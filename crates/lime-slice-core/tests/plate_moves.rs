//! Moving and changing one object of a plate with the kept stages on. One
//! test, because the kept slices are shared by the whole process.

use base64::Engine;
use lime_slice_core::{keep_support_bases, load_slice_mesh_tol, slice_payload, Job};
use serde_json::{json, Value};

const SAMPLES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../samples/");

const ALL: [&str; 6] = [
    "contours",
    "toolpaths",
    "order",
    "comb",
    "supports",
    "supportPaths",
];

fn object(id: &str, name: &str, x: f64, y: f64, settings: Value) -> Value {
    let bytes = std::fs::read(format!("{SAMPLES}{name}")).unwrap();
    let mesh = load_slice_mesh_tol(name, &bytes, true, 0.0).unwrap();
    let (min, max) = mesh.bounds().unwrap();
    let pivot = [
        (min[0] + max[0]) * 0.5,
        (min[1] + max[1]) * 0.5,
        (min[2] + max[2]) * 0.5,
    ];
    json!({
        "id": id,
        "filename": name,
        "dataB64": base64::engine::general_purpose::STANDARD.encode(bytes),
        "pose": {
            "rotation": [1, 0, 0, 0, 1, 0, 0, 0, 1],
            "pivot": pivot,
            "translation": [x, y, pivot[2] - min[2]],
        },
        "settings": settings,
    })
}

/// A cube at (70, 110) and the ledge, which needs supports, at `b`.
fn plate(b: [f64; 2], b_settings: Value, extra: Value) -> Value {
    let mut req = json!({
        "blend": {"mode": "single", "strategy": "toughness"},
        "supports": true,
        "supportStyle": "tree",
        "includeGcode": true,
        "includePreview": true,
        "baseline": false,
        "objects": [
            object("a", "calibration_cube_20mm.stl", 70.0, 110.0, json!({})),
            object("b", "overhang_ledge.stl", b[0], b[1], b_settings),
        ],
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

fn reused(reply: &Value, object: usize) -> Vec<&str> {
    reply["objects"][object]["reused"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect()
}

#[test]
fn moving_or_changing_one_object_leaves_the_other_alone() {
    let speed = json!({"blend": {"mode": "single", "strategy": "speed"}});
    keep_support_bases(true);
    let t0 = slice(&plate([150.0, 110.0], json!({}), json!({})));
    let moved = slice(&plate(
        [160.0, 115.0],
        json!({}),
        json!({"previewBase": t0["previewToken"]}),
    ));
    let changed = slice(&plate(
        [160.0, 115.0],
        speed.clone(),
        json!({"previewBase": moved["previewToken"]}),
    ));
    keep_support_bases(false);
    let cold_moved = slice(&plate([160.0, 115.0], json!({}), json!({})));

    assert_eq!(reused(&moved, 0), ALL, "every stage of a");
    assert_eq!(reused(&moved, 1), ALL, "every stage of b");
    assert_eq!(moved["previewPatch"]["base"], t0["previewToken"]);
    assert_eq!(
        moved["previewPatch"]["changed"],
        json!([]),
        "a 0-layer patch"
    );
    assert_eq!(moved["previewToken"], t0["previewToken"]);
    assert_eq!(moved["objects"][0]["offset"], json!([-40.0, 0.0]));
    assert_eq!(moved["objects"][1]["offset"], json!([50.0, 5.0]));
    assert_eq!(
        moved["gcode"], cold_moved["gcode"],
        "the kept plate writes the G-code of a cold slice at the new place"
    );
    assert_ne!(moved["gcode"], t0["gcode"]);

    assert_eq!(reused(&changed, 0), ALL, "a is not planned again");
    assert_eq!(
        reused(&changed, 1),
        ["contours"],
        "b is planned from its cut"
    );
    let layers = changed["previewPatch"]["changed"].as_array().unwrap();
    assert!(!layers.is_empty());
    let objects: Vec<u64> = layers
        .iter()
        .flat_map(|l| l["paths"]["object"].as_array().cloned().unwrap_or_default())
        .map(|o| o.as_u64().unwrap())
        .collect();
    assert!(
        objects.iter().all(|&o| o == 1),
        "only b's paths are sent again"
    );
}
