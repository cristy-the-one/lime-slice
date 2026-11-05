use super::*;

pub(super) fn gyroid_3d_graded(
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

pub(super) fn inset_loops(loops: &[Loop], delta: f64) -> Vec<Loop> {
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

pub(super) fn build_infill(
    loops: &[Loop],
    strategy: &ResolvedStrategy,
    line_width: f64,
    features: &PathFeatures,
) -> Vec<Vec<[f64; 2]>> {
    if solid_infill(strategy) {
        return island_loops(loops)
            .iter()
            .flat_map(|island| {
                let angle = solid_row_angle(island, line_width, features.layer_index);
                solid_rows(island, line_width, angle)
            })
            .collect();
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
                // Two families of waves, each about 10% longer than straight.
                gyroid(loops, spacing * 2.2, strategy.toughness)
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
    if features.infill_nearest_first {
        // The pieces come out row by row, each row from the same edge, so
        // without a tour each row would start with a hop back across.
        return order_open(paths, loops);
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
pub(super) fn clip_infill(paths: Vec<Vec<[f64; 2]>>, loops: &[Loop]) -> Vec<Vec<[f64; 2]>> {
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

pub(super) fn sharpest_near(
    loop_: &[[f64; 2]],
    cost: impl Fn([f64; 2]) -> f64,
    max_cost: f64,
) -> usize {
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
pub(super) fn turn_penalty(loop_: &[[f64; 2]], i: usize) -> f64 {
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

pub(super) fn lightning(loops: &[Loop], spacing: f64) -> Vec<Vec<[f64; 2]>> {
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

#[cfg(test)]
mod density_tests {
    use super::*;
    use crate::strategy::{pure, InfillPattern, StrategyId};

    /// What the pattern covers of a square, mean over layers: extruded length
    /// times line width over area. Stated density is what it should be.
    fn coverage(pattern: InfillPattern, gyroid_3d: bool, density: f64) -> f64 {
        let (lw, side, layers) = (0.45, 18.2, 150);
        let square: Vec<Loop> = vec![vec![[0.0, 0.0], [side, 0.0], [side, side], [0.0, side]]];
        let mut strategy = pure(StrategyId::Toughness);
        strategy.pattern = pattern;
        strategy.gyroid_3d = gyroid_3d;
        strategy.infill_density = density;
        strategy.lightning_range_mm = 0.0;
        let length: f64 = (0..layers)
            .map(|k| {
                let features = PathFeatures {
                    z: 0.1 + 0.2 * k as f64,
                    layer_index: k,
                    ..PathFeatures::default()
                };
                let paths = build_infill(&square, &strategy, lw, &features);
                paths.iter().map(|p| polyline_len(p)).sum::<f64>()
            })
            .sum();
        length / layers as f64 * lw / (side * side)
    }

    #[test]
    fn every_pattern_covers_the_density_it_states() {
        for (name, pattern, gyroid_3d) in [
            ("lines", InfillPattern::Lines, false),
            ("grid", InfillPattern::Grid, false),
            ("gyroid", InfillPattern::Gyroid, false),
            ("3D gyroid", InfillPattern::Gyroid, true),
        ] {
            for density in [0.1, 0.2, 0.4, 0.8] {
                let share = coverage(pattern, gyroid_3d, density);
                assert!(
                    (share / density - 1.0).abs() < 0.08,
                    "{name} at {density} covers {share:.3}"
                );
            }
        }
    }
}
