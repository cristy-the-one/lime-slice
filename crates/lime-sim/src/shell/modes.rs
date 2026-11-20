//! The lowest natural frequencies of a shell.
//!
//! faer 0.24 has no sparse generalised eigensolver. The operator is
//! K⁻¹ M, applied with the static LDLᵀ already factored for a load case,
//! and [`faer::matrix_free::eigen::partial_eigen`] (Krylov–Schur, largest
//! magnitude). K⁻¹ M is self-adjoint in the M inner product, not the
//! Euclidean one, so `partial_self_adjoint_eigen` does not apply.
//!
//! Rotational dofs carry no mass, so their eigenvalues of K⁻¹ M are zero and
//! a largest-magnitude solve never returns them. What comes back is a
//! bending mode. The reported frequency is the Rayleigh quotient
//! vᵀ K v / vᵀ M v, not the raw Ritz value.

use std::time::Instant;

use faer::dyn_stack::{MemBuffer, MemStack};
use faer::matrix_free::eigen::{partial_eigen, partial_eigen_scratch, PartialEigenParams};
use faer::matrix_free::LinOp;
use faer::sparse::linalg::cholesky::SymbolicCholesky;
use faer::{c64, Mat, MatMut, MatRef, Par};

use super::sparse::{solve_in_place, Factor, Pattern};
use crate::error::SimError;

/// ω² within this relative gap of the lowest belong to one cluster.
///
/// A simply supported square splits its analytic pair by 0.72 % on a
/// 12 × 12 mesh, and a clamped square by 0.20 % on 32 × 32 (Leissa's
/// repeated λ₂ = λ₃ = 73.41). The next distinct rectangle mode sits at
/// about 1.60× the first, so 2 % gathers those splits and not the next
/// mode.
pub const CLUSTER_GAP: f64 = 0.02;

/// One mode: Rayleigh frequency and the free-dof shape (shell dofs, then
/// web rotations).
#[derive(Clone, Debug)]
pub struct ShellMode {
    /// vᵀ K v / vᵀ M v, rad²/s².
    pub omega2: f64,
    /// ω / 2π.
    pub hz: f64,
    pub vector: Vec<f64>,
}

/// The modes [`crate::shell::ShellModel::lowest_modes`] asked for, lowest
/// first, and how long the Krylov–Schur iteration took.
#[derive(Clone, Debug)]
pub struct ModeSet {
    pub modes: Vec<ShellMode>,
    pub seconds: f64,
}

/// How many leading ω² values, already lowest-first, sit in the cluster.
pub fn cluster_count(omega2: &[f64]) -> usize {
    let Some(&w0) = omega2.first() else {
        return 0;
    };
    if !(w0.is_finite() && w0 > 0.0) {
        return 1.min(omega2.len());
    }
    let mut n = 1;
    while n < omega2.len() && (omega2[n] - w0).abs() <= CLUSTER_GAP * w0 {
        n += 1;
    }
    n
}

/// The smaller generalised eigenvalue of A v = λ B v. A and B are
/// symmetric n × n, row-major, and B is the modes' mass Gram (positive
/// definite when the vectors are independent). n is 1 or 2 on the plates
/// this scores; a longer cluster uses the same reduction.
pub fn lower_generalized(a: &[f64], b: &[f64], n: usize) -> f64 {
    if n == 0 {
        return 0.0;
    }
    if n == 1 {
        return if b[0].abs() > 0.0 { a[0] / b[0] } else { 0.0 };
    }
    // B = L Lᵀ, then the eigenvalues of L⁻¹ A L⁻ᵀ.
    let mut l = b.to_vec();
    for i in 0..n {
        let mut d = l[i * n + i];
        for q in 0..i {
            d -= l[i * n + q] * l[i * n + q];
        }
        if d <= 0.0 || d.is_nan() {
            return 0.0;
        }
        let d = d.sqrt();
        l[i * n + i] = d;
        for r in i + 1..n {
            let mut s = l[r * n + i];
            for q in 0..i {
                s -= l[r * n + q] * l[i * n + q];
            }
            l[r * n + i] = s / d;
        }
    }
    // C = L⁻¹ A, then G = C L⁻ᵀ, so L Gᵀ = Cᵀ and each row of G is a
    // forward substitution of that row of C. G is symmetric; mirror it.
    let mut c = a.to_vec();
    for col in 0..n {
        for i in 0..n {
            let mut s = c[i * n + col];
            for q in 0..i {
                s -= l[i * n + q] * c[q * n + col];
            }
            c[i * n + col] = s / l[i * n + i];
        }
    }
    let mut g = vec![0.0; n * n];
    for i in 0..n {
        for k in 0..n {
            let mut s = c[i * n + k];
            for q in 0..k {
                s -= l[k * n + q] * g[i * n + q];
            }
            g[i * n + k] = s / l[k * n + k];
        }
    }
    for i in 0..n {
        for j in i + 1..n {
            let m = 0.5 * (g[i * n + j] + g[j * n + i]);
            g[i * n + j] = m;
            g[j * n + i] = m;
        }
    }
    jacobi_smallest(&mut g, n)
}

/// Smallest eigenvalue of a symmetric matrix, Jacobi rotations. `g` is
/// overwritten. n ≤ 8 in practice (a cluster, not the whole spectrum).
fn jacobi_smallest(g: &mut [f64], n: usize) -> f64 {
    for _ in 0..32 {
        let mut max = 0.0;
        let mut piv = (0, 1);
        for i in 0..n {
            for j in i + 1..n {
                let a = g[i * n + j].abs();
                if a > max {
                    max = a;
                    piv = (i, j);
                }
            }
        }
        if max <= 1e-15 * diag_scale(g, n) {
            break;
        }
        let (p, q) = piv;
        let app = g[p * n + p];
        let aqq = g[q * n + q];
        let apq = g[p * n + q];
        let tau = (aqq - app) / (2.0 * apq);
        let t = if tau >= 0.0 {
            1.0 / (tau + (1.0 + tau * tau).sqrt())
        } else {
            -1.0 / (-tau + (1.0 + tau * tau).sqrt())
        };
        let c = 1.0 / (1.0 + t * t).sqrt();
        let s = t * c;
        g[p * n + p] = app - t * apq;
        g[q * n + q] = aqq + t * apq;
        g[p * n + q] = 0.0;
        g[q * n + p] = 0.0;
        for i in 0..n {
            if i == p || i == q {
                continue;
            }
            let aip = g[i * n + p];
            let aiq = g[i * n + q];
            g[i * n + p] = c * aip - s * aiq;
            g[p * n + i] = g[i * n + p];
            g[i * n + q] = s * aip + c * aiq;
            g[q * n + i] = g[i * n + q];
        }
    }
    (0..n).map(|i| g[i * n + i]).fold(f64::INFINITY, f64::min)
}

fn diag_scale(g: &[f64], n: usize) -> f64 {
    (0..n)
        .map(|i| g[i * n + i].abs())
        .fold(0.0, f64::max)
        .max(1.0)
}

/// y = M x for an upper triangle stored the stiffness's way.
pub(crate) fn spmv(pattern: &Pattern, values: &[f64], x: &[f64], y: &mut [f64]) {
    y.fill(0.0);
    for c in 0..pattern.n {
        for p in pattern.col_ptr[c]..pattern.col_ptr[c + 1] {
            let r = pattern.row_idx[p];
            let v = values[p];
            y[r] += v * x[c];
            if r != c {
                y[c] += v * x[r];
            }
        }
    }
}

pub(crate) fn sym_dot(pattern: &Pattern, values: &[f64], u: &[f64], v: &[f64]) -> f64 {
    let mut y = vec![0.0; pattern.n];
    spmv(pattern, values, u, &mut y);
    y.iter().zip(v).map(|(a, b)| a * b).sum()
}

struct ShiftInv<'a> {
    pattern: &'a Pattern,
    mass: &'a [f64],
    symbolic: &'a SymbolicCholesky<usize>,
    factor: &'a Factor,
}

impl std::fmt::Debug for ShiftInv<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "ShiftInv({})", self.pattern.n)
    }
}

impl LinOp<f64> for ShiftInv<'_> {
    fn apply_scratch(&self, _: usize, _: Par) -> faer::dyn_stack::StackReq {
        faer::dyn_stack::StackReq::empty()
    }

    fn nrows(&self) -> usize {
        self.pattern.n
    }

    fn ncols(&self) -> usize {
        self.pattern.n
    }

    fn apply(&self, mut out: MatMut<'_, f64>, rhs: MatRef<'_, f64>, _: Par, _: &mut MemStack) {
        let n = self.pattern.n;
        let mut x = vec![0.0; n];
        let mut mx = vec![0.0; n];
        for col in 0..rhs.ncols() {
            for i in 0..n {
                x[i] = rhs[(i, col)];
            }
            spmv(self.pattern, self.mass, &x, &mut mx);
            let mut rhs = Mat::from_fn(n, 1, |i, _| mx[i]);
            // The factor is the one a static solve just accepted.
            solve_in_place(self.symbolic, self.factor, &mut rhs, 1).expect("the factor holds");
            for i in 0..n {
                out[(i, col)] = rhs[(i, 0)];
            }
        }
    }

    fn conj_apply(
        &self,
        out: MatMut<'_, f64>,
        rhs: MatRef<'_, f64>,
        par: Par,
        stack: &mut MemStack,
    ) {
        self.apply(out, rhs, par, stack);
    }
}

pub(crate) fn lowest(
    pattern: &Pattern,
    stiffness: &[f64],
    mass: &[f64],
    symbolic: &SymbolicCholesky<usize>,
    factor: &Factor,
    count: usize,
) -> Result<ModeSet, SimError> {
    let op = ShiftInv {
        pattern,
        mass,
        symbolic,
        factor,
    };
    let n = pattern.n;
    let want = (count + 4).min(n.saturating_sub(1).max(1));
    let par = Par::Seq;
    let params = PartialEigenParams {
        min_dim: 24.min(n),
        max_dim: 48.min(n).max(24.min(n)),
        max_restarts: 60,
        ..Default::default()
    };
    let scratch = partial_eigen_scratch(&op, want, par, params);
    let mut mem = MemBuffer::try_new(scratch).map_err(|_| SimError::new("Out of memory."))?;
    let mut vecs = Mat::<c64>::zeros(n, want);
    let mut vals = vec![c64::ZERO; want];
    // >> 32 keeps a full u32, so the components fill [-1, 1]. >> 33
    // would leave them in [-1, 0).
    let v0 = faer::Col::<f64>::from_fn(n, |i| {
        let mut h = i as u64;
        h = h.wrapping_mul(0x9E37_79B9_7F4A_7C15);
        let unit = (h >> 32) as f64 / (u32::MAX as f64);
        unit * 2.0 - 1.0
    });
    let started = Instant::now();
    let info = partial_eigen(
        vecs.as_mut(),
        &mut vals,
        &op,
        v0.as_ref(),
        1e-9,
        par,
        MemStack::new(&mut mem),
        params,
    );
    let seconds = started.elapsed().as_secs_f64();
    let mut found = Vec::new();
    for j in 0..info.n_converged_eigen {
        let mu = vals[j].re;
        let imag = vals[j].im.abs();
        if mu.abs() < 1e-18 || (imag > 1e-6 * mu.abs().max(1e-30) && imag > 1e-8) {
            continue;
        }
        let v: Vec<f64> = (0..n).map(|i| vecs[(i, j)].re).collect();
        let kk = sym_dot(pattern, stiffness, &v, &v);
        let ss = sym_dot(pattern, mass, &v, &v);
        if ss.abs() < 1e-30 * kk.abs().max(1.0) {
            continue;
        }
        let omega2 = kk / ss;
        if !(omega2.is_finite() && omega2 > 0.0) {
            continue;
        }
        found.push(ShellMode {
            omega2,
            hz: omega2.sqrt() / std::f64::consts::TAU,
            vector: v,
        });
    }
    found.sort_by(|a, b| a.omega2.total_cmp(&b.omega2));
    found.truncate(count);
    if found.len() < count {
        return Err(SimError::new(format!(
            "The shell yielded {} mode(s); {count} were asked for.",
            found.len()
        )));
    }
    Ok(ModeSet {
        modes: found,
        seconds,
    })
}

#[cfg(test)]
mod pencil {
    use super::lower_generalized;

    #[test]
    fn repeated_pair_pencil_is_invariant() {
        let a = [1.0, 0.5, 0.5, 2.0];
        let b = [1.0, 0.0, 0.0, 1.0];
        let expect = (3.0 - 2.0_f64.sqrt()) / 2.0;
        let got = lower_generalized(&a, &b, 2);
        assert!((got - expect).abs() < 1e-12, "{got} vs {expect}");
        // A change of basis leaves the smaller eigenvalue where it was.
        let r = [0.6, -0.8, 0.8, 0.6];
        let mut ar = [0.0; 4];
        let mut br = [0.0; 4];
        for i in 0..2 {
            for j in 0..2 {
                for p in 0..2 {
                    for q in 0..2 {
                        ar[i * 2 + j] += r[p * 2 + i] * a[p * 2 + q] * r[q * 2 + j];
                        br[i * 2 + j] += r[p * 2 + i] * b[p * 2 + q] * r[q * 2 + j];
                    }
                }
            }
        }
        let again = lower_generalized(&ar, &br, 2);
        assert!((again - expect).abs() < 1e-12, "{again} vs {expect}");
        // A mass Gram with an off-diagonal, the case a rotated pair produces.
        let b2 = [
            6.509349003319259e-8,
            -5.182904686638507e-10,
            -5.182904686638507e-10,
            6.539582613991212e-8,
        ];
        let a2 = [
            3.7695167887857455,
            -0.5481861865185874,
            -0.5481861865185874,
            0.11089237738465083,
        ];
        let low = lower_generalized(&a2, &b2, 2);
        assert!((low - 467_821.902_123_87).abs() < 1e-4, "{low}");
    }
}
