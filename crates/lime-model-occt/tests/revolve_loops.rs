//! F2: a sketch region revolved about an axis. A rectangle off V, a quarter turn, a profile
//! that crosses the axis, a turn about U, and the same solid opened as a feature root.
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

fn volume(reply: &Value) -> f64 {
    assert!(reply.get("error").is_none(), "{reply}");
    reply["volumeMm3"].as_f64().expect("volumeMm3")
}

fn near(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() < 0.05,
        "{actual} is not near {expected}"
    );
}

fn refused(reply: &Value, wanted: &str) {
    assert_eq!(reply["error"].as_str(), Some(wanted), "{reply}");
}

/// A rectangle as four lines, closed.
fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Value {
    json!({
        "start": [x0, y0],
        "segments": [
            { "kind": "line", "to": [x1, y0] },
            { "kind": "line", "to": [x1, y1] },
            { "kind": "line", "to": [x0, y1] },
            { "kind": "line", "to": [x0, y0] }
        ]
    })
}

fn revolve(loops: Value, origin: [f64; 2], dir: [f64; 2], angle: f64) -> Value {
    json!({
        "kind": "revolve",
        "op": "fuse",
        "origin": [0.0, 0.0, 0.0],
        "turn": [0.0, 0.0, 0.0],
        "loops": loops,
        "axisOrigin": origin,
        "axisDir": dir,
        "angleDeg": angle
    })
}

fn open_feature(key: &str, feature: &Value) -> Value {
    call(json!({ "call": "open", "key": key, "feature": feature, "chordMm": 0.1 }))
}

/// False, and the test passes, when the kernel is not linked and nobody asked for it.
fn kernel() -> bool {
    let probe = call(json!({ "call": "open", "key": "rev-kernel", "box": [1.0, 1.0, 1.0] }));
    if probe.get("error").is_some() {
        assert!(!require(), "OCCT was required: {probe}");
        return false;
    }
    true
}

#[test]
fn a_rectangle_revolved_about_an_axis() {
    if !kernel() {
        return;
    }
    // u = 2..6, v = 0..4, a full turn about V. The radii are 2 and 6, so the volume is π(36 − 4)·4.
    let full = revolve(json!([rect(2.0, 0.0, 6.0, 4.0)]), [0.0, 0.0], [0.0, 1.0], 360.0);
    let opened = open_feature("rev", &full);
    near(volume(&opened), 128.0 * PI);
    assert_eq!(opened["id"], 0);

    // A quarter of that turn.
    let quarter = revolve(json!([rect(2.0, 0.0, 6.0, 4.0)]), [0.0, 0.0], [0.0, 1.0], 90.0);
    near(volume(&open_feature("rev90", &quarter)), 32.0 * PI);

    // The same outline, now straddling V.
    let across = revolve(json!([rect(-2.0, 0.0, 6.0, 4.0)]), [0.0, 0.0], [0.0, 1.0], 360.0);
    refused(
        &open_feature("revx", &across),
        "The profile crosses the revolve axis. Keep it on one side.",
    );

    // u = 0..4, v = 0..4, touching the U axis. A disk of radius 4, 4 mm thick: π·16·4.
    let about_u = revolve(json!([rect(0.0, 0.0, 4.0, 4.0)]), [0.0, 0.0], [1.0, 0.0], 360.0);
    near(volume(&open_feature("revu", &about_u)), 64.0 * PI);
}
