//! Plates: several objects on one bed. Each object is planned alone in its own
//! part frame. The plate join only interleaves what the objects planned, so it
//! is the one step besides emit that reads where the objects sit.

use std::sync::Arc;

use rayon::prelude::*;
use sha2::{Digest, Sha256};

use super::{Collision, Contours, SliceSettings, SupportPlan, XyRect};
use crate::adaptive::LayerBand;
use crate::gcode::{Entry, PlateLayer, PrintLayer, Run};
use crate::poly::{boolean_union, loop_bounds, Loop};
use crate::strategy::{StrategyId, ZHopMode};
use crate::support::SupportOpts;
use crate::toolpath::Extrusion;

/// One layer Z of the plate, and for each object printing at it, the object
/// and the index of its own band there.
pub(super) struct PlateBand {
    pub z: f64,
    pub height: f64,
    pub members: Vec<(usize, usize)>,
}

/// The objects' bands merged by `(z, height)`, lowest first. Objects share
/// every band below the shorter one's clipped top, so only that top makes
/// a plate layer of its own.
pub(super) fn plate_bands(per_object: &[&[LayerBand]]) -> Vec<PlateBand> {
    let mut all: Vec<(f64, f64, usize, usize)> = per_object
        .iter()
        .enumerate()
        .flat_map(|(o, bands)| {
            bands
                .iter()
                .enumerate()
                .map(move |(i, b)| (b.z, b.height, o, i))
        })
        .collect();
    all.sort_by(|a, b| {
        a.0.total_cmp(&b.0)
            .then(a.1.total_cmp(&b.1))
            .then(a.2.cmp(&b.2))
    });
    let mut out: Vec<PlateBand> = Vec::new();
    for (z, height, o, i) in all {
        match out.last_mut() {
            Some(band)
                if band.z.to_bits() == z.to_bits() && band.height.to_bits() == height.to_bits() =>
            {
                band.members.push((o, i));
            }
            _ => out.push(PlateBand {
                z,
                height,
                members: vec![(o, i)],
            }),
        }
    }
    out
}

/// One object's planned layers as the join reads them.
pub(super) struct Joinable<'a> {
    pub layers: &'a [PrintLayer],
    /// How many leading paths of each layer are its head: skirt and supports.
    pub heads: &'a [usize],
    pub offset: [f64; 2],
    /// Written before the object's part tour on a plate of two or more.
    pub label: Option<Arc<str>>,
}

/// Every plate layer: the head of each object in plate order, then the part
/// of each object in plate order. A run keeps the travel its object planned
/// when the run before it is the same object's, since the nozzle is then
/// where that object alone would have left it.
pub(super) fn join(
    objects: &[Joinable<'_>],
    bands: &[PlateBand],
    settings: &SliceSettings,
) -> Vec<PlateLayer> {
    let mut last: Option<(u16, [f64; 2])> = None;
    bands
        .iter()
        .enumerate()
        .map(|(index, band)| {
            let run = |o: usize, i: usize, paths: std::ops::Range<usize>, label| Run {
                object: o as u16,
                layer: objects[o].layers[i].clone(),
                paths,
                entry: Entry::AsPlanned,
                label,
            };
            let mut runs = Vec::new();
            for &(o, i) in &band.members {
                let head = objects[o].heads[i];
                if head > 0 {
                    runs.push(run(o, i, 0..head, None));
                }
            }
            for &(o, i) in &band.members {
                let (head, len) = (objects[o].heads[i], objects[o].layers[i].paths.len());
                if len > head {
                    runs.push(run(o, i, head..len, objects[o].label.clone()));
                }
            }
            for r in &mut runs {
                let offset = objects[r.object as usize].offset;
                let mut printed = r.layer.paths[r.paths.clone()]
                    .iter()
                    .filter(|p| !p.points.is_empty());
                let (Some(first), Some(end)) = (printed.clone().next(), printed.next_back()) else {
                    continue;
                };
                if let Some((_, from)) = last.filter(|(o, _)| *o != r.object) {
                    let to = bed(first.points[0], offset);
                    r.entry = Entry::Cross {
                        z_hop: cross_hop(settings, first, (to[0] - from[0]).hypot(to[1] - from[1])),
                    };
                }
                last = Some((r.object, bed(end.points[end.points.len() - 1], offset)));
            }
            PlateLayer {
                index,
                z: band.z,
                height: band.height,
                note: layer_note(objects, band),
                runs,
            }
        })
        .collect()
}

/// The note of the first object that prints its part on the band, else of
/// the first object on it.
fn layer_note(objects: &[Joinable<'_>], band: &PlateBand) -> String {
    let printing = band
        .members
        .iter()
        .find(|&&(o, i)| objects[o].layers[i].paths.len() > objects[o].heads[i]);
    printing
        .or(band.members.first())
        .map(|&(o, i)| objects[o].layers[i].note.clone())
        .unwrap_or_default()
}

fn bed(p: [f64; 2], offset: [f64; 2]) -> [f64; 2] {
    [p[0] + offset[0], p[1] + offset[1]]
}

/// The hop of a travel from another object into `path`, `dist` long on the
/// bed. It leaves one part for another, so it hops whenever z-hop applies to
/// the path's strategy and the travel is long enough.
fn cross_hop(settings: &SliceSettings, path: &Extrusion, dist: f64) -> f64 {
    let policy = match settings.z_hop {
        ZHopMode::Blend if path.strategy == StrategyId::Toughness => ZHopMode::Smart,
        ZHopMode::Blend => ZHopMode::Off,
        other => other,
    };
    let off = policy == ZHopMode::Off
        || settings.z_hop_height <= 1e-6
        || !path.z_frac.is_empty()
        || dist < settings.z_hop_min_travel;
    if off {
        0.0
    } else {
        settings.z_hop_height
    }
}

/// Another object of the plate, as one object's supports may see it.
pub(super) struct Neighbour {
    pub cut: Arc<Contours>,
    /// Its cut's content key, so the obstacle list does not depend on plate order.
    pub key: [u8; 32],
    /// Added to its coordinates to bring them into the seeing object's frame.
    pub shift: [f64; 2],
}

/// Other objects a support plan grows among: their outlines unioned with the
/// part's on each layer, and the key of that list.
pub(super) struct Ground {
    pub solid: Arc<Vec<Vec<Loop>>>,
    pub key: [u8; 32],
}

/// How close another object may come to a support plan's printed box on a
/// layer and still be left out of its growth, mm: the support XY gap and a
/// millimetre more.
pub(super) fn margin() -> f64 {
    SupportOpts::default().xy_gap + 1.0
}

/// One object's supports among the others. `grow` plans them among a ground,
/// or alone for `None`. The closure starts from the alone growth and adds
/// every object that comes within `margin` of the plan's box on some layer,
/// then grows again among all added so far, until none is added. It reads
/// only the cuts and the shifts, never a plan held in memory, so a cold slice
/// and a kept one grow the same supports.
pub(super) fn settle<T>(
    cut: &Contours,
    neighbours: &[Neighbour],
    mut grow: impl FnMut(Option<Ground>) -> Result<T, String>,
    plan_of: impl Fn(&T) -> &SupportPlan,
) -> Result<T, String> {
    let mut plan = grow(None)?;
    let mut near: Vec<usize> = Vec::new();
    loop {
        let reach = plan_of(&plan).supports.reach();
        let found: Vec<usize> = (0..neighbours.len())
            .filter(|k| !near.contains(k) && meets(cut, &reach, &neighbours[*k]))
            .collect();
        if found.is_empty() {
            return Ok(plan);
        }
        near.extend(found);
        near.sort_by(|&a, &b| {
            let bits = |n: &Neighbour| (n.key, n.shift.map(f64::to_bits));
            bits(&neighbours[a]).cmp(&bits(&neighbours[b]))
        });
        let mut key = Sha256::new();
        for &k in &near {
            key.update(neighbours[k].key);
            for v in neighbours[k].shift {
                key.update(v.to_bits().to_le_bytes());
            }
        }
        plan = grow(Some(Ground {
            solid: Arc::new(solid_among(cut, neighbours, &near)),
            key: key.finalize().into(),
        }))?;
    }
}

/// `neighbour`, grown by the margin, overlaps the printed box of a support
/// plan on some layer of `cut`.
fn meets(cut: &Contours, reach: &[Option<XyRect>], neighbour: &Neighbour) -> bool {
    let pad = margin();
    let boxes = neighbour.cut.boxes();
    cut.bands.iter().zip(reach).any(|(band, printed)| {
        let (Some((lo, hi)), Some(j)) = (printed, neighbour.cut.band_at(band)) else {
            return false;
        };
        boxes[j].is_some_and(|(nlo, nhi)| {
            let [dx, dy] = neighbour.shift;
            nlo[0] + dx - pad <= hi[0]
                && lo[0] <= nhi[0] + dx + pad
                && nlo[1] + dy - pad <= hi[1]
                && lo[1] <= nhi[1] + dy + pad
        })
    })
}

/// Each layer of `cut` with the outlines of the objects in `near` at the
/// same Z, moved into its frame. Outlines whose boxes do not touch are kept
/// side by side; ones that do are unioned.
fn solid_among(cut: &Contours, neighbours: &[Neighbour], near: &[usize]) -> Vec<Vec<Loop>> {
    cut.bands
        .par_iter()
        .enumerate()
        .map(|(i, band)| {
            let mut solid = cut.contours[i].clone();
            for &k in near {
                let n = &neighbours[k];
                let Some(j) = n.cut.band_at(band) else {
                    continue;
                };
                let [dx, dy] = n.shift;
                let moved: Vec<Loop> = n.cut.contours[j]
                    .iter()
                    .map(|l| l.iter().map(|p| [p[0] + dx, p[1] + dy]).collect())
                    .collect();
                let touch = match (loop_bounds(&solid), loop_bounds(&moved)) {
                    (Some((alo, ahi)), Some((blo, bhi))) => {
                        alo[0] <= bhi[0] && blo[0] <= ahi[0] && alo[1] <= bhi[1] && blo[1] <= ahi[1]
                    }
                    _ => false,
                };
                if touch {
                    solid = boolean_union(&solid, &moved);
                } else {
                    solid.extend(moved);
                }
            }
            solid
        })
        .collect()
}

/// Every pair of objects whose XY boxes on the bed overlap with positive
/// area, in plate order.
pub(super) fn collisions(boxes: &[(&str, [f64; 2], [f64; 2])]) -> Vec<Collision> {
    let mut out = Vec::new();
    for (i, a) in boxes.iter().enumerate() {
        for b in &boxes[i + 1..] {
            let lo = [a.1[0].max(b.1[0]), a.1[1].max(b.1[1])];
            let hi = [a.2[0].min(b.2[0]), a.2[1].min(b.2[1])];
            if hi[0] > lo[0] && hi[1] > lo[1] {
                out.push(Collision {
                    a: a.0.to_owned(),
                    b: b.0.to_owned(),
                    overlap: [lo[0], lo[1], hi[0], hi[1]],
                });
            }
        }
    }
    out
}
