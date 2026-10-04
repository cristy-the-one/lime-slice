//! Progress stays ordered, a cancel stops at the stage it names, and the
//! G-code of a slice that was watched or cancelled and run again matches a
//! slice that was neither.

use std::fs;
use std::path::PathBuf;
use std::time::Instant;

use base64::Engine;
use lime_slice_core::{
    keep_support_bases, slice_payload, slice_payload_watched, slice_request, slice_request_watched,
    Job, SliceCache, SliceRequest, Stage, Status, Watch,
};
use serde_json::{json, Value};

fn cube_request(preview: bool) -> SliceRequest {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../samples/calibration_cube_20mm.stl");
    let bytes = fs::read(path).unwrap();
    serde_json::from_value(json!({
        "filename": "calibration_cube_20mm.stl",
        "dataB64": base64::engine::general_purpose::STANDARD.encode(bytes),
        "baseline": false,
        "compare": false,
        "includePreview": preview,
        "includeGcode": true,
    }))
    .unwrap()
}

fn stage_index(name: &str) -> usize {
    Stage::ALL
        .iter()
        .position(|stage| stage.name() == name)
        .unwrap_or(0)
}

#[test]
fn a_watched_slice_reports_stages_in_order_and_matches_an_unwatched_one() {
    let req = cube_request(false);
    let plain = slice_request(&req, Job::default()).unwrap();
    let watch = Watch::new();
    let watched = slice_request_watched(&req, Job::default(), &watch);
    watch.finish(Status::of(&watched));
    let watched = watched.unwrap();
    assert_eq!(watched.gcode, plain.gcode);

    let events = watch.events();
    assert!(events.len() > Stage::ALL.len());
    let mut fraction = 0.0;
    let mut stage = 0;
    let mut done = 0u32;
    for event in &events {
        assert!(event.fraction + 1e-12 >= fraction, "{event:?}");
        assert!((0.0..=1.0).contains(&event.fraction));
        assert!(event.total == 0 || event.done <= event.total);
        let index = stage_index(event.stage);
        assert!(index >= stage, "{} after {}", event.stage, events[0].stage);
        if index == stage {
            assert!(event.done >= done || event.status != Status::Running);
        } else {
            done = 0;
        }
        if event.status == Status::Running {
            done = event.done;
            stage = index;
        }
        fraction = event.fraction;
    }
    let end = watch.snapshot();
    assert_eq!(end.status, Status::Done);
    assert!((end.fraction - 1.0).abs() < 1e-12);
    let names: Vec<_> = events.iter().map(|event| event.stage).collect();
    for stage in Stage::ALL {
        assert!(
            names.contains(&stage.name()),
            "missing {} in {names:?}",
            stage.name()
        );
    }
}

#[test]
fn cancelling_at_each_stage_stops_there_and_a_rerun_matches() {
    let req = cube_request(false);
    let started = Instant::now();
    let plain = slice_request(&req, Job::default()).unwrap();
    let full_ms = started.elapsed().as_secs_f64() * 1000.0;

    for stage in Stage::ALL {
        let watch = Watch::cancel_on(stage);
        let started = Instant::now();
        let result = slice_request_watched(&req, Job::default(), &watch);
        let ms = started.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(result.unwrap_err(), "cancelled");
        watch.finish(Status::Cancelled);
        assert_eq!(watch.snapshot().status, Status::Cancelled);
        let seen: Vec<_> = watch
            .events()
            .into_iter()
            .map(|event| event.stage)
            .collect();
        assert!(
            seen.iter().any(|name| *name == stage.name()),
            "{stage:?} never started: {seen:?}"
        );
        assert!(
            seen.iter()
                .all(|name| stage_index(name) <= stage_index(stage.name())),
            "{stage:?} ran past itself: {seen:?}"
        );
        if matches!(stage, Stage::Load | Stage::Cut | Stage::Part) {
            assert!(
                ms < full_ms * 0.9,
                "{stage:?} took {ms:.0} ms of a {full_ms:.0} ms slice"
            );
        }
    }

    let watch = Watch::new();
    let again = slice_request_watched(&req, Job::default(), &watch).unwrap();
    watch.finish(Status::Done);
    assert_eq!(again.gcode, plain.gcode);
}

#[test]
fn a_cancelled_slice_is_not_cached_and_the_next_one_is_the_full_result() {
    let dir = std::env::temp_dir().join(format!(
        "lime-slice-progress-cache-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = fs::remove_dir_all(&dir);
    let cache = SliceCache::new(&dir, 1 << 30);
    let payload = serde_json::to_string(&cube_request(false)).unwrap();

    let watch = Watch::cancel_on(Stage::Part);
    let err = slice_payload_watched(&payload, Some(&cache), Job::default(), &watch, |g| g.text());
    assert_eq!(err, Err("cancelled".to_string()));
    watch.finish(Status::Cancelled);
    cache.flush();
    let files: Vec<_> = fs::read_dir(&dir).map_or(Vec::new(), |dir| dir.collect());
    assert!(files.is_empty(), "a cancelled slice left {}", files.len());

    let plain: Value =
        serde_json::from_str(&slice_payload(&payload, None, Job::default(), |g| g.text()).unwrap())
            .unwrap();
    let first: Value = serde_json::from_str(
        &slice_payload(&payload, Some(&cache), Job::default(), |g| g.text()).unwrap(),
    )
    .unwrap();
    cache.flush();
    assert_eq!(first["fromCache"], json!(false));
    assert_eq!(first["gcode"], plain["gcode"]);
    let stored = fs::read_dir(&dir)
        .unwrap()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().extension().and_then(|ext| ext.to_str()) == Some("json"))
        .count();
    assert_eq!(stored, 1);

    let second: Value = serde_json::from_str(
        &slice_payload(&payload, Some(&cache), Job::default(), |g| g.text()).unwrap(),
    )
    .unwrap();
    assert_eq!(second["fromCache"], json!(true));
    assert_eq!(second["gcode"], plain["gcode"]);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_cancel_during_part_leaves_the_kept_shelves_usable() {
    keep_support_bases(false);
    let req = cube_request(true);
    let plain = slice_request(&req, Job::default()).unwrap();

    keep_support_bases(true);
    let watch = Watch::cancel_on(Stage::Part);
    let err = slice_request_watched(&req, Job::default(), &watch);
    assert_eq!(err.unwrap_err(), "cancelled");
    let again = slice_request(&req, Job::default()).unwrap();
    keep_support_bases(false);

    assert_eq!(again.gcode, plain.gcode);
}

#[test]
fn a_plate_fills_one_bar_in_object_order() {
    let object = |id: &str, name: &str, x: f64| {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../../samples/{name}"));
        json!({
            "id": id,
            "filename": name,
            "dataB64": base64::engine::general_purpose::STANDARD.encode(fs::read(path).unwrap()),
            "pose": {"rotation": [1, 0, 0, 0, 1, 0, 0, 0, 1], "pivot": [0, 0, 0], "translation": [x, 60, 0]},
        })
    };
    // The cube has 12 triangles and the ledge 24, so the cube is a third of the plate.
    let req: SliceRequest = serde_json::from_value(json!({
        "baseline": false,
        "includePreview": false,
        "includeGcode": true,
        "objects": [
            object("cube", "calibration_cube_20mm.stl", 40.0),
            object("ledge", "overhang_ledge.stl", 120.0),
        ],
    }))
    .unwrap();
    let watch = Watch::new();
    let sliced = slice_request_watched(&req, Job::default(), &watch);
    watch.finish(Status::of(&sliced));
    sliced.unwrap();

    let events = watch.events();
    let mut fraction = 0.0;
    for event in &events {
        assert!(event.fraction + 1e-12 >= fraction, "{event:?}");
        fraction = event.fraction;
    }
    let starts = |stage: &str| -> Vec<f64> {
        events
            .iter()
            .filter(|e| e.stage == stage && e.done == 0)
            .map(|e| (e.fraction * 1e6).round() / 1e6)
            .collect()
    };
    // The ledge's cut starts where the cube's ends, so only its ticks show.
    let cuts: Vec<f64> = events
        .iter()
        .filter(|e| e.stage == "cut")
        .map(|e| (e.fraction * 1e6).round() / 1e6)
        .collect();
    assert_eq!(starts("cut"), [0.02], "the cut starts once");
    assert!(cuts.contains(&0.046667), "the cube's cut ends a third in");
    assert_eq!(cuts.last(), Some(&0.1), "the ledge's cut fills the rest");
    assert_eq!(
        starts("part"),
        [0.1, 0.373333],
        "the ledge's stages start where the cube's end"
    );
    assert_eq!(starts("emit"), [0.92], "one emit for the plate");
    assert_eq!(watch.snapshot().fraction, 1.0);
}
