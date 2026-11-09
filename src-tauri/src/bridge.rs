//! Opt-in live mirror from the MCP server into this window.
//!
//! Off unless `LIME_BRIDGE` is `1`, `true`, or `yes`, and `LIME_BRIDGE_TOKEN`
//! is non-empty (the bridge launcher), or the person turned it on in the app
//! (the Tandem light): then the app keeps a random token in
//! `tandem-bridge.json` in its config folder, a file only this user can read,
//! and starts the bridge from it on every start until it is turned off. The
//! bundled MCP server reads the same file, so neither side needs the token typed.
//! The token is never logged and never sent anywhere but that file and the page.
//! The listener is `127.0.0.1` only (`LIME_BRIDGE_PORT`, default
//! 43119). Every request, including health, must send `Authorization: Bearer`.
//! A matching POST body is emitted as the `lime-bridge` event after any token
//! field is removed. A body `{"open": "<path>"}` is not mirrored: the window
//! requests that the page open that file the way File > Open does. It answers 204
//! when delivered, or 404 if the file cannot be read; the page may still ask
//! the user for confirmation. This
//! module does not start a process and does not open a console window.
//!
//! An authorised answer names this window's instance in `X-Lime-Bridge-Instance`,
//! and what it does beyond the mirror in `X-Lime-Bridge-Features` (`open`).
//! It changes when the app starts and each time the page calls `bridge_ready`,
//! so the server knows a page that has none of the meshes it sent before.

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::open_file;

const DEFAULT_PORT: u16 = 43119;
const TANDEM_BETA_PORT: u16 = 43129;
const MAX_HEADER: usize = 16 * 1024;
/// A plate message carries its meshes: room for a few large parts.
const MAX_BODY: usize = 256 * 1024 * 1024;

/// What this window does beyond the mirror, named on every authorised answer, so a server
/// sends an open message only to a window that will not take it for a plate.
const FEATURES: &str = "open tandem-context tandem-receipts";

/// Bumped by the page each time it mounts, so a reloaded page reads as a new desktop.
static PAGE_EPOCH: AtomicU64 = AtomicU64::new(0);
static START: OnceLock<String> = OnceLock::new();
static HUMAN_CONTEXT: Mutex<Option<Value>> = Mutex::new(None);
static RECEIPTS: Mutex<VecDeque<Value>> = Mutex::new(VecDeque::new());
/// The listener while it runs: who started it, its port, and how to stop it.
static RUNNING: Mutex<Option<Running>> = Mutex::new(None);
/// When an MCP server last sent an authorised request, in milliseconds since 1970. Zero: never.
static LAST_SEEN: AtomicU64 = AtomicU64::new(0);
/// An MCP server that talked within this long counts as connected.
const CONNECTED_FOR: Duration = Duration::from_secs(120);
/// The file the app keeps its own token in, in its config folder; the bundled MCP server reads it too.
const TOKEN_FILE: &str = "tandem-bridge.json";

struct Running {
    port: u16,
    /// `launcher` (the environment) or `app` (turned on in the app).
    source: &'static str,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

/// A part the page held back or replaced, as text fields only, each cut short: `{object, name, kind}`.
fn part_row(row: &Value, kinds: &[&str]) -> Option<Value> {
    let field = |key: &str| {
        row.get(key)
            .and_then(Value::as_str)
            .map(|text| text.chars().take(120).collect::<String>())
    };
    let kind = field("kind")?;
    if !kinds.contains(&kind.as_str()) {
        return None;
    }
    Some(serde_json::json!({ "object": field("object")?, "name": field("name")?, "kind": kind }))
}

/// Record a bounded outcome after the page has actually handled an MCP snapshot. A conflict names the parts it held
/// back; the rest of that snapshot applied. `replaced` names the parts where MCP's version replaced the window's own
/// (a person's edits, or a Model history MCP's does not continue); the window keeps its version as one undo step.
/// `waiting` says the page holds the snapshot until the person finishes (`reason`: a gesture, typing, a Model edit);
/// its outcome follows under the same sequence number.
#[tauri::command]
pub fn bridge_receipt(
    session: String,
    seq: u64,
    outcome: String,
    held: Option<Vec<Value>>,
    replaced: Option<Vec<Value>>,
    reason: Option<String>,
) {
    if session.is_empty()
        || session.len() > 120
        || !matches!(
            outcome.as_str(),
            "applied" | "diverged" | "conflict" | "missing" | "failed" | "stale" | "waiting"
        )
    {
        return;
    }
    let rows = |list: Option<Vec<Value>>, kinds: &[&str]| -> Vec<Value> {
        list.unwrap_or_default()
            .iter()
            .take(20)
            .filter_map(|row| part_row(row, kinds))
            .collect()
    };
    let held = rows(held, &["model-history", "both-changed", "removed-here"]);
    let replaced = rows(replaced, &["human-edits", "removed-here", "model-history"]);
    let reason =
        reason.filter(|text| matches!(text.as_str(), "gesture" | "typing" | "model-edit"));
    if let Ok(mut receipts) = RECEIPTS.lock() {
        if receipts.len() == 64 {
            receipts.pop_front();
        }
        let mut receipt = serde_json::json!({ "session": session, "seq": seq, "outcome": outcome });
        if !held.is_empty() {
            receipt["held"] = Value::Array(held);
        }
        if !replaced.is_empty() {
            receipt["replaced"] = Value::Array(replaced);
        }
        if let Some(reason) = reason {
            receipt["reason"] = Value::String(reason);
        }
        receipts.push_back(receipt);
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|time| time.as_millis() as u64)
        .unwrap_or(0)
}

/// The bridge as the Tandem light shows it: `off`, `on` (listening, no MCP server talked lately) or `connected`.
#[tauri::command]
pub fn bridge_status(app: AppHandle) -> Value {
    let beta = app.config().identifier == "com.limeslice.slicer.tandem-beta";
    let running = RUNNING
        .lock()
        .ok()
        .and_then(|running| running.as_ref().map(|run| (run.port, run.source)));
    let Some((port, source)) = running else {
        return serde_json::json!({ "state": "off", "beta": beta, "port": default_port(&app) });
    };
    let seen = LAST_SEEN.load(Ordering::SeqCst);
    let connected = seen > 0 && now_ms().saturating_sub(seen) < CONNECTED_FOR.as_millis() as u64;
    serde_json::json!({
        "state": if connected { "connected" } else { "on" },
        "beta": beta,
        "port": port,
        "source": source,
        "url": format!("http://127.0.0.1:{port}/"),
    })
}

/// Turn the bridge on from the app: a token from the file, or a new random one written there, and the listener.
#[tauri::command]
pub fn bridge_enable(app: AppHandle) -> Result<Value, String> {
    let running = RUNNING.lock().map(|run| run.is_some()).unwrap_or(false);
    if !running {
        let token = match read_token_file(&app) {
            Some(token) => token,
            None => {
                let token = new_token()?;
                write_token_file(&app, &token, default_port(&app))?;
                token
            }
        };
        listen(app.clone(), token, default_port(&app), "app")?;
    }
    Ok(bridge_status(app))
}

/// Turn the bridge off: the listener stops and the app's token file goes, so the next start stays off too.
#[tauri::command]
pub fn bridge_disable(app: AppHandle) -> Value {
    stop_listener();
    if let Some(path) = token_path(&app) {
        let _ = std::fs::remove_file(path);
    }
    bridge_status(app)
}

/// The two lines an MCP server's environment needs to reach this window, for the person to copy into another MCP
/// client's settings. Only while the bridge runs. The bundled MCP server does not need them: it reads the token file.
#[tauri::command]
pub fn bridge_setup(app: AppHandle) -> Option<Value> {
    let port = RUNNING.lock().ok()?.as_ref()?.port;
    let token = read_token_file(&app).or_else(|| {
        std::env::var("LIME_BRIDGE_TOKEN")
            .ok()
            .filter(|token| !token.is_empty())
    })?;
    let file = token_path(&app).map(|path| path.to_string_lossy().into_owned());
    Some(serde_json::json!({ "url": format!("http://127.0.0.1:{port}/"), "token": token, "file": file }))
}

fn default_port(app: &AppHandle) -> u16 {
    std::env::var("LIME_BRIDGE_PORT")
        .ok()
        .and_then(|text| text.trim().parse::<u16>().ok())
        .filter(|port| *port != 0)
        .unwrap_or(
            if app.config().identifier == "com.limeslice.slicer.tandem-beta" {
                TANDEM_BETA_PORT
            } else {
                DEFAULT_PORT
            },
        )
}

fn token_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(TOKEN_FILE))
}

/// The app's token, when the person turned the bridge on here and it was not turned off since.
fn read_token_file(app: &AppHandle) -> Option<String> {
    let text = std::fs::read_to_string(token_path(app)?).ok()?;
    token_from_file(&text)
}

fn token_from_file(text: &str) -> Option<String> {
    let value: Value = serde_json::from_str(text).ok()?;
    let token = value.get("token")?.as_str()?;
    (token.len() >= 32 && token.chars().all(|c| c.is_ascii_hexdigit())).then(|| token.to_string())
}

fn write_token_file(app: &AppHandle, token: &str, port: u16) -> Result<(), String> {
    let path = token_path(app).ok_or("The app has no config folder for the bridge token.")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|err| format!("The bridge token could not be kept: {err}"))?;
    }
    let body = serde_json::json!({ "url": format!("http://127.0.0.1:{port}/"), "token": token }).to_string();
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&path)
        .map_err(|err| format!("The bridge token could not be kept: {err}"))?;
    file.write_all(body.as_bytes())
        .map_err(|err| format!("The bridge token could not be kept: {err}"))
}

/// 32 random bytes from the operating system, as hex.
fn new_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "The system gave no random bytes for a bridge token.".to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// This process and page, as the server sees them.
fn instance() -> String {
    let start = START.get_or_init(|| {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|time| time.as_nanos())
            .unwrap_or(0);
        format!("{nanos:x}")
    });
    format!("{start}-{}", PAGE_EPOCH.load(Ordering::SeqCst))
}

/// The page mounted, or it missed a mesh: the server's next message sends every mesh again.
#[tauri::command]
pub fn bridge_ready() {
    PAGE_EPOCH.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut context) = HUMAN_CONTEXT.lock() {
        *context = None;
    }
}

/// A bounded, deliberately small description of the page; never input field values.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HumanContext {
    stage: String,
    selected: Option<String>,
    gesture: bool,
    editing: bool,
    conflict: Option<String>,
    #[serde(default)]
    conflicts: Vec<Value>,
    mirror_session: Option<String>,
    mirror_seq: Option<u64>,
    human_changes: Vec<Value>,
    human_changes_truncated: bool,
}

#[tauri::command]
pub fn bridge_human_context(context: HumanContext) {
    let HumanContext {
        stage,
        selected,
        gesture,
        editing,
        conflict,
        conflicts,
        mirror_session,
        mirror_seq,
        human_changes,
        human_changes_truncated,
    } = context;
    let conflicts: Vec<Value> = conflicts
        .into_iter()
        .take(8)
        .filter(|row| row.to_string().len() <= 1024)
        .collect();
    let stage: String = stage.chars().take(32).collect();
    let selected = selected.map(|name| name.chars().take(120).collect::<String>());
    let conflict = conflict.map(|name| name.chars().take(120).collect::<String>());
    let mirror_session = mirror_session.map(|name| name.chars().take(120).collect::<String>());
    let human_changes_count = human_changes.len();
    let human_changes: Vec<Value> = human_changes
        .into_iter()
        .take(20)
        .filter(|row| row.to_string().len() <= 2048)
        .collect();
    let human_changes_truncated =
        human_changes_truncated || human_changes.len() < human_changes_count;
    if let Ok(mut context) = HUMAN_CONTEXT.lock() {
        *context = Some(
            serde_json::json!({ "stage": stage, "selected": selected, "gesture": gesture, "editing": editing, "conflict": conflict, "conflicts": conflicts, "mirrorSession": mirror_session, "mirrorSeq": mirror_seq, "humanChanges": human_changes, "humanChangesTruncated": human_changes_truncated }),
        );
    }
}

/// At app start: the launcher's environment, else the token the person kept by turning the bridge on in the app.
pub fn start(app: AppHandle) {
    let port = default_port(&app);
    if flag_on("LIME_BRIDGE") {
        match std::env::var("LIME_BRIDGE_TOKEN")
            .ok()
            .filter(|token| !token.is_empty())
        {
            Some(token) => {
                if let Err(err) = listen(app, token, port, "launcher") {
                    eprintln!("lime-slice: {err}");
                }
                return;
            }
            None => eprintln!(
                "lime-slice: the live bridge stayed off because LIME_BRIDGE_TOKEN is empty."
            ),
        }
    }
    if let Some(token) = read_token_file(&app) {
        if let Err(err) = listen(app, token, port, "app") {
            eprintln!("lime-slice: {err}");
        }
    }
}

/// Bind loopback `port` and serve on a thread of its own until `stop_listener`.
fn listen(app: AppHandle, token: String, port: u16, source: &'static str) -> Result<(), String> {
    let addr = listen_addr(port);
    let listener = TcpListener::bind(addr)
        .map_err(|err| format!("the live bridge could not listen on {addr}: {err}"))?;
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();
    let thread = std::thread::spawn(move || serve(listener, token, app, flag));
    if let Ok(mut running) = RUNNING.lock() {
        *running = Some(Running {
            port,
            source,
            stop,
            thread: Some(thread),
        });
    }
    Ok(())
}

/// Stop the listener and wait for its thread, so the port is free for the next `listen`.
fn stop_listener() {
    let Some(mut running) = RUNNING.lock().ok().and_then(|mut running| running.take()) else {
        return;
    };
    running.stop.store(true, Ordering::SeqCst);
    // The thread waits in accept: a connection of our own wakes it to see the flag.
    let _ = TcpStream::connect_timeout(&listen_addr(running.port), Duration::from_secs(1));
    if let Some(thread) = running.thread.take() {
        let _ = thread.join();
    }
    LAST_SEEN.store(0, Ordering::SeqCst);
}

fn flag_on(name: &str) -> bool {
    matches!(
        std::env::var(name).ok().as_deref().map(str::trim),
        Some("1") | Some("true") | Some("yes")
    )
}

/// The only address the bridge binds. A host variable is not read.
pub fn listen_addr(port: u16) -> SocketAddr {
    SocketAddr::from((Ipv4Addr::LOCALHOST, port))
}

fn serve(listener: TcpListener, token: String, app: AppHandle, stop: Arc<AtomicBool>) {
    for incoming in listener.incoming() {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        let Ok(mut stream) = incoming else {
            continue;
        };
        let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
        let request = read_request(&mut stream);
        if let Ok(request) = &request {
            if tokens_match(bearer(&request.authorization), &token) {
                LAST_SEEN.store(now_ms(), Ordering::SeqCst);
            }
        }
        match request {
            Ok(request)
                if request.method.eq_ignore_ascii_case("GET")
                    && request.path == "/tandem-receipts"
                    && tokens_match(bearer(&request.authorization), &token) =>
            {
                let body = RECEIPTS
                    .lock()
                    .map(|items| serde_json::json!(&*items).to_string())
                    .unwrap_or_else(|_| "[]".into());
                let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nX-Lime-Bridge-Instance: {}\r\nX-Lime-Bridge-Features: {FEATURES}\r\nConnection: close\r\n\r\n{body}", body.len(), instance());
            }
            Ok(request)
                if request.method.eq_ignore_ascii_case("GET")
                    && request.path == "/tandem-context"
                    && tokens_match(bearer(&request.authorization), &token) =>
            {
                let body = HUMAN_CONTEXT
                    .lock()
                    .ok()
                    .and_then(|context| context.clone())
                    .unwrap_or(Value::Null)
                    .to_string();
                let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nX-Lime-Bridge-Instance: {}\r\nX-Lime-Bridge-Features: {FEATURES}\r\nConnection: close\r\n\r\n{body}", body.len(), instance());
            }
            Ok(request) => match decide(&request, &token) {
                (status, Some(Event::Mirror(mut value))) => {
                    let _ = write_status(&mut stream, status, &instance());
                    strip_secrets(&mut value);
                    let _ = app.emit("lime-bridge", value);
                }
                (_, Some(Event::Open(path))) => {
                    // Delivery follows the file read; the page may still ask for confirmation.
                    match open_file::deliver(&app, path) {
                        Ok(()) => {
                            let _ = write_status(&mut stream, 204, &instance());
                        }
                        Err(reason) => {
                            let _ = write_not_found(&mut stream, &reason);
                        }
                    }
                }
                (status, None) => {
                    let _ = write_status(&mut stream, status, &instance());
                }
            },
            Err(()) => {
                let _ = write_status(&mut stream, 400, "");
            }
        }
    }
}

struct Incoming {
    method: String,
    path: String,
    authorization: String,
    body: Vec<u8>,
}

fn read_request(stream: &mut TcpStream) -> Result<Incoming, ()> {
    let mut buf = Vec::new();
    let mut tmp = vec![0u8; 64 * 1024];
    let header_at = loop {
        if buf.len() > MAX_HEADER {
            return Err(());
        }
        let read = stream.read(&mut tmp).map_err(|_| ())?;
        if read == 0 {
            return Err(());
        }
        buf.extend_from_slice(&tmp[..read]);
        if let Some(at) = buf.windows(4).position(|window| window == b"\r\n\r\n") {
            break at;
        }
    };
    let header = std::str::from_utf8(&buf[..header_at]).map_err(|_| ())?;
    let mut lines = header.split("\r\n");
    let request_line = lines.next().ok_or(())?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().ok_or(())?.to_string();
    let path = parts.next().ok_or(())?.to_string();
    let mut authorization = String::new();
    let mut length = 0usize;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.eq_ignore_ascii_case("authorization") {
            authorization = value.trim().to_string();
        } else if name.eq_ignore_ascii_case("content-length") {
            length = value.trim().parse().map_err(|_| ())?;
        }
    }
    if length > MAX_BODY {
        return Err(());
    }
    let mut body = buf[header_at + 4..].to_vec();
    body.reserve(length.saturating_sub(body.len()));
    while body.len() < length {
        let read = stream.read(&mut tmp).map_err(|_| ())?;
        if read == 0 {
            return Err(());
        }
        body.extend_from_slice(&tmp[..read]);
    }
    body.truncate(length);
    Ok(Incoming {
        method,
        path,
        authorization,
        body,
    })
}

/// What an accepted POST asks of the window.
#[derive(Debug, PartialEq)]
enum Event {
    /// A plate message for the page's mirror.
    Mirror(Value),
    /// A file for the window to open.
    Open(PathBuf),
}

fn decide(request: &Incoming, token: &str) -> (u16, Option<Event>) {
    if !tokens_match(bearer(&request.authorization), token) {
        return (401, None);
    }
    let path = request.path.split('?').next().unwrap_or("");
    if path == "/health" || request.method.eq_ignore_ascii_case("GET") {
        return (200, None);
    }
    if !request.method.eq_ignore_ascii_case("POST") {
        return (405, None);
    }
    match serde_json::from_slice::<Value>(&request.body) {
        Ok(Value::Object(map)) => match map.get("open") {
            None => (204, Some(Event::Mirror(Value::Object(map)))),
            Some(Value::String(path)) if !path.is_empty() => {
                (204, Some(Event::Open(PathBuf::from(path))))
            }
            Some(_) => (400, None),
        },
        _ => (400, None),
    }
}

fn bearer(header: &str) -> &str {
    let rest = header.trim();
    let prefix = "bearer ";
    if rest.len() >= prefix.len() && rest[..prefix.len()].eq_ignore_ascii_case(prefix) {
        rest[prefix.len()..].trim()
    } else {
        ""
    }
}

/// Compare without returning early, so a mismatch does not reveal the token length by timing.
fn tokens_match(given: &str, expected: &str) -> bool {
    let given = given.as_bytes();
    let expected = expected.as_bytes();
    let mut diff = given.len() ^ expected.len();
    let len = given.len().max(expected.len());
    for index in 0..len {
        let left = given.get(index).copied().unwrap_or(0);
        let right = expected.get(index).copied().unwrap_or(0);
        diff |= usize::from(left ^ right);
    }
    diff == 0
}

fn strip_secrets(value: &mut Value) {
    let Some(map) = value.as_object_mut() else {
        return;
    };
    map.remove("token");
    map.remove("authorization");
    map.remove("LIME_BRIDGE_TOKEN");
}

fn write_status(stream: &mut TcpStream, status: u16, instance: &str) -> std::io::Result<()> {
    let (code, body) = match status {
        200 => ("200 OK", "ok"),
        204 => ("204 No Content", ""),
        401 => ("401 Unauthorized", ""),
        405 => ("405 Method Not Allowed", ""),
        _ => ("400 Bad Request", ""),
    };
    // Only an authorised answer names the instance.
    let named = if status == 200 || status == 204 {
        format!("X-Lime-Bridge-Instance: {instance}\r\nX-Lime-Bridge-Features: {FEATURES}\r\n")
    } else {
        String::new()
    };
    write!(
        stream,
        "HTTP/1.1 {code}\r\nContent-Length: {}\r\n{named}Connection: close\r\n\r\n{body}",
        body.len()
    )
}

/// An open the window refused, with the reason as the body for the server to pass on.
fn write_not_found(stream: &mut TcpStream, reason: &str) -> std::io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reason}",
        reason.len()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(method: &str, path: &str, token: &str, body: &str) -> Incoming {
        Incoming {
            method: method.into(),
            path: path.into(),
            authorization: format!("Bearer {token}"),
            body: body.as_bytes().to_vec(),
        }
    }

    #[test]
    fn the_bridge_binds_loopback_only() {
        let addr = listen_addr(43119);
        assert!(addr.ip().is_loopback());
        assert_eq!(addr.port(), 43119);
    }

    #[test]
    fn receipts_are_bounded_and_ignore_invalid_outcomes() {
        RECEIPTS.lock().unwrap().clear();
        bridge_receipt("s".into(), 0, "invented".into(), None, None, None);
        assert!(RECEIPTS.lock().unwrap().is_empty());
        for seq in 0..70 {
            bridge_receipt("s".into(), seq, "applied".into(), None, None, None);
        }
        {
            let receipts = RECEIPTS.lock().unwrap();
            assert_eq!(receipts.len(), 64);
            assert_eq!(receipts.front().unwrap()["seq"], 6);
            assert_eq!(receipts.back().unwrap()["seq"], 69);
        }
        let held = vec![
            serde_json::json!({ "object": "obj-1", "name": "Sphere 1", "kind": "model-history", "extra": "dropped" }),
            serde_json::json!({ "object": "obj_9", "name": "x", "kind": "invented" }),
        ];
        bridge_receipt("s".into(), 70, "conflict".into(), Some(held), None, None);
        let receipts = RECEIPTS.lock().unwrap();
        let last = receipts.back().unwrap();
        assert_eq!(last["outcome"], "conflict");
        assert_eq!(
            last["held"],
            serde_json::json!([{ "object": "obj-1", "name": "Sphere 1", "kind": "model-history" }])
        );
        drop(receipts);
        // Live shapes: MCP's version applied over the person's edits, and a snapshot waiting for a gesture.
        let replaced = vec![
            serde_json::json!({ "object": "obj_1", "name": "Glasses frame", "kind": "human-edits" }),
            serde_json::json!({ "object": "obj_2", "name": "x", "kind": "both-changed" }),
        ];
        bridge_receipt("s".into(), 71, "applied".into(), None, Some(replaced), None);
        bridge_receipt("s".into(), 72, "waiting".into(), None, None, Some("model-edit".into()));
        bridge_receipt("s".into(), 73, "waiting".into(), None, None, Some("<script>".into()));
        let receipts = RECEIPTS.lock().unwrap();
        let rows: Vec<&Value> = receipts.iter().rev().take(3).collect();
        assert_eq!(
            rows[2]["replaced"],
            serde_json::json!([{ "object": "obj_1", "name": "Glasses frame", "kind": "human-edits" }])
        );
        assert_eq!(rows[1]["outcome"], "waiting");
        assert_eq!(rows[1]["reason"], "model-edit");
        assert!(rows[0].get("reason").is_none());
    }

    #[test]
    fn only_a_long_hex_token_is_read_from_the_file() {
        let good = "ab".repeat(32);
        assert_eq!(
            token_from_file(&format!(r#"{{"url":"http://127.0.0.1:43129/","token":"{good}"}}"#)),
            Some(good)
        );
        assert_eq!(token_from_file(r#"{"token":"short"}"#), None);
        assert_eq!(token_from_file(&format!(r#"{{"token":"{}"}}"#, "zz".repeat(32))), None);
        assert_eq!(token_from_file("not json"), None);
        let made = new_token().unwrap();
        assert_eq!(made.len(), 64);
        assert_ne!(made, new_token().unwrap());
    }

    #[test]
    fn a_wrong_token_is_refused_and_a_post_is_kept() {
        assert!(tokens_match("abc", "abc"));
        assert!(!tokens_match("abc", "abcd"));
        assert!(!tokens_match("abc", "abd"));
        let denied = decide(&request("POST", "/", "nope", "{}"), "secret");
        assert_eq!(denied.0, 401);
        assert!(denied.1.is_none());
        let health = decide(&request("GET", "/health", "secret", ""), "secret");
        assert_eq!(health.0, 200);
        let (status, event) = decide(
            &request(
                "POST",
                "/",
                "secret",
                r#"{"tool":"object_place","token":"secret","ok":true}"#,
            ),
            "secret",
        );
        assert_eq!(status, 204);
        let Some(Event::Mirror(mut value)) = event else {
            panic!("a plate message is mirrored: {event:?}");
        };
        strip_secrets(&mut value);
        assert!(value.get("token").is_none());
        assert_eq!(value["tool"], "object_place");
    }

    #[test]
    fn a_new_page_is_a_new_instance() {
        let before = instance();
        assert_eq!(before, instance());
        bridge_ready();
        let after = instance();
        assert_ne!(before, after);
        assert_eq!(before.split('-').next(), after.split('-').next());
    }

    #[test]
    fn an_open_message_names_a_file_and_is_not_mirrored() {
        let (status, event) = decide(
            &request("POST", "/", "secret", r#"{"open":"C:\\work\\duck.lime"}"#),
            "secret",
        );
        assert_eq!(status, 204);
        assert_eq!(
            event,
            Some(Event::Open(PathBuf::from(r"C:\work\duck.lime")))
        );
        let empty = decide(&request("POST", "/", "secret", r#"{"open":""}"#), "secret");
        assert_eq!(empty, (400, None));
        let wrong = decide(&request("POST", "/", "secret", r#"{"open":3}"#), "secret");
        assert_eq!(wrong, (400, None));
        let denied = decide(
            &request("POST", "/", "nope", r#"{"open":"a.lime"}"#),
            "secret",
        );
        assert_eq!(denied, (401, None));
    }
}
