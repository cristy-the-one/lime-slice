//! `lime_recipe::horology`: known answers for the going train, the Graham escapement, the ratchet and click, the
//! BS 978-2 cycloidal teeth and the bores. `mcp/recipe-horology.test.ts` holds lust and rustc to the same numbers.

use lime_recipe::gears::{mate_phase, Outline, Piece};
use lime_recipe::horology::*;

type P2 = [f64; 2];

fn dist(a: P2, b: P2) -> f64 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)).sqrt()
}

fn rot(p: P2, deg: f64) -> P2 {
    let (s, c) = deg.to_radians().sin_cos();
    [p[0] * c - p[1] * s, p[0] * s + p[1] * c]
}

fn cross(o: P2, a: P2, b: P2) -> f64 {
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
}

fn crosses(a: P2, b: P2, c: P2, d: P2) -> bool {
    cross(a, b, c) * cross(a, b, d) < 0.0 && cross(c, d, a) * cross(c, d, b) < 0.0
}

/// No two edges of the closed polyline cross.
fn simple(pts: &[P2]) -> bool {
    let n = pts.len();
    for i in 0..n {
        for j in i + 2..n {
            if i == 0 && j == n - 1 {
                continue;
            }
            if crosses(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n]) {
                return false;
            }
        }
    }
    true
}

/// Whether any edge of one closed polyline crosses one of the other's.
fn meet(a: &[P2], b: &[P2]) -> bool {
    let (n, m) = (a.len(), b.len());
    (0..n).any(|i| (0..m).any(|j| crosses(a[i], a[(i + 1) % n], b[j], b[(j + 1) % m])))
}

fn signed_area(pts: &[P2]) -> f64 {
    let n = pts.len();
    (0..n).map(|i| pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1]).sum::<f64>() / 2.0
}

fn closes(o: &Outline) -> bool {
    let last = match o.pieces.last() {
        Some(Piece::Line(to)) | Some(Piece::Arc(_, to)) | Some(Piece::Spline(_, to)) => *to,
        None => return false,
    };
    last == o.start
}

/// Points at the outline's largest radius, counted once per run.
fn tips(pts: &[P2], radius: f64) -> usize {
    let n = pts.len();
    (0..n).filter(|&i| (dist(pts[i], [0.0, 0.0]) - radius).abs() < 1e-9 && (dist(pts[(i + n - 1) % n], [0.0, 0.0]) - radius).abs() >= 1e-9).count()
}

// ---- The going train. ----

#[test]
fn the_notes_train_gives_a_three_quarter_second_pendulum() {
    let note = [(64, 8), (50, 10), (40, 10)];
    assert_eq!(train_ratio(&note), 160.0);
    assert_eq!(escape_period_s(160.0, 30), 0.75);
    assert_eq!(escape_period_s(train_ratio(&[(60, 8), (64, 8)]), 30), 2.0, "the seconds pendulum's 60:1");
    let limits = TrainLimits::new(40, 64, 8, 10);
    let options = train_options(0.75, 30, 3, &limits).unwrap();
    assert!(options.iter().any(|t| t.stages == vec![(64, 8), (50, 10), (40, 10)]), "the note's train is an option");
    for t in options.iter() {
        assert_eq!(t.stages.len(), 3);
        assert!((t.period_s() - 0.75).abs() < 1e-12, "{t:?}");
        assert!((t.ratio() - 160.0).abs() < 1e-9, "{t:?}");
        for &(w, p) in t.stages.iter() {
            assert!((40..=64).contains(&w) && (8..=10).contains(&p), "{t:?}");
        }
        for k in 1..t.stages.len() {
            let (a, b) = (t.stages[k - 1], t.stages[k]);
            assert!(a.0 * b.1 >= b.0 * a.1, "largest ratio first: {t:?}");
        }
    }
    let best = count_train(0.75, 30, 3, &limits).unwrap();
    assert_eq!(best, options[0]);
    assert_eq!(best, count_train(0.75, 30, 3, &limits).unwrap(), "the same input gives the same train");
    assert_eq!(best.stages, vec![(50, 9), (54, 10), (48, 9)], "the most balanced train");
}

#[test]
fn trains_that_cannot_be_counted_are_refused() {
    let one = count_train(0.75, 30, 1, &TrainLimits::new(40, 64, 8, 10)).unwrap_err();
    assert!(one.contains("gives 160:1 exactly"), "{one}");
    let fraction = count_train(0.8, 30, 2, &TrainLimits::new(30, 40, 6, 8)).unwrap_err();
    assert!(fraction.contains("150:1"), "{fraction}");
    assert!(count_train(0.75, 30, 5, &TrainLimits::new(40, 64, 8, 10)).unwrap_err().contains("1 to 4 stages"));
    assert!(count_train(0.0, 30, 3, &TrainLimits::new(40, 64, 8, 10)).is_err());
    assert!(count_train(0.75, 30, 3, &TrainLimits::new(40, 64, 10, 8)).unwrap_err().contains("leaves"));
    // A ratio with a denominator: 0.7 s on 30 teeth is 1200/7.
    let seventh = count_train(0.7, 30, 3, &TrainLimits::new(30, 120, 6, 14)).unwrap();
    assert!((seventh.period_s() - 0.7).abs() < 1e-12, "{seventh:?}");
}

// ---- The Graham escapement. ----

fn note_escapement() -> Graham {
    Graham::new(EscapeWheel::new(30, 22.5, 17.5, 12.0), 7.5)
}

#[test]
fn the_pivot_stands_where_the_tangents_meet() {
    let g = note_escapement();
    assert!((g.pivot_distance() - 22.5 * 2f64.sqrt()).abs() < 1e-12, "7.5 of 30 teeth is 45 degrees each side");
    // The note's layout: escape arbor at y 75, anchor pivot at y 106.82.
    assert!((75.0 + g.pivot_distance() - 106.82).abs() < 0.005);
    assert_eq!(g.swing_deg(), 4.0);
    assert_eq!(g.letoff_deg(), (-2.0, 2.0));
    assert_eq!(g.refusal(), None);
    // A pallet is half a pitch less the drop thick: 4.5 wheel degrees at the tips, about R × 4.5° along the tangent.
    let thick = g.pallet_thickness().unwrap();
    assert!((thick - 22.5 * 4.5f64.to_radians()).abs() < 0.02, "{thick}");
}

#[test]
fn locking_faces_are_arcs_about_the_pivot() {
    let g = note_escapement();
    let (entry, exit) = g.pallets().unwrap();
    for p in [entry, exit] {
        assert!((dist(p.locking_corner, [0.0, 0.0]) - p.locking_radius).abs() < 1e-9);
        assert!((dist(p.face_end, [0.0, 0.0]) - p.locking_radius).abs() < 1e-9);
    }
    assert!(entry.locking_radius > exit.locking_radius, "the entry pallet locks on its outer face, the exit on its inner one");
    assert!((dist(entry.letoff_corner, [0.0, 0.0]) - exit.locking_radius).abs() < 1e-9, "circular pallets: both between the same radii");
    assert!((dist(exit.letoff_corner, [0.0, 0.0]) - entry.locking_radius).abs() < 1e-9);
    // In the outline, the locking faces are the arcs ending on the locking corners, through points at the same radius.
    let anchor = g.anchor().unwrap();
    assert!(closes(&anchor));
    let mut faces = 0;
    for piece in anchor.pieces.iter() {
        if let Piece::Arc(through, to) = piece {
            for p in [entry, exit] {
                if *to == p.locking_corner {
                    faces += 1;
                    assert!((dist(*through, [0.0, 0.0]) - p.locking_radius).abs() < 1e-9);
                }
            }
        }
    }
    assert_eq!(faces, 2);
    let pts = g.anchor_points(1.0).unwrap();
    assert!(simple(&pts), "the anchor's outline does not cross itself");
    assert!(signed_area(&pts) > 0.0, "counter-clockwise");
}

#[test]
fn the_beat_runs_lock_impulse_drop_lock() {
    let g = note_escapement();
    let d = g.pivot_distance();
    let r = g.wheel.tip_radius;
    let pitch = g.wheel.pitch_deg();
    let (entry, exit) = g.pallets().unwrap();
    let (e_off, x_off) = g.letoff_deg();
    // Anchor-frame point at anchor angle `a`, in the wheel's frame.
    let place = |p: P2, a: f64| {
        let q = rot(p, a);
        [q[0], q[1] + d]
    };
    // Each let-off corner is on the tip circle at its let-off, each locking corner an impulse earlier.
    assert!((dist(place(entry.letoff_corner, e_off), [0.0, 0.0]) - r).abs() < 1e-9);
    assert!((dist(place(entry.locking_corner, e_off + g.impulse_deg), [0.0, 0.0]) - r).abs() < 1e-9);
    assert!((dist(place(exit.letoff_corner, x_off), [0.0, 0.0]) - r).abs() < 1e-9);
    assert!((dist(place(exit.locking_corner, x_off - g.impulse_deg), [0.0, 0.0]) - r).abs() < 1e-9);
    // At rest a tip sits on the entry locking face, and the anchor stands at the exit let-off.
    let (phase, anchor_deg) = g.rest_pose().unwrap();
    assert_eq!(anchor_deg, x_off);
    let tip = rot([r, 0.0], phase);
    let on = rot([tip[0], tip[1] - d], -anchor_deg);
    assert!((dist(on, [0.0, 0.0]) - entry.locking_radius).abs() < 1e-9);
    // After the entry let-off the wheel runs the drop, and a tooth on the exit side lands on the exit locking face.
    let letoff_phase = phase - (pitch / 2.0 - g.drop_deg);
    let landing = letoff_phase - g.drop_deg;
    let lands = (0..30).map(|k| rot([r, 0.0], landing + pitch * k as f64)).map(|t| rot([t[0], t[1] - d], -e_off)).any(|q| (dist(q, [0.0, 0.0]) - exit.locking_radius).abs() < 1e-9 && q[0] > 0.0);
    assert!(lands, "a tooth lands on the exit locking face after the drop");
}

#[test]
fn the_escape_wheel_has_pointed_forward_leaning_teeth() {
    let wheel = EscapeWheel::new(30, 22.5, 17.5, 12.0);
    let o = wheel.outline(90.0).unwrap();
    assert!(closes(&o));
    let pts = wheel.points(90.0).unwrap();
    assert!(simple(&pts));
    assert!(signed_area(&pts) > 0.0);
    assert_eq!(tips(&pts, 22.5), 30);
    assert!(pts.iter().all(|p| dist(*p, [0.0, 0.0]) > 17.5 - 1e-9 && dist(*p, [0.0, 0.0]) < 22.5 + 1e-9));
    // Tooth 0's tip is at the top; its front face runs down to the left (behind it as the wheel turns clockwise), 12
    // degrees off the radius.
    let (tip, front_root) = (pts[1], pts[0]);
    assert!((tip[0]).abs() < 1e-12 && (tip[1] - 22.5).abs() < 1e-12);
    let lean = (tip[0] - front_root[0]).atan2(tip[1] - front_root[1]).to_degrees();
    assert!((lean - 12.0).abs() < 1e-9, "{lean}");
}

#[test]
fn escapements_that_cannot_work_are_refused() {
    let g = note_escapement();
    let said = |g: Graham, part: &str| {
        let why = g.refusal().unwrap_or_default();
        assert!(why.contains(part), "{part:?} not in {why:?}");
    };
    said(Graham::new(EscapeWheel::new(30, 22.5, 17.5, 12.0), 7.0), "whole number of teeth and a half");
    said(Graham::new(EscapeWheel::new(30, 22.5, 17.5, 12.0), 12.5), "more than 70 degrees");
    said(g.drop(0.0), "drop of nothing");
    said(g.drop(6.0), "no thickness");
    said(g.drop(0.4).clearance(0.2), "smaller than the clearance");
    // A steep impulse face (much impulse over a thin pallet) leans too little off the locking face.
    said(g.impulse(8.0).friction(0.6), "friction angle");
    said(g.hub_radius(9.5), "hub reaches");
    said(Graham::new(EscapeWheel::new(30, 22.5, 21.5, 12.0), 7.5), "away from the tooth tips");
    said(Graham::new(EscapeWheel::new(30, 22.5, 20.0, 0.0), 7.5).supplementary(6.0), "away from the tooth tips");
    assert!(g.anchor().is_ok());
}

// ---- Ratchet and click. ----

#[test]
fn the_click_seats_on_the_tangent_and_lifts_clear() {
    let ratchet = Ratchet::new(24, 15.0, 12.5);
    let o = ratchet.outline(0.0).unwrap();
    assert!(closes(&o));
    let pts = ratchet.points(0.0).unwrap();
    assert!(simple(&pts));
    assert!(signed_area(&pts) > 0.0);
    assert_eq!(tips(&pts, 15.0), 24);
    let size = ratchet.click_size(18.0);
    let c = ratchet.click(0.0, &size).unwrap();
    assert!(closes(&c.outline));
    let local = outline_points(&c.outline, 2.0);
    assert!(simple(&local));
    assert!(signed_area(&local) > 0.0);
    // Placed: turned by seat_deg, moved to the pivot.
    let placed: Vec<P2> = local.iter().map(|p| rot(*p, c.seat_deg)).map(|p| [p[0] + c.pivot[0], p[1] + c.pivot[1]]).collect();
    let nose = rot(c.nose, c.seat_deg);
    let nose = [nose[0] + c.pivot[0], nose[1] + c.pivot[1]];
    assert!(dist(nose, [12.5 + size.seat_gap, 0.0]) < 1e-9, "the nose sits on tooth 0's face, seat_gap off the root");
    // The pivot lies on the tangent through the middle of the face: the face's push passes through it.
    let mid = [(12.5 + size.seat_gap + 15.0) / 2.0, 0.0];
    assert!(((c.pivot[0] - mid[0]) * mid[0] + (c.pivot[1] - mid[1]) * mid[1]).abs() < 1e-9);
    assert!(!meet(&placed, &pts), "the seated click only touches the ratchet");
    assert!(placed.iter().all(|p| dist(*p, [0.0, 0.0]) >= 12.5 + size.seat_gap - 1e-9));
    // The lift brings the nose to the tip circle, turning outward.
    assert!(c.lift_deg > 0.0, "{}", c.lift_deg);
    let lifted = rot(c.nose, c.seat_deg + c.lift_deg);
    assert!((dist([lifted[0] + c.pivot[0], lifted[1] + c.pivot[1]], [0.0, 0.0]) - 15.0).abs() < 1e-9);
    // A wound ratchet passes under the lifted click.
    let up: Vec<P2> = local.iter().map(|p| rot(*p, c.seat_deg + c.lift_deg)).map(|p| [p[0] + c.pivot[0], p[1] + c.pivot[1]]).collect();
    for turn in [-3.0, -7.5, -11.0] {
        assert!(!meet(&up, &ratchet.points(turn).unwrap()), "turned {turn}");
    }
    assert!(ratchet.click(0.0, &ratchet.click_size(2.0)).unwrap_err().contains("hub reaches"));
    assert!(Ratchet::new(3, 15.0, 12.5).refusal().is_some());
}

// ---- Cycloidal clock teeth. ----

/// BS 978-2's full wheel addendum, by S. Parks' iteration ("Designing Cycloidal Gears", eqs. 9, 11, 17).
fn parks_addendum(wheel: u32, pinion: u32) -> f64 {
    let ratio = wheel as f64 / pinion as f64;
    let k = 1.0 + 2.0 * ratio;
    let mut theta = std::f64::consts::PI / pinion as f64;
    for _ in 0..200 {
        let beta = (theta.sin() / (1.0 + 2.0 * ratio - theta.cos())).atan();
        theta = std::f64::consts::PI / pinion as f64 + 2.0 * ratio * beta;
    }
    pinion as f64 / 4.0 * (1.0 - k + (1.0 + k * k - 2.0 * k * theta.cos()).sqrt())
}

#[test]
fn the_wheel_addendum_is_bs_978s() {
    for (z, zp) in [(64, 8), (50, 10), (40, 10), (60, 8), (96, 12), (30, 6), (80, 16)] {
        let w = ClockWheel::new(z, 1.0, zp);
        let ours = w.addendum_factor();
        let parks = parks_addendum(z, zp);
        assert!((ours - parks).abs() < 1e-9, "{z}/{zp}: {ours} against {parks}");
        assert!((w.addendum() - 0.95 * ours).abs() < 1e-12);
    }
}

#[test]
fn clock_wheels_and_pinions_mesh_through_a_turn() {
    for (z, zp, top) in [(64, 8, LeafTop::Medium), (50, 10, LeafTop::Round), (40, 7, LeafTop::High), (96, 12, LeafTop::Round)] {
        let m = 1.5;
        let wheel = ClockWheel::new(z, m, zp);
        let pinion = wheel.pinion(top);
        assert_eq!(pinion.refusal(), None);
        let wo = wheel.outline(0.0).unwrap();
        let po = pinion.outline(0.0).unwrap();
        assert!(closes(&wo) && closes(&po));
        let wp = wheel.points(0.0, 8).unwrap();
        let pp = pinion.points(0.0).unwrap();
        assert!(simple(&wp) && simple(&pp), "{z}/{zp}");
        assert!(signed_area(&wp) > 0.0 && signed_area(&pp) > 0.0);
        assert_eq!(tips(&wp, wheel.tip_radius()), z as usize);
        assert!(wp.iter().all(|p| dist(*p, [0.0, 0.0]) > wheel.root_radius() - 1e-9 && dist(*p, [0.0, 0.0]) < wheel.tip_radius() + 1e-9));
        assert!((wheel.root_radius() - (wheel.pitch_radius() - std::f64::consts::PI / 2.0 * m)).abs() < 1e-12);
        let tip = pp.iter().map(|p| dist(*p, [0.0, 0.0])).fold(0.0, f64::max);
        assert!((tip - pinion.tip_radius()).abs() < 1e-9, "{tip} {}", pinion.tip_radius());
        // In mesh at the centre distance, turned through two pitches in small steps: the outlines never cross.
        let a = wheel.centre_distance();
        let phase = mate_phase(0.0, z, 0.0, zp);
        for step in 0..=40 {
            let turn = 2.0 * 360.0 / z as f64 * step as f64 / 40.0;
            let w = wheel.points(turn, 8).unwrap();
            let p: Vec<P2> = pinion.points(phase - turn * z as f64 / zp as f64).unwrap().iter().map(|q| [q[0] + a, q[1]]).collect();
            assert!(!meet(&w, &p), "{z}/{zp} crosses at {turn}");
        }
    }
}

#[test]
fn the_epicycloid_points_are_exact_and_the_chords_close() {
    // The flank's spline points lie on the epicycloid rolled by a circle of half the pinion's pitch radius; between
    // them the chords stay within a hundredth of a module of it.
    let (z, zp, m) = (64u32, 8u32, 1.0);
    let wheel = ClockWheel::new(z, m, zp);
    let big = wheel.pitch_radius();
    let g = m * zp as f64 / 4.0;
    let half = std::f64::consts::PI / (2.0 * z as f64);
    let cyc = |t: f64| {
        let k = (big + g) / g;
        rot([(big + g) * t.cos() - g * (k * t).cos(), (big + g) * t.sin() - g * (k * t).sin()], -half.to_degrees())
    };
    let o = wheel.outline(0.0).unwrap();
    let Piece::Spline(through, to) = &o.pieces[1] else { panic!("the flank is a spline") };
    let mut knots = vec![rot([big, 0.0], -half.to_degrees())];
    knots.extend(through.iter().copied());
    knots.push(*to);
    // Each knot is on the curve: the roll that reaches its radius reaches the knot.
    let apex = std::f64::consts::PI * g / big;
    for k in knots.iter() {
        let (mut lo, mut hi) = (0.0, apex);
        for _ in 0..200 {
            let mid = 0.5 * (lo + hi);
            if dist(cyc(mid), [0.0, 0.0]) < dist(*k, [0.0, 0.0]) {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        assert!(dist(cyc(hi), *k) < 1e-9, "{}", dist(cyc(hi), *k));
    }
    let fine: Vec<P2> = (0..=20000).map(|i| cyc(apex * i as f64 / 20000.0)).collect();
    let mut worst: f64 = 0.0;
    for p in fine.iter().filter(|p| dist(**p, [0.0, 0.0]) <= wheel.tip_radius()) {
        let d = (0..knots.len() - 1)
            .map(|i| {
                let (a, b) = (knots[i], knots[i + 1]);
                let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
                let t = (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)).clamp(0.0, 1.0);
                dist(*p, [a[0] + t * dx, a[1] + t * dy])
            })
            .fold(f64::MAX, f64::min);
        worst = worst.max(d);
    }
    println!("64/8 at module 1: chords within {worst} mm of the epicycloid");
    assert!(worst < 0.01 * m, "chord error {worst}");
}

// ---- Bores. ----

#[test]
fn bores_follow_iso_286_plus_the_printers_allowance() {
    assert_eq!(STEEL_PINS, [1.0, 1.5, 2.0, 3.0]);
    assert!((pin_bore(2.0, Fit::Running, 0.2).unwrap() - 2.245).abs() < 1e-12);
    assert!((pin_bore(3.0, Fit::Press, 0.0).unwrap() - 2.996).abs() < 1e-12, "3 mm is in the 0 to 3 mm row");
    assert!((pin_bore(1.5, Fit::Sliding, 0.1).unwrap() - 1.608).abs() < 1e-12);
    assert_eq!(fit_clearance(31.0, Fit::Running), None);
    assert_eq!(hole(0.0, Fit::Running, 0.0), None);
    let b = bearing("623").unwrap();
    assert_eq!((b.bore, b.outer, b.width), (3.0, 10.0, 4.0));
    assert!((b.seat(Fit::Press, 0.15) - (10.0 - 0.012 + 0.15)).abs() < 1e-12);
    assert!((b.shaft(Fit::Sliding, 0.05) - (3.0 - 0.008 - 0.05)).abs() < 1e-12);
    let mr85 = bearing("MR85").unwrap();
    assert_eq!((mr85.bore, mr85.outer, mr85.width), (5.0, 8.0, 2.5));
    assert_eq!(bearing("6204"), None);
    for name in BEARINGS {
        let b = bearing(name).unwrap();
        assert!(b.bore < b.outer && b.width > 0.0, "{name}");
    }
}
