use super::*;

pub(super) fn serpentine(segments: Vec<Vec<[f64; 2]>>, solid: &[Loop]) -> Vec<Vec<[f64; 2]>> {
    chain_ends(segments, 4.0, Some(solid))
}

/// Greedily weld open segments into polylines, reversing either end.
/// Gaps up to `join` are bridged. When `solid` is set, a bridge that leaves
/// the region (a hole, or outside the part) is not taken.
///
/// Endpoints live in a grid of `join`-sized cells, so each weld looks only at
/// nearby segments. Ties go where the old linear scan sent them: shortest gap,
/// then position in the unused list, then which end, then which direction.
pub(super) fn chain_ends(
    segments: Vec<Vec<[f64; 2]>>,
    join: f64,
    solid: Option<&[Loop]>,
) -> Vec<Vec<[f64; 2]>> {
    let sample = crate::inner_prof::Sample::start();
    let seg_count = segments.len() as u64;
    let outline = solid.map(Outline::new);
    let mut segs: Vec<Option<Vec<[f64; 2]>>> = segments
        .into_iter()
        .filter(|s| s.len() >= 2)
        .map(Some)
        .collect();
    let mut unused: Vec<usize> = (0..segs.len()).collect();
    let mut pos: Vec<usize> = (0..segs.len()).collect();
    let cell = join.max(1e-3);
    let key = |p: [f64; 2]| ((p[0] / cell).floor() as i64, (p[1] / cell).floor() as i64);
    let mut grid: HashMap<(i64, i64), Vec<usize>> = HashMap::new();
    for (id, seg) in segs.iter().enumerate() {
        let seg = seg.as_ref().unwrap();
        grid.entry(key(seg[0])).or_default().push(id);
        grid.entry(key(*seg.last().unwrap())).or_default().push(id);
    }
    let unlink = |grid: &mut HashMap<(i64, i64), Vec<usize>>, seg: &[[f64; 2]], id: usize| {
        for p in [seg[0], *seg.last().unwrap()] {
            if let Some(ids) = grid.get_mut(&key(p)) {
                ids.retain(|x| *x != id);
            }
        }
    };
    let join2 = join * join;
    let mut out = Vec::new();
    let mut near: Vec<usize> = Vec::new();
    while let Some(id) = unused.pop() {
        let mut path = segs[id].take().unwrap();
        unlink(&mut grid, &path, id);
        loop {
            let end = *path.last().unwrap();
            let start = path[0];
            near.clear();
            for tip in [end, start] {
                let (cx, cy) = key(tip);
                for gx in cx - 1..=cx + 1 {
                    for gy in cy - 1..=cy + 1 {
                        if let Some(ids) = grid.get(&(gx, gy)) {
                            near.extend_from_slice(ids);
                        }
                    }
                }
            }
            near.sort_unstable();
            near.dedup();
            // (gap², position in `unused`, end order, direction order, segment)
            let mut best: Option<(f64, usize, u8, u8, usize)> = None;
            for &c in &near {
                let seg = segs[c].as_ref().unwrap();
                let s0 = seg[0];
                let s1 = *seg.last().unwrap();
                for (end_order, tip) in [(0u8, end), (1u8, start)] {
                    for (rev_order, other) in [(0u8, s0), (1u8, s1)] {
                        let d2 = dist2(tip, other);
                        if d2 > join2 {
                            continue;
                        }
                        let rank = (d2, pos[c], end_order, rev_order);
                        if best.is_some_and(|b| (b.0, b.1, b.2, b.3) <= rank) {
                            continue;
                        }
                        if d2 > 1e-8 {
                            if let Some(outline) = &outline {
                                if !outline.link_stays(tip, other) {
                                    continue;
                                }
                            }
                        }
                        best = Some((rank.0, rank.1, rank.2, rank.3, c));
                    }
                }
            }
            let Some((_, p, end_order, rev_order, c)) = best else {
                break;
            };
            unused.swap_remove(p);
            if p < unused.len() {
                pos[unused[p]] = p;
            }
            let mut seg = segs[c].take().unwrap();
            unlink(&mut grid, &seg, c);
            let (at_end, rev) = (end_order == 0, rev_order == 1);
            // `rev` means the matched vertex is currently the segment's last point.
            // Appending needs it at the front; prepending needs it at the back.
            if at_end == rev {
                seg.reverse();
            }
            if at_end {
                if dist2(*path.last().unwrap(), seg[0]) < 1e-8 {
                    path.extend(seg.into_iter().skip(1));
                } else {
                    path.extend(seg);
                }
            } else if dist2(path[0], *seg.last().unwrap()) < 1e-8 {
                seg.pop();
                seg.append(&mut path);
                path = seg;
            } else {
                seg.append(&mut path);
                path = seg;
            }
        }
        out.push(path);
    }
    sample.chain(seg_count);
    out
}

/// Order open polylines so each one starts at the free end nearest where the
/// last one stopped, reversed when that end is its last point. Ends that meet
/// exactly are welded into one polyline. Every point is kept and no link is
/// extruded, so the beads are the same; only the travels between them shrink.
///
/// A hop that leaves `solid` (over a hole or outside the part) loses to one
/// that stays inside, unless that one is more than twice as far. Ties go to
/// the earlier polyline, then its first point, so the order is deterministic.
pub(super) fn order_open(paths: Vec<Vec<[f64; 2]>>, solid: &[Loop]) -> Vec<Vec<[f64; 2]>> {
    let mut pending: Vec<Option<Vec<[f64; 2]>>> = paths
        .into_iter()
        .filter(|p| p.len() >= 2)
        .map(Some)
        .collect();
    if pending.len() < 2 {
        return pending.into_iter().flatten().collect();
    }
    let outline = Outline::new(solid);
    let mut out = Vec::with_capacity(pending.len());
    let mut current = pending[0].take().unwrap();
    let mut left = pending.len() - 1;
    // (gap², index, reversed)
    let mut near: Vec<(f64, usize, bool)> = Vec::new();
    while left > 0 {
        let end = *current.last().unwrap();
        let mut best = f64::INFINITY;
        for p in pending.iter().flatten() {
            best = best
                .min(dist2(end, p[0]))
                .min(dist2(end, *p.last().unwrap()));
        }
        near.clear();
        let reach = best * 4.0 + 1e-12;
        for (i, p) in pending.iter().enumerate() {
            let Some(p) = p else { continue };
            for (rev, tip) in [(false, p[0]), (true, *p.last().unwrap())] {
                let d2 = dist2(end, tip);
                if d2 <= reach {
                    near.push((d2, i, rev));
                }
            }
        }
        near.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
        let tip = |&(_, i, rev): &(f64, usize, bool)| {
            let p = pending[i].as_ref().unwrap();
            if rev {
                *p.last().unwrap()
            } else {
                p[0]
            }
        };
        let (d2, i, rev) = near
            .iter()
            .find(|c| c.0 < 1e-8 || outline.link_stays(end, tip(c)))
            .copied()
            .unwrap_or(near[0]);
        let mut next = pending[i].take().unwrap();
        if rev {
            next.reverse();
        }
        if d2 < 1e-8 {
            current.extend(next.into_iter().skip(1));
        } else {
            out.push(std::mem::replace(&mut current, next));
        }
        left -= 1;
    }
    out.push(current);
    out
}

#[cfg(test)]
mod order_open_tests {
    use super::*;
    use crate::strategy::{classicize, pure, StrategyId};

    fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Loop {
        vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    }

    /// A 40 mm square with a 12 mm square hole: rows of waves split in two.
    fn holed() -> Vec<Loop> {
        let mut hole = rect(14.0, 14.0, 26.0, 26.0);
        hole.reverse();
        vec![rect(0.0, 0.0, 40.0, 40.0), hole]
    }

    fn hops(paths: &[Vec<[f64; 2]>]) -> f64 {
        paths
            .windows(2)
            .map(|w| dist2(*w[0].last().unwrap(), w[1][0]).sqrt())
            .sum()
    }

    fn bead_len(paths: &[Vec<[f64; 2]>]) -> f64 {
        paths
            .iter()
            .flat_map(|p| p.windows(2))
            .map(|w| dist2(w[0], w[1]).sqrt())
            .sum()
    }

    /// Every segment of the input, either way round, as bit patterns.
    fn segments(paths: &[Vec<[f64; 2]>]) -> Vec<[u64; 4]> {
        let mut out: Vec<[u64; 4]> = paths
            .iter()
            .flat_map(|p| p.windows(2))
            .map(|w| {
                let (a, b) = if (w[0][0], w[0][1]) <= (w[1][0], w[1][1]) {
                    (w[0], w[1])
                } else {
                    (w[1], w[0])
                };
                [a[0], a[1], b[0], b[1]].map(f64::to_bits)
            })
            .collect();
        out.sort_unstable();
        out
    }

    fn classic_gyroid() -> ResolvedStrategy {
        let mut s = classicize(pure(StrategyId::Toughness));
        s.gyroid_3d = false;
        s
    }

    #[test]
    fn gyroid_waves_hop_short_and_keep_every_bead() {
        let loops = holed();
        let raw = clip_infill(gyroid(&loops, 2.0, 0.5), &loops);
        let ordered = order_open(raw.clone(), &loops);
        assert!(raw.len() > 20, "pieces {}", raw.len());
        assert!(
            hops(&ordered) < hops(&raw) * 0.25,
            "hops {:.0} mm vs {:.0} mm raw",
            hops(&ordered),
            hops(&raw)
        );
        // Same beads: same segments either way round, same length, no links.
        assert_eq!(segments(&ordered), segments(&raw));
        assert!((bead_len(&ordered) - bead_len(&raw)).abs() < 1e-6);
    }

    #[test]
    fn meeting_ends_are_welded_and_far_ends_flipped() {
        let paths = vec![
            vec![[0.0, 0.0], [10.0, 0.0]],
            vec![[10.0, 1.0], [0.0, 1.0]],
            vec![[20.0, 0.0], [10.0, 0.0]],
        ];
        let out = order_open(paths, &[rect(-1.0, -1.0, 21.0, 2.0)]);
        // The third piece meets the first at (10, 0), reversed; the second
        // starts 1 mm away at (10, 1).
        assert_eq!(
            out,
            vec![
                vec![[0.0, 0.0], [10.0, 0.0], [20.0, 0.0]],
                vec![[10.0, 1.0], [0.0, 1.0]],
            ]
        );
    }

    #[test]
    fn hops_stay_inside_over_a_nearer_one_across_a_hole() {
        let mut hole = rect(10.0, 10.0, 20.0, 20.0);
        hole.reverse();
        let loops = vec![rect(0.0, 0.0, 30.0, 30.0), hole];
        let paths = vec![
            vec![[5.0, 9.5], [15.0, 9.5]],
            // 11 mm away, straight across the hole.
            vec![[15.0, 20.5], [25.0, 20.5]],
            // 11.7 mm away, below the hole.
            vec![[24.0, 2.0], [28.0, 2.0]],
        ];
        let out = order_open(paths, &loops);
        assert_eq!(out[1][0], [24.0, 2.0]);
        // Nothing inside reach: the nearest end wins.
        let far = vec![
            vec![[5.0, 9.5], [15.0, 9.5]],
            vec![[15.0, 20.5], [25.0, 20.5]],
            vec![[29.0, 29.0], [29.5, 29.5]],
        ];
        let out = order_open(far, &loops);
        assert_eq!(out[1][0], [15.0, 20.5]);
    }

    #[test]
    fn classic_gyroid_infill_is_deterministic_and_short() {
        let loops = holed();
        let strategy = classic_gyroid();
        let features = PathFeatures {
            infill_nearest_first: true,
            ..PathFeatures::default()
        };
        let a = build_infill(&loops, &strategy, 0.45, &features);
        let b = build_infill(&loops, &strategy, 0.45, &features);
        assert_eq!(a, b);
        let spacing = (0.45 / strategy.infill_density.max(0.02)).clamp(0.45 * 1.05, 14.0);
        let raw = clip_infill(gyroid(&loops, spacing * 2.2, strategy.toughness), &loops);
        assert_eq!(segments(&a), segments(&raw));
        assert!(
            hops(&a) < hops(&raw) * 0.25,
            "{} vs {}",
            hops(&a),
            hops(&raw)
        );
        // Off, as the tour planner wants it: the generator's own order.
        let toured = build_infill(&loops, &strategy, 0.45, &PathFeatures::default());
        assert_eq!(toured, raw);
    }

    #[test]
    fn classic_lines_and_grid_keep_their_beads() {
        let loops = holed();
        for pattern in [InfillPattern::Lines, InfillPattern::Grid] {
            let mut strategy = classicize(pure(StrategyId::Speed));
            strategy.pattern = pattern;
            let ordered = PathFeatures {
                infill_nearest_first: true,
                ..PathFeatures::default()
            };
            let a = build_infill(&loops, &strategy, 0.45, &ordered);
            let raw = build_infill(&loops, &strategy, 0.45, &PathFeatures::default());
            assert_eq!(segments(&a), segments(&raw), "{pattern:?}");
            assert!((bead_len(&a) - bead_len(&raw)).abs() < 1e-6, "{pattern:?}");
            assert!(hops(&a) <= hops(&raw) + 1e-9, "{pattern:?}");
        }
    }
}
