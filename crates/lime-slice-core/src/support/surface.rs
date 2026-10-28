//! Support demand read off the part's surface instead of from differences
//! between layers: ray trees R1 in `docs/plan-ray-trees.md`.
//!
//! A face needs support when its outward normal points down past the
//! support angle, measured against the axis trunks grow along: plumb, which
//! on a belt is normal to the belt. Tips are spread over those faces by
//! area, a Poisson disk at the tip pitch, and each face is projected onto
//! the bands it crosses as that layer's overhang.

use rayon::prelude::*;

use super::paint::{PaintDisk, PaintKind};
use super::FloorPlane;
use crate::adaptive::LayerBand;
use crate::mesh::Mesh;
use crate::poly::{drop_slivers, in_solid, resolve_nonzero, signed_area, Loop};

/// A face within this many degrees past the support angle still prints
/// without support: a roof at the angle gets one answer, not a sliver a layer.
const ANGLE_TOLERANCE_DEG: f64 = 2.0;
/// A face this close to the bed or the belt rests on it, mm.
const ON_FLOOR_MM: f64 = 0.3;
/// Enforce paint reaches a face that points down at least this much.
const PAINT_FACING: f64 = 0.05;
/// Candidates per tip pitch squared: dense enough that the disk is maximal.
const CANDIDATES_PER_PITCH2: f64 = 16.0;
/// Overhang pieces this small are boolean noise, mm².
const SPECK_MM2: f64 = 0.05;

/// What the surface asks of supports on every layer.
pub(crate) struct Surface {
    /// The faces that need support, projected onto each band they cross.
    pub regions: Vec<Vec<Loop>>,
    /// Tips on those faces, on the layer whose band holds them.
    pub tips: Vec<Vec<Tip>>,
}

/// One tip on the surface. `load` is the area it carries in fine-grid
/// cells, as a packed tip of the layer walk carries samples.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Tip {
    pub xy: [f64; 2],
    pub load: f64,
}

pub(crate) struct Spec {
    pub angle_deg: f64,
    pub floor: Option<FloorPlane>,
    /// The angle asks for support. Off, only enforce paint does.
    pub by_angle: bool,
    /// Poisson radius: the tip pitch.
    pub pitch: f64,
    /// The fine grid a tip's load is counted in.
    pub fine: f64,
    /// Most fine cells one tip carries.
    pub capacity: f64,
}

impl Spec {
    /// Unit vector trunks grow along, in the slice frame.
    fn down(&self) -> [f64; 3] {
        match self.floor {
            Some(floor) => {
                let t = floor.tan_a();
                let n = (1.0 + t * t).sqrt();
                [0.0, t / n, -1.0 / n]
            }
            None => [0.0, 0.0, -1.0],
        }
    }

    /// Distance from `p` to the bed or the belt, along its normal.
    fn above_floor(&self, p: [f64; 3]) -> f64 {
        match self.floor {
            Some(floor) => {
                let t = floor.tan_a();
                (p[2] - floor.z_at(p[1])) / (1.0 + t * t).sqrt()
            }
            None => p[2],
        }
    }
}

struct Face {
    tri: [[f64; 3]; 3],
    normal: [f64; 3],
    area: f64,
    /// Down past the angle, before paint.
    asked: bool,
}

#[derive(Clone, Copy)]
struct Candidate {
    p: [f64; 3],
    n: [f64; 3],
}

/// `own` is the part cut on `bands`: a face with part right under it, one
/// inside the solid where two bodies overlap, asks for nothing.
pub(crate) fn read(
    mesh: &Mesh,
    bands: &[LayerBand],
    own: &[Vec<Loop>],
    paint: &[PaintDisk],
    spec: &Spec,
) -> Surface {
    let n = bands.len();
    let mut surface = Surface {
        regions: vec![Vec::new(); n],
        tips: vec![Vec::new(); n],
    };
    if n == 0 || spec.pitch <= 0.0 {
        return surface;
    }
    let down = spec.down();
    // The support angle is a face's least slope from level that prints, as
    // `slope_of` reads it: a face nearer level than that, facing down, asks.
    let past = (spec.angle_deg.clamp(15.0, 75.0) - ANGLE_TOLERANCE_DEG)
        .to_radians()
        .cos();
    let asks = |n: [f64; 3]| dot(n, down) > past;
    let enforced = paint.iter().any(|d| d.kind == PaintKind::Enforce);
    let faces: Vec<Face> = mesh
        .triangles
        .par_iter()
        .filter_map(|tri| {
            let cross = cross(sub(tri[1], tri[0]), sub(tri[2], tri[0]));
            let len = dot(cross, cross).sqrt();
            if len <= 1e-12 {
                return None;
            }
            let normal = cross.map(|c| c / len);
            let facing = dot(normal, down);
            let asked = spec.by_angle && asks(normal);
            let painted = enforced && facing > PAINT_FACING && near_enforce(tri, paint);
            if !asked && !painted {
                return None;
            }
            if tri.iter().all(|&v| spec.above_floor(v) < ON_FLOOR_MM) {
                return None;
            }
            let centre = [0, 1, 2].map(|k| (tri[0][k] + tri[1][k] + tri[2][k]) / 3.0);
            if solid_under(centre, down, bands, own) {
                return None;
            }
            Some(Face {
                tri: *tri,
                normal,
                area: len * 0.5,
                asked,
            })
        })
        .collect();

    // Overhang regions: each face's piece within a band, flat onto it.
    // Paint keeps its own per-layer regions, as the walk's demand applies them.
    let mut pieces: Vec<(usize, Loop)> = faces
        .par_iter()
        .filter(|f| f.asked)
        .flat_map_iter(|f| band_pieces(&f.tri, bands))
        .collect();
    pieces.sort_by_key(|(i, _)| *i);
    let mut by_layer: Vec<Vec<Loop>> = vec![Vec::new(); n];
    for (i, piece) in pieces {
        by_layer[i].push(piece);
    }
    surface.regions = by_layer
        .into_par_iter()
        .map(|polys| {
            if polys.is_empty() {
                polys
            } else {
                drop_slivers(resolve_nonzero(polys), SPECK_MM2)
            }
        })
        .collect();

    // Tips: a dense, seeded scatter by area, thinned to a Poisson disk.
    let density = CANDIDATES_PER_PITCH2 / (spec.pitch * spec.pitch);
    let mut candidates: Vec<(u64, Candidate)> = faces
        .par_iter()
        .enumerate()
        .flat_map_iter(|(k, f)| scatter(k as u64, f, density))
        .filter(|(_, c)| {
            let facing = dot(c.n, down);
            let mut wanted = spec.by_angle && asks(c.n);
            for d in paint {
                if dist2(c.p, d.p) <= d.r * d.r {
                    wanted = d.kind == PaintKind::Enforce && facing > PAINT_FACING;
                }
            }
            wanted
                && band_of(bands, c.p[2]).is_some_and(|i| i > 0)
                && !solid_under(c.p, down, bands, own)
        })
        .collect();
    candidates.sort_by_key(|(key, _)| *key);
    let cell_area = 1.0 / density;
    for (tip, layer) in poisson(&candidates, spec.pitch, cell_area, spec, bands) {
        surface.tips[layer].push(tip);
    }
    surface
}

/// Thin `candidates`, in their shuffled order, to points at least `r` apart
/// on the same sheet, and give each the area of the candidates nearest it.
fn poisson(
    candidates: &[(u64, Candidate)],
    r: f64,
    cell_area: f64,
    spec: &Spec,
    bands: &[LayerBand],
) -> Vec<(Tip, usize)> {
    use std::collections::HashMap;
    let key = |p: [f64; 3]| p.map(|v| (v / r).floor() as i64);
    let mut grid: HashMap<[i64; 3], Vec<usize>> = HashMap::new();
    let mut kept: Vec<Candidate> = Vec::new();
    let mut weight: Vec<f64> = Vec::new();
    let nearest = |grid: &HashMap<[i64; 3], Vec<usize>>, kept: &[Candidate], c: &Candidate| {
        let k = key(c.p);
        let mut best: Option<(usize, f64)> = None;
        for dx in -1..=1 {
            for dy in -1..=1 {
                for dz in -1..=1 {
                    let Some(ids) = grid.get(&[k[0] + dx, k[1] + dy, k[2] + dz]) else {
                        continue;
                    };
                    for &id in ids {
                        let q = &kept[id];
                        let d2 = dist2(c.p, q.p);
                        if d2 < r * r && same_sheet(c, q) && best.is_none_or(|(_, b)| d2 < b) {
                            best = Some((id, d2));
                        }
                    }
                }
            }
        }
        best.map(|(id, _)| id)
    };
    let mut rejected = Vec::new();
    for (_, c) in candidates {
        match nearest(&grid, &kept, c) {
            Some(_) => rejected.push(*c),
            None => {
                grid.entry(key(c.p)).or_default().push(kept.len());
                kept.push(*c);
                weight.push(cell_area);
            }
        }
    }
    for c in &rejected {
        if let Some(id) = nearest(&grid, &kept, c) {
            weight[id] += cell_area;
        }
    }
    let cell = spec.fine * spec.fine;
    kept.iter()
        .zip(weight)
        .filter_map(|(c, w)| {
            let layer = band_of(bands, c.p[2])?;
            Some((
                Tip {
                    xy: [c.p[0], c.p[1]],
                    load: (w / cell).clamp(1.0, spec.capacity.max(1.0)),
                },
                layer,
            ))
        })
        .collect()
}

/// How far below a face the part is looked for, mm. More than a layer, so
/// the cut it is looked for in lies under the face.
const UNDER_MM: f64 = 0.45;

/// True when the part is right under `p`, along `down`.
fn solid_under(p: [f64; 3], down: [f64; 3], bands: &[LayerBand], own: &[Vec<Loop>]) -> bool {
    let q = [0, 1, 2].map(|k| p[k] + down[k] * UNDER_MM);
    band_of(bands, q[2])
        .and_then(|i| own.get(i))
        .is_some_and(|part| !part.is_empty() && in_solid(part, q[0], q[1]))
}

/// Two points lie on one sheet when each is near the other's tangent
/// plane: a roof over a roof is two sheets, however close.
fn same_sheet(a: &Candidate, b: &Candidate) -> bool {
    let d = sub(a.p, b.p);
    let len = dot(d, d).sqrt();
    let off = dot(d, b.n).abs().max(dot(d, a.n).abs());
    off <= 0.3 * len + 0.5
}

/// Seeded points on `f`, `density` per mm² on average, each keyed for a
/// shuffle that does not depend on the order faces were read in.
fn scatter(seed: u64, f: &Face, density: f64) -> Vec<(u64, Candidate)> {
    let mut rng = SplitMix(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ 0x5851_F42D_4C95_7F2D);
    let expected = f.area * density;
    let count = expected.floor() as usize + usize::from(rng.unit() < expected.fract());
    let [a, b, c] = f.tri;
    // A flat face's points stay in its band, not a rounding below it.
    let flat = a[2] == b[2] && b[2] == c[2];
    (0..count)
        .map(|_| {
            let (u, v) = (rng.unit(), rng.unit());
            let su = u.sqrt();
            let (wa, wb, wc) = (1.0 - su, su * (1.0 - v), su * v);
            let mut p = [0, 1, 2].map(|k| a[k] * wa + b[k] * wb + c[k] * wc);
            if flat {
                p[2] = a[2];
            }
            (rng.next(), Candidate { p, n: f.normal })
        })
        .collect()
}

/// The band whose slab `[z - height, z)` holds `z`.
fn band_of(bands: &[LayerBand], z: f64) -> Option<usize> {
    let i = bands.partition_point(|b| b.z <= z);
    bands
        .get(i)
        .filter(|b| b.z - b.height <= z + 1e-9)
        .map(|_| i)
}

/// `tri`'s piece within each band it crosses, flat onto the band. A flat
/// face lies in one band. The first band holds no overhang.
fn band_pieces(tri: &[[f64; 3]; 3], bands: &[LayerBand]) -> Vec<(usize, Loop)> {
    let lo = tri.iter().map(|v| v[2]).fold(f64::INFINITY, f64::min);
    let hi = tri.iter().map(|v| v[2]).fold(f64::NEG_INFINITY, f64::max);
    let flat = hi - lo < 1e-9;
    let (Some(first), Some(last)) = (
        band_of(bands, lo),
        band_of(bands, hi).or_else(|| (hi >= bands.last()?.z).then(|| bands.len() - 1)),
    ) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (i, b) in bands.iter().enumerate().take(last + 1).skip(first.max(1)) {
        let poly: Vec<[f64; 3]> = if flat {
            if i != first {
                continue;
            }
            tri.to_vec()
        } else {
            clip(&clip(tri, b.z - b.height, 1.0), b.z, -1.0)
        };
        if poly.len() < 3 {
            continue;
        }
        let mut flat_loop: Loop = poly.iter().map(|p| [p[0], p[1]]).collect();
        let area = signed_area(&flat_loop);
        if area.abs() < 1e-6 {
            continue;
        }
        if area < 0.0 {
            flat_loop.reverse();
        }
        out.push((i, flat_loop));
    }
    out
}

/// The part of `poly` where `side * (z - at) >= 0`.
fn clip(poly: &[[f64; 3]], at: f64, side: f64) -> Vec<[f64; 3]> {
    let inside = |p: &[f64; 3]| side * (p[2] - at) >= 0.0;
    let mut out = Vec::with_capacity(poly.len() + 2);
    for k in 0..poly.len() {
        let (a, b) = (poly[k], poly[(k + 1) % poly.len()]);
        if inside(&a) {
            out.push(a);
        }
        if inside(&a) != inside(&b) {
            let t = (at - a[2]) / (b[2] - a[2]);
            out.push([0, 1, 2].map(|j| a[j] + (b[j] - a[j]) * t));
        }
    }
    out
}

fn near_enforce(tri: &[[f64; 3]; 3], paint: &[PaintDisk]) -> bool {
    let min = [0, 1, 2].map(|k| tri.iter().map(|v| v[k]).fold(f64::INFINITY, f64::min));
    let max = [0, 1, 2].map(|k| tri.iter().map(|v| v[k]).fold(f64::NEG_INFINITY, f64::max));
    paint.iter().any(|d| {
        d.kind == PaintKind::Enforce
            && (0..3)
                .map(|k| (min[k] - d.p[k]).max(d.p[k] - max[k]).max(0.0).powi(2))
                .sum::<f64>()
                <= d.r * d.r
    })
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn dist2(a: [f64; 3], b: [f64; 3]) -> f64 {
    let d = sub(a, b);
    dot(d, d)
}

/// A small seeded generator, so the same mesh always gets the same tips.
struct SplitMix(u64);

impl SplitMix {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bands(n: usize, h: f64) -> Vec<LayerBand> {
        (0..n)
            .map(|i| LayerBand {
                index: i,
                z: (i + 1) as f64 * h,
                height: h,
            })
            .collect()
    }

    fn quad(z: f64, size: f64, down: bool) -> Vec<[[f64; 3]; 3]> {
        let (a, b, c, d) = (
            [0.0, 0.0, z],
            [size, 0.0, z],
            [size, size, z],
            [0.0, size, z],
        );
        if down {
            vec![[a, c, b], [a, d, c]]
        } else {
            vec![[a, b, c], [a, c, d]]
        }
    }

    fn spec() -> Spec {
        Spec {
            angle_deg: 45.0,
            floor: None,
            by_angle: true,
            pitch: 5.0,
            fine: 2.5,
            capacity: 6.0,
        }
    }

    #[test]
    fn a_ceiling_bears_tips_a_pitch_apart_and_a_floor_bears_none() {
        let mut triangles = quad(10.0, 40.0, true);
        triangles.extend(quad(20.0, 40.0, false));
        let mesh = Mesh { triangles };
        let bands = bands(120, 0.2);
        let surface = read(&mesh, &bands, &[], &[], &spec());
        let layer = band_of(&bands, 10.0).unwrap();
        let tips = &surface.tips[layer];
        assert!(
            tips.len() >= 40,
            "{} tips under a 40 mm square at a 5 mm pitch",
            tips.len()
        );
        assert!(surface
            .tips
            .iter()
            .enumerate()
            .all(|(i, t)| i == layer || t.is_empty()));
        for (k, a) in tips.iter().enumerate() {
            for b in &tips[k + 1..] {
                let d = (a.xy[0] - b.xy[0]).hypot(a.xy[1] - b.xy[1]);
                assert!(d >= 5.0 - 1e-9, "tips {d:.2} mm apart");
            }
        }
        let area: f64 = surface.regions[layer].iter().map(|l| signed_area(l)).sum();
        assert!((area - 1600.0).abs() < 1.0, "region {area:.1} mm²");
        let carried: f64 = tips.iter().map(|t| t.load * 2.5 * 2.5).sum();
        assert!(
            (carried - 1600.0).abs() < 400.0,
            "tips carry {carried:.0} mm²"
        );
    }

    #[test]
    fn the_same_mesh_bears_the_same_tips() {
        let mesh = Mesh {
            triangles: quad(10.0, 30.0, true),
        };
        let bands = bands(80, 0.2);
        let a = read(&mesh, &bands, &[], &[], &spec());
        let b = read(&mesh, &bands, &[], &[], &spec());
        let flat =
            |s: &Surface| -> Vec<[f64; 2]> { s.tips.iter().flatten().map(|t| t.xy).collect() };
        assert_eq!(flat(&a), flat(&b));
    }

    #[test]
    fn a_slope_inside_the_angle_asks_for_nothing() {
        // 30° from vertical, normal 60° from straight down.
        let (run, rise) = (10.0 * 30f64.to_radians().tan(), 10.0);
        let tri = [[0.0, 0.0, 5.0], [0.0, 20.0, 5.0], [run, 0.0, 5.0 + rise]];
        let mesh = Mesh {
            triangles: vec![tri],
        };
        let surface = read(&mesh, &bands(100, 0.2), &[], &[], &spec());
        assert!(surface.tips.iter().all(Vec::is_empty));
        assert!(surface.regions.iter().all(Vec::is_empty));
    }

    #[test]
    fn enforce_paint_asks_where_the_angle_does_not() {
        let mesh = Mesh {
            triangles: quad(10.0, 40.0, true),
        };
        let bands = bands(80, 0.2);
        let paint = [PaintDisk {
            kind: PaintKind::Enforce,
            p: [20.0, 20.0, 10.0],
            n: [0.0, 0.0, -1.0],
            r: 6.0,
        }];
        let spec = Spec {
            by_angle: false,
            ..spec()
        };
        let surface = read(&mesh, &bands, &[], &paint, &spec);
        let tips: Vec<&Tip> = surface.tips.iter().flatten().collect();
        assert!(!tips.is_empty());
        assert!(tips
            .iter()
            .all(|t| (t.xy[0] - 20.0).hypot(t.xy[1] - 20.0) <= 6.0));
        assert!(surface.regions.iter().all(Vec::is_empty));
    }
}
