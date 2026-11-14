//! Racks (docs/plan-gear-kinds.md, stage 3): `gears::Rack`'s outline is sound, and `gear_pair::classify_rack` calls a
//! pinion over a rack meshing at its pitch radius from the pitch line with the mating phase, keeps meshing as the pinion
//! turns and the rack travels `PI m z / 360` mm a degree, and calls it too close, loose or tooth on tooth when it is.

use lime_recipe::gear_pair::{classify_rack, rack_turn, PairVerdict};
use lime_recipe::gears::{rack_travel, Gear, Piece, Rack};

/// The rack phase that meets a pinion standing over U = `x` with tooth 0 at `phase_deg`.
fn mate(x: f64, phase_deg: f64, z: u32, rack: &Rack) -> f64 {
    let pitch = 360.0 / f64::from(z);
    let f = (((-90.0 - phase_deg) / pitch) % 1.0 + 1.0) % 1.0;
    x - f * rack.pitch_mm() + rack.pitch_mm() / 2.0
}

#[test]
fn the_rack_outline_is_a_bar_with_teeth_on_its_pitch_line() {
    for (teeth, module) in [(10, 1.0), (24, 2.0), (1, 1.5), (60, 0.8)] {
        let rack = Rack::new(teeth, module);
        assert_eq!(rack.refusal(), None);
        let pts = rack.points(0.0, 3.0).unwrap();
        let n = pts.len();
        assert_eq!(n, 4 + 4 * teeth as usize);
        let mut a2 = 0.0;
        for i in 0..n {
            let (p, q) = (pts[i], pts[(i + 1) % n]);
            a2 += p[0] * q[1] - p[1] * q[0];
        }
        let (u0, u1) = rack.ends();
        let bar = (u1 - u0) * 3.0;
        // Counter-clockwise; the bar plus teeth whose area is their mean width times their height.
        // A tooth is a trapezoid 2.25 m high: half a pitch less the backlash wide at the pitch line, wider by tan(a) a
        // millimetre down to its root 1.25 m below and narrower up to its tip 1 m above.
        let tan_a = 20f64.to_radians().tan();
        let teeth_area = f64::from(teeth) * (rack.pitch_mm() / 2.0 - rack.backlash + 0.25 * module * tan_a) * 2.25 * module;
        assert!((a2 / 2.0 - bar - teeth_area).abs() < 1e-6 * (bar + teeth_area), "{teeth}: {} against {}", a2 / 2.0, bar + teeth_area);
        let outline = rack.outline(0.0, 3.0).unwrap();
        let last = match outline.pieces.last().unwrap() {
            Piece::Line(to) | Piece::Arc(_, to) | Piece::Spline(_, to) => *to,
        };
        assert_eq!(last, outline.start);
    }
    assert_eq!(Rack::new(0, 1.0).refusal().as_deref(), Some("A rack takes 1 to 400 teeth."));
    assert!(Rack { pressure_deg: 30.0, backlash: 1.0, ..Rack::new(10, 1.0) }.refusal().is_some());
}

#[test]
fn a_pinion_meshes_over_a_rack_and_keeps_meshing_as_the_rack_travels() {
    for (z, m) in [(12u32, 1.0), (18, 2.0), (9, 1.5), (30, 1.0)] {
        let pinion = Gear::new(z, m);
        let rack = Rack::new(40, m);
        let at = [10.0 * m, pinion.pitch_radius()];
        let phase = 7.0;
        let rack_phase = mate(at[0], phase, z, &rack);
        let report = classify_rack(&pinion, &rack, at, phase, rack_phase);
        assert_eq!(report.verdict, PairVerdict::Meshing, "{z}: {report:?}");
        // Through a turn and a half each way, the rack travelling with it, while the pinion stays over the rack.
        for k in -60..=60 {
            let angle = f64::from(k) * 4.7;
            let travel = rack_travel(angle, z, m);
            if at[0] - (rack_phase + travel) < 2.0 * m || at[0] - (rack_phase + travel) > rack.ends().1 - 2.0 * m {
                continue;
            }
            let turned = rack_turn(&pinion, &rack, at, phase, rack_phase, angle);
            assert_eq!(turned.verdict, PairVerdict::Meshing, "{z}, turned {angle}: {turned:?}");
        }
        // The rack moved the wrong way: caught within a few degrees.
        let wrong = (1..30).any(|k| {
            let a = f64::from(k) * 2.0;
            classify_rack(&pinion, &rack, at, phase + a, rack_phase - rack_travel(a, z, m)).verdict == PairVerdict::ToothOnTooth
        });
        assert!(wrong, "{z}: a rack moved against the pinion must be caught");
        assert_eq!(classify_rack(&pinion, &rack, at, phase, rack_phase + rack.pitch_mm() / 2.0).verdict, PairVerdict::ToothOnTooth);
        assert_eq!(classify_rack(&pinion, &rack, [at[0], at[1] - 0.5], phase, rack_phase).verdict, PairVerdict::TooClose);
        assert_eq!(classify_rack(&pinion, &rack, [at[0], at[1] + 0.5], phase, rack_phase).verdict, PairVerdict::Loose);
        assert_eq!(classify_rack(&pinion, &rack, [at[0], at[1] + 20.0 * m], phase, rack_phase).verdict, PairVerdict::Apart);
        assert_eq!(classify_rack(&pinion, &rack, [rack.ends().1 + 60.0 * m, at[1]], phase, rack_phase).verdict, PairVerdict::Apart);
    }
    assert_eq!(rack_travel(360.0, 12, 1.0), std::f64::consts::PI * 12.0);
}
