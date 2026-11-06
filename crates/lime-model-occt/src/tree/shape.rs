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
    RawMesh,
    RawShape,
};
#[cfg(lime_occt_test_hooks)]
use super::ffi::{lime_tree_test_fault, lime_tree_test_nurbs, lime_tree_test_text};

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
