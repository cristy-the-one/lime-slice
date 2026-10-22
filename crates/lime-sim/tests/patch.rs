#![allow(clippy::needless_range_loop)]

//! Constant-stress patch. The expected stress is written here, from λ and μ,
//! so a bug shared with the element matrix cannot mark itself correct.
//!
//! u = 0.01 x + 0.002 y − 0.003 z
//! v = −0.004 x + 0.02 y + 0.001 z
//! w = 0.005 x − 0.002 y + 0.015 z
//! E = 1000, ν = 0.25, so λ = μ = 400.
//! strain = [0.01, 0.02, 0.015, −0.002, −0.001, 0.002]
//! stress = λ tr(ε) I + 2 μ ε, with engineering shear, which is
//! [26, 34, 30, −0.8, −0.4, 0.8].

use lime_sim::assemble::{Hold, NodeHold};
use lime_sim::element::ElementKind;
use lime_sim::material::LinearOrthotropic;
use lime_sim::mesh::{interior_nodes, patch_mesh};
use lime_sim::recipe::Recipe;
use lime_sim::solve_request;
use lime_sim::study::Request;
use lime_sim::trust::TrustLevel;

const PARENT: [[f64; 3]; 4] = [
    [0.0, 0.0, 0.0],
    [2.0, 0.15, 0.1],
    [0.2, 1.8, 0.05],
    [0.3, 0.25, 1.7],
];

const EXPECTED_STRESS: [f64; 6] = [26.0, 34.0, 30.0, -0.8, -0.4, 0.8];

fn field(p: [f64; 3]) -> [f64; 3] {
    let [x, y, z] = p;
    [
        0.01 * x + 0.002 * y - 0.003 * z,
        -0.004 * x + 0.02 * y + 0.001 * z,
        0.005 * x - 0.002 * y + 0.015 * z,
    ]
}

fn request(kind: ElementKind, interior: bool) -> Request {
    let mesh = patch_mesh(kind, interior).unwrap();
    let interior_ids = interior_nodes(&mesh, &PARENT);
    let mut holds = Vec::new();
    for (i, p) in mesh.nodes.iter().enumerate() {
        if interior_ids.contains(&i) {
            continue;
        }
        let u = field(*p);
        for axis in 0..3 {
            holds.push(NodeHold {
                node: i,
                hold: Hold::Axis {
                    axis,
                    value: u[axis],
                },
            });
        }
    }
    Request {
        mesh,
        material: LinearOrthotropic::isotropic(1000.0, 0.25, 1.0),
        recipe: Recipe::solid(),
        build_axis: [0.0, 0.0, 1.0],
        holds,
        loads: Vec::new(),
        steps: vec![lime_sim::study::Step {
            factor: 1.0,
            max_iter: 1,
            tol: 1e-12,
        }],
        linear: true,
        gravity: None,
        h_mm: 0.0,
        allow_linear_tets: true,
        analysis: "static".into(),
        temperature_c: None,
        fibre_axis: None,
        solver: "faer-ldlt".into(),
        representation: "smear".into(),
        cells: Vec::new(),
        beads: None,
        post_steps: Vec::new(),
        provisional: false,
        cancel: None,
        on_progress: None,
    }
}

fn assert_stress(kind: ElementKind, interior: bool) {
    let req = request(kind, interior);
    let interior_ids = interior_nodes(&req.mesh, &PARENT);
    let solution = solve_request(&req).unwrap_or_else(|err| panic!("{}", err.message));
    assert!(!solution.gauss.is_empty());
    for sample in &solution.gauss {
        for k in 0..6 {
            let rel = (sample.stress[k] - EXPECTED_STRESS[k]).abs() / EXPECTED_STRESS[k].abs();
            assert!(
                rel < 1e-9,
                "{kind:?} interior={interior} component {k}: got {} expected {} relative {rel}",
                sample.stress[k],
                EXPECTED_STRESS[k]
            );
        }
    }
    for i in interior_ids {
        let got = solution.displacement[i];
        let expect = field(req.mesh.nodes[i]);
        for k in 0..3 {
            let scale = expect[k].abs().max(1e-6);
            let rel = (got[k] - expect[k]).abs() / scale;
            assert!(
                rel < 1e-8,
                "interior node {i} component {k}: got {} expected {}",
                got[k],
                expect[k]
            );
        }
    }
    assert!(
        solution.relative_energy_error < 1e-8,
        "constant stress should estimate as zero, got {}",
        solution.relative_energy_error
    );
    assert_eq!(solution.label, "In-house estimate");
}

#[test]
fn single_tet4_matches_the_analytic_stress() {
    assert_stress(ElementKind::Tet4, false);
}

#[test]
fn single_tet10_matches_the_analytic_stress() {
    assert_stress(ElementKind::Tet10, false);
}

#[test]
fn interior_tet4_matches_the_analytic_stress() {
    assert_stress(ElementKind::Tet4, true);
}

#[test]
fn interior_tet10_matches_the_analytic_stress() {
    assert_stress(ElementKind::Tet10, true);
}

/// The patch is inside the converged band. A provisional card still forces rough.
#[test]
fn a_provisional_card_forces_rough() {
    let mut req = request(ElementKind::Tet10, false);
    let plain = solve_request(&req).unwrap_or_else(|err| panic!("{}", err.message));
    assert!(plain.relative_energy_error < 0.05);
    assert_ne!(plain.trust, TrustLevel::Rough);
    req.provisional = true;
    let solution = solve_request(&req).unwrap_or_else(|err| panic!("{}", err.message));
    assert_eq!(solution.trust, TrustLevel::Rough);
    assert!(solution
        .notes
        .iter()
        .any(|note| note == "Provisional card, not a measurement."));
}
