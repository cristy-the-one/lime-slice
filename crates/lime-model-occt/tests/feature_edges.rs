//! A fillet or chamfer that takes its edges from an earlier step: the edges that step made or changed, all sharp
//! ones, the convex ones, or the concave ones. Picked again at every build, so an edit above and a replay from saved
//! nodes find them again. `LIME_REQUIRE_OCCT=1` makes a missing kernel a failure.

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
        (actual - expected).abs() < 0.05,
        "{actual} is not near {expected}"
    );
}

fn apply(key: &str, parent: u32, node: u32, op: &Value) -> Value {
    call(json!({ "call": "apply", "key": key, "parent": parent, "node": node, "op": op }))
}

fn refused(reply: &Value, wanted: &str) {
    assert_eq!(reply["error"].as_str(), Some(wanted), "{reply}");
}

fn from_step(kind: &str, node: u32, filter: Option<&str>, size: f64) -> Value {
    let mut pick = json!({ "fromNode": node });
    if let Some(filter) = filter {
        pick["filter"] = json!(filter);
    }
    json!({ "kind": kind, "edges": [pick], "size": size })
}

/// A 10 × 10 × 5 block fused on the middle of the top face of the 20 × 20 × 10 box.
fn block(x: f64) -> Value {
    json!({ "kind": "boolean", "op": "fuse", "primitive": "box", "origin": [x, 5.0, 10.0], "size": [10.0, 10.0, 5.0] })
}

/// A box a × b × c with every edge rounded to r: the straight strips, and the corners as eighths of a sphere.
fn rounded_box(a: f64, b: f64, c: f64, r: f64) -> f64 {
    a * b * c - r * r * (1.0 - PI / 4.0) * (4.0 * (a + b + c) - 24.0 * r) - 8.0 * r * r * r
        + 4.0 / 3.0 * PI * r * r * r
}

#[test]
fn blend_the_edges_a_step_made() {
    let opened = call(json!({ "call": "open", "key": "f", "box": [20.0, 20.0, 10.0] }));
    if opened.get("error").is_some() {
        assert!(!require(), "OCCT was required: {opened}");
        return;
    }
    // The root made every edge it has: all twelve rounded.
    let all = apply("f", 0, 1, &from_step("fillet", 0, None, 1.0));
    near(volume(&all), rounded_box(20.0, 20.0, 10.0, 1.0));
    assert_eq!(all["op"], from_step("fillet", 0, None, 1.0), "the pick is stored as sent");

    // The block made eight convex edges (its four upright ones and its top) and four concave ones where it meets the box.
    let fused = apply("f", 0, 2, &block(5.0));
    near(volume(&fused), 4000.0 + 500.0);
    let probe = |op: Value| call(json!({ "call": "probe", "key": "f", "node": 2, "op": op }));
    // A concave chamfer adds material: four 10 mm prisms of 0.5 mm², and a third of a cubic millimetre at each corner.
    let filled = apply("f", 2, 3, &from_step("chamfer", 2, Some("concave"), 1.0));
    near(volume(&filled), 4500.0 + 4.0 * 10.0 * 0.5 + 4.0 / 3.0);
    let rounded = apply("f", 2, 4, &from_step("fillet", 2, Some("convex"), 1.0));
    assert!(volume(&rounded) < 4500.0, "{}", volume(&rounded));
    let edges = rounded["fingerprint"]["edges"].as_i64().unwrap();
    // All sharp edges of the step: both kinds at once.
    let both = probe(from_step("fillet", 2, Some("all"), 1.0));
    assert_eq!(both["ok"], json!(true), "{both}");
    // A step pick and an index pick together.
    let mixed = json!({ "kind": "fillet", "edges": [{ "fromNode": 2, "filter": "convex" }, 0], "size": 1.0 });
    assert_eq!(probe(mixed)["ok"], json!(true));

    // A step pick names a step above the one it rounds: the root, or the parent itself.
    refused(
        &apply("f", 0, 90, &from_step("fillet", 2, Some("convex"), 1.0)),
        "A blend can only take edges from this step's parent or a step above it.",
    );
    refused(
        &apply("f", 0, 90, &from_step("fillet", 0, Some("concave"), 1.0)),
        "Step 0 left no concave edges on this solid to fillet.",
    );
    let after_round = probe(from_step("chamfer", 4, Some("concave"), 0.5));
    assert_eq!(after_round["ok"], json!(false));

    // The block moves: the edit replays the fillet, which finds the moved block's convex edges again.
    let edited = call(json!({
        "call": "edit", "key": "f", "parent": 0, "node": 5, "op": block(8.0),
        "replay": [{ "id": 6, "op": from_step("fillet", 5, Some("convex"), 1.0) }],
    }));
    assert!(edited.get("broken").is_none(), "{edited}");
    near(volume(&edited), volume(&rounded));
    assert_eq!(edited["fingerprint"]["edges"].as_i64(), Some(edges));

    // Saved nodes, built again from nothing, rebuild to their fingerprints: the step's edges are read again.
    let saved = json!([
        { "id": 2, "parent": 0, "op": fused["op"], "fingerprint": fused["fingerprint"] },
        { "id": 4, "parent": 2, "op": rounded["op"], "fingerprint": rounded["fingerprint"] },
    ]);
    let reopened = call(json!({ "call": "open", "key": "f2", "box": [20.0, 20.0, 10.0], "nodes": saved, "current": 4 }));
    near(volume(&reopened), volume(&rounded));
    // A step that is gone, or never was: the pick names a step not above it.
    refused(
        &apply("f2", 4, 7, &from_step("fillet", 9, None, 0.5)),
        "A blend can only take edges from this step's parent or a step above it.",
    );
}
