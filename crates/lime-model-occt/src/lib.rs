//! Open CASCADE bridge for Model mode: the history tree, as JSON in and JSON out.
//!
//! The desktop shell dlopens this crate and does not link it. Open CASCADE is
//! linked only when `OCCT_ROOT` is set. Without that, every call returns an
//! error and the C++ compiler is not run.

use std::ffi::{CStr, CString};
use std::os::raw::c_char;

#[cfg(lime_occt)]
mod tree;

#[cfg(not(lime_occt))]
const MISSING: &str = "{\"error\":\"OCCT_ROOT is not set, so Open CASCADE is not linked\"}";

/// One call on the Model history tree, as JSON in and JSON out. `docs/step-modeler.md` lists the calls.
pub fn tree(request: &str) -> String {
    #[cfg(lime_occt)]
    {
        tree::call(request)
    }
    #[cfg(not(lime_occt))]
    {
        let _ = request;
        MISSING.into()
    }
}

/// One piece of a partition, as the kernel reports it. For tests.
#[derive(Clone, Debug, PartialEq)]
pub struct PartitionPiece {
    pub volume_mm3: f64,
    pub solids: i32,
    pub faces: i32,
    /// `BRepCheck_Analyzer` accepts it.
    pub valid: bool,
    /// Every edge lies on exactly two faces.
    pub closed: bool,
}

/// Builds a `Solid` (as JSON), cuts it along every plane (x, y, z, nx, ny, nz) at once, and reports each piece in
/// order, or the kernel's one-sentence refusal. A test path: the history op that holds the pieces comes later.
pub fn partition_primitive(solid: &str, planes: &[[f64; 6]]) -> Result<Vec<PartitionPiece>, String> {
    #[cfg(lime_occt)]
    {
        tree::partition_primitive(solid, planes)
    }
    #[cfg(not(lime_occt))]
    {
        let _ = (solid, planes);
        Err("OCCT_ROOT is not set, so Open CASCADE is not linked".into())
    }
}

/// The solids a STEP file holds, each checked as a partition's piece: what a split to print's STEP export reads back as.
pub fn step_solids(step: &[u8]) -> Result<Vec<PartitionPiece>, String> {
    #[cfg(lime_occt)]
    {
        tree::step_solids(step)
    }
    #[cfg(not(lime_occt))]
    {
        let _ = step;
        Err("OCCT_ROOT is not set, so Open CASCADE is not linked".into())
    }
}

/// The solids of a STEP file with the product name of the free shape each came from (empty when that shape holds
/// several), each checked as a partition's piece, in the file's order: what a named STEP export reads back as in an
/// XCAF document. The `stepSolids` tree call answers the same for the app.
pub fn step_named_solids(step: &[u8]) -> Result<Vec<(String, PartitionPiece)>, String> {
    #[cfg(lime_occt)]
    {
        tree::step_named_solids(step)
    }
    #[cfg(not(lime_occt))]
    {
        let _ = step;
        Err("OCCT_ROOT is not set, so Open CASCADE is not linked".into())
    }
}

/// How long a new group (an Apply or a probe) may build before it stops; 60 s unless set. Without the kernel
/// this does nothing.
pub fn set_group_budget(budget: std::time::Duration) {
    #[cfg(lime_occt)]
    {
        tree::set_group_budget(budget);
    }
    #[cfg(not(lime_occt))]
    {
        let _ = budget;
    }
}

/// How many unpinned solids and cached replies the tree keeps. Without the kernel this does nothing.
pub fn set_tree_limits(shapes: usize, replies: usize) {
    #[cfg(lime_occt)]
    {
        tree::set_limits(tree::Limits { shapes, replies });
    }
    #[cfg(not(lime_occt))]
    {
        let _ = (shapes, replies);
    }
}

/// The linked Open CASCADE `version`, and kernel work since the library loaded: `builds`
/// (booleans, cuts, blends, splits), `volumes` (volume integrations), `tessellations` (replies
/// built rather than reused), `meshes` (shapes meshed), `fullMeshes` (of those, meshed whole
/// rather than only around the faces their step made), and `descriptions` (shapes whose faces
/// and edges were measured for a reply). Then the microseconds spent in `booleanUs` (booleans),
/// `volumeUs` (volume integrations), `meshUs` (meshing), `readoutUs` (reading a mesh out), and
/// `describeUs` (measuring faces and edges). For tests and benches.
pub fn stats() -> String {
    #[cfg(lime_occt)]
    {
        native::stats()
    }
    #[cfg(not(lime_occt))]
    {
        MISSING.into()
    }
}

/// With `on`, mesh every face of a solid, as before a step meshed only around the faces it
/// made, so a test can compare the two. Without the kernel this does nothing.
pub fn set_whole_meshes(on: bool) {
    #[cfg(lime_occt)]
    {
        native::set_whole_meshes(on);
    }
    #[cfg(not(lime_occt))]
    {
        let _ = on;
    }
}

fn export_json(text: String) -> *mut c_char {
    CString::new(text)
        .unwrap_or_else(|_| CString::new("{\"error\":\"bridge text was not a C string\"}").unwrap())
        .into_raw()
}

/// # Safety
/// `request` is null or a valid null-terminated string. The returned pointer is freed with `lime_occt_string_free`.
#[no_mangle]
pub unsafe extern "C" fn lime_occt_tree(request: *const c_char) -> *mut c_char {
    let request = cstr(request);
    let answer = std::panic::catch_unwind(|| tree(&request))
        .unwrap_or_else(|_| "{\"error\":\"The history tree failed inside the bridge\"}".into());
    export_json(answer)
}

/// # Safety
/// `text` is null or a pointer returned by `lime_occt_tree`.
#[no_mangle]
pub unsafe extern "C" fn lime_occt_string_free(text: *mut c_char) {
    if !text.is_null() {
        drop(unsafe { CString::from_raw(text) });
    }
}

fn cstr(ptr: *const c_char) -> String {
    if ptr.is_null() {
        return String::new();
    }
    unsafe { CStr::from_ptr(ptr) }
        .to_string_lossy()
        .into_owned()
}

#[cfg(lime_occt)]
mod native {
    use std::ffi::CStr;
    use std::os::raw::c_char;

    extern "C" {
        fn lime_model_occt_stats() -> *mut c_char;
        fn lime_model_occt_string_free(text: *mut c_char);
        fn lime_model_occt_whole_meshes(on: std::os::raw::c_int);
    }

    pub fn set_whole_meshes(on: bool) {
        unsafe { lime_model_occt_whole_meshes(std::os::raw::c_int::from(on)) };
    }

    pub fn stats() -> String {
        let ptr = unsafe { lime_model_occt_stats() };
        if ptr.is_null() {
            return "{\"error\":\"Open CASCADE returned nothing\"}".into();
        }
        let text = unsafe { CStr::from_ptr(ptr) }
            .to_string_lossy()
            .into_owned();
        unsafe { lime_model_occt_string_free(ptr) };
        text
    }
}

#[cfg(test)]
mod kernel_contract {
    #[test]
    fn step_writer_goes_to_a_log_and_a_face_cut_is_refused() {
        let src = include_str!("../cpp/kernel.cpp").replace("\r\n", "\n");
        assert!(src.contains("Message_PrinterOStream"), "{src}");
        assert!(src.contains("lime-slice/occt.log"));
        assert!(src.contains("The plane is too close to a face. Move it into the part."));
        assert!(src.contains("This solid is too thin to split"));
    }

    #[cfg(not(lime_occt))]
    #[test]
    fn missing_kernel_probe_does_not_claim_success() {
        let text = super::tree(
            r#"{"call":"probe","key":"k","node":0,"op":{"kind":"fillet","edges":[0],"size":2}}"#,
        );
        assert!(text.contains("OCCT_ROOT"), "{text}");
        assert!(!text.contains("\"ok\":true"), "{text}");
    }
}
