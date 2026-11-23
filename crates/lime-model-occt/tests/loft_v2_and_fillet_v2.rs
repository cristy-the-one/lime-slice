//! Organic surfaces S3: Variable-radius, exact G2 curvature-continuous, and exact Conic-rho fillets
//! (`Op::Fillet` v2) + Controlled `Op::Loft` v2 (point apex caps, start/end boundary conditions,
//! closed periodic lofts, degree caps, and 3D NURBS guide rails).

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

/// The worst normal angle and curvature jump on edges the kernel already classed as G2.
/// The jump bound is the classifier's own G2 threshold, 1e-3 mm^-1.
fn g2_edge_bounds(inspect: &Value) -> (f64, f64) {
    let mut angle: f64 = 0.0;
    let mut jump: f64 = 0.0;
    let mut seen = 0;
    let rows = inspect["continuity"]["edges"].as_array().cloned().unwrap_or_default();
    for row in rows {
        if row["kind"].as_str() != Some("G2") {
            continue;
        }
        seen += 1;
        angle = angle.max(row["angleDeg"].as_f64().unwrap_or(99.0));
        jump = jump.max(row["curvatureJump"].as_f64().unwrap_or(99.0));
    }
    if seen < 2 {
        return (99.0, 99.0);
    }
    (angle, jump)
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

fn find_top_front_edge(opened: &Value) -> usize {
    let decode_bytes = |b64: &str| {
        base64::engine::general_purpose::STANDARD
            .decode(b64)
            .expect("valid base64")
    };
    let epts: Vec<f32> = decode_bytes(opened["edgePoints"].as_str().expect("edgePoints"))
        .chunks_exact(4)
        .map(|w| f32::from_le_bytes([w[0], w[1], w[2], w[3]]))
        .collect();
    let eoffs: Vec<u32> = decode_bytes(opened["edgeOffsets"].as_str().expect("edgeOffsets"))
        .chunks_exact(4)
        .map(|w| u32::from_le_bytes([w[0], w[1], w[2], w[3]]))
        .collect();
    eoffs
        .windows(2)
        .position(|w| {
            let a = w[0] as usize * 3;
            let b = (w[1] as usize - 1) * 3;
            let mx = 0.5 * (epts[a] + epts[b]);
            let my = 0.5 * (epts[a + 1] + epts[b + 1]);
            let mz = 0.5 * (epts[a + 2] + epts[b + 2]);
            (mx - 10.0).abs() < 1e-2 && my.abs() < 1e-2 && (mz - 10.0).abs() < 1e-2
        })
        .expect("top front edge along +X")
}

/// The fillet's own seam edges, found by where they lie, not by the class model_check assigned.
/// A constant or variable fillet of the box's top-front edge leaves one seam on the top face
/// (z = 10, y inset) and one on the front face (y = 0, z inset), both running along X.
fn fillet_own_seams(shaped: &Value) -> Vec<usize> {
    let decode_bytes = |b64: &str| {
        base64::engine::general_purpose::STANDARD
            .decode(b64)
            .unwrap_or_default()
    };
    let Some(points_b64) = shaped["edgePoints"].as_str() else {
        return Vec::new();
    };
    let Some(offs_b64) = shaped["edgeOffsets"].as_str() else {
        return Vec::new();
    };
    let points: Vec<f32> = decode_bytes(points_b64)
        .chunks_exact(4)
        .map(|w| f32::from_le_bytes([w[0], w[1], w[2], w[3]]))
        .collect();
    let offsets: Vec<u32> = decode_bytes(offs_b64)
        .chunks_exact(4)
        .map(|w| u32::from_le_bytes([w[0], w[1], w[2], w[3]]))
        .collect();
    let mut seams = Vec::new();
    for (index, window) in offsets.windows(2).enumerate() {
        let start = window[0] as usize;
        let end = window[1] as usize;
        if end <= start + 1 {
            continue;
        }
        let mut min_x = f32::MAX;
        let mut max_x = f32::MIN;
        let mut on_top = true;
        let mut on_front = true;
        for i in start..end {
            let base = i * 3;
            if base + 2 >= points.len() {
                on_top = false;
                on_front = false;
                break;
            }
            let x = points[base];
            let y = points[base + 1];
            let z = points[base + 2];
            min_x = min_x.min(x);
            max_x = max_x.max(x);
            if !((z - 10.0).abs() < 0.15 && y > 0.2 && y < 19.8) {
                on_top = false;
            }
            if !(y.abs() < 0.15 && z > 0.2 && z < 9.8) {
                on_front = false;
            }
        }
        if max_x - min_x > 10.0 && (on_top || on_front) {
            seams.push(index);
        }
    }
    seams
}

fn assert_fillet_seams(case_name: &str, shaped: &Value, inspect: &Value) {
    let seams = fillet_own_seams(shaped);
    let rows = inspect["continuity"]["edges"].as_array().cloned().unwrap_or_default();
    assert!(
        seams.len() >= 2,
        "S5 fillet {case_name} expected its two seam edges by geometry, got {seams:?}"
    );
    for id in seams {
        let Some(row) = rows.iter().find(|row| row["edge"].as_u64() == Some(id as u64)) else {
            panic!("S5 fillet {case_name} edge {id} is missing from continuity.edges");
        };
        let kind = row["kind"].as_str().unwrap_or("");
        let angle = row["angleDeg"].as_f64().unwrap_or(99.0);
        let jump = row["curvatureJump"].as_f64().unwrap_or(99.0);
        println!("S5 fillet {case_name} edge={id} kind={kind} angleDeg={angle} curvatureJump={jump}");
        assert!(
            kind == "G2" && angle < 0.1 && jump <= 1e-3,
            "S5 fillet {case_name} edge {id} must be G2 with angle under 0.1° and curvature jump within 1e-3 mm^-1, got kind={kind} angleDeg={angle} curvatureJump={jump}"
        );
    }
}

fn open_box(key: &str) -> Value {
    ok(json!({
        "call": "open",
        "key": key,
        "primitive": {
            "primitive": "box",
            "origin": [0.0, 0.0, 0.0],
            "size": [20.0, 20.0, 10.0],
            "radius": 0.0,
            "height": 0.0,
            "turn": [0.0, 0.0, 0.0]
        },
        "chordMm": 0.05
    }))
}

#[test]
fn variable_radius_g1_fillet_builds_clean_watertight_taper() {
    if !has_occt() {
        return;
    }
    let key = "s3-var-g1-fillet";
    let opened = open_box(key);
    let edge = find_top_front_edge(&opened);

    let applied = ok(json!({
        "call": "apply",
        "key": key,
        "parent": 0,
        "node": 1,
        "op": {
            "kind": "fillet",
            "edges": [edge],
            "size": 2.0,
            "continuity": "g1",
            "variable": [[0.0, 1.0], [0.5, 3.5], [1.0, 1.5]]
        },
        "chordMm": 0.05
    }));
    let vol = applied["volumeMm3"].as_f64().expect("volume");
    // Box is 4000 mm³; variable fillet with average r~2.5 mm over 20 mm removes ~(1 - pi/4)*r^2*20 ≈ 20..50 mm³.
    assert!(
        vol < 3985.0 && vol > 3900.0,
        "variable G1 fillet volume={vol:.2}"
    );
    let inspect = ok(json!({
        "call": "surfaceInspect",
        "key": key,
        "node": 1,
        "chordMm": 0.05,
        "curvature": false,
        "isoparms": false
    }));
    assert_eq!(inspect["continuity"]["gaps"].as_u64(), Some(0));
    ok(json!({ "call": "close", "key": key }));
}

#[test]
fn g2_smooth_fillet_achieves_exact_g2_continuity_on_constant_and_variable_edges() {
    if !has_occt() {
        return;
    }
    // 1. Constant-radius G2 quintic NURBS fillet.
    let key = "s3-g2-const";
    let opened = open_box(key);
    let edge = find_top_front_edge(&opened);
    let applied = ok(json!({
        "call": "apply",
        "key": key,
        "parent": 0,
        "node": 1,
        "op": {
            "kind": "fillet",
            "edges": [edge],
            "size": 3.0,
            "continuity": "g2"
        },
        "chordMm": 0.05
    }));
    let vol = applied["volumeMm3"].as_f64().expect("g2 volume");
    assert!(vol < 3970.0 && vol > 3850.0, "G2 fillet volume={vol:.2}");

    let inspect = ok(json!({
        "call": "surfaceInspect",
        "key": key,
        "node": 1,
        "chordMm": 0.05,
        "curvature": false,
        "isoparms": false
    }));
    assert_eq!(inspect["continuity"]["gaps"].as_u64(), Some(0));
    let g2_edges = inspect["continuity"]["g2"].as_u64().unwrap_or(0);
    assert!(
        g2_edges >= 2,
        "G2 fillet must achieve true G2 continuity along both blend seams, got inspect={inspect}"
    );
    let worst_angle = inspect["continuity"]["worstSmoothAngleDeg"]
        .as_f64()
        .unwrap_or(99.0);
    let (g2_angle, g2_jump) = g2_edge_bounds(&inspect);
    println!("S5 fillet constant g2Edges={g2_edges} worstSmoothAngleDeg={worst_angle} g2AngleDeg={g2_angle} g2CurvatureJump={g2_jump}");
    assert_fillet_seams("constant", &applied, &inspect);
    assert!(
        worst_angle < 0.1,
        "G2 seam normal angle expected < 0.1°, got {worst_angle}"
    );
    assert!(
        g2_angle < 0.1 && g2_jump <= 1e-3,
        "constant G2 fillet curvature jump must stay within 1e-3 mm^-1 and the normal angle under 0.1°, got angle={g2_angle} jump={g2_jump}"
    );
    ok(json!({ "call": "close", "key": key }));

    // 2. Variable-radius G2 fillet (1.5 mm -> 3.5 mm).
    let key_v = "s3-g2-var";
    let opened_v = open_box(key_v);
    let edge_v = find_top_front_edge(&opened_v);
    let applied_v = ok(json!({
        "call": "apply",
        "key": key_v,
        "parent": 0,
        "node": 1,
        "op": {
            "kind": "fillet",
            "edges": [edge_v],
            "size": 2.0,
            "continuity": "g2",
            "variable": [[0.0, 1.5], [1.0, 3.5]]
        },
        "chordMm": 0.05
    }));
    let vol_v = applied_v["volumeMm3"].as_f64().expect("var g2 volume");
    assert!(vol_v < 3985.0 && vol_v > 3850.0, "variable G2 volume={vol_v:.2}");
    let inspect_v = ok(json!({
        "call": "surfaceInspect",
        "key": key_v,
        "node": 1,
        "chordMm": 0.05,
        "curvature": false,
        "isoparms": false
    }));
    assert_eq!(inspect_v["continuity"]["gaps"].as_u64(), Some(0));
    let g2_var = inspect_v["continuity"]["g2"].as_u64().unwrap_or(0);
    let worst_var = inspect_v["continuity"]["worstSmoothAngleDeg"].as_f64().unwrap_or(99.0);
    let (g2_angle_v, g2_jump_v) = g2_edge_bounds(&inspect_v);
    println!("S5 fillet variable g2Edges={g2_var} worstSmoothAngleDeg={worst_var} g2AngleDeg={g2_angle_v} g2CurvatureJump={g2_jump_v}");
    assert_fillet_seams("variable", &applied_v, &inspect_v);
    assert!(
        g2_var >= 2,
        "variable G2 fillet should preserve G2 continuity along both seams: {inspect_v}"
    );
    assert!(
        worst_var < 0.1 && g2_angle_v < 0.1 && g2_jump_v <= 1e-3,
        "variable G2 fillet must keep the normal angle under 0.1° and the curvature jump within 1e-3 mm^-1, got angle={g2_angle_v} jump={g2_jump_v}"
    );
    ok(json!({ "call": "close", "key": key_v }));
}

#[test]
fn conic_rho_fillet_varies_fullness_and_is_exact_rational_nurbs() {
    if !has_occt() {
        return;
    }
    let mut vols = Vec::new();
    for (tag, rho) in [("flat", 0.25), ("sharp", 0.75)] {
        let key = format!("s3-conic-{tag}");
        let opened = open_box(&key);
        let edge = find_top_front_edge(&opened);
        let applied = ok(json!({
            "call": "apply",
            "key": key,
            "parent": 0,
            "node": 1,
            "op": {
                "kind": "fillet",
                "edges": [edge],
                "size": 3.0,
                "continuity": "conic",
                "rho": rho
            },
            "chordMm": 0.05
        }));
        let vol = applied["volumeMm3"].as_f64().expect("conic volume");
        vols.push(vol);
        let inspect = ok(json!({
            "call": "surfaceInspect",
            "key": key,
            "node": 1,
            "chordMm": 0.05,
            "curvature": false,
            "isoparms": false
        }));
        assert_eq!(inspect["continuity"]["gaps"].as_u64(), Some(0));
        assert!(
            inspect["surfaceHealth"]["rationalFaces"].as_u64().unwrap_or(0) >= 1,
            "conic fillet (rho={rho}) must be exact rational NURBS: {inspect}"
        );
        ok(json!({ "call": "close", "key": key }));
    }
    // Larger rho pulls the conic closer to the sharp corner -> larger remaining solid volume.
    assert!(
        vols[1] > vols[0] + 10.0,
        "rho=0.75 should keep more corner volume than rho=0.25: flat={:.2}, sharp={:.2}",
        vols[0],
        vols[1]
    );
}

#[test]
fn controlled_loft_v2_supports_apex_caps_tangency_closed_periodic_and_3d_nurbs_guide_rails() {
    if !has_occt() {
        return;
    }

    // 1. Point-apex smooth nose cone (circle r=10 at z=0 -> circle r=6 at z=12 -> apex [0,0,22]).
    let apex_loft = ok(json!({
        "call": "open",
        "key": "s3-loft-apex",
        "feature": {
            "kind": "loft",
            "op": "fuse",
            "sections": [
                { "origin": [0.0, 0.0, 0.0], "turn": [0.0, 0.0, 0.0], "radius": 10.0 },
                { "origin": [0.0, 0.0, 12.0], "turn": [0.0, 0.0, 0.0], "radius": 6.0 },
                { "origin": [0.0, 0.0, 22.0], "apex": [0.0, 0.0, 22.0] }
            ],
            "smoothing": true,
            "maxDegree": 5
        },
        "chordMm": 0.05
    }));
    let apex_vol = apex_loft["volumeMm3"].as_f64().expect("apex vol");
    assert!(apex_vol > 2000.0 && apex_vol < 5000.0, "apex nose cone vol={apex_vol:.1}");
    ok(json!({ "call": "close", "key": "s3-loft-apex" }));

    // 2. Start/End normal tangency loft (barrel bulge vs straight ruled cone).
    let tangent_loft = ok(json!({
        "call": "open",
        "key": "s3-loft-tangent",
        "feature": {
            "kind": "loft",
            "op": "fuse",
            "sections": [
                { "origin": [0.0, 0.0, 0.0], "turn": [0.0, 0.0, 0.0], "radius": 10.0 },
                { "origin": [0.0, 0.0, 20.0], "turn": [0.0, 0.0, 0.0], "radius": 5.0 }
            ],
            "startCondition": { "kind": "normal", "tension": 1.2 },
            "endCondition": { "kind": "curvature", "tension": 1.0 }
        },
        "chordMm": 0.05
    }));
    let tan_vol = tangent_loft["volumeMm3"].as_f64().expect("tangent loft vol");
    assert!(tan_vol > 2500.0 && tan_vol < 5000.0, "tangent loft vol={tan_vol:.1}");
    ok(json!({ "call": "close", "key": "s3-loft-tangent" }));

    // 3. Closed periodic torus-ring loft (4 circular sections around a ring of R=20, tube r=4).
    let closed_loft = ok(json!({
        "call": "open",
        "key": "s3-loft-closed",
        "feature": {
            "kind": "loft",
            "op": "fuse",
            "closed": true,
            "sections": [
                { "origin": [20.0, 0.0, 0.0], "turn": [90.0, 0.0, 0.0], "radius": 4.0 },
                { "origin": [0.0, 20.0, 0.0], "turn": [90.0, 0.0, 90.0], "radius": 4.0 },
                { "origin": [-20.0, 0.0, 0.0], "turn": [90.0, 0.0, 180.0], "radius": 4.0 },
                { "origin": [0.0, -20.0, 0.0], "turn": [90.0, 0.0, -90.0], "radius": 4.0 }
            ]
        },
        "chordMm": 0.05
    }));
    let ring_vol = closed_loft["volumeMm3"].as_f64().expect("closed ring vol");
    // Exact torus volume 2 * pi^2 * 20 * 16 ≈ 6316 mm³.
    assert!(ring_vol > 4500.0 && ring_vol < 8500.0, "closed periodic loft vol={ring_vol:.1}");
    ok(json!({ "call": "close", "key": "s3-loft-closed" }));

    // 4. 3D NURBS guide-rail loft: two r=8 circles at z=0 and z=20 bulged outward to r=15 by a NURBS guide rail!
    let guided = ok(json!({
        "call": "open",
        "key": "s3-loft-guided",
        "feature": {
            "kind": "loft",
            "op": "fuse",
            "sections": [
                { "origin": [0.0, 0.0, 0.0], "turn": [0.0, 0.0, 0.0], "radius": 8.0 },
                { "origin": [0.0, 0.0, 20.0], "turn": [0.0, 0.0, 0.0], "radius": 8.0 }
            ],
            "guides": [{
                "kind": "nurbs",
                "poles": [[8.0, 0.0, 0.0], [18.0, 0.0, 7.0], [18.0, 0.0, 13.0], [8.0, 0.0, 20.0]],
                "degree": 3
            }]
        },
        "chordMm": 0.05
    }));
    let plain_cyl = std::f64::consts::PI * 64.0 * 20.0; // ~4021 mm³
    let guided_vol = guided["volumeMm3"].as_f64().expect("guided loft vol");
    assert!(
        guided_vol > plain_cyl + 2000.0,
        "3D NURBS guide rail should visibly bulge loft past straight cylinder ({plain_cyl:.0}), got {guided_vol:.0}"
    );
    ok(json!({ "call": "close", "key": "s3-loft-guided" }));
}
