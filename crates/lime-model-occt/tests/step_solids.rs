//! Opening a STEP file of several solids as its pieces: `stepSolids` reads a split to print's named STEP export back as
//! its solids, with their names, in order, at the volumes they were cut at, and writes each as a STEP file of its own.
//! `LIME_REQUIRE_OCCT=1` makes a missing kernel a failure.
//!
//! The store is process-wide, so everything runs in one test, in order.

use base64::Engine;
use serde_json::{json, Value};

fn call(request: Value) -> Value {
    let text = lime_model_occt::tree(&request.to_string());
    serde_json::from_str(&text).unwrap_or_else(|err| panic!("not JSON ({err}): {text}"))
}

fn ok(request: Value) -> Value {
    let reply = call(request.clone());
    assert!(reply.get("error").is_none(), "{request} -> {reply}");
    reply
}

fn within(actual: f64, expected: f64, tolerance: f64) {
    assert!(
        (actual - expected).abs() <= tolerance,
        "{actual} is not within {tolerance} of {expected}"
    );
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn unb64(text: &Value) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD
        .decode(text.as_str().expect("base64 text"))
        .expect("base64")
}

fn across_z(z: f64) -> Value {
    json!({ "origin": [50.0, 40.0, z], "normal": [0.0, 0.0, 1.0], "u": [1.0, 0.0, 0.0], "profile": { "kind": "straight" }, "connectors": { "on": false } })
}

fn solids(reply: &Value) -> &Vec<Value> {
    reply["solids"]
        .as_array()
        .unwrap_or_else(|| panic!("solids in {reply}"))
}

#[test]
fn a_named_step_export_reads_back_as_its_solids() {
    let opened = call(json!({ "call": "open", "key": "tall", "box": [100.0, 80.0, 300.0] }));
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
    let op = json!({
        "kind": "partition",
        "cuts": [across_z(100.0), across_z(250.0)],
        "target": { "printer": "formlabs-form-4", "process": "resin", "volumeMm": [200.0, 125.0, 210.0] },
        "orient": "keep",
        "arrange": false,
        "labels": { "on": false },
        "bedMarginMm": 10.0,
        "maxPieces": 12.0,
    });
    ok(
        json!({ "call": "apply", "key": "tall", "parent": 0, "node": 1, "op": op, "pieceKeys": ["tall-2", "tall-3"] }),
    );
    let in_order: Vec<f64> = [("tall", 1), ("tall-2", 0), ("tall-3", 0)]
        .iter()
        .map(|(key, node)| {
            ok(json!({ "call": "goto", "key": key, "node": node }))["volumeMm3"]
                .as_f64()
                .expect("volumeMm3")
        })
        .collect();
    let mut cut = in_order.clone();
    cut.sort_by(f64::total_cmp);
    for (got, height) in cut.iter().zip([50.0, 100.0, 150.0]) {
        within(*got, 100.0 * 80.0 * height, 1e-6);
    }
    let exported = ok(json!({
        "call": "export", "key": "tall", "node": 1, "format": "step",
        "pieces": [{ "key": "tall-2", "node": 0 }, { "key": "tall-3", "node": 0 }],
        "names": ["cover-1", "cover-2", "cover-3"],
    }));
    let step = unb64(&exported["bytesBase64"]);

    let read = ok(json!({ "call": "stepSolids", "dataB64": b64(&step) }));
    let rows = solids(&read);
    assert_eq!(
        rows.iter()
            .map(|row| row["name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["cover-1", "cover-2", "cover-3"],
        "{read}"
    );
    for (row, volume) in rows.iter().zip(&in_order) {
        assert!(
            row.get("bytesBase64").is_none(),
            "files only when asked: {row}"
        );
        within(row["volumeMm3"].as_f64().unwrap(), *volume, 1e-3);
    }

    let named = lime_model_occt::step_named_solids(&step).expect("the file reads");
    assert_eq!(
        named
            .iter()
            .map(|(name, _)| name.as_str())
            .collect::<Vec<_>>(),
        ["cover-1", "cover-2", "cover-3"]
    );
    for ((_, piece), volume) in named.iter().zip(&in_order) {
        assert!(
            piece.valid && piece.closed && piece.solids == 1,
            "{piece:?}"
        );
        within(piece.volume_mm3, *volume, 1e-3);
    }

    let names = ["cover-1", "cover-2", "cover-3"];
    let written = ok(json!({ "call": "stepSolids", "dataB64": b64(&step), "files": true }));
    assert_eq!(solids(&written).len(), 3, "{written}");
    for (index, row) in solids(&written).iter().enumerate() {
        let alone = unb64(&row["bytesBase64"]);
        let back = ok(json!({ "call": "stepSolids", "dataB64": b64(&alone) }));
        let back = solids(&back);
        assert_eq!(back.len(), 1, "{back:?}");
        assert_eq!(back[0]["name"], names[index], "{back:?}");
        within(
            back[0]["volumeMm3"].as_f64().unwrap(),
            in_order[index],
            1e-3,
        );
        let opened =
            ok(json!({ "call": "open", "key": format!("piece-{index}"), "dataB64": b64(&alone) }));
        within(opened["volumeMm3"].as_f64().unwrap(), in_order[index], 1e-3);
    }

    let whole = ok(json!({ "call": "export", "key": "tall", "node": 0, "format": "step" }));
    let one = ok(json!({ "call": "stepSolids", "dataB64": whole["bytesBase64"] }));
    assert_eq!(solids(&one).len(), 1, "{one}");
    within(
        solids(&one)[0]["volumeMm3"].as_f64().unwrap(),
        100.0 * 80.0 * 300.0,
        1e-3,
    );

    for key in ["tall", "tall-2", "tall-3", "piece-0", "piece-1", "piece-2"] {
        ok(json!({ "call": "close", "key": key }));
    }
}
