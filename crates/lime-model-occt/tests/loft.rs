//! Loft through sections, smooth profiles, and where a probe says a new hollow or loose piece is. Each volume against
//! a hand-computed one. `LIME_REQUIRE_OCCT=1` makes a missing kernel a failure.

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

fn near(actual: f64, expected: f64, within: f64) {
    assert!(
        (actual - expected).abs() <= within,
        "{actual} is not within {within} of {expected}"
    );
}

/// A 40 × 40 × 10 block, 16 000 mm³, or None without the kernel.
fn block(key: &str) -> Option<()> {
    let opened = call(json!({ "call": "open", "key": key, "box": [40.0, 40.0, 10.0] }));
    if opened.get("error").is_some() {
        assert!(!require(), "OCCT was required: {opened}");
        return None;
    }
    near(volume(&opened), 16_000.0, 0.01);
    Some(())
}

fn apply(key: &str, parent: u32, node: u32, op: &Value) -> Value {
    call(json!({ "call": "apply", "key": key, "parent": parent, "node": node, "op": op }))
}

fn circle(z: f64, radius: f64) -> Value {
    json!({ "origin": [20.0, 20.0, z], "radius": radius })
}

#[test]
fn loft_circles_ellipses_and_profiles() {
    if block("l").is_none() {
        return;
    }
    // Two equal circles a cylinder, standing on the block: π 5² 10.
    let post = json!({ "kind": "loft", "op": "fuse", "sections": [circle(10.0, 5.0), circle(20.0, 5.0)] });
    let built = apply("l", 0, 1, &post);
    near(volume(&built), 16_000.0 + PI * 25.0 * 10.0, 0.5);
    assert_eq!(built["op"]["sections"][1]["radius"], json!(5.0), "the op is stored as sent: {built}");
    assert_eq!(built["op"]["sections"][1]["turn"], json!([0.0, 0.0, 0.0]), "with its turn: {built}");

    // A cone's frustum, ruled: π h / 3 (R² + R r + r²).
    let frustum = json!({ "kind": "loft", "op": "fuse", "ruled": true, "sections": [circle(10.0, 5.0), circle(20.0, 2.5)] });
    near(volume(&apply("l", 0, 2, &frustum)), 16_000.0 + PI * 10.0 / 3.0 * (25.0 + 12.5 + 6.25), 0.5);

    // An ellipse 6 along U by 3 along V: π a b h.
    let oval = json!({ "origin": [20.0, 20.0, 10.0], "radius": 6.0, "radiusV": 3.0 });
    let oval_top = json!({ "origin": [20.0, 20.0, 20.0], "radius": 6.0, "radiusV": 3.0 });
    near(volume(&apply("l", 0, 3, &json!({ "kind": "loft", "op": "fuse", "sections": [oval, oval_top] }))), 16_000.0 + PI * 18.0 * 10.0, 0.5);

    // A square to a circle, cut down into the block: something between the two prisms.
    let square = json!({ "origin": [20.0, 20.0, 10.5], "profile": [[-4.0, -4.0], [4.0, -4.0], [4.0, 4.0], [-4.0, 4.0]] });
    let cut = apply("l", 0, 4, &json!({ "kind": "loft", "op": "cut", "sections": [square, circle(4.0, 3.0)] }));
    let removed = 16_000.0 - volume(&cut);
    assert!(removed > PI * 9.0 * 6.0 && removed < 64.0 * 6.0, "removed {removed}");

    // Refusals.
    let one = apply("l", 0, 5, &json!({ "kind": "loft", "op": "fuse", "sections": [circle(10.0, 5.0)] }));
    assert_eq!(one["error"].as_str(), Some("A loft needs at least 2 sections."), "{one}");
    let bad = apply("l", 0, 5, &json!({ "kind": "loft", "op": "fuse", "sections": [circle(10.0, 5.0), { "origin": [20.0, 20.0, 15.0], "profile": [[0.0, 0.0], [1.0, 0.0]] }] }));
    assert!(bad["error"].as_str().unwrap_or_default().starts_with("Section 1:"), "{bad}");
}

#[test]
fn smooth_profiles() {
    if block("s").is_none() {
        return;
    }
    // Every point a corner: straight edges, the square's own prism.
    let square = json!([[10.0, 10.0], [30.0, 10.0], [30.0, 30.0], [10.0, 30.0]]);
    let all_corners = json!({ "kind": "extrude", "op": "fuse", "origin": [0.0, 0.0, 10.0], "profile": square, "depth": 2.0, "smooth": true, "corners": [0, 1, 2, 3] });
    near(volume(&apply("s", 0, 1, &all_corners)), 16_000.0 + 400.0 * 2.0, 0.01);
    // No corners: one closed spline through the four points bulges past the square's sides.
    let round = json!({ "kind": "extrude", "op": "fuse", "origin": [0.0, 0.0, 10.0], "profile": square, "depth": 2.0, "smooth": true });
    let added = volume(&apply("s", 0, 2, &round)) - 16_000.0;
    assert!(added > 800.0 && added < 900.0 * 2.0, "added {added}");

    // A half circle through five points, straight along the axis between its two corners, turned into a ball sunk 1 mm
    // into the block: the sphere less a cap of height 1, π h² (3r − h) / 3.
    let s = 5.0 * std::f64::consts::FRAC_1_SQRT_2;
    let half = json!([[0.0, -5.0], [s, -s], [5.0, 0.0], [s, s], [0.0, 5.0]]);
    let ball = json!({ "kind": "revolve", "op": "fuse", "origin": [20.0, 20.0, 14.0], "turn": [90.0, 0.0, 0.0], "profile": half, "smooth": true, "corners": [0, 4] });
    let sphere = 4.0 / 3.0 * PI * 125.0 - PI * (3.0 * 5.0 - 1.0) / 3.0;
    near(volume(&apply("s", 0, 3, &ball)) - 16_000.0, sphere, sphere * 0.01);

    let stray = apply("s", 0, 4, &json!({ "kind": "extrude", "op": "fuse", "origin": [0.0, 0.0, 10.0], "profile": square, "depth": 2.0, "smooth": true, "corners": [7] }));
    assert_eq!(stray["error"].as_str(), Some("A corner is not the index of a profile point."), "{stray}");
}

#[test]
fn a_probe_says_where_a_hollow_or_a_piece_is() {
    if block("p").is_none() {
        return;
    }
    // A box 5 mm over the block: a piece apart, 5 mm from it.
    let above = json!({ "kind": "boolean", "op": "fuse", "primitive": "box", "origin": [10.0, 10.0, 15.0], "size": [4.0, 4.0, 4.0], "turn": [0.0, 0.0, 0.0] });
    let probe = call(json!({ "call": "probe", "key": "p", "node": 0, "op": above }));
    assert_eq!(probe["ok"], json!(true), "{probe}");
    let piece = &probe["pieces"][0];
    near(piece["gapMm"].as_f64().unwrap_or(-1.0), 5.0, 1e-6);
    near(piece["volumeMm3"].as_f64().unwrap_or(0.0), 64.0, 1e-6);
    for (got, want) in piece["min"].as_array().expect("a box").iter().zip([10.0, 10.0, 15.0]) {
        near(got.as_f64().unwrap_or(0.0), want, 1e-3);
    }

    // A pocket, then a lid over it: the pocket is sealed off inside.
    let pocket = json!({ "kind": "boolean", "op": "cut", "primitive": "box", "origin": [15.0, 15.0, 5.0], "size": [10.0, 10.0, 6.0], "turn": [0.0, 0.0, 0.0] });
    volume(&apply("p", 0, 1, &pocket));
    let lid = json!({ "kind": "boolean", "op": "fuse", "primitive": "box", "origin": [14.0, 14.0, 9.0], "size": [12.0, 12.0, 2.0], "turn": [0.0, 0.0, 0.0] });
    let sealed = call(json!({ "call": "probe", "key": "p", "node": 1, "op": lid }));
    let hollow = &sealed["voids"][0];
    let min: Vec<f64> = hollow["min"].as_array().expect("a hollow").iter().map(|v| v.as_f64().unwrap_or(0.0)).collect();
    let max: Vec<f64> = hollow["max"].as_array().expect("a hollow").iter().map(|v| v.as_f64().unwrap_or(0.0)).collect();
    for (got, want) in min.iter().zip([15.0, 15.0, 5.0]).chain(max.iter().zip([25.0, 25.0, 9.0])) {
        near(*got, want, 1e-3);
    }
    // A step that makes neither says nothing of them.
    let fine = call(json!({ "call": "probe", "key": "p", "node": 0, "op": pocket }));
    assert!(fine.get("voids").is_none() && fine.get("pieces").is_none(), "{fine}");
}
