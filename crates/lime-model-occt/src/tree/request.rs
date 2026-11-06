//! The requests a client sends the store (the serde side of `call`) and the small types they carry.

use serde::Deserialize;
use serde_json::Value;
use std::os::raw::c_int;

use super::{transition, Fingerprint, NodeId};
use super::fit_coupon::CouponSpec;
use super::ops::{Affine, EdgeFilter, FacePick, Op, Solid, TextUse};

/// What an edit asks of its own tree's step: a split to print's `pieceKeys`, and `keepBroken`.
pub(super) struct OwnEdit {
    pub(super) piece_keys: Vec<Option<String>>,
    pub(super) pins_key: Option<String>,
    pub(super) keep_broken: bool,
}

#[derive(Deserialize)]
#[serde(
    tag = "call",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(super) enum Request {
    /// Stateless import for slicing; it owns no history and cannot evict a document.
    MeshStep {
        data_b64: String,
        chord_mm: f64,
    },
    Capabilities,
    /// Stateless: a split to print's fit coupon, the plate and its pins each as a STEP file, which the app adds as it adds
    /// any STEP file. Owns no history.
    FitCoupon {
        spec: CouponSpec,
    },
    /// Stateless, as `meshStep`: the solids of a STEP file, each with its product name and volume. With `files`, each
    /// also comes back as a STEP file of its own: that solid alone, a product of the same name, where the file placed it.
    StepSolids {
        data_b64: String,
        #[serde(default)]
        files: bool,
    },
    /// Stateless, as `stepSolids`: the solids of a shape the engine wrote (`brep`) or of a STEP file, each on its own
    /// in the engine's binary format, with its volume and its geometric box. A committed compound is split this way,
    /// one solid per shell of its mesh.
    ShapeSolids {
        data_b64: String,
    },

    /// Open a tree from its root: a STEP, a primitive built from its numbers, or a feature (an extrude, a
    /// revolve, or a loft) built against nothing. With `nodes`,
    /// register the saved ops (parents first) without building them, then jump to `current`.
    /// `fingerprint` is the root's as saved: a root that builds to another is broken.
    Open {
        key: String,
        data_b64: Option<String>,
        step_path: Option<String>,
        #[serde(rename = "box")]
        box_mm: Option<[f64; 3]>,
        primitive: Option<Solid>,
        /// K2: a feature root. An extrude, revolve, or loft built against nothing. Exactly one root source.
        /// Boxed so `Open` stays no larger than the other calls.
        #[serde(default)]
        feature: Option<Box<Op>>,
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
        /// --- Split to print only: piece 2, 3, ... in partition order opens as the root of its own tree under the
        /// key at its place. A null, or no key at that place, leaves that piece unseen.
        #[serde(default)]
        piece_keys: Vec<Option<String>>,
        /// --- Split to print only: the pins of its dowels open as the root of their own tree under this key.
        pins_key: Option<String>,
    },
    /// --- 3.1 F1. The steps from `parent` down to `last`, each already applied, become the one group `node` under
    /// `parent`, with the solid `last` holds: nothing is built again. `op` is the group, its steps the chain's ops in
    /// order. The chain is dropped. A chain that is not exactly those steps, has another branch, or whose last solid is
    /// no longer held is refused, and the caller builds the group instead.
    Fold {
        key: String,
        parent: NodeId,
        node: NodeId,
        op: Op,
        last: NodeId,
        #[serde(default = "default_chord")]
        chord_mm: f64,
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
        /// --- Split to print: as an apply's, for the edited step when it is a split to print (D9).
        #[serde(default)]
        piece_keys: Vec<Option<String>>,
        /// --- Split to print: as an apply's.
        pins_key: Option<String>,
        /// --- Split to print (D9). The steps a rebuilt piece had after its root, replayed on the new piece: when the
        /// first of them no longer builds, it is kept broken with the rest under it, as a later replayed step would
        /// be, instead of the edit keeping nothing. Only for an edit of the tree's own step, with no tools.
        #[serde(default)]
        keep_broken: bool,
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
    /// K4: the face's outline in its own plane, as D2 loops (`origin`, `turn`, `loops`).
    FaceLoops {
        key: String,
        node: NodeId,
        face: FacePick,
    },
    // --- Recipe reads (docs/plan-recipe-ingredients.md I5–I7). Keep these together. ---
    /// I5: a flat face's outline inset `insetMm`, in `frame` (origin, U, V: nine numbers) or the face's own: the frame,
    /// the extrude `origin` and `turn` that draw in it, `loops`, `regions` sampled to `chordMm`, and `areaMm2`.
    FaceOutline {
        key: String,
        node: NodeId,
        face: FacePick,
        #[serde(default)]
        inset_mm: f64,
        #[serde(default = "default_outline_chord")]
        chord_mm: f64,
        #[serde(default)]
        frame: Option<[f64; 9]>,
    },
    /// I6: the solid at `node` cut by the plane through `origin` along `normal`, in `frame` on that plane, answered as
    /// `faceOutline` answers.
    Section {
        key: String,
        node: NodeId,
        origin: [f64; 3],
        normal: [f64; 3],
        frame: [f64; 9],
        #[serde(default = "default_outline_chord")]
        chord_mm: f64,
    },
    /// Debug builds only: an access violation inside Open CASCADE on purpose, on step `node`'s solid, answered as the
    /// refusal any such crash gets (`tests/kernel_fault.rs`).
    #[cfg(lime_occt_test_hooks)]
    TestFault { key: String, node: NodeId },
    /// Debug builds only (text milestone 4): a font file built in code, base64, for a test that adds it. `variable` is the
    /// weight axis's minimum and maximum.
    #[cfg(lime_occt_test_hooks)]
    #[serde(rename_all = "camelCase")]
    TextTestFont {
        family: String,
        #[serde(default)]
        fs_type: u16,
        #[serde(default)]
        variable: Option<[f32; 2]>,
    },
    /// --- A5. The edges step `node` made, as indexes on the tree's current solid. ---
    StepEdges {
        key: String,
        node: NodeId,
        #[serde(default)]
        filter: EdgeFilter,
    },
    /// --- Print transitions, auto-find (docs/plan-belt-transitions.md, step 5). The edges of step `node`'s solid that
    /// would start in the air, built along `build` on a plate whose up is `up`, both in the solid's frame, with the support
    /// limit `limitDeg` to the layers. Each row's fix is `fix` on that one edge, probed as a print transition: its answer
    /// is the probe's. Nothing is applied.
    TransitionFind {
        key: String,
        node: NodeId,
        build: [f64; 3],
        up: [f64; 3],
        #[serde(default = "transition::default_angle")]
        limit_deg: f64,
        #[serde(default)]
        fix: Value,
    },
    /// --- Print transitions, step 6. The tangent chain through edge `edge` of step `node`'s solid: the sharp edges of its
    /// convexity that run on from it at vertices turning 5° or less, with no branch, the picked edge first.
    EdgeChain {
        key: String,
        node: NodeId,
        edge: c_int,
    },
    // --- Text with real fonts (milestone 1). Stateless: they own no history. ---
    /// A text laid out as outlines for the card's live preview: each letter's loops as polylines about `stepMm` apart in the
    /// plane's own U and V, and the letters too thin for a `lineMm` line.
    #[serde(rename_all = "camelCase")]
    TextLayout {
        text: String,
        font: String,
        #[serde(default)]
        style: Option<String>,
        height: f64,
        #[serde(default)]
        spacing: Option<f64>,
        #[serde(default)]
        line_spacing: Option<f64>,
        #[serde(default)]
        align: Option<crate::text::Align>,
        #[serde(default)]
        angle_deg: Option<f64>,
        #[serde(default)]
        weight: Option<f64>,
        #[serde(default)]
        #[serde(rename = "strokeWidth")]
        stroke_mm: Option<f64>,
        #[serde(default)]
        line_mm: Option<f64>,
        #[serde(default)]
        step_mm: Option<f64>,
    },
    /// The bundled fonts, for the font picker and the guide.
    TextFonts,
    /// --- Text milestone 4. Give the engine a font file (or the pack of a restricted font's letters), base64, and answer what it
    /// is; `face` picks one of a collection's fonts. The font is kept by id for the life of the engine.
    #[serde(rename_all = "camelCase")]
    TextFontAdd {
        data_b64: String,
        #[serde(default)]
        face: Option<u32>,
    },
    /// The pack of a font's letters for the texts a project sets in it, as base64 of its JSON.
    #[serde(rename_all = "camelCase")]
    TextFontPack {
        id: String,
        uses: Vec<TextUse>,
    },
    /// A text laid out on the cylinder or cone under `point` (milestone 2), for the card's live preview: each letter's loops as
    /// 3D polylines on the face and on the top (or floor), the layout points they come from, and the refusal when the text
    /// would not build (too long, off the face, too deep).
    #[serde(rename_all = "camelCase")]
    TextCurved {
        key: String,
        node: NodeId,
        point: [f64; 3],
        text: String,
        font: String,
        #[serde(default)]
        style: Option<String>,
        height: f64,
        depth: f64,
        #[serde(default)]
        cut: bool,
        #[serde(default)]
        spacing: Option<f64>,
        #[serde(default)]
        line_spacing: Option<f64>,
        #[serde(default)]
        align: Option<crate::text::Align>,
        #[serde(default)]
        angle_deg: Option<f64>,
        #[serde(default)]
        along: Option<String>,
        #[serde(default)]
        flip: Option<bool>,
        /// --- Milestone 3: `wrap` or `project`, on a sphere, a torus or a freeform face.
        #[serde(default)]
        wrap: Option<String>,
        #[serde(default)]
        weight: Option<f64>,
        #[serde(default)]
        #[serde(rename = "strokeWidth")]
        stroke_mm: Option<f64>,
        #[serde(default)]
        line_mm: Option<f64>,
        #[serde(default)]
        step_mm: Option<f64>,
    },
    /// Debug builds only: step `node`'s solid with every face and edge converted to NURBS, as BinTools bytes in base64,
    /// for a test that opens a flat face stored as a B-spline.
    #[cfg(lime_occt_test_hooks)]
    TestNurbs { key: String, node: NodeId },
    /// Debug builds only: the cheap checks of a text build next to the exact calls they stand in for, on the face of step `node`'s solid
    /// nearest `point`: the classifier, the edge gap, the validity checks, and the whole solid's volume.
    #[cfg(lime_occt_test_hooks)]
    TestText {
        key: String,
        node: NodeId,
        point: [f64; 3],
    },
    /// `format` is `step` (the default, for a file to hand on) or `brep` (the binary a project keeps).
    Export {
        key: String,
        node: NodeId,
        #[serde(default)]
        format: ExportFormat,
        /// --- Split to print (D12): the other pieces, each a tree's step, written with this one as one STEP file of
        /// separate solids, in this order.
        #[serde(default)]
        pieces: Vec<TreeStep>,
        /// --- Split to print: the product name of each solid of that file, this one first and then `pieces`, never
        /// echoed. With pieces, one for each is required.
        #[serde(default)]
        names: Vec<String>,
        /// --- Assemblies M9: where each solid of that file is written, this one first and then `pieces`, each a pose
        /// from its own frame (an assembly member's pose in model space). Absent, each is written where it is.
        #[serde(default)]
        poses: Vec<Affine>,
    },
}

/// --- Split to print. A step of a tree by its key.
#[derive(Deserialize)]
pub(super) struct TreeStep {
    pub(super) key: String,
    pub(super) node: NodeId,
}

#[derive(Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(super) enum ExportFormat {
    #[default]
    Step,
    Brep,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SeedSolid {
    pub(super) node: NodeId,
    pub(super) data_b64: String,
}

#[derive(Deserialize)]
pub(super) struct ReplayStep {
    pub(super) id: NodeId,
    pub(super) op: Op,
}

/// One tree's part of an edit: `op` on `parent` as `node`, then each of `replay`. Its tip is the last step it keeps.
#[derive(Deserialize)]
pub(super) struct ToolEdit {
    pub(super) key: String,
    pub(super) parent: NodeId,
    pub(super) node: NodeId,
    pub(super) op: Op,
    #[serde(default)]
    pub(super) replay: Vec<ReplayStep>,
}

impl ToolEdit {
    pub(super) fn tip(&self) -> NodeId {
        self.replay.last().map_or(self.node, |step| step.id)
    }

    pub(super) fn ids(&self) -> impl Iterator<Item = NodeId> + '_ {
        std::iter::once(self.node).chain(self.replay.iter().map(|step| step.id))
    }
}

/// How a tool tree's part of an edit ended: its tip built, or the step that broke and why.
pub(super) type Tip = Result<NodeId, String>;

/// An edit's new branch: the last step that built, each built step as `{id, op, fingerprint}`, and the broken step with why.
pub(super) type Forked = (NodeId, Vec<serde_json::Value>, Option<(NodeId, String)>);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SavedNode {
    pub(super) id: NodeId,
    pub(super) parent: NodeId,
    pub(super) op: Op,
    pub(super) fingerprint: Option<Fingerprint>,
}

fn default_chord() -> f64 {
    0.1
}

/// I5–I6: how closely an outline's curves are sampled into points, unless the request says.
fn default_outline_chord() -> f64 {
    0.05
}

/// The kernel's clamp, so one reply is cached once whatever chord asked for it.
pub(super) fn chord_key(chord: f64) -> u64 {
    let clamped = if chord.is_nan() {
        0.01
    } else {
        chord.clamp(0.01, 2.0)
    };
    clamped.to_bits()
}
