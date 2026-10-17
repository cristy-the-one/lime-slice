//! A step's solid saved in Open CASCADE's binary format (`export` with `format: "brep"`) and opened again: as a root,
//! and as the `seed` of a saved step. `LIME_REQUIRE_OCCT=1` makes a missing kernel a failure.

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

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn bytes(reply: &Value) -> Vec<u8> {
    let data = reply["bytesBase64"].as_str().expect("bytesBase64");
    base64::engine::general_purpose::STANDARD
        .decode(data)
        .expect("base64")
}

fn hole() -> Value {
    json!({ "kind": "hole", "origin": [10.0, 10.0, 20.0], "axis": [0.0, 0.0, -1.0], "radius": 3.0, "depth": 8.0 })
}

fn cut() -> Value {
    json!({ "kind": "boolean", "op": "cut", "primitive": "cylinder", "origin": [0.0, 0.0, 12.0], "radius": 6.0, "height": 20.0 })
}

/// What a reply says of a solid, but for its id and the nodes held: two solids that answer the same are the same.
fn shape_of(reply: &Value) -> Value {
    let mut out = reply.clone();
    for key in ["id", "held", "replayed", "op", "seedRefused"] {
        out.as_object_mut().expect("object").remove(key);
    }
    out
}

fn saved_nodes(fingerprints: &[(u32, u32, Value, Value)]) -> Value {
    Value::Array(
        fingerprints
            .iter()
            .map(|(id, parent, op, fingerprint)| json!({ "id": id, "parent": parent, "op": op, "fingerprint": fingerprint }))
            .collect(),
    )
}

#[test]
fn a_saved_solid_reopens_as_its_step() {
    let stats: Value = serde_json::from_str(&lime_model_occt::stats()).expect("stats");
    if stats.get("error").is_some() {
        assert!(!require(), "Open CASCADE is required: {stats}");
        return;
    }
    let root = json!({ "primitive": "box", "origin": [0.0, 0.0, 0.0], "size": [20.0, 20.0, 20.0] });
    ok(json!({ "call": "open", "key": "a", "primitive": root, "chordMm": 0.1 }));
    let one = ok(
        json!({ "call": "apply", "key": "a", "parent": 0, "node": 1, "op": hole(), "chordMm": 0.1 }),
    );
    let two = ok(
        json!({ "call": "apply", "key": "a", "parent": 1, "node": 2, "op": cut(), "chordMm": 0.1 }),
    );

    // The binary format: a header line with the format, the Open CASCADE version, the volume, and the edges the step made.
    let saved = ok(json!({ "call": "export", "key": "a", "node": 2, "format": "brep" }));
    assert_eq!(saved["format"], "brep");
    let solid = bytes(&saved);
    let header = String::from_utf8_lossy(&solid[..solid.iter().position(|&b| b == b'\n').unwrap()])
        .to_string();
    let fields: Vec<&str> = header.split(' ').collect();
    assert_eq!(
        fields[..3],
        ["LIMEBREP", "1", stats["version"].as_str().unwrap()],
        "{header}"
    );
    assert_eq!(
        fields[3].parse::<f64>().unwrap(),
        two["fingerprint"]["volumeMm3"].as_f64().unwrap(),
        "the step's own volume, not integrated again"
    );
    assert!(
        fields[4] != "*" && !fields[4].is_empty(),
        "a cut made some of its edges, not all: {header}"
    );
    let step = ok(json!({ "call": "export", "key": "a", "node": 2 }));
    assert_eq!(step["format"], "step", "STEP stays the default");
    assert!(bytes(&step).starts_with(b"ISO-10303-21"));
    assert!(
        solid.len() < bytes(&step).len(),
        "the binary solid is smaller than its STEP"
    );

    // As a root: the same solid, face for face and edge for edge, and a fillet by edge index builds the same.
    let read = ok(json!({ "call": "open", "key": "b", "dataB64": b64(&solid), "chordMm": 0.1 }));
    assert_eq!(
        shape_of(&read),
        shape_of(&two),
        "the read solid answers as the step"
    );
    let fillet = (0..40)
        .map(|edge| json!({ "kind": "fillet", "edges": [edge], "size": 1.0 }))
        .find(|op| call(json!({ "call": "probe", "key": "a", "node": 2, "op": op }))["ok"] == true)
        .expect("an edge of the cut part takes a 1 mm fillet");
    let built = ok(
        json!({ "call": "apply", "key": "a", "parent": 2, "node": 3, "op": fillet, "chordMm": 0.1 }),
    );
    let on_read = ok(
        json!({ "call": "apply", "key": "b", "parent": 0, "node": 1, "op": fillet, "chordMm": 0.1 }),
    );
    assert_eq!(
        built["fingerprint"], on_read["fingerprint"],
        "the same edges by the same numbers"
    );
    assert_eq!(
        bytes(&ok(
            json!({ "call": "export", "key": "b", "node": 0, "format": "brep" })
        ))
        .len(),
        solid.len()
    );

    // As a seed: the whole tree opens with step 2 from the saved solid, nothing above it replayed.
    let nodes = saved_nodes(&[
        (1, 0, hole(), one["fingerprint"].clone()),
        (2, 1, cut(), two["fingerprint"].clone()),
    ]);
    let before: Value = serde_json::from_str(&lime_model_occt::stats()).unwrap();
    let seeded = ok(
        json!({ "call": "open", "key": "c", "primitive": root, "chordMm": 0.1, "nodes": nodes, "current": 2, "seed": { "node": 2, "dataB64": b64(&solid) } }),
    );
    let after: Value = serde_json::from_str(&lime_model_occt::stats()).unwrap();
    assert!(seeded.get("seedRefused").is_none(), "{seeded}");
    assert_eq!(seeded["replayed"], 0);
    assert_eq!(after["builds"], before["builds"], "no step was built");
    assert_eq!(shape_of(&seeded), shape_of(&two));
    // A blend that takes the edges step 2 made picks them on the seed, as on the step built.
    let made = json!({ "kind": "fillet", "edges": [{ "fromNode": 2 }], "size": 0.5 });
    let a = ok(
        json!({ "call": "apply", "key": "a", "parent": 2, "node": 4, "op": made, "chordMm": 0.1 }),
    );
    let c = ok(
        json!({ "call": "apply", "key": "c", "parent": 2, "node": 4, "op": made, "chordMm": 0.1 }),
    );
    assert_eq!(a["fingerprint"], c["fingerprint"]);
    assert_eq!(a["op"], c["op"], "the same edges stored");
    // Quiet: the step is built and kept, and only named, for a caller that asks for it next.
    let quiet = ok(
        json!({ "call": "open", "key": "q", "primitive": root, "chordMm": 0.1, "nodes": nodes, "current": 2, "seed": { "node": 2, "dataB64": b64(&solid) }, "quiet": true }),
    );
    assert_eq!(quiet["fingerprint"], two["fingerprint"]);
    assert!(
        quiet.get("positions").is_none() && quiet.get("faces").is_none(),
        "{quiet}"
    );
    assert_eq!(quiet["replayed"], 0);
    assert_eq!(
        shape_of(&ok(
            json!({ "call": "goto", "key": "q", "node": 2, "chordMm": 0.1 })
        )),
        shape_of(&two)
    );
    ok(json!({ "call": "close", "key": "q" }));
    // A step above the seed builds from the root.
    let up = ok(json!({ "call": "goto", "key": "c", "node": 1, "chordMm": 0.1 }));
    assert_eq!(up["fingerprint"], one["fingerprint"]);
    assert_eq!(up["replayed"], 1);

    // The seed stays however many other solids come and go: building it again would replay every step above it.
    lime_model_occt::set_tree_limits(0, 0);
    for node in 5..8 {
        ok(
            json!({ "call": "apply", "key": "c", "parent": node - 1, "node": node, "op": { "kind": "scale", "factor": 1.01 }, "chordMm": 0.1 }),
        );
    }
    let held = ok(json!({ "call": "goto", "key": "c", "node": 2, "chordMm": 0.1 }));
    assert_eq!(held["replayed"], 0, "{held}");
    lime_model_occt::set_tree_limits(24, 8);

    // A seed that is not the step it names, a STEP, or damaged bytes is refused, and the step is replayed instead.
    let wrong = ok(
        json!({ "call": "open", "key": "d", "primitive": root, "chordMm": 0.1, "nodes": nodes, "current": 1, "seed": { "node": 1, "dataB64": b64(&solid) } }),
    );
    assert!(
        wrong["seedRefused"]
            .as_str()
            .unwrap()
            .starts_with("This step rebuilt differently"),
        "{wrong}"
    );
    assert_eq!(wrong["fingerprint"], one["fingerprint"]);
    assert_eq!(wrong["replayed"], 1);
    let as_step = ok(
        json!({ "call": "open", "key": "d", "primitive": root, "chordMm": 0.1, "nodes": nodes, "current": 2, "seed": { "node": 2, "dataB64": b64(&bytes(&step)) } }),
    );
    assert_eq!(
        as_step["seedRefused"],
        "Only a solid saved in Open CASCADE's binary format seeds a step"
    );
    assert_eq!(as_step["replayed"], 2);
    let mut cut_short = solid.clone();
    cut_short.truncate(solid.len() / 2);
    let damaged = ok(
        json!({ "call": "open", "key": "d", "primitive": root, "chordMm": 0.1, "nodes": nodes, "current": 2, "seed": { "node": 2, "dataB64": b64(&cut_short) } }),
    );
    assert!(damaged["seedRefused"].is_string(), "{damaged}");
    assert_eq!(damaged["fingerprint"], two["fingerprint"]);
    let root_damaged =
        call(json!({ "call": "open", "key": "e", "dataB64": b64(&cut_short), "chordMm": 0.1 }));
    assert!(root_damaged["error"].is_string(), "{root_damaged}");
    let mut other_format = solid.clone();
    other_format[9] = b'9';
    let newer =
        call(json!({ "call": "open", "key": "e", "dataB64": b64(&other_format), "chordMm": 0.1 }));
    assert_eq!(
        newer["error"],
        "This solid was saved in format 9, which this modeler does not read"
    );

    for key in ["a", "b", "c", "d"] {
        ok(json!({ "call": "close", "key": key }));
    }
}
