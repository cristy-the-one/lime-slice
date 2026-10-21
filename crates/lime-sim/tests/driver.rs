#![allow(clippy::needless_range_loop)]

//! The load loop is real: one step runs, a second factor of 0 does not move
//! the tip, and a first factor of 0 followed by 1 matches a single step of 1.

use std::collections::HashSet;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use lime_sim::assemble::{Hold, Load, NodeHold};
use lime_sim::element::ElementKind;
use lime_sim::material::LinearOrthotropic;
use lime_sim::mesh::{beam, faces_on_plane};
use lime_sim::recipe::Recipe;
use lime_sim::study::{Request, Step};
use lime_sim::{solve_request, SimError};

const L: f64 = 100.0;
const B: f64 = 10.0;
const H: f64 = 10.0;
const P: f64 = 10.0;

fn cantilever(steps: Vec<Step>) -> Result<lime_sim::Solution, SimError> {
    let mesh = beam(L, B, H, H, ElementKind::Tet10).unwrap();
    let mut holds = Vec::new();
    for (i, p) in mesh.nodes.iter().enumerate() {
        if p[0] <= 1e-8 {
            holds.push(NodeHold {
                node: i,
                hold: Hold::Fixed,
            });
        }
    }
    let mut loads = Vec::new();
    let traction = [0.0, 0.0, -P / (B * H)];
    for face in faces_on_plane(&mesh, 0, L, 1e-8) {
        loads.push(Load::Traction {
            nodes: face.nodes,
            traction,
        });
    }
    let req = Request {
        mesh,
        material: LinearOrthotropic::isotropic(10_000.0, 0.3, 1.2),
        recipe: Recipe::solid(),
        build_axis: [0.0, 0.0, 1.0],
        holds,
        loads,
        steps,
        linear: true,
        gravity: None,
        h_mm: H,
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
    };
    solve_request(&req)
}

fn tip_nodes(solution: &lime_sim::Solution) -> Vec<usize> {
    let mut nodes = HashSet::new();
    for face in faces_on_plane(&solution.mesh, 0, L, 1e-8) {
        nodes.extend(face.nodes);
    }
    let mut out: Vec<usize> = nodes.into_iter().collect();
    out.sort_unstable();
    out
}

fn tip_uz(solution: &lime_sim::Solution) -> f64 {
    let nodes = tip_nodes(solution);
    nodes
        .iter()
        .map(|n| solution.displacement[*n][2])
        .sum::<f64>()
        / nodes.len() as f64
}

fn step(factor: f64) -> Step {
    Step {
        factor,
        max_iter: 1,
        tol: 1e-10,
    }
}

#[test]
fn one_step_cantilever_runs() {
    let solution = cantilever(vec![step(1.0)]).unwrap();
    let uz = tip_uz(&solution);
    let down = -uz;
    assert!(
        (0.05..2.0).contains(&down),
        "tip moved {down} mm downward, residual {}",
        solution.residual
    );
    assert!(solution.residual < 1e-8, "residual {}", solution.residual);
    assert_eq!(solution.steps_run, 1);
    assert_eq!(solution.label, "In-house estimate");
    assert_eq!(solution.criterion, "max-stress");
    let summary = solution.summary();
    let json = serde_json::to_value(&summary).unwrap();
    assert!(json.get("triangles").is_none());
    assert!(json.get("displacement").is_none());
    assert_eq!(json["label"], "In-house estimate");
    assert!(json["trust"]["relativeEnergyError"]
        .as_f64()
        .unwrap()
        .is_finite());
}

#[test]
fn a_zero_second_factor_does_not_move_the_tip() {
    let once = cantilever(vec![step(1.0)]).unwrap();
    let twice = cantilever(vec![step(1.0), step(0.0)]).unwrap();
    assert_eq!(twice.steps_run, 2);
    let mut worst: f64 = 0.0;
    for i in 0..once.displacement.len() {
        for k in 0..3 {
            worst = worst.max((once.displacement[i][k] - twice.displacement[i][k]).abs());
        }
    }
    assert!(worst < 1e-8, "second step moved a node by {worst} mm");
}

#[test]
fn split_factors_match_one_step() {
    let once = cantilever(vec![step(1.0)]).unwrap();
    let from_zero = cantilever(vec![step(0.0), step(1.0)]).unwrap();
    let halves = cantilever(vec![step(0.5), step(0.5)]).unwrap();
    for (name, other) in [("zero then one", &from_zero), ("two halves", &halves)] {
        let mut worst: f64 = 0.0;
        for i in 0..once.displacement.len() {
            for k in 0..3 {
                worst = worst.max((once.displacement[i][k] - other.displacement[i][k]).abs());
            }
        }
        assert!(worst < 1e-8, "{name} differed by {worst} mm");
    }
}

#[test]
fn an_unheld_part_is_refused() {
    let mesh = beam(L, B, H, H, ElementKind::Tet10).unwrap();
    let req = Request {
        mesh,
        material: LinearOrthotropic::isotropic(10_000.0, 0.3, 1.2),
        recipe: Recipe::solid(),
        build_axis: [0.0, 0.0, 1.0],
        holds: Vec::new(),
        loads: vec![Load::Force {
            node: 0,
            force: [0.0, 0.0, -1.0],
        }],
        steps: vec![step(1.0)],
        linear: true,
        gravity: None,
        h_mm: H,
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
    };
    let err = solve_request(&req).unwrap_err();
    assert_eq!(
        err.message,
        "This part is not held. Fix a face, or the bed."
    );
}

#[test]
fn modal_refuses_before_a_missing_hold_would() {
    let mesh = beam(L, B, H, H, ElementKind::Tet10).unwrap();
    let mut req = Request {
        mesh,
        material: LinearOrthotropic::isotropic(10_000.0, 0.3, 1.2),
        recipe: Recipe::solid(),
        build_axis: [0.0, 0.0, 1.0],
        holds: Vec::new(),
        loads: Vec::new(),
        steps: vec![step(1.0)],
        linear: true,
        gravity: None,
        h_mm: H,
        allow_linear_tets: false,
        analysis: "modal".into(),
        temperature_c: None,
        fibre_axis: None,
        solver: "faer-ldlt".into(),
        representation: "smear".into(),
        post_steps: Vec::new(),
        provisional: false,
        cancel: None,
        on_progress: None,
    };
    assert_eq!(
        solve_request(&req).unwrap_err().message,
        "Modal analysis is not in this version."
    );
    req.analysis = "static".into();
    req.temperature_c = Some(20.0);
    assert_eq!(
        solve_request(&req).unwrap_err().message,
        "Temperature is not in this version."
    );
}

#[test]
fn cancel_between_factor_and_recovery() {
    let mesh = beam(L, B, H, H, ElementKind::Tet10).unwrap();
    let mut holds = Vec::new();
    for (i, p) in mesh.nodes.iter().enumerate() {
        if p[0] <= 1e-8 {
            holds.push(NodeHold {
                node: i,
                hold: Hold::Fixed,
            });
        }
    }
    let req = Request {
        mesh,
        material: LinearOrthotropic::isotropic(10_000.0, 0.3, 1.2),
        recipe: Recipe::solid(),
        build_axis: [0.0, 0.0, 1.0],
        holds,
        loads: vec![Load::Force {
            node: 0,
            force: [0.0, 0.0, -1.0],
        }],
        steps: vec![step(1.0)],
        linear: true,
        gravity: None,
        h_mm: H,
        allow_linear_tets: false,
        analysis: "static".into(),
        temperature_c: None,
        fibre_axis: None,
        solver: "faer-ldlt".into(),
        representation: "smear".into(),
        post_steps: Vec::new(),
        provisional: false,
        cancel: Some(Arc::new(AtomicBool::new(true))),
        on_progress: None,
    };
    assert_eq!(
        solve_request(&req).unwrap_err().message,
        "The solve was cancelled."
    );
}

#[test]
fn a_post_step_is_refused() {
    let mesh = beam(20.0, 10.0, 10.0, 10.0, ElementKind::Tet4).unwrap();
    let mut holds = Vec::new();
    for i in 0..mesh.nodes.len() {
        holds.push(NodeHold {
            node: i,
            hold: Hold::Fixed,
        });
    }
    let req = Request {
        mesh,
        material: LinearOrthotropic::isotropic(1000.0, 0.25, 1.0),
        recipe: Recipe::solid(),
        build_axis: [0.0, 0.0, 1.0],
        holds,
        loads: Vec::new(),
        steps: vec![step(1.0)],
        linear: true,
        gravity: None,
        h_mm: 10.0,
        allow_linear_tets: true,
        analysis: "static".into(),
        temperature_c: None,
        fibre_axis: None,
        solver: "faer-ldlt".into(),
        representation: "smear".into(),
        post_steps: vec![serde_json::json!({"kind": "buckling"})],
        provisional: false,
        cancel: None,
        on_progress: None,
    };
    assert_eq!(
        solve_request(&req).unwrap_err().message,
        "A post-step is not in this version."
    );
}

#[test]
fn over_the_node_cap_is_refused() {
    let mut mesh = beam(10.0, 10.0, 10.0, 10.0, ElementKind::Tet10).unwrap();
    mesh.nodes.resize(200_001, [0.0; 3]);
    let req = Request {
        mesh,
        material: LinearOrthotropic::isotropic(1000.0, 0.25, 1.0),
        recipe: Recipe::solid(),
        build_axis: [0.0, 0.0, 1.0],
        holds: Vec::new(),
        loads: Vec::new(),
        steps: vec![step(1.0)],
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
    };
    assert_eq!(
        solve_request(&req).unwrap_err().message,
        "This mesh has 200001 nodes. Raise the edge length, or the cap."
    );
}
