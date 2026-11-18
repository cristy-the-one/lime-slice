//! Several load cases on one wall.
//!
//! The first test records what v6.11.0 does: compliance is summed, so a
//! load ten times the other (a hundred times the compliance) spends the
//! rib material on itself. Later tests are the weighted objective, the
//! worst case, and the one-case plan that must match v6.11.0.

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
    req.goal = Goal::Budget {
        volume_mm3: 1800.0,
    };
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
        .flat_map(|r| r.profile.solver_ribs(&r.vertices, &r.heights, r.width, r.side))
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

/// What summing the two compliances does on this panel, measured against
/// v6.11.0 before the weighted objective. The ×10 column is the bad one:
/// case 2 stays at 1.002, the same as planning for the left load alone.
const SUMMED_EQUAL: [f64; 2] = [2.146639343320, 2.114592183597];
const SUMMED_HEAVY: [f64; 2] = [3.469144151550, 1.002061434711];
const SUMMED_LEFT_ON_BOTH: [f64; 2] = [3.459900734848, 1.002059653687];

/// v6.11.0 sums compliance. Equal loads share the ribs; ×10 ignores the
/// right-hand load.
#[test]
fn summed_compliance_on_opposed_loads() {
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
    assert_eq!(heavy_plan.ribs.len(), 7, "left ×10");
    assert_eq!(only_plan.ribs.len(), 7, "left alone");
    for (got, want) in eq_f.iter().zip(SUMMED_EQUAL) {
        close_to(*got, want);
    }
    for (got, want) in heavy_f.iter().zip(SUMMED_HEAVY) {
        close_to(*got, want);
    }
    for (got, want) in only_f.iter().zip(SUMMED_LEFT_ON_BOTH) {
        close_to(*got, want);
    }
    // The summed factor is the ratio of the summed compliances.
    close_to(eq_plan.stiffness_factor, 2.130496019041);
    close_to(heavy_plan.stiffness_factor, 3.386264618617);
    // ×10 spends the budget on the left load. The right-hand case does
    // not move, and the ribs sit on the left, as they do for that load alone.
    assert!(heavy_f[1] < 1.01, "case 2 is ignored: {}", heavy_f[1]);
    assert!(only_f[1] < 1.01, "left-only ribs miss the right load");
    assert!(mean_x(&heavy_plan) < 50.0, "{}", mean_x(&heavy_plan));
    assert!((mean_x(&eq_plan) - 80.0).abs() < 2.0, "{}", mean_x(&eq_plan));
}
