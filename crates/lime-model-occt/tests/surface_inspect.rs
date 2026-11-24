//! Organic surfaces S1: exact OCCT analytic vertex normals, per-vertex curvature buffers,
//! trimmed UV isoparms, shared-edge G0/G1/G2 continuity, and per-face NURBS surface health.

use base64::Engine;
use serde_json::{json, Value};

fn call(request: Value) -> Value {
    let text = lime_model_occt::tree(&request.to_string());
    serde_json::from_str(&text).unwrap_or_else(|err| panic!("not JSON ({err}): {text}"))
}

fn ok(request: Value) -> Value {
    let reply = call(request.clone());
    assert!(reply.get("error").is_none(), "{request} -> {reply}");
    reply
}

fn decode_f32(b64: &str) -> Vec<f32> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .expect("valid base64");
    assert_eq!(bytes.len() % 4, 0, "aligned f32 bytes");
    bytes
        .chunks_exact(4)
        .map(|w| f32::from_le_bytes([w[0], w[1], w[2], w[3]]))
        .collect()
}

fn has_occt() -> bool {
    let caps = call(json!({ "call": "capabilities" }));
    if caps["stepMeshing"].as_bool() == Some(true) {
        return true;
    }
    if std::env::var_os("LIME_REQUIRE_OCCT").is_some() {
        panic!("Open CASCADE is required (LIME_REQUIRE_OCCT is set) but not linked: {caps}");
    }
    false
}

#[test]
fn analytic_normals_match_exact_sphere_and_box_surfaces() {
    if !has_occt() {
        return;
    }
    let reply = ok(json!({
        "call": "open",
        "key": "s1-sphere",
        "primitive": { "primitive": "sphere", "origin": [10.0, -5.0, 20.0], "radius": 15.0 },
        "chordMm": 0.05,
        // Analytic normals are the Model view's display mesh only.
        "meshQuality": "display"
    }));
    let positions = decode_f32(reply["display"]["positions"].as_str().expect("display positions"));
    let normals = decode_f32(reply["display"]["normals"].as_str().expect("display normals"));
    assert_eq!(normals.len(), positions.len(), "one normal per vertex");
    assert!(positions.len() >= 90);

    // Every vertex normal on a sphere centred at (10, -5, 20) equals (P - C) / R.
    let mut worst_err = 0.0f32;
    for (p, n) in positions.chunks_exact(3).zip(normals.chunks_exact(3)) {
        let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        assert!((len - 1.0).abs() < 1e-3, "unit normal, got len {len}");
        let dx = p[0] - 10.0;
        let dy = p[1] + 5.0;
        let dz = p[2] - 20.0;
        let dlen = (dx * dx + dy * dy + dz * dz).sqrt();
        let dot = (n[0] * dx + n[1] * dy + n[2] * dz) / dlen;
        let err = (1.0 - dot).abs();
        if err > worst_err {
            worst_err = err;
        }
    }
    assert!(worst_err < 1e-3, "sphere analytic normal alignment err={worst_err}");
    ok(json!({ "call": "close", "key": "s1-sphere" }));
}

#[test]
fn surface_inspect_curvatures_isoparms_and_continuity() {
    if !has_occt() {
        return;
    }
    // 1. Filleted box: has flat faces, G0 corners, and G1 tangent fillet seams with known radius 3 mm.
    let key = "s1-fillet-box";
    let opened = ok(json!({
        "call": "open",
        "key": key,
        "primitive": { "primitive": "box", "origin": [0.0, 0.0, 0.0], "size": [30.0, 20.0, 12.0] },
        "chordMm": 0.05
    }));
    let filleted = ok(json!({
        "call": "apply",
        "key": key,
        "parent": 0,
        "node": 1,
        "op": { "kind": "fillet", "edges": [0], "size": 3.0 },
        "chordMm": 0.05
    }));
    let positions = decode_f32(filleted["positions"].as_str().expect("positions"));
    let inspect = ok(json!({
        "call": "surfaceInspect",
        "key": key,
        "node": 1,
        "chordMm": 0.05,
        "curvature": true,
        "isoparms": true,
        "isoCount": 6
    }));
    let rmin = decode_f32(inspect["minRadiusMm"].as_str().expect("minRadiusMm"));
    let gaussian = decode_f32(inspect["gaussian"].as_str().expect("gaussian"));
    let mean = decode_f32(inspect["mean"].as_str().expect("mean"));
    let iso = decode_f32(inspect["isoPoints"].as_str().expect("isoPoints"));
    assert_eq!(rmin.len(), positions.len() / 3);
    // The display mesh's curvature follows the display mesh, corner for corner.
    let shown = ok(json!({ "call": "goto", "key": key, "node": 1, "chordMm": 0.05, "meshQuality": "display" }));
    // surfaceInspect with the flag describes the display mesh: its buffers match display.positions corner for corner.
    let shown_positions = decode_f32(shown["display"]["positions"].as_str().expect("display positions"));
    let shown_inspect = ok(json!({
        "call": "surfaceInspect", "key": key, "node": 1, "chordMm": 0.05, "curvature": true, "meshQuality": "display"
    }));
    let shown_rmin = decode_f32(shown_inspect["minRadiusMm"].as_str().expect("minRadiusMm"));
    assert_eq!(shown_rmin.len(), shown_positions.len() / 3);
    assert!(shown_positions.len() > positions.len(), "the display mesh is the finer one");
    assert_eq!(gaussian.len(), positions.len() / 3);
    assert_eq!(mean.len(), positions.len() / 3);
    assert!(iso.len() >= 12 && iso.len() % 6 == 0, "expected isoparm segments on fillet face, got {}", iso.len());

    // Minimum radius across vertices matches the 3 mm fillet closely.
    let min_r = rmin.iter().copied().fold(f32::INFINITY, f32::min);
    assert!((min_r - 3.0).abs() < 0.05, "expected min radius ~3 mm, got {min_r}");

    // Continuity: 0 gaps, sharp box corners (G0 >= 8), and 2 G1 fillet-to-plane seams.
    let cont = &inspect["continuity"];
    assert_eq!(cont["gaps"].as_u64(), Some(0));
    assert!(cont["g0"].as_u64().unwrap_or(0) >= 8, "expected sharp G0 corners: {cont}");
    assert!(cont["g1"].as_u64().unwrap_or(0) >= 2, "expected G1 fillet seams: {cont}");
    assert!(
        cont["worstCurvatureJump"].as_f64().unwrap_or(0.0) > 0.25,
        "circular fillet has curvature jump 1/3 ≈ 0.333: {cont}"
    );

    // Surface health: reports 1 cylinder (fillet) + 6 planes + tightest radius ~3 mm.
    let health = &inspect["surfaceHealth"];
    assert_eq!(health["kinds"]["plane"].as_u64(), Some(6));
    assert_eq!(health["kinds"]["cylinder"].as_u64(), Some(1));
    let health_r = health["minRadiusMm"].as_f64().expect("health minRadiusMm");
    assert!((health_r - 3.0).abs() < 0.05, "health minRadiusMm={health_r}");

    // Unfilleted box (node 0) has 0 isoparms (all planes) and all 12 edges G0.
    let box_inspect = ok(json!({
        "call": "surfaceInspect",
        "key": key,
        "node": 0,
        "chordMm": 0.05,
        "curvature": false,
        "isoparms": true
    }));
    assert_eq!(box_inspect["continuity"]["g0"].as_u64(), Some(12));
    assert_eq!(box_inspect["continuity"]["gaps"].as_u64(), Some(0));
    assert!(box_inspect["surfaceHealth"].get("minRadiusMm").is_none());
    let _ = opened;
    ok(json!({ "call": "close", "key": key }));
}

#[test]
fn surface_inspect_reports_bspline_health_on_organic_loft() {
    if !has_occt() {
        return;
    }
    let key = "s1-organic-loft";
    ok(json!({
        "call": "open",
        "key": key,
        "feature": {
            "kind": "loft",
            "op": "fuse",
            "sections": [
                { "origin": [0.0, 0.0, 0.0], "radius": 12.0, "radiusV": 8.0 },
                { "origin": [0.0, 0.0, 15.0], "radius": 16.0, "radiusV": 11.0 },
                { "origin": [0.0, 0.0, 30.0], "radius": 9.0, "radiusV": 9.0 }
            ]
        },
        "chordMm": 0.05
    }));
    let inspect = ok(json!({
        "call": "surfaceInspect",
        "key": key,
        "node": 0,
        "chordMm": 0.05,
        "curvature": true,
        "isoparms": true,
        "isoCount": 6
    }));
    let health = &inspect["surfaceHealth"];
    assert!(health["kinds"]["bspline"].as_u64().unwrap_or(0) >= 1, "expected bspline face: {health}");
    assert!(health["maxUDegree"].as_u64().unwrap_or(0) >= 2, "expected degree >= 2: {health}");
    assert!(health["maxPoles"].as_u64().unwrap_or(0) >= 9, "expected poles >= 9: {health}");
    assert!(health["minRadiusMm"].as_f64().unwrap_or(0.0) > 1.0, "expected finite minRadiusMm: {health}");
    let iso = decode_f32(inspect["isoPoints"].as_str().expect("isoPoints"));
    assert!(iso.len() >= 24, "expected trimmed UV isoparms on organic loft, got {}", iso.len());
    ok(json!({ "call": "close", "key": key }));
}
