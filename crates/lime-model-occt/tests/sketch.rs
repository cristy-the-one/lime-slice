//! Extrude and revolve: a closed profile on a plane, pushed or turned and combined with the solid. Each volume
//! against a hand-computed one, the plane's frame, the stored op, each refusal, and a replay from saved nodes.
//! `LIME_REQUIRE_OCCT=1` makes a missing kernel a failure.

use std::f64::consts::PI;

use serde_json::{json, Value};

fn require() -> bool {
    std::env::var_os("LIME_REQUIRE_OCCT").is_some()
}

fn call(request: Value) -> Value {
    let text = lime_model_occt::tree(&request.to_string());
    serde_json::from_str(&text).unwrap_or_else(|err| panic!("not JSON ({err}): {text}"))
}

fn volume(reply: &Value) -> f64 {
    assert!(reply.get("error").is_none(), "{reply}");
    reply["volumeMm3"].as_f64().expect("volumeMm3")
}

fn near(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() < 0.02,
        "{actual} is not near {expected}"
    );
}

fn apply(key: &str, parent: u32, node: u32, op: &Value) -> Value {
    call(json!({ "call": "apply", "key": key, "parent": parent, "node": node, "op": op }))
}

fn refused(reply: &Value, wanted: &str) {
    assert_eq!(reply["error"].as_str(), Some(wanted), "{reply}");
}

/// A profile on the XZ plane through y: U is X, V is Z, and W is −Y (a turn of 90° about X).
fn extrude(op: &str, y: f64, profile: Value, depth: f64) -> Value {
    json!({ "kind": "extrude", "op": op, "origin": [0.0, y, 0.0], "turn": [90.0, 0.0, 0.0], "profile": profile, "depth": depth })
}

/// A profile on the XZ plane through the top middle of the 40 × 40 × 10 block, turned about its V (+Z) axis.
fn revolve(op: &str, profile: Value) -> Value {
    json!({ "kind": "revolve", "op": op, "origin": [20.0, 20.0, 10.0], "turn": [90.0, 0.0, 0.0], "profile": profile })
}

#[test]
fn extrude_a_gable_roof_and_a_window() {
    // A house body 100 × 60 × 50: 300 000 mm³.
    let opened = call(json!({ "call": "open", "key": "x", "box": [100.0, 60.0, 50.0] }));
    if opened.get("error").is_some() {
        assert!(!require(), "OCCT was required: {opened}");
        return;
    }
    near(volume(&opened), 300_000.0);

    // The roof: a triangle 110 wide and 30 high, 5 mm over each wall, 70 mm deep centred on the middle of the house,
    // so 5 mm over the gable ends too. 1650 mm² × 70 on top of the body, which it touches along the top face.
    let gable = json!([[-5.0, 50.0], [105.0, 50.0], [50.0, 80.0]]);
    let mut roof = extrude("fuse", 30.0, gable.clone(), 70.0);
    roof["symmetric"] = json!(true);
    let roofed = apply("x", 0, 1, &roof);
    near(volume(&roofed), 300_000.0 + 1650.0 * 70.0);
    assert_eq!(roofed["op"], roof, "the op is stored as sent");

    // Not symmetric: W is −Y, so a roof from the back wall (y = 60) runs forward over the body.
    let back = apply("x", 0, 2, &extrude("fuse", 60.0, gable.clone(), 60.0));
    near(volume(&back), 300_000.0 + 1650.0 * 60.0);
    // A negative depth runs along +W's other way: from the front wall back.
    let front = apply("x", 0, 3, &extrude("fuse", 0.0, gable.clone(), -60.0));
    near(volume(&front), 300_000.0 + 1650.0 * 60.0);
    // Clockwise, and with the first point repeated at the end: the same solid.
    let turned = json!([[50.0, 80.0], [105.0, 50.0], [-5.0, 50.0], [50.0, 80.0]]);
    near(
        volume(&apply("x", 0, 4, &extrude("fuse", 0.0, turned, -60.0))),
        300_000.0 + 1650.0 * 60.0,
    );
    // No turn sent is the model axes: the profile in XY, pushed up Z. A 10 × 10 chimney 20 tall from the roof line.
    let chimney = json!({ "kind": "extrude", "op": "fuse", "origin": [10.0, 10.0, 50.0], "profile": [[0, 0], [10, 0], [10, 10], [0, 10]], "depth": 20.0 });
    let stood = apply("x", 0, 5, &chimney);
    near(volume(&stood), 300_000.0 + 2000.0);
    assert_eq!(stood["op"]["turn"], json!([0.0, 0.0, 0.0]));

    // A window cut 10 mm into the front wall from outside: W is −Y, out of the wall, so the depth is −10.
    let window = json!([[20.0, 20.0], [40.0, 20.0], [40.0, 35.0], [20.0, 35.0]]);
    let cut = apply("x", 1, 6, &extrude("cut", 0.0, window.clone(), -10.0));
    near(volume(&cut), volume(&roofed) - 20.0 * 15.0 * 10.0);
    // The same pocket, centred on the plane 5 mm into the wall.
    let mut both = extrude("cut", 5.0, window.clone(), 10.0);
    both["symmetric"] = json!(true);
    near(
        volume(&apply("x", 1, 7, &both)),
        volume(&roofed) - 20.0 * 15.0 * 10.0,
    );
    // Common keeps what the prism and the part share.
    near(
        volume(&apply("x", 0, 8, &extrude("common", 0.0, window.clone(), -60.0))),
        20.0 * 15.0 * 60.0,
    );

    // Refusals, each one sentence, none changing the tree.
    let square = json!([[0, 0], [10, 0], [10, 10], [0, 10]]);
    refused(
        &apply("x", 0, 90, &extrude("fuse", 0.0, json!([[0, 0], [10, 0]]), 5.0)),
        "A profile needs at least 3 points.",
    );
    refused(
        &apply("x", 0, 90, &extrude("fuse", 0.0, json!([[0, 0], [10, 10], [10, 0], [0, 10]]), 5.0)),
        "The profile crosses itself.",
    );
    refused(
        &apply("x", 0, 90, &extrude("fuse", 0.0, json!([[0, 0], [5, 5], [10, 10]]), 5.0)),
        "The profile has no area.",
    );
    refused(
        &apply("x", 0, 90, &extrude("fuse", 0.0, json!([[0, 0], [0, 0], [10, 0], [10, 10]]), 5.0)),
        "Two profile points in a row are in the same place.",
    );
    refused(
        &apply("x", 0, 90, &extrude("fuse", 0.0, square.clone(), 0.0)),
        "An extrude needs a depth other than 0.",
    );
    // A cut that misses the part, and a fuse wholly inside it, do nothing.
    refused(
        &apply("x", 0, 90, &extrude("cut", -50.0, square.clone(), 5.0)),
        "The extrude does not change the part.",
    );
    refused(
        &apply("x", 0, 90, &extrude("fuse", 30.0, square.clone(), 5.0)),
        "The extrude does not change the part.",
    );
    refused(
        &apply("x", 0, 90, &extrude("fuse", -50.0, square.clone(), 5.0)),
        "This would add a separate body; place it touching the part.",
    );
    refused(
        &apply("x", 0, 90, &extrude("common", -50.0, square.clone(), 5.0)),
        "The solids do not overlap",
    );
    let mut wrong = extrude("fuse", 0.0, square, 5.0);
    wrong["op"] = json!("glue");
    assert!(apply("x", 0, 90, &wrong)["error"].is_string());

    // The probe of an extrude answers what it would build.
    let probe = call(json!({ "call": "probe", "key": "x", "node": 0, "op": extrude("cut", 0.0, window, -10.0) }));
    assert_eq!(probe["ok"], json!(true), "{probe}");
    near(probe["volumeMm3"].as_f64().unwrap(), 300_000.0 - 3000.0);
    assert_eq!(probe["solids"], json!(1));
    near(
        probe["before"]["volumeMm3"].as_f64().unwrap(),
        300_000.0,
    );

    // Saved nodes rebuild to the fingerprints they had.
    let saved: Vec<Value> = [(1, 0, &roofed), (6, 1, &cut)]
        .iter()
        .map(|(id, parent, reply)| json!({ "id": id, "parent": parent, "op": reply["op"], "fingerprint": reply["fingerprint"] }))
        .collect();
    let reopened = call(json!({ "call": "open", "key": "x2", "box": [100.0, 60.0, 50.0], "nodes": saved, "current": 6 }));
    near(volume(&reopened), volume(&cut));
    assert_eq!(reopened["replayed"], json!(2));
}

#[test]
fn revolve_a_boss_and_a_groove() {
    let opened = call(json!({ "call": "open", "key": "r", "box": [40.0, 40.0, 10.0] }));
    if opened.get("error").is_some() {
        assert!(!require(), "OCCT was required: {opened}");
        return;
    }
    near(volume(&opened), 16_000.0);

    // A rectangle against the axis, turned whole: a boss ⌀10 × 8 standing on the top face.
    let boss = revolve("fuse", json!([[0.0, 0.0], [5.0, 0.0], [5.0, 8.0], [0.0, 8.0]]));
    let stood = apply("r", 0, 1, &boss);
    near(volume(&stood), 16_000.0 + PI * 25.0 * 8.0);
    assert_eq!(stood["op"], boss, "no axis or angle sent, none stored");
    // A quarter turn.
    let mut quarter = boss.clone();
    quarter["angleDeg"] = json!(90.0);
    near(
        volume(&apply("r", 0, 2, &quarter)),
        16_000.0 + PI * 25.0 * 8.0 / 4.0,
    );
    // The same profile on the other side of the axis turns the right way round too.
    near(
        volume(&apply("r", 0, 3, &revolve("fuse", json!([[0, 0], [0, 8], [-5, 8], [-5, 0]])))),
        16_000.0 + PI * 25.0 * 8.0,
    );

    // A ring groove 2 deep in the top face, ⌀10 to ⌀14.
    let groove = apply("r", 0, 4, &revolve("cut", json!([[5, 0], [7, 0], [7, -2], [5, -2]])));
    near(volume(&groove), 16_000.0 - PI * (49.0 - 25.0) * 2.0);

    // About another axis: the line v = 1 along U, a rod ⌀4 along X whose axis is 1 mm above the top face.
    let mut rod = revolve("fuse", json!([[0, 1], [4, 1], [4, 3], [0, 3]]));
    rod["axisOrigin"] = json!([0.0, 1.0]);
    rod["axisDir"] = json!([1.0, 0.0]);
    // The part of the rod below the top face, a circle's segment 1 mm from its centre, is inside the block.
    let segment = 4.0 * (0.5f64).acos() - 3.0f64.sqrt();
    near(
        volume(&apply("r", 0, 5, &rod)),
        16_000.0 + PI * 4.0 * 4.0 - segment * 4.0,
    );

    refused(
        &apply("r", 0, 90, &revolve("fuse", json!([[-1, 0], [5, 0], [5, 8], [-1, 8]]))),
        "The profile crosses the revolve axis. Keep it on one side.",
    );
    let mut flat = boss.clone();
    flat["angleDeg"] = json!(0.0);
    refused(
        &apply("r", 0, 90, &flat),
        "A revolve needs an angle above 0 and at most 360 degrees.",
    );
    flat["angleDeg"] = json!(400.0);
    refused(
        &apply("r", 0, 90, &flat),
        "A revolve needs an angle above 0 and at most 360 degrees.",
    );
    let mut nowhere = boss.clone();
    nowhere["axisDir"] = json!([0.0, 0.0]);
    refused(
        &apply("r", 0, 90, &nowhere),
        "The revolve axis needs a direction in the profile's plane.",
    );
    let mut far = boss;
    far["origin"] = json!([20.0, 20.0, 30.0]);
    refused(
        &apply("r", 0, 90, &far),
        "This would add a separate body; place it touching the part.",
    );
}
