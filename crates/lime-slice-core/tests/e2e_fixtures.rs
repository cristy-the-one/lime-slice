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

/// The overhang ledge on a 45° belt with floor supports and a skeleton.
fn ledge_belt_request() -> Value {
    let stl = std::fs::read(format!("{ROOT}samples/overhang_ledge.stl")).unwrap();
    json!({
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
    })
}

fn write_reply(req: &Value, name: &str) -> Value {
    let reply = slice_payload(&req.to_string(), None, Job::default(), |g| g.text()).unwrap();
    let mut reply: Value = serde_json::from_str(&reply).unwrap();
    let chars = reply["gcode"].as_str().unwrap().chars().count();
    reply["gcode"] = json!(format!(
        "; fixture keeps estimates and preview; gcode body omitted ({chars} chars)
"
    ));
    std::fs::write(
        format!("{ROOT}e2e/fixtures/{name}"),
        serde_json::to_string(&reply).unwrap(),
    )
    .unwrap();
    reply
}

/// A belt reply with floor supports and a skeleton, for the support-edit UI:
/// the knots are in the reply frame and `skeleton.ls` names their layers.
#[test]
#[ignore = "writes e2e/fixtures; run on purpose"]
fn write_ledge_belt_skeleton_fixture() {
    write_reply(&ledge_belt_request(), "ledge-belt-skeleton.json");
}

/// The same reply after pruning the tree with the most tips, which leaves a
/// coverage gap: its slice-frame region and `z`, and where the preview draws it.
#[test]
#[ignore = "writes e2e/fixtures; run on purpose"]
fn write_ledge_belt_pruned_fixture() {
    let mut req = ledge_belt_request();
    let held = slice_payload(&req.to_string(), None, Job::default(), |g| g.text()).unwrap();
    let held: Value = serde_json::from_str(&held).unwrap();
    let skeleton = &held["skeleton"];
    let trees: Vec<u64> = skeleton["tree"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t.as_u64().unwrap())
        .collect();
    let tips = |root: u64| trees.iter().filter(|&&t| t == root).count();
    let root = *trees.iter().max_by_key(|&&t| tips(t)).unwrap();
    let sites: Vec<Value> = (0..trees.len())
        .filter(|&k| trees[k] == root)
        .map(|k| json!({"xy": [skeleton["siteX"][k], skeleton["siteY"][k]], "z": skeleton["siteZ"][k]}))
        .collect();
    req["supportEdits"] = json!([{"kind": "prune", "sites": sites}]);
    write_reply(&req, "ledge-belt-pruned.json");
}
