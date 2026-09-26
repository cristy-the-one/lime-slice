//! Quadric edge collapse limited by what the nozzle can reproduce.
//!
//! The bound is half the smaller of nozzle diameter and layer height, in
//! print-space millimetres (after scale, pose, and bed settle). A 0.4 mm
//! nozzle and a 0.2 mm layer give 0.10 mm, which is 0.25 × the nozzle. That
//! sits at the tight end of the usual 0.25–0.5 × nozzle band so a 0.7 mm fin
//! and a sharp overhang edge are not eaten. Area-weighted plane quadrics
//! choose the new vertex; a collapse is kept only when the area-weighted RMS
//! distance to the original planes, and the distance to every touched current
//! plane, stay inside that bound. Edges with anything other than one or two
//! faces are left alone, and the link condition keeps a manifold edge manifold.
//! Candidates are rebuilt each pass and collapsed smallest-error first, so a
//! rejected edge is not scored again until the surface around it changes.

use std::borrow::Cow;
use std::collections::HashMap;
use std::time::Instant;

use crate::cancel::Job;
use crate::mesh::Mesh;

/// Checked-in samples other than Dragon 2.5 are at or under the hull's 4800
/// triangles. Contouring those is already cheap, and rebuilding them would
/// move G-code on meshes the nozzle can already trace. Denser meshes are collapsed.
pub const SIMPLIFY_MIN_TRIANGLES: usize = 8_000;

#[derive(Clone, Copy, Debug)]
pub struct SimplifyStats {
    pub source_triangles: usize,
    pub triangles: usize,
    pub error_mm: f64,
    pub milliseconds: f64,
}

/// Half the smaller of nozzle diameter and layer height.
///
/// `0.4` and `0.2` → `0.10` mm (0.25 × nozzle). A zero or non-finite input
/// falls back to that same 0.4 mm / 0.2 mm pair.
pub fn nozzle_error_mm(nozzle_diameter: f64, layer_height: f64) -> f64 {
    let nozzle = if nozzle_diameter.is_finite() && nozzle_diameter > 0.0 {
        nozzle_diameter
    } else {
        0.4
    };
    let layer = if layer_height.is_finite() && layer_height > 0.0 {
        layer_height
    } else {
        0.2
    };
    0.5 * nozzle.min(layer)
}

/// Simplify when enabled and the mesh is dense enough to be worth rebuilding.
/// The borrowed mesh is the input; nothing was collapsed.
pub fn simplify_for_nozzle<'a>(
    mesh: &'a Mesh,
    enabled: bool,
    error_mm: f64,
    job: Job,
) -> Result<(Cow<'a, Mesh>, SimplifyStats), String> {
    let source = mesh.triangle_count();
    let started = Instant::now();
    let skip =
        !enabled || !error_mm.is_finite() || error_mm <= 0.0 || source < SIMPLIFY_MIN_TRIANGLES;
    if skip {
        return Ok((
            Cow::Borrowed(mesh),
            SimplifyStats {
                source_triangles: source,
                triangles: source,
                error_mm: if enabled { error_mm.max(0.0) } else { 0.0 },
                milliseconds: millis(started),
            },
        ));
    }
    let Some(simplified) = simplify_inner(mesh, error_mm, job)? else {
        return Ok((
            Cow::Borrowed(mesh),
            SimplifyStats {
                source_triangles: source,
                triangles: source,
                error_mm,
                milliseconds: millis(started),
            },
        ));
    };
    let triangles = simplified.triangle_count();
    Ok((
        Cow::Owned(simplified),
        SimplifyStats {
            source_triangles: source,
            triangles,
            error_mm,
            milliseconds: millis(started),
        },
    ))
}

/// Collapse `mesh` until every remaining edge would move the surface by more
/// than `max_error_mm`. The result is empty only when the input was empty.
pub fn simplify_mesh(mesh: &Mesh, max_error_mm: f64) -> Result<Mesh, String> {
    if !max_error_mm.is_finite() || max_error_mm <= 0.0 {
        return Ok(mesh.clone());
    }
    Ok(simplify_inner(mesh, max_error_mm, Job::default())?.unwrap_or_else(|| mesh.clone()))
}

fn millis(started: Instant) -> f64 {
    started.elapsed().as_secs_f64() * 1000.0
}

#[derive(Clone, Copy)]
struct Quadric {
    a: f64,
    b: f64,
    c: f64,
    d: f64,
    e: f64,
    f: f64,
    g: f64,
    h: f64,
    i: f64,
    j: f64,
}

impl Quadric {
    fn zero() -> Self {
        Self {
            a: 0.0,
            b: 0.0,
            c: 0.0,
            d: 0.0,
            e: 0.0,
            f: 0.0,
            g: 0.0,
            h: 0.0,
            i: 0.0,
            j: 0.0,
        }
    }

    fn from_plane(n: [f64; 3], d: f64, weight: f64) -> Self {
        let [x, y, z] = n;
        Self {
            a: weight * x * x,
            b: weight * x * y,
            c: weight * x * z,
            d: weight * x * d,
            e: weight * y * y,
            f: weight * y * z,
            g: weight * y * d,
            h: weight * z * z,
            i: weight * z * d,
            j: weight * d * d,
        }
    }

    fn add(self, o: Self) -> Self {
        Self {
            a: self.a + o.a,
            b: self.b + o.b,
            c: self.c + o.c,
            d: self.d + o.d,
            e: self.e + o.e,
            f: self.f + o.f,
            g: self.g + o.g,
            h: self.h + o.h,
            i: self.i + o.i,
            j: self.j + o.j,
        }
    }

    /// Squared distance to the accumulated planes, scaled by whatever weight
    /// `from_plane` was given.
    fn eval(self, p: [f64; 3]) -> f64 {
        let [x, y, z] = p;
        self.a * x * x
            + 2.0 * self.b * x * y
            + 2.0 * self.c * x * z
            + 2.0 * self.d * x
            + self.e * y * y
            + 2.0 * self.f * y * z
            + 2.0 * self.g * y
            + self.h * z * z
            + 2.0 * self.i * z
            + self.j
    }

    fn solve(self) -> Option<[f64; 3]> {
        let (a, b, c, e, f, h) = (self.a, self.b, self.c, self.e, self.f, self.h);
        let det = a * (e * h - f * f) - b * (b * h - c * f) + c * (b * f - e * c);
        let scale = a.abs() + e.abs() + h.abs() + 1.0;
        if !det.is_finite() || det.abs() < 1e-12 * scale * scale * scale {
            return None;
        }
        let r0 = -self.d;
        let r1 = -self.g;
        let r2 = -self.i;
        let inv = 1.0 / det;
        let x = (r0 * (e * h - f * f) - b * (r1 * h - f * r2) + c * (r1 * f - e * r2)) * inv;
        let y = (a * (r1 * h - f * r2) - r0 * (b * h - c * f) + c * (b * r2 - r1 * c)) * inv;
        let z = (a * (e * r2 - r1 * f) - b * (b * r2 - r1 * c) + r0 * (b * f - e * c)) * inv;
        if x.is_finite() && y.is_finite() && z.is_finite() {
            Some([x, y, z])
        } else {
            None
        }
    }
}

struct Face {
    v: [u32; 3],
    alive: bool,
}

struct Simp {
    pos: Vec<[f64; 3]>,
    q: Vec<Quadric>,
    area: Vec<f64>,
    alive: Vec<bool>,
    faces: Vec<Face>,
    vf: Vec<Vec<u32>>,
    max_err_sq: f64,
}

struct Scratch {
    shared: Vec<u32>,
    incident: Vec<u32>,
    edges: Vec<u64>,
    cands: Vec<(u64, u32, u32)>,
    stamp: Vec<u32>,
    stamp_id: u32,
}

impl Scratch {
    fn new(nverts: usize) -> Self {
        Self {
            shared: Vec::with_capacity(4),
            incident: Vec::with_capacity(16),
            edges: Vec::new(),
            cands: Vec::new(),
            stamp: vec![0; nverts],
            stamp_id: 0,
        }
    }

    fn bump(&mut self) -> u32 {
        self.stamp_id = self.stamp_id.wrapping_add(1);
        if self.stamp_id == 0 {
            self.stamp.fill(0);
            self.stamp_id = 1;
        }
        self.stamp_id
    }
}

fn simplify_inner(mesh: &Mesh, max_error_mm: f64, job: Job) -> Result<Option<Mesh>, String> {
    if mesh.triangles.is_empty() {
        return Ok(None);
    }
    let mut simp = Simp::from_mesh(mesh, max_error_mm);
    if simp.faces.is_empty() {
        return Ok(None);
    }
    let mut scratch = Scratch::new(simp.pos.len());
    let mut collapses = 0usize;
    let limit = simp.pos.len();
    for _ in 0..48 {
        if job.cancelled() {
            return Err("cancelled".into());
        }
        let collapsed = simp.collapse_pass(&mut scratch, &mut collapses, limit, job)?;
        if collapsed == 0 || collapses >= limit {
            break;
        }
    }
    if collapses == 0 {
        return Ok(None);
    }
    let out = simp.to_mesh();
    if out.triangles.is_empty() {
        return Ok(None);
    }
    Ok(Some(out))
}

impl Simp {
    fn from_mesh(mesh: &Mesh, max_error_mm: f64) -> Self {
        let mut ids: HashMap<[u64; 3], u32> = HashMap::with_capacity(mesh.triangles.len() / 2 + 1);
        let mut pos = Vec::new();
        let mut raw_faces = Vec::with_capacity(mesh.triangles.len());
        for tri in &mesh.triangles {
            let mut face = [0u32; 3];
            for (slot, v) in face.iter_mut().zip(tri.iter()) {
                let key = [v[0].to_bits(), v[1].to_bits(), v[2].to_bits()];
                *slot = *ids.entry(key).or_insert_with(|| {
                    let id = pos.len() as u32;
                    pos.push(*v);
                    id
                });
            }
            if face[0] != face[1] && face[1] != face[2] && face[0] != face[2] {
                raw_faces.push(face);
            }
        }
        let n = pos.len();
        let mut vf = vec![Vec::new(); n];
        let mut faces = Vec::with_capacity(raw_faces.len());
        for (fi, v) in raw_faces.into_iter().enumerate() {
            for id in v {
                vf[id as usize].push(fi as u32);
            }
            faces.push(Face { v, alive: true });
        }
        let mut q = vec![Quadric::zero(); n];
        let mut area = vec![0.0; n];
        for face in &faces {
            let (normal, plane_d, face_area) = plane(&pos, face.v);
            if face_area < 1e-16 {
                continue;
            }
            let quad = Quadric::from_plane(normal, plane_d, face_area);
            for id in face.v {
                let i = id as usize;
                q[i] = q[i].add(quad);
                area[i] += face_area;
            }
        }
        add_boundary_quadrics(&pos, &faces, &mut q);
        Self {
            pos,
            q,
            area,
            alive: vec![true; n],
            faces,
            vf,
            max_err_sq: max_error_mm * max_error_mm,
        }
    }

    fn collapse_pass(
        &mut self,
        scratch: &mut Scratch,
        collapses: &mut usize,
        limit: usize,
        job: Job,
    ) -> Result<usize, String> {
        self.compact_refs();
        self.fill_candidates(scratch);
        if scratch.cands.is_empty() {
            return Ok(0);
        }
        scratch.cands.sort_unstable();
        let mut cands = std::mem::take(&mut scratch.cands);
        let mut collapsed = 0usize;
        for (i, &(_, u, v)) in cands.iter().enumerate() {
            if i % 8192 == 0 && job.cancelled() {
                return Err("cancelled".into());
            }
            if !self.alive[u as usize] || !self.alive[v as usize] {
                continue;
            }
            let Some((_, place)) = self.best(u, v, scratch) else {
                continue;
            };
            let (keep, dropv) = if u < v { (u, v) } else { (v, u) };
            scratch.incident.clear();
            scratch.incident.extend_from_slice(&self.vf[dropv as usize]);
            self.collapse(keep, dropv, place, &scratch.incident);
            collapsed += 1;
            *collapses += 1;
            if *collapses >= limit {
                break;
            }
            if *collapses % 1024 == 0 && job.cancelled() {
                return Err("cancelled".into());
            }
        }
        cands.clear();
        scratch.cands = cands;
        Ok(collapsed)
    }

    fn compact_refs(&mut self) {
        for (v, list) in self.vf.iter_mut().enumerate() {
            if !self.alive[v] {
                list.clear();
            } else {
                list.retain(|fi| self.faces[*fi as usize].alive);
            }
        }
    }

    fn fill_candidates(&self, scratch: &mut Scratch) {
        scratch.edges.clear();
        for face in &self.faces {
            if !face.alive {
                continue;
            }
            for (a, b) in [
                (face.v[0], face.v[1]),
                (face.v[1], face.v[2]),
                (face.v[2], face.v[0]),
            ] {
                let (u, v) = if a < b { (a, b) } else { (b, a) };
                scratch.edges.push(((u as u64) << 32) | v as u64);
            }
        }
        scratch.edges.sort_unstable();
        scratch.edges.dedup();
        scratch.cands.clear();
        scratch.cands.reserve(scratch.edges.len());
        for key in scratch.edges.iter().copied() {
            let u = (key >> 32) as u32;
            let v = key as u32;
            if let Some(err) = self.cheap(u, v) {
                let bits = if err <= 0.0 { 0 } else { err.to_bits() };
                scratch.cands.push((bits, u, v));
            }
        }
    }

    /// Quadric error of the best placement, ignoring topology. `None` when
    /// every placement already exceeds the bound, so the link test can be skipped.
    fn cheap(&self, u: u32, v: u32) -> Option<f64> {
        if !self.alive[u as usize] || !self.alive[v as usize] {
            return None;
        }
        let quad = self.q[u as usize].add(self.q[v as usize]);
        let weight = self.area[u as usize] + self.area[v as usize];
        if !weight.is_finite() || weight <= 1e-20 {
            return None;
        }
        let pu = self.pos[u as usize];
        let pv = self.pos[v as usize];
        let mid = [
            0.5 * (pu[0] + pv[0]),
            0.5 * (pu[1] + pv[1]),
            0.5 * (pu[2] + pv[2]),
        ];
        let edge = dist(pu, pv);
        if !edge.is_finite() || edge <= 1e-12 {
            return None;
        }
        let mut best = f64::MAX;
        for p in [mid, pu, pv] {
            if let Some((err, _)) = self.quadric_err(u, v, quad, weight, p) {
                if err < best {
                    best = err;
                }
            }
        }
        if best > self.max_err_sq {
            if let Some(p) = quad.solve() {
                if dist(p, mid) <= edge {
                    if let Some((err, _)) = self.quadric_err(u, v, quad, weight, p) {
                        if err < best {
                            best = err;
                        }
                    }
                }
            }
        }
        if best <= self.max_err_sq {
            Some(best)
        } else {
            None
        }
    }

    /// Lowest-error placement that stays inside the bound and keeps the link.
    fn best(&self, u: u32, v: u32, scratch: &mut Scratch) -> Option<(f64, [f64; 3])> {
        if !self.alive[u as usize] || !self.alive[v as usize] {
            return None;
        }
        let quad = self.q[u as usize].add(self.q[v as usize]);
        let weight = self.area[u as usize] + self.area[v as usize];
        if !weight.is_finite() || weight <= 1e-20 {
            return None;
        }
        let pu = self.pos[u as usize];
        let pv = self.pos[v as usize];
        let mid = [
            0.5 * (pu[0] + pv[0]),
            0.5 * (pu[1] + pv[1]),
            0.5 * (pu[2] + pv[2]),
        ];
        let edge = dist(pu, pv);
        if !edge.is_finite() || edge <= 1e-12 {
            return None;
        }
        let mut placed = [(0.0, [0.0; 3]); 4];
        let mut nplaced = 0usize;
        let mut consider = |p: [f64; 3]| {
            let Some(scored) = self.quadric_err(u, v, quad, weight, p) else {
                return;
            };
            placed[nplaced] = scored;
            nplaced += 1;
        };
        if let Some(p) = quad.solve() {
            if dist(p, mid) <= edge {
                consider(p);
            }
        }
        consider(mid);
        consider(pu);
        consider(pv);
        if nplaced == 0 || !self.link_ok(u, v, scratch) {
            return None;
        }
        let nshare = scratch.shared.len();
        let shared = [
            scratch.shared[0],
            scratch.shared.get(1).copied().unwrap_or(u32::MAX),
        ];
        let shared = &shared[..nshare];
        let mut best: Option<(f64, [f64; 3])> = None;
        for &(err, p) in &placed[..nplaced] {
            if self.deviates(u, v, shared, p) || self.flips(u, v, shared, p) {
                continue;
            }
            if best.is_none_or(|(cur, _)| err < cur) {
                best = Some((err, p));
            }
        }
        best
    }

    fn quadric_err(
        &self,
        u: u32,
        v: u32,
        quad: Quadric,
        weight: f64,
        mut p: [f64; 3],
    ) -> Option<(f64, [f64; 3])> {
        if !p[0].is_finite() || !p[1].is_finite() || !p[2].is_finite() {
            return None;
        }
        let zu = self.pos[u as usize][2];
        let zv = self.pos[v as usize][2];
        if on_bed(zu) && on_bed(zv) {
            p[2] = 0.0;
        }
        if p[2] < -1e-6 || ((on_bed(zu) || on_bed(zv)) && p[2] > 1e-4) {
            return None;
        }
        let mut err = quad.eval(p) / weight;
        if !err.is_finite() {
            return None;
        }
        if err < 0.0 {
            if err > -1e-8 {
                err = 0.0;
            } else {
                return None;
            }
        }
        if err > self.max_err_sq {
            return None;
        }
        Some((err, p))
    }

    fn deviates(&self, u: u32, v: u32, shared: &[u32], p: [f64; 3]) -> bool {
        for id in [u, v] {
            for &fi in &self.vf[id as usize] {
                if !self.faces[fi as usize].alive || shared.contains(&fi) {
                    continue;
                }
                if plane_exceeds(&self.pos, self.faces[fi as usize].v, p, self.max_err_sq) {
                    return true;
                }
            }
        }
        shared
            .iter()
            .any(|fi| plane_exceeds(&self.pos, self.faces[*fi as usize].v, p, self.max_err_sq))
    }

    fn flips(&self, u: u32, v: u32, shared: &[u32], p: [f64; 3]) -> bool {
        for id in [u, v] {
            for &fi in &self.vf[id as usize] {
                let face = &self.faces[fi as usize];
                if !face.alive || shared.contains(&fi) {
                    continue;
                }
                let old = face_cross(&self.pos, face.v, None);
                let new = face_cross(&self.pos, face.v, Some((u, v, p)));
                let dot = old[0] * new[0] + old[1] * new[1] + old[2] * new[2];
                let new_len2 = new[0] * new[0] + new[1] * new[1] + new[2] * new[2];
                if new_len2 < 1e-20 || dot <= 0.0 {
                    return true;
                }
            }
        }
        false
    }

    fn fill_shared(&self, u: u32, v: u32, out: &mut Vec<u32>) {
        out.clear();
        let small = if self.vf[u as usize].len() <= self.vf[v as usize].len() {
            u
        } else {
            v
        };
        for &fi in &self.vf[small as usize] {
            let face = &self.faces[fi as usize];
            if face.alive && face.v.contains(&u) && face.v.contains(&v) {
                out.push(fi);
                if out.len() > 2 {
                    return;
                }
            }
        }
    }

    fn link_ok(&self, u: u32, v: u32, scratch: &mut Scratch) -> bool {
        self.fill_shared(u, v, &mut scratch.shared);
        let nshare = scratch.shared.len();
        if nshare == 0 || nshare > 2 {
            return false;
        }
        let mut opp = [0u32; 2];
        let mut nopp = 0usize;
        for &fi in &scratch.shared {
            for w in self.faces[fi as usize].v {
                if w != u && w != v && opp[..nopp].iter().all(|other| *other != w) {
                    if nopp == 2 {
                        return false;
                    }
                    opp[nopp] = w;
                    nopp += 1;
                }
            }
        }
        if nopp != nshare {
            return false;
        }
        let sid_u = scratch.bump();
        self.stamp_neighbors(u, sid_u, scratch);
        let sid_seen = scratch.bump();
        let mut inter = 0usize;
        for &fi in &self.vf[v as usize] {
            let face = &self.faces[fi as usize];
            if !face.alive {
                continue;
            }
            for w in face.v {
                if w == v || w == u || !self.alive[w as usize] {
                    continue;
                }
                let wi = w as usize;
                if scratch.stamp[wi] == sid_seen {
                    continue;
                }
                let touches_u = scratch.stamp[wi] == sid_u;
                scratch.stamp[wi] = sid_seen;
                if touches_u {
                    inter += 1;
                    if opp[..nopp].iter().all(|other| *other != w) {
                        return false;
                    }
                }
            }
        }
        inter == nopp
    }

    fn stamp_neighbors(&self, v: u32, sid: u32, scratch: &mut Scratch) {
        if !self.alive[v as usize] {
            return;
        }
        for &fi in &self.vf[v as usize] {
            let face = &self.faces[fi as usize];
            if !face.alive {
                continue;
            }
            for w in face.v {
                if w != v && self.alive[w as usize] {
                    scratch.stamp[w as usize] = sid;
                }
            }
        }
    }

    fn collapse(&mut self, keep: u32, drop: u32, p: [f64; 3], incident: &[u32]) {
        for &fi in incident {
            let face = &mut self.faces[fi as usize];
            if !face.alive {
                continue;
            }
            if face.v.contains(&keep) {
                face.alive = false;
                continue;
            }
            for slot in &mut face.v {
                if *slot == drop {
                    *slot = keep;
                }
            }
            if face.v[0] == face.v[1] || face.v[1] == face.v[2] || face.v[0] == face.v[2] {
                face.alive = false;
                continue;
            }
            self.vf[keep as usize].push(fi);
        }
        self.vf[drop as usize].clear();
        self.alive[drop as usize] = false;
        self.pos[keep as usize] = p;
        self.q[keep as usize] = self.q[keep as usize].add(self.q[drop as usize]);
        self.area[keep as usize] += self.area[drop as usize];
        self.vf[keep as usize].retain(|fi| self.faces[*fi as usize].alive);
        self.vf[keep as usize].sort_unstable();
        self.vf[keep as usize].dedup();
    }

    fn to_mesh(&self) -> Mesh {
        let mut triangles = Vec::new();
        for face in &self.faces {
            if !face.alive {
                continue;
            }
            let tri = face.v.map(|id| self.pos[id as usize]);
            if !degenerate(&tri) {
                triangles.push(tri);
            }
        }
        Mesh { triangles }
    }
}

fn add_boundary_quadrics(pos: &[[f64; 3]], faces: &[Face], q: &mut [Quadric]) {
    let mut uses: HashMap<u64, (u32, u32)> = HashMap::with_capacity(faces.len() * 2);
    for (fi, face) in faces.iter().enumerate() {
        for (a, b) in [
            (face.v[0], face.v[1]),
            (face.v[1], face.v[2]),
            (face.v[2], face.v[0]),
        ] {
            let (lo, hi) = if a < b { (a, b) } else { (b, a) };
            let key = ((lo as u64) << 32) | hi as u64;
            uses.entry(key)
                .and_modify(|(count, _)| *count += 1)
                .or_insert((1, fi as u32));
        }
    }
    for (key, (count, fi)) in uses {
        if count != 1 {
            continue;
        }
        let lo = (key >> 32) as u32;
        let hi = key as u32;
        let face = &faces[fi as usize];
        let (normal, _, _) = plane(pos, face.v);
        let edge = [
            pos[hi as usize][0] - pos[lo as usize][0],
            pos[hi as usize][1] - pos[lo as usize][1],
            pos[hi as usize][2] - pos[lo as usize][2],
        ];
        let mut n = cross(edge, normal);
        let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        if len < 1e-12 {
            continue;
        }
        n = [n[0] / len, n[1] / len, n[2] / len];
        let d =
            -(n[0] * pos[lo as usize][0] + n[1] * pos[lo as usize][1] + n[2] * pos[lo as usize][2]);
        let weight = len * len;
        let quad = Quadric::from_plane(n, d, weight);
        q[lo as usize] = q[lo as usize].add(quad);
        q[hi as usize] = q[hi as usize].add(quad);
    }
}

fn plane(pos: &[[f64; 3]], v: [u32; 3]) -> ([f64; 3], f64, f64) {
    let a = pos[v[0] as usize];
    let b = pos[v[1] as usize];
    let c = pos[v[2] as usize];
    let n = cross(sub(b, a), sub(c, a));
    let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
    if len < 1e-16 {
        return ([0.0, 0.0, 1.0], 0.0, 0.0);
    }
    let normal = [n[0] / len, n[1] / len, n[2] / len];
    let d = -(normal[0] * a[0] + normal[1] * a[1] + normal[2] * a[2]);
    (normal, d, 0.5 * len)
}

fn plane_exceeds(pos: &[[f64; 3]], v: [u32; 3], p: [f64; 3], max_err_sq: f64) -> bool {
    let a = pos[v[0] as usize];
    let n = cross(sub(pos[v[1] as usize], a), sub(pos[v[2] as usize], a));
    let len2 = n[0] * n[0] + n[1] * n[1] + n[2] * n[2];
    if len2 < 1e-32 {
        return false;
    }
    let d = n[0] * (p[0] - a[0]) + n[1] * (p[1] - a[1]) + n[2] * (p[2] - a[2]);
    d * d > max_err_sq * len2
}

fn face_cross(pos: &[[f64; 3]], v: [u32; 3], moved: Option<(u32, u32, [f64; 3])>) -> [f64; 3] {
    let at = |id: u32| -> [f64; 3] {
        if let Some((u, v, p)) = moved {
            if id == u || id == v {
                return p;
            }
        }
        pos[id as usize]
    };
    cross(sub(at(v[1]), at(v[0])), sub(at(v[2]), at(v[0])))
}

fn on_bed(z: f64) -> bool {
    z <= 1e-4
}

fn degenerate(tri: &[[f64; 3]; 3]) -> bool {
    let n = cross(sub(tri[1], tri[0]), sub(tri[2], tri[0]));
    n[0] * n[0] + n[1] * n[1] + n[2] * n[2] < 1e-16
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn dist(a: [f64; 3], b: [f64; 3]) -> f64 {
    let d = sub(a, b);
    (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt()
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn cube() -> Mesh {
        let s = 20.0;
        let v = [
            [0.0, 0.0, 0.0],
            [s, 0.0, 0.0],
            [s, s, 0.0],
            [0.0, s, 0.0],
            [0.0, 0.0, s],
            [s, 0.0, s],
            [s, s, s],
            [0.0, s, s],
        ];
        let faces = [
            (0, 2, 1),
            (0, 3, 2),
            (4, 5, 6),
            (4, 6, 7),
            (0, 1, 5),
            (0, 5, 4),
            (3, 7, 6),
            (3, 6, 2),
            (0, 4, 7),
            (0, 7, 3),
            (1, 2, 6),
            (1, 6, 5),
        ];
        Mesh {
            triangles: faces.map(|(i, j, k)| [v[i], v[j], v[k]]).to_vec(),
        }
    }

    fn subdivide(mesh: &Mesh, times: usize) -> Mesh {
        let mut mesh = mesh.clone();
        for _ in 0..times {
            let mut next = Vec::with_capacity(mesh.triangles.len() * 4);
            for tri in &mesh.triangles {
                let m01 = mid(tri[0], tri[1]);
                let m12 = mid(tri[1], tri[2]);
                let m20 = mid(tri[2], tri[0]);
                next.push([tri[0], m01, m20]);
                next.push([m01, tri[1], m12]);
                next.push([m20, m12, tri[2]]);
                next.push([m01, m12, m20]);
            }
            mesh.triangles = next;
        }
        mesh
    }

    fn mid(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
        [
            0.5 * (a[0] + b[0]),
            0.5 * (a[1] + b[1]),
            0.5 * (a[2] + b[2]),
        ]
    }

    fn volume(mesh: &Mesh) -> f64 {
        mesh.triangles
            .iter()
            .map(|[a, b, c]| {
                (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0])
                    + a[2] * (b[0] * c[1] - b[1] * c[0]))
                    / 6.0
            })
            .sum::<f64>()
            .abs()
    }

    fn open_edges(mesh: &Mesh) -> usize {
        let mut ids: HashMap<[u64; 3], u32> = HashMap::new();
        let mut next = 0u32;
        let mut uses: HashMap<(u32, u32), u32> = HashMap::new();
        for tri in &mesh.triangles {
            let mut face = [0u32; 3];
            for (slot, v) in face.iter_mut().zip(tri.iter()) {
                let bits = [v[0].to_bits(), v[1].to_bits(), v[2].to_bits()];
                *slot = *ids.entry(bits).or_insert_with(|| {
                    let id = next;
                    next += 1;
                    id
                });
            }
            if face[0] == face[1] || face[1] == face[2] || face[0] == face[2] {
                continue;
            }
            for (a, b) in [(face[0], face[1]), (face[1], face[2]), (face[2], face[0])] {
                let key = if a < b { (a, b) } else { (b, a) };
                *uses.entry(key).or_default() += 1;
            }
        }
        uses.values().filter(|count| **count == 1).count()
    }

    #[test]
    fn nozzle_error_is_half_the_smaller_of_nozzle_and_layer() {
        assert!((nozzle_error_mm(0.4, 0.2) - 0.1).abs() < 1e-12);
        assert!((nozzle_error_mm(0.4, 0.08) - 0.04).abs() < 1e-12);
        assert!((nozzle_error_mm(0.6, 0.3) - 0.15).abs() < 1e-12);
        assert!((nozzle_error_mm(0.0, 0.0) - 0.1).abs() < 1e-12);
    }

    #[test]
    fn coarse_cube_is_not_rebuilt() {
        let mesh = cube();
        let (cow, stats) = simplify_for_nozzle(&mesh, true, 0.1, Job::default()).unwrap();
        assert_eq!(stats.source_triangles, 12);
        assert_eq!(stats.triangles, 12);
        assert!(matches!(cow, Cow::Borrowed(_)));
    }

    #[test]
    fn subdivided_cube_collapses_back_to_its_corners() {
        let dense = subdivide(&cube(), 4);
        assert!(dense.triangle_count() > 1_000);
        let out = simplify_mesh(&dense, 0.1).unwrap();
        assert!(
            out.triangle_count() <= 12,
            "collapsed to {} triangles",
            out.triangle_count()
        );
        assert_eq!(open_edges(&out), 0);
        let corners = [
            [0.0, 0.0, 0.0],
            [20.0, 0.0, 0.0],
            [20.0, 20.0, 0.0],
            [0.0, 20.0, 0.0],
            [0.0, 0.0, 20.0],
            [20.0, 0.0, 20.0],
            [20.0, 20.0, 20.0],
            [0.0, 20.0, 20.0],
        ];
        for corner in corners {
            assert!(
                out.triangles
                    .iter()
                    .flatten()
                    .any(|v| dist(*v, corner) < 1e-6),
                "lost corner {corner:?}"
            );
        }
        assert!((volume(&out) - 8000.0).abs() < 1e-3);
        let (min, _) = out.bounds().unwrap();
        assert!(min[2].abs() < 1e-6, "bed contact lifted to {}", min[2]);
    }

    #[test]
    fn thin_box_keeps_its_thickness() {
        let mut triangles = Vec::new();
        let (x0, x1, y0, y1, z0, z1) = (0.0, 0.7, 0.0, 12.0, 0.0, 10.0);
        let v = [
            [x0, y0, z0],
            [x1, y0, z0],
            [x1, y1, z0],
            [x0, y1, z0],
            [x0, y0, z1],
            [x1, y0, z1],
            [x1, y1, z1],
            [x0, y1, z1],
        ];
        for (i, j, k) in [
            (0, 2, 1),
            (0, 3, 2),
            (4, 5, 6),
            (4, 6, 7),
            (0, 1, 5),
            (0, 5, 4),
            (3, 7, 6),
            (3, 6, 2),
            (0, 4, 7),
            (0, 7, 3),
            (1, 2, 6),
            (1, 6, 5),
        ] {
            triangles.push([v[i], v[j], v[k]]);
        }
        let dense = subdivide(&Mesh { triangles }, 4);
        let out = simplify_mesh(&dense, nozzle_error_mm(0.4, 0.2)).unwrap();
        let xs = out.triangles.iter().flat_map(|t| t.iter()).map(|p| p[0]);
        let (mut lo, mut hi) = (f64::MAX, f64::MIN);
        for x in xs {
            lo = lo.min(x);
            hi = hi.max(x);
        }
        let thick = hi - lo;
        assert!(
            (thick - 0.7).abs() < 0.05,
            "0.7 mm wall became {thick:.3} mm ({lo:.3}..{hi:.3})"
        );
        assert_eq!(open_edges(&out), 0);
        assert!((volume(&out) - 0.7 * 12.0 * 10.0).abs() < 0.05);
    }

    fn sphere(stacks: usize, slices: usize, radius: f64) -> Mesh {
        let mut verts = vec![[0.0, 0.0, radius * 2.0]];
        for i in 1..stacks {
            let phi = std::f64::consts::PI * i as f64 / stacks as f64;
            let z = radius * phi.cos() + radius;
            let rr = radius * phi.sin();
            for j in 0..slices {
                let th = std::f64::consts::TAU * j as f64 / slices as f64;
                verts.push([rr * th.cos(), rr * th.sin(), z]);
            }
        }
        let south = verts.len();
        verts.push([0.0, 0.0, 0.0]);
        let at = |i: usize, j: usize| 1 + (i - 1) * slices + (j % slices);
        let mut triangles = Vec::new();
        for j in 0..slices {
            triangles.push([verts[0], verts[at(1, j)], verts[at(1, j + 1)]]);
        }
        for i in 1..stacks - 1 {
            for j in 0..slices {
                let a = at(i, j);
                let b = at(i, j + 1);
                let c = at(i + 1, j + 1);
                let d = at(i + 1, j);
                triangles.push([verts[a], verts[b], verts[c]]);
                triangles.push([verts[a], verts[c], verts[d]]);
            }
        }
        for j in 0..slices {
            triangles.push([
                verts[at(stacks - 1, j + 1)],
                verts[at(stacks - 1, j)],
                verts[south],
            ]);
        }
        Mesh { triangles }
    }

    #[test]
    fn sphere_drops_triangles_and_keeps_volume() {
        let mesh = sphere(48, 48, 15.0);
        let before = mesh.triangle_count();
        assert_eq!(open_edges(&mesh), 0, "sphere input is open");
        let out = simplify_mesh(&mesh, 0.1).unwrap();
        assert!(
            out.triangle_count() * 4 < before,
            "{} → {}",
            before,
            out.triangle_count()
        );
        assert_eq!(open_edges(&out), 0);
        let want = 4.0 / 3.0 * std::f64::consts::PI * 15.0_f64.powi(3);
        assert!(
            (volume(&out) - want).abs() / want < 0.01,
            "volume {} vs {want}",
            volume(&out)
        );
        let (min, _) = out.bounds().unwrap();
        assert!(min[2] > -0.1 && min[2] < 0.15, "bed z {}", min[2]);
    }

    #[test]
    #[ignore = "release timing of a dense sphere"]
    fn time_large_sphere() {
        for (stacks, slices) in [(100, 120), (200, 250), (320, 400), (450, 500)] {
            let mesh = sphere(stacks, slices, 30.0);
            let started = Instant::now();
            let out = simplify_mesh(&mesh, 0.1).unwrap();
            eprintln!(
                "sphere {stacks}x{slices}  {} → {}  {:.1} ms  open {}",
                mesh.triangle_count(),
                out.triangle_count(),
                millis(started),
                open_edges(&out)
            );
        }
    }
}
