use std::borrow::Cow;
use std::sync::Arc;
use std::time::Instant;

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

mod kept;
mod patch;
mod plate;
mod wire;

pub use kept::keep_support_bases;
pub use patch::PreviewPatch;
pub(crate) use patch::WholePreview;
pub use wire::{
    Collision, EditOutcomeView, HeightRangeSpec, ModifierVolumeSpec, ObjectSpec, ObjectView,
    PaintDiskSpec, SiteSpec, SupportEditSpec, VolumeKind,
};

use crate::adaptive::{plan_bands, plan_plate_bands, HeightOpts, LayerBand};
use crate::cancel::Job;
use crate::gcode::{
    emit_gcode, emit_later, Entry, GcodeText, LayerPaths, PlateLayer, PrintLayer, Run,
};
use crate::index::ZIndex;
use crate::lightning::{Branches, Lightning};
use crate::load::load_slice_mesh_tol;
use crate::mesh::Mesh;
use crate::meshes::{self, PayloadError};
use crate::modifiers::{zone_runs, Overrides, Print, Tweak};
use crate::poly::{
    boolean_diff, boolean_intersect, boolean_union, clip_to_rect, loop_bounds, offset_loops,
    resolve_nonzero, signed_area, simplify_loops, Loop,
};
use crate::progress::{Stage, Status, Watch};
use crate::strategy::{
    classicize, layer_weight, mix, pure, support_density, support_interface_density, support_speed,
    Axis, BlendMode, FuzzySkin, Gyroid3d, Ironing, PrinterProfile, ResolvedStrategy, ScarfSeam, SeamPlacement,
    StrategyId, ZHopMode,
};
use crate::support::edit::{EditOutcome, SupportEdit};
use crate::support::paint::{self, PaintDisk, PaintTally};
use crate::support::skeleton::{skeleton, SupportSkeleton};
use crate::support::{
    CoverageGap, Disk, FloorPlane, InAir, SupportLayer, SupportOpts, SupportStyle, Supports,
};
use crate::toolpath::{
    apply_overhang, apply_scarf, apply_z_hop, comb_layer, island_loops, lightning_pitch,
    belt_raft_paths, order_supports, plan_ironing, plan_region_split, plan_skirt, plan_support,
    plan_tree_support,
    CapFeed, Extrusion, PartLayout, PathFeatures, PathKind, ScarfParams, Seam, ShellBand, Skin,
    Slowdown, TravelIn,
};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SliceRequest {
    /// Empty when `objects` carries the meshes.
    #[serde(default)]
    pub filename: String,
    /// The mesh bytes. Empty when `meshRef` names them or `objects` carries
    /// the meshes.
    #[serde(default)]
    pub data_b64: String,
    /// A mesh the engine already holds, by the `meshId` a reply named it
    /// with, in place of `dataB64`. See `docs/mesh-refs.md`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mesh_ref: Option<String>,
    /// The plate, in print order. Omitted for one object with no overrides,
    /// which is then the request's own `filename`, `dataB64`, and `pose`.
    /// Never serialized: `wire::object_requests` serializes the request to
    /// resolve each object's settings over the plate's.
    #[serde(default, skip_serializing)]
    pub objects: Option<Vec<ObjectSpec>>,
    /// `all-at-once` when omitted. `sequential` finishes each object before
    /// the next. See `docs/sequential-printing.md`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub print_order: Option<String>,
    /// Millimetres of XY clearance between a finished object and the next,
    /// only with `printOrder: "sequential"`: the toolhead's reach around the
    /// nozzle. `0` or omitted means `SEQUENTIAL_TOOLHEAD_MM`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sequential_clearance_mm: Option<f64>,
    /// Millimetres from the nozzle tip up to the gantry, only with
    /// `printOrder: "sequential"`. Every object but the last must be lower.
    /// `0` or omitted means `SEQUENTIAL_GANTRY_MM`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sequential_gantry_mm: Option<f64>,
    #[serde(default = "default_layer")]
    pub layer_height: f64,
    #[serde(default = "default_width")]
    pub line_width: f64,
    #[serde(default)]
    pub blend: BlendMode,
    #[serde(default)]
    pub printer: Option<PrinterProfile>,
    /// Vary layer height inside `[adaptive_min, adaptive_max]` from local slope.
    #[serde(default)]
    pub adaptive: bool,
    /// `0` means 0.08 mm.
    #[serde(default)]
    pub adaptive_min: f64,
    /// `0` means the nominal layer height.
    #[serde(default)]
    pub adaptive_max: f64,
    /// Generate sparse-grid supports under overhangs.
    #[serde(default)]
    pub supports: bool,
    /// Overhang angle from horizontal, degrees. `0` means 45°.
    #[serde(default)]
    pub support_angle: f64,
    /// Arachne-style variable walls, thin walls, and gap fill. Default on.
    #[serde(default = "default_true")]
    pub variable_width: bool,
    /// G2/G3 arc fitting. Default on.
    #[serde(default = "default_true")]
    pub arc_fit: bool,
    /// Seam hiding and travel reorder. Default on.
    #[serde(default = "default_true")]
    pub travel_opt: bool,
    /// Overhang slowdown, extra fan, and bridge detection. Default on.
    #[serde(default = "default_true")]
    pub overhang_control: bool,
    /// Replay the pre-feature planner (lines, no arcs, no index) for benches.
    #[serde(default)]
    pub classic: bool,
    /// `grid` (default) or `tree` / `organic`.
    #[serde(default)]
    pub support_style: String,
    /// Max organic branch lean from vertical, degrees. `0` means 40°.
    #[serde(default)]
    pub branch_angle: f64,
    /// Organic tip diameter, millimetres. `0` means 0.8.
    #[serde(default)]
    pub tip_diameter: f64,
    /// Organic trunk diameter, millimetres. `0` means 4.2.
    #[serde(default)]
    pub trunk_diameter: f64,
    /// `0` keeps model layer height. Values above 1 thicken sparse support shafts.
    #[serde(default)]
    pub support_height_mult: f64,
    /// Combine sparse infill on speed and low-weight blends. Default on.
    #[serde(default = "default_true")]
    pub infill_combine: bool,
    /// Route travels inside the part and retract only when the route is blocked.
    #[serde(default = "default_true")]
    pub combing: bool,
    /// Per-feature speeds and accels. Default on.
    #[serde(default = "default_true")]
    pub feature_speeds: bool,
    /// Where each wall starts. `blend` follows the strategy, or `nearest`,
    /// `aligned`, or `rear`. Left out at `blend`, so the request's key holds.
    #[serde(default, skip_serializing_if = "SeamPlacement::is_blend")]
    pub seam: SeamPlacement,
    /// A low-flow pass over the part's top surfaces. Left out when off, so
    /// the request's key holds. `{}` is on at the defaults.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ironing: Option<Ironing>,
    /// Noise on the outer walls. Left out when off, so the request's key holds.
    /// `{}` is on at 0.3 mm thickness and 0.8 mm point spacing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fuzzy_skin: Option<FuzzySkin>,
    /// Extrusion multiplier. `1` is left out, so a request that does not
    /// change flow keeps its cache key. It scales filament length only.
    #[serde(default = "default_one", skip_serializing_if = "is_one")]
    pub flow: f64,
    /// Retract length in millimetres. Left out to keep the strategy length
    /// (0.35 mm on speed, 0.9 mm on toughness).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retract_length: Option<f64>,
    /// Retract and unretract speed in mm/s. Left out to keep 30 mm/s.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retract_speed: Option<f64>,
    /// Sparse infill for this object, 0 to 1. Left out to keep the strategy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub infill: Option<f64>,
    /// Wall count for this object, 1 to 12. Left out to keep the strategy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub walls: Option<u32>,
    /// Speed cap for this object, mm/s. Left out to keep the strategy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speed: Option<f64>,
    /// `blend` follows the strategy, or `off` / `outer` / `all`.
    #[serde(default)]
    pub scarf_seam: ScarfSeam,
    /// Overlap length of a scarf joint, millimetres.
    #[serde(default = "default_scarf_length")]
    pub scarf_length: f64,
    /// Discrete Z steps along each ramp.
    #[serde(default = "default_scarf_steps")]
    pub scarf_steps: u32,
    /// Nozzle height at the scarf start, as a fraction of the layer height.
    #[serde(default = "default_scarf_height")]
    pub scarf_start_height: f64,
    /// Flow multiplier at the scarf start. Ramps to 1 at full height.
    #[serde(default = "default_scarf_flow")]
    pub scarf_start_flow: f64,
    /// `blend` follows the strategy, `off` keeps the 2D gyroid, `on` forces 3D.
    #[serde(default)]
    pub gyroid_3d: Gyroid3d,
    /// `off`, `blend`, `always`, or `smart`.
    #[serde(default)]
    pub z_hop: ZHopMode,
    /// Hop height in millimetres. `0` means 0.4.
    #[serde(default)]
    pub z_hop_height: f64,
    /// Travels shorter than this stay on the layer. `0` means 2 mm.
    #[serde(default)]
    pub z_hop_min_travel: f64,
    /// When true, time a second speed plan. The UI leaves this off.
    #[serde(default)]
    pub baseline: bool,
    /// When true, also slice pure speed, efficiency, toughness, and classic.
    #[serde(default)]
    pub compare: bool,
    /// When false, the reply leaves the G-code out, and the HTTP and desktop
    /// shells park it, formatted on first read, for playback and export.
    #[serde(default = "default_true")]
    pub include_gcode: bool,
    /// When false, skip preview polylines. Estimates and G-code still run.
    #[serde(default = "default_true")]
    pub include_preview: bool,
    /// Stop to zero at every segment end. Default is junction lookahead.
    #[serde(default)]
    pub classic_estimator: bool,
    /// Klipper junction deviation in millimetres. `0` means 0.02.
    #[serde(default)]
    pub junction_deviation_mm: f64,
    /// Drop outline vertices the nozzle cannot trace. Default on.
    #[serde(default = "default_true")]
    pub simplify: bool,
    /// Outline tolerance in millimetres. `0` uses [`outline_tolerance_mm`].
    #[serde(default)]
    pub simplify_error_mm: f64,
    /// Applied after load. The mesh bytes are the scaled canonical
    /// frame: rotation, bed settle, and translation are not in the vertices.
    /// Absent means those bytes are already in print space.
    #[serde(default)]
    pub pose: Option<RigidPose>,
    /// Chord tolerance for STEP tessellation, millimetres. `0` uses 0.1 mm.
    /// STL and 3MF ignore it.
    #[serde(default = "default_step_tolerance")]
    pub step_tolerance_mm: f64,
    /// Edits replayed on the grown supports, in order. Omitted when empty,
    /// so a slice without edits keeps its cache key.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub support_edits: Vec<SupportEditSpec>,
    /// Enforce and block disks in the mesh frame, in paint order. Omitted
    /// when empty, so a slice without paint keeps its cache key.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub support_paint: Vec<PaintDiskSpec>,
    /// Seam disks in the mesh frame. Omitted when empty, so a slice without
    /// seam paint keeps its cache key and its G-code.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub seam_paint: Vec<crate::slice::wire::SeamDiskSpec>,
    /// Z spans that print with their own infill, walls, or speed cap.
    /// Omitted when empty, so a slice without them keeps its cache key.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub height_ranges: Vec<HeightRangeSpec>,
    /// Boxes, cylinders, and spheres on the bed, in bed millimetres, that
    /// print with their own infill, walls, or speed cap. Omitted when empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub modifier_volumes: Vec<ModifierVolumeSpec>,
    /// Also return the tree outline the UI picks limbs from.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub include_skeleton: bool,
    /// The `previewToken` of the preview the client shows. When the engine
    /// still holds that preview, the reply carries `previewPatch` instead
    /// of `layers`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview_base: Option<String>,
    /// Present only for a belt printer. Omitted on a cartesian request, so
    /// the request bytes and the cache key stay what they were.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub belt: Option<crate::belt::BeltSpec>,
}

/// Rigid placement of a mesh that was simplified in its scaled frame.
///
/// `placed = rotation * (v - pivot) + translation`, with `rotation` row-major.
/// Scale is not in this transform. It has to already be in the vertices so
/// the nozzle bound stays in print millimetres.
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RigidPose {
    pub rotation: [f64; 9],
    pub pivot: [f64; 3],
    pub translation: [f64; 3],
}

impl RigidPose {
    pub fn apply(&self, mesh: &Mesh) -> Mesh {
        mesh.rigid_move(&self.rotation, self.pivot, self.translation)
    }

    /// This pose with its X/Y translation replaced by `centre`, and the
    /// offset from that part frame to the bed. Bed coordinates are part-frame
    /// coordinates plus the offset. The part frame does not depend on the
    /// X/Y translation, so moving a part changes only the offset.
    pub fn part_frame(&self, centre: [f64; 2]) -> (RigidPose, [f64; 2]) {
        let [x, y, z] = self.translation;
        let frame = RigidPose {
            translation: [centre[0], centre[1], z],
            ..*self
        };
        (frame, [x - centre[0], y - centre[1]])
    }
}

#[derive(Clone, Debug)]
pub struct SliceSettings {
    pub layer_height: f64,
    pub line_width: f64,
    pub adaptive: bool,
    pub adaptive_min: f64,
    pub adaptive_max: f64,
    pub supports: bool,
    pub support_angle: f64,
    pub variable_width: bool,
    pub arc_fit: bool,
    pub travel_opt: bool,
    pub overhang_control: bool,
    pub classic: bool,
    pub support_style: SupportStyle,
    pub branch_angle: f64,
    pub tip_diameter: f64,
    pub trunk_diameter: f64,
    pub support_height_mult: f64,
    pub infill_combine: bool,
    pub combing: bool,
    pub feature_speeds: bool,
    pub seam: SeamPlacement,
    pub ironing: Option<Ironing>,
    pub fuzzy_skin: Option<FuzzySkin>,
    /// Extrusion multiplier. `1` leaves filament length where it was.
    pub flow: f64,
    /// `None` keeps the strategy retract length.
    pub retract_length: Option<f64>,
    /// `None` keeps the 30 mm/s retract feed.
    pub retract_speed: Option<f64>,
    /// Off on a belt, where an outward loop around the first layer crosses the belt line.
    pub skirt: bool,
    pub scarf_seam: ScarfSeam,
    pub scarf_length: f64,
    pub scarf_steps: u32,
    pub scarf_start_height: f64,
    pub scarf_start_flow: f64,
    pub gyroid_3d: Gyroid3d,
    pub z_hop: ZHopMode,
    pub z_hop_height: f64,
    pub z_hop_min_travel: f64,
    pub baseline: bool,
    pub compare: bool,
    pub include_gcode: bool,
    pub include_preview: bool,
    /// Stop to zero at every segment end. The default carries junction speed.
    pub classic_estimator: bool,
    /// Klipper junction deviation, millimetres. `0` uses 0.02.
    pub junction_deviation_mm: f64,
    /// Drop outline vertices closer than the tolerance to the line through
    /// their neighbors, on every layer's cut.
    pub simplify: bool,
    /// Outline tolerance in millimetres. `0` uses [`outline_tolerance_mm`].
    pub simplify_error_mm: f64,
    /// Rigid placement applied after load. `None` slices the mesh as given.
    pub pose: Option<RigidPose>,
    /// Edits applied to the grown supports, in order.
    pub support_edits: Vec<SupportEdit>,
    /// Paint that changes the demand the supports grow on, in paint order:
    /// in the mesh frame while `pose` is set, then in the part frame.
    pub support_paint: Vec<PaintDisk>,
    /// Seam disks. Empty leaves the picker's seam. In the mesh frame while
    /// `pose` is set, then in the part frame.
    pub seam_paint: Vec<crate::support::paint::SeamDisk>,
    /// Height ranges and modifier volumes. Volumes are in bed coordinates
    /// until the plate moves them into each part frame.
    pub overrides: Overrides,
    /// Infill, walls, and speed for this object. Empty keeps the strategy.
    /// A range or volume wins on each field it sets.
    pub object_tweak: Tweak,
    /// Report the tree outline on the response.
    pub include_skeleton: bool,
    /// The preview the client holds, from `SliceRequest::preview_base`.
    pub preview_base: Option<String>,
    /// The shell job this slice belongs to. A stale job stops with "cancelled".
    pub job: Job,
}

impl Default for SliceSettings {
    fn default() -> Self {
        Self {
            layer_height: 0.2,
            line_width: 0.45,
            adaptive: false,
            adaptive_min: 0.08,
            adaptive_max: 0.2,
            supports: false,
            support_angle: 45.0,
            variable_width: true,
            arc_fit: true,
            travel_opt: true,
            overhang_control: true,
            classic: false,
            support_style: SupportStyle::Tree,
            branch_angle: 40.0,
            tip_diameter: 0.8,
            trunk_diameter: 4.2,
            support_height_mult: 1.0,
            infill_combine: true,
            combing: true,
            feature_speeds: true,
            seam: SeamPlacement::Blend,
            ironing: None,
            fuzzy_skin: None,
            flow: 1.0,
            retract_length: None,
            retract_speed: None,
            skirt: true,
            scarf_seam: ScarfSeam::Blend,
            scarf_length: default_scarf_length(),
            scarf_steps: default_scarf_steps(),
            scarf_start_height: default_scarf_height(),
            scarf_start_flow: default_scarf_flow(),
            gyroid_3d: Gyroid3d::Blend,
            z_hop: ZHopMode::Blend,
            z_hop_height: 0.4,
            z_hop_min_travel: 2.0,
            baseline: true,
            compare: false,
            include_gcode: true,
            include_preview: true,
            classic_estimator: false,
            junction_deviation_mm: 0.02,
            simplify: true,
            simplify_error_mm: 0.0,
            pose: None,
            support_edits: Vec::new(),
            support_paint: Vec::new(),
            seam_paint: Vec::new(),
            overrides: Overrides::default(),
            object_tweak: Tweak::default(),
            include_skeleton: false,
            preview_base: None,
            job: Job::default(),
        }
    }
}

impl SliceSettings {
    pub fn from_request(req: &SliceRequest) -> Self {
        let layer_height = req.layer_height.clamp(0.05, 0.6);
        let line_width = req.line_width.clamp(0.15, 1.2);
        let adaptive_min = if req.adaptive_min > 0.0 {
            req.adaptive_min
        } else {
            0.08
        };
        let adaptive_max = if req.adaptive_max > 0.0 {
            req.adaptive_max
        } else {
            layer_height
        };
        let support_angle = if req.support_angle > 0.0 {
            req.support_angle
        } else {
            45.0
        };
        Self {
            layer_height,
            line_width,
            adaptive: req.adaptive,
            adaptive_min: adaptive_min.clamp(0.04, 0.48),
            adaptive_max: adaptive_max.clamp(0.05, 0.6),
            supports: req.supports,
            support_angle: support_angle.clamp(15.0, 75.0),
            variable_width: req.variable_width && !req.classic,
            arc_fit: req.arc_fit && !req.classic,
            travel_opt: req.travel_opt && !req.classic,
            overhang_control: req.overhang_control && !req.classic,
            classic: req.classic,
            support_style: if req.classic {
                SupportStyle::Grid
            } else {
                parse_support_style(&req.support_style)
            },
            branch_angle: if req.branch_angle > 0.0 {
                req.branch_angle.clamp(10.0, 65.0)
            } else {
                40.0
            },
            tip_diameter: if req.tip_diameter > 0.0 {
                req.tip_diameter.clamp(0.4, 3.0)
            } else {
                0.8
            },
            trunk_diameter: if req.trunk_diameter > 0.0 {
                req.trunk_diameter.clamp(1.2, 16.0)
            } else {
                4.2
            },
            support_height_mult: if req.classic {
                1.0
            } else {
                req.support_height_mult.clamp(0.0, 4.0)
            },
            infill_combine: req.infill_combine && !req.classic,
            combing: req.combing && !req.classic,
            feature_speeds: req.feature_speeds && !req.classic,
            seam: req.seam,
            ironing: req.ironing,
            fuzzy_skin: if req.classic { None } else { req.fuzzy_skin },
            flow: req.flow,
            retract_length: req.retract_length,
            retract_speed: req.retract_speed,
            skirt: true,
            scarf_seam: if req.classic {
                ScarfSeam::Off
            } else {
                req.scarf_seam
            },
            scarf_length: req.scarf_length.clamp(0.5, 40.0),
            scarf_steps: req.scarf_steps.clamp(2, 64),
            scarf_start_height: req.scarf_start_height.clamp(0.0, 0.9),
            scarf_start_flow: req.scarf_start_flow.clamp(0.05, 1.0),
            gyroid_3d: if req.classic {
                Gyroid3d::Off
            } else {
                req.gyroid_3d
            },
            z_hop: if req.classic {
                ZHopMode::Off
            } else {
                req.z_hop
            },
            z_hop_height: if req.z_hop_height > 0.0 {
                req.z_hop_height
            } else {
                0.4
            },
            z_hop_min_travel: if req.z_hop_min_travel > 0.0 {
                req.z_hop_min_travel
            } else {
                2.0
            },
            baseline: req.baseline,
            compare: req.compare,
            // Without it the text is formatted only when the shell's parked
            // G-code is first read.
            include_gcode: req.include_gcode,
            include_preview: req.include_preview,
            classic_estimator: req.classic_estimator,
            junction_deviation_mm: if req.junction_deviation_mm > 0.0 {
                req.junction_deviation_mm
            } else {
                0.02
            },
            simplify: req.simplify,
            simplify_error_mm: if req.simplify_error_mm > 0.0 {
                req.simplify_error_mm.clamp(0.001, 0.2)
            } else {
                0.0
            },
            pose: req.pose,
            support_edits: Vec::new(),
            support_paint: Vec::new(),
            seam_paint: Vec::new(),
            overrides: Overrides::default(),
            object_tweak: Tweak {
                infill: req.infill,
                walls: req.walls,
                speed: req.speed,
            },
            include_skeleton: req.include_skeleton,
            preview_base: req.preview_base.clone(),
            job: Job::default(),
        }
    }

    /// A copy for a side plan: no edits, and no preview, so it neither reads
    /// nor evicts the kept interactive slices.
    fn unkept(&self) -> Self {
        Self {
            support_edits: Vec::new(),
            include_preview: false,
            preview_base: None,
            ..self.clone()
        }
    }

    fn feature_note(&self) -> String {
        let layers = if self.adaptive {
            format!(
                "adaptive {:.3}..{:.3} (nominal {:.3})",
                self.adaptive_min.min(self.adaptive_max),
                self.adaptive_max.max(self.adaptive_min),
                self.layer_height
            )
        } else {
            "fixed layer height".into()
        };
        let supports = if self.supports {
            let style = match self.support_style {
                SupportStyle::Grid => "grid",
                SupportStyle::Tree => "tree",
            };
            let organic = match self.support_style {
                SupportStyle::Tree => format!(
                    ", branch {:.0}°, tip {:.1} mm, trunk {:.1} mm",
                    self.branch_angle, self.tip_diameter, self.trunk_diameter
                ),
                SupportStyle::Grid => String::new(),
            };
            format!(
                "supports {style} (angle {:.0}°, shaft ×{:.1}{organic})",
                self.support_angle,
                self.support_height_mult.max(1.0)
            )
        } else {
            "supports off".into()
        };
        let combine = if self.infill_combine {
            "infill combine on"
        } else {
            "infill combine off"
        };
        let scarf = format!(
            "scarf {} {:.1} mm / {} steps",
            self.scarf_seam.as_str(),
            self.scarf_length,
            self.scarf_steps
        );
        let gyroid = format!("gyroid mode {}", self.gyroid_3d.as_str());
        let hop = format!(
            "z-hop {} {:.2} mm / {:.1} mm",
            self.z_hop.as_str(),
            self.z_hop_height,
            self.z_hop_min_travel
        );
        let seam = match self.seam {
            SeamPlacement::Blend => String::new(),
            placed => format!("; seam {}", placed.as_str()),
        };
        let ironing = self.ironing.map_or(String::new(), |i| {
            format!(
                "; ironing flow {} speed {} spacing {}",
                i.flow, i.speed, i.spacing
            )
        });
        let fuzzy = self.fuzzy_skin.map_or(String::new(), |f| {
            format!(
                "; fuzzy skin {} mm / {} mm",
                f.thickness, f.point_distance
            )
        });
        let flow = if is_one(&self.flow) {
            String::new()
        } else {
            format!("; flow {:.3}", self.flow)
        };
        let retract = match (self.retract_length, self.retract_speed) {
            (None, None) => String::new(),
            (length, speed) => {
                let len = length
                    .map(|n| format!("{n:.3} mm"))
                    .unwrap_or_else(|| "strategy".into());
                let spd = speed
                    .map(|n| format!("{n:.0} mm/s"))
                    .unwrap_or_else(|| "30 mm/s".into());
                format!("; retract {len} at {spd}")
            }
        };
        format!("{layers}; {supports}; {combine}; {scarf}; {gyroid}; {hop}{seam}{ironing}{fuzzy}{flow}{retract}")
    }
}

/// Trees unless the request asks for the grid: they reach the part in far
/// less material and time than a column filling the whole overhang.
fn parse_support_style(name: &str) -> SupportStyle {
    match name.trim().to_ascii_lowercase().as_str() {
        "grid" => SupportStyle::Grid,
        _ => SupportStyle::Tree,
    }
}

fn default_layer() -> f64 {
    0.2
}

fn default_step_tolerance() -> f64 {
    crate::step::STEP_TOLERANCE_DEFAULT_MM
}
fn default_width() -> f64 {
    0.45
}

fn default_true() -> bool {
    true
}

fn default_one() -> f64 {
    1.0
}

fn is_one(value: &f64) -> bool {
    (*value - 1.0).abs() < 1e-9
}

fn default_scarf_length() -> f64 {
    10.0
}

fn default_scarf_steps() -> u32 {
    8
}

fn default_scarf_height() -> f64 {
    0.15
}

fn default_scarf_flow() -> f64 {
    0.55
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SliceResponse {
    pub core_ms: f64,
    pub baseline_ms: f64,
    pub baseline_label: String,
    pub mesh: MeshInfo,
    /// Where the reply frame sits on the bed. `layers`, `previewPatch`,
    /// `coverage`, `skeleton`, `inAir`, the gaps in `supportEdits`, and
    /// `mesh.min`/`max` are in the part frame: draw them at their coordinates
    /// plus `offset`. The G-code and `sanity`'s bounds are in bed
    /// coordinates. Absent when the request has no pose, since the two
    /// frames are then the same.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<[f64; 2]>,
    /// Named slices of `core_ms`: contours, supports, toolpaths, order, combing, and G-code emit.
    /// Simplify time stays on `mesh` because it runs before the core timer.
    pub stages: StageTimes,
    pub sanity: Sanity,
    /// Overhang the supports leave unheld, largest first. Empty when every
    /// demanded interface prints.
    pub coverage: Vec<CoverageGap>,
    /// With supports off, the islands and overhangs that print over air.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_air: Option<InAir>,
    pub gcode: String,
    /// The G-code, formatted when first read, when the settings left it out
    /// of `gcode`.
    #[serde(skip)]
    pub gcode_text: Option<GcodeText>,
    pub layers: Vec<PreviewLayer>,
    pub blend: String,
    pub estimate: PrintEstimate,
    pub score: BlendScore,
    /// Real slices of the same mesh: speed, efficiency (weight 0.5), toughness, classic.
    /// Empty unless the request set `compare`.
    #[serde(default)]
    pub compare: Vec<CompareEstimate>,
    /// One per requested support edit, in request order.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub support_edits: Vec<EditOutcomeView>,
    /// How the request's support paint landed. Only when it sent paint.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub support_paint: Option<PaintTally>,
    /// The grown trees after every edit. Only when the request asked for it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skeleton: Option<SupportSkeleton>,
    /// Names the preview this reply leaves the client holding. Sent back as
    /// `previewBase`. Only for kept interactive slices.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_token: Option<String>,
    /// The changed layers against the request's `previewBase`. `layers` is
    /// empty when this is set.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_patch: Option<PreviewPatch>,
    /// One per requested object, in plate order. Empty when the request
    /// omitted `objects`.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub objects: Vec<ObjectView>,
    /// Pairs of objects whose boxes overlap on the bed. Only when the
    /// request sent `objects`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collisions: Option<Vec<Collision>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintEstimate {
    pub seconds: f64,
    pub filament_mm: f64,
    pub filament_g: f64,
    pub arc_moves: usize,
    pub travel_mm: f64,
    pub retracts: usize,
    pub z_hops: usize,
    /// Closed walls that received a scarf. `0` means every seam is a butt joint.
    pub scarfed_loops: usize,
    /// Mean overlap length of those scarfs, millimetres.
    pub mean_scarf_mm: f64,
    /// Largest |ΔZ| between consecutive scarf vertices. `0` when no scarf was emitted.
    pub max_seam_z_step_mm: f64,
    /// Time and filament per path kind, including travel.
    #[serde(default)]
    pub by_feature: Vec<FeatureEstimate>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureEstimate {
    pub kind: String,
    pub seconds: f64,
    pub filament_mm: f64,
    pub filament_g: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareEstimate {
    pub label: String,
    pub seconds: f64,
    pub filament_g: f64,
    pub by_feature: Vec<FeatureEstimate>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlendScore {
    /// Higher is a shorter print. Fed by the time estimator.
    pub speed: f64,
    /// Higher uses less filament. Fed by the mass estimator.
    pub efficiency: f64,
    /// Structural proxy (walls and pattern). Lightning scores below gyroid.
    pub toughness: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshInfo {
    /// Triangles the planner contoured. Every triangle of the mesh is cut.
    pub triangles: usize,
    /// Each layer's outline stays within this distance of the true cut, in
    /// millimetres. `0` when outline simplification is off.
    pub outline_tolerance_mm: f64,
    pub min: [f64; 3],
    pub max: [f64; 3],
    /// Layers whose contour closed a mesh gap. The cut already counts these.
    pub repaired_layers: usize,
    /// Open chains the cut could not close. Their outline is lost.
    pub dropped_chains: usize,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageTimes {
    pub contour_ms: f64,
    pub support_ms: f64,
    /// Parallel per-layer walls, infill, and overhang split. Inside `core_ms`.
    pub toolpath_ms: f64,
    /// Serial travel order: island tour, seams, and scarf. Inside `core_ms`.
    pub order_ms: f64,
    /// Parallel combing and z-hop after the order is set. Inside `core_ms`.
    pub comb_ms: f64,
    /// G-code writer. Inside `core_ms`.
    pub emit_ms: f64,
    /// Z-bucket build before the parallel cut. Inside `contour_ms`'s caller, not inside `contour_ms`.
    #[serde(default)]
    pub index_ms: f64,
    /// Sum of per-layer cut time. Parallel, so this can exceed `contour_ms`.
    #[serde(default)]
    pub cut_cpu_ms: f64,
    /// Sum of per-layer outline simplify time. Parallel, so this can exceed `contour_ms`.
    #[serde(default)]
    pub simplify_cpu_ms: f64,
    /// Roof-distance booleans. Inside `core_ms`, outside the named stage sum.
    #[serde(default)]
    pub roof_ms: f64,
    /// Sum of per-layer wall offset time inside `toolpath_ms`.
    #[serde(default)]
    pub wall_cpu_ms: f64,
    /// Sum of per-layer infill and gap-fill time inside `toolpath_ms`.
    #[serde(default)]
    pub infill_cpu_ms: f64,
    /// Stages taken from memory instead of computed, in pipeline order:
    /// `contours`, `toolpaths`, `order`, `comb`, `supports` (grown), and
    /// `supportPaths`. Their clocks above read zero.
    #[serde(default)]
    pub reused: Vec<&'static str>,
    /// Leading edits whose result was already in memory.
    #[serde(default)]
    pub edits_reused: u32,
    /// Pruning and regrowing the edits applied in this request.
    #[serde(default)]
    pub edit_apply_ms: f64,
    /// Repainting the support layers those edits changed.
    #[serde(default)]
    pub edit_refresh_ms: f64,
    /// Layers whose travel order, combing, and z-hop came from the kept
    /// slice because their supports and the nozzle's way in were the same.
    #[serde(default)]
    pub layers_reused: u32,
    /// Layers of a part stage that ran again but took them from a kept
    /// slice, because the only change was overrides that miss them: their
    /// toolpaths, their tour (same paths from the same start), and their
    /// combing (same tour). A stage reused whole is in `reused` instead.
    #[serde(default)]
    pub toolpath_layers_reused: u32,
    #[serde(default)]
    pub order_layers_reused: u32,
    #[serde(default)]
    pub comb_layers_reused: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sanity {
    pub ok: bool,
    pub layers: usize,
    pub extrusion_moves: usize,
    pub travel_moves: usize,
    pub final_e: f64,
    pub extrusion_length_mm: f64,
    pub travel_length_mm: f64,
    pub min_x: f64,
    pub max_x: f64,
    pub min_y: f64,
    pub max_y: f64,
    pub notes: Vec<String>,
    pub retracts: usize,
    pub z_hops: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewLayer {
    pub index: usize,
    pub z: f64,
    pub height: f64,
    pub note: String,
    pub speed_walls: u32,
    pub toughness_walls: u32,
    pub support_paths: u32,
    /// Estimator seconds for this layer.
    #[serde(default)]
    pub seconds: f64,
    /// Sent as columns (see `path_columns`), not one object per path.
    #[serde(serialize_with = "path_columns")]
    pub paths: Vec<PreviewPath>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewPath {
    pub kind: String,
    pub strategy: String,
    pub pts: Vec<[f64; 2]>,
    pub width: f64,
    pub speed: f64,
    /// Feed after the volumetric cap, mm/s.
    #[serde(default)]
    pub effective_speed: f64,
    /// Strategy toughness weight, 0 (speed) to 1 (toughness).
    #[serde(default)]
    pub toughness: f64,
    /// Absolute nozzle Z per preview point. Empty means the layer Z.
    #[serde(default)]
    pub zs: Vec<f64>,
    /// Vertical bead size. `0` means the layer height.
    #[serde(default)]
    pub bead_height: f64,
    /// Index of the plate object it prints, in that object's part frame.
    #[serde(default)]
    pub object: u16,
}

/// Milliseconds to contour every layer with the Z index, then with a full triangle scan.
/// Wall-clock time to cut every 0.2 mm layer of `mesh` through the Z index.
pub fn contour_times(mesh: &Mesh, layer_height: f64) -> Result<f64, String> {
    let (_, max) = mesh.bounds().ok_or("empty mesh")?;
    let mut zs = Vec::new();
    let mut z = layer_height;
    while z < max[2] + 1e-6 {
        zs.push(z);
        z += layer_height;
    }
    let index = ZIndex::build(mesh);
    let started = Instant::now();
    let _: Vec<_> = zs.par_iter().map(|z| index.slice(*z)).collect();
    Ok(elapsed_ms(started))
}

pub fn slice_request(req: &SliceRequest, job: Job) -> Result<SliceResponse, String> {
    slice_request_watched(req, job, &Watch::idle())
}

pub fn slice_request_watched(
    req: &SliceRequest,
    job: Job,
    watch: &Watch,
) -> Result<SliceResponse, String> {
    watch.begin(Stage::Load, 1);
    if watch.stopped(job) {
        return Err("cancelled".into());
    }
    if !req.flow.is_finite() || !(0.5..=1.5).contains(&req.flow) {
        return Err(format!("flow {} must be from 0.5 to 1.5", req.flow));
    }
    let profile = req.printer.clone().unwrap_or_default();
    let order = plate_order(req)?;
    let overrides = wire::parse_overrides(req, [profile.bed_x, profile.bed_y])?;
    if let Some(ironing) = &req.ironing {
        ironing.check(SliceSettings::from_request(req).line_width)?;
    }
    if let Some(fuzzy) = &req.fuzzy_skin {
        fuzzy.check()?;
    }
    let listed = req.objects.is_some();
    let requests = if listed {
        wire::object_requests(req)?
    } else {
        Vec::new()
    };
    let loaded: Vec<(Mesh, SliceSettings)> = if listed {
        requests
            .iter()
            .enumerate()
            .map(|(i, one)| {
                load_object(one, &overrides, job).map_err(|e| format!("objects[{i}]: {e}"))
            })
            .collect::<Result<_, _>>()?
    } else {
        vec![load_object(req, &overrides, job)?]
    };
    watch.tick();
    let ids = req.objects.iter().flatten().map(|o| o.id.as_str());
    let sources: Vec<Source<'_>> = if listed {
        loaded
            .iter()
            .zip(&requests)
            .zip(ids)
            .map(|(((mesh, settings), one), id)| Source {
                id: Some(id),
                mesh,
                blend: &one.blend,
                settings: settings.clone(),
            })
            .collect()
    } else {
        vec![Source {
            id: None,
            mesh: &loaded[0].0,
            blend: &req.blend,
            settings: loaded[0].1.clone(),
        }]
    };
    let settings = SliceSettings {
        job,
        ..SliceSettings::from_request(req)
    };
    slice_plate(
        &sources,
        &req.blend,
        &profile,
        &settings,
        req.belt.as_ref(),
        order,
        &mut None,
        watch,
    )
}

/// One object's mesh as the request sends it, and its settings with its
/// edits, pose, and the plate's overrides.
fn load_object(
    req: &SliceRequest,
    overrides: &Overrides,
    job: Job,
) -> Result<(Mesh, SliceSettings), String> {
    let held;
    let decoded;
    let bytes: &[u8] = match (&req.mesh_ref, req.data_b64.is_empty()) {
        (Some(id), true) => {
            held = meshes::find(id)
                .ok_or_else(|| PayloadError::UnknownMesh(vec![id.clone()]).to_string())?;
            &held
        }
        (Some(_), false) => return Err("send dataB64 or meshRef, not both".into()),
        (None, _) => {
            decoded = meshes::decode_b64(&req.data_b64)?;
            &decoded
        }
    };
    let mesh = load_slice_mesh_tol(
        &req.filename,
        bytes,
        req.pose.is_some(),
        req.step_tolerance_mm,
    )?;
    let settings = SliceSettings {
        job,
        support_edits: wire::parse_support_edits(&req.support_edits)?,
        support_paint: wire::parse_support_paint(&req.support_paint)?,
        seam_paint: wire::parse_seam_paint(&req.seam_paint)?,
        overrides: overrides.clone(),
        ..SliceSettings::from_request(req)
    };
    Ok((mesh, settings))
}

/// An object of a plate before its part frame is taken: the mesh as loaded,
/// and its settings with `pose` still set.
struct Source<'a> {
    /// `None` when the request omitted `objects`.
    id: Option<&'a str>,
    mesh: &'a Mesh,
    blend: &'a BlendMode,
    settings: SliceSettings,
}

/// Plan `req` into the kept stages and note its preview as the one the
/// client holds, so the next request of the same part reuses every stage and
/// gets a patch. For a reply the client got from elsewhere, such as the disk.
/// Does nothing when no stages are kept or `req` draws no preview.
pub(crate) fn warm_kept(req: SliceRequest, job: Job) {
    if !kept::on() || !req.include_preview {
        return;
    }
    let req = SliceRequest {
        baseline: false,
        compare: false,
        include_gcode: false,
        include_skeleton: false,
        preview_base: None,
        ..req
    };
    let _ = slice_request_watched(&req, job, &Watch::idle());
}

pub fn slice_with_baseline(
    mesh: &Mesh,
    blend: &BlendMode,
    profile: &PrinterProfile,
    layer_height: f64,
    line_width: f64,
) -> Result<SliceResponse, String> {
    slice_configured(
        mesh,
        blend,
        profile,
        &SliceSettings {
            layer_height,
            line_width,
            ..SliceSettings::default()
        },
    )
}

pub fn slice_configured(
    mesh: &Mesh,
    blend: &BlendMode,
    profile: &PrinterProfile,
    settings: &SliceSettings,
) -> Result<SliceResponse, String> {
    slice_sharing(mesh, blend, profile, settings, &mut None, &Watch::idle())
}

/// `slice_configured`, publishing into `watch` and leaving it `done`,
/// `cancelled`, or `error` when this returns.
pub fn slice_configured_watched(
    mesh: &Mesh,
    blend: &BlendMode,
    profile: &PrinterProfile,
    settings: &SliceSettings,
    watch: &Watch,
) -> Result<SliceResponse, String> {
    let result = slice_sharing(mesh, blend, profile, settings, &mut None, watch);
    watch.finish(Status::of(&result));
    result
}

/// `slice_configured`, sharing the cut through `cut` as `plan_sharing` does.
fn slice_sharing(
    mesh: &Mesh,
    blend: &BlendMode,
    profile: &PrinterProfile,
    settings: &SliceSettings,
    cut: &mut Option<Arc<Contours>>,
    watch: &Watch,
) -> Result<SliceResponse, String> {
    let source = Source {
        id: None,
        mesh,
        blend,
        settings: settings.clone(),
    };
    slice_plate(
        &[source],
        blend,
        profile,
        settings,
        None,
        PlateOrder::AllAtOnce,
        cut,
        watch,
    )
}

/// How a plate joins its objects. All-at-once is the omitted default.
/// Sequential carries the clearance already resolved, never zero.
#[derive(Clone, Copy)]
enum PlateOrder {
    AllAtOnce,
    Sequential { clearance_mm: f64, gantry_mm: f64 },
}

/// Reach of a typical toolhead around its nozzle: heater block, fan duct and
/// carriage. A plate printed one object at a time keeps each object this far
/// from every earlier one unless the request says how far its head reaches.
const SEQUENTIAL_TOOLHEAD_MM: f64 = 35.0;
/// Height of a typical gantry above the nozzle tip. Only the last object of a
/// plate printed one object at a time may be taller.
const SEQUENTIAL_GANTRY_MM: f64 = 20.0;

/// `printOrder` and `sequentialClearanceMm`. A bad value is an error before
/// any mesh is planned. Omitted order is all-at-once.
fn plate_order(req: &SliceRequest) -> Result<PlateOrder, String> {
    let sequential = match req.print_order.as_deref() {
        None | Some("all-at-once") => false,
        Some("sequential") => true,
        Some(other) => {
            return Err(format!(
                "printOrder \"{other}\" is not a print order; send \"all-at-once\" or \"sequential\""
            ))
        }
    };
    if let Some(n) = req.sequential_clearance_mm {
        if !sequential {
            return Err(
                "sequentialClearanceMm is sent only with printOrder \"sequential\"".into(),
            );
        }
        if !n.is_finite() || !(0.0..=100.0).contains(&n) {
            return Err(format!("sequentialClearanceMm {n} must be from 0 to 100"));
        }
    }
    if let Some(n) = req.sequential_gantry_mm {
        if !sequential {
            return Err("sequentialGantryMm is sent only with printOrder \"sequential\"".into());
        }
        if !n.is_finite() || !(0.0..=500.0).contains(&n) {
            return Err(format!("sequentialGantryMm {n} must be from 0 to 500"));
        }
    }
    if !sequential {
        return Ok(PlateOrder::AllAtOnce);
    }
    // The belt advances once per layer. Starting the next object again at its
    // first layer would run the belt backwards into the head.
    if req.belt.is_some() {
        return Err("printOrder \"sequential\" is not available on a belt printer".into());
    }
    let set = |n: Option<f64>, auto: f64| match n {
        Some(n) if n > 1e-9 => n,
        _ => auto,
    };
    Ok(PlateOrder::Sequential {
        clearance_mm: set(req.sequential_clearance_mm, SEQUENTIAL_TOOLHEAD_MM),
        gantry_mm: set(req.sequential_gantry_mm, SEQUENTIAL_GANTRY_MM),
    })
}

/// The settings the stages read: lengths clamped, and every later feature
/// off under `classic`.
fn resolved(settings: &SliceSettings) -> SliceSettings {
    let mut settings = SliceSettings {
        layer_height: settings.layer_height.clamp(0.05, 0.6),
        line_width: settings.line_width.clamp(0.15, 1.2),
        ..settings.clone()
    };
    if settings.classic {
        settings.variable_width = false;
        settings.arc_fit = false;
        settings.travel_opt = false;
        settings.overhang_control = false;
        settings.infill_combine = false;
        settings.combing = false;
        settings.feature_speeds = false;
        settings.seam = SeamPlacement::Blend;
        settings.ironing = None;
        settings.fuzzy_skin = None;
        settings.scarf_seam = ScarfSeam::Off;
        settings.gyroid_3d = Gyroid3d::Off;
        settings.z_hop = ZHopMode::Off;
        settings.support_style = SupportStyle::Grid;
        settings.support_height_mult = 1.0;
    }
    settings
}

/// One object of a plate in its part frame, ready to plan.
struct PlateObject<'a> {
    id: Option<&'a str>,
    mesh: Cow<'a, Mesh>,
    /// Where the part frame sits on the bed. `None` when it has no pose.
    offset: Option<[f64; 2]>,
    /// Its blend, moved into its part frame.
    blend: BlendMode,
    /// Its settings, with no pose left.
    settings: SliceSettings,
}

impl PlateObject<'_> {
    fn to_bed(&self) -> [f64; 2] {
        self.offset.unwrap_or([0.0, 0.0])
    }
}

/// A belt slice: the rotation that laid the plate flat, and the placement
/// the reply still reports. The planner sees the settled meshes, with no offset.
struct BeltJob {
    /// Its `frame` is the rotation that laid this plate flat.
    belt: crate::belt::Belt,
    /// Belt length of one copy, from the settled slice height.
    extent: f64,
    /// Each object's part-frame offset before that shift was baked into the mesh.
    offsets: Vec<Option<[f64; 2]>>,
    /// Part-frame bounds in the lab, with the later copies included along Y.
    lab_bounds: Vec<([f64; 3], [f64; 3])>,
    /// A pad on the belt, in the slice frame, when the request asked for one.
    raft: Option<crate::belt::Raft>,
    /// Set when supports grow to the tilted belt. `None` forces supports off.
    floor: Option<FloorPlane>,
}

/// How far the belt raft reaches past the plate's footprint on every side.
const BELT_RAFT_MARGIN_MM: f64 = 1.0;

/// Lay the plate on the belt, and turn off the features that assume a flat bed.
fn prepare_belt(
    objects: &mut [PlateObject<'_>],
    settings: &mut SliceSettings,
    spec: &crate::belt::BeltSpec,
) -> Result<BeltJob, String> {
    let mut belt = crate::belt::Belt::resolve(spec)?;
    if settings.compare {
        return Err("belt: compare is not supported yet".into());
    }
    if belt.floor_supports && belt.raft_layers > 0 {
        return Err("belt.floorSupports is not available with a raft yet".into());
    }
    for object in objects.iter() {
        if !object.settings.support_edits.is_empty() {
            return Err(
                "belt: support edits are not available until supports are grown on the belt".into(),
            );
        }
        if !object.settings.support_paint.is_empty() {
            return Err(
                "belt: support paint is not available until supports are grown on the belt".into(),
            );
        }
        if !object.settings.seam_paint.is_empty() {
            return Err(
                "belt: seam paint is not available until the disks move with the belt frame"
                    .into(),
            );
        }
    }
    let offsets: Vec<Option<[f64; 2]>> = objects.iter().map(|o| o.offset).collect();
    let mut lab_bounds = Vec::with_capacity(objects.len());
    let mut placed = Vec::with_capacity(objects.len());
    for object in objects.iter() {
        let (min, max) = object.mesh.bounds().ok_or("empty mesh")?;
        lab_bounds.push((min, max));
        placed.push(crate::belt::translate_xy(
            object.mesh.as_ref(),
            object.to_bed(),
        ));
    }
    if belt.raft_layers > 0 && settings.adaptive {
        return Err(
            "belt.raftLayers needs a fixed layer height; turn adaptive layers off".into(),
        );
    }
    // The pad lies on the belt under the footprint, and the parts stand on it.
    let raft = if belt.raft_layers > 0 {
        let (min, max) = xy_bounds(&placed)?;
        let top = f64::from(belt.raft_layers) * settings.layer_height.clamp(0.05, 0.6);
        for mesh in &mut placed {
            *mesh = crate::belt::shift_z(mesh, top);
        }
        Some(crate::belt::Raft {
            min: [min[0] - BELT_RAFT_MARGIN_MM, min[1] - BELT_RAFT_MARGIN_MM],
            max: [max[0] + BELT_RAFT_MARGIN_MM, max[1] + BELT_RAFT_MARGIN_MM],
            top,
            line_width: settings.line_width,
        })
    } else {
        None
    };
    let (laid, frame) = crate::belt::lay_flat(
        &placed,
        &belt,
        raft.as_ref(),
        settings.layer_height.clamp(0.05, 0.6),
    )?;
    belt.frame = frame;
    let (span_x, max_z) = crate::belt::plate_span(&laid)?;
    let extent = max_z / belt.sin_a;
    crate::belt::check_fit(&belt, span_x, extent)?;
    for (object, mesh) in objects.iter_mut().zip(laid) {
        object.mesh = Cow::Owned(mesh);
        object.offset = None;
        // Horizontal supports would stand on a bed this printer does not have.
        // `floorSupports` grows them to the tilted belt instead.
        if !belt.floor_supports {
            object.settings.supports = false;
        }
        // A scarf ramp and a hop both move machine Z. On a belt that axis is
        // the belt, so either one would walk the part between beads.
        object.settings.z_hop = ZHopMode::Off;
        object.settings.scarf_seam = ScarfSeam::Off;
        object.settings.skirt = false;
        // Blend would hide the seam wherever the strategy likes. The belt edge
        // is the back of the nozzle plane, which is Rear after the rotation.
        // An explicit seam stays unless the printer asks for the belt edge.
        if belt.seam_on_edge || object.settings.seam == SeamPlacement::Blend {
            object.settings.seam = SeamPlacement::Rear;
        }
    }
    if !belt.floor_supports {
        settings.supports = false;
    }
    settings.z_hop = ZHopMode::Off;
    settings.scarf_seam = ScarfSeam::Off;
    settings.skirt = false;
    let extra = f64::from(belt.copies - 1) * belt.stride(extent);
    if extra > 0.0 {
        for (min, max) in &mut lab_bounds {
            if belt.direction >= 0.0 {
                max[1] += extra;
            } else {
                min[1] -= extra;
            }
        }
    }
    let floor = belt.floor_supports.then(|| {
        FloorPlane::new(belt.sin_a / belt.cos_a, frame.y_shift, frame.z_drop)
    });
    Ok(BeltJob {
        belt,
        extent,
        offsets,
        lab_bounds,
        raft,
        floor,
    })
}

fn xy_bounds(meshes: &[Mesh]) -> Result<([f64; 2], [f64; 2]), String> {
    let mut min = [f64::INFINITY; 2];
    let mut max = [f64::NEG_INFINITY; 2];
    for mesh in meshes {
        let (lo, hi) = mesh.bounds().ok_or("empty mesh")?;
        min[0] = min[0].min(lo[0]);
        min[1] = min[1].min(lo[1]);
        max[0] = max[0].max(hi[0]);
        max[1] = max[1].max(hi[1]);
    }
    if !max[0].is_finite() {
        return Err("empty mesh".into());
    }
    Ok((min, max))
}

/// One planned plate, emitted once per copy. The first copy keeps the writer's
/// layer-0 treatment. Later copies' first layer is slowed here, because the
/// writer only does that for index 0. Layers below the belt's start print
/// nothing and are left out, so the lowest foot is layer 0.
fn belt_output(mut layers: Vec<PlateLayer>, job: &BeltJob) -> Vec<PlateLayer> {
    let opened = layers
        .iter()
        .take_while(|layer| layer.z <= job.belt.start + 1e-9)
        .count();
    layers.drain(..opened);
    for layer in &mut layers {
        layer.index -= opened;
        layer.own -= opened;
    }
    if let Some(raft) = &job.raft {
        let across = [raft.min[0], raft.max[0]];
        for layer in &mut layers {
            let ys = raft.lines(&job.belt.frame, layer.z);
            if ys.is_empty() {
                continue;
            }
            let paths = belt_raft_paths(across, &ys, raft.line_width, layer.index % 2 == 1);
            let n = paths.len();
            // The part's plan does not know the nozzle ends on the pad.
            if let Some(first) = layer.runs.first_mut() {
                first.entry = Entry::Cross { z_hop: 0.0 };
            }
            let pad = Run {
                object: 0,
                layer: PrintLayer::new(LayerPaths {
                    index: layer.index,
                    z: layer.z,
                    height: layer.height,
                    paths,
                    note: layer.note.clone(),
                }),
                paths: 0..n,
                entry: Entry::AsPlanned,
                label: None,
            };
            layer.runs.insert(0, pad);
        }
    }
    for layer in &mut layers {
        if layer.index != 0 {
            retouch_layer(layer, &job.belt.frame, false);
        }
    }
    let stride = job.belt.stride(job.extent);
    let mut out = Vec::with_capacity(layers.len() * job.belt.copies as usize);
    for copy in 0..job.belt.copies {
        for layer in &layers {
            let mut layer = layer.clone();
            if copy > 0 && layer.index == 0 {
                retouch_layer(&mut layer, &job.belt.frame, true);
            }
            layer.belt_shift = f64::from(copy) * stride;
            layer.index = out.len();
            out.push(layer);
        }
    }
    out
}

/// Slow the belt-contact edge. Runs that share one path list are rebuilt
/// together, so a split wall does not leave the head and the body on different lists.
fn retouch_layer(layer: &mut PlateLayer, frame: &crate::belt::Frame, slow_all: bool) {
    let mut seen = vec![false; layer.runs.len()];
    for i in 0..layer.runs.len() {
        if seen[i] {
            continue;
        }
        let mut group = vec![i];
        seen[i] = true;
        for (j, run) in layer.runs.iter().enumerate().skip(i + 1) {
            if run.layer.shares_paths(&layer.runs[i].layer) {
                group.push(j);
                seen[j] = true;
            }
        }
        let paths = layer.runs[i].layer.paths.clone();
        let mut touched = vec![false; paths.len()];
        for &run in &group {
            for k in layer.runs[run].paths.clone() {
                if let Some(flag) = touched.get_mut(k) {
                    *flag = true;
                }
            }
        }
        let mut next = Vec::with_capacity(paths.len());
        let mut placed: Vec<std::ops::Range<usize>> = Vec::with_capacity(paths.len());
        let mut changed = false;
        for (k, path) in paths.iter().enumerate() {
            let start = next.len();
            if touched[k] {
                let pieces = crate::belt::retouch(path, layer.z, layer.height, frame, slow_all);
                if pieces.len() != 1
                    || pieces[0].points.len() != path.points.len()
                    || pieces[0].speed != path.speed
                    || pieces[0].flow != path.flow
                    || pieces[0].fan != path.fan
                {
                    changed = true;
                }
                next.extend(pieces);
            } else {
                next.push(path.clone());
            }
            placed.push(start..next.len());
        }
        if !changed {
            continue;
        }
        let mut printed = layer.runs[i].layer.clone();
        printed.set_paths(next);
        for &run in &group {
            let range = layer.runs[run].paths.clone();
            let rebuilt = if range.is_empty() {
                let at = if range.start >= placed.len() {
                    printed.paths.len()
                } else {
                    placed[range.start].start
                };
                at..at
            } else {
                placed[range.start].start..placed[range.end - 1].end
            };
            layer.runs[run].layer = printed.clone();
            layer.runs[run].paths = rebuilt;
        }
    }
}

/// Preview points go back to the lab, in the part frame, so a layer draws tilted.
/// `z` on the layer is the belt position the scrubber already prints.
fn tilt_preview(preview: &mut [PreviewLayer], planned: &[PlateLayer], tilt: &patch::BeltTilt) {
    let printed: Vec<&PlateLayer> = planned.iter().filter(|layer| !layer.is_empty()).collect();
    for (view, layer) in preview.iter_mut().zip(printed) {
        tilt_layer(view, layer, tilt);
    }
}

/// The same tilt, for a stored patch whose plate is the expanded belt plate.
fn tilt_held(
    preview: &mut [PreviewLayer],
    planned: &[PlateLayer],
    tilt: &patch::BeltTilt,
) {
    tilt_preview(preview, planned, tilt);
}

fn tilt_layer(view: &mut PreviewLayer, layer: &PlateLayer, tilt: &patch::BeltTilt) {
    for path in &mut view.paths {
        let [dx, dy] = tilt
            .offsets
            .get(path.object as usize)
            .copied()
            .flatten()
            .unwrap_or([0.0, 0.0]);
        let shift = tilt.belt.direction * layer.belt_shift;
        let mut pts = Vec::with_capacity(path.pts.len());
        let mut zs = Vec::with_capacity(path.pts.len());
        for (i, pt) in path.pts.iter().enumerate() {
            let slice_z = path
                .zs
                .get(i)
                .copied()
                .filter(|z| z.is_finite())
                .unwrap_or(layer.z);
            let lab = tilt.belt.frame.lab(pt[0], pt[1], slice_z);
            pts.push([lab[0] - dx, lab[1] - dy + shift]);
            zs.push(lab[2]);
        }
        path.pts = pts;
        path.zs = zs;
    }
    view.z = tilt.belt.position(layer.z, layer.belt_shift);
}

/// Plan each object alone in its own part frame, join the plans layer by
/// layer, write the G-code with each object's offset, and build the reply.
/// A request without `objects` is a plate of one, sliced exactly as before.
#[allow(clippy::too_many_arguments)]
fn slice_plate(
    sources: &[Source<'_>],
    requested: &BlendMode,
    profile: &PrinterProfile,
    settings: &SliceSettings,
    belt_spec: Option<&crate::belt::BeltSpec>,
    order: PlateOrder,
    cut: &mut Option<Arc<Contours>>,
    watch: &Watch,
) -> Result<SliceResponse, String> {
    if !settings.flow.is_finite() || !(0.5..=1.5).contains(&settings.flow) {
        return Err(format!("flow {} must be from 0.5 to 1.5", settings.flow));
    }
    if let Some(n) = settings.retract_length {
        if !n.is_finite() || !(0.0..=5.0).contains(&n) {
            return Err(format!("retractLength {n} must be from 0 to 5"));
        }
    }
    if let Some(n) = settings.retract_speed {
        if !n.is_finite() || !(5.0..=80.0).contains(&n) {
            return Err(format!("retractSpeed {n} must be from 5 to 80"));
        }
    }
    let listed = sources.iter().any(|s| s.id.is_some());
    let mut settings = resolved(settings);
    let (layer_height, line_width) = (settings.layer_height, settings.line_width);
    let mut features = settings.feature_note();
    let mut profile = profile.clone();
    if settings.classic {
        profile.max_volumetric_mm3_s = f64::INFINITY;
        profile.pressure_advance = 0.0;
        profile.linear_advance = 0.0;
    }
    let centre = [profile.bed_x * 0.5, profile.bed_y * 0.5];
    // Every stage runs in the part frame with no pose left in the settings,
    // so no kept key sees where a part sits on the bed. Emit adds the offset.
    let mut objects: Vec<PlateObject<'_>> = sources
        .iter()
        .map(|s| {
            let mut settings = resolved(&s.settings);
            let (mesh, offset) = match settings.pose.take() {
                Some(pose) => {
                    let (frame, offset) = pose.part_frame(centre);
                    for disk in &mut settings.support_paint {
                        *disk = disk.posed(&frame.rotation, frame.pivot, frame.translation);
                    }
                    for disk in &mut settings.seam_paint {
                        *disk = disk.posed(&frame.rotation, frame.pivot, frame.translation);
                    }
                    (Cow::Owned(frame.apply(s.mesh)), Some(offset))
                }
                None => (Cow::Borrowed(s.mesh), None),
            };
            let blend = s.blend.in_part_frame(offset.unwrap_or([0.0, 0.0]));
            if !settings.overrides.is_empty() {
                if let Some((min, max)) = mesh.bounds() {
                    settings.overrides =
                        settings
                            .overrides
                            .for_part(offset.unwrap_or([0.0, 0.0]), min, max);
                }
            }
            PlateObject {
                id: s.id,
                mesh,
                offset,
                blend,
                settings,
            }
        })
        .collect();
    for (i, object) in objects.iter().enumerate() {
        let tweak = object.settings.object_tweak;
        if let Err(err) = wire::tweak(tweak.infill, tweak.walls, tweak.speed) {
            return Err(if listed {
                format!("objects[{i}].settings: {err}")
            } else {
                err
            });
        }
    }
    let seam_disks: usize = objects.iter().map(|o| o.settings.seam_paint.len()).sum();
    if seam_disks > 0 {
        features.push_str(&format!("; seam paint {seam_disks} disks"));
    }
    // A belt lays the placed meshes flat, then the planar pipeline runs in
    // that frame. Bed XY is baked in first so two objects keep their relative
    // place, which a shift along the belt turns into a different nozzle plane.
    // The whole plate is then settled so the belt and the rail start at 0.
    let mut belt_job = match belt_spec {
        Some(spec) => Some(prepare_belt(&mut objects, &mut settings, spec)?),
        None => None,
    };
    let bounds: Vec<([f64; 3], [f64; 3])> = if let Some(job) = &belt_job {
        job.lab_bounds.clone()
    } else {
        objects
            .iter()
            .map(|o| o.mesh.bounds().ok_or("empty mesh"))
            .collect::<Result<_, _>>()?
    };
    if let PlateOrder::Sequential {
        clearance_mm,
        gantry_mm,
    } = order
    {
        let mut boxes = Vec::with_capacity(objects.len());
        for (k, object) in objects.iter().enumerate() {
            let (min, max) = object.mesh.bounds().ok_or("empty mesh")?;
            let [dx, dy] = object.to_bed();
            let id = object.id.unwrap_or("part");
            let tall = max[2] - min[2];
            if k + 1 < objects.len() && tall > gantry_mm + 1e-9 {
                return Err(format!(
                    "printOrder \"sequential\": \"{id}\" is {tall:.1} mm tall, above the {gantry_mm} mm gantry; only the last object may be taller"
                ));
            }
            boxes.push((id, [min[0] + dx, min[1] + dy], [max[0] + dx, max[1] + dy]));
        }
        plate::sequential_clearance(&boxes, clearance_mm)?;
    }
    let started = Instant::now();
    if kept::on() {
        kept::fit(objects.len());
    }
    let meshes: Vec<&Mesh> = objects.iter().map(|o| o.mesh.as_ref()).collect();
    // One bar for the plate: each object fills its share of the per-object
    // stages, weighed by its triangles.
    let watches: Vec<Watch> = if objects.len() == 1 {
        vec![watch.clone()]
    } else {
        let tris: Vec<f64> = meshes.iter().map(|m| m.triangle_count() as f64).collect();
        let all = tris.iter().sum::<f64>().max(1.0);
        let mut before = 0.0;
        tris.iter()
            .map(|&t| {
                let slot = watch.object(before, t / all);
                before += t / all;
                slot
            })
            .collect()
    };
    // Every cut first: an object's supports read the cuts of the others.
    let floor = belt_job.as_ref().and_then(|job| job.floor);
    let mut cuts: Vec<(Arc<Contours>, bool, Option<kept::Keys>)> =
        Vec::with_capacity(objects.len());
    for (k, o) in objects.iter().enumerate() {
        let bands = plan_plate_bands(&o.mesh, &meshes, &height_opts(&o.settings))?;
        let keys = kept_keys(
            &o.mesh,
            &bands,
            &o.blend,
            &o.settings,
            profile.nozzle_diameter,
            floor,
        );
        let mut alone = None;
        let shared = if objects.len() == 1 {
            &mut *cut
        } else {
            &mut alone
        };
        let (cut, reused) = cut_object(
            &o.mesh,
            bands,
            &o.settings,
            profile.nozzle_diameter,
            keys.as_ref(),
            shared,
            &watches[k],
        )?;
        cuts.push((cut, reused, keys));
    }
    let offsets: Vec<[f64; 2]> = objects.iter().map(PlateObject::to_bed).collect();
    let mut plans: Vec<Plan> = Vec::with_capacity(objects.len());
    for (a, (o, (cut, reused, keys))) in objects.iter().zip(&cuts).enumerate() {
        let shift = |b: usize| [offsets[b][0] - offsets[a][0], offsets[b][1] - offsets[a][1]];
        // Every other part, and the trees of the objects planned before this
        // one, so two objects' trees never print in the same place.
        let parts = cuts
            .iter()
            .enumerate()
            .filter(|&(b, _)| b != a)
            .map(|(b, (cut, _, keys))| {
                plate::Neighbour::part(cut, keys.as_ref().map_or([0; 32], |k| k.contours), shift(b))
            });
        let trees = plans.iter().enumerate().map(|(b, plan)| {
            let key = plan.kept.as_ref().map_or([0; 32], |k| {
                let edits = &objects[b].settings.support_edits;
                Sha256::digest(format!("trees|{:?}|{edits:?}", k.key)).into()
            });
            plate::Neighbour::trees(
                &plan.cut,
                &plan.supports,
                objects[b].settings.line_width,
                key,
                shift(b),
            )
        });
        let neighbours: Vec<plate::Neighbour> = parts.chain(trees).collect();
        plans.push(plan_object(
            Arc::clone(cut),
            *reused,
            keys.clone(),
            &o.blend,
            &o.settings,
            profile.nozzle_diameter,
            &neighbours,
            floor,
            &watches[a],
        )?);
    }
    let band_lists: Vec<&[LayerBand]> = plans.iter().map(|p| p.cut.bands.as_slice()).collect();
    let bands = match order {
        PlateOrder::AllAtOnce => plate::plate_bands(&band_lists),
        PlateOrder::Sequential { .. } => plate::sequential_bands(&band_lists),
    };
    let sequential_stamp = matches!(order, PlateOrder::Sequential { .. }) && objects.len() > 1;
    let labelled = objects.len() > 1;
    let joinable: Vec<plate::Joinable<'_>> = plans
        .iter()
        .zip(&objects)
        .map(|(p, o)| plate::Joinable {
            layers: &p.layers,
            heads: &p.heads,
            offset: o.to_bed(),
            label: o.id.filter(|_| labelled).map(Arc::from),
        })
        .collect();
    let planned = Arc::new(plate::join(&joinable, &bands, &settings));
    // Each object's band, renumbered as the plate's layer it prints on.
    let mut plate_index: Vec<Vec<usize>> =
        plans.iter().map(|p| vec![0; p.cut.bands.len()]).collect();
    for (k, band) in bands.iter().enumerate() {
        for &(o, i) in &band.members {
            plate_index[o][i] = k;
        }
    }
    let belt_stamp = belt_job
        .as_ref()
        .map(|job| patch::BeltStamp::from_belt(&job.belt));
    let kept_plate = plans
        .iter()
        .map(|p| p.kept.as_ref())
        .collect::<Option<Vec<&KeptPlan>>>()
        .map(|kept| {
            let edits: Vec<&[SupportEdit]> = objects
                .iter()
                .map(|o| o.settings.support_edits.as_slice())
                .collect();
            let whole: Vec<[u8; 32]> = kept.iter().map(|k| k.key).collect();
            let contours: Vec<[u8; 32]> = kept.iter().map(|k| k.contours).collect();
            let prior = kept::plate_prior();
            kept::keep_plate(Arc::clone(&planned));
            KeptPlate {
                token: patch::token(
                    &whole,
                    &profile,
                    &edits,
                    belt_stamp.as_ref(),
                    sequential_stamp,
                ),
                drawn: patch::drawn(&contours, &profile),
                prior,
                belt: belt_stamp,
                sequential: sequential_stamp,
            }
        });
    // A frame lowered for floor supports starts with layers nothing reached.
    if let Some(job) = belt_job.as_mut().filter(|job| job.floor.is_some()) {
        job.belt.start = planned
            .iter()
            .find(|layer| !layer.is_empty())
            .map_or(0.0, |layer| layer.z - layer.height);
    }
    // Copies are emit-only. Contour stages stay the single planned part.
    // The preview prior is the expanded plate, which is what the client draws.
    let belt_emit = belt_job.as_ref().map(|job| &job.belt);
    let belt_tilt = belt_job.as_ref().map(|job| patch::BeltTilt {
        belt: job.belt,
        offsets: job.offsets.clone(),
    });
    let emit_held = if let Some(job) = &belt_job {
        let arc = Arc::new(belt_output((*planned).clone(), job));
        if kept_plate.is_some() {
            kept::keep_plate(Arc::clone(&arc));
        }
        arc
    } else {
        Arc::clone(&planned)
    };
    let emit_layers: &[PlateLayer] = emit_held.as_slice();
    let emit_started = Instant::now();
    let (gcode, gcode_text) = if settings.include_gcode {
        let gcode = emit_gcode(
            emit_layers,
            &profile,
            requested,
            layer_height,
            line_width,
            &features,
            settings.arc_fit,
            settings.classic_estimator,
            settings.junction_deviation_mm,
            &offsets,
            belt_emit,
            settings.flow,
            crate::gcode::RetractEmit {
                length_mm: settings.retract_length,
                speed_mm_s: settings.retract_speed,
            },
            settings.job,
            watch,
        );
        (gcode, None)
    } else {
        let (gcode, text) = emit_later(
            emit_layers,
            &profile,
            requested,
            layer_height,
            line_width,
            &features,
            settings.arc_fit,
            settings.classic_estimator,
            settings.junction_deviation_mm,
            &offsets,
            belt_emit,
            settings.flow,
            crate::gcode::RetractEmit {
                length_mm: settings.retract_length,
                speed_mm_s: settings.retract_speed,
            },
            settings.job,
            watch,
        );
        (gcode, Some(text))
    };
    let emit_ms = elapsed_ms(emit_started);
    if gcode.cancelled || watch.stopped(settings.job) {
        return Err("cancelled".into());
    }
    let core_ms = elapsed_ms(started);
    let mut spent = Spent::default();
    for p in &plans {
        spent.add(&p.spent);
    }
    let stages = StageTimes {
        contour_ms: spent.contour_ms,
        support_ms: spent.support_ms,
        order_ms: spent.order_ms,
        toolpath_ms: spent.toolpath_ms,
        emit_ms,
        comb_ms: spent.comb_ms,
        index_ms: spent.index_ms,
        cut_cpu_ms: spent.cut_cpu_ms,
        simplify_cpu_ms: spent.simplify_cpu_ms,
        roof_ms: spent.roof_ms,
        wall_cpu_ms: spent.wall_cpu_ms,
        infill_cpu_ms: spent.infill_cpu_ms,
        reused: plans
            .iter()
            .map(|p| p.reuse)
            .reduce(Reuse::both)
            .unwrap_or_default()
            .names(),
        edits_reused: plans.iter().map(|p| p.reuse.edits).sum(),
        edit_apply_ms: spent.edit_apply_ms,
        edit_refresh_ms: spent.edit_refresh_ms,
        layers_reused: plans.iter().map(|p| p.layers_reused).sum(),
        toolpath_layers_reused: plans.iter().map(|p| p.reuse.toolpath_layers).sum(),
        order_layers_reused: plans.iter().map(|p| p.reuse.order_layers).sum(),
        comb_layers_reused: plans.iter().map(|p| p.reuse.comb_layers).sum(),
    };
    let views: Vec<ObjectView> = plans
        .iter()
        .zip(&objects)
        .zip(&bounds)
        .enumerate()
        .map(|(o, ((p, obj), &(min, max)))| {
            let indexed: Vec<LayerBand> = p
                .cut
                .bands
                .iter()
                .map(|b| LayerBand {
                    index: plate_index[o][b.index],
                    ..*b
                })
                .collect();
            ObjectView {
                id: obj.id.unwrap_or_default().to_owned(),
                min,
                max,
                triangles: obj.mesh.triangle_count(),
                offset: if let Some(job) = &belt_job {
                    job.offsets[o].unwrap_or([0.0, 0.0])
                } else {
                    obj.to_bed()
                },
                coverage: p.coverage.clone(),
                in_air: p.in_air,
                skeleton: obj
                    .settings
                    .include_skeleton
                    .then(|| skeleton(&p.supports, &indexed)),
                support_edits: p
                    .outcomes
                    .iter()
                    .map(|out| EditOutcomeView::of(out, &indexed))
                    .collect(),
                support_paint: (!obj.settings.support_paint.is_empty()).then(|| {
                    paint::tally(
                        &obj.settings.support_paint,
                        &obj.mesh,
                        &p.cut.bands,
                        obj.settings.supports,
                    )
                }),
                reused: p.reuse.names(),
            }
        })
        .collect();

    let alone = objects.len() == 1;
    let (baseline_ms, baseline_label) = if settings.baseline && alone {
        let object = &objects[0];
        let baseline_mode = BlendMode::Single {
            strategy: StrategyId::Speed,
        };
        let baseline_started = Instant::now();
        let quiet = watch.silent();
        let baseline_plan = plan_sharing(
            &object.mesh,
            &baseline_mode,
            &object.settings.unkept(),
            plans[0].cut.bands.clone(),
            profile.nozzle_diameter,
            cut,
            &quiet,
        )?;
        let baseline_planned = plate::join(
            &[plate::Joinable {
                layers: &baseline_plan.layers,
                heads: &baseline_plan.heads,
                offset: object.to_bed(),
                label: None,
            }],
            &bands,
            &settings,
        );
        let baseline_owned;
        let baseline_layers: &[PlateLayer] = if let Some(job) = &belt_job {
            baseline_owned = belt_output(baseline_planned, job);
            &baseline_owned
        } else {
            &baseline_planned
        };
        let baseline_belt = belt_job.as_ref().map(|job| &job.belt);
        let baseline_gcode = if settings.include_gcode {
            emit_gcode(
                baseline_layers,
                &profile,
                &baseline_mode,
                layer_height,
                line_width,
                &features,
                settings.arc_fit,
                settings.classic_estimator,
                settings.junction_deviation_mm,
                &offsets,
                baseline_belt,
                settings.flow,
                crate::gcode::RetractEmit {
                    length_mm: settings.retract_length,
                    speed_mm_s: settings.retract_speed,
                },
                settings.job,
                &quiet,
            )
        } else {
            crate::gcode::emit_estimates(
                baseline_layers,
                &profile,
                &baseline_mode,
                layer_height,
                line_width,
                &features,
                settings.arc_fit,
                settings.classic_estimator,
                settings.junction_deviation_mm,
                &offsets,
                baseline_belt,
                settings.flow,
                crate::gcode::RetractEmit {
                    length_mm: settings.retract_length,
                    speed_mm_s: settings.retract_speed,
                },
                settings.job,
                &quiet,
            )
        };
        if baseline_gcode.cancelled || watch.stopped(settings.job) {
            return Err("cancelled".into());
        }
        (
            elapsed_ms(baseline_started),
            "single-strategy speed (same mesh, layer height, and line width)".into(),
        )
    } else {
        (0.0, "skipped".into())
    };
    let compare = if settings.compare && alone {
        compare_estimates(
            &objects[0].mesh,
            &objects[0].settings,
            &profile,
            cut,
            &watch.silent(),
        )?
    } else {
        Vec::new()
    };
    let on_bed: Vec<([f64; 2], [f64; 2])> = objects
        .iter()
        .zip(&bounds)
        .enumerate()
        .map(|(i, (o, (min, max)))| {
            let [dx, dy] = if let Some(job) = &belt_job {
                job.offsets[i].unwrap_or([0.0, 0.0])
            } else {
                o.to_bed()
            };
            ([min[0] + dx, min[1] + dy], [max[0] + dx, max[1] + dy])
        })
        .collect();
    let min_bed = on_bed
        .iter()
        .map(|b| b.0)
        .reduce(|a, b| [a[0].min(b[0]), a[1].min(b[1])])
        .unwrap_or([0.0, 0.0]);
    let max_bed = on_bed
        .iter()
        .map(|b| b.1)
        .reduce(|a, b| [a[0].max(b[0]), a[1].max(b[1])])
        .unwrap_or([0.0, 0.0]);
    let margin = 4.0;
    let mut notes = Vec::new();
    if gcode.layer_count == 0 {
        notes.push("no layers were produced".into());
    }
    if gcode.extrusion_moves == 0 {
        notes.push("no extrusion moves".into());
    }
    if gcode.final_e <= 0.0 {
        notes.push("final E is not positive".into());
    }
    // Gantry XY is the nozzle plane, not the lab box, so this check is cartesian only.
    if belt_job.is_none() {
        if gcode.min_x < min_bed[0] - margin || gcode.max_x > max_bed[0] + margin {
            notes.push(format!(
                "X bounds {:.2}..{:.2} outside mesh {:.2}..{:.2} ± {margin}",
                gcode.min_x, gcode.max_x, min_bed[0], max_bed[0]
            ));
        }
        if gcode.min_y < min_bed[1] - margin || gcode.max_y > max_bed[1] + margin {
            notes.push(format!(
                "Y bounds {:.2}..{:.2} outside mesh {:.2}..{:.2} ± {margin}",
                gcode.min_y, gcode.max_y, min_bed[1], max_bed[1]
            ));
        }
    }
    if settings.include_gcode && !gcode.text.contains(";LAYER:") {
        notes.push("g-code is missing layer markers".into());
    }

    let blends: Vec<&BlendMode> = objects.iter().map(|o| &o.blend).collect();
    let (layers, preview_token, preview_patch) = if !settings.include_preview {
        (Vec::new(), None, None)
    } else {
        preview(
            &emit_held,
            kept_plate,
            &profile,
            &blends,
            settings.preview_base.as_deref(),
            &gcode.layer_seconds,
            belt_tilt.as_ref(),
        )
    };
    let repaired_layers = plans.iter().map(|plan| plan.cut.repaired_layers).sum();
    let dropped_chains = plans.iter().map(|plan| plan.cut.dropped_chains).sum();
    let mesh = if listed {
        MeshInfo {
            triangles: objects.iter().map(|o| o.mesh.triangle_count()).sum(),
            outline_tolerance_mm: outline_tolerance(&settings, profile.nozzle_diameter),
            repaired_layers,
            dropped_chains,
            min: [
                min_bed[0],
                min_bed[1],
                bounds.iter().map(|b| b.0[2]).fold(f64::INFINITY, f64::min),
            ],
            max: [
                max_bed[0],
                max_bed[1],
                bounds
                    .iter()
                    .map(|b| b.1[2])
                    .fold(f64::NEG_INFINITY, f64::max),
            ],
        }
    } else {
        MeshInfo {
            triangles: objects[0].mesh.triangle_count(),
            outline_tolerance_mm: outline_tolerance(&settings, profile.nozzle_diameter),
            min: bounds[0].0,
            max: bounds[0].1,
            repaired_layers,
            dropped_chains,
        }
    };
    let collisions = listed.then(|| {
        let boxes: Vec<(&str, [f64; 2], [f64; 2])> = if belt_job.is_some() {
            // The plan is in the nozzle plane. The lab boxes are the overlap.
            objects
                .iter()
                .zip(&on_bed)
                .map(|(o, b)| (o.id.unwrap_or_default(), b.0, b.1))
                .collect()
        } else {
            objects
                .iter()
                .zip(&on_bed)
                .zip(&plans)
                .map(|((o, b), plan)| {
                    let [dx, dy] = o.to_bed();
                    let (lo, hi) = plate::first_layer_reach(plan, b.0, b.1, [dx, dy]);
                    (o.id.unwrap_or_default(), lo, hi)
                })
                .collect()
        };
        plate::collisions(&boxes)
    });
    let (offset, coverage, in_air, support_edits, support_paint, skeleton, objects_view) = if listed
    {
        (None, Vec::new(), None, Vec::new(), None, None, views)
    } else {
        let view = views.into_iter().next().expect("one object");
        (
            if let Some(job) = &belt_job {
                job.offsets[0]
            } else {
                objects[0].offset
            },
            view.coverage,
            view.in_air,
            view.support_edits,
            view.support_paint,
            view.skeleton,
            Vec::new(),
        )
    };
    Ok(SliceResponse {
        core_ms,
        baseline_ms,
        baseline_label,
        mesh,
        offset,
        stages,
        sanity: Sanity {
            ok: notes.is_empty(),
            layers: gcode.layer_count,
            extrusion_moves: gcode.extrusion_moves,
            travel_moves: gcode.travel_moves,
            final_e: gcode.final_e,
            extrusion_length_mm: gcode.extrusion_length_mm,
            travel_length_mm: gcode.travel_length_mm,
            min_x: gcode.min_x,
            max_x: gcode.max_x,
            min_y: gcode.min_y,
            max_y: gcode.max_y,
            notes,
            retracts: gcode.retracts,
            z_hops: gcode.z_hops,
        },
        coverage,
        in_air,
        gcode: gcode.text,
        gcode_text,
        layers,
        blend: requested.describe(),
        estimate: {
            let (scarfed_loops, mean_scarf_mm, max_seam_z_step_mm) = seam_metrics(emit_layers);
            PrintEstimate {
                seconds: gcode.print_time_s,
                filament_mm: gcode.filament_mm,
                filament_g: gcode.filament_g,
                arc_moves: gcode.arc_moves,
                travel_mm: gcode.travel_length_mm,
                retracts: gcode.retracts,
                z_hops: gcode.z_hops,
                scarfed_loops,
                mean_scarf_mm,
                max_seam_z_step_mm,
                by_feature: feature_estimates(&gcode.by_feature, &profile),
            }
        },
        score: score_of(
            gcode.print_time_s,
            gcode.filament_g,
            structural_mm3(emit_layers),
        ),
        compare,
        support_edits,
        support_paint,
        skeleton,
        preview_token,
        preview_patch,
        objects: objects_view,
        collisions,
    })
}

/// A plate preview's name and what it was drawn from, when every object came
/// from the kept stages, and the preview the client was given before.
struct KeptPlate {
    token: String,
    drawn: [u8; 32],
    prior: Option<(Arc<Vec<PlateLayer>>, Arc<patch::Shown>)>,
    belt: Option<patch::BeltStamp>,
    /// True only when two or more objects print one at a time.
    sequential: bool,
}

/// The reply's preview. A kept plate names it with a token, and when the
/// request's `previewBase` is the preview the engine last drew from the same
/// cuts under the same blends and flow cap, only the layers that differ go
/// back, as a patch.
fn preview(
    planned: &Arc<Vec<PlateLayer>>,
    kept: Option<KeptPlate>,
    profile: &PrinterProfile,
    blends: &[&BlendMode],
    preview_base: Option<&str>,
    layer_seconds: &[f64],
    tilt: Option<&patch::BeltTilt>,
) -> (Vec<PreviewLayer>, Option<String>, Option<PreviewPatch>) {
    let Some(kept) = kept else {
        let mut layers = preview_of(planned, profile, blends, layer_seconds);
        if let Some(tilt) = tilt {
            tilt_preview(&mut layers, planned, tilt);
        }
        return (layers, None, None);
    };
    let mut emitted = layer_seconds.iter();
    let seconds: Vec<Option<f64>> = planned
        .iter()
        .map(|l| (!l.is_empty()).then(|| emitted.next().copied().unwrap_or(0.0)))
        .collect();
    // A different belt stamp is a different drawing. The planned paths can
    // match while the tilt does not, so that reply is the whole plate.
    let base = kept.prior.as_ref().filter(|(_, shown)| {
        preview_base == Some(shown.token.as_str())
            && shown.drawn == kept.drawn
            && shown.belt == kept.belt
            && shown.sequential == kept.sequential
    });
    let (mut layers, mut patched) = match base {
        Some((joined, shown)) => {
            let shown_blends: Vec<&BlendMode> = shown.blends.iter().collect();
            let restyled: Vec<bool> = (0..blends.len())
                .map(|o| {
                    shown
                        .blends
                        .get(o)
                        .is_none_or(|b| format!("{b:?}") != format!("{:?}", blends[o]))
                })
                .collect();
            let changed = planned
                .par_iter()
                .enumerate()
                .filter_map(|(i, layer)| {
                    let now = seconds[i]?;
                    let was = joined.get(i);
                    let held = was.is_some() && shown.seconds.get(i).is_some_and(Option::is_some);
                    let same = was.is_some_and(|w| w.same(layer))
                        && layer.runs.iter().all(|r| !restyled[r.object as usize]);
                    if held && same {
                        return None;
                    }
                    let layer = preview_layer(layer, profile, blends, now);
                    let was = match was.filter(|_| held) {
                        Some(was) => preview_layer(was, profile, &shown_blends, 0.0).paths,
                        None => Vec::new(),
                    };
                    Some(patch::diff_layer(&was, layer))
                })
                .collect();
            let patch = PreviewPatch {
                base: shown.token.clone(),
                layers: planned
                    .iter()
                    .filter(|l| !l.is_empty())
                    .map(|l| l.index)
                    .collect(),
                changed,
                seconds: seconds.iter().flatten().copied().collect(),
                whole: WholePreview {
                    layers: Arc::clone(planned),
                    profile: profile.clone(),
                    blends: blends.iter().map(|&b| b.clone()).collect(),
                    layer_seconds: layer_seconds.to_vec(),
                    tilt: tilt.cloned(),
                },
            };
            (Vec::new(), Some(patch))
        }
        None => (preview_of(planned, profile, blends, layer_seconds), None),
    };
    if let Some(tilt) = tilt {
        if let Some(patch) = patched.as_mut() {
            for changed in &mut patch.changed {
                if let Some(plate) = planned.iter().find(|l| l.index == changed.layer.index) {
                    tilt_layer(&mut changed.layer, plate, tilt);
                }
            }
        } else {
            tilt_preview(&mut layers, planned, tilt);
        }
    }
    kept::show(
        planned,
        patch::Shown {
            token: kept.token.clone(),
            drawn: kept.drawn,
            blends: blends.iter().map(|&b| b.clone()).collect(),
            seconds,
            belt: kept.belt,
            sequential: kept.sequential,
        },
    );
    (layers, Some(kept.token), patched)
}

fn feature_estimates(
    rows: &[crate::gcode::FeatureStat],
    profile: &PrinterProfile,
) -> Vec<FeatureEstimate> {
    let area = std::f64::consts::PI * (profile.filament_diameter * 0.5).powi(2);
    let scale = area * profile.filament_density_g_cm3 / 1000.0;
    rows.iter()
        .map(|row| FeatureEstimate {
            kind: row.kind.clone(),
            seconds: row.seconds,
            filament_mm: row.filament_mm,
            filament_g: row.filament_mm * scale,
        })
        .collect()
}

fn compare_estimates(
    mesh: &Mesh,
    settings: &SliceSettings,
    profile: &PrinterProfile,
    cut: &mut Option<Arc<Contours>>,
    watch: &Watch,
) -> Result<Vec<CompareEstimate>, String> {
    let mut quiet = settings.unkept();
    quiet.baseline = false;
    quiet.compare = false;
    let modes = [
        (
            "speed",
            BlendMode::Single {
                strategy: StrategyId::Speed,
            },
            false,
        ),
        ("efficiency", BlendMode::Weight { toughness: 0.5 }, false),
        (
            "toughness",
            BlendMode::Single {
                strategy: StrategyId::Toughness,
            },
            false,
        ),
        (
            "classic",
            BlendMode::Single {
                strategy: StrategyId::Speed,
            },
            true,
        ),
    ];
    let mut out = Vec::with_capacity(modes.len());
    for (label, blend, classic) in modes {
        let mut one = quiet.clone();
        one.classic = classic;
        if classic {
            one.variable_width = false;
            one.arc_fit = false;
            one.travel_opt = false;
            one.overhang_control = false;
            one.infill_combine = false;
            one.combing = false;
            one.feature_speeds = false;
            one.scarf_seam = ScarfSeam::Off;
            one.support_style = SupportStyle::Grid;
            one.support_height_mult = 1.0;
        }
        let response = slice_sharing(mesh, &blend, profile, &one, cut, watch)?;
        out.push(CompareEstimate {
            label: label.into(),
            seconds: response.estimate.seconds,
            filament_g: response.estimate.filament_g,
            by_feature: response.estimate.by_feature,
        });
    }
    Ok(out)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParetoPoint {
    pub label: String,
    pub toughness: f64,
    pub seconds: f64,
    pub filament_g: f64,
    /// Structural toughness proxy from the same scorer as a normal slice.
    pub score: f64,
}

/// Speed, three weight mixes, and toughness. No preview polylines and no G-code text.
pub fn pareto_estimates(
    mesh: &Mesh,
    profile: &PrinterProfile,
    settings: &SliceSettings,
) -> Result<Vec<ParetoPoint>, String> {
    let mut quiet = settings.unkept();
    quiet.baseline = false;
    quiet.compare = false;
    quiet.include_gcode = false;
    let points = [
        (0.0, "speed"),
        (0.25, "weight 25%"),
        (0.5, "weight 50%"),
        (0.75, "weight 75%"),
        (1.0, "toughness"),
    ];
    // Each blend already fans its layers out across the pool. A second
    // `par_iter` over the five blends oversubscribes that pool: on this part
    // the grid blend then took ~20 s instead of ~7.5 s alone, and the five
    // together were slower than one-after-another. The blends share one cut.
    let mut cut = None;
    points
        .iter()
        .map(|(toughness, label)| {
            let blend = if *toughness <= 1e-9 {
                BlendMode::Single {
                    strategy: StrategyId::Speed,
                }
            } else if *toughness >= 1.0 - 1e-9 {
                BlendMode::Single {
                    strategy: StrategyId::Toughness,
                }
            } else {
                BlendMode::Weight {
                    toughness: *toughness,
                }
            };
            let response = slice_sharing(mesh, &blend, profile, &quiet, &mut cut, &Watch::idle())?;
            Ok(ParetoPoint {
                label: (*label).into(),
                toughness: *toughness,
                seconds: response.estimate.seconds,
                filament_g: response.estimate.filament_g,
                score: response.score.toughness,
            })
        })
        .collect()
}

fn score_of(seconds: f64, grams: f64, toughness: f64) -> BlendScore {
    BlendScore {
        speed: 60.0 / (seconds / 60.0).max(0.05),
        efficiency: 8.0 / grams.max(0.02),
        toughness,
    }
}

fn structural_mm3(layers: &[PlateLayer]) -> f64 {
    layers
        .iter()
        .map(|layer| {
            layer
                .paths()
                .map(|(_, path)| {
                    let len = path
                        .points
                        .windows(2)
                        .map(|w| {
                            let dx = w[1][0] - w[0][0];
                            let dy = w[1][1] - w[0][1];
                            dx.hypot(dy)
                        })
                        .sum::<f64>();
                    let h = if path.bead_height > 1e-6 {
                        path.bead_height
                    } else {
                        layer.height
                    };
                    let (z_scale, flow_scale) = scarf_scales(path);
                    len * path.width * h * z_scale * path.strength * path.flow * flow_scale
                })
                .sum::<f64>()
        })
        .sum()
}

/// Coordinates, speeds, and weights on the wire are rounded to 1 µm (or 0.001).
struct Rounded(f64);

impl Serialize for Rounded {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_f64((self.0 * 1000.0).round() / 1000.0)
    }
}

/// A layer's paths as parallel arrays, so a large preview is a few long
/// number arrays instead of one object per path. `start[i]..start[i + 1]`
/// are path `i`'s points in `xy` (two numbers each) and `z` (one each). `z` is
/// empty when every point sits on the layer, and `null` marks a point that does.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PathColumns<'a> {
    kinds: Vec<&'a str>,
    strategies: Vec<&'a str>,
    kind: Vec<u8>,
    strategy: Vec<u8>,
    width: Vec<Rounded>,
    speed: Vec<Rounded>,
    effective_speed: Vec<Rounded>,
    toughness: Vec<Rounded>,
    bead_height: Vec<Rounded>,
    start: Vec<u32>,
    xy: Vec<Rounded>,
    z: Vec<Rounded>,
    /// Each path's object. Empty when every path is object 0.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    object: Vec<u16>,
}

fn path_columns<S: serde::Serializer>(paths: &[PreviewPath], s: S) -> Result<S::Ok, S::Error> {
    fn slot<'a>(table: &mut Vec<&'a str>, name: &'a str) -> u8 {
        match table.iter().position(|k| *k == name) {
            Some(i) => i as u8,
            None => {
                table.push(name);
                (table.len() - 1) as u8
            }
        }
    }
    let points: usize = paths.iter().map(|p| p.pts.len()).sum();
    let has_z = paths.iter().any(|p| !p.zs.is_empty());
    let mut c = PathColumns {
        kinds: Vec::new(),
        strategies: Vec::new(),
        kind: Vec::with_capacity(paths.len()),
        strategy: Vec::with_capacity(paths.len()),
        width: Vec::with_capacity(paths.len()),
        speed: Vec::with_capacity(paths.len()),
        effective_speed: Vec::with_capacity(paths.len()),
        toughness: Vec::with_capacity(paths.len()),
        bead_height: Vec::with_capacity(paths.len()),
        start: Vec::with_capacity(paths.len() + 1),
        xy: Vec::with_capacity(points * 2),
        z: Vec::with_capacity(if has_z { points } else { 0 }),
        object: if paths.iter().any(|p| p.object != 0) {
            paths.iter().map(|p| p.object).collect()
        } else {
            Vec::new()
        },
    };
    c.start.push(0);
    for p in paths {
        let k = slot(&mut c.kinds, &p.kind);
        c.kind.push(k);
        let st = slot(&mut c.strategies, &p.strategy);
        c.strategy.push(st);
        c.width.push(Rounded(p.width));
        c.speed.push(Rounded(p.speed));
        c.effective_speed.push(Rounded(p.effective_speed));
        c.toughness.push(Rounded(p.toughness));
        c.bead_height.push(Rounded(p.bead_height));
        for (i, pt) in p.pts.iter().enumerate() {
            c.xy.push(Rounded(pt[0]));
            c.xy.push(Rounded(pt[1]));
            if has_z {
                // NaN serializes as JSON null: this point is at the layer Z.
                c.z.push(Rounded(p.zs.get(i).copied().unwrap_or(f64::NAN)));
            }
        }
        c.start.push((c.xy.len() / 2) as u32);
    }
    c.serialize(s)
}

fn preview_of(
    layers: &[PlateLayer],
    profile: &PrinterProfile,
    blends: &[&BlendMode],
    layer_seconds: &[f64],
) -> Vec<PreviewLayer> {
    layers
        .iter()
        .filter(|l| !l.is_empty())
        .enumerate()
        .map(|(emitted, layer)| {
            let seconds = layer_seconds.get(emitted).copied().unwrap_or(0.0);
            preview_layer(layer, profile, blends, seconds)
        })
        .collect()
}

/// One printed layer as the preview draws it: a travel before each path
/// that moves the nozzle, then the path, decimated. Each path is in its
/// object's part frame, so a travel from another object is not drawn.
fn preview_layer(
    layer: &PlateLayer,
    profile: &PrinterProfile,
    blends: &[&BlendMode],
    seconds: f64,
) -> PreviewLayer {
    let mut paths = Vec::new();
    let mut cursor: Option<[f64; 2]> = None;
    let mut speed_walls = 0u32;
    let mut toughness_walls = 0u32;
    let mut support_paths = 0u32;
    for run in &layer.runs {
        if run.entry != Entry::AsPlanned {
            cursor = None;
        }
        let blend = blends[run.object as usize];
        for path in &run.layer.paths[run.paths.clone()] {
            if path.kind == PathKind::Support || path.kind == PathKind::SupportInterface {
                support_paths += 1;
            }
            preview_path(
                &mut paths,
                &mut cursor,
                (&mut speed_walls, &mut toughness_walls),
                layer,
                path,
                run.object,
                profile,
                blend,
            );
        }
    }
    PreviewLayer {
        index: layer.index,
        z: layer.z,
        height: layer.height,
        note: layer.note.clone(),
        speed_walls,
        toughness_walls,
        support_paths,
        seconds,
        paths,
    }
}

#[allow(clippy::too_many_arguments)]
fn preview_path(
    paths: &mut Vec<PreviewPath>,
    cursor: &mut Option<[f64; 2]>,
    (speed_walls, toughness_walls): (&mut u32, &mut u32),
    layer: &PlateLayer,
    path: &Extrusion,
    object: u16,
    profile: &PrinterProfile,
    blend: &BlendMode,
) {
    if path.kind.is_wall() {
        match path.strategy {
            StrategyId::Speed => *speed_walls += 1,
            StrategyId::Toughness => *toughness_walls += 1,
        }
    }
    if let (Some(c), Some(start)) = (*cursor, path.points.first()) {
        let mut pts = vec![c];
        pts.extend(path.lead_in.iter().copied());
        pts.push(*start);
        if pts.len() > 2 || dist2(c, *start) > 0.05 * 0.05 {
            paths.push(PreviewPath {
                kind: "travel".into(),
                strategy: path.strategy.as_str().into(),
                pts,
                width: 0.0,
                speed: path.travel_speed,
                effective_speed: path.travel_speed,
                toughness: path_weight(blend, layer.z, path.strategy),
                zs: Vec::new(),
                bead_height: 0.0,
                object,
            });
        }
    }
    let (pts, zs) = decimate_path(&path.points, &path.z_frac, layer.z, layer.height);
    let bead = if path.bead_height > 1e-6 {
        path.bead_height
    } else {
        layer.height
    };
    let mut limited = crate::gcode::limit_speed(
        path.speed,
        path.width,
        bead,
        path.flow,
        profile.max_volumetric_mm3_s,
    );
    if layer.index == 0 {
        limited = limited.min(30.0);
    }
    paths.push(PreviewPath {
        kind: path.kind.as_str().into(),
        strategy: path.strategy.as_str().into(),
        pts,
        width: path.width,
        speed: path.speed,
        effective_speed: limited,
        toughness: path_weight(blend, layer.z, path.strategy),
        zs,
        bead_height: if path.bead_height > 1e-6 {
            path.bead_height
        } else {
            0.0
        },
        object,
    });
    *cursor = path.points.last().copied();
}

fn path_weight(blend: &BlendMode, z: f64, strategy: StrategyId) -> f64 {
    match blend {
        BlendMode::Single { strategy } => match strategy {
            StrategyId::Speed => 0.0,
            StrategyId::Toughness => 1.0,
        },
        BlendMode::Weight { toughness } => toughness.clamp(0.0, 1.0),
        BlendMode::ByLayer {
            bottom_mm,
            transition_mm,
        } => layer_weight(z, *bottom_mm, *transition_mm),
        BlendMode::ByRegion { .. } => match strategy {
            StrategyId::Speed => 0.0,
            StrategyId::Toughness => 1.0,
        },
    }
}

fn decimate_path(
    pts: &[[f64; 2]],
    z_frac: &[f64],
    layer_z: f64,
    layer_h: f64,
) -> (Vec<[f64; 2]>, Vec<f64>) {
    let z_at = |i: usize| {
        z_frac
            .get(i)
            .map(|f| layer_z - layer_h * (1.0 - f.clamp(0.0, 1.0)))
    };
    if pts.len() <= 2 {
        let zs = (0..pts.len()).filter_map(z_at).collect::<Vec<_>>();
        let zs = if zs.len() == pts.len() {
            zs
        } else {
            Vec::new()
        };
        return (pts.to_vec(), zs);
    }
    let mut keep = vec![0usize];
    for i in 1..pts.len() {
        let last = pts[*keep.last().unwrap()];
        if dist2(last, pts[i]) >= 0.04 * 0.04 {
            keep.push(i);
        }
    }
    if *keep.last().unwrap() != pts.len() - 1 {
        keep.push(pts.len() - 1);
    }
    let out: Vec<[f64; 2]> = keep.iter().map(|i| pts[*i]).collect();
    let zs: Vec<f64> = keep.iter().filter_map(|i| z_at(*i)).collect();
    let zs = if zs.len() == out.len() {
        zs
    } else {
        Vec::new()
    };
    (out, zs)
}

fn seam_metrics(layers: &[PlateLayer]) -> (usize, f64, f64) {
    let mut n = 0usize;
    let mut sum = 0.0;
    let mut max_step = 0.0f64;
    for layer in layers {
        for (_, path) in layer.paths() {
            if path.scarf_mm <= 0.0 {
                continue;
            }
            n += 1;
            sum += path.scarf_mm;
            for w in path.z_frac.windows(2) {
                max_step = max_step.max((w[1] - w[0]).abs() * layer.height);
            }
        }
    }
    let mean = if n == 0 { 0.0 } else { sum / n as f64 };
    (n, mean, max_step)
}

fn scarf_scales(path: &Extrusion) -> (f64, f64) {
    if path.z_frac.len() != path.points.len() || path.points.len() < 2 {
        return (1.0, 1.0);
    }
    let mut len = 0.0;
    let mut z_acc = 0.0;
    let mut f_acc = 0.0;
    for i in 0..path.points.len() - 1 {
        let dx = path.points[i + 1][0] - path.points[i][0];
        let dy = path.points[i + 1][1] - path.points[i][1];
        let seg = dx.hypot(dy);
        let z = 0.5 * (path.z_frac[i] + path.z_frac[i + 1]).clamp(0.0, 1.0);
        let f = if path.flow_frac.len() == path.points.len() {
            0.5 * (path.flow_frac[i] + path.flow_frac[i + 1]).clamp(0.0, 2.0)
        } else {
            1.0
        };
        len += seg;
        z_acc += seg * z;
        f_acc += seg * f;
    }
    if len < 1e-6 {
        return (1.0, 1.0);
    }
    (z_acc / len, f_acc / len)
}

fn dist2(a: [f64; 2], b: [f64; 2]) -> f64 {
    let dx = a[0] - b[0];
    let dy = a[1] - b[1];
    dx * dx + dy * dy
}

/// Everything `plan` derives from the mesh. `layers` is what the G-code writer
/// consumes; the rest is kept for the audit and the response.
pub(crate) struct Plan {
    pub layers: Vec<PrintLayer>,
    /// How many leading paths of each layer are its skirt and supports.
    pub heads: Vec<usize>,
    pub cut: Arc<Contours>,
    pub supports: Arc<Supports>,
    pub coverage: Vec<CoverageGap>,
    pub in_air: Option<InAir>,
    /// What each requested support edit did, in request order.
    pub outcomes: Vec<EditOutcome>,
    pub reuse: Reuse,
    pub spent: Spent,
    pub layers_reused: u32,
    /// Set when the plan came from the kept stages.
    pub kept: Option<KeptPlan>,
}

/// What a plan from the kept stages adds to its plate's preview token.
pub(crate) struct KeptPlan {
    /// Names the plan.
    key: [u8; 32],
    /// The cut's key. A preview patches only one drawn from the same cuts.
    contours: [u8; 32],
}

/// The stages a plan took from the kept slices instead of computing them.
#[derive(Clone, Copy, Default)]
pub(crate) struct Reuse {
    pub contours: bool,
    pub toolpaths: bool,
    pub order: bool,
    pub comb: bool,
    /// The supports as grown, before painting.
    pub supports: bool,
    pub support_paths: bool,
    /// Leading edits whose result was already applied.
    pub edits: u32,
    /// Layers a part stage computed again took from a kept plan.
    pub toolpath_layers: u32,
    pub order_layers: u32,
    pub comb_layers: u32,
}

impl Reuse {
    /// The reused stages, as `StageTimes.reused` names them.
    fn names(&self) -> Vec<&'static str> {
        [
            (self.contours, "contours"),
            (self.toolpaths, "toolpaths"),
            (self.order, "order"),
            (self.comb, "comb"),
            (self.supports, "supports"),
            (self.support_paths, "supportPaths"),
        ]
        .into_iter()
        .filter_map(|(on, name)| on.then_some(name))
        .collect()
    }

    /// The stages both plans reused.
    fn both(self, other: Reuse) -> Reuse {
        Reuse {
            contours: self.contours && other.contours,
            toolpaths: self.toolpaths && other.toolpaths,
            order: self.order && other.order,
            comb: self.comb && other.comb,
            supports: self.supports && other.supports,
            support_paths: self.support_paths && other.support_paths,
            edits: self.edits.min(other.edits),
            toolpath_layers: self.toolpath_layers.min(other.toolpath_layers),
            order_layers: self.order_layers.min(other.order_layers),
            comb_layers: self.comb_layers.min(other.comb_layers),
        }
    }
}

/// Wall-clock and CPU time of the stages a plan computed. A reused stage
/// adds nothing.
#[derive(Clone, Copy, Default)]
pub(crate) struct Spent {
    pub contour_ms: f64,
    pub index_ms: f64,
    pub cut_cpu_ms: f64,
    pub simplify_cpu_ms: f64,
    pub roof_ms: f64,
    pub support_ms: f64,
    pub toolpath_ms: f64,
    pub order_ms: f64,
    pub comb_ms: f64,
    pub wall_cpu_ms: f64,
    pub infill_cpu_ms: f64,
    pub edit_apply_ms: f64,
    pub edit_refresh_ms: f64,
}

impl Spent {
    fn add(&mut self, other: &Spent) {
        self.contour_ms += other.contour_ms;
        self.index_ms += other.index_ms;
        self.cut_cpu_ms += other.cut_cpu_ms;
        self.simplify_cpu_ms += other.simplify_cpu_ms;
        self.roof_ms += other.roof_ms;
        self.support_ms += other.support_ms;
        self.toolpath_ms += other.toolpath_ms;
        self.order_ms += other.order_ms;
        self.comb_ms += other.comb_ms;
        self.wall_cpu_ms += other.wall_cpu_ms;
        self.infill_cpu_ms += other.infill_cpu_ms;
        self.edit_apply_ms += other.edit_apply_ms;
        self.edit_refresh_ms += other.edit_refresh_ms;
    }

    fn cut(&mut self, cut: &Contours) {
        let c = &cut.clocks;
        self.contour_ms += c.contour_ms;
        self.index_ms += c.index_ms;
        self.cut_cpu_ms += c.cut_cpu_ms;
        self.simplify_cpu_ms += c.simplify_cpu_ms;
        self.roof_ms += c.roof_ms;
    }

    fn toolpaths(&mut self, part: &PartPaths) {
        self.toolpath_ms += part.toolpath_ms;
        self.wall_cpu_ms += part.wall_cpu_ms;
        self.infill_cpu_ms += part.infill_cpu_ms;
    }

    fn supports(&mut self, plan: &SupportPlan) {
        self.support_ms += plan.support_ms;
        self.toolpath_ms += plan.toolpath_ms;
    }
}

/// A sixteenth of the nozzle: 0.025 mm for a 0.4 mm nozzle. Two outlines
/// closer than twice this could touch after simplifying, and a gap that
/// narrow is far below anything the nozzle prints. The raw cut of a dense
/// mesh carries a vertex every few microns, and every boolean after it pays
/// for them.
pub fn outline_tolerance_mm(nozzle_diameter: f64) -> f64 {
    let nozzle = if nozzle_diameter.is_finite() && nozzle_diameter > 0.0 {
        nozzle_diameter
    } else {
        0.4
    };
    nozzle / 16.0
}

fn outline_tolerance(settings: &SliceSettings, nozzle_diameter: f64) -> f64 {
    if !settings.simplify {
        0.0
    } else if settings.simplify_error_mm > 0.0 {
        settings.simplify_error_mm
    } else {
        outline_tolerance_mm(nozzle_diameter)
    }
}

/// Slice the part, plan its supports, apply the settings' edits, and join
/// them. An interactive slice with kept stages on starts from what memory
/// already holds.
pub(crate) fn plan(
    mesh: &Mesh,
    blend: &BlendMode,
    settings: &SliceSettings,
    nozzle_diameter: f64,
) -> Result<Plan, String> {
    plan_sharing(
        mesh,
        blend,
        settings,
        plan_bands(mesh, &height_opts(settings))?,
        nozzle_diameter,
        &mut None,
        &Watch::idle(),
    )
}

/// How the layer settings ask for bands.
fn height_opts(settings: &SliceSettings) -> HeightOpts {
    HeightOpts {
        nominal: settings.layer_height,
        adaptive: settings.adaptive,
        min_h: settings.adaptive_min,
        max_h: if settings.adaptive {
            settings.adaptive_max.max(settings.adaptive_min)
        } else {
            settings.layer_height
        },
    }
}

/// `plan` on `bands`, cutting the mesh only when `shared` holds no cut of it
/// yet, and leaving this plan's cut there. The side plans of one request
/// (baseline, compare, Pareto) cut the same mesh with the same layer
/// settings, and the cut does not depend on the blend.
#[allow(clippy::too_many_arguments)]
fn plan_sharing(
    mesh: &Mesh,
    blend: &BlendMode,
    settings: &SliceSettings,
    bands: Vec<LayerBand>,
    nozzle_diameter: f64,
    shared: &mut Option<Arc<Contours>>,
    watch: &Watch,
) -> Result<Plan, String> {
    let keys = kept_keys(mesh, &bands, blend, settings, nozzle_diameter, None);
    let (cut, reused) = cut_object(
        mesh,
        bands,
        settings,
        nozzle_diameter,
        keys.as_ref(),
        shared,
        watch,
    )?;
    plan_object(
        cut,
        reused,
        keys,
        blend,
        settings,
        nozzle_diameter,
        &[],
        None,
        watch,
    )
}

/// The stage keys of an interactive slice while stages are kept.
/// `floor` is mixed into the support keys only when it is set, so a
/// cartesian slice keeps the key bytes it had.
fn kept_keys(
    mesh: &Mesh,
    bands: &[LayerBand],
    blend: &BlendMode,
    settings: &SliceSettings,
    nozzle_diameter: f64,
    floor: Option<FloorPlane>,
) -> Option<kept::Keys> {
    (kept::on() && settings.include_preview)
        .then(|| kept::keys(mesh, bands, blend, settings, nozzle_diameter, floor))
}

/// The mesh cut on `bands`: kept under `keys`, else the cut in `shared`,
/// else cut now. `shared` holds it afterwards. The flag says it was not cut
/// by this call.
#[allow(clippy::too_many_arguments)]
fn cut_object(
    mesh: &Mesh,
    bands: Vec<LayerBand>,
    settings: &SliceSettings,
    nozzle_diameter: f64,
    keys: Option<&kept::Keys>,
    shared: &mut Option<Arc<Contours>>,
    watch: &Watch,
) -> Result<(Arc<Contours>, bool), String> {
    let mut reused = false;
    let cut = match (keys, shared.as_ref()) {
        (Some(keys), _) => kept::stage(&keys.contours, &mut reused, || {
            cut_mesh(mesh, bands, settings, nozzle_diameter, watch)
        })?,
        (None, Some(cut)) => {
            reused = true;
            Arc::clone(cut)
        }
        (None, None) => Arc::new(cut_mesh(mesh, bands, settings, nozzle_diameter, watch)?),
    };
    if reused {
        watch.complete(Stage::Cut);
    }
    *shared = Some(Arc::clone(&cut));
    Ok((cut, reused))
}

/// Every stage after the cut, from the kept stages when there are `keys`.
/// Supports grow among the `neighbours` that come near them.
#[allow(clippy::too_many_arguments)]
fn plan_object(
    cut: Arc<Contours>,
    reused: bool,
    keys: Option<kept::Keys>,
    blend: &BlendMode,
    settings: &SliceSettings,
    nozzle_diameter: f64,
    neighbours: &[plate::Neighbour],
    floor: Option<FloorPlane>,
    watch: &Watch,
) -> Result<Plan, String> {
    let reuse = Reuse {
        contours: reused,
        ..Reuse::default()
    };
    match keys {
        Some(keys) => plan_kept(
            keys,
            cut,
            reuse,
            blend,
            settings,
            nozzle_diameter,
            neighbours,
            floor,
            watch,
        ),
        None => plan_cut(
            cut,
            reuse,
            blend,
            settings,
            nozzle_diameter,
            neighbours,
            floor,
            watch,
        ),
    }
}

/// `plan` from the mesh already cut into per-band contours.
#[cfg(test)]
fn plan_contours(
    bands: Vec<LayerBand>,
    contours: Vec<Vec<Loop>>,
    bounds: ([f64; 3], [f64; 3]),
    blend: &BlendMode,
    settings: &SliceSettings,
    nozzle_diameter: f64,
) -> Result<Plan, String> {
    let cut = Arc::new(Contours::new(bands, contours, bounds, settings));
    plan_cut(
        cut,
        Reuse::default(),
        blend,
        settings,
        nozzle_diameter,
        &[],
        None,
        &Watch::idle(),
    )
}

/// Every stage after the cut, with nothing kept. `reuse.contours` says the
/// cut was computed elsewhere, so its clocks are not this plan's.
#[allow(clippy::too_many_arguments)]
fn plan_cut(
    cut: Arc<Contours>,
    reuse: Reuse,
    blend: &BlendMode,
    settings: &SliceSettings,
    nozzle_diameter: f64,
    neighbours: &[plate::Neighbour],
    floor: Option<FloorPlane>,
    watch: &Watch,
) -> Result<Plan, String> {
    let mut spent = Spent::default();
    if !reuse.contours {
        spent.cut(&cut);
    }
    let paths = part_paths(&cut, blend, settings, nozzle_diameter, [0; 32], None, watch)?;
    spent.toolpaths(&paths);
    let tour = tour_part(&cut, &paths, blend, settings, [0; 32], None, watch)?;
    spent.order_ms += tour.order_ms;
    let travels = comb_part(&cut, &tour, settings, [0; 32], None, watch)?;
    spent.comb_ms += travels.comb_ms;
    let mut supports = plate::settle(
        &cut,
        neighbours,
        |ground| {
            let plan = plan_supports(&cut, blend, settings, ground.map(|g| g.solid), floor, watch)?;
            spent.supports(&plan);
            Ok(plan)
        },
        |plan| plan,
    )?;
    if watch.stopped(settings.job) {
        return Err("cancelled".into());
    }
    let edits = edit(
        &mut supports,
        &cut,
        &settings.support_edits,
        blend,
        settings,
    );
    if watch.stopped(settings.job) {
        return Err("cancelled".into());
    }
    let part = Part {
        paths: &paths,
        tour: &tour,
        travels: &travels,
    };
    let assembled = assemble(&cut, part, &supports, blend, settings, &[], watch)?;
    let cap = settings.object_tweak.speed;
    Ok(finish(cut, &supports, edits, assembled, reuse, spent, cap))
}

/// `plan` from the kept stages. Each stage is reused when its key matches.
/// Edits extend the last edited state when they start with its edits, and
/// otherwise replay from the base, which is how undoing an edit works.
#[allow(clippy::too_many_arguments)]
fn plan_kept(
    keys: kept::Keys,
    cut: Arc<Contours>,
    mut reuse: Reuse,
    blend: &BlendMode,
    settings: &SliceSettings,
    nozzle_diameter: f64,
    neighbours: &[plate::Neighbour],
    floor: Option<FloorPlane>,
    watch: &Watch,
) -> Result<Plan, String> {
    let mut spent = Spent::default();
    if !reuse.contours {
        spent.cut(&cut);
    }
    if watch.stopped(settings.job) {
        return Err("cancelled".into());
    }
    let base = &keys.layers;
    let paths = kept::stage(&keys.toolpaths, &mut reuse.toolpaths, || {
        let kept = kept::newest::<PartPaths>(|p| p.base == base.toolpaths);
        part_paths(
            &cut,
            blend,
            settings,
            nozzle_diameter,
            base.toolpaths,
            kept.as_deref(),
            watch,
        )
    })?;
    if reuse.toolpaths {
        watch.complete(Stage::Part);
    } else {
        spent.toolpaths(&paths);
        reuse.toolpath_layers = paths.reused;
    }
    if watch.stopped(settings.job) {
        return Err("cancelled".into());
    }
    let tour = kept::stage(&keys.order, &mut reuse.order, || {
        let kept = kept::newest::<PartTour>(|t| t.base == base.order);
        tour_part(
            &cut,
            &paths,
            blend,
            settings,
            base.order,
            kept.as_deref(),
            watch,
        )
    })?;
    if reuse.order {
        watch.complete(Stage::Travel);
    } else {
        spent.order_ms += tour.order_ms;
        reuse.order_layers = tour.reused;
    }
    if watch.stopped(settings.job) {
        return Err("cancelled".into());
    }
    let travels = kept::stage(&keys.comb, &mut reuse.comb, || {
        let kept = kept::newest::<PartTravels>(|t| t.base == base.comb);
        comb_part(&cut, &tour, settings, base.comb, kept.as_deref(), watch)
    })?;
    if !reuse.comb {
        spent.comb_ms += travels.comb_ms;
        reuse.comb_layers = travels.reused;
    }
    if watch.stopped(settings.job) {
        return Err("cancelled".into());
    }

    let want = &settings.support_edits;
    let (keys, base, edited) = plate::settle(
        &cut,
        neighbours,
        |ground| {
            let keys = ground
                .as_ref()
                .map_or_else(|| keys.clone(), |g| keys.grounded(&g.key));
            let (base, edited) = kept_supports(
                &keys,
                &cut,
                blend,
                settings,
                ground.map(|g| g.solid),
                floor,
                &mut reuse,
                &mut spent,
                watch,
            )?;
            kept::keep_supports(&keys, Arc::clone(&base), edited.clone());
            Ok((keys, base, edited))
        },
        |(_, base, _)| base,
    )?;
    if watch.stopped(settings.job) {
        return Err("cancelled".into());
    }
    let mut edits = Edits::default();
    let fresh = (!want.is_empty()).then(|| {
        let (mut plan, mut outcomes) = match edited.as_deref() {
            Some(e) if want.starts_with(&e.edits) => {
                reuse.edits = e.edits.len() as u32;
                (e.plan.clone(), e.outcomes.clone())
            }
            _ => ((*base).clone(), Vec::new()),
        };
        edits = edit(
            &mut plan,
            &cut,
            &want[reuse.edits as usize..],
            blend,
            settings,
        );
        outcomes.append(&mut edits.outcomes);
        edits.outcomes = outcomes;
        Arc::new(kept::Edited {
            edits: want.clone(),
            plan,
            outcomes: edits.outcomes.clone(),
        })
    });
    if watch.stopped(settings.job) {
        return Err("cancelled".into());
    }
    let supports = fresh.as_deref().map_or(&*base, |e| &e.plan);
    let prior = kept::prior(&keys);
    let part = Part {
        paths: &paths,
        tour: &tour,
        travels: &travels,
    };
    let assembled = assemble(
        &cut,
        part,
        supports,
        blend,
        settings,
        prior.as_ref().map_or(&[], |p| p.as_slice()),
        watch,
    )?;
    kept::keep_joined(&keys, Arc::new(assembled.joined.clone()));
    kept::keep_supports(&keys, Arc::clone(&base), fresh.clone().or(edited));
    let kept = KeptPlan {
        key: keys.whole,
        contours: keys.contours,
    };
    let cap = settings.object_tweak.speed;
    let mut plan = finish(cut, supports, edits, assembled, reuse, spent, cap);
    plan.kept = Some(kept);
    Ok(plan)
}

/// The supports kept under `keys` and their last edited state: painted
/// already, or grown and painted again under `settings`, or grown now among
/// `solid`.
#[allow(clippy::too_many_arguments)]
fn kept_supports(
    keys: &kept::Keys,
    cut: &Contours,
    blend: &BlendMode,
    settings: &SliceSettings,
    solid: Option<Arc<Vec<Vec<Loop>>>>,
    floor: Option<FloorPlane>,
    reuse: &mut Reuse,
    spent: &mut Spent,
    watch: &Watch,
) -> Result<(Arc<SupportPlan>, Option<Arc<kept::Edited>>), String> {
    let want = &settings.support_edits;
    reuse.supports = false;
    reuse.support_paths = false;
    match kept::supports(keys) {
        Some(found) if found.painted => {
            reuse.supports = true;
            reuse.support_paths = true;
            watch.complete(Stage::Supports);
            Ok((found.base, found.edited))
        }
        Some(found) => {
            reuse.supports = true;
            let layers = cut.bands.len().max(1) as u32;
            watch.begin(Stage::Supports, layers);
            if watch.stopped(settings.job) {
                return Err("cancelled".into());
            }
            let base = Arc::new(found.base.repaint(cut, blend, settings, watch));
            spent.supports(&base);
            if watch.stopped(settings.job) {
                return Err("cancelled".into());
            }
            let edited = found
                .edited
                .filter(|e| !want.is_empty() && want.starts_with(&e.edits))
                .map(|e| {
                    let plan = e.plan.repaint(cut, blend, settings, watch);
                    spent.supports(&plan);
                    Arc::new(kept::Edited {
                        edits: e.edits.clone(),
                        plan,
                        outcomes: e.outcomes.clone(),
                    })
                });
            if watch.stopped(settings.job) {
                return Err("cancelled".into());
            }
            watch.fill();
            Ok((base, edited))
        }
        None => {
            let base = Arc::new(plan_supports(cut, blend, settings, solid, floor, watch)?);
            spent.supports(&base);
            Ok((base, None))
        }
    }
}

/// The plan, with the object's speed cap `cap` applied and the clocks of
/// what was joined and edited added.
fn finish(
    cut: Arc<Contours>,
    supports: &SupportPlan,
    edits: Edits,
    assembled: Assembled,
    reuse: Reuse,
    mut spent: Spent,
    cap: Option<f64>,
) -> Plan {
    spent.order_ms += assembled.order_ms;
    spent.comb_ms += assembled.comb_ms;
    spent.edit_apply_ms += edits.apply_ms;
    spent.edit_refresh_ms += edits.refresh_ms;
    let heads = assembled.joined.iter().map(|j| j.head).collect();
    Plan {
        layers: assembled
            .joined
            .into_par_iter()
            .map(|j| j.capped(cap))
            .collect(),
        heads,
        layers_reused: assembled.reused,
        kept: None,
        cut,
        supports: Arc::clone(&supports.supports),
        coverage: supports.coverage.clone(),
        in_air: supports.in_air,
        outcomes: edits.outcomes,
        reuse,
        spent,
    }
}

/// The mesh cut into per-band contours, and the roof distances the part's
/// shells read off them.
fn cut_mesh(
    mesh: &Mesh,
    bands: Vec<LayerBand>,
    settings: &SliceSettings,
    nozzle_diameter: f64,
    watch: &Watch,
) -> Result<Contours, String> {
    let bounds = mesh.bounds().ok_or("empty mesh")?;
    let index_started = Instant::now();
    let index = ZIndex::build(mesh);
    let index_ms = elapsed_ms(index_started);
    let tolerance = outline_tolerance(settings, nozzle_diameter);
    let contour_started = Instant::now();
    watch.begin(Stage::Cut, bands.len().max(1) as u32);
    if watch.stopped(settings.job) {
        return Err("cancelled".into());
    }
    let cut: Vec<(Vec<Loop>, f64, f64, usize, usize)> = bands
        .par_iter()
        .map(|band| {
            if watch.stopped(settings.job) {
                return (Vec::new(), 0.0, 0.0, 0, 0);
            }
            let cut_started = Instant::now();
            let (raw, stats) = index.slice_with_stats(band.cut_z());
            let cut_ms = elapsed_ms(cut_started);
            let simplify_started = Instant::now();
            let loops = simplify_loops(raw, tolerance);
            watch.tick();
            (
                loops,
                cut_ms,
                elapsed_ms(simplify_started),
                usize::from(stats.bridged > 0),
                stats.dropped,
            )
        })
        .collect();
    let contour_ms = elapsed_ms(contour_started);
    let cut_cpu_ms = cut.iter().map(|row| row.1).sum();
    let simplify_cpu_ms = cut.iter().map(|row| row.2).sum();
    let repaired_layers = cut.iter().map(|row| row.3).sum();
    let dropped_chains = cut.iter().map(|row| row.4).sum();
    let contours = cut.into_iter().map(|row| row.0).collect();
    if watch.stopped(settings.job) {
        return Err("cancelled".into());
    }
    watch.fill();
    let mut cut = Contours::new(bands, contours, bounds, settings);
    cut.clocks.contour_ms = contour_ms;
    cut.clocks.index_ms = index_ms;
    cut.clocks.cut_cpu_ms = cut_cpu_ms;
    cut.clocks.simplify_cpu_ms = simplify_cpu_ms;
    cut.repaired_layers = repaired_layers;
    cut.dropped_chains = dropped_chains;
    Ok(cut)
}

/// The mesh cut into layers, with what is read off the cut alone. Every
/// blend of the same mesh and layer settings shares it.
pub(crate) struct Contours {
    pub bands: Vec<LayerBand>,
    pub contours: Vec<Vec<Loop>>,
    bounds: ([f64; 3], [f64; 3]),
    /// Each layer's distance below the nearest roof, from `roof_distances`.
    roofs: Vec<f64>,
    /// Each layer's skin, from `skin_regions`: `[0]` at speed's shell
    /// depths, `[1]` at toughness's. `skin_of` picks one for a strategy.
    skins: [Vec<Arc<Skin>>; 2],
    /// What prints over air with supports off, for the first overhang angle
    /// asked, keyed by its bits.
    in_air: std::sync::OnceLock<(u64, InAir)>,
    /// Each layer's XY box, `None` on an empty layer, found when first asked.
    boxes: std::sync::OnceLock<Vec<Option<XyRect>>>,
    clocks: CutClocks,
    /// Layers that closed a mesh gap, and chains that stayed open.
    repaired_layers: usize,
    dropped_chains: usize,
}

/// Wall-clock and CPU time the cut took.
#[derive(Clone, Copy, Default)]
struct CutClocks {
    contour_ms: f64,
    index_ms: f64,
    cut_cpu_ms: f64,
    simplify_cpu_ms: f64,
    roof_ms: f64,
}

impl Contours {
    fn new(
        bands: Vec<LayerBand>,
        contours: Vec<Vec<Loop>>,
        bounds: ([f64; 3], [f64; 3]),
        settings: &SliceSettings,
    ) -> Self {
        let fewest_walls = pure(StrategyId::Speed)
            .walls
            .min(pure(StrategyId::Toughness).walls)
            .max(1);
        let roof_started = Instant::now();
        let wall_stack = settings.line_width * fewest_walls as f64;
        let roofs = roof_distances(&bands, &contours, wall_stack);
        let skins = skin_regions(&bands, &contours, wall_stack);
        Self {
            bands,
            contours,
            bounds,
            roofs,
            skins,
            in_air: std::sync::OnceLock::new(),
            boxes: std::sync::OnceLock::new(),
            repaired_layers: 0,
            dropped_chains: 0,
            clocks: CutClocks {
                roof_ms: elapsed_ms(roof_started),
                ..CutClocks::default()
            },
        }
    }

    /// What prints over air at overhang angle `angle_deg`. It reads only
    /// the cut and the angle, so every blend of the cut shares it.
    fn boxes(&self) -> &[Option<XyRect>] {
        self.boxes
            .get_or_init(|| self.contours.par_iter().map(|c| loop_bounds(c)).collect())
    }

    /// The band of this cut that prints at the Z where `band` is cut, if any.
    fn band_at(&self, band: &LayerBand) -> Option<usize> {
        let z = band.cut_z();
        let i = self.bands.partition_point(|b| b.z < z);
        self.bands.get(i).filter(|b| b.z - b.height <= z).map(|_| i)
    }

    fn in_air(&self, angle_deg: f64) -> InAir {
        let bits = angle_deg.to_bits();
        if let Some(&(_, found)) = self.in_air.get().filter(|(at, _)| *at == bits) {
            return found;
        }
        let found = crate::support::in_air(&self.bands, &self.contours, angle_deg);
        let _ = self.in_air.set((bits, found));
        found
    }
}

/// One layer of the part on its own. `note` names the strategy it used.
#[derive(Clone)]
struct ObjectLayer {
    paths: Vec<Extrusion>,
    note: String,
    /// The print speed `note` names, when the object's speed cap lowers it.
    shown_speed: Option<f64>,
    wall_ms: f64,
    infill_ms: f64,
}

impl ObjectLayer {
    /// `note` under the object's speed cap `cap`.
    fn note_under(&self, cap: f64) -> String {
        match self.shown_speed {
            Some(speed) if cap < speed => {
                self.note
                    .replacen(&speed_label(speed), &speed_label(cap), 1)
            }
            _ => self.note.clone(),
        }
    }
}

/// The part's own toolpaths: every layer's walls, infill, and skin with
/// overhangs split, in the order they were planned. Supports never read it.
pub(crate) struct PartPaths {
    layers: Vec<Arc<ObjectLayer>>,
    /// Each layer's own inputs, from `layer_inputs`.
    inputs: Vec<[u8; 32]>,
    /// The kept layer key the layers were planned under.
    base: [u8; 32],
    /// Layers taken from a kept plan instead of planned.
    reused: u32,
    toolpath_ms: f64,
    wall_cpu_ms: f64,
    infill_cpu_ms: f64,
}

/// The part's layers in print order, each one tour scarfed as it went,
/// before any travel is combed or hopped.
pub(crate) struct PartTour {
    layers: Vec<Arc<TourLayer>>,
    base: [u8; 32],
    reused: u32,
    order_ms: f64,
}

/// One layer of the part's tour and what it was toured from.
pub(crate) struct TourLayer {
    source: Arc<ObjectLayer>,
    /// Where the tour started: where the tour below ended.
    from: Option<[f64; 2]>,
    paths: Vec<Extrusion>,
    /// Where the tour ends, carried up through layers with no part.
    end: Option<[f64; 2]>,
}

/// How the nozzle travels into each path of the part's tour, combed and
/// hopped.
pub(crate) struct PartTravels {
    layers: Vec<Arc<CombLayer>>,
    base: [u8; 32],
    reused: u32,
    comb_ms: f64,
}

/// One travel per path of `tour`.
pub(crate) struct CombLayer {
    tour: Arc<TourLayer>,
    /// The layer below has top skin, which z-hop reads.
    after_top: bool,
    travels: Vec<Travel>,
}

/// What combing and z-hop decide about the travel into one path.
#[derive(Clone)]
struct Travel {
    lead_in: Vec<[f64; 2]>,
    travel_in: TravelIn,
    z_hop: f64,
}

impl Travel {
    fn of(path: Extrusion) -> Self {
        Self {
            lead_in: path.lead_in,
            travel_in: path.travel_in,
            z_hop: path.z_hop,
        }
    }

    fn onto(&self, path: &Extrusion) -> Extrusion {
        Extrusion {
            lead_in: self.lead_in.clone(),
            travel_in: self.travel_in,
            z_hop: self.z_hop,
            ..path.clone()
        }
    }
}

/// The part as `assemble` joins it: its tour with its travels.
#[derive(Clone, Copy)]
struct Part<'a> {
    paths: &'a PartPaths,
    tour: &'a PartTour,
    travels: &'a PartTravels,
}

impl Part<'_> {
    /// The nozzle moves on layer `i`'s part, so the layer ends where the
    /// part's tour does.
    fn prints(&self, i: usize) -> bool {
        self.tour.layers[i]
            .paths
            .iter()
            .any(|p| !p.points.is_empty())
    }

    /// Layer `i` of the part in print order, combed and hopped.
    fn combed(&self, i: usize) -> impl Iterator<Item = Extrusion> + '_ {
        let layer = &self.travels.layers[i];
        layer
            .tour
            .paths
            .iter()
            .zip(&layer.travels)
            .map(|(path, travel)| travel.onto(path))
    }
}

/// Supports planned on the cut: the forest, the regions and branches of
/// every layer, and the paths printed from them. The forest is shared
/// with the plan built from it; editing it copies it first.
#[derive(Clone)]
pub(crate) struct SupportPlan {
    supports: Arc<Supports>,
    coverage: Vec<CoverageGap>,
    /// With supports off, what prints over air. `None` with supports on.
    in_air: Option<InAir>,
    /// Layers each layer's support stands for, from `shaft_scales`.
    shaft: Vec<f64>,
    /// Each layer's support paths. An edit repaints some layers and shares
    /// the rest with the plan it started from.
    paths: Vec<Arc<Vec<Extrusion>>>,
    /// What the trees grew among when other objects stand near: the part
    /// and those objects, per layer, in the part frame. `None` is the part
    /// alone.
    solid: Option<Arc<Vec<Vec<Loop>>>>,
    support_ms: f64,
    toolpath_ms: f64,
}

impl SupportPlan {
    /// What the trees avoid and stand on.
    fn solid<'a>(&'a self, cut: &'a Contours) -> &'a [Vec<Loop>] {
        self.solid.as_deref().map_or(&cut.contours, Vec::as_slice)
    }

    /// Bring paths, shaft scales, and coverage up to date after edits
    /// changed the support on `changed` layers. A changed layer can move the
    /// shaft scale of its run beyond itself, so layers whose scale moved are
    /// repainted too. Returns the layers repainted, ascending.
    fn refresh(
        &mut self,
        cut: &Contours,
        changed: &[usize],
        blend: &BlendMode,
        settings: &SliceSettings,
    ) -> Vec<usize> {
        if changed.is_empty() {
            return Vec::new();
        }
        let layers = &self.supports.layers;
        let shaft = shaft_scales(layers, settings.support_height_mult);
        let mut repaint: Vec<usize> = (0..shaft.len())
            .filter(|&i| shaft[i] != self.shaft[i])
            .chain(changed.iter().copied())
            .collect();
        repaint.sort_unstable();
        repaint.dedup();
        let painted = paint(
            cut,
            layers,
            &shaft,
            &repaint,
            blend,
            settings,
            &Watch::idle(),
            false,
        );
        for (&i, paths) in repaint.iter().zip(painted) {
            self.paths[i] = Arc::new(paths);
        }
        self.shaft = shaft;
        self.coverage = self.supports.coverage(&cut.bands, self.solid(cut));
        repaint
    }

    /// The same supports painted again under `settings`, for a plan whose
    /// supports grew alike but whose toolpath settings differ. Each layer's
    /// paint reads only its own support and shaft scale, so this is the
    /// plan the supports would have had painted under `settings` all along.
    fn repaint(
        &self,
        cut: &Contours,
        blend: &BlendMode,
        settings: &SliceSettings,
        watch: &Watch,
    ) -> SupportPlan {
        let started = Instant::now();
        let shaft = shaft_scales(&self.supports.layers, settings.support_height_mult);
        let all: Vec<usize> = (0..cut.bands.len()).collect();
        let paths = paint(
            cut,
            &self.supports.layers,
            &shaft,
            &all,
            blend,
            settings,
            watch,
            true,
        )
        .into_iter()
        .map(Arc::new)
        .collect();
        SupportPlan {
            supports: Arc::clone(&self.supports),
            coverage: self.coverage.clone(),
            in_air: self.in_air,
            shaft,
            paths,
            solid: self.solid.clone(),
            support_ms: 0.0,
            toolpath_ms: elapsed_ms(started),
        }
    }
}

/// What applying edits to a support plan did, and what it cost.
#[derive(Default)]
struct Edits {
    outcomes: Vec<EditOutcome>,
    apply_ms: f64,
    refresh_ms: f64,
}

/// Apply `edits` in order onto `plan`, then repaint the layers they changed.
fn edit(
    plan: &mut SupportPlan,
    cut: &Contours,
    edits: &[SupportEdit],
    blend: &BlendMode,
    settings: &SliceSettings,
) -> Edits {
    if edits.is_empty() {
        return Edits::default();
    }
    let started = Instant::now();
    let solid = plan.solid.clone();
    let solid = solid.as_deref().map_or(&cut.contours, |s| s);
    let outcomes = Arc::make_mut(&mut plan.supports).apply(edits, &cut.bands, solid);
    let apply_ms = elapsed_ms(started);
    let started = Instant::now();
    let mut changed: Vec<usize> = outcomes
        .iter()
        .flat_map(|o| o.changed.iter().copied())
        .collect();
    changed.sort_unstable();
    changed.dedup();
    plan.refresh(cut, &changed, blend, settings);
    Edits {
        outcomes,
        apply_ms,
        refresh_ms: elapsed_ms(started),
    }
}

/// Every layer's walls, infill, and skin, with overhangs split, and the
/// ironing over each roof. A layer of `kept`, planned under the same `base`,
/// is taken as it is when its own inputs are the same.
fn part_paths(
    cut: &Contours,
    blend: &BlendMode,
    settings: &SliceSettings,
    nozzle_diameter: f64,
    base: [u8; 32],
    kept: Option<&PartPaths>,
    watch: &Watch,
) -> Result<PartPaths, String> {
    let (bands, contours) = (&cut.bands, &cut.contours);
    let (min, max) = cut.bounds;
    watch.begin(Stage::Part, bands.len().max(1) as u32);
    if watch.stopped(settings.job) {
        return Err("cancelled".into());
    }
    let (remain_low, remain_high) = interior_remainings(blend, settings, bands, &cut.skins);
    let lightning = grow_lightning(cut, blend, settings);
    let toolpath_started = Instant::now();
    let kept = kept.filter(|k| k.base == base);
    let planned: Vec<([u8; 32], Arc<ObjectLayer>, bool)> = bands
        .par_iter()
        .enumerate()
        .map(|(i, band)| {
            let ironing = settings.ironing.filter(|_| cut.roofs[i] == 0.0);
            let inputs = layer_inputs(&settings.overrides, band.z, &contours[i], ironing);
            if let Some(kept) = kept.filter(|k| k.inputs.get(i) == Some(&inputs)) {
                watch.tick();
                return (inputs, Arc::clone(&kept.layers[i]), true);
            }
            if watch.stopped(settings.job) {
                let layer = ObjectLayer {
                    paths: Vec::new(),
                    note: String::new(),
                    shown_speed: None,
                    wall_ms: 0.0,
                    infill_ms: 0.0,
                };
                return (inputs, Arc::new(layer), false);
            }
            let mut layer = object_layer(
                band.index,
                band.z,
                band.height,
                &contours[i],
                blend,
                settings,
                [&cut.skins[0][i], &cut.skins[1][i]],
                cut.roofs[i],
                min,
                max,
                nozzle_diameter,
                remain_low[i],
                remain_high[i],
                lightning.as_ref().map(|l| (l, i)),
            );
            if settings.overhang_control && i > 0 {
                apply_overhang(
                    &mut layer.paths,
                    &contours[i - 1],
                    band.height,
                    settings.line_width,
                );
            }
            if let Some(ironing) = ironing {
                layer
                    .paths
                    .extend(iron_layer(cut, i, blend, settings, &ironing));
            }
            watch.tick();
            (inputs, Arc::new(layer), false)
        })
        .collect();
    let toolpath_ms = elapsed_ms(toolpath_started);
    if watch.stopped(settings.job) {
        return Err("cancelled".into());
    }
    watch.fill();
    let fresh = || planned.iter().filter(|p| !p.2).map(|p| &p.1);
    Ok(PartPaths {
        wall_cpu_ms: fresh().map(|l| l.wall_ms).sum(),
        infill_cpu_ms: fresh().map(|l| l.infill_ms).sum(),
        reused: planned.iter().filter(|p| p.2).count() as u32,
        inputs: planned.iter().map(|p| p.0).collect(),
        layers: planned.into_iter().map(|p| p.1).collect(),
        base,
        toolpath_ms,
    })
}

/// The inputs of the layer at `z` with `contours` that differ from layer to
/// layer, hashed: the range over it, the volumes that can reach it, and its
/// ironing, which only a roof has. Every other input of a layer's toolpaths
/// is the same for all layers of a plan.
fn layer_inputs(
    overrides: &Overrides,
    z: f64,
    contours: &[Loop],
    ironing: Option<Ironing>,
) -> [u8; 32] {
    let range = overrides.range_at(z);
    let prints = layer_footprints(overrides, z, contours);
    Sha256::digest(format!("{range:?}|{prints:?}|{ironing:?}")).into()
}

/// Ironing over layer `i`'s top surface: what the layer above leaves open,
/// within the outline inset by half a line width. Ranges and volumes do not
/// change it.
fn iron_layer(
    cut: &Contours,
    i: usize,
    blend: &BlendMode,
    settings: &SliceSettings,
    ironing: &Ironing,
) -> Vec<Extrusion> {
    let contours = &cut.contours[i];
    let open = match cut.contours.get(i + 1) {
        Some(above) if !above.is_empty() => boolean_diff(contours, above),
        _ => contours.clone(),
    };
    let area = boolean_intersect(&open, &offset_loops(contours, -settings.line_width * 0.5));
    if area.is_empty() {
        return Vec::new();
    }
    let iron =
        |strategy: &ResolvedStrategy| plan_ironing(&area, strategy, settings.line_width, ironing);
    match blend {
        BlendMode::ByRegion { axis, at_mm } => {
            let tough = iron(&resolve(pure(StrategyId::Toughness), settings));
            let speed = iron(&resolve(pure(StrategyId::Speed), settings));
            let mut paths = keep_side(tough, *axis, *at_mm, true);
            paths.extend(keep_side(speed, *axis, *at_mm, false));
            paths
        }
        other => iron(&layer_strategy(other, cut.bands[i].z, settings)),
    }
}

/// Orders each layer of the part as one tour, starting where the part's
/// tour on the layer below ended. The tour never sees the supports, so
/// editing them leaves it alone. A layer of `kept`, toured under the same
/// `base`, is taken as it is when it toured the same paths from the same
/// point.
///
/// The first layer's tour starts where a skirt around the part alone would
/// end. That is where the skirt really ends when no support stands on the
/// first layer, so a print without supports orders as it always did.
#[allow(clippy::too_many_arguments)]
fn tour_part(
    cut: &Contours,
    part: &PartPaths,
    blend: &BlendMode,
    settings: &SliceSettings,
    base: [u8; 32],
    kept: Option<&PartTour>,
    watch: &Watch,
) -> Result<PartTour, String> {
    let (bands, contours) = (&cut.bands, &cut.contours);
    let order_started = Instant::now();
    watch.begin(Stage::Travel, bands.len().max(1) as u32);
    if watch.stopped(settings.job) {
        return Err("cancelled".into());
    }
    let kept = kept.filter(|k| k.base == base);
    let same_paths = |i: usize| {
        kept.and_then(|k| k.layers.get(i))
            .filter(|k| Arc::ptr_eq(&k.source, &part.layers[i]))
    };
    let bits = |p: Option<[f64; 2]>| p.map(|p| p.map(f64::to_bits));
    let mut reused = 0;
    let layers: Vec<Arc<TourLayer>> = if settings.travel_opt {
        // Every layer from the first with new paths up may start somewhere
        // new, so each is laid out up front, in parallel, and the serial pass
        // only tours. Layers below it start where they did before.
        let first = (0..bands.len())
            .find(|&i| same_paths(i).is_none())
            .unwrap_or(bands.len());
        let mut laid: Vec<Option<PartLayout>> = part
            .layers
            .par_iter()
            .enumerate()
            .map(|(i, l)| (i >= first).then(|| PartLayout::new(l.paths.clone(), &contours[i])))
            .collect();
        let mut end = bands.first().filter(|b| b.index == 0).and_then(|b| {
            let mut skirt = skirt_paths(&contours[0], None, b.z, blend, settings);
            order_supports(&mut skirt, None, scarf_params(settings, 0).as_ref())
        });
        let mut layers = Vec::with_capacity(bands.len());
        for (i, source) in part.layers.iter().enumerate() {
            if watch.stopped(settings.job) {
                return Err("cancelled".into());
            }
            let layer = match same_paths(i).filter(|k| bits(k.from) == bits(end)) {
                Some(k) => {
                    reused += 1;
                    Arc::clone(k)
                }
                None => {
                    let layout = laid[i]
                        .take()
                        .unwrap_or_else(|| PartLayout::new(source.paths.clone(), &contours[i]));
                    let scarf = scarf_params(settings, bands[i].index);
                    let (paths, to) = layout.tour(end, scarf.as_ref());
                    Arc::new(TourLayer {
                        source: Arc::clone(source),
                        from: end,
                        paths,
                        end: to,
                    })
                }
            };
            end = layer.end;
            layers.push(layer);
            watch.tick();
        }
        layers
    } else {
        let toured: Vec<(Arc<TourLayer>, bool)> = part
            .layers
            .par_iter()
            .enumerate()
            .map(|(i, source)| {
                if let Some(k) = same_paths(i) {
                    watch.tick();
                    return (Arc::clone(k), true);
                }
                let mut paths = Vec::new();
                if !watch.stopped(settings.job) {
                    paths = source.paths.clone();
                    if let Some(params) = scarf_params(settings, bands[i].index) {
                        apply_scarf(&mut paths, &params);
                    }
                    crate::toolpath::apply_fuzzy_skin(&mut paths);
                }
                watch.tick();
                let layer = TourLayer {
                    source: Arc::clone(source),
                    from: None,
                    paths,
                    end: None,
                };
                (Arc::new(layer), false)
            })
            .collect();
        if watch.stopped(settings.job) {
            return Err("cancelled".into());
        }
        reused = toured.iter().filter(|t| t.1).count() as u32;
        toured.into_iter().map(|t| t.0).collect()
    };
    watch.fill();
    Ok(PartTour {
        layers,
        base,
        reused,
        order_ms: elapsed_ms(order_started),
    })
}

/// Combs and hops the travels between the part's paths on each layer. The
/// travel into a layer's first path depends on what prints before it, so
/// `assemble` decides that one. A layer of `kept`, combed under the same
/// `base`, is taken as it is when it combed the same tour after the same
/// kind of layer.
fn comb_part(
    cut: &Contours,
    tour: &PartTour,
    settings: &SliceSettings,
    base: [u8; 32],
    kept: Option<&PartTravels>,
    watch: &Watch,
) -> Result<PartTravels, String> {
    let comb_started = Instant::now();
    let contours = &cut.contours;
    let kept = kept.filter(|k| k.base == base);
    let tops: Vec<bool> = tour.layers.iter().map(|l| has_top(&l.paths)).collect();
    let combed: Vec<(Arc<CombLayer>, bool)> = tour
        .layers
        .par_iter()
        .enumerate()
        .map(|(i, layer)| {
            let after_top = i > 0 && tops[i - 1];
            let same = kept
                .and_then(|k| k.layers.get(i))
                .filter(|k| Arc::ptr_eq(&k.tour, layer) && k.after_top == after_top);
            if let Some(k) = same {
                return (Arc::clone(k), true);
            }
            let mut travels = Vec::new();
            if !watch.stopped(settings.job) {
                let mut paths = layer.paths.clone();
                if settings.travel_opt {
                    comb_layer(
                        &mut paths,
                        &contours[i],
                        settings.combing,
                        settings.line_width * 0.8,
                        None,
                    );
                }
                hop_travels(&mut paths, &contours[i], after_top, settings);
                travels = paths.into_iter().map(Travel::of).collect();
            }
            let layer = CombLayer {
                tour: Arc::clone(layer),
                after_top,
                travels,
            };
            (Arc::new(layer), false)
        })
        .collect();
    if watch.stopped(settings.job) {
        return Err("cancelled".into());
    }
    Ok(PartTravels {
        reused: combed.iter().filter(|c| c.1).count() as u32,
        layers: combed.into_iter().map(|c| c.0).collect(),
        base,
        comb_ms: elapsed_ms(comb_started),
    })
}

fn has_top(paths: &[Extrusion]) -> bool {
    paths.iter().any(|p| p.kind == PathKind::Top)
}

/// Z-hop on the travels between `paths`, which start a layer.
fn hop_travels(paths: &mut [Extrusion], solid: &[Loop], after_top: bool, settings: &SliceSettings) {
    if settings.z_hop == ZHopMode::Off || settings.z_hop_height <= 1e-6 || paths.len() < 2 {
        return;
    }
    let infill = offset_loops(solid, -settings.line_width * 2.2);
    apply_z_hop(
        paths,
        solid,
        &infill,
        settings.z_hop,
        settings.z_hop_height,
        settings.z_hop_min_travel,
        after_top,
    );
}

fn scarf_params(settings: &SliceSettings, layer_index: usize) -> Option<ScarfParams> {
    (settings.scarf_seam != ScarfSeam::Off).then_some(ScarfParams {
        mode: settings.scarf_seam,
        length: settings.scarf_length,
        steps: settings.scarf_steps,
        start_height: settings.scarf_start_height,
        start_flow: settings.scarf_start_flow,
        layer_index,
    })
}

/// Supports for the part of `cut`, grown among `solid` when other objects
/// stand near, else among the part alone.
fn plan_supports(
    cut: &Contours,
    blend: &BlendMode,
    settings: &SliceSettings,
    solid: Option<Arc<Vec<Vec<Loop>>>>,
    floor: Option<FloorPlane>,
    watch: &Watch,
) -> Result<SupportPlan, String> {
    let support_started = Instant::now();
    let mut opts = SupportOpts {
        angle_deg: settings.support_angle,
        z_gap: settings.layer_height.max(0.12),
        style: settings.support_style,
        branch_angle_deg: settings.branch_angle,
        tip_diameter: settings.tip_diameter,
        trunk_diameter: settings.trunk_diameter.max(settings.tip_diameter + 0.6),
        density: support_seed_weight(blend),
        load_factor: support_load_factor(blend),
        max_tip_spacing: support_tip_spacing(blend),
        job: settings.job,
        ..SupportOpts::default()
    };
    opts.floor = floor;
    watch.begin(Stage::Supports, cut.bands.len().max(1) as u32);
    if watch.stopped(settings.job) {
        return Err("cancelled".into());
    }
    if !settings.supports {
        let in_air = cut.in_air(opts.angle_deg);
        if watch.stopped(settings.job) {
            return Err("cancelled".into());
        }
        watch.fill();
        return Ok(SupportPlan {
            supports: Arc::new(Supports::none(cut.bands.len(), &opts)),
            coverage: Vec::new(),
            in_air: Some(in_air),
            shaft: vec![0.0; cut.bands.len()],
            paths: (0..cut.bands.len()).map(|_| Arc::new(Vec::new())).collect(),
            solid: None,
            support_ms: elapsed_ms(support_started),
            toolpath_ms: 0.0,
        });
    }
    let among = solid.as_deref().map_or(&cut.contours, |s| s);
    let supports = Supports::build_with(
        &cut.bands,
        &cut.contours,
        among,
        &settings.support_paint,
        &opts,
        watch,
    );
    let Some(supports) = supports.filter(|_| !watch.stopped(settings.job)) else {
        return Err("cancelled".into());
    };
    let coverage = supports.coverage(&cut.bands, among);
    let support_ms = elapsed_ms(support_started);
    let shaft = shaft_scales(&supports.layers, settings.support_height_mult);
    let toolpath_started = Instant::now();
    let all: Vec<usize> = (0..cut.bands.len()).collect();
    let paths = paint(
        cut,
        &supports.layers,
        &shaft,
        &all,
        blend,
        settings,
        watch,
        false,
    )
    .into_iter()
    .map(Arc::new)
    .collect();
    let toolpath_ms = elapsed_ms(toolpath_started);
    if watch.stopped(settings.job) {
        return Err("cancelled".into());
    }
    watch.fill();
    Ok(SupportPlan {
        supports: Arc::new(supports),
        coverage,
        in_air: None,
        shaft,
        paths,
        solid,
        support_ms,
        toolpath_ms,
    })
}

/// Support paths for each layer `which` names, in its order.
#[allow(clippy::too_many_arguments)]
fn paint(
    cut: &Contours,
    layers: &[SupportLayer],
    shaft: &[f64],
    which: &[usize],
    blend: &BlendMode,
    settings: &SliceSettings,
    watch: &Watch,
    count: bool,
) -> Vec<Vec<Extrusion>> {
    let (min, max) = cut.bounds;
    which
        .par_iter()
        .map(|&i| {
            let band = &cut.bands[i];
            let Some(layer) = layers.get(i).filter(|_| !watch.stopped(settings.job)) else {
                return Vec::new();
            };
            let paths = support_paths(
                band.z,
                band.height,
                &cut.contours[i],
                layer,
                shaft.get(i).copied().unwrap_or(0.0),
                blend,
                settings,
                min,
                max,
            );
            if count {
                watch.tick();
            }
            paths
        })
        .collect()
}

/// One layer as `assemble` joined it, with the inputs that decided it. A
/// layer whose part, skirt, support paths, and way in are the same joins to
/// the same paths.
#[derive(Clone)]
pub(crate) struct JoinedLayer {
    /// No contour and no support: the layer prints nothing.
    empty: bool,
    /// The part's layer, toured and combed. `None` only on a layer never
    /// joined because the slice stopped.
    part: Option<Arc<CombLayer>>,
    skirt: Vec<Extrusion>,
    under: Arc<Vec<Extrusion>>,
    /// Where the nozzle stood when the layer began.
    from: Option<[f64; 2]>,
    /// Where it stood when the layer ended.
    end: Option<[f64; 2]>,
    /// How many leading paths of `layer` are the skirt and supports.
    head: usize,
    layer: PrintLayer,
}

impl JoinedLayer {
    fn joins_like(
        &self,
        empty: bool,
        part: &Arc<CombLayer>,
        skirt: &[Extrusion],
        under: &Arc<Vec<Extrusion>>,
        from: Option<[f64; 2]>,
    ) -> bool {
        let bits = |p: Option<[f64; 2]>| p.map(|p| p.map(f64::to_bits));
        self.empty == empty
            && self.part.as_ref().is_some_and(|p| Arc::ptr_eq(p, part))
            && bits(self.from) == bits(from)
            && self.skirt == skirt
            && (Arc::ptr_eq(&self.under, under) || self.under == *under)
    }

    /// The layer with the object's speed cap `cap` on its part's paths and
    /// note. A layer the cap leaves alone stays shared, arcs and all.
    fn capped(self, cap: Option<f64>) -> PrintLayer {
        let mut layer = self.layer;
        let (Some(cap), Some(part), false) = (cap, &self.part, self.empty) else {
            return layer;
        };
        let note = part.tour.source.note_under(cap);
        let slower = |p: &Extrusion| p.cap_feed.is_some_and(|c| c.speed(cap) != p.speed);
        if note != layer.note || layer.paths.iter().any(slower) {
            layer.edit(|l| {
                l.note = note;
                for path in &mut l.paths {
                    if let Some(c) = path.cap_feed {
                        path.speed = c.speed(cap);
                    }
                }
            });
        }
        layer
    }
}

/// A layer during `assemble`: taken from the last join, or with its skirt
/// and supports ordered and the join still to finish.
enum Slot {
    Kept(JoinedLayer),
    Fresh(JoinedLayer, Vec<Extrusion>),
}

/// The print as the G-code writer takes it, and what joining it cost.
struct Assembled {
    joined: Vec<JoinedLayer>,
    /// Layers taken from `kept` instead of joined again.
    reused: u32,
    order_ms: f64,
    comb_ms: f64,
}

/// Joins the part and its supports layer by layer: the skirt and supports
/// first as one tour from where the nozzle stands, then the part's own tour.
/// Only the travels the supports lead into are combed and hopped here. A
/// layer of `kept`, the last join of the same part, is reused when its
/// inputs are the same.
fn assemble(
    cut: &Contours,
    part: Part<'_>,
    supports: &SupportPlan,
    blend: &BlendMode,
    settings: &SliceSettings,
    kept: &[JoinedLayer],
    watch: &Watch,
) -> Result<Assembled, String> {
    let (bands, contours) = (&cut.bands, &cut.contours);
    watch.begin(Stage::Assemble, bands.len().max(1) as u32);
    if watch.stopped(settings.job) {
        return Err("cancelled".into());
    }
    // A layer that prints part ends where the part's tour ends, so the next
    // layer's way in is known before any support is ordered. Only a run of
    // layers without part chains one support tour to the next.
    let runs: Vec<std::ops::Range<usize>> = {
        let mut starts: Vec<usize> = (0..bands.len())
            .filter(|&i| i == 0 || part.prints(i - 1))
            .collect();
        starts.push(bands.len());
        starts.windows(2).map(|w| w[0]..w[1]).collect()
    };
    let order_started = Instant::now();
    let slots: Vec<Slot> = runs
        .into_par_iter()
        .flat_map_iter(|run| {
            let mut from = run
                .start
                .checked_sub(1)
                .and_then(|i| part.tour.layers[i].end);
            run.map(move |i| {
                if watch.stopped(settings.job) {
                    return empty_slot();
                }
                let slot = join_supports(cut, part, supports, blend, settings, kept, i, from);
                from = match &slot {
                    Slot::Kept(k) => k.end,
                    Slot::Fresh(j, _) => j.end,
                };
                watch.tick();
                slot
            })
        })
        .collect();
    if watch.stopped(settings.job) {
        return Err("cancelled".into());
    }
    let order_ms = elapsed_ms(order_started);
    let comb_started = Instant::now();
    let reused = slots
        .iter()
        .filter(|slot| matches!(slot, Slot::Kept(..)))
        .count() as u32;
    let joined: Vec<JoinedLayer> = slots
        .into_par_iter()
        .enumerate()
        .map(|(i, slot)| {
            if watch.stopped(settings.job) {
                return match slot {
                    Slot::Kept(kept) => kept,
                    Slot::Fresh(joined, _) => joined,
                };
            }
            let (mut joined, mut paths) = match slot {
                Slot::Kept(k) => return k,
                Slot::Fresh(joined, head) => (joined, head),
            };
            joined.head = paths.len();
            // The skirt and supports, and the travel into the part's first path.
            let lead = paths.len() + 1;
            if !joined.empty {
                paths.extend(part.combed(i));
            }
            let lead = lead.min(paths.len());
            if settings.travel_opt {
                comb_layer(
                    &mut paths[..lead],
                    &contours[i],
                    settings.combing,
                    settings.line_width * 0.8,
                    joined.from,
                );
            }
            let after_top = part.travels.layers[i].after_top;
            hop_travels(&mut paths[..lead], &contours[i], after_top, settings);
            joined.layer.set_paths(paths);
            joined
        })
        .collect();
    if watch.stopped(settings.job) {
        return Err("cancelled".into());
    }
    watch.fill();
    Ok(Assembled {
        reused,
        order_ms,
        comb_ms: elapsed_ms(comb_started),
        joined,
    })
}

/// A layer that was not joined because the slice had already stopped.
/// Discarded with the rest of the plan; never stored.
fn empty_slot() -> Slot {
    Slot::Kept(JoinedLayer {
        empty: true,
        part: None,
        skirt: Vec::new(),
        under: Arc::new(Vec::new()),
        from: None,
        end: None,
        head: 0,
        layer: PrintLayer::new(LayerPaths {
            index: 0,
            z: 0.0,
            height: 0.0,
            paths: Vec::new(),
            note: String::new(),
        }),
    })
}

/// Layer `i`'s skirt and supports, ordered from `from`, or the kept layer
/// when nothing it was joined from changed.
#[allow(clippy::too_many_arguments)]
fn join_supports(
    cut: &Contours,
    part: Part<'_>,
    supports: &SupportPlan,
    blend: &BlendMode,
    settings: &SliceSettings,
    kept: &[JoinedLayer],
    i: usize,
    from: Option<[f64; 2]>,
) -> Slot {
    let band = &cut.bands[i];
    let contour = &cut.contours[i];
    let support = supports.supports.layers.get(i);
    let unsupported =
        support.is_none_or(|s| s.sparse.is_empty() && s.interface.is_empty() && s.disks.is_empty());
    let empty = contour.is_empty() && unsupported;
    let skirt = if band.index == 0 && !empty {
        skirt_paths(contour, support, band.z, blend, settings)
    } else {
        Vec::new()
    };
    let under = &supports.paths[i];
    let own = &part.travels.layers[i];
    if let Some(k) = kept
        .get(i)
        .filter(|k| k.joins_like(empty, own, &skirt, under, from))
    {
        return Slot::Kept(k.clone());
    }
    let mut head = Vec::new();
    let mut end = from;
    if !empty {
        head.extend(skirt.iter().cloned());
        head.extend(under.iter().cloned());
        let scarf = scarf_params(settings, band.index);
        if settings.travel_opt {
            end = order_supports(&mut head, from, scarf.as_ref());
        } else if let Some(params) = scarf {
            apply_scarf(&mut head, &params);
        }
        if part.prints(i) {
            end = own.tour.end;
        }
    }
    let note = if empty {
        "empty".into()
    } else {
        part.paths.layers[i].note.clone()
    };
    let layer = LayerPaths {
        index: band.index,
        z: band.z,
        height: band.height,
        paths: Vec::new(),
        note,
    };
    let joined = JoinedLayer {
        empty,
        part: Some(Arc::clone(own)),
        skirt,
        under: Arc::clone(under),
        from,
        end,
        head: 0,
        layer: PrintLayer::new(layer),
    };
    Slot::Fresh(joined, head)
}

fn roof_distances(bands: &[LayerBand], contours: &[Vec<Loop>], wall_stack: f64) -> Vec<f64> {
    let n = bands.len();
    let roof: Vec<bool> = (0..n)
        .into_par_iter()
        .map(|i| {
            i + 1 >= n
                || exposed_past_walls(
                    &contours[i],
                    contours.get(i + 1).map(Vec::as_slice).unwrap_or(&[]),
                    wall_stack,
                )
        })
        .collect();
    let mut dist = vec![0.0; n];
    let mut since = 0.0;
    for i in (0..n).rev() {
        if roof[i] {
            since = 0.0;
        }
        dist[i] = since;
        since += bands[i].height;
    }
    dist
}

/// Each layer's skin at both pairs of shell depths `shell_depths` gives,
/// speed's first. A floor is the area of a layer that the layer below does
/// not cover, and a roof the area the layer above does not cover; the first
/// layer is all floor and the last all roof. A layer's bottom skin is every
/// floor whose underside is within the bottom depth below its top, and its
/// top skin every roof within the top depth above it, each clipped to the
/// layer. Inside a closed part neither reaches, so it prints as interior.
fn skin_regions(
    bands: &[LayerBand],
    contours: &[Vec<Loop>],
    wall_stack: f64,
) -> [Vec<Arc<Skin>>; 2] {
    let n = bands.len();
    let floors: Vec<Vec<Loop>> = (0..n)
        .into_par_iter()
        .map(|i| match i {
            0 => contours[0].clone(),
            _ => exposed_core(&contours[i], &contours[i - 1], wall_stack),
        })
        .collect();
    let roofs: Vec<Vec<Loop>> = (0..n)
        .into_par_iter()
        .map(|i| match contours.get(i + 1) {
            None => contours[i].clone(),
            Some(above) => exposed_core(&contours[i], above, wall_stack),
        })
        .collect();
    let at = |(bottom, top): (f64, f64)| -> Vec<Arc<Skin>> {
        (0..n)
            .into_par_iter()
            .map(|i| {
                let mut under: Vec<Loop> = Vec::new();
                for f in (0..=i).rev() {
                    let dist = bands[f..=i].iter().fold(0.0, |d, b| d + b.height);
                    if dist > bottom + 1e-6 {
                        break;
                    }
                    under.extend(floors[f].iter().cloned());
                }
                let mut over: Vec<Loop> = Vec::new();
                for r in i..n {
                    let dist = bands[i + 1..=r].iter().rev().fold(0.0, |d, b| d + b.height);
                    if dist > top {
                        break;
                    }
                    over.extend(roofs[r].iter().cloned());
                }
                Arc::new(Skin {
                    bottom: clipped_union(&contours[i], under),
                    top: clipped_union(&contours[i], over),
                })
            })
            .collect()
    };
    [at(SPEED_SHELLS), at(TOUGH_SHELLS)]
}

/// Core of an exposed island, past half the walls, that makes it skin, mm².
const SKIN_CORE_MM2: f64 = 0.05;

/// Bottom and top shell depths, mm: speed's, and a strategy's over 0.6 toughness.
const SPEED_SHELLS: (f64, f64) = (0.6, 0.6);
const TOUGH_SHELLS: (f64, f64) = (1.2, 1.0);

/// The skin of a layer, of `skins` at both shell depths, for `strategy`.
fn skin_of(skins: [&Arc<Skin>; 2], strategy: &ResolvedStrategy) -> Arc<Skin> {
    Arc::clone(skins[usize::from(strategy.toughness > 0.6)])
}

/// The part of `layer` inside any of `pieces`, which may overlap.
fn clipped_union(layer: &[Loop], pieces: Vec<Loop>) -> Vec<Loop> {
    if pieces.is_empty() || layer.is_empty() {
        return Vec::new();
    }
    boolean_intersect(layer, &resolve_nonzero(pieces))
}

/// The islands of `current` that `other` does not cover, each kept only when
/// it reaches deeper than the walls. A thinner strip along the outline, as on
/// a slope, is closed by the walls; an island with any core left is skin.
fn exposed_core(current: &[Loop], other: &[Loop], wall_stack: f64) -> Vec<Loop> {
    if current.is_empty() {
        return Vec::new();
    }
    if other.is_empty() {
        return current.to_vec();
    }
    let exposed = boolean_diff(current, other);
    island_loops(&exposed)
        .into_iter()
        .filter(|island| {
            let core = offset_loops(island, -wall_stack * 0.5);
            core.iter().map(|l| signed_area(l)).sum::<f64>() >= SKIN_CORE_MM2
        })
        .flatten()
        .collect()
}

/// `current` has area `other` does not cover, reaching deeper than the walls:
/// a roof when `other` is the layer above, a floor when it is the layer below.
/// A thinner strip along the outline, as on a slope, is closed by the walls.
fn exposed_past_walls(current: &[Loop], other: &[Loop], wall_stack: f64) -> bool {
    if current.is_empty() {
        return false;
    }
    if other.is_empty() {
        return true;
    }
    let exposed = boolean_diff(current, other);
    if exposed.is_empty() {
        return false;
    }
    let core = offset_loops(&exposed, -wall_stack * 0.5);
    core.iter().map(|l| signed_area(l)).sum::<f64>() >= 1.0
}

fn pattern_label(strategy: &ResolvedStrategy) -> String {
    if strategy.gyroid_3d && strategy.pattern == crate::strategy::InfillPattern::Gyroid {
        "gyroid3d".into()
    } else {
        strategy.pattern.as_str().into()
    }
}

fn resolve(mut strategy: ResolvedStrategy, settings: &SliceSettings) -> ResolvedStrategy {
    if settings.classic {
        strategy = classicize(strategy);
    }
    if !settings.feature_speeds {
        strategy.feature_speeds = false;
    }
    if !settings.infill_combine {
        strategy.infill_combine = 1;
    }
    if let Some(mode) = settings.seam.mode() {
        strategy.seam = mode;
        strategy.inner_follows_seam = true;
    }
    if !settings.classic {
        match settings.gyroid_3d {
            Gyroid3d::Off => strategy.gyroid_3d = false,
            Gyroid3d::Blend => {}
            Gyroid3d::On => {
                strategy.pattern = crate::strategy::InfillPattern::Gyroid;
                strategy.gyroid_3d = true;
                strategy.lightning_range_mm = 0.0;
            }
        }
        if strategy.gyroid_3d
            && strategy.pattern == crate::strategy::InfillPattern::Gyroid
            && strategy.toughness >= 0.75
            && settings.infill_combine
        {
            strategy.infill_combine = strategy.infill_combine.max(2);
        }
        strategy.z_hop = match settings.z_hop {
            ZHopMode::Off => ZHopMode::Off,
            ZHopMode::Always => ZHopMode::Always,
            ZHopMode::Smart => ZHopMode::Smart,
            ZHopMode::Blend => strategy.z_hop,
        };
        if settings.classic {
            strategy.z_hop = ZHopMode::Off;
        }
    }
    strategy
}

fn shaft_scales(supports: &[crate::support::SupportLayer], mult: f64) -> Vec<f64> {
    let m = if mult < 1.0 {
        1
    } else {
        mult.round().clamp(1.0, 4.0) as u32
    };
    let has = |i: usize| {
        supports
            .get(i)
            .map(|s| !s.sparse.is_empty() || !s.disks.is_empty())
            .unwrap_or(false)
    };
    let mut scale = vec![0.0; supports.len()];
    let mut since = 0u32;
    for (i, slot) in scale.iter_mut().enumerate() {
        if !has(i) {
            since = 0;
            continue;
        }
        since += 1;
        if since >= m || !has(i + 1) {
            *slot = since as f64;
            since = 0;
        }
    }
    scale
}

fn interior_remainings(
    blend: &BlendMode,
    settings: &SliceSettings,
    bands: &[crate::adaptive::LayerBand],
    skins: &[Vec<Arc<Skin>>; 2],
) -> (Vec<InteriorSpan>, Vec<InteriorSpan>) {
    let shells_for = |pick: &dyn Fn(f64) -> ResolvedStrategy| -> Vec<ShellBand> {
        bands
            .iter()
            .enumerate()
            .map(|(i, b)| skin_of([&skins[0][i], &skins[1][i]], &pick(b.z)).shell())
            .collect()
    };
    match blend {
        BlendMode::ByRegion { .. } => {
            let low = shells_for(&|_| {
                settings
                    .object_tweak
                    .apply(resolve(pure(StrategyId::Toughness), settings))
            });
            let high = shells_for(&|_| {
                settings
                    .object_tweak
                    .apply(resolve(pure(StrategyId::Speed), settings))
            });
            (remaining_interior(&low), remaining_interior(&high))
        }
        other => {
            let low = shells_for(&|z| {
                settings
                    .object_tweak
                    .apply(resolve(strategy_at(other, z), settings))
            });
            (remaining_interior(&low), vec![(0, 0); bands.len()])
        }
    }
}

fn strategy_at(blend: &BlendMode, z: f64) -> ResolvedStrategy {
    match blend {
        BlendMode::Single { strategy } => pure(*strategy),
        BlendMode::Weight { toughness } => mix(*toughness),
        BlendMode::ByLayer {
            bottom_mm,
            transition_mm,
        } => mix(layer_weight(z, *bottom_mm, *transition_mm)),
        BlendMode::ByRegion { .. } => pure(StrategyId::Speed),
    }
}

type InteriorSpan = (u32, u32);

fn remaining_interior(shells: &[ShellBand]) -> Vec<InteriorSpan> {
    let n = shells.len();
    let mut out = vec![(0u32, 0u32); n];
    let mut i = 0;
    while i < n {
        if shells[i] != ShellBand::Interior {
            i += 1;
            continue;
        }
        let mut j = i;
        while j < n && shells[j] == ShellBand::Interior {
            j += 1;
        }
        let run = (j - i) as u32;
        for (k, slot) in out.iter_mut().enumerate().take(j).skip(i) {
            *slot = (run - (k - i) as u32, run);
        }
        i = j;
    }
    out
}

/// How far past the region cut each side plans its half. Every wall of the
/// thicker shell, plus one bead, then lies past the plane: nothing the side
/// keeps follows the clip edge, so the walls near the cut trace the real
/// outline and a thin feature on the plane is planned whole by both sides.
fn cut_margin(low: &ResolvedStrategy, high: &ResolvedStrategy, line_width: f64) -> f64 {
    (low.walls.max(high.walls) + 2) as f64 * line_width
}

fn widen_rect(rect: XyRect, axis: Axis, low_side: bool, margin: f64) -> XyRect {
    let (mut min, mut max) = rect;
    let k = match axis {
        Axis::X => 0,
        Axis::Y => 1,
    };
    if low_side {
        max[k] += margin;
    } else {
        min[k] -= margin;
    }
    (min, max)
}

/// The beads of one side's plan that lie on that side of the cut. A closed
/// loop cut open keeps the run through its start whole instead of splitting it
/// at the seam.
fn keep_side(paths: Vec<Extrusion>, axis: Axis, at: f64, low_side: bool) -> Vec<Extrusion> {
    let mut out = Vec::with_capacity(paths.len());
    for path in paths {
        let (low, high) = split_polyline(&path.points, axis, at);
        let (mut kept, dropped) = if low_side { (low, high) } else { (high, low) };
        if dropped.is_empty() {
            out.push(path);
            continue;
        }
        let closed = path.points.len() > 2 && path.points.first() == path.points.last();
        if closed && kept.len() >= 2 && kept[0].first() == path.points.first() {
            let head = kept.remove(0);
            let tail = kept.last_mut().unwrap();
            tail.extend_from_slice(&head[1..]);
        }
        out.extend(
            kept.into_iter()
                .filter(|pts| poly_len(pts) > 0.05)
                .map(|pts| {
                    let mut piece = cut_piece(&path, pts);
                    if piece.kind.is_closed() {
                        piece.seam = Seam::Cut;
                    }
                    piece
                }),
        );
    }
    out
}

/// The volumes whose footprint at `z` can meet the layer's outline, in
/// request order.
fn layer_footprints(overrides: &Overrides, z: f64, contours: &[Loop]) -> Vec<Print> {
    if overrides.volumes.is_empty() {
        return Vec::new();
    }
    let Some((lo, hi)) = loop_bounds(contours) else {
        return Vec::new();
    };
    overrides
        .footprints(z)
        .into_iter()
        .filter(|p| {
            let (a, b) = p.outline.bounds();
            a[0] <= hi[0] && b[0] >= lo[0] && a[1] <= hi[1] && b[1] >= lo[1]
        })
        .collect()
}

/// The most walls a zone with `tweak` prints at `z`.
fn zone_walls(blend: &BlendMode, z: f64, settings: &SliceSettings, tweak: &Tweak) -> u32 {
    match blend {
        BlendMode::ByRegion { .. } => [StrategyId::Toughness, StrategyId::Speed]
            .into_iter()
            .map(|id| tweak.apply(resolve(pure(id), settings)).walls)
            .max()
            .unwrap_or(0),
        other => tweak.apply(layer_strategy(other, z, settings)).walls,
    }
}

/// The beads of one zone's plan that lie in that zone: outside every
/// footprint for `None`, else where footprint `zone` is the last to hold
/// them. A closed loop cut open keeps the run through its start whole, as
/// `keep_side` does.
fn keep_zone(paths: Vec<Extrusion>, prints: &[Print], zone: Option<usize>) -> Vec<Extrusion> {
    let mut out = Vec::with_capacity(paths.len());
    for path in paths {
        let mut kept = zone_runs(&path.points, prints, zone);
        if kept.len() == 1 && kept[0] == path.points {
            out.push(path);
            continue;
        }
        let closed = path.points.len() > 2 && path.points.first() == path.points.last();
        if closed && kept.len() >= 2 && kept[0].first() == path.points.first() {
            let head = kept.remove(0);
            let tail = kept.last_mut().unwrap();
            tail.extend_from_slice(&head[1..]);
        }
        out.extend(
            kept.into_iter()
                .filter(|pts| poly_len(pts) > 0.05)
                .map(|pts| {
                    let mut piece = cut_piece(&path, pts);
                    if piece.kind.is_closed() {
                        piece.seam = Seam::Cut;
                    }
                    piece
                }),
        );
    }
    out
}

/// Both sides' beads with each high run of a travel group right after the low
/// run of the same group. Ordering chains paths only within a run of one
/// group, so a wall or infill line that ends on the cut continues on the
/// other side instead of leaving a travel back from every cut end.
fn pair_sides(low: Vec<Extrusion>, high: Vec<Extrusion>) -> Vec<Extrusion> {
    let runs = |paths: Vec<Extrusion>| {
        let mut out: Vec<Vec<Extrusion>> = Vec::new();
        for path in paths {
            match out.last_mut() {
                Some(run) if run[0].travel_group() == path.travel_group() => run.push(path),
                _ => out.push(vec![path]),
            }
        }
        out
    };
    let mut high = runs(high).into_iter().peekable();
    let mut out = Vec::new();
    for run in runs(low) {
        let group = run[0].travel_group();
        out.extend(run);
        if let Some(next) = high.next_if(|h| h[0].travel_group() == group) {
            out.extend(next);
        }
    }
    out.extend(high.flatten());
    out
}

/// The strategy a non-region blend prints at height `z`.
/// The lightning branches of every layer, grown once for the strategy the
/// blend prints lightning with: speed on a region blend's high side, else
/// the first layer's strategy that prints lightning. `None` when none does.
fn grow_lightning(
    cut: &Contours,
    blend: &BlendMode,
    settings: &SliceSettings,
) -> Option<Lightning> {
    let strategy = match blend {
        BlendMode::ByRegion { .. } => resolve(pure(StrategyId::Speed), settings),
        other => cut
            .bands
            .iter()
            .map(|b| layer_strategy(other, b.z, settings))
            .find(|s| s.pattern == crate::strategy::InfillPattern::Lightning)?,
    };
    let strategy = settings.object_tweak.apply(strategy);
    if strategy.pattern != crate::strategy::InfillPattern::Lightning {
        return None;
    }
    let skins = &cut.skins[usize::from(strategy.toughness > 0.6)];
    Some(crate::lightning::grow(
        &cut.bands,
        &cut.contours,
        skins,
        strategy.walls,
        settings.line_width,
        lightning_pitch(&strategy, settings.line_width),
    ))
}

fn layer_strategy(blend: &BlendMode, z: f64, settings: &SliceSettings) -> ResolvedStrategy {
    resolve(
        match blend {
            BlendMode::Single { strategy } => pure(*strategy),
            BlendMode::Weight { toughness } => mix(*toughness),
            BlendMode::ByLayer {
                bottom_mm,
                transition_mm,
            } => mix(layer_weight(z, *bottom_mm, *transition_mm)),
            BlendMode::ByRegion { .. } => unreachable!(),
        },
        settings,
    )
}

#[allow(clippy::too_many_arguments)]
fn object_layer(
    index: usize,
    z: f64,
    height: f64,
    contours: &[Loop],
    blend: &BlendMode,
    settings: &SliceSettings,
    skins: [&Arc<Skin>; 2],
    roof_distance: f64,
    min: [f64; 3],
    max: [f64; 3],
    nozzle_diameter: f64,
    remain_low: (u32, u32),
    remain_high: (u32, u32),
    lightning: Option<(&Lightning, usize)>,
) -> ObjectLayer {
    let line_width = settings.line_width;
    // The grown branches, for a strategy that prints the lightning they were grown for.
    let grown = |s: &ResolvedStrategy| -> Option<Branches> {
        let (plan, i) = lightning?;
        let fits = s.pattern == crate::strategy::InfillPattern::Lightning
            && s.walls == plan.walls
            && (lightning_pitch(s, line_width) - plan.pitch).abs() < 1e-9;
        fits.then(|| Arc::clone(&plan.layers[i]))
    };
    let features = PathFeatures {
        variable_width: settings.variable_width,
        roof_distance_mm: roof_distance,
        layer_index: index,
        layer_height: height,
        shell: ShellBand::Interior,
        skin: Arc::default(),
        lightning: None,
        z,
        fuzzy_skin: settings.fuzzy_skin,
        seam_paint: settings.seam_paint.clone(),
        nozzle_diameter,
        interior_remaining: remain_low.0,
        interior_run: remain_low.1,
    };
    // The blend's plan of `region`, with `tweak` over every strategy it
    // prints, and the print speed the note names when the object's cap
    // lowers it.
    let plan = |region: &[Loop], tweak: Option<&Tweak>| {
        let tweaked = |s: ResolvedStrategy| match tweak {
            Some(t) => t.apply(s),
            None => s,
        };
        let takes_cap = tweak.and_then(|t| t.speed).is_none();
        let mut shown = None;
        let mut paths = Vec::new();
        let mut wall_ms = 0.0;
        let mut infill_ms = 0.0;
        let contours = region;
        let note = match blend {
            BlendMode::ByRegion { axis, at_mm } => {
                let (low_rect, high_rect) = split_rects(*axis, *at_mm, min, max, contours);
                let tough = tweaked(resolve(pure(StrategyId::Toughness), settings));
                let speed = tweaked(resolve(pure(StrategyId::Speed), settings));
                let margin = cut_margin(&tough, &speed, line_width);
                let low_plan = widen_rect(low_rect, *axis, true, margin);
                let high_plan = widen_rect(high_rect, *axis, false, margin);
                let low = clip_to_rect(contours, low_plan.0, low_plan.1);
                let high = clip_to_rect(contours, high_plan.0, high_plan.1);
                let mut hint = [min[0], min[1]];
                let mut low_feat = features.clone();
                low_feat.skin = skin_of(skins, &tough);
                low_feat.lightning = grown(&tough);
                low_feat.shell = low_feat.skin.shell();
                low_feat.interior_remaining = remain_low.0;
                low_feat.interior_run = remain_low.1;
                let mut high_feat = features.clone();
                high_feat.skin = skin_of(skins, &speed);
                high_feat.lightning = grown(&speed);
                high_feat.shell = high_feat.skin.shell();
                high_feat.interior_remaining = remain_high.0;
                high_feat.interior_run = remain_high.1;
                let (low_paths, low_wall, low_infill) =
                    plan_region_split(&low, &tough, line_width, &mut hint, &low_feat);
                let (high_paths, high_wall, high_infill) =
                    plan_region_split(&high, &speed, line_width, &mut hint, &high_feat);
                wall_ms += low_wall + high_wall;
                infill_ms += low_infill + high_infill;
                paths.extend(pair_sides(
                    keep_side(low_paths, *axis, *at_mm, true),
                    keep_side(high_paths, *axis, *at_mm, false),
                ));
                format!("region low=toughness high=speed split {at_mm:.2} h={height:.3}")
            }
            other => {
                let resolved = tweaked(layer_strategy(other, z, settings));
                let mut hint = [max[0], (min[1] + max[1]) * 0.5];
                let mut feat = features.clone();
                feat.skin = skin_of(skins, &resolved);
                feat.lightning = grown(&resolved);
                feat.shell = feat.skin.shell();
                feat.interior_remaining = remain_low.0;
                feat.interior_run = remain_low.1;
                let (region, region_wall, region_infill) =
                    plan_region_split(contours, &resolved, line_width, &mut hint, &feat);
                wall_ms += region_wall;
                infill_ms += region_infill;
                paths.extend(region);
                shown = takes_cap.then_some(resolved.print_speed);
                format!(
                    "{} walls={} infill={:.0}% {}{}h={:.3}",
                    resolved.id.as_str(),
                    resolved.walls,
                    resolved.infill_density * 100.0,
                    pattern_label(&resolved),
                    speed_label(resolved.print_speed),
                    height
                )
            }
        };
        if takes_cap {
            for path in &mut paths {
                path.cap_feed = Some(CapFeed {
                    feed: path.speed,
                    slow: Slowdown::None,
                });
            }
        }
        (paths, wall_ms, infill_ms, note, shown)
    };
    // The object's speed cap is applied once the layers are joined, so a
    // cap change reuses every part stage.
    let object = Tweak {
        speed: None,
        ..settings.object_tweak
    };
    let range = object.under(settings.overrides.range_at(z));
    let prints = layer_footprints(&settings.overrides, z, contours);
    let (paths, wall_ms, infill_ms, mut note, shown) = if prints.is_empty() {
        plan(contours, range.as_ref())
    } else {
        // Each zone plans the part's own outline, so its walls follow the
        // real perimeter. The base zone plans the whole layer; a volume plans
        // the part within reach of its footprint, so the walls of that clip
        // edge lie outside the footprint. Each keeps only the beads in its
        // zone, and beads cut at a footprint edge meet the other zone's.
        let (mut paths, mut wall_ms, mut infill_ms, mut note, shown) =
            plan(contours, range.as_ref());
        paths = keep_zone(paths, &prints, None);
        for (k, print) in prints.iter().enumerate() {
            // The volume wins on each field it sets; the range, then the
            // object, fill the rest.
            let stacked = range
                .unwrap_or_default()
                .under(Some(print.tweak))
                .unwrap_or(print.tweak);
            let walls = zone_walls(blend, z, settings, &stacked);
            let reach = offset_loops(&[print.outline.polygon()], (walls + 2) as f64 * line_width);
            let region = boolean_intersect(contours, &reach);
            if region.is_empty() {
                continue;
            }
            let (own, own_wall, own_infill, _, _) = plan(&region, Some(&stacked));
            wall_ms += own_wall;
            infill_ms += own_infill;
            let own = keep_zone(own, &prints, Some(k));
            if !own.is_empty() {
                note.push_str(&format!(" · volume {}", print.volume));
            }
            paths = pair_sides(paths, own);
        }
        (paths, wall_ms, infill_ms, note, shown)
    };
    if paths.iter().any(|p| p.kind == PathKind::GapFill) && !note.contains("gap-fill") {
        note.push_str(" · gap-fill");
    }
    ObjectLayer {
        paths,
        note,
        shown_speed: shown,
        wall_ms,
        infill_ms,
    }
}

/// A print speed as a layer note names it, with the spaces around it.
fn speed_label(speed: f64) -> String {
    format!(" {speed:.0}mm/s ")
}

/// Paths printed from one layer's support regions and branches.
#[allow(clippy::too_many_arguments)]
fn support_paths(
    z: f64,
    height: f64,
    contours: &[Loop],
    layer: &SupportLayer,
    shaft_scale: f64,
    blend: &BlendMode,
    settings: &SliceSettings,
    min: [f64; 3],
    max: [f64; 3],
) -> Vec<Extrusion> {
    let line_width = settings.line_width;
    let mut paths = Vec::new();
    match blend {
        BlendMode::ByRegion { axis, at_mm } => {
            let split = split_rects(*axis, *at_mm, min, max, contours);
            let tough = resolve(pure(StrategyId::Toughness), settings);
            let speed = resolve(pure(StrategyId::Speed), settings);
            emit_supports(
                &mut paths,
                &layer.sparse,
                &layer.interface,
                &layer.disks,
                shaft_scale,
                height,
                &tough,
                &speed,
                Some(split),
                line_width,
            );
        }
        other => {
            let resolved = layer_strategy(other, z, settings);
            emit_supports(
                &mut paths,
                &layer.sparse,
                &layer.interface,
                &layer.disks,
                shaft_scale,
                height,
                &resolved,
                &resolved,
                None,
                line_width,
            );
        }
    }
    paths
}

/// The first layer's skirt around the part and its support footprint.
fn skirt_paths(
    contours: &[Loop],
    support: Option<&SupportLayer>,
    z: f64,
    blend: &BlendMode,
    settings: &SliceSettings,
) -> Vec<Extrusion> {
    let (sparse, interface) = support
        .map(|s| (s.sparse.as_slice(), s.interface.as_slice()))
        .unwrap_or((&[], &[]));
    let outline = boolean_union(contours, &boolean_union(sparse, interface));
    if outline.is_empty() || !settings.skirt {
        return Vec::new();
    }
    let strategy = match blend {
        BlendMode::ByRegion { .. } => {
            let mut tough = resolve(pure(StrategyId::Toughness), settings);
            tough.skirt_loops = 1;
            tough
        }
        other => layer_strategy(other, z, settings),
    };
    plan_skirt(&outline, &strategy, settings.line_width)
}

type XyRect = ([f64; 2], [f64; 2]);
type RegionSplit = (XyRect, XyRect);

#[allow(clippy::too_many_arguments)]
fn support_seed_weight(blend: &BlendMode) -> f64 {
    match blend {
        BlendMode::Single { strategy } => match strategy {
            StrategyId::Toughness => 1.0,
            StrategyId::Speed => 0.15,
        },
        BlendMode::Weight { toughness } => toughness.clamp(0.0, 1.0),
        BlendMode::ByLayer { .. } => 0.45,
        BlendMode::ByRegion { .. } => 0.55,
    }
}

/// 0 is speed, 1 is toughness. Mixed blends sit between them.
fn support_toughness(blend: &BlendMode) -> f64 {
    match blend {
        BlendMode::Single { strategy } => match strategy {
            StrategyId::Toughness => 1.0,
            StrategyId::Speed => 0.0,
        },
        BlendMode::Weight { toughness } => toughness.clamp(0.0, 1.0),
        BlendMode::ByLayer { .. } => 0.45,
        BlendMode::ByRegion { .. } => 0.55,
    }
}

/// Interface may bridge this far to the tip that carries it.
/// Speed is 10.8 mm; toughness keeps a 3.5 mm contact grid.
fn support_tip_spacing(blend: &BlendMode) -> f64 {
    let t = support_toughness(blend);
    (10.8 - 7.3 * t).clamp(3.2, 12.0)
}

/// Tip-units one tip-sized cross-section may carry.
/// Speed is 5.2; toughness is 1.5, so trunks stay more numerous.
fn support_load_factor(blend: &BlendMode) -> f64 {
    let t = support_toughness(blend);
    (5.2 - 3.7 * t).clamp(1.05, 8.0)
}

#[allow(clippy::too_many_arguments)]
fn emit_supports(
    paths: &mut Vec<Extrusion>,
    support: &[Loop],
    interface: &[Loop],
    disks: &[Disk],
    shaft_scale: f64,
    layer_height: f64,
    low: &ResolvedStrategy,
    high: &ResolvedStrategy,
    split: Option<RegionSplit>,
    line_width: f64,
) {
    if support.is_empty() && interface.is_empty() && disks.is_empty() {
        return;
    }
    let paint = |paths: &mut Vec<Extrusion>,
                 region_s: &[Loop],
                 region_i: &[Loop],
                 disks: &[Disk],
                 strategy: &ResolvedStrategy| {
        if shaft_scale > 0.0 {
            let mut sparse = if disks.is_empty() {
                plan_support(
                    region_s,
                    strategy,
                    line_width,
                    support_density(strategy),
                    false,
                )
            } else {
                plan_tree_support(disks, strategy, line_width)
            };
            if shaft_scale > 1.01 {
                for path in &mut sparse {
                    path.bead_height = layer_height * shaft_scale;
                }
            }
            paths.extend(sparse);
        }
        paths.extend(plan_support(
            region_i,
            strategy,
            line_width,
            support_interface_density(strategy),
            true,
        ));
    };
    if let Some((low_rect, high_rect)) = split {
        // Part rects stop 2 mm outside this layer's outline. Trunks stand in
        // the air beside that outline. Plan every branch once, then cut the
        // beads on the plane, so a trunk that leans across the cut is not
        // drawn twice and a trunk outside the outline is not dropped.
        if !disks.is_empty() && shaft_scale > 0.0 {
            let mut trunks = plan_tree_support(disks, low, line_width);
            if shaft_scale > 1.01 {
                for path in &mut trunks {
                    path.bead_height = layer_height * shaft_scale;
                }
            }
            if let Some((axis, at)) = split_edge(low_rect, high_rect) {
                let (low_paths, high_paths) = split_extrusions(trunks, axis, at);
                retarget_supports(paths, low_paths, low);
                retarget_supports(paths, high_paths, high);
            } else {
                paths.extend(trunks);
            }
        }
        let (low_cover, high_cover) =
            support_half_rects(support, interface, disks, low_rect, high_rect);
        for (rect, strategy) in [(low_cover, low), (high_cover, high)] {
            let Some(rect) = rect else {
                continue;
            };
            if disks.is_empty() {
                paint(
                    paths,
                    &clip_to_rect(support, rect.0, rect.1),
                    &clip_to_rect(interface, rect.0, rect.1),
                    &[],
                    strategy,
                );
            } else {
                paths.extend(plan_support(
                    &clip_to_rect(interface, rect.0, rect.1),
                    strategy,
                    line_width,
                    support_interface_density(strategy),
                    true,
                ));
            }
        }
    } else {
        paint(paths, support, interface, disks, low);
    }
}

fn retarget_supports(
    paths: &mut Vec<Extrusion>,
    side: Vec<Extrusion>,
    strategy: &ResolvedStrategy,
) {
    for mut path in side {
        path.strategy = strategy.id;
        path.speed = support_speed(strategy, false);
        path.travel_speed = strategy.travel_speed;
        path.accel = strategy.accel;
        path.retract_mm = strategy.retract_mm;
        path.retract_min_travel = strategy.retract_min_travel;
        path.fan = strategy.fan;
        path.travel_accel = if strategy.feature_speeds {
            strategy.travel_accel
        } else {
            strategy.accel
        };
        paths.push(path);
    }
}

/// Cut support beads on the region plane. A bead that stays on one side keeps
/// its loop. A bead that crosses becomes the two pieces that meet on the plane.
fn split_extrusions(
    paths: Vec<Extrusion>,
    axis: Axis,
    at: f64,
) -> (Vec<Extrusion>, Vec<Extrusion>) {
    let mut low = Vec::new();
    let mut high = Vec::new();
    for path in paths {
        let (low_pts, high_pts) = split_polyline(&path.points, axis, at);
        for pts in low_pts {
            if pts.len() >= 2 && poly_len(&pts) > 0.4 {
                low.push(cut_piece(&path, pts));
            }
        }
        for pts in high_pts {
            if pts.len() >= 2 && poly_len(&pts) > 0.4 {
                high.push(cut_piece(&path, pts));
            }
        }
    }
    (low, high)
}

fn cut_piece(src: &Extrusion, pts: Vec<[f64; 2]>) -> Extrusion {
    let mut path = src.clone();
    path.points = pts;
    path.z_frac.clear();
    path.flow_frac.clear();
    path.lead_in.clear();
    path
}

fn poly_len(pts: &[[f64; 2]]) -> f64 {
    pts.windows(2)
        .map(|w| (w[1][0] - w[0][0]).hypot(w[1][1] - w[0][1]))
        .sum()
}

type PointChains = Vec<Vec<[f64; 2]>>;

fn split_polyline(pts: &[[f64; 2]], axis: Axis, at: f64) -> (PointChains, PointChains) {
    let mut low_out = Vec::new();
    let mut high_out = Vec::new();
    if pts.len() < 2 {
        return (low_out, high_out);
    }
    let mut low: Vec<[f64; 2]> = Vec::new();
    let mut high: Vec<[f64; 2]> = Vec::new();
    for w in pts.windows(2) {
        let (a, b) = (w[0], w[1]);
        let a_low = axis_of(a, axis) < at;
        let b_low = axis_of(b, axis) < at;
        if a_low == b_low {
            if a_low {
                push_pt(&mut low, a, b);
            } else {
                push_pt(&mut high, a, b);
            }
            continue;
        }
        let hit = plane_hit(a, b, axis, at);
        if a_low {
            push_pt(&mut low, a, hit);
            take_chain(&mut low, &mut low_out);
            push_pt(&mut high, hit, b);
        } else {
            push_pt(&mut high, a, hit);
            take_chain(&mut high, &mut high_out);
            push_pt(&mut low, hit, b);
        }
    }
    take_chain(&mut low, &mut low_out);
    take_chain(&mut high, &mut high_out);
    (low_out, high_out)
}

fn axis_of(p: [f64; 2], axis: Axis) -> f64 {
    match axis {
        Axis::X => p[0],
        Axis::Y => p[1],
    }
}

fn plane_hit(a: [f64; 2], b: [f64; 2], axis: Axis, at: f64) -> [f64; 2] {
    let ca = axis_of(a, axis);
    let cb = axis_of(b, axis);
    let t = if (cb - ca).abs() < 1e-12 {
        0.0
    } else {
        ((at - ca) / (cb - ca)).clamp(0.0, 1.0)
    };
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

fn push_pt(chain: &mut Vec<[f64; 2]>, a: [f64; 2], b: [f64; 2]) {
    if chain.is_empty() {
        chain.push(a);
    }
    let last = *chain.last().unwrap();
    if (last[0] - b[0]).abs() > 1e-9 || (last[1] - b[1]).abs() > 1e-9 {
        chain.push(b);
    }
}

fn take_chain(chain: &mut Vec<[f64; 2]>, out: &mut PointChains) {
    if chain.len() >= 2 {
        out.push(std::mem::take(chain));
    } else {
        chain.clear();
    }
}

/// Half-planes of the region cut, expanded to every support loop and branch.
/// A side with no support returns `None` so an inverted outline rect cannot
/// swallow the other side's trunks.
fn support_half_rects(
    support: &[Loop],
    interface: &[Loop],
    disks: &[Disk],
    low: XyRect,
    high: XyRect,
) -> (Option<XyRect>, Option<XyRect>) {
    let Some((axis, at)) = split_edge(low, high) else {
        return (Some(low), Some(high));
    };
    let mut min = [f64::INFINITY; 2];
    let mut max = [f64::NEG_INFINITY; 2];
    let mut touch = |p: [f64; 2]| {
        min[0] = min[0].min(p[0]);
        min[1] = min[1].min(p[1]);
        max[0] = max[0].max(p[0]);
        max[1] = max[1].max(p[1]);
    };
    for loops in [support, interface] {
        for lp in loops {
            for p in lp {
                touch(*p);
            }
        }
    }
    for d in disks {
        let (p, r) = (d.xy, d.r.max(0.0));
        touch([p[0] - r, p[1] - r]);
        touch([p[0] + r, p[1] + r]);
    }
    if !min[0].is_finite() {
        return (None, None);
    }
    // Stay past the last vertex so the clip rect includes it.
    const PAD: f64 = 0.5;
    min[0] -= PAD;
    min[1] -= PAD;
    max[0] += PAD;
    max[1] += PAD;
    let side = |low_side: bool| -> Option<XyRect> {
        let mut a = min;
        let mut b = max;
        let axis_i = match axis {
            Axis::X => 0,
            Axis::Y => 1,
        };
        if low_side {
            b[axis_i] = at;
        } else {
            a[axis_i] = at;
        }
        if b[axis_i] - a[axis_i] <= 1e-6 {
            None
        } else {
            Some((a, b))
        }
    };
    (side(true), side(false))
}

fn split_edge(low: XyRect, high: XyRect) -> Option<(Axis, f64)> {
    let x = (low.1[0] - high.0[0]).abs() <= 1e-4;
    let y = (low.1[1] - high.0[1]).abs() <= 1e-4;
    match (x, y) {
        (true, false) => Some((Axis::X, low.1[0])),
        (false, true) => Some((Axis::Y, low.1[1])),
        (true, true) => {
            let x_span = (high.1[0] - low.0[0]).abs();
            let y_span = (high.1[1] - low.0[1]).abs();
            if y_span > x_span {
                Some((Axis::Y, low.1[1]))
            } else {
                Some((Axis::X, low.1[0]))
            }
        }
        (false, false) => None,
    }
}

fn split_rects(
    axis: Axis,
    at: f64,
    min: [f64; 3],
    max: [f64; 3],
    contours: &[Loop],
) -> RegionSplit {
    let (bmin, bmax) = loop_bounds(contours).unwrap_or(([min[0], min[1]], [max[0], max[1]]));
    let pad = 2.0;
    match axis {
        Axis::X => (
            ([bmin[0] - pad, bmin[1] - pad], [at, bmax[1] + pad]),
            ([at, bmin[1] - pad], [bmax[0] + pad, bmax[1] + pad]),
        ),
        Axis::Y => (
            ([bmin[0] - pad, bmin[1] - pad], [bmax[0] + pad, at]),
            ([bmin[0] - pad, at], [bmax[0] + pad, bmax[1] + pad]),
        ),
    }
}

fn elapsed_ms(started: Instant) -> f64 {
    started.elapsed().as_secs_f64() * 1000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Root 8 mm wide, tip 0.55 mm, 40 mm long, 12 mm tall. Matches `wedge_wing`
    /// in tests/slice_cube.rs.
    fn wedge_wing() -> Mesh {
        let (length, root, tip, z1) = (40.0, 8.0, 0.55, 12.0);
        let y_tip0 = (root - tip) * 0.5;
        let ring = |z: f64| {
            [
                [0.0, 0.0, z],
                [length, y_tip0, z],
                [length, y_tip0 + tip, z],
                [0.0, root, z],
            ]
        };
        let (b, t) = (ring(0.0), ring(z1));
        let mut triangles = vec![
            [b[0], b[1], b[2]],
            [b[0], b[2], b[3]],
            [t[0], t[2], t[1]],
            [t[0], t[3], t[2]],
        ];
        for i in 0..4 {
            let j = (i + 1) % 4;
            triangles.push([b[i], t[i], t[j]]);
            triangles.push([b[i], t[j], b[j]]);
        }
        Mesh { triangles }
    }

    fn seg_dist(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let len2 = dx * dx + dy * dy;
        let t = if len2 < 1e-12 {
            0.0
        } else {
            (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2).clamp(0.0, 1.0)
        };
        (a[0] + dx * t - p[0]).hypot(a[1] + dy * t - p[1])
    }

    /// Wing centerline stations `flared_wing_taper_is_filled_on_speed_and_toughness`
    /// checks, left uncovered at `want_z`, and the gap-fill length on that layer.
    fn wing_holes(plan: &Plan, want_z: f64) -> (Vec<f64>, f64) {
        let layer = plan
            .layers
            .iter()
            .find(|l| (l.z - want_z).abs() < 0.15)
            .unwrap();
        let gap_mm = layer
            .paths
            .iter()
            .filter(|p| p.kind == PathKind::GapFill)
            .flat_map(|p| p.points.windows(2))
            .map(|w| (w[1][0] - w[0][0]).hypot(w[1][1] - w[0][1]))
            .sum();
        let holes = (1..20)
            .map(|i| i as f64 * 2.0)
            .filter(|&x| {
                let width = 8.0 + (0.55 - 8.0) * (x / 40.0);
                // Sparse and gyroid may leave the fat root open. The taper may not.
                let open_ok = want_z < 10.0 && width > 3.2;
                let hit = layer.paths.iter().any(|p| {
                    p.kind != PathKind::Skirt
                        && p.points.windows(2).any(|s| {
                            seg_dist([x, 4.0], s[0], s[1]) <= (p.width * 0.5).max(0.1) + 0.05
                        })
                });
                !hit && !open_ok
            })
            .collect();
        (holes, gap_mm)
    }

    /// Two 4 mm squares joined by a neck narrower than one bead. The outer wall
    /// splits at the neck, and the bead that fills it is the part's skin there.
    /// Necks under the narrowest bead (0.2 mm), and under the 0.1 mm the width
    /// probe can read, are where a membrane's faces meet. They still print.
    #[test]
    fn a_pinch_too_narrow_for_walls_is_filled_as_thin_wall() {
        for neck in [0.35, 0.12, 0.06] {
            pinch_is_thin_wall(neck);
        }
    }

    fn pinch_is_thin_wall(neck: f64) {
        let (lo, hi) = (2.0 - neck * 0.5, 2.0 + neck * 0.5);
        let dumbbell: Loop = vec![
            [0.0, 0.0],
            [4.0, 0.0],
            [4.0, lo],
            [7.0, lo],
            [7.0, 0.0],
            [11.0, 0.0],
            [11.0, 4.0],
            [7.0, 4.0],
            [7.0, hi],
            [4.0, hi],
            [4.0, 4.0],
            [0.0, 4.0],
        ];
        let settings = SliceSettings::default();
        for strategy in [StrategyId::Speed, StrategyId::Toughness] {
            let resolved = resolve(pure(strategy), &settings);
            let features = PathFeatures {
                variable_width: true,
                layer_height: 0.2,
                z: 1.0,
                nozzle_diameter: 0.4,
                layer_index: 5,
                ..PathFeatures::default()
            };
            let paths = crate::toolpath::plan_region(
                &[dumbbell.clone()],
                &resolved,
                settings.line_width,
                &mut [0.0, 0.0],
                &features,
            );
            let covered = |x: f64, kind: PathKind| {
                paths.iter().any(|p| {
                    p.kind == kind
                        && p.points
                            .windows(2)
                            .any(|s| seg_dist([x, 2.0], s[0], s[1]) <= p.width * 0.5 + 0.05)
                })
            };
            for x in [4.5, 5.0, 5.5, 6.0, 6.5] {
                assert!(
                    covered(x, PathKind::ThinWall),
                    "{strategy:?}: {neck} mm neck at x={x} has no thin wall"
                );
                assert!(
                    !covered(x, PathKind::GapFill),
                    "{strategy:?}: {neck} mm neck at x={x} is labelled gap fill"
                );
            }
        }
    }

    #[test]
    fn wing_taper_fill_survives_micron_moves_and_start_rotation() {
        let mesh = wedge_wing();
        let settings = SliceSettings::default();
        let bands = plan_bands(
            &mesh,
            &HeightOpts {
                nominal: settings.layer_height,
                adaptive: false,
                min_h: settings.adaptive_min,
                max_h: settings.layer_height,
            },
        )
        .unwrap();
        let index = ZIndex::build(&mesh);
        let cut: Vec<Vec<Loop>> = bands.iter().map(|b| index.slice(b.cut_z())).collect();
        let mut seed = 0x9E37_79B9_7F4A_7C15u64;
        let mut step = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed % 3) as f64 - 1.0
        };
        let mut failures = Vec::new();
        for case in 0..16 {
            // One Clipper grid step (1 µm) per coordinate, on the 1e-3 grid, from a rotated start.
            let moves: Vec<[f64; 2]> = (0..4).map(|_| [step() * 1e-3, step() * 1e-3]).collect();
            let contours: Vec<Vec<Loop>> = cut
                .iter()
                .map(|layer| {
                    layer
                        .iter()
                        .map(|l| {
                            let mut l: Loop = l
                                .iter()
                                .zip(moves.iter().cycle())
                                .map(|(p, m)| {
                                    [
                                        ((p[0] + m[0]) * 1e3).round() / 1e3,
                                        ((p[1] + m[1]) * 1e3).round() / 1e3,
                                    ]
                                })
                                .collect();
                            let start = case % l.len();
                            l.rotate_left(start);
                            l
                        })
                        .collect()
                })
                .collect();
            for strategy in [StrategyId::Speed, StrategyId::Toughness] {
                let plan = plan_contours(
                    bands.clone(),
                    contours.clone(),
                    mesh.bounds().unwrap(),
                    &BlendMode::Single { strategy },
                    &settings,
                    0.4,
                )
                .unwrap();
                for want_z in [6.0, 11.8] {
                    let (holes, gap_mm) = wing_holes(&plan, want_z);
                    if !holes.is_empty() || gap_mm <= 1.0 {
                        failures.push(format!(
                            "case {case} {strategy:?} z={want_z} holes at x={holes:?} gap-fill {gap_mm:.2} mm"
                        ));
                    }
                }
            }
        }
        assert!(
            failures.is_empty(),
            "{}",
            failures.join(
                "
"
            )
        );
    }

    #[test]
    fn parallel_gcode_matches_linear_on_the_cube() {
        let bytes = std::fs::read(
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../samples/calibration_cube_20mm.stl"),
        )
        .unwrap();
        let mesh = crate::load::load_mesh("calibration_cube_20mm.stl", &bytes).unwrap();
        let settings = SliceSettings {
            baseline: false,
            include_preview: false,
            compare: false,
            ..SliceSettings::default()
        };
        let profile = PrinterProfile {
            pressure_advance: 0.05,
            linear_advance: 0.08,
            ..PrinterProfile::default()
        };
        for blend in [
            BlendMode::Single {
                strategy: StrategyId::Speed,
            },
            BlendMode::Single {
                strategy: StrategyId::Toughness,
            },
        ] {
            let planned = plan(&mesh, &blend, &settings, profile.nozzle_diameter)
                .unwrap()
                .layers
                .into_iter()
                .map(PlateLayer::single)
                .collect::<Vec<_>>();
            let features = settings.feature_note();
            let parallel = crate::gcode::emit_gcode(
                &planned,
                &profile,
                &blend,
                settings.layer_height,
                settings.line_width,
                &features,
                settings.arc_fit,
                settings.classic_estimator,
                settings.junction_deviation_mm,
                &[[0.0, 0.0]],
                None,
                settings.flow,
                crate::gcode::RetractEmit {
                    length_mm: settings.retract_length,
                    speed_mm_s: settings.retract_speed,
                },
                settings.job,
                &Watch::idle(),
            );
            let linear = crate::gcode::emit_gcode_linear(
                &planned,
                &profile,
                &blend,
                settings.layer_height,
                settings.line_width,
                &features,
                settings.arc_fit,
                settings.classic_estimator,
                settings.junction_deviation_mm,
                &[[0.0, 0.0]],
                None,
                settings.flow,
                crate::gcode::RetractEmit {
                    length_mm: settings.retract_length,
                    speed_mm_s: settings.retract_speed,
                },
                settings.job,
                &Watch::idle(),
            );
            assert!(
                crate::gcode::scans_in_parallel(
                    &planned,
                    &profile,
                    settings.arc_fit,
                    settings.classic_estimator
                ),
                "{blend:?} scans its layers in parallel"
            );
            assert_eq!(parallel.text, linear.text, "{blend:?} g-code bytes");
            assert_eq!(parallel.print_time_s, linear.print_time_s);
            assert_eq!(parallel.final_e, linear.final_e);
            assert_eq!(parallel.layer_seconds, linear.layer_seconds);
            assert_eq!(parallel.arc_moves, linear.arc_moves);
            assert_eq!(parallel.retracts, linear.retracts);
            assert_eq!(parallel.z_hops, linear.z_hops);
            assert_eq!(parallel.extrusion_moves, linear.extrusion_moves);
            assert_eq!(parallel.by_feature.len(), linear.by_feature.len());
            for (a, b) in parallel.by_feature.iter().zip(&linear.by_feature) {
                assert_eq!(a.kind, b.kind);
                assert_eq!(a.seconds, b.seconds);
                assert_eq!(a.filament_mm, b.filament_mm);
            }
        }
        let settings = SliceSettings {
            classic_estimator: true,
            arc_fit: false,
            ..settings
        };
        let profile = PrinterProfile::default();
        let blend = BlendMode::Single {
            strategy: StrategyId::Speed,
        };
        let planned = plan(&mesh, &blend, &settings, profile.nozzle_diameter)
            .unwrap()
            .layers
            .into_iter()
            .map(PlateLayer::single)
            .collect::<Vec<_>>();
        let features = settings.feature_note();
        let parallel = crate::gcode::emit_gcode(
            &planned,
            &profile,
            &blend,
            settings.layer_height,
            settings.line_width,
            &features,
            settings.arc_fit,
            settings.classic_estimator,
            settings.junction_deviation_mm,
            &[[0.0, 0.0]],
            None,
            settings.flow,
            crate::gcode::RetractEmit {
                length_mm: settings.retract_length,
                speed_mm_s: settings.retract_speed,
            },
            settings.job,
            &Watch::idle(),
        );
        let linear = crate::gcode::emit_gcode_linear(
            &planned,
            &profile,
            &blend,
            settings.layer_height,
            settings.line_width,
            &features,
            settings.arc_fit,
            settings.classic_estimator,
            settings.junction_deviation_mm,
            &[[0.0, 0.0]],
            None,
            settings.flow,
            crate::gcode::RetractEmit {
                length_mm: settings.retract_length,
                speed_mm_s: settings.retract_speed,
            },
            settings.job,
            &Watch::idle(),
        );
        assert!(
            crate::gcode::scans_in_parallel(&planned, &profile, false, true),
            "the classic estimator scans its layers in parallel"
        );
        assert_eq!(parallel.text, linear.text, "classic estimator g-code");
        assert_eq!(parallel.print_time_s, linear.print_time_s);
        assert_eq!(parallel.layer_seconds, linear.layer_seconds);
    }

    #[test]
    fn pose_is_applied_without_seating_the_canonical_mesh() {
        let stl = raised_cube_stl(5.0);
        use base64::Engine;
        let data_b64 = base64::engine::general_purpose::STANDARD.encode(stl.as_bytes());
        let req: SliceRequest = serde_json::from_value(serde_json::json!({
            "filename": "raised-cube.stl",
            "dataB64": data_b64,
            "baseline": false,
            "includePreview": false,
            "simplify": false,
            "pose": {
                "rotation": [1, 0, 0, 0, 1, 0, 0, 0, 1],
                "pivot": [10.0, 10.0, 15.0],
                "translation": [10.0, 10.0, 15.0]
            }
        }))
        .unwrap();
        let response = slice_request(&req, Job::default()).unwrap();
        assert!(
            response.mesh.min[2] > 4.0,
            "canonical mesh was seated before the pose: {:?}",
            response.mesh.min
        );
        assert_eq!(response.offset, Some([-100.0, -100.0]));
        assert_eq!(response.mesh.max[0], 120.0, "part frame centred on the bed");
    }

    fn raised_cube_stl(z0: f64) -> String {
        let z1 = z0 + 20.0;
        let v = [
            [0.0, 0.0, z0],
            [20.0, 0.0, z0],
            [20.0, 20.0, z0],
            [0.0, 20.0, z0],
            [0.0, 0.0, z1],
            [20.0, 0.0, z1],
            [20.0, 20.0, z1],
            [0.0, 20.0, z1],
        ];
        let faces = [
            (0, 2, 1),
            (0, 3, 2),
            (4, 5, 6),
            (4, 6, 7),
            (0, 1, 5),
            (0, 5, 4),
            (3, 7, 6),
            (3, 6, 2),
            (0, 4, 7),
            (0, 7, 3),
            (1, 2, 6),
            (1, 6, 5),
        ];
        let mut out = String::from("solid raised\n");
        for (i, j, k) in faces {
            out.push_str("facet normal 0 0 0\nouter loop\n");
            for p in [v[i], v[j], v[k]] {
                out.push_str(&format!("vertex {} {} {}\n", p[0], p[1], p[2]));
            }
            out.push_str("endloop\nendfacet\n");
        }
        out.push_str("endsolid raised\n");
        out
    }

    /// Raw cut against simplified outline on every layer of an external mesh.
    /// Not part of the default suite.
    ///   LIME_FIDELITY_MESH=path.stl cargo test -p lime-slice-core --release -- outline_fidelity_report --ignored --nocapture
    #[test]
    #[ignore = "opt-in fidelity report on an external mesh"]
    fn outline_fidelity_report() {
        use crate::poly::{boolean_intersect, simplify_loops};
        let Ok(path) = std::env::var("LIME_FIDELITY_MESH") else {
            eprintln!("skip: LIME_FIDELITY_MESH unset");
            return;
        };
        let bytes = std::fs::read(&path).expect("read mesh");
        let mesh = crate::load::load_mesh(&path, &bytes).expect("load");
        let tol = outline_tolerance_mm(0.4);
        let index = ZIndex::build(&mesh);
        let (_, max) = mesh.bounds().unwrap();
        let area = |loops: &[Loop]| loops.iter().map(|l| signed_area(l)).sum::<f64>().abs();
        let (mut verts, mut kept, mut beyond, mut fused) = (0usize, 0usize, 0.0, 0usize);
        let mut widest = 0.0f64;
        let mut z = 0.1;
        while z < max[2] {
            let raw = index.slice(z);
            let cut = simplify_loops(raw.clone(), tol);
            verts += raw.iter().map(Vec::len).sum::<usize>();
            kept += cut.iter().map(Vec::len).sum::<usize>();
            beyond += area(&boolean_diff(&cut, &offset_loops(&raw, tol)))
                + area(&boolean_diff(&raw, &offset_loops(&cut, tol)));
            let raw_islands = crate::toolpath::island_loops(&raw);
            for piece in crate::toolpath::island_loops(&cut) {
                let near: Vec<&Vec<Loop>> = raw_islands
                    .iter()
                    .filter(|r| area(&boolean_intersect(r, &piece)) > 1e-3)
                    .collect();
                if near.len() >= 2 {
                    fused += 1;
                    let mut gap = f64::MAX;
                    for (i, a) in near.iter().enumerate() {
                        for b in &near[i + 1..] {
                            for v in a.iter().flatten() {
                                gap = gap.min(crate::poly::distance_to_outline(b, *v));
                            }
                        }
                    }
                    widest = widest.max(gap);
                    if gap > 0.05 {
                        println!(
                            "  z {z:.2}: {} islands merged, raw gap {gap:.3} mm",
                            near.len()
                        );
                    }
                }
            }
            z += 0.2;
        }
        println!(
            "tolerance {tol} mm  outline vertices {verts} -> {kept}  area beyond tolerance {beyond:.4} mm2  fused islands {fused}, widest raw gap among them {widest:.4} mm"
        );
    }

    /// Before/after travel for the reorder. Not part of the default suite.
    ///   cargo test -p lime-slice-core --release -- travel_cluster_report --ignored --nocapture
    #[test]
    #[ignore = "opt-in travel reorder report"]
    fn travel_cluster_report() {
        use crate::toolpath::set_legacy_travel_for_test;
        use std::path::PathBuf;

        struct Guard;
        impl Drop for Guard {
            fn drop(&mut self) {
                set_legacy_travel_for_test(false);
            }
        }
        let _guard = Guard;

        let quiet = SliceSettings {
            baseline: false,
            compare: false,
            include_gcode: false,
            include_preview: false,
            supports: false,
            ..SliceSettings::default()
        };
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let mut meshes: Vec<(&str, Mesh)> = Vec::new();
        for name in [
            "calibration_cube_20mm.stl",
            "lime_hull.stl",
            "dragon_2_5.stl",
        ] {
            let path = root.join("samples").join(name);
            let bytes = match std::fs::read(&path) {
                Ok(bytes) => bytes,
                Err(_) => {
                    eprintln!("skip {name}: missing");
                    continue;
                }
            };
            match crate::load::load_mesh(name, &bytes) {
                Ok(mesh) => meshes.push((name.trim_end_matches(".stl"), mesh)),
                Err(err) => eprintln!("skip {name}: {err}"),
            }
        }
        let blends = [
            (
                "speed",
                BlendMode::Single {
                    strategy: StrategyId::Speed,
                },
            ),
            (
                "tough",
                BlendMode::Single {
                    strategy: StrategyId::Toughness,
                },
            ),
        ];
        println!(
            "{:<16} {:<8} {:>10} {:>10} {:>8} {:>8} {:>10} {:>10} {:>8} {:>8}",
            "mesh",
            "blend",
            "travel0",
            "travel1",
            "moves0",
            "moves1",
            "sec0",
            "sec1",
            "core0",
            "core1"
        );
        for (name, mesh) in &meshes {
            for (label, blend) in &blends {
                set_legacy_travel_for_test(true);
                let before = slice_configured(mesh, blend, &PrinterProfile::default(), &quiet)
                    .expect("legacy slice");
                set_legacy_travel_for_test(false);
                let after = slice_configured(mesh, blend, &PrinterProfile::default(), &quiet)
                    .expect("slice");
                let dt = before.sanity.travel_length_mm - after.sanity.travel_length_mm;
                let ds = before.estimate.seconds - after.estimate.seconds;
                println!(
                    "{:<16} {:<8} {:>10.1} {:>10.1} {:>8} {:>8} {:>10.1} {:>10.1} {:>8.1} {:>8.1}  dTravel {:+.1} mm  dTime {:+.1} s  filament {:.2}->{:.2} g  retract {}->{}  order {:.1}->{:.1} ms",
                    name,
                    label,
                    before.sanity.travel_length_mm,
                    after.sanity.travel_length_mm,
                    before.sanity.travel_moves,
                    after.sanity.travel_moves,
                    before.estimate.seconds,
                    after.estimate.seconds,
                    before.core_ms,
                    after.core_ms,
                    dt,
                    ds,
                    before.estimate.filament_g,
                    after.estimate.filament_g,
                    before.sanity.retracts,
                    after.sanity.retracts,
                    before.stages.order_ms,
                    after.stages.order_ms
                );
            }
        }
    }

    #[test]
    fn estimates_without_gcode_text_match_the_full_emit() {
        let mesh = wedge_wing();
        let blend = BlendMode::Single {
            strategy: StrategyId::Speed,
        };
        let profile = PrinterProfile::default();
        let with = SliceSettings {
            include_gcode: true,
            include_preview: false,
            baseline: false,
            ..SliceSettings::default()
        };
        let without = SliceSettings {
            include_gcode: false,
            ..with.clone()
        };
        let full = slice_configured(&mesh, &blend, &profile, &with).expect("gcode");
        let quiet = slice_configured(&mesh, &blend, &profile, &without).expect("estimates");
        assert!(
            full.gcode.contains(";LAYER:"),
            "full emit should keep layer markers"
        );
        assert!(
            quiet.gcode.is_empty(),
            "discarded g-code should not be built"
        );
        assert!(full.gcode_text.is_none());
        assert!(
            quiet.gcode_text.as_ref().unwrap().text() == full.gcode,
            "the text formatted later is the text a full emit writes"
        );
        assert!(quiet.sanity.ok, "{:?}", quiet.sanity.notes);
        assert_eq!(full.sanity.layers, quiet.sanity.layers);
        assert_eq!(full.sanity.extrusion_moves, quiet.sanity.extrusion_moves);
        assert!((full.estimate.seconds - quiet.estimate.seconds).abs() < 1e-6);
        assert!((full.estimate.filament_g - quiet.estimate.filament_g).abs() < 1e-9);
    }
}

#[cfg(test)]
mod edit_cost {
    use super::*;
    use crate::support::edit::{gaps_in, SupportEdit, TipSite};
    use crate::support::{End, NodeId};

    /// What pruning costs against planning supports from scratch, on the mesh
    /// at `LIME_EDIT_MESH` under toughness. Prints one line per case.
    ///
    /// LIME_EDIT_MESH=/path/part.stp cargo test -p lime-slice-core --release --lib edit_cost -- --ignored --nocapture
    #[test]
    #[ignore = "needs LIME_EDIT_MESH"]
    fn edit_cost() {
        let path = std::env::var("LIME_EDIT_MESH").expect("set LIME_EDIT_MESH to a mesh path");
        let bytes = std::fs::read(&path).unwrap();
        let mesh = load_slice_mesh_tol(&path, &bytes, false, 0.1).unwrap();
        let blend = BlendMode::Single {
            strategy: StrategyId::Toughness,
        };
        let settings = SliceSettings {
            supports: true,
            ..SliceSettings::default()
        };
        let bounds = mesh.bounds().unwrap();
        let bands = plan_bands(
            &mesh,
            &HeightOpts {
                nominal: settings.layer_height,
                adaptive: false,
                min_h: settings.adaptive_min,
                max_h: settings.layer_height,
            },
        )
        .unwrap();
        let index = ZIndex::build(&mesh);
        let tolerance = outline_tolerance(&settings, 0.4);
        let contours: Vec<Vec<Loop>> = bands
            .par_iter()
            .map(|b| simplify_loops(index.slice(b.cut_z()), tolerance))
            .collect();
        let object = Contours::new(bands, contours, bounds, &settings);
        let plan = || plan_supports(&object, &blend, &settings, None, None, &Watch::idle()).unwrap();

        let started = Instant::now();
        let base = plan();
        let full_ms = elapsed_ms(started);
        let limbs = &base.supports.forest.limbs;
        let knots: usize = limbs.iter().map(|l| l.knots.len()).sum();
        let disks: usize = base.supports.layers.iter().map(|l| l.disks.len()).sum();
        println!(
            "full plan_supports {full_ms:.0} ms (supports {:.0} ms, paths {:.0} ms); {} layers, {} limbs, {knots} knots of {} B, layer index {:.1} MB, knots {:.1} MB; storing raw disks instead would be up to one per knot at {} B, {:.1} MB; {disks} printed disks",
            base.support_ms,
            base.toolpath_ms,
            object.bands.len(),
            limbs.len(),
            std::mem::size_of_val(&limbs[0].knots[0]),
            knots as f64 * 4.0 / 1e6,
            knots as f64 * std::mem::size_of_val(&limbs[0].knots[0]) as f64 / 1e6,
            std::mem::size_of::<Disk>(),
            knots as f64 * std::mem::size_of::<Disk>() as f64 / 1e6,
        );
        let started = Instant::now();
        base.supports.coverage(&object.bands, &object.contours);
        println!("one coverage pass {:.0} ms", elapsed_ms(started));

        // Limbs in each branch, counted up from the youngest guest.
        let mut branch = vec![1usize; limbs.len()];
        for k in (0..limbs.len()).rev() {
            if let End::Merged { into } = limbs[k].end {
                branch[into.0 as usize - 1] += branch[k];
            }
        }
        let median = |mut ks: Vec<usize>| {
            ks.sort_by_key(|&k| (branch[k], k));
            ks[ks.len() / 2]
        };
        let merged = |k: usize| matches!(limbs[k].end, End::Merged { .. });
        let mut trees: Vec<usize> = (0..limbs.len()).filter(|&k| !merged(k)).collect();
        trees.sort_by_key(|&k| (branch[k], k));
        let tips = |at: f64| branch[trees[((trees.len() - 1) as f64 * at) as usize]];
        println!(
            "{} trees, tips per tree: median {}, p90 {}, p99 {}, max {}",
            trees.len(),
            tips(0.5),
            tips(0.9),
            tips(0.99),
            tips(1.0)
        );
        let tree = median(
            (0..limbs.len())
                .filter(|&k| !merged(k) && branch[k] >= 10)
                .collect(),
        );
        let largest = *trees.last().unwrap();
        let guest = median(
            (0..limbs.len())
                .filter(|&k| merged(k) && branch[k] >= 2)
                .collect(),
        );
        let bands = &object.bands;
        let id = |k: usize| NodeId(k as u32 + 1);
        let mut seed = 0x2545_F491_4F6C_DD1Du64;
        let subset: Vec<TipSite> = (0..limbs.len())
            .filter(|_| {
                seed ^= seed << 13;
                seed ^= seed >> 7;
                seed ^= seed << 17;
                seed % 100 == 0
            })
            .map(|k| base.supports.limb_site(id(k), bands))
            .collect();
        let cases = [
            ("mid-size tree", base.supports.tree_sites(id(tree), bands)),
            ("largest tree", base.supports.tree_sites(id(largest), bands)),
            ("one branch", base.supports.branch_sites(id(guest), bands)),
            ("1% of tips", subset),
        ];
        let mid = cases[0].1.clone();
        let warned = |p: &SupportPlan| {
            let area: f64 = p.coverage.iter().map(|g| f64::from(g.area_mm2)).sum();
            (p.coverage.len(), (area * 10.0).round() / 10.0)
        };
        let warned_built = warned(&base);
        let built = base
            .supports
            .coverage_from(&object.bands, &object.contours, 0.0);
        drop(base);
        for (name, sites) in cases {
            let mut plan = plan();
            let tips = sites.len();
            let edit = [SupportEdit::Prune { sites }];
            let started = Instant::now();
            let out =
                Arc::make_mut(&mut plan.supports).apply(&edit, &object.bands, &object.contours);
            let apply_ms = elapsed_ms(started);
            let started = Instant::now();
            let painted = plan.refresh(&object, &out[0].changed, &blend, &settings);
            let refresh_ms = elapsed_ms(started);
            let same =
                plan.supports.layers == plan.supports.rebuilt(&object.bands, &object.contours);
            println!(
                "{name}: {tips} tips, {:?}, apply {apply_ms:.0} ms, {} layers changed in {:?}, stood {}, refresh {refresh_ms:.0} ms repainting {} layers, newly floating {:.1} mm2, incremental == full {same}",
                out[0].status,
                out[0].changed.len(),
                out[0].changed.first().zip(out[0].changed.last()),
                out[0].stood,
                painted.len(),
                out[0].newly_floating_mm2,
            );
            assert!(
                same,
                "{name}: the incremental rebuild differs from a full one"
            );
        }

        let mut plan = plan();
        let pruned = Arc::make_mut(&mut plan.supports).apply(
            &[SupportEdit::Prune { sites: mid }],
            &object.bands,
            &object.contours,
        );
        plan.refresh(&object, &pruned[0].changed, &blend, &settings);
        let edit = [SupportEdit::over_gaps(&pruned[0].floating)];
        let SupportEdit::Regrow { region, z } = &edit[0] else {
            unreachable!()
        };
        let area = |gaps: &[CoverageGap]| -> f64 {
            gaps_in(gaps, region, *z)
                .iter()
                .map(|g| f64::from(g.area_mm2))
                .sum()
        };
        let (limbs, warned_before) = (plan.supports.forest.limbs.len(), warned(&plan));
        let started = Instant::now();
        let out = Arc::make_mut(&mut plan.supports).apply(&edit, &object.bands, &object.contours);
        let apply_ms = elapsed_ms(started);
        let started = Instant::now();
        let painted = plan.refresh(&object, &out[0].changed, &blend, &settings);
        let refresh_ms = elapsed_ms(started);
        let same = plan.supports.layers == plan.supports.rebuilt(&object.bands, &object.contours);
        let (now, was) = (area(&out[0].floating), area(&built));
        println!(
            "mid-size tree pruned then regrown over its {} gaps: {:?}, apply {apply_ms:.0} ms, {} limbs grown, {} layers changed in {:?}, stood {}, refresh {refresh_ms:.0} ms repainting {} layers, warned coverage {warned_built:?} as built, {warned_before:?} pruned, {:?} regrown (gaps, mm2), newly floating {:.1} mm2, in the region {now:.1} mm2 against {was:.1} mm2 as built, incremental == full {same}",
            pruned[0].floating.len(),
            out[0].status,
            plan.supports.forest.limbs.len() - limbs,
            out[0].changed.len(),
            out[0].changed.first().zip(out[0].changed.last()),
            out[0].stood,
            painted.len(),
            warned(&plan),
            out[0].newly_floating_mm2,
        );
        assert!(
            same,
            "regrow: the incremental rebuild differs from a full one"
        );
        assert!(
            now <= was + 1e-3,
            "the regrown region floats {now} mm2, more than the {was} mm2 it did as built"
        );
    }
}
