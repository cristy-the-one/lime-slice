use std::collections::HashMap;

use crate::mesh::Mesh;
use crate::poly::{loop_bounds, orient_loops, resolve_nonzero, signed_area, Loop};

/// Widest mesh hole a contour is closed across. Wider gaps drop the open chain.
const CLOSE_GAP_MM: f64 = 2.0;

/// A mesh edge `(lo, hi)` by welded vertex id. Two faces that share an edge cut
/// the plane at the same key, so stitching follows topology, not rounded coordinates.
type EdgeKey = u64;

fn edge_key(a: u32, b: u32) -> EdgeKey {
    let (lo, hi) = if a < b { (a, b) } else { (b, a) };
    ((lo as u64) << 32) | hi as u64
}

/// Welded, Z-bucketed faces. A layer tests only the faces that can cross its plane.
pub struct ZIndex {
    verts: Vec<[f64; 3]>,
    faces: Vec<[u32; 3]>,
    z0: f64,
    bucket_h: f64,
    buckets: Vec<Vec<u32>>,
}

/// How much repair one plane cut needed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CutStats {
    /// Gap links added across mesh holes to close a contour.
    pub bridged: usize,
    /// Open chains that could not be closed. Their outline is lost.
    pub dropped: usize,
}

impl ZIndex {
    pub fn build(mesh: &Mesh) -> Self {
        let mut ids: HashMap<[u64; 3], u32> = HashMap::with_capacity(mesh.triangles.len());
        let mut verts = Vec::with_capacity(mesh.triangles.len() / 2 + 3);
        let mut faces = Vec::with_capacity(mesh.triangles.len());
        for tri in &mesh.triangles {
            let mut f = [0u32; 3];
            for (slot, v) in f.iter_mut().zip(tri.iter()) {
                let bits = [v[0].to_bits(), v[1].to_bits(), v[2].to_bits()];
                *slot = *ids.entry(bits).or_insert_with(|| {
                    verts.push(*v);
                    (verts.len() - 1) as u32
                });
            }
            if f[0] != f[1] && f[1] != f[2] && f[0] != f[2] {
                faces.push(f);
            }
        }
        let (mut z_min, mut z_max) = (f64::MAX, f64::MIN);
        for v in &verts {
            z_min = z_min.min(v[2]);
            z_max = z_max.max(v[2]);
        }
        if faces.is_empty() {
            return Self {
                verts,
                faces,
                z0: 0.0,
                bucket_h: 1.0,
                buckets: Vec::new(),
            };
        }
        let span = (z_max - z_min).max(0.2);
        let bucket_h = (span / 256.0).clamp(0.1, 2.0);
        let n = ((span / bucket_h).ceil() as usize).saturating_add(1).max(1);
        let mut buckets = vec![Vec::new(); n];
        for (fi, f) in faces.iter().enumerate() {
            let zs = f.map(|v| verts[v as usize][2]);
            let lo = zs[0].min(zs[1]).min(zs[2]);
            let hi = zs[0].max(zs[1]).max(zs[2]);
            if hi - lo < 1e-12 {
                continue;
            }
            let i0 = bucket_of(lo, z_min, bucket_h, n);
            let i1 = bucket_of(hi, z_min, bucket_h, n);
            for bucket in buckets.iter_mut().take(i1 + 1).skip(i0) {
                bucket.push(fi as u32);
            }
        }
        Self {
            verts,
            faces,
            z0: z_min,
            bucket_h,
            buckets,
        }
    }

    pub fn slice(&self, z: f64) -> Vec<Loop> {
        self.slice_with_stats(z).0
    }

    /// Cut the mesh at `z`. Segments are directed by their face normal so solid
    /// lies on the left, chains are closed across small mesh holes, and the loops
    /// are resolved with a nonzero union so overlapping shells merge instead of
    /// punching holes in each other.
    pub fn slice_with_stats(&self, z: f64) -> (Vec<Loop>, CutStats) {
        if self.buckets.is_empty() {
            return (Vec::new(), CutStats::default());
        }
        let idx = ((z - self.z0) / self.bucket_h).floor() as isize;
        if idx < 0 || idx >= self.buckets.len() as isize {
            return (Vec::new(), CutStats::default());
        }
        let segs: Vec<Seg> = self.buckets[idx as usize]
            .iter()
            .filter_map(|&fi| self.cut_face(self.faces[fi as usize], z))
            .collect();
        let (mut loops, open) = trace(&segs);
        let stats = close_chains(open, &mut loops);
        if loops.iter().map(|l| signed_area(l)).sum::<f64>() < 0.0 {
            // An inside-out mesh cuts every outline clockwise.
            for l in &mut loops {
                l.reverse();
            }
        }
        if boxes_overlap(&loops) {
            (resolve_nonzero(loops), stats)
        } else {
            (orient_loops(loops), stats)
        }
    }

    fn cut_face(&self, f: [u32; 3], z: f64) -> Option<Seg> {
        let p = f.map(|v| self.verts[v as usize]);
        // A vertex on the plane counts as above, so a face has zero or two crossings.
        let above = p.map(|v| v[2] >= z);
        if above[0] == above[1] && above[1] == above[2] {
            return None;
        }
        let hit = |i: usize, j: usize| {
            let (a, b) = (p[i], p[j]);
            let t = (z - a[2]) / (b[2] - a[2]);
            (
                [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
                edge_key(f[i], f[j]),
            )
        };
        // Walking the winding, the plane is crossed once going down and once going up.
        // Down-to-up keeps the solid on the left of the segment for an outward normal.
        let (mut down, mut up) = (None, None);
        for i in 0..3 {
            let j = (i + 1) % 3;
            match (above[i], above[j]) {
                (true, false) => down = Some(hit(i, j)),
                (false, true) => up = Some(hit(i, j)),
                _ => {}
            }
        }
        let ((a, ka), (b, kb)) = (down?, up?);
        Some(Seg { a, b, ka, kb })
    }
}

#[derive(Clone, Copy)]
struct Seg {
    a: [f64; 2],
    b: [f64; 2],
    ka: EdgeKey,
    kb: EdgeKey,
}

/// Follow directed segments head to tail by edge key. Closed rings come back as
/// loops. Runs broken by mesh holes or flipped faces come back as open chains.
fn trace(segs: &[Seg]) -> (Vec<Loop>, Vec<Loop>) {
    let mut starts: HashMap<EdgeKey, Vec<u32>> = HashMap::with_capacity(segs.len());
    let mut ends: HashMap<EdgeKey, u32> = HashMap::with_capacity(segs.len());
    for (i, s) in segs.iter().enumerate() {
        starts.entry(s.ka).or_default().push(i as u32);
        *ends.entry(s.kb).or_default() += 1;
    }
    let mut used = vec![false; segs.len()];
    let (mut closed, mut open) = (Vec::new(), Vec::new());
    // Start at dangling keys first so an open run is traced from its real head.
    let heads = (0..segs.len()).filter(|i| !ends.contains_key(&segs[*i].ka));
    for start in heads.chain(0..segs.len()).collect::<Vec<_>>() {
        if used[start] {
            continue;
        }
        used[start] = true;
        let first = segs[start].ka;
        let mut pts = vec![segs[start].a, segs[start].b];
        let mut key = segs[start].kb;
        let mut is_closed = false;
        while let Some(ni) = starts
            .get(&key)
            .and_then(|c| c.iter().map(|i| *i as usize).find(|i| !used[*i]))
        {
            used[ni] = true;
            key = segs[ni].kb;
            if key == first {
                is_closed = true;
                break;
            }
            pts.push(segs[ni].b);
        }
        if is_closed {
            closed.push(pts);
        } else {
            open.push(pts);
        }
    }
    (closed, open)
}

/// Join open chains end to end across gaps up to `CLOSE_GAP_MM`, nearest first.
/// A head-to-tail link is preferred. A link that has to flip a chain (a patch of
/// reversed faces) costs double. Chains that still cannot close are dropped.
fn close_chains(open: Vec<Loop>, loops: &mut Vec<Loop>) -> CutStats {
    let mut stats = CutStats::default();
    if open.is_empty() {
        return stats;
    }
    // Endpoint 2k is the head of chain k, 2k+1 its tail.
    let point = |e: usize| {
        let c = &open[e / 2];
        if e % 2 == 0 {
            c[0]
        } else {
            *c.last().unwrap()
        }
    };
    let n = open.len() * 2;
    let mut links: Vec<(f64, usize, usize)> = Vec::new();
    for p in 0..n {
        for q in (p + 1)..n {
            let (a, b) = (point(p), point(q));
            let d = (a[0] - b[0]).hypot(a[1] - b[1]);
            if d > CLOSE_GAP_MM {
                continue;
            }
            let head_to_tail = p % 2 != q % 2;
            links.push((if head_to_tail { d } else { d * 2.0 + 1e-6 }, p, q));
        }
    }
    links.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut mate = vec![usize::MAX; n];
    for (_, p, q) in links {
        if mate[p] == usize::MAX && mate[q] == usize::MAX {
            mate[p] = q;
            mate[q] = p;
        }
    }
    // Each endpoint has at most one gap link and one chain, so every walk is a cycle or a path.
    let mut seen = vec![false; open.len()];
    for k in 0..open.len() {
        if seen[k] {
            continue;
        }
        let mut ring: Loop = Vec::new();
        let (mut forward_len, mut reverse_len) = (0.0, 0.0);
        let mut enter = 2 * k;
        let mut links_used = 0;
        let closed = loop {
            let c = enter / 2;
            seen[c] = true;
            let len = polyline_len(&open[c]);
            if enter % 2 == 0 {
                ring.extend_from_slice(&open[c]);
                forward_len += len;
            } else {
                ring.extend(open[c].iter().rev());
                reverse_len += len;
            }
            let next = mate[enter ^ 1];
            if next == usize::MAX {
                break false;
            }
            links_used += 1;
            if next / 2 == k {
                break next == 2 * k;
            }
            if seen[next / 2] {
                break false;
            }
            enter = next;
        };
        if closed && ring.len() >= 3 {
            if reverse_len > forward_len {
                ring.reverse();
            }
            stats.bridged += links_used;
            loops.push(ring);
        } else {
            stats.dropped += 1;
        }
    }
    stats
}

/// Loops with disjoint bounding boxes cannot overlap or nest, so they need no union.
fn boxes_overlap(loops: &[Loop]) -> bool {
    let boxes: Vec<_> = loops
        .iter()
        .filter_map(|l| loop_bounds(std::slice::from_ref(l)))
        .collect();
    boxes.iter().enumerate().any(|(i, a)| {
        boxes[i + 1..]
            .iter()
            .any(|b| a.0[0] <= b.1[0] && b.0[0] <= a.1[0] && a.0[1] <= b.1[1] && b.0[1] <= a.1[1])
    })
}

fn polyline_len(pts: &[[f64; 2]]) -> f64 {
    pts.windows(2)
        .map(|w| (w[1][0] - w[0][0]).hypot(w[1][1] - w[0][1]))
        .sum()
}

fn bucket_of(z: f64, z0: f64, h: f64, n: usize) -> usize {
    let i = ((z - z0) / h).floor() as isize;
    i.clamp(0, n as isize - 1) as usize
}
