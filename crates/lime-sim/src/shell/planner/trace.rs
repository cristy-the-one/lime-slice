//! Candidate rib lines: evenly spaced streamlines of the cross field,
//! traced across triangles (not along mesh edges), after Tam & Mueller 2015
//! (seeding, interpolated tracing, bypassing near-duplicates) and Jobard &
//! Lefer's evenly spaced streamlines.
//!
//! - **Seeds** are triangle centroids in order of strain energy density,
//!   highest first; each seeds a line along the field's major and its minor
//!   direction there, unless a parallel line already passes within the
//!   spacing.
//! - **Tracing** goes from edge to edge of the triangles with a midpoint
//!   (RK2) step in each, the direction interpolated from the vertices. It
//!   stops at the boundary, at a keep-out triangle, closer than
//!   [`TEST_FRACTION`] of the spacing to a parallel line (within 45°), on a
//!   turn sharper than [`MAX_TURN`], or after running straight through
//!   low-confidence triangles for longer than the spacing (the straight
//!   tail is then dropped).
//! - Lines are simplified (Douglas–Peucker, bounded deviation) and those
//!   under the minimum length dropped.

use std::collections::HashMap;

use crate::units::{add, dot, norm, normalize, scale, sub};

use super::field::Field;
use super::surface::Surface;

/// A trace stops nearer than this share of the spacing to a parallel line.
pub(crate) const TEST_FRACTION: f64 = 0.5;
/// Largest turn from one triangle to the next (Li et al. trace quad edges
/// that turn less than π/3).
pub(crate) const MAX_TURN: f64 = std::f64::consts::FRAC_PI_3;
/// Lines within this angle of each other count as parallel.
const PARALLEL_COS: f64 = std::f64::consts::FRAC_1_SQRT_2;
/// Seeds need this share of the 90th-percentile energy density.
pub(crate) const SEED_FLOOR: f64 = 0.05;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Family {
    /// Along the larger principal moment (or force).
    Major,
    /// Square to it.
    Minor,
}

/// Why a traced line ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TraceEnd {
    Boundary,
    KeepOut,
    Spacing,
    LowConfidence,
    Turn,
    Limit,
}

#[derive(Clone, Debug)]
pub(crate) struct Candidate {
    pub points: Vec<[f64; 3]>,
    pub family: Family,
    pub ends: [TraceEnd; 2],
    /// Outward tangent at each end, and the triangle the end sits in.
    pub end_dir: [[f64; 3]; 2],
    pub end_tri: [u32; 2],
}

pub(crate) struct TraceRules {
    pub spacing: f64,
    pub min_length: f64,
    pub tolerance: f64,
}

/// Samples of accepted lines in a uniform grid of `cell` mm.
struct Samples {
    cell: f64,
    grid: HashMap<[i64; 3], Vec<usize>>,
    pts: Vec<([f64; 3], [f64; 3])>,
}

impl Samples {
    fn new(cell: f64) -> Self {
        Self {
            cell,
            grid: HashMap::new(),
            pts: Vec::new(),
        }
    }

    fn cell_of(&self, p: [f64; 3]) -> [i64; 3] {
        p.map(|x| (x / self.cell).floor() as i64)
    }

    fn add_line(&mut self, points: &[[f64; 3]]) {
        let step = self.cell / 8.0;
        for w in points.windows(2) {
            let d = sub(w[1], w[0]);
            let len = norm(d);
            let Some(t) = normalize(d) else { continue };
            let n = (len / step).ceil().max(1.0) as usize;
            for i in 0..=n {
                let p = add(w[0], scale(d, i as f64 / n as f64));
                let c = self.cell_of(p);
                self.grid.entry(c).or_default().push(self.pts.len());
                self.pts.push((p, t));
            }
        }
    }

    /// Is a line within `dist` of `p` running within 45° of `dir`?
    fn near_parallel(&self, p: [f64; 3], dir: [f64; 3], dist: f64) -> bool {
        let c = self.cell_of(p);
        let reach = (dist / self.cell).ceil() as i64;
        for dx in -reach..=reach {
            for dy in -reach..=reach {
                for dz in -reach..=reach {
                    let Some(list) = self.grid.get(&[c[0] + dx, c[1] + dy, c[2] + dz]) else {
                        continue;
                    };
                    for &i in list {
                        let (q, t) = self.pts[i];
                        if norm(sub(q, p)) < dist && dot(t, dir).abs() > PARALLEL_COS {
                            return true;
                        }
                    }
                }
            }
        }
        false
    }
}

/// Where the ray from `p` (in or on triangle `t`) along `d` leaves `t`:
/// the point, the local edge, and the corner when it leaves through one.
fn exit(s: &Surface, t: u32, p: [f64; 3], d: [f64; 3]) -> Option<([f64; 3], usize, Option<usize>)> {
    let c = s.corners(t);
    let n = s.normal(t);
    let mut best: Option<(f64, [f64; 3], usize, f64)> = None;
    let scale_len = norm(sub(c[1], c[0])).max(norm(sub(c[2], c[0])));
    for k in 0..3 {
        let a = c[k];
        let u = sub(c[(k + 1) % 3], a);
        let w = sub(a, p);
        // p + r d = a + s u
        let den = dot(crate::units::cross(d, u), n);
        if den.abs() < 1e-14 * norm(u) {
            continue;
        }
        let r = dot(crate::units::cross(w, u), n) / den;
        let sp = dot(crate::units::cross(w, d), n) / den;
        if r > 1e-9 * scale_len
            && (-1e-9..=1.0 + 1e-9).contains(&sp)
            && best.is_none_or(|b| r < b.0)
        {
            best = Some((r, add(p, scale(d, r)), k, sp));
        }
    }
    let (_, q, k, sp) = best?;
    let corner = if sp <= 1e-7 {
        Some(k)
    } else if sp >= 1.0 - 1e-7 {
        Some((k + 1) % 3)
    } else {
        None
    };
    Some((q, k, corner))
}

fn project(d: [f64; 3], n: [f64; 3]) -> Option<[f64; 3]> {
    normalize(sub(d, scale(n, dot(d, n))))
}

fn angle(a: [f64; 3], b: [f64; 3]) -> f64 {
    dot(a, b).clamp(-1.0, 1.0).acos()
}

/// A continuation that turns more than this folds back onto the face it
/// came from and stops. A right-angle fold is well under it, so a crease
/// is crossed; only a reversal is refused.
const FOLD_BACK: f64 = 150.0 * std::f64::consts::PI / 180.0;

/// `d` as it continues from a face of normal `n_from` onto `n_to`.
/// Flatter than [`super::surface::CREASE_COS`] this is [`project`], so a
/// flat trace is unchanged. A crease rotates `d` about `edge` into the
/// next plane; the projection afterwards only removes the drift.
fn carry_heading(
    d: [f64; 3],
    n_from: [f64; 3],
    n_to: [f64; 3],
    edge: Option<[f64; 3]>,
) -> Option<[f64; 3]> {
    if dot(n_from, n_to) >= super::surface::CREASE_COS {
        return project(d, n_to);
    }
    let Some(edge) = edge else {
        return project(d, n_to);
    };
    let rotated = super::surface::unfold_about(d, edge, n_from, n_to);
    project(rotated, n_to).or_else(|| project(d, n_to))
}

/// The heading after stepping from `t` into `next`. Creases off, the plain
/// projection onto the next face, as v6.12; on, [`carry_heading`].
fn step_heading(s: &Surface, d: [f64; 3], t: u32, next: u32) -> Option<[f64; 3]> {
    if !s.creases {
        return project(d, s.normal(next));
    }
    carry_heading(d, s.normal(t), s.normal(next), shared_edge(s, t, next))
}

fn edge_unit(s: &Surface, t: u32, k: usize) -> Option<[f64; 3]> {
    let tri = s.tris[t as usize];
    normalize(sub(
        s.pos[tri[(k + 1) % 3] as usize],
        s.pos[tri[k] as usize],
    ))
}

/// A unit direction along an edge `a` and `b` share, if they share one.
fn shared_edge(s: &Surface, a: u32, b: u32) -> Option<[f64; 3]> {
    let ta = s.tris[a as usize];
    let tb = s.tris[b as usize];
    for i in 0..3 {
        let (u, v) = (ta[i], ta[(i + 1) % 3]);
        if tb.contains(&u) && tb.contains(&v) {
            return normalize(sub(s.pos[v as usize], s.pos[u as usize]));
        }
    }
    None
}

/// Does a short step from `q` along `heading` land inside triangle `t`?
fn enters(s: &Surface, t: u32, q: [f64; 3], heading: [f64; 3]) -> bool {
    let [a, b, c] = s.corners(t);
    let span = norm(sub(b, a)).max(norm(sub(c, a))).max(norm(sub(c, b)));
    let (l, _) = s.barycentric(t, add(q, scale(heading, 1e-4 * span)));
    l.iter().all(|&x| x >= -1e-6)
}

/// Which face to take when three or more triangles share the edge.
///
/// The two-triangle case never comes here: it is [`Surface::neighbour`],
/// the same triangle as before. Each other face is unfolded about the
/// edge and kept only when the heading enters it and the turn is at most
/// [`FOLD_BACK`]. The smallest turn wins. A coplanar continuation turns
/// about nothing and beats a wall standing on the edge, so a trace
/// crossing a T-junction in the floor stays in the floor. A trace that
/// comes down the wall onto two coplanar faces takes the one it enters.
/// Nothing enters, or every continuation folds back, and the trace stops.
fn continue_across(
    s: &Surface,
    t: u32,
    k: usize,
    q: [f64; 3],
    d: [f64; 3],
    others: &[u32],
) -> Option<u32> {
    let n_from = s.normal(t);
    let edge = edge_unit(s, t, k)?;
    let mut best: Option<(f64, u32)> = None;
    for &o in others {
        let Some(heading) = carry_heading(d, n_from, s.normal(o), Some(edge)) else {
            continue;
        };
        let turn = angle(d, heading);
        if turn > FOLD_BACK || !enters(s, o, q, heading) {
            continue;
        }
        if best.is_none_or(|(so_far, _)| turn < so_far) {
            best = Some((turn, o));
        }
    }
    best.map(|(_, o)| o)
}

/// The triangle after leaving `t` at `q` through local edge `k` (or corner
/// `corner`), heading `d`.
///
/// Two triangles on the edge: [`Surface::neighbour`], unchanged. Three or
/// more (a T-junction, the wall welded onto an edge the floor already
/// shares): [`continue_across`] picks the smallest turn that the unfolded
/// heading enters, and stops on a fold-back. A corner on a flat wall uses
/// the same sector test as before; a corner on a crease unfolds the
/// heading into each face first.
fn next_triangle(
    s: &Surface,
    t: u32,
    q: [f64; 3],
    k: usize,
    corner: Option<usize>,
    d: [f64; 3],
) -> Option<u32> {
    match corner {
        None => {
            if !s.creases {
                // Creases off: the one neighbour, as v6.12.
                return s.neighbour(t, k);
            }
            let others = s.neighbours(t, k);
            if others.len() <= 1 {
                // The same triangle `neighbour` has always returned.
                s.neighbour(t, k)
            } else {
                continue_across(s, t, k, q, d, &others)
            }
        }
        Some(c) => {
            // Through a vertex: the other triangle around it whose sector
            // holds the heading.
            let v = s.tris[t as usize][c];
            let n_from = s.normal(t);
            // Creases off, every corner takes the flat sector test, as v6.12.
            let folded = s.creases
                && s.vert_tris[v as usize]
                    .iter()
                    .any(|&o| o != t && dot(n_from, s.normal(o)) < super::surface::CREASE_COS);
            if !folded {
                let target = add(q, d);
                let mut best: Option<(f64, u32)> = None;
                for &o in &s.vert_tris[v as usize] {
                    if o == t {
                        continue;
                    }
                    let (l, _) = s.barycentric(o, add(q, scale(sub(target, q), 1e-3)));
                    let m = l[0].min(l[1]).min(l[2]);
                    if best.is_none_or(|b| m > b.0) {
                        best = Some((m, o));
                    }
                }
                best.filter(|b| b.0 > -1e-6).map(|b| b.1)
            } else {
                let mut best: Option<(f64, u32)> = None;
                for &o in &s.vert_tris[v as usize] {
                    if o == t {
                        continue;
                    }
                    let heading = if dot(n_from, s.normal(o)) >= super::surface::CREASE_COS {
                        d
                    } else {
                        match carry_heading(d, n_from, s.normal(o), shared_edge(s, t, o)) {
                            Some(h) => h,
                            None => continue,
                        }
                    };
                    let (l, _) = s.barycentric(o, add(q, scale(heading, 1e-3)));
                    let m = l[0].min(l[1]).min(l[2]);
                    if m <= -1e-6 {
                        continue;
                    }
                    if best.is_none_or(|b| m > b.0) {
                        best = Some((m, o));
                    }
                }
                best.map(|b| b.1)
            }
        }
    }
}

pub(crate) struct Tracer<'a> {
    pub s: &'a Surface,
    pub field: &'a Field,
    pub blocked: &'a [bool],
    pub rules: &'a TraceRules,
    pub max_length: f64,
}

struct Traced {
    points: Vec<[f64; 3]>,
    end: TraceEnd,
    tri: u32,
    dir: [f64; 3],
}

impl Tracer<'_> {
    /// One direction from `p` in `t`, heading `h`.
    fn trace(&self, samples: &Samples, mut t: u32, p0: [f64; 3], h0: [f64; 3]) -> Traced {
        let s = self.s;
        let mut pts = vec![p0];
        let mut p = p0;
        let mut h = h0;
        let mut len = 0.0;
        let mut straight = 0.0;
        // Points kept before the current straight run began.
        let mut keep = 1usize;
        let test = TEST_FRACTION * self.rules.spacing;
        let end = loop {
            if len > self.max_length || pts.len() > 200_000 {
                break TraceEnd::Limit;
            }
            let confident = self.field.confident[t as usize];
            let dir = if confident {
                let (l, _) = s.barycentric(t, p);
                let l = super::surface::clamp_barycentric(l);
                let Some(d1) = self.field.direction(s, t, l, h) else {
                    break TraceEnd::LowConfidence;
                };
                match exit(s, t, p, d1) {
                    Some((q1, _, _)) => {
                        let mid = scale(add(p, q1), 0.5);
                        let (lm, _) = s.barycentric(t, mid);
                        let lm = super::surface::clamp_barycentric(lm);
                        self.field.direction(s, t, lm, d1).unwrap_or(d1)
                    }
                    None => d1,
                }
            } else {
                h
            };
            if confident {
                straight = 0.0;
                keep = pts.len();
            }
            if angle(dir, h) > MAX_TURN {
                break TraceEnd::Turn;
            }
            let Some((q, k, corner)) = exit(s, t, p, dir) else {
                break TraceEnd::Turn;
            };
            // Spacing against the accepted lines along p → q.
            let seg = norm(sub(q, p));
            let n = (seg / (0.25 * test)).ceil().max(1.0) as usize;
            let mut close = None;
            for i in 1..=n {
                let x = add(p, scale(sub(q, p), i as f64 / n as f64));
                if samples.near_parallel(x, dir, test) {
                    close = Some(x);
                    break;
                }
            }
            if let Some(x) = close {
                if norm(sub(x, p)) > 1e-9 {
                    pts.push(x);
                }
                break TraceEnd::Spacing;
            }
            pts.push(q);
            len += seg;
            h = dir;
            if !confident {
                straight += seg;
                if straight > self.rules.spacing {
                    pts.truncate(keep);
                    break TraceEnd::LowConfidence;
                }
            }
            let Some(next) = next_triangle(s, t, q, k, corner, dir) else {
                break TraceEnd::Boundary;
            };
            if self.blocked[next as usize] {
                break TraceEnd::KeepOut;
            }
            let Some(hn) = step_heading(s, dir, t, next) else {
                break TraceEnd::Turn;
            };
            h = hn;
            t = next;
            p = q;
        };
        let n = pts.len();
        let dir = if n >= 2 {
            normalize(sub(pts[n - 1], pts[n - 2])).unwrap_or(h)
        } else {
            h
        };
        Traced {
            points: pts,
            end,
            tri: t,
            dir,
        }
    }

    /// Every candidate line, in seed order.
    pub fn candidates(&self) -> Vec<Candidate> {
        let s = self.s;
        let f = self.field;
        let mut order: Vec<u32> = (0..s.tris.len() as u32)
            .filter(|&t| {
                !self.blocked[t as usize]
                    && f.confident[t as usize]
                    && f.density[t as usize] >= SEED_FLOOR * f.density_p90
            })
            .collect();
        order.sort_by(|&a, &b| {
            f.density[b as usize]
                .total_cmp(&f.density[a as usize])
                .then(a.cmp(&b))
        });
        let mut samples = Samples::new(self.rules.spacing);
        let mut out = Vec::new();
        for t in order {
            let c = s.centroid(t);
            let n = s.normal(t);
            let Some(major) = f.direction(s, t, [1.0 / 3.0; 3], f.major[t as usize]) else {
                continue;
            };
            let minor = crate::units::cross(n, major);
            for (family, d) in [(Family::Major, major), (Family::Minor, minor)] {
                if samples.near_parallel(c, d, self.rules.spacing) {
                    continue;
                }
                let fwd = self.trace(&samples, t, c, d);
                let back = self.trace(&samples, t, c, scale(d, -1.0));
                let mut points: Vec<[f64; 3]> = back.points.iter().rev().copied().collect();
                points.extend_from_slice(&fwd.points[1..]);
                let points = simplify(&points, self.rules.tolerance);
                let length: f64 = points.windows(2).map(|w| norm(sub(w[1], w[0]))).sum();
                if length < self.rules.min_length {
                    continue;
                }
                samples.add_line(&points);
                out.push(Candidate {
                    points,
                    family,
                    ends: [back.end, fwd.end],
                    end_dir: [back.dir, fwd.dir],
                    end_tri: [back.tri, fwd.tri],
                });
            }
        }
        out
    }

    /// The field's own continuation of a line from `p` in `t`, heading `d`,
    /// with no spacing rule (it may run beside other lines): up to the
    /// boundary, a keep-out, a sharp turn or low confidence. The points and
    /// whether it stopped at a keep-out.
    pub fn follow(&self, t: u32, p: [f64; 3], d: [f64; 3]) -> (Vec<[f64; 3]>, bool) {
        let empty = Samples::new(self.rules.spacing);
        let Some(h) = project(d, self.s.normal(t)) else {
            return (vec![p], false);
        };
        let traced = self.trace(&empty, t, p, h);
        (
            simplify(&traced.points, self.rules.tolerance),
            traced.end == TraceEnd::KeepOut,
        )
    }

    /// A straight continuation from `p` in or next to triangle `t` along
    /// `d`, up to `limit` mm, stopping at the boundary or a keep-out; and
    /// whether it stopped at a keep-out.
    pub fn straight_to(
        &self,
        t: u32,
        p: [f64; 3],
        d: [f64; 3],
        limit: f64,
    ) -> (Vec<[f64; 3]>, bool) {
        let s = self.s;
        // Start in whichever of t and its neighbours the ray enters.
        let mut start = None;
        let mut cands = vec![t];
        for k in 0..3 {
            if s.creases {
                cands.extend(s.neighbours(t, k));
            } else if let Some(o) = s.neighbour(t, k) {
                cands.push(o);
            }
        }
        for c in cands {
            let (l, _) = s.barycentric(c, p);
            if l.iter().all(|&x| x >= -1e-6) && !self.blocked[c as usize] {
                if let Some(h) = project(d, s.normal(c)) {
                    if exit(s, c, p, h).is_some() {
                        start = Some((c, h));
                        break;
                    }
                }
            }
        }
        let Some((mut t, mut h)) = start else {
            return (vec![p], false);
        };
        let mut pts = vec![p];
        let mut p = p;
        let mut len = 0.0;
        let mut keep_out = false;
        while len < limit {
            let Some((q, k, corner)) = exit(s, t, p, h) else {
                break;
            };
            let seg = norm(sub(q, p));
            if len + seg >= limit {
                pts.push(add(p, scale(h, limit - len)));
                break;
            }
            pts.push(q);
            len += seg;
            let Some(next) = next_triangle(s, t, q, k, corner, h) else {
                break;
            };
            if self.blocked[next as usize] {
                keep_out = true;
                break;
            }
            let Some(hn) = step_heading(s, h, t, next) else {
                break;
            };
            h = hn;
            t = next;
            p = q;
        }
        (simplify(&pts, self.rules.tolerance), keep_out)
    }
}

/// Douglas–Peucker: the fewest of `points` whose polyline stays within
/// `tol` of all of them, ends kept.
pub(crate) fn simplify(points: &[[f64; 3]], tol: f64) -> Vec<[f64; 3]> {
    if points.len() <= 2 {
        return points.to_vec();
    }
    let mut keep = vec![false; points.len()];
    keep[0] = true;
    keep[points.len() - 1] = true;
    let mut stack = vec![(0usize, points.len() - 1)];
    while let Some((a, b)) = stack.pop() {
        let (pa, pb) = (points[a], points[b]);
        let ab = sub(pb, pa);
        let len2 = dot(ab, ab);
        let mut worst = (0.0, a);
        for (i, &p) in points.iter().enumerate().take(b).skip(a + 1) {
            let ap = sub(p, pa);
            let tpar = if len2 > 0.0 {
                (dot(ap, ab) / len2).clamp(0.0, 1.0)
            } else {
                0.0
            };
            let d = norm(sub(ap, scale(ab, tpar)));
            if d > worst.0 {
                worst = (d, i);
            }
        }
        if worst.0 > tol {
            keep[worst.1] = true;
            stack.push((a, worst.1));
            stack.push((worst.1, b));
        }
    }
    points
        .iter()
        .zip(&keep)
        .filter(|(_, k)| **k)
        .map(|(p, _)| *p)
        .collect()
}

#[cfg(test)]
#[path = "fold_tests.rs"]
mod fold_tests;
