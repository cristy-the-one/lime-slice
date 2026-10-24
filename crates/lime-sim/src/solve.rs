//! Sparse LDLᵀ through faer. AMD orders the matrix. The trait is the seam
//! a later factorisation would implement. Modal analysis is the trait that
//! returns "not in this version".

use faer::dyn_stack::{MemBuffer, MemStack};
use faer::prelude::ReborrowMut;
use faer::sparse::linalg::cholesky::supernodal::{SupernodalLdltRef, SymbolicSupernodalCholesky};
use faer::sparse::linalg::cholesky::{
    factorize_symbolic_cholesky, CholeskySymbolicParams, LdltRef, SymbolicCholesky,
    SymbolicCholeskyRaw, SymmetricOrdering,
};
use faer::sparse::linalg::SupernodalThreshold;
use faer::sparse::{SparseColMat, SymbolicSparseColMat, Triplet};
use faer::{Conj, Mat, Par, Side};

use crate::error::{not_held, SimError};
use crate::mesh::Mesh;

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

/// Faer's sparse LDLᵀ, ordered by AMD. `factor` orders and factors the
/// matrix once and keeps the factor, so each `solve` is one forward and back
/// substitution: a second load case on the same matrix costs no new factor.
/// Faer picks a simplicial or a supernodal factor by its flop estimate; the
/// supernodal one is far faster on a 3D mesh, and both keep the pivots on
/// their diagonal.
#[derive(Default)]
pub struct FaerLdlt {
    factored: Option<Factored>,
    /// Smallest |pivot| over largest |pivot| of the last factor.
    pivot_ratio: f64,
    /// How many times `factor` ran, so a test can count factorisations.
    pub factors: usize,
}

struct Factored {
    n: usize,
    symbolic: SymbolicCholesky<usize>,
    values: Vec<f64>,
}

impl FaerLdlt {
    /// How many values the last factor holds: its memory, at eight bytes
    /// each. Zero when nothing was factored.
    pub fn factor_len(&self) -> usize {
        self.factored.as_ref().map_or(0, |f| f.values.len())
    }

    /// `|D_min| / |D_max|` of the last factor. Zero when nothing was factored.
    pub fn pivot_ratio(&self) -> f64 {
        self.pivot_ratio
    }

    /// Factor with an explicit choice of simplicial or supernodal, so the
    /// two can be compared.
    fn factor_with(
        &mut self,
        triplets: &[(usize, usize, f64)],
        n: usize,
        threshold: SupernodalThreshold,
    ) -> Result<(), SimError> {
        self.factors += 1;
        self.factored = None;
        self.pivot_ratio = 0.0;
        if n == 0 {
            return Ok(());
        }
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
                supernodal_flop_ratio_threshold: threshold,
                ..Default::default()
            },
        )
        .map_err(|_| SimError::new("The stiffness matrix could not be ordered."))?;
        let mut values = vec![0.0; symbolic.len_val()];
        let par = parallel();
        let scratch = symbolic.factorize_numeric_ldlt_scratch::<f64>(par, Default::default());
        let mut mem = MemBuffer::try_new(scratch).map_err(|_| SimError::new("Out of memory."))?;
        if symbolic
            .factorize_numeric_ldlt(
                &mut values,
                matrix.as_ref(),
                Side::Upper,
                Default::default(),
                par,
                MemStack::new(&mut mem),
                Default::default(),
            )
            .is_err()
        {
            return Err(not_held());
        }
        self.pivot_ratio = match symbolic.raw() {
            SymbolicCholeskyRaw::Simplicial(simplicial) => {
                pivot_ratio_of(simplicial.col_ptr(), simplicial.row_idx(), &values)
            }
            SymbolicCholeskyRaw::Supernodal(supernodal) => {
                supernodal_pivot_ratio(supernodal, &values)
            }
        };
        self.factored = Some(Factored {
            n,
            symbolic,
            values,
        });
        Ok(())
    }
}

impl LinearSolver for FaerLdlt {
    fn factor(&mut self, triplets: &[(usize, usize, f64)], n: usize) -> Result<(), SimError> {
        self.factor_with(triplets, n, SupernodalThreshold::AUTO)
    }

    fn solve(&self, b: &[f64], x: &mut [f64]) -> Result<(), SimError> {
        if b.len() != x.len() {
            return Err(SimError::new("The load vector does not match the matrix."));
        }
        let Some(f) = &self.factored else {
            if b.is_empty() {
                return Ok(());
            }
            return Err(SimError::new("The matrix has not been factored."));
        };
        if b.len() != f.n {
            return Err(SimError::new("The load vector does not match the matrix."));
        }
        let par = parallel();
        let mut rhs = Mat::<f64>::from_fn(f.n, 1, |i, _| b[i]);
        let scratch = f.symbolic.solve_in_place_scratch::<f64>(1, par);
        let mut mem = MemBuffer::try_new(scratch).map_err(|_| SimError::new("Out of memory."))?;
        LdltRef::new(&f.symbolic, &f.values).solve_in_place_with_conj(
            Conj::No,
            rhs.rb_mut(),
            par,
            MemStack::new(&mut mem),
        );
        for (i, out) in x.iter_mut().enumerate() {
            *out = rhs[(i, 0)];
        }
        Ok(())
    }
}

/// How many values a supernodal factor of the mesh's node graph would hold:
/// AMD and the symbolic analysis only, on one row per node instead of three
/// per node, so it costs a small part of a real factor. Its ratio to a real
/// factor of the same kind of grid is close to constant, so a caller that
/// has factored one grid can size a finer one before building it.
pub fn node_graph_factor_len(mesh: &Mesh) -> Result<usize, SimError> {
    let n = mesh.nodes.len();
    if n == 0 {
        return Ok(0);
    }
    let mut pairs: Vec<(u32, u32)> = Vec::new();
    for cell in &mesh.elements {
        for &a in &cell.nodes {
            for &b in &cell.nodes {
                if a <= b {
                    // (column, row) of the upper triangle.
                    pairs.push((b as u32, a as u32));
                }
            }
        }
    }
    pairs.sort_unstable();
    pairs.dedup();
    let mut col_ptr = vec![0usize; n + 1];
    for &(col, _) in &pairs {
        col_ptr[col as usize + 1] += 1;
    }
    for c in 0..n {
        col_ptr[c + 1] += col_ptr[c];
    }
    let row_idx: Vec<usize> = pairs.iter().map(|&(_, row)| row as usize).collect();
    drop(pairs);
    let graph = SymbolicSparseColMat::new_checked(n, n, col_ptr, None, row_idx);
    let symbolic = factorize_symbolic_cholesky(
        graph.as_ref(),
        Side::Upper,
        SymmetricOrdering::Amd,
        CholeskySymbolicParams {
            supernodal_flop_ratio_threshold: SupernodalThreshold::FORCE_SUPERNODAL,
            ..Default::default()
        },
    )
    .map_err(|_| SimError::new("The mesh's node graph could not be ordered."))?;
    Ok(symbolic.len_val())
}

/// The most threads one factor uses. faer splits the dense blocks of the
/// largest supernodes, which stops paying past a handful of threads: the
/// jet study's numeric factor took 4.1 s on one thread, 1.9 s on six or
/// eight, and 2.4 s on all 24 of a Core Ultra 9 275HX.
const MAX_THREADS: usize = 8;

fn parallel() -> Par {
    let cores = std::thread::available_parallelism().map_or(1, |n| n.get());
    Par::rayon(cores.min(MAX_THREADS))
}

/// `|D_min| / |D_max|` of a supernodal factor: each supernode's block
/// diagonal holds its pivots on its own diagonal.
fn supernodal_pivot_ratio(symbolic: &SymbolicSupernodalCholesky<usize>, values: &[f64]) -> f64 {
    let factor = SupernodalLdltRef::new(symbolic, values);
    let mut min_abs = f64::INFINITY;
    let mut max_abs = 0.0_f64;
    for s in 0..symbolic.n_supernodes() {
        let block = factor.supernode(s).val();
        for j in 0..block.ncols() {
            let pivot = block[(j, j)].abs();
            min_abs = min_abs.min(pivot);
            max_abs = max_abs.max(pivot);
        }
    }
    if !min_abs.is_finite() || max_abs == 0.0 {
        0.0
    } else {
        min_abs / max_abs
    }
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
        let err = solver.factor(&[(0, 0, 0.0)], 1).unwrap_err();
        assert_eq!(
            err.message,
            "This part is not held. Fix a face, or the bed."
        );
    }

    /// A 3D Laplacian, the stiffness of a grid of springs to ground: big
    /// enough that faer goes supernodal.
    fn laplacian(side: usize) -> (Vec<(usize, usize, f64)>, usize) {
        let n = side * side * side;
        let id = |i: usize, j: usize, k: usize| i + side * (j + side * k);
        let mut t = Vec::new();
        for k in 0..side {
            for j in 0..side {
                for i in 0..side {
                    let a = id(i, j, k);
                    t.push((a, a, 6.0 + 0.01 * (a % 7) as f64));
                    if i + 1 < side {
                        t.push((a, id(i + 1, j, k), -1.0));
                    }
                    if j + 1 < side {
                        t.push((a, id(i, j + 1, k), -1.0));
                    }
                    if k + 1 < side {
                        t.push((a, id(i, j, k + 1), -1.0));
                    }
                }
            }
        }
        (t, n)
    }

    #[test]
    fn supernodal_and_simplicial_agree_and_both_read_their_pivots() {
        let (t, n) = laplacian(18);
        let b: Vec<f64> = (0..n).map(|i| (i % 5) as f64 - 2.0).collect();
        let mut simple = FaerLdlt::default();
        simple
            .factor_with(&t, n, SupernodalThreshold::FORCE_SIMPLICIAL)
            .unwrap();
        let mut blocks = FaerLdlt::default();
        blocks
            .factor_with(&t, n, SupernodalThreshold::FORCE_SUPERNODAL)
            .unwrap();
        let (mut x, mut y) = (vec![0.0; n], vec![0.0; n]);
        simple.solve(&b, &mut x).unwrap();
        blocks.solve(&b, &mut y).unwrap();
        let worst = x
            .iter()
            .zip(&y)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0, f64::max);
        assert!(worst < 1e-10, "{worst}");
        assert!(simple.pivot_ratio() > 0.0);
        // Different orderings of the same elimination keep different pivots,
        // but both are well away from a singular matrix.
        assert!(blocks.pivot_ratio() > 0.1, "{}", blocks.pivot_ratio());
    }

    #[test]
    fn one_factor_serves_every_load() {
        let (t, n) = laplacian(6);
        let mut solver = FaerLdlt::default();
        solver.factor(&t, n).unwrap();
        for case in 0..3 {
            let b: Vec<f64> = (0..n).map(|i| ((i + case) % 4) as f64).collect();
            let mut x = vec![0.0; n];
            solver.solve(&b, &mut x).unwrap();
            // A x = b, checked by the triplets.
            let mut ax = vec![0.0; n];
            for &(r, c, v) in &t {
                ax[r] += v * x[c];
                if r != c {
                    ax[c] += v * x[r];
                }
            }
            let worst = ax
                .iter()
                .zip(&b)
                .map(|(a, b)| (a - b).abs())
                .fold(0.0, f64::max);
            assert!(worst < 1e-10, "case {case}: {worst}");
        }
        assert_eq!(solver.factors, 1);
    }

    /// A dof-level factor of a mesh's pattern: every node pair a dense 3 × 3
    /// block, diagonally dominant so it factors.
    fn dof_factor_len(mesh: &Mesh) -> usize {
        let mut pairs = std::collections::BTreeSet::new();
        for cell in &mesh.elements {
            for &a in &cell.nodes {
                for &b in &cell.nodes {
                    if a <= b {
                        pairs.insert((a, b));
                    }
                }
            }
        }
        let mut t = Vec::new();
        for (a, b) in pairs {
            for i in 0..3 {
                for j in 0..3 {
                    let (r, c) = (3 * a + i, 3 * b + j);
                    if r < c {
                        t.push((r, c, -0.01));
                    } else if r == c {
                        t.push((r, c, 1000.0));
                    }
                }
            }
        }
        let mut solver = FaerLdlt::default();
        solver.factor(&t, 3 * mesh.nodes.len()).unwrap();
        solver.factor_len()
    }

    /// The node graph sizes a finer grid's factor: its ratio to the real,
    /// three-dofs-a-node factor holds within 15% from one cell size to the
    /// next, which is what lets a study size its second grid from its first.
    #[test]
    fn the_node_graph_sizes_a_finer_factor() {
        use crate::{beam, ElementKind};
        let coarse = beam(40.0, 8.0, 8.0, 2.0, ElementKind::Tet10).unwrap();
        let fine = beam(40.0, 8.0, 8.0, 2.0 / std::f64::consts::SQRT_2, ElementKind::Tet10).unwrap();
        let ratio = |mesh: &Mesh| dof_factor_len(mesh) as f64 / node_graph_factor_len(mesh).unwrap() as f64;
        let (a, b) = (ratio(&coarse), ratio(&fine));
        assert!(node_graph_factor_len(&fine).unwrap() > node_graph_factor_len(&coarse).unwrap());
        assert!((a - b).abs() / a.max(b) < 0.15, "{a} and {b}");
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
