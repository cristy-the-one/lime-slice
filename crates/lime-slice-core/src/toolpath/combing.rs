use super::*;

pub(super) enum Comb {
    Clear,
    Open,
    Routed(Vec<[f64; 2]>),
    Blocked,
}

/// A layer's solid and its combing inset, split into islands. Islands never
/// touch, so a travel between two of them always leaves the part, and a
/// routed travel only searches the inset of the island it stays in.
pub(super) struct Combing<'a> {
    solid: Outline<'a>,
    enabled: bool,
    islands: Vec<CombIsland>,
    /// The solid grown by the combing inset. A travel that stays out of it
    /// is in open air; empty when combing is off.
    grown: Outline<'static>,
    open_air: bool,
}

pub(super) struct CombIsland {
    solid: Outline<'static>,
    inset: Outline<'static>,
}

impl<'a> Combing<'a> {
    pub(super) fn new(solid: &'a [Loop], combing: bool, inset: f64) -> Self {
        let inset_loops = if combing && !solid.is_empty() {
            offset_loops(solid, -inset.abs())
        } else {
            Vec::new()
        };
        let enabled = combing && !inset_loops.is_empty();
        let mut islands: Vec<CombIsland> = Vec::new();
        if enabled {
            islands = island_loops(solid)
                .into_iter()
                .map(|loops| CombIsland {
                    solid: Outline::owned(loops),
                    inset: Outline::owned(Vec::new()),
                })
                .collect();
            let mut insets: Vec<Vec<Loop>> = vec![Vec::new(); islands.len()];
            for loop_ in inset_loops {
                let Some(&p) = loop_.first() else {
                    continue;
                };
                if let Some(i) = islands.iter().position(|isl| isl.solid.contains(p)) {
                    insets[i].push(loop_);
                }
            }
            for (island, inset) in islands.iter_mut().zip(insets) {
                island.inset = Outline::owned(inset);
            }
        }
        let grown = if combing {
            Outline::owned(offset_loops(solid, inset.abs()))
        } else {
            Outline::owned(Vec::new())
        };
        Self {
            solid: Outline::new(solid),
            enabled,
            islands,
            grown,
            open_air: combing,
        }
    }

    /// Both ends and every point between lie clear of the part by the combing
    /// inset, so the nozzle passes no wall on the way.
    fn open_air(&self, a: [f64; 2], b: [f64; 2]) -> bool {
        self.open_air
            && !self.grown.contains(a)
            && !self.grown.contains(b)
            && !self.grown.meets(a, b)
    }

    fn island_of(&self, p: [f64; 2]) -> Option<usize> {
        self.islands
            .iter()
            .position(|isl| isl.solid.box_holds(p) && isl.solid.contains(p))
    }
}

/// A way into `node` from `from` in the combing search, ranked by its estimate
/// `f` of the whole route through it.
pub(super) struct CombStep {
    f: f64,
    node: usize,
    from: usize,
}

impl Ord for CombStep {
    fn cmp(&self, other: &Self) -> CmpOrdering {
        self.f
            .total_cmp(&other.f)
            .then(self.node.cmp(&other.node))
            .then(self.from.cmp(&other.from))
    }
}

impl PartialOrd for CombStep {
    fn partial_cmp(&self, other: &Self) -> Option<CmpOrdering> {
        Some(self.cmp(other))
    }
}

impl PartialEq for CombStep {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == CmpOrdering::Equal
    }
}

impl Eq for CombStep {}

pub(super) fn comb_between(comb: &Combing, from: [f64; 2], to: [f64; 2]) -> Comb {
    if dist2(from, to) < 0.04 * 0.04 {
        return Comb::Clear;
    }
    if comb.solid.route_inside(from, to) {
        return Comb::Clear;
    }
    if comb.open_air(from, to) {
        return Comb::Open;
    }
    if !comb.enabled {
        return Comb::Blocked;
    }
    if !comb.solid.contains(from) || !comb.solid.contains(to) {
        return Comb::Blocked;
    }
    let island = match (comb.island_of(from), comb.island_of(to)) {
        (Some(a), Some(b)) if a == b => &comb.islands[a],
        _ => return Comb::Blocked,
    };
    let (solid, inset) = (&island.solid, &island.inset);
    let mut nodes = Vec::new();
    for loop_ in inset.loops.iter() {
        let step = (loop_.len() / 64).max(1);
        for (i, p) in loop_.iter().enumerate() {
            if i % step == 0 {
                nodes.push(*p);
            }
        }
    }
    nodes.push(from);
    nodes.push(to);
    let n = nodes.len();
    let start = n - 2;
    let goal = n - 1;
    let visible = |i: usize, j: usize| {
        inset.route_inside(nodes[i], nodes[j])
            || (i == start || j == start || i == goal || j == goal)
                && solid.route_inside(nodes[i], nodes[j])
    };
    // A* over the visibility graph, testing an edge only when it is the cheapest
    // way left to reach its node. A plate with a hundred holes has thousands of
    // nodes, and the holes away from the travel are never tested.
    let span = |i: usize, j: usize| dist2(nodes[i], nodes[j]).sqrt();
    let mut dist = vec![f64::INFINITY; n];
    let mut prev = vec![usize::MAX; n];
    let mut open = BinaryHeap::new();
    open.push(Reverse(CombStep {
        f: span(start, goal),
        node: start,
        from: usize::MAX,
    }));
    while let Some(Reverse(CombStep {
        node: v, from: u, ..
    })) = open.pop()
    {
        if dist[v].is_finite() || u != usize::MAX && !visible(u, v) {
            continue;
        }
        dist[v] = if u == usize::MAX {
            0.0
        } else {
            dist[u] + span(u, v)
        };
        prev[v] = u;
        if v == goal {
            break;
        }
        for w in 0..n {
            if !dist[w].is_finite() {
                open.push(Reverse(CombStep {
                    f: dist[v] + span(v, w) + span(w, goal),
                    node: w,
                    from: v,
                }));
            }
        }
    }
    if !dist[goal].is_finite() {
        return Comb::Blocked;
    }
    let mut via = Vec::new();
    let mut cur = goal;
    while cur != start && cur != usize::MAX {
        if cur != goal {
            via.push(nodes[cur]);
        }
        cur = prev[cur];
    }
    via.reverse();
    if via.is_empty() {
        Comb::Clear
    } else {
        Comb::Routed(via)
    }
}

/// Mark travels that should lift. `mode` is the resolved policy (`Off`, `Smart`, or `Always`).
/// Smart never hops inside the infill inset, skips short moves and scarf ramps, and hops
/// when combing is blocked across a printed wall or top, or when leaving a top skin.
/// A hole crossing retracts in combing; smart hops that blocked travel, speed does not.
pub fn apply_z_hop(
    paths: &mut [Extrusion],
    solid: &[Loop],
    infill: &[Loop],
    mode: crate::strategy::ZHopMode,
    height: f64,
    min_travel: f64,
    after_top_layer: bool,
) {
    if height <= 1e-6 || mode == crate::strategy::ZHopMode::Off {
        return;
    }
    let (solid, infill) = (Outline::new(solid), Outline::new(infill));
    let mut cursor: Option<[f64; 2]> = None;
    let mut prev_top = false;
    let mut printed: Vec<([f64; 2], [f64; 2])> = Vec::new();
    for path in paths.iter_mut() {
        let Some(start) = path.points.first().copied() else {
            continue;
        };
        if let Some(from) = cursor {
            let mut chain = Vec::with_capacity(path.lead_in.len() + 2);
            chain.push(from);
            chain.extend(path.lead_in.iter().copied());
            chain.push(start);
            let travel = polyline_len(&chain);
            let spiral = !path.z_frac.is_empty();
            let inside_infill = !infill.loops.is_empty()
                && chain.windows(2).all(|w| infill.segment_inside(w[0], w[1]))
                && chain.windows(2).all(|w| solid.segment_inside(w[0], w[1]));
            let policy = match mode {
                crate::strategy::ZHopMode::Blend => {
                    if path.strategy == crate::strategy::StrategyId::Toughness {
                        crate::strategy::ZHopMode::Smart
                    } else {
                        crate::strategy::ZHopMode::Off
                    }
                }
                other => other,
            };
            let hop = if spiral || travel < min_travel || policy == crate::strategy::ZHopMode::Off {
                false
            } else if policy == crate::strategy::ZHopMode::Always {
                true
            } else if inside_infill {
                false
            } else if prev_top || after_top_layer {
                true
            } else {
                let blocked = path.travel_in != TravelIn::Inside && path.retract_mm > 0.0;
                blocked && chain_crosses(&chain, &solid, &printed, path.travel_in == TravelIn::Open)
            };
            if hop {
                path.z_hop = height;
            }
        }
        if matches!(
            path.kind,
            PathKind::Outer | PathKind::Inner | PathKind::Wall | PathKind::Top | PathKind::Ironing
        ) {
            for w in path.points.windows(2) {
                printed.push((w[0], w[1]));
            }
        }
        prev_top = matches!(path.kind, PathKind::Top | PathKind::Ironing);
        cursor = path.points.last().copied();
    }
}

/// Whether a travel would drag across the part or a wall printed this layer.
/// A travel known to run in open air leaves the part by definition, so it
/// counts only when it passes close to a printed wall.
pub(super) fn chain_crosses(
    chain: &[[f64; 2]],
    solid: &Outline,
    printed: &[([f64; 2], [f64; 2])],
    open_air: bool,
) -> bool {
    let leaves = !open_air && chain.windows(2).any(|w| !solid.segment_inside(w[0], w[1]));
    if leaves {
        return true;
    }
    chain.windows(2).any(|w| {
        printed
            .iter()
            .any(|&(a, b)| point_seg_dist(w[0], a, b) < 0.5 || point_seg_dist(w[1], a, b) < 0.5)
    })
}
