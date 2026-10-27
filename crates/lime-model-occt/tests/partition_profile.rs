//! Split to print, milestone 8: a lap and a tongue on the real solids (plan sections 6, 7 and 14). Volumes by hand, the
//! step's faces at the typed depth and height, closed valid pieces, and the sentences when a profile cannot be built.
//! `LIME_REQUIRE_OCCT=1` makes a missing kernel a failure.

use serde_json::{json, Value};

/// The bar every case cuts: 120 × 30 × 20 mm from the origin, cut across X at 60 mm, U along Y, so V is Z.
const WHOLE: f64 = 120.0 * 30.0 * 20.0;

fn bar() -> String {
    json!({ "primitive": "box", "origin": [0.0, 0.0, 0.0], "size": [120.0, 30.0, 20.0] })
        .to_string()
}

fn op(profile: Value) -> Value {
    json!({
        "kind": "partition",
        "cuts": [{ "origin": [60.0, 15.0, 10.0], "normal": [1.0, 0.0, 0.0], "u": [0.0, 1.0, 0.0],
            "profile": profile, "connectors": { "on": false } }],
        "up": [0.0, 0.0, 1.0],
        "target": { "printer": "lime-220", "process": "fdm", "volumeMm": [220.0, 220.0, 250.0] },
        "orient": "keep",
        "arrange": true,
        "labels": { "on": false },
        "bedMarginMm": 5.0,
        "maxPieces": 12.0,
    })
}

fn cut(op: &Value) -> Option<Result<Value, String>> {
    match lime_model_occt::partition_joints(&bar(), &op.to_string()) {
        Err(message) if message.contains("OCCT_ROOT") => {
            assert!(
                std::env::var_os("LIME_REQUIRE_OCCT").is_none(),
                "Open CASCADE is required"
            );
            None
        }
        Err(message) => Some(Err(message)),
        Ok(text) => Some(Ok(serde_json::from_str(&text).expect("JSON"))),
    }
}

fn within(actual: f64, expected: f64, tolerance: f64) {
    assert!(
        (actual - expected).abs() <= tolerance,
        "{actual} is not within {tolerance} of {expected}"
    );
}

fn volume(piece: &Value) -> f64 {
    piece["volumeMm3"].as_f64().expect("volume")
}

fn whole(piece: &Value) {
    assert_eq!(piece["valid"], json!(true), "{piece}");
    assert_eq!(piece["closed"], json!(true), "{piece}");
    assert_eq!(piece["solids"], json!(1), "{piece}");
}

/// The flat faces of a piece with this outward normal: (centre, area).
fn planes(piece: &Value, normal: [f64; 3]) -> Vec<([f64; 3], f64)> {
    piece["surfaces"]
        .as_array()
        .expect("surfaces")
        .iter()
        .filter(|face| face["kind"] == "plane")
        .filter(|face| {
            let n = face["normal"].as_array().expect("normal");
            (0..3).all(|i| (n[i].as_f64().unwrap() - normal[i]).abs() < 1e-9)
        })
        .map(|face| {
            let at = face["at"].as_array().expect("at");
            (
                [
                    at[0].as_f64().unwrap(),
                    at[1].as_f64().unwrap(),
                    at[2].as_f64().unwrap(),
                ],
                face["area"].as_f64().unwrap(),
            )
        })
        .collect()
}

fn lap(side: &str) -> Value {
    json!({ "kind": "lap", "depth": 6.0, "height": 10.0, "side": side, "at": 0.0 })
}

#[test]
fn a_lap_carries_the_step_to_the_positive_side_and_the_volumes_sum_to_the_parent() {
    let Some(made) = cut(&op(lap("positive"))) else {
        return;
    };
    let made = made.expect("the lap builds");
    let pieces = made["pieces"].as_array().expect("pieces");
    assert_eq!(pieces.len(), 2);
    for piece in pieces {
        whole(piece);
    }
    // The first flat is the plane x = 60 below z = 10; above it the second flat is carried 6 mm to x = 66.
    let extra = 6.0 * 30.0 * 10.0;
    within(volume(&pieces[0]), WHOLE / 2.0 + extra, 1e-6);
    within(volume(&pieces[1]), WHOLE / 2.0 - extra, 1e-6);
    within(volume(&pieces[0]) + volume(&pieces[1]), WHOLE, 1e-6);
    // The first piece: a flat at x = 60 for z below 10, one at x = 66 above, the riser at z = 10 between them.
    let low = planes(&pieces[0], [1.0, 0.0, 0.0]);
    assert_eq!(low.len(), 2, "{low:?}");
    let first = low
        .iter()
        .find(|(at, _)| (at[0] - 60.0).abs() < 1e-6)
        .expect("flat at 60");
    let second = low
        .iter()
        .find(|(at, _)| (at[0] - 66.0).abs() < 1e-6)
        .expect("flat at 66");
    within(first.1, 30.0 * 10.0, 1e-6);
    within(second.1, 30.0 * 10.0, 1e-6);
    within(first.0[2], 5.0, 1e-6);
    within(second.0[2], 15.0, 1e-6);
    let riser = planes(&pieces[0], [0.0, 0.0, -1.0]);
    let step: Vec<_> = riser
        .iter()
        .filter(|(at, _)| (at[2] - 10.0).abs() < 1e-6)
        .collect();
    assert_eq!(step.len(), 1, "{riser:?}");
    within(step[0].1, 6.0 * 30.0, 1e-6);
    // The second piece has the mating faces, facing the other way.
    let mate = planes(&pieces[1], [-1.0, 0.0, 0.0]);
    assert!(
        mate.iter()
            .any(|(at, area)| (at[0] - 60.0).abs() < 1e-6 && (area - 300.0).abs() < 1e-6),
        "{mate:?}"
    );
    assert!(
        mate.iter()
            .any(|(at, area)| (at[0] - 66.0).abs() < 1e-6 && (area - 300.0).abs() < 1e-6),
        "{mate:?}"
    );
}

#[test]
fn the_other_side_carries_the_step_the_other_way() {
    let Some(made) = cut(&op(lap("negative"))) else {
        return;
    };
    let made = made.expect("the lap builds");
    let pieces = made["pieces"].as_array().expect("pieces");
    let extra = 6.0 * 30.0 * 10.0;
    within(volume(&pieces[0]), WHOLE / 2.0 - extra, 1e-6);
    within(volume(&pieces[1]), WHOLE / 2.0 + extra, 1e-6);
    let flats = planes(&pieces[0], [1.0, 0.0, 0.0]);
    assert!(
        flats.iter().any(|(at, _)| (at[0] - 54.0).abs() < 1e-6),
        "{flats:?}"
    );
}

fn tongue(side: &str) -> Value {
    json!({ "kind": "tongue", "width": 6.0, "depth": 3.0, "clearance": 0.15, "endGap": 0.4, "side": side,
        "u0": -10.0, "u1": 10.0, "v": 0.0 })
}

#[test]
fn a_tongue_is_fused_onto_one_piece_and_its_groove_cut_from_the_other() {
    let Some(made) = cut(&op(tongue("positive"))) else {
        return;
    };
    let made = made.expect("the tongue builds");
    let pieces = made["pieces"].as_array().expect("pieces");
    assert_eq!(pieces.len(), 2);
    for piece in pieces {
        whole(piece);
    }
    within(volume(&pieces[1]), WHOLE / 2.0 + 6.0 * 3.0 * 20.0, 1e-6);
    // The groove is the tongue grown by the clearance each side and the end gap at the bottom.
    within(
        volume(&pieces[0]),
        WHOLE / 2.0 - (6.0 + 0.3) * (3.0 + 0.4) * (20.0 + 0.3),
        1e-6,
    );
    // The tongue's end is a face at x = 57, 6 × 20 mm; the groove's bottom is at x = 56.6, 6.3 × 20.3.
    let end = planes(&pieces[1], [-1.0, 0.0, 0.0]);
    assert!(
        end.iter()
            .any(|(at, area)| (at[0] - 57.0).abs() < 1e-6 && (area - 120.0).abs() < 1e-6),
        "{end:?}"
    );
    let bottom = planes(&pieces[0], [1.0, 0.0, 0.0]);
    assert!(
        bottom
            .iter()
            .any(|(at, area)| (at[0] - 56.6).abs() < 1e-6 && (area - 6.3 * 20.3).abs() < 1e-6),
        "{bottom:?}"
    );
}

#[test]
fn a_tongue_on_the_negative_side_stands_the_other_way() {
    let Some(made) = cut(&op(tongue("negative"))) else {
        return;
    };
    let made = made.expect("the tongue builds");
    let pieces = made["pieces"].as_array().expect("pieces");
    within(volume(&pieces[0]), WHOLE / 2.0 + 6.0 * 3.0 * 20.0, 1e-6);
    within(
        volume(&pieces[1]),
        WHOLE / 2.0 - (6.0 + 0.3) * (3.0 + 0.4) * (20.0 + 0.3),
        1e-6,
    );
    let end = planes(&pieces[0], [1.0, 0.0, 0.0]);
    assert!(
        end.iter().any(|(at, _)| (at[0] - 63.0).abs() < 1e-6),
        "{end:?}"
    );
}

#[test]
fn a_tongue_outside_the_section_is_refused_in_a_sentence() {
    let mut off = tongue("positive");
    off["v"] = json!(40.0);
    let Some(made) = cut(&op(off)) else { return };
    assert_eq!(
        made.expect_err("outside"),
        "The tongue of cut 1 is outside the section, so it was not built"
    );
}

fn zigzag(angle: f64) -> Value {
    json!({ "kind": "zigzag", "pitch": 10.0, "depth": 3.0, "angle": angle, "side": "positive", "u0": -15.0 })
}

#[test]
fn a_zig_zag_carries_square_teeth_to_the_positive_side() {
    let Some(made) = cut(&op(zigzag(0.0))) else {
        return;
    };
    let made = made.expect("the zig-zag builds");
    let pieces = made["pieces"].as_array().expect("pieces");
    assert_eq!(pieces.len(), 2);
    for piece in pieces {
        whole(piece);
    }
    // 30 mm of section is three 10 mm periods; each carries a tooth 5 mm wide and 3 mm tall across the 20 mm of V.
    let teeth = 3.0 * 5.0 * 3.0 * 20.0;
    within(volume(&pieces[0]), WHOLE / 2.0 + teeth, 1e-6);
    within(volume(&pieces[1]), WHOLE / 2.0 - teeth, 1e-6);
    // Each tooth's top is a flat at x = 63, 5 x 20 mm, three of them; the floor between them stays at x = 60.
    let tops: Vec<_> = planes(&pieces[0], [1.0, 0.0, 0.0])
        .into_iter()
        .filter(|(at, _)| (at[0] - 63.0).abs() < 1e-6)
        .collect();
    assert_eq!(tops.len(), 3, "{tops:?}");
    for (_, area) in &tops {
        within(*area, 5.0 * 20.0, 1e-6);
    }
}

#[test]
fn a_leaning_zig_zag_has_a_narrower_tip_and_the_volume_of_its_trapezoids() {
    let Some(made) = cut(&op(zigzag(30.0))) else {
        return;
    };
    let made = made.expect("the zig-zag builds");
    let pieces = made["pieces"].as_array().expect("pieces");
    for piece in pieces {
        whole(piece);
    }
    // Each flank leans in by half of depth x tan(30), so a tooth 5 mm at its base is narrower by depth x tan(30) at its tip.
    let tip = 5.0 - 3.0 * (30.0_f64).to_radians().tan();
    let tooth = (5.0 + tip) / 2.0 * 3.0 * 20.0;
    within(volume(&pieces[0]), WHOLE / 2.0 + 3.0 * tooth, 1e-6);
    within(volume(&pieces[1]), WHOLE / 2.0 - 3.0 * tooth, 1e-6);
    let tops: Vec<_> = planes(&pieces[0], [1.0, 0.0, 0.0])
        .into_iter()
        .filter(|(at, _)| (at[0] - 63.0).abs() < 1e-6)
        .collect();
    assert_eq!(tops.len(), 3, "{tops:?}");
    within(tops[0].1, tip * 20.0, 1e-6);
}

fn dovetail(slide: &str) -> Value {
    json!({ "kind": "dovetail", "width": 8.0, "angle": 20.0, "depth": 3.0, "slide": slide, "side": "positive",
        "clearance": 0.15, "endGap": 0.4, "u0": -15.0, "u1": 15.0, "v": 0.0 })
}

/// The dovetail's section: the neck at the plane, 8 mm at its end, and the groove grown by the clearance square to a flank.
fn dovetail_areas() -> (f64, f64) {
    let lean = (20.0_f64).to_radians().tan();
    let root = 4.0 - 3.0 * lean;
    let peg = (2.0 * root + 8.0) / 2.0 * 3.0;
    let grow = 0.15 / (20.0_f64).to_radians().cos();
    let groove = 2.0 * (root + grow) * 3.4 + lean * 3.4 * 3.4;
    (peg, groove)
}

#[test]
fn a_dovetail_profile_runs_the_whole_section_and_its_groove_is_grown_by_the_clearance() {
    let Some(made) = cut(&op(dovetail("u"))) else {
        return;
    };
    let made = made.expect("the dovetail builds");
    let pieces = made["pieces"].as_array().expect("pieces");
    assert_eq!(pieces.len(), 2);
    for piece in pieces {
        whole(piece);
    }
    let (peg, groove) = dovetail_areas();
    // It slides along U, the 30 mm of the section.
    within(volume(&pieces[1]), WHOLE / 2.0 + 30.0 * peg, 1e-5);
    within(volume(&pieces[0]), WHOLE / 2.0 - 30.0 * groove, 1e-5);
    // The tongue's end, 8 mm across and 30 mm long, is a plane at x = 57.
    let end = planes(&pieces[1], [-1.0, 0.0, 0.0]);
    assert!(
        end.iter()
            .any(|(at, area)| (at[0] - 57.0).abs() < 1e-6 && (area - 8.0 * 30.0).abs() < 1e-6),
        "{end:?}"
    );
}

#[test]
fn a_dovetail_sliding_along_v_lies_across_u() {
    // Slid along V, the 20 mm of the section; the 30 mm of U is across it, with the cross-section centred on U.
    let mut v = dovetail("v");
    v["u0"] = json!(-10.0);
    v["u1"] = json!(10.0);
    let Some(made) = cut(&op(v)) else { return };
    let made = made.expect("the dovetail builds");
    let pieces = made["pieces"].as_array().expect("pieces");
    for piece in pieces {
        whole(piece);
    }
    let (peg, groove) = dovetail_areas();
    within(volume(&pieces[1]), WHOLE / 2.0 + 20.0 * peg, 1e-5);
    within(volume(&pieces[0]), WHOLE / 2.0 - 20.0 * groove, 1e-5);
}

#[test]
fn a_dovetail_without_a_neck_is_refused_in_a_sentence() {
    let mut wide = dovetail("u");
    wide["angle"] = json!(60.0);
    let Some(made) = cut(&op(wide)) else { return };
    assert_eq!(
        made.expect_err("no neck"),
        "The dovetail of cut 1 has no neck at this depth and angle. Lower the angle or widen it."
    );
}

#[test]
fn connectors_on_a_shaped_cut_are_refused_until_they_are_built() {
    let mut with = op(lap("positive"));
    with["cuts"][0]["connectors"] =
        json!({ "on": true, "types": [{ "type": "dowel" }], "placed": [] });
    let Some(refused) = cut(&with) else { return };
    assert_eq!(
        refused.expect_err("shaped"),
        "Connectors on a shaped cut are not built yet. Turn them off, or cut straight."
    );
}

// --- Milestone 10: a sketched profile. The chain is in the cut's (U, W) from its origin, so on the bar U is Y − 15 and W
// is X − 60; it is swept along V, which is Z.

fn sketch(start: [f64; 2], chain: Value) -> Value {
    json!({ "kind": "sketch", "start": start, "chain": chain })
}

/// A step up 6 mm at U = −5, then a half circle of radius 5 standing on the upper flat, then the flat to past the side.
fn step_and_arc() -> Value {
    sketch(
        [-20.0, 0.0],
        json!([
            { "kind": "line", "to": [-5.0, 0.0] },
            { "kind": "line", "to": [-5.0, 6.0] },
            { "kind": "arc", "through": [0.0, 11.0], "to": [5.0, 6.0] },
            { "kind": "line", "to": [20.0, 6.0] },
        ]),
    )
}

#[test]
fn a_sketched_step_and_arc_cut_pieces_that_sum_to_the_parent() {
    let Some(made) = cut(&op(step_and_arc())) else {
        return;
    };
    let made = made.expect("the sketch builds");
    let pieces = made["pieces"].as_array().expect("pieces");
    assert_eq!(pieces.len(), 2);
    for piece in pieces {
        whole(piece);
    }
    // By hand, in (U, W) times the 20 mm along V: below the chain is 10 × 60 up to the step, 20 × 66 after it, and the
    // half circle over the upper flat.
    let below = 20.0 * (10.0 * 60.0 + 20.0 * 66.0 + std::f64::consts::PI * 25.0 / 2.0);
    within(volume(&pieces[0]), below, 1e-6);
    within(volume(&pieces[1]), WHOLE - below, 1e-6);
    within(volume(&pieces[0]) + volume(&pieces[1]), WHOLE, 1e-6);
}

#[test]
fn the_cut_faces_follow_the_chain() {
    let Some(made) = cut(&op(step_and_arc())) else {
        return;
    };
    let made = made.expect("the sketch builds");
    let pieces = made["pieces"].as_array().expect("pieces");
    // The first flat, W = 0 up to the step: x = 60 for y from 0 to 10.
    let flats = planes(&pieces[0], [1.0, 0.0, 0.0]);
    let first = flats
        .iter()
        .find(|(at, _)| (at[0] - 60.0).abs() < 1e-6)
        .expect("flat at 60");
    within(first.1, 10.0 * 20.0, 1e-6);
    within(first.0[1], 5.0, 1e-6);
    // The last flat, W = 6 after the arc: x = 66 for y from 20 to 30.
    let last = flats
        .iter()
        .find(|(at, _)| (at[0] - 66.0).abs() < 1e-6)
        .expect("flat at 66");
    within(last.1, 10.0 * 20.0, 1e-6);
    within(last.0[1], 25.0, 1e-6);
    // The step's riser at U = −5, y = 10, from x = 60 to 66, faces back along −Y on the first piece and +Y on the second.
    let riser = planes(&pieces[0], [0.0, -1.0, 0.0]);
    let step = riser
        .iter()
        .find(|(at, _)| (at[1] - 10.0).abs() < 1e-6)
        .expect("riser at y = 10");
    within(step.1, 6.0 * 20.0, 1e-6);
    within(step.0[0], 63.0, 1e-6);
    assert!(planes(&pieces[1], [0.0, 1.0, 0.0])
        .iter()
        .any(|(at, area)| (at[1] - 10.0).abs() < 1e-6 && (area - 120.0).abs() < 1e-6));
    // The arc is a cylinder of radius 5 standing along V (Z) on the line x = 66, y = 15, on both pieces.
    for piece in pieces {
        let arcs: Vec<_> = piece["surfaces"]
            .as_array()
            .expect("surfaces")
            .iter()
            .filter(|face| face["kind"] == "cylinder")
            .collect();
        assert_eq!(arcs.len(), 1, "{arcs:?}");
        within(arcs[0]["radius"].as_f64().expect("radius"), 5.0, 1e-9);
        let at = arcs[0]["at"].as_array().expect("at");
        let axis = arcs[0]["axis"].as_array().expect("axis");
        within(at[0].as_f64().unwrap(), 66.0, 1e-9);
        within(at[1].as_f64().unwrap(), 15.0, 1e-9);
        within(axis[2].as_f64().unwrap().abs(), 1.0, 1e-9);
    }
}

#[test]
fn a_piece_that_wraps_a_tall_tooth_is_still_on_its_own_side() {
    // A tooth 6 mm wide and 50 mm tall: the second piece wraps it, and its centre of mass lies inside the tooth.
    let tooth = sketch(
        [-20.0, 0.0],
        json!([
            { "kind": "line", "to": [-3.0, 0.0] },
            { "kind": "line", "to": [-3.0, 50.0] },
            { "kind": "line", "to": [3.0, 50.0] },
            { "kind": "line", "to": [3.0, 0.0] },
            { "kind": "line", "to": [20.0, 0.0] },
        ]),
    );
    let Some(made) = cut(&op(tooth)) else { return };
    let made = made.expect("the tooth builds");
    let pieces = made["pieces"].as_array().expect("pieces");
    assert_eq!(pieces.len(), 2);
    within(volume(&pieces[0]), WHOLE / 2.0 + 6.0 * 50.0 * 20.0, 1e-6);
    within(volume(&pieces[1]), WHOLE / 2.0 - 6.0 * 50.0 * 20.0, 1e-6);
}

#[test]
fn a_sketch_that_crosses_itself_or_misses_the_part_is_refused() {
    let crossed = sketch(
        [-20.0, 0.0],
        json!([
            { "kind": "line", "to": [5.0, 0.0] },
            { "kind": "line", "to": [5.0, 8.0] },
            { "kind": "line", "to": [-5.0, 8.0] },
            { "kind": "line", "to": [-5.0, -8.0] },
            { "kind": "line", "to": [20.0, -8.0] },
        ]),
    );
    let Some(refused) = cut(&op(crossed)) else {
        return;
    };
    assert_eq!(refused.expect_err("crosses"), "The profile crosses itself.");
    // 100 mm along W is past the bar's end: nothing is cut.
    let away = sketch([-20.0, 100.0], json!([{ "kind": "line", "to": [20.0, 100.0] }]));
    let Some(missed) = cut(&op(away)) else { return };
    assert_eq!(
        missed.expect_err("misses"),
        "The sketch profile does not cross the part. Draw it from one side of the section to the other."
    );
    let spline = sketch([-20.0, 0.0], json!([{ "kind": "spline", "to": [20.0, 0.0] }]));
    let Some(splined) = cut(&op(spline)) else { return };
    assert_eq!(splined.expect_err("spline"), "Cut 1's sketch is lines and arcs.");
}
