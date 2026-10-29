//! Parts that need more than 20,000 layers slice end to end: a long bar on a
//! 45° belt and a tall column on a flat bed.

use base64::Engine;
use lime_slice_core::{slice_request, Job, SliceRequest};
use serde_json::{json, Value};

fn box_stl(x: f64, y: f64, z: f64) -> String {
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

fn request(stl: &str, extra: Value) -> SliceRequest {
    let mut body = json!({
        "filename": "long.stl",
        "dataB64": base64::engine::general_purpose::STANDARD.encode(stl.as_bytes()),
        "layerHeight": 0.08,
        "lineWidth": 0.45,
        "baseline": false,
        "compare": false,
        "includePreview": true,
        "includeGcode": true,
    });
    for (key, value) in extra.as_object().unwrap() {
        body[key] = value.clone();
    }
    serde_json::from_value(body).unwrap()
}

fn layer_marks(gcode: &str) -> usize {
    gcode.lines().filter(|l| l.starts_with(";LAYER:")).count()
}

#[test]
fn a_2_3_m_bar_on_a_45_degree_belt_slices_past_20000_layers() {
    let belt = json!({
        "belt": { "angleDeg": 45.0, "axis": "z", "direction": 1, "widthMm": 250.0, "copies": 1, "gapMm": 5.0 },
    });
    let response =
        slice_request(&request(&box_stl(20.0, 2300.0, 10.0), belt), Job::default()).unwrap();
    let layers = response.layers.len();
    assert!(layers > 20_000, "{layers} layers");
    assert_eq!(layer_marks(&response.gcode), layers);
}

#[test]
fn a_1_7_m_column_on_a_flat_bed_slices_past_20000_layers() {
    let response = slice_request(
        &request(&box_stl(20.0, 20.0, 1700.0), json!({})),
        Job::default(),
    )
    .unwrap();
    assert_eq!(response.layers.len(), 21_250);
    assert_eq!(layer_marks(&response.gcode), 21_250);
    let top = response.layers.last().unwrap().z;
    assert!((top - 1700.0).abs() < 1e-3, "top at {top}");
}
