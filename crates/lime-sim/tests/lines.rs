//! Lines infill is a grid smear. The note says the layer direction is lost,
//! and an infill core cannot be marked converged.

use lime_sim::assemble::{Hold, Load, NodeHold};
use lime_sim::element::ElementKind;
use lime_sim::material::LinearOrthotropic;
use lime_sim::mesh::beam;
use lime_sim::recipe::{Pattern, Recipe};
use lime_sim::solve_request;
use lime_sim::study::{Request, Step};

const LINES_NOTE: &str = "Lines infill is modelled as a grid of the same density. Its strength along each layer's direction is not modelled.";

#[test]
fn lines_infill_is_noted_and_not_converged() {
    let mesh = beam(10.0, 10.0, 10.0, 10.0, ElementKind::Tet10).unwrap();
    let mut holds = Vec::new();
    for (node, p) in mesh.nodes.iter().enumerate() {
        if p[2].abs() <= 1e-8 {
            holds.push(NodeHold {
                node,
                hold: Hold::Fixed,
            });
        }
    }
    let loaded = mesh
        .nodes
        .iter()
        .enumerate()
        .max_by(|(_, a), (_, b)| a[2].total_cmp(&b[2]))
        .map(|(i, _)| i)
        .unwrap();
    let solution = solve_request(&Request {
        mesh,
        material: LinearOrthotropic::isotropic(1_000.0, 0.3, 1.2),
        recipe: Recipe {
            walls: 0,
            line_width_mm: 0.4,
            layer_height_mm: 0.2,
            skin_layers: 0,
            infill: 0.2,
            pattern: Pattern::Lines,
            pattern_factor: 1.0,
            pattern_measured: false,
            regions: Vec::new(),
            reinforced_infill: 0.2,
        },
        build_axis: [0.0, 0.0, 1.0],
        holds,
        loads: vec![Load::Force {
            node: loaded,
            force: [0.0, 0.0, -1.0],
        }],
        steps: vec![Step {
            factor: 1.0,
            max_iter: 1,
            tol: 1e-8,
        }],
        linear: true,
        gravity: None,
        h_mm: 10.0,
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
    })
    .unwrap_or_else(|err| panic!("{}", err.message));
    assert!(
        solution.notes.iter().any(|line| line == LINES_NOTE),
        "notes {:?}",
        solution.notes
    );
    assert_ne!(
        solution.trust.as_str(),
        "converged",
        "{}",
        solution.trust.as_str()
    );
}
