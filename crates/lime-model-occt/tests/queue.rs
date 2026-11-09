//! --- docs/plan-native-recipes.md 7.1. A recipe's queued booleans: a plain tool's box built alone (`toolBox`), queued
//! groups that say which extrude changed nothing (`combined.missed`), and the groups stored as the recipe sent them
//! (`unfold`): one step per op in order, the last with the groups' solid, the same fingerprint as building the ops one
//! by one, and a middle step that builds when it is shown. `LIME_REQUIRE_OCCT=1` makes a missing kernel a failure.

use serde_json::{json, Value};

fn call(request: Value) -> Value {
    let text = lime_model_occt::tree(&request.to_string());
    serde_json::from_str(&text).unwrap_or_else(|err| panic!("not JSON ({err}): {text}"))
}

fn ok(reply: Value) -> Value {
    assert!(reply.get("error").is_none(), "{reply}");
    reply
}

fn pocket(x: f64, y: f64) -> Value {
    json!({ "kind": "boolean", "op": "cut", "primitive": "box", "origin": [x, y, 6.0], "size": [4.0, 4.0, 10.0] })
}

fn stud(x: f64, y: f64) -> Value {
    json!({ "kind": "boolean", "op": "fuse", "primitive": "cylinder", "origin": [x, y, 9.0], "radius": 1.5, "height": 4.0 })
}

/// A square extruded cut of side 2 at (x, y), from z = 8 up by 4.
fn notch(x: f64, y: f64) -> Value {
    json!({ "kind": "extrude", "op": "cut", "origin": [x, y, 8.0], "turn": [0.0, 0.0, 0.0], "profile": [[-1.0, -1.0], [1.0, -1.0], [1.0, 1.0], [-1.0, 1.0]], "depth": 4.0 })
}

fn queued(which: &str, steps: &[Value]) -> Value {
    json!({ "kind": "group", "label": "queued", "source": { "kind": "queue", "ops": steps.len() }, "steps": steps, "combine": which })
}

fn opened(key: &str) -> Option<Value> {
    let reply = call(json!({ "call": "open", "key": key, "box": [40.0, 40.0, 10.0] }));
    if reply.get("error").is_some() {
        assert!(std::env::var_os("LIME_REQUIRE_OCCT").is_none(), "OCCT was required: {reply}");
        return None;
    }
    Some(reply)
}

#[test]
fn a_tool_alone_has_its_box() {
    if opened("queue-box").is_none() {
        return;
    }
    let boxed = ok(call(json!({ "call": "toolBox", "op": pocket(2.0, 3.0) })));
    let near = |a: &Value, b: [f64; 3]| (0..3).all(|i| (a[i].as_f64().unwrap() - b[i]).abs() < 1e-3);
    assert!(near(&boxed["min"], [2.0, 3.0, 6.0]) && near(&boxed["max"], [6.0, 7.0, 16.0]), "{boxed}");
    let fillet = call(json!({ "call": "toolBox", "op": { "kind": "fillet", "edges": [1], "size": 1.0 } }));
    assert!(fillet.get("error").is_some(), "a fillet has no tool of its own: {fillet}");
}

#[test]
fn queued_groups_unfold_into_the_steps_one_by_one_would_store() {
    if opened("queue-groups").is_none() {
        return;
    }
    // The recipe's order: pocket, stud, pocket, stud. Queued: the pockets in one cut, the studs in one fuse.
    let sent = [pocket(2.0, 2.0), stud(30.0, 30.0), pocket(12.0, 22.0), stud(20.0, 8.0)];
    let cuts = queued("cut", &[sent[0].clone(), sent[2].clone()]);
    let fuses = queued("fuse", &[sent[1].clone(), sent[3].clone()]);
    ok(call(json!({ "call": "apply", "key": "queue-groups", "parent": 0, "node": 1, "op": cuts })));
    ok(call(json!({ "call": "apply", "key": "queue-groups", "parent": 1, "node": 2, "op": fuses })));
    let nodes: Vec<Value> = sent.iter().enumerate().map(|(i, op)| json!({ "id": 3 + i, "op": op })).collect();

    // Ops that are not the groups' steps are refused, and nothing changes.
    let mut wrong = nodes.clone();
    wrong[3] = json!({ "id": 6, "op": stud(21.0, 8.0) });
    let refused = call(json!({ "call": "unfold", "key": "queue-groups", "from": 0, "last": 2, "nodes": wrong }));
    assert_eq!(refused["error"], json!("The steps to unfold are not the groups' steps"), "{refused}");

    let unfolded = ok(call(json!({ "call": "unfold", "key": "queue-groups", "from": 0, "last": 2, "nodes": nodes })));
    assert_eq!(unfolded["id"], json!(6), "{unfolded}");
    let gone = call(json!({ "call": "goto", "key": "queue-groups", "node": 1 }));
    assert!(gone.get("error").is_some(), "the groups are gone: {gone}");

    // One by one, in the order sent: the same solid.
    opened("queue-one").unwrap();
    let mut last = Value::Null;
    for (i, op) in sent.iter().enumerate() {
        last = ok(call(json!({ "call": "apply", "key": "queue-one", "parent": i, "node": i + 1, "op": op })));
    }
    let a = &unfolded["fingerprint"];
    let b = &last["fingerprint"];
    assert_eq!(a["faces"], b["faces"], "{a} {b}");
    assert_eq!(a["edges"], b["edges"], "{a} {b}");
    assert!((a["volumeMm3"].as_f64().unwrap() - b["volumeMm3"].as_f64().unwrap()).abs() < 1e-6, "{a} {b}");

    // A middle step held no solid: showing it builds it from the steps above, as one by one did.
    let middle = ok(call(json!({ "call": "goto", "key": "queue-groups", "node": 4 })));
    let alone = ok(call(json!({ "call": "goto", "key": "queue-one", "node": 2 })));
    assert_eq!(middle["fingerprint"], alone["fingerprint"], "{middle}\n{alone}");
    // And the last again.
    let tip = ok(call(json!({ "call": "goto", "key": "queue-groups", "node": 6 })));
    assert_eq!(tip["fingerprint"]["faces"], b["faces"]);
}

#[test]
fn a_queued_extrude_that_changes_nothing_is_named() {
    if opened("queue-miss").is_none() {
        return;
    }
    // The second notch is above the box (z 8..12 on a 10 mm box, at a corner the first does not reach): it cuts. The
    // third floats clear above the box: alone it is refused, in the group it is named by its place.
    let high = json!({ "kind": "extrude", "op": "cut", "origin": [20.0, 20.0, 14.0], "turn": [0.0, 0.0, 0.0], "profile": [[-1.0, -1.0], [1.0, -1.0], [1.0, 1.0], [-1.0, 1.0]], "depth": 2.0 });
    let alone = call(json!({ "call": "apply", "key": "queue-miss", "parent": 0, "node": 1, "op": high }));
    assert!(alone.get("error").is_some(), "alone it changes nothing: {alone}");
    let group = queued("cut", &[notch(5.0, 5.0), notch(30.0, 30.0), high]);
    let built = ok(call(json!({ "call": "apply", "key": "queue-miss", "parent": 0, "node": 2, "op": group })));
    assert_eq!(built["combined"]["missed"], json!([2]), "{built}");
    // A plain boolean that misses is an ordinary step either way: not named.
    let far = json!({ "kind": "boolean", "op": "cut", "primitive": "box", "origin": [60.0, 60.0, 0.0], "size": [2.0, 2.0, 2.0] });
    let plain = ok(call(json!({ "call": "apply", "key": "queue-miss", "parent": 0, "node": 3, "op": queued("cut", &[notch(5.0, 5.0), far]) })));
    assert_eq!(plain["combined"]["missed"], json!([]), "{plain}");
}
