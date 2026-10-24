//! In-house linear static stress solver.
//!
//! Length is millimetres, force is newtons, stress and modulus are MPa.
//! The result is an in-house estimate, not a certification.
//!
//! The driver is a loop over load steps and a loop over iterations even when
//! a study has one linear step. `factor` on a step is an increment of the
//! load level, not an absolute target. A second factor of 0 does not move
//! the displacement.

// Voigt and nodal loops index a fixed slot on purpose. An iterator hides the
// component.
#![allow(clippy::needless_range_loop)]

pub mod assemble;
pub mod build_axis;
pub mod element;
pub mod error;
pub mod estimate;
pub mod fields;
pub mod iterative;
pub mod material;
pub mod memory;
pub mod multigrid;
pub mod mesh;
pub mod recipe;
pub mod skin;
pub mod slice_field;
pub mod sliced;
pub mod sliced_study;
pub mod solve;
pub mod study;
pub mod trust;
pub mod units;

pub use assemble::{Hold, Load, NodeHold};
pub use element::ElementKind;
pub use error::SimError;
pub use fields::{Solution, Summary, LABEL};
pub use mesh::{beam, grid, patch_mesh, Mesh};
pub use study::{Card, Request, Study};

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use rayon::prelude::*;

use assemble::{add_increment, assemble, rel_norm};
use element::{sample_element, shape_of};
use error::{node_cap, not_held, temperature_refused, tet4_refused, zero_axis};
use estimate::{Estimator, Zz};
use fields::GaussSample;
use material::{
    compliance_of, von_mises, BeadComposite, BeadMaxStress, BeadSection, FailureCriterion, Governs,
    MatState, MaterialContext, MaterialModel, MaxStress, Stress,
};
use recipe::volume_fractions;
use sliced::CellMaterial;
use solve::{FaerLdlt, LinearSolver};
use study::{modal_sentence, validate_request_fields};
use trust::{level_of, TrustInput, TrustLevel};
use units::{mass_g, norm, normalize, NODE_CAP, SLICED_NODE_CAP};

/// A displacement this large, in millimetres, is a rigid mode that Cholesky
/// did not report as an exact zero pivot.
const RIGID_DISPLACEMENT_MM: f64 = 1.0e8;

/// A solved step whose residual is larger than this did not satisfy equilibrium.
const RELATIVE_RESIDUAL_MAX: f64 = 1.0e-6;

/// Peak displacement above this many bounding-box diagonals is a rigid swing.
const DISPLACEMENT_OVER_DIAGONAL: f64 = 10.0;

/// Smallest LDLᵀ pivot over the largest. Below this the part is not held.
const PIVOT_RATIO_MIN: f64 = 1.0e-12;

/// State a post-step sees. v1 has no post-step that succeeds.
pub struct SolveState<'a> {
    pub displacement: &'a mut [[f64; 3]],
    pub load_level: f64,
    pub residual: f64,
}

pub trait PostStep {
    fn after(&self, state: &mut SolveState<'_>) -> Result<(), SimError>;
}

struct UnavailablePostStep;

impl PostStep for UnavailablePostStep {
    fn after(&self, _state: &mut SolveState<'_>) -> Result<(), SimError> {
        Err(SimError::new("A post-step is not in this version."))
    }
}

pub fn solve(study: &Study, mesh: &Mesh) -> Result<Solution, SimError> {
    solve_request(&study.to_request(mesh)?)
}

pub fn solve_request(req: &Request) -> Result<Solution, SimError> {
    let mut solved = solve_cases(req, std::slice::from_ref(&req.loads))?;
    Ok(solved.solutions.remove(0))
}

/// Solutions of one request under several load cases, and how many times
/// the stiffness was factored to get them.
pub struct CaseSolutions {
    pub solutions: Vec<Solution>,
    pub factorisations: usize,
    /// How many values the last factor holds, so a caller can size another.
    pub factor_len: usize,
}

/// Solve `req` once per load case in `cases`; `req.loads` is not read. A
/// linear study's stiffness doesn't depend on its loads, so it is factored
/// once and each case is one more back-substitution.
pub fn solve_cases(req: &Request, cases: &[Vec<Load>]) -> Result<CaseSolutions, SimError> {
    solve_cases_with(req, cases, &mut FaerLdlt::default())
}

/// [`solve_cases`] with a solver the caller holds: an iterative one, or a
/// direct one whose factor the caller keeps for a later solve.
pub fn solve_cases_with(
    req: &Request,
    cases: &[Vec<Load>],
    solver: &mut dyn LinearSolver,
) -> Result<CaseSolutions, SimError> {
    validate_request_fields(req)?;
    if req.temperature_c.is_some() || req.fibre_axis.is_some() {
        return Err(temperature_refused());
    }
    if !req.allow_linear_tets && req.mesh.kind == ElementKind::Tet4 {
        return Err(tet4_refused());
    }
    if !matches!(req.mesh.kind, ElementKind::Tet4 | ElementKind::Tet10) {
        return Err(SimError::new(format!(
            "{} is not in this version.",
            req.mesh.kind.name()
        )));
    }
    // A sliced grid is sized by its memory budget, so its cap is only a backstop.
    let cap = if req.representation == "sliced" {
        SLICED_NODE_CAP
    } else {
        NODE_CAP
    };
    if req.mesh.nodes.len() > cap {
        return Err(node_cap(req.mesh.nodes.len()));
    }
    let axis = normalize(req.build_axis).ok_or_else(zero_axis)?;
    if req.analysis == "modal" {
        return Err(modal_sentence());
    }
    if req.analysis != "static" {
        return Err(SimError::new(format!(
            "{} is not in this version.",
            req.analysis
        )));
    }

    stage(req, "mesh");
    let made = Materials::of(req, axis);
    let beads = made.beads(req);
    let mut solutions = Vec::with_capacity(cases.len());
    for loads in cases {
        solutions.push(solve_case(
            req,
            loads,
            made.material(req),
            beads,
            axis,
            &made.cells,
            solver,
        )?);
    }
    Ok(CaseSolutions {
        solutions,
        factorisations: solver.factor_count(),
        factor_len: solver.factor_len(),
    })
}

/// What a request's elements are made of: per-element cells, and the bead
/// composite a sliced request with beads solves with.
struct Materials {
    cells: Vec<CellMaterial>,
    composite: Option<BeadComposite>,
}

impl Materials {
    fn of(req: &Request, axis: [f64; 3]) -> Self {
        let sliced = req.representation == "sliced";
        let cells = if sliced {
            req.cells.clone()
        } else {
            volume_fractions(&req.mesh, &req.recipe, axis)
                .into_iter()
                .map(CellMaterial::smeared)
                .collect()
        };
        let composite = req
            .beads
            .as_ref()
            .filter(|_| sliced)
            .map(|b| BeadComposite {
                beads: b.clone(),
                nu: req.material.nu,
                density_g_cm3: req.material.density_g_cm3,
            });
        Self { cells, composite }
    }

    fn beads<'a>(&self, req: &'a Request) -> Option<&'a BeadSection> {
        req.beads.as_ref().filter(|_| req.representation == "sliced")
    }

    fn material<'a>(&'a self, req: &'a Request) -> &'a dyn MaterialModel {
        match &self.composite {
            Some(c) => c,
            None => &req.material,
        }
    }
}

/// One load case. A linear study reuses a factor the solver already holds.
#[allow(clippy::too_many_arguments)]
fn solve_case(
    req: &Request,
    loads: &[Load],
    material: &dyn MaterialModel,
    beads: Option<&BeadSection>,
    axis: [f64; 3],
    cells: &[CellMaterial],
    solver: &mut dyn LinearSolver,
) -> Result<Solution, SimError> {
    let mut u = vec![[0.0; 3]; req.mesh.nodes.len()];
    let mut load_level = 0.0;
    let mut steps_run = 0;

    // A linear solve's end state, read off the system it solved instead of
    // assembling the grid again: the residual, the volumes, the free dofs.
    let mut linear_end: Option<(f64, f64, f64, usize)> = None;
    for step in &req.steps {
        load_level += step.factor;
        steps_run += 1;
        for _iter in 0..step.max_iter {
            stage(req, "assemble");
            let dof = assemble::build_dof(req.mesh.nodes.len(), &req.holds)?;
            let assembly = assemble(
                &req.mesh,
                material,
                axis,
                cells,
                loads,
                load_level,
                req.gravity,
                &u,
                dof,
                &req.holds,
            )?;
            if assembly.system.dof.n_free == 0 {
                add_increment(
                    &mut u,
                    &assembly.system.dof,
                    &[],
                    &assembly.system.prescribed,
                );
                break;
            }
            if !(req.linear && solver.factor_count() > 0) {
                stage(req, "factor");
                solver.attach_dofs(&assembly.system.dof);
                solver.factor(&assembly.system.k, assembly.system.dof.n_free)?;
            }
            if cancelled(req.cancel.as_ref()) {
                return Err(SimError::new("The solve was cancelled."));
            }
            let mut du = vec![0.0; assembly.system.dof.n_free];
            solver.solve(&assembly.system.residual, &mut du)?;
            add_increment(
                &mut u,
                &assembly.system.dof,
                &du,
                &assembly.system.prescribed,
            );
            if exploded(&u) {
                return Err(not_held());
            }
            if req.linear {
                // After K du = r, the residual is r − K du.
                let system = &assembly.system;
                let mut left = system.residual.clone();
                for &(i, j, v) in &system.k {
                    left[i] -= v * du[j];
                    if i != j {
                        left[j] -= v * du[i];
                    }
                }
                linear_end = Some((
                    rel_norm(&left, &system.external),
                    assembly.solid_volume,
                    assembly.printed_volume,
                    system.dof.n_free,
                ));
                break;
            }
            let check = assemble(
                &req.mesh,
                material,
                axis,
                cells,
                loads,
                load_level,
                req.gravity,
                &u,
                assemble::build_dof(req.mesh.nodes.len(), &req.holds)?,
                &req.holds,
            )?;
            if rel_norm(&check.system.residual, &check.system.external) < step.tol {
                break;
            }
        }
        let mut state = SolveState {
            displacement: &mut u,
            load_level,
            residual: 0.0,
        };
        for _hook in &req.post_steps {
            UnavailablePostStep.after(&mut state)?;
        }
        load_level = state.load_level;
    }

    if cancelled(req.cancel.as_ref()) {
        return Err(SimError::new("The solve was cancelled."));
    }

    stage(req, "recover");
    let (residual, solid_volume, printed_volume, free) = match linear_end {
        Some(end) => end,
        None => {
            let final_dof = assemble::build_dof(req.mesh.nodes.len(), &req.holds)?;
            let last = assemble(
                &req.mesh,
                material,
                axis,
                cells,
                loads,
                load_level,
                req.gravity,
                &u,
                final_dof,
                &req.holds,
            )?;
            (
                rel_norm(&last.system.residual, &last.system.external),
                last.solid_volume,
                last.printed_volume,
                last.system.dof.n_free,
            )
        }
    };
    let peak = u.iter().copied().map(norm).fold(0.0_f64, f64::max);
    let diagonal = bbox_diagonal(&req.mesh.nodes);
    // The same predicate is what `level_of` reads. A failure refuses here,
    // before recovery, so a mechanism never comes back as a rough result.
    let rigid_failed = residual > RELATIVE_RESIDUAL_MAX
        || peak > DISPLACEMENT_OVER_DIAGONAL * diagonal
        || (free > 0 && solver.pivots().is_some_and(|p| p < PIVOT_RATIO_MIN));
    if rigid_failed {
        return Err(not_held());
    }
    let h_mm = if req.h_mm > 0.0 {
        req.h_mm
    } else {
        req.mesh.edge_length()
    };
    recover(
        req,
        material,
        beads,
        axis,
        cells,
        u,
        residual,
        solid_volume,
        printed_volume,
        free,
        h_mm,
        steps_run,
        rigid_failed,
    )
}

#[allow(clippy::too_many_arguments)]
fn recover(
    req: &Request,
    material: &dyn MaterialModel,
    beads: Option<&BeadSection>,
    axis: [f64; 3],
    cells: &[CellMaterial],
    displacement: Vec<[f64; 3]>,
    residual: f64,
    solid_volume: f64,
    printed_volume: f64,
    dofs: usize,
    h_mm: f64,
    steps_run: usize,
    rigid_failed: bool,
) -> Result<Solution, SimError> {
    let mesh = &req.mesh;
    let made_of = |ei: usize| cells.get(ei).copied().unwrap_or(CellMaterial::smeared(1.0));
    let vf: Vec<f64> = cells.iter().map(|c| c.volume_fraction).collect();
    // Each element's samples on its own thread, kept in element order.
    let per_element: Vec<Vec<GaussSample>> = mesh
        .elements
        .par_iter()
        .enumerate()
        .map(|(ei, cell)| {
            let mut gauss = Vec::new();
            let coords: Vec<[f64; 3]> = cell.nodes.iter().map(|n| mesh.nodes[*n]).collect();
            let mut local_u = vec![0.0; cell.nodes.len() * 3];
            for (a, node) in cell.nodes.iter().enumerate() {
                for k in 0..3 {
                    local_u[a * 3 + k] = displacement[*node][k];
                }
            }
            let mat_ctx = made_of(ei).context(axis);
            let mut state = MatState::default();
            let (_, tangent) = material.stress_tangent(&[0.0; 6], &mut state, &mat_ctx);
            let compliance = compliance_of(&tangent.c);
            for sample in sample_element(mesh.kind, &coords, &local_u, material, &mat_ctx) {
                let shape = shape_of(mesh.kind, sample.xi);
                let mut xyz = [0.0; 3];
                for (a, weight) in shape.n.iter().enumerate() {
                    for k in 0..3 {
                        xyz[k] += weight * coords[a][k];
                    }
                }
                gauss.push(GaussSample {
                    element: ei,
                    xi: sample.xi,
                    weight_det: sample.weight_det,
                    stress: sample.stress,
                    strain: sample.strain,
                    xyz,
                    compliance,
                });
            }
            gauss
        })
        .collect();
    let gauss: Vec<GaussSample> = per_element.into_iter().flatten().collect();

    // Extrapolated to the corners and averaged by volume. The same field the estimator smooths with.
    let nodal_stress = estimate::recover_nodal(mesh, &gauss);
    let allow = req.material.allowables();
    // A node takes the element around it with the lowest fraction. A node on
    // both a wall and the core is limited by the core, which is the
    // conservative choice.
    let mut nodal_cell: Vec<Option<usize>> = vec![None; mesh.nodes.len()];
    for (ei, cell) in mesh.elements.iter().enumerate() {
        let fraction = made_of(ei).volume_fraction;
        for &node in &cell.nodes {
            let lower = nodal_cell[node].is_none_or(|e| fraction < made_of(e).volume_fraction);
            if lower {
                nodal_cell[node] = Some(ei);
            }
        }
    }
    let safety_of = |stress: &[f64; 6], ctx: &MaterialContext| -> (f64, Option<Governs>) {
        match beads {
            Some(b) => BeadMaxStress { beads: b }.safety_governed(&Stress { v: *stress }, ctx),
            None => (
                MaxStress.safety(&Stress { v: *stress }, &allow, ctx),
                Some(Governs::InPlane),
            ),
        }
    };
    let mut von_mises_field = vec![0.0; mesh.nodes.len()];
    let mut safety = vec![0.0; mesh.nodes.len()];
    let mut max_vm = -1.0;
    let mut max_vm_at = [0.0; 3];
    let mut max_disp = -1.0;
    let mut max_disp_at = [0.0; 3];
    let mut min_sf = f64::INFINITY;
    let mut min_sf_at: Option<[f64; 3]> = None;
    let mut min_sf_governs: Option<Governs> = None;
    for i in 0..mesh.nodes.len() {
        let vm = von_mises(&nodal_stress[i]);
        von_mises_field[i] = vm;
        let ctx = made_of(nodal_cell[i].unwrap_or(0)).context(axis);
        let (sf, governs) = safety_of(&nodal_stress[i], &ctx);
        safety[i] = if sf.is_finite() { sf } else { 1.0e9 };
        if vm > max_vm {
            max_vm = vm;
            max_vm_at = mesh.nodes[i];
        }
        let mag = norm(displacement[i]);
        if mag > max_disp {
            max_disp = mag;
            max_disp_at = mesh.nodes[i];
        }
        if sf.is_finite() && sf < min_sf {
            min_sf = sf;
            min_sf_at = Some(mesh.nodes[i]);
            min_sf_governs = governs;
        }
    }
    // A peak is never below the Gauss points': the recovered field can still be smoother than them on a coarse mesh.
    let recovered_peak = max_vm;
    let mut gauss_peak: f64 = 0.0;
    // Trust is judged at the worst point away from the edge of a fixed hold, where the stress has no finite limit.
    let reach = estimate::hold_reach(mesh, h_mm);
    let at_hold = estimate::held_edge_elements(mesh, &req.holds, reach);
    let mut judged_vm = -1.0;
    let mut judged_vm_at = None;
    let mut judged_sf = f64::INFINITY;
    let mut judged_sf_at = None;
    let mut peak_in_hold = false;
    for sample in &gauss {
        let vm = von_mises(&sample.stress);
        let skip = at_hold.get(sample.element).copied().unwrap_or(false);
        gauss_peak = gauss_peak.max(vm);
        if vm > max_vm {
            max_vm = vm;
            max_vm_at = sample.xyz;
            peak_in_hold = skip;
        }
        if !skip && vm > judged_vm {
            judged_vm = vm;
            judged_vm_at = Some(sample.xyz);
        }
        let ctx = made_of(sample.element).context(axis);
        let (sf, governs) = safety_of(&sample.stress, &ctx);
        if sf.is_finite() && sf < min_sf {
            min_sf = sf;
            min_sf_at = Some(sample.xyz);
            min_sf_governs = governs;
        }
        if !skip && sf.is_finite() && sf < judged_sf {
            judged_sf = sf;
            judged_sf_at = Some(sample.xyz);
        }
    }
    // With nothing near a gripping hold, trust is judged at the reported peaks themselves. With every element near
    // one, as on a very coarse mesh, it is judged there too.
    let any_hold_edge = at_hold.iter().any(|&s| s);
    let judged_vm_at = if any_hold_edge {
        judged_vm_at.unwrap_or(max_vm_at)
    } else {
        max_vm_at
    };
    let judged_sf_at = if any_hold_edge {
        judged_sf_at.or(min_sf_at)
    } else {
        min_sf_at
    };
    let peak_gap = if max_vm > 1e-30 {
        (recovered_peak - gauss_peak).abs() / recovered_peak.max(gauss_peak)
    } else {
        0.0
    };
    if !max_vm.is_finite() {
        max_vm = 0.0;
    }
    if !max_disp.is_finite() {
        max_disp = 0.0;
    }
    let min_safety_factor = if min_sf.is_finite() {
        Some(min_sf)
    } else {
        None
    };

    let density = material.density_g_cm3();
    let mut solution = Solution {
        mesh: mesh.clone(),
        displacement,
        nodal_stress,
        von_mises: von_mises_field,
        safety,
        gauss,
        element_error: Vec::new(),
        relative_energy_error: 0.0,
        peak_relative_error: 0.0,
        peak_gap,
        peak_at_hold: peak_in_hold,
        residual,
        mass_g: mass_g(printed_volume, density),
        solid_mass_g: mass_g(solid_volume, density),
        trust: TrustLevel::Rough,
        notes: Vec::new(),
        max_von_mises_mpa: max_vm,
        max_von_mises_at: max_vm_at,
        max_displacement_mm: max_disp,
        max_displacement_at: max_disp_at,
        min_safety_factor,
        min_safety_at: min_sf_at,
        criterion: if beads.is_some() {
            "max-stress-bead"
        } else {
            "max-stress"
        }
        .into(),
        min_safety_governs: min_safety_factor.and(if beads.is_some() {
            min_sf_governs
        } else {
            None
        }),
        label: LABEL.into(),
        steps_run,
        h_mm,
        dofs,
        element: mesh.kind.name().into(),
        provisional: req.provisional,
    };
    let estimator = Zz::new();
    solution.element_error = estimator.element_error(&solution);
    solution.relative_energy_error = estimator.relative(&solution.element_error);
    // The elements within two edge lengths of the peak stress, and of the lowest safety factor when that is a real number.
    let radius = 2.0 * h_mm;
    let skip: Vec<bool> = if at_hold.iter().all(|&s| s) {
        vec![false; at_hold.len()]
    } else {
        at_hold
    };
    let mut peak_error = estimate::local_relative(
        &solution,
        &solution.element_error,
        judged_vm_at,
        radius,
        &skip,
    );
    if let Some(at) = judged_sf_at {
        peak_error = peak_error.max(estimate::local_relative(
            &solution,
            &solution.element_error,
            at,
            radius,
            &skip,
        ));
    }
    solution.peak_relative_error = peak_error;
    let has_infill_core = vf.iter().any(|v| *v < 1.0 - 1e-9);
    let provisional = req.provisional || beads.is_some_and(|b| b.provisional);
    solution.provisional = provisional;
    solution.trust = level_of(&TrustInput {
        provisional,
        tet4: mesh.kind == ElementKind::Tet4,
        relative_energy_error: Some(solution.relative_energy_error),
        peak_relative_error: Some(solution.peak_relative_error),
        rigid_failed,
        estimator_ran: true,
        // A sliced cell holds the real pattern's beads, not a smeared factor.
        pattern_unmeasured: req.representation != "sliced" && !req.recipe.pattern_is_measured(),
        has_infill_core,
        notes: &[],
    });
    if solution.peak_at_hold {
        solution.notes.push(
            "The highest stress is where a fixed face meets a free face. A rigid hold makes the stress there grow as the mesh is refined, so the trust is judged away from it."
                .into(),
        );
    }
    if req.provisional {
        solution
            .notes
            .push("Provisional card, not a measurement.".into());
    } else if provisional {
        solution
            .notes
            .push("Provisional bead constants, not a measurement.".into());
    }
    if req.representation == "sliced" && beads.is_none() {
        solution.notes.push(
            "This card has no bead constants, so each cell is a smear of the card at its fraction."
                .into(),
        );
    }
    if req.representation == "sliced" {
        solution.notes.push(format!(
            "Solved as sliced, on cells of {} mm and whole layers.",
            format_mm(h_mm)
        ));
    } else if has_infill_core {
        if let Some(note) = req.recipe.pattern.note() {
            solution.notes.push(note.to_string());
        }
    }
    let worst = solution
        .relative_energy_error
        .max(solution.peak_relative_error);
    // A sliced study judges itself by two cell sizes; see `sliced_study`.
    if solution.trust == TrustLevel::Rough && worst > 0.15 && req.representation != "sliced" {
        let pct = (worst * 100.0).round() as i64;
        solution.notes.push(format!(
            "The error estimate is {pct}%, which is only a rough result."
        ));
    }
    Ok(solution)
}

/// Millimetres with at most two decimals and no trailing zeros.
fn format_mm(mm: f64) -> String {
    let text = format!("{mm:.2}");
    text.trim_end_matches('0').trim_end_matches('.').to_string()
}

fn stage(req: &Request, name: &'static str) {
    if let Some(cb) = req.on_progress {
        cb(name);
    }
}

fn cancelled(flag: Option<&Arc<AtomicBool>>) -> bool {
    flag.map(|f| f.load(Ordering::Relaxed)).unwrap_or(false)
}

fn exploded(u: &[[f64; 3]]) -> bool {
    u.iter()
        .flatten()
        .any(|c| !c.is_finite() || c.abs() > RIGID_DISPLACEMENT_MM)
}

fn bbox_diagonal(nodes: &[[f64; 3]]) -> f64 {
    let mut lo = [f64::INFINITY; 3];
    let mut hi = [f64::NEG_INFINITY; 3];
    for p in nodes {
        for k in 0..3 {
            lo[k] = lo[k].min(p[k]);
            hi[k] = hi[k].max(p[k]);
        }
    }
    let mut sum = 0.0;
    for k in 0..3 {
        let d = hi[k] - lo[k];
        sum += d * d;
    }
    sum.sqrt()
}
