use super::*;

pub(super) fn stripe_orders(paths: &[Extrusion]) -> Vec<Vec<usize>> {
    let n = paths.len();
    if n < 4 || paths.iter().any(geom_closed) {
        return Vec::new();
    }
    let angs: Vec<Option<f64>> = paths.iter().map(line_angle).collect();
    let known: Vec<f64> = angs.iter().copied().flatten().collect();
    if known.len() * 4 < n * 3 {
        return Vec::new();
    }
    let mut bins = [0u32; 18];
    for a in &known {
        let bin = ((a / std::f64::consts::PI) * 18.0).floor() as usize % 18;
        bins[bin] += 1;
    }
    let dom = bins
        .iter()
        .enumerate()
        .max_by(|a, b| a.1.cmp(b.1).then(b.0.cmp(&a.0)))
        .map(|(i, _)| i)
        .unwrap_or(0);
    let axis = (dom as f64 + 0.5) * std::f64::consts::PI / 18.0;
    let axis_v = (axis + std::f64::consts::FRAC_PI_2).rem_euclid(std::f64::consts::PI);
    let mut along = Vec::new();
    let mut across = Vec::new();
    let mut rest = Vec::new();
    for (i, ang) in angs.iter().enumerate() {
        match ang {
            Some(a) if angle_near(*a, axis) => along.push(i),
            Some(a) if angle_near(*a, axis_v) => across.push(i),
            _ => rest.push(i),
        }
    }
    if (along.len() + across.len()) * 4 < n * 3 {
        return Vec::new();
    }
    let snake_a = snake(&along, paths, axis);
    let snake_b = snake(&across, paths, axis_v);
    let mut first = Vec::with_capacity(n);
    first.extend_from_slice(&snake_a);
    first.extend_from_slice(&snake_b);
    first.extend_from_slice(&rest);
    if across.is_empty() {
        return vec![first];
    }
    let mut second = Vec::with_capacity(n);
    second.extend_from_slice(&snake_b);
    second.extend_from_slice(&snake_a);
    second.extend_from_slice(&rest);
    vec![first, second]
}

pub(super) fn angle_near(a: f64, axis: f64) -> bool {
    let d = (a - axis).abs().rem_euclid(std::f64::consts::PI);
    let d = d.min(std::f64::consts::PI - d);
    d <= 20.0_f64.to_radians()
}

pub(super) fn line_angle(path: &Extrusion) -> Option<f64> {
    if path.points.len() < 2 {
        return None;
    }
    let a = path.points[0];
    let b = *path.points.last().unwrap();
    if dist2(a, b) < 0.2 * 0.2 {
        return None;
    }
    Some(
        (b[1] - a[1])
            .atan2(b[0] - a[0])
            .rem_euclid(std::f64::consts::PI),
    )
}

pub(super) fn snake(indices: &[usize], paths: &[Extrusion], axis: f64) -> Vec<usize> {
    if indices.is_empty() {
        return Vec::new();
    }
    let dir = [axis.cos(), axis.sin()];
    let nrm = [-dir[1], dir[0]];
    let mut items: Vec<(f64, f64, usize)> = indices
        .iter()
        .map(|&i| {
            let pts = &paths[i].points;
            let a = pts[0];
            let b = *pts.last().unwrap();
            let c = [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5];
            (
                c[0] * nrm[0] + c[1] * nrm[1],
                c[0] * dir[0] + c[1] * dir[1],
                i,
            )
        })
        .collect();
    items.sort_by(|a, b| {
        a.0.total_cmp(&b.0)
            .then(a.1.total_cmp(&b.1))
            .then(a.2.cmp(&b.2))
    });
    let mut rows: Vec<Vec<(f64, usize)>> = Vec::new();
    let mut row_n = 0.0;
    for (n, t, i) in items {
        if rows.is_empty() || (n - row_n).abs() > 0.22 {
            rows.push(Vec::new());
            row_n = n;
        }
        rows.last_mut().unwrap().push((t, i));
    }
    let mut flip = false;
    let mut out = Vec::with_capacity(indices.len());
    for mut row in rows {
        row.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
        if flip {
            row.reverse();
        }
        flip = !flip;
        out.extend(row.into_iter().map(|(_, i)| i));
    }
    out
}

/// Move paths that sit on a long travel next to a spatial neighbor when that
/// shortens the seated tour. Caps the scan so a fat layer cannot nest an
/// O(n²) search inside every candidate.
pub(super) fn polish_order(
    paths: &[Extrusion],
    order: &[usize],
    cursor: [f64; 2],
    has: bool,
    rotate: bool,
    to: Option<[f64; 2]>,
) -> Vec<usize> {
    let n = order.len();
    // Large groups already have a spatial candidate. The relocation search is
    // for the myopic case (a long chord stealing a small neighborhood).
    if !(3..=160).contains(&n) {
        return order.to_vec();
    }
    let neighbors = k_nearest(paths, 8);
    let mut order = order.to_vec();
    let mut walk = Walk::new(paths, &order, cursor, has, rotate, to);
    let mut cost = walk.total;
    for _ in 0..24 {
        let dirs = &walk.dirs;
        let mut hot: Vec<(f64, usize)> = Vec::new();
        if has && !dirs.is_empty() {
            let d = dist_mm(cursor, dirs[0].start);
            if d > 1.5 {
                hot.push((d, 0));
            }
        }
        for i in 0..n.saturating_sub(1) {
            let d = dist_mm(dirs[i].end, dirs[i + 1].start);
            if d > 1.5 {
                hot.push((d, i));
                hot.push((d, i + 1));
            }
        }
        if hot.is_empty() {
            break;
        }
        hot.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
        hot.dedup_by(|a, b| a.1 == b.1);
        hot.truncate(24);
        let mut pos = vec![0usize; paths.len()];
        for (p, dir) in dirs.iter().enumerate() {
            pos[dir.index] = p;
        }
        let mut accepted = None;
        'search: for (_, t) in hot {
            let idx = dirs[t].index;
            for &nb in &neighbors[idx] {
                let t2 = pos[nb];
                for raw_at in [t2, t2 + 1] {
                    let mut trial = order.clone();
                    let item = trial.remove(t);
                    let at = insert_at(raw_at, t, trial.len());
                    if at == t {
                        continue;
                    }
                    trial.insert(at, item);
                    let span = (t.min(at), t.max(at));
                    let next = walk.cost_of(paths, &trial, span, TRAVEL_WIN_MM, cost);
                    if let Some(next) = next.filter(|next| next + TRAVEL_WIN_MM < cost) {
                        accepted = Some((trial, next));
                        break 'search;
                    }
                }
            }
        }
        let Some((trial, next)) = accepted else {
            break;
        };
        walk = Walk::new(paths, &trial, cursor, has, rotate, to);
        order = trial;
        cost = next;
    }
    order
}

pub(super) fn insert_at(raw_at: usize, removed: usize, len_after_remove: usize) -> usize {
    let at = if raw_at > removed { raw_at - 1 } else { raw_at };
    at.min(len_after_remove)
}

pub(super) fn k_nearest(paths: &[Extrusion], k: usize) -> Vec<Vec<usize>> {
    let n = paths.len();
    let k = k.min(n.saturating_sub(1));
    let reps: Vec<Vec<[f64; 2]>> = paths.iter().map(rep_points).collect();
    if k == 0 {
        return vec![Vec::new(); n];
    }
    if n <= 400 {
        return brute_nearest(&reps, k);
    }
    grid_nearest(&reps, k)
}

pub(super) fn brute_nearest(reps: &[Vec<[f64; 2]>], k: usize) -> Vec<Vec<usize>> {
    let n = reps.len();
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let mut best: Vec<(f64, usize)> = Vec::new();
        for j in 0..n {
            if i == j {
                continue;
            }
            best.push((rep_dist2(&reps[i], &reps[j]), j));
        }
        best.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
        best.truncate(k);
        out.push(best.into_iter().map(|(_, j)| j).collect());
    }
    out
}

pub(super) fn grid_nearest(reps: &[Vec<[f64; 2]>], k: usize) -> Vec<Vec<usize>> {
    let n = reps.len();
    let cell = 4.0_f64;
    let key = |p: [f64; 2]| ((p[0] / cell).floor() as i64, (p[1] / cell).floor() as i64);
    let mut grid: HashMap<(i64, i64), Vec<usize>> = HashMap::new();
    for (i, pts) in reps.iter().enumerate() {
        for p in pts {
            grid.entry(key(*p)).or_default().push(i);
        }
    }
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let mut best: Vec<(f64, usize)> = Vec::new();
        let mut seen = vec![false; n];
        seen[i] = true;
        for ring in 0..=6 {
            for p in &reps[i] {
                let (cx, cy) = key(*p);
                for gx in cx - ring..=cx + ring {
                    for gy in cy - ring..=cy + ring {
                        let Some(ids) = grid.get(&(gx, gy)) else {
                            continue;
                        };
                        for &j in ids {
                            if seen[j] {
                                continue;
                            }
                            seen[j] = true;
                            best.push((rep_dist2(&reps[i], &reps[j]), j));
                        }
                    }
                }
            }
            if best.len() >= k {
                break;
            }
        }
        best.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
        best.truncate(k);
        out.push(best.into_iter().map(|(_, j)| j).collect());
    }
    out
}

pub(super) fn rep_points(path: &Extrusion) -> Vec<[f64; 2]> {
    let pts = &path.points;
    if pts.len() < 2 {
        return pts.clone();
    }
    if geom_closed(path) {
        let ring = pts.len() - 1;
        let step = (ring / 12).max(1);
        let mut out = Vec::new();
        let mut i = 0;
        while i < ring {
            out.push(pts[i]);
            i += step;
        }
        out
    } else {
        vec![pts[0], pts[pts.len() / 2], *pts.last().unwrap()]
    }
}

pub(super) fn rep_dist2(a: &[[f64; 2]], b: &[[f64; 2]]) -> f64 {
    let mut best = f64::MAX;
    for p in a {
        for q in b {
            let d = dist2(*p, *q);
            if d < best {
                best = d;
            }
        }
    }
    best
}

pub(super) fn centroid(path: &Extrusion) -> [f64; 2] {
    if path.points.is_empty() {
        return [0.0, 0.0];
    }
    let n = if geom_closed(path) {
        path.points.len() - 1
    } else {
        path.points.len()
    };
    let n = n.max(1);
    let mut x = 0.0;
    let mut y = 0.0;
    for p in path.points.iter().take(n) {
        x += p[0];
        y += p[1];
    }
    let n = n as f64;
    [x / n, y / n]
}

pub(super) struct TourStop {
    index: usize,
    pub(super) start: [f64; 2],
    end: [f64; 2],
}

/// One order's `walk_cost`, kept leg by leg, so an order that differs from
/// it only between two positions is costed without orienting every path
/// again. The sums run in `tour_cost`'s order, so a cost is the same `f64`.
pub(super) struct Walk {
    dirs: Vec<TourStop>,
    /// Where the nozzle stands before each stop, and whether it stands anywhere.
    at: Vec<([f64; 2], bool)>,
    /// The travel into each stop. The first is zero with no cursor.
    legs: Vec<f64>,
    /// The cost through each stop.
    sums: Vec<f64>,
    cursor: [f64; 2],
    has: bool,
    rotate: bool,
    to: Option<[f64; 2]>,
    pub(super) total: f64,
}

impl Walk {
    pub(super) fn new(
        paths: &[Extrusion],
        order: &[usize],
        cursor: [f64; 2],
        has: bool,
        rotate: bool,
        to: Option<[f64; 2]>,
    ) -> Self {
        let dirs = build_dirs(paths, order, cursor, has, rotate);
        let n = dirs.len();
        let (mut at, mut legs, mut sums) = (
            Vec::with_capacity(n),
            Vec::with_capacity(n),
            Vec::with_capacity(n),
        );
        let mut stand = (cursor, has);
        for (k, dir) in dirs.iter().enumerate() {
            at.push(stand);
            let leg = match k {
                0 if has => dist_mm(cursor, dir.start),
                0 => 0.0,
                _ => dist_mm(dirs[k - 1].end, dir.start),
            };
            legs.push(leg);
            sums.push(if k == 0 { leg } else { sums[k - 1] + leg });
            if !paths[dir.index].points.is_empty() {
                stand = (dir.end, true);
            }
        }
        let mut total = sums.last().copied().unwrap_or(0.0);
        if let (Some(to), Some(last)) = (to, dirs.last()) {
            total += dist_mm(last.end, to);
        }
        Self {
            dirs,
            at,
            legs,
            sums,
            cursor,
            has,
            rotate,
            to,
            total,
        }
    }

    /// `walk_cost` of `order`, which holds this walk's paths at every
    /// position outside `span`. Past `span`, once the nozzle stands where it
    /// stood on this walk, every stop is this walk's. `None` once the cost
    /// can no longer come in `win` under `bound`: legs are never negative.
    pub(super) fn cost_of(
        &self,
        paths: &[Extrusion],
        order: &[usize],
        span: (usize, usize),
        win: f64,
        bound: f64,
    ) -> Option<f64> {
        let (lo, hi) = span;
        let n = order.len();
        let bits = |(p, h): ([f64; 2], bool)| (p.map(f64::to_bits), h);
        let mut stand = self.at[lo];
        let mut sum = if lo == 0 { 0.0 } else { self.sums[lo - 1] };
        let mut last = if lo == 0 {
            self.cursor
        } else {
            self.dirs[lo - 1].end
        };
        for k in lo..n {
            if k > hi && bits(stand) == bits(self.at[k]) {
                for leg in &self.legs[k..] {
                    sum += leg;
                    if sum + win >= bound {
                        return None;
                    }
                }
                last = self.dirs[n - 1].end;
                break;
            }
            let path = &paths[order[k]];
            let (start, end) = oriented_ends(path, stand.0, stand.1, self.rotate);
            let leg = match k {
                0 if self.has => dist_mm(self.cursor, start),
                0 => 0.0,
                _ => dist_mm(last, start),
            };
            sum = if k == 0 { leg } else { sum + leg };
            if sum + win >= bound {
                return None;
            }
            last = end;
            if !path.points.is_empty() {
                stand = (end, true);
            }
        }
        if let (Some(to), true) = (self.to, n > 0) {
            sum += dist_mm(last, to);
        }
        Some(sum)
    }
}

pub(super) fn walk_cost(
    paths: &[Extrusion],
    order: &[usize],
    cursor: [f64; 2],
    has: bool,
    rotate: bool,
    to: Option<[f64; 2]>,
) -> f64 {
    tour_cost(
        &build_dirs(paths, order, cursor, has, rotate),
        cursor,
        has,
        to,
    )
}

pub(super) fn build_dirs(
    paths: &[Extrusion],
    order: &[usize],
    mut cursor: [f64; 2],
    mut has: bool,
    rotate: bool,
) -> Vec<TourStop> {
    let mut dirs = Vec::with_capacity(order.len());
    for &idx in order {
        let (start, end) = oriented_ends(&paths[idx], cursor, has, rotate);
        if !paths[idx].points.is_empty() {
            cursor = end;
            has = true;
        }
        dirs.push(TourStop {
            index: idx,
            start,
            end,
        });
    }
    dirs
}

pub(super) fn tour_cost(
    dirs: &[TourStop],
    cursor: [f64; 2],
    has: bool,
    to: Option<[f64; 2]>,
) -> f64 {
    if dirs.is_empty() {
        return 0.0;
    }
    let mut cost = if has {
        dist_mm(cursor, dirs[0].start)
    } else {
        0.0
    };
    for w in dirs.windows(2) {
        cost += dist_mm(w[0].end, w[1].start);
    }
    if let (Some(to), Some(last)) = (to, dirs.last()) {
        cost += dist_mm(last.end, to);
    }
    cost
}

pub(super) fn oriented_ends(
    path: &Extrusion,
    cursor: [f64; 2],
    has: bool,
    rotate_seams: bool,
) -> ([f64; 2], [f64; 2]) {
    let pts = &path.points;
    if pts.is_empty() {
        return (cursor, cursor);
    }
    if !has {
        return (pts[0], *pts.last().unwrap());
    }
    if path.is_loop() {
        if geom_closed(path) {
            let v = match path.seam {
                Seam::Fixed | Seam::Cut => pts[0],
                Seam::Corner => pts[nearest_seam(&pts[..pts.len() - 1], cursor)],
                Seam::Nearest => nearest_vertex(path, cursor),
                Seam::Edge => path.points[edge_start(path, cursor)],
            };
            return (v, v);
        }
        return (pts[0], *pts.last().unwrap());
    }
    if rotate_seams && geom_closed(path) {
        let v = nearest_vertex(path, cursor);
        return (v, v);
    }
    let a = pts[0];
    let b = *pts.last().unwrap();
    if dist2(cursor, b) + 1e-9 < dist2(cursor, a) {
        (b, a)
    } else {
        (a, b)
    }
}

pub(super) fn path_bounds(path: &Extrusion) -> ([f64; 2], [f64; 2]) {
    let mut min = [f64::INFINITY; 2];
    let mut max = [f64::NEG_INFINITY; 2];
    for p in &path.points {
        min[0] = min[0].min(p[0]);
        min[1] = min[1].min(p[1]);
        max[0] = max[0].max(p[0]);
        max[1] = max[1].max(p[1]);
    }
    if path.points.is_empty() {
        ([0.0, 0.0], [0.0, 0.0])
    } else {
        (min, max)
    }
}

pub(super) fn box_dist2(min: [f64; 2], max: [f64; 2], p: [f64; 2]) -> f64 {
    let dx = if p[0] < min[0] {
        min[0] - p[0]
    } else if p[0] > max[0] {
        p[0] - max[0]
    } else {
        0.0
    };
    let dy = if p[1] < min[1] {
        min[1] - p[1]
    } else if p[1] > max[1] {
        p[1] - max[1]
    } else {
        0.0
    };
    dx * dx + dy * dy
}

pub(super) fn approach_dist2(path: &Extrusion, cursor: [f64; 2], has: bool) -> f64 {
    if path.points.is_empty() {
        return if has { f64::MAX } else { 0.0 };
    }
    if !has {
        return 0.0;
    }
    if starts_fixed(path) {
        dist2(cursor, path.points[0])
    } else if edge_loop(path) {
        dist2(cursor, path.points[edge_start(path, cursor)])
    } else if path.is_loop() || geom_closed(path) {
        nearest_dist2(path, cursor)
    } else {
        dist2(cursor, path.points[0]).min(dist2(cursor, *path.points.last().unwrap()))
    }
}

/// A loop that starts where it was planned.
pub(super) fn starts_fixed(path: &Extrusion) -> bool {
    path.is_loop() && (path.seam == Seam::Fixed || (path.seam == Seam::Edge && !geom_closed(path)))
}

/// A closed loop that starts at any of its `edge_sites`.
pub(super) fn edge_loop(path: &Extrusion) -> bool {
    path.is_loop() && path.seam == Seam::Edge && geom_closed(path)
}

pub(super) fn nearest_dist2(path: &Extrusion, hint: [f64; 2]) -> f64 {
    let ring = ring_len(path);
    path.points
        .iter()
        .take(ring)
        .map(|p| dist2(*p, hint))
        .fold(f64::MAX, f64::min)
}

pub(super) fn nearest_vertex(path: &Extrusion, hint: [f64; 2]) -> [f64; 2] {
    let ring = ring_len(path);
    let mut best = path.points[0];
    let mut best_d = f64::MAX;
    for p in path.points.iter().take(ring) {
        let d = dist2(*p, hint);
        if d < best_d {
            best_d = d;
            best = *p;
        }
    }
    best
}

pub(super) fn ring_len(path: &Extrusion) -> usize {
    if geom_closed(path) {
        path.points.len() - 1
    } else {
        path.points.len().max(1)
    }
}

pub(super) fn geom_closed(path: &Extrusion) -> bool {
    let n = path.points.len();
    n >= 4 && dist2(path.points[0], path.points[n - 1]) < 1e-8
}

pub(super) fn apply_order(
    paths: Vec<Extrusion>,
    order: &[usize],
    mut cursor: [f64; 2],
    mut has: bool,
    rotate: bool,
) -> Vec<Extrusion> {
    let mut slots: Vec<Option<Extrusion>> = paths.into_iter().map(Some).collect();
    let mut out = Vec::with_capacity(order.len());
    for &idx in order {
        let mut path = slots[idx].take().unwrap();
        orient_path(&mut path, cursor, has, rotate);
        if let Some(end) = path.points.last().copied() {
            cursor = end;
            has = true;
        }
        out.push(path);
    }
    out
}
