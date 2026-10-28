//! A belt slice keeps a lone part's place across the belt out of the plan:
//! moving it across reuses every kept stage and only shifts the G-code's
//! across-belt word, and moving it along the belt changes nothing, since
//! laying flat settles that away. One test, because the kept slices are
//! shared by the whole process.

use base64::Engine;
use lime_slice_core::{keep_support_bases, load_slice_mesh_tol, slice_payload, Job};
use serde_json::{json, Value};

const STL: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../samples/overhang_ledge.stl"
);
const DX: f64 = -23.5;

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
        "belt": {"angleDeg": 45.0, "axis": "z", "direction": 1, "widthMm": 250.0, "copies": 1, "gapMm": 5.0},
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

/// `moved` is `base` with every X word of a move shifted by `DX`, to the
/// printed precision, and every other word the same.
fn assert_shifted(base: &str, moved: &str) {
    let (base, moved): (Vec<&str>, Vec<&str>) = (base.lines().collect(), moved.lines().collect());
    assert_eq!(base.len(), moved.len(), "g-code line count");
    let mut shifted = 0;
    for (n, (a, b)) in base.iter().zip(&moved).enumerate() {
        let (wa, wb): (Vec<&str>, Vec<&str>) = (
            a.split_whitespace().collect(),
            b.split_whitespace().collect(),
        );
        assert_eq!(wa.len(), wb.len(), "line {n}: {a} | {b}");
        let is_move = wa
            .first()
            .is_some_and(|w| ["G0", "G1", "G2", "G3"].contains(w));
        for (x, y) in wa.iter().zip(&wb) {
            if !(is_move && x.starts_with('X')) {
                assert_eq!(x, y, "line {n}: {a} | {b}");
                continue;
            }
            let (p, q): (f64, f64) = (x[1..].parse().unwrap(), y[1..].parse().unwrap());
            assert!((q - (p + DX)).abs() < 0.0015, "line {n}: {a} | {b}");
            shifted += 1;
        }
    }
    assert!(shifted > 1000, "{shifted} X words");
}

#[test]
fn moving_a_part_across_the_belt_only_shifts_the_gcode() {
    keep_support_bases(true);
    let t0 = slice(&request(110.0, 110.0, json!({})));
    let t1 = slice(&request(110.0 + DX, 110.0, json!({"previewBase": t0["previewToken"]})));
    let along = slice(&request(110.0 + DX, 87.0, json!({})));
    keep_support_bases(false);
    let cold = slice(&request(110.0 + DX, 110.0, json!({})));

    for stage in ["contours", "toolpaths", "order", "comb"] {
        assert!(reused(&t1).contains(&stage), "across: {stage} not reused: {:?}", reused(&t1));
        assert!(reused(&along).contains(&stage), "along: {stage} not reused: {:?}", reused(&along));
    }
    let gcode = |r: &Value| r["gcode"].as_str().unwrap().to_string();
    assert_eq!(gcode(&t1), gcode(&cold), "a kept move is the cold slice");
    assert_eq!(gcode(&along), gcode(&cold), "along the belt nothing changes");
    assert_shifted(&gcode(&t0), &gcode(&t1));

    // The preview is in the part frame, so the move redraws no layer.
    let patch = &t1["previewPatch"];
    assert!(patch.is_object(), "a move is a patch: {}", t1["layers"].as_array().map_or(0, Vec::len));
    assert_eq!(patch["changed"].as_array().unwrap().len(), 0);
    let offset = |r: &Value| r["offset"][0].as_f64().unwrap();
    assert!((offset(&t1) - offset(&t0) - DX).abs() < 1e-9);
}
