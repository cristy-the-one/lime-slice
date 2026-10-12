//! A travel between supports that runs in open air retracts only from 15 mm.
//! With combing off, every such travel retracts.

use base64::Engine;
use lime_slice_core::{slice_payload, Job};
use serde_json::{json, Value};

/// The shortest travel in open air that retracts, mm.
const MIN_TRAVEL_MM: f64 = 15.0;

fn ledge_gcode(combing: bool) -> String {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../samples/overhang_ledge.stl");
    let data = base64::engine::general_purpose::STANDARD.encode(std::fs::read(path).unwrap());
    let req = json!({
        "filename": "overhang_ledge.stl",
        "dataB64": data,
        "blend": {"mode": "single", "strategy": "speed"},
        "supports": true,
        "supportStyle": "tree",
        "combing": combing,
        "arcFit": false,
        "includeGcode": true,
        "includePreview": false,
        "baseline": false,
    });
    let reply = slice_payload(&req.to_string(), None, Job::default(), |g| g.text()).unwrap();
    let reply: Value = serde_json::from_str(&reply).unwrap();
    reply["gcode"].as_str().unwrap().to_owned()
}

/// Lengths of the XY travels, mm, that start with a retract and lead into a
/// support path.
fn retracted_support_travels(gcode: &str) -> Vec<f64> {
    let (mut kind, mut e, mut at) = (String::new(), 0.0, [0.0, 0.0]);
    let (mut pulled, mut out) = (false, Vec::new());
    for line in gcode.lines() {
        if let Some(k) = line.strip_prefix("; TYPE:") {
            kind = k.to_owned();
            continue;
        }
        if !line.starts_with("G1 ") {
            continue;
        }
        let word = |axis: char| {
            line.split_whitespace()
                .find_map(|t| t.strip_prefix(axis)?.parse::<f64>().ok())
        };
        let (x, y, ne) = (word('X'), word('Y'), word('E'));
        if x.is_none() && y.is_none() {
            if let Some(v) = ne {
                pulled = v < e - 0.05;
                e = v;
            }
            continue;
        }
        let to = [x.unwrap_or(at[0]), y.unwrap_or(at[1])];
        if ne.is_none() && pulled && kind.starts_with("SUPPORT") {
            out.push((to[0] - at[0]).hypot(to[1] - at[1]));
        }
        if let Some(v) = ne {
            e = v;
        }
        pulled = false;
        at = to;
    }
    out
}

#[test]
fn supports_in_open_air_retract_only_past_fifteen_millimetres() {
    let combed = retracted_support_travels(&ledge_gcode(true));
    assert!(!combed.is_empty());
    // What is left starts or ends against the part, which is not open air.
    let short: Vec<_> = combed.iter().filter(|d| **d < MIN_TRAVEL_MM).collect();
    assert!(short.len() <= 30, "{short:?}");
}

#[test]
fn with_combing_off_every_support_travel_retracts() {
    let plain = retracted_support_travels(&ledge_gcode(false));
    let short = plain.iter().filter(|d| **d < MIN_TRAVEL_MM).count();
    assert!(short > 150, "{short} of {}", plain.len());
}
