//! Split to print, profile shift (plan section 32): a shaped profile slid along its cut, and the rule that no piece keeps
//! a wall under the floor, on the real solids. Synthetic parts only: a thin-walled box, a box with ribs, a bar with a hole
//! near the cut. The numbers are the planner's (`src/modeling/profile-shift.test.ts` checks it chooses them): where a
//! zig-zag's period starts at shift 0 and on Auto, the chain it stores when no shift clears every wall, and where Auto puts
//! a tongue. `LIME_REQUIRE_OCCT=1` makes a missing kernel a failure.

use serde_json::{json, Value};

/// The planner's floor for a 0.4 mm nozzle: two beads.
const FLOOR: f64 = 0.8;

/// A box from the origin, less boxes along X through it.
fn part(size: [f64; 3], holes: &[([f64; 3], [f64; 3])]) -> String {
    let before: Vec<Value> = holes
        .iter()
        .map(|(origin, size)| json!({ "kind": "boolean", "op": "cut", "primitive": "box", "origin": origin, "size": size }))
        .collect();
    json!({ "primitive": "box", "origin": [0.0, 0.0, 0.0], "size": size, "before": before })
        .to_string()
}

/// The thin-walled box: 120 × 30.9 × 20 mm, walls 1.2 mm, open along X.
fn tube() -> String {
    part(
        [120.0, 30.9, 20.0],
        &[([-1.0, 1.2, 1.2], [122.0, 28.5, 17.6])],
    )
}

const TUBE: f64 = 120.0 * 30.9 * 20.0 - 120.0 * 28.5 * 17.6;

/// Five walls 1.2 mm thick, 6.2 mm apart along Y, so a 10 mm zig-zag lays a flank in one of them at every shift.
fn ribs() -> String {
    let cell = |y: f64| ([-1.0, y, 1.2], [122.0, 5.0, 17.6]);
    part(
        [120.0, 26.0, 20.0],
        &[cell(1.2), cell(7.4), cell(13.6), cell(19.8)],
    )
}

const RIBS: f64 = 120.0 * 26.0 * 20.0 - 4.0 * 120.0 * 5.0 * 17.6;

/// A bar 120 × 30 × 20 with a hole along X, from y 5 to 25 and z 11.5 to 14.5: just above where a tongue sits.
fn holed() -> String {
    part(
        [120.0, 30.0, 20.0],
        &[([-1.0, 5.0, 11.5], [122.0, 20.0, 3.0])],
    )
}

const HOLED: f64 = 120.0 * 30.0 * 20.0 - 120.0 * 20.0 * 3.0;

/// The op the planner stores: one cut across X at 60, U along Y from `centre_y`, so V is Z.
fn op(centre_y: f64, profile: Value) -> String {
    json!({
        "kind": "partition",
        "cuts": [{ "origin": [60.0, centre_y, 10.0], "normal": [1.0, 0.0, 0.0], "u": [0.0, 1.0, 0.0],
            "profile": profile, "connectors": { "on": false } }],
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

fn cut(solid: &str, op: &str) -> Option<Value> {
    match lime_model_occt::partition_joints(solid, op) {
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

/// Two closed, valid pieces whose volumes sum to `whole`.
fn two_pieces(made: &Value, whole: f64) -> Vec<Value> {
    let pieces = made["pieces"].as_array().expect("pieces").clone();
    assert_eq!(pieces.len(), 2, "{made}");
    for piece in &pieces {
        assert_eq!(piece["valid"], json!(true), "{piece}");
        assert_eq!(piece["closed"], json!(true), "{piece}");
        assert_eq!(piece["solids"], json!(1), "{piece}");
    }
    within(pieces.iter().map(volume).sum(), whole, 1e-4);
    pieces
}

/// The flat faces of a piece square to Y: (y, outward normal along Y).
fn across_y(piece: &Value) -> Vec<(f64, f64)> {
    piece["surfaces"]
        .as_array()
        .expect("surfaces")
        .iter()
        .filter(|face| face["kind"] == "plane")
        .filter_map(|face| {
            let n = face["normal"].as_array()?;
            let ny = n[1].as_f64()?;
            ((ny.abs() - 1.0).abs() < 1e-9).then(|| (face["at"][1].as_f64().unwrap(), ny))
        })
        .collect()
}

/// The thinnest wall along Y in either piece: from a face looking −Y to the nearest face past it looking +Y. On these
/// parts every wall is a slab between two such faces.
fn thinnest_along_y(pieces: &[Value]) -> f64 {
    let mut thinnest = f64::INFINITY;
    for piece in pieces {
        let faces = across_y(piece);
        for (low, _) in faces.iter().filter(|(_, n)| *n < 0.0) {
            for (high, _) in faces.iter().filter(|(_, n)| *n > 0.0) {
                if *high > low + 1e-6 {
                    thinnest = thinnest.min(high - low);
                }
            }
        }
    }
    thinnest
}

fn zigzag(u0: f64) -> Value {
    json!({ "kind": "zigzag", "pitch": 10.0, "depth": 3.0, "angle": 0.0, "side": "positive", "u0": u0 })
}

#[test]
fn a_zig_zag_at_shift_0_leaves_a_sliver_in_the_thin_walled_box_and_auto_does_not() {
    let Some(made) = cut(&tube(), &op(15.45, zigzag(-15.45))) else {
        return;
    };
    let pieces = two_pieces(&made, TUBE);
    // A flank 30 mm from the box's side lies 0.3 mm inside the far wall's inner face.
    within(thinnest_along_y(&pieces), 0.3, 1e-6);
    // Auto slides the teeth 9.6 mm (the period starts at −15.45 + 9.6): every flank misses both walls.
    let made = cut(&tube(), &op(15.45, zigzag(-15.45 + 9.6))).expect("kernel");
    let pieces = two_pieces(&made, TUBE);
    let thinnest = thinnest_along_y(&pieces);
    println!("thin-walled box, Auto: thinnest wall {thinnest:.4} mm");
    assert!(thinnest >= FLOOR, "{thinnest}");
    within(thinnest, 1.2, 1e-6);
}

/// The planner's changed zig-zag for the thin-walled box at shift 0: the tooth whose flank lay in the wall is flattened.
fn tube_chain() -> Value {
    let to = [
        [-20.45, 0.0],
        [-20.45, 3.0],
        [-15.45, 3.0],
        [-15.45, 0.0],
        [-10.45, 0.0],
        [-10.45, 3.0],
        [-5.45, 3.0],
        [-5.45, 0.0],
        [-0.45, 0.0],
        [-0.45, 3.0],
        [4.55, 3.0],
        [4.55, 0.0],
        [19.55, 0.0],
        [19.55, 3.0],
        [24.55, 3.0],
        [24.55, 0.0],
        [29.55, 0.0],
        [29.55, 3.0],
        [34.55, 3.0],
        [34.55, 0.0],
        [39.55, 0.0],
        [39.55, 3.0],
        [44.55, 3.0],
        [44.55, 0.0],
        [49.55, 0.0],
    ];
    let chain: Vec<Value> = to
        .iter()
        .map(|p| json!({ "kind": "line", "to": p }))
        .collect();
    let mut profile = zigzag(-15.45);
    profile["start"] = json!([-25.45, 0.0]);
    profile["chain"] = json!(chain);
    profile
}

#[test]
fn a_zig_zag_with_its_tooth_flattened_keeps_every_wall() {
    let Some(made) = cut(&tube(), &op(15.45, tube_chain())) else {
        return;
    };
    let pieces = two_pieces(&made, TUBE);
    let thinnest = thinnest_along_y(&pieces);
    println!("thin-walled box, shift 0, tooth flattened: thinnest wall {thinnest:.4} mm");
    assert!(thinnest >= FLOOR, "{thinnest}");
    // The flattened tooth leaves the far wall whole on one piece; the teeth that stay still cross the top and bottom.
    within(thinnest, 1.2, 1e-6);
}

#[test]
fn on_the_ribs_every_shift_leaves_a_sliver_and_the_changed_teeth_do_not() {
    // Auto's best shift, 9.2 mm, still lays a flank 0.6 mm into a rib.
    let Some(made) = cut(&ribs(), &op(13.0, zigzag(-13.0 + 9.2))) else {
        return;
    };
    let pieces = two_pieces(&made, RIBS);
    within(thinnest_along_y(&pieces), 0.6, 1e-6);
    // The planner flattens that tooth, and the walls hold.
    let to = [
        [-18.8, 0.0],
        [-18.8, 3.0],
        [-13.8, 3.0],
        [-13.8, 0.0],
        [-8.8, 0.0],
        [-8.8, 3.0],
        [-3.8, 3.0],
        [-3.8, 0.0],
        [11.2, 0.0],
        [11.2, 3.0],
        [16.2, 3.0],
        [16.2, 0.0],
        [21.2, 0.0],
        [21.2, 3.0],
        [26.2, 3.0],
        [26.2, 0.0],
        [31.2, 0.0],
        [31.2, 3.0],
        [36.2, 3.0],
        [36.2, 0.0],
        [41.2, 0.0],
    ];
    let mut profile = zigzag(-3.8);
    profile["start"] = json!([-23.8, 0.0]);
    profile["chain"] = json!(to
        .iter()
        .map(|p| json!({ "kind": "line", "to": p }))
        .collect::<Vec<_>>());
    let made = cut(&ribs(), &op(13.0, profile)).expect("kernel");
    let pieces = two_pieces(&made, RIBS);
    let thinnest = thinnest_along_y(&pieces);
    println!("ribs, tooth flattened: thinnest wall {thinnest:.4} mm");
    assert!(thinnest >= FLOOR, "{thinnest}");
}

fn tongue(v: f64) -> Value {
    json!({ "kind": "tongue", "width": 6.0, "depth": 3.0, "clearance": 0.15, "endGap": 0.4, "side": "positive",
        "u0": -11.05, "u1": 11.05, "v": v })
}

#[test]
fn a_tongue_auto_moves_off_the_hole_keeps_its_whole_groove() {
    let Some(made) = cut(&holed(), &op(15.0, tongue(-4.05))) else {
        return;
    };
    let pieces = made["pieces"].as_array().expect("pieces").clone();
    let peg = 22.1 * 6.0 * 3.0;
    let groove = (22.1 + 0.3) * (6.0 + 0.3) * (3.0 + 0.4);
    // Moved down 4.05 mm, the groove lies wholly in material: it takes all of its volume, so its walls are whole.
    within(volume(&pieces[0]), HOLED / 2.0 - groove, 1e-6);
    within(volume(&pieces[1]), HOLED / 2.0 + peg, 1e-6);
    for piece in &pieces {
        assert_eq!(piece["valid"], json!(true), "{piece}");
    }
    // In the middle, at shift 0, the groove breaks into the hole: it takes less than its volume, the rest is the hole's.
    let made = cut(&holed(), &op(15.0, tongue(0.0))).expect("kernel");
    let pieces = made["pieces"].as_array().expect("pieces").clone();
    assert!(
        volume(&pieces[0]) > HOLED / 2.0 - groove + 1.0,
        "{}",
        volume(&pieces[0])
    );
}
