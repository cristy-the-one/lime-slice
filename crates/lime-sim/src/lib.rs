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
pub mod material;
pub mod mesh;
pub mod recipe;
pub mod skin;
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

use assemble::{add_increment, assemble, rel_norm};
use element::{sample_element, shape_of};
use error::{node_cap, not_held, temperature_refused, tet4_refused, zero_axis};
use estimate::{Estimator, Zz};
use fields::GaussSample;
use material::{
    compliance_of, von_mises, FailureCriterion, MatState, MaterialContext, MaterialModel,
    MaxStress, Stress,
};
use recipe::volume_fractions;
use solve::{FaerLdlt, LinearSolver};
use study::{modal_sentence, validate_request_fields};
use trust::{level_of, TrustInput, TrustLevel};
use units::{mass_g, norm, normalize, NODE_CAP};

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
    if req.mesh.nodes.len() > NODE_CAP {
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
    let vf = volume_fractions(&req.mesh, &req.recipe, axis);
    let mut u = vec![[0.0; 3]; req.mesh.nodes.len()];
    let mut load_level = 0.0;
    let mut steps_run = 0;
    let mut solver = FaerLdlt::default();

    for step in &req.steps {
        load_level += step.factor;
        steps_run += 1;
        for _iter in 0..step.max_iter {
            stage(req, "assemble");
            let dof = assemble::build_dof(req.mesh.nodes.len(), &req.holds)?;
            let assembly = assemble(
                &req.mesh,
                &req.material,
                axis,
                &vf,
                &req.loads,
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
            stage(req, "factor");
            solver.factor(&assembly.system.k, assembly.system.dof.n_free)?;
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
                break;
            }
            let check = assemble(
                &req.mesh,
                &req.material,
                axis,
                &vf,
                &req.loads,
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
    let final_dof = assemble::build_dof(req.mesh.nodes.len(), &req.holds)?;
    let final_assembly = assemble(
        &req.mesh,
        &req.material,
        axis,
        &vf,
        &req.loads,
        load_level,
        req.gravity,
        &u,
        final_dof,
        &req.holds,
    )?;
    let residual = rel_norm(
        &final_assembly.system.residual,
        &final_assembly.system.external,
    );
    let peak = u.iter().copied().map(norm).fold(0.0_f64, f64::max);
    let diagonal = bbox_diagonal(&req.mesh.nodes);
    let free = final_assembly.system.dof.n_free;
    // The same predicate is what `level_of` reads. A failure refuses here,
    // before recovery, so a mechanism never comes back as a rough result.
    let rigid_failed = residual > RELATIVE_RESIDUAL_MAX
        || peak > DISPLACEMENT_OVER_DIAGONAL * diagonal
        || (free > 0 && solver.pivot_ratio() < PIVOT_RATIO_MIN);
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
        axis,
        &vf,
        u,
        residual,
        final_assembly.solid_volume,
        final_assembly.printed_volume,
        final_assembly.system.dof.n_free,
        h_mm,
        steps_run,
        rigid_failed,
    )
}

#[allow(clippy::too_many_arguments)]
fn recover(
    req: &Request,
    axis: [f64; 3],
    vf: &[f64],
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
    let mut gauss = Vec::new();
    for (ei, cell) in mesh.elements.iter().enumerate() {
        let fraction = vf.get(ei).copied().unwrap_or(1.0);
        let coords: Vec<[f64; 3]> = cell.nodes.iter().map(|n| mesh.nodes[*n]).collect();
        let mut local_u = vec![0.0; cell.nodes.len() * 3];
        for (a, node) in cell.nodes.iter().enumerate() {
            for k in 0..3 {
                local_u[a * 3 + k] = displacement[*node][k];
            }
        }
        let mat_ctx = MaterialContext {
            build_axis: axis,
            temperature_c: None,
            fibre_axis: None,
            volume_fraction: fraction,
        };
        let mut state = MatState::default();
        let (_, tangent) = req.material.stress_tangent(&[0.0; 6], &mut state, &mat_ctx);
        let compliance = compliance_of(&tangent.c);
        for sample in sample_element(mesh.kind, &coords, &local_u, &req.material, &mat_ctx) {
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
    }

    // Extrapolated to the corners and averaged by volume. The same field the estimator smooths with.
    let nodal_stress = estimate::recover_nodal(mesh, &gauss);
    let allow = req.material.allowables();
    // Lowest fraction of the elements around the node. A node on both a wall
    // and the core is limited by the core, which is the conservative choice.
    let mut nodal_vf = vec![1.0; mesh.nodes.len()];
    let mut touched = vec![false; mesh.nodes.len()];
    for (ei, cell) in mesh.elements.iter().enumerate() {
        let fraction = vf.get(ei).copied().unwrap_or(1.0);
        for &node in &cell.nodes {
            if !touched[node] || fraction < nodal_vf[node] {
                nodal_vf[node] = fraction;
                touched[node] = true;
            }
        }
    }
    let mut von_mises_field = vec![0.0; mesh.nodes.len()];
    let mut safety = vec![0.0; mesh.nodes.len()];
    let mut max_vm = -1.0;
    let mut max_vm_at = [0.0; 3];
    let mut max_disp = -1.0;
    let mut max_disp_at = [0.0; 3];
    let mut min_sf = f64::INFINITY;
    let mut min_sf_at: Option<[f64; 3]> = None;
    for i in 0..mesh.nodes.len() {
        let vm = von_mises(&nodal_stress[i]);
        von_mises_field[i] = vm;
        let ctx = MaterialContext {
            build_axis: axis,
            temperature_c: None,
            fibre_axis: None,
            volume_fraction: nodal_vf[i],
        };
        let sf = MaxStress.safety(&Stress { v: nodal_stress[i] }, &allow, &ctx);
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
        }
    }
    // A peak is never below the Gauss points': the recovered field can still be smoother than them on a coarse mesh.
    let recovered_peak = max_vm;
    let mut gauss_peak: f64 = 0.0;
    for sample in &gauss {
        let vm = von_mises(&sample.stress);
        gauss_peak = gauss_peak.max(vm);
        if vm > max_vm {
            max_vm = vm;
            max_vm_at = sample.xyz;
        }
        let ctx = MaterialContext {
            build_axis: axis,
            temperature_c: None,
            fibre_axis: None,
            volume_fraction: vf.get(sample.element).copied().unwrap_or(1.0),
        };
        let sf = MaxStress.safety(&Stress { v: sample.stress }, &allow, &ctx);
        if sf.is_finite() && sf < min_sf {
            min_sf = sf;
            min_sf_at = Some(sample.xyz);
        }
    }
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

    let density = req.material.density_g_cm3();
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
        criterion: "max-stress".into(),
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
    let mut peak_error = estimate::local_relative(
        &solution,
        &solution.element_error,
        solution.max_von_mises_at,
        radius,
    );
    if let Some(at) = solution.min_safety_at {
        peak_error = peak_error.max(estimate::local_relative(
            &solution,
            &solution.element_error,
            at,
            radius,
        ));
    }
    solution.peak_relative_error = peak_error;
    let has_infill_core = vf.iter().any(|v| *v < 1.0 - 1e-9);
    solution.trust = level_of(&TrustInput {
        provisional: req.provisional,
        tet4: mesh.kind == ElementKind::Tet4,
        relative_energy_error: Some(solution.relative_energy_error),
        peak_relative_error: Some(solution.peak_relative_error),
        rigid_failed,
        estimator_ran: true,
        pattern_unmeasured: !req.recipe.pattern_is_measured(),
        has_infill_core,
        notes: &[],
    });
    if req.provisional {
        solution
            .notes
            .push("Provisional card, not a measurement.".into());
    }
    if has_infill_core {
        if let Some(note) = req.recipe.pattern.note() {
            solution.notes.push(note.to_string());
        }
    }
    let worst = solution
        .relative_energy_error
        .max(solution.peak_relative_error);
    if solution.trust == TrustLevel::Rough && worst > 0.15 {
        let pct = (worst * 100.0).round() as i64;
        solution.notes.push(format!(
            "The error estimate is {pct}%, which is only a rough result."
        ));
    }
    Ok(solution)
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
