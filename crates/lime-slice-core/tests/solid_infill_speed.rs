//! Solid infill inside a thin-walled cover is a strip a few beads wide. Rows
//! across a strip make a turn every few millimetres and the head never reaches
//! its feed, so those strips print along their length instead.

use base64::Engine;
use lime_slice_core::{slice_request, Job, SliceRequest};
use serde_json::json;

type P = [f64; 3];

fn quad(out: &mut Vec<[P; 3]>, a: P, b: P, c: P, d: P) {
    out.push([a, b, c]);
    out.push([a, c, d]);
}

/// A box with a pocket open at the bottom: walls and a roof `wall` thick.
fn cover_stl(x: f64, y: f64, z: f64, wall: f64) -> String {
    let mut f: Vec<[P; 3]> = Vec::new();
    let (hi_x, hi_y, hi_z) = (x - wall, y - wall, z - wall);
    quad(&mut f, [0., 0., z], [x, 0., z], [x, y, z], [0., y, z]);
    for (x0, y0, x1, y1, z0, z1, out) in [
        (0.0, 0.0, x, y, 0.0, z, true),
        (wall, wall, hi_x, hi_y, 0.0, hi_z, false),
    ] {
        let sides = [
            ([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]),
            ([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]),
            ([x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]),
            ([x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]),
        ];
        for (a, b, c, d) in sides {
            if out {
                quad(&mut f, a, b, c, d);
            } else {
                quad(&mut f, d, c, b, a);
            }
        }
    }
    quad(
        &mut f,
        [wall, wall, hi_z],
        [wall, hi_y, hi_z],
        [hi_x, hi_y, hi_z],
        [hi_x, wall, hi_z],
    );
    let o = [[0., 0.], [x, 0.], [x, y], [0., y]];
    let i = [[wall, wall], [hi_x, wall], [hi_x, hi_y], [wall, hi_y]];
    for k in 0..4 {
        let n = (k + 1) % 4;
        let p = |q: [f64; 2]| [q[0], q[1], 0.0];
        quad(&mut f, p(o[k]), p(i[k]), p(i[n]), p(o[n]));
    }
    let mut s = String::from("solid cover\n");
    for t in f {
        s.push_str("facet normal 0 0 0\nouter loop\n");
        for v in t {
            s.push_str(&format!("vertex {} {} {}\n", v[0], v[1], v[2]));
        }
        s.push_str("endloop\nendfacet\n");
    }
    s.push_str("endsolid cover\n");
    s
}

/// What the solid infill did: the estimator's mean volumetric rate over all
/// layers, and the extruded solid moves (G-code columns) of the mid layers.
struct Solid {
    mm3_s: f64,
    mean_move_mm: f64,
}

fn solid_infill(belt: bool) -> Solid {
    let mut body = json!({
        "filename": "cover.stl",
        "dataB64": base64::engine::general_purpose::STANDARD.encode(cover_stl(150.0, 300.0, 50.0, 3.0)),
        "layerHeight": 0.2,
        "lineWidth": 0.45,
        "blend": {"mode": "single", "strategy": "speed"},
        "walls": 2,
        "infill": 1.0,
        "arcFit": false,
        "baseline": false,
        "compare": false,
        "supports": false,
        "includePreview": false,
        "includeGcode": true,
        "printer": {
            "name": "cover test",
            "nozzleDiameter": 0.4,
            "filamentDiameter": 1.75,
            "nozzleTemp": 215.0,
            "bedTemp": 60.0,
            "bedX": 250.0,
            "bedY": 250.0,
            "maxVolumetricMm3S": 12.0,
            "maxAccel": 7000.0,
        },
    });
    if belt {
        body["belt"] = json!({
            "angleDeg": 45.0, "axis": "z", "direction": 1, "widthMm": 250.0,
            "copies": 1, "gapMm": 5.0, "floorSupports": true,
        });
    }
    let request: SliceRequest = serde_json::from_value(body).unwrap();
    let reply = slice_request(&request, Job::default()).unwrap();
    // Cartesian mid layers are all wall strips. A belt layer cuts the walls
    // aslant, so every belt layer is.
    let (mut layer_z, mut solid) = (0.0, false);
    let (mut x, mut y, mut e) = (0.0f64, 0.0f64, 0.0f64);
    let (mut moves, mut length) = (0usize, 0.0);
    for line in reply.gcode.lines() {
        if let Some(rest) = line.strip_prefix(";LAYER:") {
            layer_z = rest
                .split("Z:")
                .nth(1)
                .unwrap()
                .split_whitespace()
                .next()
                .unwrap()
                .parse()
                .unwrap();
        } else if let Some(kind) = line.strip_prefix("; TYPE:") {
            solid = kind.trim() == "SOLID";
        } else if line.starts_with("G1") {
            let word = |c: char| {
                line.split_whitespace()
                    .find_map(|w| w.strip_prefix(c).and_then(|v| v.parse::<f64>().ok()))
            };
            let (nx, ny, ne) = (
                word('X').unwrap_or(x),
                word('Y').unwrap_or(y),
                word('E').unwrap_or(e),
            );
            let mid = belt || (10.0..40.0).contains(&layer_z);
            if solid && mid && ne > e && (word('X').is_some() || word('Y').is_some()) {
                moves += 1;
                length += (nx - x).hypot(ny - y);
            }
            (x, y, e) = (nx, ny, ne);
        }
    }
    let row = reply
        .estimate
        .by_feature
        .iter()
        .find(|f| f.kind == "solid")
        .unwrap();
    let volume = row.filament_mm * std::f64::consts::PI * 0.875f64.powi(2);
    let found = Solid {
        mm3_s: volume / row.seconds,
        mean_move_mm: length / moves as f64,
    };
    println!(
        "belt {belt}: solid {:.0} s, {:.1} cm3, {:.2} mm3/s, {moves} moves, mean {:.2} mm",
        row.seconds,
        volume / 1000.0,
        found.mm3_s,
        found.mean_move_mm
    );
    found
}

#[test]
fn solid_strips_of_a_cover_print_along_their_length() {
    let tilted = solid_infill(true);
    let flat = solid_infill(false);
    assert!(
        flat.mean_move_mm >= 20.0,
        "flat cover: mean solid move {:.2} mm, {:.2} mm3/s",
        flat.mean_move_mm,
        flat.mm3_s
    );
    assert!(
        tilted.mm3_s >= 8.0,
        "belt cover: {:.2} mm3/s, mean solid move {:.2} mm",
        tilted.mm3_s,
        tilted.mean_move_mm
    );
}
