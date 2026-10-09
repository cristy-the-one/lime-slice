//! Infill density is the share of the infill region the lines cover, for
//! every pattern. A grid lays two sets of lines, so each set is half that
//! share. From 99% the infill is solid: one set of lines at a full line
//! width apart, turning a quarter each layer, with no crossing.

use std::collections::HashMap;

use base64::Engine;
use lime_slice_core::{slice_request, Job, SliceRequest};
use serde_json::{json, Value};

const LINE_WIDTH: f64 = 0.45;
const WALLS: u32 = 2;
/// The cube's side less the two walls on each side. The infill region.
const INNER: f64 = 20.0 - 2.0 * WALLS as f64 * LINE_WIDTH;

/// One extruded move: its feature, its two ends, and the filament it took.
struct Move {
    kind: String,
    a: [f64; 2],
    b: [f64; 2],
    filament: f64,
}

fn cube_gcode(extra: Value) -> String {
    let path = format!(
        "{}/../../samples/calibration_cube_20mm.stl",
        env!("CARGO_MANIFEST_DIR")
    );
    let stl = std::fs::read(path).unwrap();
    let mut body = json!({
        "filename": "calibration_cube_20mm.stl",
        "dataB64": base64::engine::general_purpose::STANDARD.encode(stl),
        "layerHeight": 0.2,
        "lineWidth": LINE_WIDTH,
        "blend": {"mode": "single", "strategy": "speed"},
        "walls": WALLS,
        "baseline": false,
        "compare": false,
        "supports": false,
        "includePreview": false,
        "includeGcode": true,
    });
    for (key, value) in extra.as_object().unwrap() {
        body[key] = value.clone();
    }
    let request: SliceRequest = serde_json::from_value(body).unwrap();
    slice_request(&request, Job::default()).unwrap().gcode
}

/// Every extruded move of each layer, with the layer's Z.
fn moves_by_layer(gcode: &str) -> Vec<(f64, Vec<Move>)> {
    let mut layers: Vec<(f64, Vec<Move>)> = Vec::new();
    let (mut x, mut y, mut e) = (0.0f64, 0.0f64, 0.0f64);
    let mut kind = String::new();
    for line in gcode.lines() {
        if let Some(rest) = line.strip_prefix(";LAYER:") {
            let z = rest.split("Z:").nth(1).unwrap().split_whitespace().next();
            layers.push((z.unwrap().parse().unwrap(), Vec::new()));
            continue;
        }
        if let Some(k) = line.strip_prefix("; TYPE:") {
            kind = k.trim().to_string();
            continue;
        }
        if !line.starts_with("G1") {
            continue;
        }
        let word = |c: char| {
            line.split_whitespace()
                .find_map(|w| w.strip_prefix(c).and_then(|v| v.parse::<f64>().ok()))
        };
        let (nx, ny, ne) = (
            word('X').unwrap_or(x),
            word('Y').unwrap_or(y),
            word('E').unwrap_or(e),
        );
        if ne > e && (word('X').is_some() || word('Y').is_some()) {
            if let Some((_, moves)) = layers.last_mut() {
                moves.push(Move {
                    kind: kind.clone(),
                    a: [x, y],
                    b: [nx, ny],
                    filament: ne - e,
                });
            }
        }
        (x, y, e) = (nx, ny, ne);
    }
    layers
}

fn length(m: &Move) -> f64 {
    (m.b[0] - m.a[0]).hypot(m.b[1] - m.a[1])
}

/// The layers well inside the cube, where no skin prints.
fn middle(layers: &[(f64, Vec<Move>)]) -> Vec<&Vec<Move>> {
    layers
        .iter()
        .filter(|(z, _)| *z > 5.0 && *z < 15.0)
        .map(|(_, moves)| moves)
        .collect()
}

/// What the infill covers of the region inside the walls, mean over the
/// middle layers: extruded length times line width over area.
fn coverage(layers: &[(f64, Vec<Move>)], kinds: &[&str]) -> f64 {
    let mid = middle(layers);
    assert!(mid.len() > 20, "{} middle layers", mid.len());
    let total: f64 = mid
        .iter()
        .flat_map(|moves| moves.iter())
        .filter(|m| kinds.contains(&m.kind.as_str()))
        .map(length)
        .sum();
    total * LINE_WIDTH / (INNER * INNER) / mid.len() as f64
}

/// Direction of a line in degrees, folded to 0..180.
fn direction(m: &Move) -> f64 {
    let d = (m.b[1] - m.a[1]).atan2(m.b[0] - m.a[0]).to_degrees();
    d.rem_euclid(180.0)
}

/// The directions long infill lines run in on one layer, in whole degrees.
/// The short hops that join one row to the next are not lines.
fn line_directions(moves: &[Move], kind: &str) -> Vec<i64> {
    let mut seen: Vec<i64> = moves
        .iter()
        .filter(|m| m.kind == kind && length(m) > 3.0)
        .map(|m| direction(m).round() as i64 % 180)
        .collect();
    seen.sort_unstable();
    seen.dedup();
    seen
}

#[test]
fn a_twenty_percent_grid_covers_a_fifth_of_the_inside() {
    // The object infill override turns the speed strategy's lightning into a grid.
    let gcode = cube_gcode(json!({"infill": 0.2, "infillCombine": false}));
    let layers = moves_by_layer(&gcode);
    let share = coverage(&layers, &["SPARSE"]);
    assert!(
        (0.17..=0.23).contains(&share),
        "20% grid covers {:.1}% of the inside",
        share * 100.0
    );
}

#[test]
fn a_full_infill_is_one_set_of_touching_lines_that_turns_each_layer() {
    let gcode = cube_gcode(json!({"infill": 1.0}));
    let layers = moves_by_layer(&gcode);
    let share = coverage(&layers, &["SOLID", "SPARSE"]);
    assert!(
        (0.93..=1.05).contains(&share),
        "100% infill covers {:.1}% of the inside",
        share * 100.0
    );
    let mid = middle(&layers);
    let mut turns = HashMap::new();
    for (i, moves) in mid.iter().enumerate() {
        let sparse = line_directions(moves, "SPARSE");
        assert!(
            sparse.is_empty(),
            "layer {i}: solid infill printed as sparse"
        );
        let dirs = line_directions(moves, "SOLID");
        assert_eq!(dirs.len(), 1, "layer {i}: lines cross, {dirs:?}");
        turns.insert(i, dirs[0]);
    }
    for i in 1..mid.len() {
        let turn = (turns[&i] - turns[&(i - 1)]).rem_euclid(180);
        assert_eq!(
            turn,
            90,
            "layer {i} runs {} after {}",
            turns[&i],
            turns[&(i - 1)]
        );
    }
}

#[test]
fn a_solid_cube_extrudes_about_its_volume() {
    let gcode = cube_gcode(json!({"infill": 1.0}));
    let layers = moves_by_layer(&gcode);
    let filament: f64 = layers
        .iter()
        .flat_map(|(_, moves)| moves.iter())
        .filter(|m| m.kind != "SKIRT")
        .map(|m| m.filament)
        .sum();
    let volume = filament * std::f64::consts::PI * 0.875 * 0.875;
    assert!(
        (7700.0..=8300.0).contains(&volume),
        "a 20 mm cube at 100% extrudes {volume:.0} mm3 without its skirt"
    );
}
