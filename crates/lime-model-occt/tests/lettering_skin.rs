//! Lettering on a sphere, a torus and a freeform face (docs/plan-text-on-curves-and-fonts.md, milestone 3), on the real kernel.
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

/// A ball of radius 30 about the origin. Its seam is at +X, its poles at +Z and -Z; the anchor across from the seam is (-30, 0, 0).
fn ball(key: &str) -> Option<Value> {
    open(
        key,
        json!({ "primitive": "sphere", "origin": [0.0, 0.0, 0.0], "radius": 30.0 }),
    )
}

/// A torus about Z with the ring radius 30 and the tube radius 10. The tube's top at the far side is (-30, 0, 10).
fn torus(key: &str) -> Option<Value> {
    open(
        key,
        json!({ "primitive": "torus", "origin": [0.0, 0.0, 0.0], "radius": 30.0, "tubeRadius": 10.0 }),
    )
}

/// An ellipsoid 80 x 60 x 50: its faces are B-splines.
fn ellipsoid(key: &str) -> Option<Value> {
    open(
        key,
        json!({ "primitive": "ellipsoid", "origin": [0.0, 0.0, 0.0], "size": [80.0, 60.0, 50.0] }),
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

fn mesh(reply: &Value) -> (Vec<[f64; 3]>, Vec<u32>) {
    let positions: Vec<f32> = words(reply, "positions")
        .into_iter()
        .map(f32::from_le_bytes)
        .collect();
    let triangles: Vec<u32> = words(reply, "triangles")
        .into_iter()
        .map(u32::from_le_bytes)
        .collect();
    let points = positions
        .chunks_exact(3)
        .map(|p| [f64::from(p[0]), f64::from(p[1]), f64::from(p[2])])
        .collect();
    (points, triangles)
}

/// Every corner of every triangle of the faces the step made (owner = the step's node), as points.
fn letter_points(reply: &Value) -> Vec<[f64; 3]> {
    let node = reply["id"].as_u64().expect("id");
    let (points, triangles) = mesh(reply);
    let owners = reply["stepFaces"].as_array().expect("stepFaces");
    let mut out = Vec::new();
    for (tri, face) in triangles.iter().enumerate() {
        if owners[*face as usize].as_u64() != Some(node) {
            continue;
        }
        out.extend_from_slice(&points[tri * 3..tri * 3 + 3]);
    }
    out
}

/// The ball of radius 30: a point's height off it.
fn off_ball(p: [f64; 3]) -> f64 {
    (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]).sqrt() - 30.0
}

/// The torus 30 / 10: a point's height off the tube.
fn off_torus(p: [f64; 3]) -> f64 {
    (p[0].hypot(p[1]) - 30.0).hypot(p[2]) - 10.0
}

/// The ellipsoid with the half widths 40, 30, 25: a point's height off it, to the first order.
fn off_ellipsoid(p: [f64; 3]) -> f64 {
    let (a, b, c) = (40.0, 30.0, 25.0);
    let f = ((p[0] / a).powi(2) + (p[1] / b).powi(2) + (p[2] / c).powi(2)).sqrt();
    let w = [p[0] / (a * a * f), p[1] / (b * b * f), p[2] / (c * c * f)];
    (f - 1.0) / (w[0] * w[0] + w[1] * w[1] + w[2] * w[2]).sqrt()
}

/// Depth along the normal at every cap point (the points that are neither on the surface nor on a wall's way up), and the share of
/// the step's points that are on the cap. `tol` is the kernel's mesh and the first-order distance.
fn check_depth(points: &[[f64; 3]], off: impl Fn([f64; 3]) -> f64, lift: f64, tol: f64) {
    let mut caps = 0;
    for p in points {
        let h = off(*p);
        assert!(
            h * lift.signum() > -tol && h.abs() < lift.abs() + tol,
            "{p:?} is {h} off the surface"
        );
        if (h - lift).abs() < tol {
            caps += 1;
        }
    }
    assert!(
        caps * 3 > points.len(),
        "{caps} of {} points are on the cap",
        points.len()
    );
}

/// The area of the triangles in `points` (three to a triangle) whose corners are all on the cap, `lift` off the surface.
fn cap_area(points: &[[f64; 3]], off: impl Fn([f64; 3]) -> f64, lift: f64, tol: f64) -> f64 {
    let mut area = 0.0;
    for tri in points.chunks_exact(3) {
        if tri.iter().any(|p| (off(*p) - lift).abs() > tol) {
            continue;
        }
        let (a, b) = (
            [
                tri[1][0] - tri[0][0],
                tri[1][1] - tri[0][1],
                tri[1][2] - tri[0][2],
            ],
            [
                tri[2][0] - tri[0][0],
                tri[2][1] - tri[0][1],
                tri[2][2] - tri[0][2],
            ],
        );
        let c = [
            a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0],
        ];
        area += 0.5 * (c[0] * c[0] + c[1] * c[1] + c[2] * c[2]).sqrt();
    }
    area
}

/// The anchors the tests use: across from the seam, away from the poles.
const BALL_AT: [f64; 3] = [-30.0, 0.0, 0.0];
const TORUS_AT: [f64; 3] = [-30.0, 0.0, 10.0];
const ELLIPSOID_AT: [f64; 3] = [-40.0, 0.0, 0.0];

#[test]
fn raised_and_engraved_letters_on_a_sphere_are_valid_and_stand_a_constant_depth_off_it() {
    let Some(opened) = ball("b-both") else {
        return;
    };
    let before = volume_of(&opened);
    for (which, sign) in [("fuse", 1.0), ("cut", -1.0)] {
        let op = lettering(which, "AOB8ge", BALL_AT, 5.0, DEPTH);
        let reply = apply("b-both", &op);
        assert!(reply.get("error").is_none(), "{which}: {reply}");
        assert_eq!(reply["text"]["build"], json!("direct"), "{which}: {reply}");
        assert_eq!(reply["text"]["surface"], json!("sphere"));
        assert_eq!(reply["solids"], json!(1), "{which}: {reply}");
        assert_eq!(reply["shells"], json!(1), "{which}: {reply}");
        // Volume: the ink on the surface times the depth, a little more raised and a little less cut:
        // d (1 + d/R + d^2/3R^2) and d (1 - d/R + d^2/3R^2).
        let moved = sign * (volume_of(&reply) - before);
        let expect = ink(&op) * DEPTH * (1.0 + sign * DEPTH / 30.0);
        near(moved, expect, 0.03 * expect);
        check_depth(&letter_points(&reply), off_ball, sign * DEPTH, 2e-3);
    }
}

#[test]
fn letters_keep_their_size_on_the_sphere() {
    // A column of an I six millimetres tall, on the equator: the foot and the head are six millimetres of arc apart.
    let Some(_) = ball("b-size") else { return };
    let op = lettering("fuse", "II", BALL_AT, 6.0, DEPTH);
    let reply = apply("b-size", &op);
    assert!(reply.get("error").is_none(), "{reply}");
    let on: Vec<[f64; 3]> = letter_points(&reply)
        .into_iter()
        .filter(|p| off_ball(*p).abs() < 2e-3)
        .collect();
    let zs: Vec<f64> = on.iter().map(|p| p[2]).collect();
    let height =
        zs.iter().cloned().fold(f64::MIN, f64::max) - zs.iter().cloned().fold(f64::MAX, f64::min);
    // 6 mm of arc on R 30 is 2 R sin(3 / 30) = 5.99 of height.
    near(height, 2.0 * 30.0 * (3.0f64 / 30.0).sin(), 0.03);
    // The two letters' advance along the baseline is the font's: their centres are an advance apart.
    let layout = call(json!({ "call": "textLayout", "text": "II", "font": "sans", "height": 6.0 }));
    let faces = layout["faces"].as_array().unwrap();
    let centre = |face: &Value| {
        let xs: Vec<f64> = face["loops"][0]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p[0].as_f64().unwrap())
            .collect();
        (xs.iter().cloned().fold(f64::MIN, f64::max) + xs.iter().cloned().fold(f64::MAX, f64::min))
            / 2.0
    };
    let gap = centre(&faces[1]) - centre(&faces[0]);
    // On the equator the baseline runs along Y: the two letters' middles are `gap` of arc apart.
    let mut by_y: Vec<f64> = on.iter().map(|p| p[1]).collect();
    by_y.sort_by(f64::total_cmp);
    let (lo, hi) = (by_y[0], by_y[by_y.len() - 1]);
    let arc = |a: f64, b: f64| 2.0 * 30.0 * ((b - a).abs() / 60.0).asin();
    let width = arc(lo, hi);
    assert!(
        width > gap && width < gap + 3.0,
        "{width} for a gap of {gap}"
    );
}

#[test]
fn text_across_a_spheres_seam_builds_with_the_boolean_and_is_still_valid() {
    let Some(opened) = ball("b-seam") else { return };
    let before = volume_of(&opened);
    // At +X, on the seam itself.
    for (which, sign) in [("fuse", 1.0), ("cut", -1.0)] {
        let op = lettering(which, "LIME 42", [30.0, 0.0, 0.0], 5.0, DEPTH);
        let reply = apply("b-seam", &op);
        assert!(reply.get("error").is_none(), "{which}: {reply}");
        assert_eq!(reply["text"]["build"], json!("boolean"), "{which}: {reply}");
        assert_eq!(reply["text"]["crossesSeam"], json!(true));
        assert_eq!(reply["solids"], json!(1), "{which}: {reply}");
        assert_eq!(reply["shells"], json!(1), "{which}: {reply}");
        let moved = sign * (volume_of(&reply) - before);
        let expect = ink(&op) * DEPTH * (1.0 + sign * DEPTH / 30.0);
        near(moved, expect, 0.04 * expect);
    }
}

#[test]
fn text_across_a_pole_is_refused() {
    let Some(_) = ball("b-pole") else { return };
    let op = lettering("fuse", "LIME", [0.0, 0.0, 30.0], 5.0, DEPTH);
    let reply = probe("b-pole", &op);
    assert_eq!(reply["ok"], json!(false), "{reply}");
    assert!(
        reply["error"]
            .as_str()
            .unwrap()
            .contains("pole of this sphere"),
        "{reply}"
    );
    // A little way from it, a short text is fine.
    let near_it = probe(
        "b-pole",
        &lettering("fuse", "I", [-12.0, 0.0, 27.5], 3.0, DEPTH),
    );
    assert_eq!(near_it["ok"], json!(true), "{near_it}");
}

#[test]
fn raised_and_engraved_letters_on_a_torus_stand_a_constant_depth_off_the_tube() {
    let Some(opened) = torus("t-both") else {
        return;
    };
    let before = volume_of(&opened);
    // Outside the tube's top, in the middle of the face's u and v.
    for (which, sign) in [("fuse", 1.0), ("cut", -1.0)] {
        let op = lettering(which, "AOB8ge", TORUS_AT, 4.0, DEPTH);
        let reply = apply("t-both", &op);
        assert!(reply.get("error").is_none(), "{which}: {reply}");
        assert_eq!(reply["text"]["build"], json!("direct"), "{which}: {reply}");
        assert_eq!(reply["text"]["surface"], json!("torus"));
        assert_eq!(reply["solids"], json!(1), "{which}: {reply}");
        assert_eq!(reply["shells"], json!(1), "{which}: {reply}");
        // The tube's top: the letters grow with the tube, d (1 + d / 2r), r = 10, and the ring's own curve adds little.
        let moved = sign * (volume_of(&reply) - before);
        let expect = ink(&op) * DEPTH * (1.0 + sign * DEPTH / 20.0);
        near(moved, expect, 0.04 * expect);
        check_depth(&letter_points(&reply), off_torus, sign * DEPTH, 2e-3);
    }
}

#[test]
fn letters_on_the_inside_of_a_torus_where_the_surface_is_a_saddle_are_valid() {
    let Some(_) = torus("t-saddle") else { return };
    // The ring's inner side, (-20, 0, 0): the face's normal looks to the axis and the surface bends two ways.
    for which in ["fuse", "cut"] {
        let op = lettering(which, "LIME 42", [-20.0, 0.0, 0.0], 4.0, 0.6);
        let reply = apply("t-saddle", &op);
        assert!(reply.get("error").is_none(), "{which}: {reply}");
        assert_eq!(reply["text"]["surface"], json!("torus"));
        assert_eq!(reply["solids"], json!(1), "{which}: {reply}");
        assert_eq!(reply["shells"], json!(1), "{which}: {reply}");
    }
}

#[test]
fn text_across_a_torus_seam_builds_with_the_boolean() {
    let Some(opened) = torus("t-seam") else {
        return;
    };
    let before = volume_of(&opened);
    // At the tube's top where the ring's seam runs (u = 0): (30, 0, 10).
    let op = lettering("fuse", "LIME", [30.0, 0.0, 10.0], 4.0, DEPTH);
    let reply = apply("t-seam", &op);
    assert!(reply.get("error").is_none(), "{reply}");
    assert_eq!(reply["text"]["build"], json!("boolean"), "{reply}");
    assert_eq!(reply["text"]["crossesSeam"], json!(true));
    let grew = volume_of(&reply) - before;
    near(
        grew,
        ink(&op) * DEPTH * (1.0 + DEPTH / 20.0),
        0.05 * ink(&op) * DEPTH,
    );
}

#[test]
fn raised_and_engraved_letters_on_a_freeform_face_stand_a_constant_depth_off_it() {
    let Some(_) = ellipsoid("e-both") else {
        return;
    };
    for (which, sign) in [("fuse", 1.0), ("cut", -1.0)] {
        let op = lettering(which, "AOB8ge", ELLIPSOID_AT, 5.0, DEPTH);
        let reply = apply("e-both", &op);
        assert!(reply.get("error").is_none(), "{which}: {reply}");
        assert_eq!(reply["text"]["build"], json!("direct"), "{which}: {reply}");
        assert_eq!(reply["text"]["surface"], json!("freeform"));
        assert_eq!(reply["solids"], json!(1), "{which}: {reply}");
        assert_eq!(reply["shells"], json!(1), "{which}: {reply}");
        // The volume of a B-spline body is an integral with an error bigger than the letters; their caps' area is not: at the end of
        // the long axis the radii of curvature are 22.5 and 15.6, so a cap `d` off the surface is 1 + d (1/22.5 + 1/15.6) the ink.
        let caps = cap_area(&letter_points(&reply), off_ellipsoid, sign * DEPTH, 0.03);
        let expect = ink(&op) * (1.0 + sign * DEPTH * (1.0 / 22.5 + 1.0 / 15.6));
        near(caps, expect, 0.04 * expect);
        check_depth(&letter_points(&reply), off_ellipsoid, sign * DEPTH, 0.03);
    }
}

#[test]
fn text_off_the_edge_of_a_trimmed_freeform_face_is_refused() {
    let Some(_) = ellipsoid("e-trim") else { return };
    // Cut the ellipsoid by a plane: the freeform face now ends at the cut's edge, at x = -30.
    let cut = call(json!({
        "call": "apply", "key": "e-trim", "parent": 0, "node": 1,
        "op": { "kind": "boolean", "op": "cut", "primitive": "box", "origin": [-60.0, -50.0, -50.0], "size": [30.0, 100.0, 100.0] }
    }));
    assert!(cut.get("error").is_none(), "{cut}");
    let probe_at = |at: [f64; 3], text: &str| {
        call(
            json!({ "call": "probe", "key": "e-trim", "node": 1, "op": lettering("fuse", text, at, 5.0, DEPTH) }),
        )
    };
    // The edge is the circle where the ellipsoid meets x = -30 (at y = 19.8 on z = 0): a text centred 1.4 mm from it runs off.
    let off = probe_at([-28.566, 21.0, 0.0], "LIME");
    assert_eq!(off["ok"], json!(false), "{off}");
    assert_eq!(
        off["error"],
        json!("The text runs off this face. Move it, make it smaller, or put it on one face."),
        "{off}"
    );
    // On the side that is whole, the same text builds.
    let fine = probe_at([0.0, -30.0, 0.0], "LIME");
    assert_eq!(fine["ok"], json!(true), "{fine}");
}

#[test]
fn project_pushes_the_letters_onto_the_sphere_along_the_normal() {
    let Some(opened) = ball("b-project") else {
        return;
    };
    let before = volume_of(&opened);
    let op = with(
        lettering("fuse", "LIME 42", BALL_AT, 5.0, DEPTH),
        "wrap",
        json!("project"),
    );
    let reply = apply("b-project", &op);
    assert!(reply.get("error").is_none(), "{reply}");
    assert_eq!(reply["text"]["build"], json!("direct"), "{reply}");
    // Viewed square to the sphere at the anchor, the letters are the layout: the x of the points is -30 to within the sag.
    let points = letter_points(&reply);
    let on: Vec<[f64; 3]> = points
        .into_iter()
        .filter(|p| off_ball(*p).abs() < 2e-3)
        .collect();
    let ys: Vec<f64> = on.iter().map(|p| p[1]).collect();
    let zs: Vec<f64> = on.iter().map(|p| p[2]).collect();
    let spread = |v: &[f64]| {
        v.iter().cloned().fold(f64::MIN, f64::max) - v.iter().cloned().fold(f64::MAX, f64::min)
    };
    // The layout's box is what the projection keeps: (y, z) are the layout's (x, y) at the anchor on the equator.
    let flat =
        call(json!({ "call": "textLayout", "text": "LIME 42", "font": "sans", "height": 5.0 }));
    let b = &flat["bounds"];
    near(
        spread(&ys),
        b[2].as_f64().unwrap() - b[0].as_f64().unwrap(),
        0.05,
    );
    near(
        spread(&zs),
        b[3].as_f64().unwrap() - b[1].as_f64().unwrap(),
        0.05,
    );
    let grew = volume_of(&reply) - before;
    assert!(
        grew > ink(&op) * DEPTH * 0.97 && grew < ink(&op) * DEPTH * 1.1,
        "{grew}"
    );
    // An unknown mode is a sentence.
    let bad = probe("b-project", &with(op, "wrap", json!("squash")));
    assert_eq!(bad["ok"], json!(false), "{bad}");
    assert!(
        bad["error"]
            .as_str()
            .unwrap()
            .starts_with("wrap is wrap or project"),
        "{bad}"
    );
}

#[test]
fn the_baseline_along_v_and_a_flip_and_an_angle_all_build() {
    let Some(_) = ball("b-dir") else { return };
    let op = lettering("fuse", "LIME 42", BALL_AT, 4.0, DEPTH);
    let plain = probe("b-dir", &op);
    assert_eq!(plain["ok"], json!(true), "{plain}");
    for (field, value) in [
        ("along", json!("v")),
        ("flip", json!(true)),
        ("angleDeg", json!(30.0)),
    ] {
        let reply = probe("b-dir", &with(op.clone(), field, value));
        assert_eq!(reply["ok"], json!(true), "{field}: {reply}");
        assert_eq!(reply["text"]["build"], json!("direct"), "{field}: {reply}");
        // The same letters are the same ink on a sphere, wherever they point.
        near(
            volume_of(&reply),
            volume_of(&plain),
            0.04 * ink(&op) * DEPTH,
        );
    }
    let bad = probe("b-dir", &with(op, "along", json!("sideways")));
    assert_eq!(bad["ok"], json!(false), "{bad}");
    assert!(
        bad["error"]
            .as_str()
            .unwrap()
            .starts_with("along is u or v"),
        "{bad}"
    );
}

#[test]
fn the_refusals_are_one_sentence_each() {
    let Some(_) = ball("b-no") else { return };
    // Longer than the way round (R 30: 188.5 mm).
    let long = probe(
        "b-no",
        &lettering("fuse", &"LIME SLICE 2026 ".repeat(12), BALL_AT, 6.0, DEPTH),
    );
    assert_eq!(long["ok"], json!(false), "{long}");
    assert!(
        long["error"]
            .as_str()
            .unwrap()
            .starts_with("The text is longer than the way round this sphere (188.5 mm)."),
        "{long}"
    );
    // Too big for the curve to keep its size.
    let big = probe(
        "b-no",
        &lettering("fuse", "LIME", [-30.0, 0.0, 0.0], 40.0, DEPTH),
    );
    assert_eq!(big["ok"], json!(false), "{big}");
    assert!(
        big["error"]
            .as_str()
            .unwrap()
            .contains("too big for this curve"),
        "{big}"
    );
    // An engraving deeper than the curve allows.
    let Some(_) = open(
        "b-small",
        json!({ "primitive": "sphere", "origin": [0.0, 0.0, 0.0], "radius": 12.0 }),
    ) else {
        return;
    };
    let deep = probe(
        "b-small",
        &lettering("cut", "I", [-12.0, 0.0, 0.0], 2.0, 11.5),
    );
    assert_eq!(deep["ok"], json!(false), "{deep}");
    assert!(
        deep["error"]
            .as_str()
            .unwrap()
            .starts_with("Letters this deep would fold over inside this curve. Use a depth under "),
        "{deep}"
    );
    // The stroke font stays on flat faces; other fonts are the same as ever.
    let missing = probe(
        "b-no",
        &with(
            lettering("fuse", "☃", BALL_AT, 4.0, DEPTH),
            "font",
            json!("sans"),
        ),
    );
    assert_eq!(missing["ok"], json!(false), "{missing}");
    assert_eq!(
        missing["error"],
        json!("This font has no ‘☃’. Pick another font, or take it out.")
    );
    // A refusal leaves the solid as it was.
    let again = probe("b-no", &lettering("fuse", "I", BALL_AT, 4.0, DEPTH));
    assert_eq!(again["ok"], json!(true), "{again}");
}

#[test]
fn a_sphere_text_step_replays_from_a_saved_node_to_the_same_solid() {
    let Some(_) = ball("b-replay") else { return };
    let group = json!({
        "kind": "group", "label": "Text LIME", "source": { "kind": "text", "text": "LIME" },
        "steps": [with(lettering("fuse", "LIME", BALL_AT, 5.0, DEPTH), "font", json!("sans@4.0"))],
    });
    let applied =
        call(json!({ "call": "apply", "key": "b-replay", "parent": 0, "node": 1, "op": group }));
    assert!(applied.get("error").is_none(), "{applied}");
    let reopened = call(json!({
        "call": "open", "key": "b-replay2",
        "primitive": { "primitive": "sphere", "origin": [0.0, 0.0, 0.0], "radius": 30.0 },
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
fn the_preview_call_answers_the_letters_on_the_sphere_and_on_their_top() {
    let Some(_) = ball("b-preview") else { return };
    let reply = call(json!({
        "call": "textCurved", "key": "b-preview", "node": 0, "point": BALL_AT,
        "text": "Hi 8", "font": "sans", "height": 6.0, "depth": DEPTH, "stepMm": 0.5,
    }));
    assert_eq!(reply["ok"], json!(true), "{reply}");
    assert_eq!(reply["surface"], json!("sphere"));
    assert_eq!(reply["crossesSeam"], json!(false));
    // A short text does not walk far enough to know the way round.
    assert!(reply["wayRoundMm"].is_null(), "{reply}");
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
                near(off_ball(p(b)), 0.0, 1e-3);
                near(off_ball(p(t)), DEPTH, 1e-3);
            }
        }
    }
    // A projection previews too, and a refusal is an error with the sentence.
    let projected = call(json!({
        "call": "textCurved", "key": "b-preview", "node": 0, "point": BALL_AT,
        "text": "Hi 8", "font": "sans", "height": 6.0, "depth": DEPTH, "wrap": "project",
    }));
    assert_eq!(projected["ok"], json!(true), "{projected}");
    let refused = call(json!({
        "call": "textCurved", "key": "b-preview", "node": 0, "point": [0.0, 0.0, 30.0],
        "text": "LIME", "font": "sans", "height": 6.0, "depth": DEPTH,
    }));
    assert!(
        refused["error"].as_str().unwrap().contains("pole"),
        "{refused}"
    );
}

#[test]
fn the_display_mesh_around_the_letters_has_no_long_thin_triangles() {
    // The spike saw long thin triangles in the sphere face's display mesh around many holes. The mesh the engine sends is the app's
    // display, so the worst triangle of the face that carries the letters' holes is measured here.
    let Some(_) = ball("b-mesh") else { return };
    let op = lettering("fuse", "Lime Slice gAO8 2026", BALL_AT, 5.0, DEPTH);
    let reply = apply("b-mesh", &op);
    assert!(reply.get("error").is_none(), "{reply}");
    let (points, triangles) = mesh(&reply);
    let owners = reply["stepFaces"].as_array().unwrap();
    let node = reply["id"].as_u64().unwrap();
    let mut longest = 0.0f64;
    let mut worst_aspect = 0.0f64;
    for (tri, face) in triangles.iter().enumerate() {
        // The faces the step did not make: the ball's own face, now with the letters' holes.
        if owners[*face as usize].as_u64() == Some(node) {
            continue;
        }
        let p = &points[tri * 3..tri * 3 + 3];
        let d = |a: [f64; 3], b: [f64; 3]| {
            ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
        };
        let (a, b, c) = (d(p[0], p[1]), d(p[1], p[2]), d(p[2], p[0]));
        let s = (a + b + c) / 2.0;
        let area = (s * (s - a) * (s - b) * (s - c)).max(0.0).sqrt();
        let edge = a.max(b).max(c);
        longest = longest.max(edge);
        if area > 1e-9 {
            // Longest edge over the height it stands on: 1 for an equilateral triangle's 1.15, large for a needle.
            worst_aspect = worst_aspect.max(edge * edge / (2.0 * area));
        }
    }
    println!("display mesh of the ball with the spike text: longest edge {longest:.2} mm, worst edge^2 / 2 area {worst_aspect:.1}");
    assert!(longest < 60.0, "an edge {longest} mm long");
}

/// What a person waits for: every case on the spike's text, timed, with OBJ files when `LIME_TEXT_SKIN_OBJ` names a directory.
#[test]
fn timings_for_the_spike_text_on_a_sphere_a_torus_and_a_freeform_face() {
    let dir = std::env::var("LIME_TEXT_SKIN_OBJ").ok();
    let spike = "Lime Slice gAO8 2026";
    let jobs: Vec<(&str, &str, Value)> = vec![
        (
            "sphere-raise",
            "ball",
            lettering("fuse", spike, BALL_AT, 6.0, DEPTH),
        ),
        (
            "sphere-cut",
            "ball",
            lettering("cut", spike, BALL_AT, 6.0, DEPTH),
        ),
        (
            "sphere-seam",
            "ball",
            lettering("fuse", spike, [30.0, 0.0, 0.0], 6.0, DEPTH),
        ),
        (
            "sphere-project",
            "ball",
            with(
                lettering("fuse", "Lime 42 gA8", BALL_AT, 6.0, DEPTH),
                "wrap",
                json!("project"),
            ),
        ),
        (
            "sphere-two-lines",
            "ball",
            lettering("fuse", "Lime 42\nAO8 gB", BALL_AT, 5.0, DEPTH),
        ),
        (
            "torus-raise",
            "torus",
            lettering("fuse", "Lime 42 gA8", TORUS_AT, 4.0, DEPTH),
        ),
        (
            "torus-cut",
            "torus",
            lettering("cut", "Lime 42 gA8", TORUS_AT, 4.0, DEPTH),
        ),
        (
            "torus-seam",
            "torus",
            lettering("fuse", "Lime 42", [30.0, 0.0, 10.0], 4.0, DEPTH),
        ),
        (
            "ellipsoid-raise",
            "ellipsoid",
            lettering("fuse", spike, ELLIPSOID_AT, 5.0, DEPTH),
        ),
        (
            "ellipsoid-cut",
            "ellipsoid",
            lettering("cut", spike, ELLIPSOID_AT, 5.0, DEPTH),
        ),
    ];
    let only = std::env::var("LIME_TEXT_ONLY").ok();
    for (name, part, op) in jobs {
        if only.as_deref().is_some_and(|wanted| !name.contains(wanted)) {
            continue;
        }
        let key = format!("time-{name}");
        let opened = match part {
            "ball" => ball(&key),
            "torus" => torus(&key),
            _ => ellipsoid(&key),
        };
        if opened.is_none() {
            return;
        }
        let asked = std::time::Instant::now();
        let preview = call(json!({
            "call": "textCurved", "key": key, "node": 0, "point": op["origin"], "text": op["text"], "font": "sans", "height": op["height"],
            "depth": DEPTH, "cut": op["op"] == "cut", "wrap": op.get("wrap"), "stepMm": 0.4,
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
        if let Some(dir) = &dir {
            let (points, _) = mesh(&reply);
            let mut obj = String::new();
            for (i, p) in points.iter().enumerate() {
                obj.push_str(&format!("v {} {} {}\n", p[0], p[1], p[2]));
                if i % 3 == 2 {
                    obj.push_str(&format!("f {} {} {}\n", i - 1, i, i + 1));
                }
            }
            std::fs::write(std::path::Path::new(dir).join(format!("{name}.obj")), obj)
                .expect("write obj");
        }
        println!(
            "{name}: preview {:.3} s, probe {:.2} s, apply {:.2} s, build {}",
            preview_took, probe_took, took, reply["text"]["build"]
        );
    }
}
