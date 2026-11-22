//! A solid in the kernel: `Shape`, `Mesh`, their drop and the small queries on a shape.

use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int};
use std::ptr::NonNull;

use super::Fingerprint;
use super::ffi::{
    lime_model_occt_string_free,
    lime_tree_bounds,
    lime_tree_check,
    lime_tree_counts,
    lime_tree_editable,
    lime_tree_fingerprint,
    lime_tree_free,
    lime_tree_mesh_free,
    lime_tree_mesh_order,
    lime_tree_solids,
    lime_tree_surface_inspect_free,
    RawMesh,
    RawShape,
    RawSurfaceInspect,
};
#[cfg(lime_occt_test_hooks)]
use super::ffi::{
    lime_tree_eval_nurbs_curve, lime_tree_eval_nurbs_surface, lime_tree_test_fault, lime_tree_test_mesh,
    lime_tree_test_nurbs, lime_tree_test_text,
};
#[cfg(lime_occt_test_hooks)]
use super::request::{EvalNurbsCurve, EvalNurbsSurface};

/// One solid owned by the kernel. Freed when dropped.
pub(super) struct Shape(pub(super) NonNull<RawShape>);

/// One tessellation owned by the kernel, while its reply is written.
pub(super) struct Mesh(pub(super) NonNull<RawMesh>);

impl Mesh {
    /// Bytes the mesh's view points at, borrowed for as long as the mesh lives.
    ///
    /// # Safety
    /// `ptr` and `len` are one array of the `MeshView` that `lime_tree_mesh` filled with this mesh.
    pub(super) unsafe fn bytes(&self, ptr: *const u8, len: usize) -> &[u8] {
        if len == 0 {
            return &[];
        }
        unsafe { std::slice::from_raw_parts(ptr, len) }
    }
}

impl Drop for Mesh {
    fn drop(&mut self) {
        unsafe { lime_tree_mesh_free(self.0.as_ptr()) };
    }
}

/// One lazy surface inspection owned by the kernel, while its reply is written.
pub(super) struct SurfaceInspect(pub(super) NonNull<RawSurfaceInspect>);

impl SurfaceInspect {
    /// Bytes the inspection view points at, borrowed for as long as the inspection lives.
    ///
    /// # Safety
    /// `ptr` and `len` are one array of the `SurfaceInspectView` filled by `lime_tree_surface_inspect`.
    pub(super) unsafe fn bytes(&self, ptr: *const u8, len: usize) -> &[u8] {
        if len == 0 {
            return &[];
        }
        unsafe { std::slice::from_raw_parts(ptr, len) }
    }
}

impl Drop for SurfaceInspect {
    fn drop(&mut self) {
        unsafe { lime_tree_surface_inspect_free(self.0.as_ptr()) };
    }
}

// The store lock serialises every use, and a shape is never shared between nodes.
unsafe impl Send for Shape {}

impl Drop for Shape {
    fn drop(&mut self) {
        unsafe { lime_tree_free(self.0.as_ptr()) };
    }
}

pub(super) fn take_text(ptr: *mut c_char) -> Option<String> {
    let ptr = NonNull::new(ptr)?;
    let text = unsafe { CStr::from_ptr(ptr.as_ptr()) }
        .to_string_lossy()
        .into_owned();
    unsafe { lime_model_occt_string_free(ptr.as_ptr()) };
    Some(text)
}

pub(super) fn c_path(path: &std::path::Path) -> Result<CString, String> {
    let text = path.to_str().ok_or("STEP path is not UTF-8")?;
    CString::new(text).map_err(|_| "STEP path is not a C string".to_string())
}


impl Shape {
    pub(super) fn raw(&self) -> *const RawShape {
        self.0.as_ptr()
    }

    pub(super) fn made(run: impl FnOnce(*mut *mut c_char) -> *mut RawShape) -> Result<Shape, String> {
        let mut error: *mut c_char = std::ptr::null_mut();
        let shape = run(&mut error);
        let message = take_text(error);
        match NonNull::new(shape) {
            Some(shape) => Ok(Shape(shape)),
            None => Err(message.unwrap_or_else(|| "Open CASCADE failed".into())),
        }
    }

    /// --- Split to print. Each solid of this shape on its own, at most 24.
    pub(super) fn solids(&self) -> Result<Vec<Shape>, String> {
        self.solids_up_to(24, "More solids than a partition makes")
    }

    /// Each solid of this shape on its own, at most `max`, or `more` when it has more.
    pub(super) fn solids_up_to(&self, max: usize, more: &str) -> Result<Vec<Shape>, String> {
        let mut out = vec![std::ptr::null_mut::<RawShape>(); max];
        let count = c_int::try_from(max).map_err(|_| more.to_string())?;
        // SAFETY: `out` has room for `max` shapes.
        let made = unsafe { lime_tree_solids(self.raw(), out.as_mut_ptr(), count) };
        let made = usize::try_from(made).map_err(|_| more.to_string())?;
        Ok(out[..made]
            .iter()
            .filter_map(|piece| NonNull::new(*piece).map(Shape))
            .collect())
    }

    /// --- Split to print. The solid's box from its geometry, least corner then greatest; None when it has no extent.
    pub(super) fn bounds(&self) -> Option<[f64; 6]> {
        let mut out = [0.0; 6];
        // SAFETY: `out` has the six slots the kernel writes.
        let found = unsafe { lime_tree_bounds(self.raw(), out.as_mut_ptr()) };
        (found != 0).then_some(out)
    }

    pub(super) fn check(&self) -> crate::PartitionPiece {
        let mut out = [0 as c_int; 4];
        let mut volume = 0.0;
        let (mut faces, mut edges) = (0, 0);
        // SAFETY: `out` has four slots, and the fingerprint writes one number and two counts.
        unsafe {
            lime_tree_check(self.raw(), out.as_mut_ptr());
            lime_tree_fingerprint(self.raw(), &mut volume, &mut faces, &mut edges);
        }
        crate::PartitionPiece {
            volume_mm3: volume,
            solids: out[0],
            faces: out[1],
            valid: out[2] != 0,
            closed: out[3] != 0,
        }
    }

    /// The order the mesh reads the faces out in, by index from 1; empty for index order.
    pub(super) fn mesh_order(&self) -> Vec<c_int> {
        let count = unsafe { lime_tree_mesh_order(self.raw(), std::ptr::null_mut(), 0) };
        let mut out = vec![0; count.max(0) as usize];
        if !out.is_empty() {
            unsafe { lime_tree_mesh_order(self.raw(), out.as_mut_ptr(), count) };
        }
        out
    }

    pub(super) fn editable(&self) -> Result<(), String> {
        let mut error: *mut c_char = std::ptr::null_mut();
        let ok = unsafe { lime_tree_editable(self.raw(), &mut error) };
        let message = take_text(error);
        if ok == 0 {
            return Err(message.unwrap_or_else(|| "This shape cannot be edited".into()));
        }
        Ok(())
    }

    pub(super) fn fingerprint(&self) -> Fingerprint {
        let mut volume = 0.0;
        let mut faces = 0;
        let mut edges = 0;
        unsafe { lime_tree_fingerprint(self.raw(), &mut volume, &mut faces, &mut edges) };
        Fingerprint {
            volume_mm3: volume,
            faces,
            edges,
        }
    }

    /// Separate solids and closed shells.
    pub(super) fn counts(&self) -> (i32, i32) {
        let mut solids = 0;
        let mut shells = 0;
        unsafe { lime_tree_counts(self.raw(), &mut solids, &mut shells) };
        (solids, shells)
    }

    /// Debug builds only: this solid with every surface and curve converted to NURBS, as a project keeps a solid.
    #[cfg(lime_occt_test_hooks)]
    pub(super) fn test_nurbs(&self) -> Result<Vec<u8>, String> {
        // SAFETY: `self` is held for this call; the kernel returns a new shape or an error.
        Shape::made(|error| unsafe { lime_tree_test_nurbs(self.raw(), error) })?.brep_bytes()
    }

    /// Debug builds only: how good the solid's mesh at `chord` is (triangles, the farthest from the surface, the
    /// sharpest corner, slivers).
    #[cfg(lime_occt_test_hooks)]
    pub(super) fn test_mesh(&mut self, chord: f64) -> Result<String, String> {
        let mut error: *mut c_char = std::ptr::null_mut();
        // SAFETY: `self` is held for this call.
        let raw = unsafe { lime_tree_test_mesh(self.0.as_ptr(), chord, &mut error) };
        let message = take_text(error);
        take_text(raw).ok_or_else(|| message.unwrap_or_else(|| "Open CASCADE failed".into()))
    }

    /// Debug builds only: the cheap checks of a text build against the exact ones, on the face nearest `point`.
    #[cfg(lime_occt_test_hooks)]
    pub(super) fn test_text(&self, point: [f64; 3]) -> Result<String, String> {
        let mut error: *mut c_char = std::ptr::null_mut();
        // SAFETY: `self` is held for this call; `point` holds the three numbers the kernel reads.
        let raw = unsafe { lime_tree_test_text(self.raw(), point.as_ptr(), &mut error) };
        let message = take_text(error);
        take_text(raw).ok_or_else(|| message.unwrap_or_else(|| "Open CASCADE failed".into()))
    }

    /// Debug builds only: the refusal for a fault inside Open CASCADE caused on purpose.
    #[cfg(lime_occt_test_hooks)]
    pub(super) fn test_fault(&self) -> String {
        let mut error: *mut c_char = std::ptr::null_mut();
        unsafe { lime_tree_test_fault(self.raw(), &mut error) };
        take_text(error).unwrap_or_default()
    }
}

/// Points from `Geom_BSplineCurve::D0`, as `[[x, y, z], ...]`.
#[cfg(lime_occt_test_hooks)]
pub(super) fn eval_nurbs_curve_points(curve: &EvalNurbsCurve) -> Result<Vec<[f64; 3]>, String> {
    if curve.poles.is_empty() || curve.params.is_empty() {
        return Err("A NURBS evaluation needs poles and parameters.".into());
    }
    if !curve.weights.is_empty() && curve.weights.len() != curve.poles.len() {
        return Err("NURBS weights count must match the number of poles.".into());
    }
    if curve.knots.len() != curve.mults.len() {
        return Err("NURBS knots and multiplicities must be the same length.".into());
    }
    let mut xyz = Vec::with_capacity(curve.poles.len() * 3);
    for pole in &curve.poles {
        xyz.extend_from_slice(pole);
    }
    let mut out = vec![0.0; curve.params.len() * 3];
    let mut error: *mut c_char = std::ptr::null_mut();
    let weights = if curve.weights.is_empty() {
        std::ptr::null()
    } else {
        curve.weights.as_ptr()
    };
    let knots = if curve.knots.is_empty() {
        std::ptr::null()
    } else {
        curve.knots.as_ptr()
    };
    let mults = if curve.mults.is_empty() {
        std::ptr::null()
    } else {
        curve.mults.as_ptr()
    };
    // SAFETY: the vectors live for this call. The kernel writes `out` and, on failure, an error string we free.
    let ok = unsafe {
        lime_tree_eval_nurbs_curve(
            xyz.as_ptr(),
            curve.poles.len() as c_int,
            weights,
            curve.degree,
            knots,
            mults,
            curve.knots.len() as c_int,
            if curve.periodic { 1 } else { 0 },
            curve.params.as_ptr(),
            curve.params.len() as c_int,
            out.as_mut_ptr(),
            &mut error,
        )
    };
    let message = take_text(error);
    if ok == 0 {
        return Err(message.unwrap_or_else(|| "Open CASCADE did not evaluate the NURBS curve.".into()));
    }
    Ok(out.chunks_exact(3).map(|p| [p[0], p[1], p[2]]).collect())
}

/// Points from `Geom_BSplineSurface::D0`, as `[[x, y, z], ...]`.
#[cfg(lime_occt_test_hooks)]
pub(super) fn eval_nurbs_surface_points(surface: &EvalNurbsSurface) -> Result<Vec<[f64; 3]>, String> {
    let nu = surface.poles.len();
    let nv = surface.poles.first().map(|row| row.len()).unwrap_or(0);
    if nu < 2 || nv < 2 || surface.params.is_empty() {
        return Err("A NURBS surface evaluation needs a pole grid and parameters.".into());
    }
    if surface.poles.iter().any(|row| row.len() != nv) {
        return Err("Every NURBS surface row needs the same number of poles.".into());
    }
    if !surface.weights.is_empty()
        && (surface.weights.len() != nu || surface.weights.iter().any(|row| row.len() != nv))
    {
        return Err("NURBS surface weights must match the pole grid.".into());
    }
    if surface.knots_u.len() != surface.mults_u.len() || surface.knots_v.len() != surface.mults_v.len() {
        return Err("NURBS knots and multiplicities must be the same length.".into());
    }
    let mut xyz = Vec::with_capacity(nu * nv * 3);
    for row in &surface.poles {
        for pole in row {
            xyz.extend_from_slice(pole);
        }
    }
    let mut weight_flat = Vec::new();
    if !surface.weights.is_empty() {
        for row in &surface.weights {
            weight_flat.extend_from_slice(row);
        }
    }
    let mut params = Vec::with_capacity(surface.params.len() * 2);
    for uv in &surface.params {
        params.extend_from_slice(uv);
    }
    let mut out = vec![0.0; surface.params.len() * 3];
    let mut error: *mut c_char = std::ptr::null_mut();
    let weights = if weight_flat.is_empty() {
        std::ptr::null()
    } else {
        weight_flat.as_ptr()
    };
    let knots_u = if surface.knots_u.is_empty() {
        std::ptr::null()
    } else {
        surface.knots_u.as_ptr()
    };
    let mults_u = if surface.mults_u.is_empty() {
        std::ptr::null()
    } else {
        surface.mults_u.as_ptr()
    };
    let knots_v = if surface.knots_v.is_empty() {
        std::ptr::null()
    } else {
        surface.knots_v.as_ptr()
    };
    let mults_v = if surface.mults_v.is_empty() {
        std::ptr::null()
    } else {
        surface.mults_v.as_ptr()
    };
    // SAFETY: the vectors live for this call. The kernel writes `out` and, on failure, an error string we free.
    let ok = unsafe {
        lime_tree_eval_nurbs_surface(
            xyz.as_ptr(),
            nu as c_int,
            nv as c_int,
            weights,
            surface.degree_u,
            surface.degree_v,
            knots_u,
            mults_u,
            surface.knots_u.len() as c_int,
            knots_v,
            mults_v,
            surface.knots_v.len() as c_int,
            params.as_ptr(),
            surface.params.len() as c_int,
            out.as_mut_ptr(),
            &mut error,
        )
    };
    let message = take_text(error);
    if ok == 0 {
        return Err(message.unwrap_or_else(|| "Open CASCADE did not evaluate the NURBS surface.".into()));
    }
    Ok(out.chunks_exact(3).map(|p| [p[0], p[1], p[2]]).collect())
}
