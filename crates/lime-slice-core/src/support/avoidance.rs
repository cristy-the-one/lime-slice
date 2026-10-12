//! Per-layer regions a tree branch must not enter.
//!
//! A center of a given radius is forbidden where the part, grown by the XY gap
//! and that radius, occupies it, and where a step of one layer's lean cannot
//! reach a place the branch can still leave. The bed foot is the trunk radius,
//! because a branch that reaches the bed is widened to it. Built only when the
//! request asks, and read by the walk that already merges and pushes.

use rayon::prelude::*;

use crate::adaptive::LayerBand;
use crate::poly::{boolean_diff, boolean_union, drop_slivers, in_solid, offset_loops, loop_bounds, Loop};

use super::{clip_half, FloorPlane};

/// Forbidden centers, `[layer][radius bucket]`. `bed` must reach the bed or
/// the belt. `model` may also stop on a roof.
pub(crate) struct Avoidance {
    buckets: Vec<f64>,
    bed: Vec<Vec<Vec<Loop>>>,
    model: Vec<Vec<Vec<Loop>>>,
}

/// What a branch may do while the areas are built. One argument, so the
/// walk's constructor stays under the argument limit.
#[derive(Clone, Copy)]
pub(crate) struct AvoidanceSpec {
    pub xy_gap: f64,
    pub lean: f64,
    pub tip_r: f64,
    pub trunk_r: f64,
    pub flare: f64,
    pub floor: Option<FloorPlane>,
}

impl Avoidance {
    pub(crate) fn build(bands: &[LayerBand], contours: &[Vec<Loop>], spec: &AvoidanceSpec) -> Self {
        let AvoidanceSpec {
            xy_gap,
            lean,
            tip_r,
            trunk_r,
            flare,
            floor,
        } = *spec;
        let n = bands.len();
        let buckets = radius_buckets(tip_r, trunk_r);
        let b = buckets.len();
        if n == 0 || b == 0 {
            return Self {
                buckets,
                bed: Vec::new(),
                model: Vec::new(),
            };
        }
        let collision: Vec<Vec<Vec<Loop>>> = (0..n)
            .into_par_iter()
            .map(|i| {
                let part = contours.get(i).map(Vec::as_slice).unwrap_or(&[]);
                buckets
                    .iter()
                    .map(|&r| {
                        if part.is_empty() {
                            Vec::new()
                        } else {
                            offset_loops(part, xy_gap + r)
                        }
                    })
                    .collect()
            })
            .collect();
        let roofs = roof_layers(contours);
        let trunk_i = bucket_of(&buckets, trunk_r);
        let mut bed = vec![vec![Vec::new(); b]; n];
        let mut model = vec![vec![Vec::new(); b]; n];
        for bi in 0..b {
            bed[0][bi] = collision[0][trunk_i].clone();
            model[0][bi] = if roof_at(&roofs, 0) {
                boolean_diff(&bed[0][bi], contours.first().map(Vec::as_slice).unwrap_or(&[]))
            } else {
                bed[0][bi].clone()
            };
            clip_floor(&mut bed[0][bi], floor, bands, 0);
            clip_floor(&mut model[0][bi], floor, bands, 0);
        }
        for layer in 1..n {
            let step = (bands[layer].height * lean).clamp(0.05, 4.0);
            let part = contours.get(layer).map(Vec::as_slice).unwrap_or(&[]);
            for bi in 0..b {
                let r_below = if layer == 1 {
                    trunk_r
                } else {
                    (buckets[bi] + flare * bands[layer].height).min(trunk_r)
                };
                let below = bucket_of(&buckets, r_below);
                let trapped_bed = shrink(&bed[layer - 1][below], step);
                let trapped_model = shrink(&model[layer - 1][below], step);
                bed[layer][bi] = boolean_union(&collision[layer][bi], &trapped_bed);
                let mut landed = boolean_union(&collision[layer][bi], &trapped_model);
                if roof_at(&roofs, layer) {
                    landed = boolean_diff(&landed, part);
                }
                model[layer][bi] = landed;
                clip_floor(&mut bed[layer][bi], floor, bands, layer);
                clip_floor(&mut model[layer][bi], floor, bands, layer);
            }
        }
        Self { buckets, bed, model }
    }

    /// True when a center of `radius` at `layer` cannot stand there and still
    /// leave. `to_bed` is a branch that has to reach the ground.
    pub(crate) fn blocks(&self, layer: usize, p: [f64; 2], radius: f64, to_bed: bool) -> bool {
        let layers = if to_bed { &self.bed } else { &self.model };
        let Some(at) = layers.get(layer) else {
            return false;
        };
        let loops = &at[bucket_of(&self.buckets, radius)];
        !loops.is_empty() && in_solid(loops, p[0], p[1])
    }
}

fn radius_buckets(tip: f64, trunk: f64) -> Vec<f64> {
    let trunk = trunk.max(tip);
    let mut out = vec![tip];
    let mut r = tip;
    while trunk - r > 0.45 {
        r = (r + 0.4).min(trunk);
        if out.last().is_some_and(|prev| (r - prev).abs() < 1e-6) {
            break;
        }
        out.push(r);
    }
    if out.last().is_some_and(|prev| trunk - prev > 1e-6) {
        out.push(trunk);
    }
    out
}

fn bucket_of(buckets: &[f64], radius: f64) -> usize {
    buckets
        .iter()
        .position(|b| *b + 1e-6 >= radius)
        .unwrap_or(buckets.len().saturating_sub(1))
}

fn shrink(loops: &[Loop], dist: f64) -> Vec<Loop> {
    if loops.is_empty() || dist <= 1e-6 {
        return loops.to_vec();
    }
    drop_slivers(offset_loops(loops, -dist), 0.02)
}

fn clip_floor(loops: &mut Vec<Loop>, floor: Option<FloorPlane>, bands: &[LayerBand], layer: usize) {
    let Some(floor) = floor else {
        return;
    };
    let Some(band) = bands.get(layer) else {
        return;
    };
    *loops = clip_half(loops, floor.y_max(band.z));
}

fn roof_at(roofs: &[bool], layer: usize) -> bool {
    roofs.get(layer).copied().unwrap_or(false)
}

/// A layer whose outline reaches past the one above, so a branch may stop on it.
fn roof_layers(contours: &[Vec<Loop>]) -> Vec<bool> {
    let bounds: Vec<Option<([f64; 2], [f64; 2])>> = contours.iter().map(|c| loop_bounds(c)).collect();
    (0..contours.len())
        .map(|i| {
            let Some((min, max)) = bounds[i] else {
                return false;
            };
            let Some((above_min, above_max)) = bounds.get(i + 1).copied().flatten() else {
                return true;
            };
            const EPS: f64 = 0.2;
            min[0] < above_min[0] - EPS
                || max[0] > above_max[0] + EPS
                || min[1] < above_min[1] - EPS
                || max[1] > above_max[1] + EPS
        })
        .collect()
}
