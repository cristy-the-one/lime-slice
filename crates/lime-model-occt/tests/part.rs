//! Fasteners (docs/plan-mech-parts.md, sections 4.1–4.4 and 9). The analytic box and volume are computed
//! here from the plan's rows. They are not read back from the solid. `LIME_REQUIRE_OCCT=1` makes a missing
//! kernel a failure.
//!
//! `cargo test -p lime-model-occt --test part -- --nocapture` prints measured volume and bounds against the analytic solid.

use base64::Engine;
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
    assert!(
        reply.get("error").is_none() && reply["ok"] != json!(false),
        "{} -> {}",
        short(&request),
        short(&reply)
    );
    reply
}

fn short(value: &Value) -> String {
    value.to_string().chars().take(500).collect()
}

fn kernel() -> bool {
    let probe = call(json!({ "call": "open", "key": "part-kernel", "box": [1.0, 1.0, 1.0] }));
    if probe.get("error").is_some() {
        assert!(!require(), "OCCT was required: {probe}");
        return false;
    }
    true
}

fn volume(reply: &Value) -> f64 {
    reply["volumeMm3"].as_f64().expect("volumeMm3")
}

fn points(reply: &Value) -> Vec<[f64; 3]> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(reply["positions"].as_str().expect("positions"))
        .expect("base64");
    bytes
        .chunks_exact(12)
        .map(|corner| {
            let word =
                |i: usize| f64::from(f32::from_le_bytes(corner[i..i + 4].try_into().unwrap()));
            [word(0), word(4), word(8)]
        })
        .collect()
}

fn bounds(reply: &Value) -> [[f64; 3]; 2] {
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    for point in points(reply) {
        for axis in 0..3 {
            min[axis] = min[axis].min(point[axis]);
            max[axis] = max[axis].max(point[axis]);
        }
    }
    [min, max]
}

fn near_box(got: [[f64; 3]; 2], want: [[f64; 3]; 2]) {
    for (side, (a, b)) in got.iter().zip(want.iter()).enumerate() {
        for axis in 0..3 {
            assert!(
                (a[axis] - b[axis]).abs() < 0.02,
                "box {got:?} is not near {want:?} (side {side}, axis {axis})"
            );
        }
    }
}

fn step_check(key: &str, node: u32) -> lime_model_occt::PartitionPiece {
    let exported = ok(json!({ "call": "export", "key": key, "node": node, "format": "step" }));
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(exported["bytesBase64"].as_str().expect("bytesBase64"))
        .expect("base64");
    let solids = lime_model_occt::step_solids(&bytes).expect("the STEP file reads");
    assert_eq!(solids.len(), 1, "{solids:?}");
    solids[0].clone()
}

fn hex_x(s: f64) -> f64 {
    s / 3f64.sqrt()
}

fn nut_volume(s: f64, m: f64, drill: f64) -> f64 {
    (3f64.sqrt() / 2.0) * s * s * m - std::f64::consts::PI * (drill / 2.0).powi(2) * m
}

fn socket_volume(major: f64, dk: f64, k: f64, s: f64, t: f64, length: f64) -> f64 {
    std::f64::consts::PI * (dk / 2.0).powi(2) * k
        + std::f64::consts::PI * (major / 2.0).powi(2) * length
        - (3f64.sqrt() / 2.0) * s * s * t
}

fn hex_volume(major: f64, s: f64, k: f64, length: f64) -> f64 {
    (3f64.sqrt() / 2.0) * s * s * k + std::f64::consts::PI * (major / 2.0).powi(2) * length
}

fn washer_volume(d1: f64, d2: f64, h: f64) -> f64 {
    std::f64::consts::PI * ((d2 / 2.0).powi(2) - (d1 / 2.0).powi(2)) * h
}

/// Plan rows used as the oracle. M3, M6 and M12 of each table, with the default length under the head.
fn check_open(key: &str, solid: Value, want_volume: f64, want: [[f64; 3]; 2]) {
    let opened = ok(json!({ "call": "open", "key": key, "primitive": solid, "chordMm": 0.01 }));
    let got = volume(&opened);
    let box_ = bounds(&opened);
    println!(
        "part {key}: measured volume {got} mm3, analytic {want_volume} mm3, measured bounds {box_:?}, analytic bounds {want:?}"
    );
    assert!(
        (got - want_volume).abs() < 0.5,
        "{key}: volume {got} vs {want_volume}"
    );
    near_box(box_, want);
    let piece = step_check(key, 0);
    assert!(
        piece.valid && piece.closed && piece.solids == 1,
        "{key}: {piece:?}"
    );
}

#[test]
fn fasteners_match_the_analytic_solid_at_m3_m6_and_m12() {
    if !kernel() {
        return;
    }
    // ISO 4032. s, m, tap drill.
    for (nominal, s, m, drill) in [
        ("M3", 5.5, 2.4, 2.5),
        ("M6", 10.0, 5.2, 5.0),
        ("M12", 18.0, 10.8, 10.2),
    ] {
        let x = hex_x(s);
        check_open(
            &format!("nut-{nominal}"),
            json!({ "primitive": "part", "partKind": "nut", "nominal": nominal, "origin": [0.0, 0.0, 0.0] }),
            nut_volume(s, m, drill),
            [[-x, -s / 2.0, 0.0], [x, s / 2.0, m]],
        );
    }
    // ISO 4762. major, dk, k, key s, t min. Length under the head is the default 25.
    for (nominal, major, dk, k, s, t) in [
        ("M3", 3.0, 5.5, 3.0, 2.5, 1.3),
        ("M6", 6.0, 10.0, 6.0, 5.0, 3.0),
        ("M12", 12.0, 18.0, 12.0, 10.0, 6.0),
    ] {
        let r = dk / 2.0;
        check_open(
            &format!("socket-{nominal}"),
            json!({ "primitive": "part", "partKind": "socket", "nominal": nominal, "origin": [0.0, 0.0, 0.0] }),
            socket_volume(major, dk, k, s, t, 25.0),
            [[-r, -r, -25.0], [r, r, k]],
        );
    }
    // ISO 4017. major, s, k. Length under the head is the default 20.
    for (nominal, major, s, k) in [
        ("M3", 3.0, 5.5, 2.0),
        ("M6", 6.0, 10.0, 4.0),
        ("M12", 12.0, 18.0, 7.5),
    ] {
        let x = hex_x(s);
        check_open(
            &format!("hex-{nominal}"),
            json!({ "primitive": "part", "partKind": "hex", "nominal": nominal, "origin": [0.0, 0.0, 0.0] }),
            hex_volume(major, s, k, 20.0),
            [[-x, -s / 2.0, -20.0], [x, s / 2.0, k]],
        );
    }
    // ISO 7089. d1, d2, h.
    for (nominal, d1, d2, h) in [
        ("M3", 3.2, 7.0, 0.5),
        ("M6", 6.4, 12.0, 1.6),
        ("M12", 13.0, 24.0, 2.5),
    ] {
        let r = d2 / 2.0;
        check_open(
            &format!("washer-{nominal}"),
            json!({ "primitive": "part", "partKind": "washer", "nominal": nominal, "origin": [0.0, 0.0, 0.0] }),
            washer_volume(d1, d2, h),
            [[-r, -r, 0.0], [r, r, h]],
        );
    }
}

#[test]
fn a_socket_pocket_opens_the_top_of_the_head() {
    if !kernel() {
        return;
    }
    // k and t min from the ISO 4762 rows. The pocket point is halfway down the socket, inside the head's height.
    for (nominal, k, t) in [("M3", 3.0, 1.3), ("M6", 6.0, 3.0), ("M12", 12.0, 6.0)] {
        let key = format!("socket-pocket-{nominal}");
        let opened = ok(json!({
            "call": "open", "key": key, "chordMm": 0.01,
            "primitive": { "primitive": "part", "partKind": "socket", "nominal": nominal, "origin": [0.0, 0.0, 0.0] }
        }));
        let before = volume(&opened);
        let box_ = bounds(&opened);
        let pocket_z = k - t / 2.0;
        let probe = |at: [f64; 3]| {
            call(json!({
                "call": "probe", "key": key, "node": 0,
                "op": { "kind": "boolean", "op": "cut", "primitive": "sphere", "origin": at, "radius": 0.2 }
            }))
        };
        let pocket = probe([0.0, 0.0, pocket_z]);
        let pocket_volume = if pocket.get("error").is_some() {
            before
        } else {
            volume(&pocket)
        };
        println!(
            "socket {nominal}: point (0,0,{pocket_z}) probe volume {pocket_volume} mm3, solid {before} mm3, box z max {}",
            box_[1][2]
        );
        // A socket that started at z = k would still have metal here, and the probe would remove some.
        assert!(
            (pocket_volume - before).abs() < 0.01,
            "{nominal}: the pocket point is still material ({pocket_volume} vs {before})"
        );
        assert!(
            k + 1.0 > box_[1][2] + 0.5,
            "{nominal}: (0,0,k+1) is inside the box {box_:?}"
        );
        // A point in the head, below the pocket and inside the head radius, does remove metal.
        let metal_z = (k - t) / 2.0;
        let metal_x = match nominal {
            "M3" => 2.2,
            "M6" => 4.2,
            _ => 8.2,
        };
        let metal = probe([metal_x, 0.0, metal_z]);
        assert!(metal.get("error").is_none(), "{nominal}: {}", short(&metal));
        assert!(
            before - volume(&metal) > 0.02,
            "{nominal}: a point in the head removed nothing"
        );
    }
}

#[test]
fn a_turned_nut_turns_about_the_middle_of_its_box() {
    if !kernel() {
        return;
    }
    // M6 nut, s = 10, m = 5.2. A quarter turn about Z swaps the flat (y = ±5) onto x.
    let s = 10.0;
    let m = 5.2;
    let x = hex_x(s);
    let opened = ok(json!({
        "call": "open", "key": "nut-turned", "chordMm": 0.01,
        "primitive": { "primitive": "part", "partKind": "nut", "nominal": "M6", "origin": [0.0, 0.0, 0.0], "turn": [0.0, 0.0, 90.0] }
    }));
    let box_ = bounds(&opened);
    println!("turned M6 nut bounds {box_:?}");
    near_box(box_, [[-s / 2.0, -x, 0.0], [s / 2.0, x, m]]);
}

#[test]
fn a_washer_cut_by_a_nut_stays_closed() {
    if !kernel() {
        return;
    }
    ok(json!({
        "call": "open", "key": "washer-cut", "chordMm": 0.01,
        "primitive": { "primitive": "part", "partKind": "washer", "nominal": "M12", "origin": [0.0, 0.0, 0.0] }
    }));
    let cut = ok(json!({
        "call": "apply", "key": "washer-cut", "parent": 0, "node": 1,
        "op": { "kind": "boolean", "op": "cut", "primitive": "part", "partKind": "nut", "nominal": "M12", "origin": [0.0, 0.0, 0.0] }
    }));
    println!("M12 washer cut by an M12 nut: volume {} mm3", volume(&cut));
    let piece = step_check("washer-cut", 1);
    assert!(
        piece.valid && piece.closed && piece.solids == 1,
        "{piece:?}"
    );
}

#[test]
fn unknown_sizes_and_a_washer_with_no_wall_are_refused() {
    if !kernel() {
        return;
    }
    let refused = |key: &str, solid: Value, sentence: &str| {
        let reply = call(json!({ "call": "open", "key": key, "primitive": solid }));
        assert_eq!(reply["error"].as_str(), Some(sentence), "{}", short(&reply));
    };
    refused(
        "part-no-kind",
        json!({ "primitive": "part", "origin": [0.0, 0.0, 0.0] }),
        "A part needs a kind: nut, socket, hex, or washer.",
    );
    refused(
        "part-m7-nut",
        json!({ "primitive": "part", "partKind": "nut", "nominal": "M7", "origin": [0.0, 0.0, 0.0] }),
        "M7 is not in the ISO 4032 style 1 hex nut table.",
    );
    refused(
        "part-m7-socket",
        json!({ "primitive": "part", "partKind": "socket", "nominal": "M7", "origin": [0.0, 0.0, 0.0] }),
        "M7 is not in the ISO 4762 socket head cap screw table.",
    );
    refused(
        "part-m7-hex",
        json!({ "primitive": "part", "partKind": "hex", "nominal": "M7", "origin": [0.0, 0.0, 0.0] }),
        "M7 is not in the ISO 4017 hex head screw table.",
    );
    refused(
        "part-m7-washer",
        json!({ "primitive": "part", "partKind": "washer", "nominal": "M7", "origin": [0.0, 0.0, 0.0] }),
        "M7 is not in the ISO 7089 washer table.",
    );
    refused(
        "part-washer-wall",
        json!({ "primitive": "part", "partKind": "washer", "nominal": "M6", "allowance": 6.0, "origin": [0.0, 0.0, 0.0] }),
        "The allowance leaves no wall on this washer.",
    );
    refused(
        "part-thread",
        json!({ "primitive": "part", "partKind": "nut", "nominal": "M6", "boreKind": "thread", "origin": [0.0, 0.0, 0.0] }),
        "A modelled thread is not available yet. Use tap drill.",
    );
}
