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
use lime_slice_core::{slice_payload_watched, Job, Watch};
use serde_json::{json, Value};

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

fn occt_ready() -> bool {
    let reply = model_tree_json(r#"{"call":"close","key":"lime-mcp-occt-probe"}"#);
    let missing = reply.contains("was not found") || reply.contains("Could not load the Open CASCADE bridge");
    !missing
}

#[cfg(not(test))]
mod napi_host {
    use super::{cancel_slice, mesh_preview_json, model_tree_json, occt_ready, poll_slice, start_slice};
    use serde_json::json;
    use std::ffi::{c_char, c_void, CString};
    use std::os::raw::c_int;
    use std::ptr;

    type NapiEnv = *mut c_void;
    type NapiValue = *mut c_void;
    type NapiCallbackInfo = *mut c_void;
    type NapiCallback = unsafe extern "C" fn(NapiEnv, NapiCallbackInfo) -> NapiValue;

    const NAPI_OK: c_int = 0;
    const NAPI_AUTO_LENGTH: usize = usize::MAX;

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
    export_fn(env, exports, "version", version_cb);
    export_fn(env, exports, "sliceStart", slice_start_cb);
    export_fn(env, exports, "slicePoll", slice_poll_cb);
    export_fn(env, exports, "sliceCancel", slice_cancel_cb);
    export_fn(env, exports, "meshPreview", mesh_preview_cb);
    export_fn(env, exports, "modelTree", model_tree_cb);
    export_fn(env, exports, "occt", occt_cb);
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
}
