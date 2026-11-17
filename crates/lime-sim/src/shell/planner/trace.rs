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
    pub extend_limit: f64,
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

/// The triangle after leaving `t` at `q` through local edge `k` (or corner
/// `corner`), heading `d`.
fn next_triangle(
    s: &Surface,
    t: u32,
    q: [f64; 3],
    k: usize,
    corner: Option<usize>,
    d: [f64; 3],
) -> Option<u32> {
    match corner {
        None => s.neighbour(t, k),
        Some(c) => {
            // Through a vertex: the other triangle around it whose sector
            // holds the heading.
            let v = s.tris[t as usize][c];
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
            let Some(hn) = project(dir, s.normal(next)) else {
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

    /// A straight continuation from `p` in or next to triangle `t` along
    /// `d`, up to `limit` mm, stopping at the boundary or a keep-out.
    pub fn straight(&self, t: u32, p: [f64; 3], d: [f64; 3], limit: f64) -> Vec<[f64; 3]> {
        let s = self.s;
        // Start in whichever of t and its neighbours the ray enters.
        let mut start = None;
        let mut cands = vec![t];
        for k in 0..3 {
            if let Some(o) = s.neighbour(t, k) {
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
            return vec![p];
        };
        let mut pts = vec![p];
        let mut p = p;
        let mut len = 0.0;
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
                break;
            }
            let Some(hn) = project(h, s.normal(next)) else {
                break;
            };
            h = hn;
            t = next;
            p = q;
        }
        simplify(&pts, self.rules.tolerance)
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
