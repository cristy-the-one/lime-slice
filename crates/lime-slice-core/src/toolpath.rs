use std::borrow::Cow;
use std::cmp::{Ordering as CmpOrdering, Reverse};
use std::collections::{BinaryHeap, BTreeSet, HashMap};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Instant;

use crate::poly::{
    boolean_diff, boolean_intersect, boolean_union, drop_slivers, in_solid, loop_bounds, loops_from_paths,
    offset_loops, offset_paths, paths_from_loops, point_in_loop, principal_axis, resolve_nonzero,
    signed_area, Loop,
};
use crate::strategy::{
    FuzzySkin, InfillPattern, Ironing, ResolvedStrategy, ScarfSeam, SeamMode, StrategyId,
};
use crate::support::paint::SeamDisk;
use crate::support::Disk;
use clipper2::{EndType, FillRule, JoinType, Milli, Paths};

mod adhesion;
mod bridges;
mod combing;
mod fill_lines;
mod fuzzy;
mod infill;
mod infill_order;
mod island_order;
mod layout;
mod nearest;
mod open_order;
mod outline;
mod polish;
mod scarf;
mod seams;
mod solid_fill;
mod support_emit;
mod tour;
mod void_fill;
mod walls;
#[cfg(test)]
mod travel_tests;

pub use self::adhesion::*;
pub use self::bridges::*;
pub use self::combing::*;
pub use self::fill_lines::*;
pub(crate) use self::fuzzy::*;
pub use self::infill::*;
use self::infill_order::*;
pub(crate) use self::island_order::*;
pub use self::layout::*;
use self::nearest::*;
use self::open_order::*;
use self::outline::*;
use self::polish::*;
pub use self::scarf::*;
use self::seams::*;
use self::solid_fill::*;
pub use self::support_emit::*;
use self::tour::*;
pub(crate) use self::void_fill::*;
pub use self::walls::*;

/// How a top skin is filled. Omitted on a request means rectilinear, the
/// scanlines the planner already lays.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SurfacePattern {
    #[default]
    Rectilinear,
    /// Every bead in a connected region steps the same way, from the low side
    /// of the scan to the high side, so a hole does not leave a scar.
    Monotonic,
    /// Closed inset rings, one line width apart.
    Concentric,
}

impl SurfacePattern {
    pub fn is_rectilinear(&self) -> bool {
        *self == Self::Rectilinear
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PathKind {
    Skirt,
    Wall,
    Outer,
    Inner,
    ThinWall,
    GapFill,
    Infill,
    Sparse,
    Solid,
    Top,
    Bridge,
    Support,
    SupportInterface,
    Ironing,
}

impl PathKind {
    pub fn as_str(self) -> &'static str {
        match self {
            PathKind::Skirt => "skirt",
            PathKind::Wall => "wall",
            PathKind::Outer => "outer",
            PathKind::Inner => "inner",
            PathKind::ThinWall => "thin-wall",
            PathKind::GapFill => "gap-fill",
            PathKind::Infill => "infill",
            PathKind::Sparse => "sparse",
            PathKind::Solid => "solid",
            PathKind::Top => "top",
            PathKind::Bridge => "bridge",
            PathKind::Support => "support",
            PathKind::SupportInterface => "support-interface",
            PathKind::Ironing => "ironing",
        }
    }

    pub fn is_wall(self) -> bool {
        matches!(self, PathKind::Wall | PathKind::Outer | PathKind::Inner)
    }

    pub fn is_closed(self) -> bool {
        matches!(
            self,
            PathKind::Wall
                | PathKind::Outer
                | PathKind::Inner
                | PathKind::ThinWall
                | PathKind::Skirt
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShellBand {
    Interior,
    Bottom,
    Top,
}

/// The areas of a layer that print as skin. `bottom` hangs over open air or
/// the bed within the bottom shell's depth below, `top` lies under open air
/// within the top shell's depth above. The rest inside the walls is interior.
#[derive(Clone, Debug, Default)]
pub struct Skin {
    pub bottom: Vec<Loop>,
    pub top: Vec<Loop>,
}

impl Skin {
    /// The band a layer with this skin is in, for what still works layer by
    /// layer. Bottom wins, as it does where a floor and a roof are close.
    pub fn shell(&self) -> ShellBand {
        if !self.bottom.is_empty() {
            ShellBand::Bottom
        } else if !self.top.is_empty() {
            ShellBand::Top
        } else {
            ShellBand::Interior
        }
    }
}

#[derive(Clone, Debug)]
pub struct PathFeatures {
    pub variable_width: bool,
    /// Distance downward from the nearest roof. Lightning fades out past the strategy range.
    pub roof_distance_mm: f64,
    /// Solid infill turns a quarter on each layer by its parity.
    pub layer_index: usize,
    pub layer_height: f64,
    /// `Interior` unless some area of the layer is skin. Infill combine and
    /// the gyroid's graded core read it; the skin itself comes from `skin`.
    pub shell: ShellBand,
    /// The areas of this layer that print as skin.
    pub skin: std::sync::Arc<Skin>,
    /// This layer's lightning branches, grown with the layers around it,
    /// when the strategy prints the lightning they were grown for.
    pub lightning: Option<crate::lightning::Branches>,
    /// The cells of the layer below, which the lightning with those branches
    /// leaves hollow. Void fill over them bridges across its strip.
    pub hollow_below: Option<crate::lightning::Hollow>,
    /// Absolute layer Z. The 3D gyroid section is evaluated here.
    pub z: f64,
    /// Outer-wall noise. `None` leaves the walls as planned.
    pub fuzzy_skin: Option<FuzzySkin>,
    /// Seam disks in the part frame. Empty leaves the picker's start.
    pub seam_paint: Vec<SeamDisk>,
    /// Nozzle diameter used to cap combined sparse beads.
    pub nozzle_diameter: f64,
    /// Interior layers from this one through the last before a shell, including this one.
    /// `0` when this layer is not an interior sparse layer.
    pub interior_remaining: u32,
    /// Length of the interior run this layer belongs to.
    pub interior_run: u32,
    /// Top-skin fill. Rectilinear is the existing diagonal scan.
    pub top_pattern: SurfacePattern,
    /// Widen holes by this many millimetres. `0` leaves them.
    pub xy_hole_mm: f64,
    /// Grow outer contours by this many millimetres. Negative shrinks them.
    pub xy_contour_mm: f64,
    /// Extra inset of outer contours on layer 0, millimetres.
    pub elephants_foot_mm: f64,
    /// Order the sparse infill pieces nearest end first as they are planned.
    /// The classic planner tours nothing afterwards, so this is its only
    /// ordering; the tour reorders them anyway, so elsewhere it stays off.
    pub infill_nearest_first: bool,
}

impl Default for PathFeatures {
    fn default() -> Self {
        Self {
            variable_width: true,
            roof_distance_mm: 0.0,
            layer_index: 0,
            layer_height: 0.2,
            shell: ShellBand::Interior,
            skin: std::sync::Arc::default(),
            lightning: None,
            hollow_below: None,
            z: 0.0,
            fuzzy_skin: None,
            seam_paint: Vec::new(),
            nozzle_diameter: 0.4,
            interior_remaining: 1,
            interior_run: 1,
            top_pattern: SurfacePattern::Rectilinear,
            xy_hole_mm: 0.0,
            xy_contour_mm: 0.0,
            elephants_foot_mm: 0.0,
            infill_nearest_first: false,
        }
    }
}

/// A travel in open air, between supports and clear of the part, only strings
/// the ooze across the gap, so it retracts from this length. A strategy's own
/// minimum travel still applies when it is longer.
const OPEN_AIR_RETRACT_MIN_MM: f64 = 15.0;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TravelIn {
    /// Not checked against the part. Retract past the strategy's minimum travel.
    #[default]
    Unchecked,
    /// Stays inside the part, straight or through `lead_in`. No retract.
    Inside,
    /// Leaves the part or crosses a hole. Always retract.
    Blocked,
    /// Runs wholly in open air: it starts and ends clear of the part and
    /// touches none of its walls. Retract past `OPEN_AIR_RETRACT_MIN_MM`.
    Open,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Extrusion {
    pub kind: PathKind,
    pub strategy: StrategyId,
    pub points: Vec<[f64; 2]>,
    pub speed: f64,
    pub travel_speed: f64,
    pub accel: f64,
    pub width: f64,
    pub retract_mm: f64,
    pub retract_min_travel: f64,
    pub fan: u8,
    /// Emit `fan` on this path even on a layer whose fan is off. The next path
    /// restores the layer fan. Off leaves the layer fan policy alone.
    pub fan_hold: bool,
    /// Which of the printer's fan values the bead takes when the request
    /// names them. `fan` is what it runs at when none is named.
    pub fan_role: FanRole,
    /// Multiplier on the volumetric bead. Bridges stay at 1 unless a bridge
    /// flow ratio is set.
    pub flow: f64,
    /// Structural weight used by the toughness score. Not a G-code field.
    pub strength: f64,
    /// `0` uses the layer height. Combined infill and thick support shafts set this.
    pub bead_height: f64,
    /// Accel used for the travel into this path.
    pub travel_accel: f64,
    /// Intermediate combing points visited before `points[0]`.
    pub lead_in: Vec<[f64; 2]>,
    /// How the travel into this path relates to the part. Decides the retract.
    pub travel_in: TravelIn,
    /// Nozzle height as a fraction of this layer's height, one entry per point.
    /// Empty means the whole path sits on the layer Z. `0` is the previous layer top.
    pub z_frac: Vec<f64>,
    /// Flow multiplier per point. Empty means `flow` for every vertex.
    pub flow_frac: Vec<f64>,
    /// Length of the scarf overlap. `0` is a butt seam.
    pub scarf_mm: f64,
    /// Set when overhang splitting slowed this span. Scarf stays off those spans.
    pub on_overhang: bool,
    /// Set on a part path the object's speed cap lowers: no range or volume
    /// set its speed. `speed` is planned without the cap.
    pub cap_feed: Option<CapFeed>,
    /// Run the existing G2/G3 fitter on this open path (3D gyroid).
    pub fit_arcs: bool,
    /// Lift height for the travel into this path. `0` stays on the layer.
    pub z_hop: f64,
    /// How the travel order may move where this closed path starts.
    pub seam: Seam,
    /// Noise applied once the seam and any scarf ramp are final. `None`
    /// leaves the path as planned.
    pub fuzzy: Option<FuzzyMark>,
}

/// Which printer fan value a bead takes. Planning leaves `fan` where the
/// strategy put it, so a fan change re-emits and never re-plans.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FanRole {
    /// Walls, infill, skin, skirt, and brim: Fan %.
    Part,
    /// An overhang span or a bridge: Overhang fan %, or else Fan % raised to
    /// `boost` as the span was before the printer named a fan.
    Overhang { boost: u8 },
    /// A short supported stretch between two overhang spans of one path. It
    /// shares their fan, so the run changes the fan once.
    Gap,
    /// Support, interface, and tree paths: Support fan %, else Fan %.
    Support,
    /// Belt-contact walls and the belt raft: always off.
    Off,
}

/// The feed a path was planned at and how overhang splitting slowed it, so
/// a speed cap can be applied after planning exactly as it is before.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CapFeed {
    pub feed: f64,
    pub slow: Slowdown,
}

impl CapFeed {
    /// The path's speed had `cap` been on its strategy while planning.
    pub fn speed(&self, cap: f64) -> f64 {
        self.slow.speed(self.feed.min(cap))
    }
}

/// How overhang splitting slows a span from its feed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Slowdown {
    None,
    Bridge,
    /// Over air at 42° to 68°.
    Overhang,
    /// Over air at 68° or more.
    Steep,
}

impl Slowdown {
    pub fn speed(self, feed: f64) -> f64 {
        match self {
            Slowdown::None => feed,
            Slowdown::Bridge => feed.clamp(18.0, 36.0),
            Slowdown::Overhang => (feed * 0.55).max(16.0),
            Slowdown::Steep => (feed * 0.32).max(16.0),
        }
    }
}

/// Outer-wall noise waiting for the seam to be chosen.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FuzzyMark {
    pub skin: FuzzySkin,
    pub z: f64,
}

/// How the travel order may move a closed path's start.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Seam {
    /// Keep the planned seam. Aligned walls stack it on one side.
    Fixed,
    /// The sharpest corner near the nozzle. A visible wall hides its seam there.
    Corner,
    /// The vertex nearest the nozzle. Inner walls are hidden, and on a smooth
    /// curve the nearest vertex keeps the arc fitter's runs whole.
    Nearest,
    /// The back corner of the loop, like `Fixed`, except that when several
    /// corners are equally far back the one nearest the nozzle starts it.
    Edge,
    /// A wall the region cut opened. It has no seam and prints from whichever
    /// end is nearer, so the next ring starts where this one ended.
    Cut,
}

fn as_outers(loops: &[Loop]) -> Vec<Loop> {
    loops
        .iter()
        .map(|loop_| {
            let mut next = loop_.clone();
            if signed_area(&next) < 0.0 {
                next.reverse();
            }
            next
        })
        .collect()
}

fn union_all(loops: &[Loop]) -> Vec<Loop> {
    let mut acc = Vec::new();
    for loop_ in loops {
        acc = boolean_union(&acc, std::slice::from_ref(loop_));
    }
    acc
}

/// Exterior corners whose interior angle is under 125°.
fn sharp_corners(loop_: &Loop) -> Vec<[f64; 2]> {
    let n = loop_.len();
    if n < 3 {
        return Vec::new();
    }
    let closed = dist2(loop_[0], loop_[n - 1]) < 1e-8;
    let count = if closed { n - 1 } else { n };
    if count < 3 {
        return Vec::new();
    }
    let mut out = Vec::new();
    for i in 0..count {
        let a = loop_[(i + count - 1) % count];
        let b = loop_[i];
        let c = loop_[(i + 1) % count];
        let ab = [b[0] - a[0], b[1] - a[1]];
        let bc = [c[0] - b[0], c[1] - b[1]];
        let cross = ab[0] * bc[1] - ab[1] * bc[0];
        let dot = ab[0] * bc[0] + ab[1] * bc[1];
        let turn = cross.atan2(dot);
        if turn <= 0.0 {
            continue;
        }
        let interior = std::f64::consts::PI - turn;
        if interior < 125.0_f64.to_radians() {
            out.push(b);
        }
    }
    out
}

fn circle(center: [f64; 2], radius: f64, steps: usize) -> Loop {
    let steps = steps.max(8);
    (0..steps)
        .map(|i| {
            let angle = i as f64 / steps as f64 * std::f64::consts::TAU;
            [
                center[0] + radius * angle.cos(),
                center[1] + radius * angle.sin(),
            ]
        })
        .collect()
}

fn extrusion(
    kind: PathKind,
    strategy: &ResolvedStrategy,
    points: Vec<[f64; 2]>,
    width: f64,
) -> Extrusion {
    let mut path = Extrusion {
        kind,
        strategy: strategy.id,
        points,
        speed: strategy.print_speed,
        travel_speed: strategy.travel_speed,
        accel: strategy.accel,
        width,
        retract_mm: strategy.retract_mm,
        retract_min_travel: strategy.retract_min_travel,
        fan: strategy.fan,
        fan_hold: false,
        fan_role: if matches!(kind, PathKind::Support | PathKind::SupportInterface) {
            FanRole::Support
        } else {
            FanRole::Part
        },
        flow: 1.0,
        strength: kind_strength(kind, strategy),
        bead_height: 0.0,
        travel_accel: if strategy.feature_speeds {
            strategy.travel_accel
        } else {
            strategy.accel
        },
        lead_in: Vec::new(),
        travel_in: TravelIn::Unchecked,
        z_frac: Vec::new(),
        flow_frac: Vec::new(),
        scarf_mm: 0.0,
        on_overhang: false,
        cap_feed: None,
        fit_arcs: false,
        z_hop: 0.0,
        seam: match (kind, strategy.seam) {
            (PathKind::Inner, _) if !strategy.inner_follows_seam => Seam::Nearest,
            (_, SeamMode::Nearest) => Seam::Corner,
            (_, SeamMode::Aligned | SeamMode::Rear) => Seam::Fixed,
            (_, SeamMode::Edge) => Seam::Edge,
        },
        fuzzy: None,
    };
    apply_feed(&mut path, strategy);
    path
}

/// A layer's strip of the belt raft: one line across the belt at each slice
/// Y in `ys`, alternating direction, the first from `x[1]` when `flip`.
/// 30 mm/s, flow 1.0 and fan off, so the pad lays down like a first layer.
pub(crate) fn belt_raft_paths(
    x: [f64; 2],
    ys: &[f64],
    line_width: f64,
    flip: bool,
) -> Vec<Extrusion> {
    let strategy = crate::strategy::pure(crate::strategy::StrategyId::Speed);
    ys.iter()
        .enumerate()
        .map(|(i, &y)| {
            let (from, to) = if (i % 2 == 1) == flip {
                (x[0], x[1])
            } else {
                (x[1], x[0])
            };
            let mut line = extrusion(
                PathKind::Solid,
                &strategy,
                vec![[from, y], [to, y]],
                line_width,
            );
            line.speed = 30.0;
            line.flow = 1.0;
            line.fan = 0;
            line.fan_role = FanRole::Off;
            line.seam = Seam::Fixed;
            line
        })
        .collect()
}

fn apply_feed(path: &mut Extrusion, strategy: &ResolvedStrategy) {
    if !strategy.feature_speeds {
        return;
    }
    let (speed, accel) = match path.kind {
        PathKind::Outer | PathKind::Skirt | PathKind::Wall => {
            (strategy.outer_speed, strategy.outer_accel)
        }
        PathKind::Inner | PathKind::ThinWall => (strategy.inner_speed, strategy.inner_accel),
        PathKind::Sparse | PathKind::Infill => {
            if strategy.gyroid_3d && strategy.pattern == InfillPattern::Gyroid {
                (strategy.gyroid_speed, strategy.gyroid_accel)
            } else {
                (strategy.sparse_speed, strategy.sparse_accel)
            }
        }
        PathKind::Solid | PathKind::GapFill => (strategy.solid_speed, strategy.solid_accel),
        PathKind::Top | PathKind::Ironing => (strategy.top_speed, strategy.top_accel),
        PathKind::Bridge => (strategy.top_speed.min(36.0), strategy.top_accel),
        PathKind::Support | PathKind::SupportInterface => (strategy.print_speed, strategy.accel),
    };
    path.speed = speed;
    path.accel = accel;
    path.travel_speed = strategy.travel_speed;
    path.travel_accel = strategy.travel_accel;
}

fn kind_strength(kind: PathKind, strategy: &ResolvedStrategy) -> f64 {
    match kind {
        PathKind::Wall | PathKind::Outer | PathKind::Inner | PathKind::ThinWall => 1.25,
        PathKind::GapFill => 1.05,
        PathKind::Infill | PathKind::Sparse | PathKind::Solid | PathKind::Top => {
            let base = strategy.pattern.strength();
            if strategy.gyroid_3d && strategy.pattern == InfillPattern::Gyroid {
                base * 1.15
            } else {
                base
            }
        }
        PathKind::Bridge => 0.7,
        PathKind::Skirt | PathKind::Support | PathKind::SupportInterface | PathKind::Ironing => 0.0,
    }
}

fn emit_loops(
    out: &mut Vec<Extrusion>,
    loops: &[Loop],
    kind: PathKind,
    strategy: &ResolvedStrategy,
    width: f64,
    hint: &mut [f64; 2],
) {
    let mut items: Vec<Vec<[f64; 2]>> = loops
        .iter()
        .filter(|l| l.len() >= 3)
        .map(|l| seam_rotate(l, strategy.seam, *hint))
        .collect();
    if strategy.seam == SeamMode::Nearest {
        let mut ordered = Vec::with_capacity(items.len());
        while !items.is_empty() {
            let mut best = 0usize;
            let mut best_d = f64::MAX;
            for (i, pts) in items.iter().enumerate() {
                let d = dist2(pts[0], *hint);
                if d < best_d {
                    best_d = d;
                    best = i;
                }
            }
            let pts = items.swap_remove(best);
            *hint = *pts.last().unwrap();
            ordered.push(pts);
        }
        items = ordered;
    }
    for pts in items {
        if pts.len() >= 2 {
            *hint = *pts.last().unwrap();
            out.push(extrusion(kind, strategy, pts, width));
        }
    }
}

impl Extrusion {
    /// A loop keeps its direction and only moves its seam. A thin wall can also
    /// be an open stroke across a pinch, and a wall the region cut opened is
    /// one too: both may run either way.
    fn is_loop(&self) -> bool {
        match self.kind {
            PathKind::ThinWall => {
                self.points.len() > 2 && self.points.first() == self.points.last()
            }
            _ if self.seam == Seam::Cut => false,
            kind => kind.is_closed(),
        }
    }

    /// Kind the travel optimizer orders this path with. A thin-wall stroke across
    /// a pinch comes out of void fill, and ordering it apart from the gap fill
    /// around it costs travel. Gap fill lies beside the solid it fills, and
    /// ordering it after the solid as a tour of its own crossed the layer for
    /// every bead.
    pub(crate) fn travel_group(&self) -> PathKind {
        match self.kind {
            PathKind::ThinWall if !self.is_loop() => PathKind::Solid,
            PathKind::GapFill => PathKind::Solid,
            kind => kind,
        }
    }

    /// Replace whatever an earlier pass decided about the travel into this path.
    fn take_comb(&mut self, comb: Comb) {
        self.lead_in.clear();
        self.travel_in = match comb {
            Comb::Clear => TravelIn::Inside,
            Comb::Open => TravelIn::Open,
            Comb::Routed(via) => {
                self.lead_in = via;
                TravelIn::Inside
            }
            Comb::Blocked => TravelIn::Blocked,
        };
    }

    /// Retract length and minimum travel for the move into this path.
    /// `length` replaces the strategy's length; a travel that combs inside
    /// the part still does not retract.
    pub fn travel_retract(&self, length: Option<f64>) -> (f64, f64) {
        let mm = length.unwrap_or(self.retract_mm);
        match self.travel_in {
            TravelIn::Unchecked => (mm, self.retract_min_travel),
            TravelIn::Open => (mm, self.retract_min_travel.max(OPEN_AIR_RETRACT_MIN_MM)),
            TravelIn::Inside => (0.0, self.retract_min_travel),
            TravelIn::Blocked => (mm, 0.0),
        }
    }
}
