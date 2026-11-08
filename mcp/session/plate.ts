/**
 * The plate: objects, selection, placement, duplicate, split shells, arrange, print order, mesh import, and plate undo.
 * The methods run with this: Session; session.ts installs them on the Session prototype.
 */
import { readFile } from "node:fs/promises";
import { base64ToBytes, bytesToBase64 } from "../../src/base64.ts";
import { foreign3mfMessage, foreignSlicer3mf } from "../../src/foreign-3mf.ts";
import { ID_MATRIX, offBed, placeMesh, type Bounds, type Mat3 } from "../../src/mesh-place.ts";
import type { Vec3 } from "../../src/pivot.ts";
import { refreshLinks, removedMember, saneChains, type ChainObject } from "../../src/chain.ts";
import { page } from "../../src/modeling/model-calls.ts";
import { placeOnPlate, placedBounds } from "../../src/modeling/placing.ts";
import { IDENTITY_POSE, type Affine } from "../../src/model-space.ts";
import { pathTo } from "../../src/model-tree.ts";
import type { PaintDisk } from "../../src/support-paint.ts";
import { ARRANGE_GAP_MM, arrangedObjects, type PlateObject as SliceObject } from "../../src/plate.ts";
import { cloneStudy } from "../../src/sim/study.ts";
import { sequentialClearance } from "../../src/settings-rules.ts";
import { GLOBAL_WORKPLANE, type Workplane } from "../../src/workplane.ts";
import type { FilamentRecord, PrinterRecord } from "../../src/ui/machine-library.ts";
import { ProtocolError } from "../engine.ts";
import { stlBytes } from "../request.ts";
import { shellGroups, takeGroups } from "../../src/mesh-shells.ts";
import { matchShellSolids, type SolidBounds } from "../shell-solids.ts";
import { offsetInPlace, pieceFileName, separateBy, solidNames, stepSolidHint } from "../../src/step-solids.ts";
import { assemblyOf } from "../../src/assembly.ts";
import { resolveRead } from "../workspace.ts";
import { type Job, ModelRunaway, NAME_LIMIT, OVERLAP, type PlateObject, type PlateSnap, STEP, type SnapObject, type ToolHandler, UNKNOWN_OBJECT, positionsFrom, shownName, xyGap } from "./shared.ts";
import type { Session } from "../session.ts";
import { NEXT, refuse } from "../refusals.ts";

function printer(this: Session): PrinterRecord {
  return this.library.printers.find((row) => row.id === this.library.printerId) ?? this.library.printers[0]!;
}

function filament(this: Session): FilamentRecord {
  return this.library.filaments.find((row) => row.id === this.library.filamentId) ?? this.library.filaments[0]!;
}

function addObject(this: Session, partial: Omit<PlateObject, "id" | "modelPose" | "workplane" | "tree" | "solid" | "probes" | "stepTolerance" | "supportEdits" | "supportPaint" | "seamPaint" | "reinforcement" | "objectSettings" | "platedNode"> & Partial<Pick<PlateObject, "stepTolerance" | "supportEdits" | "supportPaint" | "seamPaint" | "reinforcement" | "objectSettings" | "platedNode">>, id?: string): PlateObject {
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

function takeId(this: Session, id?: string): string {
  if (id) {
    const match = /^obj_(\d+)$/.exec(id);
    if (match) this.seq = Math.max(this.seq, Number(match[1]));
    return id;
  }
  this.seq += 1;
  return `obj_${this.seq}`;
}

async function preview(this: Session, filename: string, bytes: Uint8Array, tolerance: number): Promise<{ triangles: number; source: Float32Array; seatMm: number }> {
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

function snapObject(this: Session, obj: PlateObject): SnapObject {
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
    ...(obj.frame ? { frame: obj.frame } : {}),
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
    ...(obj.pivot ? { pivot: [...obj.pivot] as Vec3 } : {}),
    ...(obj.chain ? { chain: { parent: obj.chain.parent, offset: [...obj.chain.offset] as Vec3, turn: [...obj.chain.turn] as Mat3 } } : {}),
    ...(obj.jointLimits ? { jointLimits: structuredClone(obj.jointLimits) } : {}),
  };
}

function capture(this: Session, label: string): PlateSnap {
  return {
    label,
    assemblies: structuredClone(this.assemblies),
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

function revive(this: Session, row: SnapObject): PlateObject {
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

function install(this: Session, snap: PlateSnap): void {
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
      kept.modelPose = structuredClone(row.modelPose);
      kept.frame = row.frame;
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
  this.assemblies = structuredClone(snap.assemblies);
  this.settings = structuredClone(snap.settings);
  this.library = structuredClone(snap.library);
  this.actions = snap.actions.map((action) => ({ ...action }));
  this.overrides = structuredClone(snap.overrides);
  this.printOrder = snap.printOrder;
  this.clearanceMm = snap.clearanceMm;
  this.gantryMm = snap.gantryMm;
}

function remember(this: Session, label: string): void {
  this.undoStack.push(this.capture(label));
  if (this.undoStack.length > 32) this.undoStack.shift();
  this.redoStack = [];
}

function plateUndo(this: Session): Record<string, unknown> {
  const snap = this.undoStack.pop();
  if (!snap) return refuse("nothing-to-undo", "Nothing to undo.");
  this.redoStack.push(this.capture(snap.label));
  this.install(snap);
  return { ok: true, label: snap.label };
}

function plateRedo(this: Session): Record<string, unknown> {
  const snap = this.redoStack.pop();
  if (!snap) return refuse("nothing-to-redo", "Nothing to redo.");
  this.undoStack.push(this.capture(snap.label));
  this.install(snap);
  return { ok: true, label: snap.label };
}

async function meshImport(this: Session, path: string, tolerance: number, pieces = false): Promise<Record<string, unknown>> {
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
async function splitSolids(this: Session, obj: PlateObject, undoable: boolean): Promise<Record<string, unknown> | null> {
  let written: Record<string, unknown>;
  try {
    written = JSON.parse(await this.ask(this.engine.modelTree(JSON.stringify({ call: "stepSolids", dataB64: bytesToBase64(obj.bytes), files: true })))) as Record<string, unknown>;
  } catch (err) {
    written = { error: err instanceof Error ? err.message : String(err) };
  }
  if (typeof written.error === "string") return refuse("kernel-refused", written.error);
  const rows = Array.isArray(written.solids) ? (written.solids as { name?: unknown; bytesBase64?: unknown }[]) : [];
  if (rows.length < 2) return null;
  const files = rows.map((row) => (typeof row.bytesBase64 === "string" ? base64ToBytes(row.bytesBase64) : null));
  if (files.some((file) => !file)) return refuse("export-failed", "The kernel did not write the solids of this STEP file.");
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
  // --- Assemblies M8. The solids of one STEP file are one assembly, the first its root, each where the file put it.
  const assembly = this.groupPieces(made[0]!, made.slice(1).map((piece) => piece.id), obj.fileName.replace(/\.(step|stp)$/i, ""));
  return { ok: true, objects: made.map((piece) => piece.id), names: made.map((piece) => piece.name), solids: made.length, ...(assembly ? { assembly } : {}), label: "Separate solids" };
}

function placed(this: Session, obj: PlateObject) {
  const printer = this.printer();
  return placeMesh(obj.source, obj.orient, obj.scale, printer.bedX, printer.bedY, obj.centered, obj.offset);
}

function overlaps(this: Session, obj: PlateObject): boolean {
  const a = this.placed(obj).bounds;
  return this.objects.some((other) => {
    if (other.id === obj.id) return false;
    const b = this.placed(other).bounds;
    return a.min[0] < b.max[0] - 0.05 && b.min[0] < a.max[0] - 0.05 && a.min[1] < b.max[1] - 0.05 && b.min[1] < a.max[1] - 0.05;
  });
}

function plateNotes(this: Session, obj: PlateObject, bounds: Bounds): string[] {
  const printer = this.printer();
  const notes = offBed(bounds, printer.bedX, printer.bedY, printer.bedZ, printer.kind === "belt");
  if (this.overlaps(obj)) notes.push(OVERLAP);
  return notes;
}

function find(this: Session, id: string): PlateObject | null {
  return this.objects.find((obj) => obj.id === id) ?? null;
}

function plateList(this: Session, input: Record<string, unknown>): Record<string, unknown> {
  const assemblies = this.liveAssemblies();
  const rows = this.objects.map((obj) => {
    const placed = this.placed(obj);
    const group = assemblyOf(assemblies, obj.id);
    const assembly = group?.name;
    const joint = group?.members.find((member) => member.object === obj.id)?.joint;
    const centre = [
      (placed.bounds.min[0] + placed.bounds.max[0]) / 2,
      (placed.bounds.min[1] + placed.bounds.max[1]) / 2,
      (placed.bounds.min[2] + placed.bounds.max[2]) / 2,
    ];
    const assembled = this.assembledBox(obj);
    return {
      object: obj.id,
      name: shownName(obj.name),
      bboxMm: { min: placed.bounds.min, max: placed.bounds.max },
      centreMm: centre,
      ...(assembled ? { assembledMm: assembled } : {}),
      ...(obj.frame === "part" ? { frame: "part" as const } : {}),
      ...(assembly ? { assembly } : {}),
      ...(joint ? { joint: structuredClone(joint) } : {}),
      scalePercent: obj.scale * 100,
      notes: this.plateNotes(obj, placed.bounds),
    };
  });
  const listed = page(rows, input.cursor, input.limit);
  const offer = rows.length === 0 && this.previousAutosave ? { autosave: this.previousAutosave } : {};
  return { ok: true, objects: listed.rows, ...(listed.nextCursor ? { nextCursor: listed.nextCursor } : {}), ...offer };
}

/** A name typed for a plate object, trimmed to the limit; undefined when none was given. */
function givenName(this: Session, value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, NAME_LIMIT) : undefined;
}

function objectSelect(this: Session, id: string, name?: unknown): Record<string, unknown> {
  const obj = this.find(id);
  if (!obj) return refuse("no-object", UNKNOWN_OBJECT, undefined, NEXT.plate);
  const renamed = this.givenName(name);
  if (renamed && renamed !== obj.name) {
    this.remember("Rename");
    obj.name = renamed;
  }
  this.selected = obj.id;
  return { ok: true, object: obj.id, name: shownName(obj.name) };
}

/** The chain view of the plate: the app's field names on this session's rows. */
function chainRows(this: Session): ChainObject[] {
  return this.objects.map((obj) => ({
    id: obj.id,
    name: obj.name,
    sourcePos: obj.source,
    orient: obj.orient,
    partScale: obj.scale,
    centered: obj.centered,
    offset: obj.offset,
    ...(obj.pivot ? { pivot: obj.pivot } : {}),
    ...(obj.chain ? { chain: obj.chain } : {}),
  }));
}

function writeLinks(this: Session, rows: readonly ChainObject[]): void {
  for (const row of rows) {
    const live = this.find(row.id);
    if (!live) continue;
    if (row.chain) live.chain = row.chain;
    else delete live.chain;
  }
}

/**
 * MCP has no chain tools: a pose edit moves one object and nothing follows. The links are then re-read from where
 * the parts stand, so the app's next move of a parent carries its children from here instead of snapping them
 * back to a link recorded before the edit.
 */
function relink(this: Session): void {
  if (!this.objects.some((obj) => obj.chain)) return;
  const printer = this.printer();
  this.writeLinks(refreshLinks(saneChains(this.chainRows()), { x: printer.bedX, y: printer.bedY }));
}

function objectPlace(this: Session, input: Record<string, unknown>): Record<string, unknown> {
  const obj = this.find(String(input.object));
  if (!obj) return refuse("no-object", UNKNOWN_OBJECT, undefined, NEXT.plate);
  this.remember("Place");
  const printer = this.printer();
  // The place itself is the shared one (src/modeling/placing.ts), as the app's recipe calls set it.
  // A recipe has a current solid before it has a committed plate mesh. Use that solid for the
  // bounds, including alignment targets, without committing geometry partway through the run.
  const place = { ...obj, source: obj.solid?.positions ?? obj.source };
  const bedMm: [number, number, number] = [printer.bedX, printer.bedY, printer.bedZ];
  const reply = placeOnPlate(place, input, {
    bedMm,
    ...(obj.solid ? { faces: obj.solid.faces } : {}),
    boundsOf: (id) => {
      const other = this.find(id);
      return other && other.id !== obj.id ? placedBounds({ ...other, source: other.solid?.positions ?? other.source }, bedMm) : null;
    },
  });
  if (reply.ok === true) {
    obj.orient = place.orient;
    obj.scale = place.scale;
    obj.centered = place.centered;
    obj.offset = place.offset;
    this.relink();
  }
  return reply;
}

/** Older jobs keep z and seconds. Only the latest job keeps layer paths. */
function keepLatestWire(this: Session, latest: Job): void {
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

function retainJobs(this: Session, job: Job) {
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

async function forgetObjects(this: Session): Promise<void> {
  for (const obj of [...this.objects, ...this.toolsOffPlate, ...this.piecesOffPlate]) await this.closeTree(obj);
  this.toolsOffPlate = [];
  this.piecesOffPlate = [];
}

/** The object, on the plate or taken off it by a join or an undone split to print, whose tree has this engine key. */
function byTreeKey(this: Session, key: string): PlateObject | undefined {
  return [...this.objects, ...this.toolsOffPlate, ...this.piecesOffPlate].find((row) => row.tree?.key === key);
}

/** A join without keepTool takes its tool off the plate, as the desktop does; its tree stays for replays and the save. */
function takeOffPlate(this: Session, id: string): void {
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
async function followJoins(this: Session, obj: PlateObject): Promise<{ back: string[]; left: string[] }> {
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

async function closeTree(this: Session, obj: PlateObject): Promise<void> {
  const key = obj.tree?.key;
  obj.tree = null;
  if (!key) return;
  try {
    await this.ask(this.engine.modelTree(JSON.stringify({ call: "close", key })));
  } catch {
    // Removing the part still succeeds when the modeler is already gone.
  }
}

async function objectRemove(this: Session, id: string): Promise<Record<string, unknown>> {
  const index = this.objects.findIndex((obj) => obj.id === id);
  if (index < 0) return refuse("no-object", UNKNOWN_OBJECT, undefined, NEXT.plate);
  this.remember("Remove");
  const leaving = this.objects[index];
  if (leaving) await this.closeTree(leaving);
  // Its children sit on its parent where they stand, as the app's Remove does.
  if (leaving && this.objects.some((obj) => obj.chain?.parent === id)) {
    const printer = this.printer();
    this.writeLinks(removedMember(this.chainRows(), id, { x: printer.bedX, y: printer.bedY }));
  }
  this.objects.splice(index, 1);
  if (this.selected === id) this.selected = this.objects[0]?.id ?? "";
  return { ok: true, objects: this.objects.map((obj) => obj.id), label: "Remove" };
}

function objectDuplicate(this: Session, input: Record<string, unknown>): Record<string, unknown> {
  const source = this.find(String(input.object));
  if (!source) return refuse("no-object", UNKNOWN_OBJECT, undefined, NEXT.plate);
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
      ...(source.pivot ? { pivot: [...source.pivot] as Vec3 } : {}),
      ...(source.jointLimits ? { jointLimits: structuredClone(source.jointLimits) } : {}),
    };
    delete copy.chain;
    this.objects.push(copy);
    made.push(id);
  }
  this.selected = made[made.length - 1] ?? source.id;
  return { ok: true, objects: made, label: "Duplicate" };
}

/**
 * The solids of a committed shape, one per shell, or null when the shape is one solid or cannot be read.
 * Null leaves each piece with the shape it already had.
 */
async function shellSolids(this: Session, obj: PlateObject, shells: readonly Float32Array[]): Promise<((SolidBounds & { bytes: Uint8Array }) | null)[] | null> {
  if (!obj.brep) return null;
  let written: Record<string, unknown>;
  try {
    written = JSON.parse(await this.ask(this.engine.modelTree(JSON.stringify({ call: "shapeSolids", dataB64: bytesToBase64(obj.brep) })))) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof written.error === "string" || !Array.isArray(written.solids)) return null;
  const solids: (SolidBounds & { bytes: Uint8Array })[] = [];
  for (const row of written.solids as Record<string, unknown>[]) {
    const bytes = row && typeof row.bytesBase64 === "string" ? base64ToBytes(row.bytesBase64) : null;
    const volume = row?.volumeMm3;
    const bounds = row?.bounds as { min?: unknown; max?: unknown } | undefined;
    const min = Array.isArray(bounds?.min) ? bounds.min.map(Number) : null;
    const max = Array.isArray(bounds?.max) ? bounds.max.map(Number) : null;
    if (!bytes || typeof volume !== "number" || !min || !max || min.length !== 3 || max.length !== 3 || min.some((value) => !Number.isFinite(value)) || max.some((value) => !Number.isFinite(value))) return null;
    solids.push({ bytes, volumeMm3: volume, bounds: { min, max } });
  }
  if (solids.length < 2) return null;
  return matchShellSolids(shells, obj.seatMm, solids);
}

/** `solid` is this shell's own shape. With none, the piece is a mesh and does not keep the whole compound. */
function keepShellSolid(this: Session, obj: PlateObject, solid: { bytes: Uint8Array } | null): void {
  if (solid) obj.brep = solid.bytes;
  else delete obj.brep;
  obj.platedNode = null;
  obj.treeStale = false;
}

async function splitShells(this: Session, id: string): Promise<Record<string, unknown>> {
  const obj = this.find(id);
  if (!obj) return refuse("no-object", UNKNOWN_OBJECT, undefined, NEXT.plate);
  const split = separateBy(obj.fileName, stepSolidHint(obj.bytes)) === "solids" ? await this.splitSolids(obj, true) : null;
  if (split) return split;
  const groups = shellGroups(obj.source);
  if (!groups) return refuse("single-shell", "This mesh is one shell.");
  const pieces = takeGroups(obj.source, groups.groups);
  // A commit keeps the whole shape in `brep` and an STL of every solid in `source`. The mesh splits by shell, and
  // each piece was left holding that whole shape, so a later join or describe used every solid. A shape of several
  // solids is split here, and each shell keeps the solid whose box it is.
  const splitModel = await this.shellSolids(obj, pieces);
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
      if (splitModel) this.keepShellSolid(obj, splitModel[index] ?? null);
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
      ...(splitModel ? { brep: splitModel[index]?.bytes } : {}),
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

function asBed(this: Session, obj: PlateObject): SliceObject {
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

function plateArrange(this: Session, input: Record<string, unknown>): Record<string, unknown> {
  if (this.objects.length < 2) return refuse("arrange-needs-two", "Arrange needs two objects.");
  const printer = this.printer();
  const clearance = sequentialClearance(this.sliceRules(this.objects.length), this.order());
  const gap = typeof input.gapMm === "number" ? input.gapMm : clearance === null ? ARRANGE_GAP_MM : clearance + 0.01;
  let keep: Set<string> | undefined;
  if (input.assembly !== undefined) {
    const assemblies = this.liveAssemblies();
    const wanted = String(input.assembly).trim();
    const found = assemblies.find((row) => row.name === wanted || row.id === wanted);
    if (!found) return refuse("no-assembly", assemblies.length ? `There is no assembly named ${wanted}. Assemblies: ${assemblies.map((row) => row.name).join(", ")}.` : "There is no assembly on the plate.", undefined, NEXT.assembly);
    const members = new Set(found.members.map((row) => row.object));
    keep = new Set(this.objects.filter((obj) => !members.has(obj.id)).map((obj) => obj.id));
  }
  const arranged = arrangedObjects(this.objects.map((obj) => this.asBed(obj)), printer.bedX, printer.bedY, gap, keep);
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
    this.relink();
  }
  return { ok: true, moved: moved.filter((row) => !keep?.has(row.object)).map(({ object, centre }) => ({ object, centre })), fits: outside.length === 0, ...(outside.length ? { outside } : {}), ...(input.dryRun === true ? { dryRun: true } : { stale: true }), label: "Arrange" };
}

function plateCollisions(this: Session): { a: string; b: string }[] {
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

function printOrderSet(this: Session, input: Record<string, unknown>): Record<string, unknown> {
  const order = input.order === "sequential" ? "sequential" : input.order === "together" ? "all-at-once" : null;
  if (!order) return refuse("bad-argument", "order is together or sequential.");
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

/** The methods this module adds to Session. */
export const plateMethods = {
  printer,
  filament,
  addObject,
  takeId,
  preview,
  snapObject,
  capture,
  revive,
  install,
  remember,
  plateUndo,
  plateRedo,
  meshImport,
  splitSolids,
  placed,
  overlaps,
  plateNotes,
  find,
  plateList,
  givenName,
  objectSelect,
  chainRows,
  writeLinks,
  relink,
  objectPlace,
  keepLatestWire,
  retainJobs,
  forgetObjects,
  byTreeKey,
  takeOffPlate,
  followJoins,
  closeTree,
  objectRemove,
  objectDuplicate,
  shellSolids,
  keepShellSolid,
  splitShells,
  asBed,
  plateArrange,
  plateCollisions,
  printOrderSet,
};

export const plateHandlers: Record<string, ToolHandler> = {
  mesh_import: (s, input) => s.meshImport(String(input.path), typeof input.stepToleranceMm === "number" ? input.stepToleranceMm : STEP, input.pieces === true),
  plate_list: (s, input) => s.plateList(input),
  plate_undo: (s) => s.plateUndo(),
  plate_redo: (s) => s.plateRedo(),
  object_select: (s, input) => s.objectSelect(String(input.object), input.name),
  object_place: (s, input) => s.objectPlace(input),
  object_remove: (s, input) => s.objectRemove(String(input.object)),
  object_duplicate: (s, input) => s.objectDuplicate(input),
  object_split_shells: (s, input) => s.splitShells(String(input.object)),
  plate_arrange: (s, input) => s.plateArrange(input),
  plate_print_order: (s, input) => s.printOrderSet(input),
};
