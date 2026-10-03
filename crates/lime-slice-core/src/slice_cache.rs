//! Finished slices on disk, keyed by the exact request and the engine build,
//! so asking for the same slice again loads it instead of planning it.

use std::collections::HashSet;
use std::fs;
use std::io::{self, BufWriter, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, LazyLock, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::ser::{Serialize, SerializeMap, Serializer};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::{slice_request, GcodeText, Job, SliceRequest};

/// A folder of `<key>.json` files, each one slice reply with its G-code.
/// Entries are written on background threads after the reply is out.
pub struct SliceCache {
    shared: Arc<Shared>,
}

struct Shared {
    dir: PathBuf,
    cap_bytes: u64,
    /// Keys being written right now. Never more than `MAX_WRITES`.
    writing: Mutex<HashSet<String>>,
    idle: Condvar,
}

/// A stored reply holds a whole preview and its G-code, so a few of them in
/// memory at once is already a lot. A slice that finds every slot taken is
/// simply not kept.
const MAX_WRITES: usize = 2;

/// A temp file this old belongs to a write that never finished.
const STALE_TEMP: Duration = Duration::from_secs(3600);

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
            shared: Arc::new(Shared {
                dir: dir.into(),
                cap_bytes,
                writing: Mutex::new(HashSet::new()),
                idle: Condvar::new(),
            }),
        }
    }

    /// Wait until every write started so far has finished.
    pub fn flush(&self) {
        let mut writing = self.shared.writing.lock().expect("cache writes");
        while !writing.is_empty() {
            writing = self.shared.idle.wait(writing).expect("cache writes");
        }
    }

    fn load(&self, key: &str) -> Option<Value> {
        let path = self.shared.path(key);
        let reply = serde_json::from_slice(&fs::read(&path).ok()?).ok()?;
        if let Ok(file) = fs::File::options().write(true).open(&path) {
            let _ = file.set_modified(SystemTime::now());
        }
        Some(reply)
    }

    /// Write `reply` under `key` on a background thread, with `gcode` as its
    /// G-code when the reply left it out. Skipped when `key` is already being
    /// written or every write slot is taken.
    fn store_later(&self, key: &str, reply: Arc<Value>, gcode: Option<GcodeText>) {
        {
            let mut writing = self.shared.writing.lock().expect("cache writes");
            if writing.len() >= MAX_WRITES || !writing.insert(key.to_owned()) {
                return;
            }
        }
        let writer = Arc::clone(&self.shared);
        let owned = key.to_owned();
        let spawned = std::thread::Builder::new()
            .name("slice-cache-write".into())
            .spawn(move || {
                // A slice that cannot be kept is still a slice.
                let _ = writer.store(&owned, &reply, gcode.as_ref());
                writer.release(&owned);
            });
        if spawned.is_err() {
            self.shared.release(key);
        }
    }
}

impl Shared {
    fn release(&self, key: &str) {
        self.writing.lock().expect("cache writes").remove(key);
        self.idle.notify_all();
    }

    fn path(&self, key: &str) -> PathBuf {
        self.dir.join(format!("{key}.json"))
    }

    /// The entry appears under its name only once it is complete and on disk,
    /// so a crash leaves a `.tmp` file that nothing reads.
    fn store(&self, key: &str, reply: &Value, gcode: Option<&GcodeText>) -> io::Result<()> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        fs::create_dir_all(&self.dir)?;
        let tmp = self.dir.join(format!(
            "{key}.{}.{}.tmp",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let written = (|| {
            let mut out = BufWriter::new(fs::File::create(&tmp)?);
            let gcode = gcode.map(GcodeText::text);
            serde_json::to_writer(&mut out, &Stored { reply, gcode })?;
            out.flush()?;
            out.get_ref().sync_all()
        })();
        if let Err(err) = written.and_then(|()| fs::rename(&tmp, self.path(key))) {
            let _ = fs::remove_file(&tmp);
            return Err(err);
        }
        self.evict()
    }

    fn evict(&self) -> io::Result<()> {
        let mut entries: Vec<(SystemTime, u64, PathBuf)> = Vec::new();
        for e in fs::read_dir(&self.dir)? {
            let Ok(e) = e else { continue };
            let Ok(meta) = e.metadata() else { continue };
            let Ok(modified) = meta.modified() else {
                continue;
            };
            let path = e.path();
            match path.extension().and_then(|x| x.to_str()) {
                Some("json") => entries.push((modified, meta.len(), path)),
                Some("tmp") if modified.elapsed().is_ok_and(|age| age > STALE_TEMP) => {
                    let _ = fs::remove_file(path);
                }
                _ => {}
            }
        }
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
///
/// A new slice is returned first and written to `cache` afterwards, on a
/// background thread. Call `SliceCache::flush` to wait for it.
///
/// `previewBase` is left out of the cache key, and a reply with a
/// `previewPatch` is never stored: a stored reply is always whole, which is
/// right for any client.
pub fn slice_payload(
    payload: &str,
    cache: Option<&SliceCache>,
    job: Job,
    park: impl FnOnce(GcodeText) -> String,
) -> Result<String, String> {
    let mut value: Value = serde_json::from_str(payload).map_err(|e| e.to_string())?;
    let reslice = value
        .as_object_mut()
        .and_then(|o| o.remove("reslice"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let key = cache.and_then(|_| disk_key(&mut value));
    let cache = cache.zip(key.as_deref());
    let req: SliceRequest = serde_json::from_value(value).map_err(|e| e.to_string())?;
    let hit = cache
        .filter(|_| !reslice)
        .and_then(|(cache, key)| cache.load(key));
    let from_cache = hit.is_some();
    let (reply, text) = match hit {
        Some(reply) => (Arc::new(reply), None),
        None => {
            let response = slice_request(&req, job)?;
            let mut reply = serde_json::to_value(&response).map_err(|e| e.to_string())?;
            reply["slicedAtMs"] = json!(now_ms());
            let reply = Arc::new(reply);
            if let Some((cache, key)) = cache.filter(|_| response.preview_patch.is_none()) {
                cache.store_later(key, Arc::clone(&reply), response.gcode_text.clone());
            }
            (reply, response.gcode_text)
        }
    };
    let obj = reply.as_object().ok_or("slice reply is not an object")?;
    let gcode_token = (!req.include_gcode).then(|| {
        park(text.unwrap_or_else(|| {
            let gcode = obj.get("gcode").and_then(Value::as_str).unwrap_or_default();
            GcodeText::ready(gcode.to_owned())
        }))
    });
    serde_json::to_string(&Wire {
        reply: obj,
        from_cache,
        gcode_token,
    })
    .map_err(|e| e.to_string())
}

/// The reply as the client gets it. A stored reply is shared with the thread
/// writing it, so the G-code is left out here instead of removed.
struct Wire<'a> {
    reply: &'a Map<String, Value>,
    from_cache: bool,
    /// Present when the G-code was parked instead of sent.
    gcode_token: Option<String>,
}

impl Serialize for Wire<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        for (k, v) in self.reply {
            if self.gcode_token.is_none() || k != "gcode" {
                map.serialize_entry(k, v)?;
            }
        }
        map.serialize_entry("fromCache", &self.from_cache)?;
        if let Some(token) = &self.gcode_token {
            map.serialize_entry("gcodeToken", token)?;
        }
        map.end()
    }
}

/// A reply as the disk keeps it: whole, with `gcode` in place of the empty
/// text a reply that left its G-code out carries.
struct Stored<'a> {
    reply: &'a Value,
    gcode: Option<String>,
}

impl Serialize for Stored<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let (Some(gcode), Some(fields)) = (&self.gcode, self.reply.as_object()) else {
            return self.reply.serialize(serializer);
        };
        let mut map = serializer.serialize_map(Some(fields.len()))?;
        for (k, v) in fields {
            if k == "gcode" {
                map.serialize_entry(k, gcode)?;
            } else {
                map.serialize_entry(k, v)?;
            }
        }
        map.end()
    }
}

/// The disk key of a request, or `None` when the engine cannot be hashed.
/// `previewBase` is left out: it picks how the reply is sent, not what it holds.
fn disk_key(request: &mut Value) -> Option<String> {
    let engine = ENGINE.as_deref()?;
    let preview_base = request
        .as_object_mut()
        .and_then(|o| o.remove("previewBase"));
    let key = cache_key(engine, request);
    if let (Some(base), Some(o)) = (preview_base, request.as_object_mut()) {
        o.insert("previewBase".into(), base);
    }
    Some(key)
}

fn cache_key(engine: &str, request: &Value) -> String {
    let mut hash = Sha256::new();
    hash.update(engine.as_bytes());
    feed(&mut hash, request);
    hex(&hash.finalize())
}

/// Object keys in sorted order, so the key does not depend on field order.
/// `src/slice-action.ts` `feed` copies this layout so the slice button and
/// this cache agree on which recipes are the same.
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

#[cfg(test)]
mod tests {
    use super::*;

    fn cache(name: &str) -> SliceCache {
        let dir = std::env::temp_dir().join(format!(
            "lime-slice-cache-unit-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        SliceCache::new(dir, 1 << 30)
    }

    fn written(cache: &SliceCache) -> usize {
        fs::read_dir(&cache.shared.dir).map_or(0, |d| d.count())
    }

    #[test]
    fn a_key_already_being_written_is_not_written_again() {
        let cache = cache("same-key");
        cache.shared.writing.lock().unwrap().insert("k".into());

        cache.store_later("k", Arc::new(json!({"a": 1})), None);

        assert_eq!(written(&cache), 0);
        cache.shared.release("k");
        cache.flush();
    }

    #[test]
    fn writes_in_flight_are_bounded() {
        let cache = cache("bounded");
        for n in 0..MAX_WRITES {
            cache
                .shared
                .writing
                .lock()
                .unwrap()
                .insert(format!("busy{n}"));
        }

        cache.store_later("extra", Arc::new(json!({"a": 1})), None);

        assert_eq!(written(&cache), 0);
        assert_eq!(cache.shared.writing.lock().unwrap().len(), MAX_WRITES);
        for n in 0..MAX_WRITES {
            cache.shared.release(&format!("busy{n}"));
        }
        cache.store_later("extra", Arc::new(json!({"a": 1})), None);
        cache.flush();
        assert_eq!(written(&cache), 1);
    }
}
