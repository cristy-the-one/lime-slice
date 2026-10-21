//! Cantilever. Tip deflection and root bending stress are the beam formulas
//! written below. The stored rows lock the finite-element numbers; the
//! tolerances against the formulas are the accuracy bar.
//!
//! δ = P L³ / (3 E I) + (3/2) P L / (A G)
//! σ(x, z) = P (L − x) (z − h/2) / I
//! I = b h³ / 12, G = E / (2 (1 + ν))
//!
//! (6/5) is the work-equivalent shear factor: an average over the section.
//! The neutral-axis displacement of a rectangle is (3/2) P L / (A G). The
//! tip node sits on that axis, so the reference uses 3/2. With (6/5) the
//! same node crosses the formula and the apparent order collapses.
//!
//! The formula clamps the section: no translation, no rotation. It does not
//! set the transverse displacement to zero over the whole root face. That
//! extra constraint blocks Poisson expansion. The root face is held in x.
//! The section centre is held in y and z, and one mid-height node is held
//! in z so the section cannot roll. Bending stress is read at mid-span,
//! where the support layer has died out.

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
    // Neutral-axis shear factor for a rectangle, not the 6/5 average.
    let shear = 1.5 * P * L / (B * H * g);
    bending + shear
}

/// Beam-theory clamp. `ux = 0` on the root face, the centre pinned in y and z,
/// and one other mid-height node pinned in z.
fn beam_clamp(mesh: &lime_sim::Mesh) -> Vec<NodeHold> {
    let mut holds = Vec::new();
    let mut centre: Option<usize> = None;
    let mut centre_d = f64::INFINITY;
    let mut roll: Option<usize> = None;
    let mut roll_d = f64::INFINITY;
    for (i, p) in mesh.nodes.iter().enumerate() {
        if p[0] > 1e-8 {
            continue;
        }
        holds.push(NodeHold {
            node: i,
            hold: Hold::Axis {
                axis: 0,
                value: 0.0,
            },
        });
        let dc = (p[1] - 0.5 * B).powi(2) + (p[2] - 0.5 * H).powi(2);
        if dc < centre_d {
            centre_d = dc;
            centre = Some(i);
        }
        if p[1] < 0.5 * B - 1e-6 {
            let dr = p[1] * p[1] + (p[2] - 0.5 * H).powi(2);
            if dr < roll_d {
                roll_d = dr;
                roll = Some(i);
            }
        }
    }
    let centre = centre.expect("a node on the root");
    holds.push(NodeHold {
        node: centre,
        hold: Hold::Axis {
            axis: 1,
            value: 0.0,
        },
    });
    holds.push(NodeHold {
        node: centre,
        hold: Hold::Axis {
            axis: 2,
            value: 0.0,
        },
    });
    holds.push(NodeHold {
        node: roll.expect("a second root node"),
        hold: Hold::Axis {
            axis: 2,
            value: 0.0,
        },
    });
    holds
}

fn analytic_stress(x: f64, z: f64) -> f64 {
    P * (L - x) * (z - 0.5 * H) / inertia()
}

fn solve(edge: f64, kind: ElementKind) -> Solution {
    let mesh = beam(L, B, H, edge, kind).unwrap();
    let holds = beam_clamp(&mesh);
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
        cells: Vec::new(),
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

fn metrics(solution: &Solution) -> Metrics {
    let mut tip_i = 0;
    let mut tip_d = f64::INFINITY;
    let target = [L, 0.5 * B, 0.5 * H];
    for (i, p) in solution.mesh.nodes.iter().enumerate() {
        let d = p
            .iter()
            .zip(target)
            .map(|(a, b)| (a - b) * (a - b))
            .sum::<f64>();
        if d < tip_d {
            tip_d = d;
            tip_i = i;
        }
    }
    let tip_down = -solution.displacement[tip_i][2];
    let tip_rel = (tip_down - analytic_tip()) / analytic_tip();

    let target_s = [0.5 * L, 0.5 * B, H];
    let mut best: Option<(f64, [f64; 3], f64)> = None;
    for sample in &solution.gauss {
        let p = sample.xyz;
        let d = (p[0] - target_s[0]).powi(2)
            + (p[1] - target_s[1]).powi(2)
            + (p[2] - target_s[2]).powi(2);
        if best.map(|(s, _, _)| d < s).unwrap_or(true) {
            best = Some((d, p, sample.stress[0]));
        }
    }
    let (_, sample, stress) = best.expect("a gauss point near mid-span");
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
        "{label}: nodes {} tip {:.8} rel {:.6} stress {:.6} rel {:.6} at ({:.3},{:.3},{:.3}) energy {:.6} peak {:.6} trust {}",
        m.nodes,
        m.tip_down,
        m.tip_rel,
        m.stress,
        m.stress_rel,
        m.sample[0],
        m.sample[1],
        m.sample[2],
        m.energy,
        m.peak,
        m.trust
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
    let coarse = metrics(&solve(H, ElementKind::Tet10));
    let mid = metrics(&solve(H / 2.0, ElementKind::Tet10));
    let tet4 = metrics(&solve(H / 2.0, ElementKind::Tet4));
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
    assert!(mid.energy < coarse.energy, "the energy error falls with h");
    // The local error at the clamped corner is not monotone on this pair. Both
    // quadratic meshes stay inside the converged band, and the trust word does not get worse.
    assert!(
        coarse.peak < 0.05 && mid.peak < 0.05,
        "peak {} then {}",
        coarse.peak,
        mid.peak
    );
    assert_eq!(tet4.trust, "rough", "TET4 stays rough");
    assert!(coarse.energy.is_finite() && coarse.energy > 0.0);
    assert!(mid.energy.is_finite());
    assert!(
        coarse.tip_rel.abs() < 0.005,
        "coarse tip {}",
        coarse.tip_rel
    );
    assert!(mid.tip_rel.abs() < 0.002, "mid tip {}", mid.tip_rel);
    assert!(
        mid.tip_rel.abs() < coarse.tip_rel.abs() * 0.5,
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
        coarse.stress_rel.abs() < 0.02,
        "stress {}",
        coarse.stress_rel
    );
    assert!(
        mid.stress_rel.abs() < coarse.stress_rel.abs(),
        "mid stress {} coarse {}",
        mid.stress_rel,
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
    let fine = metrics(&solve(H / 4.0, ElementKind::Tet10));
    report("tet10 h/4", &fine);
    let mid = metrics(&solve(H / 2.0, ElementKind::Tet10));
    let order = (mid.tip_rel.abs() / fine.tip_rel.abs()).ln() / 2.0_f64.ln();
    eprintln!("observed order on the last pair {order:.6}");
    lock("tet10-h4", &fine);
    common::near_abs(
        order,
        common::number(row, "observedOrder"),
        5e-4,
        "observed order",
    );
    assert!(fine.tip_rel.abs() < mid.tip_rel.abs());
}
