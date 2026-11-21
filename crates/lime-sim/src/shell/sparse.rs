//! The shell's stiffness pattern and its LDLᵀ factor.
//!
//! Every pair of nodes on a common triangle couples all of their free
//! dofs, so the shell's part of the upper triangle is fixed by the mesh
//! and the holds alone. Ribs run along mesh edges, so they add no entry
//! among the shell's dofs; their web rotations are extra columns after the
//! shell's. A rib change keeps the shell's columns and values, and costs
//! the ordering and one numeric factorisation. The faer calls are the ones
//! [`crate::solve::FaerLdlt`] makes.

use faer::dyn_stack::{MemBuffer, MemStack, StackReq};
use faer::prelude::ReborrowMut;
use faer::sparse::linalg::cholesky::{
    factorize_symbolic_cholesky, CholeskySymbolicParams, LdltRef, SymbolicCholesky,
    SymbolicCholeskyRaw, SymmetricOrdering,
};
use faer::sparse::{SparseColMatRef, SymbolicSparseColMatRef};
use faer::{Conj, Mat, Par, Side};

use crate::error::{not_held, SimError};
use crate::solve::{parallel, pivot_ratio_of, supernodal_pivot_ratio};

/// Reusable aligned scratch memory for repeated faer factorisations and solves.
pub(crate) struct ScratchBuf {
    buf: MemBuffer,
    req: StackReq,
}

impl ScratchBuf {
    pub fn new() -> Self {
        let req = StackReq::empty();
        Self {
            buf: MemBuffer::new(req),
            req,
        }
    }

    pub fn stack(&mut self, req: StackReq) -> Result<&mut MemStack, SimError> {
        if req.size_bytes() > self.req.size_bytes() || req.align_bytes() > self.req.align_bytes() {
            let next = StackReq::or(self.req, req);
            self.buf = MemBuffer::try_new(next).map_err(|_| SimError::new("Out of memory."))?;
            self.req = next;
        }
        Ok(MemStack::new(&mut self.buf))
    }
}

impl Default for ScratchBuf {
    fn default() -> Self {
        Self::new()
    }
}

/// The factor's parallelism: `0` is the crate default ([`parallel`]),
/// `1` one thread, more a rayon split over that many.
pub(crate) fn par_of(threads: usize) -> Par {
    match threads {
        0 => parallel(),
        1 => Par::Seq,
        n => Par::rayon(n),
    }
}

/// A free-dof matrix's upper triangle in compressed columns.
#[derive(Clone, Debug)]
pub(crate) struct Pattern {
    pub n: usize,
    pub col_ptr: Vec<usize>,
    pub row_idx: Vec<usize>,
}

/// No free dof here.
pub(crate) const HELD: usize = usize::MAX;

impl Pattern {
    /// `below[b]`: node b's neighbours a ≤ b (b itself included), sorted.
    /// `dof[6 b + k]`: the free index of node b's dof k, or [`HELD`]. Free
    /// indices rise with the node, then the dof.
    pub fn build(below: &[Vec<u32>], dof: &[usize], n: usize) -> Self {
        let mut col_ptr = Vec::with_capacity(n + 1);
        col_ptr.push(0);
        let mut row_idx = Vec::new();
        for (b, near) in below.iter().enumerate() {
            for k in 0..6 {
                let c = dof[6 * b + k];
                if c == HELD {
                    continue;
                }
                for &a in near {
                    for q in 0..6 {
                        let r = dof[6 * a as usize + q];
                        if r != HELD && r <= c {
                            row_idx.push(r);
                        }
                    }
                }
                col_ptr.push(row_idx.len());
            }
        }
        debug_assert_eq!(col_ptr.len(), n + 1);
        Self {
            n,
            col_ptr,
            row_idx,
        }
    }

    /// This pattern with more columns after its own: `extra[k]` holds the
    /// sorted rows of column `n + k`, each at most `n + k`. The existing
    /// columns, and so the positions of their values, do not move.
    pub fn extend(&self, extra: &[Vec<usize>]) -> Self {
        let mut col_ptr = self.col_ptr.clone();
        let mut row_idx = self.row_idx.clone();
        for (k, rows) in extra.iter().enumerate() {
            debug_assert!(rows.iter().all(|&r| r <= self.n + k));
            row_idx.extend_from_slice(rows);
            col_ptr.push(row_idx.len());
        }
        Self {
            n: self.n + extra.len(),
            col_ptr,
            row_idx,
        }
    }

    /// Whether `self` is already `base.extend(extra)` without allocating.
    pub fn matches_extended(&self, base: &Self, extra: &[Vec<usize>]) -> bool {
        if self.n != base.n + extra.len() {
            return false;
        }
        let mut offset = base.nnz();
        for (k, rows) in extra.iter().enumerate() {
            let c = base.n + k;
            let lo = self.col_ptr[c];
            let hi = self.col_ptr[c + 1];
            if lo != offset || hi - lo != rows.len() || &self.row_idx[lo..hi] != rows.as_slice() {
                return false;
            }
            offset = hi;
        }
        true
    }

    pub fn nnz(&self) -> usize {
        self.row_idx.len()
    }

    /// Where entry (r, c), r ≤ c, lives in the values.
    pub fn position(&self, r: usize, c: usize) -> Option<usize> {
        let (lo, hi) = (self.col_ptr[c], self.col_ptr[c + 1]);
        self.row_idx[lo..hi].binary_search(&r).ok().map(|i| lo + i)
    }

    fn symbolic_ref(&self) -> SymbolicSparseColMatRef<'_, usize> {
        SymbolicSparseColMatRef::new_checked(self.n, self.n, &self.col_ptr, None, &self.row_idx)
    }

    /// AMD ordering and the symbolic factor, once per pattern.
    pub fn analyse(&self) -> Result<SymbolicCholesky<usize>, SimError> {
        factorize_symbolic_cholesky(
            self.symbolic_ref(),
            Side::Upper,
            SymmetricOrdering::Amd,
            CholeskySymbolicParams::default(),
        )
        .map_err(|_| SimError::new("The shell's stiffness matrix could not be ordered."))
    }
}

/// Below this pivot ratio the shell is taken as not held: some rigid
/// motion is left free. Held shells in the tests stay above 1e-12; a free
/// rigid mode comes out near machine precision.
pub(crate) const MIN_PIVOT_RATIO: f64 = 1e-14;

/// Factor into a reusable `out` buffer and `scratch`, returning the pivot ratio.
pub(crate) fn factor_into(
    pattern: &Pattern,
    symbolic: &SymbolicCholesky<usize>,
    values: &[f64],
    threads: usize,
    out: &mut Vec<f64>,
    scratch: &mut ScratchBuf,
) -> Result<f64, SimError> {
    out.clear();
    out.resize(symbolic.len_val(), 0.0);
    if pattern.n == 0 {
        return Ok(1.0);
    }
    let matrix = SparseColMatRef::new(pattern.symbolic_ref(), values);
    let par = par_of(threads);
    let req = symbolic.factorize_numeric_ldlt_scratch::<f64>(par, Default::default());
    let stack = scratch.stack(req)?;
    symbolic
        .factorize_numeric_ldlt(
            out,
            matrix,
            Side::Upper,
            Default::default(),
            par,
            stack,
            Default::default(),
        )
        .map_err(|_| not_held())?;
    let pivot_ratio = match symbolic.raw() {
        SymbolicCholeskyRaw::Simplicial(s) => pivot_ratio_of(s.col_ptr(), s.row_idx(), out),
        SymbolicCholeskyRaw::Supernodal(s) => supernodal_pivot_ratio(s, out),
    };
    // A NaN ratio is not held either.
    if pivot_ratio.is_nan() || pivot_ratio < MIN_PIVOT_RATIO {
        return Err(not_held());
    }
    Ok(pivot_ratio)
}

/// Solve for every column of `rhs` (n × cases, column-major) in place,
/// reusing `scratch`.
pub(crate) fn solve_in_place_with(
    symbolic: &SymbolicCholesky<usize>,
    factor_values: &[f64],
    rhs: &mut Mat<f64>,
    threads: usize,
    scratch: &mut ScratchBuf,
) -> Result<(), SimError> {
    if rhs.nrows() == 0 {
        return Ok(());
    }
    let par = par_of(threads);
    let req = symbolic.solve_in_place_scratch::<f64>(rhs.ncols(), par);
    let stack = scratch.stack(req)?;
    LdltRef::new(symbolic, factor_values).solve_in_place_with_conj(
        Conj::No,
        rhs.rb_mut(),
        par,
        stack,
    );
    Ok(())
}
