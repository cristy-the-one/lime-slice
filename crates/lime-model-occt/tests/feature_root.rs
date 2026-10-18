//! K2: a tree can open from an extrude, revolve, or loft, with no primitive under it. The tool is the solid.
//! `LIME_REQUIRE_OCCT=1` makes a missing kernel a failure.

use serde_json::{json, Value};

fn require() -> bool {
    std::env::var_os("LIME_REQUIRE_OCCT").is_some()
}

fn call(request: Value) -> Value {
    let text = lime_model_occt::tree(&request.to_string());
    serde_json::from_str(&text).unwrap_or_else(|err| panic!("not JSON ({err}): {text}"))
}

fn ok(request: Value) -> Value {
    let reply = call(request);
    assert!(reply.get("error").is_none(), "{reply}");
    reply
}

fn volume(reply: &Value) -> f64 {
    reply["volumeMm3"].as_f64().expect("volumeMm3")
}

fn near(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() < 0.02,
        "{actual} is not near {expected}"
    );
}

/// A 10 × 10 square on the bed, extruded `depth` along +Z. Its volume is 100 × depth.
fn square(depth: f64, op: &str) -> Value {
    json!({
        "kind": "extrude",
        "op": op,
        "origin": [0.0, 0.0, 0.0],
        "turn": [0.0, 0.0, 0.0],
        "profile": [[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]],
        "depth": depth
    })
}

fn open_feature(key: &str, feature: &Value) -> Value {
    call(json!({ "call": "open", "key": key, "feature": feature, "chordMm": 0.1 }))
}

/// False, and the test passes, when the kernel is not linked and nobody asked for it.
fn kernel() -> bool {
    let probe = call(json!({ "call": "open", "key": "fr-kernel", "box": [1.0, 1.0, 1.0] }));
    if probe.get("error").is_some() {
        assert!(!require(), "OCCT was required: {probe}");
        return false;
    }
    true
}

#[test]
fn an_extrude_root_has_the_prisms_volume() {
    if !kernel() {
        return;
    }
    let opened = open_feature("fr", &square(10.0, "fuse"));
    assert!(opened.get("error").is_none(), "{opened}");
    // 10 × 10 × 10.
    near(volume(&opened), 1000.0);
    assert_eq!(opened["id"], 0);

    // A 2 × 2 × 2 box cut out of the middle. The step under the root replays after a save.
    let cut = json!({
        "kind": "boolean", "op": "cut", "primitive": "box",
        "origin": [2.0, 2.0, 2.0], "size": [2.0, 2.0, 2.0]
    });
    let cut_reply = ok(json!({ "call": "apply", "key": "fr", "parent": 0, "node": 1, "op": cut }));
    near(volume(&cut_reply), 992.0);

    let reopened = ok(json!({
        "call": "open", "key": "fr-again", "feature": square(10.0, "fuse"),
        "fingerprint": opened["fingerprint"],
        "nodes": [{ "id": 1, "parent": 0, "op": cut, "fingerprint": cut_reply["fingerprint"] }],
        "current": 1, "chordMm": 0.1
    }));
    near(volume(&reopened), 992.0);
    assert_eq!(reopened["id"], 1, "the saved step is the one shown");

    // Edit the root: the same square, twice as tall. The cut replays on it.
    let edited = ok(json!({
        "call": "open", "key": "fr-edited", "feature": square(20.0, "fuse"),
        "nodes": [{ "id": 1, "parent": 0, "op": cut }],
        "current": 1, "chordMm": 0.1
    }));
    near(volume(&edited), 1992.0);
    let root = ok(json!({ "call": "goto", "key": "fr-edited", "node": 0, "chordMm": 0.1 }));
    near(volume(&root), 2000.0);
}

#[test]
fn a_feature_root_refuses_a_cut_and_a_second_source() {
    if !kernel() {
        return;
    }
    let cut = open_feature("fr-cut", &square(10.0, "cut"));
    assert_eq!(
        cut["error"],
        "A new solid is the extrude itself. Cut and intersect need a part that is already there.",
        "{cut}"
    );

    let both = call(json!({
        "call": "open", "key": "fr-both", "feature": square(10.0, "fuse"), "box": [1.0, 1.0, 1.0]
    }));
    assert_eq!(
        both["error"],
        "Open a tree from exactly one of dataB64, stepPath, box, primitive, or feature"
    );
    let hole = call(json!({
        "call": "open", "key": "fr-hole",
        "feature": { "kind": "hole", "origin": [0.0, 0.0, 0.0], "radius": 1.0, "depth": 2.0 }
    }));
    assert_eq!(
        hole["error"],
        "A new solid starts from an extrude, a revolve, or a loft."
    );
}
