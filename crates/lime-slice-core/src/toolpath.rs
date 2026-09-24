use clipper2::{EndType, FillRule, JoinType, Milli, Paths};

use crate::contour::{in_solid, loop_bounds, orient_loops, signed_area, Loop};
use crate::strategy::{InfillPattern, ResolvedStrategy, ScarfSeam, SeamMode, StrategyId};

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

#[derive(Clone, Debug)]
pub struct PathFeatures {
    pub variable_width: bool,
    /// Distance downward from the nearest roof. Lightning fades out past the strategy range.
    pub roof_distance_mm: f64,
    #[allow(dead_code)]
    pub layer_index: usize,
    pub layer_height: f64,
    pub shell: ShellBand,
    /// Absolute layer Z. The 3D gyroid section is evaluated here.
    pub z: f64,
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
            z: 0.0,
            nozzle_diameter: 0.4,
            interior_remaining: 1,
            interior_run: 1,
        }
    }
}

#[derive(Clone, Debug)]
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
    /// Nozzle height as a fraction of this layer's height, one entry per point.
    /// Empty means the whole path sits on the layer Z. `0` is the previous layer top.
    pub z_frac: Vec<f64>,
    /// Flow multiplier per point. Empty means `flow` for every vertex.
    pub flow_frac: Vec<f64>,
    /// Length of the scarf overlap. `0` is a butt seam.
    pub scarf_mm: f64,
    /// Set when overhang splitting slowed this span. Scarf stays off those spans.
    pub on_overhang: bool,
    /// Run the existing G2/G3 fitter on this open path (3D gyroid).
    pub fit_arcs: bool,
    /// Lift height for the travel into this path. `0` stays on the layer.
    pub z_hop: f64,
}

pub fn plan_region(
    contours: &[Loop],
    strategy: &ResolvedStrategy,
    line_width: f64,
    seam_hint: &mut [f64; 2],
    features: &PathFeatures,
) -> Vec<Extrusion> {
    if contours.is_empty() {
        return Vec::new();
    }
    let mut paths = Vec::new();
    let min_w = (line_width * 0.45).max(0.2);
    let max_w = line_width * 1.30;
    if features.variable_width && might_be_thin(contours, line_width * strategy.walls.max(1) as f64)
    {
        if let Some(width) = feature_width(contours) {
            if width < line_width * strategy.walls.max(1) as f64 * 0.98 && width >= min_w {
                emit_variable_feature(
                    &mut paths, contours, strategy, width, min_w, max_w, seam_hint,
                );
                return paths;
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
                fill_remaining(&mut paths, &current, strategy, min_w, max_w, seam_hint);
            }
            break;
        }
        if features.variable_width && i + 1 < strategy.walls {
            let deeper = offset_paths(&next, -line_width);
            if loops_from_paths(deeper).is_empty() {
                last_wall_loops = loops.clone();
                emit_loops(
                    &mut paths,
                    &loops,
                    wall_kind(true, strategy),
                    strategy,
                    line_width,
                    seam_hint,
                );
                let core = paths_from_loops(&loops);
                fill_remaining(&mut paths, &core, strategy, min_w, max_w, seam_hint);
                break;
            }
        }
        current = next;
        last_wall_loops = loops.clone();
        emit_loops(
            &mut paths,
            &loops,
            wall_kind(i == 0, strategy),
            strategy,
            line_width,
            seam_hint,
        );
    }
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
    let bottom = features.shell == ShellBand::Bottom;
    if strategy.infill_density > 0.01
        && !infill_loops.is_empty()
        && (bottom || infill_kept(strategy, features))
    {
        let infill = if bottom {
            serpentine(scan_angle(
                &infill_loops,
                line_width,
                std::f64::consts::FRAC_PI_4,
            ))
        } else {
            build_infill(&infill_loops, strategy, line_width, features)
        };
        let Some(bead) = combine_bead(strategy, features) else {
            return paths;
        };
        let kind = infill_kind(strategy, features.shell);
        for pts in infill {
            if pts.len() >= 2 {
                *seam_hint = *pts.last().unwrap();
                let mut path = extrusion(kind, strategy, pts, line_width);
                if (bead - features.layer_height).abs() > 1e-6 {
                    path.bead_height = bead;
                }
                if strategy.gyroid_3d && strategy.pattern == crate::strategy::InfillPattern::Gyroid
                {
                    path.fit_arcs = true;
                }
                paths.push(path);
            }
        }
    }
    paths
}

/// Combined sparse height, or `None` when this interior layer is covered by a later bead.
///
/// Groups are aligned to the next solid shell so the layer under that shell always prints.
/// Bead height is `span × layer height`, capped near `0.75 ×` the nozzle diameter.
fn combine_bead(strategy: &ResolvedStrategy, features: &PathFeatures) -> Option<f64> {
    let h = features.layer_height.max(0.05);
    if features.shell != ShellBand::Interior {
        return Some(h);
    }
    let cap = 0.75 * features.nozzle_diameter.max(0.2);
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
    if features.shell != ShellBand::Interior {
        return true;
    }
    strategy.lightning_range_mm <= 1e-6
        || features.roof_distance_mm <= strategy.lightning_range_mm + 1e-6
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
    let mut lo = 0.0;
    let mut hi = cap;
    if loops_from_paths(offset_paths(&paths_from_loops(loops), -0.05)).is_empty() {
        return 0.0;
    }
    for _ in 0..14 {
        let mid = (lo + hi) * 0.5;
        if loops_from_paths(offset_paths(&paths_from_loops(loops), -mid)).is_empty() {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    lo
}

fn emit_variable_feature(
    paths: &mut Vec<Extrusion>,
    contours: &[Loop],
    strategy: &ResolvedStrategy,
    width: f64,
    min_w: f64,
    max_w: f64,
    seam_hint: &mut [f64; 2],
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
        emit_loops(paths, &loops, kind, strategy, bead, seam_hint);
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
        emit_loops(paths, &loops, PathKind::GapFill, strategy, width, seam_hint);
    } else {
        emit_loops(
            paths,
            &center,
            PathKind::GapFill,
            strategy,
            width,
            seam_hint,
        );
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
        if signed_area(&region[0]).abs() < 0.4 || signed_area(&region[0]).abs() > 30.0 {
            continue;
        }
        fill_remaining(
            paths,
            &paths_from_loops(&region),
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
        z_frac: Vec::new(),
        flow_frac: Vec::new(),
        scarf_mm: 0.0,
        on_overhang: false,
        fit_arcs: false,
        z_hop: 0.0,
    };
    apply_feed(&mut path, strategy);
    path
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
        PathKind::Sparse | PathKind::Infill => (strategy.sparse_speed, strategy.sparse_accel),
        PathKind::Solid | PathKind::GapFill => (strategy.solid_speed, strategy.solid_accel),
        PathKind::Top => (strategy.top_speed, strategy.top_accel),
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
        PathKind::Skirt | PathKind::Support | PathKind::SupportInterface => 0.0,
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
        SeamMode::Aligned => sharpest_near(loop_, |p| -p[0], f64::MAX),
        SeamMode::Nearest => {
            let nearest = loop_
                .iter()
                .map(|p| dist2(*p, hint))
                .fold(f64::MAX, f64::min);
            sharpest_near(loop_, |p| dist2(p, hint), nearest + 1.6 * 1.6)
        }
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

fn dist2(a: [f64; 2], b: [f64; 2]) -> f64 {
    let dx = a[0] - b[0];
    let dy = a[1] - b[1];
    dx * dx + dy * dy
}

fn paths_from_loops(loops: &[Loop]) -> Paths<Milli> {
    let raw: Vec<Vec<(f64, f64)>> = loops
        .iter()
        .map(|l| l.iter().map(|p| (p[0], p[1])).collect())
        .collect();
    raw.into()
}

fn loops_from_paths(paths: Paths<Milli>) -> Vec<Loop> {
    let raw: Vec<Vec<(f64, f64)>> = paths.into();
    orient_loops(
        raw.into_iter()
            .map(|l| l.into_iter().map(|(x, y)| [x, y]).collect())
            .collect(),
    )
}

fn offset_paths(paths: &Paths<Milli>, delta: f64) -> Paths<Milli> {
    if paths.is_empty() {
        return Paths::default();
    }
    paths
        .inflate(delta, JoinType::Square, EndType::Polygon, 2.0)
        .simplify(0.02, false)
}

pub fn clip_to_rect(loops: &[Loop], min: [f64; 2], max: [f64; 2]) -> Vec<Loop> {
    if loops.is_empty() {
        return Vec::new();
    }
    let subject = paths_from_loops(loops);
    let clip: Paths<Milli> = vec![vec![
        (min[0], min[1]),
        (max[0], min[1]),
        (max[0], max[1]),
        (min[0], max[1]),
    ]]
    .into();
    match subject
        .to_clipper_subject()
        .add_clip(clip)
        .intersect(FillRule::NonZero)
    {
        Ok(paths) => loops_from_paths(paths),
        Err(_) => Vec::new(),
    }
}

fn build_infill(
    loops: &[Loop],
    strategy: &ResolvedStrategy,
    line_width: f64,
    features: &PathFeatures,
) -> Vec<Vec<[f64; 2]>> {
    let mut density = strategy.infill_density;
    if strategy.pattern == InfillPattern::Lightning && strategy.lightning_range_mm > 1e-6 {
        let t = 1.0 - (features.roof_distance_mm / strategy.lightning_range_mm).clamp(0.0, 1.0);
        density *= 0.30 + 0.70 * t;
    }
    let spacing = (line_width / density.max(0.02)).clamp(line_width * 1.05, 14.0);
    match strategy.pattern {
        InfillPattern::Lines => serpentine(scan_angle(loops, spacing, 0.0)),
        InfillPattern::Grid => {
            let mut paths = serpentine(scan_angle(loops, spacing, 0.0));
            paths.extend(serpentine(scan_angle(
                loops,
                spacing,
                std::f64::consts::FRAC_PI_2,
            )));
            paths
        }
        InfillPattern::Gyroid => {
            if strategy.gyroid_3d {
                let period = crate::gyroid::period_for_spacing(spacing);
                crate::gyroid::section(loops, period, features.z, 0.05)
            } else {
                gyroid(loops, spacing, strategy.toughness)
            }
        }
        InfillPattern::Lightning => lightning(loops, spacing.max(line_width * 3.0)),
    }
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
    let Some((min, max)) = loop_bounds(loops) else {
        return Vec::new();
    };
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
    let mut segs = Vec::new();
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
        if best_d < (spacing * 2.4) * (spacing * 2.4) {
            let piece = clip_segment(loops, nodes[i], nodes[best]);
            for seg in piece {
                segs.push(vec![seg[0], seg[1]]);
            }
        }
    }
    serpentine(segs)
}

fn scan_angle(loops: &[Loop], spacing: f64, angle: f64) -> Vec<Vec<[f64; 2]>> {
    let rotated = rotate_loops(loops, -angle);
    let chords = horizontal_chords(&rotated, spacing);
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

fn horizontal_chords(loops: &[Loop], spacing: f64) -> Vec<(f64, Vec<(f64, f64)>)> {
    let Some((min, max)) = loop_bounds(loops) else {
        return Vec::new();
    };
    let mut rows = Vec::new();
    let mut y = min[1] + spacing * 0.5;
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

fn serpentine(segments: Vec<Vec<[f64; 2]>>) -> Vec<Vec<[f64; 2]>> {
    if segments.is_empty() {
        return Vec::new();
    }
    // Group by approximate row (shared Y of the unrotated data is lost).
    // Connect consecutive segments when their ends are close.
    let mut paths: Vec<Vec<[f64; 2]>> = Vec::new();
    for seg in segments {
        if seg.len() < 2 {
            continue;
        }
        let join = paths.last().and_then(|p| {
            let end = *p.last().unwrap();
            let start = seg[0];
            let d2 = dist2(end, start);
            if d2 < 16.0 && d2 > 1e-6 {
                Some(d2)
            } else {
                None
            }
        });
        if join.is_some() {
            paths.last_mut().unwrap().extend(seg);
        } else {
            paths.push(seg);
        }
    }
    paths
}

fn gyroid(loops: &[Loop], spacing: f64, phase_bias: f64) -> Vec<Vec<[f64; 2]>> {
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
        polylines.extend(clip_polyline(loops, &pts));
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
        polylines.extend(clip_polyline(loops, &pts));
        x += spacing;
        col += 1;
    }
    polylines
}

fn clip_polyline(loops: &[Loop], pts: &[[f64; 2]]) -> Vec<Vec<[f64; 2]>> {
    if pts.len() < 2 {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut current: Vec<[f64; 2]> = Vec::new();
    for w in pts.windows(2) {
        for piece in clip_segment(loops, w[0], w[1]) {
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
    clip_segment(loops, a, b)
}

fn clip_segment(loops: &[Loop], a: [f64; 2], b: [f64; 2]) -> Vec<[[f64; 2]; 2]> {
    let mut ts = vec![0.0, 1.0];
    for loop_ in loops {
        let n = loop_.len();
        for i in 0..n {
            let c = loop_[i];
            let d = loop_[(i + 1) % n];
            if let Some(t) = segment_t(a, b, c, d) {
                if (0.0..=1.0).contains(&t) {
                    ts.push(t);
                }
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
        if in_solid(loops, mx, my) {
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

pub fn offset_loops(loops: &[Loop], delta: f64) -> Vec<Loop> {
    if loops.is_empty() || delta.abs() < 1e-9 {
        return loops.to_vec();
    }
    loops_from_paths(offset_paths(&paths_from_loops(loops), delta))
}

pub fn boolean_union(a: &[Loop], b: &[Loop]) -> Vec<Loop> {
    if a.is_empty() {
        return b.to_vec();
    }
    if b.is_empty() {
        return a.to_vec();
    }
    match paths_from_loops(a)
        .to_clipper_subject()
        .add_clip(paths_from_loops(b))
        .union(FillRule::NonZero)
    {
        Ok(paths) => loops_from_paths(paths),
        Err(_) => {
            let mut both = a.to_vec();
            both.extend(b.iter().cloned());
            both
        }
    }
}

pub fn boolean_diff(subject: &[Loop], clip: &[Loop]) -> Vec<Loop> {
    if subject.is_empty() || clip.is_empty() {
        return subject.to_vec();
    }
    match paths_from_loops(subject)
        .to_clipper_subject()
        .add_clip(paths_from_loops(clip))
        .difference(FillRule::NonZero)
    {
        Ok(paths) => loops_from_paths(paths),
        Err(_) => Vec::new(),
    }
}

pub fn drop_slivers(loops: Vec<Loop>, min_area: f64) -> Vec<Loop> {
    loops
        .into_iter()
        .filter(|l| signed_area(l).abs() >= min_area)
        .collect()
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
    let mut segs = serpentine(scan_angle(region, spacing, 0.0));
    segs.extend(serpentine(scan_angle(
        region,
        spacing,
        std::f64::consts::FRAC_PI_2,
    )));
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

/// Organic shafts: one loop per branch. Spacing follows toughness (denser when tougher).
pub fn plan_tree_support(
    centers: &[[f64; 2]],
    strategy: &ResolvedStrategy,
    line_width: f64,
) -> Vec<Extrusion> {
    if centers.is_empty() {
        return Vec::new();
    }
    let spacing = (7.2 - 4.0 * strategy.toughness).clamp(3.2, 7.2);
    let kept = thin_centers(centers, spacing);
    let radius = (line_width * (0.85 + strategy.toughness)).clamp(0.45, 1.35);
    let speed = crate::strategy::support_speed(strategy, false);
    kept.into_iter()
        .map(|c| {
            let mut path = extrusion(PathKind::Support, strategy, octagon(c, radius), line_width);
            path.speed = speed;
            path
        })
        .collect()
}

fn thin_centers(centers: &[[f64; 2]], spacing: f64) -> Vec<[f64; 2]> {
    let mut ordered = centers.to_vec();
    ordered.sort_by(|a, b| a[0].total_cmp(&b[0]).then(a[1].total_cmp(&b[1])));
    let mut kept = Vec::new();
    let limit = spacing * spacing;
    for p in ordered {
        if kept.iter().all(|q: &[f64; 2]| dist2(*q, p) >= limit) {
            kept.push(p);
        }
    }
    kept
}

fn octagon(c: [f64; 2], r: f64) -> Vec<[f64; 2]> {
    let mut pts: Vec<[f64; 2]> = (0..8)
        .map(|i| {
            let a = i as f64 * std::f64::consts::TAU / 8.0;
            [c[0] + r * a.cos(), c[1] + r * a.sin()]
        })
        .collect();
    pts.push(pts[0]);
    pts
}

/// Reorder each feature group and slide nearest seams toward the nozzle.
/// `combing` routes travels through an inset of the solid and retracts only when that route is blocked.
pub fn optimize_travel(paths: &mut Vec<Extrusion>, solid: &[Loop], combing: bool, inset: f64) {
    if paths.len() < 2 {
        return;
    }
    let mut grouped: Vec<Vec<Extrusion>> = Vec::new();
    for path in paths.drain(..) {
        if grouped
            .last()
            .and_then(|g| g.last())
            .map(|p| p.kind == path.kind)
            .unwrap_or(false)
        {
            grouped.last_mut().unwrap().push(path);
        } else {
            grouped.push(vec![path]);
        }
    }
    let inset_loops = if combing && !solid.is_empty() {
        offset_loops(solid, -inset.abs())
    } else {
        Vec::new()
    };
    let mut cursor = [0.0, 0.0];
    let mut has_cursor = false;
    let mut out = Vec::with_capacity(grouped.iter().map(|g| g.len()).sum());
    for group in grouped {
        let open = !group.first().map(|p| p.kind.is_closed()).unwrap_or(false);
        let mut pending = group;
        let mut ordered = Vec::with_capacity(pending.len());
        while !pending.is_empty() {
            let mut best_i = 0usize;
            let mut best_d = f64::MAX;
            let mut best_rev = false;
            for (i, path) in pending.iter().enumerate() {
                if path.points.is_empty() {
                    continue;
                }
                let start = path.points[0];
                let end = *path.points.last().unwrap();
                let ds = if has_cursor {
                    dist2(cursor, start)
                } else {
                    0.0
                };
                if ds < best_d {
                    best_d = ds;
                    best_i = i;
                    best_rev = false;
                }
                if open && path.points.len() >= 2 {
                    let de = if has_cursor { dist2(cursor, end) } else { ds };
                    if de + 1e-9 < best_d {
                        best_d = de;
                        best_i = i;
                        best_rev = true;
                    }
                }
            }
            let mut path = pending.swap_remove(best_i);
            if best_rev {
                path.points.reverse();
            }
            if has_cursor && path.kind.is_closed() && path.retract_min_travel > 2.0 {
                rotate_closed_to(&mut path.points, cursor);
            }
            if has_cursor {
                if let Some(start) = path.points.first().copied() {
                    match comb_between(solid, &inset_loops, cursor, start, combing) {
                        Comb::Clear => path.retract_mm = 0.0,
                        Comb::Routed(via) => {
                            path.lead_in = via;
                            path.retract_mm = 0.0;
                        }
                        Comb::Blocked => {
                            path.retract_min_travel = 0.0;
                        }
                    }
                }
            }
            if let Some(end) = path.points.last().copied() {
                cursor = end;
                has_cursor = true;
            }
            ordered.push(path);
        }
        out.extend(ordered);
    }
    *paths = out;
}

fn rotate_closed_to(pts: &mut Vec<[f64; 2]>, hint: [f64; 2]) {
    if pts.len() < 4 {
        return;
    }
    let closed = dist2(pts[0], *pts.last().unwrap()) < 1e-8;
    if !closed {
        return;
    }
    pts.pop();
    let mut best = 0usize;
    let mut best_d = f64::MAX;
    for (i, p) in pts.iter().enumerate() {
        let d = dist2(*p, hint);
        if d < best_d {
            best_d = d;
            best = i;
        }
    }
    pts.rotate_left(best);
    let first = pts[0];
    pts.push(first);
}

enum Comb {
    Clear,
    Routed(Vec<[f64; 2]>),
    Blocked,
}

fn comb_between(
    solid: &[Loop],
    inset: &[Loop],
    from: [f64; 2],
    to: [f64; 2],
    combing: bool,
) -> Comb {
    if dist2(from, to) < 0.04 * 0.04 {
        return Comb::Clear;
    }
    if segment_inside(solid, from, to) {
        return Comb::Clear;
    }
    if !combing || inset.is_empty() {
        return Comb::Blocked;
    }
    if !in_solid(solid, from[0], from[1]) || !in_solid(solid, to[0], to[1]) {
        return Comb::Blocked;
    }
    let mut nodes = Vec::new();
    for loop_ in inset {
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
    let mut edges: Vec<Vec<(usize, f64)>> = vec![Vec::new(); n];
    for i in 0..n {
        for j in (i + 1)..n {
            if segment_inside(inset, nodes[i], nodes[j])
                || (i == start || j == start || i == goal || j == goal)
                    && segment_inside(solid, nodes[i], nodes[j])
            {
                let d = dist2(nodes[i], nodes[j]).sqrt();
                edges[i].push((j, d));
                edges[j].push((i, d));
            }
        }
    }
    let mut dist = vec![f64::INFINITY; n];
    let mut prev = vec![usize::MAX; n];
    dist[start] = 0.0;
    let mut used = vec![false; n];
    for _ in 0..n {
        let mut u = usize::MAX;
        let mut best = f64::INFINITY;
        for (i, d) in dist.iter().enumerate() {
            if !used[i] && *d < best {
                best = *d;
                u = i;
            }
        }
        if u == usize::MAX || u == goal {
            break;
        }
        used[u] = true;
        for &(v, w) in &edges[u] {
            let nd = dist[u] + w;
            if nd + 1e-9 < dist[v] {
                dist[v] = nd;
                prev[v] = u;
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
            let inside_infill = !infill.is_empty()
                && chain.windows(2).all(|w| segment_inside(infill, w[0], w[1]))
                && chain.windows(2).all(|w| segment_inside(solid, w[0], w[1]));
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
                let blocked = path.retract_mm > 0.0 && path.lead_in.is_empty();
                blocked && chain_crosses(&chain, solid, &printed)
            };
            if hop {
                path.z_hop = height;
            }
        }
        if matches!(
            path.kind,
            PathKind::Outer | PathKind::Inner | PathKind::Wall | PathKind::Top
        ) {
            for w in path.points.windows(2) {
                printed.push((w[0], w[1]));
            }
        }
        prev_top = path.kind == PathKind::Top;
        cursor = path.points.last().copied();
    }
}

fn chain_crosses(chain: &[[f64; 2]], solid: &[Loop], printed: &[([f64; 2], [f64; 2])]) -> bool {
    let leaves = chain.windows(2).any(|w| !segment_inside(solid, w[0], w[1]));
    if leaves {
        return true;
    }
    chain.windows(2).any(|w| {
        printed
            .iter()
            .any(|&(a, b)| point_seg_dist(w[0], a, b) < 0.5 || point_seg_dist(w[1], a, b) < 0.5)
    })
}

/// True when the whole segment stays in the solid, holes included.
/// A boundary crossing rejects the segment; the midpoint must also land inside.
fn segment_inside(solid: &[Loop], a: [f64; 2], b: [f64; 2]) -> bool {
    if solid.is_empty() {
        return false;
    }
    if segment_crosses_boundary(solid, a, b) {
        return false;
    }
    let mid = [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5];
    in_solid(solid, mid[0], mid[1])
}

fn segment_crosses_boundary(solid: &[Loop], a: [f64; 2], b: [f64; 2]) -> bool {
    for loop_ in solid {
        let n = loop_.len();
        if n < 2 {
            continue;
        }
        for i in 0..n {
            let c = loop_[i];
            let d = loop_[(i + 1) % n];
            if segments_properly_cross(a, b, c, d) {
                return true;
            }
        }
    }
    false
}

fn segments_properly_cross(a: [f64; 2], b: [f64; 2], c: [f64; 2], d: [f64; 2]) -> bool {
    let o1 = orient(a, b, c);
    let o2 = orient(a, b, d);
    let o3 = orient(c, d, a);
    let o4 = orient(c, d, b);
    o1 * o2 < -1e-10 && o3 * o4 < -1e-10
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
    match class {
        SpanClass::Supported => {}
        SpanClass::Bridge => {
            path.kind = PathKind::Bridge;
            path.speed = path.speed.clamp(18.0, 36.0);
            path.fan = 255;
            path.strength = path.strength.min(0.7);
        }
        SpanClass::Overhang(angle) => {
            let scale = if angle >= 68.0 { 0.32 } else { 0.55 };
            path.speed = (path.speed * scale).max(16.0);
            path.fan = path.fan.max(if angle >= 68.0 { 255 } else { 220 });
            path.on_overhang = true;
        }
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
    if params.layer_index == 0 || params.length < 0.5 || params.steps < 2 {
        return;
    }
    let h0 = params.start_height.clamp(0.0, 0.9);
    let f0 = params.start_flow.clamp(0.05, 1.0);
    for path in paths.iter_mut() {
        if !scarf_kind(path, params.mode) || path.on_overhang || path.kind == PathKind::Bridge {
            continue;
        }
        scarf_path(path, params.length, params.steps, h0, f0);
    }
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
    let mut out = Vec::new();
    let mut z = Vec::new();
    let mut flow = Vec::new();
    for i in 0..=steps {
        let t = i as f64 / steps as f64;
        out.push(point_along(pts, scarf * t));
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
    for i in 1..=steps {
        let t = i as f64 / steps as f64;
        out.push(point_along(pts, scarf * t));
        z.push(1.0);
        flow.push((1.0 - (1.0 - f0) * t).clamp(0.05, 1.0));
    }
    path.points = out;
    path.z_frac = z;
    path.flow_frac = flow;
    path.scarf_mm = scarf;
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
