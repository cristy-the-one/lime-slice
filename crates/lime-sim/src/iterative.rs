//! The parts of an iterative solve: a sparse matrix a row per task,
//! Chebyshev smoothing, and flexible conjugate gradients.
//!
//! `multigrid` builds its preconditioner from these.

use rayon::prelude::*;

use crate::error::SimError;

/// A row-major sparse matrix with both triangles stored, so a product runs
/// a row per task.
pub(crate) struct Csr {
    pub(crate) nrows: usize,
    pub(crate) row_ptr: Vec<usize>,
    pub(crate) cols: Vec<u32>,
    pub(crate) vals: Vec<f64>,
}

impl Csr {
    /// The full symmetric matrix from the assembler's upper-triangle
    /// triplets, duplicates summed.
    pub(crate) fn from_upper(triplets: &[(usize, usize, f64)], n: usize) -> Self {
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
    pub(crate) fn apply(&self, x: &[f64], y: &mut [f64]) {
        y.par_iter_mut().enumerate().for_each(|(i, out)| {
            let mut sum = 0.0;
            for k in self.row_ptr[i]..self.row_ptr[i + 1] {
                sum += self.vals[k] * x[self.cols[k] as usize];
            }
            *out = sum;
        });
    }

    pub(crate) fn diagonal(&self) -> Vec<f64> {
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
pub(crate) const TOLERANCE: f64 = 1e-8;

/// The most iterations before the solve gives up and says so.
pub(crate) const MAX_ITERATIONS: usize = 300;

/// The smoothing damps `D⁻¹A`'s spectrum from its top down to the top over
/// this; below it is the coarse correction's.
pub(crate) const CHEBYSHEV_RATIO: f64 = 30.0;

/// The largest eigenvalue of `D⁻¹A`, by a few power steps.
pub(crate) fn largest_eigenvalue(a: &Csr, inv_diag: &[f64]) -> f64 {
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


/// `x ← x + p(D⁻¹A) D⁻¹ (b − A x)`: Chebyshev smoothing of `A x = b`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn chebyshev(
    a: &Csr,
    inv_diag: &[f64],
    lambda: (f64, f64),
    degree: usize,
    b: &[f64],
    x: &mut [f64],
    scratch: &mut [f64],
    start_zero: bool,
) {
    let (lo, hi) = lambda;
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
        .zip(inv_diag.par_iter())
        .for_each(|((d, r), w)| *d = r * w / theta);
    for step in 0..degree {
        x.par_iter_mut().zip(d.par_iter()).for_each(|(x, d)| *x += d);
        if step + 1 == degree {
            break;
        }
        a.apply(x, scratch);
        let rho_next = 1.0 / (2.0 * sigma - rho);
        let (keep, push) = (rho_next * rho, 2.0 * rho_next / delta);
        d.par_iter_mut()
            .zip(scratch.par_iter())
            .zip(b.par_iter())
            .zip(inv_diag.par_iter())
            .for_each(|(((d, ax), b), w)| *d = keep * *d + push * (b - ax) * w);
        rho = rho_next;
    }
}

/// Flexible preconditioned conjugate gradients on `A x = b` from zero, to a
/// relative residual of [`TOLERANCE`]: the iterations and the residual.
/// Flexible: β from the change in z, so a preconditioner that rounds
/// differently each time (a GPU's f32) keeps converging.
pub(crate) fn pcg(
    a: &Csr,
    b: &[f64],
    x: &mut [f64],
    precondition: impl Fn(&[f64], &mut [f64]) -> Result<(), SimError>,
) -> Result<(usize, f64), SimError> {
    let n = b.len();
    x.iter_mut().for_each(|v| *v = 0.0);
    let b_norm = dot(b, b).sqrt();
    if b_norm == 0.0 {
        return Ok((0, 0.0));
    }
    let mut r = b.to_vec();
    let mut z = vec![0.0; n];
    precondition(&r, &mut z)?;
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
            return Ok((it, rel));
        }
        precondition(&r, &mut z)?;
        let rz_next = dot(&r, &z);
        let r_dz = r
            .par_iter()
            .zip(&z)
            .zip(&z_last)
            .map(|((r, z), l)| r * (z - l))
            .sum::<f64>();
        let beta = r_dz / rz;
        rz = rz_next;
        z_last.copy_from_slice(&z);
        p.par_iter_mut().zip(z.par_iter()).for_each(|(p, z)| *p = z + beta * *p);
    }
    Err(SimError::new(format!(
        "The iterative solve did not converge in {MAX_ITERATIONS} iterations."
    )))
}

pub(crate) fn dot(a: &[f64], b: &[f64]) -> f64 {
    a.par_iter().zip(b).map(|(a, b)| a * b).sum()
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
