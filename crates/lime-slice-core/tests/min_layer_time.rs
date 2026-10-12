//! A layer that would print faster than `minLayerTimeS` is slowed so the plastic can cool
//! before the next one lands on it. A request without the field keeps its bytes.

use base64::Engine;
use lime_slice_core::{slice_request, Job, SliceRequest, SliceResponse};
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

fn request(size: [f64; 3], extra: Value) -> SliceRequest {
    let mut body = json!({
        "filename": "box.stl",
        "dataB64": base64::engine::general_purpose::STANDARD
            .encode(box_stl(size[0], size[1], size[2]).as_bytes()),
        "layerHeight": 0.2,
        "lineWidth": 0.45,
        "blend": { "mode": "single", "strategy": "speed" },
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

fn slice(size: [f64; 3], extra: Value) -> SliceResponse {
    let response = slice_request(&request(size, extra), Job::default()).unwrap();
    assert!(response.sanity.ok, "{:?}", response.sanity.notes);
    response
}

/// The G-code after its header: every layer, nothing the header says about the request.
fn body(gcode: &str) -> &str {
    &gcode[gcode.find(";LAYER:0 ").expect("a first layer")..]
}

/// Feeds in mm/s of the moves that push filament along the layer, and of those that do not.
fn feeds(gcode: &str) -> (Vec<f64>, Vec<f64>) {
    let (mut printing, mut travelling) = (Vec::new(), Vec::new());
    for line in body(gcode).lines() {
        if !line.starts_with("G1 ") || !(line.contains(" X") || line.contains(" Y")) {
            continue;
        }
        let Some(f) = line
            .split_whitespace()
            .find_map(|w| w.strip_prefix('F')?.parse::<f64>().ok())
        else {
            continue;
        };
        if line.contains(" E") {
            printing.push(f / 60.0);
        } else {
            travelling.push(f / 60.0);
        }
    }
    (printing, travelling)
}

#[test]
fn a_small_cube_takes_at_least_the_minimum_on_every_layer() {
    let response = slice([10.0, 10.0, 3.0], json!({ "minLayerTimeS": 4.0 }));
    let plain = slice([10.0, 10.0, 3.0], json!({}));
    assert!(
        plain.layers.iter().any(|l| l.seconds < 3.0),
        "a 10 mm cube is quick without a minimum: {:?}",
        plain.layers.iter().map(|l| l.seconds).collect::<Vec<_>>()
    );
    assert!(response.layers.len() >= 10);
    let mut slowed = 0;
    for (layer, was) in response.layers.iter().zip(&plain.layers) {
        if was.seconds >= 4.0 {
            assert_eq!(layer.seconds, was.seconds, "layer {} was already slow enough", layer.index);
            continue;
        }
        slowed += 1;
        assert!(
            layer.seconds >= 4.0 * 0.98 && layer.seconds <= 4.0 * 1.05,
            "layer {} takes {} s",
            layer.index,
            layer.seconds
        );
    }
    assert!(slowed >= 8, "{slowed}");
    assert!(response.estimate.seconds > plain.estimate.seconds + 20.0);
}

#[test]
fn no_extrusion_goes_below_the_floor_and_travel_keeps_its_feed() {
    let plain = slice([10.0, 10.0, 3.0], json!({}));
    // Too long for a 10 mm cube to reach at the floor: it prints as slowly as allowed.
    let held = slice(
        [10.0, 10.0, 3.0],
        json!({ "minLayerTimeS": 120.0, "minLayerSpeedMmS": 20.0 }),
    );
    let (printing, travelling) = feeds(&held.gcode);
    let (plain_printing, plain_travelling) = feeds(&plain.gcode);
    assert!(!printing.is_empty());
    for feed in &printing {
        assert!(*feed >= 20.0 - 1e-6, "extruded at {feed} mm/s");
    }
    assert!(
        printing.iter().any(|f| (f - 20.0).abs() < 0.05),
        "something prints at the floor"
    );
    // The floor never speeds a path up: the first layer's 30 mm/s paths stay at or under 30.
    assert!(printing.iter().all(|f| *f <= plain_printing.iter().cloned().fold(0.0, f64::max) + 1e-6));
    let mut travel_set: Vec<i64> = travelling.iter().map(|f| (f * 1000.0) as i64).collect();
    let mut plain_set: Vec<i64> = plain_travelling.iter().map(|f| (f * 1000.0) as i64).collect();
    travel_set.sort_unstable();
    travel_set.dedup();
    plain_set.sort_unstable();
    plain_set.dedup();
    assert_eq!(travel_set, plain_set);
    // Out of reach, so the layers take what the floor allows, which is under the minimum.
    assert!(held.layers.iter().all(|l| l.seconds < 120.0));
}

#[test]
fn a_slowed_layer_says_so_and_a_free_layer_does_not() {
    let response = slice([10.0, 10.0, 3.0], json!({ "minLayerTimeS": 4.0 }));
    let tagged: Vec<&str> = body(&response.gcode)
        .lines()
        .filter(|l| l.starts_with(";LAYER:"))
        .collect();
    assert_eq!(tagged.len(), response.layers.len());
    let mut slowed = 0;
    for (line, layer) in tagged.iter().zip(&response.layers) {
        if layer.slow < 1.0 {
            slowed += 1;
            assert!(layer.slow > 0.0 && line.contains(" slow ×0."), "{line} {}", layer.slow);
        } else {
            assert!(!line.contains(" slow "), "{line}");
        }
    }
    assert!(slowed >= 8, "{slowed}");
    let big = slice([60.0, 60.0, 1.0], json!({ "minLayerTimeS": 1.0 }));
    assert!(body(&big.gcode).lines().all(|l| !l.contains(" slow ")));
    assert!(big.layers.iter().all(|l| l.slow == 1.0));
}

#[test]
fn a_layer_over_the_minimum_is_untouched_and_an_absent_field_changes_no_byte() {
    let plain = slice([60.0, 60.0, 1.0], json!({}));
    assert!(
        plain.layers.iter().all(|l| l.seconds > 2.0),
        "{:?}",
        plain.layers.iter().map(|l| l.seconds).collect::<Vec<_>>()
    );
    let asked = slice([60.0, 60.0, 1.0], json!({ "minLayerTimeS": 1.0 }));
    assert_eq!(body(&asked.gcode), body(&plain.gcode));
    assert_eq!(asked.estimate.seconds, plain.estimate.seconds);
    // Off by name is off.
    let off = slice([60.0, 60.0, 1.0], json!({ "minLayerTimeS": 0.0 }));
    assert_eq!(off.gcode, plain.gcode);
}

#[test]
fn the_floor_alone_changes_nothing() {
    let plain = slice([10.0, 10.0, 1.0], json!({}));
    let floor = slice([10.0, 10.0, 1.0], json!({ "minLayerSpeedMmS": 40.0 }));
    assert_eq!(floor.gcode, plain.gcode);
}

#[test]
fn a_belt_slice_of_a_small_part_gets_the_same() {
    let belt = json!({
        "angleDeg": 45.0, "axis": "z", "direction": 1, "widthMm": 220.0, "copies": 1, "gapMm": 5.0,
    });
    let plain = slice([10.0, 10.0, 2.0], json!({ "belt": belt }));
    let held = slice(
        [10.0, 10.0, 2.0],
        json!({ "belt": belt, "minLayerTimeS": 3.0 }),
    );
    assert!(
        plain.layers.iter().any(|l| l.seconds < 2.0),
        "{:?}",
        plain.layers.iter().map(|l| l.seconds).collect::<Vec<_>>()
    );
    assert_eq!(plain.layers.len(), held.layers.len());
    // Slivers at the bottom and top, and the belt-contact edge that already prints at 30 mm/s,
    // cannot reach the minimum at the 15 mm/s floor. The body of the part can.
    let mut checked = 0;
    for (layer, was) in held.layers.iter().zip(&plain.layers).skip(1) {
        if was.seconds < 0.9 {
            continue;
        }
        checked += 1;
        assert!(
            layer.seconds >= 3.0 * 0.98 && layer.seconds <= 3.0 * 1.05,
            "belt layer {} takes {} s",
            layer.index,
            layer.seconds
        );
    }
    assert!(checked >= 20, "{checked}");
    let (printing, _) = feeds(&held.gcode);
    assert!(printing.iter().all(|f| *f >= 15.0 - 1e-6), "{printing:?}");
}

#[test]
fn the_fields_are_plate_settings_and_are_checked() {
    let value = serde_json::to_value(request([10.0, 10.0, 1.0], json!({}))).unwrap();
    assert!(value.get("minLayerTimeS").is_none());
    assert!(value.get("minLayerSpeedMmS").is_none());

    for extra in [
        json!({ "minLayerTimeS": -1.0 }),
        json!({ "minLayerTimeS": 601.0 }),
        json!({ "minLayerTimeS": 8.0, "minLayerSpeedMmS": 0.5 }),
        json!({ "minLayerTimeS": 8.0, "minLayerSpeedMmS": 400.0 }),
    ] {
        let err = slice_request(&request([10.0, 10.0, 1.0], extra.clone()), Job::default())
            .unwrap_err();
        assert!(err.contains("minLayer"), "{extra}: {err}");
    }

    let err = slice_request(
        &serde_json::from_value(json!({
            "objects": [{
                "id": "a",
                "filename": "a.stl",
                "dataB64": "",
                "settings": { "minLayerTimeS": 8.0 }
            }]
        }))
        .unwrap(),
        Job::start(),
    )
    .unwrap_err();
    assert!(
        err.contains("objects[0].settings.minLayerTimeS is a plate setting"),
        "{err}"
    );
}
