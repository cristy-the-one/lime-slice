//! A project or mesh to open, named on the command line, by a file association,
//! by a second launch that handed its path to this window, or by the MCP bridge.
//!
//! The page opens it the way File > Open does, with its unsaved-changes prompt.
//! A path that arrives before the page has mounted waits until the page asks for
//! it with `take_launch_file`.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// What the page opens: a `.lime` project, or a mesh.
pub const OPEN_EXTENSIONS: [&str; 5] = ["lime", "stl", "3mf", "step", "stp"];
/// The same limit the page and the MCP server put on a mesh.
const MAX_BYTES: u64 = 256 * 1024 * 1024;

/// Whether the page has asked for its launch file. Until then a path waits here.
struct Pending {
    ready: bool,
    path: Option<PathBuf>,
}

static PENDING: Mutex<Pending> = Mutex::new(Pending {
    ready: false,
    path: None,
});

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedFile {
    pub name: String,
    pub bytes_b64: String,
}

/// A file this window can open, by its extension.
pub fn openable(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            OPEN_EXTENSIONS
                .iter()
                .any(|known| ext.eq_ignore_ascii_case(known))
        })
}

/// The first openable path in `args`, which start with the program. Flags are skipped,
/// and a relative path is read against `cwd`, the launching shell's folder.
pub fn launch_path<I, S>(args: I, cwd: &Path) -> Option<PathBuf>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter()
        .skip(1)
        .map(|arg| arg.as_ref().trim().to_string())
        .filter(|arg| !arg.is_empty() && !arg.starts_with('-'))
        .map(PathBuf::from)
        .find(|path| openable(path))
        .map(|path| {
            if path.is_absolute() {
                path
            } else {
                cwd.join(path)
            }
        })
}

/// A sentence saying why `path` cannot be opened, if it cannot.
fn check(path: &Path) -> Result<(), String> {
    let shown = path.display();
    if !openable(path) {
        return Err(format!(
            "Lime Slice opens .lime, .stl, .3mf, and .step files, so {shown} was not opened."
        ));
    }
    let meta = std::fs::metadata(path).map_err(|_| format!("{shown} was not found."))?;
    if !meta.is_file() {
        return Err(format!("{shown} is not a file."));
    }
    if meta.len() > MAX_BYTES {
        return Err(format!(
            "{shown} is larger than 256 MB, so it was not opened."
        ));
    }
    Ok(())
}

/// The file's name and bytes, or a sentence saying why it cannot be opened.
pub fn read(path: &Path) -> Result<OpenedFile, String> {
    check(path)?;
    let shown = path.display();
    let bytes = std::fs::read(path).map_err(|err| format!("{shown} could not be read: {err}"))?;
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "model.stl".to_string());
    use base64::Engine;
    Ok(OpenedFile {
        name,
        bytes_b64: base64::engine::general_purpose::STANDARD.encode(bytes),
    })
}

/// Keep the path the app was started with, for the page to take once it mounts.
pub fn remember_launch(path: PathBuf) {
    PENDING.lock().unwrap_or_else(PoisonError::into_inner).path = Some(path);
}

/// Open `path` in this window, and bring the window forward. Before the page has
/// mounted, the path waits for it. An unreadable file is refused here, so the
/// bridge can answer the server with the reason.
pub fn deliver(app: &AppHandle, path: PathBuf) -> Result<(), String> {
    show_window(app);
    {
        let mut pending = PENDING.lock().unwrap_or_else(PoisonError::into_inner);
        if !pending.ready {
            check(&path)?;
            pending.path = Some(path);
            return Ok(());
        }
    }
    let file = read(&path)?;
    app.emit("lime-open-file", file)
        .map_err(|err| err.to_string())
}

fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// The page mounted: the file the app was started with, if any. Later paths arrive
/// as the `lime-open-file` event.
#[tauri::command]
pub fn take_launch_file() -> Result<Option<OpenedFile>, String> {
    let path = {
        let mut pending = PENDING.lock().unwrap_or_else(PoisonError::into_inner);
        pending.ready = true;
        pending.path.take()
    };
    path.map(|path| read(&path)).transpose()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cwd() -> PathBuf {
        std::env::temp_dir()
    }

    #[test]
    fn the_first_openable_argument_is_the_launch_file() {
        let abs = cwd().join("duck.lime");
        let args = ["lime-slice-desktop", abs.to_str().unwrap()];
        assert_eq!(launch_path(args, &cwd()), Some(abs));
        let args = ["app", "--flag", "notes.txt", "part.STL", "other.3mf"];
        assert_eq!(launch_path(args, &cwd()), Some(cwd().join("part.STL")));
    }

    #[test]
    fn a_relative_path_is_read_against_the_launching_folder() {
        let folder = cwd().join("work");
        assert_eq!(
            launch_path(["app", "bracket.step"], &folder),
            Some(folder.join("bracket.step"))
        );
    }

    #[test]
    fn no_openable_argument_means_no_launch_file() {
        assert_eq!(launch_path(["app"], &cwd()), None);
        assert_eq!(launch_path(["app", "readme.md", "-v", ""], &cwd()), None);
        // The program itself is never the file, even with an openable name.
        assert_eq!(launch_path(["tool.stl"], &cwd()), None);
    }

    #[test]
    fn every_open_extension_is_openable_in_any_case() {
        for ext in ["lime", "STL", "3mf", "Step", "stp"] {
            assert!(openable(Path::new(&format!("a.{ext}"))), "{ext}");
        }
        assert!(!openable(Path::new("a.gcode")));
        assert!(!openable(Path::new("lime")));
    }

    #[test]
    fn a_file_is_read_with_its_name_and_a_missing_one_is_a_sentence() {
        let dir = std::env::temp_dir().join(format!("lime-open-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("cube.stl");
        std::fs::write(&path, b"solid cube\nendsolid cube\n").unwrap();
        let file = read(&path).unwrap();
        assert_eq!(file.name, "cube.stl");
        assert_eq!(file.bytes_b64, "c29saWQgY3ViZQplbmRzb2xpZCBjdWJlCg==");
        let missing = read(&dir.join("gone.lime")).unwrap_err();
        assert!(missing.ends_with("was not found."), "{missing}");
        let wrong = read(&dir.join("cube.txt")).unwrap_err();
        assert!(wrong.starts_with("Lime Slice opens"), "{wrong}");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
