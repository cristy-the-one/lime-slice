//! Resin vent notches on a clamped panel. The opening faces +Z. A build axis
//! of +Z points that opening at the tank, so the closed cells cup. -Z points
//! it at the platform, so none do.
//!
//! One long side of the border is open. The same panel with a rising border
//! all round cannot be vented by ribs.

use lime_sim::shell::planner::{plan_ribs, vent_pockets, BorderKind, BorderRun, EndKind, Goal, RibPlanRequest, RibRun, PART_CUPS};
use lime_sim::shell::{IsotropicShell, ShellMesh};
use lime_sim::units::{norm, sub};

fn base(axis: [f64; 3], vent: bool) -> RibPlanRequest {
    let mut req = RibPlanRequest::new(
        ShellMesh::rectangle([80.0, 60.0], [12, 8], 2.0),
        IsotropicShell::new(2000.0, 0.35).expect("material"),
    );
    req.vent = vent;
    req.build_axis = axis;
    req.options.baselines = false;
    req.rules.min_spacing = 12.0;
    // 900 mm³ stops one rib in mid-wall. That end drains, so a rising border all round would still
    // be notched. 8000 mm³ lets every rib reach a border: the open side can be vented, and the
    // walled panel cannot.
    req.goal = Goal::Budget { volume_mm3: 8000.0 };
    req
}

fn open_side(axis: [f64; 3], vent: bool) -> lime_sim::shell::planner::RibPlan {
    let mut req = base(axis, vent);
    // y = 0 is the open edge. The other three sides are side walls.
    req.borders = vec![
        (vec![[0.0, 0.0, 0.0], [80.0, 0.0, 0.0]], BorderKind::Open),
        (vec![[80.0, 0.0, 0.0], [80.0, 60.0, 0.0]], BorderKind::Rises),
        (vec![[80.0, 60.0, 0.0], [0.0, 60.0, 0.0]], BorderKind::Rises),
        (vec![[0.0, 60.0, 0.0], [0.0, 0.0, 0.0]], BorderKind::Rises),
    ];
    plan_ribs(&req).expect("plan")
}

fn rising_all_round(axis: [f64; 3]) -> lime_sim::shell::planner::RibPlan {
    let mut req = base(axis, true);
    req.rising_border = true;
    plan_ribs(&req).expect("plan")
}

#[test]
fn resin_vents_the_pockets_and_a_rising_border_does_not() {
    let down = open_side([0.0, 0.0, 1.0], true);
    let vents = down.vents.expect("a resin plan reports vents");
    let n = vents.pockets.len();
    println!(
        "open side: {} pockets, {} unvented, stiffness before {:.6} after {:.6}, reported {:.6}",
        n,
        vents.unvented.len(),
        vents.factor_before,
        vents.factor_after,
        down.stiffness_factor
    );
    assert!(n > 0, "the ribs closed no cell ({} ribs, factor {:.4})", down.ribs.len(), vents.factor_before);
    assert_eq!(vents.unvented.len(), 0, "a cell that can reach the open side was left: {:?}", vents.unvented);
    assert!((vents.size_mm - 0.75).abs() < 1e-9);
    assert!(vents.factor_before > 1.0);
    assert!(vents.factor_after <= vents.factor_before + 1e-4, "a gap made the panel stiffer: {} -> {}", vents.factor_before, vents.factor_after);
    assert!((down.stiffness_factor - vents.factor_after).abs() < 1e-6, "the reported factor is the notched solve");
    for pocket in &vents.pockets {
        assert!(pocket.rib < down.ribs.len(), "pocket.rib {} is not a returned rib", pocket.rib);
    }

    let borders = [
        BorderRun { points: &[[0.0, 0.0, 0.0], [80.0, 0.0, 0.0]], kind: BorderKind::Open },
        BorderRun { points: &[[80.0, 0.0, 0.0], [80.0, 60.0, 0.0]], kind: BorderKind::Rises },
        BorderRun { points: &[[80.0, 60.0, 0.0], [0.0, 60.0, 0.0]], kind: BorderKind::Rises },
        BorderRun { points: &[[0.0, 60.0, 0.0], [0.0, 0.0, 0.0]], kind: BorderKind::Rises },
    ];
    let runs: Vec<RibRun<'_>> = down
        .ribs
        .iter()
        .map(|rib| {
            let gap = |end: usize| {
                let p = if end == 0 { rib.points[0] } else { *rib.points.last().expect("points") };
                vents.pockets.iter().any(|pocket| norm(sub(p, pocket.at)) < 1.0)
            };
            RibRun {
                points: &rib.points,
                ends: [if gap(0) { EndKind::Gap } else { EndKind::Closed }, if gap(1) { EndKind::Gap } else { EndKind::Closed }],
                width_mm: rib.width,
            }
        })
        .collect();
    let again = vent_pockets(&runs, &borders, [0.0, 0.0, 1.0], [0.0, 0.0, 1.0], 10.0);
    println!("re-run: closed {} pockets {} unvented {}", again.closed, again.pockets.len(), again.unvented.len());
    assert!(again.pockets.is_empty() && again.unvented.is_empty(), "the notched ribs still cup: {again:?}");

    let up = open_side([0.0, 0.0, -1.0], true);
    let open = up.vents.expect("resin");
    println!("facing the platform: {} pockets, factor {:.6}", open.pockets.len(), open.factor_before);
    assert!(open.pockets.is_empty(), "facing the platform still cupped: {}", open.pockets.len());
    assert!((open.factor_before - open.factor_after).abs() < 1e-6);

    let plain = open_side([0.0, 0.0, 1.0], false);
    println!("vent left false: stiffness {:.6}, vents key absent", plain.stiffness_factor);
    assert!(plain.vents.is_none());
    assert!((plain.stiffness_factor - vents.factor_before).abs() < 1e-3, "the unnotched resin layout matches the filament plan");

    let walled = rising_all_round([0.0, 0.0, 1.0]);
    let shut = walled.vents.expect("resin");
    println!(
        "rising all round: {} pockets, {} unvented, before {:.6} after {:.6}, ribs {}, loose ends {}",
        shut.pockets.len(),
        shut.unvented.len(),
        shut.factor_before,
        shut.factor_after,
        walled.ribs.len(),
        walled.loose_ends.len()
    );
    assert!(shut.pockets.is_empty(), "a side wall all round was notched");
    assert!(!shut.unvented.is_empty(), "the part itself cups, and that is reported");
    assert!(shut.unvented.iter().all(|item| item.message == PART_CUPS), "{:?}", shut.unvented);
    assert!((shut.factor_before - shut.factor_after).abs() < 1e-6, "nothing was cut, so the factor is unchanged");
}
