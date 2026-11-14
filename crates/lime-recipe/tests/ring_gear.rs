//! Ring gears (docs/plan-gear-kinds.md, stage 2): `gears::Ring`'s outline is sound, and `gear_pair::classify_internal`
//! calls a pinion inside a ring meshing at `m (z_ring - z_pinion) / 2` with `mate_phase_internal`, keeps meshing as the
//! pair turns by `ring_turn`, and calls it too close, loose or tooth on tooth when it is.

use lime_recipe::gear_pair::{classify_internal, internal_turn, PairVerdict};
use lime_recipe::gears::{mate_phase_internal, Gear, Piece, Ring};

fn area(points: &[[f64; 2]]) -> f64 {
    let n = points.len();
    let mut a2 = 0.0;
    for i in 0..n {
        let (p, q) = (points[i], points[(i + 1) % n]);
        a2 += p[0] * q[1] - p[1] * q[0];
    }
    a2 / 2.0
}

#[test]
fn the_ring_outline_is_a_toothed_hole_between_its_tip_and_root_circles() {
    for (teeth, module) in [(36, 1.0), (48, 2.0), (60, 1.5), (100, 0.8), (24, 1.0)] {
        let ring = Ring::new(teeth, module);
        assert_eq!(ring.refusal(), None, "{teeth} teeth");
        let pts = ring.points(0.0, 8).unwrap();
        let radii: Vec<f64> = pts.iter().map(|p| (p[0] * p[0] + p[1] * p[1]).sqrt()).collect();
        let (lo, hi) = radii.iter().fold((f64::MAX, 0.0_f64), |(lo, hi), r| (lo.min(*r), hi.max(*r)));
        assert!((lo - ring.tip_radius()).abs() < 1e-9 && (hi - ring.root_radius()).abs() < 1e-9, "{teeth}: {lo} {hi}");
        // Counter-clockwise, and its area between the tip and root circles' areas.
        let a = area(&pts);
        let pi = std::f64::consts::PI;
        assert!(a > pi * ring.tip_radius().powi(2) && a < pi * ring.root_radius().powi(2), "{teeth}: area {a}");
        // About half the band between the circles is space: the spaces are the external teeth, about half a pitch.
        let band = pi * (ring.root_radius().powi(2) - ring.tip_radius().powi(2));
        let share = (a - pi * ring.tip_radius().powi(2)) / band;
        assert!(share > 0.35 && share < 0.65, "{teeth}: share {share}");
        // The outline for the kernel closes where it starts, one space and one tooth tip a tooth.
        let outline = ring.outline(0.0).unwrap();
        let last = match outline.pieces.last().unwrap() {
            Piece::Line(to) | Piece::Arc(_, to) | Piece::Spline(_, to) => *to,
        };
        assert_eq!(last, outline.start);
        assert!(outline.pieces.len() >= 4 * teeth as usize);
    }
    assert_eq!(Ring::new(12, 1.0).refusal().as_deref(), Some("A ring gear takes 20 to 150 teeth."));
}

#[test]
fn a_pinion_inside_a_ring_meshes_at_the_inside_distance_and_keeps_meshing_as_it_turns() {
    for (zp, zr, m, dir) in [(12, 36, 1.0, 0.0_f64), (12, 36, 1.0, 37.0), (18, 48, 2.0, 120.0), (15, 60, 1.5, -75.0), (20, 50, 1.0, 200.0)] {
        let pinion = Gear::new(zp, m);
        let ring = Ring::new(zr, m);
        let working = m * (zr - zp) as f64 / 2.0;
        let (s, c) = dir.to_radians().sin_cos();
        let at = [working * c, working * s];
        let phase = 13.0;
        let ring_phase = mate_phase_internal(phase, zp, dir, zr);
        let report = classify_internal(&pinion, &ring, at, [0.0, 0.0], phase, ring_phase);
        assert_eq!(report.verdict, PairVerdict::Meshing, "{zp} in {zr} at {dir}: {report:?}");
        assert!(report.narrow);
        for k in 0..73 {
            let angle = k as f64 * 5.0 + 0.37;
            let turned = internal_turn(&pinion, &ring, at, [0.0, 0.0], phase, ring_phase, angle);
            assert_eq!(turned.verdict, PairVerdict::Meshing, "{zp} in {zr}, turned {angle}: {turned:?}");
        }
        // Turned the wrong way (as an external pair would), the teeth cross within a few degrees.
        let wrong = (1..40).any(|k| {
            let a = k as f64 * 2.0;
            classify_internal(&pinion, &ring, at, [0.0, 0.0], phase + a, ring_phase - a * zp as f64 / zr as f64).verdict == PairVerdict::ToothOnTooth
        });
        assert!(wrong, "{zp} in {zr}: a ring turned against the pinion must be caught");
        // Half a tooth of the ring off: tooth on tooth.
        let off = classify_internal(&pinion, &ring, at, [0.0, 0.0], phase, ring_phase + ring.pitch_deg() / 2.0);
        assert_eq!(off.verdict, PairVerdict::ToothOnTooth, "{zp} in {zr}: {off:?}");
        // Pushed 0.5 mm out into the ring's teeth, and held 0.5 mm in.
        let out = [(working + 0.5) * c, (working + 0.5) * s];
        assert_eq!(classify_internal(&pinion, &ring, out, [0.0, 0.0], phase, mate_phase_internal(phase, zp, dir, zr)).verdict, PairVerdict::TooClose);
        let inside = [(working - 0.5) * c, (working - 0.5) * s];
        let held = classify_internal(&pinion, &ring, inside, [0.0, 0.0], phase, mate_phase_internal(phase, zp, dir, zr)).verdict;
        assert!(held == PairVerdict::Loose, "{zp} in {zr}: {held:?}");
    }
}

#[test]
fn a_ring_and_a_pinion_that_do_not_reach_are_apart_and_a_module_mismatch_is_named() {
    let ring = Ring::new(48, 2.0);
    assert_eq!(classify_internal(&Gear::new(12, 2.0), &ring, [0.0, 0.0], [0.0, 0.0], 0.0, 0.0).verdict, PairVerdict::Apart);
    assert_eq!(classify_internal(&Gear::new(12, 2.0), &ring, [200.0, 0.0], [0.0, 0.0], 0.0, 0.0).verdict, PairVerdict::Apart);
    assert_eq!(classify_internal(&Gear::new(12, 1.5), &ring, [36.0, 0.0], [0.0, 0.0], 0.0, 0.0).verdict, PairVerdict::ModuleMismatch);
}
