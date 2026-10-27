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

#[test]
fn a_zig_zag_and_connectors_on_a_shaped_cut_are_refused_until_they_are_built() {
    let Some(zig) = cut(&op(
        json!({ "kind": "zigzag", "pitch": 10.0, "depth": 3.0, "angle": 0.0 }),
    )) else {
        return;
    };
    assert_eq!(
        zig.expect_err("later"),
        "Only straight cuts, laps and tongues are built yet. Leave the profile out, or make it straight, a lap or a tongue."
    );
    let mut with = op(lap("positive"));
    with["cuts"][0]["connectors"] =
        json!({ "on": true, "types": [{ "type": "dowel" }], "placed": [] });
    let Some(refused) = cut(&with) else { return };
    assert_eq!(
        refused.expect_err("shaped"),
        "Connectors on a lap or a tongue are not built yet. Turn them off, or cut straight."
    );
}
