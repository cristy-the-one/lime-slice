//! In-process engine for the MCP server.
//!
//! The TypeScript server owns the project, the plate, and the tool results.
//! This library is the other side of that split: `slice_payload` and
//! `lime_model_load::tree`, loaded into the same process. It does not change
//! how either function slices or models. A later transport can replace this
//! file without changing the tool schemas.
//!
//! Node loads the cdylib. The N-API symbols come from the host process, so
//! this crate does not link Node and does not open a console window.

#![cfg_attr(test, allow(dead_code))]

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Once};
use std::time::{Duration, Instant};

use base64::Engine;
use lime_sim_bridge::slice_field;
use lime_slice_core::{slice_payload_watched, Job, Watch};
use serde_json::{json, Value};

/// The MCP server lives as long as its client and slices again and again; on
/// the Windows heap each warm slice got slower. mimalloc keeps it as fast as
/// the first.
#[global_allocator]
static ALLOC: mimalloc::MiMalloc = mimalloc::MiMalloc;

const JOB_KEEP: usize = 8;

struct SliceJob {
    id: usize,
    watch: Watch,
    status: &'static str,
    result: Option<String>,
    error: Option<String>,
    deadline: Instant,
}

fn jobs() -> &'static Mutex<Vec<SliceJob>> {
    static JOBS: std::sync::OnceLock<Mutex<Vec<SliceJob>>> = std::sync::OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(Vec::new()))
}

fn slice_timeout() -> Duration {
    let secs = std::env::var("LIME_MCP_SLICE_TIMEOUT_SECS")
        .ok()
        .and_then(|text| text.parse::<u64>().ok())
        .filter(|secs| *secs > 0)
        .unwrap_or(30 * 60);
    Duration::from_secs(secs)
}

fn trim_jobs<T>(jobs: &mut Vec<T>, keep: usize) {
    while jobs.len() >= keep {
        jobs.remove(0);
    }
}

fn next_job_id() -> usize {
    static NEXT: AtomicUsize = AtomicUsize::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

fn ensure_timer() {
    static START: Once = Once::new();
    START.call_once(|| {
        std::thread::spawn(|| loop {
            std::thread::sleep(Duration::from_secs(1));
            let now = Instant::now();
            let due = {
                let guard = match jobs().lock() {
                    Ok(guard) => guard,
                    Err(poisoned) => poisoned.into_inner(),
                };
                guard
                    .iter()
                    .filter(|job| job.status == "running" && now >= job.deadline)
                    .map(|job| job.watch.clone())
                    .collect::<Vec<_>>()
            };
            for watch in due {
                watch.cancel();
            }
        });
    });
}

fn start_slice(body: String) -> Result<usize, String> {
    ensure_timer();
    let watch = Watch::new();
    let id = next_job_id();
    let mut guard = jobs().lock().map_err(|_| "The slice lock failed.".to_string())?;
    trim_jobs(&mut guard, JOB_KEEP);
    guard.push(SliceJob {
        id,
        watch: watch.clone(),
        status: "running",
        result: None,
        error: None,
        deadline: Instant::now() + slice_timeout(),
    });
    drop(guard);
    std::thread::spawn(move || {
        // `includeGcode: false` parks the text and leaves it out of the wire.
        // Put it back so the session can export it. `includeGcode: true` already
        // carries `gcode`, and this closure is not called.
        let parked: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let slot = Arc::clone(&parked);
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            slice_payload_watched(&body, None, Job::default(), &watch, move |gcode| {
                let text = gcode.text();
                if let Ok(mut guard) = slot.lock() {
                    *guard = Some(text);
                }
                "parked".to_string()
            })
        }));
        let mut guard = match jobs().lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        let Some(job) = guard.iter_mut().find(|job| job.id == id) else {
            return;
        };
        match outcome {
            Ok(Ok(text)) => {
                job.status = "done";
                job.result = Some(restore_parked_gcode(&text, &parked));
            }
            Ok(Err(err)) => {
                let message = err.to_string();
                job.status = if message == "cancelled" { "cancelled" } else { "error" };
                job.error = Some(err.json());
            }
            Err(_) => {
                job.status = "error";
                job.error = Some(json!({ "error": "The slicer stopped unexpectedly." }).to_string());
            }
        }
    });
    Ok(id)
}

/// The wire JSON, with parked G-code written back into `gcode`.
fn restore_parked_gcode(wire: &str, parked: &Mutex<Option<String>>) -> String {
    let text = parked.lock().ok().and_then(|mut guard| guard.take());
    let Some(text) = text else {
        return wire.to_string();
    };
    let mut value: Value = match serde_json::from_str(wire) {
        Ok(value) => value,
        Err(_) => return wire.to_string(),
    };
    if let Some(obj) = value.as_object_mut() {
        obj.insert("gcode".to_string(), Value::String(text));
        obj.remove("gcodeToken");
    }
    value.to_string()
}

fn poll_slice(id: usize) -> String {
    let mut guard = match jobs().lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let Some(job) = guard.iter_mut().find(|job| job.id == id) else {
        return json!({ "error": "That slice job is not in this session." }).to_string();
    };
    let snap = job.watch.snapshot();
    let result = if job.status == "done" { job.result.take() } else { job.result.clone() };
    json!({
        "status": job.status,
        "stage": snap.stage,
        "fraction": snap.fraction,
        "result": result,
        "error": job.error,
    })
    .to_string()
}

fn cancel_slice(id: usize) -> String {
    let guard = match jobs().lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let Some(job) = guard.iter().find(|job| job.id == id) else {
        return json!({ "ok": false, "error": "That slice job is not in this session." }).to_string();
    };
    job.watch.cancel();
    json!({ "ok": true, "status": job.status }).to_string()
}

fn mesh_preview_json(body: &str) -> String {
    // A test holds the worker thread so the stdio loop can still answer ping.
    if let Ok(text) = std::env::var("LIME_MCP_PREVIEW_DELAY_MS") {
        if let Ok(ms) = text.parse::<u64>() {
            if ms > 0 {
                std::thread::sleep(Duration::from_millis(ms));
            }
        }
    }
    let value: Value = match serde_json::from_str(body) {
        Ok(value) => value,
        Err(err) => return json!({ "error": format!("The mesh request is not JSON. {err}") }).to_string(),
    };
    let filename = value.get("filename").and_then(Value::as_str).unwrap_or("mesh.stl");
    let Some(encoded) = value.get("dataB64").and_then(Value::as_str) else {
        return json!({ "error": "The mesh request has no data." }).to_string();
    };
    let bytes = match base64::engine::general_purpose::STANDARD.decode(encoded) {
        Ok(bytes) => bytes,
        Err(_) => return json!({ "error": "The mesh data is not base64." }).to_string(),
    };
    let tolerance = value.get("stepToleranceMm").and_then(Value::as_f64).unwrap_or(0.05);
    match lime_slice_core::mesh_preview_tol(filename, &bytes, tolerance) {
        Ok(preview) => {
            let mut raw = Vec::with_capacity(preview.positions.len() * 4);
            for value in &preview.positions {
                raw.extend_from_slice(&value.to_le_bytes());
            }
            json!({
                "triangles": preview.triangles,
                "min": preview.min,
                "max": preview.max,
                "seatMm": preview.seat_mm,
                "positionsB64": base64::engine::general_purpose::STANDARD.encode(raw),
            })
            .to_string()
        }
        Err(err) => json!({ "error": err }).to_string(),
    }
}

fn model_tree_json(body: &str) -> String {
    match lime_model_load::tree(body) {
        Ok(text) => text,
        Err(err) => json!({ "error": err }).to_string(),
    }
}

fn json_error(err: impl std::fmt::Display) -> String {
    json!({ "error": err.to_string() }).to_string()
}

/// Calibration towers. `kind` selects the public builder. The slicer crates are unchanged.
fn calibrate_json(body: &str) -> String {
    let value: Value = match serde_json::from_str(body) {
        Ok(value) => value,
        Err(err) => return json_error(err),
    };
    let kind = value.get("kind").and_then(Value::as_str).unwrap_or("");
    match kind {
        "pa" => match serde_json::from_value::<lime_slice_core::PaCalibRequest>(value) {
            Ok(req) => match lime_slice_core::pressure_advance_from_request(&req) {
                Ok(out) => serde_json::to_string(&out).unwrap_or_else(json_error),
                Err(err) => json_error(err),
            },
            Err(err) => json_error(err),
        },
        "flow" => match serde_json::from_value::<lime_slice_core::FlowCalibRequest>(value) {
            Ok(req) => match lime_slice_core::flow_from_request(&req) {
                Ok(out) => serde_json::to_string(&out).unwrap_or_else(json_error),
                Err(err) => json_error(err),
            },
            Err(err) => json_error(err),
        },
        "temp" => match serde_json::from_value::<lime_slice_core::TempCalibRequest>(value) {
            Ok(req) => match lime_slice_core::temperature_from_request(&req) {
                Ok(out) => serde_json::to_string(&out).unwrap_or_else(json_error),
                Err(err) => json_error(err),
            },
            Err(err) => json_error(err),
        },
        "retract" => match serde_json::from_value::<lime_slice_core::RetractCalibRequest>(value) {
            Ok(req) => match lime_slice_core::retract_from_request(&req) {
                Ok(out) => serde_json::to_string(&out).unwrap_or_else(json_error),
                Err(err) => json_error(err),
            },
            Err(err) => json_error(err),
        },
        _ => json_error("kind is pa, flow, temp, or retract."),
    }
}

/// Five to ten blend points for one slice body. No G-code text.
fn pareto_json(body: &str) -> String {
    let req: lime_slice_core::SliceRequest = match serde_json::from_str(body) {
        Ok(req) => req,
        Err(err) => return json_error(err),
    };
    match lime_slice_core::pareto_request(&req, lime_slice_core::Job::default()) {
        Ok(points) => serde_json::to_string(&points).unwrap_or_else(json_error),
        Err(err) => json_error(err),
    }
}

/// `{ "request": <slice request>, "path": <file> }`: writes the object's
/// `slice-field-1` to `path` and answers with its header and size.
fn slice_field_json(body: &str) -> String {
    let value: Value = match serde_json::from_str(body) {
        Ok(value) => value,
        Err(err) => return json_error(format!("The slice field request is not JSON. {err}")),
    };
    let Some(path) = value.get("path").and_then(Value::as_str) else {
        return json_error("The slice field request has no path.");
    };
    let req: lime_slice_core::SliceRequest = match value.get("request").cloned().map(serde_json::from_value) {
        Some(Ok(req)) => req,
        Some(Err(err)) => return json_error(err),
        None => return json_error("The slice field request has no slice request."),
    };
    let field = match slice_field(&req, Job::default(), &Watch::idle()) {
        Ok(field) => field,
        Err(err) => return json_error(err),
    };
    let bytes = field.encode();
    if let Err(err) = std::fs::write(path, &bytes) {
        return json_error(format!("The slice field could not be written. {err}"));
    }
    json!({
        "path": path,
        "bytes": bytes.len(),
        "sliceHash": field.header.slice_hash,
        "layers": field.header.layers.len(),
        "segments": field.header.segment_count,
        "layerNormal": field.header.layer_normal,
        "volumeMm3": field.total_volume_mm3(),
    })
    .to_string()
}

/// A stress study of one object as it is sliced: `lime_sim_bridge::study_json`.
fn sim_study_json(body: &str) -> String {
    lime_sim_bridge::study_json(body)
}

fn occt_ready() -> bool {
    let reply = model_tree_json(r#"{"call":"close","key":"lime-mcp-occt-probe"}"#);
    let missing = reply.contains("was not found") || reply.contains("Could not load the Open CASCADE bridge");
    !missing
}

#[cfg(not(test))]
mod napi_host {
    use super::{
        calibrate_json, cancel_slice, mesh_preview_json, model_tree_json, occt_ready, pareto_json, poll_slice,
        sim_study_json, slice_field_json, start_slice,
    };
    use serde_json::json;
    #[cfg(not(windows))]
    use std::ffi::c_char;
    use std::ffi::{c_void, CString};
    use std::os::raw::c_int;
    use std::ptr;

    pub(super) type NapiEnv = *mut c_void;
    pub(super) type NapiValue = *mut c_void;
    pub(super) type NapiCallbackInfo = *mut c_void;
    pub(super) type NapiCallback = unsafe extern "C" fn(NapiEnv, NapiCallbackInfo) -> NapiValue;

    const NAPI_OK: c_int = 0;
    const NAPI_AUTO_LENGTH: usize = usize::MAX;

    /// Node exports `napi_*` from the process that loads this file (`node.exe`
    /// on Windows). Binding them here keeps the DLL free of unresolved imports.
    #[cfg(windows)]
    mod win_napi {
        use super::{NapiCallback, NapiCallbackInfo, NapiEnv, NapiValue};
        use std::ffi::{c_char, c_void};
        use std::os::raw::c_int;
        use std::sync::OnceLock;

        type CreateFunction = unsafe extern "C" fn(
            NapiEnv,
            *const c_char,
            usize,
            NapiCallback,
            *mut c_void,
            *mut NapiValue,
        ) -> c_int;
        type SetNamedProperty = unsafe extern "C" fn(NapiEnv, NapiValue, *const c_char, NapiValue) -> c_int;
        type CreateString = unsafe extern "C" fn(NapiEnv, *const u8, usize, *mut NapiValue) -> c_int;
        type GetCbInfo = unsafe extern "C" fn(
            NapiEnv,
            NapiCallbackInfo,
            *mut usize,
            *mut NapiValue,
            *mut NapiValue,
            *mut *mut c_void,
        ) -> c_int;
        type GetString = unsafe extern "C" fn(NapiEnv, NapiValue, *mut u8, usize, *mut usize) -> c_int;
        type ThrowError = unsafe extern "C" fn(NapiEnv, *const c_char, *const c_char) -> c_int;

        struct NapiApi {
            create_function: CreateFunction,
            set_named_property: SetNamedProperty,
            create_string_utf8: CreateString,
            get_cb_info: GetCbInfo,
            get_value_string_utf8: GetString,
            throw_error: ThrowError,
        }

        #[link(name = "kernel32")]
        extern "system" {
            fn GetModuleHandleW(module: *const u16) -> *mut c_void;
            fn GetProcAddress(module: *mut c_void, name: *const c_char) -> *mut c_void;
        }

        unsafe fn bind<T>(module: *mut c_void, name: &[u8]) -> Option<T> {
            assert_eq!(std::mem::size_of::<T>(), std::mem::size_of::<*mut c_void>());
            let ptr = GetProcAddress(module, name.as_ptr().cast());
            if ptr.is_null() {
                None
            } else {
                Some(std::mem::transmute_copy(&ptr))
            }
        }

        fn api() -> Option<&'static NapiApi> {
            static SLOT: OnceLock<Option<NapiApi>> = OnceLock::new();
            SLOT.get_or_init(|| unsafe { load() }).as_ref()
        }

        unsafe fn load() -> Option<NapiApi> {
            let module = GetModuleHandleW(std::ptr::null());
            if module.is_null() {
                return None;
            }
            Some(NapiApi {
                create_function: bind(module, b"napi_create_function\0")?,
                set_named_property: bind(module, b"napi_set_named_property\0")?,
                create_string_utf8: bind(module, b"napi_create_string_utf8\0")?,
                get_cb_info: bind(module, b"napi_get_cb_info\0")?,
                get_value_string_utf8: bind(module, b"napi_get_value_string_utf8\0")?,
                throw_error: bind(module, b"napi_throw_error\0")?,
            })
        }

        pub(super) unsafe fn napi_create_function(
            env: NapiEnv,
            utf8name: *const c_char,
            length: usize,
            cb: NapiCallback,
            data: *mut c_void,
            result: *mut NapiValue,
        ) -> c_int {
            let Some(api) = api() else {
                return 1;
            };
            (api.create_function)(env, utf8name, length, cb, data, result)
        }

        pub(super) unsafe fn napi_set_named_property(
            env: NapiEnv,
            object: NapiValue,
            utf8name: *const c_char,
            value: NapiValue,
        ) -> c_int {
            let Some(api) = api() else {
                return 1;
            };
            (api.set_named_property)(env, object, utf8name, value)
        }

        pub(super) unsafe fn napi_create_string_utf8(
            env: NapiEnv,
            str_: *const u8,
            length: usize,
            result: *mut NapiValue,
        ) -> c_int {
            let Some(api) = api() else {
                return 1;
            };
            (api.create_string_utf8)(env, str_, length, result)
        }

        pub(super) unsafe fn napi_get_cb_info(
            env: NapiEnv,
            cbinfo: NapiCallbackInfo,
            argc: *mut usize,
            argv: *mut NapiValue,
            this_arg: *mut NapiValue,
            data: *mut *mut c_void,
        ) -> c_int {
            let Some(api) = api() else {
                return 1;
            };
            (api.get_cb_info)(env, cbinfo, argc, argv, this_arg, data)
        }

        pub(super) unsafe fn napi_get_value_string_utf8(
            env: NapiEnv,
            value: NapiValue,
            buf: *mut u8,
            bufsize: usize,
            result: *mut usize,
        ) -> c_int {
            let Some(api) = api() else {
                return 1;
            };
            (api.get_value_string_utf8)(env, value, buf, bufsize, result)
        }

        pub(super) unsafe fn napi_throw_error(env: NapiEnv, code: *const c_char, msg: *const c_char) -> c_int {
            let Some(api) = api() else {
                return 1;
            };
            (api.throw_error)(env, code, msg)
        }
    }

    #[cfg(windows)]
    use win_napi::{
        napi_create_function, napi_create_string_utf8, napi_get_cb_info, napi_get_value_string_utf8, napi_set_named_property,
        napi_throw_error,
    };

    #[cfg(not(windows))]
    extern "C" {
        fn napi_create_function(
            env: NapiEnv,
            utf8name: *const c_char,
            length: usize,
            cb: NapiCallback,
            data: *mut c_void,
            result: *mut NapiValue,
        ) -> c_int;
        fn napi_set_named_property(env: NapiEnv, object: NapiValue, utf8name: *const c_char, value: NapiValue) -> c_int;
        fn napi_create_string_utf8(env: NapiEnv, str_: *const u8, length: usize, result: *mut NapiValue) -> c_int;
        fn napi_get_cb_info(
            env: NapiEnv,
            cbinfo: NapiCallbackInfo,
            argc: *mut usize,
            argv: *mut NapiValue,
            this_arg: *mut NapiValue,
            data: *mut *mut c_void,
        ) -> c_int;
        fn napi_get_value_string_utf8(
            env: NapiEnv,
            value: NapiValue,
            buf: *mut u8,
            bufsize: usize,
            result: *mut usize,
        ) -> c_int;
        fn napi_throw_error(env: NapiEnv, code: *const c_char, msg: *const c_char) -> c_int;
    }

    unsafe fn arg_string(env: NapiEnv, info: NapiCallbackInfo) -> Result<String, ()> {
    let mut argc: usize = 1;
    let mut argv: NapiValue = ptr::null_mut();
    if napi_get_cb_info(env, info, &mut argc, &mut argv, ptr::null_mut(), ptr::null_mut()) != NAPI_OK || argc < 1 {
        throw(env, "This engine call needs a string.");
        return Err(());
    }
    let mut len: usize = 0;
    if napi_get_value_string_utf8(env, argv, ptr::null_mut(), 0, &mut len) != NAPI_OK {
        throw(env, "This engine call needs a string.");
        return Err(());
    }
    let mut buf = vec![0u8; len + 1];
    if napi_get_value_string_utf8(env, argv, buf.as_mut_ptr(), buf.len(), &mut len) != NAPI_OK {
        throw(env, "This engine call needs a string.");
        return Err(());
    }
    buf.truncate(len);
    String::from_utf8(buf).map_err(|_| {
        throw(env, "This engine call was not UTF-8.");
    })
}

unsafe fn return_string(env: NapiEnv, text: &str) -> NapiValue {
    let mut result: NapiValue = ptr::null_mut();
    napi_create_string_utf8(env, text.as_ptr(), text.len(), &mut result);
    result
}

unsafe fn throw(env: NapiEnv, message: &str) {
    let text = CString::new(message).unwrap_or_else(|_| CString::new("The engine call failed.").unwrap());
    napi_throw_error(env, ptr::null(), text.as_ptr());
}

unsafe extern "C" fn version_cb(env: NapiEnv, _info: NapiCallbackInfo) -> NapiValue {
    return_string(env, env!("CARGO_PKG_VERSION"))
}

unsafe extern "C" fn slice_start_cb(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    let Ok(body) = arg_string(env, info) else {
        return ptr::null_mut();
    };
    let text = match start_slice(body) {
        Ok(id) => json!({ "id": id }).to_string(),
        Err(err) => json!({ "error": err }).to_string(),
    };
    return_string(env, &text)
}

unsafe extern "C" fn slice_poll_cb(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    let Ok(body) = arg_string(env, info) else {
        return ptr::null_mut();
    };
    let id = body.parse::<usize>().unwrap_or(usize::MAX);
    return_string(env, &poll_slice(id))
}

unsafe extern "C" fn slice_cancel_cb(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    let Ok(body) = arg_string(env, info) else {
        return ptr::null_mut();
    };
    let id = body.parse::<usize>().unwrap_or(usize::MAX);
    return_string(env, &cancel_slice(id))
}

unsafe extern "C" fn mesh_preview_cb(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    let Ok(body) = arg_string(env, info) else {
        return ptr::null_mut();
    };
    return_string(env, &mesh_preview_json(&body))
}

unsafe extern "C" fn model_tree_cb(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    let Ok(body) = arg_string(env, info) else {
        return ptr::null_mut();
    };
    return_string(env, &model_tree_json(&body))
}

unsafe extern "C" fn occt_cb(env: NapiEnv, _info: NapiCallbackInfo) -> NapiValue {
    return_string(env, if occt_ready() { "true" } else { "false" })
}

unsafe extern "C" fn calibrate_cb(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    let Ok(body) = arg_string(env, info) else {
        return ptr::null_mut();
    };
    return_string(env, &calibrate_json(&body))
}

unsafe extern "C" fn pareto_cb(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    let Ok(body) = arg_string(env, info) else {
        return ptr::null_mut();
    };
    return_string(env, &pareto_json(&body))
}

unsafe extern "C" fn slice_field_cb(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    let Ok(body) = arg_string(env, info) else {
        return ptr::null_mut();
    };
    return_string(env, &slice_field_json(&body))
}

unsafe extern "C" fn sim_study_cb(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    let Ok(body) = arg_string(env, info) else {
        return ptr::null_mut();
    };
    return_string(env, &sim_study_json(&body))
}

unsafe fn export_fn(env: NapiEnv, exports: NapiValue, name: &str, cb: NapiCallback) {
    let c_name = CString::new(name).unwrap();
    let mut func: NapiValue = ptr::null_mut();
    if napi_create_function(env, c_name.as_ptr(), NAPI_AUTO_LENGTH, cb, ptr::null_mut(), &mut func) != NAPI_OK {
        return;
    }
    napi_set_named_property(env, exports, c_name.as_ptr(), func);
}

/// Node's addon entry. The process that loads this file provides the N-API symbols.
#[no_mangle]
pub unsafe extern "C" fn napi_register_module_v1(env: NapiEnv, exports: NapiValue) -> NapiValue {
    static STEP_MESHER: std::sync::Once = std::sync::Once::new();
    STEP_MESHER.call_once(|| {
        if let Some((mesher, identity)) = lime_model_load::step_mesher() {
            lime_slice_core::set_step_mesher(mesher, identity);
        }
    });

    export_fn(env, exports, "version", version_cb);
    export_fn(env, exports, "sliceStart", slice_start_cb);
    export_fn(env, exports, "slicePoll", slice_poll_cb);
    export_fn(env, exports, "sliceCancel", slice_cancel_cb);
    export_fn(env, exports, "meshPreview", mesh_preview_cb);
    export_fn(env, exports, "modelTree", model_tree_cb);
    export_fn(env, exports, "occt", occt_cb);
    export_fn(env, exports, "calibrate", calibrate_cb);
    export_fn(env, exports, "pareto", pareto_cb);
    export_fn(env, exports, "sliceField", slice_field_cb);
    export_fn(env, exports, "simStudy", sim_study_cb);
    exports
}

}

#[cfg(test)]
mod tests {
    use super::mesh_preview_json;
    use base64::Engine;

    fn cube_stl() -> String {
        let mut bytes = vec![0u8; 84];
        bytes[80..84].copy_from_slice(&12u32.to_le_bytes());
        let tris: [[f32; 9]; 12] = [
            [0.0, 0.0, 0.0, 20.0, 0.0, 0.0, 20.0, 20.0, 0.0],
            [0.0, 0.0, 0.0, 20.0, 20.0, 0.0, 0.0, 20.0, 0.0],
            [0.0, 0.0, 20.0, 20.0, 20.0, 20.0, 20.0, 0.0, 20.0],
            [0.0, 0.0, 20.0, 0.0, 20.0, 20.0, 20.0, 20.0, 20.0],
            [0.0, 0.0, 0.0, 0.0, 20.0, 20.0, 0.0, 0.0, 20.0],
            [0.0, 0.0, 0.0, 0.0, 20.0, 0.0, 0.0, 20.0, 20.0],
            [20.0, 0.0, 0.0, 20.0, 0.0, 20.0, 20.0, 20.0, 20.0],
            [20.0, 0.0, 0.0, 20.0, 20.0, 20.0, 20.0, 20.0, 0.0],
            [0.0, 0.0, 0.0, 20.0, 0.0, 20.0, 20.0, 0.0, 0.0],
            [0.0, 0.0, 0.0, 0.0, 0.0, 20.0, 20.0, 0.0, 20.0],
            [0.0, 20.0, 0.0, 20.0, 20.0, 0.0, 20.0, 20.0, 20.0],
            [0.0, 20.0, 0.0, 20.0, 20.0, 20.0, 0.0, 20.0, 20.0],
        ];
        for tri in tris {
            bytes.extend_from_slice(&[0u8; 12]);
            for value in tri {
                bytes.extend_from_slice(&value.to_le_bytes());
            }
            bytes.extend_from_slice(&[0u8; 2]);
        }
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    #[test]
    fn newest_jobs_stay_bounded() {
        let mut jobs = Vec::new();
        for id in 0..200 {
            super::trim_jobs(&mut jobs, super::JOB_KEEP);
            jobs.push(id);
        }
        assert_eq!(jobs.len(), 8);
        assert_eq!(jobs[0], 192);
    }

    #[test]
    fn one_timer_serves_every_slice() {
        super::ensure_timer();
        super::ensure_timer();
    }

    #[test]
    fn a_pressure_advance_tower_uses_the_public_builder() {
        let body = r#"{"kind":"pa","firmware":"klipper","start":0.0,"end":0.01,"step":0.01}"#;
        let reply: serde_json::Value = serde_json::from_str(&super::calibrate_json(body)).unwrap();
        assert!(reply.get("error").is_none(), "{reply}");
        assert!(reply["gcode"].as_str().unwrap().contains("PA_CALIBRATION"));
        assert_eq!(reply["bands"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn an_unknown_tower_is_a_sentence() {
        let reply: serde_json::Value = serde_json::from_str(&super::calibrate_json(r#"{"kind":"nope"}"#)).unwrap();
        assert!(reply["error"].as_str().unwrap().contains("pa"));
    }

    fn cube_request(extra: serde_json::Value) -> lime_slice_core::SliceRequest {
        let mut body = serde_json::json!({
            "filename": "cube.stl",
            "dataB64": cube_stl(),
            "layerHeight": 0.2,
            "lineWidth": 0.45,
            "baseline": false,
            "compare": false,
            "includePreview": false,
            "includeGcode": true,
        });
        for (key, value) in extra.as_object().unwrap() {
            body[key] = value.clone();
        }
        serde_json::from_value(body).unwrap()
    }

    /// The sliced plan's 9.1: the field holds the G-code's extrusion less
    /// the skirt, and reads back. Its rows are f32, so it matches the beads
    /// to the rounding of a millimetre value in a float.
    #[test]
    fn a_slice_field_is_the_writers_extrusion_less_what_carries_nothing() {
        use lime_sim::slice_field::SliceField;
        let req = cube_request(serde_json::json!({}));
        let job = lime_slice_core::Job::default();
        let field = super::slice_field(&req, job, &lime_slice_core::Watch::idle()).unwrap();
        let reply = lime_slice_core::slice_beads(&req, job, &lime_slice_core::Watch::idle()).unwrap();
        let sliced = reply.beads.as_ref().unwrap();
        let area = std::f64::consts::PI * (1.75_f64 * 0.5).powi(2);
        let fed = reply.estimate.filament_mm * area;
        let all: f64 = sliced.beads.iter().map(|b| b.volume_mm3()).sum();
        let idle: f64 = sliced
            .beads
            .iter()
            .filter(|b| matches!(b.kind.as_str(), "skirt" | "support" | "support-interface" | "ironing"))
            .map(|b| b.volume_mm3())
            .sum();
        assert!(idle > 0.0, "the cube's skirt is in the beads");
        assert!(((all - fed) / fed).abs() < 1e-6, "beads {all}, G-code {fed}");
        let kept = field.total_volume_mm3();
        assert!(((kept - (all - idle)) / kept).abs() < 1e-5, "field {kept}, beads {}", all - idle);
        // The rows are bytes and read back exactly. The header is JSON, whose
        // default float parse can land one ulp away.
        let back = SliceField::decode(&field.encode()).unwrap();
        assert_eq!(back.segments, field.segments);
        assert_eq!(back.header.layers.len(), field.header.layers.len());
        for (a, b) in back.header.layers.iter().zip(&field.header.layers) {
            assert_eq!((a.index, a.bead_start, a.bead_count), (b.index, b.bead_start, b.bead_count));
            assert!((a.z_mm - b.z_mm).abs() < 1e-12 && (a.height_mm - b.height_mm).abs() < 1e-12);
        }
        assert_eq!(field.header.layer_normal, [0.0, 0.0, 1.0]);
        assert_eq!(field.header.slice_hash.len(), 64);
    }

    #[test]
    fn a_slice_field_is_written_where_it_is_asked_for() {
        let dir = std::env::temp_dir().join(format!("lime-field-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("cube.lsf");
        let body = serde_json::json!({
            "request": serde_json::to_value(cube_request(serde_json::json!({}))).unwrap(),
            "path": path.to_str().unwrap(),
        });
        let reply: serde_json::Value = serde_json::from_str(&super::slice_field_json(&body.to_string())).unwrap();
        assert!(reply.get("error").is_none(), "{reply}");
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(reply["bytes"], bytes.len());
        assert!(reply["segments"].as_u64().unwrap() > 1000);
        let _ = std::fs::remove_dir_all(&dir);
        let missing: serde_json::Value = serde_json::from_str(&super::slice_field_json(r#"{"request":{}}"#)).unwrap();
        assert_eq!(missing["error"], "The slice field request has no path.");
    }

    #[test]
    fn preview_reads_a_cube_without_touching_the_slicer_binary() {
        let body = serde_json::json!({
            "filename": "cube.stl",
            "dataB64": cube_stl(),
            "stepToleranceMm": 0.05
        });
        let reply: serde_json::Value = serde_json::from_str(&mesh_preview_json(&body.to_string())).unwrap();
        assert_eq!(reply["triangles"], 12);
        assert!(reply["positionsB64"].as_str().unwrap().len() > 10);
        assert!(reply.get("error").is_none());
    }

    fn box_stl(x: f64, y: f64, z: f64) -> String {
        let faces = [
            [[0.0, 0.0, 0.0], [x, 0.0, 0.0], [x, y, 0.0]],
            [[0.0, 0.0, 0.0], [x, y, 0.0], [0.0, y, 0.0]],
            [[0.0, 0.0, z], [x, y, z], [x, 0.0, z]],
            [[0.0, 0.0, z], [0.0, y, z], [x, y, z]],
            [[0.0, 0.0, 0.0], [x, 0.0, z], [x, 0.0, 0.0]],
            [[0.0, 0.0, 0.0], [0.0, 0.0, z], [x, 0.0, z]],
            [[0.0, y, 0.0], [x, y, 0.0], [x, y, z]],
            [[0.0, y, 0.0], [x, y, z], [0.0, y, z]],
            [[0.0, 0.0, 0.0], [0.0, y, 0.0], [0.0, y, z]],
            [[0.0, 0.0, 0.0], [0.0, y, z], [0.0, 0.0, z]],
            [[x, 0.0, 0.0], [x, y, z], [x, y, 0.0]],
            [[x, 0.0, 0.0], [x, 0.0, z], [x, y, z]],
        ];
        let mut out = String::from("solid box\n");
        for face in faces {
            out.push_str("facet normal 0 0 0\nouter loop\n");
            for v in face {
                out.push_str(&format!("vertex {} {} {}\n", v[0], v[1], v[2]));
            }
            out.push_str("endloop\nendfacet\n");
        }
        out.push_str("endsolid box\n");
        out
    }

    /// Hold the face at the lowest X, pull the face at the highest X down by
    /// 2 N, on an isotropic card.
    fn bend(mesh: lime_sim::Mesh, representation: &str, cells: Vec<lime_sim::sliced::CellMaterial>, h: f64) -> lime_sim::Solution {
        use lime_sim::{Hold, Load, NodeHold};
        let lo = mesh.nodes.iter().map(|p| p[0]).fold(f64::INFINITY, f64::min);
        let hi = mesh.nodes.iter().map(|p| p[0]).fold(f64::NEG_INFINITY, f64::max);
        let holds = mesh
            .nodes
            .iter()
            .enumerate()
            .filter(|(_, p)| (p[0] - lo).abs() < 1e-6)
            .map(|(node, _)| NodeHold { node, hold: Hold::Fixed })
            .collect();
        let tip = lime_sim::mesh::faces_on_plane(&mesh, 0, hi, 1e-6);
        let area: f64 = tip.iter().map(|f| f.area).sum();
        let loads = tip
            .into_iter()
            .map(|face| Load::Traction { nodes: face.nodes, traction: [0.0, 0.0, -2.0 / area] })
            .collect();
        lime_sim::solve_request(&lime_sim::study::Request {
            mesh,
            material: lime_sim::material::LinearOrthotropic::isotropic(2000.0, 0.35, 1.24),
            recipe: lime_sim::recipe::Recipe::solid(),
            build_axis: [0.0, 0.0, 1.0],
            holds,
            loads,
            steps: vec![lime_sim::study::Step { factor: 1.0, max_iter: 1, tol: 1e-10 }],
            linear: true,
            gravity: None,
            h_mm: h,
            allow_linear_tets: false,
            analysis: "static".into(),
            temperature_c: None,
            fibre_axis: None,
            solver: "faer-ldlt".into(),
            representation: representation.into(),
            cells,
            beads: None,
            post_steps: Vec::new(),
            provisional: false,
            cancel: None,
            on_progress: None,
        })
        .unwrap_or_else(|err| panic!("{}", err.message))
    }

    /// The sliced plan's 9.2 on a real slice: a 100% infill bar under
    /// bending, its walls and its diagonal infill as the slicer lays them,
    /// solved as sliced. On an isotropic card the tip lands within 3% of the
    /// smeared bar on cells of the same size.
    #[test]
    fn a_solid_slice_bends_as_its_smear_does() {
        use lime_sim::sliced::{SlicedGrid, PHI_MIN};
        let (l, w, t) = (30.0, 6.0, 4.0);
        let req: lime_slice_core::SliceRequest = serde_json::from_value(serde_json::json!({
            "filename": "bar.stl",
            "dataB64": base64::engine::general_purpose::STANDARD.encode(box_stl(l, w, t)),
            "layerHeight": 0.2,
            "lineWidth": 0.45,
            "infill": 1.0,
            "baseline": false,
            "compare": false,
            "includePreview": false,
            "includeGcode": true,
        }))
        .unwrap();
        let field = super::slice_field(&req, lime_slice_core::Job::default(), &lime_slice_core::Watch::idle()).unwrap();
        let h = 1.0;
        let grid = SlicedGrid::rasterize(&field, h).unwrap();
        // Every bead of the field is in the grid, to the rounding of clipping
        // thin f32 rectangles (the plan asks 2%), and the solid cells hold
        // nearly all of it.
        let total = field.total_volume_mm3();
        assert!(((grid.deposited_mm3 - total) / total).abs() < 1e-6, "grid {} field {total}", grid.deposited_mm3);
        let meshed = grid.mesh(PHI_MIN).unwrap();
        assert!(meshed.solid_deposited_mm3 > 0.98 * total, "{} of {total}", meshed.solid_deposited_mm3);
        let sliced = bend(meshed.mesh, "sliced", meshed.cells, h);
        let div = [(l / h).round() as usize, (w / h).round() as usize, (t / h).round() as usize];
        let smear = lime_sim::mesh::grid([0.0, 0.0, 0.0], [l, w, t], div, lime_sim::ElementKind::Tet10).unwrap();
        let smeared = bend(smear, "smear", Vec::new(), h);
        let rel = (sliced.max_displacement_mm - smeared.max_displacement_mm) / smeared.max_displacement_mm;
        assert!(
            rel.abs() < 0.03,
            "sliced {:.5} mm, smeared {:.5} mm, {:+.2}%",
            sliced.max_displacement_mm,
            smeared.max_displacement_mm,
            rel * 100.0
        );
    }
}
