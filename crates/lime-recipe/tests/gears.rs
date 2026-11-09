//! `lime_recipe::gears`: the adopted library functions give the library ingredient's numbers bit for bit, and the new
//! `Gear` outlines are sound. `fixtures/involute_gears_v1.rs` is the library's `involute-gears` v1, copied as it was
//! adopted (docs/plan-native-recipes.md section 5); `mcp/recipe-gears.test.ts` runs the same comparison built by lust.

#[allow(dead_code, clippy::all)]
#[path = "fixtures/involute_gears_v1.rs"]
mod library;

use lime_recipe::gears::{self, Gear, Piece};

fn bits(points: &[[f64; 2]]) -> Vec<[u64; 2]> {
    points.iter().map(|p| [p[0].to_bits(), p[1].to_bits()]).collect()
}

const MODULES: [f64; 6] = [0.3, 0.5, 1.0, 1.25, 2.0, 3.175];
const BACKLASH: [f64; 4] = [0.0, 0.05, 0.1, 0.25];
const PHASES: [f64; 6] = [0.0, 7.5, -33.3, 90.0, 180.0, 1e-9];

#[test]
fn outlines_are_the_library_s_bit_for_bit() {
    let mut compared = 0usize;
    for z in 6..=120u32 {
        for &m in MODULES.iter() {
            for &b in BACKLASH.iter() {
                for flank in [2usize, 3, 5, 8] {
                    for &phase in PHASES.iter() {
                        let ours = gears::gear_outline_with(z, m, b, flank, phase);
                        let theirs = library::gear_outline_with(z, m, b, flank, phase);
                        assert_eq!(bits(&ours), bits(&theirs), "z {z} m {m} backlash {b} flank {flank} phase {phase}");
                        compared += ours.len();
                    }
                }
            }
            let ours = gears::gear_outline(z, m, 12.5);
            assert_eq!(bits(&ours), bits(&library::gear_outline(z, m, 12.5)), "gear_outline z {z} m {m}");
            assert_eq!(gears::pitch_radius(z, m).to_bits(), library::pitch_radius(z, m).to_bits());
            let mut a = Vec::new();
            let mut b = Vec::new();
            gears::gear_tooth(z, m, 0.1, 4, 0.3, &mut a);
            library::gear_tooth(z, m, 0.1, 4, 0.3, &mut b);
            assert_eq!(bits(&a), bits(&b));
        }
    }
    assert!(compared > 10_000_000, "{compared}");
}

#[test]
fn train_helpers_are_the_library_s_bit_for_bit() {
    for own_z in [6u32, 9, 12, 17, 24, 40, 77, 120] {
        for mate_z in [6u32, 10, 13, 24, 31, 60, 120] {
            for own_phase in [0.0, 3.3, -15.0, 359.0, 720.5] {
                for dir in [-180.0, -97.25, 0.0, 33.0, 90.0, 179.999] {
                    let ours = gears::mate_phase(own_phase, own_z, dir, mate_z);
                    let theirs = library::mate_phase(own_phase, own_z, dir, mate_z);
                    assert_eq!(ours.to_bits(), theirs.to_bits(), "{own_phase} {own_z} {dir} {mate_z}");
                }
            }
            assert_eq!(gears::mate_turn(37.5, own_z, mate_z).to_bits(), library::mate_turn(37.5, own_z, mate_z).to_bits());
        }
    }
    for a in [0.0, 0.1, 0.349, 0.7] {
        assert_eq!(gears::involute(a).to_bits(), library::involute(a).to_bits());
    }
    let centres = [[0.0, 0.0], [10.0, 0.0], [3.5, -7.25], [-40.0, 12.0]];
    for &a in centres.iter() {
        for &c in centres.iter() {
            assert_eq!(gears::dir_deg(a, c).to_bits(), library::dir_deg(a, c).to_bits());
            for (d1, d2) in [(12.0, 18.0), (5.0, 5.0), (30.0, 1.0), (24.5, 31.25)] {
                for left in [true, false] {
                    let ours = gears::idler_centre(a, c, d1, d2, left).map(|p| [p[0].to_bits(), p[1].to_bits()]);
                    let theirs = library::idler_centre(a, c, d1, d2, left).map(|p| [p[0].to_bits(), p[1].to_bits()]);
                    assert_eq!(ours, theirs, "{a:?} {c:?} {d1} {d2} {left}");
                }
            }
        }
    }
    for &m in MODULES.iter() {
        for count in 1..12 {
            let centres: Vec<f64> = (0..count).map(|i| -20.0 + std::f64::consts::PI * m * i as f64).collect();
            for back in [2.0, 5.5, 0.0] {
                assert_eq!(bits(&gears::rack_outline(m, &centres, back)), bits(&library::rack_outline(m, &centres, back)));
            }
        }
    }
}

/// The outline's points, with each spline's and arc's through points, in order.
fn walk(gear: &Gear, phase: f64) -> Vec<[f64; 2]> {
    let outline = gear.outline(phase).unwrap();
    let mut pts = vec![outline.start];
    for piece in outline.pieces.iter() {
        match piece {
            Piece::Line(to) => pts.push(*to),
            Piece::Arc(through, to) => pts.extend([*through, *to]),
            Piece::Spline(through, to) => {
                pts.extend(through.iter().copied());
                pts.push(*to);
            }
        }
    }
    pts
}

#[test]
fn a_gear_outline_closes_and_stays_between_root_and_tip() {
    for z in gears::MIN_TEETH..=gears::MAX_TEETH {
        for (pressure, shift) in [(20.0, 0.0), (14.5, 0.0), (25.0, 0.0), (20.0, 0.5), (20.0, -0.2)] {
            let gear = Gear::new(z, 1.5).pressure(pressure).shift(shift);
            let Ok(outline) = gear.outline(10.0) else {
                continue;
            };
            let pts = walk(&gear, 10.0);
            assert_eq!(pts.first(), pts.last(), "z {z}: the loop ends where it starts");
            let (rf, ra) = (gear.root_radius(), gear.tip_radius());
            for p in pts.iter() {
                let rho = p[0].hypot(p[1]);
                assert!(rho >= rf - 1e-9 && rho <= ra + 1e-9, "z {z} {pressure} {shift}: {rho} outside {rf}..{ra}");
            }
            // Per tooth: a root arc, a tip arc, two involutes, two fillets, and two undercut pieces on an undercut gear.
            let per_tooth = outline.pieces.len() / z as usize;
            assert!(outline.pieces.len() % z as usize == 0 && per_tooth >= 6 && per_tooth % 2 == 0, "z {z}: {per_tooth} pieces a tooth");
        }
    }
    // The standard 20-degree gears all build, from 6 teeth up.
    for z in gears::MIN_TEETH..=gears::MAX_TEETH {
        assert_eq!(Gear::new(z, 1.0).refusal(), None, "z {z}");
    }
}

#[test]
fn the_area_matches_the_library_polyline_closely() {
    // The library's 8-point polyline is close to the involute; the true outline differs by its root (rack fillet
    // against straight radial lines), so compare a gear big enough to need no undercut, with the same backlash.
    for z in [24u32, 40, 60] {
        let gear = Gear::new(z, 2.0);
        let ours = gear.area().unwrap();
        let poly = gears::gear_outline_with(z, 2.0, 0.1, 40, 0.0);
        let n = poly.len();
        let theirs: f64 = (0..n).map(|i| poly[i][0] * poly[(i + 1) % n][1] - poly[i][1] * poly[(i + 1) % n][0]).sum::<f64>() / 2.0;
        let pitch_area = std::f64::consts::PI * gear.pitch_radius().powi(2);
        assert!((ours - theirs).abs() / ours < 0.01, "z {z}: {ours} vs {theirs}");
        assert!(ours > pitch_area * 0.9 && ours < pitch_area * 1.1, "z {z}: {ours} vs pitch circle {pitch_area}");
    }
}

#[test]
fn tooth_thickness_at_the_pitch_circle() {
    // The dense outline crosses the pitch circle where the tooth is pitch_thickness wide.
    for (z, shift, backlash) in [(12u32, 0.0, 0.1), (24, 0.0, 0.0), (24, 0.3, 0.1), (60, -0.2, 0.2)] {
        let gear = Gear::new(z, 2.0).shift(shift).backlash(backlash);
        let r = gear.pitch_radius();
        let pts = gear.points(0.0, 2000).unwrap();
        // Tooth 0 is centred on +X: find where its counter-clockwise flank crosses r.
        let mut half = None;
        for w in pts.windows(2) {
            let (a, b) = (w[0][0].hypot(w[0][1]), w[1][0].hypot(w[1][1]));
            let (aa, ab) = (w[0][1].atan2(w[0][0]), w[1][1].atan2(w[1][0]));
            if aa > 0.0 && ab > 0.0 && aa < std::f64::consts::PI / z as f64 && (a - r) * (b - r) <= 0.0 && a > b {
                let t = (a - r) / (a - b);
                half = Some(aa + (ab - aa) * t);
            }
        }
        let width = 2.0 * r * half.expect("crosses the pitch circle");
        let expected = std::f64::consts::PI * 2.0 / 2.0 + 2.0 * shift * 2.0 * 20f64.to_radians().tan() - backlash;
        assert!((width - expected).abs() < 2e-4, "z {z}: {width} vs {expected}");
        assert!((gear.pitch_thickness() - expected).abs() < 1e-9);
    }
}

#[test]
fn small_gears_are_undercut_by_the_rack() {
    // Below 17 teeth at 20 degrees the rack's tip cuts into the involute: the fillet meets it above the base circle.
    let small = Gear::new(10, 1.0);
    let outline = small.outline(0.0).unwrap();
    assert!(small.undercut());
    // The cutter's path runs inside the involute past the base circle, so the flank's involute starts higher up.
    let Piece::Spline(_, undercut_end) = &outline.pieces[0] else { panic!("the cutter's path first") };
    assert!(undercut_end[0].hypot(undercut_end[1]) > small.base_radius() + 1e-3, "{undercut_end:?} vs base {}", small.base_radius());
    // The tooth is thinner there than the involute would be: compare the dense outline with the involute at that radius.
    let gear = Gear::new(10, 1.0).backlash(0.0);
    let thin = Gear::new(10, 1.0).backlash(0.0).points(0.0, 400).unwrap();
    let r = gear.base_radius();
    let rb = gear.base_radius();
    let t = ((r * r - rb * rb).sqrt()) / rb;
    let involute_half = std::f64::consts::PI / 20.0 + (20f64.to_radians().tan() - 20f64.to_radians()) - (t - t.atan());
    let ours = thin
        .iter()
        .filter(|p| p[1] > 0.0 && p[1].atan2(p[0]) < std::f64::consts::PI / 10.0 && (p[0].hypot(p[1]) - r).abs() < 0.02)
        .map(|p| p[1].atan2(p[0]))
        .fold(f64::INFINITY, f64::min);
    assert!(ours < involute_half - 1e-4, "undercut half-angle {ours} vs involute {involute_half}");
    // Shifted out by half a module (more than the 0.41 that 10 teeth need) the rack clears the involute: one fillet,
    // ending on the form circle above the base circle.
    let shifted = Gear::new(10, 1.0).shift(0.5);
    assert!(!shifted.undercut());
    let outline = shifted.outline(0.0).unwrap();
    assert_eq!(outline.pieces.len(), 10 * 6);
    let Piece::Spline(_, end) = &outline.pieces[0] else { panic!("a fillet first") };
    assert!(end[0].hypot(end[1]) > shifted.base_radius());
    // With the ISO 53 rack (tip round 0.38 m) 18 teeth at 20 degrees are clear and 17 are just undercut.
    assert!(!Gear::new(18, 1.0).undercut() && Gear::new(17, 1.0).undercut());
    for z in gears::MIN_TEETH..=gears::MAX_TEETH {
        let per_tooth = Gear::new(z, 1.0).outline(0.0).unwrap().pieces.len() / z as usize;
        assert!(per_tooth >= 6 && per_tooth % 2 == 0, "z {z}: {per_tooth}");
    }
}

#[test]
fn refusals_are_one_sentence() {
    let cases = [
        (Gear::new(5, 1.0), "A gear takes 6 to 150 teeth."),
        (Gear::new(151, 1.0), "A gear takes 6 to 150 teeth."),
        (Gear::new(20, 0.0), "A gear's module is 0.05 to 50 mm."),
        (Gear::new(20, 1.0).pressure(40.0), "A gear's pressure angle is 10 to 30 degrees."),
        (Gear::new(20, 1.0).shift(1.5), "A gear's profile shift is -1 to 1, times the module."),
        (Gear::new(20, 1.0).backlash(-0.1), "A gear's backlash is 0 to one module, in mm at the pitch circle."),
        (Gear::new(8, 1.0).shift(1.0), "These teeth come to a point below the tip: use less profile shift, more teeth, or a smaller pressure angle."),
        (Gear::new(6, 1.0).shift(-1.0), "The undercut cuts through these teeth: use more teeth or a positive profile shift."),
    ];
    for (gear, why) in cases {
        assert_eq!(gear.refusal().as_deref(), Some(why), "{gear:?}");
        assert_eq!(gear.outline(0.0).err().as_deref(), Some(why));
    }
}

#[test]
fn centre_distance_with_and_without_shift() {
    let (a, b) = (Gear::new(12, 2.0), Gear::new(30, 2.0));
    assert_eq!(a.centre_distance(&b), 42.0);
    // Shifted pair: the working pressure angle grows, so the distance is a little less than r1 + r2 + (x1 + x2) m.
    let (a, b) = (Gear::new(12, 2.0).shift(0.4), Gear::new(30, 2.0).shift(0.1));
    let d = a.centre_distance(&b);
    assert!(d > 42.0 && d < 43.0, "{d}");
}

#[test]
fn the_loop_is_what_extrude_takes() {
    let gear = Gear::new(9, 1.0);
    let json = gear.outline(0.0).unwrap().to_loop().to_string();
    assert!(json.starts_with("{\"start\":["), "{json}");
    assert!(json.contains("\"kind\":\"spline\"") && json.contains("\"kind\":\"arc\""), "{json}");
    // The kernel op's builder spells the fields the guide lists.
    let op = lime_recipe::ops::gear("fuse", &gear, 6.0, [1.0, 2.0, 3.0]).to_string();
    assert_eq!(op, r#"{"kind":"gear","op":"fuse","teeth":9,"module":1,"thickness":6,"pressureDeg":20,"backlash":0.1,"profileShift":0,"origin":[1,2,3]}"#);
    let solid = lime_recipe::ops::gear_solid(&gear, 6.0).to_string();
    assert_eq!(solid, r#"{"primitive":"gear","teeth":9,"module":1,"thickness":6,"pressureDeg":20,"backlash":0.1,"profileShift":0}"#);
}
