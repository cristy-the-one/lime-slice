//! A plan whose goal is the buckling load factor, not the stiffness.
//!
//! The pre-stress is the static solve of the chosen load. Plate Kg is built
//! from each triangle's own membrane force, including on a fold. The score
//! is the rise in the lowest positive load factor per added volume. A
//! repeated pair is scored by the lower eigenvalue of the projected 2×2,
//! and the shortlist is re-solved exactly. There is no membrane Kg and no
//! beam Kg.

use std::time::Instant;

use rayon::prelude::*;

use super::select::{network_volume, CandChain, DRib};
use super::trace;
use super::{
    draft_lost_notes, edge_caps, restrictions, BucklingFactor, Clean, GRib, Goal, LooseEnd,
    LooseEndReason, PlanStage, PlanStats, PlannedRib, Reporter, Response, RibEndKind, RibPlan,
    RibPlanRequest, TARGET_FLOOR,
};
use crate::error::SimError;
use crate::shell::model::PreparedRib;
use crate::shell::modes::cluster_count;
use crate::shell::{BucklingSet, LoadCase, Rib, ShellLoad, ShellModel, ShellResult};
use crate::units::{norm, sub};

/// How many modes to ask for. A repeated pair is two; a few more keep a
/// near-null from hiding it.
const MODES: usize = 4;

/// Carried on every buckling result.
pub const IDEAL_BUCKLING: &str = "This is the ideal buckling load. A curved wall, or one that isn't perfectly flat, can buckle well below it.";

pub(crate) fn plan(
    req: &RibPlanRequest,
    rep: &Reporter,
    started: Instant,
) -> Result<RibPlan, SimError> {
    let Goal::Buckling { factor, on } = req.goal else {
        return Err(SimError::new("Not a buckling goal."));
    };
    let mut stats = PlanStats {
        input_triangles: req.mesh.triangles.len(),
        ..PlanStats::default()
    };
    let rules = &req.rules;
    let mut s0 = super::surface::Surface::new(&req.mesh, rules.clearance.as_deref());
    s0.creases = req.options.creases;
    let cases0 = if req.load_cases.is_empty() {
        vec![vec![ShellLoad::Pressure {
            triangles: (0..req.mesh.triangles.len() as u32).collect(),
            pressure: super::DEFAULT_PRESSURE,
        }]]
    } else {
        req.load_cases.clone()
    };
    let idx = on.unwrap_or(0);
    let case0 = cases0[idx].clone();

    let t = Instant::now();
    rep.stage(PlanStage::BareSolve, 0.0);
    let holds0 = super::resolve_holds(&s0, &req.holds);
    let mut model0 = ShellModel::new(
        req.mesh.clone(),
        req.material,
        &holds0,
        req.options.shell(),
    )?;
    model0.set_threads(1);
    let (bare_modes, metric, bare_static) = model0.buckling_state(&case0, MODES)?;
    stats.seconds.bare = t.elapsed().as_secs_f64();
    stats.seconds.solver += bare_modes.seconds;
    stats.solves += 1;
    let lambda0 = bare_modes.modes[0].lambda;
    if rep.cancelled() {
        return Ok(stopped_bare(req, lambda0, &bare_static, stats, started, rep));
    }
    if lambda0 + 1e-9 >= factor {
        let solved = model0.solve_cases_light(&cases0, false)?;
        stats.solves += 1;
        return Ok(already(
            req, lambda0, &solved, stats, started, rep,
        ));
    }

    let t = Instant::now();
    rep.stage(PlanStage::Field, 0.0);
    let shapes = mode_results(&model0, &bare_modes, &metric)?;
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
        return Ok(stopped_bare(req, lambda0, &bare_static, stats, started, rep));
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
        return Ok(stopped_bare(req, lambda0, &bare_static, stats, started, rep));
    }

    let t = Instant::now();
    rep.stage(PlanStage::Embed, 0.0);
    let (cands, mesh1, holds1, pos, case1) = embed(req, &s0, &zones, &traced, &cases0, idx)?;
    stats.embedded_candidates = cands.len();
    stats.embedded_triangles = mesh1.triangles.len();
    stats.seconds.embed = t.elapsed().as_secs_f64();
    if rep.cancelled() {
        return Ok(stopped_bare(req, lambda0, &bare_static, stats, started, rep));
    }

    let mut model = ShellModel::new(mesh1, req.material, &holds1, req.options.shell())?;
    model.set_threads(1);
    let workers = match req.options.workers {
        0 => std::thread::available_parallelism()
            .map_or(1, |n| n.get())
            .min(8),
        n => n,
    };
    let ctx_width = rules.width;
    let ctx_profile = rules.profile;
    let ctx_max = rules.max_height;
    let shortlist = req.options.shortlist;

    let mut ask = factor;
    let mut gribs: Vec<GRib> = Vec::new();
    let mut clean: Option<Clean> = None;
    let mut lam = [0.0, 0.0];
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
            &case1,
            ask,
            shortlist,
            workers,
            ctx_width,
            ctx_max,
            ctx_profile,
            rules.side,
            rules.min_height,
            rep,
        )?;
        stats.seconds.select += t.elapsed().as_secs_f64();
        stats.seconds.solver += grown.eigen_s;
        stats.solves += grown.solves;
        if grown.stopped && grown.design.is_empty() {
            return Ok(stopped_bare(req, lambda0, &bare_static, stats, started, rep));
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
        let mut solved = super::clean_solve(req, &s0, &cases0, &gribs)?;
        stats.solves += 2;
        let (bare_l, rib_l, eigen_s, solves) = factors(&mut solved, idx)?;
        stats.seconds.solver += eigen_s;
        stats.solves += solves;
        lam = [bare_l, rib_l];
        stats.selection_factor = rib_l;
        clean = Some(solved);
        if grown.stopped {
            break;
        }
        if rib_l + 1e-9 >= factor {
            break;
        }
        if !grown.reached || design.is_empty() {
            unreached = Some(rib_l);
            break;
        }
        let got = rib_l.max(1e-9);
        ask = (ask * (factor / got) * 1.002).max(ask + 1e-6);
        stats.clean_retries = attempt + 1;
    }
    let Some(clean) = clean else {
        return Ok(stopped_bare(req, lambda0, &bare_static, stats, started, rep));
    };
    finish(
        req, clean, gribs, lam, factor, unreached, stats, started, rep,
    )
}

#[allow(clippy::too_many_arguments)]
fn finish(
    req: &RibPlanRequest,
    clean: Clean,
    gribs: Vec<GRib>,
    lam: [f64; 2],
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
    let met = lam[1] + 1e-9 >= factor && !rep.cancelled();
    let mut notes = buckling_notes(lam, factor, unreached.filter(|_| !met), ribs.is_empty(), req.vent);
    notes.extend(draft_lost_notes(&ribs));
    Ok(RibPlan {
        ribs,
        rib_volume_mm3: clean.volume,
        bare: clean.bare,
        ribbed: clean.ribbed,
        stiffness_factor: clean.factor,
        case_factors: clean.case_factors,
        case_deflection_mm: clean.case_deflection_mm,
        worst_trace: Vec::new(),
        goal_met: met,
        thickening: None,
        grid: None,
        not_better_than_baseline: false,
        stopped_early: rep.cancelled(),
        loose_ends,
        mesh: clean.mesh,
        stats,
        vents: None,
        frequency_hz: None,
        frequency_factor: None,
        buckling_factor: Some(factor_of(req, lam[0], lam[1])),
        notes,
    })
}

fn factor_of(req: &RibPlanRequest, bare: f64, ribbed: f64) -> BucklingFactor {
    let case_index = match req.goal {
        Goal::Buckling { on, .. } => on,
        _ => None,
    };
    BucklingFactor {
        bare,
        ribbed,
        case_index,
    }
}

/// One decimal, or a whole number when the tenth is zero: 3.1, 0.9, 2, 1.5.
fn times(x: f64) -> String {
    let tenth = (x * 10.0).round() / 10.0;
    if (tenth - tenth.round()).abs() < 1e-9 {
        format!("{}", tenth.round() as i64)
    } else {
        format!("{tenth:.1}")
    }
}

pub fn buckles_at(now: f64, was: f64) -> String {
    format!("Buckles at {}× the load (was {}×).", times(now), times(was))
}

pub fn already_enough(holds: f64, asked: f64) -> String {
    format!(
        "The wall already holds {}× this load before it buckles, above the {}× asked. No ribs needed.",
        times(holds),
        times(asked)
    )
}

pub fn reached_short(reached: f64, asked: f64) -> String {
    format!(
        "Reached {}× of the {}× asked: no further rib pays enough.",
        times(reached),
        times(asked)
    )
}

pub fn against_case(name: &str) -> String {
    format!("Against case: {name}")
}

fn ideal_notes(vent: bool) -> Vec<String> {
    let mut notes = vec![IDEAL_BUCKLING.to_string()];
    if vent {
        notes.push("Venting was skipped: a buckling plan is not notched.".to_string());
    }
    notes
}

/// Carried by a buckling plan that has ribs: the same sentence a frequency plan gives.
pub const AS_TRACED: &str = "Loose ends are not extended or closed, and ribs stay at full height.";

fn buckling_notes(
    lam: [f64; 2],
    asked: f64,
    unreached: Option<f64>,
    no_ribs: bool,
    vent: bool,
) -> Vec<String> {
    let mut notes = vec![IDEAL_BUCKLING.to_string()];
    if no_ribs && lam[0] + 1e-9 >= asked {
        notes.push(already_enough(lam[0], asked));
    } else if no_ribs {
        notes.push(reached_short(lam[1], asked));
    } else {
        notes.push(buckles_at(lam[1], lam[0]));
        if unreached.is_some() {
            notes.push(reached_short(lam[1], asked));
        }
        // As a frequency plan, a buckling plan leaves each trace where it stopped and
        // plans no comparisons. Say so, or the card's loose-end line reads as a fault.
        notes.push(AS_TRACED.to_string());
    }
    if vent {
        notes.push("Venting was skipped: a buckling plan is not notched.".to_string());
    }
    notes
}

fn response_of(results: &[ShellResult]) -> Response {
    Response {
        compliance: results.iter().map(|r| r.compliance).sum(),
        max_deflection: results.iter().map(|r| r.max_deflection).fold(0.0, f64::max),
    }
}

fn stopped_bare(
    req: &RibPlanRequest,
    lambda: f64,
    solved: &ShellResult,
    mut stats: PlanStats,
    started: Instant,
    rep: &Reporter,
) -> RibPlan {
    stats.seconds.total = started.elapsed().as_secs_f64();
    rep.stage(PlanStage::Done, 1.0);
    let bare = Response {
        compliance: solved.compliance,
        max_deflection: solved.max_deflection,
    };
    RibPlan {
        ribs: Vec::new(),
        rib_volume_mm3: 0.0,
        bare,
        ribbed: bare,
        stiffness_factor: 1.0,
        case_factors: vec![1.0; cases_len(req)],
        case_deflection_mm: vec![[solved.max_deflection, solved.max_deflection]; cases_len(req)],
        worst_trace: Vec::new(),
        goal_met: false,
        thickening: None,
        grid: None,
        not_better_than_baseline: false,
        stopped_early: true,
        loose_ends: Vec::new(),
        mesh: req.mesh.clone(),
        stats,
        vents: None,
        frequency_hz: None,
        frequency_factor: None,
        buckling_factor: Some(factor_of(req, lambda, lambda)),
        notes: ideal_notes(req.vent),
    }
}

fn already(
    req: &RibPlanRequest,
    lambda: f64,
    solved: &[ShellResult],
    mut stats: PlanStats,
    started: Instant,
    rep: &Reporter,
) -> RibPlan {
    stats.seconds.total = started.elapsed().as_secs_f64();
    rep.stage(PlanStage::Done, 1.0);
    let bare = response_of(solved);
    let defl: Vec<[f64; 2]> = solved
        .iter()
        .map(|r| [r.max_deflection, r.max_deflection])
        .collect();
    RibPlan {
        ribs: Vec::new(),
        rib_volume_mm3: 0.0,
        bare,
        ribbed: bare,
        stiffness_factor: 1.0,
        case_factors: vec![1.0; solved.len()],
        case_deflection_mm: defl,
        worst_trace: Vec::new(),
        goal_met: !rep.cancelled(),
        thickening: None,
        grid: None,
        not_better_than_baseline: false,
        stopped_early: rep.cancelled(),
        loose_ends: Vec::new(),
        mesh: req.mesh.clone(),
        stats,
        vents: None,
        frequency_hz: None,
        frequency_factor: None,
        buckling_factor: Some(factor_of(req, lambda, lambda)),
        notes: buckling_notes([lambda, lambda], asked_of(req), None, true, req.vent),
    }
}

fn asked_of(req: &RibPlanRequest) -> f64 {
    match req.goal {
        Goal::Buckling { factor, .. } => factor,
        _ => 1.0,
    }
}

fn cases_len(req: &RibPlanRequest) -> usize {
    req.load_cases.len().max(1)
}

fn mode_results(
    model: &ShellModel,
    modes: &BucklingSet,
    metric: &[f64],
) -> Result<Vec<ShellResult>, SimError> {
    let lambdas: Vec<f64> = modes.modes.iter().map(|m| m.lambda).collect();
    let n = cluster_count(&lambdas).max(1);
    let mut out = Vec::with_capacity(n);
    for mode in modes.modes.iter().take(n) {
        let scale = model
            .mass_inner(metric, &mode.vector, &mode.vector)
            .abs()
            .sqrt();
        let scale = if scale > 0.0 { 1.0 / scale } else { 1.0 };
        let v: Vec<f64> = mode.vector.iter().map(|x| x * scale).collect();
        out.push(model.result_of_free(&v)?);
    }
    Ok(out)
}

type Embedded = (
    Vec<CandChain>,
    crate::shell::ShellMesh,
    Vec<crate::shell::ShellHold>,
    Vec<[f64; 3]>,
    LoadCase,
);

fn embed(
    req: &RibPlanRequest,
    s0: &super::surface::Surface,
    zones: &super::Restrictions,
    traced: &[trace::Candidate],
    cases0: &[LoadCase],
    idx: usize,
) -> Result<Embedded, SimError> {
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
    let case = super::remap_cases(&s1, cases0, req.mesh.triangles.len())
        .get(idx)
        .cloned()
        .unwrap_or_default();
    let mesh = s1.to_mesh();
    let holds = super::resolve_holds(&s1, &req.holds);
    let pos = s1.pos.clone();
    Ok((cands, mesh, holds, pos, case))
}

struct Grown {
    design: Vec<DRib>,
    reached: bool,
    stopped: bool,
    eigen_s: f64,
    solves: usize,
}

#[allow(clippy::too_many_arguments)]
fn grow(
    model: &mut ShellModel,
    cands: &[CandChain],
    pos: &[[f64; 3]],
    case: &LoadCase,
    factor: f64,
    shortlist: usize,
    workers: usize,
    width: f64,
    max_height: f64,
    profile: super::RibProfile,
    side: crate::shell::RibSide,
    min_height: f64,
    rep: &Reporter,
) -> Result<Grown, SimError> {
    if rep.cancelled() {
        return Ok(Grown {
            design: Vec::new(),
            reached: false,
            stopped: true,
            eigen_s: 0.0,
            solves: 0,
        });
    }
    model.set_ribs(Vec::new())?;
    let (first, metric0) = {
        let (set, metric, _) = model.buckling_state(case, MODES)?;
        (set, metric)
    };
    let mut eigen_s = first.seconds;
    let mut solves = 1usize;
    let lambda0 = first.modes[0].lambda;
    let mut pending = Some((first, metric0));
    let mut lambda = lambda0;
    let mut design: Vec<DRib> = Vec::new();
    let mut used = vec![false; cands.len()];
    let mut first_eff: Option<f64> = None;
    let mut reached = false;
    let w_count = workers.max(1);
    let mut pool_models: Vec<ShellModel> = (0..w_count)
        .map(|_| {
            let mut m = model.clone_bare();
            m.set_threads(1);
            m
        })
        .collect();
    // Precompute each candidate's layout, beam stiffnesses, and factored Kψψ once.
    let prepared: Vec<Option<Result<Vec<PreparedRib>, SimError>>> = cands
        .par_iter()
        .enumerate()
        .map(|(i, c)| {
            let d = candidate_rib(c, i, width, max_height, profile);
            if d.heights().iter().all(|&h| h < min_height) {
                return None;
            }
            let ribs = d.solver_ribs(side);
            Some(ribs.iter().map(|r| model.prepare_rib(r)).collect())
        })
        .collect();
    for _round in 0..cands.len() {
        if rep.cancelled() {
            return Ok(Grown {
                design,
                reached: false,
                stopped: true,
                eigen_s,
                solves,
            });
        }
        if lambda + 1e-9 >= factor {
            reached = true;
            break;
        }
        let (modes, metric) = match pending.take() {
            Some(ready) => ready,
            None => {
                let (set, metric, _) = model.buckling_state(case, MODES)?;
                eigen_s += set.seconds;
                solves += 1;
                (set, metric)
            }
        };
        lambda = modes.modes[0].lambda;
        if lambda + 1e-9 >= factor {
            reached = true;
            break;
        }
        let lambdas: Vec<f64> = modes.modes.iter().map(|m| m.lambda).collect();
        let nclus = cluster_count(&lambdas).max(1);
        let vectors: Vec<Vec<f64>> = modes
            .modes
            .iter()
            .take(nclus)
            .map(|m| m.vector.clone())
            .collect();
        let gram = model.mass_gram(&vectors, &metric);
        let base_volume = network_volume(pos, &design);
        let mut pool: Vec<(f64, usize, f64)> = (0..cands.len())
            .into_par_iter()
            .filter(|&i| !used[i])
            .filter_map(|i| {
                if rep.cancelled() {
                    return None;
                }
                let preps_res = prepared[i].as_ref()?;
                let d = candidate_rib(&cands[i], i, width, max_height, profile);
                let mut trial = design.clone();
                trial.push(d);
                let dv = network_volume(pos, &trial) - base_volume;
                if dv <= 0.0 {
                    return None;
                }
                match preps_res {
                    Ok(preps) => match model.cluster_shift_prepared(preps, &vectors, &gram) {
                        Ok(shift) => Some(Ok((shift / dv, i, dv))),
                        Err(e) => Some(Err(e)),
                    },
                    Err(e) => Some(Err(e.clone())),
                }
            })
            .collect::<Result<Vec<_>, _>>()?;
        if rep.cancelled() {
            return Ok(Grown {
                design,
                reached: false,
                stopped: true,
                eigen_s,
                solves,
            });
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
        let base_ribs: Vec<Rib> = design.iter().flat_map(|r| r.solver_ribs(side)).collect();
        let trials: Vec<(usize, f64, DRib, Vec<Rib>)> = pool
            .iter()
            .map(|&(_, i, dv)| {
                let d = candidate_rib(&cands[i], i, width, max_height, profile);
                let mut built = base_ribs.clone();
                built.extend(d.solver_ribs(side));
                (i, dv, d, built)
            })
            .collect();
        let mut last_qs = vec![None::<usize>; w_count];
        type TrialEval = (usize, Result<(f64, f64), SimError>);
        let mut evals: Vec<TrialEval> = pool_models
            .par_iter_mut()
            .zip(last_qs.par_iter_mut())
            .enumerate()
            .flat_map_iter(|(k, (m, last_q))| {
                let mut out = Vec::new();
                for (q, (_, _, _, built)) in trials.iter().enumerate() {
                    if q % w_count != k {
                        continue;
                    }
                    if rep.cancelled() {
                        break;
                    }
                    let res = m.set_ribs(built.clone()).and_then(|()| {
                        let (got, _, _) = m.buckling_state(case, 1)?;
                        Ok((got.modes[0].lambda, got.seconds))
                    });
                    *last_q = Some(q);
                    out.push((q, res));
                }
                out
            })
            .collect();
        if rep.cancelled() {
            return Ok(Grown {
                design,
                reached: false,
                stopped: true,
                eigen_s,
                solves,
            });
        }
        evals.sort_by_key(|x| x.0);
        let mut best: Option<(f64, usize, usize, DRib, f64)> = None;
        for (q, res) in evals {
            let (w, sec) = res?;
            eigen_s += sec;
            solves += 1;
            let (i, dv, d, _) = &trials[q];
            let eff = (w - lambda) / *dv;
            if best.as_ref().is_none_or(|b| eff > b.0) {
                best = Some((eff, q, *i, d.clone(), w));
            }
        }
        let Some((eff, best_q, i, mut d, w)) = best else {
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
        d.gain = (w - lambda) / lambda0.max(1e-30);
        lambda = w;
        design.push(d);
        let wk = best_q % w_count;
        if last_qs[wk] == Some(best_q) {
            std::mem::swap(model, &mut pool_models[wk]);
        } else {
            let with: Vec<Rib> = design.iter().flat_map(|r| r.solver_ribs(side)).collect();
            model.set_ribs(with)?;
        }
        let within = if factor > lambda0 {
            ((lambda - lambda0) / (factor - lambda0)).clamp(0.0, 1.0)
        } else {
            1.0
        };
        rep.stage(PlanStage::Select, within);
        if let Some(last) = design.last().cloned() {
            rep.buckling_rib(&last, pos, &design, lambda);
        }
    }
    if lambda + 1e-9 >= factor {
        reached = true;
    }
    Ok(Grown {
        design,
        reached,
        stopped: false,
        eigen_s,
        solves,
    })
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

/// Load factors on the clean mesh, bare then with the chosen ribs.
fn factors(clean: &mut Clean, idx: usize) -> Result<(f64, f64, f64, usize), SimError> {
    let case = clean
        .cases
        .get(idx)
        .cloned()
        .ok_or_else(|| SimError::new("A buckling goal names a load case the request does not have."))?;
    let mut bare_model = clean.model.clone_bare();
    bare_model.set_threads(1);
    let bare = bare_model.buckling_modes(&case, 1)?;
    // `clean.model` already has `clean.design` ribs set and factored.
    let ribbed = clean.model.buckling_modes(&case, 1)?;
    Ok((
        bare.modes[0].lambda,
        ribbed.modes[0].lambda,
        bare.seconds + ribbed.seconds,
        2,
    ))
}

#[cfg(test)]
mod sentences {
    use super::{against_case, already_enough, buckles_at, reached_short, IDEAL_BUCKLING};

    #[test]
    fn the_owners_sentences_are_verbatim() {
        assert_eq!(
            IDEAL_BUCKLING,
            "This is the ideal buckling load. A curved wall, or one that isn't perfectly flat, can buckle well below it."
        );
        assert_eq!(
            buckles_at(3.1, 0.9),
            "Buckles at 3.1× the load (was 0.9×)."
        );
        assert_eq!(
            already_enough(3.2, 2.0),
            "The wall already holds 3.2× this load before it buckles, above the 2× asked. No ribs needed."
        );
        assert_eq!(
            reached_short(1.7, 3.0),
            "Reached 1.7× of the 3× asked: no further rib pays enough."
        );
        assert_eq!(against_case("edge push"), "Against case: edge push");
        assert_eq!(buckles_at(1.5, 2.0), "Buckles at 1.5× the load (was 2×).");
    }
}
