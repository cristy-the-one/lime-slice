//! Throwaway probe for docs/plan-shell-modes.md. Not a production test and
//! not part of the unit list. Natural frequencies and buckling loads of the
//! existing shell (Allman + DKT, Timoshenko rib) using faer's Krylov–Schur
//! partial eigen solver on K⁻¹ S. Synthetic plates only.
//!
//! Run: `cargo test -p lime-sim --release --test shell_modes_probe -- --nocapture`

#![allow(clippy::needless_range_loop, clippy::too_many_arguments)]

use std::collections::HashMap;
use std::time::Instant;

use faer::dyn_stack::{MemBuffer, MemStack};
use faer::matrix_free::eigen::{partial_eigen, partial_eigen_scratch, PartialEigenParams};
use faer::matrix_free::LinOp;
use faer::sparse::linalg::cholesky::{
    factorize_symbolic_cholesky, LdltRef, SymbolicCholesky, SymmetricOrdering,
};
use faer::sparse::SymbolicSparseColMatRef;
use faer::{c64, Conj, Mat, MatMut, MatRef, Par, Side};
use lime_sim::shell::planner::{plan_ribs, Goal, PlannerOptions, RibPlanRequest};
use lime_sim::shell::{
    IsotropicShell, Rib, RibSide, ShellHold, ShellLoad, ShellMesh, ShellModel, ShellOptions,
    ShellResult,
};

const E: f64 = 2000.0;
const NU: f64 = 0.3;
/// N·s²/mm⁴. About 1 g/cm³ once millimetres and newtons are consistent
/// (1 kg = 10⁻³ N·s²/mm, so 10⁻⁶ kg/mm³ is 10⁻⁹ in these units).
const RHO: f64 = 1.0e-9;
const TOL: f64 = 1e-8;

fn material() -> IsotropicShell {
    IsotropicShell::new(E, NU).unwrap()
}

fn rigidity(t: f64) -> f64 {
    E * t.powi(3) / (12.0 * (1.0 - NU * NU))
}

fn omega_mn(a: f64, b: f64, t: f64, m: i32, n: i32) -> f64 {
    let pi = std::f64::consts::PI;
    let k = (m as f64 / a).powi(2) + (n as f64 / b).powi(2);
    pi * pi * k * (rigidity(t) / (RHO * t)).sqrt()
}

// --- Element geometry, copied in spirit from the crate's private helpers.

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
fn scale(a: [f64; 3], s: f64) -> [f64; 3] {
    [a[0] * s, a[1] * s, a[2] * s]
}
fn norm(a: [f64; 3]) -> f64 {
    dot(a, a).sqrt()
}

struct Facet {
    e1: [f64; 3],
    e2: [f64; 3],
    normal: [f64; 3],
    xy: [[f64; 2]; 3],
    area: f64,
}

fn facet(p: [[f64; 3]; 3]) -> Facet {
    let a = sub(p[1], p[0]);
    let b = sub(p[2], p[0]);
    let la = norm(a);
    let nn = cross(a, b);
    let twice = norm(nn);
    let e1 = scale(a, 1.0 / la);
    let normal = scale(nn, 1.0 / twice);
    let e2 = cross(normal, e1);
    Facet {
        e1,
        e2,
        normal,
        xy: [[0.0, 0.0], [la, 0.0], [dot(b, e1), dot(b, e2)]],
        area: 0.5 * twice,
    }
}

fn area_gradients(xy: &[[f64; 2]; 3]) -> ([f64; 3], [f64; 3], f64) {
    let mut b = [0.0; 3];
    let mut c = [0.0; 3];
    for i in 0..3 {
        let j = (i + 1) % 3;
        let k = (i + 2) % 3;
        b[i] = xy[j][1] - xy[k][1];
        c[i] = xy[k][0] - xy[j][0];
    }
    let two_a = b[0] * xy[0][0] + b[1] * xy[1][0] + b[2] * xy[2][0];
    // b·x is not 2A; use the edge formula, which matches the crate.
    let two = (xy[1][0] - xy[0][0]) * (xy[2][1] - xy[0][1])
        - (xy[2][0] - xy[0][0]) * (xy[1][1] - xy[0][1]);
    let _ = two_a;
    (b, c, two)
}

const EDGES: [(usize, usize); 3] = [(0, 1), (1, 2), (2, 0)];

/// DKT slopes at the six nodes, from plate.rs. Rows are βx, βy of each node.
fn dkt_slopes(xy: &[[f64; 2]; 3]) -> [[f64; 9]; 12] {
    let corner = |a: &mut [[f64; 9]; 12], row: usize, i: usize, m: [[f64; 2]; 2], s: f64| {
        for r in 0..2 {
            a[row + r][3 * i + 2] += -s * m[r][0];
            a[row + r][3 * i + 1] += s * m[r][1];
        }
    };
    let mut a = [[0.0; 9]; 12];
    let id = [[1.0, 0.0], [0.0, 1.0]];
    for i in 0..3 {
        corner(&mut a, 2 * i, i, id, 1.0);
    }
    for (m, (i, j)) in EDGES.iter().copied().enumerate() {
        let row = 2 * (3 + m);
        let ex = xy[j][0] - xy[i][0];
        let ey = xy[j][1] - xy[i][1];
        let len = (ex * ex + ey * ey).sqrt();
        let s = [ex / len, ey / len];
        let n = [s[1], -s[0]];
        let mut p = [[0.0; 2]; 2];
        for r in 0..2 {
            for q in 0..2 {
                p[r][q] = -0.25 * s[r] * s[q] + 0.5 * n[r] * n[q];
            }
        }
        corner(&mut a, row, i, p, 1.0);
        corner(&mut a, row, j, p, 1.0);
        for r in 0..2 {
            a[row + r][3 * j] += 1.5 * s[r] / len;
            a[row + r][3 * i] -= 1.5 * s[r] / len;
        }
    }
    a
}

fn quad_n(l: [f64; 3]) -> [f64; 6] {
    let mut n = [0.0; 6];
    for i in 0..3 {
        n[i] = l[i] * (2.0 * l[i] - 1.0);
    }
    for (m, (i, j)) in EDGES.iter().copied().enumerate() {
        n[3 + m] = 4.0 * l[i] * l[j];
    }
    n
}

/// βx, βy rows (9,) at area coordinates `l`.
fn beta_at(slopes: &[[f64; 9]; 12], l: [f64; 3]) -> ([f64; 9], [f64; 9]) {
    let nk = quad_n(l);
    let mut bx = [0.0; 9];
    let mut by = [0.0; 9];
    for k in 0..6 {
        for d in 0..9 {
            bx[d] += nk[k] * slopes[2 * k][d];
            by[d] += nk[k] * slopes[2 * k + 1][d];
        }
    }
    (bx, by)
}

/// 7-point Dunavant rule. Weights are fractions of the area and sum to 1.
fn gauss7() -> [([f64; 3], f64); 7] {
    let s = 15.0f64.sqrt();
    let a = (6.0 - s) / 21.0;
    let b = (6.0 + s) / 21.0;
    let wa = (155.0 - s) / 1200.0;
    let wb = (155.0 + s) / 1200.0;
    [
        ([1.0 / 3.0, 1.0 / 3.0, 1.0 / 3.0], 0.225),
        ([a, a, 1.0 - 2.0 * a], wa),
        ([a, 1.0 - 2.0 * a, a], wa),
        ([1.0 - 2.0 * a, a, a], wa),
        ([b, b, 1.0 - 2.0 * b], wb),
        ([b, 1.0 - 2.0 * b, b], wb),
        ([1.0 - 2.0 * b, b, b], wb),
    ]
}

/// Plate geometric stiffness on the nine local bending dofs `[w, θx, θy]`,
/// from membrane forces `n` = `[Nxx, Nyy, Nxy]` (N/mm, tension positive).
fn plate_kg(xy: &[[f64; 2]; 3], area: f64, nforce: [f64; 3]) -> [[f64; 9]; 9] {
    let slopes = dkt_slopes(xy);
    let mut k = [[0.0; 9]; 9];
    let [nxx, nyy, nxy] = nforce;
    for (l, w) in gauss7() {
        let (bx, by) = beta_at(&slopes, l);
        let s = w * area;
        for i in 0..9 {
            for j in 0..9 {
                k[i][j] += s
                    * (bx[i] * nxx * bx[j] + by[i] * nyy * by[j] + (bx[i] * by[j] + by[i] * bx[j]) * nxy);
            }
        }
    }
    k
}

/// In-plane geometric stiffness on `[u, v]` (no drilling), CST gradients.
fn membrane_kg(xy: &[[f64; 2]; 3], area: f64, nforce: [f64; 3]) -> [[f64; 6]; 6] {
    let (b, c, two) = area_gradients(xy);
    let mut gx = [0.0; 3];
    let mut gy = [0.0; 3];
    for i in 0..3 {
        gx[i] = b[i] / two;
        gy[i] = c[i] / two;
    }
    let [nxx, nyy, nxy] = nforce;
    let mut k = [[0.0; 6]; 6];
    // Two in-plane components, each with the same gradient form.
    for comp in 0..2 {
        for i in 0..3 {
            for j in 0..3 {
                let g = gx[i] * nxx * gx[j] + gy[i] * nyy * gy[j] + (gx[i] * gy[j] + gy[i] * gx[j]) * nxy;
                k[2 * i + comp][2 * j + comp] += area * g;
            }
        }
    }
    k
}

fn membrane_matrix(t: f64) -> [[f64; 3]; 3] {
    let c = E * t / (1.0 - NU * NU);
    [
        [c, c * NU, 0.0],
        [c * NU, c, 0.0],
        [0.0, 0.0, c * 0.5 * (1.0 - NU)],
    ]
}

fn cst_strain(xy: &[[f64; 2]; 3], u: &[[f64; 2]; 3]) -> [f64; 3] {
    let (b, c, two) = area_gradients(xy);
    let mut e = [0.0; 3];
    for i in 0..3 {
        let dx = b[i] / two;
        let dy = c[i] / two;
        e[0] += dx * u[i][0];
        e[1] += dy * u[i][1];
        e[2] += dy * u[i][0] + dx * u[i][1];
    }
    e
}

fn matvec3(a: &[[f64; 3]; 3], x: [f64; 3]) -> [f64; 3] {
    [0, 1, 2].map(|i| a[i][0] * x[0] + a[i][1] * x[1] + a[i][2] * x[2])
}

fn add_bending_global(acc: &mut Accum, map: &DofMap, corners: [u32; 3], f: &Facet, k: &[[f64; 9]; 9]) {
    let mut col = [[0.0; 6]; 9];
    // col[local 9][global 6 of that corner] = T
    let mut t = [[0.0; 6]; 9];
    for a in 0..3 {
        for q in 0..3 {
            t[3 * a][q] = f.normal[q];
            t[3 * a + 1][3 + q] = f.e1[q];
            t[3 * a + 2][3 + q] = f.e2[q];
        }
    }
    let _ = col;
    // Kg_global = T K Tᵀ over the 18 global slots.
    for a in 0..3 {
        for b in 0..3 {
            for i in 0..3 {
                for j in 0..3 {
                    let kij = k[3 * a + i][3 * b + j];
                    if kij == 0.0 {
                        continue;
                    }
                    for p in 0..6 {
                        let tp = t[3 * a + i][p];
                        if tp == 0.0 {
                            continue;
                        }
                        for q in 0..6 {
                            let v = tp * kij * t[3 * b + j][q];
                            if v != 0.0 {
                                acc.add_nodal(map, corners[a], p, corners[b], q, v);
                            }
                        }
                    }
                }
            }
        }
    }
}

fn add_membrane_global(acc: &mut Accum, map: &DofMap, corners: [u32; 3], f: &Facet, k: &[[f64; 6]; 6]) {
    // Local [u, v] of each corner. u along e1, v along e2.
    for a in 0..3 {
        for b in 0..3 {
            for i in 0..2 {
                for j in 0..2 {
                    let kij = k[2 * a + i][2 * b + j];
                    if kij == 0.0 {
                        continue;
                    }
                    let ei = if i == 0 { f.e1 } else { f.e2 };
                    let ej = if j == 0 { f.e1 } else { f.e2 };
                    for p in 0..3 {
                        for q in 0..3 {
                            let v = ei[p] * kij * ej[q];
                            if v != 0.0 {
                                acc.add_nodal(map, corners[a], p, corners[b], q, v);
                            }
                        }
                    }
                }
            }
        }
    }
}

// --- Sparse accumulation and the eigen operator.

struct DofMap {
    node: Vec<[usize; 6]>,
    psi: Vec<usize>,
    n: usize,
}

impl DofMap {
    fn build(mesh: &ShellMesh, holds: &[ShellHold], webs: &[(u32, [f64; 3], bool)]) -> Self {
        let nv = mesh.vertices.len();
        let mut held = vec![false; 6 * nv];
        for h in holds {
            for k in 0..6 {
                if h.dofs[k].is_some() {
                    held[6 * h.node as usize + k] = true;
                }
            }
        }
        let mut node = vec![[usize::MAX; 6]; nv];
        let mut n = 0;
        for i in 0..nv {
            for k in 0..6 {
                if !held[6 * i + k] {
                    node[i][k] = n;
                    n += 1;
                }
            }
        }
        let mut psi = Vec::with_capacity(webs.len());
        for (_, _, free) in webs {
            if *free {
                psi.push(n);
                n += 1;
            } else {
                psi.push(usize::MAX);
            }
        }
        Self { node, psi, n }
    }
}

struct Accum {
    n: usize,
    // Full matrix. Callers that start from an upper triangle mirror it themselves.
    upper: HashMap<(usize, usize), f64>,
}

impl Accum {
    fn new(n: usize) -> Self {
        Self {
            n,
            upper: HashMap::new(),
        }
    }

    fn add(&mut self, i: usize, j: usize, v: f64) {
        if i == usize::MAX || j == usize::MAX || v == 0.0 {
            return;
        }
        *self.upper.entry((i, j)).or_default() += v;
    }

    fn add_nodal(&mut self, map: &DofMap, na: u32, pa: usize, nb: u32, pb: usize, v: f64) {
        self.add(map.node[na as usize][pa], map.node[nb as usize][pb], v);
    }

    fn add_psi(&mut self, ia: usize, ib: usize, v: f64) {
        self.add(ia, ib, v);
    }

    fn into_csc(self) -> Csc {
        let mut cols: Vec<Vec<(usize, f64)>> = vec![Vec::new(); self.n];
        for ((r, c), v) in self.upper {
            cols[c].push((r, v));
        }
        let mut col_ptr = Vec::with_capacity(self.n + 1);
        let mut row_idx = Vec::new();
        let mut val = Vec::new();
        col_ptr.push(0);
        for mut col in cols {
            col.sort_by_key(|e| e.0);
            // Sum duplicates after the mirror.
            let mut i = 0;
            while i < col.len() {
                let (r, mut s) = col[i];
                let mut j = i + 1;
                while j < col.len() && col[j].0 == r {
                    s += col[j].1;
                    j += 1;
                }
                row_idx.push(r);
                val.push(s);
                i = j;
            }
            col_ptr.push(row_idx.len());
        }
        Csc {
            n: self.n,
            col_ptr,
            row_idx,
            val,
        }
    }
}

struct Csc {
    n: usize,
    col_ptr: Vec<usize>,
    row_idx: Vec<usize>,
    val: Vec<f64>,
}

impl Csc {
    fn spmv(&self, x: &[f64], y: &mut [f64]) {
        y.fill(0.0);
        for c in 0..self.n {
            let xc = x[c];
            for p in self.col_ptr[c]..self.col_ptr[c + 1] {
                y[self.row_idx[p]] += self.val[p] * xc;
            }
        }
    }

    fn upper_parts(&self) -> (Vec<usize>, Vec<usize>, Vec<f64>) {
        let mut col_ptr = Vec::with_capacity(self.n + 1);
        let mut row_idx = Vec::new();
        let mut val = Vec::new();
        col_ptr.push(0);
        for c in 0..self.n {
            for p in self.col_ptr[c]..self.col_ptr[c + 1] {
                let r = self.row_idx[p];
                if r <= c {
                    row_idx.push(r);
                    val.push(self.val[p]);
                }
            }
            col_ptr.push(row_idx.len());
        }
        (col_ptr, row_idx, val)
    }

    fn quad(&self, x: &[f64]) -> f64 {
        self.bilinear(x, x)
    }

    fn bilinear(&self, x: &[f64], z: &[f64]) -> f64 {
        let mut y = vec![0.0; self.n];
        self.spmv(z, &mut y);
        x.iter().zip(&y).map(|(a, b)| a * b).sum()
    }
}

struct Factored {
    symbolic: SymbolicCholesky<usize>,
    values: Vec<f64>,
    n: usize,
}

impl Factored {
    fn from_upper_k(k: &Csc) -> Self {
        let (col_ptr, row_idx, val) = k.upper_parts();
        let sym = SymbolicSparseColMatRef::new_checked(k.n, k.n, &col_ptr, None, &row_idx);
        let symbolic = factorize_symbolic_cholesky(
            sym,
            Side::Upper,
            SymmetricOrdering::Amd,
            Default::default(),
        )
        .expect("ordering");
        let mut values = vec![0.0; symbolic.len_val()];
        let matrix = faer::sparse::SparseColMatRef::new(
            SymbolicSparseColMatRef::new_checked(k.n, k.n, &col_ptr, None, &row_idx),
            &val,
        );
        let par = Par::Seq;
        let scratch = symbolic.factorize_numeric_ldlt_scratch::<f64>(par, Default::default());
        let mut mem = MemBuffer::try_new(scratch).expect("memory");
        symbolic
            .factorize_numeric_ldlt(
                &mut values,
                matrix,
                Side::Upper,
                Default::default(),
                par,
                MemStack::new(&mut mem),
                Default::default(),
            )
            .expect("factor");
        Self {
            symbolic,
            values,
            n: k.n,
        }
    }

    fn solve(&self, x: &[f64], y: &mut [f64]) {
        let mut rhs = Mat::<f64>::from_fn(self.n, 1, |i, _| x[i]);
        let par = Par::Seq;
        let scratch = self.symbolic.solve_in_place_scratch::<f64>(1, par);
        let mut mem = MemBuffer::try_new(scratch).expect("memory");
        LdltRef::new(&self.symbolic, &self.values).solve_in_place_with_conj(
            Conj::No,
            rhs.as_mut(),
            par,
            MemStack::new(&mut mem),
        );
        for i in 0..self.n {
            y[i] = rhs[(i, 0)];
        }
    }
}

struct ShiftInv {
    factor: Factored,
    s: Csc,
}

impl std::fmt::Debug for ShiftInv {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "ShiftInv({})", self.factor.n)
    }
}

impl LinOp<f64> for ShiftInv {
    fn apply_scratch(&self, _: usize, _: Par) -> faer::dyn_stack::StackReq {
        faer::dyn_stack::StackReq::empty()
    }
    fn nrows(&self) -> usize {
        self.factor.n
    }
    fn ncols(&self) -> usize {
        self.factor.n
    }
    fn apply(&self, mut out: MatMut<'_, f64>, rhs: MatRef<'_, f64>, _: Par, _: &mut MemStack) {
        let n = self.factor.n;
        let mut x = vec![0.0; n];
        let mut sx = vec![0.0; n];
        let mut y = vec![0.0; n];
        for col in 0..rhs.ncols() {
            for i in 0..n {
                x[i] = rhs[(i, col)];
            }
            self.s.spmv(&x, &mut sx);
            self.factor.solve(&sx, &mut y);
            for i in 0..n {
                out[(i, col)] = y[i];
            }
        }
    }
    fn conj_apply(&self, out: MatMut<'_, f64>, rhs: MatRef<'_, f64>, par: Par, stack: &mut MemStack) {
        self.apply(out, rhs, par, stack);
    }
}

struct Mode {
    /// 1/ω² or 1/λ, from the partial solver.
    mu: f64,
    /// Rayleigh quotient vᵀ K v / vᵀ S v.
    rayleigh: f64,
    v: Vec<f64>,
    w_share: f64,
}

fn lowest_modes(k: &Csc, s: &Csc, map: &DofMap, count: usize) -> (Vec<Mode>, f64) {
    let op = ShiftInv {
        factor: Factored::from_upper_k(k),
        s: Csc {
            n: s.n,
            col_ptr: s.col_ptr.clone(),
            row_idx: s.row_idx.clone(),
            val: s.val.clone(),
        },
    };
    // Ask for a few extra so a near-null or a complex pair does not hide a mode.
    let want = (count + 4).min(op.nrows().saturating_sub(1).max(1));
    let par = Par::Seq;
    let params = PartialEigenParams {
        min_dim: 24,
        max_dim: 48,
        max_restarts: 60,
        ..Default::default()
    };
    let scratch = partial_eigen_scratch(&op, want, par, params);
    let mut mem = MemBuffer::try_new(scratch).expect("memory");
    let mut vecs = Mat::<c64>::zeros(op.nrows(), want);
    let mut vals = vec![c64::ZERO; want];
    let v0 = faer::Col::<f64>::from_fn(op.nrows(), |i| {
        let mut h = i as u64;
        h = h.wrapping_mul(0x9E37_79B9_7F4A_7C15);
        ((h >> 33) as f64 / (u32::MAX as f64)) * 2.0 - 1.0
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
    let mut modes = Vec::new();
    for j in 0..info.n_converged_eigen {
        let mu = vals[j].re;
        if mu.abs() < 1e-18 || vals[j].im.abs() > 1e-6 * mu.abs().max(1e-30) && vals[j].im.abs() > 1e-8 {
            continue;
        }
        let v: Vec<f64> = (0..op.nrows()).map(|i| vecs[(i, j)].re).collect();
        let kk = k.quad(&v);
        let ss = s.quad(&v);
        if ss.abs() < 1e-30 * kk.abs().max(1.0) {
            continue;
        }
        let mut w2 = 0.0;
        let mut all2 = 0.0;
        for (node, slots) in map.node.iter().enumerate() {
            let _ = node;
            for (dof, &id) in slots.iter().enumerate() {
                if id == usize::MAX {
                    continue;
                }
                let c = v[id] * v[id];
                all2 += c;
                if dof == 2 {
                    w2 += c;
                }
            }
        }
        modes.push(Mode {
            mu,
            rayleigh: kk / ss,
            v,
            w_share: if all2 > 0.0 { w2 / all2 } else { 0.0 },
        });
    }
    modes.sort_by(|a, b| b.mu.partial_cmp(&a.mu).unwrap());
    modes.truncate(count);
    (modes, seconds)
}

// --- Building K (from the solver) and S (mass or −Kg).

fn k_and_map(model: &ShellModel, holds: &[ShellHold]) -> (Csc, DofMap) {
    let webs = model.web_rotations();
    let map = DofMap::build(model.mesh(), holds, &webs);
    let (n, upper) = model.stiffness_upper();
    assert_eq!(n, map.n, "free-dof count {} vs {}", n, map.n);
    let mut acc = Accum::new(n);
    for (r, c, v) in upper {
        acc.add(r, c, v);
        if r != c {
            acc.add(c, r, v);
        }
    }
    (acc.into_csc(), map)
}

#[derive(Clone, Copy)]
struct MassOpt {
    /// Consistent linear shape functions on u, v, w. Off: lumped ρ t A/3.
    consistent: bool,
    /// Rotary inertia ρ t³/12 on θx and θy, as a multiple of the physical value.
    rotary: f64,
    /// The same inertia on the drilling rotation θz, as a multiple of ρ t³/12.
    drill: f64,
    /// Rib translational mass, and rotary inertia on ψ as a multiple of ρ I L.
    beam_trans: bool,
    beam_psi: f64,
}

fn shell_mass(mesh: &ShellMesh, map: &DofMap, opt: MassOpt) -> Accum {
    let mut acc = Accum::new(map.n);
    for tri in &mesh.triangles {
        let p = tri.map(|i| mesh.vertices[i as usize]);
        let f = facet(p);
        let t = tri.map(|i| mesh.thickness[i as usize]).iter().sum::<f64>() / 3.0;
        let mass = RHO * t * f.area;
        if opt.consistent {
            // ∫ L_i L_j = A/12 (1 + δ_ij), so the factor on ρ t is that.
            for a in 0..3 {
                for b in 0..3 {
                    let m = mass * if a == b { 1.0 / 6.0 } else { 1.0 / 12.0 };
                    for dof in [0, 1, 2] {
                        acc.add_nodal(map, tri[a], dof, tri[b], dof, m);
                    }
                }
            }
        } else {
            let m = mass / 3.0;
            for a in 0..3 {
                for dof in [0, 1, 2] {
                    acc.add_nodal(map, tri[a], dof, tri[a], dof, m);
                }
            }
        }
        let rotary = RHO * t.powi(3) / 12.0 * f.area / 3.0;
        for a in 0..3 {
            if opt.rotary != 0.0 {
                acc.add_nodal(map, tri[a], 3, tri[a], 3, opt.rotary * rotary);
                acc.add_nodal(map, tri[a], 4, tri[a], 4, opt.rotary * rotary);
            }
            if opt.drill != 0.0 {
                acc.add_nodal(map, tri[a], 5, tri[a], 5, opt.drill * rotary);
            }
        }
    }
    acc
}

fn add_rib_mass(acc: &mut Accum, mesh: &ShellMesh, map: &DofMap, ribs: &[Rib], opt: MassOpt) {
    if !opt.beam_trans && opt.beam_psi == 0.0 {
        return;
    }
    let mut psi_of: HashMap<u32, usize> = HashMap::new();
    // ψ ids follow rib order, one per distinct vertex in each rib, which is
    // how the model numbers them when ribs do not share a vertex. The probe's
    // ribs are disjoint, so a running count matches `web_rotations`.
    let mut next = 0usize;
    for rib in ribs {
        let mut seen = Vec::new();
        for &(a, b) in &rib.edges {
            for v in [a, b] {
                if !seen.contains(&v) {
                    seen.push(v);
                    psi_of.insert(v, next);
                    next += 1;
                }
            }
        }
        let props = rib.section.properties(rib.height).unwrap();
        for &(a, b) in &rib.edges {
            let pa = mesh.vertices[a as usize];
            let pb = mesh.vertices[b as usize];
            let len = norm(sub(pb, pa));
            let x = scale(sub(pb, pa), 1.0 / len);
            let up = [0.0, 0.0, 1.0];
            let z = up;
            let y = cross(z, x);
            let sign = match rib.side {
                RibSide::Positive => 1.0,
                RibSide::Negative => -1.0,
                RibSide::Centered => 0.0,
            };
            let tmid = 0.5 * (mesh.thickness[a as usize] + mesh.thickness[b as usize]);
            let foot = scale(z, sign * 0.5 * tmid);
            let up_web = scale(z, sign * props.centroid);
            let g = rib_map(foot, up_web, y);
            let m = RHO * props.area * len / 2.0;
            let j = opt.beam_psi * RHO * props.i_across * len / 2.0;
            for (end, node) in [(0usize, a), (1usize, b)] {
                let psi = map.psi[psi_of[&node]];
                let mut ids = [usize::MAX; 7];
                for k in 0..6 {
                    ids[k] = map.node[node as usize][k];
                }
                ids[6] = psi;
                if opt.beam_trans {
                    for c1 in 0..7 {
                        for c2 in 0..7 {
                            let mut s = 0.0;
                            for i in 0..3 {
                                s += g[i][c1] * g[i][c2];
                            }
                            acc.add_psi(ids[c1], ids[c2], m * s);
                        }
                    }
                }
                if j != 0.0 {
                    acc.add_psi(ids[6], ids[6], j);
                }
                let _ = end;
            }
        }
    }
}

fn rib_map(foot: [f64; 3], up_web: [f64; 3], lateral: [f64; 3]) -> [[f64; 7]; 6] {
    let y = lateral;
    let mut p = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            p[i][j] = (if i == j { 1.0 } else { 0.0 }) - y[i] * y[j];
        }
    }
    let st = skew(foot);
    let sh = skew(up_web);
    let mut g = [[0.0; 7]; 6];
    for i in 0..3 {
        g[i][i] = 1.0;
        for j in 0..3 {
            let shp: f64 = (0..3).map(|q| sh[i][q] * p[q][j]).sum();
            g[i][3 + j] = -st[i][j] - shp;
            g[3 + i][3 + j] = p[i][j];
        }
        g[i][6] = -(0..3).map(|q| sh[i][q] * y[q]).sum::<f64>();
        g[3 + i][6] = y[i];
    }
    g
}

fn skew(e: [f64; 3]) -> [[f64; 3]; 3] {
    [[0.0, -e[2], e[1]], [e[2], 0.0, -e[0]], [-e[1], e[0], 0.0]]
}

fn geometric_of(
    mesh: &ShellMesh,
    uv: &[( [f64; 3], [f64; 3] )],
    map: &DofMap,
    plate: bool,
    membrane: bool,
) -> (Accum, f64, f64) {
    let mut acc = Accum::new(map.n);
    let mut nxx = 0.0;
    let mut nyy = 0.0;
    let mut area = 0.0;
    let a_mat_scale = |t: f64| membrane_matrix(t);
    for tri in &mesh.triangles {
        let p = tri.map(|i| mesh.vertices[i as usize]);
        let f = facet(p);
        let t = tri.map(|i| mesh.thickness[i as usize]).iter().sum::<f64>() / 3.0;
        let mut local_u = [[0.0; 2]; 3];
        for a in 0..3 {
            let u = uv[tri[a] as usize].0;
            local_u[a] = [dot(f.e1, u), dot(f.e2, u)];
        }
        let eps = cst_strain(&f.xy, &local_u);
        let nforce = matvec3(&a_mat_scale(t), eps);
        // Element-frame forces, rotated into global x, y. The two triangles
        // of a cell do not share a frame, so an element-frame average is
        // not Nxx.
        let (e1, e2) = (f.e1, f.e2);
        let nxx_g = e1[0] * e1[0] * nforce[0]
            + e2[0] * e2[0] * nforce[1]
            + 2.0 * e1[0] * e2[0] * nforce[2];
        let nyy_g = e1[1] * e1[1] * nforce[0]
            + e2[1] * e2[1] * nforce[1]
            + 2.0 * e1[1] * e2[1] * nforce[2];
        nxx += nxx_g * f.area;
        nyy += nyy_g * f.area;
        area += f.area;
        if plate {
            let kg = plate_kg(&f.xy, f.area, nforce);
            add_bending_global(&mut acc, map, *tri, &f, &kg);
        }
        if membrane {
            let kg = membrane_kg(&f.xy, f.area, nforce);
            add_membrane_global(&mut acc, map, *tri, &f, &kg);
        }
    }
    (acc, nxx / area, nyy / area)
}

// --- Boundaries.

fn on_box(p: [f64; 3], a: f64, b: f64) -> (bool, bool) {
    let on_x = p[0].abs() < TOL || (p[0] - a).abs() < TOL;
    let on_y = p[1].abs() < TOL || (p[1] - b).abs() < TOL;
    (on_x, on_y)
}

fn simple_holds(mesh: &ShellMesh, a: f64, b: f64) -> Vec<ShellHold> {
    let mut holds = Vec::new();
    for (i, p) in mesh.vertices.iter().enumerate() {
        let (on_x, on_y) = on_box(*p, a, b);
        if on_x || on_y {
            holds.push(ShellHold::fixed(i as u32, [true, true, true, on_x, on_y, false]));
        }
    }
    holds
}

fn clamped_holds(mesh: &ShellMesh, a: f64, b: f64) -> Vec<ShellHold> {
    let mut holds = Vec::new();
    for (i, p) in mesh.vertices.iter().enumerate() {
        let (on_x, on_y) = on_box(*p, a, b);
        if on_x || on_y {
            holds.push(ShellHold::clamped(i as u32));
        }
    }
    holds
}

/// Simply supported bending, uniaxial compression along x: ux fixed on
/// x = 0, uy fixed at the origin only, so Poisson can expand.
fn compression_holds(mesh: &ShellMesh, a: f64, b: f64) -> Vec<ShellHold> {
    let mut holds = Vec::new();
    for (i, p) in mesh.vertices.iter().enumerate() {
        let (on_x, on_y) = on_box(*p, a, b);
        if !(on_x || on_y) {
            continue;
        }
        let ux = p[0].abs() < TOL;
        let uy = p[0].abs() < TOL && p[1].abs() < TOL;
        holds.push(ShellHold::fixed(i as u32, [ux, uy, true, on_x, on_y, false]));
    }
    holds
}

fn compression_load(mesh: &ShellMesh, a: f64, b: f64, ny: usize, n_per_length: f64) -> Vec<ShellLoad> {
    let dy = b / ny as f64;
    let mut loads = Vec::new();
    for (i, p) in mesh.vertices.iter().enumerate() {
        if (p[0] - a).abs() < TOL {
            let share = if p[1].abs() < TOL || (p[1] - b).abs() < TOL {
                0.5
            } else {
                1.0
            };
            loads.push(ShellLoad::Force {
                node: i as u32,
                force: [-n_per_length * dy * share, 0.0, 0.0],
            });
        }
    }
    loads
}

fn solve_disp(mesh: ShellMesh, holds: &[ShellHold], loads: &[ShellLoad]) -> (ShellModel, Vec<([f64; 3], [f64; 3])>, f64) {
    let mut model = ShellModel::new(mesh, material(), holds, ShellOptions::default()).unwrap();
    model.set_threads(1);
    let started = Instant::now();
    let r = model.solve(loads).unwrap();
    let seconds = started.elapsed().as_secs_f64();
    let uv = r
        .displacement
        .iter()
        .zip(&r.rotation)
        .map(|(u, th)| (*u, *th))
        .collect();
    (model, uv, seconds)
}

fn hz(omega: f64) -> f64 {
    omega / (2.0 * std::f64::consts::PI)
}

fn print_freq(label: &str, mesh: &str, got: f64, reference: f64) -> f64 {
    let err = (got - reference) / reference;
    eprintln!(
        "| {label} | {mesh} | {got:.6e} | {reference:.6e} | {:+.3} % |",
        100.0 * err
    );
    err
}

fn mass_default() -> MassOpt {
    MassOpt {
        consistent: true,
        rotary: 0.0,
        drill: 0.0,
        beam_trans: false,
        beam_psi: 0.0,
    }
}

fn frequencies(mesh: &ShellMesh, holds: &[ShellHold], opt: MassOpt, ribs: &[Rib], count: usize) -> (Vec<Mode>, f64, usize) {
    let mut model = ShellModel::new(mesh.clone(), material(), holds, ShellOptions::default()).unwrap();
    model.set_threads(1);
    if !ribs.is_empty() {
        model.set_ribs(ribs.to_vec()).unwrap();
    }
    let (k, map) = k_and_map(&model, holds);
    let mut acc = shell_mass(mesh, &map, opt);
    add_rib_mass(&mut acc, mesh, &map, ribs, opt);
    let s = acc.into_csc();
    let (modes, seconds) = lowest_modes(&k, &s, &map, count);
    (modes, seconds, map.n)
}

// --- Beam geometric stiffness, standalone, tension-positive P. ---

fn beam_elastic(l: f64, ea: f64, eiy: f64, eiz: f64, gj: f64, gay: f64, gaz: f64) -> [[f64; 12]; 12] {
    // Local [u, v, w, θx, θy, θz] at each end. v bends about z, w about y
    // with θy = −dw/dx. Same layout as beam.rs.
    let mut k = [[0.0; 12]; 12];
    let set = |k: &mut [[f64; 12]; 12], i: usize, j: usize, v: f64| {
        k[i][j] = v;
        k[j][i] = v;
    };
    let phi_y = 12.0 * eiz / (gay * l * l);
    let phi_z = 12.0 * eiy / (gaz * l * l);
    let a = eiz / ((1.0 + phi_y) * l.powi(3));
    let b = eiy / ((1.0 + phi_z) * l.powi(3));
    set(&mut k, 0, 0, ea / l);
    set(&mut k, 6, 6, ea / l);
    set(&mut k, 0, 6, -ea / l);
    set(&mut k, 3, 3, gj / l);
    set(&mut k, 9, 9, gj / l);
    set(&mut k, 3, 9, -gj / l);
    set(&mut k, 1, 1, 12.0 * a);
    set(&mut k, 1, 5, 6.0 * a * l);
    set(&mut k, 1, 7, -12.0 * a);
    set(&mut k, 1, 11, 6.0 * a * l);
    set(&mut k, 5, 5, (4.0 + phi_y) * a * l * l);
    set(&mut k, 5, 7, -6.0 * a * l);
    set(&mut k, 5, 11, (2.0 - phi_y) * a * l * l);
    set(&mut k, 7, 7, 12.0 * a);
    set(&mut k, 7, 11, -6.0 * a * l);
    set(&mut k, 11, 11, (4.0 + phi_y) * a * l * l);
    set(&mut k, 2, 2, 12.0 * b);
    set(&mut k, 2, 4, -6.0 * b * l);
    set(&mut k, 2, 8, -12.0 * b);
    set(&mut k, 2, 10, -6.0 * b * l);
    set(&mut k, 4, 4, (4.0 + phi_z) * b * l * l);
    set(&mut k, 4, 8, 6.0 * b * l);
    set(&mut k, 4, 10, (2.0 - phi_z) * b * l * l);
    set(&mut k, 8, 8, 12.0 * b);
    set(&mut k, 8, 10, 6.0 * b * l);
    set(&mut k, 10, 10, (4.0 + phi_z) * b * l * l);
    k
}

/// Geometric stiffness at axial tension +1, cubic Hermitian. Compression
/// uses a negative factor. θy = −dw/dx, so that plane's signs flip.
fn beam_kg_tension(l: f64) -> [[f64; 12]; 12] {
    let mut k = [[0.0; 12]; 12];
    let set = |k: &mut [[f64; 12]; 12], i: usize, j: usize, v: f64| {
        k[i][j] = v;
        k[j][i] = v;
    };
    let s = 1.0 / (30.0 * l);
    // v, θz = dv/dx. Standard cubic form.
    let g = |i: usize| match i {
        0 => 1,
        1 => 5,
        2 => 7,
        _ => 11,
    };
    let m = [
        [36.0, 3.0 * l, -36.0, 3.0 * l],
        [3.0 * l, 4.0 * l * l, -3.0 * l, -l * l],
        [-36.0, -3.0 * l, 36.0, -3.0 * l],
        [3.0 * l, -l * l, -3.0 * l, 4.0 * l * l],
    ];
    for i in 0..4 {
        for j in 0..4 {
            set(&mut k, g(i), g(j), s * m[i][j]);
        }
    }
    // w, θy = −dw/dx: conjugate the slope dofs by a minus.
    let h = |i: usize| match i {
        0 => 2,
        1 => 4,
        2 => 8,
        _ => 10,
    };
    let sign = |i: usize| if i == 1 || i == 3 { -1.0 } else { 1.0 };
    for i in 0..4 {
        for j in 0..4 {
            set(&mut k, h(i), h(j), s * m[i][j] * sign(i) * sign(j));
        }
    }
    k
}

// --- Tests.

#[test]
fn rectangular_plate_frequencies_within_two_percent() {
    // 200 × 100 × 1, simply supported. Modes (1,1), (2,1), (3,1), (1,2).
    let (a, b, t) = (200.0, 100.0, 1.0);
    let modes = [(1, 1), (2, 1), (3, 1), (1, 2)];
    let refs: Vec<f64> = modes.iter().map(|(m, n)| omega_mn(a, b, t, *m, *n)).collect();
    eprintln!("| SS rectangle {a}×{b}×{t} | mesh | ω rad/s | closed form | error |");
    let mut finest = Vec::new();
    for (nx, ny, consistent) in [(8, 4, true), (16, 8, true), (32, 16, true), (32, 16, false)] {
        let mesh = ShellMesh::rectangle([a, b], [nx, ny], t);
        let holds = simple_holds(&mesh, a, b);
        let mut opt = mass_default();
        opt.consistent = consistent;
        let (got, seconds, n) = frequencies(&mesh, &holds, opt, &[], 4);
        let kind = if consistent { "consistent" } else { "lumped" };
        eprintln!("mesh {nx}×{ny}×2  {kind}  dofs {n}  eigen {seconds:.3} s");
        let mut errs = Vec::new();
        for (i, mode) in got.iter().enumerate() {
            let w = mode.rayleigh.sqrt();
            errs.push(print_freq(
                &format!("({m},{n}) {kind}", m = modes[i].0, n = modes[i].1),
                &format!("{nx}×{ny}"),
                w,
                refs[i],
            ));
            eprintln!("    w-share {:.3}  μ {:.6e}", mode.w_share, mode.mu);
        }
        if nx == 32 && consistent {
            finest = errs;
        }
    }
    assert!(finest.len() == 4, "expected 4 modes");
    for (i, e) in finest.iter().enumerate() {
        assert!(e.abs() < 0.02, "mode {} error {e}", i + 1);
    }
}

#[test]
fn square_plate_buckling_within_two_percent() {
    let (a, t) = (100.0, 1.0);
    let ncr = 4.0 * std::f64::consts::PI.powi(2) * rigidity(t) / (a * a);
    eprintln!("| SS square buckling | mesh | N_cr | 4 π² D/b² | error |");
    eprintln!("reference N_cr = {ncr:.6e} N/mm");
    let mut finest = 1.0;
    let mut with_membrane = 1.0;
    for n in [8usize, 16, 32] {
        let mesh = ShellMesh::rectangle([a, a], [n, n], t);
        let holds = compression_holds(&mesh, a, a);
        let load = compression_load(&mesh, a, a, n, 1.0);
        let (model, uv, static_s) = solve_disp(mesh.clone(), &holds, &load);
        let (k, map) = k_and_map(&model, &holds);
        let (gp, nxx, nyy) = geometric_of(&mesh, &uv, &map, true, false);
        let (gb, _, _) = geometric_of(&mesh, &uv, &map, true, true);
        // S = −Kg so the load factor is the eigenvalue of K φ = λ S φ,
        // and the partial solver's largest 1/λ is the lowest factor.
        let mut sp = Accum::new(map.n);
        for ((r, c), v) in &gp.upper {
            sp.add(*r, *c, -v);
        }
        let mut sb = Accum::new(map.n);
        for ((r, c), v) in &gb.upper {
            sb.add(*r, *c, -v);
        }
        let (modes, eigen_s) = lowest_modes(&k, &sp.into_csc(), &map, 1);
        let (both, _) = lowest_modes(&k, &sb.into_csc(), &map, 1);
        let lam = modes[0].rayleigh;
        finest = print_freq("plate Kg", &format!("{n}×{n}"), lam, ncr);
        let both_err = print_freq("plate+membrane Kg", &format!("{n}×{n}"), both[0].rayleigh, ncr);
        eprintln!(
            "    Nxx {nxx:.4} Nyy {nyy:.4}  static {static_s:.3} s  eigen {eigen_s:.3} s  dofs {}  w-share {:.3}",
            map.n, modes[0].w_share
        );
        if n == 32 {
            with_membrane = both_err;
        }
    }
    assert!(finest.abs() < 0.02, "plate Kg {finest}");
    assert!(with_membrane.abs() < 0.02, "membrane Kg moved the load to {with_membrane}");
}

#[test]
fn clamped_square_frequency_against_leissa() {
    // Leissa, Vibration of Plates, NASA SP-160, 1969: λ₁ = ω a² √(ρ h / D) = 35.99.
    let (a, t) = (100.0, 1.0);
    let lambda_ref = 35.99;
    let scale = (a * a) * (RHO * t / rigidity(t)).sqrt();
    eprintln!("| clamped square | mesh | λ | 35.99 | error |");
    let mut finest = 1.0;
    for n in [8usize, 16, 32] {
        let mesh = ShellMesh::rectangle([a, a], [n, n], t);
        let holds = clamped_holds(&mesh, a, a);
        let (modes, seconds, nd) = frequencies(&mesh, &holds, mass_default(), &[], 3);
        let lambda = modes[0].rayleigh.sqrt() * scale;
        finest = print_freq("λ1", &format!("{n}×{n}"), lambda, lambda_ref);
        let l2 = modes[1].rayleigh.sqrt() * scale;
        let l3 = modes[2].rayleigh.sqrt() * scale;
        eprintln!("    λ2 {l2:.3} λ3 {l3:.3}  eigen {seconds:.3} s  dofs {nd}");
    }
    assert!(finest.abs() < 0.02, "clamped {finest}");
}

#[test]
fn drilling_and_web_mass_move_the_lowest_modes() {
    let (a, b, t) = (200.0, 100.0, 1.0);
    let mesh = ShellMesh::rectangle([a, b], [16, 8], t);
    let holds = simple_holds(&mesh, a, b);
    let reference = omega_mn(a, b, t, 1, 1);
    let variants = [
        ("consistent, no rotary", MassOpt { consistent: true, rotary: 0.0, drill: 0.0, beam_trans: false, beam_psi: 0.0 }),
        ("lumped, no rotary", MassOpt { consistent: false, rotary: 0.0, drill: 0.0, beam_trans: false, beam_psi: 0.0 }),
        ("physical rotary and drill", MassOpt { consistent: true, rotary: 1.0, drill: 1.0, beam_trans: false, beam_psi: 0.0 }),
        ("drill × 1e6 physical", MassOpt { consistent: true, rotary: 0.0, drill: 1.0e6, beam_trans: false, beam_psi: 0.0 }),
    ];
    eprintln!("| mass on the bare plate | ω1 | closed form | error | lowest w-share |");
    for (name, opt) in variants {
        let (modes, _, _) = frequencies(&mesh, &holds, opt, &[], 4);
        let w = modes[0].rayleigh.sqrt();
        print_freq(name, "16×8", w, reference);
        eprintln!(
            "    shares {}",
            modes.iter().map(|m| format!("{:.2}", m.w_share)).collect::<Vec<_>>().join(" ")
        );
    }

    // One rib across the short span of a clamped 120 × 70 panel.
    let (a, b, t) = (120.0, 70.0, 2.0);
    let (nx, ny) = (12usize, 7usize);
    let mesh = ShellMesh::rectangle([a, b], [nx, ny], t);
    let holds = clamped_holds(&mesh, a, b);
    let id = |i: usize, j: usize| (i + (nx + 1) * j) as u32;
    let col = nx / 2;
    let edges: Vec<(u32, u32)> = (0..ny).map(|j| (id(col, j), id(col, j + 1))).collect();
    let rib = Rib::rectangular(edges, 2.0, 8.0, RibSide::Positive);
    eprintln!("| ribbed 120×70, centre rib 2×8 | ω1 rad/s | against no beam mass |");
    let base_opt = MassOpt {
        consistent: true,
        rotary: 0.0,
        drill: 0.0,
        beam_trans: false,
        beam_psi: 0.0,
    };
    let (base, _, _) = frequencies(&mesh, &holds, base_opt, &[rib.clone()], 1);
    let w0 = base[0].rayleigh.sqrt();
    let rib_variants = [
        ("shell mass only", MassOpt { beam_trans: false, beam_psi: 0.0, ..base_opt }),
        ("beam translation, ψ rotary 0", MassOpt { beam_trans: true, beam_psi: 0.0, ..base_opt }),
        ("beam translation + physical ψ", MassOpt { beam_trans: true, beam_psi: 1.0, ..base_opt }),
        ("beam translation + ψ × 1e4", MassOpt { beam_trans: true, beam_psi: 1.0e4, ..base_opt }),
    ];
    for (name, opt) in rib_variants {
        let (modes, _, _) = frequencies(&mesh, &holds, opt, &[rib.clone()], 1);
        let w = modes[0].rayleigh.sqrt();
        print_freq(name, "12×7", w, w0);
    }
}

#[test]
fn repeated_pair_score_swings_with_the_vector() {
    // Square plate, modes (2,1) and (1,2) share ω. A rib on y = a/2 sits on
    // the node line of one of them.
    let (a, t, n) = (100.0, 1.0, 12usize);
    let mesh = ShellMesh::rectangle([a, a], [n, n], t);
    let holds = simple_holds(&mesh, a, a);
    let (modes, _, _) = frequencies(&mesh, &holds, mass_default(), &[], 4);
    let w2 = modes[1].rayleigh.sqrt();
    let w3 = modes[2].rayleigh.sqrt();
    eprintln!(
        "bare ω2 {:.6e} ω3 {:.6e}  relative gap {:+.4} %",
        w2,
        w3,
        100.0 * (w3 - w2) / w2
    );
    let id = |i: usize, j: usize| (i + (n + 1) * j) as u32;
    let row = n / 2;
    let edges: Vec<(u32, u32)> = (0..n).map(|i| (id(i, row), id(i + 1, row))).collect();
    let rib = Rib::rectangular(edges, 1.2, 6.0, RibSide::Positive);
    let mut model = ShellModel::new(mesh.clone(), material(), &holds, ShellOptions::default()).unwrap();
    // Rebuild nodal vectors from the free eigenvector.
    let map = DofMap::build(&mesh, &holds, &[]);
    let nodal = |v: &[f64]| -> (Vec<[f64; 3]>, Vec<[f64; 3]>) {
        let mut u = vec![[0.0; 3]; mesh.vertices.len()];
        let mut th = vec![[0.0; 3]; mesh.vertices.len()];
        for (i, slots) in map.node.iter().enumerate() {
            for k in 0..3 {
                if slots[k] != usize::MAX {
                    u[i][k] = v[slots[k]];
                }
                if slots[3 + k] != usize::MAX {
                    th[i][k] = v[slots[3 + k]];
                }
            }
        }
        (u, th)
    };
    let fake = |u: Vec<[f64; 3]>, th: Vec<[f64; 3]>| ShellResult {
        displacement: u,
        rotation: th,
        strain_energy: 0.0,
        compliance: 0.0,
        elements: Vec::new(),
        rib_energy: Vec::new(),
        max_deflection: 0.0,
        max_deflection_node: 0,
        max_deflection_at: [0.0; 3],
        pivot_ratio: 1.0,
    };
    let energy = |v: &[f64]| {
        let (u, th) = nodal(v);
        model.probe_rib_energy(&rib, &fake(u, th)).unwrap()
    };
    // Scores of the two raw vectors and of mixtures. probe_rib_energy is
    // ½ φᵀ ΔK φ with ψ relaxed, so Δ(ω²) ≈ 2 E / (φᵀ M φ).
    let (k, map2) = k_and_map(&model, &holds);
    let s = shell_mass(&mesh, &map2, mass_default()).into_csc();
    let mnorm = |v: &[f64]| s.quad(v);
    eprintln!("| mixture angle | 2E / φᵀMφ  (Δω² estimate) |");
    let mut scores = Vec::new();
    for deg in [0.0, 15.0, 30.0, 45.0, 60.0, 75.0, 90.0] {
        let r = (deg as f64).to_radians();
        let v: Vec<f64> = modes[1]
            .v
            .iter()
            .zip(&modes[2].v)
            .map(|(a, b)| a * r.cos() + b * r.sin())
            .collect();
        let est = 2.0 * energy(&v) / mnorm(&v);
        scores.push(est);
        eprintln!("| {deg:>4.0}° | {est:.6e} |");
    }
    let (with, _, _) = frequencies(&mesh, &holds, mass_default(), &[rib.clone()], 4);
    eprintln!(
        "after the rib: ω1 {:.6e} ω2 {:.6e} ω3 {:.6e} ω4 {:.6e}",
        with[0].rayleigh.sqrt(),
        with[1].rayleigh.sqrt(),
        with[2].rayleigh.sqrt(),
        with[3].rayleigh.sqrt()
    );
    let min = scores.iter().cloned().fold(f64::INFINITY, f64::min);
    let max = scores.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    eprintln!("score range {min:.6e} .. {max:.6e}  ratio {:.3}", max / min.max(1e-30));
    // The two eigenvalues of the projected ΔK in this subspace. They do not
    // depend on which basis vector the solver returned.
    let a = &modes[1].v;
    let b = &modes[2].v;
    let k11 = 2.0 * energy(a);
    let k22 = 2.0 * energy(b);
    let sumv: Vec<f64> = a.iter().zip(b).map(|(p, q)| p + q).collect();
    let k12 = energy(&sumv) - energy(a) - energy(b);
    let m11 = mnorm(a);
    let m22 = mnorm(b);
    let m12 = s.bilinear(a, b);
    // det(K − λ M) = 0 for the 2×2.
    let aq = m11 * m22 - m12 * m12;
    let bq = -(k11 * m22 + k22 * m11 - 2.0 * k12 * m12);
    let cq = k11 * k22 - k12 * k12;
    let disc = (bq * bq - 4.0 * aq * cq).max(0.0).sqrt();
    let l_lo = (-bq - disc) / (2.0 * aq);
    let l_hi = (-bq + disc) / (2.0 * aq);
    eprintln!(
        "2×2 cluster Δω²  low {l_lo:.6e}  high {l_hi:.6e}  sum {:.6e}  ratio {:.3}",
        l_lo + l_hi,
        l_hi / l_lo.abs().max(1e-30)
    );
    let _ = k;
    assert!((w3 - w2).abs() / w2 < 0.02, "the pair is not repeated: {w2} {w3}");
    assert!(
        l_hi > 1.5 * l_lo.abs().max(1e-6),
        "the rib did not split the pair: {l_lo} {l_hi}"
    );
}

#[test]
fn beam_buckling_against_euler() {
    // Simply supported beam, weak-axis bending, 8 elements. P_cr = π² E I / L².
    let (l_tot, n) = (200.0, 8usize);
    let l = l_tot / n as f64;
    let (e, g) = (E, E / (2.0 * (1.0 + NU)));
    let (width, height) = (8.0_f64, 2.0_f64); 
    // i about the axis for w-bending (θy): height is the thickness in z, I = width * height³ / 12.
    let i_w = width * height.powi(3) / 12.0;
    let i_v = height * width.powi(3) / 12.0;
    let area = width * height;
    let torsion = width * height.powi(3) / 3.0 * (1.0 - 0.63 * height / width);
    let ea = e * area;
    let eiy = e * i_w;
    let eiz = e * i_v;
    let gj = g * torsion;
    let gay = g * area * 5.0 / 6.0;
    let gaz = gay;
    let ke = beam_elastic(l, ea, eiy, eiz, gj, gay, gaz);
    let kg = beam_kg_tension(l);
    // Assemble a chain. Dofs: 6 per node.
    let nodes = n + 1;
    let nd = 6 * nodes;
    let mut k = vec![0.0; nd * nd];
    let mut s = vec![0.0; nd * nd];
    let add = |m: &mut [f64], i: usize, j: usize, v: f64| {
        m[i * nd + j] += v;
    };
    for e in 0..n {
        for i in 0..12 {
            for j in 0..12 {
                // i 0..5 is node e, i 6..11 is node e+1: 6*(e+1) + (i-6) = 6*e + i.
                // Kg is for unit tension, so K φ = P Kg φ and the positive root is the compressive load.
                add(&mut k, 6 * e + i, 6 * e + j, ke[i][j]);
                add(&mut s, 6 * e + i, 6 * e + j, kg[i][j]);
            }
        }
    }
    let _ = add;
    // Holds: u = 0 at node 0; v = w = 0 at both ends; θx = 0 at node 0 (no spin).
    let mut held = vec![false; nd];
    held[0] = true; // u
    held[1] = true; // v
    held[2] = true; // w
    held[3] = true; // θx
    held[6 * n + 1] = true;
    held[6 * n + 2] = true;
    let free: Vec<usize> = (0..nd).filter(|&i| !held[i]).collect();
    let nf = free.len();
    let kd = Mat::<f64>::from_fn(nf, nf, |i, j| k[free[i] * nd + free[j]]);
    let sd = Mat::<f64>::from_fn(nf, nf, |i, j| s[free[i] * nd + free[j]]);
    let ev = kd.generalized_eigen(&sd).expect("euler");
    let mut lams: Vec<f64> = ev
        .S_a()
        .column_vector()
        .iter()
        .zip(ev.S_b().column_vector().iter())
        .filter_map(|(sa, sb)| {
            if sb.re.abs() < 1e-12 {
                return None;
            }
            let l = sa.re / sb.re;
            if l.is_finite() && l > 0.0 {
                Some(l)
            } else {
                None
            }
        })
        .collect();
    lams.sort_by(|a, b| a.partial_cmp(b).unwrap());
    assert!(!lams.is_empty(), "no positive buckling load");
    let p = lams[0];
    let euler_w = std::f64::consts::PI.powi(2) * eiy / (l_tot * l_tot);
    let euler_v = std::f64::consts::PI.powi(2) * eiz / (l_tot * l_tot);
    let euler = euler_w.min(euler_v);
    let err = (p - euler) / euler;
    eprintln!(
        "| SS beam {n} elements | P {p:.6e} | Euler {euler:.6e} | {:+.3} % | next {:+.6e} |",
        100.0 * err,
        lams.get(1).copied().unwrap_or(0.0)
    );
    assert!(err.abs() < 0.02, "{err} p {p} euler {euler}");
}

#[test]
fn frequency_score_against_compliance_ribs() {
    // 120 × 70 clamped panel, the size named in the brief, at the planner
    // tests' 5 mm pitch. Timing is one static solve against one eigen solve.
    let (a, b, t) = (120.0, 70.0, 2.0);
    let (nx, ny) = (24usize, 14usize);
    let mesh = ShellMesh::rectangle([a, b], [nx, ny], t);
    let holds = clamped_holds(&mesh, a, b);
    let mut model = ShellModel::new(mesh.clone(), material(), &holds, ShellOptions::default()).unwrap();
    model.set_threads(1);
    let load = vec![ShellLoad::Pressure {
        triangles: (0..mesh.triangles.len() as u32).collect(),
        pressure: 0.001,
    }];
    let t0 = Instant::now();
    let bare = model.solve(&load).unwrap();
    let static_s = t0.elapsed().as_secs_f64();
    let (k, map) = k_and_map(&model, &holds);
    let s = shell_mass(&mesh, &map, mass_default()).into_csc();
    let (modes, eigen_s) = lowest_modes(&k, &s, &map, 3);
    eprintln!(
        "120×70 div {nx}×{ny}  dofs {}  triangles {}  static {:.3} s (factor {:.3} + solve {:.3})  eigen {:.3} s  ω1 {:.6e}",
        map.n,
        mesh.triangles.len(),
        static_s,
        model.timings().factor,
        model.timings().solve,
        eigen_s,
        modes[0].rayleigh.sqrt()
    );
    eprintln!("bare compliance {:.6e}", bare.compliance);
}

#[test]
fn frequency_versus_compliance_ranking() {
    let (a, b, t) = (120.0, 70.0, 2.0);
    let (nx, ny) = (12usize, 7usize);
    let mesh = ShellMesh::rectangle([a, b], [nx, ny], t);
    let holds = clamped_holds(&mesh, a, b);
    let id = |i: usize, j: usize| (i + (nx + 1) * j) as u32;
    let pool: Vec<Rib> = (1..nx)
        .map(|col| {
            let edges: Vec<(u32, u32)> = (0..ny).map(|j| (id(col, j), id(col, j + 1))).collect();
            Rib::rectangular(edges, 1.2, 6.0, RibSide::Positive)
        })
        .collect();
    let pressure = vec![ShellLoad::Pressure {
        triangles: (0..mesh.triangles.len() as u32).collect(),
        pressure: 0.001,
    }];
    // A load near one short edge, so the compliance ribs and the first-mode ribs can disagree.
    let near = mesh.nearest_vertex([15.0, 35.0, 0.0]);
    let point = vec![ShellLoad::Force {
        node: near,
        force: [0.0, 0.0, -10.0],
    }];
    let measure = |ribs: &[Rib], load: &[ShellLoad]| -> (f64, f64) {
        let mut model = ShellModel::new(mesh.clone(), material(), &holds, ShellOptions::default()).unwrap();
        model.set_threads(1);
        if !ribs.is_empty() {
            model.set_ribs(ribs.to_vec()).unwrap();
        }
        let c = model.solve(load).unwrap().compliance;
        let (modes, _, _) = frequencies(&mesh, &holds, mass_default(), ribs, 1);
        (c, hz(modes[0].rayleigh.sqrt()))
    };
    let grow = |load: &[ShellLoad], by_freq: bool, n_ribs: usize| -> Vec<Rib> {
        let mut left = pool.clone();
        let mut chosen = Vec::new();
        for _ in 0..n_ribs {
            let (c_now, f_now) = measure(&chosen, load);
            let mut best = (f64::MIN, 0usize);
            for (i, rib) in left.iter().enumerate() {
                let mut trial = chosen.clone();
                trial.push(rib.clone());
                let (c, f) = measure(&trial, load);
                let gain = if by_freq { f - f_now } else { c_now - c };
                if gain > best.0 {
                    best = (gain, i);
                }
            }
            chosen.push(left.swap_remove(best.1));
        }
        chosen
    };
    let col_of = |rib: &Rib| rib.edges[0].0 as usize % (nx + 1);
    let mut with_mass = mass_default();
    with_mass.beam_trans = true;
    with_mass.beam_psi = 1.0;
    let freq_with_mass = |ribs: &[Rib]| -> f64 {
        let (modes, _, _) = frequencies(&mesh, &holds, with_mass, ribs, 1);
        hz(modes[0].rayleigh.sqrt())
    };
    for (name, load) in [("pressure", &pressure), ("point near x=15", &point)] {
        let (c0, f0) = measure(&[], load);
        let comp = grow(load, false, 2);
        let freq = grow(load, true, 2);
        let (cc, cf) = measure(&comp, load);
        let (fc, ff) = measure(&freq, load);
        let cf_m = freq_with_mass(&comp);
        let ff_m = freq_with_mass(&freq);
        eprintln!(
            "| {name} | bare C {c0:.4e} f {f0:.4} Hz | compliance cols {:?} C {cc:.4e} ({:.3}×) f {cf:.4} Hz ({:+.2} %) with mass {cf_m:.4} | frequency cols {:?} C {fc:.4e} ({:.3}×) f {ff:.4} Hz ({:+.2} %) with mass {ff_m:.4} |",
            comp.iter().map(col_of).collect::<Vec<_>>(),
            c0 / cc,
            100.0 * (cf - f0) / f0,
            freq.iter().map(col_of).collect::<Vec<_>>(),
            c0 / fc,
            100.0 * (ff - f0) / f0
        );
    }
    // Today's planner, same panel, a budget of about two of these ribs.
    let mut req = RibPlanRequest::new(mesh.clone(), material());
    req.goal = Goal::Budget { volume_mm3: 2.0 * 1.2 * 6.0 * b };
    req.options.baselines = false;
    req.options.workers = 1;
    let plan = plan_ribs(&req).expect("plan");
    eprintln!(
        "planner budget {:.1} mm³ used {:.1} mm³  ribs {}  stiffness ×{:.3}  C bare {:.4e} ribbed {:.4e}",
        2.0 * 1.2 * 6.0 * b,
        plan.rib_volume_mm3,
        plan.ribs.len(),
        plan.stiffness_factor,
        plan.bare.compliance,
        plan.ribbed.compliance
    );
    let _ = (pool, PlannerOptions::default());
}
