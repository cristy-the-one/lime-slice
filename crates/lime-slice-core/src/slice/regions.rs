use crate::poly::{loop_bounds, Loop};
use crate::strategy::ResolvedStrategy;
use crate::support::Disk;
use crate::toolpath::{Extrusion, Seam};
use crate::Axis;

/// How far past the region cut each side plans its half. Every wall of the
/// thicker shell, plus one bead, then lies past the plane: nothing the side
/// keeps follows the clip edge, so the walls near the cut trace the real
/// outline and a thin feature on the plane is planned whole by both sides.
pub(super) fn cut_margin(low: &ResolvedStrategy, high: &ResolvedStrategy, line_width: f64) -> f64 {
    (low.walls.max(high.walls) + 2) as f64 * line_width
}

pub(super) fn widen_rect(rect: XyRect, axis: Axis, low_side: bool, margin: f64) -> XyRect {
    let (mut min, mut max) = rect;
    let k = match axis {
        Axis::X => 0,
        Axis::Y => 1,
    };
    if low_side {
        max[k] += margin;
    } else {
        min[k] -= margin;
    }
    (min, max)
}

/// The beads of one side's plan that lie on that side of the cut. A closed
/// loop cut open keeps the run through its start whole instead of splitting it
/// at the seam.
pub(super) fn keep_side(
    paths: Vec<Extrusion>,
    axis: Axis,
    at: f64,
    low_side: bool,
) -> Vec<Extrusion> {
    let mut out = Vec::with_capacity(paths.len());
    for path in paths {
        let (low, high) = split_polyline(&path.points, axis, at);
        let (mut kept, dropped) = if low_side { (low, high) } else { (high, low) };
        if dropped.is_empty() {
            out.push(path);
            continue;
        }
        let closed = path.points.len() > 2 && path.points.first() == path.points.last();
        if closed && kept.len() >= 2 && kept[0].first() == path.points.first() {
            let head = kept.remove(0);
            let tail = kept.last_mut().unwrap();
            tail.extend_from_slice(&head[1..]);
        }
        out.extend(
            kept.into_iter()
                .filter(|pts| poly_len(pts) > 0.05)
                .map(|pts| {
                    let mut piece = cut_piece(&path, pts);
                    if piece.kind.is_closed() {
                        piece.seam = Seam::Cut;
                    }
                    piece
                }),
        );
    }
    out
}

pub(super) type XyRect = ([f64; 2], [f64; 2]);
pub(super) type RegionSplit = (XyRect, XyRect);

/// Cut support beads on the region plane. A bead that stays on one side keeps
/// its loop. A bead that crosses becomes the two pieces that meet on the plane.
pub(super) fn split_extrusions(
    paths: Vec<Extrusion>,
    axis: Axis,
    at: f64,
) -> (Vec<Extrusion>, Vec<Extrusion>) {
    let mut low = Vec::new();
    let mut high = Vec::new();
    for path in paths {
        let (low_pts, high_pts) = split_polyline(&path.points, axis, at);
        for pts in low_pts {
            if pts.len() >= 2 && poly_len(&pts) > 0.4 {
                low.push(cut_piece(&path, pts));
            }
        }
        for pts in high_pts {
            if pts.len() >= 2 && poly_len(&pts) > 0.4 {
                high.push(cut_piece(&path, pts));
            }
        }
    }
    (low, high)
}

pub(super) fn cut_piece(src: &Extrusion, pts: Vec<[f64; 2]>) -> Extrusion {
    let mut path = src.clone();
    path.points = pts;
    path.z_frac.clear();
    path.flow_frac.clear();
    path.lead_in.clear();
    path
}

pub(super) fn poly_len(pts: &[[f64; 2]]) -> f64 {
    pts.windows(2)
        .map(|w| (w[1][0] - w[0][0]).hypot(w[1][1] - w[0][1]))
        .sum()
}

pub(super) type PointChains = Vec<Vec<[f64; 2]>>;

pub(super) fn split_polyline(pts: &[[f64; 2]], axis: Axis, at: f64) -> (PointChains, PointChains) {
    let mut low_out = Vec::new();
    let mut high_out = Vec::new();
    if pts.len() < 2 {
        return (low_out, high_out);
    }
    let mut low: Vec<[f64; 2]> = Vec::new();
    let mut high: Vec<[f64; 2]> = Vec::new();
    for w in pts.windows(2) {
        let (a, b) = (w[0], w[1]);
        let a_low = axis_of(a, axis) < at;
        let b_low = axis_of(b, axis) < at;
        if a_low == b_low {
            if a_low {
                push_pt(&mut low, a, b);
            } else {
                push_pt(&mut high, a, b);
            }
            continue;
        }
        let hit = plane_hit(a, b, axis, at);
        if a_low {
            push_pt(&mut low, a, hit);
            take_chain(&mut low, &mut low_out);
            push_pt(&mut high, hit, b);
        } else {
            push_pt(&mut high, a, hit);
            take_chain(&mut high, &mut high_out);
            push_pt(&mut low, hit, b);
        }
    }
    take_chain(&mut low, &mut low_out);
    take_chain(&mut high, &mut high_out);
    (low_out, high_out)
}

pub(super) fn axis_of(p: [f64; 2], axis: Axis) -> f64 {
    match axis {
        Axis::X => p[0],
        Axis::Y => p[1],
    }
}

pub(super) fn plane_hit(a: [f64; 2], b: [f64; 2], axis: Axis, at: f64) -> [f64; 2] {
    let ca = axis_of(a, axis);
    let cb = axis_of(b, axis);
    let t = if (cb - ca).abs() < 1e-12 {
        0.0
    } else {
        ((at - ca) / (cb - ca)).clamp(0.0, 1.0)
    };
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

pub(super) fn push_pt(chain: &mut Vec<[f64; 2]>, a: [f64; 2], b: [f64; 2]) {
    if chain.is_empty() {
        chain.push(a);
    }
    let last = *chain.last().unwrap();
    if (last[0] - b[0]).abs() > 1e-9 || (last[1] - b[1]).abs() > 1e-9 {
        chain.push(b);
    }
}

pub(super) fn take_chain(chain: &mut Vec<[f64; 2]>, out: &mut PointChains) {
    if chain.len() >= 2 {
        out.push(std::mem::take(chain));
    } else {
        chain.clear();
    }
}

/// Half-planes of the region cut, expanded to every support loop and branch.
/// A side with no support returns `None` so an inverted outline rect cannot
/// swallow the other side's trunks.
pub(super) fn support_half_rects(
    support: &[Loop],
    interface: &[Loop],
    disks: &[Disk],
    low: XyRect,
    high: XyRect,
) -> (Option<XyRect>, Option<XyRect>) {
    let Some((axis, at)) = split_edge(low, high) else {
        return (Some(low), Some(high));
    };
    let mut min = [f64::INFINITY; 2];
    let mut max = [f64::NEG_INFINITY; 2];
    let mut touch = |p: [f64; 2]| {
        min[0] = min[0].min(p[0]);
        min[1] = min[1].min(p[1]);
        max[0] = max[0].max(p[0]);
        max[1] = max[1].max(p[1]);
    };
    for loops in [support, interface] {
        for lp in loops {
            for p in lp {
                touch(*p);
            }
        }
    }
    for d in disks {
        let (p, r) = (d.xy, d.r.max(0.0));
        touch([p[0] - r, p[1] - r]);
        touch([p[0] + r, p[1] + r]);
    }
    if !min[0].is_finite() {
        return (None, None);
    }
    // Stay past the last vertex so the clip rect includes it.
    const PAD: f64 = 0.5;
    min[0] -= PAD;
    min[1] -= PAD;
    max[0] += PAD;
    max[1] += PAD;
    let side = |low_side: bool| -> Option<XyRect> {
        let mut a = min;
        let mut b = max;
        let axis_i = match axis {
            Axis::X => 0,
            Axis::Y => 1,
        };
        if low_side {
            b[axis_i] = at;
        } else {
            a[axis_i] = at;
        }
        if b[axis_i] - a[axis_i] <= 1e-6 {
            None
        } else {
            Some((a, b))
        }
    };
    (side(true), side(false))
}

pub(super) fn split_edge(low: XyRect, high: XyRect) -> Option<(Axis, f64)> {
    let x = (low.1[0] - high.0[0]).abs() <= 1e-4;
    let y = (low.1[1] - high.0[1]).abs() <= 1e-4;
    match (x, y) {
        (true, false) => Some((Axis::X, low.1[0])),
        (false, true) => Some((Axis::Y, low.1[1])),
        (true, true) => {
            let x_span = (high.1[0] - low.0[0]).abs();
            let y_span = (high.1[1] - low.0[1]).abs();
            if y_span > x_span {
                Some((Axis::Y, low.1[1]))
            } else {
                Some((Axis::X, low.1[0]))
            }
        }
        (false, false) => None,
    }
}

pub(super) fn split_rects(
    axis: Axis,
    at: f64,
    min: [f64; 3],
    max: [f64; 3],
    contours: &[Loop],
) -> RegionSplit {
    let (bmin, bmax) = loop_bounds(contours).unwrap_or(([min[0], min[1]], [max[0], max[1]]));
    let pad = 2.0;
    match axis {
        Axis::X => (
            ([bmin[0] - pad, bmin[1] - pad], [at, bmax[1] + pad]),
            ([at, bmin[1] - pad], [bmax[0] + pad, bmax[1] + pad]),
        ),
        Axis::Y => (
            ([bmin[0] - pad, bmin[1] - pad], [bmax[0] + pad, at]),
            ([bmin[0] - pad, at], [bmax[0] + pad, bmax[1] + pad]),
        ),
    }
}
