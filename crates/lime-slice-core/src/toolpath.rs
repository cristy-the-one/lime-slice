use std::borrow::Cow;
use std::cmp::{Ordering as CmpOrdering, Reverse};
use std::collections::{BinaryHeap, HashMap};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Instant;

use crate::poly::{
    boolean_diff, boolean_intersect, drop_slivers, in_solid, loop_bounds, loops_from_paths,
    offset_loops, offset_paths, paths_from_loops, point_in_loop, principal_axis, resolve_nonzero,
    signed_area, Loop,
};
use crate::strategy::{
    FuzzySkin, InfillPattern, Ironing, ResolvedStrategy, ScarfSeam, SeamMode, StrategyId,
};
use crate::support::paint::SeamDisk;
use crate::support::Disk;
use clipper2::{EndType, FillRule, JoinType, Milli, Paths};

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
            z: 0.0,
            fuzzy_skin: None,
            seam_paint: Vec::new(),
            nozzle_diameter: 0.4,
            interior_remaining: 1,
            interior_run: 1,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TravelIn {
    /// Not checked against the part. Retract past the strategy's minimum travel.
    #[default]
    Unchecked,
    /// Stays inside the part, straight or through `lead_in`. No retract.
    Inside,
    /// Leaves the part or crosses a hole. Always retract.
    Blocked,
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
    /// Multiplier on the volumetric bead. Bridges stay at 1.
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
    /// A wall the region cut opened. It has no seam and prints from whichever
    /// end is nearer, so the next ring starts where this one ended.
    Cut,
}

#[allow(dead_code)]
pub fn plan_region(
    contours: &[Loop],
    strategy: &ResolvedStrategy,
    line_width: f64,
    seam_hint: &mut [f64; 2],
    features: &PathFeatures,
) -> Vec<Extrusion> {
    plan_region_split(contours, strategy, line_width, seam_hint, features).0
}

/// Walls and infill of [`plan_region`], with CPU milliseconds for each half.
pub(crate) fn plan_region_split(
    contours: &[Loop],
    strategy: &ResolvedStrategy,
    line_width: f64,
    seam_hint: &mut [f64; 2],
    features: &PathFeatures,
) -> (Vec<Extrusion>, f64, f64) {
    if contours.is_empty() {
        return (Vec::new(), 0.0, 0.0);
    }
    let wall_started = Instant::now();
    let mut paths = Vec::new();
    let min_w = min_bead(line_width);
    let max_w = line_width * 1.30;
    if features.variable_width && might_be_thin(contours, line_width * strategy.walls.max(1) as f64)
    {
        if let Some(width) = feature_width(contours) {
            if width < line_width * strategy.walls.max(1) as f64 * 0.98 && width >= min_w {
                emit_variable_feature(
                    &mut paths, contours, strategy, width, min_w, max_w, seam_hint, features,
                );
                emit_void_fill(&mut paths, contours, &[], strategy, line_width, seam_hint);
                return (finish_paths(paths, features), ms_since(wall_started), 0.0);
            }
        }
    }
    let mut current = paths_from_loops(contours);
    let mut last_wall_loops: Vec<Loop> = Vec::new();
    for i in 0..strategy.walls {
        let delta = if i == 0 {
            -line_width * 0.5
        } else {
            -line_width
        };
        let next = offset_paths(&current, delta);
        let loops = loops_from_paths(next.clone());
        if loops.is_empty() {
            if features.variable_width {
                // Nothing fit one bead in from the outline, so this bead is the skin.
                let kind = if i == 0 {
                    PathKind::ThinWall
                } else {
                    PathKind::GapFill
                };
                fill_remaining(
                    &mut paths, &current, kind, strategy, min_w, max_w, seam_hint,
                );
            }
            break;
        }
        if features.variable_width && i + 1 < strategy.walls {
            let deeper = offset_paths(&next, -line_width);
            if loops_from_paths(deeper).is_empty() {
                last_wall_loops = loops.clone();
                let first = paths.len();
                emit_loops(
                    &mut paths,
                    &loops,
                    wall_kind(true, strategy),
                    strategy,
                    line_width,
                    seam_hint,
                );
                mark_outer_walls(&mut paths[first..], features);
                let core = paths_from_loops(&loops);
                fill_remaining(
                    &mut paths,
                    &core,
                    PathKind::GapFill,
                    strategy,
                    min_w,
                    max_w,
                    seam_hint,
                );
                break;
            }
        }
        current = next;
        last_wall_loops = loops.clone();
        let first = paths.len();
        emit_loops(
            &mut paths,
            &loops,
            wall_kind(i == 0, strategy),
            strategy,
            line_width,
            seam_hint,
        );
        if i == 0 {
            mark_outer_walls(&mut paths[first..], features);
        }
    }
    let wall_ms = ms_since(wall_started);
    let infill_started = Instant::now();
    let infill_src = if last_wall_loops.is_empty() {
        offset_paths(&paths_from_loops(contours), -line_width * 0.5)
    } else {
        offset_paths(&paths_from_loops(&last_wall_loops), -line_width * 0.5)
    };
    let infill_loops = loops_from_paths(infill_src.clone());
    if features.variable_width {
        emit_gap_fill(
            &mut paths,
            &infill_loops,
            strategy,
            line_width,
            min_w,
            max_w,
            seam_hint,
        );
    }
    // Skin closes the part where a surface is open above or below. Inside a
    // closed part the layer is interior, however much skin the rest of it has.
    let (bottom, rest) = carve(&infill_loops, &features.skin.bottom, line_width * 2.0);
    let (top, interior) = carve(&rest, &features.skin.top, line_width * 2.0);
    let arcs = strategy.gyroid_3d && strategy.pattern == crate::strategy::InfillPattern::Gyroid;
    for (area, shell) in [(&bottom, ShellBand::Bottom), (&top, ShellBand::Top)] {
        if area.is_empty() {
            continue;
        }
        let kind = infill_kind(strategy, shell);
        let fill = solid_fill(area, line_width, std::f64::consts::FRAC_PI_4, None);
        for pts in clip_infill(fill, area) {
            if pts.len() >= 2 {
                *seam_hint = *pts.last().unwrap();
                let mut path = extrusion(kind, strategy, pts, line_width);
                path.fit_arcs = arcs;
                paths.push(path);
            }
        }
    }
    if strategy.infill_density > 0.01 && !interior.is_empty() && infill_kept(strategy, features) {
        let infill = build_infill(&interior, strategy, line_width, features);
        let Some(bead) = combine_bead(strategy, features) else {
            emit_void_fill(
                &mut paths, contours, &interior, strategy, line_width, seam_hint,
            );
            return (finish_paths(paths, features), wall_ms, ms_since(infill_started));
        };
        let shell = if solid_infill(strategy) {
            ShellBand::Bottom
        } else {
            ShellBand::Interior
        };
        let kind = infill_kind(strategy, shell);
        for pts in infill {
            if pts.len() >= 2 {
                *seam_hint = *pts.last().unwrap();
                let mut path = extrusion(kind, strategy, pts, line_width);
                if (bead - features.layer_height).abs() > 1e-6 {
                    path.bead_height = bead;
                }
                path.fit_arcs = arcs;
                paths.push(path);
            }
        }
    }
    // Every void in a wide sparse area is a cell the pattern left on purpose.
    // Only an area too narrow for those cells can be one the pattern missed.
    let cells = if interior.is_empty() {
        Vec::new()
    } else {
        let narrow_sample = crate::inner_prof::Sample::start();
        let cells = wide_part(&interior, line_width * 6.0);
        narrow_sample.void_narrow();
        cells
    };
    emit_void_fill(
        &mut paths, contours, &cells, strategy, line_width, seam_hint,
    );
    (finish_paths(paths, features), wall_ms, ms_since(infill_started))
}

/// Tags outer walls. The offset waits until the seam is chosen, so the seam
/// stays on the corner and a scarf ramp, which lands after that, is skipped.
/// `None` does not touch the paths.
fn finish_paths(mut paths: Vec<Extrusion>, features: &PathFeatures) -> Vec<Extrusion> {
    if !features.seam_paint.is_empty() {
        for path in &mut paths {
            if !matches!(path.kind, PathKind::Outer | PathKind::Wall | PathKind::Inner) {
                continue;
            }
            if !geom_closed(path) {
                continue;
            }
            let ring = path.points.len() - 1;
            let (z, h) = (features.z, features.layer_height);
            let at =
                painted_vertex(&path.points[..ring], &features.seam_paint, z, h).or_else(|| {
                    // No vertex in any disk: start at the wall's nearest point
                    // to a disk centre, which a straight side may not have yet.
                    if !path.z_frac.is_empty() || !path.flow_frac.is_empty() {
                        return None;
                    }
                    let (i, q) = painted_edge(&path.points, &features.seam_paint, z, h)?;
                    path.points.insert(i + 1, q);
                    Some(i + 1)
                });
            if let Some(at) = at {
                rotate_closed_at(path, at);
                path.seam = Seam::Fixed;
            }
        }
    }
    if let Some(skin) = features.fuzzy_skin {
        for path in &mut paths {
            if path.kind == PathKind::Outer {
                path.fuzzy = Some(FuzzyMark { skin, z: features.z });
            }
        }
    }
    paths
}

/// With feature speeds off every wall is a `Wall`, so the kind no longer
/// says which one is outermost. The wall planner marks those as it emits them.
fn mark_outer_walls(paths: &mut [Extrusion], features: &PathFeatures) {
    if let Some(skin) = features.fuzzy_skin {
        for path in paths.iter_mut().filter(|p| p.kind == PathKind::Wall) {
            path.fuzzy = Some(FuzzyMark { skin, z: features.z });
        }
    }
}

/// The offset, after the seam and the scarf. A scarf ramp already has a
/// height and a flow on each point, so it is left alone. Taking the mark
/// means a second pass does nothing.
pub(crate) fn apply_fuzzy_skin(paths: &mut [Extrusion]) {
    for path in paths {
        fuzz_settled(path);
    }
}

fn fuzz_settled(path: &mut Extrusion) {
    let Some(mark) = path.fuzzy.take() else {
        return;
    };
    if !matches!(path.kind, PathKind::Outer | PathKind::Wall) || path.points.len() < 2 {
        return;
    }
    if !path.z_frac.is_empty() || !path.flow_frac.is_empty() {
        return;
    }
    path.points = fuzz_polyline(&path.points, mark.skin, mark.z);
}

fn fuzz_polyline(points: &[[f64; 2]], fuzzy: FuzzySkin, z: f64) -> Vec<[f64; 2]> {
    let mut length = 0.0;
    for w in points.windows(2) {
        length += hypot2(w[0], w[1]);
    }
    if length < fuzzy.point_distance * 1.5 {
        return points.to_vec();
    }
    let last = *points.last().unwrap();
    let mut out = vec![points[0]];
    let mut acc = 0.0;
    let mut next = fuzzy.point_distance;
    for w in points.windows(2) {
        let (a, b) = (w[0], w[1]);
        let dx = b[0] - a[0];
        let dy = b[1] - a[1];
        let seg = dx.hypot(dy);
        if seg < 1e-9 {
            continue;
        }
        while acc + seg + 1e-9 >= next && next < length - 1e-6 {
            let t = ((next - acc) / seg).clamp(0.0, 1.0);
            let sample = [a[0] + dx * t, a[1] + dy * t];
            let nx = -dy / seg;
            let ny = dx / seg;
            let n = fuzzy_noise(sample[0], sample[1], z);
            out.push([
                sample[0] + nx * n * fuzzy.thickness,
                sample[1] + ny * n * fuzzy.thickness,
            ]);
            next += fuzzy.point_distance;
        }
        acc += seg;
    }
    if hypot2(*out.last().unwrap(), last) > 1e-6 {
        out.push(last);
    } else {
        *out.last_mut().unwrap() = last;
    }
    out
}

fn hypot2(a: [f64; 2], b: [f64; 2]) -> f64 {
    (a[0] - b[0]).hypot(a[1] - b[1])
}

/// -1 to 1, stable for the same point and layer.
fn fuzzy_noise(x: f64, y: f64, z: f64) -> f64 {
    let s = (x * 12.9898 + y * 78.233 + z * 45.164).sin() * 43758.5453;
    // `fract` of a negative value stays negative, which would push the
    // offset past one thickness. `floor` keeps the fraction in [0, 1).
    let frac = s - s.floor();
    frac * 2.0 - 1.0
}

/// Skin pieces smaller than this are boolean noise along a skin edge, mm².
const SKIN_SLIVER_MM2: f64 = 0.05;

/// `area` split into what lies inside `skin` and the rest. A piece of the
/// rest no wider than `narrow` cannot hold a fill of its own and joins the
/// skin, as under a thin fin standing on a roof. An area all inside or all
/// outside keeps its own loops, so a layer that is all skin or has none
/// plans exactly as it did when skin was chosen layer by layer.
fn carve(area: &[Loop], skin: &[Loop], narrow: f64) -> (Vec<Loop>, Vec<Loop>) {
    if area.is_empty() || skin.is_empty() {
        return (Vec::new(), area.to_vec());
    }
    let cut = drop_slivers(boolean_diff(area, skin), SKIN_SLIVER_MM2);
    let rest: Vec<Loop> = island_loops(&cut)
        .into_iter()
        .filter(|piece| !offset_loops(piece, -narrow * 0.5).is_empty())
        .flatten()
        .collect();
    if rest.is_empty() {
        return (area.to_vec(), Vec::new());
    }
    let inside = drop_slivers(boolean_diff(area, &rest), SKIN_SLIVER_MM2);
    if inside.is_empty() {
        return (Vec::new(), area.to_vec());
    }
    (inside, rest)
}

fn ms_since(started: Instant) -> f64 {
    started.elapsed().as_secs_f64() * 1000.0
}

/// Fill contour area that no bead covers, outside `skip`.
/// A flared wing pinches between perimeters; that leftover used to stay empty.
fn emit_void_fill(
    paths: &mut Vec<Extrusion>,
    contours: &[Loop],
    skip: &[Loop],
    strategy: &ResolvedStrategy,
    line_width: f64,
    seam_hint: &mut [f64; 2],
) {
    let sample = crate::inner_prof::Sample::start();
    let cover_sample = crate::inner_prof::Sample::start();
    let cover = bead_cover(paths);
    cover_sample.void_cover(paths.len() as u64);
    let bool_sample = crate::inner_prof::Sample::start();
    let missed = if cover.is_empty() {
        contours.to_vec()
    } else {
        boolean_diff(contours, &cover)
    };
    let voids = boolean_diff(&missed, skip);
    bool_sample.void_bool();
    let island_sample = crate::inner_prof::Sample::start();
    let regions = island_loops(&voids);
    island_sample.void_island();
    let min_w = min_bead(line_width);
    // A void that reaches the outline is the part's skin there, so it is a wall.
    let core = offset_loops(contours, -line_width * 0.25);
    // One index for every void on this layer. A piece only meets the core
    // loops whose boxes overlap it, so the skin test does not rebuild the
    // whole core for each pocket.
    let mut core_near = OverlapIndex::build(&core);
    // Specks smaller than a square bead are clipping noise.
    let speck = min_w * min_w;
    let reach = line_width * 0.5;
    let mut near_bead: Option<Vec<Loop>> = None;
    // A void is an outline with the holes inside it. A ring-shaped void read
    // loop by loop is two discs, and its fill runs straight across the hole.
    for region in regions {
        let area = net_area(&region);
        if area < speck {
            continue;
        }
        let skin_sample = crate::inner_prof::Sample::start();
        let skin = outside_area(&region, &core, &mut core_near) > 0.01;
        skin_sample.void_skin();
        if !skin && area < 0.25 {
            continue;
        }
        // The fill reads the width only through these steps, so the search
        // stops once they agree at both ends of its bracket.
        let reading = |r: f64| (r >= 0.05, r * 2.0 >= min_w, void_rows(r * 2.0, line_width));
        let radius = inradius_until(&region, 8.0, |lo, hi| reading(lo) == reading(hi));
        // Under 0.1 mm the width probe reads nothing. Skin that thin is
        // where two faces cross, and still needs its bead.
        let width = if radius >= 0.05 {
            radius * 2.0
        } else if skin {
            0.0
        } else {
            continue;
        };
        let kind = if skin {
            PathKind::ThinWall
        } else {
            PathKind::GapFill
        };
        if width >= min_w {
            let rows = void_rows(width, line_width);
            fill_void_piece(paths, &region, rows, kind, strategy, line_width, seam_hint);
        } else if skin {
            // Skin thinner than the narrowest bead: a membrane whose faces
            // meet, or a spike tip past its wall. Where no bead is within
            // reach, dropping it opens a hole through the part, so print one
            // bead down its spine, a little proud of the model. The hairline
            // a wall leaves against a curved outline is within reach and stays.
            let near = near_bead.get_or_insert_with(|| offset_loops(&cover, reach));
            for bare in bare_stretches(&region, near, reach) {
                let spine = match bare.as_slice() {
                    [outline] => sliver_spine(outline, min_w),
                    _ => ring_spine(&bare),
                };
                if let Some(spine) = spine {
                    *seam_hint = *spine.last().unwrap();
                    paths.push(extrusion(kind, strategy, spine, line_width));
                }
            }
        }
    }
    sample.void_fill();
}

#[allow(clippy::too_many_arguments)]
fn fill_void_piece(
    paths: &mut Vec<Extrusion>,
    region: &[Loop],
    rows: f64,
    kind: PathKind,
    strategy: &ResolvedStrategy,
    line_width: f64,
    seam_hint: &mut [f64; 2],
) {
    // Rows run along the piece, centered on its centroid, so a pinch one bead
    // wide gets one continuous bead down the middle. Cross chords there are
    // short, and where they land follows the void's bounding box, which a 1 µm
    // move can reshape.
    let Some((center, angle)) = principal_axis(&region[0]) else {
        return;
    };
    let shift = if rows % 2.0 == 0.0 {
        line_width * 0.5
    } else {
        0.0
    };
    let through = [
        center[0] - angle.sin() * shift,
        center[1] + angle.cos() * shift,
    ];
    let hatched = clip_infill(solid_fill(region, line_width, angle, Some(through)), region);
    if hatched.is_empty() {
        let width = inradius(region, 8.0) * 2.0;
        fill_remaining(
            paths,
            &paths_from_loops(region),
            kind,
            strategy,
            line_width * 0.45,
            width.max(line_width),
            seam_hint,
        );
        return;
    }
    for pts in hatched {
        if pts.len() >= 2 {
            *seam_hint = *pts.last().unwrap();
            paths.push(extrusion(kind, strategy, pts, line_width));
        }
    }
}

/// Stretches of `sliver` farther than `reach` from every bead, grown back to
/// full length within the sliver so their bead meets the walls at each end.
/// Each is an outline with its holes.
fn bare_stretches(sliver: &[Loop], near_bead: &[Loop], reach: f64) -> Vec<Vec<Loop>> {
    let far = boolean_diff(sliver, near_bead);
    if far.iter().all(|l| signed_area(l).abs() < 1e-4) {
        return Vec::new();
    }
    island_loops(&boolean_intersect(&offset_loops(&far, reach), sliver))
}

/// Closed center line of a sliver that rings a hole: its outline pulled in by
/// half the sliver's mean width.
fn ring_spine(ring: &[Loop]) -> Option<Vec<[f64; 2]>> {
    let perimeter: f64 = ring.iter().map(closed_len).sum();
    let half = net_area(ring) / perimeter.max(1e-9);
    let outline = std::slice::from_ref(ring.first()?);
    let mut spine = offset_loops(outline, -half)
        .into_iter()
        .max_by(|a, b| closed_len(a).total_cmp(&closed_len(b)))
        .unwrap_or_else(|| outline[0].clone());
    spine.push(*spine.first()?);
    Some(spine)
}

fn closed_len(l: &Loop) -> f64 {
    polyline_len(l)
        + l.first()
            .zip(l.last())
            .map_or(0.0, |(a, b)| dist2(*a, *b).sqrt())
}

/// Area inside an outline and outside its holes.
fn net_area(region: &[Loop]) -> f64 {
    region.iter().map(|l| signed_area(l)).sum::<f64>().abs()
}

/// Rows of beads along a void piece `width` across.
fn void_rows(width: f64, line_width: f64) -> f64 {
    (width / line_width).round().max(1.0)
}

/// Center line of a sliver: split its outline at its two tips and average the
/// two sides point by point. A straight row would cut the corner of a curved
/// sliver and leave most of it bare.
///
/// A tip is where the outline folds back on itself: a short step either way
/// along it lands on the two faces, one sliver thickness apart. The two points
/// farthest apart are not the tips of a bent sliver. On a V they are one tip
/// and the heel, and averaging the short side with the long way round draws
/// the spine across the gap between the arms.
fn sliver_spine(ring: &[[f64; 2]], step: f64) -> Option<Vec<[f64; 2]>> {
    let n = ring.len();
    if n < 3 {
        return None;
    }
    let mut closed = ring.to_vec();
    closed.push(ring[0]);
    let perimeter = polyline_len(&closed);
    let mut at = Vec::with_capacity(n);
    let mut run = 0.0;
    for w in closed.windows(2) {
        at.push(run);
        run += dist2(w[0], w[1]).sqrt();
    }
    let reach = (step * 4.0).min(perimeter / 8.0);
    let on_ring = |s: f64| point_along(&closed, s.rem_euclid(perimeter));
    let fold: Vec<f64> = at
        .iter()
        .map(|&s| dist2(on_ring(s - reach), on_ring(s + reach)))
        .collect();
    let tightest = |allowed: &dyn Fn(usize) -> bool| {
        (0..n)
            .filter(|&k| allowed(k))
            .min_by(|&a, &b| fold[a].total_cmp(&fold[b]).then(a.cmp(&b)))
    };
    let i = tightest(&|_| true)?;
    // The other tip is at least a quarter of the way round, past the tip's own
    // corners.
    let apart = |k: usize| {
        let d = (at[k] - at[i]).abs();
        d.min(perimeter - d) >= perimeter * 0.25
    };
    let j = tightest(&apart)?;
    let walk = |from: usize, to: usize| {
        let mut side = vec![ring[from]];
        let mut k = from;
        while k != to {
            k = (k + 1) % n;
            side.push(ring[k]);
        }
        side
    };
    let a = walk(i, j);
    let mut b = walk(j, i);
    b.reverse();
    let length = polyline_len(&a).max(polyline_len(&b));
    if length < step {
        return None;
    }
    let samples = (length / step).ceil() as usize + 1;
    let (la, lb) = (polyline_len(&a), polyline_len(&b));
    Some(
        (0..samples)
            .map(|k| {
                let t = k as f64 / (samples - 1) as f64;
                let (p, q) = (point_along(&a, la * t), point_along(&b, lb * t));
                [(p[0] + q[0]) * 0.5, (p[1] + q[1]) * 0.5]
            })
            .collect(),
    )
}

/// The part of `region` at least `width` across. The eroded core grows back
/// by sqrt(2) times the erosion, so a right-angle corner stays whole; a sharper
/// corner is a taper tip and stays out.
fn wide_part(region: &[Loop], width: f64) -> Vec<Loop> {
    let core = offset_loops(region, -width * 0.5);
    if core.is_empty() {
        return Vec::new();
    }
    boolean_intersect(
        &offset_loops(&core, width * 0.5 * std::f64::consts::SQRT_2),
        region,
    )
}

/// Core loops whose boxes can meet a query box. A loop that misses every
/// cell of the query misses the query, same as scanning every box.
struct OverlapIndex {
    cell: f64,
    origin: [f64; 2],
    nx: usize,
    ny: usize,
    /// `None` buckets means the bounds were too wide for a grid, so `hits`
    /// scans `boxes` directly.
    buckets: Option<Vec<Vec<usize>>>,
    boxes: Vec<Option<([f64; 2], [f64; 2])>>,
    seen: Vec<u32>,
    stamp: u32,
}

impl OverlapIndex {
    fn build(loops: &[Loop]) -> Self {
        let cell = 8.0;
        let mut boxes = Vec::with_capacity(loops.len());
        let mut lo = [f64::INFINITY; 2];
        let mut hi = [f64::NEG_INFINITY; 2];
        for loop_ in loops {
            let bounds = loop_bounds(std::slice::from_ref(loop_));
            if let Some((a, b)) = bounds {
                lo[0] = lo[0].min(a[0]);
                lo[1] = lo[1].min(a[1]);
                hi[0] = hi[0].max(b[0]);
                hi[1] = hi[1].max(b[1]);
            }
            boxes.push(bounds);
        }
        let n = loops.len();
        if !lo[0].is_finite() {
            return Self {
                cell,
                origin: [0.0; 2],
                nx: 0,
                ny: 0,
                buckets: Some(Vec::new()),
                boxes,
                seen: vec![0; n],
                stamp: 0,
            };
        }
        let nx = (((hi[0] - lo[0]) / cell).floor() as usize).saturating_add(1);
        let ny = (((hi[1] - lo[1]) / cell).floor() as usize).saturating_add(1);
        if nx > 512 || ny > 512 || nx.saturating_mul(ny) > 20_000 {
            return Self {
                cell,
                origin: lo,
                nx: 0,
                ny: 0,
                buckets: None,
                boxes,
                seen: vec![0; n],
                stamp: 0,
            };
        }
        let mut buckets = vec![Vec::new(); nx * ny];
        for (i, bounds) in boxes.iter().enumerate() {
            let Some((a, b)) = bounds else {
                continue;
            };
            let x0 = ((a[0] - lo[0]) / cell).floor() as usize;
            let x1 = ((b[0] - lo[0]) / cell).floor() as usize;
            let y0 = ((a[1] - lo[1]) / cell).floor() as usize;
            let y1 = ((b[1] - lo[1]) / cell).floor() as usize;
            for y in y0..=y1.min(ny - 1) {
                for x in x0..=x1.min(nx - 1) {
                    buckets[y * nx + x].push(i);
                }
            }
        }
        Self {
            cell,
            origin: lo,
            nx,
            ny,
            buckets: Some(buckets),
            boxes,
            seen: vec![0; n],
            stamp: 0,
        }
    }

    /// Clip loops whose box overlaps `min`/`max`, in ascending loop index.
    fn hits(&mut self, min: [f64; 2], max: [f64; 2]) -> Vec<usize> {
        self.stamp = self.stamp.wrapping_add(1);
        if self.stamp == 0 {
            self.seen.fill(0);
            self.stamp = 1;
        }
        let stamp = self.stamp;
        let candidates: Vec<usize> = if let Some(buckets) = &self.buckets {
            if self.nx == 0 || buckets.is_empty() {
                Vec::new()
            } else {
                let x0 = (((min[0] - self.origin[0]) / self.cell).floor() as isize)
                    .clamp(0, self.nx as isize - 1) as usize;
                let x1 = (((max[0] - self.origin[0]) / self.cell).floor() as isize)
                    .clamp(0, self.nx as isize - 1) as usize;
                let y0 = (((min[1] - self.origin[1]) / self.cell).floor() as isize)
                    .clamp(0, self.ny as isize - 1) as usize;
                let y1 = (((max[1] - self.origin[1]) / self.cell).floor() as isize)
                    .clamp(0, self.ny as isize - 1) as usize;
                let mut ids = Vec::new();
                for y in y0..=y1 {
                    for x in x0..=x1 {
                        ids.extend_from_slice(&buckets[y * self.nx + x]);
                    }
                }
                ids
            }
        } else {
            (0..self.boxes.len()).collect()
        };
        let mut out = Vec::new();
        for i in candidates {
            let Some((a, b)) = self.boxes[i] else {
                continue;
            };
            if self.seen[i] == stamp {
                continue;
            }
            self.seen[i] = stamp;
            if a[0] <= max[0] && min[0] <= b[0] && a[1] <= max[1] && min[1] <= b[1] {
                out.push(i);
            }
        }
        out.sort_unstable();
        out
    }
}

fn edge_box_meets(a: [f64; 2], b: [f64; 2], min: [f64; 2], max: [f64; 2]) -> bool {
    let (ex0, ex1) = if a[0] <= b[0] {
        (a[0], b[0])
    } else {
        (b[0], a[0])
    };
    let (ey0, ey1) = if a[1] <= b[1] {
        (a[1], b[1])
    } else {
        (b[1], a[1])
    };
    ex0 <= max[0] && min[0] <= ex1 && ey0 <= max[1] && min[1] <= ey1
}

/// Area of `piece` outside `clip`. Matches `net_area(boolean_diff(piece, clip))`:
/// a clip loop whose box misses the piece cannot remove any of it, and a piece
/// that meets no clip edge is entirely inside or entirely outside.
fn outside_area(piece: &[Loop], clip: &[Loop], index: &mut OverlapIndex) -> f64 {
    let Some((min, max)) = loop_bounds(piece) else {
        return 0.0;
    };
    let hits = index.hits(min, max);
    if hits.is_empty() {
        return net_area(piece);
    }
    let touches = hits.iter().any(|&i| {
        let loop_ = &clip[i];
        let n = loop_.len();
        (0..n).any(|k| edge_box_meets(loop_[k], loop_[(k + 1) % n], min, max))
    });
    if !touches {
        let Some(&p) = piece.iter().find_map(|l| l.first()) else {
            return 0.0;
        };
        let inside = hits
            .iter()
            .filter(|&&i| point_in_loop(&clip[i], p[0], p[1]))
            .count()
            % 2
            == 1;
        return if inside { 0.0 } else { net_area(piece) };
    }
    net_area(&boolean_diff_indexed(piece, clip, &hits))
}

fn boolean_diff_indexed(subject: &[Loop], clip: &[Loop], which: &[usize]) -> Vec<Loop> {
    if subject.is_empty() || which.is_empty() {
        return subject.to_vec();
    }
    let raw: Vec<Vec<(f64, f64)>> = which
        .iter()
        .filter_map(|&i| clip.get(i))
        .map(|l| l.iter().map(|p| (p[0], p[1])).collect())
        .collect();
    if raw.is_empty() {
        return subject.to_vec();
    }
    let clip_paths: Paths<Milli> = raw.into();
    match paths_from_loops(subject)
        .to_clipper_subject()
        .add_clip(clip_paths)
        .difference(FillRule::NonZero)
    {
        Ok(paths) => loops_from_paths(paths),
        Err(_) => Vec::new(),
    }
}

pub(crate) fn bead_cover(paths: &[Extrusion]) -> Vec<Loop> {
    let mut acc = Vec::new();
    for path in paths {
        if path.points.len() < 2 || path.width <= 1e-6 {
            continue;
        }
        // Square end-caps stroke the centerline. A polygon offset would fill
        // the loop interior and hide the pinch between walls.
        let raw: Vec<Vec<(f64, f64)>> = vec![path.points.iter().map(|p| (p[0], p[1])).collect()];
        let stroked: Paths<Milli> = raw.into();
        let grown = stroked.inflate(path.width * 0.5, JoinType::Round, EndType::Square, 2.0);
        acc.extend(loops_from_paths(grown));
    }
    union_loops(&acc)
}

fn union_loops(loops: &[Loop]) -> Vec<Loop> {
    if loops.is_empty() {
        return Vec::new();
    }
    let empty: Paths<Milli> = Paths::default();
    match paths_from_loops(loops)
        .to_clipper_subject()
        .add_clip(empty)
        .union(FillRule::NonZero)
    {
        Ok(paths) => loops_from_paths(paths),
        Err(_) => loops.to_vec(),
    }
}

/// Combined sparse height, or `None` when this interior layer is covered by a later bead.
///
/// Groups are aligned to the next solid shell so the layer under that shell always prints.
/// Bead height is `span × layer height`, capped near `0.75 ×` the nozzle diameter.
fn combine_bead(strategy: &ResolvedStrategy, features: &PathFeatures) -> Option<f64> {
    let h = features.layer_height.max(0.05);
    if features.shell != ShellBand::Interior || solid_infill(strategy) {
        return Some(h);
    }
    let nozzle = features.nozzle_diameter.max(0.2);
    // 3D gyroid may stack two nominal layers when that bead stays within the nozzle.
    // Other patterns keep the 0.75 × nozzle cap.
    let cap = if strategy.gyroid_3d && strategy.pattern == InfillPattern::Gyroid {
        nozzle
    } else {
        0.75 * nozzle
    };
    let max_n = ((cap / h).floor() as u32).max(1);
    let every = strategy.infill_combine.max(1).min(max_n);
    if every <= 1 {
        return Some(h);
    }
    let rem = features.interior_remaining.max(1);
    let run = features.interior_run.max(rem);
    let from_end = rem - 1;
    let last = {
        let m = run % every;
        if m == 0 {
            every
        } else {
            m
        }
    };
    let span = if from_end < last {
        if from_end != 0 {
            return None;
        }
        last
    } else {
        let pos = from_end - last;
        if pos % every != 0 {
            return None;
        }
        every
    };
    Some(h * span as f64)
}

/// Density from which the infill is solid. Lines are already at their
/// closest spacing from 95%, so this only drops the gaps and any crossing.
/// The Infill % fields step by whole percents, so 99 and 100 both land here.
const SOLID_DENSITY: f64 = 0.99;

/// Infill that fills the whole region, whatever the pattern.
fn solid_infill(strategy: &ResolvedStrategy) -> bool {
    strategy.infill_density >= SOLID_DENSITY - 1e-9
}

fn infill_kind(strategy: &ResolvedStrategy, shell: ShellBand) -> PathKind {
    if !strategy.feature_speeds {
        return PathKind::Infill;
    }
    match shell {
        ShellBand::Top => PathKind::Top,
        ShellBand::Bottom => PathKind::Solid,
        ShellBand::Interior => PathKind::Sparse,
    }
}

fn wall_kind(outer: bool, strategy: &ResolvedStrategy) -> PathKind {
    if !strategy.feature_speeds {
        PathKind::Wall
    } else if outer {
        PathKind::Outer
    } else {
        PathKind::Inner
    }
}

fn infill_kept(strategy: &ResolvedStrategy, features: &PathFeatures) -> bool {
    // Grown lightning prints only the branches some skin needs.
    (strategy.pattern == InfillPattern::Lightning && features.lightning.is_some())
        || strategy.lightning_range_mm <= 1e-6
        || features.roof_distance_mm <= strategy.lightning_range_mm + 1e-6
}

/// Narrowest bead the planner will lay down.
fn min_bead(line_width: f64) -> f64 {
    (line_width * 0.45).max(0.2)
}

fn might_be_thin(contours: &[Loop], nominal_stack: f64) -> bool {
    let Some((min, max)) = loop_bounds(contours) else {
        return false;
    };
    let dx = max[0] - min[0];
    let dy = max[1] - min[1];
    dx.min(dy) < nominal_stack * 1.4
}

fn feature_width(contours: &[Loop]) -> Option<f64> {
    let outers: Vec<Loop> = contours
        .iter()
        .filter(|l| signed_area(l) > 0.0)
        .cloned()
        .collect();
    if outers.is_empty() {
        return None;
    }
    let radius = inradius(&outers, 8.0);
    if radius < 0.05 {
        None
    } else {
        Some(radius * 2.0)
    }
}

fn inradius(loops: &[Loop], cap: f64) -> f64 {
    inradius_until(loops, cap, |_, _| false)
}

/// The bisection of [`inradius`], stopped once `settled(lo, hi)`. The full
/// search ends in `[lo, hi)`, so a caller that reads the radius through steps
/// that only rise with it, equal at `lo` and `hi`, reads the same from `lo`.
fn inradius_until(loops: &[Loop], cap: f64, settled: impl Fn(f64, f64) -> bool) -> f64 {
    let paths = paths_from_loops(loops);
    let mut lo = 0.0;
    let mut hi = cap;
    if loops_from_paths(offset_paths(&paths, -0.05)).is_empty() {
        return 0.0;
    }
    // No interior point is farther from the boundary than half the smaller
    // side of the bounds, so a probe past that is empty and can be skipped.
    // The kept probes are the same midpoints as the full search.
    let limit = loop_bounds(loops)
        .map(|(mn, mx)| (mx[0] - mn[0]).min(mx[1] - mn[1]) * 0.5)
        .unwrap_or(cap);
    for _ in 0..14 {
        if settled(lo, hi) {
            break;
        }
        let mid = (lo + hi) * 0.5;
        if mid > limit || loops_from_paths(offset_paths(&paths, -mid)).is_empty() {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    lo
}

#[allow(clippy::too_many_arguments)]
fn emit_variable_feature(
    paths: &mut Vec<Extrusion>,
    contours: &[Loop],
    strategy: &ResolvedStrategy,
    width: f64,
    min_w: f64,
    max_w: f64,
    seam_hint: &mut [f64; 2],
    features: &PathFeatures,
) {
    let nominal = max_w / 1.30;
    let n = bead_count(width, nominal, strategy.walls.max(1), min_w, max_w);
    let bead = (width / n as f64).clamp(min_w, max_w.max(min_w));
    let outers: Vec<Loop> = contours
        .iter()
        .filter(|l| signed_area(l) > 0.0)
        .cloned()
        .collect();
    for i in 0..n {
        let inset = bead * 0.5 + bead * i as f64;
        let loops = loops_from_paths(offset_paths(&paths_from_loops(&outers), -inset));
        if loops.is_empty() {
            if i == 0 {
                emit_loops(
                    paths,
                    &outers,
                    PathKind::ThinWall,
                    strategy,
                    bead,
                    seam_hint,
                );
            }
            break;
        }
        let kind = if n == 1 {
            PathKind::ThinWall
        } else {
            wall_kind(i == 0, strategy)
        };
        let first = paths.len();
        emit_loops(paths, &loops, kind, strategy, bead, seam_hint);
        if i == 0 {
            mark_outer_walls(&mut paths[first..], features);
        }
    }
}

fn bead_count(width: f64, nominal: f64, max_walls: u32, min_w: f64, max_w: f64) -> u32 {
    let min_n = (width / max_w).ceil().max(1.0) as u32;
    let max_n = ((width / min_w).floor() as u32)
        .max(1)
        .min(max_walls.max(1));
    let ideal = (width / nominal.max(0.05)).round().max(1.0) as u32;
    ideal.clamp(min_n, max_n.max(min_n))
}

fn fill_remaining(
    paths: &mut Vec<Extrusion>,
    current: &Paths<Milli>,
    kind: PathKind,
    strategy: &ResolvedStrategy,
    min_w: f64,
    max_w: f64,
    seam_hint: &mut [f64; 2],
) {
    let loops = loops_from_paths(current.clone());
    let Some(width) = feature_width(&loops) else {
        return;
    };
    if width < min_w || width > max_w * 1.15 {
        return;
    }
    let center = loops_from_paths(offset_paths(current, -width * 0.5));
    if center.is_empty() {
        emit_loops(paths, &loops, kind, strategy, width, seam_hint);
    } else {
        emit_loops(paths, &center, kind, strategy, width, seam_hint);
    }
}

fn emit_gap_fill(
    paths: &mut Vec<Extrusion>,
    infill_loops: &[Loop],
    strategy: &ResolvedStrategy,
    line_width: f64,
    min_w: f64,
    max_w: f64,
    seam_hint: &mut [f64; 2],
) {
    if infill_loops.is_empty() || !might_be_thin(infill_loops, line_width * 3.0) {
        return;
    }
    let eroded = offset_paths(&paths_from_loops(infill_loops), -line_width * 0.55);
    if loops_from_paths(eroded.clone()).is_empty() {
        return;
    }
    let grown = offset_paths(&eroded, line_width * 0.55);
    let gaps = boolean_diff(infill_loops, &loops_from_paths(grown));
    for gap in gaps {
        let region = [gap];
        let Some(width) = feature_width(&region) else {
            continue;
        };
        if !(min_w..=max_w).contains(&width) {
            continue;
        }
        // Long thin membrane gaps (a wing taper) can be tens of mm². Area is not a cap.
        if signed_area(&region[0]).abs() < 0.4 {
            continue;
        }
        fill_remaining(
            paths,
            &paths_from_loops(&region),
            PathKind::GapFill,
            strategy,
            min_w,
            max_w,
            seam_hint,
        );
    }
}

pub fn plan_skirt(
    contours: &[Loop],
    strategy: &ResolvedStrategy,
    line_width: f64,
) -> Vec<Extrusion> {
    let outers: Vec<Loop> = contours
        .iter()
        .filter(|l| signed_area(l) > 0.0)
        .cloned()
        .collect();
    if outers.is_empty() {
        return Vec::new();
    }
    let mut acc = Vec::new();
    let mut hint = [0.0, 0.0];
    for i in 0..strategy.skirt_loops {
        let grown = offset_paths(&paths_from_loops(&outers), line_width * (i as f64 + 1.0));
        let loops = loops_from_paths(grown);
        emit_loops(
            &mut acc,
            &loops,
            PathKind::Skirt,
            strategy,
            line_width,
            &mut hint,
        );
    }
    acc
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

fn seam_rotate(loop_: &[[f64; 2]], mode: SeamMode, hint: [f64; 2]) -> Vec<[f64; 2]> {
    if loop_.is_empty() {
        return Vec::new();
    }
    let idx = match mode {
        SeamMode::Aligned => aligned_seam(loop_),
        SeamMode::Nearest => nearest_seam(loop_, hint),
        SeamMode::Rear => rear_seam(loop_),
    };
    let mut pts: Vec<[f64; 2]> = loop_[idx..]
        .iter()
        .chain(loop_[..idx].iter())
        .copied()
        .collect();
    if let Some(first) = pts.first().copied() {
        pts.push(first);
    }
    pts
}

/// The sharpest real corner, ties to +X, or the +X vertex when the loop has
/// no corner. A smooth curve's sharpest vertex is only a kink that moves from
/// layer to layer, so the seam would not stack.
fn aligned_seam(ring: &[[f64; 2]]) -> usize {
    let corner = sharpest_near(ring, |p| -p[0], f64::MAX);
    if real_corner(turn_penalty(ring, corner)) {
        return corner;
    }
    ring.iter()
        .enumerate()
        .fold(
            (0, f64::MIN),
            |best, (i, p)| if p[0] > best.1 { (i, p[0]) } else { best },
        )
        .0
}

/// The sharpest real corner within 1 mm of the loop's back, ties to +X, or
/// the rear-most vertex, ties to +X. The slice turns the part before it
/// cuts and only moves it after, so the part frame's +Y is the bed's back.
fn rear_seam(ring: &[[f64; 2]]) -> usize {
    let back = ring.iter().fold(f64::MIN, |y, p| y.max(p[1]));
    let in_band = |p: [f64; 2]| {
        if p[1] >= back - 1.0 {
            -p[0]
        } else {
            f64::INFINITY
        }
    };
    let corner = sharpest_near(ring, in_band, f64::MAX);
    if real_corner(turn_penalty(ring, corner)) {
        return corner;
    }
    ring.iter()
        .enumerate()
        .fold((0, [f64::MIN; 2]), |best, (i, p)| {
            if p[1] > best.1[1] || (p[1] == best.1[1] && p[0] > best.1[0]) {
                (i, *p)
            } else {
                best
            }
        })
        .0
}

/// A turn of at least 30°, convex or concave, by `turn_penalty`'s scale.
fn real_corner(turn: f64) -> bool {
    turn <= 0.5 || (2.0..=2.0 + 30f64.to_radians().cos()).contains(&turn)
}

/// The sharpest corner close to the vertex nearest `hint`, or that vertex
/// when nothing close turns at least 30°. On a smooth curve the "sharpest"
/// vertex is only a kink in the polyline, and starting there splits an arc.
fn nearest_seam(ring: &[[f64; 2]], hint: [f64; 2]) -> usize {
    let (near_at, nearest) = ring
        .iter()
        .enumerate()
        .map(|(i, p)| (i, dist2(*p, hint)))
        .fold(
            (0, f64::MAX),
            |best, cur| if cur.1 < best.1 { cur } else { best },
        );
    let corner = sharpest_near(ring, |p| dist2(p, hint), nearest + 1.6 * 1.6);
    if real_corner(turn_penalty(ring, corner)) {
        corner
    } else {
        near_at
    }
}

fn dist2(a: [f64; 2], b: [f64; 2]) -> f64 {
    let dx = a[0] - b[0];
    let dy = a[1] - b[1];
    dx * dx + dy * dy
}

fn gyroid_3d_graded(
    loops: &[Loop],
    strategy: &ResolvedStrategy,
    spacing: f64,
    features: &PathFeatures,
) -> Vec<Vec<[f64; 2]>> {
    let period = crate::gyroid::period_for_spacing(spacing);
    // 0.04 mm keeps the TPMS long enough to score, and still circular enough
    // to collapse into G2/G3. A looser 0.08 mm kinked the curve into short chords.
    let tol = 0.04;
    let skin = strategy.gyroid_skin_mm.max(0.0);
    let ratio = strategy.gyroid_core_ratio.clamp(0.35, 1.0);
    let near_roof = features.shell != ShellBand::Interior
        || features.roof_distance_mm <= skin.max(1.6) + features.layer_height;
    if near_roof || skin < 0.4 || ratio >= 0.995 {
        return crate::gyroid::section(loops, period, features.z, tol);
    }
    let core = inset_loops(loops, skin);
    if core.is_empty() {
        return crate::gyroid::section(loops, period, features.z, tol);
    }
    let band = drop_slivers(boolean_diff(loops, &core), 0.8);
    let mut paths = if band.is_empty() {
        Vec::new()
    } else {
        crate::gyroid::section(&band, period, features.z, tol)
    };
    let core_spacing = (spacing / ratio).clamp(spacing, 14.0);
    let core_period = crate::gyroid::period_for_spacing(core_spacing);
    paths.extend(crate::gyroid::section(&core, core_period, features.z, tol));
    paths
}

fn inset_loops(loops: &[Loop], delta: f64) -> Vec<Loop> {
    if delta <= 0.05 || loops.is_empty() {
        return Vec::new();
    }
    let paths = paths_from_loops(loops);
    drop_slivers(loops_from_paths(offset_paths(&paths, -delta)), 0.8)
}

/// Grid pitch of `strategy`'s lightning at its full density, mm.
pub(crate) fn lightning_pitch(strategy: &ResolvedStrategy, line_width: f64) -> f64 {
    let spacing = (line_width / strategy.infill_density.max(0.02)).clamp(line_width * 1.05, 14.0);
    spacing.max(line_width * 3.0)
}

fn build_infill(
    loops: &[Loop],
    strategy: &ResolvedStrategy,
    line_width: f64,
    features: &PathFeatures,
) -> Vec<Vec<[f64; 2]>> {
    if solid_infill(strategy) {
        // Rows turn a quarter each layer, so no layer's lines cross.
        let quarters = if features.layer_index % 2 == 0 { 1.0 } else { 3.0 };
        let angle = std::f64::consts::FRAC_PI_4 * quarters;
        return solid_rows(loops, line_width, angle);
    }
    let sample = crate::inner_prof::Sample::start();
    let mut density = strategy.infill_density;
    let grown = features
        .lightning
        .as_ref()
        .filter(|_| strategy.pattern == InfillPattern::Lightning);
    if grown.is_none()
        && strategy.pattern == InfillPattern::Lightning
        && strategy.lightning_range_mm > 1e-6
    {
        let t = 1.0 - (features.roof_distance_mm / strategy.lightning_range_mm).clamp(0.0, 1.0);
        density *= 0.30 + 0.70 * t;
    }
    let spacing = (line_width / density.max(0.02)).clamp(line_width * 1.05, 14.0);
    let paths = match strategy.pattern {
        InfillPattern::Lines => {
            clip_infill(serpentine(scan_angle(loops, spacing, 0.0), loops), loops)
        }
        InfillPattern::Grid => {
            // Two sets of lines, so each set covers half the density.
            let spacing = (spacing * 2.0).min(14.0);
            let mut paths = serpentine(scan_angle(loops, spacing, 0.0), loops);
            paths.extend(serpentine(
                scan_angle(loops, spacing, std::f64::consts::FRAC_PI_2),
                loops,
            ));
            clip_infill(paths, loops)
        }
        InfillPattern::Gyroid => {
            let paths = if strategy.gyroid_3d {
                gyroid_3d_graded(loops, strategy, spacing, features)
            } else {
                gyroid(loops, spacing, strategy.toughness)
            };
            clip_infill(paths, loops)
        }
        InfillPattern::Lightning => match grown {
            Some(branches) => {
                // Join only branch ends that meet. A weld across a gap would
                // be a bead no branch on the layer below holds up.
                let segs = branches.iter().map(|s| s.to_vec()).collect();
                chain_ends(
                    clip_infill(segs, loops),
                    lightning_pitch(strategy, line_width) * 1.25,
                    Some(loops),
                )
            }
            None => clip_infill(lightning(loops, spacing.max(line_width * 3.0)), loops),
        },
    };
    match strategy.pattern {
        InfillPattern::Lines => sample.lines(),
        InfillPattern::Grid => sample.grid(),
        InfillPattern::Gyroid => sample.gyroid(),
        InfillPattern::Lightning => sample.lightning(),
    }
    paths
}

/// Ironing over `area`: lines `spacing` apart along Y, 45° off the top
/// skin's lines as PrusaSlicer irons, at a `flow` fraction of a top line's
/// extrusion and at the ironing speed.
pub fn plan_ironing(
    area: &[Loop],
    strategy: &ResolvedStrategy,
    line_width: f64,
    ironing: &Ironing,
) -> Vec<Extrusion> {
    let rows = solid_fill(area, ironing.spacing, std::f64::consts::FRAC_PI_2, None);
    // The links between rows run along the outline, where clipping to the
    // outline itself drops every other one. Ten microns of slack keep them
    // and still cut a link across a gap.
    clip_infill(rows, &offset_loops(area, 0.01))
        .into_iter()
        .map(|pts| {
            let mut path = extrusion(PathKind::Ironing, strategy, pts, line_width);
            path.flow = ironing.flow;
            path.speed = ironing.speed;
            path
        })
        .collect()
}

/// Drop any infill chord that leaves the region, including arc-fit bulges and
/// links that were chained across a gap between separate contours.
fn clip_infill(paths: Vec<Vec<[f64; 2]>>, loops: &[Loop]) -> Vec<Vec<[f64; 2]>> {
    let outline = Outline::new(loops);
    let mut out = Vec::new();
    for path in paths {
        if path.len() < 2 {
            continue;
        }
        out.extend(clip_polyline(&outline, &path));
    }
    out
}

fn sharpest_near(loop_: &[[f64; 2]], cost: impl Fn([f64; 2]) -> f64, max_cost: f64) -> usize {
    let n = loop_.len();
    let mut best = 0usize;
    let mut best_key = (f64::MAX, f64::MAX);
    for i in 0..n {
        let c = cost(loop_[i]);
        if c > max_cost {
            continue;
        }
        let turn = turn_penalty(loop_, i);
        if turn < best_key.0 - 1e-9 || ((turn - best_key.0).abs() <= 1e-9 && c < best_key.1) {
            best_key = (turn, c);
            best = i;
        }
    }
    if best_key.0.is_finite() {
        best
    } else {
        loop_
            .iter()
            .enumerate()
            .min_by(|(_, a), (_, b)| cost(**a).total_cmp(&cost(**b)))
            .map(|(i, _)| i)
            .unwrap_or(0)
    }
}

/// Smaller is a sharper convex corner. Straight vertices sort last.
fn turn_penalty(loop_: &[[f64; 2]], i: usize) -> f64 {
    let n = loop_.len();
    let a = loop_[(i + n - 1) % n];
    let b = loop_[i];
    let c = loop_[(i + 1) % n];
    let abx = b[0] - a[0];
    let aby = b[1] - a[1];
    let bcx = c[0] - b[0];
    let bcy = c[1] - b[1];
    let abn = abx.hypot(aby).max(1e-9);
    let bcn = bcx.hypot(bcy).max(1e-9);
    let cross = abx * bcy - aby * bcx;
    let dot = (abx * bcx + aby * bcy) / (abn * bcn);
    if cross <= 0.0 {
        return 2.0 + dot;
    }
    1.0 - cross.abs() / (abn * bcn)
}

fn lightning(loops: &[Loop], spacing: f64) -> Vec<Vec<[f64; 2]>> {
    let outline = Outline::new(loops);
    let Some((min, max)) = loop_bounds(loops) else {
        return Vec::new();
    };
    let seed = crate::inner_prof::Sample::start();
    let mut boundary = Vec::new();
    for loop_ in loops {
        if signed_area(loop_) <= 0.0 {
            continue;
        }
        let mut acc = 0.0;
        let n = loop_.len();
        for i in 0..n {
            let a = loop_[i];
            let b = loop_[(i + 1) % n];
            let len = dist2(a, b).sqrt();
            if i == 0 || acc >= 1.4 {
                boundary.push(a);
                acc = 0.0;
            }
            acc += len;
        }
    }
    if boundary.is_empty() {
        return Vec::new();
    }
    let mut interior = Vec::new();
    let mut y = min[1] + spacing * 0.5;
    while y < max[1] {
        let mut x = min[0] + spacing * 0.5;
        while x < max[0] {
            if in_solid(loops, x, y) {
                interior.push([x, y]);
            }
            x += spacing;
        }
        y += spacing;
    }
    if interior.is_empty() {
        return Vec::new();
    }
    let dist_b = |p: [f64; 2]| {
        boundary
            .iter()
            .map(|q| dist2(p, *q))
            .fold(f64::MAX, f64::min)
    };
    let mut nodes = boundary.clone();
    nodes.extend(interior.iter().copied());
    let bcount = boundary.len();
    let mut dist: Vec<f64> = nodes.iter().map(|p| dist_b(*p)).collect();
    for d in dist.iter_mut().take(bcount) {
        *d = 0.0;
    }
    seed.lightning_seed(nodes.len() as u64);
    let nn = crate::inner_prof::Sample::start();
    let reach2 = (spacing * 2.4) * (spacing * 2.4);
    let mut picks = Vec::new();
    for i in bcount..nodes.len() {
        let mut best = 0usize;
        let mut best_d = f64::MAX;
        for j in 0..nodes.len() {
            if i == j || dist[j] >= dist[i] - 1e-6 {
                continue;
            }
            let d = dist2(nodes[i], nodes[j]);
            if d < best_d {
                best_d = d;
                best = j;
            }
        }
        if best_d < reach2 {
            picks.push((i, best));
        }
    }
    nn.lightning_nn(nodes.len() as u64);
    let link = crate::inner_prof::Sample::start();
    let mut segs = Vec::new();
    for (i, best) in picks {
        let piece = outline.clip_segment(nodes[i], nodes[best]);
        for seg in piece {
            segs.push(vec![seg[0], seg[1]]);
        }
    }
    // Weld shared nodes and short in-part gaps so each capped layer is one
    // polyline. The gap is inside the part, so it does not cross a hole.
    let chained = chain_ends(segs, spacing * 1.25, Some(loops));
    link.lightning_link();
    chained
}

/// Rows shorter than this end before the head reaches its feed, and each
/// turn costs about as much as the row.
const SOLID_ROW_MM: f64 = 10.0;

/// Solid rows over `loops`, at `base` where they run long. A stretch only a
/// few beads wide, like the wall of a cover, would take a turn every few
/// millimetres at `base`, so it prints along its length: the longest edges of
/// the region name those directions, and each takes the rows of at least
/// `SOLID_ROW_MM` it finds in what the last left. Rows that all run long
/// print as one region at `base`.
fn solid_rows(loops: &[Loop], spacing: f64, base: f64) -> Vec<Vec<[f64; 2]>> {
    let mut rest = loops.to_vec();
    let mut paths = Vec::new();
    for angle in std::iter::once(base).chain(long_edge_angles(loops, base)) {
        let chords = horizontal_chords(&rotate_loops(&rest, -angle), spacing, None);
        let (mut long, mut short) = (0.0, 0.0);
        for (x0, x1) in chords.iter().flat_map(|(_, spans)| spans) {
            if x1 - x0 >= SOLID_ROW_MM {
                long += x1 - x0;
            } else {
                short += x1 - x0;
            }
        }
        if long == 0.0 {
            continue;
        }
        if short == 0.0 {
            paths.extend(clip_infill(solid_fill(&rest, spacing, angle, None), &rest));
            return paths;
        }
        let half = spacing * 0.5;
        let mut rows = Vec::new();
        for (y, spans) in &chords {
            for &(x0, x1) in spans.iter().filter(|(x0, x1)| x1 - x0 >= SOLID_ROW_MM) {
                rows.push(
                    [
                        [x0, y - half],
                        [x1, y - half],
                        [x1, y + half],
                        [x0, y + half],
                    ]
                    .map(|p| rot(p, angle))
                    .to_vec(),
                );
            }
        }
        // Grown by a row, so the bare edge a stretch's rows leave is its own.
        let taken = boolean_intersect(&offset_loops(&resolve_nonzero(rows), spacing), &rest);
        let whole = rest.clone();
        rest = drop_slivers(boolean_diff(&rest, &taken), SKIN_SLIVER_MM2);
        for piece in island_loops(&taken) {
            let (pitch, through) = fit_rows(&piece, &whole, angle, spacing);
            paths.extend(clip_infill(
                solid_fill(&piece, pitch, angle, through),
                &piece,
            ));
        }
    }
    if !rest.is_empty() {
        paths.extend(clip_infill(solid_fill(&rest, spacing, base, None), &rest));
    }
    paths
}

/// Row pitch and grid for a stretch `piece` of `region` that runs along
/// `angle`. A stretch only a few beads wide takes a whole number of rows, laid
/// edge to edge, so it has no bare edge. Wider ones keep `spacing`.
fn fit_rows(piece: &[Loop], region: &[Loop], angle: f64, spacing: f64) -> (f64, Option<[f64; 2]>) {
    let Some((lo, hi)) = loop_bounds(&rotate_loops(piece, -angle)) else {
        return (spacing, None);
    };
    // Across the stretch at its middle: a scan line square to the rows.
    let across = angle + std::f64::consts::FRAC_PI_2;
    let at = (lo[0] + hi[0]) * 0.5;
    let line = horizontal_chords(&rotate_loops(region, -across), 1e9, Some(-at));
    let mid = (lo[1] + hi[1]) * 0.5;
    let Some(&(a, b)) = line
        .iter()
        .flat_map(|(_, spans)| spans)
        .find(|(a, b)| *a <= mid && mid <= *b)
    else {
        return (spacing, None);
    };
    let width = b - a;
    if width >= spacing * 6.0 {
        return (spacing, None);
    }
    let pitch = width / (width / spacing).round().max(1.0);
    (pitch, Some(rot([at, a + pitch * 0.5], angle)))
}

/// Directions of the longest edges of `loops`, at most two, each at least 20
/// degrees from `base` and from each other.
fn long_edge_angles(loops: &[Loop], base: f64) -> Vec<f64> {
    use std::f64::consts::PI;
    let mut edges: Vec<(f64, f64)> = loops
        .iter()
        .flat_map(|l| l.iter().zip(l.iter().cycle().skip(1)))
        .map(|(a, b)| {
            let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
            (dx.hypot(dy), dy.atan2(dx).rem_euclid(PI))
        })
        .collect();
    edges.sort_by(|a, b| b.0.total_cmp(&a.0));
    let apart = |a: f64, b: f64| {
        let d = (a - b).rem_euclid(PI);
        d.min(PI - d) >= 20f64.to_radians()
    };
    let mut found: Vec<f64> = Vec::new();
    for (_, angle) in edges {
        if apart(angle, base) && found.iter().all(|f| apart(angle, *f)) {
            found.push(angle);
            if found.len() == 2 {
                break;
            }
        }
    }
    found
}

/// Solid rectilinear in scan order. Alternate rows flip so the next chord
/// starts beside the previous end, and that short link is extruded when it
/// stays inside the region. Rows run at `angle`; one passes through `through`
/// when given, else the first sits half a spacing inside the bounds.
fn solid_fill(
    loops: &[Loop],
    spacing: f64,
    angle: f64,
    through: Option<[f64; 2]>,
) -> Vec<Vec<[f64; 2]>> {
    let sample = crate::inner_prof::Sample::start();
    let outline = Outline::new(loops);
    let rotated = rotate_loops(loops, -angle);
    let chords = horizontal_chords(&rotated, spacing, through.map(|p| rot(p, -angle)[1]));
    let mut paths: Vec<Vec<[f64; 2]>> = Vec::new();
    let mut flip = false;
    for (y, spans) in &chords {
        let mut row: Vec<Vec<[f64; 2]>> = spans
            .iter()
            .map(|(x0, x1)| vec![rot([*x0, *y], angle), rot([*x1, *y], angle)])
            .collect();
        if flip {
            for seg in &mut row {
                seg.reverse();
            }
            row.reverse();
        }
        for seg in row {
            let link = paths.last().and_then(|path| {
                let end = *path.last().unwrap();
                let gap = dist2(end, seg[0]).sqrt();
                if gap <= spacing * 1.75 && (gap < 1e-4 || outline.link_stays(end, seg[0])) {
                    Some(gap)
                } else {
                    None
                }
            });
            if link.is_some() {
                let path = paths.last_mut().unwrap();
                if link.unwrap() >= 1e-4 {
                    path.push(seg[0]);
                }
                path.extend(seg.into_iter().skip(1));
            } else {
                paths.push(seg);
            }
        }
        flip = !flip;
    }
    sample.solid();
    paths
}

fn scan_angle(loops: &[Loop], spacing: f64, angle: f64) -> Vec<Vec<[f64; 2]>> {
    let rotated = rotate_loops(loops, -angle);
    let chords = horizontal_chords(&rotated, spacing, None);
    let mut out = Vec::new();
    for (y, spans) in chords {
        for (x0, x1) in spans {
            let a = rot([x0, y], angle);
            let b = rot([x1, y], angle);
            out.push(vec![a, b]);
        }
    }
    out
}

fn horizontal_chords(
    loops: &[Loop],
    spacing: f64,
    through: Option<f64>,
) -> Vec<(f64, Vec<(f64, f64)>)> {
    let Some((min, max)) = loop_bounds(loops) else {
        return Vec::new();
    };
    let mut rows = Vec::new();
    let mut y = match through {
        Some(t) => t - ((t - min[1]) / spacing).floor() * spacing,
        None => min[1] + spacing * 0.5,
    };
    while y < max[1] - 0.05 {
        let mut xs = Vec::new();
        for loop_ in loops {
            let n = loop_.len();
            for i in 0..n {
                let a = loop_[i];
                let b = loop_[(i + 1) % n];
                if (a[1] < y && b[1] >= y) || (b[1] < y && a[1] >= y) {
                    let dy = b[1] - a[1];
                    if dy.abs() < 1e-12 {
                        continue;
                    }
                    let t = (y - a[1]) / dy;
                    xs.push(a[0] + (b[0] - a[0]) * t);
                }
            }
        }
        xs.sort_by(|a, b| a.total_cmp(b));
        xs.dedup_by(|a, b| (*a - *b).abs() < 1e-4);
        let mut spans = Vec::new();
        let mut i = 0;
        while i + 1 < xs.len() {
            if xs[i + 1] - xs[i] > 0.2 {
                spans.push((xs[i], xs[i + 1]));
            }
            i += 2;
        }
        if !spans.is_empty() {
            rows.push((y, spans));
        }
        y += spacing;
    }
    rows
}

fn serpentine(segments: Vec<Vec<[f64; 2]>>, solid: &[Loop]) -> Vec<Vec<[f64; 2]>> {
    chain_ends(segments, 4.0, Some(solid))
}

/// Greedily weld open segments into polylines, reversing either end.
/// Gaps up to `join` are bridged. When `solid` is set, a bridge that leaves
/// the region (a hole, or outside the part) is not taken.
///
/// Endpoints live in a grid of `join`-sized cells, so each weld looks only at
/// nearby segments. Ties go where the old linear scan sent them: shortest gap,
/// then position in the unused list, then which end, then which direction.
fn chain_ends(
    segments: Vec<Vec<[f64; 2]>>,
    join: f64,
    solid: Option<&[Loop]>,
) -> Vec<Vec<[f64; 2]>> {
    let sample = crate::inner_prof::Sample::start();
    let seg_count = segments.len() as u64;
    let outline = solid.map(Outline::new);
    let mut segs: Vec<Option<Vec<[f64; 2]>>> = segments
        .into_iter()
        .filter(|s| s.len() >= 2)
        .map(Some)
        .collect();
    let mut unused: Vec<usize> = (0..segs.len()).collect();
    let mut pos: Vec<usize> = (0..segs.len()).collect();
    let cell = join.max(1e-3);
    let key = |p: [f64; 2]| ((p[0] / cell).floor() as i64, (p[1] / cell).floor() as i64);
    let mut grid: HashMap<(i64, i64), Vec<usize>> = HashMap::new();
    for (id, seg) in segs.iter().enumerate() {
        let seg = seg.as_ref().unwrap();
        grid.entry(key(seg[0])).or_default().push(id);
        grid.entry(key(*seg.last().unwrap())).or_default().push(id);
    }
    let unlink = |grid: &mut HashMap<(i64, i64), Vec<usize>>, seg: &[[f64; 2]], id: usize| {
        for p in [seg[0], *seg.last().unwrap()] {
            if let Some(ids) = grid.get_mut(&key(p)) {
                ids.retain(|x| *x != id);
            }
        }
    };
    let join2 = join * join;
    let mut out = Vec::new();
    let mut near: Vec<usize> = Vec::new();
    while let Some(id) = unused.pop() {
        let mut path = segs[id].take().unwrap();
        unlink(&mut grid, &path, id);
        loop {
            let end = *path.last().unwrap();
            let start = path[0];
            near.clear();
            for tip in [end, start] {
                let (cx, cy) = key(tip);
                for gx in cx - 1..=cx + 1 {
                    for gy in cy - 1..=cy + 1 {
                        if let Some(ids) = grid.get(&(gx, gy)) {
                            near.extend_from_slice(ids);
                        }
                    }
                }
            }
            near.sort_unstable();
            near.dedup();
            // (gap², position in `unused`, end order, direction order, segment)
            let mut best: Option<(f64, usize, u8, u8, usize)> = None;
            for &c in &near {
                let seg = segs[c].as_ref().unwrap();
                let s0 = seg[0];
                let s1 = *seg.last().unwrap();
                for (end_order, tip) in [(0u8, end), (1u8, start)] {
                    for (rev_order, other) in [(0u8, s0), (1u8, s1)] {
                        let d2 = dist2(tip, other);
                        if d2 > join2 {
                            continue;
                        }
                        let rank = (d2, pos[c], end_order, rev_order);
                        if best.is_some_and(|b| (b.0, b.1, b.2, b.3) <= rank) {
                            continue;
                        }
                        if d2 > 1e-8 {
                            if let Some(outline) = &outline {
                                if !outline.link_stays(tip, other) {
                                    continue;
                                }
                            }
                        }
                        best = Some((rank.0, rank.1, rank.2, rank.3, c));
                    }
                }
            }
            let Some((_, p, end_order, rev_order, c)) = best else {
                break;
            };
            unused.swap_remove(p);
            if p < unused.len() {
                pos[unused[p]] = p;
            }
            let mut seg = segs[c].take().unwrap();
            unlink(&mut grid, &seg, c);
            let (at_end, rev) = (end_order == 0, rev_order == 1);
            // `rev` means the matched vertex is currently the segment's last point.
            // Appending needs it at the front; prepending needs it at the back.
            if at_end == rev {
                seg.reverse();
            }
            if at_end {
                if dist2(*path.last().unwrap(), seg[0]) < 1e-8 {
                    path.extend(seg.into_iter().skip(1));
                } else {
                    path.extend(seg);
                }
            } else if dist2(path[0], *seg.last().unwrap()) < 1e-8 {
                seg.pop();
                seg.append(&mut path);
                path = seg;
            } else {
                seg.append(&mut path);
                path = seg;
            }
        }
        out.push(path);
    }
    sample.chain(seg_count);
    out
}

fn gyroid(loops: &[Loop], spacing: f64, phase_bias: f64) -> Vec<Vec<[f64; 2]>> {
    let outline = Outline::new(loops);
    let Some((min, max)) = loop_bounds(loops) else {
        return Vec::new();
    };
    let amp = spacing * 0.38;
    let freq = std::f64::consts::TAU / (spacing * 3.2);
    let step = 0.7_f64;
    let mut polylines = Vec::new();
    let mut y = min[1] + spacing * 0.5;
    let mut row = 0i32;
    while y < max[1] {
        let mut pts = Vec::new();
        let mut x = min[0] - 0.5;
        while x <= max[0] + 0.5 {
            let wave = amp * ((x * freq) + phase_bias + row as f64 * 0.35).sin();
            pts.push([x, y + wave]);
            x += step;
        }
        polylines.extend(clip_polyline(&outline, &pts));
        y += spacing;
        row += 1;
    }
    let mut x = min[0] + spacing * 0.5;
    let mut col = 0i32;
    while x < max[0] {
        let mut pts = Vec::new();
        let mut y = min[1] - 0.5;
        while y <= max[1] + 0.5 {
            let wave = amp * ((y * freq) + phase_bias * 1.7 + col as f64 * 0.35).sin();
            pts.push([x + wave, y]);
            y += step;
        }
        polylines.extend(clip_polyline(&outline, &pts));
        x += spacing;
        col += 1;
    }
    polylines
}

fn clip_polyline(outline: &Outline, pts: &[[f64; 2]]) -> Vec<Vec<[f64; 2]>> {
    if pts.len() < 2 {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut current: Vec<[f64; 2]> = Vec::new();
    for w in pts.windows(2) {
        for piece in outline.clip_segment(w[0], w[1]) {
            if current
                .last()
                .map(|p| dist2(*p, piece[0]) < 1e-6)
                .unwrap_or(false)
            {
                current.push(piece[1]);
            } else {
                if current.len() >= 2 {
                    out.push(std::mem::take(&mut current));
                } else {
                    current.clear();
                }
                current.push(piece[0]);
                current.push(piece[1]);
            }
        }
    }
    if current.len() >= 2 {
        out.push(current);
    }
    out
}

pub fn clip_open_segment(loops: &[Loop], a: [f64; 2], b: [f64; 2]) -> Vec<[[f64; 2]; 2]> {
    Outline::new(loops).clip_segment(a, b)
}

/// The pieces of `a..b` inside the loops.
fn clip_segment_in(outline: &Outline, a: [f64; 2], b: [f64; 2]) -> Vec<[[f64; 2]; 2]> {
    let mut ts = vec![0.0, 1.0];
    // An edge whose box misses the segment's, grown by a Clipper unit for
    // rounding, cuts it nowhere.
    let lo = [a[0].min(b[0]) - 1e-3, a[1].min(b[1]) - 1e-3];
    let hi = [a[0].max(b[0]) + 1e-3, a[1].max(b[1]) + 1e-3];
    let mut cut = |c: [f64; 2], d: [f64; 2]| {
        if !edge_box_meets(c, d, lo, hi) {
            return;
        }
        if let Some(t) = segment_t(a, b, c, d) {
            if (0.0..=1.0).contains(&t) {
                ts.push(t);
            }
        }
    };
    if let Some(cells) = outline.cells() {
        // An edge listed twice adds its cut twice, which the dedup drops.
        for (l, k) in cells.near(a, b) {
            if outline.loop_meets(l, a, b) {
                let (c, d) = outline.edge(l, k);
                cut(c, d);
            }
        }
    } else {
        for loop_ in outline.touching(a, b) {
            let n = loop_.len();
            for i in 0..n {
                cut(loop_[i], loop_[(i + 1) % n]);
            }
        }
    }
    ts.sort_by(|a, b| a.total_cmp(b));
    ts.dedup_by(|a, b| (*a - *b).abs() < 1e-4);
    let mut pieces = Vec::new();
    for w in ts.windows(2) {
        let t0 = w[0];
        let t1 = w[1];
        if t1 - t0 < 1e-3 {
            continue;
        }
        let tm = (t0 + t1) * 0.5;
        let mx = a[0] + (b[0] - a[0]) * tm;
        let my = a[1] + (b[1] - a[1]) * tm;
        if outline.contains([mx, my]) {
            let p0 = [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0];
            let p1 = [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1];
            pieces.push([p0, p1]);
        }
    }
    pieces
}

fn segment_t(a: [f64; 2], b: [f64; 2], c: [f64; 2], d: [f64; 2]) -> Option<f64> {
    let r = [b[0] - a[0], b[1] - a[1]];
    let s = [d[0] - c[0], d[1] - c[1]];
    let denom = r[0] * s[1] - r[1] * s[0];
    if denom.abs() < 1e-12 {
        return None;
    }
    let qp = [c[0] - a[0], c[1] - a[1]];
    let t = (qp[0] * s[1] - qp[1] * s[0]) / denom;
    let u = (qp[0] * r[1] - qp[1] * r[0]) / denom;
    if (0.0..=1.0).contains(&u) {
        Some(t)
    } else {
        None
    }
}

fn rotate_loops(loops: &[Loop], angle: f64) -> Vec<Loop> {
    loops
        .iter()
        .map(|l| l.iter().copied().map(|p| rot(p, angle)).collect())
        .collect()
}

fn rot(p: [f64; 2], angle: f64) -> [f64; 2] {
    let (s, c) = angle.sin_cos();
    [p[0] * c - p[1] * s, p[0] * s + p[1] * c]
}

/// One chord through a support patch the grid spacing skipped.
fn support_spine(region: &[Loop]) -> Vec<Vec<[f64; 2]>> {
    let Some((min, max)) = loop_bounds(region) else {
        return Vec::new();
    };
    let c = [(min[0] + max[0]) * 0.5, (min[1] + max[1]) * 0.5];
    let (a, b) = if max[0] - min[0] >= max[1] - min[1] {
        ([min[0] - 0.5, c[1]], [max[0] + 0.5, c[1]])
    } else {
        ([c[0], min[1] - 0.5], [c[0], max[1] + 0.5])
    };
    clip_infill(vec![vec![a, b]], region)
}

/// Sparse grid (or a denser interface grid) inside `region`.
/// Density and speed come from the resolved strategy.
pub fn plan_support(
    region: &[Loop],
    strategy: &ResolvedStrategy,
    line_width: f64,
    density: f64,
    interface: bool,
) -> Vec<Extrusion> {
    if region.is_empty() || density <= 0.01 {
        return Vec::new();
    }
    let spacing = (line_width / density).clamp(line_width * 1.05, 8.0);
    let kind = if interface {
        PathKind::SupportInterface
    } else {
        PathKind::Support
    };
    let mut segs = serpentine(scan_angle(region, spacing, 0.0), region);
    segs.extend(serpentine(
        scan_angle(region, spacing, std::f64::consts::FRAC_PI_2),
        region,
    ));
    let mut segs = clip_infill(segs, region);
    if segs.is_empty() {
        segs = support_spine(region);
    }
    let speed = crate::strategy::support_speed(strategy, interface);
    segs.into_iter()
        .filter(|pts| pts.len() >= 2 && polyline_len(pts) > 0.4)
        .map(|pts| {
            let mut path = extrusion(kind, strategy, pts, line_width);
            path.speed = speed;
            path
        })
        .collect()
}

/// Organic branches: thin tips are one loop, thicker trunks are perimeters of the
/// union of their cross-sections so nearby branches melt into one shape.
pub fn plan_tree_support(
    disks: &[Disk],
    strategy: &ResolvedStrategy,
    line_width: f64,
) -> Vec<Extrusion> {
    if disks.is_empty() {
        return Vec::new();
    }
    let speed = crate::strategy::support_speed(strategy, false);
    let mut paths = Vec::new();
    let mut thick: Vec<Loop> = Vec::new();
    for d in disks {
        let (c, r) = (d.xy, d.r.max(0.32));
        if r <= line_width * 0.95 {
            let mut path = extrusion(PathKind::Support, strategy, circle_pts(c, r), line_width);
            path.speed = speed;
            paths.push(path);
        } else {
            thick.push(circle_pts(c, r));
        }
    }
    if thick.is_empty() {
        return paths;
    }
    // One union of every cross-section. Folding them in one at a time sent the
    // whole growing shape through Clipper per branch: 388 s on one layer with
    // 4063 branches. A lone section skips Clipper, as the fold did.
    let solid = if thick.len() == 1 {
        thick
    } else {
        resolve_nonzero(thick)
    };
    let inset = offset_loops(&solid, -line_width * 0.5);
    let walls = if inset.is_empty() { solid } else { inset };
    emit_support_loops(&mut paths, &walls, strategy, line_width, speed);
    let inner = offset_loops(&walls, -line_width * 0.95);
    let inner: Vec<Loop> = inner
        .into_iter()
        .filter(|l| signed_area(l).abs() >= 0.35 && l.len() >= 3)
        .collect();
    emit_support_loops(&mut paths, &inner, strategy, line_width, speed);
    paths
}

fn emit_support_loops(
    out: &mut Vec<Extrusion>,
    loops: &[Loop],
    strategy: &ResolvedStrategy,
    line_width: f64,
    speed: f64,
) {
    for lp in loops {
        if lp.len() < 3 {
            continue;
        }
        let mut pts = lp.clone();
        if dist2(pts[0], *pts.last().unwrap()) > 1e-8 {
            let first = pts[0];
            pts.push(first);
        }
        if polyline_len(&pts) < 0.4 {
            continue;
        }
        let mut path = extrusion(PathKind::Support, strategy, pts, line_width);
        path.speed = speed;
        out.push(path);
    }
}

fn circle_pts(c: [f64; 2], r: f64) -> Vec<[f64; 2]> {
    let n = if r > 2.2 { 20 } else { 12 };
    let mut pts: Vec<[f64; 2]> = (0..n)
        .map(|i| {
            let a = i as f64 * std::f64::consts::TAU / n as f64;
            [c[0] + r * a.cos(), c[1] + r * a.sin()]
        })
        .collect();
    pts.push(pts[0]);
    pts
}

/// Test hook. Off in every slice unless a report test turns it on. SeqCst so a
/// rayon worker observes the store that happened before the travel order.
static LEGACY_TRAVEL: AtomicBool = AtomicBool::new(false);

#[cfg(test)]
#[doc(hidden)]
pub(crate) fn set_legacy_travel_for_test(on: bool) {
    LEGACY_TRAVEL.store(on, Ordering::SeqCst);
}

/// A new infill order has to beat nearest-neighbor by this much or the group
/// stays on the old sequence. Stops float noise from rewriting G-code.
const TRAVEL_WIN_MM: f64 = 0.05;

/// Rep points within this distance belong to one island. The link is
/// transitive, so a dense gyroid or a rectilinear field becomes one island
/// and a real gap between parts does not.
const ISLAND_GAP_MM: f64 = 2.2;

/// `PartLayout::tour` in place.
#[cfg(test)]
fn order_part(
    paths: &mut Vec<Extrusion>,
    solid: &[Loop],
    from: Option<[f64; 2]>,
    scarf: Option<&ScarfParams>,
) -> Option<[f64; 2]> {
    let (out, end) = PartLayout::new(std::mem::take(paths), solid).tour(from, scarf);
    *paths = out;
    end
}

/// One layer's part paths as the tour reads them: split into islands and
/// runs of one travel group, with everything the tour needs that does not
/// depend on where it starts. Every layer can be laid out at once; only the
/// tour itself has to wait for the layer below.
pub struct PartLayout {
    blocks: Vec<Vec<Run>>,
    /// The gap between each pair of islands, `blocks.len()` squared, or
    /// empty for one island.
    gaps: Vec<f64>,
}

impl PartLayout {
    pub fn new(paths: Vec<Extrusion>, solid: &[Loop]) -> Self {
        if paths.is_empty() {
            return Self {
                blocks: Vec::new(),
                gaps: Vec::new(),
            };
        }
        let islands: Vec<Outline<'static>> = island_loops(solid)
            .into_iter()
            .map(Outline::owned)
            .collect();
        let mut parts: Vec<Vec<Extrusion>> = vec![Vec::new(); islands.len() + 1];
        for path in paths {
            let at = island_for(&islands, &path).unwrap_or(islands.len());
            parts[at].push(path);
        }
        let blocks: Vec<Vec<Extrusion>> = parts.into_iter().filter(|p| !p.is_empty()).collect();
        let gaps = island_gaps(&blocks);
        Self {
            blocks: blocks.into_iter().map(runs_of).collect(),
            gaps,
        }
    }

    /// Print order for the part's paths on one layer, starting at `from`,
    /// and where the tour ends.
    ///
    /// The part prints one island at a time, nearest unprinted island next,
    /// each island's paths in plan order. Printing kind by kind across the
    /// layer crossed the bed once per kind; the Baby Dragon has up to 93
    /// islands a layer, so that was 93 outer walls, then 93 inner walls, and
    /// so on.
    ///
    /// Inside an island each run of one kind is reordered: walls and closed
    /// thin walls by nearest neighbor, infill, skin, and gap fill by the best
    /// of island, Hilbert, and stripe orders. A loop with a nearest seam
    /// starts at the corner nearest the nozzle; an aligned seam stays put. A
    /// wall is scarfed as soon as its seam is final, so the next path starts
    /// from where the scarf overlap really ends.
    pub fn tour(
        self,
        from: Option<[f64; 2]>,
        scarf: Option<&ScarfParams>,
    ) -> (Vec<Extrusion>, Option<[f64; 2]>) {
        let mut out = Vec::new();
        let mut cursor = from;
        let tour = island_tour(&self.blocks, &self.gaps, cursor);
        let mut slots: Vec<Option<Vec<Run>>> = self.blocks.into_iter().map(Some).collect();
        for i in tour {
            if let Some(block) = slots[i].take() {
                cursor = order_runs(block, cursor, &mut out, scarf);
            }
        }
        (out, cursor)
    }
}

/// Print order for a layer's skirt and supports, starting where the nozzle
/// stands (`from`). They keep the order they were planned in, and each run
/// of one kind is reordered as in `PartLayout::tour`. Returns where the nozzle ends.
pub fn order_supports(
    paths: &mut Vec<Extrusion>,
    from: Option<[f64; 2]>,
    scarf: Option<&ScarfParams>,
) -> Option<[f64; 2]> {
    let mut out = Vec::with_capacity(paths.len());
    let end = order_runs(runs_of(std::mem::take(paths)), from, &mut out, scarf);
    *paths = out;
    end
}

/// The gaps between every pair of islands' walls, for `island_tour`.
fn island_gaps(blocks: &[Vec<Extrusion>]) -> Vec<f64> {
    let n = blocks.len();
    if n <= 1 {
        return Vec::new();
    }
    let reps: Vec<Vec<[f64; 2]>> = blocks.iter().map(|b| block_reps(b)).collect();
    let mut gap = vec![0.0; n * n];
    for i in 0..n {
        for j in i + 1..n {
            let d = rep_dist2(&reps[i], &reps[j]).sqrt();
            gap[i * n + j] = d;
            gap[j * n + i] = d;
        }
    }
    gap
}

/// Visit order for the part's islands. Nearest-neighbor from the cursor, then
/// 2-opt on the gaps between island outlines: nearest-neighbor alone leaves
/// islands behind and crosses the layer to come back for them.
fn island_tour(blocks: &[Vec<Run>], gap: &[f64], cursor: Option<[f64; 2]>) -> Vec<usize> {
    let n = blocks.len();
    if n <= 1 {
        return (0..n).collect();
    }
    let start: Vec<f64> = blocks
        .iter()
        .map(|b| cursor.map_or(0.0, |c| block_entry(&b[0].paths, c).sqrt()))
        .collect();
    let mut tour = Vec::with_capacity(n);
    let mut used = vec![false; n];
    let mut at: Option<usize> = None;
    for _ in 0..n {
        let next = (0..n)
            .filter(|&j| !used[j])
            .min_by(|&a, &b| {
                let da = at.map_or(start[a], |i| gap[i * n + a]);
                let db = at.map_or(start[b], |i| gap[i * n + b]);
                da.total_cmp(&db).then(a.cmp(&b))
            })
            .unwrap();
        used[next] = true;
        tour.push(next);
        at = Some(next);
    }
    let edge = |from: Option<usize>, to: usize| from.map_or(start[to], |i| gap[i * n + to]);
    for _ in 0..32 {
        let mut improved = false;
        for i in 0..n - 1 {
            let before = if i == 0 { None } else { Some(tour[i - 1]) };
            for j in i + 1..n {
                let after = tour.get(j + 1).copied();
                let old = edge(before, tour[i]) + after.map_or(0.0, |k| gap[tour[j] * n + k]);
                let new = edge(before, tour[j]) + after.map_or(0.0, |k| gap[tour[i] * n + k]);
                if new + 1e-6 < old {
                    tour[i..=j].reverse();
                    improved = true;
                }
            }
        }
        if !improved {
            break;
        }
    }
    tour
}

/// Points around an island: its first run of paths, which is its walls.
fn block_reps(block: &[Extrusion]) -> Vec<[f64; 2]> {
    let Some(group) = block.first().map(Extrusion::travel_group) else {
        return Vec::new();
    };
    block
        .iter()
        .take_while(|p| p.travel_group() == group)
        .flat_map(rep_points)
        .collect()
}

/// Decide the travel into every path of an ordered layer: straight, combed
/// through the inset of the island it stays in, or retracted. `from` is where
/// the previous layer ended.
pub fn comb_layer(
    paths: &mut [Extrusion],
    solid: &[Loop],
    combing: bool,
    inset: f64,
    from: Option<[f64; 2]>,
) {
    let comb = Combing::new(solid, combing, inset);
    let mut cursor = from;
    for path in paths.iter_mut() {
        let Some(start) = path.points.first().copied() else {
            continue;
        };
        if let Some(from) = cursor {
            path.take_comb(comb_between(&comb, from, start));
        }
        cursor = path.points.last().copied();
    }
}

/// The island holding `path`: the first of its start, middle, and end that
/// lies inside one, else the island whose box is nearest its start.
fn island_for(islands: &[Outline], path: &Extrusion) -> Option<usize> {
    let pts = &path.points;
    let n = pts.len();
    if n == 0 || islands.is_empty() {
        return None;
    }
    let inside = |p: [f64; 2]| {
        islands
            .iter()
            .position(|isl| isl.box_holds(p) && isl.contains(p))
    };
    [0, n / 2, n - 1]
        .into_iter()
        .find_map(|i| inside(pts[i]))
        .or_else(|| {
            (0..islands.len()).min_by(|&a, &b| {
                let da = islands[a]
                    .bounds
                    .map_or(f64::MAX, |(mn, mx)| box_dist2(mn, mx, pts[0]));
                let db = islands[b]
                    .bounds
                    .map_or(f64::MAX, |(mn, mx)| box_dist2(mn, mx, pts[0]));
                da.total_cmp(&db)
            })
        })
}

fn block_entry(block: &[Extrusion], cursor: [f64; 2]) -> f64 {
    let Some(group) = block.first().map(Extrusion::travel_group) else {
        return f64::MAX;
    };
    block
        .iter()
        .take_while(|p| p.travel_group() == group)
        .map(|p| approach_dist2(p, cursor, true))
        .fold(f64::MAX, f64::min)
}

/// One run of a travel group in an island, in plan order, with what ordering
/// it reads from the paths alone.
struct Run {
    paths: Vec<Extrusion>,
    grid: Option<ApproachGrid>,
    /// Set on a run `order_infill` sorts.
    infill: Option<InfillLayout>,
}

/// What `order_infill` reads from a run's paths alone.
struct InfillLayout {
    closed: bool,
    comps: Vec<Vec<usize>>,
    stripes: Vec<Vec<usize>>,
    hilbert: Vec<usize>,
}

/// `block` split into runs of one travel group, each laid out.
fn runs_of(block: Vec<Extrusion>) -> Vec<Run> {
    let mut runs = Vec::new();
    let mut group: Vec<Extrusion> = Vec::new();
    for path in block {
        if group
            .last()
            .is_some_and(|last| last.travel_group() != path.travel_group())
        {
            runs.push(Run::new(std::mem::take(&mut group)));
        }
        group.push(path);
    }
    if !group.is_empty() {
        runs.push(Run::new(group));
    }
    runs
}

impl Run {
    fn new(paths: Vec<Extrusion>) -> Self {
        let infill = paths
            .first()
            .is_some_and(|p| infill_travel_group(p.travel_group()))
            && paths.len() >= 2;
        let infill = infill.then(|| {
            let sample = crate::inner_prof::Sample::start();
            let comps = islands(&paths);
            sample.order_islands(paths.len() as u64);
            InfillLayout {
                closed: paths.iter().any(geom_closed),
                comps,
                stripes: stripe_orders(&paths),
                hilbert: hilbert_curve(&paths),
            }
        });
        Self {
            grid: approach_grid(&paths),
            paths,
            infill,
        }
    }
}

/// Order each run of a block from the cursor, in turn.
fn order_runs(
    block: Vec<Run>,
    mut cursor: Option<[f64; 2]>,
    out: &mut Vec<Extrusion>,
    scarf: Option<&ScarfParams>,
) -> Option<[f64; 2]> {
    for run in block {
        cursor = order_run(run, cursor, out, scarf);
    }
    cursor
}

fn order_run(
    run: Run,
    cursor: Option<[f64; 2]>,
    out: &mut Vec<Extrusion>,
    scarf: Option<&ScarfParams>,
) -> Option<[f64; 2]> {
    let (at, has) = (cursor.unwrap_or([0.0, 0.0]), cursor.is_some());
    let Run {
        paths,
        grid,
        infill,
    } = run;
    let n = paths.len() as u64;
    let ordered = match infill.filter(|_| !LEGACY_TRAVEL.load(Ordering::SeqCst)) {
        Some(layout) => {
            let sample = crate::inner_prof::Sample::start();
            let ordered = order_infill(paths, layout, grid, at, has);
            sample.order_infill(n);
            ordered
        }
        None => {
            let sample = crate::inner_prof::Sample::start();
            let ordered = order_nearest(paths, grid.as_ref(), at, has, scarf);
            sample.order_nearest(n);
            ordered
        }
    };
    let mut end = cursor;
    for path in ordered {
        if let Some(last) = path.points.last() {
            end = Some(*last);
        }
        out.push(path);
    }
    end
}

fn infill_travel_group(kind: PathKind) -> bool {
    matches!(
        kind,
        PathKind::GapFill
            | PathKind::Infill
            | PathKind::Sparse
            | PathKind::Solid
            | PathKind::Top
            | PathKind::Bridge
            | PathKind::Support
            | PathKind::SupportInterface
            | PathKind::Ironing
    )
}

fn order_infill(
    paths: Vec<Extrusion>,
    layout: InfillLayout,
    grid: Option<ApproachGrid>,
    cursor: [f64; 2],
    has: bool,
) -> Vec<Extrusion> {
    let n = paths.len();
    let InfillLayout {
        closed,
        comps,
        stripes,
        hilbert,
    } = layout;
    let legacy_sample = crate::inner_prof::Sample::start();
    let legacy = legacy_nn_indices(&paths, grid.as_ref(), cursor, has);
    legacy_sample.order_legacy(n as u64);
    let off = walk_cost(&paths, &legacy, cursor, has, false);
    let on = if closed {
        walk_cost(&paths, &legacy, cursor, has, true)
    } else {
        off
    };
    let mut best = if on + TRAVEL_WIN_MM < off {
        Choice {
            order: legacy.clone(),
            cost: on,
            rotate: true,
        }
    } else {
        Choice {
            order: legacy.clone(),
            cost: off,
            rotate: false,
        }
    };
    // Open paths already score both ends in the legacy scan, so a second
    // nearest-neighbor pass only pays off once closed seams move the target.
    let mut candidates = vec![
        hilbert_order(&paths, hilbert, cursor, has),
        (0..n).collect(),
    ];
    if closed {
        candidates.insert(0, nn_order(&paths, cursor, has));
    }
    if comps.len() > 1 {
        candidates.push(island_order(&paths, &comps, cursor, has));
    }
    let rest_sample = crate::inner_prof::Sample::start();
    candidates.extend(stripes);
    for order in candidates {
        consider(&paths, order, cursor, has, closed, &mut best);
    }
    let polished = polish_order(&paths, &best.order, cursor, has, best.rotate);
    if polished != best.order {
        for rotate in [best.rotate, !best.rotate] {
            if rotate && !closed {
                continue;
            }
            let cost = walk_cost(&paths, &polished, cursor, has, rotate);
            if cost + 1e-6 < best.cost {
                best.cost = cost;
                best.order = polished.clone();
                best.rotate = rotate;
            }
        }
    }
    if !closed {
        let (order, flips) = untangle(&paths, &best.order, cursor, has);
        if order != best.order || flips.iter().any(|f| *f) {
            rest_sample.order_rest(n as u64);
            return apply_flips(paths, &order, &flips);
        }
    }
    if !best.rotate && best.order == legacy {
        rest_sample.order_rest(n as u64);
        return order_nearest(paths, grid.as_ref(), cursor, has, None);
    }
    let ordered = apply_order(paths, &best.order, cursor, has, best.rotate);
    rest_sample.order_rest(n as u64);
    ordered
}

/// Positions a 2-opt move may reach past `i`. Crossings sit between nearby
/// paths, and the cap keeps a big skin group linear.
const UNTANGLE_WINDOW: usize = 64;

/// 2-opt on a run of open paths. Reversing a stretch of the run also flips
/// each path in it, so only the two travels at its ends change; a move is
/// kept when those two get shorter. This undoes the crossing jumps that
/// nearest-neighbor leaves behind, such as finishing one bar of a frame and
/// cutting across the opening to the far bar. Returns the order and, per
/// position, whether that path runs from its last point.
fn untangle(
    paths: &[Extrusion],
    order: &[usize],
    cursor: [f64; 2],
    has: bool,
) -> (Vec<usize>, Vec<bool>) {
    let n = order.len();
    let mut order = order.to_vec();
    let mut ins: Vec<[f64; 2]> = Vec::with_capacity(n);
    let mut outs: Vec<[f64; 2]> = Vec::with_capacity(n);
    let mut flips: Vec<bool> = Vec::with_capacity(n);
    let mut at = (cursor, has);
    for &idx in &order {
        let (start, end) = oriented_ends(&paths[idx], at.0, at.1, false);
        let first = paths[idx].points.first().copied().unwrap_or(at.0);
        flips.push(paths[idx].points.len() >= 2 && start != first);
        ins.push(start);
        outs.push(end);
        if !paths[idx].points.is_empty() {
            at = (end, true);
        }
    }
    if n < 3 {
        return (order, flips);
    }
    let link = |from: Option<[f64; 2]>, to: [f64; 2]| from.map_or(0.0, |f| dist_mm(f, to));
    for _ in 0..8 {
        let mut improved = false;
        for i in 0..n - 1 {
            let before = if i == 0 {
                has.then_some(cursor)
            } else {
                Some(outs[i - 1])
            };
            for j in i + 1..n.min(i + UNTANGLE_WINDOW) {
                let after = ins.get(j + 1).copied();
                let old = link(before, ins[i]) + after.map_or(0.0, |a| dist_mm(outs[j], a));
                let new = link(before, outs[j]) + after.map_or(0.0, |a| dist_mm(ins[i], a));
                if new + 1e-6 < old {
                    order[i..=j].reverse();
                    ins[i..=j].reverse();
                    outs[i..=j].reverse();
                    flips[i..=j].reverse();
                    for k in i..=j {
                        std::mem::swap(&mut ins[k], &mut outs[k]);
                        flips[k] = !flips[k];
                    }
                    improved = true;
                }
            }
        }
        if !improved {
            break;
        }
    }
    (order, flips)
}

fn apply_flips(paths: Vec<Extrusion>, order: &[usize], flips: &[bool]) -> Vec<Extrusion> {
    let mut slots: Vec<Option<Extrusion>> = paths.into_iter().map(Some).collect();
    order
        .iter()
        .zip(flips)
        .map(|(&idx, &flip)| {
            let mut path = slots[idx].take().unwrap();
            if flip {
                reverse_open(&mut path);
            }
            path
        })
        .collect()
}

struct Choice {
    order: Vec<usize>,
    cost: f64,
    rotate: bool,
}

fn consider(
    paths: &[Extrusion],
    order: Vec<usize>,
    cursor: [f64; 2],
    has: bool,
    closed: bool,
    best: &mut Choice,
) {
    if !is_perm(&order, paths.len()) {
        return;
    }
    for rotate in [false, true] {
        if rotate && !closed {
            continue;
        }
        let cost = walk_cost(paths, &order, cursor, has, rotate);
        if cost + TRAVEL_WIN_MM < best.cost {
            best.cost = cost;
            best.order = order.clone();
            best.rotate = rotate;
        }
    }
}

fn is_perm(order: &[usize], n: usize) -> bool {
    if order.len() != n {
        return false;
    }
    let mut seen = vec![false; n];
    for &i in order {
        if i >= n || seen[i] {
            return false;
        }
        seen[i] = true;
    }
    true
}

/// Greedy nearest neighbor. Open paths may flip; closed paths score the nearest
/// vertex, which is the seam a later rotate will use.
fn nn_order(paths: &[Extrusion], cursor: [f64; 2], has: bool) -> Vec<usize> {
    let pool: Vec<usize> = (0..paths.len()).collect();
    nn_pool(paths, &pool, cursor, has)
}

fn nn_pool(paths: &[Extrusion], pool: &[usize], mut cursor: [f64; 2], mut has: bool) -> Vec<usize> {
    let bounds: Vec<([f64; 2], [f64; 2])> = paths.iter().map(path_bounds).collect();
    let mut pending = pool.to_vec();
    let mut out = Vec::with_capacity(pending.len());
    while !pending.is_empty() {
        let mut best_at = 0usize;
        let mut best_d = f64::MAX;
        let mut best_idx = usize::MAX;
        for (i, &idx) in pending.iter().enumerate() {
            if has && box_dist2(bounds[idx].0, bounds[idx].1, cursor) >= best_d {
                continue;
            }
            let d = approach_dist2(&paths[idx], cursor, has);
            if d < best_d - 1e-12 || ((d - best_d).abs() <= 1e-12 && idx < best_idx) {
                best_d = d;
                best_at = i;
                best_idx = idx;
            }
        }
        let idx = pending.swap_remove(best_at);
        if !paths[idx].points.is_empty() {
            cursor = oriented_ends(&paths[idx], cursor, has, true).1;
            has = true;
        }
        out.push(idx);
    }
    out
}

fn island_order(
    paths: &[Extrusion],
    comps: &[Vec<usize>],
    mut cursor: [f64; 2],
    mut has: bool,
) -> Vec<usize> {
    let mut remaining: Vec<Vec<usize>> = comps.to_vec();
    let mut out = Vec::with_capacity(paths.len());
    while !remaining.is_empty() {
        let mut best = 0usize;
        let mut best_d = f64::MAX;
        let mut best_key = usize::MAX;
        for (ci, comp) in remaining.iter().enumerate() {
            let key = comp[0];
            let d = comp
                .iter()
                .map(|&idx| approach_dist2(&paths[idx], cursor, has))
                .fold(f64::MAX, f64::min);
            if d < best_d - 1e-12 || ((d - best_d).abs() <= 1e-12 && key < best_key) {
                best_d = d;
                best = ci;
                best_key = key;
            }
        }
        let comp = remaining.swap_remove(best);
        let sub = nn_pool(paths, &comp, cursor, has);
        for &idx in &sub {
            if !paths[idx].points.is_empty() {
                cursor = oriented_ends(&paths[idx], cursor, has, true).1;
                has = true;
            }
        }
        out.extend(sub);
    }
    out
}

fn islands(paths: &[Extrusion]) -> Vec<Vec<usize>> {
    let n = paths.len();
    let reps: Vec<Vec<[f64; 2]>> = paths.iter().map(rep_points).collect();
    let mut parent: Vec<usize> = (0..n).collect();
    let gap2 = ISLAND_GAP_MM * ISLAND_GAP_MM;
    let cell = ISLAND_GAP_MM;
    let key = |p: [f64; 2]| ((p[0] / cell).floor() as i64, (p[1] / cell).floor() as i64);
    let mut grid: HashMap<(i64, i64), Vec<usize>> = HashMap::new();
    for (i, pts) in reps.iter().enumerate() {
        for p in pts {
            grid.entry(key(*p)).or_default().push(i);
        }
    }
    for i in 0..n {
        for p in &reps[i] {
            let (cx, cy) = key(*p);
            for gx in cx - 1..=cx + 1 {
                for gy in cy - 1..=cy + 1 {
                    let Some(ids) = grid.get(&(gx, gy)) else {
                        continue;
                    };
                    for &j in ids {
                        if j <= i {
                            continue;
                        }
                        let ri = find(&mut parent, i);
                        let rj = find(&mut parent, j);
                        if ri == rj {
                            continue;
                        }
                        if rep_dist2(&reps[i], &reps[j]) <= gap2 {
                            unite(&mut parent, i, j);
                        }
                    }
                }
            }
        }
    }
    let mut groups: HashMap<usize, Vec<usize>> = HashMap::new();
    for i in 0..n {
        groups.entry(find(&mut parent, i)).or_default().push(i);
    }
    let mut comps: Vec<Vec<usize>> = groups.into_values().collect();
    for comp in &mut comps {
        comp.sort_unstable();
    }
    comps.sort_by_key(|comp| comp[0]);
    comps
}

fn find(parent: &mut [usize], mut i: usize) -> usize {
    while parent[i] != i {
        parent[i] = parent[parent[i]];
        i = parent[i];
    }
    i
}

fn unite(parent: &mut [usize], a: usize, b: usize) {
    let mut a = find(parent, a);
    let mut b = find(parent, b);
    if a == b {
        return;
    }
    if a > b {
        std::mem::swap(&mut a, &mut b);
    }
    parent[b] = a;
}

/// `order`, the paths along a Hilbert curve, started at the path nearest the
/// cursor and walked whichever way travels less.
fn hilbert_order(
    paths: &[Extrusion],
    order: Vec<usize>,
    cursor: [f64; 2],
    has: bool,
) -> Vec<usize> {
    let n = order.len();
    if !has || n == 0 {
        return order;
    }
    let start = order
        .iter()
        .enumerate()
        .min_by(|(_, ia), (_, ib)| {
            approach_dist2(&paths[**ia], cursor, true)
                .total_cmp(&approach_dist2(&paths[**ib], cursor, true))
                .then((**ia).cmp(*ib))
        })
        .map(|(pos, _)| pos)
        .unwrap_or(0);
    let mut fwd = Vec::with_capacity(n);
    fwd.extend_from_slice(&order[start..]);
    fwd.extend_from_slice(&order[..start]);
    let mut rev = Vec::with_capacity(n);
    for k in 0..n {
        rev.push(order[(start + n - k) % n]);
    }
    let cf = walk_cost(paths, &fwd, cursor, has, true);
    let cr = walk_cost(paths, &rev, cursor, has, true);
    if cr + 1e-6 < cf {
        rev
    } else {
        fwd
    }
}

/// The paths sorted by where their centroids fall on a Hilbert curve over
/// the run's box.
fn hilbert_curve(paths: &[Extrusion]) -> Vec<usize> {
    let n = paths.len();
    if n == 0 {
        return Vec::new();
    }
    let cents: Vec<[f64; 2]> = paths.iter().map(centroid).collect();
    let mut min = [f64::INFINITY; 2];
    let mut max = [f64::NEG_INFINITY; 2];
    for c in &cents {
        min[0] = min[0].min(c[0]);
        min[1] = min[1].min(c[1]);
        max[0] = max[0].max(c[0]);
        max[1] = max[1].max(c[1]);
    }
    let span = (max[0] - min[0]).max(max[1] - min[1]).max(1e-9);
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&a, &b| {
        hilbert_key(cents[a], min, span)
            .cmp(&hilbert_key(cents[b], min, span))
            .then(a.cmp(&b))
    });
    order
}

fn hilbert_key(p: [f64; 2], min: [f64; 2], span: f64) -> u64 {
    let x = (((p[0] - min[0]) / span).clamp(0.0, 1.0) * 65535.0).round() as u32;
    let y = (((p[1] - min[1]) / span).clamp(0.0, 1.0) * 65535.0).round() as u32;
    hilbert_d(x.min(65535), y.min(65535))
}

fn hilbert_d(mut x: u32, mut y: u32) -> u64 {
    let mut d = 0u64;
    let mut s = 1u32 << 15;
    while s > 0 {
        let rx = u32::from((x & s) > 0);
        let ry = u32::from((y & s) > 0);
        d += u64::from(s) * u64::from(s) * u64::from((3 * rx) ^ ry);
        if ry == 0 {
            if rx == 1 {
                x = 65535 - x;
                y = 65535 - y;
            }
            std::mem::swap(&mut x, &mut y);
        }
        s >>= 1;
    }
    d
}

fn stripe_orders(paths: &[Extrusion]) -> Vec<Vec<usize>> {
    let n = paths.len();
    if n < 4 || paths.iter().any(geom_closed) {
        return Vec::new();
    }
    let angs: Vec<Option<f64>> = paths.iter().map(line_angle).collect();
    let known: Vec<f64> = angs.iter().copied().flatten().collect();
    if known.len() * 4 < n * 3 {
        return Vec::new();
    }
    let mut bins = [0u32; 18];
    for a in &known {
        let bin = ((a / std::f64::consts::PI) * 18.0).floor() as usize % 18;
        bins[bin] += 1;
    }
    let dom = bins
        .iter()
        .enumerate()
        .max_by(|a, b| a.1.cmp(b.1).then(b.0.cmp(&a.0)))
        .map(|(i, _)| i)
        .unwrap_or(0);
    let axis = (dom as f64 + 0.5) * std::f64::consts::PI / 18.0;
    let axis_v = (axis + std::f64::consts::FRAC_PI_2).rem_euclid(std::f64::consts::PI);
    let mut along = Vec::new();
    let mut across = Vec::new();
    let mut rest = Vec::new();
    for (i, ang) in angs.iter().enumerate() {
        match ang {
            Some(a) if angle_near(*a, axis) => along.push(i),
            Some(a) if angle_near(*a, axis_v) => across.push(i),
            _ => rest.push(i),
        }
    }
    if (along.len() + across.len()) * 4 < n * 3 {
        return Vec::new();
    }
    let snake_a = snake(&along, paths, axis);
    let snake_b = snake(&across, paths, axis_v);
    let mut first = Vec::with_capacity(n);
    first.extend_from_slice(&snake_a);
    first.extend_from_slice(&snake_b);
    first.extend_from_slice(&rest);
    if across.is_empty() {
        return vec![first];
    }
    let mut second = Vec::with_capacity(n);
    second.extend_from_slice(&snake_b);
    second.extend_from_slice(&snake_a);
    second.extend_from_slice(&rest);
    vec![first, second]
}

fn angle_near(a: f64, axis: f64) -> bool {
    let d = (a - axis).abs().rem_euclid(std::f64::consts::PI);
    let d = d.min(std::f64::consts::PI - d);
    d <= 20.0_f64.to_radians()
}

fn line_angle(path: &Extrusion) -> Option<f64> {
    if path.points.len() < 2 {
        return None;
    }
    let a = path.points[0];
    let b = *path.points.last().unwrap();
    if dist2(a, b) < 0.2 * 0.2 {
        return None;
    }
    Some(
        (b[1] - a[1])
            .atan2(b[0] - a[0])
            .rem_euclid(std::f64::consts::PI),
    )
}

fn snake(indices: &[usize], paths: &[Extrusion], axis: f64) -> Vec<usize> {
    if indices.is_empty() {
        return Vec::new();
    }
    let dir = [axis.cos(), axis.sin()];
    let nrm = [-dir[1], dir[0]];
    let mut items: Vec<(f64, f64, usize)> = indices
        .iter()
        .map(|&i| {
            let pts = &paths[i].points;
            let a = pts[0];
            let b = *pts.last().unwrap();
            let c = [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5];
            (
                c[0] * nrm[0] + c[1] * nrm[1],
                c[0] * dir[0] + c[1] * dir[1],
                i,
            )
        })
        .collect();
    items.sort_by(|a, b| {
        a.0.total_cmp(&b.0)
            .then(a.1.total_cmp(&b.1))
            .then(a.2.cmp(&b.2))
    });
    let mut rows: Vec<Vec<(f64, usize)>> = Vec::new();
    let mut row_n = 0.0;
    for (n, t, i) in items {
        if rows.is_empty() || (n - row_n).abs() > 0.22 {
            rows.push(Vec::new());
            row_n = n;
        }
        rows.last_mut().unwrap().push((t, i));
    }
    let mut flip = false;
    let mut out = Vec::with_capacity(indices.len());
    for mut row in rows {
        row.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
        if flip {
            row.reverse();
        }
        flip = !flip;
        out.extend(row.into_iter().map(|(_, i)| i));
    }
    out
}

/// Move paths that sit on a long travel next to a spatial neighbor when that
/// shortens the seated tour. Caps the scan so a fat layer cannot nest an
/// O(n²) search inside every candidate.
fn polish_order(
    paths: &[Extrusion],
    order: &[usize],
    cursor: [f64; 2],
    has: bool,
    rotate: bool,
) -> Vec<usize> {
    let n = order.len();
    // Large groups already have a spatial candidate. The relocation search is
    // for the myopic case (a long chord stealing a small neighborhood).
    if !(3..=160).contains(&n) {
        return order.to_vec();
    }
    let neighbors = k_nearest(paths, 8);
    let mut order = order.to_vec();
    let mut cost = walk_cost(paths, &order, cursor, has, rotate);
    for _ in 0..24 {
        let dirs = build_dirs(paths, &order, cursor, has, rotate);
        let mut hot: Vec<(f64, usize)> = Vec::new();
        if has && !dirs.is_empty() {
            let d = dist_mm(cursor, dirs[0].start);
            if d > 1.5 {
                hot.push((d, 0));
            }
        }
        for i in 0..n.saturating_sub(1) {
            let d = dist_mm(dirs[i].end, dirs[i + 1].start);
            if d > 1.5 {
                hot.push((d, i));
                hot.push((d, i + 1));
            }
        }
        if hot.is_empty() {
            break;
        }
        hot.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
        hot.dedup_by(|a, b| a.1 == b.1);
        hot.truncate(24);
        let mut pos = vec![0usize; paths.len()];
        for (p, dir) in dirs.iter().enumerate() {
            pos[dir.index] = p;
        }
        let mut improved = false;
        for (_, t) in hot {
            let idx = dirs[t].index;
            for &nb in &neighbors[idx] {
                let t2 = pos[nb];
                for raw_at in [t2, t2 + 1] {
                    let mut trial = order.clone();
                    let item = trial.remove(t);
                    let at = insert_at(raw_at, t, trial.len());
                    if at == t {
                        continue;
                    }
                    trial.insert(at, item);
                    let next = walk_cost(paths, &trial, cursor, has, rotate);
                    if next + TRAVEL_WIN_MM < cost {
                        order = trial;
                        cost = next;
                        improved = true;
                        break;
                    }
                }
                if improved {
                    break;
                }
            }
            if improved {
                break;
            }
        }
        if !improved {
            break;
        }
    }
    order
}

fn insert_at(raw_at: usize, removed: usize, len_after_remove: usize) -> usize {
    let at = if raw_at > removed { raw_at - 1 } else { raw_at };
    at.min(len_after_remove)
}

fn k_nearest(paths: &[Extrusion], k: usize) -> Vec<Vec<usize>> {
    let n = paths.len();
    let k = k.min(n.saturating_sub(1));
    let reps: Vec<Vec<[f64; 2]>> = paths.iter().map(rep_points).collect();
    if k == 0 {
        return vec![Vec::new(); n];
    }
    if n <= 400 {
        return brute_nearest(&reps, k);
    }
    grid_nearest(&reps, k)
}

fn brute_nearest(reps: &[Vec<[f64; 2]>], k: usize) -> Vec<Vec<usize>> {
    let n = reps.len();
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let mut best: Vec<(f64, usize)> = Vec::new();
        for j in 0..n {
            if i == j {
                continue;
            }
            best.push((rep_dist2(&reps[i], &reps[j]), j));
        }
        best.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
        best.truncate(k);
        out.push(best.into_iter().map(|(_, j)| j).collect());
    }
    out
}

fn grid_nearest(reps: &[Vec<[f64; 2]>], k: usize) -> Vec<Vec<usize>> {
    let n = reps.len();
    let cell = 4.0_f64;
    let key = |p: [f64; 2]| ((p[0] / cell).floor() as i64, (p[1] / cell).floor() as i64);
    let mut grid: HashMap<(i64, i64), Vec<usize>> = HashMap::new();
    for (i, pts) in reps.iter().enumerate() {
        for p in pts {
            grid.entry(key(*p)).or_default().push(i);
        }
    }
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let mut best: Vec<(f64, usize)> = Vec::new();
        let mut seen = vec![false; n];
        seen[i] = true;
        for ring in 0..=6 {
            for p in &reps[i] {
                let (cx, cy) = key(*p);
                for gx in cx - ring..=cx + ring {
                    for gy in cy - ring..=cy + ring {
                        let Some(ids) = grid.get(&(gx, gy)) else {
                            continue;
                        };
                        for &j in ids {
                            if seen[j] {
                                continue;
                            }
                            seen[j] = true;
                            best.push((rep_dist2(&reps[i], &reps[j]), j));
                        }
                    }
                }
            }
            if best.len() >= k {
                break;
            }
        }
        best.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
        best.truncate(k);
        out.push(best.into_iter().map(|(_, j)| j).collect());
    }
    out
}

fn rep_points(path: &Extrusion) -> Vec<[f64; 2]> {
    let pts = &path.points;
    if pts.len() < 2 {
        return pts.clone();
    }
    if geom_closed(path) {
        let ring = pts.len() - 1;
        let step = (ring / 12).max(1);
        let mut out = Vec::new();
        let mut i = 0;
        while i < ring {
            out.push(pts[i]);
            i += step;
        }
        out
    } else {
        vec![pts[0], pts[pts.len() / 2], *pts.last().unwrap()]
    }
}

fn rep_dist2(a: &[[f64; 2]], b: &[[f64; 2]]) -> f64 {
    let mut best = f64::MAX;
    for p in a {
        for q in b {
            let d = dist2(*p, *q);
            if d < best {
                best = d;
            }
        }
    }
    best
}

fn centroid(path: &Extrusion) -> [f64; 2] {
    if path.points.is_empty() {
        return [0.0, 0.0];
    }
    let n = if geom_closed(path) {
        path.points.len() - 1
    } else {
        path.points.len()
    };
    let n = n.max(1);
    let mut x = 0.0;
    let mut y = 0.0;
    for p in path.points.iter().take(n) {
        x += p[0];
        y += p[1];
    }
    let n = n as f64;
    [x / n, y / n]
}

struct TourStop {
    index: usize,
    start: [f64; 2],
    end: [f64; 2],
}

fn walk_cost(
    paths: &[Extrusion],
    order: &[usize],
    cursor: [f64; 2],
    has: bool,
    rotate: bool,
) -> f64 {
    tour_cost(&build_dirs(paths, order, cursor, has, rotate), cursor, has)
}

fn build_dirs(
    paths: &[Extrusion],
    order: &[usize],
    mut cursor: [f64; 2],
    mut has: bool,
    rotate: bool,
) -> Vec<TourStop> {
    let mut dirs = Vec::with_capacity(order.len());
    for &idx in order {
        let (start, end) = oriented_ends(&paths[idx], cursor, has, rotate);
        if !paths[idx].points.is_empty() {
            cursor = end;
            has = true;
        }
        dirs.push(TourStop {
            index: idx,
            start,
            end,
        });
    }
    dirs
}

fn tour_cost(dirs: &[TourStop], cursor: [f64; 2], has: bool) -> f64 {
    if dirs.is_empty() {
        return 0.0;
    }
    let mut cost = if has {
        dist_mm(cursor, dirs[0].start)
    } else {
        0.0
    };
    for w in dirs.windows(2) {
        cost += dist_mm(w[0].end, w[1].start);
    }
    cost
}

fn oriented_ends(
    path: &Extrusion,
    cursor: [f64; 2],
    has: bool,
    rotate_seams: bool,
) -> ([f64; 2], [f64; 2]) {
    let pts = &path.points;
    if pts.is_empty() {
        return (cursor, cursor);
    }
    if !has {
        return (pts[0], *pts.last().unwrap());
    }
    if path.is_loop() {
        if geom_closed(path) {
            let v = match path.seam {
                Seam::Fixed | Seam::Cut => pts[0],
                Seam::Corner => pts[nearest_seam(&pts[..pts.len() - 1], cursor)],
                Seam::Nearest => nearest_vertex(path, cursor),
            };
            return (v, v);
        }
        return (pts[0], *pts.last().unwrap());
    }
    if rotate_seams && geom_closed(path) {
        let v = nearest_vertex(path, cursor);
        return (v, v);
    }
    let a = pts[0];
    let b = *pts.last().unwrap();
    if dist2(cursor, b) + 1e-9 < dist2(cursor, a) {
        (b, a)
    } else {
        (a, b)
    }
}

fn path_bounds(path: &Extrusion) -> ([f64; 2], [f64; 2]) {
    let mut min = [f64::INFINITY; 2];
    let mut max = [f64::NEG_INFINITY; 2];
    for p in &path.points {
        min[0] = min[0].min(p[0]);
        min[1] = min[1].min(p[1]);
        max[0] = max[0].max(p[0]);
        max[1] = max[1].max(p[1]);
    }
    if path.points.is_empty() {
        ([0.0, 0.0], [0.0, 0.0])
    } else {
        (min, max)
    }
}

fn box_dist2(min: [f64; 2], max: [f64; 2], p: [f64; 2]) -> f64 {
    let dx = if p[0] < min[0] {
        min[0] - p[0]
    } else if p[0] > max[0] {
        p[0] - max[0]
    } else {
        0.0
    };
    let dy = if p[1] < min[1] {
        min[1] - p[1]
    } else if p[1] > max[1] {
        p[1] - max[1]
    } else {
        0.0
    };
    dx * dx + dy * dy
}

fn approach_dist2(path: &Extrusion, cursor: [f64; 2], has: bool) -> f64 {
    if path.points.is_empty() {
        return if has { f64::MAX } else { 0.0 };
    }
    if !has {
        return 0.0;
    }
    if path.is_loop() && path.seam == Seam::Fixed {
        dist2(cursor, path.points[0])
    } else if path.is_loop() || geom_closed(path) {
        nearest_dist2(path, cursor)
    } else {
        dist2(cursor, path.points[0]).min(dist2(cursor, *path.points.last().unwrap()))
    }
}

fn nearest_dist2(path: &Extrusion, hint: [f64; 2]) -> f64 {
    let ring = ring_len(path);
    path.points
        .iter()
        .take(ring)
        .map(|p| dist2(*p, hint))
        .fold(f64::MAX, f64::min)
}

fn nearest_vertex(path: &Extrusion, hint: [f64; 2]) -> [f64; 2] {
    let ring = ring_len(path);
    let mut best = path.points[0];
    let mut best_d = f64::MAX;
    for p in path.points.iter().take(ring) {
        let d = dist2(*p, hint);
        if d < best_d {
            best_d = d;
            best = *p;
        }
    }
    best
}

fn ring_len(path: &Extrusion) -> usize {
    if geom_closed(path) {
        path.points.len() - 1
    } else {
        path.points.len().max(1)
    }
}

fn geom_closed(path: &Extrusion) -> bool {
    let n = path.points.len();
    n >= 4 && dist2(path.points[0], path.points[n - 1]) < 1e-8
}

fn apply_order(
    paths: Vec<Extrusion>,
    order: &[usize],
    mut cursor: [f64; 2],
    mut has: bool,
    rotate: bool,
) -> Vec<Extrusion> {
    let mut slots: Vec<Option<Extrusion>> = paths.into_iter().map(Some).collect();
    let mut out = Vec::with_capacity(order.len());
    for &idx in order {
        let mut path = slots[idx].take().unwrap();
        orient_path(&mut path, cursor, has, rotate);
        if let Some(end) = path.points.last().copied() {
            cursor = end;
            has = true;
        }
        out.push(path);
    }
    out
}

fn orient_path(path: &mut Extrusion, cursor: [f64; 2], has: bool, rotate_seams: bool) {
    if path.points.is_empty() || !has {
        return;
    }
    if path.is_loop() {
        match path.seam {
            Seam::Fixed | Seam::Cut => {}
            Seam::Corner if geom_closed(path) => {
                let ring = path.points.len() - 1;
                let at = nearest_seam(&path.points[..ring], cursor);
                rotate_closed_at(path, at);
            }
            Seam::Corner => {}
            Seam::Nearest => rotate_closed_extrusion(path, cursor),
        }
        return;
    }
    if rotate_seams && geom_closed(path) {
        rotate_closed_extrusion(path, cursor);
        return;
    }
    let a = path.points[0];
    let b = *path.points.last().unwrap();
    if path.points.len() >= 2 && dist2(cursor, b) + 1e-9 < dist2(cursor, a) {
        reverse_open(path);
    }
}

fn rotate_closed_extrusion(path: &mut Extrusion, hint: [f64; 2]) {
    let n = path.points.len();
    if n < 4 || dist2(path.points[0], path.points[n - 1]) >= 1e-8 {
        return;
    }
    let ring = n - 1;
    let mut best = 0usize;
    let mut best_d = f64::MAX;
    for (i, p) in path.points.iter().take(ring).enumerate() {
        let d = dist2(*p, hint);
        if d < best_d {
            best_d = d;
            best = i;
        }
    }
    rotate_closed_at(path, best);
}

/// The vertex of `ring` that sits inside a seam disk on this layer, closest
/// to that disk's centre. `None` when the paint misses the loop, so the
/// picker's start stays.
fn painted_vertex(ring: &[[f64; 2]], disks: &[SeamDisk], z: f64, height: f64) -> Option<usize> {
    let lo = z - height;
    let mut best: Option<(usize, f64)> = None;
    for disk in disks {
        let dz = (lo - disk.p[2]).max(disk.p[2] - z).max(0.0);
        if dz >= disk.r {
            continue;
        }
        let reach2 = disk.r * disk.r - dz * dz;
        for (i, p) in ring.iter().enumerate() {
            let dx = p[0] - disk.p[0];
            let dy = p[1] - disk.p[1];
            let dist = dx * dx + dy * dy;
            if dist <= reach2 + 1e-8 && best.map(|(_, b)| dist < b).unwrap_or(true) {
                best = Some((i, dist));
            }
        }
    }
    best.map(|(i, _)| i)
}

/// The segment of the closed `points` that passes nearest a disk centre
/// within the disk, and that nearest point, strictly between its ends.
fn painted_edge(
    points: &[[f64; 2]],
    disks: &[SeamDisk],
    z: f64,
    height: f64,
) -> Option<(usize, [f64; 2])> {
    let lo = z - height;
    let mut best: Option<(usize, [f64; 2], f64)> = None;
    for disk in disks {
        let dz = (lo - disk.p[2]).max(disk.p[2] - z).max(0.0);
        if dz >= disk.r {
            continue;
        }
        let reach2 = disk.r * disk.r - dz * dz;
        for (i, w) in points.windows(2).enumerate() {
            let d = [w[1][0] - w[0][0], w[1][1] - w[0][1]];
            let len2 = d[0] * d[0] + d[1] * d[1];
            if len2 < 1e-12 {
                continue;
            }
            let t = ((disk.p[0] - w[0][0]) * d[0] + (disk.p[1] - w[0][1]) * d[1]) / len2;
            if t <= 1e-6 || t >= 1.0 - 1e-6 {
                continue;
            }
            let q = [w[0][0] + d[0] * t, w[0][1] + d[1] * t];
            let dist = (q[0] - disk.p[0]).powi(2) + (q[1] - disk.p[1]).powi(2);
            if dist <= reach2 + 1e-8 && best.is_none_or(|(_, _, b)| dist < b) {
                best = Some((i, q, dist));
            }
        }
    }
    best.map(|(i, q, _)| (i, q))
}

fn rotate_closed_at(path: &mut Extrusion, at: usize) {
    let n = path.points.len();
    if at == 0 || at + 1 >= n {
        return;
    }
    path.points.pop();
    path.points.rotate_left(at);
    let first = path.points[0];
    path.points.push(first);
    rotate_frac(&mut path.z_frac, at, n);
    rotate_frac(&mut path.flow_frac, at, n);
}

fn rotate_frac(frac: &mut Vec<f64>, best: usize, n: usize) {
    if frac.len() != n || best == 0 {
        return;
    }
    frac.pop();
    frac.rotate_left(best);
    let first = frac[0];
    frac.push(first);
}

fn reverse_open(path: &mut Extrusion) {
    let n = path.points.len();
    path.points.reverse();
    if path.z_frac.len() == n {
        path.z_frac.reverse();
    }
    if path.flow_frac.len() == n {
        path.flow_frac.reverse();
    }
}

/// `grid` is `approach_grid(paths)`.
fn legacy_nn_indices(
    paths: &[Extrusion],
    grid: Option<&ApproachGrid>,
    mut cursor: [f64; 2],
    mut has: bool,
) -> Vec<usize> {
    let n = paths.len();
    let mut pending: Vec<usize> = (0..n).collect();
    let mut pos: Vec<usize> = (0..n).collect();
    let mut out = Vec::with_capacity(n);
    while !pending.is_empty() {
        let best_i = pending_winner(paths, &pending, &pos, grid, cursor, has);
        let idx = pending.swap_remove(best_i);
        pos[idx] = usize::MAX;
        if best_i < pending.len() {
            pos[pending[best_i]] = best_i;
        }
        if !paths[idx].points.is_empty() {
            cursor = oriented_ends(&paths[idx], cursor, has, false).1;
            has = true;
        }
        out.push(idx);
    }
    out
}

/// Groups smaller than this stay on the linear scan. The grid pays for itself
/// once a layer's infill is hundreds of paths, which is where the scan was
/// quadratic.
const NN_LINEAR_LIMIT: usize = 48;

const NN_CELL_MM: f64 = 2.0;

/// The grid nearest-neighbor ordering of `paths` searches, when there are
/// enough of them to pay for it.
fn approach_grid(paths: &[Extrusion]) -> Option<ApproachGrid> {
    (paths.len() > NN_LINEAR_LIMIT).then(|| ApproachGrid::build(paths))
}

type ApproachBuckets = HashMap<(i64, i64), Vec<(usize, [f64; 2])>>;

/// Endpoints (or seam vertices) of the paths still waiting to print.
///
/// A query walks outward from the nozzle until the square already searched is
/// closer than any cell outside it, so the winner is the same path the linear
/// scan would pick: smallest approach distance, then the earliest slot in
/// `pending`.
struct ApproachGrid {
    cell: f64,
    buckets: ApproachBuckets,
    min_c: [i64; 2],
    max_c: [i64; 2],
}

impl ApproachGrid {
    fn build(paths: &[Extrusion]) -> Self {
        let cell = NN_CELL_MM;
        let mut buckets = ApproachBuckets::new();
        let mut min_c = [i64::MAX; 2];
        let mut max_c = [i64::MIN; 2];
        for (id, path) in paths.iter().enumerate() {
            for_each_approach_site(path, |p| {
                let key = cell_key(p, cell);
                min_c[0] = min_c[0].min(key.0);
                min_c[1] = min_c[1].min(key.1);
                max_c[0] = max_c[0].max(key.0);
                max_c[1] = max_c[1].max(key.1);
                buckets.entry(key).or_default().push((id, p));
            });
        }
        if min_c[0] == i64::MAX {
            min_c = [0; 2];
            max_c = [0; 2];
        }
        Self {
            cell,
            buckets,
            min_c,
            max_c,
        }
    }

    /// Index into `pending` of the path the linear scan would print next.
    /// `pos[id]` is that path's slot, or `usize::MAX` once it has been printed.
    fn winner(&self, pos: &[usize], cursor: [f64; 2]) -> usize {
        let (cx, cy) = cell_key(cursor, self.cell);
        let mut best_d = f64::MAX;
        let mut best_i = 0usize;
        let mut ring = 0i64;
        loop {
            if ring > 0 {
                let gap = searched_gap(cursor, cx, cy, ring - 1, self.cell);
                if best_d < gap * gap || searched_covers(self, cx, cy, ring - 1) {
                    break;
                }
            }
            let r = ring;
            for gx in cx - r..=cx + r {
                for gy in cy - r..=cy + r {
                    if r > 0 && (gx - cx).abs() != r && (gy - cy).abs() != r {
                        continue;
                    }
                    let Some(hits) = self.buckets.get(&(gx, gy)) else {
                        continue;
                    };
                    for &(id, p) in hits {
                        let at = pos[id];
                        if at == usize::MAX {
                            continue;
                        }
                        let d = dist2(cursor, p);
                        // Equal distances keep the earlier pending slot, which
                        // is what `d < best_d` does on a front-to-back scan.
                        if d < best_d || (d == best_d && at < best_i) {
                            best_d = d;
                            best_i = at;
                        }
                    }
                }
            }
            if searched_covers(self, cx, cy, ring) {
                break;
            }
            ring += 1;
            if ring > 100_000 {
                break;
            }
        }
        if best_d.is_finite() {
            best_i
        } else {
            0
        }
    }
}

fn cell_key(p: [f64; 2], cell: f64) -> (i64, i64) {
    ((p[0] / cell).floor() as i64, (p[1] / cell).floor() as i64)
}

/// Distance from `cursor` to the outside of the square of cells within
/// Chebyshev `ring` of `(cx, cy)`. Points outside that square are at least
/// this far away.
fn searched_gap(cursor: [f64; 2], cx: i64, cy: i64, ring: i64, cell: f64) -> f64 {
    let minx = (cx - ring) as f64 * cell;
    let maxx = (cx + ring + 1) as f64 * cell;
    let miny = (cy - ring) as f64 * cell;
    let maxy = (cy + ring + 1) as f64 * cell;
    let dx = (cursor[0] - minx).min(maxx - cursor[0]);
    let dy = (cursor[1] - miny).min(maxy - cursor[1]);
    dx.min(dy).max(0.0)
}

fn searched_covers(grid: &ApproachGrid, cx: i64, cy: i64, ring: i64) -> bool {
    cx - ring <= grid.min_c[0]
        && cy - ring <= grid.min_c[1]
        && cx + ring >= grid.max_c[0]
        && cy + ring >= grid.max_c[1]
}

/// Sites `approach_dist2` measures. Empty paths contribute none.
fn for_each_approach_site(path: &Extrusion, mut f: impl FnMut([f64; 2])) {
    if path.points.is_empty() {
        return;
    }
    if path.is_loop() && path.seam == Seam::Fixed {
        f(path.points[0]);
        return;
    }
    if path.is_loop() || geom_closed(path) {
        let ring = ring_len(path);
        for p in path.points.iter().take(ring) {
            f(*p);
        }
        return;
    }
    f(path.points[0]);
    let last = *path.points.last().unwrap();
    if dist2(path.points[0], last) > 0.0 {
        f(last);
    }
}

fn pending_winner(
    paths: &[Extrusion],
    pending: &[usize],
    pos: &[usize],
    grid: Option<&ApproachGrid>,
    cursor: [f64; 2],
    has: bool,
) -> usize {
    match grid {
        Some(grid) if has && pending.len() > NN_LINEAR_LIMIT => grid.winner(pos, cursor),
        _ => pending_winner_linear(paths, pending, cursor, has),
    }
}

fn pending_winner_linear(
    paths: &[Extrusion],
    pending: &[usize],
    cursor: [f64; 2],
    has: bool,
) -> usize {
    pending_winner_scored(pending, cursor, has, |idx| Some(&paths[idx]))
}

fn pending_winner_slots(
    slots: &[Option<Extrusion>],
    pending: &[usize],
    pos: &[usize],
    grid: Option<&ApproachGrid>,
    cursor: [f64; 2],
    has: bool,
) -> usize {
    match grid {
        Some(grid) if has && pending.len() > NN_LINEAR_LIMIT => grid.winner(pos, cursor),
        _ => pending_winner_scored(pending, cursor, has, |idx| slots[idx].as_ref()),
    }
}

fn pending_winner_scored<'a>(
    pending: &[usize],
    cursor: [f64; 2],
    has: bool,
    path_at: impl Fn(usize) -> Option<&'a Extrusion>,
) -> usize {
    let mut best_i = 0usize;
    let mut best_d = f64::MAX;
    for (i, &idx) in pending.iter().enumerate() {
        let Some(path) = path_at(idx) else {
            continue;
        };
        if path.points.is_empty() {
            continue;
        }
        let d = approach_dist2(path, cursor, has);
        if d < best_d {
            best_d = d;
            best_i = i;
        }
    }
    best_i
}

/// Nearest neighbor that seats each path as it is chosen, so the next choice
/// is measured from where that path really ends, scarf overlap included.
/// `grid` is `approach_grid(&paths)`.
fn order_nearest(
    paths: Vec<Extrusion>,
    grid: Option<&ApproachGrid>,
    mut cursor: [f64; 2],
    mut has: bool,
    scarf: Option<&ScarfParams>,
) -> Vec<Extrusion> {
    let n = paths.len();
    let mut slots: Vec<Option<Extrusion>> = paths.into_iter().map(Some).collect();
    let mut pending: Vec<usize> = (0..n).collect();
    let mut pos: Vec<usize> = (0..n).collect();
    let mut out = Vec::with_capacity(n);
    while !pending.is_empty() {
        let best_i = pending_winner_slots(&slots, &pending, &pos, grid, cursor, has);
        let id = pending.swap_remove(best_i);
        pos[id] = usize::MAX;
        if best_i < pending.len() {
            pos[pending[best_i]] = best_i;
        }
        let mut path = slots[id].take().unwrap();
        orient_path(&mut path, cursor, has, false);
        if let Some(params) = scarf {
            scarf_one(&mut path, params);
        }
        fuzz_settled(&mut path);
        if let Some(end) = path.points.last() {
            cursor = *end;
            has = true;
        }
        out.push(path);
    }
    out
}

fn dist_mm(a: [f64; 2], b: [f64; 2]) -> f64 {
    dist2(a, b).sqrt()
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
    /// around it costs travel.
    pub(crate) fn travel_group(&self) -> PathKind {
        if self.kind == PathKind::ThinWall && !self.is_loop() {
            PathKind::GapFill
        } else {
            self.kind
        }
    }

    /// Replace whatever an earlier pass decided about the travel into this path.
    fn take_comb(&mut self, comb: Comb) {
        self.lead_in.clear();
        self.travel_in = match comb {
            Comb::Clear => TravelIn::Inside,
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
            TravelIn::Inside => (0.0, self.retract_min_travel),
            TravelIn::Blocked => (mm, 0.0),
        }
    }
}

enum Comb {
    Clear,
    Routed(Vec<[f64; 2]>),
    Blocked,
}

/// A layer's solid and its combing inset, split into islands. Islands never
/// touch, so a travel between two of them always leaves the part, and a
/// routed travel only searches the inset of the island it stays in.
struct Combing<'a> {
    solid: Outline<'a>,
    enabled: bool,
    islands: Vec<CombIsland>,
}

struct CombIsland {
    solid: Outline<'static>,
    inset: Outline<'static>,
}

impl<'a> Combing<'a> {
    fn new(solid: &'a [Loop], combing: bool, inset: f64) -> Self {
        let inset_loops = if combing && !solid.is_empty() {
            offset_loops(solid, -inset.abs())
        } else {
            Vec::new()
        };
        let enabled = combing && !inset_loops.is_empty();
        let mut islands: Vec<CombIsland> = Vec::new();
        if enabled {
            islands = island_loops(solid)
                .into_iter()
                .map(|loops| CombIsland {
                    solid: Outline::owned(loops),
                    inset: Outline::owned(Vec::new()),
                })
                .collect();
            let mut insets: Vec<Vec<Loop>> = vec![Vec::new(); islands.len()];
            for loop_ in inset_loops {
                let Some(&p) = loop_.first() else {
                    continue;
                };
                if let Some(i) = islands.iter().position(|isl| isl.solid.contains(p)) {
                    insets[i].push(loop_);
                }
            }
            for (island, inset) in islands.iter_mut().zip(insets) {
                island.inset = Outline::owned(inset);
            }
        }
        Self {
            solid: Outline::new(solid),
            enabled,
            islands,
        }
    }

    fn island_of(&self, p: [f64; 2]) -> Option<usize> {
        self.islands
            .iter()
            .position(|isl| isl.solid.box_holds(p) && isl.solid.contains(p))
    }
}

/// Each outer loop with the holes directly inside it. Nesting comes from
/// containment, so loop orientation does not matter.
pub(crate) fn island_loops(loops: &[Loop]) -> Vec<Vec<Loop>> {
    let outlines: Vec<Outline> = loops
        .iter()
        .map(|l| Outline::new(std::slice::from_ref(l)))
        .collect();
    let parents = containing_loops(loops, &outlines);
    let mut island_at: Vec<Option<usize>> = vec![None; loops.len()];
    let mut out: Vec<Vec<Loop>> = Vec::new();
    for (i, up) in parents.iter().enumerate() {
        if up.len() % 2 == 0 {
            island_at[i] = Some(out.len());
            out.push(vec![loops[i].clone()]);
        }
    }
    for (i, up) in parents.iter().enumerate() {
        if up.len() % 2 == 1 {
            let owner = up
                .iter()
                .filter(|&&j| parents[j].len() + 1 == up.len())
                .find_map(|&j| island_at[j]);
            if let Some(k) = owner {
                out[k].push(loops[i].clone());
            }
        }
    }
    out
}

/// Loops that contain each loop's first vertex, in ascending loop index.
/// A grid is the linear scan's hits: a box that misses the vertex's cell
/// cannot contain it, and equal distances are not involved.
fn containing_loops(loops: &[Loop], outlines: &[Outline]) -> Vec<Vec<usize>> {
    let n = loops.len();
    if n <= 48 {
        return (0..n)
            .map(|i| contained_by_linear(loops, outlines, i, 0..n))
            .collect();
    }
    let cell = 8.0_f64;
    let mut buckets: HashMap<(i64, i64), Vec<usize>> = HashMap::new();
    for (j, outline) in outlines.iter().enumerate() {
        let Some((mn, mx)) = outline.bounds else {
            continue;
        };
        let x0 = (mn[0] / cell).floor() as i64;
        let x1 = (mx[0] / cell).floor() as i64;
        let y0 = (mn[1] / cell).floor() as i64;
        let y1 = (mx[1] / cell).floor() as i64;
        for x in x0..=x1 {
            for y in y0..=y1 {
                buckets.entry((x, y)).or_default().push(j);
            }
        }
    }
    (0..n)
        .map(|i| {
            let Some(&p) = loops[i].first() else {
                return Vec::new();
            };
            let key = ((p[0] / cell).floor() as i64, (p[1] / cell).floor() as i64);
            let Some(ids) = buckets.get(&key) else {
                return Vec::new();
            };
            let mut hits: Vec<usize> = ids
                .iter()
                .copied()
                .filter(|&j| j != i && outlines[j].box_holds(p) && outlines[j].contains(p))
                .collect();
            hits.sort_unstable();
            hits.dedup();
            hits
        })
        .collect()
}

fn contained_by_linear(
    loops: &[Loop],
    outlines: &[Outline],
    i: usize,
    js: impl Iterator<Item = usize>,
) -> Vec<usize> {
    let Some(&p) = loops[i].first() else {
        return Vec::new();
    };
    js.filter(|&j| j != i && outlines[j].box_holds(p) && outlines[j].contains(p))
        .collect()
}

/// A way into `node` from `from` in the combing search, ranked by its estimate
/// `f` of the whole route through it.
struct CombStep {
    f: f64,
    node: usize,
    from: usize,
}

impl Ord for CombStep {
    fn cmp(&self, other: &Self) -> CmpOrdering {
        self.f
            .total_cmp(&other.f)
            .then(self.node.cmp(&other.node))
            .then(self.from.cmp(&other.from))
    }
}

impl PartialOrd for CombStep {
    fn partial_cmp(&self, other: &Self) -> Option<CmpOrdering> {
        Some(self.cmp(other))
    }
}

impl PartialEq for CombStep {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == CmpOrdering::Equal
    }
}

impl Eq for CombStep {}

fn comb_between(comb: &Combing, from: [f64; 2], to: [f64; 2]) -> Comb {
    if dist2(from, to) < 0.04 * 0.04 {
        return Comb::Clear;
    }
    if comb.solid.route_inside(from, to) {
        return Comb::Clear;
    }
    if !comb.enabled {
        return Comb::Blocked;
    }
    if !comb.solid.contains(from) || !comb.solid.contains(to) {
        return Comb::Blocked;
    }
    let island = match (comb.island_of(from), comb.island_of(to)) {
        (Some(a), Some(b)) if a == b => &comb.islands[a],
        _ => return Comb::Blocked,
    };
    let (solid, inset) = (&island.solid, &island.inset);
    let mut nodes = Vec::new();
    for loop_ in inset.loops.iter() {
        let step = (loop_.len() / 64).max(1);
        for (i, p) in loop_.iter().enumerate() {
            if i % step == 0 {
                nodes.push(*p);
            }
        }
    }
    nodes.push(from);
    nodes.push(to);
    let n = nodes.len();
    let start = n - 2;
    let goal = n - 1;
    let visible = |i: usize, j: usize| {
        inset.route_inside(nodes[i], nodes[j])
            || (i == start || j == start || i == goal || j == goal)
                && solid.route_inside(nodes[i], nodes[j])
    };
    // A* over the visibility graph, testing an edge only when it is the cheapest
    // way left to reach its node. A plate with a hundred holes has thousands of
    // nodes, and the holes away from the travel are never tested.
    let span = |i: usize, j: usize| dist2(nodes[i], nodes[j]).sqrt();
    let mut dist = vec![f64::INFINITY; n];
    let mut prev = vec![usize::MAX; n];
    let mut open = BinaryHeap::new();
    open.push(Reverse(CombStep {
        f: span(start, goal),
        node: start,
        from: usize::MAX,
    }));
    while let Some(Reverse(CombStep {
        node: v, from: u, ..
    })) = open.pop()
    {
        if dist[v].is_finite() || u != usize::MAX && !visible(u, v) {
            continue;
        }
        dist[v] = if u == usize::MAX {
            0.0
        } else {
            dist[u] + span(u, v)
        };
        prev[v] = u;
        if v == goal {
            break;
        }
        for w in 0..n {
            if !dist[w].is_finite() {
                open.push(Reverse(CombStep {
                    f: dist[v] + span(v, w) + span(w, goal),
                    node: w,
                    from: v,
                }));
            }
        }
    }
    if !dist[goal].is_finite() {
        return Comb::Blocked;
    }
    let mut via = Vec::new();
    let mut cur = goal;
    while cur != start && cur != usize::MAX {
        if cur != goal {
            via.push(nodes[cur]);
        }
        cur = prev[cur];
    }
    via.reverse();
    if via.is_empty() {
        Comb::Clear
    } else {
        Comb::Routed(via)
    }
}

/// Mark travels that should lift. `mode` is the resolved policy (`Off`, `Smart`, or `Always`).
/// Smart never hops inside the infill inset, skips short moves and scarf ramps, and hops
/// when combing is blocked across a printed wall or top, or when leaving a top skin.
/// A hole crossing retracts in combing; smart hops that blocked travel, speed does not.
pub fn apply_z_hop(
    paths: &mut [Extrusion],
    solid: &[Loop],
    infill: &[Loop],
    mode: crate::strategy::ZHopMode,
    height: f64,
    min_travel: f64,
    after_top_layer: bool,
) {
    if height <= 1e-6 || mode == crate::strategy::ZHopMode::Off {
        return;
    }
    let (solid, infill) = (Outline::new(solid), Outline::new(infill));
    let mut cursor: Option<[f64; 2]> = None;
    let mut prev_top = false;
    let mut printed: Vec<([f64; 2], [f64; 2])> = Vec::new();
    for path in paths.iter_mut() {
        let Some(start) = path.points.first().copied() else {
            continue;
        };
        if let Some(from) = cursor {
            let mut chain = Vec::with_capacity(path.lead_in.len() + 2);
            chain.push(from);
            chain.extend(path.lead_in.iter().copied());
            chain.push(start);
            let travel = polyline_len(&chain);
            let spiral = !path.z_frac.is_empty();
            let inside_infill = !infill.loops.is_empty()
                && chain.windows(2).all(|w| infill.segment_inside(w[0], w[1]))
                && chain.windows(2).all(|w| solid.segment_inside(w[0], w[1]));
            let policy = match mode {
                crate::strategy::ZHopMode::Blend => {
                    if path.strategy == crate::strategy::StrategyId::Toughness {
                        crate::strategy::ZHopMode::Smart
                    } else {
                        crate::strategy::ZHopMode::Off
                    }
                }
                other => other,
            };
            let hop = if spiral || travel < min_travel || policy == crate::strategy::ZHopMode::Off {
                false
            } else if policy == crate::strategy::ZHopMode::Always {
                true
            } else if inside_infill {
                false
            } else if prev_top || after_top_layer {
                true
            } else {
                let blocked = path.travel_in != TravelIn::Inside && path.retract_mm > 0.0;
                blocked && chain_crosses(&chain, &solid, &printed)
            };
            if hop {
                path.z_hop = height;
            }
        }
        if matches!(
            path.kind,
            PathKind::Outer | PathKind::Inner | PathKind::Wall | PathKind::Top | PathKind::Ironing
        ) {
            for w in path.points.windows(2) {
                printed.push((w[0], w[1]));
            }
        }
        prev_top = matches!(path.kind, PathKind::Top | PathKind::Ironing);
        cursor = path.points.last().copied();
    }
}

fn chain_crosses(chain: &[[f64; 2]], solid: &Outline, printed: &[([f64; 2], [f64; 2])]) -> bool {
    let leaves = chain.windows(2).any(|w| !solid.segment_inside(w[0], w[1]));
    if leaves {
        return true;
    }
    chain.windows(2).any(|w| {
        printed
            .iter()
            .any(|&(a, b)| point_seg_dist(w[0], a, b) < 0.5 || point_seg_dist(w[1], a, b) < 0.5)
    })
}

/// Loops with their bounding boxes, so segment and point tests skip loops that
/// cannot touch them.
struct Outline<'a> {
    loops: Cow<'a, [Loop]>,
    boxes: Vec<([f64; 2], [f64; 2])>,
    bounds: Option<([f64; 2], [f64; 2])>,
    /// Built at the first test on an outline with many edges.
    cells: OnceLock<Option<EdgeCells>>,
}

impl<'a> Outline<'a> {
    fn new(loops: &'a [Loop]) -> Self {
        Self::from_cow(Cow::Borrowed(loops))
    }

    fn owned(loops: Vec<Loop>) -> Outline<'static> {
        Outline::from_cow(Cow::Owned(loops))
    }

    fn from_cow(loops: Cow<'a, [Loop]>) -> Self {
        let boxes = loops
            .iter()
            .map(|l| loop_bounds(std::slice::from_ref(l)).unwrap_or(([0.0; 2], [0.0; 2])))
            .collect();
        let bounds = loop_bounds(&loops);
        Self {
            loops,
            boxes,
            bounds,
            cells: OnceLock::new(),
        }
    }

    fn cells(&self) -> Option<&EdgeCells> {
        self.cells
            .get_or_init(|| EdgeCells::build(&self.loops, self.bounds?))
            .as_ref()
    }

    /// Whether loop `l`'s box meets the box of `a..b`.
    fn loop_meets(&self, l: usize, a: [f64; 2], b: [f64; 2]) -> bool {
        let lo = [a[0].min(b[0]), a[1].min(b[1])];
        let hi = [a[0].max(b[0]), a[1].max(b[1])];
        let (mn, mx) = self.boxes[l];
        !(hi[0] < mn[0] || lo[0] > mx[0] || hi[1] < mn[1] || lo[1] > mx[1])
    }

    /// Edge `k` of loop `l`, from vertex `k` to the next.
    fn edge(&self, l: usize, k: usize) -> ([f64; 2], [f64; 2]) {
        let loop_ = &self.loops[l];
        (loop_[k], loop_[(k + 1) % loop_.len()])
    }

    fn box_holds(&self, p: [f64; 2]) -> bool {
        self.bounds.is_some_and(|(mn, mx)| {
            p[0] >= mn[0] && p[0] <= mx[0] && p[1] >= mn[1] && p[1] <= mx[1]
        })
    }

    /// Loops whose box meets the box of `a..b`. The others cannot touch it.
    fn touching(&self, a: [f64; 2], b: [f64; 2]) -> impl Iterator<Item = &Loop> + '_ {
        (0..self.loops.len())
            .filter(move |&l| self.loop_meets(l, a, b))
            .map(|l| &self.loops[l])
    }

    /// Same answer as `in_solid`: a point outside a loop's box is outside that loop.
    fn contains(&self, p: [f64; 2]) -> bool {
        if let Some(cells) = self.cells() {
            // The parity of every crossing over the loops `touching` keeps.
            let mut inside = false;
            for &(l, k) in cells.row(p[1]) {
                let (l, k) = (l as usize, k as usize);
                if self.loops[l].len() >= 3 && self.loop_meets(l, p, p) {
                    let (pj, pi) = self.edge(l, k);
                    inside ^= crate::poly::ray_crosses(p[0], p[1], pi, pj);
                }
            }
            return inside;
        }
        self.touching(p, p)
            .filter(|l| crate::poly::point_in_loop(l, p[0], p[1]))
            .count()
            % 2
            == 1
    }

    fn crosses(&self, a: [f64; 2], b: [f64; 2]) -> bool {
        if let Some(cells) = self.cells() {
            return cells.near(a, b).any(|(l, k)| {
                let (c, d) = self.edge(l, k);
                self.loop_meets(l, a, b) && segments_properly_cross(a, b, c, d)
            });
        }
        self.touching(a, b).any(|l| {
            let n = l.len();
            n >= 2 && (0..n).any(|i| segments_properly_cross(a, b, l[i], l[(i + 1) % n]))
        })
    }

    /// True when the whole segment stays in the solid, holes included.
    /// A boundary crossing rejects the segment; the midpoint must also land inside.
    fn segment_inside(&self, a: [f64; 2], b: [f64; 2]) -> bool {
        if self.loops.is_empty() || self.crosses(a, b) {
            return false;
        }
        self.contains([(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5])
    }

    /// Like `segment_inside`, but touching the boundary anywhere except at the
    /// segment's own ends also counts as leaving. Clipper snaps to a 1 µm grid,
    /// so a travel that passes exactly through an outline vertex is common, and
    /// a proper-crossing test alone lets it slip out of the part there.
    fn route_inside(&self, a: [f64; 2], b: [f64; 2]) -> bool {
        if self.loops.is_empty() {
            return false;
        }
        let meets = self.touching(a, b).any(|l| {
            let n = l.len();
            n >= 2 && (0..n).any(|i| segment_meets(a, b, l[i], l[(i + 1) % n]))
        });
        !meets && self.contains([(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5])
    }

    /// A link that crosses no boundary and whose midpoint is inside, or just
    /// inside when nudged toward the region's centre.
    fn link_stays(&self, a: [f64; 2], b: [f64; 2]) -> bool {
        if self.crosses(a, b) {
            return false;
        }
        let mid = [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5];
        if self.contains(mid) {
            return true;
        }
        let Some((mn, mx)) = self.bounds else {
            return false;
        };
        let c = [(mn[0] + mx[0]) * 0.5, (mn[1] + mx[1]) * 0.5];
        let vx = c[0] - mid[0];
        let vy = c[1] - mid[1];
        let len = vx.hypot(vy).max(1e-9);
        self.contains([mid[0] + vx / len * 0.05, mid[1] + vy / len * 0.05])
    }

    fn clip_segment(&self, a: [f64; 2], b: [f64; 2]) -> Vec<[[f64; 2]; 2]> {
        clip_segment_in(self, a, b)
    }
}

/// An outline's edges on a grid, so a test reads the edges near it instead of
/// every edge. A cell lists each edge whose box meets it, a row each edge
/// whose height range meets it. Callers still apply their exact test and the
/// loop boxes `Outline::touching` applies.
struct EdgeCells {
    origin: [f64; 2],
    cell: f64,
    nx: usize,
    ny: usize,
    cells: Vec<Vec<(u32, u32)>>,
    rows: Vec<Vec<(u32, u32)>>,
}

/// Outlines with fewer edges are scanned whole.
const EDGE_CELLS_MIN: usize = 64;

/// How far from a segment `near` still finds an edge, mm. Far above the
/// rounding in the segment tests, far below a cell.
const EDGE_CELLS_SLACK: f64 = 1e-3;

impl EdgeCells {
    fn build(loops: &[Loop], (min, max): ([f64; 2], [f64; 2])) -> Option<Self> {
        let edges: usize = loops.iter().filter(|l| l.len() >= 2).map(|l| l.len()).sum();
        if edges < EDGE_CELLS_MIN {
            return None;
        }
        let w = (max[0] - min[0]).max(1e-6);
        let h = (max[1] - min[1]).max(1e-6);
        // About one edge per cell, at most 256 cells a side.
        let cell = (w * h / edges as f64).sqrt().max(w / 256.0).max(h / 256.0);
        let (nx, ny) = ((w / cell) as usize + 1, (h / cell) as usize + 1);
        let mut grid = Self {
            origin: min,
            cell,
            nx,
            ny,
            cells: vec![Vec::new(); nx * ny],
            rows: vec![Vec::new(); ny],
        };
        for (l, loop_) in loops.iter().enumerate() {
            if loop_.len() < 2 {
                continue;
            }
            for k in 0..loop_.len() {
                let (c, d) = (loop_[k], loop_[(k + 1) % loop_.len()]);
                let (x0, x1) = (grid.col(c[0].min(d[0])), grid.col(c[0].max(d[0])));
                for y in grid.row_at(c[1].min(d[1]))..=grid.row_at(c[1].max(d[1])) {
                    grid.rows[y].push((l as u32, k as u32));
                    for x in x0..=x1 {
                        grid.cells[y * grid.nx + x].push((l as u32, k as u32));
                    }
                }
            }
        }
        Some(grid)
    }

    fn col(&self, x: f64) -> usize {
        (((x - self.origin[0]) / self.cell).floor().max(0.0) as usize).min(self.nx - 1)
    }

    fn row_at(&self, y: f64) -> usize {
        (((y - self.origin[1]) / self.cell).floor().max(0.0) as usize).min(self.ny - 1)
    }

    /// Edges whose height range can hold `y`, each once.
    fn row(&self, y: f64) -> &[(u32, u32)] {
        &self.rows[self.row_at(y)]
    }

    /// Edges within `EDGE_CELLS_SLACK` of segment `a..b`, some more than once.
    /// Each column the segment spans gives the rows its height covers there.
    fn near(&self, a: [f64; 2], b: [f64; 2]) -> impl Iterator<Item = (usize, usize)> + '_ {
        let s = EDGE_CELLS_SLACK;
        let (x_lo, x_hi) = (a[0].min(b[0]), a[0].max(b[0]));
        let y_at = move |x: f64| {
            let t = ((x - a[0]) / (b[0] - a[0])).clamp(0.0, 1.0);
            a[1] + (b[1] - a[1]) * t
        };
        (self.col(x_lo - s)..=self.col(x_hi + s))
            .flat_map(move |x| {
                let (y0, y1) = if (b[0] - a[0]).abs() < 1e-9 {
                    (a[1].min(b[1]), a[1].max(b[1]))
                } else {
                    let left = self.origin[0] + x as f64 * self.cell - s;
                    let right = left + self.cell + 2.0 * s;
                    let (ya, yb) = (y_at(left.max(x_lo)), y_at(right.min(x_hi)));
                    (ya.min(yb), ya.max(yb))
                };
                (self.row_at(y0 - s)..=self.row_at(y1 + s)).map(move |y| y * self.nx + x)
            })
            .flat_map(move |i| self.cells[i].iter())
            .map(|&(l, k)| (l as usize, k as usize))
    }
}

fn segments_properly_cross(a: [f64; 2], b: [f64; 2], c: [f64; 2], d: [f64; 2]) -> bool {
    let o1 = orient(a, b, c);
    let o2 = orient(a, b, d);
    let o3 = orient(c, d, a);
    let o4 = orient(c, d, b);
    o1 * o2 < -1e-10 && o3 * o4 < -1e-10
}

/// `a..b` and `c..d` share a point other than `a` or `b`: a proper crossing,
/// or `c` or `d` lying on `a..b` strictly between its ends.
fn segment_meets(a: [f64; 2], b: [f64; 2], c: [f64; 2], d: [f64; 2]) -> bool {
    const ON: f64 = 1e-9;
    let side = |o: f64| {
        if o > ON {
            1
        } else if o < -ON {
            -1
        } else {
            0
        }
    };
    let (o1, o2) = (orient(a, b, c), orient(a, b, d));
    let (s1, s2) = (side(o1), side(o2));
    let (s3, s4) = (side(orient(c, d, a)), side(orient(c, d, b)));
    if s1 * s2 < 0 && s3 * s4 < 0 {
        return true;
    }
    let within = |p: [f64; 2]| {
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let len2 = dx * dx + dy * dy;
        if len2 <= 0.0 {
            return false;
        }
        let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
        let len = len2.sqrt();
        t * len > 1e-6 && (1.0 - t) * len > 1e-6
    };
    (s1 == 0 && within(c)) || (s2 == 0 && within(d))
}

fn orient(p: [f64; 2], q: [f64; 2], r: [f64; 2]) -> f64 {
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
}

/// Slow unsupported spans, pin bridges, and raise the fan. The first layer is on the bed.
pub fn apply_overhang(
    paths: &mut Vec<Extrusion>,
    lower: &[Loop],
    layer_height: f64,
    line_width: f64,
) {
    if lower.is_empty() || paths.is_empty() {
        return;
    }
    let margin = line_width * 0.65;
    let mut next = Vec::with_capacity(paths.len());
    for path in paths.drain(..) {
        if matches!(
            path.kind,
            PathKind::Skirt | PathKind::Support | PathKind::SupportInterface
        ) || path.points.len() < 2
        {
            next.push(path);
            continue;
        }
        next.extend(split_overhang(path, lower, layer_height, margin));
    }
    *paths = next;
}

fn split_overhang(
    path: Extrusion,
    lower: &[Loop],
    layer_height: f64,
    margin: f64,
) -> Vec<Extrusion> {
    let pts = &path.points;
    let mut out = Vec::new();
    let mut cur: Vec<[f64; 2]> = vec![pts[0]];
    let mut cur_class = span_class(pts[0], pts[1], lower, layer_height, margin);
    for w in pts.windows(2) {
        let class = span_class(w[0], w[1], lower, layer_height, margin);
        if class_tag(class) != class_tag(cur_class) && cur.len() >= 2 {
            out.push(paint(&path, std::mem::take(&mut cur), cur_class));
            cur.push(w[0]);
        }
        cur.push(w[1]);
        cur_class = class;
    }
    if cur.len() >= 2 {
        out.push(paint(&path, cur, cur_class));
    }
    if out.is_empty() {
        vec![path]
    } else {
        out
    }
}

#[derive(Clone, Copy)]
enum SpanClass {
    Supported,
    Overhang(f64),
    Bridge,
}

fn class_tag(c: SpanClass) -> u8 {
    match c {
        SpanClass::Supported => 0,
        SpanClass::Overhang(_) => 1,
        SpanClass::Bridge => 2,
    }
}

fn span_class(
    a: [f64; 2],
    b: [f64; 2],
    lower: &[Loop],
    layer_height: f64,
    margin: f64,
) -> SpanClass {
    let mid = [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5];
    let sa = supported(a, lower, margin);
    let sb = supported(b, lower, margin);
    let sm = supported(mid, lower, margin);
    if sa && sb && !sm {
        let len = dist2(a, b).sqrt();
        if len >= 1.2 {
            return SpanClass::Bridge;
        }
    }
    if sm {
        return SpanClass::Supported;
    }
    let outside = outside_dist(mid, lower).max(outside_dist(a, lower));
    let angle = (outside / layer_height.max(0.05)).atan().to_degrees();
    if angle < 42.0 {
        SpanClass::Supported
    } else {
        SpanClass::Overhang(angle)
    }
}

fn paint(src: &Extrusion, points: Vec<[f64; 2]>, class: SpanClass) -> Extrusion {
    let mut path = src.clone();
    path.points = points;
    let slow = match class {
        SpanClass::Supported => Slowdown::None,
        SpanClass::Bridge => {
            path.kind = PathKind::Bridge;
            path.fan = 255;
            path.strength = path.strength.min(0.7);
            Slowdown::Bridge
        }
        SpanClass::Overhang(angle) => {
            path.fan = path.fan.max(if angle >= 68.0 { 255 } else { 220 });
            path.on_overhang = true;
            if angle >= 68.0 {
                Slowdown::Steep
            } else {
                Slowdown::Overhang
            }
        }
    };
    path.speed = slow.speed(path.speed);
    if let Some(cap) = &mut path.cap_feed {
        cap.slow = slow;
    }
    path
}

fn supported(p: [f64; 2], lower: &[Loop], margin: f64) -> bool {
    if in_solid(lower, p[0], p[1]) {
        return true;
    }
    outside_dist(p, lower) <= margin
}

fn outside_dist(p: [f64; 2], lower: &[Loop]) -> f64 {
    if in_solid(lower, p[0], p[1]) {
        return 0.0;
    }
    let mut best = f64::MAX;
    for loop_ in lower {
        let n = loop_.len();
        for i in 0..n {
            let d = point_seg_dist(p, loop_[i], loop_[(i + 1) % n]);
            if d < best {
                best = d;
            }
        }
    }
    best
}

fn point_seg_dist(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    let abx = b[0] - a[0];
    let aby = b[1] - a[1];
    let len2 = abx * abx + aby * aby;
    if len2 < 1e-12 {
        return dist2(p, a).sqrt();
    }
    let t = ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len2;
    let t = t.clamp(0.0, 1.0);
    dist2(p, [a[0] + abx * t, a[1] + aby * t]).sqrt()
}

/// Spread a closed wall's seam into a scarf joint.
///
/// The loop still starts at the corner-or-nearest seam. When that vertex is a
/// sharp convex corner, the corner hide wins and the path is left alone. On a
/// smooth seam the start ramps from `start_height` up to the layer Z over
/// `length`, the body stays at full height, and the end retraces that same
/// length at full Z while flow ramps back down. The second pass never drops
/// below plastic the start ramp already deposited. The first layer, open paths,
/// bridges, overhang spans, and loops shorter than 8 mm are skipped. Tiny
/// loops that clear 8 mm clamp the scarf to 45% of the perimeter so the two
/// ramps cannot wrap around each other.
pub fn apply_scarf(paths: &mut [Extrusion], params: &ScarfParams) {
    for path in paths.iter_mut() {
        scarf_one(path, params);
    }
}

fn scarf_one(path: &mut Extrusion, params: &ScarfParams) {
    if params.layer_index == 0 || params.length < 0.5 || params.steps < 2 {
        return;
    }
    if !scarf_kind(path, params.mode) || path.on_overhang || path.kind == PathKind::Bridge {
        return;
    }
    let h0 = params.start_height.clamp(0.0, 0.9);
    let f0 = params.start_flow.clamp(0.05, 1.0);
    scarf_path(path, params.length, params.steps, h0, f0);
}

pub struct ScarfParams {
    pub mode: ScarfSeam,
    pub length: f64,
    pub steps: u32,
    pub start_height: f64,
    pub start_flow: f64,
    pub layer_index: usize,
}

fn scarf_kind(path: &Extrusion, requested: ScarfSeam) -> bool {
    let mode = match requested {
        ScarfSeam::Blend => path_blend_scarf(path.strategy),
        other => other,
    };
    match mode {
        ScarfSeam::Off | ScarfSeam::Blend => false,
        ScarfSeam::Outer => matches!(path.kind, PathKind::Outer | PathKind::Wall),
        ScarfSeam::All => matches!(
            path.kind,
            PathKind::Outer | PathKind::Inner | PathKind::Wall
        ),
    }
}

fn path_blend_scarf(strategy: StrategyId) -> ScarfSeam {
    match strategy {
        StrategyId::Toughness => ScarfSeam::Outer,
        StrategyId::Speed => ScarfSeam::Off,
    }
}

fn scarf_path(path: &mut Extrusion, length: f64, steps: u32, h0: f64, f0: f64) {
    let pts = &path.points;
    if pts.len() < 4 || dist2(pts[0], *pts.last().unwrap()) > 1e-8 {
        return;
    }
    let ring_len = pts.len() - 1;
    if seam_is_sharp(&pts[..ring_len]) {
        return;
    }
    let perim = polyline_len(pts);
    if perim < 8.0 {
        return;
    }
    let scarf = length.min(perim * 0.45);
    if scarf < 1.0 {
        return;
    }
    let steps = (steps as usize).clamp(2, 64);
    let ramp = ramp_points(pts, scarf, steps);
    let mut out = Vec::new();
    let mut z = Vec::new();
    let mut flow = Vec::new();
    for &(p, along) in &ramp {
        let t = along / scarf;
        out.push(p);
        z.push(h0 + (1.0 - h0) * t);
        flow.push(f0 + (1.0 - f0) * t);
    }
    let mut acc = 0.0;
    for w in pts.windows(2) {
        let seg = (dist2(w[0], w[1])).sqrt();
        let next = acc + seg;
        if acc >= scarf - 1e-4 && next < perim - 1e-4 {
            push_unique(&mut out, &mut z, &mut flow, w[0], 1.0, 1.0);
            push_unique(&mut out, &mut z, &mut flow, w[1], 1.0, 1.0);
        } else if acc < scarf && next > scarf + 1e-4 && next < perim - 1e-4 {
            push_unique(&mut out, &mut z, &mut flow, w[1], 1.0, 1.0);
        }
        acc = next;
    }
    push_unique(&mut out, &mut z, &mut flow, pts[0], 1.0, 1.0);
    for &(p, along) in &ramp[1..] {
        out.push(p);
        z.push(1.0);
        flow.push((1.0 - (1.0 - f0) * along / scarf).clamp(0.05, 1.0));
    }
    path.points = out;
    path.z_frac = z;
    path.flow_frac = flow;
    path.scarf_mm = scarf;
}

/// The loop from its start to `scarf` along it, with each point's distance
/// from the start: every vertex in that stretch, plus `steps` evenly spaced
/// marks so no Z step is larger than a mark apart. Keeping the vertices is
/// what keeps the ramp on a curved wall; the marks alone are chords that cut
/// inside it.
fn ramp_points(pts: &[[f64; 2]], scarf: f64, steps: usize) -> Vec<([f64; 2], f64)> {
    let mut out = vec![(pts[0], 0.0)];
    let mut mark = 1;
    let mut acc = 0.0;
    for w in pts.windows(2) {
        let seg = dist2(w[0], w[1]).sqrt();
        if seg < 1e-12 {
            continue;
        }
        let next = acc + seg;
        while mark <= steps {
            let at = scarf * mark as f64 / steps as f64;
            if at > next + 1e-9 {
                break;
            }
            let t = ((at - acc) / seg).clamp(0.0, 1.0);
            out.push((
                [
                    w[0][0] + (w[1][0] - w[0][0]) * t,
                    w[0][1] + (w[1][1] - w[0][1]) * t,
                ],
                at,
            ));
            mark += 1;
        }
        if mark > steps {
            break;
        }
        if out.last().is_none_or(|(_, along)| next - along > 1e-9) {
            out.push((w[1], next));
        }
        acc = next;
    }
    out
}

fn seam_is_sharp(ring: &[[f64; 2]]) -> bool {
    ring.len() >= 3 && turn_penalty(ring, 0) < 0.45
}

fn push_unique(
    pts: &mut Vec<[f64; 2]>,
    z: &mut Vec<f64>,
    flow: &mut Vec<f64>,
    p: [f64; 2],
    zf: f64,
    ff: f64,
) {
    if let Some(last) = pts.last() {
        if dist2(*last, p) < 1e-10 {
            return;
        }
    }
    pts.push(p);
    z.push(zf);
    flow.push(ff);
}

fn point_along(pts: &[[f64; 2]], dist: f64) -> [f64; 2] {
    if pts.len() < 2 || dist <= 0.0 {
        return pts[0];
    }
    let mut left = dist;
    for w in pts.windows(2) {
        let seg = dist2(w[0], w[1]).sqrt();
        if left <= seg || seg < 1e-12 {
            if seg < 1e-12 {
                continue;
            }
            let t = (left / seg).clamp(0.0, 1.0);
            return [
                w[0][0] + (w[1][0] - w[0][0]) * t,
                w[0][1] + (w[1][1] - w[0][1]) * t,
            ];
        }
        left -= seg;
    }
    *pts.last().unwrap()
}

fn polyline_len(pts: &[[f64; 2]]) -> f64 {
    pts.windows(2)
        .map(|w| {
            let dx = w[1][0] - w[0][0];
            let dy = w[1][1] - w[0][1];
            dx.hypot(dy)
        })
        .sum()
}

#[cfg(test)]
mod travel_tests {
    use super::*;
    use crate::strategy::{pure, StrategyId};

    fn path(kind: PathKind, pts: Vec<[f64; 2]>) -> Extrusion {
        extrusion(kind, &pure(StrategyId::Speed), pts, 0.45)
    }

    /// Euclidean travel between the paths as ordered.
    fn nozzle_travel(paths: &[Extrusion]) -> f64 {
        let mut cursor = [0.0, 0.0];
        let mut has = false;
        let mut travel = 0.0;
        for path in paths {
            if path.points.is_empty() {
                continue;
            }
            if !has {
                cursor = *path.points.last().unwrap();
                has = true;
                continue;
            }
            travel += dist_mm(cursor, path.points[0]);
            cursor = *path.points.last().unwrap();
        }
        travel
    }

    fn square_at(x: f64, y: f64, size: f64) -> Loop {
        vec![[x, y], [x + size, y], [x + size, y + size], [x, y + size]]
    }

    #[test]
    fn a_travel_between_islands_retracts() {
        let solid = vec![square_at(0.0, 0.0, 10.0), square_at(11.4, 0.0, 10.0)];
        let comb = Combing::new(&solid, true, 0.36);
        assert!(matches!(
            comb_between(&comb, [9.0, 5.0], [12.4, 5.0]),
            Comb::Blocked
        ));
        assert!(matches!(
            comb_between(&comb, [1.0, 1.0], [9.0, 9.0]),
            Comb::Clear
        ));
    }

    #[test]
    fn a_travel_around_a_hole_stays_in_its_island() {
        let ring = vec![
            square_at(0.0, 0.0, 10.0),
            square_at(3.0, 3.0, 4.0).into_iter().rev().collect(),
            square_at(4.0, 4.0, 2.0),
        ];
        let comb = Combing::new(&ring, true, 0.36);
        let Comb::Routed(via) = comb_between(&comb, [1.0, 5.0], [9.0, 5.0]) else {
            panic!("a travel across the hole should comb around it");
        };
        assert!(via.iter().all(|p| p[1] < 3.0 || p[1] > 7.0), "{via:?}");
        assert!(matches!(
            comb_between(&comb, [1.0, 5.0], [5.0, 5.0]),
            Comb::Blocked
        ));
    }

    fn ring(x: f64, y: f64, size: f64) -> Vec<[f64; 2]> {
        let mut pts = square_at(x, y, size);
        pts.push(pts[0]);
        pts
    }

    #[test]
    fn a_scarf_ramp_keeps_every_vertex_of_a_curved_wall() {
        let ring: Vec<[f64; 2]> = (0..=64)
            .map(|i| {
                let a = std::f64::consts::TAU * (i % 64) as f64 / 64.0;
                [10.0 * a.cos(), 10.0 * a.sin()]
            })
            .collect();
        let mut wall = extrusion(
            PathKind::Outer,
            &pure(StrategyId::Toughness),
            ring.clone(),
            0.45,
        );
        scarf_path(&mut wall, 10.0, 8, 0.15, 0.55);
        assert!(wall.scarf_mm > 9.9, "scarf {}", wall.scarf_mm);
        let step = dist_mm(ring[0], ring[1]);
        let on_ramp = ring
            .iter()
            .enumerate()
            .filter(|(i, _)| *i as f64 * step <= 10.0);
        for (i, v) in on_ramp {
            assert!(
                wall.points.iter().any(|p| dist2(*p, *v) < 1e-12),
                "ramp skipped vertex {i} at {v:?}"
            );
        }
    }

    #[test]
    fn a_layer_prints_island_by_island() {
        let solid = vec![square_at(0.0, 0.0, 10.0), square_at(20.0, 0.0, 10.0)];
        let mut paths = vec![
            path(PathKind::Outer, ring(0.2, 0.2, 9.6)),
            path(PathKind::Outer, ring(20.2, 0.2, 9.6)),
            path(PathKind::Sparse, vec![[1.0, 5.0], [9.0, 5.0]]),
            path(PathKind::Sparse, vec![[21.0, 5.0], [29.0, 5.0]]),
        ];
        order_part(&mut paths, &solid, Some([0.0, 0.0]), None);
        let order: Vec<(PathKind, bool)> = paths
            .iter()
            .map(|p| (p.kind, p.points[0][0] < 15.0))
            .collect();
        assert_eq!(
            order,
            vec![
                (PathKind::Outer, true),
                (PathKind::Sparse, true),
                (PathKind::Outer, false),
                (PathKind::Sparse, false),
            ]
        );
    }

    #[test]
    fn an_aligned_seam_stays_and_an_inner_wall_starts_near_the_nozzle() {
        let tough = pure(StrategyId::Toughness);
        let outer = extrusion(PathKind::Outer, &tough, ring(0.0, 0.0, 10.0), 0.45);
        let mut far = square_at(0.45, 0.45, 9.1);
        far.rotate_left(2);
        far.push(far[0]);
        let inner = extrusion(PathKind::Inner, &tough, far, 0.45);
        let mut paths = vec![outer, inner];
        order_part(&mut paths, &[], Some([10.0, 10.0]), None);
        assert_eq!(paths[0].points[0], [0.0, 0.0], "aligned seam moved");
        assert_eq!(
            paths[1].points[0],
            [0.45, 0.45],
            "inner wall should start by the outer seam"
        );
    }

    #[test]
    fn a_rear_seam_takes_a_corner_at_the_back_and_aligned_the_sharpest() {
        let house = vec![[0.0, 0.0], [10.0, 0.0], [10.0, 6.0], [5.0, 10.0], [0.0, 6.0]];
        assert_eq!(rear_seam(&house), 3, "the roof peak");
        assert_eq!(aligned_seam(&house), 1, "the front +X corner");
    }

    #[test]
    fn a_rear_seam_without_a_back_corner_takes_the_rear_most_vertex() {
        let mut d: Vec<[f64; 2]> = vec![[-10.0, 0.0]];
        d.extend((0..32).map(|k| {
            let a = std::f64::consts::PI * k as f64 / 32.0;
            [10.0 * a.cos(), 10.0 * a.sin()]
        }));
        let at = rear_seam(&d);
        assert_eq!(at, 17);
        assert_eq!(d[at][1], 10.0);
        assert_eq!(aligned_seam(&d), 1, "aligned keeps the front +X corner");
    }

    #[test]
    fn a_rear_seam_breaks_a_tie_toward_plus_x() {
        let flat = vec![[0.0, 0.0], [4.0, 0.0], [8.0, 0.0], [8.0, 5.0], [4.0, 5.0], [0.0, 5.0]];
        assert_eq!(rear_seam(&flat), 3);
    }

    /// Where a square's outer wall and a triangle's inner wall start, planned
    /// under `strategy` and toured from the front-left corner. The inner
    /// wall's back corner is far from where the outer wall ends.
    fn wall_starts(strategy: &ResolvedStrategy) -> Vec<(PathKind, [f64; 2])> {
        let mut paths = Vec::new();
        let mut hint = [0.0, 0.0];
        let outer = [square_at(0.0, 0.0, 10.0)];
        let inner = [vec![[1.0, 1.0], [7.0, 1.0], [1.0, 6.0]]];
        emit_loops(&mut paths, &outer, PathKind::Outer, strategy, 0.45, &mut hint);
        emit_loops(&mut paths, &inner, PathKind::Inner, strategy, 0.45, &mut hint);
        order_part(&mut paths, &[], Some([0.0, 0.0]), None);
        paths.iter().map(|p| (p.kind, p.points[0])).collect()
    }

    #[test]
    fn an_explicit_seam_starts_the_inner_wall_where_the_outer_wall_starts() {
        let mut placed = pure(StrategyId::Speed);
        placed.seam = SeamMode::Rear;
        placed.inner_follows_seam = true;
        assert_eq!(
            wall_starts(&placed),
            vec![(PathKind::Outer, [10.0, 10.0]), (PathKind::Inner, [1.0, 6.0])]
        );
        placed.inner_follows_seam = false;
        assert_eq!(
            wall_starts(&placed),
            vec![(PathKind::Outer, [10.0, 10.0]), (PathKind::Inner, [7.0, 1.0])],
            "without an explicit seam the inner wall starts near the nozzle"
        );
    }

    #[test]
    fn a_route_through_an_outline_vertex_is_not_inside() {
        let loop_ = vec![[1.0, 1.0], [4.0, 1.5], [4.5, 4.5], [1.5, 4.0]];
        let outline = Outline::new(std::slice::from_ref(&loop_));
        assert!(!outline.route_inside([0.0, 0.0], [4.0, 4.0]));
        assert!(outline.route_inside([2.0, 2.0], [4.0, 4.0]));
    }

    #[test]
    fn edge_cells_answer_as_the_full_scan() {
        // A wavy band on Clipper's 1 µm grid, with enough edges for the grid.
        let ring = |r: f64, n: usize| -> Loop {
            (0..n)
                .map(|i| {
                    let a = i as f64 / n as f64 * std::f64::consts::TAU;
                    let rr = r + r * 0.1 * (7.0 * a).sin();
                    let snap = |v: f64| (v * 1000.0).round() / 1000.0;
                    [snap(50.0 + rr * a.cos()), snap(40.0 + rr * a.sin())]
                })
                .collect()
        };
        let mut hole = ring(12.0, 150);
        hole.reverse();
        let loops = vec![ring(30.0, 250), hole];
        let indexed = Outline::new(&loops);
        let scanned = Outline::new(&loops);
        assert!(indexed.cells().is_some());
        assert!(scanned.cells.set(None).is_ok());
        assert!(indexed.contains([71.0, 40.3]));
        assert!(!indexed.contains([50.0, 40.3]));
        assert!(indexed.crosses([50.0, 40.3], [71.0, 40.3]));
        assert_eq!(
            indexed.clip_segment([10.0, 40.3], [90.0, 40.3]).len(),
            2,
            "a chord through the hole keeps the band on each side"
        );
        // Random points, then the outline's own vertices, whose segments run
        // along edges and through vertices.
        let mut seed = 7u64;
        let mut next = || {
            seed = seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (seed >> 11) as f64 / (1u64 << 53) as f64
        };
        let mut pts: Vec<[f64; 2]> = (0..2000)
            .map(|_| [10.0 + next() * 80.0, next() * 80.0])
            .collect();
        pts.extend(loops.iter().flatten().copied());
        for w in pts.windows(2) {
            let (a, b) = (w[0], w[1]);
            assert_eq!(indexed.contains(a), scanned.contains(a), "contains {a:?}");
            assert_eq!(
                indexed.crosses(a, b),
                scanned.crosses(a, b),
                "crosses {a:?} {b:?}"
            );
            assert_eq!(
                indexed.clip_segment(a, b),
                scanned.clip_segment(a, b),
                "clip {a:?} {b:?}"
            );
        }
    }

    #[test]
    fn long_chord_does_not_pull_the_nozzle_off_nearby_infill() {
        let mut paths = vec![path(
            PathKind::Outer,
            vec![[0.0, 0.0], [0.2, 0.0], [0.2, 0.2], [0.0, 0.2], [0.0, 0.0]],
        )];
        paths.push(path(PathKind::Sparse, vec![[0.05, 0.0], [80.0, 0.0]]));
        for i in 0..6 {
            let y = 2.0 + i as f64;
            paths.push(path(PathKind::Sparse, vec![[0.0, y], [3.0, y]]));
        }
        order_part(&mut paths, &[], None, None);
        let travel = nozzle_travel(&paths);
        assert!(
            travel < 30.0,
            "nearby infill should print before the 80 mm chord, travel {travel:.1} mm"
        );
    }

    #[test]
    fn closed_infill_starts_at_the_near_vertex() {
        let mut paths = vec![
            path(PathKind::Sparse, vec![[0.0, 0.0], [10.0, 10.0]]),
            path(
                PathKind::Sparse,
                vec![
                    [0.0, 0.0],
                    [10.0, 0.0],
                    [10.0, 10.0],
                    [0.0, 10.0],
                    [0.0, 0.0],
                ],
            ),
        ];
        order_part(&mut paths, &[], None, None);
        let travel = nozzle_travel(&paths);
        assert!(travel < 1.0, "seam or order left {travel:.2} mm");
        if paths[0].points.len() == 2 {
            let seam = paths[1].points[0];
            assert!(
                (seam[0] - 10.0).abs() < 1e-6 && (seam[1] - 10.0).abs() < 1e-6,
                "seam {seam:?}"
            );
        }
    }

    #[test]
    fn walls_stay_ahead_of_infill() {
        let mut paths = vec![
            path(
                PathKind::Outer,
                vec![[0.0, 0.0], [4.0, 0.0], [4.0, 4.0], [0.0, 4.0], [0.0, 0.0]],
            ),
            path(
                PathKind::Outer,
                vec![
                    [20.0, 0.0],
                    [24.0, 0.0],
                    [24.0, 4.0],
                    [20.0, 4.0],
                    [20.0, 0.0],
                ],
            ),
            path(PathKind::Sparse, vec![[1.0, 1.0], [3.0, 1.0]]),
            path(PathKind::Sparse, vec![[1.0, 2.0], [3.0, 2.0]]),
        ];
        order_part(&mut paths, &[], None, None);
        let kinds: Vec<_> = paths.iter().map(|p| p.kind).collect();
        assert!(
            kinds.starts_with(&[PathKind::Outer, PathKind::Outer]),
            "{kinds:?}"
        );
        assert!(kinds[2..].iter().all(|k| *k == PathKind::Sparse));
    }

    #[test]
    fn travel_order_is_deterministic() {
        let mut once = vec![
            path(PathKind::Sparse, vec![[0.0, 0.0], [8.0, 0.0]]),
            path(PathKind::Sparse, vec![[30.0, 5.0], [34.0, 5.0]]),
            path(PathKind::Sparse, vec![[0.0, 2.0], [8.0, 2.0]]),
            path(PathKind::Sparse, vec![[30.0, 7.0], [34.0, 7.0]]),
        ];
        let mut twice = once.clone();
        order_part(&mut once, &[], None, None);
        order_part(&mut twice, &[], None, None);
        let a: Vec<_> = once.iter().map(|p| p.points.clone()).collect();
        let b: Vec<_> = twice.iter().map(|p| p.points.clone()).collect();
        assert_eq!(a, b);
    }

    #[test]
    fn hilbert_of_the_origin_is_zero() {
        assert_eq!(hilbert_d(0, 0), 0);
    }

    /// A V-shaped membrane 0.15 mm thick. Tip to heel (3.2 mm) is farther than
    /// tip to tip (2 mm), so splitting at the farthest pair ran the spine from
    /// one tip across the gap between the arms and left the other arm bare.
    #[test]
    fn a_bent_sliver_spine_runs_tip_to_tip_inside_it() {
        let ring = vec![
            [-1.0, 0.0],
            [-0.85, 0.0],
            [0.0, -2.5],
            [0.85, 0.0],
            [1.0, 0.0],
            [0.0, -3.0],
        ];
        let spine = sliver_spine(&ring, 0.2).unwrap();
        let ends = [spine[0], *spine.last().unwrap()];
        for tip in [[-0.925, 0.0], [0.925, 0.0]] {
            assert!(
                ends.iter().any(|e| dist_mm(*e, tip) < 0.2),
                "no spine end near {tip:?}: {ends:?}"
            );
        }
        let outline = [ring.clone()];
        for p in &spine {
            assert!(
                crate::poly::point_in_loop(&ring, p[0], p[1])
                    || crate::poly::distance_to_outline(&outline, *p) < 0.05,
                "spine point {p:?} leaves the sliver"
            );
        }
    }

    /// The grid nearest-neighbor must print the same sequence as the linear
    /// scan, including equal-distance ties and closed walls.
    #[test]
    fn grid_nearest_matches_the_linear_scan() {
        let mut state = 0x1234_5678_9abc_u64;
        let mut rnd = || {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1);
            (state >> 33) as f64 / f64::from(1u32 << 31)
        };
        let mut paths = Vec::new();
        for i in 0..180 {
            let x = rnd() * 300.0 - 20.0;
            let y = rnd() * 200.0 - 10.0;
            if i % 17 == 0 {
                paths.push(path(PathKind::GapFill, vec![[x, y], [x, y]]));
            } else if i % 11 == 0 {
                paths.push(path(PathKind::Outer, ring(x, y, 1.2 + rnd())));
            } else if i % 13 == 0 {
                paths.push(path(PathKind::GapFill, Vec::new()));
            } else {
                paths.push(path(
                    PathKind::Sparse,
                    vec![[x, y], [x + rnd() * 4.0, y + rnd() * 3.0]],
                ));
            }
        }
        // Several segments share a point so equal distances have a winner.
        for k in 0..8 {
            paths.push(path(
                PathKind::Solid,
                vec![[40.0, 40.0], [40.0 + k as f64, 48.0]],
            ));
        }
        let cursor = [12.5, -3.0];
        let grid = approach_grid(&paths);
        let got = legacy_nn_indices(&paths, grid.as_ref(), cursor, true);
        let mut pending: Vec<usize> = (0..paths.len()).collect();
        let mut expect = Vec::new();
        let mut at = cursor;
        let mut has = true;
        while !pending.is_empty() {
            let best_i = pending_winner_linear(&paths, &pending, at, has);
            let idx = pending.swap_remove(best_i);
            if !paths[idx].points.is_empty() {
                at = oriented_ends(&paths[idx], at, has, false).1;
                has = true;
            }
            expect.push(idx);
        }
        assert_eq!(got, expect);
        let seated = order_nearest(paths.clone(), grid.as_ref(), cursor, true, None);
        let mut replay = Vec::new();
        let mut at = cursor;
        let mut has = true;
        for idx in expect {
            let mut path = paths[idx].clone();
            orient_path(&mut path, at, has, false);
            if let Some(end) = path.points.last() {
                at = *end;
                has = true;
            }
            replay.push(path.points);
        }
        let seated_pts: Vec<_> = seated.iter().map(|p| p.points.clone()).collect();
        assert_eq!(seated_pts, replay);
    }

    #[test]
    fn island_grid_matches_pairwise_containment() {
        let mut loops = vec![square_at(0.0, 0.0, 80.0)];
        for i in 0..70 {
            let x = (i % 10) as f64 * 7.5 + 1.0;
            let y = (i / 10) as f64 * 10.0 + 1.0;
            loops.push(square_at(x, y, 3.0 + (i % 3) as f64));
        }
        loops.push(square_at(2.0, 2.0, 1.0));
        let outlines: Vec<Outline> = loops
            .iter()
            .map(|l| Outline::new(std::slice::from_ref(l)))
            .collect();
        let got = containing_loops(&loops, &outlines);
        let expect: Vec<Vec<usize>> = (0..loops.len())
            .map(|i| contained_by_linear(&loops, &outlines, i, 0..loops.len()))
            .collect();
        assert_eq!(got, expect);
    }

    #[test]
    fn void_skin_area_matches_the_full_difference() {
        let mut clip = Vec::new();
        for i in 0..30 {
            for j in 0..12 {
                clip.push(square_at(i as f64 * 6.0, j as f64 * 6.0, 4.0));
            }
        }
        let mut hole = square_at(10.0, 10.0, 6.0);
        if signed_area(&hole) > 0.0 {
            hole.reverse();
        }
        let plate = vec![square_at(0.0, 0.0, 40.0), hole];
        let probes = [
            vec![square_at(0.4, 0.4, 1.2)],
            vec![square_at(4.3, 0.4, 1.0)],
            vec![square_at(3.2, 0.5, 1.6)],
            vec![square_at(3.7, 3.7, 2.4)],
            vec![square_at(-8.0, 2.0, 3.0)],
            vec![square_at(1.0, 1.0, 2.0), square_at(1.4, 1.4, 0.8)],
            vec![square_at(12.0, 12.0, 1.5)],
            vec![square_at(8.5, 12.0, 4.0)],
            vec![square_at(38.5, 20.0, 3.0)],
        ];
        for (label, solid) in [("tiles", &clip), ("plate", &plate)] {
            let mut index = OverlapIndex::build(solid);
            for piece in &probes {
                let full = net_area(&boolean_diff(piece, solid));
                let fast = outside_area(piece, solid, &mut index);
                assert!(
                    (full - fast).abs() < 1e-4,
                    "{label} full {full} fast {fast}"
                );
                assert_eq!(full > 0.01, fast > 0.01, "{label}");
            }
            let linear: Vec<usize> = (0..solid.len()).collect();
            for piece in &probes {
                let Some((min, max)) = loop_bounds(piece) else {
                    continue;
                };
                let expect: Vec<usize> = linear
                    .iter()
                    .copied()
                    .filter(|&i| {
                        loop_bounds(std::slice::from_ref(&solid[i])).is_some_and(|(a, b)| {
                            a[0] <= max[0] && min[0] <= b[0] && a[1] <= max[1] && min[1] <= b[1]
                        })
                    })
                    .collect();
                assert_eq!(index.hits(min, max), expect, "{label}");
            }
        }
    }
}

#[cfg(test)]
mod fuzzy_tests {
    use super::*;
    use crate::strategy::{FuzzySkin, StrategyId};

    fn path(kind: PathKind, pts: Vec<[f64; 2]>) -> Extrusion {
        extrusion(kind, &crate::strategy::pure(StrategyId::Speed), pts, 0.45)
    }

    fn dist_seg(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
        let ab = [b[0] - a[0], b[1] - a[1]];
        let ap = [p[0] - a[0], p[1] - a[1]];
        let ab2 = ab[0] * ab[0] + ab[1] * ab[1];
        if ab2 < 1e-18 {
            return ap[0].hypot(ap[1]);
        }
        let t = ((ap[0] * ab[0] + ap[1] * ab[1]) / ab2).clamp(0.0, 1.0);
        (p[0] - (a[0] + ab[0] * t)).hypot(p[1] - (a[1] + ab[1] * t))
    }

    fn dist_poly(p: [f64; 2], poly: &[[f64; 2]]) -> f64 {
        poly.windows(2)
            .map(|w| dist_seg(p, w[0], w[1]))
            .fold(f64::MAX, f64::min)
    }

    #[test]
    fn fuzzy_skin_offsets_outer_walls_and_leaves_a_scarf_ramp() {
        let loop_pts = vec![
            [0.0, 0.0],
            [12.0, 0.0],
            [12.0, 8.0],
            [0.0, 8.0],
            [0.0, 0.0],
        ];
        let features = PathFeatures {
            fuzzy_skin: Some(FuzzySkin::default()),
            z: 1.2,
            ..PathFeatures::default()
        };
        let mut plain = finish_paths(vec![path(PathKind::Outer, loop_pts.clone())], &features);
        fuzz_settled(&mut plain[0]);
        assert_eq!(plain[0].points[0], loop_pts[0]);
        assert_eq!(*plain[0].points.last().unwrap(), *loop_pts.last().unwrap());
        assert!(plain[0].points.len() > loop_pts.len());
        let mut moved = false;
        for p in &plain[0].points {
            let d = dist_poly(*p, &loop_pts);
            assert!(d <= 0.3 + 1e-9, "{p:?} is {d} mm off the wall");
            if d > 0.05 {
                moved = true;
            }
        }
        assert!(moved, "the wall did not move");

        let mut scarfed = finish_paths(vec![path(PathKind::Outer, loop_pts.clone())], &features);
        scarfed[0].z_frac = vec![0.2; loop_pts.len()];
        scarfed[0].flow_frac = vec![1.0; loop_pts.len()];
        fuzz_settled(&mut scarfed[0]);
        assert_eq!(scarfed[0].points, loop_pts);

        let mut inner = finish_paths(vec![path(PathKind::Inner, loop_pts.clone())], &features);
        fuzz_settled(&mut inner[0]);
        assert_eq!(inner[0].points, loop_pts);

        let mut smooth = finish_paths(
            vec![path(PathKind::Outer, loop_pts.clone())],
            &PathFeatures {
                fuzzy_skin: None,
                ..features
            },
        );
        fuzz_settled(&mut smooth[0]);
        assert_eq!(smooth[0].points, loop_pts);
    }

    #[test]
    fn seam_paint_starts_a_wall_inside_the_disk_and_leaves_infill() {
        let loop_pts = vec![
            [0.0, 0.0],
            [10.0, 0.0],
            [10.0, 10.0],
            [0.0, 10.0],
            [0.0, 0.0],
        ];
        let features = PathFeatures {
            z: 0.2,
            layer_height: 0.2,
            seam_paint: vec![crate::support::paint::SeamDisk {
                p: [10.0, 10.0, 0.1],
                n: [0.0, 0.0, 1.0],
                r: 1.5,
            }],
            ..PathFeatures::default()
        };
        let walls = finish_paths(vec![path(PathKind::Outer, loop_pts.clone())], &features);
        assert_eq!(walls[0].points[0], [10.0, 10.0]);
        assert_eq!(walls[0].seam, Seam::Fixed);
        let fill = finish_paths(vec![path(PathKind::Solid, loop_pts.clone())], &features);
        assert_eq!(fill[0].points, loop_pts);
        let miss = PathFeatures {
            seam_paint: vec![crate::support::paint::SeamDisk {
                p: [5.0, 5.0, 0.1],
                n: [0.0, 0.0, 1.0],
                r: 1.0,
            }],
            ..features
        };
        let plain = finish_paths(vec![path(PathKind::Outer, loop_pts.clone())], &miss);
        assert_eq!(plain[0].points, loop_pts);
    }
}
