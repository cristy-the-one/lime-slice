//! What a call answers: `Answer`, the reply fields (`Part`) and the `Failure` refusals.

use serde_json::json;
use std::sync::Arc;

use super::NodeId;

pub(super) enum Answer {
    Plain(String),
    /// `text` with `fields` added, and the list of which nodes of `key` hold a solid, read after
    /// eviction. `text` and an `other` piece may be cached replies, so each is copied once, when
    /// the answer is written.
    Held {
        key: String,
        text: Arc<String>,
        fields: Vec<(&'static str, Part)>,
    },
}

/// A field's value: JSON as it is, or a JSON object, such as a cached reply, with fields added.
pub(super) enum Part {
    Json(String),
    Object(Arc<String>, Vec<(&'static str, Part)>),
}

impl Part {
    fn len(&self) -> usize {
        match self {
            Part::Json(text) => text.len(),
            Part::Object(text, fields) => text.len() + fields_len(fields),
        }
    }

    fn write(&self, out: &mut String) {
        match self {
            Part::Json(text) => out.push_str(text),
            Part::Object(text, fields) => write_object(out, text, fields),
        }
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

/// `text` is a JSON object. Each field is added before its closing brace, in one allocation with
/// room for the terminator the C string adds, since a solid reply is megabytes.
pub(super) fn with_fields(text: &str, fields: &[(&str, Part)]) -> String {
    let mut out = String::with_capacity(text.len() + fields_len(fields) + 2);
    write_object(&mut out, text, fields);
    out
}

fn fields_len(fields: &[(&str, Part)]) -> usize {
    fields
        .iter()
        .map(|(name, value)| name.len() + value.len() + 4)
        .sum()
}

pub(super) fn write_object(out: &mut String, text: &str, fields: &[(&str, Part)]) {
    let Some(body) = text.strip_suffix('}') else {
        out.push_str(text);
        return;
    };
    out.push_str(body);
    for (name, value) in fields {
        out.push_str(",\"");
        out.push_str(name);
        out.push_str("\":");
        value.write(out);
    }
    out.push('}');
}
