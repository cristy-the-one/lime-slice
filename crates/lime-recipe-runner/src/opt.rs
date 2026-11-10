//! Optimised recipe builds: lust's `--opt=bg` with the zig the installers bundle beside lust (lust-lang docs/opt.md).
//! The same rules as the MCP server's `mcp/recipe-opt.ts`, which says why each is so:
//!
//! - zig: `LIME_ZIG`, else `zig/zig` in the bundled lust's folder (`mcp/lust/zig`). Without one, builds stay tcc.
//! - `LIME_LUST_OPT`: `0` off, `now` a foreground `--opt` build, `1` `--opt=bg`; unset, `--opt=bg` on Windows only.
//! - zig's cache is Lime Slice's own (`cache_root`), shared with the MCP server; until a one-shot warm-up without
//!   lust's daemon has filled it, builds stay tcc (a cold zig cache would hold the daemon for about a minute).
//! - Before a slot's file changes while lust's background builds run, those builds are untrusted, and their binaries
//!   are removed once they end (lust reads the file when its background build runs).

use std::ffi::OsString;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

/// How a build runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OptMode {
    /// tcc only.
    Off,
    /// `--opt=bg`: tcc now, the cached optimised binary on a later build of the same source.
    Bg,
    /// `--opt`: the optimised binary now (tests).
    Now,
}

/// What one build passes to lust.
#[derive(Debug, Clone)]
pub struct OptBuild {
    pub mode: OptMode,
    /// zig's folder first on PATH, and zig's cache dirs. Empty without zig.
    pub env: Vec<(&'static str, OsString)>,
}

impl OptBuild {
    /// The extra `lust build` argument, if any.
    pub fn arg(&self) -> Option<&'static str> {
        match self.mode {
            OptMode::Off => None,
            OptMode::Bg => Some("--opt=bg"),
            OptMode::Now => Some("--opt"),
        }
    }

    /// `opt` when the build left lust's optimised program (it said it installed one, or `--opt` built it), else `tcc`.
    pub fn built_with(&self, stderr: &str) -> &'static str {
        match self.mode {
            OptMode::Now => "opt",
            OptMode::Bg if stderr.lines().any(|l| l.starts_with("opt: cached optimised build")) => "opt",
            _ => "tcc",
        }
    }
}

fn zig_file() -> &'static str {
    if cfg!(windows) {
        "zig.exe"
    } else {
        "zig"
    }
}

/// The zig lust would use: `LIME_ZIG`, else the one bundled beside lust (`<lust>/../../zig/zig`).
pub fn zig_for(lust: &Path) -> Option<PathBuf> {
    if let Some(named) = std::env::var_os("LIME_ZIG").filter(|v| !v.is_empty()) {
        let named = PathBuf::from(named);
        return named.is_file().then_some(named);
    }
    let bundled = lust.parent()?.parent()?.join("zig").join(zig_file());
    bundled.is_file().then_some(bundled)
}

/// Lime Slice's own cache folder (zig's cache lives in `zig/` there), as the MCP server names it.
pub fn cache_root() -> PathBuf {
    let var = |name: &str| std::env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from);
    if let Some(named) = var("LIME_LUST_OPT_CACHE") {
        return named;
    }
    if cfg!(windows) {
        return var("LOCALAPPDATA").unwrap_or_else(std::env::temp_dir).join("Lime Slice").join("cache");
    }
    let home = var("HOME").unwrap_or_else(std::env::temp_dir);
    if cfg!(target_os = "macos") {
        return home.join("Library").join("Caches").join("Lime Slice");
    }
    var("XDG_CACHE_HOME").unwrap_or_else(|| home.join(".cache")).join("lime-slice")
}

/// Where `--opt=bg` is on by default: Windows only, where the optimised program is proven to send tcc's bytes (on
/// Linux zig's default glibc 2.28 target links the old `log@GLIBC_2.2.5`, whose NaN sign differs; macOS is not proven:
/// CI's macOS job runs the proof since lust 0.3.0, not blocking, and the default waits for its result).
pub const OPT_BY_DEFAULT: bool = cfg!(windows);

/// `LIME_LUST_OPT`: `0` off, `now` foreground `--opt`, `1` (or `bg`) `--opt=bg` anywhere, unset the platform's default.
fn mode() -> OptMode {
    match std::env::var("LIME_LUST_OPT").unwrap_or_default().trim().to_ascii_lowercase().as_str() {
        "0" | "off" | "false" => OptMode::Off,
        "now" => OptMode::Now,
        "" if !OPT_BY_DEFAULT => OptMode::Off,
        _ => OptMode::Bg,
    }
}

/// How the next build runs; starts the warm-up when zig's cache is cold (the build then stays tcc).
pub fn opt_build(lust: &Path) -> OptBuild {
    let off = OptBuild { mode: OptMode::Off, env: Vec::new() };
    let wanted = mode();
    if wanted == OptMode::Off {
        return off;
    }
    let Some(zig) = zig_for(lust) else { return off };
    let cache = cache_root();
    let zig_cache = cache.join("zig");
    if fs::create_dir_all(&zig_cache).is_err() {
        return off;
    }
    let mut paths = vec![zig.parent().map(Path::to_path_buf).unwrap_or_default()];
    paths.extend(std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()));
    let path = std::env::join_paths(paths).unwrap_or_default();
    let env = vec![("PATH", path), ("ZIG_GLOBAL_CACHE_DIR", zig_cache.clone().into_os_string()), ("ZIG_LOCAL_CACHE_DIR", zig_cache.into_os_string())];
    if wanted == OptMode::Now {
        return OptBuild { mode: wanted, env };
    }
    let marker = warm_marker(&cache, lust, &zig);
    if !marker.is_file() {
        warm_up(lust, &env, marker);
        return OptBuild { mode: OptMode::Off, env };
    }
    OptBuild { mode: OptMode::Bg, env }
}

/// One marker per lust and zig pair (their paths and sizes).
fn warm_marker(cache: &Path, lust: &Path, zig: &Path) -> PathBuf {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for p in [lust, zig] {
        p.hash(&mut hasher);
        fs::metadata(p).map(|m| m.len()).unwrap_or(0).hash(&mut hasher);
    }
    cache.join(format!("warm-app-{:016x}", hasher.finish()))
}

static WARMING: AtomicBool = AtomicBool::new(false);

/// A one-shot `lust build --sandbox --opt` of a small program, with no daemon and its own lust cache, so zig builds
/// its libc and compiler_rt into the shared cache once. Writes `marker` on success. One at a time per process.
fn warm_up(lust: &Path, env: &[(&'static str, OsString)], marker: PathBuf) {
    if WARMING.swap(true, Ordering::SeqCst) {
        return;
    }
    let lust = lust.to_path_buf();
    let env = env.to_vec();
    thread::spawn(move || {
        let dir = std::env::temp_dir().join(format!("lime-lust-warm-app-{}", std::process::id()));
        let ok = (|| -> std::io::Result<bool> {
            fs::create_dir_all(&dir)?;
            let main = dir.join("main.rs");
            fs::write(
                &main,
                "fn main() {\n    let mut s = 0.0f64;\n    for i in 0..1000 { s += (i as f64).sin() * (i as f64).sqrt(); }\n    println!(\"{}\", s.to_bits());\n}\n",
            )?;
            let mut command = super::quiet(lust.clone());
            command
                .arg("build")
                .arg("--sandbox")
                .arg("--opt")
                .arg(&main)
                .arg("-o")
                .arg(dir.join(if cfg!(windows) { "warm.exe" } else { "warm" }))
                .envs(env.iter().map(|(k, v)| (*k, v)))
                .env("LUST_NO_DAEMON", "1")
                .env("LUST_CACHE_DIR", dir.join("cache"))
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            let mut child = command.spawn()?;
            let started = Instant::now();
            loop {
                if let Some(status) = child.try_wait()? {
                    return Ok(status.success());
                }
                if started.elapsed() > Duration::from_secs(15 * 60) {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Ok(false);
                }
                thread::sleep(Duration::from_millis(250));
            }
        })()
        .unwrap_or(false);
        if ok {
            let _ = fs::write(&marker, b"ok\n");
        }
        let _ = fs::remove_dir_all(&dir);
        WARMING.store(false, Ordering::SeqCst);
    });
}

const UNTRUSTED: &str = "opt-untrusted.txt";

/// The background builds in flight under lust's cache `cache` are untrusted from now on (a slot's file is changing).
pub fn distrust_running(cache: &Path) {
    let Ok(dir) = fs::read_dir(cache.join("opt")) else { return };
    let mut names: Vec<String> = dir
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| n.ends_with(".lock") && n != "running.lock")
        .map(|n| n.trim_end_matches(".lock").to_string())
        .collect();
    if names.is_empty() {
        return;
    }
    let list = cache.join(UNTRUSTED);
    names.extend(fs::read_to_string(&list).unwrap_or_default().lines().filter(|l| !l.is_empty()).map(str::to_string));
    names.sort();
    names.dedup();
    let _ = fs::write(&list, names.join("\n") + "\n");
}

/// Removes the untrusted binaries whose background build has ended.
pub fn drop_untrusted(cache: &Path) {
    let list = cache.join(UNTRUSTED);
    let Ok(text) = fs::read_to_string(&list) else { return };
    let opt = cache.join("opt");
    let left: Vec<&str> = text
        .lines()
        .filter(|name| !name.is_empty())
        .filter(|name| {
            if opt.join(format!("{name}.lock")).exists() {
                return true;
            }
            let _ = fs::remove_file(opt.join(format!("{name}.ok")));
            let _ = fs::remove_file(opt.join(name));
            false
        })
        .collect();
    if left.is_empty() {
        let _ = fs::remove_file(&list);
    } else {
        let _ = fs::write(&list, left.join("\n") + "\n");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_build_that_ran_while_a_slot_changed_is_dropped_when_it_ends() {
        let cache = std::env::temp_dir().join(format!("lime-runner-opt-{}", std::process::id()));
        let opt = cache.join("opt");
        fs::create_dir_all(&opt).unwrap();
        for f in ["opt-a.exe.lock", "running.lock", "opt-b.exe", "opt-b.exe.ok"] {
            fs::write(opt.join(f), b"").unwrap();
        }
        distrust_running(&cache);
        assert_eq!(fs::read_to_string(cache.join(UNTRUSTED)).unwrap(), "opt-a.exe\n");
        drop_untrusted(&cache);
        assert!(cache.join(UNTRUSTED).is_file(), "still running: kept on the list");
        fs::write(opt.join("opt-a.exe"), b"").unwrap();
        fs::write(opt.join("opt-a.exe.ok"), b"").unwrap();
        fs::remove_file(opt.join("opt-a.exe.lock")).unwrap();
        drop_untrusted(&cache);
        assert!(!opt.join("opt-a.exe").exists() && !opt.join("opt-a.exe.ok").exists());
        assert!(opt.join("opt-b.exe").exists(), "a build nobody distrusted stays");
        assert!(!cache.join(UNTRUSTED).exists());
        let _ = fs::remove_dir_all(&cache);
    }

    #[test]
    fn which_program_a_build_left() {
        let bg = OptBuild { mode: OptMode::Bg, env: Vec::new() };
        assert_eq!(bg.built_with("opt: cached optimised build\n"), "opt");
        assert_eq!(bg.built_with("opt: optimised build started in the background\n"), "tcc");
        assert_eq!(OptBuild { mode: OptMode::Off, env: Vec::new() }.built_with(""), "tcc");
        assert_eq!(bg.arg(), Some("--opt=bg"));
    }

    #[test]
    fn the_bundled_zig_sits_beside_lust() {
        if std::env::var_os("LIME_ZIG").is_some() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("lime-runner-zig-{}", std::process::id()));
        let bin = dir.join("lust").join("bin");
        fs::create_dir_all(&bin).unwrap();
        assert_eq!(zig_for(&bin.join("lust")), None);
        fs::create_dir_all(dir.join("lust").join("zig")).unwrap();
        fs::write(dir.join("lust").join("zig").join(zig_file()), b"").unwrap();
        assert_eq!(zig_for(&bin.join("lust")), Some(dir.join("lust").join("zig").join(zig_file())));
        let _ = fs::remove_dir_all(&dir);
    }
}
