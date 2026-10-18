//! Face extrude and face move: a pulled box top, a widened hole, a prism on a side face, the refusal when a
//! face cannot move with its neighbours, and a face found again after an edit above renumbers the faces.
//! `LIME_REQUIRE_OCCT=1` makes a missing kernel a failure.

use std::f64::consts::PI;

use serde_json::{json, Value};

fn require() -> bool {
    std::env::var_os("LIME_REQUIRE_OCCT").is_some()
}

fn call(request: Value) -> Value {
    let text = lime_model_occt::tree(&request.to_string());
    serde_json::from_str(&text).unwrap_or_else(|err| panic!("not JSON ({err}): {text}"))
}

fn volume(reply: &Value) -> f64 {
    assert!(reply.get("error").is_none(), "{reply}");
    reply["volumeMm3"].as_f64().expect("volumeMm3")
}

fn near(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() < 0.05,
        "{actual} is not near {expected}"
    );
}

fn apply(key: &str, parent: u32, node: u32, op: &Value) -> Value {
    call(json!({ "call": "apply", "key": key, "parent": parent, "node": node, "op": op }))
}

fn refused(reply: &Value, wanted: &str) {
    assert_eq!(reply["error"].as_str(), Some(wanted), "{reply}");
}

fn face_facing(reply: &Value, normal: [f64; 3]) -> usize {
    let faces = reply["faces"].as_array().expect("faces");
    let found: Vec<usize> = faces
        .iter()
        .enumerate()
        .filter(|(_, face)| {
            face["normal"].as_array().is_some_and(|n| {
                (0..3).all(|i| (n[i].as_f64().unwrap() - normal[i]).abs() < 1e-6)
            })
        })
        .map(|(index, _)| index)
        .collect();
    assert_eq!(found.len(), 1, "one face faces {normal:?}: {found:?}");
    found[0]
}

fn largest_facing(reply: &Value, normal: [f64; 3]) -> usize {
    let faces = reply["faces"].as_array().expect("faces");
    let facing = |face: &Value| {
        face["normal"].as_array().is_some_and(|n| {
            (0..3).all(|i| (n[i].as_f64().unwrap() - normal[i]).abs() < 1e-6)
        })
    };
    let area = |index: usize| faces[index]["areaMm2"].as_f64().unwrap();
    (0..faces.len())
        .filter(|index| facing(&faces[*index]))
        .max_by(|a, b| area(*a).total_cmp(&area(*b)))
        .expect("a face facing that way")
}

fn face_of_area(reply: &Value, area: f64) -> usize {
    let faces = reply["faces"].as_array().expect("faces");
    let found: Vec<usize> = faces
        .iter()
        .enumerate()
        .filter(|(_, face)| (face["areaMm2"].as_f64().unwrap() - area).abs() < 1.0)
        .map(|(index, _)| index)
        .collect();
    assert_eq!(found.len(), 1, "one face of area {area}: {faces:?}");
    found[0]
}

const UP: [f64; 3] = [0.0, 0.0, 1.0];
const CANNOT_MOVE: &str =
    "This face cannot move with its neighbours here. Push or pull adds material instead: hold Alt.";

fn pull(face: usize, distance: f64) -> Value {
    json!({ "kind": "moveFaces", "faces": [{ "face": face, "distance": distance }] })
}

#[test]
fn pull_a_box_top_and_extrude_a_side() {
    let opened = call(json!({ "call": "open", "key": "box", "box": [20.0, 20.0, 10.0] }));
    if opened.get("error").is_some() {
        assert!(!require(), "OCCT was required: {opened}");
        return;
    }
    near(volume(&opened), 4000.0);
    let top = face_facing(&opened, UP);

    // Pull the top 5 mm: 20 × 20 × 15.
    let taller = apply("box", 0, 1, &pull(top, 5.0));
    near(volume(&taller), 6000.0);
    let stored = &taller["op"]["faces"][0];
    assert_eq!(stored["face"]["index"], json!(top), "the face is stored as a reference: {stored}");
    near(stored["face"]["areaMm2"].as_f64().unwrap(), 400.0);
    assert!(taller["op"].get("draftDeg").is_none(), "{}", taller["op"]);

    let probe = call(json!({ "call": "probe", "key": "box", "node": 0, "op": pull(top, 5.0) }));
    assert_eq!(probe["ok"], json!(true), "{probe}");
    near(probe["volumeMm3"].as_f64().unwrap(), 6000.0);

    // A prism on the +X face, 5 mm out: the face is 20 × 10, so 1000 mm³ is added.
    let side = face_facing(&opened, [1.0, 0.0, 0.0]);
    let prism = apply(
        "box",
        0,
        2,
        &json!({ "kind": "faceExtrude", "face": side, "distance": 5.0 }),
    );
    near(volume(&prism), 5000.0);
    assert_eq!(prism["op"]["face"]["index"], json!(side));

    refused(
        &apply("box", 0, 90, &pull(top, 0.0)),
        "A face move needs a distance other than 0.",
    );
    refused(
        &apply("box", 0, 90, &json!({ "kind": "faceExtrude", "face": side, "distance": 0.0 })),
        "A face extrude needs a distance other than 0.",
    );
    refused(
        &apply("box", 0, 90, &pull(40, 1.0)),
        "That face is not on this solid.",
    );
    refused(
        &apply("box", 0, 90, &json!({ "kind": "moveFaces", "faces": [] })),
        "Pick a face to move.",
    );

    // The top pulled down through the box is not a move the neighbours can follow.
    refused(&apply("box", 0, 90, &pull(top, -100.0)), CANNOT_MOVE);

    // The top face's outline, in its own plane: origin at its centre, no turn, one loop of four lines.
    let loops = call(json!({ "call": "faceLoops", "key": "box", "node": 0, "face": top }));
    assert!(loops.get("error").is_none(), "{loops}");
    assert_eq!(loops["face"], json!(top));
    near(loops["origin"][0].as_f64().unwrap(), 10.0);
    near(loops["origin"][1].as_f64().unwrap(), 10.0);
    near(loops["origin"][2].as_f64().unwrap(), 10.0);
    for axis in 0..3 {
        near(loops["turn"][axis].as_f64().unwrap(), 0.0);
    }
    let ring = loops["loops"].as_array().expect("loops");
    assert_eq!(ring.len(), 1, "{ring:?}");
    let segments = ring[0]["segments"].as_array().expect("segments");
    assert_eq!(segments.len(), 4, "{segments:?}");
    assert!(segments.iter().all(|seg| seg["kind"] == "line"), "{segments:?}");
    let mut points = vec![
        [
            ring[0]["start"][0].as_f64().unwrap(),
            ring[0]["start"][1].as_f64().unwrap(),
        ],
    ];
    for seg in segments {
        points.push([seg["to"][0].as_f64().unwrap(), seg["to"][1].as_f64().unwrap()]);
    }
    for corner in [[-10.0, -10.0], [10.0, -10.0], [10.0, 10.0], [-10.0, 10.0]] {
        assert!(
            points.iter().any(|point| (point[0] - corner[0]).abs() < 1e-6 && (point[1] - corner[1]).abs() < 1e-6),
            "missing {corner:?} in {points:?}"
        );
    }

    let rod = call(json!({
        "call": "open", "key": "rod",
        "primitive": { "primitive": "cylinder", "origin": [0, 0, 0], "radius": 10.0, "height": 20.0 }
    }));
    let wall = face_of_area(&rod, 2.0 * PI * 10.0 * 20.0);
    refused(
        &call(json!({ "call": "faceLoops", "key": "rod", "node": 0, "face": wall })),
        "Face loops are for a flat face.",
    );
}

#[test]
fn move_a_hole_wall_wider() {
    let opened = call(json!({ "call": "open", "key": "hole", "box": [20.0, 20.0, 20.0] }));
    if opened.get("error").is_some() {
        assert!(!require(), "OCCT was required: {opened}");
        return;
    }
    // A through hole, radius 4, along −Z through the middle.
    let drilled = apply(
        "hole",
        0,
        1,
        &json!({
            "kind": "hole", "origin": [10.0, 10.0, 20.0], "axis": [0.0, 0.0, -1.0],
            "radius": 4.0, "depth": 3.0, "through": true
        }),
    );
    near(volume(&drilled), 8000.0 - PI * 16.0 * 20.0);
    let wall = face_of_area(&drilled, 2.0 * PI * 4.0 * 20.0);
    // The solid's outward normal on a hole wall points toward the axis, so a negative distance
    // moves the wall into the material and the hole grows from radius 4 to 5.
    let wider = apply("hole", 1, 2, &pull(wall, -1.0));
    near(volume(&wider), 8000.0 - PI * 25.0 * 20.0);
}

#[test]
fn a_moved_face_survives_an_edit_above() {
    let opened = call(json!({ "call": "open", "key": "edit", "box": [20.0, 20.0, 10.0] }));
    if opened.get("error").is_some() {
        assert!(!require(), "OCCT was required: {opened}");
        return;
    }
    let notch = |x: f64| {
        json!({
            "kind": "boolean", "op": "fuse", "primitive": "box",
            "origin": [x, -3.0, 3.0], "size": [4.0, 3.0, 4.0]
        })
    };
    let notched = apply("edit", 0, 1, &notch(5.0));
    let top = largest_facing(&notched, UP);
    let moved = apply("edit", 1, 2, &pull(top, 5.0));
    let before = volume(&moved);
    let edited = call(json!({
        "call": "edit", "key": "edit", "parent": 0, "node": 3, "op": notch(11.0),
        "replay": [{ "id": 4, "op": moved["op"] }],
    }));
    assert!(edited.get("broken").is_none(), "{edited}");
    near(volume(&edited), before);
    let again = largest_facing(&apply("edit", 0, 5, &notch(11.0)), UP);
    assert_eq!(edited["built"][1]["op"]["faces"][0]["face"]["index"], json!(again));
}
