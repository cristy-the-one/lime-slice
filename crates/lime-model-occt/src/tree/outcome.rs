//! What a call answers: `Answer`, the reply fields (`Part`), `BinObject` for raw mesh buffers,
//! and the `Failure` refusals.

use base64::Engine;
use serde_json::json;
use std::fmt::Write as _;
use std::sync::Arc;

use super::NodeId;

/// Binary frame magic: `[L, M, B, 1][u32 LE jsonLen][u32 LE flags=0][utf8 json][0..3 pad][aligned blobs]`.
pub(super) const LMB1_MAGIC: &[u8; 4] = b"LMB1";

/// A reply JSON object carrying metadata (`head`, without its closing `}`) plus optional raw
/// little-endian binary arrays (`positions`, `triangles`, `edgePoints`, `edgeOffsets`, `display.*`,
/// or `surfaceInspect` buffers). Rendered as base64 JSON for `lime_occt_tree` and as an aligned
/// `LMB1` binary frame for `lime_occt_tree_bin`.
pub(super) struct BinObject {
    /// JSON object text up to, not including, the closing `}`.
    pub(super) head: String,
    /// Top-level raw binary fields in emission order.
    pub(super) arrays: Vec<(&'static str, Vec<u8>)>,
    /// Optional nested `"display":{...}` raw binary fields in emission order.
    pub(super) display: Option<Vec<(&'static str, Vec<u8>)>>,
}

impl BinObject {
    /// Wrap an already-formatted JSON object string with no binary buffers.
    pub(super) fn plain(text: String) -> Self {
        let head = text.strip_suffix('}').unwrap_or(&text).to_string();
        Self {
            head,
            arrays: Vec::new(),
            display: None,
        }
    }

    /// Append a JSON field to `head` without copying any binary buffers.
    pub(super) fn push_field(&mut self, name: &str, json_value: &str) {
        self.head.push_str(",\"");
        self.head.push_str(name);
        self.head.push_str("\":");
        self.head.push_str(json_value);
    }

    fn json_len(&self, extra: &[(&str, Part)]) -> usize {
        let arrays_len: usize = self
            .arrays
            .iter()
            .map(|(name, bytes)| name.len() + bytes.len().div_ceil(3) * 4 + 6)
            .sum();
        let display_len: usize = self.display.as_ref().map_or(0, |parts| {
            16 + parts
                .iter()
                .map(|(name, bytes)| name.len() + bytes.len().div_ceil(3) * 4 + 6)
                .sum::<usize>()
        });
        self.head.len() + arrays_len + display_len + fields_len_json(extra) + 2
    }

    fn write_json(&self, out: &mut String, extra: &[(&str, Part)]) {
        out.push_str(&self.head);
        for (name, bytes) in &self.arrays {
            let _ = write!(out, ",\"{name}\":\"");
            base64::engine::general_purpose::STANDARD.encode_string(bytes, out);
            out.push('"');
        }
        if let Some(parts) = &self.display {
            out.push_str(",\"display\":{");
            for (at, (name, bytes)) in parts.iter().enumerate() {
                let _ = write!(out, "{}\"{name}\":\"", if at == 0 { "" } else { "," });
                base64::engine::general_purpose::STANDARD.encode_string(bytes, out);
                out.push('"');
            }
            out.push('}');
        }
        write_fields_json(out, extra);
        out.push('}');
    }

    fn write_bin(&self, out: &mut String, blobs: &mut Vec<u8>, used_bin: &mut bool, extra: &[(&str, Part)]) {
        out.push_str(&self.head);
        for (name, bytes) in &self.arrays {
            let (off, len) = push_blob(blobs, bytes);
            *used_bin = true;
            let _ = write!(out, ",\"{name}\":{{\"$bin\":[{off},{len}]}}");
        }
        if let Some(parts) = &self.display {
            out.push_str(",\"display\":{");
            for (at, (name, bytes)) in parts.iter().enumerate() {
                let (off, len) = push_blob(blobs, bytes);
                *used_bin = true;
                let _ = write!(
                    out,
                    "{}\"{name}\":{{\"$bin\":[{off},{len}]}}",
                    if at == 0 { "" } else { "," }
                );
            }
            out.push('}');
        }
        write_fields_bin(out, blobs, used_bin, extra);
        out.push('}');
    }
}

fn push_blob(blobs: &mut Vec<u8>, bytes: &[u8]) -> (usize, usize) {
    while blobs.len() % 4 != 0 {
        blobs.push(0);
    }
    let off = blobs.len();
    blobs.extend_from_slice(bytes);
    (off, bytes.len())
}

pub(super) fn pack_lmb1(json: &str, blobs: &[u8]) -> Vec<u8> {
    let json_bytes = json.as_bytes();
    let pad = (4 - (json_bytes.len() % 4)) % 4;
    let mut out = Vec::with_capacity(12 + json_bytes.len() + pad + blobs.len());
    out.extend_from_slice(LMB1_MAGIC);
    out.extend_from_slice(&(json_bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(json_bytes);
    out.resize(out.len() + pad, 0);
    out.extend_from_slice(blobs);
    out
}

pub(super) enum Answer {
    Plain(String),
    /// One binary-capable object (e.g. `meshStep` or `surfaceInspect`).
    Object(BinObject),
    /// A JSON object wrapper whose `head` (without closing `}`) may have binary-capable `fields`
    /// (e.g. `probe` with `preview`).
    Fields {
        head: String,
        fields: Vec<(&'static str, Part)>,
    },
    /// `body` with `fields` added, and the list of which nodes of `key` hold a solid, read after
    /// eviction. `body` and an `other`/`pieces`/`pins` entry may be cached replies.
    Held {
        key: String,
        body: Arc<BinObject>,
        fields: Vec<(&'static str, Part)>,
    },
}

impl Answer {
    pub(super) fn into_json(self) -> String {
        match self {
            Answer::Plain(text) => text,
            Answer::Object(obj) => {
                let mut out = String::with_capacity(obj.json_len(&[]) + 1);
                obj.write_json(&mut out, &[]);
                out
            }
            Answer::Fields { head, fields } => {
                let mut out = String::with_capacity(head.len() + fields_len_json(&fields) + 2);
                out.push_str(&head);
                write_fields_json(&mut out, &fields);
                out.push('}');
                out
            }
            Answer::Held { body, fields, .. } => {
                let mut out = String::with_capacity(body.json_len(&fields) + 1);
                body.write_json(&mut out, &fields);
                out
            }
        }
    }

    pub(super) fn into_bin(self) -> Vec<u8> {
        match self {
            Answer::Plain(text) => text.into_bytes(),
            Answer::Object(obj) => {
                let mut json = String::with_capacity(obj.head.len() + 256);
                let mut blobs = Vec::new();
                let mut used_bin = false;
                obj.write_bin(&mut json, &mut blobs, &mut used_bin, &[]);
                if used_bin {
                    pack_lmb1(&json, &blobs)
                } else {
                    json.into_bytes()
                }
            }
            Answer::Fields { head, fields } => {
                let mut json = String::with_capacity(head.len() + 256);
                let mut blobs = Vec::new();
                let mut used_bin = false;
                json.push_str(&head);
                write_fields_bin(&mut json, &mut blobs, &mut used_bin, &fields);
                json.push('}');
                if used_bin {
                    pack_lmb1(&json, &blobs)
                } else {
                    json.into_bytes()
                }
            }
            Answer::Held { body, fields, .. } => {
                let mut json = String::with_capacity(body.head.len() + 256);
                let mut blobs = Vec::new();
                let mut used_bin = false;
                body.write_bin(&mut json, &mut blobs, &mut used_bin, &fields);
                if used_bin {
                    pack_lmb1(&json, &blobs)
                } else {
                    json.into_bytes()
                }
            }
        }
    }
}

/// A field's value: raw JSON, a cached binary-capable object with extra fields, or a JSON array of
/// optional parts (such as partition `pieces`).
pub(super) enum Part {
    Json(String),
    Object(Arc<BinObject>, Vec<(&'static str, Part)>),
    List(Vec<Option<Part>>),
}

impl Part {
    fn json_len(&self) -> usize {
        match self {
            Part::Json(text) => text.len(),
            Part::Object(body, fields) => body.json_len(fields),
            Part::List(items) => {
                2 + items
                    .iter()
                    .map(|item| item.as_ref().map_or(4, Part::json_len) + 1)
                    .sum::<usize>()
            }
        }
    }

    fn write_json(&self, out: &mut String) {
        match self {
            Part::Json(text) => out.push_str(text),
            Part::Object(body, fields) => body.write_json(out, fields),
            Part::List(items) => {
                out.push('[');
                for (index, item) in items.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    match item {
                        Some(part) => part.write_json(out),
                        None => out.push_str("null"),
                    }
                }
                out.push(']');
            }
        }
    }

    fn write_bin(&self, out: &mut String, blobs: &mut Vec<u8>, used_bin: &mut bool) {
        match self {
            Part::Json(text) => out.push_str(text),
            Part::Object(body, fields) => body.write_bin(out, blobs, used_bin, fields),
            Part::List(items) => {
                out.push('[');
                for (index, item) in items.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    match item {
                        Some(part) => part.write_bin(out, blobs, used_bin),
                        None => out.push_str("null"),
                    }
                }
                out.push(']');
            }
        }
    }
}

fn fields_len_json(fields: &[(&str, Part)]) -> usize {
    fields
        .iter()
        .map(|(name, value)| name.len() + value.json_len() + 4)
        .sum()
}

fn write_fields_json(out: &mut String, fields: &[(&str, Part)]) {
    for (name, value) in fields {
        out.push_str(",\"");
        out.push_str(name);
        out.push_str("\":");
        value.write_json(out);
    }
}

fn write_fields_bin(
    out: &mut String,
    blobs: &mut Vec<u8>,
    used_bin: &mut bool,
    fields: &[(&str, Part)],
) {
    for (name, value) in fields {
        out.push_str(",\"");
        out.push_str(name);
        out.push_str("\":");
        value.write_bin(out, blobs, used_bin);
    }
}

pub(super) enum Failure {
    Message(String),
    /// The engine does not have these nodes (or this tree, as `[0]`). Resend the ops.
    Missing(Vec<NodeId>),
    /// `node` did not rebuild. It and everything under it stay unbuilt until it is dropped.
    Broken {
        node: NodeId,
        message: String,
    },
    /// A join needs a tool tree, or a step of one, that this engine does not hold: `key` and `step`. `node`
    /// is the step of the tree asked about that cannot be built for it, if it has one yet. Nothing is
    /// marked: once the client opens that tree again the same call works.
    ToolMissing {
        node: Option<NodeId>,
        key: String,
        step: NodeId,
    },
    /// An `open` whose seed was refused and that then failed: both are said, so the client does not send the seed again.
    SeedRefused(Box<Failure>, String),
    /// A group's step failed. `failed_step` counts from 1, as the sentence says ("Step 2 of 3").
    GroupFailed { message: String, failed_step: u32 },
}

const TOOL_MISSING: &str = "The tool object's history is not open in the modeler";

pub(super) const CYCLE: &str = "The tool object's history already uses this part, so the two cannot be joined";

impl Failure {
    pub(super) fn json(&self) -> String {
        match self {
            Failure::Message(message) => json!({ "error": message }).to_string(),
            Failure::Missing(nodes) => json!({ "error": "unknown", "missing": nodes }).to_string(),
            Failure::Broken { node, message } => {
                json!({ "error": message, "broken": node }).to_string()
            }
            Failure::ToolMissing { node, key, step } => {
                let mut reply =
                    json!({ "error": TOOL_MISSING, "missingTool": { "key": key, "node": step } });
                if let Some(node) = node {
                    reply["broken"] = json!(node);
                }
                reply.to_string()
            }
            Failure::SeedRefused(failure, why) => {
                let mut reply: serde_json::Value =
                    serde_json::from_str(&failure.json()).expect("a failure is JSON");
                reply["seedRefused"] = json!(why);
                reply.to_string()
            }
            Failure::GroupFailed {
                message,
                failed_step,
            } => json!({ "error": message, "failedStep": failed_step }).to_string(),
        }
    }
}
