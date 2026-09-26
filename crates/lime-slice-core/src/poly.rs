use clipper2::{EndType, FillRule, JoinType, Milli, Paths};

/// Closed loop in the XY plane, millimeters.
pub type Loop = Vec<[f64; 2]>;

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

fn drop_collinear(input: &[[f64; 2]]) -> Vec<[f64; 2]> {
    if input.len() < 3 {
        return input.to_vec();
    }
    // Merge near-coincident neighbours first. Dropping every point next to a
    // tiny edge would take both of its ends, and with them a real corner.
    let mut pts: Vec<[f64; 2]> = Vec::with_capacity(input.len());
    for &p in input {
        if pts
            .last()
            .is_none_or(|q| (p[0] - q[0]).hypot(p[1] - q[1]) >= 1e-5)
        {
            pts.push(p);
        }
    }
    while pts.len() > 3 && {
        let (a, b) = (pts[0], pts[pts.len() - 1]);
        (a[0] - b[0]).hypot(a[1] - b[1]) < 1e-5
    } {
        pts.pop();
    }
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
        let want_ccw = depth[i].is_multiple_of(2);
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

pub(crate) fn paths_from_loops(loops: &[Loop]) -> Paths<Milli> {
    let raw: Vec<Vec<(f64, f64)>> = loops
        .iter()
        .map(|l| l.iter().map(|p| (p[0], p[1])).collect())
        .collect();
    raw.into()
}

pub(crate) fn loops_from_paths(paths: Paths<Milli>) -> Vec<Loop> {
    let raw: Vec<Vec<(f64, f64)>> = paths.into();
    orient_loops(
        raw.into_iter()
            .map(|l| l.into_iter().map(|(x, y)| [x, y]).collect())
            .collect(),
    )
}

pub(crate) fn offset_paths(paths: &Paths<Milli>, delta: f64) -> Paths<Milli> {
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

/// Union of loops that may overlap or self-intersect. Any region wound at
/// least once is solid, so a clockwise hole only cancels the outline around it.
pub fn resolve_nonzero(loops: Vec<Loop>) -> Vec<Loop> {
    if loops.is_empty() {
        return loops;
    }
    let empty: Paths<Milli> = Paths::default();
    match paths_from_loops(&loops)
        .to_clipper_subject()
        .add_clip(empty)
        .union(FillRule::NonZero)
    {
        Ok(paths) => loops_from_paths(paths),
        Err(_) => orient_loops(loops),
    }
}

pub fn boolean_intersect(a: &[Loop], b: &[Loop]) -> Vec<Loop> {
    if a.is_empty() || b.is_empty() {
        return Vec::new();
    }
    match paths_from_loops(a)
        .to_clipper_subject()
        .add_clip(paths_from_loops(b))
        .intersect(FillRule::NonZero)
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

#[cfg(test)]
mod tests {
    use super::orient_loops;

    #[test]
    fn a_doubled_corner_stays_a_corner() {
        let square = vec![
            [40.0, 0.0],
            [40.0, 16.0],
            [1e-14, 16.0],
            [1e-14, 5e-15],
            [1e-14, 0.0],
            [16.0, 0.0],
        ];
        let loops = orient_loops(vec![square]);
        assert_eq!(
            loops,
            vec![vec![
                [40.0, 0.0],
                [40.0, 16.0],
                [1e-14, 16.0],
                [1e-14, 5e-15]
            ]]
        );
    }
}
