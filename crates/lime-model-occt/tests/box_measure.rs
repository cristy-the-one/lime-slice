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
            distances
                .iter()
                .any(|value| (*value - expected).abs() < 0.05),
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
        booleans_and_split();
    }

    assert_shared("TKPrim");
    bridge_exports(true);
}

fn tool(origin: [f64; 3], size: [f64; 3], radius: f64, height: f64) -> lime_model_occt::Tool {
    lime_model_occt::Tool {
        origin,
        size,
        radius,
        height,
    }
}

fn plane(origin: [f64; 3], normal: [f64; 3]) -> lime_model_occt::Plane {
    lime_model_occt::Plane { origin, normal }
}

fn booleans_and_split() {
    let opened = parse(&lime_model_occt::open_box(10.0, 10.0, 10.0));
    let id = opened["id"].as_i64().expect("id") as i32;
    near(opened["volumeMm3"].as_f64().expect("volume"), 1000.0);

    let rejected = parse(&lime_model_occt::boolean(
        id,
        "fuse",
        "box",
        tool([0.0, 0.0, 0.0], [0.0, 10.0, 10.0], 0.0, 0.0),
        0.1,
    ));
    assert_eq!(
        rejected["error"].as_str(),
        Some("A box needs a positive length on each side")
    );
    let missed = parse(&lime_model_occt::split(
        id,
        plane([0.0, 0.0, 100.0], [0.0, 0.0, 1.0]),
        0.1,
    ));
    assert_eq!(
        missed["error"].as_str(),
        Some("The plane did not split this solid")
    );
    let apart = parse(&lime_model_occt::boolean(
        id,
        "common",
        "box",
        tool([100.0, 0.0, 0.0], [10.0, 10.0, 10.0], 0.0, 0.0),
        0.1,
    ));
    assert_eq!(apart["error"].as_str(), Some("The solids do not overlap"));

    let fused = parse(&lime_model_occt::boolean(
        id,
        "fuse",
        "box",
        tool([10.0, 0.0, 0.0], [10.0, 10.0, 10.0], 0.0, 0.0),
        0.1,
    ));
    assert!(fused.get("error").is_none(), "{fused}");
    near(fused["volumeMm3"].as_f64().expect("fused"), 2000.0);
    let undone = parse(&lime_model_occt::undo(id, 0.1));
    assert!(undone.get("error").is_none(), "{undone}");
    near(undone["volumeMm3"].as_f64().expect("undone"), 1000.0);

    let cut = parse(&lime_model_occt::boolean(
        id,
        "cut",
        "box",
        tool([0.0, 0.0, 5.0], [10.0, 10.0, 5.0], 0.0, 0.0),
        0.1,
    ));
    assert!(cut.get("error").is_none(), "{cut}");
    near(cut["volumeMm3"].as_f64().expect("cut"), 500.0);
    let _ = lime_model_occt::undo(id, 0.1);

    let common = parse(&lime_model_occt::boolean(
        id,
        "common",
        "box",
        tool([0.0, 0.0, 0.0], [10.0, 10.0, 5.0], 0.0, 0.0),
        0.1,
    ));
    assert!(common.get("error").is_none(), "{common}");
    near(common["volumeMm3"].as_f64().expect("common"), 500.0);
    let _ = lime_model_occt::undo(id, 0.1);

    let cylinder = std::f64::consts::PI * 25.0 * 10.0;
    let fused_cylinder = parse(&lime_model_occt::boolean(
        id,
        "fuse",
        "cylinder",
        tool([0.0, 0.0, 0.0], [0.0, 0.0, 0.0], 5.0, 10.0),
        0.1,
    ));
    assert!(fused_cylinder.get("error").is_none(), "{fused_cylinder}");
    near(
        fused_cylinder["volumeMm3"].as_f64().expect("cylinder"),
        1000.0 + cylinder * 0.75,
    );
    let _ = lime_model_occt::undo(id, 0.1);

    let sphere = 4.0 / 3.0 * std::f64::consts::PI * 125.0;
    let cut_sphere = parse(&lime_model_occt::boolean(
        id,
        "cut",
        "sphere",
        tool([5.0, 5.0, 5.0], [0.0, 0.0, 0.0], 5.0, 0.0),
        0.1,
    ));
    assert!(cut_sphere.get("error").is_none(), "{cut_sphere}");
    near(
        cut_sphere["volumeMm3"].as_f64().expect("sphere"),
        1000.0 - sphere,
    );
    let _ = lime_model_occt::undo(id, 0.1);

    let split = parse(&lime_model_occt::split(
        id,
        plane([0.0, 0.0, 5.0], [0.0, 0.0, 1.0]),
        0.1,
    ));
    assert!(split.get("error").is_none(), "{split}");
    near(split["volumeMm3"].as_f64().expect("kept"), 500.0);
    near(split["other"]["volumeMm3"].as_f64().expect("other"), 500.0);
    assert!(split["positions"].as_array().expect("positions").len() >= 9);
    assert!(
        split["other"]["positions"]
            .as_array()
            .expect("other positions")
            .len()
            >= 9
    );
    let restored = parse(&lime_model_occt::undo(id, 0.1));
    near(restored["volumeMm3"].as_f64().expect("restored"), 1000.0);
    assert!(restored.get("other").is_none());

    thin_plate_split();

    let step_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../samples/step_cube.step");
    let step = parse(&lime_model_occt::open_step(&step_path, 0.1));
    assert!(step.get("error").is_none(), "{step}");
    near(step["volumeMm3"].as_f64().expect("step"), 1000.0);
    let step_id = step["id"].as_i64().expect("id") as i32;
    let step_fuse = parse(&lime_model_occt::boolean(
        step_id,
        "fuse",
        "box",
        tool([10.0, 0.0, 0.0], [10.0, 10.0, 10.0], 0.0, 0.0),
        0.1,
    ));
    assert!(step_fuse.get("error").is_none(), "{step_fuse}");
    near(step_fuse["volumeMm3"].as_f64().expect("step fuse"), 2000.0);
    blends_hole_and_scale();
}

fn span_x(positions: &Value) -> f64 {
    let values = positions.as_array().expect("positions");
    let mut min_x = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    for (index, value) in values.iter().enumerate() {
        if index % 3 != 0 {
            continue;
        }
        let x = value.as_f64().expect("x");
        min_x = min_x.min(x);
        max_x = max_x.max(x);
    }
    max_x - min_x
}

/// A 220×220×5 plate cut on its top face must not become a 0.1 mm sliver.
fn thin_plate_split() {
    let opened = parse(&lime_model_occt::open_box(220.0, 220.0, 5.0));
    assert!(opened.get("error").is_none(), "{opened}");
    let id = opened["id"].as_i64().expect("id") as i32;
    near(opened["volumeMm3"].as_f64().expect("volume"), 242_000.0);
    let face = parse(&lime_model_occt::split(
        id,
        plane([0.0, 0.0, 5.0], [0.0, 0.0, 1.0]),
        0.1,
    ));
    assert_eq!(
        face["error"].as_str(),
        Some("The plane is too close to a face. Move it into the part.")
    );
    let mid = parse(&lime_model_occt::split(
        id,
        plane([0.0, 0.0, 2.5], [0.0, 0.0, 1.0]),
        0.1,
    ));
    assert!(mid.get("error").is_none(), "{mid}");
    near(mid["volumeMm3"].as_f64().expect("kept"), 121_000.0);
    near(
        mid["other"]["volumeMm3"].as_f64().expect("other"),
        121_000.0,
    );
    let kept_span = span_x(&mid["positions"]);
    let other_span = span_x(&mid["other"]["positions"]);
    assert!((200.0..230.0).contains(&kept_span), "kept span {kept_span}");
    assert!(
        (200.0..230.0).contains(&other_span),
        "other span {other_span}"
    );
}

fn blends_hole_and_scale() {
    let opened = parse(&lime_model_occt::open_box(10.0, 10.0, 10.0));
    let id = opened["id"].as_i64().expect("id") as i32;
    near(opened["volumeMm3"].as_f64().expect("volume"), 1000.0);

    let unpicked = parse(&lime_model_occt::fillet(id, -1, 2.0, 0.1));
    assert_eq!(unpicked["error"].as_str(), Some("Pick an edge to fillet."));
    let flat = parse(&lime_model_occt::fillet(id, 0, 0.0, 0.1));
    assert_eq!(
        flat["error"].as_str(),
        Some("A fillet needs a positive radius")
    );
    let tight = parse(&lime_model_occt::fillet(id, 0, 11.0, 0.1));
    assert_eq!(
        tight["error"].as_str(),
        Some("The fillet did not fit this edge")
    );

    let removed = 10.0 * 4.0 * (1.0 - std::f64::consts::PI / 4.0);
    let filleted = parse(&lime_model_occt::fillet(id, 0, 2.0, 0.1));
    assert!(filleted.get("error").is_none(), "{filleted}");
    near(
        filleted["volumeMm3"].as_f64().expect("fillet"),
        1000.0 - removed,
    );
    let undone = parse(&lime_model_occt::undo(id, 0.1));
    near(undone["volumeMm3"].as_f64().expect("undo fillet"), 1000.0);

    let missing = parse(&lime_model_occt::chamfer(id, 99, 1.0, 0.1));
    assert_eq!(
        missing["error"].as_str(),
        Some("That edge is not on this solid")
    );
    let no_chamfer = parse(&lime_model_occt::chamfer(id, 0, 0.0, 0.1));
    assert_eq!(
        no_chamfer["error"].as_str(),
        Some("A chamfer needs a positive distance")
    );
    let chamfered = parse(&lime_model_occt::chamfer(id, 0, 1.0, 0.1));
    assert!(chamfered.get("error").is_none(), "{chamfered}");
    near(chamfered["volumeMm3"].as_f64().expect("chamfer"), 995.0);
    let _ = lime_model_occt::undo(id, 0.1);

    let no_hole = parse(&lime_model_occt::hole(id, [5.0, 5.0, 10.0], 0.0, 12.0, 0.1));
    assert_eq!(
        no_hole["error"].as_str(),
        Some("A hole needs a positive radius and depth")
    );
    let missed = parse(&lime_model_occt::hole(
        id,
        [100.0, 0.0, 10.0],
        2.0,
        12.0,
        0.1,
    ));
    assert_eq!(missed["error"].as_str(), Some("The hole missed this solid"));
    let gone = parse(&lime_model_occt::hole(
        id,
        [5.0, 5.0, 11.0],
        20.0,
        12.0,
        0.1,
    ));
    assert_eq!(gone["error"].as_str(), Some("The hole removed the solid"));
    let drilled = parse(&lime_model_occt::hole(id, [5.0, 5.0, 10.0], 2.0, 12.0, 0.1));
    assert!(drilled.get("error").is_none(), "{drilled}");
    near(
        drilled["volumeMm3"].as_f64().expect("hole"),
        1000.0 - std::f64::consts::PI * 4.0 * 10.0,
    );
    let _ = lime_model_occt::undo(id, 0.1);

    let zero = parse(&lime_model_occt::scale(id, 0.0, 0.1));
    assert_eq!(
        zero["error"].as_str(),
        Some("Scale needs a positive factor")
    );
    let same = parse(&lime_model_occt::scale(id, 1.0, 0.1));
    assert_eq!(
        same["error"].as_str(),
        Some("Scale needs a factor other than 1")
    );
    let grown = parse(&lime_model_occt::scale(id, 2.0, 0.1));
    assert!(grown.get("error").is_none(), "{grown}");
    near(grown["volumeMm3"].as_f64().expect("scale"), 8000.0);
    let restored = parse(&lime_model_occt::undo(id, 0.1));
    near(restored["volumeMm3"].as_f64().expect("undo scale"), 1000.0);
    assert_shared("TKFillet");
    write_step_round_trip();
}

fn write_step_round_trip() {
    let opened = parse(&lime_model_occt::open_box(10.0, 10.0, 10.0));
    let id = opened["id"].as_i64().expect("id") as i32;
    let path = std::env::temp_dir().join(format!("lime-model-write-{}.step", std::process::id()));
    let wrote = parse(&lime_model_occt::write_step(id, &path));
    assert!(wrote.get("error").is_none(), "{wrote}");
    let text = std::fs::read_to_string(&path).expect("step file");
    assert!(
        text.contains("AUTOMOTIVE_DESIGN"),
        "schema is not AP214: {text}"
    );
    assert!(
        text.contains("MANIFOLD_SOLID_BREP"),
        "not a manifold solid: {text}"
    );
    let reread = parse(&lime_model_occt::open_step(&path, 0.1));
    let _ = std::fs::remove_file(&path);
    assert!(reread.get("error").is_none(), "{reread}");
    near(reread["volumeMm3"].as_f64().expect("reread"), 1000.0);

    let step_id = reread["id"].as_i64().expect("id") as i32;
    let fused = parse(&lime_model_occt::boolean(
        step_id,
        "fuse",
        "box",
        tool([10.0, 0.0, 0.0], [10.0, 10.0, 10.0], 0.0, 0.0),
        0.1,
    ));
    assert!(fused.get("error").is_none(), "{fused}");
    let edited =
        std::env::temp_dir().join(format!("lime-model-edited-{}.step", std::process::id()));
    let wrote_edit = parse(&lime_model_occt::write_step(step_id, &edited));
    assert!(wrote_edit.get("error").is_none(), "{wrote_edit}");
    let again = parse(&lime_model_occt::open_step(&edited, 0.1));
    let _ = std::fs::remove_file(&edited);
    assert!(again.get("error").is_none(), "{again}");
    near(again["volumeMm3"].as_f64().expect("edited"), 2000.0);
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
        let id = json["id"].as_i64().expect("id") as i32;
        let fused = parse(
            &lime_model_load::boolean(
                id,
                "fuse",
                "box",
                lime_model_load::Tool {
                    origin: [20.0, 0.0, 0.0],
                    size: [10.0, 10.0, 10.0],
                    radius: 0.0,
                    height: 0.0,
                },
                0.1,
            )
            .expect("dlopen boolean"),
        );
        assert!(fused.get("error").is_none(), "{fused}");
        near(fused["volumeMm3"].as_f64().expect("fused"), 7000.0);
        let grown = parse(&lime_model_load::scale(id, 2.0, 0.1).expect("dlopen scale"));
        assert!(grown.get("error").is_none(), "{grown}");
        near(grown["volumeMm3"].as_f64().expect("scale"), 56000.0);
        let path =
            std::env::temp_dir().join(format!("lime-model-bridge-{}.step", std::process::id()));
        let wrote = parse(&lime_model_load::write_step(id, &path).expect("dlopen write"));
        assert!(wrote.get("error").is_none(), "{wrote}");
        let text = std::fs::read_to_string(&path).expect("bridge step");
        let _ = std::fs::remove_file(&path);
        assert!(text.contains("MANIFOLD_SOLID_BREP"), "{text}");
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
        let tool = if cfg!(target_os = "macos") {
            "otool"
        } else {
            "ldd"
        };
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
            text.lines()
                .any(|line| line.contains(&needle) && !line.contains("not found")),
            "{stem} is not a resolved dynamic import of {}. {text}",
            exe.display()
        );
    }
}
