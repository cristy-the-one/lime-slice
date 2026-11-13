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
    let report = classify(&driver, &driven, [0.0, 0.0], [36.0, 0.0], 0.0, 172.5);
    assert_eq!(report.verdict, PairVerdict::ModuleMismatch);
    assert!(!report.narrow);
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
