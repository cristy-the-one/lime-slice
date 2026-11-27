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

/// The distance from `p` to the triangle `a b c`.
fn point_triangle(p: [f32; 3], a: [f32; 3], b: [f32; 3], c: [f32; 3]) -> f32 {
    let sub = |x: [f32; 3], y: [f32; 3]| [x[0] - y[0], x[1] - y[1], x[2] - y[2]];
    let dot = |x: [f32; 3], y: [f32; 3]| x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
    let cross = |x: [f32; 3], y: [f32; 3]| [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
    let segment = |x: [f32; 3], y: [f32; 3]| {
        let d = sub(y, x);
        let t = (dot(sub(p, x), d) / dot(d, d).max(1e-20)).clamp(0.0, 1.0);
        let q = [x[0] + d[0] * t, x[1] + d[1] * t, x[2] + d[2] * t];
        dot(sub(p, q), sub(p, q)).sqrt()
    };
    let n = cross(sub(b, a), sub(c, a));
    let len = dot(n, n).sqrt();
    if len > 1e-12 {
        let inside = [(a, b), (b, c), (c, a)].iter().all(|(x, y)| dot(cross(sub(*y, *x), sub(p, *x)), n) >= 0.0);
        if inside {
            return (dot(sub(p, a), n) / len).abs();
        }
    }
    segment(a, b).min(segment(b, c)).min(segment(c, a))
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

/// The default mesh on origin/main at 146a5ec1 (Angle 0.5, no normals), by shape and chord: triangle count and FNV-1a
/// hash of the positions and triangles bytes. This file's meshing run on a detached worktree of that commit, built
/// against OCCT 7.9.2 with MSVC on Windows, printed them. The hashes are asserted on Windows, where they were made: the
/// mesh is the same algorithm on every platform, but float rounding in another compiler's build of Open CASCADE can
/// move a node in its last bit. Elsewhere the counts are asserted and the hashes printed.
const REFERENCE: &[(&str, f64, usize, u64)] = &[
    ("filleted box", 0.05, 788, 0x1dff_cbee_a035_b94d),
    ("filleted box", 0.1, 628, 0x1565_029c_a2a1_58c5),
    ("cylinder", 0.05, 176, 0xd76b_db78_1aa0_ed1e),
    ("cylinder", 0.1, 124, 0x0bb3_663e_be10_d455),
];

/// The same for the STEP paths (`step_meshes`): meshStep and opening a STEP file, on the filleted box as the kernel
/// writes it to STEP.
const STEP_REFERENCE: &[(&str, f64, usize, u64)] = &[
    ("meshStep", 0.05, 788, 0xd215_5f5d_559e_ee21),
    ("open STEP", 0.05, 788, 0xd215_5f5d_559e_ee21),
    ("meshStep", 0.1, 628, 0x9136_8f20_a1a0_a9fc),
    ("open STEP", 0.1, 628, 0x9136_8f20_a1a0_a9fc),
];

/// Prints every row, then returns the mismatches. One Windows failure lists every soup hash Watson
/// moved, instead of stopping on the first.
fn mesh_drift(what: &str, count: usize, hash: u64, expected: usize, expected_hash: u64) -> Option<String> {
    println!("{what}: {count} triangles, soup hash {hash:#x} (main {expected}, {expected_hash:#x})");
    let mut notes = Vec::new();
    if count != expected {
        notes.push(format!("{what}: {count} triangles, main had {expected}"));
    }
    if cfg!(windows) && hash != expected_hash {
        notes.push(format!("{what}: soup hash {hash:#x}, main had {expected_hash:#x}"));
    }
    if notes.is_empty() { None } else { Some(notes.join("; ")) }
}

#[test]
fn the_default_mesh_is_mains_and_only_the_display_mesh_is_finer() {
    if !ready() {
        return;
    }
    let mut drift = Vec::new();
    for &(name, chord, expected, expected_hash) in REFERENCE {
        let key = format!("angle-{name}-{chord}");
        let standard = meshed(name, &key, chord, None);
        let count = triangles(&standard);
        if let Some(note) = mesh_drift(&format!("{name} at {chord}"), count, soup_hash(&standard), expected, expected_hash) {
            drift.push(note);
        }
        assert!(standard.get("normals").is_none(), "{name}: the default mesh sends no normals");

        assert!(standard.get("display").is_none(), "{name}: no display mesh without the flag");

        // With the flag, a twin opened fresh: everything outside `display` is the same bytes as without it, and as main's.
        let flagged_key = format!("{key}-flagged");
        let flagged = meshed(name, &flagged_key, chord, Some("display"));
        let mut outside = flagged.clone();
        let display = outside.as_object_mut().expect("object").remove("display").expect("a display mesh with the flag");
        assert_eq!(outside, standard, "{name}: the plate mesh in a flagged reply is the unflagged reply");
        if let Some(note) = mesh_drift(&format!("{name} at {chord}, flagged"), triangles(&flagged), soup_hash(&flagged), expected, expected_hash) {
            drift.push(note);
        }
        ok(json!({ "call": "close", "key": flagged_key }));

        let node = standard["id"].clone();
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
        // Outward: both shapes are convex, so each corner's normal points away from the solid's middle.
        let centre: [f32; 3] = if name == "cylinder" { [0.0, 0.0, 10.0] } else { [10.0, 10.0, 5.0] };
        let inward = positions
            .chunks_exact(3)
            .zip(normals.chunks_exact(3))
            .filter(|(p, n)| (p[0] - centre[0]) * n[0] + (p[1] - centre[1]) * n[1] + (p[2] - centre[2]) * n[2] <= 0.0)
            .count();
        assert_eq!(inward, 0, "{name}: every display normal points out");
        // Every display triangle names a face of the solid, and lies on it: its corners within the chord of that face.
        let faces = standard["faces"].as_array().expect("faces").len();
        let owners: Vec<u32> = bytes(&display, "triangles").chunks_exact(4).map(|w| u32::from_le_bytes(w.try_into().expect("4"))).collect();
        assert_eq!(owners.len(), finer);
        assert!(owners.iter().all(|&f| (f as usize) < faces), "{name}: a display triangle names a face that is not there");
        let plate_positions = floats(&standard, "positions");
        let plate_owners: Vec<u32> = bytes(&standard, "triangles").chunks_exact(4).map(|w| u32::from_le_bytes(w.try_into().expect("4"))).collect();
        for t in (0..owners.len()).step_by((owners.len() / 25).max(1)) {
            let corner = &positions[t * 9..t * 9 + 3];
            // The nearest triangle of the plate mesh on the same face: the plate mesh lies within its chord of the B-rep
            // face, so a display corner on that face is within a few chords of it.
            let nearest = plate_owners
                .iter()
                .enumerate()
                .filter(|(_, f)| **f == owners[t])
                .map(|(k, _)| {
                    let q = |c: usize| [plate_positions[k * 9 + c * 3], plate_positions[k * 9 + c * 3 + 1], plate_positions[k * 9 + c * 3 + 2]];
                    point_triangle([corner[0], corner[1], corner[2]], q(0), q(1), q(2))
                })
                .fold(f32::MAX, f32::min);
            assert!(nearest <= 3.0 * chord as f32, "{name}: display triangle {t} lies {nearest} mm off face {}", owners[t]);
        }

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
    assert!(drift.is_empty(), "{}", drift.join("\n"));
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
    let positions = floats(&shown["display"], "positions");
    let normals = floats(&shown["display"], "normals");
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
    assert!(applied["display"].get("normals").is_some(), "the call's own reply carries the display mesh");
    let piece = &applied["pieces"][0];
    assert!(piece.get("positions").is_some(), "{piece}");
    assert!(piece.get("display").is_none() && piece.get("normals").is_none(), "a piece for the plate has the plate mesh only");
    // And the piece's own tree, asked again without the flag, is that same mesh.
    let again = ok(json!({ "call": "goto", "key": "quality-piece", "node": 0, "chordMm": 0.05 }));
    assert_eq!(again["positions"], piece["positions"]);
    ok(json!({ "call": "close", "key": "quality-split" }));
    ok(json!({ "call": "close", "key": "quality-piece" }));
}

/// The STEP paths: `meshStep` (what the slicer and the MCP engine install) and opening a STEP file as a tree, each at
/// two chords, on a STEP the kernel writes of the filleted box. Returns (path, chord, triangles, soup hash).
fn step_meshes() -> Vec<(&'static str, f64, usize, u64)> {
    let source = meshed("filleted box", "step-source", 0.1, None);
    let written = ok(json!({ "call": "export", "key": "step-source", "node": source["id"], "format": "step" }));
    ok(json!({ "call": "close", "key": "step-source" }));
    let data = written["bytesBase64"].clone();
    let mut out = Vec::new();
    for chord in [0.05, 0.1] {
        let step = ok(json!({ "call": "meshStep", "dataB64": data, "chordMm": chord }));
        out.push(("meshStep", chord, triangles(&step), soup_hash(&step)));
        let key = format!("step-open-{chord}");
        let opened = ok(json!({ "call": "open", "key": key, "dataB64": data, "chordMm": chord }));
        out.push(("open STEP", chord, triangles(&opened), soup_hash(&opened)));
        ok(json!({ "call": "close", "key": key }));
    }
    out
}

#[test]
fn the_step_paths_mesh_as_main_did() {
    if !ready() {
        return;
    }
    let mut drift = Vec::new();
    for ((path, chord, count, hash), &(want_path, want_chord, want_count, want_hash)) in step_meshes().into_iter().zip(STEP_REFERENCE) {
        assert_eq!((path, chord), (want_path, want_chord));
        if let Some(note) = mesh_drift(&format!("{path} at {chord}"), count, hash, want_count, want_hash) {
            drift.push(note);
        }
    }
    assert!(drift.is_empty(), "{}", drift.join("\n"));
}
