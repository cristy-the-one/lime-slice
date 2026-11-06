use super::fuzzy::fuzz_settled;
use super::polish::{
    approach_dist2, edge_loop, geom_closed, oriented_ends, ring_len, starts_fixed,
};
use super::scarf::{scarf_one, ScarfParams};
use super::seams::{dist2, edge_sites, orient_path};
use super::Extrusion;

/// `grid` is `approach_grid(paths)`.
pub(super) fn legacy_nn_indices(
    paths: &[Extrusion],
    grid: Option<&ApproachGrid>,
    mut cursor: [f64; 2],
    mut has: bool,
) -> Vec<usize> {
    let n = paths.len();
    let mut pending: Vec<usize> = (0..n).collect();
    let mut pos: Vec<usize> = (0..n).collect();
    let mut out = Vec::with_capacity(n);
    while !pending.is_empty() {
        let best_i = pending_winner(paths, &pending, &pos, grid, cursor, has);
        let idx = pending.swap_remove(best_i);
        pos[idx] = usize::MAX;
        if best_i < pending.len() {
            pos[pending[best_i]] = best_i;
        }
        if !paths[idx].points.is_empty() {
            cursor = oriented_ends(&paths[idx], cursor, has, false).1;
            has = true;
        }
        out.push(idx);
    }
    out
}

/// Groups smaller than this stay on the linear scan. The grid pays for itself
/// once a layer's infill is hundreds of paths, which is where the scan was
/// quadratic.
pub(super) const NN_LINEAR_LIMIT: usize = 48;

pub(super) const NN_CELL_MM: f64 = 2.0;

/// The grid nearest-neighbor ordering of `paths` searches, when there are
/// enough of them to pay for it.
pub(super) fn approach_grid(paths: &[Extrusion]) -> Option<ApproachGrid> {
    (paths.len() > NN_LINEAR_LIMIT)
        .then(|| ApproachGrid::build(paths))
        .flatten()
}

/// Endpoints (or seam vertices) of the paths still waiting to print.
///
/// A query walks outward from the nozzle until the square already searched is
/// closer than any cell outside it, so the winner is the same path the linear
/// scan would pick: smallest approach distance, then the earliest slot in
/// `pending`. The cells are one dense array over the sites' box, each cell's
/// sites stored together.
#[derive(Clone)]
pub(super) struct ApproachGrid {
    cell: f64,
    min_c: [i64; 2],
    max_c: [i64; 2],
    /// Cells across the box.
    cols: usize,
    /// Where each cell's sites start in `sites`, row by row, and one past
    /// the last.
    starts: Vec<u32>,
    sites: Vec<(usize, [f64; 2])>,
}

/// Most cells a grid may span. A run spread wider than this takes the linear
/// scan, which picks the same paths.
pub(super) const NN_GRID_MAX_CELLS: i64 = 1 << 22;

impl ApproachGrid {
    fn build(paths: &[Extrusion]) -> Option<Self> {
        let cell = NN_CELL_MM;
        let mut keyed: Vec<((i64, i64), usize, [f64; 2])> = Vec::new();
        let mut min_c = [i64::MAX; 2];
        let mut max_c = [i64::MIN; 2];
        for (id, path) in paths.iter().enumerate() {
            for_each_approach_site(path, |p| {
                let key = cell_key(p, cell);
                min_c[0] = min_c[0].min(key.0);
                min_c[1] = min_c[1].min(key.1);
                max_c[0] = max_c[0].max(key.0);
                max_c[1] = max_c[1].max(key.1);
                keyed.push((key, id, p));
            });
        }
        if min_c[0] == i64::MAX {
            min_c = [0; 2];
            max_c = [0; 2];
        }
        let cols = max_c[0].checked_sub(min_c[0])?.checked_add(1)?;
        let rows = max_c[1].checked_sub(min_c[1])?.checked_add(1)?;
        if cols.checked_mul(rows)? > NN_GRID_MAX_CELLS || keyed.len() >= u32::MAX as usize {
            return None;
        }
        let (cols, rows) = (cols as usize, rows as usize);
        let slot =
            |(gx, gy): (i64, i64)| (gy - min_c[1]) as usize * cols + (gx - min_c[0]) as usize;
        let mut starts = vec![0u32; cols * rows + 1];
        for (key, _, _) in &keyed {
            starts[slot(*key) + 1] += 1;
        }
        for k in 1..starts.len() {
            starts[k] += starts[k - 1];
        }
        let mut fill = starts.clone();
        let mut sites = vec![(0usize, [0.0; 2]); keyed.len()];
        for (key, id, p) in keyed {
            let at = &mut fill[slot(key)];
            sites[*at as usize] = (id, p);
            *at += 1;
        }
        Some(Self {
            cell,
            min_c,
            max_c,
            cols,
            starts,
            sites,
        })
    }

    /// The sites in cell `(gx, gy)`, which lies inside the box.
    fn cell_sites(&self, gx: i64, gy: i64) -> &[(usize, [f64; 2])] {
        let k = (gy - self.min_c[1]) as usize * self.cols + (gx - self.min_c[0]) as usize;
        &self.sites[self.starts[k] as usize..self.starts[k + 1] as usize]
    }

    /// Index into `pending` of the path the linear scan would print next.
    /// `pos[id]` is that path's slot, or `usize::MAX` once it has been printed.
    fn winner(&self, pos: &[usize], cursor: [f64; 2]) -> usize {
        let (cx, cy) = cell_key(cursor, self.cell);
        let (mut best_d, mut best_i) = (f64::MAX, 0usize);
        let mut ring = 0i64;
        let visit = |gx: i64, gy: i64, best_d: &mut f64, best_i: &mut usize| {
            for &(id, p) in self.cell_sites(gx, gy) {
                let at = pos[id];
                if at == usize::MAX {
                    continue;
                }
                let d = dist2(cursor, p);
                // Equal distances keep the earlier pending slot, which
                // is what `d < best_d` does on a front-to-back scan, so
                // the order cells and sites are visited in never matters.
                if d < *best_d || (d == *best_d && at < *best_i) {
                    *best_d = d;
                    *best_i = at;
                }
            }
        };
        let [x_lo, y_lo] = self.min_c;
        let [x_hi, y_hi] = self.max_c;
        loop {
            if ring > 0 {
                let gap = searched_gap(cursor, cx, cy, ring - 1, self.cell);
                if best_d < gap * gap || searched_covers(self, cx, cy, ring - 1) {
                    break;
                }
            }
            // The ring's cells inside the box: its top and bottom rows whole,
            // then its two sides between them.
            let r = ring;
            let (x0, x1, y0, y1) = (cx - r, cx + r, cy - r, cy + r);
            for gy in [y0, y1] {
                if (y_lo..=y_hi).contains(&gy) {
                    for gx in x0.max(x_lo)..=x1.min(x_hi) {
                        visit(gx, gy, &mut best_d, &mut best_i);
                    }
                }
                if r == 0 {
                    break;
                }
            }
            for gx in [x0, x1] {
                if r > 0 && (x_lo..=x_hi).contains(&gx) {
                    for gy in (y0 + 1).max(y_lo)..=(y1 - 1).min(y_hi) {
                        visit(gx, gy, &mut best_d, &mut best_i);
                    }
                }
            }
            if searched_covers(self, cx, cy, ring) {
                break;
            }
            ring += 1;
            if ring > 100_000 {
                break;
            }
        }
        if best_d.is_finite() {
            best_i
        } else {
            0
        }
    }
}

pub(super) fn cell_key(p: [f64; 2], cell: f64) -> (i64, i64) {
    ((p[0] / cell).floor() as i64, (p[1] / cell).floor() as i64)
}

/// Distance from `cursor` to the outside of the square of cells within
/// Chebyshev `ring` of `(cx, cy)`. Points outside that square are at least
/// this far away.
pub(super) fn searched_gap(cursor: [f64; 2], cx: i64, cy: i64, ring: i64, cell: f64) -> f64 {
    let minx = (cx - ring) as f64 * cell;
    let maxx = (cx + ring + 1) as f64 * cell;
    let miny = (cy - ring) as f64 * cell;
    let maxy = (cy + ring + 1) as f64 * cell;
    let dx = (cursor[0] - minx).min(maxx - cursor[0]);
    let dy = (cursor[1] - miny).min(maxy - cursor[1]);
    dx.min(dy).max(0.0)
}

pub(super) fn searched_covers(grid: &ApproachGrid, cx: i64, cy: i64, ring: i64) -> bool {
    cx - ring <= grid.min_c[0]
        && cy - ring <= grid.min_c[1]
        && cx + ring >= grid.max_c[0]
        && cy + ring >= grid.max_c[1]
}

/// Sites `approach_dist2` measures. Empty paths contribute none.
pub(super) fn for_each_approach_site(path: &Extrusion, mut f: impl FnMut([f64; 2])) {
    if path.points.is_empty() {
        return;
    }
    if starts_fixed(path) {
        f(path.points[0]);
        return;
    }
    if edge_loop(path) {
        let ring = &path.points[..path.points.len() - 1];
        for i in edge_sites(ring) {
            f(ring[i]);
        }
        return;
    }
    if path.is_loop() || geom_closed(path) {
        let ring = ring_len(path);
        for p in path.points.iter().take(ring) {
            f(*p);
        }
        return;
    }
    f(path.points[0]);
    let last = *path.points.last().unwrap();
    if dist2(path.points[0], last) > 0.0 {
        f(last);
    }
}

pub(super) fn pending_winner(
    paths: &[Extrusion],
    pending: &[usize],
    pos: &[usize],
    grid: Option<&ApproachGrid>,
    cursor: [f64; 2],
    has: bool,
) -> usize {
    match grid {
        Some(grid) if has && pending.len() > NN_LINEAR_LIMIT => grid.winner(pos, cursor),
        _ => pending_winner_linear(paths, pending, cursor, has),
    }
}

pub(super) fn pending_winner_linear(
    paths: &[Extrusion],
    pending: &[usize],
    cursor: [f64; 2],
    has: bool,
) -> usize {
    pending_winner_scored(pending, cursor, has, |idx| Some(&paths[idx]))
}

pub(super) fn pending_winner_slots(
    slots: &[Option<Extrusion>],
    pending: &[usize],
    pos: &[usize],
    grid: Option<&ApproachGrid>,
    cursor: [f64; 2],
    has: bool,
) -> usize {
    match grid {
        Some(grid) if has && pending.len() > NN_LINEAR_LIMIT => grid.winner(pos, cursor),
        _ => pending_winner_scored(pending, cursor, has, |idx| slots[idx].as_ref()),
    }
}

pub(super) fn pending_winner_scored<'a>(
    pending: &[usize],
    cursor: [f64; 2],
    has: bool,
    path_at: impl Fn(usize) -> Option<&'a Extrusion>,
) -> usize {
    let mut best_i = 0usize;
    let mut best_d = f64::MAX;
    for (i, &idx) in pending.iter().enumerate() {
        let Some(path) = path_at(idx) else {
            continue;
        };
        if path.points.is_empty() {
            continue;
        }
        let d = approach_dist2(path, cursor, has);
        if d < best_d {
            best_d = d;
            best_i = i;
        }
    }
    best_i
}

/// Nearest neighbor that seats each path as it is chosen, so the next choice
/// is measured from where that path really ends, scarf overlap included.
/// `grid` is `approach_grid(&paths)`.
pub(super) fn order_nearest(
    paths: Vec<Extrusion>,
    grid: Option<&ApproachGrid>,
    mut cursor: [f64; 2],
    mut has: bool,
    scarf: Option<&ScarfParams>,
) -> Vec<Extrusion> {
    let n = paths.len();
    let mut slots: Vec<Option<Extrusion>> = paths.into_iter().map(Some).collect();
    let mut pending: Vec<usize> = (0..n).collect();
    let mut pos: Vec<usize> = (0..n).collect();
    let mut out = Vec::with_capacity(n);
    while !pending.is_empty() {
        let best_i = pending_winner_slots(&slots, &pending, &pos, grid, cursor, has);
        let id = pending.swap_remove(best_i);
        pos[id] = usize::MAX;
        if best_i < pending.len() {
            pos[pending[best_i]] = best_i;
        }
        let mut path = slots[id].take().unwrap();
        orient_path(&mut path, cursor, has, false);
        if let Some(params) = scarf {
            scarf_one(&mut path, params);
        }
        fuzz_settled(&mut path);
        if let Some(end) = path.points.last() {
            cursor = *end;
            has = true;
        }
        out.push(path);
    }
    out
}

pub(super) fn dist_mm(a: [f64; 2], b: [f64; 2]) -> f64 {
    dist2(a, b).sqrt()
}
