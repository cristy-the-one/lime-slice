//! The shell model: mesh, holds and ribs in; displacements, energies and
//! principal directions out.

use std::collections::HashMap;
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
use super::sparse::{self, Factor, Pattern, HELD};
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

/// A shell with its stiffness assembled and its pattern analysed, ready to
/// take ribs and load cases.
///
/// **Re-solving with other ribs.** The shell's part of the matrix is
/// assembled once, in [`ShellModel::new`], and kept. [`ShellModel::set_ribs`],
/// [`ShellModel::add_rib`] and [`ShellModel::remove_rib`] only rebuild the
/// rib part and mark the factor stale. Free dofs number the shell's first
/// and the ribs' web rotations after them, so the shell's columns of the
/// matrix never move: its values are reused as they are, and a rib change
/// appends columns, re-runs the ordering (AMD) and the numeric
/// factorisation. The timing test gives both costs. A rank-k update of
/// that factor (Sherman–Morrison–Woodbury on the rib's own dofs) was
/// measured and lost: the condensed block is full rank, and one solve
/// per rib dof costs more than refactoring except for ribs shorter than
/// any candidate (see the note in `select`, and handover §3).
///
/// **Web rotations.** Each rib has one extra dof per vertex it runs
/// through, ψ (see [`super::beam`]). It is held when the vertex's three
/// rotations are all held (a clamped end clamps the web too) and free
/// otherwise.
pub struct ShellModel {
    mesh: ShellMesh,
    section: Box<dyn ShellSection>,
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
    /// Ribs' web rotations: where they sit and how they number.
    layout: RibLayout,
    /// The current pattern: the shell's columns, then the web rotations'.
    pattern: Pattern,
    symbolic: SymbolicCholesky<usize>,
    shell_values: Vec<f64>,
    shell_lift: Vec<f64>,
    ribs: Vec<Rib>,
    rib_values: Vec<f64>,
    rib_lift: Vec<f64>,
    factor: Option<Factor>,
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
        let (on_crease, edge_faces) = crease_map(&mesh, &tris);
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
        let analysing = Instant::now();
        let symbolic = pattern.analyse()?;
        let analyse = analysing.elapsed().as_secs_f64();
        let mut model = Self {
            mesh,
            section: Box::new(section),
            options,
            tris,
            element_thickness,
            normals: normal_unit,
            on_crease,
            edge_faces,
            neighbours,
            dof,
            prescribed,
            shell_values: vec![0.0; pattern.nnz()],
            shell_lift: vec![0.0; free],
            rib_values: vec![0.0; pattern.nnz()],
            rib_lift: vec![0.0; free],
            symbolic,
            shell_pattern: pattern.clone(),
            layout: RibLayout::default(),
            pattern,
            ribs: Vec::new(),
            factor: None,
            factorisations: 0,
            timings: Timings::default(),
            threads: 0,
        };
        model.assemble_shell();
        // Mesh checks, adjacency and the element loop; the ordering apart.
        model.timings.assemble_shell = started.elapsed().as_secs_f64() - analyse;
        model.timings.analyse = analyse;
        Ok(model)
    }

    pub fn mesh(&self) -> &ShellMesh {
        &self.mesh
    }

    pub fn options(&self) -> ShellOptions {
        self.options
    }

    /// Unit normal at each vertex: the area-weighted mean of its triangles'.
    pub fn vertex_normals(&self) -> &[[f64; 3]] {
        &self.normals
    }

    pub fn ribs(&self) -> &[Rib] {
        &self.ribs
    }

    /// How many free dofs the system has.
    pub fn free_dofs(&self) -> usize {
        self.pattern.n
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
    /// columns, order it, and assemble every rib.
    fn rebuild_ribs(&mut self) -> Result<(), SimError> {
        let started = Instant::now();
        self.factor = None;
        let layout = self.layout_ribs();
        let n_shell = self.shell_pattern.n;
        let base = 6 * self.mesh.vertices.len();
        // Columns of the free web rotations, rows from every rib element
        // that touches them.
        let n_free = layout.free.iter().filter(|&&f| f != HELD).count();
        let mut extra: Vec<Vec<usize>> = vec![Vec::new(); n_free];
        for edges in &layout.edges {
            for &(pa, pb) in edges {
                let ids = rib_ids(&layout, pa, pb, base);
                let frees: Vec<usize> = ids
                    .iter()
                    .map(|&id| self.free_in(&layout, id))
                    .filter(|&f| f != HELD)
                    .collect();
                for &c in &frees {
                    if c < n_shell {
                        continue;
                    }
                    for &r in &frees {
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
        let pattern = self.shell_pattern.extend(&extra);
        let analysing = Instant::now();
        self.symbolic = pattern.analyse()?;
        self.timings.analyse = analysing.elapsed().as_secs_f64();
        self.layout = layout;
        self.pattern = pattern;
        let mut values = vec![0.0; self.pattern.nnz()];
        let mut lift = vec![0.0; self.pattern.n];
        for r in 0..self.ribs.len() {
            for e in 0..self.ribs[r].edges.len() {
                let (g, k) = self.rib_element(r, e);
                self.scatter(&g, &k, &mut values, &mut lift);
            }
        }
        self.rib_values = values;
        self.rib_lift = lift;
        self.timings.assemble_ribs = started.elapsed().as_secs_f64() - self.timings.analyse;
        Ok(())
    }

    /// Give every rib a web rotation at each of its vertices, with its axis
    /// and hold.
    fn layout_ribs(&self) -> RibLayout {
        self.layout_of(&self.ribs, self.shell_pattern.n)
    }

    /// The web-rotation layout of `ribs`, free ψ numbered from `first_free`.
    fn layout_of(&self, ribs: &[Rib], first_free: usize) -> RibLayout {
        let mut layout = RibLayout::default();
        let mut tangent: Vec<[f64; 3]> = Vec::new();
        // Face normals of the rib edges at each crease vertex. A vertex
        // that is not a crease never reads this and keeps `self.normals`.
        let mut face_sum: Vec<[f64; 3]> = Vec::new();
        let mut free = first_free;
        for rib in ribs {
            let mut at: Vec<(u32, usize)> = Vec::new();
            let mut edges = Vec::with_capacity(rib.edges.len());
            for &(a, b) in &rib.edges {
                let dir = normalize(sub(
                    self.mesh.vertices[b as usize],
                    self.mesh.vertices[a as usize],
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
                if self.on_crease[a as usize] || self.on_crease[b as usize] {
                    let nf = self.rib_face_normal(a, b);
                    if self.on_crease[a as usize] {
                        face_sum[ids[0]] = add(face_sum[ids[0]], nf);
                    }
                    if self.on_crease[b as usize] {
                        face_sum[ids[1]] = add(face_sum[ids[1]], nf);
                    }
                }
                edges.push((ids[0], ids[1]));
            }
            layout.edges.push(edges);
        }
        for (k, &v) in layout.vertex.iter().enumerate() {
            let n = if self.on_crease[v as usize] {
                normalize(face_sum[k]).unwrap_or(self.normals[v as usize])
            } else {
                self.normals[v as usize]
            };
            let lateral = normalize(cross(n, tangent[k]))
                .or_else(|| normalize(cross(n, [1.0, 0.0, 0.0])))
                .or_else(|| normalize(cross(n, [0.0, 1.0, 0.0])))
                .expect("a unit normal has a perpendicular");
            layout.lateral.push(lateral);
            let rot = 6 * v as usize + 3;
            if (0..3).all(|q| self.dof[rot + q] == HELD) {
                let theta = [0, 1, 2].map(|q| self.prescribed[rot + q]);
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
        let base = 6 * self.mesh.vertices.len();
        if id < base {
            self.dof[id]
        } else {
            layout.free[id - base]
        }
    }

    /// Solve one load case.
    pub fn solve(&mut self, case: &[ShellLoad]) -> Result<ShellResult, SimError> {
        let mut all = self.solve_cases(std::slice::from_ref(&case.to_vec()))?;
        Ok(all.remove(0))
    }

    /// Solve several load cases on one factor.
    pub fn solve_cases(&mut self, cases: &[LoadCase]) -> Result<Vec<ShellResult>, SimError> {
        let n = self.mesh.vertices.len();
        let mut forces = Vec::with_capacity(cases.len());
        for case in cases {
            forces.push(self.load_vector(case)?);
        }
        self.ensure_factor()?;
        let started = Instant::now();
        let free = self.pattern.n;
        let mut rhs = Mat::<f64>::zeros(free, cases.len());
        for (c, f) in forces.iter().enumerate() {
            for d in 0..free {
                let shell = self.shell_lift.get(d).copied().unwrap_or(0.0);
                rhs[(d, c)] = shell + self.rib_lift[d];
            }
            for i in 0..6 * n {
                let d = self.dof[i];
                if d != HELD {
                    rhs[(d, c)] += f[i];
                }
            }
        }
        let factor = self.factor.as_ref().expect("factored above");
        sparse::solve_in_place(&self.symbolic, factor, &mut rhs, self.threads)?;
        self.timings.solve = started.elapsed().as_secs_f64();
        let started = Instant::now();
        let mut out = Vec::with_capacity(cases.len());
        for (c, f) in forces.iter().enumerate() {
            // Vertex dofs, then the web rotations.
            let mut u = self.prescribed.clone();
            u.extend_from_slice(&self.layout.value);
            for i in 0..6 * n {
                let d = self.dof[i];
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
            out.push(self.recover(&u, f, factor.pivot_ratio));
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
        let mut out = Vec::with_capacity(self.pattern.nnz());
        for c in 0..self.pattern.n {
            for p in self.pattern.col_ptr[c]..self.pattern.col_ptr[c + 1] {
                out.push((self.pattern.row_idx[p], c, values[p]));
            }
        }
        (self.pattern.n, out)
    }

    /// Shell and rib values over the current pattern. The shell's columns
    /// come first in it, so the shell's values are its prefix.
    fn values(&self) -> Vec<f64> {
        let mut values = self.rib_values.clone();
        for (v, s) in values.iter_mut().zip(&self.shell_values) {
            *v += s;
        }
        values
    }

    fn ensure_factor(&mut self) -> Result<(), SimError> {
        if self.factor.is_some() {
            return Ok(());
        }
        let started = Instant::now();
        let values = self.values();
        let factor = sparse::factor(&self.pattern, &self.symbolic, &values, self.threads)?;
        self.factorisations += 1;
        self.factor = Some(factor);
        self.timings.factor = started.elapsed().as_secs_f64();
        Ok(())
    }

    /// Membrane and bending stiffness of facet `e` in its own frame.
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

    /// Facet `e`'s 18 × 18 stiffness on its corners' global dofs.
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
        let mut values = vec![0.0; self.pattern.nnz()];
        let mut lift = vec![0.0; self.pattern.n];
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
                self.scatter(&g, k, &mut values, &mut lift);
            }
            start = end;
        }
        self.shell_values = values;
        self.shell_lift = lift;
    }

    /// The held value of dof id `id` (vertex dofs, then web rotations).
    fn held_value(&self, id: usize) -> f64 {
        let base = 6 * self.mesh.vertices.len();
        if id < base {
            self.prescribed[id]
        } else {
            self.layout.value[id - base]
        }
    }

    /// Add an element matrix on dof ids `g`: free–free pairs into the
    /// matrix, free–held pairs times the held value into the load lift.
    fn scatter<const N: usize>(
        &self,
        g: &[usize; N],
        k: &[[f64; N]; N],
        values: &mut [f64],
        lift: &mut [f64],
    ) {
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
                    let p = self
                        .pattern
                        .position(fi, fj)
                        .expect("every element pair is in the pattern");
                    values[p] += k[i][j];
                }
            }
        }
    }

    fn check_rib(&self, rib: &Rib) -> Result<(), SimError> {
        rib.section.check(rib.height)?;
        if rib.edges.is_empty() {
            return Err(SimError::new("A rib needs at least one edge."));
        }
        let n = self.mesh.vertices.len();
        for &(a, b) in &rib.edges {
            if a as usize >= n || b as usize >= n {
                return Err(SimError::new(format!(
                    "Rib edge {a}–{b} names a vertex the shell does not have."
                )));
            }
            if a == b || self.neighbours[a as usize].binary_search(&b).is_err() {
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
        self.check_rib(rib)?;
        let n = self.mesh.vertices.len();
        if result.displacement.len() != n || result.rotation.len() != n {
            return Err(SimError::new("The result is not one of this shell."));
        }
        let layout = self.layout_of(std::slice::from_ref(rib), 0);
        let m = layout.vertex.len();
        let base = 6 * n;
        let value = |id: usize| -> f64 {
            let v = id / 6;
            let k = id % 6;
            if k < 3 {
                result.displacement[v][k]
            } else {
                result.rotation[v][k - 3]
            }
        };
        let elements: Vec<([usize; 14], K14)> = (0..rib.edges.len())
            .map(|e| self.rib_element_in(&layout, rib, 0, e))
            .collect();
        // Kψψ ψ = −Kψu u over the free ψ; held ψ move to the right side.
        let free: Vec<usize> = layout.free.clone();
        let nf = free.iter().filter(|&&f| f != HELD).count();
        let mut kpp = vec![0.0; nf * nf];
        let mut rhs = vec![0.0; nf];
        for (g, k) in &elements {
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
                            rhs[fi] -= k[i][j] * layout.value[g[j] - base];
                        } else {
                            kpp[fi * nf + fj] += k[i][j];
                        }
                    }
                }
            }
        }
        let psi_free = solve_small_spd(&mut kpp, &mut rhs, nf)
            .ok_or_else(|| SimError::new("A probed rib's web has no stiffness."))?;
        let mut psi = layout.value.clone();
        for k in 0..m {
            if free[k] != HELD {
                psi[k] = psi_free[free[k]];
            }
        }
        let mut energy = 0.0;
        for (g, k) in &elements {
            let x: [f64; 14] = std::array::from_fn(|q| {
                if q < 12 {
                    value(g[q])
                } else {
                    psi[g[q] - base]
                }
            });
            energy += quadratic(k, &x);
        }
        Ok(energy)
    }

    /// The normal of the face the directed edge `a` → `b` belongs to.
    /// The triangle of lowest index that lists the edge in that order
    /// wins; if none does, the lowest that lists it reversed. Both ends
    /// of a rib element call this once, so they stand on the same face.
    fn rib_face_normal(&self, a: u32, b: u32) -> [f64; 3] {
        let key = if a < b { (a, b) } else { (b, a) };
        let Some(faces) = self.edge_faces.get(&key) else {
            return self.normals[a as usize];
        };
        let mut forward = None;
        let mut reverse = None;
        for &e in faces {
            let t = self.mesh.triangles[e as usize];
            let goes = (0..3).any(|k| t[k] == a && t[(k + 1) % 3] == b);
            if goes && forward.is_none() {
                forward = Some(e);
            } else if !goes && reverse.is_none() {
                reverse = Some(e);
            }
        }
        match forward.or(reverse) {
            Some(e) => self.tris[e as usize].frame.normal,
            None => self.normals[a as usize],
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
        let (pa, pb) = layout.edges[r][e];
        let g = rib_ids(layout, pa, pb, 6 * self.mesh.vertices.len());
        let (a, b) = (layout.vertex[pa] as usize, layout.vertex[pb] as usize);
        let (xa, xb) = (self.mesh.vertices[a], self.mesh.vertices[b]);
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
        let on_edge = self.on_crease[a] || self.on_crease[b];
        let face = if on_edge {
            self.rib_face_normal(a as u32, b as u32)
        } else {
            [0.0; 3]
        };
        let end = |v: usize, psi: usize| {
            let n = if self.on_crease[v] {
                face
            } else {
                self.normals[v]
            };
            RibEnd {
                foot: scale(n, sign * 0.5 * self.mesh.thickness[v]),
                up_web: scale(n, sign * props.centroid),
                lateral: layout.lateral[psi],
            }
        };
        let axis = normalize(sub(xb, xa)).unwrap_or([1.0, 0.0, 0.0]);
        let (modulus, shear) = self.section.rib_moduli(axis);
        let section = BeamSection {
            e: modulus,
            g: shear,
            props,
        };
        let na = if self.on_crease[a] {
            face
        } else {
            self.normals[a]
        };
        let nb = if self.on_crease[b] {
            face
        } else {
            self.normals[b]
        };
        // A mesh edge lies in the surface, so the mean normal is never along it.
        let k = beam::rib_stiffness(xa, xb, add(na, nb), [end(a, pa), end(b, pb)], &section)
            .expect("a mesh edge is never along the surface normal");
        (g, k)
    }

    fn load_vector(&self, case: &[ShellLoad]) -> Result<Vec<f64>, SimError> {
        let n = self.mesh.vertices.len();
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
            if list.iter().any(|&t| t as usize >= self.tris.len()) {
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
            for &v in &self.mesh.triangles[t] {
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
                        let tri = &self.tris[t as usize];
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
                    let total: f64 = triangles.iter().map(|&t| self.tris[t as usize].area).sum();
                    for &t in triangles {
                        let share = self.tris[t as usize].area / total;
                        spread(&mut f, t as usize, scale(*force, share));
                    }
                }
            }
        }
        Ok(f)
    }

    fn recover(&self, u: &[f64], f: &[f64], pivot_ratio: f64) -> ShellResult {
        let n = self.mesh.vertices.len();
        let elements: Vec<ElementResult> = (0..self.tris.len())
            .into_par_iter()
            .map(|e| self.element_result(e, u))
            .collect();
        let rib_energy: Vec<f64> = (0..self.ribs.len())
            .map(|r| {
                (0..self.ribs[r].edges.len())
                    .map(|e| {
                        let (g, k) = self.rib_element(r, e);
                        quadratic(&k, &g.map(|id| u[id]))
                    })
                    .sum()
            })
            .collect();
        let strain_energy = elements
            .iter()
            .map(|e| e.membrane_energy + e.bending_energy)
            .sum::<f64>()
            + rib_energy.iter().sum::<f64>();
        let compliance = f.iter().zip(u).map(|(a, b)| a * b).sum();
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
            max_deflection_at: self.mesh.vertices[max.1],
            pivot_ratio,
        }
    }

    fn element_result(&self, e: usize, u: &[f64]) -> ElementResult {
        let tri = &self.tris[e];
        let frame = tri.frame;
        let t = self.mesh.triangles[e];
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
        let (km, kb) = self.element_local(e);
        let th = self.element_thickness[e];
        let a = self.section.membrane(th, &frame);
        let d = self.section.bending(th, &frame);
        let strain = membrane::centroid_strain(self.options.membrane, &tri.xy, &um);
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

    /// The free-dof mass matrix, upper triangle, same pattern as the
    /// stiffness. Consistent translational mass of the wall (linear
    /// triangle, ρ t) on ux, uy, uz, and the same for each rib end through
    /// the offset map that builds its stiffness. No mass on a rotation,
    /// the drilling dof, or the web's own ψ.
    pub(crate) fn mass_upper(&self, density: f64, rib_mass: bool) -> Vec<f64> {
        let mut values = vec![0.0; self.pattern.nnz()];
        for (e, tri) in self.tris.iter().enumerate() {
            let t = self.mesh.triangles[e];
            let mass = density * self.element_thickness[e] * tri.area;
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
            .pattern
            .position(r, c)
            .expect("a mass pair is a stiffness pair");
        values[p] += m;
    }

    /// Half the rib element's mass at each end, on the three translations
    /// of the section centroid, carried to the vertex dofs by the same map
    /// as the stiffness. No ρ I L on ψ.
    fn add_rib_mass(&self, values: &mut [f64], r: usize, e: usize, density: f64) {
        let layout = &self.layout;
        let rib = &self.ribs[r];
        let (pa, pb) = layout.edges[r][e];
        let ids = rib_ids(layout, pa, pb, 6 * self.mesh.vertices.len());
        let (a, b) = (layout.vertex[pa] as usize, layout.vertex[pb] as usize);
        let (xa, xb) = (self.mesh.vertices[a], self.mesh.vertices[b]);
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
        let on_edge = self.on_crease[a] || self.on_crease[b];
        let face = if on_edge {
            self.rib_face_normal(a as u32, b as u32)
        } else {
            [0.0; 3]
        };
        let end = |v: usize, psi: usize| {
            let n = if self.on_crease[v] {
                face
            } else {
                self.normals[v]
            };
            RibEnd {
                foot: scale(n, sign * 0.5 * self.mesh.thickness[v]),
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
        super::modes::sym_dot(&self.pattern, mass, u, v)
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
        if count == 0 || self.pattern.n == 0 {
            return Ok(super::modes::ModeSet {
                modes: Vec::new(),
                seconds: 0.0,
            });
        }
        let mass = self.mass_upper(density, rib_mass);
        let stiffness = self.values();
        self.ensure_factor()?;
        let factor = self.factor.as_ref().expect("just factored");
        super::modes::lowest(
            &self.pattern,
            &stiffness,
            &mass,
            &self.symbolic,
            factor,
            count,
        )
    }

    /// A free-dof vector as a shell result, so a mode can feed the same
    /// direction field a static solution does. Held dofs stay at rest.
    pub(crate) fn result_of_free(&self, free: &[f64]) -> Result<ShellResult, SimError> {
        if free.len() != self.pattern.n {
            return Err(SimError::new("The vector is not one of this shell."));
        }
        let n = self.mesh.vertices.len();
        let mut u = self.prescribed.clone();
        for (id, &d) in self.dof.iter().enumerate() {
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
        let pivot = self.factor.as_ref().map_or(1.0, |f| f.pivot_ratio);
        Ok(self.recover(&u, &f, pivot))
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
        self.cluster_shift_mass(std::slice::from_ref(rib), vectors, &mass)
    }

    /// The same score for several ribs at once: one projected matrix, the
    /// sum of their stiffnesses, not the sum of their scores.
    pub(crate) fn cluster_shift_mass(
        &self,
        ribs: &[Rib],
        vectors: &[Vec<f64>],
        mass: &[f64],
    ) -> Result<f64, SimError> {
        let n = vectors.len();
        if n == 0 {
            return Err(SimError::new("A cluster score needs a mode."));
        }
        for rib in ribs {
            self.check_rib(rib)?;
        }
        let mut states = Vec::with_capacity(n);
        for v in vectors {
            let mut one = Vec::new();
            for rib in ribs {
                one.extend(self.rib_state(rib, v)?);
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
                let m = self.mass_inner(mass, &vectors[i], &vectors[j]);
                b[i * n + j] = m;
                b[j * n + i] = m;
            }
        }
        Ok(super::modes::lower_generalized(&a, &b, n))
    }

    /// One probed rib's element states: stiffness and the 14 amplitudes
    /// with ψ relaxed against `vector` (a free-dof vector of this model).
    fn rib_state(&self, rib: &Rib, vector: &[f64]) -> Result<Vec<RibState>, SimError> {
        if vector.len() != self.pattern.n {
            return Err(SimError::new("The vector is not one of this shell."));
        }
        let n = self.mesh.vertices.len();
        let layout = self.layout_of(std::slice::from_ref(rib), 0);
        let m = layout.vertex.len();
        let base = 6 * n;
        let value = |id: usize| -> f64 {
            if id < base {
                let d = self.dof[id];
                if d == HELD {
                    0.0
                } else {
                    vector[d]
                }
            } else {
                0.0
            }
        };
        let elements: Vec<([usize; 14], K14)> = (0..rib.edges.len())
            .map(|e| self.rib_element_in(&layout, rib, 0, e))
            .collect();
        let free = &layout.free;
        let nf = free.iter().filter(|&&f| f != HELD).count();
        let mut kpp = vec![0.0; nf * nf];
        let mut rhs = vec![0.0; nf];
        for (g, k) in &elements {
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
                            rhs[fi] -= k[i][j] * layout.value[g[j] - base];
                        } else {
                            kpp[fi * nf + fj] += k[i][j];
                        }
                    }
                }
            }
        }
        let psi_free = solve_small_spd(&mut kpp, &mut rhs, nf)
            .ok_or_else(|| SimError::new("A probed rib's web has no stiffness."))?;
        let mut psi = layout.value.clone();
        for k in 0..m {
            if free[k] != HELD {
                psi[k] = psi_free[free[k]];
            }
        }
        let mut out = Vec::with_capacity(elements.len());
        for (g, k) in elements {
            let x = std::array::from_fn(|q| {
                if q < 12 {
                    value(g[q])
                } else {
                    psi[g[q] - base]
                }
            });
            out.push((g, k, x));
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

/// Solve the dense symmetric positive definite `k x = b` (`k` row-major,
/// `n × n`) by Cholesky, in place. A rib's web rotations form a chain, so
/// `k` is tridiagonal in practice and the band is used when it is.
fn solve_small_spd(k: &mut [f64], b: &mut [f64], n: usize) -> Option<Vec<f64>> {
    let tridiagonal = (0..n).all(|i| (0..n).all(|j| i.abs_diff(j) <= 1 || k[i * n + j] == 0.0));
    if tridiagonal {
        // Thomas on the symmetric tridiagonal.
        let mut diag: Vec<f64> = (0..n).map(|i| k[i * n + i]).collect();
        let off: Vec<f64> = (1..n).map(|i| k[i * n + i - 1]).collect();
        let mut x = b.to_vec();
        for i in 1..n {
            if diag[i - 1].abs() < 1e-300 {
                return None;
            }
            let f = off[i - 1] / diag[i - 1];
            diag[i] -= f * off[i - 1];
            x[i] -= f * x[i - 1];
        }
        for i in (0..n).rev() {
            if diag[i].is_nan() || diag[i] <= 0.0 {
                return None;
            }
            if i + 1 < n {
                x[i] -= off[i] * x[i + 1];
            }
            x[i] /= diag[i];
        }
        return Some(x);
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
    let mut x = b.to_vec();
    for i in 0..n {
        for q in 0..i {
            x[i] -= k[i * n + q] * x[q];
        }
        x[i] /= k[i * n + i];
    }
    for i in (0..n).rev() {
        for q in i + 1..n {
            x[i] -= k[q * n + i] * x[q];
        }
        x[i] /= k[i * n + i];
    }
    Some(x)
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
