//! Height ranges and modifier volumes: the parts of a layer that print with
//! their own infill, walls, or speed cap.
//!
//! The later volume wins over an earlier one. A range applies only outside
//! every volume, and the later range wins over an earlier one.

use crate::poly::Loop;
use crate::strategy::{InfillPattern, ResolvedStrategy};

/// Layer z values are sums of layer heights, so a layer at 2 mm can sit a
/// hair below 2. A range or volume end holds the layers within this of it.
const Z_SLACK: f64 = 1e-6;

/// What a range or a volume changes. `None` keeps the strategy's value.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Tweak {
    /// Sparse infill, 0 to 1.
    pub infill: Option<f64>,
    /// Wall count, 1 to 12.
    pub walls: Option<u32>,
    /// A cap on every feature speed, mm/s.
    pub speed: Option<f64>,
}

impl Tweak {
    pub fn is_set(&self) -> bool {
        self.infill.is_some() || self.walls.is_some() || self.speed.is_some()
    }

    /// `over` wins on each field it sets. `None` when neither sets a field,
    /// which is what a layer with no override plans today.
    pub fn under(self, over: Option<Tweak>) -> Option<Tweak> {
        let top = over.filter(|tweak| tweak.is_set());
        if !self.is_set() {
            return top;
        }
        let Some(top) = top else {
            return Some(self);
        };
        Some(Tweak {
            infill: top.infill.or(self.infill),
            walls: top.walls.or(self.walls),
            speed: top.speed.or(self.speed),
        })
    }

    pub fn apply(&self, mut s: ResolvedStrategy) -> ResolvedStrategy {
        if let Some(walls) = self.walls {
            s.walls = walls;
        }
        if let Some(density) = self.infill {
            s.infill_density = density;
            // A density the user asks for fills the whole region. Lightning
            // and the pruned lines only hold up roofs, so a dense volume deep
            // inside the part would print nothing.
            s.lightning_range_mm = 0.0;
            if s.pattern == InfillPattern::Lightning {
                s.pattern = InfillPattern::Grid;
            }
        }
        if let Some(cap) = self.speed {
            for speed in [
                &mut s.print_speed,
                &mut s.outer_speed,
                &mut s.inner_speed,
                &mut s.sparse_speed,
                &mut s.solid_speed,
                &mut s.top_speed,
                &mut s.gyroid_speed,
            ] {
                *speed = speed.min(cap);
            }
        }
        s
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shape {
    Box,
    /// Upright on Z, with elliptical radii of half the X and Y size.
    Cylinder,
    /// The ellipsoid of the three sizes.
    Sphere,
}

#[derive(Clone, Debug, PartialEq)]
pub struct HeightRange {
    /// Low then high, inclusive.
    pub z: [f64; 2],
    pub tweak: Tweak,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Volume {
    pub shape: Shape,
    pub center: [f64; 3],
    /// Full extent along each axis.
    pub size: [f64; 3],
    pub tweak: Tweak,
    /// Its place in the request, which the layer note names.
    pub index: usize,
}

/// Every range and volume of a slice, in request order.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Overrides {
    pub ranges: Vec<HeightRange>,
    pub volumes: Vec<Volume>,
}

impl Overrides {
    pub fn is_empty(&self) -> bool {
        self.ranges.is_empty() && self.volumes.is_empty()
    }

    /// These overrides for a part whose frame sits `offset` from the bed and
    /// whose part-frame bounds are `min..max`. Volume centres move by minus
    /// the offset, as a region plane does. Entries that cannot reach the
    /// part are left out, so they never enter its stage keys.
    pub fn for_part(&self, offset: [f64; 2], min: [f64; 3], max: [f64; 3]) -> Overrides {
        // Rounded to a micrometre: a volume moved with the part by the same
        // X/Y then lands on the same bits, and every stage key holds.
        let snap = |v: f64| (v * 1e6).round() / 1e6;
        Overrides {
            ranges: self
                .ranges
                .iter()
                .filter(|r| r.z[1] >= min[2] && r.z[0] <= max[2])
                .cloned()
                .collect(),
            volumes: self
                .volumes
                .iter()
                .map(|v| Volume {
                    center: [
                        snap(v.center[0] - offset[0]),
                        snap(v.center[1] - offset[1]),
                        v.center[2],
                    ],
                    ..v.clone()
                })
                .filter(|v| {
                    (0..3).all(|k| {
                        let h = v.size[k] * 0.5;
                        v.center[k] + h >= min[k] && v.center[k] - h <= max[k]
                    })
                })
                .collect(),
        }
    }

    /// The tweak of the last range whose span holds `z`.
    pub fn range_at(&self, z: f64) -> Option<Tweak> {
        self.ranges
            .iter()
            .rev()
            .find(|r| r.z[0] - Z_SLACK <= z && z <= r.z[1] + Z_SLACK)
            .map(|r| r.tweak)
    }

    /// Each volume's cross-section at `z`, in request order.
    pub fn footprints(&self, z: f64) -> Vec<Print> {
        self.volumes
            .iter()
            .filter_map(|v| {
                v.footprint(z).map(|outline| Print {
                    outline,
                    tweak: v.tweak,
                    volume: v.index,
                })
            })
            .collect()
    }
}

/// One volume on one layer.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Print {
    pub outline: Footprint,
    pub tweak: Tweak,
    /// The volume's place in the request.
    pub volume: usize,
}

impl Volume {
    fn footprint(&self, z: f64) -> Option<Footprint> {
        let c = [self.center[0], self.center[1]];
        let h = [self.size[0] * 0.5, self.size[1] * 0.5, self.size[2] * 0.5];
        let dz = z - self.center[2];
        if dz.abs() > h[2] + Z_SLACK {
            return None;
        }
        match self.shape {
            Shape::Box => Some(Footprint::Rect { c, h: [h[0], h[1]] }),
            Shape::Cylinder => Some(Footprint::Ellipse { c, r: [h[0], h[1]] }),
            Shape::Sphere => {
                let k = (1.0 - (dz / h[2]).powi(2)).sqrt();
                (k > 1e-9).then_some(Footprint::Ellipse {
                    c,
                    r: [h[0] * k, h[1] * k],
                })
            }
        }
    }
}

/// A volume's cross-section on one layer.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Footprint {
    Rect { c: [f64; 2], h: [f64; 2] },
    Ellipse { c: [f64; 2], r: [f64; 2] },
}

impl Footprint {
    pub fn contains(&self, p: [f64; 2]) -> bool {
        match *self {
            Footprint::Rect { c, h } => (p[0] - c[0]).abs() <= h[0] && (p[1] - c[1]).abs() <= h[1],
            Footprint::Ellipse { c, r } => {
                let (u, v) = ((p[0] - c[0]) / r[0], (p[1] - c[1]) / r[1]);
                u * u + v * v <= 1.0
            }
        }
    }

    pub fn bounds(&self) -> ([f64; 2], [f64; 2]) {
        let (c, h) = match *self {
            Footprint::Rect { c, h } => (c, h),
            Footprint::Ellipse { c, r } => (c, r),
        };
        ([c[0] - h[0], c[1] - h[1]], [c[0] + h[0], c[1] + h[1]])
    }

    /// Where the segment `a`→`b` crosses this outline, as fractions strictly
    /// between 0 and 1, pushed onto `out`.
    pub fn crossings(&self, a: [f64; 2], b: [f64; 2], out: &mut Vec<f64>) {
        let d = [b[0] - a[0], b[1] - a[1]];
        let mut push = |t: f64| {
            if t > 1e-12 && t < 1.0 - 1e-12 {
                out.push(t);
            }
        };
        match *self {
            Footprint::Rect { c, h } => {
                for k in 0..2 {
                    if d[k].abs() < 1e-15 {
                        continue;
                    }
                    for edge in [c[k] - h[k], c[k] + h[k]] {
                        let t = (edge - a[k]) / d[k];
                        let o = 1 - k;
                        let along = a[o] + d[o] * t;
                        if (along - c[o]).abs() <= h[o] {
                            push(t);
                        }
                    }
                }
            }
            Footprint::Ellipse { c, r } => {
                let (px, py) = ((a[0] - c[0]) / r[0], (a[1] - c[1]) / r[1]);
                let (dx, dy) = (d[0] / r[0], d[1] / r[1]);
                let qa = dx * dx + dy * dy;
                if qa < 1e-30 {
                    return;
                }
                let qb = 2.0 * (px * dx + py * dy);
                let qc = px * px + py * py - 1.0;
                let disc = qb * qb - 4.0 * qa * qc;
                if disc <= 0.0 {
                    return;
                }
                let s = disc.sqrt();
                push((-qb - s) / (2.0 * qa));
                push((-qb + s) / (2.0 * qa));
            }
        }
    }

    /// The outline as a counter-clockwise polygon.
    pub fn polygon(&self) -> Loop {
        match *self {
            Footprint::Rect { c, h } => vec![
                [c[0] - h[0], c[1] - h[1]],
                [c[0] + h[0], c[1] - h[1]],
                [c[0] + h[0], c[1] + h[1]],
                [c[0] - h[0], c[1] + h[1]],
            ],
            Footprint::Ellipse { c, r } => {
                let n = 96;
                (0..n)
                    .map(|i| {
                        let a = std::f64::consts::TAU * i as f64 / n as f64;
                        [c[0] + r[0] * a.cos(), c[1] + r[1] * a.sin()]
                    })
                    .collect()
            }
        }
    }
}

/// The index of the footprint that owns `p`: the last one holding it.
pub fn owner(prints: &[Print], p: [f64; 2]) -> Option<usize> {
    prints.iter().rposition(|f| f.outline.contains(p))
}

/// The runs of the polyline `pts` that `prints` give to `zone`, split where
/// it crosses a footprint outline.
pub fn zone_runs(pts: &[[f64; 2]], prints: &[Print], zone: Option<usize>) -> Vec<Vec<[f64; 2]>> {
    let mut runs = Vec::new();
    let mut run: Vec<[f64; 2]> = Vec::new();
    let mut ts = Vec::new();
    let at =
        |a: [f64; 2], b: [f64; 2], t: f64| [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    for w in pts.windows(2) {
        let (a, b) = (w[0], w[1]);
        ts.clear();
        ts.push(0.0);
        for f in prints {
            f.outline.crossings(a, b, &mut ts);
        }
        ts.push(1.0);
        ts.sort_by(f64::total_cmp);
        // The run's last point is a split inside this segment, so a kept
        // span after it moves that point instead of adding one on the line.
        let mut split = false;
        for span in ts.windows(2) {
            let (t0, t1) = (span[0], span[1]);
            if t1 - t0 < 1e-12 {
                continue;
            }
            if owner(prints, at(a, b, (t0 + t1) * 0.5)) == zone {
                if run.is_empty() {
                    run.push(at(a, b, t0));
                } else if split {
                    run.pop();
                }
                run.push(if t1 >= 1.0 { b } else { at(a, b, t1) });
                split = t1 < 1.0;
            } else {
                split = false;
                if !run.is_empty() {
                    runs.push(std::mem::take(&mut run));
                }
            }
        }
    }
    if !run.is_empty() {
        runs.push(run);
    }
    runs
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_segment_through_a_box_and_a_later_ellipse_splits_by_owner() {
        let print = |outline, volume| Print {
            outline,
            tweak: Tweak::default(),
            volume,
        };
        let prints = [
            print(
                Footprint::Rect {
                    c: [0.0, 0.0],
                    h: [2.0, 2.0],
                },
                0,
            ),
            print(
                Footprint::Ellipse {
                    c: [2.0, 0.0],
                    r: [1.0, 1.0],
                },
                1,
            ),
        ];
        let line = [[-4.0, 0.0], [4.0, 0.0]];
        assert_eq!(
            zone_runs(&line, &prints, None),
            vec![vec![[-4.0, 0.0], [-2.0, 0.0]], vec![[3.0, 0.0], [4.0, 0.0]]]
        );
        assert_eq!(
            zone_runs(&line, &prints, Some(0)),
            vec![vec![[-2.0, 0.0], [1.0, 0.0]]]
        );
        assert_eq!(
            zone_runs(&line, &prints, Some(1)),
            vec![vec![[1.0, 0.0], [3.0, 0.0]]]
        );
    }

    #[test]
    fn a_sphere_narrows_toward_its_poles() {
        let sphere = Volume {
            shape: Shape::Sphere,
            center: [0.0, 0.0, 10.0],
            size: [20.0, 10.0, 20.0],
            tweak: Tweak::default(),
            index: 0,
        };
        assert_eq!(
            sphere.footprint(10.0),
            Some(Footprint::Ellipse {
                c: [0.0, 0.0],
                r: [10.0, 5.0]
            })
        );
        let Some(Footprint::Ellipse { r, .. }) = sphere.footprint(16.0) else {
            panic!("a sphere slice is an ellipse");
        };
        assert!(
            (r[0] - 8.0).abs() < 1e-12 && (r[1] - 4.0).abs() < 1e-12,
            "{r:?}"
        );
        assert_eq!(sphere.footprint(20.5), None);
    }
}
