use std::time::Instant;

use base64::Engine;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::contour::{loop_bounds, slice_contours, Loop};
use crate::gcode::{emit_gcode, LayerPaths};
use crate::load::load_mesh;
use crate::mesh::Mesh;
use crate::strategy::{layer_weight, mix, pure, Axis, BlendMode, PrinterProfile, StrategyId};
use crate::toolpath::{clip_to_rect, plan_region, plan_skirt, Extrusion, PathKind};

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
    pub note: String,
    pub speed_walls: u32,
    pub toughness_walls: u32,
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
    let layer_height = req.layer_height.clamp(0.05, 0.6);
    let line_width = req.line_width.clamp(0.15, 1.2);
    slice_with_baseline(&mesh, &req.blend, &profile, layer_height, line_width)
}

pub fn slice_with_baseline(
    mesh: &Mesh,
    blend: &BlendMode,
    profile: &PrinterProfile,
    layer_height: f64,
    line_width: f64,
) -> Result<SliceResponse, String> {
    let (min, max) = mesh.bounds().ok_or("empty mesh")?;
    let started = Instant::now();
    let planned = plan(mesh, blend, layer_height, line_width)?;
    let gcode = emit_gcode(&planned, profile, blend, layer_height, line_width);
    let core_ms = elapsed_ms(started);

    let baseline_mode = BlendMode::Single {
        strategy: StrategyId::Speed,
    };
    let baseline_started = Instant::now();
    let baseline_planned = plan(mesh, &baseline_mode, layer_height, line_width)?;
    let _baseline_gcode = emit_gcode(
        &baseline_planned,
        profile,
        &baseline_mode,
        layer_height,
        line_width,
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
                note: layer.note.clone(),
                speed_walls,
                toughness_walls,
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
    paths: Vec<Extrusion>,
    note: String,
}

fn plan(
    mesh: &Mesh,
    blend: &BlendMode,
    layer_height: f64,
    line_width: f64,
) -> Result<Vec<LayerPaths>, String> {
    let (min, max) = mesh.bounds().ok_or("empty mesh")?;
    if max[2] < layer_height * 0.5 {
        return Err("mesh is flatter than one layer".into());
    }
    let mut zs = Vec::new();
    let mut z = layer_height;
    let mut index = 0usize;
    while z <= max[2] + 1e-6 {
        zs.push((index, z));
        index += 1;
        z += layer_height;
        if index > 20000 {
            return Err("layer count exceeded 20000".into());
        }
    }
    let jobs: Vec<Job> = zs
        .par_iter()
        .map(|&(index, z)| {
            let contours = slice_contours(mesh, z);
            build_layer(index, z, &contours, blend, line_width, min, max)
        })
        .collect();
    Ok(jobs
        .into_iter()
        .map(|job| LayerPaths {
            index: job.index,
            z: job.z,
            paths: job.paths,
            note: job.note,
        })
        .collect())
}

fn build_layer(
    index: usize,
    z: f64,
    contours: &[Loop],
    blend: &BlendMode,
    line_width: f64,
    min: [f64; 3],
    max: [f64; 3],
) -> Job {
    if contours.is_empty() {
        return Job {
            index,
            z,
            paths: Vec::new(),
            note: "empty".into(),
        };
    }
    let mut paths = Vec::new();
    let note;
    match blend {
        BlendMode::ByRegion { axis, at_mm } => {
            let (low_rect, high_rect) = split_rects(*axis, *at_mm, min, max, contours);
            let tough = pure(StrategyId::Toughness);
            let speed = pure(StrategyId::Speed);
            let low = clip_to_rect(contours, low_rect.0, low_rect.1);
            let high = clip_to_rect(contours, high_rect.0, high_rect.1);
            let skirt_src = if index == 0 {
                tough.skirt_loops.max(speed.skirt_loops)
            } else {
                0
            };
            if skirt_src > 0 {
                let mut skirt_strategy = tough.clone();
                skirt_strategy.skirt_loops = 1;
                paths.extend(plan_skirt(contours, &skirt_strategy, line_width));
            }
            let mut hint = [min[0], min[1]];
            paths.extend(plan_region(&low, &tough, line_width, &mut hint));
            paths.extend(plan_region(&high, &speed, line_width, &mut hint));
            note = format!("region low=toughness high=speed split {:.2}", at_mm);
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
            if index == 0 {
                paths.extend(plan_skirt(contours, &resolved, line_width));
            }
            let mut hint = [max[0], (min[1] + max[1]) * 0.5];
            paths.extend(plan_region(contours, &resolved, line_width, &mut hint));
            note = format!(
                "{} walls={} infill={:.0}% {} {:.0}mm/s",
                resolved.id.as_str(),
                resolved.walls,
                resolved.infill_density * 100.0,
                resolved.pattern.as_str(),
                resolved.print_speed
            );
        }
    }
    Job {
        index,
        z,
        paths,
        note,
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
