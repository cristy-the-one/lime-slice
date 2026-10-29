//! Print transitions on straight edges (docs/plan-belt-transitions.md, step 2): the corner wedge on synthetic coupons,
//! on the belt and on a flat bed, through the chamfer and the prism, with each refusal. `LIME_REQUIRE_OCCT=1` makes a
//! missing kernel a failure.
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

fn refused(request: Value) -> String {
    let reply = call(request.clone());
    reply["error"]
        .as_str()
        .unwrap_or_else(|| panic!("{request} was not refused: {reply}"))
        .to_string()
}

fn volume(reply: &Value) -> f64 {
    reply["volumeMm3"].as_f64().expect("volumeMm3")
}

fn near(actual: f64, expected: f64, tolerance: f64) {
    assert!(
        (actual - expected).abs() < tolerance,
        "{actual} is not near {expected}"
    );
}

/// Faces whose outward normal is within 1e-6 of `normal`.
fn facing(reply: &Value, normal: [f64; 3]) -> usize {
    reply["faces"]
        .as_array()
        .expect("faces")
        .iter()
        .filter(|face| {
            let n = &face["normal"];
            (0..3).all(|i| (n[i].as_f64().unwrap_or(9.0) - normal[i]).abs() < 1e-6)
        })
        .count()
}

/// The IR3 V2's build direction for a part lying as built: the belt at 45°, layers stacking toward −Y.
fn belt() -> [f64; 3] {
    let s = std::f64::consts::FRAC_1_SQRT_2;
    [0.0, -s, s]
}

const WIDTH: f64 = 20.0;

/// A side view in part Y and Z, extruded `WIDTH` along X from −WIDTH/2, as the step 1 coupons were.
fn coupon(key: &str, profile: &[[f64; 2]]) -> Value {
    let top = profile.iter().map(|p| p[1]).fold(0.0, f64::max);
    let far = profile.iter().map(|p| p[0]).fold(0.0, f64::max);
    ok(json!({ "call": "open", "key": key,
        "primitive": { "primitive": "box", "origin": [-WIDTH / 2.0, -1.0, 0.0], "size": [WIDTH, far + 2.0, top + 1.0] } }));
    ok(
        json!({ "call": "apply", "key": key, "parent": 0, "node": 1, "op": {
        "kind": "extrude", "op": "common", "origin": [-WIDTH / 2.0, 0.0, 0.0], "turn": [90.0, 0.0, 90.0],
        "profile": profile, "depth": WIDTH } }),
    )
}

/// The edge across the coupon at `[y, z]` in its side view.
fn edge_at(y: f64, z: f64) -> Value {
    json!({ "index": 0, "mid": [0.0, y, z], "lengthMm": WIDTH })
}

/// A 2 mm shell whose inner underside climbs a 45° slope from the belt at Y 50 to Y 30, Z 20 (a wall to the
/// slicer), then turns toward −Y falling `fall_deg` below level, to an inner wall at Y 2.
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

fn transition(edges: Value, extra: Value) -> Value {
    let mut op = json!({ "kind": "transition", "edges": edges, "build": belt() });
    if let Value::Object(fields) = extra {
        for (key, value) in fields {
            op[key] = value;
        }
    }
    op
}

#[test]
fn print_transitions() {
    let opened = call(
        json!({ "call": "open", "key": "t0", "primitive": { "primitive": "box", "origin": [0.0, 0.0, 0.0], "size": [10.0, 10.0, 10.0] } }),
    );
    if opened.get("error").is_some() {
        assert!(!require(), "OCCT was required: {opened}");
        return;
    }

    // --- The roof 20° past the limit: the corner at Y 30, Z 20 between the 45° slope (a wall to the slicer) and the roof.
    let past = coupon("t20", &corner_profile(20.0));
    let bare = volume(&past);
    // The two feet on the belt face down already.
    let feet = facing(&past, [0.0, 0.0, -1.0]);
    assert_eq!(feet, 2);
    let corner = edge_at(30.0, 20.0);

    // To the roof's end, the wedge is the step 1 gusset: its face lies level, 45° to the layers, and it
    // fills the roof to the inner wall. Its 29.8 mm reach is past the 20 mm limit, so it asks for a larger maxMm.
    let limit = refused(
        json!({ "call": "probe", "key": "t20", "node": 1, "op": transition(json!([corner]), json!({ "size": "face" })) }),
    );
    assert!(
        limit.contains("past the 20 mm limit") && limit.contains("Supports or a split"),
        "{limit}"
    );
    let gusset = ok(
        json!({ "call": "probe", "key": "t20", "node": 1, "preview": true,
        "op": transition(json!([corner]), json!({ "size": "face", "maxMm": 40 })) }),
    );
    let fall = 20f64.to_radians();
    let roof_end = [2.0, 20.0 - 28.0 * fall.tan()];
    // The level face from the roof's end at the inner wall to the 45° slope: Z stays at the roof's end.
    let meets = 30.0 + (20.0 - roof_end[1]);
    let wedge = 0.5 * (meets - roof_end[0]) * (20.0 - roof_end[1]) * WIDTH;
    near(volume(&gusset) - bare, wedge, 0.5);
    let row = &gusset["transition"][0];
    assert_eq!(row["case"], json!("corner"), "{row}");
    assert_eq!(
        row["path"],
        json!("prism"),
        "a wedge to the face's end is a prism: {row}"
    );
    near(row["angleToLayersDeg"].as_f64().unwrap(), 45.0, 1e-6);
    near(row["farDeg"].as_f64().unwrap(), 25.0, 1e-6);
    near(row["nearDeg"].as_f64().unwrap(), 90.0, 1e-6);
    near(row["reachMm"].as_f64().unwrap(), 28.0 / fall.cos(), 1e-3);
    assert_eq!(
        facing(&gusset["preview"], [0.0, 0.0, -1.0]),
        feet + 1,
        "one level underside"
    );

    // 5 mm along the roof is a chamfer by a distance and an angle from the roof. The level face runs from 5 mm down
    // the roof to the slope.
    // Picked by its index, as the app and the MCP send it, so it is stored with its faces.
    let index = row["edge"].clone();
    let short = ok(
        json!({ "call": "apply", "key": "t20", "parent": 1, "node": 2,
        "op": transition(json!([index]), json!({ "size": 5.0, "beltDeg": 45.0, "orient": [1, 0, 0, 0, 1, 0, 0, 0, 1], "printer": "ideaformer-ir3-v2" })) }),
    );
    let drop = 5.0 * fall.sin();
    let (p, q) = ([-5.0 * fall.cos(), -drop], [drop, -drop]);
    near(
        volume(&short) - bare,
        0.5 * (p[0] * q[1] - p[1] * q[0]).abs() * WIDTH,
        0.05,
    );
    assert_eq!(facing(&short, [0.0, 0.0, -1.0]), feet + 1, "{short}");
    let stored = &short["op"];
    assert_eq!(stored["kind"], json!("transition"));
    assert_eq!(
        stored["angleDeg"],
        json!(45.0),
        "the default angle is stored: {stored}"
    );
    assert_eq!(stored["beltDeg"], json!(45.0));
    assert_eq!(stored["printer"], json!("ideaformer-ir3-v2"));
    assert_eq!(stored["orient"], json!([1, 0, 0, 0, 1, 0, 0, 0, 1]));
    assert!(
        stored["edges"][0]["sig"].is_object(),
        "the edge is stored with its faces: {stored}"
    );
    // A fillet on the wedge's edges after it, then the wedge rebuilt from its stored op.
    let rounded = ok(
        json!({ "call": "apply", "key": "t20", "parent": 2, "node": 3,
        "op": { "kind": "fillet", "edges": [{ "fromNode": 2, "filter": "convex" }], "size": 0.5 } }),
    );
    assert!(volume(&rounded) < volume(&short));
    let again = ok(json!({ "call": "goto", "key": "t20", "node": 2 }));
    near(volume(&again), volume(&short), 1e-6);

    // Without a size the wedge reaches 2 mm along the roof, the size the coupon study kept.
    let plain = ok(
        json!({ "call": "probe", "key": "t20", "node": 1, "op": transition(json!([corner]), json!({})) }),
    );
    near(
        plain["transition"][0]["reachMm"].as_f64().unwrap(),
        2.0,
        1e-9,
    );
    assert_eq!(plain["transition"][0]["path"], json!("chamfer"));

    // --- The same corner at 55° to the layers: a steeper face, reaching further up the slope for the same 5 mm.
    let steep = ok(json!({ "call": "probe", "key": "t20", "node": 1,
        "op": transition(json!([corner]), json!({ "size": 5.0, "angleDeg": 55.0 })) }));
    near(
        steep["transition"][0]["angleToLayersDeg"].as_f64().unwrap(),
        55.0,
        1e-6,
    );
    assert!(volume(&steep) > volume(&short));

    // --- The flat roof at the limit: at 45° it is the roof itself, so nothing is added. At 55° a 5 mm wedge is the
    // step 1 coupon's chamfer, 53.5 mm³ on this 20 mm wide part.
    coupon("t0f", &corner_profile(0.0));
    let flat = refused(
        json!({ "call": "probe", "key": "t0f", "node": 1, "op": transition(json!([corner]), json!({ "size": 5.0 })) }),
    );
    assert!(
        flat.contains("already grows at 45.0°") && flat.contains("A steeper angle"),
        "{flat}"
    );
    let flat55 = ok(json!({ "call": "probe", "key": "t0f", "node": 1,
        "op": transition(json!([corner]), json!({ "size": 5.0, "angleDeg": 55.0 })) }));
    assert_eq!(flat55["transition"][0]["path"], json!("chamfer"));
    let (along, gap) = (10f64.to_radians(), 135f64.to_radians());
    let up = 5.0 * along.sin() / (gap + along).sin();
    near(
        volume(&flat55) - flat55["before"]["volumeMm3"].as_f64().unwrap(),
        0.5 * 5.0 * up * gap.sin() * WIDTH,
        0.05,
    );
    near(
        volume(&flat55) - flat55["before"]["volumeMm3"].as_f64().unwrap(),
        53.5,
        0.05,
    );

    // --- Refusals, each a sentence, the solid unchanged.
    let probe = |op: Value| refused(json!({ "call": "probe", "key": "t20", "node": 1, "op": op }));
    // The outer corner of the roof is convex.
    let outer = corner_profile(20.0)[6];
    let convex = probe(transition(json!([edge_at(outer[0], outer[1])]), json!({})));
    assert!(convex.contains("This edge is convex"), "{convex}");
    let cut = probe(transition(json!([corner]), json!({ "mode": "cut" })));
    assert!(cut.contains("comes with lips in a later step"), "{cut}");
    let flat_angle = probe(transition(json!([corner]), json!({ "angleDeg": 90.0 })));
    assert!(flat_angle.contains("at most 85°"), "{flat_angle}");
    let zero = probe(json!({ "kind": "transition", "edges": [corner], "build": [0.0, 0.0, 0.0] }));
    assert!(zero.contains("must be a direction"), "{zero}");
    let past_end = probe(transition(
        json!([corner]),
        json!({ "size": 35.0, "maxMm": 60 }),
    ));
    assert!(
        past_end.contains("runs past the end of the flatter face, 29.8 mm"),
        "{past_end}"
    );
    let up_slope = probe(transition(
        json!([corner]),
        json!({ "size": 25.0, "angleDeg": 80.0, "maxMm": 60 }),
    ));
    assert!(up_slope.contains("up the steeper face"), "{up_slope}");
    // Turned so the layers run along the edge's faces' own steepness: the corner already grows steeply enough.
    let along_edge =
        probe(json!({ "kind": "transition", "edges": [corner], "build": [1.0, 0.0, 0.0] }));
    assert!(
        along_edge.contains("already grows at least 45°"),
        "{along_edge}"
    );
    // Upside down, both faces look up the build.
    let upside =
        probe(json!({ "kind": "transition", "edges": [corner], "build": [0.0, 1.0, -1.0] }));
    assert!(
        upside.contains("look up the build") || upside.contains("already grows"),
        "{upside}"
    );
    // A lip: both faces past the angle. On the 20° roof, the corner at the inner wall: the wall grows at 45°, the roof
    // at 25°, so at 50° to the layers neither holds.
    let lip = probe(transition(
        json!([edge_at(2.0, roof_end[1])]),
        json!({ "angleDeg": 50.0 }),
    ));
    assert!(lip.contains("That is a lip"), "{lip}");
    // A curved edge.
    ok(
        json!({ "call": "open", "key": "tc", "primitive": { "primitive": "box", "origin": [-20.0, -20.0, 0.0], "size": [40.0, 40.0, 10.0] } }),
    );
    let post = ok(
        json!({ "call": "apply", "key": "tc", "parent": 0, "node": 1,
        "op": { "kind": "boolean", "op": "fuse", "primitive": "cylinder", "origin": [0.0, 0.0, 10.0], "radius": 5.0, "height": 10.0 } }),
    );
    let ring = json!({ "index": 0, "mid": [-5.0, 0.0, 10.0], "lengthMm": 2.0 * std::f64::consts::PI * 5.0 });
    let curved = refused(
        json!({ "call": "probe", "key": "tc", "node": 1, "op": { "kind": "transition", "edges": [ring], "build": [0.0, 0.0, 1.0] } }),
    );
    assert!(
        curved.contains("straight edge between two flat faces"),
        "{curved} {}",
        volume(&post)
    );
    // Unchanged: the coupon's tip is still its own volume.
    near(
        volume(&ok(json!({ "call": "goto", "key": "t20", "node": 1 }))),
        bare,
        1e-6,
    );

    // --- A flat bed: the build is +Z. A shelf 10 mm out from a wall, its underside level: a 45° wedge under it.
    ok(
        json!({ "call": "open", "key": "tf", "primitive": { "primitive": "box", "origin": [0.0, 0.0, 0.0], "size": [20.0, 5.0, 30.0] } }),
    );
    let shelf = ok(
        json!({ "call": "apply", "key": "tf", "parent": 0, "node": 1,
        "op": { "kind": "boolean", "op": "fuse", "primitive": "box", "origin": [0.0, 5.0, 20.0], "size": [20.0, 10.0, 5.0], "merge": true } }),
    );
    let under = json!({ "index": 0, "mid": [10.0, 5.0, 20.0], "lengthMm": 20.0 });
    let bed = ok(
        json!({ "call": "apply", "key": "tf", "parent": 1, "node": 2,
        "op": { "kind": "transition", "edges": [under], "build": [0.0, 0.0, 2.0], "size": 6.0 } }),
    );
    near(volume(&bed) - volume(&shelf), 0.5 * 6.0 * 6.0 * 20.0, 1e-3);
    assert_eq!(
        bed["op"]["build"],
        json!([0.0, 0.0, 1.0]),
        "the build is stored as a unit direction"
    );
    let s = std::f64::consts::FRAC_1_SQRT_2;
    assert_eq!(
        facing(&bed, [0.0, s, -s]),
        1,
        "one 45° face under the shelf"
    );
    // Two edges at once: the shelf's other underside corner is at its tip, convex, and refused by its index.
    let both = refused(json!({ "call": "probe", "key": "tf", "node": 1,
        "op": { "kind": "transition", "edges": [under, { "index": 0, "mid": [10.0, 15.0, 20.0], "lengthMm": 20.0 }], "build": [0.0, 0.0, 1.0], "size": 6.0 } }));
    assert!(
        both.starts_with("Edge ") && both.contains("convex"),
        "{both}"
    );
    // A rib hanging from the shelf 3 mm out from the wall sits inside the 6 mm wedge: the wedge would meet it.
    ok(
        json!({ "call": "apply", "key": "tf", "parent": 1, "node": 3,
        "op": { "kind": "boolean", "op": "fuse", "primitive": "box", "origin": [8.0, 8.0, 15.0], "size": [4.0, 1.0, 5.0], "merge": true } }),
    );
    let ribbed = refused(json!({ "call": "probe", "key": "tf", "node": 3,
        "op": { "kind": "transition", "edges": [under], "build": [0.0, 0.0, 1.0], "size": 6.0 } }));
    assert!(
        ribbed.contains("run into another part of the solid"),
        "{ribbed}"
    );
    // A 2 mm wedge stops short of it.
    ok(json!({ "call": "probe", "key": "tf", "node": 3,
        "op": { "kind": "transition", "edges": [under], "build": [0.0, 0.0, 1.0], "size": 2.0 } }));
}
