//! External spur gears: `gear_pair` agrees with the poses Open CASCADE measures in
//! `lime-model-occt/tests/gear.rs` (`two_gears_mesh_at_their_centre_distance_within_their_backlash`).
//! 0.1 mm of backlash on each tooth is 0.2 mm of play, 0.1 mm each way along the pitch circle.

use lime_recipe::gear_pair::{PairReport, PairVerdict, classify, driven_turn};
use lime_recipe::gears::{Gear, mate_phase};

const PAIRS: [(u32, u32, f64); 4] = [(12, 24, 2.0), (17, 31, 1.5), (9, 40, 1.0), (24, 24, 1.0)];

fn mesh(z1: u32, z2: u32, module: f64) -> (Gear, Gear, f64, f64) {
    let (driver, driven) = (Gear::new(z1, module), Gear::new(z2, module));
    let distance = driver.centre_distance(&driven);
    let phase = mate_phase(0.0, z1, 0.0, z2);
    (driver, driven, distance, phase)
}

/// The driven gear's phase after it is turned `turn_mm` along its pitch circle from the mating phase.
fn turned(driven: &Gear, phase: f64, turn_mm: f64) -> f64 {
    phase + (turn_mm / driven.pitch_radius()) * (180.0 / std::f64::consts::PI)
}

fn at(driver: &Gear, driven: &Gear, distance: f64, phase: f64, turn_mm: f64) -> PairReport {
    classify(
        driver,
        driven,
        [0.0, 0.0],
        [distance, 0.0],
        0.0,
        turned(driven, phase, turn_mm),
    )
}

#[test]
fn meshing_pairs_match_the_kernel_cases() {
    for (z1, z2, module) in PAIRS {
        let (driver, driven, distance, phase) = mesh(z1, z2, module);
        for turn in [0.0, 0.06, -0.06] {
            let report = at(&driver, &driven, distance, phase, turn);
            assert_eq!(
                report.verdict,
                PairVerdict::Meshing,
                "{z1} with {z2} at {turn} mm: {}",
                report.verdict.as_str()
            );
            assert!(
                report.narrow,
                "{z1} with {z2}: the tip circles meet, so the outlines are compared"
            );
            assert!(
                !report.hit,
                "{z1} with {z2} at {turn} mm: a segment crossed"
            );
        }
        for turn in [0.16, -0.16] {
            let report = at(&driver, &driven, distance, phase, turn);
            assert_eq!(
                report.verdict,
                PairVerdict::ToothOnTooth,
                "{z1} with {z2} at {turn} mm is interference, got {}",
                report.verdict.as_str()
            );
            assert!(report.verdict.interferes());
        }
        let half = at(
            &driver,
            &driven,
            distance,
            phase,
            std::f64::consts::PI * module / 2.0,
        );
        assert_eq!(
            half.verdict,
            PairVerdict::ToothOnTooth,
            "{z1} with {z2}: half a tooth is tooth on tooth, got {}",
            half.verdict.as_str()
        );
        assert!(half.narrow);
    }
}

#[test]
fn far_apart_skips_the_outlines() {
    let (driver, driven, _, phase) = mesh(12, 24, 2.0);
    let report = classify(&driver, &driven, [0.0, 0.0], [1_000.0, 0.0], 0.0, phase);
    assert_eq!(report.verdict, PairVerdict::Apart);
    assert!(!report.narrow);
    assert!(!report.hit);
}

#[test]
fn different_modules_do_not_mesh() {
    let driver = Gear::new(12, 2.0);
    let driven = Gear::new(24, 1.5);
    // Tip radii 14 and 19.5 mm: at 30 mm the gears reach each other, and they cannot mesh.
    let report = classify(&driver, &driven, [0.0, 0.0], [30.0, 0.0], 0.0, 172.5);
    assert_eq!(report.verdict, PairVerdict::ModuleMismatch);
    assert!(!report.narrow);
    // At 36 mm they do not reach: two stages of a train with different modules are not a fault.
    let stages = classify(&driver, &driven, [0.0, 0.0], [36.0, 0.0], 0.0, 172.5);
    assert_eq!(stages.verdict, PairVerdict::Apart);
}

#[test]
fn different_pressure_angles_do_not_mesh() {
    let driver = Gear::new(12, 2.0);
    let driven = Gear::new(24, 2.0).pressure(25.0);
    let distance = Gear::new(12, 2.0).centre_distance(&Gear::new(24, 2.0));
    let phase = mate_phase(0.0, 12, 0.0, 24);
    let report = classify(&driver, &driven, [0.0, 0.0], [distance, 0.0], 0.0, phase);
    assert_eq!(report.verdict, PairVerdict::PressureMismatch);
    assert!(!report.narrow);
}

#[test]
fn centres_inside_the_backlash_are_too_close() {
    let (driver, driven, distance, phase) = mesh(24, 24, 1.0);
    let report = classify(
        &driver,
        &driven,
        [0.0, 0.0],
        [distance - 0.25, 0.0],
        0.0,
        phase,
    );
    assert_eq!(report.verdict, PairVerdict::TooClose);
    assert!(report.narrow, "the tip circles still meet");
}

#[test]
fn extra_centre_distance_widens_the_play() {
    let (driver, driven, _, phase) = mesh(12, 24, 2.0);
    // 0.16 mm is past the 0.1 mm of play at the working distance. The radial band is both
    // backlashes, the same edge as tooClose: 36.2 mm is still on it, and past it is loose
    // when nothing crosses. Tangential play is (b1+b2)/2 + (distance - working) * tan(pressure).
    let on_edge = at(&driver, &driven, 36.2, phase, 0.16);
    assert!(!on_edge.hit, "36.2 mm: a segment crossed");
    assert_eq!(on_edge.verdict, PairVerdict::Meshing, "36.2 is the far edge of the band, not past it");
    for distance in [37.0, 38.0, 39.9] {
        let report = at(&driver, &driven, distance, phase, 0.16);
        assert!(!report.hit, "{distance} mm: a segment crossed");
        assert_eq!(report.verdict, PairVerdict::Loose, "{distance} mm is past the backlash band");
    }
    let wide = at(&driver, &driven, 39.9, phase, 0.0);
    assert_eq!(wide.verdict, PairVerdict::Loose, "12/24 m2 at 39.9 mm");
    assert!(!wide.hit);
    // Closer than the working distance, the same allowance shrinks. 0.065 mm is inside the
    // centred 0.1 mm and past the play at 35.9 mm, and the outlines do not cross.
    let tight = at(&driver, &driven, 35.9, phase, 0.065);
    assert!(!tight.hit, "0.065 mm does not cross; the verdict is the shrunk allowance");
    assert_eq!(tight.verdict, PairVerdict::ToothOnTooth, "the close side shrinks the play");
    // A crossing is still tooth on tooth when the arc would otherwise be allowed.
    let crossed = at(&driver, &driven, 36.0, phase, std::f64::consts::PI);
    assert!(crossed.hit, "half a tooth crosses");
    assert_eq!(crossed.verdict, PairVerdict::ToothOnTooth);
}

#[test]
fn an_outline_that_cannot_be_built_is_not_a_mesh() {
    let pointed = Gear::new(6, 1.0).pressure(30.0).shift(1.0);
    assert!(
        pointed.refusal().unwrap().contains("come to a point"),
        "the repro is the existing refusal"
    );
    let mate = Gear::new(12, 1.0).pressure(30.0);
    let distance = pointed.centre_distance(&mate);
    let phase = mate_phase(0.0, 6, 0.0, 12);
    let report = classify(&pointed, &mate, [0.0, 0.0], [distance, 0.0], 0.0, phase);
    assert!(!report.narrow, "the outlines were not compared");
    assert!(!report.hit);
    assert_eq!(report.verdict, PairVerdict::Unbuildable);
}

#[test]
fn a_driven_turn_stays_in_mesh() {
    for (z1, z2, module) in PAIRS {
        let (driver, driven, distance, phase) = mesh(z1, z2, module);
        for angle in [0.0, 1.0, 15.0, 90.0, 180.0, 360.0] {
            let report = driven_turn(
                &driver,
                &driven,
                [0.0, 0.0],
                [distance, 0.0],
                0.0,
                phase,
                angle,
            );
            assert_eq!(
                report.verdict,
                PairVerdict::Meshing,
                "{z1} with {z2} at driver {angle}°: {}",
                report.verdict.as_str()
            );
            assert!(
                !report.hit,
                "{z1} with {z2} at driver {angle}°: a segment crossed"
            );
            assert!(report.narrow);
        }
    }
}

#[test]
fn a_loose_pair_out_of_phase_crosses_only_when_its_outlines_do() {
    let (driver, driven, _, phase) = mesh(12, 24, 2.0);
    let pitch_mm = std::f64::consts::PI * 2.0;
    // Past the band the teeth are narrow where they overlap, so there is more room than the pitch-circle play says.
    // A fifth of a tooth at 39 mm, and just over a quarter at 39.5 mm, cross nothing: the pair is loose.
    for (distance, tooth) in [(39.0, 0.2), (39.5, 0.26)] {
        let report = at(&driver, &driven, distance, phase, tooth * pitch_mm);
        assert!(!report.hit, "{distance} mm, {tooth} of a tooth: a segment crossed");
        assert_eq!(report.verdict, PairVerdict::Loose, "{distance} mm, {tooth} of a tooth");
    }
    // Tip against tip does cross.
    for (distance, tooth) in [(39.0, 0.5), (39.5, 0.5), (38.0, 0.2)] {
        let report = at(&driver, &driven, distance, phase, tooth * pitch_mm);
        assert!(report.hit, "{distance} mm, {tooth} of a tooth");
        assert_eq!(report.verdict, PairVerdict::ToothOnTooth, "{distance} mm, {tooth} of a tooth");
    }
}
