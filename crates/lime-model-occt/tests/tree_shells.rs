//! The history tree opens facet-shell STEP files the way the session does: shells that sew into
//! solids are edited as solids, and surfaces that do not are opened for measuring only, with every
//! edit and probe refused before a node is built.

mod facets;

use base64::Engine;
use facets::{broken_cubes, three_cubes, write_step};
use serde_json::{json, Value};

const VIEW_ONLY: &str =
    "This STEP file has surfaces but no closed solid, so it can be measured but not edited.";

fn call(request: Value) -> Value {
    let text = lime_model_occt::tree(&request.to_string());
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

#[test]
fn facet_shells_in_the_tree() {
    let probe = call(json!({ "call": "open", "key": "probe", "box": [1.0, 1.0, 1.0] }));
    if probe.get("error").is_some() {
        assert!(
            std::env::var_os("LIME_REQUIRE_OCCT").is_none(),
            "OCCT was required: {probe}"
        );
        return;
    }
    ok(json!({ "call": "close", "key": "probe" }));

    let path = write_step("tree-cubes", &three_cubes());
    let by_path = ok(json!({ "call": "open", "key": "cubes", "stepPath": path }));
    near(volume(&by_path), 3000.0);
    let split = ok(
        json!({ "call": "apply", "key": "cubes", "parent": 0, "node": 1,
        "op": { "kind": "split", "origin": [25.0, 5.0, 5.0], "normal": [0.0, 0.0, 1.0] } }),
    );
    near(volume(&split), 1500.0);
    near(volume(&split["other"]), 1500.0);

    let bytes = std::fs::read(&path).expect("facet step");
    let _ = std::fs::remove_file(&path);
    let data = base64::engine::general_purpose::STANDARD.encode(bytes);
    let by_bytes = ok(json!({ "call": "open", "key": "cubes", "dataB64": data }));
    assert_eq!(by_bytes["fingerprint"], by_path["fingerprint"]);
    ok(json!({ "call": "close", "key": "cubes" }));

    let ops = [
        json!({ "kind": "boolean", "op": "cut", "primitive": "box", "origin": [-1.0, -1.0, -1.0], "size": [6.0, 12.0, 12.0] }),
        json!({ "kind": "hole", "origin": [5.0, 5.0, 10.0], "axis": [0.0, 0.0, -1.0], "radius": 2.0, "depth": 4.0 }),
        json!({ "kind": "split", "origin": [5.0, 5.0, 5.0], "normal": [0.0, 0.0, 1.0] }),
        json!({ "kind": "fillet", "edges": [0], "size": 1.0 }),
        json!({ "kind": "chamfer", "edges": [0], "size": 1.0 }),
        json!({ "kind": "scale", "factor": 2.0 }),
    ];
    for (name, shell) in broken_cubes() {
        let path = write_step(&format!("tree-{name}"), &[shell]);
        let opened = ok(json!({ "call": "open", "key": name, "stepPath": path }));
        let _ = std::fs::remove_file(&path);
        assert_eq!(opened["held"], json!([0]), "{name}");
        for op in &ops {
            let applied =
                call(json!({ "call": "apply", "key": name, "parent": 0, "node": 1, "op": op }));
            assert_eq!(applied, json!({ "error": VIEW_ONLY }), "{name} apply {op}");
            let probed = call(json!({ "call": "probe", "key": name, "node": 0, "op": op }));
            assert_eq!(
                probed,
                json!({ "ok": false, "error": VIEW_ONLY }),
                "{name} probe {op}"
            );
        }
        let nothing = call(json!({ "call": "goto", "key": name, "node": 1 }));
        assert_eq!(
            nothing,
            json!({ "error": "unknown", "missing": [1] }),
            "{name}"
        );
        let root = ok(json!({ "call": "goto", "key": name, "node": 0 }));
        assert_eq!(root["held"], json!([0]), "{name}: no node was built");
        ok(json!({ "call": "close", "key": name }));
    }
}
