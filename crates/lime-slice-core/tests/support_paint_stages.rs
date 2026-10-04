//! Support paint and the kept stages: a stroke regrows only the supports,
//! and a pure X/Y move of a painted part reuses every stage. One test,
//! because the kept stages are shared by the whole process.

use base64::Engine;
use lime_slice_core::{keep_support_bases, slice_payload, Job};
use serde_json::{json, Value};

fn request(x: f64, y: f64, paint: Value) -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../samples/overhang_ledge.stl"
    );
    json!({
        "filename": "overhang_ledge.stl",
        "dataB64": base64::engine::general_purpose::STANDARD.encode(std::fs::read(path).unwrap()),
        "blend": {"mode": "single", "strategy": "toughness"},
        "supports": true,
        "supportStyle": "tree",
        "includeGcode": true,
        "includePreview": true,
        "baseline": false,
        "pose": {
            "rotation": [1, 0, 0, 0, 1, 0, 0, 0, 1],
            "pivot": [24.0, 12.0, 8.0],
            "translation": [x, y, 8.0],
        },
        "supportPaint": paint,
    })
}

fn slice(req: &Value) -> Value {
    let reply = slice_payload(&req.to_string(), None, Job::default(), |g| g.text()).unwrap();
    serde_json::from_str(&reply).unwrap()
}

fn reused(reply: &Value) -> Vec<&str> {
    reply["stages"]["reused"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect()
}

#[test]
fn a_stroke_regrows_only_supports_and_a_move_reuses_every_stage() {
    let stroke =
        json!([{"kind": "block", "p": [42.0, 12.0, 12.0], "n": [0.0, 0.0, -1.0], "r": 6.0}]);
    keep_support_bases(true);
    let first = slice(&request(100.0, 120.0, json!([])));
    let painted = slice(&request(100.0, 120.0, stroke.clone()));
    let moved = slice(&request(123.5, 102.75, stroke.clone()));
    keep_support_bases(false);
    let cold = slice(&request(123.5, 102.75, stroke));

    assert_eq!(reused(&first), Vec::<&str>::new());
    assert_eq!(reused(&painted), ["contours", "toolpaths", "order", "comb"]);
    assert_eq!(
        reused(&moved),
        [
            "contours",
            "toolpaths",
            "order",
            "comb",
            "supports",
            "supportPaths"
        ]
    );
    assert_ne!(painted["gcode"], first["gcode"]);
    assert_eq!(moved["gcode"], cold["gcode"]);
    assert_eq!(moved["supportPaint"], cold["supportPaint"]);
}
