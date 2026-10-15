//! A printer whose firmware skips G2/G3 gets no arcs, whatever `arcFit` asks.
//! Klipper without `[gcode_arcs]` drops each arc and then lays its filament
//! on the next G1, which stopped a real IR3 V2 print with "Move exceeds
//! maximum extrusion".

use lime_slice_core::{slice_request, Job, SliceRequest};
use serde_json::{json, Value};

const SAMPLES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../samples/");

fn request(printer: Value, extra: Value) -> SliceRequest {
    let bytes = std::fs::read(format!("{SAMPLES}arc_post.stl")).unwrap();
    let mut body = json!({
        "filename": "arc_post.stl",
        "dataB64": base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes),
        "blend": {"mode": "single", "strategy": "speed"},
        "arcFit": true,
        "baseline": false,
        "compare": false,
        "includePreview": false,
        "includeGcode": true,
        "printer": printer,
    });
    for (key, value) in extra.as_object().unwrap() {
        body[key] = value.clone();
    }
    serde_json::from_value(body).unwrap()
}

fn printer(fields: Value) -> Value {
    let mut out = json!({
        "name": "test", "nozzleDiameter": 0.4, "filamentDiameter": 1.75,
        "nozzleTemp": 210.0, "bedTemp": 60.0, "bedX": 250.0, "bedY": 250.0,
    });
    for (key, value) in fields.as_object().unwrap() {
        out[key] = value.clone();
    }
    out
}

struct Sliced {
    gcode: String,
    final_e: f64,
}

fn slice(printer: Value, extra: Value) -> Sliced {
    let out = slice_request(&request(printer, extra), Job::default()).unwrap();
    assert!(out.sanity.ok, "{:?}", out.sanity.notes);
    Sliced {
        final_e: out.sanity.final_e,
        gcode: out.gcode,
    }
}

fn arc_lines(gcode: &str) -> usize {
    gcode
        .lines()
        .filter(|l| l.starts_with("G2 ") || l.starts_with("G3 "))
        .count()
}

fn footer_arcs(gcode: &str) -> usize {
    let tail = gcode.rsplit_once("ARCS:").expect("footer").1;
    tail.split_whitespace().next().unwrap().parse().unwrap()
}

fn features(gcode: &str) -> &str {
    gcode
        .lines()
        .find(|l| l.starts_with("; features:"))
        .expect("features line")
}

#[test]
fn a_firmware_without_arcs_gets_none_and_the_same_plastic() {
    let allowed = slice(printer(json!({ "firmwareArcs": true })), json!({}));
    let refused = slice(printer(json!({ "firmwareArcs": false })), json!({}));

    assert!(
        arc_lines(&allowed.gcode) > 20,
        "{} arcs",
        arc_lines(&allowed.gcode)
    );
    assert_eq!(footer_arcs(&allowed.gcode), arc_lines(&allowed.gcode));
    assert!(
        features(&allowed.gcode).ends_with("; arcs on"),
        "{}",
        features(&allowed.gcode)
    );

    assert_eq!(arc_lines(&refused.gcode), 0);
    assert_eq!(footer_arcs(&refused.gcode), 0);
    assert!(
        features(&refused.gcode).ends_with("; arcs off (firmware takes no G2/G3)"),
        "{}",
        features(&refused.gcode)
    );

    // The arcs replace chords of the same path, so the filament barely moves.
    let drift = (allowed.final_e - refused.final_e).abs() / refused.final_e;
    assert!(
        drift < 1e-3,
        "E {} with arcs, {} without",
        allowed.final_e,
        refused.final_e
    );
}

#[test]
fn klipper_left_unsaid_takes_no_arcs_and_says_so() {
    let klipper = slice(printer(json!({ "firmware": "klipper" })), json!({}));
    assert_eq!(arc_lines(&klipper.gcode), 0);
    assert!(features(&klipper.gcode).ends_with("; arcs off (firmware takes no G2/G3)"));

    let opted_in = slice(
        printer(json!({ "firmware": "klipper", "firmwareArcs": true })),
        json!({}),
    );
    assert!(arc_lines(&opted_in.gcode) > 20);

    let marlin = slice(printer(json!({ "firmware": "marlin" })), json!({}));
    assert!(arc_lines(&marlin.gcode) > 20);
    // Nothing named and arcs on: the header is the one it was before.
    assert!(
        !features(&marlin.gcode).contains("arcs"),
        "{}",
        features(&marlin.gcode)
    );
}

#[test]
fn arc_fit_off_is_still_off_and_a_named_firmware_says_so() {
    let off = slice(
        printer(json!({ "firmwareArcs": true })),
        json!({ "arcFit": false }),
    );
    assert_eq!(arc_lines(&off.gcode), 0);
    assert!(features(&off.gcode).ends_with("; arcs off"));
}

#[test]
fn a_belt_on_firmware_without_arcs_writes_no_arcs() {
    let belt = json!({ "belt": {
        "angleDeg": 45.0, "axis": "z", "direction": 1, "widthMm": 250.0, "copies": 1, "gapMm": 5.0
    } });
    let allowed = slice(printer(json!({ "firmwareArcs": true })), belt.clone());
    let refused = slice(
        printer(json!({ "firmware": "klipper", "firmwareArcs": false })),
        belt,
    );
    assert!(
        arc_lines(&allowed.gcode) > 20,
        "a belt that takes arcs keeps them"
    );
    assert_eq!(arc_lines(&refused.gcode), 0);
    assert_eq!(footer_arcs(&refused.gcode), 0);
}

#[test]
fn an_omitted_firmware_arcs_stays_off_the_wire() {
    let req = request(printer(json!({})), json!({}));
    let printer = req.printer.as_ref().unwrap();
    assert_eq!(printer.firmware_arcs, None);
    assert!(printer.accepts_arcs());
    let wire = serde_json::to_value(&req).unwrap();
    assert!(
        wire["printer"].get("firmwareArcs").is_none(),
        "{}",
        wire["printer"]
    );
}
