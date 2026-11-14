//! The edit vocabulary: the `Op` enum and the small types its fields are made of (primitives, edge and face picks, profile loops, affine placements).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::ffi::CStr;

use super::{transition, NodeId};
use super::partition::{PartitionCut, PartitionNumbers, PartitionTarget};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BooleanOp {
    Fuse,
    Cut,
    Common,
}

impl BooleanOp {
    pub(super) fn name(self) -> &'static CStr {
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
    /// A spur gear with true involute flanks (`gear.rs`), built in Rust from loops: never handed to `spec_of`.
    Gear,
}

/// A gear's bore: a round hole, a hexagon (`bore` across its flats), or a D (`bore` across, `boreFlat` from the flat).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BoreShape {
    Round,
    Hex,
    D,
}

impl Primitive {
    pub(super) fn name(self) -> &'static CStr {
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
            Primitive::Gear => c"gear",
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
    /// A box's four edges along its own Z, rounded to this radius in the one solid, as a rounded pocket or boss cuts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub corner_radius: Option<f64>,
    // --- A gear (docs/plan-native-recipes.md milestone 8). `height` is its thickness; `origin` its base centre. Each is
    // written only on a gear, so every other primitive stores as it did.
    /// 6 to 200, a whole number.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub teeth: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub module: Option<f64>,
    /// 20 when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pressure_deg: Option<f64>,
    /// mm off each tooth's thickness at the pitch circle; 0.1 when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backlash: Option<f64>,
    /// Times the module; 0 when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_shift: Option<f64>,
    /// Tooth 0's centre, degrees from the gear's own +X about its axis; 0 when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase_deg: Option<f64>,
    /// The bore's size, mm: a round or D bore's diameter, a hexagon's width across its flats. None or 0 for no bore.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bore: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bore_shape: Option<BoreShape>,
    /// A D bore's width from its flat to the far side, mm; 0.9 of the bore when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bore_flat: Option<f64>,
    /// A hub on the gear's top face (its own +Z): both, or neither.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hub_diameter: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hub_height: Option<f64>,
    /// An internal gear, a ring with its teeth pointing in (docs/plan-gear-kinds.md, stage 2). Written only when true.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub internal: Option<bool>,
    /// A ring's outside diameter, mm; at least two modules outside its root circle. Only on a ring.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rim: Option<f64>,
}

impl Solid {
    /// The numbers `spec_of` in tree.cpp reads, in its order.
    pub(super) fn numbers(&self) -> [f64; 19] {
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
            or_zero(self.corner_radius),
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
    /// What the edge is, apart from where: written for a fresh pick, so a rebuild that moved or resized the part still
    /// finds the same edge when its midpoint and length no longer agree. An edge stored before it has none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sig: Option<EdgeSig>,
}

/// An edge's curve and direction, and the faces either side of it: each one's surface and outward normal at the
/// edge's middle, in a fixed order. Edges with the same one on a part are told apart by where they are.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeSig {
    /// 0 a line, 1 a circle, 2 another curve.
    pub curve: u8,
    /// A line's direction or a circle's axis, its first non-zero part positive.
    pub dir: [f64; 3],
    /// Each face's surface: 0 plane, 1 cylinder, 2 cone, 3 sphere, 4 torus, 5 other, 9 no face.
    pub kinds: [u8; 2],
    pub normals: [[f64; 3]; 2],
}

/// Directions agree within half a degree.
const SIG_COS: f64 = 0.999_961_923;

/// A curve or a surface within this many millimetres of a line or a plane is one, to a print transition and its finder.
pub(super) const FLAT_MM: f64 = 1e-4;

/// Edges that turn this many degrees or less at a vertex run on as one tangent chain (plan section 4).
pub(super) const CHAIN_DEG: f64 = 5.0;

impl EdgeSig {
    pub(super) fn matches(&self, other: &EdgeSig) -> bool {
        let dot = |a: [f64; 3], b: [f64; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        let same = |a: [f64; 3], b: [f64; 3]| {
            let zero = |v: [f64; 3]| dot(v, v) < 1e-12;
            (zero(a) && zero(b)) || dot(a, b) >= SIG_COS
        };
        self.curve == other.curve
            && self.kinds == other.kinds
            && dot(self.dir, other.dir).abs() >= SIG_COS
            && same(self.normals[0], other.normals[0])
            && same(self.normals[1], other.normals[1])
    }
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

/// One face of a `moveFaces`, moved `distance` along the solid's outward normal.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FaceMove {
    pub face: FacePick,
    pub distance: f64,
}

fn draft_unset(value: &f64) -> bool {
    *value == 0.0
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
    pub(super) fn rigid(&self) -> Result<[f64; 12], String> {
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

    /// --- Assemblies M9. The twelve numbers `lime_tree_write_step_many` reads: a turn and a move, times at most one
    /// uniform scale (a plate object's pose in model space), with no shear or mirror.
    pub(super) fn placement(&self) -> Result<[f64; 12], String> {
        let scale = (self.m[0] * self.m[0] + self.m[3] * self.m[3] + self.m[6] * self.m[6]).sqrt();
        if !(scale.is_finite() && scale > 1e-9) {
            return Err("A part's pose must be a turn and a move, with no shear or mirror".into());
        }
        let turn = Affine {
            m: self.m.map(|value| value / scale),
            t: self.t,
        };
        turn.rigid().map_err(|_| {
            "A part's pose must be a turn and a move, with no shear or mirror".to_string()
        })?;
        let m = self.m;
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

// --- K1 profile v2 (loops, arcs, holes). Other packages add their own ops beside these types. ---

/// One edge of a loop, from the previous end (the loop's `start`, for the first) to `to`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ProfileSegment {
    Line { to: [f64; 2] },
    Arc { through: [f64; 2], to: [f64; 2] },
    Spline { through: Vec<[f64; 2]>, to: [f64; 2] },
}

/// A closed loop on a profile's plane. A loop inside no other is an outline, and one inside an outline is its hole.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileLoop {
    pub start: [f64; 2],
    pub segments: Vec<ProfileSegment>,
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
        /// Faces and edges that now lie on one surface or curve are merged after the boolean, so a pad flush with a rim
        /// leaves one top face. Absent on a step saved before it, which rebuilds with its faces as they were.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        merge: bool,
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
    /// Equal distances by default. With `size2`, `size` runs along each edge's upper face (the one whose outward
    /// normal points more up; on a level tie, more along +X, then +Y) and `size2` along the other. With `angleDeg`,
    /// `size` runs along that face and the bevel leaves it at that angle. `flip` swaps the faces.
    Chamfer {
        edges: Vec<EdgePick>,
        size: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        size2: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        angle_deg: Option<f64>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        flip: bool,
    },
    Scale {
        factor: f64,
    },
    /// Faces and edges on one surface or curve, left apart by earlier steps, become one, so a fillet or chamfer can
    /// cross the old seam. Nothing is added or removed.
    Unify,
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
        /// Absent when `loops` is set, so a loops-only op does not store an empty profile.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        profile: Vec<[f64; 2]>,
        depth: f64,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        symmetric: bool,
        /// Splines through the points, sharp at `corners`.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        smooth: bool,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        corners: Vec<u32>,
        // --- K3. Each one is absent on a plain extrude, so an older request stores and compares as it did. ---
        /// The other side of the plane, above 0. The prism runs from −`depth2` to `depth` when `depth` is positive.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        depth2: Option<f64>,
        /// Draft angle in degrees. Positive makes the section smaller as W increases.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        draft_deg: Option<f64>,
        /// Stop at this face of the solid the extrude is built on, instead of at `depth`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        up_to: Option<FacePick>,
        /// K1: closed loops in place of `profile`. Empty, and omitted, for a point profile.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        loops: Vec<ProfileLoop>,
        // --- I20 cells (docs/plan-recipe-ingredients.md). Each is absent on any other extrude. With any of them, each
        // outline of `loops` is one cell: clipped to `clip` (loops on the same plane), left out under `minArea` mm²,
        // its corners rounded to `cornerRadius`, and every cell meets the part in one boolean. ---
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        clip: Vec<ProfileLoop>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        corner_radius: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        min_area: Option<f64>,
    },
    /// The same outline turned `angleDeg` (360 when absent) about the in-plane axis through `axisOrigin` ([0, 0]
    /// when absent) along `axisDir` (V, [0, 1], when absent), and combined by `op`.
    Revolve {
        op: BooleanOp,
        origin: [f64; 3],
        #[serde(default)]
        turn: [f64; 3],
        /// Absent when `loops` is set, so a loops-only op does not store an empty profile.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
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
        /// K1: closed loops in place of `profile`. Empty, and omitted, for a point profile.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        loops: Vec<ProfileLoop>,
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
    // --- A1 group (docs/plan-gui-mcp-parity.md D2). Keep this variant, and the match arms marked
    // the same way, in one block so other kernel ops can rebase beside it. ---
    /// One history node for a composite edit. Each step is built on the shape the one before left.
    /// `source` is the composite as typed, kept so an edit can reopen it, and never built.
    Group {
        /// The history row's name, e.g. "Pocket 10 × 10, 2 bars".
        label: String,
        /// The composite as typed (`{kind: "pocket", ...}`), kept opaque. Read back for an edit; never built.
        #[serde(default, skip_serializing_if = "Value::is_null")]
        source: Value,
        steps: Vec<Op>,
        /// I19: every step is a tool of this one boolean, built alone, and all of them meet the solid at once. A step
        /// whose tool does not build is left out. Absent on a group built step by step.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        combine: Option<BooleanOp>,
    },
    // --- K4: faceExtrude, moveFaces. Keep this block together. ---
    /// The face pushed along its outward normal: fused when `distance` is positive, cut when negative.
    /// `draftDeg` of 0 and no `upTo` build a prism. A draft or a stop-face uses a feature prism.
    FaceExtrude {
        face: FacePick,
        distance: f64,
        #[serde(default, skip_serializing_if = "draft_unset")]
        draft_deg: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        up_to: Option<FacePick>,
    },
    /// Faces offset along their outward normals. Neighbours extend or trim; the other faces stay put.
    MoveFaces { faces: Vec<FaceMove> },
    // --- Split to print (docs/plan-split-connectors.md, D1). Keep this variant, and the arms marked the same way, in
    // one block. ---
    /// The solid cut along every plane at once. The node keeps the first piece in partition order; the others are
    /// answered once, in the apply reply, and with `pieceKeys` each becomes the root of its own tree. `target`,
    /// `orient`, `arrange`, `labels`, `bedMarginMm` and `maxPieces` are stored as sent; only `maxPieces` is read here.
    /// `numbers` is the part numbers' strokes the client builds from `labels` for every request, and is never echoed.
    /// `up` is the print's up in the solid's frame at Apply, which a teardrop's roof and the pins follow.
    Partition {
        cuts: Vec<PartitionCut>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        up: Option<[f64; 3]>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target: Option<PartitionTarget>,
        #[serde(default, skip_serializing_if = "Value::is_null")]
        orient: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        arrange: Option<bool>,
        #[serde(default, skip_serializing_if = "Value::is_null")]
        labels: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        bed_margin_mm: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_pieces: Option<f64>,
        #[serde(default, skip_serializing)]
        numbers: Option<PartitionNumbers>,
    },
    // --- Print transitions (docs/plan-belt-transitions.md, step 2). Keep this variant, and the arms marked the same
    // way, in one block. ---
    /// A flat wedge in the concave corner of each straight edge between two flat faces, whose new face makes `angleDeg`
    /// with the layers. `build` is the side each new layer is laid on, in the solid's frame, worked out once at Apply
    /// from the part's pose and its printer, so a later turn on the plate never changes the solid. `size` is how far the
    /// wedge reaches along the flatter face, 2 mm when absent. `beltDeg`, `orient` and `printer` are that pose, stored as
    /// sent. Step 4: a lip, the lowest edge of a ledge, gets a gusset back into the part, or with `mode: "cut"` its
    /// underside becomes a ramp that leaves at least `floorMm` on top. `case` overrides the case found per edge.
    Transition {
        edges: Vec<EdgePick>,
        build: [f64; 3],
        #[serde(default = "transition::default_angle")]
        angle_deg: f64,
        #[serde(default)]
        size: transition::TransitionSize,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_mm: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mode: Option<transition::TransitionMode>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        case: Option<transition::TransitionCase>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        floor_mm: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        belt_deg: Option<f64>,
        #[serde(default, skip_serializing_if = "Value::is_null")]
        orient: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        printer: Option<String>,
    },
    // --- Text with real fonts (docs/plan-text-on-curves-and-fonts.md, milestone 1). Keep this variant, and the arms marked
    // the same way, in one block. ---
    /// The letters of `text` in a bundled font, raised from the flat face at the plane `origin` and `turn` (fuse) or cut into it
    /// (cut), `depth` deep along the plane's normal. `height` is the capitals'; the layout is centred on `origin` and turned
    /// `angleDeg` about it. The font is stored with its version (`sans@4.0`), so a rebuild reads the bytes it was made with.
    #[serde(rename = "lettering")]
    Lettering {
        op: BooleanOp,
        origin: [f64; 3],
        #[serde(default)]
        turn: [f64; 3],
        text: String,
        font: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        style: Option<String>,
        height: f64,
        depth: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        spacing: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        line_spacing: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        align: Option<crate::text::Align>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        angle_deg: Option<f64>,
        /// A variable font's weight, 100 to 900 (milestone 4).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        weight: Option<f64>,
        /// A pen font's line width, mm (milestone 5). Absent: 0.15 of the height.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[serde(rename = "strokeWidth")]
        stroke_mm: Option<f64>,
        /// --- Milestone 2, a cylinder or a cone. Which way the baseline runs: `around` (the default) or `axis`; `u` and `v`
        /// are the same two. Not read on a flat face.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        along: Option<String>,
        /// The text turned half a turn about its anchor: reads the other way round, upside down.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        flip: Option<bool>,
        /// --- Milestone 3, a sphere, a torus or a freeform face. `wrap` (the default) walks the baseline along the surface and
        /// keeps the letters' size; `project` pushes the layout onto the surface along the anchor's normal. `along` is then `u`
        /// (the default) or `v`: the surface's own direction the baseline starts in.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        wrap: Option<String>,
    },
}

/// One text a project sets in a font, for the pack of the letters it needs.
#[derive(Debug, Deserialize)]
pub(super) struct TextUse {
    pub(super) text: String,
    #[serde(default)]
    pub(super) style: Option<String>,
    #[serde(default)]
    pub(super) weight: Option<f64>,
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
    /// K1: closed loops in place of `profile` or `radius`. Empty, and omitted, otherwise.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub loops: Vec<ProfileLoop>,
}
