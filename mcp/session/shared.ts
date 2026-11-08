import type { Assembly } from "../../src/assembly.ts";
/**
 * What the Session and its tool modules share: the constants, types, and helper functions that were at the top of
 * mcp/session.ts. Moved, not changed.
 */
import { fnv1aHex } from "../../src/slice-action.ts";
import type { Bounds, Mat3 } from "../../src/mesh-place.ts";
import type { SolidView } from "../../src/modeling/model-calls.ts";
import { EDGES_SHAPE } from "../../src/modeling/bake.ts";
import { applyPose, type Affine, type ObjectFrame } from "../../src/model-space.ts";
import { type ModelTree, type PluginStamp } from "../../src/model-tree.ts";
import type { StampedRun } from "../../src/plugin-step.ts";
import type { PresetSettings } from "../../src/presets.ts";
import type { OverrideDocument } from "../../src/overrides.ts";
import type { EditEntry } from "../../src/support-edit-list.ts";
import type { PaintDisk } from "../../src/support-paint.ts";
import type { SeamDisk } from "../../src/seam-paint.ts";
import type { ReinforceRegion } from "../../src/reinforcement.ts";
import type { PlateObjectSettings } from "../../src/plate.ts";
import type { ChainLink, JointLimits } from "../../src/chain.ts";
import type { Vec3 } from "../../src/pivot.ts";
import type { ObjectStudy, StudyConstraint } from "../../src/sim/study.ts";
import { LABEL } from "../../src/sim/label.ts";
import type { PrintOrder } from "../../src/settings-rules.ts";
import type { LayerAction } from "../../src/layer-actions.ts";
import type { Workplane } from "../../src/workplane.ts";
import type { MachineLibrary } from "../../src/ui/machine-library.ts";
import type { KeptIngredient } from "../ingredients.ts";
import type { RecipeData } from "../recipe.ts";
import type { FacePick } from "../../src/modeling/compose.ts";
import { pickSentence } from "../../src/modeling/frames.ts";
import { isPlainNumber } from "../../src/modeling/params.ts";
import type { Session } from "../session.ts";
import { refuse } from "../refusals.ts";

export const OVERLAP = "These parts overlap. Move one before slicing.";
export const CHORD = 0.05;
export const STEP = 0.05;
export const SLICE_WAIT_DEFAULT_S = 20;
export const SLICE_WAIT_MAX_S = 25;
export const STALE_SLICE = "The printer, filament, settings, or placement changed after this slice. Slice again.";
/** --- Print transitions, step 6b. plan:true before a slice of this plate as it is. */
export const SLICE_CHECK_MCP = "slice_start, then plan again, to mark the rows that hang in the slice too (seenInSlice).";
export const MESH_EDIT = "Model edits need a STEP file or a new solid. This part is a mesh.";
export const UNKNOWN_OBJECT = "That object is not on the plate. Call plate_list for the current handles.";

export const PLACE_KEYS = ["x", "y", "z", "turnX", "turnY", "turnZ"] as const;

export function joinedPositions(parts: ArrayLike<number>[]): Float32Array {
  const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export function posedPositions(positions: ArrayLike<number>, pose: Affine): Float32Array {
  const out = new Float32Array(positions.length);
  for (let i = 0; i + 2 < positions.length; i += 3) out.set(applyPose(pose, [positions[i]!, positions[i + 1]!, positions[i + 2]!]), i);
  return out;
}

/** What model_place says about the frame later Model numbers are read in. */
/** --- D25. Expression text, so an MCP step keeps the expressions it was typed with, as an app step keeps a field's. */
export function exprText(value: unknown): string | null {
  return typeof value === "string" && value.trim() && !isPlainNumber(value) ? value.trim() : null;
}

/** The app field each typed number lands in, by op kind; a diameter is halved into the radius the op stores. */
export const OP_EXPR_FIELDS: Record<string, readonly (readonly [string, string, boolean?])[]> = {
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
export const FEATURE_EXPR_FIELDS: readonly (readonly [string, string])[] = [["width", "modelFeatW"], ["height", "modelFeatH"], ["depth", "modelFeatDepth"], ["diameter", "modelFeatDia"], ["grooveWidth", "modelTexGroove"]];

/**
 * The expression fields of one typed op, keyed as the app's panel stores them (`op.exprs`), so the app's Rebuild and
 * its out-of-date mark follow a parameter the MCP named. The session uses it for a feature (pocket, boss, texture, …),
 * whose group the app re-expands from its source; every other op links what it stored (`linksOf`).
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
export function changesPlate(name: string): boolean {
  if (name === "model_export_step" || name === "model_check" || name === "model_params" || name === "model_define") return false;
  if (name === "sim_setup" || name === "sim_sweep") return true;
  return /^(model_|object_|plate_|assembly_|paint_|workplane_|support_edit|reinforce_|modifier_|range_|override_)/.test(name) || name === "solid_new" || name === "recipe_run" || name === "mesh_import" || name === "project_open" || name === "project_create";
}

/** Calls that can outlast a client's request timeout: the autosave is written before they start. */
// A sweep that reslices is one slice and one solve per variant.
export const LONG_CALLS = new Set(["recipe_run", "model_apply_batch", "model_build", "model_edit", "project_open", "mesh_import", "sim_sweep"]);
export const NAME_LIMIT = 120;
/** D11.3: an imported plugin's build stops after this long (a person's own save keeps the cold-slot 120 s). */
export const IMPORT_BUILD_LIMIT_MS = 30_000;
/** Tools whose op fields may be text expressions. */

/**
 * Calls that may outrun the client's request timeout (Claude Code's is 60 s, and it then restarts the server). One that
 * has not answered after `replySeconds()`, or whose request the client cancels, goes on as a background job instead:
 * the reply is a job handle for slice_wait, and the work finishes or, with slice_cancel, is taken back.
 */
export const DETACHABLE = new Set([
  "model_apply", "model_apply_batch", "model_build", "model_edit", "model_goto", "model_undo", "model_redo", "model_commit",
  "model_probe", "project_open", "project_save", "app_open", "mesh_import", "solid_new", "slice_start", "export_3mf", "model_export_step",
  "sim_run", "sim_sweep", "model_params", "recipe_run",
]);

/** What may run while a background job does: reads that do not touch the modeler, and the job's own wait and cancel. */
export const WHILE_BUSY = new Set([
  "session_info", "guide", "tools_enable", "plate_list", "slice_wait", "slice_cancel", "model_history", "settings_schema", "machine_list",
  "machine_get", "overrides_list", "layer_actions_list", "paint_list", "gcode_summary", "gcode_read", "layer_summary",
  "layer_detail", "mesh_stats", "support_trees",
]);

/** Detachable calls that change no part: a cancelled one is simply left to finish. */
export const CHANGES_NOTHING = new Set(["model_probe", "project_save", "app_open", "export_3mf", "model_export_step"]);

/** Seconds a detachable call runs before it answers with a job instead: under a 60 s client timeout. */
export function replySeconds(): number {
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
  /** Reserved before a plan starts so each autosave can identify its eventual background job. */
  planJob?: string;
}

/** A detachable call that outran its reply: it runs on, and slice_wait returns its result. */
export interface WorkJob {
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
export const TARGET_KINDS = ["minSafetyFactor", "maxDeflectionMm", "deflectionBandMm", "minStiffnessNPerMm", "stiffnessBandNPerMm", "relativeDeflectionMm", "maxMassG", "minMassG"];
export const BAND_KINDS = new Set(["deflectionBandMm", "stiffnessBandNPerMm"]);
export const STIFFNESS_KINDS = new Set(["minStiffnessNPerMm", "stiffnessBandNPerMm"]);
export const REGION_SHAPE = "A region is {faces:[...]}, {sphere:{centre, radiusMm}}, or {box:{min, max}}, in the model frame.";
export const STALE_FACES = "The part changed since this study was set up. Pick the faces again, or give the regions as a sphere or a box.";
export const PLACE_ON_SMEAR = "A sphere or box region is read on a sliced study. Hold and load faces on a smear.";
export const STRESS_LAYER_NEEDS ="Run sim_run on a sliced study of this object, then colour by stress or safety.";
export const BEADS_REFUSAL = "A card's beads need every modulus and strength above 0, and a bridgeFactor above 0 and at most 1.";

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
  /** Which frame Model numbers are typed in: the part's own, or model space (absent). `model_place {frame}` sets it. */
  frame?: ObjectFrame;
  workplane: Workplane;
  /** --- Gaps A3. A workplane typed with expressions: its numbers and text, so ops typed on it link to them and a parameter set moves it. */
  workplaneTyped?: TypedWorkplane;
  tree: ModelTree | null;
  /** The modeler was restarted under this tree: it is rebuilt from its root and ops at its current step on next use. */
  treeStale?: boolean;
  /** Why the last commit's mesh does not close, when it committed anyway because the part came in open. */
  commitWarning?: string;
  solid: SolidView | null;
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
  /** Source-frame pivot. Absent for the bounds centre. */
  pivot?: Vec3;
  /** Parent link through pivots. Absent when the part is free. */
  chain?: ChainLink;
  /** Inverse-kinematics limits, degrees. Absent when the joint is free. */
  jointLimits?: JointLimits;
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
  /** The recipe_run that made this object: a key of `rustRecipes`. Saved with the project. */
  rustRecipe?: string;
  /**
   * --- Plugin steps (D8). A rebuild of the plugin that made this part gave it a new tree: the object it replaced, kept
   * off the plate so one model_undo at `tip` puts it back. Not saved.
   */
  rebuiltFrom?: { prior: PlateObject; tip: number };
  /** The rebuilt object a model_undo took back, so model_redo brings it again. Not saved. */
  rebuiltTo?: PlateObject;
  /** Stress study. Absent until sim_setup. Not sent to the slicer. */
  sim?: ObjectStudy;
}

/** A workplane_set origin and turn as numbers, beside the text each was typed as (`resolveTexts`). */
export interface TypedWorkplane {
  source: "global" | "bed" | "face";
  origin: [number, number, number];
  turn: [number, number, number];
  text: { origin: unknown; turn: unknown };
}

/** A recipe_run's source as it built, the parameters of its last apply, and the objects that apply made. */
export interface RustRecipe {
  source: string;
  params: Record<string, unknown>;
  objects: string[];
  /** --- R-A. The recipe data the last apply read, by name, so a rerun builds the same where the files are missing. */
  data?: Record<string, RecipeData>;
  /** The workspace file the source was read from, when it came from one. */
  path?: string;
  /** SHA-256 of the source as it built: the draft's identity (docs/plan-recipe-plugins.md D1). */
  sha256?: string;
  /** The session's order of applies, so plugin save {from} keeps the latest run of a name. */
  at?: number;
  /** Parts already on the plate that the run changed. */
  changed?: string[];
  /** The plugin this run came from, or was kept as. */
  plugin?: { id: string; version: number; sha256: string };
  /**
   * --- I10. The ingredients the source imported, as they built, by `ingredients::<name>` (`<name>@<N>` when pinned):
   * a rerun builds these, and a plugin kept from this run carries them (I11).
   */
  ingredients?: Record<string, KeptIngredient>;
}

/** --- Plugin steps (D8). A recipe_run that rebuilds a stamped run: the part, the run, and where the part stood. */
export interface PluginRebuild {
  obj: PlateObject;
  run: StampedRun;
  stamp: PluginStamp;
  /** The step shown before the rebuild: Undo goes back to it. */
  from: number;
  /** The steps after the run on the way to `from`: built again after the new run. */
  later: number[];
  /** A draft's ingredient copies, as its last apply built them. */
  ingredients?: Record<string, KeptIngredient>;
}

/** A model_build's base, ops, parameters, and name, as typed. */
export interface Recipe {
  base: unknown;
  ops: unknown;
  params: Record<string, unknown>;
  name?: string;
}

export interface Ghost {
  mesh: Float32Array;
  touches: boolean;
}

export interface Job {
  handle: string;
  engineId: number;
  objectId: string;
  /** True when this job sliced every object, not the selected one. */
  plateScope: boolean;
  /** Object ids whose meshes went into this slice. */
  slicedIds: string[];
  /** Another object was on the plate, so the result names the slice set. */
  others: boolean;
  stamp: string;
  status: string;
  gcode?: string;
  wire?: Record<string, unknown>;
  error?: string;
}

export interface SliceSummary {
  seconds: number;
  grams: number;
  filamentMm: number;
  cost: number;
  warnings: string[];
  features: { label: string; seconds: number; grams: number }[];
  layerSeconds: number[];
  layers: { z: number; seconds?: number }[];
}

/** --- Split to print. The kernel's sentence for each piece whose number had no room. */
export function numberNotes(reply: Record<string, unknown>): string[] {
  return Array.isArray(reply.notes) ? reply.notes.filter((note): note is string => typeof note === "string") : [];
}

/**
 * --- Split to print, milestone 5. The connectors the kernel built and left out, in model space: each placed one's id,
 * centre and whether its holes got the teardrop roof; each dropped one's id and sentence.
 */
export function joined(reply: Record<string, unknown>, pose: Affine): { connectors?: { placed: { id: string; at: number[]; teardrop: boolean }[]; dropped: { id: string; reason: string; sentence: string }[] } } {
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
export function pinsOf(reply: Record<string, unknown>): { pins?: { count: number; volumeMm3: number } } {
  const pins = reply.pins as { count?: unknown; volumeMm3?: unknown } | undefined;
  if (!pins || typeof pins !== "object") return {};
  return { pins: { count: Number(pins.count) || 0, volumeMm3: Math.round(Number(pins.volumeMm3) * 1000) / 1000 } };
}

/** --- Split to print. Where each piece's number was cut, in model space: on cut N's face (from 1), or on a side face. */
export function numbered(reply: Record<string, unknown>, pose: Affine): { numbers?: { part: number; faces: { face: string; cut?: number; at: number[] }[] }[] } {
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

export function positionsFrom(encoded: string): Float32Array {
  const bytes = Buffer.from(encoded, "base64");
  const copy = new Uint8Array(bytes);
  return new Float32Array(copy.buffer);
}

/** Rows in a `layer_detail` page: every layer of an ordinary part, about 90 KB. */
export const LAYER_ROWS = 2000;

export function shownName(name: string): string {
  return name.length <= NAME_LIMIT ? name : name.slice(0, NAME_LIMIT);
}

export function changedValues(rows: unknown[]): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const item = row as { key?: unknown; to?: unknown };
    if (typeof item.key === "string") values[item.key] = item.to;
  }
  return values;
}

export function roundTo(value: number, places: number): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

export interface SnapObject {
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
  frame?: ObjectFrame;
  workplane: Workplane;
  supportEdits: EditEntry[];
  supportPaint: PaintDisk[];
  seamPaint: SeamDisk[];
  reinforcement: ReinforceRegion[];
  objectSettings: PlateObjectSettings;
  platedNode: number | null;
  brep?: Uint8Array;
  sim?: ObjectStudy;
  pivot?: Vec3;
  chain?: ChainLink;
  jointLimits?: JointLimits;
}

export interface PlateSnap {
  label: string;
  assemblies: Assembly[];
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

export class ModelRunaway extends Error {
  /** --- R-C. The modeler's process ended under the call, rather than running past its time. */
  readonly crashed: boolean;
  constructor(message: string, crashed = false) {
    super(message);
    this.name = "ModelRunaway";
    this.crashed = crashed;
  }
}

/** --- I8. A face a selector picked during a call, with the nearPoint it was aimed at. */
export type PickRow = FacePick & { nearPoint?: number[] };

/**
 * The call's reply with the faces its selectors picked: `picked` on any reply, and on a refusal one sentence per pick
 * after the reason, so a wrong face is named where the agent reads why.
 */
export function withPicks(value: Record<string, unknown>, picks: readonly PickRow[]): Record<string, unknown> {
  if (picks.length === 0 || value.picked !== undefined) return value;
  const picked = picks.map(({ nearPoint: _near, ...row }) => (row.level === null ? (({ level: _level, ...rest }) => rest)(row) : row));
  if (value.ok !== false) return { ...value, picked };
  const said = picks.map((row) => pickSentence(row, row.nearPoint)).join(" ");
  return { ...value, ...(typeof value.reason === "string" ? { reason: `${value.reason} ${said}` } : {}), picked };
}

export function domainRefusal(message: string): { ok: false; reason: string; next?: string } | null {
  if (message.startsWith("That file was not found")) {
    return refuse("file-not-found", message, undefined, "Check the path, then call the tool again.");
  }
  if (message.startsWith("This mesh did not finish") || message.includes("LIME_MCP_WORKSPACE") || message.startsWith("Writes stay") || message.startsWith("That path is not") || message.startsWith("That name cannot") || message.startsWith("Open a .stl") || message.startsWith("That file is")) {
    return refuse("bad-path", message);
  }
  return null;
}

/** The plate STL's name for a solid's file: the app's `stlName`. */
export function stlFileName(name: string): string {
  const stem = name.replace(/\.(step|stp|stl|3mf)$/i, "");
  return `${stem || "solid"}.stl`;
}

/** A STEP file's name for a solid's file, as the app's `stepFileName` names it. */
export function stepFileName(name: string): string {
  const stem = name.replace(/\.(step|stp|stl|3mf|brep)$/i, "");
  return `${stem || "solid"}.step`;
}

/** A value as text with its keys sorted, so two ops that ask the same thing have the same key. */
export function stableKey(value: unknown): string {
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
export function modelSteps(tree: ModelTree): number {
  let count = 0;
  for (const node of tree.nodes.values()) {
    count += 1;
    if (node.op?.kind === "group") count += node.op.steps.length;
  }
  return count;
}

/**
 * --- 3.1 F4. A fillet's or chamfer's `edges` as the schema takes it: one pick object written inside a list,
 * `[{fromNode, filter}]`, is that object. Several pick objects in a list, or picks mixed with indexes, are refused
 * with the shapes that are taken, before the schema check says only "edges[0] must be a number".
 */
export function edgePicksAsTyped(args: unknown): { args: unknown } | { reason: string } {
  if (!args || typeof args !== "object" || Array.isArray(args)) return { args };
  const input = args as Record<string, unknown>;
  const fix = (op: unknown): { op: unknown } | { reason: string } => {
    if (!op || typeof op !== "object" || Array.isArray(op)) return { op };
    const row = op as Record<string, unknown>;
    if ((row.kind !== "fillet" && row.kind !== "chamfer" && row.kind !== "transition") || !Array.isArray(row.edges)) return { op };
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

/** The first node on the path from `from` down to `to`: the child of `from` that `to` descends from. */
export function firstAfter(tree: ModelTree, from: number, to: number): number | null {
  let node: number | null = to;
  while (node !== null) {
    const parent: number | null = tree.nodes.get(node)?.parent ?? null;
    if (parent === from) return node;
    node = parent;
  }
  return null;
}

export function isObject(value: PlateObject | { ok: false; reason: string }): value is PlateObject {
  return !("reason" in value);
}

export function xyGap(a: Bounds, b: Bounds): number {
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
export function slicedRunReply(text: string, targets: readonly StudyConstraint[] = []): Record<string, unknown> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return refuse("solve-failed", "The stress solve did not finish.");
  }
  if (parsed.ok !== true) {
    return refuse("solve-failed", typeof parsed.reason === "string" && parsed.reason ? parsed.reason : "The stress solve did not finish.");
  }
  const report = parsed.report && typeof parsed.report === "object" ? (parsed.report as Record<string, unknown>) : null;
  if (!report) return refuse("solve-failed", "The stress solve did not finish.");
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

export function withRegion(row: unknown, target: StudyConstraint | undefined): unknown {
  if (!target?.region || !row || typeof row !== "object" || Array.isArray(row)) return row;
  return { ...(row as Record<string, unknown>), region: target.region, ...(target.other ? { other: target.other } : {}) };
}

/** The slicer's estimate of the slice a sliced study solved: free, since it was sliced anyway. */
export function sliceEstimateOf(value: unknown): { slicerSeconds?: number; slicerGrams?: number } {
  if (!value || typeof value !== "object") return {};
  const row = value as Record<string, unknown>;
  return {
    ...(typeof row.seconds === "number" ? { slicerSeconds: row.seconds } : {}),
    ...(typeof row.filamentG === "number" ? { slicerGrams: row.filamentG } : {}),
  };
}

/**
 * The engine's check for part beads that stand on nothing: no bead, support or belt under them. Lengths to 0.1 mm,
 * the longest span of one path over nothing, and the five largest patches with their layers and where each starts on
 * the plate. Absent when the engine did not run it.
 */
export function standsOnNothing(value: unknown): { standsOnNothing?: Record<string, unknown> } {
  if (!value || typeof value !== "object") return {};
  const hold = value as Record<string, unknown>;
  const mm = (n: unknown) => Math.round((typeof n === "number" ? n : 0) * 10) / 10;
  const rows = Array.isArray(hold.largest) ? hold.largest as Record<string, unknown>[] : [];
  return {
    standsOnNothing: {
      unheldMm: mm(hold.unheldMm),
      danglingMm: mm(hold.danglingMm),
      longestSpanMm: mm(hold.longestSpanMm),
      partMm: mm(hold.partMm),
      patches: typeof hold.patches === "number" ? hold.patches : 0,
      largest: rows.slice(0, 5).map((row) => ({
        mm: mm(row.mm),
        danglingMm: mm(row.danglingMm),
        longestSpanMm: mm(row.longestSpanMm),
        layers: row.layers,
        at: Array.isArray(row.at) ? row.at.map(mm) : [],
      })),
    },
  };
}


export function meshHash(bytes: Uint8Array): string {
  return fnv1aHex(bytes);
}

/** What a tool handler answers: the reply, or a promise of it. */
export type ToolReply = Record<string, unknown> | Promise<Record<string, unknown>>;
/** One tool: the session, the call's input, and the call's meta. The dispatch table maps a tool name to one. */
export type ToolHandler = (s: Session, input: Record<string, unknown>, meta?: CallMeta) => ToolReply;
/** A Model tool that works on one object, found by the Model dispatch. */
export type ObjectToolHandler = (s: Session, obj: PlateObject, input: Record<string, unknown>) => ToolReply;
