use super::*;
use crate::strategy::{pure, StrategyId};

fn path(kind: PathKind, pts: Vec<[f64; 2]>) -> Extrusion {
    extrusion(kind, &pure(StrategyId::Speed), pts, 0.45)
}

/// `Walk::cost_of` must be `walk_cost` to the bit for every move of one
/// path, on open lines, closed rings, and an empty path, with and without
/// a cursor, seam rotation, and a target; and a cut-short cost must be one
/// the full walk would reject too.
#[test]
fn a_walk_costs_a_moved_path_like_a_full_walk() {
    let mut seed = 0x9e37_79b9_7f4a_7c15u64;
    let mut rand = || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        (seed >> 11) as f64 / (1u64 << 53) as f64 * 40.0
    };
    let mut paths = Vec::new();
    for k in 0..23 {
        let (x, y) = (rand(), rand());
        let pts = match k % 4 {
            0 => vec![[x, y], [x + 3.0, y + 1.0], [x + 3.0, y + 4.0], [x, y]],
            _ => vec![[x, y], [rand(), rand()]],
        };
        paths.push(path(PathKind::Infill, pts));
    }
    paths.push(path(PathKind::Infill, Vec::new()));
    let n = paths.len();
    for (has, rotate, to) in [
        (true, false, None),
        (true, true, Some([5.0, 5.0])),
        (false, false, Some([30.0, 2.0])),
        (false, true, None),
    ] {
        let cursor = [rand(), rand()];
        let order: Vec<usize> = (0..n).rev().collect();
        let walk = Walk::new(&paths, &order, cursor, has, rotate, to);
        let full = |o: &[usize]| walk_cost(&paths, o, cursor, has, rotate, to);
        assert_eq!(walk.total.to_bits(), full(&order).to_bits());
        for t in 0..n {
            for raw in 0..=n {
                let mut trial = order.clone();
                let item = trial.remove(t);
                let at = insert_at(raw, t, trial.len());
                trial.insert(at, item);
                let want = full(&trial);
                let span = (t.min(at), t.max(at));
                let got = walk.cost_of(&paths, &trial, span, 0.0, f64::INFINITY);
                assert_eq!(got.map(f64::to_bits), Some(want.to_bits()), "{t} -> {at}");
                let bound = walk.total;
                match walk.cost_of(&paths, &trial, span, TRAVEL_WIN_MM, bound) {
                    Some(cost) => assert_eq!(cost.to_bits(), want.to_bits()),
                    None => assert!(want + TRAVEL_WIN_MM >= bound),
                }
            }
        }
    }
}

/// Euclidean travel between the paths as ordered.
fn nozzle_travel(paths: &[Extrusion]) -> f64 {
    let mut cursor = [0.0, 0.0];
    let mut has = false;
    let mut travel = 0.0;
    for path in paths {
        if path.points.is_empty() {
            continue;
        }
        if !has {
            cursor = *path.points.last().unwrap();
            has = true;
            continue;
        }
        travel += dist_mm(cursor, path.points[0]);
        cursor = *path.points.last().unwrap();
    }
    travel
}

fn square_at(x: f64, y: f64, size: f64) -> Loop {
    vec![[x, y], [x + size, y], [x + size, y + size], [x, y + size]]
}

fn support(pts: Vec<[f64; 2]>) -> Extrusion {
    path(PathKind::Support, pts)
}

/// A 10 mm square of part with supports around it.
fn combed_supports(paths: Vec<Extrusion>) -> Vec<Extrusion> {
    let mut paths = paths;
    comb_layer(&mut paths, &[square_at(0.0, 0.0, 10.0)], true, 0.36, None);
    paths
}

#[test]
fn a_support_travel_in_open_air_retracts_only_past_fifteen_millimetres() {
    let paths = combed_supports(vec![
        support(vec![[20.0, 0.0], [20.4, 0.0]]),
        support(vec![[20.8, 0.0], [21.2, 0.0]]),
        support(vec![[30.0, 0.0], [30.4, 0.0]]),
    ]);
    assert_eq!(paths[1].travel_in, TravelIn::Open);
    assert_eq!(paths[2].travel_in, TravelIn::Open);
    assert_eq!(paths[1].travel_retract(None), (0.35, 15.0));
    assert_eq!(paths[2].travel_retract(None), (0.35, 15.0));
}

#[test]
fn a_support_travel_across_the_part_still_retracts_every_time() {
    let paths = combed_supports(vec![
        support(vec![[-5.0, 5.0], [-4.6, 5.0]]),
        support(vec![[15.0, 5.0], [15.4, 5.0]]),
    ]);
    assert_eq!(paths[1].travel_in, TravelIn::Blocked);
    assert_eq!(paths[1].travel_retract(None), (0.35, 0.0));
}

#[test]
fn a_support_travel_that_ends_against_a_wall_retracts() {
    let paths = combed_supports(vec![
        support(vec![[20.0, 5.0], [20.4, 5.0]]),
        support(vec![[10.2, 5.0], [10.6, 5.0]]),
    ]);
    assert_eq!(paths[1].travel_in, TravelIn::Blocked);
}

#[test]
fn a_travel_in_open_air_does_not_hop_unless_it_passes_a_printed_wall() {
    use crate::strategy::ZHopMode;
    let solid = vec![square_at(0.0, 0.0, 10.0)];
    let mut paths = vec![
        support(vec![[20.0, 0.0], [20.4, 0.0]]),
        support(vec![[26.0, 0.0], [26.4, 0.0]]),
    ];
    for p in &mut paths {
        p.strategy = StrategyId::Toughness;
    }
    comb_layer(&mut paths, &solid, true, 0.36, None);
    apply_z_hop(&mut paths, &solid, &[], ZHopMode::Smart, 0.4, 2.0, false);
    assert_eq!(paths[1].z_hop, 0.0);
    // The same travel, blocked by the part, hops.
    let mut across = vec![
        support(vec![[-5.0, 5.0], [-4.6, 5.0]]),
        support(vec![[15.0, 5.0], [15.4, 5.0]]),
    ];
    for p in &mut across {
        p.strategy = StrategyId::Toughness;
    }
    comb_layer(&mut across, &solid, true, 0.36, None);
    apply_z_hop(&mut across, &solid, &[], ZHopMode::Smart, 0.4, 2.0, false);
    assert_eq!(across[1].z_hop, 0.4);
}

/// Travel between loops of 0.4 mm radius, as `order_supports` orders them from
/// the middle of a 40 mm square.
fn walked_over_loops(count: usize, seed: u64) -> f64 {
    let mut state = seed;
    let mut next = || {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (state >> 33) as f64 / (1u64 << 31) as f64 * 40.0
    };
    let mut paths: Vec<Extrusion> = (0..count)
        .map(|_| support(circle_pts([next(), next()], 0.4)))
        .collect();
    let mut at = [20.0, 20.0];
    order_supports(&mut paths, Some(at), None, None);
    let mut walked = 0.0;
    for path in &paths {
        walked += dist_mm(at, path.points[0]);
        at = *path.points.last().unwrap();
    }
    walked
}

#[test]
fn a_support_tip_is_a_loop_of_24_sides() {
    let strategy = crate::strategy::pure(StrategyId::Speed);
    let disk = |r: f64| crate::support::Disk {
        xy: [5.0, 5.0],
        r,
        node: crate::support::NodeId(0),
    };
    let tip = plan_tree_support(&[disk(0.39)], &[], &strategy, 0.45);
    assert_eq!(tip.len(), 1);
    assert_eq!(tip[0].points.len(), 25);
    assert_eq!(tip[0].points[0], tip[0].points[24]);
    // A trunk is the outline of its disks pulled in by half a bead, and
    // then a second loop inside it.
    let trunk = plan_tree_support(&[disk(1.5)], &[], &strategy, 0.45);
    assert_eq!(trunk.len(), 2);
    assert!(trunk.iter().all(|p| p.points.len() == 25));
}

#[test]
fn support_loops_are_visited_in_a_short_order() {
    let walked: f64 = (1..=6).map(|seed| walked_over_loops(60, seed)).sum();
    // Nearest-neighbour with relocations walks 1490 mm here; 2-opt and
    // moving short runs of loops brings it to 1410.
    assert!(walked < 1450.0, "walked {walked:.1} mm");
}

/// Travel over 60 supports, loops of 0.4 mm radius and 1.5 mm strokes by turns,
/// ordered from the middle of a 40 mm square.
fn walked_over_mixed(seed: u64) -> f64 {
    let mut state = seed;
    let mut next = || {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (state >> 33) as f64 / (1u64 << 31) as f64 * 40.0
    };
    let mut paths: Vec<Extrusion> = (0..60)
        .map(|k| {
            let (x, y) = (next(), next());
            if k % 2 == 0 {
                support(circle_pts([x, y], 0.4))
            } else {
                support(vec![[x, y], [x + 1.5, y]])
            }
        })
        .collect();
    let mut at = [20.0, 20.0];
    order_supports(&mut paths, Some(at), None, None);
    let mut walked = 0.0;
    for path in &paths {
        walked += dist_mm(at, path.points[0]);
        at = *path.points.last().unwrap();
    }
    walked
}

#[test]
fn a_run_of_loops_and_strokes_is_visited_in_a_short_order() {
    let walked: f64 = (1..=6).map(walked_over_mixed).sum();
    // Nearest-neighbour with 2-opt on the strokes alone walks 1451 mm here;
    // 2-opt over the loops and strokes together brings it to 1361.
    assert!(walked < 1400.0, "walked {walked:.1} mm");
}

#[test]
fn a_stroke_printed_too_early_is_moved_past_its_neighbours() {
    // Strokes along a line, the second one far ahead of its place: reversing
    // a stretch cannot bring it back, moving it can.
    let paths: Vec<Extrusion> = [1.0, 10.0, 3.0, 5.0]
        .iter()
        .map(|&x| support(vec![[x, 0.0], [x + 1.0, 0.0]]))
        .collect();
    let (order, flips) = untangle(&paths, &[0, 1, 2, 3], [0.0, 0.0], true, None);
    assert_eq!(order, vec![0, 2, 3, 1]);
    assert_eq!(flips, vec![false; 4]);
}

#[test]
fn supports_end_nearest_the_path_that_prints_after_them() {
    let loops = |at: [f64; 2], to: Option<[f64; 2]>| {
        let mut paths: Vec<Extrusion> = [10.0, 20.0, 30.0]
            .iter()
            .map(|&x| support(circle_pts([x, 0.0], 0.4)))
            .collect();
        order_supports(&mut paths, Some(at), to, None);
        paths
            .iter()
            .map(|p| p.points[0][0].round())
            .collect::<Vec<_>>()
    };
    // From the right of the middle one, the shortest walk takes the far
    // end first and finishes at the left.
    assert_eq!(loops([24.0, 5.0], None), vec![30.0, 20.0, 10.0]);
    // With the part starting 30 mm further right it finishes there instead.
    assert_eq!(
        loops([24.0, 5.0], Some([60.0, 0.0])),
        vec![10.0, 20.0, 30.0]
    );
}

/// A square wall loop of `size` mm at (`x`, 0), outer or inner.
fn wall(kind: PathKind, x: f64, size: f64) -> Extrusion {
    path(kind, ring(x, 0.0, size))
}

fn kinds_in_order(paths: &[Extrusion]) -> Vec<(PathKind, i64)> {
    paths
        .iter()
        .map(|p| (p.kind, p.points[0][0].round() as i64 / 10 * 10))
        .collect()
}

#[test]
fn two_wall_stacks_far_apart_print_one_after_the_other() {
    // One island: both squares sit in one 72 mm slab. Plan order is every
    // outer wall, then every inner wall.
    let solid = vec![vec![[-1.0, -1.0], [71.0, -1.0], [71.0, 11.0], [-1.0, 11.0]]];
    let paths = vec![
        wall(PathKind::Outer, 0.0, 10.0),
        wall(PathKind::Outer, 60.0, 10.0),
        wall(PathKind::Inner, 0.45, 9.1),
        wall(PathKind::Inner, 60.45, 9.1),
    ];
    let (out, _) = PartLayout::new(paths, &solid).tour(Some([0.0, 0.0]), None);
    assert_eq!(
        kinds_in_order(&out),
        vec![
            (PathKind::Outer, 0),
            (PathKind::Inner, 0),
            (PathKind::Outer, 60),
            (PathKind::Inner, 60),
        ]
    );
}

#[test]
fn one_wall_stack_keeps_the_plan_order() {
    let solid = vec![vec![[-1.0, -1.0], [12.0, -1.0], [12.0, 11.0], [-1.0, 11.0]]];
    let paths = vec![
        wall(PathKind::Outer, 0.0, 10.0),
        wall(PathKind::Inner, 0.45, 9.1),
        wall(PathKind::Inner, 0.9, 8.2),
    ];
    let (out, _) = PartLayout::new(paths, &solid).tour(Some([0.0, 0.0]), None);
    assert_eq!(
        kinds_in_order(&out),
        vec![
            (PathKind::Outer, 0),
            (PathKind::Inner, 0),
            (PathKind::Inner, 0)
        ]
    );
}

#[test]
fn a_travel_between_islands_retracts() {
    let solid = vec![square_at(0.0, 0.0, 10.0), square_at(11.4, 0.0, 10.0)];
    let comb = Combing::new(&solid, true, 0.36);
    assert!(matches!(
        comb_between(&comb, [9.0, 5.0], [12.4, 5.0]),
        Comb::Blocked
    ));
    assert!(matches!(
        comb_between(&comb, [1.0, 1.0], [9.0, 9.0]),
        Comb::Clear
    ));
}

#[test]
fn a_travel_around_a_hole_stays_in_its_island() {
    let ring = vec![
        square_at(0.0, 0.0, 10.0),
        square_at(3.0, 3.0, 4.0).into_iter().rev().collect(),
        square_at(4.0, 4.0, 2.0),
    ];
    let comb = Combing::new(&ring, true, 0.36);
    let Comb::Routed(via) = comb_between(&comb, [1.0, 5.0], [9.0, 5.0]) else {
        panic!("a travel across the hole should comb around it");
    };
    assert!(via.iter().all(|p| p[1] < 3.0 || p[1] > 7.0), "{via:?}");
    assert!(matches!(
        comb_between(&comb, [1.0, 5.0], [5.0, 5.0]),
        Comb::Blocked
    ));
}

fn ring(x: f64, y: f64, size: f64) -> Vec<[f64; 2]> {
    let mut pts = square_at(x, y, size);
    pts.push(pts[0]);
    pts
}

#[test]
fn a_scarf_ramp_keeps_every_vertex_of_a_curved_wall() {
    let ring: Vec<[f64; 2]> = (0..=64)
        .map(|i| {
            let a = std::f64::consts::TAU * (i % 64) as f64 / 64.0;
            [10.0 * a.cos(), 10.0 * a.sin()]
        })
        .collect();
    let mut wall = extrusion(
        PathKind::Outer,
        &pure(StrategyId::Toughness),
        ring.clone(),
        0.45,
    );
    scarf_path(&mut wall, 10.0, 8, 0.15, 0.55);
    assert!(wall.scarf_mm > 9.9, "scarf {}", wall.scarf_mm);
    let step = dist_mm(ring[0], ring[1]);
    let on_ramp = ring
        .iter()
        .enumerate()
        .filter(|(i, _)| *i as f64 * step <= 10.0);
    for (i, v) in on_ramp {
        assert!(
            wall.points.iter().any(|p| dist2(*p, *v) < 1e-12),
            "ramp skipped vertex {i} at {v:?}"
        );
    }
}

#[test]
fn a_layer_prints_island_by_island() {
    let solid = vec![square_at(0.0, 0.0, 10.0), square_at(20.0, 0.0, 10.0)];
    let mut paths = vec![
        path(PathKind::Outer, ring(0.2, 0.2, 9.6)),
        path(PathKind::Outer, ring(20.2, 0.2, 9.6)),
        path(PathKind::Sparse, vec![[1.0, 5.0], [9.0, 5.0]]),
        path(PathKind::Sparse, vec![[21.0, 5.0], [29.0, 5.0]]),
    ];
    order_part(&mut paths, &solid, Some([0.0, 0.0]), None);
    let order: Vec<(PathKind, bool)> = paths
        .iter()
        .map(|p| (p.kind, p.points[0][0] < 15.0))
        .collect();
    assert_eq!(
        order,
        vec![
            (PathKind::Outer, true),
            (PathKind::Sparse, true),
            (PathKind::Outer, false),
            (PathKind::Sparse, false),
        ]
    );
}

#[test]
fn an_aligned_seam_stays_and_an_inner_wall_starts_near_the_nozzle() {
    let tough = pure(StrategyId::Toughness);
    let outer = extrusion(PathKind::Outer, &tough, ring(0.0, 0.0, 10.0), 0.45);
    let mut far = square_at(0.45, 0.45, 9.1);
    far.rotate_left(2);
    far.push(far[0]);
    let inner = extrusion(PathKind::Inner, &tough, far, 0.45);
    let mut paths = vec![outer, inner];
    order_part(&mut paths, &[], Some([10.0, 10.0]), None);
    assert_eq!(paths[0].points[0], [0.0, 0.0], "aligned seam moved");
    assert_eq!(
        paths[1].points[0],
        [0.45, 0.45],
        "inner wall should start by the outer seam"
    );
}

#[test]
fn a_rear_seam_takes_a_corner_at_the_back_and_aligned_the_sharpest() {
    let house = vec![
        [0.0, 0.0],
        [10.0, 0.0],
        [10.0, 6.0],
        [5.0, 10.0],
        [0.0, 6.0],
    ];
    assert_eq!(rear_seam(&house), 3, "the roof peak");
    assert_eq!(aligned_seam(&house), 1, "the front +X corner");
}

#[test]
fn a_rear_seam_without_a_back_corner_takes_the_rear_most_vertex() {
    let mut d: Vec<[f64; 2]> = vec![[-10.0, 0.0]];
    d.extend((0..32).map(|k| {
        let a = std::f64::consts::PI * k as f64 / 32.0;
        [10.0 * a.cos(), 10.0 * a.sin()]
    }));
    let at = rear_seam(&d);
    assert_eq!(at, 17);
    assert_eq!(d[at][1], 10.0);
    assert_eq!(aligned_seam(&d), 1, "aligned keeps the front +X corner");
}

#[test]
fn a_rear_seam_breaks_a_tie_toward_plus_x() {
    let flat = vec![
        [0.0, 0.0],
        [4.0, 0.0],
        [8.0, 0.0],
        [8.0, 5.0],
        [4.0, 5.0],
        [0.0, 5.0],
    ];
    assert_eq!(rear_seam(&flat), 3);
}

/// Where a square's outer wall and a triangle's inner wall start, planned
/// under `strategy` and toured from the front-left corner. The inner
/// wall's back corner is far from where the outer wall ends.
fn wall_starts(strategy: &ResolvedStrategy) -> Vec<(PathKind, [f64; 2])> {
    let mut paths = Vec::new();
    let mut hint = [0.0, 0.0];
    let outer = [square_at(0.0, 0.0, 10.0)];
    let inner = [vec![[1.0, 1.0], [7.0, 1.0], [1.0, 6.0]]];
    emit_loops(
        &mut paths,
        &outer,
        PathKind::Outer,
        strategy,
        0.45,
        &mut hint,
    );
    emit_loops(
        &mut paths,
        &inner,
        PathKind::Inner,
        strategy,
        0.45,
        &mut hint,
    );
    order_part(&mut paths, &[], Some([0.0, 0.0]), None);
    paths.iter().map(|p| (p.kind, p.points[0])).collect()
}

#[test]
fn an_explicit_seam_starts_the_inner_wall_where_the_outer_wall_starts() {
    let mut placed = pure(StrategyId::Speed);
    placed.seam = SeamMode::Rear;
    placed.inner_follows_seam = true;
    assert_eq!(
        wall_starts(&placed),
        vec![
            (PathKind::Outer, [10.0, 10.0]),
            (PathKind::Inner, [1.0, 6.0])
        ]
    );
    placed.inner_follows_seam = false;
    assert_eq!(
        wall_starts(&placed),
        vec![
            (PathKind::Outer, [10.0, 10.0]),
            (PathKind::Inner, [7.0, 1.0])
        ],
        "without an explicit seam the inner wall starts near the nozzle"
    );
}

/// Where the outer wall of a U with its feet at the back (+Y) starts when
/// the nozzle is at `from`. Its four rear corners are equally far back.
fn u_start(strategy: &ResolvedStrategy, from: [f64; 2]) -> [f64; 2] {
    let u = [vec![
        [0.0, 0.0],
        [50.0, 0.0],
        [50.0, 23.0],
        [47.0, 23.0],
        [47.0, 3.0],
        [3.0, 3.0],
        [3.0, 23.0],
        [0.0, 23.0],
    ]];
    let mut paths = Vec::new();
    emit_loops(
        &mut paths,
        &u,
        PathKind::Outer,
        strategy,
        0.45,
        &mut [0.0, 0.0],
    );
    order_part(&mut paths, &[], Some(from), None);
    paths[0].points[0]
}

#[test]
fn an_edge_seam_starts_a_u_at_the_foot_nearest_the_nozzle() {
    let mut edge = pure(StrategyId::Speed);
    edge.seam = SeamMode::Edge;
    assert_eq!(u_start(&edge, [1.0, 20.0]), [0.0, 23.0]);
    assert_eq!(u_start(&edge, [49.0, 20.0]), [50.0, 23.0]);
    let mut rear = pure(StrategyId::Speed);
    rear.seam = SeamMode::Rear;
    assert_eq!(
        u_start(&rear, [1.0, 20.0]),
        [50.0, 23.0],
        "rear stacks on +X"
    );
    assert_eq!(u_start(&rear, [49.0, 20.0]), [50.0, 23.0]);
}

#[test]
fn a_route_through_an_outline_vertex_is_not_inside() {
    let loop_ = vec![[1.0, 1.0], [4.0, 1.5], [4.5, 4.5], [1.5, 4.0]];
    let outline = Outline::new(std::slice::from_ref(&loop_));
    assert!(!outline.route_inside([0.0, 0.0], [4.0, 4.0]));
    assert!(outline.route_inside([2.0, 2.0], [4.0, 4.0]));
}

#[test]
fn edge_cells_answer_as_the_full_scan() {
    // A wavy band on Clipper's 1 µm grid, with enough edges for the grid.
    let ring = |r: f64, n: usize| -> Loop {
        (0..n)
            .map(|i| {
                let a = i as f64 / n as f64 * std::f64::consts::TAU;
                let rr = r + r * 0.1 * (7.0 * a).sin();
                let snap = |v: f64| (v * 1000.0).round() / 1000.0;
                [snap(50.0 + rr * a.cos()), snap(40.0 + rr * a.sin())]
            })
            .collect()
    };
    let mut hole = ring(12.0, 150);
    hole.reverse();
    let loops = vec![ring(30.0, 250), hole];
    let indexed = Outline::new(&loops);
    let scanned = Outline::new(&loops);
    assert!(indexed.cells().is_some());
    assert!(scanned.cells.set(None).is_ok());
    assert!(indexed.contains([71.0, 40.3]));
    assert!(!indexed.contains([50.0, 40.3]));
    assert!(indexed.crosses([50.0, 40.3], [71.0, 40.3]));
    assert_eq!(
        indexed.clip_segment([10.0, 40.3], [90.0, 40.3]).len(),
        2,
        "a chord through the hole keeps the band on each side"
    );
    // Random points, then the outline's own vertices, whose segments run
    // along edges and through vertices.
    let mut seed = 7u64;
    let mut next = || {
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (seed >> 11) as f64 / (1u64 << 53) as f64
    };
    let mut pts: Vec<[f64; 2]> = (0..2000)
        .map(|_| [10.0 + next() * 80.0, next() * 80.0])
        .collect();
    pts.extend(loops.iter().flatten().copied());
    for w in pts.windows(2) {
        let (a, b) = (w[0], w[1]);
        assert_eq!(indexed.contains(a), scanned.contains(a), "contains {a:?}");
        assert_eq!(
            indexed.crosses(a, b),
            scanned.crosses(a, b),
            "crosses {a:?} {b:?}"
        );
        assert_eq!(
            indexed.clip_segment(a, b),
            scanned.clip_segment(a, b),
            "clip {a:?} {b:?}"
        );
    }
}

#[test]
fn long_chord_does_not_pull_the_nozzle_off_nearby_infill() {
    let mut paths = vec![path(
        PathKind::Outer,
        vec![[0.0, 0.0], [0.2, 0.0], [0.2, 0.2], [0.0, 0.2], [0.0, 0.0]],
    )];
    paths.push(path(PathKind::Sparse, vec![[0.05, 0.0], [80.0, 0.0]]));
    for i in 0..6 {
        let y = 2.0 + i as f64;
        paths.push(path(PathKind::Sparse, vec![[0.0, y], [3.0, y]]));
    }
    order_part(&mut paths, &[], None, None);
    let travel = nozzle_travel(&paths);
    assert!(
        travel < 30.0,
        "nearby infill should print before the 80 mm chord, travel {travel:.1} mm"
    );
}

#[test]
fn closed_infill_starts_at_the_near_vertex() {
    let mut paths = vec![
        path(PathKind::Sparse, vec![[0.0, 0.0], [10.0, 10.0]]),
        path(
            PathKind::Sparse,
            vec![
                [0.0, 0.0],
                [10.0, 0.0],
                [10.0, 10.0],
                [0.0, 10.0],
                [0.0, 0.0],
            ],
        ),
    ];
    order_part(&mut paths, &[], None, None);
    let travel = nozzle_travel(&paths);
    assert!(travel < 1.0, "seam or order left {travel:.2} mm");
    if paths[0].points.len() == 2 {
        let seam = paths[1].points[0];
        assert!(
            (seam[0] - 10.0).abs() < 1e-6 && (seam[1] - 10.0).abs() < 1e-6,
            "seam {seam:?}"
        );
    }
}

#[test]
fn walls_stay_ahead_of_infill() {
    let mut paths = vec![
        path(
            PathKind::Outer,
            vec![[0.0, 0.0], [4.0, 0.0], [4.0, 4.0], [0.0, 4.0], [0.0, 0.0]],
        ),
        path(
            PathKind::Outer,
            vec![
                [20.0, 0.0],
                [24.0, 0.0],
                [24.0, 4.0],
                [20.0, 4.0],
                [20.0, 0.0],
            ],
        ),
        path(PathKind::Sparse, vec![[1.0, 1.0], [3.0, 1.0]]),
        path(PathKind::Sparse, vec![[1.0, 2.0], [3.0, 2.0]]),
    ];
    order_part(&mut paths, &[], None, None);
    let kinds: Vec<_> = paths.iter().map(|p| p.kind).collect();
    assert!(
        kinds.starts_with(&[PathKind::Outer, PathKind::Outer]),
        "{kinds:?}"
    );
    assert!(kinds[2..].iter().all(|k| *k == PathKind::Sparse));
}

#[test]
fn travel_order_is_deterministic() {
    let mut once = vec![
        path(PathKind::Sparse, vec![[0.0, 0.0], [8.0, 0.0]]),
        path(PathKind::Sparse, vec![[30.0, 5.0], [34.0, 5.0]]),
        path(PathKind::Sparse, vec![[0.0, 2.0], [8.0, 2.0]]),
        path(PathKind::Sparse, vec![[30.0, 7.0], [34.0, 7.0]]),
    ];
    let mut twice = once.clone();
    order_part(&mut once, &[], None, None);
    order_part(&mut twice, &[], None, None);
    let a: Vec<_> = once.iter().map(|p| p.points.clone()).collect();
    let b: Vec<_> = twice.iter().map(|p| p.points.clone()).collect();
    assert_eq!(a, b);
}

#[test]
fn hilbert_of_the_origin_is_zero() {
    assert_eq!(hilbert_d(0, 0), 0);
}

/// A V-shaped membrane 0.15 mm thick. Tip to heel (3.2 mm) is farther than
/// tip to tip (2 mm), so splitting at the farthest pair ran the spine from
/// one tip across the gap between the arms and left the other arm bare.
#[test]
fn a_bent_sliver_spine_runs_tip_to_tip_inside_it() {
    let ring = vec![
        [-1.0, 0.0],
        [-0.85, 0.0],
        [0.0, -2.5],
        [0.85, 0.0],
        [1.0, 0.0],
        [0.0, -3.0],
    ];
    let spine = sliver_spine(&ring, 0.2).unwrap();
    let ends = [spine[0], *spine.last().unwrap()];
    for tip in [[-0.925, 0.0], [0.925, 0.0]] {
        assert!(
            ends.iter().any(|e| dist_mm(*e, tip) < 0.2),
            "no spine end near {tip:?}: {ends:?}"
        );
    }
    let outline = [ring.clone()];
    for p in &spine {
        assert!(
            crate::poly::point_in_loop(&ring, p[0], p[1])
                || crate::poly::distance_to_outline(&outline, *p) < 0.05,
            "spine point {p:?} leaves the sliver"
        );
    }
}

/// The grid nearest-neighbor must print the same sequence as the linear
/// scan, including equal-distance ties and closed walls.
#[test]
fn grid_nearest_matches_the_linear_scan() {
    let mut state = 0x1234_5678_9abc_u64;
    let mut rnd = || {
        state = state.wrapping_mul(6364136223846793005).wrapping_add(1);
        (state >> 33) as f64 / f64::from(1u32 << 31)
    };
    let mut paths = Vec::new();
    for i in 0..180 {
        let x = rnd() * 300.0 - 20.0;
        let y = rnd() * 200.0 - 10.0;
        if i % 17 == 0 {
            paths.push(path(PathKind::GapFill, vec![[x, y], [x, y]]));
        } else if i % 11 == 0 {
            paths.push(path(PathKind::Outer, ring(x, y, 1.2 + rnd())));
        } else if i % 13 == 0 {
            paths.push(path(PathKind::GapFill, Vec::new()));
        } else {
            paths.push(path(
                PathKind::Sparse,
                vec![[x, y], [x + rnd() * 4.0, y + rnd() * 3.0]],
            ));
        }
    }
    // Several segments share a point so equal distances have a winner.
    for k in 0..8 {
        paths.push(path(
            PathKind::Solid,
            vec![[40.0, 40.0], [40.0 + k as f64, 48.0]],
        ));
    }
    let cursor = [12.5, -3.0];
    let grid = approach_grid(&paths);
    let got = legacy_nn_indices(&paths, grid.as_ref(), cursor, true);
    let mut pending: Vec<usize> = (0..paths.len()).collect();
    let mut expect = Vec::new();
    let mut at = cursor;
    let mut has = true;
    while !pending.is_empty() {
        let best_i = pending_winner_linear(&paths, &pending, at, has);
        let idx = pending.swap_remove(best_i);
        if !paths[idx].points.is_empty() {
            at = oriented_ends(&paths[idx], at, has, false).1;
            has = true;
        }
        expect.push(idx);
    }
    assert_eq!(got, expect);
    let seated = order_nearest(paths.clone(), grid.as_ref(), cursor, true, None);
    let mut replay = Vec::new();
    let mut at = cursor;
    let mut has = true;
    for idx in expect {
        let mut path = paths[idx].clone();
        orient_path(&mut path, at, has, false);
        if let Some(end) = path.points.last() {
            at = *end;
            has = true;
        }
        replay.push(path.points);
    }
    let seated_pts: Vec<_> = seated.iter().map(|p| p.points.clone()).collect();
    assert_eq!(seated_pts, replay);
}

#[test]
fn island_grid_matches_pairwise_containment() {
    let mut loops = vec![square_at(0.0, 0.0, 80.0)];
    for i in 0..70 {
        let x = (i % 10) as f64 * 7.5 + 1.0;
        let y = (i / 10) as f64 * 10.0 + 1.0;
        loops.push(square_at(x, y, 3.0 + (i % 3) as f64));
    }
    loops.push(square_at(2.0, 2.0, 1.0));
    let outlines: Vec<Outline> = loops
        .iter()
        .map(|l| Outline::new(std::slice::from_ref(l)))
        .collect();
    let got = containing_loops(&loops, &outlines);
    let expect: Vec<Vec<usize>> = (0..loops.len())
        .map(|i| contained_by_linear(&loops, &outlines, i, 0..loops.len()))
        .collect();
    assert_eq!(got, expect);
}

#[test]
fn void_skin_area_matches_the_full_difference() {
    let mut clip = Vec::new();
    for i in 0..30 {
        for j in 0..12 {
            clip.push(square_at(i as f64 * 6.0, j as f64 * 6.0, 4.0));
        }
    }
    let mut hole = square_at(10.0, 10.0, 6.0);
    if signed_area(&hole) > 0.0 {
        hole.reverse();
    }
    let plate = vec![square_at(0.0, 0.0, 40.0), hole];
    let probes = [
        vec![square_at(0.4, 0.4, 1.2)],
        vec![square_at(4.3, 0.4, 1.0)],
        vec![square_at(3.2, 0.5, 1.6)],
        vec![square_at(3.7, 3.7, 2.4)],
        vec![square_at(-8.0, 2.0, 3.0)],
        vec![square_at(1.0, 1.0, 2.0), square_at(1.4, 1.4, 0.8)],
        vec![square_at(12.0, 12.0, 1.5)],
        vec![square_at(8.5, 12.0, 4.0)],
        vec![square_at(38.5, 20.0, 3.0)],
    ];
    for (label, solid) in [("tiles", &clip), ("plate", &plate)] {
        let mut index = OverlapIndex::build(solid);
        for piece in &probes {
            let full = net_area(&boolean_diff(piece, solid));
            let fast = outside_area(piece, solid, &mut index);
            assert!(
                (full - fast).abs() < 1e-4,
                "{label} full {full} fast {fast}"
            );
            assert_eq!(full > 0.01, fast > 0.01, "{label}");
        }
        let linear: Vec<usize> = (0..solid.len()).collect();
        for piece in &probes {
            let Some((min, max)) = loop_bounds(piece) else {
                continue;
            };
            let expect: Vec<usize> = linear
                .iter()
                .copied()
                .filter(|&i| {
                    loop_bounds(std::slice::from_ref(&solid[i])).is_some_and(|(a, b)| {
                        a[0] <= max[0] && min[0] <= b[0] && a[1] <= max[1] && min[1] <= b[1]
                    })
                })
                .collect();
            assert_eq!(index.hits(min, max), expect, "{label}");
        }
    }
}
