//! An Apply that asks for no mesh (`mesh: false`) and a request that asks for its kernel timing (`{"timing":true,`).
//! `LIME_REQUIRE_OCCT=1` makes a missing kernel a failure. The store is process-wide, so everything runs in one test.

use serde_json::{json, Value};

fn require() -> bool {
    std::env::var_os("LIME_REQUIRE_OCCT").is_some()
}

fn call_text(text: &str) -> Value {
    let reply = lime_model_occt::tree(text);
    serde_json::from_str(&reply).unwrap_or_else(|err| panic!("not JSON ({err}): {reply}"))
}

fn call(request: Value) -> Value {
    call_text(&request.to_string())
}

/// Through the exported function the app and the MCP engine load, which is where the timing marker is read.
fn exported(text: &str) -> Value {
    let request = std::ffi::CString::new(text).unwrap();
    // SAFETY: `request` is a valid C string, and the answer is freed with the function that goes with it.
    let answer = unsafe { lime_model_occt::lime_occt_tree(request.as_ptr()) };
    let reply = unsafe { std::ffi::CStr::from_ptr(answer) }
        .to_string_lossy()
        .into_owned();
    unsafe { lime_model_occt::lime_occt_string_free(answer) };
    serde_json::from_str(&reply).unwrap_or_else(|err| panic!("not JSON ({err}): {reply}"))
}

fn boss(x: f64, op: &str) -> Value {
    json!({
        "kind": "boolean", "op": op, "primitive": "cylinder",
        "radius": if op == "fuse" { 3.0 } else { 1.0 }, "height": if op == "fuse" { 4.0 } else { 12.0 },
        "origin": [x, 0.0, if op == "fuse" { 10.0 } else { 0.0 }],
    })
}

#[test]
fn a_step_without_a_mesh_is_the_same_step() {
    let open = |key: &str| call(json!({ "call": "open", "key": key, "box": [40.0, 20.0, 10.0] }));
    if open("every").get("error").is_some() {
        assert!(!require(), "OCCT was required");
        return;
    }
    open("late");
    // The same four steps on two trees: every one meshed, or none until the end.
    let mut last = Value::Null;
    for (i, x) in [5.0, 15.0].iter().enumerate() {
        for (j, op) in ["fuse", "cut"].iter().enumerate() {
            let node = (2 * i + j + 1) as u64;
            let parent = node - 1;
            last = call(
                json!({ "call": "apply", "key": "every", "parent": parent, "node": node, "op": boss(*x, op) }),
            );
            assert!(last.get("error").is_none(), "{last}");
            assert!(
                last["positions"].is_string(),
                "a step meshes by default: {last}"
            );
            let light = call(
                json!({ "call": "apply", "key": "late", "parent": parent, "node": node, "op": boss(*x, op), "mesh": false }),
            );
            assert!(light.get("error").is_none(), "{light}");
            assert_eq!(light["format"], "lime-solid-lite", "{light}");
            assert!(
                light.get("positions").is_none() && light.get("triangles").is_none(),
                "no arrays: {light}"
            );
            assert_eq!(
                light["fingerprint"], last["fingerprint"],
                "the same solid, step {node}"
            );
            assert_eq!(light["op"], last["op"]);
        }
    }
    // A goto of the last step answers the reply an Apply that meshed gave: the same mesh, byte for byte.
    let meshed = call(json!({ "call": "goto", "key": "late", "node": 4 }));
    assert!(meshed.get("error").is_none(), "{meshed}");
    for field in [
        "format",
        "volumeMm3",
        "fingerprint",
        "positions",
        "triangles",
        "faces",
        "edgeLengths",
        "edgePoints",
        "edgeOffsets",
    ] {
        assert_eq!(
            meshed[field], last[field],
            "{field} after the same steps, meshed once at the end"
        );
    }
    // A split, which starts a tree of its own, is meshed whatever was asked.
    let split = call(json!({
        "call": "apply", "key": "late", "parent": 4, "node": 5, "mesh": false, "otherKey": "late-half",
        "op": { "kind": "split", "origin": [20.0, 0.0, 0.0], "normal": [1.0, 0.0, 0.0] },
    }));
    assert!(split.get("error").is_none(), "{split}");
    assert!(
        split["positions"].is_string() && split["other"]["positions"].is_string(),
        "a split is meshed: {split}"
    );
}

#[test]
fn a_request_that_starts_with_the_marker_is_timed() {
    if call(json!({ "call": "open", "key": "timed", "box": [20.0, 20.0, 20.0] }))
        .get("error")
        .is_some()
    {
        assert!(!require(), "OCCT was required");
        return;
    }
    let request =
        json!({ "call": "apply", "key": "timed", "parent": 0, "node": 1, "op": boss(5.0, "fuse") })
            .to_string();
    let timed = exported(&format!("{{\"timing\":true,{}", &request[1..]));
    assert!(timed.get("error").is_none(), "{timed}");
    let kernel = &timed["kernelUs"];
    assert!(kernel["us"].as_u64().unwrap() > 0, "{timed}");
    assert!(
        kernel["builds"].as_u64().unwrap() >= 1,
        "the boolean was counted: {timed}"
    );
    assert!(
        kernel["meshUs"].as_u64().unwrap() > 0,
        "the mesh was timed: {timed}"
    );
    let counted: u64 = ["booleanUs", "volumeUs", "meshUs", "readoutUs", "describeUs"]
        .iter()
        .map(|name| kernel[name].as_u64().unwrap())
        .sum();
    assert!(
        counted <= kernel["us"].as_u64().unwrap() + 50,
        "the parts are inside the whole: {timed}"
    );
    // Without the marker the answer has no timing; the same step again is a jump to it.
    let plain = exported(&request);
    assert!(plain.get("kernelUs").is_none(), "{plain}");
}
