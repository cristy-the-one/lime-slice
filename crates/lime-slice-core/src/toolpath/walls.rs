use super::fill_lines::concentric_fill;
use super::infill::{build_infill, clip_infill};
use super::island_order::island_loops;
use super::polish::geom_closed;
use super::seams::{painted_edge, painted_vertex, rotate_closed_at};
use super::solid_fill::{fill_strips, fit_bounds, monotonic_fill, solid_fill, solid_row_angle};
use super::void_fill::{carve, emit_void_fill, emit_void_fill_over, ms_since, void_cells};
use super::{
    emit_loops, extrusion, Extrusion, FuzzyMark, PathFeatures, PathKind, Seam, ShellBand,
    SurfacePattern,
};
use crate::poly::{
    boolean_diff, boolean_intersect, loop_bounds, loops_from_paths, offset_loops, offset_paths,
    paths_from_loops, signed_area, Loop,
};
use crate::strategy::{InfillPattern, ResolvedStrategy};
use clipper2::{Milli, Paths};
use std::time::Instant;

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

/// `None` when every compensation is zero, so the caller keeps the original loops.
pub(super) fn compensate_contours(contours: &[Loop], features: &PathFeatures) -> Option<Vec<Loop>> {
    let hole = features.xy_hole_mm;
    let contour = features.xy_contour_mm;
    let foot = if features.layer_index == 0 {
        features.elephants_foot_mm.max(0.0)
    } else {
        0.0
    };
    if hole.abs() < 1e-9 && contour.abs() < 1e-9 && foot < 1e-9 {
        return None;
    }
    let mut out = Vec::with_capacity(contours.len());
    for loop_ in contours {
        let area = signed_area(loop_);
        if area.abs() < 1e-6 {
            continue;
        }
        // A lone loop is offset as an outer. Growing it and reversing puts a
        // wider hole back; a positive hole compensation is that growth.
        let (delta, want_hole) = if area > 0.0 {
            (contour - foot, false)
        } else {
            (hole, true)
        };
        if delta.abs() < 1e-9 {
            out.push(loop_.clone());
            continue;
        }
        for mut ring in offset_loops(std::slice::from_ref(loop_), delta) {
            // A loop offset on its own is oriented as an outer. Put holes back.
            if want_hole == (signed_area(&ring) > 0.0) {
                ring.reverse();
            }
            out.push(ring);
        }
    }
    Some(out)
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
    let adjusted = compensate_contours(contours, features);
    if adjusted.as_ref().is_some_and(Vec::is_empty) {
        return (Vec::new(), 0.0, 0.0);
    }
    let contours = adjusted.as_deref().unwrap_or(contours);
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
        // The top surface keeps its diagonal lines; the bottom skin runs as the
        // interior's solid rows do.
        let fill = if shell == ShellBand::Bottom {
            island_loops(area)
                .iter()
                .flat_map(|island| {
                    let angle = solid_row_angle(island, line_width, features.layer_index);
                    let (pitch, through) = fit_bounds(island, angle, line_width);
                    clip_infill(solid_fill(island, pitch, angle, through), island)
                })
                .collect()
        } else {
            let angle = std::f64::consts::FRAC_PI_4;
            match features.top_pattern {
                SurfacePattern::Rectilinear => {
                    clip_infill(solid_fill(area, line_width, angle, None), area)
                }
                SurfacePattern::Monotonic => island_loops(area)
                    .iter()
                    .flat_map(|island| {
                        clip_infill(monotonic_fill(island, line_width, angle, None), island)
                    })
                    .collect(),
                SurfacePattern::Concentric => island_loops(area)
                    .iter()
                    .flat_map(|island| clip_infill(concentric_fill(island, line_width), island))
                    .collect(),
            }
        };
        for pts in fill {
            if pts.len() >= 2 {
                *seam_hint = *pts.last().unwrap();
                let mut path = extrusion(kind, strategy, pts, line_width);
                path.fit_arcs = arcs;
                paths.push(path);
            }
        }
    }
    let mut hairlines: Vec<Loop> = Vec::new();
    if strategy.infill_density > 0.01 && !interior.is_empty() && infill_kept(strategy, features) {
        let wide = if solid_infill(strategy) && features.variable_width {
            fill_strips(
                &mut paths,
                &interior,
                strategy,
                line_width,
                seam_hint,
                &mut hairlines,
            )
        } else {
            interior.clone()
        };
        let infill = if wide.is_empty() {
            Vec::new()
        } else {
            build_infill(&wide, strategy, line_width, features)
        };
        let Some(bead) = combine_bead(strategy, features) else {
            emit_void_fill(
                &mut paths, contours, &interior, strategy, line_width, seam_hint,
            );
            return (
                finish_paths(paths, features),
                wall_ms,
                ms_since(infill_started),
            );
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
        let mut cells = void_cells(&interior, line_width);
        narrow_sample.void_narrow();
        cells.append(&mut hairlines);
        cells
    };
    let over_hollow = match features.hollow_below.as_deref() {
        Some(hollow) if !hollow.is_empty() && !interior.is_empty() => {
            boolean_intersect(&interior, hollow)
        }
        _ => Vec::new(),
    };
    emit_void_fill_over(
        &mut paths,
        contours,
        &cells,
        &over_hollow,
        strategy,
        line_width,
        seam_hint,
    );
    (
        finish_paths(paths, features),
        wall_ms,
        ms_since(infill_started),
    )
}

/// Tags outer walls. The offset waits until the seam is chosen, so the seam
/// stays on the corner and a scarf ramp, which lands after that, is skipped.
/// `None` does not touch the paths.
pub(super) fn finish_paths(mut paths: Vec<Extrusion>, features: &PathFeatures) -> Vec<Extrusion> {
    if !features.seam_paint.is_empty() {
        for path in &mut paths {
            if !matches!(
                path.kind,
                PathKind::Outer | PathKind::Wall | PathKind::Inner
            ) {
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
                path.fuzzy = Some(FuzzyMark {
                    skin,
                    z: features.z,
                });
            }
        }
    }
    paths
}

/// With feature speeds off every wall is a `Wall`, so the kind no longer
/// says which one is outermost. The wall planner marks those as it emits them.
pub(super) fn mark_outer_walls(paths: &mut [Extrusion], features: &PathFeatures) {
    if let Some(skin) = features.fuzzy_skin {
        for path in paths.iter_mut().filter(|p| p.kind == PathKind::Wall) {
            path.fuzzy = Some(FuzzyMark {
                skin,
                z: features.z,
            });
        }
    }
}

/// Combined sparse height, or `None` when this interior layer is covered by a later bead.
///
/// Groups are aligned to the next solid shell so the layer under that shell always prints.
/// Bead height is `span × layer height`, capped near `0.75 ×` the nozzle diameter.
pub(super) fn combine_bead(strategy: &ResolvedStrategy, features: &PathFeatures) -> Option<f64> {
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
pub(super) const SOLID_DENSITY: f64 = 0.99;

/// Infill that fills the whole region, whatever the pattern.
pub(super) fn solid_infill(strategy: &ResolvedStrategy) -> bool {
    strategy.infill_density >= SOLID_DENSITY - 1e-9
}

pub(super) fn infill_kind(strategy: &ResolvedStrategy, shell: ShellBand) -> PathKind {
    if !strategy.feature_speeds {
        return PathKind::Infill;
    }
    match shell {
        ShellBand::Top => PathKind::Top,
        ShellBand::Bottom => PathKind::Solid,
        ShellBand::Interior => PathKind::Sparse,
    }
}

pub(super) fn wall_kind(outer: bool, strategy: &ResolvedStrategy) -> PathKind {
    if !strategy.feature_speeds {
        PathKind::Wall
    } else if outer {
        PathKind::Outer
    } else {
        PathKind::Inner
    }
}

pub(super) fn infill_kept(strategy: &ResolvedStrategy, features: &PathFeatures) -> bool {
    // Grown lightning prints only the branches some skin needs.
    (strategy.pattern == InfillPattern::Lightning && features.lightning.is_some())
        || strategy.lightning_range_mm <= 1e-6
        || features.roof_distance_mm <= strategy.lightning_range_mm + 1e-6
}

/// Narrowest bead the planner will lay down.
pub(super) fn min_bead(line_width: f64) -> f64 {
    (line_width * 0.45).max(0.2)
}

pub(super) fn might_be_thin(contours: &[Loop], nominal_stack: f64) -> bool {
    let Some((min, max)) = loop_bounds(contours) else {
        return false;
    };
    let dx = max[0] - min[0];
    let dy = max[1] - min[1];
    dx.min(dy) < nominal_stack * 1.4
}

pub(super) fn feature_width(contours: &[Loop]) -> Option<f64> {
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

pub(super) fn inradius(loops: &[Loop], cap: f64) -> f64 {
    inradius_until(loops, cap, |_, _| false)
}

/// The bisection of [`inradius`], stopped once `settled(lo, hi)`. The full
/// search ends in `[lo, hi)`, so a caller that reads the radius through steps
/// that only rise with it, equal at `lo` and `hi`, reads the same from `lo`.
pub(super) fn inradius_until(loops: &[Loop], cap: f64, settled: impl Fn(f64, f64) -> bool) -> f64 {
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
pub(super) fn emit_variable_feature(
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

pub(super) fn bead_count(width: f64, nominal: f64, max_walls: u32, min_w: f64, max_w: f64) -> u32 {
    let min_n = (width / max_w).ceil().max(1.0) as u32;
    let max_n = ((width / min_w).floor() as u32)
        .max(1)
        .min(max_walls.max(1));
    let ideal = (width / nominal.max(0.05)).round().max(1.0) as u32;
    ideal.clamp(min_n, max_n.max(min_n))
}

pub(super) fn fill_remaining(
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

pub(super) fn emit_gap_fill(
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
