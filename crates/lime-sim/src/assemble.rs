//! Triplets in, a free matrix out. A fixed direction is dropped from the
//! matrix, not penalised, so what remains is symmetric positive definite
//! when the part is held.

use std::collections::HashMap;

use faer::Mat;
use rayon::prelude::*;

use crate::element::{element, gradients, ElementKind, ElementOut, GaussContext};
use crate::error::SimError;
use crate::material::{MatState, MaterialModel};
use crate::mesh::Mesh;
use crate::sliced::CellMaterial;
use crate::units::{normalize, specific_weight_n_per_mm3};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConstraintKind {
    Fixed,
    Prescribed,
    Tie,
    Contact,
}

#[derive(Clone, Debug)]
pub struct NodeBasis {
    /// Columns are the local dof directions, written in global coordinates.
    pub q: [[f64; 3]; 3],
    pub prescribed: [Option<f64>; 3],
}

impl Default for NodeBasis {
    fn default() -> Self {
        Self {
            q: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
            prescribed: [None, None, None],
        }
    }
}

#[derive(Clone, Debug)]
pub struct DofMap {
    pub bases: Vec<NodeBasis>,
    columns: Vec<[Option<usize>; 3]>,
    pub n_free: usize,
}

impl DofMap {
    pub fn column(&self, node: usize, local: usize) -> Option<usize> {
        self.columns[node][local]
    }
}

#[derive(Clone, Debug)]
pub enum Hold {
    Fixed,
    Axis {
        axis: usize,
        value: f64,
    },
    Normal {
        normal: [f64; 3],
        value: f64,
    },
    /// `q` columns are the local directions in global coordinates, same layout
    /// as `NodeBasis`. `prescribed[local]` is set, and `None` stays free.
    Frame {
        q: [[f64; 3]; 3],
        prescribed: [Option<f64>; 3],
    },
}

#[derive(Clone, Debug)]
pub struct NodeHold {
    pub node: usize,
    pub hold: Hold,
}

#[derive(Clone, Debug)]
pub enum Load {
    Traction {
        nodes: Vec<usize>,
        traction: [f64; 3],
    },
    Force {
        node: usize,
        force: [f64; 3],
    },
}

pub struct System {
    pub k: Vec<(usize, usize, f64)>,
    pub residual: Vec<f64>,
    pub external: Vec<f64>,
    pub dof: DofMap,
    /// Prescribed local values, keyed by `(node, local dof)`.
    pub prescribed: HashMap<(usize, usize), f64>,
}

pub trait Constraint {
    fn kind(&self) -> ConstraintKind;
    fn apply(&self, dof: &DofMap, system: &mut System);
}

impl Constraint for NodeHold {
    fn kind(&self) -> ConstraintKind {
        match self.hold {
            Hold::Fixed => ConstraintKind::Fixed,
            Hold::Axis { .. } | Hold::Normal { .. } | Hold::Frame { .. } => {
                ConstraintKind::Prescribed
            }
        }
    }

    fn apply(&self, dof: &DofMap, system: &mut System) {
        match self.hold {
            Hold::Fixed => {
                for local in 0..3 {
                    system.prescribed.insert((self.node, local), 0.0);
                    let _ = dof.column(self.node, local);
                }
            }
            Hold::Axis { axis, value } => {
                system.prescribed.insert((self.node, axis), value);
            }
            Hold::Normal { value, .. } => {
                system.prescribed.insert((self.node, 0), value);
            }
            Hold::Frame { prescribed, .. } => {
                for local in 0..3 {
                    if let Some(value) = prescribed[local] {
                        system.prescribed.insert((self.node, local), value);
                    }
                }
            }
        }
    }
}

pub fn build_dof(n_nodes: usize, holds: &[NodeHold]) -> Result<DofMap, SimError> {
    let mut bases = vec![NodeBasis::default(); n_nodes];
    for hold in holds {
        if hold.node >= n_nodes {
            return Err(SimError::new(
                "A hold names a node that is not in the mesh.",
            ));
        }
        let basis = &mut bases[hold.node];
        match hold.hold {
            Hold::Fixed => {
                *basis = NodeBasis::default();
                basis.prescribed = [Some(0.0), Some(0.0), Some(0.0)];
            }
            Hold::Axis { axis, value } => {
                if axis > 2 {
                    return Err(SimError::new("A held direction has to be x, y, or z."));
                }
                if !is_identity(&basis.q) {
                    return Err(SimError::new("A node is held twice."));
                }
                if let Some(prev) = basis.prescribed[axis] {
                    if (prev - value).abs() > 1e-9 {
                        return Err(SimError::new("A node is held twice."));
                    }
                }
                basis.prescribed[axis] = Some(value);
            }
            Hold::Normal { normal, value } => {
                if basis.prescribed.iter().any(|p| p.is_some()) || !is_identity(&basis.q) {
                    return Err(SimError::new("A node is held twice."));
                }
                let n = normalize(normal)
                    .ok_or_else(|| SimError::new("A symmetry direction has zero length."))?;
                let helper = if n[0].abs() < 0.9 {
                    [1.0, 0.0, 0.0]
                } else {
                    [0.0, 1.0, 0.0]
                };
                let t1 = normalize(crate::units::cross(helper, n)).unwrap();
                let t2 = crate::units::cross(n, t1);
                // Columns: normal, then the two tangents.
                basis.q = [
                    [n[0], t1[0], t2[0]],
                    [n[1], t1[1], t2[1]],
                    [n[2], t1[2], t2[2]],
                ];
                basis.prescribed[0] = Some(value);
            }
            Hold::Frame { q, prescribed } => {
                if basis.prescribed.iter().any(|p| p.is_some()) || !is_identity(&basis.q) {
                    return Err(SimError::new("A node is held twice."));
                }
                basis.q = q;
                basis.prescribed = prescribed;
            }
        }
    }
    let mut columns = vec![[None; 3]; n_nodes];
    let mut n_free = 0;
    for node in 0..n_nodes {
        for local in 0..3 {
            if bases[node].prescribed[local].is_none() {
                columns[node][local] = Some(n_free);
                n_free += 1;
            }
        }
    }
    Ok(DofMap {
        bases,
        columns,
        n_free,
    })
}

fn is_identity(q: &[[f64; 3]; 3]) -> bool {
    for i in 0..3 {
        for j in 0..3 {
            let expect = if i == j { 1.0 } else { 0.0 };
            if (q[i][j] - expect).abs() > 1e-12 {
                return false;
            }
        }
    }
    true
}

pub struct Assembly {
    pub system: System,
    pub solid_volume: f64,
    pub printed_volume: f64,
}

/// Elements a thread assembles at a time.
const ASSEMBLY_CHUNK: usize = 256;

/// What a chunk of elements adds besides its matrix values.
#[derive(Default)]
struct Piece {
    /// `(column, value)` to add to the residual.
    residual: Vec<(usize, f64)>,
    /// Body force at a node, load level applied.
    body: Vec<(usize, [f64; 3])>,
    solid_volume: f64,
    printed_volume: f64,
}

#[allow(clippy::too_many_arguments)]
pub fn assemble(
    mesh: &Mesh,
    material: &dyn MaterialModel,
    build_axis: [f64; 3],
    cells: &[CellMaterial],
    loads: &[Load],
    load_level: f64,
    gravity_mm_s2: Option<f64>,
    u: &[[f64; 3]],
    dof: DofMap,
    holds: &[NodeHold],
) -> Result<Assembly, SimError> {
    let mut system = System {
        k: Vec::new(),
        residual: vec![0.0; dof.n_free],
        external: vec![0.0; dof.n_free],
        dof,
        prescribed: HashMap::new(),
    };
    let dof_for_holds = system.dof.clone();
    for hold in holds {
        hold.apply(&dof_for_holds, &mut system);
    }
    // Split the borrow: prescribed and dof are used while k is filled.
    let prescribed = system.prescribed.clone();
    let dof = system.dof.clone();

    let mut fext = vec![[0.0; 3]; mesh.nodes.len()];
    for load in loads {
        match load {
            Load::Force { node, force } => {
                for k in 0..3 {
                    fext[*node][k] += force[k] * load_level;
                }
            }
            Load::Traction { nodes, traction } => {
                let coords: Vec<[f64; 3]> = nodes.iter().map(|n| mesh.nodes[*n]).collect();
                let forces = traction_forces(&coords, *traction);
                for (node, force) in nodes.iter().zip(forces) {
                    for k in 0..3 {
                        fext[*node][k] += force[k] * load_level;
                    }
                }
            }
        }
    }

    let density = material.density_g_cm3();
    let mut solid_volume = 0.0;
    let mut printed_volume = 0.0;
    let elem = element(mesh.kind)
        .ok_or_else(|| SimError::new(format!("{} is not in this version.", mesh.kind.name())))?;

    // Each element adds the upper triangle of its free dofs to the matrix:
    // f(f + 1) / 2 values for f free dofs. Counted first, the whole list is
    // allocated once and every chunk of elements fills its own part of it
    // on its own thread.
    let free_dofs = |nodes: &[usize]| {
        nodes
            .iter()
            .map(|n| (0..3).filter(|&l| dof.column(*n, l).is_some()).count())
            .sum::<usize>()
    };
    let chunks: Vec<usize> = mesh
        .elements
        .par_chunks(ASSEMBLY_CHUNK)
        .map(|chunk| {
            chunk
                .iter()
                .map(|cell| {
                    let f = free_dofs(&cell.nodes);
                    f * (f + 1) / 2
                })
                .sum()
        })
        .collect();
    system.k = vec![(0, 0, 0.0); chunks.iter().sum()];
    let mut parts: Vec<&mut [(usize, usize, f64)]> = Vec::with_capacity(chunks.len());
    let mut rest = system.k.as_mut_slice();
    for len in &chunks {
        let (part, tail) = rest.split_at_mut(*len);
        parts.push(part);
        rest = tail;
    }
    let pieces: Vec<Piece> = mesh
        .elements
        .par_chunks(ASSEMBLY_CHUNK)
        .zip(parts.into_par_iter())
        .enumerate()
        .map(|(c, (chunk, out))| {
            let mut piece = Piece::default();
            let mut at = 0;
            for (offset, cell) in chunk.iter().enumerate() {
                let ei = c * ASSEMBLY_CHUNK + offset;
                let made_of = cells.get(ei).copied().unwrap_or(CellMaterial::smeared(1.0));
                let fraction = made_of.volume_fraction;
                let coords: Vec<[f64; 3]> = cell.nodes.iter().map(|n| mesh.nodes[*n]).collect();
                let nd = cell.nodes.len() * 3;
                let mut displacement = vec![0.0; nd];
                for (a, node) in cell.nodes.iter().enumerate() {
                    for k in 0..3 {
                        displacement[a * 3 + k] = u[*node][k];
                    }
                }
                let mat_ctx = made_of.context(build_axis);
                let mut state = MatState::default();
                let mut ctx = GaussContext {
                    coords: &coords,
                    displacement: &displacement,
                    material,
                    mat_ctx: &mat_ctx,
                    state: &mut state,
                    density_g_per_mm3: density / 1000.0 * fraction,
                };
                let mut el = ElementOut::zeros(nd);
                for gp in elem.quadrature() {
                    elem.contribute(gp, &mut ctx, &mut el);
                    let shape = elem.shape(gp.xi);
                    if let Some((_, det)) = gradients(&shape.dn_dxi, &coords) {
                        let dv = gp.weight * det;
                        piece.solid_volume += dv;
                        piece.printed_volume += dv * fraction;
                    }
                }
                if let Some(g) = gravity_mm_s2 {
                    let weight = specific_weight_n_per_mm3(density, g) * fraction;
                    let body = body_force(mesh.kind, &coords, [0.0, 0.0, -weight]);
                    for (a, node) in cell.nodes.iter().enumerate() {
                        let f = body[a];
                        piece
                            .body
                            .push((*node, [f[0] * load_level, f[1] * load_level, f[2] * load_level]));
                    }
                }
                symmetrize(&mut el.ke);
                let qs: Vec<[[f64; 3]; 3]> = cell.nodes.iter().map(|n| dof.bases[*n].q).collect();
                let (ke, fe) = rotate_element(&el.ke, &el.fe, &qs);
                let mut du_p = vec![0.0; nd];
                let mut held = vec![false; nd];
                for (a, node) in cell.nodes.iter().enumerate() {
                    let u_l = to_local(&dof.bases[*node].q, u[*node]);
                    for local in 0..3 {
                        if let Some(value) = prescribed.get(&(*node, local)) {
                            du_p[a * 3 + local] = value - u_l[local];
                            held[a * 3 + local] = true;
                        }
                    }
                }
                for i in 0..nd {
                    if held[i] {
                        continue;
                    }
                    let (na, la) = (i / 3, i % 3);
                    let Some(ci) = dof.column(cell.nodes[na], la) else {
                        continue;
                    };
                    let mut r = -fe[i];
                    for j in 0..nd {
                        if held[j] {
                            r -= ke[(i, j)] * du_p[j];
                        }
                    }
                    piece.residual.push((ci, r));
                    for j in i..nd {
                        if held[j] {
                            continue;
                        }
                        let (nb, lb) = (j / 3, j % 3);
                        let Some(cj) = dof.column(cell.nodes[nb], lb) else {
                            continue;
                        };
                        let v = ke[(i, j)];
                        out[at] = if ci <= cj { (ci, cj, v) } else { (cj, ci, v) };
                        at += 1;
                    }
                }
            }
            debug_assert_eq!(at, out.len());
            piece
        })
        .collect();
    for piece in pieces {
        solid_volume += piece.solid_volume;
        printed_volume += piece.printed_volume;
        for (col, r) in piece.residual {
            system.residual[col] += r;
        }
        for (node, f) in piece.body {
            for k in 0..3 {
                fext[node][k] += f[k];
            }
        }
    }

    for node in 0..mesh.nodes.len() {
        let local = to_local(&dof.bases[node].q, fext[node]);
        for axis in 0..3 {
            if let Some(col) = dof.column(node, axis) {
                system.residual[col] += local[axis];
                system.external[col] += local[axis];
            }
        }
    }

    Ok(Assembly {
        system,
        solid_volume,
        printed_volume,
    })
}

pub fn add_increment(
    u: &mut [[f64; 3]],
    dof: &DofMap,
    du: &[f64],
    prescribed: &HashMap<(usize, usize), f64>,
) {
    for node in 0..u.len() {
        let u_l = to_local(&dof.bases[node].q, u[node]);
        let mut du_l = [0.0; 3];
        for local in 0..3 {
            if let Some(value) = prescribed.get(&(node, local)) {
                du_l[local] = value - u_l[local];
            } else if let Some(col) = dof.column(node, local) {
                du_l[local] = du[col];
            }
        }
        let du_g = to_global(&dof.bases[node].q, du_l);
        for k in 0..3 {
            u[node][k] += du_g[k];
        }
    }
}

fn to_local(q: &[[f64; 3]; 3], v: [f64; 3]) -> [f64; 3] {
    let mut o = [0.0; 3];
    for local in 0..3 {
        for g in 0..3 {
            o[local] += q[g][local] * v[g];
        }
    }
    o
}

fn to_global(q: &[[f64; 3]; 3], v: [f64; 3]) -> [f64; 3] {
    let mut o = [0.0; 3];
    for g in 0..3 {
        for local in 0..3 {
            o[g] += q[g][local] * v[local];
        }
    }
    o
}

fn symmetrize(ke: &mut Mat<f64>) {
    let n = ke.nrows();
    for i in 0..n {
        for j in i..n {
            let s = 0.5 * (ke[(i, j)] + ke[(j, i)]);
            ke[(i, j)] = s;
            ke[(j, i)] = s;
        }
    }
}

fn rotate_element(ke: &Mat<f64>, fe: &[f64], qs: &[[[f64; 3]; 3]]) -> (Mat<f64>, Vec<f64>) {
    let nn = qs.len();
    let nd = nn * 3;
    let mut out = Mat::<f64>::zeros(nd, nd);
    let mut fo = vec![0.0; nd];
    for a in 0..nn {
        let fl = to_local(&qs[a], [fe[3 * a], fe[3 * a + 1], fe[3 * a + 2]]);
        fo[3 * a] = fl[0];
        fo[3 * a + 1] = fl[1];
        fo[3 * a + 2] = fl[2];
        for b in 0..nn {
            let mut gq = [[0.0; 3]; 3];
            for i in 0..3 {
                for lb in 0..3 {
                    let mut s = 0.0;
                    for j in 0..3 {
                        s += ke[(3 * a + i, 3 * b + j)] * qs[b][j][lb];
                    }
                    gq[i][lb] = s;
                }
            }
            for la in 0..3 {
                for lb in 0..3 {
                    let mut s = 0.0;
                    for i in 0..3 {
                        s += qs[a][i][la] * gq[i][lb];
                    }
                    out[(3 * a + la, 3 * b + lb)] = s;
                }
            }
        }
    }
    (out, fo)
}

pub fn traction_forces(coords: &[[f64; 3]], traction: [f64; 3]) -> Vec<[f64; 3]> {
    let n = coords.len();
    let mut forces = vec![[0.0; 3]; n];
    if n == 6 {
        let points = [
            (1.0 / 6.0, 1.0 / 6.0),
            (2.0 / 3.0, 1.0 / 6.0),
            (1.0 / 6.0, 2.0 / 3.0),
        ];
        let w = 1.0 / 6.0;
        for (l1, l2) in points {
            let (nvals, d1, d2) = quad_face(l1, l2);
            let scale = face_jac(coords, &d1, &d2) * w;
            for a in 0..6 {
                for k in 0..3 {
                    forces[a][k] += nvals[a] * traction[k] * scale;
                }
            }
        }
    } else if n >= 3 {
        let l1 = 1.0 / 3.0;
        let l2 = 1.0 / 3.0;
        let l0 = 1.0 - l1 - l2;
        let nvals = [l0, l1, l2];
        let d1 = [-1.0, 1.0, 0.0];
        let d2 = [-1.0, 0.0, 1.0];
        let scale = face_jac(&coords[..3], &d1, &d2) * 0.5;
        for a in 0..3 {
            for k in 0..3 {
                forces[a][k] += nvals[a] * traction[k] * scale;
            }
        }
    }
    forces
}

fn quad_face(l1: f64, l2: f64) -> ([f64; 6], [f64; 6], [f64; 6]) {
    let l0 = 1.0 - l1 - l2;
    let n = [
        l0 * (2.0 * l0 - 1.0),
        l1 * (2.0 * l1 - 1.0),
        l2 * (2.0 * l2 - 1.0),
        4.0 * l0 * l1,
        4.0 * l1 * l2,
        4.0 * l2 * l0,
    ];
    let d1 = [
        -(4.0 * l0 - 1.0),
        4.0 * l1 - 1.0,
        0.0,
        4.0 * (l0 - l1),
        4.0 * l2,
        -4.0 * l2,
    ];
    let d2 = [
        -(4.0 * l0 - 1.0),
        0.0,
        4.0 * l2 - 1.0,
        -4.0 * l1,
        4.0 * l1,
        4.0 * (l0 - l2),
    ];
    (n, d1, d2)
}

fn face_jac(coords: &[[f64; 3]], d1: &[f64], d2: &[f64]) -> f64 {
    let mut dr1 = [0.0; 3];
    let mut dr2 = [0.0; 3];
    for a in 0..d1.len() {
        for k in 0..3 {
            dr1[k] += d1[a] * coords[a][k];
            dr2[k] += d2[a] * coords[a][k];
        }
    }
    let c = crate::units::cross(dr1, dr2);
    crate::units::norm(c)
}

fn body_force(kind: ElementKind, coords: &[[f64; 3]], density: [f64; 3]) -> Vec<[f64; 3]> {
    let Some(elem) = element(kind) else {
        return Vec::new();
    };
    let n = elem.nodes();
    let mut f = vec![[0.0; 3]; n];
    for gp in elem.quadrature() {
        let shape = elem.shape(gp.xi);
        let Some((_, det)) = gradients(&shape.dn_dxi, coords) else {
            continue;
        };
        let scale = gp.weight * det;
        for a in 0..n {
            for k in 0..3 {
                f[a][k] += shape.n[a] * density[k] * scale;
            }
        }
    }
    f
}

pub fn rel_norm(residual: &[f64], external: &[f64]) -> f64 {
    let rn = residual.iter().map(|v| v * v).sum::<f64>().sqrt();
    let en = external.iter().map(|v| v * v).sum::<f64>().sqrt();
    if en > 1e-30 {
        rn / en
    } else {
        rn
    }
}
