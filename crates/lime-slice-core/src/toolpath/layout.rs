use super::*;

/// Test hook. Off in every slice unless a report test turns it on. SeqCst so a
/// rayon worker observes the store that happened before the travel order.
pub(super) static LEGACY_TRAVEL: AtomicBool = AtomicBool::new(false);

#[cfg(test)]
#[doc(hidden)]
pub(crate) fn set_legacy_travel_for_test(on: bool) {
    LEGACY_TRAVEL.store(on, Ordering::SeqCst);
}

/// A new infill order has to beat nearest-neighbor by this much or the group
/// stays on the old sequence. Stops float noise from rewriting G-code.
pub(super) const TRAVEL_WIN_MM: f64 = 0.05;

/// Rep points within this distance belong to one island. The link is
/// transitive, so a dense gyroid or a rectilinear field becomes one island
/// and a real gap between parts does not.
pub(super) const ISLAND_GAP_MM: f64 = 2.2;

/// `PartLayout::tour` in place.
#[cfg(test)]
pub(super) fn order_part(
    paths: &mut Vec<Extrusion>,
    solid: &[Loop],
    from: Option<[f64; 2]>,
    scarf: Option<&ScarfParams>,
) -> Option<[f64; 2]> {
    let (out, end) = PartLayout::new(std::mem::take(paths), solid).tour(from, scarf);
    *paths = out;
    end
}

/// One layer's part paths as the tour reads them: split into islands and
/// runs of one travel group, with everything the tour needs that does not
/// depend on where it starts. Every layer can be laid out at once; only the
/// tour itself has to wait for the layer below.
#[derive(Clone)]
pub struct PartLayout {
    blocks: Vec<Vec<Run>>,
    /// The gap between each pair of islands, `blocks.len()` squared, or
    /// empty for one island.
    gaps: Vec<f64>,
}

impl PartLayout {
    pub fn new(paths: Vec<Extrusion>, solid: &[Loop]) -> Self {
        if paths.is_empty() {
            return Self {
                blocks: Vec::new(),
                gaps: Vec::new(),
            };
        }
        let islands: Vec<Outline<'static>> = island_loops(solid)
            .into_iter()
            .map(Outline::owned)
            .collect();
        let mut parts: Vec<Vec<Extrusion>> = vec![Vec::new(); islands.len() + 1];
        for path in paths {
            let at = island_for(&islands, &path).unwrap_or(islands.len());
            parts[at].push(path);
        }
        let blocks: Vec<Vec<Extrusion>> = parts.into_iter().filter(|p| !p.is_empty()).collect();
        let gaps = island_gaps(&blocks);
        Self {
            blocks: blocks.into_iter().map(runs_of).collect(),
            gaps,
        }
    }

    /// Print order for the part's paths on one layer, starting at `from`,
    /// and where the tour ends.
    ///
    /// The part prints one island at a time, nearest unprinted island next,
    /// each island's paths in plan order. Printing kind by kind across the
    /// layer crossed the bed once per kind; the Baby Dragon has up to 93
    /// islands a layer, so that was 93 outer walls, then 93 inner walls, and
    /// so on.
    ///
    /// Inside an island each run of one kind is reordered: walls and closed
    /// thin walls by nearest neighbor, infill, skin, and gap fill by the best
    /// of island, Hilbert, and stripe orders. A loop with a nearest seam
    /// starts at the corner nearest the nozzle; an aligned seam stays put. A
    /// wall is scarfed as soon as its seam is final, so the next path starts
    /// from where the scarf overlap really ends.
    pub fn tour(
        self,
        from: Option<[f64; 2]>,
        scarf: Option<&ScarfParams>,
    ) -> (Vec<Extrusion>, Option<[f64; 2]>) {
        let mut out = Vec::new();
        let mut cursor = from;
        let tour = island_tour(&self.blocks, &self.gaps, cursor);
        let mut slots: Vec<Option<Vec<Run>>> = self.blocks.into_iter().map(Some).collect();
        for i in tour {
            if let Some(block) = slots[i].take() {
                cursor = order_block(block, cursor, &mut out, scarf);
            }
        }
        (out, cursor)
    }
}

/// Travel time a stacked island must save over the plan order to be used.
pub(super) const STACK_WIN_S: f64 = 0.15;

/// An island's walls in plan order, outer loops then inner, hold one stack of
/// loops for each piece of wall: a pocket in the web of a cover has its own.
/// Printed in plan order the nozzle crosses to every outer wall and then back
/// to every inner one. With two or more stacks each can print whole, outer then
/// inner, taking next the stack whose entry lies nearest where the last one
/// ended. The island is ordered both ways and takes the stacks only when its
/// travel, infill after the walls included, takes `STACK_WIN_S` less.
pub(super) fn order_block(
    block: Vec<Run>,
    cursor: Option<[f64; 2]>,
    out: &mut Vec<Extrusion>,
    scarf: Option<&ScarfParams>,
) -> Option<[f64; 2]> {
    let walls = block
        .iter()
        .take_while(|r| r.paths.first().is_some_and(|p| p.kind.is_wall()))
        .count();
    let plain_walls = block[..walls]
        .iter()
        .flat_map(|r| &r.paths)
        .all(|p| matches!(p.kind, PathKind::Outer | PathKind::Inner));
    let stacks = if plain_walls {
        wall_stacks(block[..walls].iter().flat_map(|r| &r.paths))
    } else {
        Vec::new()
    };
    if stacks.len() < 2 {
        return order_runs(block, cursor, None, out, scarf);
    }
    let nwalls: usize = block[..walls].iter().map(|r| r.paths.len()).sum();
    let all: Vec<Extrusion> = block.iter().flat_map(|r| r.paths.iter().cloned()).collect();
    let mut plain = Vec::new();
    let plain_end = order_runs(block, cursor, None, &mut plain, scarf);
    let (wall_paths, rest_paths) = all.split_at(nwalls);
    let mut slots: Vec<Option<Extrusion>> = wall_paths.iter().cloned().map(Some).collect();
    let mut left: Vec<Option<Vec<Run>>> = stacks
        .iter()
        .map(|stack| {
            let pile: Vec<Extrusion> = stack.iter().map(|&k| slots[k].take().unwrap()).collect();
            Some(runs_of(pile))
        })
        .collect();
    let mut stacked = Vec::new();
    let mut at = cursor;
    for _ in 0..left.len() {
        let entry = |stack: &Vec<Run>| at.map_or(0.0, |c| block_entry(&stack[0].paths, c));
        let next = (0..left.len())
            .filter(|&k| left[k].is_some())
            .min_by(|&a, &b| {
                entry(left[a].as_ref().unwrap())
                    .total_cmp(&entry(left[b].as_ref().unwrap()))
                    .then(a.cmp(&b))
            })
            .unwrap();
        at = order_runs(left[next].take().unwrap(), at, None, &mut stacked, scarf);
    }
    let stacked_end = order_runs(runs_of(rest_paths.to_vec()), at, None, &mut stacked, scarf);
    let wins = walk_seconds(&stacked, cursor) + STACK_WIN_S < walk_seconds(&plain, cursor);
    let (paths, end) = if wins {
        (stacked, stacked_end)
    } else {
        (plain, plain_end)
    };
    out.extend(paths);
    end
}

/// Seconds a travel of `d` mm takes at the planner's travel feed and accel,
/// from rest to rest: short hops are all acceleration, long ones cruise.
pub(super) fn hop_seconds(d: f64) -> f64 {
    const FEED: f64 = 300.0;
    const ACCEL: f64 = 5500.0;
    if d < FEED * FEED / ACCEL {
        2.0 * (d / ACCEL).sqrt()
    } else {
        d / FEED + FEED / ACCEL
    }
}

/// Seconds of travel between the paths as ordered, from `cursor`.
pub(super) fn walk_seconds(paths: &[Extrusion], cursor: Option<[f64; 2]>) -> f64 {
    let mut at = cursor;
    let mut total = 0.0;
    for path in paths {
        let (Some(first), Some(last)) = (path.points.first(), path.points.last()) else {
            continue;
        };
        if let Some(at) = at {
            total += hop_seconds(dist_mm(at, *first));
        }
        at = Some(*last);
    }
    total
}

/// The wall loops split into stacks, each a list of indexes into `walls` in
/// plan order: an outer loop, and the inner loops that follow it. An inner
/// loop is an offset of the loop it follows, so it keeps the same distance from
/// it all the way round; it joins the stack whose loop lies nearest it on
/// average, which a loop that only passes close by does not.
pub(super) fn wall_stacks<'a>(walls: impl Iterator<Item = &'a Extrusion>) -> Vec<Vec<usize>> {
    let walls: Vec<&Extrusion> = walls.collect();
    let boxes: Vec<([f64; 2], [f64; 2])> = walls.iter().map(|w| path_bounds(w)).collect();
    let box_gap = |a: usize, b: usize| {
        let dx = (boxes[a].0[0] - boxes[b].1[0])
            .max(boxes[b].0[0] - boxes[a].1[0])
            .max(0.0);
        let dy = (boxes[a].0[1] - boxes[b].1[1])
            .max(boxes[b].0[1] - boxes[a].1[1])
            .max(0.0);
        dx.hypot(dy)
    };
    let mut stacks: Vec<Vec<usize>> = Vec::new();
    for (k, wall) in walls.iter().enumerate() {
        if wall.kind != PathKind::Inner {
            stacks.push(vec![k]);
            continue;
        }
        let (mut best, mut at) = (f64::MAX, None);
        for (s, stack) in stacks.iter().enumerate() {
            for &m in stack {
                if box_gap(k, m) > 3.0 * wall.width.max(walls[m].width) {
                    continue;
                }
                let gap = mean_gap(&wall.points, &walls[m].points);
                if gap < best {
                    (best, at) = (gap, Some(s));
                }
            }
        }
        match at {
            Some(s) => stacks[s].push(k),
            None => stacks.push(vec![k]),
        }
    }
    stacks
}

/// The mean distance from the points of `a` to the polyline `b`.
pub(super) fn mean_gap(a: &[[f64; 2]], b: &[[f64; 2]]) -> f64 {
    if a.is_empty() {
        return f64::MAX;
    }
    let total: f64 = a
        .iter()
        .map(|&p| {
            b.windows(2)
                .map(|w| point_seg_dist(p, w[0], w[1]))
                .fold(f64::MAX, f64::min)
        })
        .sum();
    total / a.len() as f64
}

/// Print order for a layer's skirt and supports, starting where the nozzle
/// stands (`from`). They keep the order they were planned in, and each run
/// of one kind is reordered as in `PartLayout::tour`. Returns where the nozzle ends.
pub fn order_supports(
    paths: &mut Vec<Extrusion>,
    from: Option<[f64; 2]>,
    to: Option<[f64; 2]>,
    scarf: Option<&ScarfParams>,
) -> Option<[f64; 2]> {
    let mut out = Vec::with_capacity(paths.len());
    let end = order_runs(runs_of(std::mem::take(paths)), from, to, &mut out, scarf);
    *paths = out;
    end
}

/// The gaps between every pair of islands' walls, for `island_tour`.
pub(super) fn island_gaps(blocks: &[Vec<Extrusion>]) -> Vec<f64> {
    let n = blocks.len();
    if n <= 1 {
        return Vec::new();
    }
    let reps: Vec<Vec<[f64; 2]>> = blocks.iter().map(|b| block_reps(b)).collect();
    let mut gap = vec![0.0; n * n];
    for i in 0..n {
        for j in i + 1..n {
            let d = rep_dist2(&reps[i], &reps[j]).sqrt();
            gap[i * n + j] = d;
            gap[j * n + i] = d;
        }
    }
    gap
}

/// Visit order for the part's islands. Nearest-neighbor from the cursor, then
/// 2-opt on the gaps between island outlines: nearest-neighbor alone leaves
/// islands behind and crosses the layer to come back for them.
pub(super) fn island_tour(
    blocks: &[Vec<Run>],
    gap: &[f64],
    cursor: Option<[f64; 2]>,
) -> Vec<usize> {
    let n = blocks.len();
    if n <= 1 {
        return (0..n).collect();
    }
    let start: Vec<f64> = blocks
        .iter()
        .map(|b| cursor.map_or(0.0, |c| block_entry(&b[0].paths, c).sqrt()))
        .collect();
    let mut tour = Vec::with_capacity(n);
    let mut used = vec![false; n];
    let mut at: Option<usize> = None;
    for _ in 0..n {
        let next = (0..n)
            .filter(|&j| !used[j])
            .min_by(|&a, &b| {
                let da = at.map_or(start[a], |i| gap[i * n + a]);
                let db = at.map_or(start[b], |i| gap[i * n + b]);
                da.total_cmp(&db).then(a.cmp(&b))
            })
            .unwrap();
        used[next] = true;
        tour.push(next);
        at = Some(next);
    }
    let edge = |from: Option<usize>, to: usize| from.map_or(start[to], |i| gap[i * n + to]);
    for _ in 0..32 {
        let mut improved = false;
        for i in 0..n - 1 {
            let before = if i == 0 { None } else { Some(tour[i - 1]) };
            for j in i + 1..n {
                let after = tour.get(j + 1).copied();
                let old = edge(before, tour[i]) + after.map_or(0.0, |k| gap[tour[j] * n + k]);
                let new = edge(before, tour[j]) + after.map_or(0.0, |k| gap[tour[i] * n + k]);
                if new + 1e-6 < old {
                    tour[i..=j].reverse();
                    improved = true;
                }
            }
        }
        if !improved {
            break;
        }
    }
    tour
}

/// Points around an island: its first run of paths, which is its walls.
pub(super) fn block_reps(block: &[Extrusion]) -> Vec<[f64; 2]> {
    let Some(group) = block.first().map(Extrusion::travel_group) else {
        return Vec::new();
    };
    block
        .iter()
        .take_while(|p| p.travel_group() == group)
        .flat_map(rep_points)
        .collect()
}

/// Decide the travel into every path of an ordered layer: straight, combed
/// through the inset of the island it stays in, or retracted. `from` is where
/// the previous layer ended.
pub fn comb_layer(
    paths: &mut [Extrusion],
    solid: &[Loop],
    combing: bool,
    inset: f64,
    from: Option<[f64; 2]>,
) {
    let comb = Combing::new(solid, combing, inset);
    let mut cursor = from;
    for path in paths.iter_mut() {
        let Some(start) = path.points.first().copied() else {
            continue;
        };
        if let Some(from) = cursor {
            path.take_comb(comb_between(&comb, from, start));
        }
        cursor = path.points.last().copied();
    }
}

/// Retract on every open-air travel into or out of a support that does not
/// stay on solid support, whatever its length. An open-air travel otherwise
/// retracts only past `OPEN_AIR_RETRACT_MIN_MM`, so the nozzle oozes a thread
/// across every gap between supports shorter than that, and across the open
/// cells of a sparse grid, and catches the threads on later layers. A step
/// of two line widths or less, a travel inside the dense interface
/// `regions`, and one within a tree branch of `disks` keep their rule. Run
/// after `comb_layer`, from the same `from`.
pub fn retract_off_supports(
    paths: &mut [Extrusion],
    from: Option<[f64; 2]>,
    regions: &[Loop],
    disks: &[Disk],
    line_width: f64,
) {
    let grown = if regions.is_empty() {
        Vec::new()
    } else {
        offset_loops(regions, line_width * 0.5)
    };
    let area = Outline::owned(grown);
    let on_one = |a: [f64; 2], b: [f64; 2]| {
        if dist2(a, b) <= 4.0 * line_width * line_width {
            return true;
        }
        if area.box_holds(a) && area.box_holds(b) && area.contains(a) && area.segment_inside(a, b) {
            return true;
        }
        disks.iter().any(|d| {
            let reach = (d.r + line_width).powi(2);
            dist2(a, d.xy) <= reach && dist2(b, d.xy) <= reach
        })
    };
    let mut cursor = from;
    let mut after_support = false;
    for path in paths.iter_mut() {
        let Some(start) = path.points.first().copied() else {
            continue;
        };
        let support = matches!(path.kind, PathKind::Support | PathKind::SupportInterface);
        if let Some(at) = cursor {
            if path.travel_in == TravelIn::Open && (support || after_support) && !on_one(at, start)
            {
                path.travel_in = TravelIn::Blocked;
            }
        }
        cursor = path.points.last().copied();
        after_support = support;
    }
}

/// The island holding `path`: the first of its start, middle, and end that
/// lies inside one, else the island whose box is nearest its start.
pub(super) fn island_for(islands: &[Outline], path: &Extrusion) -> Option<usize> {
    let pts = &path.points;
    let n = pts.len();
    if n == 0 || islands.is_empty() {
        return None;
    }
    let inside = |p: [f64; 2]| {
        islands
            .iter()
            .position(|isl| isl.box_holds(p) && isl.contains(p))
    };
    [0, n / 2, n - 1]
        .into_iter()
        .find_map(|i| inside(pts[i]))
        .or_else(|| {
            (0..islands.len()).min_by(|&a, &b| {
                let da = islands[a]
                    .bounds
                    .map_or(f64::MAX, |(mn, mx)| box_dist2(mn, mx, pts[0]));
                let db = islands[b]
                    .bounds
                    .map_or(f64::MAX, |(mn, mx)| box_dist2(mn, mx, pts[0]));
                da.total_cmp(&db)
            })
        })
}

pub(super) fn block_entry(block: &[Extrusion], cursor: [f64; 2]) -> f64 {
    let Some(group) = block.first().map(Extrusion::travel_group) else {
        return f64::MAX;
    };
    block
        .iter()
        .take_while(|p| p.travel_group() == group)
        .map(|p| approach_dist2(p, cursor, true))
        .fold(f64::MAX, f64::min)
}
