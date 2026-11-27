//! The exact triangulation that meshes a flat face with many holes (src/flat_mesh.rs), fed the inputs that broke
//! Delabella. `tests/fixtures/flat_mesh/fault_*.txt` are point sets on which Open CASCADE 7.9.2's vendored delabella.cpp
//! faulted (an access violation or heap corruption) in a standalone harness, and the thin rectangle below is the smallest
//! input that crashed it. None of this needs Open CASCADE.

use lime_model_occt::{flat_face_mesh, flat_triangulate};
use std::collections::HashSet;

fn area(points: &[[f64; 2]], triangles: &[[u32; 3]]) -> f64 {
    triangles
        .iter()
        .map(|t| {
            let [a, b, c] = t.map(|i| points[i as usize]);
            0.5 * ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]))
        })
        .sum()
}

/// The closed loop through `from..from + count` as segments.
fn ring(from: u32, count: u32) -> Vec<[u32; 2]> {
    (0..count).map(|k| [from + k, from + (k + 1) % count]).collect()
}

/// A polygon's area, positive when it runs counterclockwise.
fn polygon_area(points: &[[f64; 2]]) -> f64 {
    (0..points.len())
        .map(|k| {
            let (a, b) = (points[k], points[(k + 1) % points.len()]);
            0.5 * (a[0] * b[1] - b[0] * a[1])
        })
        .sum()
}

fn near(a: f64, b: f64, what: &str) {
    assert!((a - b).abs() <= 1e-9 * b.abs().max(1.0), "{what}: {a} against {b}");
}

const THIN: [[f64; 2]; 10] = [
    [0.0, 0.0],
    [7.325, 0.0],
    [14.65, 0.0],
    [21.975, 0.0],
    [29.3, 0.0],
    [29.3, 0.068],
    [21.975, 0.068],
    [14.65, 0.068],
    [7.325, 0.068],
    [0.0, 0.068],
];

#[test]
fn the_thin_rectangle_that_crashed_delabella_is_triangulated_and_meshed() {
    let all = flat_triangulate(&THIN).expect("the thin rectangle");
    // Ten points, all on the hull: 2n - 2 - h = 8 triangles, covering the rectangle.
    assert_eq!(all.len(), 8);
    near(area(&THIN, &all), 29.3 * 0.068, "the rectangle's area");
    let face = flat_face_mesh(&THIN, &ring(0, 10), &[]).expect("the thin face");
    assert_eq!(face.len(), 8);
    near(area(&THIN, &face), 29.3 * 0.068, "the face's area");
}

#[test]
fn the_points_that_crashed_delabella_never_panic_and_their_distinct_points_triangulate() {
    let folder = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/flat_mesh");
    let mut files: Vec<_> = std::fs::read_dir(&folder).expect("fixtures").map(|entry| entry.expect("entry").path()).collect();
    files.sort();
    assert_eq!(files.len(), 6, "{files:?}");
    for file in files {
        let text = std::fs::read_to_string(&file).expect("read");
        let points: Vec<[f64; 2]> = text
            .lines()
            .filter_map(|line| {
                let mut parts = line.split_whitespace().map(|part| part.parse::<f64>().expect("a number"));
                Some([parts.next()?, parts.next()?])
            })
            .collect();
        // As Delabella got them, repeats and all: an answer or a refusal, never a panic or a crash.
        let raw = flat_triangulate(&points);
        let mut seen = HashSet::new();
        let distinct: Vec<[f64; 2]> = points.iter().copied().filter(|p| seen.insert((p[0].to_bits(), p[1].to_bits()))).collect();
        if distinct.len() != points.len() {
            assert!(raw.is_err(), "{}: repeated points are refused", file.display());
        }
        let triangles = flat_triangulate(&distinct).unwrap_or_else(|err| panic!("{}: {err}", file.display()));
        assert!(!triangles.is_empty(), "{}", file.display());
        assert_eq!(flat_triangulate(&distinct).expect("again"), triangles, "{}: the same answer again", file.display());
    }
}

#[test]
fn cocircular_points_and_a_regular_grid_are_triangulated() {
    // Twelve integer points exactly on one circle of radius 5: every circle test among them is a tie.
    let circle: Vec<[f64; 2]> = [[5, 0], [4, 3], [3, 4], [0, 5], [-3, 4], [-4, 3], [-5, 0], [-4, -3], [-3, -4], [0, -5], [3, -4], [4, -3]]
        .iter()
        .map(|&[x, y]| [f64::from(x), f64::from(y)])
        .collect();
    let all = flat_triangulate(&circle).expect("the circle");
    assert_eq!(all.len(), 10);
    near(area(&circle, &all), polygon_area(&circle), "the circle's polygon");
    let face = flat_face_mesh(&circle, &ring(0, 12), &[]).expect("the circle as a face");
    near(area(&circle, &face), polygon_area(&circle), "the circle face");

    // A 21 x 21 grid: every square's four corners are cocircular.
    let grid: Vec<[f64; 2]> = (0..21).flat_map(|i| (0..21).map(move |j| [f64::from(i) * 0.5, f64::from(j) * 0.5])).collect();
    let triangles = flat_triangulate(&grid).expect("the grid");
    // 441 points with 80 on the hull: 2 * 441 - 2 - 80 = 800 triangles over a 10 x 10 square.
    assert_eq!(triangles.len(), 800);
    near(area(&grid, &triangles), 100.0, "the grid's area");
}

#[test]
fn a_plate_with_four_hundred_holes_is_meshed_inside_its_wires() {
    // As Delabella's harness built it: a 100 mm square cut 8 ways a side, with 20 x 20 octagons of 1 mm radius.
    let mut points: Vec<[f64; 2]> = Vec::new();
    let mut frontier = Vec::new();
    for k in 0..32 {
        let t = f64::from(k % 8) / 8.0 * 100.0;
        points.push(match k / 8 {
            0 => [t, 0.0],
            1 => [100.0, t],
            2 => [100.0 - t, 100.0],
            _ => [0.0, 100.0 - t],
        });
    }
    frontier.extend(ring(0, 32));
    let mut holes = 0.0;
    for a in 0..20 {
        for b in 0..20 {
            let from = points.len() as u32;
            let octagon: Vec<[f64; 2]> = (0..8)
                .map(|k| {
                    // Clockwise, as a hole runs.
                    let angle = -f64::from(k) * std::f64::consts::PI / 4.0;
                    [5.0 + f64::from(a) * 4.5 + angle.cos(), 5.0 + f64::from(b) * 4.5 + angle.sin()]
                })
                .collect();
            holes += polygon_area(&octagon);
            points.extend(octagon);
            frontier.extend(ring(from, 8));
        }
    }
    let triangles = flat_face_mesh(&points, &frontier, &[]).expect("the plate");
    near(area(&points, &triangles), 100.0 * 100.0 + holes, "the plate less its holes");
    // n + 2h - 2 triangles for a polygon of n corners with h holes and no point inside.
    assert_eq!(triangles.len(), points.len() + 2 * 400 - 2);
    assert_eq!(flat_face_mesh(&points, &frontier, &[]).expect("again"), triangles, "the same mesh again");
}

#[test]
fn what_is_not_a_face_is_refused_not_meshed() {
    let square = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]];
    // Two segments that cross.
    assert!(flat_face_mesh(&square, &[[0, 2], [1, 3]], &[]).is_err());
    // A boundary that does not close: the face would be on both sides of the open end.
    assert!(flat_face_mesh(&square, &[[0, 1], [1, 2], [2, 3]], &[]).is_err());
    // A point on a boundary segment splits it.
    let split = [[0.0, 0.0], [2.0, 0.0], [2.0, 2.0], [0.0, 2.0], [1.0, 0.0]];
    assert!(flat_face_mesh(&split, &ring(0, 4), &[]).is_err());
    // A segment to a point that is not there, a segment of one point, a repeated point, a point that is not a number.
    assert!(flat_face_mesh(&square, &[[0, 1], [1, 2], [2, 3], [3, 9]], &[]).is_err());
    assert!(flat_face_mesh(&square, &[[0, 0]], &[]).is_err());
    assert!(flat_face_mesh(&[[0.0, 0.0], [1.0, 0.0], [1.0, 0.0], [0.0, 1.0]], &ring(0, 4), &[]).is_err());
    assert!(flat_triangulate(&[[0.0, 0.0], [1.0, f64::NAN], [0.0, 1.0]]).is_err());
    // Points all on one line, and too few.
    assert!(flat_triangulate(&[[0.0, 0.0], [1.0, 0.0], [2.0, 0.0], [3.0, 0.0]]).is_err());
    assert!(flat_triangulate(&[[0.0, 0.0], [1.0, 0.0]]).is_err());
    // An inner segment (a seam inside the face) has the face on both sides.
    let with_seam = flat_face_mesh(&square, &ring(0, 4), &[[0, 2]]).expect("a square with a seam");
    near(area(&square, &with_seam), 1.0, "the square");
}
