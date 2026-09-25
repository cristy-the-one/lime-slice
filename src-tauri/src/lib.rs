use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use lime_slice_core::{
    mesh_preview, pareto_estimates, pressure_advance_from_request, request_cancel, reset_cancel,
    slice_request, strategy_card, PaCalibRequest, SliceRequest, SliceSettings,
};
use tauri::AppHandle;
use tauri::Emitter;
use tauri_plugin_dialog::DialogExt;

fn gcode_store() -> &'static Mutex<HashMap<String, String>> {
    static STORE: std::sync::LazyLock<Mutex<HashMap<String, String>>> =
        std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
    &STORE
}

fn park_gcode(text: String) -> String {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let token = NEXT.fetch_add(1, Ordering::Relaxed).to_string();
    let mut guard = gcode_store().lock().expect("gcode store");
    if guard.len() > 6 {
        guard.clear();
    }
    guard.insert(token.clone(), text);
    token
}

#[tauri::command]
async fn slice_model(app: AppHandle, payload: String) -> Result<String, String> {
    reset_cancel();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = app.emit(
            "slice-progress",
            serde_json::json!({ "progress": 0.08, "message": "Planning toolpaths" }),
        );
        let req: SliceRequest = serde_json::from_str(&payload).map_err(|e| e.to_string())?;
        let mut response = slice_request(&req)?;
        let _ = app.emit(
            "slice-progress",
            serde_json::json!({ "progress": 1.0, "message": "Done" }),
        );
        if !req.include_gcode {
            let token = park_gcode(std::mem::take(&mut response.gcode));
            let mut value = serde_json::to_value(&response).map_err(|e| e.to_string())?;
            if let Some(obj) = value.as_object_mut() {
                obj.insert("gcodeToken".into(), serde_json::json!(token));
            }
            return Ok(value.to_string());
        }
        serde_json::to_string(&response).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn cancel_slice() {
    request_cancel();
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
        .ok_or_else(|| "g-code expired".into())
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
        let mesh = lime_slice_core::load_mesh(&req.filename, &bytes)?;
        let profile = req.printer.clone().unwrap_or_default();
        let settings = SliceSettings::from_request(&req);
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
    let preview = mesh_preview(&req.filename, &bytes)?;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
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
