//! Vent notches for resin. A pocket is a cell of the rib network on the wall,
//! closed all round by ribs or by a border where a side wall stands. It cups
//! when its opening faces the build platform: the opening points against the
//! build axis, which points away from the plate toward the tank.
//!
//! The notch is one full-height gap per cupping pocket, [`RESIN_VENT_MM`]
//! wide (Formlabs' minimum drain hole). A root hole under a continuous top
//! is not a section this kernel builds, so the shipped notch is the gap.
//! [`mouse_hole`] is only the measurement: the same length at the vent's
//! height, the rest of the rib left tall.

use crate::shell::{RibSide, ShellMesh};
use crate::units::{add, dot, norm, scale, sub};

use super::GRib;

#[cfg(test)]
use super::select::DRib;

/// Formlabs' minimum drain hole, mm. Form 4 design specifications.
pub const RESIN_VENT_MM: f64 = 0.75;

const SNAP: f64 = 1e-4;
const AREA: f64 = 1e-3;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VentPocket {
    pub rib: usize,
    pub at: [f64; 3],
    pub size_mm: f64,
}

/// What a resin plan reports. The ribs in the plan are the gapped ones;
/// `mouse_hole_factor` is the same notches as a short lowered stretch, measured and not built.
#[derive(Clone, Debug, PartialEq)]
pub struct Venting {
    pub size_mm: f64,
    pub factor_before: f64,
    pub factor_after: f64,
    pub mouse_hole_factor: f64,
    pub pockets: Vec<VentPocket>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct VentPockets {
    /// The opening faces the build platform, so a closed cell cups.
    pub cups: bool,
    pub size_mm: f64,
    pub pockets: Vec<VentPocket>,
}

/// One run. A free end drains every cell that touches it.
pub struct RibRun<'a> {
    pub points: &'a [[f64; 3]],
    pub free: [bool; 2],
}

/// A wall border. `rises` closes a cell; `open` and `hole` do not.
pub struct BorderRun<'a> {
    pub points: &'a [[f64; 3]],
    pub kind: BorderKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BorderKind {
    Rises,
    Open,
    Hole,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Rib,
    Rises,
    Open,
    Hole,
}

struct Seg {
    a: [f64; 2],
    b: [f64; 2],
    kind: Kind,
    rib: i32,
    loose_a: bool,
    loose_b: bool,
}

#[derive(Clone)]
struct Half {
    from: usize,
    to: usize,
    edge: usize,
    kind: Kind,
    rib: i32,
}

/// At least [`RESIN_VENT_MM`], rounded up to `pixel_mm` when that is positive.
pub fn vent_size_mm(pixel_mm: Option<f64>) -> f64 {
    match pixel_mm {
        Some(px) if px.is_finite() && px > 0.0 => ((RESIN_VENT_MM - 1e-9) / px).ceil() * px,
        _ => RESIN_VENT_MM,
    }
}

/// Closed cells that cup, and one vent each. No pockets when the opening faces the tank.
pub fn vent_pockets(ribs: &[RibRun<'_>], borders: &[BorderRun<'_>], opening: [f64; 3], build: [f64; 3]) -> VentPockets {
    let size_mm = vent_size_mm(None);
    let Some(opening) = normalize(opening) else {
        return VentPockets { cups: false, size_mm, pockets: Vec::new() };
    };
    let Some(build) = normalize(build) else {
        return VentPockets { cups: false, size_mm, pockets: Vec::new() };
    };
    let cups = dot(opening, build) < -1e-6;
    if !cups {
        return VentPockets { cups: false, size_mm, pockets: Vec::new() };
    }
    VentPockets {
        cups: true,
        size_mm,
        pockets: closed_pockets(ribs, borders, opening, build, size_mm),
    }
}

/// The side the ribs stand on: the mesh's area-weighted normal, flipped for the negative side.
/// A centred rib has no opening, so nothing cups.
pub(crate) fn opening_of(mesh: &ShellMesh, side: RibSide) -> Option<[f64; 3]> {
    let sign = match side {
        RibSide::Positive => 1.0,
        RibSide::Negative => -1.0,
        RibSide::Centered => return None,
    };
    let mut n = [0.0, 0.0, 0.0];
    for t in &mesh.triangles {
        let (a, b, c) = (mesh.vertices[t[0] as usize], mesh.vertices[t[1] as usize], mesh.vertices[t[2] as usize]);
        n = add(n, cross(sub(b, a), sub(c, a)));
    }
    let l = norm(n);
    (l >= 1e-12).then_some(scale(n, sign / l))
}

/// The same pockets on the planner's ribs. A loose end is one `loose` names.
pub(crate) fn find(ribs: &[GRib], loose: &[(usize, usize)], borders: &[BorderRun<'_>], opening: [f64; 3], build: [f64; 3]) -> VentPockets {
    let runs: Vec<RibRun<'_>> = ribs
        .iter()
        .enumerate()
        .map(|(i, rib)| RibRun {
            points: &rib.points,
            free: [loose.iter().any(|&(r, e)| r == i && e == 0), loose.iter().any(|&(r, e)| r == i && e == 1)],
        })
        .collect();
    vent_pockets(&runs, borders, opening, build)
}

/// Cut each vent out of its rib. Gap ends are not loose ends of the plan: the
/// caller remaps those from the points that were already loose.
pub(crate) fn notch(ribs: &[GRib], pockets: &[VentPocket]) -> (Vec<GRib>, Vec<VentPocket>) {
    let mut cuts: Vec<Vec<[f64; 3]>> = vec![Vec::new(); ribs.len()];
    for pocket in pockets {
        if pocket.rib < cuts.len() {
            cuts[pocket.rib].push(pocket.at);
        }
    }
    let mut out = Vec::new();
    let mut map = vec![0usize; ribs.len()];
    for (i, rib) in ribs.iter().enumerate() {
        map[i] = out.len();
        if cuts[i].is_empty() {
            out.push(rib.clone());
            continue;
        }
        let size = pockets.iter().find(|p| p.rib == i).map(|p| p.size_mm).unwrap_or(RESIN_VENT_MM);
        out.extend(split_rib(rib, &cuts[i], size));
    }
    let last = out.len().saturating_sub(1);
    let pockets = pockets
        .iter()
        .map(|p| VentPocket {
            rib: map.get(p.rib).copied().unwrap_or(0).min(last),
            at: p.at,
            size_mm: p.size_mm,
        })
        .collect();
    (out, pockets)
}

/// The measurement of a root notch: each vent's length is lowered to the vent
/// size, and the rest of the rib stays at its height. One run, not a gap.
pub(crate) fn mouse_hole(ribs: &[GRib], pockets: &[VentPocket]) -> Vec<GRib> {
    let mut out = ribs.to_vec();
    for pocket in pockets {
        let Some(rib) = out.get_mut(pocket.rib) else { continue };
        lower_stretch(rib, pocket.at, pocket.size_mm);
    }
    out
}

fn closed_pockets(ribs: &[RibRun<'_>], borders: &[BorderRun<'_>], opening: [f64; 3], build: [f64; 3], size_mm: f64) -> Vec<VentPocket> {
    let axis = if opening[0].abs() < 0.9 { [1.0, 0.0, 0.0] } else { [0.0, 1.0, 0.0] };
    let Some(u) = normalize(cross(axis, opening)) else { return Vec::new() };
    let v = cross(opening, u);
    let origin = first_point(ribs).unwrap_or([0.0, 0.0, 0.0]);
    let project = |p: [f64; 3]| -> [f64; 2] {
        let d = sub(p, origin);
        [dot(d, u), dot(d, v)]
    };
    let lift = |q: [f64; 2]| -> [f64; 3] {
        [
            origin[0] + q[0] * u[0] + q[1] * v[0],
            origin[1] + q[0] * u[1] + q[1] * v[1],
            origin[2] + q[0] * u[2] + q[1] * v[2],
        ]
    };
    let mut segs = Vec::new();
    let mut push = |points: &[[f64; 3]], kind: Kind, rib: i32, loose_a: bool, loose_b: bool| {
        for i in 1..points.len() {
            let a = project(points[i - 1]);
            let b = project(points[i]);
            if dist2(a, b) < SNAP * SNAP {
                continue;
            }
            segs.push(Seg {
                a,
                b,
                kind,
                rib,
                loose_a: i == 1 && loose_a,
                loose_b: i + 1 == points.len() && loose_b,
            });
        }
    };
    for (i, rib) in ribs.iter().enumerate() {
        push(rib.points, Kind::Rib, i as i32, rib.free[0], rib.free[1]);
    }
    for border in borders {
        let kind = match border.kind {
            BorderKind::Rises => Kind::Rises,
            BorderKind::Open => Kind::Open,
            BorderKind::Hole => Kind::Hole,
        };
        push(border.points, kind, -1, false, false);
    }
    let pieces = split_segs(&segs);
    if pieces.is_empty() {
        return Vec::new();
    }
    let mut xy: Vec<[f64; 2]> = Vec::new();
    let mut id_of: std::collections::HashMap<(i64, i64), usize> = std::collections::HashMap::new();
    let mut vid = |q: [f64; 2]| -> usize {
        let key = ((q[0] / SNAP).round() as i64, (q[1] / SNAP).round() as i64);
        if let Some(&id) = id_of.get(&key) {
            return id;
        }
        let id = xy.len();
        xy.push(q);
        id_of.insert(key, id);
        id
    };
    let mut loose = vec![false; 0];
    struct Edge {
        a: usize,
        b: usize,
        kind: Kind,
        rib: i32,
    }
    let mut edges: Vec<Edge> = Vec::new();
    let mut seen_edge = std::collections::HashSet::new();
    for seg in &pieces {
        let a = vid(seg.a);
        let b = vid(seg.b);
        if a == b {
            continue;
        }
        if loose.len() <= a.max(b) {
            loose.resize(a.max(b) + 1, false);
        }
        if seg.loose_a {
            loose[a] = true;
        }
        if seg.loose_b {
            loose[b] = true;
        }
        let key = if a < b { (a, b) } else { (b, a) };
        if !seen_edge.insert(key) {
            continue;
        }
        edges.push(Edge { a, b, kind: seg.kind, rib: seg.rib });
    }
    if loose.len() < xy.len() {
        loose.resize(xy.len(), false);
    }
    let mut out: Vec<Vec<Half>> = vec![Vec::new(); xy.len()];
    for (i, edge) in edges.iter().enumerate() {
        out[edge.a].push(Half { from: edge.a, to: edge.b, edge: i, kind: edge.kind, rib: edge.rib });
        out[edge.b].push(Half { from: edge.b, to: edge.a, edge: i, kind: edge.kind, rib: edge.rib });
    }
    let ang = |h: &Half| -> f64 { (xy[h.to][1] - xy[h.from][1]).atan2(xy[h.to][0] - xy[h.from][0]) };
    for list in &mut out {
        list.sort_by(|p, q| ang(p).partial_cmp(&ang(q)).unwrap_or(std::cmp::Ordering::Equal).then(p.edge.cmp(&q.edge)));
    }
    let next_of = |h: &Half, out: &[Vec<Half>]| -> Half {
        let list = &out[h.to];
        let i = list.iter().position(|row| row.edge == h.edge).unwrap_or(0);
        list[(i + list.len() - 1) % list.len()].clone_half()
    };
    let mut used = std::collections::HashSet::new();
    let mut pockets = Vec::new();
    let mut taken: Vec<(i32, [f64; 2])> = Vec::new();
    for list in &out {
        for start in list {
            let start_key = (start.from, start.edge);
            if used.contains(&start_key) {
                continue;
            }
            let mut face = Vec::new();
            let mut h = start.clone_half();
            let mut guard = 0;
            let mut closed = false;
            while guard < edges.len() * 2 + 4 {
                guard += 1;
                let key = (h.from, h.edge);
                if !used.insert(key) {
                    break;
                }
                face.push(h.clone_half());
                h = next_of(&h, &out);
                if h.from == start.from && h.edge == start.edge {
                    closed = true;
                    break;
                }
            }
            if !closed || face.len() < 3 {
                continue;
            }
            let mut area = 0.0;
            for row in &face {
                let p = xy[row.from];
                let q = xy[row.to];
                area += p[0] * q[1] - q[0] * p[1];
            }
            if area < AREA {
                continue;
            }
            if face.iter().any(|row| row.kind != Kind::Rib && row.kind != Kind::Rises) {
                continue;
            }
            if face.iter().any(|row| loose[row.from]) {
                continue;
            }
            let Some(vent) = choose_vent(&face, &xy, &Frame { build, u, v, origin }, size_mm, &taken) else { continue };
            taken.push((vent.0, vent.1));
            pockets.push(VentPocket { rib: vent.0 as usize, at: lift(vent.1), size_mm });
        }
    }
    pockets
}

impl Half {
    fn clone_half(&self) -> Self {
        Self { from: self.from, to: self.to, edge: self.edge, kind: self.kind, rib: self.rib }
    }
}

struct Frame {
    build: [f64; 3],
    u: [f64; 3],
    v: [f64; 3],
    origin: [f64; 3],
}

struct Choice {
    index: usize,
    a: [f64; 2],
    b: [f64; 2],
    span: f64,
    low: f64,
}

fn choose_vent(face: &[Half], xy: &[[f64; 2]], frame: &Frame, size_mm: f64, taken: &[(i32, [f64; 2])]) -> Option<(i32, [f64; 2])> {
    let drain = |q: [f64; 2]| -> f64 {
        let p = [
            frame.origin[0] + q[0] * frame.u[0] + q[1] * frame.v[0],
            frame.origin[1] + q[0] * frame.u[1] + q[1] * frame.v[1],
            frame.origin[2] + q[0] * frame.u[2] + q[1] * frame.v[2],
        ];
        dot(p, frame.build)
    };
    let mut rows: Vec<Choice> = face
        .iter()
        .enumerate()
        .filter(|(_, row)| row.kind == Kind::Rib && row.rib >= 0)
        .map(|(index, row)| {
            let a = xy[row.from];
            let b = xy[row.to];
            let span = ((b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2)).sqrt();
            Choice { index, a, b, span, low: drain(a).min(drain(b)) }
        })
        .collect();
    rows.sort_by(|p, q| {
        p.low
            .partial_cmp(&q.low)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(q.span.partial_cmp(&p.span).unwrap_or(std::cmp::Ordering::Equal))
            .then(face[p.index].rib.cmp(&face[q.index].rib))
            .then(face[p.index].edge.cmp(&face[q.index].edge))
    });
    for row in rows {
        let flat = place(row.a, row.b, &drain, size_mm);
        let rib = face[row.index].rib;
        if taken.iter().any(|(r, at)| *r == rib && ((at[0] - flat[0]).powi(2) + (at[1] - flat[1]).powi(2)).sqrt() < size_mm) {
            continue;
        }
        return Some((rib, flat));
    }
    None
}

fn place(a: [f64; 2], b: [f64; 2], drain: &dyn Fn([f64; 2]) -> f64, size_mm: f64) -> [f64; 2] {
    let span = ((b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2)).sqrt();
    let mid = [(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0];
    if span < 1e-9 {
        return mid;
    }
    let da = drain(a);
    let db = drain(b);
    if (da - db).abs() < 1e-6 {
        return mid;
    }
    let (low, high) = if da < db { (a, b) } else { (b, a) };
    let t = (span / 2.0).min(size_mm / 2.0 + 0.05) / span;
    [low[0] + (high[0] - low[0]) * t, low[1] + (high[1] - low[1]) * t]
}

fn split_segs(segs: &[Seg]) -> Vec<Seg> {
    let mut cuts = vec![Vec::new(); segs.len()];
    for i in 0..segs.len() {
        for j in i + 1..segs.len() {
            let Some(hit) = intersect(&segs[i], &segs[j]) else { continue };
            if hit.0 > 1e-6 && hit.0 < 1.0 - 1e-6 {
                cuts[i].push(hit.0);
            }
            if hit.1 > 1e-6 && hit.1 < 1.0 - 1e-6 {
                cuts[j].push(hit.1);
            }
        }
    }
    let mut out = Vec::new();
    for (i, seg) in segs.iter().enumerate() {
        let mut ts = vec![0.0];
        ts.extend(cuts[i].iter().copied());
        ts.push(1.0);
        ts.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        for k in 1..ts.len() {
            let (t0, t1) = (ts[k - 1], ts[k]);
            if t1 - t0 < 1e-8 {
                continue;
            }
            let a = [seg.a[0] + (seg.b[0] - seg.a[0]) * t0, seg.a[1] + (seg.b[1] - seg.a[1]) * t0];
            let b = [seg.a[0] + (seg.b[0] - seg.a[0]) * t1, seg.a[1] + (seg.b[1] - seg.a[1]) * t1];
            if dist2(a, b) < SNAP * SNAP {
                continue;
            }
            out.push(Seg {
                a,
                b,
                kind: seg.kind,
                rib: seg.rib,
                loose_a: k == 1 && seg.loose_a,
                loose_b: k + 1 == ts.len() && seg.loose_b,
            });
        }
    }
    out
}

fn intersect(p: &Seg, q: &Seg) -> Option<(f64, f64)> {
    let (rx, ry) = (p.b[0] - p.a[0], p.b[1] - p.a[1]);
    let (sx, sy) = (q.b[0] - q.a[0], q.b[1] - q.a[1]);
    let den = rx * sy - ry * sx;
    let (qx, qy) = (q.a[0] - p.a[0], q.a[1] - p.a[1]);
    if den.abs() < 1e-12 {
        let on = |a: [f64; 2], b: [f64; 2], c: [f64; 2]| -> Option<f64> {
            let (abx, aby) = (b[0] - a[0], b[1] - a[1]);
            let ab2 = abx * abx + aby * aby;
            if ab2 < 1e-18 {
                return None;
            }
            let t = ((c[0] - a[0]) * abx + (c[1] - a[1]) * aby) / ab2;
            if t <= 1e-6 || t >= 1.0 - 1e-6 {
                return None;
            }
            let (dx, dy) = (a[0] + abx * t - c[0], a[1] + aby * t - c[1]);
            (dx * dx + dy * dy < SNAP * SNAP).then_some(t)
        };
        if let Some(t) = on(p.a, p.b, q.a) {
            return Some((t, 0.0));
        }
        if let Some(t) = on(p.a, p.b, q.b) {
            return Some((t, 1.0));
        }
        if let Some(u) = on(q.a, q.b, p.a) {
            return Some((0.0, u));
        }
        if let Some(u) = on(q.a, q.b, p.b) {
            return Some((1.0, u));
        }
        return None;
    }
    let t = (qx * sy - qy * sx) / den;
    let u = (qx * ry - qy * rx) / den;
    if !(-1e-6..=1.0 + 1e-6).contains(&t) || !(-1e-6..=1.0 + 1e-6).contains(&u) {
        return None;
    }
    Some((t.clamp(0.0, 1.0), u.clamp(0.0, 1.0)))
}

fn split_rib(rib: &GRib, centers: &[[f64; 3]], size: f64) -> Vec<GRib> {
    let total = poly_length(&rib.points);
    if total < SNAP {
        return Vec::new();
    }
    let mut gaps = Vec::new();
    for at in centers {
        let Some(s) = param_of(&rib.points, *at) else { continue };
        let half = size / 2.0;
        let lo = (s - half).max(0.0);
        let hi = (s + half).min(total);
        if hi - lo >= SNAP {
            gaps.push((lo, hi));
        }
    }
    gaps.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut merged: Vec<(f64, f64)> = Vec::new();
    for gap in gaps {
        if let Some(last) = merged.last_mut() {
            if gap.0 <= last.1 + SNAP {
                last.1 = last.1.max(gap.1);
                continue;
            }
        }
        merged.push(gap);
    }
    let mut spans = Vec::new();
    let mut cursor = 0.0;
    for gap in &merged {
        if gap.0 - cursor > SNAP {
            spans.push((cursor, gap.0));
        }
        cursor = gap.1;
    }
    if total - cursor > SNAP {
        spans.push((cursor, total));
    }
    spans
        .into_iter()
        .map(|(lo, hi)| {
            let (points, heights) = sample_rib(&rib.points, &rib.heights, lo, hi);
            let mut piece = rib.clone();
            piece.points = points;
            piece.heights = heights;
            piece
        })
        .filter(|piece| piece.points.len() >= 2)
        .collect()
}

/// The vent's length, and only that length, drops to `size`. The rib stays one run.
fn lower_stretch(rib: &mut GRib, at: [f64; 3], size: f64) {
    let total = poly_length(&rib.points);
    let Some(s) = param_of(&rib.points, at) else { return };
    let lo = (s - size / 2.0).max(0.0);
    let hi = (s + size / 2.0).min(total);
    if hi - lo < SNAP {
        return;
    }
    let marks = [0.0, lo, hi, total];
    let mut points = vec![point_at(&rib.points, 0.0)];
    for w in marks.windows(2) {
        if w[1] - w[0] < SNAP {
            continue;
        }
        let mut run = 0.0;
        for i in 1..rib.points.len() {
            let step = norm(sub(rib.points[i], rib.points[i - 1]));
            let at_s = run + step;
            if at_s > w[0] + SNAP && at_s < w[1] - SNAP {
                points.push(rib.points[i]);
            }
            run = at_s;
        }
        points.push(point_at(&rib.points, w[1]));
    }
    let mut clean = vec![points[0]];
    for p in points.into_iter().skip(1) {
        if norm(sub(p, *clean.last().unwrap())) > SNAP {
            clean.push(p);
        }
    }
    let old_points = rib.points.clone();
    let old_heights = rib.heights.clone();
    let heights: Vec<f64> = clean
        .windows(2)
        .map(|w| {
            let m = [(w[0][0] + w[1][0]) / 2.0, (w[0][1] + w[1][1]) / 2.0, (w[0][2] + w[1][2]) / 2.0];
            let at_s = param_of(&old_points, m).unwrap_or(0.0);
            let h = height_at(&old_points, &old_heights, at_s);
            if at_s >= lo - 1e-6 && at_s <= hi + 1e-6 { size.max(0.1) } else { h }
        })
        .collect();
    rib.points = clean;
    rib.heights = heights;
}

fn sample_rib(points: &[[f64; 3]], heights: &[f64], lo: f64, hi: f64) -> (Vec<[f64; 3]>, Vec<f64>) {
    let mut out = vec![point_at(points, lo)];
    let mut run = 0.0;
    for i in 1..points.len() {
        let step = norm(sub(points[i], points[i - 1]));
        let next = run + step;
        if next > lo + SNAP && next < hi - SNAP {
            out.push(points[i]);
        }
        run = next;
    }
    out.push(point_at(points, hi));
    let mut clean = vec![out[0]];
    for p in out.into_iter().skip(1) {
        if norm(sub(p, *clean.last().unwrap())) > SNAP {
            clean.push(p);
        }
    }
    let hs: Vec<f64> = clean
        .windows(2)
        .map(|w| {
            let m = [(w[0][0] + w[1][0]) / 2.0, (w[0][1] + w[1][1]) / 2.0, (w[0][2] + w[1][2]) / 2.0];
            height_at(points, heights, param_of(points, m).unwrap_or(0.0))
        })
        .collect();
    (clean, hs)
}

fn height_at(points: &[[f64; 3]], heights: &[f64], s: f64) -> f64 {
    if heights.is_empty() {
        return 1.0;
    }
    let mut run = 0.0;
    for i in 1..points.len() {
        let step = norm(sub(points[i], points[i - 1]));
        if run + step >= s - 1e-9 || i + 1 == points.len() {
            return heights[(i - 1).min(heights.len() - 1)];
        }
        run += step;
    }
    *heights.last().unwrap()
}

fn poly_length(pts: &[[f64; 3]]) -> f64 {
    pts.windows(2).map(|w| norm(sub(w[1], w[0]))).sum()
}

fn param_of(pts: &[[f64; 3]], at: [f64; 3]) -> Option<f64> {
    let mut best = f64::INFINITY;
    let mut at_s = 0.0;
    let mut run = 0.0;
    for w in pts.windows(2) {
        let ab = sub(w[1], w[0]);
        let ab2 = dot(ab, ab);
        let t = if ab2 < 1e-18 { 0.0 } else { (dot(sub(at, w[0]), ab) / ab2).clamp(0.0, 1.0) };
        let q = [w[0][0] + ab[0] * t, w[0][1] + ab[1] * t, w[0][2] + ab[2] * t];
        let d = norm(sub(at, q));
        if d < best {
            best = d;
            at_s = run + ab2.sqrt() * t;
        }
        run += ab2.sqrt();
    }
    (best <= 0.5).then_some(at_s)
}

fn point_at(pts: &[[f64; 3]], s: f64) -> [f64; 3] {
    let mut run = 0.0;
    for i in 1..pts.len() {
        let step = norm(sub(pts[i], pts[i - 1]));
        if run + step >= s - 1e-9 || i + 1 == pts.len() {
            let t = if step < 1e-12 { 0.0 } else { ((s - run) / step).clamp(0.0, 1.0) };
            return [
                pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t,
                pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t,
                pts[i - 1][2] + (pts[i][2] - pts[i - 1][2]) * t,
            ];
        }
        run += step;
    }
    pts.last().copied().unwrap_or([0.0, 0.0, 0.0])
}

fn first_point(ribs: &[RibRun<'_>]) -> Option<[f64; 3]> {
    ribs.iter().find_map(|rib| rib.points.first().copied())
}

fn normalize(v: [f64; 3]) -> Option<[f64; 3]> {
    let l = norm(v);
    (l >= 1e-12).then_some([v[0] / l, v[1] / l, v[2] / l])
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn dist2(a: [f64; 2], b: [f64; 2]) -> f64 {
    let (x, y) = (a[0] - b[0], a[1] - b[1]);
    x * x + y * y
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edge(a: [f64; 3], b: [f64; 3]) -> Vec<[f64; 3]> {
        vec![a, b]
    }

    fn square(x0: f64, x1: f64, y0: f64, y1: f64) -> Vec<Vec<[f64; 3]>> {
        vec![
            edge([x0, y0, 0.0], [x1, y0, 0.0]),
            edge([x1, y0, 0.0], [x1, y1, 0.0]),
            edge([x1, y1, 0.0], [x0, y1, 0.0]),
            edge([x0, y1, 0.0], [x0, y0, 0.0]),
        ]
    }

    fn run<'a>(pts: &'a [[f64; 3]], free: [bool; 2]) -> RibRun<'a> {
        RibRun { points: pts, free }
    }

    fn pockets(lines: &[Vec<[f64; 3]>], free: &[[bool; 2]], borders: &[BorderRun<'_>], opening: [f64; 3], build: [f64; 3]) -> VentPockets {
        let ribs: Vec<RibRun<'_>> = lines.iter().enumerate().map(|(i, p)| run(p, free.get(i).copied().unwrap_or([false, false]))).collect();
        vent_pockets(&ribs, borders, opening, build)
    }

    const CUP: ([f64; 3], [f64; 3]) = ([0.0, 0.0, -1.0], [0.0, 0.0, 1.0]);

    #[test]
    fn a_square_is_one_pocket_and_a_gap_is_none() {
        let lines = square(0.0, 10.0, 0.0, 10.0);
        let one = pockets(&lines, &[], &[], CUP.0, CUP.1);
        assert!(one.cups);
        assert_eq!(one.pockets.len(), 1);
        assert!((one.size_mm - 0.75).abs() < 1e-9);
        let at = one.pockets[0].at;
        let on_side = at[0].abs() < 1e-6 || (at[0] - 10.0).abs() < 1e-6 || at[1].abs() < 1e-6 || (at[1] - 10.0).abs() < 1e-6;
        assert!(on_side);
        let gapped = pockets(&lines[..3], &[], &[], CUP.0, CUP.1);
        assert!(gapped.pockets.is_empty());
    }

    #[test]
    fn two_squares_a_hole_a_loose_end_and_the_build_direction() {
        let mut lines = square(0.0, 10.0, 0.0, 10.0);
        lines.push(edge([10.0, 0.0, 0.0], [20.0, 0.0, 0.0]));
        lines.push(edge([20.0, 0.0, 0.0], [20.0, 10.0, 0.0]));
        lines.push(edge([20.0, 10.0, 0.0], [10.0, 10.0, 0.0]));
        let two = pockets(&lines, &[], &[], CUP.0, CUP.1);
        assert_eq!(two.pockets.len(), 2);
        assert_ne!(two.pockets[0].rib, two.pockets[1].rib);

        let hole_pts = edge([0.0, 0.0, 0.0], [10.0, 0.0, 0.0]);
        let hole = BorderRun { points: &hole_pts, kind: BorderKind::Hole };
        let three = &lines[..4][1..];
        // lines[1..4] plus the hole in place of the bottom.
        let cell: Vec<Vec<[f64; 3]>> = lines[1..4].to_vec();
        let holed = pockets(&cell, &[], &[hole], CUP.0, CUP.1);
        assert!(holed.pockets.is_empty(), "{holed:?}");
        let _ = three;

        let open_pts = hole_pts.clone();
        let open = BorderRun { points: &open_pts, kind: BorderKind::Open };
        assert!(pockets(&cell, &[], &[open], CUP.0, CUP.1).pockets.is_empty());
        let rises = BorderRun { points: &open_pts, kind: BorderKind::Rises };
        assert_eq!(pockets(&cell, &[], &[rises], CUP.0, CUP.1).pockets.len(), 1);

        let mut free = vec![[false, false]; lines.len()];
        free[0] = [true, false];
        assert!(pockets(&lines[..4], &free, &[], CUP.0, CUP.1).pockets.is_empty());

        assert!(pockets(&lines[..4], &[], &[], [0.0, 0.0, 1.0], [0.0, 0.0, 1.0]).pockets.is_empty());
        assert!(pockets(&lines[..4], &[], &[], [0.0, 0.0, -1.0], [0.0, 0.0, -1.0]).pockets.is_empty());
    }

    #[test]
    fn a_crossed_grid_and_the_notch_that_drains_it() {
        let lines = vec![
            edge([0.0, 10.0, 0.0], [30.0, 10.0, 0.0]),
            edge([0.0, 20.0, 0.0], [30.0, 20.0, 0.0]),
            edge([10.0, 0.0, 0.0], [10.0, 30.0, 0.0]),
            edge([20.0, 0.0, 0.0], [20.0, 30.0, 0.0]),
        ];
        let free = [[true, true]; 4];
        let cell = pockets(&lines, &free, &[], CUP.0, CUP.1);
        assert_eq!(cell.pockets.len(), 1, "{cell:?}");

        let ribs: Vec<GRib> = lines
            .iter()
            .map(|points| GRib {
                points: points.clone(),
                heights: vec![4.0; points.len() - 1],
                d: DRib::fixed(vec![0, 1], 4.0, 1.2, super::super::profile::RibProfile::Rectangular),
            })
            .collect();
        let (notched, _) = notch(&ribs, &cell.pockets);
        let runs: Vec<RibRun<'_>> = notched.iter().map(|rib| RibRun { points: &rib.points, free: [false, false] }).collect();
        let again = vent_pockets(&runs, &[], CUP.0, CUP.1);
        assert!(again.pockets.is_empty(), "{again:?}");
        assert!(notched.len() > lines.len());
    }

    #[test]
    fn the_notch_is_at_the_low_end_and_the_pixel_rounds_up() {
        let lines = vec![
            edge([0.0, 0.0, 0.0], [10.0, 0.0, 4.0]),
            edge([10.0, 0.0, 4.0], [10.0, 10.0, 4.0]),
            edge([10.0, 10.0, 4.0], [0.0, 10.0, 0.0]),
            edge([0.0, 10.0, 0.0], [0.0, 0.0, 0.0]),
        ];
        let sloped = pockets(&lines, &[], &[], CUP.0, CUP.1);
        assert_eq!(sloped.pockets.len(), 1);
        assert!(sloped.pockets[0].at[2] < 0.5, "{:?}", sloped.pockets[0].at);
        assert!((vent_size_mm(None) - 0.75).abs() < 1e-12);
        assert!((vent_size_mm(Some(0.05)) - 0.75).abs() < 1e-9);
        assert!((vent_size_mm(Some(0.4)) - 0.8).abs() < 1e-9);
    }
}
