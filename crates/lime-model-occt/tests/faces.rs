//! Face extrude and face move: a pulled box top, a widened hole, a prism on a side face, the refusal when a
//! face cannot move with its neighbours, a face found again after an edit above renumbers the faces, and the only face
//! of a closed curved part (an ellipsoid, a sphere, a torus) moved as one surface up to where it folds.
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

/// P1. A cylinder's wall carries its radius. A box face does not: that JSON stays as it was.
#[test]
fn a_cylinder_reports_its_radius_and_a_box_does_not() {
    let rod = call(json!({
        "call": "open", "key": "radius",
        "primitive": { "primitive": "cylinder", "origin": [0, 0, 0], "radius": 10.0, "height": 20.0 }
    }));
    if rod.get("error").is_some() {
        assert!(!require(), "OCCT was required: {rod}");
        return;
    }
    let wall = face_of_area(&rod, 2.0 * PI * 10.0 * 20.0);
    let face = &rod["faces"][wall];
    assert_eq!(face["surface"], json!("cylinder"), "{face}");
    near(face["radiusMm"].as_f64().unwrap(), 10.0);
    assert!(face["axis"].is_array(), "{face}");
    assert!(face["axisPoint"].is_array(), "{face}");

    let block = call(json!({ "call": "open", "key": "plain", "box": [20.0, 20.0, 10.0] }));
    for face in block["faces"].as_array().unwrap() {
        assert!(face.get("radiusMm").is_none(), "a box face has no radius: {face}");
        assert!(face.get("surface").is_none(), "a box face has no surface: {face}");
    }
}

/// The flat egg the owner pulled: 86.2 × 10 × 24, one closed face with no neighbours.
fn egg(key: &str) -> Option<Value> {
    let opened = call(json!({
        "call": "open", "key": key,
        "primitive": { "primitive": "ellipsoid", "origin": [0.0, 0.0, 12.0], "size": [86.2, 10.0, 24.0] }
    }));
    if opened.get("error").is_some() {
        assert!(!require(), "OCCT was required: {opened}");
        return None;
    }
    Some(opened)
}

const WHOLE_PART_PRISM: &str = "Alt adds a prism on a face's outline, and this face is the whole part, so it has none. \
     Drag without Alt to grow or shrink the part all round.";

fn folds(pushed: &str, most: &str) -> String {
    format!(
        "Pushed in {pushed} mm, this surface would fold onto itself where it curves tightest. It can go in at most {most} mm."
    )
}

/// A face that is the whole part moves as one surface: out without limit on a convex part, in only until the surface
/// would fold where it curves tightest. The face says how far that is, so the app can refuse before it asks.
#[test]
fn the_only_face_of_a_curved_part_offsets_the_whole_surface() {
    let Some(opened) = egg("egg") else {
        return;
    };
    let faces = opened["faces"].as_array().expect("faces");
    assert_eq!(faces.len(), 1, "{faces:?}");
    let face = &faces[0];
    assert_eq!(face["closed"], json!(true), "{face}");
    // The tightest curve is at the long ends, radius b² / a = 5² / 43.1 = 0.58 mm. Just under it, to the tenth below,
    // is the largest push that fits.
    assert_eq!(face["inMaxMm"].as_f64(), Some(0.5), "{face}");
    assert!(face.get("outMaxMm").is_none(), "a convex face may go out any distance: {face}");
    let before = volume(&opened);
    let area = face["areaMm2"].as_f64().unwrap();

    // Out 2 mm: at least the area times 2 is added, as for any convex part (Steiner), and not wildly more.
    let grown = volume(&apply("egg", 0, 1, &pull(0, 2.0)));
    assert!(grown > before + 2.0 * area, "{grown} vs {before} + 2 × {area}");
    assert!(grown < (before + 2.0 * area) * 1.1, "{grown}");

    // In 0.5 mm, just under the tightest curve: at most the area times 0.5 comes off.
    let shrunk = volume(&apply("egg", 0, 2, &pull(0, -0.5)));
    assert!(shrunk < before && shrunk > before - 0.5 * area, "{shrunk} vs {before}");

    // Deeper than that the surface would fold onto itself: refused with the largest push that fits.
    refused(&apply("egg", 0, 90, &pull(0, -24.9)), &folds("24.9", "0.5"));
    refused(&apply("egg", 0, 90, &pull(0, -0.6)), &folds("0.6", "0.5"));

    // A push that reads as the limit at the tenth is written to the hundredth, so the sentence does not refuse 0.5.
    refused(&apply("egg", 0, 90, &pull(0, -0.54)), &folds("0.54", "0.5"));

    // Alt's prism needs an outline to sweep, and the whole part has none.
    refused(
        &apply("egg", 0, 90, &json!({ "kind": "faceExtrude", "face": 0, "distance": 2.0 })),
        WHOLE_PART_PRISM,
    );

    // The same egg stood on end: its tightest curve is now at a pole of the stretched sphere, where the surface's
    // parameters are degenerate. It is read from beside the pole, not skipped.
    let standing = call(json!({
        "call": "open", "key": "egg-up",
        "primitive": { "primitive": "ellipsoid", "origin": [0.0, 0.0, 43.1], "size": [10.0, 24.0, 86.2] }
    }));
    assert_eq!(standing["faces"][0]["inMaxMm"].as_f64(), Some(0.5), "{}", standing["faces"][0]);
}

/// A ball-shaped void is a closed face too, but not the whole part: the sentences say so without calling it the part.
/// Open CASCADE's joined offset does not move such a wall inside a box yet, and the simple offset would move the box too.
#[test]
fn a_ball_void_is_closed_but_not_the_part() {
    let opened = call(json!({ "call": "open", "key": "void", "box": [20.0, 20.0, 20.0] }));
    if opened.get("error").is_some() {
        assert!(!require(), "OCCT was required: {opened}");
        return;
    }
    let hollow = apply(
        "void",
        0,
        1,
        &json!({ "kind": "boolean", "op": "cut", "primitive": "sphere", "origin": [10.0, 10.0, 10.0], "radius": 5.0 }),
    );
    let ball = |r: f64| 4.0 / 3.0 * PI * r * r * r;
    near(volume(&hollow), 8000.0 - ball(5.0));
    let wall = hollow["faces"]
        .as_array()
        .unwrap()
        .iter()
        .position(|face| face["closed"] == json!(true))
        .expect("the void's wall is closed");
    assert_eq!(hollow["faces"][wall]["inMaxMm"].as_f64(), None, "a void's wall is concave seen from the part");
    assert_eq!(hollow["faces"][wall]["outMaxMm"].as_f64(), Some(4.7), "{}", hollow["faces"][wall]);
    refused(
        &apply("void", 1, 90, &pull(wall, -1.0)),
        "Open CASCADE could not move this closed surface 1 mm as one.",
    );
    refused(
        &apply("void", 1, 90, &json!({ "kind": "faceExtrude", "face": wall, "distance": 1.0 })),
        "Alt adds a prism on a face's outline, and this closed surface has none. Drag without Alt to move all of it.",
    );
}

/// A sphere's one face, analytic: out and in by exact radii, and in only to just under its radius.
#[test]
fn a_sphere_grows_and_shrinks_by_its_radius() {
    let ball = call(json!({
        "call": "open", "key": "ball",
        "primitive": { "primitive": "sphere", "origin": [0.0, 0.0, 10.0], "radius": 10.0 }
    }));
    if ball.get("error").is_some() {
        assert!(!require(), "OCCT was required: {ball}");
        return;
    }
    let face = &ball["faces"][0];
    assert_eq!(face["closed"], json!(true), "{face}");
    assert_eq!(face["inMaxMm"].as_f64(), Some(9.5), "{face}");
    let sphere = |r: f64| 4.0 / 3.0 * PI * r * r * r;
    near(volume(&apply("ball", 0, 1, &pull(0, 2.0))), sphere(12.0));
    near(volume(&apply("ball", 0, 2, &pull(0, -9.5))), sphere(0.5));
    refused(&apply("ball", 0, 90, &pull(0, -10.0)), &folds("10", "9.5"));
    refused(
        &apply("ball", 0, 90, &json!({ "kind": "faceExtrude", "face": 0, "distance": -2.0 })),
        WHOLE_PART_PRISM,
    );
    // A torus is one closed face too. In, it folds at its tube's radius 5; out, where the hole closes, 20 − 5 = 15.
    let ring = call(json!({
        "call": "open", "key": "ring",
        "primitive": { "primitive": "torus", "origin": [0.0, 0.0, 5.0], "radius": 20.0, "tubeRadius": 5.0 }
    }));
    let face = &ring["faces"][0];
    assert_eq!(ring["faces"].as_array().map(Vec::len), Some(1), "{ring}");
    assert_eq!(face["closed"], json!(true), "{face}");
    assert_eq!(face["inMaxMm"].as_f64(), Some(4.7), "{face}");
    assert_eq!(face["outMaxMm"].as_f64(), Some(14.2), "{face}");
    // Pappus: 2π R × π r².
    let torus = |r: f64| 2.0 * PI * 20.0 * PI * r * r;
    near(volume(&apply("ring", 0, 1, &pull(0, 1.0))), torus(6.0));
    refused(
        &apply("ring", 0, 90, &pull(0, 15.0)),
        "Pulled out 15 mm, this surface would fold onto itself where it curves tightest. It can go out at most 14.2 mm.",
    );

    // A box face has neighbours: it is not closed and says nothing of a fold.
    let block = call(json!({ "call": "open", "key": "plain-fold", "box": [20.0, 20.0, 10.0] }));
    for face in block["faces"].as_array().unwrap() {
        assert!(face.get("closed").is_none() && face.get("inMaxMm").is_none(), "{face}");
    }
}
