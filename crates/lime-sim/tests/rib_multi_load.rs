//! Several load cases on one wall.
//!
//! v6.11.0 summed compliance, so a load ten times the other (about a
//! hundred times the compliance) spent the rib material on itself. The
//! constants `SUMMED_*` are that measurement. The planner now minimises
//! `sum w_i C_i / C_i0`.

mod shell_common;

use lime_sim::shell::planner::{
    boundary_vertices, plan_ribs, Family, Goal, Holds, LoadCombine, PlannerOptions, RibEndKind,
    RibPlan, RibPlanRequest,
};
use lime_sim::shell::{Rib, ShellHold, ShellLoad, ShellMesh, ShellModel, ShellOptions};
use shell_common::{cylinder_segment, material};

const E: f64 = 2000.0;
const NU: f64 = 0.35;

/// Clamped 160 × 80 mm wall, 2 mm thick. Two point loads on the centre
/// line, 40 mm in from either short edge: opposed places, same direction.
fn opposed_request(scale_left: f64, right: bool) -> (RibPlanRequest, [u32; 2]) {
    let mesh = ShellMesh::rectangle([160.0, 80.0], [24, 12], 2.0);
    let left = mesh.nearest_vertex([40.0, 40.0, 0.0]);
    let right_at = mesh.nearest_vertex([120.0, 40.0, 0.0]);
    let mut cases = vec![vec![ShellLoad::Force {
        node: left,
        force: [0.0, 0.0, -scale_left],
    }]];
    if right {
        cases.push(vec![ShellLoad::Force {
            node: right_at,
            force: [0.0, 0.0, -1.0],
        }]);
    }
    let mut req = RibPlanRequest::new(mesh, material(E, NU));
    req.holds = Holds::AllBoundaryClamped;
    req.load_cases = cases;
    req.goal = Goal::Budget { volume_mm3: 1800.0 };
    req.rules.min_spacing = 18.0;
    req.rules.min_length = 12.0;
    req.options.baselines = false;
    req.options.close_loose_ends = true;
    (req, [left, right_at])
}

/// `C_i0 / C_i` of `plan` under the same point loads, solved on the plan's
/// own mesh. The loaded vertices keep their indexes when ribs are cut in.
fn case_factors(plan: &RibPlan, nodes: &[u32], scales: &[f64]) -> Vec<f64> {
    assert_eq!(nodes.len(), scales.len());
    let holds: Vec<ShellHold> = boundary_vertices(&plan.mesh)
        .into_iter()
        .map(ShellHold::clamped)
        .collect();
    let cases: Vec<Vec<ShellLoad>> = nodes
        .iter()
        .zip(scales)
        .map(|(&node, &scale)| {
            vec![ShellLoad::Force {
                node,
                force: [0.0, 0.0, -scale],
            }]
        })
        .collect();
    let mut model = ShellModel::new(
        plan.mesh.clone(),
        material(E, NU),
        &holds,
        ShellOptions::default(),
    )
    .unwrap();
    let bare = model.solve_cases(&cases).unwrap();
    let ribs: Vec<Rib> = plan
        .ribs
        .iter()
        .flat_map(|r| {
            r.profile
                .solver_ribs(&r.vertices, &r.heights, r.width, r.side)
        })
        .collect();
    model.set_ribs(ribs).unwrap();
    let ribbed = model.solve_cases(&cases).unwrap();
    bare.iter()
        .zip(&ribbed)
        .map(|(b, r)| b.compliance / r.compliance)
        .collect()
}

fn mean_x(plan: &RibPlan) -> f64 {
    let mut w = 0.0;
    let mut x = 0.0;
    for r in &plan.ribs {
        for seg in r.points.windows(2) {
            let len = (0..3)
                .map(|k| (seg[1][k] - seg[0][k]).powi(2))
                .sum::<f64>()
                .sqrt();
            w += len;
            x += len * 0.5 * (seg[0][0] + seg[1][0]);
        }
    }
    if w > 0.0 {
        x / w
    } else {
        f64::NAN
    }
}

fn close_to(got: f64, want: f64) {
    let tol = 1e-9 * want.abs().max(1.0);
    assert!((got - want).abs() <= tol, "{got} vs {want}");
}

fn dump(label: &str, plan: &RibPlan, factors: &[f64]) {
    eprintln!(
        "| {label} | ribs {} | vol {:.6} | combined {:.12} | per-case {} | mean x {:.6} | {:.6} s |",
        plan.ribs.len(),
        plan.rib_volume_mm3,
        plan.stiffness_factor,
        factors
            .iter()
            .map(|f| format!("{f:.12}"))
            .collect::<Vec<_>>()
            .join(" "),
        mean_x(plan),
        plan.stats.seconds.total
    );
    for r in &plan.ribs {
        let a = r.points[0];
        let b = *r.points.last().unwrap();
        eprintln!(
            "|   rib | ({:.2}, {:.2}) → ({:.2}, {:.2}) | {:.1} mm × {:.2} |",
            a[0], a[1], b[0], b[1], r.length_mm, r.height
        );
    }
}

/// What summing the two compliances did on this panel, at v6.11.0. The
/// ×10 column is the bad one: case 2 stayed at 1.002, the same miss as
/// planning for the left load alone.
const SUMMED_EQUAL: [f64; 2] = [2.146639343320, 2.114592183597];
const SUMMED_HEAVY: [f64; 2] = [3.469144151550, 1.002061434711];
const SUMMED_LEFT_ON_BOTH: [f64; 2] = [3.459900734848, 1.002059653687];

/// Weighted objective. Equal loads keep the summed plan (the two bare
/// compliances match, so the weights are equal). ×10 is normalised and
/// comes out the same plan: both cases near 2.13×, where the sum had
/// left case 2 at 1.002. The left load alone still misses the right one.
#[test]
fn weighted_objective_serves_both_opposed_loads() {
    let (eq, nodes) = opposed_request(1.0, true);
    let eq_plan = plan_ribs(&eq).unwrap();
    let eq_f = case_factors(&eq_plan, &nodes, &[1.0, 1.0]);
    dump("equal loads, weighted", &eq_plan, &eq_f);

    let (heavy, _) = opposed_request(10.0, true);
    let heavy_plan = plan_ribs(&heavy).unwrap();
    let heavy_f = case_factors(&heavy_plan, &nodes, &[10.0, 1.0]);
    dump("left ×10, weighted", &heavy_plan, &heavy_f);

    let (only, _) = opposed_request(1.0, false);
    let only_plan = plan_ribs(&only).unwrap();
    let only_f = case_factors(&only_plan, &nodes, &[1.0, 1.0]);
    dump("left alone, factors on both loads", &only_plan, &only_f);

    assert_eq!(eq_plan.ribs.len(), 8, "equal loads");
    assert_eq!(heavy_plan.ribs.len(), 8, "left ×10, normalised");
    assert_eq!(only_plan.ribs.len(), 7, "left alone");
    // Equal bare compliances: the weighted plan is the old summed plan.
    for (got, want) in eq_f.iter().zip(SUMMED_EQUAL) {
        close_to(*got, want);
    }
    // ×10 used to be SUMMED_HEAVY (3.469 and 1.002). Normalised, it is the
    // equal-load plan: both cases move, and the ribs sit in the middle.
    for (got, want) in heavy_f.iter().zip(SUMMED_EQUAL) {
        close_to(*got, want);
    }
    assert!(
        (heavy_f[1] - SUMMED_HEAVY[1]).abs() > 1.0,
        "case 2 was ignored at {:.6} and is not now",
        SUMMED_HEAVY[1]
    );
    for (got, want) in only_f.iter().zip(SUMMED_LEFT_ON_BOTH) {
        close_to(*got, want);
    }
    close_to(eq_plan.stiffness_factor, 2.130495255991);
    close_to(heavy_plan.stiffness_factor, 2.130495255991);
    close_to(only_plan.stiffness_factor, 3.459900734848);
    // The plan's own per-case factors are the re-solve.
    for (got, want) in eq_plan.case_factors.iter().zip(&eq_f) {
        close_to(*got, *want);
    }
    for (got, want) in heavy_plan.case_factors.iter().zip(&heavy_f) {
        close_to(*got, *want);
    }
    assert!(only_f[1] < 1.01, "left-only ribs miss the right load");
    assert!(heavy_f[1] > 2.0, "normalised ×10 still serves case 2");
    assert!(
        (mean_x(&heavy_plan) - 80.0).abs() < 2.0,
        "{}",
        mean_x(&heavy_plan)
    );
    assert!(
        (mean_x(&eq_plan) - 80.0).abs() < 2.0,
        "{}",
        mean_x(&eq_plan)
    );
    assert!(mean_x(&only_plan) < 50.0, "{}", mean_x(&only_plan));
}

/// A weight on the right-hand load moves the ribs toward it.
#[test]
fn a_weight_pulls_ribs_toward_that_load() {
    let (mut req, nodes) = opposed_request(1.0, true);
    req.case_weights = vec![1.0, 8.0];
    let plan = plan_ribs(&req).unwrap();
    let f = case_factors(&plan, &nodes, &[1.0, 1.0]);
    dump("weights 1 and 8", &plan, &f);
    assert!(
        mean_x(&plan) > 100.0,
        "ribs should sit right of centre, x {}",
        mean_x(&plan)
    );
    assert!(f[1] > f[0], "the heavier case gains more: {f:?}");
    assert_eq!(plan.case_factors.len(), 2);
}

/// Thickening and an even grid brought to the same combined stiffness.
#[test]
fn material_at_the_same_combined_stiffness() {
    let (mut req, nodes) = opposed_request(10.0, true);
    req.options.baselines = true;
    let plan = plan_ribs(&req).unwrap();
    let f = case_factors(&plan, &nodes, &[10.0, 1.0]);
    let th = plan.thickening.expect("thickening");
    let grid = plan.grid.expect("grid");
    eprintln!(
        "| material | ribs {:.1} mm³ ×{:.4} | thickening {:.1} mm³ ({:.3} mm) | grid {:?} mm³ pitch {:.2} | cases {f:?} |",
        plan.rib_volume_mm3,
        plan.stiffness_factor,
        th.added_volume_mm3,
        th.added_thickness_mm,
        grid.volume_mm3,
        grid.pitch_mm
    );
    assert!(f[0] > 2.0 && f[1] > 2.0, "{f:?}");
    assert!(th.added_volume_mm3 > plan.rib_volume_mm3);
    let grid_v = grid.volume_mm3.expect("the grid reaches the factor");
    assert!(grid_v > plan.rib_volume_mm3);
}

/// Pressure on each half of the panel, so an even grid is a real
/// competitor: several lines, pitch below the panel length. The point-load
/// panel's grid collapsed to a 160 mm pitch.
#[test]
fn an_even_grid_competes_under_half_panel_pressure() {
    let mesh = ShellMesh::rectangle([160.0, 80.0], [24, 12], 2.0);
    let mut left = Vec::new();
    let mut right = Vec::new();
    for (i, tri) in mesh.triangles.iter().enumerate() {
        let x: f64 = tri
            .map(|v| mesh.vertices[v as usize][0])
            .into_iter()
            .sum::<f64>()
            / 3.0;
        if x < 80.0 {
            left.push(i as u32);
        } else {
            right.push(i as u32);
        }
    }
    let mut req = RibPlanRequest::new(mesh, material(E, NU));
    req.load_cases = vec![
        vec![ShellLoad::Pressure {
            triangles: left,
            pressure: lime_sim::shell::planner::DEFAULT_PRESSURE,
        }],
        vec![ShellLoad::Pressure {
            triangles: right,
            pressure: lime_sim::shell::planner::DEFAULT_PRESSURE,
        }],
    ];
    req.goal = Goal::Budget { volume_mm3: 1800.0 };
    req.rules.min_spacing = 18.0;
    req.rules.min_length = 12.0;
    req.options.baselines = true;
    let plan = plan_ribs(&req).unwrap();
    let th = plan.thickening.expect("thickening");
    let grid = plan.grid.expect("grid");
    let grid_v = grid.volume_mm3.expect("the grid reaches the factor");
    eprintln!(
        "| half pressure | ribs {:.3} mm³ ×{:.4} ({} ribs) | thickening {:.3} mm³ ({:.4} mm) | grid {:.3} mm³ pitch {:.3} lines {:?} | cases {:?} |",
        plan.rib_volume_mm3,
        plan.stiffness_factor,
        plan.ribs.len(),
        th.added_volume_mm3,
        th.added_thickness_mm,
        grid_v,
        grid.pitch_mm,
        grid.lines,
        plan.case_factors
    );
    assert!(
        plan.case_factors.iter().all(|f| *f > 1.5),
        "{:?}",
        plan.case_factors
    );
    assert!(th.added_volume_mm3 > plan.rib_volume_mm3);
    assert!(
        grid.pitch_mm < 80.0,
        "pitch {:.2} is still a one-rib grid",
        grid.pitch_mm
    );
    assert!(grid.lines[0] + grid.lines[1] >= 3, "lines {:?}", grid.lines);
    assert!(grid_v > 0.0);
}

/// Plan time for 1, 2 and 4 of the same four load positions. Wall time is
/// not comparable across rib counts; solves and seconds per solve are.
#[test]
fn plan_seconds_for_one_two_and_four_cases() {
    let mesh = ShellMesh::rectangle([160.0, 80.0], [24, 12], 2.0);
    let xs = [32.0, 64.0, 96.0, 128.0];
    let nodes: Vec<u32> = xs
        .iter()
        .map(|&x| mesh.nearest_vertex([x, 40.0, 0.0]))
        .collect();
    for n in [1usize, 2, 4] {
        let mut req = RibPlanRequest::new(mesh.clone(), material(E, NU));
        req.load_cases = nodes
            .iter()
            .take(n)
            .map(|&node| {
                vec![ShellLoad::Force {
                    node,
                    force: [0.0, 0.0, -1.0],
                }]
            })
            .collect();
        req.goal = Goal::Budget { volume_mm3: 1800.0 };
        req.rules.min_spacing = 18.0;
        req.rules.min_length = 12.0;
        req.options.baselines = false;
        let plan = plan_ribs(&req).unwrap();
        let solves = plan.stats.solves.max(1);
        let each = plan.stats.seconds.total / solves as f64;
        eprintln!(
            "| {n} cases | {:.3} s | solves {} | {:.4} s/solve | solver {:.3} s | ribs {} | ×{:.3} | factors {:?} |",
            plan.stats.seconds.total,
            plan.stats.solves,
            each,
            plan.stats.seconds.solver,
            plan.ribs.len(),
            plan.stiffness_factor,
            plan.case_factors
        );
        assert!(
            plan.stats.seconds.total < 30.0,
            "{}",
            plan.stats.seconds.total
        );
        assert!(plan.stats.solves > 0);
        assert_eq!(plan.case_factors.len(), n);
        assert!(
            plan.case_factors.iter().all(|f| *f > 1.2),
            "{:?}",
            plan.case_factors
        );
    }
}

/// The weighted plan's weaker factor on this panel, equal loads and ×10
/// (they are the same plan). Worst-case mode has to reach it at p = 8.
fn weighted_weaker() -> f64 {
    SUMMED_EQUAL.into_iter().fold(f64::INFINITY, f64::min)
}

struct SweepRow {
    p: f64,
    panel: &'static str,
    factors: [f64; 2],
    ribs: usize,
}

/// Worst-case mode minimises a p-norm of the scaled compliances and still
/// reports `min_i C_i0 / C_i`. At the 1800 mm³ budget the default p = 8
/// must meet or beat the weighted plan on that minimum, on both panels.
/// The other exponents are the sweep; they are printed and not required.
#[test]
fn worst_case_p_norm_meets_the_weighted_min() {
    let bar = weighted_weaker();
    assert_eq!(PlannerOptions::default().worst_p, 8.0);
    let mut rows = Vec::new();
    for &p in &[2.0_f64, 4.0, 8.0, 16.0] {
        for (scale, panel) in [(1.0, "equal"), (10.0, "x10")] {
            let (mut req, nodes) = opposed_request(scale, true);
            req.combine = LoadCombine::Worst;
            req.options.worst_p = p;
            let plan = plan_ribs(&req).unwrap();
            let scales = if scale == 1.0 {
                vec![1.0, 1.0]
            } else {
                vec![10.0, 1.0]
            };
            let f = case_factors(&plan, &nodes, &scales);
            let min = f[0].min(f[1]);
            eprintln!(
                "| p {p:.0} | {panel} | min {min:.6} | {:.6} {:.6} | ribs {} | vol {:.3} | reported {:.6} | trace {} |",
                f[0],
                f[1],
                plan.ribs.len(),
                plan.rib_volume_mm3,
                plan.stiffness_factor,
                plan.worst_trace.len()
            );
            if (p - 8.0).abs() < 1e-12 {
                dump_trace(&plan);
            }
            rows.push(SweepRow {
                p,
                panel,
                factors: [f[0], f[1]],
                ribs: plan.ribs.len(),
            });
            close_to(plan.stiffness_factor, min);
            assert!(
                plan.goal_met,
                "{panel} p={p} left the budget, vol {}",
                plan.rib_volume_mm3
            );
        }
    }
    eprintln!("| acceptance | weighted weaker {bar:.6} | p=8 must reach it on both panels |");
    for row in &rows {
        if (row.p - 8.0).abs() > 1e-12 {
            continue;
        }
        let min = row.factors[0].min(row.factors[1]);
        assert!(
            min + 1e-9 >= bar,
            "{} p=8 min {min:.6} is under the weighted {bar:.6}",
            row.panel
        );
        assert!(row.ribs >= 1, "{}", row.panel);
    }

    // One case is the plain sum in either mode: same ribs, same factor.
    let (weighted_only, _) = opposed_request(1.0, false);
    let (mut worst_only, _) = opposed_request(1.0, false);
    worst_only.combine = LoadCombine::Worst;
    let a = plan_ribs(&weighted_only).unwrap();
    let b = plan_ribs(&worst_only).unwrap();
    assert_eq!(a.ribs.len(), b.ribs.len());
    assert!(
        (a.stiffness_factor - b.stiffness_factor).abs() < 1e-12,
        "{} vs {}",
        a.stiffness_factor,
        b.stiffness_factor
    );
    for (ra, rb) in a.ribs.iter().zip(&b.ribs) {
        assert_eq!(ra.points.len(), rb.points.len());
        for (p, q) in ra.points.iter().zip(&rb.points) {
            for k in 0..3 {
                assert!((p[k] - q[k]).abs() < 1e-12, "{p:?} vs {q:?}");
            }
        }
    }

    // Stiffer(2) means both cases, not the p-norm ratio.
    let (mut stiff, nodes) = opposed_request(10.0, true);
    stiff.combine = LoadCombine::Worst;
    stiff.goal = Goal::Stiffer(2.0);
    let plan = plan_ribs(&stiff).unwrap();
    let f = case_factors(&plan, &nodes, &[10.0, 1.0]);
    dump("left ×10, worst p=8, stiffer 2", &plan, &f);
    assert!(plan.goal_met, "{f:?}");
    assert!(f.iter().all(|x| *x >= 2.0 - 1e-9), "{f:?}");
    close_to(plan.stiffness_factor, f[0].min(f[1]));
}

/// A worst-case request with weights is refused. They used to be dropped.
#[test]
fn worst_case_refuses_weights() {
    let (mut req, _) = opposed_request(1.0, true);
    req.combine = LoadCombine::Worst;
    req.case_weights = vec![1.0, 8.0];
    let err = plan_ribs(&req).unwrap_err();
    assert!(err.message.contains("weights"), "{}", err.message);
    req.case_weights.clear();
    req.options.worst_p = 0.5;
    let err = plan_ribs(&req).unwrap_err();
    assert!(err.message.contains("exponent"), "{}", err.message);
}

/// v6.11.0, one load case, this mesh and `Goal::Stiffer(2)`. The factor
/// must match to 1e-12 and the ribs must be the same ones. Recorded before
/// the multi-load objective, and not to be loosened: an absolute cutoff
/// on compliance would move these ribs.
const ONE_CASE_V6110: &str = include_str!("one_case_v6110.txt");

struct SnapRib {
    height: f64,
    points: Vec<[f64; 3]>,
    heights: Vec<f64>,
    ends: [RibEndKind; 2],
    family: Family,
}

struct Snap {
    factor: f64,
    volume: f64,
    bare: f64,
    ribbed: f64,
    ribs: Vec<SnapRib>,
}

fn parse_snap(text: &str) -> Snap {
    let mut lines = text.lines().filter(|l| !l.trim().is_empty());
    let head: Vec<&str> = lines.next().unwrap().split_whitespace().collect();
    let mut snap = Snap {
        factor: head[4].parse().unwrap(),
        volume: head[6].parse().unwrap(),
        bare: head[9].parse().unwrap(),
        ribbed: head[11].parse().unwrap(),
        ribs: Vec::new(),
    };
    let mut rib: Option<SnapRib> = None;
    for line in lines {
        let p: Vec<&str> = line.split_whitespace().collect();
        match p[1] {
            "rib" => {
                if let Some(r) = rib.take() {
                    snap.ribs.push(r);
                }
                rib = Some(SnapRib {
                    height: p[4].parse().unwrap(),
                    points: Vec::new(),
                    heights: Vec::new(),
                    ends: [RibEndKind::Boundary, RibEndKind::Boundary],
                    family: Family::Major,
                });
            }
            "pt" => {
                let r = rib.as_mut().unwrap();
                r.points.push([
                    p[2].parse().unwrap(),
                    p[3].parse().unwrap(),
                    p[4].parse().unwrap(),
                ]);
            }
            "ht" => rib.as_mut().unwrap().heights.push(p[2].parse().unwrap()),
            other => panic!("unexpected snapshot line {other}"),
        }
    }
    snap.ribs.push(rib.unwrap());
    assert_eq!(snap.ribs.len(), head[2].parse::<usize>().unwrap());
    snap
}

fn within_1e_12(got: f64, want: f64, what: &str) {
    assert!(
        (got - want).abs() <= 1e-12,
        "{what}: {got:.16} vs {want:.16}"
    );
}

#[test]
fn a_one_case_plan_matches_v6_11_0() {
    let snap = parse_snap(ONE_CASE_V6110);
    let mut req = RibPlanRequest::new(
        ShellMesh::rectangle([160.0, 80.0], [24, 12], 2.0),
        material(E, NU),
    );
    req.goal = Goal::Stiffer(2.0);
    req.options.baselines = false;
    let plan = plan_ribs(&req).unwrap();
    within_1e_12(plan.stiffness_factor, snap.factor, "factor");
    within_1e_12(plan.rib_volume_mm3, snap.volume, "volume");
    within_1e_12(plan.bare.compliance, snap.bare, "bare compliance");
    within_1e_12(plan.ribbed.compliance, snap.ribbed, "ribbed compliance");
    assert_eq!(plan.case_factors.len(), 1);
    within_1e_12(plan.case_factors[0], plan.stiffness_factor, "case factor");
    assert!(plan.worst_trace.is_empty());
    assert_eq!(plan.ribs.len(), snap.ribs.len());
    for (got, want) in plan.ribs.iter().zip(&snap.ribs) {
        within_1e_12(got.height, want.height, "rib height");
        assert_eq!(got.ends, [RibEndKind::Boundary, RibEndKind::Boundary]);
        assert_eq!(got.family, Family::Major);
        assert_eq!(got.points.len(), want.points.len(), "point count");
        assert_eq!(got.heights.len(), want.heights.len(), "height count");
        for (p, q) in got.points.iter().zip(&want.points) {
            for k in 0..3 {
                within_1e_12(p[k], q[k], "point");
            }
        }
        for (h, w) in got.heights.iter().zip(&want.heights) {
            within_1e_12(*h, *w, "stretch height");
        }
    }
}

/// v6.11.0 `Goal::Budget` of 1800 mm³ with both baselines, on the same
/// flat panel as [`a_one_case_plan_matches_v6_11_0`]. Recorded by running
/// that commit (`8486f501`) and copying its print.
const ONE_CASE_BUDGET_V6110: &str = include_str!("one_case_budget_v6110.txt");

/// v6.11.0 `Goal::Balanced` on a cylinder segment, baselines off. Same
/// commit as the flat snapshots.
const ONE_CASE_CURVED_V6110: &str = include_str!("one_case_curved_v6110.txt");

struct LockSnap {
    factor: f64,
    volume: f64,
    bare: f64,
    ribbed: f64,
    thick: Option<(f64, f64)>,
    grid_pitch: Option<f64>,
    grid_volume: Option<f64>,
    ribs: Vec<SnapRib>,
}

fn end_kind(s: &str) -> RibEndKind {
    match s {
        "Boundary" => RibEndKind::Boundary,
        "Hold" => RibEndKind::Hold,
        "Rib" => RibEndKind::Rib,
        "Free" => RibEndKind::Free,
        other => panic!("rib end {other}"),
    }
}

fn family_of(s: &str) -> Family {
    match s {
        "Major" => Family::Major,
        "Minor" => Family::Minor,
        other => panic!("family {other}"),
    }
}

fn parse_lock(text: &str) -> LockSnap {
    let mut factor = None;
    let mut volume = None;
    let mut bare = None;
    let mut ribbed = None;
    let mut n_ribs = None;
    let mut thick = None;
    let mut grid_pitch = None;
    let mut grid_volume = None;
    let mut ribs = Vec::new();
    let mut rib: Option<SnapRib> = None;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let p: Vec<&str> = line.split_whitespace().collect();
        match p[1] {
            "head" => {
                n_ribs = Some(p[3].parse::<usize>().unwrap());
                factor = Some(p[5].parse().unwrap());
                volume = Some(p[7].parse().unwrap());
                bare = Some(p[9].parse().unwrap());
                ribbed = Some(p[11].parse().unwrap());
            }
            "thick" => thick = Some((p[2].parse().unwrap(), p[3].parse().unwrap())),
            "grid" => {
                grid_pitch = Some(p[2].parse().unwrap());
                grid_volume = Some(p[3].parse().unwrap());
            }
            "rib" => {
                if let Some(r) = rib.take() {
                    ribs.push(r);
                }
                rib = Some(SnapRib {
                    height: p[3].parse().unwrap(),
                    points: Vec::new(),
                    heights: Vec::new(),
                    ends: [end_kind(p[6]), end_kind(p[7])],
                    family: family_of(p[8]),
                });
            }
            "pt" => {
                rib.as_mut().unwrap().points.push([
                    p[2].parse().unwrap(),
                    p[3].parse().unwrap(),
                    p[4].parse().unwrap(),
                ]);
            }
            "ht" => rib.as_mut().unwrap().heights.push(p[2].parse().unwrap()),
            other => panic!("unexpected snapshot line {other}"),
        }
    }
    ribs.push(rib.expect("a rib"));
    let n_ribs = n_ribs.unwrap();
    assert_eq!(ribs.len(), n_ribs);
    LockSnap {
        factor: factor.unwrap(),
        volume: volume.unwrap(),
        bare: bare.unwrap(),
        ribbed: ribbed.unwrap(),
        thick,
        grid_pitch,
        grid_volume,
        ribs,
    }
}

fn same_ribs(plan: &RibPlan, snap: &LockSnap) {
    assert_eq!(plan.ribs.len(), snap.ribs.len());
    for (got, want) in plan.ribs.iter().zip(&snap.ribs) {
        within_1e_12(got.height, want.height, "rib height");
        assert_eq!(got.ends[0], want.ends[0]);
        assert_eq!(got.ends[1], want.ends[1]);
        assert_eq!(got.family, want.family);
        assert_eq!(got.points.len(), want.points.len(), "point count");
        assert_eq!(got.heights.len(), want.heights.len(), "height count");
        for (p, q) in got.points.iter().zip(&want.points) {
            for k in 0..3 {
                within_1e_12(p[k], q[k], "point");
            }
        }
        for (h, w) in got.heights.iter().zip(&want.heights) {
            within_1e_12(*h, *w, "stretch height");
        }
    }
}

/// Budget, baselines on. Ribs, factor, thickening and the grid, each to
/// 1e-12 against the v6.11.0 print.
#[test]
fn a_budget_plan_matches_v6_11_0() {
    let snap = parse_lock(ONE_CASE_BUDGET_V6110);
    let mut req = RibPlanRequest::new(
        ShellMesh::rectangle([160.0, 80.0], [24, 12], 2.0),
        material(E, NU),
    );
    req.goal = Goal::Budget { volume_mm3: 1800.0 };
    req.options.baselines = true;
    let plan = plan_ribs(&req).unwrap();
    within_1e_12(plan.stiffness_factor, snap.factor, "factor");
    within_1e_12(plan.rib_volume_mm3, snap.volume, "volume");
    within_1e_12(plan.bare.compliance, snap.bare, "bare compliance");
    within_1e_12(plan.ribbed.compliance, snap.ribbed, "ribbed compliance");
    let (tv, tt) = snap.thick.expect("thickening in the snapshot");
    let th = plan.thickening.expect("thickening");
    within_1e_12(th.added_volume_mm3, tv, "thickening volume");
    within_1e_12(th.added_thickness_mm, tt, "thickening thickness");
    let grid = plan.grid.expect("grid");
    let gv = grid.volume_mm3.expect("grid volume");
    within_1e_12(grid.pitch_mm, snap.grid_pitch.unwrap(), "grid pitch");
    within_1e_12(gv, snap.grid_volume.unwrap(), "grid volume");
    same_ribs(&plan, &snap);
}

/// Balanced ribs on a curved wall, against the v6.11.0 print.
#[test]
fn a_curved_balanced_plan_matches_v6_11_0() {
    let snap = parse_lock(ONE_CASE_CURVED_V6110);
    let (r, len, angle) = (40.0, 80.0, std::f64::consts::FRAC_PI_2);
    let div = [16, 8];
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
    req.goal = Goal::Balanced;
    req.options.baselines = false;
    let plan = plan_ribs(&req).unwrap();
    within_1e_12(plan.stiffness_factor, snap.factor, "factor");
    within_1e_12(plan.rib_volume_mm3, snap.volume, "volume");
    within_1e_12(plan.bare.compliance, snap.bare, "bare compliance");
    within_1e_12(plan.ribbed.compliance, snap.ribbed, "ribbed compliance");
    same_ribs(&plan, &snap);
    for rb in &plan.ribs {
        for p in &rb.points {
            let rr = p[1].hypot(p[2]);
            assert!((rr - r).abs() < 0.2, "{p:?} at r {rr}");
        }
    }
}

/// A centre load spans the whole panel; a load 10 mm from a clamped edge
/// barely spans anything, so a gram of rib buys far less stiffness there.
/// Equal budget, p = 8. The symmetric panel made every p tie the weighted
/// plan. This one asks whether worst-case mode raises the weaker factor
/// enough (2%) to be worth exposing on the tool.
///
/// It does not. The edge load is already carried by the clamp, so ribs
/// cannot lift it, and both modes leave it at the same factor. Worst-case
/// mode stays in the crate and off the tool.
#[test]
fn a_lopsided_pair_does_not_favour_worst_case() {
    let mesh = ShellMesh::rectangle([160.0, 80.0], [16, 8], 2.0);
    let centre = mesh.nearest_vertex([80.0, 40.0, 0.0]);
    let edge = mesh.nearest_vertex([10.0, 40.0, 0.0]);
    let at = |node: u32| mesh.vertices[node as usize];
    assert!((at(centre)[0] - 80.0).abs() < 1e-9 && (at(centre)[1] - 40.0).abs() < 1e-9);
    assert!((at(edge)[0] - 10.0).abs() < 1e-9 && (at(edge)[1] - 40.0).abs() < 1e-9);
    let plan_at = |combine: LoadCombine| {
        let mut req = RibPlanRequest::new(mesh.clone(), material(E, NU));
        req.holds = Holds::AllBoundaryClamped;
        req.load_cases = vec![
            vec![ShellLoad::Force {
                node: centre,
                force: [0.0, 0.0, -1.0],
            }],
            vec![ShellLoad::Force {
                node: edge,
                force: [0.0, 0.0, -1.0],
            }],
        ];
        req.goal = Goal::Budget { volume_mm3: 1800.0 };
        req.rules.min_spacing = 18.0;
        req.rules.min_length = 12.0;
        req.options.baselines = false;
        req.combine = combine;
        if combine == LoadCombine::Worst {
            req.options.worst_p = 8.0;
        }
        plan_ribs(&req).unwrap()
    };
    let weighted = plan_at(LoadCombine::Weighted);
    let worst = plan_at(LoadCombine::Worst);
    let w = case_factors(&weighted, &[centre, edge], &[1.0, 1.0]);
    let u = case_factors(&worst, &[centre, edge], &[1.0, 1.0]);
    let wmin = w[0].min(w[1]);
    let umin = u[0].min(u[1]);
    // Locked from the release run of this test.
    within_1e_12(w[0], 4.401264978619979, "weighted centre");
    within_1e_12(w[1], 1.2607959330185834, "weighted edge");
    within_1e_12(u[0], 2.5583306328964595, "worst centre");
    within_1e_12(u[1], 1.2601204659032641, "worst edge");
    assert_eq!(weighted.ribs.len(), 5);
    assert_eq!(worst.ribs.len(), 2);
    within_1e_12(weighted.rib_volume_mm3, 1713.6773280957775, "weighted volume");
    within_1e_12(worst.rib_volume_mm3, 936.0688139731215, "worst volume");
    assert!(
        umin < 1.02 * wmin,
        "worst min {umin} beats weighted {wmin} by 2%; expose combine"
    );
}

fn dump_trace(plan: &RibPlan) {
    for (i, round) in plan.worst_trace.iter().enumerate() {
        eprintln!(
            "|   round {i} | case {} | min ×{:.6} |",
            round.limiting_case, round.min_factor
        );
    }
}
