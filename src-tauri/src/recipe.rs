//! Recipes in the window (docs/plan-recipe-plugins.md D16): the Tauri side of `src/recipe/tauri.ts`.
//!
//! The protocol host is the shared TypeScript in `src/recipe/host.ts`; these commands only build with the bundled lust
//! (`recipe_build`), start a built recipe (`recipe_start`), pipe lines both ways (`recipe-line` events out,
//! `recipe_send` in), and stop it (`recipe_close_input`, `recipe_kill`). The runner (`lime-recipe-runner`) enforces
//! the limits and the memory cap itself, and every running recipe is killed when the window closes. The app's slots
//! and lust daemon live under their own root, apart from the MCP server's.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::Duration;

use lime_recipe_runner::{build, find_lust, recipe_crate_dir, Limits, RecipeRun, RunEvent};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

/// A plugin build is limited to 30 s (D11.3); a cold slot takes about a second.
const BUILD_LIMIT: Duration = Duration::from_secs(30);

pub struct Recipes {
    root: PathBuf,
    resource_dir: Option<PathBuf>,
    lust: OnceLock<Option<PathBuf>>,
    runs: Mutex<HashMap<String, RecipeRun>>,
    /// One build at a time (D11.3).
    building: Mutex<()>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Recipes {
    pub fn new(resource_dir: Option<PathBuf>) -> Recipes {
        Recipes {
            root: std::env::temp_dir().join("lime-recipes-app"),
            resource_dir,
            lust: OnceLock::new(),
            runs: Mutex::new(HashMap::new()),
            building: Mutex::new(()),
        }
    }

    fn lust(&self) -> Option<PathBuf> {
        self.lust.get_or_init(|| find_lust(self.resource_dir.as_deref())).clone()
    }

    fn crate_dir(&self) -> Option<PathBuf> {
        recipe_crate_dir(self.resource_dir.as_deref())
    }

    /// Kills every running recipe (the window is closing).
    pub fn stop_all(&self) {
        lock(&self.runs).clear();
    }

    /// Whether `exe` is a program this app built: a slot's recipe under the app's root, nothing else.
    fn built_here(&self, exe: &Path) -> bool {
        let (Ok(exe), Ok(root)) = (exe.canonicalize(), self.root.canonicalize()) else {
            return false;
        };
        let name = if cfg!(windows) { "recipe.exe" } else { "recipe" };
        exe.file_name().is_some_and(|n| n == name)
            && exe.parent().and_then(Path::parent) == Some(root.as_path())
            && exe.parent().and_then(Path::file_name).is_some_and(|n| n.to_string_lossy().starts_with("slot-"))
    }
}

fn unavailable() -> String {
    if cfg!(target_os = "macos") {
        "Running plugins needs lust, which the macOS app does not ship yet.".to_string()
    } else {
        "Running plugins needs lust, which this install does not have. Reinstall Lime Slice, or set LIME_LUST to a lust binary.".to_string()
    }
}

/// Whether recipes can run here, and why not.
#[tauri::command]
pub async fn recipe_available(state: State<'_, Recipes>) -> Result<Value, String> {
    let Some(lust) = state.lust() else {
        return Ok(json!({ "ok": false, "reason": unavailable() }));
    };
    if state.crate_dir().is_none() {
        return Ok(json!({ "ok": false, "reason": "The lime-recipe crate is missing from this install. Reinstall Lime Slice." }));
    }
    Ok(json!({ "ok": true, "lust": lust.to_string_lossy() }))
}

/// Writes `source` as slot `slot`'s `main.rs` and builds it: lust's exit code and output, the program, and `main`.
#[tauri::command]
pub async fn recipe_build(app: AppHandle, slot: u32, source: String) -> Result<Value, String> {
    let worker = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = worker.state::<Recipes>();
        let lust = state.lust().ok_or_else(unavailable)?;
        let crate_dir = state.crate_dir().ok_or("The lime-recipe crate is missing from this install.")?;
        let _one = lock(&state.building);
        let out = build(&lust, &state.root, &crate_dir, slot, &source, BUILD_LIMIT).map_err(|e| e.to_string())?;
        Ok(json!({
            "code": out.code,
            "stdout": out.stdout,
            "stderr": out.stderr,
            "exe": out.exe.map(|p| p.to_string_lossy().into_owned()),
            "main": out.main.to_string_lossy(),
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The host's limits (src/recipe/host.ts `RecipeLimits`).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunLimits {
    timeout_s: f64,
    max_calls: u32,
    max_line_bytes: usize,
}

/// Starts a recipe this app built, under the run id the window chose. Its lines arrive as `recipe-line` events and its
/// end as one `recipe-exit`.
#[tauri::command]
pub fn recipe_start(app: AppHandle, state: State<'_, Recipes>, run: String, exe: String, limits: RunLimits) -> Result<(), String> {
    let exe = PathBuf::from(exe);
    if !state.built_here(&exe) {
        return Err("Only a recipe this app built can run.".to_string());
    }
    if !(limits.timeout_s.is_finite() && limits.timeout_s > 0.0) {
        return Err("The time limit must be a positive number of seconds.".to_string());
    }
    let limits = Limits::for_calls(Duration::from_secs_f64(limits.timeout_s.min(3600.0)), limits.max_calls, limits.max_line_bytes);
    let events = app.clone();
    let id = run.clone();
    // Held across the start, so a recipe that ends at once is removed after it was put in.
    let mut runs = lock(&state.runs);
    let started = RecipeRun::start(&exe, &[], &state.root, limits, move |event| match event {
        RunEvent::Line(line) => {
            let _ = events.emit("recipe-line", json!({ "run": id, "line": line }));
        }
        RunEvent::Exit(exit) => {
            lock(&events.state::<Recipes>().runs).remove(&id);
            let _ = events.emit("recipe-exit", json!({ "run": id, "code": exit.code, "reason": exit.reason, "stderr": exit.stderr }));
        }
    })
    .map_err(|e| format!("The recipe could not start: {e}"))?;
    runs.insert(run, started);
    Ok(())
}

/// Writes one reply line to a running recipe.
#[tauri::command]
pub fn recipe_send(state: State<'_, Recipes>, run: String, line: String) -> Result<(), String> {
    let runs = lock(&state.runs);
    let recipe = runs.get(&run).ok_or("That recipe is no longer running.")?;
    recipe.send(&line).map_err(|e| e.to_string())
}

/// Closes a recipe's input (after `done`).
#[tauri::command]
pub fn recipe_close_input(state: State<'_, Recipes>, run: String) {
    if let Some(recipe) = lock(&state.runs).get(&run) {
        recipe.close_input();
    }
}

/// Kills a running recipe; its `recipe-exit` still arrives.
#[tauri::command]
pub fn recipe_kill(state: State<'_, Recipes>, run: String) {
    if let Some(recipe) = lock(&state.runs).get(&run) {
        recipe.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_slot_program_under_the_root_runs() {
        let base = std::env::temp_dir().join(format!("lime-recipes-app-test-{}", std::process::id()));
        let recipes = Recipes { root: base.clone(), ..Recipes::new(None) };
        let name = if cfg!(windows) { "recipe.exe" } else { "recipe" };
        let slot = base.join("slot-0");
        std::fs::create_dir_all(&slot).unwrap();
        std::fs::write(slot.join(name), b"").unwrap();
        std::fs::write(base.join(name), b"").unwrap();
        assert!(recipes.built_here(&slot.join(name)));
        assert!(!recipes.built_here(&base.join(name)), "a program beside the slots is not a slot's");
        assert!(!recipes.built_here(&slot.join("other.exe")));
        assert!(!recipes.built_here(&slot.join("..").join("..").join(name)));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn the_app_uses_its_own_root() {
        let recipes = Recipes::new(None);
        assert!(recipes.root.ends_with("lime-recipes-app"));
        assert!(!unavailable().is_empty());
    }
}
