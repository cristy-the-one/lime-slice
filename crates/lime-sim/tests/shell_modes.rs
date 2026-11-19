//! Textbook plates for the shell's natural frequencies. The meshes and the
//! 2 % band are the ones docs/plan-shell-modes.md measured; the tolerances
//! are not loosened.

use std::time::Instant;

use lime_sim::shell::planner::{plan_ribs, Goal, RibPlan, RibPlanRequest};
use lime_sim::shell::{
    cluster_count, IsotropicShell, Rib, RibSide, ShellLoad, ShellMesh, ShellModel, ShellOptions,
    CLUSTER_GAP,
};
use shell_common::{material, rectangle_holds, rigidity, Edge};

#[path = "shell_common/mod.rs"]
mod shell_common;

const RHO: f64 = 1.0e-9;

fn dense(e: f64, nu: f64) -> IsotropicShell {
    material(e, nu).with_density(RHO).unwrap()
}

fn omega_mn(m: u32, n: u32, a: f64, b: f64, d: f64, rho: f64, h: f64) -> f64 {
    let k = (m as f64 / a).powi(2) + (n as f64 / b).powi(2);
    std::f64::consts::PI.powi(2) * k * (d / (rho * h)).sqrt()
}

/// Simply supported 200 × 100 × 1. First four closed-form frequencies, the
/// finest of three meshes inside 2 %.
#[test]
fn simply_supported_rectangle_first_four_modes() {
    let (a, b, h) = (200.0, 100.0, 1.0);
    let mat = dense(2000.0, 0.3);
    let d = rigidity(2000.0, 0.3, h);
    let targets = [
        omega_mn(1, 1, a, b, d, RHO, h),
        omega_mn(2, 1, a, b, d, RHO, h),
        omega_mn(3, 1, a, b, d, RHO, h),
        omega_mn(1, 2, a, b, d, RHO, h),
    ];
    // The study's closed form, so a slipped formula fails before the mesh does.
    let published = [527.975, 844.760, 1372.74, 1795.12];
    for (t, p) in targets.iter().zip(published) {
        assert!(
            (t - p).abs() / p < 5e-4,
            "closed form {t} against the study's {p}"
        );
    }
    println!("simply supported 200x100x1, ω rad/s, error against the closed form");
    let mut finest = [0.0; 4];
    for (nx, ny) in [(8, 4), (16, 8), (32, 16)] {
        let mesh = ShellMesh::rectangle([a, b], [nx, ny], h);
        let holds = rectangle_holds(&mesh, a, b, Edge::Simple);
        let mut model = ShellModel::new(mesh, mat, &holds, ShellOptions::default()).unwrap();
        model.set_threads(1);
        let modes = model.lowest_modes(RHO, 4).unwrap();
        let mut line = format!("{nx:>2}x{ny:<2}");
        for (k, mode) in modes.modes.iter().enumerate() {
            let w = mode.omega2.sqrt();
            let err = (w - targets[k]) / targets[k];
            line.push_str(&format!("  {w:9.3} ({:+7.3}%)", err * 100.0));
            finest[k] = err;
        }
        println!("{line}   eigen {:.4} s", modes.seconds);
    }
    for (k, err) in finest.iter().enumerate() {
        assert!(
            err.abs() <= 0.02,
            "mode {} at 32x16 is {:.3}%, outside 2%",
            k + 1,
            err * 100.0
        );
    }
}

/// Clamped 100 × 100 × 1. Leissa λ₁ = 35.99, finest of three meshes inside 2 %.
#[test]
fn clamped_square_fundamental_against_leissa() {
    let (a, h) = (100.0, 1.0);
    let mat = dense(2000.0, 0.3);
    let d = rigidity(2000.0, 0.3, h);
    let scale = a * a * (RHO * h / d).sqrt();
    println!("clamped square 100x100x1, λ = ω a² √(ρh/D), Leissa 35.99");
    let mut finest = 0.0;
    for n in [8, 16, 32] {
        let mesh = ShellMesh::rectangle([a, a], [n, n], h);
        let holds = rectangle_holds(&mesh, a, a, Edge::Clamped);
        let mut model = ShellModel::new(mesh, mat, &holds, ShellOptions::default()).unwrap();
        model.set_threads(1);
        let modes = model.lowest_modes(RHO, 1).unwrap();
        let lambda = modes.modes[0].omega2.sqrt() * scale;
        let err = (lambda - 35.99) / 35.99;
        println!(
            "{n:>2}x{n:<2}  λ {lambda:8.4} ({:+7.3}%)  {:.1} Hz   eigen {:.4} s",
            err * 100.0,
            modes.modes[0].hz,
            modes.seconds
        );
        finest = err;
    }
    assert!(
        finest.abs() <= 0.02,
        "32x32 is {:.3}%, outside 2%",
        finest * 100.0
    );
}

/// The square's repeated pair. Rotating the two returned vectors must not
/// move the cluster score.
#[test]
fn repeated_pair_cluster_score_is_basis_independent() {
    let (a, h, n) = (100.0, 1.0, 12);
    let mat = dense(2000.0, 0.3);
    let mesh = ShellMesh::rectangle([a, a], [n, n], h);
    let holds = rectangle_holds(&mesh, a, a, Edge::Simple);
    let mut model = ShellModel::new(mesh, mat, &holds, ShellOptions::default()).unwrap();
    model.set_threads(1);
    let modes = model.lowest_modes(RHO, 4).unwrap();
    let w: Vec<f64> = modes.modes.iter().map(|m| m.omega2).collect();
    println!(
        "square n=12 ω² {:.6} {:.6} {:.6} {:.6}",
        w[0], w[1], w[2], w[3]
    );
    // The fundamental is alone. The pair is the next two.
    assert_eq!(
        cluster_count(&w),
        1,
        "the fundamental is not a repeated pair"
    );
    let gap = (w[2] - w[1]).abs() / w[1];
    println!(
        "pair gap {:.4}%, cluster tolerance {:.1}%",
        gap * 100.0,
        CLUSTER_GAP * 100.0
    );
    assert!(
        gap <= CLUSTER_GAP,
        "the pair split by more than the cluster gap"
    );
    assert!(
        cluster_count(&w[1..]) >= 2,
        "the pair is not gathered as one cluster"
    );
    let pair = vec![modes.modes[1].vector.clone(), modes.modes[2].vector.clone()];
    let rib = centre_rib(a, n);
    let score = model.cluster_shift(&rib, &pair, RHO).unwrap();
    let (c, s) = (0.6, 0.8);
    let rotated = vec![
        pair[0]
            .iter()
            .zip(&pair[1])
            .map(|(p, q)| c * p + s * q)
            .collect(),
        pair[0]
            .iter()
            .zip(&pair[1])
            .map(|(p, q)| -s * p + c * q)
            .collect(),
    ];
    let again = model.cluster_shift(&rib, &rotated, RHO).unwrap();
    println!("cluster lower Δ(ω²) {score:.9} rotated {again:.9}");
    let scale = score.abs().max(1.0);
    assert!(
        (score - again).abs() <= 1e-9 * scale,
        "rotated score {again} differs from {score}"
    );
}

#[test]
fn a_frequency_goal_names_itself_when_it_refuses() {
    let mesh = ShellMesh::rectangle([40.0, 20.0], [4, 2], 2.0);
    let mut req = RibPlanRequest::new(mesh, material(2000.0, 0.3));
    req.goal = Goal::Frequency { factor: 1.3 };
    let err = plan_ribs(&req).unwrap_err().to_string();
    assert!(
        err.contains("frequency goal") && err.contains("density"),
        "{err}"
    );
    req.material = dense(2000.0, 0.3);
    req.goal = Goal::Frequency { factor: 0.5 };
    let err = plan_ribs(&req).unwrap_err().to_string();
    assert!(err.contains("frequency goal"), "{err}");
    // The goal is one variant. A frequency request has no budget to set
    // beside it, which is how a conflicting goal is refused today.
    assert!(!format!("{:?}", Goal::Frequency { factor: 1.3 }).contains("volume"));
}

/// Clamped 120 × 70 × 2 at the planner's 5 mm pitch. Reaches ×1.3, and
/// under the study's point load beats an equal volume of compliance ribs.
#[test]
fn frequency_plan_reaches_1_3_and_beats_compliance_ribs() {
    let mesh = ShellMesh::rectangle([120.0, 70.0], [24, 14], 2.0);
    let mat = dense(2000.0, 0.3);
    let node = nearest(&mesh, [15.0, 35.0, 0.0]);
    let point = vec![vec![ShellLoad::Force {
        node,
        force: [0.0, 0.0, -10.0],
    }]];

    let mut freq = RibPlanRequest::new(mesh.clone(), mat);
    freq.goal = Goal::Frequency { factor: 1.3 };
    freq.load_cases = point.clone();
    freq.options.baselines = false;
    let t = Instant::now();
    let plan = plan_ribs(&freq).unwrap();
    let freq_s = t.elapsed().as_secs_f64();
    let hz = plan.frequency_hz.expect("a frequency result");
    println!(
        "frequency plan: bare {:.3} Hz, ribbed {:.3} Hz, ×{:.4} frequency, ×{:.4} stiffness, volume {:.2} mm³, {:.2} s, goal_met {}",
        hz.bare,
        hz.ribbed,
        plan.frequency_factor.unwrap(),
        plan.stiffness_factor,
        plan.rib_volume_mm3,
        freq_s,
        plan.goal_met
    );
    println!("notes: {:?}", plan.notes);
    assert!(
        plan.notes.iter().any(|n| n.contains("ignored")),
        "the result should say the loads are ignored"
    );
    assert!(
        plan.frequency_factor.unwrap() >= 1.3,
        "reached ×{:.4}, under ×1.3",
        plan.frequency_factor.unwrap()
    );
    assert!(plan.goal_met);

    let (with_mass, without) = rib_mass_shift(&plan, mat);
    let drop = (without - with_mass) / without;
    println!(
        "rib mass: {with_mass:.4} Hz with it, {without:.4} Hz without, {:+.3}%",
        drop * 100.0
    );
    assert!(with_mass < without, "rib mass should lower the frequency");
    assert!(
        drop < 0.01,
        "rib mass moved the frequency by {:.3}%, over 1%",
        drop * 100.0
    );

    let mut spend = RibPlanRequest::new(mesh.clone(), mat);
    spend.goal = Goal::Budget {
        volume_mm3: plan.rib_volume_mm3,
    };
    spend.load_cases = point.clone();
    spend.options.baselines = false;
    let t = Instant::now();
    let compliance = plan_ribs(&spend).unwrap();
    let comp_s = t.elapsed().as_secs_f64();
    let (c_bare, c_rib) = plan_hz(&compliance, mat);
    let c_factor = c_rib / c_bare;
    println!(
        "frequency ribs: {}, compliance ribs: {}",
        plan.ribs.len(),
        compliance.ribs.len()
    );
    println!(
        "compliance plan: bare {:.3} Hz, ribbed {:.3} Hz, ×{:.4} frequency, ×{:.4} stiffness, volume {:.2} mm³, {:.2} s",
        c_bare, c_rib, c_factor, compliance.stiffness_factor, compliance.rib_volume_mm3, comp_s
    );
    println!("plan time: frequency {freq_s:.2} s, stiffness {comp_s:.2} s");
    // How far a frequency plan goes once the ratio stops being the limit.
    let mut far = RibPlanRequest::new(mesh.clone(), mat);
    far.goal = Goal::Frequency { factor: 4.0 };
    far.load_cases = point.clone();
    far.options.baselines = false;
    let far = plan_ribs(&far).unwrap();
    println!(
        "frequency plan asked for ×4: reached ×{:.4}, {} ribs, volume {:.2} mm³, goal_met {}",
        far.frequency_factor.unwrap(),
        far.ribs.len(),
        far.rib_volume_mm3,
        far.goal_met
    );
    assert!(
        hz.ribbed > c_rib,
        "frequency ribs {:.3} Hz, compliance ribs {:.3} Hz",
        hz.ribbed,
        c_rib
    );

    let mut bare = ShellModel::new(
        mesh,
        mat,
        &rectangle_holds(
            &ShellMesh::rectangle([120.0, 70.0], [24, 14], 2.0),
            120.0,
            70.0,
            Edge::Clamped,
        ),
        ShellOptions::default(),
    )
    .unwrap();
    bare.set_threads(1);
    let load = vec![ShellLoad::Force {
        node,
        force: [0.0, 0.0, -10.0],
    }];
    let t = Instant::now();
    bare.solve(&load).unwrap();
    let static_s = t.elapsed().as_secs_f64();
    let t = Instant::now();
    bare.lowest_modes(RHO, 1).unwrap();
    let eigen_s = t.elapsed().as_secs_f64();
    println!("bare panel: static {static_s:.4} s, lowest mode {eigen_s:.4} s");
}

fn nearest(mesh: &ShellMesh, at: [f64; 3]) -> u32 {
    mesh.vertices
        .iter()
        .enumerate()
        .min_by(|(_, a), (_, b)| {
            let d = |p: &[f64; 3]| {
                (p[0] - at[0]).powi(2) + (p[1] - at[1]).powi(2) + (p[2] - at[2]).powi(2)
            };
            d(a).total_cmp(&d(b))
        })
        .map(|(i, _)| i as u32)
        .unwrap()
}

fn plan_ribs_of(plan: &RibPlan) -> Vec<Rib> {
    plan.ribs
        .iter()
        .flat_map(|r| {
            r.profile
                .solver_ribs(&r.vertices, &r.heights, r.width, r.side)
        })
        .collect()
}

fn plan_hz(plan: &RibPlan, mat: IsotropicShell) -> (f64, f64) {
    let holds = rectangle_holds(&plan.mesh, 120.0, 70.0, Edge::Clamped);
    let mut model =
        ShellModel::new(plan.mesh.clone(), mat, &holds, ShellOptions::default()).unwrap();
    model.set_threads(1);
    let bare = model.lowest_modes(RHO, 1).unwrap().modes[0].hz;
    model.set_ribs(plan_ribs_of(plan)).unwrap();
    let ribbed = model.lowest_modes(RHO, 1).unwrap().modes[0].hz;
    (bare, ribbed)
}

fn rib_mass_shift(plan: &RibPlan, mat: IsotropicShell) -> (f64, f64) {
    let holds = rectangle_holds(&plan.mesh, 120.0, 70.0, Edge::Clamped);
    let mut model =
        ShellModel::new(plan.mesh.clone(), mat, &holds, ShellOptions::default()).unwrap();
    model.set_threads(1);
    model.set_ribs(plan_ribs_of(plan)).unwrap();
    let with_mass = model.lowest_modes(RHO, 1).unwrap().modes[0].hz;
    let without = model.lowest_modes_with(RHO, 1, false).unwrap().modes[0].hz;
    (with_mass, without)
}

/// A stiffness request's plan, serialised without the frequency fields.
/// Locked to the bytes this branch produced from the unchanged selector;
/// the v6.11.0 snapshot tests lock the same plan to 1e-12.
#[test]
fn a_stiffness_plan_json_is_unchanged() {
    let mut req = RibPlanRequest::new(
        ShellMesh::rectangle([160.0, 80.0], [24, 12], 2.0),
        material(2000.0, 0.35),
    );
    req.goal = Goal::Stiffer(2.0);
    req.options.baselines = false;
    let plan = plan_ribs(&req).unwrap();
    assert!(plan.frequency_hz.is_none());
    assert!(plan.frequency_factor.is_none());
    assert!(plan.notes.is_empty());
    let stamp = stiffness_stamp(&plan);
    assert_eq!(stamp, include_str!("one_case_stamp_v6110.json"));
}

fn stiffness_stamp(plan: &RibPlan) -> String {
    let ribs: Vec<_> = plan
        .ribs
        .iter()
        .map(|r| {
            serde_json::json!({
                "height": r.height,
                "heights": r.heights,
                "points": r.points,
                "family": format!("{:?}", r.family),
                "ends": format!("{:?}", r.ends),
                "volume_mm3": r.volume_mm3,
            })
        })
        .collect();
    let v = serde_json::json!({
        "stiffness_factor": plan.stiffness_factor,
        "rib_volume_mm3": plan.rib_volume_mm3,
        "bare_compliance": plan.bare.compliance,
        "ribbed_compliance": plan.ribbed.compliance,
        "bare_deflection": plan.bare.max_deflection,
        "ribbed_deflection": plan.ribbed.max_deflection,
        "goal_met": plan.goal_met,
        "case_factors": plan.case_factors,
        "ribs": ribs,
    });
    serde_json::to_string_pretty(&v).unwrap() + "\n"
}

fn centre_rib(a: f64, n: usize) -> Rib {
    let row = n / 2;
    let stride = n + 1;
    let mut edges = Vec::new();
    for i in 0..n {
        let v = (i + stride * row) as u32;
        edges.push((v, v + 1));
    }
    let _ = a;
    Rib::rectangular(edges, 1.2, 6.0, RibSide::Positive)
}
