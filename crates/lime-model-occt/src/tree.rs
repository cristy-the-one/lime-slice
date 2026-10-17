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

use std::collections::{HashMap, HashSet};
use std::ffi::{CStr, CString};
use std::fmt::Write as _;
use std::os::raw::{c_char, c_int};
use std::ptr::NonNull;
use std::sync::{Arc, LazyLock, Mutex};

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::json;

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

/// The first word of a solid saved in Open CASCADE's binary format (`Shape::brep_bytes`). Its header line is
/// `LIMEBREP 1 <Open CASCADE version> <volume>`, then the BinTools bytes. A STEP file never starts with it.
const BREP_MAGIC: &[u8] = b"LIMEBREP ";
const BREP_FORMAT: &str = "1";

// A reply sends the kernel's f32 and u32 arrays byte for byte, and the format says little-endian.
const _: () = assert!(cfg!(target_endian = "little"));

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BooleanOp {
    Fuse,
    Cut,
    Common,
}

impl BooleanOp {
    fn name(self) -> &'static CStr {
        match self {
            BooleanOp::Fuse => c"fuse",
            BooleanOp::Cut => c"cut",
            BooleanOp::Common => c"common",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Primitive {
    #[default]
    Box,
    Cylinder,
    Sphere,
    Cone,
    Torus,
    Wedge,
    Polygon,
    Tube,
    Ellipsoid,
}

impl Primitive {
    fn name(self) -> &'static CStr {
        match self {
            Primitive::Box => c"box",
            Primitive::Cylinder => c"cylinder",
            Primitive::Sphere => c"sphere",
            Primitive::Cone => c"cone",
            Primitive::Torus => c"torus",
            Primitive::Wedge => c"wedge",
            Primitive::Polygon => c"polygon",
            Primitive::Tube => c"tube",
            Primitive::Ellipsoid => c"ellipsoid",
        }
    }
}

/// A primitive solid: a boolean's tool, or a tree's root. Lengths are millimetres, turns degrees
/// about the primitive's centre by X, then Y, then Z. Each kind reads its own fields
/// (`docs/step-modeler.md`); the newer ones are written only when sent, so a box, cylinder, or
/// sphere stores exactly as it did before they existed.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Solid {
    pub primitive: Primitive,
    pub origin: [f64; 3],
    #[serde(default)]
    pub size: [f64; 3],
    #[serde(default)]
    pub radius: f64,
    #[serde(default)]
    pub height: f64,
    #[serde(default)]
    pub turn: [f64; 3],
    /// A cone's top. 0 is a point.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top_radius: Option<f64>,
    /// A torus's tube, about its ring at `radius`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tube_radius: Option<f64>,
    /// A tube's hole. `radius` is its outside.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inner_radius: Option<f64>,
    /// A wedge's top face, along X from `origin`. `size` is its base.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top_x: Option<f64>,
    /// A polygon prism's side count, 3 to 64.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sides: Option<f64>,
    /// A polygon prism's width, across corners, or across flats with `flats`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub across: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flats: Option<bool>,
}

impl Solid {
    /// The numbers `spec_of` in tree.cpp reads, in its order.
    fn numbers(&self) -> [f64; 18] {
        let [x, y, z] = self.origin;
        let [dx, dy, dz] = self.size;
        let [rx, ry, rz] = self.turn;
        let or_zero = |value: Option<f64>| value.unwrap_or(0.0);
        [
            x,
            y,
            z,
            dx,
            dy,
            dz,
            self.radius,
            self.height,
            rx,
            ry,
            rz,
            or_zero(self.top_radius),
            or_zero(self.tube_radius),
            or_zero(self.inner_radius),
            or_zero(self.top_x),
            or_zero(self.sides),
            or_zero(self.across),
            if self.flats == Some(true) { 1.0 } else { 0.0 },
        ]
    }
}

/// An edge as the kernel numbered it, with where it is and how long it is.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeRef {
    pub index: i32,
    pub mid: [f64; 3],
    pub length_mm: f64,
}

/// Which of a step's edges a pick takes. Every one is sharp: an edge already smooth, or a seam, cannot be blended.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EdgeFilter {
    #[default]
    All,
    Convex,
    Concave,
}

/// The edges an earlier step made or changed, still on the solid blended, worked out at every build from that step's
/// solid and the one it was built from, so a replay after an edit above finds them again.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeStep {
    pub from_node: NodeId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter: Option<EdgeFilter>,
}

/// A fresh pick is an index into the parent's reply. A stored op carries the full reference, or the step it takes
/// edges from as it was sent.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum EdgePick {
    Ref(EdgeRef),
    Step(EdgeStep),
    Index(i32),
}

/// A face as the kernel numbered it, with its centre of area and its area, so a rebuild can find it again.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FaceRef {
    pub index: i32,
    pub mid: [f64; 3],
    pub area_mm2: f64,
}

/// A fresh pick is an index into the parent's reply. A stored op carries the full reference.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum FacePick {
    Ref(FaceRef),
    Index(i32),
}

/// `q = m·p + t`, `m` row by row: the client's `Affine`.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Affine {
    pub m: [f64; 9],
    pub t: [f64; 3],
}

/// A turn is rigid within this much: columns of length 1 and square to each other.
const RIGID_TOLERANCE: f64 = 1e-6;

impl Affine {
    /// The twelve numbers `lime_tree_join` reads, when this is a turn and a move with no scale, shear, or mirror.
    fn rigid(&self) -> Result<[f64; 12], String> {
        let m = self.m;
        let col = |c: usize| [m[c], m[c + 3], m[c + 6]];
        let dot = |a: [f64; 3], b: [f64; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        let [x, y, z] = [col(0), col(1), col(2)];
        let unit = [x, y, z]
            .iter()
            .all(|c| (dot(*c, *c) - 1.0).abs() <= RIGID_TOLERANCE);
        let square = [(x, y), (y, z), (x, z)]
            .iter()
            .all(|(a, b)| dot(*a, *b).abs() <= RIGID_TOLERANCE);
        let det = dot(
            x,
            [
                y[1] * z[2] - y[2] * z[1],
                y[2] * z[0] - y[0] * z[2],
                y[0] * z[1] - y[1] * z[0],
            ],
        );
        let finite = m.iter().chain(&self.t).all(|value| value.is_finite());
        if !(finite && unit && square && det > 0.0) {
            return Err(
                "The tool's placement must be a turn and a move only, with no scale, shear, or mirror"
                    .into(),
            );
        }
        let t = self.t;
        Ok([
            m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], t[0], t[1], t[2],
        ])
    }
}

/// The solid a join takes from another tree: that tree's key and the step it held at Apply. `object` and
/// `name` are the client's (the plate object and its name then), stored and echoed as they came.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolRef {
    pub key: String,
    pub node: NodeId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// One edit. Lengths are millimetres, turns degrees about X, then Y, then Z.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Op {
    Boolean {
        op: BooleanOp,
        #[serde(flatten)]
        tool: Solid,
    },
    Hole {
        origin: [f64; 3],
        /// Into the material. Zero drills toward −Z.
        #[serde(default)]
        axis: [f64; 3],
        radius: f64,
        /// With `through`, kept for the panel but not cut.
        depth: f64,
        /// Cut to wherever the part ends along the axis, worked out from the solid it is cut from, so a
        /// replay after an earlier edit still goes all the way through.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        through: bool,
        /// A wider, shallow bore at the entry. Both are sent, or neither; one alone is refused as a size of 0.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        counterbore_radius: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        counterbore_depth: Option<f64>,
    },
    /// The node keeps the negative side. The positive side is answered once, in the apply reply,
    /// and with `otherKey` it becomes the root of its own tree. Replaying the split never touches that tree.
    Split {
        origin: [f64; 3],
        normal: [f64; 3],
    },
    Fillet {
        edges: Vec<EdgePick>,
        size: f64,
    },
    Chamfer {
        edges: Vec<EdgePick>,
        size: f64,
    },
    Scale {
        factor: f64,
    },
    /// Another tree's solid at `tool.node`, moved into this solid's frame by `relative`, which was
    /// worked out once at Apply, so moving either part later never moves a cut already made.
    Join {
        op: BooleanOp,
        tool: ToolRef,
        relative: Affine,
        #[serde(default)]
        keep_tool: bool,
    },
    /// A new solid's primitive built again from other numbers, in place of the solid above it. An edited
    /// primitive root forks this way, right under the root, so node 0, which other steps and trees name, never changes.
    Root {
        #[serde(flatten)]
        solid: Solid,
    },
    /// A closed outline of `[u, v]` points on the plane at `origin`, turned by `turn` as a workplane is, pushed
    /// `depth` along W (−W when negative), or centred on the plane with `symmetric`, and combined by `op`.
    Extrude {
        op: BooleanOp,
        origin: [f64; 3],
        #[serde(default)]
        turn: [f64; 3],
        profile: Vec<[f64; 2]>,
        depth: f64,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        symmetric: bool,
        /// Splines through the points, sharp at `corners`.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        smooth: bool,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        corners: Vec<u32>,
    },
    /// The same outline turned `angleDeg` (360 when absent) about the in-plane axis through `axisOrigin` ([0, 0]
    /// when absent) along `axisDir` (V, [0, 1], when absent), and combined by `op`.
    Revolve {
        op: BooleanOp,
        origin: [f64; 3],
        #[serde(default)]
        turn: [f64; 3],
        profile: Vec<[f64; 2]>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        axis_origin: Option<[f64; 2]>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        axis_dir: Option<[f64; 2]>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        angle_deg: Option<f64>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        smooth: bool,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        corners: Vec<u32>,
    },
    /// A solid through `sections` in order, smooth or `ruled`, combined by `op`.
    Loft {
        op: BooleanOp,
        sections: Vec<LoftSection>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        ruled: bool,
    },
    /// The solid hollowed inward to walls `thickness` thick, with `openFaces` removed. None open leaves a closed void.
    Shell {
        thickness: f64,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        open_faces: Vec<FacePick>,
    },
}

/// One cross-section of a loft, on the plane at `origin` turned by `turn`: a profile of `[u, v]` points, or a circle of
/// `radius` about the origin (an ellipse with `radiusV`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoftSection {
    pub origin: [f64; 3],
    #[serde(default)]
    pub turn: [f64; 3],
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub profile: Vec<[f64; 2]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub radius: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub radius_v: Option<f64>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub smooth: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub corners: Vec<u32>,
}

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
    let transient = matches!(&request, Request::MeshStep { .. } | Request::Capabilities);
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

#[derive(Deserialize)]
#[serde(
    tag = "call",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum Request {
    /// Stateless import for slicing; it owns no history and cannot evict a document.
    MeshStep {
        data_b64: String,
        chord_mm: f64,
    },
    Capabilities,

    /// Open a tree from its root: a STEP, or a primitive built from its numbers. With `nodes`,
    /// register the saved ops (parents first) without building them, then jump to `current`.
    /// `fingerprint` is the root's as saved: a root that builds to another is broken.
    Open {
        key: String,
        data_b64: Option<String>,
        step_path: Option<String>,
        #[serde(rename = "box")]
        box_mm: Option<[f64; 3]>,
        primitive: Option<Solid>,
        fingerprint: Option<Fingerprint>,
        #[serde(default = "default_chord", alias = "stepToleranceMm")]
        chord_mm: f64,
        #[serde(default)]
        nodes: Vec<SavedNode>,
        #[serde(default)]
        current: NodeId,
        /// One saved step's solid as `export` wrote it in `brep`, so that step and the steps after it build
        /// without replaying the steps above it.
        seed: Option<SeedSolid>,
        /// Build `current` but answer only `{id, fingerprint}`, for a caller that asks for the step next anyway.
        #[serde(default)]
        quiet: bool,
    },
    Apply {
        key: String,
        parent: NodeId,
        node: NodeId,
        op: Op,
        #[serde(default = "default_chord")]
        chord_mm: f64,
        /// Split only: the piece cut off opens as the root of its own tree under this key.
        other_key: Option<String>,
    },
    /// With `preview`, a probe that builds also answers the built shape's reply at `chordMm`, which
    /// the shape keeps, so an Apply that takes the probe meshes nothing again.
    Probe {
        key: String,
        node: NodeId,
        op: Op,
        #[serde(default)]
        preview: bool,
        #[serde(default = "default_chord")]
        chord_mm: f64,
    },
    /// An edited step: `op` built on `parent` as the new `node`, a sibling of the step edited, then each
    /// of `replay` on the one before it. Nothing already in the tree changes. `tools` are edits of tool
    /// trees, deepest first, each feeding the join above it: the next one's `op` is a join naming the
    /// last step of the one before, and this edit's `op` names the last step of the last of `tools`.
    Edit {
        key: String,
        parent: NodeId,
        node: NodeId,
        op: Op,
        #[serde(default)]
        replay: Vec<ReplayStep>,
        #[serde(default)]
        tools: Vec<ToolEdit>,
        #[serde(default = "default_chord")]
        chord_mm: f64,
    },
    Goto {
        key: String,
        node: NodeId,
        #[serde(default = "default_chord")]
        chord_mm: f64,
    },
    Drop {
        key: String,
        node: NodeId,
    },
    Close {
        key: String,
    },
    Distance {
        key: String,
        node: NodeId,
        a_kind: String,
        a_index: i32,
        b_kind: String,
        b_index: i32,
    },
    /// `format` is `step` (the default, for a file to hand on) or `brep` (the binary a project keeps).
    Export {
        key: String,
        node: NodeId,
        #[serde(default)]
        format: ExportFormat,
    },
}

#[derive(Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum ExportFormat {
    #[default]
    Step,
    Brep,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SeedSolid {
    node: NodeId,
    data_b64: String,
}

#[derive(Deserialize)]
struct ReplayStep {
    id: NodeId,
    op: Op,
}

/// One tree's part of an edit: `op` on `parent` as `node`, then each of `replay`. Its tip is the last step it keeps.
#[derive(Deserialize)]
struct ToolEdit {
    key: String,
    parent: NodeId,
    node: NodeId,
    op: Op,
    #[serde(default)]
    replay: Vec<ReplayStep>,
}

impl ToolEdit {
    fn tip(&self) -> NodeId {
        self.replay.last().map_or(self.node, |step| step.id)
    }

    fn ids(&self) -> impl Iterator<Item = NodeId> + '_ {
        std::iter::once(self.node).chain(self.replay.iter().map(|step| step.id))
    }
}

/// How a tool tree's part of an edit ended: its tip built, or the step that broke and why.
type Tip = Result<NodeId, String>;

/// An edit's new branch: the last step that built, each built step as `{id, op, fingerprint}`, and the broken step with why.
type Forked = (NodeId, Vec<serde_json::Value>, Option<(NodeId, String)>);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedNode {
    id: NodeId,
    parent: NodeId,
    op: Op,
    fingerprint: Option<Fingerprint>,
}

fn default_chord() -> f64 {
    0.1
}

/// The kernel's clamp, so one reply is cached once whatever chord asked for it.
fn chord_key(chord: f64) -> u64 {
    let clamped = if chord.is_nan() {
        0.01
    } else {
        chord.clamp(0.01, 2.0)
    };
    clamped.to_bits()
}

enum Answer {
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
enum Part {
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

enum Failure {
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
}

const TOOL_MISSING: &str = "The tool object's history is not open in the modeler";
const CYCLE: &str = "The tool object's history already uses this part, so the two cannot be joined";

impl Failure {
    fn json(&self) -> String {
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
        }
    }
}

/// `text` is a JSON object. Each field is added before its closing brace, in one allocation with
/// room for the terminator the C string adds, since a solid reply is megabytes.
fn with_fields(text: &str, fields: &[(&str, Part)]) -> String {
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

fn write_object(out: &mut String, text: &str, fields: &[(&str, Part)]) {
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

struct Node {
    parent: Option<NodeId>,
    op: Option<Op>,
    shape: Option<Shape>,
    fingerprint: Option<Fingerprint>,
    broken: Option<String>,
    /// A split's `otherKey`, so a retried apply can be told from a different one.
    piece: Option<String>,
    /// The edges this step made or changed, read once from its solid when a later blend first picks them.
    created: Option<Vec<EdgeRef>>,
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

impl Doc {
    fn new(root: Shape, used: u64) -> Doc {
        let fingerprint = root.fingerprint();
        let mut nodes = HashMap::new();
        nodes.insert(
            ROOT,
            Node {
                parent: None,
                op: None,
                shape: Some(root),
                fingerprint: Some(fingerprint),
                broken: None,
                piece: None,
                created: None,
                seeded: false,
                depth: 0,
                used,
            },
        );
        Doc {
            nodes,
            current: ROOT,
            probe: None,
        }
    }

    fn node(&self, id: NodeId) -> Result<&Node, Failure> {
        self.nodes.get(&id).ok_or(Failure::Missing(vec![id]))
    }

    fn insert(&mut self, id: NodeId, parent: NodeId, op: Op) -> Result<&mut Node, Failure> {
        root_placement(parent, &op).map_err(Failure::Message)?;
        let depth = self.node(parent)?.depth + 1;
        let node = self.nodes.entry(id).or_insert(Node {
            parent: Some(parent),
            op: Some(op),
            shape: None,
            fingerprint: None,
            broken: None,
            piece: None,
            created: None,
            seeded: false,
            depth,
            used: 0,
        });
        Ok(node)
    }

    fn held(&self) -> Vec<NodeId> {
        let mut held: Vec<NodeId> = self
            .nodes
            .iter()
            .filter(|(_, node)| node.shape.is_some())
            .map(|(id, _)| *id)
            .collect();
        held.sort_unstable();
        held
    }

    /// Whether `node` is `id` or a step above it.
    fn above(&self, id: NodeId, node: NodeId) -> bool {
        let mut at = Some(id);
        while let Some(step) = at {
            if step == node {
                return true;
            }
            at = self.nodes.get(&step).and_then(|found| found.parent);
        }
        false
    }

    /// The root, the current node, every eighth node on the path between them, and every seeded node.
    fn pinned(&self) -> HashSet<NodeId> {
        let mut pinned = HashSet::from([ROOT, self.current]);
        pinned.extend(
            self.nodes
                .iter()
                .filter(|(_, node)| node.seeded)
                .map(|(id, _)| *id),
        );
        let mut at = Some(self.current);
        while let Some(id) = at {
            let Some(node) = self.nodes.get(&id) else {
                break;
            };
            if node.depth % PATH_PIN_EVERY == 0 {
                pinned.insert(id);
            }
            at = node.parent;
        }
        pinned
    }

    /// `id` and every node under it.
    fn subtree(&self, id: NodeId) -> HashSet<NodeId> {
        let mut found = HashSet::from([id]);
        loop {
            let before = found.len();
            for (child, node) in &self.nodes {
                if node.parent.is_some_and(|up| found.contains(&up)) {
                    found.insert(*child);
                }
            }
            if found.len() == before {
                return found;
            }
        }
    }

    /// No solid under a broken node stays usable: each would have been built from a solid that
    /// no longer rebuilds the same.
    fn mark_broken(&mut self, id: NodeId, message: String) -> Failure {
        let under = self.subtree(id);
        for node in &under {
            if let Some(node) = self.nodes.get_mut(node) {
                node.shape = None;
            }
        }
        if let Some(node) = self.nodes.get_mut(&id) {
            node.broken = Some(message.clone());
        }
        if self
            .probe
            .as_ref()
            .is_some_and(|probe| under.contains(&probe.parent))
        {
            self.probe = None;
        }
        Failure::Broken { node: id, message }
    }

    /// The first broken node from `id` up to the root, as the failure a call on `id` answers.
    fn broken_above(&self, id: NodeId) -> Result<(), Failure> {
        let mut at = Some(id);
        while let Some(step) = at {
            let node = self.node(step)?;
            if let Some(message) = &node.broken {
                return Err(Failure::Broken {
                    node: step,
                    message: message.clone(),
                });
            }
            at = node.parent;
        }
        Ok(())
    }

    /// The steps from `id` up to the nearest ancestor that holds its solid, `id` first: what a
    /// replay of `id` builds.
    fn unbuilt(&self, id: NodeId) -> Result<Vec<NodeId>, Failure> {
        let mut chain = Vec::new();
        let mut at = id;
        loop {
            let node = self.node(at)?;
            if let Some(message) = &node.broken {
                return Err(Failure::Broken {
                    node: at,
                    message: message.clone(),
                });
            }
            if node.shape.is_some() {
                return Ok(chain);
            }
            chain.push(at);
            at = node.parent.expect("the root always holds its solid");
        }
    }

    /// Give `id` a solid, replaying from the nearest ancestor that has one. `tools` holds the
    /// solid each join step on the way takes from its tool tree, and `steps` the edges each blend
    /// on the way takes from an earlier step (`Store::ensure`).
    /// Returns how many steps were replayed. Only solids are built here, never replies.
    fn ensure_shape(
        &mut self,
        id: NodeId,
        clock: &mut u64,
        tools: &HashMap<NodeId, ToolSolid>,
        steps: &HashMap<NodeId, Steps>,
    ) -> Result<usize, Failure> {
        let chain = self.unbuilt(id)?;
        let replayed = chain.len();
        for step in chain.into_iter().rev() {
            let (parent, op, expected) = {
                let node = &self.nodes[&step];
                (
                    node.parent.expect("only the root has no parent"),
                    node.op.clone().expect("only the root has no op"),
                    node.fingerprint,
                )
            };
            let built = {
                let from = self
                    .nodes
                    .get_mut(&parent)
                    .and_then(|node| node.shape.as_mut())
                    .expect("the parent was built first");
                let none = Steps::new();
                resolve(from, &op, steps.get(&step).unwrap_or(&none)).and_then(|op| {
                    build(from, op, false, tools.get(&step).copied())
                        .map_err(|(message, _)| message)
                })
            };
            let built = match built {
                Ok(built) => built,
                Err(message) => return Err(self.mark_broken(step, message)),
            };
            let got = built.kept.fingerprint();
            if let Some(expected) = expected {
                if !expected.matches(&got) {
                    return Err(self.mark_broken(step, rebuilt_differently(&got, &expected)));
                }
            }
            *clock += 1;
            let node = self.nodes.get_mut(&step).expect("step is in the tree");
            node.fingerprint = Some(got);
            node.op = Some(built.op);
            node.shape = Some(built.kept);
            node.used = *clock;
        }
        *clock += 1;
        if let Some(node) = self.nodes.get_mut(&id) {
            node.used = *clock;
        }
        Ok(replayed)
    }

    fn shape(&mut self, id: NodeId) -> &mut Shape {
        self.nodes
            .get_mut(&id)
            .and_then(|node| node.shape.as_mut())
            .expect("ensure_shape ran first")
    }
}

impl Store {
    /// Give node `id` of tree `key` a solid. A join on the way first has its tool tree build the step
    /// it names, from that tree's own kept solids, so one tree's step can depend on another's.
    fn ensure(&mut self, key: &str, id: NodeId) -> Result<usize, Failure> {
        self.ensure_from(key, id, &mut Vec::new())
    }

    /// `visiting` is the trees whose replay is under way, so a history that names itself fails plainly.
    fn ensure_from(
        &mut self,
        key: &str,
        id: NodeId,
        visiting: &mut Vec<String>,
    ) -> Result<usize, Failure> {
        // A blend's step picks first: reading a step's edges may build that step, and so part of this replay.
        let doc = doc_in(&mut self.docs, key)?;
        let picking: Vec<(NodeId, NodeId, Op)> = doc
            .unbuilt(id)?
            .into_iter()
            .filter_map(|step| {
                let node = &doc.nodes[&step];
                let op = node.op.as_ref()?;
                picks_steps(op).then(|| (step, node.parent.expect("only the root has no parent"), op.clone()))
            })
            .collect();
        let mut steps = HashMap::new();
        for (step, parent, op) in picking {
            match self.step_edges(key, parent, &op) {
                Ok(found) => {
                    steps.insert(step, found);
                }
                Err(Failure::Message(message)) => {
                    return Err(doc_in(&mut self.docs, key)?.mark_broken(step, message));
                }
                Err(failure) => return Err(failure),
            }
        }
        let doc = doc_in(&mut self.docs, key)?;
        let joins: Vec<(NodeId, ToolRef)> = doc
            .unbuilt(id)?
            .into_iter()
            .filter_map(|step| match &doc.nodes[&step].op {
                Some(Op::Join { tool, .. }) => Some((step, tool.clone())),
                _ => None,
            })
            .collect();
        let mut tools = HashMap::new();
        for (step, tool) in joins {
            match self.tool_solid(key, &tool, visiting) {
                Ok(solid) => {
                    tools.insert(step, solid);
                }
                Err(Failure::ToolMissing {
                    key: missing,
                    step: wanted,
                    ..
                }) => {
                    return Err(Failure::ToolMissing {
                        node: Some(step),
                        key: missing,
                        step: wanted,
                    })
                }
                Err(Failure::Message(message)) => {
                    return Err(doc_in(&mut self.docs, key)?.mark_broken(step, message));
                }
                Err(failure) => return Err(failure),
            }
        }
        doc_in(&mut self.docs, key)?.ensure_shape(id, &mut self.clock, &tools, &steps)
    }

    /// The solid a join on tree `key` takes from `tool`, built if it must be. A tool tree or step this
    /// engine does not hold is `ToolMissing`; one that cannot serve as a tool is a plain message.
    fn tool_solid(
        &mut self,
        key: &str,
        tool: &ToolRef,
        visiting: &mut Vec<String>,
    ) -> Result<ToolSolid, Failure> {
        if tool.key == key {
            return Err(Failure::Message("A part cannot be its own tool".into()));
        }
        if visiting.contains(&tool.key) {
            return Err(Failure::Message(CYCLE.into()));
        }
        let held = self
            .docs
            .get(&tool.key)
            .is_some_and(|doc| doc.nodes.contains_key(&tool.node));
        if !held {
            return Err(Failure::ToolMissing {
                node: None,
                key: tool.key.clone(),
                step: tool.node,
            });
        }
        visiting.push(key.to_string());
        let built = self.ensure_from(&tool.key, tool.node, visiting);
        visiting.pop();
        match built {
            Ok(_) => {}
            Err(Failure::ToolMissing { key, step, .. }) => {
                return Err(Failure::ToolMissing {
                    node: None,
                    key,
                    step,
                })
            }
            Err(Failure::Message(message)) => return Err(Failure::Message(message)),
            Err(Failure::Broken { message, .. }) => {
                return Err(Failure::Message(format!(
                    "The tool object's step could not be rebuilt: {message}"
                )))
            }
            Err(Failure::Missing(_)) => {
                return Err(Failure::ToolMissing {
                    node: None,
                    key: tool.key.clone(),
                    step: tool.node,
                })
            }
        }
        let shape = self.docs[&tool.key].nodes[&tool.node]
            .shape
            .as_ref()
            .expect("ensure_from built it");
        shape.editable().map_err(|_| {
            Failure::Message(
                "The tool object has surfaces but no closed solid, so it cannot be used as a tool"
                    .into(),
            )
        })?;
        Ok(ToolSolid(shape.raw()))
    }

    /// The edges each step that `op`, built on `parent`, takes edges from made: read once from that step's solid,
    /// which is built first if it must be. A step that is not `parent` or above it is refused.
    fn step_edges(&mut self, key: &str, parent: NodeId, op: &Op) -> Result<Steps, Failure> {
        let wanted: Vec<NodeId> = match op {
            Op::Fillet { edges, .. } | Op::Chamfer { edges, .. } => edges
                .iter()
                .filter_map(|pick| match pick {
                    EdgePick::Step(step) => Some(step.from_node),
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        };
        let mut steps = Steps::new();
        for node in wanted {
            if steps.contains_key(&node) {
                continue;
            }
            if !doc_in(&mut self.docs, key)?.above(parent, node) {
                return Err(Failure::Message(NOT_ABOVE.into()));
            }
            let kept = doc_in(&mut self.docs, key)?
                .node(node)?
                .created
                .clone();
            let made = match kept {
                Some(made) => made,
                None => {
                    self.ensure(key, node)?;
                    let doc = doc_in(&mut self.docs, key)?;
                    let made = doc.shape(node).created_edges();
                    if let Some(at) = doc.nodes.get_mut(&node) {
                        at.created = Some(made.clone());
                    }
                    made
                }
            };
            steps.insert(node, made);
        }
        Ok(steps)
    }

    /// Whether tree `from`, or any tree its joins take a tool from, takes one from tree `key`.
    /// A tree on the way that this engine does not hold is `ToolMissing`, so the client opens it and
    /// the answer covers every tree.
    fn uses(&self, from: &ToolRef, key: &str) -> Result<bool, Failure> {
        let mut queue = vec![(from.key.clone(), from.node)];
        let mut seen = HashSet::new();
        while let Some((at, step)) = queue.pop() {
            if at == key {
                return Ok(true);
            }
            if !seen.insert(at.clone()) {
                continue;
            }
            let Some(doc) = self.docs.get(&at) else {
                return Err(Failure::ToolMissing {
                    node: None,
                    key: at,
                    step,
                });
            };
            for node in doc.nodes.values() {
                if let Some(Op::Join { tool, .. }) = &node.op {
                    queue.push((tool.key.clone(), tool.node));
                }
            }
        }
        Ok(false)
    }

    /// A new join's checks before anything is built: a rigid placement, another part, and no loop
    /// between two histories. A loop would leave each tree naming the other, so neither could ever
    /// be closed, nor its join's branch dropped. A refusal is a plain `Message`.
    fn join_refusal(&self, key: &str, op: &Op) -> Result<(), Failure> {
        let Op::Join { tool, relative, .. } = op else {
            return Ok(());
        };
        relative.rigid().map_err(Failure::Message)?;
        if tool.key == key {
            return Err(Failure::Message("A part cannot be its own tool".into()));
        }
        if self.uses(tool, key)? {
            return Err(Failure::Message(CYCLE.into()));
        }
        Ok(())
    }

    /// Whether a join in a tree other than `key` takes its tool from one of `nodes` of `key` (any node when None).
    fn names_tool(&self, key: &str, nodes: Option<&HashSet<NodeId>>) -> bool {
        self.docs
            .iter()
            .filter(|(other, _)| other.as_str() != key)
            .flat_map(|(_, doc)| doc.nodes.values())
            .any(|node| {
                matches!(&node.op, Some(Op::Join { tool, .. })
                    if tool.key == key && nodes.is_none_or(|nodes| nodes.contains(&tool.node)))
            })
    }

    fn handle(&mut self, request: Request) -> Result<Answer, Failure> {
        match request {
            Request::Capabilities => Ok(Answer::Plain(
                json!({"stepMeshing": cfg!(lime_occt_step)}).to_string(),
            )),
            Request::MeshStep { data_b64, chord_mm } => {
                if !chord_mm.is_finite() || !(0.01..=2.0).contains(&chord_mm) {
                    return Err(Failure::Message(
                        "STEP chord tolerance must be from 0.01 to 2 mm".into(),
                    ));
                }
                let mut shape = root_shape(Some(data_b64), None, None, None)?;
                Ok(Answer::Plain(shape.reply(ROOT, chord_mm)?))
            }
            Request::Open {
                key,
                data_b64,
                step_path,
                box_mm,
                primitive,
                fingerprint,
                chord_mm,
                nodes,
                current,
                seed,
                quiet,
            } => {
                let root = root_shape(data_b64, step_path, box_mm, primitive)?;
                if let Some(saved) = fingerprint {
                    let got = root.fingerprint();
                    if !saved.matches(&got) {
                        return Err(Failure::Broken {
                            node: ROOT,
                            message: rebuilt_differently(&got, &saved),
                        });
                    }
                }
                self.open(
                    key,
                    root,
                    nodes,
                    current,
                    seed,
                    (!quiet).then_some(chord_mm),
                )
            }
            Request::Apply {
                key,
                parent,
                node,
                op,
                chord_mm,
                other_key,
            } => self.apply(key, parent, node, op, chord_mm, other_key),
            Request::Probe {
                key,
                node,
                op,
                preview,
                chord_mm,
            } => self.probe(&key, node, op, preview.then_some(chord_mm)),
            Request::Edit {
                key,
                parent,
                node,
                op,
                replay,
                tools,
                chord_mm,
            } => {
                let mut levels = tools;
                levels.push(ToolEdit {
                    key,
                    parent,
                    node,
                    op,
                    replay,
                });
                self.edit(levels, chord_mm)
            }
            Request::Goto {
                key,
                node,
                chord_mm,
            } => self.goto(key, node, chord_mm),
            Request::Drop { key, node } => self.drop_branch(key, node),
            Request::Close { key } => {
                if self.names_tool(&key, None) {
                    return Err(Failure::Message(
                        "A step of another part's history uses this part as its tool, so it stays open"
                            .into(),
                    ));
                }
                self.docs.remove(&key);
                self.replies.retain(|reply| reply.key != key);
                Ok(Answer::Plain(json!({ "ok": true }).to_string()))
            }
            Request::Distance {
                key,
                node,
                a_kind,
                a_index,
                b_kind,
                b_index,
            } => {
                self.ensure(&key, node)?;
                let distance = doc_in(&mut self.docs, &key)?
                    .shape(node)
                    .distance(&a_kind, a_index, &b_kind, b_index)
                    .map_err(Failure::Message)?;
                Ok(Answer::Plain(
                    json!({ "id": node, "distanceMm": distance }).to_string(),
                ))
            }
            Request::Export { key, node, format } => {
                self.ensure(&key, node)?;
                let shape = doc_in(&mut self.docs, &key)?.shape(node);
                let bytes = match format {
                    ExportFormat::Step => shape.step_bytes(),
                    ExportFormat::Brep => shape.brep_bytes(),
                }
                .map_err(Failure::Message)?;
                let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
                let format = match format {
                    ExportFormat::Step => "step",
                    ExportFormat::Brep => "brep",
                };
                Ok(Answer::Plain(format!(
                    "{{\"bytesBase64\":\"{encoded}\",\"byteLength\":{},\"format\":\"{format}\"}}",
                    bytes.len()
                )))
            }
        }
    }

    fn open(
        &mut self,
        key: String,
        root: Shape,
        saved: Vec<SavedNode>,
        current: NodeId,
        seed: Option<SeedSolid>,
        chord: Option<f64>,
    ) -> Result<Answer, Failure> {
        self.clock += 1;
        let mut doc = Doc::new(root, self.clock);
        for node in saved {
            if node.id == ROOT || doc.nodes.contains_key(&node.id) {
                return Err(Failure::Message(format!(
                    "Saved node {} is listed twice or replaces the root",
                    node.id
                )));
            }
            if !doc.nodes.contains_key(&node.parent) {
                return Err(Failure::Message(format!(
                    "Saved node {} comes before its parent {}",
                    node.id, node.parent
                )));
            }
            doc.insert(node.id, node.parent, node.op)?.fingerprint = node.fingerprint;
        }
        // A seed that does not read, or is not the step it names, is left out: the step is replayed instead.
        let refused = seed.and_then(|seed| {
            let used = self.clock;
            seed_node(&mut doc, seed, used).err()
        });
        self.replies.retain(|reply| reply.key != key);
        self.docs.insert(key.clone(), doc);
        // Without a chord the step is built and kept, not meshed: the caller asks for it next.
        let mut answer = match chord {
            Some(chord) => self.goto(key, current, chord)?,
            None => {
                doc_in(&mut self.docs, &key)?.broken_above(current)?;
                let replayed = self.ensure(&key, current)?;
                let doc = doc_in(&mut self.docs, &key)?;
                doc.current = current;
                let fingerprint = doc.node(current)?.fingerprint;
                Answer::Held {
                    key,
                    text: Arc::new(
                        json!({ "id": current, "fingerprint": fingerprint }).to_string(),
                    ),
                    fields: vec![("replayed", Part::Json(replayed.to_string()))],
                }
            }
        };
        if let (Some(message), Answer::Held { fields, .. }) = (refused, &mut answer) {
            fields.push(("seedRefused", Part::Json(json!(message).to_string())));
        }
        Ok(answer)
    }

    fn goto(&mut self, key: String, id: NodeId, chord: f64) -> Result<Answer, Failure> {
        let doc = doc_in(&mut self.docs, &key)?;
        doc.broken_above(id)?;
        doc.probe = None;
        let (text, replayed) = match self.cached_reply(&key, id, chord) {
            Some(text) => {
                let doc = doc_in(&mut self.docs, &key)?;
                if let Some(node) = doc.nodes.get_mut(&id) {
                    node.used = self.clock;
                }
                (text, 0)
            }
            None => {
                let replayed = self.ensure(&key, id)?;
                (self.reply(&key, id, chord)?, replayed)
            }
        };
        doc_in(&mut self.docs, &key)?.current = id;
        Ok(Answer::Held {
            key,
            text,
            fields: vec![("replayed", Part::Json(replayed.to_string()))],
        })
    }

    fn cached_reply(&mut self, key: &str, id: NodeId, chord: f64) -> Option<Arc<String>> {
        let chord = chord_key(chord);
        self.clock += 1;
        let reply = self
            .replies
            .iter_mut()
            .find(|reply| reply.key == key && reply.node == id && reply.chord == chord)?;
        reply.used = self.clock;
        Some(Arc::clone(&reply.text))
    }

    /// The node's reply, built and cached on first use. The node must hold its solid.
    fn reply(&mut self, key: &str, id: NodeId, chord: f64) -> Result<Arc<String>, Failure> {
        if let Some(text) = self.cached_reply(key, id, chord) {
            return Ok(text);
        }
        let doc = doc_in(&mut self.docs, key)?;
        let text = Arc::new(doc.shape(id).reply(id, chord)?);
        self.remember(key, id, chord, Arc::clone(&text));
        Ok(text)
    }

    fn remember(&mut self, key: &str, id: NodeId, chord: f64, text: Arc<String>) {
        self.replies.push(Reply {
            key: key.to_string(),
            node: id,
            chord: chord_key(chord),
            text,
            used: self.clock,
        });
    }

    fn apply(
        &mut self,
        key: String,
        parent: NodeId,
        id: NodeId,
        op: Op,
        chord: f64,
        other_key: Option<String>,
    ) -> Result<Answer, Failure> {
        if other_key.is_some() && !matches!(op, Op::Split { .. }) {
            return Err(Failure::Message("otherKey is only for a split".into()));
        }
        if other_key.as_deref() == Some(key.as_str()) {
            return Err(Failure::Message(
                "The split piece needs a key of its own".into(),
            ));
        }
        let doc = doc_in(&mut self.docs, &key)?;
        if let Some(existing) = doc.nodes.get(&id) {
            let same = existing.parent == Some(parent)
                && existing.piece == other_key
                && existing
                    .op
                    .as_ref()
                    .is_some_and(|stored| same_request(stored, &op));
            if same {
                return self.goto(key, id, chord);
            }
            return Err(Failure::Message(format!(
                "Node {id} is already in this tree for another step"
            )));
        }
        root_placement(parent, &op).map_err(Failure::Message)?;
        self.join_refusal(&key, &op)?;
        let replayed = self.ensure(&key, parent)?;
        let steps = self.step_edges(&key, parent, &op)?;
        let (op, reused) = {
            let doc = doc_in(&mut self.docs, &key)?;
            let probed = doc.probe.take();
            let from = doc.shape(parent);
            from.editable().map_err(Failure::Message)?;
            let op = resolve(from, &op, &steps).map_err(Failure::Message)?;
            match probed {
                Some(probed) if probed.parent == parent && same_build(&probed.op, &op.op) => {
                    (op, Some(probed.built))
                }
                _ => (op, None),
            }
        };
        let mut built = match reused {
            // The op stored is the one applied: a join's `keepTool` and its tool's name build nothing.
            Some(reused) => Built { op: op.op, ..reused },
            None => {
                let tool = self.join_tool(&key, &op.op)?;
                let from = doc_in(&mut self.docs, &key)?.shape(parent);
                build(from, op, false, tool).map_err(|(message, _)| Failure::Message(message))?
            }
        };
        let doc = doc_in(&mut self.docs, &key)?;
        let fingerprint = built.kept.fingerprint();
        self.clock += 1;
        let previous = doc.current;
        let node = doc.insert(id, parent, built.op.clone())?;
        node.fingerprint = Some(fingerprint);
        node.shape = Some(built.kept);
        node.piece = other_key.clone();
        node.used = self.clock;
        doc.current = id;
        // The other piece is sent only to start its own tree. A split replayed without `otherKey`
        // drops it unseen.
        let rendered = self.reply(&key, id, chord).and_then(|text| {
            let other = match (built.other.as_mut(), &other_key) {
                (Some(other), Some(_)) => Some(other.reply(ROOT, chord)?),
                _ => None,
            };
            Ok((text, other))
        });
        let (text, other) = match rendered {
            Ok(rendered) => rendered,
            Err(failure) => {
                if let Some(doc) = self.docs.get_mut(&key) {
                    doc.nodes.remove(&id);
                    doc.current = previous;
                }
                self.replies
                    .retain(|reply| reply.key != key || reply.node != id);
                return Err(failure);
            }
        };
        let mut fields = vec![
            ("op", Part::Json(json!(built.op).to_string())),
            ("replayed", Part::Json(replayed.to_string())),
        ];
        if let (Some(piece), Some(other_key), Some(other)) = (built.other, other_key, other) {
            self.clock += 1;
            self.replies.retain(|reply| reply.key != other_key);
            self.docs
                .insert(other_key.clone(), Doc::new(piece, self.clock));
            let other = Arc::new(other);
            self.remember(&other_key, ROOT, chord, Arc::clone(&other));
            let key_field = ("key", Part::Json(json!(other_key).to_string()));
            fields.push(("other", Part::Object(other, vec![key_field])));
        }
        Ok(Answer::Held { key, text, fields })
    }

    fn probe(
        &mut self,
        key: &str,
        id: NodeId,
        op: Op,
        preview: Option<f64>,
    ) -> Result<Answer, Failure> {
        let checked = root_placement(id, &op)
            .map_err(Failure::Message)
            .and_then(|()| self.join_refusal(key, &op));
        self.ensure(key, id)?;
        doc_in(&mut self.docs, key)?.probe = None;
        let tool = match checked.and_then(|()| self.join_tool(key, &op)) {
            Ok(tool) => Ok(tool),
            Err(Failure::Message(message)) => Err(message),
            Err(failure) => return Err(failure),
        };
        let steps = match self.step_edges(key, id, &op) {
            Ok(steps) => Ok(steps),
            Err(Failure::Message(message)) => Err(message),
            Err(failure) => return Err(failure),
        };
        let doc = doc_in(&mut self.docs, key)?;
        let from = doc.shape(id);
        let result = tool
            .and_then(|tool| steps.map(|steps| (tool, steps)))
            .and_then(|(tool, steps)| from.editable().map(|()| (tool, steps)))
            .and_then(|(tool, steps)| resolve(from, &op, &steps).map(|op| (op, tool)))
            .map_err(|message| (message, None))
            .and_then(|(op, tool)| build(from, op, true, tool));
        match result {
            Ok(mut built) => {
                // The shape keeps what its reply measured and meshed, so an Apply that takes it meshes nothing again.
                let shown = preview.and_then(|chord| built.kept.reply(id, chord).ok());
                let metrics = probe_metrics(from, &built.kept);
                doc.probe = Some(Probed {
                    parent: id,
                    op: built.op.clone(),
                    built,
                });
                Ok(Answer::Plain(match shown {
                    Some(text) => format!("{{\"ok\":true,{metrics},\"preview\":{text}}}"),
                    None => format!("{{\"ok\":true,{metrics}}}"),
                }))
            }
            Err((message, max_mm)) => {
                let mut reply = json!({ "ok": false, "error": message });
                if let Some(max_mm) = max_mm.filter(|max| max + 1e-6 >= 0.05) {
                    reply["maxMm"] = json!(max_mm);
                }
                Ok(Answer::Plain(reply.to_string()))
            }
        }
    }

    /// An edited step and the steps under it, in one call: `op` on `parent` as the new node `id`, a sibling of the step
    /// edited, then each of `replay` on the one before it. A replayed step that no longer builds is kept, broken, the steps
    /// after it unbuilt under it, and the tree shows the last step that built, the only one tessellated. A failure before
    /// anything is kept (the edited step itself, or a tool tree this engine lacks) leaves the tree as it was.
    ///
    /// `levels` is the tool trees' edits, deepest first, then the tree's own last, all under the one lock. Each after the
    /// first is a join that takes the tip of the one before. A tool step that no longer builds is kept broken as in any
    /// replay, and so is the join above it, which has no tool to take. A failure of the edited op, or of a join whose tool
    /// built, keeps nothing in any tree.
    fn edit(&mut self, levels: Vec<ToolEdit>, chord: f64) -> Result<Answer, Failure> {
        self.edit_checks(&levels)?;
        let mut kept: Vec<(String, HashSet<NodeId>, NodeId)> = Vec::new();
        let result = self.edit_levels(&levels, chord, &mut kept);
        if result.is_err() {
            for (key, fresh, previous) in kept {
                if let Some(doc) = self.docs.get_mut(&key) {
                    doc.nodes.retain(|node, _| !fresh.contains(node));
                    doc.current = previous;
                }
                self.replies
                    .retain(|reply| reply.key != key || !fresh.contains(&reply.node));
            }
        }
        result
    }

    /// Everything an edit refuses before it builds: ids already taken, a `root` step out of place, a join that loops, a
    /// tool tree or step this engine lacks, and a tool edit that does not feed the join above it.
    fn edit_checks(&self, levels: &[ToolEdit]) -> Result<(), Failure> {
        let last = levels.len() - 1;
        let mut trees = HashSet::new();
        for (at, level) in levels.iter().enumerate() {
            if !trees.insert(level.key.as_str()) {
                return Err(Failure::Message("One edit changes each tree once".into()));
            }
            let held = self.docs.get(&level.key);
            let Some(doc) = held.filter(|doc| doc.nodes.contains_key(&level.parent)) else {
                // The tree's own parent missing is for the client to restore; a tool tree comes back as a tool does.
                if at == last {
                    return Err(Failure::Missing(vec![if held.is_some() {
                        level.parent
                    } else {
                        ROOT
                    }]));
                }
                return Err(Failure::ToolMissing {
                    node: None,
                    key: level.key.clone(),
                    step: level.parent,
                });
            };
            let mut fresh = HashSet::new();
            for new in level.ids() {
                if new == ROOT || doc.nodes.contains_key(&new) || !fresh.insert(new) {
                    return Err(Failure::Message(format!(
                        "Node {new} is already in this tree for another step"
                    )));
                }
            }
            root_placement(level.parent, &level.op).map_err(Failure::Message)?;
            if level
                .replay
                .iter()
                .any(|step| matches!(step.op, Op::Root { .. }))
            {
                return Err(Failure::Message(ROOT_ONLY.into()));
            }
            let fed = at.checked_sub(1).map(|below| &levels[below]);
            if let Some(below) = fed {
                let feeds = matches!(&level.op, Op::Join { tool, .. } if tool.key == below.key && tool.node == below.tip());
                if !feeds {
                    return Err(Failure::Message(
                        "Each tool tree's edit must feed the join above it".into(),
                    ));
                }
            }
            for (index, op) in std::iter::once(&level.op)
                .chain(level.replay.iter().map(|step| &step.op))
                .enumerate()
            {
                self.join_refusal(&level.key, op)?;
                // The join fed from below takes a step this edit makes.
                if !(index == 0 && fed.is_some()) {
                    self.tool_held(op)?;
                }
            }
        }
        Ok(())
    }

    /// Each level in turn, deepest first: its parent built, its op, then its replay. `kept` gets each tree's new ids and
    /// the node it showed, as soon as anything of it may be kept, so a failure can take them all back.
    fn edit_levels(
        &mut self,
        levels: &[ToolEdit],
        chord: f64,
        kept: &mut Vec<(String, HashSet<NodeId>, NodeId)>,
    ) -> Result<Answer, Failure> {
        let last = levels.len() - 1;
        let mut tools = Vec::new();
        let mut below: Option<Tip> = None;
        for (at, level) in levels.iter().enumerate() {
            let key = level.key.as_str();
            let own = at == last;
            let replayed = match self.ensure(key, level.parent) {
                Ok(count) => count,
                Err(failure) if own => return Err(failure),
                Err(Failure::Broken { message, .. }) => {
                    return Err(Failure::Message(format!(
                        "The tool object's step could not be rebuilt: {message}"
                    )))
                }
                Err(Failure::Missing(_)) => {
                    return Err(Failure::ToolMissing {
                        node: None,
                        key: key.to_string(),
                        step: level.parent,
                    })
                }
                Err(failure) => return Err(failure),
            };
            let first = match &below {
                // The tool step this join takes did not build, so neither does the join: it is kept broken.
                Some(Err(message)) => Err((
                    level.op.clone(),
                    format!("The tool object's step could not be rebuilt: {message}"),
                )),
                _ => Ok(self.edited(key, level.parent, &level.op)?),
            };
            let previous = doc_in(&mut self.docs, key)?.current;
            kept.push((key.to_string(), level.ids().collect(), previous));
            let replay = level
                .replay
                .iter()
                .map(|step| (step.id, step.op.clone()))
                .collect();
            let (tip, built, broken) = self.fork(key, level.parent, level.node, first, replay)?;
            if !own {
                let mut part = json!({ "key": key, "built": built });
                if let Some((node, error)) = &broken {
                    part["broken"] = json!({ "id": node, "error": error });
                }
                tools.push(part);
                below = Some(match broken {
                    None => Ok(tip),
                    Some((_, error)) => Err(error),
                });
                continue;
            }
            doc_in(&mut self.docs, key)?.current = tip;
            let text = self.reply(key, tip, chord)?;
            let mut fields = vec![
                (
                    "built",
                    Part::Json(serde_json::Value::Array(built).to_string()),
                ),
                ("replayed", Part::Json(replayed.to_string())),
            ];
            if let Some((node, error)) = broken {
                fields.push((
                    "broken",
                    Part::Json(json!({ "id": node, "error": error }).to_string()),
                ));
            }
            if !tools.is_empty() {
                fields.push((
                    "tools",
                    Part::Json(serde_json::Value::Array(tools).to_string()),
                ));
            }
            return Ok(Answer::Held {
                key: key.to_string(),
                text,
                fields,
            });
        }
        unreachable!("an edit has its own tree last")
    }

    /// The edited op built on `parent`, which holds its solid: a kept probe of it if there is one, as Apply takes it.
    fn edited(&mut self, key: &str, parent: NodeId, op: &Op) -> Result<Built, Failure> {
        let steps = self.step_edges(key, parent, op)?;
        let (op, reused) = {
            let doc = doc_in(&mut self.docs, key)?;
            let probed = doc.probe.take();
            let from = doc.shape(parent);
            from.editable().map_err(Failure::Message)?;
            let op = resolve(from, op, &steps).map_err(Failure::Message)?;
            match probed {
                Some(probed) if probed.parent == parent && same_build(&probed.op, &op.op) => {
                    (op, Some(probed.built))
                }
                _ => (op, None),
            }
        };
        match reused {
            Some(reused) => Ok(Built { op: op.op, ..reused }),
            None => {
                let tool = self.join_tool(key, &op.op)?;
                let from = doc_in(&mut self.docs, key)?.shape(parent);
                build(from, op, false, tool).map_err(|(message, _)| Failure::Message(message))
            }
        }
    }

    /// The new branch of an edit: its first step kept as `id` under `parent`, built or broken, then each replayed step
    /// on the last that built, until one fails; it and the rest are kept unbuilt, it marked broken. Returns the last step
    /// that built (`parent` when the first did not), each built step as stored, and the broken step with why.
    fn fork(
        &mut self,
        key: &str,
        parent: NodeId,
        id: NodeId,
        first: Result<Built, (Op, String)>,
        replay: Vec<(NodeId, Op)>,
    ) -> Result<Forked, Failure> {
        let mut built = Vec::new();
        let mut broken: Option<(NodeId, String)> = None;
        // The last step that built, and the last step kept, built or not.
        let (mut last, mut tail) = (parent, id);
        match first {
            Ok(first) => {
                built.push(self.keep(key, parent, id, first)?);
                last = id;
            }
            Err((op, message)) => {
                doc_in(&mut self.docs, key)?.insert(id, parent, op)?.broken = Some(message.clone());
                broken = Some((id, message));
            }
        }
        for (step, op) in replay {
            if broken.is_none() {
                match self.replay_step(key, last, &op) {
                    Ok(done) => {
                        built.push(self.keep(key, last, step, done)?);
                        last = step;
                        tail = step;
                        continue;
                    }
                    Err(Failure::Message(message)) => broken = Some((step, message)),
                    Err(failure) => return Err(failure),
                }
            }
            let node = doc_in(&mut self.docs, key)?.insert(step, tail, op)?;
            if let Some((_, message)) = broken.as_ref().filter(|(at, _)| *at == step) {
                node.broken = Some(message.clone());
            }
            tail = step;
        }
        Ok((last, built, broken))
    }

    /// One replayed step built on node `from`, which holds its solid. A step that cannot be built is a `Message`; a
    /// tool tree this engine lacks stays `ToolMissing`, so the client opens it and the whole edit is asked again.
    fn replay_step(&mut self, key: &str, from: NodeId, op: &Op) -> Result<Built, Failure> {
        let tool = self.join_tool(key, op)?;
        let steps = self.step_edges(key, from, op)?;
        let from = doc_in(&mut self.docs, key)?.shape(from);
        let op = resolve(from, op, &steps).map_err(Failure::Message)?;
        build(from, op, false, tool).map_err(|(message, _)| Failure::Message(message))
    }

    /// Keep `built` as node `id` under `parent`, as an apply does: its solid, its fingerprint, and its op as stored.
    fn keep(
        &mut self,
        key: &str,
        parent: NodeId,
        id: NodeId,
        built: Built,
    ) -> Result<serde_json::Value, Failure> {
        let fingerprint = built.kept.fingerprint();
        let stored = json!({ "id": id, "op": built.op, "fingerprint": fingerprint });
        self.clock += 1;
        let node = doc_in(&mut self.docs, key)?.insert(id, parent, built.op)?;
        node.fingerprint = Some(fingerprint);
        node.shape = Some(built.kept);
        node.used = self.clock;
        Ok(stored)
    }

    /// A join's tool step when this engine does not hold it, as `ToolMissing`, before anything is built.
    fn tool_held(&self, op: &Op) -> Result<(), Failure> {
        let Op::Join { tool, .. } = op else {
            return Ok(());
        };
        if self
            .docs
            .get(&tool.key)
            .is_some_and(|doc| doc.nodes.contains_key(&tool.node))
        {
            return Ok(());
        }
        Err(Failure::ToolMissing {
            node: None,
            key: tool.key.clone(),
            step: tool.node,
        })
    }

    /// The solid a join takes from its tool tree, or None for any other op.
    fn join_tool(&mut self, key: &str, op: &Op) -> Result<Option<ToolSolid>, Failure> {
        match op {
            Op::Join { tool, .. } => self.tool_solid(key, tool, &mut Vec::new()).map(Some),
            _ => Ok(None),
        }
    }

    /// Remove `id` and everything under it. The current node moves to `id`'s parent if it was inside.
    fn drop_branch(&mut self, key: String, id: NodeId) -> Result<Answer, Failure> {
        if id == ROOT {
            return Err(Failure::Message(
                "The root cannot be dropped. Close the tree instead.".into(),
            ));
        }
        let doc = doc_in(&mut self.docs, &key)?;
        let parent = doc.node(id)?.parent.expect("only the root has no parent");
        let gone = doc.subtree(id);
        if self.names_tool(&key, Some(&gone)) {
            return Err(Failure::Message(
                "A step of another part's history uses a step of this branch as its tool, so it cannot be deleted"
                    .into(),
            ));
        }
        let doc = doc_in(&mut self.docs, &key)?;
        doc.nodes.retain(|node, _| !gone.contains(node));
        if gone.contains(&doc.current) {
            doc.current = parent;
        }
        if doc
            .probe
            .as_ref()
            .is_some_and(|probe| gone.contains(&probe.parent))
        {
            doc.probe = None;
        }
        let current = doc.current;
        self.replies
            .retain(|reply| reply.key != key || !gone.contains(&reply.node));
        let mut dropped: Vec<NodeId> = gone.into_iter().collect();
        dropped.sort_unstable();
        Ok(Answer::Held {
            key,
            text: Arc::new(json!({ "dropped": dropped, "current": current }).to_string()),
            fields: Vec::new(),
        })
    }

    fn evict(&mut self) {
        let mut loose: Vec<(u64, String, NodeId)> = Vec::new();
        for (key, doc) in &self.docs {
            let pinned = doc.pinned();
            for (id, node) in &doc.nodes {
                if node.shape.is_some() && !pinned.contains(id) {
                    loose.push((node.used, key.clone(), *id));
                }
            }
        }
        if loose.len() > self.limits.shapes {
            loose.sort_unstable_by_key(|(used, _, _)| *used);
            let excess = loose.len() - self.limits.shapes;
            for (_, key, id) in loose.into_iter().take(excess) {
                if let Some(node) = self
                    .docs
                    .get_mut(&key)
                    .and_then(|doc| doc.nodes.get_mut(&id))
                {
                    node.shape = None;
                }
            }
        }
        if self.replies.len() > self.limits.replies {
            self.replies
                .sort_unstable_by_key(|reply| std::cmp::Reverse(reply.used));
            self.replies.truncate(self.limits.replies);
        }
    }
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
    let shape = Shape::read_brep(&bytes)?;
    let got = shape.fingerprint();
    if let Some(expected) = node.fingerprint {
        if !expected.matches(&got) {
            return Err(rebuilt_differently(&got, &expected));
        }
    }
    let node = doc.nodes.get_mut(&seed.node).expect("checked above");
    node.fingerprint = Some(got);
    node.shape = Some(shape);
    node.seeded = true;
    node.used = used;
    Ok(())
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
    match (data_b64, step_path, primitive) {
        (Some(data), None, None) => {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(data.trim())
                .map_err(|err| Failure::Message(err.to_string()))?;
            if bytes.starts_with(BREP_MAGIC) {
                return Shape::read_brep(&bytes).map_err(Failure::Message);
            }
            let path = temp_step("open");
            std::fs::write(&path, bytes).map_err(|err| Failure::Message(err.to_string()))?;
            let shape = Shape::read_step(&path);
            let _ = std::fs::remove_file(&path);
            shape.map_err(Failure::Message)
        }
        (None, Some(path), None) => {
            Shape::read_step(std::path::Path::new(&path)).map_err(Failure::Message)
        }
        (None, None, Some(solid)) => Shape::primitive(&solid).map_err(Failure::Message),
        _ => Err(one_root()),
    }
}

fn one_root() -> Failure {
    Failure::Message("Open a tree from exactly one of dataB64, stepPath, box, or primitive".into())
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

/// The edges each step a blend takes edges from made, by that step's id.
type Steps = HashMap<NodeId, Vec<EdgeRef>>;

const NOT_ABOVE: &str = "A blend can only take edges from this step's parent or a step above it.";

/// Whether `op` takes edges from an earlier step, which must be read before it builds.
fn picks_steps(op: &Op) -> bool {
    matches!(op, Op::Fillet { edges, .. } | Op::Chamfer { edges, .. }
        if edges.iter().any(|pick| matches!(pick, EdgePick::Step(_))))
}

/// An op as the tree stores it, and the kernel indexes it is built with: a blend's edges or a shell's open faces,
/// on the solid it is built from.
struct Resolved {
    op: Op,
    picks: Vec<c_int>,
}

/// Turn every edge or face pick into a reference on `from`: the index when its midpoint and size still
/// agree, else the one that matches them. A step's edges are found on `from` by midpoint and length and
/// kept by `filter`; the op keeps the step pick as sent. Other ops pass through.
fn resolve(from: &mut Shape, op: &Op, steps: &Steps) -> Result<Resolved, String> {
    match op {
        Op::Fillet { edges, size } => resolve_blend(from, edges, *size, false, steps),
        Op::Chamfer { edges, size } => resolve_blend(from, edges, *size, true, steps),
        Op::Shell {
            thickness,
            open_faces,
        } => resolve_shell(from, open_faces, *thickness),
        _ => Ok(Resolved {
            op: op.clone(),
            picks: Vec::new(),
        }),
    }
}

fn resolve_blend(
    from: &mut Shape,
    edges: &[EdgePick],
    size: f64,
    chamfer: bool,
    steps: &Steps,
) -> Result<Resolved, String> {
    let verb = if chamfer { "chamfer" } else { "fillet" };
    let mut refs: Vec<EdgePick> = Vec::with_capacity(edges.len());
    let mut picks: Vec<c_int> = Vec::new();
    // Every edge of `from`, read once, the first time a step pick needs to look for one.
    let mut every: Option<Vec<EdgeRef>> = None;
    for pick in edges {
        let found = match *pick {
            EdgePick::Index(index) if index < 0 && edges.len() == 1 => {
                return Err(format!("Pick an edge to {verb}."))
            }
            EdgePick::Index(index) => from.edge(index),
            EdgePick::Ref(want) => match from.edge(want.index) {
                Some(have) if same_edge(&have, &want) => Some(have),
                _ => from.find_edge(&want)?,
            },
            EdgePick::Step(step) => {
                let made = steps.get(&step.from_node).ok_or(NOT_ABOVE)?;
                let every = every.get_or_insert_with(|| from.all_edges());
                let mut found: Vec<c_int> = Vec::new();
                for want in made {
                    let at = usize::try_from(want.index).ok();
                    match at.and_then(|at| every.get(at)) {
                        Some(have) if same_edge(have, want) => found.push(have.index),
                        _ => found.extend(
                            every
                                .iter()
                                .filter(|have| same_edge(have, want))
                                .map(|have| have.index),
                        ),
                    }
                }
                found.sort_unstable();
                found.dedup();
                let kinds = from.edge_kinds(&found)?;
                let filter = step.filter.unwrap_or_default();
                let mut any = false;
                for (index, kind) in found.into_iter().zip(kinds) {
                    let keep = match filter {
                        EdgeFilter::All => kind != 0,
                        EdgeFilter::Convex => kind == 1,
                        EdgeFilter::Concave => kind == 2,
                    };
                    if keep {
                        any = true;
                        if !picks.contains(&index) {
                            picks.push(index);
                        }
                    }
                }
                if !any {
                    let which = match filter {
                        EdgeFilter::All => "sharp",
                        EdgeFilter::Convex => "convex",
                        EdgeFilter::Concave => "concave",
                    };
                    return Err(format!(
                        "Step {} left no {which} edges on this solid to {verb}.",
                        step.from_node
                    ));
                }
                if !refs.contains(pick) {
                    refs.push(*pick);
                }
                continue;
            }
        };
        let found = found.ok_or_else(|| "That edge is not on this solid".to_string())?;
        if !found.mid.iter().all(|value| value.is_finite()) || !found.length_mm.is_finite() {
            return Err("Open CASCADE could not measure that edge".into());
        }
        if !refs
            .iter()
            .any(|have| matches!(have, EdgePick::Ref(have) if have.index == found.index))
        {
            refs.push(EdgePick::Ref(found));
        }
        if !picks.contains(&found.index) {
            picks.push(found.index);
        }
    }
    if picks.is_empty() {
        return Err(format!("Pick an edge to {verb}."));
    }
    let op = if chamfer {
        Op::Chamfer { edges: refs, size }
    } else {
        Op::Fillet { edges: refs, size }
    };
    Ok(Resolved { op, picks })
}

fn resolve_shell(from: &mut Shape, faces: &[FacePick], thickness: f64) -> Result<Resolved, String> {
    let mut refs: Vec<FacePick> = Vec::with_capacity(faces.len());
    let mut picks: Vec<c_int> = Vec::new();
    for pick in faces {
        let found = match *pick {
            FacePick::Index(index) => from.face(index),
            FacePick::Ref(want) => match from.face(want.index) {
                Some(have) if same_face(&have, &want) => Some(have),
                _ => from.find_face(&want)?,
            },
        };
        let found = found.ok_or_else(|| "That face is not on this solid.".to_string())?;
        if !found.mid.iter().all(|value| value.is_finite()) || !found.area_mm2.is_finite() {
            return Err("Open CASCADE could not measure that face".into());
        }
        if !picks.contains(&found.index) {
            picks.push(found.index);
            refs.push(FacePick::Ref(found));
        }
    }
    Ok(Resolved {
        op: Op::Shell {
            thickness,
            open_faces: refs,
        },
        picks,
    })
}

/// The probe's measures of what it built, and of the solid it was built on, as JSON fields without braces.
fn probe_metrics(from: &Shape, built: &Shape) -> String {
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

/// Whether `incoming` asks for the op `stored` already is. A stored edge matches an index pick by
/// index and a reference by midpoint and length, since a rebuild may have renumbered it.
fn same_request(stored: &Op, incoming: &Op) -> bool {
    let (stored_edges, incoming_edges) = match (stored, incoming) {
        (Op::Fillet { edges: a, size: x }, Op::Fillet { edges: b, size: y })
        | (Op::Chamfer { edges: a, size: x }, Op::Chamfer { edges: b, size: y })
            if x == y && a.len() == b.len() =>
        {
            (a, b)
        }
        (Op::Fillet { .. } | Op::Chamfer { .. }, _) => return false,
        (
            Op::Shell {
                thickness: x,
                open_faces: a,
            },
            Op::Shell {
                thickness: y,
                open_faces: b,
            },
        ) => {
            return x == y
                && a.len() == b.len()
                && a.iter().zip(b).all(|pair| match pair {
                    (FacePick::Ref(have), FacePick::Index(index)) => have.index == *index,
                    (FacePick::Ref(have), FacePick::Ref(want)) => same_face(have, want),
                    (have, want) => have == want,
                })
        }
        _ => return stored == incoming,
    };
    stored_edges
        .iter()
        .zip(incoming_edges)
        .all(|pair| match pair {
            (EdgePick::Ref(have), EdgePick::Index(index)) => have.index == *index,
            (EdgePick::Ref(have), EdgePick::Ref(want)) => same_edge(have, want),
            (have, want) => have == want,
        })
}

/// Whether two resolved ops build the same solid. A join's `keepTool` is the plate's business, and its
/// tool's `object` and `name` only label it.
fn same_build(a: &Op, b: &Op) -> bool {
    match (a, b) {
        (
            Op::Join {
                op: x,
                tool: t,
                relative: r,
                ..
            },
            Op::Join {
                op: y,
                tool: u,
                relative: q,
                ..
            },
        ) => x == y && t.key == u.key && t.node == u.node && r == q,
        _ => a == b,
    }
}

fn same_face(a: &FaceRef, b: &FaceRef) -> bool {
    let d = (0..3)
        .map(|i| (a.mid[i] - b.mid[i]).powi(2))
        .sum::<f64>()
        .sqrt();
    d <= EDGE_MATCH_MM && (a.area_mm2 - b.area_mm2).abs() <= EDGE_MATCH_MM * a.area_mm2.abs().max(1.0)
}

fn same_edge(a: &EdgeRef, b: &EdgeRef) -> bool {
    let d = (0..3)
        .map(|i| (a.mid[i] - b.mid[i]).powi(2))
        .sum::<f64>()
        .sqrt();
    d <= EDGE_MATCH_MM && (a.length_mm - b.length_mm).abs() <= EDGE_MATCH_MM
}

struct Built {
    op: Op,
    kept: Shape,
    other: Option<Shape>,
}

/// Another tree's solid, for one join, as the kernel takes it. Sound for the call it was taken in:
/// nothing is evicted before the call ends, a node that holds its solid keeps that same solid for
/// the whole call, a tool is never the tree being built, and a failure drops the map of these
/// before any is used.
#[derive(Clone, Copy)]
struct ToolSolid(*const RawShape);

/// Run a resolved op on `from`. With `probe`, a fillet or chamfer that does not fit also reports
/// the largest size that does. A join takes its tool's solid in `tool`.
fn build(
    from: &Shape,
    resolved: Resolved,
    probe: bool,
    tool: Option<ToolSolid>,
) -> Result<Built, (String, Option<f64>)> {
    let Resolved { op, picks } = resolved;
    let mut other = None;
    let kept = match &op {
        Op::Join {
            op: which,
            relative,
            ..
        } => {
            let Some(ToolSolid(solid)) = tool else {
                return Err(("The tool object's solid is missing".into(), None));
            };
            let place = relative.rigid().map_err(|message| (message, None))?;
            // SAFETY: `solid` is a tool tree's held solid, alive for this call (`ToolSolid`).
            Shape::made(|error| unsafe {
                lime_tree_join(
                    from.raw(),
                    solid,
                    which.name().as_ptr(),
                    place.as_ptr(),
                    error,
                )
            })
        }
        Op::Boolean { op: which, tool } => {
            let which = which.name();
            let p = tool.numbers();
            Shape::made(|error| unsafe {
                lime_tree_boolean(
                    from.raw(),
                    which.as_ptr(),
                    tool.primitive.name().as_ptr(),
                    p.as_ptr(),
                    error,
                )
            })
        }
        Op::Hole {
            origin,
            axis,
            radius,
            depth,
            through,
            counterbore_radius,
            counterbore_depth,
        } => {
            let bore = counterbore_radius.is_some() || counterbore_depth.is_some();
            let p = [
                origin[0],
                origin[1],
                origin[2],
                axis[0],
                axis[1],
                axis[2],
                *radius,
                *depth,
                f64::from(u8::from(*through)),
                f64::from(u8::from(bore)),
                counterbore_radius.unwrap_or(0.0),
                counterbore_depth.unwrap_or(0.0),
            ];
            Shape::made(|error| unsafe { lime_tree_hole(from.raw(), p.as_ptr(), error) })
        }
        Op::Split { origin, normal } => {
            let p = [
                origin[0], origin[1], origin[2], normal[0], normal[1], normal[2],
            ];
            let mut piece: *mut RawShape = std::ptr::null_mut();
            let kept = Shape::made(|error| unsafe {
                lime_tree_split(from.raw(), p.as_ptr(), &mut piece, error)
            });
            other = NonNull::new(piece).map(Shape);
            kept
        }
        Op::Fillet { size, .. } | Op::Chamfer { size, .. } => {
            let chamfer = matches!(op, Op::Chamfer { .. });
            let indexes = &picks;
            let mut max_mm = 0.0;
            let max_ptr: *mut f64 = if probe {
                &mut max_mm
            } else {
                std::ptr::null_mut()
            };
            let built = Shape::made(|error| unsafe {
                lime_tree_blend(
                    from.raw(),
                    indexes.as_ptr(),
                    indexes.len() as c_int,
                    *size,
                    c_int::from(chamfer),
                    max_ptr,
                    error,
                )
            });
            return match built {
                Ok(kept) => Ok(Built {
                    op,
                    kept,
                    other: None,
                }),
                Err(message) => Err((message, probe.then_some(max_mm))),
            };
        }
        Op::Scale { factor } => {
            Shape::made(|error| unsafe { lime_tree_scale(from.raw(), *factor, error) })
        }
        Op::Root { solid } => Shape::primitive(solid),
        Op::Extrude {
            op: which,
            origin,
            turn,
            profile,
            depth,
            symmetric,
            smooth,
            corners,
        } => {
            let mut p = vec![
                origin[0],
                origin[1],
                origin[2],
                turn[0],
                turn[1],
                turn[2],
                *depth,
                f64::from(u8::from(*symmetric)),
            ];
            push_shape(&mut p, *smooth, corners);
            let points: Vec<f64> = profile.iter().flatten().copied().collect();
            Shape::made(|error| unsafe {
                lime_tree_extrude(
                    from.raw(),
                    which.name().as_ptr(),
                    p.as_ptr(),
                    points.as_ptr(),
                    profile.len() as c_int,
                    error,
                )
            })
        }
        Op::Revolve {
            op: which,
            origin,
            turn,
            profile,
            axis_origin,
            axis_dir,
            angle_deg,
            smooth,
            corners,
        } => {
            let [au, av] = axis_origin.unwrap_or([0.0, 0.0]);
            let [du, dv] = axis_dir.unwrap_or([0.0, 1.0]);
            let mut p = vec![
                origin[0],
                origin[1],
                origin[2],
                turn[0],
                turn[1],
                turn[2],
                au,
                av,
                du,
                dv,
                angle_deg.unwrap_or(360.0),
            ];
            push_shape(&mut p, *smooth, corners);
            let points: Vec<f64> = profile.iter().flatten().copied().collect();
            Shape::made(|error| unsafe {
                lime_tree_revolve(
                    from.raw(),
                    which.name().as_ptr(),
                    p.as_ptr(),
                    points.as_ptr(),
                    profile.len() as c_int,
                    error,
                )
            })
        }
        Op::Loft {
            op: which,
            sections,
            ruled,
        } => {
            let mut head = Vec::with_capacity(sections.len() * 11);
            let mut data = Vec::new();
            for section in sections {
                head.extend_from_slice(&section.origin);
                head.extend_from_slice(&section.turn);
                head.push(section.radius.unwrap_or(0.0));
                head.push(section.radius_v.unwrap_or(0.0));
                head.push(f64::from(u8::from(section.smooth)));
                head.push(section.profile.len() as f64);
                head.push(section.corners.len() as f64);
                data.extend(section.profile.iter().flatten().copied());
                data.extend(section.corners.iter().map(|&c| f64::from(c)));
            }
            Shape::made(|error| unsafe {
                lime_tree_loft(
                    from.raw(),
                    which.name().as_ptr(),
                    head.as_ptr(),
                    sections.len() as c_int,
                    data.as_ptr(),
                    c_int::from(*ruled),
                    error,
                )
            })
        }
        Op::Shell { thickness, .. } => Shape::made(|error| unsafe {
            lime_tree_shell(
                from.raw(),
                picks.as_ptr(),
                picks.len() as c_int,
                *thickness,
                error,
            )
        }),
    };
    match kept {
        Ok(kept) => Ok(Built { op, kept, other }),
        Err(message) => Err((message, None)),
    }
}

#[repr(C)]
struct RawShape {
    _opaque: [u8; 0],
}

#[repr(C)]
struct RawMesh {
    _opaque: [u8; 0],
}

/// `LimeMeshView` in tree.cpp: a mesh's arrays as bytes, until the mesh is freed, and the shape's
/// description as JSON, for as long as the shape lives.
#[repr(C)]
struct MeshView {
    positions: *const u8,
    positions_bytes: usize,
    triangles: *const u8,
    triangles_bytes: usize,
    edge_points: *const u8,
    edge_points_bytes: usize,
    edge_offsets: *const u8,
    edge_offsets_bytes: usize,
    meta: *const c_char,
}

extern "C" {
    fn lime_tree_free(shape: *mut RawShape);
    fn lime_tree_primitive(
        kind: *const c_char,
        p: *const f64,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    fn lime_tree_read_step(path: *const c_char, error: *mut *mut c_char) -> *mut RawShape;
    fn lime_tree_read_brep(
        data: *const u8,
        size: usize,
        volume: f64,
        created: *const c_int,
        count: c_int,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    fn lime_tree_write_brep(
        shape: *const RawShape,
        size: *mut usize,
        error: *mut *mut c_char,
    ) -> *mut c_char;
    fn lime_tree_occt_version() -> *const c_char;
    fn lime_tree_boolean(
        from: *const RawShape,
        op: *const c_char,
        primitive: *const c_char,
        p: *const f64,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    fn lime_tree_join(
        from: *const RawShape,
        tool: *const RawShape,
        op: *const c_char,
        place: *const f64,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    fn lime_tree_hole(
        from: *const RawShape,
        p: *const f64,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    fn lime_tree_blend(
        from: *const RawShape,
        edges: *const c_int,
        count: c_int,
        size: f64,
        chamfer: c_int,
        max_mm: *mut f64,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    fn lime_tree_split(
        from: *const RawShape,
        p: *const f64,
        other: *mut *mut RawShape,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    fn lime_tree_scale(
        from: *const RawShape,
        factor: f64,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    fn lime_tree_extrude(
        from: *const RawShape,
        op: *const c_char,
        p: *const f64,
        points: *const f64,
        count: c_int,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    fn lime_tree_revolve(
        from: *const RawShape,
        op: *const c_char,
        p: *const f64,
        points: *const f64,
        count: c_int,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    fn lime_tree_loft(
        from: *const RawShape,
        op: *const c_char,
        head: *const f64,
        count: c_int,
        data: *const f64,
        ruled: c_int,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    fn lime_tree_pieces(from: *const RawShape, built: *const RawShape) -> *mut c_char;
    fn lime_tree_shell(
        from: *const RawShape,
        faces: *const c_int,
        count: c_int,
        thickness: f64,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    fn lime_tree_created(shape: *const RawShape, out: *mut *const c_int) -> c_int;
    fn lime_tree_edge_kinds(
        shape: *const RawShape,
        edges: *const c_int,
        count: c_int,
        out: *mut c_int,
    ) -> c_int;
    fn lime_tree_counts(shape: *const RawShape, solids: *mut c_int, shells: *mut c_int);
    fn lime_tree_face(shape: *mut RawShape, index: c_int, mid: *mut f64, area: *mut f64)
        -> c_int;
    fn lime_tree_editable(shape: *const RawShape, error: *mut *mut c_char) -> c_int;
    fn lime_tree_fingerprint(
        shape: *const RawShape,
        volume: *mut f64,
        faces: *mut c_int,
        edges: *mut c_int,
    );
    fn lime_tree_edge(shape: *mut RawShape, index: c_int, mid: *mut f64, length: *mut f64)
        -> c_int;
    fn lime_tree_mesh(
        shape: *mut RawShape,
        chord: f64,
        view: *mut MeshView,
        error: *mut *mut c_char,
    ) -> *mut RawMesh;
    fn lime_tree_mesh_free(mesh: *mut RawMesh);
    fn lime_tree_distance(
        shape: *const RawShape,
        a_kind: *const c_char,
        a_index: c_int,
        b_kind: *const c_char,
        b_index: c_int,
        out: *mut f64,
        error: *mut *mut c_char,
    ) -> c_int;
    fn lime_tree_write_step(
        shape: *const RawShape,
        path: *const c_char,
        error: *mut *mut c_char,
    ) -> c_int;
    fn lime_model_occt_string_free(text: *mut c_char);
}

/// One solid owned by the kernel. Freed when dropped.
struct Shape(NonNull<RawShape>);

/// One tessellation owned by the kernel, while its reply is written.
struct Mesh(NonNull<RawMesh>);

impl Mesh {
    /// Bytes the mesh's view points at, borrowed for as long as the mesh lives.
    ///
    /// # Safety
    /// `ptr` and `len` are one array of the `MeshView` that `lime_tree_mesh` filled with this mesh.
    unsafe fn bytes(&self, ptr: *const u8, len: usize) -> &[u8] {
        if len == 0 {
            return &[];
        }
        unsafe { std::slice::from_raw_parts(ptr, len) }
    }
}

impl Drop for Mesh {
    fn drop(&mut self) {
        unsafe { lime_tree_mesh_free(self.0.as_ptr()) };
    }
}

// The store lock serialises every use, and a shape is never shared between nodes.
unsafe impl Send for Shape {}

impl Drop for Shape {
    fn drop(&mut self) {
        unsafe { lime_tree_free(self.0.as_ptr()) };
    }
}

/// A profile's smooth flag, its corner count, and its corners, after an op's own numbers.
fn push_shape(p: &mut Vec<f64>, smooth: bool, corners: &[u32]) {
    p.push(f64::from(u8::from(smooth)));
    p.push(corners.len() as f64);
    p.extend(corners.iter().map(|&c| f64::from(c)));
}

fn take_text(ptr: *mut c_char) -> Option<String> {
    let ptr = NonNull::new(ptr)?;
    let text = unsafe { CStr::from_ptr(ptr.as_ptr()) }
        .to_string_lossy()
        .into_owned();
    unsafe { lime_model_occt_string_free(ptr.as_ptr()) };
    Some(text)
}

fn c_path(path: &std::path::Path) -> Result<CString, String> {
    let text = path.to_str().ok_or("STEP path is not UTF-8")?;
    CString::new(text).map_err(|_| "STEP path is not a C string".to_string())
}

impl Shape {
    fn raw(&self) -> *const RawShape {
        self.0.as_ptr()
    }

    fn made(run: impl FnOnce(*mut *mut c_char) -> *mut RawShape) -> Result<Shape, String> {
        let mut error: *mut c_char = std::ptr::null_mut();
        let shape = run(&mut error);
        let message = take_text(error);
        match NonNull::new(shape) {
            Some(shape) => Ok(Shape(shape)),
            None => Err(message.unwrap_or_else(|| "Open CASCADE failed".into())),
        }
    }

    fn primitive(solid: &Solid) -> Result<Shape, String> {
        let p = solid.numbers();
        Shape::made(|error| unsafe {
            lime_tree_primitive(solid.primitive.name().as_ptr(), p.as_ptr(), error)
        })
    }

    fn read_step(path: &std::path::Path) -> Result<Shape, String> {
        let path = c_path(path)?;
        Shape::made(|error| unsafe { lime_tree_read_step(path.as_ptr(), error) })
    }

    /// A solid `brep_bytes` wrote: the same faces and edges, in the same order, as the step it was saved from.
    /// Bytes another Open CASCADE wrote are read as well; BinTools reads every older format.
    fn read_brep(bytes: &[u8]) -> Result<Shape, String> {
        let damaged = || "This saved solid is damaged".to_string();
        let end = bytes.iter().position(|&b| b == b'\n').ok_or_else(damaged)?;
        let header = std::str::from_utf8(&bytes[..end]).map_err(|_| damaged())?;
        let fields: Vec<&str> = header.split(' ').collect();
        let [_, format, occt, volume, created] = fields[..] else {
            return Err(damaged());
        };
        if format != BREP_FORMAT {
            return Err(format!(
                "This solid was saved in format {format}, which this modeler does not read"
            ));
        }
        let volume: f64 = volume.parse().map_err(|_| damaged())?;
        // `*` is every edge (a root, or a solid read from a file); else the edges its step made, by index.
        let created: Option<Vec<c_int>> = match created {
            "*" => None,
            "" | "-" => Some(Vec::new()),
            list => Some(
                list.split(',')
                    .map(|index| index.parse().map_err(|_| damaged()))
                    .collect::<Result<_, _>>()?,
            ),
        };
        let (made, count) = created.as_ref().map_or((std::ptr::null(), -1), |list| {
            (list.as_ptr(), list.len() as c_int)
        });
        let data = &bytes[end + 1..];
        Shape::made(|error| unsafe {
            lime_tree_read_brep(data.as_ptr(), data.len(), volume, made, count, error)
        })
        .map_err(|message| {
            let ours = occt_version();
            if occt == ours {
                message
            } else {
                format!("{message} (saved by Open CASCADE {occt}, this modeler has {ours})")
            }
        })
    }

    /// The solid as a project keeps it: a header line with the volume its step integrated, so a read
    /// integrates nothing and its fingerprint is the step's, then Open CASCADE's binary format.
    fn brep_bytes(&self) -> Result<Vec<u8>, String> {
        let mut size = 0usize;
        let mut error: *mut c_char = std::ptr::null_mut();
        let raw = unsafe { lime_tree_write_brep(self.raw(), &mut size, &mut error) };
        let message = take_text(error);
        let Some(raw) = NonNull::new(raw) else {
            return Err(message.unwrap_or_else(|| "Open CASCADE did not write this solid".into()));
        };
        let created = self.created_indexes();
        let created = if created.len() == self.fingerprint().edges as usize
            && created
                .iter()
                .enumerate()
                .all(|(i, &index)| i as c_int == index)
        {
            "*".to_string()
        } else if created.is_empty() {
            "-".to_string()
        } else {
            created
                .iter()
                .map(c_int::to_string)
                .collect::<Vec<_>>()
                .join(",")
        };
        let header = format!(
            "{}{BREP_FORMAT} {} {} {created}\n",
            std::str::from_utf8(BREP_MAGIC).expect("ASCII"),
            occt_version(),
            self.fingerprint().volume_mm3
        );
        let mut out = Vec::with_capacity(header.len() + size);
        out.extend_from_slice(header.as_bytes());
        // SAFETY: the kernel wrote `size` bytes there; they are copied before the buffer is freed.
        out.extend_from_slice(unsafe {
            std::slice::from_raw_parts(raw.as_ptr().cast::<u8>(), size)
        });
        unsafe { lime_model_occt_string_free(raw.as_ptr()) };
        Ok(out)
    }

    fn editable(&self) -> Result<(), String> {
        let mut error: *mut c_char = std::ptr::null_mut();
        let ok = unsafe { lime_tree_editable(self.raw(), &mut error) };
        let message = take_text(error);
        if ok == 0 {
            return Err(message.unwrap_or_else(|| "This shape cannot be edited".into()));
        }
        Ok(())
    }

    fn fingerprint(&self) -> Fingerprint {
        let mut volume = 0.0;
        let mut faces = 0;
        let mut edges = 0;
        unsafe { lime_tree_fingerprint(self.raw(), &mut volume, &mut faces, &mut edges) };
        Fingerprint {
            volume_mm3: volume,
            faces,
            edges,
        }
    }

    fn edge(&mut self, index: i32) -> Option<EdgeRef> {
        let mut mid = [0.0; 3];
        let mut length = 0.0;
        let found =
            unsafe { lime_tree_edge(self.0.as_ptr(), index, mid.as_mut_ptr(), &mut length) };
        (found != 0).then_some(EdgeRef {
            index,
            mid,
            length_mm: length,
        })
    }

    /// Every edge, as the kernel numbers them.
    fn all_edges(&mut self) -> Vec<EdgeRef> {
        let count = self.fingerprint().edges;
        (0..count).filter_map(|index| self.edge(index)).collect()
    }

    /// The indexes of the edges the op that built this solid made or changed.
    fn created_indexes(&self) -> Vec<c_int> {
        let mut ptr: *const c_int = std::ptr::null();
        let count = unsafe { lime_tree_created(self.raw(), &mut ptr) };
        if count <= 0 || ptr.is_null() {
            return Vec::new();
        }
        // SAFETY: the kernel keeps `count` ints there for as long as the shape lives; they are copied here.
        unsafe { std::slice::from_raw_parts(ptr, count as usize) }.to_vec()
    }

    /// The edges the op that built this solid made or changed, those it could measure.
    fn created_edges(&mut self) -> Vec<EdgeRef> {
        self.created_indexes()
            .into_iter()
            .filter_map(|index| self.edge(index))
            .filter(|edge| edge.mid.iter().all(|v| v.is_finite()) && edge.length_mm.is_finite())
            .collect()
    }

    /// Each edge as convex (1), concave (2), or neither (0): smooth, a seam, or on one face.
    fn edge_kinds(&self, edges: &[c_int]) -> Result<Vec<c_int>, String> {
        let mut out = vec![0; edges.len()];
        let ok = unsafe {
            lime_tree_edge_kinds(
                self.raw(),
                edges.as_ptr(),
                edges.len() as c_int,
                out.as_mut_ptr(),
            )
        };
        if ok == 0 {
            return Err("Open CASCADE could not read those edges".into());
        }
        Ok(out)
    }

    /// Separate solids and closed shells.
    fn counts(&self) -> (i32, i32) {
        let mut solids = 0;
        let mut shells = 0;
        unsafe { lime_tree_counts(self.raw(), &mut solids, &mut shells) };
        (solids, shells)
    }

    fn face(&mut self, index: i32) -> Option<FaceRef> {
        let mut mid = [0.0; 3];
        let mut area = 0.0;
        let found =
            unsafe { lime_tree_face(self.0.as_ptr(), index, mid.as_mut_ptr(), &mut area) };
        (found != 0).then_some(FaceRef {
            index,
            mid,
            area_mm2: area,
        })
    }

    /// The one face whose centre and area match `want`. None when no face does; an error when several do.
    fn find_face(&mut self, want: &FaceRef) -> Result<Option<FaceRef>, String> {
        let count = self.fingerprint().faces;
        let mut found = None;
        for index in 0..count {
            let Some(have) = self.face(index) else {
                continue;
            };
            if same_face(&have, want) {
                if found.is_some() {
                    return Err("Two faces match the one this step opens".into());
                }
                found = Some(have);
            }
        }
        Ok(found)
    }

    /// The one edge whose midpoint and length match `want`. None when no edge does; an error when several do.
    fn find_edge(&mut self, want: &EdgeRef) -> Result<Option<EdgeRef>, String> {
        let count = self.fingerprint().edges;
        let mut found = None;
        for index in 0..count {
            let Some(have) = self.edge(index) else {
                continue;
            };
            if same_edge(&have, want) {
                if found.is_some() {
                    return Err("Two edges match the one this step rounds".into());
                }
                found = Some(have);
            }
        }
        Ok(found)
    }

    /// The solid reply for node `id`: the tessellation's arrays as base64 of their little-endian
    /// bytes, its faces and edges as JSON, and the fingerprint. `docs/step-modeler.md` lists the fields.
    fn reply(&mut self, id: NodeId, chord: f64) -> Result<String, Failure> {
        let mut view = MeshView {
            positions: std::ptr::null(),
            positions_bytes: 0,
            triangles: std::ptr::null(),
            triangles_bytes: 0,
            edge_points: std::ptr::null(),
            edge_points_bytes: 0,
            edge_offsets: std::ptr::null(),
            edge_offsets_bytes: 0,
            meta: std::ptr::null(),
        };
        let mut error: *mut c_char = std::ptr::null_mut();
        let raw = unsafe { lime_tree_mesh(self.0.as_ptr(), chord, &mut view, &mut error) };
        let message = take_text(error);
        let mesh = NonNull::new(raw).map(Mesh).ok_or_else(|| {
            Failure::Message(message.unwrap_or_else(|| "Open CASCADE failed".into()))
        })?;
        let meta = unsafe { CStr::from_ptr(view.meta) }
            .to_str()
            .ok()
            .and_then(|meta| meta.strip_prefix('{')?.strip_suffix('}'))
            .ok_or_else(|| Failure::Message("Open CASCADE returned a damaged mesh".into()))?;
        // SAFETY: `lime_tree_mesh` filled `view` with `mesh`'s own arrays, which live until it drops.
        let arrays = unsafe {
            [
                (
                    "positions",
                    mesh.bytes(view.positions, view.positions_bytes),
                ),
                (
                    "triangles",
                    mesh.bytes(view.triangles, view.triangles_bytes),
                ),
                (
                    "edgePoints",
                    mesh.bytes(view.edge_points, view.edge_points_bytes),
                ),
                (
                    "edgeOffsets",
                    mesh.bytes(view.edge_offsets, view.edge_offsets_bytes),
                ),
            ]
        };
        let fingerprint = json!(self.fingerprint()).to_string();
        let size = arrays
            .iter()
            .map(|(name, bytes)| name.len() + bytes.len().div_ceil(3) * 4 + 6)
            .sum::<usize>()
            + meta.len()
            + fingerprint.len()
            + 64;
        let mut out = String::with_capacity(size);
        let _ = write!(
            out,
            "{{\"id\":{id},\"format\":\"{SOLID_FORMAT}\",{meta},\"fingerprint\":{fingerprint}"
        );
        for (name, bytes) in arrays {
            let _ = write!(out, ",\"{name}\":\"");
            base64::engine::general_purpose::STANDARD.encode_string(bytes, &mut out);
            out.push('"');
        }
        out.push('}');
        Ok(out)
    }

    fn distance(&self, a_kind: &str, a: i32, b_kind: &str, b: i32) -> Result<f64, String> {
        let a_kind = CString::new(a_kind).map_err(|_| "pick kind is not a C string".to_string())?;
        let b_kind = CString::new(b_kind).map_err(|_| "pick kind is not a C string".to_string())?;
        let mut out = 0.0;
        let mut error: *mut c_char = std::ptr::null_mut();
        let ok = unsafe {
            lime_tree_distance(
                self.raw(),
                a_kind.as_ptr(),
                a,
                b_kind.as_ptr(),
                b,
                &mut out,
                &mut error,
            )
        };
        let message = take_text(error);
        if ok == 0 {
            return Err(message.unwrap_or_else(|| "Open CASCADE failed".into()));
        }
        Ok(out)
    }

    fn step_bytes(&self) -> Result<Vec<u8>, String> {
        let path = temp_step("export");
        let c = c_path(&path)?;
        let mut error: *mut c_char = std::ptr::null_mut();
        let ok = unsafe { lime_tree_write_step(self.raw(), c.as_ptr(), &mut error) };
        let message = take_text(error);
        let bytes = if ok == 0 {
            Err(message.unwrap_or_else(|| "Open CASCADE did not write this solid".into()))
        } else {
            std::fs::read(&path).map_err(|err| err.to_string())
        };
        let _ = std::fs::remove_file(&path);
        bytes
    }
}
