use clipper2::{EndType, FillRule, JoinType, Milli, Paths};

use crate::contour::{in_solid, loop_bounds, orient_loops, signed_area, Loop};
use crate::strategy::{InfillPattern, ResolvedStrategy, SeamMode, StrategyId};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PathKind {
    Skirt,
    Wall,
    Infill,
    Support,
    SupportInterface,
}

impl PathKind {
    pub fn as_str(self) -> &'static str {
        match self {
            PathKind::Skirt => "skirt",
            PathKind::Wall => "wall",
            PathKind::Infill => "infill",
            PathKind::Support => "support",
            PathKind::SupportInterface => "support-interface",
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
}

pub fn plan_region(
    contours: &[Loop],
    strategy: &ResolvedStrategy,
    line_width: f64,
    seam_hint: &mut [f64; 2],
) -> Vec<Extrusion> {
    if contours.is_empty() {
        return Vec::new();
    }
    let mut paths = Vec::new();
    let mut current = paths_from_loops(contours);
    let mut last_wall_loops: Vec<Loop> = Vec::new();
    for i in 0..strategy.walls {
        let delta = if i == 0 {
            -line_width * 0.5
        } else {
            -line_width
        };
        current = offset_paths(&current, delta);
        let loops = loops_from_paths(current.clone());
        if loops.is_empty() {
            break;
        }
        last_wall_loops = loops.clone();
        emit_loops(
            &mut paths,
            &loops,
            PathKind::Wall,
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
    let infill_loops = loops_from_paths(infill_src);
    if strategy.infill_density > 0.01 && !infill_loops.is_empty() {
        let infill = build_infill(&infill_loops, strategy, line_width);
        for pts in infill {
            if pts.len() >= 2 {
                *seam_hint = *pts.last().unwrap();
                paths.push(extrusion(PathKind::Infill, strategy, pts, line_width));
            }
        }
    }
    paths
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
    Extrusion {
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
        SeamMode::Aligned => loop_
            .iter()
            .enumerate()
            .max_by(|(_, a), (_, b)| a[0].total_cmp(&b[0]).then(a[1].total_cmp(&b[1])))
            .map(|(i, _)| i)
            .unwrap_or(0),
        SeamMode::Nearest => loop_
            .iter()
            .enumerate()
            .min_by(|(_, a), (_, b)| dist2(**a, hint).total_cmp(&dist2(**b, hint)))
            .map(|(i, _)| i)
            .unwrap_or(0),
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
) -> Vec<Vec<[f64; 2]>> {
    let spacing = (line_width / strategy.infill_density).clamp(line_width * 1.05, 12.0);
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
        InfillPattern::Gyroid => gyroid(loops, spacing, strategy.toughness),
    }
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

fn polyline_len(pts: &[[f64; 2]]) -> f64 {
    pts.windows(2)
        .map(|w| {
            let dx = w[1][0] - w[0][0];
            let dy = w[1][1] - w[0][1];
            dx.hypot(dy)
        })
        .sum()
}
