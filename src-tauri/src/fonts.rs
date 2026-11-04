//! The person's font library (docs/plan-text-on-curves-and-fonts.md, milestone 4): the fonts they added for text, kept
//! on their computer so they are in the font picker for every project, not only the one they were added in.
//!
//! The folder is `LIME_FONTS_DIR`, else `.lime-slice/fonts` in the home folder. Only font files (`.ttf`, `.otf`, `.ttc`)
//! are listed, and only names this module makes are written: a safe file name with one of those extensions, written whole
//! through a temporary file and a rename. The window reads the files as data (the engine parses them; nothing here runs
//! or interprets a font).

use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde_json::{json, Value};

/// The largest font file the library lists or takes, bytes: the engine's own limit.
const MAX_FILE: u64 = 40 << 20;

/// The extensions of the font files the library holds.
const EXTENSIONS: [&str; 3] = ["ttf", "otf", "ttc"];

fn library_dir() -> Result<PathBuf, String> {
    if let Some(named) = std::env::var_os("LIME_FONTS_DIR").filter(|v| !v.is_empty()) {
        return Ok(PathBuf::from(named));
    }
    let home = std::env::var_os("USERPROFILE")
        .filter(|v| !v.is_empty())
        .or_else(|| std::env::var_os("HOME").filter(|v| !v.is_empty()))
        .ok_or_else(|| "The home folder is not known here.".to_string())?;
    Ok(PathBuf::from(home).join(".lime-slice").join("fonts"))
}

/// A file name the library writes: letters, digits, `.`, `_`, `-` and spaces, 1 to 120 characters, no `..`, and one of
/// the font extensions.
fn is_font_name(name: &str) -> bool {
    let ok_chars = name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ' '));
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase());
    ok_chars
        && !name.is_empty()
        && name.len() <= 120
        && !name.contains("..")
        && !name.starts_with('.')
        && ext.is_some_and(|e| EXTENSIONS.contains(&e.as_str()))
}

fn write_whole(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)
}

/// Every font file of `dir`, as `{name, dataB64}` in name order. A missing folder lists nothing.
pub fn list_in(dir: &Path) -> Value {
    let mut names: Vec<String> = fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
                .filter_map(|e| e.file_name().into_string().ok())
                .filter(|name| is_font_name(name))
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    let files: Vec<Value> = names
        .into_iter()
        .filter_map(|name| {
            let path = dir.join(&name);
            let meta = fs::metadata(&path).ok()?;
            if meta.len() > MAX_FILE {
                return None;
            }
            let bytes = fs::read(&path).ok()?;
            Some(json!({ "name": name, "dataB64": base64::engine::general_purpose::STANDARD.encode(bytes) }))
        })
        .collect();
    json!({ "dir": dir.to_string_lossy(), "files": files })
}

/// Write a font file into `dir` under `name`.
pub fn add_in(dir: &Path, name: &str, bytes: &[u8]) -> Result<(), String> {
    if !is_font_name(name) {
        return Err("That is not a name the font library keeps.".into());
    }
    if bytes.len() as u64 > MAX_FILE {
        return Err("This font file is larger than 40 MB.".into());
    }
    write_whole(&dir.join(name), bytes)
        .map_err(|e| format!("The font could not be saved to the library: {e}"))
}

/// Delete one font file of `dir`. Answers whether there was one.
pub fn remove_in(dir: &Path, name: &str) -> Result<bool, String> {
    if !is_font_name(name) {
        return Err("That is not a name the font library keeps.".into());
    }
    match fs::remove_file(dir.join(name)) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!(
            "The font could not be removed from the library: {e}"
        )),
    }
}

#[tauri::command]
pub fn font_library_list() -> Result<Value, String> {
    Ok(list_in(&library_dir()?))
}

#[tauri::command]
pub fn font_library_add(name: String, data_b64: String) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64.trim())
        .map_err(|_| "The font data is not base64.".to_string())?;
    add_in(&library_dir()?, &name, &bytes)
}

#[tauri::command]
pub fn font_library_remove(name: String) -> Result<bool, String> {
    remove_in(&library_dir()?, &name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lime-fonts-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn only_font_names_the_library_makes_are_accepted() {
        assert!(is_font_name("0123456789abcdef-Source Sans.ttf"));
        assert!(is_font_name("a.OTF"));
        assert!(is_font_name("collection.ttc"));
        for bad in [
            "",
            "a.exe",
            "a",
            "../a.ttf",
            "a/b.ttf",
            "a\\b.ttf",
            ".hidden.ttf",
            "a..ttf",
            "a.ttf.exe",
            "é.ttf",
        ] {
            assert!(!is_font_name(bad), "{bad:?}");
        }
        assert!(!is_font_name(&format!("{}.ttf", "a".repeat(120))));
    }

    #[test]
    fn a_font_is_added_listed_and_removed() {
        let dir = scratch("roundtrip");
        assert_eq!(
            list_in(&dir)["files"],
            json!([]),
            "a missing folder lists nothing"
        );
        add_in(&dir, "b-second.ttf", b"two").unwrap();
        add_in(&dir, "a-first.otf", b"one").unwrap();
        fs::write(dir.join("notes.txt"), "not a font").unwrap();
        let listed = list_in(&dir);
        let names: Vec<&str> = listed["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            ["a-first.otf", "b-second.ttf"],
            "only fonts, in name order"
        );
        assert_eq!(
            listed["files"][0]["dataB64"],
            json!(base64::engine::general_purpose::STANDARD.encode(b"one"))
        );
        assert!(remove_in(&dir, "a-first.otf").unwrap());
        assert!(!remove_in(&dir, "a-first.otf").unwrap(), "already gone");
        assert!(add_in(&dir, "../escape.ttf", b"x").is_err());
        assert!(
            remove_in(&dir, "notes.txt").is_err(),
            "only font names are removed"
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
