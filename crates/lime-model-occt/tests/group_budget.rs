//! A new group stops when it runs past its budget, so hundreds of Booleans cannot hold the store lock from
//! every other part for minutes. A saved group replays with no budget. Its own binary, because the budget is
//! global. `LIME_REQUIRE_OCCT=1` makes a missing kernel a failure.

use std::time::Duration;

use serde_json::{json, Value};

fn call(request: Value) -> Value {
    let text = lime_model_occt::tree(&request.to_string());
    serde_json::from_str(&text).unwrap_or_else(|err| panic!("not JSON ({err}): {text}"))
}

fn cut(z: f64) -> Value {
    json!({ "kind": "boolean", "op": "cut", "primitive": "box", "origin": [0.0, 0.0, z], "size": [10.0, 10.0, 1.0] })
}

#[test]
fn a_new_group_stops_at_its_budget_and_a_saved_one_replays() {
    let opened = call(json!({ "call": "open", "key": "b", "box": [10.0, 10.0, 10.0] }));
    if opened.get("error").is_some() {
        assert!(
            std::env::var_os("LIME_REQUIRE_OCCT").is_none(),
            "OCCT was required: {opened}"
        );
        return;
    }
    let group = json!({ "kind": "group", "label": "Texture lines", "steps": [cut(9.5), cut(7.5), cut(5.5)] });

    lime_model_occt::set_group_budget(Duration::ZERO);
    let expected = "This group stopped after 0 s, before step 1 of 3. Use fewer steps, a larger pitch, or a smaller region.";
    let probed = call(json!({ "call": "probe", "key": "b", "node": 0, "op": group }));
    assert_eq!(probed["error"], json!(expected), "{probed}");
    let applied = call(json!({ "call": "apply", "key": "b", "parent": 0, "node": 1, "op": group }));
    assert_eq!(applied["error"], json!(expected), "{applied}");

    // A saved group replays whatever the budget: a part must open the same on a slower machine.
    let reopened = call(json!({
        "call": "open", "key": "b2", "box": [10.0, 10.0, 10.0],
        "nodes": [{ "id": 1, "parent": 0, "op": group }], "current": 1,
    }));
    assert!(reopened.get("error").is_none(), "{reopened}");
    assert!(
        (reopened["volumeMm3"].as_f64().unwrap() - 750.0).abs() < 0.01,
        "{reopened}"
    );

    // The edited step of an edit is typed now, as an Apply's is: it stops too.
    let edited = call(json!({ "call": "edit", "key": "b2", "parent": 0, "node": 2, "op": group, "replay": [], "chordMm": 0.1 }));
    assert_eq!(edited["error"], json!(expected), "{edited}");

    lime_model_occt::set_group_budget(Duration::from_secs(60));
    let applied = call(json!({ "call": "apply", "key": "b", "parent": 0, "node": 1, "op": group }));
    assert!(applied.get("error").is_none(), "{applied}");
    assert!(
        (applied["volumeMm3"].as_f64().unwrap() - 750.0).abs() < 0.01,
        "{applied}"
    );
}
