//! The object's speed cap and the kept stages: a cap changes only speeds,
//! so changing it reuses every stage and still slices as cold. Ranges and
//! volumes that set their own speed win over the cap, and ironing never
//! takes it. One test, because the kept slices are shared by the whole
//! process.

use base64::Engine;
use lime_slice_core::{keep_support_bases, load_slice_mesh_tol, slice_payload, Job};
use serde_json::{json, Value};

const STL: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../samples/overhang_ledge.stl"
);

/// The ledge centred over (100, 120), with a range and a volume that set
/// their own speed, a range and a volume that do not, and ironing faster
/// than the cap.
fn request(extra: Value) -> Value {
    let bytes = std::fs::read(STL).unwrap();
    let mesh = load_slice_mesh_tol("overhang_ledge.stl", &bytes, true, 0.0).unwrap();
    let (min, max) = mesh.bounds().unwrap();
    let pivot = [
        (min[0] + max[0]) * 0.5,
        (min[1] + max[1]) * 0.5,
        (min[2] + max[2]) * 0.5,
    ];
    let mut req = json!({
        "filename": "overhang_ledge.stl",
        "dataB64": base64::engine::general_purpose::STANDARD.encode(bytes),
        "blend": {"mode": "single", "strategy": "toughness"},
        "supports": true,
        "supportStyle": "tree",
        "includeGcode": true,
        "includePreview": true,
        "baseline": false,
        "ironing": {"speed": 40},
        "heightRanges": [
            {"z": [2.0, 4.0], "speed": 50},
            {"z": [8.0, 10.0], "walls": 4},
        ],
        "modifierVolumes": [
            {"kind": "box", "center": [86, 120, 0], "size": [12, 30, 200], "infill": 0.5},
            {"kind": "box", "center": [116, 120, 0], "size": [10, 30, 200], "speed": 60},
        ],
        "pose": {
            "rotation": [1, 0, 0, 0, 1, 0, 0, 0, 1],
            "pivot": pivot,
            "translation": [100.0, 120.0, pivot[2] - min[2]],
        },
    });
    for (k, v) in extra.as_object().unwrap() {
        req[k] = v.clone();
    }
    req
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
fn a_speed_cap_change_reuses_every_stage_and_slices_as_cold() {
    let steps = [
        ("uncapped", request(json!({}))),
        ("capped", request(json!({"speed": 30}))),
        ("uncapped again", request(json!({}))),
    ];

    keep_support_bases(true);
    let staged: Vec<Value> = steps.iter().map(|(_, req)| slice(req)).collect();
    keep_support_bases(false);
    let cold: Vec<Value> = steps.iter().map(|(_, req)| slice(req)).collect();

    let got: Vec<(&str, Vec<&str>)> = steps
        .iter()
        .zip(&staged)
        .map(|((name, _), reply)| (*name, reused(reply)))
        .collect();
    let all = vec![
        "contours",
        "toolpaths",
        "order",
        "comb",
        "supports",
        "supportPaths",
    ];
    assert_eq!(
        got,
        vec![
            ("uncapped", vec![]),
            ("capped", all.clone()),
            ("uncapped again", all),
        ]
    );
    for (((name, _), staged), cold) in steps.iter().zip(&staged).zip(&cold) {
        assert!(
            staged["gcode"].as_str().unwrap().contains(";LAYER:"),
            "{name}: g-code"
        );
        assert!(staged["gcode"] == cold["gcode"], "{name}: g-code differs");
        assert!(
            staged["layers"] == cold["layers"],
            "{name}: preview differs"
        );
        assert_eq!(staged["estimate"], cold["estimate"], "{name}: estimate");
    }
    assert!(
        cold[1]["gcode"] != cold[0]["gcode"],
        "the cap changes the g-code"
    );
    assert!(
        cold[2]["gcode"] == cold[0]["gcode"],
        "lifting the cap restores the g-code"
    );
}
