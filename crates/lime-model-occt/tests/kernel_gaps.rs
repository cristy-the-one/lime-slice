//! Rounded pockets and bosses, chamfers by two sizes, merged coplanar faces, and fillet edges that survive a rebuild
//! that moved them. `LIME_REQUIRE_OCCT=1` makes a missing kernel a failure.
//!
//! The store is process-wide, so everything runs in one test, in order, each part in its own document.

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

fn refused(request: Value) -> String {
    let reply = call(request.clone());
    reply["error"]
        .as_str()
        .unwrap_or_else(|| panic!("{request} was not refused: {reply}"))
        .to_string()
}

fn volume(reply: &Value) -> f64 {
    reply["volumeMm3"].as_f64().expect("volumeMm3")
}

fn near(actual: f64, expected: f64, tolerance: f64) {
    assert!(
        (actual - expected).abs() < tolerance,
        "{actual} is not near {expected}"
    );
}

fn faces(reply: &Value) -> Vec<(f64, [f64; 3])> {
    reply["faces"]
        .as_array()
        .expect("faces")
        .iter()
        .map(|face| {
            let n = face["normal"].as_array().map(|n| {
                [0, 1, 2].map(|i| n.get(i).and_then(Value::as_f64).unwrap_or(0.0))
            });
            (face["areaMm2"].as_f64().expect("areaMm2"), n.unwrap_or([0.0; 3]))
        })
        .collect()
}

/// Faces whose outward normal is `normal`, by area, largest first.
fn facing(reply: &Value, normal: [f64; 3]) -> Vec<f64> {
    let mut areas: Vec<f64> = faces(reply)
        .into_iter()
        .filter(|(_, n)| (0..3).all(|i| (n[i] - normal[i]).abs() < 1e-6))
        .map(|(area, _)| area)
        .collect();
    areas.sort_by(|a, b| b.total_cmp(a));
    areas
}

fn edge_count(reply: &Value) -> usize {
    reply["edgeLengths"].as_array().expect("edgeLengths").len()
}

fn box_at(origin: [f64; 3], size: [f64; 3]) -> Value {
    json!({ "primitive": "box", "origin": origin, "size": size })
}

/// The area of a `w` × `h` rectangle with corners rounded to `r`.
fn rounded_area(w: f64, h: f64, r: f64) -> f64 {
    w * h - (4.0 - PI) * r * r
}

#[test]
fn kernel_gaps() {
    let opened = call(json!({ "call": "open", "key": "g8", "primitive": box_at([0.0, 0.0, 0.0], [60.0, 40.0, 10.0]) }));
    if opened.get("error").is_some() {
        assert!(!require(), "OCCT was required: {opened}");
        return;
    }

    // --- Item 8. A box with rounded corners is one solid; as a tool it cuts a rounded pocket and fuses a rounded boss.
    let rounded = ok(json!({ "call": "open", "key": "g8r",
        "primitive": { "primitive": "box", "origin": [0.0, 0.0, 0.0], "size": [20.0, 10.0, 5.0], "cornerRadius": 3.0 } }));
    near(volume(&rounded), rounded_area(20.0, 10.0, 3.0) * 5.0, 1e-6);
    assert_eq!(facing(&rounded, [0.0, 0.0, 1.0]).len(), 1, "one top face");
    let full = ok(json!({ "call": "open", "key": "g8f",
        "primitive": { "primitive": "box", "origin": [0.0, 0.0, 0.0], "size": [20.0, 10.0, 5.0], "cornerRadius": 5.0 } }));
    near(volume(&full), rounded_area(20.0, 10.0, 5.0) * 5.0, 1e-6);
    let too_round = refused(json!({ "call": "open", "key": "g8x",
        "primitive": { "primitive": "box", "origin": [0.0, 0.0, 0.0], "size": [20.0, 10.0, 5.0], "cornerRadius": 5.5 } }));
    assert!(too_round.contains("at most half its shorter side, 5 mm"), "{too_round}");

    // A pocket 20 × 10 with r 3, 4 deep, in the top of the 60 × 40 × 10 block; the tool rises 1 mm past the face.
    let pocket = ok(json!({ "call": "apply", "key": "g8", "parent": 0, "node": 1, "op": {
        "kind": "boolean", "op": "cut", "primitive": "box", "origin": [20.0, 15.0, 6.0], "size": [20.0, 10.0, 5.0],
        "cornerRadius": 3.0, "merge": true } }));
    near(volume(&pocket), 24000.0 - rounded_area(20.0, 10.0, 3.0) * 4.0, 1e-3);
    assert_eq!(pocket["op"]["cornerRadius"], json!(3.0), "{}", pocket["op"]);
    // A boss 10 × 10, r 2, 3 high on the pocket's floor, sunk 0.2 mm into it as a boss is.
    let boss = ok(json!({ "call": "apply", "key": "g8", "parent": 1, "node": 2, "op": {
        "kind": "boolean", "op": "fuse", "primitive": "box", "origin": [25.0, 15.0, 5.8], "size": [10.0, 10.0, 3.2],
        "cornerRadius": 2.0, "merge": true } }));
    near(volume(&boss), volume(&pocket) + rounded_area(10.0, 10.0, 2.0) * 3.0, 1e-3);

    // --- Item 13. A 20 mm cube's top edge along X at −Y, chamfered 2 along the top and 5 down the side.
    ok(json!({ "call": "open", "key": "g13", "primitive": box_at([0.0, 0.0, 0.0], [20.0; 3]) }));
    let edges = ok(json!({ "call": "goto", "key": "g13", "node": 0 }));
    let top_front = (0..edge_count(&edges))
        .find(|&index| {
            let reply = call(json!({ "call": "probe", "key": "g13", "node": 0,
                "preview": true, "op": { "kind": "chamfer", "edges": [index], "size": 2.0, "size2": 5.0 } }));
            reply["firstFaces"][0]["normal"] == json!([0.0, 0.0, 1.0])
                && (volume(&reply) - (8000.0 - 0.5 * 2.0 * 5.0 * 20.0)).abs() < 1e-6
                && reply.get("preview").is_some_and(|shown| faces(shown).iter().any(|(area, n)| (n[1] + 1.0).abs() < 1e-9 && (area - 300.0).abs() < 1e-6))
        })
        .expect("the top edge at −Y takes 2 along the top and 5 down the side");
    let two = ok(json!({ "call": "apply", "key": "g13", "parent": 0, "node": 1,
        "op": { "kind": "chamfer", "edges": [top_front], "size": 2.0, "size2": 5.0 } }));
    near(volume(&two), 8000.0 - 0.5 * 2.0 * 5.0 * 20.0, 1e-6);
    assert_eq!(facing(&two, [0.0, 0.0, 1.0]), vec![20.0 * 18.0], "the top keeps 18 of its 20 mm");
    assert_eq!(facing(&two, [0.0, -1.0, 0.0]), vec![20.0 * 15.0], "the side keeps 15 of its 20 mm");
    assert_eq!(two["op"]["size2"], json!(5.0));
    // Flipped: 2 down the side and 5 along the top.
    let flipped = ok(json!({ "call": "apply", "key": "g13", "parent": 0, "node": 2,
        "op": { "kind": "chamfer", "edges": [top_front], "size": 2.0, "size2": 5.0, "flip": true } }));
    assert_eq!(facing(&flipped, [0.0, 0.0, 1.0]), vec![20.0 * 15.0]);
    assert_eq!(facing(&flipped, [0.0, -1.0, 0.0]), vec![20.0 * 18.0]);
    // The owner's barb: 2.7 along the top, 5 down the side.
    let barb = ok(json!({ "call": "apply", "key": "g13", "parent": 0, "node": 3,
        "op": { "kind": "chamfer", "edges": [top_front], "size": 2.7, "size2": 5.0 } }));
    near(volume(&barb), 8000.0 - 0.5 * 2.7 * 5.0 * 20.0, 1e-6);
    // A distance and an angle: 2 along the top at 45° is 2 down the side.
    let angled = ok(json!({ "call": "apply", "key": "g13", "parent": 0, "node": 4,
        "op": { "kind": "chamfer", "edges": [top_front], "size": 2.0, "angleDeg": 45.0 } }));
    near(volume(&angled), 8000.0 - 0.5 * 2.0 * 2.0 * 20.0, 1e-6);
    // 2 along the top at 60° from it runs 2·tan 60° down the side.
    let steep = ok(json!({ "call": "apply", "key": "g13", "parent": 0, "node": 5,
        "op": { "kind": "chamfer", "edges": [top_front], "size": 2.0, "angleDeg": 60.0 } }));
    let down = 2.0 * (60.0f64).to_radians().tan();
    near(volume(&steep), 8000.0 - 0.5 * 2.0 * down * 20.0, 1e-3);
    let both = refused(json!({ "call": "probe", "key": "g13", "node": 0,
        "op": { "kind": "chamfer", "edges": [top_front], "size": 2.0, "size2": 3.0, "angleDeg": 45.0 } }));
    assert!(both.contains("not both"), "{both}");
    // Equal distances stay the default, and store as they did.
    let equal = ok(json!({ "call": "apply", "key": "g13", "parent": 0, "node": 6,
        "op": { "kind": "chamfer", "edges": [top_front], "size": 2.0 } }));
    near(volume(&equal), 8000.0 - 40.0, 1e-6);
    assert!(equal["op"].get("size2").is_none() && equal["op"].get("flip").is_none(), "{}", equal["op"]);

    // --- Item 14. Two boxes side by side, fused: without merge the top is two faces, with it one, and a chamfer runs
    // the whole 40 mm edge across the old seam.
    ok(json!({ "call": "open", "key": "g14", "primitive": box_at([-20.0, -20.0, 0.0], [40.0, 20.0, 10.0]) }));
    let side = json!({ "kind": "boolean", "op": "fuse", "primitive": "box", "origin": [-20.0, 0.0, 0.0], "size": [40.0, 20.0, 10.0] });
    let split = ok(json!({ "call": "apply", "key": "g14", "parent": 0, "node": 1, "op": side }));
    let mut merged_op = side.clone();
    merged_op["merge"] = json!(true);
    let merged = ok(json!({ "call": "apply", "key": "g14", "parent": 0, "node": 2, "op": merged_op }));
    near(volume(&merged), 16000.0, 1e-6);
    assert!(facing(&split, [0.0, 0.0, 1.0]).len() == 2, "{:?}", facing(&split, [0.0, 0.0, 1.0]));
    assert_eq!(facing(&merged, [0.0, 0.0, 1.0]), vec![1600.0]);
    assert_eq!(faces(&merged).len(), 6);
    assert_eq!(edge_count(&merged), 12);
    assert_eq!(merged["op"]["merge"], json!(true));
    assert!(split["op"].get("merge").is_none(), "a boolean without merge stores as before: {}", split["op"]);
    let long = merged["edgeLengths"]
        .as_array()
        .expect("edgeLengths")
        .iter()
        .position(|length| (length.as_f64().unwrap_or(0.0) - 40.0).abs() < 1e-6)
        .expect("a 40 mm edge");
    let across = ok(json!({ "call": "apply", "key": "g14", "parent": 2, "node": 3,
        "op": { "kind": "chamfer", "edges": [long], "size": 2.0 } }));
    near(volume(&across), 16000.0 - 0.5 * 2.0 * 2.0 * 40.0, 1e-6);
    // A pad flush with the rim: a 40 × 20 pocket 4 deep, then a 40 × 6 boss on its floor up to the top. With merge,
    // the rim top and the pad top are one face.
    for (key, merge) in [("g14p", false), ("g14m", true)] {
        ok(json!({ "call": "open", "key": key, "primitive": box_at([-30.0, -20.0, 0.0], [60.0, 40.0, 10.0]) }));
        let mut cut = json!({ "kind": "boolean", "op": "cut", "primitive": "box", "origin": [-20.0, -10.0, 6.0], "size": [40.0, 20.0, 5.0] });
        let mut pad = json!({ "kind": "boolean", "op": "fuse", "primitive": "box", "origin": [-20.0, -3.0, 5.8], "size": [40.0, 6.0, 4.2] });
        if merge {
            cut["merge"] = json!(true);
            pad["merge"] = json!(true);
        }
        ok(json!({ "call": "apply", "key": key, "parent": 0, "node": 1, "op": cut }));
        let padded = ok(json!({ "call": "apply", "key": key, "parent": 1, "node": 2, "op": pad }));
        near(volume(&padded), 24000.0 - 800.0 * 4.0 + 240.0 * 4.0, 1e-3);
        let tops = facing(&padded, [0.0, 0.0, 1.0]);
        if merge {
            assert_eq!(tops.len(), 3, "the top is one face, with the two pocket floors: {tops:?}");
            near(tops[0], 2400.0 - 800.0 + 240.0, 1e-6);
        } else {
            assert_eq!(tops.len(), 4, "the rim top and the pad top are apart: {tops:?}");
        }
    }

    // --- Item 17. The rim of a 150 × 60 × 8 cover with r 5 corners, a pocket 4 deep leaving a 1 mm wall, and a boss on
    // its floor out to the wall, sunk 0.2 mm as a boss is. Without merge the outside wall keeps a 0.2 mm strip.
    for (key, merge) in [("g17s", false), ("g17m", true)] {
        ok(json!({ "call": "open", "key": key,
            "primitive": { "primitive": "box", "origin": [-75.0, -30.0, 0.0], "size": [150.0, 60.0, 8.0], "cornerRadius": 5.0 } }));
        let mut cut = json!({ "kind": "boolean", "op": "cut", "primitive": "box", "origin": [-74.0, -29.0, 4.0],
            "size": [148.0, 58.0, 5.0], "cornerRadius": 4.0 });
        let mut pad = json!({ "kind": "boolean", "op": "fuse", "primitive": "box", "origin": [70.0, -10.0, 3.8],
            "size": [5.0, 20.0, 4.2] });
        if merge {
            cut["merge"] = json!(true);
            pad["merge"] = json!(true);
        }
        ok(json!({ "call": "apply", "key": key, "parent": 0, "node": 1, "op": cut }));
        let padded = ok(json!({ "call": "apply", "key": key, "parent": 1, "node": 2, "op": pad }));
        let slivers: Vec<f64> = faces(&padded)
            .into_iter()
            .map(|(area, _)| area)
            .filter(|area| *area < 5.0)
            .collect();
        let outside = facing(&padded, [1.0, 0.0, 0.0]);
        if merge {
            assert!(slivers.is_empty(), "no sliver faces: {slivers:?}");
            assert_eq!(outside.len(), 2, "the outside wall at +X is one face, and the pocket's wall: {outside:?}");
        } else {
            assert!(outside.len() > 2, "the outside wall at +X is split: {outside:?}");
        }
    }

    // --- Item 12. A box 20 × 20 × 10 centred on the origin, one vertical edge filleted r 2, then the box made 30
    // wide by an edit of its root, as a variable change would: the same corner is still the filleted one.
    let start = ok(json!({ "call": "open", "key": "g12", "primitive": box_at([-10.0, -10.0, 0.0], [20.0, 20.0, 10.0]) }));
    let mut corner = None;
    for index in 0..edge_count(&start) {
        let probe = call(json!({ "call": "probe", "key": "g12", "node": 0,
            "op": { "kind": "fillet", "edges": [index], "size": 2.0 } }));
        if probe["ok"] == json!(true) {
            let applied = ok(json!({ "call": "apply", "key": "g12", "parent": 0, "node": 1,
                "op": { "kind": "fillet", "edges": [index], "size": 2.0 } }));
            let edge = &applied["op"]["edges"][0];
            if edge["mid"] == json!([-10.0, -10.0, 5.0]) {
                corner = Some(applied);
                break;
            }
            ok(json!({ "call": "drop", "key": "g12", "node": 1 }));
        }
    }
    let filleted = corner.expect("the vertical edge at (−10, −10)");
    let round_off = 10.0 * 4.0 * (1.0 - PI / 4.0);
    near(volume(&filleted), 4000.0 - round_off, 1e-6);
    let stored = filleted["op"].clone();
    assert!(stored["edges"][0]["sig"].is_object(), "a fresh pick is stored with its signature: {stored}");
    let wider = ok(json!({ "call": "edit", "key": "g12", "parent": 0, "node": 2,
        "op": { "kind": "root", "primitive": "box", "origin": [-15.0, -10.0, 0.0], "size": [30.0, 20.0, 10.0] },
        "replay": [{ "id": 3, "op": stored }] }));
    near(volume(&wider), 6000.0 - round_off, 1e-6);
    let replayed = &wider["built"].as_array().expect("built").last().expect("the fillet")["op"]["edges"][0];
    assert_eq!(replayed["mid"], json!([-15.0, -10.0, 5.0]), "the same corner, moved: {replayed}");
    // Taller and narrower: the edge's length and both ends change.
    let taller = ok(json!({ "call": "edit", "key": "g12", "parent": 0, "node": 4,
        "op": { "kind": "root", "primitive": "box", "origin": [-8.0, -10.0, 0.0], "size": [16.0, 20.0, 14.0] },
        "replay": [{ "id": 5, "op": stored }] }));
    near(volume(&taller), 16.0 * 20.0 * 14.0 - 14.0 * 4.0 * (1.0 - PI / 4.0), 1e-6);
    // An edge stored before signatures (as 4.0.0 saved it) still rebuilds where it is, and is stored as it was. Moved,
    // it is lost as it was before: nothing tells which edge it was.
    let mut old = stored.clone();
    old["edges"][0].as_object_mut().expect("ref").remove("sig");
    let again = ok(json!({ "call": "apply", "key": "g12", "parent": 0, "node": 6, "op": old.clone() }));
    near(volume(&again), 4000.0 - round_off, 1e-6);
    assert!(again["op"]["edges"][0].get("sig").is_none(), "{}", again["op"]);
    let lost = call(json!({ "call": "edit", "key": "g12", "parent": 0, "node": 7,
        "op": { "kind": "root", "primitive": "box", "origin": [-15.0, -10.0, 0.0], "size": [30.0, 20.0, 10.0] },
        "replay": [{ "id": 8, "op": old }] }));
    assert_eq!(lost["broken"]["error"], json!("That edge is not on this solid"), "{}", lost["broken"]);
}
