use std::collections::HashMap;

use crate::mesh::Mesh;

/// Closed loop in the XY plane, millimeters.
pub type Loop = Vec<[f64; 2]>;

pub fn slice_contours(mesh: &Mesh, z: f64) -> Vec<Loop> {
    let mut segs: Vec<([f64; 2], [f64; 2])> = Vec::new();
    for tri in &mesh.triangles {
        let mut hits = Vec::with_capacity(2);
        for e in 0..3 {
            if let Some(p) = edge_cross(tri[e], tri[(e + 1) % 3], z) {
                if hits.iter().all(|q: &[f64; 2]| dist2(*q, p) > 1e-12) {
                    hits.push(p);
                }
            }
        }
        if hits.len() == 2 && dist2(hits[0], hits[1]) > 1e-12 {
            segs.push((hits[0], hits[1]));
        }
    }
    contours_from_segments(segs)
}

pub fn contours_from_segments(segs: Vec<([f64; 2], [f64; 2])>) -> Vec<Loop> {
    orient_loops(stitch(segs))
}

fn edge_cross(a: [f64; 3], b: [f64; 3], z: f64) -> Option<[f64; 2]> {
    let za = a[2];
    let zb = b[2];
    let crosses = (za < z && zb >= z) || (zb < z && za >= z);
    if !crosses {
        return None;
    }
    let denom = zb - za;
    if denom.abs() < 1e-15 {
        return None;
    }
    let t = (z - za) / denom;
    Some([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
}

fn dist2(a: [f64; 2], b: [f64; 2]) -> f64 {
    let dx = a[0] - b[0];
    let dy = a[1] - b[1];
    dx * dx + dy * dy
}

fn key(p: [f64; 2]) -> (i64, i64) {
    (
        (p[0] * 10_000.0).round() as i64,
        (p[1] * 10_000.0).round() as i64,
    )
}

fn stitch(segs: Vec<([f64; 2], [f64; 2])>) -> Vec<Loop> {
    let mut map: HashMap<(i64, i64), Vec<usize>> = HashMap::new();
    for (i, (a, b)) in segs.iter().enumerate() {
        map.entry(key(*a)).or_default().push(i);
        map.entry(key(*b)).or_default().push(i);
    }
    let mut used = vec![false; segs.len()];
    let mut loops = Vec::new();
    for start in 0..segs.len() {
        if used[start] {
            continue;
        }
        used[start] = true;
        let mut chain = vec![segs[start].0, segs[start].1];
        let mut closed = false;
        for _ in 0..segs.len() {
            let end = *chain.last().unwrap();
            let Some(cands) = map.get(&key(end)) else {
                break;
            };
            let Some(ni) = cands.iter().copied().find(|i| !used[*i]) else {
                break;
            };
            used[ni] = true;
            let (a, b) = segs[ni];
            let pt = if key(a) == key(end) { b } else { a };
            if key(pt) == key(chain[0]) {
                closed = true;
                break;
            }
            chain.push(pt);
        }
        if closed && chain.len() >= 3 && signed_area(&chain).abs() > 0.02 {
            loops.push(chain);
        }
    }
    loops
}

pub fn signed_area(loop_: &[[f64; 2]]) -> f64 {
    let mut a = 0.0;
    for i in 0..loop_.len() {
        let p = loop_[i];
        let q = loop_[(i + 1) % loop_.len()];
        a += p[0] * q[1] - q[0] * p[1];
    }
    a * 0.5
}

pub fn point_in_loop(loop_: &[[f64; 2]], x: f64, y: f64) -> bool {
    let mut inside = false;
    let n = loop_.len();
    if n < 3 {
        return false;
    }
    let mut j = n - 1;
    for i in 0..n {
        let (xi, yi) = (loop_[i][0], loop_[i][1]);
        let (xj, yj) = (loop_[j][0], loop_[j][1]);
        if ((yi > y) != (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi) {
            inside = !inside;
        }
        j = i;
    }
    inside
}

pub fn in_solid(loops: &[Loop], x: f64, y: f64) -> bool {
    loops.iter().filter(|l| point_in_loop(l, x, y)).count() % 2 == 1
}

fn interior_point(loop_: &[[f64; 2]]) -> [f64; 2] {
    let c = polygon_centroid(loop_);
    if point_in_loop(loop_, c[0], c[1]) {
        return c;
    }
    for i in 0..loop_.len() {
        let a = loop_[i];
        let b = loop_[(i + 1) % loop_.len()];
        let mx = (a[0] + b[0]) * 0.5;
        let my = (a[1] + b[1]) * 0.5;
        let dx = a[1] - b[1];
        let dy = b[0] - a[0];
        let len = (dx * dx + dy * dy).sqrt().max(1e-9);
        for s in [-0.25_f64, 0.25, -0.08, 0.08] {
            let p = [mx + dx / len * s, my + dy / len * s];
            if point_in_loop(loop_, p[0], p[1]) {
                return p;
            }
        }
    }
    c
}

fn drop_collinear(pts: &[[f64; 2]]) -> Vec<[f64; 2]> {
    if pts.len() < 3 {
        return pts.to_vec();
    }
    let mut pts = pts.to_vec();
    let mut changed = true;
    while changed && pts.len() >= 3 {
        changed = false;
        let n = pts.len();
        let mut keep = Vec::with_capacity(n);
        for i in 0..n {
            let a = pts[(i + n - 1) % n];
            let b = pts[i];
            let c = pts[(i + 1) % n];
            let abx = b[0] - a[0];
            let aby = b[1] - a[1];
            let bcx = c[0] - b[0];
            let bcy = c[1] - b[1];
            let abn = abx.hypot(aby);
            let bcn = bcx.hypot(bcy);
            let cross = abx * bcy - aby * bcx;
            if abn < 1e-5 || bcn < 1e-5 || cross.abs() <= 1e-4 * abn * bcn {
                changed = true;
                continue;
            }
            keep.push(b);
        }
        if keep.len() >= 3 {
            pts = keep;
        } else {
            break;
        }
    }
    pts
}

fn polygon_centroid(loop_: &[[f64; 2]]) -> [f64; 2] {
    let mut a = 0.0;
    let mut cx = 0.0;
    let mut cy = 0.0;
    for i in 0..loop_.len() {
        let p = loop_[i];
        let q = loop_[(i + 1) % loop_.len()];
        let cross = p[0] * q[1] - q[0] * p[1];
        a += cross;
        cx += (p[0] + q[0]) * cross;
        cy += (p[1] + q[1]) * cross;
    }
    if a.abs() < 1e-12 {
        let n = loop_.len().max(1) as f64;
        let sx: f64 = loop_.iter().map(|p| p[0]).sum();
        let sy: f64 = loop_.iter().map(|p| p[1]).sum();
        return [sx / n, sy / n];
    }
    [cx / (3.0 * a), cy / (3.0 * a)]
}

/// Outers are CCW, holes are CW. Tiny loops are dropped.
pub fn orient_loops(mut loops: Vec<Loop>) -> Vec<Loop> {
    for loop_ in &mut loops {
        *loop_ = drop_collinear(loop_);
    }
    loops.retain(|l| l.len() >= 3 && signed_area(l).abs() > 0.02);
    let centers: Vec<[f64; 2]> = loops.iter().map(|l| interior_point(l)).collect();
    let areas: Vec<f64> = loops.iter().map(|l| signed_area(l)).collect();
    let mut depth = vec![0usize; loops.len()];
    for i in 0..loops.len() {
        for j in 0..loops.len() {
            if i == j || areas[j].abs() <= areas[i].abs() + 1e-6 {
                continue;
            }
            if point_in_loop(&loops[j], centers[i][0], centers[i][1]) {
                depth[i] += 1;
            }
        }
    }
    for i in 0..loops.len() {
        let want_ccw = depth[i] % 2 == 0;
        let is_ccw = areas[i] > 0.0;
        if want_ccw != is_ccw {
            loops[i].reverse();
        }
    }
    loops
}

pub fn loop_bounds(loops: &[Loop]) -> Option<([f64; 2], [f64; 2])> {
    let mut iter = loops.iter().flat_map(|l| l.iter());
    let first = *iter.next()?;
    let mut min = first;
    let mut max = first;
    for p in iter {
        min[0] = min[0].min(p[0]);
        min[1] = min[1].min(p[1]);
        max[0] = max[0].max(p[0]);
        max[1] = max[1].max(p[1]);
    }
    Some((min, max))
}
