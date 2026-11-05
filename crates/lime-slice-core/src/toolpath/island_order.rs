use super::*;

/// Each outer loop with the holes directly inside it. Nesting comes from
/// containment, so loop orientation does not matter.
pub(crate) fn island_loops(loops: &[Loop]) -> Vec<Vec<Loop>> {
    let outlines: Vec<Outline> = loops
        .iter()
        .map(|l| Outline::new(std::slice::from_ref(l)))
        .collect();
    let parents = containing_loops(loops, &outlines);
    let mut island_at: Vec<Option<usize>> = vec![None; loops.len()];
    let mut out: Vec<Vec<Loop>> = Vec::new();
    for (i, up) in parents.iter().enumerate() {
        if up.len() % 2 == 0 {
            island_at[i] = Some(out.len());
            out.push(vec![loops[i].clone()]);
        }
    }
    for (i, up) in parents.iter().enumerate() {
        if up.len() % 2 == 1 {
            let owner = up
                .iter()
                .filter(|&&j| parents[j].len() + 1 == up.len())
                .find_map(|&j| island_at[j]);
            if let Some(k) = owner {
                out[k].push(loops[i].clone());
            }
        }
    }
    out
}

/// One layer's paths with each island printed whole before the next, for the
/// untoured (classic) planner. A layer's islands are planned together, so
/// every wall pass runs across all of them before the next pass starts, and
/// each pass hops between islands. Here an island keeps its paths in their
/// planned order (its wall passes, then its gap fill and thin walls, then its
/// infill) and the next island is the one whose first path starts nearest
/// where the last one ended. The layer still starts on its first path. No
/// path changes, only the order.
pub(crate) fn order_by_island(paths: Vec<Extrusion>, contours: &[Loop]) -> Vec<Extrusion> {
    if paths.len() < 2 {
        return paths;
    }
    let islands: Vec<Outline<'static>> = island_loops(contours)
        .into_iter()
        .map(Outline::owned)
        .collect();
    if islands.len() < 2 {
        return paths;
    }
    let find = |p: &[f64; 2]| {
        islands
            .iter()
            .position(|isl| isl.box_holds(*p) && isl.contains(*p))
    };
    let mut owner: Vec<Option<usize>> = paths
        .iter()
        .map(|path| {
            let pts = &path.points;
            pts.first()
                .and_then(find)
                .or_else(|| pts.get(pts.len() / 2).and_then(find))
                .or_else(|| pts.last().and_then(find))
        })
        .collect();
    // A path on no island (a bead on an outline's edge) stays with the path
    // before it; one ahead of every placed path goes with the first of them.
    let Some(head) = owner.iter().flatten().next().copied() else {
        return paths;
    };
    let mut prev = head;
    for o in &mut owner {
        prev = *o.get_or_insert(prev);
    }
    let mut groups: Vec<Vec<Extrusion>> = (0..islands.len()).map(|_| Vec::new()).collect();
    for (path, o) in paths.into_iter().zip(owner) {
        groups[o.unwrap_or(head)].push(path);
    }
    let mut out = Vec::new();
    let mut next = Some(head);
    while let Some(k) = next {
        let group = std::mem::take(&mut groups[k]);
        out.extend(group);
        let at = out.last().and_then(|p| p.points.last().copied());
        let mut best: Option<(f64, usize)> = None;
        for (j, g) in groups.iter().enumerate() {
            if g.is_empty() {
                continue;
            }
            let start = g.iter().find_map(|p| p.points.first().copied());
            let d = match (at, start) {
                (Some(a), Some(s)) => hypot2(a, s),
                _ => 0.0,
            };
            if best.is_none_or(|(bd, _)| d < bd) {
                best = Some((d, j));
            }
        }
        next = best.map(|(_, j)| j);
    }
    out
}

/// Loops that contain each loop's first vertex, in ascending loop index.
/// A grid is the linear scan's hits: a box that misses the vertex's cell
/// cannot contain it, and equal distances are not involved.
pub(super) fn containing_loops(loops: &[Loop], outlines: &[Outline]) -> Vec<Vec<usize>> {
    let n = loops.len();
    if n <= 48 {
        return (0..n)
            .map(|i| contained_by_linear(loops, outlines, i, 0..n))
            .collect();
    }
    let cell = 8.0_f64;
    let mut buckets: HashMap<(i64, i64), Vec<usize>> = HashMap::new();
    for (j, outline) in outlines.iter().enumerate() {
        let Some((mn, mx)) = outline.bounds else {
            continue;
        };
        let x0 = (mn[0] / cell).floor() as i64;
        let x1 = (mx[0] / cell).floor() as i64;
        let y0 = (mn[1] / cell).floor() as i64;
        let y1 = (mx[1] / cell).floor() as i64;
        for x in x0..=x1 {
            for y in y0..=y1 {
                buckets.entry((x, y)).or_default().push(j);
            }
        }
    }
    (0..n)
        .map(|i| {
            let Some(&p) = loops[i].first() else {
                return Vec::new();
            };
            let key = ((p[0] / cell).floor() as i64, (p[1] / cell).floor() as i64);
            let Some(ids) = buckets.get(&key) else {
                return Vec::new();
            };
            let mut hits: Vec<usize> = ids
                .iter()
                .copied()
                .filter(|&j| j != i && outlines[j].box_holds(p) && outlines[j].contains(p))
                .collect();
            hits.sort_unstable();
            hits.dedup();
            hits
        })
        .collect()
}

pub(super) fn contained_by_linear(
    loops: &[Loop],
    outlines: &[Outline],
    i: usize,
    js: impl Iterator<Item = usize>,
) -> Vec<usize> {
    let Some(&p) = loops[i].first() else {
        return Vec::new();
    };
    js.filter(|&j| j != i && outlines[j].box_holds(p) && outlines[j].contains(p))
        .collect()
}

#[cfg(test)]
mod island_order_tests {
    use super::*;
    use crate::strategy::{classicize, pure, StrategyId};

    fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Loop {
        vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    }

    /// Four 12 mm squares, the far one listed second, so the planned order
    /// would hop right across the plate between passes.
    fn islands() -> Vec<Loop> {
        vec![
            rect(0.0, 0.0, 12.0, 12.0),
            rect(60.0, 0.0, 72.0, 12.0),
            rect(20.0, 0.0, 32.0, 12.0),
            rect(40.0, 0.0, 52.0, 12.0),
        ]
    }

    fn island_at(loops: &[Loop], p: [f64; 2]) -> usize {
        loops
            .iter()
            .position(|l| {
                let (mn, mx) = loop_bounds(std::slice::from_ref(l)).unwrap();
                p[0] >= mn[0] - 1.0 && p[0] <= mx[0] + 1.0
            })
            .unwrap()
    }

    fn classic_plan(loops: &[Loop]) -> Vec<Extrusion> {
        let strategy = classicize(pure(StrategyId::Toughness));
        let features = PathFeatures {
            variable_width: false,
            ..PathFeatures::default()
        };
        let mut hint = [80.0, 6.0];
        plan_region(loops, &strategy, 0.45, &mut hint, &features)
    }

    fn hops(paths: &[Extrusion]) -> f64 {
        paths
            .windows(2)
            .map(|w| hypot2(*w[0].points.last().unwrap(), w[1].points[0]))
            .sum()
    }

    fn piece(kind: PathKind, pts: Vec<[f64; 2]>) -> Extrusion {
        extrusion(kind, &pure(StrategyId::Toughness), pts, 0.45)
    }

    #[test]
    fn each_island_prints_whole_in_planned_order() {
        let loops = islands();
        let planned = classic_plan(&loops);
        let ordered = order_by_island(planned.clone(), &loops);
        assert_eq!(ordered.len(), planned.len());
        // The plan runs every pass across all islands first.
        let runs = |paths: &[Extrusion]| {
            let mut seen: Vec<usize> = Vec::new();
            for p in paths {
                let k = island_at(&loops, p.points[0]);
                if seen.last() != Some(&k) {
                    seen.push(k);
                }
            }
            seen
        };
        assert!(
            runs(&planned).len() > 4,
            "planned runs {:?}",
            runs(&planned)
        );
        let visits = runs(&ordered);
        assert_eq!(visits.len(), 4, "one run per island: {visits:?}");
        // Inside each island the planned order, outer before inner, holds.
        for k in 0..loops.len() {
            let of = |paths: &[Extrusion]| -> Vec<Extrusion> {
                paths
                    .iter()
                    .filter(|p| island_at(&loops, p.points[0]) == k)
                    .cloned()
                    .collect()
            };
            assert_eq!(of(&ordered), of(&planned), "island {k}");
        }
        assert!(
            hops(&ordered) < hops(&planned) * 0.6,
            "hops {:.0} vs {:.0} mm",
            hops(&ordered),
            hops(&planned)
        );
    }

    #[test]
    fn islands_follow_nearest_from_where_the_last_ended() {
        let loops = islands();
        let planned = classic_plan(&loops);
        let ordered = order_by_island(planned.clone(), &loops);
        let mut visits: Vec<usize> = Vec::new();
        for p in &ordered {
            let k = island_at(&loops, p.points[0]);
            if visits.last() != Some(&k) {
                visits.push(k);
            }
        }
        // The layer starts on its first planned path's island.
        assert_eq!(visits[0], island_at(&loops, planned[0].points[0]));
        // From the far right (x 60) the islands run leftwards one by one.
        assert_eq!(visits, vec![1, 3, 2, 0]);
    }

    #[test]
    fn gap_fill_and_thin_walls_stay_with_their_island() {
        let loops = vec![rect(0.0, 0.0, 10.0, 10.0), rect(50.0, 0.0, 60.0, 10.0)];
        let wall = |x: f64| {
            let mut ring = rect(x + 0.2, 0.2, x + 9.8, 9.8);
            ring.push(ring[0]);
            piece(PathKind::Outer, ring)
        };
        let paths = vec![
            wall(0.0),
            wall(50.0),
            piece(PathKind::GapFill, vec![[2.0, 5.0], [8.0, 5.0]]),
            piece(PathKind::ThinWall, vec![[52.0, 5.0], [58.0, 5.0]]),
            piece(PathKind::Sparse, vec![[3.0, 3.0], [7.0, 7.0]]),
            piece(PathKind::Sparse, vec![[53.0, 3.0], [57.0, 7.0]]),
        ];
        let ordered = order_by_island(paths.clone(), &loops);
        let kinds: Vec<(PathKind, bool)> = ordered
            .iter()
            .map(|p| (p.kind, p.points[0][0] > 30.0))
            .collect();
        assert_eq!(
            kinds,
            vec![
                (PathKind::Outer, false),
                (PathKind::GapFill, false),
                (PathKind::Sparse, false),
                (PathKind::Outer, true),
                (PathKind::ThinWall, true),
                (PathKind::Sparse, true),
            ]
        );
    }

    #[test]
    fn island_order_is_deterministic_and_one_island_is_left_alone() {
        let loops = islands();
        let planned = classic_plan(&loops);
        assert_eq!(
            order_by_island(planned.clone(), &loops),
            order_by_island(planned.clone(), &loops)
        );
        let one = vec![rect(0.0, 0.0, 30.0, 30.0)];
        let single = classic_plan(&one);
        assert_eq!(order_by_island(single.clone(), &one), single);
    }

    #[test]
    fn a_hole_with_an_island_inside_keeps_each_side_whole() {
        // A ring with a post standing in its hole: two islands, nested.
        let mut hole = rect(10.0, 10.0, 30.0, 30.0);
        hole.reverse();
        let loops = vec![
            rect(0.0, 0.0, 40.0, 40.0),
            hole,
            rect(17.0, 17.0, 23.0, 23.0),
        ];
        let planned = classic_plan(&loops);
        let ordered = order_by_island(planned.clone(), &loops);
        let post = |p: &Extrusion| {
            let q = p.points[0];
            (16.0..=24.0).contains(&q[0]) && (16.0..=24.0).contains(&q[1])
        };
        let switches = ordered
            .windows(2)
            .filter(|w| post(&w[0]) != post(&w[1]))
            .count();
        assert_eq!(switches, 1);
        assert_eq!(ordered.len(), planned.len());
    }
}
