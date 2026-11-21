//! Loose rib ends (docs/plan-auto-ribs.md §7.3: "a rib that ends in
//! mid-wall is extended to the nearest wall or rib, since a loose end does
//! little").
//!
//! Selection extends an end only along a short straight stub cut into the
//! selection mesh before it starts, so ends that stop in mid-wall (a
//! candidate stopped beside a parallel line, or where the field turned)
//! survive it. This pass runs after selection, one loose end at a time,
//! on a mesh of its own: the input with the chosen ribs and that end's
//! extensions cut in (not the selection mesh, whose sliver triangles make
//! ribs look stiffer than they are). For each end it weighs:
//!
//! - **extend** along the straight continuation or the field's own
//!   continuation (traced with no spacing rule), each to the first
//!   boundary, hold or other rib it meets, at any length;
//! - **trim** the rib back to its last junction (the nearest vertex along
//!   it on the boundary, a hold or another rib);
//!
//! each against dropping the rib: an option is worth the compliance it
//! saves over the design without the rib, per the rib's volume, and it is
//! taken when that passes the selection's gain floor, the best first.
//! When none does, the rib is dropped, unless the end stands at a no-rib
//! zone's border or the only extension that reached was over the budget:
//! then it stays loose and is listed with that reason.

use rayon::prelude::*;

use crate::error::SimError;
use crate::shell::{LoadCase, ShellModel};
use crate::units::{norm, normalize, sub};

use super::select::{self, DRib, Eval, Mix};
use super::surface::Surface;
use super::trace::Tracer;
use super::{
    edge_caps, embed_design, held_flags, remap_cases, resolve_holds, rib_ends, GRib, Goal,
    LooseEndReason, LooseEndStats, Reporter, RibChange, RibEndKind, RibPlanRequest,
};

pub(crate) struct Input<'a> {
    pub req: &'a RibPlanRequest,
    pub s0: &'a Surface,
    pub tracer: &'a Tracer<'a>,
    /// Greatest rib height per input triangle.
    pub tri_cap: &'a [f64],
    /// No rib per input triangle.
    pub blocked: &'a [bool],
    pub cases0: &'a [LoadCase],
}

pub(crate) struct Closed {
    pub ribs: Vec<GRib>,
    /// Ends left loose: rib index into `ribs`, end, why.
    pub loose: Vec<(usize, usize, LooseEndReason)>,
    pub stats: LooseEndStats,
    pub solves: usize,
    pub stopped: bool,
}

impl Closed {
    /// The ribs as they are, their loose ends counted, none closed.
    pub fn unchanged(input: &Input, ribs: Vec<GRib>) -> Self {
        let (s, design, _, _) = embed_design(input.s0, &ribs, &[]);
        let held = held_flags(&resolve_holds(&s, &input.req.holds), s.pos.len());
        let free = rib_ends(&s, &held, &design)
            .iter()
            .flatten()
            .filter(|e| **e == RibEndKind::Free)
            .count();
        Self {
            ribs,
            loose: Vec::new(),
            stats: LooseEndStats {
                before: free,
                after: free,
                ..LooseEndStats::default()
            },
            solves: 0,
            stopped: false,
        }
    }
}

fn end_vertex(d: &DRib, end: usize) -> u32 {
    if end == 0 {
        d.chain[0]
    } else {
        *d.chain.last().expect("chain")
    }
}

/// The rib's chain and caps with `ext` (a chain from its `end` vertex)
/// added at that end.
fn extended(d: &DRib, end: usize, ext: &[u32], ext_caps: &[f64]) -> (Vec<u32>, Vec<f64>) {
    if end == 0 {
        let mut c: Vec<u32> = ext.iter().rev().copied().collect();
        c.extend_from_slice(&d.chain[1..]);
        let mut caps: Vec<f64> = ext_caps.iter().rev().copied().collect();
        caps.extend_from_slice(&d.caps);
        (c, caps)
    } else {
        let mut c = d.chain.clone();
        c.extend_from_slice(&ext[1..]);
        let mut caps = d.caps.clone();
        caps.extend_from_slice(ext_caps);
        (c, caps)
    }
}

fn has_repeat(chain: &[u32]) -> bool {
    let mut s = chain.to_vec();
    s.sort_unstable();
    s.windows(2).any(|w| w[0] == w[1])
}

/// Each design solved on `s` (holds and loads carried the planner's way),
/// side by side, each model on one thread.
fn solve_all(
    input: &Input,
    s: &Surface,
    designs: &[Vec<DRib>],
    mix: &Mix,
) -> Result<Vec<Eval>, SimError> {
    if designs.is_empty() {
        return Ok(Vec::new());
    }
    let req = input.req;
    let holds = resolve_holds(s, &req.holds);
    let cases = remap_cases(s, input.cases0, req.mesh.triangles.len());
    let mesh = s.to_mesh();
    let mut base = ShellModel::new(mesh, req.material, &holds, req.options.shell())?;
    base.set_threads(1);
    let forces = base.precompute_loads(&cases)?;
    designs
        .par_iter()
        .map(|d| {
            let mut m = base.clone_bare();
            select::evaluate_precomputed_light(&mut m, &forces, req.rules.side, d, mix, false)
        })
        .collect()
}

/// The ribs as they stand on `s`, back as geometry.
fn as_grib(s: &Surface, d: &DRib) -> GRib {
    GRib {
        points: d.chain.iter().map(|&v| s.pos[v as usize]).collect(),
        heights: d.heights(),
        d: d.clone(),
    }
}

/// Close the loose ends of `ribs` (see the module notes). `floor` is the
/// selection's gain floor (compliance per mm³); `c0` the bare compliance,
/// for the progress events.
pub(crate) fn close(
    input: &Input,
    mut ribs: Vec<GRib>,
    floor: f64,
    c0: f64,
    mix: &Mix,
    rep: &Reporter,
) -> Result<Closed, SimError> {
    let req = input.req;
    let rules = &req.rules;
    let mut stats = LooseEndStats::default();
    let mut solves = 0usize;
    // Ends decided to stay loose: rib id, end, why.
    let mut kept: Vec<(usize, usize, LooseEndReason)> = Vec::new();
    let mut first = true;
    let mut rounds = 0usize;
    loop {
        rounds += 1;
        if rep.cancelled() {
            return Ok(Closed {
                ribs,
                loose: Vec::new(),
                stats,
                solves,
                stopped: true,
            });
        }
        let (s, design, kept_idx, _) = embed_design(input.s0, &ribs, &[]);
        if kept_idx.len() < ribs.len() {
            ribs = kept_idx.iter().map(|&i| ribs[i].clone()).collect();
            continue;
        }
        let held = held_flags(&resolve_holds(&s, &req.holds), s.pos.len());
        let ends = rib_ends(&s, &held, &design);
        if first {
            stats.before = ends
                .iter()
                .flatten()
                .filter(|e| **e == RibEndKind::Free)
                .count();
            first = false;
        }
        let next = ends.iter().enumerate().find_map(|(i, e)| {
            (0..2).find_map(|end| {
                (e[end] == RibEndKind::Free
                    && !kept.iter().any(|k| k.0 == design[i].id && k.1 == end))
                .then_some((i, end))
            })
        });
        let Some((i, end)) = next else { break };
        if rounds > 8 * (stats.before + ribs.len()) + 8 {
            break;
        }
        let d = &design[i];
        let v = end_vertex(d, end);
        let p = s.pos[v as usize];
        let n = d.chain.len();
        let prev = if end == 0 { d.chain[1] } else { d.chain[n - 2] };
        let near_block = s.vert_tris[v as usize]
            .iter()
            .any(|&t| input.blocked[s.parent[t as usize] as usize]);
        // The two continuations, traced on the input surface.
        let mut lines: Vec<Vec<[f64; 3]>> = Vec::new();
        if let Some(dir) = normalize(sub(p, s.pos[prev as usize])) {
            let (t0, _) = input.s0.locate(p);
            let tracer = input.tracer;
            let (straight, _) = tracer.straight_to(t0, p, dir, tracer.max_length);
            if straight.len() >= 2 {
                lines.push(straight);
            }
            if !input.blocked[t0 as usize] {
                let (follow, _) = tracer.follow(t0, p, dir);
                if follow.len() >= 2 {
                    lines.push(follow);
                }
            }
        }
        let (s2, design2, kept2, ext) = embed_design(input.s0, &ribs, &lines);
        if kept2.len() < ribs.len() {
            kept.push((design[i].id, end, LooseEndReason::NoRibZone));
            continue;
        }
        let held2 = held_flags(&resolve_holds(&s2, &req.holds), s2.pos.len());
        let boundary2 = s2.boundary_flags();
        let anchored = |dz: &[DRib], j: usize, w: u32| {
            boundary2[w as usize]
                || held2[w as usize]
                || dz
                    .iter()
                    .enumerate()
                    .any(|(k, o)| k != j && o.chain.contains(&w))
        };
        let d2 = &design2[i];
        let v2 = end_vertex(d2, end);
        let mut options: Vec<(Vec<DRib>, bool)> = Vec::new();
        let mut budget_blocked = false;
        for ec in ext.iter().flatten() {
            if ec.first() != Some(&v2) || ec.len() < 2 || d2.chain.contains(&ec[1]) {
                continue;
            }
            let Some(k) = (1..ec.len()).find(|&k| anchored(&design2, i, ec[k])) else {
                continue;
            };
            let caps = edge_caps(&s2, &ec[..=k], input.tri_cap, rules.max_height);
            if caps.iter().any(|&c| c < rules.min_height) {
                continue;
            }
            let (chain, caps) = extended(d2, end, &ec[..=k], &caps);
            if has_repeat(&chain) {
                continue;
            }
            let mut trial = design2.clone();
            trial[i].chain = chain;
            trial[i].caps = caps;
            if let Goal::Budget { volume_mm3 } = req.goal {
                if select::network_volume(&s2.pos, &trial) > volume_mm3 {
                    budget_blocked = true;
                    continue;
                }
            }
            options.push((trial, true));
        }
        // Trimmed back to the last junction.
        let cut = if end == 0 {
            (1..d2.chain.len()).find(|&j| anchored(&design2, i, d2.chain[j]))
        } else {
            (0..d2.chain.len() - 1)
                .rev()
                .find(|&j| anchored(&design2, i, d2.chain[j]))
        };
        if let Some(j) = cut {
            let (chain, caps) = if end == 0 {
                (d2.chain[j..].to_vec(), d2.caps[j..].to_vec())
            } else {
                (d2.chain[..=j].to_vec(), d2.caps[..j].to_vec())
            };
            let length: f64 = chain
                .windows(2)
                .map(|w| norm(sub(s2.pos[w[1] as usize], s2.pos[w[0] as usize])))
                .sum();
            if chain.len() >= 2 && length >= rules.min_length {
                let mut trial = design2.clone();
                trial[i].chain = chain;
                trial[i].caps = caps;
                options.push((trial, false));
            }
        }
        let mut dropped = design2.clone();
        let gone = dropped.remove(i).id;
        let mut designs: Vec<Vec<DRib>> = options.iter().map(|o| o.0.clone()).collect();
        designs.push(dropped.clone());
        let evals = solve_all(input, &s2, &designs, mix)?;
        solves += designs.len();
        let c_drop = evals.last().expect("the dropped design").compliance;
        let mut best: Option<(f64, usize)> = None;
        for (q, (trial, _)) in options.iter().enumerate() {
            let vol = trial[i].volume(&s2.pos);
            let ratio = if vol > 0.0 {
                (c_drop - evals[q].compliance) / vol
            } else {
                f64::NEG_INFINITY
            };
            if ratio >= floor && ratio > 0.0 && best.is_none_or(|b| ratio > b.0) {
                best = Some((ratio, q));
            }
        }
        if let Some((_, q)) = best {
            let (trial, is_extension) = &options[q];
            if *is_extension {
                stats.extended += 1;
            } else {
                stats.trimmed += 1;
            }
            rep.rib(
                RibChange::Changed,
                Some(&trial[i]),
                trial[i].id,
                &s2.pos,
                trial,
                &evals[q],
                c0,
            );
            ribs = trial.iter().map(|d| as_grib(&s2, d)).collect();
            continue;
        }
        if near_block {
            kept.push((design[i].id, end, LooseEndReason::NoRibZone));
            continue;
        }
        if budget_blocked {
            kept.push((design[i].id, end, LooseEndReason::Budget));
            continue;
        }
        stats.dropped += 1;
        let last = evals.last().expect("the dropped design");
        rep.rib(RibChange::Removed, None, gone, &s2.pos, &dropped, last, c0);
        ribs = dropped.iter().map(|d| as_grib(&s2, d)).collect();
    }
    // What is left loose, with its reason.
    let (s, design, kept_idx, _) = embed_design(input.s0, &ribs, &[]);
    let held = held_flags(&resolve_holds(&s, &req.holds), s.pos.len());
    let mut loose = Vec::new();
    for (k, e) in rib_ends(&s, &held, &design).iter().enumerate() {
        for end in 0..2 {
            if e[end] == RibEndKind::Free {
                let reason = kept
                    .iter()
                    .find(|x| x.0 == design[k].id && x.1 == end)
                    .map_or(LooseEndReason::NoRibZone, |x| x.2);
                loose.push((kept_idx[k], end, reason));
            }
        }
    }
    stats.after = loose.len();
    Ok(Closed {
        ribs,
        loose,
        stats,
        solves,
        stopped: false,
    })
}
