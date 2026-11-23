//! The ribbon hook is compiled into the test build only. There is no op field, so
//! the app and the MCP cannot reverse a ribbon.

use std::os::raw::c_int;

use base64::Engine;
use serde_json::{json, Value};

extern "C" {
    fn lime_model_occt_test_reverse_blend_ribbon(side: c_int);
}

struct ReversedRibbon;

impl ReversedRibbon {
    fn side(side: i32) -> Self {
        unsafe { lime_model_occt_test_reverse_blend_ribbon(side) }
        Self
    }
}

impl Drop for ReversedRibbon {
    fn drop(&mut self) {
        unsafe { lime_model_occt_test_reverse_blend_ribbon(-1) }
    }
}

fn call(request: Value) -> Value {
    let text = super::tree(&request.to_string());
    serde_json::from_str(&text).unwrap_or_else(|err| panic!("not JSON ({err}): {text}"))
}

fn ok(request: Value) -> Value {
    let reply = call(request.clone());
    assert!(reply.get("error").is_none(), "{request} -> {reply}");
    reply
}

fn circle_arcs(radius: f64, z: f64) -> Value {
    json!({
        "kind": "segments",
        "start": [radius, 0.0, z],
        "segments": [
            { "kind": "arc", "through": [0.0, radius, z], "to": [-radius, 0.0, z] },
            { "kind": "arc", "through": [0.0, -radius, z], "to": [radius, 0.0, z] }
        ]
    })
}

fn decode_f32(b64: &str) -> Vec<f32> {
    base64::engine::general_purpose::STANDARD
        .decode(b64)
        .expect("valid base64")
        .chunks_exact(4)
        .map(|word| f32::from_le_bytes([word[0], word[1], word[2], word[3]]))
        .collect()
}

fn decode_u32(b64: &str) -> Vec<u32> {
    base64::engine::general_purpose::STANDARD
        .decode(b64)
        .expect("valid base64")
        .chunks_exact(4)
        .map(|word| u32::from_le_bytes([word[0], word[1], word[2], word[3]]))
        .collect()
}

fn edge_ids_at_top(opened: &Value, height: f64) -> (Vec<usize>, Vec<usize>) {
    let points = decode_f32(opened["edgePoints"].as_str().expect("edgePoints"));
    let offsets = decode_u32(opened["edgeOffsets"].as_str().expect("edgeOffsets"));
    let mut outer = Vec::new();
    let mut inner = Vec::new();
    for index in 0..offsets.len().saturating_sub(1) {
        let start = offsets[index] as usize;
        let end = offsets[index + 1] as usize;
        let mut row = Vec::new();
        let mut at = start * 3;
        while at + 2 < end * 3 && at + 2 < points.len() {
            row.push([points[at] as f64, points[at + 1] as f64, points[at + 2] as f64]);
            at += 3;
        }
        if row.len() < 2 || row.iter().any(|p| p[2] < height - 0.5) {
            continue;
        }
        let radius = row.iter().map(|p| (p[0] * p[0] + p[1] * p[1]).sqrt()).sum::<f64>() / row.len() as f64;
        if radius > 14.0 {
            outer.push(index);
        } else {
            inner.push(index);
        }
    }
    (outer, inner)
}

#[test]
fn blend_refuses_a_ribbon_that_folds_back_into_the_face() {
    let caps = call(json!({ "call": "capabilities" }));
    if caps["stepMeshing"].as_bool() != Some(true) {
        return;
    }
    // The coaxial exact-circle tubes meet G1 with the ribbon left alone. Reversing
    // side A points that cross derivative back into the wall. The normals stay
    // anti-parallel, and the op must refuse that fold by name.
    let _hook = ReversedRibbon::side(0);
    let key = "s5-blend-fold";
    let chord = 5e-4;
    ok(json!({
        "call": "open",
        "key": key,
        "chordMm": chord,
        "feature": {
            "kind": "sheet",
            "mode": "extrude",
            "curves": [circle_arcs(18.0, 0.0)],
            "dir": [0.0, 0.0, 1.0],
            "distance": 16.0
        }
    }));
    ok(json!({
        "call": "apply",
        "key": key,
        "parent": 0,
        "node": 1,
        "chordMm": chord,
        "op": {
            "kind": "sheet",
            "mode": "extrude",
            "curves": [circle_arcs(10.0, 0.0)],
            "dir": [0.0, 0.0, 1.0],
            "distance": 16.0
        }
    }));
    let walled = ok(json!({
        "call": "apply",
        "key": key,
        "parent": 1,
        "node": 2,
        "chordMm": chord,
        "op": {
            "kind": "sheet",
            "mode": "revolve",
            "curves": [{ "kind": "polyline", "points": [[10.0, 0.0, 0.0], [18.0, 0.0, 0.0]] }],
            "dir": [0.0, 0.0, 1.0],
            "axisOrigin": [0.0, 0.0, 0.0],
            "angleDeg": 360.0
        }
    }));
    let (outer, inner) = edge_ids_at_top(&walled, 16.0);
    assert!(!outer.is_empty() && !inner.is_empty(), "fold needs both rims");
    let reply = call(json!({
        "call": "apply",
        "key": key,
        "parent": 2,
        "node": 3,
        "chordMm": chord,
        "op": {
            "kind": "blendSurface",
            "a": { "edges": outer, "continuity": "g1" },
            "b": { "edges": inner, "continuity": "g1" },
            "continuity": "g1",
            "tensionA": 1.0,
            "tensionB": 1.0
        }
    }));
    let error = reply["error"].as_str().unwrap_or("").to_string();
    assert!(
        reply.get("solid").is_none(),
        "a fold builds no face: {reply}"
    );
    let named = |ids: &[usize]| {
        let mut text = format!("{} {}", if ids.len() == 1 { "Edge" } else { "Edges" }, ids[0]);
        for (i, id) in ids.iter().enumerate().skip(1) {
            text += &format!("{}{id}", if i + 1 == ids.len() { " and " } else { ", " });
        }
        text
    };
    assert_eq!(
        error,
        format!("{} folds back into the face.", named(&outer)),
        "a reversed ribbon must be refused as a fold, naming side A's edges, got {reply}"
    );
    ok(json!({ "call": "close", "key": key }));
}
