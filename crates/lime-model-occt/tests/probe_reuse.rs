//! A probe's result is committed by an Apply with the same numbers, each resulting shape's
//! volume is integrated once, and undo or redo of a shape the session holds returns its reply
//! as it was. The kernel counts its own work; every check reads the change in those counts.
//! One test, because the session is one per process.

use lime_model_occt::{Tool, stats};
use serde_json::Value;

fn parse(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or_else(|err| panic!("not JSON ({err}): {text}"))
}

fn near(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() < 0.05,
        "{actual} is not near {expected}"
    );
}

#[derive(Debug, PartialEq)]
struct Work {
    builds: i64,
    volumes: i64,
    tessellations: i64,
}

fn counts() -> Work {
    let json = parse(&stats());
    let read = |key: &str| json[key].as_i64().unwrap_or_else(|| panic!("{key} in {json}"));
    Work {
        builds: read("builds"),
        volumes: read("volumes"),
        tessellations: read("tessellations"),
    }
}

/// Run `step` and return what it cost the kernel.
fn cost<T>(step: impl FnOnce() -> T) -> (T, Work) {
    let before = counts();
    let out = step();
    let after = counts();
    (
        out,
        Work {
            builds: after.builds - before.builds,
            volumes: after.volumes - before.volumes,
            tessellations: after.tessellations - before.tessellations,
        },
    )
}

fn work(builds: i64, volumes: i64, tessellations: i64) -> Work {
    Work {
        builds,
        volumes,
        tessellations,
    }
}

fn cube_at(x: f64) -> Tool {
    Tool {
        origin: [x, 0.0, 0.0],
        size: [10.0, 10.0, 10.0],
        radius: 0.0,
        height: 0.0,
        turn: [0.0; 3],
    }
}

fn volume(reply: &str) -> f64 {
    let json = parse(reply);
    assert!(json.get("error").is_none(), "{json}");
    json["volumeMm3"].as_f64().expect("volume")
}

#[test]
fn probe_results_volumes_and_replies_are_computed_once() {
    let json = parse(&lime_model_occt::open_box(10.0, 10.0, 10.0));
    if json.get("error").is_some() {
        if std::env::var_os("LIME_REQUIRE_OCCT").is_some() {
            panic!("OCCT was required: {json}");
        }
        return;
    }
    let (opened, opening) = cost(|| lime_model_occt::open_box(10.0, 10.0, 10.0));
    assert_eq!(opening, work(0, 1, 1), "opening integrates and tessellates once");
    let id = parse(&opened)["id"].as_i64().expect("id") as i32;

    let (probe, probing) = cost(|| lime_model_occt::boolean_probe(id, "fuse", "box", cube_at(10.0)));
    assert_eq!(parse(&probe)["ok"].as_bool(), Some(true), "{probe}");
    assert_eq!(probing, work(1, 1, 0), "a probe builds once and integrates its result once");
    let (fused, applying) = cost(|| lime_model_occt::boolean(id, "fuse", "box", cube_at(10.0), 0.1));
    near(volume(&fused), 2000.0);
    assert_eq!(applying, work(0, 0, 1), "Apply after an equal probe commits the probed shape");

    let (undone, undoing) = cost(|| lime_model_occt::undo(id, 0.1));
    assert_eq!(undone, opened, "undo returns the reply the solid had");
    assert_eq!(undoing, work(0, 0, 0));
    let (redone, redoing) = cost(|| lime_model_occt::redo(id, 0.1));
    assert_eq!(redone, fused, "redo returns the reply the solid had");
    assert_eq!(redoing, work(0, 0, 0));
    let (coarse, coarser) = cost(|| lime_model_occt::undo(id, 0.5));
    near(volume(&coarse), 1000.0);
    assert_eq!(coarser, work(0, 0, 1), "a new chord builds a new reply");

    let _ = lime_model_occt::boolean_probe(id, "fuse", "box", cube_at(10.0));
    let (moved, changed) = cost(|| lime_model_occt::boolean(id, "fuse", "box", cube_at(5.0), 0.1));
    near(volume(&moved), 1500.0);
    assert_eq!(changed, work(1, 1, 1), "changed numbers build again");
    let after_edit = parse(&lime_model_occt::redo(id, 0.1));
    assert_eq!(after_edit["error"].as_str(), Some("There is no edit to redo"));
    let _ = lime_model_occt::undo(id, 0.1);

    let _ = lime_model_occt::boolean_probe(id, "fuse", "box", cube_at(10.0));
    let _ = lime_model_occt::boolean_probe(id, "fuse", "box", cube_at(5.0));
    let (older, superseded) = cost(|| lime_model_occt::boolean(id, "fuse", "box", cube_at(10.0), 0.1));
    near(volume(&older), 2000.0);
    assert_eq!(superseded, work(1, 1, 1), "only the newest probe is kept");
    let _ = lime_model_occt::undo(id, 0.1);

    let _ = lime_model_occt::boolean_probe(id, "fuse", "box", cube_at(10.0));
    let hole = std::f64::consts::PI * 4.0 * 10.0;
    let (drilled, drilling) =
        cost(|| lime_model_occt::hole_axis(id, [5.0, 5.0, 10.0], [0.0, 0.0, -1.0], 2.0, 12.0, 0.1));
    near(volume(&drilled), 1000.0 - hole);
    assert_eq!(drilling, work(1, 1, 1), "a hole integrates its result once");
    let (stale, rebuilt) = cost(|| lime_model_occt::boolean(id, "fuse", "box", cube_at(10.0), 0.1));
    near(volume(&stale), 2000.0 - hole);
    assert_eq!(rebuilt, work(1, 1, 1), "a probe of an older solid is not committed");
    let _ = lime_model_occt::undo(id, 0.1);
    let _ = lime_model_occt::undo(id, 0.1);

    let (hole_probe, hole_probing) =
        cost(|| lime_model_occt::hole_axis_probe(id, [5.0, 5.0, 10.0], [0.0, 0.0, -1.0], 2.0, 12.0));
    assert_eq!(parse(&hole_probe)["ok"].as_bool(), Some(true), "{hole_probe}");
    assert_eq!(hole_probing, work(1, 1, 0));
    let (probed_hole, hole_applying) =
        cost(|| lime_model_occt::hole_axis(id, [5.0, 5.0, 10.0], [0.0, 0.0, -1.0], 2.0, 12.0, 0.1));
    near(volume(&probed_hole), 1000.0 - hole);
    assert_eq!(hole_applying, work(0, 0, 1));
    let again = parse(&lime_model_occt::hole_axis_probe(
        id,
        [5.0, 5.0, 10.0],
        [0.0, 0.0, -1.0],
        2.0,
        12.0,
    ));
    assert_eq!(again["error"].as_str(), Some("The hole missed this solid"));
    let _ = lime_model_occt::undo(id, 0.1);

    let removed = 10.0 * 4.0 * (1.0 - std::f64::consts::PI / 4.0);
    let (fits, fillet_probing) = cost(|| lime_model_occt::blend_probe_many(id, &[0], 2.0, false));
    assert_eq!(parse(&fits)["ok"].as_bool(), Some(true), "{fits}");
    assert_eq!(fillet_probing, work(1, 1, 0));
    let (filleted, filleting) = cost(|| lime_model_occt::fillet(id, 0, 2.0, 0.1));
    near(volume(&filleted), 1000.0 - removed);
    assert_eq!(filleting, work(0, 0, 1), "a single-edge Apply reuses a one-edge probe");
    let _ = lime_model_occt::undo(id, 0.1);
    let _ = lime_model_occt::blend_probe_many(id, &[0], 2.0, false);
    let (chamfered, other_kind) = cost(|| lime_model_occt::chamfer(id, 0, 2.0, 0.1));
    near(volume(&chamfered), 980.0);
    assert_eq!(other_kind, work(1, 1, 1), "a fillet probe is not a chamfer");
    let _ = lime_model_occt::undo(id, 0.1);

    let (grown, growing) = cost(|| lime_model_occt::scale(id, 2.0, 0.1));
    near(volume(&grown), 8000.0);
    assert_eq!(growing.volumes, 0, "a scale's volume is the factor cubed");
    let _ = lime_model_occt::undo(id, 0.1);

    let plane = lime_model_occt::Plane {
        origin: [0.0, 0.0, 4.0],
        normal: [0.0, 0.0, 1.0],
    };
    let (split, splitting) = cost(|| lime_model_occt::split(id, plane, 0.1));
    let split = parse(&split);
    near(split["volumeMm3"].as_f64().expect("kept"), 400.0);
    near(split["other"]["volumeMm3"].as_f64().expect("other"), 600.0);
    assert_eq!(splitting, work(1, 2, 2), "each piece is integrated once");
    let (restored, restoring) = cost(|| lime_model_occt::undo(id, 0.1));
    near(volume(&restored), 1000.0);
    assert_eq!(restoring.tessellations, 0);
    let (kept, keeping) = cost(|| lime_model_occt::redo(id, 0.1));
    near(volume(&kept), 400.0);
    assert!(parse(&kept).get("other").is_none(), "redo returns the kept piece alone");
    assert_eq!(keeping, work(0, 0, 0));
}
