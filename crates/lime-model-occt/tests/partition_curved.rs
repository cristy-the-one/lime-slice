//! Connectors on an imported part of many curved faces. The kernel keeps a connector when each piece loses exactly
//! the hole's volume; measured each about its own vertices, a piece's volume drifts by more than that check allows,
//! and every connector was left out as though it broke through. `LIME_REQUIRE_OCCT=1` makes a missing kernel a failure.

use std::path::Path;

use serde_json::{json, Value};

fn call(request: Value) -> Value {
    let text = lime_model_occt::tree(&request.to_string());
    serde_json::from_str(&text).unwrap_or_else(|err| panic!("not JSON ({err}): {text}"))
}

/// A cut through the duck at `origin` across `normal`, one connector of `spec` at the section's middle.
fn partition(origin: [f64; 3], normal: [f64; 3], spec: Value) -> Value {
    let kind = spec["type"].clone();
    json!({
        "kind": "partition",
        "cuts": [{ "origin": origin, "normal": normal, "profile": { "kind": "straight" },
            "connectors": { "on": true, "types": [spec],
                "placed": [{ "id": "c1-1", "type": kind, "uvMm": [0.0, 0.0], "fraction": [0.5, 0.5], "fixed": false }] } }],
        "up": [0.0, 0.0, 1.0],
        "target": { "printer": "lime-220", "process": "fdm", "volumeMm": [220.0, 220.0, 250.0] },
        "orient": "keep",
        "arrange": true,
        "labels": { "on": false },
        "bedMarginMm": 5.0,
        "maxPieces": 12.0,
    })
}

#[test]
fn every_connector_fits_a_curved_part_it_lies_well_inside() {
    let step = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../lime-slice-core/tests/fixtures/duck-plate.step");
    let opened = call(json!({ "call": "open", "key": "duck", "stepPath": step, "chordMm": 0.1 }));
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
    let common = json!({ "depth": 4.0, "clearance": 0.15, "endGap": 0.4, "count": "fit", "margin": 3.0,
        "place": "fit", "at": [], "hole": "round" });
    let specs = [
        json!({ "type": "hardware", "diameter": 6.0 }),
        json!({ "type": "dowel", "radius": 3.0 }),
        json!({ "type": "plug", "radius": 3.0, "side": "positive" }),
    ];
    // The duck's middle, across each axis: each drifted by 0.001 to 0.05 mm³ against a 75 mm³ hole.
    let middle = [2.578, 0.003, 28.5];
    for normal in [[0.0, 0.0, 1.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]] {
        for spec in &specs {
            let mut spec = spec.clone();
            for (key, value) in common.as_object().expect("an object") {
                spec[key] = value.clone();
            }
            let probed = call(
                json!({ "call": "probe", "key": "duck", "node": 0, "op": partition(middle, normal, spec.clone()) }),
            );
            assert!(probed.get("error").is_none(), "{probed}");
            let connectors = &probed["connectors"];
            assert_eq!(
                connectors["dropped"],
                json!([]),
                "{} across {normal:?}: {connectors}",
                spec["type"]
            );
            assert_eq!(
                connectors["placed"].as_array().map(Vec::len),
                Some(1),
                "{connectors}"
            );
        }
    }
}
