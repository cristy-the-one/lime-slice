//! An iterative solve of a fine sliced grid, preconditioned by a coarser
//! grid's direct factor.
//!
//! A sliced study solves its first cell size directly. Its second, finer
//! size only judges trust, and a direct factor of it may not fit in memory:
//! the factor's fill grows faster than the nodes. This solves the finer grid
//! by conjugate gradients instead. Its memory is the fine matrix and a few
//! vectors, linear in the nodes, and the factor it leans on already exists.
//!
//! The preconditioner is one symmetric two-grid cycle: Chebyshev smoothing
//! on the fine matrix, a correction through the coarse grid's LDLᵀ, and the
//! same smoothing again. The two grids don't nest (the finer cell is √2
//! smaller), so the coarse-to-fine map interpolates each fine node from the
//! coarse TET10 that holds it, or the nearest one where the fine staircase
//! steps outside the coarse one.

use std::cell::Cell;
use std::collections::HashMap;

use rayon::prelude::*;

use crate::assemble::DofMap;
use crate::element::tet10_shape;
use crate::error::SimError;
use crate::sliced::SlicedMesh;
use crate::solve::{FaerLdlt, LinearSolver};

#[cfg(feature = "gpu")]
mod gpu;

/// Each fine node as a weighted sum of coarse nodes: TET10 shape functions
/// at the fine node's place in a coarse tet.
pub struct Prolongation {
    /// Row `f` is `start[f]..start[f + 1]` of `coarse` and `weight`.
    start: Vec<usize>,
    coarse: Vec<u32>,
    weight: Vec<f64>,
    /// Fine nodes that no coarse cell nearby holds: they get no coarse
    /// correction, only smoothing.
    pub unplaced: usize,
}

impl Prolongation {
    /// Place every node of `fine` in `coarse`. Both grids are in the same
    /// slice frame, as two grids of one slice field are.
    pub fn new(coarse: &SlicedMesh, fine: &SlicedMesh) -> Self {
        let mut first_tet: HashMap<(u32, u32, u32), usize> = HashMap::new();
        for (e, key) in coarse.cell_of.iter().enumerate() {
            first_tet.entry(*key).or_insert(e);
        }
        let nodes = &coarse.mesh.nodes;
        let elements = &coarse.mesh.elements;
        let slab_of = |z: f64| -> i64 {
            let i = coarse.slabs.partition_point(|s| s[1] < z);
            i.min(coarse.slabs.len().saturating_sub(1)) as i64
        };
        // The fine node's barycentric coordinates in a tet's corners, and the
        // smallest of them: at or above zero, the tet holds the node.
        let locate = |p: [f64; 3], e: usize| -> ([f64; 4], f64) {
            let c = &elements[e].nodes;
            let (a, b, cc, d) = (nodes[c[0]], nodes[c[1]], nodes[c[2]], nodes[c[3]]);
            let col = |q: [f64; 3]| [q[0] - a[0], q[1] - a[1], q[2] - a[2]];
            let (u, v, w, r) = (col(b), col(cc), col(d), col(p));
            let det = u[0] * (v[1] * w[2] - v[2] * w[1]) - v[0] * (u[1] * w[2] - u[2] * w[1])
                + w[0] * (u[1] * v[2] - u[2] * v[1]);
            if det.abs() < 1e-300 {
                return ([0.25; 4], f64::NEG_INFINITY);
            }
            // Cramer's rule for r = l2·u + l3·v + l4·w.
            let solve = |x: [f64; 3], y: [f64; 3], z: [f64; 3]| {
                (x[0] * (y[1] * z[2] - y[2] * z[1]) - y[0] * (x[1] * z[2] - x[2] * z[1])
                    + z[0] * (x[1] * y[2] - x[2] * y[1]))
                    / det
            };
            let l2 = solve(r, v, w);
            let l3 = solve(u, r, w);
            let l4 = solve(u, v, r);
            let l = [1.0 - l2 - l3 - l4, l2, l3, l4];
            (l, l.iter().copied().fold(f64::INFINITY, f64::min))
        };
        let mut start = Vec::with_capacity(fine.mesh.nodes.len() + 1);
        let mut coarse_of = Vec::new();
        let mut weight = Vec::new();
        let mut unplaced = 0;
        start.push(0);
        for &p in &fine.mesh.nodes {
            let i = ((p[0] - coarse.origin[0]) / coarse.h_xy).floor() as i64;
            let j = ((p[1] - coarse.origin[1]) / coarse.h_xy).floor() as i64;
            let k = slab_of(p[2]);
            let mut best: Option<(usize, [f64; 4], f64)> = None;
            // The cell the node falls in, then its neighbours, out to two
            // cells: a staircase can leave a fine node beside the coarse part.
            'search: for reach in 0..=2i64 {
                for dk in -reach..=reach {
                    for dj in -reach..=reach {
                        for di in -reach..=reach {
                            if di.abs().max(dj.abs()).max(dk.abs()) != reach {
                                continue;
                            }
                            let (a, b, c) = (i + di, j + dj, k + dk);
                            if a < 0 || b < 0 || c < 0 {
                                continue;
                            }
                            let Some(&e0) = first_tet.get(&(a as u32, b as u32, c as u32)) else {
                                continue;
                            };
                            for e in e0..(e0 + 6).min(elements.len()) {
                                if coarse.cell_of[e] != (a as u32, b as u32, c as u32) {
                                    break;
                                }
                                let (l, worst) = locate(p, e);
                                if best.as_ref().is_none_or(|b| worst > b.2) {
                                    best = Some((e, l, worst));
                                }
                            }
                        }
                    }
                }
                if best.as_ref().is_some_and(|b| b.2 >= -1e-9) {
                    break 'search;
                }
                if best.is_some() && reach >= 1 {
                    break 'search;
                }
            }
            if let Some((e, l, _)) = best {
                // Outside the tet, clamp to its nearest face and interpolate
                // there rather than extrapolate.
                let mut l = l.map(|v| v.max(0.0));
                let sum: f64 = l.iter().sum();
                for v in &mut l {
                    *v /= sum;
                }
                let shape = tet10_shape([l[1], l[2], l[3]]);
                for (node, n) in elements[e].nodes.iter().zip(shape.n) {
                    if n.abs() > 1e-14 {
                        coarse_of.push(*node as u32);
                        weight.push(n);
                    }
                }
            } else {
                unplaced += 1;
            }
            start.push(coarse_of.len());
        }
        Self {
            start,
            coarse: coarse_of,
            weight,
            unplaced,
        }
    }

    /// The dof-level map: a row per fine free dof, a column per coarse free
    /// dof. A sliced grid holds whole nodes, so a node's three dofs share
    /// one weight and a held node has none.
    fn dofs(&self, fine: &DofMap, coarse: &DofMap) -> Csr {
        let mut row_ptr = vec![0usize; fine.n_free + 1];
        let mut cols = Vec::new();
        let mut vals = Vec::new();
        let mut rows: Vec<(usize, Vec<(u32, f64)>)> = Vec::with_capacity(fine.n_free);
        for f in 0..self.start.len() - 1 {
            for local in 0..3 {
                let Some(row) = fine.column(f, local) else {
                    continue;
                };
                let mut entries = Vec::with_capacity(10);
                for at in self.start[f]..self.start[f + 1] {
                    if let Some(col) = coarse.column(self.coarse[at] as usize, local) {
                        entries.push((col as u32, self.weight[at]));
                    }
                }
                rows.push((row, entries));
            }
        }
        rows.sort_unstable_by_key(|r| r.0);
        for (row, entries) in rows {
            row_ptr[row + 1] = entries.len();
            for (c, v) in entries {
                cols.push(c);
                vals.push(v);
            }
        }
        for r in 0..fine.n_free {
            row_ptr[r + 1] += row_ptr[r];
        }
        Csr {
            nrows: fine.n_free,
            row_ptr,
            cols,
            vals,
        }
    }
}

/// A row-major sparse matrix with both triangles stored, so a product runs
/// a row per task.
struct Csr {
    nrows: usize,
    row_ptr: Vec<usize>,
    cols: Vec<u32>,
    vals: Vec<f64>,
}

impl Csr {
    /// The full symmetric matrix from the assembler's upper-triangle
    /// triplets, duplicates summed.
    fn from_upper(triplets: &[(usize, usize, f64)], n: usize) -> Self {
        let mut count = vec![0usize; n + 1];
        for &(r, c, _) in triplets {
            count[r + 1] += 1;
            if r != c {
                count[c + 1] += 1;
            }
        }
        for i in 0..n {
            count[i + 1] += count[i];
        }
        let mut next = count.clone();
        let total = count[n];
        let mut cols = vec![0u32; total];
        let mut vals = vec![0.0; total];
        for &(r, c, v) in triplets {
            cols[next[r]] = c as u32;
            vals[next[r]] = v;
            next[r] += 1;
            if r != c {
                cols[next[c]] = r as u32;
                vals[next[c]] = v;
                next[c] += 1;
            }
        }
        // Sort each row and sum its duplicates in place, then close the gaps.
        let mut kept = vec![0usize; n];
        {
            let mut rows: Vec<(&mut [u32], &mut [f64])> = Vec::with_capacity(n);
            let (mut c_rest, mut v_rest) = (cols.as_mut_slice(), vals.as_mut_slice());
            for i in 0..n {
                let len = count[i + 1] - count[i];
                let (c, cr) = c_rest.split_at_mut(len);
                let (v, vr) = v_rest.split_at_mut(len);
                rows.push((c, v));
                c_rest = cr;
                v_rest = vr;
            }
            rows.into_par_iter()
                .zip(kept.par_iter_mut())
                .for_each(|((c, v), kept)| {
                    let mut pairs: Vec<(u32, f64)> =
                        c.iter().copied().zip(v.iter().copied()).collect();
                    pairs.sort_unstable_by_key(|p| p.0);
                    let mut out = 0;
                    for (col, val) in pairs {
                        if out > 0 && c[out - 1] == col {
                            v[out - 1] += val;
                        } else {
                            c[out] = col;
                            v[out] = val;
                            out += 1;
                        }
                    }
                    *kept = out;
                });
        }
        let mut row_ptr = vec![0usize; n + 1];
        let mut write = 0;
        for i in 0..n {
            let from = count[i];
            for k in 0..kept[i] {
                cols[write + k] = cols[from + k];
                vals[write + k] = vals[from + k];
            }
            write += kept[i];
            row_ptr[i + 1] = write;
        }
        cols.truncate(write);
        vals.truncate(write);
        cols.shrink_to_fit();
        vals.shrink_to_fit();
        Self {
            nrows: n,
            row_ptr,
            cols,
            vals,
        }
    }

    /// `y = A x`.
    fn apply(&self, x: &[f64], y: &mut [f64]) {
        y.par_iter_mut().enumerate().for_each(|(i, out)| {
            let mut sum = 0.0;
            for k in self.row_ptr[i]..self.row_ptr[i + 1] {
                sum += self.vals[k] * x[self.cols[k] as usize];
            }
            *out = sum;
        });
    }

    /// `y = Aᵀ x`, for a map that isn't square.
    fn apply_transpose(&self, x: &[f64], y: &mut [f64]) {
        y.iter_mut().for_each(|v| *v = 0.0);
        for i in 0..self.nrows {
            let xi = x[i];
            if xi == 0.0 {
                continue;
            }
            for k in self.row_ptr[i]..self.row_ptr[i + 1] {
                y[self.cols[k] as usize] += self.vals[k] * xi;
            }
        }
    }

    fn diagonal(&self) -> Vec<f64> {
        (0..self.nrows)
            .map(|i| {
                (self.row_ptr[i]..self.row_ptr[i + 1])
                    .find(|&k| self.cols[k] as usize == i)
                    .map_or(0.0, |k| self.vals[k])
            })
            .collect()
    }
}

/// The relative residual the iterative solve stops at. The driver refuses
/// a solve whose residual is past 1e-6, so this leaves it room.
const TOLERANCE: f64 = 1e-8;

/// The most iterations before the solve gives up and says so.
const MAX_ITERATIONS: usize = 300;

/// The smoothing damps `D⁻¹A`'s spectrum from its top down to the top over
/// this; below it is the coarse grid's. 30 took 38 iterations on the jet
/// study where 10 took 47 and 100 took 51.
const CHEBYSHEV_RATIO: f64 = 30.0;

/// Chebyshev smoothing steps before and after the coarse correction. On the
/// jet study's 217k-node grid: degree 2 took 359 iterations, 4 took 144, 8
/// took 46, 12 took 38 and 16 took 35, at about one fine product a step
/// against a coarse solve of 0.14 s an iteration. Twelve is where more
/// smoothing stops paying.
const SMOOTHING_DEGREE: usize = 12;

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

/// Conjugate gradients on the fine grid, preconditioned by one two-grid
/// cycle through a coarse grid's direct factor.
pub struct TwoLevelPcg {
    coarse: FaerLdlt,
    links: Prolongation,
    p: Option<Csr>,
    a: Option<Csr>,
    inv_diag: Vec<f64>,
    /// The Chebyshev interval of `D⁻¹A`: the high part it damps.
    lambda: (f64, f64),
    factors: usize,
    iterations: Cell<usize>,
    residual: Cell<f64>,
    /// Whether to smooth on a GPU when one is there.
    use_gpu: bool,
    #[cfg(feature = "gpu")]
    gpu: Option<gpu::GpuSmoother>,
}

impl TwoLevelPcg {
    /// `coarse` has factored the coarse grid and holds its dof map.
    pub fn new(coarse: FaerLdlt, links: Prolongation) -> Self {
        Self {
            coarse,
            links,
            p: None,
            a: None,
            inv_diag: Vec::new(),
            lambda: (0.0, 0.0),
            factors: 0,
            iterations: Cell::new(0),
            residual: Cell::new(f64::NAN),
            use_gpu: false,
            #[cfg(feature = "gpu")]
            gpu: None,
        }
    }

    /// Smooth on a GPU when this build has wgpu and the machine an adapter
    /// that holds the fine matrix; otherwise on the CPU.
    pub fn with_gpu(mut self, use_gpu: bool) -> Self {
        self.use_gpu = use_gpu;
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

    /// Iterations of the last solve.
    pub fn iterations(&self) -> usize {
        self.iterations.get()
    }

    /// `x ← x + p(D⁻¹A) D⁻¹ (b − A x)`: Chebyshev smoothing of `A x = b`.
    fn smooth(&self, a: &Csr, b: &[f64], x: &mut [f64], scratch: &mut [f64], start_zero: bool) {
        let (lo, hi) = self.lambda;
        let theta = 0.5 * (hi + lo);
        let delta = 0.5 * (hi - lo);
        let sigma = theta / delta;
        let mut rho = 1.0 / sigma;
        let n = b.len();
        let mut d = vec![0.0; n];
        if start_zero {
            scratch.copy_from_slice(b);
        } else {
            a.apply(x, scratch);
            scratch.par_iter_mut().zip(b).for_each(|(r, b)| *r = b - *r);
        }
        d.par_iter_mut()
            .zip(scratch.par_iter())
            .zip(self.inv_diag.par_iter())
            .for_each(|((d, r), w)| *d = r * w / theta);
        for step in 0..SMOOTHING_DEGREE {
            x.par_iter_mut().zip(d.par_iter()).for_each(|(x, d)| *x += d);
            if step + 1 == SMOOTHING_DEGREE {
                break;
            }
            a.apply(x, scratch);
            let rho_next = 1.0 / (2.0 * sigma - rho);
            let (keep, push) = (rho_next * rho, 2.0 * rho_next / delta);
            d.par_iter_mut()
                .zip(scratch.par_iter())
                .zip(b.par_iter())
                .zip(self.inv_diag.par_iter())
                .for_each(|(((d, ax), b), w)| *d = keep * *d + push * (b - ax) * w);
            rho = rho_next;
        }
    }

    /// `z = M⁻¹ r`: smooth, correct through the coarse factor, smooth.
    fn precondition(&self, r: &[f64], z: &mut [f64]) -> Result<(), SimError> {
        #[cfg(feature = "gpu")]
        if let Some(gpu) = &self.gpu {
            return gpu.cycle(r, z, |residual| self.coarse_correction(residual));
        }
        let (a, p) = (self.a.as_ref().unwrap(), self.p.as_ref().unwrap());
        let n = r.len();
        let mut scratch = vec![0.0; n];
        z.iter_mut().for_each(|v| *v = 0.0);
        self.smooth(a, r, z, &mut scratch, true);
        a.apply(z, &mut scratch);
        scratch.par_iter_mut().zip(r).for_each(|(t, r)| *t = r - *t);
        let nc = p.cols.iter().map(|&c| c as usize + 1).max().unwrap_or(0);
        let nc = nc.max(self.coarse_n());
        let mut rc = vec![0.0; nc];
        p.apply_transpose(&scratch, &mut rc);
        let mut ec = vec![0.0; nc];
        self.coarse.solve(&rc, &mut ec)?;
        p.apply(&ec, &mut scratch);
        z.par_iter_mut().zip(scratch.par_iter()).for_each(|(z, e)| *z += e);
        self.smooth(a, r, z, &mut scratch, false);
        Ok(())
    }

    /// `P K_c⁻¹ Pᵀ t`: a fine residual's correction through the coarse grid.
    #[cfg(feature = "gpu")]
    fn coarse_correction(&self, t: &[f64]) -> Result<Vec<f64>, SimError> {
        let p = self.p.as_ref().unwrap();
        let nc = self.coarse_n();
        let mut rc = vec![0.0; nc];
        p.apply_transpose(t, &mut rc);
        let mut ec = vec![0.0; nc];
        self.coarse.solve(&rc, &mut ec)?;
        let mut e = vec![0.0; t.len()];
        p.apply(&ec, &mut e);
        Ok(e)
    }

    fn coarse_n(&self) -> usize {
        self.coarse.dofs().map_or(0, |d| d.n_free)
    }

    /// The largest eigenvalue of `D⁻¹A`, by a few power steps.
    fn largest_eigenvalue(a: &Csr, inv_diag: &[f64]) -> f64 {
        let n = a.nrows;
        let mut v: Vec<f64> = (0..n).map(|i| 1.0 + ((i * 7919) % 13) as f64 / 13.0).collect();
        let mut w = vec![0.0; n];
        let mut lambda = 1.0;
        for _ in 0..15 {
            let norm = v.par_iter().map(|x| x * x).sum::<f64>().sqrt();
            v.par_iter_mut().for_each(|x| *x /= norm);
            a.apply(&v, &mut w);
            w.par_iter_mut().zip(inv_diag).for_each(|(w, d)| *w *= d);
            lambda = v.par_iter().zip(&w).map(|(v, w)| v * w).sum::<f64>();
            std::mem::swap(&mut v, &mut w);
        }
        lambda
    }
}

fn dot(a: &[f64], b: &[f64]) -> f64 {
    a.par_iter().zip(b).map(|(a, b)| a * b).sum()
}

impl LinearSolver for TwoLevelPcg {
    fn attach_dofs(&mut self, dof: &DofMap) {
        if let Some(coarse) = self.coarse.dofs() {
            self.p = Some(self.links.dofs(dof, coarse));
        }
    }

    fn factor(&mut self, triplets: &[(usize, usize, f64)], n: usize) -> Result<(), SimError> {
        self.factors += 1;
        if self.p.is_none() {
            return Err(SimError::new(
                "The coarse grid has no dof map to correct the finer one with.",
            ));
        }
        let a = Csr::from_upper(triplets, n);
        let diag = a.diagonal();
        if diag.iter().any(|d| d.is_nan() || *d <= 0.0) {
            return Err(crate::error::not_held());
        }
        self.inv_diag = diag.iter().map(|d| 1.0 / d).collect();
        // Smooth the top of the spectrum; leave the bottom to the coarse grid.
        let hi = 1.1 * Self::largest_eigenvalue(&a, &self.inv_diag);
        self.lambda = (hi / CHEBYSHEV_RATIO, hi);
        #[cfg(feature = "gpu")]
        {
            self.gpu = None;
            if self.use_gpu {
                self.gpu = gpu::GpuSmoother::new(&a, &self.inv_diag, self.lambda);
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
        let n = b.len();
        x.iter_mut().for_each(|v| *v = 0.0);
        let b_norm = dot(b, b).sqrt();
        if b_norm == 0.0 {
            self.iterations.set(0);
            self.residual.set(0.0);
            return Ok(());
        }
        let mut r = b.to_vec();
        let mut z = vec![0.0; n];
        self.precondition(&r, &mut z)?;
        let mut p = z.clone();
        let mut z_last = z.clone();
        let mut ap = vec![0.0; n];
        let mut rz = dot(&r, &z);
        for it in 1..=MAX_ITERATIONS {
            a.apply(&p, &mut ap);
            let pap = dot(&p, &ap);
            if pap.is_nan() || pap <= 0.0 {
                return Err(crate::error::not_held());
            }
            let alpha = rz / pap;
            x.par_iter_mut().zip(p.par_iter()).for_each(|(x, p)| *x += alpha * p);
            r.par_iter_mut().zip(ap.par_iter()).for_each(|(r, ap)| *r -= alpha * ap);
            let rel = dot(&r, &r).sqrt() / b_norm;
            if rel < TOLERANCE {
                self.iterations.set(it);
                self.residual.set(rel);
                return Ok(());
            }
            self.precondition(&r, &mut z)?;
            // Flexible: β from the change in z, so a preconditioner that
            // rounds differently each time (the GPU's f32) keeps converging.
            let rz_next = dot(&r, &z);
            let r_dz = r.par_iter().zip(&z).zip(&z_last).map(|((r, z), l)| r * (z - l)).sum::<f64>();
            let beta = r_dz / rz;
            rz = rz_next;
            z_last.copy_from_slice(&z);
            p.par_iter_mut().zip(z.par_iter()).for_each(|(p, z)| *p = z + beta * *p);
        }
        Err(SimError::new(format!(
            "The iterative solve did not converge in {MAX_ITERATIONS} iterations."
        )))
    }

    fn factor_count(&self) -> usize {
        self.factors
    }

    fn pivots(&self) -> Option<f64> {
        None
    }

    fn notes(&self) -> Vec<String> {
        let on = self
            .gpu_name()
            .map(|name| format!(", smoothed on the GPU ({name})"))
            .unwrap_or_default();
        vec![format!(
            "The finer cell size was solved iteratively, preconditioned by the first{on}: {} iterations.",
            self.iterations.get()
        )]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Upper triplets with a repeated entry give the full symmetric matrix,
    /// the repeat summed, and its product matches the dense one.
    #[test]
    fn the_matrix_is_both_triangles_with_repeats_summed() {
        let t = [
            (0, 0, 4.0),
            (0, 1, 1.0),
            (1, 1, 3.0),
            (0, 1, 0.5),
            (1, 2, -1.0),
            (2, 2, 5.0),
        ];
        let a = Csr::from_upper(&t, 3);
        let dense = [[4.0, 1.5, 0.0], [1.5, 3.0, -1.0], [0.0, -1.0, 5.0]];
        let x = [1.0, -2.0, 3.0];
        let mut y = [0.0; 3];
        a.apply(&x, &mut y);
        for i in 0..3 {
            let want: f64 = (0..3).map(|j| dense[i][j] * x[j]).sum();
            assert!((y[i] - want).abs() < 1e-12, "row {i}: {} against {want}", y[i]);
        }
        assert_eq!(a.diagonal(), vec![4.0, 3.0, 5.0]);
        assert_eq!(a.vals.len(), 7);
    }
}
