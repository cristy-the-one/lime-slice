//! A step leaves the triangles of every face it did not make where they were in the mesh: the same corners, bit for bit,
//! in the same order among themselves. A slicer that keys its layers by their triangles then plans again only the
//! layers the step reached. The mesh is still a fresh tessellation of the step's solid, as a set of triangles: the solid
//! saved and opened again meshes to the same ones. `LIME_REQUIRE_OCCT=1` makes a missing kernel a failure.

use base64::Engine;
use serde_json::{json, Value};
use std::collections::HashMap;

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

type Triangle = [u32; 9];

fn decode(reply: &Value, field: &str) -> Vec<u8> {
    let data = reply[field].as_str().unwrap_or_else(|| panic!("{field}"));
    base64::engine::general_purpose::STANDARD
        .decode(data)
        .expect("base64")
}

/// The reply's triangle soup, each corner's coordinates as their bits.
fn triangles(reply: &Value) -> Vec<Triangle> {
    decode(reply, "positions")
        .chunks_exact(36)
        .map(|tri| {
            std::array::from_fn(|k| u32::from_le_bytes(tri[k * 4..k * 4 + 4].try_into().unwrap()))
        })
        .collect()
}

/// The soup cut where the face of the triangles changes: each face's triangles, in the order the mesh reads them out.
fn faces(reply: &Value) -> Vec<Vec<Triangle>> {
    let soup = triangles(reply);
    let ids: Vec<u32> = decode(reply, "triangles")
        .chunks_exact(4)
        .map(|id| u32::from_le_bytes(id.try_into().unwrap()))
        .collect();
    assert_eq!(ids.len(), soup.len());
    let mut out: Vec<Vec<Triangle>> = Vec::new();
    for (at, triangle) in soup.into_iter().enumerate() {
        match out.last_mut() {
            Some(face) if at > 0 && ids[at - 1] == ids[at] => face.push(triangle),
            _ => out.push(vec![triangle]),
        }
    }
    out
}

fn counts(soup: &[Triangle]) -> HashMap<Triangle, usize> {
    let mut out = HashMap::new();
    for triangle in soup {
        *out.entry(*triangle).or_insert(0) += 1;
    }
    out
}

fn cylinder(op: &str, origin: [f64; 3], radius: f64, height: f64) -> Value {
    json!({ "kind": "boolean", "op": op, "primitive": "cylinder", "origin": origin, "size": [0.0, 0.0, 0.0], "radius": radius, "height": height, "turn": [0.0, 0.0, 0.0] })
}

#[test]
fn a_step_keeps_the_triangles_of_the_faces_it_did_not_make_in_place() {
    let probe = call(json!({ "call": "open", "key": "mesh-order-probe", "box": [1.0, 1.0, 1.0] }));
    if probe["error"]
        .as_str()
        .is_some_and(|e| e.contains("OCCT_ROOT"))
    {
        assert!(
            !require(),
            "LIME_REQUIRE_OCCT is set but the kernel is not linked"
        );
        return;
    }
    call(json!({ "call": "close", "key": "mesh-order-probe" }));

    let key = "mesh-order";
    let mut before = faces(&ok(
        json!({ "call": "open", "key": key, "box": [60.0, 40.0, 20.0], "chordMm": 0.1 }),
    ));
    let steps = [
        json!({ "kind": "hole", "origin": [15.0, 15.0, 20.0], "axis": [0.0, 0.0, -1.0], "radius": 2.0, "depth": 5.0, "through": true }),
        json!({ "kind": "fillet", "edges": [0, 2], "size": 2.0 }),
        cylinder("fuse", [45.0, 20.0, 19.0], 6.0, 8.0),
        json!({ "kind": "boolean", "op": "cut", "primitive": "box", "origin": [50.0, 2.0, 5.0], "size": [6.0, 6.0, 30.0], "turn": [0.0, 0.0, 30.0] }),
        json!({ "kind": "chamfer", "edges": [3], "size": 1.0 }),
        cylinder("cut", [5.0, 5.0, -1.0], 1.5, 30.0),
        json!({ "kind": "boolean", "op": "fuse", "primitive": "sphere", "origin": [30.0, 20.0, 20.0], "radius": 4.0 }),
    ];
    let (mut parent, mut built) = (0, 0);
    for (at, op) in steps.into_iter().enumerate() {
        let node = at as i64 + 1;
        let reply = call(
            json!({ "call": "apply", "key": key, "parent": parent, "node": node, "op": op, "chordMm": 0.1 }),
        );
        if reply.get("error").is_some() {
            continue;
        }
        let after = faces(&reply);
        // A face the step kept reads out the triangles it had; every other face is one the step made.
        let kept: Vec<usize> = after
            .iter()
            .filter_map(|face| before.iter().position(|old| old == face))
            .collect();
        assert!(!kept.is_empty(), "step {node} kept faces");
        assert!(
            kept.windows(2).all(|pair| pair[0] < pair[1]),
            "step {node}: the kept faces read out in the order they had: {kept:?}"
        );
        let now = counts(&after.concat());

        let solid = ok(json!({ "call": "export", "key": key, "node": node, "format": "brep" }));
        let fresh_key = format!("mesh-order-fresh-{node}");
        let fresh = triangles(&ok(
            json!({ "call": "open", "key": fresh_key, "dataB64": solid["bytesBase64"], "chordMm": 0.1 }),
        ));
        call(json!({ "call": "close", "key": fresh_key }));
        assert!(
            counts(&fresh) == now,
            "step {node} meshes to the triangles of a fresh tessellation of its solid"
        );
        before = after;
        parent = node;
        built += 1;
    }
    call(json!({ "call": "close", "key": key }));
    assert!(built >= 5, "most steps built: {built}");
}
