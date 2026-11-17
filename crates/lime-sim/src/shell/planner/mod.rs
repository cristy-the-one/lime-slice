//! The rib planner (docs/plan-auto-ribs.md §7.3, step 3): given a wall,
//! where should ribs go, and how tall, to reach a goal with the least rib
//! material?
//!
//! It re-implements the published method, from the papers, on the shell
//! solver of [`super`]:
//!
//! 1. **Solve the bare wall** under each load case ([`ShellModel`]).
//! 2. **Direction field** ([`field`]): principal bending-moment directions
//!    (membrane-force directions where membrane energy dominates), combined
//!    over cases weighted by strain energy, smoothed as a cross field with
//!    Li et al.'s smoothness/alignment blend (α = 0.8), with low-confidence
//!    zones marked.
//! 3. **Candidates** ([`trace`]): evenly spaced streamlines along both
//!    directions, traced across triangles, seeded where strain energy
//!    density is highest (Tam & Mueller 2015), simplified, short ones
//!    dropped. Each loose end also gets a straight extension stub.
//! 4. **Embedding** ([`surface`]): every candidate and stub is cut into the
//!    mesh at once, so each is a chain of mesh edges that follows the line
//!    (no staircase), and the mesh stays fixed through the selection.
//! 5. **Selection** ([`select`]): greedy with exact re-solves. Each round
//!    ranks the remaining candidates by a first-order estimate (the energy
//!    the rib would take in the current solution) and solves the best
//!    [`PlannerOptions::shortlist`] exactly; the one with the largest
//!    compliance drop per added volume (Li et al.'s score per volume) is
//!    added. Then loose ends are extended to the boundary, a hold or
//!    another rib; ribs that meet end to end are joined; ribs the goal does
//!    not need are pruned, weakest first; and heights are lowered where the
//!    goal allows, most volume saved per stiffness lost first.
//! 6. **Baselines** ([`baseline`]): the wall thickened evenly, and an even
//!    orthogonal grid of the same ribs, each searched to the plan's
//!    compliance with the same solver, material, holds and loads.
//!
//! Everything is deterministic: no hash-map iteration, ties broken by
//! index, Gauss–Seidel in index order.
//!
//! Units: mm, N, MPa. Compliance is the work of the loads, N·mm, summed
//! over the load cases.

mod baseline;
mod field;
mod profile;
mod select;
mod surface;
mod trace;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use rayon::prelude::*;

use crate::error::SimError;
use crate::units::{dot, norm, sub};

use super::{
    IsotropicShell, LoadCase, Rib, RibSection, RibSide, ShellHold, ShellLoad, ShellMesh,
    ShellModel, ShellOptions,
};

pub use profile::{choose_profile, FlangeShape, Process, ProfileRules, RibProfile};
pub use trace::Family;

/// The default load when none is given: 1 kPa on every triangle, along
/// its normal. Only ratios matter for planning.
pub const DEFAULT_PRESSURE: f64 = 0.001;

/// [`Goal::Balanced`] stops adding ribs, and drops material, once the next
/// rib's compliance drop per added volume falls under this share of the
/// first rib's. A quarter: past it, each further gram buys less than a
/// quarter of what the first gram bought. It is the middle of the
/// "lightest … stiffest" slider; the ends would be about 0.6 and 0.05.
pub const BALANCED_FLOOR: f64 = 0.25;

/// The gain floor under a target or a budget: a rib worth under 2 % of the
/// first rib's gain per volume is not added (the target is then reported
/// as not met).
pub const TARGET_FLOOR: f64 = 0.02;

/// Where the wall is held.
#[derive(Clone, Debug, PartialEq)]
pub enum Holds {
    /// Every boundary vertex clamped, hole rims included. The default.
    AllBoundaryClamped,
    /// Only the longest boundary loop clamped; holes are free.
    OuterBoundaryClamped,
    /// Holds on vertices of the input mesh. A vertex the planner makes on
    /// an edge between two vertices held the same way is held that way.
    Given(Vec<ShellHold>),
}

/// What a zone does to ribs.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ZoneMode {
    /// No rib stands in it: traces and extensions stop at its border (a
    /// rib may end there, never cross).
    NoRibs,
    /// Ribs may cross it, no taller than this (mm) along the stretch
    /// inside it; the rest of the rib keeps its height. Under the least
    /// rib height it acts as [`ZoneMode::NoRibs`].
    MaxHeight(f64),
}

/// A user-defined region of the wall. The caller turns boxes, spheres,
/// painted patches and picked faces into triangles of the input mesh.
#[derive(Clone, Debug, PartialEq)]
pub struct Zone {
    pub triangles: Vec<u32>,
    pub mode: ZoneMode,
    /// The zone also covers every triangle within this distance (mm) of
    /// it (a corner or the centroid within it of one of its vertices).
    pub margin: f64,
}
/// What a rib may be.
#[derive(Clone, Debug, PartialEq)]
pub struct RibRules {
    /// Rib width, mm: the top of a straight or drafted rib, a tee's web.
    pub width: f64,
    /// Greatest rib height above the wall's face, mm.
    pub max_height: f64,
    /// Lowest height the sizing pass goes to, mm.
    pub min_height: f64,
    /// Per input vertex, the room above the face (to whatever faces the
    /// wall), mm: a rib is no taller than the least along it, and none
    /// stands where it is under `min_height`.
    pub clearance: Option<Vec<f64>>,
    /// Least distance between parallel ribs, mm: the candidate spacing.
    pub min_spacing: f64,
    /// Shortest rib, mm.
    pub min_length: f64,
    /// Which face ribs stand on.
    pub side: RibSide,
    /// The cross-section shape ([`RibProfile`]; [`choose_profile`] picks
    /// one by process and print pose).
    pub profile: RibProfile,
    /// How far a loose rib end may be extended to reach the boundary, a
    /// hold or another rib, mm. Default: twice `min_spacing`.
    pub extend_limit: Option<f64>,
}

impl Default for RibRules {
    fn default() -> Self {
        Self {
            width: 1.2,
            max_height: 6.0,
            min_height: 1.0,
            clearance: None,
            min_spacing: 15.0,
            min_length: 10.0,
            side: RibSide::Positive,
            profile: RibProfile::Rectangular,
            extend_limit: None,
        }
    }
}

/// What the plan must reach. One of them.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Goal {
    /// Bare compliance over ribbed compliance at least this.
    Stiffer(f64),
    /// The largest displacement (over all cases) at most this, mm.
    MaxDeflection(f64),
    /// The stiffest plan within this much rib material, mm³.
    Budget { volume_mm3: f64 },
    /// Keep adding while a rib pays: see [`BALANCED_FLOOR`].
    Balanced,
}

/// Tuning, with defaults that need no changing.
#[derive(Clone, Debug, PartialEq)]
pub struct PlannerOptions {
    /// Candidates solved exactly per greedy round, best first by the
    /// first-order estimate; 0 solves every candidate (exhaustive).
    pub shortlist: usize,
    /// Douglas–Peucker tolerance for traced lines, mm.
    pub simplify_tolerance: f64,
    /// Smoothness weight of the direction field (Li et al.: 0.8).
    pub field_alpha: f64,
    /// Shell models solving side by side, each on one thread; 0 picks the
    /// cores, at most 8. The plan does not depend on it.
    pub workers: usize,
    /// Compute the thickening and even-grid comparisons. The planner's
    /// report always carries them; turn off only to time the plan alone.
    pub baselines: bool,
}

/// Exactly solved candidates per round: one batch for eight models. The
/// test `the_shortlist_finds_the_same_ribs_as_exhaustive_scoring` checks
/// that even four finds the same ribs as solving all of them, and so did
/// the 600 × 120 panel at 20k triangles (4, 8, 16 and all gave the same
/// 14 ribs; release wall time 16.7, 19.2, 29.1 and 83.8 s on eight
/// models). Eight keeps a margin for walls where the estimate ranks less
/// well, for about 15 % more time.
pub const SHORTLIST: usize = 8;

impl Default for PlannerOptions {
    fn default() -> Self {
        Self {
            shortlist: SHORTLIST,
            simplify_tolerance: 0.2,
            field_alpha: field::ALPHA,
            workers: 0,
            baselines: true,
        }
    }
}

#[derive(Clone, Debug)]
pub struct RibPlanRequest {
    /// The wall's mid-surface, thickness per vertex.
    pub mesh: ShellMesh,
    pub material: IsotropicShell,
    pub holds: Holds,
    /// Load cases on the input mesh; none means [`DEFAULT_PRESSURE`] on
    /// every triangle. Several are combined by summed compliance.
    pub load_cases: Vec<LoadCase>,
    /// User-defined zones: no ribs, or ribs no taller than a cap.
    pub zones: Vec<Zone>,
    /// Keep this far (mm) from the rim of every hole in the wall (each
    /// boundary loop but the longest); `None` lets ribs run to the rims.
    pub hole_rim_margin: Option<f64>,
    pub rules: RibRules,
    pub goal: Goal,
    pub options: PlannerOptions,
}

impl RibPlanRequest {
    /// A request with every default: held all round, even pressure,
    /// [`Goal::Balanced`].
    pub fn new(mesh: ShellMesh, material: IsotropicShell) -> Self {
        Self {
            mesh,
            material,
            holds: Holds::AllBoundaryClamped,
            load_cases: Vec::new(),
            zones: Vec::new(),
            hole_rim_margin: Some(3.0),
            rules: RibRules::default(),
            goal: Goal::Balanced,
            options: PlannerOptions::default(),
        }
    }
}

/// What a rib end meets.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RibEndKind {
    Boundary,
    Hold,
    Rib,
    Free,
}

#[derive(Clone, Debug)]
pub struct PlannedRib {
    /// Points on the wall's mid-surface, in order.
    pub points: Vec<[f64; 3]>,
    /// The same points as vertices of [`RibPlan::mesh`].
    pub vertices: Vec<u32>,
    pub width: f64,
    /// The tallest stretch, mm.
    pub height: f64,
    /// Height of each stretch between consecutive points, mm: `height`,
    /// or lower where a height-capped zone or the clearance says so.
    pub heights: Vec<f64>,
    pub profile: RibProfile,
    /// The section each stretch is built with, as `heights`: the profile's
    /// at that height (a tee only where it was limited, or straight where a
    /// stretch is too low for its root and flange).
    pub sections: Vec<RibSection>,
    pub side: RibSide,
    pub ends: [RibEndKind; 2],
    pub family: Family,
    pub length_mm: f64,
    /// Section area × length per stretch, before any overlap with other
    /// ribs.
    pub volume_mm3: f64,
    /// The compliance drop when it was added, as a share of the bare
    /// compliance.
    pub gain: f64,
    /// Its share of the ribbed design's strain energy.
    pub energy_share: f64,
}

/// Compliance (N·mm, summed over cases) and largest displacement (mm,
/// over cases).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Response {
    pub compliance: f64,
    pub max_deflection: f64,
}

/// The wall thickened evenly to the plan's compliance.
#[derive(Clone, Copy, Debug)]
pub struct ThickeningBaseline {
    pub added_thickness_mm: f64,
    pub added_volume_mm3: f64,
    pub compliance: f64,
    pub solves: usize,
}

/// An even orthogonal grid of the plan's rib section, aligned to the
/// mesh's two longest bounding axes, at the pitch that reaches the plan's
/// compliance.
#[derive(Clone, Copy, Debug)]
pub struct GridBaseline {
    /// Whether any grid down to `min_spacing` pitch reaches it.
    pub reached: bool,
    /// The coarsest grid that reaches it (or the densest tried).
    pub pitch_mm: f64,
    pub lines: [usize; 2],
    pub grid_volume_mm3: f64,
    pub compliance: f64,
    /// The volume at exactly the plan's compliance, interpolated (in log
    /// compliance) between the grids either side of it. `None` when
    /// unreached.
    pub volume_mm3: Option<f64>,
    pub solves: usize,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct PlanStats {
    pub candidates: usize,
    /// Candidates whose embedded chain survived (length, clearance).
    pub embedded_candidates: usize,
    pub input_triangles: usize,
    pub embedded_triangles: usize,
    /// Factorisations for the plan itself (bare solves included), and for
    /// the two baselines.
    pub solves: usize,
    pub baseline_solves: usize,
    pub seconds: PlanSeconds,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct PlanSeconds {
    pub bare: f64,
    pub field: f64,
    pub trace: f64,
    pub embed: f64,
    pub select: f64,
    pub connect: f64,
    pub prune: f64,
    pub size: f64,
    pub baselines: f64,
    /// Inside the solver, over every plan solve (rib rebuild, ordering,
    /// factor, solve, recovery).
    pub solver: f64,
    pub total: f64,
}

#[derive(Clone, Debug)]
pub struct RibPlan {
    pub ribs: Vec<PlannedRib>,
    /// All ribs, overlaps at crossings and junctions counted once.
    pub rib_volume_mm3: f64,
    pub bare: Response,
    pub ribbed: Response,
    /// Bare compliance over ribbed.
    pub stiffness_factor: f64,
    pub goal_met: bool,
    pub thickening: Option<ThickeningBaseline>,
    pub grid: Option<GridBaseline>,
    /// The plan needs no less material than the thickening and no less
    /// than the grid (an unreached grid counts as beaten).
    pub not_better_than_baseline: bool,
    /// Cancelled: the best valid plan when it stopped. Selection may have
    /// been cut short, and the later passes and the baselines left out.
    pub stopped_early: bool,
    /// The mesh the plan was solved on: the input with every candidate cut
    /// in. Rib vertices index it.
    pub mesh: ShellMesh,
    pub stats: PlanStats,
}

/// A stage of planning, in order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlanStage {
    BareSolve,
    Field,
    Trace,
    Embed,
    Select,
    Connect,
    Prune,
    Size,
    Baselines,
    Done,
}

impl PlanStage {
    /// The share of the whole run each stage starts at and ends at, from
    /// the measured split of a 20k-triangle plan (selection and the
    /// solves after it are most of it).
    fn span(self) -> (f64, f64) {
        match self {
            Self::BareSolve => (0.0, 0.02),
            Self::Field => (0.02, 0.03),
            Self::Trace => (0.03, 0.05),
            Self::Embed => (0.05, 0.08),
            Self::Select => (0.08, 0.65),
            Self::Connect => (0.65, 0.68),
            Self::Prune => (0.68, 0.78),
            Self::Size => (0.78, 0.88),
            Self::Baselines => (0.88, 1.0),
            Self::Done => (1.0, 1.0),
        }
    }
}

/// What happened to a rib.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RibChange {
    Added,
    /// Extended, joined or lowered.
    Changed,
    Removed,
}

/// A rib as it now stands, and the design's totals after the change.
#[derive(Clone, Debug)]
pub struct RibEvent {
    pub change: RibChange,
    /// Stable for the rib through the run (its candidate's index).
    pub id: usize,
    /// Empty when removed.
    pub points: Vec<[f64; 3]>,
    /// Per stretch between points, mm.
    pub heights: Vec<f64>,
    pub ribs: usize,
    pub rib_volume_mm3: f64,
    pub compliance: f64,
    pub stiffness_factor: f64,
    pub fraction: f64,
}

#[derive(Clone, Debug)]
pub enum PlanEvent {
    /// Entering or moving through a stage; `fraction` of the whole run,
    /// never going back.
    Stage {
        stage: PlanStage,
        fraction: f64,
    },
    Rib(RibEvent),
}

/// Live progress and cancel for [`plan_ribs_with`]. Events come one at a
/// time, in order, mostly on the calling thread (the two baselines run
/// side by side and report from theirs). A channel works as a sink:
/// `let sink = |e: &PlanEvent| { let _ = tx.send(e.clone()); };`.
#[derive(Clone, Copy, Default)]
pub struct PlanControl<'a> {
    pub progress: Option<&'a (dyn Fn(&PlanEvent) + Sync)>,
    /// Set it to stop: the run returns the best valid plan so far, marked
    /// [`RibPlan::stopped_early`], within about one batch of solves.
    pub cancel: Option<&'a AtomicBool>,
}

/// Sends events with a fraction that never goes back, one at a time.
pub(crate) struct Reporter<'a> {
    ctl: PlanControl<'a>,
    last: Mutex<f64>,
}

impl Reporter<'_> {
    pub fn cancelled(&self) -> bool {
        self.ctl.cancel.is_some_and(|c| c.load(Ordering::Relaxed))
    }

    pub fn stage(&self, stage: PlanStage, within: f64) {
        let mut last = self.last.lock().unwrap_or_else(|e| e.into_inner());
        let (a, b) = stage.span();
        let fraction = (a + (b - a) * within.clamp(0.0, 1.0)).max(*last);
        *last = fraction;
        if let Some(p) = self.ctl.progress {
            p(&PlanEvent::Stage { stage, fraction });
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn rib(
        &self,
        change: RibChange,
        rib: Option<&select::DRib>,
        id: usize,
        pos: &[[f64; 3]],
        design: &[select::DRib],
        cur: &select::Eval,
        c0: f64,
    ) {
        let Some(p) = self.ctl.progress else { return };
        let last = self.last.lock().unwrap_or_else(|e| e.into_inner());
        p(&PlanEvent::Rib(RibEvent {
            change,
            id,
            points: rib.map_or_else(Vec::new, |d| {
                d.chain.iter().map(|&v| pos[v as usize]).collect()
            }),
            heights: rib.map_or_else(Vec::new, select::DRib::heights),
            ribs: design.len(),
            rib_volume_mm3: select::network_volume(pos, design),
            compliance: cur.compliance,
            stiffness_factor: c0 / cur.compliance,
            fraction: *last,
        }));
    }
}

/// Plan ribs on a wall.
pub fn plan_ribs(req: &RibPlanRequest) -> Result<RibPlan, SimError> {
    plan_ribs_with(req, PlanControl::default())
}

/// Plan ribs on a wall, with live progress and a cancel flag. Once a
/// first rib is chosen there is always a valid plan to return: a cancel
/// gives back the design as it stood after its last complete step, never
/// an error.
pub fn plan_ribs_with(req: &RibPlanRequest, control: PlanControl) -> Result<RibPlan, SimError> {
    let rep = Reporter {
        ctl: control,
        last: Mutex::new(0.0),
    };
    let started = Instant::now();
    check(req)?;
    let mut stats = PlanStats {
        input_triangles: req.mesh.triangles.len(),
        ..PlanStats::default()
    };
    let rules = &req.rules;
    let s0 = surface::Surface::new(&req.mesh, rules.clearance.as_deref());
    let cases0 = if req.load_cases.is_empty() {
        vec![vec![ShellLoad::Pressure {
            triangles: (0..req.mesh.triangles.len() as u32).collect(),
            pressure: DEFAULT_PRESSURE,
        }]]
    } else {
        req.load_cases.clone()
    };

    // 1. The bare wall.
    let t = Instant::now();
    let holds0 = resolve_holds(&s0, &req.holds);
    let mut model0 = ShellModel::new(
        req.mesh.clone(),
        req.material,
        &holds0,
        ShellOptions::default(),
    )?;
    rep.stage(PlanStage::BareSolve, 0.0);
    // One thread, as every planning model: the answer then does not depend
    // on the machine or the pool.
    model0.set_threads(1);
    let bare0 = model0.solve_cases(&cases0)?;
    stats.solves += 1;
    stats.seconds.bare = t.elapsed().as_secs_f64();
    drop(model0);
    let early = |stats: PlanStats| {
        let bare = Response {
            compliance: bare0.iter().map(|r| r.compliance).sum(),
            max_deflection: bare0.iter().map(|r| r.max_deflection).fold(0.0, f64::max),
        };
        let mut stats = stats;
        stats.seconds.total = started.elapsed().as_secs_f64();
        rep.stage(PlanStage::Done, 1.0);
        RibPlan {
            ribs: Vec::new(),
            rib_volume_mm3: 0.0,
            bare,
            ribbed: bare,
            stiffness_factor: 1.0,
            goal_met: false,
            thickening: None,
            grid: None,
            not_better_than_baseline: false,
            stopped_early: true,
            mesh: req.mesh.clone(),
            stats,
        }
    };
    if rep.cancelled() {
        return Ok(early(stats));
    }

    // 2. The field.
    let t = Instant::now();
    rep.stage(PlanStage::Field, 0.0);
    let field = field::Field::new(&s0, &bare0, req.options.field_alpha);
    let zones = restrictions(&s0, &req.zones, req.hole_rim_margin, rules.min_height);
    let blocked0 = zones.blocked.clone();
    stats.seconds.field = t.elapsed().as_secs_f64();

    // 3. Candidates and their extension stubs.
    if rep.cancelled() {
        return Ok(early(stats));
    }
    let t = Instant::now();
    rep.stage(PlanStage::Trace, 0.0);
    let extend_limit = rules.extend_limit.unwrap_or(2.0 * rules.min_spacing);
    let trace_rules = trace::TraceRules {
        spacing: rules.min_spacing,
        min_length: rules.min_length,
        tolerance: req.options.simplify_tolerance,
        extend_limit,
    };
    let diag = bbox_diagonal(&req.mesh.vertices);
    let tracer = trace::Tracer {
        s: &s0,
        field: &field,
        blocked: &blocked0,
        rules: &trace_rules,
        max_length: 4.0 * diag,
    };
    let candidates = tracer.candidates();
    stats.candidates = candidates.len();
    let stubs: Vec<[Option<Vec<[f64; 3]>>; 2]> = candidates
        .iter()
        .map(|c| {
            [0, 1].map(|end| {
                if c.ends[end] == trace::TraceEnd::Boundary {
                    return None;
                }
                let p = if end == 0 {
                    c.points[0]
                } else {
                    *c.points.last().expect("a line has points")
                };
                let stub =
                    tracer.straight(c.end_tri[end], p, c.end_dir[end], trace_rules.extend_limit);
                (stub.len() >= 2).then_some(stub)
            })
        })
        .collect();
    stats.seconds.trace = t.elapsed().as_secs_f64();

    // 4. Cut every line into one mesh.
    if rep.cancelled() {
        return Ok(early(stats));
    }
    let t = Instant::now();
    rep.stage(PlanStage::Embed, 0.0);
    let mut s1 = s0.clone();
    let ids: Vec<Option<usize>> = candidates
        .iter()
        .map(|c| s1.embed_polyline(&c.points))
        .collect();
    let stub_ids: Vec<[Option<usize>; 2]> = stubs
        .iter()
        .map(|pair| [0, 1].map(|k| pair[k].as_ref().and_then(|pts| s1.embed_polyline(pts))))
        .collect();
    let mut cands = Vec::new();
    for (i, c) in candidates.iter().enumerate() {
        let Some(id) = ids[i] else { continue };
        let chain = s1.chains[id].clone();
        if s1.chain_length(&chain) < rules.min_length {
            continue;
        }
        let caps = edge_caps(&s1, &chain, &zones.cap, rules.max_height);
        if caps.iter().all(|&h| h < rules.min_height) {
            continue;
        }
        let stub = [0, 1].map(|end| {
            let sid = stub_ids[i][end]?;
            let st = s1.chains[sid].clone();
            let at = if end == 0 {
                chain[0]
            } else {
                *chain.last().expect("chain")
            };
            let st_caps = edge_caps(&s1, &st, &zones.cap, rules.max_height);
            (st.first() == Some(&at)).then_some((st, st_caps))
        });
        cands.push(select::CandChain {
            chain,
            caps,
            family: c.family,
            stub,
        });
    }
    stats.embedded_candidates = cands.len();
    let mesh1 = s1.to_mesh();
    stats.embedded_triangles = mesh1.triangles.len();
    let holds1 = resolve_holds(&s1, &req.holds);
    let cases1 = remap_cases(&s1, &cases0, req.mesh.triangles.len());
    stats.seconds.embed = t.elapsed().as_secs_f64();

    // 5. Selection on the cut mesh.
    let held = held_flags(&holds1, s1.pos.len());
    let ctx = select::Ctx {
        pos: s1.pos.clone(),
        thickness: s1.thickness.clone(),
        boundary: s1.boundary_flags(),
        held,
        width: rules.width,
        profile: rules.profile,
        min_height: rules.min_height,
        max_height: rules.max_height,
        goal: req.goal,
        shortlist: req.options.shortlist,
    };
    if rep.cancelled() {
        return Ok(early(stats));
    }
    let workers = match req.options.workers {
        0 => std::thread::available_parallelism()
            .map_or(1, |n| n.get())
            .min(8),
        n => n,
    };
    let models: Vec<ShellModel> = (0..workers)
        .into_par_iter()
        .map(|_| {
            ShellModel::new(
                mesh1.clone(),
                req.material,
                &holds1,
                ShellOptions::default(),
            )
        })
        .collect::<Result<_, _>>()?;
    let mut ev = select::Evaluator::new(models, cases1.clone(), rules.side);
    let outcome = select::run(&mut ev, &ctx, &cands, &rep)?;
    stats.solves += ev.solves;
    stats.seconds.select = outcome.seconds[0];
    stats.seconds.connect = outcome.seconds[1];
    stats.seconds.prune = outcome.seconds[2];
    stats.seconds.size = outcome.seconds[3];
    stats.seconds.solver = ev.seconds;

    let bare = Response {
        compliance: outcome.bare.compliance,
        max_deflection: outcome.bare.max_deflection,
    };
    let ribbed = Response {
        compliance: outcome.current.compliance,
        max_deflection: outcome.current.max_deflection,
    };
    let rib_volume = select::network_volume(&ctx.pos, &outcome.design);
    let total_energy: f64 = outcome.current.strain_energy;
    let mut ribs = Vec::new();
    for (i, d) in outcome.design.iter().enumerate() {
        let points: Vec<[f64; 3]> = d.chain.iter().map(|&v| s1.pos[v as usize]).collect();
        let length = s1.chain_length(&d.chain);
        let ends = [0, 1].map(|end| {
            let v = if end == 0 {
                d.chain[0]
            } else {
                *d.chain.last().expect("chain")
            };
            if ctx.boundary[v as usize] {
                RibEndKind::Boundary
            } else if ctx.held[v as usize] {
                RibEndKind::Hold
            } else if outcome
                .design
                .iter()
                .enumerate()
                .any(|(j, o)| j != i && o.chain.contains(&v))
            {
                RibEndKind::Rib
            } else {
                RibEndKind::Free
            }
        });
        ribs.push(PlannedRib {
            points,
            vertices: d.chain.clone(),
            width: d.width,
            height: d.tallest(),
            heights: d.heights(),
            profile: d.profile,
            sections: d
                .heights()
                .iter()
                .map(|&h| d.profile.section_at(d.width, h))
                .collect(),
            side: rules.side,
            ends,
            family: d.family,
            length_mm: length,
            volume_mm3: d.volume(&ctx.pos),
            gain: d.gain,
            energy_share: if total_energy > 0.0 {
                outcome.current.rib_energy.get(i).copied().unwrap_or(0.0) / total_energy
            } else {
                0.0
            },
        });
    }
    let stiffness_factor = bare.compliance / ribbed.compliance;

    // 6. Baselines.
    let t = Instant::now();
    let (thickening, grid) =
        if req.options.baselines && !ribs.is_empty() && !outcome.stopped && !rep.cancelled() {
            rep.stage(PlanStage::Baselines, 0.0);
            let grid_input = baseline::GridInput {
                surface: &s0,
                blocked: &blocked0,
                tri_cap: &zones.cap,
                rules,
                material: req.material,
                holds: &req.holds,
                cases: &cases0,
                target: ribbed.compliance,
                tolerance: req.options.simplify_tolerance,
                rep: &rep,
            };
            // The two searches are independent: run them side by side.
            let (th, gr) = rayon::join(
                || {
                    baseline::thickening(
                        &mesh1,
                        req.material,
                        &holds1,
                        &cases1,
                        bare.compliance,
                        ribbed.compliance,
                        &rep,
                    )
                },
                || baseline::grid(&grid_input),
            );
            match (th?, gr?) {
                (Some(th), Some(gr)) => {
                    stats.baseline_solves = th.solves + gr.solves;
                    (Some(th), Some(gr))
                }
                _ => (None, None),
            }
        } else {
            (None, None)
        };
    let stopped_early =
        outcome.stopped || (req.options.baselines && !ribs.is_empty() && thickening.is_none());
    stats.seconds.baselines = t.elapsed().as_secs_f64();
    let not_better = match (&thickening, &grid) {
        (Some(th), Some(gr)) => {
            let beats_thick = rib_volume < th.added_volume_mm3;
            let beats_grid = gr.volume_mm3.is_none_or(|v| rib_volume < v);
            !beats_thick && !beats_grid
        }
        _ => false,
    };
    stats.seconds.total = started.elapsed().as_secs_f64();
    rep.stage(PlanStage::Done, 1.0);
    Ok(RibPlan {
        ribs,
        rib_volume_mm3: rib_volume,
        bare,
        ribbed,
        stiffness_factor,
        goal_met: outcome.goal_met,
        thickening,
        grid,
        not_better_than_baseline: not_better,
        stopped_early,
        mesh: mesh1,
        stats,
    })
}

fn check(req: &RibPlanRequest) -> Result<(), SimError> {
    let r = &req.rules;
    let positive = |x: f64| x.is_finite() && x > 0.0;
    if !(positive(r.width) && positive(r.max_height) && positive(r.min_height)) {
        return Err(SimError::new("Rib width and heights must be above zero."));
    }
    if r.min_height > r.max_height {
        return Err(SimError::new("The least rib height is above the greatest."));
    }
    // In full at the greatest height; lower stretches may fall back to
    // plain (see `profile`).
    r.profile.check(r.width, r.max_height)?;
    if !positive(r.min_spacing) || !r.min_length.is_finite() || r.min_length < 0.0 {
        return Err(SimError::new(
            "Rib spacing must be above zero and length not below.",
        ));
    }
    if r.extend_limit.is_some_and(|x| !(x.is_finite() && x >= 0.0)) {
        return Err(SimError::new("The extension limit must not be below zero."));
    }
    if let Some(c) = &r.clearance {
        if c.len() != req.mesh.vertices.len() {
            return Err(SimError::new(
                "The clearance map needs one value per vertex.",
            ));
        }
    }
    for z in &req.zones {
        if !(z.margin.is_finite() && z.margin >= 0.0) {
            return Err(SimError::new("A zone's margin must not be below zero."));
        }
        if z.triangles
            .iter()
            .any(|&t| t as usize >= req.mesh.triangles.len())
        {
            return Err(SimError::new(
                "A zone names a triangle the mesh does not have.",
            ));
        }
        if let ZoneMode::MaxHeight(h) = z.mode {
            if !(h.is_finite() && h >= 0.0) {
                return Err(SimError::new("A zone's height cap must not be below zero."));
            }
        }
    }
    if req
        .hole_rim_margin
        .is_some_and(|m| !(m.is_finite() && m >= 0.0))
    {
        return Err(SimError::new("The hole rim margin must not be below zero."));
    }
    match req.goal {
        Goal::Stiffer(f) if !(f.is_finite() && f >= 1.0) => {
            Err(SimError::new("A stiffness goal must be 1 or more."))
        }
        Goal::MaxDeflection(d) if !positive(d) => {
            Err(SimError::new("A deflection goal must be above zero."))
        }
        Goal::Budget { volume_mm3 } if !(volume_mm3.is_finite() && volume_mm3 >= 0.0) => {
            Err(SimError::new("A budget must not be below zero."))
        }
        _ => Ok(()),
    }
}

fn bbox_diagonal(points: &[[f64; 3]]) -> f64 {
    let mut lo = [f64::INFINITY; 3];
    let mut hi = [f64::NEG_INFINITY; 3];
    for p in points {
        for k in 0..3 {
            lo[k] = lo[k].min(p[k]);
            hi[k] = hi[k].max(p[k]);
        }
    }
    norm(sub(hi, lo))
}

/// Holds for `s`, which may be the input surface or one cut from it.
fn resolve_holds(s: &surface::Surface, holds: &Holds) -> Vec<ShellHold> {
    let n = s.pos.len();
    match holds {
        Holds::AllBoundaryClamped => s
            .boundary_flags()
            .iter()
            .enumerate()
            .filter(|(_, b)| **b)
            .map(|(i, _)| ShellHold::clamped(i as u32))
            .collect(),
        Holds::OuterBoundaryClamped => {
            let loops = s.boundary_loops();
            let outer = outer_loop(s, &loops);
            let mut out: Vec<ShellHold> = outer
                .map(|l| loops[l].iter().map(|&v| ShellHold::clamped(v)).collect())
                .unwrap_or_default();
            out.sort_by_key(|h| h.node);
            out
        }
        Holds::Given(list) => {
            let mut dofs: Vec<Option<[Option<f64>; 6]>> = vec![None; n];
            for h in list {
                if (h.node as usize) < n {
                    let slot = dofs[h.node as usize].get_or_insert([None; 6]);
                    for k in 0..6 {
                        if h.dofs[k].is_some() {
                            slot[k] = h.dofs[k];
                        }
                    }
                }
            }
            for v in 0..n {
                if let surface::Origin::Edge(a, b, _) = s.origin[v] {
                    if let (Some(da), Some(db)) = (dofs[a as usize], dofs[b as usize]) {
                        if da == db {
                            dofs[v] = Some(da);
                        }
                    }
                }
            }
            dofs.iter()
                .enumerate()
                .filter_map(|(v, d)| {
                    d.map(|d| ShellHold {
                        node: v as u32,
                        dofs: d,
                    })
                })
                .collect()
        }
    }
}

/// The longest boundary loop, by length.
fn outer_loop(s: &surface::Surface, loops: &[Vec<u32>]) -> Option<usize> {
    let len = |l: &Vec<u32>| -> f64 {
        (0..l.len())
            .map(|i| {
                norm(sub(
                    s.pos[l[(i + 1) % l.len()] as usize],
                    s.pos[l[i] as usize],
                ))
            })
            .sum()
    };
    let mut best: Option<(f64, usize)> = None;
    for (i, l) in loops.iter().enumerate() {
        let x = len(l);
        if best.is_none_or(|b| x > b.0) {
            best = Some((x, i));
        }
    }
    best.map(|b| b.1)
}

fn held_flags(holds: &[ShellHold], n: usize) -> Vec<bool> {
    let mut f = vec![false; n];
    for h in holds {
        if h.dofs[..3].iter().all(Option::is_some) {
            f[h.node as usize] = true;
        }
    }
    f
}

/// Loads on the input mesh, carried to the triangles cut from it.
fn remap_cases(s: &surface::Surface, cases: &[LoadCase], input_triangles: usize) -> Vec<LoadCase> {
    let mut children: Vec<Vec<u32>> = vec![Vec::new(); input_triangles];
    for (t, &p) in s.parent.iter().enumerate() {
        children[p as usize].push(t as u32);
    }
    let map = |list: &[u32]| -> Vec<u32> {
        let mut out: Vec<u32> = list
            .iter()
            .flat_map(|&t| children.get(t as usize).cloned().unwrap_or_default())
            .collect();
        out.sort_unstable();
        out
    };
    cases
        .iter()
        .map(|case| {
            case.iter()
                .map(|load| match load {
                    ShellLoad::Pressure {
                        triangles,
                        pressure,
                    } => ShellLoad::Pressure {
                        triangles: map(triangles),
                        pressure: *pressure,
                    },
                    ShellLoad::SpreadForce { triangles, force } => ShellLoad::SpreadForce {
                        triangles: map(triangles),
                        force: *force,
                    },
                    other => other.clone(),
                })
                .collect()
        })
        .collect()
}

/// What the zones and the clearance allow, per input triangle.
pub(crate) struct Restrictions {
    /// No rib may stand here.
    pub blocked: Vec<bool>,
    /// Greatest rib height here (infinite where unlimited).
    pub cap: Vec<f64>,
}

/// The triangles a set of seed triangles covers with a margin: the seeds,
/// and every triangle with a corner or its centroid nearer than `margin`
/// to one of the seeds' vertices.
fn grow(s: &surface::Surface, seeds: &[u32], extra_points: &[[f64; 3]], margin: f64) -> Vec<bool> {
    let nt = s.tris.len();
    let mut out = vec![false; nt];
    let mut points: Vec<[f64; 3]> = extra_points.to_vec();
    for &t in seeds {
        out[t as usize] = true;
        points.extend(s.tris[t as usize].iter().map(|&v| s.pos[v as usize]));
    }
    if margin <= 0.0 || points.is_empty() {
        return out;
    }
    let cell = margin;
    let cell_of = |p: [f64; 3]| p.map(|x| (x / cell).floor() as i64);
    let mut grid: std::collections::HashMap<[i64; 3], Vec<usize>> =
        std::collections::HashMap::new();
    for (i, p) in points.iter().enumerate() {
        grid.entry(cell_of(*p)).or_default().push(i);
    }
    let near = |p: [f64; 3]| {
        let c = cell_of(p);
        for dx in -1..=1 {
            for dy in -1..=1 {
                for dz in -1..=1 {
                    if let Some(list) = grid.get(&[c[0] + dx, c[1] + dy, c[2] + dz]) {
                        if list.iter().any(|&i| norm(sub(points[i], p)) < margin) {
                            return true;
                        }
                    }
                }
            }
        }
        false
    };
    for (t, o) in out.iter_mut().enumerate() {
        if !*o {
            let c = s.corners(t as u32);
            *o = near(s.centroid(t as u32)) || c.iter().any(|&p| near(p));
        }
    }
    out
}

/// Blocked triangles and height caps from the user's zones (each grown by
/// its margin), the holes' rims (grown by `hole_rim_margin`), and the
/// clearance map (a corner under the least rib height blocks).
fn restrictions(
    s: &surface::Surface,
    zones: &[Zone],
    hole_rim_margin: Option<f64>,
    min_height: f64,
) -> Restrictions {
    let nt = s.tris.len();
    let mut blocked = vec![false; nt];
    let mut cap = vec![f64::INFINITY; nt];
    for z in zones {
        let covered = grow(s, &z.triangles, &[], z.margin);
        for t in 0..nt {
            if !covered[t] {
                continue;
            }
            match z.mode {
                ZoneMode::NoRibs => blocked[t] = true,
                ZoneMode::MaxHeight(h) if h < min_height => blocked[t] = true,
                ZoneMode::MaxHeight(h) => cap[t] = cap[t].min(h),
            }
        }
    }
    if let Some(m) = hole_rim_margin {
        let loops = s.boundary_loops();
        let outer = outer_loop(s, &loops);
        let rims: Vec<[f64; 3]> = loops
            .iter()
            .enumerate()
            .filter(|(i, _)| Some(*i) != outer)
            .flat_map(|(_, l)| l.iter().map(|&v| s.pos[v as usize]))
            .collect();
        if !rims.is_empty() {
            let covered = grow(s, &[], &rims, m);
            for t in 0..nt {
                blocked[t] |= covered[t];
            }
        }
    }
    for t in 0..nt {
        if s.tris[t]
            .iter()
            .any(|&v| s.clearance[v as usize] < min_height)
        {
            blocked[t] = true;
        }
    }
    Restrictions { blocked, cap }
}

/// The greatest height of each edge of `chain` on `s` (a surface cut from
/// the input): the rules' greatest height, the clearance at both ends, and
/// the cap of every triangle on the edge (`tri_cap` per input triangle).
pub(crate) fn edge_caps(
    s: &surface::Surface,
    chain: &[u32],
    tri_cap: &[f64],
    max_height: f64,
) -> Vec<f64> {
    chain
        .windows(2)
        .map(|w| {
            let mut h = max_height
                .min(s.clearance[w[0] as usize])
                .min(s.clearance[w[1] as usize]);
            for &t in s.edge_triangles(w[0], w[1]) {
                h = h.min(tri_cap[s.parent[t as usize] as usize]);
            }
            h
        })
        .collect()
}
/// A wall with paths cut in: the mesh and each path as a chain of its
/// vertices (see [`embed_polylines`]).
#[derive(Clone, Debug)]
pub struct Embedding {
    pub mesh: ShellMesh,
    /// One per input path, `None` where nothing of it could be cut in.
    pub chains: Vec<Option<Vec<u32>>>,
    /// The input triangle each triangle was cut from.
    pub parent: Vec<u32>,
}

/// Cut polylines on a wall into its mesh, the planner's way: each becomes
/// a chain of edges along the line (snapped within 10 % of an edge to an
/// existing vertex), crossings share a vertex, and input vertex and
/// triangle indices keep their meaning (new ones come after).
pub fn embed_polylines(mesh: &ShellMesh, paths: &[Vec<[f64; 3]>]) -> Embedding {
    let mut s = surface::Surface::new(mesh, None);
    let ids: Vec<Option<usize>> = paths.iter().map(|p| s.embed_polyline(p)).collect();
    Embedding {
        mesh: s.to_mesh(),
        chains: ids
            .iter()
            .map(|id| id.map(|i| s.chains[i].clone()))
            .collect(),
        parent: s.parent.clone(),
    }
}

/// A chain of vertices as rib edges.
pub fn chain_edges(chain: &[u32]) -> Vec<(u32, u32)> {
    chain.windows(2).map(|w| (w[0], w[1])).collect()
}

/// The vertices on the mesh's boundary.
pub fn boundary_vertices(mesh: &ShellMesh) -> Vec<u32> {
    surface::Surface::new(mesh, None)
        .boundary_flags()
        .iter()
        .enumerate()
        .filter(|(_, b)| **b)
        .map(|(i, _)| i as u32)
        .collect()
}

/// The volume of a rib network the planner's way: width × height ×
/// length per rib, less the overlap where ribs cross or meet (see
/// [`select::network_volume`]). Each rib's edges must form one chain.
pub fn rib_network_volume(mesh: &ShellMesh, ribs: &[Rib]) -> f64 {
    let design: Vec<select::DRib> = ribs
        .iter()
        .map(|r| {
            let mut chain = vec![r.edges[0].0];
            for &(a, b) in &r.edges {
                let last = *chain.last().expect("chain");
                chain.push(if a == last { b } else { a });
            }
            let (profile, width) = RibProfile::of_section(r.section);
            select::DRib::fixed(chain, r.height, width, profile)
        })
        .collect();
    select::network_volume(&mesh.vertices, &design)
}

/// The angle in degrees between a direction and the line along `axis`.
pub fn angle_to_axis(d: [f64; 3], axis: [f64; 3]) -> f64 {
    let c = (dot(d, axis) / (norm(d) * norm(axis))).abs().min(1.0);
    c.acos().to_degrees()
}
