//! A triangle mesh that can be cut: edge and face splits that keep the
//! adjacency, point insertion with snapping, and the walk that turns a
//! path on the surface into a chain of mesh edges.
//!
//! Vertices are only ever appended, so an index of the input mesh names
//! the same vertex after any number of cuts. Every new triangle remembers
//! the input triangle it came from (`parent`), which is how loads and
//! keep-out sets given on the input carry over.
//!
//! Hash maps here are only looked up, never iterated, so the cuts are
//! deterministic.

use std::collections::HashMap;

use crate::shell::ShellMesh;
use crate::units::{add, cross, dot, norm, normalize, scale, sub};

/// How a vertex came to be.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Origin {
    /// A vertex of the input mesh.
    Input,
    /// Made on the edge from `a` to `b`, a fraction `s` of the way.
    Edge(u32, u32, f64),
    /// Made inside a face of input triangle `parent`.
    Face,
}

/// Snapping tolerance, as a fraction of an edge (or a barycentric
/// coordinate): a cut closer than this to a vertex goes through the vertex
/// instead, so no edge is ever shorter than this share of the one it was
/// cut from. Smaller keeps rib paths truer and makes thinner triangles;
/// the 30° rib test (`tests/rib_planner.rs`) gives -0.4 % at 0.08, +2.8 % at 0.15 and +8.2 % at 0.25 against an aligned mesh.
pub(crate) const SNAP: f64 = 0.1;

fn key(a: u32, b: u32) -> (u32, u32) {
    if a < b {
        (a, b)
    } else {
        (b, a)
    }
}

#[derive(Clone, Debug)]
pub(crate) struct Surface {
    pub pos: Vec<[f64; 3]>,
    pub thickness: Vec<f64>,
    /// Height cap per vertex (clearance to what faces the wall), mm.
    pub clearance: Vec<f64>,
    pub origin: Vec<Origin>,
    pub tris: Vec<[u32; 3]>,
    /// The input triangle each triangle was cut from.
    pub parent: Vec<u32>,
    pub vert_tris: Vec<Vec<u32>>,
    edge_tris: HashMap<(u32, u32), Vec<u32>>,
    /// Embedded paths, as vertex chains, kept whole through later cuts.
    pub chains: Vec<Vec<u32>>,
    edge_chains: HashMap<(u32, u32), Vec<usize>>,
}

impl Surface {
    pub fn new(mesh: &ShellMesh, clearance: Option<&[f64]>) -> Self {
        let n = mesh.vertices.len();
        let mut s = Self {
            pos: mesh.vertices.clone(),
            thickness: mesh.thickness.clone(),
            clearance: clearance.map_or_else(|| vec![f64::INFINITY; n], <[f64]>::to_vec),
            origin: vec![Origin::Input; n],
            tris: mesh.triangles.clone(),
            parent: (0..mesh.triangles.len() as u32).collect(),
            vert_tris: vec![Vec::new(); n],
            edge_tris: HashMap::new(),
            chains: Vec::new(),
            edge_chains: HashMap::new(),
        };
        for (t, tri) in mesh.triangles.iter().enumerate() {
            for k in 0..3 {
                s.vert_tris[tri[k] as usize].push(t as u32);
                s.edge_tris
                    .entry(key(tri[k], tri[(k + 1) % 3]))
                    .or_default()
                    .push(t as u32);
            }
        }
        s
    }

    pub fn to_mesh(&self) -> ShellMesh {
        ShellMesh {
            vertices: self.pos.clone(),
            triangles: self.tris.clone(),
            thickness: self.thickness.clone(),
        }
    }

    pub fn corners(&self, t: u32) -> [[f64; 3]; 3] {
        self.tris[t as usize].map(|v| self.pos[v as usize])
    }

    /// Unit normal by the corner order.
    pub fn normal(&self, t: u32) -> [f64; 3] {
        let [a, b, c] = self.corners(t);
        normalize(cross(sub(b, a), sub(c, a))).unwrap_or([0.0, 0.0, 1.0])
    }

    pub fn area(&self, t: u32) -> f64 {
        let [a, b, c] = self.corners(t);
        0.5 * norm(cross(sub(b, a), sub(c, a)))
    }

    pub fn centroid(&self, t: u32) -> [f64; 3] {
        let [a, b, c] = self.corners(t);
        scale(add(add(a, b), c), 1.0 / 3.0)
    }

    /// The triangles on edge `a`–`b`.
    pub fn edge_triangles(&self, a: u32, b: u32) -> &[u32] {
        self.edge_tris.get(&key(a, b)).map_or(&[], Vec::as_slice)
    }

    /// The triangle across local edge `k` (corner `k` to corner `k + 1`) of
    /// `t`, if any.
    pub fn neighbour(&self, t: u32, k: usize) -> Option<u32> {
        let tri = self.tris[t as usize];
        self.edge_triangles(tri[k], tri[(k + 1) % 3])
            .iter()
            .copied()
            .find(|&o| o != t)
    }

    /// Vertices on an edge with one triangle.
    pub fn boundary_flags(&self) -> Vec<bool> {
        let mut flags = vec![false; self.pos.len()];
        for tri in &self.tris {
            for k in 0..3 {
                let (a, b) = (tri[k], tri[(k + 1) % 3]);
                if self.edge_triangles(a, b).len() == 1 {
                    flags[a as usize] = true;
                    flags[b as usize] = true;
                }
            }
        }
        flags
    }

    /// Closed boundary loops, each as its vertex cycle, in a fixed order
    /// (by their lowest triangle).
    pub fn boundary_loops(&self) -> Vec<Vec<u32>> {
        // Each boundary edge, directed as its triangle runs it.
        let mut next: HashMap<u32, u32> = HashMap::new();
        let mut starts = Vec::new();
        for tri in &self.tris {
            for k in 0..3 {
                let (a, b) = (tri[k], tri[(k + 1) % 3]);
                if self.edge_triangles(a, b).len() == 1 {
                    next.insert(a, b);
                    starts.push(a);
                }
            }
        }
        let mut seen = vec![false; self.pos.len()];
        let mut loops = Vec::new();
        for s in starts {
            if seen[s as usize] {
                continue;
            }
            let mut cycle = Vec::new();
            let mut v = s;
            while !seen[v as usize] {
                seen[v as usize] = true;
                cycle.push(v);
                match next.get(&v) {
                    Some(&w) => v = w,
                    None => break,
                }
            }
            loops.push(cycle);
        }
        loops
    }

    /// Barycentric coordinates of `p` projected on `t`'s plane, and its
    /// distance from that plane.
    pub fn barycentric(&self, t: u32, p: [f64; 3]) -> ([f64; 3], f64) {
        let [a, b, c] = self.corners(t);
        let n = cross(sub(b, a), sub(c, a));
        let nn = dot(n, n);
        let la = dot(cross(sub(c, b), sub(p, b)), n) / nn;
        let lb = dot(cross(sub(a, c), sub(p, c)), n) / nn;
        let lc = 1.0 - la - lb;
        let height = dot(sub(p, a), n) / nn.sqrt();
        ([la, lb, lc], height)
    }

    pub fn at(&self, t: u32, l: [f64; 3]) -> [f64; 3] {
        let [a, b, c] = self.corners(t);
        add(add(scale(a, l[0]), scale(b, l[1])), scale(c, l[2]))
    }

    /// The triangle nearest `p` and `p`'s barycentric coordinates there,
    /// clamped into it.
    pub fn locate(&self, p: [f64; 3]) -> (u32, [f64; 3]) {
        let mut best = (f64::INFINITY, 0u32, [1.0 / 3.0; 3]);
        for t in 0..self.tris.len() as u32 {
            let (l, h) = self.barycentric(t, p);
            let c = clamp_barycentric(l);
            let q = self.at(t, c);
            let d = norm(sub(q, p));
            let _ = h;
            if d < best.0 {
                best = (d, t, c);
            }
        }
        (best.1, best.2)
    }

    fn new_vertex(&mut self, p: [f64; 3], thickness: f64, clearance: f64, origin: Origin) -> u32 {
        self.pos.push(p);
        self.thickness.push(thickness);
        self.clearance.push(clearance);
        self.origin.push(origin);
        self.vert_tris.push(Vec::new());
        (self.pos.len() - 1) as u32
    }

    fn replace_in(list: &mut [u32], old: u32, new: u32) {
        if let Some(x) = list.iter_mut().find(|x| **x == old) {
            *x = new;
        }
    }

    fn add_edge(&mut self, a: u32, b: u32, t: u32) {
        self.edge_tris.entry(key(a, b)).or_default().push(t);
    }

    /// Cut edge `a`–`b` at a fraction `s` from `a`; returns the new vertex.
    /// Both triangles on the edge are halved, and every embedded chain
    /// that ran along the edge now runs through the new vertex.
    pub fn split_edge(&mut self, a: u32, b: u32, s: f64) -> u32 {
        let (pa, pb) = (self.pos[a as usize], self.pos[b as usize]);
        let p = add(pa, scale(sub(pb, pa), s));
        let lerp = |x: f64, y: f64| {
            if x.is_finite() && y.is_finite() {
                x + s * (y - x)
            } else {
                x.min(y)
            }
        };
        let th = lerp(self.thickness[a as usize], self.thickness[b as usize]);
        let cl = lerp(self.clearance[a as usize], self.clearance[b as usize]);
        let c = self.new_vertex(p, th, cl, Origin::Edge(a, b, s));
        let tris = self.edge_tris.remove(&key(a, b)).unwrap_or_default();
        for t in tris {
            let tri = self.tris[t as usize];
            let i = (0..3)
                .find(|&i| key(tri[i], tri[(i + 1) % 3]) == key(a, b))
                .expect("the triangle is on the edge");
            let (t0, t1, t2) = (tri[i], tri[(i + 1) % 3], tri[(i + 2) % 3]);
            let nt = self.tris.len() as u32;
            self.tris[t as usize] = [t0, c, t2];
            self.tris.push([c, t1, t2]);
            self.parent.push(self.parent[t as usize]);
            self.add_edge(t0, c, t);
            self.add_edge(c, t1, nt);
            self.add_edge(c, t2, t);
            self.add_edge(c, t2, nt);
            if let Some(list) = self.edge_tris.get_mut(&key(t1, t2)) {
                Self::replace_in(list, t, nt);
            }
            Self::replace_in(&mut self.vert_tris[t1 as usize], t, nt);
            self.vert_tris[t2 as usize].push(nt);
            self.vert_tris[c as usize].push(t);
            self.vert_tris[c as usize].push(nt);
        }
        if let Some(ids) = self.edge_chains.remove(&key(a, b)) {
            for id in ids {
                let chain = &mut self.chains[id];
                if let Some(i) = (0..chain.len().saturating_sub(1))
                    .find(|&i| key(chain[i], chain[i + 1]) == key(a, b))
                {
                    chain.insert(i + 1, c);
                }
                self.edge_chains.entry(key(a, c)).or_default().push(id);
                self.edge_chains.entry(key(c, b)).or_default().push(id);
            }
        }
        c
    }

    /// Cut triangle `t` into three at barycentric `l`; returns the new
    /// vertex.
    pub fn split_face(&mut self, t: u32, l: [f64; 3]) -> u32 {
        let [a, b, d] = self.tris[t as usize];
        let p = self.at(t, l);
        let interp = |v: &[f64]| {
            let x = [a, b, d].map(|q| v[q as usize]);
            if x.iter().all(|y| y.is_finite()) {
                l[0] * x[0] + l[1] * x[1] + l[2] * x[2]
            } else {
                x[0].min(x[1]).min(x[2])
            }
        };
        let th = interp(&self.thickness);
        let cl = interp(&self.clearance);
        let c = self.new_vertex(p, th, cl, Origin::Face);
        let n1 = self.tris.len() as u32;
        let n2 = n1 + 1;
        self.tris[t as usize] = [a, b, c];
        self.tris.push([b, d, c]);
        self.tris.push([d, a, c]);
        let parent = self.parent[t as usize];
        self.parent.push(parent);
        self.parent.push(parent);
        if let Some(list) = self.edge_tris.get_mut(&key(b, d)) {
            Self::replace_in(list, t, n1);
        }
        if let Some(list) = self.edge_tris.get_mut(&key(d, a)) {
            Self::replace_in(list, t, n2);
        }
        self.add_edge(a, c, t);
        self.add_edge(a, c, n2);
        self.add_edge(b, c, t);
        self.add_edge(b, c, n1);
        self.add_edge(d, c, n1);
        self.add_edge(d, c, n2);
        self.vert_tris[a as usize].push(n2);
        self.vert_tris[b as usize].push(n1);
        Self::replace_in(&mut self.vert_tris[d as usize], t, n1);
        self.vert_tris[d as usize].push(n2);
        self.vert_tris[c as usize].extend([t, n1, n2]);
        c
    }

    /// Put a vertex at barycentric `l` of `t`, snapping to a corner or an
    /// edge when within [`SNAP`] of it.
    pub fn insert_in(&mut self, t: u32, l: [f64; 3]) -> u32 {
        let l = clamp_barycentric(l);
        let tri = self.tris[t as usize];
        let small: Vec<usize> = (0..3).filter(|&i| l[i] < SNAP).collect();
        match small.len() {
            0 => self.split_face(t, l),
            1 => {
                let i = small[0];
                let (a, b) = ((i + 1) % 3, (i + 2) % 3);
                let s = l[b] / (l[a] + l[b]);
                if s < SNAP {
                    tri[a]
                } else if s > 1.0 - SNAP {
                    tri[b]
                } else {
                    self.split_edge(tri[a], tri[b], s)
                }
            }
            _ => {
                let k = (0..3)
                    .max_by(|&x, &y| l[x].total_cmp(&l[y]).then(y.cmp(&x)))
                    .expect("three corners");
                tri[k]
            }
        }
    }

    /// Put a vertex at `p` (anywhere on the surface).
    pub fn insert_point(&mut self, p: [f64; 3]) -> u32 {
        let (t, l) = self.locate(p);
        self.insert_in(t, l)
    }

    /// The triangle around vertex `v` whose corner sector at `v` holds the
    /// direction from `v` toward `target` (projected on each triangle's
    /// plane): the triangle and its other two corners in order, and how
    /// far inside the sector the direction is (a sine; negative outside).
    fn sector(
        &self,
        v: u32,
        target: [f64; 3],
        exclude: Option<u32>,
    ) -> Option<(u32, u32, u32, f64)> {
        let pv = self.pos[v as usize];
        let mut best: Option<(u32, u32, u32, f64)> = None;
        for &t in &self.vert_tris[v as usize] {
            if Some(t) == exclude {
                continue;
            }
            let tri = self.tris[t as usize];
            let i = (0..3).find(|&i| tri[i] == v).expect("v is a corner");
            let (x, y) = (tri[(i + 1) % 3], tri[(i + 2) % 3]);
            let n = self.normal(t);
            let d = sub(target, pv);
            let d = sub(d, scale(n, dot(d, n)));
            let Some(d) = normalize(d) else {
                continue;
            };
            let ex = normalize(sub(self.pos[x as usize], pv)).unwrap_or(d);
            let ey = normalize(sub(self.pos[y as usize], pv)).unwrap_or(d);
            let m = dot(cross(ex, d), n).min(dot(cross(d, ey), n));
            // The sector is under 180°, so both tests together also need the
            // direction on the sector's side.
            let m = if dot(d, add(ex, ey)) <= 0.0 { -1.0 } else { m };
            if best.is_none_or(|b| m > b.3) {
                best = Some((t, x, y, m));
            }
        }
        best
    }

    /// Walk from vertex `from` to the point `target` on the surface,
    /// cutting the mesh so that the path is a chain of edges; `target`
    /// becomes (or snaps to) the chain's last vertex. The direction is
    /// re-aimed at the target in each triangle, so on a curved wall the
    /// path stays on the surface. `None` when the walk runs off the mesh.
    pub fn walk_to(&mut self, from: u32, target: [f64; 3]) -> Option<Vec<u32>> {
        let mut path = vec![from];
        let mut cur = from;
        for _ in 0..100_000 {
            let pc = self.pos[cur as usize];
            let gap = norm(sub(target, pc));
            if gap < 1e-9 {
                return Some(path);
            }
            let (t, x, y, margin) = self.sector(cur, target, None)?;
            if margin < -0.02 {
                return None;
            }
            let (l, _) = self.barycentric(t, target);
            if l.iter().all(|&q| q >= -1e-9) {
                let v = self.insert_in(t, l);
                if v != cur {
                    path.push(v);
                }
                return Some(path);
            }
            // Where the ray from `cur` toward the target crosses edge x–y.
            let n = self.normal(t);
            let d = sub(target, pc);
            let d = sub(d, scale(n, dot(d, n)));
            let (px, py) = (self.pos[x as usize], self.pos[y as usize]);
            let u = sub(py, px);
            let w = sub(px, pc);
            let den = dot(cross(d, u), n);
            let s = if den.abs() < 1e-300 {
                0.5
            } else {
                (dot(cross(w, d), n) / den).clamp(0.0, 1.0)
            };
            let next = if s < SNAP {
                x
            } else if s > 1.0 - SNAP {
                y
            } else {
                self.split_edge(x, y, s)
            };
            if next == cur {
                return None;
            }
            path.push(next);
            cur = next;
        }
        None
    }

    /// Embed a polyline: its first point becomes a vertex, and the walk
    /// joins each next point. Returns the chain id, or `None` when nothing
    /// of it could be embedded (it stops early where the walk fails).
    pub fn embed_polyline(&mut self, points: &[[f64; 3]]) -> Option<usize> {
        let first = *points.first()?;
        let start = self.insert_point(first);
        let id = self.chains.len();
        self.chains.push(vec![start]);
        for &p in &points[1..] {
            let from = *self.chains[id].last().expect("never empty");
            let Some(path) = self.walk_to(from, p) else {
                break;
            };
            for &v in &path[1..] {
                let chain = &mut self.chains[id];
                let last = *chain.last().expect("never empty");
                chain.push(v);
                self.edge_chains.entry(key(last, v)).or_default().push(id);
            }
        }
        if self.chains[id].len() < 2 {
            return None;
        }
        Some(id)
    }

    pub fn chain_length(&self, chain: &[u32]) -> f64 {
        chain
            .windows(2)
            .map(|w| norm(sub(self.pos[w[1] as usize], self.pos[w[0] as usize])))
            .sum()
    }
}

pub(crate) fn clamp_barycentric(l: [f64; 3]) -> [f64; 3] {
    let c = l.map(|x| x.max(0.0));
    let s: f64 = c.iter().sum();
    if s <= 0.0 {
        [1.0 / 3.0; 3]
    } else {
        c.map(|x| x / s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square(n: usize) -> Surface {
        Surface::new(&ShellMesh::rectangle([10.0, 10.0], [n, n], 1.0), None)
    }

    fn check(s: &Surface) {
        // Every interior edge has two triangles, every triangle has area,
        // and the areas add up.
        let mut area = 0.0;
        for t in 0..s.tris.len() as u32 {
            assert!(s.area(t) > 1e-6, "triangle {t} is degenerate");
            assert!(s.normal(t)[2] > 0.99, "triangle {t} flipped");
            area += s.area(t);
            let tri = s.tris[t as usize];
            for k in 0..3 {
                assert!(s.edge_triangles(tri[k], tri[(k + 1) % 3]).contains(&t));
                assert!(s.vert_tris[tri[k] as usize].contains(&t));
            }
        }
        assert!((area - 100.0).abs() < 1e-9, "{area}");
    }

    #[test]
    fn a_walk_cuts_a_straight_chain_of_edges() {
        let mut s = square(5);
        let id = s
            .embed_polyline(&[[0.0, 3.1, 0.0], [10.0, 7.3, 0.0]])
            .unwrap();
        check(&s);
        let chain = s.chains[id].clone();
        // Every vertex sits near the line, and every step is an edge.
        for &v in &chain {
            let p = s.pos[v as usize];
            let y = 3.1 + 0.42 * p[0];
            assert!((p[1] - y).abs() < 0.5, "{p:?}");
        }
        for w in chain.windows(2) {
            assert!(!s.edge_triangles(w[0], w[1]).is_empty());
        }
        let len = s.chain_length(&chain);
        let straight = (100.0f64 + 4.2 * 4.2).sqrt();
        assert!(len < 1.02 * straight, "{len} vs {straight}");
        // A second path across the first shares a vertex with it, and the
        // first chain still runs whole through the new cuts.
        let other = s
            .embed_polyline(&[[4.3, 0.0, 0.0], [5.2, 10.0, 0.0]])
            .unwrap();
        check(&s);
        let first = &s.chains[id];
        for w in first.windows(2) {
            assert!(!s.edge_triangles(w[0], w[1]).is_empty());
        }
        let shared = s.chains[other].iter().filter(|v| first.contains(v)).count();
        assert_eq!(shared, 1);
    }

    #[test]
    fn loops_and_boundary() {
        let s = square(4);
        let loops = s.boundary_loops();
        assert_eq!(loops.len(), 1);
        assert_eq!(loops[0].len(), 16);
        assert_eq!(s.boundary_flags().iter().filter(|b| **b).count(), 16);
    }
}
