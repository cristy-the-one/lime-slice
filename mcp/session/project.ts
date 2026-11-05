/**
 * Projects: create, open, save, the document the file holds, and app_open.
 * The methods run with this: Session; session.ts installs them on the Session prototype.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { base64ToBytes } from "../../src/base64.ts";
import { fanDefaults } from "../../src/fan.ts";
import { ID_MATRIX, settleBy, type Mat3 } from "../../src/mesh-place.ts";
import { solidFileName, wholeTreeRequest } from "../../src/model-request.ts";
import { solidView } from "../../src/modeling/model-calls.ts";
import type { Affine } from "../../src/model-space.ts";
import { jumped, type PluginStamp } from "../../src/model-tree.ts";
import { DEFAULT_PRESET } from "../../src/presets.ts";
import { meshRecord, readParameters, type LimeProject, type ProjectPlacement, type ProjectProfile } from "../../src/project.ts";
import { decodeProject, encodeProject } from "../../src/project-codec.ts";
import { geometryHash, projectSummary, thumbnailFromPng } from "../../src/project-thumb.ts";
import { savedTree, loadedTree, toolFirst, withSavedNames } from "../../src/model-tree-file.ts";
import { emptyOverrides } from "../../src/overrides.ts";
import type { PaintDisk } from "../../src/support-paint.ts";
import type { SeamDisk } from "../../src/seam-paint.ts";
import type { ReinforceRegion } from "../../src/reinforcement.ts";
import { settingsEmpty, type PlateObjectSettings } from "../../src/plate.ts";
import { cloneStudy, type ObjectStudy } from "../../src/sim/study.ts";
import type { Workplane } from "../../src/workplane.ts";
import { plateFileIsVersion2 } from "../../src/plate.ts";
import { adoptProfile, enginePrinter } from "../../src/ui/machine-library.ts";
import { openInApp } from "../app-open.ts";
import { appVersion } from "../export-gcode.ts";
import { renderMesh } from "../render.ts";
import { isSlug, olderVersions, pluginsDir, readPlugin } from "../plugins.ts";
import { stlBytes } from "../request.ts";
import { readAssemblies } from "../../src/assembly.ts";
import { resolveRead, resolveWorkspaceFile, resolveWrite } from "../workspace.ts";
import { CHORD, ModelRunaway, type PlateObject, STEP, type ToolHandler, modelSteps, shownName, stlFileName } from "./shared.ts";
import type { Session } from "../session.ts";

async function projectCreate(this: Session, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  // --- Gaps A6. Parameters and parts are not in plate_undo: a new plate that would drop them is refused unless asked.
  const names = Object.keys(this.paramText);
  const parts = [...this.parts.keys()];
  if (input.discard !== true && (names.length > 0 || parts.length > 0)) {
    const list = (items: string[]) => (items.length > 4 ? `${items.slice(0, 4).join(", ")}, …` : items.join(", "));
    const held = [
      ...(names.length ? [`${names.length} parameter${names.length === 1 ? "" : "s"} (${list(names)})`] : []),
      ...(parts.length ? [`${parts.length} part${parts.length === 1 ? "" : "s"} (${list(parts)})`] : []),
    ].join(" and ");
    return { ok: false, reason: `This project has ${held}, which a new plate drops and plate_undo cannot bring back. Save it with project_save first, or call project_create with discard: true.` };
  }
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
  this.assemblies = [];
  this.adoptMcpModel(undefined);
  this.projectPlugins.clear();
  // --- Text milestone 4: a new project has none of the last one's fonts.
  this.fonts.clear();
  this.projectFonts = undefined;
  return { ok: true, project: "project", label: "New plate" };
}

async function projectOpen(this: Session, path: string): Promise<Record<string, unknown>> {
  const full = resolveRead(path, "lime");
  const text = await readFile(full, "utf8");
  const parsed = await decodeProject(text);
  if (!parsed.ok) return { ok: false, reason: parsed.message };
  this.remember("Open project");
  // --- Text milestone 4. The project's fonts go to the engine first, so its text steps rebuild with the bytes they were made with.
  this.fonts.clear();
  this.projectFonts = parsed.project.fonts;
  const fontNotes = await this.fonts.adopt(parsed.project.fonts);
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
        frame: obj.frame,
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
        frame: undefined,
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
    if (row.frame === "part") obj.frame = "part";
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
  this.assemblies = readAssemblies(parsed.project.assemblies, this.objects);
  this.adoptMcpModel(parsed.project.mcpModel);
  this.projectPlugins = new Map(Object.entries(parsed.project.plugins ?? {}));
  // --- D10. Plugins the project carries and the library lacks: named, never added by the open itself.
  const offered = this.projectOnlyPlugins();
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
    ...(fontNotes.length ? { fontNotes } : {}),
    ...(offered.length ? { pluginsNotInLibrary: offered.map((row) => `${row.id} v${row.version}`), pluginsNote: `This project carries plugins your library does not have. Its parts rebuild from the project's copies; to add one to the library, ask the person first, then nugget {action:"save", kind:"plugin", from:"project:${offered[0]!.id}"}.` } : {}),
    ...(skipped.length ? { notSliced: skipped, note: `This project has ${skipped.join(", ")} that this server does not slice yet. The G-code will differ from the app's.` } : {}),
  };
}

function adoptProjectMachine(this: Session, profile: ProjectProfile): void {
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
function fanOf(this: Session, profile: ProjectProfile): { fanPercent: number; overhangFanPercent: number; fanOffLayers: number } {
  const fallback = fanDefaults("");
  return {
    fanPercent: profile.fanPercent ?? fallback.fanPercent,
    overhangFanPercent: profile.overhangFanPercent ?? fallback.overhangFanPercent,
    fanOffLayers: profile.fanOffLayers ?? fallback.fanOffLayers,
  };
}

function placementOf(this: Session, obj: PlateObject): ProjectPlacement {
  return {
    orient: [...obj.orient] as ProjectPlacement["orient"],
    scale: obj.scale,
    centered: obj.centered,
    offset: { ...obj.offset },
    stepTolerance: obj.stepTolerance > 0 ? obj.stepTolerance : STEP,
  };
}

function fileObject(this: Session, obj: PlateObject): NonNullable<LimeProject["objects"]>[number] {
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
    ...(obj.frame === "part" ? { frame: "part" as const } : {}),
    ...(obj.workplane.source === "global" ? {} : { workplane: { source: obj.workplane.source, origin: [...obj.workplane.origin] as Workplane["origin"], turn: [...obj.workplane.turn] as Workplane["turn"] } }),
    ...(obj.sim ? { sim: cloneStudy(obj.sim) } : {}),
  };
}

function savedModelTree(this: Session, obj: PlateObject): NonNullable<LimeProject["objects"]>[number]["modelTree"] | undefined {
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
async function adoptHistory(this: Session, obj: PlateObject, saved: NonNullable<NonNullable<LimeProject["objects"]>[number]["modelTree"]>): Promise<string | null> {
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
    const solid = solidView(reply);
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

function bufferOf(this: Session, encoded: string): ArrayBuffer | null {
  const bytes = base64ToBytes(encoded);
  if (!bytes) return null;
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function freshDocument(this: Session): LimeProject {
  const first = this.objects[0];
  const profile = enginePrinter(this.printer(), this.filament(), this.library.nozzleMm);
  const mesh = first ? meshRecord(first.fileName, first.bytes) : meshRecord("empty.stl", new Uint8Array());
  const objects = this.objects.map((obj) => this.fileObject(obj));
  const listed = objects.length > 1 || objects.some((row) => row.modelTree || row.settings || row.supportPaint || row.seamPaint || row.reinforcement || row.workplane || row.modelPose || row.frame);
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

function projectDocument(this: Session): LimeProject {
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

function lossy(this: Session, doc: LimeProject): string | null {
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
function attachPreview(this: Session, doc: LimeProject, render: boolean) {
  doc.summary = projectSummary(doc, this.freshEstimate());
  if (render) {
    const thumb = this.renderThumbnail(doc);
    if (thumb) doc.thumbnail = thumb;
  }
  if (doc.thumbnail && doc.thumbnail.meshHash !== geometryHash(doc)) delete doc.thumbnail;
}

function freshEstimate(this: Session): { seconds: number; grams: number } | undefined {
  const job = this.latest;
  if (!job || job.status !== "done" || !job.wire || this.staleReason(job)) return undefined;
  const summary = this.summarize(job);
  return { seconds: summary.seconds, grams: summary.grams };
}

/** The plate's triangles in bed space, one array, for the thumbnail rasterizer. */
function platePositions(this: Session): Float32Array | null {
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

function renderThumbnail(this: Session, doc: LimeProject) {
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

/** --- Plugin steps (D8). Every stamp on the plate's trees, and on the trees of tools that left it. */
function stamps(this: Session): PluginStamp[] {
  const out: PluginStamp[] = [];
  for (const obj of [...this.objects, ...this.toolsOffPlate]) for (const node of obj.tree?.nodes.values() ?? []) if (node.plugin) out.push(node.plugin);
  return out;
}

/**
 * --- Plugin steps (D7). The project's copy of each library plugin a stamped step names: the copy the project came
 * with, else the library's file of that hash. Null when there are none.
 */
function pluginCopies(this: Session): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const stamp of this.stamps()) {
    if (stamp.version === 0 || out[stamp.sha256] !== undefined) continue;
    const kept = this.projectPlugins.get(stamp.sha256);
    if (kept !== undefined) {
      out[stamp.sha256] = kept;
      continue;
    }
    if (!isSlug(stamp.plugin)) continue;
    for (const version of [undefined, ...olderVersions(stamp.plugin)]) {
      const file = readPlugin(stamp.plugin, pluginsDir(), version);
      if (file && !("reason" in file) && file.sha256 === stamp.sha256) {
        out[stamp.sha256] = file.text;
        break;
      }
    }
  }
  return Object.keys(out).length ? out : null;
}

/** The project as project_save writes it, from the plate as it stands. */
function saveDocument(this: Session): LimeProject {
  const doc = this.projectDocument();
  const mcpModel = this.mcpModelRecord();
  if (mcpModel) doc.mcpModel = mcpModel;
  else delete doc.mcpModel;
  const plugins = this.pluginCopies();
  if (plugins) doc.plugins = plugins;
  else delete doc.plugins;
  const parameters = readParameters(this.paramText);
  if (parameters) doc.parameters = parameters;
  else delete doc.parameters;
  const assemblies = readAssemblies(this.assemblies, this.objects);
  if (assemblies.length > 0) doc.assemblies = assemblies;
  else delete doc.assemblies;
  const tools = this.toolsOffPlate.flatMap((tool) => {
    const modelTree = this.savedModelTree(tool);
    return modelTree ? [{ id: tool.id, name: tool.name, modelTree }] : [];
  });
  if (tools.length > 0) doc.modelTools = [...(doc.modelTools ?? []).filter((row) => !tools.some((tool) => tool.id === row.id)), ...tools];
  // --- Text milestone 4 (D5): the fonts of the person's its texts use, as the packs made so far stand for restricted ones.
  const fonts = this.fonts.recordsNow(doc, this.projectFonts);
  if (fonts) doc.fonts = fonts;
  else delete doc.fonts;
  return doc;
}

async function projectSave(this: Session, name: string, refuseExisting = false): Promise<Record<string, unknown>> {
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
  // A restricted font keeps the outlines of exactly the letters the texts use now.
  const fonts = await this.fonts.recordsFor(doc, this.projectFonts);
  if (fonts) doc.fonts = fonts;
  else delete doc.fonts;
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
async function appOpen(this: Session, path?: string): Promise<Record<string, unknown>> {
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

/** The methods this module adds to Session. */
export const projectMethods = {
  projectCreate,
  projectOpen,
  adoptProjectMachine,
  fanOf,
  placementOf,
  fileObject,
  savedModelTree,
  adoptHistory,
  bufferOf,
  freshDocument,
  projectDocument,
  lossy,
  attachPreview,
  freshEstimate,
  platePositions,
  renderThumbnail,
  stamps,
  pluginCopies,
  saveDocument,
  projectSave,
  appOpen,
};

export const projectHandlers: Record<string, ToolHandler> = {
  project_open: (s, input) => s.projectOpen(String(input.path)),
  project_create: (s, input) => s.projectCreate(input),
  project_save: (s, input) => s.projectSave(String(input.name), input.ifExists === "refuse"),
  app_open: (s, input) => s.appOpen(typeof input.path === "string" ? input.path : undefined),
};
