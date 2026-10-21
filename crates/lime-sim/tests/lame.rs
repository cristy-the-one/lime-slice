//! Open-ended thick cylinder, a wedge with symmetry on both cut faces.
//!
//! σ_r(r) = a² p / (b² − a²) · (1 − b² / r²)
//! σ_θ(r) = a² p / (b² − a²) · (1 + b² / r²)
//! At r = a, σ_r = −p and σ_θ = p (a² + b²) / (b² − a²).

#![allow(clippy::needless_range_loop)]

mod common;

use lime_sim::assemble::{Hold, Load, NodeHold};
use lime_sim::element::ElementKind;
use lime_sim::material::LinearOrthotropic;
use lime_sim::mesh::{boundary_faces, cylindrical_mid, mapped_grid};
use lime_sim::recipe::Recipe;
use lime_sim::study::{Request, Step};
use lime_sim::units::{cross, normalize};
use lime_sim::Solution;

const A: f64 = 10.0;
const B: f64 = 20.0;
const P: f64 = 10.0;
const ALPHA: f64 = 0.2;
const THICK: f64 = 4.0;

fn radius(p: [f64; 3]) -> f64 {
    (p[0] * p[0] + p[1] * p[1]).sqrt()
}

fn lame(r: f64) -> (f64, f64) {
    let factor = A * A * P / (B * B - A * A);
    let radial = factor * (1.0 - B * B / (r * r));
    let hoop = factor * (1.0 + B * B / (r * r));
    (radial, hoop)
}

fn solve() -> Solution {
    let nr = 4;
    let nz = 2;
    let mesh = mapped_grid(
        [nr, 1, nz],
        ElementKind::Tet10,
        |i, j, k| {
            let r = A + (B - A) * i as f64 / nr as f64;
            let th = ALPHA * j as f64;
            [r * th.cos(), r * th.sin(), THICK * k as f64 / nz as f64]
        },
        cylindrical_mid,
    )
    .unwrap();
    let n = normalize([-ALPHA.sin(), ALPHA.cos(), 0.0]).unwrap();
    let ez = [0.0, 0.0, 1.0];
    let er = cross(n, ez);
    let q = [
        [n[0], er[0], ez[0]],
        [n[1], er[1], ez[1]],
        [n[2], er[2], ez[2]],
    ];
    let mut holds = Vec::new();
    let mut pin = None;
    for (i, p) in mesh.nodes.iter().enumerate() {
        let ang = p[1].atan2(p[0]);
        if p[1].abs() <= 1e-7 {
            holds.push(NodeHold {
                node: i,
                hold: Hold::Axis {
                    axis: 1,
                    value: 0.0,
                },
            });
            if p[2].abs() <= 1e-8 && pin.is_none() {
                pin = Some(i);
            }
        } else if (ang - ALPHA).abs() <= 1e-6 {
            holds.push(NodeHold {
                node: i,
                hold: Hold::Frame {
                    q,
                    prescribed: [Some(0.0), None, None],
                },
            });
        }
    }
    let pin = pin.expect("a node on the θ = 0 face");
    holds.push(NodeHold {
        node: pin,
        hold: Hold::Axis {
            axis: 2,
            value: 0.0,
        },
    });
    let mut loads = Vec::new();
    for face in boundary_faces(&mesh) {
        let corners: Vec<[f64; 3]> = face.nodes.iter().take(3).map(|n| mesh.nodes[*n]).collect();
        if corners.iter().all(|p| (radius(*p) - A).abs() < 1e-6) {
            let traction = [
                -P * face.normal[0],
                -P * face.normal[1],
                -P * face.normal[2],
            ];
            loads.push(Load::Traction {
                nodes: face.nodes,
                traction,
            });
        }
    }
    lime_sim::solve_request(&Request {
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
        h_mm: (B - A) / nr as f64,
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

fn sample_inner(solution: &Solution) -> (f64, f64, f64) {
    let mut best = f64::INFINITY;
    let mut picked = (0.0, 0.0, 0.0);
    for sample in &solution.gauss {
        let r = radius(sample.xyz);
        let ang = sample.xyz[1].atan2(sample.xyz[0]);
        let score =
            (r - A).abs() + 2.0 * (ang - 0.5 * ALPHA).abs() + (sample.xyz[2] - 0.5 * THICK).abs();
        if score < best {
            best = score;
            let c = ang.cos();
            let s = ang.sin();
            let xx = sample.stress[0];
            let yy = sample.stress[1];
            let xy = sample.stress[3];
            let radial = xx * c * c + yy * s * s + 2.0 * xy * s * c;
            let hoop = xx * s * s + yy * c * c - 2.0 * xy * s * c;
            picked = (r, radial, hoop);
        }
    }
    picked
}

#[test]
fn inner_hoop_matches_lame_on_a_coarse_wedge() {
    let (at_a_r, at_a_h) = lame(A);
    assert!((at_a_r + P).abs() < 1e-9);
    assert!((at_a_h - 50.0 / 3.0).abs() < 1e-9);
    let solution = solve();
    let (r, radial, hoop) = sample_inner(&solution);
    let doc_trust = common::load("lame.json");
    assert_ne!(
        solution.trust.as_str(),
        "rough",
        "Lamé stays at least usable on its coarsest wedge"
    );
    assert_eq!(
        solution.trust.as_str(),
        doc_trust["trust"].as_str().unwrap()
    );
    common::near_abs(
        solution.peak_relative_error,
        common::number(&doc_trust, "peakRelativeError"),
        1e-4,
        "lame peak",
    );
    let (expect_r, expect_h) = lame(r);
    eprintln!(
        "lame r={r:.4} σr={radial:.4} (formula {expect_r:.4}, surface {}) σθ={hoop:.4} (formula {expect_h:.4}, surface {at_a_h:.4}) energy={:.4} nodes={}",
        -P,
        solution.relative_energy_error,
        solution.mesh.nodes.len()
    );
    let rel_h = (hoop - expect_h).abs() / expect_h.abs();
    let rel_r = (radial - expect_r).abs() / expect_r.abs().max(1.0);
    assert!(rel_h < 0.05, "hoop relative {rel_h}");
    assert!(rel_r < 0.15, "radial relative {rel_r}");
    let surface = (hoop - at_a_h).abs() / at_a_h;
    assert!(surface < 0.08, "inner-radius hoop gap {surface}");

    let row = common::load("lame.json");
    assert_eq!(
        solution.mesh.nodes.len(),
        row["nodes"].as_u64().unwrap() as usize
    );
    common::near_abs(r, common::number(&row, "sampleRMm"), 1e-4, "sample r");
    common::near_abs(radial, common::number(&row, "sigmaRadialMPa"), 1e-4, "σr");
    common::near_abs(hoop, common::number(&row, "sigmaHoopMPa"), 1e-4, "σθ");
    common::near_abs(
        expect_r,
        common::number(&row, "formulaRadialAtSampleMPa"),
        1e-4,
        "formula σr",
    );
    common::near_abs(
        expect_h,
        common::number(&row, "formulaHoopAtSampleMPa"),
        1e-4,
        "formula σθ",
    );
    common::near_abs(
        solution.relative_energy_error,
        common::number(&row, "relativeEnergyError"),
        1e-4,
        "energy",
    );
}
