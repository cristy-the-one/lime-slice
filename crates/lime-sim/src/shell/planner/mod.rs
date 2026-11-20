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
//!    over cases by strain energy divided by each case's bare compliance,
//!    smoothed as a cross field with
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
//!    drop in the weighted compliance (each case divided by its own bare
//!    compliance) per added volume (Li et al.'s score per volume) is
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
//! Units: mm, N, MPa. Compliance is the work of the loads, N·mm. Several
//! cases are scored as `sum w_i C_i / C_i0` (each `C_i0` the bare wall on
//! the same mesh), or, in [`LoadCombine::Worst`], by the p-norm of those
//! scaled compliances. A single case is the compliance itself, in either
//! mode. The reported stiffness factor is the combined number, and in
//! worst-case mode that number is `min_i C_i0 / C_i`.

mod baseline;
mod field;
mod frequency;
mod loose;
mod profile;
mod select;
mod surface;
mod trace;
mod vents;

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
pub use vents::{vent_pockets, BorderKind, BorderRun, EndKind, RibRun, VentPocket, VentPockets, Venting, PART_CUPS, RESIN_VENT_MM};

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
    /// How far the first pass over loose rib ends (before pruning) may
    /// extend one to reach the boundary, a hold or another rib, mm. Default:
    /// twice `min_spacing`. The closing pass after pruning has no limit
    /// (see [`PlannerOptions::close_loose_ends`]).
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

/// How several load cases become the one number the planner minimises.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum LoadCombine {
    /// `sum w_i C_i / C_i0`. Empty weights are all 1.
    #[default]
    Weighted,
    /// Minimise `(sum_i (s_i C_i)^p)^(1/p)` with [`WORST_P`] unless
    /// [`PlannerOptions::worst_p`] says otherwise. `s_i` normalises each
    /// case by its bare compliance, at unit weight. The reported factor
    /// is still `min_i C_i0 / C_i`, so [`Goal::Stiffer`] means every case
    /// reaches it. Load-case weights are refused.
    Worst,
}

/// Default exponent of [`LoadCombine::Worst`]. A hard minimum stalled the
/// greedy loop; p = 8 keeps a gradient on the second-worst case.
pub const WORST_P: f64 = 8.0;

/// One greedy step in [`LoadCombine::Worst`]: which case limited the
/// objective, and the worst stiffness factor, on the selection mesh.
#[derive(Clone, Copy, Debug)]
pub struct WorstRound {
    pub limiting_case: usize,
    /// `min_i C_i0 / C_i` after this rib (1 before any rib).
    pub min_factor: f64,
}

/// What the plan must reach. One of them.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Goal {
    /// Combined stiffness at least this. One case: bare over ribbed.
    /// Weighted: `(sum w_i) / (sum w_i C_i / C_i0)`. Worst: every case,
    /// `min_i C_i0 / C_i`.
    Stiffer(f64),
    /// The largest displacement (over all cases) at most this, mm.
    MaxDeflection(f64),
    /// The stiffest plan within this much rib material, mm³.
    Budget { volume_mm3: f64 },
    /// Keep adding while a rib pays: see [`BALANCED_FLOOR`].
    Balanced,
    /// The lowest natural frequency, ribbed over bare, at least this.
    /// A plan has one goal: this does not carry a stiffness target or a
    /// budget, and a request without it plans as a stiffness goal.
    Frequency { factor: f64 },
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
    /// After pruning, extend every rib end left in mid-wall to the
    /// boundary, a hold or another rib, else trim the rib back to its last
    /// junction or drop it (see [`RibPlan::loose_ends`]). Turn off only to
    /// measure what it costs.
    pub close_loose_ends: bool,
    /// Exponent of [`LoadCombine::Worst`]'s p-norm. A weighted or one-case
    /// plan does not read it.
    pub worst_p: f64,
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
            close_loose_ends: true,
            worst_p: WORST_P,
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
    /// every triangle. Several are scored as `sum w_i C_i / C_i0`.
    pub load_cases: Vec<LoadCase>,
    /// One weight per load case. Empty means every case weighs 1. A single
    /// case then scores exactly as its compliance. [`LoadCombine::Worst`]
    /// refuses a non-empty list.
    pub case_weights: Vec<f64>,
    /// How several cases combine. [`LoadCombine::Weighted`] by default; a
    /// one-case plan does not depend on it.
    pub combine: LoadCombine,
    /// User-defined zones: no ribs, or ribs no taller than a cap.
    pub zones: Vec<Zone>,
    /// Keep this far (mm) from the rim of every hole in the wall (each
    /// boundary loop but the longest); `None` lets ribs run to the rims.
    pub hole_rim_margin: Option<f64>,
    pub rules: RibRules,
    pub goal: Goal,
    pub options: PlannerOptions,
    /// Cut a vent through each pocket the ribs close, when the part is resin.
    /// Filament and moulded leave this false, and the plan is unchanged.
    pub vent: bool,
    /// Plate frame, from the platform toward the tank. Default +Z, the part as
    /// it sits. A pocket cups when the side the ribs stand on points along this.
    pub build_axis: [f64; 3],
    /// The wall's outer border is a side wall, so it closes a cell. A free
    /// edge, and every hole, stays open. Filament and moulded leave this false.
    /// Ignored when [`RibPlanRequest::borders`] is not empty.
    pub rising_border: bool,
    /// Wall borders in the wall frame. Empty uses [`RibPlanRequest::rising_border`].
    pub borders: Vec<(Vec<[f64; 3]>, vents::BorderKind)>,
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
            case_weights: Vec::new(),
            combine: LoadCombine::Weighted,
            zones: Vec::new(),
            hole_rim_margin: Some(3.0),
            rules: RibRules::default(),
            goal: Goal::Balanced,
            options: PlannerOptions::default(),
            vent: false,
            build_axis: [0.0, 0.0, 1.0],
            rising_border: false,
            borders: Vec::new(),
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
    /// The end of a vent gap. It is not a loose end.
    Gap,
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
    /// The stiffness factor selection saw on the mesh with every candidate
    /// cut in, before the clean solve the plan reports.
    pub selection_factor: f64,
    /// Selections run again because the clean solve missed the goal.
    pub clean_retries: usize,
    pub loose_ends: LooseEndStats,
    pub seconds: PlanSeconds,
}

/// Loose rib ends (in mid-wall, on no boundary, hold or other rib) in the
/// last selection: before the closing pass, what it did, and after.
#[derive(Clone, Copy, Debug, Default)]
pub struct LooseEndStats {
    pub before: usize,
    pub extended: usize,
    pub trimmed: usize,
    pub dropped: usize,
    pub after: usize,
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
    /// Combined stiffness on [`RibPlan::mesh`]. One case: bare over ribbed.
    /// Weighted: `(sum w_i) / (sum w_i C_i / C_i0)`. Worst: `min_i C_i0 / C_i`.
    pub stiffness_factor: f64,
    /// `C_i0 / C_i` for each load case, on [`RibPlan::mesh`].
    pub case_factors: Vec<f64>,
    /// Peak deflection per load case, `[bare, ribbed]` in mm, in case order.
    /// [`RibPlan::bare`] and [`RibPlan::ribbed`] carry the greatest of these.
    pub case_deflection_mm: Vec<[f64; 2]>,
    /// Greedy rounds when [`RibPlanRequest::combine`] is
    /// [`LoadCombine::Worst`]: the limiting case and the worst factor after
    /// each accepted rib, including the bare wall as round 0. Empty for a
    /// weighted plan, and for one case (that plan is the plain sum).
    pub worst_trace: Vec<WorstRound>,
    pub goal_met: bool,
    pub thickening: Option<ThickeningBaseline>,
    pub grid: Option<GridBaseline>,
    /// The plan needs no less material than the thickening and no less
    /// than the grid (an unreached grid counts as beaten).
    pub not_better_than_baseline: bool,
    /// Cancelled: the best valid plan when it stopped. Selection may have
    /// been cut short, and the later passes and the baselines left out.
    pub stopped_early: bool,
    /// Rib ends left in mid-wall (on no boundary, hold or other rib), each
    /// with the reason it could not be closed. Every other end is anchored.
    pub loose_ends: Vec<LooseEnd>,
    /// The mesh the reported numbers were solved on: the input with only
    /// the returned ribs cut in. Rib vertices index it.
    pub mesh: ShellMesh,
    pub stats: PlanStats,
    /// Resin only: the pockets the ribs closed, and the notches that open them.
    /// The reported stiffness is the notched ribs. Absent for filament and moulded.
    pub vents: Option<Venting>,
    /// Lowest natural frequency, Hz, bare then ribbed, on [`RibPlan::mesh`].
    /// Absent on a stiffness plan.
    pub frequency_hz: Option<FrequencyHz>,
    /// Ribbed over bare lowest frequency. Absent on a stiffness plan.
    pub frequency_factor: Option<f64>,
    /// Empty on a stiffness plan. A frequency plan records that the loads
    /// were not part of the goal.
    pub notes: Vec<String>,
}

/// Bare and ribbed lowest natural frequency, Hz.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FrequencyHz {
    pub bare: f64,
    pub ribbed: f64,
}

/// Why a rib end was left in mid-wall.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LooseEndReason {
    /// It stands at a no-rib zone's border (or a hole's rim margin, or where
    /// nothing has room in front of the wall): extending it would cross.
    NoRibZone,
    /// An extension reached an anchor, but the budget does not allow it.
    Budget,
}

/// A rib end left in mid-wall.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LooseEnd {
    /// Index into [`RibPlan::ribs`].
    pub rib: usize,
    /// 0 for its first point, 1 for its last.
    pub end: usize,
    pub point: [f64; 3],
    pub reason: LooseEndReason,
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
    if matches!(req.goal, Goal::Frequency { .. }) {
        return frequency::plan(req, &rep, started);
    }
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
            case_factors: vec![1.0; bare0.len()],
            case_deflection_mm: bare0
                .iter()
                .map(|r| [r.max_deflection, r.max_deflection])
                .collect(),
            worst_trace: Vec::new(),
            goal_met: false,
            thickening: None,
            grid: None,
            not_better_than_baseline: false,
            stopped_early: true,
            loose_ends: Vec::new(),
            mesh: req.mesh.clone(),
            stats,
            vents: req.vent.then_some(Venting {
                size_mm: RESIN_VENT_MM,
                factor_before: 1.0,
                factor_after: 1.0,
                pockets: Vec::new(),
                unvented: Vec::new(),
                note: None,
            }),
            frequency_hz: None,
            frequency_factor: None,
            notes: Vec::new(),
        }
    };
    if rep.cancelled() {
        return Ok(early(stats));
    }

    // 2. The field.
    let t = Instant::now();
    rep.stage(PlanStage::Field, 0.0);
    let bare0_c: Vec<f64> = bare0.iter().map(|r| r.compliance).collect();
    let field = field::Field::new(
        &s0,
        &bare0,
        req.options.field_alpha,
        // Worst-case ignores weights, so a heavier load does not own the
        // directions. Empty weights are all 1; one case stays at scale 1.
        &field::energy_scales(
            if req.combine == LoadCombine::Worst {
                &[]
            } else {
                &req.case_weights
            },
            &bare0_c,
        ),
    );
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
                let (stub, _) = tracer.straight_to(c.end_tri[end], p, c.end_dir[end], extend_limit);
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
    let mut ctx = select::Ctx {
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
    let mut ev = select::Evaluator::new(
        models,
        cases1.clone(),
        rules.side,
        req.case_weights.clone(),
        select::Mix::unbound(req.combine, req.options.worst_p),
    );
    let loose_input = loose::Input {
        req,
        s0: &s0,
        tracer: &tracer,
        tri_cap: &zones.cap,
        blocked: &blocked0,
        cases0: &cases0,
    };
    // Select; close the loose ends; then solve exactly the chosen ribs on
    // the input mesh with only them cut in. The selection mesh, with every
    // candidate cut in, is full of sliver triangles that make a rib look
    // stiffer than it is. When the clean solve misses a stiffness or
    // deflection goal the selection reached, selection runs again with the
    // target moved by the gap (two more times at most).
    let (outcome, mut closed, mut clean, mut goal_met) = loop {
        let outcome = select::run(&mut ev, &ctx, &cands, &rep)?;
        stats.seconds.select += outcome.seconds[0];
        stats.seconds.connect += outcome.seconds[1];
        stats.seconds.prune += outcome.seconds[2];
        stats.seconds.size += outcome.seconds[3];
        stats.selection_factor = outcome.bare.compliance / outcome.current.compliance;
        let ribs: Vec<GRib> = outcome
            .design
            .iter()
            .map(|d| GRib {
                points: d.chain.iter().map(|&v| ctx.pos[v as usize]).collect(),
                heights: d.heights(),
                d: d.clone(),
            })
            .collect();
        let t = Instant::now();
        let closed = if req.options.close_loose_ends && !outcome.stopped {
            loose::close(
                &loose_input,
                ribs,
                outcome.floor,
                outcome.bare.compliance,
                &outcome.mix,
                &rep,
            )?
        } else {
            loose::Closed::unchanged(&loose_input, ribs)
        };
        let mut closed = closed;
        stats.seconds.prune += t.elapsed().as_secs_f64();
        stats.solves += closed.solves;
        // Extensions stand at full height: size the ribs again, on the
        // pass's own mesh, now that they are joined up.
        if closed.stats.extended > 0 && !closed.stopped && !matches!(ctx.goal, Goal::Budget { .. })
        {
            let t = Instant::now();
            let (ribs, solves, cut) = resize(
                &loose_input,
                &closed.ribs,
                ctx.goal,
                outcome.floor,
                &outcome.mix,
                workers,
                &rep,
            )?;
            closed.ribs = ribs;
            closed.stopped |= cut;
            stats.solves += solves;
            stats.seconds.size += t.elapsed().as_secs_f64();
        }
        let clean = clean_solve(req, &s0, &cases0, &closed.ribs)?;
        stats.solves += 2;
        let factor = clean.factor;
        let met = match req.goal {
            Goal::Stiffer(f) => factor >= f,
            Goal::MaxDeflection(d) => clean.ribbed.max_deflection <= d,
            Goal::Budget { volume_mm3 } => clean.volume <= volume_mm3,
            Goal::Balanced => outcome.goal_met,
            // A frequency plan returns before selection.
            Goal::Frequency { .. } => false,
        };
        // A budget is kept by the clean count too: the ribs cut into the
        // input mesh run through vertices snapped within a tenth of an edge,
        // a few tenths of a percent longer than on the selection mesh.
        let budget = matches!(req.goal, Goal::Budget { .. });
        let again = !met
            && (outcome.reached || budget)
            && !outcome.stopped
            && !closed.stopped
            && !rep.cancelled()
            && stats.clean_retries < 2;
        let tighter = match (req.goal, ctx.goal) {
            (Goal::Stiffer(f), Goal::Stiffer(now)) => {
                Some(Goal::Stiffer(now * (f / factor) * 1.002))
            }
            (Goal::MaxDeflection(d), Goal::MaxDeflection(now)) => Some(Goal::MaxDeflection(
                now / (clean.ribbed.max_deflection / d) / 1.002,
            )),
            (Goal::Budget { volume_mm3: b }, Goal::Budget { volume_mm3: now }) => {
                Some(Goal::Budget {
                    volume_mm3: now * (b / clean.volume) * 0.998,
                })
            }
            _ => None,
        };
        match tighter {
            Some(g) if again => {
                ctx.goal = g;
                stats.clean_retries += 1;
            }
            _ => break (outcome, closed, clean, met),
        }
    };
    stats.solves += ev.solves;
    stats.seconds.solver = ev.seconds;
    stats.loose_ends = closed.stats;

    // Resin: the reported solve is the notched ribs. The selection above is
    // the unnotched one, so filament and moulded (vent left false) are unchanged.
    let vents = if req.vent {
        let before = clean.factor;
        let build = crate::units::normalize(req.build_axis).unwrap_or([0.0, 0.0, 1.0]);
        // A loose end is not a drain. An open border and a through hole are.
        let generated = if req.borders.is_empty() { rising_borders(&s0, req.rising_border) } else { Vec::new() };
        let border_lines: &[(Vec<[f64; 3]>, vents::BorderKind)] = if req.borders.is_empty() { &generated } else { &req.borders };
        let border_runs: Vec<vents::BorderRun<'_>> = border_lines
            .iter()
            .map(|(pts, kind)| vents::BorderRun { points: pts, kind: *kind })
            .collect();
        let mut found = match vents::opening_of(&req.mesh, req.rules.side) {
            Some(opening) => vents::find(&closed.ribs, &[], &border_runs, opening, build, req.rules.min_length),
            None => vents::VentPockets {
                cups: false,
                closed: 0,
                size_mm: RESIN_VENT_MM,
                pockets: Vec::new(),
                unvented: Vec::new(),
                note: None,
            },
        };
        let (after, pockets) = if found.pockets.is_empty() {
            (before, found.pockets)
        } else {
            let loose_pts: Vec<([f64; 3], LooseEndReason)> = closed
                .loose
                .iter()
                .map(|&(rib, end, reason)| {
                    let pts = &closed.ribs[rib].points;
                    let p = if end == 0 { pts[0] } else { *pts.last().expect("rib points") };
                    (p, reason)
                })
                .collect();
            let mut cut = vents::notch(&closed.ribs, &found.pockets, req.rules.min_length);
            vents::seat_gaps(&s0, &mut cut.ribs, &cut.pairs, &mut cut.pockets, req.rules.min_length);
            found.unvented.extend(cut.refused);
            let pockets = cut.pockets;
            let notched = cut.ribs;
            closed.loose = remap_loose(&loose_pts, &notched);
            closed.ribs = notched;
            clean = clean_solve(req, &s0, &cases0, &closed.ribs)?;
            stats.solves += 2;
            goal_met = match req.goal {
                Goal::Stiffer(f) => clean.factor >= f,
                Goal::MaxDeflection(d) => clean.ribbed.max_deflection <= d,
                Goal::Budget { volume_mm3 } => clean.volume <= volume_mm3,
                Goal::Balanced => goal_met,
                // A frequency plan returns before the vent block.
                Goal::Frequency { .. } => false,
            };
            // pocket.rib indexes the ribs this plan returns. A piece that did not embed is named, not dropped.
            let mut placed = Vec::new();
            for p in pockets {
                match clean.kept.iter().position(|&i| i == p.rib) {
                    Some(rib) => placed.push(vents::VentPocket { rib, at: p.at, size_mm: p.size_mm }),
                    None => found.unvented.push(vents::VentUnvented {
                        at: p.at,
                        message: "the notched rib is not in the plan".to_string(),
                    }),
                }
            }
            (clean.factor, placed)
        };
        Some(Venting {
            size_mm: found.size_mm,
            factor_before: before,
            factor_after: after,
            pockets,
            unvented: found.unvented,
            note: found.note,
        })
    } else {
        None
    };

    let bare = clean.bare;
    let ribbed = clean.ribbed;
    let rib_volume = clean.volume;
    let total_energy: f64 = clean.eval.strain_energy;
    let mut ribs = Vec::new();
    let mut loose_ends = Vec::new();
    for (k, (&i, d)) in clean.kept.iter().zip(&clean.design).enumerate() {
        let g = &closed.ribs[i];
        let points: Vec<[f64; 3]> = d.chain.iter().map(|&v| clean.pos[v as usize]).collect();
        for &(rib, end, reason) in &closed.loose {
            if rib == i {
                loose_ends.push(LooseEnd {
                    rib: k,
                    end,
                    point: if end == 0 {
                        points[0]
                    } else {
                        *points.last().expect("points")
                    },
                    reason,
                });
            }
        }
        let length = points.windows(2).map(|w| norm(sub(w[1], w[0]))).sum();
        let mut ends = clean.ends[k];
        if let Some(v) = &vents {
            for pocket in &v.pockets {
                if norm(sub(points[0], pocket.at)) < 1.0 {
                    ends[0] = RibEndKind::Gap;
                }
                if norm(sub(*points.last().expect("points"), pocket.at)) < 1.0 {
                    ends[1] = RibEndKind::Gap;
                }
            }
        }
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
            side: rules.side,
            ends,
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
    let stiffness_factor = clean.factor;

    // 6. Baselines, on the clean solve's footing.
    let t = Instant::now();
    let stopped = outcome.stopped || closed.stopped;
    let (thickening, grid) =
        if req.options.baselines && !ribs.is_empty() && !stopped && !rep.cancelled() {
            rep.stage(PlanStage::Baselines, 0.0);
            let grid_input = baseline::GridInput {
                surface: &s0,
                blocked: &blocked0,
                tri_cap: &zones.cap,
                rules,
                material: req.material,
                holds: &req.holds,
                cases: &cases0,
                mix: &clean.mix,
                target: clean.target,
                tolerance: req.options.simplify_tolerance,
                rep: &rep,
            };
            // The two searches are independent: run them side by side.
            let (th, gr) = rayon::join(
                || {
                    baseline::thickening(
                        &clean.mesh,
                        req.material,
                        &clean.holds,
                        &clean.cases,
                        &baseline::ThickeningGoal {
                            mix: &clean.mix,
                            bare: clean.bare_objective,
                            target: clean.target,
                        },
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
        stopped || (req.options.baselines && !ribs.is_empty() && thickening.is_none());
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
        case_factors: clean.case_factors,
        case_deflection_mm: clean.case_deflection_mm,
        worst_trace: outcome.worst_trace,
        goal_met: goal_met && !stopped,
        thickening,
        grid,
        not_better_than_baseline: not_better,
        stopped_early,
        loose_ends,
        mesh: clean.mesh,
        stats,
        vents,
        frequency_hz: None,
        frequency_factor: None,
        notes: Vec::new(),
    })
}

/// The outer boundary, when a side wall stands on it. A shorter loop of this mesh is an opening
/// through it. A standing wall is not an opening: the panel and MCP send its outline in
/// `req.borders` as a rising border, and this fallback is not used then.
fn rising_borders(s0: &surface::Surface, rising: bool) -> Vec<(Vec<[f64; 3]>, vents::BorderKind)> {
    if !rising {
        return Vec::new();
    }
    let loops = s0.boundary_loops();
    let longest = loops.iter().enumerate().max_by_key(|(_, loop_ix)| loop_ix.len()).map(|(i, _)| i);
    loops
        .into_iter()
        .enumerate()
        .map(|(i, loop_ix)| {
            let mut pts: Vec<[f64; 3]> = loop_ix.iter().map(|&v| s0.pos[v as usize]).collect();
            if let Some(first) = pts.first().copied() {
                pts.push(first);
            }
            let kind = if Some(i) == longest { vents::BorderKind::Rises } else { vents::BorderKind::Hole };
            (pts, kind)
        })
        .collect()
}

/// Loose ends survive a notch when their point is still a rib end. A gap's new ends are not loose ends.
fn remap_loose(points: &[([f64; 3], LooseEndReason)], ribs: &[GRib]) -> Vec<(usize, usize, LooseEndReason)> {
    let mut out = Vec::new();
    for &(point, reason) in points {
        for (i, rib) in ribs.iter().enumerate() {
            if rib.points.len() < 2 {
                continue;
            }
            if norm(sub(rib.points[0], point)) < 0.2 {
                out.push((i, 0, reason));
            }
            if norm(sub(*rib.points.last().expect("rib points"), point)) < 0.2 {
                out.push((i, 1, reason));
            }
        }
    }
    out
}

/// A chosen rib by its geometry: points on the mid-surface and the height
/// of each stretch between them, with its section and history in `d` (whose
/// own chain is on some other mesh and is not read).
#[derive(Clone, Debug)]
pub(crate) struct GRib {
    pub points: Vec<[f64; 3]>,
    pub heights: Vec<f64>,
    pub d: select::DRib,
}

/// What [`embed_design`] gives: the surface, the ribs on it, the indexes
/// of the ribs that could be cut in, and the extra lines' chains.
pub(crate) type Embedded = (
    surface::Surface,
    Vec<select::DRib>,
    Vec<usize>,
    Vec<Option<Vec<u32>>>,
);

/// Ribs (and `extra` lines after them) cut into a copy of `s0`: the
/// surface, each rib as a chain of it with the height of the stretch each
/// of its edges lies on, the indexes of the ribs that could be cut in, and
/// the chains of the extra lines (`None` where one could not be cut in).
pub(crate) fn embed_design(
    s0: &surface::Surface,
    ribs: &[GRib],
    extra: &[Vec<[f64; 3]>],
) -> Embedded {
    let mut s = s0.clone();
    let ids: Vec<Option<usize>> = ribs.iter().map(|g| s.embed_polyline(&g.points)).collect();
    let extra_ids: Vec<Option<usize>> = extra.iter().map(|p| s.embed_polyline(p)).collect();
    let mut kept = Vec::new();
    let mut design = Vec::new();
    for (i, g) in ribs.iter().enumerate() {
        let Some(id) = ids[i] else { continue };
        // Chains are kept whole through the later cuts.
        let chain = s.chains[id].clone();
        // Each edge takes the height of the stretch its middle lies on,
        // walking forward along the rib.
        let mut j = 0usize;
        let caps: Vec<f64> = chain
            .windows(2)
            .map(|w| {
                let m = scale3(add3(s.pos[w[0] as usize], s.pos[w[1] as usize]), 0.5);
                let mut best = (f64::INFINITY, j);
                for (q, seg) in g.points.windows(2).enumerate().skip(j) {
                    let ab = sub(seg[1], seg[0]);
                    let l2 = dot(ab, ab);
                    let u = if l2 > 0.0 {
                        (dot(sub(m, seg[0]), ab) / l2).clamp(0.0, 1.0)
                    } else {
                        0.0
                    };
                    let dist = norm(sub(m, add3(seg[0], scale3(ab, u))));
                    if dist < best.0 - 1e-9 {
                        best = (dist, q);
                    }
                }
                j = best.1;
                g.heights[j]
            })
            .collect();
        let mut d = g.d.clone();
        d.chain = chain;
        d.caps = caps;
        design.push(d);
        kept.push(i);
    }
    let extra_chains = extra_ids
        .iter()
        .map(|id| id.map(|i| s.chains[i].clone()))
        .collect();
    (s, design, kept, extra_chains)
}

/// The sizing pass ([`select::size`]) run again on the input mesh with
/// only `ribs` cut in. Returns the ribs, the solves, and whether a cancel
/// cut it short.
fn resize(
    input: &loose::Input,
    ribs: &[GRib],
    goal: Goal,
    floor: f64,
    mix: &select::Mix,
    workers: usize,
    rep: &Reporter,
) -> Result<(Vec<GRib>, usize, bool), SimError> {
    let req = input.req;
    let (s, design, _, _) = embed_design(input.s0, ribs, &[]);
    let holds = resolve_holds(&s, &req.holds);
    let cases = remap_cases(&s, input.cases0, req.mesh.triangles.len());
    let mesh = s.to_mesh();
    let models: Vec<ShellModel> = (0..workers)
        .into_par_iter()
        .map(|_| ShellModel::new(mesh.clone(), req.material, &holds, ShellOptions::default()))
        .collect::<Result<_, _>>()?;
    let mut ev = select::Evaluator::new(
        models,
        cases,
        req.rules.side,
        req.case_weights.clone(),
        mix.clone(),
    );
    let bare = ev.eval(&[])?;
    let cur = ev.eval(&design)?;
    let ctx = select::Ctx {
        pos: s.pos.clone(),
        thickness: s.thickness.clone(),
        boundary: s.boundary_flags(),
        held: held_flags(&holds, s.pos.len()),
        width: req.rules.width,
        profile: req.rules.profile,
        min_height: req.rules.min_height,
        max_height: req.rules.max_height,
        goal,
        shortlist: req.options.shortlist,
    };
    let (design, _, cut) = select::size(&mut ev, &ctx, design, cur, floor, bare.compliance, rep)?;
    let out = design
        .iter()
        .map(|d| GRib {
            points: d.chain.iter().map(|&v| s.pos[v as usize]).collect(),
            heights: d.heights(),
            d: d.clone(),
        })
        .collect();
    Ok((out, ev.solves, cut))
}

/// What each end of each rib meets on surface `s`.
pub(crate) fn rib_ends(
    s: &surface::Surface,
    held: &[bool],
    design: &[select::DRib],
) -> Vec<[RibEndKind; 2]> {
    let boundary = s.boundary_flags();
    design
        .iter()
        .enumerate()
        .map(|(i, d)| {
            [0, 1].map(|end| {
                let v = if end == 0 {
                    d.chain[0]
                } else {
                    *d.chain.last().expect("chain")
                };
                if boundary[v as usize] {
                    RibEndKind::Boundary
                } else if held[v as usize] {
                    RibEndKind::Hold
                } else if design
                    .iter()
                    .enumerate()
                    .any(|(j, o)| j != i && o.chain.contains(&v))
                {
                    RibEndKind::Rib
                } else {
                    RibEndKind::Free
                }
            })
        })
        .collect()
}

fn add3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

fn scale3(a: [f64; 3], k: f64) -> [f64; 3] {
    [a[0] * k, a[1] * k, a[2] * k]
}

/// The chosen ribs solved on their own: the input surface with only them
/// cut in, holds and loads carried the planner's way, bare and ribbed.
struct Clean {
    mesh: ShellMesh,
    pos: Vec<[f64; 3]>,
    holds: Vec<ShellHold>,
    cases: Vec<LoadCase>,
    /// The ribs on the clean mesh, and for each the index of the rib it is
    /// (a rib that could not be cut in is left out).
    design: Vec<select::DRib>,
    kept: Vec<usize>,
    ends: Vec<[RibEndKind; 2]>,
    bare: Response,
    ribbed: Response,
    eval: select::Eval,
    volume: f64,
    /// Scales from this mesh's bare compliances.
    mix: select::Mix,
    /// Bare and ribbed objective (`mix.of`), the target the baselines match.
    bare_objective: f64,
    target: f64,
    factor: f64,
    case_factors: Vec<f64>,
    case_deflection_mm: Vec<[f64; 2]>,
}

fn clean_solve(
    req: &RibPlanRequest,
    s0: &surface::Surface,
    cases0: &[LoadCase],
    ribs: &[GRib],
) -> Result<Clean, SimError> {
    let (s, design, kept, _) = embed_design(s0, ribs, &[]);
    let holds = resolve_holds(&s, &req.holds);
    let cases = remap_cases(&s, cases0, req.mesh.triangles.len());
    let mesh = s.to_mesh();
    let mut model = ShellModel::new(mesh.clone(), req.material, &holds, ShellOptions::default())?;
    model.set_threads(1);
    let bare = model.solve_cases(&cases)?;
    let bare_cs: Vec<f64> = bare.iter().map(|r| r.compliance).collect();
    let mix = select::Mix::from_bare(
        &req.case_weights,
        &bare_cs,
        req.combine,
        req.options.worst_p,
    );
    let eval = select::evaluate(&mut model, &cases, req.rules.side, &design, &mix)?;
    let rib_cs: Vec<f64> = eval.results.iter().map(|r| r.compliance).collect();
    let volume = select::network_volume(&s.pos, &design);
    let ends = rib_ends(&s, &held_flags(&holds, s.pos.len()), &design);
    let bare_sum: f64 = bare_cs.iter().copied().sum();
    let rib_sum: f64 = rib_cs.iter().copied().sum();
    Ok(Clean {
        bare: Response {
            compliance: bare_sum,
            max_deflection: bare.iter().map(|r| r.max_deflection).fold(0.0, f64::max),
        },
        ribbed: Response {
            compliance: rib_sum,
            max_deflection: eval.max_deflection,
        },
        mix: mix.clone(),
        bare_objective: mix.of(&bare_cs),
        target: mix.of(&rib_cs),
        factor: mix.factor(&bare_cs, &rib_cs),
        case_factors: select::Mix::case_factors(&bare_cs, &rib_cs),
        case_deflection_mm: bare
            .iter()
            .zip(&eval.results)
            .map(|(b, r)| [b.max_deflection, r.max_deflection])
            .collect(),
        mesh,
        pos: s.pos,
        holds,
        cases,
        design,
        kept,
        ends,
        eval,
        volume,
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
    let n_cases = if req.load_cases.is_empty() {
        1
    } else {
        req.load_cases.len()
    };
    if !req.case_weights.is_empty() && req.case_weights.len() != n_cases {
        return Err(SimError::new(
            "Each load case needs one weight, or none (every case weighs 1).",
        ));
    }
    if req
        .case_weights
        .iter()
        .any(|w| !(w.is_finite() && *w > 0.0))
    {
        return Err(SimError::new("A load-case weight must be above zero."));
    }
    if req.combine == LoadCombine::Worst && !req.case_weights.is_empty() {
        return Err(SimError::new(
            "Worst-case mode does not take load-case weights.",
        ));
    }
    if req.combine == LoadCombine::Worst {
        let p = req.options.worst_p;
        if !(p.is_finite() && p >= 1.0) {
            return Err(SimError::new("The worst-case exponent must be 1 or more."));
        }
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
        Goal::Frequency { factor } => {
            if !(factor.is_finite() && factor >= 1.0) {
                return Err(SimError::new("A frequency goal must be 1 or more."));
            }
            match req.material.density {
                Some(d) if d.is_finite() && d > 0.0 => Ok(()),
                _ => Err(SimError::new(
                    "A frequency goal needs the material's density.",
                )),
            }
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
