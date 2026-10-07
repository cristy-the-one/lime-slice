//! Arc fitting replaces runs of moves with G2/G3. It may smooth the path,
//! but every arc stays on the path the moves print without it.

use std::f64::consts::TAU;

use lime_slice_core::{slice_request, Job, SliceRequest};
use serde_json::json;

const SAMPLES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../samples/");

fn gcode(name: &str, arc_fit: bool) -> String {
    let bytes = std::fs::read(format!("{SAMPLES}{name}")).unwrap();
    let req: SliceRequest = serde_json::from_value(json!({
        "filename": name,
        "dataB64": base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes),
        "blend": {"mode": "single", "strategy": "speed"},
        "arcFit": arc_fit,
        "baseline": false,
        "compare": false,
        "includePreview": false,
        "includeGcode": true,
    }))
    .unwrap();
    slice_request(&req, Job::default()).unwrap().gcode
}

fn word(line: &str, axis: char) -> Option<f64> {
    line.split_whitespace()
        .find_map(|w| w.strip_prefix(axis)?.parse().ok())
}

/// Per layer: each extruding move as points along it. A line is its two
/// ends; an arc is sampled every 6 degrees of its sweep.
fn extruded(gcode: &str) -> Vec<Vec<Vec<[f64; 2]>>> {
    let (mut x, mut y) = (0.0, 0.0);
    let mut layers: Vec<Vec<Vec<[f64; 2]>>> = Vec::new();
    for line in gcode.lines() {
        if line.starts_with(";LAYER:") {
            layers.push(Vec::new());
            continue;
        }
        let arc = line.starts_with("G2 ") || line.starts_with("G3 ");
        if !(arc || line.starts_with("G1 ")) {
            continue;
        }
        let (nx, ny) = (word(line, 'X').unwrap_or(x), word(line, 'Y').unwrap_or(y));
        let moved = (nx, ny) != (x, y);
        if let (Some(layer), true, Some(_)) = (layers.last_mut(), moved, word(line, 'E')) {
            if arc {
                let (cx, cy) = (x + word(line, 'I').unwrap(), y + word(line, 'J').unwrap());
                let r = (x - cx).hypot(y - cy);
                let a0 = (y - cy).atan2(x - cx);
                let ccw = ((ny - cy).atan2(nx - cx) - a0).rem_euclid(TAU);
                let sweep = if line.starts_with("G3 ") {
                    ccw
                } else {
                    ccw - TAU
                };
                let n = ((sweep.abs() / 6f64.to_radians()).ceil() as usize).max(1);
                layer.push(
                    (0..=n)
                        .map(|k| {
                            let a = a0 + sweep * k as f64 / n as f64;
                            [cx + r * a.cos(), cy + r * a.sin()]
                        })
                        .collect(),
                );
            } else {
                layer.push(vec![[x, y], [nx, ny]]);
            }
        }
        (x, y) = (nx, ny);
    }
    layers
}

fn to_segment(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let len2 = dx * dx + dy * dy;
    let t = if len2 > 0.0 {
        (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2).clamp(0.0, 1.0)
    } else {
        0.0
    };
    (p[0] - a[0] - t * dx).hypot(p[1] - a[1] - t * dy)
}

#[test]
fn a_cube_skirt_stays_square_with_arcs_on() {
    let fitted = extruded(&gcode("calibration_cube_20mm.stl", true));
    let lines = extruded(&gcode("calibration_cube_20mm.stl", false));
    assert_eq!(fitted.len(), lines.len());
    // Half the 0.45 mm bead the request prints.
    let bead = 0.225;
    for (i, (arcs, plain)) in fitted.iter().zip(&lines).enumerate() {
        for path in arcs.iter().filter(|p| p.len() > 2) {
            for &p in path {
                let off = plain
                    .iter()
                    .map(|m| to_segment(p, m[0], m[1]))
                    .fold(f64::INFINITY, f64::min);
                assert!(
                    off <= bead,
                    "layer {i}: an arc passes {off:.3} mm from every move, at {p:?}"
                );
            }
        }
    }
}
