//! A 10×20×30 box has volume 6000 mm³, face areas 200/300/600, and the three
//! opposite-face distances. `LIME_REQUIRE_OCCT=1` makes a missing kernel a failure.

use std::path::{Path, PathBuf};

use serde_json::Value;

fn require() -> bool {
    std::env::var_os("LIME_REQUIRE_OCCT").is_some()
}

fn parse(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or_else(|err| panic!("not JSON ({err}): {text}"))
}

fn near(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() < 0.05,
        "{actual} is not near {expected}"
    );
}

#[test]
fn box_faces_edges_and_distance() {
    let json = parse(&lime_model_occt::open_box(10.0, 20.0, 30.0));
    if json.get("error").is_some() {
        if require() {
            panic!("OCCT was required: {json}");
        }
        bridge_exports(false);
        return;
    }
    near(json["volumeMm3"].as_f64().expect("volume"), 6000.0);
    assert!(json["version"].as_str().unwrap_or("").starts_with("7.9"));

    let faces = json["faces"].as_array().expect("faces");
    assert_eq!(faces.len(), 6);
    let mut areas: Vec<f64> = faces
        .iter()
        .map(|face| face["areaMm2"].as_f64().expect("area"))
        .collect();
    areas.sort_by(|a, b| a.partial_cmp(b).unwrap());
    for (actual, expected) in areas.iter().zip([200.0, 200.0, 300.0, 300.0, 600.0, 600.0]) {
        near(*actual, expected);
    }

    let edges = json["edges"].as_array().expect("edges");
    assert_eq!(edges.len(), 12);
    let mut lengths: Vec<f64> = edges
        .iter()
        .map(|edge| edge["lengthMm"].as_f64().expect("length"))
        .collect();
    lengths.sort_by(|a, b| a.partial_cmp(b).unwrap());
    for (actual, expected) in lengths.iter().zip([
        10.0, 10.0, 10.0, 10.0, 20.0, 20.0, 20.0, 20.0, 30.0, 30.0, 30.0, 30.0,
    ]) {
        near(*actual, expected);
    }

    let positions = json["positions"].as_array().expect("positions");
    let triangles = json["triangles"].as_array().expect("triangles");
    assert!(positions.len() >= 9 && positions.len() % 9 == 0);
    assert_eq!(triangles.len(), positions.len() / 9);

    let id = json["id"].as_i64().expect("id") as i32;
    let mut distances = Vec::new();
    for a in 0..6 {
        for b in (a + 1)..6 {
            let measured = parse(&lime_model_occt::distance(id, "face", a, "face", b));
            assert!(measured.get("error").is_none(), "{measured}");
            distances.push(measured["distanceMm"].as_f64().expect("distance"));
        }
    }
    for expected in [10.0, 20.0, 30.0] {
        assert!(
            distances.iter().any(|value| (*value - expected).abs() < 0.05),
            "missing {expected} in {distances:?}"
        );
    }

    let step_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../samples/step_cube.step");
    let step = parse(&lime_model_occt::open_step(&step_path, 0.1));
    if let Some(err) = step.get("error").and_then(|value| value.as_str()) {
        if require() || err != "STEP reader is not linked" {
            panic!("STEP cube was not measured ({err})");
        }
    } else {
        near(step["volumeMm3"].as_f64().expect("step volume"), 1000.0);
        assert!(step["faces"].as_array().expect("step faces").len() >= 6);
        assert_shared("TKDESTEP");
    }

    assert_shared("TKPrim");
    bridge_exports(true);
}

fn bridge_exports(measured: bool) {
    let path = bridge_path();
    if !path.is_file() {
        if require() {
            panic!("bridge cdylib is missing at {}", path.display());
        }
        return;
    }
    // The loader looks at LIME_OCCT_BRIDGE before the executable directory.
    unsafe { std::env::set_var("LIME_OCCT_BRIDGE", &path) };
    let loaded = lime_model_load::open_box(10.0, 20.0, 30.0).expect("dlopen");
    let json = parse(&loaded);
    if measured {
        assert!(json.get("error").is_none(), "{json}");
        near(json["volumeMm3"].as_f64().expect("volume"), 6000.0);
    }
}

fn bridge_path() -> PathBuf {
    let name = if cfg!(windows) {
        "lime_model_occt.dll"
    } else if cfg!(target_os = "macos") {
        "liblime_model_occt.dylib"
    } else {
        "liblime_model_occt.so"
    };
    let exe = std::env::current_exe().expect("test executable");
    let deps = exe.parent().expect("deps directory");
    let beside_tests = deps.join(name);
    if beside_tests.is_file() {
        return beside_tests;
    }
    deps.parent().expect("target directory").join(name)
}

fn assert_shared(stem: &str) {
    #[cfg(windows)]
    {
        let _ = stem;
    }
    #[cfg(not(windows))]
    {
        let exe = std::env::current_exe().expect("test executable");
        let tool = if cfg!(target_os = "macos") { "otool" } else { "ldd" };
        let mut cmd = std::process::Command::new(tool);
        if cfg!(target_os = "macos") {
            cmd.arg("-L");
        }
        let out = cmd.arg(&exe).output().expect(tool);
        assert!(out.status.success(), "{tool} failed");
        let text = String::from_utf8_lossy(&out.stdout);
        let needle = if cfg!(target_os = "macos") {
            format!("lib{stem}.")
        } else {
            format!("lib{stem}.so")
        };
        assert!(
            text.lines().any(|line| line.contains(&needle) && !line.contains("not found")),
            "{stem} is not a resolved dynamic import of {}. {text}",
            exe.display()
        );
    }
}
