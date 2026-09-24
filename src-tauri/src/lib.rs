use lime_slice_core::{slice_request, SliceRequest};

#[tauri::command]
fn slice_model(payload: String) -> Result<String, String> {
    let req: SliceRequest = serde_json::from_str(&payload).map_err(|e| e.to_string())?;
    let response = slice_request(&req)?;
    serde_json::to_string(&response).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![slice_model])
        .run(tauri::generate_context!())
        .expect("Lime Slice window failed to start");
}
