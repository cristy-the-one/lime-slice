use super::belt::BeltJob;
use super::patch::PreviewPatch;
use super::preview_paths::path_columns;
use super::settings::is_one;
use super::wire::{Collision, ObjectView};
use super::{elapsed_ms, slice_request_inner};
use crate::gcode::PlateLayer;
use crate::index::ZIndex;
use crate::{
    CoverageGap, EditOutcomeView, GcodeText, InAir, Job, Mesh, PaintTally, SliceRequest,
    SupportSkeleton, Watch,
};
use rayon::iter::{IntoParallelRefIterator, ParallelIterator};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Instant;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SliceResponse {
    pub core_ms: f64,
    pub baseline_ms: f64,
    pub baseline_label: String,
    pub mesh: MeshInfo,
    /// Where the reply frame sits on the bed. `layers`, `previewPatch`,
    /// `coverage`, the skeleton's knots, `inAir`, the gaps in `supportEdits`,
    /// and `mesh.min`/`max` are in the part frame: draw them at their
    /// coordinates plus `offset`. The G-code and `sanity`'s bounds are in bed
    /// coordinates. Absent when the request has no pose, since the two
    /// frames are then the same. On a belt the reply frame is the lab less
    /// the offset: `coverage`, `inAir`, the gaps, and the skeleton's sites
    /// stay in the slice frame, where the part lies flat for the nozzle. A
    /// belt's gaps also carry `tilted`, their outline in the reply frame.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<[f64; 2]>,
    /// Named slices of `core_ms`: contours, supports, toolpaths, order, combing, and G-code emit.
    /// Simplify time stays on `mesh` because it runs before the core timer.
    pub stages: StageTimes,
    pub sanity: Sanity,
    /// Overhang the supports leave unheld, largest first. Empty when every
    /// demanded interface prints.
    pub coverage: Vec<CoverageGap>,
    /// With supports off, the islands and overhangs that print over air.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_air: Option<InAir>,
    pub gcode: String,
    /// The G-code, formatted when first read, when the settings left it out
    /// of `gcode`.
    #[serde(skip)]
    pub gcode_text: Option<GcodeText>,
    pub layers: Vec<PreviewLayer>,
    pub blend: String,
    pub estimate: PrintEstimate,
    pub score: BlendScore,
    /// Real slices of the same mesh: speed, efficiency (weight 0.5), toughness, classic.
    /// Empty unless the request set `compare`.
    #[serde(default)]
    pub compare: Vec<CompareEstimate>,
    /// One per requested support edit, in request order.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub support_edits: Vec<EditOutcomeView>,
    /// How the request's support paint landed. Only when it sent paint.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub support_paint: Option<PaintTally>,
    /// The grown trees after every edit. Only when the request asked for it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skeleton: Option<SupportSkeleton>,
    /// Belt only, and only with more than one copy: where the later copies sit.
    /// The skeleton and the gaps are the first copy's.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub belt_copies: Option<BeltCopies>,
    /// Names the preview this reply leaves the client holding. Sent back as
    /// `previewBase`. Only for kept interactive slices.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_token: Option<String>,
    /// The changed layers against the request's `previewBase`. `layers` is
    /// empty when this is set.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_patch: Option<PreviewPatch>,
    /// One per requested object, in plate order. Empty when the request
    /// omitted `objects`.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub objects: Vec<ObjectView>,
    /// Pairs of objects whose boxes overlap on the bed. Only when the
    /// request sent `objects`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collisions: Option<Vec<Collision>>,
    /// Mesh repair the cut already performed. Absent when every contour
    /// closed on its own. Response metadata only: G-code is unchanged.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<SliceWarning>,
    /// Part beads that stand on nothing, when the request set `partHold`.
    /// The first belt copy only; the others print the same layers.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub part_hold: Option<crate::audit::PartHold>,
    /// The emitted beads, when `slice_beads` asked for them. Never on the wire.
    #[serde(skip)]
    pub beads: Option<Arc<SlicedBeads>>,
}

/// The beads a one-object slice extrudes, as the G-code writer lays them, and
/// where they sit on the part. Built by `slice_beads` for a stress study.
#[derive(Clone, Debug)]
pub struct SlicedBeads {
    /// Every extruding segment in print order, skirt and supports included:
    /// the study decides what carries load.
    pub beads: Vec<crate::gcode::Bead>,
    /// One row per emitted layer that has beads, in order.
    pub layers: Vec<BeadLayer>,
    /// Slice frame to part frame, row-major, the last row `[0, 0, 0, 1]`.
    /// The part frame is the request's mesh after its pose.
    pub frame: [[f64; 4]; 4],
    /// The direction layers stack in, in the part frame.
    pub layer_normal: [f64; 3],
}

/// A layer of `SlicedBeads`: its beads are `beads[bead_start..][..bead_count]`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BeadLayer {
    pub index: usize,
    /// The layer top in the slice frame.
    pub z_mm: f64,
    pub height_mm: f64,
    pub bead_start: usize,
    pub bead_count: usize,
}

/// Slice one object and keep the beads its G-code extrudes. The reply is
/// the ordinary one, with `beads` set. A plate of several objects is
/// refused: `Extrusion` carries no object, so the study slices its object
/// alone, with that object's settings.
pub fn slice_beads(req: &SliceRequest, job: Job, watch: &Watch) -> Result<SliceResponse, String> {
    if let Some(objects) = &req.objects {
        if objects.len() != 1 {
            return Err(format!(
                "A study slices its object alone. This request has {} objects.",
                objects.len()
            ));
        }
    }
    if req.belt.as_ref().is_some_and(|belt| belt.copies > 1) {
        return Err("A study slices one copy. Set the belt copies to 1.".into());
    }
    let response = slice_request_inner(req, job, watch, true)?;
    if response.beads.as_ref().is_none_or(|b| b.beads.is_empty()) {
        return Err("The slice produced no beads.".into());
    }
    Ok(response)
}

/// The beads of `layers`, with the frame that takes them back to the part.
pub(super) fn sliced_beads(
    layers: &[PlateLayer],
    offsets: &[[f64; 2]],
    flow: f64,
    frame: [[f64; 4]; 4],
) -> SlicedBeads {
    let beads = crate::gcode::emitted_beads(layers, offsets, flow).collect::<Vec<_>>();
    let mut rows: Vec<BeadLayer> = Vec::new();
    for (k, bead) in beads.iter().enumerate() {
        match rows.last_mut() {
            Some(row) if row.index == bead.layer => row.bead_count += 1,
            _ => {
                let layer = layers
                    .iter()
                    .find(|l| l.index == bead.layer)
                    .expect("a bead's layer is emitted");
                rows.push(BeadLayer {
                    index: layer.index,
                    z_mm: layer.z,
                    height_mm: layer.height,
                    bead_start: k,
                    bead_count: 1,
                });
            }
        }
    }
    let layer_normal = [frame[0][2], frame[1][2], frame[2][2]];
    SlicedBeads {
        beads,
        layers: rows,
        frame,
        layer_normal,
    }
}

/// The slice-to-part map of a plate slice. On a cartesian printer the beads
/// carry the object's bed offset, which comes off. On a belt the plate was
/// moved to the bed, lifted onto any pad, and laid flat: `Frame::lab` undoes
/// the lay-flat, then the move comes off: across the belt all of it, along
/// it only what was baked into the laid mesh.
pub(super) fn slice_to_part(belt: Option<&BeltJob>, offset: [f64; 2]) -> [[f64; 4]; 4] {
    let Some(job) = belt else {
        return [
            [1.0, 0.0, 0.0, -offset[0]],
            [0.0, 1.0, 0.0, -offset[1]],
            [0.0, 0.0, 1.0, 0.0],
            [0.0, 0.0, 0.0, 1.0],
        ];
    };
    let frame = &job.belt.frame;
    // A bead holds the place baked into the laid mesh, plus the emit offset,
    // which is the rest of the place across the belt. Along the belt only the
    // baked part is in it.
    let to_bed = job.offsets.first().copied().flatten().unwrap_or([0.0, 0.0]);
    let baked = job.baked.first().copied().unwrap_or([0.0, 0.0]);
    let lift = job.raft.as_ref().map_or(0.0, |r| r.top);
    // lab(p) = A·p + b, read from the origin and the three unit points.
    let o = frame.lab(0.0, 0.0, 0.0);
    let cols = [
        frame.lab(1.0, 0.0, 0.0),
        frame.lab(0.0, 1.0, 0.0),
        frame.lab(0.0, 0.0, 1.0),
    ];
    let shift = [to_bed[0], baked[1], lift];
    let row = |r: usize| {
        [
            cols[0][r] - o[r],
            cols[1][r] - o[r],
            cols[2][r] - o[r],
            o[r] - shift[r],
        ]
    };
    [row(0), row(1), row(2), [0.0, 0.0, 0.0, 1.0]]
}

/// One plain-language notice for the results summary.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SliceWarning {
    pub code: &'static str,
    /// Layers whose contour closed a mesh gap.
    pub repaired_layers: usize,
    /// Length of the gap links those layers added, in millimetres.
    pub bridged_mm: f64,
    /// Open chains the cut could not close.
    pub dropped_chains: usize,
}

pub(super) fn mesh_warnings(
    repaired_layers: usize,
    bridged_mm: f64,
    dropped_chains: usize,
) -> Vec<SliceWarning> {
    if repaired_layers == 0 && bridged_mm == 0.0 && dropped_chains == 0 {
        return Vec::new();
    }
    vec![SliceWarning {
        code: "mesh-repair",
        repaired_layers,
        bridged_mm,
        dropped_chains,
    }]
}

/// A belt's copies are one planned part, printed again after a shift along the
/// belt. Copy `c` is the first copy's preview geometry with `c * shift_mm`
/// added to every layer `z` and skeleton `ls`, which are belt positions, and
/// subtracted from Y: the belt carries the part toward +Y, so a copy that
/// prints later stands upstream of the first.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeltCopies {
    pub count: u32,
    /// From one copy to the next, signed by the belt's direction.
    pub shift_mm: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintEstimate {
    pub seconds: f64,
    pub filament_mm: f64,
    pub filament_g: f64,
    pub arc_moves: usize,
    pub travel_mm: f64,
    pub retracts: usize,
    pub z_hops: usize,
    /// Closed walls that received a scarf. `0` means every seam is a butt joint.
    pub scarfed_loops: usize,
    /// Mean overlap length of those scarfs, millimetres.
    pub mean_scarf_mm: f64,
    /// Largest |ΔZ| between consecutive scarf vertices. `0` when no scarf was emitted.
    pub max_seam_z_step_mm: f64,
    /// Time and filament per path kind, including travel.
    #[serde(default)]
    pub by_feature: Vec<FeatureEstimate>,
    /// Set when the printer's Klipper `max_velocity` is below feeds the slice
    /// writes: Klipper runs those moves at the cap, and so does the estimate.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub velocity_cap: Option<VelocityCap>,
}

/// How much of a slice the printer's `max_velocity` holds back.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VelocityCap {
    pub max_velocity_mm_s: f64,
    /// The fastest feed the G-code asks for above the cap.
    pub fastest_feed_mm_s: f64,
    /// Share of the toolhead's path, travel included, that runs at the cap.
    pub capped_share: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureEstimate {
    pub kind: String,
    pub seconds: f64,
    pub filament_mm: f64,
    pub filament_g: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareEstimate {
    pub label: String,
    pub seconds: f64,
    pub filament_g: f64,
    pub by_feature: Vec<FeatureEstimate>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlendScore {
    /// Higher is a shorter print. Fed by the time estimator.
    pub speed: f64,
    /// Higher uses less filament. Fed by the mass estimator.
    pub efficiency: f64,
    /// Structural proxy (walls and pattern). Lightning scores below gyroid.
    pub toughness: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshInfo {
    /// Triangles the planner contoured. Every triangle of the mesh is cut.
    pub triangles: usize,
    /// Each layer's outline stays within this distance of the true cut, in
    /// millimetres. `0` when outline simplification is off.
    pub outline_tolerance_mm: f64,
    pub min: [f64; 3],
    pub max: [f64; 3],
    /// Layers whose contour closed a mesh gap. The cut already counts these.
    pub repaired_layers: usize,
    /// Open chains the cut could not close. Their outline is lost.
    pub dropped_chains: usize,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageTimes {
    pub contour_ms: f64,
    pub support_ms: f64,
    /// Parallel per-layer walls, infill, and overhang split. Inside `core_ms`.
    pub toolpath_ms: f64,
    /// Serial travel order: island tour, seams, and scarf. Inside `core_ms`.
    pub order_ms: f64,
    /// Parallel combing and z-hop after the order is set. Inside `core_ms`.
    pub comb_ms: f64,
    /// G-code writer. Inside `core_ms`.
    pub emit_ms: f64,
    /// Z-bucket build before the parallel cut. Inside `contour_ms`'s caller, not inside `contour_ms`.
    #[serde(default)]
    pub index_ms: f64,
    /// Sum of per-layer cut time. Parallel, so this can exceed `contour_ms`.
    #[serde(default)]
    pub cut_cpu_ms: f64,
    /// Sum of per-layer outline simplify time. Parallel, so this can exceed `contour_ms`.
    #[serde(default)]
    pub simplify_cpu_ms: f64,
    /// Roof-distance booleans. Inside `core_ms`, outside the named stage sum.
    #[serde(default)]
    pub roof_ms: f64,
    /// Sum of per-layer wall offset time inside `toolpath_ms`.
    #[serde(default)]
    pub wall_cpu_ms: f64,
    /// Sum of per-layer infill and gap-fill time inside `toolpath_ms`.
    #[serde(default)]
    pub infill_cpu_ms: f64,
    /// Layer bands and cache keys of every object, before the cut. Inside `core_ms`.
    #[serde(default)]
    pub bands_ms: f64,
    /// Serial pass before the parallel toolpaths: interior depths and the
    /// lightning forest. Inside `core_ms`, outside `toolpath_ms`.
    #[serde(default)]
    pub prep_ms: f64,
    /// Plate join, kept-plate stamps, layer actions, and the part audit, up to the emit. Inside `core_ms`.
    #[serde(default)]
    pub join_ms: f64,
    /// Stages taken from memory instead of computed, in pipeline order:
    /// `contours`, `toolpaths`, `order`, `comb`, `supports` (grown), and
    /// `supportPaths`. Their clocks above read zero.
    #[serde(default)]
    pub reused: Vec<&'static str>,
    /// Leading edits whose result was already in memory.
    #[serde(default)]
    pub edits_reused: u32,
    /// Pruning and regrowing the edits applied in this request.
    #[serde(default)]
    pub edit_apply_ms: f64,
    /// Repainting the support layers those edits changed.
    #[serde(default)]
    pub edit_refresh_ms: f64,
    /// Layers whose travel order, combing, and z-hop came from the kept
    /// slice because their supports and the nozzle's way in were the same.
    #[serde(default)]
    pub layers_reused: u32,
    /// Layers of a part stage that ran again but took them from a kept
    /// slice, because the only change was overrides that miss them: their
    /// toolpaths, their tour (same paths from the same start), and their
    /// combing (same tour). A stage reused whole is in `reused` instead.
    #[serde(default)]
    pub toolpath_layers_reused: u32,
    #[serde(default)]
    pub order_layers_reused: u32,
    #[serde(default)]
    pub comb_layers_reused: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sanity {
    pub ok: bool,
    pub layers: usize,
    pub extrusion_moves: usize,
    pub travel_moves: usize,
    pub final_e: f64,
    pub extrusion_length_mm: f64,
    pub travel_length_mm: f64,
    pub min_x: f64,
    pub max_x: f64,
    pub min_y: f64,
    pub max_y: f64,
    pub notes: Vec<String>,
    pub retracts: usize,
    pub z_hops: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewLayer {
    pub index: usize,
    pub z: f64,
    pub height: f64,
    pub note: String,
    pub speed_walls: u32,
    pub toughness_walls: u32,
    pub support_paths: u32,
    /// Estimator seconds for this layer.
    #[serde(default)]
    pub seconds: f64,
    /// What the layer's feeds were scaled by to reach the minimum layer time.
    /// Left out when the layer kept its feeds.
    #[serde(default = "default_one", skip_serializing_if = "is_one")]
    pub slow: f64,
    /// Sent as columns (see `path_columns`), not one object per path.
    #[serde(serialize_with = "path_columns")]
    pub paths: Vec<PreviewPath>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewPath {
    pub kind: String,
    pub strategy: String,
    pub pts: Vec<[f64; 2]>,
    pub width: f64,
    pub speed: f64,
    /// Feed after the volumetric cap, mm/s.
    #[serde(default)]
    pub effective_speed: f64,
    /// Strategy toughness weight, 0 (speed) to 1 (toughness).
    #[serde(default)]
    pub toughness: f64,
    /// Absolute nozzle Z per preview point. Empty means the layer Z.
    #[serde(default)]
    pub zs: Vec<f64>,
    /// Vertical bead size. `0` means the layer height.
    #[serde(default)]
    pub bead_height: f64,
    /// Index of the plate object it prints, in that object's part frame.
    #[serde(default)]
    pub object: u16,
}

/// Milliseconds to contour every layer with the Z index, then with a full triangle scan.
/// Wall-clock time to cut every 0.2 mm layer of `mesh` through the Z index.
pub fn contour_times(mesh: &Mesh, layer_height: f64) -> Result<f64, String> {
    let (_, max) = mesh.bounds().ok_or("empty mesh")?;
    let mut zs = Vec::new();
    let mut z = layer_height;
    while z < max[2] + 1e-6 {
        zs.push(z);
        z += layer_height;
    }
    let index = ZIndex::build(mesh);
    let started = Instant::now();
    let _: Vec<_> = zs.par_iter().map(|z| index.slice(*z)).collect();
    Ok(elapsed_ms(started))
}
