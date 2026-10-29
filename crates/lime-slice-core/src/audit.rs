//! Geometry checks on a finished plan: did the contours keep the whole part, and
//! does every support region stand on something?

use std::time::Instant;

use rayon::prelude::*;
use serde::Serialize;

use crate::index::ZIndex;
use crate::mesh::Mesh;
use crate::poly::{
    boolean_diff, boolean_intersect, boolean_union, offset_loops, signed_area, Loop,
};
use crate::slice::{plan, SliceSettings};
use crate::strategy::BlendMode;
use crate::support::{CoverageGap, Disk, End, Forest, SupportLayer};
use crate::toolpath::{bead_cover, Extrusion, PathKind};

/// Reach a support region may have past what is under it: a bead half-width plus
/// one tree lean step. Anything farther out is printed in air.
const FLOAT_TOLERANCE_MM: f64 = 0.5;
/// A trunk disk at the 0.3 mm floor covers about 0.28 mm². The 0.3 mm² noise
/// filter used for other areas would hide that whole disk and report no
/// floating support while it still prints.
const FLOAT_SPECK_MM2: f64 = 0.05;
/// Support this close inside the part outline is rounding, not a collision.
const INSIDE_TOLERANCE_MM: f64 = 0.1;
/// Uncovered skin pieces smaller than this are bead-corner rounding, not an opening.
const OPEN_SKIN_SPECK_MM2: f64 = 0.05;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SliceAudit {
    pub layers: usize,
    pub plan_ms: f64,
    /// Signed volume of the mesh. Holes in the mesh make this approximate.
    pub mesh_volume_mm3: f64,
    /// Sum of contour area times layer height.
    pub sliced_volume_mm3: f64,
    /// Material the planner's contours lost against a fresh cut at the same Z.
    pub missing_mm3: f64,
    /// Layers where the cut had to close a chain across a mesh hole.
    pub repaired_layers: usize,
    /// Gap length closed across mesh holes, summed over layers. Coverage can
    /// read 100% while this many millimetres of wall were invented.
    pub bridged_mm: f64,
    /// Open chains that could not be closed, across all layers.
    pub dropped_chains: usize,
    pub support_mm3: f64,
    /// Support volume inside the mesh cross-section at mid-layer.
    pub support_inside_mm3: f64,
    /// Column, trunk, or interface volume with neither support nor part under it.
    /// An interface deck that reaches a tree tip, or the interface under it, is a
    /// bridge and is not counted. A patch with nothing under it is.
    pub support_floating_mm3: f64,
    pub floating_layers: usize,
    /// Top surface (area not covered by the next layer) that no solid bead covers.
    /// Sparse infill showing through a roof reads as a hole in the preview.
    pub unskinned_top_mm2: f64,
    /// Z of the layer with the most unskinned top area, and that area in mm².
    pub worst_unskinned: Option<(f64, f64)>,
    /// Z of the layer with the most floating support area, and that area in mm².
    pub worst_floating: Option<(f64, f64)>,
    /// Outline band half a bead deep that no part bead covers, summed over layers.
    /// A wall this thin prints nothing there, so the surface has a hole you can see through.
    pub open_skin_mm2: f64,
    /// Z of the layer with the most open skin, and that area in mm².
    pub worst_open_skin: Option<(f64, f64)>,
    /// Part bead footprint more than half a bead outside the layer's outline,
    /// summed over layers. Material printed where the model has a hole.
    pub stray_bead_mm2: f64,
    /// Z of the layer with the most stray bead area, and that area in mm².
    pub worst_stray: Option<(f64, f64)>,
    /// Tree disks grouped by how far under an interface they stand.
    pub tree_depths: Vec<TreeDepth>,
    /// Tree supports as the walk grew them, before disks settle on each other.
    pub trees: TreeCensus,
    /// Demanded interface the supports leave unheld, largest patch first.
    pub coverage: Vec<CoverageGap>,
    /// Part beads that stand on nothing.
    pub part_hold: PartHold,
}

/// Part beads that stand on nothing: wall, skin, infill, bridge and gap-fill
/// beads that no bead, support or belt holds. A slice whose supports all
/// stand can still print a roof row in the air; this is the measure for that.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartHold {
    /// Part bead length checked.
    pub part_mm: f64,
    /// Part beads with no part bead under them within half a bead. Supports
    /// or the stacking rule may still hold them.
    pub no_bead_under_mm: f64,
    /// Part beads nothing holds.
    pub unheld_mm: f64,
    /// Of those, the beads with no held bead beside them on their own layer
    /// either: they hang in the air rather than from a neighbour.
    pub dangling_mm: f64,
    /// The longest stretch of one path that stands on nothing, nearly
    /// straight: how far a bead spans the air. A bridge between two walls
    /// spans the gap between them; a row laid along a hollow spans all of it.
    pub longest_span_mm: f64,
    /// Unheld beads in touching groups, counted.
    pub patches: usize,
    /// The largest groups first, at most [`HOLD_PATCHES_KEPT`].
    pub largest: Vec<HoldPatch>,
}

/// One group of unheld part beads on touching layers.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HoldPatch {
    pub mm: f64,
    pub dangling_mm: f64,
    /// Its longest span, as [`PartHold::longest_span_mm`].
    pub longest_span_mm: f64,
    /// First and last printed layer, counted from 0.
    pub layers: [usize; 2],
    /// Where its first layer starts, in the plate frame: X and Y on the bed
    /// or the belt, Z up from it.
    pub at: [f64; 3],
    /// Its first layer's unheld beads, at most [`HOLD_FIRST_POINTS`] of them
    /// spread along it, in the plate frame as `at`: where the patch was born,
    /// for matching it to the model edge it hangs from.
    pub first: Vec<[f64; 3]>,
}

pub const HOLD_PATCHES_KEPT: usize = 20;
/// Points kept of a patch's first layer.
pub const HOLD_FIRST_POINTS: usize = 12;
/// Part beads are sampled this often along their path.
const HOLD_STEP_MM: f64 = 0.2;
/// Row height of the sample index across the layer.
const HOLD_ROW_MM: f64 = 0.05;
/// A bead this close to the belt stands on it.
const HOLD_BELT_MM: f64 = 0.3;
/// How far back against gravity a bead may reach over what is under it.
const HOLD_UPHILL_MM: f64 = 0.3;
/// How far downhill it may lean onto what is under it: a belt bead sags
/// onto the row below.
const HOLD_DOWNHILL_MM: f64 = 0.5;
/// An unheld bead with a held bead this close on its own layer hangs from it.
const HOLD_NEIGHBOUR_MM: f64 = 0.5;
/// A span runs on along its path through a turn up to this sharp. A zigzag's
/// rows are spans of their own; a curve sampled in short steps is one.
const HOLD_SPAN_TURN_DEG: f64 = 30.0;

/// How the check reads one slice: bead width, Z gap and the frame.
#[derive(Clone, Copy, Debug)]
pub(crate) struct HoldRule {
    pub half_bead: f64,
    /// Support this many layers under the gap still holds a bead.
    pub gap_layers: usize,
    /// The frame that laid the plate flat on a belt. Absent on a flat bed.
    pub belt: Option<crate::belt::Frame>,
    /// Slice Y plus this is the distance down the nozzle plane from where
    /// the gantry's coordinate starts, the same on every layer. The index
    /// rows start there, so they fall where they do in the G-code.
    origin: f64,
}

impl HoldRule {
    pub(crate) fn new(
        line_width: f64,
        layer_height: f64,
        z_gap: f64,
        belt: Option<(crate::belt::Frame, f64)>,
    ) -> Self {
        Self {
            half_bead: line_width * 0.5,
            gap_layers: (z_gap / layer_height.max(1e-6)).round().max(1.0) as usize,
            belt: belt.map(|(frame, _)| frame),
            origin: belt.map_or(0.0, |(f, start)| f.y_shift - f.z_drop - start),
        }
    }

    /// Across, uphill and downhill reach, and the neighbour's reach across.
    /// A belt's slice frame has gravity along +Y in every layer, so a bead may
    /// sag that way. A flat bed has no downhill side.
    fn reach(&self) -> (f64, f64, f64, f64) {
        match self.belt {
            Some(_) => (
                self.half_bead,
                HOLD_UPHILL_MM,
                HOLD_DOWNHILL_MM,
                self.half_bead,
            ),
            None => (
                HOLD_UPHILL_MM,
                HOLD_UPHILL_MM,
                HOLD_UPHILL_MM,
                HOLD_NEIGHBOUR_MM,
            ),
        }
    }

    /// How far gravity carries a point down `dz` of slice height, along +Y.
    fn drift(&self, dz: f64) -> f64 {
        self.belt.map_or(0.0, |f| dz * f.sin_a / f.cos_a)
    }

    fn plate(&self, x: f64, y: f64, z: f64) -> [f64; 3] {
        self.belt.map_or([x, y, z], |f| f.lab(x, y, z))
    }
}

/// One printed layer for the check: its index, slice Z, and its beads in bed
/// coordinates (the path's points plus the offset).
pub(crate) struct HoldLayer<'a> {
    pub index: usize,
    pub z: f64,
    pub beads: Vec<HoldBead<'a>>,
}

/// A path's kind, its points, and the offset that puts them on the bed.
pub(crate) type HoldBead<'a> = (PathKind, &'a [[f64; 2]], [f64; 2]);

/// An unheld sample: layer, X, Y, length, whether it dangles, and the length
/// of the span it is in.
type Unheld = (usize, f64, f64, f64, bool, f64);

fn holds_up_part(kind: PathKind) -> bool {
    matches!(
        kind,
        PathKind::Wall
            | PathKind::Outer
            | PathKind::Inner
            | PathKind::ThinWall
            | PathKind::GapFill
            | PathKind::Infill
            | PathKind::Sparse
            | PathKind::Solid
            | PathKind::Top
            | PathKind::Bridge
    )
}

/// Sample points of one layer: rows of `HOLD_ROW_MM` across Y, each with
/// its X values sorted. A window takes whole rows, so it reaches up to one
/// row further than asked. `origin` puts the row edges where the gantry's
/// own coordinate has them on a belt.
struct Rows {
    rows: std::collections::HashMap<i64, Vec<f64>>,
    origin: f64,
}

impl Rows {
    fn new(points: impl Iterator<Item = [f64; 2]>, origin: f64) -> Self {
        let mut rows: std::collections::HashMap<i64, Vec<f64>> = Default::default();
        for [x, y] in points {
            rows.entry(((y + origin) / HOLD_ROW_MM).floor() as i64)
                .or_default()
                .push(x);
        }
        for row in rows.values_mut() {
            row.sort_by(f64::total_cmp);
        }
        Self { rows, origin }
    }

    /// Any point in the rows from `lo` to `hi` within `across` of `x`.
    fn hit(&self, x: f64, lo: f64, hi: f64, across: f64) -> bool {
        let (a, b) = (
            ((lo + self.origin) / HOLD_ROW_MM).floor() as i64,
            ((hi + self.origin) / HOLD_ROW_MM).floor() as i64,
        );
        (a..=b).any(|r| {
            self.rows.get(&r).is_some_and(|row| {
                let j = row.partition_point(|&v| v < x - across);
                j < row.len() && row[j] <= x + across
            })
        })
    }
}

struct Sample {
    x: f64,
    y: f64,
    mm: f64,
    /// A span through the sample before ends here: a new path, or a turn
    /// sharper than [`HOLD_SPAN_TURN_DEG`].
    turn: bool,
}

fn samples(layer: &HoldLayer, part: bool) -> Vec<Sample> {
    let mut out = Vec::new();
    for &(kind, points, [dx, dy]) in &layer.beads {
        let is_part = holds_up_part(kind);
        let is_support = matches!(kind, PathKind::Support | PathKind::SupportInterface);
        if (part && !is_part) || (!part && !is_support) {
            continue;
        }
        let straight = HOLD_SPAN_TURN_DEG.to_radians().cos();
        let mut heading: Option<[f64; 2]> = None;
        for w in points.windows(2) {
            let ([x0, y0], [x1, y1]) = (w[0], w[1]);
            let len = (x1 - x0).hypot(y1 - y0);
            if len <= 0.0 {
                continue;
            }
            let dir = [(x1 - x0) / len, (y1 - y0) / len];
            let turn = heading.is_none_or(|h| h[0] * dir[0] + h[1] * dir[1] < straight);
            heading = Some(dir);
            let n = ((len / HOLD_STEP_MM) as usize).max(1);
            for i in 0..n {
                let f = (i as f64 + 0.5) / n as f64;
                out.push(Sample {
                    x: x0 + (x1 - x0) * f + dx,
                    y: y0 + (y1 - y0) * f + dy,
                    mm: len / n as f64,
                    turn: turn && i == 0,
                });
            }
        }
    }
    out
}

/// The check on a plate's emitted layers. Later belt copies repeat the
/// first one's layers and are left out.
pub(crate) fn plate_hold(
    layers: &[crate::gcode::PlateLayer],
    offsets: &[[f64; 2]],
    rule: &HoldRule,
) -> PartHold {
    let held: Vec<HoldLayer> = layers
        .iter()
        .filter(|l| l.belt_shift == 0.0 && !l.is_empty())
        .map(|l| HoldLayer {
            index: l.index,
            z: l.z,
            beads: l
                .paths()
                .map(|(object, p)| {
                    let offset = offsets.get(object as usize).copied().unwrap_or([0.0, 0.0]);
                    (p.kind, p.points.as_slice(), offset)
                })
                .collect(),
        })
        .collect();
    part_hold(&held, rule)
}

/// The part-bead check on printed layers in print order. A part bead is held
/// by any of:
/// 1. a part bead on the layer below within half a bead;
/// 2. a part, support or interface bead on the layer below that it can lean
///    on: within `across`, and from `uphill` back to `downhill` along gravity;
/// 3. support or interface within the Z gap below it, out to where gravity
///    carries it on that layer;
/// 4. the belt, or the first layer.
///
/// Unheld beads are grouped over 1 mm cells on the same or the next layer.
pub(crate) fn part_hold(layers: &[HoldLayer], rule: &HoldRule) -> PartHold {
    let origin = rule.origin;
    let parts: Vec<Vec<Sample>> = layers.par_iter().map(|l| samples(l, true)).collect();
    let part_rows: Vec<Rows> = parts
        .par_iter()
        .map(|s| Rows::new(s.iter().map(|s| [s.x, s.y]), origin))
        .collect();
    let support_rows: Vec<Rows> = layers
        .par_iter()
        .map(|l| Rows::new(samples(l, false).into_iter().map(|s| [s.x, s.y]), origin))
        .collect();
    let (across, uphill, downhill, neighbour) = rule.reach();
    let half = rule.half_bead;
    // (layer, x, y, mm, dangling) per unheld bead, and the strict sum per layer.
    let checked: Vec<(Vec<Unheld>, f64)> = (0..layers.len())
        .into_par_iter()
        .map(|li| {
            let z = layers[li].z;
            let mut held = Vec::new();
            let mut unheld = Vec::new();
            let mut strict = 0.0;
            // Each run of unheld samples along a path, and the run the last
            // sample was in, if it was unheld.
            let mut spans: Vec<f64> = Vec::new();
            let mut open = false;
            for s in &parts[li] {
                if s.turn {
                    open = false;
                }
                let on_belt = rule
                    .belt
                    .is_some_and(|f| f.lab(s.x, s.y, z)[2] <= HOLD_BELT_MM);
                if li == 0 || on_belt || part_rows[li - 1].hit(s.x, s.y - half, s.y + half, half) {
                    held.push([s.x, s.y]);
                    open = false;
                    continue;
                }
                strict += s.mm;
                let (lo, hi) = (s.y - uphill, s.y + downhill);
                let mut ok = part_rows[li - 1].hit(s.x, lo, hi, across)
                    || support_rows[li - 1].hit(s.x, lo, hi, across);
                for k in 1..=rule.gap_layers + 1 {
                    if ok || k > li {
                        break;
                    }
                    let drift = rule.drift(z - layers[li - k].z);
                    ok = support_rows[li - k].hit(s.x, s.y - uphill, s.y + drift + uphill, across);
                }
                if ok {
                    held.push([s.x, s.y]);
                    open = false;
                } else {
                    if !open {
                        spans.push(0.0);
                        open = true;
                    }
                    *spans.last_mut().unwrap() += s.mm;
                    unheld.push((s.x, s.y, s.mm, spans.len() - 1));
                }
            }
            let beside = Rows::new(held.into_iter(), origin);
            let unheld = unheld
                .into_iter()
                .map(|(x, y, mm, span)| {
                    let hangs =
                        beside.hit(x, y - HOLD_NEIGHBOUR_MM, y + HOLD_NEIGHBOUR_MM, neighbour);
                    (li, x, y, mm, !hangs, spans[span])
                })
                .collect();
            (unheld, strict)
        })
        .collect();
    let mut out = PartHold {
        part_mm: parts.iter().flatten().map(|s| s.mm).sum(),
        ..PartHold::default()
    };
    let bad: Vec<Unheld> = checked
        .into_iter()
        .flat_map(|(unheld, strict)| {
            out.no_bead_under_mm += strict;
            unheld
        })
        .collect();
    for b in &bad {
        out.unheld_mm += b.3;
        if b.4 {
            out.dangling_mm += b.3;
        }
        out.longest_span_mm = out.longest_span_mm.max(b.5);
    }
    // Patches: 1 mm cells in X and Y, joined to their neighbours on the same
    // layer and the next.
    let mut cells: std::collections::HashMap<(usize, i64, i64), Vec<usize>> = Default::default();
    for (k, &(li, x, y, ..)) in bad.iter().enumerate() {
        cells
            .entry((li, x.floor() as i64, y.floor() as i64))
            .or_default()
            .push(k);
    }
    let keys: Vec<(usize, i64, i64)> = cells.keys().copied().collect();
    let slot: std::collections::HashMap<(usize, i64, i64), usize> =
        keys.iter().enumerate().map(|(i, &c)| (c, i)).collect();
    let mut parent: Vec<usize> = (0..keys.len()).collect();
    fn find(parent: &mut [usize], mut c: usize) -> usize {
        while parent[c] != c {
            parent[c] = parent[parent[c]];
            c = parent[c];
        }
        c
    }
    for (i, &(li, cx, cy)) in keys.iter().enumerate() {
        for dl in 0..=1 {
            for dx in -1..=1 {
                for dy in -1..=1 {
                    if let Some(&j) = slot.get(&(li + dl, cx + dx, cy + dy)) {
                        let (a, b) = (find(&mut parent, i), find(&mut parent, j));
                        if a != b {
                            parent[a] = b;
                        }
                    }
                }
            }
        }
    }
    let mut groups: std::collections::HashMap<usize, Vec<usize>> = Default::default();
    for (i, key) in keys.iter().enumerate() {
        let root = find(&mut parent, i);
        groups.entry(root).or_default().extend(&cells[key]);
    }
    let mut patches: Vec<HoldPatch> = groups
        .into_values()
        .map(|members| {
            let first = members
                .iter()
                .copied()
                .min_by(|&a, &b| {
                    (bad[a].0, bad[a].1, bad[a].2)
                        .partial_cmp(&(bad[b].0, bad[b].1, bad[b].2))
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
                .expect("a patch has a bead");
            let (li, x, y, ..) = bad[first];
            // The first layer's samples in the order `at` was picked by, and an even spread of them.
            let mut born: Vec<(f64, f64)> = members
                .iter()
                .filter(|&&k| bad[k].0 == li)
                .map(|&k| (bad[k].1, bad[k].2))
                .collect();
            born.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let keep = born.len().min(HOLD_FIRST_POINTS);
            let first = (0..keep)
                .map(|i| {
                    let at = if keep > 1 {
                        i * (born.len() - 1) / (keep - 1)
                    } else {
                        0
                    };
                    let (px, py) = born[at];
                    rule.plate(px, py, layers[li].z)
                })
                .collect();
            HoldPatch {
                mm: members.iter().map(|&k| bad[k].3).sum(),
                dangling_mm: members
                    .iter()
                    .filter(|&&k| bad[k].4)
                    .map(|&k| bad[k].3)
                    .sum(),
                longest_span_mm: members.iter().map(|&k| bad[k].5).fold(0.0, f64::max),
                layers: [
                    layers[li].index,
                    layers[members.iter().map(|&k| bad[k].0).max().unwrap_or(li)].index,
                ],
                at: rule.plate(x, y, layers[li].z),
                first,
            }
        })
        .collect();
    patches.sort_by(|a, b| b.mm.total_cmp(&a.mm).then(a.layers.cmp(&b.layers)));
    out.patches = patches.len();
    patches.truncate(HOLD_PATCHES_KEPT);
    out.largest = patches;
    out
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeCensus {
    /// Tips the walk started, packed and seeded alike. Each one is a limb.
    pub tips: usize,
    /// Limbs that never merged into another.
    pub trees: usize,
    /// Tips carried by the largest tree.
    pub largest_tips: usize,
    /// From the highest tip of a tree down to the foot of its trunk.
    pub tallest_mm: f64,
    /// Limbs that ended standing on the part, pushed into it, or on the bed.
    pub on_part: usize,
    pub pinched: usize,
    pub on_bed: usize,
}

/// Tree trunk disks with interface `from_mm..to_mm` above their footprint.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeDepth {
    pub from_mm: f64,
    pub to_mm: f64,
    /// Disk slices counted on every layer, so a 1 mm tall branch at 0.2 mm counts 5.
    pub disks: usize,
    pub mean_radius_mm: f64,
    pub p90_radius_mm: f64,
    /// Trunk disk volume in this band.
    pub volume_mm3: f64,
}

const TREE_DEPTH_EDGES_MM: [f64; 6] = [0.0, 2.0, 5.0, 10.0, 20.0, f64::INFINITY];

pub fn audit_slice(
    mesh: &Mesh,
    blend: &BlendMode,
    settings: &SliceSettings,
    nozzle_diameter: f64,
) -> Result<SliceAudit, String> {
    let started = Instant::now();
    let planned = plan(mesh, blend, settings, nozzle_diameter)?;
    let plan_ms = started.elapsed().as_secs_f64() * 1000.0;
    let index = ZIndex::build(mesh);
    let bands = &planned.cut.bands;
    let supports = &planned.supports.layers;
    let regions: Vec<Vec<Loop>> = supports.par_iter().map(support_region).collect();
    let columns: Vec<Vec<Loop>> = supports.par_iter().map(column_region).collect();
    let rows: Vec<LayerRow> = (0..bands.len())
        .into_par_iter()
        .map(|i| {
            let band = bands[i];
            let (fresh, stats) = index.slice_with_stats(band.cut_z());
            let mid = &fresh;
            let piece = &planned.cut.contours[i];
            let region = &regions[i];
            let column_floating = if i == 0 || columns[i].is_empty() {
                0.0
            } else {
                let below = boolean_union(&regions[i - 1], &planned.cut.contours[i - 1]);
                area_min(
                    &boolean_diff(&columns[i], &offset_loops(&below, FLOAT_TOLERANCE_MM)),
                    FLOAT_SPECK_MM2,
                )
            };
            // Interface used to be ignored here, so a lavender island with no
            // trunk read as zero floating support.
            let iface_floating = if i == 0 {
                0.0
            } else {
                crate::support::orphan_interface_area(
                    &supports[i].interface,
                    &supports[i - 1],
                    &planned.cut.contours[i - 1],
                )
            };
            let floating = column_floating + iface_floating;
            let exposed = match planned.cut.contours.get(i + 1) {
                Some(above) => boolean_diff(piece, above),
                None => piece.clone(),
            };
            let unskinned = if exposed.is_empty() {
                0.0
            } else {
                let skin = skin_cover(&planned.layers[i].paths);
                area(&boolean_diff(&exposed, &skin))
            };
            let printed: Vec<Extrusion> = planned.layers[i]
                .paths
                .iter()
                .filter(|p| {
                    !matches!(
                        p.kind,
                        PathKind::Support | PathKind::SupportInterface | PathKind::Skirt
                    )
                })
                .cloned()
                .collect();
            let cover = bead_cover(&printed);
            let specks = |loops: Vec<Loop>| uncovered_area(&loops);
            let skin_band = boolean_diff(piece, &offset_loops(piece, -settings.line_width * 0.5));
            let open_skin = if skin_band.is_empty() {
                0.0
            } else {
                specks(boolean_diff(&skin_band, &cover))
            };
            let stray = specks(boolean_diff(
                &cover,
                &offset_loops(piece, settings.line_width * 0.5),
            ));
            LayerRow {
                z: band.z,
                unskinned,
                open_skin,
                stray,
                h: band.height,
                sliced: area(piece),
                missing: area(&boolean_diff(&fresh, piece)),
                stats,
                support: area(region),
                inside: area(&boolean_intersect(
                    region,
                    &offset_loops(mid, -INSIDE_TOLERANCE_MM),
                )),
                floating,
            }
        })
        .collect();
    let mut out = SliceAudit {
        layers: bands.len(),
        plan_ms,
        mesh_volume_mm3: mesh_volume(mesh),
        ..SliceAudit::default()
    };
    for row in &rows {
        out.sliced_volume_mm3 += row.sliced * row.h;
        out.missing_mm3 += row.missing * row.h;
        out.repaired_layers += usize::from(row.stats.bridged > 0);
        out.bridged_mm += row.stats.bridged_mm;
        out.dropped_chains += row.stats.dropped;
        out.support_mm3 += row.support * row.h;
        out.support_inside_mm3 += row.inside * row.h;
        out.support_floating_mm3 += row.floating * row.h;
        out.unskinned_top_mm2 += row.unskinned;
        out.open_skin_mm2 += row.open_skin;
        out.stray_bead_mm2 += row.stray;
        if row.stray > 0.0 && out.worst_stray.is_none_or(|(_, a)| row.stray > a) {
            out.worst_stray = Some((row.z, row.stray));
        }
        if row.open_skin > 0.0 && out.worst_open_skin.is_none_or(|(_, a)| row.open_skin > a) {
            out.worst_open_skin = Some((row.z, row.open_skin));
        }
        if row.unskinned > 0.0 && out.worst_unskinned.is_none_or(|(_, a)| row.unskinned > a) {
            out.worst_unskinned = Some((row.z, row.unskinned));
        }
        if row.floating > 0.0 {
            out.floating_layers += 1;
            if out.worst_floating.is_none_or(|(_, a)| row.floating > a) {
                out.worst_floating = Some((row.z, row.floating));
            }
        }
    }
    out.tree_depths = tree_depths(supports, bands);
    out.trees = tree_census(&planned.supports.forest, bands);
    out.coverage = planned.coverage;
    let hold_layers: Vec<HoldLayer> = planned
        .layers
        .iter()
        .enumerate()
        .filter(|(_, l)| !l.paths.is_empty())
        .map(|(i, l)| HoldLayer {
            index: i,
            z: l.z,
            beads: l
                .paths
                .iter()
                .map(|p| (p.kind, p.points.as_slice(), [0.0, 0.0]))
                .collect(),
        })
        .collect();
    let z_gap = settings
        .support_z_gap_mm
        .unwrap_or_else(|| settings.layer_height.max(0.12));
    out.part_hold = part_hold(
        &hold_layers,
        &HoldRule::new(settings.line_width, settings.layer_height, z_gap, None),
    );
    Ok(out)
}

/// Each limb joins the tree of the host it merged into. Hosts always have
/// the smaller id, so one pass in id order finds every root.
fn tree_census(forest: &Forest, bands: &[crate::adaptive::LayerBand]) -> TreeCensus {
    let n = forest.limbs.len();
    let mut census = TreeCensus {
        tips: n,
        ..TreeCensus::default()
    };
    let mut root = Vec::with_capacity(n);
    let mut tips = vec![0usize; n];
    let mut highest = vec![0usize; n];
    for (k, limb) in forest.limbs.iter().enumerate() {
        let r = match limb.end {
            End::Merged { into } => root[into.0 as usize - 1],
            End::Landed => {
                census.on_part += 1;
                k
            }
            End::Pinched => {
                census.pinched += 1;
                k
            }
            End::Bed => {
                census.on_bed += 1;
                k
            }
        };
        root.push(r);
        tips[r] += 1;
        highest[r] = highest[r].max(limb.top);
    }
    for (k, limb) in forest.limbs.iter().enumerate() {
        if root[k] != k {
            continue;
        }
        census.trees += 1;
        census.largest_tips = census.largest_tips.max(tips[k]);
        let foot = &bands[limb.top + 1 - limb.knots.len()];
        let tall = bands[highest[k]].z - (foot.z - foot.height);
        census.tallest_mm = census.tallest_mm.max(tall);
    }
    census
}

/// Vertical distance from each trunk disk up to the nearest interface over its
/// footprint, then radius statistics per depth band. A tree that thickens only
/// where it carries many tips keeps the shallow bands thin.
fn tree_depths(supports: &[SupportLayer], bands: &[crate::adaptive::LayerBand]) -> Vec<TreeDepth> {
    let bounds: Vec<Option<([f64; 2], [f64; 2])>> = supports
        .iter()
        .map(|s| crate::poly::loop_bounds(&s.interface))
        .collect();
    let samples: Vec<(f64, f64, f64)> = (0..supports.len())
        .into_par_iter()
        .flat_map_iter(|i| {
            let layer = &supports[i];
            let bounds = &bounds;
            layer.disks.iter().map(move |&Disk { xy: c, r, .. }| {
                let mut depth = f64::INFINITY;
                for j in i + 1..supports.len() {
                    let dz = bands[j].z - bands[i].z;
                    if dz > 60.0 {
                        break;
                    }
                    let Some((min, max)) = bounds[j] else {
                        continue;
                    };
                    if c[0] < min[0] - r
                        || c[0] > max[0] + r
                        || c[1] < min[1] - r
                        || c[1] > max[1] + r
                    {
                        continue;
                    }
                    let iface = &supports[j].interface;
                    if crate::poly::in_solid(iface, c[0], c[1])
                        || crate::poly::distance_to_outline(iface, c) <= r
                    {
                        depth = dz;
                        break;
                    }
                }
                (depth, r, bands[i].height)
            })
        })
        .collect();
    TREE_DEPTH_EDGES_MM
        .windows(2)
        .map(|w| {
            let mut radii: Vec<f64> = Vec::new();
            let mut volume = 0.0;
            for (d, r, h) in &samples {
                if *d >= w[0] && *d < w[1] {
                    radii.push(*r);
                    volume += std::f64::consts::PI * r * r * h;
                }
            }
            radii.sort_by(f64::total_cmp);
            let n = radii.len();
            TreeDepth {
                from_mm: w[0],
                to_mm: w[1],
                disks: n,
                mean_radius_mm: if n == 0 {
                    0.0
                } else {
                    radii.iter().sum::<f64>() / n as f64
                },
                p90_radius_mm: if n == 0 {
                    0.0
                } else {
                    radii[(n * 9 / 10).min(n - 1)]
                },
                volume_mm3: volume,
            }
        })
        .collect()
}

struct LayerRow {
    z: f64,
    h: f64,
    sliced: f64,
    missing: f64,
    stats: crate::index::CutStats,
    support: f64,
    inside: f64,
    floating: f64,
    unskinned: f64,
    open_skin: f64,
    stray: f64,
}

/// Area of `loops` without the specks, counted per outline with its holes.
/// A hairline ring between an outline and a bead that reaches it is an
/// outline and a hole of almost the same size. Adding their areas unsigned
/// counted twice the layer as open skin.
fn uncovered_area(loops: &[Loop]) -> f64 {
    crate::toolpath::island_loops(loops)
        .iter()
        .map(|island| island.iter().map(|l| signed_area(l)).sum::<f64>())
        .filter(|a| *a >= OPEN_SKIN_SPECK_MM2)
        .sum()
}

/// Footprint of the beads that close a surface: walls, gap fill, and solid skins.
fn skin_cover(paths: &[Extrusion]) -> Vec<Loop> {
    let solid: Vec<Extrusion> = paths
        .iter()
        .filter(|p| {
            matches!(
                p.kind,
                PathKind::Outer
                    | PathKind::Inner
                    | PathKind::Wall
                    | PathKind::ThinWall
                    | PathKind::GapFill
                    | PathKind::Solid
                    | PathKind::Top
                    | PathKind::Bridge
            )
        })
        .cloned()
        .collect();
    bead_cover(&solid)
}

/// Where this layer prints support: the sparse and interface regions, or the tree disks.
fn support_region(layer: &SupportLayer) -> Vec<Loop> {
    boolean_union(&column_region(layer), &layer.interface)
}

/// The load-bearing part of the support: grid columns or tree trunk disks.
fn column_region(layer: &SupportLayer) -> Vec<Loop> {
    let mut region = layer.sparse.clone();
    let disks: Vec<Loop> = layer
        .disks
        .iter()
        .map(|&Disk { xy: c, r, .. }| {
            (0..24)
                .map(|k| {
                    let a = k as f64 * std::f64::consts::TAU / 24.0;
                    [c[0] + r * a.cos(), c[1] + r * a.sin()]
                })
                .collect()
        })
        .collect();
    if !disks.is_empty() {
        region = boolean_union(&region, &crate::poly::resolve_nonzero(disks));
    }
    region
}

/// Area kept by a small union: specks under 0.3 mm² are clipping noise.
fn area(loops: &[Loop]) -> f64 {
    area_min(loops, 0.3)
}

fn area_min(loops: &[Loop], min: f64) -> f64 {
    loops
        .iter()
        .map(|l| signed_area(l))
        .filter(|a| a.abs() >= min)
        .sum::<f64>()
        .max(0.0)
}

fn mesh_volume(mesh: &Mesh) -> f64 {
    mesh.triangles
        .iter()
        .map(|[a, b, c]| {
            (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0])
                + a[2] * (b[0] * c[1] - b[1] * c[0]))
                / 6.0
        })
        .sum::<f64>()
        .abs()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square(x0: f64, y0: f64, side: f64) -> Loop {
        vec![
            [x0, y0],
            [x0 + side, y0],
            [x0 + side, y0 + side],
            [x0, y0 + side],
        ]
    }

    #[test]
    fn a_hairline_ring_counts_as_its_own_area() {
        let mut hole = square(0.05, 0.05, 9.9);
        hole.reverse();
        let ring = vec![square(0.0, 0.0, 10.0), hole];
        let area = uncovered_area(&ring);
        assert!((area - 1.99).abs() < 1e-6, "{area}");
    }

    /// A 45° belt frame that puts slice Z straight into lab height, so the
    /// belt never holds a bead in these tests above the first layer.
    fn belt_45() -> crate::belt::Frame {
        let s = std::f64::consts::FRAC_1_SQRT_2;
        crate::belt::Frame {
            sin_a: s,
            cos_a: s,
            z_drop: 0.0,
            y_shift: -1000.0,
        }
    }

    fn line(y: f64) -> Vec<[f64; 2]> {
        vec![[0.0, y], [10.0, y]]
    }

    type Stack = [Vec<(PathKind, Vec<[f64; 2]>)>];

    fn rows(stack: &Stack) -> Vec<HoldLayer<'_>> {
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

    fn check(stack: &Stack, belt: bool) -> PartHold {
        let rule = HoldRule::new(0.45, 0.2, 0.2, belt.then(|| (belt_45(), 0.0)));
        part_hold(&rows(stack), &rule)
    }

    #[test]
    fn a_bead_over_a_bead_is_held() {
        let stack = vec![
            vec![(PathKind::Outer, line(0.0))],
            vec![(PathKind::Outer, line(0.2))],
        ];
        let hold = check(&stack, true);
        assert!((hold.part_mm - 20.0).abs() < 1e-9, "{hold:?}");
        assert_eq!(hold.unheld_mm, 0.0, "{hold:?}");
        assert_eq!(hold.no_bead_under_mm, 0.0, "{hold:?}");
    }

    #[test]
    fn a_patch_keeps_a_spread_of_its_first_layer() {
        // A 10 mm row 5 mm off the one under it, then a row on top of it:
        // the patch is born on layer 1, along the whole row.
        let hold = check(
            &[
                vec![(PathKind::Outer, line(0.0))],
                vec![(PathKind::Outer, line(5.0))],
                vec![(PathKind::Outer, line(5.0))],
            ],
            false,
        );
        let patch = &hold.largest[0];
        assert_eq!(patch.layers, [1, 1], "{hold:?}");
        assert_eq!(patch.first.len(), HOLD_FIRST_POINTS, "{patch:?}");
        assert_eq!(patch.first[0], patch.at, "{patch:?}");
        let xs: Vec<f64> = patch.first.iter().map(|p| p[0]).collect();
        assert!(xs.windows(2).all(|w| w[0] <= w[1]), "{xs:?}");
        assert!(xs[0] < 0.5 && *xs.last().unwrap() > 9.5, "{xs:?}");
        assert!(
            patch
                .first
                .iter()
                .all(|p| (p[1] - 5.0).abs() < 1e-9 && (p[2] - 0.4).abs() < 1e-9),
            "{patch:?}"
        );
    }

    #[test]
    fn a_belt_bead_leans_downhill_further_than_uphill() {
        // Gravity runs along +Y in the slice frame. 0.4 mm downhill is
        // inside the 0.5 mm sag; 0.4 mm uphill is past the 0.3 mm reach.
        let down = check(
            &[
                vec![(PathKind::Outer, line(0.0))],
                vec![(PathKind::Outer, line(-0.4))],
            ],
            true,
        );
        assert!((down.no_bead_under_mm - 10.0).abs() < 1e-9, "{down:?}");
        assert_eq!(down.unheld_mm, 0.0, "{down:?}");
        let up = check(
            &[
                vec![(PathKind::Outer, line(0.0))],
                vec![(PathKind::Outer, line(0.4))],
            ],
            true,
        );
        assert!((up.unheld_mm - 10.0).abs() < 1e-9, "{up:?}");
        assert!((up.dangling_mm - 10.0).abs() < 1e-9, "{up:?}");
        assert_eq!(up.patches, 1);
        assert_eq!(up.largest[0].layers, [1, 1]);
        // A flat bed has no downhill side.
        let flat = check(
            &[
                vec![(PathKind::Outer, line(0.0))],
                vec![(PathKind::Outer, line(-0.4))],
            ],
            false,
        );
        assert!((flat.unheld_mm - 10.0).abs() < 1e-9, "{flat:?}");
    }

    #[test]
    fn support_under_the_gap_holds_where_gravity_carries_the_bead() {
        // Interface two layers down, 0.5 mm downhill: the bead falls 0.4 mm
        // along +Y over those two layers, plus the 0.3 mm reach.
        let stack = vec![
            vec![(PathKind::SupportInterface, line(0.5))],
            vec![],
            vec![(PathKind::Bridge, line(0.0))],
        ];
        let hold = check(&stack, true);
        assert_eq!(hold.unheld_mm, 0.0, "{hold:?}");
        let flat = check(&stack, false);
        assert!((flat.unheld_mm - 10.0).abs() < 1e-9, "{flat:?}");
    }

    #[test]
    fn a_bead_beside_a_held_bead_hangs_and_one_alone_dangles() {
        let stack = vec![
            vec![(PathKind::Outer, line(0.0))],
            vec![
                (PathKind::Outer, line(0.0)),
                (PathKind::Inner, line(0.4)),
                (PathKind::Solid, line(-3.0)),
            ],
        ];
        let hold = check(&stack, true);
        assert!((hold.unheld_mm - 20.0).abs() < 1e-9, "{hold:?}");
        assert!((hold.dangling_mm - 10.0).abs() < 1e-9, "{hold:?}");
        assert_eq!(hold.patches, 2, "{hold:?}");
    }

    #[test]
    fn a_span_runs_along_a_path_until_it_lands_or_turns() {
        // Over a floor from X 0 to 3: a row along X spans the 6.8 mm past it
        // and its reach, and a zigzag's rows across Y are spans of 2 mm each.
        let floor: Vec<_> = (0..20)
            .map(|k| {
                (
                    PathKind::Solid,
                    vec![[0.0, k as f64 * 0.4 - 4.0], [3.0, k as f64 * 0.4 - 4.0]],
                )
            })
            .collect();
        let along = check(
            &[floor.clone(), vec![(PathKind::GapFill, line(0.0))]],
            false,
        );
        assert!((along.longest_span_mm - 6.8).abs() < 0.11, "{along:?}");
        assert_eq!(along.largest[0].longest_span_mm, along.longest_span_mm);
        let zigzag = vec![
            [5.0, 0.0],
            [5.0, 2.0],
            [5.4, 2.0],
            [5.4, 0.0],
            [5.8, 0.0],
            [5.8, 2.0],
        ];
        let across = check(&[floor, vec![(PathKind::Bridge, zigzag)]], false);
        assert!((across.unheld_mm - 6.8).abs() < 0.11, "{across:?}");
        assert!((across.longest_span_mm - 2.0).abs() < 0.11, "{across:?}");
    }

    #[test]
    fn skirt_and_ironing_are_not_part_beads() {
        let stack = vec![
            vec![(PathKind::Outer, line(0.0))],
            vec![
                (PathKind::Skirt, line(5.0)),
                (PathKind::Ironing, line(-5.0)),
            ],
        ];
        let hold = check(&stack, true);
        assert!((hold.part_mm - 10.0).abs() < 1e-9, "{hold:?}");
        assert_eq!(hold.unheld_mm, 0.0);
    }

    #[test]
    fn specks_under_the_floor_are_dropped() {
        let loops = vec![square(0.0, 0.0, 0.2), square(5.0, 5.0, 1.0)];
        assert!((uncovered_area(&loops) - 1.0).abs() < 1e-9);
    }
}
