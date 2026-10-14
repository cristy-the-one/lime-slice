//! JSON session for Model mode.
//!
//! The desktop shell dlopens this crate and does not link it. Open CASCADE is
//! linked only when `OCCT_ROOT` is set. Without that, every call returns an
//! error and the C++ compiler is not run.

use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::path::Path;

#[cfg(lime_occt)]
mod tree;

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

/// A box, cylinder, or sphere in millimetres. `origin` is the box corner, the cylinder base, or the sphere center.
/// `turn` is degrees about X, then Y, then Z, through the primitive's centre.
#[derive(Clone, Copy)]
pub struct Tool {
    pub origin: [f64; 3],
    pub size: [f64; 3],
    pub radius: f64,
    pub height: f64,
    pub turn: [f64; 3],
}

/// A plane through `origin` with `normal`, in millimetres.
#[derive(Clone, Copy)]
pub struct Plane {
    pub origin: [f64; 3],
    pub normal: [f64; 3],
}

/// Fuse, cut, or common the open solid with a box, cylinder, or sphere. A failure leaves the solid unchanged.
pub fn boolean(id: i32, op: &str, primitive: &str, tool: Tool, chord_mm: f64) -> String {
    #[cfg(lime_occt)]
    {
        native::boolean(id, op, primitive, tool, chord_mm)
    }
    #[cfg(not(lime_occt))]
    {
        let _ = (id, op, primitive, tool, chord_mm);
        MISSING.into()
    }
}

/// Split the open solid with a plane. The negative side stays; `other` is the positive side.
pub fn split(id: i32, plane: Plane, chord_mm: f64) -> String {
    #[cfg(lime_occt)]
    {
        native::split(id, plane, chord_mm)
    }
    #[cfg(not(lime_occt))]
    {
        let _ = (id, plane, chord_mm);
        MISSING.into()
    }
}

/// Round every edge in one fillet, so corners where they meet are blended together. A failure leaves the solid unchanged.
pub fn fillet_many(id: i32, edges: &[i32], radius_mm: f64, chord_mm: f64) -> String {
    #[cfg(lime_occt)]
    {
        native::fillet_many(id, edges, radius_mm, chord_mm)
    }
    #[cfg(not(lime_occt))]
    {
        let _ = (id, edges, radius_mm, chord_mm);
        MISSING.into()
    }
}

/// Round one edge. `edge` is the zero-based index from the solid document. A failure leaves the solid unchanged.
pub fn fillet(id: i32, edge: i32, radius_mm: f64, chord_mm: f64) -> String {
    #[cfg(lime_occt)]
    {
        native::fillet(id, edge, radius_mm, chord_mm)
    }
    #[cfg(not(lime_occt))]
    {
        let _ = (id, edge, radius_mm, chord_mm);
        MISSING.into()
    }
}

/// Chamfer every edge in one builder. A failure leaves the solid unchanged.
pub fn chamfer_many(id: i32, edges: &[i32], distance_mm: f64, chord_mm: f64) -> String {
    #[cfg(lime_occt)]
    {
        native::chamfer_many(id, edges, distance_mm, chord_mm)
    }
    #[cfg(not(lime_occt))]
    {
        let _ = (id, edges, distance_mm, chord_mm);
        MISSING.into()
    }
}

/// Chamfer one edge. `distance_mm` is the setback on each face. A failure leaves the solid unchanged.
pub fn chamfer(id: i32, edge: i32, distance_mm: f64, chord_mm: f64) -> String {
    #[cfg(lime_occt)]
    {
        native::chamfer(id, edge, distance_mm, chord_mm)
    }
    #[cfg(not(lime_occt))]
    {
        let _ = (id, edge, distance_mm, chord_mm);
        MISSING.into()
    }
}

/// Try a fillet (`chamfer` false) or chamfer of every edge on a copy. The open solid is not replaced.
pub fn blend_probe_many(id: i32, edges: &[i32], size_mm: f64, chamfer: bool) -> String {
    #[cfg(lime_occt)]
    {
        native::blend_probe_many(id, edges, size_mm, chamfer)
    }
    #[cfg(not(lime_occt))]
    {
        let _ = (id, edges, size_mm, chamfer);
        MISSING.into()
    }
}

/// Try a fillet (`chamfer` false) or chamfer on a copy. The open solid is not replaced.
pub fn blend_probe(id: i32, edge: i32, size_mm: f64, chamfer: bool) -> String {
    #[cfg(lime_occt)]
    {
        native::blend_probe(id, edge, size_mm, chamfer)
    }
    #[cfg(not(lime_occt))]
    {
        let _ = (id, edge, size_mm, chamfer);
        MISSING.into()
    }
}

/// Try a hole along `direction` on a copy. A zero direction drills toward −Z. The open solid is not replaced.
pub fn hole_axis_probe(
    id: i32,
    origin: [f64; 3],
    direction: [f64; 3],
    radius_mm: f64,
    depth_mm: f64,
) -> String {
    #[cfg(lime_occt)]
    {
        native::hole_axis_probe(id, origin, direction, radius_mm, depth_mm)
    }
    #[cfg(not(lime_occt))]
    {
        let _ = (id, origin, direction, radius_mm, depth_mm);
        MISSING.into()
    }
}

/// Try a hole on a copy. The open solid is not replaced.
pub fn hole_probe(id: i32, origin: [f64; 3], radius_mm: f64, depth_mm: f64) -> String {
    #[cfg(lime_occt)]
    {
        native::hole_probe(id, origin, radius_mm, depth_mm)
    }
    #[cfg(not(lime_occt))]
    {
        let _ = (id, origin, radius_mm, depth_mm);
        MISSING.into()
    }
}

/// Try a boolean on a copy. The open solid is not replaced.
pub fn boolean_probe(id: i32, op: &str, primitive: &str, tool: Tool) -> String {
    #[cfg(lime_occt)]
    {
        native::boolean_probe(id, op, primitive, tool)
    }
    #[cfg(not(lime_occt))]
    {
        let _ = (id, op, primitive, tool);
        MISSING.into()
    }
}

/// Cut a cylinder that starts at `origin` and runs along `direction` by `depth_mm`.
/// `direction` points into the material. A zero vector drills toward −Z, the same as [`hole`].
pub fn hole_axis(
    id: i32,
    origin: [f64; 3],
    direction: [f64; 3],
    radius_mm: f64,
    depth_mm: f64,
    chord_mm: f64,
) -> String {
    #[cfg(lime_occt)]
    {
        native::hole_axis(id, origin, direction, radius_mm, depth_mm, chord_mm)
    }
    #[cfg(not(lime_occt))]
    {
        let _ = (id, origin, direction, radius_mm, depth_mm, chord_mm);
        MISSING.into()
    }
}

/// Cut a cylinder that starts at `origin` and runs toward −Z by `depth_mm`. A miss or a total cut leaves the solid unchanged.
pub fn hole(id: i32, origin: [f64; 3], radius_mm: f64, depth_mm: f64, chord_mm: f64) -> String {
    #[cfg(lime_occt)]
    {
        native::hole(id, origin, radius_mm, depth_mm, chord_mm)
    }
    #[cfg(not(lime_occt))]
    {
        let _ = (id, origin, radius_mm, depth_mm, chord_mm);
        MISSING.into()
    }
}

/// Uniform scale about the solid's centre. `factor` must be positive and not 1.
pub fn scale(id: i32, factor: f64, chord_mm: f64) -> String {
    #[cfg(lime_occt)]
    {
        native::scale(id, factor, chord_mm)
    }
    #[cfg(not(lime_occt))]
    {
        let _ = (id, factor, chord_mm);
        MISSING.into()
    }
}

/// Write the open solid as AP214 IS STEP. The file is manifold solid B-rep.
pub fn write_step(id: i32, path: &Path) -> String {
    #[cfg(lime_occt)]
    {
        native::write_step(id, path)
    }
    #[cfg(not(lime_occt))]
    {
        let _ = (id, path);
        MISSING.into()
    }
}

/// Restore the solid from before the last edit.
pub fn undo(id: i32, chord_mm: f64) -> String {
    #[cfg(lime_occt)]
    {
        native::undo(id, chord_mm)
    }
    #[cfg(not(lime_occt))]
    {
        let _ = (id, chord_mm);
        MISSING.into()
    }
}

/// Put back the solid that undo just replaced.
pub fn redo(id: i32, chord_mm: f64) -> String {
    #[cfg(lime_occt)]
    {
        native::redo(id, chord_mm)
    }
    #[cfg(not(lime_occt))]
    {
        let _ = (id, chord_mm);
        MISSING.into()
    }
}

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
/// `op` and `primitive` are null or valid null-terminated strings. The returned pointer is freed with `lime_occt_string_free`.
#[allow(clippy::too_many_arguments)]
#[no_mangle]
pub unsafe extern "C" fn lime_occt_boolean(
    id: i32,
    op: *const c_char,
    primitive: *const c_char,
    x: f64,
    y: f64,
    z: f64,
    dx: f64,
    dy: f64,
    dz: f64,
    radius: f64,
    height: f64,
    rx: f64,
    ry: f64,
    rz: f64,
    chord_mm: f64,
) -> *mut c_char {
    export_json(boolean(
        id,
        &cstr(op),
        &cstr(primitive),
        Tool {
            origin: [x, y, z],
            size: [dx, dy, dz],
            radius,
            height,
            turn: [rx, ry, rz],
        },
        chord_mm,
    ))
}

/// # Safety
/// `op` and `primitive` are null or valid null-terminated strings. The returned pointer is freed with `lime_occt_string_free`.
/// The solid is not edited.
#[allow(clippy::too_many_arguments)]
#[no_mangle]
pub unsafe extern "C" fn lime_occt_boolean_probe(
    id: i32,
    op: *const c_char,
    primitive: *const c_char,
    x: f64,
    y: f64,
    z: f64,
    dx: f64,
    dy: f64,
    dz: f64,
    radius: f64,
    height: f64,
    rx: f64,
    ry: f64,
    rz: f64,
) -> *mut c_char {
    export_json(boolean_probe(
        id,
        &cstr(op),
        &cstr(primitive),
        Tool {
            origin: [x, y, z],
            size: [dx, dy, dz],
            radius,
            height,
            turn: [rx, ry, rz],
        },
    ))
}

/// The returned pointer is freed with `lime_occt_string_free`. The solid is not edited.
#[no_mangle]
pub extern "C" fn lime_occt_hole_axis_probe(
    id: i32,
    x: f64,
    y: f64,
    z: f64,
    dx: f64,
    dy: f64,
    dz: f64,
    radius_mm: f64,
    depth_mm: f64,
) -> *mut c_char {
    export_json(hole_axis_probe(id, [x, y, z], [dx, dy, dz], radius_mm, depth_mm))
}

/// The returned pointer is freed with `lime_occt_string_free`. The solid is not edited.
#[no_mangle]
pub extern "C" fn lime_occt_hole_probe(
    id: i32,
    x: f64,
    y: f64,
    z: f64,
    radius_mm: f64,
    depth_mm: f64,
) -> *mut c_char {
    export_json(hole_probe(id, [x, y, z], radius_mm, depth_mm))
}

/// The returned pointer is freed with `lime_occt_string_free`.
#[allow(clippy::too_many_arguments)]
#[no_mangle]
pub extern "C" fn lime_occt_split(
    id: i32,
    x: f64,
    y: f64,
    z: f64,
    nx: f64,
    ny: f64,
    nz: f64,
    chord_mm: f64,
) -> *mut c_char {
    export_json(split(
        id,
        Plane {
            origin: [x, y, z],
            normal: [nx, ny, nz],
        },
        chord_mm,
    ))
}

/// The returned pointer is freed with `lime_occt_string_free`.
/// # Safety
/// `edges` is null only when `count` is 0. Otherwise it points at `count` indexes.
#[no_mangle]
pub unsafe extern "C" fn lime_occt_fillet_many(
    id: i32,
    edges: *const i32,
    count: i32,
    radius_mm: f64,
    chord_mm: f64,
) -> *mut c_char {
    export_json(fillet_many(id, unsafe { edge_slice(edges, count) }, radius_mm, chord_mm))
}

/// The returned pointer is freed with `lime_occt_string_free`.
#[no_mangle]
pub extern "C" fn lime_occt_fillet(
    id: i32,
    edge: i32,
    radius_mm: f64,
    chord_mm: f64,
) -> *mut c_char {
    export_json(fillet(id, edge, radius_mm, chord_mm))
}

/// The returned pointer is freed with `lime_occt_string_free`.
/// # Safety
/// `edges` is null only when `count` is 0. Otherwise it points at `count` indexes.
#[no_mangle]
pub unsafe extern "C" fn lime_occt_chamfer_many(
    id: i32,
    edges: *const i32,
    count: i32,
    distance_mm: f64,
    chord_mm: f64,
) -> *mut c_char {
    export_json(chamfer_many(id, unsafe { edge_slice(edges, count) }, distance_mm, chord_mm))
}

/// The returned pointer is freed with `lime_occt_string_free`.
#[no_mangle]
pub extern "C" fn lime_occt_chamfer(
    id: i32,
    edge: i32,
    distance_mm: f64,
    chord_mm: f64,
) -> *mut c_char {
    export_json(chamfer(id, edge, distance_mm, chord_mm))
}

/// The returned pointer is freed with `lime_occt_string_free`.
/// `chamfer` is 0 for a fillet and anything else for a chamfer. The solid is not edited.
/// # Safety
/// `edges` is null only when `count` is 0. Otherwise it points at `count` indexes.
#[no_mangle]
pub unsafe extern "C" fn lime_occt_blend_probe_many(
    id: i32,
    edges: *const i32,
    count: i32,
    size_mm: f64,
    chamfer: i32,
) -> *mut c_char {
    export_json(blend_probe_many(id, unsafe { edge_slice(edges, count) }, size_mm, chamfer != 0))
}

/// The returned pointer is freed with `lime_occt_string_free`.
/// `chamfer` is 0 for a fillet and anything else for a chamfer. The solid is not edited.
#[no_mangle]
pub extern "C" fn lime_occt_blend_probe(
    id: i32,
    edge: i32,
    size_mm: f64,
    chamfer: i32,
) -> *mut c_char {
    export_json(blend_probe(id, edge, size_mm, chamfer != 0))
}

/// The returned pointer is freed with `lime_occt_string_free`.
#[allow(clippy::too_many_arguments)]
#[no_mangle]
pub extern "C" fn lime_occt_hole_axis(
    id: i32,
    x: f64,
    y: f64,
    z: f64,
    dx: f64,
    dy: f64,
    dz: f64,
    radius_mm: f64,
    depth_mm: f64,
    chord_mm: f64,
) -> *mut c_char {
    export_json(hole_axis(
        id,
        [x, y, z],
        [dx, dy, dz],
        radius_mm,
        depth_mm,
        chord_mm,
    ))
}

/// The returned pointer is freed with `lime_occt_string_free`.
#[no_mangle]
pub extern "C" fn lime_occt_hole(
    id: i32,
    x: f64,
    y: f64,
    z: f64,
    radius_mm: f64,
    depth_mm: f64,
    chord_mm: f64,
) -> *mut c_char {
    export_json(hole(id, [x, y, z], radius_mm, depth_mm, chord_mm))
}

/// # Safety
/// `edges` is null only when `count` is not positive. Otherwise it points at `count` indexes that outlive the call.
unsafe fn edge_slice<'a>(edges: *const i32, count: i32) -> &'a [i32] {
    if edges.is_null() || count <= 0 {
        return &[];
    }
    unsafe { std::slice::from_raw_parts(edges, count as usize) }
}

/// The returned pointer is freed with `lime_occt_string_free`.
#[no_mangle]
pub extern "C" fn lime_occt_scale(id: i32, factor: f64, chord_mm: f64) -> *mut c_char {
    export_json(scale(id, factor, chord_mm))
}

/// # Safety
/// `path` is null or a valid null-terminated string. The returned pointer is freed with `lime_occt_string_free`.
#[no_mangle]
pub unsafe extern "C" fn lime_occt_write_step(id: i32, path: *const c_char) -> *mut c_char {
    if path.is_null() {
        return export_json("{\"error\":\"STEP path is empty\"}".into());
    }
    let text = unsafe { CStr::from_ptr(path) }.to_string_lossy();
    export_json(write_step(id, Path::new(text.as_ref())))
}

/// The returned pointer is freed with `lime_occt_string_free`.
#[no_mangle]
pub extern "C" fn lime_occt_undo(id: i32, chord_mm: f64) -> *mut c_char {
    export_json(undo(id, chord_mm))
}

/// The returned pointer is freed with `lime_occt_string_free`.
#[no_mangle]
pub extern "C" fn lime_occt_redo(id: i32, chord_mm: f64) -> *mut c_char {
    export_json(redo(id, chord_mm))
}

/// # Safety
/// `request` is null or a valid null-terminated string. The returned pointer is freed with `lime_occt_string_free`.
#[no_mangle]
pub unsafe extern "C" fn lime_occt_tree(request: *const c_char) -> *mut c_char {
    export_json(tree(&cstr(request)))
}

/// # Safety
/// `text` is null or a pointer returned by one of the `lime_occt_*` JSON functions.
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
        fn lime_model_occt_boolean(
            id: i32,
            op: *const c_char,
            primitive: *const c_char,
            x: f64,
            y: f64,
            z: f64,
            dx: f64,
            dy: f64,
            dz: f64,
            radius: f64,
            height: f64,
            rx: f64,
            ry: f64,
            rz: f64,
            chord: f64,
        ) -> *mut c_char;
        fn lime_model_occt_split(
            id: i32,
            x: f64,
            y: f64,
            z: f64,
            nx: f64,
            ny: f64,
            nz: f64,
            chord: f64,
        ) -> *mut c_char;
        fn lime_model_occt_fillet(id: i32, edge: i32, radius: f64, chord: f64) -> *mut c_char;
        fn lime_model_occt_fillet_many(
            id: i32,
            edges: *const i32,
            count: i32,
            radius: f64,
            chord: f64,
        ) -> *mut c_char;
        fn lime_model_occt_chamfer(id: i32, edge: i32, distance: f64, chord: f64) -> *mut c_char;
        fn lime_model_occt_chamfer_many(
            id: i32,
            edges: *const i32,
            count: i32,
            distance: f64,
            chord: f64,
        ) -> *mut c_char;
        fn lime_model_occt_blend_probe(id: i32, edge: i32, size: f64, chamfer: i32) -> *mut c_char;
        fn lime_model_occt_blend_probe_many(
            id: i32,
            edges: *const i32,
            count: i32,
            size: f64,
            chamfer: i32,
        ) -> *mut c_char;
        fn lime_model_occt_hole_probe(
            id: i32,
            x: f64,
            y: f64,
            z: f64,
            radius: f64,
            depth: f64,
        ) -> *mut c_char;
        fn lime_model_occt_boolean_probe(
            id: i32,
            op: *const c_char,
            primitive: *const c_char,
            x: f64,
            y: f64,
            z: f64,
            dx: f64,
            dy: f64,
            dz: f64,
            radius: f64,
            height: f64,
            rx: f64,
            ry: f64,
            rz: f64,
        ) -> *mut c_char;
        fn lime_model_occt_hole(
            id: i32,
            x: f64,
            y: f64,
            z: f64,
            radius: f64,
            depth: f64,
            chord: f64,
        ) -> *mut c_char;
        fn lime_model_occt_hole_axis(
            id: i32,
            x: f64,
            y: f64,
            z: f64,
            dx: f64,
            dy: f64,
            dz: f64,
            radius: f64,
            depth: f64,
            chord: f64,
        ) -> *mut c_char;
        fn lime_model_occt_hole_axis_probe(
            id: i32,
            x: f64,
            y: f64,
            z: f64,
            dx: f64,
            dy: f64,
            dz: f64,
            radius: f64,
            depth: f64,
        ) -> *mut c_char;
        fn lime_model_occt_scale(id: i32, factor: f64, chord: f64) -> *mut c_char;
        fn lime_model_occt_write_step(id: i32, path: *const c_char) -> *mut c_char;
        fn lime_model_occt_undo(id: i32, chord: f64) -> *mut c_char;
        fn lime_model_occt_redo(id: i32, chord: f64) -> *mut c_char;
        fn lime_model_occt_stats() -> *mut c_char;
        fn lime_model_occt_string_free(text: *mut c_char);
    }

    fn take(ptr: *mut c_char) -> String {
        if ptr.is_null() {
            return "{\"error\":\"Open CASCADE returned nothing\"}".into();
        }
        let text = unsafe { CStr::from_ptr(ptr) }
            .to_string_lossy()
            .into_owned();
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

    pub fn boolean(id: i32, op: &str, primitive: &str, tool: super::Tool, chord_mm: f64) -> String {
        let Ok(op) = CString::new(op) else {
            return "{\"error\":\"boolean op is not a C string\"}".into();
        };
        let Ok(primitive) = CString::new(primitive) else {
            return "{\"error\":\"primitive name is not a C string\"}".into();
        };
        let [x, y, z] = tool.origin;
        let [dx, dy, dz] = tool.size;
        let [rx, ry, rz] = tool.turn;
        take(unsafe {
            lime_model_occt_boolean(
                id,
                op.as_ptr(),
                primitive.as_ptr(),
                x,
                y,
                z,
                dx,
                dy,
                dz,
                tool.radius,
                tool.height,
                rx,
                ry,
                rz,
                chord_mm,
            )
        })
    }

    pub fn split(id: i32, plane: super::Plane, chord_mm: f64) -> String {
        let [x, y, z] = plane.origin;
        let [nx, ny, nz] = plane.normal;
        take(unsafe { lime_model_occt_split(id, x, y, z, nx, ny, nz, chord_mm) })
    }

    pub fn fillet(id: i32, edge: i32, radius_mm: f64, chord_mm: f64) -> String {
        take(unsafe { lime_model_occt_fillet(id, edge, radius_mm, chord_mm) })
    }

    pub fn fillet_many(id: i32, edges: &[i32], radius_mm: f64, chord_mm: f64) -> String {
        let (ptr, count) = edge_ptr(edges);
        take(unsafe { lime_model_occt_fillet_many(id, ptr, count, radius_mm, chord_mm) })
    }

    pub fn chamfer(id: i32, edge: i32, distance_mm: f64, chord_mm: f64) -> String {
        take(unsafe { lime_model_occt_chamfer(id, edge, distance_mm, chord_mm) })
    }

    pub fn chamfer_many(id: i32, edges: &[i32], distance_mm: f64, chord_mm: f64) -> String {
        let (ptr, count) = edge_ptr(edges);
        take(unsafe { lime_model_occt_chamfer_many(id, ptr, count, distance_mm, chord_mm) })
    }

    pub fn blend_probe(id: i32, edge: i32, size_mm: f64, chamfer: bool) -> String {
        take(unsafe { lime_model_occt_blend_probe(id, edge, size_mm, i32::from(chamfer)) })
    }

    pub fn blend_probe_many(id: i32, edges: &[i32], size_mm: f64, chamfer: bool) -> String {
        let (ptr, count) = edge_ptr(edges);
        take(unsafe { lime_model_occt_blend_probe_many(id, ptr, count, size_mm, i32::from(chamfer)) })
    }

    pub fn hole_probe(id: i32, origin: [f64; 3], radius_mm: f64, depth_mm: f64) -> String {
        let [x, y, z] = origin;
        take(unsafe { lime_model_occt_hole_probe(id, x, y, z, radius_mm, depth_mm) })
    }

    pub fn boolean_probe(id: i32, op: &str, primitive: &str, tool: super::Tool) -> String {
        let Ok(op) = CString::new(op) else {
            return "{\"error\":\"boolean op is not a C string\"}".into();
        };
        let Ok(primitive) = CString::new(primitive) else {
            return "{\"error\":\"primitive name is not a C string\"}".into();
        };
        let [x, y, z] = tool.origin;
        let [dx, dy, dz] = tool.size;
        let [rx, ry, rz] = tool.turn;
        take(unsafe {
            lime_model_occt_boolean_probe(
                id,
                op.as_ptr(),
                primitive.as_ptr(),
                x,
                y,
                z,
                dx,
                dy,
                dz,
                tool.radius,
                tool.height,
                rx,
                ry,
                rz,
            )
        })
    }

    pub fn hole(id: i32, origin: [f64; 3], radius_mm: f64, depth_mm: f64, chord_mm: f64) -> String {
        let [x, y, z] = origin;
        take(unsafe { lime_model_occt_hole(id, x, y, z, radius_mm, depth_mm, chord_mm) })
    }

    pub fn hole_axis(
        id: i32,
        origin: [f64; 3],
        direction: [f64; 3],
        radius_mm: f64,
        depth_mm: f64,
        chord_mm: f64,
    ) -> String {
        let [x, y, z] = origin;
        let [dx, dy, dz] = direction;
        take(unsafe {
            lime_model_occt_hole_axis(id, x, y, z, dx, dy, dz, radius_mm, depth_mm, chord_mm)
        })
    }

    pub fn hole_axis_probe(
        id: i32,
        origin: [f64; 3],
        direction: [f64; 3],
        radius_mm: f64,
        depth_mm: f64,
    ) -> String {
        let [x, y, z] = origin;
        let [dx, dy, dz] = direction;
        take(unsafe { lime_model_occt_hole_axis_probe(id, x, y, z, dx, dy, dz, radius_mm, depth_mm) })
    }

    fn edge_ptr(edges: &[i32]) -> (*const i32, i32) {
        if edges.is_empty() {
            (std::ptr::null(), 0)
        } else {
            (edges.as_ptr(), edges.len() as i32)
        }
    }

    pub fn scale(id: i32, factor: f64, chord_mm: f64) -> String {
        take(unsafe { lime_model_occt_scale(id, factor, chord_mm) })
    }

    pub fn write_step(id: i32, path: &Path) -> String {
        let Some(text) = path.to_str() else {
            return "{\"error\":\"STEP path is not UTF-8\"}".into();
        };
        let Ok(c) = CString::new(text) else {
            return "{\"error\":\"STEP path is not a C string\"}".into();
        };
        take(unsafe { lime_model_occt_write_step(id, c.as_ptr()) })
    }

    pub fn undo(id: i32, chord_mm: f64) -> String {
        take(unsafe { lime_model_occt_undo(id, chord_mm) })
    }

    pub fn redo(id: i32, chord_mm: f64) -> String {
        take(unsafe { lime_model_occt_redo(id, chord_mm) })
    }

    pub fn stats() -> String {
        take(unsafe { lime_model_occt_stats() })
    }
}

#[cfg(test)]
mod session_contract {
    #[test]
    fn step_writer_goes_to_a_log_and_a_face_cut_is_refused() {
        let src = include_str!("../cpp/session.cpp").replace("\r\n", "\n");
        let src = src.as_str();
        assert!(src.contains("Message_PrinterOStream"), "{src}");
        assert!(src.contains("lime-slice/occt.log"));
        assert!(src.contains("The plane is too close to a face. Move it into the part."));
        assert!(src.contains("This solid is too thin to split"));
        assert!(src.contains("std::vector<Held> g_redo"));
        assert!(src.contains("lime_model_occt_redo"));
        assert!(src.contains("There is no edit to redo"));
        let checkpoint = src.find("void commit_held(").expect("commit_held");
        let after_checkpoint = src[checkpoint..]
            .find("\n}\n")
            .map(|at| checkpoint + at)
            .expect("commit_held ends");
        let checkpoint_body = &src[checkpoint..after_checkpoint];
        assert!(
            checkpoint_body.contains("g_redo.clear()"),
            "{checkpoint_body}"
        );
        assert!(src.contains("g_redo.clear()"));
        let probe = src
            .find("lime_model_occt_blend_probe")
            .expect("blend probe");
        let hole = src[probe..]
            .find("lime_model_occt_hole")
            .map(|at| probe + at)
            .expect("hole follows the probe");
        let body = &src[probe..hole];
        assert!(src.contains("maxMm"));
        assert!(!body.contains("checkpoint"), "{body}");
        assert!(!body.contains("replace_held"), "{body}");
        for name in [
            "lime_model_occt_hole_probe",
            "lime_model_occt_boolean_probe",
        ] {
            let start = src.find(name).expect(name);
            let end = src[start..]
                .find("\n}\n")
                .map(|at| start + at)
                .expect("probe body ends");
            let body = &src[start..end];
            assert!(body.contains("probe_json"), "{body}");
            assert!(!body.contains("checkpoint"), "{body}");
            assert!(!body.contains("replace_held"), "{body}");
            assert!(!body.contains("commit_edit"), "{body}");
        }
    }

    #[cfg(not(lime_occt))]
    #[test]
    fn missing_kernel_probe_does_not_claim_success() {
        let text = super::blend_probe(1, 0, 2.0, false);
        assert!(text.contains("OCCT_ROOT"), "{text}");
        assert!(!text.contains("\"ok\":true"), "{text}");
    }
}
