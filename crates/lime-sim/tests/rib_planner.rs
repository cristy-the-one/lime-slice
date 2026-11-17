//! The rib planner on synthetic walls: where it puts ribs, how much
//! material it needs against thickening the wall and against an even
//! grid, each goal, keep-out and height-capped zones, determinism, and
//! the embedding that lets a rib cross the mesh at any angle.
//!
//! Each case prints one row:
//! `| case | ribs | rib volume mm³ | stiffness × | thickening mm³ | grid mm³ | solves | s |`.

mod shell_common;

use lime_sim::shell::planner::{
    boundary_vertices, chain_edges, embed_polylines, plan_ribs, rib_network_volume, Goal, Holds,
    RibPlan, RibPlanRequest, RibRules, Zone, ZoneMode,
};
use lime_sim::shell::{Rib, RibSide, ShellHold, ShellLoad, ShellMesh, ShellModel, ShellOptions};
use shell_common::*;

const E: f64 = 2000.0;
const NU: f64 = 0.35;

fn report(case: &str, plan: &RibPlan) {
    let th = plan
        .thickening
        .map_or("-".to_string(), |t| format!("{:.0}", t.added_volume_mm3));
    let grid = plan.grid.map_or("-".to_string(), |g| match g.volume_mm3 {
        Some(v) => format!("{v:.0} (pitch {:.1}, {:?} lines)", g.pitch_mm, g.lines),
        None => format!(
            "unreached (densest {:.0}, ×{:.2} short)",
            g.grid_volume_mm3,
            g.compliance / plan.ribbed.compliance
        ),
    });
    eprintln!(
        "| {case} | {} | {:.0} | {:.2} | {th} | {grid} | {} + {} | {:.1} |",
        plan.ribs.len(),
        plan.rib_volume_mm3,
        plan.stiffness_factor,
        plan.stats.solves,
        plan.stats.baseline_solves,
        plan.stats.seconds.total
    );
    for r in &plan.ribs {
        let a = r.points[0];
        let b = *r.points.last().unwrap();
        eprintln!(
            "|   rib | {:?} | ({:.0}, {:.0}, {:.0}) → ({:.0}, {:.0}, {:.0}) | {:.0} mm × {:.1} mm | gain {:.3} | ends {:?} |",
            r.family, a[0], a[1], a[2], b[0], b[1], b[2], r.length_mm, r.height, r.gain, r.ends
        );
    }
}

/// Rib length running along `axis` and across it (by |cos|).
fn along_across(plan: &RibPlan, axis: [f64; 3]) -> (f64, f64) {
    let mut along = 0.0;
    let mut across = 0.0;
    for r in &plan.ribs {
        for w in r.points.windows(2) {
            let d = [0, 1, 2].map(|k| w[1][k] - w[0][k]);
            let len = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
            let c = (d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2]).abs() / len;
            along += len * c;
            across += len * (1.0 - c * c).max(0.0).sqrt();
        }
    }
    (along, across)
}

/// Rib length within `radius` of `at` (segment midpoints).
fn rib_length_near(plan: &RibPlan, at: [f64; 3], radius: f64) -> f64 {
    let mut total = 0.0;
    for r in &plan.ribs {
        for w in r.points.windows(2) {
            let m = [0, 1, 2].map(|k| 0.5 * (w[0][k] + w[1][k]));
            let len = (0..3)
                .map(|k| (w[1][k] - w[0][k]).powi(2))
                .sum::<f64>()
                .sqrt();
            if (0..3).map(|k| (m[k] - at[k]).powi(2)).sum::<f64>().sqrt() < radius {
                total += len;
            }
        }
    }
    total
}

fn panel_request(a: f64, b: f64, div: [usize; 2]) -> RibPlanRequest {
    RibPlanRequest::new(ShellMesh::rectangle([a, b], div, 2.0), material(E, NU))
}

/// A rib across the mesh at 30° to its rows gives the deflection of the
/// same rib on a mesh built along it: the embedding has no staircase bias.
/// Mesh A is a regular grid turned 30° with the rib cut in; mesh B covers
/// the same turned square in rows parallel to the rib, so the rib is a row
/// of its own edges.
#[test]
fn a_rib_across_the_mesh_matches_an_aligned_mesh() {
    let (s, n, t) = (120.0, 40, 2.0);
    let c = 0.5 * s;
    let (sin, cos) = 30f64.to_radians().sin_cos();
    let turn = |p: [f64; 2]| {
        let (x, y) = (p[0] - c, p[1] - c);
        [c + cos * x - sin * y, c + sin * x + cos * y]
    };
    // Mesh A.
    let mut a = ShellMesh::rectangle([s, s], [n, n], t);
    for p in &mut a.vertices {
        let q = turn([p[0], p[1]]);
        *p = [q[0], q[1], 0.0];
    }
    let half = c / cos;
    let rib_line = vec![[c - half, c, 0.0], [c + half, c, 0.0]];
    let emb = embed_polylines(&a, &[rib_line]);
    let chain = emb.chains[0].clone().expect("the rib is cut in");
    let a_mesh = emb.mesh;

    // Mesh B: rows y = const across the turned square.
    let corners = [[0.0, 0.0], [s, 0.0], [s, s], [0.0, s]].map(turn);
    let h = s / n as f64;
    let y_min = corners.iter().map(|p| p[1]).fold(f64::INFINITY, f64::min);
    let y_max = corners
        .iter()
        .map(|p| p[1])
        .fold(f64::NEG_INFINITY, f64::max);
    let mut levels: Vec<f64> = corners.iter().map(|p| p[1]).collect();
    levels.push(c);
    levels.sort_by(f64::total_cmp);
    let mut ys = Vec::new();
    for w in levels.windows(2) {
        let k = ((w[1] - w[0]) / h).round().max(1.0) as usize;
        for i in 0..k {
            ys.push(w[0] + (w[1] - w[0]) * i as f64 / k as f64);
        }
    }
    ys.push(y_max);
    assert!((ys[0] - y_min).abs() < 1e-9);
    // Where a row meets the turned square's sides.
    let span = |y: f64| {
        let mut xs = Vec::new();
        for i in 0..4 {
            let (p, q) = (corners[i], corners[(i + 1) % 4]);
            if (p[1] - y) * (q[1] - y) <= 0.0 && (q[1] - p[1]).abs() > 1e-12 {
                let u = (y - p[1]) / (q[1] - p[1]);
                xs.push(p[0] + u * (q[0] - p[0]));
            }
        }
        let lo = xs.iter().copied().fold(f64::INFINITY, f64::min);
        let hi = xs.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        (lo, hi)
    };
    let mut b = ShellMesh::default();
    let mut rows: Vec<Vec<u32>> = Vec::new();
    let mut rib_row = usize::MAX;
    for (r, &y) in ys.iter().enumerate() {
        let (lo, hi) = span(y);
        let k = ((hi - lo) / h).round() as usize;
        let mut row = Vec::new();
        for i in 0..=k {
            let x = if k == 0 {
                0.5 * (lo + hi)
            } else {
                lo + (hi - lo) * i as f64 / k as f64
            };
            row.push(b.vertices.len() as u32);
            b.vertices.push([x, y, 0.0]);
            b.thickness.push(t);
        }
        if (y - c).abs() < 1e-9 {
            rib_row = r;
        }
        rows.push(row);
    }
    for w in rows.windows(2) {
        let (lo, up) = (&w[0], &w[1]);
        let (mut i, mut j) = (0, 0);
        while i + 1 < lo.len() || j + 1 < up.len() {
            let fa = if lo.len() > 1 {
                (i + 1) as f64 / (lo.len() - 1) as f64
            } else {
                f64::INFINITY
            };
            let fb = if up.len() > 1 {
                (j + 1) as f64 / (up.len() - 1) as f64
            } else {
                f64::INFINITY
            };
            if j + 1 >= up.len() || (i + 1 < lo.len() && fa <= fb) {
                b.triangles.push([lo[i], lo[i + 1], up[j]]);
                i += 1;
            } else {
                b.triangles.push([lo[i], up[j + 1], up[j]]);
                j += 1;
            }
        }
    }
    let b_chain = rows[rib_row].clone();

    let solve = |mesh: &ShellMesh, chain: Option<&[u32]>| {
        let holds: Vec<ShellHold> = boundary_vertices(mesh)
            .into_iter()
            .map(ShellHold::clamped)
            .collect();
        let mut model = ShellModel::new(
            mesh.clone(),
            material(E, NU),
            &holds,
            ShellOptions::default(),
        )
        .unwrap();
        if let Some(ch) = chain {
            model
                .add_rib(Rib {
                    edges: chain_edges(ch),
                    width: 1.2,
                    height: 6.0,
                    side: RibSide::Positive,
                })
                .unwrap();
        }
        let r = model.solve(&pressure(model.mesh(), 0.001)).unwrap();
        (centre_w(&model, &r.displacement, [c, c, 0.0]), r.compliance)
    };
    let (wa0, _) = solve(&a_mesh, None);
    let (wb0, _) = solve(&b, None);
    let (wa, ca) = solve(&a_mesh, Some(&chain));
    let (wb, cb) = solve(&b, Some(&b_chain));
    // The staircase a rib on the turned grid's own edges would take.
    let stair = shortest_edge_path(
        &a,
        chain_end_vertex(&a, rib_line_end(c, half, -1.0)),
        chain_end_vertex(&a, rib_line_end(c, half, 1.0)),
    );
    let (ws, _) = solve(&a, Some(&stair));
    eprintln!(
        "| 30° rib | turned grid, cut in: w {wa:.6} C {ca:.6} ({} tris) | aligned rows: w {wb:.6} C {cb:.6} ({} tris) | gap {:+.2} % | bare gap {:+.2} % | staircase on grid edges: w {ws:.6} ({:+.2} %) |",
        a_mesh.triangles.len(),
        b.triangles.len(),
        100.0 * (wa - wb) / wb,
        100.0 * (wa0 - wb0) / wb0,
        100.0 * (ws - wb) / wb,
    );
    assert!(((wa - wb) / wb).abs() < 0.03, "{wa} vs {wb}");
    assert!(((ca - cb) / cb).abs() < 0.03, "{ca} vs {cb}");
}

fn rib_line_end(c: f64, half: f64, sign: f64) -> [f64; 3] {
    [c + sign * half, c, 0.0]
}

fn chain_end_vertex(mesh: &ShellMesh, p: [f64; 3]) -> u32 {
    mesh.nearest_vertex(p)
}

/// Dijkstra over mesh edges.
fn shortest_edge_path(mesh: &ShellMesh, from: u32, to: u32) -> Vec<u32> {
    let n = mesh.vertices.len();
    let mut adj: Vec<Vec<u32>> = vec![Vec::new(); n];
    for t in &mesh.triangles {
        for k in 0..3 {
            adj[t[k] as usize].push(t[(k + 1) % 3]);
            adj[t[(k + 1) % 3] as usize].push(t[k]);
        }
    }
    let mut dist = vec![f64::INFINITY; n];
    let mut prev = vec![u32::MAX; n];
    let mut done = vec![false; n];
    dist[from as usize] = 0.0;
    loop {
        let mut u = usize::MAX;
        for v in 0..n {
            if !done[v] && dist[v].is_finite() && (u == usize::MAX || dist[v] < dist[u]) {
                u = v;
            }
        }
        if u == usize::MAX || u == to as usize {
            break;
        }
        done[u] = true;
        for &w in &adj[u] {
            let p = mesh.vertices[u];
            let q = mesh.vertices[w as usize];
            let d = dist[u] + (0..3).map(|k| (p[k] - q[k]).powi(2)).sum::<f64>().sqrt();
            if d < dist[w as usize] {
                dist[w as usize] = d;
                prev[w as usize] = u as u32;
            }
        }
    }
    let mut path = vec![to];
    while *path.last().unwrap() != from {
        path.push(prev[*path.last().unwrap() as usize]);
    }
    path.reverse();
    path
}

/// The clamped 300 × 120 panel under even pressure: ribs run mostly across
/// the short span.
#[test]
fn clamped_panel_ribs_run_across_the_short_span() {
    let req = panel_request(300.0, 120.0, [60, 24]);
    let plan = plan_ribs(&req).unwrap();
    report("clamped 300×120 panel, pressure, balanced", &plan);
    let (along_x, across) = along_across(&plan, [1.0, 0.0, 0.0]);
    eprintln!("rib length along x {along_x:.0} mm, across {across:.0} mm");
    assert!(!plan.ribs.is_empty());
    assert!(across > along_x, "{across} vs {along_x}");
    assert!(plan.stiffness_factor > 1.5);
    assert!(!plan.not_better_than_baseline);
}

/// Clamped at one short end, a load on the other: ribs run along the span.
#[test]
fn cantilever_ribs_run_along_the_span() {
    let (a, b) = (200.0, 60.0);
    let mesh = ShellMesh::rectangle([a, b], [50, 15], 2.0);
    let holds: Vec<ShellHold> = (0..mesh.vertices.len())
        .filter(|&i| mesh.vertices[i][0].abs() < TOL)
        .map(|i| ShellHold::clamped(i as u32))
        .collect();
    let tip: Vec<u32> = (0..mesh.triangles.len() as u32)
        .filter(|&t| {
            mesh.triangles[t as usize]
                .iter()
                .any(|&v| (mesh.vertices[v as usize][0] - a).abs() < TOL)
        })
        .collect();
    let mut req = RibPlanRequest::new(mesh, material(E, NU));
    req.holds = Holds::Given(holds);
    req.load_cases = vec![vec![ShellLoad::SpreadForce {
        triangles: tip,
        force: [0.0, 0.0, -1.0],
    }]];
    let plan = plan_ribs(&req).unwrap();
    report("cantilever 200×60, end load, balanced", &plan);
    let (along, across) = along_across(&plan, [1.0, 0.0, 0.0]);
    eprintln!("rib length along the span {along:.0} mm, across {across:.0} mm");
    assert!(!plan.ribs.is_empty());
    assert!(along > 2.0 * across, "{along} vs {across}");
}

/// A free hole with a keep-out margin round its rim: no rib comes near it.
#[test]
fn ribs_keep_clear_of_a_hole() {
    let (centre, r, margin) = ([150.0, 60.0], 15.0, 5.0);
    let mesh = holed_panel(300.0, 120.0, [60, 24], 2.0, centre, r);
    let mut req = RibPlanRequest::new(mesh, material(E, NU));
    req.holds = Holds::OuterBoundaryClamped;
    req.hole_rim_margin = Some(margin);
    let plan = plan_ribs(&req).unwrap();
    report("300×120 panel with a free Ø30 hole, 5 mm rim margin", &plan);
    assert!(!plan.ribs.is_empty());
    // The hole's rim is jagged (cells cut out whole), up to one cell
    // (5 mm) beyond r; the margin is measured from the rim's vertices.
    let nearest = plan
        .ribs
        .iter()
        .flat_map(|rb| rb.points.iter())
        .map(|p| (p[0] - centre[0]).hypot(p[1] - centre[1]))
        .fold(f64::INFINITY, f64::min);
    eprintln!("nearest rib point to the hole's centre: {nearest:.1} mm");
    assert!(nearest > r + margin - 0.5, "{nearest}");
}

#[test]
fn l_shaped_panel() {
    let mesh = l_panel(200.0, 160.0, [40, 32], 2.0);
    let req = RibPlanRequest::new(mesh, material(E, NU));
    let plan = plan_ribs(&req).unwrap();
    report("L-shaped panel 200×160, pressure, balanced", &plan);
    assert!(!plan.ribs.is_empty());
    assert!(plan.stiffness_factor > 1.5);
    // Nothing stands in the cut-away quarter.
    for rb in &plan.ribs {
        for p in &rb.points {
            assert!(!(p[0] > 100.0 + 1e-6 && p[1] > 80.0 + 1e-6), "{p:?}");
        }
    }
}

/// A point load off centre: ribs gather round it.
#[test]
fn ribs_gather_under_an_off_centre_load() {
    let (a, b) = (300.0, 120.0);
    let mesh = ShellMesh::rectangle([a, b], [60, 24], 2.0);
    let at = [90.0, 70.0, 0.0];
    let patch: Vec<u32> = (0..mesh.triangles.len() as u32)
        .filter(|&t| {
            let p = mesh.triangles[t as usize].map(|v| mesh.vertices[v as usize]);
            let c = [0, 1].map(|k| (p[0][k] + p[1][k] + p[2][k]) / 3.0);
            (c[0] - at[0]).hypot(c[1] - at[1]) < 8.0
        })
        .collect();
    let mut req = RibPlanRequest::new(mesh, material(E, NU));
    req.load_cases = vec![vec![ShellLoad::SpreadForce {
        triangles: patch,
        force: [0.0, 0.0, -10.0],
    }]];
    let plan = plan_ribs(&req).unwrap();
    report("300×120 clamped, 10 N on Ø16 at (90, 70), balanced", &plan);
    let far = [a - at[0], b - at[1], 0.0];
    let near_len = rib_length_near(&plan, at, 40.0);
    let far_len = rib_length_near(&plan, far, 40.0);
    eprintln!(
        "rib length within 40 mm of the load {near_len:.0} mm; of its mirror point {far_len:.0} mm"
    );
    assert!(near_len > 2.0 * far_len.max(1.0), "{near_len} vs {far_len}");
}

/// A cylinder segment, R 80, 2 mm, clamped along its straight edges.
#[test]
fn curved_wall() {
    let (r, len, angle) = (80.0, 200.0, std::f64::consts::FRAC_PI_2);
    let div = [50, 30];
    let mesh = cylinder_segment(r, len, angle, div, 2.0);
    let holds: Vec<ShellHold> = (0..mesh.vertices.len())
        .filter(|&i| {
            let j = i / (div[0] + 1);
            j == 0 || j == div[1]
        })
        .map(|i| ShellHold::clamped(i as u32))
        .collect();
    let mut req = RibPlanRequest::new(mesh, material(E, NU));
    req.holds = Holds::Given(holds);
    let plan = plan_ribs(&req).unwrap();
    report(
        "cylinder segment R80 × 200, 90°, straight edges clamped",
        &plan,
    );
    let (along_axis, round) = along_across(&plan, [1.0, 0.0, 0.0]);
    eprintln!("rib length along the axis {along_axis:.0} mm, round the arc {round:.0} mm");
    assert!(!plan.ribs.is_empty());
    assert!(plan.stiffness_factor > 1.2);
    // Every rib point stays on the cylinder.
    for rb in &plan.ribs {
        for p in &rb.points {
            let rr = p[1].hypot(p[2]);
            assert!((rr - r).abs() < 0.2, "{p:?} at r {rr}");
        }
    }
}

/// The benchmark the feature must beat: a long clamped panel under
/// pressure stiffened by an even triangular lattice of shallow ribs
/// (1 × 2 mm, across and at ±30°, 20 mm pitch), against the planner asked
/// for the same stiffness with 1.2 mm ribs up to 6 mm tall.
#[test]
fn beats_a_uniform_shallow_lattice() {
    let (a, b) = (600.0, 120.0);
    let mesh = ShellMesh::rectangle([a, b], [120, 24], 2.0);
    let pitch = 20.0;
    let centre = [0.5 * a, 0.5 * b];
    // Three families through the centre, normals 120° apart.
    let mut lines: Vec<Vec<[f64; 3]>> = Vec::new();
    for normal_deg in [0.0f64, 120.0, 240.0] {
        let (s, c) = normal_deg.to_radians().sin_cos();
        let (nx, ny) = (c, s);
        let (dx, dy) = (-s, c);
        for k in -40i32..=40 {
            let off = k as f64 * pitch;
            // Points p = centre + off n + u d inside the rectangle.
            let base = [centre[0] + off * nx, centre[1] + off * ny];
            let mut lo = f64::NEG_INFINITY;
            let mut hi = f64::INFINITY;
            for (p0, d, min, max) in [(base[0], dx, 0.0, a), (base[1], dy, 0.0, b)] {
                if d.abs() < 1e-12 {
                    if p0 <= min || p0 >= max {
                        lo = f64::INFINITY;
                    }
                    continue;
                }
                let (u1, u2) = ((min - p0) / d, (max - p0) / d);
                lo = lo.max(u1.min(u2));
                hi = hi.min(u1.max(u2));
            }
            if hi - lo > 1.0 {
                lines.push(vec![
                    [base[0] + lo * dx, base[1] + lo * dy, 0.0],
                    [base[0] + hi * dx, base[1] + hi * dy, 0.0],
                ]);
            }
        }
    }
    let emb = embed_polylines(&mesh, &lines);
    let ribs: Vec<Rib> = emb
        .chains
        .iter()
        .flatten()
        .map(|ch| Rib {
            edges: chain_edges(ch),
            width: 1.0,
            height: 2.0,
            side: RibSide::Positive,
        })
        .collect();
    let lattice_volume = rib_network_volume(&emb.mesh, &ribs);
    let holds: Vec<ShellHold> = boundary_vertices(&emb.mesh)
        .into_iter()
        .map(ShellHold::clamped)
        .collect();
    let mut model = ShellModel::new(
        emb.mesh.clone(),
        material(E, NU),
        &holds,
        ShellOptions::default(),
    )
    .unwrap();
    let case = pressure(model.mesh(), 0.001);
    let bare = model.solve(&case).unwrap().compliance;
    model.set_ribs(ribs.clone()).unwrap();
    let ribbed = model.solve(&case).unwrap().compliance;
    let factor = bare / ribbed;
    eprintln!(
        "| lattice 600×120: {} lines, {:.0} mm³, stiffness ×{factor:.3} ({} triangles) |",
        ribs.len(),
        lattice_volume,
        emb.mesh.triangles.len()
    );

    let mut req = RibPlanRequest::new(mesh, material(E, NU));
    req.goal = Goal::Stiffer(factor);
    req.rules = RibRules {
        width: 1.2,
        max_height: 6.0,
        ..RibRules::default()
    };
    let plan = plan_ribs(&req).unwrap();
    report("600×120 planner to the lattice's stiffness", &plan);
    let ratio = plan.rib_volume_mm3 / lattice_volume;
    eprintln!(
        "| lattice vs planner | lattice {lattice_volume:.0} mm³ | planner {:.0} mm³ | planner / lattice {ratio:.3} | goal met {} |",
        plan.rib_volume_mm3, plan.goal_met
    );
    assert!(plan.goal_met);
    assert!(
        ratio < 0.5,
        "planner needs {ratio:.3} of the lattice's volume"
    );
}

/// Each goal stops where it should.
#[test]
fn each_goal_stops_where_it_should() {
    let base = panel_request(240.0, 100.0, [48, 20]);
    let quick = |goal: Goal| {
        let mut r = base.clone();
        r.goal = goal;
        r.options.baselines = false;
        plan_ribs(&r).unwrap()
    };
    let stiffer = quick(Goal::Stiffer(3.0));
    report("goal: 3× stiffer", &stiffer);
    assert!(stiffer.goal_met && stiffer.stiffness_factor >= 3.0);
    // The prune and the sizing leave little to spare.
    assert!(
        stiffer.stiffness_factor < 3.6,
        "{}",
        stiffer.stiffness_factor
    );

    let bare_max = stiffer.bare.max_deflection;
    let defl = quick(Goal::MaxDeflection(0.4 * bare_max));
    report("goal: deflection under 0.4 × bare", &defl);
    assert!(defl.goal_met && defl.ribbed.max_deflection <= 0.4 * bare_max);

    let budget = 0.5 * stiffer.rib_volume_mm3;
    let spend = quick(Goal::Budget { volume_mm3: budget });
    report("goal: budget half of the 3× plan", &spend);
    assert!(
        spend.rib_volume_mm3 <= budget + 1e-9,
        "{} > {budget}",
        spend.rib_volume_mm3
    );
    assert!(!spend.ribs.is_empty());

    let balanced = quick(Goal::Balanced);
    report("goal: balanced", &balanced);
    assert!(!balanced.ribs.is_empty());

    let never = quick(Goal::Stiffer(1000.0));
    report("goal: 1000× (unreachable)", &never);
    assert!(!never.goal_met);
}

/// Four candidates solved per round pick the same first ribs as solving
/// every candidate every round.
#[test]
fn the_shortlist_finds_the_same_ribs_as_exhaustive_scoring() {
    let mut req = panel_request(150.0, 60.0, [36, 15]);
    req.rules.min_spacing = 10.0;
    req.goal = Goal::Stiffer(2.5);
    req.options.baselines = false;
    req.options.shortlist = 4;
    let short = plan_ribs(&req).unwrap();
    req.options.shortlist = 0;
    let all = plan_ribs(&req).unwrap();
    report("shortlist 4", &short);
    report("exhaustive", &all);
    eprintln!(
        "| solves: shortlist {} vs exhaustive {} | candidates {} |",
        short.stats.solves, all.stats.solves, short.stats.embedded_candidates
    );
    let first = short.ribs.len().min(all.ribs.len()).min(3);
    assert!(first >= 1);
    for i in 0..first {
        assert_eq!(short.ribs[i].vertices, all.ribs[i].vertices, "rib {i}");
    }
}

/// A no-rib zone in the middle of the panel: no rib point inside it or
/// its margin.
#[test]
fn a_no_rib_zone_is_kept_clear() {
    let mut req = panel_request(300.0, 120.0, [60, 24]);
    let (lo, hi, margin) = ([120.0, 40.0], [180.0, 80.0], 3.0);
    let inside = |c: [f64; 2]| c[0] > lo[0] && c[0] < hi[0] && c[1] > lo[1] && c[1] < hi[1];
    let zone: Vec<u32> = (0..req.mesh.triangles.len() as u32)
        .filter(|&t| {
            let p = req.mesh.triangles[t as usize].map(|v| req.mesh.vertices[v as usize]);
            inside([0, 1].map(|k| (p[0][k] + p[1][k] + p[2][k]) / 3.0))
        })
        .collect();
    req.zones = vec![Zone {
        triangles: zone,
        mode: ZoneMode::NoRibs,
        margin,
    }];
    req.goal = Goal::Stiffer(2.0);
    let plan = plan_ribs(&req).unwrap();
    report(
        "300×120 panel, no-rib zone 60×40 in the middle, 3 mm margin, 2×",
        &plan,
    );
    // Distance from a point to the zone's rectangle.
    let gap = |p: &[f64; 3]| {
        let dx = (lo[0] - p[0]).max(p[0] - hi[0]).max(0.0);
        let dy = (lo[1] - p[1]).max(p[1] - hi[1]).max(0.0);
        dx.hypot(dy)
    };
    let nearest = plan
        .ribs
        .iter()
        .flat_map(|r| r.points.iter())
        .map(gap)
        .fold(f64::INFINITY, f64::min);
    eprintln!(
        "nearest rib point to the zone: {nearest:.2} mm (goal met: {})",
        plan.goal_met
    );
    // Points sit on edges of triangles outside zone + margin; a 5 mm cell's
    // diagonal leaves them at most ~half a cell closer than the margin, and
    // the 0.2 mm simplification a little more.
    assert!(nearest >= margin - 0.3, "{nearest}");
    assert!(plan.goal_met || !plan.ribs.is_empty());
}

/// A height-capped band across the panel: ribs cross it, no taller than
/// the cap there, full height elsewhere.
#[test]
fn a_height_capped_zone_lowers_only_the_stretch_inside() {
    let mut req = panel_request(300.0, 120.0, [60, 24]);
    let (y0, y1, cap) = (50.0, 70.0, 2.0);
    let zone: Vec<u32> = (0..req.mesh.triangles.len() as u32)
        .filter(|&t| {
            let p = req.mesh.triangles[t as usize].map(|v| req.mesh.vertices[v as usize]);
            let y = (p[0][1] + p[1][1] + p[2][1]) / 3.0;
            y > y0 && y < y1
        })
        .collect();
    req.zones = vec![Zone {
        triangles: zone,
        mode: ZoneMode::MaxHeight(cap),
        margin: 0.0,
    }];
    let plan = plan_ribs(&req).unwrap();
    report(
        "300×120 panel, 2 mm height cap on the band 50 < y < 70",
        &plan,
    );
    let mut crossing = 0;
    for r in &plan.ribs {
        let mut inside = false;
        let mut outside_tall = false;
        for (w, h) in r.points.windows(2).zip(&r.heights) {
            let m = 0.5 * (w[0][1] + w[1][1]);
            if m > y0 + 1.0 && m < y1 - 1.0 {
                assert!(*h <= cap + 1e-9, "a stretch inside the zone is {h} mm tall");
                inside = true;
            } else if m < y0 - 6.0 || m > y1 + 6.0 {
                outside_tall |= *h > cap + 1e-9;
            }
        }
        if inside && outside_tall {
            crossing += 1;
        }
    }
    eprintln!("ribs crossing the band at reduced height: {crossing}");
    assert!(crossing >= 1);
}

/// The same request gives the same plan.
#[test]
fn plans_are_deterministic() {
    let mut req = panel_request(200.0, 80.0, [40, 16]);
    req.options.baselines = false;
    let a = plan_ribs(&req).unwrap();
    let b = plan_ribs(&req).unwrap();
    assert_eq!(a.ribs.len(), b.ribs.len());
    for (x, y) in a.ribs.iter().zip(&b.ribs) {
        assert_eq!(x.vertices, y.vertices);
        assert_eq!(x.heights, y.heights);
    }
    assert_eq!(a.mesh.triangles, b.mesh.triangles);
    assert!((a.ribbed.compliance - b.ribbed.compliance).abs() <= 1e-12 * a.ribbed.compliance);
}

/// Cancel after the third rib: the plan comes back at once with exactly
/// those three ribs, marked stopped, and numbers that agree with a fresh
/// solve of them; progress never goes back, and each rib was announced
/// with its polyline as it was chosen.
#[test]
fn cancel_returns_the_ribs_so_far_and_progress_only_grows() {
    use lime_sim::shell::planner::{plan_ribs_with, PlanControl, PlanEvent, RibChange};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;
    let mut req = panel_request(300.0, 120.0, [60, 24]);
    req.goal = Goal::Stiffer(1000.0);
    let cancel = AtomicBool::new(false);
    let log: Mutex<Vec<PlanEvent>> = Mutex::new(Vec::new());
    let sink = |e: &PlanEvent| {
        let mut l = log.lock().unwrap();
        l.push(e.clone());
        let added = l
            .iter()
            .filter(|e| matches!(e, PlanEvent::Rib(r) if r.change == RibChange::Added))
            .count();
        if added >= 3 {
            cancel.store(true, Ordering::Relaxed);
        }
    };
    let plan = plan_ribs_with(
        &req,
        PlanControl {
            progress: Some(&sink),
            cancel: Some(&cancel),
        },
    )
    .unwrap();
    let log = log.into_inner().unwrap();
    report("cancelled after 3 ribs", &plan);
    assert!(plan.stopped_early);
    assert_eq!(plan.ribs.len(), 3);
    assert!(plan.thickening.is_none() && plan.grid.is_none());
    // Fractions never go back.
    let mut last = 0.0;
    for e in &log {
        let f = match e {
            PlanEvent::Stage { fraction, .. } => *fraction,
            PlanEvent::Rib(r) => r.fraction,
        };
        assert!(f >= last, "{f} after {last}");
        assert!((0.0..=1.0).contains(&f));
        last = f;
    }
    // The rib events carry what was chosen, in order.
    let added: Vec<_> = log
        .iter()
        .filter_map(|e| match e {
            PlanEvent::Rib(r) if r.change == RibChange::Added => Some(r.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(added.len(), 3);
    for (ev, rib) in added.iter().zip(&plan.ribs) {
        assert_eq!(ev.points, rib.points);
        assert_eq!(ev.heights, rib.heights);
    }
    let last_rib = added.last().unwrap();
    assert_eq!(last_rib.ribs, 3);
    assert!((last_rib.compliance - plan.ribbed.compliance).abs() <= 1e-12 * plan.ribbed.compliance);
    assert!((last_rib.rib_volume_mm3 - plan.rib_volume_mm3).abs() < 1e-9);
    // The numbers agree with a fresh solve of the three ribs.
    let holds: Vec<ShellHold> = boundary_vertices(&plan.mesh)
        .into_iter()
        .map(ShellHold::clamped)
        .collect();
    let mut model = ShellModel::new(
        plan.mesh.clone(),
        material(E, NU),
        &holds,
        ShellOptions::default(),
    )
    .unwrap();
    let ribs: Vec<Rib> = plan
        .ribs
        .iter()
        .map(|r| Rib {
            edges: chain_edges(&r.vertices),
            width: r.width,
            height: r.height,
            side: r.side,
        })
        .collect();
    let bare = model
        .solve(&pressure(model.mesh(), 0.001))
        .unwrap()
        .compliance;
    model.set_ribs(ribs.clone()).unwrap();
    let ribbed = model
        .solve(&pressure(model.mesh(), 0.001))
        .unwrap()
        .compliance;
    assert!(
        (ribbed - plan.ribbed.compliance).abs() < 1e-9 * ribbed,
        "{ribbed} vs {}",
        plan.ribbed.compliance
    );
    assert!((bare / ribbed - plan.stiffness_factor).abs() < 1e-9 * plan.stiffness_factor);
    assert!(
        (rib_network_volume(&plan.mesh, &ribs) - plan.rib_volume_mm3).abs()
            < 1e-9 * plan.rib_volume_mm3
    );
}

/// One thread and one model, or many of each: the same plan, bit for bit.
#[test]
fn the_plan_does_not_depend_on_threads() {
    let mut req = panel_request(200.0, 80.0, [40, 16]);
    req.goal = Goal::Stiffer(2.5);
    let run = |threads: usize, workers: usize| {
        let mut r = req.clone();
        r.options.workers = workers;
        rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .build()
            .unwrap()
            .install(|| plan_ribs(&r).unwrap())
    };
    let one = run(1, 1);
    let many = run(12, 6);
    report("1 thread, 1 model", &one);
    report("12 threads, 6 models", &many);
    assert_eq!(one.ribs.len(), many.ribs.len());
    for (a, b) in one.ribs.iter().zip(&many.ribs) {
        assert_eq!(a.vertices, b.vertices);
        assert_eq!(a.heights, b.heights);
    }
    assert_eq!(
        one.ribbed.compliance.to_bits(),
        many.ribbed.compliance.to_bits()
    );
    assert_eq!(one.rib_volume_mm3.to_bits(), many.rib_volume_mm3.to_bits());
    let (ta, tb) = (one.thickening.unwrap(), many.thickening.unwrap());
    assert_eq!(ta.added_volume_mm3.to_bits(), tb.added_volume_mm3.to_bits());
}

/// Time and solves for the 600 × 120 panel at about 5k and 20k triangles,
/// by arrangement: models side by side and candidates solved per round.
/// Measure in release:
/// `cargo test -p lime-sim --release --test rib_planner planning_time -- --ignored --nocapture`
#[test]
#[ignore]
fn planning_time_by_triangle_count() {
    eprintln!("| triangles | cut in | models | shortlist | candidates | ribs | factor | rib mm³ | plan solves | baseline solves | bare s | trace+embed s | select s | connect s | prune s | size s | solver s | baselines s | total s |");
    for div in [[100, 25], [200, 50]] {
        // Also measured once: shortlist 16 took 29.1 s and every candidate
        // (858 solves) 83.8 s at 20k, for the same plan.
        for (workers, shortlist) in [(1usize, 4usize), (8, 4), (8, 8)] {
            let mut req = panel_request(600.0, 120.0, div);
            req.goal = Goal::Stiffer(3.0);
            req.options.workers = workers;
            req.options.shortlist = shortlist;
            let p = plan_ribs(&req).unwrap();
            let s = p.stats.seconds;
            eprintln!(
                "| {} | {} | {workers} | {} | {} | {} | {:.2} | {:.0} | {} | {} | {:.2} | {:.2} | {:.2} | {:.2} | {:.2} | {:.2} | {:.2} | {:.2} | {:.2} |",
                p.stats.input_triangles,
                p.stats.embedded_triangles,
                if shortlist == 0 { "all".to_string() } else { shortlist.to_string() },
                p.stats.embedded_candidates,
                p.ribs.len(),
                p.stiffness_factor,
                p.rib_volume_mm3,
                p.stats.solves,
                p.stats.baseline_solves,
                s.bare,
                s.trace + s.embed,
                s.select,
                s.connect,
                s.prune,
                s.size,
                s.solver,
                s.baselines,
                s.total
            );
        }
    }
}
/// What exact scoring costs, to choose between a fresh factor per
/// candidate and a low-rank (Woodbury) update of the current factor, and
/// how to spread candidate factorisations over the cores. Measure in
/// release:
/// `cargo test -p lime-sim --release --test rib_planner scoring_cost -- --ignored --nocapture`
#[test]
#[ignore]
fn scoring_cost_and_thread_arrangement() {
    use std::time::Instant;
    // The planner's cut-in meshes of the 600 × 120 panel come to about
    // 15k and 39k triangles; regular meshes of that size stand in.
    for div in [[175usize, 43usize], [280, 70]] {
        let mesh = ShellMesh::rectangle([600.0, 120.0], div, 2.0);
        let tris = mesh.triangles.len();
        let holds: Vec<ShellHold> = boundary_vertices(&mesh)
            .into_iter()
            .map(ShellHold::clamped)
            .collect();
        let row = |j: usize| -> Vec<u32> {
            (0..=div[0])
                .map(|i| (i + (div[0] + 1) * j) as u32)
                .collect()
        };
        let col = |i: usize| -> Vec<u32> {
            (0..=div[1])
                .map(|j| (i + (div[0] + 1) * j) as u32)
                .collect()
        };
        let rib = |chain: Vec<u32>| Rib {
            edges: chain_edges(&chain),
            width: 1.2,
            height: 6.0,
            side: RibSide::Positive,
        };
        let make = || {
            ShellModel::new(
                mesh.clone(),
                material(E, NU),
                &holds,
                ShellOptions::default(),
            )
            .unwrap()
        };
        let mut m = make();
        let case = pressure(m.mesh(), 0.001);
        m.set_ribs(vec![rib(col(div[0] / 3))]).unwrap();
        m.solve(&case).unwrap();
        let t = m.timings();
        eprintln!(
            "| {tris} tris, {} free dofs | refactor: rib rebuild {:.3} s, ordering {:.3} s, factor {:.3} s, solve 1 rhs {:.4} s |",
            m.free_dofs(), t.assemble_ribs, t.analyse, t.factor, t.solve
        );
        // Multi-rhs solves on the same factor: Woodbury needs one column per
        // dof the rib touches (6 per rib vertex).
        for k in [6usize, 36, 216, 1080] {
            let cases: Vec<Vec<ShellLoad>> = (0..k)
                .map(|q| {
                    vec![ShellLoad::Force {
                        node: (q % mesh.vertices.len()) as u32,
                        force: [0.0, 0.0, 1.0],
                    }]
                })
                .collect();
            let started = Instant::now();
            m.solve_cases(&cases).unwrap();
            let all = started.elapsed().as_secs_f64();
            eprintln!(
                "|   {k} rhs: solve {:.3} s ({:.4} s per rhs), with recovery {all:.2} s | a cross rib has {} vertices ({} dofs), a long one {} ({} dofs) |",
                m.timings().solve,
                m.timings().solve / k as f64,
                div[1] + 1,
                6 * (div[1] + 1),
                div[0] + 1,
                6 * (div[0] + 1),
            );
        }
        // Eight candidate ribs scored by refactoring, arranged four ways.
        let cands: Vec<Rib> = (1..=8).map(|q| rib(col(q * div[0] / 9))).collect();
        let _ = row;
        let started = Instant::now();
        let mut seq = make();
        let mut seq_c = Vec::new();
        for r in &cands {
            seq.set_ribs(vec![r.clone()]).unwrap();
            seq_c.push(seq.solve(&case).unwrap().compliance);
        }
        let sequential = started.elapsed().as_secs_f64();
        eprintln!("|   8 candidates, one model, factor on up to 8 threads: {sequential:.2} s |");
        for (workers, threads) in [(8usize, 1usize), (4, 2), (2, 4), (4, 4), (8, 3)] {
            use rayon::prelude::*;
            let mut models: Vec<ShellModel> = (0..workers).map(|_| make()).collect();
            for m in &mut models {
                m.set_threads(threads);
            }
            let started = Instant::now();
            let got: Vec<(usize, f64)> = models
                .par_iter_mut()
                .enumerate()
                .flat_map_iter(|(w, m)| {
                    let mut out = Vec::new();
                    for (q, r) in cands.iter().enumerate().filter(|(q, _)| q % workers == w) {
                        m.set_ribs(vec![r.clone()]).unwrap();
                        out.push((q, m.solve(&case).unwrap().compliance));
                    }
                    out
                })
                .collect();
            let wall = started.elapsed().as_secs_f64();
            let worst = got
                .iter()
                .map(|(q, c)| ((c - seq_c[*q]) / seq_c[*q]).abs())
                .fold(0.0, f64::max);
            eprintln!(
                "|   8 candidates, {workers} models × {threads} threads: {wall:.2} s ({:.2}× the single model), largest compliance difference {worst:.1e} |",
                sequential / wall
            );
        }
    }
}
