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
use crate::support::SupportLayer;
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
    /// Column or trunk volume with neither support nor part under it.
    /// Interface decks spanning between tree tips are bridges and are not counted.
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
}

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
    let regions: Vec<Vec<Loop>> = planned.supports.par_iter().map(support_region).collect();
    let columns: Vec<Vec<Loop>> = planned.supports.par_iter().map(column_region).collect();
    let rows: Vec<LayerRow> = (0..bands.len())
        .into_par_iter()
        .map(|i| {
            let band = bands[i];
            let (fresh, stats) = index.slice_with_stats(band.cut_z());
            let mid = &fresh;
            let piece = &planned.contours[i];
            let region = &regions[i];
            let floating = if i == 0 || columns[i].is_empty() {
                0.0
            } else {
                let below = boolean_union(&regions[i - 1], &planned.contours[i - 1]);
                area_min(
                    &boolean_diff(&columns[i], &offset_loops(&below, FLOAT_TOLERANCE_MM)),
                    FLOAT_SPECK_MM2,
                )
            };
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
            let skin_band = boolean_diff(piece, &offset_loops(piece, -settings.line_width * 0.5));
            let open_skin = if skin_band.is_empty() {
                0.0
            } else {
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
                boolean_diff(&skin_band, &bead_cover(&printed))
                    .iter()
                    .map(|l| signed_area(l).abs())
                    .filter(|a| *a >= OPEN_SKIN_SPECK_MM2)
                    .sum()
            };
            LayerRow {
                z: band.z,
                unskinned,
                open_skin,
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
    Ok(out)
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
        .branches
        .iter()
        .zip(&layer.radii)
        .map(|(c, r)| {
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
