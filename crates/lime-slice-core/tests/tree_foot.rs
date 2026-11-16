//! A tree's foot on a flat bed is a base its trunk stands on: filled, and
//! narrowing to the trunk so every support bead of the layers above it lies
//! on a support bead of the layer below.

use std::fs;
use std::path::PathBuf;

use base64::Engine;
use lime_slice_core::{slice_request, Job, SliceRequest};
use serde_json::json;

const LINE_WIDTH: f64 = 0.45;

/// The `bridge_span` sample at Speed with tree supports: one small tree on
/// a flat bed, whose own disk is under half as wide as its foot.
fn gcode() -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../samples/bridge_span.stl");
    let body = json!({
        "filename": "bridge_span.stl",
        "dataB64": base64::engine::general_purpose::STANDARD.encode(fs::read(path).unwrap()),
        "layerHeight": 0.2,
        "lineWidth": LINE_WIDTH,
        "blend": {"mode": "single", "strategy": "speed"},
        "supports": true,
        "supportStyle": "tree",
        "arcFit": false,
        "baseline": false,
        "compare": false,
        "includePreview": false,
        "includeGcode": true,
    });
    let req: SliceRequest = serde_json::from_value(body).unwrap();
    slice_request(&req, Job::default()).unwrap().gcode
}

/// Each layer's support beads (not interface) as segments, from layer 0.
fn support_beads(gcode: &str, layers: usize) -> Vec<Vec<[[f64; 2]; 2]>> {
    let mut out = vec![Vec::new(); layers];
    let (mut at, mut e, mut layer, mut kind) = ([0.0, 0.0], 0.0, None::<usize>, "");
    for line in gcode.lines() {
        if let Some(rest) = line.strip_prefix(";LAYER:") {
            layer = rest.split_whitespace().next().and_then(|n| n.parse().ok());
            continue;
        }
        if let Some(k) = line.strip_prefix("; TYPE:") {
            kind = k.trim();
            continue;
        }
        let code = line.split(';').next().unwrap_or("");
        if !["G0 ", "G1 "].iter().any(|g| code.starts_with(g)) {
            continue;
        }
        let word = |axis: char| {
            code.split_whitespace()
                .find_map(|t| t.strip_prefix(axis)?.parse::<f64>().ok())
        };
        let to = [word('X').unwrap_or(at[0]), word('Y').unwrap_or(at[1])];
        let ne = word('E').unwrap_or(e);
        if let Some(i) = layer.filter(|&i| i < layers) {
            if ne > e && kind == "SUPPORT" {
                out[i].push([at, to]);
            }
        }
        at = to;
        e = ne;
    }
    out
}

fn to_segment(p: [f64; 2], [a, b]: [[f64; 2]; 2]) -> f64 {
    let d = [b[0] - a[0], b[1] - a[1]];
    let l2 = d[0] * d[0] + d[1] * d[1];
    let t = if l2 > 0.0 {
        (((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / l2).clamp(0.0, 1.0)
    } else {
        0.0
    };
    (p[0] - a[0] - t * d[0]).hypot(p[1] - a[1] - t * d[1])
}

/// The farthest any point of `upper`'s beads lies from a bead of `lower`.
fn farthest(upper: &[[[f64; 2]; 2]], lower: &[[[f64; 2]; 2]]) -> f64 {
    let mut worst: f64 = 0.0;
    for &[a, b] in upper {
        let n = ((b[0] - a[0]).hypot(b[1] - a[1]) / 0.1).ceil().max(1.0) as usize;
        for k in 0..=n {
            let t = k as f64 / n as f64;
            let p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
            let near = lower
                .iter()
                .map(|&s| to_segment(p, s))
                .fold(f64::INFINITY, f64::min);
            worst = worst.max(near);
        }
    }
    worst
}

#[test]
fn trunk_stands_on_its_foot() {
    let gcode = gcode();
    // The foot and the layers it narrows over. The trunk above the taper is
    // the walk's own and is not this test's concern.
    let beads = support_beads(&gcode, 7);
    assert!(
        beads.iter().all(|l| !l.is_empty()),
        "every one of the first layers prints support"
    );
    // The foot is filled: a bead runs close round its centre, where a
    // hollow foot of two rings left about 1.1 mm of bare bed.
    let (lo, hi) = beads[0].iter().flatten().fold(
        ([f64::INFINITY; 2], [f64::NEG_INFINITY; 2]),
        |(lo, hi), p| {
            (
                [lo[0].min(p[0]), lo[1].min(p[1])],
                [hi[0].max(p[0]), hi[1].max(p[1])],
            )
        },
    );
    let centre = [(lo[0] + hi[0]) * 0.5, (lo[1] + hi[1]) * 0.5];
    let hole = farthest(&[[centre, centre]], &beads[0]);
    assert!(
        hole < 0.7,
        "the foot is hollow: {hole:.2} mm round its centre"
    );
    // Half a bead of overlap, with room for the polygon of a circle.
    let limit = LINE_WIDTH * 0.5 + 0.03;
    for i in 1..beads.len() {
        let off = farthest(&beads[i], &beads[i - 1]);
        assert!(
            off <= limit,
            "layer {i}: a support bead lies {off:.3} mm from any support bead of layer {}, over {limit:.3}",
            i - 1
        );
    }
}
