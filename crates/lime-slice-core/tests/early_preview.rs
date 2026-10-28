//! A slice that asks for an early preview hands its watch the part's
//! toolpaths before the tour, drawn like the reply's preview with no travels.
//! Asking for one leaves the G-code as it was.

use std::fs;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use base64::Engine;
use lime_slice_core::{keep_support_bases, slice_payload_watched, Job, Status, Watch};
use serde_json::{json, Value};

fn body(early: bool, infill: f64) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../samples/lime_hull.stl");
    let mut body = json!({
        "filename": "lime_hull.stl",
        "dataB64": base64::engine::general_purpose::STANDARD.encode(fs::read(path).unwrap()),
        "baseline": false,
        "compare": false,
        "includePreview": true,
        "includeGcode": true,
        "infill": infill,
    });
    if early {
        body["earlyPreview"] = json!(true);
    }
    body.to_string()
}

/// Slice `body` under a live watch that stays running for up to `wait`, or
/// until the early preview lands, as a job's does while its reply is read.
fn slice(body: &str, wait: Duration) -> (Value, Option<Value>) {
    let watch = Watch::new();
    let reply = slice_payload_watched(body, None, Job::start(), &watch, |_| String::new()).unwrap();
    let waited = Instant::now();
    while watch.early().is_none() && waited.elapsed() < wait {
        std::thread::sleep(Duration::from_millis(20));
    }
    let early = watch.early().map(|text| serde_json::from_str(&text).unwrap());
    let flagged = watch.snapshot().early;
    watch.finish(Status::Done);
    assert_eq!(flagged, early.is_some());
    (serde_json::from_str(&reply).unwrap(), early)
}

fn kinds(layer: &Value) -> Vec<String> {
    let paths = &layer["paths"];
    let names: Vec<String> = paths["kinds"]
        .as_array()
        .unwrap()
        .iter()
        .map(|k| k.as_str().unwrap().to_string())
        .collect();
    paths["kind"]
        .as_array()
        .unwrap()
        .iter()
        .map(|k| names[k.as_u64().unwrap() as usize].clone())
        .collect()
}

#[test]
fn an_early_preview_draws_the_part_before_the_tour_and_changes_no_bytes() {
    keep_support_bases(true);
    let (plain, none) = slice(&body(false, 0.15), Duration::from_millis(500));
    assert!(none.is_none(), "a slice that did not ask has no early preview");

    // A new infill density plans the toolpaths again, so they can be drawn early.
    let (reply, early) = slice(&body(true, 0.25), Duration::from_secs(30));
    let (again, _) = slice(&body(false, 0.25), Duration::ZERO);
    assert_eq!(reply["gcode"], again["gcode"]);
    assert_ne!(reply["gcode"], plain["gcode"]);

    let early = early.expect("an early preview");
    let early_layers = early["layers"].as_array().unwrap();
    let layers = reply["layers"].as_array().unwrap();
    assert_eq!(early_layers.len(), layers.len());
    for (e, l) in early_layers.iter().zip(layers) {
        assert_eq!(e["z"], l["z"]);
        let drawn = kinds(e);
        assert!(drawn.iter().all(|k| k != "travel"), "no travel early");
        let mut early_kinds = drawn.clone();
        let mut part_kinds: Vec<String> = kinds(l)
            .into_iter()
            .filter(|k| !matches!(k.as_str(), "travel" | "skirt" | "support" | "support-interface"))
            .collect();
        early_kinds.sort();
        part_kinds.sort();
        assert_eq!(early_kinds, part_kinds, "layer at z {}", e["z"]);
    }

    // The same request again reuses its toolpaths: nothing new to draw early.
    let (_, reused) = slice(&body(true, 0.25), Duration::from_millis(500));
    assert!(reused.is_none());
}
