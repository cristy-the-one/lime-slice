//! The Model history tree on boxes: build, branch, jump, drop, evict, replay, and rebuild from
//! the saved op list. `LIME_REQUIRE_OCCT=1` makes a missing kernel a failure.
//!
//! The store and its cache limits are process-wide, so everything runs in one test, in order.

use std::f64::consts::PI;
use std::time::Instant;

use serde_json::{json, Value};

fn require() -> bool {
    std::env::var_os("LIME_REQUIRE_OCCT").is_some()
}

fn raw(request: Value) -> String {
    lime_model_occt::tree(&request.to_string())
}

fn call(request: Value) -> Value {
    let text = raw(request);
    serde_json::from_str(&text).unwrap_or_else(|err| panic!("not JSON ({err}): {text}"))
}

fn ok(request: Value) -> Value {
    let reply = call(request.clone());
    assert!(reply.get("error").is_none(), "{request} -> {reply}");
    reply
}

fn near(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() < 0.05,
        "{actual} is not near {expected}"
    );
}

fn volume(reply: &Value) -> f64 {
    reply["volumeMm3"].as_f64().expect("volumeMm3")
}

fn held(reply: &Value) -> Vec<u64> {
    reply["held"]
        .as_array()
        .expect("held")
        .iter()
        .map(|id| id.as_u64().expect("node id"))
        .collect()
}

/// Kernel work, from the counters `lime_model_occt::stats()` reads.
#[derive(Debug, PartialEq)]
struct Work {
    builds: i64,
    volumes: i64,
    tessellations: i64,
}

fn work(builds: i64, volumes: i64, tessellations: i64) -> Work {
    Work {
        builds,
        volumes,
        tessellations,
    }
}

fn counts() -> Work {
    let json: Value = serde_json::from_str(&lime_model_occt::stats()).expect("stats");
    let read = |key: &str| {
        json[key]
            .as_i64()
            .unwrap_or_else(|| panic!("{key} in {json}"))
    };
    work(read("builds"), read("volumes"), read("tessellations"))
}

/// Run `step` and return what it cost the kernel.
fn cost<T>(step: impl FnOnce() -> T) -> (T, Work) {
    let before = counts();
    let out = step();
    let after = counts();
    (
        out,
        work(
            after.builds - before.builds,
            after.volumes - before.volumes,
            after.tessellations - before.tessellations,
        ),
    )
}

fn cut_box(origin: [f64; 3], size: [f64; 3]) -> Value {
    json!({ "kind": "boolean", "op": "cut", "primitive": "box", "origin": origin, "size": size })
}

/// The first edge of `reply` that is `length` long.
fn edge_of_length(reply: &Value, length: f64) -> i64 {
    reply["edges"]
        .as_array()
        .expect("edges")
        .iter()
        .find(|edge| (edge["lengthMm"].as_f64().expect("length") - length).abs() < 1e-6)
        .map(|edge| edge["id"].as_i64().expect("edge id"))
        .expect("an edge of that length")
}

#[test]
fn history_tree() {
    let opened = call(json!({ "call": "open", "key": "main", "box": [10.0, 10.0, 10.0] }));
    if opened.get("error").is_some() {
        assert!(!require(), "OCCT was required: {opened}");
        return;
    }
    near(volume(&opened), 1000.0);
    assert_eq!(opened["solid"], true);
    assert_eq!(opened["id"], 0);
    assert_eq!(opened["fingerprint"]["faces"], 6);
    assert_eq!(opened["fingerprint"]["edges"], 12);
    near(
        opened["fingerprint"]["volumeMm3"]
            .as_f64()
            .expect("root volume"),
        1000.0,
    );
    assert_eq!(held(&opened), [0]);

    let cut = ok(
        json!({ "call": "apply", "key": "main", "parent": 0, "node": 1,
        "op": cut_box([0.0, 0.0, 5.0], [10.0, 10.0, 5.0]) }),
    );
    near(volume(&cut), 500.0);
    assert_eq!(cut["replayed"], 0);
    assert_eq!(held(&cut), [0, 1]);

    let edge = edge_of_length(&cut, 10.0);
    let probe_big = call(json!({ "call": "probe", "key": "main", "node": 1,
        "op": { "kind": "fillet", "edges": [edge], "size": 6.0 } }));
    assert_eq!(probe_big["ok"], false, "{probe_big}");
    let max = probe_big["maxMm"].as_f64().expect("max fillet");
    assert!(max > 1.0 && max < 6.0, "max fillet {max}");
    let probe = ok(json!({ "call": "probe", "key": "main", "node": 1,
        "op": { "kind": "fillet", "edges": [edge], "size": 1.0 } }));
    assert_eq!(probe, json!({ "ok": true }));
    let (fillet, spent) = cost(|| {
        ok(
            json!({ "call": "apply", "key": "main", "parent": 1, "node": 2,
            "op": { "kind": "fillet", "edges": [edge], "size": 1.0 } }),
        )
    });
    assert_eq!(
        spent,
        work(0, 0, 1),
        "the apply took the probe's solid and its volume"
    );
    let rounded = 500.0 - 10.0 * (1.0 - PI / 4.0);
    near(volume(&fillet), rounded);
    let fillet_op = fillet["op"].clone();
    let picked = &fillet_op["edges"][0];
    assert_eq!(picked["index"], edge);
    near(picked["lengthMm"].as_f64().expect("edge length"), 10.0);
    assert_eq!(picked["mid"].as_array().expect("edge midpoint").len(), 3);

    let retried = ok(
        json!({ "call": "apply", "key": "main", "parent": 1, "node": 2,
        "op": { "kind": "fillet", "edges": [edge], "size": 1.0 } }),
    );
    assert_eq!(
        retried["fingerprint"], fillet["fingerprint"],
        "a retried apply lands on the same node"
    );
    let clash = call(
        json!({ "call": "apply", "key": "main", "parent": 0, "node": 2,
        "op": cut_box([0.0, 0.0, 0.0], [1.0, 1.0, 1.0]) }),
    );
    assert!(
        clash["error"].as_str().unwrap_or("").contains("already"),
        "{clash}"
    );
    let other_size = call(
        json!({ "call": "apply", "key": "main", "parent": 1, "node": 2,
        "op": { "kind": "fillet", "edges": [edge], "size": 2.0 } }),
    );
    assert!(
        other_size["error"]
            .as_str()
            .unwrap_or("")
            .contains("already"),
        "a different op on an existing node is refused: {other_size}"
    );
    let as_ref =
        ok(json!({ "call": "apply", "key": "main", "parent": 1, "node": 2, "op": fillet_op }));
    assert_eq!(
        as_ref["fingerprint"], fillet["fingerprint"],
        "the stored op is the same request"
    );

    let (branch, spent) = cost(|| {
        ok(
            json!({ "call": "apply", "key": "main", "parent": 1, "node": 3,
            "op": { "kind": "hole", "origin": [5.0, 5.0, 5.0], "axis": [0.0, 0.0, -1.0], "radius": 2.0, "depth": 10.0 } }),
        )
    });
    assert_eq!(
        spent,
        work(1, 1, 1),
        "an unprobed apply builds and integrates once"
    );
    let drilled = 500.0 - PI * 4.0 * 5.0;
    near(volume(&branch), drilled);
    assert_eq!(held(&branch), [0, 1, 2, 3], "the fillet branch stays");

    let back = raw(json!({ "call": "goto", "key": "main", "node": 2 }));
    let parsed: Value = serde_json::from_str(&back).expect("goto reply");
    assert_eq!(parsed["fingerprint"], fillet["fingerprint"]);
    let started = Instant::now();
    let (again, spent) = cost(|| raw(json!({ "call": "goto", "key": "main", "node": 2 })));
    let cached_ms = started.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(spent, work(0, 0, 0));
    assert_eq!(again, back, "a cached jump answers the same bytes");
    assert!(cached_ms < 5.0, "a cached jump took {cached_ms} ms");

    let distance = ok(json!({ "call": "distance", "key": "main", "node": 0,
        "aKind": "face", "aIndex": 0, "bKind": "face", "bIndex": 1 }));
    near(distance["distanceMm"].as_f64().expect("distance"), 10.0);

    evicted_nodes_replay(&fillet, &branch);
    rebuilt_from_saved_ops(&cut, &fillet, &branch, &fillet_op);
    step_round_trip_keeps_the_fillet_edge(&fillet, &fillet_op);
    split_keeps_both_pieces();
    unknown_and_broken();

    let dropped = ok(json!({ "call": "drop", "key": "main", "node": 1 }));
    assert_eq!(dropped["dropped"], json!([1, 2, 3]));
    assert_eq!(
        dropped["current"], 0,
        "the current node was inside the dropped branch"
    );
    assert_eq!(held(&dropped), [0]);
    let gone = call(json!({ "call": "goto", "key": "main", "node": 2 }));
    assert_eq!(gone, json!({ "error": "unknown", "missing": [2] }));
    let root = call(json!({ "call": "drop", "key": "main", "node": 0 }));
    assert!(
        root["error"].as_str().unwrap_or("").contains("root"),
        "{root}"
    );
    ok(json!({ "call": "close", "key": "main" }));
    let closed = call(json!({ "call": "goto", "key": "main", "node": 0 }));
    assert_eq!(closed, json!({ "error": "unknown", "missing": [0] }));
}

/// With no room for loose solids or replies, only the root and the current node keep theirs,
/// and a jump elsewhere replays from the nearest kept ancestor to the same fingerprint.
fn evicted_nodes_replay(fillet: &Value, branch: &Value) {
    lime_model_occt::set_tree_limits(0, 0);
    let at_hole = ok(json!({ "call": "goto", "key": "main", "node": 3 }));
    assert_eq!(held(&at_hole), [0, 3]);
    assert_eq!(at_hole["fingerprint"], branch["fingerprint"]);

    let (replayed, spent) = cost(|| ok(json!({ "call": "goto", "key": "main", "node": 2 })));
    assert_eq!(
        replayed["replayed"], 2,
        "the cut and the fillet were rebuilt"
    );
    assert_eq!(
        spent,
        work(2, 2, 1),
        "each replayed step builds and integrates once; only the target is tessellated"
    );
    assert_eq!(replayed["fingerprint"], fillet["fingerprint"]);
    assert_eq!(held(&replayed), [0, 2]);

    lime_model_occt::set_tree_limits(1, 1);
    let hole = ok(json!({ "call": "goto", "key": "main", "node": 3 }));
    assert_eq!(hole["replayed"], 2, "the cut and the hole were rebuilt");
    assert_eq!(
        held(&hole),
        [0, 1, 3],
        "one loose solid stays: the most recent, the cut"
    );
    let fillet_again = ok(json!({ "call": "goto", "key": "main", "node": 2 }));
    assert_eq!(fillet_again["replayed"], 1, "only the fillet was rebuilt");
    assert_eq!(
        held(&fillet_again),
        [0, 2, 3],
        "the hole was used after the cut"
    );

    lime_model_occt::set_tree_limits(24, 8);
}

/// The client saves the root and each node's op, parent and fingerprint. Opening from those
/// builds nothing until a jump needs it.
fn rebuilt_from_saved_ops(cut: &Value, fillet: &Value, branch: &Value, fillet_op: &Value) {
    let saved = |fillet_op: &Value, fillet_print: &Value| {
        json!([
            { "id": 1, "parent": 0, "op": cut_box([0.0, 0.0, 5.0], [10.0, 10.0, 5.0]), "fingerprint": cut["fingerprint"] },
            { "id": 2, "parent": 1, "op": fillet_op, "fingerprint": fillet_print },
            { "id": 3, "parent": 1, "op": branch["op"], "fingerprint": branch["fingerprint"] },
        ])
    };
    let reopened = ok(
        json!({ "call": "open", "key": "saved", "box": [10.0, 10.0, 10.0],
        "nodes": saved(fillet_op, &fillet["fingerprint"]), "current": 2 }),
    );
    assert_eq!(reopened["replayed"], 2);
    assert_eq!(reopened["fingerprint"], fillet["fingerprint"]);
    assert_eq!(
        held(&reopened),
        [0, 1, 2],
        "node 3 is registered, not built"
    );
    let hole = ok(json!({ "call": "goto", "key": "saved", "node": 3 }));
    assert_eq!(hole["replayed"], 1);
    assert_eq!(hole["fingerprint"], branch["fingerprint"]);

    let edges = cut["edges"].as_array().expect("edges").len() as i64;
    let mut moved = fillet_op.clone();
    let index = moved["edges"][0]["index"].as_i64().expect("index");
    moved["edges"][0]["index"] = json!((index + 1) % edges);
    let matched = ok(
        json!({ "call": "open", "key": "saved", "box": [10.0, 10.0, 10.0],
        "nodes": saved(&moved, &fillet["fingerprint"]), "current": 2 }),
    );
    assert_eq!(
        matched["fingerprint"], fillet["fingerprint"],
        "the edge was found by its midpoint and length"
    );

    let mut lost = fillet_op.clone();
    lost["edges"][0]["mid"] = json!([50.0, 50.0, 50.0]);
    let broken = call(
        json!({ "call": "open", "key": "saved", "box": [10.0, 10.0, 10.0],
        "nodes": saved(&lost, &fillet["fingerprint"]), "current": 2 }),
    );
    assert_eq!(broken["broken"], 2, "{broken}");

    let wrong = json!({ "volumeMm3": 123.0, "faces": 6, "edges": 12 });
    let mismatch = call(
        json!({ "call": "open", "key": "saved", "box": [10.0, 10.0, 10.0],
        "nodes": saved(fillet_op, &wrong), "current": 2 }),
    );
    assert_eq!(mismatch["broken"], 2, "{mismatch}");
    assert!(
        mismatch["error"]
            .as_str()
            .unwrap_or("")
            .contains("rebuilt differently"),
        "{mismatch}"
    );
    let parent = ok(json!({ "call": "goto", "key": "saved", "node": 1 }));
    assert_eq!(
        parent["fingerprint"], cut["fingerprint"],
        "the steps above a broken one still open"
    );
    let still = call(json!({ "call": "goto", "key": "saved", "node": 2 }));
    assert_eq!(still["broken"], 2);
    ok(json!({ "call": "drop", "key": "saved", "node": 2 }));
    let redone =
        ok(json!({ "call": "apply", "key": "saved", "parent": 1, "node": 2, "op": fillet_op }));
    assert_eq!(redone["fingerprint"], fillet["fingerprint"]);
    ok(json!({ "call": "close", "key": "saved" }));
}

/// A tree whose root is the cut node's STEP export still finds the filleted edge.
fn step_round_trip_keeps_the_fillet_edge(fillet: &Value, fillet_op: &Value) {
    let exported = call(json!({ "call": "export", "key": "main", "node": 1 }));
    if exported["error"] == "STEP writer is not linked" && !require() {
        return;
    }
    let data = exported["bytesBase64"]
        .as_str()
        .unwrap_or_else(|| panic!("{exported}"));
    assert!(exported["byteLength"].as_u64().expect("byteLength") > 0);
    let reread = ok(json!({ "call": "open", "key": "step", "dataB64": data,
        "nodes": [{ "id": 1, "parent": 0, "op": fillet_op, "fingerprint": fillet["fingerprint"] }], "current": 1 }));
    assert_eq!(
        reread["fingerprint"]["faces"],
        fillet["fingerprint"]["faces"]
    );
    assert_eq!(
        reread["fingerprint"]["edges"],
        fillet["fingerprint"]["edges"]
    );
    near(volume(&reread), volume(fillet));
    ok(json!({ "call": "close", "key": "step" }));
}

/// Split answers the other piece once and, with `otherKey`, opens it as its own tree. Jumping
/// above the split, evicting it, replaying it, or dropping it leaves that tree alone.
fn split_keeps_both_pieces() {
    ok(json!({ "call": "open", "key": "split", "box": [10.0, 10.0, 10.0] }));
    let split_op = json!({ "kind": "split", "origin": [0.0, 0.0, 4.0], "normal": [0.0, 0.0, 1.0] });
    let mesh_only =
        ok(json!({ "call": "apply", "key": "split", "parent": 0, "node": 2, "op": split_op }));
    near(volume(&mesh_only["other"]), 600.0);
    assert!(mesh_only["other"].get("key").is_none());
    let crossed = call(
        json!({ "call": "apply", "key": "split", "parent": 0, "node": 3,
        "op": { "kind": "scale", "factor": 2.0 }, "otherKey": "piece" }),
    );
    assert_eq!(crossed, json!({ "error": "otherKey is only for a split" }));

    let split = ok(
        json!({ "call": "apply", "key": "split", "parent": 0, "node": 1,
        "op": split_op, "otherKey": "piece" }),
    );
    near(volume(&split), 400.0);
    near(volume(&split["other"]), 600.0);
    assert_eq!(split["other"]["key"], "piece");
    assert_eq!(split["other"]["id"], 0);
    let elsewhere = call(
        json!({ "call": "apply", "key": "split", "parent": 0, "node": 1,
        "op": split_op, "otherKey": "elsewhere" }),
    );
    assert!(
        elsewhere["error"]
            .as_str()
            .unwrap_or("")
            .contains("already"),
        "the piece went to another key: {elsewhere}"
    );
    let retried = ok(
        json!({ "call": "apply", "key": "split", "parent": 0, "node": 1,
        "op": split_op, "otherKey": "piece" }),
    );
    assert_eq!(retried["fingerprint"], split["fingerprint"]);
    let piece = ok(json!({ "call": "goto", "key": "piece", "node": 0 }));
    assert_eq!(piece["fingerprint"], split["other"]["fingerprint"]);

    let above = ok(json!({ "call": "goto", "key": "split", "node": 0 }));
    near(volume(&above), 1000.0);
    assert_eq!(held(&above), [0, 1, 2]);
    let below = ok(json!({ "call": "goto", "key": "split", "node": 1 }));
    near(volume(&below), 400.0);
    assert!(
        below.get("other").is_none(),
        "a jump does not send the other piece again"
    );

    lime_model_occt::set_tree_limits(0, 0);
    ok(json!({ "call": "goto", "key": "split", "node": 0 }));
    let replayed = ok(json!({ "call": "goto", "key": "split", "node": 1 }));
    assert_eq!(replayed["replayed"], 1);
    lime_model_occt::set_tree_limits(24, 8);
    ok(json!({ "call": "drop", "key": "split", "node": 1 }));
    ok(json!({ "call": "close", "key": "split" }));

    let piece_again = ok(json!({ "call": "goto", "key": "piece", "node": 0 }));
    assert_eq!(piece_again["fingerprint"], split["other"]["fingerprint"]);
    let drilled = ok(
        json!({ "call": "apply", "key": "piece", "parent": 0, "node": 1,
        "op": { "kind": "hole", "origin": [5.0, 5.0, 10.0], "radius": 1.0, "depth": 20.0 } }),
    );
    near(volume(&drilled), 600.0 - PI * 6.0);
    ok(json!({ "call": "close", "key": "piece" }));
}

fn unknown_and_broken() {
    let unknown = call(json!({ "call": "goto", "key": "nobody", "node": 0 }));
    assert_eq!(unknown, json!({ "error": "unknown", "missing": [0] }));
    let missing = call(json!({ "call": "goto", "key": "main", "node": 99 }));
    assert_eq!(missing, json!({ "error": "unknown", "missing": [99] }));
    let orphan = call(
        json!({ "call": "apply", "key": "main", "parent": 98, "node": 99,
        "op": { "kind": "scale", "factor": 2.0 } }),
    );
    assert_eq!(orphan, json!({ "error": "unknown", "missing": [98] }));
    let refused = call(
        json!({ "call": "apply", "key": "main", "parent": 0, "node": 99,
        "op": { "kind": "scale", "factor": 1.0 } }),
    );
    assert_eq!(
        refused,
        json!({ "error": "Scale needs a factor other than 1" })
    );
    let bad = call(json!({ "call": "goto", "key": "main" }));
    assert!(
        bad["error"]
            .as_str()
            .unwrap_or("")
            .starts_with("Bad tree request"),
        "{bad}"
    );
}
