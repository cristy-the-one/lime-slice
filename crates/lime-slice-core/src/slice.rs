use std::time::Instant;

use base64::Engine;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::adaptive::{plan_bands, HeightOpts};
use crate::contour::{loop_bounds, slice_contours, Loop};
use crate::gcode::{emit_gcode, LayerPaths};
use crate::index::ZIndex;
use crate::load::load_mesh;
use crate::mesh::Mesh;
use crate::strategy::{
    classicize, layer_weight, mix, pure, support_density, support_interface_density, Axis,
    BlendMode, Gyroid3d, PrinterProfile, ResolvedStrategy, ScarfSeam, StrategyId, ZHopMode,
};
use crate::support::{build_supports, SupportOpts, SupportStyle};
use crate::toolpath::{
    apply_overhang, apply_scarf, apply_z_hop, boolean_union, clip_to_rect, offset_loops,
    optimize_travel, plan_region, plan_skirt, plan_support, plan_tree_support, seat_layer_start,
    Extrusion, PathFeatures, PathKind, ScarfParams, ShellBand,
};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SliceRequest {
    pub filename: String,
    pub data_b64: String,
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
    /// `grid` (default) or `tree`.
    #[serde(default)]
    pub support_style: String,
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
    pub spatial_index: bool,
    pub support_style: SupportStyle,
    pub support_height_mult: f64,
    pub infill_combine: bool,
    pub combing: bool,
    pub feature_speeds: bool,
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
            spatial_index: true,
            support_style: SupportStyle::Grid,
            support_height_mult: 1.0,
            infill_combine: true,
            combing: true,
            feature_speeds: true,
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
            spatial_index: !req.classic,
            support_style: if req.classic {
                SupportStyle::Grid
            } else {
                parse_support_style(&req.support_style)
            },
            support_height_mult: if req.classic {
                1.0
            } else {
                req.support_height_mult.clamp(0.0, 4.0)
            },
            infill_combine: req.infill_combine && !req.classic,
            combing: req.combing && !req.classic,
            feature_speeds: req.feature_speeds && !req.classic,
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
            format!(
                "supports {style} (angle {:.0}°, shaft ×{:.1})",
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
        format!("{layers}; {supports}; {combine}; {scarf}; {gyroid}; {hop}")
    }
}

fn parse_support_style(name: &str) -> SupportStyle {
    match name.trim().to_ascii_lowercase().as_str() {
        "tree" | "organic" => SupportStyle::Tree,
        _ => SupportStyle::Grid,
    }
}

fn default_layer() -> f64 {
    0.2
}
fn default_width() -> f64 {
    0.45
}

fn default_true() -> bool {
    true
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
    pub sanity: Sanity,
    pub gcode: String,
    pub layers: Vec<PreviewLayer>,
    pub blend: String,
    pub estimate: PrintEstimate,
    pub score: BlendScore,
    /// Real slices of the same mesh: speed, efficiency (weight 0.5), toughness, classic.
    /// Empty unless the request set `compare`.
    #[serde(default)]
    pub compare: Vec<CompareEstimate>,
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
    pub triangles: usize,
    pub min: [f64; 3],
    pub max: [f64; 3],
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
    pub paths: Vec<PreviewPath>,
}

#[derive(Clone, Debug, Serialize)]
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
}

/// Milliseconds to contour every layer with the Z index, then with a full triangle scan.
pub fn contour_times(mesh: &Mesh, layer_height: f64) -> Result<(f64, f64), String> {
    let (_, max) = mesh.bounds().ok_or("empty mesh")?;
    let mut zs = Vec::new();
    let mut z = layer_height;
    while z < max[2] + 1e-6 {
        zs.push(z);
        z += layer_height;
    }
    let index = ZIndex::build(mesh);
    let started = Instant::now();
    let indexed: Vec<_> = zs.par_iter().map(|z| index.slice(*z)).collect();
    let indexed_ms = elapsed_ms(started);
    let started = Instant::now();
    let scanned: Vec<_> = zs.iter().map(|z| slice_contours(mesh, *z)).collect();
    let scanned_ms = elapsed_ms(started);
    debug_assert_eq!(indexed.len(), scanned.len());
    Ok((indexed_ms, scanned_ms))
}

pub fn slice_request(req: &SliceRequest) -> Result<SliceResponse, String> {
    if crate::cancel::poll() {
        return Err("cancelled".into());
    }
    let bytes = decode_b64(&req.data_b64)?;
    let mesh = load_mesh(&req.filename, &bytes)?;
    let profile = req.printer.clone().unwrap_or_default();
    let settings = SliceSettings::from_request(req);
    slice_configured(&mesh, &req.blend, &profile, &settings)
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
    let (min, max) = mesh.bounds().ok_or("empty mesh")?;
    let layer_height = settings.layer_height.clamp(0.05, 0.6);
    let line_width = settings.line_width.clamp(0.15, 1.2);
    let mut settings = SliceSettings {
        layer_height,
        line_width,
        ..settings.clone()
    };
    if settings.classic {
        settings.variable_width = false;
        settings.arc_fit = false;
        settings.travel_opt = false;
        settings.overhang_control = false;
        settings.spatial_index = false;
        settings.infill_combine = false;
        settings.combing = false;
        settings.feature_speeds = false;
        settings.scarf_seam = ScarfSeam::Off;
        settings.gyroid_3d = Gyroid3d::Off;
        settings.z_hop = ZHopMode::Off;
        settings.support_style = SupportStyle::Grid;
        settings.support_height_mult = 1.0;
    }
    let features = settings.feature_note();
    let mut profile = profile.clone();
    if settings.classic {
        profile.max_volumetric_mm3_s = f64::INFINITY;
        profile.pressure_advance = 0.0;
        profile.linear_advance = 0.0;
    }
    let started = Instant::now();
    let planned = plan(mesh, blend, &settings, profile.nozzle_diameter)?;
    let gcode = emit_gcode(
        &planned,
        &profile,
        blend,
        layer_height,
        line_width,
        &features,
        settings.arc_fit,
    );
    if gcode.cancelled || crate::cancel::poll() {
        return Err("cancelled".into());
    }
    let core_ms = elapsed_ms(started);

    let (baseline_ms, baseline_label) = if settings.baseline {
        let baseline_mode = BlendMode::Single {
            strategy: StrategyId::Speed,
        };
        let baseline_started = Instant::now();
        let baseline_planned = plan(mesh, &baseline_mode, &settings, profile.nozzle_diameter)?;
        let _baseline_gcode = emit_gcode(
            &baseline_planned,
            &profile,
            &baseline_mode,
            layer_height,
            line_width,
            &features,
            settings.arc_fit,
        );
        (
            elapsed_ms(baseline_started),
            "single-strategy speed (same mesh, layer height, and line width)".into(),
        )
    } else {
        (0.0, "skipped".into())
    };
    let compare = if settings.compare {
        compare_estimates(mesh, &settings, &profile, layer_height, line_width)?
    } else {
        Vec::new()
    };
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
    if gcode.min_x < min[0] - margin || gcode.max_x > max[0] + margin {
        notes.push(format!(
            "X bounds {:.2}..{:.2} outside mesh {:.2}..{:.2} ± {margin}",
            gcode.min_x, gcode.max_x, min[0], max[0]
        ));
    }
    if gcode.min_y < min[1] - margin || gcode.max_y > max[1] + margin {
        notes.push(format!(
            "Y bounds {:.2}..{:.2} outside mesh {:.2}..{:.2} ± {margin}",
            gcode.min_y, gcode.max_y, min[1], max[1]
        ));
    }
    if !gcode.text.contains(";LAYER:") {
        notes.push("g-code is missing layer markers".into());
    }

    let layers = preview_of(&planned, &profile, blend, &gcode.layer_seconds);
    Ok(SliceResponse {
        core_ms,
        baseline_ms,
        baseline_label,
        mesh: MeshInfo {
            triangles: mesh.triangle_count(),
            min,
            max,
        },
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
        gcode: gcode.text,
        layers,
        blend: blend.describe(),
        estimate: {
            let (scarfed_loops, mean_scarf_mm, max_seam_z_step_mm) = seam_metrics(&planned);
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
            structural_mm3(&planned),
        ),
        compare,
    })
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
    layer_height: f64,
    line_width: f64,
) -> Result<Vec<CompareEstimate>, String> {
    let mut quiet = settings.clone();
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
            one.spatial_index = false;
            one.infill_combine = false;
            one.combing = false;
            one.feature_speeds = false;
            one.scarf_seam = ScarfSeam::Off;
            one.support_style = SupportStyle::Grid;
            one.support_height_mult = 1.0;
        }
        let response = slice_configured(mesh, &blend, profile, &one)?;
        out.push(CompareEstimate {
            label: label.into(),
            seconds: response.estimate.seconds,
            filament_g: response.estimate.filament_g,
            by_feature: response.estimate.by_feature,
        });
    }
    let _ = (layer_height, line_width);
    Ok(out)
}

fn score_of(seconds: f64, grams: f64, toughness: f64) -> BlendScore {
    BlendScore {
        speed: 60.0 / (seconds / 60.0).max(0.05),
        efficiency: 8.0 / grams.max(0.02),
        toughness,
    }
}

fn structural_mm3(layers: &[LayerPaths]) -> f64 {
    layers
        .iter()
        .map(|layer| {
            layer
                .paths
                .iter()
                .map(|path| {
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

fn preview_of(
    layers: &[LayerPaths],
    profile: &PrinterProfile,
    blend: &BlendMode,
    layer_seconds: &[f64],
) -> Vec<PreviewLayer> {
    layers
        .iter()
        .filter(|l| !l.paths.is_empty())
        .enumerate()
        .map(|(emitted, layer)| {
            let mut paths = Vec::new();
            let mut cursor: Option<[f64; 2]> = None;
            let mut speed_walls = 0u32;
            let mut toughness_walls = 0u32;
            for path in &layer.paths {
                if path.kind.is_wall() {
                    match path.strategy {
                        StrategyId::Speed => speed_walls += 1,
                        StrategyId::Toughness => toughness_walls += 1,
                    }
                }
                if let (Some(c), Some(start)) = (cursor, path.points.first()) {
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
                });
                cursor = path.points.last().copied();
            }
            PreviewLayer {
                index: layer.index,
                z: layer.z,
                height: layer.height,
                note: layer.note.clone(),
                speed_walls,
                toughness_walls,
                support_paths: layer
                    .paths
                    .iter()
                    .filter(|p| p.kind == PathKind::Support || p.kind == PathKind::SupportInterface)
                    .count() as u32,
                seconds: layer_seconds.get(emitted).copied().unwrap_or(0.0),
                paths,
            }
        })
        .collect()
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

fn seam_metrics(layers: &[LayerPaths]) -> (usize, f64, f64) {
    let mut n = 0usize;
    let mut sum = 0.0;
    let mut max_step = 0.0f64;
    for layer in layers {
        for path in &layer.paths {
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

struct Job {
    index: usize,
    z: f64,
    height: f64,
    paths: Vec<Extrusion>,
    note: String,
}

fn plan(
    mesh: &Mesh,
    blend: &BlendMode,
    settings: &SliceSettings,
    nozzle_diameter: f64,
) -> Result<Vec<LayerPaths>, String> {
    let (min, max) = mesh.bounds().ok_or("empty mesh")?;
    let max_h = if settings.adaptive {
        settings.adaptive_max.max(settings.adaptive_min)
    } else {
        settings.layer_height
    };
    let bands = plan_bands(
        mesh,
        &HeightOpts {
            nominal: settings.layer_height,
            adaptive: settings.adaptive,
            min_h: settings.adaptive_min,
            max_h,
        },
    )?;
    let index = if settings.spatial_index {
        Some(ZIndex::build(mesh))
    } else {
        None
    };
    let contours: Vec<Vec<Loop>> = bands
        .par_iter()
        .map(|band| match &index {
            Some(index) => index.slice(band.z),
            None => slice_contours(mesh, band.z),
        })
        .collect();
    let roofs = roof_distances(&bands, &contours);
    let supports = if settings.supports {
        build_supports(
            &bands,
            &contours,
            &SupportOpts {
                angle_deg: settings.support_angle,
                z_gap: settings.layer_height.max(0.12),
                style: settings.support_style,
                ..SupportOpts::default()
            },
        )
    } else {
        Vec::new()
    };
    let shaft = shaft_scales(&supports, settings.support_height_mult);
    let (remain_low, remain_high) = interior_remainings(blend, settings, &bands, &roofs);
    let jobs: Vec<Job> = bands
        .par_iter()
        .enumerate()
        .map(|(i, band)| {
            let support = supports.get(i);
            let mut job = build_layer(
                band.index,
                band.z,
                band.height,
                &contours[i],
                support.map(|s| s.sparse.as_slice()).unwrap_or(&[]),
                support.map(|s| s.interface.as_slice()).unwrap_or(&[]),
                support.map(|s| s.branches.as_slice()).unwrap_or(&[]),
                shaft.get(i).copied().unwrap_or(0.0),
                blend,
                settings,
                roofs[i],
                min,
                max,
                nozzle_diameter,
                remain_low[i],
                remain_high[i],
            );
            if settings.overhang_control && i > 0 {
                apply_overhang(
                    &mut job.paths,
                    &contours[i - 1],
                    band.height,
                    settings.line_width,
                );
            }
            if settings.travel_opt {
                optimize_travel(
                    &mut job.paths,
                    &contours[i],
                    settings.combing,
                    settings.line_width * 0.8,
                );
            }
            if settings.scarf_seam != ScarfSeam::Off {
                apply_scarf(
                    &mut job.paths,
                    &ScarfParams {
                        mode: settings.scarf_seam,
                        length: settings.scarf_length,
                        steps: settings.scarf_steps,
                        start_height: settings.scarf_start_height,
                        start_flow: settings.scarf_start_flow,
                        layer_index: band.index,
                    },
                );
            }
            job
        })
        .collect();
    let mut prev_top = false;
    let mut jobs = jobs;
    let mut layer_end: Option<[f64; 2]> = None;
    for (i, job) in jobs.iter_mut().enumerate() {
        if settings.travel_opt {
            layer_end = seat_layer_start(
                &mut job.paths,
                &contours[i],
                settings.combing,
                settings.line_width * 0.8,
                layer_end,
            );
        }
        let infill = offset_loops(&contours[i], -settings.line_width * 2.2);
        apply_z_hop(
            &mut job.paths,
            &contours[i],
            &infill,
            settings.z_hop,
            settings.z_hop_height,
            settings.z_hop_min_travel,
            prev_top,
        );
        prev_top = job.paths.iter().any(|p| p.kind == PathKind::Top);
    }
    Ok(jobs
        .into_iter()
        .map(|job| LayerPaths {
            index: job.index,
            z: job.z,
            height: job.height,
            paths: job.paths,
            note: job.note,
        })
        .collect())
}

fn roof_distances(bands: &[crate::adaptive::LayerBand], contours: &[Vec<Loop>]) -> Vec<f64> {
    let n = bands.len();
    let mut dist = vec![0.0; n];
    let mut since = 0.0;
    for i in (0..n).rev() {
        let roof = i + 1 >= n
            || layer_is_roof(
                &contours[i],
                contours.get(i + 1).map(Vec::as_slice).unwrap_or(&[]),
            );
        if roof {
            since = 0.0;
        }
        dist[i] = since;
        since += bands[i].height;
    }
    dist
}

fn layer_is_roof(current: &[Loop], above: &[Loop]) -> bool {
    if current.is_empty() {
        return false;
    }
    if above.is_empty() {
        return true;
    }
    let Some((min, max)) = loop_bounds(current) else {
        return false;
    };
    let step = ((max[0] - min[0]).max(max[1] - min[1]) / 8.0).clamp(1.0, 4.0);
    let mut exposed = 0;
    let mut y = min[1] + step * 0.5;
    while y < max[1] {
        let mut x = min[0] + step * 0.5;
        while x < max[0] {
            if crate::contour::in_solid(current, x, y) && !crate::contour::in_solid(above, x, y) {
                exposed += 1;
                if exposed >= 2 {
                    return true;
                }
            }
            x += step;
        }
        y += step;
    }
    false
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
    if !settings.classic {
        match settings.gyroid_3d {
            Gyroid3d::Off => strategy.gyroid_3d = false,
            Gyroid3d::Blend => {}
            Gyroid3d::On => {
                strategy.pattern = crate::strategy::InfillPattern::Gyroid;
                strategy.gyroid_3d = true;
                strategy.lightning_range_mm = 0.0;
                strategy.infill_combine = 1;
            }
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

fn shell_of(z: f64, roof: f64, strategy: &ResolvedStrategy) -> ShellBand {
    let bottom = if strategy.toughness > 0.6 { 1.2 } else { 0.6 };
    let top = if strategy.toughness > 0.6 { 1.0 } else { 0.6 };
    if z <= bottom + 1e-6 {
        ShellBand::Bottom
    } else if roof <= top {
        ShellBand::Top
    } else {
        ShellBand::Interior
    }
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
            .map(|s| !s.sparse.is_empty() || !s.branches.is_empty())
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
    roofs: &[f64],
) -> (Vec<InteriorSpan>, Vec<InteriorSpan>) {
    let shells_for = |pick: &dyn Fn(f64) -> ResolvedStrategy| -> Vec<ShellBand> {
        bands
            .iter()
            .zip(roofs.iter())
            .map(|(b, r)| shell_of(b.z, *r, &pick(b.z)))
            .collect()
    };
    match blend {
        BlendMode::ByRegion { .. } => {
            let low = shells_for(&|_| resolve(pure(StrategyId::Toughness), settings));
            let high = shells_for(&|_| resolve(pure(StrategyId::Speed), settings));
            (remaining_interior(&low), remaining_interior(&high))
        }
        other => {
            let low = shells_for(&|z| resolve(strategy_at(other, z), settings));
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

/// One outer bead on the region cut. The low side snaps onto the plane; the high side drops its copy.
fn merge_split_outers(
    low: &mut [Extrusion],
    high: &mut Vec<Extrusion>,
    axis: Axis,
    at: f64,
    line_width: f64,
) {
    let tol = line_width * 0.8;
    snap_cut(low, axis, at, tol, true);
    snap_cut(high, axis, at, tol, false);
    high.retain(|p| p.points.len() >= 2);
}

fn snap_cut(paths: &mut [Extrusion], axis: Axis, at: f64, tol: f64, keep: bool) {
    for path in paths.iter_mut() {
        if !matches!(path.kind, PathKind::Outer | PathKind::Wall) {
            continue;
        }
        let closed = path.points.len() >= 2 && {
            let a = path.points[0];
            let b = *path.points.last().unwrap();
            let dx = a[0] - b[0];
            let dy = a[1] - b[1];
            dx * dx + dy * dy < 1e-8
        };
        let body: Vec<[f64; 2]> = if closed {
            path.points[..path.points.len() - 1].to_vec()
        } else {
            path.points.clone()
        };
        let flags: Vec<bool> = body
            .iter()
            .copied()
            .map(|p| on_plane(p, axis, at, tol))
            .collect();
        if !flags.iter().any(|f| *f) {
            continue;
        }
        if keep {
            let mut snapped = body;
            for (p, f) in snapped.iter_mut().zip(&flags) {
                if *f {
                    match axis {
                        Axis::X => p[0] = at,
                        Axis::Y => p[1] = at,
                    }
                }
            }
            if closed {
                let first = snapped[0];
                snapped.push(first);
            }
            path.points = snapped;
        } else {
            path.points = body
                .into_iter()
                .zip(flags)
                .filter(|(_, on)| !on)
                .map(|(p, _)| p)
                .collect();
        }
    }
}

fn on_plane(p: [f64; 2], axis: Axis, at: f64, tol: f64) -> bool {
    let d = match axis {
        Axis::X => (p[0] - at).abs(),
        Axis::Y => (p[1] - at).abs(),
    };
    d <= tol
}

#[allow(clippy::too_many_arguments)]
fn build_layer(
    index: usize,
    z: f64,
    height: f64,
    contours: &[Loop],
    support: &[Loop],
    interface: &[Loop],
    branches: &[[f64; 2]],
    shaft_scale: f64,
    blend: &BlendMode,
    settings: &SliceSettings,
    roof_distance: f64,
    min: [f64; 3],
    max: [f64; 3],
    nozzle_diameter: f64,
    remain_low: (u32, u32),
    remain_high: (u32, u32),
) -> Job {
    let line_width = settings.line_width;
    let features = PathFeatures {
        variable_width: settings.variable_width,
        roof_distance_mm: roof_distance,
        layer_index: index,
        layer_height: height,
        shell: ShellBand::Interior,
        z,
        nozzle_diameter,
        interior_remaining: remain_low.0,
        interior_run: remain_low.1,
    };
    if contours.is_empty() && support.is_empty() && interface.is_empty() && branches.is_empty() {
        return Job {
            index,
            z,
            height,
            paths: Vec::new(),
            note: "empty".into(),
        };
    }
    let mut paths = Vec::new();
    let skirt_src = if index == 0 {
        boolean_union(contours, &boolean_union(support, interface))
    } else {
        Vec::new()
    };
    let note = match blend {
        BlendMode::ByRegion { axis, at_mm } => {
            let (low_rect, high_rect) = split_rects(*axis, *at_mm, min, max, contours);
            let tough = resolve(pure(StrategyId::Toughness), settings);
            let speed = resolve(pure(StrategyId::Speed), settings);
            let low = clip_to_rect(contours, low_rect.0, low_rect.1);
            let high = clip_to_rect(contours, high_rect.0, high_rect.1);
            if index == 0 && !skirt_src.is_empty() {
                let mut skirt_strategy = tough.clone();
                skirt_strategy.skirt_loops = 1;
                paths.extend(plan_skirt(&skirt_src, &skirt_strategy, line_width));
            }
            emit_supports(
                &mut paths,
                support,
                interface,
                branches,
                shaft_scale,
                height,
                &tough,
                &speed,
                Some((low_rect, high_rect)),
                line_width,
            );
            let mut hint = [min[0], min[1]];
            let mut low_feat = features.clone();
            low_feat.shell = shell_of(z, roof_distance, &tough);
            low_feat.interior_remaining = remain_low.0;
            low_feat.interior_run = remain_low.1;
            let mut high_feat = features.clone();
            high_feat.shell = shell_of(z, roof_distance, &speed);
            high_feat.interior_remaining = remain_high.0;
            high_feat.interior_run = remain_high.1;
            let mut low_paths = plan_region(&low, &tough, line_width, &mut hint, &low_feat);
            let mut high_paths = plan_region(&high, &speed, line_width, &mut hint, &high_feat);
            merge_split_outers(&mut low_paths, &mut high_paths, *axis, *at_mm, line_width);
            paths.extend(low_paths);
            paths.extend(high_paths);
            format!("region low=toughness high=speed split {at_mm:.2} h={height:.3}")
        }
        other => {
            let resolved = resolve(
                match other {
                    BlendMode::Single { strategy } => pure(*strategy),
                    BlendMode::Weight { toughness } => mix(*toughness),
                    BlendMode::ByLayer {
                        bottom_mm,
                        transition_mm,
                    } => mix(layer_weight(z, *bottom_mm, *transition_mm)),
                    BlendMode::ByRegion { .. } => unreachable!(),
                },
                settings,
            );
            if index == 0 && !skirt_src.is_empty() {
                paths.extend(plan_skirt(&skirt_src, &resolved, line_width));
            }
            emit_supports(
                &mut paths,
                support,
                interface,
                branches,
                shaft_scale,
                height,
                &resolved,
                &resolved,
                None,
                line_width,
            );
            let mut hint = [max[0], (min[1] + max[1]) * 0.5];
            let mut feat = features.clone();
            feat.shell = shell_of(z, roof_distance, &resolved);
            feat.interior_remaining = remain_low.0;
            feat.interior_run = remain_low.1;
            paths.extend(plan_region(
                contours, &resolved, line_width, &mut hint, &feat,
            ));
            format!(
                "{} walls={} infill={:.0}% {} {:.0}mm/s h={:.3}",
                resolved.id.as_str(),
                resolved.walls,
                resolved.infill_density * 100.0,
                pattern_label(&resolved),
                resolved.print_speed,
                height
            )
        }
    };
    Job {
        index,
        z,
        height,
        paths,
        note,
    }
}

type XyRect = ([f64; 2], [f64; 2]);
type RegionSplit = (XyRect, XyRect);

#[allow(clippy::too_many_arguments)]
fn emit_supports(
    paths: &mut Vec<Extrusion>,
    support: &[Loop],
    interface: &[Loop],
    branches: &[[f64; 2]],
    shaft_scale: f64,
    layer_height: f64,
    low: &ResolvedStrategy,
    high: &ResolvedStrategy,
    split: Option<RegionSplit>,
    line_width: f64,
) {
    if support.is_empty() && interface.is_empty() && branches.is_empty() {
        return;
    }
    let paint = |paths: &mut Vec<Extrusion>,
                 region_s: &[Loop],
                 region_i: &[Loop],
                 centers: &[[f64; 2]],
                 strategy: &ResolvedStrategy| {
        if shaft_scale > 0.0 {
            let mut sparse = if centers.is_empty() {
                plan_support(
                    region_s,
                    strategy,
                    line_width,
                    support_density(strategy),
                    false,
                )
            } else {
                plan_tree_support(centers, strategy, line_width)
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
        let low_c: Vec<[f64; 2]> = centers_in(branches, low_rect.0, low_rect.1);
        let high_c: Vec<[f64; 2]> = centers_in(branches, high_rect.0, high_rect.1);
        paint(
            paths,
            &clip_to_rect(support, low_rect.0, low_rect.1),
            &clip_to_rect(interface, low_rect.0, low_rect.1),
            &low_c,
            low,
        );
        paint(
            paths,
            &clip_to_rect(support, high_rect.0, high_rect.1),
            &clip_to_rect(interface, high_rect.0, high_rect.1),
            &high_c,
            high,
        );
    } else {
        paint(paths, support, interface, branches, low);
    }
}

fn centers_in(centers: &[[f64; 2]], min: [f64; 2], max: [f64; 2]) -> Vec<[f64; 2]> {
    centers
        .iter()
        .copied()
        .filter(|p| p[0] >= min[0] && p[0] < max[0] && p[1] >= min[1] && p[1] < max[1])
        .collect()
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

fn decode_b64(data: &str) -> Result<Vec<u8>, String> {
    let trimmed = data.trim();
    let payload = trimmed
        .split_once(',')
        .map(|(_, rest)| rest)
        .unwrap_or(trimmed);
    base64::engine::general_purpose::STANDARD
        .decode(payload.trim())
        .map_err(|e| format!("base64: {e}"))
}
