use super::*;

/// One run of a travel group in an island, in plan order, with what ordering
/// it reads from the paths alone.
#[derive(Clone)]
pub(super) struct Run {
    pub(super) paths: Vec<Extrusion>,
    grid: Option<ApproachGrid>,
    /// Set on a run `order_infill` sorts.
    infill: Option<InfillLayout>,
}

/// What `order_infill` reads from a run's paths alone.
#[derive(Clone)]
pub(super) struct InfillLayout {
    closed: bool,
    comps: Vec<Vec<usize>>,
    stripes: Vec<Vec<usize>>,
    hilbert: Vec<usize>,
}

/// `block` split into runs of one travel group, each laid out.
pub(super) fn runs_of(block: Vec<Extrusion>) -> Vec<Run> {
    let mut runs = Vec::new();
    let mut group: Vec<Extrusion> = Vec::new();
    for path in block {
        if group
            .last()
            .is_some_and(|last| last.travel_group() != path.travel_group())
        {
            runs.push(Run::new(std::mem::take(&mut group)));
        }
        group.push(path);
    }
    if !group.is_empty() {
        runs.push(Run::new(group));
    }
    runs
}

impl Run {
    fn new(paths: Vec<Extrusion>) -> Self {
        let infill = paths
            .first()
            .is_some_and(|p| infill_travel_group(p.travel_group()))
            && paths.len() >= 2;
        let infill = infill.then(|| {
            let sample = crate::inner_prof::Sample::start();
            let comps = islands(&paths);
            sample.order_islands(paths.len() as u64);
            InfillLayout {
                closed: paths.iter().any(geom_closed),
                comps,
                stripes: stripe_orders(&paths),
                hilbert: hilbert_curve(&paths),
            }
        });
        Self {
            grid: approach_grid(&paths),
            paths,
            infill,
        }
    }
}

/// Order each run of a block from the cursor, in turn.
///
/// `to` is where the nozzle goes next: the last run ends near it.
pub(super) fn order_runs(
    block: Vec<Run>,
    mut cursor: Option<[f64; 2]>,
    to: Option<[f64; 2]>,
    out: &mut Vec<Extrusion>,
    scarf: Option<&ScarfParams>,
) -> Option<[f64; 2]> {
    let last = block.len().saturating_sub(1);
    for (k, run) in block.into_iter().enumerate() {
        cursor = order_run(run, cursor, if k == last { to } else { None }, out, scarf);
    }
    cursor
}

pub(super) fn order_run(
    run: Run,
    cursor: Option<[f64; 2]>,
    to: Option<[f64; 2]>,
    out: &mut Vec<Extrusion>,
    scarf: Option<&ScarfParams>,
) -> Option<[f64; 2]> {
    let (at, has) = (cursor.unwrap_or([0.0, 0.0]), cursor.is_some());
    let Run {
        paths,
        grid,
        infill,
    } = run;
    let n = paths.len() as u64;
    let ordered = match infill.filter(|_| !LEGACY_TRAVEL.load(Ordering::SeqCst)) {
        Some(layout) => {
            let sample = crate::inner_prof::Sample::start();
            let ordered = order_infill(paths, layout, grid, at, has, to);
            sample.order_infill(n);
            ordered
        }
        None => {
            let sample = crate::inner_prof::Sample::start();
            let ordered = order_nearest(paths, grid.as_ref(), at, has, scarf);
            sample.order_nearest(n);
            ordered
        }
    };
    let mut end = cursor;
    for path in ordered {
        if let Some(last) = path.points.last() {
            end = Some(*last);
        }
        out.push(path);
    }
    end
}

pub(super) fn infill_travel_group(kind: PathKind) -> bool {
    matches!(
        kind,
        PathKind::GapFill
            | PathKind::Infill
            | PathKind::Sparse
            | PathKind::Solid
            | PathKind::Top
            | PathKind::Bridge
            | PathKind::Support
            | PathKind::SupportInterface
            | PathKind::Ironing
    )
}

pub(super) fn order_infill(
    paths: Vec<Extrusion>,
    layout: InfillLayout,
    grid: Option<ApproachGrid>,
    cursor: [f64; 2],
    has: bool,
    to: Option<[f64; 2]>,
) -> Vec<Extrusion> {
    let n = paths.len();
    let InfillLayout {
        closed,
        comps,
        stripes,
        hilbert,
    } = layout;
    let legacy_sample = crate::inner_prof::Sample::start();
    let legacy = legacy_nn_indices(&paths, grid.as_ref(), cursor, has);
    legacy_sample.order_legacy(n as u64);
    let off = walk_cost(&paths, &legacy, cursor, has, false, to);
    let on = if closed {
        walk_cost(&paths, &legacy, cursor, has, true, to)
    } else {
        off
    };
    let mut best = if on + TRAVEL_WIN_MM < off {
        Choice {
            order: legacy.clone(),
            cost: on,
            rotate: true,
        }
    } else {
        Choice {
            order: legacy.clone(),
            cost: off,
            rotate: false,
        }
    };
    // Open paths already score both ends in the legacy scan, so a second
    // nearest-neighbor pass only pays off once closed seams move the target.
    let mut candidates = vec![
        hilbert_order(&paths, hilbert, cursor, has),
        (0..n).collect(),
    ];
    if closed {
        candidates.insert(0, nn_order(&paths, cursor, has));
    }
    if comps.len() > 1 {
        candidates.push(island_order(&paths, &comps, cursor, has));
    }
    let rest_sample = crate::inner_prof::Sample::start();
    candidates.extend(stripes);
    let cand_sample = crate::inner_prof::Sample::start();
    for order in candidates {
        consider(&paths, order, cursor, has, closed, to, &mut best);
    }
    cand_sample.order_candidates(n as u64);
    let polish_sample = crate::inner_prof::Sample::start();
    let polished = polish_order(&paths, &best.order, cursor, has, best.rotate, to);
    polish_sample.order_polish(n as u64);
    if polished != best.order {
        for rotate in [best.rotate, !best.rotate] {
            if rotate && !closed {
                continue;
            }
            let cost = walk_cost(&paths, &polished, cursor, has, rotate, to);
            if cost + 1e-6 < best.cost {
                best.cost = cost;
                best.order = polished.clone();
                best.rotate = rotate;
            }
        }
    }
    if closed {
        // Seams move with the visit order, so a reorder proposed on the ends as
        // they stand is kept only when the walk, seams moved, really is shorter.
        if has && paths.iter().all(geom_closed) {
            let rings_sample = crate::inner_prof::Sample::start();
            let proposed = reorder_rings(&paths, &best.order, cursor, best.rotate, to);
            rings_sample.order_rings(n as u64);
            if proposed != best.order {
                let cost = walk_cost(&paths, &proposed, cursor, has, best.rotate, to);
                if cost + TRAVEL_WIN_MM < best.cost {
                    best.cost = cost;
                    best.order = proposed;
                }
            }
        }
    } else {
        let untangle_sample = crate::inner_prof::Sample::start();
        let (order, flips) = untangle(&paths, &best.order, cursor, has, to);
        untangle_sample.order_untangle(n as u64);
        if order != best.order || flips.iter().any(|f| *f) {
            rest_sample.order_rest(n as u64);
            return apply_flips(paths, &order, &flips);
        }
    }
    if !best.rotate && best.order == legacy {
        rest_sample.order_rest(n as u64);
        return order_nearest(paths, grid.as_ref(), cursor, has, None);
    }
    let mut ordered = apply_order(paths, &best.order, cursor, has, best.rotate);
    // Closed and open paths in one run: the seams are settled now, so 2-opt reads
    // each loop as a stop at its start, and a loop is never reversed.
    if closed && !ordered.iter().all(geom_closed) {
        let ident: Vec<usize> = (0..ordered.len()).collect();
        let (order, mut flips) = untangle(&ordered, &ident, cursor, has, to);
        for (flip, &i) in flips.iter_mut().zip(&order) {
            if geom_closed(&ordered[i]) {
                *flip = false;
            }
        }
        if order != ident || flips.iter().any(|f| *f) {
            ordered = apply_flips(ordered, &order, &flips);
        }
    }
    rest_sample.order_rest(n as u64);
    ordered
}

/// A run of closed paths is a visit order over points, each path entered and
/// left at one seam. Improves `order` from the cursor by 2-opt and by moving
/// one to three paths elsewhere, until neither shortens it. The seams are those
/// the order has now; the caller checks the result with the seams moved.
pub(super) fn reorder_rings(
    paths: &[Extrusion],
    order: &[usize],
    cursor: [f64; 2],
    rotate: bool,
    to: Option<[f64; 2]>,
) -> Vec<usize> {
    let n = order.len();
    if !(3..=RING_REORDER_MAX).contains(&n) {
        return order.to_vec();
    }
    let dirs = build_dirs(paths, order, cursor, true, rotate);
    // Node 0 is the cursor and stays first; node k + 1 is `order[k]`; a target,
    // when there is one, is node n + 1 and stays last.
    let mut at: Vec<[f64; 2]> = vec![cursor];
    at.extend(dirs.iter().map(|d| d.start));
    at.extend(to);
    let fixed_end = usize::from(to.is_some());
    let mut tour: Vec<usize> = (0..at.len()).collect();
    let d = |a: usize, b: usize| dist_mm(at[a], at[b]);
    for _ in 0..RING_REORDER_PASSES {
        let mut improved = false;
        for i in 1..n {
            for j in i + 1..=n {
                let (before, first, last) = (tour[i - 1], tour[i], tour[j]);
                let mut delta = d(before, last) - d(before, first);
                if let Some(&after) = tour.get(j + 1) {
                    delta += d(first, after) - d(last, after);
                }
                if delta < -1e-6 {
                    tour[i..=j].reverse();
                    improved = true;
                }
            }
        }
        for len in 1..=3usize {
            let mut i = 1;
            while i + len <= n {
                let seg: Vec<usize> = tour[i..i + len].to_vec();
                let (before, after) = (tour[i - 1], tour.get(i + len).copied());
                let mut gain = d(before, seg[0]);
                if let Some(after) = after {
                    gain += d(seg[len - 1], after) - d(before, after);
                }
                let mut rest = tour.clone();
                rest.drain(i..i + len);
                let mut best: Option<(f64, usize, bool)> = None;
                for pos in 1..=rest.len() - fixed_end {
                    if pos == i {
                        continue;
                    }
                    let (p, q) = (rest[pos - 1], rest.get(pos).copied());
                    for reversed in [false, true] {
                        let (head, tail) = if reversed {
                            (seg[len - 1], seg[0])
                        } else {
                            (seg[0], seg[len - 1])
                        };
                        let mut cost = d(p, head);
                        if let Some(q) = q {
                            cost += d(tail, q) - d(p, q);
                        }
                        if cost + 1e-6 < gain && best.is_none_or(|b| cost < b.0) {
                            best = Some((cost, pos, reversed));
                        }
                    }
                }
                if let Some((_, pos, reversed)) = best {
                    let mut moved = seg;
                    if reversed {
                        moved.reverse();
                    }
                    for (k, node) in moved.into_iter().enumerate() {
                        rest.insert(pos + k, node);
                    }
                    tour = rest;
                    improved = true;
                }
                i += 1;
            }
        }
        if !improved {
            break;
        }
    }
    tour[1..=n].iter().map(|&node| order[node - 1]).collect()
}

/// Longest run `reorder_rings` takes, and how many passes it makes.
pub(super) const RING_REORDER_MAX: usize = 160;
pub(super) const RING_REORDER_PASSES: usize = 6;

/// Positions a 2-opt move may reach past `i`. Crossings sit between nearby
/// paths, and the cap keeps a big skin group linear.
pub(super) const UNTANGLE_WINDOW: usize = 64;

/// 2-opt on a run of open paths. Reversing a stretch of the run also flips
/// each path in it, so only the two travels at its ends change; a move is
/// kept when those two get shorter. This undoes the crossing jumps that
/// nearest-neighbor leaves behind, such as finishing one bar of a frame and
/// cutting across the opening to the far bar. Returns the order and, per
/// position, whether that path runs from its last point.
pub(super) fn untangle(
    paths: &[Extrusion],
    order: &[usize],
    cursor: [f64; 2],
    has: bool,
    to: Option<[f64; 2]>,
) -> (Vec<usize>, Vec<bool>) {
    let n = order.len();
    let mut order = order.to_vec();
    let mut ins: Vec<[f64; 2]> = Vec::with_capacity(n);
    let mut outs: Vec<[f64; 2]> = Vec::with_capacity(n);
    let mut flips: Vec<bool> = Vec::with_capacity(n);
    let mut at = (cursor, has);
    for &idx in &order {
        let (start, end) = oriented_ends(&paths[idx], at.0, at.1, false);
        let first = paths[idx].points.first().copied().unwrap_or(at.0);
        flips.push(paths[idx].points.len() >= 2 && start != first);
        ins.push(start);
        outs.push(end);
        if !paths[idx].points.is_empty() {
            at = (end, true);
        }
    }
    if n < 3 {
        return (order, flips);
    }
    let link = |from: Option<[f64; 2]>, to: [f64; 2]| from.map_or(0.0, |f| dist_mm(f, to));
    for _ in 0..8 {
        let mut improved = false;
        for i in 0..n - 1 {
            let before = if i == 0 {
                has.then_some(cursor)
            } else {
                Some(outs[i - 1])
            };
            for j in i + 1..n.min(i + UNTANGLE_WINDOW) {
                let after = ins.get(j + 1).copied().or(to);
                let old = link(before, ins[i]) + after.map_or(0.0, |a| dist_mm(outs[j], a));
                let new = link(before, outs[j]) + after.map_or(0.0, |a| dist_mm(ins[i], a));
                if new + 1e-6 < old {
                    order[i..=j].reverse();
                    ins[i..=j].reverse();
                    outs[i..=j].reverse();
                    flips[i..=j].reverse();
                    for k in i..=j {
                        std::mem::swap(&mut ins[k], &mut outs[k]);
                        flips[k] = !flips[k];
                    }
                    improved = true;
                }
            }
        }
        let mut tour = Tour {
            order: &mut order,
            ins: &mut ins,
            outs: &mut outs,
            flips: &mut flips,
        };
        improved |= tour.relocate(cursor, has, to);
        if !improved {
            break;
        }
    }
    (order, flips)
}
