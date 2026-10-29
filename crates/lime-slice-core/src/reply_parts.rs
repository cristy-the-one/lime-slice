//! A slice reply's `layers`, sent in parts. A long part's reply runs to
//! hundreds of MB, and a browser string tops out near 536M characters, so a
//! client that asks with `"replyParts": true` gets the reply without
//! `layers` and reads them as JSON arrays of whole layers, each part about
//! [`PART_BYTES`] long. Joined in order, the parts are the `layers` array.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, PoisonError};

use serde_json::Value;

/// About how long one part is. A part ends at the first layer past this, so
/// one long layer makes one long part.
pub const PART_BYTES: usize = 16 << 20;

/// Sets kept for reading. A slice that resends for a whole preview leaves
/// one set unread, so the newest two are held.
const KEPT_SETS: usize = 2;

struct Set {
    token: String,
    parts: Vec<Option<String>>,
}

static SETS: Mutex<VecDeque<Set>> = Mutex::new(VecDeque::new());

/// `layers` as JSON arrays, each about `limit` bytes, in order.
pub fn split_layers(layers: &[Value], limit: usize) -> Result<Vec<String>, String> {
    let mut parts = Vec::new();
    let mut part = Vec::with_capacity(limit.min(1 << 20));
    for layer in layers {
        if part.len() >= limit {
            part.push(b']');
            parts.push(part);
            part = Vec::with_capacity(limit.min(1 << 20));
        }
        part.push(if part.is_empty() { b'[' } else { b',' });
        serde_json::to_writer(&mut part, layer).map_err(|e| e.to_string())?;
    }
    if !part.is_empty() {
        part.push(b']');
        parts.push(part);
    }
    parts
        .into_iter()
        .map(|bytes| String::from_utf8(bytes).map_err(|e| e.to_string()))
        .collect()
}

/// Holds `parts` for [`take_reply_part`] and returns their token. Past
/// [`KEPT_SETS`], the oldest set is dropped.
pub fn park_reply_parts(parts: Vec<String>) -> String {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let token = format!("p{}", NEXT.fetch_add(1, Ordering::Relaxed));
    let mut sets = SETS.lock().unwrap_or_else(PoisonError::into_inner);
    sets.push_back(Set {
        token: token.clone(),
        parts: parts.into_iter().map(Some).collect(),
    });
    while sets.len() > KEPT_SETS {
        sets.pop_front();
    }
    token
}

/// Part `index` of set `token`, once. The set is dropped after its last part
/// is read. `None` for a set or part that is gone.
pub fn take_reply_part(token: &str, index: usize) -> Option<String> {
    let mut sets = SETS.lock().unwrap_or_else(PoisonError::into_inner);
    let at = sets.iter().position(|set| set.token == token)?;
    let part = sets[at].parts.get_mut(index)?.take();
    if sets[at].parts.iter().all(Option::is_none) {
        sets.remove(at);
    }
    part
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parts_join_to_the_layers_array() {
        let layers: Vec<Value> = (0..50).map(|i| json!({ "z": i, "paths": "x".repeat(i * 7) })).collect();
        let parts = split_layers(&layers, 300).unwrap();
        assert!(parts.len() > 5, "{} parts", parts.len());
        let mut joined = Vec::new();
        for part in &parts {
            let mut chunk: Vec<Value> = serde_json::from_str(part).unwrap();
            joined.append(&mut chunk);
        }
        assert_eq!(joined, layers);
    }

    #[test]
    fn a_part_ends_at_the_first_layer_past_the_limit() {
        let layers = vec![json!("a".repeat(100)), json!("b"), json!("c".repeat(100)), json!("d")];
        let parts = split_layers(&layers, 10).unwrap();
        assert_eq!(parts, [format!("[\"{}\"]", "a".repeat(100)), format!("[\"b\",\"{}\"]", "c".repeat(100)), "[\"d\"]".to_string()]);
        assert!(split_layers(&[], 10).unwrap().is_empty());
    }

    #[test]
    fn a_part_is_read_once_and_old_sets_go() {
        let first = park_reply_parts(vec!["[1]".into(), "[2]".into()]);
        assert_eq!(take_reply_part(&first, 1).as_deref(), Some("[2]"));
        assert_eq!(take_reply_part(&first, 1), None);
        assert_eq!(take_reply_part(&first, 0).as_deref(), Some("[1]"));
        assert_eq!(take_reply_part(&first, 0), None, "the read set is dropped");
        let a = park_reply_parts(vec!["[1]".into()]);
        park_reply_parts(vec!["[2]".into()]);
        park_reply_parts(vec!["[3]".into()]);
        assert_eq!(take_reply_part(&a, 0), None, "only the newest two are kept");
    }
}
