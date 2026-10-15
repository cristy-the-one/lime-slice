//! Primitive solids: as a tree's root (a new solid with no STEP file) and as a boolean's tool.
//! Each one's volume against its formula, its faces, where it sits, and every size the engine refuses.
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

/// False, and the test passes, when the kernel is not linked and nobody asked for it.
fn kernel() -> bool {
    let probe = call(json!({ "call": "open", "key": "kernel", "box": [1.0, 1.0, 1.0] }));
    if probe.get("error").is_some() {
        assert!(!require(), "OCCT was required: {probe}");
        return false;
    }
    true
}

fn near(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() < 1e-3,
        "{actual} is not near {expected}"
    );
}

fn volume(reply: &Value) -> f64 {
    reply["volumeMm3"].as_f64().expect("volumeMm3")
}

fn faces(reply: &Value) -> i64 {
    reply["fingerprint"]["faces"].as_i64().expect("faces")
}

/// The reply's triangle corners.
fn points(reply: &Value) -> Vec<[f64; 3]> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(reply["positions"].as_str().expect("positions"))
        .expect("base64");
    bytes
        .chunks_exact(12)
        .map(|corner| {
            let word =
                |i: usize| f64::from(f32::from_le_bytes(corner[i..i + 4].try_into().unwrap()));
            [word(0), word(4), word(8)]
        })
        .collect()
}

/// The box around the reply's mesh, min then max.
fn bounds(reply: &Value) -> [[f64; 3]; 2] {
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    for point in points(reply) {
        for axis in 0..3 {
            min[axis] = min[axis].min(point[axis]);
            max[axis] = max[axis].max(point[axis]);
        }
    }
    [min, max]
}

fn near_box(got: [[f64; 3]; 2], want: [[f64; 3]; 2]) {
    for (side, (a, b)) in got.iter().zip(want.iter()).enumerate() {
        for axis in 0..3 {
            assert!(
                (a[axis] - b[axis]).abs() < 0.02,
                "box {got:?} is not near {want:?} (side {side}, axis {axis})"
            );
        }
    }
}

/// The request that opens tree `key` from `primitive`.
fn open(key: &str, primitive: Value) -> Value {
    json!({ "call": "open", "key": key, "primitive": primitive, "chordMm": 0.01 })
}

fn cone(radius: f64, top: f64, height: f64, origin: [f64; 3]) -> Value {
    json!({ "primitive": "cone", "origin": origin, "radius": radius, "topRadius": top, "height": height })
}

fn torus(ring: f64, tube: f64, origin: [f64; 3]) -> Value {
    json!({ "primitive": "torus", "origin": origin, "radius": ring, "tubeRadius": tube })
}

fn wedge(size: [f64; 3], top_x: f64, origin: [f64; 3]) -> Value {
    json!({ "primitive": "wedge", "origin": origin, "size": size, "topX": top_x })
}

fn polygon(sides: f64, across: f64, flats: bool, height: f64, origin: [f64; 3]) -> Value {
    json!({ "primitive": "polygon", "origin": origin, "sides": sides, "across": across, "flats": flats, "height": height })
}

fn tube(outer: f64, inner: f64, height: f64, origin: [f64; 3]) -> Value {
    json!({ "primitive": "tube", "origin": origin, "radius": outer, "innerRadius": inner, "height": height })
}

#[test]
fn each_new_primitive_builds_to_its_formula() {
    if !kernel() {
        return;
    }
    // Cone: π h / 3 (R² + R r + r²), a side and two caps; a point has no top cap.
    let built = ok(open("cone", cone(5.0, 2.0, 10.0, [0.0, 0.0, 0.0])));
    near(volume(&built), 408.407_045);
    assert_eq!(faces(&built), 3);
    assert_eq!(built["solid"], true);
    near_box(bounds(&built), [[-5.0, -5.0, 0.0], [5.0, 5.0, 10.0]]);
    let point = ok(open("point", cone(5.0, 0.0, 10.0, [0.0, 0.0, 0.0])));
    near(volume(&point), 261.799_388);
    assert_eq!(faces(&point), 2);
    let flipped = ok(open("flipped", cone(0.0, 5.0, 10.0, [0.0, 0.0, 0.0])));
    near(volume(&flipped), 261.799_388);
    // Equal radii are a cylinder.
    let straight = ok(open("straight", cone(5.0, 5.0, 10.0, [0.0, 0.0, 0.0])));
    near(volume(&straight), 785.398_163);
    assert_eq!(faces(&straight), 3);

    // Torus: 2 π² R r², one face, centred on its origin.
    let ring = ok(open("torus", torus(10.0, 2.0, [0.0, 0.0, 2.0])));
    near(volume(&ring), 789.568_352);
    assert_eq!(faces(&ring), 1);
    near_box(bounds(&ring), [[-12.0, -12.0, 0.0], [12.0, 12.0, 4.0]]);

    // Wedge: a trapezoid of X 20 under, 5 on top, 8 high, 10 deep: 1000 mm³, six faces.
    let ramp = ok(open(
        "wedge",
        wedge([20.0, 10.0, 8.0], 5.0, [0.0, 0.0, 0.0]),
    ));
    near(volume(&ramp), 1000.0);
    assert_eq!(faces(&ramp), 6);
    near_box(bounds(&ramp), [[0.0, 0.0, 0.0], [20.0, 10.0, 8.0]]);
    // The top face is the short one, from X 0 to 5.
    let top_x = points(&ramp)
        .iter()
        .filter(|point| (point[2] - 8.0).abs() < 1e-4)
        .map(|point| point[0])
        .fold(f64::NEG_INFINITY, f64::max);
    near(top_x, 5.0);
    let sharp = ok(open("ramp", wedge([20.0, 10.0, 8.0], 0.0, [0.0, 0.0, 0.0])));
    near(volume(&sharp), 800.0);
    assert_eq!(faces(&sharp), 5);
    let square = ok(open(
        "square",
        wedge([20.0, 10.0, 8.0], 20.0, [0.0, 0.0, 0.0]),
    ));
    near(volume(&square), 1600.0);

    // A hexagon 10 across flats (a nut pocket), 5 high: the flats face ±Y.
    let nut = ok(open("hex", polygon(6.0, 10.0, true, 5.0, [0.0, 0.0, 0.0])));
    near(volume(&nut), 433.012_702);
    assert_eq!(faces(&nut), 8);
    near_box(
        bounds(&nut),
        [[-5.773_503, -5.0, 0.0], [5.773_503, 5.0, 5.0]],
    );
    let corners = ok(open(
        "hex-corners",
        polygon(6.0, 10.0, false, 5.0, [0.0, 0.0, 0.0]),
    ));
    near(volume(&corners), 324.759_526);
    near_box(
        bounds(&corners),
        [[-5.0, -4.330_127, 0.0], [5.0, 4.330_127, 5.0]],
    );
    let triangle = ok(open(
        "triangle",
        polygon(3.0, 10.0, false, 2.0, [0.0, 0.0, 0.0]),
    ));
    near(volume(&triangle), 64.951_905);
    assert_eq!(faces(&triangle), 5);
    let many = ok(open(
        "sixty-four",
        polygon(64.0, 10.0, false, 1.0, [0.0, 0.0, 0.0]),
    ));
    assert_eq!(faces(&many), 66);

    // Tube: π (R² − r²) h, four faces.
    let pipe = ok(open("tube", tube(10.0, 6.0, 5.0, [0.0, 0.0, 0.0])));
    near(volume(&pipe), 1_005.309_649);
    assert_eq!(faces(&pipe), 4);
    near_box(bounds(&pipe), [[-10.0, -10.0, 0.0], [10.0, 10.0, 5.0]]);
    let rod = ok(open("rod", tube(5.0, 0.0, 10.0, [0.0, 0.0, 0.0])));
    near(volume(&rod), 785.398_163);
    assert_eq!(faces(&rod), 3);

    // The older three still build as roots.
    let block = ok(open(
        "block",
        json!({ "primitive": "box", "origin": [-10.0, -10.0, 0.0], "size": [20.0, 20.0, 20.0] }),
    ));
    near(volume(&block), 8000.0);
    near_box(bounds(&block), [[-10.0, -10.0, 0.0], [10.0, 10.0, 20.0]]);
    let ball = ok(open(
        "ball",
        json!({ "primitive": "sphere", "origin": [0.0, 0.0, 5.0], "radius": 5.0 }),
    ));
    near(volume(&ball), 523.598_776);
}

#[test]
fn a_primitive_root_turns_about_its_centre() {
    if !kernel() {
        return;
    }
    // A cone turned upside down keeps its box; a torus stood on edge keeps its centre.
    let upside = ok(open(
        "upside",
        json!({ "primitive": "cone", "origin": [0.0, 0.0, 0.0], "radius": 5.0, "topRadius": 0.0, "height": 10.0, "turn": [180.0, 0.0, 0.0] }),
    ));
    near(volume(&upside), 261.799_388);
    near_box(bounds(&upside), [[-5.0, -5.0, 0.0], [5.0, 5.0, 10.0]]);
    // Its wide end is on top now, and its point on Z 0.
    let reach_at = |z: f64| {
        points(&upside)
            .iter()
            .filter(|point| (point[2] - z).abs() < 1e-4)
            .map(|point| point[0].hypot(point[1]))
            .fold(0.0, f64::max)
    };
    near(reach_at(10.0), 5.0);
    near(reach_at(0.0), 0.0);
    let standing = ok(open(
        "standing",
        json!({ "primitive": "torus", "origin": [0.0, 0.0, 12.0], "radius": 10.0, "tubeRadius": 2.0, "turn": [90.0, 0.0, 0.0] }),
    ));
    near_box(bounds(&standing), [[-12.0, -2.0, 0.0], [12.0, 2.0, 24.0]]);
    let leaning = ok(open(
        "leaning",
        json!({ "primitive": "wedge", "origin": [0.0, 0.0, 0.0], "size": [20.0, 10.0, 8.0], "topX": 5.0, "turn": [0.0, 0.0, 90.0] }),
    ));
    near_box(bounds(&leaning), [[5.0, -5.0, 0.0], [15.0, 15.0, 8.0]]);
}

/// A 40 × 40 × 20 block, with `primitive` fused standing on its top face and cut wholly inside it.
fn fuse_and_cut(name: &str, on_top: Value, inside: Value, added: f64, removed: f64) {
    let key = format!("bool-{name}");
    ok(json!({ "call": "open", "key": key, "box": [40.0, 40.0, 20.0] }));
    let boolean = |node: u32, op: &str, tool: &Value| {
        ok(json!({ "call": "apply", "key": key, "parent": 0, "node": node, "op": as_op(tool, op) }))
    };
    let fused = boolean(1, "fuse", &on_top);
    near(volume(&fused), 32000.0 + added);
    assert_eq!(
        fused["op"]["primitive"], name,
        "the op is stored as sent: {}",
        fused["op"]
    );
    let cut = boolean(2, "cut", &inside);
    near(volume(&cut), 32000.0 - removed);
    let probe = ok(json!({ "call": "probe", "key": key, "node": 0, "op": as_op(&inside, "cut") }));
    assert_eq!(probe["ok"], true, "{probe}");
}

/// A boolean op with `tool` as its primitive.
fn as_op(tool: &Value, op: &str) -> Value {
    let mut out = tool.clone();
    out["kind"] = json!("boolean");
    out["op"] = json!(op);
    out
}

#[test]
fn every_new_primitive_fuses_and_cuts_a_box() {
    if !kernel() {
        return;
    }
    fuse_and_cut(
        "cone",
        cone(5.0, 2.0, 10.0, [20.0, 20.0, 20.0]),
        cone(5.0, 2.0, 10.0, [20.0, 20.0, 5.0]),
        408.407_045,
        408.407_045,
    );
    // Half the torus is below the top face: inside the block when fused, and all that is cut away.
    fuse_and_cut(
        "torus",
        torus(10.0, 2.0, [20.0, 20.0, 20.0]),
        torus(10.0, 2.0, [20.0, 20.0, 20.0]),
        394.784_176,
        394.784_176,
    );
    fuse_and_cut(
        "wedge",
        wedge([20.0, 10.0, 8.0], 5.0, [10.0, 15.0, 20.0]),
        wedge([20.0, 10.0, 8.0], 5.0, [10.0, 15.0, 6.0]),
        1000.0,
        1000.0,
    );
    fuse_and_cut(
        "polygon",
        polygon(6.0, 10.0, true, 5.0, [20.0, 20.0, 20.0]),
        polygon(6.0, 10.0, true, 5.0, [20.0, 20.0, 7.0]),
        433.012_702,
        433.012_702,
    );
    fuse_and_cut(
        "tube",
        tube(10.0, 6.0, 5.0, [20.0, 20.0, 20.0]),
        tube(10.0, 6.0, 5.0, [20.0, 20.0, 7.0]),
        1_005.309_649,
        1_005.309_649,
    );
    // A turned tool turns about its centre: a 30 mm spike that stands out of the 20 mm block above and
    // below lies wholly inside it once turned onto its side, so the cut takes the whole cone.
    let lying = json!({ "primitive": "cone", "origin": [20.0, 20.0, -5.0], "radius": 2.0, "topRadius": 0.0, "height": 30.0, "turn": [90.0, 0.0, 0.0] });
    fuse_and_cut(
        "cone",
        cone(5.0, 2.0, 10.0, [20.0, 20.0, 20.0]),
        lying,
        408.407_045,
        125.663_706,
    );
}

#[test]
fn the_older_primitives_store_as_they_did() {
    if !kernel() {
        return;
    }
    ok(json!({ "call": "open", "key": "old-ops", "box": [10.0, 10.0, 10.0] }));
    let ops = [
        json!({ "kind": "boolean", "op": "cut", "primitive": "box", "origin": [1.0, 1.0, 5.0], "size": [3.0, 3.0, 9.0], "radius": 0.0, "height": 0.0, "turn": [0.0, 0.0, 15.0] }),
        json!({ "kind": "boolean", "op": "cut", "primitive": "cylinder", "origin": [5.0, 5.0, 5.0], "size": [0.0, 0.0, 0.0], "radius": 1.0, "height": 9.0, "turn": [0.0, 0.0, 0.0] }),
        json!({ "kind": "boolean", "op": "cut", "primitive": "sphere", "origin": [5.0, 5.0, 10.0], "size": [0.0, 0.0, 0.0], "radius": 2.0, "height": 0.0, "turn": [0.0, 0.0, 0.0] }),
    ];
    for (i, op) in ops.iter().enumerate() {
        let applied =
            ok(json!({ "call": "apply", "key": "old-ops", "parent": 0, "node": i + 1, "op": op }));
        assert_eq!(
            applied["op"], *op,
            "a {} op comes back exactly as it went",
            op["primitive"]
        );
    }
}

#[test]
fn a_size_too_small_to_build_is_no_size() {
    if !kernel() {
        return;
    }
    // A hole a nanometre wide is a solid tube, a cone top as small is a point, and a wedge top a ramp.
    let rod = ok(open("tiny-hole", tube(5.0, 1e-9, 10.0, [0.0, 0.0, 0.0])));
    near(volume(&rod), 785.398_163);
    assert_eq!(faces(&rod), 3);
    let point = ok(open("tiny-top", cone(5.0, 1e-9, 10.0, [0.0, 0.0, 0.0])));
    assert_eq!(faces(&point), 2);
    let ramp = ok(open(
        "tiny-ramp",
        wedge([20.0, 10.0, 8.0], 1e-9, [0.0, 0.0, 0.0]),
    ));
    assert_eq!(faces(&ramp), 5);
    // A size that must be there and is as small is refused.
    let flat = call(open(
        "tiny-box",
        json!({ "primitive": "box", "origin": [0.0, 0.0, 0.0], "size": [10.0, 1e-9, 10.0] }),
    ));
    assert_eq!(flat["error"], "A box needs a positive length on each side");
}

#[test]
fn a_primitive_root_replays_to_its_fingerprint() {
    if !kernel() {
        return;
    }
    let root = cone(8.0, 3.0, 12.0, [0.0, 0.0, 0.0]);
    let opened = ok(open("replay", root.clone()));
    let print = opened["fingerprint"].clone();
    let hole = json!({ "kind": "hole", "origin": [0.0, 0.0, 12.0], "radius": 1.5, "depth": 6.0 });
    let drilled =
        ok(json!({ "call": "apply", "key": "replay", "parent": 0, "node": 1, "op": hole }));
    // Opened again from the saved root and op, as after an engine restart: the step rebuilds the same.
    let nodes = json!([{ "id": 1, "parent": 0, "op": drilled["op"], "fingerprint": drilled["fingerprint"] }]);
    let again = ok(
        json!({ "call": "open", "key": "replay", "primitive": root, "fingerprint": print, "nodes": nodes, "current": 1 }),
    );
    assert_eq!(again["fingerprint"], drilled["fingerprint"]);
    assert_eq!(again["replayed"], 1);
    assert_eq!(again["id"], 1);
    // A root that builds to another shape than the one saved is broken, and the tree is not opened.
    let mut wrong = print.clone();
    wrong["volumeMm3"] = json!(print["volumeMm3"].as_f64().expect("volume") + 1.0);
    let broken = call(
        json!({ "call": "open", "key": "replay-wrong", "primitive": cone(8.0, 3.0, 12.0, [0.0, 0.0, 0.0]), "fingerprint": wrong }),
    );
    assert_eq!(broken["broken"], 0, "{broken}");
    assert!(
        broken["error"]
            .as_str()
            .expect("error")
            .starts_with("This step rebuilt differently"),
        "{broken}"
    );
    let gone = call(json!({ "call": "goto", "key": "replay-wrong", "node": 0 }));
    assert_eq!(gone["error"], "unknown", "{gone}");
    // A STEP export of the primitive root works like any other step.
    let step = ok(json!({ "call": "export", "key": "replay", "node": 0 }));
    assert!(step["byteLength"].as_u64().expect("byteLength") > 1000);
    // One root only.
    let both =
        call(json!({ "call": "open", "key": "both", "box": [1.0, 1.0, 1.0], "primitive": root }));
    assert_eq!(
        both["error"],
        "Open a tree from exactly one of dataB64, stepPath, box, or primitive"
    );
}

#[test]
fn every_size_out_of_range_is_refused_in_plain_words() {
    if !kernel() {
        return;
    }
    let refusals = [
        (
            json!({ "primitive": "box", "origin": [0.0, 0.0, 0.0], "size": [10.0, 0.0, 10.0] }),
            "A box needs a positive length on each side",
        ),
        (
            json!({ "primitive": "cylinder", "origin": [0.0, 0.0, 0.0], "radius": 5.0 }),
            "A cylinder needs a positive radius and height",
        ),
        (
            json!({ "primitive": "sphere", "origin": [0.0, 0.0, 0.0], "radius": -1.0 }),
            "A sphere needs a positive radius",
        ),
        (
            cone(5.0, 2.0, 0.0, [0.0; 3]),
            "A cone needs a height above 0",
        ),
        (
            cone(-1.0, 2.0, 10.0, [0.0; 3]),
            "A cone's radii cannot be below 0",
        ),
        (
            cone(5.0, -2.0, 10.0, [0.0; 3]),
            "A cone's radii cannot be below 0",
        ),
        (
            cone(0.0, 0.0, 10.0, [0.0; 3]),
            "A cone needs a bottom or top radius above 0",
        ),
        (
            torus(0.0, 2.0, [0.0; 3]),
            "A torus needs a ring radius above 0",
        ),
        (
            torus(10.0, 0.0, [0.0; 3]),
            "A torus needs a tube radius above 0",
        ),
        (
            torus(10.0, 10.0, [0.0; 3]),
            "The torus's tube radius must be smaller than its ring radius",
        ),
        (
            wedge([20.0, 10.0, 0.0], 5.0, [0.0; 3]),
            "A wedge needs a positive length on each side",
        ),
        (
            wedge([20.0, 10.0, 8.0], 25.0, [0.0; 3]),
            "The wedge's top length must be from 0 to its X length",
        ),
        (
            wedge([20.0, 10.0, 8.0], -1.0, [0.0; 3]),
            "The wedge's top length must be from 0 to its X length",
        ),
        (
            polygon(2.0, 10.0, false, 5.0, [0.0; 3]),
            "A polygon needs 3 to 64 sides",
        ),
        (
            polygon(65.0, 10.0, false, 5.0, [0.0; 3]),
            "A polygon needs 3 to 64 sides",
        ),
        (
            polygon(6.5, 10.0, false, 5.0, [0.0; 3]),
            "A polygon needs 3 to 64 sides",
        ),
        (
            polygon(6.0, 0.0, true, 5.0, [0.0; 3]),
            "A polygon needs a width across above 0",
        ),
        (
            polygon(6.0, 10.0, true, 0.0, [0.0; 3]),
            "A polygon needs a height above 0",
        ),
        (
            tube(10.0, 6.0, 0.0, [0.0; 3]),
            "A tube needs a height above 0",
        ),
        (
            tube(0.0, 0.0, 5.0, [0.0; 3]),
            "A tube needs an outer radius above 0",
        ),
        (
            tube(10.0, -1.0, 5.0, [0.0; 3]),
            "The tube's inner radius cannot be below 0",
        ),
        (
            tube(10.0, 10.0, 5.0, [0.0; 3]),
            "The tube's inner radius must be smaller than its outer radius",
        ),
    ];
    ok(json!({ "call": "open", "key": "refuse", "box": [10.0, 10.0, 10.0] }));
    for (i, (primitive, message)) in refusals.iter().enumerate() {
        let opened = call(open(&format!("refused-{i}"), primitive.clone()));
        assert_eq!(opened["error"], *message, "a new solid from {primitive}");
        // The same numbers as a boolean's tool: the dry run says why, and Apply refuses.
        let op = as_op(primitive, "cut");
        let probe = call(json!({ "call": "probe", "key": "refuse", "node": 0, "op": op }));
        assert_eq!(
            probe,
            json!({ "ok": false, "error": message }),
            "a cut with {primitive}"
        );
        let applied = call(
            json!({ "call": "apply", "key": "refuse", "parent": 0, "node": 100 + i, "op": op }),
        );
        assert_eq!(applied["error"], *message, "{applied}");
    }
    let unknown = call(
        json!({ "call": "open", "key": "unknown", "primitive": { "primitive": "helix", "origin": [0.0, 0.0, 0.0] } }),
    );
    assert!(
        unknown["error"]
            .as_str()
            .expect("error")
            .contains("unknown variant `helix`"),
        "{unknown}"
    );
}

/// A curved solid has few vertices, and a cut through its middle can leave every vertex of one half
/// in the cut plane: a torus cut along X was refused as "too close to a face". Each half must still
/// split, and each must hold half the volume.
#[test]
fn curved_primitives_split_through_their_middle() {
    if !kernel() {
        return;
    }
    let pi = std::f64::consts::PI;
    let cases = [
        ("torus", torus(12.8, 4.2, [0.0, 0.0, 0.0]), 2.0 * pi * pi * 12.8 * 4.2 * 4.2),
        (
            "sphere",
            json!({ "primitive": "sphere", "origin": [0.0, 0.0, 0.0], "radius": 10.0 }),
            4.0 / 3.0 * pi * 1000.0,
        ),
        (
            "cylinder",
            json!({ "primitive": "cylinder", "origin": [0.0, 0.0, -10.0], "radius": 10.0, "height": 20.0 }),
            pi * 100.0 * 20.0,
        ),
        ("cone", cone(10.0, 4.0, 20.0, [0.0, 0.0, -10.0]), pi * 20.0 / 3.0 * (100.0 + 40.0 + 16.0)),
        ("tube", tube(10.0, 6.0, 20.0, [0.0, 0.0, -10.0]), pi * (100.0 - 36.0) * 20.0),
    ];
    let tilt = std::f64::consts::FRAC_1_SQRT_2;
    let normals = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [tilt, 0.0, tilt]];
    for (name, primitive, whole) in cases {
        for (n, normal) in normals.iter().enumerate() {
            // A cone is symmetric only about planes through its axis; the others about their centre.
            if name == "cone" && n >= 2 {
                continue;
            }
            let key = format!("split-{name}-{n}");
            near(volume(&ok(open(&key, primitive.clone()))), whole);
            let reply = ok(json!({ "call": "apply", "key": key, "parent": 0, "node": 1,
                "op": { "kind": "split", "origin": [0.0, 0.0, 0.0], "normal": normal },
                "otherKey": format!("{key}-piece") }));
            let kept = volume(&reply);
            let other = volume(&reply["other"]);
            assert!(
                (kept - whole / 2.0).abs() < 1e-3 * whole && (other - whole / 2.0).abs() < 1e-3 * whole,
                "{name} along {normal:?}: {kept} + {other} is not two halves of {whole}"
            );
            ok(json!({ "call": "close", "key": format!("{key}-piece") }));
            ok(json!({ "call": "close", "key": key }));
        }
    }
}
