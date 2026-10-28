use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex, PoisonError};
use std::time::{Duration, Instant};

use lime_slice_core::{
    cancel_all, flow_from_request, keep_support_bases, mesh_preview_tol, pareto_request,
    pressure_advance_from_request, retract_from_request, slice_payload_watched, strategy_card,
    temperature_from_request, FlowCalibRequest, GcodeText, Job, PaCalibRequest, PayloadError,
    Progress, RetractCalibRequest, SliceCache, SliceRequest, Status, TempCalibRequest, Watch,
};
use serde_json::{json, Value};
use tauri::AppHandle;
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

mod bridge;
mod open_file;
mod prusa_http;
mod quiet_process;
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
        "early": progress.early,
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

/// One sliced stress study. The reply is JSON, including `{ "ok": false, "reason" }`.
fn run_sim_study(body: &str) -> String {
    lime_sim_bridge::study_json(body)
}

#[tauri::command]
async fn sim_study(body: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || run_sim_study(&body))
        .await
        .map_err(|err| err.to_string())
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

/// The running slice's toolpaths, drawn before its tour, once `slice-progress`
/// says `early`. `None` before then, and for a slice that asked for none.
#[tauri::command]
fn early_preview() -> Option<String> {
    CURRENT
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .early()
        .map(|text| text.to_string())
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

/// One file of a folder export: its name, as the card shows it, and its bytes in base64.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct FolderFile {
    name: String,
    bytes_b64: String,
}

/// A file name a folder export may write: one plain name, no folder, no drive, no `..`.
fn folder_file_name(name: &str) -> Result<&str, String> {
    let plain = !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains(['/', '\\', ':', '\0'])
        && name.trim() == name;
    if plain {
        Ok(name)
    } else {
        Err(format!("{name:?} is not a file name"))
    }
}

/// Writes every file into `folder`, checking every name and decoding every file before the first is written, so a bad
/// one leaves the folder as it was. The answer is the names written.
fn write_folder_files(folder: &std::path::Path, files: &[FolderFile]) -> Result<Vec<String>, String> {
    let mut prepared = Vec::with_capacity(files.len());
    for file in files {
        prepared.push((folder_file_name(&file.name)?, base64_decode(&file.bytes_b64)?));
    }
    for (name, bytes) in &prepared {
        std::fs::write(folder.join(name), bytes).map_err(|e| format!("{name}: {e}"))?;
    }
    Ok(prepared.iter().map(|(name, _)| (*name).to_string()).collect())
}

/// A split to print's STL per piece on the desktop: one folder picked once, every piece written there. The answer is the
/// folder, or nothing when the picker was cancelled.
#[tauri::command]
async fn save_files_to_folder(app: AppHandle, files: Vec<FolderFile>) -> Result<Option<String>, String> {
    let Some(picked) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let folder = picked.into_path().map_err(|e| e.to_string())?;
    write_folder_files(&folder, &files)?;
    Ok(Some(folder.display().to_string()))
}

#[tauri::command]
async fn pareto_model(payload: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let req: SliceRequest = serde_json::from_str(&payload).map_err(|e| e.to_string())?;
        let points = pareto_request(&req, Job::start())?;
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

/// Open CASCADE work is synchronous. Run it off the UI thread.
async fn block_model(
    work: impl FnOnce() -> Result<String, String> + Send + 'static,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|err| err.to_string())?
}

/// One call on the Model history tree. The payload is passed through as it came.
#[tauri::command(async)]
async fn model_tree(payload: String) -> Result<String, String> {
    block_model(move || lime_model_load::tree(&payload)).await
}

fn base64_decode(data: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(data.trim())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn calibrate_retract(payload: String) -> Result<String, String> {
    let req: RetractCalibRequest = serde_json::from_str(&payload).map_err(|e| e.to_string())?;
    let response = retract_from_request(&req)?;
    serde_json::to_string(&response).map_err(|e| e.to_string())
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
        // First, so a second launch hands its file to this window before anything else starts.
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            let path = open_file::launch_path(&args, std::path::Path::new(&cwd));
            if let Some(path) = path {
                if let Err(reason) = open_file::deliver(app, path) {
                    eprintln!("lime-slice: {reason}");
                }
            } else if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(window_state())
        .setup(|app| {
            if let Ok(dir) = app.path().resource_dir() {
                lime_model_load::add_search_dir(dir.join("occt").join("lib"));
            }
            if let Some((mesher, identity)) = lime_model_load::step_mesher() {
                lime_slice_core::set_step_mesher(mesher, identity);
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_decorations(native_window_decorations());
                let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/128x128.png"))?;
                window.set_icon(icon)?;
            }
            let cwd = std::env::current_dir().unwrap_or_default();
            if let Some(path) = open_file::launch_path(
                std::env::args_os().map(|arg| arg.to_string_lossy().into_owned()),
                &cwd,
            ) {
                open_file::remember_launch(path);
            }
            bridge::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            slice_model,
            cancel_slice,
            early_preview,
            sim_study,
            calibrate_pa,
            calibrate_flow,
            calibrate_temp,
            calibrate_retract,
            strategies,
            gcode_text,
            save_text_file,
            save_files_to_folder,
            pareto_model,
            preview_mesh,
            model_tree,
            prusa_link_http,
            bridge::bridge_ready,
            open_file::take_launch_file
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

    fn object_keys(value: &Value) -> Vec<String> {
        let mut keys: Vec<String> = value.as_object().map(|map| map.keys().cloned().collect()).unwrap_or_default();
        keys.sort();
        keys
    }

    #[test]
    fn a_folder_export_writes_every_piece_or_none() {
        use base64::Engine;
        let b64 = |text: &str| base64::engine::general_purpose::STANDARD.encode(text);
        let dir = std::env::temp_dir().join(format!("lime-folder-export-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = |name: &str, text: &str| FolderFile { name: name.to_string(), bytes_b64: b64(text) };
        let written = write_folder_files(&dir, &[file("bar-1.stl", "one"), file("bar-2.stl", "two")]).unwrap();
        assert_eq!(written, ["bar-1.stl", "bar-2.stl"]);
        assert_eq!(std::fs::read_to_string(dir.join("bar-2.stl")).unwrap(), "two");
        for bad in ["../x.stl", "a/b.stl", "a\\b.stl", "C:x.stl", "..", ""] {
            let err = write_folder_files(&dir, &[file("bar-3.stl", "three"), file(bad, "x")]).unwrap_err();
            assert!(err.contains("is not a file name"), "{bad}: {err}");
        }
        assert!(!dir.join("bar-3.stl").exists(), "a bad name leaves the folder as it was");
        let err = write_folder_files(&dir, &[FolderFile { name: "bar-4.stl".into(), bytes_b64: "!!".into() }]).unwrap_err();
        assert!(!err.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
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

    /// A closed box, outline in X–Z, extruded along Y. Winding matches the bridge's prism.
    fn box_stl(length: f64, depth: f64, height: f64) -> String {
        let outline = [[0.0, 0.0], [length, 0.0], [length, height], [0.0, height]];
        let mut tris: Vec<[[f64; 3]; 3]> = Vec::new();
        let at = |p: [f64; 2], y: f64| -> [f64; 3] { [p[0], y, p[1]] };
        let n = outline.len();
        for i in 1..n - 1 {
            tris.push([at(outline[0], 0.0), at(outline[i], 0.0), at(outline[i + 1], 0.0)]);
            tris.push([at(outline[0], depth), at(outline[i + 1], depth), at(outline[i], depth)]);
        }
        for i in 0..n {
            let (a, b) = (outline[i], outline[(i + 1) % n]);
            tris.push([at(a, 0.0), at(b, depth), at(b, 0.0)]);
            tris.push([at(a, 0.0), at(a, depth), at(b, depth)]);
        }
        let mut out = String::from("solid box\n");
        for t in tris {
            out.push_str("facet normal 0 0 0\nouter loop\n");
            for v in t {
                out.push_str(&format!("vertex {} {} {}\n", v[0], v[1], v[2]));
            }
            out.push_str("endloop\nendfacet\n");
        }
        out.push_str("endsolid box\n");
        out
    }

    #[test]
    fn sim_study_solves_a_small_box() {
        let stl = box_stl(8.0, 6.0, 4.0);
        let mesh = base64::engine::general_purpose::STANDARD.encode(stl.as_bytes());
        let body = json!({
            "request": {
                "filename": "box.stl",
                "dataB64": mesh,
                "layerHeight": 0.2,
                "lineWidth": 0.45,
                "infill": 1.0,
                "baseline": false,
                "compare": false,
                "includePreview": false,
                "includeGcode": false
            },
            "study": {
                "hXy": 2.0,
                "card": {
                    "id": "inhouse-pla",
                    "polymer": "PLA",
                    "provisional": true,
                    "EInPlaneMPa": 1700.0,
                    "EAcrossLayersMPa": 1400.0,
                    "nu": 0.35,
                    "strengthInPlaneMPa": 28.0,
                    "strengthAcrossLayersMPa": 14.0,
                    "compressionInPlaneMPa": 28.0,
                    "compressionAcrossLayersMPa": 14.0,
                    "shearAcrossLayersMPa": 7.0,
                    "densityGCm3": 1.24,
                    "measuredAtC": null,
                    "specimen": "placeholder, not measured",
                    "method": null,
                    "source": "in-house",
                    "isotropic": false
                },
                "holds": [{ "kind": "bed" }],
                "loads": [{
                    "kind": "force",
                    "region": { "kind": "box", "min": [0.0, 0.0, 3.2], "max": [8.0, 6.0, 4.0] },
                    "force": [0.0, 0.0, 2.0]
                }],
                "constraints": [{ "kind": "minSafetyFactor", "value": 1.0 }],
                "checkResolution": false
            }
        })
        .to_string();
        let text = run_sim_study(&body);
        let reply: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(reply["ok"], true, "{reply}");
        assert_eq!(reply["report"]["representation"], "sliced");
        assert!(reply["report"]["maxDisplacementMm"].as_f64().unwrap().is_finite());
        assert!(reply["surface"]["triangles"].as_u64().unwrap() > 0);
        let spot = &reply["report"]["margins"][0]["hotSpot"]["at"];
        assert!(spot.is_array() && spot.as_array().unwrap().len() == 3, "{reply}");

        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../e2e/fixtures/sim-study-box.json");
        if std::env::var("LIME_STRESS_OUT").ok().as_deref() == Some("1") {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir).unwrap();
            }
            std::fs::write(&path, &text).unwrap();
        }
        let fixture: Value = serde_json::from_reader(std::fs::File::open(&path).unwrap()).unwrap();
        assert_eq!(object_keys(&reply), object_keys(&fixture), "top-level keys");
        assert_eq!(object_keys(&reply["report"]), object_keys(&fixture["report"]), "report keys");
        assert_eq!(object_keys(&reply["surface"]), object_keys(&fixture["surface"]), "surface keys");
        assert!(fixture["surface"]["triangles"].as_u64().unwrap_or(0) > 0);
        let saved = &fixture["report"]["margins"][0]["hotSpot"]["at"];
        assert!(saved.is_array() && saved.as_array().unwrap().len() == 3, "{fixture}");
    }

    #[test]
    fn cancel_slice_cancels_the_current_watch() {
        let watch = Watch::new();
        *CURRENT.lock().unwrap() = watch.clone();
        cancel_slice();
        assert!(watch.cancelled());
    }
}
