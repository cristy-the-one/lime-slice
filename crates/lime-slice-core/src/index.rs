use crate::contour::{contours_from_segments, Loop};
use crate::mesh::Mesh;

struct Edge {
    tri: u32,
    a: [f64; 3],
    b: [f64; 3],
    z_lo: f64,
    z_hi: f64,
}

/// Z-bucket of mesh edges. A layer tests only the edges that can cross its plane.
pub struct ZIndex {
    z0: f64,
    bucket_h: f64,
    buckets: Vec<Vec<u32>>,
    edges: Vec<Edge>,
}

impl ZIndex {
    pub fn build(mesh: &Mesh) -> Self {
        let mut edges = Vec::with_capacity(mesh.triangles.len() * 2);
        let mut z_min = f64::MAX;
        let mut z_max = f64::MIN;
        for (ti, tri) in mesh.triangles.iter().enumerate() {
            for e in 0..3 {
                let a = tri[e];
                let b = tri[(e + 1) % 3];
                let z_lo = a[2].min(b[2]);
                let z_hi = a[2].max(b[2]);
                if z_hi - z_lo < 1e-9 {
                    continue;
                }
                z_min = z_min.min(z_lo);
                z_max = z_max.max(z_hi);
                edges.push(Edge {
                    tri: ti as u32,
                    a,
                    b,
                    z_lo,
                    z_hi,
                });
            }
        }
        if edges.is_empty() {
            return Self {
                z0: 0.0,
                bucket_h: 1.0,
                buckets: Vec::new(),
                edges,
            };
        }
        let span = (z_max - z_min).max(0.2);
        let bucket_h = (span / 64.0).clamp(0.25, 2.0);
        let n = ((span / bucket_h).ceil() as usize).saturating_add(1).max(1);
        let mut buckets = vec![Vec::new(); n];
        for (i, edge) in edges.iter().enumerate() {
            let i0 = bucket_of(edge.z_lo, z_min, bucket_h, n);
            let i1 = bucket_of(edge.z_hi, z_min, bucket_h, n);
            for b in i0..=i1 {
                buckets[b].push(i as u32);
            }
        }
        Self {
            z0: z_min,
            bucket_h,
            buckets,
            edges,
        }
    }

    pub fn slice(&self, z: f64) -> Vec<Loop> {
        if self.buckets.is_empty() {
            return Vec::new();
        }
        let idx = ((z - self.z0) / self.bucket_h).floor() as isize;
        if idx < 0 || idx >= self.buckets.len() as isize {
            return Vec::new();
        }
        // Bucket entries were appended in triangle order, so hits from one
        // triangle stay adjacent and do not need a sort.
        let mut segs = Vec::new();
        let mut open_tri = u32::MAX;
        let mut open_pt = [0.0, 0.0];
        let mut open = false;
        for &ei in &self.buckets[idx as usize] {
            let edge = &self.edges[ei as usize];
            if z < edge.z_lo || z > edge.z_hi {
                continue;
            }
            let Some(p) = cross(edge, z) else {
                continue;
            };
            if open && open_tri == edge.tri {
                if dist2(open_pt, p) > 1e-12 {
                    segs.push((open_pt, p));
                }
                open = false;
            } else {
                open_tri = edge.tri;
                open_pt = p;
                open = true;
            }
        }
        contours_from_segments(segs)
    }
}

fn bucket_of(z: f64, z0: f64, h: f64, n: usize) -> usize {
    let i = ((z - z0) / h).floor() as isize;
    i.clamp(0, n as isize - 1) as usize
}

fn cross(edge: &Edge, z: f64) -> Option<[f64; 2]> {
    let za = edge.a[2];
    let zb = edge.b[2];
    let crosses = (za < z && zb >= z) || (zb < z && za >= z);
    if !crosses {
        return None;
    }
    let denom = zb - za;
    if denom.abs() < 1e-15 {
        return None;
    }
    let t = (z - za) / denom;
    Some([
        edge.a[0] + (edge.b[0] - edge.a[0]) * t,
        edge.a[1] + (edge.b[1] - edge.a[1]) * t,
    ])
}

fn dist2(a: [f64; 2], b: [f64; 2]) -> f64 {
    let dx = a[0] - b[0];
    let dy = a[1] - b[1];
    dx * dx + dy * dy
}
