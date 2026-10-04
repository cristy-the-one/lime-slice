//! Modifier volumes and the kept stages: a volume moved with its part
//! reuses every stage, a volume left behind plans the toolpaths again, and
//! an override change never cuts the mesh again. One test, because the kept
//! slices are shared by the whole process.

use base64::Engine;
use lime_slice_core::{keep_support_bases, load_slice_mesh_tol, slice_payload, Job};
use serde_json::{json, Value};

const STL: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../samples/overhang_ledge.stl"
);
const DX: f64 = 23.5;
const DY: f64 = -17.25;

/// The ledge posed with its box centre over `(x, y)`, with `extra` keys.
fn request(x: f64, y: f64, extra: Value) -> Value {
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
        "blend": {"mode": "single", "strategy": "speed"},
        "supports": true,
        "supportStyle": "tree",
        "includeGcode": true,
        "includePreview": true,
        "baseline": false,
        "pose": {
            "rotation": [1, 0, 0, 0, 1, 0, 0, 0, 1],
            "pivot": pivot,
            "translation": [x, y, pivot[2] - min[2]],
        },
    });
    for (k, v) in extra.as_object().unwrap() {
        req[k] = v.clone();
    }
    req
}

/// A dense box with six walls centred over `(x, y)`.
fn volume(x: f64, y: f64, walls: u32) -> Value {
    json!([{"kind": "box", "center": [x, y, 0], "size": [12, 12, 200], "infill": 1, "walls": walls}])
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

const ALL: [&str; 6] = [
    "contours",
    "toolpaths",
    "order",
    "comb",
    "supports",
    "supportPaths",
];

#[test]
fn volumes_follow_the_part_frame_and_never_recut() {
    let (x1, y1) = (100.0 + DX, 120.0 + DY);
    keep_support_bases(true);
    let plain = slice(&request(100.0, 120.0, json!({})));
    let t0 = slice(&request(
        100.0,
        120.0,
        json!({"modifierVolumes": volume(100.0, 120.0, 6)}),
    ));
    let t1 = slice(&request(
        x1,
        y1,
        json!({"modifierVolumes": volume(x1, y1, 6), "previewBase": t0["previewToken"]}),
    ));
    let left = slice(&request(
        x1,
        y1,
        json!({"modifierVolumes": volume(100.0, 120.0, 6)}),
    ));
    let three = slice(&request(
        100.0,
        120.0,
        json!({"modifierVolumes": volume(100.0, 120.0, 3)}),
    ));
    let ranged = slice(&request(
        100.0,
        120.0,
        json!({
            "modifierVolumes": volume(100.0, 120.0, 3),
            "heightRanges": [{"z": [2, 6], "walls": 5, "speed": 30}],
        }),
    ));
    keep_support_bases(false);
    let cold_three = slice(&request(
        100.0,
        120.0,
        json!({"modifierVolumes": volume(100.0, 120.0, 3)}),
    ));

    assert_eq!(reused(&t0), vec!["contours", "supports", "supportPaths"]);
    assert!(t0["gcode"] != plain["gcode"]);
    assert_eq!(reused(&t1), ALL.to_vec(), "the volume moved with the part");
    assert_eq!(t1["previewPatch"]["changed"], json!([]));
    assert_eq!(
        reused(&left),
        vec!["contours", "supports", "supportPaths"],
        "the volume stayed on the bed"
    );
    assert!(left["gcode"] != t1["gcode"]);
    assert_eq!(reused(&three), vec!["contours", "supports", "supportPaths"]);
    assert_eq!(
        reused(&ranged),
        vec!["contours", "supports", "supportPaths"]
    );
    assert_eq!(three["gcode"], cold_three["gcode"], "kept and cold g-code");
    assert_eq!(three["layers"], cold_three["layers"]);
}
