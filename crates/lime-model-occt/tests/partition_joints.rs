//! Split to print, milestone 5: dowels, plugs and hardware holes on the real solids (plan sections 7, 8, 9 and 14).
//! Volumes against π r² h, radii from `Geom_CylindricalSurface`, coaxial holes, the teardrop's 45° roof, and the
//! connectors that are left out. `LIME_REQUIRE_OCCT=1` makes a missing kernel a failure.

use std::f64::consts::PI;

use serde_json::{json, Value};

/// The bar every case cuts: 120 × 30 × 20 mm from the origin, cut across X at 60 mm, U along Y, so V is Z.
const BAR: [f64; 3] = [120.0, 30.0, 20.0];
const PART: f64 = 120.0 * 30.0 * 20.0;
const CENTRE: [f64; 3] = [60.0, 15.0, 10.0];
const CHAMFER: f64 = 0.5;

fn bar() -> String {
    json!({ "primitive": "box", "origin": [0.0, 0.0, 0.0], "size": BAR }).to_string()
}

fn dowel(hole: &str) -> Value {
    json!({ "type": "dowel", "radius": 3.0, "depth": 8.0, "clearance": 0.15, "endGap": 0.4, "hole": hole,
        "count": "fit", "margin": 5.0, "place": "fit", "at": [] })
}

fn placed(kind: &str, at: &[[f64; 2]]) -> Value {
    Value::Array(
        at.iter()
            .enumerate()
            .map(|(index, fraction)| {
                json!({ "id": format!("c1-{}", index + 1), "type": kind, "uvMm": [0.0, 0.0], "fraction": fraction,
                    "fixed": false })
            })
            .collect(),
    )
}

fn op(spec: Value, placed: Value, up: [f64; 3]) -> String {
    json!({
        "kind": "partition",
        "cuts": [{ "origin": [60.0, 15.0, 10.0], "normal": [1.0, 0.0, 0.0], "u": [0.0, 1.0, 0.0],
            "profile": { "kind": "straight" },
            "connectors": { "on": true, "types": [spec], "placed": placed } }],
        "up": up,
        "target": { "printer": "lime-220", "process": "fdm", "volumeMm": [220.0, 220.0, 250.0] },
        "orient": "keep",
        "arrange": true,
        "labels": { "on": false },
        "bedMarginMm": 5.0,
        "maxPieces": 12.0,
    })
    .to_string()
}

/// The cut, or None without the kernel.
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

fn volume(part: &Value) -> f64 {
    part["volumeMm3"].as_f64().expect("volumeMm3")
}

fn whole(part: &Value) {
    assert_eq!(part["valid"], json!(true), "{part}");
    assert_eq!(part["closed"], json!(true), "{part}");
}

fn vec3(value: &Value) -> [f64; 3] {
    let list = value.as_array().expect("three numbers");
    [0, 1, 2].map(|i| list[i].as_f64().expect("a number"))
}

/// Every cylinder of a shape: its radius, a point on its axis, and the axis.
fn cylinders(part: &Value) -> Vec<(f64, [f64; 3], [f64; 3])> {
    part["surfaces"]
        .as_array()
        .expect("surfaces")
        .iter()
        .filter(|face| face["kind"] == "cylinder")
        .map(|face| {
            (
                face["radius"].as_f64().expect("radius"),
                vec3(&face["at"]),
                vec3(&face["axis"]),
            )
        })
        .collect()
}

/// How far the axis through `at` along `axis` passes from the line through `CENTRE` along X, and how far it turns.
fn off_axis(at: [f64; 3], axis: [f64; 3]) -> (f64, f64) {
    let d = [at[0] - CENTRE[0], at[1] - CENTRE[1], at[2] - CENTRE[2]];
    (d[1].hypot(d[2]), 1.0 - axis[0].abs())
}

fn coaxial(part: &Value, radius: f64) {
    let found: Vec<_> = cylinders(part)
        .into_iter()
        .filter(|(r, _, _)| (r - radius).abs() < 1e-6)
        .collect();
    assert!(!found.is_empty(), "no cylinder of {radius} mm in {part}");
    for (_, at, axis) in found {
        let (away, turn) = off_axis(at, axis);
        assert!(
            away < 1e-6 && turn < 1e-6,
            "the axis is {away} mm off, turned {turn}"
        );
    }
}

/// A chamfered pin: the cylinder less the ring each chamfer takes, π c² (r − c/3) by Pappus.
fn pin_volume(radius: f64, length: f64) -> f64 {
    PI * radius * radius * length - 2.0 * PI * CHAMFER * CHAMFER * (radius - CHAMFER / 3.0)
}

#[test]
fn dowel_holes_in_both_pieces_and_the_pin_as_its_own_solid() {
    let Some(made) = cut(&op(
        dowel("round"),
        placed("dowel", &[[0.5, 0.5]]),
        [0.0, 0.0, 1.0],
    )) else {
        return;
    };
    let pieces = made["pieces"].as_array().expect("pieces");
    assert_eq!(pieces.len(), 2);
    let hole = 3.15;
    let each = PI * hole * hole * (4.0 + 0.4);
    for piece in pieces {
        whole(piece);
        within(volume(piece), PART / 2.0 - each, 1e-6);
        coaxial(piece, hole);
    }
    let pins = &made["pins"];
    whole(pins);
    assert_eq!(pins["solids"], json!(1));
    within(volume(pins), pin_volume(3.0, 8.0), 1e-6);
    let pin = cylinders(pins);
    assert_eq!(pin.len(), 1, "{pins}");
    // The hole radius less the pin radius is the clearance.
    for piece in pieces {
        for (radius, _, _) in cylinders(piece) {
            within(radius - pin[0].0, 0.15, 1e-9);
        }
    }
    // The pin stands along up, on the floor the part stands on, beside the part.
    assert!(pin[0].2[2].abs() > 1.0 - 1e-9, "{:?}", pin[0].2);
    assert_eq!(made["connectors"]["placed"][0]["id"], json!("c1-1"));
    assert_eq!(made["connectors"]["dropped"], json!([]));
    assert_eq!(
        made["op"]["cuts"][0]["connectors"]["placed"]
            .as_array()
            .map(Vec::len),
        Some(1)
    );
}

#[test]
fn two_dowels_make_two_pins() {
    let Some(made) = cut(&op(
        dowel("round"),
        placed("dowel", &[[0.25, 0.5], [0.75, 0.5]]),
        [0.0, 0.0, 1.0],
    )) else {
        return;
    };
    let hole = 3.15;
    let each = PI * hole * hole * (4.0 + 0.4);
    for piece in made["pieces"].as_array().expect("pieces") {
        whole(piece);
        within(volume(piece), PART / 2.0 - 2.0 * each, 1e-6);
    }
    let pins = &made["pins"];
    assert_eq!(pins["solids"], json!(2));
    let volumes = pins["each"].as_array().expect("each pin");
    assert_eq!(volumes.len(), 2);
    for one in volumes {
        within(one.as_f64().expect("volume"), pin_volume(3.0, 8.0), 1e-6);
    }
}

#[test]
fn a_plug_and_its_socket() {
    let plug = json!({ "type": "plug", "radius": 3.0, "depth": 6.0, "clearance": 0.15, "endGap": 0.4, "hole": "round",
        "side": "positive", "count": "fit", "margin": 5.0, "place": "fit", "at": [] });
    let Some(made) = cut(&op(plug, placed("plug", &[[0.5, 0.5]]), [0.0, 0.0, 1.0])) else {
        return;
    };
    let pieces = made["pieces"].as_array().expect("pieces");
    let (socket_side, plug_side) = (&pieces[0], &pieces[1]);
    whole(socket_side);
    whole(plug_side);
    within(volume(plug_side), PART / 2.0 + PI * 9.0 * 6.0, 1e-6);
    within(
        volume(socket_side),
        PART / 2.0 - PI * 3.15 * 3.15 * 6.4,
        1e-6,
    );
    coaxial(plug_side, 3.0);
    coaxial(socket_side, 3.15);
    within(
        cylinders(socket_side)[0].0 - cylinders(plug_side)[0].0,
        0.15,
        1e-9,
    );
    assert!(made["pins"].is_null(), "a plug makes no pin");
}

#[test]
fn a_hardware_hole_makes_no_pin() {
    let hardware = json!({ "type": "hardware", "diameter": 4.0, "depth": 10.0, "clearance": 0.1, "endGap": 0.4,
        "count": "fit", "margin": 5.0, "place": "fit", "at": [] });
    let Some(made) = cut(&op(
        hardware,
        placed("hardware", &[[0.5, 0.5]]),
        [0.0, 0.0, 1.0],
    )) else {
        return;
    };
    for piece in made["pieces"].as_array().expect("pieces") {
        whole(piece);
        within(volume(piece), PART / 2.0 - PI * 2.1 * 2.1 * 5.4, 1e-6);
        coaxial(piece, 2.1);
    }
    assert!(made["pins"].is_null());
}

/// The roof's two flat faces of a teardrop hole: their outward normals, which point into the hole.
fn roof(part: &Value) -> Vec<[f64; 3]> {
    part["surfaces"]
        .as_array()
        .expect("surfaces")
        .iter()
        .filter(|face| face["kind"] == "plane")
        .map(|face| vec3(&face["normal"]))
        .filter(|n| n[0].abs() < 1e-9 && n[1].abs() > 1e-3 && n[2].abs() > 1e-3)
        .collect()
}

#[test]
fn a_hole_on_its_side_is_a_teardrop_on_fdm_and_round_for_resin() {
    let Some(made) = cut(&op(
        dowel("teardrop"),
        placed("dowel", &[[0.5, 0.5]]),
        [0.0, 0.0, 1.0],
    )) else {
        return;
    };
    let hole = 3.15;
    let area = (0.75 * PI + 1.0) * hole * hole;
    let half = std::f64::consts::FRAC_1_SQRT_2;
    for piece in made["pieces"].as_array().expect("pieces") {
        whole(piece);
        within(volume(piece), PART / 2.0 - area * 4.4, 1e-6);
        let faces = roof(piece);
        assert_eq!(faces.len(), 2, "{piece}");
        for n in faces {
            // 45° from up, on either side, and the roof points up: the faces look down into the hole.
            within(n[2], -half, 1e-6);
            within(n[1].abs(), half, 1e-6);
        }
        coaxial(piece, hole);
    }
    assert_eq!(made["connectors"]["placed"][0]["teardrop"], json!(true));

    // The resin row asks for a round hole: no roof.
    let Some(round) = cut(&op(
        dowel("round"),
        placed("dowel", &[[0.5, 0.5]]),
        [0.0, 0.0, 1.0],
    )) else {
        return;
    };
    for piece in round["pieces"].as_array().expect("pieces") {
        assert!(roof(piece).is_empty(), "{piece}");
    }
    assert_eq!(round["connectors"]["placed"][0]["teardrop"], json!(false));

    // Standing on the cut, the hole's axis is vertical: no roof either, though a teardrop was asked for.
    let Some(upright) = cut(&op(
        dowel("teardrop"),
        placed("dowel", &[[0.5, 0.5]]),
        [1.0, 0.0, 0.0],
    )) else {
        return;
    };
    for piece in upright["pieces"].as_array().expect("pieces") {
        within(volume(piece), PART / 2.0 - PI * hole * hole * 4.4, 1e-6);
    }
    assert_eq!(upright["connectors"]["placed"][0]["teardrop"], json!(false));
}

#[test]
fn a_dowel_that_would_break_through_is_left_out_and_named() {
    let Some(made) = cut(&op(
        dowel("round"),
        placed("dowel", &[[0.5, 0.5], [0.02, 0.5]]),
        [0.0, 0.0, 1.0],
    )) else {
        return;
    };
    let each = PI * 3.15 * 3.15 * 4.4;
    for piece in made["pieces"].as_array().expect("pieces") {
        whole(piece);
        within(volume(piece), PART / 2.0 - each, 1e-6);
    }
    assert_eq!(made["connectors"]["dropped"][0]["id"], json!("c1-2"));
    assert_eq!(made["connectors"]["dropped"][0]["reason"], json!("breaks"));
    assert_eq!(
        made["notes"],
        json!(["Cut 1: dowel 2 would break through the outline or a neighbour. It was left out."])
    );
    let kept = &made["op"]["cuts"][0]["connectors"]["placed"];
    assert_eq!(kept.as_array().map(Vec::len), Some(1));
    assert_eq!(kept[0]["id"], json!("c1-1"));
    assert_eq!(made["pins"]["solids"], json!(1));
}

#[test]
fn every_connector_dropped_makes_a_plain_cut() {
    let mut outside = placed("dowel", &[[0.02, 0.5]]);
    outside.as_array_mut().expect("placed").push(
        json!({ "id": "c1-2", "type": "dowel", "uvMm": [100.0, 100.0], "fraction": null, "fixed": true }),
    );
    let Some(made) = cut(&op(dowel("round"), outside, [0.0, 0.0, 1.0])) else {
        return;
    };
    for piece in made["pieces"].as_array().expect("pieces") {
        whole(piece);
        within(volume(piece), PART / 2.0, 1e-6);
        assert!(cylinders(piece).is_empty());
    }
    assert!(made["pins"].is_null());
    assert_eq!(
        made["notes"],
        json!([
            "Cut 1: dowel 1 would break through the outline or a neighbour. It was left out.",
            "Cut 1: dowel 2 lies outside the section. It was left out.",
            "Cut 1: no dowel fits. It is a plain cut."
        ])
    );
    assert_eq!(made["op"]["cuts"][0]["connectors"]["placed"], json!([]));
}
