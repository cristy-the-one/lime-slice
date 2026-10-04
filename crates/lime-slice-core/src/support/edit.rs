//! Edits to grown trees. An edit tombstones limbs and never changes a kept
//! knot, then stands again only the layers it changed.

use std::collections::HashMap;

use rayon::prelude::*;
use serde::Serialize;

#[cfg(test)]
use super::NodeId;
use super::{
    lean_of, load_factor_of, organic_disks, section_load, solid_area, stand, tip_radius, union_all,
    CellGrid, CoverageGap, End, Fixed, Life, Limb, Node, Pitch, SupportLayer, SupportStyle,
    Supports, Walk, COVERAGE_OUTLINE_MM, UNHELD_PIECE_MM2,
};
use crate::adaptive::LayerBand;
use crate::poly::{boolean_diff, boolean_intersect, drop_slivers, offset_loops, Loop};

/// Where a limb is born: the xy of its first knot, at the `z` of its top
/// layer. Walk ids renumber whenever the input changes and a birth site does
/// not, so edits name limbs by it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TipSite {
    pub xy: [f64; 2],
    pub z: f64,
}

/// A change to grown trees. A list of them replays in order on a fresh build.
#[derive(Clone, Debug, PartialEq)]
pub enum SupportEdit {
    /// Remove the limbs born at `sites`, then trim what no longer carries a
    /// surviving tip. A branch and a whole tree differ only in their sites.
    Prune { sites: Vec<TipSite> },
    /// Grow fresh limbs for the demand inside `region` that nothing prints,
    /// on the layers whose `z` lies within `z`, low then high. Kept limbs
    /// never change: the new ones lean toward them, join one only where it
    /// is already thick enough, and otherwise keep clear of them.
    Regrow { region: Vec<Loop>, z: [f64; 2] },
}

#[cfg(test)]
impl SupportEdit {
    /// One regrow over `gaps`, across every layer they span. A gap's outline
    /// is only its highest layer, and a layer under it can reach past that,
    /// so the region is each gap's box, which holds it on every layer.
    pub(crate) fn over_gaps(gaps: &[CoverageGap]) -> Self {
        let corner = |p: [f32; 2]| [f64::from(p[0]), f64::from(p[1])];
        SupportEdit::Regrow {
            region: gaps
                .iter()
                .map(|g| {
                    let (lo, hi) = (corner(g.min), corner(g.max));
                    vec![lo, [hi[0], lo[1]], hi, [lo[0], hi[1]]]
                })
                .collect(),
            z: [
                gaps.iter().map(|g| g.z[0]).fold(f64::INFINITY, f64::min),
                gaps.iter()
                    .map(|g| g.z[1])
                    .fold(f64::NEG_INFINITY, f64::max),
            ],
        }
    }
}

/// What one edit did.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct EditOutcome {
    pub status: EditStatus,
    /// Layers whose printed support changed, ascending.
    pub changed: Vec<usize>,
    /// Layers stood again before one that came out unchanged stopped the rebuild.
    pub stood: usize,
    /// Coverage area after the edit less the area before it, mm², specks included.
    pub newly_floating_mm2: f64,
    /// Coverage gaps the edit leaves, specks included: for a prune the ones
    /// that were not there before it, for a regrow the ones whose outline
    /// still meets its region.
    pub floating: Vec<CoverageGap>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum EditStatus {
    /// Every site matched a limb born where the site says.
    Applied,
    /// Every site matched, the farthest one `moved_mm` away: more than
    /// `REBOUND_MM` across, or born on another layer.
    Rebound { moved_mm: f64 },
    /// `missed` of the edit's targets matched nothing: sites that matched
    /// no limb, or a regrow's region with no unheld demand in it. The rest
    /// still applied.
    Stale { missed: usize },
}

/// A limb born this close across to a site, on the site's layer, is the
/// tip the site was taken from.
const REBOUND_MM: f64 = 0.3;

/// A regrow's region is widened by this. A coverage gap's outline is
/// simplified, so it can sit up to the tolerance inside the area it reports.
const REGION_SLOP_MM: f64 = 2.0 * COVERAGE_OUTLINE_MM;

impl Supports {
    /// Apply `edits` in order. Each one prunes or regrows, then stands again
    /// only the layers it changed.
    pub(crate) fn apply(
        &mut self,
        edits: &[SupportEdit],
        bands: &[LayerBand],
        contours: &[Vec<Loop>],
    ) -> Vec<EditOutcome> {
        let mut outcomes = Vec::with_capacity(edits.len());
        if edits.is_empty() {
            return outcomes;
        }
        let area = |gaps: &[CoverageGap]| gaps.iter().map(|g| f64::from(g.area_mm2)).sum::<f64>();
        // The edit's own gaps keep the specks the slice-wide warning hides:
        // the user removed what held them.
        let mut before = self.coverage_from(bands, contours, 0.0);
        for edit in edits {
            let by = self.edits;
            self.edits += 1;
            let (status, dirty) = match edit {
                SupportEdit::Prune { sites } => self.prune(sites, bands, by),
                SupportEdit::Regrow { region, z } => self.regrow(region, *z, bands, contours, by),
            };
            let (changed, stood) = self.rebuild(&dirty, bands, contours);
            let after = if changed.is_empty() {
                before.clone()
            } else {
                self.coverage_from(bands, contours, 0.0)
            };
            outcomes.push(EditOutcome {
                status,
                changed,
                stood,
                newly_floating_mm2: area(&after) - area(&before),
                floating: match edit {
                    SupportEdit::Prune { .. } => after
                        .iter()
                        .filter(|g| !before.contains(g))
                        .cloned()
                        .collect(),
                    SupportEdit::Regrow { region, z } => gaps_in(&after, region, *z),
                },
            });
            before = after;
        }
        outcomes
    }

    /// Tombstone the limbs born at `sites` and trim what then carries
    /// nothing. Returns how the sites matched and, per layer, whether a knot
    /// on it stopped printing.
    fn prune(
        &mut self,
        sites: &[TipSite],
        bands: &[LayerBand],
        by: u32,
    ) -> (EditStatus, Vec<bool>) {
        let tol = Pitch::of(&self.opts).keep * 0.5;
        let limbs = &mut self.forest.limbs;
        let mut born: Vec<Vec<usize>> = vec![Vec::new(); bands.len()];
        for (k, l) in limbs.iter().enumerate() {
            born[l.top].push(k);
        }
        let mut pick = vec![false; limbs.len()];
        let (mut missed, mut moved, mut rebound) = (0, 0.0f64, false);
        for s in sites {
            let Some((k, across, dz)) = nearest(s, limbs, &born, bands, tol) else {
                missed += 1;
                continue;
            };
            pick[k] = true;
            moved = moved.max(across.hypot(dz));
            rebound |= across > REBOUND_MM || dz > 1e-6;
        }
        let status = if missed > 0 {
            EditStatus::Stale { missed }
        } else if rebound {
            EditStatus::Rebound { moved_mm: moved }
        } else {
            EditStatus::Applied
        };
        let mut dirty = vec![false; bands.len()];
        // `need[h]` is the highest layer a surviving guest joins limb `h` on.
        // A host has a smaller id than its guests, so walking down the ids
        // settles every guest of a limb before the limb itself.
        let mut need: Vec<Option<usize>> = vec![None; limbs.len()];
        for k in (0..limbs.len()).rev() {
            let limb = &mut limbs[k];
            let pruned = pick[k] || limb.life != Life::Live;
            let by = limb.life.pruned_by().unwrap_or(by);
            let life = match (pruned, need[k]) {
                (false, _) => Life::Live,
                (true, Some(to)) => Life::Trimmed { to, by },
                (true, None) => Life::Removed { by },
            };
            if life != limb.life {
                let was = limb.reach();
                limb.life = life;
                if let Some(was) = was {
                    let from = limb.reach().map_or(limb.bottom(), |to| to + 1);
                    dirty[from..=was].fill(true);
                }
            }
            if let (Some(_), End::Merged { into }) = (limb.reach(), limb.end) {
                let (host, at) = (into.0 as usize - 1, limb.bottom() - 1);
                need[host] = Some(need[host].map_or(at, |to| to.max(at)));
            }
        }
        (status, dirty)
    }

    /// Grow new limbs for the demand in `region` on the layers within `z`
    /// that the layers do not print, walking among the kept limbs as fixed
    /// knots, and restore the interface over that demand. Returns `Stale`
    /// when there is none, and per layer whether the edit touched it.
    fn regrow(
        &mut self,
        region: &[Loop],
        z: [f64; 2],
        bands: &[LayerBand],
        contours: &[Vec<Loop>],
        by: u32,
    ) -> (EditStatus, Vec<bool>) {
        let n = self.layers.len();
        if self.opts.style != SupportStyle::Tree {
            return (EditStatus::Stale { missed: 1 }, vec![false; n]);
        }
        let region = offset_loops(region, REGION_SLOP_MM);
        let masks: Vec<Vec<Loop>> = (0..n)
            .into_par_iter()
            .map(|i| {
                let z_in = bands[i].z >= z[0] - 1e-6 && bands[i].z <= z[1] + 1e-6;
                if !z_in || self.demanded[i].is_empty() {
                    return Vec::new();
                }
                let unheld = boolean_diff(&self.demanded[i], &self.layers[i].interface);
                drop_slivers(boolean_intersect(&unheld, &region), UNHELD_PIECE_MM2)
            })
            .collect();
        let mut dirty = vec![false; n];
        let (Some(lowest), Some(top)) = (
            masks.iter().position(|m| !m.is_empty()),
            masks.iter().rposition(|m| !m.is_empty()),
        ) else {
            return (EditStatus::Stale { missed: 1 }, dirty);
        };
        let first = self.forest.limbs.len();
        // The load each kept limb carries for regrown limbs joined at or
        // above the current layer. Earlier regrows' joins below it wait in
        // `joins`, lowest first.
        let mut extra = vec![0.0; first];
        let mut joins = self.kept_joins();
        let mut walk = Walk::new(
            bands,
            contours,
            &self.demanded,
            &self.opts,
            first as u32 + 1,
        );
        for i in (0..=top).rev() {
            if i < lowest && walk.nodes.is_empty() {
                break;
            }
            let mask = &masks[i];
            let born = if mask.is_empty() || self.born[i].is_empty() {
                Vec::new()
            } else {
                drop_slivers(boolean_intersect(&self.born[i], mask), 0.05)
            };
            walk.arrive(i, &born, mask);
            self.forest.record(i, &walk.nodes);
            let mut fixed = Fixed::new(match i {
                0 => Vec::new(),
                _ => {
                    while let Some(&(_, host, load)) = joins.last().filter(|j| j.0 >= i - 1) {
                        extra[host] += load;
                        joins.pop();
                    }
                    self.kept_at(i - 1, first, &extra, &joins)
                }
            });
            walk.descend(i, &mut fixed, &mut self.forest);
            for (host, load) in fixed.joined {
                extra[host.0 as usize - 1] += load;
            }
        }
        if self.forest.limbs.len() > first {
            self.regrown.push(first);
        }
        for (i, mask) in masks.into_iter().enumerate() {
            if !mask.is_empty() {
                dirty[i] = true;
                self.restored[i].push((by, mask));
            }
        }
        for limb in &self.forest.limbs[first..] {
            dirty[limb.bottom()..=limb.top].fill(true);
        }
        (EditStatus::Applied, dirty)
    }

    /// Knots of the limbs before `first` whose disks stand on `layer`, by
    /// id, as hosts. Each limb carries `extra` more load than it recorded,
    /// and the regrown tips joined `below` on lower layers. A knot's load is
    /// raised so that it takes no more than the tightest of those lower
    /// knots still can.
    fn kept_at(
        &self,
        layer: usize,
        first: usize,
        extra: &[f64],
        below: &[(usize, usize, f64)],
    ) -> Vec<Node> {
        let (tip_r, load_factor) = (tip_radius(&self.opts), load_factor_of(&self.opts));
        let limbs = &self.forest.limbs;
        let mut room: HashMap<usize, (f64, f64)> = HashMap::new();
        for &(at, host, load) in below.iter().rev() {
            let knot = limbs[host].knots[limbs[host].top - at];
            let (carried, least) = room.entry(host).or_insert((extra[host], f64::INFINITY));
            *carried += load;
            *least =
                least.min(section_load(knot.radius, tip_r, load_factor) - knot.load - *carried);
        }
        self.layers[layer]
            .disks
            .iter()
            .map(|d| d.node.0 as usize - 1)
            .filter(|&k| k < first)
            .map(|k| {
                let limb = &limbs[k];
                let mut knot = limb.knots[limb.top - layer];
                knot.load += extra[k];
                if let Some(&(_, least)) = room.get(&k) {
                    let tight = section_load(knot.radius, tip_r, load_factor) - least;
                    knot.load = knot.load.max(tight);
                }
                knot
            })
            .collect()
    }

    /// Every regrown limb still carrying a tip that joined a kept limb: the
    /// layer the kept limb took it on, the kept limb, and the load. Lowest
    /// layer first.
    fn kept_joins(&self) -> Vec<(usize, usize, f64)> {
        let limbs = &self.forest.limbs;
        let mut joins: Vec<(usize, usize, f64)> = self
            .regrown
            .iter()
            .enumerate()
            .flat_map(|(r, &from)| {
                let to = self.regrown.get(r + 1).copied().unwrap_or(limbs.len());
                (from..to).filter_map(move |g| {
                    let limb = &limbs[g];
                    match (limb.end, limb.life) {
                        (_, Life::Removed { .. }) => None,
                        (End::Merged { into }, _) if (into.0 as usize) <= from => Some((
                            limb.bottom() - 1,
                            into.0 as usize - 1,
                            limb.knots[limb.knots.len() - 1].load,
                        )),
                        _ => None,
                    }
                })
            })
            .collect();
        joins.sort_by_key(|j| j.0);
        joins
    }

    /// Stand every layer again from the lowest dirty one up, until a layer
    /// above the highest dirty one comes out as it was. Returns the layers
    /// that changed, ascending, and how many were stood.
    fn rebuild(
        &mut self,
        dirty: &[bool],
        bands: &[LayerBand],
        contours: &[Vec<Loop>],
    ) -> (Vec<usize>, usize) {
        let Some(lo) = dirty.iter().position(|&d| d) else {
            return (Vec::new(), 0);
        };
        let hi = dirty.iter().rposition(|&d| d).unwrap_or(lo);
        let mut fresh = (lo..=hi)
            .into_par_iter()
            .map(|i| dirty[i].then(|| self.fresh(i, contours)))
            .collect::<Vec<_>>()
            .into_iter();
        let lean = lean_of(&self.opts);
        let mut near = Vec::new();
        let (mut changed, mut stood, mut below_changed) = (Vec::new(), 0, false);
        for i in lo..self.layers.len() {
            let pre = if i <= hi {
                fresh.next().flatten()
            } else {
                None
            };
            if pre.is_none() && !below_changed {
                if i > hi {
                    break;
                }
                continue;
            }
            let mut layer = pre.unwrap_or_else(|| self.fresh(i, contours));
            if i > 0 {
                stand(
                    &mut layer,
                    &self.layers[i - 1],
                    i,
                    bands,
                    contours,
                    lean,
                    &mut near,
                );
            }
            stood += 1;
            below_changed = layer != self.layers[i];
            if below_changed {
                changed.push(i);
                self.layers[i] = layer;
            }
        }
        (changed, stood)
    }

    /// Layer `i` as the walk and the edits leave it, before it is stood on
    /// the layer below: the disks of the knots still printed, and the
    /// demanded interface less what only pruned tips held and no later
    /// regrow restored.
    fn fresh(&self, i: usize, contours: &[Vec<Loop>]) -> SupportLayer {
        let mut live = Vec::new();
        let mut pruned = Vec::new();
        for &k in &self.forest.at[i] {
            let limb = &self.forest.limbs[k as usize];
            let knot = limb.knots[limb.top - i];
            if limb.reach().is_some_and(|to| i <= to) {
                live.push(knot);
            } else if let (true, Some(by)) = (knot.freeze > 0, limb.life.pruned_by()) {
                pruned.push((knot.xy, by));
            }
        }
        let pitch = Pitch::of(&self.opts);
        let part = contours.get(i).map(Vec::as_slice).unwrap_or(&[]);
        SupportLayer {
            sparse: self.layers[i].sparse.clone(),
            interface: held_interface(
                &self.demanded[i],
                &pruned,
                &live,
                pitch.keep + pitch.fine,
                &self.restored[i],
            ),
            disks: organic_disks(&live, part, self.opts.xy_gap),
        }
    }
}

/// The limb born nearest `site`, with how far it is across and in z. It is
/// born on the layer whose z is nearest the site's, or else one beside it,
/// and within `tol` across. Pruned limbs count, so pruning the same sites
/// twice matches the same limbs. A live limb wins a tie, so a site a regrow
/// bore a tip on exactly names the regrown limb, not the pruned one.
fn nearest(
    site: &TipSite,
    limbs: &[Limb],
    born: &[Vec<usize>],
    bands: &[LayerBand],
    tol: f64,
) -> Option<(usize, f64, f64)> {
    let n = bands.len();
    if n == 0 {
        return None;
    }
    let dz = |i: usize| (bands[i].z - site.z).abs();
    let above = bands.partition_point(|b| b.z < site.z).min(n - 1);
    let layer = if above > 0 && dz(above - 1) <= dz(above) {
        above - 1
    } else {
        above
    };
    let mut layers = vec![layer];
    layers.extend(layer.checked_sub(1));
    layers.extend((layer + 1 < n).then_some(layer + 1));
    layers.sort_by(|&a, &b| dz(a).total_cmp(&dz(b)));
    let window = bands[layer].height * 1.5 + 1e-6;
    layers
        .into_iter()
        .filter(|&i| dz(i) <= window)
        .find_map(|i| {
            born[i]
                .iter()
                .map(|&k| {
                    let xy = limbs[k].knots[0].xy;
                    (k, (xy[0] - site.xy[0]).hypot(xy[1] - site.xy[1]))
                })
                .filter(|&(_, across)| across <= tol)
                .min_by(|a, b| {
                    let pruned = |k: usize| limbs[k].life != Life::Live;
                    a.1.total_cmp(&b.1).then(pruned(a.0).cmp(&pruned(b.0)))
                })
                .map(|(k, across)| (k, across, dz(i)))
        })
}

/// The gaps on the layers within `z` whose outline meets `region`, widened
/// as a regrow widens it.
pub(crate) fn gaps_in(gaps: &[CoverageGap], region: &[Loop], z: [f64; 2]) -> Vec<CoverageGap> {
    let region = offset_loops(region, REGION_SLOP_MM);
    gaps.iter()
        .filter(|g| {
            g.z[0] <= z[1] + 1e-6
                && g.z[1] >= z[0] - 1e-6
                && solid_area(&boolean_intersect(&region, &outline_loops(g))) > 0.0
        })
        .cloned()
        .collect()
}

/// A gap's outline as loops.
fn outline_loops(g: &CoverageGap) -> Vec<Loop> {
    g.outline
        .iter()
        .map(|l| {
            l.iter()
                .map(|p| [f64::from(p[0]), f64::from(p[1])])
                .collect()
        })
        .collect()
}

/// `demanded` less the part only pruned tips held. Each point is held by
/// the nearest knot on its layer, a frozen tip or a passing trunk, and a
/// point nearest a pruned tip goes, out to `hold` from it, unless a regrow
/// numbered after the tip's prune restored it.
fn held_interface(
    demanded: &[Loop],
    pruned: &[([f64; 2], u32)],
    live: &[Node],
    hold: f64,
    restored: &[(u32, Vec<Loop>)],
) -> Vec<Loop> {
    if pruned.is_empty() || demanded.is_empty() {
        return demanded.to_vec();
    }
    let reach = 2.0 * std::f64::consts::SQRT_2 * hold;
    let mut grid = CellGrid::new(reach);
    for (k, n) in live.iter().enumerate() {
        grid.insert(k, n.xy);
    }
    let mut near = Vec::new();
    let cells: Vec<(Loop, u32)> = pruned
        .iter()
        .filter_map(|&(t, by)| {
            grid.near(t, reach, &mut near);
            let mut rivals: Vec<[f64; 2]> = near.iter().map(|&k| live[k].xy).collect();
            rivals.sort_by(|a, b| dist(*a, t).total_cmp(&dist(*b, t)));
            nearest_cell(t, &rivals, hold).map(|cell| (cell, by))
        })
        .collect();
    let cells = unrestored(cells, restored);
    if cells.is_empty() {
        return demanded.to_vec();
    }
    drop_slivers(boolean_diff(demanded, &cells), 0.05)
}

/// Each cell less what regrows numbered after its tip's prune restored.
fn unrestored(cells: Vec<(Loop, u32)>, restored: &[(u32, Vec<Loop>)]) -> Vec<Loop> {
    if restored.is_empty() {
        return cells.into_iter().map(|(cell, _)| cell).collect();
    }
    let mut prunes: Vec<u32> = cells.iter().map(|&(_, by)| by).collect();
    prunes.sort_unstable();
    prunes.dedup();
    let mut left = Vec::new();
    for by in prunes {
        let mine: Vec<Loop> = cells
            .iter()
            .filter(|c| c.1 == by)
            .map(|c| c.0.clone())
            .collect();
        let back = union_all(restored.iter().filter(|r| r.0 > by).map(|r| r.1.as_slice()));
        left.extend(boolean_diff(&mine, &back));
    }
    left
}

fn dist(a: [f64; 2], b: [f64; 2]) -> f64 {
    (a[0] - b[0]).hypot(a[1] - b[1])
}

/// The square of half-width `hold` around `t`, cut down to the points
/// nearer `t` than any of `rivals`, which come nearest first. `None` when
/// nothing is left.
fn nearest_cell(t: [f64; 2], rivals: &[[f64; 2]], hold: f64) -> Option<Loop> {
    let mut cell: Loop = vec![
        [t[0] - hold, t[1] - hold],
        [t[0] + hold, t[1] - hold],
        [t[0] + hold, t[1] + hold],
        [t[0] - hold, t[1] + hold],
    ];
    let mut far = std::f64::consts::SQRT_2 * hold;
    for &s in rivals {
        let d = dist(s, t);
        // The bisector is d / 2 from `t`, past every corner left.
        if d >= 2.0 * far {
            break;
        }
        if d < 1e-9 {
            return None;
        }
        cell = nearer_half(&cell, t, s);
        if cell.len() < 3 {
            return None;
        }
        far = cell.iter().map(|&p| dist(p, t)).fold(0.0, f64::max);
    }
    Some(cell)
}

/// The part of convex `poly` on `t`'s side of the bisector of `t` and `s`.
fn nearer_half(poly: &[[f64; 2]], t: [f64; 2], s: [f64; 2]) -> Loop {
    let mid = [(t[0] + s[0]) * 0.5, (t[1] + s[1]) * 0.5];
    let side = |p: [f64; 2]| (p[0] - mid[0]) * (s[0] - t[0]) + (p[1] - mid[1]) * (s[1] - t[1]);
    let mut out = Vec::with_capacity(poly.len() + 1);
    for (j, &a) in poly.iter().enumerate() {
        let b = poly[(j + 1) % poly.len()];
        let (sa, sb) = (side(a), side(b));
        if sa <= 0.0 {
            out.push(a);
        }
        if (sa <= 0.0) != (sb <= 0.0) {
            let f = sa / (sa - sb);
            out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
        }
    }
    out
}

#[cfg(test)]
impl Supports {
    /// Birth sites of the branch at `limb`: the limb and every limb merged
    /// into it, all the way up. Ascending by limb.
    pub(crate) fn branch_sites(&self, limb: NodeId, bands: &[LayerBand]) -> Vec<TipSite> {
        let limbs = &self.forest.limbs;
        let mut guests: Vec<Vec<usize>> = vec![Vec::new(); limbs.len()];
        for (k, l) in limbs.iter().enumerate() {
            if let End::Merged { into } = l.end {
                guests[into.0 as usize - 1].push(k);
            }
        }
        let mut branch = Vec::new();
        let mut stack = vec![limb.0 as usize - 1];
        while let Some(k) = stack.pop() {
            branch.push(k);
            stack.extend(&guests[k]);
        }
        branch.sort_unstable();
        branch.iter().map(|&k| site(&limbs[k], bands)).collect()
    }

    /// Birth site of `limb` alone.
    pub(crate) fn limb_site(&self, limb: NodeId, bands: &[LayerBand]) -> TipSite {
        site(&self.forest.limbs[limb.0 as usize - 1], bands)
    }

    /// Birth sites of the whole tree `limb` belongs to.
    pub(crate) fn tree_sites(&self, limb: NodeId, bands: &[LayerBand]) -> Vec<TipSite> {
        let mut root = limb;
        while let End::Merged { into } = self.forest.limbs[root.0 as usize - 1].end {
            root = into;
        }
        self.branch_sites(root, bands)
    }

    /// Every layer stood from scratch on the forest as the edits left it.
    pub(crate) fn rebuilt(&self, bands: &[LayerBand], contours: &[Vec<Loop>]) -> Vec<SupportLayer> {
        let mut layers: Vec<SupportLayer> = (0..self.layers.len())
            .into_par_iter()
            .map(|i| self.fresh(i, contours))
            .collect();
        super::project(
            &mut layers,
            1,
            bands,
            contours,
            lean_of(&self.opts),
            &crate::progress::Watch::idle(),
            self.opts.job,
        );
        layers
    }
}

#[cfg(test)]
fn site(limb: &Limb, bands: &[LayerBand]) -> TipSite {
    TipSite {
        xy: limb.knots[0].xy,
        z: bands[limb.top].z,
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{
        band, layers, pad_over_flank, plate, plate_opts, rect, unfooted_interface,
    };
    use super::super::{Forest, SupportOpts, SupportStyle};
    use super::*;
    use crate::poly::in_solid;

    type Fixture = (Vec<LayerBand>, Vec<Vec<Loop>>, SupportOpts);

    /// samples/overhang_ledge.stl: a 24 mm block and a 24 x 16 mm ledge
    /// off its side from z 12 to 16.
    fn ledge() -> (Vec<LayerBand>, Vec<Vec<Loop>>) {
        let bands = layers(80);
        let mut contours = vec![vec![rect(0.0, 0.0, 24.0, 24.0)]; 60];
        contours.extend(vec![vec![rect(24.0, 4.0, 48.0, 20.0)]; 20]);
        (bands, contours)
    }

    fn fixtures() -> Vec<(&'static str, Fixture)> {
        let speed = SupportOpts {
            style: SupportStyle::Tree,
            density: 0.15,
            load_factor: 5.2,
            max_tip_spacing: 10.8,
            ..SupportOpts::default()
        };
        let tough = SupportOpts {
            density: 1.0,
            ..plate_opts()
        };
        let (pb, pc) = plate();
        let (lb, lc) = ledge();
        let (fb, fc) = pad_over_flank();
        vec![
            ("plate", (pb.clone(), pc.clone(), plate_opts())),
            ("plate toughness", (pb, pc, tough)),
            ("ledge speed", (lb.clone(), lc.clone(), speed)),
            ("ledge toughness", (lb, lc, tough)),
            ("pad over flank", (fb, fc, plate_opts())),
        ]
    }

    fn build((bands, contours, opts): &Fixture) -> Supports {
        Supports::build(bands, contours, opts).unwrap()
    }

    fn id(k: usize) -> NodeId {
        NodeId(k as u32 + 1)
    }

    fn guests_of(s: &Supports, host: usize) -> Vec<usize> {
        let limbs = &s.forest.limbs;
        (0..limbs.len())
            .filter(|&k| limbs[k].end == End::Merged { into: id(host) })
            .collect()
    }

    /// The limb whose tree holds the most limbs.
    fn biggest_tree(s: &Supports, bands: &[LayerBand]) -> usize {
        (0..s.forest.limbs.len())
            .max_by_key(|&k| (s.tree_sites(id(k), bands).len(), usize::MAX - k))
            .unwrap()
    }

    /// Small xorshift, so the subsets are the same on every run.
    struct Rng(u64);

    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
    }

    /// Prunes worth checking on one build: one branch, one whole tree, one
    /// guest off its host, and random subsets of tips.
    fn prunes(s: &Supports, bands: &[LayerBand], rng: &mut Rng) -> Vec<(String, SupportEdit)> {
        let limbs = &s.forest.limbs;
        let prune = |sites| SupportEdit::Prune { sites };
        let mut edits = Vec::new();
        if limbs.is_empty() {
            return edits;
        }
        // The guest with the most guests of its own.
        if let Some(k) = (0..limbs.len())
            .filter(|&k| matches!(limbs[k].end, End::Merged { .. }))
            .max_by_key(|&k| (s.branch_sites(id(k), bands).len(), usize::MAX - k))
        {
            edits.push((
                format!("branch at {k}"),
                prune(s.branch_sites(id(k), bands)),
            ));
        }
        let tree = biggest_tree(s, bands);
        edits.push((
            format!("tree of {tree}"),
            prune(s.tree_sites(id(tree), bands)),
        ));
        if let Some(host) = (0..limbs.len()).find(|&k| !guests_of(s, k).is_empty()) {
            let guest = guests_of(s, host)[0];
            edits.push((
                format!("guest {guest} off host {host}"),
                prune(vec![site(&limbs[guest], bands)]),
            ));
            edits.push((
                format!("host {host} tip, guests kept"),
                prune(vec![site(&limbs[host], bands)]),
            ));
        }
        for round in 0..3 {
            let mut sites: Vec<TipSite> = limbs
                .iter()
                .filter(|_| rng.next() % 3 == 0)
                .map(|l| site(l, bands))
                .collect();
            if sites.is_empty() {
                sites.push(site(&limbs[rng.next() as usize % limbs.len()], bands));
            }
            edits.push((format!("random subset {round}"), prune(sites)));
        }
        edits
    }

    #[test]
    fn standing_the_knots_again_gives_back_the_build() {
        for (name, fixture) in fixtures() {
            let s = build(&fixture);
            assert_eq!(s.rebuilt(&fixture.0, &fixture.1), s.layers, "{name}");
        }
    }

    #[test]
    fn an_incremental_rebuild_matches_a_full_rebuild() {
        let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
        let mut checked = 0;
        for (name, fixture) in fixtures() {
            let (bands, contours, _) = &fixture;
            let edits = prunes(&build(&fixture), bands, &mut rng);
            // Each prune alone, then all of them stacked on one build.
            for (what, edit) in &edits {
                let mut s = build(&fixture);
                s.apply(std::slice::from_ref(edit), bands, contours);
                assert!(
                    s.forest.limbs.iter().any(|l| l.life != Life::Live),
                    "{name}, {what}: nothing was pruned"
                );
                assert_eq!(s.layers, s.rebuilt(bands, contours), "{name}, {what}");
                checked += 1;
            }
            let mut s = build(&fixture);
            for (what, edit) in &edits {
                s.apply(std::slice::from_ref(edit), bands, contours);
                assert_eq!(
                    s.layers,
                    s.rebuilt(bands, contours),
                    "{name}, stacked up to {what}"
                );
            }
        }
        assert!(checked >= 30, "only {checked} prunes checked");
    }

    /// A 4 mm pad 8 mm up, with one tip and so one tree.
    fn one_pad() -> Fixture {
        let bands = layers(40);
        let mut contours = vec![Vec::new(); bands.len()];
        contours[39] = vec![rect(0.0, 0.0, 4.0, 4.0)];
        (bands, contours, plate_opts())
    }

    #[test]
    fn pruning_the_only_tree_removes_its_disks_and_reports_its_pad() {
        let fixture = one_pad();
        let (bands, contours, _) = &fixture;
        let mut s = build(&fixture);
        let roots: Vec<usize> = (0..s.forest.limbs.len())
            .filter(|&k| !matches!(s.forest.limbs[k].end, End::Merged { .. }))
            .collect();
        assert_eq!(roots, vec![0], "one tree");
        let printed = |s: &Supports| {
            (
                s.layers.iter().filter(|l| !l.disks.is_empty()).count(),
                s.layers.iter().filter(|l| !l.interface.is_empty()).count(),
            )
        };
        // Contact at z 7.6, so two interface layers and disks down from z 7.2.
        assert_eq!(printed(&s), (36, 2));
        assert_eq!(s.coverage(bands, contours), Vec::new());

        let sites = s.tree_sites(NodeId(1), bands);
        let out = s.apply(&[SupportEdit::Prune { sites }], bands, contours);
        assert_eq!(printed(&s), (0, 0));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].status, EditStatus::Applied);
        assert_eq!(out[0].changed, (0..38).collect::<Vec<_>>());
        assert!((out[0].newly_floating_mm2 - 16.0).abs() < 0.01, "{out:?}");
        let gaps = s.coverage(bands, contours);
        assert_eq!(gaps.len(), 1, "{gaps:?}");
        let gap = &gaps[0];
        assert!(
            (gap.z[0] - 7.4).abs() < 1e-6 && (gap.z[1] - 7.6).abs() < 1e-6,
            "{:?}",
            gap.z
        );
        assert!((gap.area_mm2 - 16.0).abs() < 0.01, "{}", gap.area_mm2);
        assert_eq!((gap.min, gap.max), ([0.0, 0.0], [4.0, 4.0]));
        assert_eq!(out[0].floating, gaps);
    }

    /// Two 4 mm pads 8 mm up, centres 8 mm apart, one tip each. They lean
    /// together and merge into one trunk.
    fn two_pads() -> Fixture {
        let bands = layers(40);
        let mut contours = vec![Vec::new(); bands.len()];
        contours[39] = vec![rect(0.0, 0.0, 4.0, 4.0), rect(8.0, 0.0, 12.0, 4.0)];
        (bands, contours, plate_opts())
    }

    #[test]
    fn pruning_one_branch_keeps_the_host_and_drops_the_guest_above_the_merge() {
        let fixture = two_pads();
        let (bands, contours, _) = &fixture;
        let mut s = build(&fixture);
        let ends: Vec<End> = s.forest.limbs.iter().map(|l| l.end).collect();
        assert_eq!(ends, vec![End::Bed, End::Merged { into: NodeId(1) }]);
        let guest = &s.forest.limbs[1];
        let merge = guest.bottom() - 1;
        let pad = if guest.knots[0].xy[0] > 6.0 {
            ([8.0, 0.0], [12.0, 4.0])
        } else {
            ([0.0, 0.0], [4.0, 4.0])
        };
        let before = s.layers.clone();
        let host_disks = |layers: &[SupportLayer]| -> Vec<Vec<_>> {
            layers
                .iter()
                .map(|l| {
                    l.disks
                        .iter()
                        .filter(|d| d.node == NodeId(1))
                        .copied()
                        .collect()
                })
                .collect()
        };

        let sites = s.branch_sites(NodeId(2), bands);
        assert_eq!(sites.len(), 1);
        let out = s.apply(&[SupportEdit::Prune { sites }], bands, contours);
        assert_eq!(s.layers[..=merge], before[..=merge]);
        assert_eq!(host_disks(&s.layers), host_disks(&before));
        assert!(before[merge + 1..]
            .iter()
            .any(|l| l.disks.iter().any(|d| d.node == NodeId(2))));
        assert!(s
            .layers
            .iter()
            .all(|l| l.disks.iter().all(|d| d.node == NodeId(1))));
        assert_eq!(out[0].changed.first(), Some(&(merge + 1)));
        let gaps = s.coverage(bands, contours);
        assert_eq!(gaps.len(), 1, "{gaps:?}");
        assert!((gaps[0].area_mm2 - 16.0).abs() < 0.01, "{gaps:?}");
        assert_eq!((gaps[0].min, gaps[0].max), pad);
    }

    #[test]
    fn a_pruned_tree_loses_its_share_of_a_raft_it_shared() {
        // The plate's interface is one raft over every tip. Without the clip
        // the pruned tree's share would print on the neighbours' feet.
        let (bands, contours) = plate();
        let mut s = Supports::build(&bands, &contours, &plate_opts()).unwrap();
        let limbs = &s.forest.limbs;
        let tree = biggest_tree(&s, &bands);
        let sites = s.tree_sites(id(tree), &bands);
        let gone = sites[0];
        let top = limbs.iter().position(|l| site(l, &bands) == gone).unwrap();
        let top = limbs[top].top;
        let kept = limbs
            .iter()
            .map(|l| site(l, &bands))
            .find(|t| t.z == gone.z && !sites.contains(t))
            .expect("a kept tip on the same layer");
        assert!(in_solid(&s.layers[top].interface, gone.xy[0], gone.xy[1]));
        let out = s.apply(&[SupportEdit::Prune { sites }], &bands, &contours);
        let raft = &s.layers[top].interface;
        assert!(!in_solid(raft, gone.xy[0], gone.xy[1]));
        assert!(in_solid(raft, kept.xy[0], kept.xy[1]));
        let floating = out[0].newly_floating_mm2;
        assert!(floating > 10.0 && floating < 560.0, "{out:?}");
    }

    fn shifted(contours: &[Vec<Loop>], dx: f64, dy: f64) -> Vec<Vec<Loop>> {
        contours
            .iter()
            .map(|layer| {
                layer
                    .iter()
                    .map(|l| l.iter().map(|p| [p[0] + dx, p[1] + dy]).collect())
                    .collect()
            })
            .collect()
    }

    fn plate_edits(s: &Supports, bands: &[LayerBand]) -> Vec<SupportEdit> {
        let tree = biggest_tree(s, bands);
        let mut rng = Rng(7);
        let subset = s
            .forest
            .limbs
            .iter()
            .filter(|_| rng.next() % 4 == 0)
            .map(|l| site(l, bands))
            .collect();
        vec![
            SupportEdit::Prune {
                sites: s.tree_sites(id(tree), bands),
            },
            SupportEdit::Prune { sites: subset },
        ]
    }

    #[test]
    fn replaying_on_a_fresh_build_gives_the_same_layers() {
        let (bands, contours) = plate();
        let mut first = Supports::build(&bands, &contours, &plate_opts()).unwrap();
        let edits = plate_edits(&first, &bands);
        let a = first.apply(&edits, &bands, &contours);
        assert!(a.iter().all(|o| o.status == EditStatus::Applied), "{a:?}");
        let mut again = Supports::build(&bands, &contours, &plate_opts()).unwrap();
        let b = again.apply(&edits, &bands, &contours);
        assert_eq!(a, b);
        assert_eq!(first.layers, again.layers);
    }

    #[test]
    fn replaying_after_a_reslice_rebinds_or_goes_stale() {
        let (bands, contours) = plate();
        let opts = plate_opts();
        let s = Supports::build(&bands, &contours, &opts).unwrap();
        let edits = plate_edits(&s, &bands);
        let statuses = |bands: &[LayerBand], contours: &[Vec<Loop>]| {
            let mut s = Supports::build(bands, contours, &opts).unwrap();
            let out = s.apply(&edits, bands, contours);
            assert_eq!(s.layers, s.rebuilt(bands, contours));
            out.into_iter().map(|o| o.status).collect::<Vec<_>>()
        };

        // Half a millimetre across: every tip moves with the plate.
        for status in statuses(&bands, &shifted(&contours, 0.5, 0.0)) {
            let EditStatus::Rebound { moved_mm } = status else {
                panic!("{status:?}");
            };
            assert!((moved_mm - 0.5).abs() < 1e-6, "{moved_mm}");
        }

        // 0.25 mm layers: the same tips, born 0.25 mm lower.
        let quarter: Vec<LayerBand> = (0..64)
            .map(|i| LayerBand {
                height: 0.25,
                ..band(i, (i as f64 + 1.0) * 0.25)
            })
            .collect();
        let mut on_quarter = vec![Vec::new(); quarter.len()];
        for c in on_quarter.iter_mut().skip(60) {
            *c = vec![rect(0.0, 0.0, 40.0, 14.0)];
        }
        for status in statuses(&quarter, &on_quarter) {
            let EditStatus::Rebound { moved_mm } = status else {
                panic!("{status:?}");
            };
            assert!((moved_mm - 0.25).abs() < 1e-6, "{moved_mm}");
        }

        // The plate moved off every site.
        let away = statuses(&bands, &shifted(&contours, 0.0, 40.0));
        let missed: Vec<EditStatus> = edits
            .iter()
            .map(|edit| match edit {
                SupportEdit::Prune { sites } => EditStatus::Stale {
                    missed: sites.len(),
                },
                SupportEdit::Regrow { .. } => unreachable!("the plate edits only prune"),
            })
            .collect();
        assert_eq!(away, missed);
    }

    #[test]
    fn a_plate_cut_in_half_applies_the_sites_still_on_it() {
        let (bands, contours) = plate();
        let opts = plate_opts();
        let s = Supports::build(&bands, &contours, &opts).unwrap();
        let sites: Vec<TipSite> = s.forest.limbs.iter().map(|l| site(l, &bands)).collect();
        let off = sites.iter().filter(|t| t.xy[0] > 30.0).count();
        assert!(off > 0 && off < sites.len(), "{sites:?}");
        let mut half = vec![Vec::new(); bands.len()];
        for c in half.iter_mut().skip(76) {
            *c = vec![rect(0.0, 0.0, 20.0, 14.0)];
        }
        let mut cut = Supports::build(&bands, &half, &opts).unwrap();
        let out = cut.apply(&[SupportEdit::Prune { sites }], &bands, &half);
        let EditStatus::Stale { missed } = out[0].status else {
            panic!("{out:?}");
        };
        assert!(missed >= off, "{missed} missed, {off} off the half plate");
        assert!(cut
            .forest
            .limbs
            .iter()
            .any(|l| matches!(l.life, Life::Removed { .. })));
        assert_eq!(cut.layers, cut.rebuilt(&bands, &half));
    }

    #[test]
    fn pruning_twice_equals_pruning_once() {
        let (bands, contours) = plate();
        let mut once = Supports::build(&bands, &contours, &plate_opts()).unwrap();
        let edits = plate_edits(&once, &bands);
        once.apply(&edits, &bands, &contours);
        let layers = once.layers.clone();
        let again = once.apply(&edits, &bands, &contours);
        assert_eq!(once.layers, layers);
        for o in again {
            assert_eq!(o.status, EditStatus::Applied);
            assert_eq!((o.changed, o.stood), (Vec::new(), 0));
            assert_eq!(o.newly_floating_mm2, 0.0);
            assert_eq!(o.floating, Vec::new());
        }
        let mut doubled = Supports::build(&bands, &contours, &plate_opts()).unwrap();
        let twice: Vec<SupportEdit> = edits.iter().chain(&edits).cloned().collect();
        doubled.apply(&twice, &bands, &contours);
        assert_eq!(doubled.layers, layers);
    }

    #[test]
    fn no_edits_leave_the_build_as_it_was() {
        let (bands, contours) = plate();
        let mut s = Supports::build(&bands, &contours, &plate_opts()).unwrap();
        let layers = s.layers.clone();
        assert_eq!(s.apply(&[], &bands, &contours), Vec::new());
        assert_eq!(s.layers, layers);
    }

    /// A limb of `radius` standing at `xy` from layer `top` down to
    /// `bottom`, frozen on its top layer only.
    fn column(id: u32, top: usize, bottom: usize, xy: [f64; 2], radius: f64) -> Limb {
        let knots = (bottom..=top)
            .rev()
            .map(|i| Node {
                id,
                xy,
                above: xy,
                radius,
                dist: 0.0,
                freeze: u32::from(i == top),
                load: 1.0,
                to_bed: false,
            })
            .collect();
        Limb {
            top,
            knots,
            end: End::Landed,
            life: Life::Live,
        }
    }

    #[test]
    fn a_kept_limb_that_stood_on_a_pruned_one_drops_past_the_pruned_span() {
        // `stood` is born at layer 10 and its lowest disk, on layer 3, rests
        // only on `under`, which reaches up to layer 5. Pruning `under`
        // leaves that disk nothing to stand on, and each disk above it in
        // turn, up to layer 9.
        let bands = layers(12);
        let contours = vec![Vec::new(); bands.len()];
        let limbs = vec![
            column(1, 5, 0, [0.0, 0.0], 1.0),
            column(2, 10, 3, [1.0, 0.0], 0.8),
        ];
        let mut at = vec![Vec::new(); bands.len()];
        for (k, l) in limbs.iter().enumerate() {
            for on in &mut at[l.bottom()..=l.top] {
                on.push(k as u32);
            }
        }
        let empty = SupportLayer {
            sparse: Vec::new(),
            interface: Vec::new(),
            disks: Vec::new(),
        };
        let mut s = Supports {
            forest: Forest { limbs, at },
            layers: vec![empty; bands.len()],
            demanded: vec![Vec::new(); bands.len()],
            born: vec![Vec::new(); bands.len()],
            restored: vec![Vec::new(); bands.len()],
            edits: 0,
            regrown: Vec::new(),
            opts: plate_opts(),
        };
        s.layers = s.rebuilt(&bands, &contours);
        let printed = |s: &Supports, node: u32| -> Vec<usize> {
            (0..s.layers.len())
                .filter(|&i| s.layers[i].disks.iter().any(|d| d.node == NodeId(node)))
                .collect()
        };
        assert_eq!(printed(&s, 1), vec![0, 1, 2, 3, 4]);
        assert_eq!(printed(&s, 2), vec![3, 4, 5, 6, 7, 8, 9]);

        let sites = vec![site(&s.forest.limbs[0], &bands)];
        let out = s.apply(&[SupportEdit::Prune { sites }], &bands, &contours);
        assert_eq!(printed(&s, 1), Vec::<usize>::new());
        assert_eq!(printed(&s, 2), Vec::<usize>::new());
        assert_eq!(out[0].changed, (0..10).collect::<Vec<_>>());
        assert_eq!(out[0].stood, 11);
        assert_eq!(s.layers, s.rebuilt(&bands, &contours));
    }

    #[test]
    fn a_branch_is_a_limb_and_everything_merged_into_it() {
        let (bands, contours) = plate();
        let s = Supports::build(&bands, &contours, &plate_opts()).unwrap();
        let limbs = &s.forest.limbs;
        let leaf = (0..limbs.len())
            .find(|&k| guests_of(&s, k).is_empty() && matches!(limbs[k].end, End::Merged { .. }))
            .unwrap();
        assert_eq!(
            s.branch_sites(id(leaf), &bands),
            vec![site(&limbs[leaf], &bands)]
        );
        let End::Merged { into } = limbs[leaf].end else {
            unreachable!()
        };
        let host = s.branch_sites(into, &bands);
        assert!(host.contains(&site(&limbs[leaf], &bands)));
        assert!(host.contains(&site(&limbs[into.0 as usize - 1], &bands)));
        assert_eq!(s.tree_sites(id(leaf), &bands), s.tree_sites(into, &bands));
    }

    /// Everything a limb is, with every float as its bits.
    type LimbBits = (usize, Vec<[u64; 10]>, End, Life);

    fn bits(l: &Limb) -> LimbBits {
        let knots = l
            .knots
            .iter()
            .map(|n| {
                [
                    u64::from(n.id),
                    n.xy[0].to_bits(),
                    n.xy[1].to_bits(),
                    n.above[0].to_bits(),
                    n.above[1].to_bits(),
                    n.radius.to_bits(),
                    n.dist.to_bits(),
                    u64::from(n.freeze),
                    n.load.to_bits(),
                    u64::from(n.to_bed),
                ]
            })
            .collect();
        (l.top, knots, l.end, l.life)
    }

    fn limb_bits(s: &Supports) -> Vec<LimbBits> {
        s.forest.limbs.iter().map(bits).collect()
    }

    fn gap_area(gaps: &[CoverageGap]) -> f64 {
        gaps.iter().map(|g| f64::from(g.area_mm2)).sum()
    }

    #[test]
    fn regrowing_a_pruned_trees_gap_holds_it_again_and_keeps_every_kept_knot() {
        for (name, fixture) in fixtures() {
            let (bands, contours, _) = &fixture;
            let mut s = build(&fixture);
            let built = s.coverage(bands, contours);
            let original = limb_bits(&s);
            let tree = s.tree_sites(id(biggest_tree(&s, bands)), bands);
            let pruned = s.apply(&[SupportEdit::Prune { sites: tree }], bands, contours);
            let after_prune = limb_bits(&s);

            // Every gap the prune leaves, the cut-off pad's included.
            let gaps = s.coverage_from(bands, contours, 0.0);
            assert!(!gaps.is_empty(), "{name}: nothing to regrow");
            let edit = SupportEdit::over_gaps(&gaps);
            let out = s.apply(std::slice::from_ref(&edit), bands, contours);
            let o = &out[0];
            assert_eq!(o.status, EditStatus::Applied, "{name}");
            assert!(
                s.forest.limbs.len() > original.len(),
                "{name}: grew nothing"
            );
            assert_eq!(s.coverage(bands, contours), built, "{name}");
            assert_eq!(
                unfooted_interface(&s.layers, contours),
                Vec::new(),
                "{name}"
            );
            assert!(
                (o.newly_floating_mm2 + pruned[0].newly_floating_mm2).abs() < 1e-3,
                "{name}: the regrow gave back {} of the {} mm2 the prune left",
                -o.newly_floating_mm2,
                pruned[0].newly_floating_mm2
            );
            let SupportEdit::Regrow { region, z } = &edit else {
                unreachable!()
            };
            let had = gaps_in(&built, region, *z);
            assert_eq!(gap_area(&o.floating), gap_area(&had), "{name}");
            for (k, was) in original.iter().enumerate() {
                if s.forest.limbs[k].life == Life::Live {
                    assert_eq!(&bits(&s.forest.limbs[k]), was, "{name}: kept limb {k}");
                }
            }
            assert_eq!(&limb_bits(&s)[..original.len()], &after_prune[..], "{name}");
            assert_eq!(s.layers, s.rebuilt(bands, contours), "{name}");
        }
    }

    #[test]
    fn pruning_a_regrown_tree_brings_its_gap_back() {
        let (bands, contours) = plate();
        let mut s = Supports::build(&bands, &contours, &plate_opts()).unwrap();
        let first = s.forest.limbs.len();
        let tree = s.tree_sites(id(biggest_tree(&s, &bands)), &bands);
        let pruned = s.apply(&[SupportEdit::Prune { sites: tree }], &bands, &contours);
        s.apply(
            &[SupportEdit::over_gaps(&pruned[0].floating)],
            &bands,
            &contours,
        );
        assert_eq!(s.coverage(&bands, &contours), Vec::new());

        let regrown: Vec<TipSite> = s.forest.limbs[first..]
            .iter()
            .map(|l| site(l, &bands))
            .collect();
        for (k, t) in (first..).zip(&regrown) {
            assert_eq!(s.limb_site(id(k), &bands), *t);
            assert!(s.branch_sites(id(k), &bands).contains(t));
            assert!(s.tree_sites(id(k), &bands).contains(t));
        }
        let out = s.apply(&[SupportEdit::Prune { sites: regrown }], &bands, &contours);
        assert_eq!(out[0].status, EditStatus::Applied);
        assert!(s.forest.limbs[first..].iter().all(|l| l.life != Life::Live));
        let back = gap_area(&s.coverage_from(&bands, &contours, 0.0));
        let left = gap_area(&pruned[0].floating);
        assert!(
            (back - left).abs() < 0.5,
            "{back} mm2 back, the prune left {left}"
        );
        assert_eq!(s.layers, s.rebuilt(&bands, &contours));
    }

    #[test]
    fn regrowing_a_held_region_is_stale_and_changes_nothing() {
        let (bands, contours) = plate();
        let whole = SupportEdit::Regrow {
            region: vec![rect(-5.0, -5.0, 45.0, 19.0)],
            z: [0.0, 20.0],
        };
        let mut s = Supports::build(&bands, &contours, &plate_opts()).unwrap();
        let (layers, limbs) = (s.layers.clone(), limb_bits(&s));
        let out = s.apply(std::slice::from_ref(&whole), &bands, &contours);
        let stale = EditOutcome {
            status: EditStatus::Stale { missed: 1 },
            changed: Vec::new(),
            stood: 0,
            newly_floating_mm2: 0.0,
            floating: Vec::new(),
        };
        assert_eq!(out, vec![stale.clone()]);
        assert_eq!((s.layers.clone(), limb_bits(&s)), (layers, limbs));

        // Once a regrow has held what a prune left, regrowing it again is stale too.
        let tree = s.tree_sites(id(biggest_tree(&s, &bands)), &bands);
        let pruned = s.apply(&[SupportEdit::Prune { sites: tree }], &bands, &contours);
        let regrow = SupportEdit::over_gaps(&pruned[0].floating);
        s.apply(std::slice::from_ref(&regrow), &bands, &contours);
        let (layers, limbs) = (s.layers.clone(), limb_bits(&s));
        let again = s.apply(&[regrow, whole], &bands, &contours);
        assert_eq!(again, vec![stale.clone(), stale]);
        assert_eq!((s.layers.clone(), limb_bits(&s)), (layers, limbs));
    }

    #[test]
    fn an_incremental_regrow_matches_a_full_rebuild() {
        let mut rng = Rng(0xD1B5_4A32_D192_ED03);
        let mut checked = 0;
        for (name, fixture) in fixtures() {
            let (bands, contours, _) = &fixture;
            let base = build(&fixture);
            let (min, max) = base
                .layers
                .iter()
                .filter_map(|l| crate::poly::loop_bounds(&l.interface))
                .fold(([f64::MAX; 2], [f64::MIN; 2]), |(a, b), (c, d)| {
                    (
                        [a[0].min(c[0]), a[1].min(c[1])],
                        [b[0].max(d[0]), b[1].max(d[1])],
                    )
                });
            let mut stacked = build(&fixture);
            let mut list = Vec::new();
            for (what, prune) in prunes(&base, bands, &mut rng) {
                let mut s = build(&fixture);
                let out = s.apply(std::slice::from_ref(&prune), bands, contours);
                let mut edits = vec![prune];
                if !out[0].floating.is_empty() {
                    edits.push(SupportEdit::over_gaps(&out[0].floating));
                }
                // A box over a random half of the supports, across all layers.
                let cut = min[0] + (max[0] - min[0]) * (rng.next() % 100) as f64 / 100.0;
                let half = if rng.next() % 2 == 0 {
                    rect(min[0] - 1.0, min[1] - 1.0, cut, max[1] + 1.0)
                } else {
                    rect(cut, min[1] - 1.0, max[0] + 1.0, max[1] + 1.0)
                };
                edits.push(SupportEdit::Regrow {
                    region: vec![half],
                    z: [0.0, bands[bands.len() - 1].z],
                });
                let outs = s.apply(&edits[1..], bands, contours);
                assert_eq!(s.layers, s.rebuilt(bands, contours), "{name}, {what}");
                assert!(
                    outs.iter().all(|o| o.newly_floating_mm2 <= 1e-6),
                    "{name}, {what}: {outs:?}"
                );

                let mut replayed = build(&fixture);
                let all = replayed.apply(&edits, bands, contours);
                assert_eq!(all[0], out[0], "{name}, {what}");
                assert_eq!(all[1..], outs[..], "{name}, {what}");
                assert_eq!(replayed.layers, s.layers, "{name}, {what}");

                stacked.apply(&edits, bands, contours);
                assert_eq!(
                    stacked.layers,
                    stacked.rebuilt(bands, contours),
                    "{name}, stacked to {what}"
                );
                list.extend(edits);
                checked += 1;
            }
            let mut replayed = build(&fixture);
            replayed.apply(&list, bands, contours);
            assert_eq!(
                replayed.layers, stacked.layers,
                "{name}, the stacked list replayed"
            );
        }
        assert!(checked >= 30, "only {checked} sequences checked");
    }

    #[test]
    fn replaying_a_prune_and_regrow_on_a_fresh_build_gives_the_same_layers() {
        let (bands, contours) = plate();
        let mut first = Supports::build(&bands, &contours, &plate_opts()).unwrap();
        let tree = first.tree_sites(id(biggest_tree(&first, &bands)), &bands);
        let prune = SupportEdit::Prune { sites: tree };
        let pruned = first.apply(std::slice::from_ref(&prune), &bands, &contours);
        let edits = vec![prune, SupportEdit::over_gaps(&pruned[0].floating)];
        let regrown = first.apply(&edits[1..], &bands, &contours);
        assert_eq!(regrown[0].status, EditStatus::Applied);
        let mut again = Supports::build(&bands, &contours, &plate_opts()).unwrap();
        let out = again.apply(&edits, &bands, &contours);
        assert_eq!(out, [pruned, regrown].concat());
        assert_eq!(again.layers, first.layers);
        assert_eq!(limb_bits(&again), limb_bits(&first));
    }

    /// Two pads with the guest pruned and its pad regrown. When `host_load`
    /// is set, the kept trunk is made to carry that many tips already.
    fn regrow_beside_a_kept_trunk(host_load: Option<f64>) -> (Supports, Vec<LimbBits>) {
        let fixture = two_pads();
        let (bands, contours, _) = &fixture;
        let mut s = build(&fixture);
        if let Some(load) = host_load {
            for k in &mut s.forest.limbs[0].knots {
                k.load = load;
            }
        }
        let sites = s.branch_sites(NodeId(2), bands);
        let pruned = s.apply(&[SupportEdit::Prune { sites }], bands, contours);
        let host = limb_bits(&s);
        let out = s.apply(
            &[SupportEdit::over_gaps(&pruned[0].floating)],
            bands,
            contours,
        );
        assert_eq!(out[0].status, EditStatus::Applied);
        assert_eq!(s.coverage(bands, contours), Vec::new());
        assert_eq!(s.layers, s.rebuilt(bands, contours));
        (s, host)
    }

    #[test]
    fn a_regrown_tip_joins_a_kept_trunk_only_when_it_is_thick_enough() {
        // The trunk carries both pads below the merge, so it has room for one more.
        let (s, before) = regrow_beside_a_kept_trunk(None);
        let ends: Vec<End> = s.forest.limbs.iter().map(|l| l.end).collect();
        assert_eq!(
            ends,
            vec![
                End::Bed,
                End::Merged { into: NodeId(1) },
                End::Merged { into: NodeId(1) }
            ]
        );
        assert_eq!(bits(&s.forest.limbs[0]), before[0]);

        // A trunk already carrying 500 tips cannot take one more without
        // growing, so the regrown tip stands on its own trunk to the bed.
        let (s, before) = regrow_beside_a_kept_trunk(Some(500.0));
        let ends: Vec<End> = s.forest.limbs.iter().map(|l| l.end).collect();
        assert_eq!(
            ends,
            vec![End::Bed, End::Merged { into: NodeId(1) }, End::Bed]
        );
        assert_eq!(bits(&s.forest.limbs[0]), before[0]);
        for l in &s.layers {
            let host = l.disks.iter().find(|d| d.node == NodeId(1));
            let new = l.disks.iter().find(|d| d.node == NodeId(3));
            if let (Some(h), Some(n)) = (host, new) {
                let gap = dist(h.xy, n.xy) - h.r - n.r;
                assert!(
                    gap >= -1e-9,
                    "the regrown trunk overlaps the kept one by {}",
                    -gap
                );
            }
        }
    }

    /// A kept column of `radius` at the origin, from the bed up to layer
    /// `top`, already carrying `load` tips, under `pads` of interface on
    /// layers 39 and 40 that nothing holds. Layer 40 is at z 8.2.
    fn kept_column(
        radius: f64,
        top: usize,
        load: f64,
        pads: &[Loop],
    ) -> (Vec<LayerBand>, Supports) {
        let bands = layers(41);
        let mut column = column(1, top, 0, [0.0, 0.0], radius);
        for k in &mut column.knots {
            k.load = load;
        }
        let mut at = vec![Vec::new(); bands.len()];
        for on in &mut at[..=top] {
            on.push(0);
        }
        let mut demanded = vec![Vec::new(); bands.len()];
        let mut born = vec![Vec::new(); bands.len()];
        demanded[39] = pads.to_vec();
        demanded[40] = pads.to_vec();
        born[40] = pads.to_vec();
        let empty = SupportLayer {
            sparse: Vec::new(),
            interface: Vec::new(),
            disks: Vec::new(),
        };
        let mut s = Supports {
            forest: Forest {
                limbs: vec![column],
                at,
            },
            layers: vec![empty; bands.len()],
            demanded,
            born,
            restored: vec![Vec::new(); bands.len()],
            edits: 0,
            regrown: Vec::new(),
            opts: plate_opts(),
        };
        s.layers = s.rebuilt(&bands, &[]);
        (bands, s)
    }

    fn regrow_pads(pads: Vec<Loop>) -> SupportEdit {
        SupportEdit::Regrow {
            region: pads,
            z: [7.8, 8.2],
        }
    }

    #[test]
    fn a_regrown_trunk_keeps_clear_of_a_kept_trunk_it_cannot_join() {
        // The column is 1.5 mm wide up to layer 30 and carries 500 tips. The
        // pad's tip is born 1.2 mm from its axis, over its edge.
        let pad = vec![rect(0.95, -0.25, 1.45, 0.25)];
        let (bands, mut s) = kept_column(1.5, 30, 500.0, &pad);
        let contours = vec![Vec::new(); bands.len()];
        let kept = bits(&s.forest.limbs[0]);
        let out = s.apply(&[regrow_pads(pad)], &bands, &contours);
        assert_eq!(out[0].status, EditStatus::Applied);
        let ends: Vec<End> = s.forest.limbs.iter().map(|l| l.end).collect();
        assert_eq!(ends, vec![End::Landed, End::Bed]);
        assert_eq!(bits(&s.forest.limbs[0]), kept);
        let beside: Vec<(usize, bool)> = (0..s.layers.len())
            .filter_map(|i| {
                let d = &s.layers[i].disks;
                let h = d.iter().find(|d| d.node == NodeId(1))?;
                let n = d.iter().find(|d| d.node == NodeId(2))?;
                Some((i, dist(h.xy, n.xy) < h.r + n.r - 1e-9))
            })
            .collect();
        assert_eq!(beside.len(), 30, "both trunks print on layers 0 to 29");
        let overlapping: Vec<usize> = beside.iter().filter(|b| b.1).map(|b| b.0).collect();
        // It steps clear one lean step a layer under the column's top, and
        // overlaps again only where every trunk widens for the bed.
        assert_eq!(overlapping, vec![0, 26, 27, 28, 29]);
        assert_eq!(s.layers, s.rebuilt(&bands, &contours));
    }

    #[test]
    fn a_kept_trunk_takes_only_as_many_regrown_tips_as_its_section_carries() {
        // A 1 mm column up to layer 38 already carrying 31 tips has room for
        // a 32nd: section_radius(32) is 0.996 mm and section_radius(33) is
        // 1.012 mm. Two pads, either side of it, each grow one tip.
        let pads = [
            rect(2.25, -0.25, 2.75, 0.25),
            rect(-2.75, -0.25, -2.25, 0.25),
        ];
        let contours = vec![Vec::new(); 41];
        let grow = |edits: Vec<SupportEdit>| {
            let (bands, mut s) = kept_column(1.0, 38, 31.0, &pads);
            let kept = bits(&s.forest.limbs[0]);
            let out = s.apply(&edits, &bands, &contours);
            assert!(
                out.iter().all(|o| o.status == EditStatus::Applied),
                "{out:?}"
            );
            assert_eq!(bits(&s.forest.limbs[0]), kept);
            assert_eq!(s.layers, s.rebuilt(&bands, &contours));
            s.forest.limbs.iter().map(|l| l.end).collect::<Vec<End>>()
        };
        let one_taken = vec![End::Landed, End::Merged { into: NodeId(1) }, End::Bed];
        // Both tips in one regrow, then one regrow per pad.
        assert_eq!(grow(vec![regrow_pads(pads.to_vec())]), one_taken);
        assert_eq!(
            grow(vec![
                regrow_pads(vec![pads[0].clone()]),
                regrow_pads(vec![pads[1].clone()]),
            ]),
            one_taken
        );
    }
}
