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
use crate::support::{Disk, End, Forest, SupportLayer};
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
    let bands = &planned.bands;
    let supports = &planned.supports.layers;
    let regions: Vec<Vec<Loop>> = supports.par_iter().map(support_region).collect();
    let columns: Vec<Vec<Loop>> = supports.par_iter().map(column_region).collect();
    let rows: Vec<LayerRow> = (0..bands.len())
        .into_par_iter()
        .map(|i| {
            let band = bands[i];
            let (fresh, stats) = index.slice_with_stats(band.cut_z());
            let mid = &fresh;
            let piece = &planned.contours[i];
            let region = &regions[i];
            let column_floating = if i == 0 || columns[i].is_empty() {
                0.0
            } else {
                let below = boolean_union(&regions[i - 1], &planned.contours[i - 1]);
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
                    &planned.contours[i - 1],
                )
            };
            let floating = column_floating + iface_floating;
            let exposed = match planned.contours.get(i + 1) {
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

    #[test]
    fn specks_under_the_floor_are_dropped() {
        let loops = vec![square(0.0, 0.0, 0.2), square(5.0, 5.0, 1.0)];
        assert!((uncovered_area(&loops) - 1.0).abs() < 1e-9);
    }
}
