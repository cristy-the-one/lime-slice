//! Split to print, milestone 6: the fit coupons on the real kernel (plan sections 2 and 14). The layouts are the planner's
//! (`src/modeling/fit-coupon.ts`), written to `tests/fit_coupon/*.json` by `LIME_WRITE_FIXTURES=1 node
//! --experimental-strip-types src/modeling/fit-coupon.test.ts`, which also fails when they drift. Each coupon must be
//! closed, valid solids with the holes' radii from `Geom_CylindricalSurface` within 1e-9 mm, labels that keep clear of the
//! holes, and pins that match. `LIME_REQUIRE_OCCT=1` makes a missing kernel a failure.

use std::f64::consts::PI;

use serde_json::{json, Value};

const FDM_PETG: &str = include_str!("fit_coupon/fdm-petg.json");
const RESIN: &str = include_str!("fit_coupon/resin.json");
const CHAMFER: f64 = 0.5;

/// The gap each side of each hole, as the planner labels them: PETG's Snug is 0.20, resin's 0.10.
const PETG_GAPS: [f64; 7] = [0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40];
const RESIN_GAPS: [f64; 7] = [0.00, 0.05, 0.10, 0.15, 0.20, 0.25, 0.30];

fn spec(text: &str) -> Value {
    serde_json::from_str(text).expect("the fixture is JSON")
}

/// The coupon, or None without the kernel.
fn build(spec: &Value) -> Option<Value> {
    match lime_model_occt::fit_coupon(&spec.to_string()) {
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

fn number(value: &Value) -> f64 {
    value.as_f64().expect("a number")
}

fn vec3(value: &Value) -> [f64; 3] {
    let list = value.as_array().expect("three numbers");
    [0, 1, 2].map(|i| number(&list[i]))
}

/// Every cylinder of a shape: its radius, a point on its axis, and the axis.
fn cylinders(shape: &Value) -> Vec<(f64, [f64; 3], [f64; 3])> {
    shape["surfaces"]
        .as_array()
        .expect("surfaces")
        .iter()
        .filter(|face| face["kind"] == "cylinder")
        .map(|face| {
            (
                number(&face["radius"]),
                vec3(&face["at"]),
                vec3(&face["axis"]),
            )
        })
        .collect()
}

fn whole(shape: &Value) {
    assert_eq!(shape["valid"], json!(true), "{shape:.200}");
    assert_eq!(shape["closed"], json!(true), "{shape:.200}");
}

/// A chamfered pin: the cylinder less the ring each chamfer takes, π c² (r − c/3) by Pappus.
fn pin_volume(radius: f64, length: f64) -> f64 {
    PI * radius * radius * length - 2.0 * PI * CHAMFER * CHAMFER * (radius - CHAMFER / 3.0)
}

/// The roof's flat faces of a teardrop: planes parallel to the bore (Y) whose normal is 45° from up, above `axis_z`. The
/// labels' diagonal strokes make 45° faces too, all of them below the holes.
fn roofs(shape: &Value, axis_z: f64) -> Vec<[f64; 3]> {
    shape["surfaces"]
        .as_array()
        .expect("surfaces")
        .iter()
        .filter(|face| face["kind"] == "plane" && vec3(&face["at"])[2] > axis_z)
        .map(|face| vec3(&face["normal"]))
        .filter(|n| n[1].abs() < 1e-9 && n[0].abs() > 1e-3 && n[2].abs() > 1e-3)
        .collect()
}

/// The volume one hole takes out: its section times its depth. A teardrop's section is the circle and the kite of the two
/// tangents from the apex r√2, (¾π + 1) r² in all.
fn hole_volume(radius: f64, depth: f64, teardrop: bool) -> f64 {
    let area = if teardrop {
        (0.75 * PI + 1.0) * radius * radius
    } else {
        PI * radius * radius
    };
    area * depth
}

/// The coupon checked end to end against its layout: closed valid solids, each hole's radius and axis from its
/// cylinder, the pins, the volume by hand, and the plate's box.
fn check(layout: &Value, gaps: &[f64; 7], teardrop: bool) -> Value {
    let Some(made) = build(layout) else {
        return Value::Null;
    };
    let plate = &made["plate"];
    whole(plate);
    assert_eq!(plate["solids"], json!(1), "one plate");

    let size = vec3(&layout["sizeMm"]);
    let bounds = plate["bounds"].as_array().expect("bounds");
    for axis in 0..3 {
        within(number(&bounds[axis]), 0.0, 1e-6);
        within(number(&bounds[axis + 3]), size[axis], 1e-6);
    }

    // Each hole is one cylinder of the pin's radius plus its gap, on its own axis along Y.
    let pin_radius = number(&layout["pins"][0]["radiusMm"]);
    let holes = layout["holes"].as_array().expect("holes");
    assert_eq!(holes.len(), 7);
    let found = cylinders(plate);
    assert_eq!(found.len(), holes.len(), "one cylinder face for each hole");
    for (at, hole) in holes.iter().enumerate() {
        let radius = number(&hole["radiusMm"]);
        // The hole's radius less the pin's is the gap its label says, to 1e-9.
        within(radius - pin_radius, gaps[at], 1e-9);
        let (x, z) = (number(&hole["x"]), number(&hole["z"]));
        let on_axis: Vec<_> = found
            .iter()
            .filter(|(r, at, axis)| {
                (r - radius).abs() < 1e-9
                    && (at[0] - x).abs() < 1e-6
                    && (at[2] - z).abs() < 1e-6
                    && axis[1].abs() > 1.0 - 1e-9
            })
            .collect();
        assert_eq!(
            on_axis.len(),
            1,
            "hole {at}: radius {radius} at ({x}, {z}) in {found:?}"
        );
        within(on_axis[0].0, radius, 1e-9);
    }

    // The teardrop's roof: two flat faces at 45° for each hole on FDM, none on resin.
    let roof = roofs(plate, number(&holes[0]["z"]));
    if teardrop {
        assert_eq!(roof.len(), 2 * holes.len());
        for n in roof {
            within(n[2], -std::f64::consts::FRAC_1_SQRT_2, 1e-6);
            within(n[0].abs(), std::f64::consts::FRAC_1_SQRT_2, 1e-6);
        }
    } else {
        assert!(roof.is_empty(), "a resin hole stays round");
    }

    // The volume: the plate less every hole, less what the labels took.
    let strokes: Vec<[f64; 4]> =
        serde_json::from_value(layout["strokes"].clone()).expect("strokes");
    let (width, depth) = (number(&layout["strokeMm"]), number(&layout["engraveMm"]));
    let engraved = number(&made["engravedMm3"]);
    let stroke_sum: f64 = strokes.iter().map(|s| s[2] * width * depth).sum();
    assert!(
        engraved > 0.5 * stroke_sum && engraved <= stroke_sum + 1e-9,
        "{engraved} of {stroke_sum}"
    );
    let bored: f64 = holes
        .iter()
        .map(|hole| {
            hole_volume(
                number(&hole["radiusMm"]),
                number(&hole["depthMm"]),
                teardrop,
            )
        })
        .sum();
    within(
        number(&plate["volumeMm3"]),
        size[0] * size[1] * size[2] - bored - engraved,
        1e-6,
    );

    // The pins: chamfered cylinders of the dowel's radius and length, standing on z = 0.
    let pins = &made["pins"];
    whole(pins);
    let pin_specs = layout["pins"].as_array().expect("pins");
    assert_eq!(pins["solids"], json!(pin_specs.len()));
    for one in pins["each"].as_array().expect("each") {
        within(
            number(one),
            pin_volume(pin_radius, number(&pin_specs[0]["lengthMm"])),
            1e-6,
        );
    }
    let across = cylinders(pins);
    assert_eq!(across.len(), pin_specs.len());
    for (radius, _, axis) in across {
        within(radius, pin_radius, 1e-9);
        assert!(axis[2].abs() > 1.0 - 1e-9, "a pin stands along Z: {axis:?}");
    }
    let pin_bounds = pins["bounds"].as_array().expect("bounds");
    within(number(&pin_bounds[2]), 0.0, 1e-6);
    within(
        number(&pin_bounds[5]),
        number(&pin_specs[0]["lengthMm"]),
        1e-6,
    );
    assert!(
        number(&pin_bounds[1]) > size[1],
        "the pins stand beside the plate, past its back"
    );
    made
}

#[test]
fn the_fdm_coupon_is_valid_with_teardrop_holes_of_the_labelled_radii() {
    check(&spec(FDM_PETG), &PETG_GAPS, true);
}

#[test]
fn the_resin_coupon_is_valid_with_round_holes_of_the_labelled_radii() {
    check(&spec(RESIN), &RESIN_GAPS, false);
}

/// The labels leave the holes alone: the volume they take is the same on a plate with one hole as on the whole coupon,
/// so no stroke reaches another hole's wall.
#[test]
fn the_labels_stay_clear_of_the_holes() {
    for (text, teardrop) in [(FDM_PETG, true), (RESIN, false)] {
        let full = spec(text);
        let Some(made) = build(&full) else {
            return;
        };
        let with_all = number(&made["engravedMm3"]);
        // The same strokes on a plate with only the first hole: if any label touched a hole, the volume would differ.
        let mut one = full.clone();
        one["holes"] = json!([full["holes"][0].clone()]);
        let alone = number(&build(&one).expect("kernel")["engravedMm3"]);
        within(with_all, alone, 1e-6);
        // Every stroke corner is also more than a millimetre from every hole's wall, the roof's reach included.
        let strokes: Vec<[f64; 4]> =
            serde_json::from_value(full["strokes"].clone()).expect("strokes");
        let width = number(&full["strokeMm"]);
        for hole in full["holes"].as_array().expect("holes") {
            let (x, z, r) = (
                number(&hole["x"]),
                number(&hole["z"]),
                number(&hole["radiusMm"]),
            );
            for s in &strokes {
                let a = s[3].to_radians();
                let along = [a.cos() * s[2] / 2.0, a.sin() * s[2] / 2.0];
                let across = [-a.sin() * width / 2.0, a.cos() * width / 2.0];
                for (p, q) in [(-1.0, -1.0), (1.0, -1.0), (1.0, 1.0), (-1.0, 1.0)] {
                    let corner = [
                        s[0] + p * along[0] + q * across[0],
                        s[1] + p * along[1] + q * across[1],
                    ];
                    let reach = if teardrop && corner[1] > z {
                        r * std::f64::consts::SQRT_2
                    } else {
                        r
                    };
                    assert!(
                        (corner[0] - x).hypot(corner[1] - z) > reach + 1.0,
                        "a stroke corner {corner:?} is within 1 mm of the hole at ({x}, {z})"
                    );
                }
            }
        }
    }
}

/// More than one pin is one compound of separate solids, each the same chamfered cylinder.
#[test]
fn two_pins_are_two_solids_of_the_same_volume() {
    let mut layout = spec(RESIN);
    let first = layout["pins"][0].clone();
    let mut second = first.clone();
    second["x"] = json!(number(&first["x"]) + 10.0);
    layout["pins"] = json!([first, second]);
    let Some(made) = build(&layout) else {
        return;
    };
    let pins = &made["pins"];
    whole(pins);
    assert_eq!(pins["solids"], json!(2));
    let each = pins["each"].as_array().expect("each");
    assert_eq!(each.len(), 2);
    for one in each {
        within(number(one), pin_volume(3.0, 4.0), 1e-6);
    }
    within(number(&pins["volumeMm3"]), 2.0 * pin_volume(3.0, 4.0), 1e-6);
}

#[test]
fn a_hole_that_leaves_the_plate_is_refused_in_a_sentence() {
    let mut layout = spec(RESIN);
    layout["holes"][0]["x"] = json!(1.0);
    let Err(message) = lime_model_occt::fit_coupon(&layout.to_string()) else {
        panic!("a hole through the plate's edge was built");
    };
    if message.contains("OCCT_ROOT") {
        return;
    }
    assert_eq!(message, "The coupon's hole 1 reaches outside the plate");
    let mut deep = spec(RESIN);
    deep["holes"][0]["depthMm"] = json!(50.0);
    let Err(message) = lime_model_occt::fit_coupon(&deep.to_string()) else {
        panic!("a hole through the plate was built");
    };
    assert_eq!(message, "The coupon's hole 1 reaches outside the plate");
    let mut none = spec(RESIN);
    none["holes"] = json!([]);
    let Err(message) = lime_model_occt::fit_coupon(&none.to_string()) else {
        panic!("a coupon with no hole was built");
    };
    assert_eq!(message, "The coupon needs at least one hole");
}
