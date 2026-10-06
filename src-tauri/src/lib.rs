use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex, PoisonError};
use std::time::{Duration, Instant};

use lime_slice_core::{
    cancel_all, keep_support_bases, load_slice_mesh_tol, mesh_preview_tol, pareto_estimates,
    flow_from_request, pressure_advance_from_request, slice_payload_watched, strategy_card,
    temperature_from_request, FlowCalibRequest, GcodeText, Job, PaCalibRequest, PayloadError,
    Progress, SliceCache, SliceRequest, SliceSettings, Status, TempCalibRequest, Watch,
};
use serde_json::{json, Value};
use tauri::AppHandle;
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

mod prusa_http;
use prusa_http::prusa_link_http;

fn gcode_store() -> &'static Mutex<HashMap<String, GcodeText>> {
    static STORE: std::sync::LazyLock<Mutex<HashMap<String, GcodeText>>> =
        std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
    &STORE
}

fn park_gcode(text: GcodeText) -> String {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let token = NEXT.fetch_add(1, Ordering::Relaxed).to_string();
    let mut guard = gcode_store().lock().expect("gcode store");
    if guard.len() > 6 {
        guard.clear();
    }
    guard.insert(token.clone(), text);
    token
}

/// Disk budget for kept slices. Past it, the least recently used go first.
const SLICE_CACHE_BYTES: u64 = 2 << 30;

/// About 10 Hz. The terminal event is sent whenever it happens.
const PROGRESS_EVERY: Duration = Duration::from_millis(100);

/// The newest slice's watch, so `cancel_slice` stops it at the next boundary.
static CURRENT: Mutex<Watch> = Mutex::new(Watch::idle());

/// The web UI's stage names, from the file `src/ui/slice-job.ts` imports.
fn stage_label(stage: &str) -> String {
    static LABELS: LazyLock<HashMap<String, String>> = LazyLock::new(|| {
        serde_json::from_str(include_str!("../../src/ui/stage-labels.json")).expect("stage labels")
    });
    LABELS
        .get(stage)
        .cloned()
        .unwrap_or_else(|| stage.to_string())
}

/// The `slice-progress` event the UI listens for.
fn progress_event(progress: &Progress) -> Value {
    json!({
        "progress": progress.fraction,
        "message": stage_label(progress.stage),
        "stage": progress.stage,
        "done": progress.done,
        "total": progress.total,
        "status": progress.status.as_str(),
    })
}

/// Emits the newest state at most once per `every`, and the terminal state
/// always. Returns after the terminal one.
fn forward_progress(watch: &Watch, every: Duration, mut emit: impl FnMut(Value)) {
    let mut seq = 0;
    let mut not_before = Instant::now();
    loop {
        let (next, progress) = watch.latest_after(seq, not_before);
        emit(progress_event(&progress));
        if progress.status != Status::Running {
            return;
        }
        seq = next;
        not_before = Instant::now() + every;
    }
}

/// Finishes the watch as an error if the slice panics, so the forwarder,
/// which waits for a terminal state, still ends with the slice.
struct FailOnPanic<'a>(&'a Watch);

impl Drop for FailOnPanic<'_> {
    fn drop(&mut self) {
        if std::thread::panicking() {
            self.0.finish(Status::Error);
        }
    }
}

/// Slices `payload` while a second thread forwards its progress. Both end
/// before this returns.
fn slice_with_progress(
    payload: &str,
    cache: Option<&SliceCache>,
    job: Job,
    watch: &Watch,
    every: Duration,
    emit: impl FnMut(Value) + Send,
) -> Result<String, PayloadError> {
    std::thread::scope(|scope| {
        scope.spawn(move || forward_progress(watch, every, emit));
        let _settle = FailOnPanic(watch);
        let result = slice_payload_watched(payload, cache, job, watch, park_gcode);
        watch.finish(Status::of(&result));
        result
    })
}

#[tauri::command]
async fn slice_model(app: AppHandle, payload: String) -> Result<String, String> {
    let job = Job::start();
    let watch = Watch::new();
    *CURRENT.lock().unwrap_or_else(PoisonError::into_inner) = watch.clone();
    // One cache for the app's life: it owns the background writes in flight.
    static SLICE_CACHE: std::sync::OnceLock<SliceCache> = std::sync::OnceLock::new();
    let cache = app.path().app_cache_dir().ok().map(|dir| {
        SLICE_CACHE.get_or_init(|| SliceCache::new(dir.join("slices"), SLICE_CACHE_BYTES))
    });
    tauri::async_runtime::spawn_blocking(move || {
        slice_with_progress(&payload, cache, job, &watch, PROGRESS_EVERY, |event| {
            let _ = app.emit("slice-progress", event);
        })
        .map_err(command_error)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The message, or for an unknown `meshRef` the JSON body `serve` answers
/// with, so the UI reads its `code` the same way on both.
fn command_error(err: PayloadError) -> String {
    match err {
        PayloadError::UnknownMesh(_) => err.json(),
        PayloadError::Failed(message) => message,
    }
}

#[tauri::command]
fn cancel_slice() {
    cancel_all();
    CURRENT
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .cancel();
}

#[tauri::command]
fn strategies(toughness: f64, layer_height: f64, line_width: f64, max_vol: f64) -> String {
    serde_json::to_string(&strategy_card(toughness, layer_height, line_width, max_vol))
        .unwrap_or_else(|e| format!("{{\"error\":\"{e}\"}}"))
}

#[tauri::command]
fn gcode_text(token: String) -> Result<String, String> {
    gcode_store()
        .lock()
        .expect("gcode store")
        .get(&token)
        .cloned()
        .ok_or_else(|| "g-code expired".to_string())
        .map(|text| text.text())
}

#[tauri::command]
async fn save_text_file(
    app: AppHandle,
    text: String,
    default_name: String,
    extension: String,
    bytes_b64: Option<String>,
) -> Result<bool, String> {
    let label = if extension == "3mf" { "3MF" } else { "G-code" };
    let picked = app
        .dialog()
        .file()
        .set_file_name(&default_name)
        .add_filter(label, &[&extension])
        .blocking_save_file();
    let Some(file) = picked else {
        return Ok(false);
    };
    let path = file.into_path().map_err(|e| e.to_string())?;
    let bytes = if let Some(b64) = bytes_b64 {
        base64_decode(&b64)?
    } else {
        text.into_bytes()
    };
    std::fs::write(path, bytes).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
async fn pareto_model(payload: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let req: SliceRequest = serde_json::from_str(&payload).map_err(|e| e.to_string())?;
        let bytes = base64_decode(&req.data_b64)?;
        let mesh = load_slice_mesh_tol(
            &req.filename,
            &bytes,
            req.pose.is_some(),
            req.step_tolerance_mm,
        )?;
        let profile = req.printer.clone().unwrap_or_default();
        let settings = SliceSettings {
            job: Job::start(),
            ..SliceSettings::from_request(&req)
        };
        let points = pareto_estimates(&mesh, &profile, &settings)?;
        serde_json::to_string(&points).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn preview_mesh(payload: String) -> Result<String, String> {
    let req: SliceRequest = serde_json::from_str(&payload).map_err(|e| e.to_string())?;
    let bytes = base64_decode(&req.data_b64)?;
    let preview = mesh_preview_tol(&req.filename, &bytes, req.step_tolerance_mm)?;
    serde_json::to_string(&preview).map_err(|e| e.to_string())
}

fn base64_decode(data: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(data.trim())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn calibrate_temp(payload: String) -> Result<String, String> {
    let req: TempCalibRequest = serde_json::from_str(&payload).map_err(|e| e.to_string())?;
    let response = temperature_from_request(&req)?;
    serde_json::to_string(&response).map_err(|e| e.to_string())
}

#[tauri::command]
fn calibrate_flow(payload: String) -> Result<String, String> {
    let req: FlowCalibRequest = serde_json::from_str(&payload).map_err(|e| e.to_string())?;
    let response = flow_from_request(&req)?;
    serde_json::to_string(&response).map_err(|e| e.to_string())
}

#[tauri::command]
fn calibrate_pa(payload: String) -> Result<String, String> {
    let req: PaCalibRequest = serde_json::from_str(&payload).map_err(|e| e.to_string())?;
    let response = pressure_advance_from_request(&req)?;
    serde_json::to_string(&response).map_err(|e| e.to_string())
}

/// Native frame unless the user (or `LIME_SLICE_CUSTOM_TITLEBAR`) asked for the custom titlebar.
/// Linux keeps the system frame by default. `LIME_SLICE_NATIVE_DECORATIONS=1` forces it everywhere.
fn native_window_decorations() -> bool {
    if env_flag("LIME_SLICE_NATIVE_DECORATIONS") {
        return true;
    }
    if env_flag("LIME_SLICE_CUSTOM_TITLEBAR") {
        return false;
    }
    cfg!(target_os = "linux")
}

fn env_flag(name: &str) -> bool {
    matches!(
        std::env::var(name).ok().as_deref().map(str::trim),
        Some("1") | Some("true") | Some("yes")
    )
}

fn window_state() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_window_state::Builder::new()
        .with_state_flags(
            tauri_plugin_window_state::StateFlags::SIZE
                | tauri_plugin_window_state::StateFlags::POSITION
                | tauri_plugin_window_state::StateFlags::MAXIMIZED,
        )
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    keep_support_bases(true);
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(window_state())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_decorations(native_window_decorations());
                let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/128x128.png"))?;
                window.set_icon(icon)?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            slice_model,
            cancel_slice,
            calibrate_pa,
            calibrate_flow,
            calibrate_temp,
            strategies,
            gcode_text,
            save_text_file,
            pareto_model,
            preview_mesh,
            prusa_link_http
        ])
        .run(tauri::generate_context!())
        .expect("Lime Slice window failed to start");
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::thread;

    use base64::Engine;
    use lime_slice_core::Stage;

    use super::*;

    fn stage_names() -> Vec<&'static str> {
        Stage::ALL.iter().map(|stage| stage.name()).collect()
    }

    #[test]
    fn every_stage_has_the_web_ui_label() {
        let labels: HashMap<String, String> =
            serde_json::from_str(include_str!("../../src/ui/stage-labels.json")).unwrap();
        let mut keys: Vec<&str> = labels.keys().map(String::as_str).collect();
        keys.sort_unstable();
        let mut names = stage_names();
        names.sort_unstable();
        assert_eq!(keys, names);
        assert_eq!(stage_label("part"), "Walls and infill");
    }

    #[test]
    fn a_desktop_slice_forwards_ordered_named_progress_and_ends_done() {
        let stl = std::fs::read(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../samples/calibration_cube_20mm.stl"),
        )
        .unwrap();
        let payload = json!({
            "filename": "calibration_cube_20mm.stl",
            "dataB64": base64::engine::general_purpose::STANDARD.encode(stl),
            "baseline": false,
            "compare": false,
            "includePreview": false,
            "includeGcode": false,
        })
        .to_string();
        let mut events = Vec::new();
        let reply = slice_with_progress(
            &payload,
            None,
            Job::default(),
            &Watch::new(),
            Duration::ZERO,
            |event| events.push(event),
        );
        assert!(reply.unwrap().contains("gcodeToken"));

        let names = stage_names();
        let mut previous = 0.0;
        for event in &events {
            let stage = event["stage"].as_str().unwrap();
            assert!(names.contains(&stage), "unknown stage {event}");
            assert_eq!(event["message"], stage_label(stage), "{event}");
            let fraction = event["progress"].as_f64().unwrap();
            assert!(fraction + 1e-12 >= previous, "{previous} -> {event}");
            previous = fraction;
        }
        let (last, running) = events.split_last().unwrap();
        assert!(!running.is_empty(), "only the terminal event: {last}");
        assert!(running.iter().all(|event| event["status"] == "running"));
        assert_eq!(last["status"], "done");
        assert_eq!(last["progress"], 1.0);
        assert_eq!(last["stage"], "emit");
        assert_eq!(last["message"], "Writing G-code");
    }

    #[test]
    fn an_unknown_mesh_ref_fails_with_the_serve_code() {
        let payload = json!({"filename": "a.stl", "meshRef": "0".repeat(64)}).to_string();
        let err = slice_with_progress(
            &payload,
            None,
            Job::default(),
            &Watch::new(),
            Duration::ZERO,
            |_| {},
        )
        .map_err(command_error)
        .unwrap_err();
        let body: Value = serde_json::from_str(&err).unwrap();
        assert_eq!(body["code"], "unknownMeshRef");
        assert_eq!(body["meshRefs"], json!(["0".repeat(64)]));
    }

    #[test]
    fn forwarding_is_throttled_and_ends_with_the_terminal_state() {
        let watch = Watch::new();
        let mut events = Vec::new();
        thread::scope(|scope| {
            scope.spawn(|| {
                forward_progress(&watch, Duration::from_millis(100), |event| {
                    events.push(event)
                })
            });
            watch.begin(Stage::Part, 1_000);
            let started = Instant::now();
            while started.elapsed() < Duration::from_millis(300) {
                watch.tick();
                thread::sleep(Duration::from_millis(1));
            }
            watch.finish(Status::Cancelled);
        });
        assert!((2..=6).contains(&events.len()), "{events:?}");
        let last = events.last().unwrap();
        assert_eq!(last["status"], "cancelled");
        assert_eq!(last["stage"], "part");
    }

    #[test]
    fn cancel_slice_cancels_the_current_watch() {
        let watch = Watch::new();
        *CURRENT.lock().unwrap() = watch.clone();
        cancel_slice();
        assert!(watch.cancelled());
    }
}
