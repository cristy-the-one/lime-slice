//! Writes the slice replies the browser tests serve. Run with
//! `cargo test -p lime-slice-core --release --test e2e_fixtures -- --ignored`.

use base64::Engine;
use lime_slice_core::{slice_payload, Job};
use serde_json::{json, Value};

const ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../");

#[test]
#[ignore = "writes e2e/fixtures; run on purpose"]
fn write_cube_belt_fixture() {
    let stl = std::fs::read(format!("{ROOT}samples/calibration_cube_20mm.stl")).unwrap();
    let req = json!({
        "filename": "calibration_cube_20mm.stl",
        "dataB64": base64::engine::general_purpose::STANDARD.encode(stl),
        "blend": {"mode": "single", "strategy": "speed"},
        "belt": {"angleDeg": 45, "axis": "z", "direction": 1, "widthMm": 220, "copies": 1, "gapMm": 5},
        "includeGcode": true,
        "includePreview": true,
        "baseline": false,
    });
    let reply = slice_payload(&req.to_string(), None, Job::default(), |g| g.text()).unwrap();
    let mut reply: Value = serde_json::from_str(&reply).unwrap();
    let chars = reply["gcode"].as_str().unwrap().chars().count();
    reply["gcode"] = json!(format!(
        "; fixture keeps estimates and preview; gcode body omitted ({chars} chars)\n"
    ));
    std::fs::write(
        format!("{ROOT}e2e/fixtures/cube-belt.json"),
        serde_json::to_string(&reply).unwrap(),
    )
    .unwrap();
}

/// A belt reply with floor supports and a skeleton, for the support-edit UI:
/// the knots are in the reply frame and `skeleton.ls` names their layers.
#[test]
#[ignore = "writes e2e/fixtures; run on purpose"]
fn write_ledge_belt_skeleton_fixture() {
    let stl = std::fs::read(format!("{ROOT}samples/overhang_ledge.stl")).unwrap();
    let req = json!({
        "filename": "overhang_ledge.stl",
        "dataB64": base64::engine::general_purpose::STANDARD.encode(stl),
        "blend": {"mode": "single", "strategy": "speed"},
        "belt": {
            "angleDeg": 45, "axis": "z", "direction": 1, "widthMm": 220,
            "copies": 1, "gapMm": 5, "floorSupports": true,
        },
        "supports": true,
        "supportStyle": "tree",
        "includeSkeleton": true,
        "includeGcode": true,
        "includePreview": true,
        "baseline": false,
    });
    let reply = slice_payload(&req.to_string(), None, Job::default(), |g| g.text()).unwrap();
    let mut reply: Value = serde_json::from_str(&reply).unwrap();
    let chars = reply["gcode"].as_str().unwrap().chars().count();
    reply["gcode"] = json!(format!(
        "; fixture keeps estimates and preview; gcode body omitted ({chars} chars)
"
    ));
    std::fs::write(
        format!("{ROOT}e2e/fixtures/ledge-belt-skeleton.json"),
        serde_json::to_string(&reply).unwrap(),
    )
    .unwrap();
}
