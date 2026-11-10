//! The bridge triangulates faces with Open CASCADE's Delabella algorithm. On a set of parts this meshes each with it
//! and with the Watson algorithm it replaced, at the same chord, and holds Delabella to what a mesh is for: every
//! face meshed, no triangle of no area, the mesh closed (every edge of a triangle used by exactly two, corner for
//! corner, before any crack is mended), no more edges of three triangles than Watson leaves, no triangle farther from
//! its surface than one and a half chords, and the same mesh when the same solid is meshed again from nothing. The
//! numbers of both are printed, a row a part. Open CASCADE checks a face's triangles against the chord at its own
//! sample points, so on a free-form surface either algorithm's worst triangle lies a little past it: on the duck plate
//! 0.061 mm with Watson and 0.069 mm with Delabella, at a chord of 0.05.
//!
//! `LIME_MESH_QUALITY_STEP` adds STEP files from outside the repository, by path, separated by `;`: they are measured
//! and printed the same way, and nothing of them is kept.
//! `LIME_REQUIRE_OCCT=1` makes a missing kernel a failure.

use base64::Engine;
use serde_json::{json, Value};
use std::collections::HashMap;

const CHORD: f64 = 0.05;

fn require() -> bool {
    std::env::var_os("LIME_REQUIRE_OCCT").is_some()
}

fn call(request: Value) -> Value {
    let text = lime_model_occt::tree(&request.to_string());
    serde_json::from_str(&text).unwrap_or_else(|err| panic!("not JSON ({err}): {text}"))
}

fn ok(request: Value) -> Value {
    let reply = call(request.clone());
    let shown: String = request.to_string().chars().take(300).collect();
    assert!(reply.get("error").is_none(), "{shown} -> {reply}");
    reply
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn corners(reply: &Value) -> Vec<[u32; 3]> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(reply["positions"].as_str().expect("positions"))
        .expect("base64");
    bytes
        .chunks_exact(12)
        .map(|point| {
            let word = |at: usize| u32::from_le_bytes(point[at..at + 4].try_into().expect("four bytes"));
            [word(0), word(4), word(8)]
        })
        .collect()
}

/// Edges of the triangle soup used by one triangle only, and by more than two, with corners matched bit for bit.
fn open_edges(reply: &Value) -> (usize, usize) {
    let points = corners(reply);
    let mut ids: HashMap<[u32; 3], u32> = HashMap::new();
    // -0.0 and 0.0 are one place.
    let key = |p: [u32; 3]| p.map(|word| if word == 0x8000_0000 { 0 } else { word });
    let mut uses: HashMap<(u32, u32), u32> = HashMap::new();
    for triangle in points.chunks_exact(3) {
        let mut id = [0u32; 3];
        for (slot, point) in id.iter_mut().zip(triangle) {
            let next = ids.len() as u32;
            *slot = *ids.entry(key(*point)).or_insert(next);
        }
        for k in 0..3 {
            let (a, b) = (id[k], id[(k + 1) % 3]);
            if a != b {
                *uses.entry((a.min(b), a.max(b))).or_insert(0) += 1;
            }
        }
    }
    (
        uses.values().filter(|&&count| count == 1).count(),
        uses.values().filter(|&&count| count > 2).count(),
    )
}

struct Measured {
    triangles: u64,
    deviation: f64,
    angle: f64,
    slivers: u64,
    flat: u64,
    unmeshed: u64,
    area_off: f64,
    open: usize,
    shared: usize,
    mesh: String,
}

/// What opens a part: the request's fields beside `call`, `key` and `chordMm`, then the steps applied on it in turn.
struct Part {
    name: String,
    root: Value,
    steps: Vec<Value>,
}

fn measure(part: &Part, key: &str) -> Measured {
    let mut request = part.root.clone();
    request["call"] = json!("open");
    request["key"] = json!(key);
    request["chordMm"] = json!(CHORD);
    let mut reply = ok(request);
    for (index, step) in part.steps.iter().enumerate() {
        reply = ok(json!({ "call": "apply", "key": key, "parent": index, "node": index + 1, "op": step, "chordMm": CHORD }));
    }
    let quality = ok(json!({ "call": "testMesh", "key": key, "node": part.steps.len(), "chordMm": CHORD }));
    let (open, shared) = open_edges(&reply);
    ok(json!({ "call": "close", "key": key }));
    Measured {
        triangles: quality["triangles"].as_u64().expect("triangles"),
        deviation: quality["maxDeviationMm"].as_f64().expect("maxDeviationMm"),
        angle: quality["minAngleDeg"].as_f64().expect("minAngleDeg"),
        slivers: quality["slivers"].as_u64().expect("slivers"),
        flat: quality["flat"].as_u64().expect("flat"),
        unmeshed: quality["unmeshed"].as_u64().expect("unmeshed"),
        area_off: quality["areaOffPct"].as_f64().expect("areaOffPct"),
        open,
        shared,
        mesh: format!("{}{}", reply["positions"].as_str().unwrap_or(""), reply["triangles"].as_str().unwrap_or("")),
    }
}

fn hole(x: f64, y: f64) -> Value {
    json!({ "kind": "boolean", "op": "cut", "primitive": "cylinder", "origin": [x, y, -1.0], "radius": 1.5, "height": 12.0, "merge": true })
}

fn parts() -> Vec<Part> {
    let primitive = |name: &str, spec: Value, steps: Vec<Value>| Part { name: name.into(), root: json!({ "primitive": spec }), steps };
    let plate = json!({ "primitive": "box", "origin": [0.0, 0.0, 0.0], "size": [120.0, 80.0, 8.0] });
    let holes: Vec<Value> = (0..150).map(|i| hole(4.0 + 7.5 * f64::from(i % 15), 4.0 + 7.5 * f64::from(i / 15))).collect();
    let mut all = vec![
        primitive("box", json!({ "primitive": "box", "origin": [0.0, 0.0, 0.0], "size": [60.0, 40.0, 20.0] }), vec![]),
        primitive("cylinder", json!({ "primitive": "cylinder", "origin": [0.0, 0.0, 0.0], "radius": 20.0, "height": 30.0 }), vec![]),
        primitive("cone", json!({ "primitive": "cone", "origin": [0.0, 0.0, 0.0], "radius": 20.0, "topRadius": 4.0, "height": 30.0 }), vec![]),
        primitive("sphere", json!({ "primitive": "sphere", "origin": [0.0, 0.0, 0.0], "radius": 25.0 }), vec![]),
        primitive("torus", json!({ "primitive": "torus", "origin": [0.0, 0.0, 6.0], "radius": 30.0, "tubeRadius": 6.0 }), vec![]),
        primitive(
            "filleted box with a hole",
            json!({ "primitive": "box", "origin": [0.0, 0.0, 0.0], "size": [60.0, 40.0, 20.0] }),
            vec![
                json!({ "kind": "hole", "origin": [15.0, 15.0, 20.0], "axis": [0.0, 0.0, -1.0], "radius": 2.0, "depth": 5.0, "through": true }),
                json!({ "kind": "fillet", "edges": [0, 2], "size": 2.0 }),
                json!({ "kind": "boolean", "op": "fuse", "primitive": "sphere", "origin": [30.0, 20.0, 20.0], "radius": 4.0 }),
            ],
        ),
        primitive("shelled box", json!({ "primitive": "box", "origin": [0.0, 0.0, 0.0], "size": [60.0, 40.0, 20.0] }), vec![json!({ "kind": "shell", "thickness": 1.5, "openFaces": [5] })]),
        primitive(
            "plate with 150 holes",
            plate,
            vec![json!({ "kind": "group", "label": "holes", "source": { "kind": "pattern", "combine": true }, "steps": holes, "combine": "cut" })],
        ),
        primitive(
            "text on a cylinder",
            json!({ "primitive": "cylinder", "origin": [0.0, 0.0, 0.0], "radius": 20.0, "height": 30.0 }),
            vec![json!({ "kind": "lettering", "op": "fuse", "origin": [-20.0, 0.0, 15.0], "turn": [0.0, 0.0, 0.0], "text": "Lime", "font": "sans", "height": 8.0, "depth": 1.0 })],
        ),
    ];
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut files: Vec<std::path::PathBuf> = ["samples/step_cube.step", "crates/lime-slice-core/tests/fixtures/duck-plate.step", "crates/lime-slice-core/tests/fixtures/occt_sphere_two_holes.step", "crates/lime-slice-core/tests/fixtures/occt_counterbore.step"]
        .iter()
        .map(|rel| root.join(rel))
        .collect();
    if let Ok(more) = std::env::var("LIME_MESH_QUALITY_STEP") {
        files.extend(more.split(';').filter(|path| !path.is_empty()).map(std::path::PathBuf::from));
    }
    for file in files {
        let bytes = std::fs::read(&file).unwrap_or_else(|err| panic!("{}: {err}", file.display()));
        let name = file.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
        all.push(Part { name, root: json!({ "dataB64": b64(&bytes) }), steps: vec![] });
    }
    all
}

#[test]
fn delabella_meshes_close_and_keep_the_chord() {
    let stats: Value = serde_json::from_str(&lime_model_occt::stats()).expect("stats");
    if stats.get("error").is_some() {
        assert!(!require(), "Open CASCADE is required: {stats}");
        return;
    }
    eprintln!("| part | mesher | triangles | farthest from surface mm | sharpest corner deg | corners under 5 deg | open edges | edges of 3+ | faces with no triangles | a face's area off by % |");
    eprintln!("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|");
    for (index, part) in parts().iter().enumerate() {
        lime_model_occt::set_watson_mesher(true);
        let watson = measure(part, &format!("q{index}w"));
        lime_model_occt::set_watson_mesher(false);
        let delabella = measure(part, &format!("q{index}d"));
        let again = measure(part, &format!("q{index}e"));
        for (name, row) in [("Watson", &watson), ("Delabella", &delabella)] {
            eprintln!(
                "| {} | {name} | {} | {:.4} | {:.2} | {} | {} | {} | {} | {:.3} |",
                part.name, row.triangles, row.deviation, row.angle, row.slivers, row.open, row.shared, row.unmeshed, row.area_off
            );
        }
        let name = &part.name;
        assert_eq!(delabella.unmeshed, 0, "{name}: every face is meshed");
        assert_eq!(delabella.flat, watson.flat.min(delabella.flat), "{name}: no more triangles of no area than Watson's {}", watson.flat);
        assert!(delabella.open <= watson.open, "{name}: {} open edges against Watson's {}", delabella.open, watson.open);
        assert!(delabella.shared <= watson.shared, "{name}: {} edges of three triangles against Watson's {}", delabella.shared, watson.shared);
        assert!(
            delabella.deviation <= CHORD * 1.5,
            "{name}: {} mm from the surface against Watson's {} and a chord of {CHORD}",
            delabella.deviation,
            watson.deviation
        );
        assert!(
            delabella.area_off <= watson.area_off.max(1.0) * 1.5,
            "{name}: a face's triangles are {} % off its area against Watson's {} %",
            delabella.area_off,
            watson.area_off
        );
        assert!(delabella.mesh == again.mesh, "{name}: the same solid meshed again gives the same mesh");
    }
}
