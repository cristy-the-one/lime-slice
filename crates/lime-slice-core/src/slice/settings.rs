use super::*;

/// What to inject at one layer. `customGcode` also carries `gcode`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LayerActionKind {
    Pause,
    FilamentChange,
    CustomGcode,
}

/// A pause, filament change, or custom line at `z_mm`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerAction {
    pub z_mm: f64,
    pub kind: LayerActionKind,
    /// Written as a comment on the line before the command.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// The line to emit when `kind` is `customGcode`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gcode: Option<String>,
}

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
    /// Bed adhesion. Omitted means the existing one-loop (or toughness two-loop) skirt.
    #[serde(default, skip_serializing_if = "AdhesionType::is_skirt")]
    pub adhesion: AdhesionType,
    /// Brim width, or mouse-ear radius, in millimetres. Omitted keeps 5 mm when a brim or ears are on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brim_width_mm: Option<f64>,
    /// Gap between the part and a brim or mouse ear. Omitted keeps 0.1 mm.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brim_gap_mm: Option<f64>,
    /// Skirt loops. Omitted keeps the strategy count: 1 on speed, 2 on toughness.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skirt_loops: Option<u32>,
    /// Top-skin fill. Omitted keeps rectilinear scanlines, so a default request
    /// stays byte-identical. Monotonic and concentric are opt-in.
    #[serde(default, skip_serializing_if = "SurfacePattern::is_rectilinear")]
    pub top_surface_pattern: SurfacePattern,
    /// Widen vertical holes, millimetres. `0` is omitted.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub xy_hole_compensation_mm: f64,
    /// Grow outer contours, millimetres. Negative shrinks them. `0` is omitted.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub xy_contour_compensation_mm: f64,
    /// Inset the first layer's outer contour, millimetres. `0` is omitted.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub elephants_foot_compensation_mm: f64,
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
    /// Keep a thickening tree branch out of a pocket it cannot leave.
    /// Left out when off, so a request that does not ask keeps its cache key.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub support_avoidance: bool,
    /// On a belt, a tree interface row stands only on the row under it, so
    /// every row of a steep sloped sheet bears tips: more branches and a
    /// longer print. Left out when off, so a request that does not ask keeps
    /// its cache key.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub support_strict_stacking: bool,
    /// Enforce paint fills the gaps between its dabs where the part faces
    /// down, so a surface painted in dabs is held between them too. Left out
    /// when off, so a request that does not ask keeps its cache key.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub support_paint_join: bool,
    /// Print supports gently: every support path of every style at a gentle
    /// feed and acceleration, the interface slower still, and a retract on
    /// every travel that leaves a support. A longer print with fewer
    /// knocked-over supports and fewer strings. Left out when off, so a
    /// request that does not ask keeps its cache key.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub support_slow_fragile: bool,
    /// Support feed under `support_slow_fragile`, mm/s. Omitted keeps 40.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub support_gentle_speed_mm_s: Option<f64>,
    /// Support acceleration under `support_slow_fragile`, mm/s². Omitted keeps 2000.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub support_gentle_accel_mm_s2: Option<f64>,
    /// `auto` (the default) asks for supports from the overhang angle and
    /// the islands. `paint` asks only where enforce paint does. Omitted
    /// when absent, so a request that does not ask keeps its cache key.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub support_source: Option<String>,
    /// `0` keeps model layer height. Values above 1 thicken sparse support shafts.
    #[serde(default)]
    pub support_height_mult: f64,
    /// Vertical gap between the support interface and the part. Omitted keeps
    /// `layer_height` (at least 0.12 mm), which is what a default slice uses.
    /// `0` is a real zero: the support touches the part.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub support_z_gap_mm: Option<f64>,
    /// Horizontal gap between supports and the part. Omitted keeps 0.55 mm. `0` is a real zero.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub support_xy_gap_mm: Option<f64>,
    /// Dense interface layers under the part. Omitted keeps 3. `0` prints one, the fewest there can be.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub support_interface_layers: Option<u32>,
    /// Brim under every support, of every style, where it stands on the bed
    /// or the belt, millimetres wide. Omitted prints none. The name is from
    /// when only tree trunks had one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub support_tree_brim_mm: Option<f64>,
    /// On a belt, anchor lines across the belt where supports stand on it:
    /// one support line along X at the first and last support foot and every
    /// this many millimetres along the belt between them. Omitted prints none;
    /// a flat bed never prints them. The wire name keeps "belt"; the field
    /// does not, so `SliceSettings` stays free of belt words (cartesian_lock).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        rename = "supportBeltAnchorMm"
    )]
    pub support_anchor_mm: Option<f64>,
    /// Multiplier on a bridge bead. Omitted keeps 1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bridge_flow_ratio: Option<f64>,
    /// Bridge feed, millimetres per second. Omitted keeps the 18–36 mm/s slowdown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bridge_speed_mm_s: Option<f64>,
    /// Bridge fan, percent of full. Omitted, bridges take the overhang fan:
    /// the printer's `overhangFanPercent`, else full fan once the layer fan is on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bridge_fan_percent: Option<u8>,
    /// Pauses and filament changes. Omitted when empty, so a default request
    /// stays byte-identical.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub layer_actions: Vec<LayerAction>,
    /// Combine sparse infill on speed and low-weight blends. Default on.
    #[serde(default = "default_true")]
    pub infill_combine: bool,
    /// Find skin on slopes so shallow that each layer exposes a strip
    /// thinner than the walls: the strips of the shell depth are joined
    /// before the walls are taken off. More solid infill and a longer print.
    /// Left out when off, so a request that does not ask keeps its cache key.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub shallow_skins: bool,
    /// Solid skin under walls that stand on the interior of the layer below,
    /// as a lip or comb born over a slot does. More solid infill and a longer
    /// print. Left out when off, so a request that does not ask keeps its
    /// cache key.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub solid_under_walls: bool,
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
    /// A layer that would print in fewer seconds is slowed to take this many, its
    /// extrusion feeds scaled together. Left out, or `0`, keeps every layer's feeds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_layer_time_s: Option<f64>,
    /// The slowest feed in mm/s a slowed layer prints at. Left out keeps 15 mm/s.
    /// A path planned slower than this stays at its own feed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_layer_speed_mm_s: Option<f64>,
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
    /// Painted columns and box or cylinder volumes that raise infill.
    /// Omitted when empty, so a slice without them keeps its cache key and
    /// its G-code. On an object when `objects` is sent.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reinforcement: Vec<serde_json::Value>,
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
    /// Also measure the part beads that stand on nothing, as `partHold`.
    /// It reads the finished layers and never changes the G-code. Omitted
    /// when off, so a request that does not ask keeps its cache key.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub part_hold: bool,
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
    /// Hanging rows read by the bead's far edge, and those on support
    /// interface printed like bridges. Set on a belt, never by a request.
    pub hanging_rows: bool,
    pub classic: bool,
    pub support_style: SupportStyle,
    pub branch_angle: f64,
    pub tip_diameter: f64,
    pub trunk_diameter: f64,
    /// Per-layer avoidance for tree supports. Off leaves the walk unchanged.
    pub support_avoidance: bool,
    /// A tip under every belt interface row. Off keeps the in-layer reach.
    pub support_strict_stacking: bool,
    /// Enforce paint fills the gaps between its dabs. Off keeps each dab to itself.
    pub support_paint_join: bool,
    /// Every support path at the gentle feed and acceleration, and a retract
    /// on every travel that leaves a support. Off keeps every support at the
    /// support speed.
    pub support_slow_fragile: bool,
    /// `None` keeps [`GENTLE_SUPPORT_MM_S`].
    pub support_gentle_speed_mm_s: Option<f64>,
    /// `None` keeps [`GENTLE_SUPPORT_ACCEL`].
    pub support_gentle_accel_mm_s2: Option<f64>,
    pub support_source: SupportSource,
    pub support_height_mult: f64,
    pub infill_combine: bool,
    /// Skin on shallow slopes from the strips of the whole shell depth.
    pub shallow_skins: bool,
    /// Skin under walls that stand on the interior of the layer below.
    pub solid_under_walls: bool,
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
    /// `None` keeps every layer at its planned feeds.
    pub min_layer_time_s: Option<f64>,
    /// `None` keeps 15 mm/s as the slowest a slowed layer prints.
    pub min_layer_speed_mm_s: Option<f64>,
    /// Off on a belt, where an outward loop around the first layer crosses the belt line.
    pub skirt: bool,
    /// `Skirt` runs `plan_skirt` unchanged. Brim and mouse ears replace that loop.
    pub adhesion: AdhesionType,
    /// Used when `adhesion` is a brim or mouse ears. `0` is not a brim.
    pub brim_width_mm: f64,
    /// Peel gap outside the part. `0` lays the first brim bead against the wall.
    pub brim_gap_mm: f64,
    /// `None` keeps `ResolvedStrategy::skirt_loops`.
    pub skirt_loops: Option<u32>,
    /// Rectilinear unless the request asks for monotonic or concentric top skin.
    pub top_surface_pattern: SurfacePattern,
    pub xy_hole_compensation_mm: f64,
    pub xy_contour_compensation_mm: f64,
    pub elephants_foot_compensation_mm: f64,
    /// `None` keeps `layer_height.max(0.12)`.
    pub support_z_gap_mm: Option<f64>,
    /// `None` keeps 0.55 mm.
    pub support_xy_gap_mm: Option<f64>,
    /// `None` keeps 3.
    pub support_interface_layers: Option<u32>,
    /// `None` prints no brim under the supports.
    pub support_tree_brim_mm: Option<f64>,
    /// Spacing along the belt of the support anchor lines. `None` prints none.
    pub support_anchor_mm: Option<f64>,
    /// `None` keeps bridge flow at 1.
    pub bridge_flow_ratio: Option<f64>,
    /// `None` keeps the 18–36 mm/s bridge slowdown.
    pub bridge_speed_mm_s: Option<f64>,
    /// `None` gives bridges the overhang fan. A percent holds that PWM on the bridge.
    pub bridge_fan_percent: Option<u8>,
    /// Empty injects nothing at layer changes.
    pub layer_actions: Vec<LayerAction>,
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
    /// Columns and volumes that raise infill. Empty leaves the strategy.
    /// In the mesh frame while `pose` is set, then in the part frame, and
    /// on a belt after the lay-flat.
    pub reinforcement: Vec<crate::reinforcement::Region>,
    /// Height ranges and modifier volumes. Volumes are in bed coordinates
    /// until the plate moves them into each part frame.
    pub overrides: Overrides,
    /// Infill, walls, and speed for this object. Empty keeps the strategy.
    /// A range or volume wins on each field it sets.
    pub object_tweak: Tweak,
    /// Report the tree outline on the response.
    pub include_skeleton: bool,
    /// Report the part beads that stand on nothing on the response.
    pub part_hold: bool,
    /// The preview the client holds, from `SliceRequest::preview_base`.
    pub preview_base: Option<String>,
    /// The shell job this slice belongs to. A stale job stops with "cancelled".
    pub job: Job,
    /// Keep the emitted beads on the response, for a stress study. Set only by
    /// `slice_beads`; the G-code doesn't read it.
    pub capture_beads: bool,
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
            hanging_rows: false,
            classic: false,
            support_style: SupportStyle::Tree,
            branch_angle: 40.0,
            tip_diameter: 0.8,
            trunk_diameter: 4.2,
            support_avoidance: false,
            support_strict_stacking: false,
            support_paint_join: false,
            support_slow_fragile: false,
            support_gentle_speed_mm_s: None,
            support_gentle_accel_mm_s2: None,
            support_source: SupportSource::Auto,
            support_height_mult: 1.0,
            infill_combine: true,
            shallow_skins: false,
            solid_under_walls: false,
            combing: true,
            feature_speeds: true,
            seam: SeamPlacement::Blend,
            ironing: None,
            fuzzy_skin: None,
            flow: 1.0,
            retract_length: None,
            retract_speed: None,
            min_layer_time_s: None,
            min_layer_speed_mm_s: None,
            skirt: true,
            adhesion: AdhesionType::Skirt,
            brim_width_mm: 0.0,
            brim_gap_mm: 0.0,
            skirt_loops: None,
            top_surface_pattern: SurfacePattern::Rectilinear,
            xy_hole_compensation_mm: 0.0,
            xy_contour_compensation_mm: 0.0,
            elephants_foot_compensation_mm: 0.0,
            support_z_gap_mm: None,
            support_xy_gap_mm: None,
            support_interface_layers: None,
            support_tree_brim_mm: None,
            support_anchor_mm: None,
            bridge_flow_ratio: None,
            bridge_speed_mm_s: None,
            bridge_fan_percent: None,
            layer_actions: Vec::new(),
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
            reinforcement: Vec::new(),
            overrides: Overrides::default(),
            object_tweak: Tweak::default(),
            include_skeleton: false,
            part_hold: false,
            preview_base: None,
            job: Job::default(),
            capture_beads: false,
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
            hanging_rows: false,
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
            support_avoidance: req.support_avoidance && !req.classic,
            support_strict_stacking: req.support_strict_stacking && !req.classic,
            support_paint_join: req.support_paint_join && !req.classic,
            support_slow_fragile: req.support_slow_fragile && !req.classic,
            support_gentle_speed_mm_s: req
                .support_gentle_speed_mm_s
                .filter(|v| v.is_finite() && *v > 0.0 && !req.classic)
                .map(|v| v.clamp(5.0, 200.0)),
            support_gentle_accel_mm_s2: req
                .support_gentle_accel_mm_s2
                .filter(|v| v.is_finite() && *v > 0.0 && !req.classic)
                .map(|v| v.clamp(100.0, 20000.0)),
            // `load_object` has already refused a name it does not know.
            support_source: wire::parse_support_source(req.support_source.as_deref())
                .unwrap_or_default(),
            support_height_mult: if req.classic {
                1.0
            } else {
                req.support_height_mult.clamp(0.0, 4.0)
            },
            infill_combine: req.infill_combine && !req.classic,
            shallow_skins: req.shallow_skins && !req.classic,
            solid_under_walls: req.solid_under_walls && !req.classic,
            combing: req.combing && !req.classic,
            feature_speeds: req.feature_speeds && !req.classic,
            seam: req.seam,
            ironing: req.ironing,
            fuzzy_skin: if req.classic { None } else { req.fuzzy_skin },
            flow: req.flow,
            retract_length: req.retract_length,
            retract_speed: req.retract_speed,
            min_layer_time_s: req.min_layer_time_s,
            min_layer_speed_mm_s: req.min_layer_speed_mm_s,
            skirt: true,
            adhesion: req.adhesion,
            brim_width_mm: if req.adhesion.uses_brim() {
                req.brim_width_mm.unwrap_or(5.0).clamp(0.4, 30.0)
            } else {
                0.0
            },
            brim_gap_mm: if req.adhesion.uses_brim() {
                req.brim_gap_mm.unwrap_or(0.1).clamp(0.0, 2.0)
            } else {
                0.0
            },
            skirt_loops: if req.adhesion == AdhesionType::Skirt {
                req.skirt_loops.map(|loops| loops.clamp(1, 20))
            } else {
                None
            },
            top_surface_pattern: if req.classic {
                SurfacePattern::Rectilinear
            } else {
                req.top_surface_pattern
            },
            xy_hole_compensation_mm: if req.classic {
                0.0
            } else {
                snap_compensation(req.xy_hole_compensation_mm)
            },
            xy_contour_compensation_mm: if req.classic {
                0.0
            } else {
                snap_compensation(req.xy_contour_compensation_mm)
            },
            elephants_foot_compensation_mm: if req.classic {
                0.0
            } else {
                snap_compensation(req.elephants_foot_compensation_mm).max(0.0)
            },
            support_z_gap_mm: support_gap(req.classic, req.support_z_gap_mm, 2.0),
            support_xy_gap_mm: support_gap(req.classic, req.support_xy_gap_mm, 3.0),
            support_interface_layers: if req.classic {
                None
            } else {
                req.support_interface_layers.map(|n| n.clamp(1, 8))
            },
            support_tree_brim_mm: support_gap(req.classic, req.support_tree_brim_mm, 20.0)
                .filter(|mm| *mm > 1e-6),
            support_anchor_mm: req
                .support_anchor_mm
                // Only a belt has a belt to anchor to.
                .filter(|mm| !req.classic && req.belt.is_some() && mm.is_finite() && *mm > 0.0)
                .map(|mm| mm.clamp(BELT_ANCHOR_MIN_MM, BELT_ANCHOR_MAX_MM)),
            bridge_flow_ratio: bridge_flow(req.classic, req.bridge_flow_ratio),
            bridge_speed_mm_s: bridge_speed(req.classic, req.bridge_speed_mm_s),
            bridge_fan_percent: bridge_fan(req.classic, req.bridge_fan_percent),
            layer_actions: clean_layer_actions(&req.layer_actions),
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
            reinforcement: Vec::new(),
            overrides: Overrides::default(),
            object_tweak: Tweak {
                infill: req.infill,
                walls: req.walls,
                speed: req.speed,
                infill_floor: None,
            },
            include_skeleton: req.include_skeleton,
            part_hold: req.part_hold,
            preview_base: req.preview_base.clone(),
            job: Job::default(),
            capture_beads: false,
        }
    }

    /// A copy for a side plan: no edits, and no preview, so it neither reads
    /// nor evicts the kept interactive slices.
    pub(super) fn unkept(&self) -> Self {
        Self {
            support_edits: Vec::new(),
            include_preview: false,
            preview_base: None,
            ..self.clone()
        }
    }

    pub(super) fn feature_note(&self) -> String {
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
                SupportStyle::Tree => {
                    let pockets = if self.support_avoidance {
                        ", avoiding pockets"
                    } else {
                        ""
                    };
                    let rows = if self.support_strict_stacking {
                        ", a tip under every row"
                    } else {
                        ""
                    };
                    format!(
                        ", branch {:.0}°, tip {:.1} mm, trunk {:.1} mm{pockets}{rows}",
                        self.branch_angle, self.tip_diameter, self.trunk_diameter
                    )
                }
                SupportStyle::Grid => String::new(),
            };
            let angle = match self.support_source {
                SupportSource::Auto => format!("angle {:.0}°, ", self.support_angle),
                SupportSource::Paint if self.support_paint_join => {
                    "painted only, gaps between dabs filled, ".into()
                }
                SupportSource::Paint => "painted only, ".into(),
            };
            let fragile = match self.gentle() {
                Some(g) => format!(
                    ", printed gently at {:.0} mm/s and {:.0} mm/s²",
                    g.speed, g.accel
                ),
                None => String::new(),
            };
            let brim = match self.support_tree_brim_mm {
                Some(mm) => format!(", brim {mm:.1} mm"),
                None => String::new(),
            };
            let anchors = match self.support_anchor_mm {
                Some(mm) => format!(", belt anchors every {mm:.0} mm"),
                None => String::new(),
            };
            format!(
                "supports {style} ({angle}shaft ×{:.1}{organic}{fragile}{brim}{anchors})",
                self.support_height_mult.max(1.0)
            )
        } else {
            "supports off".into()
        };
        let combine = match (self.infill_combine, self.shallow_skins) {
            (true, false) => "infill combine on",
            (false, false) => "infill combine off",
            (true, true) => "infill combine on; skin on shallow slopes",
            (false, true) => "infill combine off; skin on shallow slopes",
        };
        let combine = if self.solid_under_walls {
            format!("{combine}; solid under walls on infill")
        } else {
            combine.to_string()
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
            format!("; fuzzy skin {} mm / {} mm", f.thickness, f.point_distance)
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
        let cooling = self.min_layer().map_or(String::new(), |m| {
            format!("; min layer {} s, floor {} mm/s", m.time_s, m.floor_mm_s)
        });
        format!("{layers}; {supports}; {combine}; {scarf}; {gyroid}; {hop}{seam}{ironing}{fuzzy}{flow}{retract}{cooling}")
    }

    /// The feed and acceleration supports print at, when they print gently.
    pub(crate) fn gentle(&self) -> Option<Gentle> {
        self.support_slow_fragile.then(|| Gentle {
            speed: self
                .support_gentle_speed_mm_s
                .unwrap_or(GENTLE_SUPPORT_MM_S),
            accel: self
                .support_gentle_accel_mm_s2
                .unwrap_or(GENTLE_SUPPORT_ACCEL),
        })
    }

    /// The minimum layer time the request asks for. `0` is off, like leaving it out.
    pub(crate) fn min_layer(&self) -> Option<crate::gcode::MinLayer> {
        let time_s = self.min_layer_time_s.filter(|n| *n > 0.0)?;
        Some(crate::gcode::MinLayer {
            time_s,
            floor_mm_s: self
                .min_layer_speed_mm_s
                .unwrap_or(crate::gcode::MinLayer::DEFAULT_FLOOR_MM_S),
        })
    }
}

/// Trees unless the request asks for the grid: they reach the part in far
/// less material and time than a column filling the whole overhang.
pub(super) fn parse_support_style(name: &str) -> SupportStyle {
    match name.trim().to_ascii_lowercase().as_str() {
        "grid" => SupportStyle::Grid,
        _ => SupportStyle::Tree,
    }
}

pub(super) fn default_layer() -> f64 {
    0.2
}

pub(super) fn default_step_tolerance() -> f64 {
    crate::step::STEP_TOLERANCE_DEFAULT_MM
}
pub(super) fn default_width() -> f64 {
    0.45
}

pub(super) fn default_true() -> bool {
    true
}

pub(super) fn default_one() -> f64 {
    1.0
}

pub(super) fn is_one(value: &f64) -> bool {
    (*value - 1.0).abs() < 1e-9
}

pub(super) fn is_zero(value: &f64) -> bool {
    *value == 0.0
}

/// A compensation of a few nanometres is zero. Anything else stays in ±2 mm.
pub(super) fn snap_compensation(value: f64) -> f64 {
    let value = value.clamp(-2.0, 2.0);
    if value.abs() < 1e-9 {
        0.0
    } else {
        value
    }
}

/// A support gap the request actually set. Classic, and a missing field, keep
/// the value the planner already uses.
pub(super) fn support_gap(classic: bool, value: Option<f64>, max: f64) -> Option<f64> {
    if classic {
        return None;
    }
    value.map(|mm| mm.clamp(0.0, max))
}

/// A bridge flow the request actually set. `1` is the bead bridges already use.
pub(super) fn bridge_flow(classic: bool, value: Option<f64>) -> Option<f64> {
    if classic {
        return None;
    }
    value.and_then(|ratio| {
        let ratio = ratio.clamp(0.2, 2.0);
        ((ratio - 1.0).abs() >= 1e-9).then_some(ratio)
    })
}

/// A bridge feed the request actually set. Tiny values stay on the 18–36 mm/s clamp.
pub(super) fn bridge_speed(classic: bool, value: Option<f64>) -> Option<f64> {
    if classic {
        return None;
    }
    value.and_then(|mm| (mm > 1e-6).then_some(mm.clamp(5.0, 200.0)))
}

/// A bridge fan percent the request actually set. `0` keeps the overhang fan.
pub(super) fn bridge_fan(classic: bool, value: Option<u8>) -> Option<u8> {
    if classic {
        return None;
    }
    value.filter(|pct| *pct > 0).map(|pct| pct.min(100))
}

/// Drop a pause that has no height, and a custom line that is empty.
pub(super) fn clean_layer_actions(actions: &[LayerAction]) -> Vec<LayerAction> {
    let mut out = Vec::new();
    for action in actions {
        if !action.z_mm.is_finite() {
            continue;
        }
        let z_mm = (action.z_mm.clamp(0.0, 2000.0) * 1000.0).round() / 1000.0;
        let note = action.note.as_deref().and_then(|note| {
            let note = note.trim();
            if note.is_empty() {
                None
            } else {
                Some(note.chars().take(80).collect())
            }
        });
        let gcode = match action.kind {
            LayerActionKind::CustomGcode => {
                let text = action.gcode.as_deref().unwrap_or("").trim();
                if text.is_empty() || text.contains('\0') || text.len() > 400 {
                    continue;
                }
                Some(text.to_string())
            }
            _ => None,
        };
        out.push(LayerAction {
            z_mm,
            kind: action.kind,
            note,
            gcode,
        });
    }
    out.sort_by(|a, b| {
        a.z_mm
            .partial_cmp(&b.z_mm)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    out
}

/// The firmware line for one layer action. Marlin and Prusa use `M601` / `M600`.
/// Klipper uses `PAUSE` / `M600`. Bambu and RepRapFirmware use `M400 U1`.
pub(super) fn action_line(action: &LayerAction, firmware: Option<Firmware>) -> Option<String> {
    let bambu = matches!(firmware, Some(Firmware::Bambu | Firmware::Rrf));
    let klipper = matches!(firmware, Some(Firmware::Klipper));
    let line = match action.kind {
        LayerActionKind::Pause if bambu => "M400 U1".to_string(),
        LayerActionKind::Pause if klipper => "PAUSE".to_string(),
        LayerActionKind::Pause => "M601".to_string(),
        LayerActionKind::FilamentChange if bambu => "M400 U1".to_string(),
        LayerActionKind::FilamentChange => "M600".to_string(),
        LayerActionKind::CustomGcode => action.gcode.clone()?,
    };
    Some(line)
}

/// Copy `layers` and attach each action to the closest layer within half a height.
/// An action's z is the reply's layer z, which on a belt is the belt position of
/// that layer and its copy, not the slice height.
pub(super) fn apply_layer_actions(
    layers: &[PlateLayer],
    actions: &[LayerAction],
    firmware: Option<Firmware>,
    belt: Option<&crate::belt::Belt>,
) -> Vec<PlateLayer> {
    let shown_z =
        |layer: &PlateLayer| belt.map_or(layer.z, |b| b.position(layer.z, layer.belt_shift));
    let mut owned = layers.to_vec();
    for action in actions {
        let Some(line) = action_line(action, firmware) else {
            continue;
        };
        let closest = owned.iter().enumerate().min_by(|(_, a), (_, b)| {
            (shown_z(a) - action.z_mm)
                .abs()
                .partial_cmp(&(shown_z(b) - action.z_mm).abs())
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let Some((idx, z, height)) =
            closest.map(|(idx, layer)| (idx, shown_z(layer), layer.height))
        else {
            continue;
        };
        let tol = (height * 0.5).max(0.02);
        if (z - action.z_mm).abs() > tol + 1e-6 {
            continue;
        }
        owned[idx].actions.push(LayerCue {
            line,
            note: action.note.clone(),
        });
    }
    owned
}

/// `None` when every bridge field is off, so overhang splitting is unchanged.
pub(super) fn bridge_tune(settings: &SliceSettings) -> Option<BridgeTune> {
    let flow = settings.bridge_flow_ratio.and_then(|ratio| {
        let ratio = ratio.clamp(0.2, 2.0);
        ((ratio - 1.0).abs() >= 1e-9).then_some(ratio)
    });
    let speed_mm_s = settings
        .bridge_speed_mm_s
        .and_then(|mm| (mm > 1e-6).then_some(mm.clamp(5.0, 200.0)));
    let fan_pwm = settings
        .bridge_fan_percent
        .and_then(|pct| (pct > 0).then_some(fan_pwm(pct)));
    if flow.is_none() && speed_mm_s.is_none() && fan_pwm.is_none() {
        None
    } else {
        Some(BridgeTune {
            flow,
            speed_mm_s,
            fan_pwm,
        })
    }
}

pub(super) fn default_scarf_length() -> f64 {
    10.0
}

pub(super) fn default_scarf_steps() -> u32 {
    8
}

pub(super) fn default_scarf_height() -> f64 {
    0.15
}

pub(super) fn default_scarf_flow() -> f64 {
    0.55
}
