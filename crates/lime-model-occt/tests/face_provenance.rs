//! A face a boolean only trims keeps the node that made it. The fuse trims the box's top; a later
//! cut trims the bottom. Both trimmed faces stay the box's. `LIME_REQUIRE_OCCT=1` makes a missing
//! kernel a failure.

use std::f64::consts::PI;

use serde_json::{json, Value};

fn require() -> bool {
    std::env::var_os("LIME_REQUIRE_OCCT").is_some()
}

fn call(request: Value) -> Value {
    let text = lime_model_occt::tree(&request.to_string());
    serde_json::from_str(&text).unwrap_or_else(|err| panic!("not JSON ({err}): {text}"))
}

fn volume(reply: &Value) -> f64 {
    assert!(reply.get("error").is_none(), "{reply}");
    reply["volumeMm3"].as_f64().expect("volumeMm3")
}

fn near(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() < 0.5,
        "{actual} is not near {expected}"
    );
}

fn apply(key: &str, parent: u32, node: u32, op: &Value) -> Value {
    call(json!({ "call": "apply", "key": key, "parent": parent, "node": node, "op": op }))
}

/// Area of faces whose normal is nearly `axis` (+1 or -1 on Z) and whose step is `owner`.
fn area_owned(reply: &Value, owner: u64, axis: f64) -> f64 {
    let faces = reply["faces"].as_array().expect("faces");
    let steps = reply["stepFaces"].as_array().expect("stepFaces");
    assert_eq!(faces.len(), steps.len(), "{reply}");
    faces
        .iter()
        .enumerate()
        .filter(|(index, face)| {
            steps[*index].as_u64() == Some(owner)
                && face["normal"]
                    .as_array()
                    .is_some_and(|normal| (normal[2].as_f64().unwrap_or(0.0) - axis).abs() < 1e-3)
        })
        .map(|(_, face)| face["areaMm2"].as_f64().unwrap())
        .sum()
}

#[test]
fn face_provenance_survives_a_later_boolean() {
    let opened = call(json!({ "call": "open", "key": "prov", "box": [20.0, 20.0, 10.0] }));
    if opened.get("error").is_some() {
        assert!(!require(), "OCCT was required: {opened}");
        return;
    }
    let root_faces = opened["stepFaces"].as_array().expect("stepFaces");
    assert!(root_faces.iter().all(|face| face.as_u64() == Some(0)), "{opened}");
    near(volume(&opened), 4000.0);

    // The cylinder stands on z = 8 and rises to z = 16, so only the 6 mm above the box is added.
    let fuse = json!({
        "kind": "boolean",
        "op": "fuse",
        "primitive": "cylinder",
        "origin": [10.0, 10.0, 8.0],
        "size": [0.0, 0.0, 0.0],
        "radius": 4.0,
        "height": 8.0,
        "turn": [0.0, 0.0, 0.0],
    });
    let fused = apply("prov", 0, 1, &fuse);
    near(volume(&fused), 4000.0 + 96.0 * PI);
    // The trimmed top is still the box's. IsSame alone would hand that annulus to the fuse.
    near(area_owned(&fused, 0, 1.0), 400.0 - 16.0 * PI);
    near(area_owned(&fused, 1, 1.0), 16.0 * PI);

    // A corner cut that never meets the cylinder. The new bottom is a trim of the box's bottom.
    let cut = json!({
        "kind": "boolean",
        "op": "cut",
        "primitive": "box",
        "origin": [0.0, 0.0, 0.0],
        "size": [4.0, 4.0, 10.0],
    });
    let cutted = apply("prov", 1, 2, &cut);
    near(volume(&cutted), 4000.0 + 96.0 * PI - 160.0);
    near(area_owned(&cutted, 0, -1.0), 400.0 - 16.0);
    near(area_owned(&cutted, 1, 1.0), 16.0 * PI);
}
