//! The Model history tree: one document per plate object, one node per edit.
//!
//! The client owns the tree (node ids, labels, which branch Redo follows) and can always hand it
//! back as the root STEP plus the ordered ops. This store keeps what is costly to rebuild: each
//! node's solid, its fingerprint, and the reply for the nodes the client looked at. A node whose
//! solid was evicted is rebuilt from its nearest kept ancestor, and every rebuilt step is checked
//! against the fingerprint it had when it was first built.
//!
//! Every call holds the store lock from start to end, so the kernel never sees one solid from two
//! threads.

use std::collections::HashMap;
use std::ffi::CStr;
use std::os::raw::c_int;
use std::sync::{Arc, LazyLock, Mutex};

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::json;

mod build;
mod doc;
mod ffi;
mod fit_coupon;
mod gear;
mod group;
mod handle;
mod joints;
mod k1;
mod lettering;
mod ops;
mod outcome;
mod partition;
mod request;
mod resolve;
mod same;
mod shape;
mod shape_edges;
mod shape_feature;
mod shape_io;
mod step_solids;
mod store;
mod store_apply;
mod store_edit;
mod transition;
mod transition_find;

use build::*;
use ffi::*;
pub use fit_coupon::*;
pub use group::*;
pub use joints::*;
pub use ops::*;
use outcome::*;
pub use partition::*;
use request::*;
use shape::*;
pub use step_solids::*;

pub type NodeId = u32;

/// The root node of every document: the opened solid.
pub const ROOT: NodeId = 0;

/// Fillet and chamfer name topology, and an index can point at a different edge once the solid is
/// rebuilt. The midpoint and length let a rebuild find the same edge again.
const EDGE_MATCH_MM: f64 = 1e-3;

/// One node in eight along the open path keeps its solid whatever the cache holds, so a jump back
/// along that path never replays more than seven steps.
const PATH_PIN_EVERY: u32 = 8;

/// The solid reply's layout. The client reads no array from a reply that names another
/// (`src/model-reply.ts`), so an engine and an app that do not match fail plainly.
const SOLID_FORMAT: &str = "lime-solid-2";

/// The reply of an Apply that asked for no mesh (`mesh: false`): the step and its fingerprint, no arrays.
const LITE_FORMAT: &str = "lime-solid-lite";

/// The first word of a solid saved in Open CASCADE's binary format (`Shape::brep_bytes`). Its header line is
/// `LIMEBREP 1 <Open CASCADE version> <volume>`, then the BinTools bytes. A STEP file never starts with it.
const BREP_MAGIC: &[u8] = b"LIMEBREP ";

const BREP_FORMAT: &str = "1";

/// A saved solid whose mesh reads its faces out in another order than their index ends in this line, after the BinTools
/// bytes: `\nLIMEORDER 3,1,2\n`. BinTools stops before it, so a modeler that does not know it still reads the solid.
const BREP_ORDER: &[u8] = b"\nLIMEORDER ";

// A reply sends the kernel's f32 and u32 arrays byte for byte, and the format says little-endian.
const _: () = assert!(cfg!(target_endian = "little"));

const ROOT_ONLY: &str = "A new solid's primitive can only be built again right under its root";

/// What a rebuild must reproduce for a node to count as the same solid.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fingerprint {
    pub volume_mm3: f64,
    pub faces: i32,
    pub edges: i32,
}

impl Fingerprint {
    fn matches(&self, other: &Fingerprint) -> bool {
        let tolerance = 1e-6 * self.volume_mm3.abs().max(1.0);
        self.faces == other.faces
            && self.edges == other.edges
            && (self.volume_mm3 - other.volume_mm3).abs() <= tolerance
    }
}

/// How many solids and replies the store keeps before it evicts the least recently used.
/// Pinned solids (each tree's root, its current node, and every eighth node on the path to it)
/// do not count against `shapes`.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub shapes: usize,
    pub replies: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            shapes: 24,
            replies: 8,
        }
    }
}

pub fn set_limits(limits: Limits) {
    lock().limits = limits;
}

/// Answer one JSON request. See `docs/step-modeler.md` for the calls.
pub fn call(request: &str) -> String {
    let request: Request = match serde_json::from_str(request) {
        Ok(request) => request,
        Err(err) => return Failure::Message(format!("Bad tree request: {err}")).json(),
    };
    let mut store = lock();
    let transient = matches!(
        &request,
        Request::MeshStep { .. }
            | Request::ToolBox { .. }
            | Request::Capabilities
            | Request::StepSolids { .. }
            | Request::ShapeSolids { .. }
            | Request::FitCoupon { .. }
            | Request::TextLayout { .. }
            | Request::TextFonts
            | Request::TextFontAdd { .. }
            | Request::TextFontPack { .. }
    );
    let answer = store.handle(request);
    if !transient {
        store.evict();
    }
    match answer {
        Ok(Answer::Plain(text)) => text,
        Ok(Answer::Held {
            key,
            text,
            mut fields,
        }) => {
            let held = store.docs.get(&key).map(Doc::held).unwrap_or_default();
            fields.push(("held", Part::Json(json!(held).to_string())));
            with_fields(&text, &fields)
        }
        Err(failure) => failure.json(),
    }
}

fn lock() -> std::sync::MutexGuard<'static, Store> {
    static STORE: LazyLock<Mutex<Store>> = LazyLock::new(|| Mutex::new(Store::default()));
    STORE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct Node {
    parent: Option<NodeId>,
    op: Option<Op>,
    shape: Option<Shape>,
    fingerprint: Option<Fingerprint>,
    broken: Option<String>,
    /// A split's `otherKey`, so a retried apply can be told from a different one.
    piece: Option<String>,
    /// --- Split to print: its `pieceKeys`, for the same reason.
    pieces: Vec<Option<String>>,
    /// --- Split to print: its `pinsKey`, for the same reason.
    pins: Option<String>,
    /// The edges this step made or changed, read once from its solid when a later blend first picks them.
    created: Option<Vec<EdgeRef>>,
    /// --- A10. The node that made each face of this solid, in the kernel's face order. Empty until the solid is held.
    face_owners: Vec<NodeId>,
    /// Its solid came from a saved copy (`open`'s `seed`), not from a replay. It is never evicted, since
    /// building it again means replaying every step above it.
    seeded: bool,
    depth: u32,
    used: u64,
}

/// The last successful probe. Apply with the same parent and op takes its solid instead of building again.
struct Probed {
    parent: NodeId,
    op: Op,
    built: Built,
}

struct Doc {
    nodes: HashMap<NodeId, Node>,
    current: NodeId,
    probe: Option<Probed>,
}

struct Reply {
    key: String,
    node: NodeId,
    chord: u64,
    text: Arc<String>,
    used: u64,
}

#[derive(Default)]
struct Store {
    docs: HashMap<String, Doc>,
    replies: Vec<Reply>,
    clock: u64,
    limits: Limits,
}

/// A `root` op builds a new solid's primitive afresh, which only means something right under the root.
fn root_placement(parent: NodeId, op: &Op) -> Result<(), String> {
    if matches!(op, Op::Root { .. }) && parent != ROOT {
        return Err(ROOT_ONLY.into());
    }
    Ok(())
}

/// Give saved step `seed.node` the solid saved with it. Only a solid in the binary format is taken: it is the step
/// exactly, face and edge numbering included, where a STEP read can sit apart from it. It must match the step's
/// fingerprint as saved.
fn seed_node(doc: &mut Doc, seed: SeedSolid, used: u64) -> Result<(), String> {
    let node = doc
        .nodes
        .get(&seed.node)
        .ok_or_else(|| format!("Step {} is not in this history", seed.node))?;
    if seed.node == ROOT {
        return Err("The root opens from its own source".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(seed.data_b64.trim())
        .map_err(|err| err.to_string())?;
    if !bytes.starts_with(BREP_MAGIC) {
        return Err("Only a solid saved in Open CASCADE's binary format seeds a step".into());
    }
    let expected = node.fingerprint;
    let shape = Shape::read_brep(&bytes, true)?;
    let got = shape.fingerprint();
    // A step saved without a fingerprint (the MCP server saves none) takes its own saved solid unchecked.
    if let Some(expected) = expected.filter(|expected| !expected.matches(&got)) {
        return Err(format!(
            "The saved solid is not this step: {:.3} mm³, {} faces, {} edges instead of {:.3} mm³, {} faces, {} edges",
            got.volume_mm3, got.faces, got.edges, expected.volume_mm3, expected.faces, expected.edges
        ));
    }
    let node = doc.nodes.get_mut(&seed.node).expect("checked above");
    node.fingerprint = Some(got);
    node.shape = Some(shape);
    node.seeded = true;
    node.used = used;
    // --- A10. A seeded tip has no per-face history in the saved bytes, so every face is this step's until replayed.
    stamp_faces(doc, seed.node);
    Ok(())
}

/// --- A10. Each face's node. A face whose `from_face` names a parent face keeps that face's node.
/// A face this step made (`-1`), or one whose parent has no record, belongs to `id`.
fn stamp_faces(doc: &mut Doc, id: NodeId) {
    let (parent, from_face) = {
        let Some(node) = doc.nodes.get(&id) else {
            return;
        };
        let Some(shape) = node.shape.as_ref() else {
            return;
        };
        (node.parent, shape.face_from())
    };
    let parent_owners = parent
        .and_then(|parent| doc.nodes.get(&parent).map(|node| node.face_owners.clone()))
        .unwrap_or_default();
    let owners: Vec<NodeId> = from_face
        .iter()
        .map(|&src| {
            if src >= 0 {
                parent_owners.get(src as usize).copied().unwrap_or(id)
            } else {
                id
            }
        })
        .collect();
    if let Some(node) = doc.nodes.get_mut(&id) {
        node.face_owners = owners;
    }
}

/// --- A10. A probe's preview has no node of its own yet. Inherited faces keep the parent's node; new faces are null.
fn preview_step_faces(parent: &[NodeId], from_face: &[c_int]) -> Option<String> {
    if from_face.is_empty() {
        return None;
    }
    let mut out = String::from("[");
    for (index, &src) in from_face.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        if src >= 0 {
            match parent.get(src as usize) {
                Some(owner) => out.push_str(&owner.to_string()),
                None => out.push_str("null"),
            }
        } else {
            out.push_str("null");
        }
    }
    out.push(']');
    Some(out)
}

/// An unknown tree reads as a missing root: the client resends the root and the ops.
fn doc_in<'a>(docs: &'a mut HashMap<String, Doc>, key: &str) -> Result<&'a mut Doc, Failure> {
    docs.get_mut(key).ok_or(Failure::Missing(vec![ROOT]))
}

fn rebuilt_differently(got: &Fingerprint, expected: &Fingerprint) -> String {
    format!(
        "This step rebuilt differently: {:.3} mm³, {} faces, {} edges instead of {:.3} mm³, {} faces, {} edges",
        got.volume_mm3, got.faces, got.edges, expected.volume_mm3, expected.faces, expected.edges
    )
}

fn root_shape(
    data_b64: Option<String>,
    step_path: Option<String>,
    box_mm: Option<[f64; 3]>,
    primitive: Option<Solid>,
    feature: Option<Op>,
) -> Result<Shape, Failure> {
    // `box` is a primitive box from the origin, kept for the tests and tools that open one.
    let primitive = match (box_mm, primitive) {
        (Some(size), None) => Some(Solid {
            size,
            ..Solid::default()
        }),
        (None, primitive) => primitive,
        (Some(_), Some(_)) => return Err(one_root()),
    };
    let feature_sent = feature.is_some();
    match (data_b64, step_path, primitive, feature) {
        (Some(data), None, None, None) => {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(data.trim())
                .map_err(|err| Failure::Message(err.to_string()))?;
            if bytes.starts_with(BREP_MAGIC) {
                return Shape::read_brep(&bytes, false).map_err(Failure::Message);
            }
            let path = temp_step("open");
            std::fs::write(&path, bytes).map_err(|err| Failure::Message(err.to_string()))?;
            let shape = Shape::read_step(&path);
            let _ = std::fs::remove_file(&path);
            shape.map_err(Failure::Message)
        }
        (None, Some(path), None, None) => {
            Shape::read_step(std::path::Path::new(&path)).map_err(Failure::Message)
        }
        (None, None, Some(solid), None) => Shape::primitive(&solid).map_err(Failure::Message),
        // --- K2 feature root. The op is built against nothing. ---
        (None, None, None, Some(op)) => Shape::feature(&op).map_err(Failure::Message),
        _ => Err(if feature_sent {
            Failure::Message(
                "Open a tree from exactly one of dataB64, stepPath, box, primitive, or feature".into(),
            )
        } else {
            one_root()
        }),
    }
}

fn one_root() -> Failure {
    Failure::Message("Open a tree from exactly one of dataB64, stepPath, box, or primitive".into())
}

/// A saved solid's BinTools bytes, and the face order its last line names (`BREP_ORDER`), empty when it names none.
fn brep_order(data: &[u8]) -> (&[u8], Vec<c_int>) {
    let Some(start) = data
        .windows(BREP_ORDER.len())
        .rposition(|window| window == BREP_ORDER)
    else {
        return (data, Vec::new());
    };
    let line = &data[start + BREP_ORDER.len()..];
    let Some(list) = line.strip_suffix(b"\n") else {
        return (data, Vec::new());
    };
    let order = std::str::from_utf8(list).ok().and_then(|list| {
        list.split(',')
            .map(|index| index.parse::<c_int>().ok())
            .collect::<Option<Vec<_>>>()
    });
    match order {
        Some(order) => (&data[..start], order),
        None => (data, Vec::new()),
    }
}

/// The linked Open CASCADE version, as a saved solid's header names it.
fn occt_version() -> String {
    let ptr = unsafe { lime_tree_occt_version() };
    if ptr.is_null() {
        return "unknown".into();
    }
    unsafe { CStr::from_ptr(ptr) }
        .to_string_lossy()
        .replace(char::is_whitespace, "_")
}

fn temp_step(tag: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "lime-tree-{tag}-{}-{}.step",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0)
    ))
}

/// The probe's measures of what it built, and of the solid it was built on, as JSON fields without braces.
/// `skipped` is set for a group: how many of its steps missed the solid and were left out.
fn probe_metrics(from: &Shape, built: &Shape, skipped: Option<u32>) -> String {
    let measure = |shape: &Shape| {
        let (solids, shells) = shape.counts();
        json!({ "volumeMm3": shape.fingerprint().volume_mm3, "solids": solids, "shells": shells })
    };
    let after = measure(built);
    let before = measure(from);
    let mut body = json!({
        "volumeMm3": after["volumeMm3"],
        "solids": after["solids"],
        "shells": after["shells"],
        "before": before,
    });
    // --- A1 group: present even when nothing was left out, so a caller can read it. ---
    if let Some(skipped) = skipped {
        body["skipped"] = json!(skipped);
    }
    // Only when a step made a hollow or a piece: say where, so the caller can move the step.
    if after["solids"].as_i64() > before["solids"].as_i64() || after["shells"].as_i64() > before["shells"].as_i64() {
        let report = take_text(unsafe { lime_tree_pieces(from.raw(), built.raw()) });
        if let Some(Ok(serde_json::Value::Object(fields))) =
            report.map(|text| serde_json::from_str::<serde_json::Value>(&format!("{{{text}}}")))
        {
            for (key, value) in fields {
                body[key] = value;
            }
        }
    }
    let text = body.to_string();
    text[1..text.len() - 1].to_string()
}
