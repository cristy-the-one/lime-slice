//! Support demand read off the B-rep faces of a part that came from a solid,
//! in place of the differences between layers.
//!
//! Each face is judged as a whole when it is a plane, by its exact normal, so
//! a roof at the support angle gets one answer instead of a hairline strip a
//! layer. A curved face is judged per point, by the normal its triangles
//! share at each vertex, and cut where that normal crosses the angle, so a
//! fillet or a cylinder asks for one smooth band. The slope is measured in
//! the slice frame, against the layers, as `past_angle` measures it.

use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;

use rayon::prelude::*;

use super::FloorPlane;
use crate::adaptive::LayerBand;
use crate::mesh::Mesh;
use crate::poly::{drop_slivers, in_solid, resolve_nonzero, signed_area, Loop};

/// A face within this many degrees past the support angle still prints
/// without support, so a roof at the angle gets one answer.
const ANGLE_TOLERANCE_DEG: f64 = 0.5;
/// A face whose vertices all lie this near its mean plane is a plane, mm.
const PLANE_MM: f64 = 1e-3;
/// A face this close to the bed or the belt rests on it, mm.
const ON_FLOOR_MM: f64 = 0.3;
/// Enforce paint reaches a face that points down at least this much, as
/// the layers' underside does.
const PAINT_FACING: f64 = 0.05;
/// Demand pieces this small are boolean noise, mm².
const SPECK_MM2: f64 = 0.05;
/// How far below a face the part is looked for, mm: a face with the part
/// right under it lies inside where two bodies overlap.
const UNDER_MM: f64 = 0.45;

/// The B-rep face of each triangle of a part's mesh, in the mesh's order.
#[derive(Clone)]
pub struct SolidFaces {
    ids: Arc<[u32]>,
    digest: u64,
}

impl SolidFaces {
    pub(crate) fn new(ids: Vec<u32>) -> Self {
        let digest = ids.iter().fold(0xcbf2_9ce4_8422_2325_u64, |h, &id| {
            (h ^ u64::from(id)).wrapping_mul(0x0100_0000_01b3)
        });
        Self {
            ids: ids.into(),
            digest,
        }
    }

    pub(crate) fn ids(&self) -> &[u32] {
        &self.ids
    }
}

impl fmt::Debug for SolidFaces {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "SolidFaces({}, {:016x})", self.ids.len(), self.digest)
    }
}

/// A part's mesh in the slice frame, and the face of each of its triangles.
#[derive(Clone, Copy)]
pub(crate) struct Faced<'a> {
    pub mesh: &'a Mesh,
    pub faces: &'a [u32],
}

impl<'a> Faced<'a> {
    /// `None` unless every triangle has its face.
    pub(crate) fn new(mesh: &'a Mesh, faces: &'a SolidFaces) -> Option<Self> {
        (faces.ids().len() == mesh.triangles.len() && !faces.ids().is_empty()).then_some(Self {
            mesh,
            faces: faces.ids(),
        })
    }
}

pub(crate) struct Spec {
    pub angle_deg: f64,
    pub floor: Option<FloorPlane>,
    /// Also find every face that points down, for enforce paint.
    pub down: bool,
}

/// What the faces ask for on each layer.
pub(crate) struct SolidDemand {
    /// The faces past the support angle.
    pub past: Vec<Vec<Loop>>,
    /// Every face that points down. Empty unless the spec asked.
    pub down: Vec<Vec<Loop>>,
}

/// A face's piece over one layer, flat. `past` is true for a piece past the
/// angle, false for one that only points down.
type Piece = (usize, bool, Loop);

/// `own` is the part cut on `bands`.
pub(crate) fn read(
    faced: Faced<'_>,
    bands: &[LayerBand],
    own: &[Vec<Loop>],
    spec: &Spec,
) -> SolidDemand {
    let n = bands.len();
    let mut demand = SolidDemand {
        past: vec![Vec::new(); n],
        down: vec![Vec::new(); n],
    };
    if n < 2 {
        return demand;
    }
    let cuts: Vec<f64> = bands.iter().map(LayerBand::cut_z).collect();
    let past = (spec.angle_deg.clamp(15.0, 75.0) - ANGLE_TOLERANCE_DEG)
        .to_radians()
        .cos();
    let mut by_face: HashMap<u32, Vec<usize>> = HashMap::new();
    for (k, &face) in faced.faces.iter().enumerate() {
        by_face.entry(face).or_default().push(k);
    }
    let mut groups: Vec<(u32, Vec<usize>)> = by_face.into_iter().collect();
    groups.sort_unstable_by_key(|(face, _)| *face);
    let ask = Ask {
        past,
        floor: spec.floor,
        down: spec.down,
        cuts: &cuts,
        own,
    };
    let mut pieces: Vec<Piece> = groups
        .par_iter()
        .flat_map_iter(|(_, tris)| face_pieces(faced.mesh, tris, &ask))
        .collect();
    pieces.sort_by_key(|(i, _, _)| *i);
    for (i, is_past, piece) in pieces {
        if is_past {
            demand.past[i].push(piece);
        } else {
            demand.down[i].push(piece);
        }
    }
    let settle = |layers: Vec<Vec<Loop>>| -> Vec<Vec<Loop>> {
        layers
            .into_par_iter()
            .map(|polys| {
                if polys.is_empty() {
                    polys
                } else {
                    drop_slivers(resolve_nonzero(polys), SPECK_MM2)
                }
            })
            .collect()
    };
    demand.past = settle(demand.past);
    demand.down = settle(demand.down);
    demand
}

struct Ask<'a> {
    /// A face asks when its normal's downward part is over this.
    past: f64,
    floor: Option<FloorPlane>,
    down: bool,
    cuts: &'a [f64],
    own: &'a [Vec<Loop>],
}

impl Ask<'_> {
    fn above_floor(&self, p: [f64; 3]) -> f64 {
        match self.floor {
            Some(floor) => {
                let t = floor.tan_a();
                (p[2] - floor.z_at(p[1])) / (1.0 + t * t).sqrt()
            }
            None => p[2],
        }
    }

    /// The layer whose cut first meets height `z`.
    fn layer_of(&self, z: f64) -> Option<usize> {
        let i = self.cuts.partition_point(|&c| c <= z);
        (i < self.cuts.len()).then_some(i)
    }

    /// True when the part is right under `p`.
    fn solid_under(&self, p: [f64; 3]) -> bool {
        let z = p[2] - UNDER_MM;
        self.layer_of(z)
            .filter(|&i| i > 0)
            .map(|i| i - 1)
            .and_then(|i| self.own.get(i))
            .is_some_and(|part| !part.is_empty() && in_solid(part, p[0], p[1]))
    }

    /// `poly`, a flat piece of one face, cut on the layers it crosses. A
    /// piece resting on the floor, or with the part under it, asks for nothing.
    fn layer_pieces(&self, poly: &[[f64; 3]], is_past: bool, out: &mut Vec<Piece>) {
        if poly.len() < 3 || poly.iter().all(|&v| self.above_floor(v) < ON_FLOOR_MM) {
            return;
        }
        let k = poly.len() as f64;
        let centre = [0, 1, 2].map(|a| poly.iter().map(|v| v[a]).sum::<f64>() / k);
        if self.solid_under(centre) {
            return;
        }
        let lo = poly.iter().map(|v| v[2]).fold(f64::INFINITY, f64::min);
        let hi = poly.iter().map(|v| v[2]).fold(f64::NEG_INFINITY, f64::max);
        let (Some(first), last) = (
            self.layer_of(lo),
            self.layer_of(hi).unwrap_or(self.cuts.len() - 1),
        ) else {
            return;
        };
        for i in first.max(1)..=last {
            let (below, above) = (self.cuts[i - 1], self.cuts[i]);
            let cut = if lo >= below && hi < above {
                poly.to_vec()
            } else {
                clip(&clip(poly, |p| p[2] - below), |p| above - p[2])
            };
            if cut.len() < 3 {
                continue;
            }
            let mut flat: Loop = cut.iter().map(|p| [p[0], p[1]]).collect();
            let area = signed_area(&flat);
            if area.abs() < 1e-6 {
                continue;
            }
            if area < 0.0 {
                flat.reverse();
            }
            out.push((i, is_past, flat));
        }
    }
}

/// The pieces of one face, by the layers they lie over.
fn face_pieces(mesh: &Mesh, tris: &[usize], ask: &Ask<'_>) -> Vec<Piece> {
    let mut out = Vec::new();
    let mut sum = [0.0; 3];
    let crosses: Vec<[f64; 3]> = tris
        .iter()
        .map(|&k| {
            let t = &mesh.triangles[k];
            let c = cross(sub(t[1], t[0]), sub(t[2], t[0]));
            for (s, v) in sum.iter_mut().zip(c) {
                *s += v;
            }
            c
        })
        .collect();
    let len = dot(sum, sum).sqrt();
    if len > 1e-12 {
        let normal = sum.map(|c| c / len);
        let origin = mesh.triangles[tris[0]][0];
        let plane = tris
            .iter()
            .flat_map(|&k| mesh.triangles[k].iter())
            .all(|&v| dot(sub(v, origin), normal).abs() <= PLANE_MM);
        if plane {
            let facing = -normal[2];
            for (is_past, over) in [(true, ask.past), (false, PAINT_FACING)] {
                if facing > over && (is_past || ask.down) {
                    for &k in tris {
                        ask.layer_pieces(&mesh.triangles[k], is_past, &mut out);
                    }
                }
            }
            return out;
        }
    }

    // A curved face: the normal at each vertex is its triangles' mean, each
    // weighed by its angle there so the way the face was cut does not lean
    // it, and a triangle is cut where that normal crosses the angle.
    let key = |v: [f64; 3]| v.map(f64::to_bits);
    let mut at: HashMap<[u64; 3], [f64; 3]> = HashMap::with_capacity(tris.len() * 2);
    for (&k, c) in tris.iter().zip(&crosses) {
        let len = dot(*c, *c).sqrt();
        if len <= 1e-12 {
            continue;
        }
        let t = &mesh.triangles[k];
        for corner in 0..3 {
            let v = t[corner];
            let (e1, e2) = (sub(t[(corner + 1) % 3], v), sub(t[(corner + 2) % 3], v));
            let weight = dot(cross(e1, e2), cross(e1, e2)).sqrt().atan2(dot(e1, e2)) / len;
            let n = at.entry(key(v)).or_insert([0.0; 3]);
            for (s, v) in n.iter_mut().zip(c) {
                *s += v * weight;
            }
        }
    }
    let facing = |v: [f64; 3]| {
        let n = at[&key(v)];
        let len = dot(n, n).sqrt();
        if len > 1e-12 {
            -n[2] / len
        } else {
            0.0
        }
    };
    for &k in tris {
        let tri = &mesh.triangles[k];
        let f = tri.map(facing);
        let shade: Vec<([f64; 3], f64)> = tri.iter().copied().zip(f).collect();
        for (is_past, over) in [(true, ask.past), (false, PAINT_FACING)] {
            if (is_past || ask.down) && f.iter().any(|&g| g > over) {
                ask.layer_pieces(&clip_shaded(&shade, over), is_past, &mut out);
            }
        }
    }
    out
}

/// The part of `poly` where `value` is not negative.
fn clip(poly: &[[f64; 3]], value: impl Fn(&[f64; 3]) -> f64) -> Vec<[f64; 3]> {
    let mut out = Vec::with_capacity(poly.len() + 2);
    for k in 0..poly.len() {
        let (a, b) = (poly[k], poly[(k + 1) % poly.len()]);
        let (va, vb) = (value(&a), value(&b));
        if va >= 0.0 {
            out.push(a);
        }
        if (va >= 0.0) != (vb >= 0.0) {
            let t = va / (va - vb);
            out.push([0, 1, 2].map(|j| a[j] + (b[j] - a[j]) * t));
        }
    }
    out
}

/// The part of a shaded polygon whose shade, linear across it, is over `at`.
fn clip_shaded(poly: &[([f64; 3], f64)], at: f64) -> Vec<[f64; 3]> {
    let mut out = Vec::with_capacity(poly.len() + 2);
    for k in 0..poly.len() {
        let ((a, fa), (b, fb)) = (poly[k], poly[(k + 1) % poly.len()]);
        let (va, vb) = (fa - at, fb - at);
        if va > 0.0 {
            out.push(a);
        }
        if (va > 0.0) != (vb > 0.0) && va != vb {
            let t = va / (va - vb);
            out.push([0, 1, 2].map(|j| a[j] + (b[j] - a[j]) * t));
        }
    }
    out
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

#[cfg(test)]
mod tests {
    use super::*;

    fn bands(top: f64) -> Vec<LayerBand> {
        let n = (top / 0.2).round() as usize;
        (0..n)
            .map(|index| LayerBand {
                index,
                z: 0.2 * (index + 1) as f64,
                height: 0.2,
            })
            .collect()
    }

    fn read_mesh(triangles: Vec<[[f64; 3]; 3]>, faces: Vec<u32>) -> SolidDemand {
        let mesh = Mesh { triangles };
        let faces = SolidFaces::new(faces);
        let bands = bands(40.0);
        let own = vec![Vec::new(); bands.len()];
        let spec = Spec {
            angle_deg: 45.0,
            floor: None,
            down: true,
        };
        read(Faced::new(&mesh, &faces).unwrap(), &bands, &own, &spec)
    }

    fn area(layers: &[Vec<Loop>]) -> f64 {
        layers.iter().flatten().map(|l| signed_area(l)).sum()
    }

    /// A strip 40 mm along X and `run` mm up its slope, `deg` from level,
    /// facing down, cut into `slivers` long thin triangles a side, each
    /// corner off the plane by up to `jitter`.
    fn roof(deg: f64, run: f64, slivers: usize, jitter: f64) -> Vec<[[f64; 3]; 3]> {
        let (s, c) = deg.to_radians().sin_cos();
        let at = |x: f64, t: f64, k: usize| {
            let wobble = jitter * if k % 2 == 0 { 1.0 } else { -1.0 };
            [x, t * c + wobble * s, 5.0 + t * s - wobble * c]
        };
        let mut out = Vec::new();
        for k in 0..slivers {
            let t0 = run * k as f64 / slivers as f64;
            let t1 = run * (k + 1) as f64 / slivers as f64;
            let (a0, a1) = (at(0.0, t0, k), at(40.0, t0, k));
            let (b0, b1) = (at(0.0, t1, k + 1), at(40.0, t1, k + 1));
            out.push([a0, b0, a1]);
            out.push([b0, b1, a1]);
        }
        out
    }

    #[test]
    fn a_roof_past_the_angle_asks_for_its_whole_footprint() {
        let tris = roof(30.0, 10.0, 1, 0.0);
        let faces = vec![3; tris.len()];
        let demand = read_mesh(tris, faces);
        let footprint = 40.0 * 10.0 * 30f64.to_radians().cos();
        assert!((area(&demand.past) - footprint).abs() < footprint * 0.02);
    }

    #[test]
    fn a_roof_at_the_angle_asks_for_nothing_however_it_is_cut() {
        for (slivers, jitter) in [(1, 0.0), (40, 2e-5)] {
            let tris = roof(45.0, 10.0, slivers, jitter);
            let faces = vec![0; tris.len()];
            let demand = read_mesh(tris, faces);
            assert!(demand.past.iter().all(Vec::is_empty), "{slivers} slivers");
            assert!(area(&demand.down) > 0.0, "it still points down for paint");
        }
    }

    /// The lower half of a cylinder along X, radius 10, axis at Z 20, in
    /// `segments` flat strips: one curved face.
    fn trough(segments: usize) -> Vec<[[f64; 3]; 3]> {
        let point = |x: f64, k: usize| {
            let phi = std::f64::consts::PI * (1.0 + k as f64 / segments as f64);
            [x, 10.0 * phi.cos(), 20.0 + 10.0 * phi.sin()]
        };
        let mut out = Vec::new();
        for k in 0..segments {
            let (a0, a1) = (point(0.0, k), point(40.0, k));
            let (b0, b1) = (point(0.0, k + 1), point(40.0, k + 1));
            out.push([a0, b0, a1]);
            out.push([b0, b1, a1]);
        }
        out
    }

    #[test]
    fn a_curved_underside_asks_for_one_band_cut_where_it_crosses_the_angle() {
        let edge = 10.0 * (45.0 - ANGLE_TOLERANCE_DEG).to_radians().sin();
        for segments in [12, 24, 96] {
            let tris = trough(segments);
            let faces = vec![7; tris.len()];
            let demand = read_mesh(tris, faces);
            let ys = demand.past.iter().flatten().flatten().map(|p| p[1]);
            let (lo, hi) = ys.fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), y| {
                (lo.min(y), hi.max(y))
            });
            assert!((hi - edge).abs() < 0.15, "{segments}: {hi} against {edge}");
            assert!(
                (lo + edge).abs() < 0.15,
                "{segments}: {lo} against {}",
                -edge
            );
        }
    }

    #[test]
    fn faces_on_the_bed_or_over_the_part_ask_for_nothing() {
        let floor = vec![
            [[0.0, 0.0, 0.0], [0.0, 10.0, 0.0], [10.0, 0.0, 0.0]],
            [[0.0, 10.0, 0.0], [10.0, 10.0, 0.0], [10.0, 0.0, 0.0]],
        ];
        let demand = read_mesh(floor, vec![1, 1]);
        assert!(demand.past.iter().all(Vec::is_empty));

        let mesh = Mesh {
            triangles: vec![
                [[0.0, 0.0, 5.0], [0.0, 10.0, 5.0], [10.0, 0.0, 5.0]],
                [[0.0, 10.0, 5.0], [10.0, 10.0, 5.0], [10.0, 0.0, 5.0]],
            ],
        };
        let faces = SolidFaces::new(vec![2, 2]);
        let bands = bands(10.0);
        let block = vec![vec![[-1.0, -1.0], [11.0, -1.0], [11.0, 11.0], [-1.0, 11.0]]];
        let own: Vec<Vec<Loop>> = bands.iter().map(|_| block.clone()).collect();
        let spec = Spec {
            angle_deg: 45.0,
            floor: None,
            down: false,
        };
        let demand = read(Faced::new(&mesh, &faces).unwrap(), &bands, &own, &spec);
        assert!(demand.past.iter().all(Vec::is_empty));
    }

    #[test]
    fn faces_must_cover_every_triangle() {
        let mesh = Mesh {
            triangles: roof(30.0, 10.0, 1, 0.0),
        };
        assert!(Faced::new(&mesh, &SolidFaces::new(vec![0])).is_none());
        assert_ne!(
            format!("{:?}", SolidFaces::new(vec![1, 2])),
            format!("{:?}", SolidFaces::new(vec![2, 1]))
        );
    }
}
