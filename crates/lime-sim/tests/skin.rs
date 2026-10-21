//! Walls and skins follow the part's real surface, not its bounding box.
//!
//! Each case compares the smeared wall share with the exact ratio of the band's
//! volume to the part's: a box meshed far coarser than its walls, the same box
//! turned on the bed, and a hollow tube whose bore carries walls too.

use lime_sim::mesh::{grid, mapped_grid, Mesh};
use lime_sim::recipe::{integrate_volumes, volume_fractions, Pattern, Recipe};
use lime_sim::ElementKind;

const CORE: f64 = 0.2;

fn recipe() -> Recipe {
    Recipe {
        walls: 2,
        line_width_mm: 0.4,
        layer_height_mm: 0.2,
        skin_layers: 3,
        infill: CORE,
        pattern: Pattern::Grid,
        pattern_factor: 1.0,
        pattern_measured: true,
    }
}

/// The wall share the smear gave, from the printed and solid volumes: printed / solid = W + (1 − W) · core.
fn wall_share(mesh: &Mesh) -> f64 {
    let vf = volume_fractions(mesh, &recipe(), [0.0, 0.0, 1.0]);
    let (solid, printed) = integrate_volumes(mesh, &vf);
    (printed / solid - CORE) / (1.0 - CORE)
}

/// Side walls 2 × 0.4 = 0.8 mm, roofs and floors 3 × 0.2 = 0.6 mm.
const WALL: f64 = 0.8;
const SKIN: f64 = 0.6;

fn exact_box_share(size: f64) -> f64 {
    let inner = (size - 2.0 * WALL) * (size - 2.0 * WALL) * (size - 2.0 * SKIN);
    1.0 - inner / (size * size * size)
}

#[test]
fn a_box_meshed_four_times_coarser_than_its_walls_keeps_them() {
    // 20 mm cube in 6 bricks a side: a 3.3 mm edge against a 0.8 mm wall.
    let mesh = grid(
        [0.0, 0.0, 0.0],
        [20.0, 20.0, 20.0],
        [6, 6, 6],
        ElementKind::Tet10,
    )
    .unwrap();
    let got = wall_share(&mesh);
    let want = exact_box_share(20.0);
    assert!(
        (got - want).abs() / want < 0.10,
        "wall share {got:.4}, exact {want:.4}"
    );
}

#[test]
fn a_box_turned_on_the_bed_has_the_same_walls() {
    let flat = grid(
        [-10.0, -10.0, 0.0],
        [20.0, 20.0, 20.0],
        [6, 6, 6],
        ElementKind::Tet10,
    )
    .unwrap();
    let mut turned = flat.clone();
    let (s, c) = 30.0_f64.to_radians().sin_cos();
    for p in &mut turned.nodes {
        *p = [c * p[0] - s * p[1], s * p[0] + c * p[1], p[2]];
    }
    let (a, b) = (wall_share(&flat), wall_share(&turned));
    // A bounding box of the turned cube is 27 mm wide: it would find almost none of the side walls.
    assert!((a - b).abs() / a < 0.05, "flat {a:.4}, turned 30° {b:.4}");
}

#[test]
fn a_tube_has_walls_in_its_bore_as_well_as_outside() {
    // Inner radius 8, outer 12, height 20. Two bricks through the wall, 48 round, 10 up.
    let (ri, ro, height) = (8.0, 12.0, 20.0);
    let (nr, nt, nz) = (2usize, 48usize, 10usize);
    let mut mesh = mapped_grid(
        [nr, nt, nz],
        ElementKind::Tet4,
        |i, j, k| {
            let r = ri + (ro - ri) * i as f64 / nr as f64;
            let t = std::f64::consts::TAU * j as f64 / nt as f64;
            [r * t.cos(), r * t.sin(), height * k as f64 / nz as f64]
        },
        lime_sim::mesh::cylindrical_mid,
    )
    .unwrap();
    // Close the seam: the last ring of nodes is the first one, so the cut is not a surface.
    let id = |i: usize, j: usize, k: usize| i + (nr + 1) * (j + (nt + 1) * k);
    for cell in &mut mesh.elements {
        for n in &mut cell.nodes {
            let i = *n % (nr + 1);
            let j = (*n / (nr + 1)) % (nt + 1);
            let k = *n / ((nr + 1) * (nt + 1));
            if j == nt {
                *n = id(i, 0, k);
            }
        }
    }
    let core_annulus = (ro - WALL).powi(2) - (ri + WALL).powi(2);
    let annulus = ro * ro - ri * ri;
    let want = 1.0 - core_annulus * (height - 2.0 * SKIN) / (annulus * height);
    let got = wall_share(&mesh);
    assert!(
        (got - want).abs() / want < 0.10,
        "wall share {got:.4}, exact {want:.4}"
    );
}

#[test]
fn a_solid_part_is_all_polymer() {
    let mesh = grid(
        [0.0, 0.0, 0.0],
        [10.0, 10.0, 10.0],
        [2, 2, 2],
        ElementKind::Tet10,
    )
    .unwrap();
    let mut full = recipe();
    full.infill = 1.0;
    assert!(volume_fractions(&mesh, &full, [0.0, 0.0, 1.0])
        .iter()
        .all(|&f| f == 1.0));
}
