//! Split to print, milestone 11: connectors on the flats of a shaped cut (plan sections 6 and 8). A dowel on a lap's two flats,
//! on a zig-zag's low flat and tooth tip, on a tilted segment of a sketched chain, and beside a tongue and a dovetail: the
//! hole starts at that flat's own plane, along its own normal. Volumes by hand, axes from `Geom_CylindricalSurface`. `LIME_REQUIRE_OCCT=1` makes a missing
//! kernel a failure.

use std::f64::consts::PI;

use serde_json::{json, Value};

/// The bar every case cuts: 120 × 30 × 20 mm from the origin, cut across X at 60 mm, U along Y, so V is Z.
const WHOLE: f64 = 120.0 * 30.0 * 20.0;

fn bar() -> String {
    json!({ "primitive": "box", "origin": [0.0, 0.0, 0.0], "size": [120.0, 30.0, 20.0] })
        .to_string()
}

fn dowel() -> Value {
    json!({ "type": "dowel", "radius": 3.0, "depth": 8.0, "clearance": 0.15, "endGap": 0.4, "hole": "round",
        "count": "fit", "margin": 5.0, "place": "fit", "at": [] })
}

/// A dowel on a flat: where its plane runs through the cut's (U, W), its tilt, and the centre in that plane's U and V.
fn on_flat(index: usize, flat: [f64; 3], at: [f64; 2]) -> Value {
    json!({ "id": format!("c1-{index}"), "type": "dowel", "uvMm": at, "fraction": null, "fixed": true,
        "flat": { "u": flat[0], "w": flat[1], "tilt": flat[2] } })
}

fn op(profile: Value, placed: Vec<Value>) -> String {
    json!({
        "kind": "partition",
        "cuts": [{ "origin": [60.0, 15.0, 10.0], "normal": [1.0, 0.0, 0.0], "u": [0.0, 1.0, 0.0],
            "profile": profile,
            "connectors": { "on": true, "types": [dowel()], "placed": placed } }],
        "up": [0.0, 0.0, 1.0],
        "target": { "printer": "lime-220", "process": "fdm", "volumeMm": [220.0, 220.0, 250.0] },
        "orient": "keep",
        "arrange": true,
        "labels": { "on": false },
        "bedMarginMm": 5.0,
        "maxPieces": 12.0,
    })
    .to_string()
}

fn cut(op: &str) -> Option<Value> {
    match lime_model_occt::partition_joints(&bar(), op) {
        Err(message) if message.contains("OCCT_ROOT") => {
            assert!(
                std::env::var_os("LIME_REQUIRE_OCCT").is_none(),
                "Open CASCADE is required"
            );
            None
        }
        Err(message) => panic!("{message}"),
        Ok(text) => Some(serde_json::from_str(&text).expect("JSON")),
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

fn vec3(value: &Value) -> [f64; 3] {
    let list = value.as_array().expect("three numbers");
    [0, 1, 2].map(|i| list[i].as_f64().expect("a number"))
}

/// Every cylinder of a shape of this radius: a point on its axis and the axis.
fn cylinders(piece: &Value, radius: f64) -> Vec<([f64; 3], [f64; 3])> {
    piece["surfaces"]
        .as_array()
        .expect("surfaces")
        .iter()
        .filter(|face| face["kind"] == "cylinder")
        .filter(|face| (face["radius"].as_f64().expect("radius") - radius).abs() < 1e-6)
        .map(|face| (vec3(&face["at"]), vec3(&face["axis"])))
        .collect()
}

/// How far the line through `at` along `axis` passes from the line through `centre` along `normal`, and how far it turns.
fn off(at: [f64; 3], axis: [f64; 3], centre: [f64; 3], normal: [f64; 3]) -> (f64, f64) {
    let d = [at[0] - centre[0], at[1] - centre[1], at[2] - centre[2]];
    let along = d[0] * normal[0] + d[1] * normal[1] + d[2] * normal[2];
    let away = (0..3).map(|i| (d[i] - along * normal[i]).powi(2)).sum::<f64>().sqrt();
    let turn = 1.0 - (axis[0] * normal[0] + axis[1] * normal[1] + axis[2] * normal[2]).abs();
    (away, turn)
}

/// Each piece has exactly the holes it should: coaxial with one of `centres`, along `normal`.
fn holes_on(piece: &Value, centres: &[[f64; 3]], normal: [f64; 3]) {
    let found = cylinders(piece, 3.15);
    assert!(!found.is_empty(), "no hole in {piece}");
    for (at, axis) in found {
        let nearest = centres
            .iter()
            .map(|centre| off(at, axis, *centre, normal))
            .min_by(|a, b| a.0.total_cmp(&b.0))
            .expect("a centre");
        assert!(nearest.0 < 1e-6 && nearest.1 < 1e-9, "a hole is {} mm off, turned {}", nearest.0, nearest.1);
    }
}

fn each_hole() -> f64 {
    PI * 3.15 * 3.15 * (4.0 + 0.4)
}

#[test]
fn a_lap_takes_a_dowel_on_each_of_its_flats() {
    // Flat one is the plane x = 60 below the step (z < 10), flat two x = 66 above it. The step is at V = 0.
    let lap = json!({ "kind": "lap", "depth": 6.0, "height": 10.0, "side": "positive", "at": 0.0 });
    let rows = vec![on_flat(1, [0.0, 0.0, 0.0], [0.0, -5.0]), on_flat(2, [0.0, 6.0, 0.0], [0.0, 5.0])];
    let Some(made) = cut(&op(lap, rows)) else { return };
    let pieces = made["pieces"].as_array().expect("pieces");
    assert_eq!(pieces.len(), 2);
    for piece in pieces {
        whole(piece);
    }
    // The lap's own pieces: 60 × 30 × 10 and 66 × 30 × 10 below it, the rest above. Each loses both holes' halves.
    let low = 60.0 * 30.0 * 10.0 + 66.0 * 30.0 * 10.0;
    let mut volumes = pieces.iter().map(volume).collect::<Vec<_>>();
    volumes.sort_by(f64::total_cmp);
    within(volumes[0], WHOLE - low - 2.0 * each_hole(), 1e-6);
    within(volumes[1], low - 2.0 * each_hole(), 1e-6);
    let flat_one = [60.0, 15.0, 5.0];
    let flat_two = [66.0, 15.0, 15.0];
    for piece in pieces {
        holes_on(piece, &[flat_one, flat_two], [1.0, 0.0, 0.0]);
        let axes = cylinders(piece, 3.15);
        let heights: Vec<f64> = axes.iter().map(|(at, _)| at[2]).collect();
        assert!(heights.iter().any(|z| (z - 5.0).abs() < 1e-6) && heights.iter().any(|z| (z - 15.0).abs() < 1e-6), "{heights:?}");
    }
    assert_eq!(made["pins"]["solids"], json!(2));
    assert_eq!(made["connectors"]["dropped"], json!([]));
    let at = made["connectors"]["placed"].as_array().expect("placed");
    let [first, second] = [vec3(&at[0]["at"]), vec3(&at[1]["at"])];
    for (found, expected) in [(first, flat_one), (second, flat_two)] {
        for i in 0..3 {
            within(found[i], expected[i], 1e-9);
        }
    }
}

#[test]
fn a_zig_zag_takes_a_dowel_on_its_low_flat_and_on_a_tooth_tip() {
    // Pitch 20, depth 3, from U = −15: the low flat is U −15 to −5 at x = 60, the tooth tip −5 to 5 at x = 63.
    let wave = json!({ "kind": "zigzag", "pitch": 20.0, "depth": 3.0, "angle": 0.0, "side": "positive", "u0": -15.0 });
    let rows = vec![on_flat(1, [0.0, 0.0, 0.0], [-10.0, 0.0]), on_flat(2, [0.0, 3.0, 0.0], [0.0, 0.0])];
    let Some(made) = cut(&op(wave, rows)) else { return };
    let pieces = made["pieces"].as_array().expect("pieces");
    assert_eq!(pieces.len(), 2);
    for piece in pieces {
        whole(piece);
    }
    let low = 20.0 * (30.0 * 60.0 + 10.0 * 3.0);
    let mut volumes = pieces.iter().map(volume).collect::<Vec<_>>();
    volumes.sort_by(f64::total_cmp);
    within(volumes[0], WHOLE - low - 2.0 * each_hole(), 1e-6);
    within(volumes[1], low - 2.0 * each_hole(), 1e-6);
    for piece in pieces {
        holes_on(piece, &[[60.0, 5.0, 10.0], [63.0, 15.0, 10.0]], [1.0, 0.0, 0.0]);
    }
    assert_eq!(made["connectors"]["dropped"], json!([]));
}

#[test]
fn a_tilted_segment_of_a_sketch_takes_a_dowel_square_to_itself() {
    // One line from (−20, 0) to (20, 8) in (U, W): it rises 8 over 40, so its normal is turned from W toward U by
    // atan2(−8, 40) = −11.31°.
    let chain = json!({ "kind": "sketch", "start": [-20.0, 0.0], "chain": [{ "kind": "line", "to": [20.0, 8.0] }] });
    let length = 40.0_f64.hypot(8.0);
    let tilt = (-8.0_f64).atan2(40.0).to_degrees();
    // The dowel is on the line above U = 0, at w = 4: 20 of 40 mm along the cut's U, so 20 / cos(tilt) along the flat.
    let along = 20.0 / tilt.to_radians().cos();
    let rows = vec![on_flat(1, [-20.0, 0.0, tilt], [along, 0.0])];
    let Some(made) = cut(&op(chain, rows)) else { return };
    let pieces = made["pieces"].as_array().expect("pieces");
    assert_eq!(pieces.len(), 2);
    for piece in pieces {
        whole(piece);
    }
    // Below the chain: 60 × 30 and the wedge over U −15 to 15, which is 30 × 4 on average, all 20 mm along V.
    let low = 20.0 * (60.0 * 30.0 + 30.0 * 4.0);
    let mut volumes = pieces.iter().map(volume).collect::<Vec<_>>();
    volumes.sort_by(f64::total_cmp);
    within(volumes[0], WHOLE - low - each_hole(), 1e-6);
    within(volumes[1], low - each_hole(), 1e-6);
    let normal = [(40.0 / length), (8.0 / length), 0.0];
    for piece in pieces {
        holes_on(piece, &[[60.0 + 4.0 * 1.0, 15.0, 10.0]], [normal[0], -normal[1], 0.0]);
    }
}

#[test]
fn a_dowel_that_misses_every_flat_is_left_out_in_a_sentence() {
    // The first flat of this lap stops at the step (V = 0); a dowel on it at V = 5 is past the face, over the riser.
    let lap = json!({ "kind": "lap", "depth": 6.0, "height": 10.0, "side": "positive", "at": 0.0 });
    let Some(made) = cut(&op(lap, vec![on_flat(1, [0.0, 0.0, 0.0], [0.0, 5.0])])) else { return };
    let dropped = made["connectors"]["dropped"].as_array().expect("dropped");
    assert_eq!(dropped.len(), 1, "{made}");
    assert_eq!(made["connectors"]["placed"], json!([]));
}

/// A dowel of radius 1.5 mm, 8 mm long, beside a tongue or a dovetail: its hole is 1.65 mm across and 4.4 mm deep in each piece.
fn small_op(profile: Value, placed: Vec<Value>) -> String {
    let mut op: Value = serde_json::from_str(&op(profile, placed)).expect("JSON");
    op["cuts"][0]["connectors"]["types"][0]["radius"] = json!(1.5);
    op["cuts"][0]["connectors"]["types"][0]["margin"] = json!(2.0);
    op.to_string()
}

fn small_hole() -> f64 {
    PI * 1.65 * 1.65 * (4.0 + 0.4)
}

/// The piece has a hole of 1.65 mm along the cut's normal at each of `heights` (z), at y = 15, and no other.
fn holes_at(piece: &Value, heights: &[f64]) {
    let found = cylinders(piece, 1.65);
    assert_eq!(found.len(), heights.len(), "{piece}");
    for (at, axis) in found {
        let nearest = heights
            .iter()
            .map(|z| off(at, axis, [60.0, 15.0, *z], [1.0, 0.0, 0.0]))
            .min_by(|a, b| a.0.total_cmp(&b.0))
            .expect("a height");
        assert!(nearest.0 < 1e-6 && nearest.1 < 1e-9, "a hole is {} mm off, turned {}", nearest.0, nearest.1);
    }
}

fn tongue() -> Value {
    json!({ "kind": "tongue", "width": 6.0, "depth": 3.0, "clearance": 0.15, "endGap": 0.4, "side": "positive",
        "u0": -10.0, "u1": 10.0, "v": 0.0 })
}

#[test]
fn a_tongue_takes_a_dowel_on_the_flat_each_side_of_it() {
    // The tongue runs along U (y 5 to 25) and is 6 mm across V (z 7 to 13); its groove is 6.3 mm across. The flats beside it
    // are z 0 to 6.85 and 13.15 to 20 on the plane x = 60, and a dowel sits on each, at V −6.5 and 6.5.
    let rows = vec![on_flat(1, [0.0, 0.0, 0.0], [0.0, -6.5]), on_flat(2, [0.0, 0.0, 0.0], [0.0, 6.5])];
    let Some(made) = cut(&small_op(tongue(), rows)) else { return };
    let pieces = made["pieces"].as_array().expect("pieces");
    assert_eq!(pieces.len(), 2);
    for piece in pieces {
        whole(piece);
    }
    assert_eq!(made["connectors"]["dropped"], json!([]), "{made}");
    within(volume(&pieces[1]), WHOLE / 2.0 + 6.0 * 3.0 * 20.0 - 2.0 * small_hole(), 1e-6);
    within(volume(&pieces[0]), WHOLE / 2.0 - 6.3 * 3.4 * 20.3 - 2.0 * small_hole(), 1e-6);
    for piece in pieces {
        holes_at(piece, &[3.5, 16.5]);
    }
    assert_eq!(made["pins"]["solids"], json!(2));
}

#[test]
fn a_dovetail_takes_a_dowel_on_the_flat_each_side_of_it() {
    // The dovetail slides along U for the whole section; across V its groove reaches 4.31 mm from the middle at its widest.
    let dovetail = json!({ "kind": "dovetail", "width": 8.0, "angle": 20.0, "depth": 3.0, "slide": "u", "side": "positive",
        "clearance": 0.15, "endGap": 0.4, "u0": -15.0, "u1": 15.0, "v": 0.0 });
    let rows = vec![on_flat(1, [0.0, 0.0, 0.0], [0.0, -7.0]), on_flat(2, [0.0, 0.0, 0.0], [0.0, 7.0])];
    let Some(made) = cut(&small_op(dovetail, rows)) else { return };
    let pieces = made["pieces"].as_array().expect("pieces");
    assert_eq!(pieces.len(), 2);
    for piece in pieces {
        whole(piece);
    }
    assert_eq!(made["connectors"]["dropped"], json!([]), "{made}");
    let lean = 20.0_f64.to_radians().tan();
    let root = 4.0 - 3.0 * lean;
    let peg = (2.0 * root + 8.0) / 2.0 * 3.0;
    let grow = 0.15 / 20.0_f64.to_radians().cos();
    let groove = 2.0 * (root + grow) * 3.4 + lean * 3.4 * 3.4;
    within(volume(&pieces[1]), WHOLE / 2.0 + 30.0 * peg - 2.0 * small_hole(), 1e-5);
    within(volume(&pieces[0]), WHOLE / 2.0 - 30.0 * groove - 2.0 * small_hole(), 1e-5);
    for piece in pieces {
        holes_at(piece, &[3.0, 17.0]);
    }
    assert_eq!(made["pins"]["solids"], json!(2));
}

#[test]
fn a_dowel_that_reaches_into_the_groove_is_left_out() {
    // At V = 3 the 1.65 mm hole crosses the groove's edge at 3.15: the cut does not take exactly the hole's volume.
    let Some(made) = cut(&small_op(tongue(), vec![on_flat(1, [0.0, 0.0, 0.0], [0.0, 3.0])])) else { return };
    let dropped = made["connectors"]["dropped"].as_array().expect("dropped");
    assert_eq!(dropped.len(), 1, "{made}");
    assert_eq!(made["connectors"]["placed"], json!([]));
}
