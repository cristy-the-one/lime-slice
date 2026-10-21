//! The sliced representation solves the beads a slice lays down. Where the
//! smear is right, a solid part with an isotropic card, the two agree.

use lime_sim::material::LinearOrthotropic;
use lime_sim::mesh::{faces_on_plane, grid};
use lime_sim::recipe::Recipe;
use lime_sim::slice_field::{Header, LayerRow, Segment, SliceField, FORMAT, ROLES};
use lime_sim::sliced::{SlicedGrid, PHI_MIN};
use lime_sim::study::{Request, Step};
use lime_sim::{solve_request, ElementKind, Hold, Load, Mesh, NodeHold, Solution};

const LAYER: f32 = 0.2;
const WIDTH: f32 = 0.45;
const P: f64 = 2.0;

/// `layers` layers of beads along X, one width apart, `w` × `d` mm: a solid
/// block, as a 100% infill slices with every bead aligned.
fn block(w: f64, d: f64, layers: u32) -> SliceField {
    let mut segments = Vec::new();
    let mut rows = Vec::new();
    for layer in 0..layers {
        let start = segments.len() as u32;
        let z = (layer + 1) as f32 * LAYER;
        let lines = (d / f64::from(WIDTH)).round() as usize;
        for n in 0..lines {
            let y = (n as f32 + 0.5) * WIDTH;
            segments.push(Segment {
                layer,
                role: 7,
                from: [0.0, y, z],
                to: [w as f32, y, z],
                width_mm: WIDTH,
                bead_height_mm: LAYER,
                flow: 1.0,
            });
        }
        rows.push(LayerRow {
            index: layer,
            z_mm: f64::from(z),
            height_mm: f64::from(LAYER),
            bead_start: start,
            bead_count: segments.len() as u32 - start,
        });
    }
    SliceField {
        header: Header {
            format: FORMAT.into(),
            slice_hash: String::new(),
            frame: [
                [1.0, 0.0, 0.0, 0.0],
                [0.0, 1.0, 0.0, 0.0],
                [0.0, 0.0, 1.0, 0.0],
                [0.0, 0.0, 0.0, 1.0],
            ],
            layer_normal: [0.0, 0.0, 1.0],
            layers: rows,
            roles: ROLES.iter().map(|r| r.to_string()).collect(),
            segment_count: segments.len() as u32,
        },
        segments,
    }
}

/// The root face held, the tip face pulled down by `P` newtons in all.
fn request(
    mesh: Mesh,
    representation: &str,
    cells: Vec<lime_sim::sliced::CellMaterial>,
    h: f64,
) -> Request {
    let lo = mesh
        .nodes
        .iter()
        .map(|p| p[0])
        .fold(f64::INFINITY, f64::min);
    let hi = mesh
        .nodes
        .iter()
        .map(|p| p[0])
        .fold(f64::NEG_INFINITY, f64::max);
    let holds = mesh
        .nodes
        .iter()
        .enumerate()
        .filter(|(_, p)| (p[0] - lo).abs() < 1e-6)
        .map(|(node, _)| NodeHold {
            node,
            hold: Hold::Fixed,
        })
        .collect();
    let tip = faces_on_plane(&mesh, 0, hi, 1e-6);
    let area: f64 = tip.iter().map(|f| f.area).sum();
    let loads = tip
        .into_iter()
        .map(|face| Load::Traction {
            nodes: face.nodes,
            traction: [0.0, 0.0, -P / area],
        })
        .collect();
    Request {
        mesh,
        material: LinearOrthotropic::isotropic(2000.0, 0.35, 1.24),
        recipe: Recipe::solid(),
        build_axis: [0.0, 0.0, 1.0],
        holds,
        loads,
        steps: vec![Step {
            factor: 1.0,
            max_iter: 1,
            tol: 1e-10,
        }],
        linear: true,
        gravity: None,
        h_mm: h,
        allow_linear_tets: false,
        analysis: "static".into(),
        temperature_c: None,
        fibre_axis: None,
        solver: "faer-ldlt".into(),
        representation: representation.into(),
        cells,
        post_steps: Vec::new(),
        provisional: false,
        cancel: None,
        on_progress: None,
    }
}

fn solve(req: &Request) -> Solution {
    solve_request(req).unwrap_or_else(|err| panic!("{}", err.message))
}

fn sliced(field: &SliceField, h: f64) -> Solution {
    let grid = SlicedGrid::rasterize(field, h).unwrap();
    let mesh = grid.mesh(PHI_MIN).unwrap();
    solve(&request(mesh.mesh, "sliced", mesh.cells, h))
}

fn smeared(size: [f64; 3], div: [usize; 3], h: f64) -> Solution {
    let mesh = grid([0.0, 0.0, 0.0], size, div, ElementKind::Tet10).unwrap();
    solve(&request(mesh, "smear", Vec::new(), h))
}

/// Cells that fit the block whole: the sliced mesh is the smeared one, and
/// so is the answer.
#[test]
fn a_block_on_whole_cells_solves_as_its_smear() {
    // 18 × 4.5 × 4 mm. 0.9 mm cells are four 0.2 mm layers, 0.8 mm tall.
    let field = block(18.0, 4.5, 20);
    let a = sliced(&field, 0.9);
    let b = smeared([18.0, 4.5, 4.0], [20, 5, 5], 0.9);
    let rel = (a.max_displacement_mm - b.max_displacement_mm).abs() / b.max_displacement_mm;
    assert!(
        rel < 1e-5,
        "sliced {} smeared {}",
        a.max_displacement_mm,
        b.max_displacement_mm
    );
    assert!((a.mass_g - b.mass_g).abs() < 1e-5 * b.mass_g);
    assert!(
        a.notes
            .iter()
            .any(|n| n == "Solved as sliced, on cells of 0.9 mm and whole layers."),
        "{:?}",
        a.notes
    );
}

/// The sliced plan's 9.2: cells that don't fit leave a part-filled column
/// along a side. The tip still lands within 3% of the smear at that size.
#[test]
fn a_block_on_cells_that_dont_fit_stays_within_three_percent() {
    let field = block(18.0, 4.5, 20);
    let a = sliced(&field, 1.0);
    let b = smeared([18.0, 4.5, 4.0], [18, 5, 4], 1.0);
    let rel = (a.max_displacement_mm - b.max_displacement_mm).abs() / b.max_displacement_mm;
    assert!(
        rel < 0.03,
        "sliced {} smeared {} ({:.2}%)",
        a.max_displacement_mm,
        b.max_displacement_mm,
        rel * 100.0
    );
}

#[test]
fn a_sliced_request_needs_a_cell_per_element() {
    let field = block(6.0, 2.7, 6);
    let grid = SlicedGrid::rasterize(&field, 0.9).unwrap();
    let mut mesh = grid.mesh(PHI_MIN).unwrap();
    mesh.cells.pop();
    let n = mesh.mesh.elements.len();
    let err = solve_request(&request(mesh.mesh, "sliced", mesh.cells, 0.9)).unwrap_err();
    assert_eq!(
        err.message,
        format!(
            "A sliced study needs one cell per element: {} cells for {n} elements.",
            n - 1
        )
    );
}
