//! Find and call the Open CASCADE bridge. This crate does not link Open CASCADE,
//! so the slicer and the desktop shell still start when the bridge is absent.

use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use libloading::Library;

type OpenBox = unsafe extern "C" fn(f64, f64, f64) -> *mut c_char;
type OpenStep = unsafe extern "C" fn(*const c_char, f64) -> *mut c_char;
type Distance = unsafe extern "C" fn(i32, *const c_char, i32, *const c_char, i32) -> *mut c_char;
type FreeStr = unsafe extern "C" fn(*mut c_char);

struct Bridge {
    _lib: Library,
    open_box: OpenBox,
    open_step: OpenStep,
    distance: Distance,
    free: FreeStr,
}

static BRIDGE: Mutex<Option<Bridge>> = Mutex::new(None);
static EXTRA_DIRS: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

/// A directory the bridge may live in, such as the installer's resource folder.
pub fn add_search_dir(dir: PathBuf) {
    if let Ok(mut dirs) = EXTRA_DIRS.lock() {
        if !dirs.iter().any(|have| have == &dir) {
            dirs.push(dir);
        }
    }
}

/// Write STEP bytes to a temporary file and read them. The file is removed before this returns.
pub fn open_step_bytes(bytes: &[u8], chord_mm: f64) -> Result<String, String> {
    let path = std::env::temp_dir().join(format!(
        "lime-model-{}-{}.step",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::write(&path, bytes).map_err(|err| err.to_string())?;
    let result = open_step(&path, chord_mm);
    let _ = std::fs::remove_file(&path);
    result
}

/// A box solid, as JSON. The string is the bridge's document, including `error` when it failed.
pub fn open_box(x_mm: f64, y_mm: f64, z_mm: f64) -> Result<String, String> {
    let api = load()?;
    let ptr = unsafe { (api.open_box)(x_mm, y_mm, z_mm) };
    take(ptr, api.free)
}

/// Read a STEP file into a solid. `chord_mm` is the tessellation chord.
pub fn open_step(path: &Path, chord_mm: f64) -> Result<String, String> {
    let api = load()?;
    let text = path.to_string_lossy();
    let c = CString::new(text.as_ref()).map_err(|_| "STEP path is not a C string".to_string())?;
    let ptr = unsafe { (api.open_step)(c.as_ptr(), chord_mm) };
    take(ptr, api.free)
}

/// Distance in millimetres between two picks. `kind` is `face` or `edge`. Indexes are zero-based.
pub fn distance(id: i32, a_kind: &str, a: i32, b_kind: &str, b: i32) -> Result<String, String> {
    let api = load()?;
    let a_kind = CString::new(a_kind).map_err(|_| "pick kind is not a C string".to_string())?;
    let b_kind = CString::new(b_kind).map_err(|_| "pick kind is not a C string".to_string())?;
    let ptr = unsafe { (api.distance)(id, a_kind.as_ptr(), a, b_kind.as_ptr(), b) };
    take(ptr, api.free)
}

struct Api {
    open_box: OpenBox,
    open_step: OpenStep,
    distance: Distance,
    free: FreeStr,
}

fn take(ptr: *mut c_char, free: FreeStr) -> Result<String, String> {
    if ptr.is_null() {
        return Err("Open CASCADE bridge returned nothing".into());
    }
    let text = unsafe { CStr::from_ptr(ptr) }
        .to_string_lossy()
        .into_owned();
    unsafe { free(ptr) };
    Ok(text)
}

fn load() -> Result<Api, String> {
    let mut slot = BRIDGE.lock().map_err(|_| "Open CASCADE bridge lock is poisoned".to_string())?;
    if slot.is_none() {
        let path = find_bridge()?;
        let lib = unsafe { Library::new(&path) }.map_err(|err| {
            format!(
                "Could not load the Open CASCADE bridge at {}: {err}",
                path.display()
            )
        })?;
        let bridge = unsafe {
            Bridge {
                open_box: *lib
                    .get::<OpenBox>(b"lime_occt_open_box\0")
                    .map_err(|err| format!("bridge is missing lime_occt_open_box: {err}"))?,
                open_step: *lib
                    .get::<OpenStep>(b"lime_occt_open_step\0")
                    .map_err(|err| format!("bridge is missing lime_occt_open_step: {err}"))?,
                distance: *lib
                    .get::<Distance>(b"lime_occt_distance\0")
                    .map_err(|err| format!("bridge is missing lime_occt_distance: {err}"))?,
                free: *lib
                    .get::<FreeStr>(b"lime_occt_string_free\0")
                    .map_err(|err| format!("bridge is missing lime_occt_string_free: {err}"))?,
                _lib: lib,
            }
        };
        *slot = Some(bridge);
    }
    let bridge = slot.as_ref().expect("bridge was just stored");
    Ok(Api {
        open_box: bridge.open_box,
        open_step: bridge.open_step,
        distance: bridge.distance,
        free: bridge.free,
    })
}

fn find_bridge() -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("LIME_OCCT_BRIDGE") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
        return Err(format!(
            "Open CASCADE bridge was not found at {}. Model mode stays off until that library is next to the app.",
            path.display()
        ));
    }
    let mut tried = Vec::new();
    for path in candidates() {
        if path.is_file() {
            return Ok(path);
        }
        tried.push(path.display().to_string());
    }
    Err(format!(
        "Open CASCADE bridge was not found. Looked for {}. Model mode stays off until that library is next to the app.",
        tried.join(", ")
    ))
}

fn candidates() -> Vec<PathBuf> {
    let name = bridge_file_name();
    let mut out = Vec::new();
    if let Ok(dirs) = EXTRA_DIRS.lock() {
        for dir in dirs.iter() {
            out.push(dir.join(name));
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            out.push(dir.join(name));
            out.push(dir.join("../Resources/occt/lib").join(name));
            out.push(dir.join("occt/lib").join(name));
        }
    }
    out
}

fn bridge_file_name() -> &'static str {
    if cfg!(windows) {
        "lime_model_occt.dll"
    } else if cfg!(target_os = "macos") {
        "liblime_model_occt.dylib"
    } else {
        "liblime_model_occt.so"
    }
}
