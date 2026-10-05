//! Inside a closed part. Skin goes where a surface is open above or below,
//! not across the whole layer, so the inside prints as interior even on a
//! layer where some other feature has its roof or floor. And the infill
//! holding a roof up stands on something all the way down.

use std::collections::HashMap;

use base64::Engine;
use lime_slice_core::{slice_payload, Job};
use serde_json::{json, Value};

/// Triangles of the box from `lo` to `hi`, wound outward.
fn cuboid(lo: [f64; 3], hi: [f64; 3]) -> Vec<[[f64; 3]; 3]> {
    let c = |i: usize| {
        [
            if i & 1 == 0 { lo[0] } else { hi[0] },
            if i & 2 == 0 { lo[1] } else { hi[1] },
            if i & 4 == 0 { lo[2] } else { hi[2] },
        ]
    };
    // Each face as four corners counter-clockwise seen from outside.
    let faces = [
        [0, 2, 3, 1],
        [4, 5, 7, 6],
        [0, 1, 5, 4],
        [2, 6, 7, 3],
        [0, 4, 6, 2],
        [1, 3, 7, 5],
    ];
    faces
        .iter()
        .flat_map(|f| [[c(f[0]), c(f[1]), c(f[2])], [c(f[0]), c(f[2]), c(f[3])]])
        .collect()
}

fn stl_b64(tris: &[[[f64; 3]; 3]]) -> String {
    let mut out = String::from("solid parts\n");
    for t in tris {
        out.push_str(" facet normal 0 0 0\n  outer loop\n");
        for v in t {
            out.push_str(&format!("   vertex {} {} {}\n", v[0], v[1], v[2]));
        }
        out.push_str("  endloop\n endfacet\n");
    }
    out.push_str("endsolid parts\n");
    base64::engine::general_purpose::STANDARD.encode(out)
}

/// Extruded length of each feature on each layer, by layer Z.
fn lengths_by_layer(gcode: &str) -> Vec<(f64, HashMap<String, f64>)> {
    let mut layers: Vec<(f64, HashMap<String, f64>)> = Vec::new();
    let (mut x, mut y, mut e) = (0.0f64, 0.0f64, 0.0f64);
    let mut kind = String::new();
    for line in gcode.lines() {
        if let Some(rest) = line.strip_prefix(";LAYER:") {
            let z = rest
                .split("Z:")
                .nth(1)
                .unwrap()
                .split_whitespace()
                .next()
                .unwrap();
            layers.push((z.parse().unwrap(), HashMap::new()));
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
            if let Some((_, by)) = layers.last_mut() {
                *by.entry(kind.clone()).or_default() += (nx - x).hypot(ny - y);
            }
        }
        (x, y, e) = (nx, ny, ne);
    }
    layers
}

#[test]
fn a_side_block_roof_skins_only_the_side_block() {
    // A 20 mm cube with a 6 x 6 x 10 mm block against its +X side.
    let mut tris = cuboid([0.0, 0.0, 0.0], [20.0, 20.0, 20.0]);
    tris.extend(cuboid([19.0, 7.0, 0.0], [26.0, 13.0, 10.0]));
    let req = json!({
        "filename": "side_block.stl",
        "dataB64": stl_b64(&tris),
        "blend": {"mode": "single", "strategy": "speed"},
        "includeGcode": true,
        "includePreview": false,
        "baseline": false,
    });
    let reply: Value = serde_json::from_str(
        &slice_payload(&req.to_string(), None, Job::default(), |g| g.text()).unwrap(),
    )
    .unwrap();
    let layers = lengths_by_layer(reply["gcode"].as_str().unwrap());
    let get = |by: &HashMap<String, f64>, k: &str| by.get(k).copied().unwrap_or(0.0);
    // The side block's top skin runs from its roof at Z 10 down 0.6 mm.
    let under_roof: Vec<_> = layers
        .iter()
        .filter(|(z, _)| *z > 9.45 && *z < 10.05)
        .collect();
    assert!(!under_roof.is_empty());
    for (z, by) in under_roof {
        let top = get(by, "TOP");
        let sparse = get(by, "SPARSE");
        // The side block's 6 x 6 mm skin at 0.45 mm pitch is about 80 mm of
        // bead. The cube's 20 x 20 mm section would be about 800 mm more.
        assert!(top > 0.0, "z {z}: no top skin on the side block: {by:?}");
        assert!(
            top < 200.0,
            "z {z}: {top:.0} mm of top skin, the cube's inside is skinned: {by:?}"
        );
        assert!(
            sparse > 0.0,
            "z {z}: the cube's inside prints no sparse infill: {by:?}"
        );
    }
}

/// One extruded move: its feature and its two ends.
type Move = (String, [f64; 2], [f64; 2]);

/// Every extruded move of each layer, with the layer's Z.
fn segments_by_layer(gcode: &str) -> Vec<(f64, Vec<Move>)> {
    let mut layers: Vec<(f64, Vec<Move>)> = Vec::new();
    let (mut x, mut y, mut e) = (0.0f64, 0.0f64, 0.0f64);
    let mut kind = String::new();
    for line in gcode.lines() {
        if let Some(rest) = line.strip_prefix(";LAYER:") {
            let z = rest
                .split("Z:")
                .nth(1)
                .unwrap()
                .split_whitespace()
                .next()
                .unwrap();
            layers.push((z.parse().unwrap(), Vec::new()));
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
            if let Some((_, segs)) = layers.last_mut() {
                segs.push((kind.clone(), [x, y], [nx, ny]));
            }
        }
        (x, y, e) = (nx, ny, ne);
    }
    layers
}

fn to_segment(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let len2 = dx * dx + dy * dy;
    let t = if len2 < 1e-12 {
        0.0
    } else {
        (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2).clamp(0.0, 1.0)
    };
    (p[0] - a[0] - t * dx).hypot(p[1] - a[1] - t * dy)
}

#[test]
fn lightning_under_a_roof_stands_on_the_layer_below() {
    // A 20 mm cube at speed: lightning holds up its top skin. Every sparse
    // move must start and end within one line width of a bead on the layer
    // below, all the way down, so no band of it starts over the empty
    // inside. A straight move between two held ends is a short bridge.
    let req = json!({
        "filename": "cube.stl",
        "dataB64": stl_b64(&cuboid([0.0, 0.0, 0.0], [20.0, 20.0, 20.0])),
        "blend": {"mode": "single", "strategy": "speed"},
        "includeGcode": true,
        "includePreview": false,
        "baseline": false,
    });
    let reply: Value = serde_json::from_str(
        &slice_payload(&req.to_string(), None, Job::default(), |g| g.text()).unwrap(),
    )
    .unwrap();
    let layers = segments_by_layer(reply["gcode"].as_str().unwrap());
    let reach = 0.45;
    let mut sparse_layers = 0;
    for w in layers.windows(2) {
        let ((_, below), (z, here)) = (&w[0], &w[1]);
        let sparse: Vec<_> = here.iter().filter(|s| s.0 == "SPARSE").collect();
        if sparse.is_empty() {
            continue;
        }
        sparse_layers += 1;
        for (_, a, b) in sparse {
            for p in [*a, *b] {
                let held = below
                    .iter()
                    .map(|(_, c, d)| to_segment(p, *c, *d))
                    .fold(f64::MAX, f64::min);
                assert!(
                    held <= reach,
                    "z {z}: sparse bead at {p:?} is {held:.2} mm from anything on the layer below"
                );
            }
        }
    }
    assert!(sparse_layers > 0, "the cube printed no lightning");
}
