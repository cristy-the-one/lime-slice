//! Ribs as they are built: free ends tapered the way `ribNet` builds them
//! (the planner's [`EndTaper`]), and the border-fixity check (the plan
//! solved again with its held borders pinned). Synthetic walls only.
//!
//! Each case prints a row with its numbers.

mod shell_common;

use lime_sim::assemble::{Hold, Load, NodeHold};
use lime_sim::mesh::faces_on_plane;
use lime_sim::shell::planner::{
    plan_ribs, solve_paths, EndTaper, Goal, Holds, PathSolve, RibEndKind, RibPath, RibPlanRequest,
    RibProfile, PINNED_RETAINED_FLOOR,
};
use lime_sim::shell::{ShellHold, ShellLoad, ShellMesh};
use shell_common::*;

const E: f64 = 2000.0;
const NU: f64 = 0.35;
const W: f64 = 1.2;
const H: f64 = 6.0;

fn request(mesh: ShellMesh, taper: EndTaper) -> RibPlanRequest {
    let mut req = RibPlanRequest::new(mesh, material(E, NU));
    req.rules.width = W;
    req.rules.max_height = H;
    req.rules.profile = RibProfile::Rectangular;
    req.rules.end_taper = taper;
    req.options.baselines = false;
    req
}

fn path(points: &[[f64; 2]], h: f64) -> RibPath {
    RibPath {
        points: points.iter().map(|p| [p[0], p[1], 0.0]).collect(),
        heights: vec![h; points.len() - 1],
    }
}

fn row(name: &str, s: &PathSolve) {
    eprintln!(
        "| {name} | ribs {} | ×{:.4} compliance, ×{:.4} peak | {:.1} mm³ | pinned {} |",
        s.ribs.len(),
        s.stiffness_factor,
        s.peak_factor,
        s.rib_volume_mm3,
        s.pinned.map_or("-".into(), |p| format!(
            "×{:.4} compliance, ×{:.4} peak, retained {:.3}, needs rigid borders {}",
            p.compliance_factor, p.peak_factor, p.retained, p.needs_rigid_borders
        )),
    );
    for r in &s.ribs {
        eprintln!(
            "|   rib | {:.1} mm | ends {:?} | taper {:?} | {:.1} mm³ |",
            r.length_mm, r.ends, r.taper_mm, r.volume_mm3
        );
    }
}

/// A 40 mm stub from a clamped border into a 120 × 60 plate: its free end
/// tapered over 3 × 6 mm is less stiff and lighter than a square end, and
/// its volume is the analytic one, `w h (ℓ − L/2)`.
#[test]
fn a_tapered_stub_is_lighter_and_less_stiff_and_its_volume_is_analytic() {
    let mesh = ShellMesh::rectangle([120.0, 60.0], [120, 60], 2.0);
    let stub = [path(&[[0.0, 30.0], [40.0, 30.0]], H)];
    let square = solve_paths(&request(mesh.clone(), EndTaper::None), &stub).unwrap();
    let tapered = solve_paths(&request(mesh, EndTaper::TimesHeight(3.0)), &stub).unwrap();
    row("stub, square end", &square);
    row("stub, tapered 18 mm", &tapered);
    let r = &tapered.ribs[0];
    assert_eq!(r.ends, [RibEndKind::Boundary, RibEndKind::Free]);
    assert_eq!(r.taper_mm, [0.0, 18.0]);
    assert!(r.heights.iter().all(|&h| h == H), "{:?}", r.heights);
    assert!(
        *r.built_heights.last().unwrap() < 0.5,
        "{:?}",
        r.built_heights
    );
    let analytic = W * H * (40.0 - 0.5 * 18.0);
    let err = tapered.rib_volume_mm3 / analytic - 1.0;
    eprintln!(
        "| stub volume | tapered {:.2} mm³ | analytic {analytic:.2} mm³ | error {:+.2} % | square {:.2} mm³ (analytic {:.2}) |",
        tapered.rib_volume_mm3,
        100.0 * err,
        square.rib_volume_mm3,
        W * H * 40.0
    );
    assert!(
        err.abs() < 0.02,
        "tapered volume off by {:.2} %",
        100.0 * err
    );
    assert!(tapered.rib_volume_mm3 < square.rib_volume_mm3);
    assert!(tapered.stiffness_factor < square.stiffness_factor);
    assert!(tapered.stiffness_factor > 1.0);
}

/// A rib from border to border has no free end and is not tapered; a rib
/// that ends on another is not tapered at that end; a rib that stops in
/// mid-wall is, at that end only.
#[test]
fn only_free_ends_taper() {
    let mesh = ShellMesh::rectangle([120.0, 60.0], [120, 60], 2.0);
    let paths = [
        path(&[[60.0, 0.0], [60.0, 60.0]], H),
        path(&[[0.0, 30.0], [60.0, 30.0]], H),
        path(&[[120.0, 45.0], [90.0, 45.0]], H),
    ];
    let s = solve_paths(&request(mesh, EndTaper::TimesHeight(3.0)), &paths).unwrap();
    row("border to border, onto a rib, free", &s);
    assert_eq!(s.kept, vec![0, 1, 2]);
    let [a, b, c] = [&s.ribs[0], &s.ribs[1], &s.ribs[2]];
    assert_eq!(a.ends, [RibEndKind::Boundary, RibEndKind::Boundary]);
    assert_eq!(a.taper_mm, [0.0, 0.0]);
    assert_eq!(a.built_heights, a.heights);
    assert_eq!(b.ends, [RibEndKind::Boundary, RibEndKind::Rib]);
    assert_eq!(b.taper_mm, [0.0, 0.0]);
    assert_eq!(b.built_heights, b.heights);
    assert_eq!(c.ends, [RibEndKind::Boundary, RibEndKind::Free]);
    assert_eq!(c.taper_mm, [0.0, 18.0]);
    // Full height until 18 mm from the free end, then falling.
    for (k, (&h, &built)) in c.heights.iter().zip(&c.built_heights).enumerate() {
        let mid = 0.5 * (c.points[k][0] + c.points[k + 1][0]);
        let from_end = mid - 90.0;
        let want = H * (from_end / 18.0).min(1.0);
        assert!(
            (built - want.min(h)).abs() < 1e-9,
            "edge {k}: {built} vs {want}"
        );
    }
}

/// A cantilever strip 100 × 12 × 2, clamped at its root, 1 N at its tip,
/// with a 2 × 6 rib from the root to 60 mm, its end square or tapered over
/// 18 mm: the shell (the planner's model) against TET10 bricks of the
/// same strip (half on its symmetry plane; the taper a staircase of 1 mm
/// cells). Returns the tip deflections.
fn strip_shell(taper: Option<EndTaper>) -> f64 {
    let (l, b, t) = (100.0, 12.0, 2.0);
    let mesh = ShellMesh::rectangle([l, b], [100, 12], t);
    let holds: Vec<ShellHold> = (0..mesh.vertices.len())
        .filter(|&i| mesh.vertices[i][0].abs() < TOL)
        .map(|i| ShellHold::clamped(i as u32))
        .collect();
    let mut case = Vec::new();
    for (i, v) in mesh.vertices.iter().enumerate() {
        if (v[0] - l).abs() < TOL {
            let share = if v[1].abs() < TOL || (v[1] - b).abs() < TOL {
                0.5
            } else {
                1.0
            };
            case.push(ShellLoad::Force {
                node: i as u32,
                force: [0.0, 0.0, -share / 12.0],
            });
        }
    }
    let mut req = request(mesh, taper.unwrap_or(EndTaper::None));
    req.rules.width = 2.0;
    req.holds = Holds::Given(holds);
    req.load_cases = vec![case];
    req.options.fixity_check = false;
    let paths = if taper.is_some() {
        vec![path(&[[0.0, 6.0], [60.0, 6.0]], H)]
    } else {
        Vec::new()
    };
    let s = solve_paths(&req, &paths).unwrap();
    if taper.is_some() {
        s.ribbed.max_deflection
    } else {
        s.bare.max_deflection
    }
}

fn strip_solid(rib: Option<f64>) -> (f64, usize) {
    let (l, half, t) = (100.0, 6.0, 2.0);
    let mut xs = cells(0.0, 30.0, 2.0, false);
    xs.extend(cells(30.0, 70.0, 1.0, true));
    xs.extend(cells(70.0, l, 2.0, true));
    let mut ys = vec![0.0, 0.5, 1.0];
    ys.extend(cells(1.0, half, 1.0, true));
    let mut zs = vec![-0.5 * t, 0.0, 0.5 * t];
    zs.extend(cells(0.5 * t, 0.5 * t + H, 0.75, true));
    let mesh = graded_solid(&xs, &ys, &zs, |c| {
        if c[2] < 0.5 * t {
            return true;
        }
        let Some(taper) = rib else { return false };
        let top = if taper > 0.0 {
            H * ((60.0 - c[0]) / taper).clamp(0.0, 1.0)
        } else if c[0] < 60.0 {
            H
        } else {
            0.0
        };
        c[1] < 1.0 && c[2] - 0.5 * t < top
    });
    let mut holds = Vec::new();
    for (i, p) in mesh.nodes.iter().enumerate() {
        if p[0].abs() < TOL {
            holds.push(NodeHold {
                node: i,
                hold: Hold::Fixed,
            });
        } else if p[1].abs() < TOL {
            holds.push(NodeHold {
                node: i,
                hold: Hold::Axis {
                    axis: 1,
                    value: 0.0,
                },
            });
        }
    }
    let faces = faces_on_plane(&mesh, 0, l, 1e-6);
    let end: f64 = faces.iter().map(|f| f.area).sum();
    let loads: Vec<Load> = faces
        .into_iter()
        .map(|f| Load::Traction {
            nodes: f.nodes,
            traction: [0.0, 0.0, -0.5 / end],
        })
        .collect();
    let tip = nearest_node(&mesh, [l, 0.0, 0.0]);
    let nodes = mesh.nodes.len();
    let s = tet_solve(mesh, E, NU, holds, loads);
    (-s.displacement[tip][2], nodes)
}

#[test]
fn a_tapered_end_against_the_solid() {
    let t = std::time::Instant::now();
    let shell = [
        strip_shell(None),
        strip_shell(Some(EndTaper::None)),
        strip_shell(Some(EndTaper::TimesHeight(3.0))),
    ];
    let solid = [
        strip_solid(None),
        strip_solid(Some(0.0)),
        strip_solid(Some(18.0)),
    ];
    let names = ["bare", "square end", "tapered 18 mm"];
    for k in 0..3 {
        eprintln!(
            "| strip tip, {} | shell {:.6} mm | solid {:.6} mm ({} nodes) | {:+.2} % |",
            names[k],
            shell[k],
            solid[k].0,
            solid[k].1,
            100.0 * (shell[k] / solid[k].0 - 1.0)
        );
    }
    // What the taper costs: tip deflection, tapered over square end.
    let cost_shell = shell[2] / shell[1] - 1.0;
    let cost_solid = solid[2].0 / solid[1].0 - 1.0;
    // What each rib gives: bare tip over ribbed tip.
    let gain = |b: f64, r: f64| b / r;
    eprintln!(
        "| strip | taper softens the tip: shell {:+.2} %, solid {:+.2} % | gain square ×{:.4} shell, ×{:.4} solid | tapered ×{:.4} shell, ×{:.4} solid | {:.1} s |",
        100.0 * cost_shell,
        100.0 * cost_solid,
        gain(shell[0], shell[1]),
        gain(solid[0].0, solid[1].0),
        gain(shell[0], shell[2]),
        gain(solid[0].0, solid[2].0),
        t.elapsed().as_secs_f64()
    );
    assert!(cost_shell > 0.0 && cost_solid > 0.0);
    // The taper's effect within a fifth of the solid's, and the tapered
    // rib's gain within 3 %.
    assert!(
        (cost_shell / cost_solid - 1.0).abs() < 0.2,
        "taper effect: shell {cost_shell} vs solid {cost_solid}"
    );
    let g_shell = gain(shell[0], shell[2]);
    let g_solid = gain(solid[0].0, solid[2].0);
    assert!(
        (g_shell / g_solid - 1.0).abs() < 0.03,
        "tapered gain: shell {g_shell} vs solid {g_solid}"
    );
}

/// A 200 × 80 floor with a 180 × 30 opening down its middle, held round
/// its outside only (the opening free, ribs kept 3 mm off its rim): the
/// 25 mm bands beside the opening can only take stubs from the long walls,
/// whose free ends taper.
fn holed_floor() -> ShellMesh {
    let full = ShellMesh::rectangle([200.0, 80.0], [100, 40], 2.0);
    cut_mesh(&full, |c| {
        (c[0] - 100.0).abs() < 90.0 && (c[1] - 40.0).abs() < 15.0
    })
}

#[test]
fn a_stiffness_goal_is_met_by_the_tapered_ribs() {
    let goal = 1.2;
    let mut req = request(holed_floor(), EndTaper::TimesHeight(3.0));
    req.holds = Holds::OuterBoundaryClamped;
    req.goal = Goal::Stiffer(goal);
    let plan = plan_ribs(&req).unwrap();
    let tapered: usize = plan
        .ribs
        .iter()
        .map(|r| r.taper_mm.iter().filter(|&&t| t > 0.0).count())
        .sum();
    eprintln!(
        "| holed floor, ×{goal} | ribs {} | ×{:.4} compliance, ×{:.4} peak | {:.1} mm³ | tapered ends {tapered} | goal met {} | retries {} | pinned {:?} | {:.1} s |",
        plan.ribs.len(),
        plan.stiffness_factor,
        plan.peak_factor,
        plan.rib_volume_mm3,
        plan.goal_met,
        plan.stats.clean_retries,
        plan.pinned.map(|p| (p.compliance_factor, p.retained, p.needs_rigid_borders)),
        plan.stats.seconds.total,
    );
    // The same ribs, square-ended: what the plan would have claimed.
    let paths: Vec<RibPath> = plan
        .ribs
        .iter()
        .map(|r| RibPath {
            points: r.points.clone(),
            heights: r.heights.clone(),
        })
        .collect();
    let mut square_req = req.clone();
    square_req.rules.end_taper = EndTaper::None;
    let square = solve_paths(&square_req, &paths).unwrap();
    let again = solve_paths(&req, &paths).unwrap();
    eprintln!(
        "| same ribs | tapered re-solve ×{:.4} ({:.1} mm³) | square ends ×{:.4} ({:.1} mm³) |",
        again.stiffness_factor,
        again.rib_volume_mm3,
        square.stiffness_factor,
        square.rib_volume_mm3
    );
    assert!(tapered > 0, "the case needs a free end to test the taper");
    assert!(plan.goal_met);
    assert!(plan.stiffness_factor >= goal);
    // An independent cut of the same ribs, tapered from their own ends,
    // gives the same factor.
    assert!((again.stiffness_factor / plan.stiffness_factor - 1.0).abs() < 0.01);
    assert!(again.stiffness_factor >= goal * 0.99);
    assert!((again.rib_volume_mm3 / plan.rib_volume_mm3 - 1.0).abs() < 0.01);
    assert!(square.rib_volume_mm3 > plan.rib_volume_mm3);
    let pinned = plan.pinned.expect("the fixity check runs");
    assert!(pinned.compliance_factor < plan.stiffness_factor);
}

/// Short stubs along the long walls of a clamped 300 × 60 strip work only
/// because the walls hold the strip square: pinned, they give almost
/// nothing, and the plan says so.
#[test]
fn stubs_on_a_clamped_strip_need_rigid_borders() {
    let mesh = ShellMesh::rectangle([300.0, 60.0], [150, 30], 2.0);
    let mut paths = Vec::new();
    for k in 0..5 {
        let x = 50.0 + 50.0 * k as f64;
        paths.push(path(&[[x, 0.0], [x, 20.0]], H));
        paths.push(path(&[[x, 60.0], [x, 40.0]], H));
    }
    let s = solve_paths(&request(mesh, EndTaper::TimesHeight(3.0)), &paths).unwrap();
    row("300×60 strip, 10 stubs of 20 mm", &s);
    let p = s.pinned.unwrap();
    assert!(s.stiffness_factor > 1.05);
    assert!(p.needs_rigid_borders, "{p:?}");
    assert!(p.retained < PINNED_RETAINED_FLOOR);
}

/// A rib across a 120 × 70 panel, border to border, works pinned or
/// clamped: no warning.
#[test]
fn a_rib_across_a_panel_does_not_need_rigid_borders() {
    let mesh = ShellMesh::rectangle([120.0, 70.0], [60, 35], 2.0);
    let s = solve_paths(
        &request(mesh, EndTaper::TimesHeight(3.0)),
        &[path(&[[60.0, 0.0], [60.0, 70.0]], H)],
    )
    .unwrap();
    row("120×70 panel, one rib across", &s);
    let p = s.pinned.unwrap();
    assert!(!p.needs_rigid_borders, "{p:?}");
    assert!(p.retained >= PINNED_RETAINED_FLOOR);
    assert!(p.compliance_factor > 1.5);
}

/// Before/after numbers and wall time, release:
/// `cargo test -p lime-sim --release --test rib_taper plan_time -- --ignored --nocapture`
#[test]
#[ignore]
fn plan_time_with_tapers_and_the_fixity_check() {
    let holed = || {
        let mut r = RibPlanRequest::new(holed_floor(), material(E, NU));
        r.holds = Holds::OuterBoundaryClamped;
        r
    };
    type Case = (&'static str, Box<dyn Fn() -> RibPlanRequest>, Goal);
    let cases: Vec<Case> = vec![
        (
            "600x120 20k",
            Box::new(|| {
                RibPlanRequest::new(
                    ShellMesh::rectangle([600.0, 120.0], [200, 50], 2.0),
                    material(E, NU),
                )
            }),
            Goal::Stiffer(3.0),
        ),
        (
            "120x70 floor",
            Box::new(|| {
                RibPlanRequest::new(
                    ShellMesh::rectangle([120.0, 70.0], [60, 35], 2.0),
                    material(E, NU),
                )
            }),
            Goal::Stiffer(2.0),
        ),
        (
            "120x70 floor balanced",
            Box::new(|| {
                RibPlanRequest::new(
                    ShellMesh::rectangle([120.0, 70.0], [60, 35], 2.0),
                    material(E, NU),
                )
            }),
            Goal::Balanced,
        ),
        ("holed floor x1.2", Box::new(holed), Goal::Stiffer(1.2)),
    ];
    for (name, make, goal) in &cases {
        for (label, taper, fixity) in [
            ("square, no check", EndTaper::None, false),
            ("tapered 3h + check", EndTaper::TimesHeight(3.0), true),
        ] {
            let mut req = make();
            req.goal = *goal;
            req.rules.end_taper = taper;
            req.options.fixity_check = fixity;
            let p = plan_ribs(&req).unwrap();
            let tapered: usize = p
                .ribs
                .iter()
                .map(|r| r.taper_mm.iter().filter(|&&t| t > 0.0).count())
                .sum();
            eprintln!(
                "| {name} | {label} | tris {} | ribs {} (tapered ends {tapered}) | ×{:.4} compliance | ×{:.4} peak | {:.1} mm³ | goal {} | pinned {} | solves {}+{} | total {:.2} s | select {:.2} | size {:.2} | baselines {:.2} | fixity {:.2} |",
                p.stats.input_triangles,
                p.ribs.len(),
                p.stiffness_factor,
                p.peak_factor,
                p.rib_volume_mm3,
                p.goal_met,
                p.pinned.map_or("-".into(), |q| format!("×{:.4} retained {:.3}{}", q.compliance_factor, q.retained, if q.needs_rigid_borders { " WARN" } else { "" })),
                p.stats.solves,
                p.stats.baseline_solves,
                p.stats.seconds.total,
                p.stats.seconds.select,
                p.stats.seconds.size,
                p.stats.seconds.baselines,
                p.stats.seconds.fixity,
            );
        }
    }
}
