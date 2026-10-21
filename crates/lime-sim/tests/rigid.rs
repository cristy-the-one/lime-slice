//! A part held on a corner, or only along one edge, is a mechanism. The
//! sentence is the same one a fully free part already gets.

use lime_sim::assemble::{Hold, Load, NodeHold};
use lime_sim::element::ElementKind;
use lime_sim::material::LinearOrthotropic;
use lime_sim::mesh::beam;
use lime_sim::recipe::Recipe;
use lime_sim::solve_request;
use lime_sim::study::{Request, Step};

const SENTENCE: &str = "This part is not held. Fix a face, or the bed.";

fn nearest(nodes: &[[f64; 3]], target: [f64; 3]) -> usize {
    let mut best = 0;
    let mut best_d = f64::INFINITY;
    for (i, p) in nodes.iter().enumerate() {
        let d = (0..3).map(|k| (p[k] - target[k]).powi(2)).sum::<f64>();
        if d < best_d {
            best_d = d;
            best = i;
        }
    }
    best
}

fn solve_held(
    holds: Vec<NodeHold>,
    load_at: [f64; 3],
) -> Result<lime_sim::Solution, lime_sim::SimError> {
    let mesh = beam(10.0, 10.0, 10.0, 10.0, ElementKind::Tet10).unwrap();
    let loaded = nearest(&mesh.nodes, load_at);
    solve_request(&Request {
        mesh,
        material: LinearOrthotropic::isotropic(10_000.0, 0.3, 1.2),
        recipe: Recipe::solid(),
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
        cells: Vec::new(),
        post_steps: Vec::new(),
        provisional: false,
        cancel: None,
        on_progress: None,
    })
}

#[test]
fn a_corner_hold_is_not_held() {
    let mesh = beam(10.0, 10.0, 10.0, 10.0, ElementKind::Tet10).unwrap();
    let corner = nearest(&mesh.nodes, [0.0, 0.0, 0.0]);
    let err = solve_held(
        vec![NodeHold {
            node: corner,
            hold: Hold::Fixed,
        }],
        [10.0, 10.0, 10.0],
    )
    .unwrap_err();
    assert_eq!(err.message, SENTENCE);
}

#[test]
fn an_edge_line_is_not_held() {
    // Rotation about the edge leaves every node on that edge in place, so a
    // line of fixed nodes is still a mechanism.
    let mesh = beam(10.0, 10.0, 10.0, 10.0, ElementKind::Tet10).unwrap();
    let holds = mesh
        .nodes
        .iter()
        .enumerate()
        .filter(|(_, p)| p[1].abs() <= 1e-8 && p[2].abs() <= 1e-8)
        .map(|(node, _)| NodeHold {
            node,
            hold: Hold::Fixed,
        })
        .collect();
    let err = solve_held(holds, [0.0, 10.0, 10.0]).unwrap_err();
    assert_eq!(err.message, SENTENCE);
}
