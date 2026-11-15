//! Support stability, read from the emitted beads: how tall each
//! free-standing support is against how wide it stands, its thinnest
//! section, and the support beads that rest on nothing.
//!
//! A free-standing support is a set of support beads joined on their own
//! layer and from layer to layer: a tree with every limb merged into it, or
//! a connected grid column. Two trees whose beads touch are one support,
//! which is how they print. Interface beads are left out of the supports
//! (a roof of interface would join every tree under it) but still count as
//! something a support bead can rest on.
//!
//! Heights and widths are in the plate frame: up is real gravity, so on a
//! belt the tilted layers are read in the lab. A section is the support's
//! beads within one millimetre of lab height, seen from above, with a bead
//! width added to the spread of the bead centre lines.

use std::collections::{HashMap, HashSet};

use rayon::prelude::*;
use serde::Serialize;

use super::{picked_samples, samples, HoldLayer, HoldRule, Rows, Sample, HOLD_BELT_MM};
use crate::toolpath::PathKind;

/// The height a free-standing support may reach against its base width,
/// measured in its thinnest direction: the plan's rule of thumb, until a
/// pillar coupon calibrates it.
pub const SLENDER_LIMIT: f64 = 10.0;
/// A layer that prints only supports and takes less than this many seconds
/// is short: its thin columns get no time to set.
pub const SHORT_LAYER_S: f64 = 4.0;
/// Supports and layers kept in each list, as [`super::HOLD_PATCHES_KEPT`].
pub const STABILITY_KEPT: usize = super::HOLD_PATCHES_KEPT;
/// Lab height of one section.
const SLAB_MM: f64 = 1.0;
/// The base is the section this far above the support's bottom, past the
/// one-layer pad on a flat bed and the spread foot on a belt. A support
/// shorter than this plus a section reads its base at the bottom.
const BASE_FROM_MM: f64 = 3.0;
/// A section with nothing of the support this far above it is a tip, not a
/// section the support stands on, and is left out of the thinnest one.
const TIP_MM: f64 = 2.0;
/// Bead centre lines this close on one layer, or in one section, are one piece.
const JOIN_MM: f64 = 0.7;
/// A support bead this close to one on the layer below, where gravity
/// carries it, belongs to the same support. Wide enough to join a trunk to
/// a hollow foot ring it prints inside of.
const STACK_MM: f64 = 1.25;
/// Directions a section's width is measured in, over half a turn.
const DIRECTIONS: usize = 36;

/// How the supports of a slice stand.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportStability {
    /// Free-standing supports.
    pub supports: usize,
    /// Support bead length checked, interface left out.
    pub support_mm: f64,
    /// Support bead with no support, interface or part bead under at least
    /// half its width on the layer below, and neither the bed nor the belt.
    /// Part beads count within the Z gap under it.
    pub unrested_mm: f64,
    /// Layers with any such bead.
    pub unrested_layers: usize,
    /// The largest height against base width, 0 with no support.
    pub worst_slenderness: f64,
    /// Supports over [`SLENDER_LIMIT`].
    pub over_limit: usize,
    /// The thinnest section of any support below its tips, mm.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinnest_mm: Option<f64>,
    /// Layers whose only extrusion is support or interface.
    pub support_only_layers: usize,
    /// Of those, the ones under [`SHORT_LAYER_S`]. Absent where no layer
    /// times are known (the CLI audit plans without writing G-code).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub short_layers: Option<usize>,
    /// Support-only layers, the quickest first (by time when known, else by
    /// bead length), at most [`STABILITY_KEPT`].
    pub quickest_layers: Vec<SupportOnlyLayer>,
    /// The most slender supports first, at most [`STABILITY_KEPT`].
    pub most_slender: Vec<SupportColumn>,
    /// Supports with unrested beads, the most first, at most [`STABILITY_KEPT`].
    pub most_unrested: Vec<SupportColumn>,
    /// Every support-only layer, until [`SupportStability::finish`] counts them.
    #[serde(skip)]
    support_only: Vec<SupportOnlyLayer>,
}

/// One free-standing support.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportColumn {
    /// From its lowest bead's bottom to its highest bead, along gravity.
    pub height_mm: f64,
    /// Base section width in its thinnest and widest directions.
    pub base_min_mm: f64,
    pub base_max_mm: f64,
    /// Base section width along plate X (across a belt) and plate Y (along a belt).
    pub base_across_mm: f64,
    pub base_along_mm: f64,
    /// The lowest section's width in its thinnest direction: the foot.
    pub foot_min_mm: f64,
    /// Its thinnest section below its tips, in its thinnest direction, and
    /// that section's height above the support's bottom. Absent on a support
    /// too short to have a section below its tips.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinnest_mm: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinnest_at_mm: Option<f64>,
    /// Height over the base's thinnest width.
    pub slenderness: f64,
    pub stands_on: Stand,
    /// The middle of its lowest section, at its bottom, in the plate frame.
    pub at: [f64; 3],
    /// First and last printed layer, counted from 0.
    pub layers: [usize; 2],
    pub support_mm: f64,
    pub unrested_mm: f64,
    /// Its first unrested bead, in the plate frame.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unrested_at: Option<[f64; 3]>,
}

/// What a support's lowest beads stand on. Bed or belt wins over the part,
/// and the part over air.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Stand {
    #[default]
    Bed,
    Belt,
    Part,
    /// Only on other support or interface beads, as a trunk on a roof of interface.
    Support,
    /// Nothing: its lowest beads hang in the air.
    Air,
}

/// A layer that prints only supports.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportOnlyLayer {
    pub layer: usize,
    /// Support and interface bead length on it.
    pub support_mm: f64,
    /// Its estimated print time, when the G-code was written.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seconds: Option<f64>,
}

impl SupportStability {
    /// Count the short support-only layers with the estimator's seconds per
    /// printed layer index, or without when there are none, and keep the
    /// quickest.
    pub(crate) fn finish(mut self, seconds: Option<&HashMap<usize, f64>>) -> Self {
        let mut list = std::mem::take(&mut self.support_only);
        self.support_only_layers = list.len();
        match seconds {
            Some(times) => {
                for layer in &mut list {
                    layer.seconds = times.get(&layer.layer).copied();
                }
                self.short_layers = Some(
                    list.iter()
                        .filter(|l| l.seconds.is_some_and(|s| s < SHORT_LAYER_S))
                        .count(),
                );
                list.sort_by(|a, b| {
                    let (sa, sb) = (
                        a.seconds.unwrap_or(f64::INFINITY),
                        b.seconds.unwrap_or(f64::INFINITY),
                    );
                    sa.total_cmp(&sb).then(a.layer.cmp(&b.layer))
                });
            }
            None => list.sort_by(|a, b| {
                a.support_mm
                    .total_cmp(&b.support_mm)
                    .then(a.layer.cmp(&b.layer))
            }),
        }
        list.truncate(STABILITY_KEPT);
        self.quickest_layers = list;
        self
    }
}

/// What a support bead rests on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Rest {
    Bed,
    Belt,
    Support,
    Part,
    Air,
}

/// The report on printed layers in print order. Call
/// [`SupportStability::finish`] on it before it goes out.
pub(crate) fn support_stability(layers: &[HoldLayer], rule: &HoldRule) -> SupportStability {
    let half = rule.half_bead;
    let width = 2.0 * half;
    let ours: Vec<Vec<Sample>> = layers
        .par_iter()
        .map(|l| picked_samples(l, |kind| kind == PathKind::Support))
        .collect();
    let under: Vec<Rows> = layers
        .par_iter()
        .map(|l| Rows::new(samples(l, false).iter().map(|s| [s.x, s.y]), rule.origin))
        .collect();
    let parts: Vec<Rows> = layers
        .par_iter()
        .map(|l| Rows::new(samples(l, true).iter().map(|s| [s.x, s.y]), rule.origin))
        .collect();
    // What each support sample rests on: a bead under at least half its
    // width, where gravity carries it on that layer.
    let rests: Vec<Vec<Rest>> = (0..layers.len())
        .into_par_iter()
        .map(|li| {
            let z = layers[li].z;
            ours[li]
                .iter()
                .map(|s| {
                    if li == 0 {
                        return if rule.belt.is_some() {
                            Rest::Belt
                        } else {
                            Rest::Bed
                        };
                    }
                    if rule
                        .belt
                        .is_some_and(|f| f.lab(s.x, s.y, z)[2] <= HOLD_BELT_MM)
                    {
                        return Rest::Belt;
                    }
                    let on = |k: usize, rows: &Rows| {
                        let y = s.y + rule.drift(z - layers[li - k].z);
                        rows.hit(s.x, y - half, y + half, half)
                    };
                    if on(1, &under[li - 1]) {
                        Rest::Support
                    } else if (1..=rule.gap_layers + 1)
                        .take_while(|&k| k <= li)
                        .any(|k| on(k, &parts[li - k]))
                    {
                        Rest::Part
                    } else {
                        Rest::Air
                    }
                })
                .collect()
        })
        .collect();
    // Pieces on each layer, then pieces joined from layer to layer.
    let local: Vec<(Vec<usize>, usize)> = ours
        .par_iter()
        .map(|s| {
            let points: Vec<[f64; 2]> = s.iter().map(|s| [s.x, s.y]).collect();
            pieces(&points, JOIN_MM)
        })
        .collect();
    let links: Vec<Vec<(usize, usize)>> = (1..layers.len())
        .into_par_iter()
        .map(|li| {
            let below: Vec<[f64; 2]> = ours[li - 1].iter().map(|s| [s.x, s.y]).collect();
            let grid = Grid::new(&below, STACK_MM);
            let drift = rule.drift(layers[li].z - layers[li - 1].z);
            let mut pairs = HashSet::new();
            for (i, s) in ours[li].iter().enumerate() {
                grid.near([s.x, s.y + drift], STACK_MM, |j| {
                    pairs.insert((local[li].0[i], local[li - 1].0[j]));
                });
            }
            pairs.into_iter().collect()
        })
        .collect();
    let mut base = Vec::with_capacity(layers.len());
    let mut total = 0;
    for (_, n) in &local {
        base.push(total);
        total += n;
    }
    let mut sets = Sets::new(total);
    for (k, pairs) in links.iter().enumerate() {
        let li = k + 1;
        for &(a, b) in pairs {
            sets.join(base[li] + a, base[li - 1] + b);
        }
    }
    let (label, count) = sets.labels();
    let mut members: Vec<Vec<(usize, usize)>> = vec![Vec::new(); count];
    for (li, (pieces, _)) in local.iter().enumerate() {
        for (i, &p) in pieces.iter().enumerate() {
            members[label[base[li] + p]].push((li, i));
        }
    }
    let columns: Vec<SupportColumn> = members
        .par_iter()
        .map(|m| column(m, layers, &ours, &rests, rule, width))
        .collect();

    let mut out = SupportStability {
        supports: columns.len(),
        ..SupportStability::default()
    };
    let mut unrested_layers = HashSet::new();
    for (li, rest) in rests.iter().enumerate() {
        for (s, r) in ours[li].iter().zip(rest) {
            out.support_mm += s.mm;
            if *r == Rest::Air {
                out.unrested_mm += s.mm;
                unrested_layers.insert(li);
            }
        }
    }
    out.unrested_layers = unrested_layers.len();
    for c in &columns {
        out.worst_slenderness = out.worst_slenderness.max(c.slenderness);
        out.over_limit += usize::from(c.slenderness > SLENDER_LIMIT);
        if let Some(t) = c.thinnest_mm {
            out.thinnest_mm = Some(out.thinnest_mm.map_or(t, |o: f64| o.min(t)));
        }
    }
    let mut slender = columns.clone();
    slender.sort_by(|a, b| {
        b.slenderness
            .total_cmp(&a.slenderness)
            .then(a.layers.cmp(&b.layers))
    });
    slender.truncate(STABILITY_KEPT);
    out.most_slender = slender;
    let mut unrested: Vec<SupportColumn> = columns
        .into_iter()
        .filter(|c| c.unrested_mm > 0.0)
        .collect();
    unrested.sort_by(|a, b| {
        b.unrested_mm
            .total_cmp(&a.unrested_mm)
            .then(a.layers.cmp(&b.layers))
    });
    unrested.truncate(STABILITY_KEPT);
    out.most_unrested = unrested;
    out.support_only = layers
        .iter()
        .filter(|l| {
            !l.beads.is_empty()
                && l.beads.iter().all(|&(kind, ..)| {
                    matches!(kind, PathKind::Support | PathKind::SupportInterface)
                })
        })
        .map(|l| SupportOnlyLayer {
            layer: l.index,
            support_mm: samples(l, false).iter().map(|s| s.mm).sum(),
            seconds: None,
        })
        .collect();
    out
}

/// One support's measures from its samples, `(layer, sample)` pairs.
fn column(
    members: &[(usize, usize)],
    layers: &[HoldLayer],
    ours: &[Vec<Sample>],
    rests: &[Vec<Rest>],
    rule: &HoldRule,
    width: f64,
) -> SupportColumn {
    // A layer's thickness in lab height: the layers lean on a belt.
    let upright = rule.belt.map_or(1.0, |f| f.cos_a);
    let thick = |li: usize| {
        let h = match li {
            0 => rule.layer_height,
            _ => layers[li].z - layers[li - 1].z,
        };
        h.max(0.0) * upright
    };
    let points: Vec<[f64; 3]> = members
        .iter()
        .map(|&(li, i)| {
            let s = &ours[li][i];
            rule.plate(s.x, s.y, layers[li].z)
        })
        .collect();
    let (mut low, mut top, mut low_at) = (f64::INFINITY, f64::NEG_INFINITY, 0);
    for (k, p) in points.iter().enumerate() {
        if p[2] < low {
            low = p[2];
            low_at = k;
        }
        top = top.max(p[2]);
    }
    let bottom = low - thick(members[low_at].0);
    let height = top - bottom;
    let slabs_n = ((top - low) / SLAB_MM) as usize + 1;
    let mut slabs: Vec<Vec<[f64; 2]>> = vec![Vec::new(); slabs_n];
    for p in &points {
        let k = (((p[2] - low) / SLAB_MM) as usize).min(slabs_n - 1);
        slabs[k].push([p[0], p[1]]);
    }
    let base_k = if height >= BASE_FROM_MM + SLAB_MM {
        ((BASE_FROM_MM / SLAB_MM) as usize).min(slabs_n - 1)
    } else {
        0
    };
    // The base section, or the lowest one above it that has beads.
    let base = slabs[base_k..]
        .iter()
        .find(|s| !s.is_empty())
        .unwrap_or(&slabs[0]);
    let [base_min, base_max, base_across, base_along] = calipers(base, width);
    let foot_min = calipers(&slabs[0], width)[0];
    let tip_k = (TIP_MM / SLAB_MM).ceil() as usize;
    let mut thinnest: Option<(f64, f64)> = None;
    for k in 0..slabs_n.saturating_sub(tip_k) {
        let slab = &slabs[k];
        if slab.is_empty() {
            continue;
        }
        let above = &slabs[k + tip_k];
        let (label, n) = pieces(slab, JOIN_MM);
        let mut groups: Vec<Vec<[f64; 2]>> = vec![Vec::new(); n];
        for (p, &l) in slab.iter().zip(&label) {
            groups[l].push(*p);
        }
        for g in &groups {
            let (min, max) = bounds(g);
            let carried = above.iter().any(|p| {
                p[0] >= min[0] - TIP_MM
                    && p[0] <= max[0] + TIP_MM
                    && p[1] >= min[1] - TIP_MM
                    && p[1] <= max[1] + TIP_MM
            });
            if !carried {
                continue;
            }
            let w = calipers(g, width)[0];
            if thinnest.is_none_or(|(t, _)| w < t) {
                thinnest = Some((w, (k as f64 + 0.5) * SLAB_MM));
            }
        }
    }
    let foot = &slabs[0];
    let n = foot.len().max(1) as f64;
    let at = [
        foot.iter().map(|p| p[0]).sum::<f64>() / n,
        foot.iter().map(|p| p[1]).sum::<f64>() / n,
        bottom,
    ];
    let mut on = [false; 5];
    let mut support_mm = 0.0;
    let mut unrested_mm = 0.0;
    let mut first_air: Option<(usize, usize)> = None;
    let (mut first_layer, mut last_layer) = (usize::MAX, 0);
    for (k, &(li, i)) in members.iter().enumerate() {
        let rest = rests[li][i];
        let mm = ours[li][i].mm;
        support_mm += mm;
        first_layer = first_layer.min(layers[li].index);
        last_layer = last_layer.max(layers[li].index);
        on[rest as usize] = true;
        if rest == Rest::Air {
            unrested_mm += mm;
            if first_air.is_none_or(|(l, _)| li < l) {
                first_air = Some((li, k));
            }
        }
    }
    let stands_on = if on[Rest::Bed as usize] {
        Stand::Bed
    } else if on[Rest::Belt as usize] {
        Stand::Belt
    } else if on[Rest::Part as usize] {
        Stand::Part
    } else if on[Rest::Air as usize] {
        Stand::Air
    } else {
        Stand::Support
    };
    SupportColumn {
        height_mm: height,
        base_min_mm: base_min,
        base_max_mm: base_max,
        base_across_mm: base_across,
        base_along_mm: base_along,
        foot_min_mm: foot_min,
        thinnest_mm: thinnest.map(|t| t.0),
        thinnest_at_mm: thinnest.map(|t| t.1),
        slenderness: height / base_min.max(1e-9),
        stands_on,
        at,
        layers: [first_layer, last_layer],
        support_mm,
        unrested_mm,
        unrested_at: first_air.map(|(_, k)| points[k]),
    }
}

fn bounds(points: &[[f64; 2]]) -> ([f64; 2], [f64; 2]) {
    let mut min = [f64::INFINITY; 2];
    let mut max = [f64::NEG_INFINITY; 2];
    for p in points {
        for a in 0..2 {
            min[a] = min[a].min(p[a]);
            max[a] = max[a].max(p[a]);
        }
    }
    (min, max)
}

/// A section's printed width from its bead centre lines: the thinnest and
/// widest over [`DIRECTIONS`], then along X and along Y, each with a bead
/// width added.
fn calipers(points: &[[f64; 2]], width: f64) -> [f64; 4] {
    if points.is_empty() {
        return [0.0; 4];
    }
    let mut spans = [0.0; DIRECTIONS];
    for (d, span) in spans.iter_mut().enumerate() {
        let a = d as f64 * std::f64::consts::PI / DIRECTIONS as f64;
        let (s, c) = a.sin_cos();
        let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
        for p in points {
            let t = p[0] * c + p[1] * s;
            lo = lo.min(t);
            hi = hi.max(t);
        }
        *span = hi - lo + width;
    }
    let min = spans.iter().copied().fold(f64::INFINITY, f64::min);
    let max = spans.iter().copied().fold(0.0, f64::max);
    [min, max, spans[0], spans[DIRECTIONS / 2]]
}

/// Points binned in square cells, for finding near neighbours.
struct Grid<'a> {
    points: &'a [[f64; 2]],
    cell: f64,
    cells: HashMap<(i64, i64), Vec<usize>>,
}

impl<'a> Grid<'a> {
    fn new(points: &'a [[f64; 2]], cell: f64) -> Self {
        let mut cells: HashMap<(i64, i64), Vec<usize>> = HashMap::new();
        for (i, p) in points.iter().enumerate() {
            cells.entry(Self::key(p, cell)).or_default().push(i);
        }
        Self {
            points,
            cell,
            cells,
        }
    }

    fn key(p: &[f64; 2], cell: f64) -> (i64, i64) {
        ((p[0] / cell).floor() as i64, (p[1] / cell).floor() as i64)
    }

    /// Calls `f` with every point within `reach` of `p`.
    fn near(&self, p: [f64; 2], reach: f64, mut f: impl FnMut(usize)) {
        let (cx, cy) = Self::key(&p, self.cell);
        let r = (reach / self.cell).ceil() as i64;
        for dx in -r..=r {
            for dy in -r..=r {
                let Some(list) = self.cells.get(&(cx + dx, cy + dy)) else {
                    continue;
                };
                for &j in list {
                    let q = self.points[j];
                    if (q[0] - p[0]).powi(2) + (q[1] - p[1]).powi(2) <= reach * reach {
                        f(j);
                    }
                }
            }
        }
    }
}

/// Points joined when within `reach` of each other: a label per point, and
/// the number of pieces.
fn pieces(points: &[[f64; 2]], reach: f64) -> (Vec<usize>, usize) {
    let grid = Grid::new(points, reach);
    let mut sets = Sets::new(points.len());
    for (i, p) in points.iter().enumerate() {
        grid.near(*p, reach, |j| {
            if j < i {
                sets.join(i, j);
            }
        });
    }
    sets.labels()
}

/// Disjoint sets over `0..n`.
struct Sets(Vec<usize>);

impl Sets {
    fn new(n: usize) -> Self {
        Self((0..n).collect())
    }

    fn find(&mut self, mut a: usize) -> usize {
        while self.0[a] != a {
            self.0[a] = self.0[self.0[a]];
            a = self.0[a];
        }
        a
    }

    fn join(&mut self, a: usize, b: usize) {
        let (a, b) = (self.find(a), self.find(b));
        if a != b {
            self.0[a.max(b)] = a.min(b);
        }
    }

    /// A label from 0 per set, and how many sets.
    fn labels(&mut self) -> (Vec<usize>, usize) {
        let mut slot = HashMap::new();
        let labels = (0..self.0.len())
            .map(|i| {
                let root = self.find(i);
                let n = slot.len();
                *slot.entry(root).or_insert(n)
            })
            .collect();
        (labels, slot.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audit::HoldLayer;

    fn ring(c: [f64; 2], r: f64) -> Vec<[f64; 2]> {
        (0..=24)
            .map(|k| {
                let a = k as f64 * std::f64::consts::TAU / 24.0;
                [c[0] + r * a.cos(), c[1] + r * a.sin()]
            })
            .collect()
    }

    type Stack = [Vec<(PathKind, Vec<[f64; 2]>)>];

    fn layers_of(stack: &Stack) -> Vec<HoldLayer<'_>> {
        stack
            .iter()
            .enumerate()
            .map(|(i, beads)| HoldLayer {
                index: i,
                z: 0.2 * (i + 1) as f64,
                beads: beads
                    .iter()
                    .map(|(k, p)| (*k, p.as_slice(), [0.0, 0.0]))
                    .collect(),
            })
            .collect()
    }

    fn check(stack: &Stack) -> SupportStability {
        let rule = HoldRule::new(0.45, 0.2, 0.2, None);
        support_stability(&layers_of(stack), &rule).finish(None)
    }

    #[test]
    fn a_column_of_rings_rests_on_itself_and_counts_its_slenderness() {
        // A 2 mm ring stacked 100 layers: 20 mm tall, 2.45 mm wide.
        let stack: Vec<_> = (0..100)
            .map(|_| vec![(PathKind::Support, ring([5.0, 5.0], 1.0))])
            .collect();
        let s = check(&stack);
        assert_eq!(s.supports, 1, "{s:?}");
        assert_eq!(s.unrested_mm, 0.0, "{s:?}");
        let c = &s.most_slender[0];
        assert!((c.height_mm - 20.0).abs() < 1e-6, "{c:?}");
        assert!((c.base_min_mm - 2.45).abs() < 0.05, "{c:?}");
        assert!((c.slenderness - 20.0 / c.base_min_mm).abs() < 1e-9, "{c:?}");
        assert_eq!(c.stands_on, Stand::Bed);
        assert_eq!(s.support_only_layers, 100);
        assert!(s.short_layers.is_none());
    }

    #[test]
    fn a_disk_inside_a_hollow_foot_is_unrested_but_one_support() {
        // Layer 0 a 4 mm ring, layer 1 up a 1.2 mm ring inside it.
        let mut stack = vec![vec![
            (PathKind::Support, ring([0.0, 0.0], 1.77)),
            (PathKind::Support, ring([0.0, 0.0], 1.32)),
        ]];
        for _ in 0..10 {
            stack.push(vec![(PathKind::Support, ring([0.0, 0.0], 0.55))]);
        }
        let s = check(&stack);
        assert_eq!(s.supports, 1, "{s:?}");
        let unrested = std::f64::consts::TAU * 0.55;
        assert!((s.unrested_mm - unrested).abs() < 0.1, "{s:?}");
        assert_eq!(s.unrested_layers, 1);
        let c = &s.most_unrested[0];
        assert_eq!(c.stands_on, Stand::Bed);
        assert!((c.unrested_at.unwrap()[2] - 0.4).abs() < 1e-9, "{c:?}");
    }

    #[test]
    fn interface_holds_a_bead_but_is_no_support_of_its_own() {
        let stack = vec![
            vec![(PathKind::Wall, vec![[0.0, 0.0], [10.0, 0.0]])],
            vec![(PathKind::SupportInterface, vec![[0.0, 3.0], [10.0, 3.0]])],
            vec![(PathKind::Support, vec![[0.0, 3.0], [10.0, 3.0]])],
            vec![(PathKind::Support, vec![[0.0, 6.0], [10.0, 6.0]])],
        ];
        let s = check(&stack);
        assert_eq!(s.supports, 2, "{s:?}");
        assert!((s.support_mm - 20.0).abs() < 1e-9, "{s:?}");
        assert!((s.unrested_mm - 10.0).abs() < 1e-9, "{s:?}");
        let air = &s.most_unrested[0];
        assert_eq!(air.stands_on, Stand::Air);
        assert_eq!(air.layers, [3, 3]);
        assert!(s.most_slender.iter().any(|c| c.stands_on == Stand::Support));
        // A line is as thin as a bead. Samples sit mid-step, 0.1 mm in from
        // each end.
        assert!((air.base_min_mm - 0.45).abs() < 1e-9, "{air:?}");
        assert!((air.base_max_mm - 10.25).abs() < 1e-9, "{air:?}");
    }

    #[test]
    fn times_count_the_short_support_only_layers() {
        let stack: Vec<_> = (0..3)
            .map(|_| vec![(PathKind::Support, ring([5.0, 5.0], 1.0))])
            .collect();
        let layers = layers_of(&stack);
        let rule = HoldRule::new(0.45, 0.2, 0.2, None);
        let times: HashMap<usize, f64> = [(0, 10.0), (1, 2.0), (2, 3.0)].into();
        let s = support_stability(&layers, &rule).finish(Some(&times));
        assert_eq!(s.short_layers, Some(2));
        let order: Vec<usize> = s.quickest_layers.iter().map(|l| l.layer).collect();
        assert_eq!(order, [1, 2, 0]);
    }
}
