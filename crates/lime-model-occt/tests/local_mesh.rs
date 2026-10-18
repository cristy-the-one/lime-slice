//! A step meshes only the faces it made and the faces beside them, keeping the mesh of every face it shares with the solid
//! it was built on. That must answer what meshing the whole solid answers, byte for byte: the same triangles, edges,
//! measures and fingerprints, for every kind of step. `LIME_REQUIRE_OCCT=1` makes a missing kernel a failure.

use serde_json::{json, Value};

fn require() -> bool {
    std::env::var_os("LIME_REQUIRE_OCCT").is_some()
}

fn call(request: &Value) -> Value {
    let text = lime_model_occt::tree(&request.to_string());
    serde_json::from_str(&text).unwrap_or_else(|err| panic!("not JSON ({err}): {text}"))
}

fn stat(name: &str) -> i64 {
    let stats: Value = serde_json::from_str(&lime_model_occt::stats()).expect("stats JSON");
    stats[name].as_i64().unwrap_or(0)
}

/// A reply without what names the tree's nodes, which the two trees share anyway.
fn shown(mut reply: Value) -> Value {
    if let Some(fields) = reply.as_object_mut() {
        fields.remove("held");
    }
    reply
}

fn cylinder(op: &str, origin: [f64; 3], radius: f64, height: f64) -> Value {
    json!({ "kind": "boolean", "op": op, "primitive": "cylinder", "origin": origin, "size": [0.0, 0.0, 0.0], "radius": radius, "height": height, "turn": [0.0, 0.0, 0.0] })
}

/// Steps of every kind, each on the one before. A step that does not build must not build either way.
fn steps() -> Vec<Value> {
    vec![
        json!({ "kind": "fillet", "edges": [0, 2], "size": 2.0 }),
        json!({ "kind": "shell", "thickness": 1.5, "openFaces": [] }),
        json!({ "kind": "hole", "origin": [15.0, 15.0, 20.0], "axis": [0.0, 0.0, -1.0], "radius": 2.0, "depth": 5.0, "through": true }),
        cylinder("fuse", [45.0, 20.0, 19.0], 6.0, 8.0),
        json!({ "kind": "boolean", "op": "cut", "primitive": "cone", "origin": [30.0, 10.0, 8.0], "radius": 4.0, "topRadius": 1.0, "height": 15.0, "turn": [0.0, 0.0, 0.0] }),
        json!({ "kind": "boolean", "op": "fuse", "primitive": "torus", "origin": [20.0, 30.0, 20.0], "radius": 6.0, "tubeRadius": 1.5, "turn": [0.0, 0.0, 0.0] }),
        json!({ "kind": "boolean", "op": "cut", "primitive": "box", "origin": [50.0, 2.0, 5.0], "size": [6.0, 6.0, 30.0], "turn": [0.0, 0.0, 30.0] }),
        json!({ "kind": "chamfer", "edges": [3], "size": 1.0 }),
        json!({ "kind": "boolean", "op": "fuse", "primitive": "sphere", "origin": [8.0, 32.0, 20.0], "radius": 4.0 }),
        cylinder("cut", [5.0, 5.0, -1.0], 1.5, 30.0),
        json!({ "kind": "split", "origin": [57.0, 0.0, 0.0], "normal": [1.0, 0.0, 0.0] }),
        json!({ "kind": "boolean", "op": "common", "primitive": "sphere", "origin": [30.0, 20.0, 10.0], "radius": 45.0 }),
        json!({ "kind": "scale", "factor": 1.5 }),
    ]
}

/// Every step's Apply reply, then a check with its shape, then the last step again at a finer chord.
fn build(key: &str) -> Vec<Value> {
    let open = call(&json!({ "call": "open", "key": key, "box": [60.0, 40.0, 20.0], "chordMm": 0.1 }));
    assert!(open.get("error").is_none(), "{open}");
    let mut replies = vec![shown(open)];
    let mut parent = 0;
    for (at, op) in steps().into_iter().enumerate() {
        let node = at as i64 + 1;
        let reply = call(&json!({ "call": "apply", "key": key, "parent": parent, "node": node, "op": op, "chordMm": 0.1 }));
        if reply.get("error").is_none() {
            parent = node;
        }
        replies.push(shown(reply));
    }
    let probe = cylinder("fuse", [30.0, 20.0, 15.0], 3.0, 12.0);
    replies.push(call(&json!({ "call": "probe", "key": key, "node": parent, "op": probe, "preview": true, "chordMm": 0.1 })));
    replies.push(shown(call(&json!({ "call": "goto", "key": key, "node": parent, "chordMm": 0.05 }))));
    replies.push(shown(call(&json!({ "call": "goto", "key": key, "node": 3, "chordMm": 0.05 }))));
    call(&json!({ "call": "close", "key": key }));
    replies
}

#[test]
fn meshing_around_a_step_answers_what_meshing_the_whole_solid_does() {
    let probe = call(&json!({ "call": "open", "key": "local-mesh-probe", "box": [1.0, 1.0, 1.0] }));
    if probe["error"].as_str().is_some_and(|e| e.contains("OCCT_ROOT")) {
        assert!(!require(), "LIME_REQUIRE_OCCT is set but the kernel is not linked");
        return;
    }
    call(&json!({ "call": "close", "key": "local-mesh-probe" }));

    let (meshes, whole) = (stat("meshes"), stat("fullMeshes"));
    let local = build("local-mesh");
    let local_meshes = stat("meshes") - meshes;
    let local_whole = stat("fullMeshes") - whole;

    lime_model_occt::set_whole_meshes(true);
    let (meshes, whole) = (stat("meshes"), stat("fullMeshes"));
    let full = build("whole-mesh");
    let full_meshes = stat("meshes") - meshes;
    let full_whole = stat("fullMeshes") - whole;
    lime_model_occt::set_whole_meshes(false);

    assert_eq!(full_meshes, full_whole, "every mesh was whole while asked for");
    assert_eq!(local_meshes, full_meshes, "the two trees meshed as often");
    assert!(local_whole < local_meshes / 2, "most steps meshed only around what they made: {local_whole} of {local_meshes} whole");
    let built = local.iter().filter(|reply| reply.get("positions").is_some() || reply.get("preview").is_some()).count();
    assert!(built >= 12, "most steps built: {built} of {}", local.len());
    assert_eq!(local.len(), full.len());
    for (at, (a, b)) in local.iter().zip(&full).enumerate() {
        assert!(a == b, "reply {at} differs: {} vs {}", &a.to_string()[..a.to_string().len().min(300)], &b.to_string()[..b.to_string().len().min(300)]);
    }
}
