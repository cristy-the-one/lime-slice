//! The shell model: mesh, holds and ribs in; displacements, energies and
//! principal directions out.

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use std::time::Instant;

use faer::sparse::linalg::cholesky::SymbolicCholesky;
use faer::Mat;
use rayon::prelude::*;

use super::beam::{self, BeamSection, RibEnd, K14};
use super::geometry::{triangle, Frame, Tri};
use super::membrane::{self, MembraneKind, K9};
use super::plate;
use super::rib_section::RibSection;
use super::section::ShellSection;
use super::sparse::{self, Pattern, ScratchBuf, HELD};
use super::tensor::Principal;
use crate::error::SimError;
use crate::units::{add, cross, dot, norm, normalize, scale, sub};

/// A triangulated mid-surface. Lengths in mm. Each triangle's corners run
/// counter-clockwise seen from the side its normal points to; that normal
/// is the "positive" side for pressure and for ribs.
#[derive(Clone, Debug, Default)]
pub struct ShellMesh {
    pub vertices: Vec<[f64; 3]>,
    pub triangles: Vec<[u32; 3]>,
    /// Wall thickness at each vertex, mm. An element takes the mean of its
    /// three corners.
    pub thickness: Vec<f64>,
}

impl ShellMesh {
    /// A flat `size[0] × size[1]` rectangle in the xy plane from the origin,
    /// `div` cells a side, each cut into two triangles along the diagonal
    /// from its lower-left corner. Normals point to +z. Vertex `i + (nx+1) j`
    /// sits at `(i size[0]/nx, j size[1]/ny, 0)`.
    pub fn rectangle(size: [f64; 2], div: [usize; 2], thickness: f64) -> Self {
        let [nx, ny] = div;
        let mut vertices = Vec::with_capacity((nx + 1) * (ny + 1));
        for j in 0..=ny {
            for i in 0..=nx {
                vertices.push([
                    size[0] * i as f64 / nx as f64,
                    size[1] * j as f64 / ny as f64,
                    0.0,
                ]);
            }
        }
        let id = |i: usize, j: usize| (i + (nx + 1) * j) as u32;
        let mut triangles = Vec::with_capacity(2 * nx * ny);
        for j in 0..ny {
            for i in 0..nx {
                let (a, b, c, d) = (id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j + 1));
                triangles.push([a, b, c]);
                triangles.push([a, c, d]);
            }
        }
        let thickness = vec![thickness; vertices.len()];
        Self {
            vertices,
            triangles,
            thickness,
        }
    }

    /// The vertex closest to `p`.
    pub fn nearest_vertex(&self, p: [f64; 3]) -> u32 {
        let mut best = (f64::INFINITY, 0u32);
        for (i, v) in self.vertices.iter().enumerate() {
            let d = norm(sub(*v, p));
            if d < best.0 {
                best = (d, i as u32);
            }
        }
        best.1
    }
}

/// Which face of the wall a rib stands on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RibSide {
    /// On the face the triangle normals point out of.
    Positive,
    /// On the other face.
    Negative,
    /// Centred on the mid-surface: no offset. Not a printable rib; it is
    /// here to compare against, and shows what the offset is worth.
    Centered,
}

/// A rib: a cross-section ([`RibSection`]) `height` tall (mm) standing on
/// the wall along a chain of mesh edges. Its centroid sits `t/2 + z̄` off
/// the mid-surface on its side, `t` the wall's thickness at each vertex and
/// `z̄` the section's centroid height above its foot.
#[derive(Clone, Debug, PartialEq)]
pub struct Rib {
    pub edges: Vec<(u32, u32)>,
    pub section: RibSection,
    pub height: f64,
    pub side: RibSide,
}

impl Rib {
    /// A straight rib, `width × height`.
    pub fn rectangular(edges: Vec<(u32, u32)>, width: f64, height: f64, side: RibSide) -> Self {
        Self {
            edges,
            section: RibSection::rectangular(width),
            height,
            side,
        }
    }
}

/// A hold on one vertex: `Some(value)` fixes that dof (global axes) at
/// `value`, mm or radians. Order `[ux, uy, uz, θx, θy, θz]`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ShellHold {
    pub node: u32,
    pub dofs: [Option<f64>; 6],
}

impl ShellHold {
    /// No translation, no rotation.
    pub fn clamped(node: u32) -> Self {
        Self {
            node,
            dofs: [Some(0.0); 6],
        }
    }

    /// No translation; free to turn.
    pub fn pinned(node: u32) -> Self {
        Self::fixed(node, [true, true, true, false, false, false])
    }

    /// The dofs marked `true` held at zero.
    pub fn fixed(node: u32, mask: [bool; 6]) -> Self {
        let mut dofs = [None; 6];
        for k in 0..6 {
            if mask[k] {
                dofs[k] = Some(0.0);
            }
        }
        Self { node, dofs }
    }
}

/// One load. Forces in N, moments in N·mm, pressure in MPa.
#[derive(Clone, Debug, PartialEq)]
pub enum ShellLoad {
    /// A force on one vertex.
    Force { node: u32, force: [f64; 3] },
    /// A moment on one vertex.
    Moment { node: u32, moment: [f64; 3] },
    /// Pressure on the listed triangles, along each one's normal. Positive
    /// presses on the face the normal points out of: the force is
    /// `−pressure · normal` per area. A third of each triangle's share goes
    /// to each corner.
    Pressure { triangles: Vec<u32>, pressure: f64 },
    /// One total force spread over the listed triangles by area.
    SpreadForce {
        triangles: Vec<u32>,
        force: [f64; 3],
    },
}

/// Loads applied together. Every case of a model shares one factor.
pub type LoadCase = Vec<ShellLoad>;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ShellOptions {
    pub membrane: MembraneKind,
    /// The drilling penalty factor α (see [`super::membrane`]): the penalty
    /// is `α G t` per unit area on the gap between the drilling rotation and
    /// the in-plane rotation.
    pub drill_penalty: f64,
    /// Stand a rib on its own face where the wall turns more than 20°
    /// (a crease): the foot is that face's normal and the web axis the
    /// miter of the rib's faces. Off, every rib end takes the
    /// area-weighted vertex normal, as v6.12 did. On by default for a
    /// model built directly; the rib planner sets it from
    /// [`super::planner::PlannerOptions::creases`], which is off by default.
    pub creases: bool,
}

/// The default drilling penalty. The tests sweep α from 1e-4 to 1: a flat
/// plate's deflection does not move at all, and the Scordelis–Lo roof's
/// strain energy moves by 0.1 % from 1e-3 to 1e-2 and by 0.9 % over the
/// whole sweep.
pub const DRILL_PENALTY: f64 = 1e-2;

impl Default for ShellOptions {
    fn default() -> Self {
        Self {
            membrane: MembraneKind::Allman,
            drill_penalty: DRILL_PENALTY,
            creases: true,
        }
    }
}

/// One facet's results, at its centroid.
#[derive(Clone, Copy, Debug)]
pub struct ElementResult {
    pub frame: Frame,
    pub area: f64,
    pub thickness: f64,
    /// N·mm. The drilling penalty's (small) energy counts here.
    pub membrane_energy: f64,
    pub bending_energy: f64,
    /// Membrane forces `[Nxx, Nyy, Nxy]`, N/mm, in the element frame.
    pub membrane_force: Principal,
    /// Bending moments `[Mxx, Myy, Mxy]`, N·mm/mm, in the element frame,
    /// signed as in Timoshenko: `Mxx = −D (∂²w/∂x² + ν ∂²w/∂y²)`.
    pub bending_moment: Principal,
}

/// The answer to one load case.
#[derive(Clone, Debug)]
pub struct ShellResult {
    /// Per vertex, mm.
    pub displacement: Vec<[f64; 3]>,
    /// Per vertex, radians about the global axes.
    pub rotation: Vec<[f64; 3]>,
    /// Total strain energy, N·mm: shell and ribs.
    pub strain_energy: f64,
    /// Work of the applied loads `fᵀu`, N·mm. Twice the strain energy when
    /// every hold is at zero.
    pub compliance: f64,
    pub elements: Vec<ElementResult>,
    /// Strain energy of each rib, in the model's rib order.
    pub rib_energy: Vec<f64>,
    /// Largest displacement magnitude, its vertex and where that is.
    pub max_deflection: f64,
    pub max_deflection_node: u32,
    pub max_deflection_at: [f64; 3],
    /// `|D_min| / |D_max|` of the factor that solved it.
    pub pivot_ratio: f64,
}

/// One buckling mode. `lambda` is the factor on the reference load: the
/// wall buckles at `lambda` times that load. Only positive factors are
/// returned; the lowest is the answer.
#[derive(Clone, Debug)]
pub struct BucklingMode {
    pub lambda: f64,
    /// Free dofs, the same order as a frequency mode.
    pub vector: Vec<f64>,
}

/// The positive buckling load factors [`ShellModel::buckling_modes`] found,
/// lowest first.
#[derive(Clone, Debug)]
pub struct BucklingSet {
    pub modes: Vec<BucklingMode>,
    pub seconds: f64,
}

/// Seconds spent in each phase, last run of each.
#[derive(Clone, Copy, Debug, Default)]
pub struct Timings {
    pub assemble_shell: f64,
    pub analyse: f64,
    pub assemble_ribs: f64,
    pub factor: f64,
    pub solve: f64,
    pub recover: f64,
}

/// Membrane dofs (u, v, θz) and bending dofs (w, θx, θy) within a node's
/// six local dofs `[u, v, w, θx, θy, θz]`.
const MEMBRANE: [usize; 3] = [0, 1, 5];
const BENDING: [usize; 3] = [2, 3, 4];

/// How many elements are built in parallel before they are scattered.
const CHUNK: usize = 4096;

/// Cosine of 20°, the same crease the planner unfolds across. Flatter
/// than this, a rib keeps the area-weighted vertex normal, so a flat wall
/// is unchanged. A fold uses the rib's own face, or the miter of the
/// faces the rib itself stands on.
const CREASE_COS: f64 = 0.939_692_620_785_908_4;

/// The ribs' web rotations ψ. Ids run from 0 over all ribs; in the model's
/// dof id space ψ `k` is `6 n + k` after the vertices' `6 n`.
#[derive(Clone, Debug, Default)]
struct RibLayout {
    /// Per rib, per edge: the ψ ids at its two ends.
    edges: Vec<Vec<(usize, usize)>>,
    /// Per ψ: its vertex and the lateral axis it turns about.
    vertex: Vec<u32>,
    lateral: Vec<[f64; 3]>,
    /// Per ψ: its free index, or [`HELD`] with the value in `value`.
    free: Vec<usize>,
    value: Vec<f64>,
}

/// Pre-factored small SPD matrix `Kψψ` for a candidate rib.
#[derive(Clone, Debug)]
enum SmallFactor {
    /// Tridiagonal Thomas factor: `mult[i - 1] = off[i - 1] / diag[i - 1]`,
    /// reduced `diag`, and subdiagonal `off`.
    Tridiag {
        mult: Vec<f64>,
        diag: Vec<f64>,
        off: Vec<f64>,
    },
    /// Dense lower-triangular Cholesky factor `L` (row-major `nf × nf`).
    Dense { l: Vec<f64>, nf: usize },
}

impl SmallFactor {
    fn solve(&self, rhs: &[f64]) -> Vec<f64> {
        let mut x = rhs.to_vec();
        match self {
            Self::Tridiag { mult, diag, off } => {
                let n = diag.len();
                for i in 1..n {
                    x[i] -= mult[i - 1] * x[i - 1];
                }
                for i in (0..n).rev() {
                    if i + 1 < n {
                        x[i] -= off[i] * x[i + 1];
                    }
                    x[i] /= diag[i];
                }
            }
            Self::Dense { l, nf } => {
                let n = *nf;
                for i in 0..n {
                    for q in 0..i {
                        x[i] -= l[i * n + q] * x[q];
                    }
                    x[i] /= l[i * n + i];
                }
                for i in (0..n).rev() {
                    for q in i + 1..n {
                        x[i] -= l[q * n + i] * x[q];
                    }
                    x[i] /= l[i * n + i];
                }
            }
        }
        x
    }
}

/// A candidate rib's layout, element stiffnesses, and factored `Kψψ`,
/// computed once and reused across greedy selection rounds.
#[derive(Clone, Debug)]
pub(crate) struct PreparedRib {
    layout: RibLayout,
    elements: Vec<([usize; 14], K14)>,
    nf: usize,
    factor: SmallFactor,
}

/// How much post-processing [`ShellModel::solve_forces`] performs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RecoverMode {
    /// Full element stresses/energies, rib energies, displacements and rotations.
    Full,
    /// Displacements, rotations, compliance, max deflection and rib energies;
    /// skips per-triangle stress/energy recovery.
    LightWithDisplacements,
    /// Compliance and max deflection only; skips elements, rib energies, and
    /// displacement/rotation vector copies.
    ComplianceOnly,
}

/// Immutable shell geometry, holds, pattern, and assembled shell stiffness,
/// shared across worker clones via [`Arc`].
struct ShellCore {
    mesh: ShellMesh,
    section: Arc<dyn ShellSection>,
    options: ShellOptions,
    tris: Vec<Tri>,
    element_thickness: Vec<f64>,
    normals: Vec<[f64; 3]>,
    /// True on a vertex of an edge whose faces turn more than 20°.
    on_crease: Vec<bool>,
    /// Triangles on each undirected edge, in triangle-index order.
    edge_faces: HashMap<(u32, u32), Vec<u32>>,
    neighbours: Vec<Vec<u32>>,
    dof: Vec<usize>,
    prescribed: Vec<f64>,
    /// The pattern of the shell's free dofs alone.
    shell_pattern: Pattern,
    /// Bare symbolic factor, computed lazily on first bare solve and shared
    /// across all clones.
    shell_symbolic: OnceLock<Arc<SymbolicCholesky<usize>>>,
    shell_values: Vec<f64>,
    shell_lift: Vec<f64>,
}

impl ShellCore {
    fn element_local(&self, e: usize) -> (K9, K9) {
        let tri = &self.tris[e];
        let t = self.element_thickness[e];
        let a = self.section.membrane(t, &tri.frame);
        let d = self.section.bending(t, &tri.frame);
        let km = membrane::stiffness(
            self.options.membrane,
            &tri.xy,
            tri.area,
            &a,
            self.options.drill_penalty,
        );
        let kb = plate::stiffness(&tri.xy, tri.area, &d);
        (km, kb)
    }

    fn element_global(&self, e: usize) -> [[f64; 18]; 18] {
        let (km, kb) = self.element_local(e);
        let mut kl = [[0.0; 18]; 18];
        for a in 0..3 {
            for b in 0..3 {
                for i in 0..3 {
                    for j in 0..3 {
                        kl[6 * a + MEMBRANE[i]][6 * b + MEMBRANE[j]] = km[3 * a + i][3 * b + j];
                        kl[6 * a + BENDING[i]][6 * b + BENDING[j]] = kb[3 * a + i][3 * b + j];
                    }
                }
            }
        }
        let r = self.tris[e].frame.rows();
        // Each 3 × 3 block: Rᵀ K R.
        let mut kg = [[0.0; 18]; 18];
        for bi in 0..6 {
            for bj in 0..6 {
                let mut kr = [[0.0; 3]; 3];
                for i in 0..3 {
                    for j in 0..3 {
                        kr[i][j] = (0..3).map(|q| kl[3 * bi + i][3 * bj + q] * r[q][j]).sum();
                    }
                }
                for i in 0..3 {
                    for j in 0..3 {
                        kg[3 * bi + i][3 * bj + j] = (0..3).map(|q| r[q][i] * kr[q][j]).sum();
                    }
                }
            }
        }
        kg
    }

    fn assemble_shell(&mut self) {
        let mut values = vec![0.0; self.shell_pattern.nnz()];
        let mut lift = vec![0.0; self.shell_pattern.n];
        let count = self.tris.len();
        let mut start = 0;
        while start < count {
            let end = (start + CHUNK).min(count);
            let mats: Vec<[[f64; 18]; 18]> = (start..end)
                .into_par_iter()
                .map(|e| self.element_global(e))
                .collect();
            for (e, k) in (start..end).zip(&mats) {
                let t = self.mesh.triangles[e];
                let mut g = [0usize; 18];
                for a in 0..3 {
                    for q in 0..6 {
                        g[6 * a + q] = 6 * t[a] as usize + q;
                    }
                }
                let free: [usize; 18] = g.map(|id| self.dof[id]);
                for i in 0..18 {
                    let fi = free[i];
                    if fi == HELD {
                        continue;
                    }
                    for j in 0..18 {
                        let fj = free[j];
                        if fj == HELD {
                            let v = self.prescribed[g[j]];
                            if v != 0.0 {
                                lift[fi] -= k[i][j] * v;
                            }
                        } else if fi <= fj {
                            let p = self
                                .shell_pattern
                                .position(fi, fj)
                                .expect("every element pair is in the pattern");
                            values[p] += k[i][j];
                        }
                    }
                }
            }
            start = end;
        }
        self.shell_values = values;
        self.shell_lift = lift;
    }
}

/// A shell with its stiffness assembled and its pattern analysed, ready to
/// take ribs and load cases.
///
/// **Re-solving with other ribs.** The shell's part of the matrix is
/// assembled once, in [`ShellModel::new`], and kept. [`ShellModel::set_ribs`],
/// [`ShellModel::add_rib`] and [`ShellModel::remove_rib`] only rebuild the
/// rib part and mark the factor stale. Free dofs number the shell's first
/// and the ribs' web rotations after them, so the shell's columns of the
/// matrix never move: its values are reused as they are, and a rib change
/// appends columns, re-runs the ordering (AMD) when the pattern changed, and
/// runs the numeric factorisation. The timing test gives both costs. A
/// rank-k update of that factor (Sherman–Morrison–Woodbury on the rib's own
/// dofs) was measured and lost: the condensed block is full rank, and one
/// solve per rib dof costs more than refactoring except for ribs shorter
/// than any candidate (see the note in `select`, and handover §3).
///
/// **Web rotations.** Each rib has one extra dof per vertex it runs
/// through, ψ (see [`super::beam`]). It is held when the vertex's three
/// rotations are all held (a clamped end clamps the web too) and free
/// otherwise.
pub struct ShellModel {
    core: Arc<ShellCore>,
    /// Ribs' web rotations: where they sit and how they number.
    layout: RibLayout,
    /// Extended pattern when ribs add free web rotations; `None` means `core.shell_pattern`.
    rib_pattern: Option<Pattern>,
    /// Symbolic factor for `rib_pattern`; `None` means `core.shell_symbolic`.
    rib_symbolic: Option<Arc<SymbolicCholesky<usize>>>,
    ribs: Vec<Rib>,
    /// Cached `(g, K14)` per rib edge, built during [`Self::rebuild_ribs`] and
    /// reused by recovery so beam stiffnesses are never computed twice.
    rib_elements: Vec<Vec<([usize; 14], K14)>>,
    /// Rib stiffness contribution (empty when `ribs.is_empty()`).
    rib_values: Vec<f64>,
    /// Indices in `rib_values` written by the current ribs (sparse overlay).
    rib_touched: Vec<usize>,
    /// Rib lift contribution (empty when `ribs.is_empty()`).
    rib_lift: Vec<f64>,
    /// Reusable buffer for `shell_values + rib_values`, kept in sync with
    /// `core.shell_values` outside `rib_touched`.
    work_values: Vec<f64>,
    /// Whether `work_values` has been seeded with `core.shell_values`.
    work_seeded: bool,
    /// Reusable numeric LDLᵀ factor values.
    factor_values: Vec<f64>,
    /// `Some(pivot_ratio)` when `factor_values` is current.
    factor_pivot: Option<f64>,
    factor_scratch: ScratchBuf,
    solve_scratch: ScratchBuf,
    factorisations: usize,
    timings: Timings,
    /// Threads for the factor and the solve; 0 is the crate default.
    threads: usize,
}

/// Triangles on one undirected edge, in triangle-index order.
type EdgeFaces = HashMap<(u32, u32), Vec<u32>>;

/// Crease vertices, and the triangles on each undirected edge. A vertex
/// is a crease when two triangles on one of its edges turn more than 20°.
fn crease_map(mesh: &ShellMesh, tris: &[Tri]) -> (Vec<bool>, EdgeFaces) {
    let mut edge_faces: EdgeFaces = HashMap::new();
    for (e, t) in mesh.triangles.iter().enumerate() {
        for k in 0..3 {
            let (a, b) = (t[k], t[(k + 1) % 3]);
            let key = if a < b { (a, b) } else { (b, a) };
            edge_faces.entry(key).or_default().push(e as u32);
        }
    }
    let mut on_crease = vec![false; mesh.vertices.len()];
    for (&(a, b), faces) in &edge_faces {
        let mut sharp = false;
        for i in 0..faces.len() {
            for j in (i + 1)..faces.len() {
                let ni = tris[faces[i] as usize].frame.normal;
                let nj = tris[faces[j] as usize].frame.normal;
                if dot(ni, nj) < CREASE_COS {
                    sharp = true;
                }
            }
        }
        if sharp {
            on_crease[a as usize] = true;
            on_crease[b as usize] = true;
        }
    }
    (on_crease, edge_faces)
}

/// The most negative principal membrane force, N/mm. Tension is positive,
/// so a result below zero is compression. Zero when nothing is compressed.
fn most_compressive(forces: &[[f64; 3]]) -> f64 {
    forces.iter().fold(0.0, |acc, f| {
        let [xx, yy, xy] = *f;
        let mean = 0.5 * (xx + yy);
        let r = (0.25 * (xx - yy) * (xx - yy) + xy * xy).sqrt();
        acc.min(mean - r)
    })
}

impl ShellModel {
    /// Check the mesh and holds, assemble the shell and analyse the pattern.
    pub fn new(
        mesh: ShellMesh,
        section: impl ShellSection + 'static,
        holds: &[ShellHold],
        options: ShellOptions,
    ) -> Result<Self, SimError> {
        let started = Instant::now();
        let n = mesh.vertices.len();
        if !(options.drill_penalty.is_finite() && options.drill_penalty > 0.0) {
            return Err(SimError::new("The drilling penalty must be above zero."));
        }
        if mesh.thickness.len() != n {
            return Err(SimError::new("The shell needs one thickness per vertex."));
        }
        if mesh.vertices.iter().flatten().any(|v| !v.is_finite()) {
            return Err(SimError::new("A shell vertex is not a finite point."));
        }
        if mesh.thickness.iter().any(|t| !(t.is_finite() && *t > 0.0)) {
            return Err(SimError::new("Every wall thickness must be above zero."));
        }
        if mesh.triangles.is_empty() {
            return Err(SimError::new("The shell has no triangles."));
        }
        let mut tris = Vec::with_capacity(mesh.triangles.len());
        let mut element_thickness = Vec::with_capacity(mesh.triangles.len());
        let mut normals = vec![[0.0; 3]; n];
        let mut pairs: Vec<(u32, u32)> = Vec::with_capacity(6 * mesh.triangles.len());
        for (e, t) in mesh.triangles.iter().enumerate() {
            if t.iter().any(|&v| v as usize >= n) {
                return Err(SimError::new(format!(
                    "Triangle {e} names a vertex the shell does not have."
                )));
            }
            let p = t.map(|v| mesh.vertices[v as usize]);
            let tri =
                triangle(p).ok_or_else(|| SimError::new(format!("Triangle {e} has no area.")))?;
            for &v in t {
                let w = scale(tri.frame.normal, tri.area);
                normals[v as usize] = add(normals[v as usize], w);
            }
            for a in 0..3 {
                for b in 0..3 {
                    pairs.push((t[a], t[b]));
                }
            }
            element_thickness
                .push(t.iter().map(|&v| mesh.thickness[v as usize]).sum::<f64>() / 3.0);
            tris.push(tri);
        }
        let mut normal_unit = Vec::with_capacity(n);
        for (i, v) in normals.iter().enumerate() {
            normal_unit.push(
                normalize(*v)
                    .ok_or_else(|| SimError::new(format!("Vertex {i} is on no triangle.")))?,
            );
        }
        // Creases off: no vertex is a crease, so every rib end keeps the
        // averaged vertex normal exactly as before the crease handling.
        let (on_crease, edge_faces) = if options.creases {
            crease_map(&mesh, &tris)
        } else {
            (vec![false; n], EdgeFaces::new())
        };
        pairs.sort_unstable();
        pairs.dedup();
        let mut neighbours: Vec<Vec<u32>> = vec![Vec::new(); n];
        for (a, b) in pairs {
            neighbours[a as usize].push(b);
        }

        // Holds, merged per vertex.
        let mut prescribed = vec![0.0; 6 * n];
        let mut held = vec![false; 6 * n];
        for h in holds {
            let node = h.node as usize;
            if node >= n {
                return Err(SimError::new(format!(
                    "A hold names vertex {node}, which the shell does not have."
                )));
            }
            for k in 0..6 {
                if let Some(v) = h.dofs[k] {
                    if !v.is_finite() {
                        return Err(SimError::new("A held value must be a finite number."));
                    }
                    let i = 6 * node + k;
                    if held[i] && prescribed[i] != v {
                        return Err(SimError::new(format!(
                            "Vertex {node} is held at two different values."
                        )));
                    }
                    held[i] = true;
                    prescribed[i] = v;
                }
            }
        }
        let mut dof = vec![HELD; 6 * n];
        let mut free = 0;
        for i in 0..6 * n {
            if !held[i] {
                dof[i] = free;
                free += 1;
            }
        }
        let below: Vec<Vec<u32>> = neighbours
            .iter()
            .enumerate()
            .map(|(b, near)| near.iter().copied().filter(|&a| a as usize <= b).collect())
            .collect();
        let pattern = Pattern::build(&below, &dof, free);
        let mut core = ShellCore {
            mesh,
            section: Arc::new(section),
            options,
            tris,
            element_thickness,
            normals: normal_unit,
            on_crease,
            edge_faces,
            neighbours,
            dof,
            prescribed,
            shell_values: Vec::new(),
            shell_lift: Vec::new(),
            shell_pattern: pattern,
            shell_symbolic: OnceLock::new(),
        };
        core.assemble_shell();
        let assemble_shell = started.elapsed().as_secs_f64();
        let timings = Timings {
            assemble_shell,
            ..Timings::default()
        };
        Ok(Self {
            core: Arc::new(core),
            layout: RibLayout::default(),
            rib_pattern: None,
            rib_symbolic: None,
            ribs: Vec::new(),
            rib_elements: Vec::new(),
            rib_values: Vec::new(),
            rib_touched: Vec::new(),
            rib_lift: Vec::new(),
            work_values: Vec::new(),
            work_seeded: false,
            factor_values: Vec::new(),
            factor_pivot: None,
            factor_scratch: ScratchBuf::new(),
            solve_scratch: ScratchBuf::new(),
            factorisations: 0,
            timings,
            threads: 0,
        })
    }

    /// Cheap bare clone sharing the assembled shell, pattern, and bare
    /// symbolic factor via [`Arc`]. Ribs and factor buffers start empty.
    pub(crate) fn clone_bare(&self) -> Self {
        Self {
            core: Arc::clone(&self.core),
            layout: RibLayout::default(),
            rib_pattern: None,
            rib_symbolic: None,
            ribs: Vec::new(),
            rib_elements: Vec::new(),
            rib_values: Vec::new(),
            rib_touched: Vec::new(),
            rib_lift: Vec::new(),
            work_values: Vec::new(),
            work_seeded: false,
            factor_values: Vec::new(),
            factor_pivot: None,
            factor_scratch: ScratchBuf::new(),
            solve_scratch: ScratchBuf::new(),
            factorisations: 0,
            timings: self.timings,
            threads: self.threads,
        }
    }

    /// Seed `self`'s cached rib pattern and symbolic ordering from a sibling
    /// worker on the same shell so identical sparsity patterns skip AMD.
    pub(crate) fn share_rib_symbolic(&mut self, other: &Self) {
        if !Arc::ptr_eq(&self.core, &other.core) {
            return;
        }
        self.clear_rib_overlay();
        self.ribs.clear();
        self.rib_elements.clear();
        self.layout = RibLayout::default();
        self.rib_pattern = other.rib_pattern.clone();
        self.rib_symbolic = other.rib_symbolic.clone();
        self.factor_pivot = None;
    }

    /// Restore `work_values` and zero `rib_values` only at previously touched
    /// indices (O(rib nnz) instead of O(shell nnz)).
    fn clear_rib_overlay(&mut self) {
        if self.rib_touched.is_empty() {
            return;
        }
        let shell_nnz = self.core.shell_values.len();
        if self.work_seeded {
            for &p in &self.rib_touched {
                if p < shell_nnz {
                    self.work_values[p] = self.core.shell_values[p];
                } else if p < self.work_values.len() {
                    self.work_values[p] = 0.0;
                }
            }
        }
        for &p in &self.rib_touched {
            if p < self.rib_values.len() {
                self.rib_values[p] = 0.0;
            }
        }
        self.rib_touched.clear();
    }

    /// Replace vertex thicknesses on a bare shell without rebuilding
    /// adjacency, sparsity pattern, or symbolic ordering. Clears any ribs.
    pub(crate) fn set_thickness(&mut self, thickness: Vec<f64>) -> Result<(), SimError> {
        let n = self.core.mesh.vertices.len();
        if thickness.len() != n {
            return Err(SimError::new("The shell needs one thickness per vertex."));
        }
        if thickness.iter().any(|t| !(t.is_finite() && *t > 0.0)) {
            return Err(SimError::new("Every wall thickness must be above zero."));
        }
        self.clear_rib_overlay();
        self.ribs.clear();
        self.rib_elements.clear();
        self.layout = RibLayout::default();
        self.rib_pattern = None;
        self.rib_symbolic = None;
        self.rib_values.clear();
        self.rib_lift.clear();
        self.work_seeded = false;
        self.factor_pivot = None;

        let started = Instant::now();
        if let Some(core) = Arc::get_mut(&mut self.core) {
            core.mesh.thickness = thickness;
            for (e, t) in core.mesh.triangles.iter().enumerate() {
                core.element_thickness[e] =
                    t.iter().map(|&v| core.mesh.thickness[v as usize]).sum::<f64>() / 3.0;
            }
            core.assemble_shell();
        } else {
            let old = &*self.core;
            let mut mesh = old.mesh.clone();
            mesh.thickness = thickness;
            let element_thickness: Vec<f64> = mesh
                .triangles
                .iter()
                .map(|t| t.iter().map(|&v| mesh.thickness[v as usize]).sum::<f64>() / 3.0)
                .collect();
            let shell_symbolic = OnceLock::new();
            if let Some(sym) = old.shell_symbolic.get() {
                let _ = shell_symbolic.set(Arc::clone(sym));
            }
            let mut core = ShellCore {
                mesh,
                section: Arc::clone(&old.section),
                options: old.options,
                tris: old.tris.clone(),
                element_thickness,
                normals: old.normals.clone(),
                on_crease: old.on_crease.clone(),
                edge_faces: old.edge_faces.clone(),
                neighbours: old.neighbours.clone(),
                dof: old.dof.clone(),
                prescribed: old.prescribed.clone(),
                shell_pattern: old.shell_pattern.clone(),
                shell_symbolic,
                shell_values: Vec::new(),
                shell_lift: Vec::new(),
            };
            core.assemble_shell();
            self.core = Arc::new(core);
        }
        self.timings.assemble_shell = started.elapsed().as_secs_f64();
        Ok(())
    }

    fn pattern(&self) -> &Pattern {
        self.rib_pattern
            .as_ref()
            .unwrap_or(&self.core.shell_pattern)
    }

    fn ensure_symbolic(&mut self) -> Result<Arc<SymbolicCholesky<usize>>, SimError> {
        if let Some(sym) = &self.rib_symbolic {
            return Ok(Arc::clone(sym));
        }
        if let Some(sym) = self.core.shell_symbolic.get() {
            return Ok(Arc::clone(sym));
        }
        let analysing = Instant::now();
        let sym = Arc::new(self.core.shell_pattern.analyse()?);
        self.timings.analyse = analysing.elapsed().as_secs_f64();
        let stored = self.core.shell_symbolic.get_or_init(|| Arc::clone(&sym));
        Ok(Arc::clone(stored))
    }

    pub fn mesh(&self) -> &ShellMesh {
        &self.core.mesh
    }

    pub fn options(&self) -> ShellOptions {
        self.core.options
    }

    /// Unit normal at each vertex: the area-weighted mean of its triangles'.
    pub fn vertex_normals(&self) -> &[[f64; 3]] {
        &self.core.normals
    }

    pub fn ribs(&self) -> &[Rib] {
        &self.ribs
    }

    /// How many free dofs the system has.
    pub fn free_dofs(&self) -> usize {
        self.pattern().n
    }

    /// How many numeric factorisations have run.
    pub fn factorisations(&self) -> usize {
        self.factorisations
    }

    pub fn timings(&self) -> Timings {
        self.timings
    }

    /// Threads for the numeric factor and the solve: 0 (the default) up
    /// to 8 by the machine, 1 for one, more for that many. Several models
    /// solving side by side each take fewer. The answer does not depend
    /// on it beyond rounding.
    pub fn set_threads(&mut self, threads: usize) {
        self.threads = threads;
    }

    /// Each rib web rotation's vertex and lateral axis, in dof order: the
    /// web rotations are the last free dofs of [`ShellModel::stiffness_upper`]
    /// (held ones skipped). Under a rigid turn ω, ψ = ω · axis.
    pub fn web_rotations(&self) -> Vec<(u32, [f64; 3], bool)> {
        (0..self.layout.vertex.len())
            .map(|k| {
                (
                    self.layout.vertex[k],
                    self.layout.lateral[k],
                    self.layout.free[k] != HELD,
                )
            })
            .collect()
    }

    /// Replace every rib. Only the rib part of the matrix is rebuilt.
    pub fn set_ribs(&mut self, ribs: Vec<Rib>) -> Result<(), SimError> {
        for rib in &ribs {
            self.check_rib(rib)?;
        }
        self.ribs = ribs;
        self.rebuild_ribs()
    }

    /// Add one rib; returns its index.
    pub fn add_rib(&mut self, rib: Rib) -> Result<usize, SimError> {
        self.check_rib(&rib)?;
        self.ribs.push(rib);
        self.rebuild_ribs()?;
        Ok(self.ribs.len() - 1)
    }

    /// Remove the rib at `index` and return it. The rib part is rebuilt from
    /// the ribs left, so nothing drifts by subtraction.
    pub fn remove_rib(&mut self, index: usize) -> Result<Rib, SimError> {
        if index >= self.ribs.len() {
            return Err(SimError::new(format!("There is no rib {index}.")));
        }
        let gone = self.ribs.remove(index);
        self.rebuild_ribs()?;
        Ok(gone)
    }

    /// Number the web rotations, extend the shell's pattern by their
    /// columns, order it (when the pattern changed), and assemble every rib.
    fn rebuild_ribs(&mut self) -> Result<(), SimError> {
        let started = Instant::now();
        self.factor_pivot = None;
        self.clear_rib_overlay();
        if self.ribs.is_empty() {
            self.layout = RibLayout::default();
            self.rib_pattern = None;
            self.rib_symbolic = None;
            self.rib_elements.clear();
            self.rib_lift.clear();
            self.timings.analyse = 0.0;
            self.timings.assemble_ribs = 0.0;
            return Ok(());
        }
        let layout = self.layout_ribs();
        let n_shell = self.core.shell_pattern.n;
        let base = 6 * self.core.mesh.vertices.len();
        // Columns of the free web rotations, rows from every rib element
        // that touches them.
        let n_free = layout.free.iter().filter(|&&f| f != HELD).count();
        let mut extra: Vec<Vec<usize>> = vec![Vec::new(); n_free];
        for edges in &layout.edges {
            for &(pa, pb) in edges {
                let ids = rib_ids(&layout, pa, pb, base);
                let mut frees = [0usize; 14];
                let mut count = 0usize;
                for &id in &ids {
                    let f = self.free_in(&layout, id);
                    if f != HELD {
                        frees[count] = f;
                        count += 1;
                    }
                }
                for &c in &frees[..count] {
                    if c < n_shell {
                        continue;
                    }
                    for &r in &frees[..count] {
                        if r <= c {
                            extra[c - n_shell].push(r);
                        }
                    }
                }
            }
        }
        for col in &mut extra {
            col.sort_unstable();
            col.dedup();
        }
        if extra.is_empty() {
            self.rib_pattern = None;
            self.rib_symbolic = None;
            self.timings.analyse = 0.0;
        } else if self
            .rib_pattern
            .as_ref()
            .is_some_and(|p| p.matches_extended(&self.core.shell_pattern, &extra))
            && self.rib_symbolic.is_some()
        {
            self.timings.analyse = 0.0;
        } else {
            let pattern = self.core.shell_pattern.extend(&extra);
            let analysing = Instant::now();
            let sym = Arc::new(pattern.analyse()?);
            self.timings.analyse = analysing.elapsed().as_secs_f64();
            self.rib_pattern = Some(pattern);
            self.rib_symbolic = Some(sym);
        }
        self.layout = layout;
        let nnz = self.pattern().nnz();
        let n_total = self.pattern().n;
        // `rib_values` is already zeroed at all previously touched positions;
        // only adjust length without touching untouched zeros.
        let mut values = std::mem::take(&mut self.rib_values);
        if values.len() < nnz {
            values.resize(nnz, 0.0);
        } else {
            values.truncate(nnz);
        }
        let mut touched = std::mem::take(&mut self.rib_touched);
        let mut lift = std::mem::take(&mut self.rib_lift);
        lift.clear();
        lift.resize(n_total, 0.0);
        let mut rib_elements = Vec::with_capacity(self.ribs.len());
        for r in 0..self.ribs.len() {
            let mut elems = Vec::with_capacity(self.ribs[r].edges.len());
            for e in 0..self.ribs[r].edges.len() {
                let (g, k) = self.rib_element(r, e);
                self.scatter_tracked(&g, &k, &mut values, &mut lift, &mut touched);
                elems.push((g, k));
            }
            rib_elements.push(elems);
        }
        self.rib_elements = rib_elements;
        self.rib_values = values;
        self.rib_touched = touched;
        self.rib_lift = lift;
        self.timings.assemble_ribs = started.elapsed().as_secs_f64() - self.timings.analyse;
        Ok(())
    }

    /// Give every rib a web rotation at each of its vertices, with its axis
    /// and hold.
    fn layout_ribs(&self) -> RibLayout {
        self.layout_of(&self.ribs, self.core.shell_pattern.n)
    }

    /// The web-rotation layout of `ribs`, free ψ numbered from `first_free`.
    fn layout_of(&self, ribs: &[Rib], first_free: usize) -> RibLayout {
        let core = &self.core;
        let mut layout = RibLayout::default();
        let mut tangent: Vec<[f64; 3]> = Vec::new();
        // Face normals of the rib edges at each crease vertex. A vertex
        // that is not a crease never reads this and keeps `core.normals`.
        let mut face_sum: Vec<[f64; 3]> = Vec::new();
        let mut free = first_free;
        for rib in ribs {
            let mut at: Vec<(u32, usize)> = Vec::new();
            let mut edges = Vec::with_capacity(rib.edges.len());
            for &(a, b) in &rib.edges {
                let dir = normalize(sub(
                    core.mesh.vertices[b as usize],
                    core.mesh.vertices[a as usize],
                ))
                .expect("a mesh edge has a length");
                let mut ids = [0usize; 2];
                for (slot, v) in [a, b].into_iter().enumerate() {
                    let id = match at.iter().find(|(w, _)| *w == v) {
                        Some(&(_, id)) => id,
                        None => {
                            let id = layout.vertex.len();
                            at.push((v, id));
                            layout.vertex.push(v);
                            tangent.push([0.0; 3]);
                            face_sum.push([0.0; 3]);
                            id
                        }
                    };
                    // Tangents of a chain's edges may come in either
                    // direction; add them all pointing one way.
                    let t = tangent[id];
                    let d = if dot(t, dir) < 0.0 {
                        scale(dir, -1.0)
                    } else {
                        dir
                    };
                    tangent[id] = add(t, d);
                    ids[slot] = id;
                }
                if core.on_crease[a as usize] || core.on_crease[b as usize] {
                    let nf = self.rib_face_normal(a, b);
                    if core.on_crease[a as usize] {
                        face_sum[ids[0]] = add(face_sum[ids[0]], nf);
                    }
                    if core.on_crease[b as usize] {
                        face_sum[ids[1]] = add(face_sum[ids[1]], nf);
                    }
                }
                edges.push((ids[0], ids[1]));
            }
            layout.edges.push(edges);
        }
        for (k, &v) in layout.vertex.iter().enumerate() {
            let n = if core.on_crease[v as usize] {
                normalize(face_sum[k]).unwrap_or(core.normals[v as usize])
            } else {
                core.normals[v as usize]
            };
            let lateral = normalize(cross(n, tangent[k]))
                .or_else(|| normalize(cross(n, [1.0, 0.0, 0.0])))
                .or_else(|| normalize(cross(n, [0.0, 1.0, 0.0])))
                .expect("a unit normal has a perpendicular");
            layout.lateral.push(lateral);
            let rot = 6 * v as usize + 3;
            if (0..3).all(|q| core.dof[rot + q] == HELD) {
                let theta = [0, 1, 2].map(|q| core.prescribed[rot + q]);
                layout.free.push(HELD);
                layout.value.push(dot(theta, lateral));
            } else {
                layout.free.push(free);
                layout.value.push(0.0);
                free += 1;
            }
        }
        layout
    }

    fn free_in(&self, layout: &RibLayout, id: usize) -> usize {
        let base = 6 * self.core.mesh.vertices.len();
        if id < base {
            self.core.dof[id]
        } else {
            layout.free[id - base]
        }
    }

    /// Precompute global load vectors once for repeated solves on this mesh.
    pub(crate) fn precompute_loads(&self, cases: &[LoadCase]) -> Result<Vec<Vec<f64>>, SimError> {
        let mut forces = Vec::with_capacity(cases.len());
        for case in cases {
            forces.push(self.load_vector(case)?);
        }
        Ok(forces)
    }

    /// Solve one load case.
    pub fn solve(&mut self, case: &[ShellLoad]) -> Result<ShellResult, SimError> {
        let mut all = self.solve_cases(std::slice::from_ref(&case.to_vec()))?;
        Ok(all.remove(0))
    }

    /// Solve several load cases on one factor.
    pub fn solve_cases(&mut self, cases: &[LoadCase]) -> Result<Vec<ShellResult>, SimError> {
        let forces = self.precompute_loads(cases)?;
        self.solve_forces(&forces, RecoverMode::Full)
    }

    /// Solve several load cases without per-triangle element recovery.
    pub(crate) fn solve_cases_light(
        &mut self,
        cases: &[LoadCase],
        need_displacements: bool,
    ) -> Result<Vec<ShellResult>, SimError> {
        let forces = self.precompute_loads(cases)?;
        self.solve_precomputed_light(&forces, need_displacements)
    }

    /// Solve precomputed load vectors without per-triangle element recovery.
    pub(crate) fn solve_precomputed_light(
        &mut self,
        forces: &[Vec<f64>],
        need_displacements: bool,
    ) -> Result<Vec<ShellResult>, SimError> {
        let mode = if need_displacements {
            RecoverMode::LightWithDisplacements
        } else {
            RecoverMode::ComplianceOnly
        };
        self.solve_forces(forces, mode)
    }

    fn solve_forces(
        &mut self,
        forces: &[Vec<f64>],
        mode: RecoverMode,
    ) -> Result<Vec<ShellResult>, SimError> {
        let n = self.core.mesh.vertices.len();
        let pivot_ratio = self.ensure_factor()?;
        let symbolic = self.ensure_symbolic()?;
        let started = Instant::now();
        let free = self.pattern().n;
        let mut rhs = Mat::<f64>::zeros(free, forces.len());
        let shell_lift = &self.core.shell_lift;
        let rib_lift = &self.rib_lift;
        let dof = &self.core.dof;
        for (c, f) in forces.iter().enumerate() {
            if rib_lift.is_empty() {
                for d in 0..free {
                    rhs[(d, c)] = shell_lift[d];
                }
            } else {
                for d in 0..free {
                    let shell = shell_lift.get(d).copied().unwrap_or(0.0);
                    rhs[(d, c)] = shell + rib_lift[d];
                }
            }
            for i in 0..6 * n {
                let d = dof[i];
                if d != HELD {
                    rhs[(d, c)] += f[i];
                }
            }
        }
        sparse::solve_in_place_with(
            &symbolic,
            &self.factor_values,
            &mut rhs,
            self.threads,
            &mut self.solve_scratch,
        )?;
        self.timings.solve = started.elapsed().as_secs_f64();
        let started = Instant::now();
        let mut out = Vec::with_capacity(forces.len());
        let u_len = 6 * n + self.layout.value.len();
        let mut u = vec![0.0; u_len];
        for (c, f) in forces.iter().enumerate() {
            // Vertex dofs, then the web rotations.
            u[..6 * n].copy_from_slice(&self.core.prescribed);
            u[6 * n..].copy_from_slice(&self.layout.value);
            for i in 0..6 * n {
                let d = self.core.dof[i];
                if d != HELD {
                    u[i] = rhs[(d, c)];
                }
            }
            for (k, &d) in self.layout.free.iter().enumerate() {
                if d != HELD {
                    u[6 * n + k] = rhs[(d, c)];
                }
            }
            if u.iter().any(|v| !v.is_finite()) {
                return Err(crate::error::not_held());
            }
            out.push(self.recover_mode(&u, f, pivot_ratio, mode));
        }
        self.timings.recover = started.elapsed().as_secs_f64();
        Ok(out)
    }

    /// The upper triangle of the free-dof stiffness (shell and ribs) as
    /// `(row, column, value)`, for inspection. Free dofs number vertex by
    /// vertex, `[ux, uy, uz, θx, θy, θz]` within each, held ones skipped,
    /// then the free web rotations ([`ShellModel::web_rotations`]).
    pub fn stiffness_upper(&self) -> (usize, Vec<(usize, usize, f64)>) {
        let values = self.values();
        let pattern = self.pattern();
        let mut out = Vec::with_capacity(pattern.nnz());
        for c in 0..pattern.n {
            for p in pattern.col_ptr[c]..pattern.col_ptr[c + 1] {
                out.push((pattern.row_idx[p], c, values[p]));
            }
        }
        (pattern.n, out)
    }

    /// Shell and rib values over the current pattern. The shell's columns
    /// come first in it, so the shell's values are its prefix.
    fn values(&self) -> Vec<f64> {
        if self.ribs.is_empty() {
            return self.core.shell_values.clone();
        }
        let nnz = self.pattern().nnz();
        let shell_nnz = self.core.shell_values.len();
        let mut out = vec![0.0; nnz];
        out[..shell_nnz].copy_from_slice(&self.core.shell_values);
        for &p in &self.rib_touched {
            let s = if p < shell_nnz {
                self.core.shell_values[p]
            } else {
                0.0
            };
            out[p] = self.rib_values[p] + s;
        }
        out
    }

    fn sync_work_values(&mut self) {
        let nnz = self.pattern().nnz();
        let shell_nnz = self.core.shell_values.len();
        if !self.work_seeded {
            self.work_values.clear();
            self.work_values.extend_from_slice(&self.core.shell_values);
            self.work_values.resize(nnz, 0.0);
            self.work_seeded = true;
        } else if self.work_values.len() < nnz {
            self.work_values.resize(nnz, 0.0);
        } else {
            self.work_values.truncate(nnz);
        }
        for &p in &self.rib_touched {
            let s = if p < shell_nnz {
                self.core.shell_values[p]
            } else {
                0.0
            };
            self.work_values[p] = self.rib_values[p] + s;
        }
    }

    fn ensure_factor(&mut self) -> Result<f64, SimError> {
        if let Some(pivot) = self.factor_pivot {
            return Ok(pivot);
        }
        let symbolic = self.ensure_symbolic()?;
        let started = Instant::now();
        let pivot = if self.ribs.is_empty() {
            let pattern = self
                .rib_pattern
                .as_ref()
                .unwrap_or(&self.core.shell_pattern);
            sparse::factor_into(
                pattern,
                &symbolic,
                &self.core.shell_values,
                self.threads,
                &mut self.factor_values,
                &mut self.factor_scratch,
            )?
        } else {
            self.sync_work_values();
            let pattern = self
                .rib_pattern
                .as_ref()
                .unwrap_or(&self.core.shell_pattern);
            sparse::factor_into(
                pattern,
                &symbolic,
                &self.work_values,
                self.threads,
                &mut self.factor_values,
                &mut self.factor_scratch,
            )?
        };
        self.factorisations += 1;
        self.factor_pivot = Some(pivot);
        self.timings.factor = started.elapsed().as_secs_f64();
        Ok(pivot)
    }

    /// The held value of dof id `id` (vertex dofs, then web rotations).
    fn held_value(&self, id: usize) -> f64 {
        let base = 6 * self.core.mesh.vertices.len();
        if id < base {
            self.core.prescribed[id]
        } else {
            self.layout.value[id - base]
        }
    }

    /// Add an element matrix on dof ids `g`, recording touched matrix entries.
    fn scatter_tracked<const N: usize>(
        &self,
        g: &[usize; N],
        k: &[[f64; N]; N],
        values: &mut [f64],
        lift: &mut [f64],
        touched: &mut Vec<usize>,
    ) {
        let pattern = self.pattern();
        let free: [usize; N] = g.map(|id| self.free_in(&self.layout, id));
        for i in 0..N {
            let fi = free[i];
            if fi == HELD {
                continue;
            }
            for j in 0..N {
                let fj = free[j];
                if fj == HELD {
                    let v = self.held_value(g[j]);
                    if v != 0.0 {
                        lift[fi] -= k[i][j] * v;
                    }
                } else if fi <= fj {
                    let p = pattern
                        .position(fi, fj)
                        .expect("every element pair is in the pattern");
                    if values[p] == 0.0 {
                        touched.push(p);
                    }
                    values[p] += k[i][j];
                }
            }
        }
    }

    /// Add nonzero upper-triangle free–free entries of `k` on dof ids `g`.
    fn scatter_upper_nonzero<const N: usize>(
        &self,
        g: &[usize; N],
        k: &[[f64; N]; N],
        values: &mut [f64],
    ) {
        let pattern = self.pattern();
        let free: [usize; N] = g.map(|id| self.free_in(&self.layout, id));
        for i in 0..N {
            let fi = free[i];
            if fi == HELD {
                continue;
            }
            for j in 0..N {
                let fj = free[j];
                if fj != HELD && fi <= fj {
                    let v = k[i][j];
                    if v != 0.0 {
                        let p = pattern
                            .position(fi, fj)
                            .expect("every element pair is in the pattern");
                        values[p] += v;
                    }
                }
            }
        }
    }

    fn check_rib(&self, rib: &Rib) -> Result<(), SimError> {
        rib.section.check(rib.height)?;
        if rib.edges.is_empty() {
            return Err(SimError::new("A rib needs at least one edge."));
        }
        let n = self.core.mesh.vertices.len();
        for &(a, b) in &rib.edges {
            if a as usize >= n || b as usize >= n {
                return Err(SimError::new(format!(
                    "Rib edge {a}–{b} names a vertex the shell does not have."
                )));
            }
            if a == b || self.core.neighbours[a as usize].binary_search(&b).is_err() {
                return Err(SimError::new(format!(
                    "Rib edge {a}–{b} is not an edge of the mesh."
                )));
            }
        }
        Ok(())
    }

    /// Rib `r`'s edge `e`: its 14 dof ids and its stiffness on them.
    fn rib_element(&self, r: usize, e: usize) -> ([usize; 14], K14) {
        self.rib_element_in(&self.layout, &self.ribs[r], r, e)
    }

    /// Precompute a candidate rib's layout, element stiffnesses, and factored
    /// `Kψψ` so it can be probed across rounds without re-assembling beam
    /// matrices or allocating a dense `nf × nf` matrix.
    pub(crate) fn prepare_rib(&self, rib: &Rib) -> Result<PreparedRib, SimError> {
        self.check_rib(rib)?;
        let n = self.core.mesh.vertices.len();
        let base = 6 * n;
        let layout = self.layout_of(std::slice::from_ref(rib), 0);
        let elements: Vec<([usize; 14], K14)> = (0..rib.edges.len())
            .map(|e| self.rib_element_in(&layout, rib, 0, e))
            .collect();
        let free = &layout.free;
        let nf = free.iter().filter(|&&f| f != HELD).count();
        let tridiagonal = elements.iter().all(|(g, _)| {
            let fa = free[g[12] - base];
            let fb = free[g[13] - base];
            fa == HELD || fb == HELD || fa.abs_diff(fb) <= 1
        });
        let factor = if tridiagonal {
            let mut diag = vec![0.0; nf];
            let mut off = vec![0.0; nf.saturating_sub(1)];
            for (g, k) in &elements {
                for i in 12..14 {
                    let fi = free[g[i] - base];
                    if fi == HELD {
                        continue;
                    }
                    for j in 12..14 {
                        let fj = free[g[j] - base];
                        if fj == HELD {
                            continue;
                        }
                        if fi == fj {
                            diag[fi] += k[i][j];
                        } else if fi == fj + 1 {
                            off[fj] += k[i][j];
                        }
                    }
                }
            }
            factor_tridiag(diag, off)
                .ok_or_else(|| SimError::new("A probed rib's web has no stiffness."))?
        } else {
            let mut kpp = vec![0.0; nf * nf];
            for (g, k) in &elements {
                for i in 12..14 {
                    let fi = free[g[i] - base];
                    if fi == HELD {
                        continue;
                    }
                    for j in 12..14 {
                        let fj = free[g[j] - base];
                        if fj != HELD {
                            kpp[fi * nf + fj] += k[i][j];
                        }
                    }
                }
            }
            factor_small_spd(kpp, nf)
                .ok_or_else(|| SimError::new("A probed rib's web has no stiffness."))?
        };
        Ok(PreparedRib {
            layout,
            elements,
            nf,
            factor,
        })
    }

    /// Probe strain energy using a [`PreparedRib`], bit-identical to
    /// [`ShellModel::probe_rib_energy`].
    pub(crate) fn probe_prepared_rib_energy(
        &self,
        prep: &PreparedRib,
        result: &ShellResult,
    ) -> f64 {
        let base = 6 * self.core.mesh.vertices.len();
        let value = |id: usize| -> f64 {
            let v = id / 6;
            let k = id % 6;
            if k < 3 {
                result.displacement[v][k]
            } else {
                result.rotation[v][k - 3]
            }
        };
        let free = &prep.layout.free;
        let mut rhs = vec![0.0; prep.nf];
        for (g, k) in &prep.elements {
            for i in 12..14 {
                let fi = free[g[i] - base];
                if fi == HELD {
                    continue;
                }
                for j in 0..14 {
                    if j < 12 {
                        rhs[fi] -= k[i][j] * value(g[j]);
                    } else {
                        let fj = free[g[j] - base];
                        if fj == HELD {
                            rhs[fi] -= k[i][j] * prep.layout.value[g[j] - base];
                        }
                    }
                }
            }
        }
        let psi_free = prep.factor.solve(&rhs);
        let m = prep.layout.vertex.len();
        let mut psi = prep.layout.value.clone();
        for k in 0..m {
            if free[k] != HELD {
                psi[k] = psi_free[free[k]];
            }
        }
        let mut energy = 0.0;
        for (g, k) in &prep.elements {
            let x: [f64; 14] = std::array::from_fn(|q| {
                if q < 12 {
                    value(g[q])
                } else {
                    psi[g[q] - base]
                }
            });
            energy += quadratic(k, &x);
        }
        energy
    }

    /// The strain energy rib `rib` would take if it were added to this
    /// model and the wall kept the displacements and rotations of `result`
    /// (a solution of this model), with the rib's own web rotations ψ
    /// relaxed to their best fit. N·mm.
    ///
    /// This is the first-order estimate of what the rib is worth: adding
    /// stiffness `ΔK` lowers the compliance by `uᵀ ΔK u = 2 ×` this, to first
    /// order, before the wall redistributes. The rib planner ranks its
    /// candidates with it before solving the best exactly.
    pub fn probe_rib_energy(&self, rib: &Rib, result: &ShellResult) -> Result<f64, SimError> {
        let n = self.core.mesh.vertices.len();
        if result.displacement.len() != n || result.rotation.len() != n {
            return Err(SimError::new("The result is not one of this shell."));
        }
        let prep = self.prepare_rib(rib)?;
        Ok(self.probe_prepared_rib_energy(&prep, result))
    }

    /// The normal of the face the directed edge `a` → `b` belongs to.
    /// The triangle of lowest index that lists the edge in that order
    /// wins; if none does, the lowest that lists it reversed. Both ends
    /// of a rib element call this once, so they stand on the same face.
    fn rib_face_normal(&self, a: u32, b: u32) -> [f64; 3] {
        let core = &self.core;
        let key = if a < b { (a, b) } else { (b, a) };
        let Some(faces) = core.edge_faces.get(&key) else {
            return core.normals[a as usize];
        };
        let mut forward = None;
        let mut reverse = None;
        for &e in faces {
            let t = core.mesh.triangles[e as usize];
            let goes = (0..3).any(|k| t[k] == a && t[(k + 1) % 3] == b);
            if goes && forward.is_none() {
                forward = Some(e);
            } else if !goes && reverse.is_none() {
                reverse = Some(e);
            }
        }
        match forward.or(reverse) {
            Some(e) => core.tris[e as usize].frame.normal,
            None => core.normals[a as usize],
        }
    }

    /// Rib `rib`'s edge `e` under `layout`, where it is rib `r`.
    fn rib_element_in(
        &self,
        layout: &RibLayout,
        rib: &Rib,
        r: usize,
        e: usize,
    ) -> ([usize; 14], K14) {
        let core = &self.core;
        let (pa, pb) = layout.edges[r][e];
        let g = rib_ids(layout, pa, pb, 6 * core.mesh.vertices.len());
        let (a, b) = (layout.vertex[pa] as usize, layout.vertex[pb] as usize);
        let (xa, xb) = (core.mesh.vertices[a], core.mesh.vertices[b]);
        let sign = match rib.side {
            RibSide::Positive => 1.0,
            RibSide::Negative => -1.0,
            RibSide::Centered => 0.0,
        };
        // Checked when the rib came in.
        let props = rib
            .section
            .properties(rib.height)
            .expect("a checked rib section");
        // Both ends of one element stand on the same face: the triangle
        // that contains the edge in the stored a → b order. A vertex in
        // the middle of one face is not a crease and keeps its averaged
        // normal, so a flat wall is unchanged. At a crease the foot is
        // that face's normal; the web axis (set in `layout_of`) is the
        // miter of the rib's own faces.
        let on_edge = core.on_crease[a] || core.on_crease[b];
        let face = if on_edge {
            self.rib_face_normal(a as u32, b as u32)
        } else {
            [0.0; 3]
        };
        let end = |v: usize, psi: usize| {
            let n = if core.on_crease[v] {
                face
            } else {
                core.normals[v]
            };
            RibEnd {
                foot: scale(n, sign * 0.5 * core.mesh.thickness[v]),
                up_web: scale(n, sign * props.centroid),
                lateral: layout.lateral[psi],
            }
        };
        let axis = normalize(sub(xb, xa)).unwrap_or([1.0, 0.0, 0.0]);
        let (modulus, shear) = core.section.rib_moduli(axis);
        let section = BeamSection {
            e: modulus,
            g: shear,
            props,
        };
        let na = if core.on_crease[a] {
            face
        } else {
            core.normals[a]
        };
        let nb = if core.on_crease[b] {
            face
        } else {
            core.normals[b]
        };
        // A mesh edge lies in the surface, so the mean normal is never along it.
        let k = beam::rib_stiffness(xa, xb, add(na, nb), [end(a, pa), end(b, pb)], &section)
            .expect("a mesh edge is never along the surface normal");
        (g, k)
    }

    fn load_vector(&self, case: &[ShellLoad]) -> Result<Vec<f64>, SimError> {
        let core = &self.core;
        let n = core.mesh.vertices.len();
        let mut f = vec![0.0; 6 * n];
        let node_ok = |node: u32| {
            if node as usize >= n {
                Err(SimError::new(format!(
                    "A load names vertex {node}, which the shell does not have."
                )))
            } else {
                Ok(node as usize)
            }
        };
        let tris_ok = |list: &[u32]| -> Result<(), SimError> {
            if list.is_empty() {
                return Err(SimError::new("A load needs at least one triangle."));
            }
            if list.iter().any(|&t| t as usize >= core.tris.len()) {
                return Err(SimError::new(
                    "A load names a triangle the shell does not have.",
                ));
            }
            Ok(())
        };
        let finite = |v: &[f64]| {
            if v.iter().all(|x| x.is_finite()) {
                Ok(())
            } else {
                Err(SimError::new("A load must be a finite number."))
            }
        };
        let spread = |f: &mut Vec<f64>, t: usize, force: [f64; 3]| {
            for &v in &core.mesh.triangles[t] {
                for k in 0..3 {
                    f[6 * v as usize + k] += force[k] / 3.0;
                }
            }
        };
        for load in case {
            match load {
                ShellLoad::Force { node, force } => {
                    finite(force)?;
                    let i = node_ok(*node)?;
                    for k in 0..3 {
                        f[6 * i + k] += force[k];
                    }
                }
                ShellLoad::Moment { node, moment } => {
                    finite(moment)?;
                    let i = node_ok(*node)?;
                    for k in 0..3 {
                        f[6 * i + 3 + k] += moment[k];
                    }
                }
                ShellLoad::Pressure {
                    triangles,
                    pressure,
                } => {
                    finite(&[*pressure])?;
                    tris_ok(triangles)?;
                    for &t in triangles {
                        let tri = &core.tris[t as usize];
                        spread(
                            &mut f,
                            t as usize,
                            scale(tri.frame.normal, -pressure * tri.area),
                        );
                    }
                }
                ShellLoad::SpreadForce { triangles, force } => {
                    finite(force)?;
                    tris_ok(triangles)?;
                    let total: f64 = triangles.iter().map(|&t| core.tris[t as usize].area).sum();
                    for &t in triangles {
                        let share = core.tris[t as usize].area / total;
                        spread(&mut f, t as usize, scale(*force, share));
                    }
                }
            }
        }
        Ok(f)
    }

    fn recover_mode(
        &self,
        u: &[f64],
        f: &[f64],
        pivot_ratio: f64,
        mode: RecoverMode,
    ) -> ShellResult {
        let core = &self.core;
        let n = core.mesh.vertices.len();
        let compliance = f.iter().zip(u).map(|(a, b)| a * b).sum();
        if mode == RecoverMode::ComplianceOnly {
            let mut max = (0.0, 0usize);
            for i in 0..n {
                let m = norm([u[6 * i], u[6 * i + 1], u[6 * i + 2]]);
                if m > max.0 {
                    max = (m, i);
                }
            }
            return ShellResult {
                displacement: Vec::new(),
                rotation: Vec::new(),
                strain_energy: 0.0,
                compliance,
                elements: Vec::new(),
                rib_energy: Vec::new(),
                max_deflection: max.0,
                max_deflection_node: max.1 as u32,
                max_deflection_at: core.mesh.vertices[max.1],
                pivot_ratio,
            };
        }
        let rib_energy: Vec<f64> = self
            .rib_elements
            .iter()
            .map(|elems| {
                elems
                    .iter()
                    .map(|(g, k)| quadratic(k, &g.map(|id| u[id])))
                    .sum()
            })
            .collect();
        let (elements, strain_energy) = if mode == RecoverMode::Full {
            let elements: Vec<ElementResult> = (0..core.tris.len())
                .into_par_iter()
                .map(|e| self.element_result(e, u))
                .collect();
            let strain_energy = elements
                .iter()
                .map(|e| e.membrane_energy + e.bending_energy)
                .sum::<f64>()
                + rib_energy.iter().sum::<f64>();
            (elements, strain_energy)
        } else {
            (Vec::new(), 0.0)
        };
        let displacement: Vec<[f64; 3]> = (0..n)
            .map(|i| [u[6 * i], u[6 * i + 1], u[6 * i + 2]])
            .collect();
        let rotation: Vec<[f64; 3]> = (0..n)
            .map(|i| [u[6 * i + 3], u[6 * i + 4], u[6 * i + 5]])
            .collect();
        let mut max = (0.0, 0usize);
        for (i, d) in displacement.iter().enumerate() {
            let m = norm(*d);
            if m > max.0 {
                max = (m, i);
            }
        }
        ShellResult {
            displacement,
            rotation,
            strain_energy,
            compliance,
            elements,
            rib_energy,
            max_deflection: max.0,
            max_deflection_node: max.1 as u32,
            max_deflection_at: core.mesh.vertices[max.1],
            pivot_ratio,
        }
    }

    fn element_result(&self, e: usize, u: &[f64]) -> ElementResult {
        let core = &self.core;
        let tri = &core.tris[e];
        let frame = tri.frame;
        let t = core.mesh.triangles[e];
        let mut um = [0.0; 9];
        let mut ub = [0.0; 9];
        for a in 0..3 {
            let base = 6 * t[a] as usize;
            let tr = frame.to_local([u[base], u[base + 1], u[base + 2]]);
            let rot = frame.to_local([u[base + 3], u[base + 4], u[base + 5]]);
            let local = [tr[0], tr[1], tr[2], rot[0], rot[1], rot[2]];
            for i in 0..3 {
                um[3 * a + i] = local[MEMBRANE[i]];
                ub[3 * a + i] = local[BENDING[i]];
            }
        }
        let (km, kb) = core.element_local(e);
        let th = core.element_thickness[e];
        let a = core.section.membrane(th, &frame);
        let d = core.section.bending(th, &frame);
        let strain = membrane::centroid_strain(core.options.membrane, &tri.xy, &um);
        let curvature = plate::centroid_curvature(&tri.xy, &ub);
        let mut force = [0.0; 3];
        let mut moment = [0.0; 3];
        for r in 0..3 {
            force[r] = (0..3).map(|q| a[r][q] * strain[q]).sum();
            moment[r] = -(0..3).map(|q| d[r][q] * curvature[q]).sum::<f64>();
        }
        ElementResult {
            frame,
            area: tri.area,
            thickness: th,
            membrane_energy: quadratic(&km, &um),
            bending_energy: quadratic(&kb, &ub),
            membrane_force: Principal::of(force, &frame),
            bending_moment: Principal::of(moment, &frame),
        }
    }

    /// Membrane force `[Nxx, Nyy, Nxy]` in facet `e`'s local frame, matching
    /// `element_result(e, u).membrane_force.local` bit for bit without
    /// rebuilding Allman/DKT element stiffness matrices.
    fn element_membrane_force(&self, e: usize, u: &[f64]) -> [f64; 3] {
        let core = &self.core;
        let tri = &core.tris[e];
        let frame = tri.frame;
        let t = core.mesh.triangles[e];
        let mut um = [0.0; 9];
        for a in 0..3 {
            let base = 6 * t[a] as usize;
            let tr = frame.to_local([u[base], u[base + 1], u[base + 2]]);
            let rot = frame.to_local([u[base + 3], u[base + 4], u[base + 5]]);
            let local = [tr[0], tr[1], tr[2], rot[0], rot[1], rot[2]];
            for i in 0..3 {
                um[3 * a + i] = local[MEMBRANE[i]];
            }
        }
        let th = core.element_thickness[e];
        let a = core.section.membrane(th, &frame);
        let strain = membrane::centroid_strain(core.options.membrane, &tri.xy, &um);
        let mut force = [0.0; 3];
        for r in 0..3 {
            force[r] = (0..3).map(|q| a[r][q] * strain[q]).sum();
        }
        force
    }

    /// Solve one load case and recover only per-triangle membrane forces plus
    /// compliance and max deflection, for [`Self::buckling_state`].
    fn solve_for_buckling(
        &mut self,
        case: &[ShellLoad],
    ) -> Result<(Vec<[f64; 3]>, ShellResult), SimError> {
        let f = self.load_vector(case)?;
        let n = self.core.mesh.vertices.len();
        let pivot_ratio = self.ensure_factor()?;
        let symbolic = self.ensure_symbolic()?;
        let started = Instant::now();
        let free = self.pattern().n;
        let mut rhs = Mat::<f64>::zeros(free, 1);
        let shell_lift = &self.core.shell_lift;
        let rib_lift = &self.rib_lift;
        let dof = &self.core.dof;
        if rib_lift.is_empty() {
            for d in 0..free {
                rhs[(d, 0)] = shell_lift[d];
            }
        } else {
            for d in 0..free {
                let shell = shell_lift.get(d).copied().unwrap_or(0.0);
                rhs[(d, 0)] = shell + rib_lift[d];
            }
        }
        for i in 0..6 * n {
            let d = dof[i];
            if d != HELD {
                rhs[(d, 0)] += f[i];
            }
        }
        sparse::solve_in_place_with(
            &symbolic,
            &self.factor_values,
            &mut rhs,
            self.threads,
            &mut self.solve_scratch,
        )?;
        self.timings.solve = started.elapsed().as_secs_f64();
        let started = Instant::now();
        let mut u = self.core.prescribed.clone();
        u.extend_from_slice(&self.layout.value);
        for i in 0..6 * n {
            let d = self.core.dof[i];
            if d != HELD {
                u[i] = rhs[(d, 0)];
            }
        }
        for (k, &d) in self.layout.free.iter().enumerate() {
            if d != HELD {
                u[6 * n + k] = rhs[(d, 0)];
            }
        }
        if u.iter().any(|v| !v.is_finite()) {
            return Err(crate::error::not_held());
        }
        let forces: Vec<[f64; 3]> = (0..self.core.tris.len())
            .map(|e| self.element_membrane_force(e, &u))
            .collect();
        let result = self.recover_mode(&u, &f, pivot_ratio, RecoverMode::ComplianceOnly);
        self.timings.recover = started.elapsed().as_secs_f64();
        Ok((forces, result))
    }

    /// The free-dof mass matrix, upper triangle, same pattern as the
    /// stiffness. Consistent translational mass of the wall (linear
    /// triangle, ρ t) on ux, uy, uz, and the same for each rib end through
    /// the offset map that builds its stiffness. No mass on a rotation,
    /// the drilling dof, or the web's own ψ.
    pub(crate) fn mass_upper(&self, density: f64, rib_mass: bool) -> Vec<f64> {
        let core = &self.core;
        let mut values = vec![0.0; self.pattern().nnz()];
        for (e, tri) in core.tris.iter().enumerate() {
            let t = core.mesh.triangles[e];
            let mass = density * core.element_thickness[e] * tri.area;
            let corners = [t[0] as usize, t[1] as usize, t[2] as usize];
            for a in 0..3 {
                for b in a..3 {
                    let m = mass * if a == b { 1.0 / 6.0 } else { 1.0 / 12.0 };
                    for dof in 0..3 {
                        self.add_mass(&mut values, 6 * corners[a] + dof, 6 * corners[b] + dof, m);
                    }
                }
            }
        }
        if rib_mass {
            for r in 0..self.ribs.len() {
                for e in 0..self.ribs[r].edges.len() {
                    self.add_rib_mass(&mut values, r, e, density);
                }
            }
        }
        values
    }

    fn add_mass(&self, values: &mut [f64], id_a: usize, id_b: usize, m: f64) {
        if m == 0.0 {
            return;
        }
        let fa = self.free_in(&self.layout, id_a);
        let fb = self.free_in(&self.layout, id_b);
        if fa == HELD || fb == HELD {
            return;
        }
        let (r, c) = if fa <= fb { (fa, fb) } else { (fb, fa) };
        let p = self
            .pattern()
            .position(r, c)
            .expect("a mass pair is a stiffness pair");
        values[p] += m;
    }

    /// Half the rib element's mass at each end, on the three translations
    /// of the section centroid, carried to the vertex dofs by the same map
    /// as the stiffness. No ρ I L on ψ.
    fn add_rib_mass(&self, values: &mut [f64], r: usize, e: usize, density: f64) {
        let core = &self.core;
        let layout = &self.layout;
        let rib = &self.ribs[r];
        let (pa, pb) = layout.edges[r][e];
        let ids = rib_ids(layout, pa, pb, 6 * core.mesh.vertices.len());
        let (a, b) = (layout.vertex[pa] as usize, layout.vertex[pb] as usize);
        let (xa, xb) = (core.mesh.vertices[a], core.mesh.vertices[b]);
        let len = norm(sub(xb, xa));
        let props = rib
            .section
            .properties(rib.height)
            .expect("a checked rib section");
        let sign = match rib.side {
            RibSide::Positive => 1.0,
            RibSide::Negative => -1.0,
            RibSide::Centered => 0.0,
        };
        let on_edge = core.on_crease[a] || core.on_crease[b];
        let face = if on_edge {
            self.rib_face_normal(a as u32, b as u32)
        } else {
            [0.0; 3]
        };
        let end = |v: usize, psi: usize| {
            let n = if core.on_crease[v] {
                face
            } else {
                core.normals[v]
            };
            RibEnd {
                foot: scale(n, sign * 0.5 * core.mesh.thickness[v]),
                up_web: scale(n, sign * props.centroid),
                lateral: layout.lateral[psi],
            }
            .map()
        };
        let maps = [end(a, pa), end(b, pb)];
        let m = density * props.area * len / 2.0;
        let blocks = [
            [ids[0], ids[1], ids[2], ids[3], ids[4], ids[5], ids[12]],
            [ids[6], ids[7], ids[8], ids[9], ids[10], ids[11], ids[13]],
        ];
        for (map, block) in maps.iter().zip(blocks) {
            for c1 in 0..7 {
                for c2 in c1..7 {
                    let mut s = 0.0;
                    for i in 0..3 {
                        s += map[i][c1] * map[i][c2];
                    }
                    self.add_mass(values, block[c1], block[c2], m * s);
                }
            }
        }
    }

    /// `uᵀ M v` on free dofs. `mass` is [`ShellModel::mass_upper`].
    pub(crate) fn mass_inner(&self, mass: &[f64], u: &[f64], v: &[f64]) -> f64 {
        super::modes::sym_dot(self.pattern(), mass, u, v)
    }

    /// The lowest `count` modes. Rayleigh ω² = vᵀ K v / vᵀ M v. Rib mass is
    /// in M when `rib_mass` is set, which is how a plan reports Hz.
    pub fn lowest_modes(
        &mut self,
        density: f64,
        count: usize,
    ) -> Result<super::modes::ModeSet, SimError> {
        self.lowest_modes_with(density, count, true)
    }

    /// As [`ShellModel::lowest_modes`]. `rib_mass` false leaves the ribs'
    /// mass out, so a caller can see how much of the frequency is the
    /// ribs' weight. A plan reports the frequency with the mass included.
    pub fn lowest_modes_with(
        &mut self,
        density: f64,
        count: usize,
        rib_mass: bool,
    ) -> Result<super::modes::ModeSet, SimError> {
        if !(density.is_finite() && density > 0.0) {
            return Err(SimError::new("The density must be above zero."));
        }
        if count == 0 || self.pattern().n == 0 {
            return Ok(super::modes::ModeSet {
                modes: Vec::new(),
                seconds: 0.0,
            });
        }
        let mass = self.mass_upper(density, rib_mass);
        let stiffness = self.values();
        self.ensure_factor()?;
        let symbolic = self.ensure_symbolic()?;
        super::modes::lowest(
            self.pattern(),
            &stiffness,
            &mass,
            &symbolic,
            &self.factor_values,
            count,
        )
    }

    /// Buckling load factors of `case`, lowest positive first.
    ///
    /// The static solve supplies the membrane force on each triangle. The
    /// pencil is K φ = λ S φ with S = −Kg, Kg the plate geometric stiffness
    /// of those forces (DKT slopes). Membrane Kg is left out: the study
    /// found it changes no printed digit of this mode. Beam Kg is left out
    /// too: a rib buckling on its own is not this factor. Each triangle
    /// uses its own force and its own frame, so a folded wall is the same
    /// sum. No positive λ is [`crate::error::no_buckling_compression`], not
    /// a factor of zero.
    pub fn buckling_modes(
        &mut self,
        case: &[ShellLoad],
        count: usize,
    ) -> Result<BucklingSet, SimError> {
        Ok(self.buckling_state(case, count)?.0)
    }

    /// Vertex displacements of a free-dof vector (a mode). Held vertices
    /// stay at rest.
    pub fn vertex_motion(&self, free: &[f64]) -> Result<Vec<[f64; 3]>, SimError> {
        Ok(self.result_of_free(free)?.displacement)
    }

    /// Lower generalised eigenvalue of φᵢᵀ ΔK φⱼ against φᵢᵀ S φⱼ, S = −Kg
    /// of `case`. The rise in the lowest load factor a rib would buy in
    /// that subspace, with the pre-stress held. A repeated pair uses the
    /// projected 2×2, so a node-line rib is not scored as if it had raised
    /// both.
    pub fn buckling_cluster_shift(
        &mut self,
        case: &[ShellLoad],
        rib: &Rib,
        vectors: &[Vec<f64>],
    ) -> Result<f64, SimError> {
        let (_, metric, _) = self.buckling_state(case, 1.max(vectors.len()))?;
        let gram = self.mass_gram(vectors, &metric);
        self.cluster_shift_mass(std::slice::from_ref(rib), vectors, &gram)
    }

    /// The positive factors, the upper triangle of S = −Kg, and the static
    /// solution the forces came from.
    pub(crate) fn buckling_state(
        &mut self,
        case: &[ShellLoad],
        count: usize,
    ) -> Result<(BucklingSet, Vec<f64>, ShellResult), SimError> {
        if self.pattern().n == 0 {
            return Err(SimError::new("The shell has nothing free to buckle."));
        }
        if count == 0 {
            return Err(SimError::new("A buckling solve needs at least one mode."));
        }
        let (forces, solved) = self.solve_for_buckling(case)?;
        // A wall with no compression has S = 0. The Krylov–Schur step then
        // reorthogonalises a zero vector and never returns (faer's Arnoldi
        // loop treats `0 < ε·0` as false). There is no positive λ in that
        // pencil, so refuse before the eigenproblem. 1e-9 N/mm is far above
        // a static solve's roundoff and far below a load anyone would ask
        // about, in these units (N, mm).
        if most_compressive(&forces) >= -1e-9 {
            return Err(crate::error::no_buckling_compression());
        }
        let metric = self.geometric_upper(&forces);
        let stiffness = self.values();
        self.ensure_factor()?;
        let symbolic = self.ensure_symbolic()?;
        let (found, seconds) = super::modes::positive_rays(
            self.pattern(),
            &stiffness,
            &metric,
            &symbolic,
            &self.factor_values,
            count,
        )?;
        if found.is_empty() {
            return Err(crate::error::no_buckling_compression());
        }
        let modes = found
            .into_iter()
            .map(|m| BucklingMode {
                lambda: m.omega2,
                vector: m.vector,
            })
            .collect();
        Ok((BucklingSet { modes, seconds }, metric, solved))
    }

    /// Upper triangle of S = −Kg. Plate bending dofs only: membrane dofs
    /// and every rib carry nothing. See [`plate::geometric`].
    fn geometric_upper(&self, forces: &[[f64; 3]]) -> Vec<f64> {
        let core = &self.core;
        let mut values = vec![0.0; self.pattern().nnz()];
        for (e, force) in forces.iter().enumerate() {
            let kg = plate::geometric(&core.tris[e].xy, core.tris[e].area, *force);
            let mut neg = [[0.0; 9]; 9];
            for i in 0..9 {
                for j in 0..9 {
                    neg[i][j] = -kg[i][j];
                }
            }
            let global = self.bend_global(e, &neg);
            let t = core.mesh.triangles[e];
            let mut g = [0usize; 18];
            for a in 0..3 {
                for q in 0..6 {
                    g[6 * a + q] = 6 * t[a] as usize + q;
                }
            }
            self.scatter_upper_nonzero(&g, &global, &mut values);
        }
        values
    }

    /// A 9×9 bending matrix, in the facet frame, on the 18 global dofs.
    fn bend_global(&self, e: usize, kb: &K9) -> [[f64; 18]; 18] {
        let mut kl = [[0.0; 18]; 18];
        for a in 0..3 {
            for b in 0..3 {
                for i in 0..3 {
                    for j in 0..3 {
                        kl[6 * a + BENDING[i]][6 * b + BENDING[j]] = kb[3 * a + i][3 * b + j];
                    }
                }
            }
        }
        let r = self.core.tris[e].frame.rows();
        let mut kg = [[0.0; 18]; 18];
        for bi in 0..6 {
            for bj in 0..6 {
                let mut kr = [[0.0; 3]; 3];
                for i in 0..3 {
                    for j in 0..3 {
                        kr[i][j] = (0..3).map(|q| kl[3 * bi + i][3 * bj + q] * r[q][j]).sum();
                    }
                }
                for i in 0..3 {
                    for j in 0..3 {
                        kg[3 * bi + i][3 * bj + j] =
                            (0..3).map(|q| r[q][i] * kr[q][j]).sum();
                    }
                }
            }
        }
        kg
    }

    /// A free-dof vector as a shell result, so a mode can feed the same
    /// direction field a static solution does. Held dofs stay at rest:
    /// a mode is the motion about the holds, not the holds themselves.
    pub(crate) fn result_of_free(&self, free: &[f64]) -> Result<ShellResult, SimError> {
        let core = &self.core;
        if free.len() != self.pattern().n {
            return Err(SimError::new("The vector is not one of this shell."));
        }
        let n = core.mesh.vertices.len();
        let mut u = vec![0.0; core.prescribed.len()];
        for (id, &d) in core.dof.iter().enumerate() {
            if d != HELD {
                u[id] = free[d];
            }
        }
        u.resize(6 * n + self.layout.vertex.len(), 0.0);
        for (k, &d) in self.layout.free.iter().enumerate() {
            if d != HELD {
                u[6 * n + k] = free[d];
            }
        }
        let f = vec![0.0; u.len()];
        let pivot = self.factor_pivot.unwrap_or(1.0);
        Ok(self.recover_mode(&u, &f, pivot, RecoverMode::Full))
    }

    /// Lower generalised eigenvalue of φᵢᵀ ΔK φⱼ against φᵢᵀ M φⱼ, with
    /// each vector's web rotations relaxed. Δ(ω²) of the worst vector in
    /// the span, so a node line of one returned vector cannot hide the
    /// other. M is this model's mass, without `rib`.
    pub fn cluster_shift(
        &self,
        rib: &Rib,
        vectors: &[Vec<f64>],
        density: f64,
    ) -> Result<f64, SimError> {
        let mass = self.mass_upper(density, true);
        let gram = self.mass_gram(vectors, &mass);
        self.cluster_shift_mass(std::slice::from_ref(rib), vectors, &gram)
    }

    /// φᵢᵀ M φⱼ for a cluster, row-major. It does not depend on a candidate
    /// rib, so a round of [`ShellModel::cluster_shift_mass`] computes it once.
    pub(crate) fn mass_gram(&self, vectors: &[Vec<f64>], mass: &[f64]) -> Vec<f64> {
        let n = vectors.len();
        let mut b = vec![0.0; n * n];
        for i in 0..n {
            for j in i..n {
                let m = self.mass_inner(mass, &vectors[i], &vectors[j]);
                b[i * n + j] = m;
                b[j * n + i] = m;
            }
        }
        b
    }

    /// The same score for several ribs at once: one projected matrix, the
    /// sum of their stiffnesses, not the sum of their scores. `mass_gram`
    /// is [`ShellModel::mass_gram`] for these vectors.
    pub(crate) fn cluster_shift_mass(
        &self,
        ribs: &[Rib],
        vectors: &[Vec<f64>],
        mass_gram: &[f64],
    ) -> Result<f64, SimError> {
        let preps: Vec<PreparedRib> = ribs
            .iter()
            .map(|r| self.prepare_rib(r))
            .collect::<Result<_, _>>()?;
        self.cluster_shift_prepared(&preps, vectors, mass_gram)
    }

    /// Cluster shift score using precomputed [`PreparedRib`]s.
    pub(crate) fn cluster_shift_prepared(
        &self,
        preps: &[PreparedRib],
        vectors: &[Vec<f64>],
        mass_gram: &[f64],
    ) -> Result<f64, SimError> {
        let n = vectors.len();
        if n == 0 {
            return Err(SimError::new("A cluster score needs a mode."));
        }
        if mass_gram.len() != n * n {
            return Err(SimError::new("The mass Gram does not match the cluster."));
        }
        let mut states = Vec::with_capacity(n);
        for v in vectors {
            let mut one = Vec::new();
            for prep in preps {
                one.extend(self.prepared_rib_state(prep, v)?);
            }
            states.push(one);
        }
        let mut a = vec![0.0; n * n];
        let mut b = vec![0.0; n * n];
        for i in 0..n {
            for j in i..n {
                let mut s = 0.0;
                for (e, (_, k, xi)) in states[i].iter().enumerate() {
                    s += bilinear(k, xi, &states[j][e].2);
                }
                a[i * n + j] = s;
                a[j * n + i] = s;
                b[i * n + j] = mass_gram[i * n + j];
                b[j * n + i] = mass_gram[j * n + i];
            }
        }
        Ok(super::modes::lower_generalized(&a, &b, n))
    }

    /// One probed rib's element states: stiffness and the 14 amplitudes
    /// with ψ relaxed against `vector` (a free-dof vector of this model).
    fn prepared_rib_state(
        &self,
        prep: &PreparedRib,
        vector: &[f64],
    ) -> Result<Vec<RibState>, SimError> {
        if vector.len() != self.pattern().n {
            return Err(SimError::new("The vector is not one of this shell."));
        }
        let core = &self.core;
        let base = 6 * core.mesh.vertices.len();
        let value = |id: usize| -> f64 {
            if id < base {
                let d = core.dof[id];
                if d == HELD {
                    0.0
                } else {
                    vector[d]
                }
            } else {
                0.0
            }
        };
        let free = &prep.layout.free;
        let mut rhs = vec![0.0; prep.nf];
        for (g, k) in &prep.elements {
            for i in 12..14 {
                let fi = free[g[i] - base];
                if fi == HELD {
                    continue;
                }
                for j in 0..14 {
                    if j < 12 {
                        rhs[fi] -= k[i][j] * value(g[j]);
                    } else {
                        let fj = free[g[j] - base];
                        if fj == HELD {
                            rhs[fi] -= k[i][j] * prep.layout.value[g[j] - base];
                        }
                    }
                }
            }
        }
        let psi_free = prep.factor.solve(&rhs);
        let m = prep.layout.vertex.len();
        let mut psi = prep.layout.value.clone();
        for k in 0..m {
            if free[k] != HELD {
                psi[k] = psi_free[free[k]];
            }
        }
        let mut out = Vec::with_capacity(prep.elements.len());
        for (g, k) in &prep.elements {
            let x = std::array::from_fn(|q| {
                if q < 12 {
                    value(g[q])
                } else {
                    psi[g[q] - base]
                }
            });
            out.push((*g, *k, x));
        }
        Ok(out)
    }
}

/// One rib element's stiffness and the 14 amplitudes with ψ relaxed.
type RibState = ([usize; 14], K14, [f64; 14]);

/// The 14 dof ids of a rib element between web rotations `pa` and `pb`:
/// both vertices' six, then the two ψ (`base` = 6 × vertex count).
fn rib_ids(layout: &RibLayout, pa: usize, pb: usize, base: usize) -> [usize; 14] {
    let (a, b) = (layout.vertex[pa] as usize, layout.vertex[pb] as usize);
    let mut g = [0usize; 14];
    for q in 0..6 {
        g[q] = 6 * a + q;
        g[6 + q] = 6 * b + q;
    }
    g[12] = base + pa;
    g[13] = base + pb;
    g
}

/// Factor a symmetric positive-definite tridiagonal matrix for Thomas solves.
fn factor_tridiag(mut diag: Vec<f64>, off: Vec<f64>) -> Option<SmallFactor> {
    let n = diag.len();
    let mut mult = Vec::with_capacity(n.saturating_sub(1));
    for i in 1..n {
        if diag[i - 1].abs() < 1e-300 {
            return None;
        }
        let f = off[i - 1] / diag[i - 1];
        diag[i] -= f * off[i - 1];
        mult.push(f);
    }
    for i in (0..n).rev() {
        if diag[i].is_nan() || diag[i] <= 0.0 {
            return None;
        }
    }
    Some(SmallFactor::Tridiag { mult, diag, off })
}

/// Factor the dense symmetric positive definite `k` (`k` row-major, `n × n`),
/// taking the tridiagonal band when it is tridiagonal and dense Cholesky
/// otherwise.
fn factor_small_spd(mut k: Vec<f64>, n: usize) -> Option<SmallFactor> {
    let tridiagonal = (0..n).all(|i| (0..n).all(|j| i.abs_diff(j) <= 1 || k[i * n + j] == 0.0));
    if tridiagonal {
        let diag: Vec<f64> = (0..n).map(|i| k[i * n + i]).collect();
        let off: Vec<f64> = (1..n).map(|i| k[i * n + i - 1]).collect();
        return factor_tridiag(diag, off);
    }
    for j in 0..n {
        let mut d = k[j * n + j];
        for q in 0..j {
            d -= k[j * n + q] * k[j * n + q];
        }
        if d.is_nan() || d <= 0.0 {
            return None;
        }
        let d = d.sqrt();
        k[j * n + j] = d;
        for i in j + 1..n {
            let mut s = k[i * n + j];
            for q in 0..j {
                s -= k[i * n + q] * k[j * n + q];
            }
            k[i * n + j] = s / d;
        }
    }
    Some(SmallFactor::Dense { l: k, nf: n })
}

/// `uᵀ K v`.
fn bilinear<const N: usize>(k: &[[f64; N]; N], u: &[f64; N], v: &[f64; N]) -> f64 {
    let mut s = 0.0;
    for i in 0..N {
        for j in 0..N {
            s += u[i] * k[i][j] * v[j];
        }
    }
    s
}

/// `½ uᵀ K u`.
fn quadratic<const N: usize>(k: &[[f64; N]; N], u: &[f64; N]) -> f64 {
    let mut s = 0.0;
    for i in 0..N {
        let row: f64 = (0..N).map(|j| k[i][j] * u[j]).sum();
        s += u[i] * row;
    }
    0.5 * s
}

#[cfg(test)]
mod mode_shape {
    use super::{ShellHold, ShellMesh, ShellModel, ShellOptions};

    /// A nonzero prescribed hold must not appear in the mode shape. Held
    /// dofs stay at rest.
    #[test]
    fn a_mode_shape_starts_from_rest() {
        let (a, b) = (100.0, 50.0);
        let mesh = ShellMesh::rectangle([a, b], [8, 4], 1.0);
        let mat = crate::shell::IsotropicShell::new(2000.0, 0.3)
            .unwrap()
            .with_density(1.0e-9)
            .unwrap();
        let corner = 0usize;
        let prescribed_uz = 1.25;
        let prescribed_rz = 0.4;
        let mut holds = Vec::new();
        for (i, p) in mesh.vertices.iter().enumerate() {
            let on_edge = p[0] == 0.0 || p[1] == 0.0 || p[0] == a || p[1] == b;
            if !on_edge {
                continue;
            }
            if i == corner {
                holds.push(ShellHold {
                    node: i as u32,
                    dofs: [
                        Some(0.0),
                        Some(0.0),
                        Some(prescribed_uz),
                        Some(0.0),
                        Some(0.0),
                        Some(prescribed_rz),
                    ],
                });
            } else {
                holds.push(ShellHold::clamped(i as u32));
            }
        }
        let mut model = ShellModel::new(mesh, mat, &holds, ShellOptions::default()).unwrap();
        model.set_threads(1);
        let modes = model.lowest_modes(1.0e-9, 1).unwrap();
        let shape = model.result_of_free(&modes.modes[0].vector).unwrap();
        let d = shape.displacement[corner];
        let r = shape.rotation[corner];
        assert_eq!(
            d,
            [0.0, 0.0, 0.0],
            "held displacement {d:?} kept the prescribed uz {prescribed_uz}"
        );
        assert_eq!(
            r,
            [0.0, 0.0, 0.0],
            "held rotation {r:?} kept the prescribed θz {prescribed_rz}"
        );
        let peak = shape
            .displacement
            .iter()
            .map(|u| u[2].abs())
            .fold(0.0, f64::max);
        println!(
            "prescribed hold uz {prescribed_uz} θz {prescribed_rz}; mode at that node displacement {d:?} rotation {r:?}; peak |uz| {peak}"
        );
        assert!(peak > 1e-8, "the mode shape did not move, peak |uz| {peak}");
    }
}
