//! Support paint: disks the user painted on the part. An enforce disk adds
//! support demand the overhang angle would skip, and a block disk removes
//! demand the angle would keep. Disks apply in paint order, so the later
//! one wins where two overlap.
//!
//! A disk reaches the surfaces inside its ball: on a layer it covers the
//! circle where the ball meets that layer's band. Its normal only says
//! which side the brush hit from, for the reply's hit count.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};

use rayon::prelude::*;
use serde::Serialize;

use crate::adaptive::LayerBand;
use crate::mesh::Mesh;
use crate::poly::{
    boolean_diff, boolean_intersect, boolean_union, drop_slivers, resolve_nonzero, Loop,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PaintKind {
    Enforce,
    Block,
}

/// One dab of the brush, in the frame of the part it was painted on.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PaintDisk {
    pub kind: PaintKind,
    /// The point the brush hit, mm.
    pub p: [f64; 3],
    /// The surface's outward unit normal there.
    pub n: [f64; 3],
    /// Brush radius, mm.
    pub r: f64,
}

/// Demand pieces this small are boolean noise along a painted edge.
const PAINT_SLIVER_MM2: f64 = 0.05;
/// A disk hits the part when the surface crosses its normal within this
/// distance of its point, mm. Covers a mesh tessellated again from STEP.
const HIT_REACH_MM: f64 = 0.5;
/// Largest gap between a disk's circle and its polygon, mm.
const CIRCLE_TOLERANCE_MM: f64 = 0.02;

impl PaintDisk {
    /// This disk where `rotation` (row-major) about `pivot`, then
    /// `translation`, places it: the same move the part's mesh takes.
    pub(crate) fn posed(
        &self,
        rotation: &[f64; 9],
        pivot: [f64; 3],
        translation: [f64; 3],
    ) -> Self {
        let turn = |v: [f64; 3]| {
            let r = rotation;
            [
                r[0] * v[0] + r[1] * v[1] + r[2] * v[2],
                r[3] * v[0] + r[4] * v[1] + r[5] * v[2],
                r[6] * v[0] + r[7] * v[1] + r[8] * v[2],
            ]
        };
        let q = turn([
            self.p[0] - pivot[0],
            self.p[1] - pivot[1],
            self.p[2] - pivot[2],
        ]);
        Self {
            p: [
                q[0] + translation[0],
                q[1] + translation[1],
                q[2] + translation[2],
            ],
            n: turn(self.n),
            ..*self
        }
    }

    /// Radius of the circle where the ball meets the band from `lo` to `hi`.
    fn reach_on(&self, lo: f64, hi: f64) -> Option<f64> {
        let dz = (lo - self.p[2]).max(self.p[2] - hi).max(0.0);
        (dz < self.r).then(|| (self.r * self.r - dz * dz).sqrt())
    }

    fn circle(&self, radius: f64) -> Loop {
        let step = (1.0 - CIRCLE_TOLERANCE_MM / radius).clamp(-1.0, 1.0).acos();
        let sides = ((std::f64::consts::TAU / step.max(1e-3)).ceil() as usize).clamp(12, 96);
        (0..sides)
            .map(|k| {
                let a = std::f64::consts::TAU * k as f64 / sides as f64;
                [self.p[0] + radius * a.cos(), self.p[1] + radius * a.sin()]
            })
            .collect()
    }
}

/// `overhang`, the demand the angle found on layer `i`, with every disk
/// that reaches the layer applied in order. `own` is the part's contours.
pub(crate) fn paint_layer(
    disks: &[PaintDisk],
    bands: &[LayerBand],
    own: &[Vec<Loop>],
    i: usize,
    overhang: Vec<Loop>,
) -> Vec<Loop> {
    let (lo, hi) = (bands[i].z - bands[i].height, bands[i].z);
    let mut demand = overhang;
    let mut facing_down: Option<Vec<Loop>> = None;
    let mut touched = false;
    for run in disks.chunk_by(|a, b| a.kind == b.kind) {
        let circles: Vec<Loop> = run
            .iter()
            .filter_map(|d| d.reach_on(lo, hi).map(|r| d.circle(r)))
            .collect();
        if circles.is_empty() {
            continue;
        }
        touched = true;
        let brush = resolve_nonzero(circles);
        demand = match run[0].kind {
            PaintKind::Block => boolean_diff(&demand, &brush),
            PaintKind::Enforce => {
                let under = facing_down.get_or_insert_with(|| underside(own, i));
                boolean_union(&demand, &boolean_intersect(under, &brush))
            }
        };
    }
    if touched {
        drop_slivers(demand, PAINT_SLIVER_MM2)
    } else {
        demand
    }
}

/// Every part of layer `i` with nothing of the part under it, at any angle.
fn underside(own: &[Vec<Loop>], i: usize) -> Vec<Loop> {
    let upper = own.get(i).map(Vec::as_slice).unwrap_or(&[]);
    if i == 0 || upper.is_empty() {
        return Vec::new();
    }
    let lower = own.get(i - 1).map(Vec::as_slice).unwrap_or(&[]);
    drop_slivers(boolean_diff(upper, lower), PAINT_SLIVER_MM2)
}

/// What the reply says about an object's paint.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaintTally {
    /// Enforce disks whose ball reaches a layer.
    pub enforce: u32,
    /// Block disks whose ball reaches a layer.
    pub block: u32,
    /// Enforce disks whose point and normal miss the part's surface.
    pub enforce_unhit: u32,
    pub block_unhit: u32,
    /// Supports are off, so the paint is kept but nothing prints.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub supports_off: bool,
}

/// Count `disks` against the part's `mesh` and its `bands`, all in one frame.
pub(crate) fn tally(
    disks: &[PaintDisk],
    mesh: &Mesh,
    bands: &[LayerBand],
    supports: bool,
) -> PaintTally {
    let hit = hits(disks, mesh);
    let mut tally = PaintTally {
        supports_off: !supports,
        ..PaintTally::default()
    };
    for (d, &hit) in disks.iter().zip(&hit) {
        let reaches = bands
            .iter()
            .any(|b| d.reach_on(b.z - b.height, b.z).is_some());
        let (projected, unhit) = match d.kind {
            PaintKind::Enforce => (&mut tally.enforce, &mut tally.enforce_unhit),
            PaintKind::Block => (&mut tally.block, &mut tally.block_unhit),
        };
        *projected += u32::from(reaches);
        *unhit += u32::from(!hit);
    }
    tally
}

/// Edge of the XY cells that file each disk's probe for the triangle pass, mm.
const PROBE_CELL_MM: f64 = 4.0;

/// Whether each disk's probe, from `HIT_REACH_MM` out along its normal to
/// as far in, crosses a triangle of `mesh`. One pass over the triangles.
fn hits(disks: &[PaintDisk], mesh: &Mesh) -> Vec<bool> {
    let cell = |v: f64| (v / PROBE_CELL_MM).floor() as i64;
    let probe = |d: &PaintDisk| {
        let a: [f64; 3] = std::array::from_fn(|k| d.p[k] + d.n[k] * HIT_REACH_MM);
        let b: [f64; 3] = std::array::from_fn(|k| d.p[k] - d.n[k] * HIT_REACH_MM);
        (a, b)
    };
    let mut grid: HashMap<(i64, i64), Vec<u32>> = HashMap::new();
    for (k, d) in disks.iter().enumerate() {
        let (a, b) = probe(d);
        for x in cell(a[0].min(b[0]))..=cell(a[0].max(b[0])) {
            for y in cell(a[1].min(b[1]))..=cell(a[1].max(b[1])) {
                grid.entry((x, y)).or_default().push(k as u32);
            }
        }
    }
    let hit: Vec<AtomicBool> = disks.iter().map(|_| AtomicBool::new(false)).collect();
    mesh.triangles.par_iter().for_each(|t| {
        let lo = |k: usize| t[0][k].min(t[1][k]).min(t[2][k]);
        let hi = |k: usize| t[0][k].max(t[1][k]).max(t[2][k]);
        for x in cell(lo(0))..=cell(hi(0)) {
            for y in cell(lo(1))..=cell(hi(1)) {
                for &k in grid.get(&(x, y)).into_iter().flatten() {
                    let k = k as usize;
                    if hit[k].load(Ordering::Relaxed) {
                        continue;
                    }
                    let (a, b) = probe(&disks[k]);
                    if crosses(a, b, t) {
                        hit[k].store(true, Ordering::Relaxed);
                    }
                }
            }
        }
    });
    hit.into_iter().map(AtomicBool::into_inner).collect()
}

/// True when the segment from `a` to `b` meets triangle `t`, edges included.
fn crosses(a: [f64; 3], b: [f64; 3], t: &[[f64; 3]; 3]) -> bool {
    let sub = |p: [f64; 3], q: [f64; 3]| [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
    let cross = |p: [f64; 3], q: [f64; 3]| {
        [
            p[1] * q[2] - p[2] * q[1],
            p[2] * q[0] - p[0] * q[2],
            p[0] * q[1] - p[1] * q[0],
        ]
    };
    let dot = |p: [f64; 3], q: [f64; 3]| p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
    let dir = sub(b, a);
    let (e1, e2) = (sub(t[1], t[0]), sub(t[2], t[0]));
    let h = cross(dir, e2);
    let det = dot(e1, h);
    if det.abs() < 1e-12 {
        return false;
    }
    let s = sub(a, t[0]);
    let u = dot(s, h) / det;
    let q = cross(s, e1);
    let v = dot(dir, q) / det;
    let along = dot(e2, q) / det;
    let eps = 1e-9;
    u >= -eps && v >= -eps && u + v <= 1.0 + eps && (-eps..=1.0 + eps).contains(&along)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn band(z: f64) -> LayerBand {
        LayerBand {
            index: 0,
            z,
            height: 0.2,
        }
    }

    fn square(x0: f64, y0: f64, x1: f64, y1: f64) -> Loop {
        vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    }

    fn area(loops: &[Loop]) -> f64 {
        loops.iter().map(|l| crate::poly::signed_area(l)).sum()
    }

    #[test]
    fn a_pose_moves_the_point_and_turns_the_normal() {
        let d = PaintDisk {
            kind: PaintKind::Block,
            p: [2.0, 1.0, 3.0],
            n: [1.0, 0.0, 0.0],
            r: 1.0,
        };
        let quarter = [0.0, -1.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0];
        let moved = d.posed(&quarter, [1.0, 1.0, 0.0], [10.0, 20.0, 5.0]);
        assert_eq!(moved.p, [10.0, 21.0, 8.0]);
        assert_eq!(moved.n, [0.0, 1.0, 0.0]);
        assert_eq!(moved.r, 1.0);
    }

    #[test]
    fn enforce_then_block_keeps_nothing_and_block_then_enforce_keeps_the_underside() {
        let bands = [band(0.2), band(0.4)];
        let own = vec![
            vec![square(0.0, 0.0, 10.0, 10.0)],
            vec![square(0.0, 0.0, 14.0, 10.0)],
        ];
        let at = |kind| PaintDisk {
            kind,
            p: [12.0, 5.0, 0.2],
            n: [0.0, 0.0, -1.0],
            r: 30.0,
        };
        let (enforce, block) = (at(PaintKind::Enforce), at(PaintKind::Block));
        let kept = paint_layer(&[block, enforce], &bands, &own, 1, Vec::new());
        assert!((area(&kept) - 40.0).abs() < 1e-6, "{}", area(&kept));
        let gone = paint_layer(&[enforce, block], &bands, &own, 1, Vec::new());
        assert_eq!(gone, Vec::<Loop>::new());
        let untouched = vec![square(10.0, 0.0, 14.0, 10.0)];
        let far = PaintDisk {
            p: [12.0, 5.0, 40.0],
            ..block
        };
        assert_eq!(
            paint_layer(&[far], &bands, &own, 1, untouched.clone()),
            untouched
        );
    }

    #[test]
    fn a_probe_through_a_face_hits_and_one_beside_it_misses() {
        let mesh = Mesh {
            triangles: vec![[[0.0, 0.0, 1.0], [4.0, 0.0, 1.0], [0.0, 4.0, 1.0]]],
        };
        let disk = |p: [f64; 3]| PaintDisk {
            kind: PaintKind::Enforce,
            p,
            n: [0.0, 0.0, -1.0],
            r: 1.0,
        };
        let got = hits(
            &[
                disk([1.0, 1.0, 1.2]),
                disk([3.5, 3.5, 1.0]),
                disk([1.0, 1.0, 2.0]),
            ],
            &mesh,
        );
        assert_eq!(got, [true, false, false]);
    }
}
