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

/// The house in `tests/sketch.rs`: a 100 × 60 × 50 body and a gable roof, then the convex edges that roof made.
/// The fillet is the one the MCP sends (`{fromNode, filter: "convex"}`). `stepEdges` names those same edges on the
/// solid on screen, and filleting them by index removes the same volume.
#[test]
fn fillet_convex_edges_of_the_house_roof() {
    let opened = call(json!({ "call": "open", "key": "house", "box": [100.0, 60.0, 50.0] }));
    if opened.get("error").is_some() {
        assert!(!require(), "OCCT was required: {opened}");
        return;
    }
    near(volume(&opened), 300_000.0);
    let mut roof = json!({
        "kind": "extrude", "op": "fuse",
        "origin": [0.0, 30.0, 0.0], "turn": [90.0, 0.0, 0.0],
        "profile": [[-5.0, 50.0], [105.0, 50.0], [50.0, 80.0]],
        "depth": 70.0,
    });
    roof["symmetric"] = json!(true);
    let roofed = apply("house", 0, 1, &roof);
    near(volume(&roofed), 300_000.0 + 1650.0 * 70.0);

    let by_step = from_step("fillet", 1, Some("convex"), 1.0);
    let listed = call(json!({ "call": "stepEdges", "key": "house", "node": 1, "filter": "convex" }));
    assert!(listed.get("error").is_none(), "{listed}");
    assert_eq!(listed["id"], json!(1), "indexes are on the solid on screen");
    assert_eq!(listed["node"], json!(1));
    let indexes = listed["edges"].as_array().expect("edges");
    assert!(!indexes.is_empty(), "{listed}");
    // No filter is every sharp edge, which includes the convex ones.
    let all = call(json!({ "call": "stepEdges", "key": "house", "node": 1 }));
    assert!(
        all.get("error").is_none() && all["edges"].as_array().unwrap().len() >= indexes.len(),
        "{all}"
    );

    let by_index = json!({ "kind": "fillet", "edges": indexes, "size": 1.0 });
    let probe_step = call(json!({ "call": "probe", "key": "house", "node": 1, "op": by_step }));
    let probe_index = call(json!({ "call": "probe", "key": "house", "node": 1, "op": by_index }));
    assert_eq!(probe_step["ok"], json!(true), "{probe_step}");
    assert_eq!(probe_index["ok"], json!(true), "{probe_index}");
    near(
        probe_step["volumeMm3"].as_f64().unwrap(),
        probe_index["volumeMm3"].as_f64().unwrap(),
    );
    let rounded = apply("house", 1, 2, &by_step);
    near(volume(&rounded), probe_step["volumeMm3"].as_f64().unwrap());
    assert!(volume(&rounded) < volume(&roofed), "a convex fillet removes material");
    assert_eq!(rounded["op"], by_step, "the pick is stored as the MCP sends it");

    // A step that is not this solid or above it is refused, and so is one that is not in the history.
    let back = call(json!({ "call": "goto", "key": "house", "node": 1 }));
    assert!(back.get("error").is_none(), "{back}");
    refused(
        &call(json!({ "call": "stepEdges", "key": "house", "node": 2, "filter": "convex" })),
        "A blend can only take edges from this step's parent or a step above it.",
    );
    refused(
        &call(json!({ "call": "stepEdges", "key": "house", "node": 9 })),
        "Step 9 is not in this history.",
    );
}
