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

/// Kernel work since the library loaded: `builds` (booleans, cuts, blends, splits), `volumes`
/// (volume integrations), and `tessellations` (replies built rather than reused). For tests.
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
