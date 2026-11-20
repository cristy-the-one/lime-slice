//! A plan whose goal is the lowest natural frequency, not the stiffness.
//!
//! The direction field is the curvature of the lowest mode (of the whole
//! cluster, when the next eigenvalues sit within [`CLUSTER_GAP`]). The
//! loads are solved once at the end so the result can also quote a
//! stiffness factor; they do not choose the ribs. The score is the rise
//! in the lowest frequency per added volume. A repeated cluster is scored
//! by the lower eigenvalue of the projected pair, and the shortlist is
//! re-solved exactly.
//!
//! Loose ends are left where the trace stopped. They are listed, not
//! extended or closed, and every rib stays at full height. The result's
//! notes say so.

use std::time::Instant;

use super::select::{network_volume, CandChain, DRib};
use super::trace;
use super::{
    edge_caps, restrictions, Clean, FrequencyHz, GRib, Goal, LooseEnd, LooseEndReason, PlanStage,
    PlanStats, PlannedRib, Reporter, Response, RibEndKind, RibPlan, RibPlanRequest, TARGET_FLOOR,
};
use crate::error::SimError;
use crate::shell::modes::{cluster_count, ModeSet};
use crate::shell::{LoadCase, Rib, ShellLoad, ShellModel, ShellOptions, ShellResult};
use crate::units::{norm, sub};

/// How many modes to ask for. A repeated pair is two; a few more keep a
/// near-null from hiding it.
const MODES: usize = 4;

pub(crate) fn plan(
    req: &RibPlanRequest,
    rep: &Reporter,
    started: Instant,
) -> Result<RibPlan, SimError> {
    let Goal::Frequency { factor } = req.goal else {
        return Err(SimError::new("Not a frequency goal."));
    };
    let density = req.material.density.expect("check() required a density");
    let mut stats = PlanStats {
        input_triangles: req.mesh.triangles.len(),
        ..PlanStats::default()
    };
    let rules = &req.rules;
    let s0 = super::surface::Surface::new(&req.mesh, rules.clearance.as_deref());
    // The goal does not use the loads. They are solved once, afterwards,
    // so the result can quote a stiffness factor beside the frequency.
    let cases0 = if req.load_cases.is_empty() {
        vec![vec![ShellLoad::Pressure {
            triangles: (0..req.mesh.triangles.len() as u32).collect(),
            pressure: super::DEFAULT_PRESSURE,
        }]]
    } else {
        req.load_cases.clone()
    };

    let t = Instant::now();
    rep.stage(PlanStage::BareSolve, 0.0);
    let holds0 = super::resolve_holds(&s0, &req.holds);
    let mut model0 = ShellModel::new(
        req.mesh.clone(),
        req.material,
        &holds0,
        ShellOptions::default(),
    )?;
    model0.set_threads(1);
    let bare_modes = model0.lowest_modes(density, MODES)?;
    stats.seconds.bare = t.elapsed().as_secs_f64();
    stats.solves += 1;
    if rep.cancelled() {
        return Ok(empty(req, &bare_modes, stats, started, rep));
    }

    let t = Instant::now();
    rep.stage(PlanStage::Field, 0.0);
    let shapes = mode_results(&model0, &bare_modes, density)?;
    let field = super::field::Field::new(
        &s0,
        &shapes,
        req.options.field_alpha,
        &vec![1.0; shapes.len()],
    );
    let zones = restrictions(&s0, &req.zones, req.hole_rim_margin, rules.min_height);
    let blocked0 = zones.blocked.clone();
    stats.seconds.field = t.elapsed().as_secs_f64();
    drop(model0);

    if rep.cancelled() {
        return Ok(shell_only(req, &bare_modes, stats, started, rep));
    }
    let t = Instant::now();
    rep.stage(PlanStage::Trace, 0.0);
    let trace_rules = trace::TraceRules {
        spacing: rules.min_spacing,
        min_length: rules.min_length,
        tolerance: req.options.simplify_tolerance,
    };
    let diag = super::bbox_diagonal(&req.mesh.vertices);
    let tracer = trace::Tracer {
        s: &s0,
        field: &field,
        blocked: &blocked0,
        rules: &trace_rules,
        max_length: 4.0 * diag,
    };
    let traced = tracer.candidates();
    stats.candidates = traced.len();
    stats.seconds.trace = t.elapsed().as_secs_f64();
    if rep.cancelled() {
        return Ok(shell_only(req, &bare_modes, stats, started, rep));
    }

    let t = Instant::now();
    rep.stage(PlanStage::Embed, 0.0);
    let (cands, mesh1, holds1, pos) = embed(req, &s0, &zones, &traced)?;
    stats.embedded_candidates = cands.len();
    stats.embedded_triangles = mesh1.triangles.len();
    stats.seconds.embed = t.elapsed().as_secs_f64();
    if rep.cancelled() {
        return Ok(shell_only(req, &bare_modes, stats, started, rep));
    }

    let mut model = ShellModel::new(mesh1, req.material, &holds1, ShellOptions::default())?;
    model.set_threads(1);
    let ctx_width = rules.width;
    let ctx_profile = rules.profile;
    let ctx_max = rules.max_height;
    let shortlist = req.options.shortlist;

    // Selection, then the clean mesh. Ask again, a little higher, only when
    // selection itself reached this ask and the clean mesh did not. A miss
    // from the gain floor or an empty pool is the same design at any higher
    // ask, so that path stops once.
    let mut ask = factor;
    let mut gribs: Vec<GRib> = Vec::new();
    let mut clean: Option<Clean> = None;
    let mut hz = [0.0, 0.0];
    let mut unreached: Option<f64> = None;
    for attempt in 0..3 {
        if rep.cancelled() {
            break;
        }
        rep.stage(PlanStage::Select, 0.0);
        let t = Instant::now();
        let grown = grow(
            &mut model,
            &cands,
            &pos,
            density,
            ask,
            shortlist,
            ctx_width,
            ctx_max,
            ctx_profile,
            rules.side,
            rules.min_height,
            rep,
        )?;
        stats.seconds.select += t.elapsed().as_secs_f64();
        // Cancel before any rib: the bare frequencies, and one factor per
        // load case. A partial design gets one clean solve, then stops.
        if grown.stopped && grown.design.is_empty() {
            return Ok(shell_only(req, &bare_modes, stats, started, rep));
        }
        let design = grown.design;
        gribs = design
            .iter()
            .map(|d| GRib {
                points: d.chain.iter().map(|&v| pos[v as usize]).collect(),
                heights: d.heights(),
                d: d.clone(),
            })
            .collect();
        let solved = clean_solve_freq(req, &s0, &cases0, &gribs)?;
        stats.solves += 2;
        let (bare_hz, rib_hz, eigen_s) = frequencies(req, &solved, density)?;
        stats.seconds.solver += eigen_s;
        hz = [bare_hz, rib_hz];
        let got = if bare_hz > 0.0 { rib_hz / bare_hz } else { 1.0 };
        stats.selection_factor = got;
        clean = Some(solved);
        if grown.stopped {
            break;
        }
        if got + 1e-9 >= factor {
            break;
        }
        if !grown.reached || design.is_empty() {
            unreached = Some(got);
            break;
        }
        ask = (ask * (factor / got) * 1.002).max(ask + 1e-6);
        stats.clean_retries = attempt + 1;
    }
    let Some(clean) = clean else {
        return Ok(shell_only(req, &bare_modes, stats, started, rep));
    };
    let achieved = if hz[0] > 0.0 { hz[1] / hz[0] } else { 1.0 };
    finish(
        req, clean, gribs, hz, achieved, factor, unreached, stats, started, rep,
    )
}

#[allow(clippy::too_many_arguments)]
fn finish(
    req: &RibPlanRequest,
    clean: Clean,
    gribs: Vec<GRib>,
    hz: [f64; 2],
    achieved: f64,
    factor: f64,
    unreached: Option<f64>,
    mut stats: PlanStats,
    started: Instant,
    rep: &Reporter,
) -> Result<RibPlan, SimError> {
    let total_energy = clean.eval.strain_energy;
    let mut ribs = Vec::new();
    for (k, (&i, d)) in clean.kept.iter().zip(&clean.design).enumerate() {
        let g = &gribs[i];
        let points: Vec<[f64; 3]> = d.chain.iter().map(|&v| clean.pos[v as usize]).collect();
        let length = points.windows(2).map(|w| norm(sub(w[1], w[0]))).sum();
        ribs.push(PlannedRib {
            vertices: d.chain.clone(),
            points,
            width: d.width,
            height: d.tallest(),
            heights: d.heights(),
            profile: d.profile,
            sections: d
                .heights()
                .iter()
                .map(|&h| d.profile.section_at(d.width, h))
                .collect(),
            side: req.rules.side,
            ends: clean.ends[k],
            family: d.family,
            length_mm: length,
            volume_mm3: d.volume(&clean.pos),
            gain: g.d.gain,
            energy_share: if total_energy > 0.0 {
                clean.eval.rib_energy.get(k).copied().unwrap_or(0.0) / total_energy
            } else {
                0.0
            },
        });
    }
    // Ends the trace left in mid-wall. They are not extended or closed.
    let mut loose_ends = Vec::new();
    for (k, ends) in clean.ends.iter().enumerate() {
        for (e, &kind) in ends.iter().enumerate() {
            if kind != RibEndKind::Free {
                continue;
            }
            let points = &ribs[k].points;
            loose_ends.push(LooseEnd {
                rib: k,
                end: e,
                point: if e == 0 {
                    points[0]
                } else {
                    *points.last().expect("points")
                },
                reason: LooseEndReason::Open,
            });
        }
    }
    stats.loose_ends.before = loose_ends.len();
    stats.loose_ends.after = loose_ends.len();
    stats.seconds.total = started.elapsed().as_secs_f64();
    rep.stage(PlanStage::Done, 1.0);
    Ok(RibPlan {
        ribs,
        rib_volume_mm3: clean.volume,
        bare: clean.bare,
        ribbed: clean.ribbed,
        stiffness_factor: clean.factor,
        case_factors: clean.case_factors,
        case_deflection_mm: clean.case_deflection_mm,
        worst_trace: Vec::new(),
        goal_met: achieved + 1e-9 >= factor && !rep.cancelled(),
        thickening: None,
        grid: None,
        not_better_than_baseline: false,
        stopped_early: rep.cancelled(),
        loose_ends,
        mesh: clean.mesh,
        stats,
        frequency_hz: Some(FrequencyHz {
            bare: hz[0],
            ribbed: hz[1],
        }),
        frequency_factor: Some(achieved),
        notes: frequency_notes(unreached, !req.load_cases.is_empty()),
    })
}

/// What a frequency plan does, and does not do. `unreached` is the clean
/// ratio when selection stopped short of the ask. The loads sentence is
/// only there when the request carried loads: an empty request is planned
/// under the default pressure, which was not given.
fn frequency_notes(unreached: Option<f64>, loads_given: bool) -> Vec<String> {
    let mut notes = vec![
        if loads_given {
            "Loads are ignored for the goal. Ribs follow the lowest mode shape.".to_string()
        } else {
            "Ribs follow the lowest mode shape.".to_string()
        },
        "Loose ends are not extended or closed, and ribs stay at full height.".to_string(),
    ];
    if let Some(ratio) = unreached {
        notes.push(format!(
            "The frequency ratio cannot be reached. The plan reaches ×{ratio:.6}."
        ));
    }
    notes
}

fn empty(
    req: &RibPlanRequest,
    modes: &ModeSet,
    stats: PlanStats,
    started: Instant,
    rep: &Reporter,
) -> RibPlan {
    let hz = modes.modes.first().map(|m| m.hz).unwrap_or(0.0);
    let mut stats = stats;
    stats.seconds.total = started.elapsed().as_secs_f64();
    rep.stage(PlanStage::Done, 1.0);
    RibPlan {
        ribs: Vec::new(),
        rib_volume_mm3: 0.0,
        bare: Response {
            compliance: 0.0,
            max_deflection: 0.0,
        },
        ribbed: Response {
            compliance: 0.0,
            max_deflection: 0.0,
        },
        stiffness_factor: 1.0,
        case_factors: vec![1.0; load_case_count(req)],
        case_deflection_mm: vec![[0.0, 0.0]; load_case_count(req)],
        worst_trace: Vec::new(),
        goal_met: false,
        thickening: None,
        grid: None,
        not_better_than_baseline: false,
        stopped_early: true,
        loose_ends: Vec::new(),
        mesh: req.mesh.clone(),
        stats,
        frequency_hz: Some(FrequencyHz {
            bare: hz,
            ribbed: hz,
        }),
        frequency_factor: Some(1.0),
        notes: frequency_notes(None, !req.load_cases.is_empty()),
    }
}

/// One reported factor per load case. An empty request is the single
/// default pressure, the same count the stiffness path uses.
fn load_case_count(req: &RibPlanRequest) -> usize {
    req.load_cases.len().max(1)
}

fn shell_only(
    req: &RibPlanRequest,
    modes: &ModeSet,
    stats: PlanStats,
    started: Instant,
    rep: &Reporter,
) -> RibPlan {
    empty(req, modes, stats, started, rep)
}

/// The curvature of the lowest cluster, mass-normalised, as shell results
/// the direction field already knows how to read.
fn mode_results(
    model: &ShellModel,
    modes: &ModeSet,
    density: f64,
) -> Result<Vec<ShellResult>, SimError> {
    let mass = model.mass_upper(density, true);
    let omega2: Vec<f64> = modes.modes.iter().map(|m| m.omega2).collect();
    let n = cluster_count(&omega2).max(1);
    let mut out = Vec::with_capacity(n);
    for mode in modes.modes.iter().take(n) {
        let scale = model.mass_inner(&mass, &mode.vector, &mode.vector).sqrt();
        let scale = if scale > 0.0 { 1.0 / scale } else { 1.0 };
        let v: Vec<f64> = mode.vector.iter().map(|x| x * scale).collect();
        out.push(model.result_of_free(&v)?);
    }
    Ok(out)
}

type EmbeddedCandidates = (
    Vec<CandChain>,
    crate::shell::ShellMesh,
    Vec<crate::shell::ShellHold>,
    Vec<[f64; 3]>,
);

fn embed(
    req: &RibPlanRequest,
    s0: &super::surface::Surface,
    zones: &super::Restrictions,
    traced: &[trace::Candidate],
) -> Result<EmbeddedCandidates, SimError> {
    // No extension stubs. A frequency plan does not extend or close loose
    // ends, and the stubs were built and then discarded.
    let rules = &req.rules;
    let mut s1 = s0.clone();
    let ids: Vec<Option<usize>> = traced
        .iter()
        .map(|c| s1.embed_polyline(&c.points))
        .collect();
    let mut cands = Vec::new();
    for (i, c) in traced.iter().enumerate() {
        let Some(id) = ids[i] else { continue };
        let chain = s1.chains[id].clone();
        if s1.chain_length(&chain) < rules.min_length {
            continue;
        }
        let caps = edge_caps(&s1, &chain, &zones.cap, rules.max_height);
        if caps.iter().all(|&h| h < rules.min_height) {
            continue;
        }
        cands.push(CandChain {
            chain,
            caps,
            family: c.family,
            stub: [None, None],
        });
    }
    let mesh = s1.to_mesh();
    let holds = super::resolve_holds(&s1, &req.holds);
    let pos = s1.pos.clone();
    Ok((cands, mesh, holds, pos))
}

#[allow(clippy::too_many_arguments)]
fn grow(
    model: &mut ShellModel,
    cands: &[CandChain],
    pos: &[[f64; 3]],
    density: f64,
    factor: f64,
    shortlist: usize,
    width: f64,
    max_height: f64,
    profile: super::RibProfile,
    side: crate::shell::RibSide,
    min_height: f64,
    rep: &Reporter,
) -> Result<Grown, SimError> {
    // Cancel at the Select stage, before this solve: nothing was chosen.
    if rep.cancelled() {
        return Ok(Grown {
            design: Vec::new(),
            reached: false,
            stopped: true,
        });
    }
    // The model arrives with no ribs. Clearing them drops a factor, so the
    // bare modes are solved once, after that, and reused for the first round.
    model.set_ribs(Vec::new())?;
    let first = model.lowest_modes(density, MODES)?;
    let omega0 = first.modes[0].omega2.sqrt();
    let mut pending = Some(first);
    let mut omega = omega0;
    let mut design: Vec<DRib> = Vec::new();
    let mut used = vec![false; cands.len()];
    let mut first_eff: Option<f64> = None;
    let mut reached = false;
    for _round in 0..cands.len() {
        if rep.cancelled() {
            return Ok(Grown {
                design,
                reached: false,
                stopped: true,
            });
        }
        if omega / omega0 >= factor {
            reached = true;
            break;
        }
        let modes = match pending.take() {
            Some(ready) => ready,
            None => model.lowest_modes(density, MODES)?,
        };
        omega = modes.modes[0].omega2.sqrt();
        if omega / omega0 >= factor {
            reached = true;
            break;
        }
        let mass = model.mass_upper(density, true);
        let omega2: Vec<f64> = modes.modes.iter().map(|m| m.omega2).collect();
        let nclus = cluster_count(&omega2).max(1);
        let vectors: Vec<Vec<f64>> = modes
            .modes
            .iter()
            .take(nclus)
            .map(|m| m.vector.clone())
            .collect();
        let gram = model.mass_gram(&vectors, &mass);
        let base_volume = network_volume(pos, &design);
        let mut pool: Vec<(f64, usize, f64)> = Vec::new();
        for (i, c) in cands.iter().enumerate() {
            // A cancel here keeps the ribs already accepted and does not
            // finish this round or start another.
            if rep.cancelled() {
                return Ok(Grown {
                    design,
                    reached: false,
                    stopped: true,
                });
            }
            if used[i] {
                continue;
            }
            let d = candidate_rib(c, i, width, max_height, profile);
            if d.heights().iter().all(|&h| h < min_height) {
                continue;
            }
            let trial = {
                let mut t = design.clone();
                t.push(d.clone());
                t
            };
            let dv = network_volume(pos, &trial) - base_volume;
            if dv <= 0.0 {
                continue;
            }
            let ribs = d.solver_ribs(side);
            let shift = model.cluster_shift_mass(&ribs, &vectors, &gram)?;
            pool.push((shift / dv, i, dv));
        }
        if pool.is_empty() {
            break;
        }
        pool.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
        let keep = if shortlist == 0 {
            pool.len()
        } else {
            shortlist.min(pool.len())
        };
        pool.truncate(keep);
        let mut best: Option<(f64, usize, DRib, f64)> = None;
        for &(_, i, dv) in &pool {
            if rep.cancelled() {
                return Ok(Grown {
                    design,
                    reached: false,
                    stopped: true,
                });
            }
            let d = candidate_rib(&cands[i], i, width, max_height, profile);
            let mut trial = design.clone();
            trial.push(d.clone());
            let built: Vec<Rib> = trial.iter().flat_map(|r| r.solver_ribs(side)).collect();
            model.set_ribs(built)?;
            let got = model.lowest_modes(density, 1)?;
            let w = got.modes[0].omega2.sqrt();
            let eff = (w - omega) / dv;
            if best.as_ref().is_none_or(|b| eff > b.0) {
                best = Some((eff, i, d, w));
            }
        }
        // Put the model back on the ribs already accepted. The trials
        // above replaced them.
        let accepted: Vec<Rib> = design.iter().flat_map(|r| r.solver_ribs(side)).collect();
        model.set_ribs(accepted)?;
        let Some((eff, i, mut d, w)) = best else {
            break;
        };
        if eff <= 0.0 {
            break;
        }
        if let Some(first) = first_eff {
            if eff < TARGET_FLOOR * first {
                break;
            }
        } else {
            first_eff = Some(eff);
        }
        used[i] = true;
        d.gain = (w - omega) / omega0;
        omega = w;
        design.push(d);
        let with: Vec<Rib> = design.iter().flat_map(|r| r.solver_ribs(side)).collect();
        model.set_ribs(with)?;
        let ratio = if omega0 > 0.0 { omega / omega0 } else { 1.0 };
        let within = if factor > 1.0 {
            ((ratio - 1.0) / (factor - 1.0)).clamp(0.0, 1.0)
        } else {
            1.0
        };
        rep.stage(PlanStage::Select, within);
        if let Some(last) = design.last().cloned() {
            rep.frequency_rib(&last, pos, &design, ratio);
        }
    }
    if omega / omega0 >= factor {
        reached = true;
    }
    Ok(Grown {
        design,
        reached,
        stopped: false,
    })
}

/// What [`grow`] accepted, and whether the lowest frequency met the ask
/// before the candidates or the gain floor ran out.
struct Grown {
    design: Vec<DRib>,
    reached: bool,
    /// The caller cancelled. An empty design is the shell alone; a partial
    /// one is solved once and not asked again.
    stopped: bool,
}

fn candidate_rib(
    c: &CandChain,
    i: usize,
    width: f64,
    max_height: f64,
    profile: super::RibProfile,
) -> DRib {
    DRib {
        chain: c.chain.clone(),
        caps: c.caps.clone(),
        height: max_height,
        width,
        profile,
        family: c.family,
        cand: i,
        gain: 0.0,
        id: i,
    }
}

fn clean_solve_freq(
    req: &RibPlanRequest,
    s0: &super::surface::Surface,
    cases0: &[LoadCase],
    ribs: &[GRib],
) -> Result<Clean, SimError> {
    // The stiffness solve is the one the planner already uses. It is not
    // the goal; it fills the compliance and the stiffness factor.
    super::clean_solve(req, s0, cases0, ribs)
}

fn frequencies(
    req: &RibPlanRequest,
    clean: &Clean,
    density: f64,
) -> Result<(f64, f64, f64), SimError> {
    let mut model = ShellModel::new(
        clean.mesh.clone(),
        req.material,
        &clean.holds,
        ShellOptions::default(),
    )?;
    model.set_threads(1);
    let bare = model.lowest_modes(density, 1)?;
    let built: Vec<Rib> = clean
        .design
        .iter()
        .flat_map(|d| d.solver_ribs(req.rules.side))
        .collect();
    model.set_ribs(built)?;
    let ribbed = model.lowest_modes(density, 1)?;
    Ok((
        bare.modes[0].hz,
        ribbed.modes[0].hz,
        bare.seconds + ribbed.seconds,
    ))
}

#[cfg(test)]
mod tests {
    use super::super::field::Field;
    use super::super::surface::Surface;
    use super::super::{Holds, RibPlanRequest};
    use super::mode_results;
    use crate::shell::{IsotropicShell, ShellLoad, ShellMesh, ShellModel, ShellOptions};
    use crate::units::norm;

    fn centroid(field: &Field, s: &Surface) -> [f64; 2] {
        let mut w = 0.0;
        let mut c = [0.0, 0.0];
        for (t, &d) in field.density.iter().enumerate() {
            let p = s.centroid(t as u32);
            c[0] += d * p[0];
            c[1] += d * p[1];
            w += d;
        }
        [c[0] / w, c[1] / w]
    }

    /// The study's point-load panel. The mode field's energy sits nearer
    /// the middle than the static field, which sits by the load.
    #[test]
    fn mode_field_leaves_the_point_load() {
        let mesh = ShellMesh::rectangle([120.0, 70.0], [24, 14], 2.0);
        let mat = IsotropicShell::new(2000.0, 0.3)
            .unwrap()
            .with_density(1.0e-9)
            .unwrap();
        let s = Surface::new(&mesh, None);
        let mut req = RibPlanRequest::new(mesh.clone(), mat);
        req.holds = Holds::AllBoundaryClamped;
        let node = mesh
            .vertices
            .iter()
            .enumerate()
            .min_by(|(_, a), (_, b)| {
                let da = (a[0] - 15.0).powi(2) + (a[1] - 35.0).powi(2);
                let db = (b[0] - 15.0).powi(2) + (b[1] - 35.0).powi(2);
                da.total_cmp(&db)
            })
            .map(|(i, _)| i as u32)
            .unwrap();
        let holds = super::super::resolve_holds(&s, &req.holds);
        let mut model = ShellModel::new(mesh, mat, &holds, ShellOptions::default()).unwrap();
        model.set_threads(1);
        let load = vec![ShellLoad::Force {
            node,
            force: [0.0, 0.0, -10.0],
        }];
        let static_result = model.solve(&load).unwrap();
        let static_field = Field::new(&s, &[static_result], 0.8, &[1.0]);
        let modes = model.lowest_modes(1.0e-9, 4).unwrap();
        let shapes = mode_results(&model, &modes, 1.0e-9).unwrap();
        let mode_field = Field::new(&s, &shapes, 0.8, &vec![1.0; shapes.len()]);
        let cs = centroid(&static_field, &s);
        let cm = centroid(&mode_field, &s);
        println!(
            "point-load field centroid ({:.2}, {:.2}), mode field ({:.2}, {:.2}), load vertex {node}",
            cs[0], cs[1], cm[0], cm[1]
        );
        let apart = norm([cs[0] - cm[0], cs[1] - cm[1], 0.0]);
        assert!(
            apart > 10.0,
            "the two fields sit {apart:.2} mm apart, under 10"
        );
        let mid = 60.0;
        assert!(
            (cm[0] - mid).abs() < (cs[0] - mid).abs(),
            "mode centroid x {:.2} is not nearer the middle than the load's {:.2}",
            cm[0],
            cs[0]
        );
    }
}
