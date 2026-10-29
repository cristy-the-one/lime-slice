//! Print transitions, auto-find (docs/plan-belt-transitions.md, step 5): the edges that would start in the air, found
//! from the solid's faces and edges against the build direction, on synthetic parts under the IR3 V2's belt and under a
//! flat bed. Each row carries the probe of its fix. `LIME_REQUIRE_OCCT=1` makes a missing kernel a failure.
//!
//! The store is process-wide, so everything runs in one test, in order, each part in its own document.

use serde_json::{json, Value};

fn require() -> bool {
    std::env::var_os("LIME_REQUIRE_OCCT").is_some()
}

fn call(request: Value) -> Value {
    let text = lime_model_occt::tree(&request.to_string());
    serde_json::from_str(&text).unwrap_or_else(|err| panic!("not JSON ({err}): {text}"))
}

fn ok(request: Value) -> Value {
    let reply = call(request.clone());
    assert!(reply.get("error").is_none(), "{request} -> {reply}");
    reply
}

/// The IR3 V2's build direction for a part lying as built: the belt at 45°, layers stacking toward −Y.
fn belt() -> [f64; 3] {
    let s = std::f64::consts::FRAC_1_SQRT_2;
    [0.0, -s, s]
}

const FLAT: [f64; 3] = [0.0, 0.0, 1.0];
const WIDTH: f64 = 20.0;

/// A side view in part Y and Z, extruded `WIDTH` along X from −WIDTH/2, as the step 1 coupons were.
fn coupon(key: &str, profile: &[[f64; 2]]) {
    let top = profile.iter().map(|p| p[1]).fold(0.0, f64::max);
    let far = profile.iter().map(|p| p[0]).fold(0.0, f64::max);
    ok(json!({ "call": "open", "key": key,
        "primitive": { "primitive": "box", "origin": [-WIDTH / 2.0, -1.0, 0.0], "size": [WIDTH, far + 2.0, top + 1.0] } }));
    ok(
        json!({ "call": "apply", "key": key, "parent": 0, "node": 1, "op": {
        "kind": "extrude", "op": "common", "origin": [-WIDTH / 2.0, 0.0, 0.0], "turn": [90.0, 0.0, 90.0],
        "profile": profile, "depth": WIDTH } }),
    );
}

/// The 2 mm shell of the step 1 coupons: its inner underside climbs a 45° slope from the belt at Y 50 to Y 30, Z 20 (a
/// wall to the slicer), then turns toward −Y falling `fall_deg` below level, to an inner wall at Y 2.
fn corner_profile(fall_deg: f64) -> Vec<[f64; 2]> {
    let fall = fall_deg.to_radians().tan();
    let end = 20.0 - 28.0 * fall;
    let outer_roof = |y: f64| 20.0 + 2.0 / fall.atan().cos() - (30.0 - y) * fall;
    let yc = (22.828 + 30.0 - (20.0 + 2.0 / fall.atan().cos() - 30.0 * fall)) / (1.0 + fall);
    vec![
        [0.0, 0.0],
        [2.0, 0.0],
        [2.0, end],
        [30.0, 20.0],
        [50.0, 0.0],
        [52.828, 0.0],
        [yc, 22.828 - (yc - 30.0)],
        [0.0, outer_roof(0.0)],
    ]
}

/// A post from Y 0 to 10, the part's full height, with an arm out to Y 20 whose underside leaves the post at Z 10 and
/// rises `rise_deg` toward +Y. On a flat bed that underside is `rise_deg` to the layers.
fn overhang_profile(rise_deg: f64) -> Vec<[f64; 2]> {
    let tip = 10.0 + 10.0 * rise_deg.to_radians().tan();
    vec![
        [0.0, 0.0],
        [10.0, 0.0],
        [10.0, 10.0],
        [20.0, tip],
        [20.0, 30.0],
        [0.0, 30.0],
    ]
}

/// The transitionFind call on node `node` of `key`, with the card's fix: the support limit and 2 mm.
fn find(key: &str, node: u32, build: [f64; 3]) -> Value {
    ok(
        json!({ "call": "transitionFind", "key": key, "node": node, "build": build, "up": FLAT, "limitDeg": 45.0,
        "fix": { "mode": "auto", "angleDeg": 45.0, "size": 2.0 } }),
    )
}

fn rows(found: &Value) -> &Vec<Value> {
    found["rows"].as_array().expect("rows")
}

/// The row whose edge runs across the coupon at `[y, z]` in its side view.
fn row_at(found: &Value, y: f64, z: f64) -> Option<&Value> {
    rows(found).iter().find(|row| {
        let mid = &row["mid"];
        let at = |i: usize| mid[i].as_f64().unwrap_or(f64::NAN);
        at(0).abs() < 1e-3 && (at(1) - y).abs() < 1e-3 && (at(2) - z).abs() < 1e-3
    })
}

fn listed<'a>(found: &'a Value, y: f64, z: f64, case: &str) -> &'a Value {
    let row = row_at(found, y, z).unwrap_or_else(|| panic!("no row at Y {y}, Z {z}: {found}"));
    assert_eq!(row["case"], json!(case), "{row}");
    assert!(
        (row["lengthMm"].as_f64().unwrap() - WIDTH).abs() < 1e-3,
        "{row}"
    );
    row
}

/// A fix that builds gives the wedge's numbers; one that refuses gives its sentence.
fn fix_ok(row: &Value) -> bool {
    let probe = &row["probe"];
    match probe["ok"].as_bool() {
        Some(true) => {
            assert!(probe["transition"].is_array(), "{row}");
            true
        }
        Some(false) => {
            assert!(
                probe["error"].as_str().is_some_and(|text| !text.is_empty()),
                "{row}"
            );
            false
        }
        None => panic!("no probe: {row}"),
    }
}

/// Rows come longest first.
fn longest_first(found: &Value) {
    let lengths: Vec<f64> = rows(found)
        .iter()
        .map(|row| row["lengthMm"].as_f64().unwrap())
        .collect();
    assert!(
        lengths.windows(2).all(|pair| pair[0] >= pair[1]),
        "{lengths:?}"
    );
}

#[test]
fn finds_edges_that_start_in_the_air() {
    let opened = call(
        json!({ "call": "open", "key": "find0", "primitive": { "primitive": "box", "origin": [0.0, 0.0, 0.0], "size": [10.0, 10.0, 10.0] } }),
    );
    if opened.get("error").is_some() {
        assert!(!require(), "OCCT was required: {opened}");
        return;
    }

    // --- On the belt.
    // A corner past the limit: the roof falls 20° below level, 25° to the layers. Its 2 mm wedge builds.
    coupon("find-past", &corner_profile(20.0));
    let past = find("find-past", 1, belt());
    let bend = listed(&past, 30.0, 20.0, "corner");
    assert!(fix_ok(bend), "{bend}");
    assert!(
        (bend["farDeg"].as_f64().unwrap() - 25.0).abs() < 0.01,
        "{bend}"
    );
    assert!(
        (bend["probe"]["transition"][0]["reachMm"].as_f64().unwrap() - 2.0).abs() < 1e-6,
        "{bend}"
    );
    longest_first(&past);
    assert_eq!(past["curvedSkipped"], json!(0));
    // The inner wall looks toward +Y, exactly at the limit: the corner at its top is listed, and a wedge at the limit
    // would run along that wall, so its fix refuses with a sentence rather than a reach past any end.
    let wall = listed(&past, 2.0, 20.0 - 28.0 * 20f64.to_radians().tan(), "corner");
    assert!(!fix_ok(wall), "{wall}");
    assert!(
        wall["probe"]["error"]
            .as_str()
            .unwrap()
            .contains("run along it"),
        "{wall}"
    );

    // A corner at the limit: the flat roof, parallel to the belt, is 45° to the layers. It is listed, and its fix at
    // the limit refuses, since a wedge at 45° would lie along the roof.
    coupon("find-limit", &corner_profile(0.0));
    let limit = find("find-limit", 1, belt());
    let flat = listed(&limit, 30.0, 20.0, "corner");
    assert!(!fix_ok(flat), "{flat}");
    assert!(
        flat["probe"]["error"]
            .as_str()
            .unwrap()
            .contains("adds nothing"),
        "{flat}"
    );

    // A corner that holds: the roof rises 10° toward −Y, 55° to the layers.
    coupon("find-holds", &corner_profile(-10.0));
    let holds = find("find-holds", 1, belt());
    assert!(row_at(&holds, 30.0, 20.0).is_none(), "{holds}");

    // A lip born in the air: a post at high Y with a lip hanging 6 mm toward −Y, its underside rising 45° toward +Y so
    // it lies in one layer. Its first edge, at Y 14, Z 12, is listed as a lip; the root of its underside is a corner.
    coupon(
        "find-lip",
        &[
            [20.0, 0.0],
            [30.0, 0.0],
            [30.0, 20.0],
            [14.0, 20.0],
            [14.0, 12.0],
            [20.0, 18.0],
        ],
    );
    let lip = find("find-lip", 1, belt());
    let first = listed(&lip, 14.0, 12.0, "lip");
    // Step 4 builds the gusset under it, from this edge back to the post.
    assert!(fix_ok(first), "{first}");
    assert_eq!(
        first["probe"]["transition"][0]["case"],
        json!("lip"),
        "{first}"
    );
    assert!(first["farDeg"].as_f64().unwrap() < 0.01, "{first}");
    listed(&lip, 20.0, 18.0, "corner");
    // The underside's sides lie in the same layer, but one gusset from its first edge holds them: one lip per underside.
    assert_eq!(
        rows(&lip)
            .iter()
            .filter(|row| row["case"] == json!("lip"))
            .count(),
        1,
        "{lip}"
    );

    // A lip past a hole: a plate parallel to the belt, held by a wall at its high-Y end, with a hole through it. The
    // hole's far edge in build order, at Y 15, is where the plate starts again with nothing under it, although the
    // plate's underside goes on lower along the build beyond the hole. Its near edge, at Y 25, is where the plate stops.
    coupon(
        "find-hole",
        &[
            [30.0, 0.0],
            [40.0, 0.0],
            [40.0, 12.0],
            [0.0, 12.0],
            [0.0, 10.0],
            [30.0, 10.0],
        ],
    );
    ok(
        json!({ "call": "apply", "key": "find-hole", "parent": 1, "node": 2, "op":
        { "kind": "boolean", "op": "cut", "primitive": "box", "origin": [-5.0, 15.0, 5.0], "size": [10.0, 10.0, 10.0] } }),
    );
    let hole = find("find-hole", 2, belt());
    let past_hole =
        row_at(&hole, 15.0, 10.0).unwrap_or_else(|| panic!("no lip past the hole: {hole}"));
    assert_eq!(past_hole["case"], json!("lip"), "{past_hole}");
    assert!(
        (past_hole["lengthMm"].as_f64().unwrap() - 10.0).abs() < 1e-3,
        "{past_hole}"
    );
    fix_ok(past_hole);
    assert!(row_at(&hole, 25.0, 10.0).is_none(), "{hole}");

    // A box on the belt: its back edge on the belt lies in one layer and is the lowest point of both its faces, but the
    // belt holds it. No edge of it starts in the air.
    ok(
        json!({ "call": "open", "key": "find-box", "primitive": { "primitive": "box", "origin": [0.0, 0.0, 0.0], "size": [20.0, 30.0, 10.0] } }),
    );
    let box_belt = find("find-box", 0, belt());
    assert!(rows(&box_belt).is_empty(), "{box_belt}");

    // --- On a flat bed.
    // An arm with a flat underside: the corner under it is past the limit and its wedge builds; the arm's front edge is
    // a lip.
    coupon("find-arm", &overhang_profile(0.0));
    let arm = find("find-arm", 1, FLAT);
    let under = listed(&arm, 10.0, 10.0, "corner");
    assert!(fix_ok(under), "{under}");
    let arm_lip = listed(&arm, 20.0, 10.0, "lip");
    assert!(fix_ok(arm_lip), "{arm_lip}");
    longest_first(&arm);

    // An underside 46° to the layers, within 3° of the limit: listed, and its fix at the limit refuses.
    coupon("find-arm46", &overhang_profile(46.0));
    let near_limit = find("find-arm46", 1, FLAT);
    let steep = listed(&near_limit, 10.0, 10.0, "corner");
    assert!(!fix_ok(steep), "{steep}");
    assert!(
        row_at(&near_limit, 20.0, 10.0 + 10.0 * 46f64.to_radians().tan()).is_none(),
        "{near_limit}"
    );

    // An underside 60° to the layers holds.
    coupon("find-arm60", &overhang_profile(60.0));
    let held = find("find-arm60", 1, FLAT);
    assert!(rows(&held).is_empty(), "{held}");

    // A box on the bed: its bottom edges are on the bed.
    let box_bed = find("find-box", 0, FLAT);
    assert!(rows(&box_bed).is_empty(), "{box_bed}");

    // A cone's tip, hanging under a plate held up by a leg: a point is not an edge, so nothing is listed under the
    // plate where the cone is. The circle where the cone meets the plate is curved and only counted. The plate's own
    // free underside edges are lips.
    ok(json!({ "call": "open", "key": "find-cone",
        "primitive": { "primitive": "cone", "origin": [0.0, 0.0, 2.0], "radius": 5.0, "topRadius": 0.0, "height": 8.0, "turn": [180.0, 0.0, 0.0] } }));
    ok(
        json!({ "call": "apply", "key": "find-cone", "parent": 0, "node": 1, "op":
        { "kind": "boolean", "op": "fuse", "primitive": "box", "origin": [-10.0, -10.0, 10.0], "size": [20.0, 20.0, 2.0] } }),
    );
    ok(
        json!({ "call": "apply", "key": "find-cone", "parent": 1, "node": 2, "op":
        { "kind": "boolean", "op": "fuse", "primitive": "box", "origin": [8.0, 8.0, 0.0], "size": [2.0, 2.0, 10.0] } }),
    );
    for build in [FLAT, belt()] {
        let cone = find("find-cone", 2, build);
        let near_tip = rows(&cone).iter().filter(|row| {
            let mid = &row["mid"];
            mid[0].as_f64().unwrap().hypot(mid[1].as_f64().unwrap()) < 5.5
                && mid[2].as_f64().unwrap() < 10.0
        });
        assert_eq!(near_tip.count(), 0, "{cone}");
        if build == FLAT {
            assert!(cone["curvedSkipped"].as_u64().unwrap() >= 1, "{cone}");
            assert_eq!(
                cone["curvedEdges"].as_array().map(Vec::len),
                cone["curvedSkipped"].as_u64().map(|n| n as usize),
                "{cone}"
            );
            assert!(
                rows(&cone).iter().any(|row| row["case"] == json!("lip")),
                "{cone}"
            );
            assert!(
                rows(&cone)
                    .iter()
                    .all(|row| (row["mid"][2].as_f64().unwrap() - 10.0).abs() < 1e-3),
                "{cone}"
            );
        }
    }

    // A zero build direction is refused with a sentence.
    let zero = call(
        json!({ "call": "transitionFind", "key": "find-box", "node": 0, "build": [0.0, 0.0, 0.0], "up": FLAT }),
    );
    assert!(
        zero["error"]
            .as_str()
            .is_some_and(|text| text.contains("direction")),
        "{zero}"
    );
}
