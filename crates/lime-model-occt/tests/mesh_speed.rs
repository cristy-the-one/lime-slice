//! Model mesh timings for the Watson switch. Ignored in the normal suite.
//! The temporary Windows job runs it on this tree and on main. Removed with that job.

use serde_json::{json, Value};

fn call(request: Value) -> Value {
    let text = lime_model_occt::tree(&request.to_string());
    serde_json::from_str(&text).unwrap_or_else(|err| panic!("not JSON ({err}): {text}"))
}

fn ok(request: Value) -> Value {
    let reply = call(request);
    assert!(reply.get("error").is_none(), "{reply}");
    reply
}

fn stat(name: &str) -> u64 {
    let stats: Value = serde_json::from_str(&lime_model_occt::stats()).expect("stats");
    stats[name].as_u64().unwrap_or(0)
}

fn note(line: &str) {
    println!("{line}");
    if let Ok(path) = std::env::var("W1_BENCH_OUT") {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new().create(true).append(true).open(path).expect("bench out");
        writeln!(file, "{line}").expect("bench write");
    }
}

fn median(mut samples: Vec<u64>) -> u64 {
    samples.sort_unstable();
    samples[samples.len() / 2]
}

struct Timed {
    wall_us: u64,
    mesh_us: u64,
    boolean_us: u64,
    display_us: u64,
}

fn time_call(request: Value) -> Timed {
    let mesh = stat("meshUs");
    let boolean = stat("booleanUs");
    let display = stat("displayMeshUs");
    let started = std::time::Instant::now();
    ok(request);
    Timed {
        wall_us: started.elapsed().as_micros() as u64,
        mesh_us: stat("meshUs").saturating_sub(mesh),
        boolean_us: stat("booleanUs").saturating_sub(boolean),
        display_us: stat("displayMeshUs").saturating_sub(display),
    }
}

fn box_open(key: &str, display: bool) -> Value {
    let mut request = json!({
        "call": "open",
        "key": key,
        "primitive": { "primitive": "box", "origin": [0.0, 0.0, 0.0], "size": [60.0, 40.0, 20.0] },
        "chordMm": 0.05
    });
    if display {
        request["meshQuality"] = json!("display");
    }
    request
}

fn hole() -> Value {
    json!({
        "kind": "hole",
        "origin": [20.0, 15.0, 20.0],
        "axis": [0.0, 0.0, -1.0],
        "radius": 2.0,
        "depth": 5.0,
        "through": true
    })
}

fn plate_1000(key: &str) -> Value {
    let holes: Vec<Value> = (0..1000)
        .map(|i| {
            let x = 4.0 + 4.0 * f64::from(i % 40);
            let y = 4.0 + 4.0 * f64::from(i / 40);
            json!({
                "kind": "boolean", "op": "cut", "primitive": "cylinder",
                "origin": [x, y, -1.0], "radius": 1.0, "height": 12.0, "merge": true
            })
        })
        .collect();
    json!({
        "call": "apply",
        "key": key,
        "parent": 0,
        "node": 1,
        "chordMm": 0.05,
        "op": {
            "kind": "group",
            "label": "holes",
            "source": { "kind": "pattern", "combine": true },
            "steps": holes,
            "combine": "cut"
        }
    })
}

fn samples(n: usize, mut once: impl FnMut(usize) -> Timed) -> (Timed, usize) {
    let _ = once(0);
    let mut wall = Vec::with_capacity(n);
    let mut mesh = Vec::with_capacity(n);
    let mut boolean = Vec::with_capacity(n);
    let mut display = Vec::with_capacity(n);
    for i in 1..=n {
        let timed = once(i);
        wall.push(timed.wall_us);
        mesh.push(timed.mesh_us);
        boolean.push(timed.boolean_us);
        display.push(timed.display_us);
    }
    (
        Timed {
            wall_us: median(wall),
            mesh_us: median(mesh),
            boolean_us: median(boolean),
            display_us: median(display),
        },
        n,
    )
}

#[test]
#[ignore]
fn model_mesh_timings() {
    let stats: Value = serde_json::from_str(&lime_model_occt::stats()).expect("stats");
    assert!(stats.get("error").is_none(), "Open CASCADE is required: {stats}");
    let label = std::env::var("W1_BENCH_LABEL").unwrap_or_else(|_| "mesher".into());
    note(&format!("BENCH_VERSION {label} {}", stats["version"].as_str().unwrap_or("")));

    let (open, open_n) = samples(5, |i| {
        let key = format!("open{i}");
        let timed = time_call(box_open(&key, false));
        ok(json!({ "call": "close", "key": key }));
        timed
    });
    note(&format!(
        "BENCH {label} open n={open_n} median_wall_us={} median_mesh_us={}",
        open.wall_us, open.mesh_us
    ));

    let (edit, edit_n) = samples(5, |i| {
        let key = format!("edit{i}");
        ok(box_open(&key, false));
        let timed = time_call(json!({
            "call": "apply", "key": key, "parent": 0, "node": 1, "chordMm": 0.05, "op": hole()
        }));
        ok(json!({ "call": "close", "key": key }));
        timed
    });
    note(&format!(
        "BENCH {label} edit n={edit_n} median_wall_us={} median_mesh_us={} median_boolean_us={}",
        edit.wall_us, edit.mesh_us, edit.boolean_us
    ));

    let (display, display_n) = samples(5, |i| {
        let key = format!("disp{i}");
        let timed = time_call(box_open(&key, true));
        ok(json!({ "call": "close", "key": key }));
        timed
    });
    note(&format!(
        "BENCH {label} display n={display_n} median_wall_us={} median_display_mesh_us={} median_mesh_us={}",
        display.wall_us, display.display_us, display.mesh_us
    ));

    let (holes, holes_n) = samples(3, |i| {
        let key = format!("holes{i}");
        ok(json!({
            "call": "open",
            "key": key,
            "primitive": { "primitive": "box", "origin": [0.0, 0.0, 0.0], "size": [168.0, 108.0, 8.0] },
            "chordMm": 0.05
        }));
        let timed = time_call(plate_1000(&key));
        ok(json!({ "call": "close", "key": key }));
        timed
    });
    note(&format!(
        "BENCH {label} holes1000 n={holes_n} median_wall_us={} median_mesh_us={} median_boolean_us={}",
        holes.wall_us, holes.mesh_us, holes.boolean_us
    ));
}
