/**
 * Slicing and what it makes: slice_start, slice_wait, slice_cancel, the G-code summary and export, mesh stats, and the layer summary.
 * The methods run with this: Session; session.ts installs them on the Session prototype.
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { bytesToBase64 } from "../../src/base64.ts";
import { coverageWarning, fnv1aHex, inAirWarning, meshKeyHex } from "../../src/slice-action.ts";
import { filamentGrams, groupFeatures, velocityCapWarning, type VelocityCap } from "../../src/estimate.ts";
import { humanEngineError } from "../../src/engine-wording.ts";
import { meshWarningText, type MeshRepair } from "../../src/app/mesh-warning.ts";
import { encode3mf, ID_MATRIX, scaledCanonical, type Mat3 } from "../../src/mesh-place.ts";
import { editRequestFields } from "../../src/support-edit-list.ts";
import { paintRequestFields } from "../../src/support-paint.ts";
import { seamRequestFields } from "../../src/seam-paint.ts";
import { normalInfillDensity, reinforcementRequestFields } from "../../src/reinforcement.ts";
import { sourceFrame, slicePlateFields, settingsEmpty, type PlateObject as SliceObject } from "../../src/plate.ts";
import { orderFields, sequentialClearance, settingsRules, tallestLast, type PrintOrder } from "../../src/settings-rules.ts";
import { heatFor } from "../../src/ui/machine-library.ts";
import { exportGcode, mass } from "../export-gcode.ts";
import { sessionSliceRequest, stlBytes } from "../request.ts";
import { reviewGcode } from "../review.ts";
import { resolveWrite } from "../workspace.ts";
import { type CallMeta, type Job, type PlateObject, SLICE_WAIT_DEFAULT_S, SLICE_WAIT_MAX_S, STALE_SLICE, type SliceSummary, type ToolHandler, UNKNOWN_OBJECT, roundTo, shownName, standsOnNothing } from "./shared.ts";
import type { Session } from "../session.ts";
import { NEXT, refuse } from "../refusals.ts";

function selectedObject(this: Session): PlateObject | null {
  return this.find(this.selected) ?? this.objects[0] ?? null;
}

function order(this: Session): PrintOrder {
  return { printOrder: this.printOrder, clearanceMm: this.clearanceMm, gantryMm: this.gantryMm };
}

/** The selected object's fields, or every object's when `scope` is `plate`. A missing scope is the selection. */
function sliceBody(this: Session, obj: PlateObject, scope?: unknown): { body: Record<string, unknown>; mesh: Uint8Array; plate: boolean } {
  const placed = this.placed(obj);
  const name = /\.(3mf|step|stp)$/i.test(obj.fileName) ? obj.fileName.replace(/\.(3mf|step|stp)$/i, ".stl") : obj.fileName;
  const mesh = stlBytes(scaledCanonical(obj.source, obj.scale), name);
  const plateScope = scope === "plate";
  const oneObject = !plateScope && !settingsEmpty(obj.objectSettings);
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
  return { body, mesh, plate: plateScope };
}

function sliceRules(this: Session, objects: number) {
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

function oneObjectFields(this: Session, obj: PlateObject): Record<string, unknown> {
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

function plateFields(this: Session, rows: PlateObject[] = this.objects): Record<string, unknown> {
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
function notSliced(this: Session): string[] {
  return [];
}

async function sliceStart(this: Session, cancelRunning: boolean, scope?: unknown): Promise<Record<string, unknown>> {
  if (this.running && this.running.status === "running") {
    if (!cancelRunning) {
      return refuse("slice-running", `A slice is already running (${this.running.handle}). Cancel it or pass cancelRunning.`, undefined, NEXT.slicewait);
    }
    await this.ask(this.engine.sliceCancel(String(this.running.engineId)));
    this.running.status = "cancelled";
    this.running = null;
  }
  const obj = this.selectedObject();
  if (!obj) return refuse("no-mesh", "Load a mesh first.", undefined, NEXT.mesh);
  const committed = await this.commitObject(obj);
  if (committed) return refuse("commit-failed", committed);
  const skipped = this.notSliced();
  const built = this.sliceBody(obj, scope);
  built.body.partHold = true;
  const collisions = this.plateCollisions();
  const plateBody = Array.isArray(built.body.objects);
  const started = JSON.parse(await this.ask(this.engine.sliceStart(JSON.stringify(built.body), plateBody ? undefined : built.mesh))) as { id?: number; error?: string };
  if (typeof started.id !== "number") return refuse("slice-failed", humanEngineError(started.error ?? "The slice did not start."));
  this.jobSeq += 1;
  const job: Job = {
    handle: `job_${this.jobSeq}`,
    engineId: started.id,
    objectId: obj.id,
    plateScope: built.plate,
    slicedIds: built.plate ? this.objects.map((row) => row.id) : [obj.id],
    others: this.objects.length > 1,
    stamp: this.sliceStamp(),
    status: "running",
  };
  this.running = job;
  this.retainJobs(job);
  const identity = this.sliceIdentity(job);
  if (skipped.length) {
    const skip = `This project has ${skipped.join(", ")} that this server does not slice yet. The G-code will differ from the app's.`;
    identity.notSliced = skipped;
    identity.note = identity.note ? `${String(identity.note)} ${skip}` : skip;
  }
  return {
    ok: true,
    job: job.handle,
    status: "running",
    ...identity,
    collisions,
    objects: this.objects.map((row) => row.id),
  };
}

/** Names the meshes this job sliced. A plate job says so, and never claims it was only the selection. */
function sliceIdentity(this: Session, job: Job): Record<string, unknown> {
  if (job.plateScope) return { scope: "plate", sliced: job.slicedIds, note: "Sliced the whole plate." };
  const named = this.find(job.objectId);
  const one = named ? { object: named.id, name: shownName(named.name) } : { object: job.objectId };
  if (job.others) return { ...one, scope: "object", sliced: job.slicedIds };
  return one;
}

function sliceStamp(this: Session): string {
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

function staleReason(this: Session, job: Job): string | null {
  if (!this.find(job.objectId) || !job.stamp || this.sliceStamp() !== job.stamp) return STALE_SLICE;
  return null;
}

function jobOf(this: Session, handle: string): Job | null {
  return this.jobs.find((job) => job.handle === handle) ?? null;
}

async function sliceWait(this: Session, handle: string, meta?: CallMeta, timeoutS?: number): Promise<Record<string, unknown>> {
  const work = this.workJobs.find((row) => row.handle === handle);
  if (work) return this.workWait(work, meta, timeoutS);
  const job = this.jobOf(handle);
  if (!job) return this.lostJob(handle);
  const limitS = typeof timeoutS === "number" && Number.isFinite(timeoutS)
    ? Math.min(SLICE_WAIT_MAX_S, Math.max(0.05, timeoutS))
    : SLICE_WAIT_DEFAULT_S;
  const deadline = Date.now() + limitS * 1000;
  let fraction = 0;
  let stage = "";
  while (job.status === "running" && Date.now() < deadline) {
    if (meta?.signal?.aborted) return refuse("cancelled", "The wait was cancelled.", { job: job.handle, status: "cancelled" });
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
    return refuse("cancelled", "The wait was cancelled.", { job: job.handle, status: "cancelled" });
  }
  if (job.status === "running") {
    return { ok: true, job: job.handle, status: "running", fraction, stage, ...this.sliceIdentity(job) };
  }
  if (this.running?.handle === job.handle && job.status !== "running") this.running = null;
  if (job.status === "done") this.latest = job;
  if (job.status === "cancelled") return refuse("cancelled", "The slice was cancelled.", { job: job.handle, status: "cancelled" });
  if (job.status !== "done" || !job.wire) {
    const reason = job.error ? humanEngineError(this.errorText(job.error)) : "The slice did not finish.";
    return refuse("slice-failed", reason, { job: job.handle, status: "error" });
  }
  const summary = this.summarize(job);
  return {
    ok: true,
    job: job.handle,
    status: "done",
    ...this.sliceIdentity(job),
    printer: this.printer().name,
    filament: this.filament().name,
    layerHeight: this.settings.layerHeight,
    seconds: Math.round(summary.seconds),
    grams: roundTo(summary.grams, 2),
    cost: roundTo(summary.cost, 2),
  };
}

function errorText(this: Session, error: string): string {
  try {
    const parsed = JSON.parse(error) as { error?: string };
    if (typeof parsed.error === "string") return parsed.error;
  } catch {
    // The engine sometimes returns the sentence itself.
  }
  return error;
}

/**
 * --- R-C. A job this session never had. When the plate is empty and a server that has ended left an autosave, the
 * job was that server's: its plate is opened again here, and the reply says so.
 */
async function lostJob(this: Session, handle: string): Promise<Record<string, unknown>> {
  const reason = "That slice job is not in this session.";
  const previous = this.previousAutosave;
  if (!previous || this.objects.length > 0 || this.jobs.length > 0 || this.workJobs.length > 0) return refuse("slice-lost", reason, { job: handle });
  const opened = await this.projectOpen(previous.path).catch((err: unknown) => ({ ok: false, reason: err instanceof Error ? err.message : String(err) }));
  if (opened.ok === false) return refuse("slice-lost", `${reason} ${previous.note}`, { job: handle });
  return refuse("slice-lost", `${reason} The server restarted at ${this.startedAt}, so the job is gone; the plate was restored from the autosave of ${previous.savedAt} (${previous.path}), as it stood before that call. Run the call again.`, { job: handle, status: "lost", restored: previous.path, objects: this.objects.map((obj) => obj.id) });
}

async function sliceCancel(this: Session, handle: string): Promise<Record<string, unknown>> {
  const work = this.workJobs.find((row) => row.handle === handle);
  if (work) return this.workCancel(work);
  const job = this.jobOf(handle);
  if (!job) return refuse("slice-lost", "That slice job is not in this session.");
  await this.ask(this.engine.sliceCancel(String(job.engineId)));
  if (job.status === "running") job.status = "cancelled";
  if (this.running?.handle === job.handle) this.running = null;
  return { ok: true, status: job.status === "done" ? "done" : "cancelled" };
}

function summarize(this: Session, job: Job): SliceSummary {
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

function warnings(this: Session, wire: Record<string, unknown>): string[] {
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
  const capped = velocityCapWarning((wire.estimate as { velocityCap?: VelocityCap } | undefined)?.velocityCap);
  if (capped) out.push(capped);
  return out;
}

function finished(this: Session, handle?: string): Job | null {
  if (handle) return this.jobOf(handle);
  return this.latest;
}

function gcodeSummary(this: Session, handle?: string): Record<string, unknown> {
  const job = this.finished(handle);
  if (!job?.gcode || !job.wire) return refuse("not-sliced", "Slice first.", undefined, NEXT.slice);
  const stale = this.staleReason(job);
  if (stale) return refuse("stale-slice", stale, undefined, NEXT.slice);
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
    ...standsOnNothing(job.wire.partHold),
    head: review.head,
    tail: review.tail,
    review: review.review,
    custom: review.custom,
  };
}

/** Lines a person wrote: machine start and end, and custom layer actions. */
function customBlocks(this: Session): string[] {
  const printer = this.printer();
  const actions = this.actions
    .filter((action) => action.kind === "customGcode" && action.gcode)
    .map((action) => action.gcode as string);
  return [printer.startGcode, printer.endGcode, ...actions];
}

function gcodeExport(this: Session, input: Record<string, unknown>): Record<string, unknown> {
  const job = this.finished(typeof input.job === "string" ? input.job : undefined);
  if (!job?.gcode) return refuse("not-sliced", "Slice first.", undefined, NEXT.slice);
  const stale = this.staleReason(job);
  if (stale) return refuse("stale-slice", stale, undefined, NEXT.slice);
  const now = typeof input.now === "string" ? new Date(input.now) : new Date();
  if (Number.isNaN(now.getTime())) return refuse("bad-clock", "That clock is not a time.");
  const text = this.fileText(job, now);
  const path = resolveWrite(String(input.name), ".gcode");
  writeFileSync(path, text);
  return { ok: true, path, bytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") };
}

async function export3mf(this: Session, name: string): Promise<Record<string, unknown>> {
  if (this.objects.length === 0) return refuse("plate-empty", "The plate is empty.", undefined, NEXT.empty);
  const refused = (await this.commitAll())[0];
  if (refused) return refuse("commit-failed", `${refused.name} (${refused.object}): ${refused.reason}`, { object: refused.object });
  const meshes = this.objects.map((obj) => this.placed(obj).positions);
  const bytes = encode3mf(meshes);
  const path = resolveWrite(name, ".3mf");
  writeFileSync(path, bytes);
  return { ok: true, path, bytes: bytes.byteLength };
}

function meshStats(this: Session, id: string): Record<string, unknown> {
  const obj = this.find(id);
  if (!obj) return refuse("no-object", UNKNOWN_OBJECT, undefined, NEXT.plate);
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

function layerSummary(this: Session, handle?: string): Record<string, unknown> {
  const job = this.finished(handle);
  if (!job?.wire) return refuse("not-sliced", "Slice first.", undefined, NEXT.slice);
  const stale = this.staleReason(job);
  if (stale) return refuse("stale-slice", stale, undefined, NEXT.slice);
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

function fileText(this: Session, job: Job, now: Date): string {
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
    filamentDiameter: filament.diameterMm,
  });
}

/** The methods this module adds to Session. */
export const sliceMethods = {
  selectedObject,
  order,
  sliceBody,
  sliceRules,
  oneObjectFields,
  plateFields,
  notSliced,
  sliceStart,
  sliceIdentity,
  sliceStamp,
  staleReason,
  jobOf,
  sliceWait,
  errorText,
  lostJob,
  sliceCancel,
  summarize,
  warnings,
  finished,
  gcodeSummary,
  customBlocks,
  gcodeExport,
  export3mf,
  meshStats,
  layerSummary,
  fileText,
};

export const sliceHandlers: Record<string, ToolHandler> = {
  slice_start: (s, input) => s.sliceStart(input.cancelRunning === true, input.scope),
  slice_wait: (s, input, meta) => s.sliceWait(String(input.job), meta, typeof input.timeoutS === "number" ? input.timeoutS : undefined),
  slice_cancel: (s, input) => s.sliceCancel(String(input.job)),
  gcode_summary: (s, input) => s.gcodeSummary(typeof input.job === "string" ? input.job : undefined),
  gcode_export: (s, input) => s.gcodeExport(input),
  export_3mf: (s, input) => input.pieces === true ? s.exportPieceMeshes(input) : s.export3mf(String(input.name)),
  mesh_stats: (s, input) => s.meshStats(String(input.object)),
  layer_summary: (s, input) => s.layerSummary(typeof input.job === "string" ? input.job : undefined),
};
