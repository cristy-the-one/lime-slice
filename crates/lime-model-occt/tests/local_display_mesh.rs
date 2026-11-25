//! Incremental display meshing (`meshQuality: "display"`): a step copies and meshes only the faces it made and the
//! faces beside them, seeding each beside face's copy with the parent's display triangulation and edge polygons and
//! reusing every untouched far face directly. That must answer what copying and meshing the whole solid answers,
//! byte for byte — including `display.positions`, `display.normals`, and `display.triangles`.
//! `LIME_REQUIRE_OCCT=1` makes a missing kernel a failure.

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

fn shown(mut reply: Value) -> Value {
    if let Some(fields) = reply.as_object_mut() {
        fields.remove("held");
    }
    reply
}

fn cylinder(op: &str, origin: [f64; 3], radius: f64, height: f64) -> Value {
    json!({
        "kind": "boolean", "op": op, "primitive": "cylinder",
        "origin": origin, "size": [0.0, 0.0, 0.0],
        "radius": radius, "height": height, "turn": [0.0, 0.0, 0.0]
    })
}

fn steps(tool: &str) -> Vec<Value> {
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
        json!({ "kind": "join", "op": "cut", "tool": { "key": tool, "node": 0 }, "relative": { "m": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0], "t": [38.0, 26.0, -5.0] } }),
        json!({ "kind": "split", "origin": [57.0, 0.0, 0.0], "normal": [1.0, 0.0, 0.0] }),
        json!({ "kind": "boolean", "op": "common", "primitive": "sphere", "origin": [30.0, 20.0, 10.0], "radius": 45.0 }),
        json!({ "kind": "scale", "factor": 1.5 }),
    ]
}

fn build_display(key: &str) -> Vec<Value> {
    let open = call(&json!({
        "call": "open", "key": key, "box": [60.0, 40.0, 20.0],
        "chordMm": 0.1, "meshQuality": "display"
    }));
    assert!(open.get("error").is_none(), "{open}");
    let tool = "local-display-mesh-tool";
    let opened = call(&json!({
        "call": "open", "key": tool, "box": [4.0, 4.0, 40.0], "chordMm": 0.1
    }));
    assert!(opened.get("error").is_none(), "{opened}");

    let mut replies = vec![shown(open)];
    let mut parent = 0;
    for (at, op) in steps(tool).into_iter().enumerate() {
        let node = at as i64 + 1;
        let reply = call(&json!({
            "call": "apply", "key": key, "parent": parent, "node": node,
            "op": op, "chordMm": 0.1, "meshQuality": "display"
        }));
        if reply.get("error").is_none() {
            parent = node;
        }
        replies.push(shown(reply));
    }
    let probe = cylinder("fuse", [30.0, 20.0, 15.0], 3.0, 12.0);
    replies.push(call(&json!({
        "call": "probe", "key": key, "node": parent, "op": probe,
        "preview": true, "chordMm": 0.1, "meshQuality": "display"
    })));
    replies.push(shown(call(&json!({
        "call": "goto", "key": key, "node": parent, "chordMm": 0.05, "meshQuality": "display"
    }))));
    replies.push(shown(call(&json!({
        "call": "goto", "key": key, "node": 3, "chordMm": 0.05, "meshQuality": "display"
    }))));
    let mut on = 3;
    for (node, op) in [
        (100, cylinder("cut", [52.0, 30.0, 10.0], 2.0, 30.0)),
        (101, cylinder("fuse", [10.0, 20.0, 19.0], 3.0, 5.0)),
    ] {
        let reply = call(&json!({
            "call": "apply", "key": key, "parent": on, "node": node,
            "op": op, "chordMm": 0.1, "meshQuality": "display"
        }));
        assert!(reply.get("error").is_none(), "{reply}");
        replies.push(shown(reply));
        on = node;
    }
    call(&json!({ "call": "close", "key": key }));
    call(&json!({ "call": "close", "key": tool }));
    replies
}

/// Every mesh whole for as long as it lives, then restores incremental meshing on drop.
/// Because the switch is process-wide, this integration test binary keeps a single test.
struct WholeMeshes;

impl WholeMeshes {
    fn on() -> WholeMeshes {
        lime_model_occt::set_whole_meshes(true);
        WholeMeshes
    }
}

impl Drop for WholeMeshes {
    fn drop(&mut self) {
        lime_model_occt::set_whole_meshes(false);
    }
}

#[test]
fn incremental_display_meshing_matches_whole_display_meshing_byte_for_byte() {
    let probe = call(&json!({ "call": "open", "key": "local-display-probe", "box": [1.0, 1.0, 1.0] }));
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
    call(&json!({ "call": "close", "key": "local-display-probe" }));

    let (dm0, fdm0) = (stat("displayMeshes"), stat("fullDisplayMeshes"));
    let local = build_display("local-display-mesh");
    let local_dm = stat("displayMeshes") - dm0;
    let local_fdm = stat("fullDisplayMeshes") - fdm0;

    let (full, full_dm, full_fdm) = {
        let _whole = WholeMeshes::on();
        let (dm0, fdm0) = (stat("displayMeshes"), stat("fullDisplayMeshes"));
        let full = build_display("whole-display-mesh");
        (
            full,
            stat("displayMeshes") - dm0,
            stat("fullDisplayMeshes") - fdm0,
        )
    };

    assert_eq!(
        full_dm, full_fdm,
        "every display mesh was whole while asked for"
    );
    assert_eq!(local_dm, full_dm, "the two trees display-meshed as often");
    assert!(
        local_fdm < local_dm / 2,
        "most steps incrementally display-meshed around what they made: {local_fdm} of {local_dm} whole"
    );
    let built = local
        .iter()
        .filter(|reply| reply.get("display").is_some() || reply.get("preview").is_some())
        .count();
    assert!(built >= 13, "most steps built: {built} of {}", local.len());
    assert_eq!(local.len(), full.len());
    for (at, (a, b)) in local.iter().zip(&full).enumerate() {
        assert!(
            a == b,
            "reply {at} differs: {} vs {}",
            &a.to_string()[..a.to_string().len().min(300)],
            &b.to_string()[..b.to_string().len().min(300)]
        );
    }
}
