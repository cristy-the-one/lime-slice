//! Solid infill inside a thin-walled cover is a strip a few beads wide. Rows
//! across a strip make a turn every few millimetres and the head never reaches
//! its feed, so those strips print along their length instead.

use std::collections::BTreeMap;

use base64::Engine;
use lime_slice_core::{slice_request, Job, SliceRequest, SliceResponse};
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
    stl_text(&f)
}

/// `cover_stl` with its corners rounded to `radius`, so its walls bend and the
/// strips of solid between the perimeters change width along their length.
fn round_cover_stl(x: f64, y: f64, z: f64, wall: f64, radius: f64) -> String {
    let ring = |inset: f64| -> Vec<[f64; 2]> {
        let mut pts = Vec::new();
        for (corner, (cx, cy)) in [
            (0, (x - radius, y - radius)),
            (1, (radius, y - radius)),
            (2, (radius, radius)),
            (3, (x - radius, radius)),
        ] {
            for k in 0..=12 {
                let a = (corner as f64 * 90.0 + k as f64 * 7.5).to_radians();
                pts.push([
                    cx + (radius - inset) * a.cos(),
                    cy + (radius - inset) * a.sin(),
                ]);
            }
        }
        pts
    };
    let (outer, inner) = (ring(0.0), ring(wall));
    let at = |q: [f64; 2], h: f64| [q[0], q[1], h];
    let (middle, hi_z) = ([x / 2.0, y / 2.0], z - wall);
    let mut f: Vec<[P; 3]> = Vec::new();
    for k in 0..outer.len() {
        let n = (k + 1) % outer.len();
        let (o0, o1, i0, i1) = (outer[k], outer[n], inner[k], inner[n]);
        quad(&mut f, at(o0, 0.0), at(o1, 0.0), at(o1, z), at(o0, z));
        quad(&mut f, at(i1, 0.0), at(i0, 0.0), at(i0, hi_z), at(i1, hi_z));
        quad(&mut f, at(o0, 0.0), at(i0, 0.0), at(i1, 0.0), at(o1, 0.0));
        f.push([at(o0, z), at(o1, z), at(middle, z)]);
        f.push([at(i1, hi_z), at(i0, hi_z), at(middle, hi_z)]);
    }
    stl_text(&f)
}

fn stl_text(facets: &[[P; 3]]) -> String {
    let mut s = String::from("solid cover\n");
    for t in facets {
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

fn cover_reply(belt: bool, stl: &str) -> SliceResponse {
    let mut body = json!({
        "filename": "cover.stl",
        "dataB64": base64::engine::general_purpose::STANDARD.encode(stl),
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
    slice_request(&request, Job::default()).unwrap()
}

fn solid_infill(belt: bool) -> Solid {
    let reply = cover_reply(belt, &cover_stl(150.0, 300.0, 50.0, 3.0));
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

/// The G-code's moves that do not extrude, by the `; TYPE:` they come under:
/// count and length in mm.
struct Travels {
    by_kind: BTreeMap<String, (usize, f64)>,
    seconds: f64,
}

impl Travels {
    fn moves(&self) -> usize {
        self.by_kind.values().map(|v| v.0).sum()
    }
}

fn travels(belt: bool) -> Travels {
    let reply = cover_reply(belt, &round_cover_stl(150.0, 300.0, 50.0, 3.0, 30.0));
    let mut by_kind: BTreeMap<String, (usize, f64)> = BTreeMap::new();
    let (mut kind, mut x, mut y, mut e) = (String::new(), 0.0f64, 0.0f64, 0.0f64);
    let mut retracts = 0;
    for line in reply.gcode.lines() {
        if let Some(rest) = line.strip_prefix("; TYPE:") {
            kind = rest.trim().to_string();
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
            if word('X').is_none() && word('Y').is_none() {
                retracts += usize::from(ne < e);
            } else if ne <= e {
                let row = by_kind.entry(kind.clone()).or_default();
                row.0 += 1;
                row.1 += (nx - x).hypot(ny - y);
            }
            (x, y, e) = (nx, ny, ne);
        }
    }
    let seconds = reply
        .estimate
        .by_feature
        .iter()
        .find(|f| f.kind == "travel")
        .map_or(0.0, |f| f.seconds);
    let found = Travels { by_kind, seconds };
    println!(
        "belt {belt}: {} travel moves, {:.0} s travel, {retracts} retracts, {:.0} s and {:.1} g in all",
        found.moves(),
        found.seconds,
        reply.estimate.seconds,
        reply.estimate.filament_g
    );
    for (kind, (n, mm)) in &found.by_kind {
        println!("  {kind}: {n} moves, {:.1} m", mm / 1000.0);
    }
    found
}

#[test]
fn gap_fill_of_a_rounded_cover_prints_beside_its_solid() {
    // The gap fill beside the strips was ordered as a run of its own after
    // the solid, so it toured the whole cover: hops of 100 to 250 m between
    // corner beads, 96 m of travel on the flat cover.
    let tilted = travels(true);
    let flat = travels(false);
    let gap_fill_m = |t: &Travels| t.by_kind["GAP-FILL"].1 / 1000.0;
    assert!(
        gap_fill_m(&flat) <= 20.0 && gap_fill_m(&tilted) <= 25.0,
        "gap fill travels {:.1} m flat, {:.1} m on the belt",
        gap_fill_m(&flat),
        gap_fill_m(&tilted)
    );
    assert!(
        flat.seconds <= 1150.0,
        "flat cover: {:.0} s travelling, {} travel moves",
        flat.seconds,
        flat.moves()
    );
    assert!(
        tilted.seconds <= 1950.0,
        "belt cover: {:.0} s travelling, {} travel moves",
        tilted.seconds,
        tilted.moves()
    );
}
