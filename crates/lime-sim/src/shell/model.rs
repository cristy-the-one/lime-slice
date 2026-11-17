//! The shell model: mesh, holds and ribs in; displacements, energies and
//! principal directions out.

use std::time::Instant;

use faer::sparse::linalg::cholesky::SymbolicCholesky;
use faer::Mat;
use rayon::prelude::*;

use super::beam::{self, BeamSection, RibEnd, K14};
use super::geometry::{triangle, Frame, Tri};
use super::membrane::{self, MembraneKind, K9};
use super::plate;
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

/// A rib: a rectangular section `width × height` (mm) standing on the wall
/// along a chain of mesh edges. Its centroid sits `t/2 + height/2` off the
/// mid-surface on its side, `t` the wall's thickness at each vertex.
#[derive(Clone, Debug, PartialEq)]
pub struct Rib {
    pub edges: Vec<(u32, u32)>,
    pub width: f64,
    pub height: f64,
    pub side: RibSide,
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
/// factorisation. The timing test gives both costs. A rank-k update of the
/// factor for a rib of k edges would be cheaper and is left for later.
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
        let mut layout = RibLayout::default();
        let mut tangent: Vec<[f64; 3]> = Vec::new();
        let mut free = self.shell_pattern.n;
        for rib in &self.ribs {
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
                edges.push((ids[0], ids[1]));
            }
            layout.edges.push(edges);
        }
        for (k, &v) in layout.vertex.iter().enumerate() {
            let n = self.normals[v as usize];
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
        sparse::solve_in_place(&self.symbolic, factor, &mut rhs)?;
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
        let factor = sparse::factor(&self.pattern, &self.symbolic, &values)?;
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
        if !(rib.width.is_finite() && rib.width > 0.0 && rib.height.is_finite() && rib.height > 0.0)
        {
            return Err(SimError::new(
                "A rib's width and height must be above zero.",
            ));
        }
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
        let rib = &self.ribs[r];
        let (pa, pb) = self.layout.edges[r][e];
        let g = rib_ids(&self.layout, pa, pb, 6 * self.mesh.vertices.len());
        let (a, b) = (
            self.layout.vertex[pa] as usize,
            self.layout.vertex[pb] as usize,
        );
        let (xa, xb) = (self.mesh.vertices[a], self.mesh.vertices[b]);
        let sign = match rib.side {
            RibSide::Positive => 1.0,
            RibSide::Negative => -1.0,
            RibSide::Centered => 0.0,
        };
        let end = |v: usize, psi: usize| {
            let n = self.normals[v];
            RibEnd {
                foot: scale(n, sign * 0.5 * self.mesh.thickness[v]),
                up_web: scale(n, sign * 0.5 * rib.height),
                lateral: self.layout.lateral[psi],
            }
        };
        let axis = normalize(sub(xb, xa)).unwrap_or([1.0, 0.0, 0.0]);
        let (modulus, shear) = self.section.rib_moduli(axis);
        let section = BeamSection {
            e: modulus,
            g: shear,
            width: rib.width,
            height: rib.height,
        };
        // A mesh edge lies in the surface, so the mean normal is never along it.
        let k = beam::rib_stiffness(
            xa,
            xb,
            add(self.normals[a], self.normals[b]),
            [end(a, pa), end(b, pb)],
            &section,
        )
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
}

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

/// `½ uᵀ K u`.
fn quadratic<const N: usize>(k: &[[f64; N]; N], u: &[f64; N]) -> f64 {
    let mut s = 0.0;
    for i in 0..N {
        let row: f64 = (0..N).map(|j| k[i][j] * u[j]).sum();
        s += u[i] * row;
    }
    0.5 * s
}
