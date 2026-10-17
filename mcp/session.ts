/**
 * One stdio connection is one plate. The engine is behind `Engine`.
 * Feasibility refusals are `{ok:false, reason}` and are decided before apply.
 */
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
import { align, centeringShift, encode3mf, ID_MATRIX, layFlatMatrix, matMul, offBed, placeMesh, rotX, rotY, rotZ, scaledCanonical, settleBy, type Bounds, type Mat3, type RigidPose } from "../src/mesh-place.ts";
import { decodeSolid } from "../src/model-reply.ts";
import { disjointBoolean, probeFromBody, probeKey, probeNote, type ProbedTool } from "../src/model-feasibility.ts";
import { builtBranch, crossEdit, editRefusal, forked, replayChain, type ToolLink } from "../src/model-edit.ts";
import { dropRefusal } from "../src/model-history.ts";
import { SCREWS, throughLength } from "../src/model-hole.ts";
import { extentAlong, facePlane, splitBase, splitNote, tiltRings, type SplitPlan, type Vec3 as PlaneVec } from "../src/model-plane.ts";
import { rootSpec } from "../src/model-primitive.ts";
import { readFingerprint } from "../src/model-reply.ts";
import { applyRequest, crossEditRequest, exportRequest, gotoRequest, joinOp, newSolidRequest, openRequest, probeRequest, wholeTreeRequest } from "../src/model-request.ts";
import { IDENTITY_POSE, toSolidOp, type Affine } from "../src/model-space.ts";
import { dropped, jumped, newTree, opLabel, redoTarget, reserveId, undoTarget, withChild, type Fingerprint, type ModelOp, type ModelTree, type NodeId } from "../src/model-tree.ts";
import { DEFAULT_PRESET, presetKeys, type PresetSettings } from "../src/presets.ts";
import { meshRecord, parseProject, serializeProject, type LimeProject, type ProjectPlacement, type ProjectProfile } from "../src/project.ts";
import { savedTree, loadedTree } from "../src/model-tree-file.ts";
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
import type { ColorMode } from "../src/colors.ts";
import { ARRANGE_GAP_MM, arrangedObjects, sourceFrame, slicePlateFields, settingsEmpty, type PlateObject as SliceObject, type PlateObjectSettings } from "../src/plate.ts";
import { orderFields, sequentialClearance, settingsRules, tallestLast, type PrintOrder } from "../src/settings-rules.ts";
import type { LayerAction } from "../src/layer-actions.ts";
import { CURVED_FACE, GLOBAL_WORKPLANE, drillDown, isGlobalFrame, localPoint, planePoint, planePrimitive, workplaneOnBed, workplaneOnFace, type Workplane } from "../src/workplane.ts";
import { eulerOrient, orientEuler } from "../src/mesh-place.ts";
import { plateFileIsVersion2 } from "../src/plate.ts";
import { advanceFor, builtinLibrary, adoptProfile, enginePrinter, fileFromSelection, heatFor, parseMachineFile, serializeMachineFile, setAdvance, setFlow, setGcode, setNozzleTemp, setRetract, type FilamentRecord, type MachineLibrary, type PrinterRecord } from "../src/ui/machine-library.ts";
import { parseSettingsProfile, profileFileName, serializeSettingsProfile } from "../src/ui/settings-profiles.ts";

import { mirror, type BridgeLink } from "./bridge-client.ts";
import { occtHint, ProtocolError, withMesh, type Engine } from "./engine.ts";
import { appVersion, exportGcode, mass } from "./export-gcode.ts";
import { layerPaths, pathsPng, pathsSvg } from "./layer-out.ts";
import { renderMesh, type Camera } from "./render.ts";
import { applyPreset, blendOf, sessionSliceRequest, stlBytes } from "./request.ts";
import { shellGroups, takeGroups } from "../src/mesh-shells.ts";
import { reviewGcode } from "./review.ts";
import { GUIDES, guideByUri } from "./guides.ts";
import { applyObjectSetting, applySetting, inactiveWarning, isObjectKey, settingRows, type ObjectSettingKey } from "./settings-rows.ts";
import { edgesMatching, facesMatching } from "./selectors.ts";
import { settingsRangeError } from "./settings-check.ts";
import { edgeGeometry, faceRows } from "./solid-geometry.ts";
import { validateTool } from "./schema.ts";
import { cleanOp, COMPOSITE_KINDS, expand, isComposite, MAX_PIECES, primitiveFrom, readVec3, type ExpandContext, type FaceExtent, type Piece } from "./compose.ts";
import { ExprError, PARAM_NAME, evaluate, resolveNumbers } from "./expr.ts";
import { resolveRead, resolveWrite } from "./workspace.ts";

const OVERLAP = "These parts overlap. Move one before slicing.";
const CHORD = 0.05;
const STEP = 0.05;
const SLICE_WAIT_DEFAULT_S = 20;
const SLICE_WAIT_MAX_S = 120;
const STALE_SLICE = "The printer, filament, settings, or placement changed after this slice. Slice again.";
const MESH_EDIT = "Model edits need a STEP file or a new solid. This part is a mesh.";
const UNKNOWN_OBJECT = "That object is not on the plate. Call plate_list for the current handles.";
const NAME_LIMIT = 120;
/** Tools whose op fields may be text expressions. */
const EXPRESSION_TOOLS = new Set(["model_probe", "model_apply", "model_apply_batch", "model_edit", "model_build"]);

/** Carried with one tools/call: a progress token, and cancel for that request. */
export interface CallMeta {
  progressToken?: string | number;
  signal?: AbortSignal;
}

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
  solid: ReturnType<typeof rememberSolid> | null;
  probes: Map<string, true>;
  supportEdits: EditEntry[];
  supportPaint: PaintDisk[];
  seamPaint: SeamDisk[];
  reinforcement: ReinforceRegion[];
  objectSettings: PlateObjectSettings;
  /** The history node whose STEP is `bytes`. Null until a commit writes it. */
  platedNode: number | null;
  /** Runs of steps one composite edit or batch made: undo takes the whole run back. */
  groups?: { start: number; end: number; label: string }[];
  /** The run undo last took back, so redo can bring it all again. */
  undoneGroup?: { start: number; end: number; label: string };
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

export class Session {
  readonly objects: PlateObject[] = [];
  selected = "";
  settings: PresetSettings = { ...DEFAULT_PRESET };
  actions: LayerAction[] = [];
  library: MachineLibrary = builtinLibrary();
  jobs: Job[] = [];
  running: Job | null = null;
  latest: Job | null = null;
  private seq = 0;
  private jobSeq = 0;
  private readonly engine: Engine;
  private sourceProject: LimeProject | null = null;
  private sourceHash = "";
  private sourcePath = "";
  private profileTouched = false;
  private lastBridge: Record<string, unknown> | null = null;
  private undoStack: PlateSnap[] = [];
  private redoStack: PlateSnap[] = [];
  private bridgeSeq = 0;
  /** This process on the bridge. The desktop starts its sequence again when it changes. */
  private readonly bridgeSession = randomUUID();
  private readonly bridgeLink: BridgeLink = { known: new Set(), resync: () => this.resyncBridge() };
  private readonly meshHashes = new WeakMap<Uint8Array, string>();
  private generation = 0;
  private lastProgressAt = 0;
  overrides: OverrideDocument = emptyOverrides();
  private pareto: { label: string; toughness: number; seconds: number; grams: number; score: number }[] = [];
  printOrder: PrintOrder["printOrder"] = "all-at-once";
  clearanceMm = 0;
  gantryMm = 0;
  onProgress: ((job: string, fraction: number, stage: string, token?: string | number) => void) | null = null;
  /** Names model ops may use in place of numbers. Set with model_params; not saved in the project. */
  params: Record<string, number> = {};

  constructor(engine: Engine) {
    this.engine = engine;
  }

  call(name: string, args: unknown, meta?: CallMeta): Promise<Record<string, unknown>> {
    const numbered = this.withNumbers(name, args);
    if ("reason" in numbered) return Promise.resolve({ ok: false, reason: numbered.reason });
    args = numbered.args;
    const problem = validateTool(name, args ?? {});
    if (problem) throw new ProtocolError(problem);
    const input = (args ?? {}) as Record<string, unknown>;
    const result = this.dispatch(name, input, meta);
    return Promise.resolve(result).then((value) => {
      const { payload, carriedAll } = this.bridgePayload(name, input, value);
      this.lastBridge = payload;
      void mirror(payload, this.bridgeLink, carriedAll);
      return value;
    }).catch((err: unknown) => {
      if (err instanceof ProtocolError) {
        const refusal = domainRefusal(err.message);
        if (refusal) return refusal;
      }
      throw err;
    });
  }

  /**
   * Model tools take text such as "wallH / 2" where a number goes. Each one becomes its number before the schema
   * check, from the session's parameters and the call's own `params`.
   */
  private withNumbers(name: string, args: unknown): { args: unknown } | { reason: string } {
    if (!EXPRESSION_TOOLS.has(name) || !args || typeof args !== "object") return { args };
    const input = { ...(args as Record<string, unknown>) };
    let params = this.params;
    if (input.params && typeof input.params === "object") {
      const merged = this.mergeParams(input.params as Record<string, unknown>);
      if ("reason" in merged && typeof merged.reason === "string") return { reason: merged.reason };
      params = merged as Record<string, number>;
    }
    try {
      for (const key of ["op", "ops", "base"]) {
        if (input[key] !== undefined) input[key] = resolveNumbers(input[key], params, key);
      }
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
      tool: name,
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
      case "mesh_import": return this.meshImport(String(input.path), typeof input.stepToleranceMm === "number" ? input.stepToleranceMm : STEP);
      case "plate_list": return this.plateList(input);
      case "plate_undo": return this.plateUndo();
      case "plate_redo": return this.plateRedo();
      case "object_select": return this.objectSelect(String(input.object));
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
      case "export_3mf": return this.export3mf(String(input.name));
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
      default: return this.model(name, input);
    }
  }

  private async sessionInfo(): Promise<Record<string, unknown>> {
    let engine: string | null = null;
    let occt = false;
    let reason = "";
    try {
      engine = await this.ask(this.engine.version());
      occt = await this.ask(this.engine.occt());
    } catch (err) {
      reason = err instanceof Error ? err.message : "The engine did not answer.";
    }
    return {
      ok: true,
      serverVersion: appVersion(),
      engine,
      occt,
      ...(reason ? { reason } : {}),
      workspace: process.env.LIME_MCP_WORKSPACE ?? "",
      printer: this.printer().name,
      filament: this.filament().name,
      printerSend: false,
      model: {
        ops: ["boolean", "hole", "fillet", "chamfer", "split", "scale", "join", "root"],
        composite: [...COMPOSITE_KINDS],
        primitives: ["box", "cylinder", "sphere", "cone", "torus", "wedge", "polygon", "tube"],
        maxSteps: MAX_PIECES,
        expressions: true,
        guides: GUIDES.map((row) => row.uri.replace("lime://guide/", "")),
      },
    };
  }

  /** The worked guides as a tool, for clients that do not read resources. */
  private guide(input: Record<string, unknown>): Record<string, unknown> {
    const topic = typeof input.topic === "string" ? input.topic.trim().toLowerCase() : "";
    if (!topic) return { ok: true, topics: GUIDES.map((row) => ({ topic: row.uri.replace("lime://guide/", ""), name: row.name, tools: row.tools })) };
    const found = guideByUri(`lime://guide/${topic}`);
    if (!found) return { ok: false, reason: `There is no guide named ${topic}. Topics: ${GUIDES.map((row) => row.uri.replace("lime://guide/", "")).join(", ")}.` };
    return { ok: true, topic, name: found.name, tools: found.tools, text: found.text };
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
    return { ok: true, project: "project", label: "New plate" };
  }

  private async projectOpen(path: string): Promise<Record<string, unknown>> {
    const full = resolveRead(path, "lime");
    const parsed = parseProject(await readFile(full, "utf8"));
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
        seatMm: preview.seatMm,
        stepTolerance: row.placement.stepTolerance > 0 ? row.placement.stepTolerance : STEP,
        supportEdits: row.supportEdits.map((entry) => structuredClone(entry)),
        supportPaint: row.supportPaint.map((disk) => structuredClone(disk)),
        seamPaint: row.seamPaint.map((disk) => structuredClone(disk)),
        reinforcement: row.reinforcement.map((region) => structuredClone(region)),
        objectSettings: { ...row.objectSettings },
      }, row.id);
      if (row.modelPose) obj.modelPose = { m: [...row.modelPose.m] as Affine["m"], t: [...row.modelPose.t] as Affine["t"] };
      if (row.workplane) obj.workplane = { source: row.workplane.source, origin: [...row.workplane.origin] as Workplane["origin"], turn: [...row.workplane.turn] as Workplane["turn"] };
      objects.push({ object: obj.id, name: shownName(obj.name) });
    }
    for (const row of rows) {
      if (!row.modelTree || !row.id) continue;
      const obj = this.find(row.id);
      if (obj) await this.adoptHistory(obj, row.modelTree);
    }
    const skipped = this.notSliced();
    return {
      ok: true,
      project: "project",
      version: parsed.project.version,
      handles: "new",
      label: "Open project",
      printer: this.printer().name,
      filament: this.filament().name,
      objects,
      ...(parsed.project.unreadHistory?.length ? { unreadHistory: parsed.project.unreadHistory } : {}),
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
      ...(obj.modelPose.t.some((value) => value !== 0) || obj.modelPose.m.some((value, index) => value !== [1, 0, 0, 0, 1, 0, 0, 0, 1][index]) ? { modelPose: { m: [...obj.modelPose.m] as Affine["m"], t: [...obj.modelPose.t] as Affine["t"] } } : {}),
      ...(obj.workplane.source === "global" ? {} : { workplane: { source: obj.workplane.source, origin: [...obj.workplane.origin] as Workplane["origin"], turn: [...obj.workplane.turn] as Workplane["turn"] } }),
    };
  }

  private savedModelTree(obj: PlateObject): NonNullable<LimeProject["objects"]>[number]["modelTree"] | undefined {
    const tree = obj.tree;
    if (!tree || tree.root.kind === "piece") return undefined;
    const owner = (key: string) => this.objects.find((row) => row.tree?.key === key)?.id;
    const body = savedTree(tree, tree.committed, owner);
    if (tree.root.kind === "primitive") return { ...body, rootPrimitive: tree.root.solid };
    const bytes = new Uint8Array(tree.root.bytes);
    return { ...body, rootStep: meshRecord(tree.root.name, bytes) };
  }

  private async adoptHistory(obj: PlateObject, saved: NonNullable<NonNullable<LimeProject["objects"]>[number]["modelTree"]>): Promise<void> {
    const key = `mcp-${obj.id}`;
    const root = saved.rootPrimitive
      ? { kind: "primitive" as const, solid: saved.rootPrimitive }
      : saved.rootStep?.bytesBase64
        ? { kind: "step" as const, name: saved.rootStep.name, bytes: this.bufferOf(saved.rootStep.bytesBase64) }
        : null;
    if (!root || (root.kind === "step" && !root.bytes)) return;
    const stepRoot = root.kind === "step" && root.bytes ? { kind: "step" as const, name: root.name, bytes: root.bytes } : root.kind === "primitive" ? root : null;
    if (!stepRoot) return;
    const objectKey = (id: string) => this.objects.find((row) => row.id === id)?.tree?.key ?? (this.find(id) ? `mcp-${id}` : undefined);
    obj.tree = loadedTree(saved, key, stepRoot, obj.name, null, objectKey);
    obj.platedNode = obj.tree.committed;
    try {
      const reply = await this.treeCall(wholeTreeRequest(obj.tree, stepRoot, obj.tree.current, obj.stepTolerance || CHORD), "open");
      const solid = rememberSolid(reply);
      if (solid) obj.solid = solid;
    } catch (err) {
      if (err instanceof ModelRunaway) return;
      throw err;
    }
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

  private async projectSave(name: string, refuseExisting = false): Promise<Record<string, unknown>> {
    if (this.objects.length === 0) return { ok: false, reason: "The plate is empty." };
    const path = resolveWrite(name, ".lime");
    if (refuseExisting && existsSync(path)) return { ok: false, reason: "A project with that name is already in the workspace. Pick another name, or leave ifExists out to replace it." };
    const committed = await this.commitAll();
    if (committed) return { ok: false, reason: committed };
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
    const doc = this.projectDocument();
    if (this.sourcePath && path === this.sourcePath) {
      const loss = this.lossy(doc);
      if (loss) return { ok: false, reason: loss };
    }
    const text = serializeProject(doc);
    writeFileSync(path, text);
    this.sourceProject = structuredClone(doc);
    this.sourceHash = createHash("sha256").update(text).digest("hex");
    this.sourcePath = path;
    return { ok: true, path, bytes: Buffer.byteLength(text) };
  }

  private async meshImport(path: string, tolerance: number): Promise<Record<string, unknown>> {
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
    const placed = this.placed(obj);
    const overlap = this.overlaps(obj) ? OVERLAP : "";
    const combined = [note, overlap].filter((line) => line).join(" ");
    return {
      ok: true,
      object: obj.id,
      name: shownName(obj.name),
      triangles: obj.triangles,
      bboxMm: { min: placed.bounds.min, max: placed.bounds.max },
      ...(combined ? { note: combined } : {}),
    };
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
    return { ok: true, objects: listed.rows, ...(listed.nextCursor ? { nextCursor: listed.nextCursor } : {}) };
  }

  private objectSelect(id: string): Record<string, unknown> {
    const obj = this.find(id);
    if (!obj) return { ok: false, reason: UNKNOWN_OBJECT };
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
      obj.orient = layFlatMatrix(obj.source);
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
    for (const obj of [...this.objects]) await this.closeTree(obj);
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
      };
      this.objects.push(copy);
      made.push(id);
    }
    this.selected = made[made.length - 1] ?? source.id;
    return { ok: true, objects: made, label: "Duplicate" };
  }

  private splitShells(id: string): Record<string, unknown> {
    const obj = this.find(id);
    if (!obj) return { ok: false, reason: UNKNOWN_OBJECT };
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
    const committed = await this.commitAll();
    if (committed) return { ok: false, reason: committed };
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
    const camera = (input.camera === "front" || input.camera === "iso" ? input.camera : "top") as Camera;
    const mesh = obj.solid && obj.solid.positions.length >= 9 ? obj.solid.positions : this.placed(obj).positions;
    const drawn = renderMesh(mesh, camera, typeof input.longEdge === "number" ? input.longEdge : 768);
    const path = resolveWrite(typeof input.name === "string" ? input.name : `${obj.name}-${camera}.png`, ".png");
    writeFileSync(path, drawn.png);
    return { ok: true, path, camera, width: drawn.width, height: drawn.height };
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
    if (name === "solid_new") return this.solidNew(input);
    if (name === "model_build") return this.build(input);
    if (name === "model_params") return this.paramsTool(input);
    const requested = typeof input.object === "string" ? input.object : "";
    const obj = this.find(requested !== "" ? requested : this.selected);
    if (!obj) return { ok: false, reason: UNKNOWN_OBJECT };
    switch (name) {
      case "model_describe": return this.describe(obj, input);
      case "faces_find": return this.facesFind(obj, input);
      case "edges_find": return this.edgesFind(obj, input);
      case "workplane_set": return this.workplaneSet(obj, input);
      case "workplane_print_up": return this.printUp(obj);
      case "model_place": return this.modelPlace(obj, input);
      case "model_probe": return this.probe(obj, input.op, input.node);
      case "model_apply": return this.applyTool(obj, input);
      case "model_apply_batch": return this.applyBatch(obj, input);
      case "model_history": return this.history(obj, input);
      case "model_goto": return this.gotoNode(obj, this.nodeOf(obj, input.node));
      case "model_undo": return this.step(obj, "undo");
      case "model_redo": return this.step(obj, "redo");
      case "model_edit": return this.edit(obj, this.nodeOf(obj, input.node), input.op);
      case "model_drop": return this.drop(obj, this.nodeOf(obj, input.node));
      case "model_rename": return this.rename(obj, this.nodeOf(obj, input.node), String(input.label ?? ""));
      case "model_commit": return this.commit(obj);
      case "model_export_step": return this.exportStep(obj, String(input.name));
      case "measure": return this.measure(obj, input);
      default: throw new ProtocolError(`There is no tool named ${name}.`);
    }
  }

  private modelTimeoutMs(): number {
    const raw = Number(process.env.LIME_MCP_MODEL_TIMEOUT_S);
    const seconds = Number.isFinite(raw) && raw > 0 ? raw : 30;
    return seconds * 1000;
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
  private async withBudget<T>(kind: string, work: () => T | Promise<T>, onRunaway: () => Promise<void> = () => this.loseTrees()): Promise<T> {
    const budget = this.modelTimeoutMs();
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
    for (const obj of this.objects) {
      obj.tree = null;
      obj.solid = null;
      obj.probes = new Map();
    }
  }

  private lostReply(err: unknown): Record<string, unknown> | null {
    if (!(err instanceof ModelRunaway)) return null;
    return { ok: false, reason: err.message, treeLost: true };
  }

  private async treeCall(body: Record<string, unknown>, label = "edit"): Promise<Record<string, unknown>> {
    const op = body.op && typeof body.op === "object" ? body.op as { kind?: unknown } : null;
    const kind = typeof op?.kind === "string" ? op.kind : label;
    const text = await this.withBudget(kind, () => this.engine.modelTree(JSON.stringify(body)));
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

  /** STEP bytes the bridge returns. A missing `bytesBase64` is a failed export. */
  private stepBytes(reply: Record<string, unknown>): Uint8Array | null {
    if (typeof reply.bytesBase64 !== "string" || reply.bytesBase64 === "") return null;
    const bytes = base64ToBytes(reply.bytesBase64);
    if (!bytes || bytes.byteLength === 0) return null;
    if (typeof reply.byteLength === "number" && reply.byteLength !== bytes.byteLength) return null;
    return bytes;
  }

  private async ensureTree(obj: PlateObject): Promise<ModelTree> {
    if (obj.tree) return obj.tree;
    const key = `mcp-${obj.id}`;
    const root = { kind: "step" as const, name: obj.fileName, bytes: obj.bytes.buffer as ArrayBuffer };
    const reply = await this.treeCall(openRequest(key, root, CHORD));
    const error = typeof reply.error === "string" ? reply.error : "";
    if (error) throw new ProtocolError(plainModelError(error));
    obj.tree = newTree(key, root, obj.name, null);
    obj.solid = rememberSolid(reply);
    return obj.tree;
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
      name: kind,
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
    if (obj.tree) return null;
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
    const matched = facesMatching(obj.solid.faces, input);
    if ("reason" in matched) return { ok: false, reason: matched.reason };
    const listed = page(matched, input.cursor, input.limit);
    return { ok: true, total: matched.length, frame: "part", faces: listed.rows, ...(listed.nextCursor ? { nextCursor: listed.nextCursor } : {}) };
  }

  private async edgesFind(obj: PlateObject, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const tree = await this.opened(obj);
    if ("reason" in tree) return { ok: false, reason: tree.reason };
    if (!obj.solid) return { ok: false, reason: "This solid could not be read." };
    const matched = edgesMatching(obj.solid.edges, obj.solid.faces, input);
    if ("reason" in matched) return { ok: false, reason: matched.reason };
    const listed = page(matched, input.cursor, input.limit);
    return { ok: true, total: matched.length, frame: "part", edges: listed.rows, ...(listed.nextCursor ? { nextCursor: listed.nextCursor } : {}) };
  }

  /** Indexes from a list, or from the same filter `edges_find` uses. */
  private resolveEdges(obj: PlateObject, spec: Record<string, unknown>): number[] | { reason: string } {
    const raw = spec.edges;
    const empty = spec.kind === "chamfer" ? "Pick an edge to chamfer." : "Pick an edge to fillet.";
    if (Array.isArray(raw)) {
      if (raw.length === 0) return { reason: empty };
      if (!raw.every((edge) => Number.isInteger(edge))) return { reason: "Edge indexes are whole numbers." };
      return raw as number[];
    }
    if (raw && typeof raw === "object" && "select" in raw) {
      const select = (raw as { select?: unknown }).select;
      if (!select || typeof select !== "object" || Array.isArray(select)) return { reason: "edges.select is a filter." };
      if (!obj.solid) return { reason: "Describe the solid before picking edges." };
      const matched = edgesMatching(obj.solid.edges, obj.solid.faces, select as Record<string, unknown>);
      if ("reason" in matched) return matched;
      if (matched.length === 0) return { reason: "No edge matches that filter." };
      return matched.map((edge) => edge.index);
    }
    return { reason: empty };
  }

  private async workplaneSet(obj: PlateObject, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const source = input.source === "global" || input.source === "bed" || input.source === "face" ? input.source : "face";
    const origin = Array.isArray(input.origin) && input.origin.length >= 3 ? input.origin.slice(0, 3) as [number, number, number] : null;
    const turn = Array.isArray(input.turn) && input.turn.length >= 3 ? input.turn.slice(0, 3) as [number, number, number] : null;
    if (origin && turn && origin.every((value) => typeof value === "number") && turn.every((value) => typeof value === "number")) {
      obj.workplane = { source, origin, turn };
      return { ok: true, source: obj.workplane.source, origin: obj.workplane.origin, turn: obj.workplane.turn };
    }
    if (source === "global") {
      obj.workplane = { ...GLOBAL_WORKPLANE };
      return { ok: true, source: obj.workplane.source, origin: obj.workplane.origin, turn: obj.workplane.turn };
    }
    const tree = await this.opened(obj);
    if ("reason" in tree) return { ok: false, reason: tree.reason };
    if (source === "bed") {
      const box = obj.solid?.bounds ?? { min: [0, 0, 0], max: [0, 0, 0] };
      obj.workplane = workplaneOnBed(box);
      return { ok: true, source: obj.workplane.source, origin: obj.workplane.origin, turn: obj.workplane.turn };
    }
    const faceIndex = Number(input.faceIndex);
    const face = obj.solid?.faces[faceIndex];
    if (!face) return { ok: false, reason: "That face is not on this solid." };
    if (!face.normal || !obj.solid) return { ok: false, reason: CURVED_FACE };
    const plane = facePlane(obj.solid.positions, obj.solid.triangles, faceIndex, face.normal);
    if (!plane) return { ok: false, reason: CURVED_FACE };
    obj.workplane = workplaneOnFace(plane);
    return { ok: true, source: obj.workplane.source, origin: obj.workplane.origin, turn: obj.workplane.turn };
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

  private bake(obj: PlateObject, raw: unknown): { op: ModelOp; typed: Record<string, unknown> } | { reason: string } {
    if (!raw || typeof raw !== "object") return { reason: "The edit needs an op." };
    const spec = raw as Record<string, unknown>;
    const kind = spec.kind;
    if (isComposite(kind)) return { reason: `A ${kind} is several steps. Apply it with model_apply or model_apply_batch.` };
    if (kind === "scale") {
      const factor = spec.factor;
      if (typeof factor !== "number" || !Number.isFinite(factor) || factor < 0.1 || factor > 20) return { reason: "Scale is a factor from 0.1 to 20." };
      return { op: toSolidOp({ kind: "scale", factor }, obj.modelPose), typed: { kind: "scale", factor } };
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
      if (at && typeof at.u === "number" && typeof at.v === "number" && !isGlobalFrame(obj.workplane)) {
        origin = planePoint(obj.workplane, [at.u, at.v, 0]);
        axis = drillDown(obj.workplane);
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
    if (kind === "boolean") {
      const booleanOp = spec.op === "fuse" || spec.op === "common" ? spec.op : "cut";
      const local = primitiveFrom(spec, "box");
      if ("reason" in local) return local;
      const solid = planePrimitive(local, obj.workplane);
      const op = toSolidOp({ kind: "boolean", op: booleanOp, ...solid }, obj.modelPose);
      return { op, typed: { kind: "boolean", op: booleanOp, ...solid } };
    }
    if (kind === "root") {
      const local = primitiveFrom(spec, "box");
      if ("reason" in local) return local;
      const solid = rootSpec(local);
      const op: ModelOp = { kind: "root", ...solid };
      return { op, typed: { kind: "root", ...solid } };
    }
    return { reason: "That edit is not one of hole, fillet, chamfer, split, scale, boolean, join, or root." };
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
    if (tool.tree) return null;
    const opened = await this.opened(tool);
    return "reason" in opened ? opened.reason : null;
  }

  private async probe(obj: PlateObject, raw: unknown, nodeHandleValue?: unknown): Promise<Record<string, unknown>> {
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
    const baked = this.bake(obj, raw);
    if ("reason" in baked) return { ok: false, reason: baked.reason };
    return this.probeBaked(obj, tree, at, baked);
  }

  /** The check before an apply, for an op already in the solid's frame. A probe that passes is remembered for `at`. */
  private async probeBaked(obj: PlateObject, tree: ModelTree, at: number, baked: { op: ModelOp; typed: Record<string, unknown> }): Promise<Record<string, unknown>> {
    const picked = baked.op.kind === "fillet" || baked.op.kind === "chamfer" ? { edges: baked.typed.edges } : {};
    const answer = (body: Record<string, unknown>) => ({ ...body, ...picked, stored: cleanOp(baked.op as unknown as Record<string, unknown>), typed: cleanOp(baked.typed) });
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
    if (baked.op.kind === "boolean" && obj.solid) {
      const missed = disjointBoolean(obj.solid.bounds, baked.op, baked.op.op);
      if (missed) return answer({ ok: false, reason: missed, missed: true });
    }
    const tool = (baked.op.kind === "join" ? "boolean" : baked.op.kind) as ProbedTool;
    const preview = (baked.op.kind === "fillet" || baked.op.kind === "chamfer") && baked.op.edges.length > 1 ? (obj.stepTolerance || CHORD) : undefined;
    let reply: Record<string, unknown>;
    try {
      reply = await this.treeCall(probeRequest(tree.key, at, baked.op, preview), baked.op.kind);
    } catch (err) {
      const lost = this.lostReply(err);
      if (lost) return lost;
      throw err;
    }
    const view = probeFromBody(reply);
    const note = probeNote(tool, view);
    if (!note || note.bad) return answer({ ok: false, reason: note?.text ?? "This does not fit.", ...(typeof reply.maxMm === "number" ? { maxMm: reply.maxMm } : {}) });
    obj.probes.set(probeKey(String(at), baked.op), true);
    return answer({ ok: true, reason: note.text });
  }

  /**
   * model_apply. A plain op needs a passed probe, or `probe: true` to check it here first. A composite op (pattern,
   * mirror, pocket, boss, texture) always checks each step as it goes and is one undo step.
   */
  private async applyTool(obj: PlateObject, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const raw = input.op as Record<string, unknown>;
    if (isComposite(raw?.kind)) return this.applyMany(obj, [raw], { label: typeof raw.label === "string" ? raw.label : undefined, rollback: true });
    if (input.probe === true) {
      const probed = await this.probe(obj, raw);
      if (probed.ok !== true) return { ...probed, applied: false };
    }
    return this.apply(obj, raw);
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

  private async applyBaked(obj: PlateObject, tree: ModelTree, baked: { op: ModelOp; typed: Record<string, unknown> }, raw: unknown): Promise<Record<string, unknown>> {
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
      reply = await this.treeCall(applyRequest(tree.key, tree.current, node, baked.op, CHORD, otherKey), baked.op.kind);
    } catch (err) {
      const lost = this.lostReply(err);
      if (lost) return lost;
      throw err;
    }
    if (typeof reply.error === "string" && reply.error) return { ok: false, reason: plainModelError(reply.error, baked.op.kind) };
    obj.tree = withChild(obj.tree, tree.current, { id: node, op: baked.op, label: opLabel(baked.op), fingerprint: null });
    const solid = rememberSolid(reply);
    if (solid) obj.solid = solid;
    obj.probes.clear();
    const other = otherKey ? this.keepOtherHalf(obj, otherKey, reply.other, node) : undefined;
    const kept = baked.op.kind === "split" ? (keep === "both" ? "both" : this.keptSide(obj, baked.op)) : undefined;
    return { ok: true, node: nodeHandle(node), ...(other ? { other } : {}), ...(kept ? { kept } : {}), stored: cleanOp(baked.op as unknown as Record<string, unknown>), typed: cleanOp(baked.typed) };
  }

  /** What composite ops need to expand: the object's workplane, and any flat face's frame and U, V extent. */
  private expandContext(obj: PlateObject): ExpandContext {
    return {
      plane: obj.workplane,
      face: (index: number) => {
        const face = obj.solid?.faces[index];
        if (!face || !obj.solid) return { reason: "That face is not on this solid." };
        if (!face.normal) return { reason: CURVED_FACE };
        const plane = facePlane(obj.solid.positions, obj.solid.triangles, index, face.normal);
        if (!plane) return { reason: CURVED_FACE };
        const frame = workplaneOnFace(plane);
        const extent: FaceExtent = { u: [Infinity, -Infinity], v: [Infinity, -Infinity] };
        const { positions, triangles } = obj.solid;
        for (let tri = 0; tri < triangles.length; tri += 1) {
          if (triangles[tri] !== index) continue;
          for (let corner = 0; corner < 3; corner += 1) {
            const at = tri * 9 + corner * 3;
            const [u, v] = localPoint(frame, [positions[at]!, positions[at + 1]!, positions[at + 2]!]);
            extent.u = [Math.min(extent.u[0], u), Math.max(extent.u[1], u)];
            extent.v = [Math.min(extent.v[0], v), Math.max(extent.v[1], v)];
          }
        }
        return { plane: frame, extent };
      },
    };
  }

  /** A plain Boolean op typed in the object's workplane, as a part-frame piece. */
  private pieceOf(obj: PlateObject, raw: Record<string, unknown>): Piece | { reason: string } {
    const local = primitiveFrom(raw, "box");
    if ("reason" in local) return local;
    const op = raw.op === "fuse" || raw.op === "common" ? raw.op : "cut";
    return { op, spec: planePrimitive(local, obj.workplane) };
  }

  /**
   * Several edits as one: each composite op expands to Boolean steps, and every step is probed, then applied, in
   * order. The first refusal stops the run; with `rollback` the solid goes back to where it started. A run of more
   * than one step is one undo step.
   */
  private async applyMany(obj: PlateObject, raws: Record<string, unknown>[], options: { label?: string; rollback: boolean }): Promise<Record<string, unknown>> {
    const opened = await this.opened(obj);
    if ("reason" in opened) return { ok: false, reason: opened.reason };
    const start = opened.current;
    const ctx = this.expandContext(obj);
    type Step = { index: number; raw?: Record<string, unknown>; piece?: Piece; label?: string };
    const steps: Step[] = [];
    for (let index = 0; index < raws.length; index += 1) {
      const raw = raws[index]!;
      const label = typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : undefined;
      if (isComposite(raw.kind)) {
        const pieces = expand(raw, ctx, (op) => this.pieceOf(obj, op));
        if ("reason" in pieces) return { ok: false, applied: 0, failed: { index, reason: pieces.reason } };
        pieces.forEach((piece, k) => steps.push({ index, piece, label: label ? `${label} ${k + 1}/${pieces.length}` : undefined }));
      } else {
        steps.push({ index, raw, label });
      }
      if (steps.length > MAX_PIECES) return { ok: false, applied: 0, reason: `This makes more than ${MAX_PIECES} steps. Split it into smaller batches.` };
    }
    const nodes: number[] = [];
    let skipped = 0;
    for (const step of steps) {
      const tree = await this.opened(obj);
      if ("reason" in tree) return { ok: false, reason: tree.reason };
      let result: Record<string, unknown>;
      if (step.piece) {
        const op = toSolidOp({ kind: "boolean", op: step.piece.op, ...step.piece.spec }, obj.modelPose);
        const baked = { op, typed: { kind: "boolean", op: step.piece.op, ...step.piece.spec } as Record<string, unknown> };
        const probed = await this.probeBaked(obj, tree, tree.current, baked);
        if (probed.ok !== true && probed.missed === true) {
          skipped += 1;
          continue;
        }
        result = probed.ok === true ? await this.applyBaked(obj, tree, baked, {}) : probed;
        const made = parseNode(result.node);
        if (result.ok === true && step.label && made !== null) this.rename(obj, made, step.label);
      } else {
        const probed = await this.probe(obj, step.raw);
        result = probed.ok === true ? await this.apply(obj, step.raw) : probed;
      }
      if (result.ok !== true) {
        const failed = { index: step.index, reason: String(result.reason ?? "This edit did not apply."), ...(step.piece ? { piece: cleanOp({ kind: "boolean", op: step.piece.op, ...step.piece.spec }) } : {}) };
        if (options.rollback && nodes.length > 0) {
          await this.gotoNode(obj, start);
          if (obj.tree) this.drop(obj, nodes[0]!);
          return { ok: false, applied: 0, rolledBack: true, failed, node: nodeHandle(start) };
        }
        return { ok: false, applied: nodes.length, failed, ...(nodes.length ? { node: nodeHandle(nodes[nodes.length - 1]!) } : {}) };
      }
      const node = parseNode(result.node);
      if (node !== null) nodes.push(node);
    }
    if (nodes.length > 1) {
      obj.groups = [...(obj.groups ?? []), { start, end: nodes[nodes.length - 1]!, label: options.label ?? `${nodes.length} steps` }];
    }
    return {
      ok: true,
      applied: nodes.length,
      ...(skipped ? { skipped, note: `${skipped} step${skipped === 1 ? "" : "s"} missed the solid and were left out.` } : {}),
      ...(nodes.length ? { first: nodeHandle(nodes[0]!), node: nodeHandle(nodes[nodes.length - 1]!) } : {}),
      ...(options.label ? { label: options.label } : {}),
      fingerprint: obj.solid?.fingerprint ?? null,
      bounds: obj.solid?.bounds ?? null,
    };
  }

  private async applyBatch(obj: PlateObject, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const ops = Array.isArray(input.ops) ? input.ops as Record<string, unknown>[] : [];
    if (ops.length === 0) return { ok: false, reason: "The batch needs at least one op." };
    return this.applyMany(obj, ops, { label: typeof input.label === "string" ? input.label : undefined, rollback: input.onError !== "stop" });
  }

  /** A new solid, a batch of edits on it, and a commit, in one call. */
  private async build(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const base = (input.base ?? {}) as Record<string, unknown>;
    const made = await this.solidNew(base);
    if (made.ok !== true) return made;
    const obj = this.find(String(made.object));
    if (!obj) return { ok: false, reason: UNKNOWN_OBJECT };
    if (typeof input.name === "string" && input.name.trim()) obj.name = input.name.trim().slice(0, NAME_LIMIT);
    const ops = Array.isArray(input.ops) ? input.ops as Record<string, unknown>[] : [];
    const ran = ops.length ? await this.applyMany(obj, ops, { label: typeof input.label === "string" ? input.label : obj.name, rollback: input.onError !== "stop" }) : { ok: true, applied: 0 };
    if (ran.ok !== true) return { ...ran, object: obj.id, note: "The solid is on the plate without the batch. Fix the op and call model_apply_batch." };
    if (input.commit !== false) {
      const reason = await this.commitObject(obj);
      if (reason) return { ok: false, object: obj.id, reason };
    }
    return { ...ran, object: obj.id, committed: input.commit !== false, bounds: obj.solid?.bounds ?? null };
  }

  /** Session parameters: names model ops may use in place of numbers, as text such as "wallH + 2". */
  private paramsTool(input: Record<string, unknown>): Record<string, unknown> {
    if (input.clear === true) this.params = {};
    const set = (input.set ?? {}) as Record<string, unknown>;
    const merged = this.mergeParams(set);
    if ("reason" in merged) return { ok: false, reason: merged.reason };
    this.params = merged;
    return { ok: true, params: { ...this.params } };
  }

  /** `set` evaluated in order on top of the session's parameters: a later name may use an earlier one. */
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
    };
    this.objects.push(half);
    return id;
  }

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
    const reply = await this.treeCall(gotoRequest(tree.key, node, CHORD));
    if (typeof reply.error === "string" && reply.error) return { ok: false, reason: plainModelError(reply.error) };
    obj.tree = jumped(tree, node);
    const solid = rememberSolid(reply);
    if (solid) obj.solid = solid;
    return { ok: true, node: nodeHandle(node) };
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

  private async editRoot(obj: PlateObject, tree: ModelTree, node: number, raw: unknown): Promise<Record<string, unknown>> {
    const refusal = editRefusal(tree, node);
    if (refusal) return { ok: false, reason: refusal };
    const baked = this.bake(obj, raw);
    if ("reason" in baked) return { ok: false, reason: baked.reason };
    if (baked.op.kind !== "root" || tree.root.kind !== "primitive") return { ok: false, reason: "The new solid's first step takes a root edit." };
    if (!obj.probes.has(probeKey(String(node), baked.op))) return { ok: false, reason: "Probe this edit first. It was not applied." };
    const { kind: _kind, ...solid } = baked.op;
    const root = { kind: "primitive" as const, solid };
    const reply = await this.treeCall(openRequest(tree.key, root, CHORD), "root");
    if (typeof reply.error === "string" && reply.error) return { ok: false, reason: plainModelError(reply.error, "create") };
    obj.tree = { ...tree, root };
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
    const toolReason = await this.openJoinTool(raw);
    if (toolReason) return { ok: false, reason: toolReason };
    const tree = await this.opened(obj);
    if ("reason" in tree) return { ok: false, reason: tree.reason };
    if (node === null || !tree.nodes.has(node)) return { ok: false, reason: "That step is not in the history." };
    const parent = tree.nodes.get(node)?.parent;
    if (parent === null || parent === undefined) return this.editRoot(obj, tree, node, raw);
    const baked = this.bake(obj, raw);
    if ("reason" in baked) return { ok: false, reason: baked.reason };
    const probed = [parent, node, tree.current].some((id) => obj.probes.has(probeKey(String(id), baked.op)));
    if (!probed) return { ok: false, reason: "Probe this edit first. It was not applied." };
    if (baked.op.kind === "split") {
      const note = this.splitCheck(obj, baked.op);
      if (note.bad) return { ok: false, reason: note.text };
    } else if (baked.op.kind !== "scale") {
      const tool = (baked.op.kind === "join" ? "boolean" : baked.op.kind) as ProbedTool;
      const checked = await this.treeCall(probeRequest(tree.key, parent, baked.op));
      const view = probeFromBody(checked);
      const fit = probeNote(tool, view);
      if (!fit || fit.bad) return { ok: false, reason: fit?.text ?? "This does not fit." };
    }
    const replayIds = replayChain(tree, node, tree.current);
    const replayOps = replayIds.map((id) => tree.nodes.get(id)?.op).filter((op): op is ModelOp => op != null);
    const twin = builtBranch(tree, parent, baked.op, replayOps);
    if (twin != null) return this.gotoNode(obj, twin);
    const joins = this.toolLinks(tree, [node, ...replayIds]);
    const levels = crossEdit(tree, joins, node, baked.op, replayIds, (key, need) => this.reserveOn(key, need));
    const own = levels[levels.length - 1];
    if (!own) return { ok: false, reason: "That step could not be rebuilt." };
    const reply = await this.treeCall(crossEditRequest(levels, obj.stepTolerance || CHORD));
    if (typeof reply.error === "string" && reply.error) return { ok: false, reason: plainModelError(reply.error) };
    const built = readBuilt(reply.built);
    const broken = readBroken(reply.broken);
    const ids = [own.node, ...own.replay.map((step) => step.id)];
    const steps = ids.map((id, index) => {
      const made = built?.get(id);
      return {
        id,
        op: made?.op ?? (index === 0 ? own.op : own.replay[index - 1]!.op),
        fingerprint: made?.fingerprint ?? null,
        ...(broken?.id === id ? { broken: broken.error } : {}),
      };
    });
    const tip = [...steps].reverse().find((step) => !step.broken)?.id ?? ids[0]!;
    const host = obj.tree ?? tree;
    obj.tree = forked(host, own.parent, steps, tip);
    this.forkTools(levels.slice(0, -1), reply.tools);
    const solid = rememberSolid(reply);
    if (solid) obj.solid = solid;
    obj.probes.clear();
    return { ok: true, node: nodeHandle(tip), built: broken == null, broken: broken != null };
  }

  /** Fresh ids on the tree `key` names. An edit spends them even when the engine keeps only some. */
  private reserveOn(key: string, need: number): NodeId[] {
    const host = this.objects.find((row) => row.tree?.key === key);
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
      const tool = this.objects.find((row) => row.tree?.key === op.tool.key);
      if (!tool?.tree) continue;
      links.push({ tree: tool.tree, id: op.tool.node, op });
    }
    return links;
  }

  /** A join's tool trees take the branches the edit reply kept. */
  private forkTools(levels: { key: string; parent: NodeId; node: NodeId; op: ModelOp; replay: { id: NodeId; op: ModelOp }[] }[], tools: unknown): void {
    const parts = Array.isArray(tools) ? tools as { built?: unknown; broken?: unknown }[] : [];
    levels.forEach((level, index) => {
      const host = this.objects.find((row) => row.tree?.key === level.key);
      if (!host?.tree) return;
      const made = readBuilt(parts[index]?.built);
      const broken = readBroken(parts[index]?.broken);
      const ids = [level.node, ...level.replay.map((step) => step.id)];
      const steps = ids.map((id, step) => ({
        id,
        op: made?.get(id)?.op ?? (step === 0 ? level.op : level.replay[step - 1]!.op),
        fingerprint: made?.get(id)?.fingerprint ?? null,
        ...(broken?.id === id ? { broken: broken.error } : {}),
      }));
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
    return { ok: true, scalePercent: obj.scale * 100, triangles: obj.triangles };
  }

  /** The plate mesh becomes the solid on screen. A second commit of the same node does not export again. */
  private async commitObject(obj: PlateObject): Promise<string | null> {
    const tree = obj.tree;
    if (!tree || !obj.solid || obj.solid.positions.length < 9) return null;
    if (obj.platedNode === tree.current && obj.bytes.byteLength > 0) return null;
    const from = obj.platedNode;
    let reply: Record<string, unknown>;
    try {
      reply = await this.treeCall(exportRequest(tree.key, tree.current), "export");
    } catch (err) {
      if (err instanceof ModelRunaway) return err.message;
      throw err;
    }
    const step = this.stepBytes(reply);
    if (!step) return typeof reply.error === "string" ? plainModelError(reply.error) : "The solid was not exported.";
    const copy = Float32Array.from(obj.solid.positions);
    obj.seatMm = settleBy(copy);
    obj.source = copy;
    obj.triangles = copy.length / 9;
    obj.bytes = step;
    if (/\.(stl|3mf)$/i.test(obj.fileName)) obj.fileName = obj.fileName.replace(/\.(stl|3mf)$/i, ".step");
    if (this.scaleSince(tree, from, tree.current)) obj.scale = 1;
    obj.platedNode = tree.current;
    obj.tree = { ...obj.tree!, committed: tree.current };
    return null;
  }

  /** True when a scale step sits strictly after `from` on the way to `to`. */
  private scaleSince(tree: ModelTree, from: number | null, to: number): boolean {
    for (let at: number | null = to; at !== null && at !== from; at = tree.nodes.get(at)?.parent ?? null) {
      if (tree.nodes.get(at)?.op?.kind === "scale") return true;
    }
    return false;
  }

  private async commitAll(): Promise<string | null> {
    for (const obj of this.objects) {
      const reason = await this.commitObject(obj);
      if (reason) return reason;
    }
    return null;
  }

  private async exportStep(obj: PlateObject, name: string): Promise<Record<string, unknown>> {
    const tree = await this.opened(obj);
    if ("reason" in tree) return { ok: false, reason: tree.reason };
    let reply: Record<string, unknown>;
    try {
      reply = await this.treeCall(exportRequest(tree.key, tree.current), "export");
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
    const left = frame === "workplane" ? localPoint(obj.workplane, a as [number, number, number]) : a as [number, number, number];
    const right = frame === "workplane" ? localPoint(obj.workplane, b as [number, number, number]) : b as [number, number, number];
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
    const colourBy: ColorMode = input.colourBy === "speed" || input.colourBy === "weight" ? input.colourBy : "feature";
    const paths = layerPaths(layer.paths, layer.z, 0.05);
    const png = pathsPng(paths, typeof input.longEdge === "number" ? input.longEdge : 256, colourBy);
    const path = resolveWrite(typeof input.name === "string" ? input.name : `layer-${layer.index}.png`, ".png");
    writeFileSync(path, png);
    return { ok: true, path, bytes: png.byteLength, sha256: createHash("sha256").update(png).digest("hex") };
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
