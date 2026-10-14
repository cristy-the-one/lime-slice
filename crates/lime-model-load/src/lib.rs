//! Find and call the Open CASCADE bridge. This crate does not link Open CASCADE,
//! so the slicer and the desktop shell still start when the bridge is absent.
//!
//! On Windows the bridge is loaded with `LoadLibraryExW` and
//! `LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR`. The default search does not look in the
//! loaded DLL's own folder, so the Open CASCADE DLLs beside the bridge would
//! otherwise be missed unless that folder is on `PATH`.

use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use libloading::Library;

type Tree = unsafe extern "C" fn(*const c_char) -> *mut c_char;
type FreeStr = unsafe extern "C" fn(*mut c_char);

struct Bridge {
    _lib: Library,
    tree: Tree,
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

/// One call on the Model history tree. The request and the reply are JSON; `docs/step-modeler.md` lists the calls.
pub fn tree(request: &str) -> Result<String, String> {
    let (call, free) = load()?;
    let c = CString::new(request).map_err(|_| "tree request is not a C string".to_string())?;
    let ptr = unsafe { call(c.as_ptr()) };
    take(ptr, free)
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

fn load() -> Result<(Tree, FreeStr), String> {
    let mut slot = BRIDGE
        .lock()
        .map_err(|_| "Open CASCADE bridge lock is poisoned".to_string())?;
    if slot.is_none() {
        let path = find_bridge()?;
        let lib = open_library(&path)?;
        let bridge = unsafe {
            Bridge {
                tree: *lib.get::<Tree>(b"lime_occt_tree\0").map_err(|_| {
                    "This Open CASCADE bridge has no history tree. Install the matching Lime Slice."
                        .to_string()
                })?,
                free: *lib
                    .get::<FreeStr>(b"lime_occt_string_free\0")
                    .map_err(|err| format!("bridge is missing lime_occt_string_free: {err}"))?,
                _lib: lib,
            }
        };
        *slot = Some(bridge);
    }
    let bridge = slot.as_ref().expect("bridge was just stored");
    Ok((bridge.tree, bridge.free))
}

fn open_library(path: &Path) -> Result<Library, String> {
    #[cfg(windows)]
    {
        open_library_windows(path)
    }
    #[cfg(not(windows))]
    {
        unsafe { Library::new(path) }.map_err(|err| load_failure(path, err))
    }
}

/// Windows does not search the loaded DLL's directory for its dependencies.
/// `LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR` adds that directory, and it requires an
/// absolute path. `LOAD_LIBRARY_SEARCH_DEFAULT_DIRS` still finds System32.
#[cfg(windows)]
fn open_library_windows(path: &Path) -> Result<Library, String> {
    use libloading::os::windows::{
        LOAD_LIBRARY_SEARCH_DEFAULT_DIRS, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR,
    };

    let absolute = absolute_dll_path(path)?;
    let flags = LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS;
    let lib = unsafe { libloading::os::windows::Library::load_with_flags(&absolute, flags) }
        .map_err(|err| load_failure(&absolute, err))?;
    Ok(Library::from(lib))
}

#[cfg(windows)]
fn absolute_dll_path(path: &Path) -> Result<PathBuf, String> {
    let absolute = std::path::absolute(path).map_err(|err| {
        format!(
            "Could not make the Open CASCADE bridge path absolute ({}): {err}",
            path.display()
        )
    })?;
    let plain = plain_windows_path(&absolute);
    if !plain.is_absolute() {
        return Err(format!(
            "Open CASCADE bridge path is not absolute: {}",
            plain.display()
        ));
    }
    Ok(plain)
}

/// `LoadLibraryExW` rejects the `\\?\` prefix when the DLL-directory flag is set.
#[cfg(windows)]
fn plain_windows_path(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return PathBuf::from(rest.to_owned());
    }
    path.to_path_buf()
}

fn load_failure(path: &Path, err: libloading::Error) -> String {
    match std::error::Error::source(&err) {
        Some(source) => format!(
            "Could not load the Open CASCADE bridge at {}: {err}: {source}",
            path.display()
        ),
        None => format!(
            "Could not load the Open CASCADE bridge at {}: {err}",
            path.display()
        ),
    }
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
