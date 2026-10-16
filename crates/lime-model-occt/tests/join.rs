//! Booleans between two trees: a join takes another tree's solid at one of its steps, placed by a
//! rigid matrix. `LIME_REQUIRE_OCCT=1` makes a missing kernel a failure.
//!
//! The store is process-wide, so everything runs in one test, in order.

use std::f64::consts::PI;

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

fn refused(request: Value) -> String {
    let reply = call(request.clone());
    reply["error"]
        .as_str()
        .unwrap_or_else(|| panic!("{request} was not refused: {reply}"))
        .to_string()
}

fn volume(reply: &Value) -> f64 {
    reply["volumeMm3"].as_f64().expect("volumeMm3")
}

fn near(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() < 1e-3,
        "{actual} is not near {expected}"
    );
}

fn builds() -> i64 {
    let stats: Value = serde_json::from_str(&lime_model_occt::stats()).expect("stats");
    stats["builds"].as_i64().expect("builds")
}

/// Turned 90° about Z, then moved by `t`.
fn quarter_turn(t: [f64; 3]) -> Value {
    json!({ "m": [0.0, -1.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0], "t": t })
}

fn identity() -> Value {
    json!({ "m": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0], "t": [0.0, 0.0, 0.0] })
}

fn join(op: &str, key: &str, node: u64, relative: Value) -> Value {
    json!({
        "kind": "join",
        "op": op,
        "tool": { "key": key, "node": node, "object": format!("obj-{key}"), "name": format!("Part {key}") },
        "relative": relative,
        "keepTool": false,
    })
}

fn apply(key: &str, parent: u64, node: u64, op: Value) -> Value {
    call(json!({ "call": "apply", "key": key, "parent": parent, "node": node, "op": op }))
}

#[test]
fn joins_between_trees() {
    let target = call(json!({ "call": "open", "key": "a", "box": [20.0, 20.0, 20.0] }));
    if target.get("error").is_some() {
        assert!(!require(), "OCCT was required: {target}");
        return;
    }
    near(volume(&target), 8000.0);
    // A 10×4×2 bar turned a quarter about Z spans x −4..0, y 0..10, z 0..2; moved by (2, 15, 19) it
    // overlaps the 20 mm box by 2×5×1 = 10 mm³. Unturned it would overlap 10×4×1 = 40 mm³.
    let tool = ok(json!({ "call": "open", "key": "b", "box": [10.0, 4.0, 2.0] }));
    near(volume(&tool), 80.0);
    let placed = quarter_turn([2.0, 15.0, 19.0]);

    let probe = call(
        json!({ "call": "probe", "key": "a", "node": 0, "op": join("cut", "b", 0, placed.clone()) }),
    );
    assert_eq!(probe["ok"], true, "{probe}");
    let before = builds();
    // Keep the tool object changes no solid: Apply still takes the probe's, and stores what it was sent.
    let mut kept = join("cut", "b", 0, placed.clone());
    kept["keepTool"] = json!(true);
    let cut = apply("a", 0, 1, kept);
    assert!(cut.get("error").is_none(), "{cut}");
    near(volume(&cut), 7990.0);
    assert_eq!(builds(), before, "Apply takes the probe's solid");
    assert_eq!(
        cut["op"]["tool"],
        json!({ "key": "b", "node": 0, "object": "obj-b", "name": "Part b" })
    );
    assert_eq!(cut["op"]["keepTool"], true);

    let fused = apply("a", 0, 2, join("fuse", "b", 0, placed.clone()));
    near(volume(&fused), 8070.0);
    let common = apply("a", 0, 3, join("common", "b", 0, placed.clone()));
    near(volume(&common), 10.0);
    let apart = call(
        json!({ "call": "probe", "key": "a", "node": 0, "op": join("common", "b", 0, quarter_turn([100.0, 0.0, 0.0])) }),
    );
    assert_eq!(apart["ok"], false);
    assert_eq!(apart["error"], "The solids do not overlap");

    // Replay: the whole tree again from its root and ops rebuilds the same step, built from b's step 0.
    let fingerprint = cut["fingerprint"].clone();
    let reopened = ok(json!({
        "call": "open", "key": "a", "box": [20.0, 20.0, 20.0],
        "nodes": [{ "id": 1, "parent": 0, "op": cut["op"], "fingerprint": fingerprint }],
        "current": 1,
    }));
    assert_eq!(reopened["fingerprint"], fingerprint);
    assert_eq!(reopened["replayed"], 1);

    // A tool whose current step changed after Apply: the join keeps the step it named.
    let grown = apply(
        "b",
        0,
        1,
        json!({ "kind": "boolean", "op": "fuse", "primitive": "box", "origin": [0.0, 0.0, 0.0], "size": [10.0, 4.0, 6.0] }),
    );
    near(volume(&grown), 240.0);
    let again = ok(json!({
        "call": "open", "key": "a", "box": [20.0, 20.0, 20.0],
        "nodes": [{ "id": 1, "parent": 0, "op": cut["op"], "fingerprint": fingerprint }],
        "current": 1,
    }));
    assert_eq!(again["fingerprint"], fingerprint);

    // The placement is a turn and a move only.
    let stretched =
        json!({ "m": [2.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0], "t": [0.0, 0.0, 0.0] });
    let mirrored =
        json!({ "m": [-1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0], "t": [0.0, 0.0, 0.0] });
    let sheared =
        json!({ "m": [1.0, 0.5, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0], "t": [0.0, 0.0, 0.0] });
    let rigid_only =
        "The tool's placement must be a turn and a move only, with no scale, shear, or mirror";
    for matrix in [stretched, mirrored, sheared] {
        let probe = call(
            json!({ "call": "probe", "key": "a", "node": 0, "op": join("cut", "b", 0, matrix.clone()) }),
        );
        assert_eq!(probe, json!({ "ok": false, "error": rigid_only }));
        assert_eq!(
            refused(
                json!({ "call": "apply", "key": "a", "parent": 0, "node": 9, "op": join("cut", "b", 0, matrix) })
            ),
            rigid_only
        );
    }

    // A part is never its own tool.
    assert_eq!(
        refused(
            json!({ "call": "apply", "key": "a", "parent": 0, "node": 9, "op": join("cut", "a", 0, identity()) })
        ),
        "A part cannot be its own tool"
    );

    // A loop: a's step 1 takes b's step 0, so b cannot take a's step 1 (nor any step of a).
    let cycle = "The tool object's history already uses this part, so the two cannot be joined";
    assert_eq!(
        refused(
            json!({ "call": "apply", "key": "b", "parent": 1, "node": 2, "op": join("fuse", "a", 1, identity()) })
        ),
        cycle
    );
    let probe = call(
        json!({ "call": "probe", "key": "b", "node": 1, "op": join("fuse", "a", 0, identity()) }),
    );
    assert_eq!(probe, json!({ "ok": false, "error": cycle }));

    // A chain: c takes a's step 1, which took b's step 0. Both replay from their roots.
    ok(json!({ "call": "open", "key": "c", "box": [30.0, 30.0, 10.0] }));
    let chained = apply(
        "c",
        0,
        1,
        join(
            "cut",
            "a",
            1,
            json!({ "m": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0], "t": [5.0, 5.0, -15.0] }),
        ),
    );
    // a's step 1 moved by (5, 5, −15) overlaps c by 20×20×5, less its 10 mm³ notch, now at z 4..5.
    near(volume(&chained), 9000.0 - 1990.0);

    // Drop and close refuse what a kept join names, and let it go once the join goes.
    let kept_tool = "A step of another part's history uses this part as its tool, so it stays open";
    assert_eq!(refused(json!({ "call": "close", "key": "b" })), kept_tool);
    assert_eq!(refused(json!({ "call": "close", "key": "a" })), kept_tool);
    let kept_step = "A step of another part's history uses a step of this branch as its tool, so it cannot be deleted";
    assert_eq!(
        refused(json!({ "call": "drop", "key": "a", "node": 1 })),
        kept_step
    );
    // b's step 1 is no tool: it goes.
    assert_eq!(
        ok(json!({ "call": "drop", "key": "b", "node": 1 }))["dropped"],
        json!([1])
    );

    // A missing tool tree answers broken, plainly, and marks nothing: once the tool is back, it builds.
    let saved = cut["op"].clone();
    ok(json!({ "call": "drop", "key": "c", "node": 1 }));
    ok(json!({ "call": "drop", "key": "a", "node": 1 }));
    ok(json!({ "call": "close", "key": "b" }));
    let missing = call(json!({
        "call": "open", "key": "a", "box": [20.0, 20.0, 20.0],
        "nodes": [{ "id": 1, "parent": 0, "op": saved, "fingerprint": fingerprint }],
        "current": 1,
    }));
    assert_eq!(
        missing,
        json!({ "error": "The tool object's history is not open in the modeler", "broken": 1, "missingTool": { "key": "b", "node": 0 } })
    );
    let unknown = call(
        json!({ "call": "probe", "key": "a", "node": 0, "op": join("cut", "b", 0, placed.clone()) }),
    );
    assert_eq!(
        unknown,
        json!({ "error": "The tool object's history is not open in the modeler", "missingTool": { "key": "b", "node": 0 } })
    );
    ok(json!({ "call": "open", "key": "b", "box": [10.0, 4.0, 2.0] }));
    let back = ok(json!({ "call": "goto", "key": "a", "node": 1 }));
    assert_eq!(back["fingerprint"], fingerprint);

    // A split piece and its parent: the halves fuse back into the whole block.
    ok(json!({ "call": "open", "key": "p", "box": [20.0, 20.0, 20.0] }));
    let split = ok(
        json!({ "call": "apply", "key": "p", "parent": 0, "node": 1, "otherKey": "p-piece",
        "op": { "kind": "split", "origin": [0.0, 0.0, 10.0], "normal": [0.0, 0.0, 1.0] } }),
    );
    near(volume(&split), 4000.0);
    let whole = apply("p", 1, 2, join("fuse", "p-piece", 0, identity()));
    near(volume(&whole), 8000.0);
    // One solid; its four sides keep the seam where it was cut, as any fuse keeps its faces.
    assert_eq!(
        whole["fingerprint"]["faces"], 10,
        "{}",
        whole["fingerprint"]
    );

    // A primitive root is a tool like any other: a cylinder r5 h10, raised 15 mm, cuts r5 × 5 mm out of the top.
    ok(
        json!({ "call": "open", "key": "cyl", "primitive": { "primitive": "cylinder", "origin": [0.0, 0.0, 0.0], "radius": 5.0, "height": 10.0 } }),
    );
    let bored = apply(
        "p",
        2,
        3,
        join(
            "cut",
            "cyl",
            0,
            json!({ "m": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0], "t": [10.0, 10.0, 15.0] }),
        ),
    );
    near(volume(&bored), 8000.0 - std::f64::consts::PI * 25.0 * 5.0);

    // A tool's step that left the cache is rebuilt for the join that needs it, from its tree's root.
    lime_model_occt::set_tree_limits(0, 0);
    ok(json!({ "call": "open", "key": "t", "box": [10.0, 10.0, 10.0] }));
    let half = json!({ "kind": "boolean", "op": "cut", "primitive": "box", "origin": [0.0, 0.0, 5.0], "size": [10.0, 10.0, 5.0] });
    near(volume(&apply("t", 0, 1, half)), 500.0);
    let quarter = json!({ "kind": "boolean", "op": "cut", "primitive": "box", "origin": [0.0, 5.0, 0.0], "size": [10.0, 5.0, 5.0] });
    let shown = apply("t", 1, 2, quarter);
    assert_eq!(
        shown["held"],
        json!([0, 2]),
        "step 1 is neither the root nor shown, so it left the cache"
    );
    ok(json!({ "call": "open", "key": "u", "box": [20.0, 20.0, 20.0] }));
    let rebuilt = apply("u", 0, 1, join("cut", "t", 1, identity()));
    near(volume(&rebuilt), 7500.0);
    lime_model_occt::set_tree_limits(24, 8);

    // A probe of one placement is not taken for another.
    let probe = call(
        json!({ "call": "probe", "key": "u", "node": 0, "op": join("fuse", "t", 1, identity()) }),
    );
    assert_eq!(probe["ok"], true, "{probe}");
    let before = builds();
    let far = apply(
        "u",
        0,
        2,
        join(
            "fuse",
            "t",
            1,
            json!({ "m": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0], "t": [100.0, 0.0, 0.0] }),
        ),
    );
    near(volume(&far), 8500.0);
    assert_eq!(builds(), before + 1, "another placement builds again");

    // A loop check that reaches a tree this engine does not hold asks for it first.
    ok(json!({
        "call": "open", "key": "x", "box": [5.0, 5.0, 5.0],
        "nodes": [{ "id": 1, "parent": 0, "op": join("cut", "gone", 0, identity()), "fingerprint": null }],
        "current": 0,
    }));
    let asked = call(
        json!({ "call": "probe", "key": "u", "node": 0, "op": join("fuse", "x", 0, identity()) }),
    );
    assert_eq!(
        asked,
        json!({ "error": "The tool object's history is not open in the modeler", "missingTool": { "key": "gone", "node": 0 } })
    );

    edits_across_trees();
    probe_preview();
}

fn ids(reply: &Value) -> Vec<u64> {
    reply["built"]
        .as_array()
        .expect("built")
        .iter()
        .map(|step| step["id"].as_u64().expect("id"))
        .collect()
}

fn rod_root(radius: f64) -> Value {
    json!({ "kind": "root", "primitive": "cylinder", "origin": [0.0, 0.0, 0.0], "radius": radius, "height": 40.0 })
}

fn stats(key: &str) -> i64 {
    let stats: Value = serde_json::from_str(&lime_model_occt::stats()).expect("stats");
    stats[key].as_i64().unwrap_or_else(|| panic!("{key}"))
}

/// A tool step edited from the target's history: the tool's tree forks, the join is built again on the new tool step,
/// and the target's later steps replay, in one call. The old branches keep their solids.
fn edits_across_trees() {
    // A rod r2 h40 standing on its origin, scaled 1.5 about its middle (z 20): r3, z −10..50.
    ok(
        json!({ "call": "open", "key": "rod", "primitive": { "primitive": "cylinder", "origin": [0.0, 0.0, 0.0], "radius": 2.0, "height": 40.0 } }),
    );
    let scaled = apply("rod", 0, 1, json!({ "kind": "scale", "factor": 1.5 }));
    near(volume(&scaled), PI * 9.0 * 60.0);
    // Moved 15 mm down into a 20 mm box at (10, 10), it bores right through: π·3²·20.
    let placed =
        json!({ "m": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0], "t": [10.0, 10.0, -15.0] });
    ok(json!({ "call": "open", "key": "tb", "box": [20.0, 20.0, 20.0] }));
    let bored = apply("tb", 0, 1, join("cut", "rod", 1, placed.clone()));
    near(volume(&bored), 8000.0 - PI * 9.0 * 20.0);
    let corner = json!({ "kind": "boolean", "op": "cut", "primitive": "box", "origin": [0.0, 0.0, 15.0], "size": [5.0, 5.0, 5.0] });
    let notched = apply("tb", 1, 2, corner.clone());
    near(volume(&notched), 8000.0 - PI * 9.0 * 20.0 - 125.0);

    // The rod's radius to 3: a root step under its root, its scale replayed, so r4.5, then the join and the notch again.
    let edit = |tools: Value, op: Value, node: u64, replay: Value| {
        call(
            json!({ "call": "edit", "key": "tb", "parent": 0, "node": node, "op": op, "replay": replay, "tools": tools }),
        )
    };
    let wider = edit(
        json!([{ "key": "rod", "parent": 0, "node": 2, "op": rod_root(3.0), "replay": [{ "id": 3, "op": { "kind": "scale", "factor": 1.5 } }] }]),
        join("cut", "rod", 3, placed.clone()),
        3,
        json!([{ "id": 4, "op": corner.clone() }]),
    );
    assert!(wider.get("error").is_none(), "{wider}");
    near(volume(&wider), 8000.0 - PI * 4.5 * 4.5 * 20.0 - 125.0);
    assert_eq!(wider["id"], 4);
    assert_eq!(ids(&wider), vec![3, 4]);
    assert_eq!(wider["tools"][0]["key"], "rod");
    assert_eq!(
        wider["tools"][0]["built"]
            .as_array()
            .expect("built")
            .iter()
            .map(|step| step["id"].as_u64().expect("id"))
            .collect::<Vec<_>>(),
        vec![2, 3]
    );
    assert_eq!(
        wider["built"][0]["op"]["tool"]["node"], 3,
        "the join names the new tool step"
    );
    // The old branches are as they were, in both trees.
    near(
        volume(&ok(json!({ "call": "goto", "key": "tb", "node": 2 }))),
        8000.0 - PI * 9.0 * 20.0 - 125.0,
    );
    near(
        volume(&ok(json!({ "call": "goto", "key": "rod", "node": 1 }))),
        PI * 9.0 * 60.0,
    );

    // A tool edit that does not build keeps nothing in either tree, and says why.
    let flat = edit(
        json!([{ "key": "rod", "parent": 0, "node": 5, "op": rod_root(0.0), "replay": [] }]),
        join("cut", "rod", 5, placed.clone()),
        5,
        json!([]),
    );
    assert!(flat["error"].is_string(), "{flat}");
    assert_eq!(
        call(json!({ "call": "goto", "key": "rod", "node": 5 }))["missing"],
        json!([5])
    );
    assert_eq!(
        call(json!({ "call": "goto", "key": "tb", "node": 5 }))["missing"],
        json!([5])
    );

    // A join that does not build, on a tool step that did, keeps nothing either: the tool's new step goes too.
    let far = json!({ "m": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0], "t": [500.0, 0.0, 0.0] });
    let apart = edit(
        json!([{ "key": "rod", "parent": 1, "node": 5, "op": { "kind": "scale", "factor": 1.1 }, "replay": [] }]),
        join("common", "rod", 5, far),
        5,
        json!([]),
    );
    assert_eq!(apart["error"], "The solids do not overlap", "{apart}");
    assert_eq!(
        call(json!({ "call": "goto", "key": "rod", "node": 5 }))["missing"],
        json!([5])
    );
    assert_eq!(
        call(json!({ "call": "goto", "key": "tb", "node": 5 }))["missing"],
        json!([5])
    );

    // A tool step that no longer builds is kept broken, as in any replay, and so is the join it fed, with the target's
    // steps unbuilt under it; the target shows the last step that built, the join's parent.
    let lost_edge = json!({ "kind": "fillet", "edges": [{ "index": 0, "mid": [99.0, 99.0, 99.0], "lengthMm": 1.0 }], "size": 0.5 });
    let broken = edit(
        json!([{ "key": "rod", "parent": 0, "node": 6, "op": rod_root(2.5), "replay": [{ "id": 7, "op": lost_edge }] }]),
        join("cut", "rod", 7, placed.clone()),
        8,
        json!([{ "id": 9, "op": corner.clone() }]),
    );
    assert!(broken.get("error").is_none(), "{broken}");
    assert_eq!(broken["id"], 0);
    assert_eq!(broken["tools"][0]["broken"]["id"], 7);
    assert_eq!(broken["broken"]["id"], 8);
    let why = broken["broken"]["error"].as_str().expect("error");
    assert!(
        why.starts_with("The tool object's step could not be rebuilt: "),
        "{why}"
    );
    assert_eq!(ids(&broken), Vec::<u64>::new());

    // Each tool edit feeds the join above it, and a tool tree the engine lacks is asked for first.
    assert_eq!(
        edit(
            json!([{ "key": "rod", "parent": 0, "node": 10, "op": rod_root(2.5), "replay": [] }]),
            join("cut", "rod", 1, placed.clone()),
            10,
            json!([]),
        )["error"],
        "Each tool tree's edit must feed the join above it"
    );
    assert_eq!(
        edit(
            json!([{ "key": "nope", "parent": 0, "node": 1, "op": rod_root(2.5), "replay": [] }]),
            join("cut", "nope", 1, placed.clone()),
            10,
            json!([]),
        ),
        json!({ "error": "The tool object's history is not open in the modeler", "missingTool": { "key": "nope", "node": 0 } })
    );

    // Two levels: tb2 takes tb's new step 4, which took rod's step 3. The rod's scale to 1.25 rebuilds all three.
    ok(json!({ "call": "open", "key": "tb2", "box": [30.0, 30.0, 10.0] }));
    let outer = apply(
        "tb2",
        0,
        1,
        join(
            "common",
            "tb",
            4,
            json!({ "m": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0], "t": [0.0, 0.0, 0.0] }),
        ),
    );
    // tb's step 4 inside z 0..10: 20×20×10 less the bore r4.5 for 10 mm.
    near(volume(&outer), 4000.0 - PI * 4.5 * 4.5 * 10.0);
    let deep = call(json!({
        "call": "edit", "key": "tb2", "parent": 0, "node": 2,
        "op": join("common", "tb", 12, json!({ "m": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0], "t": [0.0, 0.0, 0.0] })),
        "replay": [],
        "tools": [
            { "key": "rod", "parent": 2, "node": 10, "op": { "kind": "scale", "factor": 1.25 }, "replay": [] },
            { "key": "tb", "parent": 0, "node": 11, "op": join("cut", "rod", 10, placed.clone()), "replay": [{ "id": 12, "op": corner }] },
        ],
    }));
    assert!(deep.get("error").is_none(), "{deep}");
    near(volume(&deep), 4000.0 - PI * 3.75 * 3.75 * 10.0);
    assert_eq!(deep["tools"].as_array().map(Vec::len), Some(2));
}

/// A probe asked for a preview answers the built shape's reply, and an Apply that takes the probe meshes nothing again.
fn probe_preview() {
    ok(json!({ "call": "open", "key": "pv", "box": [10.0, 10.0, 10.0] }));
    let hole = json!({ "kind": "hole", "origin": [5.0, 5.0, 10.0], "axis": [0.0, 0.0, -1.0], "radius": 1.0, "depth": 4.0 });
    let plain = call(json!({ "call": "probe", "key": "pv", "node": 0, "op": hole.clone() }));
    assert_eq!(plain, json!({ "ok": true }), "no preview unless asked");
    let probe = call(
        json!({ "call": "probe", "key": "pv", "node": 0, "op": hole.clone(), "preview": true, "chordMm": 0.1 }),
    );
    assert_eq!(probe["ok"], true, "{probe}");
    assert_eq!(probe["preview"]["format"], "lime-solid-2");
    near(volume(&probe["preview"]), 1000.0 - PI * 4.0);
    let meshes = stats("meshes");
    let applied = apply("pv", 0, 1, hole);
    near(volume(&applied), 1000.0 - PI * 4.0);
    assert_eq!(applied["fingerprint"], probe["preview"]["fingerprint"]);
    assert_eq!(
        stats("meshes"),
        meshes,
        "Apply meshes nothing the preview meshed"
    );
}
