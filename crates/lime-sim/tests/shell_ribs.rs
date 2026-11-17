//! Ribs on the shell: a T-section strip against beam theory and against
//! the tetrahedral solver, a clamped ribbed plate against the tetrahedral
//! solver, eccentric against concentric, and the re-solve API.
//!
//! The finest solid references are in `#[ignore]`d tests (minutes in the
//! test profile); their numbers are quoted in the asserts below and the
//! ignored tests check them.

mod shell_common;

use lime_sim::assemble::{Hold, Load, NodeHold};
use lime_sim::mesh::faces_on_plane;
use lime_sim::shell::{
    Rib, RibSection, RibSide, ShellHold, ShellLoad, ShellMesh, ShellModel, ShellOptions,
};
use shell_common::*;

const E: f64 = 2000.0;

/// The vertices of row `j` of an `nx`-wide rectangle mesh, as a chain of
/// edges along x.
fn row_edges(nx: usize, j: usize) -> Vec<(u32, u32)> {
    let base = (nx + 1) * j;
    (0..nx)
        .map(|i| ((base + i) as u32, (base + i + 1) as u32))
        .collect()
}

// The T-section strip: plate b × t, rib w × h on its top face, along the
// middle; a cantilever of length L with a tip load P. ν = 0, so the strip
// is a beam with no anticlastic ambiguity and the solid's clamped face
// blocks no Poisson contraction.
const L: f64 = 100.0;
const B: f64 = 10.0;
const T: f64 = 2.0;
const W: f64 = 2.0;
const H: f64 = 8.0;
const P: f64 = 1.0;

/// The finest solid strip (TET10, 1 × 0.5 × 0.5 mm, 132,057 nodes): tip
/// deflection, from `fine_solid_references`.
const STRIP_SOLID: f64 = 0.536683;

/// Second moment of the T about its own centroid (transformed section, one
/// material).
fn t_section_inertia() -> f64 {
    let (af, aw) = (B * T, W * H);
    let zw = 0.5 * T + 0.5 * H;
    let zbar = aw * zw / (af + aw);
    B * T.powi(3) / 12.0 + af * zbar * zbar + W * H.powi(3) / 12.0 + aw * (zw - zbar).powi(2)
}

fn strip_shell(nx: usize, ny: usize, side: Option<RibSide>) -> f64 {
    let mesh = ShellMesh::rectangle([L, B], [nx, ny], T);
    let holds: Vec<ShellHold> = (0..mesh.vertices.len())
        .filter(|&i| mesh.vertices[i][0].abs() < TOL)
        .map(|i| ShellHold::clamped(i as u32))
        .collect();
    let mut case = Vec::new();
    for (i, v) in mesh.vertices.iter().enumerate() {
        if (v[0] - L).abs() < TOL {
            let share = if v[1].abs() < TOL || (v[1] - B).abs() < TOL {
                0.5
            } else {
                1.0
            };
            case.push(ShellLoad::Force {
                node: i as u32,
                force: [0.0, 0.0, -P * share / ny as f64],
            });
        }
    }
    let mut model =
        ShellModel::new(mesh, material(E, 0.0), &holds, ShellOptions::default()).unwrap();
    if let Some(side) = side {
        model
            .add_rib(Rib {
                edges: row_edges(nx, ny / 2),
                section: RibSection::rectangular(W),
                height: H,
                side,
            })
            .unwrap();
    }
    let r = model.solve(&case).unwrap();
    -r.displacement[model.mesh().nearest_vertex([L, 0.5 * B, 0.0]) as usize][2]
}

/// The same strip in TET10 bricks, clamped over its root face, the tip load
/// spread evenly over its end face.
fn strip_solid(dx: f64, dyz: f64) -> (f64, usize) {
    let div = [
        (L / dx).round() as usize,
        (B / dyz).round() as usize,
        ((T + H) / dyz).round() as usize,
    ];
    let mesh = solid([0.0, 0.0, -0.5 * T], [L, B, T + H], div, |c| {
        c[2] < 0.5 * T || (c[1] > 0.5 * (B - W) && c[1] < 0.5 * (B + W))
    });
    let holds: Vec<NodeHold> = mesh
        .nodes
        .iter()
        .enumerate()
        .filter(|(_, p)| p[0].abs() < TOL)
        .map(|(i, _)| NodeHold {
            node: i,
            hold: Hold::Fixed,
        })
        .collect();
    let end_area = B * T + W * H;
    let loads: Vec<Load> = faces_on_plane(&mesh, 0, L, 1e-6)
        .into_iter()
        .map(|f| Load::Traction {
            nodes: f.nodes,
            traction: [0.0, 0.0, -P / end_area],
        })
        .collect();
    let tip = nearest_node(&mesh, [L, 0.5 * B, 0.0]);
    let nodes = mesh.nodes.len();
    let s = tet_solve(mesh, E, 0.0, holds, loads);
    (-s.displacement[tip][2], nodes)
}

/// The ribbed strip against the transformed-section beam and the solid.
#[test]
fn ribbed_strip_against_beam_theory_and_the_solid() {
    let i = t_section_inertia();
    let g = E / 2.0;
    let euler = P * L.powi(3) / (3.0 * E * i);
    // The web's shear, if the web took all of it.
    let shear = P * L / (5.0 / 6.0 * g * W * H);
    eprintln!(
        "T-section I = {i:.3} mm⁴; Euler–Bernoulli tip {euler:.6}; with the web taking all the shear {:.6}",
        euler + shear
    );
    let mut shell = Vec::new();
    for (nx, ny) in [(10, 2), (20, 4), (40, 8), (80, 16)] {
        let w = strip_shell(nx, ny, Some(RibSide::Positive));
        row(
            "ribbed strip vs EB beam",
            &format!("shell {nx}×{ny}×2"),
            w,
            euler,
        );
        row(
            "ribbed strip vs solid",
            &format!("shell {nx}×{ny}×2"),
            w,
            STRIP_SOLID,
        );
        shell.push(w);
    }
    let (solid, nodes) = strip_solid(1.0, 1.0);
    row(
        "ribbed strip vs solid",
        &format!("TET10 1 × 1 mm, {nodes} nodes"),
        solid,
        STRIP_SOLID,
    );
    let w = *shell.last().unwrap();
    // Plane sections are a strict upper bound on stiffness.
    assert!(shell.iter().all(|w| *w > euler), "{shell:?} vs {euler}");
    assert!(w < euler + shear, "{shell:?}");
    assert!((w - STRIP_SOLID).abs() < 0.002 * STRIP_SOLID, "{shell:?}");
    assert!((solid - STRIP_SOLID).abs() < 1e-3 * STRIP_SOLID, "{solid}");
    for k in 1..shell.len() {
        assert!(shell[k] < shell[k - 1], "converges from above: {shell:?}");
    }
}

/// A concentric rib (no offset) adds only its own bending; standing on the
/// face, it works with the wall as a T and is several times stiffer.
#[test]
fn the_offset_is_most_of_a_ribs_stiffness() {
    let bare = strip_shell(40, 8, None);
    let centred = strip_shell(40, 8, Some(RibSide::Centered));
    let standing = strip_shell(40, 8, Some(RibSide::Positive));
    let below = strip_shell(40, 8, Some(RibSide::Negative));
    eprintln!(
        "| strip tip deflection | bare {bare:.5} | concentric {centred:.5} | eccentric {standing:.5} | other face {below:.5} |"
    );
    // Beam theory: bare I = 6.67, concentric 6.67 + 85.3, T-section 314.
    let concentric_i = B * T.powi(3) / 12.0 + W * H.powi(3) / 12.0;
    let bare_i = B * T.powi(3) / 12.0;
    let ratio = centred / standing;
    let want = t_section_inertia() / concentric_i;
    eprintln!(
        "| concentric / eccentric | {ratio:.3} | beam theory {want:.3} | bare / concentric {:.3} vs {:.3} |",
        bare / centred,
        concentric_i / bare_i
    );
    assert!(ratio > 3.0, "{ratio}");
    assert!((ratio - want).abs() < 0.05 * want, "{ratio} vs {want}");
    // Which face it stands on does not matter to a flat strip.
    assert!((standing - below).abs() < 1e-9 * standing);
}

const A: f64 = 60.0;
const PLATE_T: f64 = 2.0;
const RIB: (f64, f64) = (2.0, 6.0);
const NU: f64 = 0.3;
const Q: f64 = 0.01;

/// The finest solid clamped plate (TET10 1 × 1 × 0.5 mm, 131,769 and
/// 146,289 nodes), centre deflection, bare and ribbed, from
/// `fine_solid_references`.
const PLATE_SOLID: f64 = 0.113763;
const RIBBED_SOLID: f64 = 0.0303816;

fn plate_shell(n: usize, ribbed: bool) -> (f64, f64) {
    let mesh = ShellMesh::rectangle([A, A], [n, n], PLATE_T);
    let holds = rectangle_holds(&mesh, A, A, Edge::Clamped);
    let mut model =
        ShellModel::new(mesh, material(E, NU), &holds, ShellOptions::default()).unwrap();
    if ribbed {
        model
            .add_rib(Rib {
                edges: row_edges(n, n / 2),
                section: RibSection::rectangular(RIB.0),
                height: RIB.1,
                side: RibSide::Positive,
            })
            .unwrap();
    }
    // Pressure on the bare face pushes toward the rib (+z).
    let case = pressure(model.mesh(), -Q);
    let r = model.solve(&case).unwrap();
    let wc = centre_w(&model, &r.displacement, [0.5 * A, 0.5 * A, 0.0]);
    (
        wc,
        r.rib_energy.first().copied().unwrap_or(0.0) / r.strain_energy,
    )
}

/// A clamped square plate with one rib across its middle, pressed from the
/// side away from the rib, against the same ribbed plate in TET10 bricks.
/// The bare plate's gap is the solid's through-thickness shear, which a
/// Kirchhoff shell leaves out (a/t = 30).
#[test]
fn clamped_ribbed_plate_against_the_solid() {
    let mut rows = Vec::new();
    for n in [12, 24, 48, 96] {
        let (bare, _) = plate_shell(n, false);
        let (ribbed, share) = plate_shell(n, true);
        row(
            "clamped plate, shell vs solid",
            &format!("shell {n}×{n}×2"),
            bare,
            PLATE_SOLID,
        );
        row(
            "clamped plate + rib, shell vs solid",
            &format!("shell {n}×{n}×2, rib energy {:.0} %", 100.0 * share),
            ribbed,
            RIBBED_SOLID,
        );
        rows.push((bare, ribbed));
    }
    let (solid, nodes) = ribbed_plate_solid(A, PLATE_T, Some(RIB), E, NU, Q, [2.0, 1.0, 1.0]);
    row(
        "clamped plate + rib, coarse solid vs fine solid",
        &format!("TET10 2 × 1 × 1 mm, {nodes} nodes"),
        solid,
        RIBBED_SOLID,
    );
    let (bare, ribbed) = rows[rows.len() - 1];
    eprintln!(
        "stiffening: shell {:.3}×, solid {:.3}×",
        bare / ribbed,
        PLATE_SOLID / RIBBED_SOLID
    );
    assert!(
        (ribbed - RIBBED_SOLID).abs() < 0.03 * RIBBED_SOLID,
        "{rows:?}"
    );
    assert!((bare - PLATE_SOLID).abs() < 0.03 * PLATE_SOLID, "{rows:?}");
    assert!(
        (solid - RIBBED_SOLID).abs() < 0.01 * RIBBED_SOLID,
        "{solid}"
    );
    // Settling: each halving moves the ribbed answer less than the last.
    let steps: Vec<f64> = rows.windows(2).map(|w| (w[1].1 - w[0].1).abs()).collect();
    assert!(steps[2] < 0.6 * steps[1], "{rows:?}");
}

/// The solid references the tests above quote, at their finest grids.
/// Minutes in the test profile: run with `--ignored`.
#[test]
#[ignore]
fn fine_solid_references() {
    for (dx, dyz) in [(2.0, 1.0), (1.0, 1.0), (1.0, 0.5)] {
        let (w, nodes) = strip_solid(dx, dyz);
        row(
            "ribbed strip solid",
            &format!("TET10 {dx} × {dyz} mm, {nodes} nodes"),
            w,
            STRIP_SOLID,
        );
    }
    for step in [[2.0, 1.0, 1.0], [1.0, 1.0, 1.0], [1.0, 1.0, 0.5]] {
        for rib in [None, Some(RIB)] {
            let (w, nodes) = ribbed_plate_solid(A, PLATE_T, rib, E, NU, Q, step);
            let reference = if rib.is_some() {
                RIBBED_SOLID
            } else {
                PLATE_SOLID
            };
            row(
                &format!(
                    "clamped plate solid{}",
                    if rib.is_some() { " + rib" } else { "" }
                ),
                &format!("TET10 {step:?} mm, {nodes} nodes"),
                w,
                reference,
            );
            if step == [1.0, 1.0, 0.5] {
                assert!((w - reference).abs() < 2e-3 * reference, "{w}");
            }
        }
    }
    let (w, _) = strip_solid(1.0, 0.5);
    assert!((w - STRIP_SOLID).abs() < 1e-5, "{w}");
}

#[test]
fn ribs_come_and_go_without_rebuilding_the_shell() {
    let (a, t, n) = (60.0, 2.0, 12);
    let make = || {
        let mesh = ShellMesh::rectangle([a, a], [n, n], t);
        let holds = rectangle_holds(&mesh, a, a, Edge::Clamped);
        ShellModel::new(mesh, material(E, 0.3), &holds, ShellOptions::default()).unwrap()
    };
    let rib = |j: usize| Rib {
        edges: row_edges(n, j),
        section: RibSection::rectangular(2.0),
        height: 6.0,
        side: RibSide::Positive,
    };
    let mut model = make();
    let case = pressure(model.mesh(), 0.01);
    let centre = model.mesh().nearest_vertex([30.0, 30.0, 0.0]) as usize;
    let bare = model.solve(&case).unwrap();
    assert_eq!(model.factorisations(), 1);
    let shell_dofs = model.free_dofs();

    let first = model.add_rib(rib(6)).unwrap();
    model.add_rib(rib(3)).unwrap();
    let two = model.solve(&case).unwrap();
    assert_eq!(model.factorisations(), 2);
    // Each rib brings one web rotation per inner vertex; its two ends are
    // on the clamped edge, where the web is held too.
    assert_eq!(model.free_dofs(), shell_dofs + 2 * (n - 1));
    assert!(two.displacement[centre][2].abs() < 0.5 * bare.displacement[centre][2].abs());
    assert_eq!(two.rib_energy.len(), 2);
    assert!(two.rib_energy.iter().all(|e| *e > 0.0));
    assert!((two.compliance - 2.0 * two.strain_energy).abs() < 1e-9 * two.compliance);

    // The same two ribs from a fresh model.
    let mut fresh = make();
    fresh.set_ribs(vec![rib(6), rib(3)]).unwrap();
    let again = fresh.solve(&case).unwrap();
    let diff = (again.displacement[centre][2] - two.displacement[centre][2]).abs();
    assert!(diff < 1e-12 * two.displacement[centre][2].abs(), "{diff}");

    // Back to bare.
    model.remove_rib(first).unwrap();
    model.remove_rib(0).unwrap();
    assert_eq!(model.free_dofs(), shell_dofs);
    let back = model.solve(&case).unwrap();
    let diff = (back.displacement[centre][2] - bare.displacement[centre][2]).abs();
    assert!(diff < 1e-12 * bare.displacement[centre][2].abs(), "{diff}");

    // Three cases on one factor, linear in the load.
    let before = model.factorisations();
    let twice = pressure(model.mesh(), 0.02);
    let point = vec![ShellLoad::Force {
        node: centre as u32,
        force: [0.0, 0.0, -5.0],
    }];
    let all = model.solve_cases(&[case.clone(), twice, point]).unwrap();
    assert_eq!(model.factorisations(), before);
    let r = all[1].displacement[centre][2] / all[0].displacement[centre][2];
    assert!((r - 2.0).abs() < 1e-12, "{r}");

    // A rib off the mesh's edges is refused (vertex 15 is two cells from
    // vertex 0), and so is an unheld shell.
    let bad = Rib {
        edges: vec![(0, 15)],
        section: RibSection::rectangular(1.0),
        height: 1.0,
        side: RibSide::Positive,
    };
    assert!(model.add_rib(bad).is_err());
    assert!(model.ribs().is_empty());
    let mesh = ShellMesh::rectangle([a, a], [4, 4], t);
    let mut free = ShellModel::new(mesh, material(E, 0.3), &[], ShellOptions::default()).unwrap();
    let case = pressure(free.mesh(), 0.01);
    let err = free.solve(&case).unwrap_err();
    assert!(err.message.contains("not held"), "{}", err.message);
}
