/**
 * One stdio connection is one plate. The engine is behind `Engine`.
 * Feasibility refusals are `{ok:false, reason}` and are decided before apply.
 */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { base64ToBytes, bytesToBase64 } from "../src/base64.ts";
import { coverageWarning, fnv1aHex, inAirWarning } from "../src/slice-action.ts";
import { fanDefaults } from "../src/fan.ts";
import { filamentGrams, groupFeatures } from "../src/estimate.ts";
import { humanEngineError } from "../src/engine-wording.ts";
import { foreign3mfMessage, foreignSlicer3mf } from "../src/foreign-3mf.ts";
import { meshWarningText, type MeshRepair } from "../src/app/mesh-warning.ts";
import { plainModelError } from "../src/app/model-error.ts";
import { centeringShift, encode3mf, ID_MATRIX, layFlatMatrix, matMul, offBed, placeMesh, rotX, rotY, rotZ, scaledCanonical, settleBy, type Bounds, type Mat3 } from "../src/mesh-place.ts";
import { decodeSolid } from "../src/model-reply.ts";
import { probeFromBody, probeKey, probeNote, type ProbedTool } from "../src/model-feasibility.ts";
import { builtBranch, crossEdit, forked, replayChain, type ToolLink } from "../src/model-edit.ts";
import { dropRefusal } from "../src/model-history.ts";
import { throughLength } from "../src/model-hole.ts";
import { extentAlong, facePlane, splitBase, splitNote, splitPlaneInside, tiltRings, valueRange, type SplitPlan, type Vec3 as PlaneVec } from "../src/model-plane.ts";
import { rootSpec, type PrimitiveSpec } from "../src/model-primitive.ts";
import { readFingerprint } from "../src/model-reply.ts";
import { applyRequest, crossEditRequest, editRequest, exportRequest, gotoRequest, joinOp, newSolidRequest, openRequest, probeRequest } from "../src/model-request.ts";
import { IDENTITY_POSE, toSolidOp, type Affine } from "../src/model-space.ts";
import { dropped, jumped, newTree, opLabel, redoTarget, reserveId, undoTarget, withChild, type Fingerprint, type ModelOp, type ModelTree, type NodeId } from "../src/model-tree.ts";
import { DEFAULT_PRESET, presetKeys, type PresetSettings } from "../src/presets.ts";
import { meshRecord, parseProject, serializeProject, type LimeProject, type ProjectPlacement, type ProjectProfile } from "../src/project.ts";
import type { LayerAction } from "../src/layer-actions.ts";
import { CURVED_FACE, GLOBAL_WORKPLANE, drillDown, isGlobalFrame, localPoint, planePoint, planePrimitive, workplaneOnFace, type Workplane } from "../src/workplane.ts";
import { eulerOrient, orientEuler } from "../src/mesh-place.ts";
import { plateFileIsVersion2 } from "../src/plate.ts";
import { builtinLibrary, adoptProfile, enginePrinter, heatFor, parseMachineFile, type FilamentRecord, type MachineLibrary, type PrinterRecord } from "../src/ui/machine-library.ts";
import { parseSettingsProfile } from "../src/ui/settings-profiles.ts";

import { mirror } from "./bridge-client.ts";
import { ProtocolError, type Engine } from "./engine.ts";
import { appVersion, exportGcode, mass } from "./export-gcode.ts";
import { renderMesh, type Camera } from "./render.ts";
import { applyPreset, blendOf, sessionSliceRequest, stlBytes } from "./request.ts";
import { reviewGcode } from "./review.ts";
import { validateTool } from "./schema.ts";
import { resolveRead, resolveWrite } from "./workspace.ts";

const OVERLAP = "These parts overlap. Move one before slicing.";
const CHORD = 0.05;
const STEP = 0.05;
const SLICE_WAIT_DEFAULT_S = 20;
const SLICE_WAIT_MAX_S = 120;
const STALE_SLICE = "The printer, filament, settings, or placement changed after this slice. Slice again.";
const MESH_EDIT = "Model edits need a STEP file or a new solid. This part is a mesh.";

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
    faces: solid.faces.map((face) => ({ areaMm2: face.areaMm2, ...(face.normal ? { normal: [...face.normal] as [number, number, number] } : {}) })),
    edges: solid.edges.map((edge) => {
      const points = edge.points;
      const midAt = Math.max(0, Math.floor(points.length / 6) * 3);
      const mid: [number, number, number] = points.length >= 3 ? [points[midAt] ?? 0, points[midAt + 1] ?? 0, points[midAt + 2] ?? 0] : [0, 0, 0];
      return { lengthMm: edge.lengthMm, mid };
    }),
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

function nodeHandle(id: NodeId): string {
  return `node_${id}`;
}

function parseNode(handle: unknown): number | null {
  if (typeof handle !== "string") return null;
  const match = /^node_(\d+)$/.exec(handle);
  return match ? Number(match[1]) : null;
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
  onProgress: ((job: string, fraction: number, stage: string, token?: string | number) => void) | null = null;

  constructor(engine: Engine) {
    this.engine = engine;
  }

  call(name: string, args: unknown, meta?: CallMeta): Promise<Record<string, unknown>> {
    const problem = validateTool(name, args ?? {});
    if (problem) throw new ProtocolError(problem);
    const input = (args ?? {}) as Record<string, unknown>;
    const result = this.dispatch(name, input, meta);
    return Promise.resolve(result).then((value) => {
      this.lastBridge = this.bridgePayload(name, input, value);
      void mirror(this.lastBridge);
      return value;
    });
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

  private bridgePayload(name: string, input: Record<string, unknown>, value: Record<string, unknown>): Record<string, unknown> {
    const objectId = typeof input.object === "string" ? input.object : "";
    const obj = objectId ? this.find(objectId) : null;
    const placement = name === "object_place" && value.ok === true && obj
      ? { orient: [...obj.orient], scale: obj.scale, centered: obj.centered, offset: { ...obj.offset } }
      : undefined;
    const settings = name === "settings_apply" && value.ok === true
      ? {
          layerHeight: this.settings.layerHeight,
          supports: this.settings.supports,
          blendKind: this.settings.blendKind,
          strategy: this.settings.strategy,
          toughness: this.settings.toughness,
        }
      : undefined;
    return {
      tool: name,
      ...(obj ? { objectId: obj.id, objectName: obj.name } : {}),
      ok: value.ok === true,
      ...(placement ? { placement } : {}),
      ...(settings ? { settings } : {}),
    };
  }

  private dispatch(name: string, input: Record<string, unknown>, meta?: CallMeta): Record<string, unknown> | Promise<Record<string, unknown>> {
    switch (name) {
      case "session_info": return this.sessionInfo();
      case "project_open": return this.projectOpen(String(input.path));
      case "project_create": return this.projectCreate();
      case "project_save": return this.projectSave(String(input.name));
      case "mesh_import": return this.meshImport(String(input.path), typeof input.stepToleranceMm === "number" ? input.stepToleranceMm : STEP);
      case "plate_list": return this.plateList(input);
      case "object_select": return this.objectSelect(String(input.object));
      case "object_place": return this.objectPlace(input);
      case "object_remove": return this.objectRemove(String(input.object));
      case "machine_list": return this.machineList(input);
      case "machine_select": return this.machineSelect(String(input.printerId), String(input.filamentId), input.nozzleMm);
      case "machine_load": return this.machineLoad(String(input.path));
      case "settings_apply": return this.settingsApply(input);
      case "slice_start": return this.sliceStart(input.cancelRunning === true);
      case "slice_wait": return this.sliceWait(String(input.job), meta, typeof input.timeoutS === "number" ? input.timeoutS : undefined);
      case "slice_cancel": return this.sliceCancel(String(input.job));
      case "gcode_summary": return this.gcodeSummary(typeof input.job === "string" ? input.job : undefined);
      case "gcode_export": return this.gcodeExport(input);
      case "export_3mf": return this.export3mf(String(input.name));
      case "mesh_stats": return this.meshStats(String(input.object));
      case "layer_summary": return this.layerSummary(typeof input.job === "string" ? input.job : undefined);
      case "render_view": return this.renderView(input);
      default: return this.model(name, input);
    }
  }

  private async sessionInfo(): Promise<Record<string, unknown>> {
    let engine = "unknown";
    let occt = false;
    try {
      engine = await this.ask(this.engine.version());
      occt = await this.ask(this.engine.occt());
    } catch (err) {
      engine = err instanceof Error ? err.message : "The engine did not answer.";
    }
    return {
      ok: true,
      serverVersion: appVersion(),
      engine,
      occt,
      workspace: process.env.LIME_MCP_WORKSPACE ?? "",
      printer: this.printer().name,
      filament: this.filament().name,
      printerSend: false,
    };
  }

  private printer(): PrinterRecord {
    return this.library.printers.find((row) => row.id === this.library.printerId) ?? this.library.printers[0]!;
  }

  private filament(): FilamentRecord {
    return this.library.filaments.find((row) => row.id === this.library.filamentId) ?? this.library.filaments[0]!;
  }

  private addObject(partial: Omit<PlateObject, "id" | "modelPose" | "workplane" | "tree" | "solid" | "probes" | "stepTolerance"> & Partial<Pick<PlateObject, "stepTolerance">>, id?: string): PlateObject {
    const obj: PlateObject = {
      modelPose: IDENTITY_POSE,
      workplane: GLOBAL_WORKPLANE,
      tree: null,
      solid: null,
      probes: new Map(),
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
    const reply = JSON.parse(await this.ask(this.engine.meshPreview(JSON.stringify({
      filename,
      dataB64: bytesToBase64(bytes),
      stepToleranceMm: tolerance,
    })))) as { error?: string; triangles?: number; positionsB64?: string; seatMm?: number };
    if (reply.error || !reply.positionsB64) throw new ProtocolError(reply.error ?? "The mesh could not be read.");
    return {
      triangles: reply.triangles ?? 0,
      source: positionsFrom(reply.positionsB64),
      seatMm: reply.seatMm ?? 0,
    };
  }

  private async projectCreate(): Promise<Record<string, unknown>> {
    await this.forgetObjects();
    this.objects.length = 0;
    this.selected = "";
    this.actions = [];
    this.settings = { ...DEFAULT_PRESET };
    this.sourceProject = null;
    this.sourceHash = "";
    this.sourcePath = "";
    this.profileTouched = false;
    return { ok: true, project: "project" };
  }

  private async projectOpen(path: string): Promise<Record<string, unknown>> {
    const full = resolveRead(path, "lime");
    const parsed = parseProject(await readFile(full, "utf8"));
    if (!parsed.ok) return { ok: false, reason: parsed.message };
    await this.forgetObjects();
    this.objects.length = 0;
    this.settings = { ...parsed.project.settings };
    this.actions = parsed.project.layerActions ? parsed.project.layerActions.map((action) => ({ ...action })) : [];
    this.sourceProject = structuredClone(parsed.project);
    this.sourceHash = createHash("sha256").update(readFileSync(full)).digest("hex");
    this.sourcePath = realpathSync(full);
    this.profileTouched = false;
    this.adoptProjectMachine(parsed.project.profile);
    const rows = parsed.project.objects?.length
      ? parsed.project.objects.map((obj) => ({ id: obj.id, name: obj.name, file: obj.mesh.name, bytes: base64ToBytes(obj.mesh.bytesBase64), placement: obj.placement }))
      : [{ id: undefined as string | undefined, name: parsed.project.mesh.name, file: parsed.project.mesh.name, bytes: base64ToBytes(parsed.project.mesh.bytesBase64), placement: parsed.project.placement }];
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
      }, row.id);
      objects.push({ object: obj.id, name: obj.name });
    }
    return {
      ok: true,
      project: "project",
      version: parsed.project.version,
      printer: this.printer().name,
      filament: this.filament().name,
      objects,
      ...(parsed.project.unreadHistory?.length ? { unreadHistory: parsed.project.unreadHistory } : {}),
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
    return {
      id: obj.id,
      name: obj.name,
      mesh: meshRecord(obj.fileName, obj.bytes),
      placement: this.placementOf(obj),
      supportEdits: [],
    };
  }

  private freshDocument(): LimeProject {
    const first = this.objects[0];
    const profile = enginePrinter(this.printer(), this.filament(), this.library.nozzleMm);
    const mesh = first ? meshRecord(first.fileName, first.bytes) : meshRecord("empty.stl", new Uint8Array());
    const objects = this.objects.map((obj) => this.fileObject(obj));
    return {
      version: objects.length > 1 ? 2 : 1,
      mesh,
      placement: first ? this.placementOf(first) : { orient: [...ID_MATRIX] as ProjectPlacement["orient"], scale: 1, centered: true, offset: { x: 0, y: 0, z: 0 }, stepTolerance: STEP },
      settings: this.settings,
      preset: null,
      profile,
      level: "simple",
      supportEdits: [],
      ...(objects.length > 1 ? { objects } : {}),
      ...(this.actions.length ? { layerActions: this.actions } : {}),
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
      const kept = base.objects.filter((obj) => live.has(obj.id)).map((obj) => ({ ...obj, placement: this.placementOf(live.get(obj.id)!) }));
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
      return base;
    }
    const obj = this.objects[0];
    if (obj) {
      const next = meshRecord(obj.fileName, obj.bytes);
      if (next.hash !== base.mesh.hash || next.name !== base.mesh.name) base.mesh = next;
      base.placement = this.placementOf(obj);
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

  private async projectSave(name: string): Promise<Record<string, unknown>> {
    if (this.objects.length === 0) return { ok: false, reason: "The plate is empty." };
    const committed = await this.commitAll();
    if (committed) return { ok: false, reason: committed };
    const path = resolveWrite(name, ".lime");
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
      name: obj.name,
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
        name: obj.name,
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
    if (!obj) return { ok: false, reason: "That object is not on the plate." };
    this.selected = obj.id;
    return { ok: true, object: obj.id, name: obj.name };
  }

  private objectPlace(input: Record<string, unknown>): Record<string, unknown> {
    const obj = this.find(String(input.object));
    if (!obj) return { ok: false, reason: "That object is not on the plate." };
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
      reslice,
    };
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
    if (index < 0) return { ok: false, reason: "That object is not on the plate." };
    const leaving = this.objects[index];
    if (leaving) await this.closeTree(leaving);
    this.objects.splice(index, 1);
    if (this.selected === id) this.selected = this.objects[0]?.id ?? "";
    return { ok: true, objects: this.objects.map((obj) => obj.id) };
  }

  private machineList(input: Record<string, unknown>): Record<string, unknown> {
    const rows = [
      ...this.library.printers.map((row) => ({ id: row.id, name: row.name, kind: row.kind })),
      ...this.library.filaments.map((row) => ({ id: row.id, name: row.name, material: row.material })),
    ];
    const listed = page(rows, input.cursor, input.limit);
    return { ok: true, machines: listed.rows, ...(listed.nextCursor ? { nextCursor: listed.nextCursor } : {}) };
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
    if (typeof input.layerHeight === "number" && (input.layerHeight < 0.08 || input.layerHeight > 0.4)) {
      return { ok: false, reason: "Layer height must be from 0.08–0.4 mm.", changed: [] };
    }
    if (typeof input.path === "string") {
      const parsed = parseSettingsProfile(readFileSync(resolveRead(input.path, "profile"), "utf8"));
      if (!parsed.ok) return { ok: false, reason: parsed.message, changed: [] };
      this.settings = { ...parsed.profile.settings };
    }
    if (typeof input.preset === "string") this.settings = applyPreset(this.settings, input.preset);
    if (typeof input.layerHeight === "number") this.settings = { ...this.settings, layerHeight: input.layerHeight };
    if (typeof input.supports === "boolean") this.settings = { ...this.settings, supports: input.supports };
    const changed = presetKeys().filter((key) => this.settings[key] !== DEFAULT_PRESET[key]);
    return { ok: true, changed };
  }

  private selectedObject(): PlateObject | null {
    return this.find(this.selected) ?? this.objects[0] ?? null;
  }

  private sliceBody(obj: PlateObject): Record<string, unknown> {
    const placed = this.placed(obj);
    const name = /\.(3mf|step|stp)$/i.test(obj.fileName) ? obj.fileName.replace(/\.(3mf|step|stp)$/i, ".stl") : obj.fileName;
    return sessionSliceRequest({
      filename: name,
      bytes: stlBytes(scaledCanonical(obj.source, obj.scale), name),
      pose: placed.pose,
      settings: this.settings,
      printer: this.printer(),
      filament: this.filament(),
      nozzleMm: this.library.nozzleMm,
      actions: this.actions,
      objects: 1,
      bounds: placed.bounds,
      stepToleranceMm: obj.stepTolerance,
    });
  }

  private async sliceStart(cancelRunning: boolean): Promise<Record<string, unknown>> {
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
    const started = JSON.parse(await this.ask(this.engine.sliceStart(JSON.stringify(this.sliceBody(obj))))) as { id?: number; error?: string };
    if (typeof started.id !== "number") return { ok: false, reason: humanEngineError(started.error ?? "The slice did not start.") };
    this.jobSeq += 1;
    const job: Job = { handle: `job_${this.jobSeq}`, engineId: started.id, objectId: obj.id, stamp: this.sliceStamp(obj), status: "running" };
    this.running = job;
    this.retainJobs(job);
    return { ok: true, job: job.handle, status: "running", object: obj.id, name: obj.name };
  }

  private sliceStamp(obj: PlateObject): string {
    return JSON.stringify({
      printerId: this.library.printerId,
      filamentId: this.library.filamentId,
      nozzleMm: this.library.nozzleMm,
      settings: this.settings,
      objectId: obj.id,
      orient: obj.orient,
      scale: obj.scale,
      centered: obj.centered,
      offset: obj.offset,
    });
  }

  private staleReason(job: Job): string | null {
    const obj = this.find(job.objectId);
    if (!obj || !job.stamp || this.sliceStamp(obj) !== job.stamp) return STALE_SLICE;
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
        this.onProgress?.(job.handle, fraction, stage, meta?.progressToken);
      }
      if (poll.status === "done" && poll.result) {
        job.status = "done";
        job.wire = JSON.parse(poll.result) as Record<string, unknown>;
        job.gcode = typeof job.wire.gcode === "string" ? job.wire.gcode : undefined;
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
      name: named?.name,
      seconds: summary.seconds,
      grams: summary.grams,
      filamentMm: summary.filamentMm,
      warnings: summary.warnings,
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
    const review = reviewGcode(this.fileText(job, new Date(Date.UTC(2020, 0, 2, 3, 4, 5))));
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
    };
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
    if (!obj) return { ok: false, reason: "That object is not on the plate." };
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
    if (uri === "lime://session") {
      return { workspace: process.env.LIME_MCP_WORKSPACE ?? "", selected: this.selected, objects: this.objects.map((obj) => obj.id), printer: this.library.printerId, filament: this.library.filamentId, running: this.running?.handle ?? null };
    }
    if (uri === "lime://machines") {
      return { printers: this.library.printers.map((row) => ({ id: row.id, name: row.name, bedMm: [row.bedX, row.bedY, row.bedZ] })), filaments: this.library.filaments.map((row) => ({ id: row.id, name: row.name, material: row.material })) };
    }
    if (uri === "lime://project") {
      const changed = presetKeys().filter((key) => this.settings[key] !== DEFAULT_PRESET[key]);
      return { objects: this.objects.map((obj) => ({ object: obj.id, name: obj.name })), changed };
    }
    if (uri === "lime://slice/latest") {
      if (!this.latest?.wire) return { ready: false };
      const summary = this.summarize(this.latest);
      return { seconds: summary.seconds, grams: summary.grams, warnings: summary.warnings };
    }
    if (uri === "lime://gcode/latest/summary") return this.gcodeSummary();
    const history = /^lime:\/\/object\/([^/]+)\/history$/.exec(uri);
    if (history) return this.model("model_history", { object: history[1]! });
    throw new ProtocolError("That resource is not on this server.");
  }

  private model(name: string, input: Record<string, unknown>): Record<string, unknown> {
    if (name === "solid_new") return this.solidNew(input);
    const obj = this.find(String(input.object ?? ""));
    if (!obj) return { ok: false, reason: "That object is not on the plate." };
    switch (name) {
      case "model_describe": return this.describe(obj, input);
      case "workplane_set": return this.workplaneSet(obj, Number(input.faceIndex));
      case "workplane_print_up": return this.printUp(obj);
      case "model_place": return this.modelPlace(obj, input);
      case "model_probe": return this.probe(obj, input.op, input.node);
      case "model_apply": return this.apply(obj, input.op, false);
      case "model_history": return this.history(obj, input);
      case "model_goto": return this.gotoNode(obj, parseNode(input.node));
      case "model_undo": return this.step(obj, "undo");
      case "model_redo": return this.step(obj, "redo");
      case "model_edit": return this.edit(obj, parseNode(input.node), input.op);
      case "model_drop": return this.drop(obj, parseNode(input.node));
      case "model_commit": return this.commit(obj);
      case "model_export_step": return this.exportStep(obj, String(input.name));
      case "measure": return this.measure(obj, input);
      default: throw new ProtocolError(`There is no tool named ${name}.`);
    }
  }

  private async treeCall(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    let text = "";
    try {
      text = await this.ask(this.engine.modelTree(JSON.stringify(body)));
    } catch (err) {
      throw new ProtocolError(err instanceof Error ? err.message : "The modeler did not answer.");
    }
    let reply: Record<string, unknown>;
    try {
      reply = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new ProtocolError("The modeler returned a damaged reply.");
    }
    const error = typeof reply.error === "string" ? reply.error : "";
    if (error.includes("was not found") || error.includes("Could not load the Open CASCADE bridge")) {
      throw new ProtocolError(error);
    }
    return reply;
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
    const kind = input.primitive === "cylinder" || input.primitive === "sphere" ? input.primitive : "box";
    const dx = typeof input.dx === "number" ? input.dx : 20;
    const dy = typeof input.dy === "number" ? input.dy : 20;
    const dz = typeof input.dz === "number" ? input.dz : 20;
    const typed: PrimitiveSpec = { primitive: kind, origin: [0, 0, 0], size: [dx, dy, dz], radius: kind === "box" ? 0 : dx / 2, height: dz, turn: [0, 0, 0] };
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
    };
    this.objects.push(obj);
    this.selected = obj.id;
    return { ok: true, object: obj.id, fingerprint: obj.solid?.fingerprint ?? null };
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
    const faces = page(solid.faces.map((face, index) => ({ index, areaMm2: face.areaMm2, ...(face.normal ? { normal: face.normal } : {}) })), input.facesCursor ?? input.cursor, input.limit);
    const edges = page(solid.edges.map((edge, index) => ({ index, mid: edge.mid, lengthMm: edge.lengthMm })), input.edgesCursor, input.limit);
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

  private async workplaneSet(obj: PlateObject, faceIndex: number): Promise<Record<string, unknown>> {
    const tree = await this.opened(obj);
    if ("reason" in tree) return { ok: false, reason: tree.reason };
    const face = obj.solid?.faces[faceIndex];
    if (!face) return { ok: false, reason: "That face is not on this solid." };
    if (!face.normal || !obj.solid) return { ok: false, reason: CURVED_FACE };
    const plane = facePlane(obj.solid.positions, obj.solid.triangles, faceIndex, face.normal);
    if (!plane) return { ok: false, reason: CURVED_FACE };
    obj.workplane = workplaneOnFace(plane);
    return { ok: true, source: obj.workplane.source, origin: obj.workplane.origin, turn: obj.workplane.turn };
  }

  private printUp(obj: PlateObject): Record<string, unknown> {
    const frame = eulerOrient(obj.workplane.turn[0], obj.workplane.turn[1], obj.workplane.turn[2]);
    obj.orient = [frame[0], frame[3], frame[6], frame[1], frame[4], frame[7], frame[2], frame[5], frame[8]];
    return { ok: true, reslice: true };
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
      const edges = Array.isArray(spec.edges) ? spec.edges.filter((edge): edge is number => Number.isInteger(edge)) : [];
      const size = spec.size;
      if (edges.length === 0) return { reason: kind === "fillet" ? "Pick an edge to fillet." : "Pick an edge to chamfer." };
      if (typeof size !== "number") return { reason: "This edit needs a size in millimetres." };
      const op: ModelOp = { kind, edges, size };
      return { op: toSolidOp(op, obj.modelPose), typed: { kind, edges, size } };
    }
    if (kind === "hole") {
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
      const op: ModelOp = { kind: "hole", origin, axis, radius, depth, ...(through ? { through: true as const } : {}), ...counterbore };
      return { op: toSolidOp(op, obj.modelPose), typed: { kind: "hole", diameterMm: radius * 2, ...(through ? { through: true } : { depth }), ...counterbore } };
    }
    if (kind === "join") {
      const tool = this.find(String(spec.toolObject ?? ""));
      if (!tool?.tree) return { reason: "The tool object has no solid yet." };
      const op = joinOp((spec.op === "fuse" || spec.op === "common" ? spec.op : "cut"), { object: tool.id, key: tool.tree.key, node: tool.tree.current, name: tool.name }, obj.modelPose, tool.modelPose, spec.keepTool === true);
      return { op, typed: { kind: "join", toolObject: tool.id, keepTool: spec.keepTool === true } };
    }
    if (kind === "boolean") {
      const primitive = spec.primitive === "cylinder" || spec.primitive === "sphere" ? spec.primitive : "box";
      const booleanOp = spec.op === "fuse" || spec.op === "common" ? spec.op : "cut";
      const dx = typeof spec.dx === "number" ? spec.dx : 10;
      const dy = typeof spec.dy === "number" ? spec.dy : dx;
      const dz = typeof spec.dz === "number" ? spec.dz : dx;
      const origin = (Array.isArray(spec.origin) ? spec.origin : [0, 0, 0]) as [number, number, number];
      const turn = (Array.isArray(spec.turn) ? spec.turn : [0, 0, 0]) as [number, number, number];
      const local: PrimitiveSpec = primitive === "cylinder"
        ? { primitive, origin, size: [0, 0, 0], radius: dx / 2, height: dz, turn }
        : primitive === "sphere"
          ? { primitive, origin, size: [0, 0, 0], radius: dx / 2, height: 0, turn: [0, 0, 0] }
          : { primitive: "box", origin, size: [dx, dy, dz], radius: 0, height: 0, turn };
      const solid = planePrimitive(local, obj.workplane);
      const op = toSolidOp({ kind: "boolean", op: booleanOp, ...solid }, obj.modelPose);
      return { op, typed: { kind: "boolean", op: booleanOp, primitive, dx, dy, dz } };
    }
    return { reason: "That edit is not one of hole, fillet, chamfer, split, scale, boolean, or join." };
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
    const window = { min: extent.min, max: extent.max, mid: (extent.min + extent.max) / 2 };
    const range = valueRange(base, normal, window);
    const along = base.dir[0] * (op.origin[0] - base.base[0]) + base.dir[1] * (op.origin[1] - base.base[1]) + base.dir[2] * (op.origin[2] - base.base[2]);
    const plan: SplitPlan = {
      base,
      value: along,
      origin: [...op.origin] as PlaneVec,
      normal,
      range,
      inside: splitPlaneInside(along, range),
      rings: tiltRings(base.normal, 0),
    };
    return splitNote({ plan });
  }

  private async probe(obj: PlateObject, raw: unknown, nodeHandleValue?: unknown): Promise<Record<string, unknown>> {
    const tree = await this.opened(obj);
    if ("reason" in tree) return { ok: false, reason: tree.reason };
    const asked = parseNode(nodeHandleValue);
    const at = asked ?? tree.current;
    if (asked !== null && !tree.nodes.has(asked)) return { ok: false, reason: "That step is not in the history." };
    const baked = this.bake(obj, raw);
    if ("reason" in baked) return { ok: false, reason: baked.reason };
    if (baked.op.kind === "scale") {
      obj.probes.set(probeKey(String(at), baked.op), true);
      return { ok: true, reason: "This scale fits.", stored: baked.op, typed: baked.typed };
    }
    if (baked.op.kind === "split") {
      const note = this.splitCheck(obj, baked.op);
      if (note.bad) return { ok: false, reason: note.text, stored: baked.op, typed: baked.typed };
      obj.probes.set(probeKey(String(at), baked.op), true);
      return { ok: true, reason: note.text, stored: baked.op, typed: baked.typed };
    }
    const tool = (baked.op.kind === "join" ? "boolean" : baked.op.kind) as ProbedTool;
    const reply = await this.treeCall(probeRequest(tree.key, at, baked.op));
    const view = probeFromBody(reply);
    const note = probeNote(tool, view);
    if (!note || note.bad) return { ok: false, reason: note?.text ?? "This does not fit.", ...(typeof reply.maxMm === "number" ? { maxMm: reply.maxMm } : {}), stored: baked.op, typed: baked.typed };
    obj.probes.set(probeKey(String(at), baked.op), true);
    return { ok: true, reason: note.text, stored: baked.op, typed: baked.typed };
  }

  private async apply(obj: PlateObject, raw: unknown, edit: boolean): Promise<Record<string, unknown>> {
    const tree = await this.opened(obj);
    if ("reason" in tree) return { ok: false, reason: tree.reason };
    const baked = this.bake(obj, raw);
    if ("reason" in baked) return { ok: false, reason: baked.reason };
    if (baked.op.kind === "split") {
      const note = this.splitCheck(obj, baked.op);
      if (note.bad) return { ok: false, reason: note.text };
    }
    const key = probeKey(String(tree.current), baked.op);
    if (!obj.probes.has(key)) return { ok: false, reason: "Probe this edit first. It was not applied." };
    const [reserved, node] = reserveId(tree);
    obj.tree = reserved;
    const reply = await this.treeCall(applyRequest(tree.key, tree.current, node, baked.op, CHORD));
    if (typeof reply.error === "string" && reply.error) return { ok: false, reason: plainModelError(reply.error, baked.op.kind) };
    obj.tree = withChild(obj.tree, tree.current, { id: node, op: baked.op, label: opLabel(baked.op), fingerprint: null });
    const solid = rememberSolid(reply);
    if (solid) obj.solid = solid;
    obj.probes.clear();
    return { ok: true, node: nodeHandle(node), ...(edit ? {} : {}), stored: baked.op, typed: baked.typed };
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
    const target = direction === "undo" ? undoTarget(tree) : redoTarget(tree);
    if (target === null) return { ok: false, reason: direction === "undo" ? "This is the start of the history." : "There is nothing to redo." };
    return this.gotoNode(obj, target);
  }

  private async edit(obj: PlateObject, node: number | null, raw: unknown): Promise<Record<string, unknown>> {
    const tree = await this.opened(obj);
    if ("reason" in tree) return { ok: false, reason: tree.reason };
    if (node === null || !tree.nodes.has(node)) return { ok: false, reason: "That step is not in the history." };
    const parent = tree.nodes.get(node)?.parent;
    if (parent === null || parent === undefined) return { ok: false, reason: "The opened file starts the history and stays." };
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

  /** The plate mesh becomes the solid on screen. The scale is reset only once that mesh is in place. */
  private async commitObject(obj: PlateObject): Promise<string | null> {
    const tree = obj.tree;
    if (!tree || !obj.solid || obj.solid.positions.length < 9) return null;
    const reply = await this.treeCall(exportRequest(tree.key, tree.current));
    const step = typeof reply.step === "string" ? reply.step : typeof reply.data === "string" ? reply.data : "";
    if (!step) return typeof reply.error === "string" ? plainModelError(reply.error) : "The solid was not exported.";
    const copy = Float32Array.from(obj.solid.positions);
    obj.seatMm = settleBy(copy);
    obj.source = copy;
    obj.triangles = copy.length / 9;
    obj.bytes = new TextEncoder().encode(step);
    if (/\.(stl|3mf)$/i.test(obj.fileName)) obj.fileName = obj.fileName.replace(/\.(stl|3mf)$/i, ".step");
    if (this.pathHasScale(tree)) obj.scale = 1;
    obj.tree = { ...obj.tree!, committed: tree.current };
    return null;
  }

  private async commitAll(): Promise<string | null> {
    for (const obj of this.objects) {
      const reason = await this.commitObject(obj);
      if (reason) return reason;
    }
    return null;
  }

  private pathHasScale(tree: ModelTree): boolean {
    for (let at: number | null = tree.current; at !== null; at = tree.nodes.get(at)?.parent ?? null) {
      if (tree.nodes.get(at)?.op?.kind === "scale") return true;
    }
    return false;
  }

  private async exportStep(obj: PlateObject, name: string): Promise<Record<string, unknown>> {
    const tree = await this.opened(obj);
    if ("reason" in tree) return { ok: false, reason: tree.reason };
    const reply = await this.treeCall(exportRequest(tree.key, tree.current));
    const step = typeof reply.step === "string" ? reply.step : typeof reply.data === "string" ? reply.data : "";
    if (!step) return { ok: false, reason: typeof reply.error === "string" ? plainModelError(reply.error) : "The solid was not exported." };
    const path = resolveWrite(name, ".step");
    writeFileSync(path, step);
    return { ok: true, path, bytes: Buffer.byteLength(step) };
  }

  private async measure(obj: PlateObject, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (typeof input.faceA === "number" || typeof input.faceB === "number") {
      if (typeof input.faceA !== "number" || typeof input.faceB !== "number") return { ok: false, reason: "Name both faces." };
      const tree = await this.opened(obj);
      if ("reason" in tree) return { ok: false, reason: tree.reason };
      const solid = obj.solid;
      if (!solid) return { ok: false, reason: "This solid could not be read." };
      const left = this.faceCentre(solid, input.faceA);
      const right = this.faceCentre(solid, input.faceB);
      if (!left || !right) return { ok: false, reason: "That face is not on this solid." };
      return this.span(left, right, "model");
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

  private faceCentre(solid: NonNullable<PlateObject["solid"]>, index: number): [number, number, number] | null {
    const face = solid.faces[index];
    if (!face?.normal) return null;
    const plane = facePlane(solid.positions, solid.triangles, index, face.normal);
    return plane ? plane.point : null;
  }

  private span(left: [number, number, number], right: [number, number, number], frame: string): Record<string, unknown> {
    const dx = right[0] - left[0];
    const dy = right[1] - left[1];
    const dz = right[2] - left[2];
    return { ok: true, distanceMm: Math.hypot(dx, dy, dz), dx, dy, dz, frame };
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
