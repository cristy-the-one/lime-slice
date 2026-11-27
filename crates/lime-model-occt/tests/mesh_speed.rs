//! Model mesh timings, Watson against the exact mesh of flat faces with many holes (`mesh_faces` in cpp/kernel.cpp).
//! Ignored in the normal suite; run it on a release build:
//!
//! `cargo test --release -p lime-model-occt --test mesh_speed -- --ignored --nocapture --test-threads=1`
//!
//! Each row is timed with every flat face on Watson and with the kernel's own choice, alternating, and the medians are
//! printed in microseconds. `MESH_SPEED_ROUNDS` sets the rounds (3). `MESH_SPEED_SWEEP`, holes counts separated by
//! commas, adds plates with that many holes, meshed with Watson and with the exact mesh on every flat face: the sweep the
//! kernel's threshold was chosen from.

use serde_json::{json, Value};

fn ok(request: Value) -> Value {
    let text = lime_model_occt::tree(&request.to_string());
    let reply: Value = serde_json::from_str(&text).unwrap_or_else(|err| panic!("not JSON ({err}): {text}"));
    assert!(reply.get("error").is_none(), "{reply}");
    reply
}

fn stat(name: &str) -> u64 {
    let stats: Value = serde_json::from_str(&lime_model_occt::stats()).expect("stats");
    stats[name].as_u64().unwrap_or(0)
}

fn median(mut samples: Vec<u64>) -> u64 {
    samples.sort_unstable();
    samples[samples.len() / 2]
}

#[derive(Default)]
struct Timed {
    wall_us: u64,
    mesh_us: u64,
    display_us: u64,
    flat: u64,
}

fn time_call(request: Value) -> Timed {
    let (mesh, display, flat) = (stat("meshUs"), stat("displayMeshUs"), stat("flatFaces"));
    let started = std::time::Instant::now();
    ok(request);
    Timed {
        wall_us: started.elapsed().as_micros() as u64,
        mesh_us: stat("meshUs") - mesh,
        display_us: stat("displayMeshUs") - display,
        flat: stat("flatFaces") - flat,
    }
}

fn open_box(key: &str, display: bool) -> Value {
    let mut request = json!({
        "call": "open", "key": key, "chordMm": 0.05,
        "primitive": { "primitive": "box", "origin": [0.0, 0.0, 0.0], "size": [60.0, 40.0, 20.0] }
    });
    if display {
        request["meshQuality"] = json!("display");
    }
    request
}

/// A plate with `holes` through holes of 1 mm radius, 40 to a row 4 mm apart, cut as one group (the 1,000-hole plate
/// PR #878 measured).
fn plate(key: &str, holes: usize) -> Timed {
    let rows = holes.div_ceil(40).max(1);
    ok(json!({
        "call": "open", "key": key, "chordMm": 0.05,
        "primitive": { "primitive": "box", "origin": [0.0, 0.0, 0.0], "size": [168.0, 8.0 + 4.0 * rows as f64, 8.0] }
    }));
    let steps: Vec<Value> = (0..holes)
        .map(|i| {
            let (x, y) = (4.0 + 4.0 * (i % 40) as f64, 4.0 + 4.0 * (i / 40) as f64);
            json!({ "kind": "boolean", "op": "cut", "primitive": "cylinder", "origin": [x, y, -1.0], "radius": 1.0, "height": 12.0, "merge": true })
        })
        .collect();
    let timed = time_call(json!({
        "call": "apply", "key": key, "parent": 0, "node": 1, "chordMm": 0.05,
        "op": { "kind": "group", "label": "holes", "source": { "kind": "pattern", "combine": true }, "steps": steps, "combine": "cut" }
    }));
    ok(json!({ "call": "close", "key": key }));
    timed
}

/// One timed call, given the key to open its part under.
type Row = Box<dyn Fn(&str) -> Timed>;

fn rows() -> Vec<(String, Row)> {
    vec![
        ("open box".into(), Box::new(|key| {
            let timed = time_call(open_box(key, false));
            ok(json!({ "call": "close", "key": key }));
            timed
        })),
        ("hole in a box".into(), Box::new(|key| {
            ok(open_box(key, false));
            let timed = time_call(json!({
                "call": "apply", "key": key, "parent": 0, "node": 1, "chordMm": 0.05,
                "op": { "kind": "hole", "origin": [20.0, 15.0, 20.0], "axis": [0.0, 0.0, -1.0], "radius": 2.0, "depth": 5.0, "through": true }
            }));
            ok(json!({ "call": "close", "key": key }));
            timed
        })),
        ("display box".into(), Box::new(|key| {
            let timed = time_call(open_box(key, true));
            ok(json!({ "call": "close", "key": key }));
            timed
        })),
        ("150-hole plate".into(), Box::new(|key| plate(key, 150))),
        ("1000-hole plate".into(), Box::new(|key| plate(key, 1000))),
    ]
}

fn run(name: &str, rounds: usize, modes: &[(&str, Option<u32>)], once: &dyn Fn(&str) -> Timed) {
    let mut samples: Vec<Vec<Timed>> = modes.iter().map(|_| Vec::new()).collect();
    // One untimed run first, so neither mode pays for the first load.
    lime_model_occt::set_flat_mesher_holes(modes[0].1);
    let _ = once("warm");
    for round in 0..rounds {
        for (index, (label, holes)) in modes.iter().enumerate() {
            lime_model_occt::set_flat_mesher_holes(*holes);
            samples[index].push(once(&format!("{label}{round}")));
        }
    }
    for ((label, _), taken) in modes.iter().zip(samples) {
        let flat = taken.iter().map(|t| t.flat).max().unwrap_or(0);
        println!(
            "| {name} | {label} | {} | {} | {} | {} |",
            median(taken.iter().map(|t| t.wall_us).collect()),
            median(taken.iter().map(|t| t.mesh_us).collect()),
            median(taken.iter().map(|t| t.display_us).collect()),
            flat,
        );
    }
}

#[test]
#[ignore]
fn model_mesh_timings() {
    let stats: Value = serde_json::from_str(&lime_model_occt::stats()).expect("stats");
    assert!(stats.get("error").is_none(), "Open CASCADE is required: {stats}");
    let rounds: usize = std::env::var("MESH_SPEED_ROUNDS").ok().and_then(|text| text.parse().ok()).unwrap_or(3);
    println!("Open CASCADE {}, {rounds} rounds, medians in microseconds", stats["version"].as_str().unwrap_or(""));
    println!("| row | mesher | wall | mesh | display mesh | flat faces |");
    println!("|---|---|---:|---:|---:|---:|");
    let kernel = [("watson", None), ("kernel", Some(lime_model_occt::FLAT_MESHER_HOLES))];
    for (name, once) in rows() {
        run(&name, rounds, &kernel, once.as_ref());
    }
    if let Ok(sweep) = std::env::var("MESH_SPEED_SWEEP") {
        let every = [("watson", None), ("exact", Some(1))];
        for holes in sweep.split(',').filter_map(|text| text.trim().parse::<usize>().ok()) {
            run(&format!("{holes}-hole plate"), rounds, &every, &move |key| plate(key, holes));
        }
    }
    lime_model_occt::set_flat_mesher_holes(Some(lime_model_occt::FLAT_MESHER_HOLES));
}
