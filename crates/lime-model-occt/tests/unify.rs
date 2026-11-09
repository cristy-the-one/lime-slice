//! `unify`: two boxes fused with flush tops leave two top faces and a seam edge; a `unify` step makes them one, and a
//! fillet then runs the whole 40 mm edge across the old seam. Face provenance survives the merge. `LIME_REQUIRE_OCCT=1`
//! makes a missing kernel a failure.

use serde_json::{json, Value};

fn require() -> bool {
    std::env::var_os("LIME_REQUIRE_OCCT").is_some()
}

fn call(request: Value) -> Value {
    let text = lime_model_occt::tree(&request.to_string());
    serde_json::from_str(&text).unwrap_or_else(|err| panic!("not JSON ({err}): {text}"))
}

fn ok(request: Value) -> Value {
    let reply = call(request.clone());
    assert!(reply.get("error").is_none(), "{request} -> {reply}");
    reply
}

fn volume(reply: &Value) -> f64 {
    reply["volumeMm3"].as_f64().expect("volumeMm3")
}

fn near(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() < 1e-3,
        "{actual} is not near {expected}"
    );
}

/// Areas of faces whose outward normal is +Z, with the step that owns each.
fn tops(reply: &Value) -> Vec<(f64, u64)> {
    let faces = reply["faces"].as_array().expect("faces");
    let steps = reply["stepFaces"].as_array().expect("stepFaces");
    faces
        .iter()
        .enumerate()
        .filter(|(_, face)| {
            face["normal"]
                .as_array()
                .is_some_and(|n| (n[2].as_f64().unwrap_or(0.0) - 1.0).abs() < 1e-6)
        })
        .map(|(i, face)| {
            (
                face["areaMm2"].as_f64().unwrap(),
                steps[i].as_u64().unwrap_or(u64::MAX),
            )
        })
        .collect()
}

fn long_edge(reply: &Value) -> usize {
    reply["edgeLengths"]
        .as_array()
        .expect("edgeLengths")
        .iter()
        .position(|length| (length.as_f64().unwrap_or(0.0) - 40.0).abs() < 1e-6)
        .expect("a 40 mm edge")
}

#[test]
fn unify_lets_a_fillet_cross_a_fuse_seam() {
    let opened = call(
        json!({ "call": "open", "key": "uni", "primitive": { "primitive": "box", "origin": [-20.0, -20.0, 0.0], "size": [20.0, 20.0, 10.0] } }),
    );
    if opened.get("error").is_some() {
        assert!(!require(), "OCCT was required: {opened}");
        return;
    }
    // Two 20 mm boxes side by side along X, fused with no merge flag: the top stays two faces, the front edge two halves.
    let side = json!({ "kind": "boolean", "op": "fuse", "primitive": "box", "origin": [0.0, -20.0, 0.0], "size": [20.0, 20.0, 10.0] });
    let fused = ok(json!({ "call": "apply", "key": "uni", "parent": 0, "node": 1, "op": side }));
    assert_eq!(tops(&fused).len(), 2, "{:?}", tops(&fused));
    assert!(
        fused["edgeLengths"]
            .as_array()
            .unwrap()
            .iter()
            .all(|l| (l.as_f64().unwrap() - 40.0).abs() > 1e-6),
        "no 40 mm edge yet"
    );

    let unified = ok(
        json!({ "call": "apply", "key": "uni", "parent": 1, "node": 2, "op": { "kind": "unify" } }),
    );
    near(volume(&unified), 8000.0);
    let merged = tops(&unified);
    assert_eq!(merged.len(), 1, "{merged:?}");
    near(merged[0].0, 800.0);
    // The merged top is still a face the root or the fuse made, not this step's.
    assert!(merged[0].1 < 2, "provenance: {merged:?}");
    // The bottom, the two long sides and the two ends are one face each as well.
    assert_eq!(unified["faces"].as_array().unwrap().len(), 6);
    assert_eq!(unified["op"]["kind"], json!("unify"));

    // A fillet along the whole 40 mm top-front edge crosses where the seam was. Before the unify it was two 20 mm halves.
    let across = ok(
        json!({ "call": "apply", "key": "uni", "parent": 2, "node": 3,
        "op": { "kind": "fillet", "edges": [long_edge(&unified)], "size": 2.0 } }),
    );
    near(
        volume(&across),
        8000.0 - (1.0 - std::f64::consts::FRAC_PI_4) * 4.0 * 40.0,
    );

    // Unified again, nothing changes: a step with no seam is allowed and adds nothing.
    let again = ok(
        json!({ "call": "apply", "key": "uni", "parent": 2, "node": 4, "op": { "kind": "unify" } }),
    );
    near(volume(&again), 8000.0);
    assert_eq!(again["faces"].as_array().unwrap().len(), 6);
}
