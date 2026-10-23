//! The straight kernel cut: one `BRepAlgoAPI_Splitter` over a solid and every plane, pieces in partition order.
//! `LIME_REQUIRE_OCCT=1` makes a missing kernel a failure.

use std::f64::consts::PI;

use lime_model_occt::PartitionPiece;
use serde_json::json;

const X: [f64; 3] = [1.0, 0.0, 0.0];
const Y: [f64; 3] = [0.0, 1.0, 0.0];
const Z: [f64; 3] = [0.0, 0.0, 1.0];

fn plane(origin: [f64; 3], normal: [f64; 3]) -> [f64; 6] {
    [
        origin[0], origin[1], origin[2], normal[0], normal[1], normal[2],
    ]
}

fn cube(size: [f64; 3]) -> String {
    json!({ "primitive": "box", "origin": [0.0, 0.0, 0.0], "size": size }).to_string()
}

fn cut(solid: &str, planes: &[[f64; 6]]) -> Option<Result<Vec<PartitionPiece>, String>> {
    let answer = lime_model_occt::partition_primitive(solid, planes);
    if matches!(&answer, Err(message) if message.contains("OCCT_ROOT")) {
        assert!(
            std::env::var_os("LIME_REQUIRE_OCCT").is_none(),
            "Open CASCADE is required"
        );
        return None;
    }
    Some(answer)
}

fn pieces(solid: &str, planes: &[[f64; 6]]) -> Option<Vec<PartitionPiece>> {
    cut(solid, planes).map(|answer| answer.unwrap_or_else(|message| panic!("{message}")))
}

fn refusal(solid: &str, planes: &[[f64; 6]]) -> Option<String> {
    cut(solid, planes).map(|answer| match answer {
        Ok(made) => panic!("expected a refusal, got {} pieces", made.len()),
        Err(message) => message,
    })
}

fn volumes(made: &[PartitionPiece]) -> Vec<f64> {
    made.iter().map(|piece| piece.volume_mm3).collect()
}

fn within(actual: f64, expected: f64, tolerance: f64) {
    assert!(
        (actual - expected).abs() <= tolerance,
        "{actual} is not within {tolerance} of {expected}"
    );
}

fn all_within(actual: &[f64], expected: &[f64], tolerance: f64) {
    assert_eq!(
        actual.len(),
        expected.len(),
        "{actual:?} against {expected:?}"
    );
    for (a, e) in actual.iter().zip(expected) {
        within(*a, *e, tolerance);
    }
}

fn whole(made: &[PartitionPiece]) {
    for piece in made {
        assert_eq!(piece.solids, 1, "{piece:?}");
        assert!(piece.valid, "{piece:?}");
        assert!(piece.closed, "{piece:?}");
    }
}

#[test]
fn a_box_cut_square_to_its_sides_is_two_halves_of_six_faces() {
    let Some(made) = pieces(&cube([20.0, 10.0, 10.0]), &[plane([10.0, 0.0, 0.0], X)]) else {
        return;
    };
    all_within(&volumes(&made), &[1000.0, 1000.0], 1e-6);
    within(volumes(&made).iter().sum::<f64>(), 2000.0, 1e-6);
    assert_eq!(
        made.iter().map(|piece| piece.faces).collect::<Vec<_>>(),
        [6, 6]
    );
    whole(&made);
}

#[test]
fn a_cube_cut_through_all_six_faces_is_two_halves_of_seven_faces() {
    let corner = plane([5.0, 5.0, 5.0], [1.0, 1.0, 1.0]);
    let Some(made) = pieces(&cube([10.0, 10.0, 10.0]), &[corner]) else {
        return;
    };
    all_within(&volumes(&made), &[500.0, 500.0], 1e-6);
    assert_eq!(
        made.iter().map(|piece| piece.faces).collect::<Vec<_>>(),
        [7, 7]
    );
    whole(&made);
}

#[test]
fn three_parallel_planes_give_four_pieces_in_order_along_the_normal() {
    let solid = cube([40.0, 10.0, 10.0]);
    let sorted = [
        plane([5.0, 0.0, 0.0], X),
        plane([10.0, 0.0, 0.0], X),
        plane([25.0, 0.0, 0.0], X),
    ];
    let Some(made) = pieces(&solid, &sorted) else {
        return;
    };
    all_within(&volumes(&made), &[500.0, 500.0, 1500.0, 1500.0], 1e-6);
    whole(&made);
    let shuffled = [sorted[2], sorted[0], sorted[1]];
    let made = pieces(&solid, &shuffled).expect("kernel");
    all_within(&volumes(&made), &[500.0, 500.0, 1500.0, 1500.0], 1e-6);
}

#[test]
fn the_negative_side_of_the_first_plane_comes_first() {
    let Some(made) = pieces(
        &cube([30.0, 10.0, 10.0]),
        &[plane([10.0, 0.0, 0.0], [-1.0, 0.0, 0.0])],
    ) else {
        return;
    };
    all_within(&volumes(&made), &[2000.0, 1000.0], 1e-6);
}

#[test]
fn two_crossing_planes_on_a_box_give_four_quarters() {
    let Some(made) = pieces(
        &cube([20.0, 10.0, 10.0]),
        &[plane([10.0, 0.0, 0.0], X), plane([0.0, 5.0, 0.0], Y)],
    ) else {
        return;
    };
    all_within(&volumes(&made), &[500.0; 4], 1e-6);
    within(volumes(&made).iter().sum::<f64>(), 2000.0, 1e-6);
    whole(&made);
}

#[test]
fn planes_that_meet_at_an_angle_cut_a_box_in_four() {
    let diagonal = [1.0, 1.0, 0.0];
    let Some(made) = pieces(
        &cube([20.0, 20.0, 10.0]),
        &[
            plane([10.0, 10.0, 0.0], X),
            plane([10.0, 10.0, 0.0], diagonal),
        ],
    ) else {
        return;
    };
    assert_eq!(made.len(), 4);
    within(volumes(&made).iter().sum::<f64>(), 4000.0, 1e-6);
    whole(&made);
}

#[test]
fn a_cylinder_cut_across_and_through_its_axis_sums_to_its_volume() {
    let cylinder = json!({ "primitive": "cylinder", "origin": [0.0, 0.0, 0.0], "radius": 10.0, "height": 20.0 })
        .to_string();
    let Some(made) = pieces(
        &cylinder,
        &[plane([0.0, 0.0, 8.0], Z), plane([0.0, 0.0, 0.0], X)],
    ) else {
        return;
    };
    assert_eq!(made.len(), 4);
    whole(&made);
    let total = PI * 100.0 * 20.0;
    within(volumes(&made).iter().sum::<f64>(), total, 1e-4);
    all_within(
        &volumes(&made),
        &[total * 0.2, total * 0.2, total * 0.3, total * 0.3],
        1e-4,
    );
}

#[test]
fn a_sphere_cut_through_its_centre_sums_to_its_volume() {
    let sphere =
        json!({ "primitive": "sphere", "origin": [0.0, 0.0, 0.0], "radius": 10.0 }).to_string();
    let Some(made) = pieces(
        &sphere,
        &[
            plane([0.0, 0.0, 0.0], Z),
            plane([0.0, 0.0, 0.0], [1.0, 1.0, 0.0]),
        ],
    ) else {
        return;
    };
    assert_eq!(made.len(), 4);
    whole(&made);
    let total = 4.0 / 3.0 * PI * 1000.0;
    within(volumes(&made).iter().sum::<f64>(), total, 1e-4);
    all_within(&volumes(&made), &[total / 4.0; 4], 1e-4);
}

#[test]
fn a_plane_outside_the_part_is_refused() {
    let solid = cube([20.0, 10.0, 10.0]);
    let Some(message) = refusal(&solid, &[plane([100.0, 0.0, 0.0], X)]) else {
        return;
    };
    assert_eq!(message, "The plane did not split this solid");
    let message = refusal(
        &solid,
        &[plane([10.0, 0.0, 0.0], X), plane([0.0, 0.0, 100.0], Z)],
    )
    .expect("kernel");
    assert_eq!(message, "The plane did not split this solid");
    let message = refusal(&solid, &[plane([0.1, 0.0, 0.0], X)]).expect("kernel");
    assert_eq!(
        message,
        "The plane is too close to a face. Move it into the part."
    );
    let made = pieces(&solid, &[plane([10.0, 0.0, 0.0], X)]).expect("kernel");
    all_within(&volumes(&made), &[1000.0, 1000.0], 1e-6);
}

#[test]
fn two_planes_closer_than_the_thinnest_piece_are_refused() {
    let Some(message) = refusal(
        &cube([20.0, 10.0, 10.0]),
        &[plane([10.0, 0.0, 0.0], X), plane([10.1, 0.0, 0.0], X)],
    ) else {
        return;
    };
    assert_eq!(
        message,
        "Two planes are too close together. Move them apart."
    );
}

#[test]
fn more_than_twenty_four_pieces_are_refused() {
    const SENTENCE: &str = "A partition makes at most 24 pieces";
    let bar = cube([260.0, 10.0, 10.0]);
    let parallel: Vec<[f64; 6]> = (1..=24)
        .map(|n| plane([f64::from(n) * 10.0, 0.0, 0.0], X))
        .collect();
    let Some(message) = refusal(&bar, &parallel) else {
        return;
    };
    assert_eq!(message, SENTENCE);
    let made = pieces(&bar, &parallel[..23]).expect("kernel");
    assert_eq!(made.len(), 24);
    whole(&made);
    let grid = [
        plane([10.0, 0.0, 0.0], X),
        plane([20.0, 0.0, 0.0], X),
        plane([0.0, 10.0, 0.0], Y),
        plane([0.0, 20.0, 0.0], Y),
        plane([0.0, 0.0, 10.0], Z),
        plane([0.0, 0.0, 20.0], Z),
    ];
    let message = refusal(&cube([30.0, 30.0, 30.0]), &grid).expect("kernel");
    assert_eq!(message, SENTENCE);
}

#[test]
fn a_region_in_two_parts_is_two_pieces() {
    // Two planes through a tube's hole: the slab between them is two bands of wall that do not touch.
    let tube = json!({ "primitive": "tube", "origin": [0.0, 0.0, 0.0], "radius": 10.0, "innerRadius": 6.0, "height": 5.0 })
        .to_string();
    let Some(made) = pieces(&tube, &[plane([-3.0, 0.0, 0.0], X), plane([3.0, 0.0, 0.0], X)]) else {
        return;
    };
    assert_eq!(made.len(), 4, "{made:?}");
    whole(&made);
    within(volumes(&made).iter().sum::<f64>(), PI * (100.0 - 36.0) * 5.0, 1e-4);
}
