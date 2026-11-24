//! Organic surfaces Milestone S6: `Op::NurbsSurface` on Open CASCADE 7.9.2.
//! An 8×8 bicubic sheet, its health, the commit time, refusals, and Sew / Thicken / TrimSplit.

#![cfg(lime_occt)]

use lime_model_occt::tree;
use serde_json::{json, Value};

fn call(req: Value) -> Value {
    let raw = tree(&req.to_string());
    let out: Value = serde_json::from_str(&raw).expect("valid json reply");
    assert!(out.get("error").is_none(), "{req} -> {out}");
    out
}

fn call_raw(req: Value) -> Value {
    serde_json::from_str(&tree(&req.to_string())).expect("valid json reply")
}

fn grid(n: usize, bump: f64) -> Vec<Vec<[f64; 3]>> {
    (0..n)
        .map(|iu| {
            (0..n)
                .map(|iv| {
                    let x = (iu as f64 - (n as f64 - 1.0) / 2.0) * 10.0;
                    let y = (iv as f64 - (n as f64 - 1.0) / 2.0) * 10.0;
                    let edge = iu == 0 || iv == 0 || iu + 1 == n || iv + 1 == n;
                    [x, y, if edge { 0.0 } else { bump }]
                })
                .collect()
        })
        .collect()
}

fn feature(poles: Vec<Vec<[f64; 3]>>, extra: Value) -> Value {
    let mut body = json!({
        "kind": "nurbsSurface",
        "poles": poles,
        "degreeU": 3,
        "degreeV": 3
    });
    if let (Some(map), Some(extra)) = (body.as_object_mut(), extra.as_object()) {
        for (key, value) in extra {
            map.insert(key.clone(), value.clone());
        }
    }
    body
}

#[test]
fn eight_by_eight_commits_and_reports_health() {
    let key = "s6-nurbs-8";
    let started = std::time::Instant::now();
    let opened = call(json!({
        "call": "open",
        "key": key,
        "chordMm": 0.05,
        "feature": feature(grid(8, 2.0), json!({}))
    }));
    let ms = started.elapsed().as_secs_f64() * 1000.0;
    eprintln!("NURBS_COMMIT ms={ms:.3}");
    // A cap for a hang, not a speed test: this is a debug build on three operating systems. The app measures the
    // commit time where it matters.
    assert!(ms < 5000.0, "an 8x8 bicubic commit took {ms:.3} ms");
    assert_eq!(opened["solid"], json!(false), "a NURBS surface is a sheet: {opened}");
    assert!(opened["volumeMm3"].as_f64().unwrap_or(1.0).abs() < 1e-6, "a sheet has no volume: {opened}");
    assert!(opened.get("nakedEdges").is_some(), "the sheet has a boundary: {opened}");

    let inspect = call(json!({
        "call": "surfaceInspect",
        "key": key,
        "node": 0,
        "chordMm": 0.05,
        "curvature": false,
        "isoparms": false
    }));
    let health = &inspect["surfaceHealth"];
    eprintln!("NURBS_HEALTH {health}");
    assert_eq!(health["maxUDegree"].as_i64(), Some(3), "{health}");
    assert_eq!(health["maxVDegree"].as_i64(), Some(3), "{health}");
    assert_eq!(health["maxPoles"].as_i64(), Some(64), "{health}");
    assert_eq!(health["maxUSpans"].as_i64(), Some(5), "{health}");
    assert_eq!(health["maxVSpans"].as_i64(), Some(5), "{health}");
    assert_eq!(health["rationalFaces"].as_i64(), Some(0), "{health}");
    assert!(health["kinds"]["bspline"].as_i64().unwrap_or(0) >= 1, "{health}");
}

#[test]
fn weighted_surface_is_rational() {
    let mut weights = vec![vec![1.0; 4]; 4];
    weights[1][1] = 2.0;
    weights[2][2] = 0.5;
    let opened = call(json!({
        "call": "open",
        "key": "s6-nurbs-weight",
        "chordMm": 0.1,
        "feature": feature(grid(4, 1.0), json!({ "weights": weights }))
    }));
    assert_eq!(opened["solid"], json!(false));
    let inspect = call(json!({
        "call": "surfaceInspect",
        "key": "s6-nurbs-weight",
        "node": 0,
        "chordMm": 0.1
    }));
    assert!(inspect["surfaceHealth"]["rationalFaces"].as_i64().unwrap_or(0) >= 1, "{}", inspect["surfaceHealth"]);
}

#[test]
fn nurbs_sheet_sew_thicken_and_trim() {
    let key = "s6-nurbs-flow";
    call(json!({
        "call": "open",
        "key": key,
        "chordMm": 0.1,
        "feature": feature(grid(4, 3.0), json!({}))
    }));
    let sewn = call(json!({
        "call": "apply",
        "key": key,
        "parent": 0,
        "node": 1,
        "chordMm": 0.1,
        "op": { "kind": "sew", "makeSolid": true }
    }));
    assert_eq!(sewn["solid"], json!(false), "one open face stays a sheet: {sewn}");

    let thick = call(json!({
        "call": "apply",
        "key": key,
        "parent": 0,
        "node": 2,
        "chordMm": 0.1,
        "op": { "kind": "thicken", "thickness": 1.0, "direction": "both" }
    }));
    assert_eq!(thick["solid"], json!(true), "thicken makes a solid: {thick}");
    assert!(thick["volumeMm3"].as_f64().unwrap_or(0.0) > 1.0, "the wall has volume: {thick}");

    let sheet_key = "s6-nurbs-trim";
    call(json!({
        "call": "open",
        "key": sheet_key,
        "chordMm": 0.1,
        "feature": feature(grid(4, 4.0), json!({}))
    }));
    let cut = call(json!({
        "call": "apply",
        "key": sheet_key,
        "parent": 0,
        "node": 1,
        "chordMm": 0.1,
        "op": {
            "kind": "trimSplit",
            "keep": "above",
            "sheet": {
                "mode": "planar",
                "curves": [{
                    "kind": "polyline",
                    "points": [[-40.0, -40.0, 1.0], [40.0, -40.0, 1.0], [40.0, 40.0, 1.0], [-40.0, 40.0, 1.0]],
                    "closed": true
                }]
            }
        }
    }));
    assert_eq!(cut["solid"], json!(false), "trimming a sheet keeps a sheet: {cut}");
    assert!(cut["fingerprint"]["faces"].as_i64().unwrap_or(0) >= 1, "the cut keeps a face: {cut}");
}

#[test]
fn nurbs_refusals_are_plain_sentences() {
    let few = call_raw(json!({
        "call": "open",
        "key": "s6-few",
        "feature": { "kind": "nurbsSurface", "poles": grid(3, 0.0), "degreeU": 3, "degreeV": 3 }
    }));
    let knots = call_raw(json!({
        "call": "open",
        "key": "s6-knots",
        "feature": feature(grid(4, 0.0), json!({ "knotsU": [0.0, 0.0], "multsU": [1, 1] }))
    }));
    let mut weights = vec![vec![1.0; 4]; 4];
    weights[0][0] = 0.0;
    let weight = call_raw(json!({
        "call": "open",
        "key": "s6-weight",
        "feature": feature(grid(4, 0.0), json!({ "weights": weights }))
    }));
    eprintln!("NURBS_REFUSAL {}", few["error"]);
    eprintln!("NURBS_REFUSAL {}", knots["error"]);
    eprintln!("NURBS_REFUSAL {}", weight["error"]);
    assert_eq!(few["error"], "This surface needs at least 4 poles in U for degree 3.");
    assert_eq!(
        knots["error"],
        "The U knots do not match this surface. They must increase, and their multiplicities must add up to the poles and the degree."
    );
    assert_eq!(
        weight["error"],
        "A weight on this surface is 0 or less. Every weight has to be greater than 0."
    );
}

/// The limits the app and the MCP check, held by the kernel too: each refused with its own sentence.
#[test]
fn nurbs_limits_are_refused_by_the_kernel() {
    let refused = |name: &str, body: Value| -> String {
        let reply = call_raw(json!({ "call": "open", "key": format!("s6-limit-{name}"), "feature": body }));
        let error = reply["error"].as_str().unwrap_or("").to_string();
        println!("{name}: {error}");
        assert!(!error.is_empty(), "{name} must be refused: {reply}");
        error
    };
    let mut ring6 = Vec::new();
    for iu in 0..2 {
        ring6.push((0..4).map(|iv| [iu as f64 * 10.0, iv as f64 * 10.0, 0.0]).collect::<Vec<_>>());
    }
    assert_eq!(
        refused("degree", json!({ "kind": "nurbsSurface", "poles": grid(10, 0.0), "degreeU": 9, "degreeV": 3 })),
        "A NURBS surface's degree is at most 8."
    );
    let tall: Vec<Vec<[f64; 3]>> = (0..65).map(|iu| (0..4).map(|iv| [iu as f64, iv as f64, 0.0]).collect()).collect();
    assert_eq!(
        refused("poles", json!({ "kind": "nurbsSurface", "poles": tall, "degreeU": 3, "degreeV": 3 })),
        "A NURBS surface has at most 64 poles in each direction."
    );
    assert_eq!(
        refused("periodic", json!({ "kind": "nurbsSurface", "poles": ring6, "degreeU": 1, "degreeV": 3, "periodicU": true })),
        "A surface closed in U needs at least 3 poles in U."
    );
    let many: Vec<[f64; 2]> = (0..33).map(|i| [0.01 + 0.02 * f64::from(i), 1.0]).collect();
    assert_eq!(
        refused("inserts", feature(grid(6, 1.0), json!({ "insertU": many }))),
        "A NURBS surface takes at most 32 knot inserts in U; it has 33."
    );
    for (name, times) in [("times0", 0.0), ("times-half", 1.5)] {
        assert_eq!(
            refused(name, feature(grid(6, 1.0), json!({ "insertU": [[0.5, times]] }))),
            "The U knots do not match this surface. They must increase, and their multiplicities must add up to the poles and the degree."
        );
    }
    assert_eq!(
        refused("times-over", feature(grid(6, 1.0), json!({ "insertU": [[0.5, 4.0]] }))),
        "A knot insert in U is 1 to 3 times, a whole number."
    );
    assert_eq!(
        refused("zero-degree", feature(grid(6, 1.0), json!({ "degreeU": 0 }))),
        "This NURBS surface could not be built."
    );
    let ring: Vec<Vec<[f64; 3]>> = (0..6)
        .map(|iu| {
            let a = std::f64::consts::TAU * iu as f64 / 6.0;
            (0..4).map(|iv| [10.0 * a.cos(), 10.0 * a.sin(), iv as f64 * 5.0]).collect()
        })
        .collect();
    assert_eq!(
        refused("closed-insert", json!({ "kind": "nurbsSurface", "poles": ring, "degreeU": 3, "degreeV": 3, "periodicU": true, "insertV": [[0.5, 1.0]] })),
        "Knot insertion and degree elevation are for a clamped NURBS surface, not a closed one."
    );
    assert_eq!(
        refused("at-end", feature(grid(6, 1.0), json!({ "insertV": [[1.0, 1.0]] }))),
        "A knot insert in V must lie strictly inside the knot range, 0 to 1."
    );
    assert_eq!(
        refused("full", feature(grid(6, 1.0), json!({ "insertU": [[0.5, 2.0], [0.5, 2.0]] }))),
        "Inserting the U knot 0.5 2 times would give it multiplicity 4, past its full multiplicity 3."
    );
    assert_eq!(
        refused("elevate", feature(grid(6, 1.0), json!({ "elevateU": 9 }))),
        "A NURBS surface's degree is at most 8."
    );
    assert_eq!(
        refused("mults", feature(grid(4, 0.0), json!({ "knotsU": [0.0, 1.0], "multsU": [5, 3] }))),
        "The U knots do not match this surface. They must increase, and their multiplicities must add up to the poles and the degree."
    );
}

/// A surface closed in U (six poles round a circle, cubic): it builds as a periodic sheet.
#[test]
fn a_periodic_surface_builds() {
    let ring: Vec<Vec<[f64; 3]>> = (0..6)
        .map(|iu| {
            let a = std::f64::consts::TAU * iu as f64 / 6.0;
            (0..4).map(|iv| [10.0 * a.cos(), 10.0 * a.sin(), iv as f64 * 5.0]).collect()
        })
        .collect();
    let opened = call(json!({ "call": "open", "key": "s6-periodic", "chordMm": 0.1,
        "feature": { "kind": "nurbsSurface", "poles": ring, "degreeU": 3, "degreeV": 3, "periodicU": true } }));
    assert_eq!(opened["solid"], json!(false), "{opened}");
    // A tube open at both ends: two naked rims.
    let naked = opened["nakedEdges"].as_array().map(Vec::len).unwrap_or(0);
    assert_eq!(naked, 2, "a periodic tube has its two rims open: {opened}");
    call(json!({ "call": "close", "key": "s6-periodic" }));
}

/// An open clamped sheet has exactly its four boundary edges open.
#[test]
fn a_clamped_sheet_has_four_naked_edges() {
    let opened = call(json!({ "call": "open", "key": "s6-naked", "chordMm": 0.1, "feature": feature(grid(8, 2.0), json!({})) }));
    assert_eq!(opened["nakedEdges"].as_array().map(Vec::len), Some(4), "{opened}");
    call(json!({ "call": "close", "key": "s6-naked" }));
}

/// A flat 30 x 30 mm sheet thickened 1 mm both ways is a 30 x 30 x 1 slab: 900 mm³.
#[test]
fn a_flat_sheet_thickens_to_its_closed_form_volume() {
    let key = "s6-thicken-flat";
    call(json!({ "call": "open", "key": key, "chordMm": 0.1, "feature": feature(grid(4, 0.0), json!({})) }));
    let thick = call(json!({ "call": "apply", "key": key, "parent": 0, "node": 1, "chordMm": 0.1,
        "op": { "kind": "thicken", "thickness": 1.0, "direction": "both" } }));
    let volume = thick["volumeMm3"].as_f64().unwrap_or(0.0);
    println!("flat sheet thickened: {volume} mm³ (900 expected)");
    assert!((volume - 900.0).abs() <= 1e-6 * 900.0, "{volume}");
    call(json!({ "call": "close", "key": key }));
}

/// Knot insertion and degree elevation, as the op applies them, leave the surface where it was: the committed surface
/// evaluated at a 7 x 7 grid of parameters against the plain one, within 1e-9 mm.
#[cfg(lime_occt_test_hooks)]
#[test]
fn insert_and_elevate_keep_the_shape() {
    let poles = grid(6, 3.0);
    let params: Vec<[f64; 2]> = (0..7).flat_map(|i| (0..7).map(move |j| [f64::from(i) / 6.0, f64::from(j) / 6.0])).collect();
    let eval = |extra: Value| -> Vec<[f64; 3]> {
        let mut surface = json!({ "poles": poles, "degreeU": 3, "degreeV": 3, "params": params });
        for (key, value) in extra.as_object().expect("object") {
            surface[key] = value.clone();
        }
        let reply = call(json!({ "call": "evalNurbs", "surface": surface }));
        serde_json::from_value(reply["points"].clone()).expect("points")
    };
    let plain = eval(json!({}));
    for extra in [
        json!({ "insertU": [[0.37, 1.0], [0.37, 1.0]], "insertV": [[0.61, 2.0]] }),
        json!({ "elevateU": 5, "elevateV": 4 }),
        json!({ "insertU": [[0.25, 1.0]], "elevateV": 6 }),
    ] {
        let changed = eval(extra.clone());
        let worst = plain
            .iter()
            .zip(&changed)
            .map(|(a, b)| ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt())
            .fold(0.0_f64, f64::max);
        println!("{extra}: worst {worst:e} mm");
        assert!(worst <= 1e-9, "{extra} moved the surface {worst} mm");
    }
}
