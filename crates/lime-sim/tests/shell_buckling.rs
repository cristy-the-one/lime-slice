//! Closed forms for plate buckling. The meshes and the 2 % band are the
//! ones docs/plan-shell-modes.md set for this slice. The reference load is
//! a uniform compression of 1 N/mm, so λ is Ncr = k π² D / b².

use std::collections::HashMap;

use lime_sim::shell::planner::{
    already_enough, buckles_at, plan_ribs, reached_short, Goal, Holds, RibPlanRequest, AS_TRACED,
    IDEAL_BUCKLING,
};
use lime_sim::shell::{
    BucklingSet, Rib, RibSide, ShellHold, ShellLoad, ShellMesh, ShellModel, ShellOptions,
    ShellResult, CLUSTER_GAP, cluster_count,
};
use shell_common::{material, rectangle_holds, rigidity, Edge};

#[path = "shell_common/mod.rs"]
mod shell_common;

const E: f64 = 2000.0;
const NU: f64 = 0.3;

fn ncr(k: f64, b: f64, h: f64) -> f64 {
    let d = rigidity(E, NU, h);
    k * std::f64::consts::PI.powi(2) * d / (b * b)
}

fn report(case: &str, mesh: &str, lambda: f64, closed: f64) -> f64 {
    let err = (lambda - closed) / closed;
    println!(
        "| {case} | {mesh} | {lambda:.6} | {closed:.6} | {:+.3}% |",
        err * 100.0
    );
    err
}

/// Area-weighted membrane force in global XY. Local frames differ per
/// triangle (the second of a cell sits on the diagonal), so averaging
/// `local` mixes Nxx with Nyy.
fn mean_force(result: &ShellResult) -> [f64; 3] {
    let mut sum = [0.0; 3];
    let mut area = 0.0;
    for e in &result.elements {
        let [nxx, nyy, nxy] = e.membrane_force.local;
        let e1 = e.frame.e1;
        let e2 = e.frame.e2;
        let gxx = nxx * e1[0] * e1[0] + nyy * e2[0] * e2[0] + 2.0 * nxy * e1[0] * e2[0];
        let gyy = nxx * e1[1] * e1[1] + nyy * e2[1] * e2[1] + 2.0 * nxy * e1[1] * e2[1];
        let gxy = nxx * e1[0] * e1[1] + nyy * e2[0] * e2[1] + nxy * (e1[0] * e2[1] + e1[1] * e2[0]);
        sum[0] += gxx * e.area;
        sum[1] += gyy * e.area;
        sum[2] += gxy * e.area;
        area += e.area;
    }
    sum.map(|v| v / area)
}

/// In-plane: ux = 0 on x = 0, one uy = 0, compressive line load on x = a
/// totalling `n_per_mm` × b. Bending holds are simple or clamped.
fn compression(
    mesh: &ShellMesh,
    a: f64,
    b: f64,
    n_per_mm: f64,
    edge: Edge,
) -> (Vec<ShellHold>, Vec<ShellLoad>) {
    let mut holds = Vec::new();
    let mut rim: Vec<(u32, f64)> = Vec::new();
    let mut anchor: Option<(f64, u32)> = None;
    for (i, p) in mesh.vertices.iter().enumerate() {
        let on_x0 = p[0].abs() < 1e-8;
        let on_xa = (p[0] - a).abs() < 1e-8;
        let on_y0 = p[1].abs() < 1e-8;
        let on_yb = (p[1] - b).abs() < 1e-8;
        if !(on_x0 || on_xa || on_y0 || on_yb) {
            continue;
        }
        let mut mask = [false; 6];
        mask[2] = true;
        match edge {
            Edge::Clamped => {
                mask[3] = true;
                mask[4] = true;
                mask[5] = true;
            }
            Edge::Simple => {
                if on_x0 || on_xa {
                    mask[3] = true;
                }
                if on_y0 || on_yb {
                    mask[4] = true;
                }
            }
        }
        if on_x0 {
            mask[0] = true;
            let dist = (p[1] - 0.5 * b).abs();
            if anchor.is_none_or(|(d, _)| dist < d) {
                anchor = Some((dist, i as u32));
            }
        }
        holds.push(ShellHold::fixed(i as u32, mask));
        if on_xa {
            rim.push((i as u32, p[1]));
        }
    }
    if let Some((_, node)) = anchor {
        if let Some(h) = holds.iter_mut().find(|h| h.node == node) {
            h.dofs[1] = Some(0.0);
        }
    }
    rim.sort_by(|p, q| p.1.total_cmp(&q.1));
    let mut loads = Vec::new();
    for (k, &(node, y)) in rim.iter().enumerate() {
        let prev = if k == 0 { y } else { rim[k - 1].1 };
        let next = if k + 1 == rim.len() { y } else { rim[k + 1].1 };
        let trib = 0.5 * ((y - prev) + (next - y));
        loads.push(ShellLoad::Force {
            node,
            force: [-n_per_mm * trib, 0.0, 0.0],
        });
    }
    (holds, loads)
}

fn solve_lambda(
    mesh: &ShellMesh,
    holds: &[ShellHold],
    loads: &[ShellLoad],
    count: usize,
) -> (BucklingSet, ShellResult) {
    let mut model = ShellModel::new(mesh.clone(), material(E, NU), holds, ShellOptions::default())
        .unwrap();
    model.set_threads(1);
    let pre = model.solve(loads).unwrap();
    let modes = model.buckling_modes(loads, count).unwrap();
    (modes, pre)
}

/// Square plate whose triangulation is unchanged by a quarter turn, so a
/// repeated buckling pair is not split by the diagonal of a rectangle cell.
fn union_jack(a: f64, n: usize, h: f64) -> ShellMesh {
    let mut vertices = Vec::new();
    let mut grid = vec![vec![0u32; n + 1]; n + 1];
    for (j, row) in grid.iter_mut().enumerate() {
        for (i, slot) in row.iter_mut().enumerate() {
            *slot = vertices.len() as u32;
            vertices.push([a * i as f64 / n as f64, a * j as f64 / n as f64, 0.0]);
        }
    }
    let mut center = vec![vec![0u32; n]; n];
    for (j, row) in center.iter_mut().enumerate() {
        for (i, slot) in row.iter_mut().enumerate() {
            *slot = vertices.len() as u32;
            vertices.push([
                a * (i as f64 + 0.5) / n as f64,
                a * (j as f64 + 0.5) / n as f64,
                0.0,
            ]);
        }
    }
    let mut triangles = Vec::new();
    for j in 0..n {
        for i in 0..n {
            let c = center[j][i];
            let (bl, br, tr, tl) = (
                grid[j][i],
                grid[j][i + 1],
                grid[j + 1][i + 1],
                grid[j + 1][i],
            );
            triangles.push([bl, br, c]);
            triangles.push([br, tr, c]);
            triangles.push([tr, tl, c]);
            triangles.push([tl, bl, c]);
        }
    }
    let thickness = vec![h; vertices.len()];
    ShellMesh {
        vertices,
        triangles,
        thickness,
    }
}

/// A rib along x = a/2. On a union-jack that line is a chain of edges.
fn centreline_rib(mesh: &ShellMesh, a: f64) -> Rib {
    let mut nodes: Vec<(u32, f64)> = mesh
        .vertices
        .iter()
        .enumerate()
        .filter(|(_, p)| (p[0] - 0.5 * a).abs() < 1e-6)
        .map(|(i, p)| (i as u32, p[1]))
        .collect();
    nodes.sort_by(|p, q| p.1.total_cmp(&q.1));
    let edges: Vec<(u32, u32)> = nodes.windows(2).map(|w| (w[0].0, w[1].0)).collect();
    Rib::rectangular(edges, 1.2, 6.0, RibSide::Positive)
}

/// A rib along x = a/2, across the compression.
fn cross_rib(nx: usize, ny: usize) -> Rib {
    let col = nx / 2;
    let stride = nx + 1;
    let mut edges = Vec::new();
    for j in 0..ny {
        let v = (col + stride * j) as u32;
        edges.push((v, v + stride as u32));
    }
    Rib::rectangular(edges, 1.2, 6.0, RibSide::Positive)
}

#[test]
fn simply_supported_square_uniaxial_converges() {
    let (a, h) = (100.0, 1.0);
    let closed = ncr(4.0, a, h);
    println!("| case | mesh | λ | closed form | error |");
    let mut errs = Vec::new();
    for n in [8, 16, 32] {
        let mesh = ShellMesh::rectangle([a, a], [n, n], h);
        let (holds, loads) = compression(&mesh, a, a, 1.0, Edge::Simple);
        let (modes, pre) = solve_lambda(&mesh, &holds, &loads, 1);
        let nbar = mean_force(&pre);
        let err = report(
            "SS square uniaxial k=4",
            &format!("{n}x{n}"),
            modes.modes[0].lambda,
            closed,
        );
        println!(
            "  mean Nxx {:.6} Nyy {:.6} Nxy {:.6}  eigen {:.4} s",
            nbar[0], nbar[1], nbar[2], modes.seconds
        );
        errs.push(err);
    }
    for (n, err) in [8, 16, 32].into_iter().zip(&errs) {
        assert!(
            err.abs() <= 0.02,
            "{n}x{n} is {:.3}%, outside 2%",
            err * 100.0
        );
    }
    assert!(
        errs[2].abs() <= errs[1].abs() && errs[1].abs() <= errs[0].abs(),
        "the error did not shrink: {errs:?}"
    );
}

#[test]
fn clamped_square_uniaxial_at_32() {
    let (a, h) = (100.0, 1.0);
    let closed = ncr(10.07, a, h);
    println!("| case | mesh | λ | closed form | error |");
    let mut finest = 0.0;
    for n in [16, 32] {
        let mesh = ShellMesh::rectangle([a, a], [n, n], h);
        let (holds, loads) = compression(&mesh, a, a, 1.0, Edge::Clamped);
        let (modes, pre) = solve_lambda(&mesh, &holds, &loads, 1);
        let nbar = mean_force(&pre);
        let err = report(
            "clamped square uniaxial k=10.07",
            &format!("{n}x{n}"),
            modes.modes[0].lambda,
            closed,
        );
        println!(
            "  mean Nxx {:.6} Nyy {:.6}  eigen {:.4} s",
            nbar[0], nbar[1], modes.seconds
        );
        finest = err;
    }
    assert!(
        finest.abs() <= 0.02,
        "32x32 is {:.3}%, outside 2%",
        finest * 100.0
    );
}

#[test]
fn rectangle_two_half_waves() {
    let (a, b, h) = (200.0, 100.0, 1.0);
    let closed = ncr(4.0, b, h);
    println!("| case | mesh | λ | closed form | error |");
    let mut finest = 0.0;
    for (nx, ny) in [(16, 8), (32, 16)] {
        let mesh = ShellMesh::rectangle([a, b], [nx, ny], h);
        let (holds, loads) = compression(&mesh, a, b, 1.0, Edge::Simple);
        let (modes, pre) = solve_lambda(&mesh, &holds, &loads, 1);
        let nbar = mean_force(&pre);
        let err = report(
            "SS rectangle a/b=2 k=4",
            &format!("{nx}x{ny}"),
            modes.modes[0].lambda,
            closed,
        );
        println!(
            "  mean Nxx {:.6} Nyy {:.6}  eigen {:.4} s",
            nbar[0], nbar[1], modes.seconds
        );
        finest = err;
    }
    assert!(
        finest.abs() <= 0.02,
        "32x16 is {:.3}%, outside 2%",
        finest * 100.0
    );
}

#[test]
fn pure_pressure_is_refused() {
    let mesh = ShellMesh::rectangle([100.0, 100.0], [8, 8], 1.0);
    let holds = rectangle_holds(&mesh, 100.0, 100.0, Edge::Simple);
    let mut model =
        ShellModel::new(mesh.clone(), material(E, NU), &holds, ShellOptions::default()).unwrap();
    model.set_threads(1);
    let err = model
        .buckling_modes(&shell_common::pressure(&mesh, 0.001), 1)
        .unwrap_err()
        .to_string();
    assert_eq!(
        err,
        "This load bends the wall but doesn't press along it, so it can't buckle it. Buckling needs a load along the wall, such as a push on its edge."
    );
    println!("pressure refusal: {err}");
}

#[test]
fn a_cross_rib_raises_lambda() {
    let (a, n) = (100.0, 16);
    let mesh = ShellMesh::rectangle([a, a], [n, n], 1.0);
    let (holds, loads) = compression(&mesh, a, a, 1.0, Edge::Simple);
    let mut model =
        ShellModel::new(mesh, material(E, NU), &holds, ShellOptions::default()).unwrap();
    model.set_threads(1);
    let bare = model.buckling_modes(&loads, 1).unwrap().modes[0].lambda;
    model.add_rib(cross_rib(n, n)).unwrap();
    let ribbed = model.buckling_modes(&loads, 1).unwrap().modes[0].lambda;
    println!("cross rib on 16x16: λ {bare:.6} → {ribbed:.6}");
    assert!(
        ribbed > bare * 1.2,
        "the rib did not raise λ: {bare} → {ribbed}"
    );
}

#[test]
fn repeated_pair_bound_is_basis_independent() {
    // Union-jack, not the rectangle's one diagonal: that diagonal splits
    // the (2,1) and (1,2) modes by more than the cluster gap even at 32×32.
    let (a, n) = (100.0, 8);
    let mesh = union_jack(a, n, 1.0);
    let (mut holds, mut loads) = compression(&mesh, a, a, 1.0, Edge::Simple);
    // compression anchors one uy on x = 0. Drop it: uy = 0 along the whole
    // of y = 0 is the symmetric partner of ux = 0 along x = 0.
    for h in &mut holds {
        let p = mesh.vertices[h.node as usize];
        if p[0].abs() < 1e-8 && p[1].abs() > 1e-8 {
            h.dofs[1] = None;
        }
    }
    // Equal compression on y = a as well, so the (2,1) and (1,2) modes are
    // the repeated pair above the fundamental.
    let mut rim: Vec<(u32, f64)> = Vec::new();
    for (i, p) in mesh.vertices.iter().enumerate() {
        if (p[1] - a).abs() < 1e-8 {
            rim.push((i as u32, p[0]));
        }
    }
    rim.sort_by(|p, q| p.1.total_cmp(&q.1));
    for (k, &(node, x)) in rim.iter().enumerate() {
        let prev = if k == 0 { x } else { rim[k - 1].1 };
        let next = if k + 1 == rim.len() { x } else { rim[k + 1].1 };
        let trib = 0.5 * ((x - prev) + (next - x));
        loads.push(ShellLoad::Force {
            node,
            force: [0.0, -trib, 0.0],
        });
    }
    for (i, p) in mesh.vertices.iter().enumerate() {
        if p[1].abs() < 1e-8 {
            if let Some(h) = holds.iter_mut().find(|h| h.node == i as u32) {
                h.dofs[1] = Some(0.0);
            }
        }
    }
    let mut model =
        ShellModel::new(mesh.clone(), material(E, NU), &holds, ShellOptions::default()).unwrap();
    model.set_threads(1);
    let modes = model.buckling_modes(&loads, 4).unwrap();
    let lam: Vec<f64> = modes.modes.iter().map(|m| m.lambda).collect();
    println!(
        "biaxial square n={n} λ {:.6} {:.6} {:.6} {:.6}",
        lam[0], lam[1], lam[2], lam[3]
    );
    assert_eq!(cluster_count(&lam), 1, "the fundamental is not alone");
    let gap = (lam[2] - lam[1]).abs() / lam[1];
    println!("pair gap {:.4}%, cluster tolerance {:.1}%", gap * 100.0, CLUSTER_GAP * 100.0);
    assert!(gap <= CLUSTER_GAP, "the pair split by more than the cluster gap");
    let pair = vec![
        modes.modes[1].vector.clone(),
        modes.modes[2].vector.clone(),
    ];
    let rib = centreline_rib(&mesh, a);
    let score = model
        .buckling_cluster_shift(&loads, &rib, &pair)
        .unwrap();
    let left = model
        .buckling_cluster_shift(&loads, &rib, &pair[..1])
        .unwrap();
    let right = model
        .buckling_cluster_shift(&loads, &rib, &pair[1..])
        .unwrap();
    println!("single-vector Δλ {left:.6} {right:.6}, cluster {score:.6}");
    assert!(
        score < left && score < right,
        "cluster {score} is not below both single-vector scores"
    );
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
    let again = model
        .buckling_cluster_shift(&loads, &rib, &rotated)
        .unwrap();
    println!("rotated cluster Δλ {again:.6}");
    let scale = score.abs().max(1.0);
    assert!(
        (score - again).abs() <= 1e-8 * scale,
        "rotated score {again} differs from {score}"
    );
}

#[test]
fn a_buckling_goal_refuses_a_low_factor_and_a_misnamed_case() {
    let mesh = ShellMesh::rectangle([40.0, 40.0], [4, 4], 1.0);
    let mut req = RibPlanRequest::new(mesh, material(E, NU));
    req.goal = Goal::Buckling {
        factor: 0.5,
        on: None,
    };
    let err = plan_ribs(&req).unwrap_err().to_string();
    assert!(err.contains("buckling goal") && err.contains("1 or more"), "{err}");
    req.goal = Goal::Buckling {
        factor: 2.0,
        on: Some(0),
    };
    let err = plan_ribs(&req).unwrap_err().to_string();
    assert!(err.contains("more than one"), "{err}");
    req.load_cases = vec![vec![], vec![]];
    req.goal = Goal::Buckling {
        factor: 2.0,
        on: None,
    };
    let err = plan_ribs(&req).unwrap_err().to_string();
    assert!(err.contains("needs the load case"), "{err}");
    assert!(!format!("{:?}", Goal::Buckling { factor: 2.0, on: None }).contains("volume"));
    println!("buckling goal refusals checked");
}

#[test]
fn planned_ribs_reach_twice_from_near_one() {
    let (a, n) = (100.0, 8);
    let mesh = ShellMesh::rectangle([a, a], [n, n], 1.0);
    // The edge load is the closed-form Ncr, so an exact plate starts at 1×.
    let (holds, loads) = compression(&mesh, a, a, ncr(4.0, a, 1.0), Edge::Simple);
    let mut req = RibPlanRequest::new(mesh, material(E, NU));
    req.holds = Holds::Given(holds);
    req.load_cases = vec![loads];
    req.goal = Goal::Buckling {
        factor: 2.0,
        on: None,
    };
    req.options.baselines = false;
    req.options.shortlist = 4;
    let plan = plan_ribs(&req).unwrap();
    let factor = plan.buckling_factor.expect("a buckling result");
    println!(
        "plan 8x8: λ {:.4} → {:.4}, ribs {}, volume {:.1} mm³, goal_met {}, notes {:?}",
        factor.bare,
        factor.ribbed,
        plan.ribs.len(),
        plan.rib_volume_mm3,
        plan.goal_met,
        plan.notes
    );
    assert!(
        (factor.bare - 1.0).abs() < 0.15,
        "bare λ {:.4} is not near 1",
        factor.bare
    );
    assert!(plan.goal_met, "the 2× target was not met");
    assert!(factor.ribbed + 1e-9 >= 2.0, "ribbed λ {}", factor.ribbed);
    assert!(
        plan.notes.iter().any(|n| n.contains("ideal buckling load")),
        "{:?}",
        plan.notes
    );
}

/// Bare λ already above the ask: the plan stops before tracing a rib.
#[test]
fn a_plate_already_above_the_factor_plans_no_ribs() {
    let (a, n) = (100.0, 8);
    let mesh = ShellMesh::rectangle([a, a], [n, n], 1.0);
    // Half the closed-form Ncr, so an exact plate holds 2×. The ask is 1.5×.
    let (holds, loads) = compression(&mesh, a, a, 0.5 * ncr(4.0, a, 1.0), Edge::Simple);
    let mut req = RibPlanRequest::new(mesh, material(E, NU));
    req.holds = Holds::Given(holds);
    req.load_cases = vec![loads];
    req.goal = Goal::Buckling {
        factor: 1.5,
        on: None,
    };
    req.options.baselines = false;
    let plan = plan_ribs(&req).unwrap();
    let factor = plan.buckling_factor.expect("a buckling result");
    println!(
        "already enough: λ {:.4}, ribs {}, goal_met {}, notes {:?}",
        factor.bare,
        plan.ribs.len(),
        plan.goal_met,
        plan.notes
    );
    assert!(plan.ribs.is_empty(), "ribs were planned on a wall that already holds");
    assert!(plan.goal_met);
    assert!(
        (factor.bare - factor.ribbed).abs() <= 1e-12,
        "before {} after {}",
        factor.bare,
        factor.ribbed
    );
    assert!(factor.bare > 1.5, "bare λ {} is not above 1.5", factor.bare);
    assert_eq!(
        plan.notes,
        vec![
            IDEAL_BUCKLING.to_string(),
            already_enough(factor.bare, 1.5),
        ]
    );
}

/// The ribs that pay still fall short of the ask, so the plan stops.
#[test]
fn a_capped_rib_stops_short_of_the_factor() {
    let (a, n) = (100.0, 8);
    let mesh = ShellMesh::rectangle([a, a], [n, n], 1.0);
    let (holds, loads) = compression(&mesh, a, a, ncr(4.0, a, 1.0), Edge::Simple);
    let mut req = RibPlanRequest::new(mesh, material(E, NU));
    req.holds = Holds::Given(holds);
    req.load_cases = vec![loads];
    req.goal = Goal::Buckling {
        factor: 5.0,
        on: None,
    };
    req.rules.max_height = 1.0;
    req.rules.min_spacing = 80.0;
    req.options.baselines = false;
    req.options.shortlist = 4;
    let plan = plan_ribs(&req).unwrap();
    let factor = plan.buckling_factor.expect("a buckling result");
    println!(
        "short: λ {:.4} → {:.4}, ribs {}, goal_met {}, notes {:?}",
        factor.bare,
        factor.ribbed,
        plan.ribs.len(),
        plan.goal_met,
        plan.notes
    );
    assert!(!plan.ribs.is_empty(), "nothing was tried");
    assert!(!plan.goal_met, "a 1 mm rib reached 5×");
    assert!(factor.ribbed + 1e-9 < 5.0, "ribbed λ {}", factor.ribbed);
    assert_eq!(
        plan.notes,
        vec![
            IDEAL_BUCKLING.to_string(),
            buckles_at(factor.ribbed, factor.bare),
            reached_short(factor.ribbed, 5.0),
            AS_TRACED.to_string(),
        ]
    );
}

#[test]
fn pressure_beside_compression_uses_the_named_case() {
    let (a, n) = (40.0, 4);
    let mesh = ShellMesh::rectangle([a, a], [n, n], 1.0);
    let (holds, loads) = compression(&mesh, a, a, 1.0, Edge::Simple);
    let mut req = RibPlanRequest::new(mesh.clone(), material(E, NU));
    req.holds = Holds::Given(holds);
    req.load_cases = vec![shell_common::pressure(&mesh, 0.001), loads];
    req.goal = Goal::Buckling {
        factor: 2.0,
        on: Some(0),
    };
    req.options.baselines = false;
    let err = plan_ribs(&req).unwrap_err().to_string();
    assert!(
        err.contains("doesn't press along it"),
        "the pressure case was not refused: {err}"
    );
    req.goal = Goal::Buckling {
        factor: 2.0,
        on: Some(1),
    };
    let plan = plan_ribs(&req).unwrap();
    let factor = plan.buckling_factor.expect("factor");
    println!(
        "named case 1: λ {:.4} → {:.4}, case {:?}",
        factor.bare, factor.ribbed, factor.case_index
    );
    assert_eq!(factor.case_index, Some(1));
    assert!(factor.bare.is_finite() && factor.bare > 0.0);
}

struct BoxBuild {
    mesh: ShellMesh,
    index: HashMap<(i64, i64, i64), u32>,
}

impl BoxBuild {
    fn new() -> Self {
        Self {
            mesh: ShellMesh::default(),
            index: HashMap::new(),
        }
    }

    fn vertex(&mut self, p: [f64; 3]) -> u32 {
        let key = (
            (p[0] * 1.0e6).round() as i64,
            (p[1] * 1.0e6).round() as i64,
            (p[2] * 1.0e6).round() as i64,
        );
        if let Some(&id) = self.index.get(&key) {
            return id;
        }
        let id = self.mesh.vertices.len() as u32;
        self.mesh.vertices.push(p);
        self.mesh.thickness.push(1.0);
        self.index.insert(key, id);
        id
    }

    fn panel(&mut self, nu: usize, nv: usize, at: impl Fn(usize, usize) -> [f64; 3], outward: [f64; 3]) {
        let mut ids = vec![0u32; (nu + 1) * (nv + 1)];
        for j in 0..=nv {
            for i in 0..=nu {
                ids[i + (nu + 1) * j] = self.vertex(at(i, j));
            }
        }
        let corner = |i: usize, j: usize| ids[i + (nu + 1) * j];
        for j in 0..nv {
            for i in 0..nu {
                let (a, b, c, d) = (
                    corner(i, j),
                    corner(i + 1, j),
                    corner(i + 1, j + 1),
                    corner(i, j + 1),
                );
                let (pa, pb, pc) = (
                    self.mesh.vertices[a as usize],
                    self.mesh.vertices[b as usize],
                    self.mesh.vertices[c as usize],
                );
                let n = {
                    let u = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
                    let v = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
                    [
                        u[1] * v[2] - u[2] * v[1],
                        u[2] * v[0] - u[0] * v[2],
                        u[0] * v[1] - u[1] * v[0],
                    ]
                };
                let dot = n[0] * outward[0] + n[1] * outward[1] + n[2] * outward[2];
                if dot >= 0.0 {
                    self.mesh.triangles.push([a, b, c]);
                    self.mesh.triangles.push([a, c, d]);
                } else {
                    self.mesh.triangles.push([a, c, b]);
                    self.mesh.triangles.push([a, d, c]);
                }
            }
        }
    }
}

fn open_box() -> ShellMesh {
    let (l, w, h) = (40.0, 24.0, 16.0);
    let (nx, ny, nz) = (5, 3, 2);
    let mut b = BoxBuild::new();
    let lerp = |a: f64, c: f64, i: usize, n: usize| a + (c - a) * (i as f64 / n as f64);
    b.panel(nx, ny, |i, j| [lerp(0.0, l, i, nx), lerp(0.0, w, j, ny), 0.0], [0.0, 0.0, 1.0]);
    b.panel(ny, nz, |i, j| [0.0, lerp(0.0, w, i, ny), lerp(0.0, h, j, nz)], [-1.0, 0.0, 0.0]);
    b.panel(ny, nz, |i, j| [l, lerp(0.0, w, i, ny), lerp(0.0, h, j, nz)], [1.0, 0.0, 0.0]);
    b.panel(nx, nz, |i, j| [lerp(0.0, l, i, nx), 0.0, lerp(0.0, h, j, nz)], [0.0, -1.0, 0.0]);
    b.panel(nx, nz, |i, j| [lerp(0.0, l, i, nx), w, lerp(0.0, h, j, nz)], [0.0, 1.0, 0.0]);
    b.mesh
}

#[test]
fn an_open_box_buckles_on_the_side_walls() {
    let (l, w, h) = (40.0, 24.0, 16.0);
    let mesh = open_box();
    let holds: Vec<ShellHold> = mesh
        .vertices
        .iter()
        .enumerate()
        .filter(|(_, p)| p[2].abs() < 1e-8)
        .map(|(i, _)| ShellHold::clamped(i as u32))
        .collect();
    // The whole floor is held, so a floor mode cannot move. The rim push
    // compresses the walls. Share 200 N down the top edge.
    let rim: Vec<u32> = mesh
        .vertices
        .iter()
        .enumerate()
        .filter(|(_, p)| (p[2] - h).abs() < 1e-6)
        .map(|(i, _)| i as u32)
        .collect();
    let share = 200.0 / rim.len() as f64;
    let loads: Vec<ShellLoad> = rim
        .iter()
        .map(|&node| ShellLoad::Force {
            node,
            force: [0.0, 0.0, -share],
        })
        .collect();
    let mut model =
        ShellModel::new(mesh.clone(), material(E, NU), &holds, ShellOptions::default()).unwrap();
    model.set_threads(1);
    let probed = model.buckling_modes(&loads, 1).unwrap();
    let lambda_probe = probed.modes[0].lambda;
    // λ scales as 1/load. Retarget so the bare factor is near 1.
    let scale = lambda_probe;
    let loads: Vec<ShellLoad> = rim
        .iter()
        .map(|&node| ShellLoad::Force {
            node,
            force: [0.0, 0.0, -share * scale],
        })
        .collect();
    let modes = model.buckling_modes(&loads, 1).unwrap();
    let motion = model.vertex_motion(&modes.modes[0].vector).unwrap();
    let mut floor = 0.0;
    let mut wall = 0.0;
    for (i, p) in mesh.vertices.iter().enumerate() {
        let u = motion[i];
        let e = u[0] * u[0] + u[1] * u[1] + u[2] * u[2];
        if p[2].abs() < 1e-6 {
            floor += e;
        } else {
            wall += e;
        }
    }
    println!(
        "open box: probe λ {:.4}, retargeted λ {:.4}, wall energy {:.6}, floor energy {:.6}, eigen {:.4} s",
        lambda_probe, modes.modes[0].lambda, wall, floor, modes.seconds
    );
    assert!(
        wall > 20.0 * floor.max(1e-30),
        "the side walls did not buckle first: wall {wall}, floor {floor}"
    );
    assert!(
        (modes.modes[0].lambda - 1.0).abs() < 0.05,
        "retargeted λ {}",
        modes.modes[0].lambda
    );

    let mut req = RibPlanRequest::new(mesh, material(E, NU));
    req.holds = Holds::Given(holds);
    req.load_cases = vec![loads];
    req.goal = Goal::Buckling {
        factor: 2.0,
        on: None,
    };
    req.options.baselines = false;
    req.options.shortlist = 4;
    req.options.creases = true;
    req.rules.min_length = 8.0;
    req.rules.min_spacing = 8.0;
    req.hole_rim_margin = None;
    let plan = plan_ribs(&req).unwrap();
    let factor = plan.buckling_factor.expect("factor");
    println!(
        "box plan: λ {:.4} → {:.4}, ribs {}, goal_met {}",
        factor.bare,
        factor.ribbed,
        plan.ribs.len(),
        plan.goal_met
    );
    for (i, rib) in plan.ribs.iter().enumerate() {
        let mean_z = rib.points.iter().map(|p| p[2]).sum::<f64>() / rib.points.len() as f64;
        let on_floor = rib.points.iter().filter(|p| p[2] < 1.0).count();
        println!(
            "  rib {i}: len {:.1}, mean z {:.2}, points on the floor {on_floor}/{}",
            rib.length_mm,
            mean_z,
            rib.points.len()
        );
        assert!(
            mean_z > 2.0,
            "rib {i} sits on the floor, mean z {mean_z}"
        );
    }
    assert!(!plan.ribs.is_empty(), "no ribs were planned on the box");
    let _ = (l, w);
}

fn r6(x: f64) -> f64 {
    let y = (x * 1.0e6).round() / 1.0e6;
    if y == 0.0 { 0.0 } else { y }
}

/// Pins the 100 × 100 × 1 ×2 buckling plan (ribs, bucklingFactor, notes) to 1e-6
/// so Windows and Linux match identically while catching any rib or mode drift.
#[test]
fn a_buckling_plan_json_is_pinned() {
    let (a, n) = (100.0, 8);
    let mesh = ShellMesh::rectangle([a, a], [n, n], 1.0);
    let (holds, loads) = compression(&mesh, a, a, ncr(4.0, a, 1.0), Edge::Simple);
    let mut req = RibPlanRequest::new(mesh, material(E, NU));
    req.holds = Holds::Given(holds);
    req.load_cases = vec![loads];
    req.goal = Goal::Buckling {
        factor: 2.0,
        on: None,
    };
    req.options.baselines = false;
    req.options.shortlist = 4;
    let plan = plan_ribs(&req).unwrap();
    let ribs: Vec<_> = plan
        .ribs
        .iter()
        .map(|r| {
            let points: Vec<[f64; 3]> = r.points.iter().map(|p| [r6(p[0]), r6(p[1]), r6(p[2])]).collect();
            let heights: Vec<f64> = r.heights.iter().map(|&h| r6(h)).collect();
            serde_json::json!({
                "height": r6(r.height),
                "heights": heights,
                "width": r6(r.width),
                "length_mm": r6(r.length_mm),
                "points": points,
                "family": format!("{:?}", r.family),
                "ends": format!("{:?}", r.ends),
                "volume_mm3": r6(r.volume_mm3),
            })
        })
        .collect();
    let factor = plan.buckling_factor.expect("buckling_factor");
    let v = serde_json::json!({
        "buckling_factor": {
            "bare": r6(factor.bare),
            "ribbed": r6(factor.ribbed),
            "case_index": factor.case_index,
        },
        "stiffness_factor": r6(plan.stiffness_factor),
        "rib_volume_mm3": r6(plan.rib_volume_mm3),
        "bare_compliance": r6(plan.bare.compliance),
        "ribbed_compliance": r6(plan.ribbed.compliance),
        "goal_met": plan.goal_met,
        "notes": plan.notes,
        "ribs": ribs,
    });
    let stamp = serde_json::to_string_pretty(&v).unwrap() + "\n";
    let expected = include_str!("buckling_plan_stamp.json").replace("\r\n", "\n");
    assert_eq!(stamp, expected);
}
