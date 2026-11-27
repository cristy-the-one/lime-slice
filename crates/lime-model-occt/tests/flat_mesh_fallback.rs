//! A flat face whose exact mesh fails, or answers with a triangle turned over, is meshed by Watson instead: the mesh is
//! Watson's own, bit for bit, and the kernel counts the face as handed back. Its own test binary, because the fault it
//! turns on is global to the kernel. Debug builds only: the hook is not in a release.

#![cfg(lime_occt_test_hooks)]

use serde_json::{json, Value};

extern "C" {
    fn lime_model_occt_test_flat_mesh_fault(mode: i32);
}

fn ok(request: Value) -> Value {
    let text = lime_model_occt::tree(&request.to_string());
    let reply: Value = serde_json::from_str(&text).unwrap_or_else(|err| panic!("not JSON ({err}): {text}"));
    assert!(reply.get("error").is_none(), "{reply}");
    reply
}

fn stat(name: &str) -> u64 {
    let stats: Value = serde_json::from_str(&lime_model_occt::stats()).expect("stats");
    stats[name].as_u64().unwrap_or(0)
}

/// A plate with 20 holes, its mesh as positions and triangles, and how many faces took the exact mesh and how many it
/// handed back to Watson.
fn plate(key: &str) -> (String, u64, u64) {
    ok(json!({ "call": "open", "key": key, "chordMm": 0.1, "primitive": { "primitive": "box", "origin": [0.0, 0.0, 0.0], "size": [50.0, 20.0, 5.0] } }));
    let steps: Vec<Value> = (0..20)
        .map(|i| {
            let (x, y) = (5.0 + 4.0 * f64::from(i % 10), 6.0 + 8.0 * f64::from(i / 10));
            json!({ "kind": "boolean", "op": "cut", "primitive": "cylinder", "origin": [x, y, -1.0], "radius": 1.0, "height": 8.0, "merge": true })
        })
        .collect();
    let (flat, back) = (stat("flatFaces"), stat("flatFallbacks"));
    let reply = ok(json!({
        "call": "apply", "key": key, "parent": 0, "node": 1, "chordMm": 0.1,
        "op": { "kind": "group", "label": "holes", "source": { "kind": "pattern", "combine": true }, "steps": steps, "combine": "cut" }
    }));
    ok(json!({ "call": "close", "key": key }));
    let mesh = format!("{}{}", reply["positions"].as_str().unwrap_or(""), reply["triangles"].as_str().unwrap_or(""));
    (mesh, stat("flatFaces") - flat, stat("flatFallbacks") - back)
}

#[test]
fn a_failed_or_wrong_exact_mesh_is_watsons_instead() {
    let stats: Value = serde_json::from_str(&lime_model_occt::stats()).expect("stats");
    if stats.get("error").is_some() {
        assert!(std::env::var_os("LIME_REQUIRE_OCCT").is_none(), "Open CASCADE is required: {stats}");
        return;
    }
    let (exact, flat, back) = plate("exact");
    assert_eq!((flat, back), (2, 0), "the plate's top and bottom take the exact mesh");
    lime_model_occt::set_flat_mesher_holes(None);
    let (watson, flat, back) = plate("watson");
    lime_model_occt::set_flat_mesher_holes(Some(lime_model_occt::FLAT_MESHER_HOLES));
    assert_eq!((flat, back), (0, 0), "with the exact mesh off, Watson meshes every face");
    assert_ne!(exact, watson, "the two meshers triangulate the plate differently");
    for (mode, what) in [(1, "fails"), (2, "commits a triangle turned over")] {
        unsafe { lime_model_occt_test_flat_mesh_fault(mode) };
        let (mesh, flat, back) = plate(&format!("fault{mode}"));
        unsafe { lime_model_occt_test_flat_mesh_fault(0) };
        assert_eq!((flat, back), (0, 2), "when the exact mesh {what}, both faces are handed back");
        assert_eq!(mesh, watson, "when the exact mesh {what}, the mesh is Watson's");
    }
}
