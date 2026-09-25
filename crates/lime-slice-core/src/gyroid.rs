//! True 3D gyroid: the TPMS `sin(x)cos(y) + sin(y)cos(z) + sin(z)cos(x) = 0`
//! cut by the layer plane. The cross-section moves with Z. Segments are clipped
//! to the infill region, chained into long polylines, then simplified.

use std::collections::HashMap;

use rayon::prelude::*;

use crate::contour::{in_solid, loop_bounds, Loop};
use crate::toolpath::clip_open_segment;

/// Cell period for a target wall spacing. Adjacent gyroid sheets sit about
/// half a period apart, so the period is twice the infill spacing.
pub fn period_for_spacing(spacing: f64) -> f64 {
    // The 2D sine draws two families of lines. One TPMS sheet needs a shorter
    // period to land near that same extruded length.
    (spacing * 1.15).clamp(0.6, 24.0)
}

pub fn section(loops: &[Loop], period: f64, z: f64, tol: f64) -> Vec<Vec<[f64; 2]>> {
    let Some((min, max)) = loop_bounds(loops) else {
        return Vec::new();
    };
    let period = period.max(0.4);
    let step = (period / 10.0).clamp(0.16, 0.45);
    let k = std::f64::consts::TAU / period;
    let kz = z * k;
    let cos_z = kz.cos();
    let sin_z = kz.sin();
    let field = |x: f64, y: f64| {
        let kx = x * k;
        let ky = y * k;
        kx.sin() * ky.cos() + ky.sin() * cos_z + sin_z * kx.cos()
    };

    let nx = ((max[0] - min[0]) / step).ceil() as i32 + 1;
    let ny = ((max[1] - min[1]) / step).ceil() as i32 + 1;
    if nx < 2 || ny < 2 || nx > 800 || ny > 800 {
        return Vec::new();
    }
    let nxy = (nx * ny) as usize;
    let mut samples = vec![0.0f64; nxy];
    let mut inside = vec![false; nxy];
    samples
        .par_iter_mut()
        .zip(inside.par_iter_mut())
        .enumerate()
        .for_each(|(id, (sample, inn))| {
            let ix = id as i32 % nx;
            let iy = id as i32 / nx;
            let x = min[0] + ix as f64 * step;
            let y = min[1] + iy as f64 * step;
            *sample = field(x, y);
            *inn = in_solid(loops, x, y);
        });

    let segs: Vec<[[f64; 2]; 2]> = (0..ny - 1)
        .into_par_iter()
        .flat_map(|iy| {
            let mut row = Vec::new();
            for ix in 0..nx - 1 {
            let id = (iy * nx + ix) as usize;
            let corners = [id, id + 1, id + nx as usize + 1, id + nx as usize];
            let mut mask = 0u8;
            let mut vals = [0.0; 4];
            let mut pts = [[0.0; 2]; 4];
            let mut any_in = false;
            for (c, &cid) in corners.iter().enumerate() {
                vals[c] = samples[cid];
                if vals[c] >= 0.0 {
                    mask |= 1 << c;
                }
                let cx = ix + if c == 1 || c == 2 { 1 } else { 0 };
                let cy = iy + if c >= 2 { 1 } else { 0 };
                pts[c] = [min[0] + cx as f64 * step, min[1] + cy as f64 * step];
                any_in |= inside[cid];
            }
            if !any_in || mask == 0 || mask == 15 {
                continue;
            }
            let cross = |a: usize, b: usize| -> [f64; 2] {
                let va = vals[a];
                let vb = vals[b];
                let t = if (vb - va).abs() < 1e-12 {
                    0.5
                } else {
                    (-va / (vb - va)).clamp(0.0, 1.0)
                };
                [
                    pts[a][0] + (pts[b][0] - pts[a][0]) * t,
                    pts[a][1] + (pts[b][1] - pts[a][1]) * t,
                ]
            };
            // Edge ids: 0 bottom (0-1), 1 right (1-2), 2 top (3-2), 3 left (0-3).
            let edge_pt = |e: u8| match e {
                0 => cross(0, 1),
                1 => cross(1, 2),
                2 => cross(3, 2),
                _ => cross(0, 3),
            };
            let mut pairs: Vec<(u8, u8)> = Vec::new();
            match mask {
                1 | 14 => pairs.push((3, 0)),
                2 | 13 => pairs.push((0, 1)),
                3 | 12 => pairs.push((3, 1)),
                4 | 11 => pairs.push((1, 2)),
                6 | 9 => pairs.push((0, 2)),
                7 | 8 => pairs.push((3, 2)),
                5 | 10 => {
                    let cx = (pts[0][0] + pts[2][0]) * 0.5;
                    let cy = (pts[0][1] + pts[2][1]) * 0.5;
                    let center = field(cx, cy);
                    if (mask == 5 && center >= 0.0) || (mask == 10 && center < 0.0) {
                        pairs.push((3, 0));
                        pairs.push((1, 2));
                    } else {
                        pairs.push((0, 1));
                        pairs.push((3, 2));
                    }
                }
                _ => {}
            }
            let fully_in = corners.iter().all(|&c| inside[c]);
            for (ea, eb) in pairs {
                let a = edge_pt(ea);
                let b = edge_pt(eb);
                if fully_in {
                    if dist2(a, b) > 1e-8 {
                        row.push([a, b]);
                    }
                } else {
                    for piece in clip_open_segment(loops, a, b) {
                        row.push(piece);
                    }
                }
            }
            }
            row
        })
        .collect();
    let chained = bridge_gaps(chain(segs), loops, 0.5);
    let arc_tol = (tol.max(0.01) * 2.6).clamp(0.1, 0.16);
    chained
        .into_iter()
        .map(|p| {
            let simple = simplify(&p, tol.max(0.01));
            arc_coarsen(&simple, arc_tol)
        })
        .filter(|p| p.len() >= 2 && polyline_len(p) > 0.35)
        .collect()
}

/// Join open ends that clipping split, when the bridge stays inside and does not reverse.
fn bridge_gaps(mut paths: Vec<Vec<[f64; 2]>>, loops: &[Loop], join: f64) -> Vec<Vec<[f64; 2]>> {
    if paths.len() < 2 {
        return paths;
    }
    let join2 = join * join;
    let mut used = vec![false; paths.len()];
    let mut out = Vec::new();
    for i in 0..paths.len() {
        if used[i] {
            continue;
        }
        used[i] = true;
        let mut path = paths[i].clone();
        loop {
            let end = *path.last().unwrap();
            let prev = if path.len() >= 2 {
                path[path.len() - 2]
            } else {
                end
            };
            let mut best: Option<(usize, bool, f64)> = None;
            for (j, other) in paths.iter().enumerate() {
                if used[j] || other.len() < 2 {
                    continue;
                }
                for rev in [false, true] {
                    let tip = if rev { *other.last().unwrap() } else { other[0] };
                    let d2 = dist2(end, tip);
                    if d2 < 1e-8 || d2 > join2 {
                        continue;
                    }
                    let next = if rev {
                        other[other.len() - 2]
                    } else {
                        other[1]
                    };
                    if turn_cost(prev, end, tip) > 0.55 || turn_cost(end, tip, next) > 0.55 {
                        continue;
                    }
                    if !gap_inside(loops, end, tip) {
                        continue;
                    }
                    if best.map(|(_, _, b)| d2 < b).unwrap_or(true) {
                        best = Some((j, rev, d2));
                    }
                }
            }
            let Some((j, rev, _)) = best else {
                break;
            };
            used[j] = true;
            let mut seg = std::mem::take(&mut paths[j]);
            if rev {
                seg.reverse();
            }
            if dist2(*path.last().unwrap(), seg[0]) < 1e-8 {
                path.extend(seg.into_iter().skip(1));
            } else {
                path.extend(seg);
            }
        }
        out.push(path);
    }
    out
}

fn gap_inside(loops: &[Loop], a: [f64; 2], b: [f64; 2]) -> bool {
    let mid = [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5];
    in_solid(loops, mid[0], mid[1])
        && in_solid(loops, a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25)
        && in_solid(loops, a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75)
}

/// Replace a locally circular run with four points on that circle so the
/// G-code fitter can emit one G2/G3 instead of a spray of chords.
fn arc_coarsen(pts: &[[f64; 2]], tol: f64) -> Vec<[f64; 2]> {
    if pts.len() < 4 {
        return pts.to_vec();
    }
    let mut out = vec![pts[0]];
    let mut i = 0usize;
    while i + 1 < pts.len() {
        let mut best = i + 1;
        let mut j = i + 3;
        while j < pts.len() && j - i <= 48 {
            if fit_circle(&pts[i..=j], tol).is_some() {
                best = j;
                j += 1;
            } else if j > i + 3 {
                break;
            } else {
                j += 1;
            }
        }
        if best >= i + 3 {
            if let Some((center, _)) = fit_circle(&pts[i..=best], tol) {
                let a = pts[i];
                let b = pts[best];
                let a0 = (a[1] - center[1]).atan2(a[0] - center[0]);
                let a1 = (b[1] - center[1]).atan2(b[0] - center[0]);
                let mid = pts[(i + best) / 2];
                let am = (mid[1] - center[1]).atan2(mid[0] - center[0]);
                let sweep = if sweep_is_cw(a0, am) {
                    cw_delta(a0, a1)
                } else {
                    ccw_delta(a0, a1)
                };
                for k in 1..=3 {
                    let ang = a0 + sweep * (k as f64 / 3.0);
                    let r = (a[0] - center[0]).hypot(a[1] - center[1]);
                    out.push([center[0] + r * ang.cos(), center[1] + r * ang.sin()]);
                }
                i = best;
                continue;
            }
        }
        out.push(pts[i + 1]);
        i += 1;
    }
    out
}

fn sweep_is_cw(a0: f64, am: f64) -> bool {
    let mut d = am - a0;
    while d > std::f64::consts::PI {
        d -= std::f64::consts::TAU;
    }
    while d < -std::f64::consts::PI {
        d += std::f64::consts::TAU;
    }
    d < 0.0
}

fn cw_delta(from: f64, to: f64) -> f64 {
    let mut d = to - from;
    while d > 0.0 {
        d -= std::f64::consts::TAU;
    }
    while d < -std::f64::consts::TAU {
        d += std::f64::consts::TAU;
    }
    d
}

fn ccw_delta(from: f64, to: f64) -> f64 {
    let mut d = to - from;
    while d < 0.0 {
        d += std::f64::consts::TAU;
    }
    while d > std::f64::consts::TAU {
        d -= std::f64::consts::TAU;
    }
    d
}

fn fit_circle(pts: &[[f64; 2]], tol: f64) -> Option<([f64; 2], f64)> {
    if pts.len() < 4 {
        return None;
    }
    let a = pts[0];
    let mid = pts[pts.len() / 2];
    let c = *pts.last().unwrap();
    let center = circle_center(a, mid, c)?;
    let r = (a[0] - center[0]).hypot(a[1] - center[1]);
    if !(0.35..=80.0).contains(&r) {
        return None;
    }
    if pts.iter().any(|p| ((p[0] - center[0]).hypot(p[1] - center[1]) - r).abs() > tol) {
        return None;
    }
    Some((center, r))
}

fn circle_center(a: [f64; 2], b: [f64; 2], c: [f64; 2]) -> Option<[f64; 2]> {
    let d = 2.0 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
    if d.abs() < 1e-8 {
        return None;
    }
    let a2 = a[0] * a[0] + a[1] * a[1];
    let b2 = b[0] * b[0] + b[1] * b[1];
    let c2 = c[0] * c[0] + c[1] * c[1];
    Some([
        (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d,
        (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d,
    ])
}

fn chain(segs: Vec<[[f64; 2]; 2]>) -> Vec<Vec<[f64; 2]>> {
    if segs.is_empty() {
        return Vec::new();
    }
    let q = 1.0e3_f64;
    let key = |p: [f64; 2]| ((p[0] * q).round() as i32, (p[1] * q).round() as i32);
    let mut at: HashMap<(i32, i32), Vec<usize>> = HashMap::new();
    for (i, seg) in segs.iter().enumerate() {
        at.entry(key(seg[0])).or_default().push(i);
        at.entry(key(seg[1])).or_default().push(i);
    }
    let mut used = vec![false; segs.len()];
    let mut paths = Vec::new();
    for start in 0..segs.len() {
        if used[start] {
            continue;
        }
        used[start] = true;
        let mut path = vec![segs[start][0], segs[start][1]];
        extend(&mut path, &segs, &mut used, &at, &key);
        path.reverse();
        extend(&mut path, &segs, &mut used, &at, &key);
        if dist2(*path.first().unwrap(), *path.last().unwrap()) < step_join() && path.len() > 3 {
            let first = path[0];
            path.push(first);
        }
        paths.push(path);
    }
    paths
}

fn step_join() -> f64 {
    0.04 * 0.04
}

fn extend(
    path: &mut Vec<[f64; 2]>,
    segs: &[[[f64; 2]; 2]],
    used: &mut [bool],
    at: &HashMap<(i32, i32), Vec<usize>>,
    key: &impl Fn([f64; 2]) -> (i32, i32),
) {
    loop {
        let tip = *path.last().unwrap();
        let prev = if path.len() >= 2 {
            path[path.len() - 2]
        } else {
            tip
        };
        let Some(cands) = at.get(&key(tip)) else {
            break;
        };
        let mut best: Option<(usize, [f64; 2], f64)> = None;
        for &si in cands {
            if used[si] {
                continue;
            }
            let seg = segs[si];
            let other = if dist2(seg[0], tip) <= dist2(seg[1], tip) {
                seg[1]
            } else {
                seg[0]
            };
            let turn = turn_cost(prev, tip, other);
            if best.map(|(_, _, t)| turn < t).unwrap_or(true) {
                best = Some((si, other, turn));
            }
        }
        let Some((si, other, _)) = best else {
            break;
        };
        used[si] = true;
        path.push(other);
        if path.len() > segs.len() + 2 {
            break;
        }
    }
}

fn turn_cost(a: [f64; 2], b: [f64; 2], c: [f64; 2]) -> f64 {
    let abx = b[0] - a[0];
    let aby = b[1] - a[1];
    let bcx = c[0] - b[0];
    let bcy = c[1] - b[1];
    let ab = abx.hypot(aby).max(1e-9);
    let bc = bcx.hypot(bcy).max(1e-9);
    1.0 - (abx * bcx + aby * bcy) / (ab * bc)
}

fn simplify(pts: &[[f64; 2]], tol: f64) -> Vec<[f64; 2]> {
    if pts.len() < 3 {
        return pts.to_vec();
    }
    let closed = dist2(pts[0], *pts.last().unwrap()) < 1e-8 && pts.len() > 3;
    let body = if closed { &pts[..pts.len() - 1] } else { pts };
    let mut keep = vec![false; body.len()];
    keep[0] = true;
    keep[body.len() - 1] = true;
    mark(body, &mut keep, 0, body.len() - 1, tol * tol);
    let mut out: Vec<[f64; 2]> = body
        .iter()
        .enumerate()
        .filter(|(i, _)| keep[*i])
        .map(|(_, p)| *p)
        .collect();
    if closed {
        if let Some(first) = out.first().copied() {
            out.push(first);
        }
    }
    out
}

fn mark(pts: &[[f64; 2]], keep: &mut [bool], i: usize, j: usize, tol2: f64) {
    if j <= i + 1 {
        return;
    }
    let mut far = 0.0;
    let mut at = i;
    for k in i + 1..j {
        let d = seg_dist2(pts[k], pts[i], pts[j]);
        if d > far {
            far = d;
            at = k;
        }
    }
    if far > tol2 {
        keep[at] = true;
        mark(pts, keep, i, at, tol2);
        mark(pts, keep, at, j, tol2);
    }
}

fn seg_dist2(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    let abx = b[0] - a[0];
    let aby = b[1] - a[1];
    let len2 = abx * abx + aby * aby;
    if len2 < 1e-18 {
        return dist2(p, a);
    }
    let t = ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len2;
    let t = t.clamp(0.0, 1.0);
    dist2(p, [a[0] + abx * t, a[1] + aby * t])
}

fn polyline_len(pts: &[[f64; 2]]) -> f64 {
    pts.windows(2).map(|w| dist2(w[0], w[1]).sqrt()).sum()
}

fn dist2(a: [f64; 2], b: [f64; 2]) -> f64 {
    let dx = a[0] - b[0];
    let dy = a[1] - b[1];
    dx * dx + dy * dy
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square(size: f64) -> Vec<Loop> {
        vec![vec![
            [0.0, 0.0],
            [size, 0.0],
            [size, size],
            [0.0, size],
        ]]
    }

    #[test]
    fn section_changes_with_z_and_stays_inside() {
        let loops = square(16.0);
        let period = 4.0;
        let a = section(&loops, period, 0.2, 0.05);
        let b = section(&loops, period, period * 0.25, 0.05);
        assert!(!a.is_empty() && !b.is_empty());
        let sample = |paths: &[Vec<[f64; 2]>]| {
            paths
                .iter()
                .flat_map(|p| p.iter().copied())
                .take(12)
                .collect::<Vec<_>>()
        };
        assert_ne!(sample(&a), sample(&b));
        for path in a.iter().chain(b.iter()) {
            for p in path {
                assert!(
                    in_solid(&loops, p[0], p[1]) || on_edge(*p, 16.0),
                    "point {p:?} left the square"
                );
            }
        }
    }

    fn on_edge(p: [f64; 2], size: f64) -> bool {
        let e = 0.15;
        (p[0] >= -e && p[0] <= size + e && p[1] >= -e && p[1] <= size + e)
            && (p[0] < e || p[1] < e || (size - p[0]) < e || (size - p[1]) < e)
    }

    #[test]
    fn chaining_makes_long_polylines() {
        let loops = square(18.0);
        let paths = section(&loops, 5.0, 1.2, 0.05);
        let longest = paths
            .iter()
            .map(|p| polyline_len(p))
            .fold(0.0, f64::max);
        assert!(
            longest > 12.0,
            "expected a chained run, longest {longest:.2} across {} paths",
            paths.len()
        );
        assert!(paths.len() < 40, "too many fragments: {}", paths.len());
    }

    #[test]
    fn nearby_layers_move_continuously() {
        let loops = square(14.0);
        let period = 4.5;
        let a = section(&loops, period, 1.0, 0.05);
        let b = section(&loops, period, 1.2, 0.05);
        let mut moved = 0.0;
        let mut n = 0.0f64;
        for path in &a {
            for p in path.iter().step_by(3) {
                let best = b
                    .iter()
                    .flat_map(|q| q.iter())
                    .map(|r| dist2(*p, *r))
                    .fold(f64::MAX, f64::min)
                    .sqrt();
                moved += best;
                n += 1.0;
            }
        }
        let mean = moved / n.max(1.0);
        assert!(mean < 0.8, "mean point drift {mean:.3} mm across 0.2 mm of Z");
    }
}
