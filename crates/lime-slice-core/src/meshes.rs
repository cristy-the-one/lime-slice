//! Meshes the engine has been sent, held by content, so a later request can
//! name one (`meshRef`) instead of sending its bytes again (`dataB64`). See
//! `docs/mesh-refs.md`.

use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use base64::Engine;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

/// About ten large meshes. Past it, the least recently used go first.
pub const HELD_BYTES: usize = 512 << 20;

/// Why a slice payload got no reply.
#[derive(Clone, Debug, PartialEq)]
pub enum PayloadError {
    /// `meshRef` named meshes the engine does not hold: it restarted, or it
    /// evicted them. Sending the request again with their `dataB64` works.
    UnknownMesh(Vec<String>),
    Failed(String),
}

impl PayloadError {
    /// `code` of an [`PayloadError::UnknownMesh`] reply.
    pub const UNKNOWN_MESH: &'static str = "unknownMeshRef";

    /// The HTTP status a shell answers with.
    pub fn status(&self) -> u16 {
        match self {
            PayloadError::UnknownMesh(_) => 409,
            PayloadError::Failed(_) => 400,
        }
    }

    /// `{"error": …}`, plus `code` and `meshRefs` for an unknown mesh.
    pub fn json(&self) -> String {
        match self {
            PayloadError::UnknownMesh(refs) => json!({
                "error": self.to_string(),
                "code": Self::UNKNOWN_MESH,
                "meshRefs": refs,
            }),
            PayloadError::Failed(err) => json!({ "error": err }),
        }
        .to_string()
    }
}

impl fmt::Display for PayloadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PayloadError::UnknownMesh(refs) => write!(
                f,
                "meshRef {} is not held by this engine; send dataB64 instead",
                refs.join(", ")
            ),
            PayloadError::Failed(err) => f.write_str(err),
        }
    }
}

impl From<String> for PayloadError {
    fn from(err: String) -> Self {
        PayloadError::Failed(err)
    }
}

impl From<PayloadError> for String {
    fn from(err: PayloadError) -> Self {
        err.to_string()
    }
}

/// Mesh bytes by id, most recently used first, within `cap` bytes.
pub(crate) struct Held {
    cap: usize,
    items: Vec<(String, Arc<[u8]>)>,
}

impl Held {
    pub(crate) const fn new(cap: usize) -> Self {
        Self {
            cap,
            items: Vec::new(),
        }
    }

    /// Holds `bytes` and returns their id with the held copy.
    pub(crate) fn keep(&mut self, bytes: Vec<u8>) -> (String, Arc<[u8]>) {
        let id = mesh_id(&bytes);
        if let Some(held) = self.find(&id) {
            return (id, held);
        }
        let held: Arc<[u8]> = bytes.into();
        self.items.insert(0, (id.clone(), Arc::clone(&held)));
        self.evict();
        (id, held)
    }

    pub(crate) fn find(&mut self, id: &str) -> Option<Arc<[u8]>> {
        let at = self.items.iter().position(|(k, _)| k == id)?;
        let item = self.items.remove(at);
        let bytes = Arc::clone(&item.1);
        self.items.insert(0, item);
        Some(bytes)
    }

    /// Drops the least recently used meshes until the rest fit in `cap`. The
    /// newest mesh stays even when it alone is over, and so does any mesh a
    /// request still reads.
    fn evict(&mut self) {
        let mut total = self.bytes();
        let mut at = self.items.len();
        while total > self.cap && at > 1 {
            at -= 1;
            if Arc::strong_count(&self.items[at].1) == 1 {
                total -= self.items[at].1.len();
                self.items.remove(at);
            }
        }
    }

    pub(crate) fn bytes(&self) -> usize {
        self.items.iter().map(|(_, b)| b.len()).sum()
    }

    #[cfg(test)]
    fn ids(&self) -> Vec<&str> {
        self.items.iter().map(|(id, _)| id.as_str()).collect()
    }
}

static HELD: Mutex<Held> = Mutex::new(Held::new(HELD_BYTES));

fn held() -> MutexGuard<'static, Held> {
    HELD.lock().unwrap_or_else(PoisonError::into_inner)
}

/// SHA-256 of the bytes, in hex.
pub fn mesh_id(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The held mesh `id` names.
pub(crate) fn find(id: &str) -> Option<Arc<[u8]>> {
    held().find(id)
}

/// `dataB64`, with or without a `data:` URL prefix.
pub(crate) fn decode_b64(data: &str) -> Result<Vec<u8>, String> {
    let trimmed = data.trim();
    let payload = trimmed
        .split_once(',')
        .map(|(_, rest)| rest)
        .unwrap_or(trimmed);
    base64::engine::general_purpose::STANDARD
        .decode(payload.trim())
        .map_err(|e| format!("base64: {e}"))
}

/// The meshes of one request, held until it is dropped, and the ids its
/// reply names them by.
pub(crate) struct Interned {
    /// The request's own mesh, when it carried one.
    pub mesh_id: Option<String>,
    /// Each object's mesh id by object id, in plate order.
    pub object_ids: Vec<(String, String)>,
    _pins: Vec<Arc<[u8]>>,
}

/// Holds every `dataB64` mesh of `request` and writes `meshRef` in its place,
/// so a request that sent its bytes and one that named them read alike from
/// here on: the same disk-cache key, kept stages, and reply.
/// Fails with `UnknownMesh` naming every `meshRef` the engine does not hold.
pub(crate) fn intern(request: &mut Value) -> Result<Interned, PayloadError> {
    let mut interned = Interned {
        mesh_id: None,
        object_ids: Vec::new(),
        _pins: Vec::new(),
    };
    let mut unknown = Vec::new();
    let Some(fields) = request.as_object_mut() else {
        return Ok(interned);
    };
    interned.mesh_id = intern_one(fields, &mut interned._pins, &mut unknown)?;
    if let Some(objects) = fields.get_mut("objects").and_then(Value::as_array_mut) {
        for (i, object) in objects.iter_mut().enumerate() {
            let Some(object) = object.as_object_mut() else {
                continue;
            };
            let found = intern_one(object, &mut interned._pins, &mut unknown)
                .map_err(|e| PayloadError::Failed(format!("objects[{i}]: {e}")))?;
            let id = object.get("id").and_then(Value::as_str);
            if let (Some(mesh), Some(id)) = (found, id) {
                interned.object_ids.push((id.to_owned(), mesh));
            }
        }
    }
    if unknown.is_empty() {
        Ok(interned)
    } else {
        Err(PayloadError::UnknownMesh(unknown))
    }
}

/// One mesh's fields: `dataB64` becomes `meshRef`, and a `meshRef` is
/// checked. Returns the mesh id, or `None` when there is no mesh here.
fn intern_one(
    fields: &mut Map<String, Value>,
    pins: &mut Vec<Arc<[u8]>>,
    unknown: &mut Vec<String>,
) -> Result<Option<String>, String> {
    let data = fields
        .get("dataB64")
        .and_then(Value::as_str)
        .filter(|d| !d.is_empty());
    let named = fields.get("meshRef").and_then(Value::as_str);
    match (data, named) {
        (Some(_), Some(_)) => Err("send dataB64 or meshRef, not both".into()),
        (Some(data), None) => {
            let bytes = decode_b64(data)?;
            let (id, pin) = held().keep(bytes);
            pins.push(pin);
            fields.remove("dataB64");
            fields.insert("meshRef".into(), Value::String(id.clone()));
            Ok(Some(id))
        }
        (None, Some(id)) => {
            match find(id) {
                Some(pin) => pins.push(pin),
                None => unknown.push(id.to_owned()),
            }
            Ok(Some(id.to_owned()))
        }
        (None, None) => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mesh(len: usize, fill: u8) -> Vec<u8> {
        vec![fill; len]
    }

    #[test]
    fn eviction_keeps_the_newest_meshes_within_the_byte_bound() {
        let mut held = Held::new(250);
        let (a, _) = held.keep(mesh(100, 1));
        let (b, _) = held.keep(mesh(100, 2));
        let (c, _) = held.keep(mesh(100, 3));

        assert_eq!(held.bytes(), 200);
        assert_eq!(held.ids(), vec![c.as_str(), b.as_str()]);
        assert!(held.find(&a).is_none());
    }

    #[test]
    fn a_found_mesh_becomes_the_newest() {
        let mut held = Held::new(250);
        let (a, _) = held.keep(mesh(100, 1));
        let (b, _) = held.keep(mesh(100, 2));
        held.find(&a).unwrap();
        let (c, _) = held.keep(mesh(100, 3));

        assert_eq!(held.ids(), vec![c.as_str(), a.as_str()]);
        assert!(held.find(&b).is_none());
    }

    #[test]
    fn a_mesh_over_the_bound_alone_is_still_held() {
        let mut held = Held::new(250);
        held.keep(mesh(100, 1));
        let (big, _) = held.keep(mesh(400, 2));

        assert_eq!(held.ids(), vec![big.as_str()]);
        assert_eq!(held.bytes(), 400);
    }

    #[test]
    fn a_mesh_a_request_still_reads_is_not_evicted() {
        let mut held = Held::new(250);
        let (a, pin) = held.keep(mesh(100, 1));
        let (b, _) = held.keep(mesh(100, 2));
        let (c, _) = held.keep(mesh(100, 3));

        assert_eq!(held.ids(), vec![c.as_str(), a.as_str()]);
        assert!(held.find(&b).is_none());
        drop(pin);
        let (d, _) = held.keep(mesh(100, 4));
        assert_eq!(held.ids(), vec![d.as_str(), c.as_str()]);
    }

    #[test]
    fn the_same_bytes_are_held_once() {
        let mut held = Held::new(1000);
        let (a, _) = held.keep(mesh(100, 1));
        let (again, _) = held.keep(mesh(100, 1));

        assert_eq!(a, again);
        assert_eq!(held.bytes(), 100);
    }

    #[test]
    fn the_id_is_the_sha256_of_the_bytes() {
        assert_eq!(
            mesh_id(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
