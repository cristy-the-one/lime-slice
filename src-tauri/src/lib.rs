use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use lime_slice_core::{
    cancel_all, keep_support_bases, load_slice_mesh_tol, mesh_preview_tol, pareto_estimates,
    pressure_advance_from_request, slice_payload, strategy_card, GcodeText, Job, PaCalibRequest,
    SliceCache, SliceRequest, SliceSettings,
};
use tauri::AppHandle;
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

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

#[tauri::command]
async fn slice_model(app: AppHandle, payload: String) -> Result<String, String> {
    let job = Job::start();
    // One cache for the app's life: it owns the background writes in flight.
    static SLICE_CACHE: std::sync::OnceLock<SliceCache> = std::sync::OnceLock::new();
    let cache = app.path().app_cache_dir().ok().map(|dir| {
        SLICE_CACHE.get_or_init(|| SliceCache::new(dir.join("slices"), SLICE_CACHE_BYTES))
    });
    tauri::async_runtime::spawn_blocking(move || {
        let _ = app.emit(
            "slice-progress",
            serde_json::json!({ "progress": 0.08, "message": "Planning toolpaths" }),
        );
        let reply = slice_payload(&payload, cache, job, park_gcode)?;
        let _ = app.emit(
            "slice-progress",
            serde_json::json!({ "progress": 1.0, "message": "Done" }),
        );
        Ok(reply)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn cancel_slice() {
    cancel_all();
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
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            slice_model,
            cancel_slice,
            calibrate_pa,
            strategies,
            gcode_text,
            save_text_file,
            pareto_model,
            preview_mesh
        ])
        .run(tauri::generate_context!())
        .expect("Lime Slice window failed to start");
}
