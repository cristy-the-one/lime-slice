//! The app's recipe runner (docs/plan-recipe-plugins.md D16): Rust only spawns and pipes.
//!
//! The protocol (start line, calls, replies, refusals, `done`) is `src/recipe/host.ts`, shared by the MCP server and
//! the window. This crate is what the window cannot do itself: build a recipe with the bundled lust in a slot, start
//! the program with an empty environment, hand each line it writes to the caller, write replies back, and stop it.
//! The limits are enforced here as well as in the host, so a stuck webview cannot leave a recipe running: wall time,
//! lines, calls, line length, and a memory cap (D11.2; a job object on Windows, the process's peak resident size on
//! Linux). Dropping a [`RecipeRun`] kills the recipe.

use std::ffi::OsString;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

pub mod opt;

/// Windows `CREATE_NO_WINDOW`: lust and the recipe are console programs, which would otherwise flash a window.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// How often the watcher looks at the clock and the recipe's memory.
const WATCH_EVERY: Duration = Duration::from_millis(20);

/// The most stderr kept for the caller (its tail), as the host keeps.
const STDERR_KEEP: usize = 64_000;

/// What a run may use. The host's own limits are the same numbers; these hold if the window stops answering.
#[derive(Debug, Clone)]
pub struct Limits {
    /// Wall time for the run, kernel time included.
    pub timeout: Duration,
    /// Call lines (`{"call": …}`) the recipe may write.
    pub max_calls: u32,
    /// Lines of any kind: calls, notes, describe lines.
    pub max_lines: u32,
    /// Longest line the recipe may write, in bytes.
    pub max_line_bytes: usize,
    /// The memory cap: past it the recipe is stopped (D11.2).
    pub memory_bytes: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Limits::for_calls(Duration::from_secs(30), 2000, 1 << 20)
    }
}

impl Limits {
    /// The host's three numbers, with room for notes and describe lines beside the calls, and the 1 GB cap.
    pub fn for_calls(timeout: Duration, max_calls: u32, max_line_bytes: usize) -> Limits {
        Limits {
            timeout,
            max_calls,
            max_lines: max_calls.saturating_mul(2).saturating_add(1000),
            max_line_bytes,
            memory_bytes: 1 << 30,
        }
    }
}

/// What a running recipe reports, in order: its lines, then one exit.
#[derive(Debug, Clone, PartialEq)]
pub enum RunEvent {
    /// One line the recipe wrote, without its newline. Blank lines are not sent.
    Line(String),
    Exit(RunExit),
}

#[derive(Debug, Clone, PartialEq)]
pub struct RunExit {
    /// The exit code; `None` when the recipe was killed.
    pub code: Option<i32>,
    /// Why the runner stopped the recipe, when it did: a sentence for the person.
    pub reason: Option<String>,
    /// The tail of what the recipe wrote to stderr (a panic's line is there).
    pub stderr: String,
}

/// The same sentences the host (src/recipe/host.ts) writes, so a stop reads the same whichever side made it.
pub fn timeout_sentence(timeout: Duration) -> String {
    format!("The recipe ran past its {} s limit and was stopped.", timeout.as_secs_f64())
}

pub fn calls_sentence(max_calls: u32) -> String {
    format!("The recipe made more than {max_calls} calls and was stopped.")
}

pub fn line_bytes_sentence(max_line_bytes: usize) -> String {
    format!("A recipe line passed {max_line_bytes} bytes.")
}

pub fn lines_sentence(max_lines: u32) -> String {
    format!("The recipe wrote more than {max_lines} lines and was stopped.")
}

pub fn memory_sentence(memory_bytes: u64) -> String {
    format!("The recipe used more than {} MB of memory and was stopped.", memory_bytes >> 20)
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

struct Shared {
    child: Mutex<Child>,
    stdin: Mutex<Option<ChildStdin>>,
    reason: Mutex<Option<String>>,
    #[cfg(windows)]
    _job: Option<win::Job>,
}

impl Shared {
    /// Stops the recipe with `reason`, unless something stopped it first.
    fn stop(&self, reason: String) {
        {
            let mut held = lock(&self.reason);
            if held.is_none() {
                *held = Some(reason);
            }
        }
        self.kill();
    }

    fn kill(&self) {
        let _ = lock(&self.child).kill();
    }
}

/// A started recipe. Lines and the exit arrive through the callback given to [`RecipeRun::start`], from the runner's
/// own threads. Dropping it kills the recipe.
pub struct RecipeRun {
    shared: Arc<Shared>,
}

impl RecipeRun {
    /// Starts `exe` (a built recipe) in `cwd` with an empty environment (`SystemRoot` only on Windows, which a process
    /// needs to start). `args` is for the runner's tests; a recipe gets none.
    pub fn start<F>(exe: &Path, args: &[&str], cwd: &Path, limits: Limits, on_event: F) -> io::Result<RecipeRun>
    where
        F: Fn(RunEvent) + Send + Sync + 'static,
    {
        let mut command = Command::new(exe);
        command
            .args(args)
            .current_dir(cwd)
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            if let Some(root) = std::env::var_os("SystemRoot") {
                command.env("SystemRoot", root);
            }
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = command.spawn()?;
        #[cfg(windows)]
        let job = win::Job::attach(&child, limits.memory_bytes.saturating_mul(2));
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let stdin = child.stdin.take();
        let shared = Arc::new(Shared {
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            reason: Mutex::new(None),
            #[cfg(windows)]
            _job: job,
        });
        let on_event = Arc::new(on_event);
        let reader = {
            let shared = Arc::clone(&shared);
            let on_event = Arc::clone(&on_event);
            let limits = limits.clone();
            thread::spawn(move || {
                if let Some(stdout) = stdout {
                    read_lines(stdout, &shared, &limits, &*on_event);
                }
            })
        };
        let errors = thread::spawn(move || {
            let mut kept = Vec::new();
            if let Some(mut stderr) = stderr {
                let mut chunk = [0u8; 8192];
                while let Ok(n) = stderr.read(&mut chunk) {
                    if n == 0 {
                        break;
                    }
                    kept.extend_from_slice(&chunk[..n]);
                    if kept.len() > STDERR_KEEP * 2 {
                        kept.drain(..kept.len() - STDERR_KEEP);
                    }
                }
            }
            let start = kept.len().saturating_sub(STDERR_KEEP);
            String::from_utf8_lossy(&kept[start..]).into_owned()
        });
        {
            let shared = Arc::clone(&shared);
            thread::spawn(move || {
                let started = Instant::now();
                let mut peak = 0u64;
                let code = loop {
                    {
                        let mut child = lock(&shared.child);
                        if let Ok(Some(status)) = child.try_wait() {
                            peak = peak.max(memory_peak(&child).unwrap_or(0));
                            break status.code();
                        }
                        peak = peak.max(memory_peak(&child).unwrap_or(0));
                    }
                    if peak > limits.memory_bytes {
                        shared.stop(memory_sentence(limits.memory_bytes));
                    } else if started.elapsed() > limits.timeout {
                        shared.stop(timeout_sentence(limits.timeout));
                    }
                    thread::sleep(WATCH_EVERY);
                };
                // A recipe stopped at its allocator's backstop exits on its own; its peak says why.
                if peak > limits.memory_bytes {
                    let mut held = lock(&shared.reason);
                    if held.is_none() {
                        *held = Some(memory_sentence(limits.memory_bytes));
                    }
                }
                let _ = reader.join();
                let stderr = errors.join().unwrap_or_default();
                lock(&shared.stdin).take();
                let reason = lock(&shared.reason).clone();
                on_event(RunEvent::Exit(RunExit { code, reason, stderr }));
            });
        }
        Ok(RecipeRun { shared })
    }

    /// Writes one line to the recipe (the newline is added).
    pub fn send(&self, line: &str) -> io::Result<()> {
        let mut stdin = lock(&self.shared.stdin);
        let Some(pipe) = stdin.as_mut() else {
            return Err(io::Error::new(io::ErrorKind::BrokenPipe, "the recipe's input is closed"));
        };
        pipe.write_all(line.as_bytes())?;
        pipe.write_all(b"\n")?;
        pipe.flush()
    }

    /// Closes the recipe's stdin (after `done`).
    pub fn close_input(&self) {
        lock(&self.shared.stdin).take();
    }

    /// Kills the recipe. The exit still arrives, with no reason of the runner's.
    pub fn kill(&self) {
        self.shared.kill();
    }

    /// Kills the recipe with a reason the exit carries.
    pub fn stop(&self, reason: &str) {
        self.shared.stop(reason.to_string());
    }
}

impl Drop for RecipeRun {
    fn drop(&mut self) {
        self.shared.kill();
    }
}

/// Splits stdout into lines and hands each on, counting lines and calls against the limits.
fn read_lines(mut stdout: impl Read, shared: &Shared, limits: &Limits, on_event: &dyn Fn(RunEvent)) {
    let mut buffer: Vec<u8> = Vec::new();
    let mut chunk = vec![0u8; 64 * 1024];
    let mut lines = 0u32;
    let mut calls = 0u32;
    loop {
        let n = match stdout.read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(n) => n,
        };
        buffer.extend_from_slice(&chunk[..n]);
        while let Some(end) = buffer.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buffer.drain(..=end).take(end).collect();
            if line.len() > limits.max_line_bytes {
                return shared.stop(line_bytes_sentence(limits.max_line_bytes));
            }
            let text = String::from_utf8_lossy(&line).into_owned();
            if text.trim().is_empty() {
                continue;
            }
            lines += 1;
            if lines > limits.max_lines {
                return shared.stop(lines_sentence(limits.max_lines));
            }
            if is_call(&text) {
                calls += 1;
                if calls > limits.max_calls {
                    // The host sees the same line and names its recipe line; the runner stops it either way.
                    on_event(RunEvent::Line(text));
                    return shared.stop(calls_sentence(limits.max_calls));
                }
            }
            on_event(RunEvent::Line(text));
        }
        if buffer.len() > limits.max_line_bytes {
            return shared.stop(line_bytes_sentence(limits.max_line_bytes));
        }
    }
}

fn is_call(line: &str) -> bool {
    line.contains("\"call\"")
        && serde_json::from_str::<serde_json::Value>(line)
            .ok()
            .is_some_and(|v| v.get("call").is_some_and(|c| c.is_string()))
}

/// The recipe's peak memory so far: its peak private commit on Windows, its peak resident size on Linux.
fn memory_peak(child: &Child) -> Option<u64> {
    #[cfg(windows)]
    {
        win::peak_commit(child)
    }
    #[cfg(target_os = "linux")]
    {
        let status = fs::read_to_string(format!("/proc/{}/status", child.id())).ok()?;
        let line = status.lines().find(|l| l.starts_with("VmHWM:"))?;
        let kb: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
        Some(kb * 1024)
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = child;
        None
    }
}

#[cfg(windows)]
mod win {
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_PROCESS_MEMORY,
    };
    use windows_sys::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};

    /// A job holding one recipe: the recipe dies when the job's handle closes (the run dropped, or the app gone), and
    /// cannot commit more than the backstop.
    pub struct Job(HANDLE);

    // The handle is only closed, once, on drop.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        pub fn attach(child: &Child, backstop: u64) -> Option<Job> {
            // SAFETY: plain Win32 calls on a job this function owns and the child's live process handle.
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return None;
                }
                let job = Job(job);
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_PROCESS_MEMORY;
                info.ProcessMemoryLimit = usize::try_from(backstop).unwrap_or(usize::MAX);
                let set = SetInformationJobObject(
                    job.0,
                    JobObjectExtendedLimitInformation,
                    (&raw const info).cast(),
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if set == 0 || AssignProcessToJobObject(job.0, child.as_raw_handle() as HANDLE) == 0 {
                    return None;
                }
                Some(job)
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: the handle came from CreateJobObjectW and is closed only here.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    pub fn peak_commit(child: &Child) -> Option<u64> {
        // SAFETY: the counters are written by the call into a struct of the size it is told.
        unsafe {
            let mut counters: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
            counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
            if K32GetProcessMemoryInfo(child.as_raw_handle() as HANDLE, &mut counters, counters.cb) == 0 {
                return None;
            }
            Some(counters.PeakPagefileUsage as u64)
        }
    }
}

/// lust's binary name on this platform.
fn lust_file() -> &'static str {
    if cfg!(windows) {
        "lust.exe"
    } else {
        "lust"
    }
}

/// Where lust is looked for, in order: `LIME_LUST`, the copy the installers ship beside the MCP server in the app's
/// resources (`mcp/lust/bin/lust`, tools/lust/stage.sh), then `lust` on PATH, as the MCP server looks (D15).
pub fn lust_candidates(resource_dir: Option<&Path>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(named) = std::env::var_os("LIME_LUST").filter(|v| !v.is_empty()) {
        out.push(PathBuf::from(named));
    }
    if let Some(dir) = resource_dir {
        let bundled = dir.join("mcp").join("lust").join("bin").join(lust_file());
        if bundled.is_file() {
            out.push(bundled);
        }
    }
    out.push(PathBuf::from("lust"));
    out
}

/// The first of [`lust_candidates`] that answers `--version`.
pub fn find_lust(resource_dir: Option<&Path>) -> Option<PathBuf> {
    lust_candidates(resource_dir).into_iter().find(|candidate| {
        let mut command = quiet(candidate);
        command.arg("--version").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        command.status().is_ok_and(|s| s.success())
    })
}

/// The lime-recipe crate recipes build against: `LIME_RECIPE_CRATE`, the copy beside the MCP server in the app's
/// resources (`mcp/lime-recipe`, tools/mcp/bundle.mjs), else the repo's (a development build).
pub fn recipe_crate_dir(resource_dir: Option<&Path>) -> Option<PathBuf> {
    if let Some(named) = std::env::var_os("LIME_RECIPE_CRATE").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(named));
    }
    let beside = resource_dir.map(|dir| dir.join("mcp").join("lime-recipe"));
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("lime-recipe");
    beside.into_iter().chain([repo]).find(|dir| dir.join("src").join("lib.rs").is_file())
}

fn quiet(program: impl Into<OsString>) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(program.into());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// One `lust build` of a slot: what the host's build loop reads (src/recipe/host.ts `CompileResult`).
#[derive(Debug, Clone)]
pub struct BuildOutput {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    /// The program, when the build made one.
    pub exe: Option<PathBuf>,
    /// The slot's `main.rs`, which lust's diagnostics name.
    pub main: PathBuf,
    /// Which program the build left: `opt` (lust's optimised build) or `tcc`.
    pub compiler: &'static str,
    /// True when lust was asked to mark unread `s.apply` calls ([`MARK_UNREAD_FN`]): `stdout` then lists them.
    pub marked: bool,
}

/// The function whose unread results lust marks (`--mark-unread`, docs/plan-native-recipes.md 7.1): `s.apply`, the
/// one call the host may hold back and build with others. The same name as `MARK_UNREAD_FN` in src/recipe/host.ts,
/// which reads the marks.
pub const MARK_UNREAD_FN: &str = "lime_recipe::Session::apply";

/// What a lust can be asked, beyond what every lust Lime Slice ran could.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct LustFeatures {
    /// `--mark-unread <fn>` (lust 0.3.0).
    pub mark_unread: bool,
}

impl LustFeatures {
    /// Read from lust's usage text, which names every flag.
    pub fn from_usage(usage: &str) -> LustFeatures {
        LustFeatures { mark_unread: usage.contains("--mark-unread") }
    }
}

/// What this lust can be asked, read once from `lust --help`. A lust that does not know a flag answers its usage and
/// exit code 2 to a build that passes it, which would fail every recipe: someone's own older build in `LIME_LUST` is
/// asked only for what it has.
pub fn lust_features(lust: &Path) -> LustFeatures {
    static FOUND: std::sync::LazyLock<Mutex<std::collections::HashMap<PathBuf, LustFeatures>>> = std::sync::LazyLock::new(Default::default);
    if let Some(found) = lock(&FOUND).get(lust) {
        return *found;
    }
    let mut command = quiet(lust);
    command.arg("--help").stdin(Stdio::null());
    let usage = command.output().map(|out| [out.stdout, out.stderr].concat()).unwrap_or_default();
    let found = LustFeatures::from_usage(&String::from_utf8_lossy(&usage));
    lock(&FOUND).insert(lust.to_path_buf(), found);
    found
}

/// The slots a root holds, as the MCP server's host keeps them (mcp/recipe.ts): a warm crate per slot, one lust daemon.
pub const SLOTS: u32 = 4;

/// Writes `text` as slot `slot`'s `main.rs` under `root` and builds it with `lust build --sandbox --json`, as the MCP
/// server's host does, with the crate's copy beside the slots. A build past `limit` is stopped (D11.3).
pub fn build(lust: &Path, root: &Path, crate_dir: &Path, slot: u32, text: &str, limit: Duration) -> io::Result<BuildOutput> {
    if slot >= SLOTS {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, format!("slot {slot} is not one of {SLOTS}")));
    }
    if crate_copy(root, crate_dir)? {
        built().clear();
    }
    let dir = root.join(format!("slot-{slot}"));
    fs::create_dir_all(dir.join("src"))?;
    let manifest = format!(
        "[package]\nname = \"recipe-slot-{slot}\"\nversion = \"0.1.0\"\nedition = \"2024\"\n\n[dependencies]\nlime-recipe = {{ path = \"../lime-recipe\" }}\n\n[workspace]\n"
    );
    write_if_changed(&dir.join("Cargo.toml"), &manifest)?;
    let main = dir.join("src").join("main.rs");
    // lust's optimised build (`--opt=bg`, zig cc) when the bundled zig is here; tcc otherwise (opt.rs).
    let opt = opt::opt_build(lust);
    let cache = root.join("cache");
    if opt.mode != opt::OptMode::Off {
        opt::drop_untrusted(&cache);
        if fs::read_to_string(&main).is_ok_and(|old| old != text) {
            opt::distrust_running(&cache);
        }
    }
    let exe = dir.join(if cfg!(windows) { "recipe.exe" } else { "recipe" });
    // The program this slot holds was built from this text by this lust against this crate: it is the program a
    // build would make. A build of unchanged text still ran lust and left a new file, and Windows takes about 0.3 s
    // to start a program file it has not run before, against a few milliseconds for one it has. Values go in the
    // start line, so a Live preview, an Apply and a rebuild from other values all come here with the same text.
    // While lust's background build may still swap in the optimised program, lust is asked each time.
    // lust says which `s.apply` calls the recipe never reads: the answer changes, not the program. The marks are in
    // the build's stdout, which a kept output keeps.
    let features = lust_features(lust);
    let key = (text.to_owned(), lust.to_path_buf(), opt.mode, features);
    if let Some(kept) = built().get(&exe) {
        if kept.0 == key && exe.is_file() && main.is_file() && (opt.mode != opt::OptMode::Bg || kept.1.compiler == "opt") {
            return Ok(kept.1.clone());
        }
    }
    built().remove(&exe);
    fs::write(&main, text)?;
    let _ = fs::remove_file(&exe);
    // Output goes to files: lust's daemon may inherit the handles and keep a pipe open past the build.
    let out_path = dir.join("build.out");
    let err_path = dir.join("build.err");
    let mut command = quiet(lust);
    command.arg("build").arg("--sandbox");
    if let Some(arg) = opt.arg() {
        command.arg(arg);
    }
    command
        .envs(opt.env.iter().map(|(k, v)| (*k, v)))
        .arg("--json")
        .args(if features.mark_unread { &["--mark-unread", MARK_UNREAD_FN][..] } else { &[] })
        .arg(&main)
        .arg("--manifest-path")
        .arg(dir.join("Cargo.toml"))
        .arg("-o")
        .arg(&exe)
        .env("LUST_DAEMON_SOCKET", root.join("lust.sock"))
        .env("LUST_CACHE_DIR", &cache)
        .stdin(Stdio::null())
        .stdout(File::create(&out_path)?)
        .stderr(File::create(&err_path)?);
    let mut child = command.spawn()?;
    let started = Instant::now();
    let mut note = String::new();
    let code = loop {
        if let Some(status) = child.try_wait()? {
            break status.code();
        }
        if started.elapsed() > limit {
            let _ = child.kill();
            let _ = child.wait();
            note = format!("\nlust build did not finish within {} s and was stopped.", limit.as_secs_f64());
            break None;
        }
        thread::sleep(Duration::from_millis(10));
    };
    let stdout = fs::read_to_string(&out_path).unwrap_or_default();
    let stderr = fs::read_to_string(&err_path).unwrap_or_default() + &note;
    let made = code == Some(0) && exe.is_file();
    let compiler = opt.built_with(&stderr);
    let output = BuildOutput { code, stdout, stderr, exe: made.then_some(exe.clone()), main, compiler, marked: features.mark_unread };
    if made {
        built().insert(exe, (key, output.clone()));
    }
    Ok(output)
}

type BuiltKey = (String, PathBuf, opt::OptMode, LustFeatures);
type Built = std::collections::HashMap<PathBuf, (BuiltKey, BuildOutput)>;

/// Each slot's last good build, by its program's path: the text, the lust and the build mode that made it.
fn built() -> std::sync::MutexGuard<'static, Built> {
    static BUILT: std::sync::LazyLock<std::sync::Mutex<Built>> = std::sync::LazyLock::new(Default::default);
    BUILT.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The crate's copy beside the slots, with a manifest of only name, version and edition (lust reads that shape without
/// `cargo metadata`); the same files the MCP server's host writes.
/// Answers whether the crate's text was written, which makes every built program stale.
fn crate_copy(root: &Path, crate_dir: &Path) -> io::Result<bool> {
    let lib = fs::read_to_string(crate_dir.join("src").join("lib.rs"))?;
    let dir = root.join("lime-recipe");
    fs::create_dir_all(dir.join("src"))?;
    let lib_path = dir.join("src").join("lib.rs");
    let changed = !fs::read_to_string(&lib_path).is_ok_and(|old| old == lib);
    write_if_changed(&lib_path, &lib)?;
    write_if_changed(
        &dir.join("Cargo.toml"),
        "[package]\nname = \"lime-recipe\"\nversion = \"0.1.0\"\nedition = \"2024\"\n\n[dependencies]\n\n[workspace]\n",
    )?;
    Ok(changed)
}

/// Writes only when the text differs, so lust's warm session keeps what it compiled.
fn write_if_changed(path: &Path, text: &str) -> io::Result<()> {
    if fs::read_to_string(path).is_ok_and(|old| old == text) {
        return Ok(());
    }
    fs::write(path, text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sentences_match_the_host() {
        // src/recipe/host.ts writes these words; a stop reads the same from either side.
        assert_eq!(timeout_sentence(Duration::from_secs(30)), "The recipe ran past its 30 s limit and was stopped.");
        assert_eq!(timeout_sentence(Duration::from_millis(500)), "The recipe ran past its 0.5 s limit and was stopped.");
        assert_eq!(calls_sentence(2000), "The recipe made more than 2000 calls and was stopped.");
        assert_eq!(line_bytes_sentence(1 << 20), "A recipe line passed 1048576 bytes.");
        let host = include_str!("../../../src/recipe/host.ts");
        assert!(host.contains("The recipe ran past its ${limits.timeoutS} s limit and was stopped."));
        assert!(host.contains("The recipe made more than ${limits.maxCalls} calls and was stopped."));
        assert!(host.contains("A recipe line passed ${limits.maxLineBytes} bytes."));
        assert_eq!(memory_sentence(1 << 30), "The recipe used more than 1024 MB of memory and was stopped.");
    }

    #[test]
    fn a_lust_is_asked_only_for_what_its_usage_names() {
        // lust 0.2.0's usage, and 0.3.0's.
        let old = "usage: lust <check|build|run> <file.rs> [--json] [--max-errors N] [--timings] [-o out] [-g] [--emit-c prefix] [-- args]";
        let new = "usage: lust <check|build|run> <file.rs> [--json] [--max-errors N] [--timings] [-o out] [-g] [--emit-c prefix] [--mark-unread <fn path>]... [-- args]";
        assert!(!LustFeatures::from_usage(old).mark_unread);
        assert!(LustFeatures::from_usage(new).mark_unread);
        assert_eq!(LustFeatures::from_usage(""), LustFeatures::default());
        // The host reads the marks by the same name.
        let host = include_str!("../../../src/recipe/host.ts");
        assert!(host.contains(&format!("export const MARK_UNREAD_FN = \"{MARK_UNREAD_FN}\";")));
    }

    #[test]
    fn a_call_line_is_one_with_a_call_name() {
        assert!(is_call(r#"{"id":1,"call":"model_apply","args":{}}"#));
        assert!(!is_call(r#"{"note":"the \"call\" word"}"#));
        assert!(!is_call(r#"{"call":3}"#));
        assert!(!is_call("not json \"call\""));
    }

    #[test]
    fn limits_leave_room_for_notes() {
        let limits = Limits::default();
        assert_eq!(limits.max_calls, 2000);
        assert_eq!(limits.max_lines, 5000);
        assert_eq!(limits.memory_bytes, 1 << 30);
    }

    #[test]
    fn lust_is_looked_for_beside_the_mcp_server() {
        let dir = std::env::temp_dir().join(format!("lime-runner-find-{}", std::process::id()));
        let bin = dir.join("mcp").join("lust").join("bin");
        fs::create_dir_all(&bin).unwrap();
        fs::write(bin.join(lust_file()), b"").unwrap();
        let found = lust_candidates(Some(&dir));
        assert!(found.contains(&bin.join(lust_file())), "{found:?}");
        assert_eq!(found.last(), Some(&PathBuf::from("lust")));
        let crate_dir = dir.join("mcp").join("lime-recipe").join("src");
        fs::create_dir_all(&crate_dir).unwrap();
        fs::write(crate_dir.join("lib.rs"), b"").unwrap();
        if std::env::var_os("LIME_RECIPE_CRATE").is_none() {
            assert_eq!(recipe_crate_dir(Some(&dir)), Some(dir.join("mcp").join("lime-recipe")));
        }
        let _ = fs::remove_dir_all(&dir);
    }
}
