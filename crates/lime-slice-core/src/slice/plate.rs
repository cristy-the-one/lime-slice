//! Plates: several objects on one bed. Each object is planned alone in its own
//! part frame. The plate join only interleaves what the objects planned, so it
//! is the one step besides emit that reads where the objects sit.

use std::sync::Arc;

use super::{Collision, SliceSettings};
use crate::adaptive::LayerBand;
use crate::gcode::{Entry, PlateLayer, PrintLayer, Run};
use crate::strategy::{StrategyId, ZHopMode};
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
