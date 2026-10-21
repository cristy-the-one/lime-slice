//! Walls and skins as a band inside the part's real surface.
//!
//! Every boundary face of the volume mesh is a triangle with an outward
//! normal. Its band is `skin` thick when that normal is within 45° of the
//! build axis (a roof or a floor) and `wall` thick otherwise (a side). A point
//! is in a wall when it lies within the band of any face, so a hole's wall, a
//! curved side, and a part turned on the bed are found the same way as a
//! box's sides.
//!
//! An element's wall share is the share of its volume in a band. It is
//! sampled at the centroids of 64 equal sub-tetrahedra, and of 512 where those
//! 64 disagree, so a wall thinner than an element still counts. Elements far
//! from the surface are skipped by a bucket grid, and cost one lookup.
//!
//! The corners of each element and face are used. A quadratic element's
//! curved mid-edge nodes do not move the band, which is a fraction of a wall
//! thickness on any mesh fine enough to resolve the curve.

use crate::mesh::{boundary_faces, Mesh};
use crate::units::{dot, sub};

/// Roofs and floors are the faces whose normal is within this angle of the build axis.
const ROOF_DEGREES: f64 = 45.0;
/// The bucket grid never has more cells than this, so a fine mesh with thin
/// walls cannot allocate a grid larger than the mesh.
const MAX_BUCKETS: usize = 1 << 21;

struct Band {
    corners: [[f64; 3]; 3],
    thick: f64,
}

pub struct SurfaceBands {
    bands: Vec<Band>,
    origin: [f64; 3],
    cell: f64,
    dims: [usize; 3],
    buckets: Vec<Vec<u32>>,
}

impl SurfaceBands {
    pub fn new(mesh: &Mesh, axis: [f64; 3], skin: f64, wall: f64) -> Self {
        let roof = ROOF_DEGREES.to_radians().cos();
        let bands: Vec<Band> = boundary_faces(mesh)
            .into_iter()
            .filter_map(|face| {
                let thick = if dot(face.normal, axis).abs() >= roof {
                    skin
                } else {
                    wall
                };
                if thick.is_nan() || thick <= 0.0 || face.nodes.len() < 3 {
                    return None;
                }
                Some(Band {
                    corners: [
                        mesh.nodes[face.nodes[0]],
                        mesh.nodes[face.nodes[1]],
                        mesh.nodes[face.nodes[2]],
                    ],
                    thick,
                })
            })
            .collect();
        let mut min = [f64::INFINITY; 3];
        let mut max = [f64::NEG_INFINITY; 3];
        for p in &mesh.nodes {
            for k in 0..3 {
                min[k] = min[k].min(p[k]);
                max[k] = max[k].max(p[k]);
            }
        }
        let thickest = bands.iter().map(|b| b.thick).fold(0.0, f64::max);
        if bands.is_empty() || !min[0].is_finite() {
            return Self {
                bands,
                origin: [0.0; 3],
                cell: 1.0,
                dims: [0; 3],
                buckets: Vec::new(),
            };
        }
        let span = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
        // About two band thicknesses a cell keeps each face in few cells. Grow the cell until the grid fits the cap.
        let mut cell = (2.0 * thickest).max(1e-6);
        let dims = loop {
            let dims = [0, 1, 2].map(|k| ((span[k] / cell).ceil() as usize).max(1));
            if dims[0].saturating_mul(dims[1]).saturating_mul(dims[2]) <= MAX_BUCKETS {
                break dims;
            }
            cell *= 1.5;
        };
        let mut buckets = vec![Vec::new(); dims[0] * dims[1] * dims[2]];
        let mut this = Self {
            bands,
            origin: min,
            cell,
            dims,
            buckets: Vec::new(),
        };
        for (index, band) in this.bands.iter().enumerate() {
            let mut lo = [f64::INFINITY; 3];
            let mut hi = [f64::NEG_INFINITY; 3];
            for c in &band.corners {
                for k in 0..3 {
                    lo[k] = lo[k].min(c[k] - band.thick);
                    hi[k] = hi[k].max(c[k] + band.thick);
                }
            }
            let (a, b) = (this.cell_of(lo), this.cell_of(hi));
            for z in a[2]..=b[2] {
                for y in a[1]..=b[1] {
                    for x in a[0]..=b[0] {
                        buckets[x + dims[0] * (y + dims[1] * z)].push(index as u32);
                    }
                }
            }
        }
        this.buckets = buckets;
        this
    }

    fn cell_of(&self, p: [f64; 3]) -> [usize; 3] {
        [0, 1, 2].map(|k| {
            let at = ((p[k] - self.origin[k]) / self.cell).floor();
            (at.max(0.0) as usize).min(self.dims[k].saturating_sub(1))
        })
    }

    fn bucket(&self, p: [f64; 3]) -> &[u32] {
        if self.buckets.is_empty() {
            return &[];
        }
        let [x, y, z] = self.cell_of(p);
        &self.buckets[x + self.dims[0] * (y + self.dims[1] * z)]
    }

    /// Is `p` within the band of any boundary face?
    pub fn in_band(&self, p: [f64; 3]) -> bool {
        self.bucket(p).iter().any(|&i| {
            let band = &self.bands[i as usize];
            distance_sq_to_triangle(p, &band.corners) <= band.thick * band.thick + 1e-12
        })
    }

    /// Does any band reach the box from `lo` to `hi`? A cheap reject for an element deep inside the part.
    fn near(&self, lo: [f64; 3], hi: [f64; 3]) -> bool {
        if self.buckets.is_empty() {
            return false;
        }
        let (a, b) = (self.cell_of(lo), self.cell_of(hi));
        for z in a[2]..=b[2] {
            for y in a[1]..=b[1] {
                for x in a[0]..=b[0] {
                    if !self.buckets[x + self.dims[0] * (y + self.dims[1] * z)].is_empty() {
                        return true;
                    }
                }
            }
        }
        false
    }

    /// One wall share per element, 0 to 1.
    pub fn wall_shares(&self, mesh: &Mesh) -> Vec<f64> {
        let coarse = sub_centroids(2);
        let fine = sub_centroids(3);
        mesh.elements
            .iter()
            .map(|elem| {
                let corners = [0, 1, 2, 3].map(|a| mesh.nodes[elem.nodes[a]]);
                let mut lo = [f64::INFINITY; 3];
                let mut hi = [f64::NEG_INFINITY; 3];
                for c in &corners {
                    for k in 0..3 {
                        lo[k] = lo[k].min(c[k]);
                        hi[k] = hi[k].max(c[k]);
                    }
                }
                if !self.near(lo, hi) {
                    return 0.0;
                }
                let share = self.share(&corners, &coarse);
                if share > 0.0 && share < 1.0 {
                    self.share(&corners, &fine)
                } else {
                    share
                }
            })
            .collect()
    }

    fn share(&self, corners: &[[f64; 3]; 4], samples: &[[f64; 4]]) -> f64 {
        let inside = samples
            .iter()
            .filter(|l| {
                let p = [0, 1, 2].map(|k| {
                    l[0] * corners[0][k]
                        + l[1] * corners[1][k]
                        + l[2] * corners[2][k]
                        + l[3] * corners[3][k]
                });
                self.in_band(p)
            })
            .count();
        inside as f64 / samples.len() as f64
    }
}

/// Barycentric centroids of the `8^levels` equal children of a tetrahedron.
/// The eight-way split of a tet into four corner tets and four from the inner
/// octahedron gives children of equal volume, so the centroids are equal-weight samples.
fn sub_centroids(levels: u32) -> Vec<[f64; 4]> {
    let unit = [
        [1.0, 0.0, 0.0, 0.0],
        [0.0, 1.0, 0.0, 0.0],
        [0.0, 0.0, 1.0, 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ];
    let mut tets: Vec<[[f64; 4]; 4]> = vec![unit];
    for _ in 0..levels {
        let mut next = Vec::with_capacity(tets.len() * 8);
        for t in &tets {
            let m = |a: usize, b: usize| [0, 1, 2, 3].map(|k| 0.5 * (t[a][k] + t[b][k]));
            // The same child list as `TET_CHILDREN` in mesh.rs: [c0, c1, c2, c3, m01, m12, m02, m03, m13, m23].
            let p = [
                t[0],
                t[1],
                t[2],
                t[3],
                m(0, 1),
                m(1, 2),
                m(0, 2),
                m(0, 3),
                m(1, 3),
                m(2, 3),
            ];
            for child in CHILDREN {
                next.push(child.map(|i| p[i]));
            }
        }
        tets = next;
    }
    tets.iter()
        .map(|t| [0, 1, 2, 3].map(|k| 0.25 * (t[0][k] + t[1][k] + t[2][k] + t[3][k])))
        .collect()
}

const CHILDREN: [[usize; 4]; 8] = [
    [0, 4, 6, 7],
    [1, 4, 8, 5],
    [2, 6, 5, 9],
    [3, 7, 9, 8],
    [4, 6, 7, 9],
    [4, 7, 8, 9],
    [4, 8, 5, 9],
    [4, 5, 6, 9],
];

/// Squared distance from `p` to a triangle: the closest point by Voronoi region of the vertices, edges, and face.
fn distance_sq_to_triangle(p: [f64; 3], t: &[[f64; 3]; 3]) -> f64 {
    let [a, b, c] = *t;
    let ab = sub(b, a);
    let ac = sub(c, a);
    let ap = sub(p, a);
    let d1 = dot(ab, ap);
    let d2 = dot(ac, ap);
    let closest = if d1 <= 0.0 && d2 <= 0.0 {
        a
    } else {
        let bp = sub(p, b);
        let d3 = dot(ab, bp);
        let d4 = dot(ac, bp);
        if d3 >= 0.0 && d4 <= d3 {
            b
        } else {
            let vc = d1 * d4 - d3 * d2;
            if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
                let v = d1 / (d1 - d3);
                along(a, ab, v)
            } else {
                let cp = sub(p, c);
                let d5 = dot(ab, cp);
                let d6 = dot(ac, cp);
                if d6 >= 0.0 && d5 <= d6 {
                    c
                } else {
                    let vb = d5 * d2 - d1 * d6;
                    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
                        let w = d2 / (d2 - d6);
                        along(a, ac, w)
                    } else {
                        let va = d3 * d6 - d5 * d4;
                        if va <= 0.0 && (d4 - d3) >= 0.0 && (d5 - d6) >= 0.0 {
                            let w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
                            along(b, sub(c, b), w)
                        } else {
                            let denom = 1.0 / (va + vb + vc);
                            let v = vb * denom;
                            let w = vc * denom;
                            [0, 1, 2].map(|k| a[k] + ab[k] * v + ac[k] * w)
                        }
                    }
                }
            }
        }
    };
    let d = sub(p, closest);
    dot(d, d)
}

fn along(from: [f64; 3], dir: [f64; 3], t: f64) -> [f64; 3] {
    [0, 1, 2].map(|k| from[k] + dir[k] * t)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_distance_to_a_triangle_takes_the_nearest_region() {
        let t = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];
        assert!(
            (distance_sq_to_triangle([0.2, 0.2, 0.5], &t) - 0.25).abs() < 1e-12,
            "above the face"
        );
        assert!(
            (distance_sq_to_triangle([-1.0, -1.0, 0.0], &t) - 2.0).abs() < 1e-12,
            "past a corner"
        );
        assert!(
            (distance_sq_to_triangle([0.5, -2.0, 0.0], &t) - 4.0).abs() < 1e-12,
            "past an edge"
        );
        assert!(
            (distance_sq_to_triangle([1.0, 1.0, 0.0], &t) - 0.5).abs() < 1e-12,
            "past the long edge"
        );
    }

    #[test]
    fn sub_centroids_are_equal_weight_and_fill_the_tet() {
        for levels in [2, 3] {
            let samples = sub_centroids(levels);
            assert_eq!(samples.len(), 8usize.pow(levels));
            let mean = [0, 1, 2, 3]
                .map(|k| samples.iter().map(|s| s[k]).sum::<f64>() / samples.len() as f64);
            for m in mean {
                assert!(
                    (m - 0.25).abs() < 1e-12,
                    "the samples' mean is the centroid"
                );
            }
            assert!(
                samples
                    .iter()
                    .all(|s| s.iter().all(|&l| l > 0.0)
                        && (s.iter().sum::<f64>() - 1.0).abs() < 1e-12)
            );
        }
    }
}
