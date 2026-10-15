//! Editing a step: `edit` builds the edited op as a sibling of the step edited, replays the steps under it on the new
//! branch, and leaves the old branch as it was. `LIME_REQUIRE_OCCT=1` makes a missing kernel a failure.
//!
//! The store is process-wide, so everything runs in one test, in order.

use std::f64::consts::PI;
use std::time::Instant;

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

fn refused(request: Value) -> String {
    let reply = call(request.clone());
    reply["error"]
        .as_str()
        .unwrap_or_else(|| panic!("{request} was not refused: {reply}"))
        .to_string()
}

fn volume(reply: &Value) -> f64 {
    reply["volumeMm3"].as_f64().expect("volumeMm3")
}

fn near(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() < 0.01,
        "{actual} is not near {expected}"
    );
}

fn tessellations() -> i64 {
    let json: Value = serde_json::from_str(&lime_model_occt::stats()).expect("stats");
    json["tessellations"].as_i64().expect("tessellations")
}

/// The first edge of `reply` that is `length` long.
fn edge_of_length(reply: &Value, length: f64) -> i64 {
    reply["edgeLengths"]
        .as_array()
        .expect("edgeLengths")
        .iter()
        .position(|edge| (edge.as_f64().expect("length") - length).abs() < 1e-6)
        .expect("an edge of that length") as i64
}

fn ids(reply: &Value) -> Vec<u64> {
    reply["built"]
        .as_array()
        .expect("built")
        .iter()
        .map(|step| step["id"].as_u64().expect("id"))
        .collect()
}

/// A new solid's root as `rootSpec` stands it: a box centred over the origin, on Z = 0.
fn box_root(size: f64) -> Value {
    flat_box(size, size)
}

/// A box `width` square and `height` tall, standing as a root does.
fn flat_box(width: f64, height: f64) -> Value {
    json!({ "primitive": "box", "origin": [-width / 2.0, -width / 2.0, 0.0], "size": [width, width, height] })
}

fn hole(radius: f64) -> Value {
    json!({ "kind": "hole", "origin": [0.0, 0.0, 20.0], "axis": [0.0, 0.0, -1.0], "radius": radius, "depth": 8.0 })
}

/// What a fillet of radius `r` along a straight edge `length` long takes off.
fn round_off(r: f64, length: f64) -> f64 {
    length * r * r * (1.0 - PI / 4.0)
}

#[test]
fn edit_steps() {
    let opened = call(json!({ "call": "open", "key": "e", "primitive": box_root(20.0) }));
    if opened.get("error").is_some() {
        assert!(!require(), "OCCT was required: {opened}");
        return;
    }
    near(volume(&opened), 8000.0);

    // Box 20, a hole ⌀4 depth 8 in the top, a fillet r1 on one 20 mm edge.
    let holed = ok(json!({ "call": "apply", "key": "e", "parent": 0, "node": 1, "op": hole(2.0) }));
    let hole_v = 8000.0 - PI * 4.0 * 8.0;
    near(volume(&holed), hole_v);
    let edge = edge_of_length(&holed, 20.0);
    let rounded = ok(json!({ "call": "apply", "key": "e", "parent": 1, "node": 2,
        "op": { "kind": "fillet", "edges": [edge], "size": 1.0 } }));
    near(volume(&rounded), hole_v - round_off(1.0, 20.0));
    let fillet_op = rounded["op"].clone();
    let old_fingerprints = [holed["fingerprint"].clone(), rounded["fingerprint"].clone()];

    // Edit the hole to ⌀6: a sibling of step 1 under the root, and the fillet replayed under it. The probe the panel
    // ran on the root is the edited step's solid; only the replayed tip is tessellated.
    let probe = ok(json!({ "call": "probe", "key": "e", "node": 0, "op": hole(3.0) }));
    assert_eq!(probe, json!({ "ok": true }));
    let before = tessellations();
    let started = Instant::now();
    let edited = ok(
        json!({ "call": "edit", "key": "e", "parent": 0, "node": 3, "op": hole(3.0),
        "replay": [{ "id": 4, "op": fillet_op }], "chordMm": 0.1 }),
    );
    let took = started.elapsed();
    assert_eq!(
        tessellations() - before,
        1,
        "only the replayed tip is tessellated"
    );
    assert_eq!(edited["id"], 4);
    assert_eq!(ids(&edited), [3, 4]);
    assert!(edited.get("broken").is_none(), "{edited}");
    let wider = 8000.0 - PI * 9.0 * 8.0;
    near(volume(&edited), wider - round_off(1.0, 20.0));
    let built = edited["built"].as_array().expect("built");
    assert_eq!(built[0]["op"]["radius"], 3.0);
    near(
        built[0]["fingerprint"]["volumeMm3"]
            .as_f64()
            .expect("volume"),
        wider,
    );
    assert_eq!(
        built[1]["op"]["edges"][0]["lengthMm"]
            .as_f64()
            .map(|length| (length - 20.0).abs() < 1e-6),
        Some(true),
        "the replayed fillet found its edge by midpoint and length: {built:?}"
    );
    assert!(
        edited["held"].as_array().expect("held").contains(&json!(4)),
        "{edited}"
    );
    eprintln!("edit of the hole with one step replayed: {took:?}");

    // The old branch is untouched: the same solids, the same fingerprints.
    let old_hole = ok(json!({ "call": "goto", "key": "e", "node": 1 }));
    assert_eq!(old_hole["fingerprint"], old_fingerprints[0]);
    near(volume(&old_hole), hole_v);
    let old_tip = ok(json!({ "call": "goto", "key": "e", "node": 2 }));
    assert_eq!(old_tip["fingerprint"], old_fingerprints[1]);
    near(volume(&old_tip), hole_v - round_off(1.0, 20.0));

    // Edit the root's primitive to a box 30 × 30 × 20: a `root` step under the root, which stays. The hole replays in
    // its top, and the fillet's 20 mm edge is on it no longer: that step is broken, the steps before it built.
    let mut root30 = flat_box(30.0, 20.0);
    root30["kind"] = json!("root");
    let rerooted = ok(
        json!({ "call": "edit", "key": "e", "parent": 0, "node": 5, "op": root30,
        "replay": [{ "id": 6, "op": holed["op"] }, { "id": 7, "op": rounded["op"] }, { "id": 8, "op": { "kind": "scale", "factor": 2.0 } }],
        "chordMm": 0.1 }),
    );
    assert_eq!(ids(&rerooted), [5, 6]);
    assert_eq!(rerooted["id"], 6, "the view is on the last step that built");
    let wide_hole = 18000.0 - PI * 4.0 * 8.0;
    near(volume(&rerooted), wide_hole);
    assert_eq!(rerooted["broken"]["id"], 7);
    assert_eq!(
        rerooted["broken"]["error"],
        "That edge is not on this solid"
    );
    let root = ok(json!({ "call": "goto", "key": "e", "node": 0 }));
    near(volume(&root), 8000.0);
    let broken = call(json!({ "call": "goto", "key": "e", "node": 8 }));
    assert_eq!(broken["broken"], 7, "{broken}");
    assert_eq!(broken["error"], "That edge is not on this solid");

    // Re-picking an edge of the new box fixes the broken fillet: an edit of step 7 forks it under step 6, and the
    // scale under it replays.
    let shown = ok(json!({ "call": "goto", "key": "e", "node": 6 }));
    let long = edge_of_length(&shown, 30.0);
    let fixed = ok(json!({ "call": "edit", "key": "e", "parent": 6, "node": 9,
        "op": { "kind": "fillet", "edges": [long], "size": 1.0 }, "replay": [{ "id": 10, "op": { "kind": "scale", "factor": 2.0 } }] }));
    assert_eq!(ids(&fixed), [9, 10]);
    near(volume(&fixed), (wide_hole - round_off(1.0, 30.0)) * 8.0);
    assert_eq!(
        call(json!({ "call": "goto", "key": "e", "node": 7 }))["broken"],
        7,
        "the old broken step stays broken"
    );

    // An edited step that does not build keeps nothing.
    let fails = refused(json!({ "call": "edit", "key": "e", "parent": 0, "node": 11,
        "op": { "kind": "fillet", "edges": [edge], "size": 30.0 }, "replay": [{ "id": 12, "op": hole(2.0) }] }));
    assert!(fails.contains("did not fit"), "{fails}");
    assert_eq!(
        call(json!({ "call": "goto", "key": "e", "node": 11 }))["missing"],
        json!([11])
    );
    assert_eq!(
        call(json!({ "call": "goto", "key": "e", "node": 12 }))["missing"],
        json!([12])
    );

    // Refusals: a node already in the tree, the same new id twice, a root step anywhere but under the root.
    assert!(refused(
        json!({ "call": "edit", "key": "e", "parent": 0, "node": 2, "op": hole(2.5) })
    )
    .contains("already"));
    assert!(refused(
        json!({ "call": "edit", "key": "e", "parent": 0, "node": 13, "op": hole(2.5),
        "replay": [{ "id": 13, "op": hole(1.0) }] })
    )
    .contains("already"));
    let mut root_low = box_root(25.0);
    root_low["kind"] = json!("root");
    assert_eq!(
        refused(json!({ "call": "edit", "key": "e", "parent": 1, "node": 13, "op": root_low })),
        "A new solid's primitive can only be built again right under its root"
    );
    assert_eq!(
        refused(
            json!({ "call": "edit", "key": "e", "parent": 0, "node": 13, "op": hole(2.5),
            "replay": [{ "id": 14, "op": root_low }] })
        ),
        "A new solid's primitive can only be built again right under its root"
    );
    assert_eq!(
        refused(json!({ "call": "apply", "key": "e", "parent": 1, "node": 13, "op": root_low })),
        "A new solid's primitive can only be built again right under its root"
    );
    assert_eq!(
        call(json!({ "call": "edit", "key": "e", "parent": 99, "node": 13, "op": hole(2.5) }))
            ["missing"],
        json!([99])
    );

    // A saved tree with an edit fork reopens with both branches, and the root step rebuilds from its numbers.
    let mut saved_root = flat_box(30.0, 20.0);
    saved_root["kind"] = json!("root");
    let reopened = ok(
        json!({ "call": "open", "key": "e2", "primitive": box_root(20.0), "current": 6,
        "nodes": [
            { "id": 1, "parent": 0, "op": holed["op"], "fingerprint": holed["fingerprint"] },
            { "id": 5, "parent": 0, "op": saved_root, "fingerprint": rerooted["built"][0]["fingerprint"] },
            { "id": 6, "parent": 5, "op": holed["op"], "fingerprint": rerooted["built"][1]["fingerprint"] },
        ] }),
    );
    near(volume(&reopened), wide_hole);
    near(
        volume(&ok(json!({ "call": "goto", "key": "e2", "node": 1 }))),
        hole_v,
    );

    // A replayed split builds its kept side only: no piece, and no tree for one.
    ok(json!({ "call": "open", "key": "s", "box": [10.0, 10.0, 10.0] }));
    let split = json!({ "kind": "split", "origin": [0.0, 0.0, 4.0], "normal": [0.0, 0.0, 1.0] });
    ok(
        json!({ "call": "apply", "key": "s", "parent": 0, "node": 1, "op": split, "otherKey": "s-piece" }),
    );
    let cut = json!({ "kind": "boolean", "op": "cut", "primitive": "box", "origin": [0.0, 0.0, 0.0], "size": [2.0, 2.0, 2.0] });
    ok(json!({ "call": "apply", "key": "s", "parent": 1, "node": 2, "op": cut }));
    let lower = json!({ "kind": "split", "origin": [0.0, 0.0, 6.0], "normal": [0.0, 0.0, 1.0] });
    let resplit = ok(
        json!({ "call": "edit", "key": "s", "parent": 0, "node": 3, "op": lower, "replay": [{ "id": 4, "op": cut }] }),
    );
    near(volume(&resplit), 600.0 - 8.0);
    assert!(resplit.get("other").is_none(), "{resplit}");
    near(
        volume(&ok(json!({ "call": "goto", "key": "s-piece", "node": 0 }))),
        600.0,
    );

    // A join replayed under an edit takes its tool from the step it named; a tool tree the engine lacks is asked
    // for before anything is built, and the tree stays as it was.
    ok(json!({ "call": "open", "key": "t", "box": [4.0, 4.0, 20.0] }));
    ok(json!({ "call": "open", "key": "a", "box": [10.0, 10.0, 10.0] }));
    let identity =
        json!({ "m": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0], "t": [0.0, 0.0, 0.0] });
    let join = json!({ "kind": "join", "op": "cut", "tool": { "key": "t", "node": 0 }, "relative": identity, "keepTool": false });
    ok(
        json!({ "call": "apply", "key": "a", "parent": 0, "node": 1, "op": { "kind": "scale", "factor": 2.0 } }),
    );
    let joined = ok(json!({ "call": "apply", "key": "a", "parent": 1, "node": 2, "op": join }));
    // Scaled 2 about its centre, the box spans -5 to 15; the tool cuts 4 x 4 of it from Z 0 to 15.
    near(volume(&joined), 8000.0 - 16.0 * 15.0);
    let rejoined = ok(
        json!({ "call": "edit", "key": "a", "parent": 0, "node": 3, "op": { "kind": "scale", "factor": 1.5 },
        "replay": [{ "id": 4, "op": join }] }),
    );
    near(volume(&rejoined), 3375.0 - 16.0 * 12.5);
    // The join's own op edited: a fuse adds the 5 mm of the tool that stands above the box.
    let mut fused = join.clone();
    fused["op"] = json!("fuse");
    let fused = ok(
        json!({ "call": "edit", "key": "a", "parent": 1, "node": 5, "op": fused, "chordMm": 0.1 }),
    );
    near(volume(&fused), 8000.0 + 16.0 * 5.0);
    let mut absent = join.clone();
    absent["tool"]["key"] = json!("gone");
    let missing = call(
        json!({ "call": "edit", "key": "a", "parent": 0, "node": 6, "op": { "kind": "scale", "factor": 1.2 },
        "replay": [{ "id": 7, "op": absent }] }),
    );
    assert_eq!(
        missing["missingTool"],
        json!({ "key": "gone", "node": 0 }),
        "{missing}"
    );
    assert_eq!(
        call(json!({ "call": "goto", "key": "a", "node": 6 }))["missing"],
        json!([6])
    );
}
