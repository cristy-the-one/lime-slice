//! Finished slices on disk, keyed by the exact request and the engine build,
//! so asking for the same slice again loads it instead of planning it.

use std::fs;
use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::LazyLock;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{slice_request, Job, SliceRequest};

/// A folder of `<key>.json` files, each one slice reply with its G-code.
pub struct SliceCache {
    dir: PathBuf,
    cap_bytes: u64,
}

/// Hash of the running executable. A rebuilt engine can slice differently, so
/// it never reads entries an older build wrote. `None` turns the cache off.
static ENGINE: LazyLock<Option<String>> = LazyLock::new(|| {
    let exe = std::env::current_exe().and_then(fs::read).ok()?;
    Some(hex(&Sha256::digest(exe)))
});

impl SliceCache {
    /// Entries live in `dir`. Once they pass `cap_bytes`, the least recently
    /// used go first.
    pub fn new(dir: impl Into<PathBuf>, cap_bytes: u64) -> Self {
        Self {
            dir: dir.into(),
            cap_bytes,
        }
    }

    fn path(&self, key: &str) -> PathBuf {
        self.dir.join(format!("{key}.json"))
    }

    fn load(&self, key: &str) -> Option<Value> {
        let path = self.path(key);
        let reply = serde_json::from_slice(&fs::read(&path).ok()?).ok()?;
        if let Ok(file) = fs::File::options().write(true).open(&path) {
            let _ = file.set_modified(SystemTime::now());
        }
        Some(reply)
    }

    fn store(&self, key: &str, reply: &Value) -> io::Result<()> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        fs::create_dir_all(&self.dir)?;
        let tmp = self.dir.join(format!(
            "{key}.{}.{}.tmp",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::write(&tmp, reply.to_string())?;
        fs::rename(&tmp, self.path(key))?;
        self.evict()
    }

    fn evict(&self) -> io::Result<()> {
        let mut entries: Vec<(SystemTime, u64, PathBuf)> = fs::read_dir(&self.dir)?
            .filter_map(|e| {
                let e = e.ok()?;
                let meta = e.metadata().ok()?;
                let (path, modified) = (e.path(), meta.modified().ok()?);
                (path.extension()? == "json").then_some((modified, meta.len(), path))
            })
            .collect();
        entries.sort();
        let mut total: u64 = entries.iter().map(|e| e.1).sum();
        for (_, len, path) in entries {
            if total <= self.cap_bytes {
                break;
            }
            fs::remove_file(path)?;
            total -= len;
        }
        Ok(())
    }
}

/// Slice the JSON `payload`, or load the same slice from `cache`. A payload
/// with `"reslice": true` always plans and replaces the cached entry. Without
/// `includeGcode`, the G-code goes to `park` and the reply carries the token it
/// returns as `gcodeToken`. Every reply has `slicedAtMs` and `fromCache`.
pub fn slice_payload(
    payload: &str,
    cache: Option<&SliceCache>,
    job: Job,
    park: impl FnOnce(String) -> String,
) -> Result<String, String> {
    let mut value: Value = serde_json::from_str(payload).map_err(|e| e.to_string())?;
    let reslice = value
        .as_object_mut()
        .and_then(|o| o.remove("reslice"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let key = ENGINE.as_deref().map(|engine| cache_key(engine, &value));
    let cache = cache.zip(key.as_deref());
    let req: SliceRequest = serde_json::from_value(value).map_err(|e| e.to_string())?;
    let hit = cache
        .filter(|_| !reslice)
        .and_then(|(cache, key)| cache.load(key));
    let from_cache = hit.is_some();
    let mut reply = match hit {
        Some(reply) => reply,
        None => {
            let response = slice_request(&req, job)?;
            let mut reply = serde_json::to_value(&response).map_err(|e| e.to_string())?;
            reply["slicedAtMs"] = json!(now_ms());
            if let Some((cache, key)) = cache {
                // A slice that cannot be kept is still a slice.
                let _ = cache.store(key, &reply);
            }
            reply
        }
    };
    let obj = reply
        .as_object_mut()
        .ok_or("slice reply is not an object")?;
    obj.insert("fromCache".into(), json!(from_cache));
    if !req.include_gcode {
        let gcode = match obj.remove("gcode") {
            Some(Value::String(text)) => text,
            _ => String::new(),
        };
        obj.insert("gcodeToken".into(), json!(park(gcode)));
    }
    Ok(reply.to_string())
}

fn cache_key(engine: &str, request: &Value) -> String {
    let mut hash = Sha256::new();
    hash.update(engine.as_bytes());
    feed(&mut hash, request);
    hex(&hash.finalize())
}

/// Object keys in sorted order, so the key does not depend on field order.
fn feed(hash: &mut Sha256, value: &Value) {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            hash.update(b"{");
            for k in keys {
                feed(hash, &Value::String(k.clone()));
                hash.update(b":");
                feed(hash, &map[k]);
            }
            hash.update(b"}");
        }
        Value::Array(items) => {
            hash.update(b"[");
            for item in items {
                feed(hash, item);
                hash.update(b",");
            }
            hash.update(b"]");
        }
        other => hash.update(other.to_string().as_bytes()),
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}
