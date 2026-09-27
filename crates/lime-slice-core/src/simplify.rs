//! Quadric edge collapse limited by what the nozzle can reproduce.
//!
//! The bound is half the smaller of nozzle diameter and layer height, in
//! print-space millimetres. Scale has to be in the vertex positions before
//! collapse, because the bound is an absolute distance. A rigid pose
//! (rotation, bed settle, translation) does not change that distance, so it
//! is applied after collapse and is not part of the cache key. A 0.4 mm
//! nozzle and a 0.2 mm layer give 0.10 mm, which is 0.25 × the nozzle. That
//! sits at the tight end of the usual 0.25–0.5 × nozzle band so a 0.7 mm fin
//! and a sharp overhang edge are not eaten. Area-weighted plane quadrics
//! choose the new vertex; a collapse is kept only when the area-weighted RMS
//! distance to the original planes, and the distance to every touched current
//! plane, stay inside that bound. Edges with anything other than one or two
//! faces are left alone, and the link condition keeps a manifold edge manifold.
//! Candidates are rebuilt each pass and collapsed smallest-error first, so a
//! rejected edge is not scored again until the surface around it changes.
//!
//! # Cache
//!
//! [`simplify_for_nozzle`] keeps the collapsed mesh for a fingerprint of the
//! source triangles. A stored result is reused when
//! [`cached_bound_covers`] says its guaranteed error still fits the new
//! budget:
//!
//! `stored <= requested * (1 + SIMPLIFY_CACHE_REL_EPS) + SIMPLIFY_CACHE_ABS_EPS_MM`
//!
//! A looser nozzle (larger budget) always reuses a finer mesh. A slightly
//! tighter budget reuses it too. A meaningfully tighter budget collapses
//! again and replaces the entry. The entry is also written under
//! `$LIME_SLICE_SIMPLIFY_CACHE`, or `$XDG_CACHE_HOME/lime-slice/simplify`
//! (`~/.cache/lime-slice/simplify` when `XDG_CACHE_HOME` is unset), so a
//! later process can load it. `LIME_SLICE_SIMPLIFY_CACHE=off` keeps the
//! cache in memory only. Meshes under [`SIMPLIFY_MIN_TRIANGLES`] never
//! enter the cache.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use crate::cancel::Job;
use crate::mesh::Mesh;

/// Checked-in samples other than Dragon 2.5 are at or under the hull's 4800
/// triangles. Contouring those is already cheap, and rebuilding them would
/// move G-code on meshes the nozzle can already trace. Denser meshes are collapsed.
pub const SIMPLIFY_MIN_TRIANGLES: usize = 8_000;

/// Relative slack on a cached error bound. Five percent of the current budget.
pub const SIMPLIFY_CACHE_REL_EPS: f64 = 0.05;

/// Absolute slack on a cached error bound, in millimetres.
///
/// 0.01 mm is 1/40 of a 0.4 mm nozzle. A layer-height nudge from 0.20 mm to
/// 0.18 mm (bound 0.10 → 0.09) stays inside this slack. 0.16 mm (bound 0.08)
/// does not.
pub const SIMPLIFY_CACHE_ABS_EPS_MM: f64 = 0.01;

/// Bump when the collapse changes enough that an old file must not be reused.
const SIMPLIFY_CACHE_VERSION: u32 = 1;

const CACHE_MAGIC: &[u8; 8] = b"LMSCACH1";

#[derive(Clone, Copy, Debug)]
pub struct SimplifyStats {
    pub source_triangles: usize,
    pub triangles: usize,
    pub error_mm: f64,
    /// `true` when the mesh was loaded from the in-memory or on-disk cache.
    /// [`SimplifyStats::milliseconds`] is then the lookup time, not the collapse.
    pub cached: bool,
    pub milliseconds: f64,
}

/// `stored_mm` is the error the cached mesh was collapsed under.
/// `requested_mm` is the budget for this slice.
pub fn cached_bound_covers(stored_mm: f64, requested_mm: f64) -> bool {
    if !stored_mm.is_finite()
        || !requested_mm.is_finite()
        || requested_mm <= 0.0
        || stored_mm <= 0.0
    {
        return false;
    }
    stored_mm <= requested_mm * (1.0 + SIMPLIFY_CACHE_REL_EPS) + SIMPLIFY_CACHE_ABS_EPS_MM
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
///
/// A hit returns an owned copy of the cached mesh and sets
/// [`SimplifyStats::cached`]. The borrowed mesh is the input when nothing
/// was collapsed and the cache was not used (disabled, or under
/// [`SIMPLIFY_MIN_TRIANGLES`]).
pub fn simplify_for_nozzle<'a>(
    mesh: &'a Mesh,
    enabled: bool,
    error_mm: f64,
    job: Job,
) -> Result<(Cow<'a, Mesh>, SimplifyStats), String> {
    shared_cache().simplify(mesh, enabled, error_mm, job)
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

fn shared_cache() -> &'static SimplifyCache {
    static CACHE: OnceLock<SimplifyCache> = OnceLock::new();
    CACHE.get_or_init(SimplifyCache::from_env)
}

struct CacheEntry {
    error_mm: f64,
    source_triangles: usize,
    mesh: Mesh,
}

struct CacheInner {
    entries: HashMap<[u64; 2], Arc<CacheEntry>>,
    inflight: HashSet<[u64; 2]>,
}

struct SimplifyCache {
    dir: Option<PathBuf>,
    inner: Mutex<CacheInner>,
    ready: Condvar,
}

struct Inflight<'a> {
    cache: &'a SimplifyCache,
    key: [u64; 2],
}

impl Drop for Inflight<'_> {
    fn drop(&mut self) {
        let mut guard = self.cache.lock();
        guard.inflight.remove(&self.key);
        self.cache.ready.notify_all();
    }
}

impl SimplifyCache {
    fn from_env() -> Self {
        let dir = match std::env::var("LIME_SLICE_SIMPLIFY_CACHE") {
            Ok(value) if value.is_empty() || value == "off" || value == "0" => None,
            Ok(value) => Some(PathBuf::from(value)),
            Err(_) => default_cache_dir(),
        };
        Self::open(dir)
    }

    fn open(dir: Option<PathBuf>) -> Self {
        Self {
            dir,
            inner: Mutex::new(CacheInner {
                entries: HashMap::new(),
                inflight: HashSet::new(),
            }),
            ready: Condvar::new(),
        }
    }

    fn lock(&self) -> MutexGuard<'_, CacheInner> {
        self.inner.lock().unwrap_or_else(|err| err.into_inner())
    }

    fn simplify<'a>(
        &self,
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
                    cached: false,
                    milliseconds: millis(started),
                },
            ));
        }
        let key = fingerprint(mesh);
        loop {
            if job.cancelled() {
                return Err("cancelled".into());
            }
            if let Some(hit) = self.lookup(key, source, error_mm) {
                return Ok(hit_stats(hit, source, started));
            }
            let Some(flight) = self.try_claim(key) else {
                self.wait_while_inflight(key, job)?;
                continue;
            };
            if let Some(hit) = self.lookup(key, source, error_mm) {
                drop(flight);
                return Ok(hit_stats(hit, source, started));
            }
            let simplified = match simplify_inner(mesh, error_mm, job) {
                Ok(Some(collapsed)) => collapsed,
                Ok(None) => mesh.clone(),
                Err(err) => return Err(err),
            };
            let entry = Arc::new(CacheEntry {
                error_mm,
                source_triangles: source,
                mesh: simplified.clone(),
            });
            self.remember(key, &entry);
            let triangles = simplified.triangle_count();
            drop(flight);
            return Ok((
                Cow::Owned(simplified),
                SimplifyStats {
                    source_triangles: source,
                    triangles,
                    error_mm,
                    cached: false,
                    milliseconds: millis(started),
                },
            ));
        }
    }

    fn lookup(&self, key: [u64; 2], source: usize, requested: f64) -> Option<Arc<CacheEntry>> {
        if let Some(hit) = self.memory(key) {
            if hit.source_triangles == source && cached_bound_covers(hit.error_mm, requested) {
                return Some(hit);
            }
        }
        let disk = self.read_disk(key)?;
        if disk.source_triangles != source || !cached_bound_covers(disk.error_mm, requested) {
            return None;
        }
        let hit = Arc::new(disk);
        self.remember(key, &hit);
        Some(hit)
    }

    fn memory(&self, key: [u64; 2]) -> Option<Arc<CacheEntry>> {
        self.lock().entries.get(&key).cloned()
    }

    /// Keep the finer guarantee when two budgets share one source mesh.
    fn remember(&self, key: [u64; 2], entry: &Arc<CacheEntry>) {
        let mut replace = true;
        {
            let mut guard = self.lock();
            if let Some(old) = guard.entries.get(&key) {
                if old.error_mm <= entry.error_mm + 1e-12 {
                    replace = false;
                }
            }
            if replace {
                guard.entries.insert(key, Arc::clone(entry));
            }
        }
        if replace {
            self.write_disk(key, entry);
        }
    }

    fn try_claim(&self, key: [u64; 2]) -> Option<Inflight<'_>> {
        let mut guard = self.lock();
        if guard.inflight.contains(&key) {
            return None;
        }
        guard.inflight.insert(key);
        drop(guard);
        Some(Inflight { cache: self, key })
    }

    fn wait_while_inflight(&self, key: [u64; 2], job: Job) -> Result<(), String> {
        let mut guard = self.lock();
        while guard.inflight.contains(&key) {
            if job.cancelled() {
                return Err("cancelled".into());
            }
            let (next, _) = self
                .ready
                .wait_timeout(guard, Duration::from_millis(200))
                .unwrap_or_else(|err| err.into_inner());
            guard = next;
        }
        Ok(())
    }

    fn read_disk(&self, key: [u64; 2]) -> Option<CacheEntry> {
        let path = self.path(key)?;
        let bytes = std::fs::read(path).ok()?;
        decode_cache(&bytes)
    }

    fn write_disk(&self, key: [u64; 2], entry: &CacheEntry) {
        let Some(dir) = &self.dir else {
            return;
        };
        if std::fs::create_dir_all(dir).is_err() {
            return;
        }
        let path = dir.join(cache_name(key));
        if let Some(existing) = std::fs::read(&path).ok().as_deref().and_then(decode_cache) {
            if existing.error_mm <= entry.error_mm + 1e-12 {
                return;
            }
        }
        let tmp = dir.join(format!(".{}.tmp", cache_name(key)));
        if std::fs::write(&tmp, encode_cache(entry)).is_err() {
            let _ = std::fs::remove_file(&tmp);
            return;
        }
        if std::fs::rename(&tmp, &path).is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
    }

    fn path(&self, key: [u64; 2]) -> Option<PathBuf> {
        self.dir.as_ref().map(|dir| dir.join(cache_name(key)))
    }
}

fn hit_stats<'a>(
    hit: Arc<CacheEntry>,
    source: usize,
    started: Instant,
) -> (Cow<'a, Mesh>, SimplifyStats) {
    let triangles = hit.mesh.triangle_count();
    let error_mm = hit.error_mm;
    (
        Cow::Owned(hit.mesh.clone()),
        SimplifyStats {
            source_triangles: source,
            triangles,
            error_mm,
            cached: true,
            milliseconds: millis(started),
        },
    )
}

fn default_cache_dir() -> Option<PathBuf> {
    if let Some(xdg) = std::env::var_os("XDG_CACHE_HOME").filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(xdg).join("lime-slice").join("simplify"));
    }
    if let Some(home) = std::env::var_os("HOME").filter(|value| !value.is_empty()) {
        return Some(
            PathBuf::from(home)
                .join(".cache")
                .join("lime-slice")
                .join("simplify"),
        );
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA").filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(local).join("lime-slice").join("simplify"));
    }
    None
}

fn cache_name(key: [u64; 2]) -> String {
    format!("{:016x}{:016x}.lscache", key[0], key[1])
}

/// Two independent 64-bit fingerprints. The file name is this pair, so a
/// different source mesh (or a different scale baked into the vertices)
/// cannot read this entry.
fn fingerprint(mesh: &Mesh) -> [u64; 2] {
    let mut a: u64 = 0xcbf2_9ce4_8422_2325;
    let mut b: u64 = 0x8422_2325_cbf2_9ce4;
    let count = mesh.triangles.len() as u64;
    a = fnv(a, count);
    b = fnv(b, count.rotate_left(17));
    for tri in &mesh.triangles {
        for vertex in tri {
            for coord in vertex {
                let bits = coord.to_bits();
                a = fnv(a, bits);
                b = fnv(b, bits.rotate_left(23) ^ 0x9e37_79b9_7f4a_7c15);
            }
        }
    }
    [a, b]
}

fn fnv(hash: u64, bits: u64) -> u64 {
    hash.wrapping_mul(0x100_0000_01b3) ^ bits
}

fn encode_cache(entry: &CacheEntry) -> Vec<u8> {
    let count = entry.mesh.triangles.len() as u64;
    let mut bytes = Vec::with_capacity(40 + entry.mesh.triangles.len() * 9 * 8);
    bytes.extend_from_slice(CACHE_MAGIC);
    bytes.extend_from_slice(&SIMPLIFY_CACHE_VERSION.to_le_bytes());
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes.extend_from_slice(&entry.error_mm.to_le_bytes());
    bytes.extend_from_slice(&(entry.source_triangles as u64).to_le_bytes());
    bytes.extend_from_slice(&count.to_le_bytes());
    for tri in &entry.mesh.triangles {
        for vertex in tri {
            for coord in vertex {
                bytes.extend_from_slice(&coord.to_le_bytes());
            }
        }
    }
    bytes
}

fn decode_cache(bytes: &[u8]) -> Option<CacheEntry> {
    if bytes.len() < 40 || &bytes[0..8] != CACHE_MAGIC {
        return None;
    }
    let version = u32::from_le_bytes(bytes[8..12].try_into().ok()?);
    if version != SIMPLIFY_CACHE_VERSION {
        return None;
    }
    let error_mm = f64::from_le_bytes(bytes[16..24].try_into().ok()?);
    let source_triangles = u64::from_le_bytes(bytes[24..32].try_into().ok()?) as usize;
    let count = u64::from_le_bytes(bytes[32..40].try_into().ok()?) as usize;
    if count > 20_000_000 || !error_mm.is_finite() || error_mm <= 0.0 {
        return None;
    }
    let body = bytes.get(40..)?;
    if body.len() != count * 9 * 8 {
        return None;
    }
    let mut triangles = Vec::with_capacity(count);
    for chunk in body.chunks_exact(9 * 8) {
        let mut face = [[0.0; 3]; 3];
        for (vertex, raw) in face.iter_mut().zip(chunk.chunks_exact(3 * 8)) {
            for (coord, bytes) in vertex.iter_mut().zip(raw.chunks_exact(8)) {
                let value = f64::from_le_bytes(bytes.try_into().ok()?);
                if !value.is_finite() {
                    return None;
                }
                *coord = value;
            }
        }
        triangles.push(face);
    }
    Some(CacheEntry {
        error_mm,
        source_triangles,
        mesh: Mesh { triangles },
    })
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
    fn cached_bound_slack_matches_the_documented_nozzle_steps() {
        assert!(cached_bound_covers(0.10, 0.10));
        assert!(
            cached_bound_covers(0.10, 0.15),
            "a looser nozzle must reuse"
        );
        assert!(
            cached_bound_covers(0.10, 0.09),
            "0.18 mm layer stays inside the slack"
        );
        assert!(
            !cached_bound_covers(0.10, 0.08),
            "0.16 mm layer is a real tightening"
        );
        assert!(!cached_bound_covers(0.10, 0.05));
        assert!(!cached_bound_covers(0.10, 0.0));
        assert!(!cached_bound_covers(0.0, 0.10));
    }

    #[test]
    fn simplify_cache_reuses_pose_scale_and_close_nozzle_bounds() {
        let dir = std::env::temp_dir().join(format!(
            "lime-slice-simplify-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let dense = subdivide(&cube(), 5);
        assert!(dense.triangle_count() >= SIMPLIFY_MIN_TRIANGLES);

        let cache = SimplifyCache::open(Some(dir.clone()));
        let coarse = cube();
        let (_, skipped) = cache.simplify(&coarse, true, 0.1, Job::default()).unwrap();
        assert!(!skipped.cached);
        assert_eq!(skipped.triangles, 12);
        assert!(
            std::fs::read_dir(&dir).unwrap().next().is_none(),
            "a coarse mesh was written to the cache"
        );

        let (collapsed, first) = cache.simplify(&dense, true, 0.10, Job::default()).unwrap();
        assert!(!first.cached, "fresh cache should miss");
        assert!(first.triangles < dense.triangle_count());
        assert!(first.milliseconds > 0.0, "miss took no time");

        let spun = collapsed.rigid_move(
            &[0.0, -1.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0],
            [10.0, 10.0, 10.0],
            [110.0, 10.0, 10.0],
        );
        let (_, rotated) = cache.simplify(&dense, true, 0.10, Job::default()).unwrap();
        assert!(
            rotated.cached,
            "rotation of the same canonical mesh rebuilt it"
        );
        assert!(
            rotated.milliseconds < first.milliseconds,
            "miss {:.2} ms, rotate hit {:.2} ms",
            first.milliseconds,
            rotated.milliseconds
        );
        assert_eq!(rotated.triangles, first.triangles);
        assert_eq!(spun.triangle_count(), collapsed.triangle_count());
        let (min_src, _) = collapsed.bounds().unwrap();
        let (min_spun, _) = spun.bounds().unwrap();
        assert!(
            (min_spun[0] - min_src[0]).abs() > 50.0,
            "pose did not move the cached mesh"
        );

        let (_, looser) = cache.simplify(&dense, true, 0.12, Job::default()).unwrap();
        assert!(looser.cached, "looser bound rebuilt");
        assert!((looser.error_mm - 0.10).abs() < 1e-9);

        let (_, close) = cache.simplify(&dense, true, 0.09, Job::default()).unwrap();
        assert!(close.cached, "close tighter bound rebuilt");
        assert!((close.error_mm - 0.10).abs() < 1e-9);
        assert!(close.milliseconds < first.milliseconds);

        let (tighter, strict) = cache.simplify(&dense, true, 0.05, Job::default()).unwrap();
        assert!(
            !strict.cached,
            "meaningfully tighter bound reused a coarse mesh"
        );
        assert!((strict.error_mm - 0.05).abs() < 1e-9);
        assert!(strict.milliseconds > close.milliseconds);

        let (_, back) = cache.simplify(&dense, true, 0.10, Job::default()).unwrap();
        assert!(back.cached);
        assert!(
            (back.error_mm - 0.05).abs() < 1e-9,
            "finer cache was discarded, error {}",
            back.error_mm
        );

        let mut scaled = dense.clone();
        for tri in &mut scaled.triangles {
            for vertex in &mut *tri {
                for coord in vertex.iter_mut() {
                    *coord *= 2.0;
                }
            }
        }
        assert_ne!(fingerprint(&dense), fingerprint(&scaled));

        drop(cache);
        let reloaded = SimplifyCache::open(Some(dir.clone()));
        let (loaded, from_disk) = reloaded
            .simplify(&dense, true, 0.10, Job::default())
            .unwrap();
        assert!(from_disk.cached, "reload missed a valid cache file");
        assert!((from_disk.error_mm - 0.05).abs() < 1e-9);
        eprintln!(
            "simplify cache  miss {:.2} ms → {} tris  rotate hit {:.2} ms  close {:.2} ms  tight {:.2} ms → {} tris  disk {:.2} ms",
            first.milliseconds,
            first.triangles,
            rotated.milliseconds,
            close.milliseconds,
            strict.milliseconds,
            strict.triangles,
            from_disk.milliseconds
        );
        assert_eq!(loaded.triangle_count(), tighter.triangle_count());
        for (left, right) in loaded.triangles.iter().zip(tighter.triangles.iter()) {
            for (a, b) in left.iter().zip(right.iter()) {
                for axis in 0..3 {
                    assert_eq!(a[axis].to_bits(), b[axis].to_bits());
                }
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Release timing for a rotate/reload of Dragon 2.5. Not part of the default suite.
    ///   cargo test -p lime-slice-core --release --lib dragon_simplify_cache -- --ignored --nocapture
    #[test]
    #[ignore = "release timing of dragon_2_5 simplify cache"]
    fn dragon_simplify_cache_skips_the_second_collapse() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../samples/dragon_2_5.stl");
        if !path.is_file() {
            eprintln!("skip dragon: {} missing", path.display());
            return;
        }
        let mesh =
            crate::load::load_mesh("dragon_2_5.stl", &std::fs::read(&path).unwrap()).unwrap();
        let dir = std::env::temp_dir().join(format!(
            "lime-slice-dragon-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let cache = SimplifyCache::open(Some(dir.clone()));
        let (_, first) = cache.simplify(&mesh, true, 0.1, Job::default()).unwrap();
        let (_, second) = cache.simplify(&mesh, true, 0.1, Job::default()).unwrap();
        drop(cache);
        let reloaded = SimplifyCache::open(Some(dir.clone()));
        let (_, third) = reloaded.simplify(&mesh, true, 0.1, Job::default()).unwrap();
        eprintln!(
            "dragon_2_5  {} → {} tris  miss {:.1} ms  rotate/settings hit {:.2} ms  disk {:.2} ms",
            first.source_triangles,
            first.triangles,
            first.milliseconds,
            second.milliseconds,
            third.milliseconds
        );
        assert!(!first.cached, "dragon miss was a hit");
        assert!(second.cached, "second collapse was not cached");
        assert!(third.cached, "reload missed");
        assert_eq!(second.triangles, first.triangles);
        assert!(
            second.milliseconds < first.milliseconds,
            "hit {:.2} ms was not cheaper than miss {:.1} ms",
            second.milliseconds,
            first.milliseconds
        );
        let _ = std::fs::remove_dir_all(&dir);
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
