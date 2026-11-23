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
