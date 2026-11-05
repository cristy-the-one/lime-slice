//! Belt support anchors: a support line across the belt at the first and last
//! support foot and every `supportBeltAnchorMm` along the belt between them.
//!
//! `samples/belt_bridge.stl` is a deck 60 mm wide and 30 mm long standing on
//! two walls 15 mm above the belt, so its supports stand on the belt for
//! about 25 mm along it.

use std::fs;
use std::path::PathBuf;

use base64::Engine;
use lime_slice_core::{slice_request, Job, SliceRequest, SliceResponse};
use serde_json::{json, Value};

const STYLES: [&str; 2] = ["grid", "tree"];
const SAMPLE: &str = "belt_bridge.stl";

fn b64(name: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../samples")
        .join(name);
    base64::engine::general_purpose::STANDARD.encode(fs::read(path).unwrap())
}

/// The bridge with supports of `style` at a 60° overhang angle, on the belt
/// when `on_belt`, with `extra` request fields.
fn slice(style: &str, on_belt: bool, extra: Value) -> SliceResponse {
    let mut body = json!({
        "filename": SAMPLE,
        "dataB64": b64(SAMPLE),
        "layerHeight": 0.2,
        "lineWidth": 0.45,
        "blend": {"mode": "weight", "toughness": 0.3},
        "supports": true,
        "supportStyle": style,
        "supportAngle": 60,
        "arcFit": false,
        "baseline": false,
        "compare": false,
        "includePreview": true,
        "includeGcode": true,
    });
    if on_belt {
        body["belt"] = json!({
            "angleDeg": 45.0,
            "axis": "z",
            "direction": 1,
            "widthMm": 220.0,
            "copies": 1,
            "gapMm": 5.0,
            "floorSupports": true,
        });
    }
    for (key, value) in extra.as_object().unwrap() {
        body[key] = value.clone();
    }
    let req: SliceRequest = serde_json::from_value(body).unwrap();
    slice_request(&req, Job::default()).unwrap()
}

/// A straight segment's two ends.
type Seg = [[f64; 2]; 2];

/// Straight support lines along X, lying on the belt, that `with` prints and
/// `base` prints on no layer, by the layer's place along the belt (a belt
/// layer's `z`, mm). An anchor can open the print a layer earlier, which
/// moves every layer after it, so no layer of `base` is matched by index.
fn anchors(base: &SliceResponse, with: &SliceResponse) -> Vec<(f64, Vec<Seg>)> {
    let before: Vec<&Vec<[f64; 2]>> = base
        .layers
        .iter()
        .flat_map(|l| &l.paths)
        .map(|p| &p.pts)
        .collect();
    let mut out = Vec::new();
    for layer in &with.layers {
        let lines: Vec<Seg> = layer
            .paths
            .iter()
            .filter(|p| p.kind == "support" && p.pts.len() == 2)
            .filter(|p| (p.pts[0][1] - p.pts[1][1]).abs() < 1e-6)
            .filter(|p| p.zs.iter().all(|z| *z < 0.2 && *z > -0.05))
            .filter(|p| {
                let back = vec![p.pts[1], p.pts[0]];
                !before.iter().any(|q| **q == p.pts || **q == back)
            })
            .map(|p| [p.pts[0], p.pts[1]])
            .collect();
        if !lines.is_empty() {
            out.push((layer.z, lines));
        }
    }
    out
}

fn support_filament(reply: &SliceResponse) -> f64 {
    reply
        .estimate
        .by_feature
        .iter()
        .filter(|f| f.kind.starts_with("support"))
        .map(|f| f.filament_mm)
        .sum()
}

#[test]
fn belt_anchors_lie_across_the_belt_every_10_mm_where_supports_stand_on_it() {
    for style in STYLES {
        let base = slice(style, true, json!({}));
        let anchored = slice(style, true, json!({"supportBeltAnchorMm": 10}));
        let lines = anchors(&base, &anchored);
        let along: Vec<f64> = lines.iter().map(|l| l.0).collect();
        // About 25 mm of feet: the first, two more every 10 mm, and the last.
        assert!(
            (3..=5).contains(&along.len()),
            "{style}: anchors at {along:?} mm"
        );
        for pair in along[..along.len() - 1].windows(2) {
            let step = pair[1] - pair[0];
            assert!(
                (10.0..=11.0).contains(&step),
                "{style}: anchors {step:.2} mm apart: {along:?}"
            );
        }
        let last = along[along.len() - 1] - along[along.len() - 2];
        assert!(last > 0.0 && last <= 11.0, "{style}: last step {last:.2}");
        // Each anchor reaches across the belt, wider than one foot.
        for (index, segs) in &lines {
            let lo = segs
                .iter()
                .map(|s| s[0][0].min(s[1][0]))
                .fold(f64::INFINITY, f64::min);
            let hi = segs
                .iter()
                .map(|s| s[0][0].max(s[1][0]))
                .fold(f64::NEG_INFINITY, f64::max);
            assert!(
                hi - lo > 20.0,
                "{style}: anchor at {index:.2} mm spans {lo:.1}..{hi:.1}"
            );
        }
        assert!(
            support_filament(&anchored) > support_filament(&base),
            "{style}"
        );
        assert!(
            anchored.estimate.seconds >= base.estimate.seconds,
            "{style}"
        );
        assert!(anchored.sanity.ok, "{style}: {:?}", anchored.sanity.notes);
        assert!(
            anchored.gcode.contains("belt anchors every 10 mm"),
            "{style}"
        );

        // A wider spacing lays fewer, from the same first foot. (The last
        // foot of the trees stands beside the far wall, which lies on the
        // belt across the whole line, so its anchor keeps clear and is gone.)
        let sparse = slice(style, true, json!({"supportBeltAnchorMm": 25}));
        let fewer: Vec<f64> = anchors(&base, &sparse).iter().map(|l| l.0).collect();
        assert!(
            fewer.len() < along.len() && fewer.len() >= 2,
            "{style}: {fewer:?} vs {along:?}"
        );
        assert_eq!(
            fewer.first(),
            along.first(),
            "{style}: the first foot anchors either way"
        );
        assert!(fewer[1] - fewer[0] >= 25.0, "{style}: {fewer:?}");
    }
}

#[test]
fn belt_anchors_change_nothing_when_off_on_a_flat_bed_or_without_supports() {
    let base = slice("grid", true, json!({}));
    let off = slice("grid", true, json!({"supportBeltAnchorMm": null}));
    assert_eq!(base.gcode, off.gcode);
    let flat = slice("grid", false, json!({}));
    let flat_asked = slice("grid", false, json!({"supportBeltAnchorMm": 10}));
    assert_eq!(flat.gcode, flat_asked.gcode);
    let bare = slice("grid", true, json!({"supports": false}));
    let bare_asked = slice(
        "grid",
        true,
        json!({"supports": false, "supportBeltAnchorMm": 10}),
    );
    assert_eq!(bare.gcode, bare_asked.gcode);
}

/// What the anchors cost on the bridge, printed for the PR. Not a check.
#[test]
#[ignore]
fn belt_anchor_cost() {
    for style in STYLES {
        let base = slice(style, true, json!({}));
        let a = slice(style, true, json!({"supportBeltAnchorMm": 10}));
        let along: Vec<String> = anchors(&base, &a)
            .iter()
            .map(|l| format!("{:.1}", l.0))
            .collect();
        eprintln!(
            "COST {style}: anchors at {along:?} mm along the belt; filament {:.2} -> {:.2} g ({:+.3} g, {:+.1} mm); time {:.0} -> {:.0} s ({:+.1} s)",
            base.estimate.filament_g,
            a.estimate.filament_g,
            a.estimate.filament_g - base.estimate.filament_g,
            a.estimate.filament_mm - base.estimate.filament_mm,
            base.estimate.seconds,
            a.estimate.seconds,
            a.estimate.seconds - base.estimate.seconds,
        );
    }
}
