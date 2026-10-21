//! Cantilever. Tip deflection and root bending stress are the beam formulas
//! written below. The stored rows lock the finite-element numbers; the
//! tolerances against the formulas are the accuracy bar.
//!
//! δ = P L³ / (3 E I) + (6/5) P L / (A G)
//! σ(x, z) = P (L − x) (z − h/2) / I
//! I = b h³ / 12, G = E / (2 (1 + ν))

#![allow(clippy::needless_range_loop)]

mod common;

use lime_sim::assemble::{Hold, Load, NodeHold};
use lime_sim::element::ElementKind;
use lime_sim::material::LinearOrthotropic;
use lime_sim::mesh::{beam, faces_on_plane};
use lime_sim::recipe::Recipe;
use lime_sim::study::{Request, Step};
use lime_sim::{solve_request, Solution};

const L: f64 = 100.0;
const B: f64 = 10.0;
const H: f64 = 10.0;
const E: f64 = 10_000.0;
const NU: f64 = 0.3;
const P: f64 = 10.0;

fn inertia() -> f64 {
    B * H * H * H / 12.0
}

fn analytic_tip() -> f64 {
    let i = inertia();
    let g = E / (2.0 * (1.0 + NU));
    let bending = P * L * L * L / (3.0 * E * i);
    let shear = 1.2 * P * L / (B * H * g);
    bending + shear
}

fn analytic_stress(x: f64, z: f64) -> f64 {
    P * (L - x) * (z - 0.5 * H) / inertia()
}

fn solve(edge: f64, kind: ElementKind) -> Solution {
    let mesh = beam(L, B, H, edge, kind).unwrap();
    let mut holds = Vec::new();
    for (i, p) in mesh.nodes.iter().enumerate() {
        if p[0] <= 1e-8 {
            holds.push(NodeHold {
                node: i,
                hold: Hold::Fixed,
            });
        }
    }
    let traction = [0.0, 0.0, -P / (B * H)];
    let mut loads = Vec::new();
    for face in faces_on_plane(&mesh, 0, L, 1e-6) {
        loads.push(Load::Traction {
            nodes: face.nodes,
            traction,
        });
    }
    solve_request(&Request {
        mesh,
        material: LinearOrthotropic::isotropic(E, NU, 1.2),
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
        h_mm: edge,
        allow_linear_tets: kind == ElementKind::Tet4,
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
    .unwrap_or_else(|err| panic!("{}", err.message))
}

struct Metrics {
    tip_down: f64,
    tip_rel: f64,
    stress: f64,
    stress_rel: f64,
    sample: [f64; 3],
    energy: f64,
    peak: f64,
    trust: &'static str,
    nodes: usize,
}

fn metrics(solution: &Solution, edge: f64) -> Metrics {
    let mut nodes = Vec::new();
    for face in faces_on_plane(&solution.mesh, 0, L, 1e-6) {
        for n in &face.nodes {
            if !nodes.contains(n) {
                nodes.push(*n);
            }
        }
    }
    let tip_uz = nodes
        .iter()
        .map(|n| solution.displacement[*n][2])
        .sum::<f64>()
        / nodes.len() as f64;
    let tip_down = -tip_uz;
    let tip_rel = (tip_down - analytic_tip()) / analytic_tip();

    let mut best: Option<(f64, [f64; 3], f64)> = None;
    for sample in &solution.gauss {
        let p = sample.xyz;
        if p[0] <= 0.05 || p[0] > edge {
            continue;
        }
        let score = p[2] - 0.05 * (p[1] - 0.5 * B).abs();
        if best.map(|(s, _, _)| score > s).unwrap_or(true) {
            best = Some((score, p, sample.stress[0]));
        }
    }
    let (_, sample, stress) = best.expect("a gauss point in the first brick");
    let expect = analytic_stress(sample[0], sample[2]);
    let stress_rel = (stress - expect) / expect;
    Metrics {
        tip_down,
        tip_rel,
        stress,
        stress_rel,
        sample,
        energy: solution.relative_energy_error,
        peak: solution.peak_relative_error,
        trust: solution.trust.as_str(),
        nodes: solution.mesh.nodes.len(),
    }
}

fn report(label: &str, m: &Metrics) {
    eprintln!(
        "{label}: nodes {} tip {:.8} rel {:.6} stress {:.6} rel {:.6} at ({:.3},{:.3},{:.3}) energy {:.6}",
        m.nodes, m.tip_down, m.tip_rel, m.stress, m.stress_rel, m.sample[0], m.sample[1], m.sample[2], m.energy
    );
}

fn lock(id: &str, m: &Metrics) {
    let doc = common::load("cantilever.json");
    let row = &doc["rows"][id];
    assert!(row.is_object(), "missing baseline row {id}");
    assert_eq!(
        m.nodes,
        row["nodes"].as_u64().unwrap() as usize,
        "{id} nodes"
    );
    common::near_abs(
        m.tip_down,
        common::number(row, "tipDownMm"),
        1e-8,
        &format!("{id} tip"),
    );
    common::near_abs(
        m.tip_rel,
        common::number(row, "tipRel"),
        1e-6,
        &format!("{id} tip rel"),
    );
    common::near_abs(
        m.stress,
        common::number(row, "stressMPa"),
        1e-6,
        &format!("{id} stress"),
    );
    common::near_abs(
        m.stress_rel,
        common::number(row, "stressRel"),
        1e-6,
        &format!("{id} stress rel"),
    );
    common::near_abs(
        m.energy,
        common::number(row, "relativeEnergyError"),
        1e-6,
        &format!("{id} energy"),
    );
    common::near_abs(
        m.peak,
        common::number(row, "peakRelativeError"),
        1e-4,
        &format!("{id} peak"),
    );
    assert_eq!(m.trust, row["trust"].as_str().unwrap(), "{id} trust");
    let sample = row["sampleMm"].as_array().expect("sample");
    for k in 0..3 {
        common::near_abs(
            m.sample[k],
            sample[k].as_f64().unwrap(),
            6e-4,
            &format!("{id} sample {k}"),
        );
    }
}

#[test]
fn coarse_and_mid_approach_the_beam_formulas() {
    let coarse = metrics(&solve(H, ElementKind::Tet10), H);
    let mid = metrics(&solve(H / 2.0, ElementKind::Tet10), H / 2.0);
    let tet4 = metrics(&solve(H / 2.0, ElementKind::Tet4), H / 2.0);
    report("tet10 h", &coarse);
    report("tet10 h/2", &mid);
    report("tet4 h/2", &tet4);
    lock("tet10-h", &coarse);
    lock("tet10-h2", &mid);
    lock("tet4-h2", &tet4);
    // The trust word never gets worse as the beam is refined. The root is a clamped corner, a real singularity, so
    // the error at the peak does not reach converged there.
    let rank = |t: &str| {
        ["rough", "usable", "converged"]
            .iter()
            .position(|w| *w == t)
            .unwrap()
    };
    assert!(
        rank(mid.trust) >= rank(coarse.trust),
        "{} then {}",
        coarse.trust,
        mid.trust
    );
    assert!(
        mid.energy < coarse.energy && mid.peak < coarse.peak,
        "the errors fall with h"
    );
    assert_eq!(tet4.trust, "rough", "TET4 stays rough");
    assert!(coarse.energy.is_finite() && coarse.energy > 0.0);
    assert!(mid.energy.is_finite());
    assert!(coarse.tip_rel.abs() < 0.03, "coarse tip {}", coarse.tip_rel);
    assert!(
        mid.tip_rel.abs() < coarse.tip_rel.abs(),
        "mid {} coarse {}",
        mid.tip_rel,
        coarse.tip_rel
    );
    assert!(
        tet4.tip_rel.abs() > coarse.tip_rel.abs(),
        "tet4 {} tet10 {}",
        tet4.tip_rel,
        coarse.tip_rel
    );
    assert!(coarse.stress > 0.0, "top fibre should be in tension");
    assert!(
        coarse.stress_rel.abs() < 0.35,
        "stress {}",
        coarse.stress_rel
    );
}

/// The h/4 factorisation is several minutes in debug. The row is always in
/// the baseline. The solve runs only when `LIME_SIM_FINE=1`, which an
/// `#[ignore]` test would not see unless `--ignored` was passed as well.
#[test]
fn fine_beam_matches_its_baseline_row() {
    let doc = common::load("cantilever.json");
    let row = &doc["rows"]["tet10-h4"];
    assert_eq!(row["fine"], true);
    assert!(row["tipDownMm"].is_number());
    assert!(row["observedOrder"].is_number());
    if std::env::var("LIME_SIM_FINE").ok().as_deref() != Some("1") {
        return;
    }
    let fine = metrics(&solve(H / 4.0, ElementKind::Tet10), H / 4.0);
    report("tet10 h/4", &fine);
    lock("tet10-h4", &fine);
    let mid = metrics(&solve(H / 2.0, ElementKind::Tet10), H / 2.0);
    let order = (mid.tip_rel.abs() / fine.tip_rel.abs()).ln() / 2.0_f64.ln();
    eprintln!("observed order on the last pair {order:.3}");
    common::near_abs(
        order,
        common::number(row, "observedOrder"),
        5e-4,
        "observed order",
    );
    assert!(fine.tip_rel.abs() < mid.tip_rel.abs());
}
