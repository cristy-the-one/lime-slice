//! --- 3.1 F1. A run of applied steps folds into one group without building them again, and the group is the one a
//! fresh build of the same steps gives: the same solid, its faces owned by the group, and the same step edges for a
//! later fillet. A run that is not the group's steps is refused, so the caller builds the group instead.
//! `LIME_REQUIRE_OCCT=1` makes a missing kernel a failure.

use serde_json::{json, Value};

fn call(request: Value) -> Value {
    let text = lime_model_occt::tree(&request.to_string());
    serde_json::from_str(&text).unwrap_or_else(|err| panic!("not JSON ({err}): {text}"))
}

fn cut(x: f64, y: f64) -> Value {
    json!({ "kind": "boolean", "op": "cut", "primitive": "box", "origin": [x, y, 6.0], "size": [4.0, 4.0, 10.0] })
}

fn ok(reply: Value) -> Value {
    assert!(reply.get("error").is_none(), "{reply}");
    reply
}

#[test]
fn a_run_of_applied_steps_folds_into_the_group_a_build_gives() {
    let opened = call(json!({ "call": "open", "key": "chain", "box": [30.0, 30.0, 10.0] }));
    if opened.get("error").is_some() {
        assert!(
            std::env::var_os("LIME_REQUIRE_OCCT").is_none(),
            "OCCT was required: {opened}"
        );
        return;
    }
    let steps = [cut(2.0, 2.0), cut(12.0, 12.0), cut(22.0, 2.0)];
    ok(call(
        json!({ "call": "apply", "key": "chain", "parent": 0, "node": 1, "op": steps[0] }),
    ));
    ok(call(
        json!({ "call": "apply", "key": "chain", "parent": 1, "node": 2, "op": steps[1] }),
    ));
    ok(call(
        json!({ "call": "apply", "key": "chain", "parent": 2, "node": 3, "op": steps[2] }),
    ));
    let group = json!({ "kind": "group", "label": "Pockets", "steps": steps });

    // Not the group's steps: refused, and the run is left as it was.
    let short = json!({ "kind": "group", "label": "Pockets", "steps": [steps[0], steps[1]] });
    let refused = call(
        json!({ "call": "fold", "key": "chain", "parent": 0, "node": 4, "op": short, "last": 3 }),
    );
    assert_eq!(
        refused["error"],
        json!("The steps to fold are not the group's steps"),
        "{refused}"
    );
    ok(call(json!({ "call": "goto", "key": "chain", "node": 3 })));

    let folded = ok(call(
        json!({ "call": "fold", "key": "chain", "parent": 0, "node": 4, "op": group, "last": 3 }),
    ));
    assert_eq!(folded["id"], json!(4), "{folded}");
    assert_eq!(folded["replayed"], json!(0), "{folded}");
    let gone = call(json!({ "call": "goto", "key": "chain", "node": 2 }));
    assert!(
        gone.get("error").is_some(),
        "the folded steps are gone: {gone}"
    );

    let built_open = ok(call(
        json!({ "call": "open", "key": "built", "box": [30.0, 30.0, 10.0] }),
    ));
    assert_eq!(built_open["fingerprint"], opened["fingerprint"]);
    let built = ok(call(
        json!({ "call": "apply", "key": "built", "parent": 0, "node": 4, "op": group }),
    ));
    assert_eq!(
        folded["fingerprint"], built["fingerprint"],
        "{folded}\n{built}"
    );
    assert_eq!(
        folded["stepFaces"], built["stepFaces"],
        "faces belong to the group as a built group's do"
    );
    let owned = folded["stepFaces"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|owner| owner.as_u64() == Some(4))
        .count();
    assert!(
        owned >= 9,
        "the pockets' walls and floors are the group's: {folded}"
    );

    let edges = |key: &str| ok(call(json!({ "call": "stepEdges", "key": key, "node": 4 })));
    assert_eq!(
        edges("chain"),
        edges("built"),
        "a fillet by the group's step finds the same edges"
    );

    // A later step builds on the folded group like on any other.
    let next = ok(call(
        json!({ "call": "apply", "key": "chain", "parent": 4, "node": 5, "op": cut(12.0, 2.0) }),
    ));
    assert!(next["volumeMm3"].as_f64().unwrap() < folded["volumeMm3"].as_f64().unwrap());
}
