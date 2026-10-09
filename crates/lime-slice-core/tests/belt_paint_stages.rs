//! Support paint on a belt and the kept stages: each stroke regrows only the
//! supports. One test, because the kept stages are shared by the whole process.

use base64::Engine;
use lime_slice_core::{keep_support_bases, slice_payload, Job};
use serde_json::{json, Value};

fn request(paint: Value) -> Value {
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
        "belt": {
            "angleDeg": 45.0,
            "axis": "z",
            "direction": 1,
            "widthMm": 220.0,
            "copies": 1,
            "gapMm": 5.0,
            "floorSupports": true,
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
fn a_belt_stroke_regrows_only_supports() {
    let stroke =
        |r: f64| json!([{"kind": "enforce", "p": [36.0, 12.0, 12.0], "n": [0.0, 0.0, -1.0], "r": r}]);
    keep_support_bases(true);
    let first = slice(&request(json!([])));
    let painted = slice(&request(stroke(6.0)));
    let smaller = slice(&request(stroke(3.0)));
    keep_support_bases(false);
    let cold = slice(&request(stroke(3.0)));

    assert_eq!(reused(&first), Vec::<&str>::new());
    assert_eq!(reused(&painted), ["contours", "toolpaths", "order", "comb"]);
    assert_eq!(reused(&smaller), ["contours", "toolpaths", "order", "comb"]);
    assert_ne!(painted["gcode"], first["gcode"]);
    assert_ne!(smaller["gcode"], painted["gcode"]);
    assert_eq!(smaller["gcode"], cold["gcode"]);
}
