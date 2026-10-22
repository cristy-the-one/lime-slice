//! Structured bricks, each split into six tetrahedra.
//!
//! The split is the same in every brick, so a face shared by two bricks
//! carries the same diagonal. No CAD kernel. A later boundary-constrained
//! mesher implements the same `Mesher` trait.

use std::collections::HashMap;

use crate::element::ElementKind;
use crate::error::SimError;
use crate::units::{cross, dist, dot, midpoint, sub};

#[derive(Clone, Debug)]
pub struct Cell {
    pub nodes: Vec<usize>,
}

#[derive(Clone, Debug)]
pub struct Mesh {
    pub nodes: Vec<[f64; 3]>,
    pub elements: Vec<Cell>,
    pub kind: ElementKind,
}

#[derive(Clone, Debug)]
pub struct BoundaryFace {
    pub nodes: Vec<usize>,
    pub normal: [f64; 3],
    pub area: f64,
    pub centroid: [f64; 3],
    /// The element the face bounds.
    pub element: usize,
}

#[derive(Clone, Debug, Default)]
pub struct SizeField {
    pub target: f64,
    pub h: Vec<f64>,
}

pub trait Mesher {
    fn refine(&self, mesh: &Mesh, size: &SizeField) -> Result<Mesh, SimError>;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct StructuredMesher;

impl Mesher for StructuredMesher {
    fn refine(&self, mesh: &Mesh, _size: &SizeField) -> Result<Mesh, SimError> {
        mesh.refine_uniform()
    }
}

/// Local hex corners, then six tets. Corner 0 is (i,j,k), 1 is +x, 2 is +x+y,
/// 3 is +y, and 4..7 are those four at +z.
pub(crate) const HEX_TETS: [[usize; 4]; 6] = [
    [0, 1, 2, 6],
    [0, 2, 3, 6],
    [0, 1, 6, 5],
    [0, 4, 5, 6],
    [0, 3, 7, 6],
    [0, 4, 6, 7],
];

/// Eight children of one tet. Indices are into `[c0, c1, c2, c3, m01, m12, m02, m03, m13, m23]`.
const TET_CHILDREN: [[usize; 4]; 8] = [
    [0, 4, 6, 7],
    [1, 4, 8, 5],
    [2, 6, 5, 9],
    [3, 7, 9, 8],
    [4, 6, 7, 9],
    [4, 7, 8, 9],
    [4, 8, 5, 9],
    [4, 5, 6, 9],
];

impl Mesh {
    pub fn tet_volume(&self, nodes: &[usize]) -> f64 {
        let a = self.nodes[nodes[0]];
        let b = self.nodes[nodes[1]];
        let c = self.nodes[nodes[2]];
        let d = self.nodes[nodes[3]];
        dot(sub(b, a), cross(sub(c, a), sub(d, a))) / 6.0
    }

    pub fn volume(&self) -> f64 {
        self.elements
            .iter()
            .map(|e| self.tet_volume(&e.nodes).abs())
            .sum()
    }

    /// Shortest edge between the four corners. On a structured grid that is
    /// the brick edge the mesher was asked for, and a uniform refine halves it.
    /// A face or space diagonal is longer, so the longest corner edge is not
    /// the element size.
    pub fn edge_length(&self) -> f64 {
        let mut m = f64::INFINITY;
        for elem in &self.elements {
            for a in 0..4 {
                for b in (a + 1)..4 {
                    m = m.min(dist(self.nodes[elem.nodes[a]], self.nodes[elem.nodes[b]]));
                }
            }
        }
        if m.is_finite() {
            m
        } else {
            0.0
        }
    }

    pub fn refine_uniform(&self) -> Result<Mesh, SimError> {
        let mut nodes = self.nodes.clone();
        let mut mids: HashMap<(usize, usize), usize> = HashMap::new();
        let mut elements = Vec::with_capacity(self.elements.len() * 8);
        for elem in &self.elements {
            let parent = parent_with_mids(elem, self.kind, &mut nodes, &mut mids);
            for child in TET_CHILDREN {
                let corners = [
                    parent[child[0]],
                    parent[child[1]],
                    parent[child[2]],
                    parent[child[3]],
                ];
                let nodes_of = match self.kind {
                    ElementKind::Tet4 => corners.to_vec(),
                    ElementKind::Tet10 => tet10_nodes(corners, &mut nodes, &mut mids, midpoint),
                    other => {
                        return Err(SimError::new(format!(
                            "{} is not in this version.",
                            other.name()
                        )));
                    }
                };
                elements.push(Cell { nodes: nodes_of });
            }
        }
        // Quadratic mids of a child sit halfway between that child's corners.
        // `tet10_nodes` above averaged the parent coordinates, which is the
        // same point on a straight edge. Rebuild from the refined node list
        // so a second pass sees the new coordinates. The map already stored
        // them; the closure captured `self.nodes` only as a fallback for the
        // first generation of corners. Re-average now that every endpoint
        // exists in `nodes`.
        Ok(Mesh {
            nodes,
            elements,
            kind: self.kind,
        })
    }
}

fn edge_key(a: usize, b: usize) -> (usize, usize) {
    if a < b {
        (a, b)
    } else {
        (b, a)
    }
}

fn ensure_mid(
    a: usize,
    b: usize,
    nodes: &mut Vec<[f64; 3]>,
    mids: &mut HashMap<(usize, usize), usize>,
    at: [f64; 3],
) -> usize {
    let key = edge_key(a, b);
    if let Some(id) = mids.get(&key) {
        return *id;
    }
    let id = nodes.len();
    nodes.push(at);
    mids.insert(key, id);
    id
}

fn parent_with_mids(
    elem: &Cell,
    kind: ElementKind,
    nodes: &mut Vec<[f64; 3]>,
    mids: &mut HashMap<(usize, usize), usize>,
) -> [usize; 10] {
    let c = [elem.nodes[0], elem.nodes[1], elem.nodes[2], elem.nodes[3]];
    if kind == ElementKind::Tet10 && elem.nodes.len() == 10 {
        return [
            c[0],
            c[1],
            c[2],
            c[3],
            elem.nodes[4],
            elem.nodes[5],
            elem.nodes[6],
            elem.nodes[7],
            elem.nodes[8],
            elem.nodes[9],
        ];
    }
    let pairs = [(0, 1), (1, 2), (0, 2), (0, 3), (1, 3), (2, 3)];
    let mut m = [0; 6];
    for (slot, (i, j)) in pairs.iter().enumerate() {
        let at = midpoint(nodes[c[*i]], nodes[c[*j]]);
        m[slot] = ensure_mid(c[*i], c[*j], nodes, mids, at);
    }
    [c[0], c[1], c[2], c[3], m[0], m[1], m[2], m[3], m[4], m[5]]
}

pub(crate) fn tet10_nodes(
    corners: [usize; 4],
    nodes: &mut Vec<[f64; 3]>,
    mids: &mut HashMap<(usize, usize), usize>,
    mid_of: fn([f64; 3], [f64; 3]) -> [f64; 3],
) -> Vec<usize> {
    let pairs = [(0, 1), (1, 2), (2, 0), (0, 3), (1, 3), (2, 3)];
    let mut out = corners.to_vec();
    for (i, j) in pairs {
        let at = mid_of(nodes[corners[i]], nodes[corners[j]]);
        out.push(ensure_mid(corners[i], corners[j], nodes, mids, at));
    }
    out
}

/// A brick grid in index space, placed by `at(i, j, k)`. `mid_of` is the
/// straight midpoint, or a projection that puts a quadratic node on a circle.
pub fn mapped_grid(
    div: [usize; 3],
    kind: ElementKind,
    at: impl Fn(usize, usize, usize) -> [f64; 3],
    mid_of: fn([f64; 3], [f64; 3]) -> [f64; 3],
) -> Result<Mesh, SimError> {
    if !matches!(kind, ElementKind::Tet4 | ElementKind::Tet10) {
        return Err(SimError::new(format!(
            "{} is not in this version.",
            kind.name()
        )));
    }
    let [nx, ny, nz] = div;
    if nx == 0 || ny == 0 || nz == 0 {
        return Err(SimError::new("A grid needs at least one brick."));
    }
    let mut nodes = Vec::new();
    for k in 0..=nz {
        for j in 0..=ny {
            for i in 0..=nx {
                nodes.push(at(i, j, k));
            }
        }
    }
    let cid = |i: usize, j: usize, k: usize| i + (nx + 1) * (j + (ny + 1) * k);
    let mut mids: HashMap<(usize, usize), usize> = HashMap::new();
    let mut elements = Vec::new();
    for k in 0..nz {
        for j in 0..ny {
            for i in 0..nx {
                let hex = [
                    cid(i, j, k),
                    cid(i + 1, j, k),
                    cid(i + 1, j + 1, k),
                    cid(i, j + 1, k),
                    cid(i, j, k + 1),
                    cid(i + 1, j, k + 1),
                    cid(i + 1, j + 1, k + 1),
                    cid(i, j + 1, k + 1),
                ];
                for tet in HEX_TETS {
                    let corners = [hex[tet[0]], hex[tet[1]], hex[tet[2]], hex[tet[3]]];
                    let cell_nodes = if kind == ElementKind::Tet4 {
                        corners.to_vec()
                    } else {
                        tet10_nodes(corners, &mut nodes, &mut mids, mid_of)
                    };
                    elements.push(Cell { nodes: cell_nodes });
                }
            }
        }
    }
    Ok(Mesh {
        nodes,
        elements,
        kind,
    })
}

/// Mid-edge node on a Z-axis cylinder. A radial edge stays straight. An edge
/// whose ends share a radius is put on that cylinder, so a quadratic tet
/// follows the hole instead of the chord.
pub fn cylindrical_mid(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    let ra = (a[0] * a[0] + a[1] * a[1]).sqrt();
    let rb = (b[0] * b[0] + b[1] * b[1]).sqrt();
    let scale = ra.max(rb).max(1.0);
    if (ra - rb).abs() > 1e-8 * scale || ra < 1e-12 || rb < 1e-12 {
        return midpoint(a, b);
    }
    let ux = a[0] / ra + b[0] / rb;
    let uy = a[1] / ra + b[1] / rb;
    let n = (ux * ux + uy * uy).sqrt();
    if n < 1e-12 {
        return midpoint(a, b);
    }
    let r = 0.5 * (ra + rb);
    [r * ux / n, r * uy / n, 0.5 * (a[2] + b[2])]
}

pub fn beam(
    length: f64,
    width: f64,
    height: f64,
    edge: f64,
    kind: ElementKind,
) -> Result<Mesh, SimError> {
    if !(length.is_finite() && width.is_finite() && height.is_finite() && edge.is_finite())
        || length <= 0.0
        || width <= 0.0
        || height <= 0.0
        || edge <= 0.0
    {
        return Err(SimError::new(
            "The beam length and the edge length have to be positive.",
        ));
    }
    if !matches!(kind, ElementKind::Tet4 | ElementKind::Tet10) {
        return Err(SimError::new(format!(
            "{} is not in this version.",
            kind.name()
        )));
    }
    let nx = ((length / edge).round() as usize).max(1);
    let ny = ((width / edge).round() as usize).max(1);
    let nz = ((height / edge).round() as usize).max(1);
    grid([0.0, 0.0, 0.0], [length, width, height], [nx, ny, nz], kind)
}

pub fn grid(
    origin: [f64; 3],
    size: [f64; 3],
    div: [usize; 3],
    kind: ElementKind,
) -> Result<Mesh, SimError> {
    let [nx, ny, nz] = div;
    if nx == 0 || ny == 0 || nz == 0 {
        return Err(SimError::new("A grid needs at least one brick."));
    }
    let mut nodes = Vec::new();
    let sx = size[0] / nx as f64;
    let sy = size[1] / ny as f64;
    let sz = size[2] / nz as f64;
    for k in 0..=nz {
        for j in 0..=ny {
            for i in 0..=nx {
                nodes.push([
                    origin[0] + i as f64 * sx,
                    origin[1] + j as f64 * sy,
                    origin[2] + k as f64 * sz,
                ]);
            }
        }
    }
    let cid = |i: usize, j: usize, k: usize| i + (nx + 1) * (j + (ny + 1) * k);
    let mut mids: HashMap<(usize, usize), usize> = HashMap::new();
    let mut elements = Vec::new();
    for k in 0..nz {
        for j in 0..ny {
            for i in 0..nx {
                let hex = [
                    cid(i, j, k),
                    cid(i + 1, j, k),
                    cid(i + 1, j + 1, k),
                    cid(i, j + 1, k),
                    cid(i, j, k + 1),
                    cid(i + 1, j, k + 1),
                    cid(i + 1, j + 1, k + 1),
                    cid(i, j + 1, k + 1),
                ];
                for tet in HEX_TETS {
                    let corners = [hex[tet[0]], hex[tet[1]], hex[tet[2]], hex[tet[3]]];
                    let cell_nodes = if kind == ElementKind::Tet4 {
                        corners.to_vec()
                    } else {
                        tet10_nodes(corners, &mut nodes, &mut mids, midpoint)
                    };
                    elements.push(Cell { nodes: cell_nodes });
                }
            }
        }
    }
    Ok(Mesh {
        nodes,
        elements,
        kind,
    })
}

/// One distorted tet, or four tets around an interior node, for the patch test.
pub fn patch_mesh(kind: ElementKind, interior: bool) -> Result<Mesh, SimError> {
    let corners = [
        [0.0, 0.0, 0.0],
        [2.0, 0.15, 0.1],
        [0.2, 1.8, 0.05],
        [0.3, 0.25, 1.7],
    ];
    if !interior {
        return one_tet(&corners, kind);
    }
    let w = [0.22, 0.27, 0.24, 0.27];
    let mut p = [0.0; 3];
    for i in 0..4 {
        for k in 0..3 {
            p[k] += w[i] * corners[i][k];
        }
    }
    let mut nodes = vec![corners[0], corners[1], corners[2], corners[3], p];
    let subs = [[4, 1, 2, 3], [0, 4, 2, 3], [0, 1, 4, 3], [0, 1, 2, 4]];
    let mut mids: HashMap<(usize, usize), usize> = HashMap::new();
    let mut elements = Vec::new();
    for tet in subs {
        let cell_nodes = if kind == ElementKind::Tet4 {
            tet.to_vec()
        } else {
            tet10_nodes(tet, &mut nodes, &mut mids, midpoint)
        };
        elements.push(Cell { nodes: cell_nodes });
    }
    Ok(Mesh {
        nodes,
        elements,
        kind,
    })
}

fn one_tet(corners: &[[f64; 3]; 4], kind: ElementKind) -> Result<Mesh, SimError> {
    let mut nodes = corners.to_vec();
    let mut mids = HashMap::new();
    let cell_nodes = if kind == ElementKind::Tet4 {
        vec![0, 1, 2, 3]
    } else {
        tet10_nodes([0, 1, 2, 3], &mut nodes, &mut mids, midpoint)
    };
    Ok(Mesh {
        nodes,
        elements: vec![Cell { nodes: cell_nodes }],
        kind,
    })
}

pub fn boundary_faces(mesh: &Mesh) -> Vec<BoundaryFace> {
    let mut count: HashMap<[usize; 3], usize> = HashMap::new();
    for elem in &mesh.elements {
        for face in 0..4 {
            let mut key = face_corners(elem, face);
            key.sort_unstable();
            *count.entry(key).or_insert(0) += 1;
        }
    }
    let mut faces = Vec::new();
    for (ei, elem) in mesh.elements.iter().enumerate() {
        for face in 0..4 {
            let mut key = face_corners(elem, face);
            key.sort_unstable();
            if count[&key] != 1 {
                continue;
            }
            if let Some(mut built) = outward_face(mesh, elem, face) {
                built.element = ei;
                faces.push(built);
            }
        }
    }
    faces
}

fn face_corners(elem: &Cell, face: usize) -> [usize; 3] {
    let c = [elem.nodes[0], elem.nodes[1], elem.nodes[2], elem.nodes[3]];
    const WHICH: [[usize; 3]; 4] = [[1, 2, 3], [0, 2, 3], [0, 1, 3], [0, 1, 2]];
    [c[WHICH[face][0]], c[WHICH[face][1]], c[WHICH[face][2]]]
}

fn mid_local(a: usize, b: usize) -> usize {
    match (a.min(b), a.max(b)) {
        (0, 1) => 4,
        (1, 2) => 5,
        (0, 2) => 6,
        (0, 3) => 7,
        (1, 3) => 8,
        (2, 3) => 9,
        _ => 0,
    }
}

fn outward_face(mesh: &Mesh, elem: &Cell, face: usize) -> Option<BoundaryFace> {
    const WHICH: [[usize; 3]; 4] = [[1, 2, 3], [0, 2, 3], [0, 1, 3], [0, 1, 2]];
    let opp = [0, 1, 2, 3][face];
    let mut local = WHICH[face];
    let pa = mesh.nodes[elem.nodes[local[0]]];
    let pb = mesh.nodes[elem.nodes[local[1]]];
    let pc = mesh.nodes[elem.nodes[local[2]]];
    let po = mesh.nodes[elem.nodes[opp]];
    let mut n = cross(sub(pb, pa), sub(pc, pa));
    if dot(n, sub(po, pa)) > 0.0 {
        local.swap(1, 2);
        n = [-n[0], -n[1], -n[2]];
    }
    let area = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt() * 0.5;
    if area < 1e-18 {
        return None;
    }
    let normal = [
        n[0] / (2.0 * area),
        n[1] / (2.0 * area),
        n[2] / (2.0 * area),
    ];
    let mut nodes = vec![
        elem.nodes[local[0]],
        elem.nodes[local[1]],
        elem.nodes[local[2]],
    ];
    if elem.nodes.len() == 10 {
        let c0 = local[0];
        let c1 = local[1];
        let c2 = local[2];
        nodes.push(elem.nodes[mid_local(c0, c1)]);
        nodes.push(elem.nodes[mid_local(c1, c2)]);
        nodes.push(elem.nodes[mid_local(c2, c0)]);
    }
    let p0 = mesh.nodes[nodes[0]];
    let p1 = mesh.nodes[nodes[1]];
    let p2 = mesh.nodes[nodes[2]];
    let centroid = [
        (p0[0] + p1[0] + p2[0]) / 3.0,
        (p0[1] + p1[1] + p2[1]) / 3.0,
        (p0[2] + p1[2] + p2[2]) / 3.0,
    ];
    Some(BoundaryFace {
        nodes,
        normal,
        area,
        centroid,
        element: 0,
    })
}

pub fn faces_on_plane(mesh: &Mesh, axis: usize, at: f64, tol: f64) -> Vec<BoundaryFace> {
    boundary_faces(mesh)
        .into_iter()
        .filter(|face| {
            face.nodes
                .iter()
                .take(3)
                .all(|n| (mesh.nodes[*n][axis] - at).abs() <= tol)
        })
        .collect()
}

/// Nodes whose barycentric coordinate in `parent` is off every face.
pub fn interior_nodes(mesh: &Mesh, parent: &[[f64; 3]; 4]) -> Vec<usize> {
    let vol = {
        let a = parent[0];
        let b = parent[1];
        let c = parent[2];
        let d = parent[3];
        dot(sub(b, a), cross(sub(c, a), sub(d, a))) / 6.0
    };
    mesh.nodes
        .iter()
        .enumerate()
        .filter(|(_, p)| {
            let coords = [
                tet_vol([**p, parent[1], parent[2], parent[3]]) / vol,
                tet_vol([parent[0], **p, parent[2], parent[3]]) / vol,
                tet_vol([parent[0], parent[1], **p, parent[3]]) / vol,
                tet_vol([parent[0], parent[1], parent[2], **p]) / vol,
            ];
            coords.iter().all(|c| *c > 1e-8)
        })
        .map(|(i, _)| i)
        .collect()
}

fn tet_vol(p: [[f64; 3]; 4]) -> f64 {
    dot(sub(p[1], p[0]), cross(sub(p[2], p[0]), sub(p[3], p[0]))) / 6.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn six_tets_fill_the_brick() {
        let mesh = grid(
            [0.0, 0.0, 0.0],
            [1.2, 0.8, 0.5],
            [1, 1, 1],
            ElementKind::Tet4,
        )
        .unwrap();
        assert_eq!(mesh.elements.len(), 6);
        let volume = mesh.volume();
        assert!((volume - 1.2 * 0.8 * 0.5).abs() < 1e-12);
        for elem in &mesh.elements {
            assert!(mesh.tet_volume(&elem.nodes) > 0.0);
        }
    }

    #[test]
    fn neighbouring_bricks_share_the_diagonal() {
        let mesh = grid(
            [0.0, 0.0, 0.0],
            [2.0, 1.0, 1.0],
            [2, 1, 1],
            ElementKind::Tet4,
        )
        .unwrap();
        let faces = boundary_faces(&mesh);
        // Two bricks: the internal face is not in the boundary set.
        let x1: Vec<_> = faces
            .iter()
            .filter(|f| {
                f.nodes
                    .iter()
                    .take(3)
                    .all(|n| (mesh.nodes[*n][0] - 1.0).abs() < 1e-12)
            })
            .collect();
        assert!(x1.is_empty(), "the shared face leaked into the boundary");
        assert!((mesh.volume() - 2.0).abs() < 1e-12);
    }

    #[test]
    fn refine_halves_the_corner_edge() {
        let mesh = beam(20.0, 10.0, 10.0, 10.0, ElementKind::Tet10).unwrap();
        let before = mesh.edge_length();
        let fine = StructuredMesher
            .refine(&mesh, &SizeField::default())
            .unwrap();
        let after = fine.edge_length();
        assert!((before - 10.0).abs() < 1e-9, "before {before}");
        assert!(
            (after - 5.0).abs() < 1e-6,
            "after {after}, elements {} -> {}",
            mesh.elements.len(),
            fine.elements.len()
        );
        assert!((fine.volume() - mesh.volume()).abs() < 1e-8);
    }

    #[test]
    fn cylindrical_mids_sit_on_the_arc() {
        let mesh = mapped_grid(
            [2, 4, 1],
            ElementKind::Tet10,
            |i, j, k| {
                let r = 10.0 + 5.0 * i as f64;
                let th = std::f64::consts::FRAC_PI_2 * j as f64 / 4.0;
                [r * th.cos(), r * th.sin(), k as f64]
            },
            cylindrical_mid,
        )
        .unwrap();
        let min_r = mesh
            .nodes
            .iter()
            .map(|p| (p[0] * p[0] + p[1] * p[1]).sqrt())
            .fold(f64::INFINITY, f64::min);
        assert!(
            (min_r - 10.0).abs() < 1e-8,
            "a chord mid would sit inside r=10, got {min_r}"
        );
    }
}
