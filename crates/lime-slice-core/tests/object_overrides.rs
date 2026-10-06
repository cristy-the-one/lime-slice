//! Per-object infill, walls, and speed. Omitted, the strategy's numbers stay
//! and a cartesian slice keeps its G-code. A height range wins on the fields
//! it sets.

use base64::Engine;
use lime_slice_core::{slice_request, Job, SliceRequest};
use serde_json::{json, Value};

fn box_stl(z: f64) -> String {
    let (x, y) = (10.0, 10.0);
    let faces = [
        [[0.0, 0.0, 0.0], [x, 0.0, 0.0], [x, y, 0.0]],
        [[0.0, 0.0, 0.0], [x, y, 0.0], [0.0, y, 0.0]],
        [[0.0, 0.0, z], [x, y, z], [x, 0.0, z]],
        [[0.0, 0.0, z], [0.0, y, z], [x, y, z]],
        [[0.0, 0.0, 0.0], [x, 0.0, z], [x, 0.0, 0.0]],
        [[0.0, 0.0, 0.0], [0.0, 0.0, z], [x, 0.0, z]],
        [[0.0, y, 0.0], [x, y, 0.0], [x, y, z]],
        [[0.0, y, 0.0], [x, y, z], [0.0, y, z]],
        [[0.0, 0.0, 0.0], [0.0, y, 0.0], [0.0, y, z]],
        [[0.0, 0.0, 0.0], [0.0, y, z], [0.0, 0.0, z]],
        [[x, 0.0, 0.0], [x, y, z], [x, y, 0.0]],
        [[x, 0.0, 0.0], [x, 0.0, z], [x, y, z]],
    ];
    let mut out = String::from("solid box\n");
    for face in faces {
        out.push_str("facet normal 0 0 0\nouter loop\n");
        for v in face {
            out.push_str(&format!("vertex {} {} {}\n", v[0], v[1], v[2]));
        }
        out.push_str("endloop\nendfacet\n");
    }
    out.push_str("endsolid box\n");
    out
}

fn request(extra: Value) -> SliceRequest {
    let stl = box_stl(2.0);
    let mut body = json!({
        "filename": "box.stl",
        "dataB64": base64::engine::general_purpose::STANDARD.encode(stl.as_bytes()),
        "layerHeight": 0.2,
        "lineWidth": 0.45,
        "blend": {"mode": "single", "strategy": "toughness"},
        "baseline": false,
        "compare": false,
        "supports": false,
        "includePreview": false,
        "includeGcode": true,
    });
    for (key, value) in extra.as_object().unwrap() {
        body[key] = value.clone();
    }
    serde_json::from_value(body).unwrap()
}

fn gcode(extra: Value) -> String {
    slice_request(&request(extra), Job::start()).unwrap().gcode
}

fn notes(gcode: &str) -> Vec<String> {
    gcode
        .lines()
        .filter_map(|line| line.strip_prefix(";LAYER:"))
        .map(str::to_owned)
        .collect()
}

#[test]
fn an_object_can_set_infill_walls_and_speed_and_a_range_wins() {
    let plain = gcode(json!({}));
    assert!(notes(&plain).iter().any(|n| n.contains("walls=5")));
    assert!(notes(&plain).iter().any(|n| n.contains("infill=48%")));
    assert!(notes(&plain).iter().any(|n| n.contains("45mm/s")));
    let wire = serde_json::to_value(request(json!({}))).unwrap();
    assert!(wire.get("infill").is_none(), "{wire}");
    assert!(wire.get("walls").is_none(), "{wire}");
    assert!(wire.get("speed").is_none(), "{wire}");

    let own = gcode(json!({ "walls": 3, "infill": 0.8, "speed": 30 }));
    assert!(notes(&own).iter().all(|n| n.contains("walls=3")));
    assert!(notes(&own).iter().all(|n| n.contains("infill=80%")));
    assert!(notes(&own).iter().all(|n| n.contains("30mm/s")));
    assert_ne!(own, plain);

    let ranged = gcode(json!({
        "walls": 3,
        "infill": 0.8,
        "heightRanges": [{ "z": [0.0, 0.4], "walls": 6 }],
    }));
    let ranged_notes = notes(&ranged);
    assert!(ranged_notes[0].contains("walls=6"), "{}", ranged_notes[0]);
    assert!(ranged_notes[0].contains("infill=80%"), "{}", ranged_notes[0]);
    assert!(
        ranged_notes.last().unwrap().contains("walls=3"),
        "{}",
        ranged_notes.last().unwrap()
    );

    let err = slice_request(&request(json!({ "walls": 0 })), Job::start()).unwrap_err();
    assert_eq!(err, "walls 0 is outside 1 to 12");
    let err = slice_request(&request(json!({ "infill": 2.0 })), Job::start()).unwrap_err();
    assert_eq!(err, "infill 2 is outside 0 to 1");
    let err = slice_request(&request(json!({ "speed": 0.0 })), Job::start()).unwrap_err();
    assert_eq!(err, "speed 0 is outside 0 to 1000 mm/s");
}
