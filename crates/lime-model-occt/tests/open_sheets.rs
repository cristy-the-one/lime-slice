//! Organic surfaces Milestone S4 real Open CASCADE 7.9.2 tests:
//! - Open Sheets (`Op::Sheet`: extrude, revolve, loft, planar) with `solid: false` and `nakedEdges`
//! - `Op::Sew` (multi-sheet box & `capPlanar` auto-promotion to watertight solid with 0 naked edges)
//! - `Op::Thicken` (sculpted double-curved NURBS roof thickened into a watertight solid, normal & both)
//! - `Op::TrimSplit` (sculpted NURBS wave roof splitting a solid cleanly into above/below/both)
//! - `Op::TrimSplit` of a sheet keeps the cut piece, and a replay rebuilds that sheet
//! - `Op::ReplaceFace` (replacing a flat box top with a sculpted arching NURBS dome roof)
//! - `Op::SplitFace` (imprinting an exact NURBS curve onto a face, dividing it with volume preserved)
//! - Solid-only ops cleanly refused on an open sheet while sheet ops run directly on it.

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
    let raw = tree(&req.to_string());
    serde_json::from_str(&raw).expect("valid json reply")
}

/// Sculpted double-curved NURBS roof sheet spanning [-15..15] x [-15..15] around height `z_base`,
/// arching upward by `arch_z` in the center so it clearly cuts or caps a 20x20 box.
fn sculpted_nurbs_roof(z_base: f64, arch_z: f64) -> Value {
    json!({
        "mode": "loft",
        "curves": [
            {
                "kind": "nurbs",
                "poles": [[-15.0, -15.0, z_base], [0.0, -15.0, z_base + arch_z * 0.5], [15.0, -15.0, z_base]],
                "degree": 2
            },
            {
                "kind": "nurbs",
                "poles": [[-15.0, 0.0, z_base + arch_z * 0.5], [0.0, 0.0, z_base + arch_z], [15.0, 0.0, z_base + arch_z * 0.5]],
                "degree": 2
            },
            {
                "kind": "nurbs",
                "poles": [[-15.0, 15.0, z_base], [0.0, 15.0, z_base + arch_z * 0.5], [15.0, 15.0, z_base]],
                "degree": 2
            }
        ]
    })
}

#[test]
fn open_nurbs_sheet_builds_with_naked_edges_refuses_solid_ops_and_thickens_watertight() {
    let key = "s4-nurbs-sheet-thicken";
    let roof = sculpted_nurbs_roof(10.0, 5.0);

    // 1. Open as feature root -> open Sheet (solid: false, 4 naked border edges, 1 NURBS face).
    let open = call(json!({
        "call": "open",
        "key": key,
        "chordMm": 0.05,
        "feature": {
            "kind": "sheet",
            "mode": roof["mode"],
            "curves": roof["curves"]
        }
    }));
    assert_eq!(open["solid"], json!(false), "open sheet must report solid: false");
    let naked = open["nakedEdges"].as_array().expect("open sheet must list nakedEdges");
    assert_eq!(naked.len(), 4, "4-sided open NURBS sheet should have 4 naked boundary edges: {naked:?}");
    assert_eq!(open["fingerprint"]["faces"], json!(1));

    // 2. Solid-only op (Fillet) on an open sheet is cleanly refused.
    let refused = call_raw(json!({
        "call": "apply",
        "key": key,
        "parent": 0,
        "node": 99,
        "chordMm": 0.05,
        "op": { "kind": "fillet", "edges": [0], "size": 1.0 }
    }));
    assert!(refused.get("error").is_some(), "fillet on open sheet should refuse: {refused}");

    // 3. Thicken (normal, +2.5 mm) turns the sculpted NURBS roof into a watertight solid with 0 naked edges!
    let thick = call(json!({
        "call": "apply",
        "key": key,
        "parent": 0,
        "node": 1,
        "chordMm": 0.05,
        "op": { "kind": "thicken", "thickness": 2.5, "direction": "normal" }
    }));
    assert_eq!(thick["solid"], json!(true), "thickened sheet must be a watertight solid");
    assert!(thick.get("nakedEdges").is_none(), "thickened solid must have zero naked edges");
    let vol = thick["volumeMm3"].as_f64().unwrap();
    // 30x30 curved sheet (~930 mm^2) * 2.5 mm ≈ 2325 mm^3.
    assert!(vol > 1800.0 && vol < 3200.0, "unexpected thickened NURBS roof volume: {vol}");

    // 4. Symmetric Thicken (`direction: "both"`, 3 mm) from the same sheet parent node 0.
    let thick_both = call(json!({
        "call": "apply",
        "key": key,
        "parent": 0,
        "node": 2,
        "chordMm": 0.05,
        "op": { "kind": "thicken", "thickness": 3.0, "direction": "both" }
    }));
    assert_eq!(thick_both["solid"], json!(true));
    assert!(thick_both.get("nakedEdges").is_none());
    let vol_both = thick_both["volumeMm3"].as_f64().unwrap();
    assert!(vol_both > vol * 1.05, "3 mm symmetric thicken ({vol_both}) should exceed 2.5 mm ({vol})");

    // 5. Verify B-spline health via surfaceInspect on the thickened NURBS solid.
    let insp = call(json!({
        "call": "surfaceInspect",
        "key": key,
        "node": 1,
        "chordMm": 0.05
    }));
    assert!(insp["surfaceHealth"]["kinds"]["bspline"].as_u64().unwrap_or(0) >= 2);
}

#[test]
fn sew_six_planar_sheets_and_cap_planar_tube_auto_promote_to_watertight_solids() {
    // Part A: Build a 10x10x10 cube from 6 independent open planar sheets and sew into a watertight solid!
    let key = "s4-sew-cube";
    let square_pts = |pts: [[f64; 3]; 4]| {
        json!({
            "kind": "sheet",
            "mode": "planar",
            "curves": [{ "kind": "polyline", "points": pts, "closed": true }]
        })
    };
    let faces = [
        [[0.0, 0.0, 0.0], [10.0, 0.0, 0.0], [10.0, 10.0, 0.0], [0.0, 10.0, 0.0]], // bottom
        [[0.0, 0.0, 10.0], [10.0, 0.0, 10.0], [10.0, 10.0, 10.0], [0.0, 10.0, 10.0]], // top
        [[0.0, 0.0, 0.0], [10.0, 0.0, 0.0], [10.0, 0.0, 10.0], [0.0, 0.0, 10.0]], // front
        [[0.0, 10.0, 0.0], [10.0, 10.0, 0.0], [10.0, 10.0, 10.0], [0.0, 10.0, 10.0]], // back
        [[0.0, 0.0, 0.0], [0.0, 10.0, 0.0], [0.0, 10.0, 10.0], [0.0, 0.0, 10.0]], // left
        [[10.0, 0.0, 0.0], [10.0, 10.0, 0.0], [10.0, 10.0, 10.0], [10.0, 0.0, 10.0]], // right
    ];
    let r0 = call(json!({
        "call": "open",
        "key": key,
        "chordMm": 0.05,
        "feature": square_pts(faces[0])
    }));
    assert_eq!(r0["solid"], json!(false));
    for (i, pts) in faces.iter().enumerate().skip(1) {
        let step = call(json!({
            "call": "apply",
            "key": key,
            "parent": i - 1,
            "node": i,
            "chordMm": 0.05,
            "op": square_pts(*pts)
        }));
        assert_eq!(step["solid"], json!(false));
    }
    let sewn = call(json!({
        "call": "apply",
        "key": key,
        "parent": 5,
        "node": 6,
        "chordMm": 0.05,
        "op": { "kind": "sew", "tolerance": 0.01 }
    }));
    assert_eq!(sewn["solid"], json!(true), "sewing all 6 faces shut must auto-promote to solid: faces={} edges={} naked={:?}", sewn["fingerprint"]["faces"], sewn["fingerprint"]["edges"], sewn.get("nakedEdges"));
    assert!(sewn.get("nakedEdges").is_none(), "sewn cube must have zero naked edges");
    let vol = sewn["volumeMm3"].as_f64().unwrap();
    assert!((vol - 1000.0).abs() < 1e-3, "sewn 10x10x10 cube volume should be 1000, got {vol}");

    // Part B: Extrude a closed square wire into an open 4-wall sleeve (no caps), then Sew with capPlanar: true!
    let key2 = "s4-sew-cap";
    let sleeve = call(json!({
        "call": "open",
        "key": key2,
        "chordMm": 0.05,
        "feature": {
            "kind": "sheet",
            "mode": "extrude",
            "curves": [{
                "kind": "polyline",
                "points": [[0.0, 0.0, 0.0], [12.0, 0.0, 0.0], [12.0, 8.0, 0.0], [0.0, 8.0, 0.0]],
                "closed": true
            }],
            "dir": [0.0, 0.0, 1.0],
            "distance": 15.0
        }
    }));
    assert_eq!(sleeve["solid"], json!(false));
    assert_eq!(sleeve["nakedEdges"].as_array().unwrap().len(), 8, "open sleeve has 4 bottom + 4 top naked edges");

    let capped = call(json!({
        "call": "apply",
        "key": key2,
        "parent": 0,
        "node": 1,
        "chordMm": 0.05,
        "op": { "kind": "sew", "capPlanar": true }
    }));
    assert_eq!(capped["solid"], json!(true), "capPlanar must cap open planar ends and promote to solid");
    assert!(capped.get("nakedEdges").is_none());
    let vol2 = capped["volumeMm3"].as_f64().unwrap();
    assert!((vol2 - 1440.0).abs() < 1e-2, "12*8*15 = 1440, got {vol2}");
}

#[test]
fn trim_split_and_replace_face_sculpt_a_solid_with_nurbs_roof() {
    let key = "s4-trim-split";
    // 20x20x20 box centered in X/Y on Z=0..20 -> volume 8000 mm^3.
    let base = call(json!({
        "call": "open",
        "key": key,
        "chordMm": 0.05,
        "primitive": { "primitive": "box", "origin": [-10.0, -10.0, 0.0], "turn": [0.0, 0.0, 0.0], "size": [20.0, 20.0, 20.0], "radius": 0.0, "height": 0.0 }
    }));
    assert!((base["volumeMm3"].as_f64().unwrap() - 8000.0).abs() < 1e-3);

    // 1. TrimSplit with sculpted double-curved NURBS roof around Z=10..14, keeping BOTH pieces!
    let roof = sculpted_nurbs_roof(10.0, 4.0);
    let split = call(json!({
        "call": "apply",
        "key": key,
        "parent": 0,
        "node": 1,
        "chordMm": 0.05,
        "otherKey": "s4-trim-split-other",
        "op": { "kind": "trimSplit", "sheet": roof, "keep": "both" }
    }));
    assert_eq!(split["solid"], json!(true));
    assert!(split.get("nakedEdges").is_none());
    let v_kept = split["volumeMm3"].as_f64().unwrap();
    let v_other = split["other"]["volumeMm3"].as_f64().unwrap();
    assert!(v_kept > 2000.0 && v_other > 3500.0, "both pieces must have substantial volume: {v_kept}, {v_other}");
    assert!((v_kept + v_other - 8000.0).abs() < 0.5, "split pieces must sum to 8000 mm^3: {v_kept} + {v_other}");

    // 2. ReplaceFace: replace the top face (+Z normal) of the original box with an arching NURBS roof
    // that rises ABOVE Z=20 (Z=20..25), extending the 4 vertical walls cleanly to meet the sculpted dome!
    let top_idx = base["faces"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .find(|(_, f)| f["normal"].as_array().is_some_and(|n| n[2].as_f64().unwrap_or(0.0) > 0.9))
        .expect("box top face")
        .0;
    let dome_roof = sculpted_nurbs_roof(20.0, 5.0);
    let replaced = call(json!({
        "call": "apply",
        "key": key,
        "parent": 0,
        "node": 2,
        "chordMm": 0.05,
        "op": { "kind": "replaceFace", "face": top_idx, "sheet": dome_roof }
    }));
    assert_eq!(replaced["solid"], json!(true), "ReplaceFace must remain a watertight solid");
    assert!(replaced.get("nakedEdges").is_none());
    let v_rep = replaced["volumeMm3"].as_f64().unwrap();
    assert!(v_rep > 8500.0 && v_rep < 10000.0, "rising dome ReplaceFace should grow volume past 8000: {v_rep}");
}

#[test]
fn split_face_imprints_exact_nurbs_curve_onto_solid_face_without_changing_volume() {
    let key = "s4-split-face";
    let base = call(json!({
        "call": "open",
        "key": key,
        "chordMm": 0.05,
        "primitive": { "primitive": "box", "origin": [-10.0, -10.0, 0.0], "turn": [0.0, 0.0, 0.0], "size": [20.0, 20.0, 10.0], "radius": 0.0, "height": 0.0 }
    }));
    let faces_before = base["fingerprint"]["faces"].as_i64().unwrap();
    let top_idx = base["faces"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .find(|(_, f)| f["normal"].as_array().is_some_and(|n| n[2].as_f64().unwrap_or(0.0) > 0.9))
        .expect("box top face")
        .0;

    // Project a curved 3D NURBS S-wave hovering above the top face onto the top face along -Z.
    let split = call(json!({
        "call": "apply",
        "key": key,
        "parent": 0,
        "node": 1,
        "chordMm": 0.05,
        "op": {
            "kind": "splitFace",
            "faces": [top_idx],
            "curve": {
                "kind": "nurbs",
                "poles": [[-12.0, -4.0, 15.0], [-4.0, 6.0, 15.0], [4.0, -6.0, 15.0], [12.0, 4.0, 15.0]],
                "degree": 3
            },
            "direction": [0.0, 0.0, -1.0]
        }
    }));
    assert_eq!(split["solid"], json!(true));
    assert!(split.get("nakedEdges").is_none());
    let faces_after = split["fingerprint"]["faces"].as_i64().unwrap();
    assert_eq!(faces_after, faces_before + 1, "imprinting one curve across the top face must split it into 2 faces");
    let vol = split["volumeMm3"].as_f64().unwrap();
    assert!((vol - 4000.0).abs() < 1e-2, "SplitFace must preserve solid volume (4000 mm^3), got {vol}");
}

/// A sheet has no solid volume, so adopting the cut used to throw the piece away.
/// The kept faces are the step. Replaying it, which is what an older .lime does on open,
/// rebuilds that same sheet.
#[test]
fn sheet_trim_split_keeps_the_cut_piece_and_replays_it() {
    let key = "s4-sheet-trim";
    let sheet = call(json!({
        "call": "open",
        "key": key,
        "chordMm": 0.05,
        "feature": {
            "kind": "sheet",
            "mode": "revolve",
            "curves": [{
                "kind": "segments",
                "start": [0.0, 0.0, 20.0],
                "segments": [{
                    "kind": "arc",
                    "through": [14.1421356237, 0.0, 14.1421356237],
                    "to": [20.0, 0.0, 0.0]
                }]
            }],
            "dir": [0.0, 0.0, 1.0],
            "axisOrigin": [0.0, 0.0, 0.0],
            "angleDeg": 360.0
        }
    }));
    assert_eq!(sheet["solid"], json!(false), "the zone starts as a sheet");
    let cut = call(json!({
        "call": "apply",
        "key": key,
        "parent": 0,
        "node": 1,
        "chordMm": 0.05,
        "op": {
            "kind": "trimSplit",
            "keep": "above",
            "sheet": {
                "mode": "planar",
                "curves": [{
                    "kind": "polyline",
                    "points": [[-30.0, -30.0, 10.0], [30.0, -30.0, 10.0], [30.0, 30.0, 10.0], [-30.0, 30.0, 10.0]],
                    "closed": true
                }]
            }
        }
    }));
    assert_eq!(cut["solid"], json!(false), "the kept piece of a sheet is a sheet: {cut}");
    let volume = cut["volumeMm3"].as_f64().unwrap_or(0.0);
    assert!(volume.abs() < 1e-6, "a sheet piece has no solid volume, got {volume}");
    assert!(cut["fingerprint"]["faces"].as_i64().unwrap_or(0) >= 1, "the cut keeps a face: {cut}");
    assert!(cut.get("nakedEdges").is_some(), "the cut sheet still has a boundary: {cut}");

    lime_model_occt::set_tree_limits(0, 0);
    // Evict runs after a call. Leave the cut first so it is no longer pinned, and the
    // following goto has to build it again. That is the replay an older .lime does on open.
    call(json!({ "call": "goto", "key": key, "node": 0, "chordMm": 0.05 }));
    let replayed = call(json!({ "call": "goto", "key": key, "node": 1, "chordMm": 0.05 }));
    lime_model_occt::set_tree_limits(24, 8);
    assert!(replayed["replayed"].as_i64().unwrap_or(0) >= 1, "the step is rebuilt, not reused: {replayed}");
    assert_eq!(replayed["fingerprint"], cut["fingerprint"], "an older .lime rebuilds the kept sheet");
    assert_eq!(replayed["solid"], json!(false));
    let replayed_volume = replayed["volumeMm3"].as_f64().unwrap_or(0.0);
    assert!(replayed_volume.abs() < 1e-6, "the rebuilt piece is still a sheet, volume {replayed_volume}");
}

/// SplitFace is allowed on a sheet, and a sheet's split stays a sheet: it used to be adopted as a solid and always refused.
#[test]
fn split_face_on_a_sheet_splits_it_and_stays_a_sheet() {
    let key = "s4-split-sheet";
    let sheet = call(json!({
        "call": "open",
        "key": key,
        "chordMm": 0.05,
        "feature": {
            "kind": "sheet",
            "mode": "planar",
            "curves": [{
                "kind": "polyline",
                "points": [[-10.0, -10.0, 0.0], [10.0, -10.0, 0.0], [10.0, 10.0, 0.0], [-10.0, 10.0, 0.0]],
                "closed": true
            }]
        }
    }));
    assert_eq!(sheet["solid"], json!(false));
    let split = call(json!({
        "call": "apply",
        "key": key,
        "parent": 0,
        "node": 1,
        "chordMm": 0.05,
        "op": {
            "kind": "splitFace",
            "faces": [0],
            "curve": { "kind": "polyline", "points": [[0.0, -12.0, 5.0], [0.0, 12.0, 5.0]] },
            "direction": [0.0, 0.0, -1.0]
        }
    }));
    assert_eq!(split["solid"], json!(false), "a split sheet is a sheet: {split}");
    assert_eq!(split["fingerprint"]["faces"], json!(2), "one cut across the square leaves two faces: {split}");
    call(json!({ "call": "close", "key": key }));
}

/// Out-of-range face and edge indices are refused with a sentence, never read past the shape.
#[test]
fn out_of_range_indices_are_refused() {
    let key = "s4-out-of-range";
    call(json!({ "call": "open", "key": key, "box": [20.0, 20.0, 10.0], "chordMm": 0.1 }));
    let refused = |op: Value| {
        let reply = call_raw(json!({ "call": "apply", "key": key, "parent": 0, "node": 1, "chordMm": 0.1, "op": op.clone() }));
        let error = reply["error"].as_str().unwrap_or("").to_string();
        assert!(!error.is_empty(), "{op} must be refused: {reply}");
        println!("{} -> {error}", op["kind"]);
    };
    refused(json!({ "kind": "fillet", "edges": [99], "size": 1.0, "continuity": "g2" }));
    refused(json!({ "kind": "fillet", "edges": [99], "size": 1.0, "variable": [[0.0, 1.0], [1.0, 2.0]] }));
    refused(json!({ "kind": "splitFace", "faces": [99], "curve": { "kind": "polyline", "points": [[0.0, -12.0, 15.0], [0.0, 12.0, 15.0]] }, "direction": [0.0, 0.0, -1.0] }));
    refused(json!({ "kind": "replaceFace", "face": 99, "sheet": { "mode": "planar", "curves": [{ "kind": "polyline", "points": [[-30.0, -30.0, 12.0], [30.0, -30.0, 12.0], [30.0, 30.0, 12.0], [-30.0, 30.0, 12.0]], "closed": true }] } }));
    call(json!({ "call": "close", "key": key }));
    // Patch and blend take a sheet's edges.
    let sheet = "s4-out-of-range-sheet";
    call(json!({ "call": "open", "key": sheet, "chordMm": 0.1, "feature": {
        "kind": "sheet", "mode": "extrude", "dir": [0.0, 0.0, 1.0], "distance": 10.0,
        "curves": [{ "kind": "polyline", "points": [[-10.0, -10.0, 0.0], [10.0, -10.0, 0.0], [10.0, 10.0, 0.0], [-10.0, 10.0, 0.0]], "closed": true }]
    } }));
    for op in [
        json!({ "kind": "patch", "boundaries": [{ "edges": [99] }, { "edges": [98] }, { "edges": [97] }] }),
        json!({ "kind": "blendSurface", "a": { "edges": [99] }, "b": { "edges": [98] }, "continuity": "g1" }),
    ] {
        let reply = call_raw(json!({ "call": "apply", "key": sheet, "parent": 0, "node": 1, "chordMm": 0.1, "op": op.clone() }));
        let error = reply["error"].as_str().unwrap_or("").to_string();
        assert!(!error.is_empty(), "{op} must be refused: {reply}");
        println!("{} -> {error}", op["kind"]);
    }
    call(json!({ "call": "close", "key": sheet }));
}

/// Bad NURBS input is refused with a sentence: a weight of 0 or less, knots that do not increase, knots and
/// multiplicities of different lengths, a degree over 10, and a degree the poles cannot carry (which used to be lowered
/// to fit without a word). A NURBS sent without a degree still takes 3, lowered to fit a short curve.
#[test]
fn bad_nurbs_input_is_refused() {
    let poles = json!([[0.0, 0.0, 0.0], [10.0, 5.0, 0.0], [20.0, 0.0, 0.0]]);
    let sheet = |curve: Value| json!({ "kind": "sheet", "mode": "extrude", "curves": [curve], "dir": [0.0, 0.0, 1.0], "distance": 5.0 });
    let cases = [
        ("weight 0", json!({ "kind": "nurbs", "poles": poles, "weights": [1.0, 0.0, 1.0], "degree": 2 })),
        ("weight below 0", json!({ "kind": "nurbs", "poles": poles, "weights": [1.0, -0.5, 1.0], "degree": 2 })),
        ("knots not increasing", json!({ "kind": "nurbs", "poles": poles, "degree": 2, "knots": [0.0, 0.0], "mults": [3, 3] })),
        ("knots and mults lengths", json!({ "kind": "nurbs", "poles": poles, "degree": 2, "knots": [0.0, 1.0], "mults": [3] })),
        ("degree over 10", json!({ "kind": "nurbs", "poles": poles, "degree": 11 })),
        ("degree the poles cannot carry", json!({ "kind": "nurbs", "poles": poles, "degree": 3 })),
    ];
    for (name, curve) in cases {
        let reply = call_raw(json!({ "call": "open", "key": "s4-bad-nurbs", "chordMm": 0.1, "feature": sheet(curve) }));
        let error = reply["error"].as_str().unwrap_or("").to_string();
        println!("{name} -> {error}");
        assert!(!error.is_empty(), "{name} must be refused: {reply}");
        if name == "knots and mults lengths" {
            assert_eq!(error, "NURBS knots and multiplicities must be the same length.");
        }
    }
    let defaulted = call(json!({ "call": "open", "key": "s4-nurbs-default", "chordMm": 0.1,
        "feature": sheet(json!({ "kind": "nurbs", "poles": poles })) }));
    assert_eq!(defaulted["solid"], json!(false), "three poles with no degree build at degree 2: {defaulted}");
    call(json!({ "call": "close", "key": "s4-nurbs-default" }));
}

/// A tube of radius 2 mm thickened by 3 mm: the wall toward the axis cannot be offset (the radius is under the
/// thickness). The thicken used to shift the sheet along its average normal instead and call the result watertight.
/// Each direction now either builds the exact wall or refuses with a sentence.
#[test]
fn thicken_on_a_tight_tube_builds_the_exact_wall_or_refuses() {
    let (radius, height, thickness) = (2.0_f64, 10.0_f64, 3.0_f64);
    let mut refused = 0;
    for direction in ["normal", "reverse"] {
        let key = format!("s4-thicken-tight-{direction}");
        call(json!({ "call": "open", "key": key, "chordMm": 0.1, "feature": {
            "kind": "sheet", "mode": "extrude", "dir": [0.0, 0.0, 1.0], "distance": height,
            "curves": [{ "kind": "segments", "start": [radius, 0.0, 0.0], "segments": [
                { "kind": "arc", "through": [0.0, radius, 0.0], "to": [-radius, 0.0, 0.0] },
                { "kind": "arc", "through": [0.0, -radius, 0.0], "to": [radius, 0.0, 0.0] }
            ] }]
        } }));
        let reply = call_raw(json!({ "call": "apply", "key": key, "parent": 0, "node": 1, "chordMm": 0.1,
            "op": { "kind": "thicken", "thickness": thickness, "direction": direction } }));
        if let Some(error) = reply["error"].as_str() {
            println!("thicken {direction}: refused: {error}");
            assert_eq!(error, format!("Open CASCADE could not offset this sheet by {thickness} mm. Try a thinner wall or the other direction."));
            refused += 1;
        } else {
            let outward = std::f64::consts::PI * ((radius + thickness).powi(2) - radius.powi(2)) * height;
            let volume = reply["volumeMm3"].as_f64().unwrap_or(0.0);
            println!("thicken {direction}: {volume} mm³ (exact outward wall {outward} mm³)");
            assert!((volume - outward).abs() <= 0.01 * outward, "thicken {direction}: {volume} mm³ is not the exact wall");
        }
        call(json!({ "call": "close", "key": key }));
    }
    assert!(refused >= 1, "the wall toward the axis cannot be built 3 mm thick on a 2 mm radius");
}
