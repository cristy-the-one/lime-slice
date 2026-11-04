//! Lettering on a cylinder and a cone (docs/plan-text-on-curves-and-fonts.md, milestone 2), on the real kernel.
//! `LIME_REQUIRE_OCCT=1` makes a missing kernel a failure.

use base64::Engine;
use serde_json::{json, Value};

const DEPTH: f64 = 0.8;

fn require() -> bool {
    std::env::var_os("LIME_REQUIRE_OCCT").is_some()
}

fn call(request: Value) -> Value {
    let text = lime_model_occt::tree(&request.to_string());
    serde_json::from_str(&text).unwrap_or_else(|err| panic!("not JSON ({err}): {text}"))
}

/// A solid of the primitive opened under `key`, or None when the kernel is not linked.
fn open(key: &str, primitive: Value) -> Option<Value> {
    let opened =
        call(json!({ "call": "open", "key": key, "primitive": primitive, "chordMm": 0.1 }));
    if opened.get("error").is_some() {
        assert!(!require(), "OCCT was required: {opened}");
        return None;
    }
    Some(opened)
}

/// A cylinder R 20, 40 high from z = 0, its axis the Z axis. Its seam is at +X; the anchor is across from it.
fn cylinder(key: &str) -> Option<Value> {
    open(
        key,
        json!({ "primitive": "cylinder", "origin": [0.0, 0.0, 0.0], "radius": 20.0, "height": 40.0 }),
    )
}

/// A cone from R 25 at z = 0 to R 15 at z = 40.
fn cone(key: &str) -> Option<Value> {
    open(
        key,
        json!({ "primitive": "cone", "origin": [0.0, 0.0, 0.0], "radius": 25.0, "topRadius": 15.0, "height": 40.0 }),
    )
}

fn volume_of(opened: &Value) -> f64 {
    opened["volumeMm3"].as_f64().expect("volume")
}

fn lettering(op: &str, text: &str, at: [f64; 3], height: f64, depth: f64) -> Value {
    json!({
        "kind": "lettering", "op": op, "origin": at, "turn": [0.0, 0.0, 0.0],
        "text": text, "font": "sans", "height": height, "depth": depth,
    })
}

fn with(mut op: Value, field: &str, value: Value) -> Value {
    op[field] = value;
    op
}

fn ink(op: &Value) -> f64 {
    let mut request = json!({ "call": "textLayout" });
    for key in [
        "text",
        "font",
        "style",
        "height",
        "spacing",
        "lineSpacing",
        "align",
        "angleDeg",
    ] {
        if let Some(value) = op.get(key) {
            request[key] = value.clone();
        }
    }
    let reply = call(request);
    assert_eq!(reply["ok"], json!(true), "{reply}");
    reply["inkMm2"].as_f64().expect("inkMm2")
}

fn probe(key: &str, op: &Value) -> Value {
    call(json!({ "call": "probe", "key": key, "node": 0, "op": op }))
}

/// Apply `op` as the step after the root, and check through the probe that the result is one closed solid.
fn apply(key: &str, op: &Value) -> Value {
    let probed = probe(key, op);
    assert_eq!(probed["ok"], json!(true), "{probed}");
    assert_eq!(probed["solids"], json!(1), "{probed}");
    assert_eq!(probed["shells"], json!(1), "{probed}");
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let node = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut reply =
        call(json!({ "call": "apply", "key": key, "parent": 0, "node": node, "op": op }));
    if reply.get("error").is_none() {
        reply["solids"] = probed["solids"].clone();
        reply["shells"] = probed["shells"].clone();
    }
    reply
}

#[track_caller]
fn near(actual: f64, expected: f64, tolerance: f64) {
    assert!(
        (actual - expected).abs() <= tolerance,
        "{actual} is not within {tolerance} of {expected}"
    );
}

fn words(reply: &Value, name: &str) -> Vec<[u8; 4]> {
    let text = reply[name]
        .as_str()
        .unwrap_or_else(|| panic!("{name} is not base64 text"));
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(text)
        .expect("base64");
    bytes
        .chunks_exact(4)
        .map(|word| word.try_into().expect("four bytes"))
        .collect()
}

/// Every corner of every triangle of the faces the step made (owner 1), as points.
fn letter_points(reply: &Value) -> Vec<[f64; 3]> {
    let node = reply["id"].as_u64().expect("id");
    let positions: Vec<f32> = words(reply, "positions")
        .into_iter()
        .map(f32::from_le_bytes)
        .collect();
    let triangles: Vec<u32> = words(reply, "triangles")
        .into_iter()
        .map(u32::from_le_bytes)
        .collect();
    let owners = reply["stepFaces"].as_array().expect("stepFaces");
    let mut out = Vec::new();
    for (tri, face) in triangles.iter().enumerate() {
        if owners[*face as usize].as_u64() != Some(node) {
            continue;
        }
        for corner in 0..3 {
            let at = tri * 9 + corner * 3;
            out.push([
                f64::from(positions[at]),
                f64::from(positions[at + 1]),
                f64::from(positions[at + 2]),
            ]);
        }
    }
    out
}

/// The letters' height off the surface, square to it: how far each point is from the cylinder of radius `r` about Z.
fn off_cylinder(p: [f64; 3], r: f64) -> f64 {
    p[0].hypot(p[1]) - r
}

/// The same off the cone from R 25 at z = 0 to R 15 at z = 40, along the normal.
fn off_cone(p: [f64; 3]) -> f64 {
    let slope = 10.0 / 40.0;
    let cos = (1.0f64 + slope * slope).sqrt().recip();
    (p[0].hypot(p[1]) - (25.0 - slope * p[2])) * cos
}

/// Depth along the normal at every cap point (the points that are neither on the surface nor on a wall's way up), and the share
/// of the step's points that are on the cap.
fn check_depth(points: &[[f64; 3]], off: impl Fn([f64; 3]) -> f64, lift: f64) {
    let mut caps = 0;
    for p in points {
        let h = off(*p);
        // Every point of a letter is between the surface and the cap, in the cap's direction.
        assert!(
            h * lift.signum() > -2e-3 && h.abs() < lift.abs() + 2e-3,
            "{p:?} is {h} off the surface"
        );
        if (h - lift).abs() < 2e-3 {
            caps += 1;
        }
    }
    assert!(
        caps * 3 > points.len(),
        "{caps} of {} points are on the cap",
        points.len()
    );
}

#[test]
fn raised_letters_on_a_cylinder_are_a_valid_closed_solid_a_depth_standing_off_it() {
    let Some(opened) = cylinder("c-raise") else {
        return;
    };
    let before = volume_of(&opened);
    // The letters with holes: A, O, B, 8, g, e.
    let op = lettering("fuse", "AOB8ge", [-20.0, 0.0, 20.0], 5.0, DEPTH);
    let reply = apply("c-raise", &op);
    assert!(reply.get("error").is_none(), "{reply}");
    assert_eq!(reply["text"]["build"], json!("direct"), "{reply}");
    assert_eq!(reply["text"]["surface"], json!("cylinder"));
    assert_eq!(reply["solids"], json!(1), "{reply}");
    assert_eq!(reply["shells"], json!(1), "{reply}");
    // Volume: ink area x depth x (1 + depth / 2R), the patch widening towards its top.
    near(
        volume_of(&reply) - before,
        ink(&op) * DEPTH * (1.0 + DEPTH / 40.0),
        0.02 * ink(&op) * DEPTH / 10.0,
    );
    check_depth(&letter_points(&reply), |p| off_cylinder(p, 20.0), DEPTH);
    // The top and bottom of the part and the wall it rests on are the faces they were.
    let owners = reply["stepFaces"].as_array().unwrap();
    assert_eq!(
        owners.iter().filter(|o| o.as_u64() == Some(0)).count(),
        3,
        "{owners:?}"
    );
}

#[test]
fn engraved_letters_on_a_cylinder_cut_a_constant_depth_into_it() {
    let Some(opened) = cylinder("c-cut") else {
        return;
    };
    let before = volume_of(&opened);
    let op = lettering("cut", "AOB8ge", [-20.0, 0.0, 20.0], 5.0, DEPTH);
    let reply = apply("c-cut", &op);
    assert!(reply.get("error").is_none(), "{reply}");
    assert_eq!(reply["text"]["build"], json!("direct"), "{reply}");
    assert_eq!(reply["solids"], json!(1), "{reply}");
    assert_eq!(reply["shells"], json!(1), "{reply}");
    near(
        before - volume_of(&reply),
        ink(&op) * DEPTH * (1.0 - DEPTH / 40.0),
        0.02 * ink(&op) * DEPTH / 10.0,
    );
    check_depth(&letter_points(&reply), |p| off_cylinder(p, 20.0), -DEPTH);
}

#[test]
fn raised_and_engraved_letters_on_a_cone_stand_a_constant_depth_off_the_slope() {
    let Some(opened) = cone("k-both") else { return };
    let before = volume_of(&opened);
    // The cone's side faces up and out at 14 degrees; the anchor is across from the seam at half height.
    let mid = [-20.0, 0.0, 20.0];
    for (which, sign) in [("fuse", 1.0), ("cut", -1.0)] {
        let op = lettering(which, "AOB8ge", mid, 5.0, DEPTH);
        let reply = apply("k-both", &op);
        assert!(reply.get("error").is_none(), "{which}: {reply}");
        assert_eq!(reply["text"]["build"], json!("direct"), "{which}: {reply}");
        assert_eq!(reply["text"]["surface"], json!("cone"));
        assert_eq!(reply["solids"], json!(1), "{which}: {reply}");
        assert_eq!(reply["shells"], json!(1), "{which}: {reply}");
        // A cone's area patch has depth along the normal: the volume is within a few percent of ink x depth.
        let moved = sign * (volume_of(&reply) - before);
        near(moved, ink(&op) * DEPTH, 0.04 * ink(&op) * DEPTH);
        check_depth(&letter_points(&reply), off_cone, sign * DEPTH);
    }
}

#[test]
fn the_anchor_is_read_from_the_part_not_from_the_op_frame() {
    // The same text typed with a turn that would be wrong for a flat face builds all the same.
    let Some(_) = cylinder("c-turn") else { return };
    let op = with(
        lettering("fuse", "LIME", [-20.0, 0.0, 20.0], 6.0, DEPTH),
        "turn",
        json!([33.0, 12.0, 80.0]),
    );
    let reply = probe("c-turn", &op);
    assert_eq!(reply["ok"], json!(true), "{reply}");
    assert_eq!(reply["text"]["build"], json!("direct"), "{reply}");
}

#[test]
fn text_across_the_seam_builds_with_the_boolean_and_is_still_valid() {
    let Some(opened) = cylinder("c-seam") else {
        return;
    };
    let before = volume_of(&opened);
    // At +X, on the seam itself.
    for (which, sign) in [("fuse", 1.0), ("cut", -1.0)] {
        let op = lettering(which, "LIME 42", [20.0, 0.0, 20.0], 6.0, DEPTH);
        let reply = apply("c-seam", &op);
        assert!(reply.get("error").is_none(), "{which}: {reply}");
        assert_eq!(reply["text"]["build"], json!("boolean"), "{which}: {reply}");
        assert_eq!(reply["text"]["crossesSeam"], json!(true));
        assert_eq!(reply["solids"], json!(1), "{which}: {reply}");
        assert_eq!(reply["shells"], json!(1), "{which}: {reply}");
        let moved = sign * (volume_of(&reply) - before);
        let expect = ink(&op) * DEPTH * (1.0 + sign * DEPTH / 40.0);
        near(moved, expect, 0.02 * expect);
    }
}

#[test]
fn along_the_axis_and_flipped_both_build() {
    let Some(_) = cylinder("c-dir") else { return };
    let op = lettering("fuse", "LIME SLICE", [-20.0, 0.0, 20.0], 3.0, DEPTH);
    let round = probe("c-dir", &op);
    assert_eq!(round["ok"], json!(true), "{round}");
    let up = probe("c-dir", &with(op.clone(), "along", json!("axis")));
    assert_eq!(up["ok"], json!(true), "{up}");
    assert_eq!(up["text"]["build"], json!("direct"), "{up}");
    // Same letters either way: the same volume.
    near(volume_of(&up), volume_of(&round), 0.05);
    let flipped = probe("c-dir", &with(op.clone(), "flip", json!(true)));
    assert_eq!(flipped["ok"], json!(true), "{flipped}");
    near(volume_of(&flipped), volume_of(&round), 0.05);
    // Along the axis the letters run in z, round it they run in the angle.
    let reply = apply("c-dir", &with(op, "along", json!("axis")));
    let points = letter_points(&reply);
    let z: Vec<f64> = points.iter().map(|p| p[2]).collect();
    let span =
        z.iter().cloned().fold(f64::MIN, f64::max) - z.iter().cloned().fold(f64::MAX, f64::min);
    assert!(span > 20.0, "z span {span}");
    let bad = probe(
        "c-dir",
        &with(
            lettering("fuse", "A", [-20.0, 0.0, 20.0], 3.0, DEPTH),
            "along",
            json!("sideways"),
        ),
    );
    assert_eq!(bad["ok"], json!(false), "{bad}");
    assert!(
        bad["error"]
            .as_str()
            .unwrap()
            .starts_with("along is around or axis"),
        "{bad}"
    );
}

#[test]
fn the_inside_of_a_tube_takes_text_too() {
    let Some(opened) = open(
        "t-in",
        json!({ "primitive": "tube", "origin": [0.0, 0.0, 0.0], "radius": 20.0, "innerRadius": 15.0, "height": 40.0 }),
    ) else {
        return;
    };
    let before = volume_of(&opened);
    // Raised from the bore goes inwards, engraved goes into the wall.
    for (which, sign) in [("fuse", 1.0), ("cut", -1.0)] {
        let op = lettering(which, "BORE 8", [-15.0, 0.0, 20.0], 4.0, DEPTH);
        let reply = apply("t-in", &op);
        assert!(reply.get("error").is_none(), "{which}: {reply}");
        assert_eq!(reply["text"]["build"], json!("direct"), "{which}: {reply}");
        assert_eq!(reply["solids"], json!(1), "{which}: {reply}");
        assert_eq!(reply["shells"], json!(1), "{which}: {reply}");
        let moved = sign * (volume_of(&reply) - before);
        let expect = ink(&op) * DEPTH * (1.0 - sign * DEPTH / 30.0);
        near(moved, expect, 0.03 * expect);
        // Raised stands 0.8 inside the bore (radius 14.2), engraved goes out to 15.8.
        check_depth(
            &letter_points(&reply),
            |p| -off_cylinder(p, 15.0),
            sign * DEPTH,
        );
    }
}

#[test]
fn a_text_that_cannot_be_built_is_refused_in_one_sentence_before_building() {
    let Some(_) = cylinder("c-no") else { return };
    // Longer than the way round (125.7 mm) at 6 mm capitals.
    let long = lettering(
        "fuse",
        &"LIME SLICE 2026 ".repeat(4),
        [-20.0, 0.0, 20.0],
        6.0,
        DEPTH,
    );
    let reply = probe("c-no", &long);
    assert_eq!(reply["ok"], json!(false), "{reply}");
    assert_eq!(
        reply["error"],
        json!("The text is longer than the way round this cylinder (125.7 mm). Make it smaller or use two lines."),
        "{reply}"
    );
    // Off the end of the wall.
    let off = lettering("fuse", "LIME", [-20.0, 0.0, 38.0], 6.0, DEPTH);
    let reply = probe("c-no", &off);
    assert_eq!(reply["ok"], json!(false), "{reply}");
    assert_eq!(
        reply["error"],
        json!("The text runs off this face. Move it, make it smaller, or put it on one face."),
        "{reply}"
    );
    // Not on a face at all: the flat way, as before.
    let sphere = open(
        "s-no",
        json!({ "primitive": "sphere", "origin": [0.0, 0.0, 0.0], "radius": 20.0 }),
    );
    if sphere.is_some() {
        let reply = probe(
            "s-no",
            &lettering("fuse", "LIME", [0.0, 0.0, 20.0], 4.0, DEPTH),
        );
        assert_eq!(reply["ok"], json!(false), "{reply}");
        assert!(
            reply["error"].as_str().unwrap().starts_with(
                "Text goes on a flat face, a cylinder or a cone for now; this is a sphere"
            ),
            "{reply}"
        );
    }
}

#[test]
fn letters_too_deep_for_a_small_cylinder_are_refused_with_the_depth_that_works() {
    let Some(_) = open(
        "c-deep",
        json!({ "primitive": "cylinder", "origin": [0.0, 0.0, 0.0], "radius": 5.0, "height": 20.0 }),
    ) else {
        return;
    };
    let op = lettering("cut", "I", [-5.0, 0.0, 10.0], 3.0, 4.6);
    let reply = probe("c-deep", &op);
    assert_eq!(reply["ok"], json!(false), "{reply}");
    assert_eq!(
        reply["error"],
        json!("Letters this deep would fold over inside this curve. Use a depth under 4.5 mm."),
        "{reply}"
    );
    let fine = probe("c-deep", &with(op, "depth", json!(2.0)));
    assert_eq!(fine["ok"], json!(true), "{fine}");
}

#[test]
fn an_engraving_that_goes_through_a_thin_wall_refuses_a_letter_that_would_lose_its_middle() {
    let Some(_) = open(
        "t-thin",
        json!({ "primitive": "tube", "origin": [0.0, 0.0, 0.0], "radius": 20.0, "innerRadius": 19.5, "height": 40.0 }),
    ) else {
        return;
    };
    let o = probe(
        "t-thin",
        &lettering("cut", "O", [-20.0, 0.0, 20.0], 6.0, 1.0),
    );
    assert_eq!(o["ok"], json!(false), "{o}");
    assert!(
        o["error"]
            .as_str()
            .unwrap()
            .starts_with("The middle of ‘O’ would fall out."),
        "{o}"
    );
    // A letter with no counter cuts through, by the boolean.
    let l = probe(
        "t-thin",
        &lettering("cut", "L", [-20.0, 0.0, 20.0], 6.0, 1.0),
    );
    assert_eq!(l["ok"], json!(true), "{l}");
    assert_eq!(l["text"]["build"], json!("boolean"), "{l}");
}

#[test]
fn a_curved_text_step_replays_from_a_saved_node_to_the_same_solid() {
    let Some(_) = cylinder("c-replay") else {
        return;
    };
    let group = json!({
        "kind": "group", "label": "Text LIME", "source": { "kind": "text", "text": "LIME" },
        "steps": [with(lettering("fuse", "LIME", [-20.0, 0.0, 20.0], 6.0, DEPTH), "font", json!("sans@4.0"))],
    });
    let applied =
        call(json!({ "call": "apply", "key": "c-replay", "parent": 0, "node": 1, "op": group }));
    assert!(applied.get("error").is_none(), "{applied}");
    let reopened = call(json!({
        "call": "open", "key": "c-replay2",
        "primitive": { "primitive": "cylinder", "origin": [0.0, 0.0, 0.0], "radius": 20.0, "height": 40.0 },
        "current": 1,
        "nodes": [{ "id": 1, "parent": 0, "op": applied["op"], "fingerprint": applied["fingerprint"] }],
    }));
    assert!(reopened.get("error").is_none(), "{reopened}");
    assert_eq!(
        reopened["fingerprint"], applied["fingerprint"],
        "{reopened}"
    );
}

#[test]
fn the_preview_call_answers_the_letters_on_the_face_and_on_their_top() {
    let Some(_) = cylinder("c-preview") else {
        return;
    };
    let request = json!({
        "call": "textCurved", "key": "c-preview", "node": 0, "point": [-20.0, 0.0, 20.0],
        "text": "Hi 8", "font": "sans", "height": 6.0, "depth": DEPTH, "stepMm": 0.5,
    });
    let reply = call(request.clone());
    assert_eq!(reply["ok"], json!(true), "{reply}");
    assert_eq!(reply["surface"], json!("cylinder"));
    assert_eq!(reply["crossesSeam"], json!(false));
    near(reply["wayRoundMm"].as_f64().unwrap(), 125.664, 0.01);
    let faces = reply["faces"].as_array().unwrap();
    assert!(faces.len() >= 3);
    for face in faces {
        for lp in face["loops"].as_array().unwrap() {
            let (base, top) = (
                lp["base"].as_array().unwrap(),
                lp["top"].as_array().unwrap(),
            );
            assert_eq!(base.len(), top.len());
            assert_eq!(base.len(), lp["uv"].as_array().unwrap().len());
            for (b, t) in base.iter().zip(top) {
                let p = |v: &Value| {
                    [
                        v[0].as_f64().unwrap(),
                        v[1].as_f64().unwrap(),
                        v[2].as_f64().unwrap(),
                    ]
                };
                // On the wall, and the depth off it.
                near(off_cylinder(p(b), 20.0), 0.0, 1e-3);
                near(off_cylinder(p(t), 20.0), DEPTH, 1e-3);
            }
        }
    }
    // A refusal is an error with the sentence.
    let mut long = request;
    long["text"] = json!("LIME SLICE 2026 ".repeat(5));
    let reply = call(long);
    assert!(
        reply["error"]
            .as_str()
            .unwrap()
            .starts_with("The text is longer than the way round this cylinder"),
        "{reply}"
    );
}

/// With LIME_TEXT_CURVES_OBJ=<dir> this writes the letters' parts as OBJ files for a render, and prints how long each took.
/// Without it, it does nothing.
#[test]
fn render_dump_for_a_look() {
    let Ok(dir) = std::env::var("LIME_TEXT_CURVES_OBJ") else {
        return;
    };
    let jobs: [(&str, &str, Value, bool); 11] = [
        (
            "cylinder-raise",
            "cyl",
            lettering("fuse", "Lime 42\nAO8 gB", [-20.0, 0.0, 20.0], 5.0, DEPTH),
            false,
        ),
        (
            "cylinder-cut",
            "cyl",
            lettering("cut", "Lime 42\nAO8 gB", [-20.0, 0.0, 20.0], 5.0, DEPTH),
            false,
        ),
        (
            "cylinder-along",
            "cyl",
            with(
                lettering("fuse", "Lime 42", [-20.0, 0.0, 20.0], 4.0, DEPTH),
                "along",
                json!("axis"),
            ),
            false,
        ),
        (
            "cylinder-seam",
            "cyl",
            lettering("fuse", "Lime 42", [20.0, 0.0, 20.0], 6.0, DEPTH),
            false,
        ),
        (
            "cone-raise",
            "cone",
            lettering("fuse", "Lime 42\nAO8 gB", [-20.0, 0.0, 20.0], 5.0, DEPTH),
            true,
        ),
        (
            "cone-cut",
            "cone",
            lettering("cut", "Lime 42\nAO8 gB", [-20.0, 0.0, 20.0], 5.0, DEPTH),
            true,
        ),
        (
            "spike-cylinder-raise",
            "cyl",
            lettering(
                "fuse",
                "Lime Slice gAO8 2026",
                [-20.0, 0.0, 20.0],
                6.0,
                DEPTH,
            ),
            false,
        ),
        (
            "spike-cylinder-cut",
            "cyl",
            lettering(
                "cut",
                "Lime Slice gAO8 2026",
                [-20.0, 0.0, 20.0],
                6.0,
                DEPTH,
            ),
            false,
        ),
        (
            "spike-cone-raise",
            "cone",
            lettering(
                "fuse",
                "Lime Slice gAO8 2026",
                [-20.0, 0.0, 20.0],
                6.0,
                DEPTH,
            ),
            true,
        ),
        (
            "spike-cylinder-seam",
            "cyl",
            lettering(
                "fuse",
                "Lime Slice gAO8 2026",
                [20.0, 0.0, 20.0],
                6.0,
                DEPTH,
            ),
            false,
        ),
        (
            "cylinder-flip",
            "cyl",
            with(
                lettering("fuse", "Lime 42", [-20.0, 0.0, 20.0], 6.0, DEPTH),
                "flip",
                json!(true),
            ),
            false,
        ),
    ];
    for (name, part, op, is_cone) in jobs {
        let key = format!("dump-{name}");
        let opened = if is_cone || part == "cone" {
            cone(&key)
        } else {
            cylinder(&key)
        };
        if opened.is_none() {
            return;
        }
        // The card's preview, then the step itself (the probe the card runs and the apply: two builds).
        let asked = std::time::Instant::now();
        let preview = call(json!({
            "call": "textCurved", "key": key, "node": 0, "point": op["origin"], "text": op["text"], "font": "sans", "height": op["height"],
            "depth": DEPTH, "cut": op["op"] == "cut", "along": op.get("along"), "flip": op.get("flip"), "stepMm": 0.4,
        }));
        let preview_took = asked.elapsed().as_secs_f64();
        assert_eq!(preview["ok"], json!(true), "{name}: {preview}");
        let probed_at = std::time::Instant::now();
        let probed = probe(&key, &op);
        let probe_took = probed_at.elapsed().as_secs_f64();
        assert_eq!(probed["ok"], json!(true), "{name}: {probed}");
        let started = std::time::Instant::now();
        let reply = call(json!({ "call": "apply", "key": key, "parent": 0, "node": 1, "op": op }));
        let took = started.elapsed().as_secs_f64();
        assert!(reply.get("error").is_none(), "{name}: {reply}");
        let positions: Vec<f32> = words(&reply, "positions")
            .into_iter()
            .map(f32::from_le_bytes)
            .collect();
        let mut obj = String::new();
        for (i, p) in positions.chunks_exact(3).enumerate() {
            obj.push_str(&format!("v {} {} {}\n", p[0], p[1], p[2]));
            if i % 3 == 2 {
                obj.push_str(&format!("f {} {} {}\n", i - 1, i, i + 1));
            }
        }
        std::fs::write(std::path::Path::new(&dir).join(format!("{name}.obj")), obj)
            .expect("write obj");
        println!(
            "{name}: preview {:.3} s, probe {:.2} s, apply {:.2} s, build {}",
            preview_took, probe_took, took, reply["text"]["build"]
        );
    }
}
