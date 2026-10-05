//! Lightning infill as trees that stand on the walls.
//!
//! On every layer a tree joins the nodes of a grid fixed to the bed to the
//! walls around the layer's interior: each node leans on its neighbour on
//! the shortest path to a wall, so branches merge into straight trunks. A node under top skin prints its whole chain
//! on the layer just below that skin. On every layer further down, each
//! chain prints one overhang step less of itself, so a branch backs off
//! toward the wall it ends on, and every bead overhangs the bead under it by
//! at most that step. Interior that holds up no skin prints nothing.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};
use std::sync::Arc;

use rayon::prelude::*;

use crate::adaptive::LayerBand;
use crate::poly::{
    boolean_diff, boolean_intersect, drop_slivers, in_solid, loop_bounds, offset_loops, Loop,
};
use crate::toolpath::Skin;

/// Steepest lean of a branch from vertical, degrees.
const LEAN_DEG: f64 = 40.0;
/// Spacing of the points along a wall that branches end on, mm.
const WALL_SAMPLE_MM: f64 = 1.4;
/// A node leans on a neighbour at most this many grid pitches away.
const REACH_PITCHES: f64 = 1.5;

/// One layer's planned branches, as segments in the part's frame.
pub(crate) type Branches = Arc<Vec<[[f64; 2]; 2]>>;

/// The branches of every layer, grown for one interior inset and pitch.
pub(crate) struct Lightning {
    /// Walls the interior was inset by, so a strategy can tell it fits.
    pub walls: u32,
    /// Grid pitch, mm.
    pub pitch: f64,
    pub layers: Vec<Branches>,
}

/// A grid cell, by integer coordinates at the grid pitch.
type Key = (i64, i64);

/// One layer's tree before budgets: wall points first, grid nodes after.
#[derive(Default)]
struct Tree {
    xy: Vec<[f64; 2]>,
    /// Distance to the nearest wall point. Zero on a wall point.
    dist: Vec<f64>,
    /// Length of the chain from the node to the wall, through its parents.
    /// A chain backs off along this, so its tip moves at most one step a layer.
    along: Vec<f64>,
    /// The node each node leans on, closer to a wall.
    parent: Vec<Option<usize>>,
    /// Grid cell of each grid node, `None` on a wall point.
    key: Vec<Option<Key>>,
    /// True for a grid node under the next layer's top skin.
    seeded: Vec<bool>,
}

/// Grow the branches of every layer. `contours` are the part's layers and
/// `skins` their skin at the depths of the strategy that prints lightning.
/// The interior is each contour inset by `walls` beads of `line_width`, less
/// its skin.
pub(crate) fn grow(
    bands: &[LayerBand],
    contours: &[Vec<Loop>],
    skins: &[Arc<Skin>],
    walls: u32,
    line_width: f64,
    pitch: f64,
) -> Lightning {
    let n = bands.len();
    let inset = walls.max(1) as f64 * line_width;
    let interiors: Vec<Vec<Loop>> = (0..n)
        .into_par_iter()
        .map(|i| interior(&contours[i], &skins[i], inset))
        .collect();
    let trees: Vec<Tree> = (0..n)
        .into_par_iter()
        .map(|i| {
            let over = skins.get(i + 1).map(|s| s.top.as_slice()).unwrap_or(&[]);
            tree(&interiors[i], over, pitch)
        })
        .collect();
    // Budgets run top-down: each layer's chains are the next layer's, one
    // step shorter, plus whatever skin the next layer asks to hold.
    let tan = LEAN_DEG.to_radians().tan();
    let mut carry: HashMap<Key, f64> = HashMap::new();
    let mut layers = vec![Branches::default(); n];
    for i in (0..n).rev() {
        let step = bands
            .get(i + 1)
            .map(|b| b.height)
            .unwrap_or(bands[i].height)
            * tan;
        let t = &trees[i];
        let mut budget: Vec<f64> = (0..t.xy.len())
            .map(|k| {
                let held = t.key[k]
                    .and_then(|key| carry.get(&key))
                    .map(|b| b - step)
                    .unwrap_or(0.0);
                let seed = if t.seeded[k] { t.along[k] } else { 0.0 };
                held.max(seed).max(0.0)
            })
            .collect();
        // A chain is printed from the wall out to its budget, so a node's
        // budget reaches every node it leans on, nearest the wall last.
        let mut order: Vec<usize> = (0..t.xy.len()).filter(|&k| t.key[k].is_some()).collect();
        order.sort_by(|&a, &b| t.along[b].total_cmp(&t.along[a]));
        for &k in &order {
            if let Some(p) = t.parent[k] {
                budget[p] = budget[p].max(budget[k]);
            }
        }
        let mut segs = Vec::new();
        for &k in &order {
            let Some(p) = t.parent[k] else {
                continue;
            };
            let (b, dk, dp) = (budget[k], t.along[k], t.along[p]);
            if b <= dp + 1e-9 {
                continue;
            }
            let (a, z) = (t.xy[p], t.xy[k]);
            let end = if b >= dk || dk - dp <= 1e-9 {
                z
            } else {
                let f = (b - dp) / (dk - dp);
                [a[0] + (z[0] - a[0]) * f, a[1] + (z[1] - a[1]) * f]
            };
            if (end[0] - a[0]).hypot(end[1] - a[1]) >= 0.05 {
                segs.push([a, end]);
            }
        }
        carry = order
            .iter()
            .filter(|&&k| budget[k] > 1e-9)
            .filter_map(|&k| t.key[k].map(|key| (key, budget[k])))
            .collect();
        layers[i] = Arc::new(segs);
    }
    Lightning {
        walls,
        pitch,
        layers,
    }
}

/// What lightning may fill on a layer: inside the walls, outside the skin.
fn interior(contour: &[Loop], skin: &Skin, inset: f64) -> Vec<Loop> {
    if contour.is_empty() {
        return Vec::new();
    }
    let inside = offset_loops(contour, -inset);
    let mut skin_area = skin.bottom.clone();
    skin_area.extend(skin.top.iter().cloned());
    if inside.is_empty() || skin_area.is_empty() {
        return inside;
    }
    drop_slivers(
        boolean_diff(&inside, &crate::poly::resolve_nonzero(skin_area)),
        0.05,
    )
}

/// The tree of one layer's `interior`, with the grid nodes under `over`, the
/// top skin of the layer above, marked as seeds.
fn tree(interior: &[Loop], over: &[Loop], pitch: f64) -> Tree {
    let mut t = Tree::default();
    let Some((min, max)) = loop_bounds(interior) else {
        return t;
    };
    // Every loop bounds the interior: a wall, a hole's wall, or skin.
    for ring in interior {
        let m = ring.len();
        let mut acc = WALL_SAMPLE_MM;
        for k in 0..m {
            let (a, b) = (ring[k], ring[(k + 1) % m]);
            let len = (b[0] - a[0]).hypot(b[1] - a[1]);
            let mut s = 0.0;
            while s < len {
                if acc >= WALL_SAMPLE_MM {
                    let f = s / len.max(1e-12);
                    t.xy.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
                    acc = 0.0;
                }
                let next = (WALL_SAMPLE_MM - acc).min(len - s);
                s += next;
                acc += next;
            }
        }
    }
    let walls = t.xy.len();
    if walls == 0 {
        return t;
    }
    t.key = vec![None; walls];
    let cell = |v: f64| (v / pitch).floor() as i64;
    for gy in cell(min[1])..=cell(max[1]) {
        for gx in cell(min[0])..=cell(max[0]) {
            let p = [(gx as f64 + 0.5) * pitch, (gy as f64 + 0.5) * pitch];
            if in_solid(interior, p[0], p[1]) {
                t.xy.push(p);
                t.key.push(Some((gx, gy)));
            }
        }
    }
    let wall_grid = Hash::new(&t.xy[..walls], pitch);
    t.dist =
        t.xy.iter()
            .enumerate()
            .map(|(k, p)| {
                if k < walls {
                    0.0
                } else {
                    wall_grid.nearest(*p).1
                }
            })
            .collect();
    // Shortest paths out from the walls over edges that stay inside. An
    // edge whose ends are both clear of every wall point by more than half
    // its length plus the wall points' spacing cannot cross a wall.
    let all = Hash::new(&t.xy, pitch);
    let reach = pitch * REACH_PITCHES;
    let inside = |a: usize, b: usize| {
        let (p, q) = (t.xy[a], t.xy[b]);
        let len = (q[0] - p[0]).hypot(q[1] - p[1]);
        if t.dist[a].min(t.dist[b]) > len * 0.5 + WALL_SAMPLE_MM {
            return true;
        }
        [0.25, 0.5, 0.75].iter().all(|f| {
            in_solid(interior, p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f)
        })
    };
    t.along = vec![f64::INFINITY; t.xy.len()];
    t.parent = vec![None; t.xy.len()];
    let mut heap = BinaryHeap::new();
    for k in 0..walls {
        t.along[k] = 0.0;
    }
    // Every grid node first reaches the walls in one step where it can.
    for k in walls..t.xy.len() {
        for j in all.within(t.xy[k], reach) {
            if j < walls && inside(k, j) {
                let d = (t.xy[j][0] - t.xy[k][0]).hypot(t.xy[j][1] - t.xy[k][1]);
                if d < t.along[k] {
                    t.along[k] = d;
                    t.parent[k] = Some(j);
                }
            }
        }
        if t.parent[k].is_some() {
            heap.push(Reverse((Ordered(t.along[k]), k)));
        }
    }
    while let Some(Reverse((Ordered(d), k))) = heap.pop() {
        if d > t.along[k] {
            continue;
        }
        for j in all.within(t.xy[k], reach) {
            if j < walls || j == k {
                continue;
            }
            let step = (t.xy[j][0] - t.xy[k][0]).hypot(t.xy[j][1] - t.xy[k][1]);
            if d + step < t.along[j] - 1e-9 && inside(k, j) {
                t.along[j] = d + step;
                t.parent[j] = Some(k);
                heap.push(Reverse((Ordered(t.along[j]), j)));
            }
        }
    }
    for a in t.along.iter_mut() {
        if !a.is_finite() {
            *a = 0.0;
        }
    }
    let held = if over.is_empty() {
        Vec::new()
    } else {
        let under = boolean_intersect(over, interior);
        if under.is_empty() {
            Vec::new()
        } else {
            offset_loops(&under, pitch * 0.75)
        }
    };
    t.seeded = (0..t.xy.len())
        .map(|k| k >= walls && !held.is_empty() && in_solid(&held, t.xy[k][0], t.xy[k][1]))
        .collect();
    t
}

/// Points hashed into cells of one pitch.
struct Hash<'a> {
    pts: &'a [[f64; 2]],
    cell: f64,
    buckets: HashMap<Key, Vec<usize>>,
}

impl<'a> Hash<'a> {
    fn new(pts: &'a [[f64; 2]], cell: f64) -> Self {
        let mut buckets: HashMap<Key, Vec<usize>> = HashMap::new();
        for (k, p) in pts.iter().enumerate() {
            buckets.entry(Self::key_of(*p, cell)).or_default().push(k);
        }
        Self { pts, cell, buckets }
    }

    fn key_of(p: [f64; 2], cell: f64) -> Key {
        ((p[0] / cell).floor() as i64, (p[1] / cell).floor() as i64)
    }

    /// The nearest point and its distance, searching rings of cells out from `p`.
    fn nearest(&self, p: [f64; 2]) -> (usize, f64) {
        let (cx, cy) = Self::key_of(p, self.cell);
        let mut best = (usize::MAX, f64::MAX);
        let mut ring = 0i64;
        loop {
            for dx in -ring..=ring {
                for dy in -ring..=ring {
                    if dx.abs() != ring && dy.abs() != ring {
                        continue;
                    }
                    for &k in self.buckets.get(&(cx + dx, cy + dy)).into_iter().flatten() {
                        let q = self.pts[k];
                        let d = (q[0] - p[0]).hypot(q[1] - p[1]);
                        if d < best.1 {
                            best = (k, d);
                        }
                    }
                }
            }
            // Every point outside this ring is at least `ring` cells away.
            if best.0 != usize::MAX && best.1 <= ring as f64 * self.cell {
                return best;
            }
            ring += 1;
            if ring > 1 << 16 {
                return best;
            }
        }
    }

    /// Every point within `reach` of `p`.
    fn within(&self, p: [f64; 2], reach: f64) -> Vec<usize> {
        let (cx, cy) = Self::key_of(p, self.cell);
        let r = (reach / self.cell).ceil() as i64;
        let mut out = Vec::new();
        for dx in -r..=r {
            for dy in -r..=r {
                for &k in self.buckets.get(&(cx + dx, cy + dy)).into_iter().flatten() {
                    let q = self.pts[k];
                    if (q[0] - p[0]).hypot(q[1] - p[1]) <= reach {
                        out.push(k);
                    }
                }
            }
        }
        out
    }
}

/// An `f64` ordered by `total_cmp`, for the shortest-path heap.
#[derive(Clone, Copy, PartialEq)]
struct Ordered(f64);

impl Eq for Ordered {}

impl PartialOrd for Ordered {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Ordered {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.0.total_cmp(&other.0)
    }
}
