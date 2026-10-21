//! A modifier or a raised reinforcement is refused. An unknown recipe key is
//! named in the error. Neither is dropped and then solved.

use lime_sim::element::ElementKind;
use lime_sim::material::LinearOrthotropic;
use lime_sim::mesh::patch_mesh;
use lime_sim::recipe::{Recipe, REGIONS_REFUSAL};
use lime_sim::solve_request;
use lime_sim::study::{Request, Step, Study};

#[test]
fn an_unknown_recipe_key_is_named() {
    let raw = r#"{
        "walls": 2,
        "lineWidthMm": 0.4,
        "layerHeightMm": 0.2,
        "infill": 0.2,
        "pattern": "grid",
        "bonus": 1
    }"#;
    let err = serde_json::from_str::<Recipe>(raw).unwrap_err().to_string();
    assert!(err.contains("bonus"), "{err}");
}

#[test]
fn an_unknown_study_key_is_named() {
    let raw = r#"{
        "format": "lime-sim-1",
        "card": {
            "id": "inhouse-petg",
            "polymer": "PETG",
            "EInPlaneMPa": 1800,
            "EAcrossLayersMPa": 1500,
            "nu": 0.35,
            "strengthInPlaneMPa": 30,
            "strengthAcrossLayersMPa": 15,
            "densityGCm3": 1.27
        },
        "notAField": true
    }"#;
    let err = serde_json::from_str::<Study>(raw).unwrap_err().to_string();
    assert!(err.contains("notAField"), "{err}");
}

#[test]
fn a_modifier_region_is_refused_and_not_solved() {
    // The shape `simRecipe` writes for one modifier and a raised reinforcement.
    let raw = r#"{
        "walls": 2,
        "lineWidthMm": 0.45,
        "layerHeightMm": 0.2,
        "skinLayers": 3,
        "infill": 0.2,
        "pattern": "lightning",
        "patternFactor": 1,
        "patternMeasured": false,
        "reinforcedInfill": 0.9,
        "regions": [
            {"id": "volume-1", "kind": "box", "infill": 0.55},
            {"id": "range-1", "kind": "range", "walls": 6}
        ]
    }"#;
    let recipe: Recipe = serde_json::from_str(raw).expect("regions are a known field");
    assert_eq!(recipe.regions.len(), 2);
    assert!((recipe.reinforced_infill - 0.9).abs() < 1e-12);
    let err = solve_request(&request(recipe)).unwrap_err();
    assert_eq!(err.message, REGIONS_REFUSAL);
}

#[test]
fn reinforcement_above_the_infill_is_refused_on_its_own() {
    let mut recipe = Recipe::solid();
    recipe.infill = 0.2;
    recipe.reinforced_infill = 0.9;
    assert_eq!(
        recipe.refuse_regions().unwrap_err().message,
        REGIONS_REFUSAL
    );
}

#[test]
fn an_empty_region_list_is_the_whole_part_smear() {
    let raw = r#"{
        "walls": 2,
        "lineWidthMm": 0.4,
        "layerHeightMm": 0.2,
        "infill": 0.2,
        "pattern": "grid",
        "regions": [],
        "reinforcedInfill": 0.2
    }"#;
    let recipe: Recipe = serde_json::from_str(raw).unwrap();
    assert!(recipe.refuse_regions().is_ok());
}

fn request(recipe: Recipe) -> Request {
    Request {
        mesh: patch_mesh(ElementKind::Tet10, false).unwrap(),
        material: LinearOrthotropic::isotropic(1000.0, 0.3, 1.2),
        recipe,
        build_axis: [0.0, 0.0, 1.0],
        holds: Vec::new(),
        loads: Vec::new(),
        steps: vec![Step {
            factor: 1.0,
            max_iter: 1,
            tol: 1e-8,
        }],
        linear: true,
        gravity: None,
        h_mm: 1.0,
        allow_linear_tets: false,
        analysis: "static".into(),
        temperature_c: None,
        fibre_axis: None,
        solver: "faer-ldlt".into(),
        representation: "smear".into(),
        post_steps: Vec::new(),
        provisional: false,
        cancel: None,
        on_progress: None,
    }
}
