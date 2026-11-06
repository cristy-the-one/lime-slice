//! Asking a shape about its edges and faces: lookups, signatures, loops, sections, distances and the reply.

use base64::Engine;
use serde_json::{json, Value};
use std::ffi::{CStr, CString};
use std::fmt::Write as _;
use std::os::raw::{c_char, c_int};
use std::ptr::NonNull;

use super::{NodeId, EDGE_MATCH_MM, SOLID_FORMAT};
use super::ffi::{
    lime_tree_created,
    lime_tree_distance,
    lime_tree_edge,
    lime_tree_edge_chain,
    lime_tree_edge_kinds,
    lime_tree_edge_sig,
    lime_tree_face,
    lime_tree_face_from,
    lime_tree_face_loops,
    lime_tree_face_region,
    lime_tree_mesh,
    lime_tree_section,
    lime_tree_set_face_from,
    MeshView,
};
use super::ops::{EdgeRef, EdgeSig, FaceRef, CHAIN_DEG, FLAT_MM};
use super::outcome::Failure;
use super::same::{same_edge, same_face};
use super::shape::{take_text, Mesh, Shape};

impl Shape {
    pub(super) fn edge(&mut self, index: i32) -> Option<EdgeRef> {
        let mut mid = [0.0; 3];
        let mut length = 0.0;
        let found =
            unsafe { lime_tree_edge(self.0.as_ptr(), index, mid.as_mut_ptr(), &mut length) };
        (found != 0).then_some(EdgeRef {
            index,
            mid,
            length_mm: length,
            sig: None,
        })
    }

    /// Every edge, as the kernel numbers them.
    pub(super) fn all_edges(&mut self) -> Vec<EdgeRef> {
        let count = self.fingerprint().edges;
        (0..count).filter_map(|index| self.edge(index)).collect()
    }

    /// The indexes of the edges the op that built this solid made or changed.
    pub(super) fn created_indexes(&self) -> Vec<c_int> {
        let mut ptr: *const c_int = std::ptr::null();
        let count = unsafe { lime_tree_created(self.raw(), &mut ptr) };
        if count <= 0 || ptr.is_null() {
            return Vec::new();
        }
        // SAFETY: the kernel keeps `count` ints there for as long as the shape lives; they are copied here.
        unsafe { std::slice::from_raw_parts(ptr, count as usize) }.to_vec()
    }

    /// --- A10. For each face, the parent face it descends from, or -1 when this step made it.
    pub(super) fn face_from(&self) -> Vec<c_int> {
        let mut ptr: *const c_int = std::ptr::null();
        let count = unsafe { lime_tree_face_from(self.raw(), &mut ptr) };
        if count <= 0 || ptr.is_null() {
            return Vec::new();
        }
        // SAFETY: the kernel keeps `count` ints there for as long as the shape lives; they are copied here.
        unsafe { std::slice::from_raw_parts(ptr, count as usize) }.to_vec()
    }

    /// --- A10. A group writes the lineage it composed, indexed by the solid the group started from.
    pub(super) fn set_face_from(&mut self, indexes: &[c_int]) {
        unsafe { lime_tree_set_face_from(self.0.as_ptr(), indexes.as_ptr(), indexes.len() as c_int) }
    }

    /// The edges the op that built this solid made or changed, those it could measure.
    pub(super) fn created_edges(&mut self) -> Vec<EdgeRef> {
        self.created_indexes()
            .into_iter()
            .filter_map(|index| self.edge(index))
            .filter(|edge| edge.mid.iter().all(|v| v.is_finite()) && edge.length_mm.is_finite())
            .collect()
    }

    /// Each edge as convex (1), concave (2), or neither (0): smooth, a seam, or on one face.
    pub(super) fn edge_kinds(&self, edges: &[c_int]) -> Result<Vec<c_int>, String> {
        let mut out = vec![0; edges.len()];
        let ok = unsafe {
            lime_tree_edge_kinds(
                self.raw(),
                edges.as_ptr(),
                edges.len() as c_int,
                out.as_mut_ptr(),
            )
        };
        if ok == 0 {
            return Err("Open CASCADE could not read those edges".into());
        }
        Ok(out)
    }

    /// --- Print transitions, step 6. The tangent chain through `edge`, the edge first, and whether it closes.
    pub(super) fn edge_chain(&mut self, edge: c_int) -> Option<(Vec<c_int>, bool)> {
        let capacity = self.fingerprint().edges.max(1);
        let mut out = vec![0 as c_int; capacity as usize];
        let mut closed: c_int = 0;
        // SAFETY: `self` is held for this call; the kernel writes at most `capacity` ints and one flag.
        let count = unsafe {
            lime_tree_edge_chain(self.0.as_ptr(), edge, CHAIN_DEG, out.as_mut_ptr(), capacity, &mut closed)
        };
        if count <= 0 {
            return None;
        }
        out.truncate(count as usize);
        Some((out, closed != 0))
    }

    /// K4. `{origin, turn, loops}` for face `index`, as JSON.
    pub(super) fn face_loops(&mut self, index: c_int) -> Result<serde_json::Value, String> {
        let mut error: *mut c_char = std::ptr::null_mut();
        let ptr = unsafe { lime_tree_face_loops(self.raw(), index, &mut error) };
        let message = take_text(error);
        let text = take_text(ptr).ok_or_else(|| {
            message.unwrap_or_else(|| "Open CASCADE could not read this face's outline.".into())
        })?;
        serde_json::from_str(&text)
            .map_err(|_| "Open CASCADE could not read this face's outline.".to_string())
    }

    // --- Recipe reads (I5–I7). Keep this block together. ---
    /// I5. Face `index`'s outline inset `inset` mm, as `{frame, origin, turn, loops, regions, areaMm2}`, in `frame`
    /// (origin, U, V) or the face's own.
    pub(super) fn face_region(&self, index: c_int, frame: Option<&[f64; 9]>, inset: f64, chord: f64) -> Result<Value, String> {
        let mut error: *mut c_char = std::ptr::null_mut();
        let frame_ptr = frame.map_or(std::ptr::null(), |numbers| numbers.as_ptr());
        let ptr = unsafe { lime_tree_face_region(self.raw(), index, frame_ptr, inset, chord, &mut error) };
        let message = take_text(error);
        let text = take_text(ptr)
            .ok_or_else(|| message.unwrap_or_else(|| "Open CASCADE could not read this face's outline.".into()))?;
        serde_json::from_str(&text).map_err(|_| "Open CASCADE could not read this face's outline.".to_string())
    }

    /// I6. The solid cut by the plane through `origin` along `normal`, in `frame` (origin, U, V on that plane).
    pub(super) fn section(&self, origin: [f64; 3], normal: [f64; 3], frame: &[f64; 9], chord: f64) -> Result<Value, String> {
        let plane = [origin[0], origin[1], origin[2], normal[0], normal[1], normal[2]];
        let mut error: *mut c_char = std::ptr::null_mut();
        let ptr = unsafe { lime_tree_section(self.raw(), plane.as_ptr(), frame.as_ptr(), chord, &mut error) };
        let message = take_text(error);
        let text = take_text(ptr).ok_or_else(|| message.unwrap_or_else(|| "Open CASCADE did not cut this section.".into()))?;
        serde_json::from_str(&text).map_err(|_| "Open CASCADE did not cut this section.".to_string())
    }

    // --- end recipe reads ---

    pub(super) fn face(&mut self, index: i32) -> Option<FaceRef> {
        let mut mid = [0.0; 3];
        let mut area = 0.0;
        let found =
            unsafe { lime_tree_face(self.0.as_ptr(), index, mid.as_mut_ptr(), &mut area) };
        (found != 0).then_some(FaceRef {
            index,
            mid,
            area_mm2: area,
        })
    }

    /// The one face whose centre and area match `want`. None when no face does; an error when several do.
    pub(super) fn find_face(&mut self, want: &FaceRef) -> Result<Option<FaceRef>, String> {
        let count = self.fingerprint().faces;
        let mut found = None;
        for index in 0..count {
            let Some(have) = self.face(index) else {
                continue;
            };
            if same_face(&have, want) {
                if found.is_some() {
                    return Err("Two faces match the one this step opens".into());
                }
                found = Some(have);
            }
        }
        Ok(found)
    }

    /// The one edge whose midpoint and length match `want`. None when no edge does; an error when several do.
    pub(super) fn find_edge(&mut self, want: &EdgeRef) -> Result<Option<EdgeRef>, String> {
        let count = self.fingerprint().edges;
        let mut found = None;
        for index in 0..count {
            let Some(have) = self.edge(index) else {
                continue;
            };
            if same_edge(&have, want) {
                if found.is_some() {
                    return Err("Two edges match the one this step rounds".into());
                }
                found = Some(have);
            }
        }
        Ok(found)
    }

    /// Edge `index`'s signature, and the indexes of its faces in the signature's order (-1 for none).
    pub(super) fn edge_sig(&mut self, index: i32) -> Option<(EdgeSig, [c_int; 2])> {
        self.edge_sig_within(index, 0.0)
    }

    /// As `edge_sig`, with a curve or a surface within `FLAT_MM` of a line or a plane read as one: a STEP file stores flat
    /// faces and straight edges as B-splines too. Only print transitions read edges this way. A saved edge keeps the
    /// signature as stored, so a step saved before this still finds its edge.
    pub(super) fn edge_sig_flat(&mut self, index: i32) -> Option<(EdgeSig, [c_int; 2])> {
        self.edge_sig_within(index, FLAT_MM)
    }

    fn edge_sig_within(&mut self, index: i32, flat: f64) -> Option<(EdgeSig, [c_int; 2])> {
        let mut out = [0.0f64; 15];
        if unsafe { lime_tree_edge_sig(self.0.as_ptr(), index, flat, out.as_mut_ptr()) } == 0 {
            return None;
        }
        if !out.iter().all(|value| value.is_finite()) {
            return None;
        }
        let mut dir = [out[1], out[2], out[3]];
        if let Some(lead) = dir.iter().find(|value| value.abs() > 1e-9) {
            if *lead < 0.0 {
                dir = dir.map(|value| -value);
            }
        }
        let count = out[4] as usize;
        let side = |k: usize| -> (c_int, u8, [f64; 3]) {
            if k >= count {
                return (-1, 9, [0.0; 3]);
            }
            let slot = &out[5 + 5 * k..10 + 5 * k];
            (slot[0] as c_int, slot[1] as u8, [slot[2], slot[3], slot[4]])
        };
        let mut sides = [side(0), side(1)];
        let key = |side: &(c_int, u8, [f64; 3])| {
            let round = |value: f64| (value * 1e6).round() as i64;
            (side.1, round(side.2[0]), round(side.2[1]), round(side.2[2]))
        };
        if key(&sides[1]) < key(&sides[0]) {
            sides.swap(0, 1);
        }
        let sig = EdgeSig {
            curve: out[0] as u8,
            dir,
            kinds: [sides[0].1, sides[1].1],
            normals: [sides[0].2, sides[1].2],
        };
        Some((sig, [sides[0].0, sides[1].0]))
    }

    /// The edge with `sig` nearest where `want` was, when the part moved or changed size under it. None when no edge
    /// has it; an error when two are as near.
    pub(super) fn find_edge_like(&mut self, want: &EdgeRef, sig: &EdgeSig) -> Result<Option<EdgeRef>, String> {
        let count = self.fingerprint().edges;
        let mut alike: Vec<(f64, EdgeRef)> = Vec::new();
        for index in 0..count {
            let Some((have_sig, _)) = self.edge_sig(index) else {
                continue;
            };
            if !have_sig.matches(sig) {
                continue;
            }
            let Some(have) = self.edge(index) else {
                continue;
            };
            let d = (0..3)
                .map(|i| (have.mid[i] - want.mid[i]).powi(2))
                .sum::<f64>()
                .sqrt();
            if d.is_finite() {
                alike.push((d, have));
            }
        }
        alike.sort_by(|a, b| a.0.total_cmp(&b.0));
        match alike.as_slice() {
            [] => Ok(None),
            [(_, only)] => Ok(Some(*only)),
            [(near, best), (next, _), ..] => {
                if next - near <= EDGE_MATCH_MM.max(near * 1e-3) {
                    Err("Two edges match the one this step rounds".into())
                } else {
                    Ok(Some(*best))
                }
            }
        }
    }

    /// The solid reply for node `id`: the tessellation's arrays as base64 of their little-endian
    /// bytes, its faces and edges as JSON, and the fingerprint. `docs/step-modeler.md` lists the fields.
    pub(super) fn reply(&mut self, id: NodeId, chord: f64) -> Result<String, Failure> {
        let mut view = MeshView {
            positions: std::ptr::null(),
            positions_bytes: 0,
            triangles: std::ptr::null(),
            triangles_bytes: 0,
            edge_points: std::ptr::null(),
            edge_points_bytes: 0,
            edge_offsets: std::ptr::null(),
            edge_offsets_bytes: 0,
            meta: std::ptr::null(),
        };
        let mut error: *mut c_char = std::ptr::null_mut();
        let raw = unsafe { lime_tree_mesh(self.0.as_ptr(), chord, &mut view, &mut error) };
        let message = take_text(error);
        let mesh = NonNull::new(raw).map(Mesh).ok_or_else(|| {
            Failure::Message(message.unwrap_or_else(|| "Open CASCADE failed".into()))
        })?;
        let meta = unsafe { CStr::from_ptr(view.meta) }
            .to_str()
            .ok()
            .and_then(|meta| meta.strip_prefix('{')?.strip_suffix('}'))
            .ok_or_else(|| Failure::Message("Open CASCADE returned a damaged mesh".into()))?;
        // SAFETY: `lime_tree_mesh` filled `view` with `mesh`'s own arrays, which live until it drops.
        let arrays = unsafe {
            [
                (
                    "positions",
                    mesh.bytes(view.positions, view.positions_bytes),
                ),
                (
                    "triangles",
                    mesh.bytes(view.triangles, view.triangles_bytes),
                ),
                (
                    "edgePoints",
                    mesh.bytes(view.edge_points, view.edge_points_bytes),
                ),
                (
                    "edgeOffsets",
                    mesh.bytes(view.edge_offsets, view.edge_offsets_bytes),
                ),
            ]
        };
        let fingerprint = json!(self.fingerprint()).to_string();
        let size = arrays
            .iter()
            .map(|(name, bytes)| name.len() + bytes.len().div_ceil(3) * 4 + 6)
            .sum::<usize>()
            + meta.len()
            + fingerprint.len()
            + 64;
        let mut out = String::with_capacity(size);
        let _ = write!(
            out,
            "{{\"id\":{id},\"format\":\"{SOLID_FORMAT}\",{meta},\"fingerprint\":{fingerprint}"
        );
        for (name, bytes) in arrays {
            let _ = write!(out, ",\"{name}\":\"");
            base64::engine::general_purpose::STANDARD.encode_string(bytes, &mut out);
            out.push('"');
        }
        out.push('}');
        Ok(out)
    }

    pub(super) fn distance(&self, a_kind: &str, a: i32, b_kind: &str, b: i32) -> Result<f64, String> {
        let a_kind = CString::new(a_kind).map_err(|_| "pick kind is not a C string".to_string())?;
        let b_kind = CString::new(b_kind).map_err(|_| "pick kind is not a C string".to_string())?;
        let mut out = 0.0;
        let mut error: *mut c_char = std::ptr::null_mut();
        let ok = unsafe {
            lime_tree_distance(
                self.raw(),
                a_kind.as_ptr(),
                a,
                b_kind.as_ptr(),
                b,
                &mut out,
                &mut error,
            )
        };
        let message = take_text(error);
        if ok == 0 {
            return Err(message.unwrap_or_else(|| "Open CASCADE failed".into()));
        }
        Ok(out)
    }
}
