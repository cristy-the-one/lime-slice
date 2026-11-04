//! Pen fonts (`stroke`, `line`) through the lettering step on every kind of face (docs/plan-text-on-curves-and-fonts.md,
//! milestone 5), on the real kernel. `LIME_REQUIRE_OCCT=1` makes a missing kernel a failure.

use serde_json::{json, Value};

const DEPTH: f64 = 0.6;

fn require() -> bool {
    std::env::var_os("LIME_REQUIRE_OCCT").is_some()
}

fn call(request: Value) -> Value {
    let text = lime_model_occt::tree(&request.to_string());
    serde_json::from_str(&text).unwrap_or_else(|err| panic!("not JSON ({err}): {text}"))
}

fn open(key: &str, request: Value) -> Option<Value> {
    let mut request = request;
    request["call"] = json!("open");
    request["key"] = json!(key);
    request["chordMm"] = json!(0.1);
    let opened = call(request);
    if opened.get("error").is_some() {
        assert!(!require(), "OCCT was required: {opened}");
        return None;
    }
    Some(opened)
}

fn primitive(key: &str, primitive: Value) -> Option<Value> {
    open(key, json!({ "primitive": primitive }))
}

fn lettering(font: &str, op: &str, text: &str, at: [f64; 3], height: f64) -> Value {
    json!({
        "kind": "lettering", "op": op, "origin": at, "turn": [0.0, 0.0, 0.0],
        "text": text, "font": font, "height": height, "depth": DEPTH,
    })
}

fn ink(op: &Value) -> f64 {
    let mut request = json!({ "call": "textLayout" });
    for key in ["text", "font", "height", "spacing", "strokeWidth"] {
        if let Some(value) = op.get(key) {
            request[key] = value.clone();
        }
    }
    let reply = call(request);
    assert_eq!(reply["ok"], json!(true), "{reply}");
    reply["inkMm2"].as_f64().expect("inkMm2")
}

fn apply(key: &str, op: &Value) -> Value {
    let probed = call(json!({ "call": "probe", "key": key, "node": 0, "op": op }));
    assert_eq!(probed["ok"], json!(true), "{probed}");
    assert_eq!(probed["solids"], json!(1), "{probed}");
    assert_eq!(probed["shells"], json!(1), "{probed}");
    probed
}

#[track_caller]
fn near(actual: f64, expected: f64, tolerance: f64) {
    assert!(
        (actual - expected).abs() <= tolerance,
        "{actual} is not within {tolerance} of {expected}"
    );
}

/// Every pen font, raised and engraved, builds one closed solid with the letters' ink times the depth, directly.
fn check(key: &str, at: [f64; 3], base: f64, surface: &str, share: f64) {
    for (font, text) in [("stroke", "LIME 42"), ("line", "Lime gy")] {
        for (op, sign) in [("fuse", 1.0), ("cut", -1.0)] {
            let step = lettering(font, op, text, at, 3.5);
            let reply = apply(key, &step);
            assert_eq!(
                reply["text"]["build"],
                json!("direct"),
                "{font} {op}: {reply}"
            );
            assert_eq!(reply["text"]["surface"], json!(surface), "{font} {op}");
            assert_eq!(
                reply["text"]["font"],
                json!(format!("{font}@1")),
                "{font} {op}"
            );
            let moved = sign * (reply["volumeMm3"].as_f64().unwrap() - base);
            let expect = ink(&step) * DEPTH;
            near(moved, expect, share * expect + 0.01);
        }
    }
}

#[test]
fn pen_fonts_build_on_a_flat_face() {
    let Some(opened) = open("pen-flat", json!({ "box": [60.0, 30.0, 10.0] })) else {
        return;
    };
    check(
        "pen-flat",
        [30.0, 15.0, 10.0],
        opened["volumeMm3"].as_f64().unwrap(),
        "plane",
        0.0,
    );
}

#[test]
fn pen_fonts_build_on_a_cylinder_and_a_cone() {
    let Some(opened) = primitive(
        "pen-cyl",
        json!({ "primitive": "cylinder", "origin": [0.0, 0.0, 0.0], "radius": 20.0, "height": 40.0 }),
    ) else {
        return;
    };
    check(
        "pen-cyl",
        [-20.0, 0.0, 20.0],
        opened["volumeMm3"].as_f64().unwrap(),
        "cylinder",
        0.04,
    );
    let opened = primitive(
        "pen-cone",
        json!({ "primitive": "cone", "origin": [0.0, 0.0, 0.0], "radius": 25.0, "topRadius": 15.0, "height": 40.0 }),
    )
    .expect("a kernel");
    check(
        "pen-cone",
        [-20.0, 0.0, 20.0],
        opened["volumeMm3"].as_f64().unwrap(),
        "cone",
        0.06,
    );
}

#[test]
fn pen_fonts_build_on_a_sphere_a_torus_and_a_freeform_face() {
    let Some(opened) = primitive(
        "pen-ball",
        json!({ "primitive": "sphere", "origin": [0.0, 0.0, 0.0], "radius": 30.0 }),
    ) else {
        return;
    };
    check(
        "pen-ball",
        [-30.0, 0.0, 0.0],
        opened["volumeMm3"].as_f64().unwrap(),
        "sphere",
        0.05,
    );
    let opened = primitive(
        "pen-torus",
        json!({ "primitive": "torus", "origin": [0.0, 0.0, 0.0], "radius": 30.0, "tubeRadius": 10.0 }),
    )
    .expect("a kernel");
    check(
        "pen-torus",
        [-30.0, 0.0, 10.0],
        opened["volumeMm3"].as_f64().unwrap(),
        "torus",
        0.08,
    );
    // A B-spline body's volume is an integral with an error larger than the letters', so the freeform face is checked by the build and
    // its path, not by volume.
    primitive(
        "pen-ellipsoid",
        json!({ "primitive": "ellipsoid", "origin": [0.0, 0.0, 0.0], "size": [80.0, 60.0, 50.0] }),
    )
    .expect("a kernel");
    for font in ["stroke", "line"] {
        let reply = apply(
            "pen-ellipsoid",
            &lettering(font, "fuse", "Lime 42", [-40.0, 0.0, 0.0], 4.0),
        );
        assert_eq!(reply["text"]["surface"], json!("freeform"), "{reply}");
        assert_eq!(reply["text"]["build"], json!("direct"), "{reply}");
    }
}

#[test]
fn a_pen_width_changes_the_ink_and_a_pen_font_names_what_it_lacks() {
    let Some(_) = open("pen-width", json!({ "box": [60.0, 30.0, 10.0] })) else {
        return;
    };
    let base = lettering("stroke", "fuse", "HI", [30.0, 15.0, 10.0], 6.0);
    let mut fat = base.clone();
    fat["strokeWidth"] = json!(1.5);
    assert!(ink(&fat) > 1.5 * ink(&base));
    let reply = apply("pen-width", &fat);
    near(
        reply["volumeMm3"].as_f64().unwrap() - 60.0 * 30.0 * 10.0,
        ink(&fat) * DEPTH,
        0.01,
    );
    let lacking = call(json!({
        "call": "probe", "key": "pen-width", "node": 0,
        "op": lettering("stroke", "fuse", "日", [30.0, 15.0, 10.0], 6.0),
    }));
    assert_eq!(lacking["ok"], json!(false), "{lacking}");
    assert!(
        lacking.to_string().contains("‘日’"),
        "the missing letter is named: {lacking}"
    );
}

#[test]
fn a_pen_font_text_replays_from_a_saved_step_to_the_same_solid() {
    let Some(_) = open("pen-replay", json!({ "box": [60.0, 30.0, 10.0] })) else {
        return;
    };
    let op = lettering("line", "fuse", "Replay 7", [30.0, 15.0, 10.0], 5.0);
    let first = apply("pen-replay", &op);
    let again = apply("pen-replay", &op);
    near(
        first["volumeMm3"].as_f64().unwrap(),
        again["volumeMm3"].as_f64().unwrap(),
        1e-9,
    );
}
