//! Quarter annulus, outer radius ten hole radii, remote tension σ.
//! Kirsch's infinite plate gives σ_xx = 3σ at the flank r = a, θ = π/2.
//! A finite plate sits a little above 3. The flank value has to move toward
//! 3 as the hole edge is halved twice. No handbook table is copied.

#![allow(clippy::needless_range_loop)]

mod common;

use std::f64::consts::PI;

use lime_sim::assemble::{Hold, Load, NodeHold};
use lime_sim::element::ElementKind;
use lime_sim::material::LinearOrthotropic;
use lime_sim::mesh::{boundary_faces, cylindrical_mid, mapped_grid};
use lime_sim::recipe::Recipe;
use lime_sim::study::Step;
use lime_sim::Solution;

const A: f64 = 10.0;
const R: f64 = 100.0;
const SIGMA: f64 = 1.0;
const THICK: f64 = 2.0;

fn mesh(nr: usize, nt: usize) -> lime_sim::Mesh {
    let angle = PI / 2.0;
    mapped_grid(
        [nr, nt, 1],
        ElementKind::Tet10,
        move |i, j, k| {
            let radius = A + (R - A) * i as f64 / nr as f64;
            let th = angle * j as f64 / nt as f64;
            [radius * th.cos(), radius * th.sin(), THICK * k as f64]
        },
        cylindrical_mid,
    )
    .unwrap()
}

fn radius(p: [f64; 3]) -> f64 {
    (p[0] * p[0] + p[1] * p[1]).sqrt()
}

fn solve(nr: usize, nt: usize) -> Solution {
    let mesh = mesh(nr, nt);
    let mut holds = Vec::new();
    for (i, p) in mesh.nodes.iter().enumerate() {
        holds.push(NodeHold {
            node: i,
            hold: Hold::Axis {
                axis: 2,
                value: 0.0,
            },
        });
        if p[1].abs() <= 1e-7 {
            holds.push(NodeHold {
                node: i,
                hold: Hold::Axis {
                    axis: 1,
                    value: 0.0,
                },
            });
        }
        if p[0].abs() <= 1e-7 {
            holds.push(NodeHold {
                node: i,
                hold: Hold::Axis {
                    axis: 0,
                    value: 0.0,
                },
            });
        }
    }
    let mut loads = Vec::new();
    for face in boundary_faces(&mesh) {
        let corners: Vec<[f64; 3]> = face.nodes.iter().take(3).map(|n| mesh.nodes[*n]).collect();
        if corners.iter().all(|p| (radius(*p) - R).abs() < 1e-6) {
            let th = face.centroid[1].atan2(face.centroid[0]);
            loads.push(Load::Traction {
                nodes: face.nodes.clone(),
                traction: [SIGMA * th.cos(), 0.0, 0.0],
            });
        }
    }
    lime_sim::solve_request(&lime_sim::study::Request {
        mesh,
        material: LinearOrthotropic::isotropic(1000.0, 0.3, 1.0),
        recipe: Recipe::solid(),
        build_axis: [0.0, 0.0, 1.0],
        holds,
        loads,
        steps: vec![Step {
            factor: 1.0,
            max_iter: 1,
            tol: 1e-10,
        }],
        linear: true,
        gravity: None,
        h_mm: A * (PI / 2.0) / nt as f64,
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
    .unwrap_or_else(|err| panic!("{}", err.message))
}

fn flank(solution: &Solution) -> f64 {
    let target = [0.0, A, THICK / 2.0];
    let mut best = f64::INFINITY;
    let mut stress = 0.0;
    for sample in &solution.gauss {
        let d = sample
            .xyz
            .iter()
            .zip(target)
            .map(|(a, b)| (a - b) * (a - b))
            .sum::<f64>();
        if d < best {
            best = d;
            stress = sample.stress[0];
        }
    }
    stress / SIGMA
}

#[test]
fn flank_stress_moves_toward_three() {
    let doc = common::load("kirsch.json");
    let cases = [
        (6_usize, 4_usize, "nr6-nt4"),
        (12, 8, "nr12-nt8"),
        (24, 16, "nr24-nt16"),
    ];
    let mut kt = Vec::new();
    let mut trust = Vec::new();
    for (nr, nt, id) in cases {
        let solution = solve(nr, nt);
        let k = flank(&solution);
        let edge = A * (PI / 2.0) / nt as f64;
        eprintln!(
            "kirsch nr={nr} nt={nt} edge={edge:.3} nodes={} Kt={k:.4} energy={:.4}",
            solution.mesh.nodes.len(),
            solution.relative_energy_error
        );
        let row = &doc["rows"][id];
        assert_eq!(
            solution.mesh.nodes.len(),
            row["nodes"].as_u64().unwrap() as usize
        );
        common::near_abs(edge, common::number(row, "edgeMm"), 6e-4, id);
        common::near_abs(k, common::number(row, "kt"), 1e-4, id);
        common::near_abs((k - 3.0).abs(), common::number(row, "gapTo3"), 1e-4, id);
        common::near_abs(
            solution.relative_energy_error,
            common::number(row, "relativeEnergyError"),
            1e-4,
            id,
        );
        common::near_abs(
            solution.peak_relative_error,
            common::number(row, "peakRelativeError"),
            1e-4,
            id,
        );
        assert_eq!(
            solution.trust.as_str(),
            row["trust"].as_str().unwrap(),
            "{id} trust"
        );
        trust.push(solution.trust);
        kt.push(k);
    }
    for k in &kt {
        assert!(*k > 2.0 && *k < 5.0, "Kt {k}");
    }
    // A flank stress more than 5% below the finest mesh's is not converged, however small the global error.
    for (k, level) in kt.iter().zip(&trust) {
        if (kt[2] - k) / kt[2] > 0.05 {
            assert_ne!(
                *level,
                lime_sim::trust::TrustLevel::Converged,
                "Kt {k} against {}",
                kt[2]
            );
        }
    }
    let e0 = (kt[0] - 3.0).abs();
    let e2 = (kt[2] - 3.0).abs();
    assert!(e2 < e0, "coarse {} fine {}", kt[0], kt[2]);
}
