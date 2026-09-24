use lime_slice_core::{
    pressure_advance_from_request, slice_request, PaCalibRequest, SliceRequest,
};

#[tauri::command]
fn slice_model(payload: String) -> Result<String, String> {
    let req: SliceRequest = serde_json::from_str(&payload).map_err(|e| e.to_string())?;
    let response = slice_request(&req)?;
    serde_json::to_string(&response).map_err(|e| e.to_string())
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
        .invoke_handler(tauri::generate_handler![slice_model, calibrate_pa])
        .run(tauri::generate_context!())
        .expect("Lime Slice window failed to start");
}
