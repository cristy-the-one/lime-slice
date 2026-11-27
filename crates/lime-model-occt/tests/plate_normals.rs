//! Prepare and Pose shade the plate mesh with the analytic normal at each of its corners. With `meshQuality: "display"`
//! the reply carries them as `display.plateNormals`, one per corner of the top-level `positions`, and everything outside
//! `display` stays the unflagged reply; `meshStep` asked the same way sends them alone. Without the flag nothing changes.
//! `LIME_REQUIRE_OCCT=1` makes a missing kernel a failure.

use base64::Engine;
use serde_json::{json, Value};

fn call(request: Value) -> Value {
    let text = lime_model_occt::tree(&request.to_string());
    serde_json::from_str(&text).unwrap_or_else(|err| panic!("not JSON ({err}): {text}"))
}

fn ok(request: Value) -> Value {
    let reply = call(request.clone());
    assert!(reply.get("error").is_none(), "{request} -> {reply}");
    reply
}

fn floats(value: &Value) -> Vec<f32> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(value.as_str().expect("base64 text")).expect("base64");
    bytes.chunks_exact(4).map(|w| f32::from_le_bytes(w.try_into().expect("four bytes"))).collect()
}

/// Every normal unit length and outward, on a cylinder of radius 10 and height 20 standing on z = 0.
fn outward_on_cylinder(positions: &[f32], normals: &[f32]) {
    assert_eq!(positions.len(), normals.len(), "one normal a corner");
    for (p, n) in positions.chunks_exact(3).zip(normals.chunks_exact(3)) {
        let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        assert!((len - 1.0).abs() < 1e-4, "unit length, got {len}");
        // A cap's normal is along the axis, the wall's across it; a rim corner belongs to either.
        let on_cap = n[2].abs() > 0.5;
        let out = if on_cap { (p[2] - 10.0) * n[2] } else { p[0] * n[0] + p[1] * n[1] };
        assert!(out > 0.0, "normal {n:?} at {p:?} points in");
    }
}

#[test]
fn the_plate_mesh_normals_ride_in_display_and_change_nothing_else() {
    let opened = call(json!({ "call": "open", "key": "plate-normals-ready", "box": [1.0, 1.0, 1.0] }));
    if opened.get("error").is_some() {
        assert!(std::env::var_os("LIME_REQUIRE_OCCT").is_none(), "OCCT was required: {opened}");
        return;
    }
    ok(json!({ "call": "close", "key": "plate-normals-ready" }));
    let cylinder = |key: &str, flag: bool| {
        let mut request = json!({
            "call": "open", "key": key, "chordMm": 0.05,
            "primitive": { "primitive": "cylinder", "origin": [0.0, 0.0, 0.0], "radius": 10.0, "height": 20.0 }
        });
        if flag {
            request["meshQuality"] = json!("display");
        }
        ok(request)
    };
    let plain = cylinder("plate-normals-plain", false);
    let flagged = cylinder("plate-normals-flagged", true);
    assert!(plain.get("display").is_none());
    let normals = floats(&flagged["display"]["plateNormals"]);
    outward_on_cylinder(&floats(&flagged["positions"]), &normals);
    let mut outside = flagged.clone();
    outside.as_object_mut().expect("object").remove("display");
    assert_eq!(outside, plain, "outside `display` the flagged reply is the unflagged one");

    let step = ok(json!({ "call": "export", "key": "plate-normals-plain", "node": 0, "format": "step" }));
    let data = step["bytesBase64"].clone();
    let meshed = ok(json!({ "call": "meshStep", "dataB64": data, "chordMm": 0.05 }));
    let shaded = ok(json!({ "call": "meshStep", "dataB64": data, "chordMm": 0.05, "meshQuality": "display" }));
    assert!(meshed.get("display").is_none(), "meshStep without the flag is as it was");
    let display = shaded["display"].as_object().expect("display");
    assert_eq!(display.keys().collect::<Vec<_>>(), vec!["plateNormals"], "meshStep sends the normals alone");
    outward_on_cylinder(&floats(&shaded["positions"]), &floats(&shaded["display"]["plateNormals"]));
    let mut outside = shaded.clone();
    outside.as_object_mut().expect("object").remove("display");
    assert_eq!(outside, meshed, "and its mesh is the same");
    ok(json!({ "call": "close", "key": "plate-normals-plain" }));
    ok(json!({ "call": "close", "key": "plate-normals-flagged" }));
}
