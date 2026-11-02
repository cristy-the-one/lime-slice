//! The plugin library in the window (docs/plan-recipe-plugins.md D7, D13): the folder the MCP server writes plugins
//! to, read and written here for the Plugins panel (`src/plugins/library.ts`).
//!
//! The folder is `LIME_PLUGINS_DIR`, else `plugins` in the app's data folder (`%APPDATA%\com.limeslice.slicer` on
//! Windows, `$XDG_DATA_HOME/com.limeslice.slicer` on Linux, `~/Library/Application Support/com.limeslice.slicer` on
//! macOS), the same place `mcp/plugins.ts` finds. These commands touch only the names the library uses: `<id>.rs`,
//! `<id>.vN.rs`, `presets/<id>.json` and `settings.json`, each written whole through a temporary file and a rename.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

/// Older versions kept beside a plugin as `<id>.vN.rs`, as the MCP server keeps them.
const KEEP_VERSIONS: usize = 5;
/// A library file larger than this is not listed (a plugin is one source file).
const MAX_FILE: u64 = 1 << 20;

/// `[a-z0-9-]`, at most 48 characters, starting and ending with a letter or digit.
fn is_slug(id: &str) -> bool {
    let bytes = id.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 48
        && bytes.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
        && bytes[0] != b'-'
        && bytes[bytes.len() - 1] != b'-'
}

fn library_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(named) = std::env::var_os("LIME_PLUGINS_DIR").filter(|v| !v.is_empty()) {
        return Ok(PathBuf::from(named));
    }
    app.path().app_data_dir().map(|dir| dir.join("plugins")).map_err(|e| format!("The app's data folder is not known here: {e}"))
}

fn write_whole(path: &Path, text: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
    fs::write(&tmp, text)?;
    fs::rename(&tmp, path)
}

fn read_small(path: &Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_FILE {
        return None;
    }
    fs::read_to_string(path).ok()
}

/// `version: N` from a plugin's front matter, or None.
fn header_version(text: &str) -> Option<u32> {
    let mut lines = text.lines();
    if lines.next()?.trim() != "//! ---" {
        return None;
    }
    for line in lines {
        let line = line.trim();
        if line == "//! ---" {
            return None;
        }
        if let Some(rest) = line.strip_prefix("//!").map(str::trim).and_then(|l| l.strip_prefix("version:")) {
            return rest.trim().parse().ok();
        }
    }
    None
}

/// The older versions kept for `id`, lowest first.
fn older_versions(dir: &Path, id: &str) -> Vec<u32> {
    let prefix = format!("{id}.v");
    let mut out: Vec<u32> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            name.strip_prefix(&prefix)?.strip_suffix(".rs")?.parse().ok()
        })
        .collect();
    out.sort_unstable();
    out
}

/// Every `.rs` file, the presets and the settings of the library.
pub fn list_in(dir: &Path) -> Value {
    let mut files = Vec::new();
    if let Ok(entries) = fs::read_dir(dir) {
        let mut names: Vec<String> = entries.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        for name in names {
            let Some(stem) = name.strip_suffix(".rs") else { continue };
            let id = stem.split(".v").next().unwrap_or(stem);
            if !is_slug(id) {
                continue;
            }
            if let Some(text) = read_small(&dir.join(&name)) {
                files.push(json!({ "name": name, "text": text }));
            }
        }
    }
    let mut presets = Vec::new();
    if let Ok(entries) = fs::read_dir(dir.join("presets")) {
        let mut names: Vec<String> = entries.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        for name in names {
            let Some(id) = name.strip_suffix(".json").filter(|id| is_slug(id)) else { continue };
            if let Some(text) = read_small(&dir.join("presets").join(&name)) {
                presets.push(json!({ "plugin": id, "text": text }));
            }
        }
    }
    json!({
        "dir": dir.to_string_lossy(),
        "files": files,
        "presets": presets,
        "settings": read_small(&dir.join("settings.json")),
    })
}

/// Writes `<id>.rs`. A different version already there is kept as `<id>.vN.rs` first, and only the last five older
/// versions stay (`writePlugin` in `mcp/plugins.ts`).
pub fn save_in(dir: &Path, id: &str, text: &str) -> Result<PathBuf, String> {
    if !is_slug(id) {
        return Err(format!("{id} is not a plugin id: lower-case letters, digits and dashes."));
    }
    let new_version = header_version(text).ok_or("A plugin file starts with a //! --- header that names its version.")?;
    let path = dir.join(format!("{id}.rs"));
    let io = |e: std::io::Error| format!("The plugin could not be written to {}: {e}", dir.display());
    if let Some(old) = read_small(&path) {
        if let Some(old_version) = header_version(&old).filter(|v| *v != new_version) {
            write_whole(&dir.join(format!("{id}.v{old_version}.rs")), &old).map_err(io)?;
        }
    }
    write_whole(&path, text).map_err(io)?;
    let older: Vec<u32> = older_versions(dir, id).into_iter().filter(|v| *v < new_version).collect();
    for v in older.iter().take(older.len().saturating_sub(KEEP_VERSIONS)) {
        let _ = fs::remove_file(dir.join(format!("{id}.v{v}.rs")));
    }
    Ok(path)
}

/// Writes `settings.json` or `presets/<id>.json`; any other name is refused.
pub fn write_in(dir: &Path, name: &str, text: &str) -> Result<(), String> {
    let allowed = name == "settings.json" || name.strip_prefix("presets/").and_then(|n| n.strip_suffix(".json")).is_some_and(is_slug);
    if !allowed {
        return Err(format!("The library does not keep a file named {name}."));
    }
    if serde_json::from_str::<Value>(text).is_err() {
        return Err(format!("{name} must be JSON."));
    }
    write_whole(&dir.join(name), text).map_err(|e| format!("{name} could not be written: {e}"))
}

/// Removes `<id>.rs` and its older versions. The number of files removed.
pub fn remove_in(dir: &Path, id: &str) -> Result<usize, String> {
    if !is_slug(id) {
        return Err(format!("{id} is not a plugin id."));
    }
    let mut removed = 0;
    let names = std::iter::once(format!("{id}.rs")).chain(older_versions(dir, id).into_iter().map(|v| format!("{id}.v{v}.rs")));
    for name in names {
        if fs::remove_file(dir.join(&name)).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

#[tauri::command]
pub fn plugin_library_list(app: AppHandle) -> Result<Value, String> {
    Ok(list_in(&library_dir(&app)?))
}

#[tauri::command]
pub fn plugin_library_save(app: AppHandle, id: String, text: String) -> Result<String, String> {
    save_in(&library_dir(&app)?, &id, &text).map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn plugin_library_write(app: AppHandle, name: String, text: String) -> Result<(), String> {
    write_in(&library_dir(&app)?, &name, &text)
}

#[tauri::command]
pub fn plugin_library_remove(app: AppHandle, id: String) -> Result<usize, String> {
    remove_in(&library_dir(&app)?, &id)
}

/// Shows `<id>.rs` selected in the system's file manager, or the folder when there is no id or no such file.
#[tauri::command]
pub fn plugin_library_reveal(app: AppHandle, id: Option<String>) -> Result<(), String> {
    let dir = library_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| format!("The plugin folder could not be made: {e}"))?;
    let file = id.filter(|id| is_slug(id)).map(|id| dir.join(format!("{id}.rs"))).filter(|p| p.is_file());
    let mut command;
    #[cfg(windows)]
    {
        command = std::process::Command::new("explorer");
        match &file {
            Some(file) => {
                use std::os::windows::process::CommandExt;
                command.raw_arg(format!("/select,\"{}\"", file.display()));
            }
            None => {
                command.arg(&dir);
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        command = std::process::Command::new("open");
        match &file {
            Some(file) => command.arg("-R").arg(file),
            None => command.arg(&dir),
        };
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = &file;
        command = std::process::Command::new("xdg-open");
        command.arg(&dir);
    }
    command.spawn().map(|_| ()).map_err(|e| format!("The plugin folder could not be shown: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plugin(version: u32) -> String {
        format!("//! ---\n//! plugin: tiny\n//! title: Tiny\n//! version: {version}\n//! ---\nfn main() {{}}\n")
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lime-plugins-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn slugs_are_the_mcp_servers() {
        assert!(is_slug("stud-row"));
        assert!(is_slug("a1"));
        assert!(!is_slug("-a"));
        assert!(!is_slug("a-"));
        assert!(!is_slug("Studs"));
        assert!(!is_slug("../x"));
        assert!(!is_slug(&"a".repeat(49)));
    }

    #[test]
    fn a_new_version_keeps_the_old_one_beside_it_and_five_at_most() {
        let dir = scratch("save");
        for v in 1..=8 {
            save_in(&dir, "tiny", &plugin(v)).unwrap();
        }
        assert_eq!(header_version(&fs::read_to_string(dir.join("tiny.rs")).unwrap()), Some(8));
        assert_eq!(older_versions(&dir, "tiny"), vec![3, 4, 5, 6, 7]);
        save_in(&dir, "tiny", &plugin(8)).unwrap();
        assert_eq!(older_versions(&dir, "tiny"), vec![3, 4, 5, 6, 7], "the same version is written over");
        let listed = list_in(&dir);
        assert_eq!(listed["files"].as_array().unwrap().len(), 6);
        assert_eq!(remove_in(&dir, "tiny").unwrap(), 6);
        assert!(!dir.join("tiny.rs").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_the_librarys_own_names_are_written() {
        let dir = scratch("write");
        assert!(save_in(&dir, "../evil", &plugin(1)).is_err());
        assert!(save_in(&dir, "tiny", "fn main() {}").is_err(), "a file with no header names no version");
        assert!(write_in(&dir, "presets/tiny.json", "{}").is_ok());
        assert!(write_in(&dir, "settings.json", "{\"author\":\"Marius\"}").is_ok());
        assert!(write_in(&dir, "presets/../x.json", "{}").is_err());
        assert!(write_in(&dir, "lessons.json", "[]").is_err());
        assert!(write_in(&dir, "settings.json", "not json").is_err());
        let listed = list_in(&dir);
        assert_eq!(listed["presets"][0]["plugin"], "tiny");
        assert_eq!(listed["settings"], "{\"author\":\"Marius\"}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_folder_lists_nothing() {
        let listed = list_in(&scratch("none"));
        assert_eq!(listed["files"].as_array().unwrap().len(), 0);
        assert!(listed["settings"].is_null());
    }
}
