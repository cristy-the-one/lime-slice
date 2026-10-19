//! A group is one history node for several edits.
//! Three box cuts in one group equal three separate nodes in volume. A failing second step names
//! "Step 2 of 3". A step whose tool misses the solid is skipped. A group replays from saved nodes
//! with the same fingerprint.
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
    let reply = call(request.clone());
    assert!(reply.get("error").is_none(), "{request} -> {reply}");
    reply
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

fn cut(origin: [f64; 3], size: [f64; 3]) -> Value {
    json!({
        "kind": "boolean",
        "op": "cut",
        "primitive": "box",
        "origin": origin,
        "size": size,
    })
}

fn group(label: &str, source: Option<Value>, steps: Vec<Value>) -> Value {
    let mut op = json!({ "kind": "group", "label": label, "steps": steps });
    if let Some(source) = source {
        op["source"] = source;
    }
    op
}

#[test]
fn three_cuts_one_row() {
    let opened = call(json!({ "call": "open", "key": "g", "box": [10.0, 10.0, 10.0] }));
    if opened.get("error").is_some() {
        assert!(!require(), "OCCT was required: {opened}");
        return;
    }
    near(volume(&opened), 1000.0);

    let cuts = [
        cut([0.0, 0.0, 8.0], [10.0, 10.0, 2.0]),
        cut([0.0, 0.0, 6.0], [10.0, 10.0, 2.0]),
        cut([0.0, 0.0, 4.0], [10.0, 10.0, 2.0]),
    ];
    let mut parent = 0u32;
    let mut separate = json!(null);
    for (i, step) in cuts.iter().enumerate() {
        let node = (i + 1) as u32;
        separate = ok(json!({ "call": "apply", "key": "g", "parent": parent, "node": node, "op": step }));
        parent = node;
    }
    near(volume(&separate), 400.0);

    let source = json!({ "kind": "pocket", "width": 10 });
    let once = group("Pocket 10 × 10", Some(source.clone()), cuts.to_vec());
    let probed = ok(json!({ "call": "probe", "key": "g", "node": 0, "op": once }));
    assert_eq!(probed["ok"], json!(true), "{probed}");
    near(probed["volumeMm3"].as_f64().unwrap(), 400.0);
    assert_eq!(probed["skipped"], json!(0), "{probed}");
    assert!(probed.get("before").is_some(), "{probed}");

    let applied = ok(json!({ "call": "apply", "key": "g", "parent": 0, "node": 4, "op": once }));
    near(volume(&applied), 400.0);
    assert_eq!(applied["fingerprint"]["volumeMm3"], separate["fingerprint"]["volumeMm3"]);
    assert_eq!(applied["op"]["kind"], "group");
    assert_eq!(applied["op"]["label"], "Pocket 10 × 10");
    assert_eq!(applied["op"]["source"], source);
    assert_eq!(applied["op"]["steps"].as_array().map(Vec::len), Some(3));
    // `source` is the composite as typed. The same steps with another source are the same node.
    let again = group("Other name", Some(json!({ "kind": "pocket", "width": 12 })), cuts.to_vec());
    let jumped = ok(json!({ "call": "apply", "key": "g", "parent": 0, "node": 4, "op": again }));
    assert_eq!(jumped["id"], 4, "same steps jump to the group already built");

    // The second tool never meets the solid: it is left out, and the other two cuts still land.
    let missed = group(
        "One misses",
        None,
        vec![
            cuts[0].clone(),
            cut([100.0, 0.0, 0.0], [10.0, 10.0, 2.0]),
            cuts[2].clone(),
        ],
    );
    let skipped = ok(json!({ "call": "probe", "key": "g", "node": 0, "op": missed }));
    assert_eq!(skipped["ok"], json!(true), "{skipped}");
    assert_eq!(skipped["skipped"], json!(1), "{skipped}");
    near(skipped["volumeMm3"].as_f64().unwrap(), 600.0);
    let kept = ok(json!({ "call": "apply", "key": "g", "parent": 0, "node": 5, "op": missed }));
    near(volume(&kept), 600.0);
    assert!(kept["op"].get("source").is_none(), "an absent source stays absent: {}", kept["op"]);

    // The second step cannot be built. The sentence names it, and says which.
    let bad = group(
        "Bad",
        None,
        vec![
            cuts[0].clone(),
            cut([0.0, 0.0, 6.0], [0.0, 10.0, 2.0]),
            cuts[2].clone(),
        ],
    );
    let refused = call(json!({ "call": "probe", "key": "g", "node": 0, "op": bad }));
    assert_eq!(refused["ok"], json!(false), "{refused}");
    assert_eq!(refused["failedStep"], json!(2), "{refused}");
    let error = refused["error"].as_str().unwrap_or("");
    assert!(error.starts_with("Step 2 of 3:"), "{refused}");
    let applied_bad = call(json!({ "call": "apply", "key": "g", "parent": 0, "node": 6, "op": bad }));
    assert_eq!(applied_bad["failedStep"], json!(2), "{applied_bad}");
    assert!(
        applied_bad["error"].as_str().unwrap_or("").starts_with("Step 2 of 3:"),
        "{applied_bad}"
    );

    for (op, sentence) in [
        (json!({ "kind": "split", "origin": [0.0, 0.0, 5.0], "normal": [0.0, 0.0, 1.0] }), "A group cannot contain a split."),
        (json!({ "kind": "scale", "factor": 2.0 }), "A group cannot contain a scale."),
        (json!({ "kind": "group", "label": "inner", "steps": [cuts[0].clone()] }), "A group cannot contain another group."),
        (json!({ "kind": "fillet", "edges": [0], "size": 1.0 }), "A fillet inside a group needs edges named by their place, not by a number."),
    ] {
        let reply = call(json!({ "call": "probe", "key": "g", "node": 0, "op": group("no", None, vec![op]) }));
        assert_eq!(reply["failedStep"], json!(1), "{reply}");
        assert!(
            reply["error"].as_str().unwrap_or("").contains(sentence),
            "{reply}"
        );
    }
    let empty = call(json!({ "call": "probe", "key": "g", "node": 0, "op": group("empty", None, vec![]) }));
    assert_eq!(empty["error"], "A group needs at least one step.", "{empty}");
    assert!(empty.get("failedStep").is_none(), "{empty}");

    // Saved and opened again, the group rebuilds to the fingerprint it was given.
    let reopened = ok(json!({
        "call": "open",
        "key": "g2",
        "box": [10.0, 10.0, 10.0],
        "current": 4,
        "nodes": [{ "id": 4, "parent": 0, "op": applied["op"], "fingerprint": applied["fingerprint"] }],
    }));
    near(volume(&reopened), 400.0);
    assert_eq!(reopened["fingerprint"], applied["fingerprint"], "{reopened}");
    ok(json!({ "call": "close", "key": "g" }));
    ok(json!({ "call": "close", "key": "g2" }));
}

/// --- D20. A new group whose every step misses changes nothing, so it is refused; a saved one still replays.
#[test]
fn a_new_group_that_misses_everywhere_is_refused() {
    let opened = call(json!({ "call": "open", "key": "gm", "box": [10.0, 10.0, 10.0] }));
    if opened.get("error").is_some() {
        assert!(!require(), "OCCT was required: {opened}");
        return;
    }
    let away = group(
        "Pattern × 2",
        None,
        vec![
            cut([100.0, 0.0, 0.0], [10.0, 10.0, 2.0]),
            cut([200.0, 0.0, 0.0], [10.0, 10.0, 2.0]),
        ],
    );
    let expected = json!("None of its 2 steps changes the part.");
    let probed = call(json!({ "call": "probe", "key": "gm", "node": 0, "op": away }));
    assert_eq!(probed["error"], expected, "{probed}");
    let applied = call(json!({ "call": "apply", "key": "gm", "parent": 0, "node": 1, "op": away }));
    assert_eq!(applied["error"], expected, "{applied}");
    let one = group("One", None, vec![cut([100.0, 0.0, 0.0], [10.0, 10.0, 2.0])]);
    let single = call(json!({ "call": "probe", "key": "gm", "node": 0, "op": one }));
    assert_eq!(single["error"], json!("Its one step does not change the part."), "{single}");

    // An edit to a group that misses everywhere is refused the same way.
    let hit = group("Pattern × 1", None, vec![cut([0.0, 0.0, 8.0], [10.0, 10.0, 2.0])]);
    near(volume(&ok(json!({ "call": "apply", "key": "gm", "parent": 0, "node": 2, "op": hit }))), 800.0);
    let edited = call(json!({ "call": "edit", "key": "gm", "parent": 0, "node": 3, "op": away, "replay": [], "chordMm": 0.1 }));
    assert_eq!(edited["error"], expected, "{edited}");

    // A saved group whose steps all miss still opens: a part must open as it was saved.
    let reopened = ok(json!({
        "call": "open", "key": "gm2", "box": [10.0, 10.0, 10.0],
        "nodes": [{ "id": 1, "parent": 0, "op": away }], "current": 1,
    }));
    near(volume(&reopened), 1000.0);
}
