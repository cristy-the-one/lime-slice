//! Resin vent notches on a clamped panel. The opening faces +Z (the rectangle's
//! normal). A build axis of -Z points the opening at the platform, so the
//! closed cells cup; +Z points it at the tank, so none do.

use lime_sim::shell::planner::{plan_ribs, vent_pockets, BorderKind, BorderRun, Goal, RibEndKind, RibPlanRequest, RibRun};
use lime_sim::shell::{IsotropicShell, ShellMesh};

fn panel(axis: [f64; 3], vent: bool) -> lime_sim::shell::planner::RibPlan {
    let mut req = RibPlanRequest::new(
        ShellMesh::rectangle([80.0, 60.0], [12, 8], 2.0),
        IsotropicShell::new(2000.0, 0.35).expect("material"),
    );
    req.vent = vent;
    req.build_axis = axis;
    req.options.baselines = false;
    req.rules.min_spacing = 12.0;
    req.goal = Goal::Budget { volume_mm3: 900.0 };
    req.rising_border = true;
    plan_ribs(&req).expect("plan")
}

#[test]
fn resin_vents_the_pockets_and_filament_does_not() {
    let down = panel([0.0, 0.0, -1.0], true);
    let vents = down.vents.expect("a resin plan reports vents");
    let n = vents.pockets.len();
    assert!(
        n > 0,
        "the ribs closed no cell ({} ribs, factor {:.4})",
        down.ribs.len(),
        vents.factor_before
    );
    assert!((vents.size_mm - 0.75).abs() < 1e-9);
    assert!(vents.factor_before > 1.0);
    assert!(vents.factor_after <= vents.factor_before + 1e-4, "a gap made the panel stiffer");
    assert!(vents.mouse_hole_factor + 1e-4 >= vents.factor_after, "a lowered stretch cost more than removing it");
    assert!((down.stiffness_factor - vents.factor_after).abs() < 1e-6);

    let border = [[0.0, 0.0, 0.0], [80.0, 0.0, 0.0], [80.0, 60.0, 0.0], [0.0, 60.0, 0.0], [0.0, 0.0, 0.0]];
    let borders = [BorderRun { points: &border, kind: BorderKind::Rises }];
    let runs: Vec<RibRun<'_>> = down
        .ribs
        .iter()
        .map(|rib| RibRun {
            points: &rib.points,
            free: [rib.ends[0] == RibEndKind::Free, rib.ends[1] == RibEndKind::Free],
        })
        .collect();
    let again = vent_pockets(&runs, &borders, [0.0, 0.0, 1.0], [0.0, 0.0, -1.0]);
    assert!(again.pockets.is_empty(), "the notched ribs still cup: {again:?}");

    let up = panel([0.0, 0.0, 1.0], true);
    let open = up.vents.expect("resin");
    assert!(open.pockets.is_empty(), "facing the tank still cupped: {}", open.pockets.len());
    assert!((open.factor_before - open.factor_after).abs() < 1e-6);

    let plain = panel([0.0, 0.0, 1.0], false);
    assert!(plain.vents.is_none());
    assert_eq!(plain.ribs.len(), up.ribs.len());
    assert!((plain.stiffness_factor - up.stiffness_factor).abs() < 1e-4);
}
