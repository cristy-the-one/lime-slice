//! Several load cases on one wall.
//!
//! v6.11.0 summed compliance, so a load ten times the other (about a
//! hundred times the compliance) spent the rib material on itself. The
//! constants `SUMMED_*` are that measurement. The planner now minimises
//! `sum w_i C_i / C_i0`.

mod shell_common;

use lime_sim::shell::planner::{
    boundary_vertices, plan_ribs, Goal, Holds, RibPlan, RibPlanRequest,
};
use lime_sim::shell::{Rib, ShellHold, ShellLoad, ShellMesh, ShellModel, ShellOptions};
use shell_common::material;

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
    dump("equal loads, summed", &eq_plan, &eq_f);

    let (heavy, _) = opposed_request(10.0, true);
    let heavy_plan = plan_ribs(&heavy).unwrap();
    let heavy_f = case_factors(&heavy_plan, &nodes, &[10.0, 1.0]);
    dump("left ×10, summed", &heavy_plan, &heavy_f);

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

/// Plan time for 1, 2 and 4 cases on the same wall. Printing is the record;
/// the bound only catches a hang.
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
        eprintln!(
            "| {n} cases | {:.3} s | ribs {} | ×{:.3} | factors {:?} |",
            plan.stats.seconds.total,
            plan.ribs.len(),
            plan.stiffness_factor,
            plan.case_factors
        );
        assert!(
            plan.stats.seconds.total < 30.0,
            "{}",
            plan.stats.seconds.total
        );
        assert_eq!(plan.case_factors.len(), n);
        assert!(
            plan.case_factors.iter().all(|f| *f > 1.2),
            "{:?}",
            plan.case_factors
        );
    }
}
