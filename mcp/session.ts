/**
 * One stdio connection is one plate. The engine is behind `Engine`.
 * Feasibility refusals are `{ok:false, reason}` and are decided before apply.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { base64ToBytes, bytesToBase64 } from "../src/base64.ts";
import { coverageWarning, fnv1aHex, inAirWarning, meshKeyHex } from "../src/slice-action.ts";
import { fanDefaults } from "../src/fan.ts";
import { filamentGrams, groupFeatures } from "../src/estimate.ts";
import { humanEngineError } from "../src/engine-wording.ts";
import { foreign3mfMessage, foreignSlicer3mf } from "../src/foreign-3mf.ts";
import { meshWarningText, type MeshRepair } from "../src/app/mesh-warning.ts";
import { plainModelError } from "../src/app/model-error.ts";
import { hullOf, layFlatMatrix, restPose } from "../src/bed-rest.ts";
import { align, centeringShift, encode3mf, ID_MATRIX, matMul, offBed, placeMesh, rotX, rotY, rotZ, scaledCanonical, settleBy, type Bounds, type Mat3, type RigidPose } from "../src/mesh-place.ts";
import { decodeSolid } from "../src/model-reply.ts";
import { alignDelta, bedBox, isAlignRelation } from "../src/place-snap.ts";
import { boxGap, disjointBoolean, primitiveBox, probeFromBody, probeKey, probeNote, turnedAxis, type ProbedTool } from "../src/model-feasibility.ts";
import { builtBranch, crossEdit, editRefusal, forked, replayChain, stepIds, type ForkStep, type ToolLink } from "../src/model-edit.ts";
import { clampPieces, type FillContext, type Target } from "../src/modeling/partition.ts";
import { couponFileName, fitCoupon, fitCouponRequest, readCouponReply } from "../src/modeling/fit-coupon.ts";
import { choiceAt, jointDown, jointPlanes } from "../src/modeling/joint-down.ts";
import { bedFrame, exportedCommit, exportedNote, exportsPieces, PLAN_KIND, planPartition, plateUp, readPartition, storedPartition } from "./partition.ts";
import { pieceNames, SUPPORT_NOTE } from "../src/modeling/partition-export.ts";
import { dropRefusal } from "../src/model-history.ts";
import { SCREWS, throughLength } from "../src/model-hole.ts";
import { extentAlong, facePlane, splitBase, splitNote, tiltRings, type SplitPlan, type Vec3 as PlaneVec } from "../src/model-plane.ts";
import { isPrimitiveKind, rootSpec, type PrimitiveSpec } from "../src/model-primitive.ts";
import { readFingerprint } from "../src/model-reply.ts";
import { applyRequest, crossEditRequest, editRequest, exportRequest, extrudeOp, faceExtrudeOp, gotoRequest, isBrep, joinOp, keepSketch, loftOp, moveFacesOp, newSolidRequest, openRequest, probeRequest, revolveOp, shellOp, solidFileName, stepEdges, wholeTreeRequest, type ProfileShape } from "../src/model-request.ts";
import { sweepSections, type SweepSpec } from "../src/modeling/sweep.ts";
import { thinWalls } from "../src/modeling/thin.ts";
import { AnchorError, anchorRow, hasAnchor, movedBox, opBox, resolveAnchors, unionBox, type Box } from "../src/modeling/anchors.ts";
import { expandOps, type PartDef } from "../src/modeling/macro.ts";
import { applyPose, IDENTITY_POSE, inversePose, isIdentity, toSolidOp, turnDir, type Affine } from "../src/model-space.ts";
import { dropped, jumped, keptSteps, newTree, opLabel, pathTo, redoTarget, renumberedSteps, reserveId, rootLabel, undoTarget, withChild, withNode, type PartitionModelOp, type EdgePick, type Fingerprint, type GroupOp, type LoftSection, type ModelOp, type ModelTree, type NodeId, type ProfileLoop, type ProfileSegment, type Vec2 } from "../src/model-tree.ts";
import { DEFAULT_PRESET, presetKeys, type PresetSettings } from "../src/presets.ts";
import { meshRecord, readParameters, type LimeProject, type ProjectPlacement, type ProjectProfile } from "../src/project.ts";
import { decodeProject, encodeProject, finishProject, prepareProject } from "../src/project-codec.ts";
import { geometryHash, projectSummary, thumbnailFromPng } from "../src/project-thumb.ts";
import { savedTree, loadedTree, toolFirst, withSavedNames } from "../src/model-tree-file.ts";
import { addRange, addVolume, emptyOverrides, freshOverrideId, removeRange, removeVolume, type OverrideDocument, type SettingOverride } from "../src/overrides.ts";
import { appendEdit, editRequestFields } from "../src/support-edit-list.ts";
import type { EditEntry } from "../src/support-edit-list.ts";
import { indexSkeleton, selectLimbs, sitesOf } from "../src/support-pick.ts";
import type { CoverageGap, SupportSkeleton } from "../src/support-edits.ts";
import { diskFromHit, MAX_PAINT_DISKS, paintCounts, paintRequestFields, type PaintDisk, type PaintKind } from "../src/support-paint.ts";
import { seamRequestFields, type SeamDisk } from "../src/seam-paint.ts";
import { addDiskToRegion, MAX_REINFORCE_REGIONS, normalInfillDensity, reinforcementRequestFields, totalReinforceDisks, type ReinforceDisk, type ReinforceRegion } from "../src/reinforcement.ts";
import { coverRegion, onSelection, selectTriangles, type RegionQuery } from "../src/paint-region.ts";
import type { PathColumns } from "../src/preview-wire.ts";
import { readsStress, type ColorMode } from "../src/colors.ts";
import { parseStressCells, type StressCells } from "../src/sim/stress-cells.ts";
import { patternBlend } from "../src/sim/pattern-patch.ts";
import { resolved } from "../src/strategy.ts";
import { ARRANGE_GAP_MM, arrangedObjects, sourceFrame, slicePlateFields, settingsEmpty, type PlateObject as SliceObject, type PlateObjectSettings } from "../src/plate.ts";
import { recipeRefusal, simRecipe } from "../src/sim/recipe.ts";
import { chooseStudyMesh, STUDY_MESH_REFUSAL, type StudyMesh } from "../src/sim/study-mesh.ts";
import { beltLayerNormal, cloneStudy, namesFaces, placeRegion, readRegion, type ObjectStudy, type SimRepresentation, type StudyConstraint, type StudyHold, type StudyLoad, type StudyRegion, type Vec3 as SimVec } from "../src/sim/study.ts";
import { LABEL } from "../src/sim/label.ts";
import { readBeadSection, withBeads } from "../src/sim/cards.ts";
import {
  BEAM_SIZE,
  OPEN_MESH,
  SLICED_FIELD,
  SLICED_SWEEP,
  RESLICE_BEAM,
  RESLICE_PARAMETERS,
  RESLICE_PATTERN_KEEP,
  SWEEP_CAP,
  SWEEP_REFUSAL,
  ZERO_AXIS,
  axisLength,
  boxPositions,
  constraintVerdict,
  elementRefusal,
  pageCursor,
  pageLimit,
  readLimits,
  readPatch,
  representationOf,
  runSolver,
  scaleLoads,
  setupSentence,
  solverJob,
  vec3Of,
  type ConstraintLimits,
  type SweepPatch,
} from "./sim.ts";
import { orderFields, sequentialClearance, settingsRules, tallestLast, type PrintOrder } from "../src/settings-rules.ts";
import type { LayerAction } from "../src/layer-actions.ts";
import { CURVED_FACE, GLOBAL_WORKPLANE, drillDown, workplaneIn, workplaneOwn, isGlobalFrame, localPoint, planePoint, planePrimitive, workplaneOnBed, workplaneOnFace, type Workplane } from "../src/workplane.ts";
import { eulerOrient, orientEuler } from "../src/mesh-place.ts";
import { plateFileIsVersion2 } from "../src/plate.ts";
import { advanceFor, builtinLibrary, adoptProfile, cardsOf, enginePrinter, exportOnlyRefusal, fileFromSelection, heatFor, printerTarget, targetPrinter, parseMachineFile, saveMaterialCard, serializeMachineFile, setAdvance, setFlow, setGcode, setNozzleTemp, setRetract, type FilamentRecord, type MachineLibrary, type PrinterRecord } from "../src/ui/machine-library.ts";
import { parseSettingsProfile, profileFileName, serializeSettingsProfile } from "../src/ui/settings-profiles.ts";

import { openInApp, systemOpener, type AppOpener } from "./app-open.ts";
import { mirror, type BridgeLink } from "./bridge-client.ts";
import { occtHint, ProtocolError, withMesh, type Engine } from "./engine.ts";
import { appVersion, exportGcode, mass } from "./export-gcode.ts";
import { layerPaths, pathsPng, type LayerStress, pathsSvg } from "./layer-out.ts";
import { renderMesh, readCamera, type Camera, type CameraSpec, type RenderOptions } from "./render.ts";
import { imagesOf, pngImage, withImages, type InlineImage } from "./inline.ts";
import { planProblem, resolveReferences, type PlanStep } from "./plan.ts";
import { printFrame } from "../src/model-check.ts";
import { checkInSource, printCheck, probeMetrics, solidMetrics, surfaceAt as surfaceAtSolid, toolMesh, type SolidMetrics } from "./inspect.ts";
import { applyPreset, blendOf, sessionSliceRequest, stlBytes } from "./request.ts";
import { shellGroups, takeGroups } from "../src/mesh-shells.ts";
import { offsetInPlace, pieceFileName, separateBy, solidNames, stepSolidHint } from "../src/step-solids.ts";
import { reviewGcode } from "./review.ts";
import { GUIDES, guideByUri } from "./guides.ts";
import { GROUP_NAMES, groupOf, groupsOptedIn, TOOL_GROUPS } from "./groups.ts";
import { applyObjectSetting, applySetting, inactiveWarning, isObjectKey, settingRows, type ObjectSettingKey } from "./settings-rows.ts";
import { standRegion } from "./plane-region.ts";
import { closeCracks, edgeReport } from "../src/mesh-check.ts";
import { lostVolume, notClosedReason, touchingEdges, touchingReason } from "./step-guard.ts";
import { edgesMatching, facesMatching } from "./selectors.ts";
import { settingsRangeError } from "./settings-check.ts";
import { edgeGeometry, faceRows } from "./solid-geometry.ts";
import { annotationsFor, EXPRESSION_TOOLS, OP_KINDS, OP_SUMMARY, OP_WORDS, opSchemaFor, validateTool } from "./schema.ts";
import { autosavePath, takePreviousAutosave, writeAutosave, type PreviousAutosave } from "./autosave.ts";
import { addsPiece, anchorOf, cleanOp, cutsOffPiece, withBoxAnchor, pieceReport, separateReason, splitReason, COMPOSITE_KINDS, expand, faceFrame, featureCopies, isComposite, MAX_PIECES, primitiveFrom, shortenedBoxes, TOUCH_TRIM, readVec3, type ExpandContext, type Piece } from "../src/modeling/compose.ts";
import { expandContextFromSolid, type FrameFace } from "../src/modeling/frames.ts";
import { evaluateTable, isPlainNumber, withExprs } from "../src/modeling/params.ts";
import { featureLabel, featureSolidInModel, isFeatureTool, posedContext } from "../src/model-features.ts";
import { repeatLabel } from "../src/model-repeat.ts";
import { ExprError, PARAM_NAME, evaluate, resolveNumbers } from "../src/modeling/expr.ts";
import { resolveRead, resolveWorkspaceFile, resolveWrite } from "./workspace.ts";

const OVERLAP = "These parts overlap. Move one before slicing.";
const CHORD = 0.05;
const STEP = 0.05;
const SLICE_WAIT_DEFAULT_S = 20;
const SLICE_WAIT_MAX_S = 120;
const STALE_SLICE = "The printer, filament, settings, or placement changed after this slice. Slice again.";
const MESH_EDIT = "Model edits need a STEP file or a new solid. This part is a mesh.";
const UNKNOWN_OBJECT = "That object is not on the plate. Call plate_list for the current handles.";
/** --- D25. Expression text, so an MCP step keeps the expressions it was typed with, as an app step keeps a field's. */
function exprText(value: unknown): string | null {
  return typeof value === "string" && value.trim() && !isPlainNumber(value) ? value.trim() : null;
}

/** The app field each typed number lands in, by op kind; a diameter is halved into the radius the op stores. */
const OP_EXPR_FIELDS: Record<string, readonly (readonly [string, string, boolean?])[]> = {
  root: [["dx", "modelDx"], ["dy", "modelDy"], ["dz", "modelDz"], ["radius", "modelRadius"], ["height", "modelHeight"], ["topRadius", "modelTopR"], ["tubeRadius", "modelTube"], ["innerRadius", "modelInnerR"], ["topX", "modelTopX"], ["sides", "modelSides"], ["across", "modelAcross"]],
  boolean: [["dx", "modelDx"], ["dy", "modelDy"], ["dz", "modelDz"], ["radius", "modelRadius"], ["height", "modelHeight"], ["topRadius", "modelTopR"], ["tubeRadius", "modelTube"], ["innerRadius", "modelInnerR"], ["topX", "modelTopX"], ["sides", "modelSides"], ["across", "modelAcross"]],
  hole: [["diameterMm", "modelHoleR", true], ["depth", "modelHoleD"], ["counterboreDiameterMm", "modelBoreR", true], ["counterboreDepth", "modelBoreD"]],
  fillet: [["size", "modelBlend"]],
  chamfer: [["size", "modelBlend"]],
  shell: [["thickness", "modelShell"]],
  scale: [["factor", "modelFactor"]],
  extrude: [["depth", "depth"], ["depth2", "depth2"], ["draftDeg", "draftDeg"]],
  revolve: [["angleDeg", "angle"]],
};
const FEATURE_EXPR_FIELDS: readonly (readonly [string, string])[] = [["width", "modelFeatW"], ["height", "modelFeatH"], ["depth", "modelFeatDepth"], ["diameter", "modelFeatDia"], ["grooveWidth", "modelTexGroove"]];

/**
 * The expression fields of one typed op, keyed as the app's panel stores them (`op.exprs`), so the app's Rebuild and
 * its out-of-date mark follow a parameter the MCP named. A placement (origin, centre, turn) is left out: the stored op
 * is in the solid's frame, so its numbers are not the typed ones on a moved part.
 */
export function typedExprs(op: unknown): Record<string, string> | undefined {
  if (!op || typeof op !== "object" || Array.isArray(op)) return undefined;
  const raw = op as Record<string, unknown>;
  const out: Record<string, string> = {};
  const kind = typeof raw.kind === "string" ? raw.kind : "";
  if (kind === "pocket" || kind === "boss" || kind === "texture" || kind === "array" || kind === "ribs" || kind === "text") {
    for (const [field, key] of FEATURE_EXPR_FIELDS) {
      const text = exprText(raw[field]);
      if (text) out[key] = text;
    }
    const at = raw.at as Record<string, unknown> | undefined;
    const u = exprText(at?.u);
    const v = exprText(at?.v);
    if (u) out.modelFeatU = u;
    if (v) out.modelFeatV = v;
    const bars = raw.bars as Record<string, unknown> | undefined;
    for (const [field, key] of [["vertical", "modelFeatBarsV"], ["horizontal", "modelFeatBarsH"], ["width", "modelFeatBarW"]] as const) {
      const text = exprText(bars?.[field]);
      if (text) out[key] = text;
    }
    const pitch = raw.pitch;
    const pu = exprText(Array.isArray(pitch) ? pitch[0] : pitch);
    const pv = exprText(Array.isArray(pitch) ? pitch[1] : pitch);
    if (pu) out.modelTexPitchU = pu;
    if (pv) out.modelTexPitchV = pv;
  } else {
    // A primitive placed by its centre grows from its corner when a size is rebuilt, so it keeps no size expression.
    if ((kind === "boolean" || kind === "root") && raw.centre !== undefined) return undefined;
    for (const [field, key, half] of OP_EXPR_FIELDS[kind] ?? []) {
      const text = exprText(raw[field]);
      if (text) out[key] = half ? `(${text}) / 2` : text;
    }
    // The fields primitiveFrom derives from dx and dz when they are left out follow them too.
    if (kind === "boolean" || kind === "root") {
      const dx = exprText(raw.dx);
      const primitive = typeof raw.primitive === "string" ? raw.primitive : "box";
      const readsRadius = ["cylinder", "cone", "tube", "sphere", "torus"].includes(primitive);
      const readsHeight = ["cylinder", "cone", "tube", "polygon"].includes(primitive);
      if (dx && raw.dy === undefined) out.modelDy = dx;
      if (dx && raw.dz === undefined && (primitive === "sphere" || primitive === "ellipsoid")) out.modelDz = dx;
      if (dx && raw.radius === undefined && readsRadius) out.modelRadius = `(${dx}) / 2`;
      if (raw.height === undefined && out.modelDz && readsHeight) out.modelHeight = out.modelDz;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Whether a tool can change what the autosave holds: the plate, its objects, their histories and paint. Settings,
 * slices, exports, and machines are not in it, so they never cost a save.
 */
function changesPlate(name: string): boolean {
  if (name === "model_export_step" || name === "model_check" || name === "model_params" || name === "model_define") return false;
  if (name === "sim_setup" || name === "sim_sweep") return true;
  return /^(model_|object_|plate_|paint_|workplane_|support_edit|reinforce_|modifier_|range_|override_)/.test(name) || name === "solid_new" || name === "mesh_import" || name === "project_open" || name === "project_create";
}

/** Calls that can outlast a client's request timeout: the autosave is written before they start. */
// A sweep that reslices is one slice and one solve per variant.
const LONG_CALLS = new Set(["model_apply_batch", "model_build", "model_edit", "project_open", "mesh_import", "sim_sweep"]);
const NAME_LIMIT = 120;
/** Tools whose op fields may be text expressions. */

/**
 * Calls that may outrun the client's request timeout (Claude Code's is 60 s, and it then restarts the server). One that
 * has not answered after `replySeconds()`, or whose request the client cancels, goes on as a background job instead:
 * the reply is a job handle for slice_wait, and the work finishes or, with slice_cancel, is taken back.
 */
const DETACHABLE = new Set([
  "model_apply", "model_apply_batch", "model_build", "model_edit", "model_goto", "model_undo", "model_redo", "model_commit",
  "model_probe", "project_open", "project_save", "app_open", "mesh_import", "solid_new", "slice_start", "export_3mf", "model_export_step",
  "sim_run", "sim_sweep",
]);

/** What may run while a background job does: reads that do not touch the modeler, and the job's own wait and cancel. */
const WHILE_BUSY = new Set([
  "session_info", "guide", "tools_enable", "plate_list", "slice_wait", "slice_cancel", "model_history", "settings_schema", "machine_list",
  "machine_get", "overrides_list", "layer_actions_list", "paint_list", "gcode_summary", "gcode_read", "layer_summary",
  "layer_detail", "mesh_stats", "support_trees",
]);

/** Detachable calls that change no part: a cancelled one is simply left to finish. */
const CHANGES_NOTHING = new Set(["model_probe", "project_save", "app_open", "export_3mf", "model_export_step"]);

/** Seconds a detachable call runs before it answers with a job instead: under a 60 s client timeout. */
function replySeconds(): number {
  const raw = Number(process.env.LIME_MCP_REPLY_S);
  return Number.isFinite(raw) && raw > 0 ? raw : 45;
}

/** Carried with one tools/call: a progress token, and cancel for that request. */
export interface CallMeta {
  progressToken?: string | number;
  signal?: AbortSignal;
  /** How far the work is, for a job's wait: the last fraction and stage it reported. */
  fraction?: number;
  stage?: string;
}

/** A detachable call that outran its reply: it runs on, and slice_wait returns its result. */
interface WorkJob {
  handle: string;
  tool: string;
  object?: string;
  started: number;
  ctx: CallMeta;
  stop: AbortController;
  /** A run of ops (a batch, a build, a composite) stops after the step it is on; anything else finishes. */
  stoppable: boolean;
  settled: Promise<void>;
  done: boolean;
  result?: Record<string, unknown>;
  error?: string;
}

/** `layer_image` coloured by stress before any sliced study. */
/** The targets `lime-sim` reads. A band kind takes `band`; the stiffness kinds need a region. */
const TARGET_KINDS = ["minSafetyFactor", "maxDeflectionMm", "deflectionBandMm", "minStiffnessNPerMm", "stiffnessBandNPerMm", "relativeDeflectionMm", "maxMassG", "minMassG"];
const BAND_KINDS = new Set(["deflectionBandMm", "stiffnessBandNPerMm"]);
const STIFFNESS_KINDS = new Set(["minStiffnessNPerMm", "stiffnessBandNPerMm"]);
const REGION_SHAPE = "A region is {faces:[...]}, {sphere:{centre, radiusMm}}, or {box:{min, max}}, in the model frame.";
export const STALE_FACES = "The part changed since this study was set up. Pick the faces again, or give the regions as a sphere or a box.";
const PLACE_ON_SMEAR = "A sphere or box region is read on a sliced study. Hold and load faces on a smear.";
const STRESS_LAYER_NEEDS ="Run sim_run on a sliced study of this object, then colour by stress or safety.";
const BEADS_REFUSAL = "A card's beads need every modulus and strength above 0, and a bridgeFactor above 0 and at most 1.";

export interface PlateObject {
  id: string;
  name: string;
  fileName: string;
  bytes: Uint8Array;
  source: Float32Array;
  triangles: number;
  orient: Mat3;
  scale: number;
  centered: boolean;
  offset: { x: number; y: number; z: number };
  seatMm: number;
  stepTolerance: number;
  note?: string;
  modelPose: Affine;
  workplane: Workplane;
  tree: ModelTree | null;
  /** The modeler was restarted under this tree: it is rebuilt from its root and ops at its current step on next use. */
  treeStale?: boolean;
  /** Why the last commit's mesh does not close, when it committed anyway because the part came in open. */
  commitWarning?: string;
  solid: ReturnType<typeof rememberSolid> | null;
  probes: Map<string, true>;
  supportEdits: EditEntry[];
  supportPaint: PaintDisk[];
  seamPaint: SeamDisk[];
  reinforcement: ReinforceRegion[];
  objectSettings: PlateObjectSettings;
  /** The history node `bytes` was meshed from. Null until a commit writes it. */
  platedNode: number | null;
  /**
   * The committed solid (`platedNode`) as the engine writes it in `brep`, beside `bytes`, which is then an STL of the
   * kernel's own mesh of it: the app's convention. A project saved before version 3 holds STEP here, which still opens.
   * The slicer never reads it: a Model solid's plate mesh is the kernel's mesh, not a re-read of a file.
   */
  brep?: Uint8Array;
  /** Runs of steps one composite edit or batch made: undo takes the whole run back. */
  groups?: { start: number; end: number; label: string }[];
  /** The run undo last took back, so redo can bring it all again. */
  undoneGroup?: { start: number; end: number; label: string };
  /**
   * What model_build ran on this object: its base, the node before the ops, and for each op its key, the node after it
   * (null when it was left out), and its first node. A later build with the same base resumes from the longest
   * matching run of ops.
   */
  buildLog?: { base: string; start: number; steps: { key: string; node: number | null; first: number | null }[]; refused: boolean };
  /** The model_build call this object came from, before expansion: rerun it with new parameters, and saved with the project. */
  recipe?: Recipe;
  /** Stress study. Absent until sim_setup. Not sent to the slicer. */
  sim?: ObjectStudy;
}

/** A model_build's base, ops, parameters, and name, as typed. */
export interface Recipe {
  base: unknown;
  ops: unknown;
  params: Record<string, unknown>;
  name?: string;
}

interface Ghost {
  mesh: Float32Array;
  touches: boolean;
}

interface Job {
  handle: string;
  engineId: number;
  objectId: string;
  stamp: string;
  status: string;
  gcode?: string;
  wire?: Record<string, unknown>;
  error?: string;
}

interface SliceSummary {
  seconds: number;
  grams: number;
  filamentMm: number;
  cost: number;
  warnings: string[];
  features: { label: string; seconds: number; grams: number }[];
  layerSeconds: number[];
  layers: { z: number; seconds?: number }[];
}

type SolidView = NonNullable<ReturnType<typeof rememberSolid>>;

/** --- Split to print. The kernel's sentence for each piece whose number had no room. */
function numberNotes(reply: Record<string, unknown>): string[] {
  return Array.isArray(reply.notes) ? reply.notes.filter((note): note is string => typeof note === "string") : [];
}

/**
 * --- Split to print, milestone 5. The connectors the kernel built and left out, in model space: each placed one's id,
 * centre and whether its holes got the teardrop roof; each dropped one's id and sentence.
 */
function joined(reply: Record<string, unknown>, pose: Affine): { connectors?: { placed: { id: string; at: number[]; teardrop: boolean }[]; dropped: { id: string; reason: string; sentence: string }[] } } {
  const connectors = reply.connectors as { placed?: unknown; dropped?: unknown } | undefined;
  if (!connectors || typeof connectors !== "object") return {};
  const mm = (value: number) => Math.round(value * 100) / 100 + 0;
  const placed = (Array.isArray(connectors.placed) ? (connectors.placed as { id?: unknown; at?: unknown; teardrop?: unknown }[]) : []).map((row) => ({
    id: String(row.id),
    at: Array.isArray(row.at) && row.at.length === 3 ? applyPose(pose, row.at as [number, number, number]).map(mm) : [],
    teardrop: row.teardrop === true,
  }));
  const dropped = (Array.isArray(connectors.dropped) ? (connectors.dropped as { id?: unknown; reason?: unknown; sentence?: unknown }[]) : []).map((row) => ({ id: String(row.id), reason: String(row.reason), sentence: String(row.sentence) }));
  return { connectors: { placed, dropped } };
}

/** --- Split to print, milestone 5. A probe's pins: how many, and their volume. */
function pinsOf(reply: Record<string, unknown>): { pins?: { count: number; volumeMm3: number } } {
  const pins = reply.pins as { count?: unknown; volumeMm3?: unknown } | undefined;
  if (!pins || typeof pins !== "object") return {};
  return { pins: { count: Number(pins.count) || 0, volumeMm3: Math.round(Number(pins.volumeMm3) * 1000) / 1000 } };
}

/** --- Split to print. Where each piece's number was cut, in model space: on cut N's face (from 1), or on a side face. */
function numbered(reply: Record<string, unknown>, pose: Affine): { numbers?: { part: number; faces: { face: string; cut?: number; at: number[] }[] }[] } {
  if (!Array.isArray(reply.numbers)) return {};
  const mm = (value: number) => Math.round(value * 100) / 100 + 0;
  const numbers = (reply.numbers as { part?: unknown; faces?: unknown }[]).map((row, index) => ({
    part: typeof row.part === "number" ? row.part : index + 1,
    faces: (Array.isArray(row.faces) ? (row.faces as { face?: unknown; cut?: unknown; at?: unknown }[]) : []).map((face) => {
      const at = Array.isArray(face.at) && face.at.length === 3 ? applyPose(pose, face.at as [number, number, number]).map(mm) : [];
      return { face: face.face === "side" ? "side" : "cut", ...(typeof face.cut === "number" ? { cut: face.cut + 1 } : {}), at };
    }),
  }));
  return { numbers };
}

function rememberSolid(body: Record<string, unknown>) {
  const solid = decodeSolid(body);
  if (typeof solid === "string") return null;
  return {
    id: solid.id,
    volumeMm3: solid.volumeMm3,
    editable: solid.editable,
    fingerprint: solid.fingerprint,
    positions: Float32Array.from(solid.positions),
    triangles: Uint32Array.from(solid.triangles),
    faces: faceRows(solid.positions, solid.triangles, solid.faces),
    edges: solid.edges.map((edge) => ({ index: edge.id, lengthMm: edge.lengthMm, ...edgeGeometry(edge.points, edge.lengthMm) })),
    bounds: boundsOf(solid.positions),
  };
}

function boundsOf(pos: ArrayLike<number>): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = pos[i + axis] ?? 0;
      if (value < min[axis]) min[axis] = value;
      if (value > max[axis]) max[axis] = value;
    }
  }
  if (!Number.isFinite(min[0])) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min, max };
}

function positionsFrom(encoded: string): Float32Array {
  const bytes = Buffer.from(encoded, "base64");
  const copy = new Uint8Array(bytes);
  return new Float32Array(copy.buffer);
}

function page<T>(items: T[], cursor: unknown, limit: unknown): { rows: T[]; nextCursor?: string } {
  const size = Math.min(100, Math.max(1, typeof limit === "number" ? limit : 20));
  const start = typeof cursor === "string" ? Number(cursor) : 0;
  const from = Number.isInteger(start) && start > 0 ? start : 0;
  const rows = items.slice(from, from + size);
  return from + size < items.length ? { rows, nextCursor: String(from + size) } : { rows };
}

function readBuilt(value: unknown): Map<number, { op: ModelOp; fingerprint: Fingerprint | null }> | null {
  if (!Array.isArray(value)) return null;
  const out = new Map<number, { op: ModelOp; fingerprint: Fingerprint | null }>();
  for (const step of value) {
    if (!step || typeof step !== "object") return null;
    const row = step as { id?: unknown; op?: unknown; fingerprint?: unknown };
    const kind = row.op && typeof row.op === "object" ? (row.op as { kind?: unknown }).kind : undefined;
    if (typeof row.id !== "number" || typeof kind !== "string") return null;
    out.set(row.id, { op: row.op as ModelOp, fingerprint: readFingerprint(row.fingerprint) });
  }
  return out;
}

function readBroken(value: unknown): { id: number; error: string } | null {
  if (!value || typeof value !== "object") return null;
  const row = value as { id?: unknown; error?: unknown };
  return typeof row.id === "number" && typeof row.error === "string" ? { id: row.id, error: row.error } : null;
}

function shownName(name: string): string {
  return name.length <= NAME_LIMIT ? name : name.slice(0, NAME_LIMIT);
}

function changedValues(rows: unknown[]): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const item = row as { key?: unknown; to?: unknown };
    if (typeof item.key === "string") values[item.key] = item.to;
  }
  return values;
}

function roundTo(value: number, places: number): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

interface SnapObject {
  id: string;
  name: string;
  fileName: string;
  bytes: Uint8Array;
  source: Float32Array;
  triangles: number;
  orient: Mat3;
  scale: number;
  centered: boolean;
  offset: { x: number; y: number; z: number };
  seatMm: number;
  stepTolerance: number;
  note?: string;
  modelPose: Affine;
  workplane: Workplane;
  supportEdits: EditEntry[];
  supportPaint: PaintDisk[];
  seamPaint: SeamDisk[];
  reinforcement: ReinforceRegion[];
  objectSettings: PlateObjectSettings;
  platedNode: number | null;
  brep?: Uint8Array;
  sim?: ObjectStudy;
}

interface PlateSnap {
  label: string;
  objects: SnapObject[];
  selected: string;
  settings: PresetSettings;
  library: MachineLibrary;
  actions: LayerAction[];
  overrides: OverrideDocument;
  printOrder: PrintOrder["printOrder"];
  clearanceMm: number;
  gantryMm: number;
}

class ModelRunaway extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelRunaway";
  }
}

function domainRefusal(message: string): { ok: false; reason: string; next?: string } | null {
  if (message.startsWith("That file was not found")) {
    return { ok: false, reason: message, next: "Check the path, then call the tool again." };
  }
  if (message.startsWith("This mesh did not finish") || message.includes("LIME_MCP_WORKSPACE") || message.startsWith("Writes stay") || message.startsWith("That path is not") || message.startsWith("That name cannot") || message.startsWith("Open a .stl") || message.startsWith("That file is")) {
    return { ok: false, reason: message };
  }
  return null;
}

function nodeHandle(id: NodeId): string {
  return `node_${id}`;
}

function parseNode(handle: unknown): number | null {
  if (typeof handle !== "string") return null;
  const match = /^node_(\d+)$/.exec(handle);
  return match ? Number(match[1]) : null;
}

/** The plate STL's name for a solid's file: the app's `stlName`. */
function stlFileName(name: string): string {
  const stem = name.replace(/\.(step|stp|stl|3mf)$/i, "");
  return `${stem || "solid"}.stl`;
}

/** A STEP file's name for a solid's file, as the app's `stepFileName` names it. */
function stepFileName(name: string): string {
  const stem = name.replace(/\.(step|stp|stl|3mf|brep)$/i, "");
  return `${stem || "solid"}.step`;
}

/** A value as text with its keys sorted, so two ops that ask the same thing have the same key. */
function stableKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableKey((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * --- A9. Steps the kernel actually builds: every history node, plus each step inside a group.
 * A group is one node, so a budget that counted only nodes would stop a long composite short.
 */
function modelSteps(tree: ModelTree): number {
  let count = 0;
  for (const node of tree.nodes.values()) {
    count += 1;
    if (node.op?.kind === "group") count += node.op.steps.length;
  }
  return count;
}

/**
 * --- 3.1 F8. Where a turned round tool's axis lies, beside its echo, and a sentence when its base left `origin`: a
 * turn is about the middle of the axis, and 198 holes once went h/2 off because a caller took origin for the pivot.
 */
function turnEcho(typed: Record<string, unknown>): Record<string, unknown> {
  if (typed.kind !== "boolean" || !isPrimitiveKind(typed.primitive) || !Array.isArray(typed.turn) || !Array.isArray(typed.origin)) return {};
  if ((typed.turn as number[]).every((value) => value === 0)) return {};
  const axis = turnedAxis(typed as unknown as PrimitiveSpec);
  if (!axis) return {};
  const at = (p: readonly number[]) => p.map((value) => Math.round(value * 1000) / 1000 + 0);
  const base = at(axis.base);
  const origin = typed.origin as number[];
  const moved = typed.centre === undefined && Math.hypot(base[0]! - origin[0]!, base[1]! - origin[1]!, base[2]! - origin[2]!) > 1e-3;
  return {
    axis: { base, top: at(axis.top) },
    ...(moved ? { turnNote: `It turns about the middle of its axis, so its base centre is at [${base.join(", ")}], not at origin. Give centre to place a turned shape by its middle.` } : {}),
  };
}

const EDGES_SHAPE = "edges is a list of edge indexes, [3, 7], or one pick object: {fromNode: \"node_4\", filter: \"convex\"} or {select: {direction, onFace, convex}}, not inside a list.";

/**
 * --- 3.1 F4. A fillet's or chamfer's `edges` as the schema takes it: one pick object written inside a list,
 * `[{fromNode, filter}]`, is that object. Several pick objects in a list, or picks mixed with indexes, are refused
 * with the shapes that are taken, before the schema check says only "edges[0] must be a number".
 */
function edgePicksAsTyped(args: unknown): { args: unknown } | { reason: string } {
  if (!args || typeof args !== "object" || Array.isArray(args)) return { args };
  const input = args as Record<string, unknown>;
  const fix = (op: unknown): { op: unknown } | { reason: string } => {
    if (!op || typeof op !== "object" || Array.isArray(op)) return { op };
    const row = op as Record<string, unknown>;
    if ((row.kind !== "fillet" && row.kind !== "chamfer") || !Array.isArray(row.edges)) return { op };
    const objects = row.edges.filter((edge) => edge !== null && typeof edge === "object");
    if (objects.length === 0) return { op };
    if (row.edges.length === 1) return { op: { ...row, edges: objects[0] } };
    return { reason: EDGES_SHAPE };
  };
  let out = input;
  if (input.op !== undefined) {
    const fixed = fix(input.op);
    if ("reason" in fixed) return fixed;
    out = { ...out, op: fixed.op };
  }
  if (Array.isArray(input.ops)) {
    const ops: unknown[] = [];
    for (const [index, op] of input.ops.entries()) {
      const fixed = fix(op);
      if ("reason" in fixed) return { reason: `ops[${index}]: ${fixed.reason}` };
      ops.push(fixed.op);
    }
    out = { ...out, ops };
  }
  return { args: out };
}

/** The history row for a composite: the label that was typed, else the feature's name, else Pattern or Mirror. */
function compositeGroupLabel(raw: Record<string, unknown>, given?: string): string {
  const typed = given?.trim();
  if (typed) return typed.slice(0, 80);
  // --- D39. The app's own row labels: "Pattern × 6 around Z", "Mirror across X".
  if (raw.kind === "pattern" || raw.kind === "mirror") return repeatLabel(raw);
  if (isFeatureTool(raw.kind)) return featureLabel(raw).slice(0, 80);
  return "Group";
}

/** The first node on the path from `from` down to `to`: the child of `from` that `to` descends from. */
function firstAfter(tree: ModelTree, from: number, to: number): number | null {
  let node: number | null = to;
  while (node !== null) {
    const parent: number | null = tree.nodes.get(node)?.parent ?? null;
    if (parent === from) return node;
    node = parent;
  }
  return null;
}

const LOOP_SHAPE = "smooth and corners are for a point profile. A loop uses arc and spline segments.";

/**
 * K1 loops, when the field is present. Absent means the op uses a point profile. A bad loop is a sentence.
 */
function readLoopsField(value: unknown): { loops?: ProfileLoop[] } | { reason: string } {
  if (value === undefined) return {};
  if (!Array.isArray(value) || value.length < 1) return { reason: "A profile needs a loop." };
  if (value.length > 32) return { reason: "A profile takes at most 32 loops." };
  const loops: ProfileLoop[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || !Array.isArray((raw as { segments?: unknown }).segments)) return { reason: "A loop needs a start and its segments." };
    const spec = raw as Record<string, unknown>;
    const start = pairOf(spec.start);
    if (!start) return { reason: "A loop starts at [u, v]." };
    const pieces = spec.segments as unknown[];
    if (pieces.length < 1) return { reason: "A loop needs a segment." };
    if (pieces.length > 200) return { reason: "A loop takes at most 200 segments." };
    const segments: ProfileSegment[] = [];
    for (const seg of pieces) {
      if (!seg || typeof seg !== "object") return { reason: "A loop segment is incomplete." };
      const piece = seg as Record<string, unknown>;
      const to = pairOf(piece.to);
      if (!to) return { reason: "A loop segment ends at [u, v]." };
      if (piece.kind === "line") {
        if (piece.through !== undefined) return { reason: "A line has no point between its ends." };
        segments.push({ kind: "line", to });
      } else if (piece.kind === "arc") {
        const through = pairOf(piece.through);
        if (!through) return { reason: "An arc needs one point between its ends." };
        segments.push({ kind: "arc", through, to });
      } else if (piece.kind === "spline") {
        if (!Array.isArray(piece.through) || piece.through.length < 1) return { reason: "A spline needs a point between its ends." };
        const through: Vec2[] = [];
        for (const point of piece.through) {
          const at = pairOf(point);
          if (!at) return { reason: "A spline's points are [u, v]." };
          through.push(at);
        }
        segments.push({ kind: "spline", through, to });
      } else {
        return { reason: "A segment kind is line, arc, or spline." };
      }
    }
    loops.push({ start, segments });
  }
  return { loops };
}

function pairOf(value: unknown): Vec2 | null {
  if (!Array.isArray(value) || value.length !== 2 || !value.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return [value[0] as number, value[1] as number];
}

/** A profile's smooth and corners fields: corners are indexes into its points, and need smooth. */
function readShape(spec: Record<string, unknown>, points: number): ProfileShape | { reason: string } {
  if (spec.smooth !== undefined && typeof spec.smooth !== "boolean") return { reason: "smooth is true or false." };
  if (spec.corners === undefined) return { smooth: spec.smooth === true };
  if (spec.smooth !== true) return { reason: "corners mark the sharp points of a smooth profile. Add smooth: true." };
  if (!Array.isArray(spec.corners) || !spec.corners.every((c) => Number.isInteger(c) && c >= 0 && c < points)) {
    return { reason: `corners are indexes of profile points, 0 to ${points - 1}.` };
  }
  return { smooth: true, corners: [...new Set(spec.corners as number[])] };
}

/** One loft section: origin and turn as a profile's plane, then a radius (radiusV for an ellipse) or a profile. */
function readSection(value: unknown): LoftSection | { reason: string } {
  if (!value || typeof value !== "object") return { reason: "A section is an object with origin and a radius or a profile." };
  const spec = value as Record<string, unknown>;
  const origin = readVec3(spec.origin, [NaN, NaN, NaN]);
  if (origin.some((n) => !Number.isFinite(n))) return { reason: "A section needs an origin [x, y, z]." };
  const turn = readVec3(spec.turn, [0, 0, 0]);
  const loops = readLoopsField(spec.loops);
  if ("reason" in loops) return loops;
  if (loops.loops) {
    if (spec.radius !== undefined || spec.profile !== undefined) return { reason: "A section takes a radius, a profile, or loops, not more than one." };
    if (spec.smooth !== undefined || spec.corners !== undefined) return { reason: LOOP_SHAPE };
    return { origin, turn, loops: loops.loops };
  }
  if (spec.radius !== undefined) {
    if (spec.profile !== undefined) return { reason: "A section takes a radius or a profile, not both." };
    if (typeof spec.radius !== "number" || !(spec.radius > 0)) return { reason: "A section's radius is above 0." };
    if (spec.radiusV !== undefined && (typeof spec.radiusV !== "number" || !(spec.radiusV > 0))) return { reason: "radiusV is above 0." };
    return { origin, turn, radius: spec.radius, ...(typeof spec.radiusV === "number" ? { radiusV: spec.radiusV } : {}) };
  }
  const profile = readProfile(spec.profile);
  if (!profile) return { reason: "A section needs a radius, or a profile of at least three [u, v] points." };
  const shape = readShape(spec, profile.length);
  if ("reason" in shape) return shape;
  return { origin, turn, profile, ...(shape.smooth ? { smooth: true as const } : {}), ...(shape.corners?.length ? { corners: [...shape.corners] } : {}) };
}

/** A closed outline of at least three [u, v] points, or null. */
function readProfile(value: unknown): Vec2[] | null {
  if (!Array.isArray(value) || value.length < 3 || value.length > 200) return null;
  const out: Vec2[] = [];
  for (const point of value) {
    if (!Array.isArray(point) || point.length !== 2 || !point.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
    out.push([point[0] as number, point[1] as number]);
  }
  return out;
}

function isObject(value: PlateObject | { ok: false; reason: string }): value is PlateObject {
  return !("reason" in value);
}

function xyGap(a: Bounds, b: Bounds): number {
  const sep = (low: number, high: number, otherLow: number, otherHigh: number) => (high <= otherLow ? otherLow - high : otherHigh <= low ? low - otherHigh : 0);
  const dx = sep(a.min[0], a.max[0], b.min[0], b.max[0]);
  const dy = sep(a.min[1], a.max[1], b.min[1], b.max[1]);
  if (dx > 0 && dy > 0) return Math.hypot(dx, dy);
  return Math.max(dx, dy);
}

/**
 * The bridge reply, without the surface. Margins keep their hot spots, and each carries the region it read as the
 * caller gave it: the solver returns one margin per target, in order.
 */
function slicedRunReply(text: string, targets: readonly StudyConstraint[] = []): Record<string, unknown> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "The stress solve did not finish." };
  }
  if (parsed.ok !== true) {
    return { ok: false, reason: typeof parsed.reason === "string" && parsed.reason ? parsed.reason : "The stress solve did not finish." };
  }
  const report = parsed.report && typeof parsed.report === "object" ? (parsed.report as Record<string, unknown>) : null;
  if (!report) return { ok: false, reason: "The stress solve did not finish." };
  const level = report.trust === "rough" || report.trust === "usable" || report.trust === "converged" ? report.trust : "rough";
  return {
    ok: true,
    label: LABEL,
    representation: "sliced",
    trust: { level },
    notes: Array.isArray(report.notes) ? report.notes.filter((note): note is string => typeof note === "string") : [],
    margins: Array.isArray(report.margins) ? report.margins.map((row, index) => withRegion(row, targets[index])) : [],
    maxDisplacementMm: typeof report.maxDisplacementMm === "number" ? report.maxDisplacementMm : 0,
    minSafetyFactor: typeof report.minSafetyFactor === "number" ? report.minSafetyFactor : null,
    massG: typeof report.massG === "number" ? report.massG : 0,
    criterion: "max-stress",
    stale: false,
    ...sliceEstimateOf(parsed.slice),
  };
}

function withRegion(row: unknown, target: StudyConstraint | undefined): unknown {
  if (!target?.region || !row || typeof row !== "object" || Array.isArray(row)) return row;
  return { ...(row as Record<string, unknown>), region: target.region, ...(target.other ? { other: target.other } : {}) };
}

/** The slicer's estimate of the slice a sliced study solved: free, since it was sliced anyway. */
function sliceEstimateOf(value: unknown): { slicerSeconds?: number; slicerGrams?: number } {
  if (!value || typeof value !== "object") return {};
  const row = value as Record<string, unknown>;
  return {
    ...(typeof row.seconds === "number" ? { slicerSeconds: row.seconds } : {}),
    ...(typeof row.filamentG === "number" ? { slicerGrams: row.filamentG } : {}),
  };
}

export class Session {
  readonly objects: PlateObject[] = [];
  selected = "";
  settings: PresetSettings = { ...DEFAULT_PRESET };
  actions: LayerAction[] = [];
  library: MachineLibrary = builtinLibrary();
  jobs: Job[] = [];
  running: Job | null = null;
  latest: Job | null = null;
  /** Long calls that went on in the background, newest last; a few finished ones are kept for their wait. */
  private workJobs: WorkJob[] = [];
  private seq = 0;
  private jobSeq = 0;
  private readonly engine: Engine;
  private sourceProject: LimeProject | null = null;
  private sourceHash = "";
  private sourcePath = "";
  private profileTouched = false;
  private lastBridge: Record<string, unknown> | null = null;
  /** The last sliced study's cells, for `layer_image`'s stress and safety colours. */
  private stressCells: StressCells | null = null;
  private lastPreview: ReturnType<typeof rememberSolid> | null = null;
  private undoStack: PlateSnap[] = [];
  private redoStack: PlateSnap[] = [];
  private bridgeSeq = 0;
  /** This process on the bridge. The desktop starts its sequence again when it changes. */
  private readonly bridgeSession = randomUUID();
  private readonly bridgeLink: BridgeLink = { known: new Set(), resync: () => this.resyncBridge() };
  private readonly meshHashes = new WeakMap<Uint8Array, string>();
  /** STEP solids from projects saved before version 3 that a commit already tried to write again in the binary format. */
  private readonly legacySolids = new WeakSet<Uint8Array>();
  /** STEP roots a commit already tried to write as the engine's binary solid, so an engine that cannot is asked once. */
  private readonly triedRoots = new WeakSet<ArrayBuffer>();
  private generation = 0;
  private lastProgressAt = 0;
  overrides: OverrideDocument = emptyOverrides();
  private pareto: { label: string; toughness: number; seconds: number; grams: number; score: number }[] = [];
  printOrder: PrintOrder["printOrder"] = "all-at-once";
  clearanceMm = 0;
  gantryMm = 0;
  onProgress: ((job: string, fraction: number, stage: string, token?: string | number) => void) | null = null;
  /** The tool groups enabled, when the server lists groups (LIME_MCP_TOOL_GROUPS=1); null lists every tool. */
  toolGroups: Set<string> | null = groupsOptedIn() ? new Set() : null;
  /** Called when tools_enable changes the tool list, so the client is told. */
  onToolsChanged: (() => void) | null = null;
  /** Names model ops may use in place of numbers. Set with model_params; the evaluated values. */
  params: Record<string, number> = {};
  /**
   * --- A6. The same table as typed: a number, or an expression. Saved as the project's `parameters`.
   * `params` is this table evaluated, which is what ops and `model_params` return.
   */
  private paramText: Record<string, string | number> = {};
  /** Parts model_define stored, which an op list places with {kind: "use"}. */
  parts = new Map<string, PartDef>();
  /**
   * Tools a join took off the plate, as the desktop does: not printed, not listed, but their trees stay open, since
   * an edit that replays the join builds the tool again, and a save keeps them as the project's modelTools.
   */
  private toolsOffPlate: PlateObject[] = [];
  /**
   * --- Split to print. Pieces of a split to print that is not on the way to its part's current step: model_undo above
   * it takes them off the plate, and a redo brings them back (D9). Not saved.
   */
  private piecesOffPlate: PlateObject[] = [];
  /** The recipe of the model_build being called, kept from before its ops were expanded. */
  private pendingRecipe: Recipe | null = null;
  /** --- D25. Each typed op's expression fields from the call being run, by op index; set before its numbers resolve. */
  private pendingExprs: (Record<string, string> | undefined)[] = [];

  /** How app_open reaches the desktop app. Tests replace it. */
  appOpener: AppOpener = systemOpener;

  /** The autosave a previous server left in the workspace, offered until this session has a plate of its own. */
  previousAutosave: PreviousAutosave | null = null;
  private startupChecked = false;
  private autosaveDirty = false;
  private autosaveTimer: ReturnType<typeof setTimeout> | null = null;
  private autosaveWriting: Promise<void> = Promise.resolve();
  private inflight = 0;
  /** The progress token and cancel signal of the call each piece of work belongs to. */
  private readonly callContext = new AsyncLocalStorage<CallMeta>();

  constructor(engine: Engine) {
    this.engine = engine;
  }

  call(name: string, args: unknown, meta?: CallMeta): Promise<Record<string, unknown>> {
    if (!this.startupChecked) {
      this.startupChecked = true;
      this.previousAutosave = takePreviousAutosave();
    }
    const busy = this.busyRefusal(name);
    if (busy) return Promise.resolve(busy);
    if (name === "plan_run") return this.planRun(args, meta);
    return this.runCall(name, args, meta, false);
  }

  /**
   * One tool call: numbers, validation, the autosave, the bridge mirror. A step of a plan runs here too, with inPlan:
   * it never detaches on its own (the plan does, as a whole) and is not refused for the plan's own background job.
   */
  private runCall(name: string, args: unknown, meta: CallMeta | undefined, inPlan: boolean): Promise<Record<string, unknown>> {
    const hidden = this.groupRefusal(name);
    if (hidden) return Promise.resolve(hidden);
    const numbered = this.withNumbers(name, args);
    if ("reason" in numbered) return Promise.resolve({ ok: false, reason: numbered.reason });
    const picked = edgePicksAsTyped(numbered.args);
    if ("reason" in picked) return Promise.resolve({ ok: false, reason: picked.reason });
    args = picked.args;
    const problem = validateTool(name, args ?? {});
    if (problem) throw new ProtocolError(problem);
    const input = (args ?? {}) as Record<string, unknown>;
    const changes = !annotationsFor(name).readOnlyHint && changesPlate(name);
    // The plate as it stood before a call that can run long is on disk before it starts; others rely on the save after.
    const long = LONG_CALLS.has(name) || (name === "model_apply" && isComposite((input.op as { kind?: unknown } | undefined)?.kind));
    if (changes && this.inflight === 0 && long) this.flushAutosave();
    this.inflight += 1;
    // A detachable call's work stops only for slice_cancel: the request's own cancel, which a client also sends when it
    // gives up waiting, hands the work to a background job instead of throwing it away.
    const detachable = !inPlan && DETACHABLE.has(name);
    const stop = new AbortController();
    const ctx: CallMeta = detachable ? { progressToken: meta?.progressToken, signal: stop.signal } : (meta ?? {});
    let result: ReturnType<Session["dispatch"]>;
    try {
      result = this.callContext.run(ctx, () => this.dispatch(name, input, ctx));
    } catch (err) {
      this.inflight -= 1;
      throw err;
    }
    const work = Promise.resolve(result).then((value) => {
      const { payload, carriedAll } = this.bridgePayload(name, input, value);
      this.lastBridge = payload;
      void mirror(payload, this.bridgeLink, carriedAll);
      return this.withAutosaveHint(value);
    }).catch((err: unknown) => {
      if (err instanceof ProtocolError) {
        const refusal = domainRefusal(err.message);
        if (refusal) return refusal;
      }
      throw err;
    }).finally(() => {
      this.inflight -= 1;
      if (changes) {
        this.autosaveDirty = true;
        this.scheduleAutosave();
      }
    });
    if (!detachable) return work;
    return this.detachable(name, input, work, ctx, stop, meta?.signal);
  }

  /** The call's answer, or a job handle when it is not done within replySeconds() or its request is cancelled. */
  private detachable(name: string, input: Record<string, unknown>, work: Promise<Record<string, unknown>>, ctx: CallMeta, stop: AbortController, request?: AbortSignal): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let answered = false;
      const finish = () => {
        answered = true;
        clearTimeout(timer);
        request?.removeEventListener("abort", detach);
      };
      const detach = () => {
        if (answered) return;
        finish();
        resolve(this.workReply(this.startWorkJob(name, input, work, ctx, stop)));
      };
      const timer = setTimeout(detach, replySeconds() * 1000);
      timer.unref?.();
      request?.addEventListener("abort", detach, { once: true });
      work.then((value) => {
        if (answered) return;
        finish();
        resolve(value);
      }, (err: unknown) => {
        if (answered) return;
        finish();
        reject(err);
      });
      if (request?.aborted) detach();
    });
  }

  private startWorkJob(name: string, input: Record<string, unknown>, work: Promise<Record<string, unknown>>, ctx: CallMeta, stop: AbortController): WorkJob {
    this.jobSeq += 1;
    const object = typeof input.object === "string" ? input.object : name.startsWith("model_") || name === "solid_new" ? this.selected : undefined;
    const stoppable = name === "plan_run" || name === "model_apply_batch" || name === "model_build" || (name === "model_apply" && isComposite((input.op as { kind?: unknown } | undefined)?.kind));
    const job: WorkJob = { handle: `job_${this.jobSeq}`, tool: name, ...(object ? { object } : {}), started: Date.now(), ctx, stop, stoppable, done: false, settled: Promise.resolve() };
    job.settled = work.then((value) => {
      job.result = value;
    }, (err: unknown) => {
      job.error = err instanceof Error ? err.message : "The call failed.";
    }).finally(() => {
      job.done = true;
      // The work's own end already scheduled the autosave; a finished job is kept a while for its wait.
      const finished = this.workJobs.filter((row) => row.done);
      if (finished.length > 8) this.workJobs.splice(this.workJobs.indexOf(finished[0]!), 1);
    });
    this.workJobs.push(job);
    return job;
  }

  /** A job's state as slice_wait and the detached call answer it. A finished job answers with its call's own result. */
  private workReply(job: WorkJob): Record<string, unknown> {
    if (job.done) {
      if (job.error !== undefined) return { ok: false, job: job.handle, status: "error", tool: job.tool, reason: job.error };
      const result = job.result ?? { ok: false };
      // A call whose result is a job of its own (slice_start's slice) keeps that handle and status, so the same wait
      // loop goes on to wait for the slice; the background job is named beside it.
      if (typeof result.job === "string") return { ...result, workJob: job.handle, tool: job.tool };
      return { ...result, job: job.handle, status: "done", tool: job.tool };
    }
    return {
      ok: true,
      job: job.handle,
      status: "running",
      tool: job.tool,
      ...(job.object ? { object: job.object } : {}),
      fraction: Math.round((job.ctx.fraction ?? 0) * 1000) / 1000,
      ...(job.ctx.stage ? { stage: job.ctx.stage } : {}),
      seconds: Math.round((Date.now() - job.started) / 1000),
      note: `${job.tool} runs longer than a client waits, so it goes on in the background. Call slice_wait {job:"${job.handle}"} until status is done: that reply is the call's own result. slice_cancel takes the work back. Edits wait until it is done.`,
    };
  }

  /** While a background job runs, only reads that leave the modeler alone, and the job's wait and cancel, are answered. */
  private busyRefusal(name: string): Record<string, unknown> | null {
    const job = this.workJobs.find((row) => !row.done);
    if (!job || WHILE_BUSY.has(name)) return null;
    const at = job.ctx.stage ? `, ${job.ctx.stage}` : "";
    return { ok: false, job: job.handle, reason: `${job.tool}${job.object ? ` on ${job.object}` : ""} is still running in the background as ${job.handle}${at}. Call slice_wait {job:"${job.handle}"} until it is done, or slice_cancel to take it back, then call this again.` };
  }

  /**
   * plan_run: its steps in order through runCall, so each is checked, applied, and autosaved as if called alone. The
   * plan as a whole is detachable: past replySeconds() it answers with a job, and slice_wait returns the plan's result.
   */
  private planRun(args: unknown, meta?: CallMeta): Promise<Record<string, unknown>> {
    const problem = validateTool("plan_run", args ?? {});
    if (problem) throw new ProtocolError(problem);
    const steps = (args as { steps: PlanStep[] }).steps;
    const bad = planProblem(steps);
    if (bad) throw new ProtocolError(bad);
    if (this.inflight === 0) this.flushAutosave();
    const stop = new AbortController();
    const ctx: CallMeta = { progressToken: meta?.progressToken, signal: stop.signal };
    const work = this.callContext.run(ctx, () => this.runPlan(steps, ctx));
    return this.detachable("plan_run", args as Record<string, unknown>, work, ctx, stop, meta?.signal);
  }

  private async runPlan(steps: PlanStep[], ctx: CallMeta): Promise<Record<string, unknown>> {
    const results: Record<string, unknown>[] = [];
    const done: Record<string, unknown>[] = [];
    const images: InlineImage[] = [];
    const end = (head: Record<string, unknown>) => withImages({ ...head, steps: done }, images);
    for (let i = 0; i < steps.length; i += 1) {
      const n = i + 1;
      const tool = steps[i]!.tool;
      if (ctx.signal?.aborted) return end({ ok: false, failedStep: n, reason: `The plan was cancelled before step ${n} (${tool}). The steps before it stay applied.` });
      const resolved = resolveReferences(steps[i]!.args ?? {}, results, n);
      if ("reason" in resolved) return end({ ok: false, failedStep: n, reason: resolved.reason });
      this.noteStage(`plan step ${n} of ${steps.length}: ${tool}`, i / steps.length);
      let value: Record<string, unknown>;
      try {
        value = await this.runCall(tool, resolved.value, ctx, true);
      } catch (err) {
        const reason = err instanceof Error ? err.message : "The step failed.";
        done.push({ step: n, tool, ok: false, reason });
        return end({ ok: false, failedStep: n, reason: `Step ${n} (${tool}) failed: ${reason}` });
      }
      images.push(...imagesOf(value));
      results.push(value);
      done.push({ step: n, tool, result: value });
      if (value.ok === false) return end({ ok: false, failedStep: n, reason: `Step ${n} (${tool}) was refused: ${typeof value.reason === "string" ? value.reason : "no reason given."}` });
    }
    return end({ ok: true });
  }

  /** With groups on, a tool of a group not enabled is refused with the call that enables it. */
  private groupRefusal(name: string): Record<string, unknown> | null {
    const group = this.toolGroups ? groupOf(name) : null;
    if (group === null || this.toolGroups!.has(group)) return null;
    return { ok: false, group, reason: `${name} is in the ${group} group, which is not enabled. Call tools_enable {groups:["${group}"]}, then call ${name} again.` };
  }

  /** tools_enable: adds groups to the list and tells the client it changed. With groups off, every tool is already listed. */
  private toolsEnable(input: Record<string, unknown>): Record<string, unknown> {
    const asked = (input.groups as string[]).filter((group) => group in TOOL_GROUPS);
    if (!this.toolGroups) return { ok: true, enabled: [...GROUP_NAMES], note: "Every tool is already listed." };
    const added = asked.filter((group) => !this.toolGroups!.has(group));
    for (const group of added) this.toolGroups.add(group);
    if (added.length > 0) this.onToolsChanged?.();
    return { ok: true, enabled: GROUP_NAMES.filter((group) => this.toolGroups!.has(group)), added: added.flatMap((group) => TOOL_GROUPS[group]!.tools) };
  }

  /** What the call is doing now, for its progress notifications and its job's wait. */
  private noteStage(stage: string, fraction?: number): void {
    const meta = this.callContext.getStore();
    if (!meta) return;
    meta.stage = stage;
    if (fraction !== undefined) meta.fraction = fraction;
    this.onProgress?.("model", meta.fraction ?? 0, stage, meta.progressToken);
  }

  private async workWait(job: WorkJob, meta: CallMeta | undefined, timeoutS?: number): Promise<Record<string, unknown>> {
    const limitS = typeof timeoutS === "number" && Number.isFinite(timeoutS) ? Math.min(SLICE_WAIT_MAX_S, Math.max(0.05, timeoutS)) : SLICE_WAIT_DEFAULT_S;
    const deadline = Date.now() + limitS * 1000;
    while (!job.done && Date.now() < deadline && !meta?.signal?.aborted) {
      this.onProgress?.(job.handle, job.ctx.fraction ?? 0, job.ctx.stage ?? "", meta?.progressToken);
      await Promise.race([job.settled, this.pause(Math.min(250, Math.max(1, deadline - Date.now())), meta?.signal)]);
    }
    return this.workReply(job);
  }

  private async workCancel(job: WorkJob): Promise<Record<string, unknown>> {
    if (job.done) return { ...this.workReply(job), reason: "That job had already finished." };
    if (!job.stoppable) {
      const after = CHANGES_NOTHING.has(job.tool) ? "It changes no part." : job.tool.startsWith("model_") || job.tool === "solid_new" ? "Once it is done, model_undo or model_goto takes the part back." : "Once it is done, plate_undo takes it back.";
      return { ok: false, job: job.handle, status: "running", reason: `${job.tool} cannot stop part way; it finishes in the background, and slice_wait returns its result. ${after}` };
    }
    job.stop.abort();
    await Promise.race([job.settled, this.pause(SLICE_WAIT_DEFAULT_S * 1000)]);
    if (!job.done) return { ok: true, job: job.handle, status: "cancelling", reason: job.tool === "plan_run" ? "The plan stops at the step it is on; a batch, build, or composite step is taken back, and the steps before it stay. Call slice_wait for the outcome." : "The work stops after the step it is on, and is then taken back. Call slice_wait for the outcome." };
    return this.workReply(job);
  }

  /** An unknown handle right after a restart: the reply says where the last session's plate is. */
  private withAutosaveHint(value: Record<string, unknown>): Record<string, unknown> {
    if (value.ok !== false || value.reason !== UNKNOWN_OBJECT || !this.previousAutosave || this.objects.length > 0) return value;
    return { ...value, reason: `${UNKNOWN_OBJECT} ${this.previousAutosave.note}`, autosave: this.previousAutosave.path };
  }

  /** Write the autosave a second after the last change, when no call is running. */
  private scheduleAutosave(): void {
    if (this.autosaveTimer) clearTimeout(this.autosaveTimer);
    this.autosaveTimer = setTimeout(() => {
      this.autosaveTimer = null;
      if (this.inflight > 0) this.scheduleAutosave();
      else this.flushAutosave();
    }, 1000);
    this.autosaveTimer.unref?.();
  }

  /** The plate and its histories to this server's autosave in the workspace, without committing anything. Never throws. */
  flushAutosave(): void {
    if (!this.autosaveDirty) return;
    this.autosaveDirty = false;
    if (this.objects.length === 0) return;
    try {
      const path = autosavePath();
      if (!path) return;
      // A solid never committed has no plate mesh yet: its kernel mesh stands in, so the file opens.
      const doc = this.withKernelMeshes(this.saveDocument());
      this.attachPreview(doc, false);
      // One write at a time, off the call's path; a failed write is not worth failing a call for. The binary records are
      // compressed in that chain too, so the call does not wait for them.
      // The document is taken now (a copy), so a write queued behind another still saves the plate as it is at this call.
      const prepared = prepareProject(doc);
      this.autosaveWriting = this.autosaveWriting.then(async () => writeAutosave(path, await finishProject(prepared))).catch(() => undefined);
    } catch {
      // An autosave that cannot be built is not worth failing a call for either.
    }
  }

  /** The autosave being written, for a test or a shutdown that wants it on disk. */
  autosaveSettled(): Promise<void> {
    return this.autosaveWriting;
  }

  /**
   * Model tools take text such as "wallH / 2" where a number goes. Each one becomes its number before the schema
   * check, from the session's parameters and the call's own `params`.
   */
  private withNumbers(name: string, args: unknown): { args: unknown } | { reason: string } {
    this.pendingExprs = [];
    if (!EXPRESSION_TOOLS.has(name) || !args || typeof args !== "object") return { args };
    const input = { ...(args as Record<string, unknown>) };
    // Ops typed in this call get the box anchor written in; a recipe rerun keeps what its ops were saved with.
    if (input.op !== undefined) input.op = withBoxAnchor(input.op);
    if (Array.isArray(input.ops)) input.ops = input.ops.map((op) => withBoxAnchor(op));
    if (name === "model_apply" || name === "model_edit") this.pendingExprs = [typedExprs(input.op)];
    // A part placed with {kind: "use"} becomes several ops, so a batch that uses one keeps no expressions.
    if (name === "model_apply_batch" && Array.isArray(input.ops) && !input.ops.some((op) => (op as { kind?: unknown } | null)?.kind === "use")) this.pendingExprs = input.ops.map(typedExprs);
    if (name === "model_define") return { args: input };
    // model_build {object, params} with no ops reruns the recipe that object was built from, with those parameters.
    if (name === "model_build" && typeof input.object === "string" && input.ops === undefined && input.base === undefined) {
      const recipe = this.find(input.object)?.recipe;
      if (!recipe) return { reason: "That object has no recipe to rerun. Pass base and ops." };
      input.base = structuredClone(recipe.base);
      input.ops = structuredClone(recipe.ops);
      input.params = { ...recipe.params, ...((input.params as Record<string, unknown> | undefined) ?? {}) };
      if (input.name === undefined && recipe.name) input.name = recipe.name;
    }
    if (name === "model_build") this.pendingRecipe = { base: structuredClone(input.base), ops: structuredClone(input.ops ?? []), params: structuredClone((input.params as Record<string, unknown>) ?? {}), name: typeof input.name === "string" ? input.name : undefined };
    let params = this.params;
    if (input.params && typeof input.params === "object") {
      const merged = this.mergeParams(input.params as Record<string, unknown>);
      if ("reason" in merged && typeof merged.reason === "string") return { reason: merged.reason };
      params = merged as Record<string, number>;
    }
    try {
      for (const key of ["op", "base"]) {
        if (input[key] !== undefined) input[key] = resolveNumbers(input[key], params, key, OP_WORDS);
      }
      if (Array.isArray(input.ops)) input.ops = expandOps(input.ops, params, this.parts, OP_WORDS);
    } catch (err) {
      if (err instanceof ExprError) return { reason: err.message };
      throw err;
    }
    return { args: input };
  }

  /** The last mirror sent to the desktop, including a place or settings result. */
  bridgeSnapshot(): Record<string, unknown> | null {
    return this.lastBridge;
  }

  private async ask<T>(value: T | Promise<T>): Promise<T> {
    return await value;
  }

  private pause(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(finish, ms);
      const stop = () => finish();
      function finish() {
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
        resolve();
      }
      signal?.addEventListener("abort", stop, { once: true });
    });
  }

  /**
   * The plate after `name`, for the desktop. A mesh the desktop has not been sent rides along once.
   * A new solid that was never committed has no file yet, so it is not on the desktop's plate.
   */
  private bridgePayload(name: string, input: Record<string, unknown>, value: Record<string, unknown>): { payload: Record<string, unknown>; carriedAll: boolean } {
    const objectId = typeof input.object === "string" ? input.object : "";
    const obj = objectId ? this.find(objectId) : null;
    const settings = (name === "settings_apply" || name === "settings_set") && value.ok === true && value.dryRun !== true
      ? {
          layerHeight: this.settings.layerHeight,
          supports: this.settings.supports,
          blendKind: this.settings.blendKind,
          strategy: this.settings.strategy,
          toughness: this.settings.toughness,
          ...(name === "settings_set" && Array.isArray(value.changed) ? { values: changedValues(value.changed) } : {}),
        }
      : undefined;
    const shown = this.objects.filter((row) => row.bytes.byteLength > 0);
    const known = this.bridgeLink.known;
    const carriedAll = known.size === 0;
    const meshes: Record<string, unknown> = {};
    for (const row of shown) {
      const hash = this.meshHashOf(row.bytes);
      if (known.has(hash) || hash in meshes) continue;
      meshes[hash] = {
        fileName: row.fileName,
        bytesB64: bytesToBase64(row.bytes),
        positionsB64: bytesToBase64(new Uint8Array(row.source.buffer, row.source.byteOffset, row.source.byteLength)),
        seatMm: row.seatMm,
      };
    }
    // The desktop keeps a mesh only while an object on its plate uses it, so an undone remove sends it again.
    known.clear();
    for (const row of shown) known.add(this.meshHashOf(row.bytes));
    const commit = name === "model_commit" && value.ok === true && obj && obj.bytes.byteLength > 0
      ? { object: obj.id, meshHash: this.meshHashOf(obj.bytes) }
      : null;
    this.bridgeSeq += 1;
    const payload = {
      tool: name === "object_select" && typeof input.name === "string" ? "plate_sync" : name,
      session: this.bridgeSession,
      seq: this.bridgeSeq,
      plate: shown.map((row) => ({
        object: row.id,
        name: shownName(row.name),
        scalePercent: row.scale * 100,
        centered: row.centered,
        offset: { ...row.offset },
        orient: [...row.orient],
        meshHash: this.meshHashOf(row.bytes),
        ...(row.sim ? { sim: row.sim } : {}),
      })),
      ...(Object.keys(meshes).length > 0 ? { meshes } : {}),
      ...(obj ? { objectId: obj.id, objectName: obj.name } : {}),
      ok: value.ok === true,
      ...(settings ? { settings } : {}),
      ...(commit ? { commit } : {}),
    };
    return { payload, carriedAll };
  }

  /** A new desktop answered: send it the whole plate with every mesh. */
  private resyncBridge(): void {
    this.bridgeLink.known.clear();
    const { payload } = this.bridgePayload("plate_sync", {}, { ok: true });
    void mirror(payload, this.bridgeLink, true);
  }

  private meshHashOf(bytes: Uint8Array): string {
    let hash = this.meshHashes.get(bytes);
    if (!hash) {
      hash = fnv1aHex(bytes);
      this.meshHashes.set(bytes, hash);
    }
    return hash;
  }

  private dispatch(name: string, input: Record<string, unknown>, meta?: CallMeta): Record<string, unknown> | Promise<Record<string, unknown>> {
    switch (name) {
      case "session_info": return this.sessionInfo();
      case "project_open": return this.projectOpen(String(input.path));
      case "project_create": return this.projectCreate();
      case "project_save": return this.projectSave(String(input.name), input.ifExists === "refuse");
      case "app_open": return this.appOpen(typeof input.path === "string" ? input.path : undefined);
      case "mesh_import": return this.meshImport(String(input.path), typeof input.stepToleranceMm === "number" ? input.stepToleranceMm : STEP, input.pieces === true);
      case "plate_list": return this.plateList(input);
      case "plate_undo": return this.plateUndo();
      case "plate_redo": return this.plateRedo();
      case "object_select": return this.objectSelect(String(input.object), input.name);
      case "object_place": return this.objectPlace(input);
      case "object_remove": return this.objectRemove(String(input.object));
      case "object_duplicate": return this.objectDuplicate(input);
      case "object_split_shells": return this.splitShells(String(input.object));
      case "plate_arrange": return this.plateArrange(input);
      case "plate_print_order": return this.printOrderSet(input);
      case "machine_list": return this.machineList(input);
      case "machine_select": return this.machineSelect(String(input.printerId), String(input.filamentId), input.nozzleMm);
      case "machine_load": return this.machineLoad(String(input.path));
      case "machine_get": return this.machineGet();
      case "machine_set": return this.machineSet(input);
      case "machine_save": return this.machineSave(String(input.name));
      case "settings_apply": return this.settingsApply(input);
      case "settings_schema": return this.settingsSchema(input);
      case "settings_set": return this.settingsSet(input);
      case "profile_save": return this.profileSave(String(input.name));
      case "range_add": return this.rangeAdd(input);
      case "modifier_add": return this.modifierAdd(input);
      case "overrides_list": return this.overridesList();
      case "override_remove": return this.overrideRemove(String(input.id));
      case "layer_action_set": return this.layerActionSet(input);
      case "layer_actions_list": return this.layerActionsList();
      case "layer_action_remove": return this.layerActionRemove(Number(input.zMm));
      case "slice_start": return this.sliceStart(input.cancelRunning === true, input.scope);
      case "slice_wait": return this.sliceWait(String(input.job), meta, typeof input.timeoutS === "number" ? input.timeoutS : undefined);
      case "slice_cancel": return this.sliceCancel(String(input.job));
      case "gcode_summary": return this.gcodeSummary(typeof input.job === "string" ? input.job : undefined);
      case "gcode_export": return this.gcodeExport(input);
      case "export_3mf": return input.pieces === true ? this.exportPieceMeshes(input) : this.export3mf(String(input.name));
      case "mesh_stats": return this.meshStats(String(input.object));
      case "layer_summary": return this.layerSummary(typeof input.job === "string" ? input.job : undefined);
      case "render_view": return this.renderView(input);
      case "paint_supports": return this.paintSupports(input);
      case "paint_seam": return this.paintSeam(input);
      case "reinforce_add": return this.reinforceAdd(input);
      case "paint_list": return this.paintList(input);
      case "paint_clear": return this.paintClear(input);
      case "support_edit": return this.supportEdit(input);
      case "support_trees": return this.supportTrees(input);
      case "layer_detail": return this.layerDetail(input);
      case "layer_paths": return this.layerPathsFile(input);
      case "layer_image": return this.layerImage(input);
      case "gcode_read": return this.gcodeRead(input);
      case "calibration_tower": return this.calibrationTower(input);
      case "calibration_apply": return this.calibrationApply(input);
      case "blend_compare": return this.blendCompare(input);
      case "blend_apply": return this.blendApply(input);
      case "guide": return this.guide(input);
      case "sim_setup": return this.simSetup(input);
      case "sim_run": return this.simRun(input);
      case "sim_field": return this.simField(input);
      case "sim_sweep": return this.simSweep(input);
      case "sim_cancel": return { ok: true, label: LABEL };
      case "tools_enable": return this.toolsEnable(input);
      default: return this.model(name, input);
    }
  }

  private async sessionInfo(): Promise<Record<string, unknown>> {
    let engine: string | null = null;
    let occt = false;
    let reason = "";
    let where: { path: string; installed: boolean } | null = null;
    try {
      engine = await this.ask(this.engine.version());
      occt = await this.ask(this.engine.occt());
      where = (await this.ask(this.engine.where?.())) ?? null;
    } catch (err) {
      reason = err instanceof Error ? err.message : "The engine did not answer.";
    }
    const running = this.workJobs.find((row) => !row.done);
    return {
      ok: true,
      serverVersion: appVersion(),
      engine,
      ...(where ? { enginePath: where.path, ...(where.installed ? { engineNote: "This checkout has no engine built, so the installed app's engine of the same version answers." } : {}) } : {}),
      occt,
      ...(reason ? { reason } : {}),
      workspace: process.env.LIME_MCP_WORKSPACE ?? "",
      ...(this.previousAutosave ? { autosave: this.previousAutosave } : {}),
      ...(running ? { job: { job: running.handle, tool: running.tool, ...(running.object ? { object: running.object } : {}), ...(running.ctx.stage ? { stage: running.ctx.stage } : {}) } } : {}),
      printer: this.printer().name,
      filament: this.filament().name,
      printerSend: false,
      model: {
        ops: ["boolean", "extrude", "revolve", "loft", "sweep", "shell", "faceExtrude", "moveFaces", "hole", "fillet", "chamfer", "split", "partition", "scale", "join", "root"],
        composite: [...COMPOSITE_KINDS],
        primitives: ["box", "cylinder", "sphere", "ellipsoid", "cone", "torus", "wedge", "polygon", "tube"],
        // --- 3.1 F16. A limit per call, as the app's composite tools have it, not per history: one object's history
        // passed 500 steps over several calls, which is fine, and maxSteps read as if it should have stopped there.
        maxStepsPerCall: MAX_PIECES,
        stepLimit: `One composite, batch, or build makes at most ${MAX_PIECES} kernel steps; the op that would pass that is refused like any other refusal. A history has no limit: split the work over several calls.`,
        expressions: true,
        guides: GUIDES.map((row) => row.uri.replace("lime://guide/", "")),
      },
    };
  }

  /** The worked guides as a tool, for clients that do not read resources. */
  private guide(input: Record<string, unknown>): Record<string, unknown> {
    if (typeof input.kind === "string") return this.opGuide(input.kind.trim());
    const topic = typeof input.topic === "string" ? input.topic.trim().toLowerCase() : "";
    if (!topic) return { ok: true, topics: GUIDES.map((row) => ({ topic: row.uri.replace("lime://guide/", ""), name: row.name, tools: row.tools })) };
    const found = guideByUri(`lime://guide/${topic}`);
    if (!found) return { ok: false, reason: `There is no guide named ${topic}. Topics: ${GUIDES.map((row) => row.uri.replace("lime://guide/", "")).join(", ")}.` };
    return { ok: true, topic, name: found.name, tools: found.tools, text: found.text };
  }

  /** One op kind's full schema, its line from tools/list, and the ops guide's lines about it. */
  private opGuide(kind: string): Record<string, unknown> {
    const schema = opSchemaFor(kind);
    if (!schema) return { ok: false, reason: `There is no op kind ${kind}. Kinds: ${OP_KINDS.join(", ")}.` };
    const ops = guideByUri("lime://guide/ops")?.text.split("\n") ?? [];
    const examples = ops.filter((line) => new RegExp(`^\\s*(\\w+, )*${kind}[:,]`).test(line) || line.includes(`kind:\"${kind}\"`));
    return { ok: true, kind, summary: OP_SUMMARY[kind], composite: isComposite(kind), schema, examples };
  }

  private printer(): PrinterRecord {
    return this.library.printers.find((row) => row.id === this.library.printerId) ?? this.library.printers[0]!;
  }

  private filament(): FilamentRecord {
    return this.library.filaments.find((row) => row.id === this.library.filamentId) ?? this.library.filaments[0]!;
  }

  private addObject(partial: Omit<PlateObject, "id" | "modelPose" | "workplane" | "tree" | "solid" | "probes" | "stepTolerance" | "supportEdits" | "supportPaint" | "seamPaint" | "reinforcement" | "objectSettings" | "platedNode"> & Partial<Pick<PlateObject, "stepTolerance" | "supportEdits" | "supportPaint" | "seamPaint" | "reinforcement" | "objectSettings" | "platedNode">>, id?: string): PlateObject {
    const obj: PlateObject = {
      modelPose: IDENTITY_POSE,
      workplane: GLOBAL_WORKPLANE,
      tree: null,
      solid: null,
      probes: new Map(),
      supportEdits: [],
      supportPaint: [],
      seamPaint: [],
      reinforcement: [],
      objectSettings: {},
      platedNode: null,
      stepTolerance: STEP,
      ...partial,
      id: this.takeId(id),
    };
    this.objects.push(obj);
    this.selected = obj.id;
    return obj;
  }

  private takeId(id?: string): string {
    if (id) {
      const match = /^obj_(\d+)$/.exec(id);
      if (match) this.seq = Math.max(this.seq, Number(match[1]));
      return id;
    }
    this.seq += 1;
    return `obj_${this.seq}`;
  }

  private async preview(filename: string, bytes: Uint8Array, tolerance: number): Promise<{ triangles: number; source: Float32Array; seatMm: number }> {
    let text = "";
    try {
      text = await this.withBudget("preview", () => this.engine.meshPreview(JSON.stringify({
        filename,
        stepToleranceMm: tolerance,
      }), bytes), () => this.resetPreview());
    } catch (err) {
      if (err instanceof ModelRunaway) throw new ProtocolError(err.message);
      throw err;
    }
    const reply = JSON.parse(text) as { error?: string; triangles?: number; positionsB64?: string; seatMm?: number };
    if (reply.error || !reply.positionsB64) throw new ProtocolError(reply.error ?? "The mesh could not be read.");
    return {
      triangles: reply.triangles ?? 0,
      source: positionsFrom(reply.positionsB64),
      seatMm: reply.seatMm ?? 0,
    };
  }

  private snapObject(obj: PlateObject): SnapObject {
    return {
      id: obj.id,
      name: obj.name,
      fileName: obj.fileName,
      bytes: obj.bytes,
      source: obj.source,
      triangles: obj.triangles,
      orient: [...obj.orient] as Mat3,
      scale: obj.scale,
      centered: obj.centered,
      offset: { ...obj.offset },
      seatMm: obj.seatMm,
      stepTolerance: obj.stepTolerance,
      ...(obj.note ? { note: obj.note } : {}),
      modelPose: { m: [...obj.modelPose.m] as Affine["m"], t: [...obj.modelPose.t] as Affine["t"] },
      workplane: { source: obj.workplane.source, origin: [...obj.workplane.origin] as Workplane["origin"], turn: [...obj.workplane.turn] as Workplane["turn"] },
      supportEdits: obj.supportEdits.map((entry) => structuredClone(entry)),
      supportPaint: obj.supportPaint.map((disk) => ({ ...disk, p: [...disk.p] as PaintDisk["p"], n: [...disk.n] as PaintDisk["n"] })),
      seamPaint: obj.seamPaint.map((disk) => structuredClone(disk)),
      reinforcement: obj.reinforcement.map((region) => structuredClone(region)),
      objectSettings: { ...obj.objectSettings },
      platedNode: obj.platedNode,
      ...(obj.brep ? { brep: obj.brep } : {}),
      ...(obj.sim ? { sim: cloneStudy(obj.sim) } : {}),
    };
  }

  private capture(label: string): PlateSnap {
    return {
      label,
      objects: this.objects.map((obj) => this.snapObject(obj)),
      selected: this.selected,
      settings: structuredClone(this.settings),
      library: structuredClone(this.library),
      actions: this.actions.map((action) => ({ ...action })),
      overrides: structuredClone(this.overrides),
      printOrder: this.printOrder,
      clearanceMm: this.clearanceMm,
      gantryMm: this.gantryMm,
    };
  }

  private revive(row: SnapObject): PlateObject {
    return {
      ...row,
      orient: [...row.orient] as Mat3,
      modelPose: { m: [...row.modelPose.m] as Affine["m"], t: [...row.modelPose.t] as Affine["t"] },
      workplane: { source: row.workplane.source, origin: [...row.workplane.origin] as Workplane["origin"], turn: [...row.workplane.turn] as Workplane["turn"] },
      tree: null,
      solid: null,
      probes: new Map(),
      ...(row.sim ? { sim: cloneStudy(row.sim) } : {}),
    };
  }

  private install(snap: PlateSnap): void {
    const live = new Map(this.objects.map((obj) => [obj.id, obj]));
    const next: PlateObject[] = [];
    for (const row of snap.objects) {
      const kept = live.get(row.id);
      if (kept) {
        kept.name = row.name;
        kept.fileName = row.fileName;
        kept.bytes = row.bytes;
        kept.source = row.source;
        kept.triangles = row.triangles;
        kept.orient = [...row.orient] as Mat3;
        kept.scale = row.scale;
        kept.centered = row.centered;
        kept.offset = { ...row.offset };
        kept.seatMm = row.seatMm;
        kept.stepTolerance = row.stepTolerance;
        kept.note = row.note;
        kept.supportEdits = row.supportEdits.map((entry) => structuredClone(entry));
        kept.supportPaint = row.supportPaint.map((disk) => ({ ...disk, p: [...disk.p] as PaintDisk["p"], n: [...disk.n] as PaintDisk["n"] }));
        kept.seamPaint = row.seamPaint.map((disk) => structuredClone(disk));
        kept.reinforcement = row.reinforcement.map((region) => structuredClone(region));
        kept.objectSettings = { ...row.objectSettings };
        kept.platedNode = row.platedNode;
        kept.brep = row.brep;
        kept.sim = row.sim ? cloneStudy(row.sim) : undefined;
        next.push(kept);
      } else {
        next.push(this.revive(row));
      }
    }
    const staying = new Set(next.map((obj) => obj.id));
    for (const obj of this.objects) {
      if (!staying.has(obj.id)) void this.closeTree(obj);
    }
    this.objects.splice(0, this.objects.length, ...next);
    this.selected = snap.selected;
    this.settings = structuredClone(snap.settings);
    this.library = structuredClone(snap.library);
    this.actions = snap.actions.map((action) => ({ ...action }));
    this.overrides = structuredClone(snap.overrides);
    this.printOrder = snap.printOrder;
    this.clearanceMm = snap.clearanceMm;
    this.gantryMm = snap.gantryMm;
  }

  private remember(label: string): void {
    this.undoStack.push(this.capture(label));
    if (this.undoStack.length > 32) this.undoStack.shift();
    this.redoStack = [];
  }

  private plateUndo(): Record<string, unknown> {
    const snap = this.undoStack.pop();
    if (!snap) return { ok: false, reason: "Nothing to undo." };
    this.redoStack.push(this.capture(snap.label));
    this.install(snap);
    return { ok: true, label: snap.label };
  }

  private plateRedo(): Record<string, unknown> {
    const snap = this.redoStack.pop();
    if (!snap) return { ok: false, reason: "Nothing to redo." };
    this.undoStack.push(this.capture(snap.label));
    this.install(snap);
    return { ok: true, label: snap.label };
  }

  private async projectCreate(): Promise<Record<string, unknown>> {
    this.remember("New plate");
    await this.forgetObjects();
    this.objects.length = 0;
    this.selected = "";
    this.actions = [];
    this.settings = { ...DEFAULT_PRESET };
    this.overrides = emptyOverrides();
    this.printOrder = "all-at-once";
    this.clearanceMm = 0;
    this.gantryMm = 0;
    this.generation += 1;
    this.sourceProject = null;
    this.sourceHash = "";
    this.sourcePath = "";
    this.profileTouched = false;
    // --- D23. A new project starts with no parameters and no defined parts, as project_open adopts only the file's.
    this.adoptParameters({});
    this.adoptMcpModel(undefined);
    return { ok: true, project: "project", label: "New plate" };
  }

  private async projectOpen(path: string): Promise<Record<string, unknown>> {
    const full = resolveRead(path, "lime");
    const text = await readFile(full, "utf8");
    const parsed = await decodeProject(text);
    if (!parsed.ok) return { ok: false, reason: parsed.message };
    this.remember("Open project");
    await this.forgetObjects();
    this.objects.length = 0;
    this.settings = { ...parsed.project.settings };
    this.actions = parsed.project.layerActions ? parsed.project.layerActions.map((action) => ({ ...action })) : [];
    this.overrides = parsed.project.overrides ? structuredClone(parsed.project.overrides) : emptyOverrides();
    this.printOrder = parsed.project.printOrder === "sequential" ? "sequential" : "all-at-once";
    this.clearanceMm = parsed.project.sequentialClearanceMm ?? 0;
    this.gantryMm = parsed.project.sequentialGantryMm ?? 0;
    this.generation += 1;
    this.sourceProject = structuredClone(parsed.project);
    this.sourceHash = createHash("sha256").update(readFileSync(full)).digest("hex");
    this.sourcePath = realpathSync(full);
    this.profileTouched = false;
    this.adoptProjectMachine(parsed.project.profile);
    const fileObjects = parsed.project.objects?.length ? parsed.project.objects : null;
    const rows = fileObjects
      ? fileObjects.map((obj) => ({
          id: obj.id,
          name: obj.name,
          file: obj.mesh.name,
          bytes: base64ToBytes(obj.mesh.bytesBase64),
          placement: obj.placement,
          supportEdits: obj.supportEdits,
          supportPaint: obj.supportPaint ?? [],
          seamPaint: obj.seamPaint ?? [],
          reinforcement: obj.reinforcement ?? [],
          objectSettings: obj.settings ?? {},
          modelTree: obj.modelTree,
          modelPose: obj.modelPose,
          workplane: obj.workplane,
          brep: obj.brep ? base64ToBytes(obj.brep.bytesBase64) ?? undefined : undefined,
          meshSeatMm: obj.meshSeatMm,
          sim: obj.sim,
        }))
      : [{
          id: undefined as string | undefined,
          name: parsed.project.mesh.name,
          file: parsed.project.mesh.name,
          bytes: base64ToBytes(parsed.project.mesh.bytesBase64),
          placement: parsed.project.placement,
          supportEdits: parsed.project.supportEdits,
          supportPaint: [] as PaintDisk[],
          seamPaint: [] as SeamDisk[],
          reinforcement: [] as ReinforceRegion[],
          objectSettings: {} as PlateObjectSettings,
          modelTree: undefined,
          modelPose: undefined,
          workplane: undefined,
          brep: undefined as Uint8Array | undefined,
          meshSeatMm: undefined as number | undefined,
          sim: undefined as ObjectStudy | undefined,
        }];
    const objects: { object: string; name: string }[] = [];
    for (const row of rows) {
      if (!row.bytes) return { ok: false, reason: "The mesh in this project is damaged." };
      const preview = await this.preview(row.file, row.bytes, row.placement.stepTolerance || STEP);
      const obj = this.addObject({
        name: row.name,
        fileName: row.file,
        bytes: row.bytes,
        source: preview.source,
        triangles: preview.triangles,
        orient: [...row.placement.orient] as Mat3,
        scale: row.placement.scale,
        centered: row.placement.centered,
        offset: { ...row.placement.offset },
        // A committed solid's STL was seated when it was written; its seat is saved beside it.
        seatMm: row.brep && typeof row.meshSeatMm === "number" ? row.meshSeatMm : preview.seatMm,
        stepTolerance: row.placement.stepTolerance > 0 ? row.placement.stepTolerance : STEP,
        supportEdits: row.supportEdits.map((entry) => structuredClone(entry)),
        supportPaint: row.supportPaint.map((disk) => structuredClone(disk)),
        seamPaint: row.seamPaint.map((disk) => structuredClone(disk)),
        reinforcement: row.reinforcement.map((region) => structuredClone(region)),
        objectSettings: { ...row.objectSettings },
      }, row.id);
      if (row.sim) obj.sim = cloneStudy(row.sim);
      if (row.modelPose) obj.modelPose = { m: [...row.modelPose.m] as Affine["m"], t: [...row.modelPose.t] as Affine["t"] };
      if (row.workplane) obj.workplane = { source: row.workplane.source, origin: [...row.workplane.origin] as Workplane["origin"], turn: [...row.workplane.turn] as Workplane["turn"] };
      if (row.brep) obj.brep = row.brep;
      objects.push({ object: obj.id, name: shownName(obj.name) });
    }
    // A tool a saved join took off the plate comes back off the plate, with its history, so model_undo of that join can
    // put it back and a replay of the join can build it.
    const selected = this.selected;
    for (const tool of parsed.project.modelTools ?? []) {
      if (this.find(tool.id)) continue;
      const obj = this.addObject({ name: tool.name, fileName: stlFileName(tool.name), bytes: new Uint8Array(0), source: new Float32Array(0), triangles: 0, orient: [...ID_MATRIX] as Mat3, scale: 1, centered: false, offset: { x: 0, y: 0, z: 0 }, seatMm: 0 }, tool.id);
      this.takeOffPlate(obj.id);
    }
    this.selected = selected;
    const saved = new Map<string, NonNullable<NonNullable<LimeProject["objects"]>[number]["modelTree"]>>();
    for (const row of rows) if (row.modelTree && row.id) saved.set(row.id, row.modelTree);
    for (const tool of parsed.project.modelTools ?? []) if (!saved.has(tool.id)) saved.set(tool.id, tool.modelTree);
    const historyNotes: string[] = [];
    const order = toolFirst(saved);
    for (const [k, id] of order.entries()) {
      const obj = this.find(id) ?? this.toolsOffPlate.find((row) => row.id === id);
      const tree = saved.get(id);
      this.noteStage(`Opening history ${k + 1} of ${order.length}`, k / order.length);
      const note = obj && tree ? await this.adoptHistory(obj, tree) : null;
      if (note) historyNotes.push(note);
    }
    this.adoptParameters(parsed.project);
    this.adoptMcpModel(parsed.project.mcpModel);
    const skipped = this.notSliced();
    return {
      ok: true,
      project: "project",
      // The file's own number: the layout read from it says 2 for any plate. A saved file writes it first.
      version: Number(/^\s*\{\s*"version"\s*:\s*(\d+)/.exec(text.slice(0, 64))?.[1] ?? parsed.project.version),
      handles: "new",
      label: "Open project",
      printer: this.printer().name,
      filament: this.filament().name,
      objects,
      ...(parsed.project.unreadHistory?.length ? { unreadHistory: parsed.project.unreadHistory } : {}),
      ...(historyNotes.length ? { historyNotes } : {}),
      ...(skipped.length ? { notSliced: skipped, note: `This project has ${skipped.join(", ")} that this server does not slice yet. The G-code will differ from the app's.` } : {}),
    };
  }

  private adoptProjectMachine(profile: ProjectProfile): void {
    const printer = this.library.printers.find((row) => row.name === profile.name);
    const filament = this.library.filaments.find((row) => row.nozzleTemp === profile.nozzleTemp && row.bedTemp === profile.bedTemp && Math.abs(row.densityGCm3 - profile.filamentDensityGCm3) < 1e-6)
      ?? this.library.filaments.find((row) => row.diameterMm === profile.filamentDiameter);
    const nozzle = profile.nozzleDiameter === 0.4 || profile.nozzleDiameter === 0.6 || profile.nozzleDiameter === 0.8 ? profile.nozzleDiameter : this.library.nozzleMm;
    if (printer && filament) {
      this.library = { ...this.library, printerId: printer.id, filamentId: filament.id, nozzleMm: nozzle };
      return;
    }
    const adopted = adoptProfile(this.library, { ...profile, ...this.fanOf(profile) }, "project-printer", "project-filament");
    this.library = { ...adopted, nozzleMm: nozzle };
  }

  /** A saved profile may predate fan fields. The library's adopt wants them. */
  private fanOf(profile: ProjectProfile): { fanPercent: number; overhangFanPercent: number; fanOffLayers: number } {
    const fallback = fanDefaults("");
    return {
      fanPercent: profile.fanPercent ?? fallback.fanPercent,
      overhangFanPercent: profile.overhangFanPercent ?? fallback.overhangFanPercent,
      fanOffLayers: profile.fanOffLayers ?? fallback.fanOffLayers,
    };
  }

  private placementOf(obj: PlateObject): ProjectPlacement {
    return {
      orient: [...obj.orient] as ProjectPlacement["orient"],
      scale: obj.scale,
      centered: obj.centered,
      offset: { ...obj.offset },
      stepTolerance: obj.stepTolerance > 0 ? obj.stepTolerance : STEP,
    };
  }

  private fileObject(obj: PlateObject): NonNullable<LimeProject["objects"]>[number] {
    const tree = this.savedModelTree(obj);
    return {
      id: obj.id,
      name: obj.name,
      mesh: meshRecord(obj.fileName, obj.bytes),
      placement: this.placementOf(obj),
      supportEdits: obj.supportEdits.map((entry) => structuredClone(entry)),
      ...(obj.supportPaint.length ? { supportPaint: obj.supportPaint.map((disk) => structuredClone(disk)) } : {}),
      ...(obj.seamPaint.length ? { seamPaint: obj.seamPaint.map((disk) => structuredClone(disk)) } : {}),
      ...(obj.reinforcement.length ? { reinforcement: obj.reinforcement.map((region) => structuredClone(region)) } : {}),
      ...(settingsEmpty(obj.objectSettings) ? {} : { settings: { ...obj.objectSettings } }),
      ...(tree ? { modelTree: tree } : {}),
      ...(obj.brep ? { brep: meshRecord(solidFileName(obj.fileName, obj.brep), obj.brep), meshSeatMm: obj.seatMm } : {}),
      ...(obj.modelPose.t.some((value) => value !== 0) || obj.modelPose.m.some((value, index) => value !== [1, 0, 0, 0, 1, 0, 0, 0, 1][index]) ? { modelPose: { m: [...obj.modelPose.m] as Affine["m"], t: [...obj.modelPose.t] as Affine["t"] } } : {}),
      ...(obj.workplane.source === "global" ? {} : { workplane: { source: obj.workplane.source, origin: [...obj.workplane.origin] as Workplane["origin"], turn: [...obj.workplane.turn] as Workplane["turn"] } }),
      ...(obj.sim ? { sim: cloneStudy(obj.sim) } : {}),
    };
  }

  private savedModelTree(obj: PlateObject): NonNullable<LimeProject["objects"]>[number]["modelTree"] | undefined {
    const tree = obj.tree;
    if (!tree || tree.root.kind === "piece") return undefined;
    const owner = (key: string) => this.byTreeKey(key)?.id;
    const body = savedTree(tree, tree.committed, owner);
    // --- D25. A primitive root keeps the expressions its sizes were typed with, as the app saves them.
    if (tree.root.kind === "primitive") return { ...body, rootPrimitive: tree.root.solid, ...(tree.root.exprs && Object.keys(tree.root.exprs).length > 0 ? { rootExprs: tree.root.exprs } : {}) };
    // --- K2 feature root. The op as stored, no STEP. ---
    if (tree.root.kind === "feature") return { ...body, rootFeature: tree.root.op };
    const bytes = new Uint8Array(tree.root.bytes);
    return { ...body, rootStep: meshRecord(tree.root.name, bytes) };
  }

  /** The object's saved history, opened at its committed step. A sentence when its saved solid was refused, else null. */
  private async adoptHistory(obj: PlateObject, saved: NonNullable<NonNullable<LimeProject["objects"]>[number]["modelTree"]>): Promise<string | null> {
    const key = `mcp-${obj.id}`;
    const root = saved.rootFeature
      ? { kind: "feature" as const, op: saved.rootFeature }
      : saved.rootPrimitive
        ? { kind: "primitive" as const, solid: saved.rootPrimitive, ...(saved.rootExprs ? { exprs: saved.rootExprs } : {}) }
        : saved.rootStep?.bytesBase64
          ? { kind: "step" as const, name: saved.rootStep.name, bytes: this.bufferOf(saved.rootStep.bytesBase64) }
          : null;
    if (!root || (root.kind === "step" && !root.bytes)) return null;
    const stepRoot = root.kind === "step" && root.bytes ? { kind: "step" as const, name: root.name, bytes: root.bytes } : root.kind === "primitive" || root.kind === "feature" ? root : null;
    if (!stepRoot) return null;
    const objectKey = (id: string) => {
      const row = this.find(id) ?? this.toolsOffPlate.find((tool) => tool.id === id);
      return row ? row.tree?.key ?? `mcp-${id}` : undefined;
    };
    // The app opens a saved tree on the plate's step, with redo leading to the step its view was on. The MCP has no view
    // to come back to, so it opens on that step itself: an autosave of a part never committed reopens on its last edit,
    // not on its first solid.
    const loaded = withSavedNames(loadedTree(saved, key, stepRoot, obj.name, null, objectKey));
    obj.tree = loaded.nodes.has(saved.current) ? jumped(loaded, saved.current) : loaded;
    obj.platedNode = obj.tree.committed;
    // A file this server saved before 2.5.1 kept a Model solid's STEP as its plate mesh, which the slicer meshed with
    // truck: a loft could come back as a sheet a metre across. Such a plate takes the kernel's mesh of the committed
    // step, as a commit gives it, and the STEP moves to brep.
    const stepPlate = !obj.brep && /\.(step|stp)$/i.test(obj.fileName);
    const tree = obj.tree;
    let note: string | null = null;
    try {
      // An old STEP plate opens on the committed step first, to mesh it for the plate, then goes on to the current one.
      const at = stepPlate ? tree.committed : tree.current;
      // A refused seed means the history replays in full: the budget covers every step, as after a restart.
      // --- A9. Count steps inside groups, or one long composite restarts inside the per-node budget. ---
      const steps = modelSteps(tree) - 1;
      const budget = Math.max(this.modelTimeoutMs(), steps * 2000);
      const seed = this.seedOf(obj, tree);
      // --- 3.1 F6. A history with no saved solid to start from replays every step: say so while it runs, and after.
      const started = Date.now();
      if (!seed && steps > 0) this.noteStage(`Opening ${shownName(obj.name)}: replaying its ${steps} steps, since this file keeps no solid to start from`);
      const reply = await this.treeCall(wholeTreeRequest(tree, stepRoot, at, obj.stepTolerance || CHORD, { seed }), "open", budget);
      const seconds = Math.round((Date.now() - started) / 1000);
      if (typeof reply.seedRefused === "string") note = `${shownName(obj.name)}: the saved solid did not open (${reply.seedRefused}), so its history was rebuilt.`;
      else if (!seed && steps > 0 && seconds >= 5) note = `${shownName(obj.name)}: this file keeps no solid in the engine's own format (a project saved before version 3 keeps STEP), so its ${steps} steps were replayed, in ${seconds} s. project_save writes version 4, which opens at once.`;
      const solid = rememberSolid(reply);
      if (solid) obj.solid = solid;
      if (stepPlate && solid && solid.positions.length >= 9) {
        const copy = Float32Array.from(solid.positions);
        obj.brep = obj.bytes;
        obj.seatMm = settleBy(copy);
        obj.source = copy;
        obj.triangles = copy.length / 9;
        obj.fileName = stlFileName(obj.fileName);
        obj.bytes = stlBytes(copy, obj.fileName);
      }
      if (at !== tree.current) await this.gotoNode(obj, tree.current);
    } catch (err) {
      if (err instanceof ModelRunaway) return note;
      throw err;
    }
    return note;
  }

  private bufferOf(encoded: string): ArrayBuffer | null {
    const bytes = base64ToBytes(encoded);
    if (!bytes) return null;
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  private freshDocument(): LimeProject {
    const first = this.objects[0];
    const profile = enginePrinter(this.printer(), this.filament(), this.library.nozzleMm);
    const mesh = first ? meshRecord(first.fileName, first.bytes) : meshRecord("empty.stl", new Uint8Array());
    const objects = this.objects.map((obj) => this.fileObject(obj));
    const listed = objects.length > 1 || objects.some((row) => row.modelTree || row.settings || row.supportPaint || row.seamPaint || row.reinforcement || row.workplane || row.modelPose);
    return {
      version: listed ? 2 : 1,
      mesh,
      placement: first ? this.placementOf(first) : { orient: [...ID_MATRIX] as ProjectPlacement["orient"], scale: 1, centered: true, offset: { x: 0, y: 0, z: 0 }, stepTolerance: STEP },
      settings: this.settings,
      preset: null,
      profile,
      level: "simple",
      supportEdits: [],
      ...(listed ? { objects } : {}),
      ...(this.actions.length ? { layerActions: this.actions } : {}),
      ...(this.overrides.ranges.length || this.overrides.volumes.length ? { overrides: structuredClone(this.overrides) } : {}),
      ...(this.printOrder === "sequential" ? { printOrder: "sequential" as const, ...(this.clearanceMm > 0 ? { sequentialClearanceMm: this.clearanceMm } : {}), ...(this.gantryMm > 0 ? { sequentialGantryMm: this.gantryMm } : {}) } : {}),
    };
  }

  private projectDocument(): LimeProject {
    const base = this.sourceProject ? structuredClone(this.sourceProject) : null;
    if (!base) return this.freshDocument();
    base.settings = structuredClone(this.settings);
    if (this.actions.length) base.layerActions = this.actions.map((action) => ({ ...action }));
    else delete base.layerActions;
    if (this.profileTouched) base.profile = enginePrinter(this.printer(), this.filament(), this.library.nozzleMm);
    if (base.objects && base.objects.length > 0) {
      const live = new Map(this.objects.map((obj) => [obj.id, obj]));
      const kept = base.objects.filter((obj) => live.has(obj.id)).map((obj) => this.fileObject(live.get(obj.id)!));
      for (const obj of this.objects) {
        if (!kept.some((row) => row.id === obj.id)) kept.push(this.fileObject(obj));
      }
      base.objects = kept;
      const first = kept[0];
      if (first) {
        base.mesh = first.mesh;
        base.placement = first.placement;
        base.supportEdits = first.supportEdits;
      }
      base.version = plateFileIsVersion2(kept) || kept.length > 1 ? 2 : 1;
      if (base.version === 1) delete base.objects;
      if (this.overrides.ranges.length || this.overrides.volumes.length) base.overrides = structuredClone(this.overrides);
      else delete base.overrides;
      if (this.printOrder === "sequential") {
        base.printOrder = "sequential";
        if (this.clearanceMm > 0) base.sequentialClearanceMm = this.clearanceMm;
        if (this.gantryMm > 0) base.sequentialGantryMm = this.gantryMm;
      }
      return base;
    }
    const obj = this.objects[0];
    if (obj) {
      const next = meshRecord(obj.fileName, obj.bytes);
      if (next.hash !== base.mesh.hash || next.name !== base.mesh.name) base.mesh = next;
      base.placement = this.placementOf(obj);
      const objects = this.objects.map((row) => this.fileObject(row));
      if (plateFileIsVersion2(objects)) {
        base.objects = objects;
        base.version = 2;
      }
    }
    if (this.overrides.ranges.length || this.overrides.volumes.length) base.overrides = structuredClone(this.overrides);
    if (this.printOrder === "sequential") {
      base.printOrder = "sequential";
      if (this.clearanceMm > 0) base.sequentialClearanceMm = this.clearanceMm;
      if (this.gantryMm > 0) base.sequentialGantryMm = this.gantryMm;
    }
    return base;
  }

  private lossy(doc: LimeProject): string | null {
    const src = this.sourceProject;
    if (!src) return null;
    const missing: string[] = [];
    if (src.overrides && !doc.overrides) missing.push("overrides");
    if ((src.modelTools?.length ?? 0) > 0 && !(doc.modelTools?.length)) missing.push("model tools");
    const trees = (rows: LimeProject) => (rows.objects ?? []).some((obj) => obj.modelTree);
    if (trees(src) && !trees(doc)) missing.push("model history");
    const paint = (rows: LimeProject) => (rows.objects ?? []).some((obj) => (obj.supportPaint?.length ?? 0) > 0 || (obj.seamPaint?.length ?? 0) > 0);
    if (paint(src) && !paint(doc)) missing.push("paint");
    const edits = (rows: LimeProject) => rows.supportEdits.length > 0 || (rows.objects ?? []).some((obj) => obj.supportEdits.length > 0);
    if (edits(src) && !edits(doc)) missing.push("support edits");
    if (missing.length === 0) return null;
    return `Saving over this project would drop ${missing.join(", ")}. Save it under a new name.`;
  }

  /**
   * Summary on every save. A picture on `project_save`, from the software renderer `render_view` uses.
   * Autosave does not draw: a picture of different geometry is dropped instead of kept.
   */
  private attachPreview(doc: LimeProject, render: boolean) {
    doc.summary = projectSummary(doc, this.freshEstimate());
    if (render) {
      const thumb = this.renderThumbnail(doc);
      if (thumb) doc.thumbnail = thumb;
    }
    if (doc.thumbnail && doc.thumbnail.meshHash !== geometryHash(doc)) delete doc.thumbnail;
  }

  private freshEstimate(): { seconds: number; grams: number } | undefined {
    const job = this.latest;
    if (!job || job.status !== "done" || !job.wire || this.staleReason(job)) return undefined;
    const summary = this.summarize(job);
    return { seconds: summary.seconds, grams: summary.grams };
  }

  /** The plate's triangles in bed space, one array, for the thumbnail rasterizer. */
  private platePositions(): Float32Array | null {
    if (this.objects.length === 0) return null;
    const meshes = this.objects.map((obj) => this.placed(obj).positions);
    let count = 0;
    for (const mesh of meshes) count += mesh.length;
    if (count < 9) return null;
    const positions = new Float32Array(count);
    let offset = 0;
    for (const mesh of meshes) {
      positions.set(mesh, offset);
      offset += mesh.length;
    }
    return positions;
  }

  private renderThumbnail(doc: LimeProject) {
    try {
      const positions = this.platePositions();
      if (!positions) return undefined;
      const hash = geometryHash(doc);
      for (const edge of [512, 256]) {
        const drawn = renderMesh(positions, "iso", edge, undefined, { transparent: true });
        const thumb = thumbnailFromPng(drawn.png, hash, `lime-mcp/${appVersion()}`);
        if (thumb) return thumb;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  /** The project as project_save writes it, from the plate as it stands. */
  private saveDocument(): LimeProject {
    const doc = this.projectDocument();
    const mcpModel = this.mcpModelRecord();
    if (mcpModel) doc.mcpModel = mcpModel;
    else delete doc.mcpModel;
    const parameters = readParameters(this.paramText);
    if (parameters) doc.parameters = parameters;
    else delete doc.parameters;
    const tools = this.toolsOffPlate.flatMap((tool) => {
      const modelTree = this.savedModelTree(tool);
      return modelTree ? [{ id: tool.id, name: tool.name, modelTree }] : [];
    });
    if (tools.length > 0) doc.modelTools = [...(doc.modelTools ?? []).filter((row) => !tools.some((tool) => tool.id === row.id)), ...tools];
    return doc;
  }

  private async projectSave(name: string, refuseExisting = false): Promise<Record<string, unknown>> {
    if (this.objects.length === 0) return { ok: false, reason: "The plate is empty." };
    const path = resolveWrite(name, ".lime");
    if (refuseExisting && existsSync(path)) return { ok: false, reason: "A project with that name is already in the workspace. Pick another name, or leave ifExists out to replace it." };
    // An object whose current step will not commit (its mesh does not close) is saved as it stands: the plate keeps its
    // last committed mesh, or the kernel's mesh when it has none, and its whole history is kept. The reply names it.
    const refused = await this.commitAll();
    if (this.sourcePath && path === this.sourcePath && this.sourceHash) {
      let now = "";
      try {
        now = createHash("sha256").update(readFileSync(path)).digest("hex");
      } catch {
        now = "";
      }
      if (now && now !== this.sourceHash) {
        return { ok: false, reason: "That project changed on disk since it was opened. Save it under a new name." };
      }
    }
    const doc = this.withKernelMeshes(this.saveDocument());
    this.attachPreview(doc, true);
    if (this.sourcePath && path === this.sourcePath) {
      const loss = this.lossy(doc);
      if (loss) return { ok: false, reason: loss };
    }
    const text = await encodeProject(doc);
    writeFileSync(path, text);
    this.sourceProject = structuredClone(doc);
    this.sourceHash = createHash("sha256").update(text).digest("hex");
    this.sourcePath = path;
    const warnings = refused.map((row) => {
      const obj = this.find(row.object);
      const kept = obj && obj.bytes.byteLength > 0 ? "the plate keeps its last committed mesh" : "the plate holds its open kernel mesh";
      return `${row.name} (${row.object}) was saved without committing its current step: ${row.reason.replace(/ It was not put on the plate[^.]*\./, "")} Its history is saved whole, and ${kept}.`;
    });
    return { ok: true, path, bytes: Buffer.byteLength(text), ...(warnings.length ? { warnings, uncommitted: refused.map((row) => row.object) } : {}) };
  }

  /**
   * Show the work in the desktop app. With no path the plate is saved first: over the project it came from when that
   * is in the workspace, otherwise under a free name from its first object, so no other file is replaced.
   */
  private async appOpen(path?: string): Promise<Record<string, unknown>> {
    if (path !== undefined) return openInApp(resolveWorkspaceFile(path), this.appOpener, false);
    if (this.objects.length === 0) return { ok: false, reason: "The plate is empty. Build or import a part first, or pass a workspace file as path." };
    let name = "";
    try {
      if (this.sourcePath) name = resolveWrite(this.sourcePath, ".lime");
    } catch {
      name = "";
    }
    if (!name) {
      const stem = (this.objects[0]!.name.replace(/\.(lime|stl|3mf|step|stp)$/i, "").replace(/[^\w .-]+/g, "-").replace(/^[\s.-]+|[\s.-]+$/g, "") || "lime-project").slice(0, 60);
      for (let n = 1; n < 100 && !name; n += 1) {
        const candidate = resolveWrite(n === 1 ? stem : `${stem}-${n}`, ".lime");
        if (!existsSync(candidate)) name = candidate;
      }
      if (!name) return { ok: false, reason: "No free project name was found in the workspace. Save it with project_save and pass that file as path." };
    }
    const saved = await this.projectSave(name);
    if (saved.ok !== true) return saved;
    return openInApp(String(saved.path), this.appOpener, true);
  }

  private async meshImport(path: string, tolerance: number, pieces = false): Promise<Record<string, unknown>> {
    await new Promise((resolve) => setImmediate(resolve));
    const full = resolveRead(path, "mesh");
    const bytes = new Uint8Array(await readFile(full));
    const fileName = full.split(/[\\/]/).pop() ?? "mesh.stl";
    let note: string | undefined;
    if (fileName.toLowerCase().endsWith(".3mf")) {
      const vendor = foreignSlicer3mf(bytes);
      if (vendor) note = foreign3mfMessage(vendor);
    }
    const preview = await this.preview(fileName, bytes, tolerance);
    const obj = this.addObject({
      name: fileName,
      fileName,
      bytes,
      source: preview.source,
      triangles: preview.triangles,
      orient: [...ID_MATRIX],
      scale: 1,
      centered: true,
      offset: { x: 0, y: 0, z: 0 },
      seatMm: preview.seatMm,
      stepTolerance: tolerance,
      ...(note ? { note } : {}),
    });
    const solids = /\.(step|stp)$/i.test(fileName) ? stepSolidHint(bytes) : 0;
    const split = pieces && solids >= 2 ? await this.splitSolids(obj, false) : null;
    if (split) return split;
    const placed = this.placed(obj);
    const overlap = this.overlaps(obj) ? OVERLAP : "";
    const several = solids >= 2 && !pieces ? `This STEP file holds ${solids} solids. mesh_import with pieces: true opens each as an object; object_split_shells splits this one.` : "";
    const combined = [note, overlap, several].filter((line) => line).join(" ");
    return {
      ok: true,
      object: obj.id,
      name: shownName(obj.name),
      triangles: obj.triangles,
      bboxMm: { min: placed.bounds.min, max: placed.bounds.max },
      ...(several ? { solids } : {}),
      ...(combined ? { note: combined } : {}),
    };
  }

  /**
   * One object per solid of `obj`'s STEP file, named from the file, each where it sat in `obj` and a solid Model edits.
   * Null when the kernel reads one solid or none, so the caller goes on as for a mesh.
   */
  private async splitSolids(obj: PlateObject, undoable: boolean): Promise<Record<string, unknown> | null> {
    let written: Record<string, unknown>;
    try {
      written = JSON.parse(await this.ask(this.engine.modelTree(JSON.stringify({ call: "stepSolids", dataB64: bytesToBase64(obj.bytes), files: true })))) as Record<string, unknown>;
    } catch (err) {
      written = { error: err instanceof Error ? err.message : String(err) };
    }
    if (typeof written.error === "string") return { ok: false, reason: written.error };
    const rows = Array.isArray(written.solids) ? (written.solids as { name?: unknown; bytesBase64?: unknown }[]) : [];
    if (rows.length < 2) return null;
    const files = rows.map((row) => (typeof row.bytesBase64 === "string" ? base64ToBytes(row.bytesBase64) : null));
    if (files.some((file) => !file)) return { ok: false, reason: "The kernel did not write the solids of this STEP file." };
    const names = solidNames(obj.fileName, rows.map((row) => ({ name: typeof row.name === "string" ? row.name : "" })));
    const read = [];
    for (const [index, file] of files.entries()) read.push({ name: names[index]!, fileName: pieceFileName(names[index]!), bytes: file!, ...(await this.preview(pieceFileName(names[index]!), file!, obj.stepTolerance)) });
    if (undoable) this.remember("Separate solids");
    const printer = this.printer();
    const posed = { source: obj.source, orient: obj.orient, scale: obj.scale, centered: obj.centered, offset: obj.offset };
    const at = this.objects.indexOf(obj);
    const made = read.map((piece, index): PlateObject => ({
      ...obj,
      id: index === 0 ? obj.id : this.takeId(),
      name: piece.name,
      fileName: piece.fileName,
      bytes: piece.bytes,
      source: piece.source,
      triangles: piece.triangles,
      seatMm: piece.seatMm,
      orient: [...obj.orient] as Mat3,
      centered: false,
      offset: offsetInPlace(posed, piece.source, piece.seatMm - obj.seatMm, printer.bedX, printer.bedY),
      modelPose: { m: [...obj.modelPose.m] as PlateObject["modelPose"]["m"], t: [...obj.modelPose.t] as PlateObject["modelPose"]["t"] },
      workplane: { source: obj.workplane.source, origin: [...obj.workplane.origin] as Workplane["origin"], turn: [...obj.workplane.turn] as Workplane["turn"] },
      tree: null,
      solid: null,
      probes: new Map(),
      platedNode: null,
      brep: undefined,
      note: undefined,
      supportEdits: [],
      supportPaint: [],
      seamPaint: [],
      reinforcement: [],
      objectSettings: { ...obj.objectSettings },
    }));
    this.objects.splice(at, 1, ...made);
    this.selected = made[0]!.id;
    return { ok: true, objects: made.map((piece) => piece.id), names: made.map((piece) => piece.name), solids: made.length, label: "Separate solids" };
  }

  private placed(obj: PlateObject) {
    const printer = this.printer();
    return placeMesh(obj.source, obj.orient, obj.scale, printer.bedX, printer.bedY, obj.centered, obj.offset);
  }

  private overlaps(obj: PlateObject): boolean {
    const a = this.placed(obj).bounds;
    return this.objects.some((other) => {
      if (other.id === obj.id) return false;
      const b = this.placed(other).bounds;
      return a.min[0] < b.max[0] - 0.05 && b.min[0] < a.max[0] - 0.05 && a.min[1] < b.max[1] - 0.05 && b.min[1] < a.max[1] - 0.05;
    });
  }

  private plateNotes(obj: PlateObject, bounds: Bounds): string[] {
    const printer = this.printer();
    const notes = offBed(bounds, printer.bedX, printer.bedY, printer.bedZ, printer.kind === "belt");
    if (this.overlaps(obj)) notes.push(OVERLAP);
    return notes;
  }

  private find(id: string): PlateObject | null {
    return this.objects.find((obj) => obj.id === id) ?? null;
  }

  private plateList(input: Record<string, unknown>): Record<string, unknown> {
    const rows = this.objects.map((obj) => {
      const placed = this.placed(obj);
      const centre = [
        (placed.bounds.min[0] + placed.bounds.max[0]) / 2,
        (placed.bounds.min[1] + placed.bounds.max[1]) / 2,
        (placed.bounds.min[2] + placed.bounds.max[2]) / 2,
      ];
      return {
        object: obj.id,
        name: shownName(obj.name),
        bboxMm: { min: placed.bounds.min, max: placed.bounds.max },
        centreMm: centre,
        scalePercent: obj.scale * 100,
        notes: this.plateNotes(obj, placed.bounds),
      };
    });
    const listed = page(rows, input.cursor, input.limit);
    const offer = rows.length === 0 && this.previousAutosave ? { autosave: this.previousAutosave } : {};
    return { ok: true, objects: listed.rows, ...(listed.nextCursor ? { nextCursor: listed.nextCursor } : {}), ...offer };
  }

  /** A name typed for a plate object, trimmed to the limit; undefined when none was given. */
  private givenName(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim().slice(0, NAME_LIMIT) : undefined;
  }

  private objectSelect(id: string, name?: unknown): Record<string, unknown> {
    const obj = this.find(id);
    if (!obj) return { ok: false, reason: UNKNOWN_OBJECT };
    const renamed = this.givenName(name);
    if (renamed && renamed !== obj.name) {
      this.remember("Rename");
      obj.name = renamed;
    }
    this.selected = obj.id;
    return { ok: true, object: obj.id, name: shownName(obj.name) };
  }

  private objectPlace(input: Record<string, unknown>): Record<string, unknown> {
    const obj = this.find(String(input.object));
    if (!obj) return { ok: false, reason: UNKNOWN_OBJECT };
    this.remember("Place");
    let reslice = false;
    if (typeof input.scalePercent === "number") {
      obj.scale = input.scalePercent / 100;
      reslice = true;
    }
    if (input.layFlat === true) {
      obj.orient = layFlatMatrix(obj.source, obj.orient, obj.scale);
      reslice = true;
    }
    const turn = input.turn as { axis?: string; degrees?: number } | undefined;
    if (turn && typeof turn.degrees === "number") {
      const rot = turn.axis === "x" ? rotX(turn.degrees) : turn.axis === "y" ? rotY(turn.degrees) : rotZ(turn.degrees);
      obj.orient = matMul(rot, obj.orient);
      reslice = true;
    }
    if (input.centreOnBed === true) {
      obj.centered = true;
      obj.offset = { x: 0, y: 0, z: 0 };
    }
    if (typeof input.rotX === "number" || typeof input.rotY === "number" || typeof input.rotZ === "number") {
      const current = orientEuler(obj.orient);
      obj.orient = eulerOrient(
        typeof input.rotX === "number" ? input.rotX : current.rx,
        typeof input.rotY === "number" ? input.rotY : current.ry,
        typeof input.rotZ === "number" ? input.rotZ : current.rz,
      );
      reslice = true;
    }
    if (typeof input.faceDown === "number") {
      const face = obj.solid?.faces[input.faceDown];
      if (!face?.normal) return { ok: false, reason: "That face is not a flat face on this solid." };
      obj.orient = align(face.normal, [0, 0, -1]);
      reslice = true;
    }
    let rest: Record<string, unknown> = {};
    if (input.settle === true) {
      const hull = hullOf(obj.source);
      if (hull) {
        const found = restPose(hull, obj.orient, obj.scale);
        obj.orient = found.orient;
        rest = { settled: found.snapped, contactMm2: Math.round(found.areaMm2 * 10) / 10 };
      } else {
        rest = { settled: false, contactMm2: 0 };
      }
      const turned = orientEuler(obj.orient);
      rest.rotationDeg = { x: Math.round(turned.rx * 100) / 100, y: Math.round(turned.ry * 100) / 100, z: Math.round(turned.rz * 100) / 100 };
      reslice = true;
    }
    if (typeof input.z === "number") {
      if (obj.centered) {
        const printer = this.printer();
        obj.offset = centeringShift(obj.source, obj.orient, obj.scale, printer.bedX, printer.bedY);
        obj.centered = false;
      }
      obj.offset = { ...obj.offset, z: input.z };
    }
    if (typeof input.centreX === "number" || typeof input.centreY === "number") {
      const current = this.placed(obj);
      const cx = (current.bounds.min[0] + current.bounds.max[0]) / 2;
      const cy = (current.bounds.min[1] + current.bounds.max[1]) / 2;
      if (obj.centered) {
        const printer = this.printer();
        obj.offset = centeringShift(obj.source, obj.orient, obj.scale, printer.bedX, printer.bedY);
        obj.centered = false;
      }
      const dx = typeof input.centreX === "number" ? input.centreX - cx : 0;
      const dy = typeof input.centreY === "number" ? input.centreY - cy : 0;
      obj.offset = { x: obj.offset.x + dx, y: obj.offset.y + dy, z: obj.offset.z };
    }
    const alignSpec = input.align as { to?: unknown; how?: unknown } | undefined;
    if (alignSpec) {
      if (!isAlignRelation(alignSpec.how)) return { ok: false, reason: "align.how is not a relation." };
      const toBed = alignSpec.to === "bed";
      const other = toBed ? undefined : this.find(String(alignSpec.to));
      if (!toBed && (!other || other.id === obj.id)) return { ok: false, reason: UNKNOWN_OBJECT };
      const printer = this.printer();
      const box = other ? this.placed(other).bounds : bedBox(printer.bedX, printer.bedY, printer.bedZ);
      const delta = alignDelta(this.placed(obj).bounds, box, alignSpec.how, toBed);
      if (!delta) return { ok: false, reason: "The bed has no side to touch or stack on. Use flush or centre." };
      if (obj.centered) {
        obj.offset = centeringShift(obj.source, obj.orient, obj.scale, printer.bedX, printer.bedY);
        obj.centered = false;
      }
      obj.offset = { x: obj.offset.x + delta[0], y: obj.offset.y + delta[1], z: obj.offset.z + delta[2] };
    }
    const placed = this.placed(obj);
    return {
      ok: true,
      centreMm: [
        (placed.bounds.min[0] + placed.bounds.max[0]) / 2,
        (placed.bounds.min[1] + placed.bounds.max[1]) / 2,
        (placed.bounds.min[2] + placed.bounds.max[2]) / 2,
      ],
      scalePercent: obj.scale * 100,
      orient: [...obj.orient],
      ...rest,
      reslice,
      label: "Place",
    };
  }

  /** Older jobs keep z and seconds. Only the latest job keeps layer paths. */
  private keepLatestWire(latest: Job): void {
    for (const job of this.jobs) {
      if (job.handle === latest.handle || !job.wire || !Array.isArray(job.wire.layers)) continue;
      job.wire = {
        ...job.wire,
        layers: (job.wire.layers as Record<string, unknown>[]).map((layer) => {
          const rest = { ...layer };
          delete rest.paths;
          return rest;
        }),
      };
    }
  }

  private retainJobs(job: Job) {
    this.jobs.push(job);
    while (this.jobs.length > 8) {
      const index = this.jobs.findIndex((row) => row !== this.running);
      if (index < 0) break;
      const dropped = this.jobs.splice(index, 1)[0];
      if (dropped && this.latest?.handle === dropped.handle) {
        this.latest = this.jobs.filter((row) => row.status === "done").at(-1) ?? null;
      }
    }
  }

  private async forgetObjects(): Promise<void> {
    for (const obj of [...this.objects, ...this.toolsOffPlate, ...this.piecesOffPlate]) await this.closeTree(obj);
    this.toolsOffPlate = [];
    this.piecesOffPlate = [];
  }

  /** The object, on the plate or taken off it by a join or an undone split to print, whose tree has this engine key. */
  private byTreeKey(key: string): PlateObject | undefined {
    return [...this.objects, ...this.toolsOffPlate, ...this.piecesOffPlate].find((row) => row.tree?.key === key);
  }

  /** A join without keepTool takes its tool off the plate, as the desktop does; its tree stays for replays and the save. */
  private takeOffPlate(id: string): void {
    const tool = this.objects.find((row) => row.id === id);
    if (!tool) return;
    this.objects.splice(this.objects.indexOf(tool), 1);
    this.toolsOffPlate.push(tool);
    if (this.selected === id) this.selected = this.objects[0]?.id ?? "";
  }

  /**
   * A tool a join took off the plate is off only while that join is on the way to its part's current step, as the
   * desktop's Prepare undo puts it back with the edit: model_undo or a goto before the join brings the tool back, and
   * redo takes it off again. A tool that came back without a plate mesh (a project's saved tool tree) is committed.
   */
  private async followJoins(obj: PlateObject): Promise<{ back: string[]; left: string[] }> {
    const named = new Set<string>();
    for (const node of obj.tree?.nodes.values() ?? []) if (node.op?.kind === "join" && !node.op.keepTool) named.add(node.op.tool.object);
    if (named.size === 0) return { back: [], left: [] };
    const consumed = new Set<string>();
    for (const row of [...this.objects, ...this.toolsOffPlate]) {
      const tree = row.tree;
      if (!tree) continue;
      for (const id of pathTo(tree, tree.current)) {
        const op = tree.nodes.get(id)?.op;
        if (op?.kind === "join" && !op.keepTool) consumed.add(op.tool.object);
      }
    }
    const back: string[] = [];
    const left: string[] = [];
    for (const id of named) {
      if (consumed.has(id)) {
        if (this.objects.some((row) => row.id === id)) {
          this.takeOffPlate(id);
          left.push(id);
        }
        continue;
      }
      const tool = this.toolsOffPlate.find((row) => row.id === id);
      if (!tool) continue;
      this.toolsOffPlate.splice(this.toolsOffPlate.indexOf(tool), 1);
      this.objects.push(tool);
      if (tool.bytes.byteLength === 0) {
        try {
          await this.commitObject(tool);
        } catch {
          // The tool is back with its history; a later commit writes its mesh.
        }
      }
      back.push(id);
    }
    return { back, left };
  }

  private async closeTree(obj: PlateObject): Promise<void> {
    const key = obj.tree?.key;
    obj.tree = null;
    if (!key) return;
    try {
      await this.ask(this.engine.modelTree(JSON.stringify({ call: "close", key })));
    } catch {
      // Removing the part still succeeds when the modeler is already gone.
    }
  }

  private async objectRemove(id: string): Promise<Record<string, unknown>> {
    const index = this.objects.findIndex((obj) => obj.id === id);
    if (index < 0) return { ok: false, reason: UNKNOWN_OBJECT };
    this.remember("Remove");
    const leaving = this.objects[index];
    if (leaving) await this.closeTree(leaving);
    this.objects.splice(index, 1);
    if (this.selected === id) this.selected = this.objects[0]?.id ?? "";
    return { ok: true, objects: this.objects.map((obj) => obj.id), label: "Remove" };
  }

  private objectDuplicate(input: Record<string, unknown>): Record<string, unknown> {
    const source = this.find(String(input.object));
    if (!source) return { ok: false, reason: UNKNOWN_OBJECT };
    const count = typeof input.count === "number" ? input.count : 1;
    this.remember("Duplicate");
    const made: string[] = [];
    for (let i = 0; i < count; i += 1) {
      this.seq += 1;
      const id = `obj_${this.seq}`;
      const copy: PlateObject = {
        ...source,
        id,
        name: `${source.name} ${i + 2}`,
        bytes: source.bytes,
        source: source.source,
        orient: [...source.orient] as Mat3,
        offset: { ...source.offset },
        modelPose: { m: [...source.modelPose.m] as PlateObject["modelPose"]["m"], t: [...source.modelPose.t] as PlateObject["modelPose"]["t"] },
        workplane: { source: source.workplane.source, origin: [...source.workplane.origin] as Workplane["origin"], turn: [...source.workplane.turn] as Workplane["turn"] },
        tree: null,
        solid: null,
        probes: new Map(),
        platedNode: null,
        supportEdits: source.supportEdits.map((entry) => structuredClone(entry)),
        supportPaint: source.supportPaint.map((disk) => ({ ...disk, p: [...disk.p] as typeof disk.p, n: [...disk.n] as typeof disk.n })),
        seamPaint: source.seamPaint.map((disk) => structuredClone(disk)),
        reinforcement: source.reinforcement.map((region) => structuredClone(region)),
        objectSettings: { ...source.objectSettings },
        ...(source.sim ? { sim: cloneStudy(source.sim) } : {}),
      };
      this.objects.push(copy);
      made.push(id);
    }
    this.selected = made[made.length - 1] ?? source.id;
    return { ok: true, objects: made, label: "Duplicate" };
  }

  private async splitShells(id: string): Promise<Record<string, unknown>> {
    const obj = this.find(id);
    if (!obj) return { ok: false, reason: UNKNOWN_OBJECT };
    const split = separateBy(obj.fileName, stepSolidHint(obj.bytes)) === "solids" ? await this.splitSolids(obj, true) : null;
    if (split) return split;
    const groups = shellGroups(obj.source);
    if (!groups) return { ok: false, reason: "This mesh is one shell." };
    const pieces = takeGroups(obj.source, groups.groups);
    this.remember("Separate shells");
    const made: string[] = [];
    const stem = obj.fileName.replace(/\.(stl|3mf|step|stp)$/i, "") || obj.name;
    const shellFile = (index: number) => `${stem}-shell-${index + 1}.stl`;
    pieces.forEach((source, index) => {
      const fileName = shellFile(index);
      const bytes = stlBytes(source, fileName);
      if (index === 0) {
        obj.source = source;
        obj.bytes = bytes;
        obj.fileName = fileName;
        obj.triangles = source.length / 9;
        obj.tree = null;
        obj.solid = null;
        made.push(obj.id);
        return;
      }
      this.seq += 1;
      const copyId = `obj_${this.seq}`;
      this.objects.push({
        ...obj,
        id: copyId,
        name: `${obj.name} ${index + 1}`,
        fileName,
        source,
        bytes,
        triangles: source.length / 9,
        orient: [...obj.orient] as Mat3,
        offset: { ...obj.offset },
        modelPose: { m: [...obj.modelPose.m] as PlateObject["modelPose"]["m"], t: [...obj.modelPose.t] as PlateObject["modelPose"]["t"] },
        workplane: { source: obj.workplane.source, origin: [...obj.workplane.origin] as Workplane["origin"], turn: [...obj.workplane.turn] as Workplane["turn"] },
        tree: null,
        solid: null,
        probes: new Map(),
        platedNode: null,
        supportEdits: [],
        supportPaint: [],
        seamPaint: [],
        reinforcement: [],
        objectSettings: { ...obj.objectSettings },
      });
      made.push(copyId);
    });
    return { ok: true, objects: made, shells: pieces.length, label: "Separate shells" };
  }

  private asBed(obj: PlateObject): SliceObject {
    return {
      id: obj.id,
      name: obj.name,
      fileName: obj.fileName,
      bytes: obj.bytes.buffer as ArrayBuffer,
      sourcePos: obj.source,
      orient: obj.orient,
      partScale: obj.scale,
      centered: obj.centered,
      offset: obj.offset,
      stepTolerance: obj.stepTolerance,
      supportEdits: obj.supportEdits,
      supportPaint: obj.supportPaint,
      seamPaint: obj.seamPaint,
      reinforcement: obj.reinforcement,
      settings: obj.objectSettings,
    };
  }

  private plateArrange(input: Record<string, unknown>): Record<string, unknown> {
    if (this.objects.length < 2) return { ok: false, reason: "Arrange needs two objects." };
    const printer = this.printer();
    const clearance = sequentialClearance(this.sliceRules(this.objects.length), this.order());
    const gap = typeof input.gapMm === "number" ? input.gapMm : clearance === null ? ARRANGE_GAP_MM : clearance + 0.01;
    const arranged = arrangedObjects(this.objects.map((obj) => this.asBed(obj)), printer.bedX, printer.bedY, gap);
    const moved = arranged.map((row) => {
      const live = this.find(row.id);
      const pose = live ? { ...live, centered: row.centered, offset: row.offset, scale: live.scale, source: live.source, orient: live.orient } : null;
      const placed = pose ? this.placed(pose) : null;
      const centre = placed
        ? [(placed.bounds.min[0] + placed.bounds.max[0]) / 2, (placed.bounds.min[1] + placed.bounds.max[1]) / 2]
        : [0, 0];
      const fits = placed ? placed.bounds.max[0] <= printer.bedX + 0.05 && placed.bounds.max[1] <= printer.bedY + 0.05 && placed.bounds.min[0] >= -0.05 && placed.bounds.min[1] >= -0.05 : false;
      return { object: row.id, centre, fits, centered: row.centered, offset: row.offset };
    });
    const outside = moved.filter((row) => !row.fits).map((row) => row.object);
    if (input.dryRun !== true) {
      this.remember("Arrange");
      for (const row of arranged) {
        const live = this.find(row.id);
        if (!live) continue;
        live.centered = row.centered;
        live.offset = { ...row.offset };
      }
    }
    return { ok: true, moved: moved.map(({ object, centre }) => ({ object, centre })), fits: outside.length === 0, ...(outside.length ? { outside } : {}), ...(input.dryRun === true ? { dryRun: true } : { stale: true }), label: "Arrange" };
  }

  private plateCollisions(): { a: string; b: string }[] {
    const placed = this.objects.map((obj) => ({ id: obj.id, bounds: this.placed(obj).bounds }));
    const clearance = this.printOrder === "sequential" ? (sequentialClearance(this.sliceRules(this.objects.length), this.order()) ?? 0) : 0;
    const pairs: { a: string; b: string }[] = [];
    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) {
        const left = placed[i]!;
        const right = placed[j]!;
        const gap = xyGap(left.bounds, right.bounds);
        const hit = clearance > 0 ? gap < clearance - 1e-6 : gap <= 0.05;
        if (hit) pairs.push({ a: left.id, b: right.id });
      }
    }
    return pairs;
  }

  private printOrderSet(input: Record<string, unknown>): Record<string, unknown> {
    const order = input.order === "sequential" ? "sequential" : input.order === "together" ? "all-at-once" : null;
    if (!order) return { ok: false, reason: "order is together or sequential." };
    const clearance = typeof input.clearanceMm === "number" ? input.clearanceMm : this.clearanceMm;
    const gantry = typeof input.gantryMm === "number" ? input.gantryMm : this.gantryMm;
    if (input.dryRun !== true) {
      this.remember("Print order");
      this.printOrder = order;
      this.clearanceMm = clearance;
      this.gantryMm = gantry;
    }
    const was = this.printOrder;
    if (input.dryRun === true) this.printOrder = order;
    const collisions = this.plateCollisions();
    if (input.dryRun === true) this.printOrder = was;
    const reason = collisions.length && order === "sequential" ? `${collisions[0]!.a} and ${collisions[0]!.b} are closer than the clearance.` : undefined;
    return { ok: true, ...(reason ? { reason } : {}), collisions, ...(input.dryRun === true ? { dryRun: true } : { stale: true }), label: "Print order" };
  }

  private machineGet(): Record<string, unknown> {
    const printer = this.printer();
    const filament = this.filament();
    const { host: _host, apiKey: _key, hostType: _kind, startPrint: _send, ...safe } = printer;
    return {
      ok: true,
      printer: { ...safe, bedMm: [printer.bedX, printer.bedY, printer.bedZ] },
      filament: {
        id: filament.id,
        name: filament.name,
        material: filament.material,
        nozzleTemp: filament.nozzleTemp,
        bedTemp: filament.bedTemp,
        flow: filament.flow,
        pressureAdvance: filament.pressureAdvance,
      },
    };
  }

  private machineSet(input: Record<string, unknown>): Record<string, unknown> {
    const printerPatch = input.printer && typeof input.printer === "object" && !Array.isArray(input.printer) ? input.printer as Record<string, unknown> : {};
    const filamentPatch = input.filament && typeof input.filament === "object" && !Array.isArray(input.filament) ? input.filament as Record<string, unknown> : {};
    for (const key of [...Object.keys(printerPatch), ...Object.keys(filamentPatch)]) {
      if (key === "host" || key === "apiKey" || key === "hostType" || key === "startPrint") {
        return { ok: false, reason: "This server does not store a printer host or a key." };
      }
    }
    const before = this.machineGet();
    let library = this.library;
    const printer = library.printers.find((row) => row.id === library.printerId);
    const filament = library.filaments.find((row) => row.id === library.filamentId);
    if (!printer || !filament) return { ok: false, reason: "Choose a printer and a filament first." };
    if (typeof printerPatch.retractLength === "number" || typeof printerPatch.retractSpeed === "number") {
      library = setRetract(library, typeof printerPatch.retractLength === "number" ? printerPatch.retractLength : null, typeof printerPatch.retractSpeed === "number" ? printerPatch.retractSpeed : null);
    }
    if (typeof filamentPatch.flow === "number") library = setFlow(library, filamentPatch.flow);
    if (typeof filamentPatch.nozzleTemp === "number") library = setNozzleTemp(library, filamentPatch.nozzleTemp);
    if (typeof filamentPatch.pressureAdvance === "number") {
      const linear = typeof filamentPatch.linearAdvance === "number" ? filamentPatch.linearAdvance : filament.linearAdvance[String(library.nozzleMm)] ?? 0;
      library = setAdvance(library, filamentPatch.pressureAdvance, linear);
    }
    const start = typeof printerPatch.startGcode === "string" ? printerPatch.startGcode : printer.startGcode;
    const end = typeof printerPatch.endGcode === "string" ? printerPatch.endGcode : printer.endGcode;
    if (start !== printer.startGcode || end !== printer.endGcode) library = setGcode(library, start, end);
    library = {
      ...library,
      printers: library.printers.map((row) => {
        if (row.id !== library.printerId) return row;
        return {
          ...row,
          ...(typeof printerPatch.bedX === "number" ? { bedX: printerPatch.bedX } : {}),
          ...(typeof printerPatch.bedY === "number" ? { bedY: printerPatch.bedY } : {}),
          ...(typeof printerPatch.bedZ === "number" ? { bedZ: printerPatch.bedZ } : {}),
        };
      }),
      filaments: library.filaments.map((row) => row.id === library.filamentId && typeof filamentPatch.bedTemp === "number" ? { ...row, bedTemp: filamentPatch.bedTemp } : row),
    };
    const review = reviewGcode(`${start}\n${end}`, { custom: [start, end] });
    if (input.dryRun === true) {
      return { ok: true, dryRun: true, review: review.review.map((line) => line.text), custom: review.custom.map((line) => line.text) };
    }
    this.remember("Machine");
    this.library = library;
    const after = this.machineGet();
    return { ok: true, stale: true, from: before, to: after, review: review.review.map((line) => line.text), custom: review.custom.map((line) => line.text), label: "Machine" };
  }

  private machineSave(name: string): Record<string, unknown> {
    const file = fileFromSelection(this.library);
    if (!file) return { ok: false, reason: "Choose a printer and a filament first." };
    const doc = JSON.parse(serializeMachineFile(file)) as { printer?: Record<string, unknown> };
    if (doc.printer) {
      delete doc.printer.host;
      delete doc.printer.apiKey;
      delete doc.printer.hostType;
      delete doc.printer.startPrint;
    }
    const text = JSON.stringify(doc, null, 2);
    if (text.includes("apiKey") || text.includes("\"host\"")) return { ok: false, reason: "The machine file still names a host." };
    const path = resolveWrite(name.endsWith(".json") ? name : `${name}.limemachine.json`, ".json");
    writeFileSync(path, text);
    return { ok: true, path, bytes: Buffer.byteLength(text) };
  }

  private profileSave(name: string): Record<string, unknown> {
    const text = serializeSettingsProfile({ version: 1, name, settings: this.settings, level: "expert" });
    const path = resolveWrite(profileFileName(name), ".json");
    writeFileSync(path, text);
    return { ok: true, path, bytes: Buffer.byteLength(text) };
  }

  private overrideOf(input: Record<string, unknown>): SettingOverride | { reason: string } {
    const override: SettingOverride = {};
    if (typeof input.infillPercent === "number") {
      if (input.infillPercent < 0 || input.infillPercent > 100) return { reason: "Infill must be from 0–100%." };
      override.infill = input.infillPercent / 100;
    }
    if (typeof input.walls === "number") {
      if (!Number.isInteger(input.walls) || input.walls < 1 || input.walls > 12) return { reason: "Walls must be from 1–12." };
      override.walls = input.walls;
    }
    if (typeof input.speedMmS === "number") {
      if (!(input.speedMmS > 0) || input.speedMmS > 1000) return { reason: "Speed must be from 0–1000 mm/s." };
      override.speed = input.speedMmS;
    }
    if (override.infill === undefined && override.walls === undefined && override.speed === undefined) {
      return { reason: "Set an infill, a wall count, or a speed." };
    }
    return override;
  }

  private partSpan(): { min: number; max: number } | null {
    const obj = this.selectedObject();
    if (!obj) return null;
    const bounds = this.placed(obj).bounds;
    return { min: bounds.min[2], max: bounds.max[2] };
  }

  private rangeAdd(input: Record<string, unknown>): Record<string, unknown> {
    const span = this.partSpan();
    if (!span) return { ok: false, reason: "Load a mesh first." };
    const zFrom = Number(input.zFromMm);
    const zTo = Number(input.zToMm);
    if (zTo < span.min - 1e-6 || zFrom > span.max + 1e-6) {
      return { ok: false, reason: `That range is outside the part. It stands from ${span.min} to ${span.max} mm.` };
    }
    const override = this.overrideOf(input);
    if ("reason" in override) return { ok: false, reason: override.reason };
    const id = freshOverrideId("range");
    if (input.dryRun === true) return { ok: true, dryRun: true, id, zFrom, zTo, override };
    this.remember("Height range");
    this.overrides = addRange(this.overrides, { id, zFrom, zTo, override });
    return { ok: true, id, stale: true, label: "Height range" };
  }

  private modifierAdd(input: Record<string, unknown>): Record<string, unknown> {
    const obj = this.selectedObject();
    if (!obj) return { ok: false, reason: "Load a mesh first." };
    const kind = input.kind === "cylinder" || input.kind === "sphere" ? input.kind : input.kind === "box" ? "box" : null;
    if (!kind) return { ok: false, reason: "kind is box, cylinder, or sphere." };
    const centre = readVec3(input.centre, [Number.NaN, Number.NaN, Number.NaN]);
    const size = readVec3(input.sizeMm, [Number.NaN, Number.NaN, Number.NaN]);
    if (centre.some((value) => !Number.isFinite(value)) || size.some((value) => !(value > 0))) {
      return { ok: false, reason: "The volume needs a centre and a size, in millimetres." };
    }
    const part = this.placed(obj).bounds;
    const volume = { min: [centre[0] - size[0] / 2, centre[1] - size[1] / 2, centre[2] - size[2] / 2], max: [centre[0] + size[0] / 2, centre[1] + size[1] / 2, centre[2] + size[2] / 2] };
    const touches = volume.min.every((value, axis) => value <= part.max[axis] && volume.max[axis] >= part.min[axis]);
    if (!touches) return { ok: false, reason: "That volume does not touch the part." };
    const override = this.overrideOf(input);
    if ("reason" in override) return { ok: false, reason: override.reason };
    const id = freshOverrideId("volume");
    if (input.dryRun === true) return { ok: true, dryRun: true, id };
    this.remember("Modifier");
    this.overrides = addVolume(this.overrides, { id, kind, x: centre[0], y: centre[1], z: centre[2], sx: size[0], sy: size[1], sz: size[2], override });
    return { ok: true, id, stale: true, label: "Modifier" };
  }

  private overridesList(): Record<string, unknown> {
    return { ok: true, ranges: this.overrides.ranges, volumes: this.overrides.volumes };
  }

  private overrideRemove(id: string): Record<string, unknown> {
    const had = this.overrides.ranges.some((row) => row.id === id) || this.overrides.volumes.some((row) => row.id === id);
    if (!had) return { ok: false, reason: "That override is not on the plate." };
    this.remember("Remove override");
    this.overrides = removeVolume(removeRange(this.overrides, id), id);
    return { ok: true, stale: true, label: "Remove override" };
  }

  private layerActionSet(input: Record<string, unknown>): Record<string, unknown> {
    const kind = input.kind === "pause" || input.kind === "filamentChange" || input.kind === "customGcode" ? input.kind : null;
    if (!kind) return { ok: false, reason: "kind is pause, filamentChange, or customGcode." };
    let zMm = Number(input.zMm);
    if (!Number.isFinite(zMm) || zMm < 0) return { ok: false, reason: "zMm is a height in millimetres." };
    const tops = this.latest ? this.summarize(this.latest).layers.map((layer) => layer.z).filter((z) => z + 1e-9 >= zMm) : [];
    if (this.latest && tops.length === 0) return { ok: false, reason: `That is above the sliced part. The top is ${this.summarize(this.latest).layers.at(-1)?.z ?? 0} mm.` };
    if (tops.length) zMm = Math.min(...tops);
    const gcode = typeof input.gcode === "string" ? input.gcode : "";
    if (kind === "customGcode") {
      if (gcode.trim() === "") return { ok: false, reason: "A custom line needs gcode." };
      if (new TextEncoder().encode(gcode).byteLength > 400) return { ok: false, reason: "A custom line is at most 400 bytes." };
    }
    const review = kind === "customGcode" ? reviewGcode(gcode, { custom: [gcode] }).review.map((line) => line.text) : [];
    if (input.dryRun === true) return { ok: true, dryRun: true, zMm, kind, ...(review.length ? { review } : {}) };
    this.remember("Layer action");
    this.actions = this.actions.filter((action) => Math.abs(action.zMm - zMm) > 1e-6);
    this.actions.push({ zMm, kind, ...(typeof input.note === "string" && input.note ? { note: input.note.slice(0, 80) } : {}), ...(kind === "customGcode" ? { gcode: gcode.trim() } : {}) });
    return { ok: true, zMm, stale: true, ...(review.length ? { review } : {}), label: "Layer action" };
  }

  private layerActionsList(): Record<string, unknown> {
    return { ok: true, actions: this.actions.map((action) => ({ ...action })) };
  }

  private layerActionRemove(zMm: number): Record<string, unknown> {
    const next = this.actions.filter((action) => Math.abs(action.zMm - zMm) > 1e-6);
    if (next.length === this.actions.length) return { ok: false, reason: "There is no action at that height." };
    this.remember("Remove layer action");
    this.actions = next;
    return { ok: true, stale: true, label: "Remove layer action" };
  }

  private machineList(input: Record<string, unknown>): Record<string, unknown> {
    const printers = this.library.printers.map((row) => ({
      id: row.id,
      name: shownName(row.name),
      kind: row.kind,
      bedMm: [row.bedX, row.bedY, row.bedZ],
      nozzlesMm: [0.4, 0.6, 0.8],
    }));
    const filaments = this.library.filaments.map((row) => ({
      id: row.id,
      name: shownName(row.name),
      material: row.material,
    }));
    const printerPage = page(printers, input.printerCursor ?? input.cursor, input.limit);
    const filamentPage = page(filaments, input.filamentCursor, input.limit);
    return {
      ok: true,
      printers: printerPage.rows,
      filaments: filamentPage.rows,
      ...(printerPage.nextCursor ? { printersNextCursor: printerPage.nextCursor } : {}),
      ...(filamentPage.nextCursor ? { filamentsNextCursor: filamentPage.nextCursor } : {}),
    };
  }

  private machineSelect(printerId: string, filamentId: string, nozzle: unknown): Record<string, unknown> {
    // --- Split to print (D11). An export-only printer is a target for the pieces, never the plate's printer.
    const exportOnly = exportOnlyRefusal(printerId);
    if (exportOnly) return { ok: false, reason: exportOnly };
    const printer = this.library.printers.find((row) => row.id === printerId);
    const filament = this.library.filaments.find((row) => row.id === filamentId);
    if (!printer || !filament) return { ok: false, reason: "That printer or filament is not in the library." };
    this.library = { ...this.library, printerId, filamentId, nozzleMm: typeof nozzle === "number" ? nozzle : this.library.nozzleMm };
    this.profileTouched = true;
    const heat = heatFor(printer, filament.nozzleTemp, filament.bedTemp);
    const start = printer.startGcode.trim() === "" ? "none" : "applied at export";
    return {
      ok: true,
      printer: printer.name,
      filament: filament.name,
      bedMm: [printer.bedX, printer.bedY, printer.bedZ],
      nozzleC: heat.nozzleC,
      bedC: heat.bedC,
      startGcode: start,
    };
  }

  private machineLoad(path: string): Record<string, unknown> {
    const full = resolveRead(path, "machine");
    const parsed = parseMachineFile(readFileSync(full, "utf8"));
    if (!parsed.ok) return { ok: false, reason: parsed.message };
    const printer: PrinterRecord = { ...parsed.file.printer, id: "loaded-printer", builtin: false };
    const filament: FilamentRecord = { ...parsed.file.filament, id: "loaded-filament", builtin: false };
    this.library = {
      ...this.library,
      printers: [...this.library.printers.filter((row) => row.id !== printer.id), printer],
      filaments: [...this.library.filaments.filter((row) => row.id !== filament.id), filament],
      printerId: printer.id,
      filamentId: filament.id,
      nozzleMm: parsed.file.nozzleMm,
    };
    return this.machineSelect(printer.id, filament.id, parsed.file.nozzleMm);
  }

  private settingsApply(input: Record<string, unknown>): Record<string, unknown> {
    let next = this.settings;
    if (typeof input.path === "string") {
      const parsed = parseSettingsProfile(readFileSync(resolveRead(input.path, "profile"), "utf8"));
      if (!parsed.ok) return { ok: false, reason: parsed.message, changed: [] };
      next = { ...parsed.profile.settings };
    }
    if (typeof input.preset === "string") next = applyPreset(next, input.preset);
    if (typeof input.layerHeight === "number") next = { ...next, layerHeight: input.layerHeight };
    if (typeof input.supports === "boolean") next = { ...next, supports: input.supports };
    const range = settingsRangeError(next, { belt: this.printer().kind === "belt", lineWidth: Math.min(1.2, Math.max(0.2, this.library.nozzleMm * 1.125)) });
    if (range) return { ok: false, reason: range, changed: [] };
    this.remember("Settings");
    this.settings = next;
    const changed = presetKeys().filter((key) => this.settings[key] !== DEFAULT_PRESET[key]);
    return { ok: true, changed, label: "Settings" };
  }

  private schemaContext() {
    return { belt: this.printer().kind === "belt", lineWidth: Math.min(1.2, Math.max(0.2, this.library.nozzleMm * 1.125)) };
  }

  private settingsSchema(input: Record<string, unknown>): Record<string, unknown> {
    const level = input.level === "simple" || input.level === "advanced" || input.level === "expert" ? input.level : undefined;
    const rows = settingRows({
      settings: this.settings,
      ctx: this.schemaContext(),
      query: typeof input.query === "string" ? input.query : undefined,
      level,
      all: input.all === true,
    });
    const listed = page(rows, input.cursor, input.limit);
    return { ok: true, rows: listed.rows, ...(listed.nextCursor ? { nextCursor: listed.nextCursor } : {}) };
  }

  private settingsSet(input: Record<string, unknown>): Record<string, unknown> {
    const values = input.values;
    if (!values || typeof values !== "object" || Array.isArray(values)) return { ok: false, reason: "values must be an object of setting keys." };
    const objectId = typeof input.object === "string" ? input.object : "";
    const obj = objectId ? this.find(objectId) : null;
    if (objectId && !obj) return { ok: false, reason: UNKNOWN_OBJECT, next: "Call plate_list for the current handles." };
    const dryRun = input.dryRun === true;
    const changed: { key: string; from: unknown; to: unknown }[] = [];
    const refused: { key: string; reason: string }[] = [];
    let next = this.settings;
    const objectNext: PlateObjectSettings = obj ? { ...obj.objectSettings } : {};
    for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
      if (obj) {
        if (!isObjectKey(key)) {
          refused.push({ key, reason: "This setting is plate-wide." });
          continue;
        }
        const applied = applyObjectSetting(next, key, value, this.schemaContext());
        if ("reason" in applied) {
          refused.push({ key, reason: applied.reason });
          continue;
        }
        (objectNext as Record<ObjectSettingKey, unknown>)[key] = applied.value;
        changed.push({ key, from: obj.objectSettings[key], to: applied.value });
        continue;
      }
      const applied = applySetting(next, key, value, this.schemaContext());
      if ("reason" in applied) {
        refused.push({ key, reason: applied.reason });
        continue;
      }
      const to = applied.settings[key as keyof PresetSettings];
      next = applied.settings;
      changed.push({ key, from: this.settings[key as keyof PresetSettings], to });
    }
    const warnings = changed.flatMap((row) => {
      const note = inactiveWarning(obj ? this.settings : next, row.key);
      return note ? [note] : [];
    });
    if (changed.length === 0) return { ok: false, reason: refused[0]?.reason ?? "Nothing to change.", refused, ...(warnings.length ? { warnings } : {}) };
    if (!dryRun) {
      this.remember(obj ? "Object settings" : "Settings");
      if (obj) obj.objectSettings = { ...obj.objectSettings, ...objectNext };
      else this.settings = next;
    }
    return {
      ok: true,
      changed,
      ...(refused.length ? { refused } : {}),
      ...(warnings.length ? { warnings } : {}),
      ...(dryRun ? { dryRun: true } : { stale: true }),
      label: obj ? "Object settings" : "Settings",
    };
  }

  private selectedObject(): PlateObject | null {
    return this.find(this.selected) ?? this.objects[0] ?? null;
  }

  private order(): PrintOrder {
    return { printOrder: this.printOrder, clearanceMm: this.clearanceMm, gantryMm: this.gantryMm };
  }

  /** Fields the app's `payload()` puts on one object, or on the plate when more than one is listed. */
  private sliceBody(obj: PlateObject, scope?: unknown): { body: Record<string, unknown>; mesh: Uint8Array } {
    const placed = this.placed(obj);
    const name = /\.(3mf|step|stp)$/i.test(obj.fileName) ? obj.fileName.replace(/\.(3mf|step|stp)$/i, ".stl") : obj.fileName;
    const mesh = stlBytes(scaledCanonical(obj.source, obj.scale), name);
    const objectScope = scope === "object";
    const plateScope = scope === "plate" || (!objectScope && this.plateWantsObjects());
    const oneObject = objectScope && !settingsEmpty(obj.objectSettings);
    const listed = plateScope || oneObject;
    const rules = this.sliceRules(plateScope ? this.objects.length : 1);
    const oneExtra = listed ? {} : this.oneObjectFields(obj);
    const plate = plateScope ? this.plateFields() : oneObject ? this.plateFields([obj]) : {};
    const body = sessionSliceRequest({
      filename: name,
      bytes: mesh,
      pose: placed.pose,
      settings: this.settings,
      printer: this.printer(),
      filament: this.filament(),
      nozzleMm: this.library.nozzleMm,
      actions: this.actions,
      objects: plateScope ? this.objects.length : 1,
      bounds: placed.bounds,
      stepToleranceMm: obj.stepTolerance,
      overrides: this.overrides,
      order: { ...orderFields(rules, this.order()) },
      plate,
      oneExtra,
      encodeMesh: false,
    });
    return { body, mesh };
  }

  private sliceRules(objects: number) {
    const printer = this.printer();
    return settingsRules({
      kind: printer.kind,
      belt: { raftLayers: printer.belt.raftLayers, maxLengthMm: printer.belt.maxLengthMm },
      firmware: printer.firmware,
      firmwareArcs: printer.firmwareArcs,
      objects,
      supportMode: this.settings.supportSource === "paint" ? "paint" : "auto",
    });
  }

  private plateWantsObjects(): boolean {
    return this.objects.length > 1 || this.objects.some((obj) => !settingsEmpty(obj.objectSettings));
  }

  private oneObjectFields(obj: PlateObject): Record<string, unknown> {
    const frame = sourceFrame(obj.source, obj.scale);
    const tree = (obj.objectSettings.supports ?? this.settings.supports) && (obj.objectSettings.supportStyle ?? this.settings.supportStyle) === "tree";
    return {
      ...editRequestFields(obj.supportEdits, tree),
      ...paintRequestFields(obj.supportPaint, frame),
      ...seamRequestFields(obj.seamPaint, frame),
      ...reinforcementRequestFields(obj.reinforcement, frame, normalInfillDensity({
        blendKind: this.settings.blendKind as "single" | "weight" | "byLayer" | "byRegion",
        strategy: this.settings.strategy === "toughness" ? "toughness" : "speed",
        toughness: this.settings.toughness,
        objectInfill: obj.objectSettings.infill,
      })),
    };
  }

  private plateFields(rows: PlateObject[] = this.objects): Record<string, unknown> {
    const specs = rows.map((obj) => {
      const placed = this.placed(obj);
      return {
        id: obj.id,
        fileName: /\.(3mf|step|stp)$/i.test(obj.fileName) ? obj.fileName.replace(/\.(3mf|step|stp)$/i, ".stl") : obj.fileName,
        sourcePos: obj.source,
        partScale: obj.scale,
        stepTolerance: obj.stepTolerance,
        supportEdits: obj.supportEdits,
        supportPaint: obj.supportPaint,
        seamPaint: obj.seamPaint,
        reinforcement: obj.reinforcement,
        settings: obj.objectSettings,
        pose: placed.pose,
        height: placed.bounds.max[2] - placed.bounds.min[2],
      };
    });
    const ordered = sequentialClearance(this.sliceRules(specs.length), this.order()) === null ? specs : tallestLast(specs, (row) => row.height);
    const plateObjects: SliceObject[] = ordered.map((row) => ({
      id: row.id,
      name: row.fileName,
      fileName: row.fileName,
      bytes: new ArrayBuffer(0),
      sourcePos: row.sourcePos,
      orient: [...ID_MATRIX] as Mat3,
      partScale: row.partScale,
      centered: true,
      offset: { x: 0, y: 0, z: 0 },
      stepTolerance: row.stepTolerance,
      supportEdits: row.supportEdits,
      supportPaint: row.supportPaint,
      seamPaint: row.seamPaint,
      reinforcement: row.reinforcement,
      settings: row.settings,
    }));
    const poseOf = new Map(specs.map((row) => [row.id, row.pose]));
    const fields = slicePlateFields(plateObjects, (row) => poseOf.get(row.id) ?? specs[0]!.pose, {
      supports: this.settings.supports,
      supportStyle: this.settings.supportStyle,
      blendKind: this.settings.blendKind as "single" | "weight" | "byLayer" | "byRegion",
      strategy: this.settings.strategy === "toughness" ? "toughness" : "speed",
      toughness: this.settings.toughness,
    });
    const trees = specs.some((row) => (row.settings.supports ?? this.settings.supports) && (row.settings.supportStyle ?? this.settings.supportStyle) === "tree");
    const objects = fields.objects.map((row) => {
      const spec = specs.find((item) => item.id === row.id);
      if (!spec) return row;
      const mesh = stlBytes(scaledCanonical(spec.sourcePos, spec.partScale), spec.fileName);
      return { ...row, dataB64: bytesToBase64(mesh) };
    });
    return { ...fields, objects, ...(trees ? { includeSkeleton: true } : {}) };
  }

  /** Features still left out of the slice body. Empty once each one is sent the way the app sends it. */
  private notSliced(): string[] {
    return [];
  }

  private async sliceStart(cancelRunning: boolean, scope?: unknown): Promise<Record<string, unknown>> {
    if (this.running && this.running.status === "running") {
      if (!cancelRunning) {
        return { ok: false, reason: `A slice is already running (${this.running.handle}). Cancel it or pass cancelRunning.` };
      }
      await this.ask(this.engine.sliceCancel(String(this.running.engineId)));
      this.running.status = "cancelled";
      this.running = null;
    }
    const obj = this.selectedObject();
    if (!obj) return { ok: false, reason: "Load a mesh first." };
    const committed = await this.commitObject(obj);
    if (committed) return { ok: false, reason: committed };
    const skipped = this.notSliced();
    const built = this.sliceBody(obj, scope);
    const collisions = this.plateCollisions();
    const plateBody = Array.isArray(built.body.objects);
    const started = JSON.parse(await this.ask(this.engine.sliceStart(JSON.stringify(built.body), plateBody ? undefined : built.mesh))) as { id?: number; error?: string };
    if (typeof started.id !== "number") return { ok: false, reason: humanEngineError(started.error ?? "The slice did not start.") };
    this.jobSeq += 1;
    const job: Job = { handle: `job_${this.jobSeq}`, engineId: started.id, objectId: obj.id, stamp: this.sliceStamp(), status: "running" };
    this.running = job;
    this.retainJobs(job);
    return {
      ok: true,
      job: job.handle,
      status: "running",
      object: obj.id,
      name: shownName(obj.name),
      collisions,
      objects: this.objects.map((row) => row.id),
      ...(skipped.length ? { notSliced: skipped, note: `This project has ${skipped.join(", ")} that this server does not slice yet. The G-code will differ from the app's.` } : {}),
    };
  }

  private sliceStamp(): string {
    return JSON.stringify({
      printerId: this.library.printerId,
      filamentId: this.library.filamentId,
      nozzleMm: this.library.nozzleMm,
      settings: this.settings,
      actions: fnv1aHex(new TextEncoder().encode(JSON.stringify(this.actions))),
      generation: this.generation,
      overrides: this.overrides,
      printOrder: this.printOrder,
      clearanceMm: this.clearanceMm,
      gantryMm: this.gantryMm,
      objects: this.objects.map((row) => ({
        id: row.id,
        orient: row.orient,
        scale: row.scale,
        centered: row.centered,
        offset: row.offset,
        modelPose: row.modelPose,
        mesh: meshKeyHex(row.bytes),
        source: meshKeyHex(new Uint8Array(row.source.buffer, row.source.byteOffset, row.source.byteLength)),
        treeCurrent: row.tree?.current ?? null,
        treeCommitted: row.tree?.committed ?? null,
        objectSettings: row.objectSettings,
        supportPaint: row.supportPaint.length,
        seamPaint: row.seamPaint.length,
        reinforcement: row.reinforcement.length,
        supportEdits: row.supportEdits.length,
      })),
    });
  }

  private staleReason(job: Job): string | null {
    if (!this.find(job.objectId) || !job.stamp || this.sliceStamp() !== job.stamp) return STALE_SLICE;
    return null;
  }

  private jobOf(handle: string): Job | null {
    return this.jobs.find((job) => job.handle === handle) ?? null;
  }

  private async sliceWait(handle: string, meta?: CallMeta, timeoutS?: number): Promise<Record<string, unknown>> {
    const work = this.workJobs.find((row) => row.handle === handle);
    if (work) return this.workWait(work, meta, timeoutS);
    const job = this.jobOf(handle);
    if (!job) return { ok: false, job: handle, reason: "That slice job is not in this session." };
    const limitS = typeof timeoutS === "number" && Number.isFinite(timeoutS)
      ? Math.min(SLICE_WAIT_MAX_S, Math.max(0.05, timeoutS))
      : SLICE_WAIT_DEFAULT_S;
    const deadline = Date.now() + limitS * 1000;
    let fraction = 0;
    let stage = "";
    while (job.status === "running" && Date.now() < deadline) {
      if (meta?.signal?.aborted) return { ok: false, job: job.handle, status: "cancelled", reason: "The wait was cancelled." };
      const poll = JSON.parse(await this.ask(this.engine.slicePoll(String(job.engineId)))) as { status?: string; stage?: string; fraction?: number; result?: string; error?: string };
      if (typeof poll.fraction === "number") {
        fraction = poll.fraction;
        stage = poll.stage ?? "";
        const now = Date.now();
        if (fraction >= 1 || now - this.lastProgressAt >= 250) {
          this.lastProgressAt = now;
          this.onProgress?.(job.handle, fraction, stage, meta?.progressToken);
        }
      }
      if (poll.status === "done" && poll.result) {
        job.status = "done";
        job.wire = JSON.parse(poll.result) as Record<string, unknown>;
        job.gcode = typeof job.wire.gcode === "string" ? job.wire.gcode : undefined;
        this.keepLatestWire(job);
      } else if (poll.status === "cancelled") {
        job.status = "cancelled";
      } else if (poll.status === "error" || poll.error) {
        job.status = "error";
        job.error = typeof poll.error === "string" ? poll.error : JSON.stringify(poll.error ?? "The slice failed.");
      } else {
        await this.pause(20, meta?.signal);
      }
    }
    if (meta?.signal?.aborted && job.status === "running") {
      return { ok: false, job: job.handle, status: "cancelled", reason: "The wait was cancelled." };
    }
    const named = this.find(job.objectId);
    if (job.status === "running") {
      return { ok: true, job: job.handle, status: "running", fraction, stage, ...(named ? { object: named.id, name: named.name } : {}) };
    }
    if (this.running?.handle === job.handle && job.status !== "running") this.running = null;
    if (job.status === "done") this.latest = job;
    if (job.status === "cancelled") return { ok: false, job: job.handle, status: "cancelled", reason: "The slice was cancelled." };
    if (job.status !== "done" || !job.wire) {
      const reason = job.error ? humanEngineError(this.errorText(job.error)) : "The slice did not finish.";
      return { ok: false, job: job.handle, status: "error", reason };
    }
    const summary = this.summarize(job);
    return {
      ok: true,
      job: job.handle,
      status: "done",
      object: named?.id,
      name: named ? shownName(named.name) : undefined,
      printer: this.printer().name,
      filament: this.filament().name,
      layerHeight: this.settings.layerHeight,
      seconds: Math.round(summary.seconds),
      grams: roundTo(summary.grams, 2),
      cost: roundTo(summary.cost, 2),
    };
  }

  private errorText(error: string): string {
    try {
      const parsed = JSON.parse(error) as { error?: string };
      if (typeof parsed.error === "string") return parsed.error;
    } catch {
      // The engine sometimes returns the sentence itself.
    }
    return error;
  }

  private async sliceCancel(handle: string): Promise<Record<string, unknown>> {
    const work = this.workJobs.find((row) => row.handle === handle);
    if (work) return this.workCancel(work);
    const job = this.jobOf(handle);
    if (!job) return { ok: false, reason: "That slice job is not in this session." };
    await this.ask(this.engine.sliceCancel(String(job.engineId)));
    if (job.status === "running") job.status = "cancelled";
    if (this.running?.handle === job.handle) this.running = null;
    return { ok: true, status: job.status === "done" ? "done" : "cancelled" };
  }

  private summarize(job: Job): SliceSummary {
    const wire = job.wire ?? {};
    const estimate = (wire.estimate ?? {}) as { seconds?: number; filamentMm?: number; byFeature?: { kind: string; seconds: number; filamentMm: number }[] };
    const filament = this.filament();
    const spec = { filamentDiameter: filament.diameterMm, filamentDensityGCm3: filament.densityGCm3, filamentCostPerKg: filament.costPerKg };
    const filamentMm = estimate.filamentMm ?? 0;
    const grams = filamentGrams(filamentMm, spec);
    const features = groupFeatures(estimate.byFeature ?? [], spec);
    const raw = Array.isArray(wire.layers) ? wire.layers as { z?: number; seconds?: number }[] : [];
    const layers = raw.filter((layer) => typeof layer.z === "number").map((layer) => ({ z: layer.z as number, seconds: layer.seconds }));
    const known = layers.length > 0 && layers.every((layer) => typeof layer.seconds === "number");
    return {
      seconds: estimate.seconds ?? 0,
      grams,
      filamentMm,
      cost: mass(filamentMm, spec).cost,
      warnings: this.warnings(wire),
      features,
      layerSeconds: known ? layers.map((layer) => layer.seconds as number) : [],
      layers: layers.map((layer) => ({ z: layer.z, ...(typeof layer.seconds === "number" ? { seconds: layer.seconds } : {}) })),
    };
  }

  private warnings(wire: Record<string, unknown>): string[] {
    const out: string[] = [];
    const rows = Array.isArray(wire.warnings) ? wire.warnings : [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const warning = row as { code?: string; repairedLayers?: number; bridgedMm?: number; droppedChains?: number; message?: string };
      if (warning.code === "mesh-repair") {
        const counts: MeshRepair = {
          repairedLayers: warning.repairedLayers ?? 0,
          bridgedMm: warning.bridgedMm ?? 0,
          droppedChains: warning.droppedChains ?? 0,
        };
        const text = meshWarningText(counts);
        if (text) out.push(text);
      } else if (warning.message) out.push(humanEngineError(warning.message));
    }
    const air = inAirWarning(wire.inAir as { islands: number; overhangs: number } | undefined, this.settings.supportSource === "paint");
    if (air) out.push(air);
    const cover = coverageWarning((wire.coverage as { areaMm2: number }[] | undefined) ?? []);
    if (cover) out.push(cover);
    return out;
  }

  private finished(handle?: string): Job | null {
    if (handle) return this.jobOf(handle);
    return this.latest;
  }

  private gcodeSummary(handle?: string): Record<string, unknown> {
    const job = this.finished(handle);
    if (!job?.gcode || !job.wire) return { ok: false, reason: "Slice first." };
    const stale = this.staleReason(job);
    if (stale) return { ok: false, reason: stale };
    const summary = this.summarize(job);
    const review = reviewGcode(this.fileText(job, new Date(Date.UTC(2020, 0, 2, 3, 4, 5))), {
      custom: this.customBlocks(),
      maxNozzleC: this.printer().maxNozzleC,
    });
    return {
      ok: true,
      seconds: summary.seconds,
      grams: summary.grams,
      cost: summary.cost,
      features: summary.features,
      warnings: summary.warnings,
      head: review.head,
      tail: review.tail,
      review: review.review,
      custom: review.custom,
    };
  }

  /** Lines a person wrote: machine start and end, and custom layer actions. */
  private customBlocks(): string[] {
    const printer = this.printer();
    const actions = this.actions
      .filter((action) => action.kind === "customGcode" && action.gcode)
      .map((action) => action.gcode as string);
    return [printer.startGcode, printer.endGcode, ...actions];
  }

  private gcodeExport(input: Record<string, unknown>): Record<string, unknown> {
    const job = this.finished(typeof input.job === "string" ? input.job : undefined);
    if (!job?.gcode) return { ok: false, reason: "Slice first." };
    const stale = this.staleReason(job);
    if (stale) return { ok: false, reason: stale };
    const now = typeof input.now === "string" ? new Date(input.now) : new Date();
    if (Number.isNaN(now.getTime())) return { ok: false, reason: "That clock is not a time." };
    const text = this.fileText(job, now);
    const path = resolveWrite(String(input.name), ".gcode");
    writeFileSync(path, text);
    return { ok: true, path, bytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") };
  }

  private async export3mf(name: string): Promise<Record<string, unknown>> {
    if (this.objects.length === 0) return { ok: false, reason: "The plate is empty." };
    const refused = (await this.commitAll())[0];
    if (refused) return { ok: false, reason: `${refused.name} (${refused.object}): ${refused.reason}`, object: refused.object };
    const meshes = this.objects.map((obj) => this.placed(obj).positions);
    const bytes = encode3mf(meshes);
    const path = resolveWrite(name, ".3mf");
    writeFileSync(path, bytes);
    return { ok: true, path, bytes: bytes.byteLength };
  }

  private meshStats(id: string): Record<string, unknown> {
    const obj = this.find(id);
    if (!obj) return { ok: false, reason: UNKNOWN_OBJECT };
    const placed = this.placed(obj);
    const size = [
      placed.bounds.max[0] - placed.bounds.min[0],
      placed.bounds.max[1] - placed.bounds.min[1],
      placed.bounds.max[2] - placed.bounds.min[2],
    ];
    return {
      ok: true,
      object: obj.id,
      triangles: obj.triangles,
      bboxMm: { min: placed.bounds.min, max: placed.bounds.max },
      sizeMm: size,
      notes: this.plateNotes(obj, placed.bounds),
    };
  }

  private layerSummary(handle?: string): Record<string, unknown> {
    const job = this.finished(handle);
    if (!job?.wire) return { ok: false, reason: "Slice first." };
    const stale = this.staleReason(job);
    if (stale) return { ok: false, reason: stale };
    const summary = this.summarize(job);
    const first = summary.layers[0];
    const last = summary.layers[summary.layers.length - 1];
    return {
      ok: true,
      layers: summary.layers.length,
      firstZ: first?.z ?? 0,
      lastZ: last?.z ?? 0,
    };
  }

  private async renderView(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const obj = this.find(typeof input.object === "string" ? input.object : this.selected) ?? this.objects[0];
    if (!obj) return { ok: false, reason: "Load a mesh first." };
    const committed = await this.commitObject(obj);
    if (committed) return { ok: false, reason: committed };
    const turntable = typeof input.turntable === "number" ? Math.round(input.turntable) : 0;
    const many = Array.isArray(input.views) || turntable > 1;
    // A turntable: views all round the part, a little from above, the first from the front.
    const around = Array.from({ length: turntable }, (_, k) => {
      const a = (k / turntable) * 2 * Math.PI;
      return { direction: [Math.round(-Math.sin(a) * 1e4) / 1e4, Math.round(-Math.cos(a) * 1e4) / 1e4, 0.45] };
    });
    const asked = turntable > 1 ? around : many ? input.views as unknown[] : [{ camera: input.camera, direction: input.direction, up: input.up }];
    const cameras: { label: string; camera: Camera | CameraSpec }[] = [];
    for (const raw of asked) {
      const read = readCamera(raw);
      if ("reason" in read) return { ok: false, reason: read.reason };
      cameras.push(read);
    }
    let ghost: Ghost | null = null;
    if (input.op !== undefined) {
      const made = await this.ghostMesh(obj, input.op);
      if ("reason" in made) return { ok: false, reason: made.reason };
      ghost = made;
    }
    // --- 3.1 F12. A section, a highlight or colours need the solid: a STEP import is opened for them here, as
    // model_describe would open it, instead of being refused until something else had.
    const looksAsked = input.section !== undefined || input.highlight !== undefined || input.colours !== undefined;
    if (looksAsked && !(obj.solid && obj.solid.positions.length >= 9) && !this.meshBlock(obj)) {
      try {
        const opened = await this.opened(obj);
        if ("reason" in opened) return { ok: false, reason: opened.reason };
      } catch (err) {
        if (err instanceof ProtocolError) return { ok: false, reason: err.message };
        throw err;
      }
    }
    const solidMesh = !!obj.solid && obj.solid.positions.length >= 9;
    const mesh = solidMesh ? obj.solid!.positions : this.placed(obj).positions;
    const looks = this.renderLooks(obj, input, solidMesh);
    if ("reason" in looks) return { ok: false, reason: looks.reason };
    const stem = typeof input.name === "string" ? input.name.replace(/\.png$/i, "") : obj.name;
    const edge = typeof input.longEdge === "number" ? input.longEdge : 768;
    const views: { camera: string; path: string; width: number; height: number }[] = [];
    const pictures: InlineImage[] = [];
    cameras.forEach(({ label, camera }, index) => {
      const drawn = renderMesh(mesh, camera, edge, ghost?.mesh, looks.options);
      const file = many ? `${stem}-${label}${cameras.filter((row) => row.label === label).length > 1 ? `-${index + 1}` : ""}.png` : typeof input.name === "string" ? input.name : `${obj.name}-${label}.png`;
      const path = resolveWrite(file, ".png");
      writeFileSync(path, drawn.png);
      views.push({ camera: label, path, width: drawn.width, height: drawn.height });
      pictures.push(pngImage(drawn.png));
    });
    // --- 3.1 F5. Faces too small to see draw their edges as specks. They are the solid's own: a back cover's lattice
    // ribs broke through its rounded outer edge by 0.2 mm at every rib end, which read as a drawing fault.
    const tiny = solidMesh ? obj.solid!.faces.filter((face) => face.areaMm2 < 0.1) : [];
    const slivers = tiny.length
      ? { slivers: { count: tiny.length, frame: "part", at: tiny.slice(0, 3).map((face) => face.centre.map((v) => Math.round(v * 100) / 100)), note: `${tiny.length} face${tiny.length === 1 ? " is" : "s are"} under 0.1 mm², drawn as specks: the solid has them, often where a step breaks through a thin wall. faces_find {nearPoint} at one (part frame) names it.` } }
      : {};
    const note = { ...(ghost ? { ghost: { colour: "orange", touchesSolid: ghost.touches } } : {}), ...(looks.legend.length ? { colours: looks.legend } : {}), ...slivers };
    const body = many ? { ok: true, views, ...note } : { ok: true, ...views[0]!, ...note };
    return input.inline === false ? body : withImages(body, pictures);
  }

  /**
   * render_view's highlight, colours, section, and smooth, as the renderer takes them: label boxes and the section
   * plane in the solid's frame, where its mesh is.
   */
  private renderLooks(obj: PlateObject, input: Record<string, unknown>, solidMesh: boolean): { options: RenderOptions; legend: Record<string, unknown>[] } | { reason: string } {
    // The solid's faces also let an edge line show only where its own faces are in front (--- 3.1 F5).
    const options: RenderOptions = { smooth: input.smooth !== false, ...(solidMesh ? { faces: obj.solid!.triangles } : {}) };
    const legend: Record<string, unknown>[] = [];
    const wanted: { label: string; rgb: [number, number, number] }[] = [];
    const highlight = typeof input.highlight === "string" ? [input.highlight] : Array.isArray(input.highlight) ? input.highlight.map(String) : [];
    for (const label of highlight) wanted.push({ label, rgb: [255, 135, 30] });
    for (const [label, hex] of Object.entries((input.colours ?? {}) as Record<string, unknown>)) {
      const match = /^#?([0-9a-f]{6})$/i.exec(String(hex));
      if (!match) return { reason: `colours.${label} is a colour like "#c86450".` };
      const n = parseInt(match[1]!, 16);
      wanted.push({ label, rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255] });
    }
    if ((wanted.length || input.section !== undefined) && !solidMesh) return { reason: "highlight, colours, and section need a solid, and this part is a mesh (STL, OBJ or 3MF), which has none. Import its STEP file, or make the part with solid_new or model_build." };
    if (wanted.length) {
      options.tints = [];
      for (const { label, rgb } of wanted) {
        const box = this.labelBox(obj, label, true);
        if (!box) return { reason: `No step is labelled "${label}" with a tool to measure. model_anchors lists the labels.` };
        options.tints.push({ min: box.min, max: box.max, rgb });
        legend.push({ label, rgb: `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}` });
      }
    }
    if (input.section !== undefined) {
      const spec = input.section as { normal?: unknown; point?: unknown };
      const back = inversePose(obj.modelPose);
      const bounds = obj.solid!.bounds;
      const centre = [0, 1, 2].map((i) => (bounds.min[i]! + bounds.max[i]!) / 2) as [number, number, number];
      const normal = readVec3(spec.normal, [0, -1, 0]);
      if (Math.hypot(...normal) < 1e-9) return { reason: "section.normal needs a direction." };
      options.section = {
        point: spec.point === undefined ? centre : applyPose(back, readVec3(spec.point, [0, 0, 0])),
        normal: turnDir(back, normal),
      };
    }
    return { options, legend };
  }

  /** The tool shape of a boolean op, for a preview: it is drawn, never applied. */
  private async ghostMesh(obj: PlateObject, raw: unknown): Promise<Ghost | { reason: string }> {
    const tree = await this.opened(obj);
    if ("reason" in tree) return { reason: tree.reason };
    if (!obj.solid) return { reason: "This solid could not be read." };
    const baked = this.bake(obj, raw);
    if ("reason" in baked) return { reason: baked.reason };
    if (baked.op.kind !== "boolean") return { reason: "A preview needs a boolean op." };
    const spec = baked.op as unknown as PrimitiveSpec;
    const mesh = toolMesh(spec);
    if (mesh.length < 9) return { reason: "That tool shape has no size." };
    return { mesh, touches: disjointBoolean(obj.solid.bounds, spec, baked.op.op) === null };
  }

  private async surfaceAt(obj: PlateObject, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const tree = await this.opened(obj);
    if ("reason" in tree) return { ok: false, reason: tree.reason };
    if (!obj.solid) return { ok: false, reason: "This solid could not be read." };
    return surfaceAtSolid(obj.solid, input);
  }

  private async modelCheck(obj: PlateObject, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const tree = await this.opened(obj);
    if ("reason" in tree) return { ok: false, reason: tree.reason };
    if (!obj.solid || obj.solid.positions.length < 9) return { ok: false, reason: "This solid could not be read." };
    const printer = this.printer();
    // As it prints: the plate's turn and scale, lowest point on the bed. Places come back in the solid's frame.
    const printed = printFrame(obj.solid.positions, obj.orient, obj.scale);
    const checked = checkInSource(printCheck({ positions: printed.positions, overhangDeg: typeof input.overhangDeg === "number" ? input.overhangDeg : 45, buildMm: [printer.bedX, printer.bedY, printer.bedZ] }), printed.toSource);
    // Two lines of the nozzle's width is the thinnest wall a slicer fills; thinner prints as one line or not at all.
    const nozzle = this.library.nozzleMm || 0.4;
    const minWallMm = typeof input.minWallMm === "number" ? input.minWallMm : Math.round(nozzle * 2 * 100) / 100;
    const thin = thinWalls(obj.solid.positions, minWallMm);
    // In the solid's frame, as the overhang regions are.
    const regions = thin.regions;
    const warnings = [...(checked.warnings as string[])];
    if (regions.length) {
      const worst = regions.reduce((a, b) => (b.thinnestMm < a.thinnestMm ? b : a));
      warnings.push(`Walls thinner than ${minWallMm} mm cover ${thin.areaMm2} mm², thinnest ${worst.thinnestMm} mm at (${worst.centre.join(", ")})${worst.thinnestMm < nozzle ? ": thinner than the nozzle, so it will not print" : ""}.`);
    }
    // Edges, as the plate mesh would have them: cracks a commit mends are counted apart from what stays open.
    const raw = edgeReport(obj.solid.positions, 8);
    const mended = raw.open === 0 && raw.degenerate === 0 ? raw : edgeReport(closeCracks(obj.solid.positions), 8);
    const closedEdges = {
      open: mended.open,
      nonManifold: mended.nonManifold,
      ...(mended.openAt.length ? { openAt: mended.openAt } : {}),
      ...(mended.nonManifoldAt.length ? { nonManifoldAt: mended.nonManifoldAt } : {}),
      ...(raw.open > mended.open ? { crackEdgesMended: raw.open - mended.open } : {}),
    };
    if (mended.open > 0) warnings.push(`The mesh has ${mended.open} open edges, the first at (${mended.openAt[0]!.at.join(", ")}). model_commit refuses it until they close.`);
    if (mended.nonManifold > 0) warnings.push(`${mended.nonManifold} edges are where pieces meet only along a line, the first at (${mended.nonManifoldAt[0]!.at.join(", ")}). model_commit refuses it until they overlap or part.`);
    return {
      ...checked,
      edges: closedEdges,
      thinWalls: { minWallMm, nozzleMm: nozzle, areaMm2: thin.areaMm2, regions, sampledPoints: thin.sampled },
      warnings,
      notChecked: [],
      printer: printer.name,
    };
  }

  /** A probe, and what the edit would do to the solid when the modeler sent the result back. */
  private async probeMeasured(obj: PlateObject, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.lastPreview = null;
    const out = await this.probe(obj, input.op, input.node, true);
    if (out.ok !== true || !obj.solid) return out;
    const op = out.stored as ModelOp | undefined;
    const before = solidMetrics(obj.solid);
    const lastPreview = this.lastPreview;
    let after: SolidMetrics | null = null;
    if (op?.kind === "scale") {
      const f = op.factor;
      const box = obj.solid.bounds;
      after = { volumeMm3: before.volumeMm3 * f ** 3, bbox: { min: box.min.map((v) => v * f) as [number, number, number], max: box.max.map((v) => v * f) as [number, number, number] }, shellCount: before.shellCount };
    } else if (lastPreview) {
      after = solidMetrics(lastPreview);
    }
    if (input.node !== undefined && this.nodeOf(obj, input.node) !== obj.tree?.current) return out;
    const measured = probeMetrics(before, after);
    return { ...out, ...(measured.warning ? { reason: `${String(out.reason)} ${measured.warning}`, warning: measured.warning } : {}), metrics: measured.metrics };
  }

  resource(uri: string): Record<string, unknown> | Promise<Record<string, unknown>> {
    const guide = guideByUri(uri);
    if (guide) return { name: guide.name, tools: guide.tools, text: guide.text };
    if (uri === "lime://session") {
      return { workspace: process.env.LIME_MCP_WORKSPACE ?? "", selected: this.selected, objects: this.objects.map((obj) => obj.id), printer: this.library.printerId, filament: this.library.filamentId, running: this.running?.handle ?? null };
    }
    if (uri === "lime://machines") {
      return { printers: this.library.printers.map((row) => ({ id: row.id, name: row.name, bedMm: [row.bedX, row.bedY, row.bedZ] })), filaments: this.library.filaments.map((row) => ({ id: row.id, name: row.name, material: row.material })) };
    }
    if (uri === "lime://project") {
      const changed = presetKeys().filter((key) => this.settings[key] !== DEFAULT_PRESET[key]);
      return { objects: this.objects.map((obj) => ({ object: obj.id, name: shownName(obj.name) })), changed };
    }
    if (uri === "lime://slice/latest") {
      if (!this.latest?.wire) return { ready: false };
      const stale = this.staleReason(this.latest);
      const summary = this.summarize(this.latest);
      if (stale) return { ready: true, stale: true, reason: stale, seconds: summary.seconds, grams: summary.grams, warnings: summary.warnings };
      return { seconds: summary.seconds, grams: summary.grams, warnings: summary.warnings, stale: false };
    }
    if (uri === "lime://gcode/latest/summary") return this.gcodeSummary();
    const history = /^lime:\/\/object\/([^/]+)\/history$/.exec(uri);
    if (history) return this.model("model_history", { object: history[1]! });
    throw new ProtocolError("That resource is not on this server.");
  }

  private model(name: string, input: Record<string, unknown>): Record<string, unknown> | Promise<Record<string, unknown>> {
    if (name === "solid_new") return input.coupon !== undefined ? this.fitCouponNew(input) : this.solidNew(input);
    if (name === "model_build") return this.build(input);
    if (name === "model_params") return this.paramsTool(input);
    if (name === "model_define") return this.defineTool(input);
    const requested = typeof input.object === "string" ? input.object : "";
    // --- Split to print (D12). An export target's piece is off the plate and still a part to model.
    const obj = this.find(requested !== "" ? requested : this.selected) ?? this.piecesOffPlate.find((row) => row.id === requested && this.exportCut(row) !== null) ?? null;
    if (!obj) return { ok: false, reason: UNKNOWN_OBJECT };
    switch (name) {
      case "model_describe": return this.describe(obj, input);
      case "faces_find": return this.facesFind(obj, input);
      case "edges_find": return this.edgesFind(obj, input);
      case "workplane_set": return this.workplaneSet(obj, input);
      case "workplane_print_up": return this.printUp(obj);
      case "model_place": return this.modelPlace(obj, input);
      case "model_probe": {
        const anchored = this.anchored(obj, input.op as Record<string, unknown>);
        if ("reason" in anchored) return { ok: false, reason: anchored.reason };
        // --- Split to print: plan runs the planner alone, with no kernel call.
        if (input.plan === true) return this.planTool(obj, anchored.op);
        return this.probeMeasured(obj, { ...input, op: anchored.op });
      }
      case "surface_at": return this.surfaceAt(obj, input);
      case "model_check": return this.modelCheck(obj, input);
      case "model_apply": return this.applyTool(obj, input);
      case "model_apply_batch": return this.applyBatch(obj, input);
      case "model_history": return this.history(obj, input);
      case "model_anchors": return this.anchorsTool(obj, input);
      case "model_goto": return this.gotoNode(obj, this.nodeOf(obj, input.node));
      case "model_undo": return this.step(obj, "undo");
      case "model_redo": return this.step(obj, "redo");
      case "model_edit": return this.edit(obj, this.nodeOf(obj, input.node), input.op);
      case "model_drop": return this.drop(obj, this.nodeOf(obj, input.node));
      case "model_rename": return this.rename(obj, this.nodeOf(obj, input.node), String(input.label ?? ""));
      case "model_commit": return this.commit(obj);
      case "model_export_step": return input.pieces === true ? this.exportPieceStep(obj, String(input.name)) : this.exportStep(obj, String(input.name));
      case "measure": return this.measure(obj, input);
      default: throw new ProtocolError(`There is no tool named ${name}.`);
    }
  }

  /**
   * How long one modeler call may run before the server kills the modeler, which closes every open tree. --- 3.1 F9.
   * It is longer than the engine's own 60 s limit on a new step, which stops a slow boolean or blend cleanly with a
   * refusal: at 30 s the server killed first, and a 3,000-face join came back as treeLost instead of a sentence.
   */
  private modelTimeoutMs(): number {
    const raw = Number(process.env.LIME_MCP_MODEL_TIMEOUT_S);
    const seconds = Number.isFinite(raw) && raw > 0 ? raw : 90;
    return seconds * 1000;
  }

  /** The steps from the root to `node`, a group's counted one by one: what a goto there may replay. */
  private stepsTo(tree: ModelTree, node: number): number {
    return pathTo(tree, node).reduce((sum, id) => {
      const op = tree.nodes.get(id)?.op;
      return sum + (op ? 1 : 0) + (op?.kind === "group" ? op.steps.length : 0);
    }, 0);
  }

  /** A call that replays `steps` steps (a group's count as many): two seconds each, at least the one-call limit. */
  private replayBudgetMs(steps: number): number {
    return Math.max(this.modelTimeoutMs(), steps * 2000);
  }

  private runawayMessage(kind: string, budgetMs: number): string {
    const seconds = Math.max(1, Math.round(budgetMs / 1000));
    if (kind === "preview") return `This mesh did not finish opening in ${seconds} s. Nothing changed.`;
    const name = kind === "fillet" || kind === "chamfer" ? kind : "edit";
    return `This ${name} did not finish in ${seconds} s. Nothing changed. Try a smaller size or fewer edges.`;
  }

  /**
   * A native call on a worker. The timer runs on this thread, so a blocked call can be cut off.
   * `onRunaway` replaces the stuck worker; by default that is the modeler, which drops the open trees.
   */
  private async withBudget<T>(kind: string, work: () => T | Promise<T>, onRunaway: () => Promise<void> = () => this.loseTrees(), budgetMs?: number): Promise<T> {
    const budget = budgetMs ?? this.modelTimeoutMs();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rss: ReturnType<typeof setInterval> | undefined;
    try {
      return await new Promise<T>((resolve, reject) => {
        timer = setTimeout(() => reject(new ModelRunaway(this.runawayMessage(kind, budget))), budget);
        const cap = Number(process.env.LIME_MCP_MODEL_RSS_MB);
        if (Number.isFinite(cap) && cap > 0) {
          rss = setInterval(() => {
            if (process.memoryUsage().rss / (1024 * 1024) > cap) reject(new ModelRunaway(this.runawayMessage(kind, budget)));
          }, 1000);
        }
        Promise.resolve(work()).then(
          resolve,
          (err: unknown) => reject(err instanceof Error ? err : new ProtocolError("The modeler did not answer.")),
        );
      });
    } catch (err) {
      if (err instanceof ModelRunaway) {
        await onRunaway();
        throw err;
      }
      throw new ProtocolError(err instanceof Error ? err.message : "The modeler did not answer.");
    } finally {
      if (timer) clearTimeout(timer);
      if (rss) clearInterval(rss);
    }
  }

  /** A timed-out mesh preview is replaced. The modeler and its open trees are left alone. */
  private async resetPreview(): Promise<void> {
    try {
      await this.ask(this.engine.resetPreview?.());
    } catch {
      // The next preview starts a fresh worker either way.
    }
  }

  /** A timed-out modeler is replaced. Open trees are dropped; the last committed bytes stay. */
  private async loseTrees(): Promise<void> {
    try {
      await this.ask(this.engine.resetModeler());
    } catch {
      // The next model call starts a fresh modeler either way.
    }
    // Each history stays; its tree is built again from the root and ops when it is next used. A piece's tree, which
    // starts from another tree's split, reopens from its plate bytes as before.
    for (const obj of [...this.objects, ...this.toolsOffPlate, ...this.piecesOffPlate]) {
      obj.probes = new Map();
      if (obj.tree && obj.tree.root.kind !== "piece") obj.treeStale = true;
      else {
        obj.tree = null;
        obj.solid = null;
      }
    }
  }

  private lostReply(err: unknown): Record<string, unknown> | null {
    if (!(err instanceof ModelRunaway)) return null;
    return {
      ok: false,
      reason: err.message,
      treeLost: true,
      treeNote: "The modeler did not answer, so it was restarted, which closed every open history in it. Nothing applied is lost: each history is built again from its first solid and its steps on its next use, which takes a while on a long one.",
    };
  }

  private async treeCall(body: Record<string, unknown>, label = "edit", budgetMs?: number): Promise<Record<string, unknown>> {
    const op = body.op && typeof body.op === "object" ? body.op as { kind?: unknown } : null;
    const kind = typeof op?.kind === "string" ? op.kind : label;
    const text = await this.withBudget(kind, () => this.engine.modelTree(JSON.stringify(body)), undefined, budgetMs);
    let reply: Record<string, unknown>;
    try {
      reply = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new ProtocolError("The modeler returned a damaged reply.");
    }
    const error = typeof reply.error === "string" ? reply.error : "";
    if (error.includes("was not found") || error.includes("Could not load the Open CASCADE bridge")) {
      throw new ProtocolError(occtHint(error));
    }
    return reply;
  }

  /**
   * The plate's step's saved solid, for a whole tree to build from instead of replaying every step above it: only one in
   * the binary format, which is that step exactly. The engine refuses one that is not the step, and replays instead.
   */
  private seedOf(obj: PlateObject, tree: ModelTree): { node: NodeId; bytes: Uint8Array } | null {
    const node = obj.platedNode;
    if (!obj.brep || !isBrep(obj.brep) || node === null || node === 0 || !tree.nodes.has(node)) return null;
    return { node, bytes: obj.brep };
  }

  /** STEP bytes the bridge returns. A missing `bytesBase64` is a failed export. */
  private stepBytes(reply: Record<string, unknown>): Uint8Array | null {
    if (typeof reply.bytesBase64 !== "string" || reply.bytesBase64 === "") return null;
    const bytes = base64ToBytes(reply.bytesBase64);
    if (!bytes || bytes.byteLength === 0) return null;
    if (typeof reply.byteLength === "number" && reply.byteLength !== bytes.byteLength) return null;
    return bytes;
  }

  private async ensureTree(obj: PlateObject, depth = 0): Promise<ModelTree> {
    if (obj.tree && obj.treeStale) {
      const rebuilt = await this.rebuildStale(obj, depth);
      if (rebuilt) return rebuilt;
      // A history that will not build again falls back to what it did before a restart kept histories: the plate's
      // STEP or mesh, opened as a new root.
      obj.tree = null;
      obj.solid = null;
      obj.treeStale = false;
      if (obj.bytes.byteLength === 0 && !obj.brep) throw new ProtocolError("The modeler was restarted and this solid's history did not build again. It was never committed, so nothing is left to open.");
    }
    if (obj.tree) return obj.tree;
    const key = `mcp-${obj.id}`;
    const source = obj.brep ?? obj.bytes;
    const bytes = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer;
    const root = { kind: "step" as const, name: obj.brep ? stepFileName(obj.fileName) : obj.fileName, bytes };
    const reply = await this.treeCall(openRequest(key, root, CHORD));
    const error = typeof reply.error === "string" ? reply.error : "";
    if (error) throw new ProtocolError(plainModelError(error));
    obj.tree = newTree(key, root, obj.name, null);
    obj.solid = rememberSolid(reply);
    return obj.tree;
  }

  /**
   * A history the restarted modeler lost, built again at its current step: the tools its joins name first, then the
   * whole tree, with a budget for every step in it. Null when it does not build.
   */
  private async rebuildStale(obj: PlateObject, depth: number): Promise<ModelTree | null> {
    const tree = obj.tree;
    if (!tree || tree.root.kind === "piece" || depth > 8) return null;
    for (const node of tree.nodes.values()) {
      if (node.op?.kind !== "join") continue;
      const tool = this.byTreeKey(node.op.tool.key);
      if (tool && tool !== obj && tool.treeStale) {
        try {
          await this.ensureTree(tool, depth + 1);
        } catch {
          return null;
        }
      }
    }
    // --- A9. The same step count as an open: groups are one node but many kernel steps. ---
    const budget = Math.max(this.modelTimeoutMs(), modelSteps(tree) * 2000);
    let reply: Record<string, unknown>;
    try {
      reply = await this.treeCall(wholeTreeRequest(tree, tree.root, tree.current, obj.stepTolerance || CHORD, { seed: this.seedOf(obj, tree) }), "open", budget);
    } catch (err) {
      if (err instanceof ModelRunaway) return null;
      throw err;
    }
    if (typeof reply.error === "string" && reply.error) return null;
    obj.treeStale = false;
    const solid = rememberSolid(reply);
    if (solid) obj.solid = solid;
    return tree;
  }

  private async solidNew(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const typed = primitiveFrom(input);
    if ("reason" in typed) return { ok: false, reason: typed.reason };
    const kind = typed.primitive;
    const spec = rootSpec(typed);
    this.seq += 1;
    const id = `obj_${this.seq}`;
    const key = `mcp-${id}`;
    const reply = await this.treeCall(newSolidRequest(key, typed, CHORD));
    const error = typeof reply.error === "string" ? reply.error : "";
    if (error) return { ok: false, reason: plainModelError(error, "create") };
    const obj: PlateObject = {
      id,
      name: this.givenName(input.name) ?? kind,
      fileName: `${kind}.step`,
      bytes: new Uint8Array(),
      source: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      triangles: 1,
      orient: [...ID_MATRIX],
      scale: 1,
      centered: true,
      offset: { x: 0, y: 0, z: 0 },
      seatMm: 0,
      stepTolerance: STEP,
      modelPose: IDENTITY_POSE,
      workplane: GLOBAL_WORKPLANE,
      tree: newTree(key, { kind: "primitive", solid: spec }, kind, null),
      solid: rememberSolid(reply),
      probes: new Map(),
      supportEdits: [],
      supportPaint: [],
      seamPaint: [],
      reinforcement: [],
      objectSettings: {},
      platedNode: null,
    };
    this.objects.push(obj);
    this.selected = obj.id;
    return { ok: true, object: obj.id, fingerprint: obj.solid?.fingerprint ?? null, bounds: obj.solid?.bounds ?? null, frame: "part" };
  }

  /** A mesh has no solid to edit. A STEP file and a new solid do. */
  private meshBlock(obj: PlateObject): string | null {
    if (obj.tree || obj.brep) return null;
    const name = obj.fileName.toLowerCase();
    if (name.endsWith(".step") || name.endsWith(".stp")) return null;
    return MESH_EDIT;
  }

  private async opened(obj: PlateObject): Promise<ModelTree | { reason: string }> {
    const blocked = this.meshBlock(obj);
    if (blocked) return { reason: blocked };
    return this.ensureTree(obj);
  }

  private async describe(obj: PlateObject, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const tree = await this.opened(obj);
    if ("reason" in tree) return { ok: false, reason: tree.reason };
    const solid = obj.solid;
    if (!solid) return { ok: false, reason: "This solid could not be read." };
    const faces = page(solid.faces.map((face) => ({
      index: face.index,
      areaMm2: face.areaMm2,
      ...(face.normal ? { normal: face.normal } : {}),
      centre: face.centre,
      bbox: face.bbox,
      kind: face.kind,
      ...(face.radiusMm !== undefined ? { radiusMm: face.radiusMm, axis: face.axis } : {}),
    })), input.facesCursor ?? input.cursor, input.limit);
    const edges = page(solid.edges.map((edge) => ({
      index: edge.index,
      mid: edge.mid,
      start: edge.start,
      end: edge.end,
      lengthMm: edge.lengthMm,
      ...(edge.dir ? { dir: edge.dir } : {}),
    })), input.edgesCursor, input.limit);
    return {
      ok: true,
      volumeMm3: solid.volumeMm3,
      solid: solid.editable,
      fingerprint: solid.fingerprint,
      faces: faces.rows,
      edges: edges.rows,
      ...(faces.nextCursor ? { facesNextCursor: faces.nextCursor, nextCursor: faces.nextCursor } : {}),
      ...(edges.nextCursor ? { edgesNextCursor: edges.nextCursor } : {}),
    };
  }

  private async facesFind(obj: PlateObject, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const tree = await this.opened(obj);
    if ("reason" in tree) return { ok: false, reason: tree.reason };
    if (!obj.solid) return { ok: false, reason: "This solid could not be read." };
    const matched = facesMatching(obj.solid.faces, input, obj.solid);
    if ("reason" in matched) return { ok: false, reason: matched.reason };
    const listed = page(matched, input.cursor, input.limit);
    return { ok: true, total: matched.length, frame: "part", faces: listed.rows, ...(listed.nextCursor ? { nextCursor: listed.nextCursor } : {}) };
  }

  private async edgesFind(obj: PlateObject, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const tree = await this.opened(obj);
    if ("reason" in tree) return { ok: false, reason: tree.reason };
    if (!obj.solid) return { ok: false, reason: "This solid could not be read." };
    const filter = this.onFaceIndex(obj, input);
    if (typeof filter === "string") return { ok: false, reason: filter };
    const matched = edgesMatching(obj.solid.edges, obj.solid.faces, filter, obj.solid);
    if ("reason" in matched) return { ok: false, reason: matched.reason };
    const listed = page(matched, input.cursor, input.limit);
    return { ok: true, total: matched.length, frame: "part", edges: listed.rows, ...(listed.nextCursor ? { nextCursor: listed.nextCursor } : {}) };
  }

  /** An edge filter whose onFace is a face selector {normal, withinDeg, nearPoint}, with that face's index in its place. */
  private onFaceIndex(obj: PlateObject, filter: Record<string, unknown>): Record<string, unknown> | string {
    const on = filter.onFace;
    if (!on || typeof on !== "object" || Array.isArray(on)) return filter;
    const index = this.expandContext(obj).faceBy(on as Record<string, unknown>);
    if (typeof index !== "number") return `onFace: ${index.reason}`;
    return { ...filter, onFace: index };
  }

  /** Indexes from a list, or from the same filter `edges_find` uses. */
  private resolveEdges(obj: PlateObject, spec: Record<string, unknown>): EdgePick[] | { reason: string } {
    const raw = spec.edges;
    const empty = spec.kind === "chamfer" ? "Pick an edge to chamfer." : "Pick an edge to fillet.";
    if (raw && typeof raw === "object" && "fromNode" in raw) {
      const { fromNode, filter } = raw as { fromNode?: unknown; filter?: unknown };
      const node = this.nodeOf(obj, fromNode);
      if (node === null || !obj.tree?.nodes.has(node)) return { reason: "That step is not in the history." };
      if (node === 0) return { reason: "Pick a step after the first solid. Its edges are not a step's own." };
      return [stepEdges(node, filter === "convex" || filter === "concave" ? filter : "all")];
    }
    if (Array.isArray(raw)) {
      if (raw.length === 0) return { reason: empty };
      if (!raw.every((edge) => Number.isInteger(edge))) return { reason: EDGES_SHAPE };
      return raw as number[];
    }
    if (raw && typeof raw === "object" && "select" in raw) {
      const select = (raw as { select?: unknown }).select;
      if (!select || typeof select !== "object" || Array.isArray(select)) return { reason: "edges.select is a filter." };
      if (!obj.solid) return { reason: "Describe the solid before picking edges." };
      const filter = this.onFaceIndex(obj, select as Record<string, unknown>);
      if (typeof filter === "string") return { reason: filter };
      const matched = edgesMatching(obj.solid.edges, obj.solid.faces, filter, obj.solid);
      if ("reason" in matched) return matched;
      if (matched.length === 0) return { reason: "No edge matches that filter." };
      return matched.map((edge) => edge.index);
    }
    return { reason: empty };
  }

  /**
   * --- D24. A frame is typed and answered in model space, and kept in the part's own frame, as the app and the file keep
   * it, so it moves with the part when model_place moves the part.
   */
  private async workplaneSet(obj: PlateObject, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const source = input.source === "global" || input.source === "bed" || input.source === "face" ? input.source : "face";
    const origin = Array.isArray(input.origin) && input.origin.length >= 3 ? input.origin.slice(0, 3) as [number, number, number] : null;
    const turn = Array.isArray(input.turn) && input.turn.length >= 3 ? input.turn.slice(0, 3) as [number, number, number] : null;
    const answer = () => {
      const plane = this.typedPlane(obj);
      return { ok: true, source: plane.source, origin: plane.origin, turn: plane.turn };
    };
    if (origin && turn && origin.every((value) => typeof value === "number") && turn.every((value) => typeof value === "number")) {
      obj.workplane = workplaneOwn({ source, origin, turn }, obj.modelPose);
      return answer();
    }
    if (source === "global") {
      obj.workplane = { ...GLOBAL_WORKPLANE };
      return answer();
    }
    const tree = await this.opened(obj);
    if ("reason" in tree) return { ok: false, reason: tree.reason };
    if (source === "bed") {
      // Under the middle of the part as it stands, W up in model space.
      const box = obj.solid ? (isIdentity(obj.modelPose) ? obj.solid.bounds : boundsOf(featureSolidInModel(obj.solid, obj.modelPose).positions)) : { min: [0, 0, 0], max: [0, 0, 0] };
      obj.workplane = workplaneOwn(workplaneOnBed(box), obj.modelPose);
      return answer();
    }
    const faceIndex = Number(input.faceIndex);
    const face = obj.solid?.faces[faceIndex];
    if (!face) return { ok: false, reason: "That face is not on this solid." };
    if (!face.normal || !obj.solid) return { ok: false, reason: CURVED_FACE };
    const plane = facePlane(obj.solid.positions, obj.solid.triangles, faceIndex, face.normal);
    if (!plane) return { ok: false, reason: CURVED_FACE };
    obj.workplane = workplaneOnFace(plane);
    return answer();
  }

  private printUp(obj: PlateObject): Record<string, unknown> {
    if (isGlobalFrame(obj.workplane)) return { ok: false, reason: "Pick a face before pointing it up." };
    this.remember("Point up");
    const frame = eulerOrient(obj.workplane.turn[0], obj.workplane.turn[1], obj.workplane.turn[2]);
    obj.orient = [frame[0], frame[3], frame[6], frame[1], frame[4], frame[7], frame[2], frame[5], frame[8]];
    return { ok: true, reslice: true, label: "Point up" };
  }

  private modelPlace(obj: PlateObject, input: Record<string, unknown>): Record<string, unknown> {
    const x = typeof input.x === "number" ? input.x : obj.modelPose.t[0];
    const y = typeof input.y === "number" ? input.y : obj.modelPose.t[1];
    const z = typeof input.z === "number" ? input.z : obj.modelPose.t[2];
    const current = orientEuler(obj.modelPose.m);
    const turnX = typeof input.turnX === "number" ? input.turnX : current.rx;
    const turnY = typeof input.turnY === "number" ? input.turnY : current.ry;
    const turnZ = typeof input.turnZ === "number" ? input.turnZ : current.rz;
    obj.modelPose = { m: eulerOrient(turnX, turnY, turnZ), t: [x, y, z] };
    const turn = orientEuler(obj.modelPose.m);
    return { ok: true, x, y, z, turnX: turn.rx, turnY: turn.ry, turnZ: turn.rz };
  }

  private bake(obj: PlateObject, raw: unknown): { op: ModelOp; typed: Record<string, unknown>; notes?: string[] } | { reason: string } {
    if (!raw || typeof raw !== "object") return { reason: "The edit needs an op." };
    const spec = raw as Record<string, unknown>;
    const kind = spec.kind;
    if (isComposite(kind)) return { reason: `A ${kind} is several steps. Apply it with model_apply or model_apply_batch.` };
    if (kind === "scale") {
      const factor = spec.factor;
      if (typeof factor !== "number" || !Number.isFinite(factor) || factor < 0.1 || factor > 20) return { reason: "Scale is a factor from 0.1 to 20." };
      return { op: toSolidOp({ kind: "scale", factor }, obj.modelPose), typed: { kind: "scale", factor } };
    }
    // --- Split to print. Defaults are filled from the plate's printer and settings now, as at Apply (D11).
    if (kind === "partition") {
      const typed = readPartition(spec, (id) => this.partitionTarget(id));
      if ("reason" in typed) return typed;
      const stored = storedPartition(typed, this.partitionContext(obj), obj.modelPose, obj.solid ? { positions: obj.solid.positions, up: plateUp(obj.orient) } : undefined);
      if ("reason" in stored) return stored;
      return { op: stored.op, typed: cleanOp(spec), notes: stored.notes };
    }
    if (kind === "split") {
      const origin = (Array.isArray(spec.origin) ? spec.origin : [0, 0, 0]) as [number, number, number];
      const normal = (Array.isArray(spec.normal) ? spec.normal : [0, 0, 1]) as [number, number, number];
      const op: ModelOp = { kind: "split", origin, normal };
      return { op: toSolidOp(op, obj.modelPose), typed: { kind: "split", origin, normal } };
    }
    if (kind === "fillet" || kind === "chamfer") {
      const picked = this.resolveEdges(obj, spec);
      if ("reason" in picked) return picked;
      const size = spec.size;
      if (typeof size !== "number") return { reason: "This edit needs a size in millimetres." };
      const op: ModelOp = { kind, edges: picked, size };
      return { op: toSolidOp(op, obj.modelPose), typed: { kind, edges: picked, size } };
    }
    if (kind === "hole") {
      if (typeof spec.screw === "string") {
        const screw = SCREWS.find((entry) => entry.name === spec.screw);
        if (!screw) return { reason: "That screw size is not one this slicer cuts." };
        spec.diameterMm = screw.hole;
        spec.through = true;
        spec.counterboreDiameterMm = screw.bore;
        spec.counterboreDepth = screw.boreDepth;
      }
      const radius = typeof spec.diameterMm === "number" ? spec.diameterMm / 2 : spec.radius;
      if (typeof radius !== "number" || !(radius > 0)) return { reason: "The hole needs a diameter." };
      const at = spec.at as { u?: number; v?: number } | undefined;
      let origin: [number, number, number];
      let axis: [number, number, number];
      const typedIn = this.typedPlane(obj);
      if (at && typeof at.u === "number" && typeof at.v === "number" && !isGlobalFrame(typedIn)) {
        origin = planePoint(typedIn, [at.u, at.v, 0]);
        axis = drillDown(typedIn);
      } else if (at && typeof at.u === "number" && typeof at.v === "number") {
        origin = [at.u, at.v, obj.solid?.bounds.max[2] ?? 0];
        axis = [0, 0, -1];
      } else {
        origin = (Array.isArray(spec.origin) ? spec.origin : [0, 0, 0]) as [number, number, number];
        axis = (Array.isArray(spec.axis) ? spec.axis : [0, 0, -1]) as [number, number, number];
      }
      const through = spec.through === true;
      const box = obj.solid?.bounds ?? { min: [0, 0, 0] as [number, number, number], max: [0, 0, 0] as [number, number, number] };
      const depth = through ? throughLength(box, origin, axis) : (typeof spec.depth === "number" ? spec.depth : 0);
      if (!through && !(depth > 0)) return { reason: "The hole needs a depth, or through." };
      const counterbore = typeof spec.counterboreDiameterMm === "number" && typeof spec.counterboreDepth === "number"
        ? { counterboreRadius: spec.counterboreDiameterMm / 2, counterboreDepth: spec.counterboreDepth }
        : {};
      const typedBore = typeof spec.counterboreDiameterMm === "number" && typeof spec.counterboreDepth === "number"
        ? { counterboreDiameterMm: spec.counterboreDiameterMm, counterboreDepth: spec.counterboreDepth }
        : {};
      const op: ModelOp = { kind: "hole", origin, axis, radius, depth, ...(through ? { through: true as const } : {}), ...counterbore };
      return { op: toSolidOp(op, obj.modelPose), typed: { kind: "hole", diameterMm: radius * 2, ...(through ? { through: true } : { depth }), ...typedBore } };
    }
    if (kind === "join") {
      const tool = this.find(String(spec.toolObject ?? ""));
      if (!tool) return { reason: UNKNOWN_OBJECT };
      if (!tool.tree) return { reason: "The tool object has no solid yet." };
      const op = joinOp((spec.op === "fuse" || spec.op === "common" ? spec.op : "cut"), { object: tool.id, key: tool.tree.key, node: tool.tree.current, name: tool.name }, obj.modelPose, tool.modelPose, spec.keepTool === true);
      return { op, typed: { kind: "join", toolObject: tool.id, keepTool: spec.keepTool === true } };
    }
    if (kind === "extrude" || kind === "revolve") {
      const plane = this.profilePlane(obj, spec);
      if ("reason" in plane) return plane;
      const loops = readLoopsField(spec.loops);
      if ("reason" in loops) return loops;
      if (loops.loops && spec.profile !== undefined) return { reason: "Give a profile or loops, not both." };
      if (loops.loops && (spec.smooth !== undefined || spec.corners !== undefined)) return { reason: LOOP_SHAPE };
      const booleanOp = spec.op === "cut" || spec.op === "common" ? spec.op : "fuse";
      // K3. Each field is sent only when set. A plain extrude is the same call as before. Loops take them too.
      const readExtent = (depth: number): { depth2?: number; draftDeg?: number; upTo?: number } | { reason: string } => {
        const extent: { depth2?: number; draftDeg?: number; upTo?: number } = {};
        if (spec.depth2 !== undefined) {
          if (typeof spec.depth2 !== "number" || !(spec.depth2 > 0)) return { reason: "The second depth is a distance on the other side of the plane, above 0." };
          extent.depth2 = spec.depth2;
        }
        if (spec.draftDeg !== undefined && spec.draftDeg !== 0) {
          if (typeof spec.draftDeg !== "number" || !Number.isFinite(spec.draftDeg) || Math.abs(spec.draftDeg) >= 89) return { reason: "A draft angle must be between -89 and 89 degrees." };
          extent.draftDeg = spec.draftDeg;
        }
        if (spec.upTo !== undefined) {
          if (typeof spec.upTo === "number" && Number.isInteger(spec.upTo)) {
            if (!obj.solid?.faces[spec.upTo]) return { reason: "That face is not on this solid." };
            extent.upTo = spec.upTo;
          } else if (spec.upTo && typeof spec.upTo === "object") {
            const found = this.expandContext(obj).faceBy(spec.upTo as Record<string, unknown>);
            if (typeof found !== "number") return found;
            extent.upTo = found;
          } else return { reason: "That face is not on this solid." };
        }
        if (extent.upTo !== undefined && extent.depth2 !== undefined) return { reason: "An extrude up to a face starts at the profile. Drop the second depth." };
        if (extent.upTo !== undefined && spec.symmetric === true) return { reason: "An extrude up to a face starts at the profile. Leave centred off." };
        if (extent.upTo !== undefined && extent.draftDeg !== undefined) return { reason: "A draft up to a face is not available yet. Drop the draft, or drop the face and set a depth." };
        if (extent.depth2 !== undefined && spec.symmetric === true) return { reason: "An extrude is centred, or it has a second depth, not both." };
        if (depth === 0 && extent.upTo === undefined && extent.depth2 === undefined) return { reason: "An extrude needs a depth in millimetres." };
        return extent;
      };
      if (loops.loops) {
        if (kind === "extrude") {
          const depth = spec.depth;
          if (typeof depth !== "number" || !Number.isFinite(depth)) return { reason: "An extrude needs a depth in millimetres." };
          const extent = readExtent(depth);
          if ("reason" in extent) return extent;
          const plain = extrudeOp(booleanOp, plane, [], depth, spec.symmetric === true, {}, loops.loops);
          const fields = extrudeOp(booleanOp, plane, [], depth, spec.symmetric === true, {}, extent);
          const made = {
            ...plain,
            ...(fields.depth2 !== undefined ? { depth2: fields.depth2 } : {}),
            ...(fields.draftDeg !== undefined ? { draftDeg: fields.draftDeg } : {}),
            ...(fields.upTo !== undefined ? { upTo: fields.upTo } : {}),
          };
          return { op: toSolidOp(made, obj.modelPose), typed: { ...made } };
        }
        const axisOrigin = readProfile([spec.axisOrigin, [0, 0], [0, 0]])?.[0];
        const axisDir = readProfile([spec.axisDir, [0, 0], [0, 0]])?.[0];
        const made = revolveOp(booleanOp, plane, [], {
          ...(spec.axisOrigin !== undefined && axisOrigin ? { origin: axisOrigin } : {}),
          ...(spec.axisDir !== undefined && axisDir ? { dir: axisDir } : {}),
          ...(typeof spec.angleDeg === "number" ? { angleDeg: spec.angleDeg } : {}),
        }, {}, loops.loops);
        return { op: toSolidOp(made, obj.modelPose), typed: { ...made } };
      }
      const profile = readProfile(spec.profile);
      if (!profile) return { reason: "A profile needs at least three [u, v] points." };
      const shape = readShape(spec, profile.length);
      if ("reason" in shape) return shape;
      if (kind === "extrude") {
        const depth = spec.depth;
        if (typeof depth !== "number" || !Number.isFinite(depth)) return { reason: "An extrude needs a depth in millimetres." };
        const extent = readExtent(depth);
        if ("reason" in extent) return extent;
        const made = extrudeOp(booleanOp, plane, profile, depth, spec.symmetric === true, shape, extent);
        return { op: toSolidOp(made, obj.modelPose), typed: { ...made } };
      }
      const axisOrigin = readProfile([spec.axisOrigin, [0, 0], [0, 0]])?.[0];
      const axisDir = readProfile([spec.axisDir, [0, 0], [0, 0]])?.[0];
      const made = revolveOp(booleanOp, plane, profile, {
        ...(spec.axisOrigin !== undefined && axisOrigin ? { origin: axisOrigin } : {}),
        ...(spec.axisDir !== undefined && axisDir ? { dir: axisDir } : {}),
        ...(typeof spec.angleDeg === "number" ? { angleDeg: spec.angleDeg } : {}),
      }, shape);
      return { op: toSolidOp(made, obj.modelPose), typed: { ...made } };
    }
    if (kind === "loft" || kind === "sweep") {
      const booleanOp = spec.op === "cut" || spec.op === "common" ? spec.op : "fuse";
      let sections: LoftSection[];
      if (kind === "sweep") {
        const made = sweepSections(spec as unknown as SweepSpec);
        if ("reason" in made) return made;
        sections = made;
      } else {
        if (!Array.isArray(spec.sections) || spec.sections.length < 2) return { reason: "A loft needs at least 2 sections." };
        if (spec.sections.length > 200) return { reason: "A loft takes at most 200 sections." };
        sections = [];
        for (const [index, value] of (spec.sections as unknown[]).entries()) {
          const section = readSection(value);
          if ("reason" in section) return { reason: `sections[${index}]: ${section.reason}` };
          sections.push(section);
        }
      }
      const made = loftOp(booleanOp, sections, spec.ruled === true);
      const typed = kind === "sweep" ? { ...cleanOp(spec), op: booleanOp, sections: sections.length } : { ...made };
      return { op: toSolidOp(made, obj.modelPose), typed };
    }
    if (kind === "shell") {
      const thickness = spec.thickness;
      if (typeof thickness !== "number" || !(thickness > 0)) return { reason: "A shell needs a wall thickness in millimetres." };
      const faces: number[] = [];
      const ctx = this.expandContext(obj);
      for (const pick of Array.isArray(spec.openFaces) ? spec.openFaces : []) {
        if (Number.isInteger(pick)) {
          if (!obj.solid?.faces[pick as number]) return { reason: "That face is not on this solid." };
          faces.push(pick as number);
          continue;
        }
        const found = ctx.faceBy((pick ?? {}) as Record<string, unknown>);
        if (typeof found !== "number") return found;
        faces.push(found);
      }
      const made = shellOp(thickness, [...new Set(faces)]);
      return { op: toSolidOp(made, obj.modelPose), typed: { ...made } };
    }
    // --- K4: faceExtrude and moveFaces. A face is an index, a stored {index}, or a {normal, nearPoint} selector. ---
    if (kind === "faceExtrude") {
      const distance = spec.distance;
      if (typeof distance !== "number" || !Number.isFinite(distance) || distance === 0) return { reason: "A face extrude needs a distance other than 0." };
      if (spec.draftDeg !== undefined && (typeof spec.draftDeg !== "number" || !Number.isFinite(spec.draftDeg) || spec.draftDeg < -89 || spec.draftDeg > 89)) {
        return { reason: "The draft angle must be between -89 and 89 degrees." };
      }
      const face = this.bakedFace(obj, spec.face);
      if (typeof face !== "number") return face;
      let upTo: number | undefined;
      if (spec.upTo !== undefined && spec.upTo !== null) {
        const until = this.bakedFace(obj, spec.upTo);
        if (typeof until !== "number") return until;
        if (until === face) return { reason: "A face cannot stop at itself." };
        upTo = until;
      }
      const made = faceExtrudeOp(face, distance, {
        ...(typeof spec.draftDeg === "number" && spec.draftDeg !== 0 ? { draftDeg: spec.draftDeg } : {}),
        ...(upTo !== undefined ? { upTo } : {}),
      });
      return { op: toSolidOp(made, obj.modelPose), typed: { ...made } };
    }
    if (kind === "moveFaces") {
      if (!Array.isArray(spec.faces) || spec.faces.length === 0) return { reason: "Pick a face to move." };
      const rows: { face: number; distance: number }[] = [];
      for (const raw of spec.faces) {
        if (!raw || typeof raw !== "object") return { reason: "Pick a face to move." };
        const row = raw as { face?: unknown; distance?: unknown };
        if (typeof row.distance !== "number" || !Number.isFinite(row.distance) || row.distance === 0) return { reason: "A face move needs a distance other than 0." };
        const face = this.bakedFace(obj, row.face);
        if (typeof face !== "number") return face;
        rows.push({ face, distance: row.distance });
      }
      const made = moveFacesOp(rows);
      return { op: toSolidOp(made, obj.modelPose), typed: { ...made } };
    }
    if (kind === "boolean") {
      const booleanOp = spec.op === "fuse" || spec.op === "common" ? spec.op : "cut";
      const local = primitiveFrom(spec, "box");
      if ("reason" in local) return local;
      const solid = planePrimitive(local, this.typedPlane(obj));
      const op = toSolidOp({ kind: "boolean", op: booleanOp, ...solid }, obj.modelPose);
      // A tool placed by centre already says where its middle goes: turnEcho has no note for it. cleanOp drops the mark.
      return { op, typed: { kind: "boolean", op: booleanOp, ...solid, ...(spec.centre !== undefined ? { centre: spec.centre } : {}) } };
    }
    if (kind === "root") {
      const local = primitiveFrom(spec, "box");
      if ("reason" in local) return local;
      const solid = rootSpec(local);
      const op: ModelOp = { kind: "root", ...solid };
      return { op, typed: { kind: "root", ...solid } };
    }
    return { reason: "That edit is not one of hole, fillet, chamfer, split, partition, scale, boolean, extrude, revolve, loft, sweep, shell, faceExtrude, moveFaces, join, or root." };
  }

  /** K4. A face as a shell's open face: an index, a stored `{index}`, or a `{normal, nearPoint}` selector. */
  private bakedFace(obj: PlateObject, pick: unknown): number | { reason: string } {
    if (Number.isInteger(pick)) {
      if (!obj.solid?.faces[pick as number]) return { reason: "That face is not on this solid." };
      return pick as number;
    }
    if (pick && typeof pick === "object" && Number.isInteger((pick as { index?: unknown }).index)) {
      const index = (pick as { index: number }).index;
      if (!obj.solid?.faces[index]) return { reason: "That face is not on this solid." };
      return index;
    }
    const found = this.expandContext(obj).faceBy((pick ?? {}) as Record<string, unknown>);
    if (typeof found !== "number") return found;
    return found;
  }

  private splitCheck(obj: PlateObject, op: Extract<ModelOp, { kind: "split" }>): { text: string; bad: boolean } {
    const positions = obj.solid?.positions;
    const box = obj.solid?.bounds;
    if (!positions || !box) return splitNote({ why: "This solid is too thin to split.", wait: false });
    const length = Math.hypot(op.normal[0], op.normal[1], op.normal[2]) || 1;
    const normal: PlaneVec = [op.normal[0] / length, op.normal[1] / length, op.normal[2] / length];
    const extent = extentAlong(positions, normal);
    if (!extent || !(extent.max > extent.min)) return splitNote({ why: "This solid is too thin to split.", wait: false });
    const center: PlaneVec = [
      (box.min[0] + box.max[0]) / 2,
      (box.min[1] + box.max[1]) / 2,
      (box.min[2] + box.max[2]) / 2,
    ];
    const axis = Math.abs(normal[0]) >= Math.abs(normal[1]) && Math.abs(normal[0]) >= Math.abs(normal[2]) ? 0 : Math.abs(normal[1]) >= Math.abs(normal[2]) ? 1 : 2;
    const mode = axis === 0 ? "x" : axis === 1 ? "y" : "z";
    const base = splitBase(mode, center, null);
    if (!base) return splitNote({ why: "This solid is too thin to split.", wait: false });
    const depth = op.origin[0] * normal[0] + op.origin[1] * normal[1] + op.origin[2] * normal[2];
    const margin = 1e-4;
    const range = { min: extent.min, max: extent.max, mid: (extent.min + extent.max) / 2 };
    const inside = extent.min + margin < depth && depth < extent.max - margin;
    const plan: SplitPlan = {
      base,
      value: depth,
      origin: [...op.origin] as PlaneVec,
      normal,
      range,
      inside,
      rings: tiltRings(base.normal, 0),
    };
    return splitNote({ plan });
  }

  private async openJoinTool(raw: unknown): Promise<string | null> {
    if (!raw || typeof raw !== "object") return null;
    const spec = raw as { kind?: unknown; toolObject?: unknown };
    if (spec.kind !== "join") return null;
    const tool = this.find(typeof spec.toolObject === "string" ? spec.toolObject : "");
    if (!tool) return UNKNOWN_OBJECT;
    if (tool.tree && !tool.treeStale) return null;
    const opened = await this.opened(tool);
    return "reason" in opened ? opened.reason : null;
  }

  private async probe(obj: PlateObject, raw: unknown, nodeHandleValue?: unknown, measure = false): Promise<Record<string, unknown>> {
    if (raw && typeof raw === "object" && isComposite((raw as { kind?: unknown }).kind)) {
      return { ok: false, reason: "model_probe checks one step. Apply a pattern, mirror, pocket, boss, or texture with model_apply; it checks each step as it goes." };
    }
    const toolReason = await this.openJoinTool(raw);
    if (toolReason) return { ok: false, reason: toolReason };
    const tree = await this.opened(obj);
    if ("reason" in tree) return { ok: false, reason: tree.reason };
    const asked = this.nodeOf(obj, nodeHandleValue);
    const at = asked ?? tree.current;
    if (asked !== null && !tree.nodes.has(asked)) return { ok: false, reason: "That step is not in the history." };
    if (at !== tree.current) return this.atStep(obj, tree, at, () => this.bakeAndProbe(obj, tree, at, raw, measure));
    return this.bakeAndProbe(obj, tree, at, raw, measure);
  }

  private async bakeAndProbe(obj: PlateObject, tree: ModelTree, at: number, raw: unknown, measure: boolean): Promise<Record<string, unknown>> {
    const baked = this.bake(obj, raw);
    if ("reason" in baked) return { ok: false, reason: baked.reason };
    return this.probeBaked(obj, tree, at, baked, measure);
  }

  /**
   * --- 3.1 F14. Work on step `at`'s solid: face and edge selectors, a hole's depth through the part, and the checks
   * read `obj.solid`, which is the current step's. The engine shows `at` for the work and the current step again after,
   * and the history does not move.
   */
  private async atStep(obj: PlateObject, tree: ModelTree, at: number, work: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
    const current = tree.current;
    const prior = obj.solid;
    let reply: Record<string, unknown>;
    try {
      reply = await this.treeCall(gotoRequest(tree.key, at, CHORD), "edit", this.replayBudgetMs(this.stepsTo(tree, at)));
    } catch (err) {
      const lost = this.lostReply(err);
      if (lost) return lost;
      throw err;
    }
    if (typeof reply.error === "string" && reply.error) return { ok: false, reason: plainModelError(reply.error) };
    const solid = rememberSolid(reply);
    if (!solid) return { ok: false, reason: "That step's solid could not be read." };
    obj.solid = solid;
    try {
      return await work();
    } finally {
      obj.solid = prior;
      if (!obj.treeStale) {
        try {
          await this.treeCall(gotoRequest(tree.key, current, CHORD), "edit", this.replayBudgetMs(this.stepsTo(tree, current)));
        } catch {
          // A modeler restarted under the work rebuilds the history at its current step on next use.
        }
      }
    }
  }

  /**
   * The check before an apply, for an op already in the solid's frame. A probe that passes is remembered for `at`.
   * `measure` asks the modeler for the built shape too, for model_probe's metrics; a batch step does not need it.
   */
  private async probeBaked(obj: PlateObject, tree: ModelTree, at: number, baked: { op: ModelOp; typed: Record<string, unknown>; notes?: string[] }, measure = false, composite = false, budgetMs?: number): Promise<Record<string, unknown>> {
    const picked = baked.op.kind === "fillet" || baked.op.kind === "chamfer" ? { edges: baked.typed.edges } : {};
    const answer = (body: Record<string, unknown>) => ({ ...body, ...picked, stored: cleanOp(baked.op as unknown as Record<string, unknown>), typed: cleanOp(baked.typed), ...turnEcho(baked.typed) });
    if (baked.op.kind === "scale") {
      obj.probes.set(probeKey(String(at), baked.op), true);
      return answer({ ok: true, reason: "This scale fits." });
    }
    if (baked.op.kind === "root") {
      obj.probes.set(probeKey(String(at), baked.op), true);
      return answer({ ok: true, reason: "This solid can be rebuilt from these sizes." });
    }
    if (baked.op.kind === "split") {
      const note = this.splitCheck(obj, baked.op);
      if (note.bad) return answer({ ok: false, reason: note.text });
      obj.probes.set(probeKey(String(at), baked.op), true);
      return answer({ ok: true, reason: note.text });
    }
    if (baked.op.kind === "partition") return answer(await this.probePartition(obj, tree, at, baked.op, budgetMs, baked.notes ?? []));
    if (baked.op.kind === "boolean" && obj.solid) {
      const missed = disjointBoolean(obj.solid.bounds, baked.op, baked.op.op);
      if (missed) {
        // In the solid's frame both boxes; the gap is a lower bound on how far the tool must move.
        const gap = Math.round(boxGap(obj.solid.bounds, primitiveBox(baked.op)) * 100) / 100;
        const far = baked.op.op === "fuse" && gap > 0 ? `${missed} It is at least ${gap} mm clear of the part's bounding box.` : missed;
        return answer({ ok: false, reason: far, missed: true, ...(gap > 0 ? { gapMm: gap } : {}) });
      }
    }
    const tool = (baked.op.kind === "join" ? "boolean" : baked.op.kind) as ProbedTool;
    const blend = (baked.op.kind === "fillet" || baked.op.kind === "chamfer") && baked.op.edges.length > 1;
    const preview = measure || blend ? (obj.stepTolerance || CHORD) : undefined;
    let reply: Record<string, unknown>;
    try {
      reply = await this.treeCall(probeRequest(tree.key, at, baked.op, preview), baked.op.kind, budgetMs);
    } catch (err) {
      const lost = this.lostReply(err);
      if (lost) return lost;
      throw err;
    }
    const view = probeFromBody(reply, baked.op.kind === "group" ? baked.op.steps.length : undefined);
    this.lastPreview = reply.preview && typeof reply.preview === "object" ? rememberSolid(reply.preview as Record<string, unknown>) : null;
    const note = probeNote(tool, view);
    // --- A9. A group probe names the step that failed, counting from 1. ---
    const failedStep = view?.phase === "done" && view.ok === false && view.failedStep != null ? { failedStep: view.failedStep } : {};
    if (baked.op.kind === "shell" && note?.bad && /too thick/.test(note.text)) {
      const advice = await this.shellAdvice(obj, tree, at, baked.op, budgetMs);
      if (advice.lost) return answer(advice.lost);
      return answer({ ok: false, reason: `${note.text} ${advice.text}`, ...(advice.maxMm !== undefined ? { maxMm: advice.maxMm } : {}), ...(advice.where ? { where: advice.where } : {}) });
    }
    if (!note || note.bad) return answer({ ok: false, reason: note?.text ?? "This does not fit.", ...(typeof reply.maxMm === "number" ? { maxMm: reply.maxMm } : {}), ...failedStep });
    if (view?.phase === "done" && addsPiece(baked.op as { kind: string; op?: string }, view.measure)) {
      const where = pieceReport(reply, (p) => applyPose(obj.modelPose, p));
      return answer({ ok: false, reason: separateReason(where), ...(where ? { where } : {}) });
    }
    if (composite && view?.phase === "done" && cutsOffPiece(baked.op as { kind: string; op?: string }, view.measure)) {
      const where = pieceReport(reply, (p) => applyPose(obj.modelPose, p));
      return answer({ ok: false, reason: splitReason(where), ...(where ? { where } : {}) });
    }
    obj.probes.set(probeKey(String(at), baked.op), true);
    return answer({ ok: true, reason: note.text });
  }

  /**
   * --- 3.1 F10. Where a shell that is too thick runs out of room, and the thickest wall that fits. Inward offsets of t
   * from two sides meet where the part is thinner than 2t, so the thinnest places are measured from the solid's mesh;
   * a curved face of smaller radius than the wall cannot be offset either. The largest wall that fits is found by
   * halving, a probe each, within about 20 s; the solid does not change.
   */
  private async shellAdvice(obj: PlateObject, tree: ModelTree, at: number, op: Extract<ModelOp, { kind: "shell" }>, budgetMs?: number): Promise<{ text: string; maxMm?: number; where?: Record<string, unknown>; lost?: Record<string, unknown> }> {
    const t = op.thickness;
    const parts: string[] = [];
    let where: Record<string, unknown> | undefined;
    const solid = obj.solid;
    const pose = (p: readonly number[]) => applyPose(obj.modelPose, p as [number, number, number]).map((v) => Math.round(v * 100) / 100);
    if (solid && solid.positions.length >= 9) {
      const thin = thinWalls(solid.positions, 2 * t);
      const worst = [...thin.regions].sort((a, b) => a.thinnestMm - b.thinnestMm)[0];
      if (worst) {
        where = { thinnestMm: Math.round(worst.thinnestMm * 100) / 100, at: pose(worst.centre), min: pose(worst.min), max: pose(worst.max) };
        parts.push(`The part is ${where.thinnestMm} mm thick at (${(where.at as number[]).join(", ")}), and a ${t} mm wall needs ${2 * t} mm there.`);
      }
      const tight = solid.faces.filter((face) => (face.kind === "cylinder" || face.kind === "sphere" || face.kind === "cone") && typeof face.radiusMm === "number" && face.radiusMm < t).sort((a, b) => a.radiusMm! - b.radiusMm!)[0];
      if (tight) {
        where = { ...(where ?? {}), radiusMm: Math.round(tight.radiusMm! * 100) / 100, radiusAt: pose(tight.centre), face: tight.index };
        parts.push(`Face ${tight.index}, a ${tight.kind} of radius ${where.radiusMm} mm at (${(where.radiusAt as number[]).join(", ")}), is rounder than the wall is thick.`);
      }
    }
    let fits = 0;
    let fails = t;
    const until = Date.now() + 20_000;
    for (let round = 0; round < 6 && Date.now() < until; round += 1) {
      const trial = Math.round(((fits + fails) / 2) * 100) / 100;
      if (!(trial > fits) || !(trial < fails)) break;
      let reply: Record<string, unknown>;
      try {
        reply = await this.treeCall(probeRequest(tree.key, at, { ...op, thickness: trial }), "shell", budgetMs);
      } catch (err) {
        const lost = this.lostReply(err);
        if (lost) return { text: parts.join(" "), lost };
        break;
      }
      const view = probeFromBody(reply);
      if (view?.phase === "done" && view.ok) fits = trial;
      else fails = trial;
    }
    if (fits > 0) parts.push(`A ${fits} mm wall fits.`);
    else parts.push(`Nothing from ${Math.round((fails) * 100) / 100} mm up fits; try a much thinner wall, or open a face near there.`);
    return { text: parts.join(" "), ...(fits > 0 ? { maxMm: fits } : {}), ...(where ? { where } : {}) };
  }

  /**
   * model_apply. A plain op needs a passed probe, or `probe: true` to check it here first. A composite op (pattern,
   * mirror, pocket, boss, texture) always checks each step as it goes and is one undo step.
   */
  private async applyTool(obj: PlateObject, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const anchored = this.anchored(obj, input.op as Record<string, unknown>);
    if ("reason" in anchored) return { ok: false, reason: anchored.reason };
    const raw = anchored.op;
    const exprs = this.pendingExprs;
    this.pendingExprs = [];
    if (isComposite(raw?.kind)) {
      const { checkpoints, ...ran } = await this.applyMany(obj, [raw], { label: typeof raw.label === "string" ? raw.label : undefined });
      this.keepExprs(obj, checkpoints as (number | null)[], exprs);
      return ran;
    }
    if (input.probe === true) {
      const probed = await this.probe(obj, raw);
      if (probed.ok !== true) return { ...probed, applied: false };
    }
    const done = await this.apply(obj, raw);
    if (done.ok === true) this.keepExprs(obj, [parseNode(done.node)], exprs);
    return done;
  }

  /** --- D25. Each applied op's node keeps the expressions it was typed with. A node an op did not make is left. */
  private keepExprs(obj: PlateObject, nodes: readonly (number | null)[], exprs: readonly (Record<string, string> | undefined)[]): void {
    nodes.forEach((id, index) => {
      const texts = exprs[index];
      const node = id === null ? undefined : obj.tree?.nodes.get(id);
      if (!texts || !node?.op || !obj.tree || id === null) return;
      obj.tree = withNode(obj.tree, id, { op: withExprs(node.op, texts) });
    });
  }

  private async apply(obj: PlateObject, raw: unknown): Promise<Record<string, unknown>> {
    const toolReason = await this.openJoinTool(raw);
    if (toolReason) return { ok: false, reason: toolReason };
    const tree = await this.opened(obj);
    if ("reason" in tree) return { ok: false, reason: tree.reason };
    const baked = this.bake(obj, raw);
    if ("reason" in baked) return { ok: false, reason: baked.reason };
    const done = await this.applyBaked(obj, tree, baked, raw);
    const label = raw && typeof raw === "object" ? (raw as { label?: unknown }).label : undefined;
    if (done.ok === true && typeof label === "string" && label.trim()) {
      const node = parseNode(done.node);
      if (node !== null) this.rename(obj, node, label);
      return { ...done, label: label.trim().slice(0, 80) };
    }
    return done;
  }

  private async applyBaked(obj: PlateObject, tree: ModelTree, baked: { op: ModelOp; typed: Record<string, unknown> }, raw: unknown, budgetMs?: number): Promise<Record<string, unknown>> {
    if (baked.op.kind === "partition") return this.applyPartition(obj, tree, baked.op, baked.typed, budgetMs);
    if (baked.op.kind === "split") {
      const note = this.splitCheck(obj, baked.op);
      if (note.bad) return { ok: false, reason: note.text };
    }
    const key = probeKey(String(tree.current), baked.op);
    if (!obj.probes.has(key)) return { ok: false, reason: "Probe this edit first, or pass probe: true. It was not applied." };
    const [reserved, node] = reserveId(tree);
    obj.tree = reserved;
    const keep = baked.op.kind === "split" ? this.splitKeep(raw) : "both";
    const otherKey = baked.op.kind === "split" && keep === "both" ? `mcp-split-${obj.id}-${node}` : undefined;
    let reply: Record<string, unknown>;
    try {
      reply = await this.treeCall(applyRequest(tree.key, tree.current, node, baked.op, CHORD, otherKey), baked.op.kind, budgetMs);
    } catch (err) {
      const lost = this.lostReply(err);
      if (lost) return lost;
      throw err;
    }
    if (typeof reply.error === "string" && reply.error) {
      // --- A9. The kernel's failedStep is the piece inside a group, counting from 1. ---
      const failedStep = Number.isInteger(reply.failedStep) ? { failedStep: reply.failedStep as number } : {};
      return { ok: false, reason: plainModelError(reply.error, baked.op.kind), ...failedStep };
    }
    obj.tree = withChild(obj.tree, tree.current, { id: node, op: baked.op, label: opLabel(baked.op), fingerprint: null });
    const prior = obj.solid;
    const solid = rememberSolid(reply);
    if (solid) obj.solid = solid;
    obj.probes.clear();
    // --- A9. Each piece of a group was already guarded. A group of cuts may remove more than half on purpose. ---
    const guarded = baked.op.kind === "group" ? null : this.stepGuard(obj, baked.op, prior, obj.solid);
    if (guarded) {
      await this.takeBack(obj, tree.current, node);
      return { ok: false, ...guarded };
    }
    const leftPlate = baked.op.kind === "join" && !baked.op.keepTool ? baked.op.tool.object : undefined;
    if (leftPlate) await this.followJoins(obj);
    const other = otherKey ? this.keepOtherHalf(obj, otherKey, reply.other, node) : undefined;
    const kept = baked.op.kind === "split" ? (keep === "both" ? "both" : this.keptSide(obj, baked.op)) : undefined;
    return { ok: true, node: nodeHandle(node), ...(other ? { other } : {}), ...(kept ? { kept } : {}), ...(leftPlate ? { toolLeftPlate: leftPlate } : {}), stored: cleanOp(baked.op as unknown as Record<string, unknown>), typed: cleanOp(baked.typed), ...turnEcho(baked.typed) };
  }

  /**
   * A step the kernel applied but that is not what it meant: a fuse that lost the part, a cut that took more than its
   * tool, a step that lost most of the volume, or a Boolean that left pieces meeting along an edge.
   */
  private stepGuard(obj: PlateObject, op: ModelOp, prior: SolidView | null, after: SolidView | null): { reason: string; touching?: true } | null {
    if (!prior || !after) return null;
    const box = op.kind === "boolean" ? primitiveBox(op) : null;
    const lost = lostVolume(op as { kind: string; op?: string }, prior.volumeMm3, after.volumeMm3, box);
    if (lost) return { reason: lost };
    if (box) {
      const was = touchingEdges(prior.positions, box);
      const now = touchingEdges(after.positions, box);
      if (now.count > was.count) return { reason: touchingReason(now.at ? applyPose(obj.modelPose, now.at).map((v) => Math.round(v * 100) / 100) as [number, number, number] : null), touching: true };
    }
    return null;
  }

  /** Back to `to`, and `node` out of the history: a step the guard refused leaves no trace. */
  private async takeBack(obj: PlateObject, to: number, node: number): Promise<void> {
    await this.gotoNode(obj, to);
    if (obj.tree?.nodes.has(node)) this.drop(obj, node);
  }

  /**
   * What composite ops need to expand: the object's workplane, and any flat face's frame and U, V extent.
   * The builder is shared with the app's feature tools (`src/modeling/frames.ts`).
   */
  private expandContext(obj: PlateObject): ExpandContext {
    // --- D24. A moved part is read in model space, as the app reads it, since every op goes through toSolidOp once.
    // The posed mesh and its face frames are kept per solid and pose (posedContext), so a batch reads them once.
    if (obj.solid && !isIdentity(obj.modelPose)) return { ...posedContext(obj.solid, obj.modelPose), plane: this.typedPlane(obj) };
    // --- A3 composite features: one context builder for the session and the panel. ---
    return expandContextFromSolid(
      obj.solid ? { positions: obj.solid.positions, triangles: obj.solid.triangles, faces: obj.solid.faces as FrameFace[] } : null,
      obj.workplane,
      {
        matchFaces: (faces, input) => facesMatching(faces as Parameters<typeof facesMatching>[0], input),
        stand: (positions, frame, depth, overlap) => standRegion(positions as Float32Array, frame, depth, overlap),
        closeCracks,
      },
    );
    // --- end A3 ---
  }

  /**
   * --- D28. A feature typed with a face selector is stored with the face it found, as the app stores its pick, so an
   * edit in the app and a replay re-expand on that face. A selector that finds none is left for expand to refuse.
   */
  private withFaceIndex(obj: PlateObject, raw: Record<string, unknown>): Record<string, unknown> {
    if (!isFeatureTool(raw.kind) || raw.face === undefined || raw.faceIndex !== undefined || !raw.face || typeof raw.face !== "object") return raw;
    const index = this.expandContext(obj).faceBy(raw.face as Record<string, unknown>);
    if (typeof index !== "number") return raw;
    const { face: _face, ...rest } = raw;
    return { ...rest, faceIndex: index };
  }

  /**
   * The plane a profile is drawn on: origin and turn as given, else a face (face or faceIndex, with from: corner putting
   * U, V = 0 at the face's min corner), else the object's workplane.
   */
  private profilePlane(obj: PlateObject, spec: Record<string, unknown>): { origin: [number, number, number]; turn: [number, number, number] } | { reason: string } {
    if (spec.origin !== undefined || spec.turn !== undefined) return { origin: readVec3(spec.origin, [0, 0, 0]), turn: readVec3(spec.turn, [0, 0, 0]) };
    if (spec.face === undefined && spec.faceIndex === undefined) {
      const plane = this.typedPlane(obj);
      return { origin: [...plane.origin], turn: [...plane.turn] };
    }
    const frame = faceFrame(spec, this.expandContext(obj));
    if ("reason" in frame) return frame;
    const shift = anchorOf(spec.from, frame.extent);
    if ("reason" in shift) return shift;
    return { origin: planePoint(frame.plane, [shift[0], shift[1], 0]), turn: [...frame.plane.turn] };
  }

  /** A plain Boolean op typed in the object's workplane, as a part-frame piece. */
  private pieceOf(obj: PlateObject, raw: Record<string, unknown>): Piece | { reason: string } {
    const local = primitiveFrom(raw, "box");
    if ("reason" in local) return local;
    const op = raw.op === "fuse" || raw.op === "common" ? raw.op : "cut";
    return { op, spec: planePrimitive(local, this.typedPlane(obj)) };
  }

  /**
   * Several edits as one: each composite op expands to Boolean steps, and every step is probed, then applied, in
   * order. On a refusal, `rollback` takes the solid back to where it started, `stop` leaves it at the last op that
   * applied, and `skip` leaves the refused op out and carries on, reporting every refusal. `keep` leaves the steps of
   * a rolled-back run in the history, so a model_build can resume from them. A run of more than one step is one undo
   * step. `offset` numbers the ops from there, for a resumed build.
   * --- A9. A composite whose pieces all apply is then one group node, and one checkpoint. ---
   */
  private async applyMany(obj: PlateObject, raws: Record<string, unknown>[], options: { label?: string; onError?: unknown; keep?: boolean; offset?: number; start?: number }): Promise<Record<string, unknown>> {
    const opened = await this.opened(obj);
    if ("reason" in opened) return { ok: false, reason: opened.reason };
    const mode = options.onError === "stop" || options.onError === "skip" ? options.onError : "rollback";
    const start = options.start ?? opened.current;
    const offset = options.offset ?? 0;
    const nodes: number[] = [];
    /** The node after each op, or null for one left out: what a resumed build reuses. */
    const checkpoints: (number | null)[] = [];
    const failures: Record<string, unknown>[] = [];
    let skipped = 0;
    let touching = 0;
    let touchingAt: string | undefined;
    let made = 0;
    const result = (body: Record<string, unknown>) => ({ ...body, checkpoints });
    const meta = this.callContext.getStore();
    // Progress per step, so a client that resets its timeout on progress keeps waiting for a long batch.
    const progress = (index: number, step: number, steps: number, doing?: string) => {
      const fraction = Math.min(0.999, (index + (steps > 0 ? step / steps : 0)) / Math.max(1, raws.length));
      const stage = `op ${index + 1 + offset} of ${raws.length + offset}${doing ? `, ${doing}` : steps > 1 ? `, step ${step + 1} of ${steps}` : ""}`;
      if (meta) {
        meta.fraction = fraction;
        meta.stage = stage;
      }
      this.onProgress?.("model", fraction, stage, meta?.progressToken);
    };
    // A cancelled call, or one the client gave up on, takes the whole run back: the part is as it was before it.
    const cancelled = async (): Promise<Record<string, unknown>> => {
      if (obj.treeStale && obj.tree?.nodes.has(start)) obj.tree = jumped(obj.tree, start);
      if (nodes.length > 0) {
        await this.gotoNode(obj, start);
        if (obj.tree?.nodes.has(nodes[0]!)) this.drop(obj, nodes[0]!);
      }
      return result({ ok: false, applied: 0, rolledBack: true, cancelled: true, reason: "The call was cancelled, so the whole run was taken back. The part and its history are as they were before it.", node: nodeHandle(start) });
    };
    const fail = async (failed: Record<string, unknown>): Promise<Record<string, unknown>> => {
      if (mode === "rollback" && nodes.length > 0) {
        if (obj.treeStale && obj.tree?.nodes.has(start)) obj.tree = jumped(obj.tree, start);
        await this.gotoNode(obj, start);
        if (obj.tree && !options.keep) this.drop(obj, nodes[0]!);
        return result({ ok: false, applied: 0, rolledBack: true, failed, node: nodeHandle(start) });
      }
      return result({ ok: false, applied: nodes.length, failed, ...(nodes.length ? { node: nodeHandle(nodes[nodes.length - 1]!) } : {}) });
    };
    for (let index = 0; index < raws.length; index += 1) {
      if (meta?.signal?.aborted) return cancelled();
      progress(index, 0, 0);
      const label = typeof raws[index]!.label === "string" && (raws[index]!.label as string).trim() ? (raws[index]!.label as string).trim() : undefined;
      const before = obj.tree?.current ?? start;
      const anchored = this.anchored(obj, raws[index]!);
      if ("reason" in anchored) {
        const row = { index: index + offset, ...(label ? { label } : {}), reason: anchored.reason };
        if (mode !== "skip") return fail(row);
        failures.push(row);
        checkpoints.push(null);
        continue;
      }
      const raw = this.withFaceIndex(obj, anchored.op);
      const ownNodes: number[] = [];
      // One op's refusal: the run ends, or with skip the op's own steps go and the run carries on.
      const refuse = async (failed: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
        const row = { index: index + offset, ...(label ? { label } : {}), ...failed };
        if (mode !== "skip") {
          const ended = await fail(row);
          // A kept run keeps only whole ops: a composite's partial steps go.
          if (mode === "rollback" && options.keep && ownNodes.length > 0 && obj.tree?.nodes.has(ownNodes[0]!)) this.drop(obj, ownNodes[0]!);
          return ended;
        }
        if (ownNodes.length > 0) {
          await this.gotoNode(obj, before);
          if (obj.tree) this.drop(obj, ownNodes[0]!);
          nodes.splice(nodes.length - ownNodes.length, ownNodes.length);
        }
        failures.push(row);
        checkpoints.push(null);
        return null;
      };
      if (!isComposite(raw.kind)) {
        if ((made += 1) > MAX_PIECES) return fail({ index: index + offset, reason: `This makes more than ${MAX_PIECES} steps. Split it into smaller batches.` });
        const probed = await this.probe(obj, raw);
        const done = probed.ok === true ? await this.apply(obj, raw) : probed;
        if (done.ok !== true) {
          const ended = await refuse({ reason: String(done.reason ?? "This edit did not apply."), ...(done.where ? { where: done.where } : {}) });
          if (ended) return ended;
          continue;
        }
        const node = parseNode(done.node);
        if (node !== null) nodes.push(node);
        checkpoints.push(obj.tree?.current ?? null);
        continue;
      }
      // --- 3.1 F15. A pattern or mirror of an extrude or a revolve repeats that whole step on moved planes; other
      // composites expand to Boolean pieces. Expanded now, on the solid as the steps before it left it, so a face
      // selector sees faces they made.
      const context = this.expandContext(obj);
      const copies = featureCopies(raw, context.plane, (spec) => this.profilePlane(obj, spec));
      const expanded = copies === null ? expand(raw, context, (op) => this.pieceOf(obj, op)) : copies;
      if ("reason" in expanded) {
        const ended = await refuse({ reason: expanded.reason });
        if (ended) return ended;
        continue;
      }
      const pieces = copies === null ? expanded as Piece[] : [];
      const count = expanded.length;
      if ((made += count) > MAX_PIECES) return fail({ index: index + offset, reason: `This makes more than ${MAX_PIECES} steps. Split it into smaller batches.` });
      let refused: Record<string, unknown> | null = null;
      const touchingBefore = touching;
      // --- A9. The pieces that landed, in the solid's frame, become the group's steps. ---
      const steps: ModelOp[] = [];
      for (let k = 0; k < count; k += 1) {
        if (meta?.signal?.aborted) return cancelled();
        progress(index, k, count);
        if (copies !== null && !("reason" in copies)) {
          const copy = copies[k]!;
          const probed = await this.probe(obj, copy);
          const done = probed.ok === true ? await this.apply(obj, copy) : probed;
          if (done.ok !== true) {
            refused = { reason: String(done.reason ?? "This edit did not apply."), piece: cleanOp(copy), step: k + 1, of: count, failedStep: k + 1, ...(done.where ? { where: done.where } : {}) };
            break;
          }
          const node = parseNode(done.node);
          const op = node === null ? null : obj.tree?.nodes.get(node)?.op;
          if (node === null || !op) continue;
          nodes.push(node);
          ownNodes.push(node);
          steps.push(op);
          continue;
        }
        const piece = pieces[k]!;
        const attempt = async (spec: PrimitiveSpec): Promise<{ probed: Record<string, unknown>; done: Record<string, unknown>; typed: Record<string, unknown>; op: ModelOp | null }> => {
          const at = await this.opened(obj);
          if ("reason" in at) {
            const missed = { ok: false, reason: at.reason };
            return { probed: missed, done: missed, typed: {}, op: null };
          }
          const typed = { kind: "boolean", op: piece.op, ...spec } as Record<string, unknown>;
          const baked = { op: toSolidOp({ kind: "boolean", op: piece.op, ...spec }, obj.modelPose), typed };
          const probed = await this.probeBaked(obj, at, at.current, baked, false, true);
          const done = probed.ok === true ? await this.applyBaked(obj, at, baked, {}) : probed;
          return { probed, done, typed, op: baked.op };
        };
        let { probed, done, typed, op } = await attempt(piece.spec);
        if (probed.ok !== true && probed.missed === true) {
          skipped += 1;
          continue;
        }
        // A step that leaves pieces meeting along an edge is tried once a little shorter, then left out.
        if (done.ok !== true && done.touching === true) {
          for (const shorter of shortenedBoxes(piece.spec, TOUCH_TRIM)) {
            ({ probed, done, typed, op } = await attempt(shorter));
            if (done.ok === true || (done.touching !== true && probed.missed !== true)) break;
          }
          if (done.ok !== true && (done.touching === true || probed.missed === true)) {
            touching += 1;
            touchingAt ??= String(done.reason ?? "");
            continue;
          }
        }
        if (done.ok !== true) {
          // --- A9. failedStep is the piece, counting from 1, including a located refusal. ---
          refused = { reason: String(done.reason ?? "This edit did not apply."), piece: cleanOp(typed), step: k + 1, of: count, failedStep: k + 1, ...(done.where ? { where: done.where } : {}) };
          break;
        }
        const node = parseNode(done.node);
        if (node === null || !op) continue;
        nodes.push(node);
        ownNodes.push(node);
        steps.push(op);
      }
      // --- D20. A composite whose every step missed changes nothing: refused, as the engine refuses such a group.
      // A step left out because it would only touch along an edge is reported as leftOut instead.
      if (!refused && ownNodes.length === 0 && count > 0 && touching === touchingBefore) {
        refused = { reason: count === 1 ? "Its one step does not change the part." : `None of its ${count} steps changes the part.` };
      }
      if (refused) {
        const ended = await refuse(refused);
        if (ended) return ended;
        continue;
      }
      // --- A9. Replace the piece chain with one group. A composite that applied nothing stays as it was. ---
      if (ownNodes.length > 0) {
        progress(index, count - 1, count, `gathering its ${ownNodes.length} steps into one group`);
        const stored = await this.storeGroup(obj, before, ownNodes[0]!, steps, label, raw);
        if (stored.ok !== true) {
          // The pieces are already gone. refuse still drops them when they remain, and rolls the run back.
          const ended = await refuse(stored.failed);
          if (ended) return ended;
          continue;
        }
        nodes.splice(nodes.length - ownNodes.length, ownNodes.length);
        nodes.push(stored.node);
      }
      checkpoints.push(obj.tree?.current ?? null);
    }
    // A cancel that came while the last step ran takes the run back too.
    if (meta?.signal?.aborted) return cancelled();
    // --- A9. One group node is still one undo step, the same as a run of several pieces was. ---
    const end = nodes[nodes.length - 1];
    const storedGroup = nodes.some((id) => obj.tree?.nodes.get(id)?.op?.kind === "group");
    if (end !== undefined && (nodes.length > 1 || storedGroup || (options.start !== undefined && nodes.length > 0))) {
      const endOp = obj.tree?.nodes.get(end)?.op;
      const groupLabel = options.label ?? (endOp?.kind === "group" ? endOp.label : `${nodes.length} steps`);
      obj.groups = [...(obj.groups ?? []), { start, end, label: groupLabel }];
    }
    return result({
      ok: failures.length === 0,
      applied: nodes.length,
      ...(failures.length ? { failures, note: `${failures.length} op${failures.length === 1 ? " was" : "s were"} refused and left out; the rest applied. Fix them and call model_build again: it reuses every op before the first one changed.` } : {}),
      ...(skipped ? { skipped, missedNote: `${skipped} step${skipped === 1 ? "" : "s"} missed the solid and were left out.` } : {}),
      ...(touching ? { leftOut: touching, leftOutNote: `${touching} step${touching === 1 ? "" : "s"} would have left pieces meeting only along an edge, even ${TOUCH_TRIM} mm shorter at each end, and ${touching === 1 ? "was" : "were"} left out. The first: ${touchingAt}` } : {}),
      ...(nodes.length ? { first: nodeHandle(nodes[0]!), node: nodeHandle(nodes[nodes.length - 1]!) } : {}),
      ...(options.label ? { label: options.label } : {}),
      fingerprint: obj.solid?.fingerprint ?? null,
      bounds: obj.solid?.bounds ?? null,
    });
  }

  /**
   * The run of pieces from `firstPiece` to the current step, folded by the engine into `group` under `before`: the group
   * node's id, null when the engine would not fold it (the caller then builds the group), or the failure when the
   * modeler had to be restarted.
   */
  private async foldGroup(obj: PlateObject, before: number, firstPiece: number, group: GroupOp): Promise<number | Record<string, unknown> | null> {
    const tree = obj.tree;
    if (!tree || obj.treeStale || !pathTo(tree, tree.current).includes(firstPiece)) return null;
    const [reserved, node] = reserveId(tree);
    const without = dropped(jumped(reserved, before), firstPiece);
    if (!without) return null;
    let reply: Record<string, unknown>;
    try {
      reply = await this.treeCall({ call: "fold", key: tree.key, parent: before, node, op: group, last: tree.current, chordMm: CHORD }, "group");
    } catch (err) {
      const lost = this.lostReply(err);
      if (lost) return lost;
      if (err instanceof ProtocolError) return null;
      throw err;
    }
    if (typeof reply.error === "string" && reply.error) return null;
    obj.tree = withChild(without, before, { id: node, op: group, label: opLabel(group), fingerprint: null });
    const solid = rememberSolid(reply);
    if (solid) obj.solid = solid;
    obj.probes.clear();
    return node;
  }

  /**
   * --- A9. The pieces of one composite become a single group node.
   * Go back to the step before them, drop the chain, then probe and apply the group.
   * The probe and the apply share a budget that grows with the step count, so one composite is not cut off at the per-call limit.
   */
  private async storeGroup(obj: PlateObject, before: number, firstPiece: number, steps: ModelOp[], label: string | undefined, raw: Record<string, unknown>): Promise<{ ok: true; node: number } | { ok: false; failed: Record<string, unknown> }> {
    let source: unknown = raw;
    try {
      source = JSON.parse(JSON.stringify(raw)) as unknown;
    } catch {
      source = raw;
    }
    const group: GroupOp = { kind: "group", label: compositeGroupLabel(raw, label), source, steps };
    // --- 3.1 F1. The pieces are built and checked already: they fold into the group, which builds nothing again. Only
    // an engine that cannot fold them (an old one, or a run whose last solid it let go) builds the group from the start.
    const folded = await this.foldGroup(obj, before, firstPiece, group);
    if (typeof folded === "number") return { ok: true, node: folded };
    if (folded) return { ok: false, failed: folded };
    const back = await this.gotoNode(obj, before);
    if (back.ok !== true) return { ok: false, failed: { reason: String(back.reason ?? "The steps could not be gathered into one.") } };
    if (obj.tree?.nodes.has(firstPiece)) this.drop(obj, firstPiece);
    const at = await this.opened(obj);
    if ("reason" in at) return { ok: false, failed: { reason: at.reason } };
    const baked = { op: group as ModelOp, typed: group as unknown as Record<string, unknown> };
    const budget = Math.max(this.modelTimeoutMs(), Math.max(1, steps.length) * 5000);
    const probed = await this.probeBaked(obj, at, at.current, baked, false, false, budget);
    if (probed.ok !== true) {
      return { ok: false, failed: { reason: String(probed.reason ?? "These steps did not fit."), ...(typeof probed.failedStep === "number" ? { failedStep: probed.failedStep } : {}), ...(probed.where ? { where: probed.where } : {}) } };
    }
    const done = await this.applyBaked(obj, at, baked, {}, budget);
    if (done.ok !== true) {
      return { ok: false, failed: { reason: String(done.reason ?? "These steps did not apply."), ...(typeof done.failedStep === "number" ? { failedStep: done.failedStep } : {}), ...(done.where ? { where: done.where } : {}) } };
    }
    const node = parseNode(done.node);
    if (node === null) return { ok: false, failed: { reason: "These steps did not apply." } };
    return { ok: true, node };
  }

  private async applyBatch(obj: PlateObject, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const ops = Array.isArray(input.ops) ? input.ops as Record<string, unknown>[] : [];
    if (ops.length === 0) return { ok: false, reason: "The batch needs at least one op." };
    const exprs = this.pendingExprs;
    this.pendingExprs = [];
    const { checkpoints, ...ran } = await this.applyMany(obj, ops, { label: typeof input.label === "string" ? input.label : undefined, onError: input.onError });
    // A batch rolled back made no node to keep them on.
    if (ran.rolledBack !== true) this.keepExprs(obj, checkpoints as (number | null)[], exprs);
    return ran;
  }

  /**
   * A new solid, a batch of edits on it, and a commit, in one call. A build that was refused keeps its steps: called
   * again with the same base, it reuses every op before the first one that changed, and runs only the rest. `object`
   * names an earlier build to rebuild in place the same way, refused or not.
   */
  private async build(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const recipe = this.pendingRecipe;
    this.pendingRecipe = null;
    if (input.base === undefined) return { ok: false, reason: "model_build needs a base, or an object whose recipe to rerun." };
    const base = (input.base ?? {}) as Record<string, unknown>;
    const ops = Array.isArray(input.ops) ? input.ops as Record<string, unknown>[] : [];
    const baseKey = stableKey(base);
    const keys = ops.map(stableKey);
    const name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, NAME_LIMIT) : undefined;
    let obj: PlateObject | null | undefined;
    if (input.object !== undefined) {
      obj = this.find(String(input.object));
      if (!obj) return { ok: false, reason: UNKNOWN_OBJECT };
      if (!obj.buildLog) return { ok: false, reason: "That object was not made by model_build. Rebuild only works on one that was." };
      if (obj.buildLog.base !== baseKey) return { ok: false, reason: "The base differs from that object's build. Rebuild keeps the base; start a new model_build for another." };
    } else if (input.resume !== false) {
      obj = [...this.objects].reverse().find((row) => row.buildLog?.refused && row.buildLog.base === baseKey && (!name || row.name === name));
    }
    let reused = 0;
    let from: number | null = null;
    if (obj?.buildLog && obj.tree) {
      const log = obj.buildLog;
      while (reused < keys.length && reused < log.steps.length && log.steps[reused]!.key === keys[reused] && log.steps[reused]!.node !== null && obj.tree.nodes.has(log.steps[reused]!.node!)) reused += 1;
      from = reused > 0 ? log.steps[reused - 1]!.node : log.start;
      const moved = await this.gotoNode(obj, from);
      if (moved.ok !== true) {
        obj = undefined;
        reused = 0;
      } else {
        // The old run past the reused ops is replaced: drop it, so the history holds one path.
        const stale = log.steps.slice(reused).find((step) => step.first !== null && obj!.tree!.nodes.has(step.first));
        if (stale?.first != null) this.drop(obj, stale.first);
      }
    }
    if (!obj) {
      const made = await this.solidNew(base);
      if (made.ok !== true) return made;
      obj = this.find(String(made.object));
      if (!obj) return { ok: false, reason: UNKNOWN_OBJECT };
      const tree = await this.opened(obj);
      if ("reason" in tree) return { ok: false, object: obj.id, reason: tree.reason };
      obj.buildLog = { base: baseKey, start: tree.current, steps: [], refused: false };
      from = null;
    }
    if (name) obj.name = name;
    if (recipe) obj.recipe = recipe;
    const log = obj.buildLog!;
    const firsts = log.steps.slice(0, reused);
    const rest = ops.slice(reused);
    const beforeRest = obj.tree?.current ?? log.start;
    const ran = rest.length
      ? await this.applyMany(obj, rest, { label: typeof input.label === "string" ? input.label : obj.name, onError: input.onError, keep: true, offset: reused, ...(reused > 0 ? { start: log.start } : {}) })
      : { ok: true, applied: 0, checkpoints: [] };
    // The log: each op's key, the node after it (null when left out), and its first node, for a later resume to drop.
    const points = (ran.checkpoints ?? []) as (number | null)[];
    let previous = beforeRest;
    const fresh = points.map((node, i) => {
      const first = node === null || !obj!.tree ? null : firstAfter(obj!.tree, previous, node);
      if (node !== null) previous = node;
      return { key: keys[reused + i]!, node, first };
    });
    log.steps = [...firsts, ...fresh];
    log.refused = ran.ok !== true;
    const { checkpoints: _checkpoints, ...body } = ran as Record<string, unknown>;
    const resumed = from !== null ? { resumed: { reusedOps: reused, ranOps: rest.length, note: reused > 0 ? `Reused the first ${reused} ops from the earlier build; ran ${rest.length}.` : "Rebuilt on the earlier build's object." } } : {};
    if (ran.ok !== true) {
      const note = input.onError === "skip"
        ? "The solid has every op but the refused ones, uncommitted. Fix those ops and call model_build again with the same base: it reuses every op before the first one changed."
        : "The solid is on the plate without the batch. Fix the op and call model_build again with the same base and ops: it reuses every op before the refused one.";
      return { ...body, ...resumed, applied: reused + Number(body.applied ?? 0), object: obj.id, note };
    }
    if (input.commit !== false) {
      const reason = await this.commitObject(obj);
      if (reason) return { ok: false, object: obj.id, reason };
    }
    return { ...body, ...resumed, applied: reused + Number(body.applied ?? 0), object: obj.id, committed: input.commit !== false, bounds: obj.solid?.bounds ?? null };
  }

  /** The op with every anchor replaced by the point it names on this object, as the solid stands now. */
  private anchored(obj: PlateObject, raw: Record<string, unknown>): { op: Record<string, unknown> } | { reason: string } {
    if (!hasAnchor(raw)) return { op: raw };
    try {
      return { op: resolveAnchors(raw, (label) => this.labelBox(obj, label)) as Record<string, unknown> };
    } catch (err) {
      if (err instanceof AnchorError) return { reason: err.message };
      throw err;
    }
  }

  /**
   * The box, in the frame ops are typed in, of the tools the steps a label names applied: a step's own label, every
   * step named under it ("label body" of a placed part, or an older file's "label k/n"), a group's own label, or a
   * batch's label, on the path to the current step. "part" is the solid.
   */
  private labelBox(obj: PlateObject, label: string, solidFrame = false): Box | null {
    const tree = obj.tree;
    if (!tree) return null;
    const toTyped = solidFrame ? (p: [number, number, number]) => p : (p: [number, number, number]) => this.typedPoint(obj, applyPose(obj.modelPose, p));
    if (label.trim().toLowerCase() === "part") return obj.solid ? movedBox(obj.solid.bounds as Box, toTyped) : null;
    const wanted = label.trim().toLowerCase();
    const path: number[] = [];
    for (let node: number | null = tree.current; node !== null; node = tree.nodes.get(node)?.parent ?? null) path.push(node);
    const onPath = new Set(path);
    const grouped = new Set<number>();
    for (const group of obj.groups ?? []) {
      if (group.label.toLowerCase() !== wanted || !onPath.has(group.end) || !onPath.has(group.start)) continue;
      for (let node: number | null = group.end; node !== null && node !== group.start; node = tree.nodes.get(node)?.parent ?? null) grouped.add(node);
    }
    let box: Box | null = null;
    for (const node of path) {
      const row = tree.nodes.get(node);
      if (!row?.op) continue;
      const name = row.label.toLowerCase();
      // "fish 0" names "fish 0 body" and "fish 0 tail". An older file's "label k/n" still matches; a group matches its own label.
      const piece = name.startsWith(`${wanted} `);
      if (name !== wanted && !piece && !grouped.has(node)) continue;
      const own = opBox(row.op);
      if (own) box = unionBox(box, movedBox(own, toTyped));
    }
    return box;
  }

  /**
   * --- D24. The workplane in model space, where ops are typed. It is stored in the part's own frame, as the app and
   * the file keep it, so it moves with the part when model_place moves the part.
   */
  private typedPlane(obj: PlateObject): Workplane {
    // Global is model space itself, on any pose.
    if (isIdentity(obj.modelPose) || isGlobalFrame(obj.workplane)) return obj.workplane;
    return workplaneIn(obj.workplane, obj.modelPose);
  }

  /** A part-frame point in the object's workplane, the frame its ops are typed in. */
  private typedPoint(obj: PlateObject, p: [number, number, number]): [number, number, number] {
    const plane = this.typedPlane(obj);
    if (isGlobalFrame(plane)) return p;
    const m = eulerOrient(plane.turn[0], plane.turn[1], plane.turn[2]);
    const d = [p[0] - plane.origin[0], p[1] - plane.origin[1], p[2] - plane.origin[2]];
    return [0, 1, 2].map((c) => m[c]! * d[0]! + m[3 + c]! * d[1]! + m[6 + c]! * d[2]!) as [number, number, number];
  }

  /** model_anchors: every label on the path to the current step with its box, or one label's. */
  private anchorsTool(obj: PlateObject, input: Record<string, unknown>): Record<string, unknown> {
    if (!obj.tree) return { ok: false, reason: "This object has no Model history yet." };
    if (typeof input.label === "string") {
      const box = this.labelBox(obj, input.label);
      return box ? { ok: true, ...anchorRow(input.label, box) } : { ok: false, reason: `No step is labelled "${input.label}" with a tool to measure.` };
    }
    const names = new Set<string>();
    for (let node: number | null = obj.tree.current; node !== null; node = obj.tree.nodes.get(node)?.parent ?? null) {
      const row = obj.tree.nodes.get(node);
      if (!row?.op) continue;
      names.add(row.label.replace(/ \d+\/\d+$/, ""));
    }
    for (const group of obj.groups ?? []) if (obj.tree.nodes.has(group.end)) names.add(group.label);
    const rows = [...names].reverse().flatMap((name) => {
      const box = this.labelBox(obj, name);
      return box ? [anchorRow(name, box)] : [];
    });
    const part = this.labelBox(obj, "part");
    return { ok: true, labels: rows.slice(0, 200), ...(part ? { part: anchorRow("part", part) } : {}) };
  }

  /** The parameters, parts, and each build's recipe and log, as the project keeps them. Null when there are none. */
  private mcpModelRecord(): Record<string, unknown> | null {
    const recipes: Record<string, unknown> = {};
    for (const obj of this.objects) if (obj.recipe) recipes[obj.id] = { recipe: obj.recipe, ...(obj.buildLog ? { buildLog: obj.buildLog } : {}) };
    const record = {
      ...(this.parts.size ? { parts: Object.fromEntries(this.parts) } : {}),
      ...(Object.keys(recipes).length ? { recipes } : {}),
    };
    return Object.keys(record).length ? structuredClone(record) : null;
  }

  /** A project's MCP record back into the session: what it does not understand it leaves out. */
  private adoptMcpModel(value: Record<string, unknown> | undefined): void {
    this.parts.clear();
    if (!value) return;
    const parts = value.parts;
    if (parts && typeof parts === "object") {
      for (const [name, part] of Object.entries(parts)) {
        const row = part as Partial<PartDef> | null;
        if (row && Array.isArray(row.ops) && row.params && typeof row.params === "object") this.parts.set(name, { params: row.params, ops: row.ops });
      }
    }
    const recipes = value.recipes;
    if (recipes && typeof recipes === "object") {
      for (const [id, saved] of Object.entries(recipes)) {
        const obj = this.find(id);
        const row = saved as { recipe?: Recipe; buildLog?: PlateObject["buildLog"] } | null;
        if (!obj || !row?.recipe || typeof row.recipe !== "object") continue;
        obj.recipe = row.recipe;
        if (row.buildLog && Array.isArray(row.buildLog.steps) && typeof row.buildLog.base === "string") obj.buildLog = row.buildLog;
      }
    }
  }

  /** model_define: a named part, its default parameters and its ops, which {kind: "use", part, with} places. */
  private defineTool(input: Record<string, unknown>): Record<string, unknown> {
    if (input.clear === true) this.parts.clear();
    if (typeof input.name === "string") {
      const name = input.name.trim();
      if (!/^[A-Za-z_][A-Za-z0-9_ -]*$/.test(name)) return { ok: false, reason: "A part name is letters, digits, spaces, dashes, and underscores." };
      if (!Array.isArray(input.ops) || input.ops.length === 0) return { ok: false, reason: "A part needs ops." };
      const params = (input.params ?? {}) as Record<string, unknown>;
      try {
        // Expanded once with its defaults, so a mistake shows now rather than at the first use.
        const defaults: Record<string, number> = { ...this.params };
        for (const [key, value] of Object.entries(params)) defaults[key] = Number(resolveNumbers(value, defaults, `params.${key}`));
        expandOps(input.ops, defaults, this.parts, OP_WORDS);
      } catch (err) {
        if (err instanceof ExprError) return { ok: false, reason: err.message };
        throw err;
      }
      this.parts.set(name, { params: structuredClone(params), ops: structuredClone(input.ops) });
    }
    return { ok: true, parts: [...this.parts.entries()].map(([name, part]) => ({ name, params: part.params, ops: part.ops.length })) };
  }

  /** Session parameters: names model ops may use in place of numbers, as text such as "wallH + 2". */
  private paramsTool(input: Record<string, unknown>): Record<string, unknown> {
    const set = (input.set ?? {}) as Record<string, unknown>;
    const next: Record<string, string | number> = input.clear === true ? {} : { ...this.paramText };
    for (const [name, value] of Object.entries(set)) {
      if (!PARAM_NAME.test(name)) return { ok: false, reason: `"${name}" is not a parameter name. Use letters, digits, and underscores.` };
      next[name] = typeof value === "number" && Number.isFinite(value) ? value : String(value);
    }
    // --- D22. A row this call sets must evaluate; a bad row it does not touch stays, as the app's panel keeps it.
    const table = evaluateTable(next);
    const bad = table.rows.filter((row) => row.error);
    const refused = bad.find((row) => Object.hasOwn(set, row.name));
    if (refused) return { ok: false, reason: `${refused.name}: ${refused.error}` };
    this.paramText = next;
    this.params = { ...table.values };
    const errors = bad.length > 0 ? { errors: Object.fromEntries(bad.map((row) => [row.name, row.error])) } : {};
    return { ok: true, params: { ...this.params }, ...errors };
  }

  /**
   * The project's parameter table. `parameters` wins. An older file's `mcpModel.params` is the
   * fallback, and those values are numbers.
   */
  private adoptParameters(project: { parameters?: Record<string, string | number>; mcpModel?: Record<string, unknown> }): void {
    this.params = {};
    this.paramText = {};
    const top = project.parameters;
    if (top && typeof top === "object" && !Array.isArray(top)) {
      this.paramText = readParameters(top) ?? {};
    } else {
      const legacy = project.mcpModel?.params;
      if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) {
        const numbers: Record<string, number> = {};
        for (const [key, n] of Object.entries(legacy as Record<string, unknown>)) {
          if (PARAM_NAME.test(key) && typeof n === "number" && Number.isFinite(n)) numbers[key] = n;
        }
        this.paramText = numbers;
      }
    }
    this.params = { ...evaluateTable(this.paramText).values };
  }

  /**
   * A call's `params` evaluated in order on top of the session's numbers. A later name may use an
   * earlier one. The session table is unchanged.
   */
  private mergeParams(set: Record<string, unknown>): Record<string, number> | { reason: string } {
    const out: Record<string, number> = { ...this.params };
    for (const [name, value] of Object.entries(set)) {
      if (!PARAM_NAME.test(name)) return { reason: `"${name}" is not a parameter name. Use letters, digits, and underscores.` };
      try {
        out[name] = typeof value === "number" ? value : evaluate(String(value), out);
      } catch (err) {
        return { reason: `${name}: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (!Number.isFinite(out[name])) return { reason: `${name} is not a finite number.` };
    }
    return out;
  }

  /** The whole table, in order. The first bad row refuses the set and changes nothing. */
  /** A history step from a handle (node_3), its label, or a composite edit's label (its last step). */
  private nodeOf(obj: PlateObject, value: unknown): number | null {
    const parsed = parseNode(value);
    if (parsed !== null || typeof value !== "string" || !obj.tree) return parsed;
    const wanted = value.trim().toLowerCase();
    const rows = [...obj.tree.nodes.values()].filter((node) => node.label.toLowerCase() === wanted);
    if (rows.length > 0) return rows[rows.length - 1]!.id;
    const group = [...(obj.groups ?? [])].reverse().find((row) => row.label.toLowerCase() === wanted && obj.tree!.nodes.has(row.end));
    return group ? group.end : null;
  }

  private splitKeep(raw: unknown): "both" | "above" | "below" {
    if (!raw || typeof raw !== "object") return "both";
    const keep = (raw as { keep?: unknown }).keep;
    return keep === "above" || keep === "below" ? keep : "both";
  }

  /** The half whose centre is on the positive side of the plane is above. */
  private keptSide(obj: PlateObject, op: Extract<ModelOp, { kind: "split" }>): "above" | "below" {
    const box = obj.solid?.bounds;
    if (!box) return "above";
    const length = Math.hypot(op.normal[0], op.normal[1], op.normal[2]) || 1;
    const centre = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
    const depth = centre[0] * op.normal[0] + centre[1] * op.normal[1] + centre[2] * op.normal[2];
    const plane = op.origin[0] * op.normal[0] + op.origin[1] * op.normal[1] + op.origin[2] * op.normal[2];
    return depth / length >= plane / length ? "above" : "below";
  }

  private keepOtherHalf(obj: PlateObject, otherKey: string, other: unknown, node: number): string | undefined {
    if (!other || typeof other !== "object") return undefined;
    const piece = rememberSolid(other as Record<string, unknown>);
    if (!piece) return undefined;
    this.seq += 1;
    const id = `obj_${this.seq}`;
    const half: PlateObject = {
      ...obj,
      id,
      name: `${obj.name} split`,
      fileName: obj.fileName,
      bytes: new Uint8Array(),
      source: Float32Array.from(piece.positions),
      triangles: piece.positions.length / 9,
      orient: [...obj.orient] as Mat3,
      offset: { ...obj.offset },
      modelPose: { m: [...obj.modelPose.m] as Affine["m"], t: [...obj.modelPose.t] as Affine["t"] },
      workplane: { source: obj.workplane.source, origin: [...obj.workplane.origin] as Workplane["origin"], turn: [...obj.workplane.turn] as Workplane["turn"] },
      tree: newTree(otherKey, { kind: "piece", tree: obj.tree?.key ?? otherKey, node }, "Split", piece.fingerprint),
      solid: piece,
      probes: new Map(),
      platedNode: null,
      supportEdits: obj.supportEdits.map((entry) => structuredClone(entry)),
      supportPaint: obj.supportPaint.map((disk) => ({ ...disk, p: [...disk.p] as PaintDisk["p"], n: [...disk.n] as PaintDisk["n"] })),
      seamPaint: obj.seamPaint.map((disk) => structuredClone(disk)),
      reinforcement: obj.reinforcement.map((region) => structuredClone(region)),
      objectSettings: { ...obj.objectSettings },
      // The half has no STEP or build of its own until its first commit.
      brep: undefined,
      buildLog: undefined,
      recipe: undefined,
    };
    this.objects.push(half);
    return id;
  }

  // --- Split to print (docs/plan-split-connectors.md, D8, D9, sections 10 and 13). Keep this block together. ---

  /** What the planner fills defaults from: the plate's printer as the target, the nozzle, the layer, the filament, the brim. */
  private partitionContext(obj: PlateObject | null): FillContext {
    const printer = this.printer();
    const box = obj?.solid ? (isIdentity(obj.modelPose) ? obj.solid.bounds : boundsOf(featureSolidInModel(obj.solid, obj.modelPose).positions)) : null;
    return {
      plateTarget: { printer: printer.id, process: "fdm", volumeMm: [printer.bedX, printer.bedY, printer.bedZ] },
      featureMm: this.library.nozzleMm,
      layerMm: this.settings.layerHeight,
      material: this.filament().material,
      adhesion: this.settings.adhesion,
      brimWidthMm: this.settings.brimWidthMm,
      ...(box ? { box: { min: [...box.min], max: [...box.max] } } : {}),
    };
  }

  /** model_probe with plan: true. The planner alone: the solid is read, nothing is cut. */
  private async planTool(obj: PlateObject, raw: unknown): Promise<Record<string, unknown>> {
    const spec = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    if (spec.kind !== "partition") return { ok: false, reason: PLAN_KIND };
    const tree = await this.opened(obj);
    if ("reason" in tree) return { ok: false, reason: tree.reason };
    const typed = readPartition(spec, (id) => this.partitionTarget(id));
    if ("reason" in typed) return { ok: false, reason: typed.reason };
    if (!obj.solid) return { ok: false, reason: "This solid could not be read." };
    const printer = this.printer();
    const frame = bedFrame(obj.solid.positions, obj.orient, obj.scale, obj.modelPose);
    const targetName = typed.target ? targetPrinter(this.library, typed.target.printer)?.name : undefined;
    return planPartition(typed, this.partitionContext(obj), frame, { name: printer.name, belt: printer.kind === "belt", ...(targetName ? { targetName } : {}) }, { positions: obj.solid.positions, up: plateUp(obj.orient), pose: obj.modelPose });
  }

  /**
   * solid_new with a coupon (plan section 2, milestone 6): the fit coupon for a dowel, built from the planner's layout. On
   * the plate's printer the plate and its pin are two new objects (STEP solids, with their labels cut in); for an
   * export-only printer, the Form 4, they are written to the workspace as STEP files and never reach the plate.
   */
  private async fitCouponNew(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const raw = input.coupon && typeof input.coupon === "object" && !Array.isArray(input.coupon) ? (input.coupon as Record<string, unknown>) : null;
    if (!raw) return { ok: false, reason: "coupon is {printer, material, radius, depth, hole, startMm}; every field is optional." };
    if (Object.keys(input).some((key) => key !== "coupon" && key !== "name")) return { ok: false, reason: "solid_new takes a coupon or a primitive, not both. Only name goes with a coupon." };
    const sizes = (["radius", "depth", "startMm"] as const).filter((key) => raw[key] !== undefined && (typeof raw[key] !== "number" || !Number.isFinite(raw[key])));
    if (sizes.length > 0) return { ok: false, reason: `coupon.${sizes[0]} is a number of millimetres.` };
    if (raw.hole !== undefined && raw.hole !== "round" && raw.hole !== "teardrop") return { ok: false, reason: "coupon.hole is round or teardrop." };
    let target: Target | null = null;
    if (typeof raw.printer === "string") {
      target = this.partitionTarget(raw.printer);
      if (!target) return { ok: false, reason: `No printer in the library is ${raw.printer}. machine_list shows the ids; formlabs-form-4 is the resin printer.` };
    }
    const ctx = this.partitionContext(null);
    const aimed = target ?? ctx.plateTarget;
    const name = this.givenName(input.name);
    const coupon = fitCoupon({
      process: aimed.process,
      material: typeof raw.material === "string" ? raw.material : ctx.material,
      featureMm: ctx.featureMm,
      layerMm: ctx.layerMm,
      ...(typeof raw.radius === "number" ? { radiusMm: raw.radius } : {}),
      ...(typeof raw.depth === "number" ? { depthMm: raw.depth } : {}),
      ...(raw.hole ? { hole: raw.hole as "round" | "teardrop" } : {}),
      ...(typeof raw.startMm === "number" ? { startMm: raw.startMm } : {}),
      ...(name ? { name } : {}),
    });
    if ("reason" in coupon) return { ok: false, reason: coupon.reason };
    let reply: ReturnType<typeof readCouponReply>;
    try {
      reply = readCouponReply(JSON.parse(await this.ask(this.engine.modelTree(JSON.stringify(fitCouponRequest(coupon))))) as Record<string, unknown>);
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    if (typeof reply === "string") return { ok: false, reason: plainModelError(reply, "create") };
    const parts = [{ name: coupon.name, file: couponFileName(coupon), part: reply.plate }, ...(reply.pins ? [{ name: `${coupon.name} pins`, file: couponFileName(coupon, true), part: reply.pins }] : [])];
    const summary = {
      sentence: coupon.sentence,
      process: coupon.process,
      sizeMm: coupon.sizeMm,
      holes: coupon.holes.map((hole) => ({ label: hole.label, clearanceMm: hole.clearanceMm, radiusMm: hole.radiusMm, teardrop: hole.teardrop })),
      pins: coupon.pins.length,
      engravedMm3: reply.engravedMm3,
    };
    if (aimed.process !== "fdm") {
      const paths: string[] = [];
      for (const one of parts) {
        const path = resolveWrite(one.file, ".step");
        writeFileSync(path, base64ToBytes(one.part.stepB64) ?? new Uint8Array());
        paths.push(path);
      }
      return { ok: true, files: paths, ...summary, note: SUPPORT_NOTE };
    }
    const made: PlateObject[] = [];
    for (const one of parts) {
      const bytes = base64ToBytes(one.part.stepB64);
      if (!bytes) return { ok: false, reason: "The engine did not write the coupon." };
      const preview = await this.preview(one.file, bytes, STEP);
      made.push(this.addObject({ name: one.name, fileName: one.file, bytes, source: preview.source, triangles: preview.triangles, orient: [...ID_MATRIX], scale: 1, centered: true, offset: { x: 0, y: 0, z: 0 }, seatMm: preview.seatMm, stepTolerance: STEP }));
    }
    this.selected = made[0]!.id;
    return { ok: true, objects: made.map((obj) => obj.id), names: made.map((obj) => shownName(obj.name)), ...summary };
  }

  /** --- D11. A target typed by its printer alone: the library's printer, or an export-only one such as the Form 4. */
  private partitionTarget(id: string): Target | null {
    const row = targetPrinter(this.library, id);
    return row ? printerTarget(row) : null;
  }

  /** The name a target's sentences use: the library's, or the id when the library has no such printer. */
  private targetName(op: PartitionModelOp): string {
    const id = op.target?.printer ?? this.printer().id;
    return targetPrinter(this.library, id)?.name ?? id;
  }

  /** --- D12. The split to print for an export target on the way to the part's step, or on the way to a piece's root. */
  private exportCut(obj: PlateObject): PartitionModelOp | null {
    const tree = obj.tree;
    if (!tree) return null;
    for (const id of pathTo(tree, tree.current)) {
      const op = tree.nodes.get(id)?.op;
      if (op?.kind === "partition" && exportsPieces(op)) return op;
    }
    if (tree.root.kind === "piece") {
      const parent = this.byTreeKey(tree.root.tree)?.tree?.nodes.get(tree.root.node)?.op;
      if (parent?.kind === "partition" && exportsPieces(parent)) return parent;
    }
    return null;
  }

  /** The kernel cuts a copy: every piece's volume and box in model space. The solid does not change. */
  private async probePartition(obj: PlateObject, tree: ModelTree, at: number, op: PartitionModelOp, budgetMs?: number, planned: readonly string[] = []): Promise<Record<string, unknown>> {
    let reply: Record<string, unknown>;
    try {
      reply = await this.treeCall(probeRequest(tree.key, at, op), "partition", budgetMs);
    } catch (err) {
      const lost = this.lostReply(err);
      if (lost) return lost;
      throw err;
    }
    if (reply.ok !== true) return { ok: false, reason: plainModelError(typeof reply.error === "string" ? reply.error : "This does not fit.") };
    const parts = Array.isArray(reply.parts) ? (reply.parts as { volumeMm3?: unknown; min?: unknown; max?: unknown }[]) : [];
    const mm = (value: number) => Math.round(value * 100) / 100;
    const pieces = parts.map((part, index) => {
      const corners = Array.isArray(part.min) && Array.isArray(part.max) ? [part.min as number[], part.max as number[]] : null;
      const placed = corners ? boundsOf([0, 1, 2, 3, 4, 5, 6, 7].flatMap((k) => applyPose(obj.modelPose, [corners[k & 1]![0]!, corners[(k >> 1) & 1]![1]!, corners[(k >> 2) & 1]![2]!]))) : null;
      return { part: index + 1, volumeMm3: mm(Number(part.volumeMm3)), ...(placed ? { min: placed.min.map(mm), max: placed.max.map(mm) } : {}) };
    });
    obj.probes.set(probeKey(String(at), op), true);
    // The planner's sentences first (a count that does not fit, a wall too thin), then the kernel's.
    const notes = [...new Set([...planned, ...numberNotes(reply)])];
    return { ok: true, reason: `This cut makes ${parts.length} pieces.`, parts: parts.length, pieces, ...pinsOf(reply), ...joined(reply, obj.modelPose), ...numbered(reply, obj.modelPose), ...(notes.length ? { notes } : {}) };
  }

  /** --- Milestone 5. The key the pins' tree opens under, when a cut of `op` has a dowel placed. */
  private pinsKey(obj: PlateObject, node: number, op: PartitionModelOp): string | null {
    const dowels = op.cuts.some((cut) => cut.connectors?.on && (cut.connectors.placed ?? []).some((row) => row.type === "dowel"));
    return dowels ? `mcp-pins-${obj.id}-${node}` : null;
  }

  /** The keys the kernel opens each piece's tree under, one for every piece Max pieces allows after the first. */
  private pieceKeys(obj: PlateObject, node: number, op: PartitionModelOp): string[] {
    return Array.from({ length: clampPieces(op.maxPieces ?? 12) - 1 }, (_, at) => `mcp-part-${obj.id}-${node}-${at + 2}`);
  }

  /**
   * model_apply of a split to print. The part keeps its plate id, its tree and its study, which goes stale by the solid's
   * fingerprint (D8); every other piece is a new plate object in the part's plate orientation and model pose, its own tree
   * rooted at this node, with no paint, seam, reinforcement or support edit of its own.
   */
  private async applyPartition(obj: PlateObject, tree: ModelTree, op: PartitionModelOp, typed: Record<string, unknown>, budgetMs?: number): Promise<Record<string, unknown>> {
    if (!obj.probes.has(probeKey(String(tree.current), op))) return { ok: false, reason: "Probe this edit first, or pass probe: true. It was not applied." };
    const [reserved, node] = reserveId(tree);
    obj.tree = reserved;
    let reply: Record<string, unknown>;
    try {
      reply = await this.treeCall(applyRequest(tree.key, tree.current, node, op, CHORD, null, this.pieceKeys(obj, node, op), this.pinsKey(obj, node, op)), "partition", budgetMs);
    } catch (err) {
      const lost = this.lostReply(err);
      if (lost) return lost;
      throw err;
    }
    if (typeof reply.error === "string" && reply.error) return { ok: false, reason: plainModelError(reply.error) };
    const keys: (string | null)[] = [];
    const objects: string[] = [];
    const listed = Array.isArray(reply.pieces) ? (reply.pieces as unknown[]) : [];
    const exported = exportsPieces(op);
    listed.forEach((entry, at) => {
      const id = entry && typeof entry === "object" ? this.partitionPiece(obj, entry as Record<string, unknown>, node, at + 2, exported) : null;
      keys.push(id ? String((entry as { key?: unknown }).key) : null);
      if (id) objects.push(id);
    });
    // --- Milestone 5. The pins of the cut's dowels: one more object, in the part's orientation, which stands them up.
    const pins = reply.pins && typeof reply.pins === "object" ? this.partitionPins(obj, reply.pins as Record<string, unknown>, node, exported) : null;
    const stored = reply.op && typeof reply.op === "object" && (reply.op as ModelOp).kind === "partition" ? (reply.op as PartitionModelOp) : op;
    obj.tree = withChild(obj.tree, tree.current, { id: node, op: stored, label: opLabel(stored, keys.length + 1), fingerprint: null, pieces: keys, ...(pins ? { pins: pins.key } : {}) });
    const solid = rememberSolid(reply);
    if (solid) obj.solid = solid;
    obj.probes.clear();
    const followed = this.followPieces(obj);
    const notes = [...numberNotes(reply), ...followed.orient.notes];
    const note = exported
      ? exportedNote(this.targetName(op))
      : op.arrange === false
        ? "On the plate the pieces share one spot: Arrange lays them side by side."
        : "model_commit puts every piece on the plate and lays them out.";
    return {
      ok: true,
      node: nodeHandle(node),
      parts: keys.length + 1,
      pieces: objects,
      ...(pins ? { pins: pins.id } : {}),
      note,
      ...joined(reply, obj.modelPose),
      ...numbered(reply, obj.modelPose),
      ...(notes.length ? { notes } : {}),
      stored: cleanOp(stored as unknown as Record<string, unknown>),
      typed,
    };
  }

  /**
   * --- Milestone 5. The pins as one more object (plan section 10): the part's plate orientation, which stands each pin
   * along the plate's Z, its own tree rooted as this node's pins, held off the plate for an export target. Its id and key.
   */
  private partitionPins(obj: PlateObject, entry: Record<string, unknown>, node: number, exported: boolean): { id: string; key: string } | null {
    const id = this.partitionPiece(obj, entry, node, 0, exported);
    const made = id ? [...this.objects, ...this.piecesOffPlate].find((row) => row.id === id) : undefined;
    if (!made?.tree) return null;
    made.name = `${obj.name} pins`;
    made.tree = newTree(made.tree.key, { kind: "piece", tree: obj.tree!.key, node, pins: true }, "Pins", made.tree.nodes.get(0)?.fingerprint ?? null);
    return { id: made.id, key: made.tree.key };
  }

  /**
   * One piece after the first as a plate object: the part's orientation, pose and settings, its own tree, empty paint.
   * An export target's piece is held off the plate from the start (D12): it is exported, never sliced.
   */
  private partitionPiece(obj: PlateObject, entry: Record<string, unknown>, node: number, index: number, exported = false): string | null {
    const solid = rememberSolid(entry);
    const key = typeof entry.key === "string" ? entry.key : "";
    if (!solid || !key || !obj.tree) return null;
    this.seq += 1;
    const id = `obj_${this.seq}`;
    (exported ? this.piecesOffPlate : this.objects).push({
      id,
      name: `${obj.name} part ${index}`,
      fileName: obj.fileName,
      bytes: new Uint8Array(),
      source: Float32Array.from(solid.positions),
      triangles: solid.positions.length / 9,
      orient: [...obj.orient] as Mat3,
      scale: obj.scale,
      centered: obj.centered,
      offset: { ...obj.offset },
      seatMm: obj.seatMm,
      stepTolerance: obj.stepTolerance,
      modelPose: { m: [...obj.modelPose.m] as Affine["m"], t: [...obj.modelPose.t] as Affine["t"] },
      workplane: { source: obj.workplane.source, origin: [...obj.workplane.origin] as Workplane["origin"], turn: [...obj.workplane.turn] as Workplane["turn"] },
      tree: newTree(key, { kind: "piece", tree: obj.tree.key, node, index }, `Part ${index}`, solid.fingerprint),
      solid,
      probes: new Map(),
      supportEdits: [],
      supportPaint: [],
      seamPaint: [],
      reinforcement: [],
      objectSettings: { ...obj.objectSettings },
      platedNode: null,
    });
    return id;
  }

  /** The object, on the plate or off it, whose tree is `key`; a reopened project's piece has none open yet, and goes by its id. */
  private objectOfKey(key: string): PlateObject | undefined {
    return this.byTreeKey(key) ?? [...this.objects, ...this.piecesOffPlate].find((row) => !row.tree && `mcp-${row.id}` === key);
  }

  /**
   * --- D9. A split to print's pieces are on the plate while that step is on the way to its part's current step, as a
   * join's tool is off it: model_undo or a goto above the cut takes them off, and a redo brings them back.
   */
  private followPieces(obj: PlateObject): { back: string[]; left: string[]; orient: { turned: string[]; notes: string[] } } {
    const tree = obj.tree;
    if (!tree) return { back: [], left: [], orient: { turned: [], notes: [] } };
    const path = new Set(pathTo(tree, tree.current));
    const wanted = new Map<string, boolean>();
    for (const node of tree.nodes.values()) {
      // An export target's pieces stay off the plate on every step (D12).
      const on = path.has(node.id) && !exportsPieces(node.op);
      for (const key of [...(node.pieces ?? []), node.pins ?? null]) if (key) wanted.set(key, wanted.get(key) === true || on);
    }
    const back: string[] = [];
    const left: string[] = [];
    for (const [key, on] of wanted) {
      const piece = this.objectOfKey(key);
      if (!piece) continue;
      const placed = this.objects.includes(piece);
      if (on && !placed) {
        this.piecesOffPlate.splice(this.piecesOffPlate.indexOf(piece), 1);
        this.objects.push(piece);
        back.push(piece.id);
      } else if (!on && placed) {
        this.objects.splice(this.objects.indexOf(piece), 1);
        this.piecesOffPlate.push(piece);
        if (this.selected === piece.id) this.selected = obj.id;
        left.push(piece.id);
      }
    }
    return { back, left, orient: this.settleOrients(obj) };
  }

  /** Each object Joint down turned, by id, and the orientation it had before: Keep, and a step above the cut, put it back. */
  private keptOrients = new Map<string, Mat3>();
  private jointed = new Set<string>();

  /**
   * --- Milestone 7 (plan D4, section 10). The plate orientation of a split to print's pieces from the cut on the way to
   * the part's step: a piece set to joint is turned so its larger cut face lies on the bed (`jointDown`, its long way
   * along X, or along the belt on a belt printer); every other piece, and the pins, keep the part's own orientation, which
   * is what a step above the cut gives back too. An export target's pieces keep as cut. Idempotent: the apply, an edit,
   * model_undo, a goto and a redo all end here. The ids it turned, and a sentence for each piece it jointed.
   */
  private settleOrients(obj: PlateObject): { turned: string[]; notes: string[] } {
    const out = { turned: [] as string[], notes: [] as string[] };
    const tree = obj.tree;
    if (!tree) return out;
    const path = new Set(pathTo(tree, tree.current));
    const live = [...path].reverse().find((id) => tree.nodes.get(id)?.op?.kind === "partition" && !exportsPieces(tree.nodes.get(id)?.op));
    const same = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]!) < 1e-12);
    const belt = this.printer().kind === "belt";
    const base = this.keptOrients.get(obj.id) ?? obj.orient;
    const parentTurned = this.keptOrients.has(obj.id);
    const turn = (row: PlateObject, orient: Mat3) => {
      if (same(row.orient, orient)) return;
      row.orient = [...orient] as Mat3;
      out.turned.push(row.id);
    };
    const settle = (row: PlateObject, op: PartitionModelOp | null, index: number | null, positions: Float32Array | null): void => {
      const choice = op && index !== null ? choiceAt(op.orient, index) : "keep";
      if (choice === "joint" && positions) {
        const joint = jointDown(positions, jointPlanes(op!.cuts), belt);
        if (joint) {
          if (row === obj && !this.keptOrients.has(obj.id)) this.keptOrients.set(obj.id, [...obj.orient] as Mat3);
          this.jointed.add(row.id);
          turn(row, joint.orient);
          out.notes.push(`Part ${index! + 1} is joint down on cut ${joint.face.cut + 1}, its ${joint.other ? "larger" : "only"} cut face, ${Math.round(joint.face.area * 100) / 100} mm².`);
          return;
        }
        out.notes.push(`Part ${index! + 1} has no cut face, so it keeps its orientation.`);
      }
      // Keep: the part's own orientation, for an object Joint down turned or a piece copied from a part that is turned.
      if (row === obj) {
        if (this.jointed.has(row.id)) {
          this.jointed.delete(row.id);
          this.keptOrients.delete(row.id);
          turn(row, base);
        }
        return;
      }
      if (this.jointed.has(row.id) || (parentTurned && same(row.orient, obj.orient))) {
        this.jointed.delete(row.id);
        turn(row, base);
      }
    };
    const livePart = live !== undefined && tree.current === live ? tree.nodes.get(live)?.op : null;
    settle(obj, livePart?.kind === "partition" ? livePart : null, 0, obj.solid ? Float32Array.from(obj.solid.positions) : null);
    for (const node of tree.nodes.values()) {
      if (node.op?.kind !== "partition") continue;
      const on = node.id === live;
      (node.pieces ?? []).forEach((key, at) => {
        const piece = key ? this.objectOfKey(key) : undefined;
        if (!piece) return;
        settle(piece, on ? node.op as PartitionModelOp : null, at + 1, on ? Float32Array.from(piece.solid?.positions ?? piece.source) : null);
      });
      const pins = node.pins ? this.objectOfKey(node.pins) : undefined;
      if (pins) settle(pins, null, null, null);
    }
    return out;
  }

  /**
   * --- D9. The pieces of an edited split to print, from the edit's reply. The plate object of each part number that is
   * still there takes the new piece, with its later steps replayed on it; a piece past the old count is a new object; an
   * old piece past the new count leaves the plate.
   */
  private async rebuildPieces(obj: PlateObject, old: readonly (string | null)[], reply: Record<string, unknown>, node: number, exported: boolean): Promise<{ keys: (string | null)[]; objects: string[]; notes: string[] }> {
    const listed = Array.isArray(reply.pieces) ? (reply.pieces as unknown[]) : [];
    const keys: (string | null)[] = [];
    const objects: string[] = [];
    const notes: string[] = [];
    for (const [at, entry] of listed.entries()) {
      if (!entry || typeof entry !== "object") {
        keys.push(null);
        continue;
      }
      const row = entry as Record<string, unknown>;
      const was = old[at] ? this.objectOfKey(old[at]!) : undefined;
      const id = was ? await this.replayPiece(obj, was, row, node, at + 2, notes) : this.partitionPiece(obj, row, node, at + 2, exported);
      keys.push(id ? String(row.key) : null);
      if (id) objects.push(id);
    }
    for (const key of old.slice(listed.length)) {
      const gone = key ? this.objectOfKey(key) : undefined;
      if (!gone) continue;
      if (this.objects.includes(gone)) this.objects.splice(this.objects.indexOf(gone), 1);
      this.piecesOffPlate = this.piecesOffPlate.filter((row) => row !== gone);
      if (this.selected === gone.id) this.selected = obj.id;
      await this.closeTree(gone);
    }
    return { keys, objects, notes };
  }

  /** --- Milestone 5. The edited cut's pins: the old pins object leaves, and the reply's pins, if any, are a new one. */
  private async rebuildPins(obj: PlateObject, old: string | null, reply: Record<string, unknown>, node: number, exported: boolean): Promise<{ id: string; key: string } | null> {
    const gone = old ? this.objectOfKey(old) : undefined;
    if (gone) {
      if (this.objects.includes(gone)) this.objects.splice(this.objects.indexOf(gone), 1);
      this.piecesOffPlate = this.piecesOffPlate.filter((row) => row !== gone);
      if (this.selected === gone.id) this.selected = obj.id;
      await this.closeTree(gone);
    }
    return reply.pins && typeof reply.pins === "object" ? this.partitionPins(obj, reply.pins as Record<string, unknown>, node, exported) : null;
  }

  /** `piece` takes part `index` of the edited cut as its new root, and the steps it had after its root are built again on it. */
  private async replayPiece(obj: PlateObject, piece: PlateObject, entry: Record<string, unknown>, node: number, index: number, notes: string[]): Promise<string | null> {
    const solid = rememberSolid(entry);
    const key = typeof entry.key === "string" ? entry.key : "";
    if (!solid || !key || !obj.tree) return null;
    const before = piece.tree;
    const later = before ? keptSteps(before) : [];
    if (before) await this.closeTree(piece);
    let tree = newTree(key, { kind: "piece", tree: obj.tree.key, node, index }, `Part ${index}`, solid.fingerprint);
    piece.solid = solid;
    piece.probes = new Map();
    piece.platedNode = null;
    if (before && later.length > 0) {
      const ids = later.map((_, at) => at + 1);
      const renamed = stepIds(later, ids);
      const ops = later.map((id) => renumberedSteps(before.nodes.get(id)!.op!, renamed));
      const replay = ops.slice(1).map((op, at) => ({ id: ids[at + 1]!, op }));
      let built: Record<string, unknown>;
      try {
        // D9: a later step that no longer builds is kept, broken, with the rest under it, the first one too.
        built = await this.treeCall({ ...editRequest(key, 0, ids[0]!, ops[0]!, replay, piece.stepTolerance || CHORD), keepBroken: true }, "edit", this.replayBudgetMs(ids.length));
      } catch (err) {
        if (!(err instanceof ModelRunaway)) throw err;
        built = { error: err.message };
      }
      if (typeof built.error === "string" && built.error) {
        notes.push(`${piece.name}'s later steps did not build on the new cut (${plainModelError(built.error)}), so it is the new piece as cut.`);
      } else {
        const made = readBuilt(built.built);
        const broken = readBroken(built.broken);
        const steps = ids.map((id, at) => ({
          id,
          op: made?.get(id)?.op ?? ops[at]!,
          fingerprint: made?.get(id)?.fingerprint ?? null,
          ...(before.nodes.get(later[at]!)?.name ? { name: before.nodes.get(later[at]!)!.name! } : {}),
          ...(broken?.id === id ? { broken: broken.error } : {}),
        }));
        const tip = [...ids].reverse().find((id) => made?.has(id)) ?? 0;
        tree = forked(tree, 0, steps, tip);
        const shown = rememberSolid(built);
        if (shown) piece.solid = shown;
        if (broken) notes.push(`${piece.name}'s step ${steps.findIndex((step) => step.id === broken.id) + 1} did not build on the new cut: ${plainModelError(broken.error)}`);
      }
    }
    piece.tree = tree;
    return piece.id;
  }

  /**
   * --- D8. A commit of the part puts its split-to-print pieces on the plate as they now stand: each piece on the way to
   * the part's step that the plate does not hold at its own step is committed too. With the cut's arrange on, the plate is
   * then laid out, as Arrange does.
   */
  private async commitPieces(obj: PlateObject): Promise<{ committed: string[]; refused: { object: string; reason: string }[]; arranged: boolean }> {
    const tree = obj.tree;
    const out = { committed: [] as string[], refused: [] as { object: string; reason: string }[], arranged: false };
    if (!tree) return out;
    const laid: string[] = [];
    for (const id of pathTo(tree, tree.current)) {
      const node = tree.nodes.get(id);
      if (node?.op?.kind !== "partition") continue;
      for (const key of [...(node.pieces ?? []), node.pins ?? null]) {
        const piece = key ? this.objectOfKey(key) : undefined;
        if (!piece || !this.objects.includes(piece) || !piece.tree || (piece.platedNode === piece.tree.current && piece.bytes.byteLength > 0)) continue;
        const reason = await this.commitObject(piece);
        if (reason) {
          out.refused.push({ object: piece.id, reason });
          continue;
        }
        out.committed.push(piece.id);
        if (node.op.arrange !== false) laid.push(piece.id);
      }
    }
    if (laid.length > 0) out.arranged = this.layOutPieces(laid);
    return out;
  }

  /**
   * --- D12. Every piece of the last split to print on the way to the part's step, in assembly order: the part itself,
   * then each piece's object as it stands now. An export target's pieces are not saved with a project, so one that no
   * object holds any more is cut again from the stored op on a spare step, as the app's `rebuildPiece` does.
   */
  private async partitionPieces(obj: PlateObject): Promise<{ pieces: PlateObject[]; op: PartitionModelOp; pins: PlateObject | null } | { reason: string }> {
    const tree = await this.opened(obj);
    if ("reason" in tree) return tree;
    const at = [...pathTo(tree, tree.current)].reverse().find((id) => tree.nodes.get(id)?.op?.kind === "partition");
    const node = at === undefined ? undefined : tree.nodes.get(at);
    if (!node || node.op?.kind !== "partition" || node.parent === null) return { reason: "This part has no split to print on the way to its step. pieces: true exports a split to print's pieces." };
    const op = node.op;
    const keys = [...(node.pieces ?? [])];
    const pieces: (PlateObject | null)[] = [];
    for (const key of keys) {
      const piece = key ? this.objectOfKey(key) : undefined;
      const opened = piece ? await this.opened(piece) : null;
      pieces.push(piece && opened && !("reason" in opened) && piece.solid ? piece : null);
    }
    const missing = pieces.findIndex((piece) => !piece);
    // A plate piece the user removed is not made again by an export, which would put it back on the plate.
    if (missing >= 0 && !exportsPieces(op)) return { reason: `Part ${missing + 2} of this cut is no longer on the plate. model_edit the cut to make it again.` };
    if (missing >= 0) {
      const [reserved, spare] = reserveId(tree);
      obj.tree = reserved;
      const fresh = pieces.map((piece, index) => (piece ? null : `mcp-part-${obj.id}-${node.id}-${index + 2}-r${spare}`));
      let reply: Record<string, unknown>;
      try {
        reply = await this.treeCall(applyRequest(tree.key, node.parent, spare, op, CHORD, null, fresh), "partition");
      } catch (err) {
        const lost = this.lostReply(err);
        if (lost) return { reason: String(lost.reason) };
        throw err;
      }
      await this.treeCall({ call: "drop", key: tree.key, node: spare }).catch(() => ({}));
      if (typeof reply.error === "string" && reply.error) return { reason: plainModelError(reply.error) };
      const listed = Array.isArray(reply.pieces) ? (reply.pieces as unknown[]) : [];
      if (listed.length !== keys.length) return { reason: "This cut no longer makes the pieces its step names. Edit it with model_edit." };
      for (const [index, key] of fresh.entries()) {
        const entry = listed[index];
        if (!key || !entry || typeof entry !== "object") continue;
        const id = this.partitionPiece(obj, entry as Record<string, unknown>, node.id, index + 2, true);
        const made = id ? this.objectOfKey(key) : undefined;
        if (!made) return { reason: `Part ${index + 2} could not be cut again.` };
        pieces[index] = made;
        keys[index] = key;
      }
      obj.tree = withNode(obj.tree ?? tree, node.id, { pieces: keys });
    }
    if (!obj.solid) return { reason: "This solid could not be read." };
    // --- Milestone 5. The pins, when the cut has dowels, export as one more part after the last piece.
    let pins: PlateObject | null = null;
    if (node.pins) {
      const held = this.objectOfKey(node.pins);
      const opened = held ? await this.opened(held) : null;
      if (held && opened && !("reason" in opened) && held.solid) pins = held;
      else if (exportsPieces(op)) {
        const [reserved, spare] = reserveId(obj.tree ?? tree);
        obj.tree = reserved;
        const key = `mcp-pins-${obj.id}-${node.id}-r${spare}`;
        let reply: Record<string, unknown>;
        try {
          reply = await this.treeCall(applyRequest(tree.key, node.parent, spare, op, CHORD, null, undefined, key), "partition");
        } catch (err) {
          const lost = this.lostReply(err);
          if (lost) return { reason: String(lost.reason) };
          throw err;
        }
        await this.treeCall({ call: "drop", key: tree.key, node: spare }).catch(() => ({}));
        if (typeof reply.error === "string" && reply.error) return { reason: plainModelError(reply.error) };
        const made = reply.pins && typeof reply.pins === "object" ? this.partitionPins(obj, reply.pins as Record<string, unknown>, node.id, true) : null;
        pins = made ? (this.objectOfKey(made.key) ?? null) : null;
        if (!pins) return { reason: "This cut's pins could not be cut again." };
        obj.tree = withNode(obj.tree ?? tree, node.id, { pins: made!.key });
      } else return { reason: "This cut's pins are no longer on the plate. model_edit the cut to make them again." };
    }
    return { pieces: [obj, ...(pieces as PlateObject[])], op, pins };
  }

  /** --- D12. export_3mf with pieces: true. One 3MF of every piece, named `<name>-<n>`, or with stl: true one STL each. */
  private async exportPieceMeshes(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const requested = typeof input.object === "string" ? input.object : "";
    const obj = this.find(requested !== "" ? requested : this.selected) ?? this.piecesOffPlate.find((row) => row.id === requested) ?? null;
    if (!obj) return { ok: false, reason: UNKNOWN_OBJECT };
    const got = await this.partitionPieces(obj);
    if ("reason" in got) return { ok: false, reason: got.reason };
    const name = String(input.name);
    const parts = got.pins ? [...got.pieces, got.pins] : got.pieces;
    const names = pieceNames(name, got.pieces.length, !!got.pins);
    const folder = name.slice(0, Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
    const meshes = parts.map((piece) => featureSolidInModel(piece.solid!, piece.modelPose).positions);
    const rows = this.pieceRows(parts, names);
    if (input.stl === true) {
      const files = meshes.map((mesh, index) => {
        const path = resolveWrite(`${folder}${names[index]}`, ".stl");
        const bytes = stlBytes(Float32Array.from(mesh), `${names[index]}.stl`);
        writeFileSync(path, bytes);
        return { path, bytes: bytes.byteLength };
      });
      return { ok: true, files, parts: got.pieces.length, pieces: rows, note: SUPPORT_NOTE };
    }
    const bytes = encode3mf(meshes.map((mesh) => Float32Array.from(mesh)), names);
    const path = resolveWrite(name, ".3mf");
    writeFileSync(path, bytes);
    return { ok: true, path, bytes: bytes.byteLength, parts: got.pieces.length, pieces: rows, note: SUPPORT_NOTE };
  }

  /** --- D12. model_export_step with pieces: true. One STEP file holding every piece as a named solid, in order. */
  private async exportPieceStep(obj: PlateObject, name: string): Promise<Record<string, unknown>> {
    const got = await this.partitionPieces(obj);
    if ("reason" in got) return { ok: false, reason: got.reason };
    const parts = got.pins ? [...got.pieces, got.pins] : got.pieces;
    const names = pieceNames(name, got.pieces.length, !!got.pins);
    const [first, ...rest] = parts.map((piece) => piece.tree!);
    let reply: Record<string, unknown>;
    try {
      reply = await this.treeCall(exportRequest(first!.key, first!.current, "step", rest.map((tree) => ({ key: tree.key, node: tree.current })), names), "export");
    } catch (err) {
      const lost = this.lostReply(err);
      if (lost) return lost;
      throw err;
    }
    const step = this.stepBytes(reply);
    if (!step) return { ok: false, reason: typeof reply.error === "string" ? plainModelError(reply.error) : "The pieces were not exported." };
    const path = resolveWrite(name, ".step");
    writeFileSync(path, step);
    return {
      ok: true,
      path,
      bytes: step.byteLength,
      parts: got.pieces.length,
      solids: typeof reply.solids === "number" ? reply.solids : parts.length,
      pieces: this.pieceRows(parts, names),
      names: "The STEP file holds the pieces as separate named solids in this order, named as in the 3MF and the STL files.",
      note: SUPPORT_NOTE,
    };
  }

  private pieceRows(pieces: readonly PlateObject[], names: readonly string[]): { part: number; name: string; object: string; volumeMm3: number }[] {
    return pieces.map((piece, index) => ({ part: index + 1, name: names[index]!, object: piece.id, volumeMm3: Math.round((piece.solid?.volumeMm3 ?? 0) * 1000) / 1000 }));
  }

  /**
   * --- Plan section 10. Lay out places only the new pieces, around what is already on the plate, the part's own first
   * piece included, which all stay where they are; Arrange would move every object.
   */
  private layOutPieces(ids: readonly string[]): boolean {
    const printer = this.printer();
    const fresh = new Set(ids);
    const keep = new Set(this.objects.filter((row) => !fresh.has(row.id)).map((row) => row.id));
    const clearance = sequentialClearance(this.sliceRules(this.objects.length), this.order());
    const gap = clearance === null ? ARRANGE_GAP_MM : clearance + 0.01;
    // A belt printer's length is unbounded (decision 11): the pieces stack along it, so none goes off the bed.
    const arranged = arrangedObjects(this.objects.map((obj) => this.asBed(obj)), printer.bedX, printer.kind === "belt" ? 1e6 : printer.bedY, gap, keep);
    for (const row of arranged) {
      const live = fresh.has(row.id) ? this.find(row.id) : undefined;
      if (!live) continue;
      live.centered = row.centered;
      live.offset = { ...row.offset };
    }
    return true;
  }

  // --- end Split to print ---

  private async history(obj: PlateObject, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const opened = obj.tree ?? await this.opened(obj);
    if ("reason" in opened) return { ok: false, reason: opened.reason };
    const tree = opened;
    const rows = [...tree.nodes.values()].sort((a, b) => a.id - b.id).map((node) => ({
      id: nodeHandle(node.id),
      parent: node.parent === null ? null : nodeHandle(node.parent),
      label: node.label,
      current: node.id === tree.current,
      committed: node.id === tree.committed,
      broken: node.broken ?? false,
    }));
    const listed = page(rows, input.cursor, input.limit);
    return { ok: true, nodes: listed.rows, ...(listed.nextCursor ? { nextCursor: listed.nextCursor } : {}) };
  }

  private async gotoNode(obj: PlateObject, node: number | null): Promise<Record<string, unknown>> {
    const tree = await this.opened(obj);
    if ("reason" in tree) return { ok: false, reason: tree.reason };
    if (node === null || !tree.nodes.has(node)) return { ok: false, reason: "That step is not in the history." };
    // --- 3.1 F9. A goto replays from the nearest solid the engine still holds, which can be a whole group of hundreds
    // of booleans: it gets two seconds a step on the way, not one call's limit, and a modeler past even that is a reply.
    let reply: Record<string, unknown>;
    try {
      reply = await this.treeCall(gotoRequest(tree.key, node, CHORD), "edit", this.replayBudgetMs(this.stepsTo(tree, node)));
    } catch (err) {
      const lost = this.lostReply(err);
      if (lost) return lost;
      throw err;
    }
    if (typeof reply.error === "string" && reply.error) return { ok: false, reason: plainModelError(reply.error) };
    obj.tree = jumped(tree, node);
    const solid = rememberSolid(reply);
    if (solid) obj.solid = solid;
    const tools = await this.followJoins(obj);
    const pieces = this.followPieces(obj);
    return {
      ok: true,
      node: nodeHandle(node),
      ...(tools.back.length ? { toolsBack: tools.back } : {}),
      ...(tools.left.length ? { toolsLeftPlate: tools.left } : {}),
      ...(pieces.back.length ? { piecesBack: pieces.back } : {}),
      ...(pieces.left.length ? { piecesLeftPlate: pieces.left } : {}),
    };
  }

  private async step(obj: PlateObject, direction: "undo" | "redo"): Promise<Record<string, unknown>> {
    const tree = await this.opened(obj);
    if ("reason" in tree) return { ok: false, reason: tree.reason };
    const group = direction === "undo"
      ? obj.groups?.find((row) => row.end === tree.current && tree.nodes.has(row.start))
      : obj.undoneGroup && obj.undoneGroup.start === tree.current && tree.nodes.has(obj.undoneGroup.end) ? obj.undoneGroup : undefined;
    if (group) {
      const moved = await this.gotoNode(obj, direction === "undo" ? group.start : group.end);
      obj.undoneGroup = direction === "undo" && moved.ok === true ? group : undefined;
      return moved.ok === true ? { ...moved, group: group.label } : moved;
    }
    const target = direction === "undo" ? undoTarget(tree) : redoTarget(tree);
    if (target === null) return { ok: false, reason: direction === "undo" ? "This is the start of the history." : "There is nothing to redo." };
    obj.undoneGroup = undefined;
    return this.gotoNode(obj, target);
  }

  private async editRoot(obj: PlateObject, tree: ModelTree, node: number, raw: unknown, exprs?: Record<string, string>): Promise<Record<string, unknown>> {
    const refusal = editRefusal(tree, node);
    if (refusal) return { ok: false, reason: refusal };
    const baked = this.bake(obj, raw);
    if ("reason" in baked) return { ok: false, reason: baked.reason };
    // --- K2 feature root. Reopen from the baked extrude, revolve, or loft. A probe on the solid is not a preview of replacing it, so the engine's open is the check. ---
    if (tree.root.kind === "feature") {
      const op = baked.op;
      if (op.kind !== "extrude" && op.kind !== "revolve" && op.kind !== "loft") {
        return { ok: false, reason: "This solid started from a sketch. Replace it with an extrude, a revolve, or a loft." };
      }
      if (op.op !== "fuse") {
        const noun = op.kind === "extrude" ? "extrude" : op.kind === "revolve" ? "revolve" : "loft";
        return { ok: false, reason: `A new solid is the ${noun} itself. Cut and intersect need a part that is already there.` };
      }
      const root = { kind: "feature" as const, op };
      const reply = await this.treeCall(openRequest(tree.key, root, CHORD), "root");
      if (typeof reply.error === "string" && reply.error) return { ok: false, reason: plainModelError(reply.error, "create") };
      const next = rememberSolid(reply);
      const nodes = new Map(tree.nodes);
      const row = nodes.get(0);
      if (row) nodes.set(0, { ...row, label: rootLabel(root, row.label), ...(next ? { fingerprint: next.fingerprint } : {}) });
      obj.tree = { ...tree, root, nodes };
      if (next) obj.solid = next;
      obj.probes.clear();
      return { ok: true, node: nodeHandle(node), stored: op, typed: baked.typed };
    }
    if (baked.op.kind !== "root" || tree.root.kind !== "primitive") return { ok: false, reason: "The new solid's first step takes a root edit." };
    if (!obj.probes.has(probeKey(String(node), baked.op))) return { ok: false, reason: "Probe this edit first. It was not applied." };
    const { kind: _kind, exprs: _exprs, ...solid } = baked.op;
    const root = { kind: "primitive" as const, solid };
    const reply = await this.treeCall(openRequest(tree.key, root, CHORD), "root");
    if (typeof reply.error === "string" && reply.error) return { ok: false, reason: plainModelError(reply.error, "create") };
    // --- D25. The new sizes keep the expressions this call typed; typed numbers drop the old ones.
    obj.tree = { ...tree, root: exprs ? { ...root, exprs } : root };
    const next = rememberSolid(reply);
    if (next) obj.solid = next;
    obj.probes.clear();
    return { ok: true, node: nodeHandle(node), stored: baked.op, typed: baked.typed };
  }

  private rename(obj: PlateObject, node: number | null, label: string): Record<string, unknown> {
    const tree = obj.tree;
    if (!tree || node === null || !tree.nodes.has(node)) return { ok: false, reason: "That step is not in the history." };
    const trimmed = label.trim();
    if (!trimmed) return { ok: false, reason: "The step needs a name." };
    const row = tree.nodes.get(node);
    if (!row) return { ok: false, reason: "That step is not in the history." };
    row.label = trimmed.slice(0, 80);
    return { ok: true, node: nodeHandle(node), label: row.label };
  }

  private async edit(obj: PlateObject, node: number | null, raw: unknown): Promise<Record<string, unknown>> {
    const exprs = this.pendingExprs[0];
    this.pendingExprs = [];
    const toolReason = await this.openJoinTool(raw);
    if (toolReason) return { ok: false, reason: toolReason };
    const tree = await this.opened(obj);
    if ("reason" in tree) return { ok: false, reason: tree.reason };
    if (node === null || !tree.nodes.has(node)) return { ok: false, reason: "That step is not in the history." };
    const parent = tree.nodes.get(node)?.parent;
    if (parent === null || parent === undefined) return this.editRoot(obj, tree, node, raw, exprs);
    const baked = this.bake(obj, raw);
    if ("reason" in baked) return { ok: false, reason: baked.reason };
    const probed = [parent, node, tree.current].some((id) => obj.probes.has(probeKey(String(id), baked.op)));
    if (!probed) return { ok: false, reason: "Probe this edit first. It was not applied." };
    if (baked.op.kind === "split") {
      const note = this.splitCheck(obj, baked.op);
      if (note.bad) return { ok: false, reason: note.text };
    } else if (baked.op.kind === "partition") {
      const checked = await this.treeCall(probeRequest(tree.key, parent, baked.op));
      if (checked.ok !== true) return { ok: false, reason: plainModelError(typeof checked.error === "string" ? checked.error : "This does not fit.") };
    } else if (baked.op.kind !== "scale") {
      const tool = (baked.op.kind === "join" ? "boolean" : baked.op.kind) as ProbedTool;
      const checked = await this.treeCall(probeRequest(tree.key, parent, baked.op));
      const view = probeFromBody(checked);
      const fit = probeNote(tool, view);
      if (!fit || fit.bad) return { ok: false, reason: fit?.text ?? "This does not fit." };
    }
    const replayIds = replayChain(tree, node, tree.current);
    const replayOps = replayIds.map((id) => tree.nodes.get(id)?.op).filter((op): op is ModelOp => op != null);
    // A split to print is always cut again: an earlier branch's pieces went to the edit that replaced it (D9).
    const twin = baked.op.kind === "partition" ? null : builtBranch(tree, parent, baked.op, replayOps);
    if (twin != null) return this.gotoNode(obj, twin);
    const joins = this.toolLinks(tree, [node, ...replayIds]);
    const levels = crossEdit(tree, joins, node, baked.op, replayIds, (key, need) => this.reserveOn(key, need));
    const own = levels[levels.length - 1];
    if (!own) return { ok: false, reason: "That step could not be rebuilt." };
    // --- 3.1 F9. An edit replays every step after the one edited, and the tools its joins take: a budget for all of them.
    const replayed = levels.reduce((sum, level) => sum + 1 + level.replay.reduce((inner, step) => inner + 1 + (step.op.kind === "group" ? step.op.steps.length : 0), 0), 0);
    // --- Split to print (D9): the edited cut makes its pieces again in the same call.
    const pieceKeys = baked.op.kind === "partition" ? this.pieceKeys(obj, own.node, baked.op) : undefined;
    const pinsKey = baked.op.kind === "partition" ? this.pinsKey(obj, own.node, baked.op) : null;
    let reply: Record<string, unknown>;
    try {
      reply = await this.treeCall(crossEditRequest(levels, obj.stepTolerance || CHORD, pieceKeys, pinsKey), "edit", this.replayBudgetMs(replayed));
    } catch (err) {
      const lost = this.lostReply(err);
      if (lost) return lost;
      throw err;
    }
    if (typeof reply.error === "string" && reply.error) return { ok: false, reason: plainModelError(reply.error) };
    const built = readBuilt(reply.built);
    const broken = readBroken(reply.broken);
    const ids = [own.node, ...own.replay.map((step) => step.id)];
    const steps: ForkStep[] = ids.map((id, index) => {
      const made = built?.get(id);
      // --- D25. The engine's echo has no sketch and no expressions: each step keeps its own, and the edited step the
      // expressions this call typed.
      const source = index === 0 ? withExprs(own.op, exprs) : own.replay[index - 1]!.op;
      // A split to print replayed under this edit keeps the parts its older cut made, as a split's piece stays.
      const older = index === 0 ? undefined : tree.nodes.get(replayIds[index - 1]!)?.pieces;
      return {
        id,
        op: made ? keepSketch(made.op, source) : source,
        fingerprint: made?.fingerprint ?? null,
        ...(broken?.id === id ? { broken: broken.error } : {}),
        ...(older ? { pieces: older } : {}),
      };
    });
    const rebuilt = pieceKeys ? await this.rebuildPieces(obj, tree.nodes.get(node)?.pieces ?? [], reply, own.node, exportsPieces(baked.op)) : null;
    // --- Milestone 5. The pins are made again with the pieces: the old object goes, the new one joins (D9).
    const pins = pieceKeys ? await this.rebuildPins(obj, tree.nodes.get(node)?.pins ?? null, reply, own.node, exportsPieces(baked.op)) : null;
    if (rebuilt) steps[0] = { ...steps[0]!, pieces: rebuilt.keys, ...(pins ? { pins: pins.key } : {}) };
    const tip = [...steps].reverse().find((step) => !step.broken)?.id ?? ids[0]!;
    const host = obj.tree ?? tree;
    obj.tree = forked(host, own.parent, steps, tip);
    this.forkTools(levels.slice(0, -1), reply.tools);
    const solid = rememberSolid(reply);
    if (solid) obj.solid = solid;
    obj.probes.clear();
    const followed = this.followPieces(obj);
    if (followed.orient.turned.length > 0 && (baked.op as PartitionModelOp).arrange !== false) this.layOutPieces(followed.orient.turned.filter((id) => this.objects.some((row) => row.id === id && row.platedNode !== null)));
    const notes = rebuilt ? [...(baked.notes ?? []), ...numberNotes(reply), ...rebuilt.notes, ...followed.orient.notes] : [];
    const parts = rebuilt ? { parts: rebuilt.keys.length + 1, pieces: rebuilt.objects, ...(pins ? { pins: pins.id } : {}), ...joined(reply, obj.modelPose), ...numbered(reply, obj.modelPose), ...(notes.length ? { notes } : {}) } : {};
    return { ok: true, node: nodeHandle(tip), built: broken == null, broken: broken != null, ...parts };
  }

  /** Fresh ids on the tree `key` names. An edit spends them even when the engine keeps only some. */
  private reserveOn(key: string, need: number): NodeId[] {
    const host = this.byTreeKey(key);
    if (!host?.tree) return [];
    let reserved = host.tree;
    const ids: NodeId[] = [];
    while (ids.length < need) {
      const [next, id] = reserveId(reserved);
      reserved = next;
      ids.push(id);
    }
    host.tree = reserved;
    return ids;
  }

  private toolLinks(tree: ModelTree, ids: readonly NodeId[]): ToolLink[] {
    const links: ToolLink[] = [];
    for (const id of ids) {
      const op = tree.nodes.get(id)?.op;
      if (op?.kind !== "join") continue;
      const tool = this.byTreeKey(op.tool.key);
      if (!tool?.tree) continue;
      links.push({ tree: tool.tree, id: op.tool.node, op });
    }
    return links;
  }

  /** A join's tool trees take the branches the edit reply kept. */
  private forkTools(levels: { key: string; parent: NodeId; node: NodeId; op: ModelOp; replay: { id: NodeId; op: ModelOp }[] }[], tools: unknown): void {
    const parts = Array.isArray(tools) ? tools as { built?: unknown; broken?: unknown }[] : [];
    levels.forEach((level, index) => {
      const host = this.byTreeKey(level.key);
      if (!host?.tree) return;
      const made = readBuilt(parts[index]?.built);
      const broken = readBroken(parts[index]?.broken);
      const ids = [level.node, ...level.replay.map((step) => step.id)];
      const steps = ids.map((id, step) => {
        const source = step === 0 ? level.op : level.replay[step - 1]!.op;
        const echo = made?.get(id)?.op;
        return {
        id,
        op: echo ? keepSketch(echo, source) : source,
        fingerprint: made?.get(id)?.fingerprint ?? null,
        ...(broken?.id === id ? { broken: broken.error } : {}),
        };
      });
      const tip = [...steps].reverse().find((step) => !step.broken)?.id ?? ids[0]!;
      host.tree = forked(host.tree, level.parent, steps, tip, false);
    });
  }

  private drop(obj: PlateObject, node: number | null): Record<string, unknown> {
    const tree = obj.tree;
    if (!tree || node === null) return { ok: false, reason: "That step is not in the history." };
    const reason = dropRefusal(tree, node);
    if (reason) return { ok: false, reason };
    const next = dropped(tree, node);
    if (!next) return { ok: false, reason: "That step stays." };
    obj.tree = next;
    return { ok: true };
  }

  private async commit(obj: PlateObject): Promise<Record<string, unknown>> {
    const blocked = this.meshBlock(obj);
    if (blocked) return { ok: false, reason: blocked };
    const reason = await this.commitObject(obj);
    if (reason) return { ok: false, reason };
    const pieces = await this.commitPieces(obj);
    return {
      ok: true,
      scalePercent: obj.scale * 100,
      triangles: obj.triangles,
      ...(obj.commitWarning ? { warning: obj.commitWarning } : {}),
      ...(pieces.committed.length ? { pieces: pieces.committed } : {}),
      ...(pieces.refused.length ? { piecesRefused: pieces.refused } : {}),
      ...(pieces.arranged ? { arranged: true } : {}),
    };
  }

  /** The plate mesh becomes the solid on screen. A second commit of the same node does not export again. */
  private async commitObject(obj: PlateObject): Promise<string | null> {
    if (!obj.tree) return null;
    // --- Split to print (D12). A part cut for an export target is exported, and the plate keeps what it had.
    const exported = this.exportCut(obj);
    if (exported) return exportedCommit(shownName(obj.name), this.targetName(exported));
    // A history the modeler lost in a restart is built again before its export.
    let tree: ModelTree;
    try {
      const opened = await this.opened(obj);
      if ("reason" in opened) return opened.reason;
      tree = opened;
    } catch (err) {
      if (err instanceof ProtocolError || err instanceof ModelRunaway) return err.message;
      throw err;
    }
    if (!obj.solid || obj.solid.positions.length < 9) return null;
    await this.brepRoot(obj, tree);
    if (obj.platedNode === tree.current && obj.bytes.byteLength > 0) {
      // A project saved before version 3 keeps the plate's step as STEP: the step is written again as the engine's own
      // solid, which the next open builds from at once. A step that will not write keeps its STEP.
      // Once per solid: an engine that cannot write the binary format keeps the STEP, and is not asked again.
      if (obj.brep && !isBrep(obj.brep) && !this.legacySolids.has(obj.brep)) {
        this.legacySolids.add(obj.brep);
        const reply = await this.treeCall(exportRequest(tree.key, tree.current, "brep"), "export").catch(() => ({}));
        const solid = this.stepBytes(reply);
        if (solid && isBrep(solid)) obj.brep = solid;
      }
      return null;
    }
    // The plate mesh should close: cracks where two faces sample a shared edge apart are mended. What stays open is
    // refused when the edits opened it (the plate's mesh before them closed); a part that came in open, such as a STEP
    // whose kernel mesh never closed but sliced, still commits, with a warning.
    const mended = closeCracks(obj.solid.positions);
    const closed = edgeReport(mended, 1);
    obj.commitWarning = undefined;
    if (closed.open > 0 || closed.nonManifold > 0) {
      const why = notClosedReason(closed);
      const before = obj.bytes.byteLength > 0 && obj.source.length >= 9 ? edgeReport(closeCracks(obj.source), 0) : null;
      const cameOpen = before !== null && (before.open > 0 || before.nonManifold > 0);
      if (!cameOpen) return why;
      obj.commitWarning = `${why.replace(" It was not put on the plate, because the slicer would have to guess at the gaps.", "")} The part's mesh was open before these edits too, so it was committed as it is.`;
    }
    const from = obj.platedNode;
    let reply: Record<string, unknown>;
    try {
      reply = await this.treeCall(exportRequest(tree.key, tree.current, "brep"), "export");
    } catch (err) {
      if (err instanceof ModelRunaway) return err.message;
      throw err;
    }
    const step = this.stepBytes(reply);
    if (!step) return typeof reply.error === "string" ? plainModelError(reply.error) : "The solid was not exported.";
    const copy = mended;
    obj.seatMm = settleBy(copy);
    obj.source = copy;
    obj.triangles = copy.length / 9;
    obj.fileName = stlFileName(obj.fileName);
    obj.bytes = stlBytes(copy, obj.fileName);
    obj.brep = step;
    if (this.scaleSince(tree, from, tree.current)) obj.scale = 1;
    obj.platedNode = tree.current;
    obj.tree = { ...obj.tree!, committed: tree.current };
    return null;
  }

  /**
   * An imported STEP root, written once as the engine's own solid of it, as the app saves it: a reopen that needs the root
   * reads that in a fraction of the STEP's time. A root that is still the plate's file stays STEP, kept once for both.
   */
  private async brepRoot(obj: PlateObject, tree: ModelTree): Promise<void> {
    const root = tree.root;
    if (root.kind !== "step" || isBrep(root.bytes) || this.triedRoots.has(root.bytes)) return;
    const bytes = new Uint8Array(root.bytes);
    if (this.objects.some((other) => other.bytes.byteLength === bytes.byteLength && meshKeyHex(other.bytes) === meshKeyHex(bytes))) return;
    this.triedRoots.add(root.bytes);
    const reply = await this.treeCall(exportRequest(tree.key, 0, "brep"), "export").catch(() => ({}));
    const solid = this.stepBytes(reply);
    if (!solid || !isBrep(solid) || obj.tree !== tree) return;
    obj.tree = { ...tree, root: { ...root, bytes: solid.buffer.slice(solid.byteOffset, solid.byteOffset + solid.byteLength) as ArrayBuffer } };
  }

  /** True when a scale step sits strictly after `from` on the way to `to`. */
  private scaleSince(tree: ModelTree, from: number | null, to: number): boolean {
    for (let at: number | null = to; at !== null && at !== from; at = tree.nodes.get(at)?.parent ?? null) {
      if (tree.nodes.get(at)?.op?.kind === "scale") return true;
    }
    return false;
  }

  /** Every object's current step onto the plate. One that will not commit is named with its reason; the rest still commit. */
  private async commitAll(): Promise<{ object: string; name: string; reason: string }[]> {
    const refused: { object: string; name: string; reason: string }[] = [];
    for (const obj of this.objects) {
      const reason = await this.commitObject(obj);
      if (reason) refused.push({ object: obj.id, name: shownName(obj.name), reason });
    }
    return refused;
  }

  /**
   * A plate object with no plate mesh yet, a solid never committed, carries its kernel mesh in a saved file, so the file
   * opens: an autosave commits nothing, and a save keeps an object whose mesh would not close as it stands.
   */
  private withKernelMeshes(doc: LimeProject): LimeProject {
    const unplated = new Map(this.objects.filter((obj) => obj.bytes.byteLength === 0 && obj.solid && obj.solid.positions.length >= 9).map((obj) => [obj.id, obj]));
    if (unplated.size > 0 && doc.objects) {
      doc.objects = doc.objects.map((row) => {
        const obj = row.id ? unplated.get(row.id) : undefined;
        if (!obj?.solid) return row;
        const name = stlFileName(obj.fileName);
        return { ...row, mesh: meshRecord(name, stlBytes(Float32Array.from(obj.solid.positions), name)) };
      });
    }
    return doc;
  }

  private async exportStep(obj: PlateObject, name: string): Promise<Record<string, unknown>> {
    const tree = await this.opened(obj);
    if ("reason" in tree) return { ok: false, reason: tree.reason };
    let reply: Record<string, unknown>;
    try {
      reply = await this.treeCall(exportRequest(tree.key, tree.current, "step"), "export");
    } catch (err) {
      const lost = this.lostReply(err);
      if (lost) return lost;
      throw err;
    }
    const step = this.stepBytes(reply);
    if (!step) return { ok: false, reason: typeof reply.error === "string" ? plainModelError(reply.error) : "The solid was not exported." };
    const path = resolveWrite(name, ".step");
    writeFileSync(path, step);
    return { ok: true, path, bytes: step.byteLength };
  }

  private async measure(obj: PlateObject, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (typeof input.faceA === "number" || typeof input.faceB === "number") {
      if (typeof input.faceA !== "number" || typeof input.faceB !== "number") return { ok: false, reason: "Name both faces." };
      const tree = await this.opened(obj);
      if ("reason" in tree) return { ok: false, reason: tree.reason };
      const solid = obj.solid;
      if (!solid) return { ok: false, reason: "This solid could not be read." };
      if (!solid.faces[input.faceA] || !solid.faces[input.faceB]) return { ok: false, reason: "That face is not on this solid." };
      let reply: Record<string, unknown>;
      try {
        reply = await this.treeCall({
          call: "distance",
          key: tree.key,
          node: tree.current,
          aKind: "face",
          aIndex: input.faceA,
          bKind: "face",
          bIndex: input.faceB,
        }, "measure");
      } catch (err) {
        const lost = this.lostReply(err);
        if (lost) return lost;
        throw err;
      }
      if (typeof reply.distanceMm !== "number") return { ok: false, reason: "Could not measure that distance." };
      return { ok: true, distanceMm: reply.distanceMm, frame: "model" };
    }
    const a = input.a;
    const b = input.b;
    if (!Array.isArray(a) || !Array.isArray(b) || a.length < 3 || b.length < 3) {
      return { ok: false, reason: "Name two points, or two faces from the solid." };
    }
    const frame = input.frame === "workplane" ? "workplane" : "model";
    const plane = this.typedPlane(obj);
    const left = frame === "workplane" ? localPoint(plane, a as [number, number, number]) : a as [number, number, number];
    const right = frame === "workplane" ? localPoint(plane, b as [number, number, number]) : b as [number, number, number];
    return this.span(left, right, frame);
  }

  private span(left: [number, number, number], right: [number, number, number], frame: string): Record<string, unknown> {
    const dx = right[0] - left[0];
    const dy = right[1] - left[1];
    const dz = right[2] - left[2];
    return { ok: true, distanceMm: Math.hypot(dx, dy, dz), dx, dy, dz, frame };
  }

  private wanted(input: Record<string, unknown>): PlateObject | { ok: false; reason: string } {
    if (typeof input.object === "string" && input.object !== "") {
      const named = this.find(input.object);
      if (!named) return { ok: false, reason: UNKNOWN_OBJECT };
      return named;
    }
    const obj = this.selectedObject();
    if (!obj) return { ok: false, reason: "Load a mesh first." };
    return obj;
  }

  private readRegion(value: unknown): RegionQuery | { reason: string } {
    if (!value || typeof value !== "object" || Array.isArray(value)) return { reason: "Name a face, an overhang, a box, a sphere, or a stroke." };
    const row = value as Record<string, unknown>;
    const region: RegionQuery = {};
    if (Array.isArray(row.faces)) region.faces = row.faces.filter((item): item is number => typeof item === "number" && Number.isInteger(item));
    if (typeof row.overhangBelowDeg === "number") region.overhangBelowDeg = row.overhangBelowDeg;
    if (Array.isArray(row.zRangeMm) && row.zRangeMm.length >= 2 && typeof row.zRangeMm[0] === "number" && typeof row.zRangeMm[1] === "number") {
      region.zRangeMm = [row.zRangeMm[0], row.zRangeMm[1]];
    }
    if (row.box && typeof row.box === "object") {
      const box = row.box as { min?: unknown; max?: unknown };
      const min = readVec3(box.min, [Number.NaN, Number.NaN, Number.NaN]);
      const max = readVec3(box.max, [Number.NaN, Number.NaN, Number.NaN]);
      if (min.some((item) => !Number.isFinite(item)) || max.some((item) => !Number.isFinite(item))) return { reason: "A box needs min and max, in millimetres." };
      region.box = { min, max };
    }
    if (row.sphere && typeof row.sphere === "object") {
      const sphere = row.sphere as { centre?: unknown; radiusMm?: unknown };
      const centre = readVec3(sphere.centre, [Number.NaN, Number.NaN, Number.NaN]);
      if (centre.some((item) => !Number.isFinite(item)) || typeof sphere.radiusMm !== "number" || !(sphere.radiusMm > 0)) {
        return { reason: "A sphere needs a centre and a radius, in millimetres." };
      }
      region.sphere = { centre, radiusMm: sphere.radiusMm };
    }
    if (row.stroke && typeof row.stroke === "object") {
      const stroke = row.stroke as { points?: unknown; radiusMm?: unknown };
      const points = Array.isArray(stroke.points) ? stroke.points.map((point) => readVec3(point, [Number.NaN, Number.NaN, Number.NaN])) : [];
      if (points.length < 2 || points.some((point) => point.some((item) => !Number.isFinite(item))) || typeof stroke.radiusMm !== "number") {
        return { reason: "A stroke needs points and a radius, in millimetres." };
      }
      region.stroke = { points, radiusMm: stroke.radiusMm };
    }
    return region;
  }

  private paintFrame(input: Record<string, unknown>): "part" | "bed" | { reason: string } {
    if (input.frame === undefined || input.frame === "part" || input.frame === "bed") return input.frame === "bed" ? "bed" : "part";
    return { reason: "Paint on the part or the bed. The workplane is for model edits." };
  }

  private paintPositions(obj: PlateObject, frame: "part" | "bed"): Float32Array {
    return frame === "bed" ? this.placed(obj).positions : obj.source;
  }

  private sourceDisks(obj: PlateObject, disks: { p: [number, number, number]; n: [number, number, number]; r: number }[], kind: PaintKind, frame: "part" | "bed"): PaintDisk[] {
    if (frame === "bed") {
      const placed = this.placed(obj);
      const src = sourceFrame(obj.source, obj.scale);
      return disks.map((disk) => diskFromHit(kind, disk.p, disk.n, disk.r, placed.pose, src));
    }
    const scale = obj.scale || 1;
    return disks.map((disk) => ({ kind, p: disk.p, n: disk.n, r: disk.r / scale }));
  }

  private pointInFrame(obj: PlateObject, point: [number, number, number], frame: "part" | "bed"): [number, number, number] {
    if (frame === "part") return point;
    const pose: RigidPose = this.placed(obj).pose;
    const centre = sourceFrame(obj.source, obj.scale).centre;
    const scale = obj.scale || 1;
    const mesh = [
      (point[0] - centre[0]) * scale + centre[0] - pose.pivot[0],
      (point[1] - centre[1]) * scale + centre[1] - pose.pivot[1],
      (point[2] - centre[2]) * scale + centre[2] - pose.pivot[2],
    ];
    const rotation = pose.rotation;
    return [
      rotation[0] * mesh[0]! + rotation[1] * mesh[1]! + rotation[2] * mesh[2]! + pose.translation[0],
      rotation[3] * mesh[0]! + rotation[4] * mesh[1]! + rotation[5] * mesh[2]! + pose.translation[1],
      rotation[6] * mesh[0]! + rotation[7] * mesh[1]! + rotation[8] * mesh[2]! + pose.translation[2],
    ];
  }

  private bedPointToSource(obj: PlateObject, point: [number, number, number]): [number, number, number] {
    const placed = this.placed(obj);
    return diskFromHit("enforce", point, [0, 0, 1], 1, placed.pose, sourceFrame(obj.source, obj.scale)).p;
  }

  private paintSupports(input: Record<string, unknown>): Record<string, unknown> {
    const obj = this.wanted(input);
    if (!isObject(obj)) return obj;
    const mode: PaintKind | "erase" = input.mode === "block" || input.mode === "erase" ? input.mode : "enforce";
    return this.paintDisks(obj, input, mode === "erase" ? "erase" : mode, "supports");
  }

  private paintSeam(input: Record<string, unknown>): Record<string, unknown> {
    const obj = this.wanted(input);
    if (!isObject(obj)) return obj;
    return this.paintDisks(obj, input, input.erase === true ? "erase" : "enforce", "seam");
  }

  private paintDisks(obj: PlateObject, input: Record<string, unknown>, mode: PaintKind | "erase", layer: "supports" | "seam"): Record<string, unknown> {
    const frame = this.paintFrame(input);
    if (typeof frame !== "string") return { ok: false, reason: frame.reason };
    const region = this.readRegion(input.region);
    if ("reason" in region) return { ok: false, reason: region.reason };
    const radius = typeof input.radiusMm === "number" ? input.radiusMm : 3;
    const positions = this.paintPositions(obj, frame);
    const covered = coverRegion(positions, region, radius, this.faceOf(obj));
    if ("reason" in covered) return { ok: false, reason: covered.reason };
    const kind: PaintKind = mode === "block" ? "block" : "enforce";
    const made = this.sourceDisks(obj, covered.disks, kind, frame);
    const existing = layer === "supports" ? obj.supportPaint : obj.seamPaint;
    if (mode === "erase") {
      const picked = selectTriangles(positions, region, this.faceOf(obj));
      const removed = existing.filter((disk) => onSelection(positions, picked, this.pointInFrame(obj, disk.p, frame), Math.max(radius, disk.r))).length;
      if (input.dryRun === true) return { ok: true, dryRun: true, disks: removed, areaMm2: roundTo(covered.areaMm2, 2) };
      if (removed === 0) return { ok: false, reason: "No paint is inside that region." };
      this.remember(layer === "supports" ? "Support paint" : "Seam paint");
      if (layer === "supports") {
        obj.supportPaint = obj.supportPaint.filter((disk) => !onSelection(positions, picked, this.pointInFrame(obj, disk.p, frame), Math.max(radius, disk.r)));
      } else {
        obj.seamPaint = obj.seamPaint.filter((disk) => !onSelection(positions, picked, this.pointInFrame(obj, disk.p, frame), Math.max(radius, disk.r)));
      }
      return { ok: true, disks: removed, areaMm2: roundTo(covered.areaMm2, 2), stale: true, label: layer === "supports" ? "Support paint" : "Seam paint" };
    }
    if (existing.length + made.length > MAX_PAINT_DISKS) {
      return { ok: false, reason: `That needs ${existing.length + made.length} disks; the limit is ${MAX_PAINT_DISKS}. Use a larger radius.` };
    }
    const warnings = mode === "enforce" && layer === "supports" && obj.objectSettings.supports !== true && !this.settings.supports
      ? ["Paint is kept but not used while supports are off."]
      : [];
    const total = paintCounts(layer === "supports" ? [...obj.supportPaint, ...made] : []);
    if (input.dryRun === true) {
      return { ok: true, dryRun: true, disks: made.length, areaMm2: roundTo(covered.areaMm2, 2), ...(layer === "supports" ? { total } : { seams: existing.length + made.length }), ...(warnings.length ? { warnings } : {}) };
    }
    this.remember(layer === "supports" ? "Support paint" : "Seam paint");
    if (layer === "supports") obj.supportPaint = [...obj.supportPaint, ...made];
    else obj.seamPaint = [...obj.seamPaint, ...made.map(({ p, n, r }) => ({ p, n, r }))];
    const after = layer === "supports" ? paintCounts(obj.supportPaint) : { seams: obj.seamPaint.length };
    return {
      ok: true,
      disks: made.length,
      areaMm2: roundTo(covered.areaMm2, 2),
      total: after,
      limit: MAX_PAINT_DISKS,
      ...(warnings.length ? { warnings } : {}),
      stale: true,
      label: layer === "supports" ? "Support paint" : "Seam paint",
    };
  }

  private faceOf(obj: PlateObject): ((index: number) => number) | undefined {
    const triangles = obj.solid?.triangles;
    if (!triangles) return undefined;
    return (index) => triangles[index] ?? -1;
  }

  private reinforceAdd(input: Record<string, unknown>): Record<string, unknown> {
    const obj = this.wanted(input);
    if (!isObject(obj)) return obj;
    const kind = input.kind === "paint" || input.kind === "box" || input.kind === "cylinder" ? input.kind : null;
    if (!kind) return { ok: false, reason: "kind is paint, box, or cylinder." };
    const density = typeof input.density === "number" ? Math.min(1, Math.max(0, input.density)) : 1;
    if (kind === "paint") {
      const frame = this.paintFrame(input);
      if (typeof frame !== "string") return { ok: false, reason: frame.reason };
      const region = this.readRegion(input.region);
      if ("reason" in region) return { ok: false, reason: region.reason };
      const radius = typeof input.radiusMm === "number" ? input.radiusMm : 3;
      const covered = coverRegion(this.paintPositions(obj, frame), region, radius, this.faceOf(obj));
      if ("reason" in covered) return { ok: false, reason: covered.reason };
      const disks: ReinforceDisk[] = this.sourceDisks(obj, covered.disks, "enforce", frame).map(({ p, n, r }) => ({ p, n, r }));
      if (totalReinforceDisks(obj.reinforcement) + disks.length > MAX_PAINT_DISKS) {
        return { ok: false, reason: `That needs ${totalReinforceDisks(obj.reinforcement) + disks.length} disks; the limit is ${MAX_PAINT_DISKS}. Use a larger radius.` };
      }
      if (input.dryRun === true) return { ok: true, dryRun: true, disks: disks.length, areaMm2: roundTo(covered.areaMm2, 2) };
      const depthMm = typeof input.depthMm === "number" ? input.depthMm : 5;
      let regions = obj.reinforcement;
      let active = regions.findIndex((item) => item.kind === "paint");
      for (const disk of disks) {
        const next = addDiskToRegion(regions, active, disk, { depthMm, fillThrough: input.fillThrough === true });
        if (next.regions === regions) return { ok: false, reason: `One object holds at most ${MAX_REINFORCE_REGIONS} reinforcement regions.` };
        regions = [...next.regions];
        active = next.activeIndex;
        const painted = regions[active];
        if (painted && painted.kind === "paint") {
          regions[active] = { ...painted, density, depthMm, ...(input.fillThrough === true ? { fillThrough: true } : {}) };
        }
      }
      this.remember("Reinforcement");
      obj.reinforcement = regions;
      return { ok: true, disks: disks.length, areaMm2: roundTo(covered.areaMm2, 2), stale: true, label: "Reinforcement" };
    }
    const frame = this.paintFrame(input);
    if (typeof frame !== "string") return { ok: false, reason: frame.reason };
    const centre = readVec3(input.centre, [Number.NaN, Number.NaN, Number.NaN]);
    const size = readVec3(input.sizeMm, [Number.NaN, Number.NaN, Number.NaN]);
    if (centre.some((value) => !Number.isFinite(value)) || size.some((value) => !(value > 0))) {
      return { ok: false, reason: "The volume needs a centre and a size, in millimetres." };
    }
    const bounds = frame === "bed" ? this.placed(obj).bounds : boundsOf(obj.source);
    const box = { min: [centre[0] - size[0] / 2, centre[1] - size[1] / 2, centre[2] - size[2] / 2], max: [centre[0] + size[0] / 2, centre[1] + size[1] / 2, centre[2] + size[2] / 2] };
    const touches = box.min.every((value, axis) => value <= bounds.max[axis] && box.max[axis] >= bounds.min[axis]);
    if (!touches) return { ok: false, reason: "That volume does not touch the part." };
    if (obj.reinforcement.length >= MAX_REINFORCE_REGIONS) return { ok: false, reason: `One object holds at most ${MAX_REINFORCE_REGIONS} reinforcement regions.` };
    const scale = obj.scale || 1;
    const center = frame === "bed" ? this.bedPointToSource(obj, centre) : centre;
    const stored = size.map((value) => value / (frame === "bed" ? scale : 1)) as [number, number, number];
    if (input.dryRun === true) return { ok: true, dryRun: true, kind };
    this.remember("Reinforcement");
    obj.reinforcement = [...obj.reinforcement, { kind, density, center, size: stored }];
    return { ok: true, kind, stale: true, label: "Reinforcement" };
  }

  private paintList(input: Record<string, unknown>): Record<string, unknown> {
    const obj = this.wanted(input);
    if (!isObject(obj)) return obj;
    const layer = input.layer === "seam" || input.layer === "reinforce" ? input.layer : "supports";
    const limit = typeof input.limit === "number" ? Math.min(100, Math.max(1, Math.round(input.limit))) : 20;
    const start = typeof input.cursor === "string" ? Number(input.cursor) : 0;
    if (layer === "reinforce") {
      return { ok: true, object: obj.id, layer, regions: obj.reinforcement.length, total: totalReinforceDisks(obj.reinforcement) };
    }
    const disks = layer === "seam" ? obj.seamPaint : obj.supportPaint;
    const page = disks.slice(start, start + limit);
    return {
      ok: true,
      object: obj.id,
      layer,
      total: disks.length,
      disks: page,
      ...(start + limit < disks.length ? { nextCursor: String(start + limit) } : {}),
    };
  }

  private paintClear(input: Record<string, unknown>): Record<string, unknown> {
    const obj = this.wanted(input);
    if (!isObject(obj)) return obj;
    const layer = input.layer === "seam" || input.layer === "reinforce" ? input.layer : "supports";
    this.remember("Clear paint");
    if (layer === "seam") obj.seamPaint = [];
    else if (layer === "reinforce") obj.reinforcement = [];
    else obj.supportPaint = [];
    return { ok: true, layer, stale: true, label: "Clear paint" };
  }

  private supportEdit(input: Record<string, unknown>): Record<string, unknown> {
    const obj = this.wanted(input);
    if (!isObject(obj)) return obj;
    const action = input.action === "regrow" ? "regrow" : input.action === "prune" ? "prune" : null;
    if (!action) return { ok: false, reason: "action is prune or regrow." };
    const job = this.latest;
    const skeleton = job?.wire?.skeleton as SupportSkeleton | undefined;
    if (!skeleton?.id?.length) return { ok: false, reason: "Slice with tree supports first." };
    const site = input.site as { xy?: unknown; zMm?: unknown } | undefined;
    const xy = readVec3(site?.xy ? [ ...(Array.isArray(site.xy) ? site.xy : []), 0] : undefined, [Number.NaN, Number.NaN, Number.NaN]);
    const zMm = typeof site?.zMm === "number" ? site.zMm : Number.NaN;
    if (!Number.isFinite(xy[0]) || !Number.isFinite(xy[1]) || !Number.isFinite(zMm)) return { ok: false, reason: "site needs xy and zMm, in millimetres." };
    if (action === "regrow") {
      const gaps = Array.isArray(job?.wire?.coverage) ? job?.wire?.coverage as CoverageGap[] : [];
      const gap = gaps.find((row) => zMm + 0.5 >= row.z[0] && zMm - 0.5 <= row.z[1]);
      if (!gap) return { ok: false, reason: "Nothing unheld to regrow here." };
      if (input.dryRun === true) return { ok: true, dryRun: true, action, areaMm2: gap.areaMm2 };
      const id = obj.supportEdits.reduce((max, entry) => Math.max(max, entry.id), 0) + 1;
      this.remember("Support edit");
      obj.supportEdits = appendEdit(obj.supportEdits, { id, edit: { kind: "regrow", region: gap.outline, z: gap.z }, areaMm2: gap.areaMm2 });
      return { ok: true, action, areaMm2: gap.areaMm2, stale: true, label: "Support edit" };
    }
    const index = indexSkeleton(skeleton);
    let best = -1;
    let bestD = Infinity;
    skeleton.id.forEach((_, limb) => {
      if (skeleton.live[limb] !== 1) return;
      const d = Math.hypot((skeleton.siteX[limb] ?? 0) - xy[0], (skeleton.siteY[limb] ?? 0) - xy[1], (skeleton.siteZ[limb] ?? 0) - zMm);
      if (d < bestD) {
        bestD = d;
        best = limb;
      }
    });
    if (best < 0 || bestD > 15) return { ok: false, reason: "No support is at that point." };
    const scope = input.scope === "branch" ? "branch" : "tree";
    const sites = sitesOf(index, selectLimbs(index, best, scope));
    if (sites.length === 0) return { ok: false, reason: "No support is at that point." };
    if (input.dryRun === true) return { ok: true, dryRun: true, action, sites: sites.length, scope };
    const id = obj.supportEdits.reduce((max, entry) => Math.max(max, entry.id), 0) + 1;
    this.remember("Support edit");
    obj.supportEdits = appendEdit(obj.supportEdits, { id, edit: { kind: "prune", sites }, scope });
    return { ok: true, action, sites: sites.length, scope, stale: true, label: "Support edit" };
  }

  private supportTrees(input: Record<string, unknown>): Record<string, unknown> {
    const job = this.finished(typeof input.job === "string" ? input.job : undefined);
    const skeleton = job?.wire?.skeleton as SupportSkeleton | undefined;
    if (!job?.wire || !skeleton?.id?.length) return { ok: false, reason: "Slice with tree supports first." };
    const stale = this.staleReason(job);
    if (stale) return { ok: false, reason: stale };
    const groups = new Map<number, { id: number; baseXY: [number, number]; tipZ: number; branches: number }>();
    skeleton.id.forEach((id, limb) => {
      const tree = skeleton.tree[limb] ?? id;
      const row = groups.get(tree) ?? { id: tree, baseXY: [skeleton.siteX[limb] ?? 0, skeleton.siteY[limb] ?? 0] as [number, number], tipZ: skeleton.siteZ[limb] ?? 0, branches: 0 };
      row.branches += 1;
      const tip = skeleton.zs.slice(skeleton.start[limb] ?? 0, skeleton.start[limb + 1] ?? 0).reduce((max, value) => Math.max(max, value), row.tipZ);
      row.tipZ = tip;
      if ((skeleton.into[limb] ?? 0) === 0) row.baseXY = [skeleton.siteX[limb] ?? 0, skeleton.siteY[limb] ?? 0];
      groups.set(tree, row);
    });
    const trees = [...groups.values()];
    const start = typeof input.cursor === "string" ? Number(input.cursor) : 0;
    const limit = typeof input.limit === "number" ? Math.min(100, Math.max(1, Math.round(input.limit))) : 20;
    return { ok: true, total: trees.length, trees: trees.slice(start, start + limit), ...(start + limit < trees.length ? { nextCursor: String(start + limit) } : {}) };
  }

  private layerColumns(input: Record<string, unknown>): { paths: PathColumns; z: number; index: number } | { reason: string } {
    const job = this.finished(typeof input.job === "string" ? input.job : undefined);
    if (!job?.wire) return { reason: "Slice first." };
    const stale = this.staleReason(job);
    if (stale) return { reason: stale };
    const layers = Array.isArray(job.wire.layers) ? job.wire.layers as { z?: number; paths?: PathColumns }[] : [];
    const index = typeof input.layer === "number" ? input.layer : 0;
    const layer = layers[index];
    if (!layer?.paths || !Array.isArray(layer.paths.xy)) return { reason: "That layer has no paths." };
    return { paths: layer.paths, z: layer.z ?? 0, index };
  }

  private layerDetail(input: Record<string, unknown>): Record<string, unknown> {
    const job = this.finished(typeof input.job === "string" ? input.job : undefined);
    if (!job?.wire) return { ok: false, reason: "Slice first." };
    const stale = this.staleReason(job);
    if (stale) return { ok: false, reason: stale };
    const layers = Array.isArray(job.wire.layers) ? job.wire.layers as { z?: number; seconds?: number; index?: number }[] : [];
    const span = Array.isArray(input.layers) ? input.layers : [0, Math.max(0, layers.length - 1)];
    const from = typeof span[0] === "number" ? span[0] : 0;
    const to = typeof span[1] === "number" ? span[1] : from;
    const rows = layers.slice(from, to + 1).map((layer, offset) => ({
      index: layer.index ?? from + offset,
      z: layer.z ?? 0,
      ...(typeof layer.seconds === "number" ? { seconds: layer.seconds } : {}),
    }));
    return { ok: true, rows };
  }

  private layerPathsFile(input: Record<string, unknown>): Record<string, unknown> {
    const layer = this.layerColumns(input);
    if ("reason" in layer) return { ok: false, reason: layer.reason };
    const paths = layerPaths(layer.paths, layer.z, typeof input.simplifyMm === "number" ? input.simplifyMm : 0.05);
    const text = pathsSvg(paths);
    const path = resolveWrite(typeof input.name === "string" ? input.name : `layer-${layer.index}.svg`, ".svg");
    writeFileSync(path, text);
    return { ok: true, path, bytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex"), paths: paths.length };
  }

  private layerImage(input: Record<string, unknown>): Record<string, unknown> {
    const layer = this.layerColumns(input);
    if ("reason" in layer) return { ok: false, reason: layer.reason };
    const colourBy: ColorMode = input.colourBy === "speed" || input.colourBy === "weight" || input.colourBy === "stress" || input.colourBy === "safety" ? input.colourBy : "feature";
    let stress: LayerStress | undefined;
    if (readsStress(colourBy)) {
      const cells = this.stressCells;
      if (!cells) return { ok: false, reason: STRESS_LAYER_NEEDS };
      const objects = this.finished(typeof input.job === "string" ? input.job : undefined)?.wire?.objects;
      const ids = Array.isArray(objects) ? objects.map((o) => (o && typeof o === "object" ? (o as { id?: unknown }).id : undefined)) : null;
      // A plate reply names its objects; a one-object reply is the studied object's.
      const studied = (object: number) => !ids || cells.objectId === null || ids[object] === cells.objectId;
      stress = { cells, studied, layerZ: layer.z };
    }
    const paths = layerPaths(layer.paths, layer.z, 0.05);
    const png = pathsPng(paths, typeof input.longEdge === "number" ? input.longEdge : 256, colourBy, stress);
    const path = resolveWrite(typeof input.name === "string" ? input.name : `layer-${layer.index}.png`, ".png");
    writeFileSync(path, png);
    const body = { ok: true, path, bytes: png.byteLength, sha256: createHash("sha256").update(png).digest("hex") };
    return input.inline === false ? body : withImages(body, [pngImage(png)]);
  }

  private gcodeRead(input: Record<string, unknown>): Record<string, unknown> {
    const job = this.finished(typeof input.job === "string" ? input.job : undefined);
    if (!job?.gcode) return { ok: false, reason: "Slice first." };
    const stale = this.staleReason(job);
    if (stale) return { ok: false, reason: stale };
    const lines = job.gcode.split("\n");
    const start = typeof input.fromLine === "number" ? Math.max(1, Math.round(input.fromLine)) : 1;
    const count = typeof input.count === "number" ? Math.min(500, Math.max(1, Math.round(input.count))) : 40;
    const grep = typeof input.grep === "string" ? input.grep : "";
    const rows: { line: number; text: string }[] = [];
    for (let index = start - 1; index < lines.length && rows.length < count; index += 1) {
      const text = lines[index] ?? "";
      if (grep && !text.includes(grep)) continue;
      rows.push({ line: index + 1, text });
    }
    return { ok: true, lines: rows, ...(rows.length === count ? { nextLine: (rows[rows.length - 1]?.line ?? start) + 1 } : {}) };
  }

  private async calibrationTower(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const kind = input.kind === "pa" || input.kind === "flow" || input.kind === "temp" || input.kind === "retract" ? input.kind : null;
    if (!kind) return { ok: false, reason: "kind is pa, flow, temp, or retract." };
    const start = Number(input.start);
    const end = Number(input.end);
    const step = Number(input.step);
    if (!Number.isFinite(start) || !Number.isFinite(end) || !(step > 0) || end + 1e-9 < start) {
      return { ok: false, reason: "The tower needs a start, an end, and a positive step." };
    }
    const bandHeight = typeof input.bandHeightMm === "number" && input.bandHeightMm > 0 ? input.bandHeightMm : kind === "pa" ? 2 : 5;
    const bands = Math.floor((end - start) / step + 1e-9) + 1;
    if (bands > 40) return { ok: false, reason: `That tower has ${bands} bands. The limit is 40.` };
    const height = bands * bandHeight;
    const printer = this.printer();
    if (height > printer.bedZ) return { ok: false, reason: `That tower is ${roundTo(height, 1)} mm. The bed is ${printer.bedZ} mm tall.` };
    if (kind === "pa" && !printer.firmware) return { ok: false, reason: "The PA tower needs a firmware." };
    const body = {
      kind,
      firmware: printer.firmware,
      start,
      end,
      step,
      layerHeight: typeof input.layerHeight === "number" ? input.layerHeight : this.settings.layerHeight,
      bandHeight,
      slowMmS: 40,
      fastMmS: 200,
      accel: 3000,
      speedMmS: kind === "retract" ? 30 : 40,
      printer: enginePrinter(printer, this.filament(), this.library.nozzleMm),
    };
    if (input.dryRun === true) return { ok: true, dryRun: true, bands, heightMm: roundTo(height, 2) };
    let reply: { bands?: { index?: number; value?: number; k?: number; flow?: number; temp?: number; length?: number; z0?: number; z1?: number }[]; gcode?: string; error?: string };
    try {
      reply = JSON.parse(await this.ask(this.engine.calibrate(JSON.stringify(body)))) as typeof reply;
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : "The tower was not built." };
    }
    if (!reply.gcode || !Array.isArray(reply.bands)) return { ok: false, reason: reply.error ?? "The tower was not built." };
    const path = resolveWrite(`${kind}-tower.gcode`, ".gcode");
    writeFileSync(path, reply.gcode);
    const listed = reply.bands.map((band, index) => ({
      index: band.index ?? index,
      value: band.value ?? band.k ?? band.flow ?? band.temp ?? band.length ?? 0,
      z0: band.z0 ?? 0,
      z1: band.z1 ?? 0,
    }));
    return { ok: true, bands: listed, gcodePath: path, bytes: Buffer.byteLength(reply.gcode) };
  }

  private calibrationApply(input: Record<string, unknown>): Record<string, unknown> {
    const kind = input.kind === "pa" || input.kind === "flow" || input.kind === "temp" || input.kind === "retract" ? input.kind : null;
    if (!kind) return { ok: false, reason: "kind is pa, flow, temp, or retract." };
    const value = Number(input.value);
    if (!Number.isFinite(value)) return { ok: false, reason: "value is the number to save on the filament." };
    const filament = this.filament();
    this.remember("Calibration");
    if (kind === "pa") this.library = setAdvance(this.library, value, advanceFor(filament.linearAdvance, this.library.nozzleMm));
    else if (kind === "flow") this.library = setFlow(this.library, value);
    else if (kind === "temp") this.library = setNozzleTemp(this.library, value);
    else this.library = setRetract(this.library, value, null);
    return { ok: true, kind, value, stale: true, label: "Calibration" };
  }

  private async blendCompare(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const obj = this.wanted(input);
    if (!isObject(obj)) return obj;
    const committed = await this.commitObject(obj);
    if (committed) return { ok: false, reason: committed };
    const built = this.sliceBody(obj, "object");
    let reply: { label?: string; toughness?: number; seconds?: number; filamentG?: number; score?: number; error?: string }[];
    try {
      const parsed = JSON.parse(await this.ask(this.engine.pareto(withMesh(JSON.stringify(built.body), built.mesh)))) as typeof reply | { error?: string };
      if (!Array.isArray(parsed)) return { ok: false, reason: parsed.error ?? "The blends were not compared." };
      reply = parsed;
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : "The blends were not compared." };
    }
    this.pareto = reply.filter((point) => typeof point.toughness === "number").map((point) => ({
      label: point.label ?? "",
      toughness: point.toughness ?? 0,
      seconds: point.seconds ?? 0,
      grams: point.filamentG ?? 0,
      score: point.score ?? 0,
    }));
    if (this.pareto.length === 0) return { ok: false, reason: "The blends were not compared." };
    return { ok: true, points: this.pareto };
  }

  private blendApply(input: Record<string, unknown>): Record<string, unknown> {
    const index = typeof input.index === "number" ? input.index : -1;
    const point = this.pareto[index];
    if (!point) return { ok: false, reason: "Call blend_compare first, then pass a point index." };
    this.remember("Blend");
    if (point.toughness <= 0.001) {
      this.settings = { ...this.settings, blendKind: "single", strategy: "speed" };
    } else if (point.toughness >= 0.999) {
      this.settings = { ...this.settings, blendKind: "single", strategy: "toughness" };
    } else {
      this.settings = { ...this.settings, blendKind: "weight", toughness: point.toughness };
    }
    return { ok: true, index, toughness: point.toughness, stale: true, label: "Blend" };
  }

  /** The file Export writes, so the review sees the printer's start and end text. */
  private printerBuildAxis(): SimVec {
    const printer = this.printer();
    return printer.kind === "belt" ? beltLayerNormal(printer.belt.angleDeg) : [0, 0, 1];
  }

  private readFixtures(value: unknown): StudyHold[] | { reason: string } {
    if (value === undefined) return [];
    if (!Array.isArray(value)) return { reason: "Fixtures are a list." };
    const holds: StudyHold[] = [];
    for (const item of value) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return { reason: "A fixture is an object." };
      const row = item as Record<string, unknown>;
      if (row.kind === "bed") {
        holds.push({ kind: "bed", faces: [] });
        continue;
      }
      if (row.kind === "faces") {
        if (!Array.isArray(row.faces) || !row.faces.every((face) => Number.isInteger(face) && (face as number) >= 0)) return { reason: "Face indexes are whole numbers." };
        holds.push({ kind: "faces", faces: [...row.faces] as number[] });
        continue;
      }
      if (row.kind === "plane") {
        const normal = vec3Of(row.normal);
        const origin = vec3Of(row.origin);
        if (!normal || !origin) return { reason: "A plane needs a normal and an origin." };
        holds.push({ kind: "plane", faces: [], normal, origin });
        continue;
      }
      if (row.kind === "region") {
        const region = readRegion(row.region);
        if (!region) return { reason: REGION_SHAPE };
        holds.push("faces" in region ? { kind: "faces", faces: region.faces } : { kind: "faces", faces: [], place: region });
        continue;
      }
      return { reason: "A fixture is a bed, faces, a plane, or a region." };
    }
    return holds;
  }

  private readLoads(value: unknown): StudyLoad[] | { reason: string } {
    if (value === undefined) return [];
    if (!Array.isArray(value)) return { reason: "Loads are a list." };
    const loads: StudyLoad[] = [];
    for (const item of value) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return { reason: "A load is an object." };
      const row = item as Record<string, unknown>;
      if (row.kind !== "force" && row.kind !== "pressure") return { reason: "A load is a force or a pressure." };
      if (typeof row.magnitude !== "number" || !Number.isFinite(row.magnitude)) return { reason: "The load magnitude has to be a number." };
      const direction = vec3Of(row.direction) ?? [0, 0, -1];
      if (row.region !== undefined) {
        if (row.faces !== undefined) return { reason: "A load is on faces or on a region, not both." };
        const region = readRegion(row.region);
        if (!region) return { reason: REGION_SHAPE };
        if ("faces" in region) loads.push({ kind: row.kind, faces: region.faces, magnitude: row.magnitude, direction });
        else loads.push({ kind: row.kind, faces: [], magnitude: row.magnitude, direction, place: region });
        continue;
      }
      if (!Array.isArray(row.faces) || !row.faces.every((face) => Number.isInteger(face) && (face as number) >= 0)) return { reason: "Face indexes are whole numbers." };
      loads.push({ kind: row.kind, faces: [...row.faces] as number[], magnitude: row.magnitude, direction });
    }
    return loads;
  }

  private simCard(value: unknown) {
    const cards = cardsOf(this.library);
    const fallback = cards.find((card) => card.id === "inhouse-petg") ?? cards[0];
    if (!fallback) return { reason: "That card is not in the library." } as const;
    if (value === undefined) return fallback;
    if (typeof value === "string") return cards.find((card) => card.id === value) ?? ({ reason: "That card is not in the library." } as const);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { reason: "That card is not in the library." } as const;
    const row = value as Record<string, unknown>;
    const base = (typeof row.id === "string" ? cards.find((card) => card.id === row.id) : undefined) ?? fallback;
    const num = (key: string, current: number) => (typeof row[key] === "number" && Number.isFinite(row[key] as number) ? (row[key] as number) : current);
    const beads = row.beads === undefined ? base.beads : readBeadSection(row.beads);
    if (beads === null) return { reason: BEADS_REFUSAL } as const;
    return {
      ...base,
      id: typeof row.id === "string" && row.id.trim() ? row.id : base.id,
      polymer: typeof row.polymer === "string" && row.polymer.trim() ? row.polymer : base.polymer,
      provisional: row.provisional === false ? false : row.provisional === true ? true : base.provisional,
      EInPlaneMPa: num("EInPlaneMPa", base.EInPlaneMPa),
      EAcrossLayersMPa: num("EAcrossLayersMPa", base.EAcrossLayersMPa),
      nu: num("nu", base.nu),
      strengthInPlaneMPa: num("strengthInPlaneMPa", base.strengthInPlaneMPa),
      strengthAcrossLayersMPa: num("strengthAcrossLayersMPa", base.strengthAcrossLayersMPa),
      compressionInPlaneMPa: num("compressionInPlaneMPa", base.compressionInPlaneMPa),
      compressionAcrossLayersMPa: num("compressionAcrossLayersMPa", base.compressionAcrossLayersMPa),
      shearAcrossLayersMPa: num("shearAcrossLayersMPa", base.shearAcrossLayersMPa),
      densityGCm3: num("densityGCm3", base.densityGCm3),
      specimen: typeof row.specimen === "string" ? row.specimen : base.specimen,
      source: typeof row.source === "string" ? row.source : base.source,
      isotropic: row.isotropic === undefined ? base.isotropic : row.isotropic === true,
      beads,
    };
  }

  private beamOf(value: unknown): ObjectStudy["beam"] | { reason: string } | undefined {
    if (value === undefined) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) return { reason: BEAM_SIZE };
    const box = value as Record<string, unknown>;
    if (typeof box.lengthMm !== "number" || typeof box.widthMm !== "number" || typeof box.heightMm !== "number") return { reason: BEAM_SIZE };
    if (!(box.lengthMm > 0) || !(box.widthMm > 0) || !(box.heightMm > 0)) return { reason: BEAM_SIZE };
    return { lengthMm: box.lengthMm, widthMm: box.widthMm, heightMm: box.heightMm };
  }

  private simSetup(input: Record<string, unknown>): Record<string, unknown> {
    const element = elementRefusal(input.element);
    if (element) return { ok: false, reason: element };
    const beam = this.beamOf(input.beam);
    if (beam && "reason" in beam) return { ok: false, reason: beam.reason };
    const fixtures = this.readFixtures(input.fixtures);
    if ("reason" in fixtures) return { ok: false, reason: fixtures.reason };
    const loads = this.readLoads(input.loads);
    if ("reason" in loads) return { ok: false, reason: loads.reason };
    const card = this.simCard(input.card);
    if ("reason" in card) return { ok: false, reason: card.reason };
    const printer = input.printer === true;
    let buildAxis: SimVec = printer ? this.printerBuildAxis() : [0, 0, 1];
    if (!printer && input.buildAxis !== undefined) {
      const axis = vec3Of(input.buildAxis);
      if (!axis) return { ok: false, reason: ZERO_AXIS };
      buildAxis = axis;
    }
    if (axisLength(buildAxis) <= 1e-12) return { ok: false, reason: ZERO_AXIS };
    let edge = 5;
    if (input.hMm !== undefined) {
      if (typeof input.hMm !== "number" || !(input.hMm > 0)) return { ok: false, reason: BEAM_SIZE };
      edge = input.hMm;
    }
    let representation: SimRepresentation | undefined;
    if (input.representation !== undefined) {
      if (input.representation !== "sliced" && input.representation !== "smear") return { ok: false, reason: "representation is sliced or smear." };
      representation = input.representation;
    }
    const constraints = this.readSimConstraints(input.constraints);
    if (constraints && "reason" in constraints) return { ok: false, reason: constraints.reason };
    const requested = typeof input.object === "string" ? input.object : "";
    let obj = requested ? this.find(requested) : this.selectedObject();
    if (requested && !obj) return { ok: false, reason: UNKNOWN_OBJECT };
    if (!obj && !beam) return { ok: false, reason: "Load a mesh first." };
    this.remember("Stress");
    if (!obj && beam) {
      const source = boxPositions(beam.lengthMm, beam.widthMm, beam.heightMm);
      obj = this.addObject({
        name: "beam",
        fileName: "beam.stl",
        bytes: stlBytes(source, "beam.stl"),
        source,
        triangles: source.length / 9,
        orient: [...ID_MATRIX] as Mat3,
        scale: 1,
        centered: false,
        offset: { x: 0, y: 0, z: 0 },
        seatMm: 0,
      });
    }
    if (!obj) return { ok: false, reason: "Load a mesh first." };
    if (input.card && typeof input.card === "object") this.library = saveMaterialCard(this.library, card);
    const study: ObjectStudy = {
      holds: fixtures,
      loads,
      cardId: card.id,
      printer,
      buildAxis,
      gravity: input.gravity === true,
      edgeMm: edge,
      ...(beam ? { beam } : {}),
      ...(obj.sim?.pattern ? { pattern: obj.sim.pattern } : {}),
      ...(representation ? { representation } : {}),
      ...(constraints ? { constraints } : {}),
    };
    if (namesFaces(study)) study.facesKey = this.shapeKey(obj);
    obj.sim = study;
    return { ok: true, object: obj.id, study, sentence: setupSentence(study, card.polymer, card.provisional), label: LABEL };
  }

  private smearOf(obj: PlateObject, patch?: SweepPatch) {
    return simRecipe({
      toughness: this.settings.toughness,
      layerHeightMm: this.settings.layerHeight,
      lineWidthMm: Math.min(1.2, Math.max(0.2, this.library.nozzleMm * 1.125)),
      blendKind: this.settings.blendKind === "weight" || this.settings.blendKind === "byLayer" || this.settings.blendKind === "byRegion" ? this.settings.blendKind : "single",
      strategy: this.settings.strategy === "toughness" ? "toughness" : "speed",
      object: { walls: patch?.walls ?? obj.objectSettings.walls, infill: patch?.infill ?? obj.objectSettings.infill },
      overrides: this.overrides,
      reinforcementDensities: obj.reinforcement.map((region) => region.density),
    });
  }

  private solveCopy(obj: PlateObject, patch: SweepPatch | undefined, op: "run" | "field", field?: Record<string, unknown>): Record<string, unknown> {
    const saved = obj.sim;
    if (!saved) return { ok: false, reason: "Set up a study first." };
    const stale = this.staleFaces(obj, saved);
    if (stale) return { ok: false, reason: stale };
    if (saved.holds.some((hold) => hold.place) || saved.loads.some((load) => load.place)) return { ok: false, reason: PLACE_ON_SMEAR };
    const study = cloneStudy(saved);
    if (study.printer) study.buildAxis = this.printerBuildAxis();
    if (patch?.loadScale) study.loads = scaleLoads(study.loads, patch.loadScale);
    if (patch?.pattern) study.pattern = patch.pattern;
    const recipe = this.smearOf(obj, patch);
    const refused = recipeRefusal(recipe);
    if (refused) return { ok: false, reason: refused };
    const card = cardsOf(this.library).find((row) => row.id === study.cardId);
    if (!card) return { ok: false, reason: "That card is not in the library." };
    const pattern = study.pattern ?? recipe.pattern;
    const job = solverJob({
      op,
      study,
      card,
      walls: recipe.walls,
      infill: recipe.infill,
      pattern: pattern === "lines" || pattern === "grid" || pattern === "gyroid" || pattern === "lightning" ? pattern : undefined,
      field: typeof field?.field === "string" ? field.field : undefined,
      points: field?.points as SimVec[] | undefined,
      box: field?.box as { min: SimVec; max: SimVec } | undefined,
      face: typeof field?.face === "number" ? field.face : undefined,
      stride: typeof field?.stride === "number" ? field.stride : undefined,
      limit: typeof field?.limit === "number" ? field.limit : undefined,
      cursor: typeof field?.cursor === "number" ? field.cursor : undefined,
    });
    if ("reason" in job) return { ok: false, reason: job.reason };
    const reply = runSolver(job);
    if (Array.isArray(reply.triangles)) delete reply.triangles;
    if (Array.isArray(reply.nodes)) delete reply.nodes;
    if ("stiffness" in reply) delete reply.stiffness;
    return reply;
  }

  private async simRun(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const obj = this.simTarget(input);
    if ("reason" in obj) return { ok: false, reason: obj.reason };
    const saved = obj.sim;
    if (!saved) return { ok: false, reason: "Set up a study first." };
    const reply = this.representationFor(obj, saved) === "sliced"
      ? await this.solveSliced(obj, saved, input.checkResolution !== false)
      : this.solveCopy(obj, undefined, "run");
    if (reply.ok === true && input.includeSlicerMass === true) {
      const estimate = this.freshEstimate();
      if (estimate) reply.slicerGrams = estimate.grams;
    }
    return reply;
  }

  private representationFor(obj: PlateObject, study: ObjectStudy): SimRepresentation {
    return representationOf({
      asked: study.representation,
      beam: study.beam !== undefined,
      printerId: this.library.printerId,
      fileName: obj.fileName,
    });
  }

  /** The solver's kinds and its refusal sentences (`lime-sim` sliced_study.rs), so a refusal reads the same either way. */
  private readSimConstraints(value: unknown): StudyConstraint[] | { reason: string } | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) return { reason: "Constraints are a list of targets." };
    if (value.length > 8) return { reason: "A study takes up to 8 targets." };
    const out: StudyConstraint[] = [];
    for (const item of value) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return { reason: "A target is an object." };
      const row = item as Record<string, unknown>;
      if (typeof row.kind !== "string" || !TARGET_KINDS.includes(row.kind)) return { reason: `A target is ${TARGET_KINDS.join(", ")}.` };
      const band = BAND_KINDS.has(row.kind);
      let pair: [number, number] | undefined;
      if (band) {
        const lo = Array.isArray(row.band) ? row.band[0] : undefined;
        const hi = Array.isArray(row.band) ? row.band[1] : undefined;
        if (!Array.isArray(row.band) || row.band.length !== 2 || typeof lo !== "number" || typeof hi !== "number" || !Number.isFinite(lo) || !Number.isFinite(hi) || !(lo >= 0) || !(hi > lo)) {
          return { reason: "A band needs two numbers, the lower first." };
        }
        pair = [lo, hi];
      } else if (typeof row.value !== "number" || !(row.value > 0) || !Number.isFinite(row.value)) return { reason: "A target has to be a positive number." };
      const region = row.region === undefined ? undefined : readRegion(row.region);
      const other = row.other === undefined ? undefined : readRegion(row.other);
      if (region === null || other === null) return { reason: REGION_SHAPE };
      if (STIFFNESS_KINDS.has(row.kind) && !region) return { reason: "A stiffness target needs the region it reads." };
      if (row.kind === "relativeDeflectionMm" && (!region || !other)) return { reason: "A relative deflection needs two regions, region and other." };
      out.push({
        kind: row.kind,
        value: band ? 0 : (row.value as number),
        ...(pair ? { band: pair } : {}),
        ...(region ? { region } : {}),
        ...(other ? { other } : {}),
      });
    }
    return out;
  }

  /** The solid the face indexes are picked on, as a key. A Model edit changes it. */
  private shapeKey(obj: PlateObject): string {
    const positions = obj.solid && obj.solid.positions.length >= 9 ? obj.solid.positions : obj.source;
    return fnv1aHex(new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength));
  }

  /** A study that names faces, run on a solid edited since it was set up. Never solve on renumbered faces. */
  private staleFaces(obj: PlateObject, study: ObjectStudy): string | null {
    if (!study.facesKey || !namesFaces(study)) return null;
    return study.facesKey === this.shapeKey(obj) ? null : STALE_FACES;
  }

  /**
   * The mesh the study slices: the solid the faces were picked on, scaled the
   * same way, or the committed plate mesh when that is the same shape.
   * A triangle-count difference is not the test. A box parameter keeps the count.
   */
  private studyMesh(obj: PlateObject): StudyMesh | { reason: string } {
    const committed = !obj.treeStale && obj.bytes.byteLength > 0 && (!obj.tree || obj.platedNode === obj.tree.current);
    const solid = obj.solid;
    const choice = chooseStudyMesh({
      picked: solid && solid.positions.length >= 9 ? solid.positions : null,
      pickedTriangles: solid?.triangles ?? null,
      plate: obj.source.length >= 9 ? obj.source : null,
      scale: obj.scale,
      committed,
    });
    if (!choice) return { reason: STUDY_MESH_REFUSAL };
    if ("reason" in choice) return choice;
    return choice;
  }

  /** The pose of the tessellation being sliced, when it is not the plate mesh. */
  private studyPose(obj: PlateObject, unscaled: Float32Array): RigidPose | null {
    if (unscaled === obj.source) return null;
    const printer = this.printer();
    return placeMesh(unscaled, obj.orient, obj.scale, printer.bedX, printer.bedY, obj.centered, obj.offset).pose;
  }

  /** Face index of each triangle. A generated beam with no solid pairs triangles into faces. */
  private faceIds(obj: PlateObject, study: ObjectStudy, count: number, triangleIds: ArrayLike<number> | null): number[] | null {
    if (triangleIds && triangleIds.length === count) return Array.from(triangleIds);
    if (study.beam && !obj.solid) return Array.from({ length: count }, (_, index) => Math.floor(index / 2));
    return null;
  }

  /**
   * A region's triangles in the mesh frame, before the pose. A generated beam
   * stores clockwise corners, so those are reversed to face outward.
   */
  private slicedRegion(
    obj: PlateObject,
    study: ObjectStudy,
    faces: number[],
    role: "hold" | "load" | "target",
    corners: Float32Array,
    triangleIds: ArrayLike<number> | null,
  ): Record<string, unknown> | { reason: string } {
    if (faces.length === 0) {
      if (role === "hold") return { reason: "A hold's region touches no surface of the sliced part." };
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (let i = 0; i < corners.length; i += 3) {
        const x = corners[i] ?? 0;
        const y = corners[i + 1] ?? 0;
        const z = corners[i + 2] ?? 0;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        minZ = Math.min(minZ, z);
        maxZ = Math.max(maxZ, z);
      }
      if (!Number.isFinite(minX)) return { reason: "Pick a face to load, or type its index." };
      const span = Math.max(1e-3, maxX - minX);
      const thick = Math.min(1, span * 0.05);
      return { kind: "box", min: [maxX - thick, minY, minZ], max: [maxX, maxY, maxZ] };
    }
    const count = Math.floor(corners.length / 9);
    const ids = this.faceIds(obj, study, count, triangleIds);
    if (!ids) return { reason: "That face is not on this part." };
    const want = new Set(faces);
    const reverse = study.beam !== undefined && obj.solid === null;
    const triangles: [number, number, number][][] = [];
    for (let tri = 0; tri < count; tri += 1) {
      if (!want.has(ids[tri] ?? -1)) continue;
      const at = tri * 9;
      const corner = (offset: number): [number, number, number] => [corners[at + offset] ?? 0, corners[at + offset + 1] ?? 0, corners[at + offset + 2] ?? 0];
      const a = corner(0);
      const b = corner(3);
      const c = corner(6);
      triangles.push(reverse ? [a, c, b] : [a, b, c]);
    }
    if (triangles.length === 0) {
      return { reason: `A ${role}'s region touches no surface of the sliced part.` };
    }
    return { kind: "faces", triangles };
  }

  /**
   * Solve the object as it is sliced. A sweep `patch` changes that one slice (walls, infill, the pattern) and
   * scales the loads, without touching the plate.
   */
  private async solveSliced(obj: PlateObject, saved: ObjectStudy, checkResolution = true, patch?: SweepPatch): Promise<Record<string, unknown>> {
    const stale = this.staleFaces(obj, saved);
    if (stale) return { ok: false, reason: stale };
    const study = cloneStudy(saved);
    if (patch?.loadScale !== undefined && patch.loadScale !== 1) study.loads = scaleLoads(study.loads, patch.loadScale);
    if (study.printer) study.buildAxis = this.printerBuildAxis();
    if (study.holds.some((hold) => hold.kind === "plane")) return { ok: false, reason: "A plane hold is not on a sliced study. Hold the bed or faces." };
    if (!study.holds.some((hold) => hold.kind === "bed" || hold.faces.length > 0 || hold.place)) return { ok: false, reason: "Nothing is held." };
    const card = cardsOf(this.library).find((row) => row.id === study.cardId);
    if (!card) return { ok: false, reason: "That card is not in the library." };
    const { body } = this.sliceBody(obj, "object");
    body.includePreview = false;
    body.includeGcode = false;
    delete body.sim;
    const mesh = this.studyMesh(obj);
    if ("reason" in mesh) return { ok: false, reason: mesh.reason };
    const encoded = bytesToBase64(stlBytes(mesh.positions, stlFileName(obj.fileName)));
    const pose = this.studyPose(obj, mesh.unscaled);
    if (Array.isArray(body.objects)) {
      const first = body.objects[0];
      if (first && typeof first === "object" && !Array.isArray(first)) {
        const row = first as Record<string, unknown>;
        row.dataB64 = encoded;
        if (pose) row.pose = pose;
      }
    } else {
      body.dataB64 = encoded;
      if (pose) body.pose = pose;
    }
    if (obj.objectSettings.walls !== undefined && !Array.isArray(body.objects)) body.walls = obj.objectSettings.walls;
    if (obj.objectSettings.infill !== undefined && !Array.isArray(body.objects)) body.infill = obj.objectSettings.infill;
    if (patch) this.patchSliceBody(body, obj, patch);
    // A place is in the model frame; the sliced mesh is scaled about its source's centre.
    const box = boundsOf(mesh.unscaled);
    const centre: SimVec = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
    const regionOf = (region: StudyRegion, role: "hold" | "load" | "target") =>
      "faces" in region ? this.slicedRegion(obj, study, region.faces, role, mesh.positions, mesh.triangles) : placeRegion(region, centre, obj.scale);
    const holds: Record<string, unknown>[] = [];
    for (const hold of study.holds) {
      if (hold.kind === "bed") {
        holds.push({ kind: "bed" });
        continue;
      }
      const region = regionOf(hold.place ?? { faces: hold.faces }, "hold");
      if ("reason" in region) return { ok: false, reason: region.reason as string };
      holds.push({ kind: "region", region });
    }
    const loads: Record<string, unknown>[] = [];
    for (const load of study.loads) {
      const region = load.place
        ? placeRegion(load.place, centre, obj.scale)
        : this.slicedRegion(obj, study, load.faces, "load", mesh.positions, mesh.triangles);
      if ("reason" in region) return { ok: false, reason: region.reason as string };
      if (load.kind === "pressure") {
        loads.push({ kind: "pressure", region, mpa: load.magnitude });
        continue;
      }
      const n = Math.hypot(load.direction[0], load.direction[1], load.direction[2]);
      if (!(n > 1e-12)) return { ok: false, reason: "The load direction has zero length." };
      loads.push({
        kind: "force",
        region,
        force: [load.direction[0] / n * load.magnitude, load.direction[1] / n * load.magnitude, load.direction[2] / n * load.magnitude],
      });
    }
    if (loads.length === 0) return { ok: false, reason: "This study has no load." };
    const targets: Record<string, unknown>[] = [];
    for (const row of study.constraints ?? []) {
      const target: Record<string, unknown> = { kind: row.kind, value: row.value, ...(row.band ? { band: row.band } : {}) };
      for (const key of ["region", "other"] as const) {
        const given = row[key];
        if (!given) continue;
        const region = regionOf(given, "target");
        if ("reason" in region) return { ok: false, reason: region.reason as string };
        target[key] = region;
      }
      targets.push(target);
    }
    const sent: Record<string, unknown> = { ...withBeads(card) };
    for (const [key, value] of Object.entries(sent)) if (value === null || value === undefined) delete sent[key];
    const payload = JSON.stringify({
      request: body,
      study: {
        ...(study.edgeMm > 0 ? { hXy: study.edgeMm } : {}),
        card: sent,
        holds,
        loads,
        ...(targets.length > 0 ? { constraints: targets } : {}),
        checkResolution,
      },
    });
    let text: string;
    try {
      text = await Promise.resolve(this.engine.simStudy(payload));
    } catch (err) {
      return { ok: false, reason: err instanceof Error && err.message ? err.message : "The stress solve did not finish." };
    }
    this.stressCells = parseStressCells(text, obj.id) ?? this.stressCells;
    return slicedRunReply(text, study.constraints ?? []);
  }

  /**
   * A sweep variant's print settings on a one-object slice body: on the object's own settings when the body lists
   * it, else on the body. A pattern is a blend, which would also move walls and infill with its toughness, so they
   * are pinned to what the object prints now, as the desktop's sweep does.
   */
  private patchSliceBody(body: Record<string, unknown>, obj: PlateObject, patch: SweepPatch): void {
    const row = Array.isArray(body.objects) && body.objects[0] && typeof body.objects[0] === "object"
      ? (body.objects[0] as Record<string, unknown>)
      : null;
    const target: Record<string, unknown> = row
      ? ((row.settings && typeof row.settings === "object" ? row.settings : (row.settings = {})) as Record<string, unknown>)
      : body;
    if (patch.walls !== undefined) target.walls = patch.walls;
    if (patch.infill !== undefined) target.infill = patch.infill;
    if (patch.pattern) {
      const width = Math.min(1.2, Math.max(0.2, this.library.nozzleMm * 1.125));
      const card = resolved(this.settings.toughness, this.settings.layerHeight, width);
      target.blend = patternBlend(patch.pattern);
      if (target.walls === undefined) target.walls = obj.objectSettings.walls ?? card.walls;
      if (target.infill === undefined) target.infill = obj.objectSettings.infill ?? card.density;
    }
  }

  /** A sliced sweep: each variant one slice of the object alone and one solve. */
  private async slicedSweep(obj: PlateObject, patches: SweepPatch[], limits: ConstraintLimits, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (patches.some((patch) => patch.parameters)) return { ok: false, reason: RESLICE_PARAMETERS };
    const saved = obj.sim!;
    // One cell size per variant unless asked: a sweep compares variants, and a second size doubles each solve.
    const checkResolution = input.checkResolution === true;
    type SweepRow = Record<string, unknown> & { ok?: boolean; met: boolean; reason: string };
    const rows: SweepRow[] = [];
    for (const patch of patches) {
      const solved = await this.solveSliced(obj, saved, checkResolution, patch);
      if (solved.ok !== true) {
        rows.push({ ok: false, met: false, reason: typeof solved.reason === "string" ? solved.reason : "The stress solve did not finish." });
        continue;
      }
      const verdict = constraintVerdict({
        maxDisplacementMm: typeof solved.maxDisplacementMm === "number" ? solved.maxDisplacementMm : 0,
        minSafetyFactor: typeof solved.minSafetyFactor === "number" ? solved.minSafetyFactor : null,
        massG: typeof solved.massG === "number" ? solved.massG : 0,
      }, limits);
      rows.push({ ...solved, met: verdict.met, reason: verdict.reason });
    }
    let committed = false;
    if (input.commit === true) {
      const index = typeof input.variant === "number" ? input.variant : patches.length === 1 ? 0 : -1;
      if (!Number.isInteger(index) || index < 0 || index >= patches.length) return { ok: false, variants: rows, reason: "Name the variant to keep." };
      const chosen = rows[index];
      if (!chosen || chosen.ok === false) return { ok: false, variants: rows, reason: typeof chosen?.reason === "string" ? chosen.reason : "The stress solve did not finish." };
      if (patches[index]!.pattern) return { ok: false, variants: rows, reason: RESLICE_PATTERN_KEEP };
      this.remember("Sweep");
      this.applySweepPatch(obj, patches[index]!);
      committed = true;
    }
    return { ok: true, variants: rows, committed, note: "Each variant was sliced alone and solved. slicerSeconds and slicerGrams are that slice's." };
  }

  private simField(input: Record<string, unknown>): Record<string, unknown> {
    const obj = this.simTarget(input);
    if ("reason" in obj) return { ok: false, reason: obj.reason };
    if (obj.sim && this.representationFor(obj, obj.sim) === "sliced") return { ok: false, reason: SLICED_FIELD };
    const field = typeof input.field === "string" ? input.field : "";
    const names = ["displacement", "von_mises", "stress", "safety_factor", "element_error"];
    if (!names.includes(field)) return { ok: false, reason: `Unknown field. This result has ${names.join(", ")}.` };
    let points: SimVec[] | undefined;
    if (input.points !== undefined) {
      if (!Array.isArray(input.points)) return { ok: false, reason: "A point is three numbers." };
      points = [];
      for (const item of input.points) {
        const point = vec3Of(item);
        if (!point) return { ok: false, reason: "A point is three numbers." };
        points.push(point);
      }
    }
    let box: { min: SimVec; max: SimVec } | undefined;
    if (input.box !== undefined) {
      if (!input.box || typeof input.box !== "object" || Array.isArray(input.box)) return { ok: false, reason: "A box needs a min and a max." };
      const row = input.box as { min?: unknown; max?: unknown };
      const min = vec3Of(row.min);
      const max = vec3Of(row.max);
      if (!min || !max) return { ok: false, reason: "A box needs a min and a max." };
      box = { min, max };
    }
    let face: number | undefined;
    if (input.face !== undefined) {
      if (!Number.isInteger(input.face) || (input.face as number) < 0) return { ok: false, reason: "That face is not on this beam." };
      face = input.face as number;
    }
    let stride: number | undefined;
    if (input.stride !== undefined) {
      if (!Number.isInteger(input.stride) || (input.stride as number) < 1) return { ok: false, reason: "A stride starts at 1." };
      stride = input.stride as number;
    }
    if (!points && !box && face === undefined && stride === undefined) return { ok: false, reason: "Name points, a box, a face, or a stride." };
    return this.solveCopy(obj, undefined, "field", { field, points, box, face, stride, limit: pageLimit(input.limit), cursor: pageCursor(input.cursor) });
  }

  private simTarget(input: Record<string, unknown>): PlateObject | { reason: string } {
    const requested = typeof input.object === "string" ? input.object : "";
    const obj = requested ? this.find(requested) : this.selectedObject();
    if (!obj) return { reason: requested ? UNKNOWN_OBJECT : "Load a mesh first." };
    return obj;
  }

  private sweepPatchProblem(patch: SweepPatch): string | null {
    if (patch.parameters) {
      const merged = this.mergeParams(patch.parameters);
      if ("reason" in merged && typeof merged.reason === "string") return merged.reason;
    }
    if (patch.walls !== undefined) {
      const applied = applyObjectSetting(this.settings, "walls", patch.walls, this.schemaContext());
      if ("reason" in applied) return applied.reason;
    }
    if (patch.infill !== undefined) {
      const applied = applyObjectSetting(this.settings, "infill", patch.infill, this.schemaContext());
      if ("reason" in applied) return applied.reason;
    }
    return null;
  }

  private applySweepPatch(obj: PlateObject, patch: SweepPatch): void {
    if (patch.parameters) this.paramsTool({ set: patch.parameters });
    const next = { ...obj.objectSettings };
    if (patch.walls !== undefined) {
      const applied = applyObjectSetting(this.settings, "walls", patch.walls, this.schemaContext());
      if (!("reason" in applied)) next.walls = applied.value as number;
    }
    if (patch.infill !== undefined) {
      const applied = applyObjectSetting(this.settings, "infill", patch.infill, this.schemaContext());
      if (!("reason" in applied)) next.infill = applied.value as number;
    }
    obj.objectSettings = next;
    if (!obj.sim) return;
    const study = cloneStudy(obj.sim);
    if (patch.pattern) study.pattern = patch.pattern;
    if (patch.loadScale !== undefined && patch.loadScale !== 1) study.loads = scaleLoads(study.loads, patch.loadScale);
    obj.sim = study;
  }

  private async simSweep(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!Array.isArray(input.variants)) return { ok: false, reason: SWEEP_REFUSAL };
    if (input.variants.length > SWEEP_CAP) return { ok: false, reason: SWEEP_REFUSAL };
    const patches: SweepPatch[] = [];
    for (const item of input.variants) {
      const patch = readPatch(item);
      if (typeof patch === "string") return { ok: false, reason: patch };
      const problem = this.sweepPatchProblem(patch);
      if (problem) return { ok: false, reason: problem };
      patches.push(patch);
    }
    const limits = readLimits(input.constraints);
    if (typeof limits === "string") return { ok: false, reason: limits };
    const obj = this.simTarget(input);
    if ("reason" in obj) return { ok: false, reason: obj.reason };
    const sliced = obj.sim !== undefined && this.representationFor(obj, obj.sim) === "sliced";
    if (sliced && input.reslice !== true) return { ok: false, reason: SLICED_SWEEP };
    if (!sliced && input.reslice === true) return { ok: false, reason: RESLICE_BEAM };
    if (sliced) return this.slicedSweep(obj, patches, limits as ConstraintLimits, input);
    type SweepRow = Record<string, unknown> & { ok?: boolean; met: boolean; reason: string; slicerSeconds?: number };
    const rows: SweepRow[] = patches.map((patch): SweepRow => {
      const solved = this.solveCopy(obj, patch, "run");
      if (solved.ok !== true) return { ok: false, met: false, reason: typeof solved.reason === "string" ? solved.reason : OPEN_MESH };
      const verdict = constraintVerdict({
        maxDisplacementMm: typeof solved.maxDisplacementMm === "number" ? solved.maxDisplacementMm : 0,
        minSafetyFactor: typeof solved.minSafetyFactor === "number" ? solved.minSafetyFactor : null,
        massG: typeof solved.massG === "number" ? solved.massG : 0,
      }, limits as ConstraintLimits);
      return { ...solved, met: verdict.met, reason: verdict.reason };
    });
    const commit = input.commit === true;
    let committed = false;
    if (commit) {
      const index = typeof input.variant === "number" ? input.variant : patches.length === 1 ? 0 : -1;
      if (!Number.isInteger(index) || index < 0 || index >= patches.length) return { ok: false, variants: rows, reason: "Name the variant to keep." };
      const chosen = rows[index];
      if (!chosen || chosen.ok === false) return { ok: false, variants: rows, reason: typeof chosen?.reason === "string" ? chosen.reason : OPEN_MESH };
      this.remember("Sweep");
      this.applySweepPatch(obj, patches[index]!);
      committed = true;
    }
    let note = "";
    if (input.includePrintTime === true) {
      const estimate = this.freshEstimate();
      if (estimate) {
        for (const row of rows) row.slicerSeconds = estimate.seconds;
        note = "The slicer's estimate.";
      } else note = "Print time was not estimated.";
    }
    return { ok: true, variants: rows, committed, ...(note ? { note } : {}) };
  }

  private fileText(job: Job, now: Date): string {
    const summary = this.summarize(job);
    const printer = this.printer();
    const filament = this.filament();
    const heat = heatFor(printer, filament.nozzleTemp, filament.bedTemp);
    return exportGcode({
      gcode: job.gcode ?? "",
      grams: summary.grams,
      now,
      layerSeconds: summary.layerSeconds,
      layerHeight: this.settings.layerHeight,
      nozzleDiameter: this.library.nozzleMm,
      filamentType: filament.material === "Saved" ? undefined : filament.material,
      printerName: printer.name,
      startGcode: printer.startGcode,
      endGcode: printer.endGcode,
      startOwnsHoming: printer.startOwnsHoming,
      heat,
    });
  }
}

export function meshHash(bytes: Uint8Array): string {
  return fnv1aHex(bytes);
}

export { blendOf };
