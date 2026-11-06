use super::fill_lines::scan_through;
use super::infill::clip_infill;
use super::open_order::serpentine;
use super::scarf::polyline_len;
use super::seams::dist2;
use super::{extrusion, Extrusion, PathKind};
use crate::poly::{loop_bounds, offset_loops, point_in_loop, resolve_nonzero, signed_area, Loop};
use crate::strategy::ResolvedStrategy;
use crate::support::Disk;

/// One chord through a support patch the grid spacing skipped.
pub(super) fn support_spine(region: &[Loop]) -> Vec<Vec<[f64; 2]>> {
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
/// Density and speed come from the resolved strategy. `through` pins the
/// grid to a point, so each layer's lines stand on the lines below however
/// the region's outline changes. `None` starts the grid at the region's edge.
pub fn plan_support(
    region: &[Loop],
    strategy: &ResolvedStrategy,
    line_width: f64,
    density: f64,
    interface: bool,
    through: Option<[f64; 2]>,
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
    let mut segs = serpentine(scan_through(region, spacing, 0.0, through), region);
    segs.extend(serpentine(
        scan_through(region, spacing, std::f64::consts::FRAC_PI_2, through),
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
    feet: &[Loop],
    strategy: &ResolvedStrategy,
    line_width: f64,
) -> Vec<Extrusion> {
    if disks.is_empty() && feet.is_empty() {
        return Vec::new();
    }
    let speed = crate::strategy::support_speed(strategy, false);
    let mut paths = Vec::new();
    let mut thick: Vec<Loop> = feet.to_vec();
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
    // A foot is wider than the trunk it carries, so it is filled: the trunk's
    // own loops then stand on beads, not on the foot's hollow middle.
    let mut fill: Vec<Loop> = inner
        .iter()
        .filter(|l| {
            l.iter()
                .any(|p| feet.iter().any(|f| point_in_loop(f, p[0], p[1])))
        })
        .cloned()
        .collect();
    for _ in 0..16 {
        fill = offset_loops(&fill, -line_width * 0.95);
        fill.retain(|l| signed_area(l).abs() >= 0.35 && l.len() >= 3);
        if fill.is_empty() {
            break;
        }
        emit_support_loops(&mut paths, &fill, strategy, line_width, speed);
    }
    paths
}

/// Concentric loops outside the layer-0 supports that stand on the bed: the
/// support `region` of a grid and the `disks` of trees alike, kept `gap` off
/// the part. `brim_mm` of 0 prints nothing, and the caller skips this then.
pub fn plan_support_brim(
    region: &[Loop],
    disks: &[Disk],
    part: &[Loop],
    strategy: &ResolvedStrategy,
    line_width: f64,
    brim_mm: f64,
    gap: f64,
) -> Vec<Extrusion> {
    let loops = crate::support::tree::on_bed_brim(region, disks, part, line_width, brim_mm, gap);
    if loops.is_empty() {
        return Vec::new();
    }
    let speed = crate::strategy::support_speed(strategy, false);
    let mut paths = Vec::new();
    emit_support_loops(&mut paths, &loops, strategy, line_width, speed);
    paths
}

/// A belt layer's brim: one support line along X at slice `y`, over each of
/// `spans`, in order. A span shorter than a line width prints nothing.
pub fn plan_brim_lines(
    spans: &[[f64; 2]],
    y: f64,
    strategy: &ResolvedStrategy,
    line_width: f64,
) -> Vec<Extrusion> {
    let speed = crate::strategy::support_speed(strategy, false);
    spans
        .iter()
        .filter(|span| span[1] - span[0] >= line_width)
        .map(|span| {
            let mut path = extrusion(
                PathKind::Support,
                strategy,
                vec![[span[0], y], [span[1], y]],
                line_width,
            );
            path.speed = speed;
            path
        })
        .collect()
}

pub(super) fn emit_support_loops(
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

/// A circle as a closed polyline. Klipper takes each vertex of a loop at a
/// speed that falls with the angle the path turns there, so a 0.78 mm tip of 12
/// sides (30 degrees a turn) crawls at 17 mm/s; 24 sides take it at about
/// 35 mm/s and cut a tree's support time by a tenth.
pub(super) fn circle_pts(c: [f64; 2], r: f64) -> Vec<[f64; 2]> {
    let n = if r > 2.2 { 20 } else { 24 };
    let mut pts: Vec<[f64; 2]> = (0..n)
        .map(|i| {
            let a = i as f64 * std::f64::consts::TAU / n as f64;
            [c[0] + r * a.cos(), c[1] + r * a.sin()]
        })
        .collect();
    pts.push(pts[0]);
    pts
}
