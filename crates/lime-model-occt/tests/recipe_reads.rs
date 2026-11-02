//! Recipe reads and lattices (docs/plan-recipe-ingredients.md I5–I7, I18–I20): many outlines in one extrude, cells
//! clipped to a region with rounded corners and a draft, a combined group as one boolean with a step that fails by
//! index, a face's outline inset, and a section. `LIME_REQUIRE_OCCT=1` makes a missing kernel a failure.

use std::f64::consts::PI;
use std::time::Instant;

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

fn near(actual: f64, expected: f64, within: f64) {
    assert!((actual - expected).abs() <= within, "{actual} is not within {within} of {expected}");
}

fn apply(key: &str, parent: u32, node: u32, op: &Value) -> Value {
    call(json!({ "call": "apply", "key": key, "parent": parent, "node": node, "op": op }))
}

fn open(key: &str, size: [f64; 3]) -> Option<Value> {
    let opened = call(json!({ "call": "open", "key": key, "box": size }));
    if opened.get("error").is_some() {
        assert!(!require(), "OCCT was required: {opened}");
        return None;
    }
    Some(opened)
}

fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Value {
    json!({
        "start": [x0, y0],
        "segments": [
            { "kind": "line", "to": [x1, y0] },
            { "kind": "line", "to": [x1, y1] },
            { "kind": "line", "to": [x0, y1] },
            { "kind": "line", "to": [x0, y0] }
        ]
    })
}

fn hex(cx: f64, cy: f64, side: f64) -> Value {
    let corner = |k: usize| {
        let a = (90.0 + 60.0 * k as f64).to_radians();
        [cx + side * a.cos(), cy + side * a.sin()]
    };
    let segments: Vec<Value> = (1..=6).map(|k| json!({ "kind": "line", "to": corner(k % 6) })).collect();
    json!({ "start": corner(0), "segments": segments })
}

fn face_facing(reply: &Value, normal: [f64; 3]) -> usize {
    let faces = reply["faces"].as_array().expect("faces");
    faces
        .iter()
        .position(|face| {
            face["normal"]
                .as_array()
                .is_some_and(|n| (0..3).all(|i| (n[i].as_f64().unwrap() - normal[i]).abs() < 1e-6))
        })
        .expect("a face with that normal")
}

#[test]
fn many_outlines_cut_in_one_extrude() {
    let Some(opened) = open("many", [200.0, 200.0, 10.0]) else {
        return;
    };
    let block = 200.0 * 200.0 * 10.0;
    near(volume(&opened), block, 0.01);
    // 400 square pockets, 4 × 4 at a 9 mm pitch, 3 deep from the top: one extrude, one boolean.
    let mut squares = Vec::new();
    for i in 0..20 {
        for j in 0..20 {
            let (x, y) = (10.0 + 9.0 * i as f64, 10.0 + 9.0 * j as f64);
            squares.push(rect(x, y, x + 4.0, y + 4.0));
        }
    }
    let started = Instant::now();
    let cut = apply(
        "many",
        0,
        1,
        &json!({ "kind": "extrude", "op": "cut", "origin": [0.0, 0.0, 10.0], "depth": -3.0, "loops": squares }),
    );
    eprintln!("400 pockets in one extrude: {} ms", started.elapsed().as_millis());
    near(volume(&cut), block - 400.0 * 16.0 * 3.0, 0.5);

    // An outline, a hole, and an island in the hole: two outlines, the island raised inside the ring's hole.
    let nested = json!([rect(0.0, 0.0, 30.0, 30.0), rect(5.0, 5.0, 25.0, 25.0), rect(10.0, 10.0, 20.0, 20.0)]);
    let raised = apply(
        "many",
        0,
        2,
        &json!({ "kind": "extrude", "op": "fuse", "origin": [10.0, 10.0, 10.0], "depth": 2.0, "loops": nested }),
    );
    near(volume(&raised), block + (900.0 - 400.0 + 100.0) * 2.0, 0.05);

    // Loops in any order: the hole first, then its outline.
    let swapped = apply(
        "many",
        0,
        3,
        &json!({ "kind": "extrude", "op": "fuse", "origin": [10.0, 10.0, 10.0], "depth": 2.0,
                 "loops": [rect(5.0, 5.0, 25.0, 25.0), rect(0.0, 0.0, 30.0, 30.0)] }),
    );
    near(volume(&swapped), block + 500.0 * 2.0, 0.05);

    // Drafted cells with a hole each: every outline drafted, its hole the other way, one boolean.
    let mut rings = Vec::new();
    for i in 0..10 {
        let x = 20.0 + 15.0 * i as f64;
        rings.push(rect(x, 20.0, x + 10.0, 30.0));
        rings.push(rect(x + 3.0, 23.0, x + 7.0, 27.0));
    }
    let drafted = apply(
        "many",
        0,
        4,
        &json!({ "kind": "extrude", "op": "cut", "origin": [0.0, 0.0, 10.0], "depth": -2.0, "draftDeg": 5.0, "loops": rings }),
    );
    let removed = block - volume(&drafted);
    assert!(removed > 10.0 * (100.0 - 16.0) * 2.0 * 0.8 && removed < 10.0 * (100.0 - 16.0) * 2.0 * 1.2, "{removed}");

    let too_many: Vec<Value> = (0..1001).map(|i| rect(i as f64 * 0.15, 0.0, i as f64 * 0.15 + 0.1, 0.1)).collect();
    let refused = apply(
        "many",
        0,
        90,
        &json!({ "kind": "extrude", "op": "cut", "origin": [0.0, 0.0, 10.0], "depth": -1.0, "loops": too_many }),
    );
    assert_eq!(refused["error"].as_str(), Some("A profile takes at most 1000 loops."), "{refused}");
}

#[test]
fn cells_are_clipped_rounded_and_drafted_in_one_boolean() {
    let Some(_) = open("cells", [120.0, 80.0, 10.0]) else {
        return;
    };
    let block = 120.0 * 80.0 * 10.0;
    // A staggered hex lattice over the whole top, clipped to the top inset 5 mm.
    let side = 6.0;
    let mut cells = Vec::new();
    for j in -1..=10 {
        for i in -1..=13 {
            let shift = if j % 2 == 0 { 0.0 } else { 3f64.sqrt() * side / 2.0 };
            let (x, y) = (i as f64 * 3f64.sqrt() * side + shift, j as f64 * 1.5 * side);
            cells.push(hex(x, y, side - 1.0));
        }
    }
    let lattice = |extra: Value| {
        let mut op = json!({
            "kind": "extrude", "op": "cut", "origin": [0.0, 0.0, 10.0], "depth": -3.0,
            "loops": cells, "clip": [rect(5.0, 5.0, 115.0, 75.0)], "minArea": 4.0
        });
        for (key, value) in extra.as_object().unwrap() {
            op[key] = value.clone();
        }
        op
    };
    let started = Instant::now();
    let plain = apply("cells", 0, 1, &lattice(json!({})));
    eprintln!("{} cells clipped in one extrude: {} ms", cells.len(), started.elapsed().as_millis());
    let report = &plain["cells"];
    assert!(report["cells"].as_f64().unwrap() > 50.0, "{plain}");
    assert!(report["clipped"].as_f64().unwrap() > 10.0, "{report}");
    assert!(report["outside"].as_f64().unwrap() > 0.0, "{report}");
    let removed = block - volume(&plain);
    assert!(removed > 0.0 && removed < 110.0 * 70.0 * 3.0, "{removed}");
    // Nothing was cut outside the region: a section just under the top stays inside it.
    let section = call(json!({
        "call": "section", "key": "cells", "node": 1, "origin": [0.0, 0.0, 9.0], "normal": [0.0, 0.0, 1.0],
        "frame": [0.0, 0.0, 9.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0]
    }));
    assert!(section.get("error").is_none(), "{section}");
    let regions = section["regions"].as_array().expect("regions");
    assert_eq!(regions.len(), 1, "one slab with the cells as holes: {section}");
    let holes = regions[0]["holes"].as_array().expect("holes");
    assert_eq!(holes.len() as f64, report["cells"].as_f64().unwrap(), "every cell is a hole in the section");
    for hole in holes {
        for point in hole.as_array().unwrap() {
            let (u, v) = (point[0].as_f64().unwrap(), point[1].as_f64().unwrap());
            assert!((5.0 - 1e-6..=115.0 + 1e-6).contains(&u) && (5.0 - 1e-6..=75.0 + 1e-6).contains(&v), "{u}, {v}");
        }
    }
    near(section["areaMm2"].as_f64().unwrap(), 120.0 * 80.0 - removed / 3.0, 0.5);

    // Rounded and drafted: corners are counted, the pockets narrow toward their floors.
    let rounded = apply("cells", 0, 2, &lattice(json!({ "cornerRadius": 1.5, "draftDeg": 3.0 })));
    let corners = &rounded["cells"]["corners"];
    assert!(corners["full"].as_f64().unwrap() > 100.0, "{rounded}");
    let removed_rounded = block - volume(&rounded);
    assert!(removed_rounded < removed, "{removed_rounded} < {removed}");

    // A region that leaves no cell is a refusal; the op as stored replays to the same solid.
    let empty = apply("cells", 0, 90, &lattice(json!({ "clip": [rect(200.0, 200.0, 210.0, 210.0)] })));
    assert!(empty["error"].as_str().unwrap_or("").starts_with("No cell is left inside the region."), "{empty}");
    assert_eq!(plain["op"]["clip"], json!([rect(5.0, 5.0, 115.0, 75.0)]));
}

#[test]
fn a_combined_group_is_one_boolean_and_names_a_step_that_fails() {
    let Some(_) = open("combined", [100.0, 100.0, 10.0]) else {
        return;
    };
    let block = 100.0 * 100.0 * 10.0;
    let mut steps = Vec::new();
    for i in 0..7 {
        for j in 0..7 {
            steps.push(json!({
                "kind": "boolean", "op": "cut", "primitive": "cylinder",
                "origin": [10.0 + 12.0 * i as f64, 10.0 + 12.0 * j as f64, 5.0], "radius": 3.0, "height": 10.0
            }));
        }
    }
    // A fuse in a cut batch is not a tool of it: reported by index, the rest still cut.
    steps.insert(3, json!({ "kind": "boolean", "op": "fuse", "primitive": "box", "origin": [0.0, 0.0, 10.0], "size": [5.0, 5.0, 5.0] }));
    let started = Instant::now();
    let reply = apply(
        "combined",
        0,
        1,
        &json!({ "kind": "group", "label": "holes", "combine": "cut", "steps": steps }),
    );
    eprintln!("49 cylinders in one combined boolean: {} ms", started.elapsed().as_millis());
    near(volume(&reply), block - 49.0 * PI * 9.0 * 5.0, 0.5);
    assert_eq!(reply["combined"]["tools"], json!(49), "{reply}");
    assert_eq!(reply["combined"]["failed"][0]["index"], json!(3), "{reply}");
    assert_eq!(reply["op"]["combine"], json!("cut"));
    assert_eq!(reply["op"]["steps"].as_array().unwrap().len(), 50, "the group keeps every step as sent");

    // An extrude step with several outlines is one tool too.
    let extrude = json!({ "kind": "extrude", "op": "cut", "origin": [0.0, 0.0, 10.0], "depth": -2.0,
                          "loops": [rect(2.0, 2.0, 4.0, 4.0), rect(6.0, 2.0, 8.0, 4.0)] });
    let mixed = apply("combined", 0, 2, &json!({ "kind": "group", "label": "mixed", "combine": "cut", "steps": [extrude] }));
    near(volume(&mixed), block - 2.0 * 4.0 * 2.0, 0.01);
}

#[test]
fn a_face_outline_inset_and_a_section_read_the_real_shape() {
    let Some(opened) = open("reads", [40.0, 30.0, 20.0]) else {
        return;
    };
    // A round hole through the block, so the top face has a curved hole.
    let drilled = apply(
        "reads",
        0,
        1,
        &json!({ "kind": "boolean", "op": "cut", "primitive": "cylinder", "origin": [20.0, 15.0, -1.0], "radius": 5.0, "height": 30.0 }),
    );
    let top = face_facing(&drilled, [0.0, 0.0, 1.0]);
    let _ = opened;

    // The face's own frame: the outline and its hole, the area 40 × 30 − 25π.
    let outline = call(json!({ "call": "faceOutline", "key": "reads", "node": 1, "face": top }));
    assert!(outline.get("error").is_none(), "{outline}");
    near(outline["areaMm2"].as_f64().unwrap(), 1200.0 - 25.0 * PI, 0.01);
    assert_eq!(outline["loops"].as_array().unwrap().len(), 2, "{outline}");
    let regions = outline["regions"].as_array().unwrap();
    assert_eq!(regions.len(), 1);
    let hole = regions[0]["holes"][0].as_array().unwrap();
    // Sampled to 0.05 mm: a 5 mm circle needs about π / acos(1 − 0.05 / 5) ≈ 22 points or more.
    assert!(hole.len() >= 20, "{}", hole.len());
    for axis in 0..3 {
        near(outline["frame"]["w"][axis].as_f64().unwrap(), [0.0, 0.0, 1.0][axis], 1e-9);
    }

    // A frame given in the face's plane: corner origin, U along X. Inset 2 mm: (36 × 26) minus the hole grown to r 7,
    // corners kept sharp outside, round where the hole grew.
    let framed = call(json!({
        "call": "faceOutline", "key": "reads", "node": 1, "face": top, "insetMm": 2.0,
        "frame": [0.0, 0.0, 20.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0]
    }));
    assert!(framed.get("error").is_none(), "{framed}");
    near(framed["areaMm2"].as_f64().unwrap(), 36.0 * 26.0 - 49.0 * PI, 0.05);
    near(framed["origin"][2].as_f64().unwrap(), 20.0, 1e-9);
    for axis in 0..3 {
        near(framed["turn"][axis].as_f64().unwrap(), 0.0, 1e-9);
    }
    let outer = framed["regions"][0]["outer"].as_array().unwrap();
    let us: Vec<f64> = outer.iter().map(|p| p[0].as_f64().unwrap()).collect();
    near(us.iter().copied().fold(f64::INFINITY, f64::min), 2.0, 1e-6);
    near(us.iter().copied().fold(f64::NEG_INFINITY, f64::max), 38.0, 1e-6);

    // The loops it answers extrude back to the same area: a 1 mm pad on the top, drawn in that frame.
    let pad = apply(
        "reads",
        1,
        2,
        &json!({ "kind": "extrude", "op": "fuse", "origin": framed["origin"], "turn": framed["turn"], "depth": 1.0, "loops": framed["loops"] }),
    );
    near(volume(&pad) - volume(&drilled), framed["areaMm2"].as_f64().unwrap(), 0.05);

    // An inset past the middle leaves nothing: an empty region, not a refusal.
    let gone = call(json!({ "call": "faceOutline", "key": "reads", "node": 1, "face": top, "insetMm": 20.0 }));
    assert!(gone.get("error").is_none(), "{gone}");
    assert_eq!(gone["loops"].as_array().unwrap().len(), 0, "{gone}");

    // A side face is not flat-and-looking-up, but it is flat: its outline is 40 × 20 in a frame standing on it.
    let side = face_facing(&drilled, [0.0, -1.0, 0.0]);
    let wall = call(json!({ "call": "faceOutline", "key": "reads", "node": 1, "face": side }));
    near(wall["areaMm2"].as_f64().unwrap(), 800.0, 0.01);

    // The section through the hole's axis, standing: two 15 × 20 rectangles beside the 10 mm hole.
    let section = call(json!({
        "call": "section", "key": "reads", "node": 1, "origin": [20.0, 15.0, 10.0], "normal": [0.0, 1.0, 0.0],
        "frame": [20.0, 15.0, 10.0, 1.0, 0.0, 0.0, 0.0, 0.0, -1.0]
    }));
    assert!(section.get("error").is_none(), "{section}");
    assert_eq!(section["regions"].as_array().unwrap().len(), 2, "{section}");
    near(section["areaMm2"].as_f64().unwrap(), 2.0 * 15.0 * 20.0, 0.01);
    let away = call(json!({
        "call": "section", "key": "reads", "node": 1, "origin": [0.0, 99.0, 0.0], "normal": [0.0, 1.0, 0.0],
        "frame": [0.0, 99.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, -1.0]
    }));
    assert_eq!(away["regions"].as_array().unwrap().len(), 0, "{away}");
    let bad = call(json!({
        "call": "section", "key": "reads", "node": 1, "origin": [0.0, 0.0, 0.0], "normal": [0.0, 1.0, 0.0],
        "frame": [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0]
    }));
    assert_eq!(bad["error"].as_str(), Some("The frame does not lie in the section's plane."), "{bad}");
}
