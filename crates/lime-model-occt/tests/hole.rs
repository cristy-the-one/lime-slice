//! A hole with Through all and a counterbore: each volume against a hand-computed one, a through hole replayed on a
//! part an earlier edit made taller, each refusal, and an old hole op stored as it was.
//! `LIME_REQUIRE_OCCT=1` makes a missing kernel a failure.
//!
//! The kernel's work counters are process-wide, so everything runs in one test, in order.

use std::f64::consts::PI;

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
    assert!(reply.get("error").is_none(), "{reply}");
    reply["volumeMm3"].as_f64().expect("volumeMm3")
}

fn near(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() < 0.01,
        "{actual} is not near {expected}"
    );
}

/// Shapes built and volumes integrated since the library loaded.
fn counts() -> [i64; 2] {
    let json: Value = serde_json::from_str(&lime_model_occt::stats()).expect("stats");
    ["builds", "volumes"].map(|key| json[key].as_i64().unwrap_or_else(|| panic!("{key}")))
}

/// Run `step` and return what it cost the kernel: shapes built, volumes integrated.
fn cost<T>(step: impl FnOnce() -> T) -> (T, [i64; 2]) {
    let before = counts();
    let out = step();
    let after = counts();
    (out, [after[0] - before[0], after[1] - before[1]])
}

fn apply(key: &str, parent: u32, node: u32, op: Value) -> Value {
    call(json!({ "call": "apply", "key": key, "parent": parent, "node": node, "op": op }))
}

fn refusal(key: &str, op: Value) -> String {
    let reply = apply(key, 0, 99, op.clone());
    reply["error"]
        .as_str()
        .unwrap_or_else(|| panic!("{op} was not refused: {reply}"))
        .to_string()
}

fn hole(origin: [f64; 3], axis: [f64; 3], radius: f64, depth: f64) -> Value {
    json!({ "kind": "hole", "origin": origin, "axis": axis, "radius": radius, "depth": depth })
}

fn through(origin: [f64; 3], axis: [f64; 3], radius: f64) -> Value {
    let mut op = hole(origin, axis, radius, 3.0);
    op["through"] = json!(true);
    op
}

fn counterbored(mut op: Value, radius: f64, depth: f64) -> Value {
    op["counterboreRadius"] = json!(radius);
    op["counterboreDepth"] = json!(depth);
    op
}

const DOWN: [f64; 3] = [0.0, 0.0, -1.0];
const UP: [f64; 3] = [0.0, 0.0, 1.0];

/// A cylinder's volume.
fn rod(radius: f64, length: f64) -> f64 {
    PI * radius * radius * length
}

#[test]
fn through_all_and_counterbore() {
    // A box 20 × 20 × 10 from the origin: 4000 mm³.
    let opened = call(json!({ "call": "open", "key": "h", "box": [20.0, 20.0, 10.0] }));
    if opened.get("error").is_some() {
        assert!(!require(), "OCCT was required: {opened}");
        return;
    }
    near(volume(&opened), 4000.0);

    // An op from before Through all and the counterbore is stored as it was: no new field appears.
    let plain = ok(
        json!({ "call": "apply", "key": "h", "parent": 0, "node": 1, "op": hole([10.0, 10.0, 10.0], DOWN, 2.0, 6.0) }),
    );
    near(volume(&plain), 4000.0 - rod(2.0, 6.0));
    assert_eq!(
        plain["op"],
        json!({ "kind": "hole", "origin": [10.0, 10.0, 10.0], "axis": DOWN, "radius": 2.0, "depth": 6.0 })
    );

    // Through all from the top: the whole 10 mm, whatever Depth says, in one cut and one volume.
    let top = through([10.0, 10.0, 10.0], DOWN, 2.0);
    let (down, work) = cost(|| apply("h", 0, 2, top.clone()));
    near(volume(&down), 4000.0 - rod(2.0, 10.0));
    assert_eq!(work, [1, 1], "one cut, one volume");
    assert_eq!(down["op"], top, "the flag is stored, not a length");
    // From a side face: the whole 20 mm across.
    near(
        volume(&apply(
            "h",
            0,
            3,
            through([20.0, 10.0, 5.0], [-1.0, 0.0, 0.0], 2.0),
        )),
        4000.0 - rod(2.0, 20.0),
    );

    // A counterbore with plain depth: ⌀6 × 3.2, then ⌀3.4 on to 8 mm deep.
    let bored = counterbored(hole([10.0, 10.0, 10.0], DOWN, 1.7, 8.0), 3.0, 3.2);
    let (counterbore, work) = cost(|| apply("h", 0, 4, bored.clone()));
    near(
        volume(&counterbore),
        4000.0 - rod(3.0, 3.2) - rod(1.7, 8.0 - 3.2),
    );
    assert_eq!(
        work,
        [2, 1],
        "the two cylinders fuse into one tool, cut once, one volume"
    );
    assert_eq!(counterbore["op"], bored);
    // And with Through all: ⌀3.4 on through the remaining 6.8 mm.
    near(
        volume(&apply(
            "h",
            0,
            5,
            counterbored(through([10.0, 10.0, 10.0], DOWN, 1.7), 3.0, 3.2),
        )),
        4000.0 - rod(3.0, 3.2) - rod(1.7, 10.0 - 3.2),
    );
    // A dry-run of a through counterbore is kept: its Apply builds nothing more.
    let side = counterbored(through([0.0, 10.0, 5.0], [1.0, 0.0, 0.0], 1.0), 2.0, 2.0);
    assert_eq!(
        ok(json!({ "call": "probe", "key": "h", "node": 0, "op": side })),
        json!({ "ok": true })
    );
    let (kept, work) = cost(|| apply("h", 0, 6, side.clone()));
    near(volume(&kept), 4000.0 - rod(2.0, 2.0) - rod(1.0, 18.0));
    assert_eq!(work, [0, 0], "the apply took the probe's solid");

    // Each refusal, in plain words.
    let wide = |radius: f64, depth: f64| {
        counterbored(hole([10.0, 10.0, 10.0], DOWN, 2.0, 6.0), radius, depth)
    };
    assert_eq!(
        refusal("h", wide(2.0, 2.0)),
        "The counterbore must be wider than the hole"
    );
    assert_eq!(
        refusal("h", wide(1.0, 2.0)),
        "The counterbore must be wider than the hole"
    );
    assert_eq!(
        refusal("h", wide(4.0, 0.0)),
        "The counterbore needs a positive depth"
    );
    assert_eq!(
        refusal("h", wide(4.0, -1.0)),
        "The counterbore needs a positive depth"
    );
    assert_eq!(
        refusal("h", wide(4.0, 6.0)),
        "The counterbore must be shallower than the hole"
    );
    let mut half = hole([10.0, 10.0, 10.0], DOWN, 2.0, 6.0);
    half["counterboreRadius"] = json!(4.0);
    assert_eq!(refusal("h", half), "The counterbore needs a positive depth");
    assert_eq!(
        refusal("h", through([10.0, 10.0, 10.0], DOWN, 0.0)),
        "A hole needs a positive radius"
    );
    // A counterbore as deep as the part, or deeper, under Through all is no hole under a bore.
    assert_eq!(
        refusal(
            "h",
            counterbored(through([10.0, 10.0, 10.0], DOWN, 2.0), 4.0, 10.0)
        ),
        "The counterbore must be shallower than the hole"
    );
    // Through all with no depth, or a negative one, still drills: Depth is not read.
    for (node, depth) in [(7, 0.0), (8, -1.0)] {
        let mut op = through([10.0, 10.0, 10.0], DOWN, 2.0);
        op["depth"] = json!(depth);
        near(volume(&apply("h", 0, node, op)), 4000.0 - rod(2.0, 10.0));
    }
    assert_eq!(
        refusal("h", through([10.0, 10.0, 12.0], UP, 2.0)),
        "The hole missed this solid"
    );
    assert_eq!(
        call(
            json!({ "call": "probe", "key": "h", "node": 0, "op": through([10.0, 10.0, 12.0], UP, 2.0) })
        ),
        json!({ "ok": false, "error": "The hole missed this solid" })
    );
    ok(json!({ "call": "close", "key": "h" }));

    // A part made taller by an earlier step: a through hole up from the bottom goes all the way, and still does after
    // that step is edited taller again and the hole replays on it.
    ok(json!({ "call": "open", "key": "t", "box": [20.0, 20.0, 10.0] }));
    let raise = |height: f64| json!({ "kind": "boolean", "op": "fuse", "primitive": "box", "origin": [0.0, 0.0, 10.0], "size": [20.0, 20.0, height] });
    let raised =
        ok(json!({ "call": "apply", "key": "t", "parent": 0, "node": 1, "op": raise(10.0) }));
    near(volume(&raised), 8000.0);
    let bottom = counterbored(through([10.0, 10.0, 0.0], UP, 2.0), 3.0, 4.0);
    let drilled = ok(json!({ "call": "apply", "key": "t", "parent": 1, "node": 2, "op": bottom }));
    near(volume(&drilled), 8000.0 - rod(3.0, 4.0) - rod(2.0, 16.0));
    let edited = ok(
        json!({ "call": "edit", "key": "t", "parent": 0, "node": 3, "op": raise(20.0), "replay": [{ "id": 4, "op": drilled["op"] }] }),
    );
    near(volume(&edited), 12000.0 - rod(3.0, 4.0) - rod(2.0, 26.0));
    // The whole tree from its root and ops, as a reopened project replays it, builds the same steps.
    let reopened = ok(
        json!({ "call": "open", "key": "t2", "box": [20.0, 20.0, 10.0], "current": 4, "nodes": [
        { "id": 1, "parent": 0, "op": raised["op"], "fingerprint": raised["fingerprint"] },
        { "id": 2, "parent": 1, "op": drilled["op"], "fingerprint": drilled["fingerprint"] },
        { "id": 3, "parent": 0, "op": edited["built"][0]["op"], "fingerprint": edited["built"][0]["fingerprint"] },
        { "id": 4, "parent": 3, "op": edited["built"][1]["op"], "fingerprint": edited["built"][1]["fingerprint"] },
    ] }),
    );
    near(volume(&reopened), 12000.0 - rod(3.0, 4.0) - rod(2.0, 26.0));
    near(
        volume(&ok(json!({ "call": "goto", "key": "t2", "node": 2 }))),
        8000.0 - rod(3.0, 4.0) - rod(2.0, 16.0),
    );
    ok(json!({ "call": "close", "key": "t" }));
    ok(json!({ "call": "close", "key": "t2" }));
}
