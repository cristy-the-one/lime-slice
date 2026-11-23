//! The mesh every sliced, exported or committed solid gets is the one main had before organic surfaces: half a radian
//! between neighbouring segments, and no normals. Only the Model view's display mesh (`meshQuality: "display"`) is
//! finer and carries analytic normals.
//! `LIME_REQUIRE_OCCT=1` makes a missing kernel a failure.

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
    assert!(reply.get("error").is_none(), "{request} -> {reply}");
    reply
}

fn bytes(reply: &Value, field: &str) -> Vec<u8> {
    reply[field]
        .as_str()
        .map(|text| base64::engine::general_purpose::STANDARD.decode(text).expect("base64"))
        .unwrap_or_default()
}

fn floats(reply: &Value, field: &str) -> Vec<f32> {
    bytes(reply, field)
        .chunks_exact(4)
        .map(|word| f32::from_le_bytes(word.try_into().expect("four bytes")))
        .collect()
}

/// FNV-1a over the positions and triangles bytes: the same number means the same soup, byte for byte.
fn soup_hash(reply: &Value) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes(reply, "positions").into_iter().chain(bytes(reply, "triangles")) {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    hash
}

fn triangles(reply: &Value) -> usize {
    bytes(reply, "triangles").len() / 4
}

/// A box with its twelve edges rounded 2 mm, and a cylinder, each meshed at `chord` (as `quality`, when given).
fn meshed(name: &str, key: &str, chord: f64, quality: Option<&str>) -> Value {
    let with_quality = |mut request: Value| {
        if let Some(quality) = quality {
            request["meshQuality"] = json!(quality);
        }
        request
    };
    match name {
        "filleted box" => {
            ok(json!({ "call": "open", "key": key, "box": [20.0, 20.0, 10.0], "quiet": true }));
            let edges: Vec<i32> = (0..12).collect();
            ok(with_quality(json!({
                "call": "apply", "key": key, "parent": 0, "node": 1, "chordMm": chord,
                "op": { "kind": "fillet", "edges": edges, "size": 2.0 }
            })))
        }
        _ => ok(with_quality(json!({
            "call": "open", "key": key, "chordMm": chord,
            "primitive": { "primitive": "cylinder", "origin": [0.0, 0.0, 0.0], "radius": 10.0, "height": 20.0 }
        }))),
    }
}

/// False, and a failure under `LIME_REQUIRE_OCCT`, when the kernel is not linked.
fn ready() -> bool {
    let opened = call(json!({ "call": "open", "key": "mesh-angle-ready", "box": [1.0, 1.0, 1.0] }));
    if opened.get("error").is_some() {
        assert!(!require(), "OCCT was required: {opened}");
        return false;
    }
    true
}

/// Triangle counts of the default mesh on origin/main at 146a5ec1 (Angle 0.5, no normals), by shape and chord: this
/// file's meshing run on a detached worktree of that commit printed them.
const REFERENCE: &[(&str, f64, usize)] = &[
    ("filleted box", 0.05, 788),
    ("filleted box", 0.1, 628),
    ("cylinder", 0.05, 176),
    ("cylinder", 0.1, 124),
];

#[test]
fn the_default_mesh_is_mains_and_only_the_display_mesh_is_finer() {
    if !ready() {
        return;
    }
    for &(name, chord, expected) in REFERENCE {
        let key = format!("angle-{name}-{chord}");
        let standard = meshed(name, &key, chord, None);
        let count = triangles(&standard);
        println!("{name} chord {chord}: default {count} triangles (main {expected}), soup hash {:#x}", soup_hash(&standard));
        assert_eq!(count, expected, "{name} at {chord}: the default mesh must be main's");
        assert!(standard.get("normals").is_none(), "{name}: the default mesh sends no normals");

        let node = standard["id"].clone();
        let display = ok(json!({ "call": "goto", "key": key, "node": node, "chordMm": chord, "meshQuality": "display" }));
        let finer = triangles(&display);
        println!("{name} chord {chord}: display {finer} triangles");
        assert!(finer > count, "{name} at {chord}: the display mesh ({finer}) must be finer than the default ({count})");
        let positions = floats(&display, "positions");
        let normals = floats(&display, "normals");
        assert_eq!(normals.len(), positions.len(), "{name}: one normal a corner");
        let worst = normals
            .chunks_exact(3)
            .map(|n| ((n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt() - 1.0).abs())
            .fold(0.0_f32, f32::max);
        assert!(worst < 1e-4, "{name}: display normals are unit length, worst off by {worst}");

        // The display mesh lives on a copy. Had it meshed the held faces, Open CASCADE would keep its finer triangles
        // and the next default mesh, at a coarser chord, would read them: compare with a twin that never asked.
        let after = ok(json!({ "call": "goto", "key": key, "node": node, "chordMm": 0.3 }));
        let twin = format!("{key}-twin");
        let twin_first = meshed(name, &twin, chord, None);
        let twin_after = ok(json!({ "call": "goto", "key": twin, "node": twin_first["id"], "chordMm": 0.3 }));
        assert_eq!(soup_hash(&after), soup_hash(&twin_after), "{name}: a display mesh must not change the default mesh");
        assert!(after.get("normals").is_none());
        ok(json!({ "call": "close", "key": twin }));
        ok(json!({ "call": "close", "key": key }));
    }
}

/// A mirrored box: every plane has an indirect placement, whose axis is the reverse of D1U x D1V. Each display normal
/// must still point out of the solid.
#[cfg(lime_occt_test_hooks)]
#[test]
fn display_normals_of_a_mirrored_box_point_out() {
    if !ready() {
        return;
    }
    ok(json!({ "call": "open", "key": "mirror-source", "box": [20.0, 20.0, 10.0], "quiet": true }));
    let placed = ok(json!({ "call": "testPlace", "key": "mirror-source", "node": 0, "mirror": true }));
    ok(json!({ "call": "close", "key": "mirror-source" }));
    let shown = ok(json!({ "call": "open", "key": "mirrored", "dataB64": placed["dataB64"], "meshQuality": "display" }));
    let positions = floats(&shown, "positions");
    let normals = floats(&shown, "normals");
    assert_eq!(positions.len(), normals.len());
    // The box from (0, 0, 0) to (20, 20, 10), mirrored in x = 0.
    let centre = [-10.0_f32, 10.0, 5.0];
    let mut inward = 0;
    for (p, n) in positions.chunks_exact(3).zip(normals.chunks_exact(3)) {
        let out = (p[0] - centre[0]) * n[0] + (p[1] - centre[1]) * n[1] + (p[2] - centre[2]) * n[2];
        if out <= 0.0 {
            inward += 1;
        }
    }
    assert!(positions.iter().step_by(3).all(|x| *x <= 1e-4), "the box was mirrored to x <= 0");
    assert_eq!(inward, 0, "every display normal of the mirrored box points out");
    ok(json!({ "call": "close", "key": "mirrored" }));
}

/// A split to print's pieces go to the plate, so they keep the standard mesh even when the call asked for the display
/// mesh for its own reply; and a meshQuality other than "display" is refused.
#[test]
fn pieces_keep_the_standard_mesh_and_an_unknown_quality_is_refused() {
    if !ready() {
        return;
    }
    let refused = call(json!({ "call": "open", "key": "quality-typo", "box": [10.0, 10.0, 10.0], "meshQuality": "fine" }));
    assert_eq!(refused["error"].as_str(), Some("meshQuality is 'display' or absent"), "{refused}");

    let cut = json!({
        "kind": "partition",
        "cuts": [{ "origin": [10.0, 5.0, 5.0], "normal": [1.0, 0.0, 0.0], "u": [0.0, 1.0, 0.0],
            "profile": { "kind": "straight" }, "connectors": { "on": false } }],
        "target": { "printer": "lime-220", "process": "fdm", "volumeMm": [220.0, 220.0, 250.0] },
        "orient": "keep", "arrange": true, "bedMarginMm": 5.0, "maxPieces": 12.0,
    });
    ok(json!({ "call": "open", "key": "quality-split", "box": [20.0, 10.0, 10.0], "quiet": true }));
    let applied = ok(json!({ "call": "apply", "key": "quality-split", "parent": 0, "node": 1, "op": cut,
        "pieceKeys": ["quality-piece"], "chordMm": 0.05, "meshQuality": "display" }));
    assert!(applied.get("normals").is_some(), "the call's own reply is the display mesh");
    let piece = &applied["pieces"][0];
    assert!(piece.get("positions").is_some(), "{piece}");
    assert!(piece.get("normals").is_none(), "a piece for the plate has the standard mesh");
    // And the piece's own tree, asked again without the flag, is that same mesh.
    let again = ok(json!({ "call": "goto", "key": "quality-piece", "node": 0, "chordMm": 0.05 }));
    assert_eq!(again["positions"], piece["positions"]);
    ok(json!({ "call": "close", "key": "quality-split" }));
    ok(json!({ "call": "close", "key": "quality-piece" }));
}
