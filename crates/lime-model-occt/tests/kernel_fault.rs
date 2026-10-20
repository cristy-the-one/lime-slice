//! A crash inside Open CASCADE refuses the step instead of ending the app.
//!
//! 3.1.1 died in Model with an access violation in TKBRep.dll: a push on a wall of a part with raised lettering made
//! BRepOffset_Inter2d (GetEdgesOrientedInFace) hand BRepAdaptor_Curve a null edge, inside BRepOffset_MakeOffset.
//! These steps are the app's own: Text as a group of turned box strokes, a fillet of one letter's edges, and a push.
//! `LIME_REQUIRE_OCCT=1` makes a missing kernel a failure.

use serde_json::{json, Value};

const CANNOT_MOVE: &str =
    "This face cannot move with its neighbours here. Push or pull adds material instead: hold Alt.";
const INTERNAL: &str = "The modeler hit an internal error on this step; the step was not applied.";

/// A stroke's box: origin, size, turn, as the app's Text tool sends them for a 6 mm letter, 0.9 mm strokes, 1 mm raised.
type Stroke = ([f64; 3], [f64; 3], [f64; 3]);

/// "A" on the top of a 40 × 30 × 20 box.
const TEXT_A: &[Stroke] = &[
    ([15.55, 13.55, 19.8], [4.9, 0.9, 1.2], [0.0, 0.0, 90.0]),
    (
        [17.135786437626905, 16.55, 19.8],
        [3.72842712474619, 0.9, 1.2],
        [0.0, 0.0, 45.0],
    ),
    (
        [19.135786437626905, 16.55, 19.8],
        [3.72842712474619, 0.9, 1.2],
        [0.0, 0.0, -45.0],
    ),
    ([19.55, 13.55, 19.8], [4.9, 0.9, 1.2], [0.0, 0.0, -90.0]),
    ([17.55, 14.55, 19.8], [4.9, 0.9, 1.2], [0.0, 0.0, 0.0]),
];

/// "B" on its front (−Y). The first five strokes are enough for the crash: the stem and most of the upper bowl.
const TEXT_B: &[Stroke] = &[
    ([14.55, -0.85, 9.4], [6.9, 0.9, 1.2], [90.0, -90.0, 0.0]),
    (
        [17.55, -0.8499999999999999, 12.4],
        [3.9, 0.9, 1.2],
        [90.0, 0.0, 0.0],
    ),
    (
        [20.34289321881345, -0.8499999999999999, 11.9],
        [2.3142135623730953, 0.9, 1.2],
        [90.0, 45.0, 0.0],
    ),
    (
        [21.05, -0.8499999999999999, 10.9],
        [1.9, 0.9, 1.2],
        [90.0, 90.0, 0.0],
    ),
    (
        [20.34289321881345, -0.8499999999999999, 9.9],
        [2.3142135623730953, 0.9, 1.2],
        [-90.0, 45.0, 180.0],
    ),
    ([17.55, -0.85, 9.4], [3.9, 0.9, 1.2], [-90.0, 0.0, 180.0]),
    (
        [20.34289321881345, -0.8500000000000001, 8.9],
        [2.3142135623730953, 0.9, 1.2],
        [90.0, 45.0, 0.0],
    ),
    (
        [21.05, -0.8500000000000001, 7.9],
        [1.9, 0.9, 1.2],
        [90.0, 90.0, 0.0],
    ),
    (
        [20.34289321881345, -0.8500000000000001, 6.9],
        [2.3142135623730953, 0.9, 1.2],
        [-90.0, 45.0, 180.0],
    ),
    (
        [17.55, -0.8500000000000001, 6.4],
        [3.9, 0.9, 1.2],
        [-90.0, 0.0, 180.0],
    ),
];

/// "C" on its right (+X).
const TEXT_C: &[Stroke] = &[
    (
        [38.449999999999996, 15.05, 12.4],
        [3.9, 0.9, 1.2],
        [-90.0, 0.0, -90.0],
    ),
    (
        [39.24289321881345, 13.05, 11.9],
        [2.3142135623730953, 0.9, 1.2],
        [-90.0, 45.0, -90.0],
    ),
    (
        [37.949999999999996, 12.55, 9.4],
        [4.9, 0.9, 1.2],
        [0.0, 90.0, 0.0],
    ),
    (
        [39.24289321881345, 13.05, 6.9],
        [2.3142135623730953, 0.9, 1.2],
        [90.0, 45.0, 90.0],
    ),
    (
        [38.449999999999996, 15.05, 6.4],
        [3.9, 0.9, 1.2],
        [90.0, 0.0, 90.0],
    ),
];

fn call(request: Value) -> Value {
    let text = lime_model_occt::tree(&request.to_string());
    serde_json::from_str(&text).unwrap_or_else(|err| panic!("not JSON ({err}): {text}"))
}

fn ok(reply: Value) -> Value {
    assert!(reply.get("error").is_none(), "{reply}");
    reply
}

/// A step that crashed Open CASCADE 7.9.2 on Windows is refused there with one of `refusals`. Linux and macOS round
/// differently and may not reach the null edge, so there a solid is fine too; a refusal is still one of `refusals`.
fn survived(reply: &Value, refusals: &[&str]) {
    match reply.get("error") {
        Some(error) => assert!(refusals.iter().any(|said| error == &json!(said)), "{reply}"),
        None => assert!(
            !cfg!(windows) && reply["volumeMm3"].as_f64().is_some_and(|v| v > 0.0),
            "refused on Windows: {reply}"
        ),
    }
}

/// The box, or None when the kernel is not linked.
fn open(key: &str) -> Option<Value> {
    let opened = call(json!({ "call": "open", "key": key, "box": [40.0, 30.0, 20.0] }));
    if opened.get("error").is_some() {
        assert!(
            std::env::var_os("LIME_REQUIRE_OCCT").is_none(),
            "OCCT was required: {opened}"
        );
        return None;
    }
    Some(opened)
}

fn text(letter: &str, strokes: &[Stroke]) -> Value {
    let steps: Vec<Value> = strokes
        .iter()
        .map(|(origin, size, turn)| {
            json!({ "kind": "boolean", "op": "fuse", "primitive": "box", "origin": origin, "size": size,
                "radius": 0, "height": 0, "turn": turn })
        })
        .collect();
    json!({ "kind": "group", "label": format!("Text {letter}"), "source": { "kind": "text", "text": letter },
        "steps": steps })
}

fn apply(key: &str, parent: u32, node: u32, op: Value) -> Value {
    call(json!({ "call": "apply", "key": key, "parent": parent, "node": node, "op": op }))
}

fn push(face: usize, distance: f64) -> Value {
    json!({ "kind": "moveFaces", "faces": [{ "face": face, "distance": distance }] })
}

/// The one face facing `normal` exactly, with `area`.
fn face_of(reply: &Value, normal: [f64; 3], area: f64) -> usize {
    let faces = reply["faces"].as_array().expect("faces");
    let found: Vec<usize> = (0..faces.len())
        .filter(|&i| {
            let face = &faces[i];
            (face["areaMm2"].as_f64().unwrap() - area).abs() < 1e-6
                && face["normal"].as_array().is_some_and(|n| {
                    (0..3).all(|k| (n[k].as_f64().unwrap() - normal[k]).abs() < 1e-9)
                })
        })
        .collect();
    assert_eq!(
        found.len(),
        1,
        "one face faces {normal:?} with {area} mm²: {found:?}"
    );
    found[0]
}

/// The minimal repro: the left wall (−X) pushed in 0.05 mm, with five strokes of a raised "B" on the front.
#[test]
fn a_wall_push_beside_raised_lettering_is_refused_instead_of_crashing() {
    if open("wall").is_none() {
        return;
    }
    let lettered = ok(apply("wall", 0, 1, text("B", &TEXT_B[..5])));
    let wall = face_of(&lettered, [-1.0, 0.0, 0.0], 600.0);

    // The drag's probe and the Apply both meet the crash, and both refuse.
    let probed = call(
        json!({ "call": "probe", "key": "wall", "node": 1, "op": push(wall, -0.05), "preview": true }),
    );
    survived(&probed, &[CANNOT_MOVE]);
    let applied = apply("wall", 1, 2, push(wall, -0.05));
    survived(&applied, &[CANNOT_MOVE]);

    // The tree is still whole: the lettered solid is unchanged, and another step builds on it.
    let back = ok(call(json!({ "call": "goto", "key": "wall", "node": 1 })));
    assert_eq!(back["fingerprint"], lettered["fingerprint"], "{back}");
    let top = face_of(&lettered, [0.0, 0.0, 1.0], 1200.0);
    let raised = ok(apply(
        "wall",
        1,
        3,
        json!({ "kind": "faceExtrude", "face": top, "distance": 2.0 }),
    ));
    let before = lettered["volumeMm3"].as_f64().unwrap();
    let after = raised["volumeMm3"].as_f64().unwrap();
    assert!((after - before - 2400.0).abs() < 0.5, "{before} -> {after}");
}

/// The owner's steps: a letter on each of three faces, the top letter's edges filleted, then its rounded faces pushed
/// and pulled. Each answer is a solid or a sentence, and the part stays usable after.
#[test]
fn the_rounded_faces_of_a_filleted_letter_push_or_refuse() {
    if open("owner").is_none() {
        return;
    }
    ok(apply("owner", 0, 1, text("A", TEXT_A)));
    ok(apply("owner", 1, 2, text("B", TEXT_B)));
    ok(apply("owner", 2, 3, text("C", TEXT_C)));
    let filleted = ok(apply(
        "owner",
        3,
        4,
        json!({ "kind": "fillet", "edges": [{ "fromNode": 1 }], "size": 0.1 }),
    ));
    let faces = filleted["faces"].as_array().expect("faces");
    let owners = filleted["stepFaces"].as_array().expect("stepFaces");
    // The fillet's own rounds: a cylinder band and a corner sphere.
    let rounds: Vec<usize> = ["cylinder", "sphere"]
        .iter()
        .map(|surface| {
            (0..faces.len())
                .find(|&i| owners[i] == json!(4) && faces[i]["surface"] == json!(surface))
                .unwrap_or_else(|| panic!("a {surface} round: {filleted}"))
        })
        .collect();
    // The top face the letter stands on, which the fillet trimmed: the largest facing up.
    let top = (0..faces.len())
        .filter(|&i| faces[i]["normal"] == json!([0.0, 0.0, 1.0]))
        .max_by(|&a, &b| {
            faces[a]["areaMm2"]
                .as_f64()
                .unwrap()
                .total_cmp(&faces[b]["areaMm2"].as_f64().unwrap())
        })
        .expect("the top");
    for face in rounds.into_iter().chain([top]) {
        for distance in [-0.05, 0.05] {
            let reply = call(
                json!({ "call": "probe", "key": "owner", "node": 4, "op": push(face, distance), "preview": true }),
            );
            if let Some(error) = reply.get("error") {
                let said = error.as_str().unwrap_or_default();
                assert!(
                    said.ends_with('.') && said.len() > 20,
                    "face {face} by {distance}: {reply}"
                );
            } else {
                assert!(reply["volumeMm3"].as_f64().unwrap() > 0.0, "{reply}");
            }
        }
    }
    let back = ok(call(json!({ "call": "goto", "key": "owner", "node": 4 })));
    assert_eq!(back["fingerprint"], filleted["fingerprint"], "{back}");
}

/// A fillet of the front letter's edges crashed in TKFillet (ChFi3d_FilBuilder::PerformThreeCorner) before the push.
#[test]
fn a_fillet_that_crashes_the_kernel_is_refused() {
    if open("blend").is_none() {
        return;
    }
    ok(apply("blend", 0, 1, text("A", TEXT_A)));
    ok(apply("blend", 1, 2, text("B", TEXT_B)));
    let lettered = ok(apply("blend", 2, 3, text("C", TEXT_C)));
    let reply = apply(
        "blend",
        3,
        4,
        json!({ "kind": "fillet", "edges": [{ "fromNode": 2 }], "size": 0.1 }),
    );
    survived(&reply, &["The fillet did not fit these edges", INTERNAL]);
    let back = ok(call(json!({ "call": "goto", "key": "blend", "node": 3 })));
    assert_eq!(back["fingerprint"], lettered["fingerprint"], "{back}");
}

/// The guard itself: an access violation inside TKBRep on purpose (a curve read off a null edge, the owner's crash)
/// comes back as the sentence, and the tree goes on answering.
#[cfg(lime_occt_test_hooks)]
#[test]
fn a_deliberate_access_violation_is_answered_with_a_sentence() {
    let Some(opened) = open("fault") else {
        return;
    };
    for _ in 0..2 {
        let reply = call(json!({ "call": "testFault", "key": "fault", "node": 0 }));
        assert_eq!(reply["error"], json!(INTERNAL), "{reply}");
    }
    let back = ok(call(json!({ "call": "goto", "key": "fault", "node": 0 })));
    assert_eq!(back["fingerprint"], opened["fingerprint"], "{back}");
    ok(apply(
        "fault",
        0,
        1,
        json!({ "kind": "boolean", "op": "cut", "primitive": "box", "origin": [5.0, 5.0, 15.0], "size": [4.0, 4.0, 10.0] }),
    ));
}
