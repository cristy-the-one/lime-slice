//! Timings of the text build on parts of several kinds (release build, `--ignored --nocapture`), and the checks that the faster
//! paths decide the same as the exact ones. `LIME_REQUIRE_OCCT=1` makes a missing kernel a failure.

use serde_json::{json, Value};

const DEPTH: f64 = 0.8;
static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
const SPIKE: &str = "Lime Slice gAO8 2026";

fn require() -> bool {
    std::env::var_os("LIME_REQUIRE_OCCT").is_some()
}

fn call(request: Value) -> Value {
    let text = lime_model_occt::tree(&request.to_string());
    serde_json::from_str(&text).unwrap_or_else(|err| panic!("not JSON ({err}): {text}"))
}

fn open_reply(key: &str, primitive: Value) -> Option<Value> {
    let opened =
        call(json!({ "call": "open", "key": key, "primitive": primitive, "chordMm": 0.1 }));
    if opened.get("error").is_some() {
        assert!(!require(), "OCCT was required: {opened}");
        return None;
    }
    Some(opened)
}

fn open(key: &str, primitive: Value) -> bool {
    open_reply(key, primitive).is_some()
}

fn lettering(op: &str, text: &str, at: [f64; 3], height: f64, depth: f64) -> Value {
    json!({
        "kind": "lettering", "op": op, "origin": at, "turn": [0.0, 0.0, 0.0],
        "text": text, "font": "sans", "height": height, "depth": depth,
    })
}

fn probe(key: &str, node: u64, op: &Value) -> Value {
    call(json!({ "call": "probe", "key": key, "node": node, "op": op }))
}

/// A plate with a field of small ellipsoid bumps on it and one big ellipsoid bump: a stand-in for a part of many freeform faces.
/// Returns the node of the finished part and the top of the big bump.
fn big_part(key: &str, columns: usize, rows: usize) -> Option<(u64, [f64; 3])> {
    let width = 20.0 * columns as f64 + 120.0;
    let depth = 20.0 * rows as f64 + 20.0;
    if !open(
        key,
        json!({ "primitive": "box", "origin": [0.0, 0.0, 0.0], "size": [width, depth, 6.0] }),
    ) {
        return None;
    }
    let mut parent = 0u64;
    let mut node = 0u64;
    let started = std::time::Instant::now();
    for i in 0..columns * rows {
        let x = 130.0 + 20.0 * (i % columns) as f64;
        let y = 10.0 + 20.0 * (i / columns) as f64;
        node += 1;
        let reply = call(json!({
            "call": "apply", "key": key, "parent": parent, "node": node,
            "op": { "kind": "boolean", "op": "fuse", "primitive": "ellipsoid", "origin": [x, y, 3.0], "size": [14.0, 11.0, 12.0] },
        }));
        assert!(reply.get("error").is_none(), "bump {i}: {reply}");
        parent = node;
    }
    node += 1;
    let (cx, cy) = (60.0, depth / 2.0);
    let reply = call(json!({
        "call": "apply", "key": key, "parent": parent, "node": node,
        "op": { "kind": "boolean", "op": "fuse", "primitive": "ellipsoid", "origin": [cx, cy, 28.0], "size": [100.0, 70.0, 50.0] },
    }));
    assert!(reply.get("error").is_none(), "the big bump: {reply}");
    println!(
        "big part faces: {}",
        reply["faces"].as_array().map_or(0, |f| f.len())
    );
    println!("big part built in {:.1} s", started.elapsed().as_secs_f64());
    Some((node, [cx - 50.0, cy, 28.0]))
}

fn time_text(label: &str, key: &str, parent: u64, op: &Value) {
    let started = std::time::Instant::now();
    let probed = probe(key, parent, op);
    let probe_s = started.elapsed().as_secs_f64();
    assert_eq!(probed["ok"], json!(true), "{label}: {probed}");
    let started = std::time::Instant::now();
    let reply = call(
        json!({ "call": "apply", "key": key, "parent": parent, "node": 9000 + NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed), "op": op }),
    );
    let apply_s = started.elapsed().as_secs_f64();
    assert!(reply.get("error").is_none(), "{label}: {reply}");
    println!(
        "TIMING {label}: probe {probe_s:.3} s, apply {apply_s:.3} s, build {} ({})",
        reply["text"]["build"], reply["text"]["booleanBecause"]
    );
}

/// A text step applied as the step after `parent`; the reply, with its error if it has one.
fn apply(key: &str, parent: u64, op: &Value) -> Value {
    call(json!({
        "call": "apply", "key": key, "parent": parent,
        "node": 5000 + NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed), "op": op,
    }))
}

#[test]
fn a_point_off_the_part_is_refused_with_how_far_off_it_is() {
    // A sphere of radius 30 centred at (0, 0, 30); (30, 0, 0) is 12.4 mm off it, and not on any face.
    if !open(
        "off-ball",
        json!({ "primitive": "sphere", "origin": [0.0, 0.0, 30.0], "radius": 30.0 }),
    ) {
        return;
    }
    for op in ["fuse", "cut"] {
        for text in ["LIME", "I"] {
            let reply = probe(
                "off-ball",
                0,
                &lettering(op, text, [30.0, 0.0, 0.0], 6.0, DEPTH),
            );
            assert_eq!(reply["ok"], json!(false), "{op} {text}: {reply}");
            assert_eq!(
                reply["error"],
                json!("The point is 12.4 mm off the part, not on the face you picked. Pick a point on the face."),
                "{op} {text}: {reply}"
            );
        }
    }
    // On the surface it builds, both ways.
    for op in ["fuse", "cut"] {
        let reply = probe(
            "off-ball",
            0,
            &lettering(op, "LIME", [-30.0, 0.0, 30.0], 6.0, DEPTH),
        );
        assert_eq!(reply["ok"], json!(true), "{op}: {reply}");
    }
    // A flat top and a cylinder get the same sentence.
    assert!(open(
        "off-plate",
        json!({ "primitive": "box", "origin": [0.0, 0.0, 0.0], "size": [40.0, 30.0, 10.0] })
    ));
    let flat = probe(
        "off-plate",
        0,
        &lettering("fuse", "LIME", [20.0, 15.0, 15.0], 6.0, DEPTH),
    );
    assert_eq!(
        flat["error"],
        json!("The point is 5.0 mm off the part, not on the face you picked. Pick a point on the face."),
        "{flat}"
    );
    assert!(open(
        "off-pipe",
        json!({ "primitive": "cylinder", "origin": [0.0, 0.0, 0.0], "radius": 20.0, "height": 60.0 })
    ));
    let round = probe(
        "off-pipe",
        0,
        &lettering("cut", "LIME", [-32.0, 0.0, 30.0], 6.0, DEPTH),
    );
    assert_eq!(
        round["error"],
        json!("The point is 12.0 mm off the part, not on the face you picked. Pick a point on the face."),
        "{round}"
    );
}

/// The ink of "I" at 6 mm: its box in the layout, [min u, min v, max u, max v].
fn stem_bounds() -> [f64; 4] {
    let reply = call(json!({ "call": "textLayout", "text": "I", "font": "sans", "height": 6.0 }));
    assert_eq!(reply["ok"], json!(true), "{reply}");
    let b = reply["bounds"].as_array().expect("bounds");
    [
        b[0].as_f64().unwrap(),
        b[1].as_f64().unwrap(),
        b[2].as_f64().unwrap(),
        b[3].as_f64().unwrap(),
    ]
}

#[test]
fn text_near_the_edge_of_a_flat_face_goes_to_the_boolean_exactly_inside_0_02_mm() {
    if !open(
        "edge-plate",
        json!({ "primitive": "box", "origin": [0.0, 0.0, 0.0], "size": [40.0, 30.0, 10.0] }),
    ) {
        return;
    }
    let bounds = stem_bounds();
    // The stem's right side `gap` mm from the face's right edge (x = 40).
    let at = |gap: f64| {
        [
            40.0 - gap - bounds[2],
            15.0 - (bounds[1] + bounds[3]) / 2.0,
            10.0,
        ]
    };
    for (gap, direct) in [
        (0.5, true),
        (0.15, true),
        (0.05, true),
        (0.03, true),
        (0.015, false),
        (0.005, false),
    ] {
        let reply = apply(
            "edge-plate",
            0,
            &lettering("fuse", "I", at(gap), 6.0, DEPTH),
        );
        assert!(reply.get("error").is_none(), "gap {gap}: {reply}");
        assert_eq!(
            reply["text"]["build"],
            json!(if direct { "direct" } else { "boolean" }),
            "gap {gap}: {reply}"
        );
        if !direct {
            assert_eq!(
                reply["text"]["booleanBecause"],
                json!("The text is within 0.02 mm of the face's edge."),
                "gap {gap}"
            );
        }
    }
}

#[cfg(lime_occt_test_hooks)]
fn checks(key: &str, node: u64, point: [f64; 3]) -> Value {
    let reply = call(json!({ "call": "testText", "key": key, "node": node, "point": point }));
    assert!(reply.get("error").is_none(), "{reply}");
    reply
}

#[cfg(lime_occt_test_hooks)]
fn kinds() -> Vec<(&'static str, Value, [f64; 3])> {
    vec![
        (
            "cylinder",
            json!({ "primitive": "cylinder", "origin": [0.0, 0.0, 0.0], "radius": 20.0, "height": 60.0 }),
            [-20.0, 0.0, 30.0],
        ),
        (
            "sphere",
            json!({ "primitive": "sphere", "origin": [0.0, 0.0, 30.0], "radius": 30.0 }),
            [-30.0, 0.0, 30.0],
        ),
        (
            "ellipsoid",
            json!({ "primitive": "ellipsoid", "origin": [0.0, 0.0, 0.0], "size": [80.0, 60.0, 50.0] }),
            [-40.0, 0.0, 0.0],
        ),
        (
            "torus",
            json!({ "primitive": "torus", "origin": [0.0, 0.0, 0.0], "radius": 30.0, "tubeRadius": 10.0 }),
            [-30.0, 0.0, 10.0],
        ),
    ]
}

/// The cheap checks beside the exact ones, on a part's face nearest a point: the (u, v) classifier gives the verdicts the 3D one does, the
/// sampled edge gap decides as the exact distance does, and an invalid result is caught.
#[cfg(lime_occt_test_hooks)]
#[test]
fn the_cheap_checks_decide_like_the_exact_ones_and_still_catch_an_invalid_result() {
    for (name, primitive, at) in kinds() {
        let key = format!("checks-{name}");
        if !open(&key, primitive) {
            return;
        }
        let reply = checks(&key, 0, at);
        let classify = &reply["classify"];
        assert!(classify["inside"].as_i64().unwrap() > 20, "{name}: {reply}");
        assert_eq!(classify["mismatches"], json!(0), "{name}: {reply}");
        let rows = reply["edges"].as_array().expect("edges");
        assert!(!rows.is_empty(), "{name}: {reply}");
        for row in rows {
            assert_eq!(row["fast"], row["exact"], "{name}: {row}");
            let gap = row["gap"].as_f64().unwrap();
            if gap <= 0.015 {
                assert_eq!(row["fast"], json!(true), "{name}: {row}");
            }
            if gap >= 0.05 {
                assert_eq!(row["fast"], json!(false), "{name}: {row}");
            }
        }
        let valid = &reply["valid"];
        assert_eq!(valid["whole"], json!(true), "{name}: {reply}");
        assert_eq!(valid["intact"], json!(true), "{name}: {reply}");
        // A part of one face (a ball, a torus) has no neighbour to turn against, and without it no shell.
        if valid["faces"].as_i64().unwrap() > 2 {
            assert_eq!(
                valid["turned"],
                json!(false),
                "{name}: a face turned over must be caught: {reply}"
            );
            assert_eq!(
                valid["open"],
                json!(false),
                "{name}: a missing face must be caught: {reply}"
            );
        }
        assert_eq!(
            valid["crossed"],
            json!(false),
            "{name}: a face whose outline crosses itself must be caught: {reply}"
        );
    }
}

/// The volume a direct build reports (the old one, less the face that went and plus the faces that came) is the whole result's volume where
/// the surfaces integrate exactly, and the letters' own volume everywhere: a freeform part's whole-shape integral is itself good to only
/// about a part in a thousand, which is more than the letters weigh.
#[cfg(lime_occt_test_hooks)]
#[test]
fn the_incremental_volume_is_the_letters_volume_and_the_whole_volume() {
    let mut parts = kinds();
    parts.push((
        "box",
        json!({ "primitive": "box", "origin": [0.0, 0.0, 0.0], "size": [40.0, 30.0, 10.0] }),
        [20.0, 15.0, 10.0],
    ));
    for (name, primitive, at) in parts {
        let key = format!("volume-{name}");
        let Some(opened) = open_reply(&key, primitive) else {
            return;
        };
        let before = opened["volumeMm3"].as_f64().unwrap();
        for which in ["fuse", "cut"] {
            let op = lettering(which, "Lime 42", at, 5.0, DEPTH);
            let reply = apply(&key, 0, &op);
            assert!(reply.get("error").is_none(), "{name} {which}: {reply}");
            assert_eq!(
                reply["text"]["build"],
                json!("direct"),
                "{name} {which}: {reply}"
            );
            let kept = reply["volumeMm3"].as_f64().unwrap();
            let letters = reply["text"]["inkMm2"].as_f64().unwrap() * DEPTH;
            let expected = if which == "fuse" { letters } else { -letters };
            assert!(
                ((kept - before) - expected).abs() <= 0.08 * letters,
                "{name} {which}: the part went from {before} to {kept}, the letters are {expected}"
            );
            if name != "ellipsoid" {
                let node = reply["id"].as_u64().expect("id");
                let whole = checks(&key, node, at)["fullVolumeMm3"].as_f64().unwrap();
                assert!(
                    (whole - kept).abs() <= 1e-7 * whole.abs(),
                    "{name} {which}: kept {kept}, whole {whole}"
                );
            }
        }
    }
}

#[test]
#[ignore = "a timing run: cargo test --release -p lime-model-occt --test text_speed -- --ignored --nocapture"]
fn timings_on_synthetic_parts() {
    let only = std::env::var("LIME_TEXT_ONLY").ok();
    let wanted = |name: &str| only.as_deref().is_none_or(|w| name.contains(w));
    let parts: Vec<(&str, Value, [f64; 3], f64)> = vec![
        (
            "ellipsoid",
            json!({ "primitive": "ellipsoid", "origin": [0.0, 0.0, 0.0], "size": [80.0, 60.0, 50.0] }),
            [-40.0, 0.0, 0.0],
            5.0,
        ),
        (
            "cylinder",
            json!({ "primitive": "cylinder", "origin": [0.0, 0.0, 0.0], "radius": 20.0, "height": 60.0 }),
            [-20.0, 0.0, 30.0],
            6.0,
        ),
        (
            "sphere",
            json!({ "primitive": "sphere", "origin": [0.0, 0.0, 30.0], "radius": 30.0 }),
            [-30.0, 0.0, 30.0],
            6.0,
        ),
    ];
    for (name, primitive, at, height) in parts {
        if !wanted(name) {
            continue;
        }
        let key = format!("speed-{name}");
        if !open(&key, primitive) {
            return;
        }
        for which in ["fuse", "cut"] {
            time_text(
                &format!("{name}-{which}"),
                &key,
                0,
                &lettering(which, SPIKE, at, height, DEPTH),
            );
        }
    }
    if wanted("big") {
        let columns: usize = std::env::var("LIME_BIG_COLUMNS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(10);
        let rows: usize = std::env::var("LIME_BIG_ROWS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(10);
        let Some((node, top)) = big_part("speed-big", columns, rows) else {
            return;
        };
        for which in ["fuse", "cut"] {
            time_text(
                &format!("big-{which}"),
                "speed-big",
                node,
                &lettering(which, SPIKE, top, 5.0, DEPTH),
            );
        }
    }
}
