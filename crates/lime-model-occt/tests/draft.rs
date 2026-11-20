//! Draft on faces that already exist. A positive angle opens the faces toward the pull, so a box
//! drafted about its bottom shrinks at the top. Volumes are the closed forms, within 1e-6 relative.
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

fn ok(request: Value) -> Value {
    let reply = call(request.clone());
    assert!(reply.get("error").is_none(), "{request} -> {reply}");
    reply
}

fn volume(reply: &Value) -> f64 {
    assert!(reply.get("error").is_none(), "{reply}");
    reply["volumeMm3"].as_f64().expect("volumeMm3")
}

/// `|actual - expected| / |expected|`, and it must be within 1e-6.
fn rel(actual: f64, expected: f64) {
    let err = (actual - expected).abs() / expected.abs();
    assert!(
        err <= 1e-6,
        "{actual} vs {expected}: relative {err} is over 1e-6"
    );
}

fn ready(key: &str) -> bool {
    let opened = call(json!({ "call": "open", "key": key, "box": [40.0, 30.0, 20.0] }));
    if opened.get("error").is_some() {
        assert!(!require(), "OCCT was required: {opened}");
        return false;
    }
    rel(volume(&opened), 40.0 * 30.0 * 20.0);
    true
}

/// A planar face with this outward normal. A cylinder also reports a normal, and it is not a wall.
fn face_facing(reply: &Value, normal: [f64; 3]) -> usize {
    let faces = reply["faces"].as_array().expect("faces");
    let found: Vec<usize> = faces
        .iter()
        .enumerate()
        .filter(|(_, face)| {
            face.get("surface").is_none()
                && face["normal"].as_array().is_some_and(|n| {
                    (0..3).all(|i| (n[i].as_f64().unwrap() - normal[i]).abs() < 1e-6)
                })
        })
        .map(|(index, _)| index)
        .collect();
    assert_eq!(found.len(), 1, "one face faces {normal:?} in {faces:?}");
    found[0]
}

fn area(reply: &Value, index: usize) -> f64 {
    reply["faces"][index]["areaMm2"].as_f64().expect("areaMm2")
}

fn apply(key: &str, parent: u32, node: u32, op: Value) -> Value {
    ok(json!({ "call": "apply", "key": key, "parent": parent, "node": node, "op": op }))
}

fn walls(reply: &Value) -> Vec<usize> {
    [[1.0, 0.0, 0.0], [-1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, -1.0, 0.0]]
        .into_iter()
        .map(|normal| face_facing(reply, normal))
        .collect()
}

fn draft(faces: &[usize], angle: f64) -> Value {
    json!({ "kind": "draft", "faces": faces, "angleDeg": angle })
}

/// Four walls of a `40 × 30 × h` box, drafted `angle` degrees about the bottom, pull +Z.
///
/// Each wall tilts by the angle, so at height `z` the section is smaller by `2 z tan(angle)` on
/// every side. The top is not a scaled copy of the bottom (40 and 30 shrink by the same length),
/// so the volume is the integral of that rectangle, not the similar-section frustum.
fn drafted_box(h: f64, angle: f64) -> (f64, f64) {
    let t = angle.to_radians().tan();
    let top = (40.0 - 2.0 * h * t) * (30.0 - 2.0 * h * t);
    let volume = 40.0 * 30.0 * h - (40.0 + 30.0) * h * h * t + (4.0 / 3.0) * h * h * h * t * t;
    (volume, top)
}

#[test]
fn four_walls_at_three_degrees_match_the_frustum() {
    if !ready("four") {
        return;
    }
    let opened = ok(json!({ "call": "goto", "key": "four", "node": 0 }));
    let faces = walls(&opened);
    let drafted = apply("four", 0, 1, draft(&faces, 3.0));
    let (expected, top) = drafted_box(20.0, 3.0);
    rel(volume(&drafted), expected);
    // The top shrinks by 2 · 20 · tan 3° on each side, so its area is that rectangle.
    rel(area(&drafted, face_facing(&drafted, [0.0, 0.0, 1.0])), top);
}

#[test]
fn one_wall_at_five_degrees_matches_the_prism() {
    if !ready("one") {
        return;
    }
    let opened = ok(json!({ "call": "goto", "key": "one", "node": 0 }));
    let face = face_facing(&opened, [1.0, 0.0, 0.0]);
    let drafted = apply("one", 0, 1, draft(&[face], 5.0));
    let theta = 5.0_f64.to_radians();
    rel(volume(&drafted), 40.0 * 30.0 * 20.0 - 6000.0 * theta.tan());
    rel(
        area(&drafted, face_facing(&drafted, [0.0, 0.0, 1.0])),
        30.0 * (40.0 - 20.0 * theta.tan()),
    );
    // The opposite wall and the floor stay. The walls beside the drafted one stay on their planes.
    rel(area(&drafted, face_facing(&drafted, [-1.0, 0.0, 0.0])), 30.0 * 20.0);
    rel(area(&drafted, face_facing(&drafted, [0.0, 0.0, -1.0])), 40.0 * 30.0);
    face_facing(&drafted, [0.0, 1.0, 0.0]);
    face_facing(&drafted, [0.0, -1.0, 0.0]);
}

#[test]
fn a_positive_angle_shrinks_the_top_and_a_negative_one_grows_it() {
    if !ready("sign") {
        return;
    }
    let opened = ok(json!({ "call": "goto", "key": "sign", "node": 0 }));
    let faces = walls(&opened);
    let plus = apply("sign", 0, 1, draft(&faces, 3.0));
    let minus = apply("sign", 0, 2, draft(&faces, -3.0));
    let (plus_volume, plus_top) = drafted_box(20.0, 3.0);
    let (minus_volume, minus_top) = drafted_box(20.0, -3.0);
    rel(volume(&plus), plus_volume);
    rel(area(&plus, face_facing(&plus, [0.0, 0.0, 1.0])), plus_top);
    rel(volume(&minus), minus_volume);
    rel(area(&minus, face_facing(&minus, [0.0, 0.0, 1.0])), minus_top);
    assert!(plus_top < 40.0 * 30.0 && minus_top > 40.0 * 30.0);
}

#[test]
fn a_cylinder_side_at_two_degrees_becomes_a_frustum() {
    let rod = call(json!({
        "call": "open", "key": "rod",
        "primitive": { "primitive": "cylinder", "origin": [0.0, 0.0, 0.0], "radius": 10.0, "height": 20.0 }
    }));
    if rod.get("error").is_some() {
        assert!(!require(), "OCCT was required: {rod}");
        return;
    }
    let side = rod["faces"]
        .as_array()
        .unwrap()
        .iter()
        .position(|face| face["surface"] == json!("cylinder"))
        .expect("a cylinder side");
    let drafted = apply("rod", 0, 1, draft(&[side], 2.0));
    let top_r = 10.0 - 20.0 * 2.0_f64.to_radians().tan();
    let expected = PI * 20.0 / 3.0 * (10.0 * 10.0 + 10.0 * top_r + top_r * top_r);
    rel(volume(&drafted), expected);
    rel(area(&drafted, face_facing(&drafted, [0.0, 0.0, 1.0])), PI * top_r * top_r);
    assert!(
        drafted["faces"]
            .as_array()
            .unwrap()
            .iter()
            .any(|face| face["surface"] == json!("cone")),
        "the side is a cone: {}",
        drafted["faces"]
    );
}

#[test]
fn a_wall_beside_a_fillet_is_drafted_or_refused_cleanly() {
    if !ready("fillet") {
        return;
    }
    let opened = ok(json!({ "call": "goto", "key": "fillet", "node": 0 }));
    let vertical: Vec<i64> = opened["edgeLengths"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .filter(|(_, length)| (length.as_f64().unwrap() - 20.0).abs() < 1e-6)
        .map(|(index, _)| index as i64)
        .collect();
    assert_eq!(vertical.len(), 4, "four vertical edges");
    let filleted = apply(
        "fillet",
        0,
        1,
        json!({ "kind": "fillet", "edges": vertical, "size": 1.0 }),
    );
    let before = volume(&filleted);
    let face = face_facing(&filleted, [1.0, 0.0, 0.0]);
    let drafted = call(json!({
        "call": "apply", "key": "fillet", "parent": 1, "node": 2,
        "op": draft(&[face], 3.0)
    }));
    if let Some(message) = drafted["error"].as_str() {
        assert!(!message.is_empty(), "a refusal says why");
        let still = ok(json!({ "call": "goto", "key": "fillet", "node": 1 }));
        rel(volume(&still), before);
        eprintln!("draft fillet-adjacent: refused: {message}");
    } else {
        let after = volume(&drafted);
        assert!(after.is_finite() && (after - before).abs() > 1e-6 * before, "{drafted}");
        eprintln!("draft fillet-adjacent: drafted, volume {after} (was {before})");
    }
}

#[test]
fn a_floor_is_refused_and_a_bad_face_refuses_its_index() {
    if !ready("floor") {
        return;
    }
    let opened = ok(json!({ "call": "goto", "key": "floor", "node": 0 }));
    let floor = face_facing(&opened, [0.0, 0.0, 1.0]);
    let refused = call(json!({
        "call": "apply", "key": "floor", "parent": 0, "node": 1,
        "op": draft(&[floor], 3.0)
    }));
    let message = refused["error"].as_str().expect("an error");
    // The face is named by its index on the solid, as picked, not by its place in the list.
    assert!(
        message.starts_with(&format!("Face {floor} is a floor")),
        "{message}"
    );
    rel(volume(&ok(json!({ "call": "goto", "key": "floor", "node": 0 }))), 24000.0);

    let side = face_facing(&opened, [1.0, 0.0, 0.0]);
    let other = face_facing(&opened, [-1.0, 0.0, 0.0]);
    let mixed = call(json!({
        "call": "apply", "key": "floor", "parent": 0, "node": 1,
        "op": draft(&[side, floor, other], 3.0)
    }));
    let mixed_message = mixed["error"].as_str().expect("an error");
    assert!(
        mixed_message.starts_with(&format!("Face {floor} is a floor")),
        "the bad face is named by its index, not its place (1) in the list: {mixed_message}"
    );
    rel(volume(&ok(json!({ "call": "goto", "key": "floor", "node": 0 }))), 24000.0);
}

#[test]
fn a_draft_is_applied_again_after_an_earlier_hole_changes() {
    if !ready("replay") {
        return;
    }
    let hole = |radius: f64| {
        json!({
            "kind": "hole", "origin": [20.0, 15.0, 20.0], "axis": [0.0, 0.0, -1.0],
            "radius": radius, "depth": 3.0, "through": true
        })
    };
    let drilled = apply("replay", 0, 1, hole(2.0));
    rel(volume(&drilled), 24000.0 - PI * 4.0 * 20.0);
    let drafted = apply("replay", 1, 2, draft(&walls(&drilled), 3.0));
    let (body, _) = drafted_box(20.0, 3.0);
    rel(volume(&drafted), body - PI * 4.0 * 20.0);
    let edited = call(json!({
        "call": "edit", "key": "replay", "parent": 0, "node": 3, "op": hole(3.0),
        "replay": [{ "id": 4, "op": drafted["op"] }],
    }));
    assert!(edited.get("error").is_none() && edited.get("broken").is_none(), "{edited}");
    rel(volume(&edited), body - PI * 9.0 * 20.0);
}

#[test]
fn an_imported_step_box_drafts_the_same_way() {
    if !ready("step") {
        return;
    }
    let exported = ok(json!({ "call": "export", "key": "step", "node": 0, "format": "step" }));
    let imported = ok(json!({ "call": "open", "key": "step-in", "dataB64": exported["bytesBase64"] }));
    rel(volume(&imported), 24000.0);
    let drafted = apply("step-in", 0, 1, draft(&walls(&imported), 3.0));
    let (expected, top) = drafted_box(20.0, 3.0);
    rel(volume(&drafted), expected);
    rel(area(&drafted, face_facing(&drafted, [0.0, 0.0, 1.0])), top);
}

#[test]
fn a_group_cannot_contain_a_draft() {
    if !ready("group") {
        return;
    }
    let opened = ok(json!({ "call": "goto", "key": "group", "node": 0 }));
    let face = face_facing(&opened, [1.0, 0.0, 0.0]);
    let refused = call(json!({
        "call": "apply", "key": "group", "parent": 0, "node": 1,
        "op": { "kind": "group", "label": "Draft", "steps": [draft(&[face], 3.0)] }
    }));
    assert_eq!(
        refused["error"].as_str(),
        Some("Step 1 of 1: A group cannot contain a draft."),
        "{refused}"
    );
    rel(volume(&ok(json!({ "call": "goto", "key": "group", "node": 0 }))), 24000.0);
}

#[test]
fn a_zero_angle_and_a_duplicate_face_are_refused() {
    if !ready("bad") {
        return;
    }
    let opened = ok(json!({ "call": "goto", "key": "bad", "node": 0 }));
    let face = face_facing(&opened, [1.0, 0.0, 0.0]);
    let zero = call(json!({
        "call": "apply", "key": "bad", "parent": 0, "node": 1,
        "op": draft(&[face], 0.0)
    }));
    assert_eq!(
        zero["error"].as_str(),
        Some("The draft angle must be between -30 and 30 degrees, and not 0."),
        "{zero}"
    );
    let twice = call(json!({
        "call": "apply", "key": "bad", "parent": 0, "node": 1,
        "op": draft(&[face, face], 3.0)
    }));
    assert_eq!(
        twice["error"].as_str(),
        Some(format!("Face {face} is listed twice.").as_str()),
        "{twice}"
    );
    rel(volume(&ok(json!({ "call": "goto", "key": "bad", "node": 0 }))), 24000.0);
}

fn bottom_and_top(reply: &Value) -> (f64, f64) {
    (
        area(reply, face_facing(reply, [0.0, 0.0, -1.0])),
        area(reply, face_facing(reply, [0.0, 0.0, 1.0])),
    )
}

/// The +X wall of the 40 × 30 × 20 box drafted 3° about a plane at mid-height. The wall pivots
/// on the line at z = 10: the top loses 10 tan 3° of width and the bottom gains the same, so the
/// volume is the box's. The draft is a change all the same and must build.
#[test]
fn a_neutral_plane_at_mid_height_drafts_although_the_volume_stays() {
    if !ready("mid") {
        return;
    }
    let opened = ok(json!({ "call": "goto", "key": "mid", "node": 0 }));
    let face = face_facing(&opened, [1.0, 0.0, 0.0]);
    let drafted = apply(
        "mid",
        0,
        1,
        json!({
            "kind": "draft", "faces": [face], "angleDeg": 3.0,
            "neutral": { "origin": [0.0, 0.0, 10.0], "normal": [0.0, 0.0, 1.0] }
        }),
    );
    let t = 3.0_f64.to_radians().tan();
    rel(volume(&drafted), 40.0 * 30.0 * 20.0);
    let (bottom, top) = bottom_and_top(&drafted);
    rel(top, 30.0 * (40.0 - 10.0 * t));
    rel(bottom, 30.0 * (40.0 + 10.0 * t));
}

/// The +X wall drafted 3° about the top face: the top stays 40 wide, the bottom grows by 20 tan 3°,
/// and the box gains the wedge 30 · 20 · 20 tan 3° / 2.
#[test]
fn a_neutral_face_keeps_that_face_and_tilts_the_wall_about_it() {
    if !ready("neutral-face") {
        return;
    }
    let opened = ok(json!({ "call": "goto", "key": "neutral-face", "node": 0 }));
    let face = face_facing(&opened, [1.0, 0.0, 0.0]);
    let top_face = face_facing(&opened, [0.0, 0.0, 1.0]);
    let drafted = apply(
        "neutral-face",
        0,
        1,
        json!({ "kind": "draft", "faces": [face], "angleDeg": 3.0, "neutral": top_face }),
    );
    let t = 3.0_f64.to_radians().tan();
    rel(volume(&drafted), 40.0 * 30.0 * 20.0 + 6000.0 * t);
    let (bottom, top) = bottom_and_top(&drafted);
    rel(top, 30.0 * 40.0);
    rel(bottom, 30.0 * (40.0 + 20.0 * t));
}

/// Pulled down (−Z), the +X wall opens toward the bottom about the plane through its lowest point
/// along the pull, the top: the bottom loses 20 tan 3° of width and the top stays.
#[test]
fn a_pull_down_drafts_the_wall_about_the_top() {
    if !ready("pull-down") {
        return;
    }
    let opened = ok(json!({ "call": "goto", "key": "pull-down", "node": 0 }));
    let face = face_facing(&opened, [1.0, 0.0, 0.0]);
    let drafted = apply(
        "pull-down",
        0,
        1,
        json!({ "kind": "draft", "faces": [face], "angleDeg": 3.0, "pull": [0.0, 0.0, -1.0] }),
    );
    let t = 3.0_f64.to_radians().tan();
    rel(volume(&drafted), 40.0 * 30.0 * 20.0 - 6000.0 * t);
    let (bottom, top) = bottom_and_top(&drafted);
    rel(top, 30.0 * 40.0);
    rel(bottom, 30.0 * (40.0 - 20.0 * t));
}
