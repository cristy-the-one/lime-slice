//! Choosing ribs among the embedded candidates: greedy growth with exact
//! re-solves, loose ends extended, ribs joined, pruning and height sizing.
//!
//! **Score.** A candidate's worth is the drop in compliance (the loads'
//! work, summed over cases) it brings, per rib volume it adds: Li et
//! al.'s `1 − Uᵢ/U₀` per volume, against the current design rather than
//! the bare wall, so ribs that would duplicate a chosen one score low.
//!
//! **Shortlist.** Solving every candidate every round costs candidates ×
//! rounds factorisations. Each round instead ranks the candidates by the
//! first-order estimate: the energy `U` the rib would take if the current
//! displacements were kept ([`ShellModel::probe_rib_energy`], web
//! rotations relaxed); `g = 2U` is the compliance drop to first order, and
//! the one-spring saturation `C g / (C + g)` (exact for a single dof)
//! keeps stiff ribs from being over-promised. The best
//! [`super::PlannerOptions::shortlist`] by estimate per volume are solved
//! exactly, side by side on the [`Evaluator`]'s models, and the best of
//! those is added.
//!
//! **Why a fresh factor per candidate, not a low-rank update.** Adding a
//! rib changes the stiffness only on its own dofs, so its exact gain could
//! come from the current factor by Sherman–Morrison–Woodbury (the web
//! rotations as a bordered block): `ΔC = u_Sᵀ S (I + G S)⁻¹ u_S` with
//! `G = K⁻¹` on the rib's dofs. But `G` needs one solve per dof the rib
//! touches, six per rib vertex, and the rib's condensed stiffness is of
//! full rank on them. Measured (`scoring_cost_and_thread_arrangement`,
//! release): at 39k triangles a refactor costs 0.76 s and one right-hand
//! side 0.035 s alone or 0.013 s in a batch of 216; a cross candidate
//! touches 426 dofs (≈ 4.5 s of solves) and a long one 1686 (≈ 11 s). The
//! update wins only for ribs under about 7–16 vertices, shorter than any
//! candidate. Eight refactors side by side, one thread each, cost 0.64 s.

use std::collections::BTreeMap;
use std::time::Instant;

use rayon::prelude::*;

use crate::error::SimError;
use crate::shell::{LoadCase, Rib, RibSide, ShellModel, ShellResult};
use crate::units::{cross, norm, normalize, sub};

use super::profile::RibProfile;
use super::trace::Family;
use super::{Goal, PlanStage, Reporter, RibChange, BALANCED_FLOOR, TARGET_FLOOR};

/// A candidate cut into the mesh.
#[derive(Clone, Debug)]
pub(crate) struct CandChain {
    pub chain: Vec<u32>,
    /// Per edge, the greatest height allowed there (rules, clearance and
    /// height-capped zones).
    pub caps: Vec<f64>,
    pub family: Family,
    /// The straight extension from each end, a chain starting at that
    /// end, with its edge caps.
    pub stub: [Option<(Vec<u32>, Vec<f64>)>; 2],
}

/// A rib of the design: a nominal height, lowered per edge to its cap.
#[derive(Clone, Debug)]
pub(crate) struct DRib {
    pub chain: Vec<u32>,
    pub caps: Vec<f64>,
    pub height: f64,
    pub width: f64,
    pub profile: RibProfile,
    pub family: Family,
    /// The candidate it grew from.
    pub cand: usize,
    /// Compliance drop when added, over the bare compliance.
    pub gain: f64,
    /// A stable identity through removals.
    pub id: usize,
}

impl DRib {
    /// A rib of one height everywhere.
    pub fn fixed(chain: Vec<u32>, height: f64, width: f64, profile: RibProfile) -> Self {
        let caps = vec![height; chain.len().saturating_sub(1)];
        Self {
            chain,
            caps,
            height,
            width,
            profile,
            family: Family::Major,
            cand: usize::MAX,
            gain: 0.0,
            id: 0,
        }
    }

    /// The height of each edge.
    pub fn heights(&self) -> Vec<f64> {
        self.caps.iter().map(|c| c.min(self.height)).collect()
    }

    pub fn tallest(&self) -> f64 {
        self.heights().into_iter().fold(0.0, f64::max)
    }

    pub fn solver_ribs(&self, side: RibSide) -> Vec<Rib> {
        self.profile
            .solver_ribs(&self.chain, &self.heights(), self.width, side)
    }

    /// Its own volume, before overlaps.
    pub fn volume(&self, pos: &[[f64; 3]]) -> f64 {
        self.chain
            .windows(2)
            .zip(self.heights())
            .map(|(w, h)| {
                norm(sub(pos[w[1] as usize], pos[w[0] as usize])) * self.profile.area(self.width, h)
            })
            .sum()
    }
}

pub(crate) struct Ctx {
    pub pos: Vec<[f64; 3]>,
    pub thickness: Vec<f64>,
    pub boundary: Vec<bool>,
    pub held: Vec<bool>,
    pub width: f64,
    pub profile: RibProfile,
    pub min_height: f64,
    pub max_height: f64,
    pub goal: Goal,
    pub shortlist: usize,
}

#[derive(Clone, Debug)]
pub(crate) struct Eval {
    pub compliance: f64,
    pub max_deflection: f64,
    pub strain_energy: f64,
    /// Per design rib (summed over its solver ribs and the cases).
    pub rib_energy: Vec<f64>,
    pub results: Vec<ShellResult>,
}

/// Solves designs on the cut mesh, several at once.
///
/// One model per worker, each factoring on a single thread. Measured on
/// a 24-core machine (`scoring_cost_and_thread_arrangement`, 39k
/// triangles): eight candidates took 5.34 s one after another on one
/// model factoring on 8 threads, and 0.64 s on eight single-threaded
/// models side by side; 4 × 2 threads took 1.16 s and 2 × 4 took 2.00 s.
/// A sparse factor this size gains little from threads of its own, so the
/// cores are better spent on candidates.
///
/// Every model is the same and factors on one thread, so a design's
/// answer is bit for bit the same whichever model, worker count or thread
/// pool solves it.
pub(crate) struct Evaluator {
    pub models: Vec<ShellModel>,
    pub cases: Vec<LoadCase>,
    pub side: RibSide,
    pub solves: usize,
    pub seconds: f64,
}

fn evaluate(
    model: &mut ShellModel,
    cases: &[LoadCase],
    side: RibSide,
    design: &[DRib],
) -> Result<Eval, SimError> {
    let mut ribs: Vec<Rib> = Vec::new();
    let mut owner: Vec<usize> = Vec::new();
    for (i, d) in design.iter().enumerate() {
        for r in d.solver_ribs(side) {
            ribs.push(r);
            owner.push(i);
        }
    }
    model.set_ribs(ribs)?;
    let results = model.solve_cases(cases)?;
    let mut rib_energy = vec![0.0; design.len()];
    for r in &results {
        for (k, e) in r.rib_energy.iter().enumerate() {
            rib_energy[owner[k]] += e;
        }
    }
    Ok(Eval {
        compliance: results.iter().map(|r| r.compliance).sum(),
        max_deflection: results.iter().map(|r| r.max_deflection).fold(0.0, f64::max),
        strain_energy: results.iter().map(|r| r.strain_energy).sum(),
        rib_energy,
        results,
    })
}

impl Evaluator {
    /// `models` must all be the same shell; each is set to one thread.
    pub fn new(mut models: Vec<ShellModel>, cases: Vec<LoadCase>, side: RibSide) -> Self {
        for m in &mut models {
            m.set_threads(1);
        }
        Self {
            models,
            cases,
            side,
            solves: 0,
            seconds: 0.0,
        }
    }

    pub fn workers(&self) -> usize {
        self.models.len()
    }

    pub fn eval(&mut self, design: &[DRib]) -> Result<Eval, SimError> {
        let mut all = self.eval_many(&[design.to_vec()])?;
        Ok(all.remove(0))
    }

    /// Solve every design, spread over the models; answers in order.
    pub fn eval_many(&mut self, designs: &[Vec<DRib>]) -> Result<Vec<Eval>, SimError> {
        let started = Instant::now();
        let w = self.models.len();
        let (cases, side) = (&self.cases, self.side);
        let mut out: Vec<(usize, Result<Eval, SimError>)> = self
            .models
            .par_iter_mut()
            .enumerate()
            .flat_map_iter(|(k, m)| {
                designs
                    .iter()
                    .enumerate()
                    .filter(|(q, _)| q % w == k)
                    .map(|(q, d)| (q, evaluate(m, cases, side, d)))
                    .collect::<Vec<_>>()
            })
            .collect();
        out.sort_by_key(|x| x.0);
        self.solves += designs.len();
        self.seconds += started.elapsed().as_secs_f64();
        out.into_iter().map(|x| x.1).collect()
    }

    /// The first-order compliance drop of adding rib `d` to the design
    /// `at` was solved for.
    fn estimate(&self, d: &DRib, at: &Eval) -> Result<f64, SimError> {
        let ribs = d.solver_ribs(self.side);
        let model = &self.models[0];
        let mut drop = 0.0;
        for r in &at.results {
            let mut u = 0.0;
            for rib in &ribs {
                u += model.probe_rib_energy(rib, r)?;
            }
            let g = 2.0 * u;
            let c = r.compliance.abs();
            if c + g > 0.0 {
                drop += c * g / (c + g);
            }
        }
        Ok(drop)
    }
}

/// Unit tangent of a chain at its `i`-th vertex.
fn tangent(pos: &[[f64; 3]], chain: &[u32], i: usize) -> [f64; 3] {
    let a = chain[i.saturating_sub(1)];
    let b = chain[(i + 1).min(chain.len() - 1)];
    normalize(sub(pos[b as usize], pos[a as usize])).unwrap_or([1.0, 0.0, 0.0])
}

/// Volume of a rib network: each edge's length × its section area, less
/// the overlap where two ribs share a vertex. Crossing at angle θ they
/// share `w₁ w₂ min(h) / sin θ` (sin θ floored at 0.3, h the lower of the
/// edges there); one ending on the other shares half that, two ends
/// meeting a quarter. Gil-Ureta et al. 2020 show double counting the
/// joints overstates rib volume.
pub(crate) fn network_volume(pos: &[[f64; 3]], design: &[DRib]) -> f64 {
    let mut v: f64 = design.iter().map(|d| d.volume(pos)).sum();
    // Per vertex: (rib, at its end, tangent, height there).
    type Meet = (usize, bool, [f64; 3], f64);
    let mut at: BTreeMap<u32, Vec<Meet>> = BTreeMap::new();
    for (r, d) in design.iter().enumerate() {
        let n = d.chain.len();
        let hs = d.heights();
        for (i, &vtx) in d.chain.iter().enumerate() {
            let end = i == 0 || i + 1 == n;
            let h = match (i.checked_sub(1).map(|e| hs[e]), hs.get(i)) {
                (Some(a), Some(b)) => a.min(*b),
                (Some(a), None) => a,
                (None, Some(b)) => *b,
                (None, None) => 0.0,
            };
            at.entry(vtx)
                .or_default()
                .push((r, end, tangent(pos, &d.chain, i), h));
        }
    }
    for list in at.values() {
        for i in 0..list.len() {
            for j in i + 1..list.len() {
                let (ri, ei, ti, hi) = list[i];
                let (rj, ej, tj, hj) = list[j];
                if ri == rj {
                    continue;
                }
                let sin = norm(cross(ti, tj)).max(0.3);
                let share = match (ei, ej) {
                    (false, false) => 1.0,
                    (true, true) => 0.25,
                    _ => 0.5,
                };
                let (a, b) = (&design[ri], &design[rj]);
                let h = hi.min(hj);
                v -= share
                    * a.profile
                        .crossing_overlap(a.width, b.profile, b.width, h, sin);
            }
        }
    }
    v.max(0.0)
}

pub(crate) struct Outcome {
    pub design: Vec<DRib>,
    pub bare: Eval,
    pub current: Eval,
    pub goal_met: bool,
    /// Cancelled: the design is the best valid one when it stopped.
    pub stopped: bool,
    /// Seconds in selection, connection, pruning, sizing.
    pub seconds: [f64; 4],
}

fn goal_met(goal: Goal, c0: f64, e: &Eval) -> bool {
    match goal {
        Goal::Stiffer(f) => c0 / e.compliance >= f,
        Goal::MaxDeflection(d) => e.max_deflection <= d,
        Goal::Budget { .. } | Goal::Balanced => false,
    }
}

fn floor_share(goal: Goal) -> f64 {
    match goal {
        Goal::Balanced => BALANCED_FLOOR,
        _ => TARGET_FLOOR,
    }
}

/// How far toward the goal, 0 to 1, for the progress bar.
fn goal_progress(goal: Goal, bare: &Eval, cur: &Eval, volume: f64, eff: Option<(f64, f64)>) -> f64 {
    let g = match goal {
        Goal::Stiffer(f) if f > 1.0 => (bare.compliance / cur.compliance).ln() / f.ln(),
        Goal::MaxDeflection(d) if bare.max_deflection > d => {
            (bare.max_deflection / cur.max_deflection).ln() / (bare.max_deflection / d).ln()
        }
        Goal::Budget { volume_mm3 } if volume_mm3 > 0.0 => volume / volume_mm3,
        Goal::Balanced => eff.map_or(0.0, |(last, first)| {
            (1.0 - last / first) / (1.0 - BALANCED_FLOOR)
        }),
        _ => 1.0,
    };
    if g.is_finite() {
        g.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

pub(crate) fn run(
    ev: &mut Evaluator,
    ctx: &Ctx,
    cands: &[CandChain],
    rep: &Reporter,
) -> Result<Outcome, SimError> {
    let bare = ev.eval(&[])?;
    let c0 = bare.compliance;
    let mut cur = bare.clone();
    let mut design: Vec<DRib> = Vec::new();
    let mut used = vec![false; cands.len()];
    let mut first_eff: Option<f64> = None;
    let mut seconds = [0.0; 4];
    let mut stopped = false;
    let workers = ev.workers().max(1);
    let finish = |design: Vec<DRib>, cur: Eval, stopped: bool, seconds: [f64; 4]| {
        let met = match ctx.goal {
            Goal::Budget { volume_mm3 } => network_volume(&ctx.pos, &design) <= volume_mm3,
            Goal::Balanced => !stopped,
            g => goal_met(g, c0, &cur),
        };
        Outcome {
            design,
            bare: bare.clone(),
            current: cur,
            goal_met: met,
            stopped,
            seconds,
        }
    };

    // Greedy growth.
    let t = Instant::now();
    rep.stage(PlanStage::Select, 0.0);
    if !goal_met(ctx.goal, c0, &cur) {
        loop {
            if rep.cancelled() {
                stopped = true;
                break;
            }
            let base_volume = network_volume(&ctx.pos, &design);
            let mut pool: Vec<(f64, usize, f64)> = Vec::new();
            for (i, c) in cands.iter().enumerate() {
                if used[i] {
                    continue;
                }
                let trial = with(&design, c, i, ctx);
                let dv = network_volume(&ctx.pos, &trial) - base_volume;
                if dv <= 0.0 {
                    continue;
                }
                if let Goal::Budget { volume_mm3 } = ctx.goal {
                    if base_volume + dv > volume_mm3 {
                        continue;
                    }
                }
                let est = ev.estimate(trial.last().expect("added"), &cur)?;
                pool.push((est / dv, i, dv));
            }
            if pool.is_empty() {
                break;
            }
            pool.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
            let k = if ctx.shortlist == 0 {
                pool.len()
            } else {
                ctx.shortlist.min(pool.len())
            };
            let trials: Vec<Vec<DRib>> = pool[..k]
                .iter()
                .map(|&(_, i, _)| with(&design, &cands[i], i, ctx))
                .collect();
            let evals = ev.eval_many(&trials)?;
            if rep.cancelled() {
                stopped = true;
                break;
            }
            let mut best: Option<(f64, usize, Eval)> = None;
            for (&(_, i, dv), e) in pool[..k].iter().zip(evals) {
                let eff = (cur.compliance - e.compliance) / dv;
                let better = match &best {
                    None => true,
                    Some((b, bi, _)) => eff > *b || (eff == *b && i < *bi),
                };
                if better {
                    best = Some((eff, i, e));
                }
            }
            let Some((eff, i, e)) = best else { break };
            if eff <= 0.0 {
                break;
            }
            let first = *first_eff.get_or_insert(eff);
            if eff < floor_share(ctx.goal) * first {
                break;
            }
            let mut rib = with(&design, &cands[i], i, ctx).pop().expect("added");
            rib.gain = (cur.compliance - e.compliance) / c0;
            design.push(rib);
            used[i] = true;
            cur = e;
            let volume = network_volume(&ctx.pos, &design);
            rep.stage(
                PlanStage::Select,
                goal_progress(ctx.goal, &bare, &cur, volume, Some((eff, first))),
            );
            rep.rib(
                RibChange::Added,
                design.last(),
                i,
                &ctx.pos,
                &design,
                &cur,
                c0,
            );
            if goal_met(ctx.goal, c0, &cur) {
                break;
            }
        }
    }
    seconds[0] = t.elapsed().as_secs_f64();
    if stopped {
        return Ok(finish(design, cur, true, seconds));
    }
    let floor = first_eff.map_or(0.0, |f| floor_share(ctx.goal) * f);

    // Loose ends: extend along the stub to the boundary, a hold or a rib.
    let t = Instant::now();
    rep.stage(PlanStage::Connect, 0.0);
    'ends: for i in 0..design.len() {
        rep.stage(PlanStage::Connect, i as f64 / design.len() as f64);
        for end in 0..2 {
            let chain = &design[i].chain;
            let v = if end == 0 {
                chain[0]
            } else {
                *chain.last().expect("chain")
            };
            if ctx.boundary[v as usize] || ctx.held[v as usize] || on_other(&design, i, v) {
                continue;
            }
            let cand = design[i].cand;
            if cand >= cands.len() {
                continue;
            }
            let Some((stub, stub_caps)) = &cands[cand].stub[end] else {
                continue;
            };
            let reach = (1..stub.len()).find(|&k| {
                let w = stub[k] as usize;
                ctx.boundary[w] || ctx.held[w] || on_other(&design, i, stub[k])
            });
            let Some(k) = reach else { continue };
            let ext = &stub[1..=k];
            let ext_caps = &stub_caps[..k];
            if ext_caps.iter().any(|&c| c < ctx.min_height) {
                continue;
            }
            let d = &design[i];
            let (new_chain, new_caps) = if end == 0 {
                let mut c: Vec<u32> = ext.iter().rev().copied().collect();
                c.extend_from_slice(&d.chain);
                let mut caps: Vec<f64> = ext_caps.iter().rev().copied().collect();
                caps.extend_from_slice(&d.caps);
                (c, caps)
            } else {
                let mut c = d.chain.clone();
                c.extend_from_slice(ext);
                let mut caps = d.caps.clone();
                caps.extend_from_slice(ext_caps);
                (c, caps)
            };
            if has_repeat(&new_chain) {
                continue;
            }
            let mut trial = design.clone();
            trial[i].chain = new_chain;
            trial[i].caps = new_caps;
            if over_budget(ctx, &trial) {
                continue;
            }
            let dv = network_volume(&ctx.pos, &trial) - network_volume(&ctx.pos, &design);
            if rep.cancelled() {
                stopped = true;
                break 'ends;
            }
            let e = ev.eval(&trial)?;
            let dc = cur.compliance - e.compliance;
            if dc > 0.0 && (dv <= 0.0 || dc / dv >= floor) {
                design = trial;
                cur = e;
                rep.rib(
                    RibChange::Changed,
                    Some(&design[i]),
                    design[i].id,
                    &ctx.pos,
                    &design,
                    &cur,
                    c0,
                );
            }
        }
    }
    if stopped {
        seconds[1] = t.elapsed().as_secs_f64();
        return Ok(finish(design, cur, true, seconds));
    }
    // Join ribs that meet end to end nearly straight.
    let mut joined = false;
    'outer: loop {
        for i in 0..design.len() {
            for j in i + 1..design.len() {
                if let Some((chain, caps)) = join(&ctx.pos, &design[i], &design[j]) {
                    // Joined, their shared end is no longer an overlap: the
                    // network grows a little, which a budget may not take.
                    let mut trial = design.clone();
                    trial[i].chain = chain;
                    trial[i].caps = caps;
                    trial[i].gain += trial[j].gain;
                    let gone = trial.remove(j);
                    if over_budget(ctx, &trial) {
                        continue;
                    }
                    design = trial;
                    rep.rib(
                        RibChange::Removed,
                        None,
                        gone.id,
                        &ctx.pos,
                        &design,
                        &cur,
                        c0,
                    );
                    joined = true;
                    continue 'outer;
                }
            }
        }
        break;
    }
    if joined {
        cur = ev.eval(&design)?;
        for d in &design {
            rep.rib(
                RibChange::Changed,
                Some(d),
                d.id,
                &ctx.pos,
                &design,
                &cur,
                c0,
            );
        }
    }
    seconds[1] = t.elapsed().as_secs_f64();

    // Prune, weakest first by energy per volume. Removals are tried in
    // batches of one per worker, each against the current design; the
    // first that is taken changes the design, and the rest of its batch
    // is tried again against the new one, so the outcome is the same as
    // trying them one by one.
    let t = Instant::now();
    rep.stage(PlanStage::Prune, 0.0);
    if !design.is_empty() {
        let mut order: Vec<(f64, usize)> = design
            .iter()
            .enumerate()
            .map(|(i, d)| (cur.rib_energy[i] / d.volume(&ctx.pos), d.id))
            .collect();
        order.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
        let order: Vec<usize> = order.into_iter().map(|x| x.1).collect();
        let total = order.len();
        let mut next = 0;
        while next < total {
            if rep.cancelled() {
                stopped = true;
                break;
            }
            let batch: Vec<usize> = order[next..(next + workers).min(total)].to_vec();
            let trials: Vec<Vec<DRib>> = batch
                .iter()
                .map(|&id| design.iter().filter(|d| d.id != id).cloned().collect())
                .collect();
            let evals = ev.eval_many(&trials)?;
            for ((id, trial), e) in batch.into_iter().zip(trials).zip(evals) {
                next += 1;
                let remove = match ctx.goal {
                    Goal::Stiffer(_) | Goal::MaxDeflection(_) => goal_met(ctx.goal, c0, &e),
                    Goal::Balanced | Goal::Budget { .. } => {
                        let dv =
                            network_volume(&ctx.pos, &design) - network_volume(&ctx.pos, &trial);
                        dv > 0.0 && (e.compliance - cur.compliance) / dv < floor
                    }
                };
                if remove {
                    design = trial;
                    cur = e;
                    rep.rib(RibChange::Removed, None, id, &ctx.pos, &design, &cur, c0);
                    break;
                }
            }
            rep.stage(PlanStage::Prune, next as f64 / total as f64);
        }
    }
    seconds[2] = t.elapsed().as_secs_f64();
    if stopped {
        return Ok(finish(design, cur, true, seconds));
    }

    // Heights: lower each rib's nominal height (edges under a lower cap
    // stay at their cap) where the goal allows, most volume saved per
    // estimated stiffness lost first. A budget plan keeps its heights
    // (lowering only loses stiffness there). The best few cuts are solved
    // side by side: a refused cut freezes its rib and leaves the design as
    // it was, so the next in the ranking is the one a one-by-one pass would
    // try next; a taken cut changes the design and the ranking is redone.
    let t = Instant::now();
    rep.stage(PlanStage::Size, 0.0);
    if !matches!(ctx.goal, Goal::Budget { .. }) && !design.is_empty() {
        let step = ctx.max_height / 6.0;
        let mut frozen: Vec<usize> = Vec::new();
        let budget_steps = (design.len() * 7).max(1) as f64;
        let mut tried = 0usize;
        'size: loop {
            if rep.cancelled() {
                stopped = true;
                break;
            }
            let volume = network_volume(&ctx.pos, &design);
            let mut ranked: Vec<(f64, usize, f64)> = Vec::new();
            for (i, d) in design.iter().enumerate() {
                let top = d.tallest();
                if frozen.contains(&d.id) || top <= ctx.min_height + 1e-9 {
                    continue;
                }
                let h2 = (top - step).max(ctx.min_height);
                let mut lower = d.clone();
                lower.height = h2;
                let dv = d.volume(&ctx.pos) - lower.volume(&ctx.pos);
                if dv <= 0.0 {
                    continue;
                }
                let stiffness = |r: &DRib| -> f64 {
                    r.chain
                        .windows(2)
                        .zip(r.heights())
                        .map(|(w, h)| {
                            let len = norm(sub(ctx.pos[w[1] as usize], ctx.pos[w[0] as usize]));
                            let wall =
                                0.5 * (ctx.thickness[w[0] as usize] + ctx.thickness[w[1] as usize]);
                            len * r.profile.bending_proxy(r.width, h, wall)
                        })
                        .sum()
                };
                let dc_est = 2.0 * cur.rib_energy[i] * (1.0 - stiffness(&lower) / stiffness(d));
                let ratio = if dc_est > 0.0 {
                    dv / dc_est
                } else {
                    f64::INFINITY
                };
                ranked.push((ratio, i, h2));
            }
            if ranked.is_empty() {
                break;
            }
            ranked.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
            ranked.truncate(workers);
            let trials: Vec<Vec<DRib>> = ranked
                .iter()
                .map(|&(_, i, h2)| {
                    let mut t = design.clone();
                    t[i].height = h2;
                    t
                })
                .collect();
            let evals = ev.eval_many(&trials)?;
            for ((&(_, i, _), trial), e) in ranked.iter().zip(trials).zip(evals) {
                tried += 1;
                let accept = match ctx.goal {
                    Goal::Stiffer(_) | Goal::MaxDeflection(_) => goal_met(ctx.goal, c0, &e),
                    _ => {
                        let dv = volume - network_volume(&ctx.pos, &trial);
                        dv > 0.0 && (e.compliance - cur.compliance) / dv < floor
                    }
                };
                rep.stage(PlanStage::Size, tried as f64 / budget_steps);
                if accept {
                    design = trial;
                    cur = e;
                    rep.rib(
                        RibChange::Changed,
                        Some(&design[i]),
                        design[i].id,
                        &ctx.pos,
                        &design,
                        &cur,
                        c0,
                    );
                    continue 'size;
                }
                frozen.push(design[i].id);
            }
        }
    }
    seconds[3] = t.elapsed().as_secs_f64();
    Ok(finish(design, cur, stopped, seconds))
}

/// Whether a design spends more than a [`Goal::Budget`] allows, counted as
/// the plan reports it: real section areas, crossing overlaps once.
fn over_budget(ctx: &Ctx, design: &[DRib]) -> bool {
    match ctx.goal {
        Goal::Budget { volume_mm3 } => network_volume(&ctx.pos, design) > volume_mm3,
        _ => false,
    }
}

/// The design with candidate `i` added at the greatest height.
fn with(design: &[DRib], c: &CandChain, i: usize, ctx: &Ctx) -> Vec<DRib> {
    let mut d = design.to_vec();
    d.push(DRib {
        chain: c.chain.clone(),
        caps: c.caps.clone(),
        height: ctx.max_height,
        width: ctx.width,
        profile: ctx.profile,
        family: c.family,
        cand: i,
        gain: 0.0,
        id: i,
    });
    d
}

fn on_other(design: &[DRib], i: usize, v: u32) -> bool {
    design
        .iter()
        .enumerate()
        .any(|(j, d)| j != i && d.chain.contains(&v))
}

fn has_repeat(chain: &[u32]) -> bool {
    let mut s = chain.to_vec();
    s.sort_unstable();
    s.windows(2).any(|w| w[0] == w[1])
}

/// One chain (and its edge caps) from two ribs that share an end and
/// continue each other within 30°, with the same nominal height.
fn join(pos: &[[f64; 3]], a: &DRib, b: &DRib) -> Option<(Vec<u32>, Vec<f64>)> {
    if (a.height - b.height).abs() > 1e-9 || a.width != b.width || a.profile != b.profile {
        return None;
    }
    let ends = |c: &[u32]| [c[0], *c.last().expect("chain")];
    for (ea, va) in ends(&a.chain).into_iter().enumerate() {
        for (eb, vb) in ends(&b.chain).into_iter().enumerate() {
            if va != vb {
                continue;
            }
            // a oriented to end at the shared vertex, b to start there.
            let mut ca = a.chain.clone();
            let mut ka = a.caps.clone();
            if ea == 0 {
                ca.reverse();
                ka.reverse();
            }
            let mut cb = b.chain.clone();
            let mut kb = b.caps.clone();
            if eb == 1 {
                cb.reverse();
                kb.reverse();
            }
            let n = ca.len();
            let ta = tangent(pos, &ca, n - 1);
            let tb = tangent(pos, &cb, 0);
            if crate::units::dot(ta, tb) < 30f64.to_radians().cos() {
                continue;
            }
            ca.extend_from_slice(&cb[1..]);
            if has_repeat(&ca) {
                continue;
            }
            ka.extend_from_slice(&kb);
            return Some((ca, ka));
        }
    }
    None
}
