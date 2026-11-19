//! Textbook plates for the shell's natural frequencies. The meshes and the
//! 2 % band are the ones docs/plan-shell-modes.md measured; the tolerances
//! are not loosened.

use lime_sim::shell::{
    CLUSTER_GAP, IsotropicShell, Rib, RibSide, ShellMesh, ShellModel, ShellOptions, cluster_count,
};
use shell_common::{Edge, material, rectangle_holds, rigidity};

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
