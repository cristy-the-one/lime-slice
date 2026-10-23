//! Split to print through the history tree, as the app and the MCP server send it: the op, its pieces each opening a
//! tree of their own, the order, a replay, an edit, a rebuilt piece's kept steps, the probe's pieces, and this
//! milestone's refusals.
//! `LIME_REQUIRE_OCCT=1` makes a missing kernel a failure.
//!
//! The store is process-wide, so everything runs in one test, in order.

use std::f64::consts::PI;

use serde_json::{json, Value};

const PROFILE_LATER: &str =
    "Only straight cuts are built yet. Leave the profile out, or make it straight.";
const KEYS_LATER: &str = "Key and dovetail connectors are not built yet. They come with the zig-zag and dovetail profiles. Use a dowel, a plug, or a hardware hole.";

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
    reply["volumeMm3"]
        .as_f64()
        .unwrap_or_else(|| panic!("volumeMm3 in {reply}"))
}

fn within(actual: f64, expected: f64, tolerance: f64) {
    assert!(
        (actual - expected).abs() <= tolerance,
        "{actual} is not within {tolerance} of {expected}"
    );
}

/// A straight cut across X at `x`, as the planner writes it.
fn across_x(x: f64) -> Value {
    json!({ "origin": [x, 5.0, 5.0], "normal": [1.0, 0.0, 0.0], "u": [0.0, 1.0, 0.0],
        "profile": { "kind": "straight" }, "connectors": { "on": false } })
}

fn partition(cuts: &[f64]) -> Value {
    json!({
        "kind": "partition",
        "cuts": cuts.iter().map(|x| across_x(*x)).collect::<Vec<_>>(),
        "target": { "printer": "lime-220", "process": "fdm", "volumeMm": [220.0, 220.0, 250.0] },
        "orient": "keep",
        "arrange": true,
        "bedMarginMm": 5.0,
        "maxPieces": 12.0,
    })
}

fn apply(key: &str, node: u32, op: &Value, keys: Value) -> Value {
    call(
        json!({ "call": "apply", "key": key, "parent": 0, "node": node, "op": op, "pieceKeys": keys }),
    )
}

#[test]
fn split_to_print_in_the_history_tree() {
    let opened = call(json!({ "call": "open", "key": "bar", "box": [60.0, 10.0, 10.0] }));
    if opened["error"]
        .as_str()
        .is_some_and(|error| error.contains("OCCT_ROOT"))
    {
        assert!(
            std::env::var_os("LIME_REQUIRE_OCCT").is_none(),
            "Open CASCADE is required"
        );
        return;
    }
    assert!(opened.get("error").is_none(), "{opened}");
    within(volume(&opened), 6000.0, 1e-6);

    pieces_in_order_sum_to_the_parent();
    a_replay_keeps_the_first_piece_and_leaves_the_others();
    the_probe_measures_every_piece();
    an_edit_cuts_new_pieces();
    a_rebuilt_piece_keeps_its_later_steps();
    refusals_leave_the_solid_as_it_was();
    dowels_open_a_pins_tree();
}

/// Milestone 5. A dowel on the cut: the probe measures the pins and names the connector built; the apply opens the pins'
/// tree under `pinsKey`, stores only what was built, and an edit rebuilds the pins under a new key.
fn dowels_open_a_pins_tree() {
    let mut op = partition(&[30.0]);
    op["up"] = json!([0.0, 0.0, 1.0]);
    op["cuts"][0]["connectors"] = json!({
        "on": true,
        "types": [{ "type": "dowel", "radius": 2.0, "depth": 8.0, "clearance": 0.15, "endGap": 0.4, "hole": "round",
            "count": "fit", "margin": 4.0, "place": "fit", "at": [] }],
        "placed": [
            { "id": "c1-1", "type": "dowel", "uvMm": [0.0, 0.0], "fraction": [0.5, 0.5], "fixed": false },
            { "id": "c1-2", "type": "dowel", "uvMm": [0.0, 0.0], "fraction": [0.05, 0.5], "fixed": false }
        ]
    });
    ok(json!({ "call": "open", "key": "dowel-bar", "box": [60.0, 10.0, 10.0] }));
    let probe = ok(json!({ "call": "probe", "key": "dowel-bar", "node": 0, "op": op }));
    let pin = PI * 4.0 * 8.0 - 2.0 * PI * 0.25 * (2.0 - 0.5 / 3.0);
    within(
        probe["pins"]["volumeMm3"].as_f64().expect("pins"),
        pin,
        1e-6,
    );
    assert_eq!(probe["pins"]["count"], 1);
    assert_eq!(probe["connectors"]["placed"][0]["id"], "c1-1");
    assert_eq!(probe["connectors"]["dropped"][0]["id"], "c1-2");
    let applied = call(
        json!({ "call": "apply", "key": "dowel-bar", "parent": 0, "node": 30, "op": op,
        "pieceKeys": ["bar-d2"], "pinsKey": "bar-pins" }),
    );
    assert!(applied.get("error").is_none(), "{applied}");
    let hole = PI * 2.15 * 2.15 * 4.4;
    within(volume(&applied), 3000.0 - hole, 1e-6);
    within(volume(&applied["pieces"][0]), 3000.0 - hole, 1e-6);
    assert_eq!(applied["pins"]["key"], "bar-pins");
    within(volume(&applied["pins"]), pin, 1e-6);
    assert_eq!(
        applied["op"]["cuts"][0]["connectors"]["placed"]
            .as_array()
            .map(Vec::len),
        Some(1)
    );
    assert_eq!(
        applied["notes"],
        json!(["Cut 1: dowel 2 would break through the outline or a neighbour. It was left out."])
    );
    let pins = ok(json!({ "call": "goto", "key": "bar-pins", "node": 0 }));
    within(volume(&pins), pin, 1e-6);

    let mut longer = applied["op"].clone();
    longer["cuts"][0]["connectors"]["types"][0]["depth"] = json!(10.0);
    let edited = ok(
        json!({ "call": "edit", "key": "dowel-bar", "parent": 0, "node": 31, "op": longer,
        "pieceKeys": ["bar-d2b"], "pinsKey": "bar-pins-b" }),
    );
    assert_eq!(edited["pins"]["key"], "bar-pins-b");
    within(
        volume(&edited["pins"]),
        PI * 4.0 * 10.0 - 2.0 * PI * 0.25 * (2.0 - 0.5 / 3.0),
        1e-6,
    );
    ok(json!({ "call": "goto", "key": "dowel-bar", "node": 0 }));
    for key in ["bar-d2", "bar-pins", "bar-d2b", "bar-pins-b", "dowel-bar"] {
        ok(json!({ "call": "close", "key": key }));
    }
}

/// Cuts at X 10 and 30 make 10, 20 and 30 mm long pieces: 1000, 2000 and 3000 mm³, negative side first.
fn pieces_in_order_sum_to_the_parent() {
    let op = partition(&[10.0, 30.0]);
    let applied = apply("bar", 1, &op, json!(["bar-2", "bar-3"]));
    assert!(applied.get("error").is_none(), "{applied}");
    assert_eq!(applied["parts"], 3);
    within(volume(&applied), 1000.0, 1e-6);
    let pieces = applied["pieces"].as_array().expect("pieces");
    assert_eq!(pieces.len(), 2, "{applied}");
    assert_eq!([&pieces[0]["key"], &pieces[1]["key"]], ["bar-2", "bar-3"]);
    assert_eq!([&pieces[0]["part"], &pieces[1]["part"]], [2, 3]);
    assert_eq!(
        [&pieces[0]["id"], &pieces[1]["id"]],
        [0, 0],
        "each piece is its tree's root"
    );
    within(volume(&pieces[0]), 2000.0, 1e-6);
    within(volume(&pieces[1]), 3000.0, 1e-6);
    within(
        volume(&applied) + volume(&pieces[0]) + volume(&pieces[1]),
        6000.0,
        1e-6,
    );
    assert_eq!(applied["op"], op, "the op is stored as sent");

    let retried = apply("bar", 1, &op, json!(["bar-2", "bar-3"]));
    assert_eq!(retried["fingerprint"], applied["fingerprint"], "{retried}");
    let elsewhere = apply("bar", 1, &op, json!(["bar-2", "other"]));
    assert!(
        elsewhere["error"]
            .as_str()
            .unwrap_or("")
            .contains("already"),
        "{elsewhere}"
    );
    for (key, piece) in [("bar-2", &pieces[0]), ("bar-3", &pieces[1])] {
        let root = ok(json!({ "call": "goto", "key": key, "node": 0 }));
        assert_eq!(root["fingerprint"], piece["fingerprint"]);
    }
    let drilled = ok(
        json!({ "call": "apply", "key": "bar-3", "parent": 0, "node": 1,
        "op": { "kind": "hole", "origin": [45.0, 5.0, 10.0], "radius": 1.0, "depth": 20.0 } }),
    );
    within(volume(&drilled), 3000.0 - std::f64::consts::PI * 10.0, 0.05);

    // Unkeyed pieces are left unseen; a null key leaves only that one.
    let one = apply("bar", 2, &op, json!([null, "bar-3b"]));
    let pieces = one["pieces"].as_array().expect("pieces");
    assert!(pieces[0].is_null(), "{one}");
    assert_eq!(pieces[1]["key"], "bar-3b");
    let none = ok(json!({ "call": "apply", "key": "bar", "parent": 0, "node": 3, "op": op }));
    assert_eq!(none["parts"], 3);
    assert!(none.get("pieces").is_none(), "{none}");
    for node in [2, 3] {
        ok(json!({ "call": "drop", "key": "bar", "node": node }));
    }
    ok(json!({ "call": "close", "key": "bar-3b" }));
}

fn a_replay_keeps_the_first_piece_and_leaves_the_others() {
    let piece = ok(json!({ "call": "goto", "key": "bar-2", "node": 0 }));
    lime_model_occt::set_tree_limits(0, 0);
    ok(json!({ "call": "goto", "key": "bar", "node": 0 }));
    let replayed = ok(json!({ "call": "goto", "key": "bar", "node": 1 }));
    assert_eq!(replayed["replayed"], 1);
    within(volume(&replayed), 1000.0, 1e-6);
    assert!(replayed.get("pieces").is_none(), "a jump sends no piece");
    lime_model_occt::set_tree_limits(24, 8);
    let again = ok(json!({ "call": "goto", "key": "bar-2", "node": 0 }));
    assert_eq!(
        again["fingerprint"], piece["fingerprint"],
        "the piece's tree is untouched"
    );
    let drilled = ok(json!({ "call": "goto", "key": "bar-3", "node": 1 }));
    within(volume(&drilled), 3000.0 - std::f64::consts::PI * 10.0, 0.05);
}

fn the_probe_measures_every_piece() {
    let probed =
        ok(json!({ "call": "probe", "key": "bar", "node": 0, "op": partition(&[20.0, 40.0]) }));
    assert_eq!(probed["ok"], true, "{probed}");
    let parts = probed["parts"].as_array().expect("parts");
    assert_eq!(parts.len(), 3);
    for (part, [from, to]) in parts.iter().zip([[0.0, 20.0], [20.0, 40.0], [40.0, 60.0]]) {
        within(volume(part), 2000.0, 1e-6);
        within(part["min"][0].as_f64().expect("min"), from, 1e-6);
        within(part["max"][0].as_f64().expect("max"), to, 1e-6);
        within(part["max"][1].as_f64().expect("max"), 10.0, 1e-6);
    }
}

/// D9: the edited step makes its own pieces, under the keys the edit sends, in one call.
fn an_edit_cuts_new_pieces() {
    let edited = ok(
        json!({ "call": "edit", "key": "bar", "parent": 0, "node": 4,
        "op": partition(&[25.0]), "pieceKeys": ["bar-2e", null] }),
    );
    assert_eq!(edited["parts"], 2);
    within(volume(&edited), 2500.0, 1e-6);
    let pieces = edited["pieces"].as_array().expect("pieces");
    assert_eq!(pieces.len(), 1, "{edited}");
    assert_eq!(pieces[0]["key"], "bar-2e");
    within(volume(&pieces[0]), 3500.0, 1e-6);
    let root = ok(json!({ "call": "goto", "key": "bar-2e", "node": 0 }));
    within(volume(&root), 3500.0, 1e-6);
    let short = call(
        json!({ "call": "edit", "key": "bar", "parent": 0, "node": 5,
        "op": partition(&[10.0, 20.0, 30.0]), "pieceKeys": ["bar-a"] }),
    );
    assert_eq!(
        short,
        json!({ "error": "This cut makes 4 pieces, and keys came for 2." })
    );
    let unkept = call(json!({ "call": "goto", "key": "bar", "node": 5 }));
    assert_eq!(
        unkept,
        json!({ "error": "unknown", "missing": [5] }),
        "a refused edit keeps nothing"
    );
    ok(json!({ "call": "goto", "key": "bar", "node": 1 }));
}

/// D9: piece 3 had a hole at X 45 and a scale after it. An edit that cuts it from X 50 to 60 replays both on the new
/// piece; the hole misses it. Without `keepBroken` the replay keeps nothing; with it, the hole is kept broken, the scale
/// unbuilt under it, and the piece shows its new root, so the user's later steps stay in its tree.
fn a_rebuilt_piece_keeps_its_later_steps() {
    let edited = ok(
        json!({ "call": "edit", "key": "bar", "parent": 0, "node": 6,
        "op": partition(&[10.0, 50.0]), "pieceKeys": ["bar-2k", "bar-3k"] }),
    );
    let pieces = edited["pieces"].as_array().expect("pieces");
    assert_eq!(pieces[1]["key"], "bar-3k");
    within(volume(&pieces[1]), 1000.0, 1e-6);

    let hole = json!({ "kind": "hole", "origin": [45.0, 5.0, 10.0], "radius": 1.0, "depth": 20.0 });
    let replay = json!([{ "id": 2, "op": { "kind": "scale", "factor": 1.1 } }]);
    let replayed = |keep: bool| {
        call(
            json!({ "call": "edit", "key": "bar-3k", "parent": 0, "node": 1, "op": hole, "replay": replay, "keepBroken": keep }),
        )
    };
    let lost = replayed(false);
    assert!(
        lost["error"].as_str().unwrap_or("").contains("missed"),
        "{lost}"
    );
    let unkept = call(json!({ "call": "goto", "key": "bar-3k", "node": 1 }));
    assert_eq!(
        unkept,
        json!({ "error": "unknown", "missing": [1] }),
        "without keepBroken nothing is kept"
    );

    let kept = replayed(true);
    assert!(kept.get("error").is_none(), "{kept}");
    assert_eq!(kept["id"], 0, "the piece shows its new root: {kept}");
    within(volume(&kept), 1000.0, 1e-6);
    assert_eq!(kept["built"], json!([]), "{kept}");
    let broken = &kept["broken"];
    assert_eq!(broken["id"], 1, "{kept}");
    assert!(
        broken["error"].as_str().unwrap_or("").contains("missed"),
        "the row says why: {kept}"
    );
    for node in [1, 2] {
        let jump = call(json!({ "call": "goto", "key": "bar-3k", "node": node }));
        assert_eq!(
            jump["broken"], 1,
            "step {node} is kept, under the broken hole: {jump}"
        );
    }
    let root = ok(json!({ "call": "goto", "key": "bar-3k", "node": 0 }));
    within(volume(&root), 1000.0, 1e-6);

    let tools = call(
        json!({ "call": "edit", "key": "bar-3k", "parent": 0, "node": 3, "op": hole, "keepBroken": true,
        "tools": [{ "key": "bar-2k", "parent": 0, "node": 1, "op": { "kind": "scale", "factor": 1.1 } }] }),
    );
    assert_eq!(
        tools,
        json!({ "error": "keepBroken is only for an edit of one tree" })
    );
    ok(json!({ "call": "goto", "key": "bar", "node": 1 }));
    for key in ["bar-2k", "bar-3k"] {
        ok(json!({ "call": "close", "key": key }));
    }
}

fn refusals_leave_the_solid_as_it_was() {
    let refused = |op: Value, sentence: &str| {
        let reply = apply("bar", 9, &op, json!([]));
        assert_eq!(reply, json!({ "error": sentence }), "{op}");
        let probe = call(json!({ "call": "probe", "key": "bar", "node": 0, "op": op }));
        assert_eq!(probe, json!({ "ok": false, "error": sentence }));
    };
    let mut lap = partition(&[30.0]);
    lap["cuts"][0]["profile"] = json!({ "kind": "lap", "depth": 8.0 });
    refused(lap, PROFILE_LATER);
    let mut sketch = partition(&[30.0]);
    sketch["cuts"][0]["profile"] = json!({ "kind": "sketch", "sketch": { "v": 1 } });
    refused(sketch, PROFILE_LATER);
    for kind in ["key", "dovetail"] {
        let mut keyed = partition(&[30.0]);
        keyed["cuts"][0]["connectors"] = json!({ "on": true, "types": [{ "type": kind }] });
        refused(keyed, KEYS_LATER);
    }
    let mut three = partition(&[10.0, 20.0, 30.0]);
    three["maxPieces"] = json!(3.0);
    refused(three, "This cut makes 4 pieces. Max pieces is 3.");
    let mut many = partition(&[
        4.0, 8.0, 12.0, 16.0, 20.0, 24.0, 28.0, 32.0, 36.0, 40.0, 44.0, 48.0,
    ]);
    many.as_object_mut().expect("op").remove("maxPieces");
    refused(many, "This cut makes 13 pieces. Max pieces is 12.");

    let off_with_types = {
        let mut op = partition(&[30.0]);
        op["cuts"][0]["connectors"] = json!({ "on": false, "types": [{ "type": "dowel" }] });
        op
    };
    let plain = apply("bar", 10, &off_with_types, json!([]));
    assert!(
        plain.get("error").is_none(),
        "connectors off is a plain cut: {plain}"
    );
    ok(json!({ "call": "drop", "key": "bar", "node": 10 }));

    let crossed = call(
        json!({ "call": "apply", "key": "bar", "parent": 0, "node": 11,
        "op": { "kind": "scale", "factor": 2.0 }, "pieceKeys": ["x"] }),
    );
    assert_eq!(
        crossed,
        json!({ "error": "pieceKeys is only for a split to print" })
    );
    let own = apply("bar", 11, &partition(&[30.0]), json!(["bar"]));
    assert_eq!(own, json!({ "error": "Each piece needs a key of its own" }));
    let short = apply("bar", 11, &partition(&[10.0, 30.0]), json!(["only"]));
    assert_eq!(
        short,
        json!({ "error": "This cut makes 3 pieces, and keys came for 2." })
    );
    let grouped = call(
        json!({ "call": "apply", "key": "bar", "parent": 0, "node": 11,
        "op": { "kind": "group", "label": "Two", "steps": [partition(&[30.0])] } }),
    );
    assert_eq!(
        grouped["error"],
        "Step 1 of 1: A group cannot contain a split to print."
    );

    let still = ok(json!({ "call": "goto", "key": "bar", "node": 0 }));
    within(volume(&still), 6000.0, 1e-6);
    for key in ["bar", "bar-2", "bar-3", "bar-2e"] {
        ok(json!({ "call": "close", "key": key }));
    }
}
