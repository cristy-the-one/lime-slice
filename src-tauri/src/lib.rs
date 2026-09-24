use lime_slice_core::{
    pressure_advance_from_request, request_cancel, reset_cancel, slice_request, strategy_card,
    PaCalibRequest, SliceRequest,
};
use tauri::{AppHandle, Emitter};

#[tauri::command]
async fn slice_model(app: AppHandle, payload: String) -> Result<String, String> {
    reset_cancel();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = app.emit(
            "slice-progress",
            serde_json::json!({ "progress": 0.08, "message": "Planning toolpaths" }),
        );
        let req: SliceRequest = serde_json::from_str(&payload).map_err(|e| e.to_string())?;
        let response = slice_request(&req)?;
        let _ = app.emit(
            "slice-progress",
            serde_json::json!({ "progress": 1.0, "message": "Done" }),
        );
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
fn calibrate_pa(payload: String) -> Result<String, String> {
    let req: PaCalibRequest = serde_json::from_str(&payload).map_err(|e| e.to_string())?;
    let response = pressure_advance_from_request(&req)?;
    serde_json::to_string(&response).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            slice_model,
            cancel_slice,
            calibrate_pa,
            strategies
        ])
        .run(tauri::generate_context!())
        .expect("Lime Slice window failed to start");
}
