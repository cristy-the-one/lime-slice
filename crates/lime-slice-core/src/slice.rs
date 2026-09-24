use std::time::Instant;

use base64::Engine;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::adaptive::{plan_bands, HeightOpts};
use crate::contour::{loop_bounds, slice_contours, Loop};
use crate::gcode::{emit_gcode, LayerPaths};
use crate::load::load_mesh;
use crate::mesh::Mesh;
use crate::strategy::{
    layer_weight, mix, pure, support_density, support_interface_density, Axis, BlendMode,
    PrinterProfile, ResolvedStrategy, StrategyId,
};
use crate::support::{build_supports, SupportOpts};
use crate::toolpath::{
    boolean_union, clip_to_rect, plan_region, plan_skirt, plan_support, Extrusion, PathKind,
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
            format!("supports on (angle {:.0}°)", self.support_angle)
        } else {
            "supports off".into()
        };
        format!("{layers}; {supports}")
    }
}

fn default_layer() -> f64 {
    0.2
}
fn default_width() -> f64 {
    0.45
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
    pub paths: Vec<PreviewPath>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewPath {
    pub kind: String,
    pub strategy: String,
    pub pts: Vec<[f64; 2]>,
}

pub fn slice_request(req: &SliceRequest) -> Result<SliceResponse, String> {
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
    let settings = SliceSettings {
        layer_height,
        line_width,
        ..settings.clone()
    };
    let features = settings.feature_note();
    let started = Instant::now();
    let planned = plan(mesh, blend, &settings)?;
    let gcode = emit_gcode(
        &planned,
        profile,
        blend,
        layer_height,
        line_width,
        &features,
    );
    let core_ms = elapsed_ms(started);

    let baseline_mode = BlendMode::Single {
        strategy: StrategyId::Speed,
    };
    let baseline_started = Instant::now();
    let baseline_planned = plan(mesh, &baseline_mode, &settings)?;
    let _baseline_gcode = emit_gcode(
        &baseline_planned,
        profile,
        &baseline_mode,
        layer_height,
        line_width,
        &features,
    );
    let baseline_ms = elapsed_ms(baseline_started);

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

    let layers = preview_of(&planned);
    Ok(SliceResponse {
        core_ms,
        baseline_ms,
        baseline_label: "single-strategy speed (same mesh, layer height, and line width)".into(),
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
        },
        gcode: gcode.text,
        layers,
        blend: blend.describe(),
    })
}

fn preview_of(layers: &[LayerPaths]) -> Vec<PreviewLayer> {
    layers
        .iter()
        .filter(|l| !l.paths.is_empty())
        .map(|layer| {
            let mut paths = Vec::new();
            let mut cursor: Option<[f64; 2]> = None;
            let mut speed_walls = 0u32;
            let mut toughness_walls = 0u32;
            for path in &layer.paths {
                if path.kind == PathKind::Wall {
                    match path.strategy {
                        StrategyId::Speed => speed_walls += 1,
                        StrategyId::Toughness => toughness_walls += 1,
                    }
                }
                if let (Some(c), Some(start)) = (cursor, path.points.first()) {
                    if dist2(c, *start) > 0.05 * 0.05 {
                        paths.push(PreviewPath {
                            kind: "travel".into(),
                            strategy: path.strategy.as_str().into(),
                            pts: vec![c, *start],
                        });
                    }
                }
                paths.push(PreviewPath {
                    kind: path.kind.as_str().into(),
                    strategy: path.strategy.as_str().into(),
                    pts: decimate(&path.points),
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
                paths,
            }
        })
        .collect()
}

fn decimate(pts: &[[f64; 2]]) -> Vec<[f64; 2]> {
    if pts.len() <= 2 {
        return pts.to_vec();
    }
    let mut out = vec![pts[0]];
    for p in pts.iter().skip(1) {
        let last = *out.last().unwrap();
        if dist2(last, *p) >= 0.04 * 0.04 {
            out.push(*p);
        }
    }
    let end = *pts.last().unwrap();
    if dist2(*out.last().unwrap(), end) > 1e-8 {
        out.push(end);
    }
    out
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
    let contours: Vec<Vec<Loop>> = bands
        .par_iter()
        .map(|band| slice_contours(mesh, band.z))
        .collect();
    let supports = if settings.supports {
        build_supports(
            &bands,
            &contours,
            &SupportOpts {
                angle_deg: settings.support_angle,
                z_gap: settings.layer_height.max(0.12),
                ..SupportOpts::default()
            },
        )
    } else {
        Vec::new()
    };
    let jobs: Vec<Job> = bands
        .par_iter()
        .enumerate()
        .map(|(i, band)| {
            let support = supports.get(i);
            build_layer(
                band.index,
                band.z,
                band.height,
                &contours[i],
                support.map(|s| s.sparse.as_slice()).unwrap_or(&[]),
                support.map(|s| s.interface.as_slice()).unwrap_or(&[]),
                blend,
                settings.line_width,
                min,
                max,
            )
        })
        .collect();
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

fn build_layer(
    index: usize,
    z: f64,
    height: f64,
    contours: &[Loop],
    support: &[Loop],
    interface: &[Loop],
    blend: &BlendMode,
    line_width: f64,
    min: [f64; 3],
    max: [f64; 3],
) -> Job {
    if contours.is_empty() && support.is_empty() && interface.is_empty() {
        return Job {
            index,
            z,
            height,
            paths: Vec::new(),
            note: "empty".into(),
        };
    }
    let mut paths = Vec::new();
    let note;
    let skirt_src = if index == 0 {
        boolean_union(contours, &boolean_union(support, interface))
    } else {
        Vec::new()
    };
    match blend {
        BlendMode::ByRegion { axis, at_mm } => {
            let (low_rect, high_rect) = split_rects(*axis, *at_mm, min, max, contours);
            let tough = pure(StrategyId::Toughness);
            let speed = pure(StrategyId::Speed);
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
                &tough,
                &speed,
                Some((low_rect, high_rect)),
                line_width,
            );
            let mut hint = [min[0], min[1]];
            paths.extend(plan_region(&low, &tough, line_width, &mut hint));
            paths.extend(plan_region(&high, &speed, line_width, &mut hint));
            note = format!(
                "region low=toughness high=speed split {:.2} h={:.3}",
                at_mm, height
            );
        }
        other => {
            let resolved = match other {
                BlendMode::Single { strategy } => pure(*strategy),
                BlendMode::Weight { toughness } => mix(*toughness),
                BlendMode::ByLayer {
                    bottom_mm,
                    transition_mm,
                } => mix(layer_weight(z, *bottom_mm, *transition_mm)),
                BlendMode::ByRegion { .. } => unreachable!(),
            };
            if index == 0 && !skirt_src.is_empty() {
                paths.extend(plan_skirt(&skirt_src, &resolved, line_width));
            }
            emit_supports(
                &mut paths, support, interface, &resolved, &resolved, None, line_width,
            );
            let mut hint = [max[0], (min[1] + max[1]) * 0.5];
            paths.extend(plan_region(contours, &resolved, line_width, &mut hint));
            note = format!(
                "{} walls={} infill={:.0}% {} {:.0}mm/s h={:.3}",
                resolved.id.as_str(),
                resolved.walls,
                resolved.infill_density * 100.0,
                resolved.pattern.as_str(),
                resolved.print_speed,
                height
            );
        }
    }
    Job {
        index,
        z,
        height,
        paths,
        note,
    }
}

fn emit_supports(
    paths: &mut Vec<Extrusion>,
    support: &[Loop],
    interface: &[Loop],
    low: &ResolvedStrategy,
    high: &ResolvedStrategy,
    split: Option<(([f64; 2], [f64; 2]), ([f64; 2], [f64; 2]))>,
    line_width: f64,
) {
    if support.is_empty() && interface.is_empty() {
        return;
    }
    let paint = |paths: &mut Vec<Extrusion>,
                 region_s: &[Loop],
                 region_i: &[Loop],
                 strategy: &ResolvedStrategy| {
        paths.extend(plan_support(
            region_s,
            strategy,
            line_width,
            support_density(strategy),
            false,
        ));
        paths.extend(plan_support(
            region_i,
            strategy,
            line_width,
            support_interface_density(strategy),
            true,
        ));
    };
    if let Some((low_rect, high_rect)) = split {
        paint(
            paths,
            &clip_to_rect(support, low_rect.0, low_rect.1),
            &clip_to_rect(interface, low_rect.0, low_rect.1),
            low,
        );
        paint(
            paths,
            &clip_to_rect(support, high_rect.0, high_rect.1),
            &clip_to_rect(interface, high_rect.0, high_rect.1),
            high,
        );
    } else {
        paint(paths, support, interface, low);
    }
}

fn split_rects(
    axis: Axis,
    at: f64,
    min: [f64; 3],
    max: [f64; 3],
    contours: &[Loop],
) -> (([f64; 2], [f64; 2]), ([f64; 2], [f64; 2])) {
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
