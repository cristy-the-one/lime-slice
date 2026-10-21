//! Simplicial LDLᵀ through faer. AMD orders the matrix. The trait is the seam
//! a later factorisation would implement. Modal analysis is the trait that
//! returns "not in this version".

use std::cell::Cell;

use faer::dyn_stack::{MemBuffer, MemStack};
use faer::prelude::ReborrowMut;
use faer::sparse::linalg::cholesky::{
    factorize_symbolic_cholesky, CholeskySymbolicParams, SymbolicCholeskyRaw, SymmetricOrdering,
};
use faer::sparse::linalg::SupernodalThreshold;
use faer::sparse::{SparseColMat, Triplet};
use faer::{Conj, Mat, Par, Side};

use crate::error::{not_held, SimError};

pub struct Csc {
    pub nrows: usize,
    pub col_ptr: Vec<usize>,
    pub row_idx: Vec<usize>,
    pub values: Vec<f64>,
}

#[derive(Clone, Debug)]
pub struct EigenPairs {
    pub values: Vec<f64>,
    pub vectors: Vec<Vec<f64>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NotInThisVersion {
    pub analysis: String,
}

impl NotInThisVersion {
    pub fn sentence(&self) -> String {
        if self.analysis == "modal" {
            "Modal analysis is not in this version.".to_string()
        } else {
            format!("{} is not in this version.", self.analysis)
        }
    }
}

pub trait LinearSolver {
    fn factor(&mut self, triplets: &[(usize, usize, f64)], n: usize) -> Result<(), SimError>;
    fn solve(&self, b: &[f64], x: &mut [f64]) -> Result<(), SimError>;
}

pub trait EigenSolver {
    fn smallest(&self, k: &Csc, m: &Csc, n: usize) -> Result<EigenPairs, NotInThisVersion>;
}

#[derive(Default)]
pub struct ModalStub;

impl EigenSolver for ModalStub {
    fn smallest(&self, _k: &Csc, _m: &Csc, _n: usize) -> Result<EigenPairs, NotInThisVersion> {
        Err(NotInThisVersion {
            analysis: "modal".into(),
        })
    }
}

/// Faer's simplicial LDLᵀ. Supernodal factorisation is forced off.
#[derive(Default)]
pub struct FaerLdlt {
    symbolic_n: usize,
    /// Triplets kept so `solve` factorises the matrix it was given.
    raw: Option<Factor>,
    /// Smallest |pivot| over largest |pivot| from the last successful solve.
    /// Faer stores each LDLᵀ pivot on the diagonal of the simplicial factor.
    pivot_ratio: Cell<f64>,
}

struct Factor {
    n: usize,
    triplets: Vec<(usize, usize, f64)>,
}

impl FaerLdlt {
    /// `|D_min| / |D_max|` of the last factor. Zero when no solve has run.
    pub fn pivot_ratio(&self) -> f64 {
        self.pivot_ratio.get()
    }
}

impl LinearSolver for FaerLdlt {
    fn factor(&mut self, triplets: &[(usize, usize, f64)], n: usize) -> Result<(), SimError> {
        self.symbolic_n = n;
        self.raw = Some(Factor {
            n,
            triplets: triplets.to_vec(),
        });
        Ok(())
    }

    fn solve(&self, b: &[f64], x: &mut [f64]) -> Result<(), SimError> {
        if b.len() != x.len() || b.len() != self.symbolic_n {
            return Err(SimError::new("The load vector does not match the matrix."));
        }
        if self.symbolic_n == 0 {
            return Ok(());
        }
        let factor = self
            .raw
            .as_ref()
            .ok_or_else(|| SimError::new("The matrix has not been factored."))?;
        let (sol, ratio) = numeric(&factor.triplets, factor.n, b)?;
        self.pivot_ratio.set(ratio);
        x.copy_from_slice(&sol);
        Ok(())
    }
}

fn numeric(
    triplets: &[(usize, usize, f64)],
    n: usize,
    rhs: &[f64],
) -> Result<(Vec<f64>, f64), SimError> {
    let trips: Vec<Triplet<usize, usize, f64>> = triplets
        .iter()
        .copied()
        .map(|(r, c, v)| Triplet::new(r, c, v))
        .collect();
    let matrix = SparseColMat::<usize, f64>::try_new_from_triplets(n, n, &trips)
        .map_err(|_| SimError::new("The stiffness matrix could not be built."))?;
    let symbolic = factorize_symbolic_cholesky(
        matrix.symbolic(),
        Side::Upper,
        SymmetricOrdering::Amd,
        CholeskySymbolicParams {
            supernodal_flop_ratio_threshold: SupernodalThreshold::FORCE_SIMPLICIAL,
            ..Default::default()
        },
    )
    .map_err(|_| SimError::new("The stiffness matrix could not be ordered."))?;
    let mut values = vec![0.0; symbolic.len_val()];
    let par = Par::Seq;
    let scratch = symbolic.factorize_numeric_ldlt_scratch::<f64>(par, Default::default());
    let mut mem = MemBuffer::try_new(scratch).map_err(|_| SimError::new("Out of memory."))?;
    let ldlt = match symbolic.factorize_numeric_ldlt(
        &mut values,
        matrix.as_ref(),
        Side::Upper,
        Default::default(),
        par,
        MemStack::new(&mut mem),
        Default::default(),
    ) {
        Ok(ldlt) => ldlt,
        Err(_) => return Err(not_held()),
    };
    let mut x = Mat::<f64>::from_fn(n, 1, |i, _| rhs[i]);
    let scratch = symbolic.solve_in_place_scratch::<f64>(1, par);
    let mut mem = MemBuffer::try_new(scratch).map_err(|_| SimError::new("Out of memory."))?;
    ldlt.solve_in_place_with_conj(Conj::No, x.rb_mut(), par, MemStack::new(&mut mem));
    let ratio = match symbolic.raw() {
        SymbolicCholeskyRaw::Simplicial(simplicial) => {
            pivot_ratio_of(simplicial.col_ptr(), simplicial.row_idx(), &values)
        }
        // Supernodal factorisation is forced off. Its block diagonal is not read.
        SymbolicCholeskyRaw::Supernodal(_) => 1.0,
    };
    Ok(((0..n).map(|i| x[(i, 0)]).collect(), ratio))
}

/// `|D_min| / |D_max|`. The diagonal entries of the simplicial factor are the pivots.
fn pivot_ratio_of(col_ptr: &[usize], row_idx: &[usize], values: &[f64]) -> f64 {
    let mut min_abs = f64::INFINITY;
    let mut max_abs = 0.0_f64;
    let n = col_ptr.len().saturating_sub(1);
    for col in 0..n {
        for k in col_ptr[col]..col_ptr[col + 1] {
            if row_idx.get(k).copied() == Some(col) {
                let pivot = values.get(k).copied().unwrap_or(0.0).abs();
                min_abs = min_abs.min(pivot);
                max_abs = max_abs.max(pivot);
            }
        }
    }
    if !min_abs.is_finite() || max_abs == 0.0 {
        0.0
    } else {
        min_abs / max_abs
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_two_by_two_matches_the_inverse() {
        // [4, 1; 1, 3] [x, y] = [5, 4] => x = 1, y = 1
        let mut solver = FaerLdlt::default();
        solver
            .factor(&[(0, 0, 4.0), (0, 1, 1.0), (1, 1, 3.0)], 2)
            .unwrap();
        let mut x = [0.0; 2];
        solver.solve(&[5.0, 4.0], &mut x).unwrap();
        assert!((x[0] - 1.0).abs() < 1e-12);
        assert!((x[1] - 1.0).abs() < 1e-12);
        // D = diag(4, 3 - 1/4). The ratio is the smaller pivot over the larger.
        assert!((solver.pivot_ratio() - 0.6875).abs() < 1e-12);
    }

    #[test]
    fn a_zero_pivot_is_not_held() {
        let mut solver = FaerLdlt::default();
        solver.factor(&[(0, 0, 0.0)], 1).unwrap();
        let mut x = [0.0];
        let err = solver.solve(&[1.0], &mut x).unwrap_err();
        assert_eq!(
            err.message,
            "This part is not held. Fix a face, or the bed."
        );
    }

    #[test]
    fn modal_is_refused() {
        let err = ModalStub
            .smallest(
                &Csc {
                    nrows: 0,
                    col_ptr: vec![0],
                    row_idx: vec![],
                    values: vec![],
                },
                &Csc {
                    nrows: 0,
                    col_ptr: vec![0],
                    row_idx: vec![],
                    values: vec![],
                },
                0,
            )
            .unwrap_err();
        assert_eq!(err.sentence(), "Modal analysis is not in this version.");
    }
}
