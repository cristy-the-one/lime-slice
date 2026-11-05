use super::*;

/// The tour `untangle` improves: the path at each position, where it is entered
/// and left, and whether it runs from its last point.
pub(super) struct Tour<'a> {
    pub(super) order: &'a mut Vec<usize>,
    pub(super) ins: &'a mut Vec<[f64; 2]>,
    pub(super) outs: &'a mut Vec<[f64; 2]>,
    pub(super) flips: &'a mut Vec<bool>,
}

/// Shortest saving, in mm of travel, that moves a short run of paths.
pub(super) const RELOCATE_MIN_MM: f64 = 0.5;

/// How far a lower bound must clear a test before `relocate` skips the
/// exact cost: far above the rounding of sums of a few bed-sized distances.
pub(super) const RELOCATE_SKIP_MM: f64 = 1e-6;

/// The larger of the axis steps from `a` to `b`, never more than the distance.
pub(super) fn chebyshev(a: [f64; 2], b: [f64; 2]) -> f64 {
    (a[0] - b[0]).abs().max((a[1] - b[1]).abs())
}

impl Tour<'_> {
    /// Or-opt: takes one to three paths in a row out and puts them back between
    /// two other stops, either way round, when that shortens the travel by at
    /// least `RELOCATE_MIN_MM`. 2-opt cannot make this move, since it only
    /// reverses a stretch of two paths or more. Returns whether anything moved.
    pub(super) fn relocate(&mut self, cursor: [f64; 2], has: bool, to: Option<[f64; 2]>) -> bool {
        let n = self.order.len();
        let link = |from: Option<[f64; 2]>, to: [f64; 2]| from.map_or(0.0, |f| dist_mm(f, to));
        let mut moved = false;
        for len in 1..=3usize {
            let mut i = 0;
            while i + len <= n {
                let before = if i == 0 {
                    has.then_some(cursor)
                } else {
                    Some(self.outs[i - 1])
                };
                let after = self.ins.get(i + len).copied().or(to);
                let mut saved = link(before, self.ins[i]);
                if let Some(a) = after {
                    saved += dist_mm(self.outs[i + len - 1], a);
                    if let Some(b) = before {
                        saved -= dist_mm(b, a);
                    }
                }
                // `rest` is the tour without the run; a run goes back before
                // `rest(pos)`, or after the last stop when `pos` is `n - len`.
                let rest = |k: usize| if k < i { k } else { k + len };
                let mut best: Option<(f64, usize, bool)> = None;
                for pos in i.saturating_sub(UNTANGLE_WINDOW)..=(i + UNTANGLE_WINDOW).min(n - len) {
                    let prev = if pos == 0 {
                        has.then_some(cursor)
                    } else {
                        Some(self.outs[rest(pos - 1)])
                    };
                    let next = (pos < n - len).then(|| self.ins[rest(pos)]).or(to);
                    let gap = prev.zip(next).map(|(p, q)| dist_mm(p, q));
                    for reversed in [false, true] {
                        // Back where it was, the same way round, is no move.
                        if pos == i && !reversed {
                            continue;
                        }
                        let (head, tail) = if reversed {
                            (self.outs[i + len - 1], self.ins[i])
                        } else {
                            (self.ins[i], self.outs[i + len - 1])
                        };
                        // A distance is at least its larger axis step, so
                        // this bounds the cost from below without a root.
                        // The margin dwarfs the rounding, so a skipped place
                        // is one the test below would turn down too.
                        let low = prev.map_or(0.0, |p| chebyshev(p, head))
                            + next.map_or(0.0, |q| chebyshev(tail, q))
                            - gap.unwrap_or(0.0);
                        if low >= saved - RELOCATE_MIN_MM + RELOCATE_SKIP_MM
                            || best.is_some_and(|b| low >= b.0 + RELOCATE_SKIP_MM)
                        {
                            continue;
                        }
                        let mut cost = link(prev, head);
                        if let Some(q) = next {
                            cost += dist_mm(tail, q);
                            if let Some(gap) = gap {
                                cost -= gap;
                            }
                        }
                        if cost + RELOCATE_MIN_MM < saved && best.is_none_or(|b| cost < b.0) {
                            best = Some((cost, pos, reversed));
                        }
                    }
                }
                if let Some((_, pos, reversed)) = best {
                    let mut run: Vec<usize> = (i..i + len).collect();
                    if reversed {
                        run.reverse();
                    }
                    let mut stops: Vec<(usize, bool)> =
                        (0..n - len).map(|k| (rest(k), false)).collect();
                    for (offset, &k) in run.iter().enumerate() {
                        stops.insert(pos + offset, (k, reversed));
                    }
                    let take = |v: &Vec<[f64; 2]>, flip_it: bool, k: usize, w: &Vec<[f64; 2]>| {
                        if flip_it {
                            w[k]
                        } else {
                            v[k]
                        }
                    };
                    let ins = stops
                        .iter()
                        .map(|&(k, f)| take(self.ins, f, k, self.outs))
                        .collect();
                    let outs = stops
                        .iter()
                        .map(|&(k, f)| take(self.outs, f, k, self.ins))
                        .collect();
                    let flips = stops.iter().map(|&(k, f)| self.flips[k] != f).collect();
                    let order = stops.iter().map(|&(k, _)| self.order[k]).collect();
                    *self.ins = ins;
                    *self.outs = outs;
                    *self.flips = flips;
                    *self.order = order;
                    moved = true;
                }
                i += 1;
            }
        }
        moved
    }
}

pub(super) fn apply_flips(
    paths: Vec<Extrusion>,
    order: &[usize],
    flips: &[bool],
) -> Vec<Extrusion> {
    let mut slots: Vec<Option<Extrusion>> = paths.into_iter().map(Some).collect();
    order
        .iter()
        .zip(flips)
        .map(|(&idx, &flip)| {
            let mut path = slots[idx].take().unwrap();
            if flip {
                reverse_open(&mut path);
            }
            path
        })
        .collect()
}

pub(super) struct Choice {
    pub(super) order: Vec<usize>,
    pub(super) cost: f64,
    pub(super) rotate: bool,
}

pub(super) fn consider(
    paths: &[Extrusion],
    order: Vec<usize>,
    cursor: [f64; 2],
    has: bool,
    closed: bool,
    to: Option<[f64; 2]>,
    best: &mut Choice,
) {
    if !is_perm(&order, paths.len()) {
        return;
    }
    for rotate in [false, true] {
        if rotate && !closed {
            continue;
        }
        let cost = walk_cost(paths, &order, cursor, has, rotate, to);
        if cost + TRAVEL_WIN_MM < best.cost {
            best.cost = cost;
            best.order = order.clone();
            best.rotate = rotate;
        }
    }
}

pub(super) fn is_perm(order: &[usize], n: usize) -> bool {
    if order.len() != n {
        return false;
    }
    let mut seen = vec![false; n];
    for &i in order {
        if i >= n || seen[i] {
            return false;
        }
        seen[i] = true;
    }
    true
}

/// Greedy nearest neighbor. Open paths may flip; closed paths score the nearest
/// vertex, which is the seam a later rotate will use.
pub(super) fn nn_order(paths: &[Extrusion], cursor: [f64; 2], has: bool) -> Vec<usize> {
    let pool: Vec<usize> = (0..paths.len()).collect();
    nn_pool(paths, &pool, cursor, has)
}

pub(super) fn nn_pool(
    paths: &[Extrusion],
    pool: &[usize],
    mut cursor: [f64; 2],
    mut has: bool,
) -> Vec<usize> {
    let bounds: Vec<([f64; 2], [f64; 2])> = paths.iter().map(path_bounds).collect();
    let mut pending = pool.to_vec();
    let mut out = Vec::with_capacity(pending.len());
    while !pending.is_empty() {
        let mut best_at = 0usize;
        let mut best_d = f64::MAX;
        let mut best_idx = usize::MAX;
        for (i, &idx) in pending.iter().enumerate() {
            if has && box_dist2(bounds[idx].0, bounds[idx].1, cursor) >= best_d {
                continue;
            }
            let d = approach_dist2(&paths[idx], cursor, has);
            if d < best_d - 1e-12 || ((d - best_d).abs() <= 1e-12 && idx < best_idx) {
                best_d = d;
                best_at = i;
                best_idx = idx;
            }
        }
        let idx = pending.swap_remove(best_at);
        if !paths[idx].points.is_empty() {
            cursor = oriented_ends(&paths[idx], cursor, has, true).1;
            has = true;
        }
        out.push(idx);
    }
    out
}

pub(super) fn island_order(
    paths: &[Extrusion],
    comps: &[Vec<usize>],
    mut cursor: [f64; 2],
    mut has: bool,
) -> Vec<usize> {
    let mut remaining: Vec<Vec<usize>> = comps.to_vec();
    let mut out = Vec::with_capacity(paths.len());
    while !remaining.is_empty() {
        let mut best = 0usize;
        let mut best_d = f64::MAX;
        let mut best_key = usize::MAX;
        for (ci, comp) in remaining.iter().enumerate() {
            let key = comp[0];
            let d = comp
                .iter()
                .map(|&idx| approach_dist2(&paths[idx], cursor, has))
                .fold(f64::MAX, f64::min);
            if d < best_d - 1e-12 || ((d - best_d).abs() <= 1e-12 && key < best_key) {
                best_d = d;
                best = ci;
                best_key = key;
            }
        }
        let comp = remaining.swap_remove(best);
        let sub = nn_pool(paths, &comp, cursor, has);
        for &idx in &sub {
            if !paths[idx].points.is_empty() {
                cursor = oriented_ends(&paths[idx], cursor, has, true).1;
                has = true;
            }
        }
        out.extend(sub);
    }
    out
}

pub(super) fn islands(paths: &[Extrusion]) -> Vec<Vec<usize>> {
    let n = paths.len();
    let reps: Vec<Vec<[f64; 2]>> = paths.iter().map(rep_points).collect();
    let mut parent: Vec<usize> = (0..n).collect();
    let gap2 = ISLAND_GAP_MM * ISLAND_GAP_MM;
    let cell = ISLAND_GAP_MM;
    let key = |p: [f64; 2]| ((p[0] / cell).floor() as i64, (p[1] / cell).floor() as i64);
    let mut grid: HashMap<(i64, i64), Vec<usize>> = HashMap::new();
    for (i, pts) in reps.iter().enumerate() {
        for p in pts {
            grid.entry(key(*p)).or_default().push(i);
        }
    }
    for i in 0..n {
        for p in &reps[i] {
            let (cx, cy) = key(*p);
            for gx in cx - 1..=cx + 1 {
                for gy in cy - 1..=cy + 1 {
                    let Some(ids) = grid.get(&(gx, gy)) else {
                        continue;
                    };
                    for &j in ids {
                        if j <= i {
                            continue;
                        }
                        let ri = find(&mut parent, i);
                        let rj = find(&mut parent, j);
                        if ri == rj {
                            continue;
                        }
                        if rep_dist2(&reps[i], &reps[j]) <= gap2 {
                            unite(&mut parent, i, j);
                        }
                    }
                }
            }
        }
    }
    let mut groups: HashMap<usize, Vec<usize>> = HashMap::new();
    for i in 0..n {
        groups.entry(find(&mut parent, i)).or_default().push(i);
    }
    let mut comps: Vec<Vec<usize>> = groups.into_values().collect();
    for comp in &mut comps {
        comp.sort_unstable();
    }
    comps.sort_by_key(|comp| comp[0]);
    comps
}

pub(super) fn find(parent: &mut [usize], mut i: usize) -> usize {
    while parent[i] != i {
        parent[i] = parent[parent[i]];
        i = parent[i];
    }
    i
}

pub(super) fn unite(parent: &mut [usize], a: usize, b: usize) {
    let mut a = find(parent, a);
    let mut b = find(parent, b);
    if a == b {
        return;
    }
    if a > b {
        std::mem::swap(&mut a, &mut b);
    }
    parent[b] = a;
}

/// `order`, the paths along a Hilbert curve, started at the path nearest the
/// cursor and walked whichever way travels less.
pub(super) fn hilbert_order(
    paths: &[Extrusion],
    order: Vec<usize>,
    cursor: [f64; 2],
    has: bool,
) -> Vec<usize> {
    let n = order.len();
    if !has || n == 0 {
        return order;
    }
    let start = order
        .iter()
        .enumerate()
        .min_by(|(_, ia), (_, ib)| {
            approach_dist2(&paths[**ia], cursor, true)
                .total_cmp(&approach_dist2(&paths[**ib], cursor, true))
                .then((**ia).cmp(*ib))
        })
        .map(|(pos, _)| pos)
        .unwrap_or(0);
    let mut fwd = Vec::with_capacity(n);
    fwd.extend_from_slice(&order[start..]);
    fwd.extend_from_slice(&order[..start]);
    let mut rev = Vec::with_capacity(n);
    for k in 0..n {
        rev.push(order[(start + n - k) % n]);
    }
    let cf = walk_cost(paths, &fwd, cursor, has, true, None);
    let cr = walk_cost(paths, &rev, cursor, has, true, None);
    if cr + 1e-6 < cf {
        rev
    } else {
        fwd
    }
}

/// The paths sorted by where their centroids fall on a Hilbert curve over
/// the run's box.
pub(super) fn hilbert_curve(paths: &[Extrusion]) -> Vec<usize> {
    let n = paths.len();
    if n == 0 {
        return Vec::new();
    }
    let cents: Vec<[f64; 2]> = paths.iter().map(centroid).collect();
    let mut min = [f64::INFINITY; 2];
    let mut max = [f64::NEG_INFINITY; 2];
    for c in &cents {
        min[0] = min[0].min(c[0]);
        min[1] = min[1].min(c[1]);
        max[0] = max[0].max(c[0]);
        max[1] = max[1].max(c[1]);
    }
    let span = (max[0] - min[0]).max(max[1] - min[1]).max(1e-9);
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&a, &b| {
        hilbert_key(cents[a], min, span)
            .cmp(&hilbert_key(cents[b], min, span))
            .then(a.cmp(&b))
    });
    order
}

pub(super) fn hilbert_key(p: [f64; 2], min: [f64; 2], span: f64) -> u64 {
    let x = (((p[0] - min[0]) / span).clamp(0.0, 1.0) * 65535.0).round() as u32;
    let y = (((p[1] - min[1]) / span).clamp(0.0, 1.0) * 65535.0).round() as u32;
    hilbert_d(x.min(65535), y.min(65535))
}

pub(super) fn hilbert_d(mut x: u32, mut y: u32) -> u64 {
    let mut d = 0u64;
    let mut s = 1u32 << 15;
    while s > 0 {
        let rx = u32::from((x & s) > 0);
        let ry = u32::from((y & s) > 0);
        d += u64::from(s) * u64::from(s) * u64::from((3 * rx) ^ ry);
        if ry == 0 {
            if rx == 1 {
                x = 65535 - x;
                y = 65535 - y;
            }
            std::mem::swap(&mut x, &mut y);
        }
        s >>= 1;
    }
    d
}
