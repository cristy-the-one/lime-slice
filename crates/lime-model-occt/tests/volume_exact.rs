//! E5a: the four solids from docs/studies/volume-accuracy.md, measured by Gauss-Kronrod with spans
//! at 1e-6. Each expected volume is that study's settled reference. The bar is the study's:
//! the absolute error is at most the larger of 0.01 % of the reference and 0.01 mm³.
//! `LIME_REQUIRE_OCCT=1` makes a missing kernel a failure.

use std::f64::consts::PI;

use serde_json::{json, Value};

fn require() -> bool {
    std::env::var_os("LIME_REQUIRE_OCCT").is_some()
}

fn call(request: Value) -> Value {
    let text = lime_model_occt::tree(&request.to_string());
    serde_json::from_str(&text).unwrap_or_else(|err| panic!("not JSON ({err}): {text}"))
}

fn kernel() -> bool {
    let probe = call(json!({ "call": "open", "key": "exact-kernel", "box": [1.0, 1.0, 1.0] }));
    if probe.get("error").is_some() {
        assert!(!require(), "OCCT was required: {probe}");
        return false;
    }
    true
}

/// The study's bar: `abs_err <= max(|reference| * 1e-4, 0.01)`.
fn within_bar(name: &str, actual: f64, reference: f64) {
    let bar = (reference.abs() * 1e-4).max(0.01);
    let err = (actual - reference).abs();
    assert!(
        err <= bar,
        "{name}: {actual} mm³ is {err} mm³ from {reference}; the bar is {bar} mm³"
    );
}

/// The exact volume is its own read. A step's reply keeps the quick measure.
fn exact_volume(key: &str, node: u32) -> f64 {
    let reply = call(json!({ "call": "exactVolume", "key": key, "node": node }));
    reply["exactVolumeMm3"]
        .as_f64()
        .unwrap_or_else(|| panic!("exactVolumeMm3 is missing: {reply}"))
}

fn keeps_quick_volume(reply: &Value) {
    assert!(reply.get("exactVolumeMm3").is_none(), "a step reply carries the exact volume: {reply}");
    assert!(reply.get("volumeMm3").is_some(), "a step reply has no quick volume: {reply}");
}

fn sign(value: f64) -> f64 {
    if value > 0.0 {
        1.0
    } else if value < 0.0 {
        -1.0
    } else {
        0.0
    }
}

/// One fuse-volume stand-in section, copied from mcp/fuse-volume-occt.test.ts.
fn section(x: f64, w: f64, h: f64) -> Value {
    let mut profile = Vec::with_capacity(16);
    for i in 0..16 {
        let a = (i as f64 / 16.0) * PI * 2.0;
        let c = a.cos();
        let s = a.sin();
        // turn [0, 90, 0]: profile u runs along −Z and v along Y.
        let u = -((h / 2.0) * sign(s) * s.abs().powf(0.6) + h / 2.0);
        let v = w * sign(c) * c.abs().powf(0.6);
        profile.push(json!([u, v]));
    }
    json!({ "origin": [x, 0.0, 0.0], "turn": [0.0, 90.0, 0.0], "profile": profile, "smooth": true })
}

fn loft_feature() -> Value {
    const STATIONS: [f64; 7] = [-88.0, -86.0, -83.0, -76.0, -40.0, -5.0, 6.0];
    const HALF_WIDTH: [f64; 7] = [14.0, 20.0, 25.0, 29.0, 30.0, 27.0, 22.0];
    const HEIGHT: [f64; 7] = [30.0, 36.0, 40.0, 44.0, 46.0, 44.0, 38.0];
    let sections: Vec<Value> = STATIONS
        .iter()
        .zip(HALF_WIDTH)
        .zip(HEIGHT)
        .map(|((x, w), h)| section(*x, w, h))
        .collect();
    json!({ "kind": "loft", "op": "fuse", "sections": sections })
}

/// 6×6 degree-3 poles. z = 12 sin(πu) sin(πv) + 4 sin(2πu) sin(3πv) on an 80×60 mm rectangle.
fn organic_poles() -> Value {
    const N: usize = 6;
    let mut poles = Vec::with_capacity(N);
    for i in 0..N {
        let u = i as f64 / (N - 1) as f64;
        let mut row = Vec::with_capacity(N);
        for j in 0..N {
            let v = j as f64 / (N - 1) as f64;
            let x = (u - 0.5) * 80.0;
            let y = (v - 0.5) * 60.0;
            let z = 12.0 * (PI * u).sin() * (PI * v).sin() + 4.0 * (2.0 * PI * u).sin() * (3.0 * PI * v).sin();
            row.push(json!([x, y, z]));
        }
        poles.push(Value::Array(row));
    }
    Value::Array(poles)
}

fn open_feature(key: &str, feature: Value) -> Value {
    let reply = call(json!({ "call": "open", "key": key, "feature": feature }));
    assert!(reply.get("error").is_none(), "{key} did not open: {reply}");
    reply
}

fn apply(key: &str, parent: u32, node: u32, op: Value) -> Value {
    let reply = call(json!({ "call": "apply", "key": key, "parent": parent, "node": node, "op": op }));
    assert!(reply.get("error").is_none(), "{key} step {node} was refused: {reply}");
    reply
}

#[test]
fn the_study_solids_match_its_exact_volumes() {
    if !kernel() {
        return;
    }

    // Analytic π r² h. The study's bench printed 19634.954084936206 from acos(-1); Rust's PI is the same value to far inside the bar.
    let cylinder = call(json!({
        "call": "open", "key": "exact-cylinder",
        "primitive": { "primitive": "cylinder", "origin": [0.0, 0.0, 0.0], "radius": 12.5, "height": 40.0 }
    }));
    assert!(cylinder.get("error").is_none(), "{cylinder}");
    keeps_quick_volume(&cylinder);
    within_bar("cylinder", exact_volume("exact-cylinder", 0), PI * 12.5 * 12.5 * 40.0);

    // VolumeProperties at 1e-12, settled against 1e-11 in the study.
    let loft = open_feature("exact-loft", loft_feature());
    keeps_quick_volume(&loft);
    within_bar("loft", exact_volume("exact-loft", 0), 224_215.246_200_349_82);

    let _tub = open_feature("exact-tub", loft_feature());
    // The cockpit box, centre [-30, 0, 46], 50×40×20: origin is that centre minus half the size.
    let mut tub_reply = apply(
        "exact-tub",
        0,
        1,
        json!({
            "kind": "boolean", "op": "cut", "primitive": "box",
            "origin": [-55.0, -20.0, 36.0], "size": [50.0, 40.0, 20.0]
        }),
    );
    // Four side holes, centre [x, 30, 20], radius 3, height 12, turned 90° about X.
    // A cylinder's turn centre is halfway up its axis, so the origin sits 6 mm under the centre.
    for (index, x) in [-60.0, -50.0, -20.0, -10.0].into_iter().enumerate() {
        tub_reply = apply(
            "exact-tub",
            (index + 1) as u32,
            (index + 2) as u32,
            json!({
                "kind": "boolean", "op": "cut", "primitive": "cylinder",
                "origin": [x, 30.0, 14.0], "radius": 3.0, "height": 12.0, "turn": [90.0, 0.0, 0.0]
            }),
        );
    }
    keeps_quick_volume(&tub_reply);
    within_bar("tub", exact_volume("exact-tub", 5), 204_762.145_722_839_57);

    // The sheet's VolumeProperties sequence did not settle. The reference is the study's
    // Gauss-Kronrod span result at 1e-8, which agreed with 1e-6 inside this bar.
    let sheet = open_feature(
        "exact-sheet",
        json!({ "kind": "nurbsSurface", "poles": organic_poles() }),
    );
    assert_eq!(sheet["solid"], json!(false), "the sheet is open: {sheet}");
    let thick = apply(
        "exact-sheet",
        0,
        1,
        json!({ "kind": "thicken", "thickness": 3.0, "direction": "normal" }),
    );
    keeps_quick_volume(&thick);
    within_bar("sheet", exact_volume("exact-sheet", 1), 15_637.988_626_950_415);
}

/// Wall time of one hundred cuts on a box. `LIME_VOLUME_TIME=1` runs it and prints the milliseconds;
/// CI does not set that, so the assertion test above is the one that always runs.
#[test]
fn time_one_hundred_cuts() {
    if std::env::var_os("LIME_VOLUME_TIME").is_none() || !kernel() {
        return;
    }
    let started = std::time::Instant::now();
    let opened = call(json!({
        "call": "open", "key": "exact-hundred",
        "primitive": { "primitive": "box", "origin": [0.0, 0.0, 0.0], "size": [100.0, 100.0, 20.0] }
    }));
    assert!(opened.get("error").is_none(), "{opened}");
    for index in 0..100 {
        let x = (index % 10) as f64 * 8.0 + 2.0;
        let y = (index / 10) as f64 * 8.0 + 2.0;
        let reply = apply(
            "exact-hundred",
            index,
            index + 1,
            json!({
                "kind": "boolean", "op": "cut", "primitive": "box",
                "origin": [x, y, 18.0], "size": [2.0, 2.0, 4.0]
            }),
        );
        assert!(reply["volumeMm3"].as_f64().unwrap_or(0.0) > 0.0, "{reply}");
    }
    let ms = started.elapsed().as_secs_f64() * 1000.0;
    println!("HUNDRED_STEP_MS {ms}");
}
