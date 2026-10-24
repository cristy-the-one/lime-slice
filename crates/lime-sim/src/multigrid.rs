//! A two-level p-multigrid solve of a TET10 grid.
//!
//! The coarse space is the linear tets on the same grid: a TET10's corners,
//! about an eighth of its nodes. It nests exactly in the quadratic space (a
//! mid-edge node is the mean of its edge's corners), so the map between the
//! two is exact, holds carry over node by node, and the coarse operator is
//! the fine one restricted, `PᵀAP`, rather than another grid's guess at it.
//! With two weights a fine row that product is cheap and very sparse, and it
//! factors in a moment. The cycle smooths the fine grid with Chebyshev
//! steps, corrects through that factor, and smooths again; conjugate
//! gradients run outside it.
//!
//! It replaces a two-level solve that leaned on a coarser grid's own factor
//! (3.9.2): that grid disagreed with the fine one (the jet's 2 mm grid is 18%
//! stiffer than its 1.41 mm one), its solves were most of the time, and the
//! factor cost as much as a direct solve. On the jet's 1.41 mm grid this
//! takes 24 iterations where that took 38, with no large factor anywhere.

use std::cell::Cell;
use std::collections::HashMap;

use rayon::prelude::*;

use crate::assemble::DofMap;
use crate::error::SimError;
use crate::mesh::Mesh;
use crate::solve::{FaerLdlt, LinearSolver};
use crate::iterative::{chebyshev, largest_eigenvalue, pcg, Csr, CHEBYSHEV_RATIO};

#[cfg(feature = "gpu")]
mod gpu;

/// TET10 mid-edge slots and the corner slots of their edge, as
/// `mesh::tet10_nodes` lays them out.
const MID_EDGES: [(usize, usize); 6] = [(0, 1), (1, 2), (2, 0), (0, 3), (1, 3), (2, 3)];

/// Chebyshev steps before and after the coarse correction, on the CPU. On the
/// jet study's 217k-node grid, against the corners' factor: degree 12 took 20
/// iterations and 4.2 s, 6 took 22 and 2.8 s, 3 took 24 and 2.0 s, 2 took 30
/// and 2.1 s. With a correction this good, a few cheap steps win.
const CPU_DEGREE: usize = 3;

/// The same on a GPU, where a step costs a fraction of the coarse solve
/// around it, so more of them, and fewer iterations, pay.
#[cfg(feature = "gpu")]
const GPU_DEGREE: usize = 8;

/// The grid, in nodes, from which the smoothing goes to a GPU. Below it the
/// CPU is as quick: the smoothing is a small part of a solve whose
/// assembly, coarse operator and recovery stay on the CPU, and opening the
/// GPU costs about a second. On the jet study (RTX 5080 Laptop GPU, 24
/// cores) the GPU lost at 99k nodes (4.0 s against 2.4 s) and won by 6% at
/// 486k (13.1 s against 13.9 s).
pub const GPU_FROM_NODES: usize = 400_000;

/// Start opening the GPU, in a build that has one, so it is ready when an
/// iterative solve asks for it.
pub fn warm_gpu() {
    #[cfg(feature = "gpu")]
    gpu::warm_up();
}

/// Whether this build has a GPU and the machine an adapter it can use.
/// Waits for [`warm_gpu`]'s opening if it is still going.
pub fn gpu_available() -> bool {
    #[cfg(feature = "gpu")]
    return gpu::available();
    #[cfg(not(feature = "gpu"))]
    false
}

/// Conjugate gradients preconditioned by one p-multigrid cycle.
pub struct PMultigridPcg {
    /// Each fine node as corners: itself for a corner, its edge's two for a
    /// mid-edge node.
    parents: Vec<[(u32, f64); 2]>,
    /// Fine node to corner number, for corners.
    corner_of: Vec<Option<u32>>,
    corners: usize,
    p: Option<Csr>,
    pt: Option<Csr>,
    a: Option<Csr>,
    inv_diag: Vec<f64>,
    lambda: (f64, f64),
    coarse: FaerLdlt,
    coarse_n: usize,
    factors: usize,
    iterations: Cell<usize>,
    /// Nonzeros of the coarse operator, for the note.
    coarse_nnz: usize,
    /// The grid, in nodes, from which to smooth on a GPU when one is there;
    /// `None`, never.
    gpu_from_nodes: Option<usize>,
    #[cfg(feature = "gpu")]
    gpu: Option<gpu::GpuSmoother>,
}

impl PMultigridPcg {
    /// The corner structure of a TET10 mesh.
    pub fn new(mesh: &Mesh) -> Result<Self, SimError> {
        let n = mesh.nodes.len();
        let mut corner_of: Vec<Option<u32>> = vec![None; n];
        let mut corners = 0u32;
        for cell in &mesh.elements {
            if cell.nodes.len() != 10 {
                return Err(SimError::new("A p-multigrid needs TET10 elements."));
            }
            for &node in &cell.nodes[..4] {
                if corner_of[node].is_none() {
                    corner_of[node] = Some(corners);
                    corners += 1;
                }
            }
        }
        let mut parents = vec![[(u32::MAX, 0.0); 2]; n];
        for (node, c) in corner_of.iter().enumerate() {
            if let Some(c) = c {
                parents[node] = [(*c, 1.0), (u32::MAX, 0.0)];
            }
        }
        for cell in &mesh.elements {
            for (slot, &(i, j)) in MID_EDGES.iter().enumerate() {
                let mid = cell.nodes[4 + slot];
                let (a, b) = (corner_of[cell.nodes[i]], corner_of[cell.nodes[j]]);
                if let (Some(a), Some(b)) = (a, b) {
                    parents[mid] = [(a, 0.5), (b, 0.5)];
                }
            }
        }
        if parents.iter().any(|p| p[0].0 == u32::MAX) {
            return Err(SimError::new("A node of the grid belongs to no tet."));
        }
        Ok(Self {
            parents,
            corner_of,
            corners: corners as usize,
            p: None,
            pt: None,
            a: None,
            inv_diag: Vec::new(),
            lambda: (0.0, 0.0),
            coarse: FaerLdlt::default(),
            coarse_n: 0,
            factors: 0,
            iterations: Cell::new(0),
            coarse_nnz: 0,
            gpu_from_nodes: None,
            #[cfg(feature = "gpu")]
            gpu: None,
        })
    }

    /// Smooth on a GPU from a grid of `from_nodes` nodes, when this build
    /// has wgpu and the machine an adapter that holds the fine matrix;
    /// otherwise, or with `None`, on the CPU.
    pub fn with_gpu(mut self, from_nodes: Option<usize>) -> Self {
        self.gpu_from_nodes = from_nodes;
        self
    }

    /// The GPU the smoothing ran on, if it did.
    pub fn gpu_name(&self) -> Option<&str> {
        #[cfg(feature = "gpu")]
        if let Some(gpu) = &self.gpu {
            return Some(&gpu.name);
        }
        None
    }

    /// `P K_c⁻¹ Pᵀ t`: a fine residual's correction through the corners.
    fn correction(&self, t: &[f64], e: &mut [f64]) -> Result<(), SimError> {
        let (p, pt) = (self.p.as_ref().unwrap(), self.pt.as_ref().unwrap());
        let mut rc = vec![0.0; self.coarse_n];
        pt.apply(t, &mut rc);
        let mut ec = vec![0.0; self.coarse_n];
        self.coarse.solve(&rc, &mut ec)?;
        p.apply(&ec, e);
        Ok(())
    }

    /// The map from coarse free dofs to fine free dofs. A corner's dof is
    /// free on the coarse grid when it is on the fine one.
    fn map(&self, fine: &DofMap) -> (Csr, usize) {
        let mut coarse_col: HashMap<(u32, usize), u32> = HashMap::new();
        let mut node_of_corner = vec![0usize; self.corners];
        for (node, c) in self.corner_of.iter().enumerate() {
            if let Some(c) = c {
                node_of_corner[*c as usize] = node;
            }
        }
        let mut nc = 0u32;
        for (c, &node) in node_of_corner.iter().enumerate() {
            for local in 0..3 {
                if fine.column(node, local).is_some() {
                    coarse_col.insert((c as u32, local), nc);
                    nc += 1;
                }
            }
        }
        let mut rows: Vec<Vec<(u32, f64)>> = vec![Vec::new(); fine.n_free];
        for (node, parents) in self.parents.iter().enumerate() {
            for local in 0..3 {
                let Some(row) = fine.column(node, local) else {
                    continue;
                };
                for &(corner, w) in parents {
                    if corner == u32::MAX {
                        continue;
                    }
                    if let Some(&col) = coarse_col.get(&(corner, local)) {
                        rows[row].push((col, w));
                    }
                }
            }
        }
        (csr_of_rows(rows), nc as usize)
    }

    /// `z = M⁻¹ r`: smooth, correct through the corners, smooth again.
    fn cycle(&self, r: &[f64], z: &mut [f64]) -> Result<(), SimError> {
        #[cfg(feature = "gpu")]
        if let Some(gpu) = &self.gpu {
            return gpu.cycle(r, z, |t| {
                let mut e = vec![0.0; t.len()];
                self.correction(t, &mut e)?;
                Ok(e)
            });
        }
        let a = self.a.as_ref().unwrap();
        let n = r.len();
        let mut scratch = vec![0.0; n];
        let mut e = vec![0.0; n];
        z.iter_mut().for_each(|v| *v = 0.0);
        chebyshev(a, &self.inv_diag, self.lambda, CPU_DEGREE, r, z, &mut scratch, true);
        a.apply(z, &mut scratch);
        scratch.par_iter_mut().zip(r).for_each(|(t, r)| *t = r - *t);
        self.correction(&scratch, &mut e)?;
        z.par_iter_mut().zip(e.par_iter()).for_each(|(z, e)| *z += e);
        chebyshev(a, &self.inv_diag, self.lambda, CPU_DEGREE, r, z, &mut scratch, false);
        Ok(())
    }

    pub fn iterations(&self) -> usize {
        self.iterations.get()
    }

    /// Nonzeros of the corners' operator (upper triangle) and its free dofs.
    pub fn coarse_size(&self) -> (usize, usize) {
        (self.coarse_nnz, self.coarse_n)
    }
}

/// Rows of `(column, value)` pairs, each sorted by column, as CSR.
fn csr_of_rows(rows: Vec<Vec<(u32, f64)>>) -> Csr {
    let mut row_ptr = Vec::with_capacity(rows.len() + 1);
    row_ptr.push(0);
    let total: usize = rows.iter().map(Vec::len).sum();
    let (mut cols, mut vals) = (Vec::with_capacity(total), Vec::with_capacity(total));
    for mut row in rows {
        row.sort_unstable_by_key(|e| e.0);
        for (c, v) in row {
            cols.push(c);
            vals.push(v);
        }
        row_ptr.push(cols.len());
    }
    Csr {
        nrows: row_ptr.len() - 1,
        row_ptr,
        cols,
        vals,
    }
}

/// `Mᵀ` of an `nrows × ncols` CSR.
fn transpose(m: &Csr, ncols: usize) -> Csr {
    let mut rows: Vec<Vec<(u32, f64)>> = vec![Vec::new(); ncols];
    for i in 0..m.nrows {
        for k in m.row_ptr[i]..m.row_ptr[i + 1] {
            rows[m.cols[k] as usize].push((i as u32, m.vals[k]));
        }
    }
    csr_of_rows(rows)
}

/// The upper triangle of `PᵀAP` as triplets: each coarse row summed from
/// the fine rows its column of `P` touches, through `AP` built row by row.
fn galerkin(a: &Csr, p: &Csr, pt: &Csr, nc: usize) -> Vec<(usize, usize, f64)> {
    // AP, a row per fine row.
    let ap_rows: Vec<Vec<(u32, f64)>> = (0..a.nrows)
        .into_par_iter()
        .map(|i| {
            let mut row: Vec<(u32, f64)> = Vec::with_capacity(160);
            for k in a.row_ptr[i]..a.row_ptr[i + 1] {
                let (j, v) = (a.cols[k] as usize, a.vals[k]);
                for q in p.row_ptr[j]..p.row_ptr[j + 1] {
                    row.push((p.cols[q], v * p.vals[q]));
                }
            }
            merge(&mut row);
            row
        })
        .collect();
    // Pᵀ(AP), a row per coarse row; only the upper triangle is kept.
    let rows: Vec<Vec<(u32, f64)>> = (0..nc)
        .into_par_iter()
        .map(|c| {
            let mut row: Vec<(u32, f64)> = Vec::with_capacity(256);
            for k in pt.row_ptr[c]..pt.row_ptr[c + 1] {
                let (i, w) = (pt.cols[k] as usize, pt.vals[k]);
                for &(cc, v) in &ap_rows[i] {
                    if cc as usize >= c {
                        row.push((cc, w * v));
                    }
                }
            }
            merge(&mut row);
            row
        })
        .collect();
    let mut out = Vec::with_capacity(rows.iter().map(Vec::len).sum());
    for (c, row) in rows.into_iter().enumerate() {
        for (cc, v) in row {
            out.push((c, cc as usize, v));
        }
    }
    out
}

/// Sort by column and sum repeats, in place.
fn merge(row: &mut Vec<(u32, f64)>) {
    row.sort_unstable_by_key(|e| e.0);
    let mut out = 0;
    for k in 0..row.len() {
        if out > 0 && row[out - 1].0 == row[k].0 {
            row[out - 1].1 += row[k].1;
        } else {
            row[out] = row[k];
            out += 1;
        }
    }
    row.truncate(out);
}

impl LinearSolver for PMultigridPcg {
    fn attach_dofs(&mut self, dof: &DofMap) {
        let (p, nc) = self.map(dof);
        self.pt = Some(transpose(&p, nc));
        self.p = Some(p);
        self.coarse_n = nc;
    }

    fn factor(&mut self, triplets: &[(usize, usize, f64)], n: usize) -> Result<(), SimError> {
        self.factors += 1;
        let (Some(p), Some(pt)) = (&self.p, &self.pt) else {
            return Err(SimError::new("The multigrid has no dof map for its grid."));
        };
        let a = Csr::from_upper(triplets, n);
        let diag = a.diagonal();
        if diag.iter().any(|d| d.is_nan() || *d <= 0.0) {
            return Err(crate::error::not_held());
        }
        self.inv_diag = diag.iter().map(|d| 1.0 / d).collect();
        let hi = 1.1 * largest_eigenvalue(&a, &self.inv_diag);
        self.lambda = (hi / CHEBYSHEV_RATIO, hi);
        let coarse = galerkin(&a, p, pt, self.coarse_n);
        self.coarse_nnz = coarse.len();
        self.coarse = FaerLdlt::default();
        self.coarse.factor(&coarse, self.coarse_n)?;
        drop(coarse);
        #[cfg(feature = "gpu")]
        {
            self.gpu = None;
            if self.gpu_from_nodes.is_some_and(|from| n >= 3 * from) {
                self.gpu = gpu::GpuSmoother::new(&a, &self.inv_diag, self.lambda, GPU_DEGREE);
            }
        }
        self.a = Some(a);
        Ok(())
    }

    fn solve(&self, b: &[f64], x: &mut [f64]) -> Result<(), SimError> {
        let a = self
            .a
            .as_ref()
            .ok_or_else(|| SimError::new("The matrix has not been factored."))?;
        let (iterations, _) = pcg(a, b, x, |r, z| self.cycle(r, z))?;
        self.iterations.set(iterations);
        Ok(())
    }

    fn factor_count(&self) -> usize {
        self.factors
    }

    fn pivots(&self) -> Option<f64> {
        // The corner grid's factor reads the part's holds as well as the
        // fine one would: a part that isn't held is singular on both.
        self.coarse.pivots()
    }

    fn factor_len(&self) -> usize {
        self.coarse.factor_len()
    }

    fn notes(&self) -> Vec<String> {
        let on = self
            .gpu_name()
            .map(|name| format!(", smoothed on the GPU ({name})"))
            .unwrap_or_default();
        vec![format!(
            "solved iteratively by p-multigrid{on}: {} iterations",
            self.iterations.get()
        )]
    }
}
