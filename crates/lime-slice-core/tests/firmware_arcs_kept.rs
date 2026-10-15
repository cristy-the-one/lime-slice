//! Whether the firmware takes arcs changes only the emitted G-code, so turning
//! it over reuses every kept stage and writes what a cold slice writes. Its
//! own test binary, because the kept stages are shared by the whole process.

use base64::Engine;
use lime_slice_core::{keep_support_bases, slice_payload, Job};
use serde_json::{json, Value};

fn request(firmware_arcs: bool) -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../samples/arc_post.stl");
    json!({
        "filename": "arc_post.stl",
        "dataB64": base64::engine::general_purpose::STANDARD.encode(std::fs::read(path).unwrap()),
        "blend": {"mode": "single", "strategy": "speed"},
        "printer": {
            "name": "test", "nozzleDiameter": 0.4, "filamentDiameter": 1.75,
            "nozzleTemp": 210.0, "bedTemp": 60.0, "bedX": 250.0, "bedY": 250.0,
            "firmware": "klipper", "firmwareArcs": firmware_arcs,
        },
        "includeGcode": true,
        // Stages are kept only for an interactive slice, which asks for its preview.
        "includePreview": true,
        "baseline": false,
    })
}

fn slice(req: &Value) -> Value {
    let reply = slice_payload(&req.to_string(), None, Job::default(), |g| g.text()).unwrap();
    serde_json::from_str(&reply).unwrap()
}

fn arcs(reply: &Value) -> usize {
    reply["gcode"]
        .as_str()
        .unwrap()
        .lines()
        .filter(|l| l.starts_with("G2 ") || l.starts_with("G3 "))
        .count()
}

#[test]
fn turning_firmware_arcs_over_reuses_every_stage_and_slices_as_cold() {
    keep_support_bases(true);
    let on = slice(&request(true));
    let off = slice(&request(false));
    keep_support_bases(false);
    let cold = slice(&request(false));

    assert!(arcs(&on) > 20, "{} arcs", arcs(&on));
    assert_eq!(arcs(&off), 0);
    let reused: Vec<&str> = off["stages"]["reused"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert_eq!(
        reused,
        vec![
            "contours",
            "toolpaths",
            "order",
            "comb",
            "supports",
            "supportPaths"
        ]
    );
    assert_eq!(off["gcode"], cold["gcode"]);
    assert_eq!(off["layers"], cold["layers"]);
}
