//! Support demand from a STEP solid's faces. Run with LIME_REQUIRE_OCCT=1 and
//! LIME_OCCT_BRIDGE pointing at the built bridge.
use base64::Engine;
use lime_slice_core::{slice_payload, Job};
use serde_json::{json, Value};

fn support_mm(reply: &Value) -> f64 {
    reply["estimate"]["byFeature"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["kind"] == "support" || row["kind"] == "support-interface")
        .map(|row| row["filamentMm"].as_f64().unwrap())
        .sum()
}

#[test]
fn a_cylinder_on_its_side_asks_from_its_faces() {
    let (Some((mesher, identity)), Some(faced)) = (
        lime_model_load::step_mesher(),
        lime_model_load::step_face_mesher(),
    ) else {
        assert!(
            std::env::var_os("LIME_REQUIRE_OCCT").is_none(),
            "OCCT STEP bridge is required"
        );
        eprintln!("skipping solid demand: bridge unavailable");
        return;
    };
    let bytes = include_bytes!("../../lime-slice-core/tests/fixtures/cylinder.step");
    let (triangles, faces) = faced(bytes, 0.05).unwrap();
    assert_eq!(mesher(bytes, 0.05).unwrap(), triangles);
    assert_eq!(faces.len(), triangles.len());
    assert!(faces.iter().any(|&f| f != faces[0]));

    lime_slice_core::set_step_mesher(mesher, identity);
    lime_slice_core::set_step_face_mesher(faced);
    let request = |demand: &str| {
        json!({
            "filename": "cylinder.step",
            "dataB64": base64::engine::general_purpose::STANDARD.encode(bytes),
            "pose": {
                "rotation": [1.0, 0.0, 0.0, 0.0, 0.0, -1.0, 0.0, 1.0, 0.0],
                "pivot": [0.0, 0.0, 6.0],
                "translation": [0.0, 0.0, 5.0],
            },
            "blend": {"mode": "single", "strategy": "toughness"},
            "supports": true,
            "supportStyle": "tree",
            "supportDemandSource": demand,
            "includeGcode": true,
            "includePreview": false,
            "baseline": false,
        })
        .to_string()
    };
    let slice = |demand: &str| -> Value {
        let text = slice_payload(&request(demand), None, Job::default(), |g| g.text()).unwrap();
        serde_json::from_str(&text).unwrap()
    };
    let layers = slice("layers");
    let solid = slice("solid");
    assert!(support_mm(&layers) > 0.0);
    assert!(support_mm(&solid) > 0.0);
    assert_ne!(solid["gcode"], layers["gcode"]);
}
