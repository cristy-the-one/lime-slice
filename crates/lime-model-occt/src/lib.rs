//! JSON session for Model mode.
//!
//! The desktop shell dlopens this crate and does not link it. Open CASCADE is
//! linked only when `OCCT_ROOT` is set. Without that, every call returns an
//! error and the C++ compiler is not run.

use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::path::Path;

#[cfg(not(lime_occt))]
const MISSING: &str = "{\"error\":\"OCCT_ROOT is not set, so Open CASCADE is not linked\"}";

/// A box solid, as JSON. `error` is set when the kernel is absent or the box is rejected.
pub fn open_box(x_mm: f64, y_mm: f64, z_mm: f64) -> String {
    #[cfg(lime_occt)]
    {
        native::open_box(x_mm, y_mm, z_mm)
    }
    #[cfg(not(lime_occt))]
    {
        let _ = (x_mm, y_mm, z_mm);
        MISSING.into()
    }
}

/// Read a STEP file. `chord_mm` is the tessellation chord, clamped by the kernel.
pub fn open_step(path: &Path, chord_mm: f64) -> String {
    #[cfg(lime_occt)]
    {
        native::open_step(path, chord_mm)
    }
    #[cfg(not(lime_occt))]
    {
        let _ = (path, chord_mm);
        MISSING.into()
    }
}

/// Distance in millimetres between two picks. `kind` is `face` or `edge`. Indexes are zero-based.
pub fn distance(id: i32, a_kind: &str, a: i32, b_kind: &str, b: i32) -> String {
    #[cfg(lime_occt)]
    {
        native::distance(id, a_kind, a, b_kind, b)
    }
    #[cfg(not(lime_occt))]
    {
        let _ = (id, a_kind, a, b_kind, b);
        MISSING.into()
    }
}

fn export_json(text: String) -> *mut c_char {
    CString::new(text)
        .unwrap_or_else(|_| CString::new("{\"error\":\"bridge text was not a C string\"}").unwrap())
        .into_raw()
}

#[no_mangle]
pub extern "C" fn lime_occt_open_box(x_mm: f64, y_mm: f64, z_mm: f64) -> *mut c_char {
    export_json(open_box(x_mm, y_mm, z_mm))
}

/// # Safety
/// `path` is null or a valid null-terminated string. The returned pointer is freed with `lime_occt_string_free`.
#[no_mangle]
pub unsafe extern "C" fn lime_occt_open_step(path: *const c_char, chord_mm: f64) -> *mut c_char {
    if path.is_null() {
        return export_json("{\"error\":\"STEP path is empty\"}".into());
    }
    let text = unsafe { CStr::from_ptr(path) }.to_string_lossy();
    export_json(open_step(Path::new(text.as_ref()), chord_mm))
}

/// # Safety
/// `a_kind` and `b_kind` are null or valid null-terminated strings. The returned pointer is freed with `lime_occt_string_free`.
#[no_mangle]
pub unsafe extern "C" fn lime_occt_distance(
    id: i32,
    a_kind: *const c_char,
    a: i32,
    b_kind: *const c_char,
    b: i32,
) -> *mut c_char {
    let a_kind = cstr(a_kind);
    let b_kind = cstr(b_kind);
    export_json(distance(id, &a_kind, a, &b_kind, b))
}

/// # Safety
/// `text` is null or a pointer returned by `lime_occt_open_box`, `lime_occt_open_step`, or `lime_occt_distance`.
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
    unsafe { CStr::from_ptr(ptr) }.to_string_lossy().into_owned()
}

#[cfg(lime_occt)]
mod native {
    use std::ffi::{CStr, CString};
    use std::os::raw::c_char;
    use std::path::Path;

    extern "C" {
        fn lime_model_occt_open_box(x: f64, y: f64, z: f64) -> *mut c_char;
        fn lime_model_occt_open_step(path: *const c_char, chord: f64) -> *mut c_char;
        fn lime_model_occt_distance(
            id: i32,
            a_kind: *const c_char,
            a: i32,
            b_kind: *const c_char,
            b: i32,
        ) -> *mut c_char;
        fn lime_model_occt_string_free(text: *mut c_char);
    }

    fn take(ptr: *mut c_char) -> String {
        if ptr.is_null() {
            return "{\"error\":\"Open CASCADE returned nothing\"}".into();
        }
        let text = unsafe { CStr::from_ptr(ptr) }.to_string_lossy().into_owned();
        unsafe { lime_model_occt_string_free(ptr) };
        text
    }

    pub fn open_box(x_mm: f64, y_mm: f64, z_mm: f64) -> String {
        take(unsafe { lime_model_occt_open_box(x_mm, y_mm, z_mm) })
    }

    pub fn open_step(path: &Path, chord_mm: f64) -> String {
        let Some(text) = path.to_str() else {
            return "{\"error\":\"STEP path is not UTF-8\"}".into();
        };
        let Ok(c) = CString::new(text) else {
            return "{\"error\":\"STEP path is not a C string\"}".into();
        };
        take(unsafe { lime_model_occt_open_step(c.as_ptr(), chord_mm) })
    }

    pub fn distance(id: i32, a_kind: &str, a: i32, b_kind: &str, b: i32) -> String {
        let Ok(a_kind) = CString::new(a_kind) else {
            return "{\"error\":\"pick kind is not a C string\"}".into();
        };
        let Ok(b_kind) = CString::new(b_kind) else {
            return "{\"error\":\"pick kind is not a C string\"}".into();
        };
        take(unsafe { lime_model_occt_distance(id, a_kind.as_ptr(), a, b_kind.as_ptr(), b) })
    }
}
