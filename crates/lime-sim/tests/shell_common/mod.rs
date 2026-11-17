//! Meshes, holds and printing shared by the shell tests.

#![allow(dead_code)]

use lime_sim::assemble::{Hold, Load, NodeHold};
use lime_sim::element::ElementKind;
use lime_sim::material::LinearOrthotropic;
use lime_sim::mesh::{faces_on_plane, grid, Cell, Mesh};
use lime_sim::recipe::Recipe;
use lime_sim::shell::{
    IsotropicShell, LoadCase, ShellHold, ShellLoad, ShellMesh, ShellModel, ShellOptions,
};
use lime_sim::solve_request;
use lime_sim::study::{Request, Step};

/// A structured TET10 brick grid with the bricks whose centre fails `keep`
/// taken out, and unused nodes dropped.
pub fn solid(
    origin: [f64; 3],
    size: [f64; 3],
    div: [usize; 3],
    keep: impl Fn([f64; 3]) -> bool,
) -> Mesh {
    let full = grid(origin, size, div, ElementKind::Tet10).unwrap();
    let [nx, ny, _] = div;
    let step = [0, 1, 2].map(|k| size[k] / div[k] as f64);
    let mut used = vec![usize::MAX; full.nodes.len()];
    let mut nodes = Vec::new();
    let mut elements = Vec::new();
    for (e, cell) in full.elements.iter().enumerate() {
        let h = e / 6;
        let (i, j, k) = (h % nx, (h / nx) % ny, h / (nx * ny));
        let centre = [
            origin[0] + (i as f64 + 0.5) * step[0],
            origin[1] + (j as f64 + 0.5) * step[1],
            origin[2] + (k as f64 + 0.5) * step[2],
        ];
        if !keep(centre) {
            continue;
        }
        let mut cn = Vec::with_capacity(cell.nodes.len());
        for &n in &cell.nodes {
            if used[n] == usize::MAX {
                used[n] = nodes.len();
                nodes.push(full.nodes[n]);
            }
            cn.push(used[n]);
        }
        elements.push(Cell { nodes: cn });
    }
    Mesh {
        nodes,
        elements,
        kind: ElementKind::Tet10,
    }
}

/// A linear static TET10 solve through the existing study path.
pub fn tet_solve(
    mesh: Mesh,
    e: f64,
    nu: f64,
    holds: Vec<NodeHold>,
    loads: Vec<Load>,
) -> lime_sim::Solution {
    solve_request(&Request {
        mesh,
        material: LinearOrthotropic::isotropic(e, nu, 1.2),
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
        h_mm: 1.0,
        allow_linear_tets: false,
        analysis: "static".into(),
        temperature_c: None,
        fibre_axis: None,
        solver: "faer-ldlt".into(),
        representation: "smear".into(),
        cells: Vec::new(),
        beads: None,
        post_steps: Vec::new(),
        provisional: false,
        cancel: None,
        on_progress: None,
    })
    .unwrap_or_else(|err| panic!("{}", err.message))
}

pub fn nearest_node(mesh: &Mesh, p: [f64; 3]) -> usize {
    let mut best = (f64::INFINITY, 0);
    for (i, q) in mesh.nodes.iter().enumerate() {
        let d = (0..3).map(|k| (q[k] - p[k]).powi(2)).sum::<f64>();
        if d < best.0 {
            best = (d, i);
        }
    }
    best.1
}

/// A clamped `a × a` plate of thickness `t`, optionally with a `w × h` rib
/// along y = a/2 on its top face, pressed up with `q` on its bottom face, in
/// TET10 bricks of `step` = [along the rib, across it, through the
/// height]. Returns the centre's mid-plane deflection and the node count.
#[allow(clippy::too_many_arguments)]
pub fn ribbed_plate_solid(
    a: f64,
    t: f64,
    rib: Option<(f64, f64)>,
    e: f64,
    nu: f64,
    q: f64,
    step: [f64; 3],
) -> (f64, usize) {
    let h = rib.map_or(0.0, |r| r.1);
    let w = rib.map_or(0.0, |r| r.0);
    let div = [
        (a / step[0]).round() as usize,
        (a / step[1]).round() as usize,
        ((t + h) / step[2]).round() as usize,
    ];
    let mesh = solid([0.0, 0.0, -0.5 * t], [a, a, t + h], div, |c| {
        c[2] < 0.5 * t || (rib.is_some() && (c[1] - 0.5 * a).abs() < 0.5 * w)
    });
    let holds: Vec<NodeHold> = mesh
        .nodes
        .iter()
        .enumerate()
        .filter(|(_, p)| {
            p[0].abs() < TOL || (p[0] - a).abs() < TOL || p[1].abs() < TOL || (p[1] - a).abs() < TOL
        })
        .map(|(i, _)| NodeHold {
            node: i,
            hold: Hold::Fixed,
        })
        .collect();
    let loads: Vec<Load> = faces_on_plane(&mesh, 2, -0.5 * t, 1e-6)
        .into_iter()
        .map(|f| Load::Traction {
            nodes: f.nodes,
            traction: [0.0, 0.0, q],
        })
        .collect();
    let centre = nearest_node(&mesh, [0.5 * a, 0.5 * a, 0.0]);
    let nodes = mesh.nodes.len();
    let s = tet_solve(mesh, e, nu, holds, loads);
    (s.displacement[centre][2], nodes)
}

pub const TOL: f64 = 1e-9;

pub fn material(e: f64, nu: f64) -> IsotropicShell {
    IsotropicShell::new(e, nu).unwrap()
}

pub fn every_triangle(mesh: &ShellMesh) -> Vec<u32> {
    (0..mesh.triangles.len() as u32).collect()
}

pub fn pressure(mesh: &ShellMesh, p: f64) -> LoadCase {
    vec![ShellLoad::Pressure {
        triangles: every_triangle(mesh),
        pressure: p,
    }]
}

/// Plate bending rigidity `E t³ / (12 (1 − ν²))`.
pub fn rigidity(e: f64, nu: f64, t: f64) -> f64 {
    e * t.powi(3) / (12.0 * (1.0 - nu * nu))
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Edge {
    Clamped,
    /// w = 0 and the slope along the edge zero (Kirchhoff's simple support),
    /// in-plane translations held.
    Simple,
}

/// Holds on every boundary vertex of a flat `a × b` rectangle in the xy
/// plane.
pub fn rectangle_holds(mesh: &ShellMesh, a: f64, b: f64, edge: Edge) -> Vec<ShellHold> {
    let mut holds = Vec::new();
    for (i, p) in mesh.vertices.iter().enumerate() {
        let on_x = p[0].abs() < TOL || (p[0] - a).abs() < TOL;
        let on_y = p[1].abs() < TOL || (p[1] - b).abs() < TOL;
        if !(on_x || on_y) {
            continue;
        }
        let node = i as u32;
        holds.push(match edge {
            Edge::Clamped => ShellHold::clamped(node),
            // Along x = const the edge runs in y: ∂w/∂y = θx = 0. Along
            // y = const: ∂w/∂x = −θy = 0.
            Edge::Simple => ShellHold::fixed(node, [true, true, true, on_x, on_y, false]),
        });
    }
    holds
}

pub fn centre_w(model: &ShellModel, w: &[[f64; 3]], at: [f64; 3]) -> f64 {
    w[model.mesh().nearest_vertex(at) as usize][2]
}

pub fn plate_model(
    a: f64,
    t: f64,
    n: usize,
    mat: IsotropicShell,
    edge: Edge,
    options: ShellOptions,
) -> ShellModel {
    let mesh = ShellMesh::rectangle([a, a], [n, n], t);
    let holds = rectangle_holds(&mesh, a, a, edge);
    ShellModel::new(mesh, mat, &holds, options).unwrap()
}

/// One printed row of a convergence table.
pub fn row(case: &str, mesh: &str, value: f64, reference: f64) -> f64 {
    let err = (value - reference) / reference;
    eprintln!(
        "| {case} | {mesh} | {value:.6e} | {reference:.6e} | {:+.3} % |",
        100.0 * err
    );
    err
}

/// `mesh` without the triangles `drop` says to drop (by centroid), and
/// without the vertices left on no triangle.
pub fn cut_mesh(mesh: &ShellMesh, drop: impl Fn([f64; 3]) -> bool) -> ShellMesh {
    let mut used = vec![u32::MAX; mesh.vertices.len()];
    let mut out = ShellMesh::default();
    for t in &mesh.triangles {
        let p = t.map(|v| mesh.vertices[v as usize]);
        let c = [0, 1, 2].map(|k| (p[0][k] + p[1][k] + p[2][k]) / 3.0);
        if drop(c) {
            continue;
        }
        let tri = t.map(|v| {
            if used[v as usize] == u32::MAX {
                used[v as usize] = out.vertices.len() as u32;
                out.vertices.push(mesh.vertices[v as usize]);
                out.thickness.push(mesh.thickness[v as usize]);
            }
            used[v as usize]
        });
        out.triangles.push(tri);
    }
    out
}

/// An `a × b` panel with a round hole of radius `r` at `centre`.
pub fn holed_panel(a: f64, b: f64, div: [usize; 2], t: f64, centre: [f64; 2], r: f64) -> ShellMesh {
    let mesh = ShellMesh::rectangle([a, b], div, t);
    cut_mesh(&mesh, |c| (c[0] - centre[0]).hypot(c[1] - centre[1]) < r)
}

/// An `a × b` panel without its top-right quarter: an L.
pub fn l_panel(a: f64, b: f64, div: [usize; 2], t: f64) -> ShellMesh {
    let mesh = ShellMesh::rectangle([a, b], div, t);
    cut_mesh(&mesh, |c| c[0] > 0.5 * a && c[1] > 0.5 * b)
}

/// A cylinder segment of radius `r`: `length` along x, `angle` (radians)
/// of arc centred on the top, normals outward. Vertex `i + (nx+1) j` is at
/// x = i length/nx and arc position j of ny.
pub fn cylinder_segment(r: f64, length: f64, angle: f64, div: [usize; 2], t: f64) -> ShellMesh {
    let mut mesh = ShellMesh::rectangle([length, r * angle], div, t);
    for p in &mut mesh.vertices {
        let phi = p[1] / r - 0.5 * angle;
        *p = [p[0], r * phi.sin(), r * phi.cos()];
    }
    mesh
}
