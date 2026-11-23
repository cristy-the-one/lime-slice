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
fn eight_by_eight_commits_under_100ms_and_reports_health() {
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
    assert!(ms < 100.0, "an 8x8 bicubic commit took {ms:.3} ms");
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
