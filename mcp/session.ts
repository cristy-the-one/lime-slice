/**
 * One stdio connection is one plate. The engine is behind `Engine`.
 * Feasibility refusals are `{ok:false, reason}` and are decided before apply.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import { base64ToBytes, bytesToBase64 } from "../src/base64.ts";
import { coverageWarning, fnv1aHex, inAirWarning } from "../src/slice-action.ts";
import { filamentGrams, groupFeatures } from "../src/estimate.ts";
import { humanEngineError } from "../src/engine-wording.ts";
import { foreign3mfMessage, foreignSlicer3mf } from "../src/foreign-3mf.ts";
import { meshWarningText, type MeshRepair } from "../src/app/mesh-warning.ts";
import { plainModelError } from "../src/app/model-error.ts";
import { encode3mf, ID_MATRIX, layFlatMatrix, matMul, offBed, placeMesh, rotX, rotY, rotZ, scaledCanonical, type Mat3 } from "../src/mesh-place.ts";
import { decodeSolid } from "../src/model-reply.ts";
import { probeFromBody, probeKey, probeNote, type ProbedTool } from "../src/model-feasibility.ts";
import { dropRefusal } from "../src/model-history.ts";
import { throughLength } from "../src/model-hole.ts";
import { splitNote, type SplitPlan } from "../src/model-plane.ts";
import { rootSpec, type PrimitiveSpec } from "../src/model-primitive.ts";
import { applyRequest, editRequest, exportRequest, gotoRequest, joinOp, newSolidRequest, openRequest, probeRequest } from "../src/model-request.ts";
import { IDENTITY_POSE, toSolidOp, type Affine } from "../src/model-space.ts";
import { dropped, jumped, newTree, opLabel, redoTarget, reserveId, undoTarget, withChild, type ModelOp, type ModelTree, type NodeId } from "../src/model-tree.ts";
import { DEFAULT_PRESET, presetKeys, type PresetSettings } from "../src/presets.ts";
import { meshRecord, parseProject, serializeProject, type LimeProject, type ProjectPlacement } from "../src/project.ts";
import type { LayerAction } from "../src/layer-actions.ts";
import { CURVED_FACE, GLOBAL_WORKPLANE, isGlobalFrame, localPoint, planePoint, workplaneOnFace, type Workplane } from "../src/workplane.ts";
import { eulerOrient } from "../src/mesh-place.ts";
import { builtinLibrary, enginePrinter, heatFor, parseMachineFile, type FilamentRecord, type MachineLibrary, type PrinterRecord } from "../src/ui/machine-library.ts";
import { parseSettingsProfile } from "../src/ui/settings-profiles.ts";

import { mirror } from "./bridge-client.ts";
import { ProtocolError, type Engine } from "./engine.ts";
import { appVersion, exportGcode, mass } from "./export-gcode.ts";
import { renderMesh, type Camera } from "./render.ts";
import { applyPreset, blendOf, sessionSliceRequest, stlBytes } from "./request.ts";
import { reviewGcode } from "./review.ts";
import { validateTool } from "./schema.ts";
import { resolveRead, resolveWrite } from "./workspace.ts";

const CHORD = 0.05;
const STEP = 0.05;

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
    volumeMm3: solid.volumeMm3,
    editable: solid.editable,
    fingerprint: solid.fingerprint,
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
  private readonly engine: Engine;
  onProgress: ((job: string, fraction: number, stage: string) => void) | null = null;

  constructor(engine: Engine) {
    this.engine = engine;
  }

  call(name: string, args: unknown): Promise<Record<string, unknown>> | Record<string, unknown> {
    const problem = validateTool(name, args ?? {});
    if (problem) throw new ProtocolError(problem);
    const input = (args ?? {}) as Record<string, unknown>;
    const result = this.dispatch(name, input);
    return Promise.resolve(result).then((value) => {
      void mirror({ tool: name, objectName: this.objectName(input.object), args: input, ok: value.ok === true });
      return value;
    });
  }

  private objectName(handle: unknown): string | undefined {
    if (typeof handle !== "string") return undefined;
    return this.objects.find((obj) => obj.id === handle)?.name;
  }

  private dispatch(name: string, input: Record<string, unknown>): Record<string, unknown> | Promise<Record<string, unknown>> {
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
      case "slice_wait": return this.sliceWait(String(input.job));
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

  private sessionInfo(): Record<string, unknown> {
    let engine = "unknown";
    let occt = false;
    try {
      engine = this.engine.version();
      occt = this.engine.occt();
    } catch (err) {
      engine = err instanceof Error ? err.message : "The engine did not answer.";
    }
    return {
      ok: true,
      serverVersion: appVersion(),
      engine,
      occt,
      workspace: process.env.LIME_MCP_WORKSPACE ?? "",
      printerSend: false,
    };
  }

  private printer(): PrinterRecord {
    return this.library.printers.find((row) => row.id === this.library.printerId) ?? this.library.printers[0]!;
  }

  private filament(): FilamentRecord {
    return this.library.filaments.find((row) => row.id === this.library.filamentId) ?? this.library.filaments[0]!;
  }

  private addObject(partial: Omit<PlateObject, "id" | "modelPose" | "workplane" | "tree" | "solid" | "probes"> & Partial<PlateObject>): PlateObject {
    this.seq += 1;
    const obj: PlateObject = {
      modelPose: IDENTITY_POSE,
      workplane: GLOBAL_WORKPLANE,
      tree: null,
      solid: null,
      probes: new Map(),
      ...partial,
      id: `obj_${this.seq}`,
    };
    this.objects.push(obj);
    this.selected = obj.id;
    return obj;
  }

  private preview(filename: string, bytes: Uint8Array, tolerance: number): { triangles: number; source: Float32Array; seatMm: number } {
    const reply = JSON.parse(this.engine.meshPreview(JSON.stringify({
      filename,
      dataB64: bytesToBase64(bytes),
      stepToleranceMm: tolerance,
    }))) as { error?: string; triangles?: number; positionsB64?: string; seatMm?: number };
    if (reply.error || !reply.positionsB64) throw new ProtocolError(reply.error ?? "The mesh could not be read.");
    return {
      triangles: reply.triangles ?? 0,
      source: positionsFrom(reply.positionsB64),
      seatMm: reply.seatMm ?? 0,
    };
  }

  private projectCreate(): Record<string, unknown> {
    this.objects.length = 0;
    this.selected = "";
    this.actions = [];
    this.settings = { ...DEFAULT_PRESET };
    return { ok: true, project: "project" };
  }

  private projectOpen(path: string): Record<string, unknown> {
    const full = resolveRead(path, "lime");
    const parsed = parseProject(readFileSync(full, "utf8"));
    if (!parsed.ok) return { ok: false, reason: parsed.message };
    this.objects.length = 0;
    this.settings = { ...parsed.project.settings };
    this.actions = parsed.project.layerActions ? [...parsed.project.layerActions] : [];
    const rows = parsed.project.objects?.length
      ? parsed.project.objects.map((obj) => ({ name: obj.name, file: obj.mesh.name, bytes: base64ToBytes(obj.mesh.bytesBase64), placement: obj.placement }))
      : [{ name: parsed.project.mesh.name, file: parsed.project.mesh.name, bytes: base64ToBytes(parsed.project.mesh.bytesBase64), placement: parsed.project.placement }];
    const objects: { object: string; name: string }[] = [];
    for (const row of rows) {
      if (!row.bytes) return { ok: false, reason: "The mesh in this project is damaged." };
      const preview = this.preview(row.file, row.bytes, row.placement.stepTolerance || STEP);
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
      });
      objects.push({ object: obj.id, name: obj.name });
    }
    return {
      ok: true,
      project: "project",
      version: parsed.project.version,
      objects,
      ...(parsed.project.unreadHistory?.length ? { unreadHistory: parsed.project.unreadHistory } : {}),
    };
  }

  private projectDocument(): LimeProject {
    const first = this.objects[0];
    const placement = (obj: PlateObject): ProjectPlacement => ({
      orient: [...obj.orient] as ProjectPlacement["orient"],
      scale: obj.scale,
      centered: obj.centered,
      offset: { ...obj.offset },
      stepTolerance: STEP,
    });
    const profile = enginePrinter(this.printer(), this.filament(), this.library.nozzleMm);
    const mesh = first ? meshRecord(first.fileName, first.bytes) : meshRecord("empty.stl", new Uint8Array());
    const objects = this.objects.map((obj) => ({
      id: obj.id,
      name: obj.name,
      mesh: meshRecord(obj.fileName, obj.bytes),
      placement: placement(obj),
      supportEdits: [],
    }));
    return {
      version: objects.length > 1 ? 2 : 1,
      mesh,
      placement: first ? placement(first) : { orient: [...ID_MATRIX] as ProjectPlacement["orient"], scale: 1, centered: true, offset: { x: 0, y: 0, z: 0 }, stepTolerance: STEP },
      settings: this.settings,
      preset: null,
      profile,
      level: "simple",
      supportEdits: [],
      ...(objects.length > 1 ? { objects } : {}),
      ...(this.actions.length ? { layerActions: this.actions } : {}),
    };
  }

  private projectSave(name: string): Record<string, unknown> {
    if (this.objects.length === 0) return { ok: false, reason: "The plate is empty." };
    const path = resolveWrite(name, ".lime");
    const text = serializeProject(this.projectDocument());
    writeFileSync(path, text);
    return { ok: true, path, bytes: Buffer.byteLength(text) };
  }

  private meshImport(path: string, tolerance: number): Record<string, unknown> {
    const full = resolveRead(path, "mesh");
    const bytes = new Uint8Array(readFileSync(full));
    const fileName = full.split(/[\\/]/).pop() ?? "mesh.stl";
    let note: string | undefined;
    if (fileName.toLowerCase().endsWith(".3mf")) {
      const vendor = foreignSlicer3mf(bytes);
      if (vendor) note = foreign3mfMessage(vendor);
    }
    const preview = this.preview(fileName, bytes, tolerance);
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
      ...(note ? { note } : {}),
    });
    const placed = this.placed(obj);
    return {
      ok: true,
      object: obj.id,
      name: obj.name,
      triangles: obj.triangles,
      bboxMm: { min: placed.bounds.min, max: placed.bounds.max },
      ...(note ? { note } : {}),
    };
  }

  private placed(obj: PlateObject) {
    const printer = this.printer();
    return placeMesh(obj.source, obj.orient, obj.scale, printer.bedX, printer.bedY, obj.centered, obj.offset);
  }

  private find(id: string): PlateObject | null {
    return this.objects.find((obj) => obj.id === id) ?? null;
  }

  private plateList(input: Record<string, unknown>): Record<string, unknown> {
    const printer = this.printer();
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
        notes: offBed(placed.bounds, printer.bedX, printer.bedY, printer.bedZ, printer.kind === "belt"),
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
      const before = this.placed({ ...obj, centered: true, offset: { x: 0, y: 0, z: 0 } });
      const cx = (before.bounds.min[0] + before.bounds.max[0]) / 2;
      const cy = (before.bounds.min[1] + before.bounds.max[1]) / 2;
      obj.centered = false;
      obj.offset = {
        x: typeof input.centreX === "number" ? input.centreX - cx : obj.offset.x,
        y: typeof input.centreY === "number" ? input.centreY - cy : obj.offset.y,
        z: obj.offset.z,
      };
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

  private objectRemove(id: string): Record<string, unknown> {
    const index = this.objects.findIndex((obj) => obj.id === id);
    if (index < 0) return { ok: false, reason: "That object is not on the plate." };
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
    });
  }

  private sliceStart(cancelRunning: boolean): Record<string, unknown> {
    if (this.running && this.running.status === "running") {
      if (!cancelRunning) {
        return { ok: false, reason: `A slice is already running (${this.running.handle}). Cancel it or pass cancelRunning.` };
      }
      this.engine.sliceCancel(String(this.running.engineId));
      this.running.status = "cancelled";
      this.running = null;
    }
    const obj = this.selectedObject();
    if (!obj) return { ok: false, reason: "Load a mesh first." };
    const started = JSON.parse(this.engine.sliceStart(JSON.stringify(this.sliceBody(obj)))) as { id?: number; error?: string };
    if (typeof started.id !== "number") return { ok: false, reason: humanEngineError(started.error ?? "The slice did not start.") };
    const job: Job = { handle: `job_${this.jobs.length + 1}`, engineId: started.id, status: "running" };
    this.jobs.push(job);
    this.running = job;
    return { ok: true, job: job.handle, status: "running" };
  }

  private jobOf(handle: string): Job | null {
    return this.jobs.find((job) => job.handle === handle) ?? null;
  }

  private async sliceWait(handle: string): Promise<Record<string, unknown>> {
    const job = this.jobOf(handle);
    if (!job) return { ok: false, job: handle, reason: "That slice job is not in this session." };
    const deadline = Date.now() + 30 * 60 * 1000;
    while (job.status === "running" && Date.now() < deadline) {
      const poll = JSON.parse(this.engine.slicePoll(String(job.engineId))) as { status?: string; stage?: string; fraction?: number; result?: string; error?: string };
      if (typeof poll.fraction === "number") this.onProgress?.(job.handle, poll.fraction, poll.stage ?? "");
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
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
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

  private sliceCancel(handle: string): Record<string, unknown> {
    const job = this.jobOf(handle);
    if (!job) return { ok: false, reason: "That slice job is not in this session." };
    this.engine.sliceCancel(String(job.engineId));
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
    const layers = Array.isArray(wire.layers) ? wire.layers as { z?: number; seconds?: number }[] : [];
    return {
      seconds: estimate.seconds ?? 0,
      grams,
      filamentMm,
      cost: mass(filamentMm, spec).cost,
      warnings: this.warnings(wire),
      features,
      layerSeconds: layers.map((layer) => layer.seconds).filter((value): value is number => typeof value === "number"),
      layers: layers.filter((layer) => typeof layer.z === "number").map((layer) => ({ z: layer.z as number, ...(typeof layer.seconds === "number" ? { seconds: layer.seconds } : {}) })),
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
    const summary = this.summarize(job);
    const review = reviewGcode(job.gcode);
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
    const now = typeof input.now === "string" ? new Date(input.now) : new Date();
    if (Number.isNaN(now.getTime())) return { ok: false, reason: "That clock is not a time." };
    const summary = this.summarize(job);
    const printer = this.printer();
    const filament = this.filament();
    const heat = heatFor(printer, filament.nozzleTemp, filament.bedTemp);
    const text = exportGcode({
      gcode: job.gcode,
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
    const path = resolveWrite(String(input.name), ".gcode");
    writeFileSync(path, text);
    return { ok: true, path, bytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") };
  }

  private export3mf(name: string): Record<string, unknown> {
    if (this.objects.length === 0) return { ok: false, reason: "The plate is empty." };
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
    const printer = this.printer();
    return {
      ok: true,
      object: obj.id,
      triangles: obj.triangles,
      bboxMm: { min: placed.bounds.min, max: placed.bounds.max },
      sizeMm: size,
      notes: offBed(placed.bounds, printer.bedX, printer.bedY, printer.bedZ, printer.kind === "belt"),
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

  private renderView(input: Record<string, unknown>): Record<string, unknown> {
    const obj = this.find(typeof input.object === "string" ? input.object : this.selected) ?? this.objects[0];
    if (!obj) return { ok: false, reason: "Load a mesh first." };
    const camera = (input.camera === "front" || input.camera === "iso" ? input.camera : "top") as Camera;
    const drawn = renderMesh(this.placed(obj).positions, camera, typeof input.longEdge === "number" ? input.longEdge : 768);
    const path = resolveWrite(typeof input.name === "string" ? input.name : `${obj.name}-${camera}.png`, ".png");
    writeFileSync(path, drawn.png);
    return { ok: true, path, camera, width: drawn.width, height: drawn.height };
  }

  resource(uri: string): Record<string, unknown> {
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
      case "model_probe": return this.probe(obj, input.op);
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

  private treeCall(body: Record<string, unknown>): Record<string, unknown> {
    let text = "";
    try {
      text = this.engine.modelTree(JSON.stringify(body));
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

  private ensureTree(obj: PlateObject): ModelTree {
    if (obj.tree) return obj.tree;
    const key = `mcp-${obj.id}`;
    const root = { kind: "step" as const, name: obj.fileName, bytes: obj.bytes.buffer as ArrayBuffer };
    const reply = this.treeCall(openRequest(key, root, CHORD));
    const error = typeof reply.error === "string" ? reply.error : "";
    if (error) throw new ProtocolError(plainModelError(error));
    obj.tree = newTree(key, root, obj.name, null);
    obj.solid = rememberSolid(reply);
    return obj.tree;
  }

  private solidNew(input: Record<string, unknown>): Record<string, unknown> {
    const kind = input.primitive === "cylinder" || input.primitive === "sphere" ? input.primitive : "box";
    const dx = typeof input.dx === "number" ? input.dx : 20;
    const dy = typeof input.dy === "number" ? input.dy : 20;
    const dz = typeof input.dz === "number" ? input.dz : 20;
    const typed: PrimitiveSpec = { primitive: kind, origin: [0, 0, 0], size: [dx, dy, dz], radius: kind === "box" ? 0 : dx / 2, height: dz, turn: [0, 0, 0] };
    const spec = rootSpec(typed);
    this.seq += 1;
    const id = `obj_${this.seq}`;
    const key = `mcp-${id}`;
    const reply = this.treeCall(newSolidRequest(key, typed, CHORD));
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

  private describe(obj: PlateObject, input: Record<string, unknown>): Record<string, unknown> {
    this.ensureTree(obj);
    const solid = obj.solid;
    if (!solid) return { ok: false, reason: "This solid could not be read." };
    const faces = page(solid.faces.map((face, index) => ({ index, areaMm2: face.areaMm2, ...(face.normal ? { normal: face.normal } : {}) })), input.cursor, input.limit);
    const edges = page(solid.edges.map((edge, index) => ({ index, mid: edge.mid, lengthMm: edge.lengthMm })), input.cursor, input.limit);
    return {
      ok: true,
      volumeMm3: solid.volumeMm3,
      solid: solid.editable,
      fingerprint: solid.fingerprint,
      faces: faces.rows,
      edges: edges.rows,
      ...(faces.nextCursor ? { nextCursor: faces.nextCursor } : {}),
    };
  }

  private workplaneSet(obj: PlateObject, faceIndex: number): Record<string, unknown> {
    this.ensureTree(obj);
    const face = obj.solid?.faces[faceIndex];
    if (!face) return { ok: false, reason: "That face is not on this solid." };
    if (!face.normal) return { ok: false, reason: CURVED_FACE };
    const point = obj.solid?.edges[0]?.mid ?? [0, 0, 0];
    obj.workplane = workplaneOnFace({ point: [...point] as [number, number, number], normal: [...face.normal] as [number, number, number] });
    return { ok: true, source: obj.workplane.source };
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
    const turnX = typeof input.turnX === "number" ? input.turnX : 0;
    const turnY = typeof input.turnY === "number" ? input.turnY : 0;
    const turnZ = typeof input.turnZ === "number" ? input.turnZ : 0;
    obj.modelPose = { m: eulerOrient(turnX, turnY, turnZ), t: [x, y, z] };
    return { ok: true };
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
        axis = [0, 0, -1];
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
      const op: ModelOp = { kind: "hole", origin, axis, radius, depth, ...(through ? { through: true as const } : {}) };
      return { op: toSolidOp(op, obj.modelPose), typed: { kind: "hole", diameterMm: radius * 2, ...(through ? { through: true } : { depth }) } };
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
      const solid = rootSpec({ primitive, origin: [0, 0, 0], size: [10, 10, 10], radius: 5, height: 10, turn: [0, 0, 0] });
      const op = toSolidOp({ kind: "boolean", op: booleanOp, ...solid }, obj.modelPose);
      return { op, typed: { kind: "boolean", op: booleanOp, primitive } };
    }
    return { reason: "That edit is not one of hole, fillet, chamfer, split, scale, boolean, or join." };
  }

  private splitCheck(obj: PlateObject, op: Extract<ModelOp, { kind: "split" }>): { text: string; bad: boolean } {
    const box = obj.solid?.bounds;
    if (!box) return splitNote({ why: "This solid is too thin to split.", wait: false });
    const span = Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]);
    if (!(span > 1)) return splitNote({ why: "This solid is too thin to split.", wait: false });
    const plan: SplitPlan = {
      base: { mode: "z", normal: op.normal, base: op.origin, dir: op.normal },
      value: 0,
      origin: op.origin,
      normal: op.normal,
      range: { min: -span / 2, max: span / 2, mid: 0 },
      inside: true,
      rings: [[1, 0, 0], [0, 1, 0]],
    };
    return splitNote({ plan });
  }

  private probe(obj: PlateObject, raw: unknown): Record<string, unknown> {
    const tree = this.ensureTree(obj);
    const baked = this.bake(obj, raw);
    if ("reason" in baked) return { ok: false, reason: baked.reason };
    if (baked.op.kind === "scale") {
      obj.probes.set(probeKey(String(tree.current), baked.op), true);
      return { ok: true, reason: "This scale fits.", stored: baked.op, typed: baked.typed };
    }
    if (baked.op.kind === "split") {
      const note = this.splitCheck(obj, baked.op);
      if (note.bad) return { ok: false, reason: note.text, stored: baked.op, typed: baked.typed };
      obj.probes.set(probeKey(String(tree.current), baked.op), true);
      return { ok: true, reason: note.text, stored: baked.op, typed: baked.typed };
    }
    const tool = (baked.op.kind === "join" ? "boolean" : baked.op.kind) as ProbedTool;
    const reply = this.treeCall(probeRequest(tree.key, tree.current, baked.op));
    const view = probeFromBody(reply);
    const note = probeNote(tool, view);
    if (!note || note.bad) return { ok: false, reason: note?.text ?? "This does not fit.", ...(typeof reply.maxMm === "number" ? { maxMm: reply.maxMm } : {}), stored: baked.op, typed: baked.typed };
    obj.probes.set(probeKey(String(tree.current), baked.op), true);
    return { ok: true, reason: note.text, stored: baked.op, typed: baked.typed };
  }

  private apply(obj: PlateObject, raw: unknown, edit: boolean): Record<string, unknown> {
    const tree = this.ensureTree(obj);
    const baked = this.bake(obj, raw);
    if ("reason" in baked) return { ok: false, reason: baked.reason };
    const key = probeKey(String(tree.current), baked.op);
    if (!obj.probes.has(key)) return { ok: false, reason: "Probe this edit first. It was not applied." };
    const [reserved, node] = reserveId(tree);
    obj.tree = reserved;
    const reply = this.treeCall(applyRequest(tree.key, tree.current, node, baked.op, CHORD));
    if (typeof reply.error === "string" && reply.error) return { ok: false, reason: plainModelError(reply.error, baked.op.kind) };
    obj.tree = withChild(obj.tree, tree.current, { id: node, op: baked.op, label: opLabel(baked.op), fingerprint: null });
    const solid = rememberSolid(reply);
    if (solid) obj.solid = solid;
    obj.probes.clear();
    return { ok: true, node: nodeHandle(node), ...(edit ? {} : {}), stored: baked.op, typed: baked.typed };
  }

  private history(obj: PlateObject, input: Record<string, unknown>): Record<string, unknown> {
    const tree = obj.tree ?? this.ensureTree(obj);
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

  private gotoNode(obj: PlateObject, node: number | null): Record<string, unknown> {
    const tree = this.ensureTree(obj);
    if (node === null || !tree.nodes.has(node)) return { ok: false, reason: "That step is not in the history." };
    const reply = this.treeCall(gotoRequest(tree.key, node, CHORD));
    if (typeof reply.error === "string" && reply.error) return { ok: false, reason: plainModelError(reply.error) };
    obj.tree = jumped(tree, node);
    const solid = rememberSolid(reply);
    if (solid) obj.solid = solid;
    return { ok: true, node: nodeHandle(node) };
  }

  private step(obj: PlateObject, direction: "undo" | "redo"): Record<string, unknown> {
    const tree = this.ensureTree(obj);
    const target = direction === "undo" ? undoTarget(tree) : redoTarget(tree);
    if (target === null) return { ok: false, reason: direction === "undo" ? "This is the start of the history." : "There is nothing to redo." };
    return this.gotoNode(obj, target);
  }

  private edit(obj: PlateObject, node: number | null, raw: unknown): Record<string, unknown> {
    const tree = this.ensureTree(obj);
    if (node === null || !tree.nodes.has(node)) return { ok: false, reason: "That step is not in the history." };
    const parent = tree.nodes.get(node)?.parent;
    if (parent === null || parent === undefined) return { ok: false, reason: "The opened file starts the history and stays." };
    const baked = this.bake(obj, raw);
    if ("reason" in baked) return { ok: false, reason: baked.reason };
    const key = probeKey(String(parent), baked.op);
    if (!obj.probes.has(key)) return { ok: false, reason: "Probe this edit first. It was not applied." };
    const [reserved, id] = reserveId(tree);
    obj.tree = reserved;
    const reply = this.treeCall(editRequest(tree.key, parent, id, baked.op, [], CHORD));
    if (typeof reply.error === "string" && reply.error) return { ok: false, reason: plainModelError(reply.error) };
    obj.tree = withChild(obj.tree, parent, { id, op: baked.op, label: opLabel(baked.op), fingerprint: null });
    return { ok: true, node: nodeHandle(id), built: true, broken: typeof reply.broken === "boolean" ? reply.broken : false };
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

  private commit(obj: PlateObject): Record<string, unknown> {
    const tree = this.ensureTree(obj);
    let scaled = false;
    for (let at: number | null = tree.current; at !== null; at = tree.nodes.get(at)?.parent ?? null) {
      if (tree.nodes.get(at)?.op?.kind === "scale") scaled = true;
    }
    obj.tree = { ...tree, committed: tree.current };
    if (scaled) obj.scale = 1;
    return { ok: true, scalePercent: obj.scale * 100 };
  }

  private exportStep(obj: PlateObject, name: string): Record<string, unknown> {
    const tree = this.ensureTree(obj);
    const reply = this.treeCall(exportRequest(tree.key, tree.current));
    const step = typeof reply.step === "string" ? reply.step : typeof reply.data === "string" ? reply.data : "";
    if (!step) return { ok: false, reason: typeof reply.error === "string" ? plainModelError(reply.error) : "The solid was not exported." };
    const path = resolveWrite(name, ".step");
    writeFileSync(path, step);
    return { ok: true, path, bytes: Buffer.byteLength(step) };
  }

  private measure(obj: PlateObject, input: Record<string, unknown>): Record<string, unknown> {
    const a = input.a as number[];
    const b = input.b as number[];
    const frame = input.frame === "workplane" ? "workplane" : "model";
    const left = frame === "workplane" ? localPoint(obj.workplane, a) : a as [number, number, number];
    const right = frame === "workplane" ? localPoint(obj.workplane, b) : b as [number, number, number];
    const dx = right[0] - left[0];
    const dy = right[1] - left[1];
    const dz = right[2] - left[2];
    return { ok: true, distanceMm: Math.hypot(dx, dy, dz), dx, dy, dz, frame };
  }
}

export function meshHash(bytes: Uint8Array): string {
  return fnv1aHex(bytes);
}

export { blendOf };
