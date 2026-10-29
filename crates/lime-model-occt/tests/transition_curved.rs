//! Print transitions, step 6 (docs/plan-belt-transitions.md, sections 4 and 8): flat faces stored as B-splines, curved
//! edges and faces, tangent chains, mitres where picked edges meet at an angle, and wedges that end at walls. Every part
//! is synthetic. `LIME_REQUIRE_OCCT=1` makes a missing kernel a failure.
//!
//! The store is process-wide, so everything runs in one test, in order, each part in its own document.

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

fn volume(reply: &Value) -> f64 {
    reply["volumeMm3"].as_f64().expect("volumeMm3")
}

fn near(actual: f64, expected: f64, tolerance: f64) {
    assert!(
        (actual - expected).abs() < tolerance,
        "{actual} is not near {expected}"
    );
}

/// The IR3 V2's build direction for a part lying as built: the belt at 45°, layers stacking toward −Y.
fn belt() -> [f64; 3] {
    let s = std::f64::consts::FRAC_1_SQRT_2;
    [0.0, -s, s]
}

const UP: [f64; 3] = [0.0, 0.0, 1.0];
const WIDTH: f64 = 20.0;

/// Step 1's 2 mm shell, its roof 20° past the limit, extruded `WIDTH` along X: the corner at Y 30, Z 20.
fn corner_coupon(key: &str) -> Value {
    let fall = 20f64.to_radians().tan();
    let end = 20.0 - 28.0 * fall;
    let outer_roof = |y: f64| 20.0 + 2.0 / fall.atan().cos() - (30.0 - y) * fall;
    let yc = (22.828 + 30.0 - (20.0 + 2.0 / fall.atan().cos() - 30.0 * fall)) / (1.0 + fall);
    let profile = vec![
        [0.0, 0.0],
        [2.0, 0.0],
        [2.0, end],
        [30.0, 20.0],
        [50.0, 0.0],
        [52.828, 0.0],
        [yc, 22.828 - (yc - 30.0)],
        [0.0, outer_roof(0.0)],
    ];
    let top = profile.iter().map(|p| p[1]).fold(0.0, f64::max);
    ok(json!({ "call": "open", "key": key,
        "primitive": { "primitive": "box", "origin": [-WIDTH / 2.0, -1.0, 0.0], "size": [WIDTH, 54.828, top + 1.0] } }));
    ok(
        json!({ "call": "apply", "key": key, "parent": 0, "node": 1, "op": {
        "kind": "extrude", "op": "common", "origin": [-WIDTH / 2.0, 0.0, 0.0], "turn": [90.0, 0.0, 90.0],
        "profile": profile, "depth": WIDTH } }),
    )
}

fn find(key: &str, node: u32, build: [f64; 3], fix: Value) -> Value {
    ok(
        json!({ "call": "transitionFind", "key": key, "node": node, "build": build, "up": UP, "limitDeg": 45.0, "fix": fix }),
    )
}

fn rows(found: &Value) -> Vec<Value> {
    found["rows"].as_array().expect("rows").clone()
}

/// The row whose edge's middle is within 1e-3 of `mid`.
fn row_at(found: &Value, mid: [f64; 3]) -> Value {
    rows(found)
        .into_iter()
        .find(|row| {
            (0..3).all(|i| (row["mid"][i].as_f64().unwrap_or(f64::NAN) - mid[i]).abs() < 1e-3)
        })
        .unwrap_or_else(|| panic!("no row at {mid:?}: {found}"))
}

fn transition(edges: Value, build: [f64; 3], extra: Value) -> Value {
    let mut op = json!({ "kind": "transition", "edges": edges, "build": build });
    if let Value::Object(fields) = extra {
        for (key, value) in fields {
            op[key] = value;
        }
    }
    op
}

fn probe(key: &str, node: u32, op: Value) -> Value {
    call(json!({ "call": "probe", "key": key, "node": node, "op": op }))
}

#[test]
fn curves_chains_and_walls() {
    let opened = call(
        json!({ "call": "open", "key": "c0", "primitive": { "primitive": "box", "origin": [0.0, 0.0, 0.0], "size": [10.0, 10.0, 10.0] } }),
    );
    if opened.get("error").is_some() {
        assert!(!require(), "OCCT was required: {opened}");
        return;
    }

    // --- A flat face stored as a B-spline. The step 2 coupon, every surface and curve converted to NURBS as a STEP file
    // may store them, reads as the same corner and takes the same 2 mm wedge.
    let planes = corner_coupon("flat");
    let nurbs = ok(json!({ "call": "testNurbs", "key": "flat", "node": 1 }));
    let opened = ok(json!({ "call": "open", "key": "spline", "dataB64": nurbs["dataB64"] }));
    near(volume(&opened), volume(&planes), 1e-3);
    let fix = json!({ "mode": "auto", "angleDeg": 45.0, "size": 2.0 });
    let from_planes = find("flat", 1, belt(), fix.clone());
    let from_splines = find("spline", 0, belt(), fix.clone());
    assert_eq!(from_splines["curvedSkipped"], json!(0), "{from_splines}");
    let bend = [0.0, 30.0, 20.0];
    let plane_row = row_at(&from_planes, bend);
    let spline_row = row_at(&from_splines, bend);
    assert_eq!(spline_row["case"], json!("corner"), "{spline_row}");
    assert_eq!(
        spline_row["curved"],
        json!(false),
        "a flat B-spline face is flat: {spline_row}"
    );
    near(spline_row["farDeg"].as_f64().unwrap(), 25.0, 1e-3);
    let wedge = plane_row["probe"]["transition"][0]["volumeMm3"]
        .as_f64()
        .unwrap();
    near(wedge, 17.5, 0.1);
    assert_eq!(spline_row["probe"]["ok"], json!(true), "{spline_row}");
    near(
        spline_row["probe"]["transition"][0]["volumeMm3"]
            .as_f64()
            .unwrap(),
        wedge,
        1e-3,
    );
    assert_eq!(
        spline_row["probe"]["transition"][0]["path"],
        json!("prism"),
        "{spline_row}"
    );
    // Applied, then rebuilt under an edit above it: the step stores the edge as read (its B-spline faces) and finds it
    // again on the rebuilt solid.
    let notch = |size: f64| json!({ "kind": "boolean", "op": "cut", "primitive": "box", "origin": [-WIDTH / 2.0, 50.0, -1.0], "size": [size, 1.0, 1.5] });
    let notched =
        ok(json!({ "call": "apply", "key": "spline", "parent": 0, "node": 1, "op": notch(2.0) }));
    let found = find("spline", 1, belt(), fix.clone());
    let edge = row_at(&found, bend)["edge"].clone();
    let applied = ok(
        json!({ "call": "apply", "key": "spline", "parent": 1, "node": 2,
        "op": transition(json!([edge]), belt(), json!({ "size": 2.0 })) }),
    );
    near(volume(&applied) - volume(&notched), wedge, 0.05);
    let stored = applied["op"].clone();
    assert!(
        stored["edges"][0]["sig"].is_object(),
        "stored with its signature: {stored}"
    );
    let edited = ok(
        json!({ "call": "edit", "key": "spline", "parent": 0, "node": 3, "op": notch(4.0),
        "replay": [{ "id": 4, "op": stored }], "chordMm": 0.1 }),
    );
    assert!(
        edited.get("broken").is_none() || edited["broken"].is_null(),
        "{edited}"
    );
    assert_eq!(edited["id"], json!(4), "{edited}");
    let rebuilt_notch = ok(json!({ "call": "goto", "key": "spline", "node": 3 }));
    near(volume(&edited) - volume(&rebuilt_notch), wedge, 0.05);

    // --- A curved edge: a disc over a post on a flat bed. The ring where the post meets the disc's underside is a
    // concave circle between a cylinder (90° to the layers) and a plane (0°). Its 2 mm wedge at 45° is swept around the
    // ring with its binormal held to the build: a cone ring whose section is the 2 by 2 mm triangle.
    ok(
        json!({ "call": "open", "key": "disc", "primitive": { "primitive": "cylinder", "origin": [0.0, 0.0, 0.0], "radius": 10.0, "height": 10.0 } }),
    );
    ok(
        json!({ "call": "apply", "key": "disc", "parent": 0, "node": 1,
        "op": { "kind": "boolean", "op": "fuse", "primitive": "cylinder", "origin": [0.0, 0.0, 10.0], "radius": 20.0, "height": 5.0 } }),
    );
    let found = find("disc", 1, UP, fix.clone());
    let ring = rows(&found)
        .into_iter()
        .find(|row| row["case"] == json!("corner") && row["curved"] == json!(true))
        .unwrap_or_else(|| panic!("no curved corner: {found}"));
    near(
        ring["lengthMm"].as_f64().unwrap(),
        2.0 * std::f64::consts::PI * 10.0,
        0.5,
    );
    near(ring["farDeg"].as_f64().unwrap(), 0.0, 1e-3);
    near(ring["nearDeg"].as_f64().unwrap(), 90.0, 1e-3);
    assert_eq!(ring["probe"]["ok"], json!(true), "{ring}");
    let swept = &ring["probe"]["transition"][0];
    assert_eq!(swept["path"], json!("sweep"), "{swept}");
    near(swept["angleRangeDeg"][0].as_f64().unwrap(), 45.0, 0.05);
    near(swept["angleRangeDeg"][1].as_f64().unwrap(), 45.0, 0.05);
    assert!(
        swept["soup"].as_array().is_some_and(|soup| soup.len() > 9),
        "a ghost: {swept}"
    );
    // Pappus: the triangle's 2 mm² times the path of its centroid, 10 + 2/3 mm from the axis.
    let cone_ring = 2.0 * 2.0 * std::f64::consts::PI * (10.0 + 2.0 / 3.0);
    let ring_edge = ring["edge"].clone();
    let made = ok(
        json!({ "call": "apply", "key": "disc", "parent": 1, "node": 2,
        "op": transition(json!([ring_edge.clone()]), UP, json!({ "size": 2.0 })) }),
    );
    let disc = ok(json!({ "call": "goto", "key": "disc", "node": 1 }));
    near(volume(&made) - volume(&disc), cone_ring, 0.01 * cone_ring);
    // Turned on its side the ring climbs through the layers, so one section cannot hold the angle all around.
    let tilted = probe(
        "disc",
        1,
        transition(
            json!([ring_edge]),
            [0.0, -0.5, 0.866_025_403_784_438_6],
            json!({ "size": 2.0 }),
        ),
    );
    let said = tilted["error"].as_str().unwrap_or_default();
    assert!(!said.is_empty(), "{tilted}");
    eprintln!("tilted ring: {said}");

    // --- A tangent chain: a block with a rounded vertical corner under a plate, on a flat bed. Where the block meets the
    // plate's underside, a line, a quarter circle and a line run on with no corner; one click takes all three.
    ok(
        json!({ "call": "open", "key": "chain", "primitive": { "primitive": "box", "origin": [0.0, 0.0, 0.0], "size": [20.0, 20.0, 10.0] } }),
    );
    let round = ok(
        json!({ "call": "apply", "key": "chain", "parent": 0, "node": 1,
        "op": { "kind": "fillet", "edges": [{ "index": 0, "mid": [20.0, 20.0, 5.0], "lengthMm": 10.0 }], "size": 5.0 } }),
    );
    assert!(volume(&round) < 4000.0, "{round}");
    ok(
        json!({ "call": "apply", "key": "chain", "parent": 1, "node": 2,
        "op": { "kind": "boolean", "op": "fuse", "primitive": "box", "origin": [0.0, 0.0, 10.0], "size": [40.0, 40.0, 5.0] } }),
    );
    let found = find("chain", 2, UP, fix.clone());
    let line = row_at(&found, [20.0, 7.5, 10.0]);
    let chained =
        ok(json!({ "call": "edgeChain", "key": "chain", "node": 2, "edge": line["edge"] }));
    let edges = chained["edges"].as_array().expect("edges").clone();
    assert_eq!(edges.len(), 3, "a line, an arc and a line: {chained}");
    assert_eq!(edges[0], line["edge"], "the picked edge first: {chained}");
    assert_eq!(chained["closed"], json!(false));
    let tray = ok(json!({ "call": "goto", "key": "chain", "node": 2 }));
    let chain_op = transition(Value::Array(edges.clone()), UP, json!({ "size": 2.0 }));
    let run = probe("chain", 2, chain_op.clone());
    assert_eq!(run["ok"], json!(true), "{run}");
    let paths: Vec<Value> = run["transition"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["path"].clone())
        .collect();
    assert_eq!(
        paths.iter().filter(|p| **p == json!("sweep")).count(),
        1,
        "{paths:?}"
    );
    // Two 15 mm straight runs, and a quarter of a cone ring around the rounded corner's axis, 5 mm out.
    let quarter = 2.0 * 0.5 * std::f64::consts::PI * (5.0 + 2.0 / 3.0);
    let chain_volume = 2.0 * 15.0 * 2.0 + quarter;
    let built =
        ok(json!({ "call": "apply", "key": "chain", "parent": 2, "node": 3, "op": chain_op }));
    near(
        volume(&built) - volume(&tray),
        chain_volume,
        0.02 * chain_volume,
    );
    for row in run["transition"].as_array().unwrap() {
        assert_eq!(
            row["ends"],
            json!(["flush", "flush"]),
            "tangent joins and open ends meet flush: {row}"
        );
    }

    // --- A mitre: the same block with a square corner. Its two edges under the plate meet at 90°, so each is its own
    // chain, and picked together their wedges are cut on the bisecting plane and meet with no notch and no spike.
    ok(
        json!({ "call": "open", "key": "mitre", "primitive": { "primitive": "box", "origin": [0.0, 0.0, 0.0], "size": [20.0, 20.0, 10.0] } }),
    );
    ok(
        json!({ "call": "apply", "key": "mitre", "parent": 0, "node": 1,
        "op": { "kind": "boolean", "op": "fuse", "primitive": "box", "origin": [0.0, 0.0, 10.0], "size": [40.0, 40.0, 5.0] } }),
    );
    let found = find("mitre", 1, UP, fix.clone());
    let side = row_at(&found, [20.0, 10.0, 10.0]);
    let back = row_at(&found, [10.0, 20.0, 10.0]);
    let alone = ok(json!({ "call": "edgeChain", "key": "mitre", "node": 1, "edge": side["edge"] }));
    assert_eq!(
        alone["edges"],
        json!([side["edge"]]),
        "a 90° turn ends the chain: {alone}"
    );
    let both = transition(
        json!([side["edge"], back["edge"]]),
        UP,
        json!({ "size": 2.0 }),
    );
    let mitred = probe("mitre", 1, both.clone());
    assert_eq!(mitred["ok"], json!(true), "{mitred}");
    for row in mitred["transition"].as_array().unwrap() {
        assert!(
            row["ends"].as_array().unwrap().contains(&json!("mitre")),
            "{row}"
        );
    }
    // Each 20 mm wedge, and the corner square between them filled once: the two halves of a 2 by 2 by 2 mm pyramid's
    // worth of mitre, which together are a prism's corner of 2 × 2 × 2 / 3 mm³.
    let plate = ok(json!({ "call": "goto", "key": "mitre", "node": 1 }));
    let built = ok(json!({ "call": "apply", "key": "mitre", "parent": 1, "node": 2, "op": both }));
    let added = volume(&built) - volume(&plate);
    near(added, 2.0 * 2.0 * 20.0 + 8.0 / 3.0, 0.05);

    // --- Walls at both ends: a U whose side walls stand at the corner's ends. The wedge runs into each wall by its own
    // size and merges there; the walls stand square, so it adds only its own volume.
    ok(
        json!({ "call": "open", "key": "walls", "primitive": { "primitive": "box", "origin": [0.0, -5.0, 0.0], "size": [20.0, 50.0, 10.0] } }),
    );
    let mut node = 1;
    for (origin, size) in [
        ([0.0, -5.0, 10.0], [40.0, 50.0, 5.0]),
        ([0.0, -5.0, 0.0], [40.0, 5.0, 15.0]),
        ([0.0, 40.0, 0.0], [40.0, 5.0, 15.0]),
    ] {
        ok(
            json!({ "call": "apply", "key": "walls", "parent": node - 1, "node": node,
            "op": { "kind": "boolean", "op": "fuse", "primitive": "box", "origin": origin, "size": size } }),
        );
        node += 1;
    }
    let tip = node - 1;
    let found = find("walls", tip, UP, fix);
    let between = row_at(&found, [20.0, 20.0, 10.0]);
    near(between["lengthMm"].as_f64().unwrap(), 40.0, 1e-3);
    let walled = probe(
        "walls",
        tip,
        transition(json!([between["edge"]]), UP, json!({ "size": 2.0 })),
    );
    assert_eq!(walled["ok"], json!(true), "{walled}");
    assert_eq!(
        walled["transition"][0]["ends"],
        json!(["wall", "wall"]),
        "{walled}"
    );
    let u = ok(json!({ "call": "goto", "key": "walls", "node": tip }));
    near(volume(&walled) - volume(&u), 2.0 * 40.0, 0.05);
}
