//! The Hershey pen fonts through the lettering step on the real kernel: each bundled one builds one closed solid on a flat face and
//! on a cylinder, raised and engraved. `LIME_REQUIRE_OCCT=1` makes a missing kernel a failure.

use serde_json::{json, Value};

const DEPTH: f64 = 0.6;
const FONTS: [&str; 5] = [
    "hershey-simplex",
    "hershey-duplex",
    "hershey-complex",
    "hershey-script",
    "hershey-gothic",
];

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

fn lettering(font: &str, op: &str, text: &str, at: [f64; 3]) -> Value {
    json!({
        "kind": "lettering", "op": op, "origin": at, "turn": [0.0, 0.0, 0.0],
        "text": text, "font": font, "height": 5.0, "depth": DEPTH,
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

fn check(key: &str, at: [f64; 3], base: f64, surface: &str, share: f64) {
    for font in FONTS {
        for (op, sign) in [("fuse", 1.0), ("cut", -1.0)] {
            let step = lettering(font, op, "Lime 42", at);
            let probed = call(json!({ "call": "probe", "key": key, "node": 0, "op": &step }));
            assert_eq!(probed["ok"], json!(true), "{font} {op}: {probed}");
            assert_eq!(probed["solids"], json!(1), "{font} {op}: {probed}");
            assert_eq!(probed["shells"], json!(1), "{font} {op}: {probed}");
            assert_eq!(
                probed["text"]["build"],
                json!("direct"),
                "{font} {op}: {probed}"
            );
            assert_eq!(probed["text"]["surface"], json!(surface), "{font} {op}");
            assert_eq!(
                probed["text"]["font"],
                json!(format!("{font}@1")),
                "{font} {op}"
            );
            let moved = sign * (probed["volumeMm3"].as_f64().unwrap() - base);
            let expect = ink(&step) * DEPTH;
            assert!(
                (moved - expect).abs() <= share * expect + 0.01,
                "{font} {op}: moved {moved}, expected {expect}"
            );
        }
    }
}

#[test]
fn hershey_fonts_build_on_a_flat_face() {
    let Some(opened) = open("hershey-flat", json!({ "box": [80.0, 30.0, 10.0] })) else {
        return;
    };
    check(
        "hershey-flat",
        [40.0, 15.0, 10.0],
        opened["volumeMm3"].as_f64().unwrap(),
        "plane",
        0.0,
    );
}

#[test]
fn hershey_fonts_build_on_a_cylinder() {
    let Some(opened) = open(
        "hershey-cyl",
        json!({ "primitive": { "primitive": "cylinder", "origin": [0.0, 0.0, 0.0], "radius": 20.0, "height": 40.0 } }),
    ) else {
        return;
    };
    check(
        "hershey-cyl",
        [-20.0, 0.0, 20.0],
        opened["volumeMm3"].as_f64().unwrap(),
        "cylinder",
        0.04,
    );
}
