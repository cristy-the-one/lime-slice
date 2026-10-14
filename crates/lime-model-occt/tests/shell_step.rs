//! STEP files from mesh converters carry closed shells of loose facets and no solid.
//! Three 10 mm cubes written that way, two sharing a wall and one wound inside out,
//! open as 3000 mm³ that splits, cuts, and drills. A shell with a gap, or one that
//! crosses itself, opens for measuring only.

mod facets;

use facets::{broken_cubes, three_cubes, write_step};
use serde_json::Value;

const VIEW_ONLY: &str =
    "This STEP file has surfaces but no closed solid, so it can be measured but not edited.";

fn parse(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or_else(|err| panic!("not JSON ({err}): {text}"))
}

fn near(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() < 0.05,
        "{actual} is not near {expected}"
    );
}

fn volume(json: &Value) -> f64 {
    assert!(json.get("error").is_none(), "{json}");
    json["volumeMm3"].as_f64().expect("volume")
}

fn plane(origin: [f64; 3], normal: [f64; 3]) -> lime_model_occt::Plane {
    lime_model_occt::Plane { origin, normal }
}

fn cutter(origin: [f64; 3], size: [f64; 3]) -> lime_model_occt::Tool {
    lime_model_occt::Tool {
        origin,
        size,
        radius: 0.0,
        height: 0.0,
        turn: [0.0; 3],
    }
}

#[test]
fn facet_shells_open_as_editable_solids() {
    if parse(&lime_model_occt::open_box(1.0, 1.0, 1.0))
        .get("error")
        .is_some()
    {
        assert!(
            std::env::var_os("LIME_REQUIRE_OCCT").is_none(),
            "OCCT was required"
        );
        return;
    }

    let path = write_step("cubes", &three_cubes());
    let opened = parse(&lime_model_occt::open_step(&path, 0.1));
    near(volume(&opened), 3000.0);
    let id = opened["id"].as_i64().expect("id") as i32;

    let split = parse(&lime_model_occt::split(
        id,
        plane([25.0, 5.0, 5.0], [0.0, 0.0, 1.0]),
        0.1,
    ));
    near(volume(&split), 1500.0);
    near(volume(&split["other"]), 1500.0);
    near(volume(&parse(&lime_model_occt::undo(id, 0.1))), 3000.0);

    let cut = parse(&lime_model_occt::boolean(
        id,
        "cut",
        "box",
        cutter([5.0, -1.0, -1.0], [10.0, 12.0, 12.0]),
        0.1,
    ));
    near(volume(&cut), 2000.0);
    near(volume(&parse(&lime_model_occt::undo(id, 0.1))), 3000.0);

    let drilled = parse(&lime_model_occt::hole(id, [45.0, 5.0, 10.0], 2.0, 4.0, 0.1));
    near(volume(&drilled), 3000.0 - std::f64::consts::PI * 16.0);
    let _ = std::fs::remove_file(&path);

    for (name, shell) in broken_cubes() {
        let path = write_step(name, &[shell]);
        let opened = parse(&lime_model_occt::open_step(&path, 0.1));
        assert!(opened.get("error").is_none(), "{name}: {opened}");
        let id = opened["id"].as_i64().expect("id") as i32;
        let refusals = [
            lime_model_occt::split(id, plane([5.0, 5.0, 5.0], [0.0, 0.0, 1.0]), 0.1),
            lime_model_occt::boolean(
                id,
                "cut",
                "box",
                cutter([-1.0, -1.0, -1.0], [6.0, 12.0, 12.0]),
                0.1,
            ),
            lime_model_occt::hole(id, [5.0, 5.0, 10.0], 2.0, 4.0, 0.1),
            lime_model_occt::fillet(id, 0, 1.0, 0.1),
            lime_model_occt::scale(id, 2.0, 0.1),
            lime_model_occt::hole_probe(id, [5.0, 5.0, 10.0], 2.0, 4.0),
            lime_model_occt::boolean_probe(id, "cut", "box", cutter([-1.0, -1.0, -1.0], [6.0, 12.0, 12.0])),
            lime_model_occt::blend_probe_many(id, &[0], 1.0, false),
        ];
        for refusal in refusals {
            assert_eq!(parse(&refusal)["error"].as_str(), Some(VIEW_ONLY), "{name}");
        }
        let _ = std::fs::remove_file(&path);
    }
}
