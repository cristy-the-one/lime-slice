//! Organic surfaces S2: exact rational NURBS profile segments (`ProfileSegment::Nurbs`),
//! sharp knot-multiplicity creases, exact 3D NURBS spines, and real kernel `Op::Sweep`
//! (`BRepOffsetAPI_MakePipeShell`: sharp 90° round/right elbows, hollow pipes, Law_Interpol scale,
//! twist, and solid-edge spines).

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

fn decode_f32(b64: &str) -> Vec<f32> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .expect("valid base64");
    bytes
        .chunks_exact(4)
        .map(|w| f32::from_le_bytes([w[0], w[1], w[2], w[3]]))
        .collect()
}

#[test]
fn rational_nurbs_quarter_circle_extrude_is_exact_conic() {
    if !has_occt() {
        return;
    }
    let key = "s2-nurbs-quarter-circle";
    let w = std::f64::consts::FRAC_1_SQRT_2;
    // Quarter disk of radius 10 mm in XY, extruded 10 mm along +Z.
    let reply = ok(json!({
        "call": "open",
        "key": key,
        "feature": {
            "kind": "extrude",
            "op": "fuse",
            "origin": [0.0, 0.0, 0.0],
            "turn": [0.0, 0.0, 0.0],
            "depth": 10.0,
            "loops": [{
                "start": [0.0, 0.0],
                "segments": [
                    { "kind": "line", "to": [10.0, 0.0] },
                    { "kind": "nurbs", "poles": [[10.0, 10.0]], "weights": [1.0, w, 1.0], "degree": 2, "to": [0.0, 10.0] },
                    { "kind": "line", "to": [0.0, 0.0] }
                ]
            }]
        },
        "chordMm": 0.05
    }));
    let expected = std::f64::consts::PI * 100.0 * 0.25 * 10.0;
    let vol = reply["volumeMm3"].as_f64().expect("volume");
    assert!(
        (vol - expected).abs() < 0.05,
        "exact rational NURBS quarter disk volume expected {expected:.4}, got {vol:.4}"
    );
    // Verify surfaceInspect recognizes the rational B-spline face cleanly.
    let inspect = ok(json!({
        "call": "surfaceInspect",
        "key": key,
        "node": 0,
        "chordMm": 0.05,
        "curvature": false,
        "isoparms": false
    }));
    assert_eq!(inspect["surfaceHealth"]["rationalFaces"].as_u64(), Some(1));
    assert_eq!(inspect["continuity"]["gaps"].as_u64(), Some(0));
    let min_r = inspect["surfaceHealth"]["minRadiusMm"].as_f64().expect("minRadiusMm");
    assert!((min_r - 10.0).abs() < 0.05, "exact quarter-circle minRadiusMm expected 10.0, got {min_r}");
    // Verify every curved edge point on z=0 lies on exact radius 10.0000 mm (rational conic exactness).
    let pts = decode_f32(reply["edgePoints"].as_str().expect("edgePoints"));
    let mut curved_checked = 0usize;
    for p in pts.chunks_exact(3) {
        if p[2].abs() < 1e-3 && p[0] > 0.5 && p[1] > 0.5 {
            let r = (p[0] as f64).hypot(p[1] as f64);
            assert!((r - 10.0).abs() < 1e-4, "rational NURBS edge point ({}, {}) off exact circle: r={r}", p[0], p[1]);
            curved_checked += 1;
        }
    }
    assert!(curved_checked >= 8, "expected curved edge samples, got {curved_checked}");
    ok(json!({ "call": "close", "key": key }));
}

#[test]
fn cubic_nurbs_with_interior_knot_crease_extrudes_cleanly() {
    if !has_occt() {
        return;
    }
    let key = "s2-nurbs-crease";
    // Cubic NURBS with 7 total poles: start (0,0), 5 interior poles, end (20,0).
    // Interior knot at 0.5 has multiplicity 3 (= degree) -> C0 sharp crease at middle pole (10, 12)!
    let reply = ok(json!({
        "call": "open",
        "key": key,
        "feature": {
            "kind": "extrude",
            "op": "fuse",
            "origin": [0.0, 0.0, 0.0],
            "turn": [0.0, 0.0, 0.0],
            "depth": 6.0,
            "loops": [{
                "start": [0.0, 0.0],
                "segments": [
                    {
                        "kind": "nurbs",
                        "poles": [[2.0, 8.0], [6.0, 10.0], [10.0, 12.0], [14.0, 10.0], [18.0, 8.0]],
                        "degree": 3,
                        "knots": [0.0, 0.5, 1.0],
                        "mults": [4, 3, 4],
                        "to": [20.0, 0.0]
                    },
                    { "kind": "line", "to": [0.0, 0.0] }
                ]
            }]
        },
        "chordMm": 0.05
    }));
    let vol = reply["volumeMm3"].as_f64().expect("volume");
    assert!(vol > 500.0 && vol < 1500.0, "creased NURBS volume={vol}");
    // Verify the edge points pass directly through the crease apex (10, 12, 0).
    let pts = decode_f32(reply["edgePoints"].as_str().expect("edgePoints"));
    let near_apex = pts.chunks_exact(3).any(|p| {
        ((p[0] - 10.0).powi(2) + (p[1] - 12.0).powi(2) + p[2].powi(2)).sqrt() < 0.05
    });
    assert!(near_apex, "creased NURBS edge must hit the sharp apex (10, 12, 0)");
    ok(json!({ "call": "close", "key": key }));
}

#[test]
fn real_kernel_sweep_handles_sharp_90_deg_elbows_3d_nurbs_hollow_pipes_and_scale_law() {
    if !has_occt() {
        return;
    }

    // 1. 90° sharp L-bend elbow with RoundCorner AND RightCorner (no 25° refusal!).
    for (name, transition) in [("round", "round"), ("right", "right")] {
        let key = format!("s2-elbow-{name}");
        let reply = ok(json!({
            "call": "open",
            "key": key,
            "feature": {
                "kind": "sweep",
                "op": "fuse",
                "sections": [{
                    "origin": [0.0, 0.0, 0.0],
                    "turn": [0.0, 0.0, 0.0],
                    "radius": 4.0
                }],
                "spine": {
                    "kind": "polyline",
                    "points": [[0.0, 0.0, 0.0], [0.0, 0.0, 20.0], [20.0, 0.0, 20.0]]
                },
                "transition": transition
            },
            "chordMm": 0.05
        }));
        let vol = reply["volumeMm3"].as_f64().expect("elbow volume");
        // Two 20 mm legs of radius 4 mm (pi * 16 * 40 ≈ 2010 mm³ minus/plus corner).
        assert!(vol > 1800.0 && vol < 2300.0, "{name} 90-deg elbow volume={vol}");
        ok(json!({ "call": "close", "key": key }));
    }

    // 2. Exact 3D NURBS spine with solid rod vs hollow pipe (loop with hole).
    let spine_3d = json!({
        "kind": "nurbs",
        "poles": [
            [0.0, 0.0, 0.0],
            [0.0, 0.0, 15.0],
            [15.0, 10.0, 30.0],
            [30.0, 10.0, 30.0]
        ],
        "degree": 3
    });
    let solid_rod = ok(json!({
        "call": "open",
        "key": "s2-nurbs-rod",
        "feature": {
            "kind": "sweep",
            "op": "fuse",
            "sections": [{ "origin": [0.0, 0.0, 0.0], "turn": [0.0, 0.0, 0.0], "radius": 4.0 }],
            "spine": spine_3d
        },
        "chordMm": 0.05
    }));
    let rod_vol = solid_rod["volumeMm3"].as_f64().expect("rod vol");
    assert!(rod_vol > 1500.0, "3D NURBS swept rod vol={rod_vol}");

    // Hollow pipe using two circular loops (outer r=4, inner r=2 -> 3/4 the cross-sectional area!).
    let circle_loop = |r: f64| {
        json!({
            "start": [r, 0.0],
            "segments": [
                { "kind": "arc", "through": [0.0, r], "to": [-r, 0.0] },
                { "kind": "arc", "through": [0.0, -r], "to": [r, 0.0] }
            ]
        })
    };
    let hollow_pipe = ok(json!({
        "call": "open",
        "key": "s2-nurbs-pipe",
        "feature": {
            "kind": "sweep",
            "op": "fuse",
            "sections": [{
                "origin": [0.0, 0.0, 0.0],
                "turn": [0.0, 0.0, 0.0],
                "loops": [circle_loop(4.0), circle_loop(2.0)]
            }],
            "spine": spine_3d
        },
        "chordMm": 0.05
    }));
    let pipe_vol = hollow_pipe["volumeMm3"].as_f64().expect("pipe vol");
    let ratio = pipe_vol / rod_vol;
    assert!(
        (ratio - 0.75).abs() < 0.02,
        "hollow pipe volume ratio expected ~0.75, got {ratio:.4} (pipe={pipe_vol}, rod={rod_vol})"
    );
    ok(json!({ "call": "close", "key": "s2-nurbs-rod" }));
    ok(json!({ "call": "close", "key": "s2-nurbs-pipe" }));

    // 3. Scale law sweep via Law_Interpol: radius 5 mm -> 10 mm over 20 mm vertical spine.
    let tapered = ok(json!({
        "call": "open",
        "key": "s2-taper-sweep",
        "feature": {
            "kind": "sweep",
            "op": "fuse",
            "sections": [{ "origin": [0.0, 0.0, 0.0], "turn": [0.0, 0.0, 0.0], "radius": 5.0 }],
            "spine": { "kind": "polyline", "points": [[0.0, 0.0, 0.0], [0.0, 0.0, 20.0]] },
            "scale": [[0.0, 1.0], [1.0, 2.0]]
        },
        "chordMm": 0.05
    }));
    let expected_frustum = (20.0 * std::f64::consts::PI / 3.0) * (25.0 + 50.0 + 100.0);
    let taper_vol = tapered["volumeMm3"].as_f64().expect("taper vol");
    assert!(
        (taper_vol - expected_frustum).abs() < 5.0,
        "Law_Interpol tapered sweep volume expected {expected_frustum:.2}, got {taper_vol:.2}"
    );
    ok(json!({ "call": "close", "key": "s2-taper-sweep" }));

    // 4. Twisted square bar (6x6 square swept 30 mm with 90° smooth twist).
    let twisted = ok(json!({
        "call": "open",
        "key": "s2-twist-sweep",
        "feature": {
            "kind": "sweep",
            "op": "fuse",
            "sections": [{
                "origin": [0.0, 0.0, 0.0],
                "turn": [0.0, 0.0, 0.0],
                "profile": [[-3.0, -3.0], [3.0, -3.0], [3.0, 3.0], [-3.0, 3.0]]
            }],
            "spine": { "kind": "polyline", "points": [[0.0, 0.0, 0.0], [0.0, 0.0, 30.0]] },
            "twistDeg": 90.0
        },
        "chordMm": 0.05
    }));
    let twist_vol = twisted["volumeMm3"].as_f64().expect("twist vol");
    assert!(
        (twist_vol - 36.0 * 30.0).abs() < 5.0,
        "twisted 6x6x30 bar volume expected 1080, got {twist_vol:.2}"
    );
    ok(json!({ "call": "close", "key": "s2-twist-sweep" }));
}

#[test]
fn sweep_along_solid_edge_fuses_bead_onto_box() {
    if !has_occt() {
        return;
    }
    let key = "s2-solid-edge-sweep";
    let opened = ok(json!({
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
    }));
    // Find a top edge along +X at z=10, y=0 (endpoints [0, 0, 10] .. [20, 0, 10]).
    let epts = decode_f32(opened["edgePoints"].as_str().expect("edgePoints"));
    let eoffs_bytes = base64::engine::general_purpose::STANDARD
        .decode(opened["edgeOffsets"].as_str().expect("edgeOffsets"))
        .expect("valid base64");
    let eoffs: Vec<u32> = eoffs_bytes
        .chunks_exact(4)
        .map(|w| u32::from_le_bytes([w[0], w[1], w[2], w[3]]))
        .collect();
    let edge_idx = eoffs
        .windows(2)
        .position(|w| {
            let a = w[0] as usize * 3;
            let b = (w[1] as usize - 1) * 3;
            let mx = 0.5 * (epts[a] + epts[b]);
            let my = 0.5 * (epts[a + 1] + epts[b + 1]);
            let mz = 0.5 * (epts[a + 2] + epts[b + 2]);
            (mx - 10.0).abs() < 1e-2 && my.abs() < 1e-2 && (mz - 10.0).abs() < 1e-2
        })
        .expect("top front edge along +X");

    let applied = ok(json!({
        "call": "apply",
        "key": key,
        "parent": 0,
        "node": 1,
        "op": {
            "kind": "sweep",
            "op": "fuse",
            "sections": [{
                "origin": [0.0, 0.0, 10.0],
                "turn": [0.0, 90.0, 0.0],
                "radius": 2.0
            }],
            "spine": {
                "kind": "edges",
                "edges": [edge_idx]
            }
        },
        "chordMm": 0.05
    }));
    let vol = applied["volumeMm3"].as_f64().expect("volume");
    // Box is 4000 mm³; a r=2 bead along a 20 mm edge adds 3/4 * pi * 4 * 20 ≈ 188.5 mm³.
    assert!(
        (vol - (4000.0 + 0.75 * std::f64::consts::PI * 4.0 * 20.0)).abs() < 10.0,
        "edge-swept bead volume expected ~4188.5, got {vol:.2}"
    );
    ok(json!({ "call": "close", "key": key }));
}
