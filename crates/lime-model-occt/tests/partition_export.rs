//! Split to print for a printer this app does not slice for (docs/plan-split-connectors.md, milestone 3b): a resin
//! target cuts, part numbers are engraved on both mating cut faces (or a side face, or skipped with a sentence), and the
//! pieces export as one STEP file of separate named solids that reads back with the same volumes.
//! `LIME_REQUIRE_OCCT=1` makes a missing kernel a failure.
//!
//! The store is process-wide, so everything runs in one test, in order.

use base64::Engine;
use serde_json::{json, Value};

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
    reply["volumeMm3"]
        .as_f64()
        .unwrap_or_else(|| panic!("volumeMm3 in {reply}"))
}

fn within(actual: f64, expected: f64, tolerance: f64) {
    assert!(
        (actual - expected).abs() <= tolerance,
        "{actual} is not within {tolerance} of {expected}"
    );
}

/// Planar B-rep volumes integrate exactly up to rounding: a 12 000 mm³ box less a stroke differs from the sum of its
/// boxes by about 1e-11 mm³ in double precision, so 1e-6 mm³ is a hundred thousand times that and still a thousandth of
/// the smallest number's volume here (0.96 mm³).
const EXACT: f64 = 1e-6;

const FORM_4: [f64; 3] = [200.0, 125.0, 210.0];

fn cut(origin: [f64; 3], normal: [f64; 3], u: [f64; 3]) -> Value {
    json!({ "origin": origin, "normal": normal, "u": u, "profile": { "kind": "straight" }, "connectors": { "on": false } })
}

fn resin(cuts: Vec<Value>) -> Value {
    json!({
        "kind": "partition",
        "cuts": cuts,
        "target": { "printer": "formlabs-form-4", "process": "resin", "volumeMm": FORM_4 },
        "orient": "keep",
        "arrange": false,
        "labels": { "on": true, "face": "cut", "height": 4.0, "depth": 0.4 },
        "bedMarginMm": 10.0,
        "maxPieces": 12.0,
    })
}

/// The numbers' strokes as the client sends them beside the op: one list of `[u, v, length, angleDeg]` per piece.
fn numbered(mut op: Value, digits: Value, stroke: f64, depth: f64, inset: f64) -> Value {
    op["numbers"] =
        json!({ "digits": digits, "strokeMm": stroke, "depthMm": depth, "insetMm": inset });
    op
}

/// `textStrokes("1", 4, 0.6)` in src/modeling/text.ts: the glyph's polylines on the 4 × 6 grid, centred, each stroke
/// running half a width past both ends.
fn one_at_4mm() -> Vec<[f64; 4]> {
    let k = 4.0 / 6.0;
    let (u0, v0) = (-2.0 * k, -2.0);
    let width = 0.6;
    [
        [[1.0, 5.0], [2.0, 6.0]],
        [[2.0, 6.0], [2.0, 0.0]],
        [[1.0, 0.0], [3.0, 0.0]],
    ]
    .iter()
    .map(|[a, b]| {
        let (au, av) = (u0 + a[0] * k, v0 + a[1] * k);
        let (bu, bv) = (u0 + b[0] * k, v0 + b[1] * k);
        let (du, dv): (f64, f64) = (bu - au, bv - av);
        [
            (au + bu) / 2.0,
            (av + bv) / 2.0,
            du.hypot(dv) + width,
            dv.atan2(du).to_degrees(),
        ]
    })
    .collect()
}

#[test]
fn split_to_print_for_export() {
    let opened = call(json!({ "call": "open", "key": "tall", "box": [100.0, 80.0, 400.0] }));
    if opened["error"]
        .as_str()
        .is_some_and(|error| error.contains("OCCT_ROOT"))
    {
        assert!(
            std::env::var_os("LIME_REQUIRE_OCCT").is_none(),
            "Open CASCADE is required"
        );
        return;
    }
    assert!(opened.get("error").is_none(), "{opened}");
    a_resin_target_cuts();
    numbers_go_on_both_mating_cut_faces();
    a_real_digit_cuts_less_than_its_strokes();
    a_cut_face_with_no_room_takes_a_side_face();
    a_piece_with_no_room_skips_its_number();
    the_pieces_round_trip_as_one_step_file();
}

/// A 400 mm tall part for the Form 4, cut across its height in three, as the planner proposes it (section 5).
fn a_resin_target_cuts() {
    let third = 400.0 / 3.0;
    let op = resin(vec![
        cut([50.0, 40.0, third], [0.0, 0.0, 1.0], [1.0, 0.0, 0.0]),
        cut([50.0, 40.0, 2.0 * third], [0.0, 0.0, 1.0], [1.0, 0.0, 0.0]),
    ]);
    let applied = ok(
        json!({ "call": "apply", "key": "tall", "parent": 0, "node": 1, "op": op, "pieceKeys": ["tall-2", "tall-3"] }),
    );
    assert_eq!(applied["parts"], 3, "{applied}");
    let slab = 100.0 * 80.0 * third;
    within(volume(&applied), slab, 1e-6);
    let pieces = applied["pieces"].as_array().expect("pieces");
    for piece in pieces {
        within(volume(piece), slab, 1e-6);
    }
    assert!(
        applied.get("numbers").is_none(),
        "no strokes were sent, so no number is cut: {applied}"
    );
    assert_eq!(applied["op"], op, "the op is stored as sent");
}

/// One cut across a 60 × 20 × 20 box at X 30. Piece 1's number is one stroke 4 × 0.6 mm and piece 2's two: no stroke
/// overlaps another, so each number's area is its strokes' and the volume lost is that area times the depth.
fn numbers_go_on_both_mating_cut_faces() {
    ok(json!({ "call": "open", "key": "bar", "box": [60.0, 20.0, 20.0] }));
    let digits = json!([
        [[0.0, 0.0, 4.0, 0.0]],
        [[0.0, -1.0, 4.0, 0.0], [0.0, 1.0, 4.0, 0.0]]
    ]);
    let op = numbered(
        resin(vec![cut(
            [30.0, 10.0, 10.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
        )]),
        digits,
        0.6,
        0.4,
        0.8,
    );
    let probe = ok(json!({ "call": "probe", "key": "bar", "node": 0, "op": op }));
    assert_eq!(probe["notes"], json!([]), "{probe}");
    let applied = ok(
        json!({ "call": "apply", "key": "bar", "parent": 0, "node": 1, "op": op, "pieceKeys": ["bar-2"] }),
    );
    assert!(
        applied["op"].get("numbers").is_none(),
        "the strokes are never echoed: {applied}"
    );
    let (one, two) = (4.0 * 0.6, 2.0 * 4.0 * 0.6);
    within(volume(&applied), 12000.0 - one * 0.4, EXACT);
    let piece = &applied["pieces"][0];
    within(volume(piece), 12000.0 - two * 0.4, EXACT);
    for (part, normal) in [(0, [1.0, 0.0, 0.0]), (1, [-1.0, 0.0, 0.0])] {
        let faces = applied["numbers"][part]["faces"].as_array().expect("faces");
        assert_eq!(faces.len(), 1, "{applied}");
        assert_eq!(faces[0]["face"], "cut");
        assert_eq!(faces[0]["cut"], 0);
        assert_eq!(
            faces[0]["normal"],
            json!(normal),
            "the face points out of piece {}",
            part + 1
        );
        for (axis, expected) in [30.0, 10.0, 10.0].into_iter().enumerate() {
            within(faces[0]["at"][axis].as_f64().expect("at"), expected, 1e-6);
        }
    }
    assert_eq!(applied["notes"], json!([]));
    // The recess's floor is a face of the number's area, facing out of the cut face; the cap keeps the rest.
    let floor_and_cap = |reply: &Value, normal: [f64; 3], area: f64| {
        let faces = reply["faces"].as_array().expect("faces");
        let facing: Vec<f64> = faces
            .iter()
            .filter(|face| {
                (0..3).all(|i| (face["normal"][i].as_f64().unwrap_or(9.0) - normal[i]).abs() < 1e-9)
            })
            .map(|face| face["areaMm2"].as_f64().expect("areaMm2"))
            .collect();
        let total: f64 = facing.iter().sum();
        within(total, 400.0, 1e-6);
        assert!(
            facing
                .iter()
                .any(|face| (face - (400.0 - area)).abs() < 1e-6),
            "the cap is 400 mm² less the number: {facing:?}"
        );
    };
    floor_and_cap(&applied, [1.0, 0.0, 0.0], one);
    floor_and_cap(piece, [-1.0, 0.0, 0.0], two);
    ok(json!({ "call": "close", "key": "bar-2" }));
}

/// The glyph "1" as `textStrokes` draws it at 4 mm. Its strokes overlap where they meet, so the number takes less than
/// the strokes' summed area and more than its largest stroke's.
fn a_real_digit_cuts_less_than_its_strokes() {
    let strokes = one_at_4mm();
    let op = numbered(
        resin(vec![cut(
            [30.0, 10.0, 10.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
        )]),
        json!([strokes, []]),
        0.6,
        0.4,
        0.8,
    );
    let applied = ok(json!({ "call": "apply", "key": "bar", "parent": 0, "node": 2, "op": op }));
    let lost = 12000.0 - volume(&applied);
    let areas: Vec<f64> = strokes.iter().map(|stroke| stroke[2] * 0.6).collect();
    let sum: f64 = areas.iter().sum();
    let largest = areas.iter().cloned().fold(0.0, f64::max);
    assert!(
        lost < sum * 0.4 - 1e-3 && lost > largest * 0.4 + 1e-3,
        "{lost} mm³ is between {} and {}",
        largest * 0.4,
        sum * 0.4
    );
    assert_eq!(
        applied["numbers"][1]["faces"],
        json!([]),
        "piece 2 was sent no strokes"
    );
}

/// A 6 × 6 mm section cannot hold a label 7 mm long with its inset, either way round; the 30 × 6 mm side can.
fn a_cut_face_with_no_room_takes_a_side_face() {
    ok(json!({ "call": "open", "key": "rod", "box": [60.0, 6.0, 6.0] }));
    let op = numbered(
        resin(vec![cut(
            [30.0, 3.0, 3.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
        )]),
        json!([[[0.0, 0.0, 4.0, 0.0]], [[0.0, 0.0, 4.0, 0.0]]]),
        0.6,
        0.4,
        1.5,
    );
    let applied = ok(json!({ "call": "apply", "key": "rod", "parent": 0, "node": 1, "op": op }));
    for part in 0..2 {
        let faces = applied["numbers"][part]["faces"].as_array().expect("faces");
        assert_eq!(faces.len(), 1, "{applied}");
        assert_eq!(faces[0]["face"], "side");
        assert!(faces[0]["cut"].is_null());
        let normal: Vec<f64> = (0..3)
            .map(|i| faces[0]["normal"][i].as_f64().expect("normal"))
            .collect();
        assert!(
            normal[0].abs() < 1e-9,
            "a side face is along the rod: {normal:?}"
        );
    }
    within(volume(&applied), 1080.0 - 4.0 * 0.6 * 0.4, EXACT);
    assert_eq!(applied["notes"], json!([]));
    ok(json!({ "call": "close", "key": "rod" }));
}

/// A 2 × 2 mm rod has no face that holds a 4 mm number: both pieces keep their volume, and each is named.
fn a_piece_with_no_room_skips_its_number() {
    ok(json!({ "call": "open", "key": "wire", "box": [60.0, 2.0, 2.0] }));
    let op = numbered(
        resin(vec![cut(
            [30.0, 1.0, 1.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
        )]),
        json!([[[0.0, 0.0, 4.0, 0.0]], [[0.0, 0.0, 4.0, 90.0]]]),
        0.6,
        0.4,
        0.8,
    );
    let applied = ok(
        json!({ "call": "apply", "key": "wire", "parent": 0, "node": 1, "op": op, "pieceKeys": ["wire-2"] }),
    );
    within(volume(&applied), 120.0, EXACT);
    within(volume(&applied["pieces"][0]), 120.0, EXACT);
    assert_eq!(
        applied["notes"],
        json!([
            "Part 1 has no room for a number.",
            "Part 2 has no room for a number."
        ])
    );
    assert_eq!(applied["numbers"][0]["faces"], json!([]));
    for key in ["wire", "wire-2"] {
        ok(json!({ "call": "close", "key": key }));
    }
}

/// The three slabs of the tall part as one STEP file: three solids, each closed and valid, with the volumes the tree
/// holds. STEP writes coordinates in decimal to 15 significant digits, so a 1 066 667 mm³ slab reads back within
/// about 1e-6 of a relative part: 1e-3 mm³ is the tolerance.
fn the_pieces_round_trip_as_one_step_file() {
    let expected: Vec<f64> = [("tall", 1), ("tall-2", 0), ("tall-3", 0)]
        .iter()
        .map(|(key, node)| volume(&ok(json!({ "call": "goto", "key": key, "node": node }))))
        .collect();
    let pieces = json!([{ "key": "tall-2", "node": 0 }, { "key": "tall-3", "node": 0 }]);
    let exported = ok(json!({
        "call": "export", "key": "tall", "node": 1, "format": "step",
        "pieces": pieces, "names": ["tall-1", "tall-2", "tall-3"],
    }));
    assert_eq!(exported["solids"], 3, "{exported}");
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(exported["bytesBase64"].as_str().expect("bytesBase64"))
        .expect("base64");
    assert_eq!(exported["byteLength"].as_u64(), Some(bytes.len() as u64));
    let named =
        lime_model_occt::step_named_solids(&bytes).expect("the file reads as an XCAF document");
    assert_eq!(
        named
            .iter()
            .map(|(name, _)| name.as_str())
            .collect::<Vec<_>>(),
        ["tall-1", "tall-2", "tall-3"]
    );
    for ((_, solid), expected) in named.iter().zip(&expected) {
        assert!(
            solid.valid && solid.closed && solid.solids == 1,
            "{solid:?}"
        );
        within(solid.volume_mm3, *expected, 1e-3);
    }
    let solids = lime_model_occt::step_solids(&bytes).expect("the file reads");
    assert_eq!(solids.len(), 3, "{solids:?}");
    for (solid, expected) in solids.iter().zip(&expected) {
        assert!(
            solid.valid && solid.closed && solid.solids == 1,
            "{solid:?}"
        );
        within(solid.volume_mm3, *expected, 1e-3);
    }
    let unnamed = call(json!({
        "call": "export", "key": "tall", "node": 1, "format": "step",
        "pieces": pieces, "names": ["tall-1"],
    }));
    assert_eq!(
        unnamed,
        json!({ "error": "A STEP file of 3 pieces needs a name for each, and 1 came." })
    );
    let brep = call(json!({
        "call": "export", "key": "tall", "node": 1, "format": "brep",
        "pieces": [{ "key": "tall-2", "node": 0 }], "names": ["tall-1", "tall-2"],
    }));
    assert_eq!(
        brep,
        json!({ "error": "A split to print's pieces export as STEP" })
    );
    for key in ["tall", "tall-2", "tall-3", "bar"] {
        ok(json!({ "call": "close", "key": key }));
    }
}
