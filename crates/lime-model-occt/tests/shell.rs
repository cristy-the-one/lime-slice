//! Shell: a solid hollowed inward to a wall thickness, with faces open or none. Each volume against a hand-computed
//! one, the probe's measures, an open face found again after an edit above renumbers the faces, and each refusal.
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

/// The index of the face whose outward normal is `normal`, as `faces_find` reads the reply.
fn face_facing(reply: &Value, normal: [f64; 3]) -> usize {
    let faces = reply["faces"].as_array().expect("faces");
    let found: Vec<usize> = faces
        .iter()
        .enumerate()
        .filter(|(_, face)| {
            face["normal"]
                .as_array()
                .is_some_and(|n| (0..3).all(|i| (n[i].as_f64().unwrap() - normal[i]).abs() < 1e-6))
        })
        .map(|(index, _)| index)
        .collect();
    assert_eq!(found.len(), 1, "one face faces {normal:?}: {found:?}");
    found[0]
}

/// The largest face whose outward normal is `normal`.
fn largest_facing(reply: &Value, normal: [f64; 3]) -> usize {
    let faces = reply["faces"].as_array().expect("faces");
    let facing = |face: &Value| {
        face["normal"]
            .as_array()
            .is_some_and(|n| (0..3).all(|i| (n[i].as_f64().unwrap() - normal[i]).abs() < 1e-6))
    };
    let area = |index: usize| faces[index]["areaMm2"].as_f64().unwrap();
    (0..faces.len())
        .filter(|index| facing(&faces[*index]))
        .max_by(|a, b| area(*a).total_cmp(&area(*b)))
        .expect("a face facing that way")
}

fn shell(thickness: f64, open: &[usize]) -> Value {
    json!({ "kind": "shell", "thickness": thickness, "openFaces": open })
}

const UP: [f64; 3] = [0.0, 0.0, 1.0];

#[test]
fn hollow_a_box_and_a_cylinder() {
    // A box 20 × 20 × 10: 4000 mm³.
    let opened = call(json!({ "call": "open", "key": "s", "box": [20.0, 20.0, 10.0] }));
    if opened.get("error").is_some() {
        assert!(!require(), "OCCT was required: {opened}");
        return;
    }
    let top = face_facing(&opened, UP);

    // Open at the top, walls 1 mm: the inside is 18 × 18 × 9.
    let cup = apply("s", 0, 1, &shell(1.0, &[top]));
    near(volume(&cup), 4000.0 - 18.0 * 18.0 * 9.0);
    let stored = &cup["op"]["openFaces"][0];
    assert_eq!(stored["index"], json!(top), "the face is stored as a reference: {stored}");
    near(stored["areaMm2"].as_f64().unwrap(), 400.0);
    // Two faces open: a tray open at the top and the front.
    let front = face_facing(&opened, [0.0, -1.0, 0.0]);
    near(
        volume(&apply("s", 0, 2, &shell(1.0, &[top, front]))),
        4000.0 - 18.0 * 19.0 * 9.0,
    );

    // None open: a closed void, one solid of two shells, as the probe says before Apply.
    let probe = call(json!({ "call": "probe", "key": "s", "node": 0, "op": shell(1.0, &[]) }));
    assert_eq!(probe["ok"], json!(true), "{probe}");
    near(probe["volumeMm3"].as_f64().unwrap(), 4000.0 - 18.0 * 18.0 * 8.0);
    assert_eq!((probe["solids"].clone(), probe["shells"].clone()), (json!(1), json!(2)));
    near(probe["before"]["volumeMm3"].as_f64().unwrap(), 4000.0);
    assert_eq!((probe["before"]["solids"].clone(), probe["before"]["shells"].clone()), (json!(1), json!(1)));
    let closed = apply("s", 0, 3, &shell(1.0, &[]));
    near(volume(&closed), 4000.0 - 18.0 * 18.0 * 8.0);
    assert!(closed["op"].get("openFaces").is_none(), "{}", closed["op"]);
    refused(
        &apply("s", 3, 4, &shell(0.5, &[])),
        "This part is hollow already.",
    );

    refused(
        &apply("s", 0, 90, &shell(0.0, &[top])),
        "A shell needs a wall thickness above 0.",
    );
    refused(
        &apply("s", 0, 90, &shell(1.0, &[40])),
        "That face is not on this solid.",
    );
    refused(
        &apply("s", 0, 90, &shell(1.0, &[0, 1, 2, 3, 4, 5])),
        "A shell needs at least one face left closed.",
    );
    refused(
        &apply("s", 0, 90, &shell(12.0, &[top])),
        "This wall is too thick for the part's smallest feature.",
    );
    let probe = call(json!({ "call": "probe", "key": "s", "node": 0, "op": shell(12.0, &[top]) }));
    assert_eq!(probe["ok"], json!(false), "{probe}");
    assert_eq!(
        probe["error"],
        json!("This wall is too thick for the part's smallest feature.")
    );

    // A cylinder ⌀20 × 20, open at the top, walls 1 mm.
    let rod = call(json!({ "call": "open", "key": "c", "primitive": { "primitive": "cylinder", "origin": [0, 0, 0], "radius": 10.0, "height": 20.0 } }));
    let lid = face_facing(&rod, UP);
    near(
        volume(&apply("c", 0, 1, &shell(1.0, &[lid]))),
        PI * 100.0 * 20.0 - PI * 81.0 * 19.0,
    );
}

#[test]
fn an_open_face_survives_an_edit_above() {
    let opened = call(json!({ "call": "open", "key": "e", "box": [20.0, 20.0, 10.0] }));
    if opened.get("error").is_some() {
        assert!(!require(), "OCCT was required: {opened}");
        return;
    }
    // A bump on the front wall, then a shell open at the top.
    let notch = |x: f64| json!({ "kind": "boolean", "op": "fuse", "primitive": "box", "origin": [x, -3.0, 3.0], "size": [4.0, 3.0, 4.0] });
    let notched = apply("e", 0, 1, &notch(5.0));
    let top = largest_facing(&notched, UP);
    let hollow = apply("e", 1, 2, &shell(1.0, &[top]));
    let before = volume(&hollow);
    // The bump moves to its mirror image. The top is found again by its centre and area, whatever its index.
    let edited = call(json!({
        "call": "edit", "key": "e", "parent": 0, "node": 3, "op": notch(11.0),
        "replay": [{ "id": 4, "op": hollow["op"] }],
    }));
    assert!(edited.get("broken").is_none(), "{edited}");
    near(volume(&edited), before);
    let moved = largest_facing(&apply("e", 0, 5, &notch(11.0)), UP);
    assert_eq!(edited["built"][1]["op"]["openFaces"][0]["index"], json!(moved));
}
