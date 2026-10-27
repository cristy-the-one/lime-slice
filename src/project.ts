/**
 * A `.lime` project file. Version 1 embeds one mesh so the file opens on its own.
 * Version 2 is a plate of objects. `migrations[1]` wraps a version 1 document into
 * that plate. A plate that is still one object with no per-object settings and no
 * support paint is written back as version 1 and omits `objects`. Support paint is
 * an optional field on each plate object, so a plate file without it still opens.
 * `brep` is that same kind of field: the object's solid, present only after Model has a session.
 * Version 3 is the version 2 plate whose `brep` this app writes in Open CASCADE's binary format, as the
 * engine writes it, not STEP. A `brep` is told by its first bytes (`isBrep`), not by the version: a
 * version 3 file can still carry a STEP `brep` not yet written again. `migrations[2]` takes a version 2
 * file as it is. An app before version 3 refuses a version 3 file.
 * Version 4 is the version 3 plate with its big binary records (a mesh, a solid, a root STEP) compressed: such a
 * record keeps `name`, `byteLength`, and `hash` of the original bytes, and holds the bytes as `encoding` and `data`
 * (`gzip+base64`) in place of `bytesBase64`. `src/project-codec.ts` writes and reads that form. A version 4 file
 * is always a plate, even for one plain object. `parseProject` and `serializeProject` here are the plain layer
 * under it, with every record as `bytesBase64`. A version 3 file reads as before.
 * `modelTree` is another: the object's Model history. A damaged one is left out and the part opens.
 * `modelTools` keeps the trees of tools that left the plate while a saved join names them.
 * `heldPieces` keeps the pieces a split to print for an export target holds off the plate (`HeldPiece`).
 * `assemblies` holds plate objects at poses relative to each other (`src/assembly.ts`); an older app ignores it.
 * `modelPose` and `meshSeatMm` place the object in Model's shared space; without them it sits where its file put it.
 * `workplane` is that object's local U, V, W frame, in its own frame. Without it the frame is the global one.
 * A later version adds a function to `migrations` at index `n` that rewrites version `n`
 * into version `n + 1`. `applyMigrations` is that hook.
 * `thumbnail` and `summary` are optional and do not change the version. They are written first.
 * A reader that does not know them still opens the file. See `docs/lime-explorer-preview.md`.
 */
import { KLIPPER_NUMBERS, type PrinterProfile } from "./profiles.ts";
import type { LayerAction } from "./layer-actions.ts";
import type { PresetSettings } from "./presets.ts";
import { readPresetSettings } from "./presets.ts";
import { fanDefaults, readFan, type FanSettings } from "./fan.ts";
import { fnv1aHex } from "./slice-action.ts";
import { base64ToBytes, bytesToBase64 } from "./base64.ts";
import { parseOverrides, type OverrideDocument } from "./overrides.ts";
import { plateFileIsVersion2, readPlateSettings, settingsEmpty, type PlateFileObject } from "./plate.ts";
import { readStudy } from "./sim/study.ts";
import { isGlobalFrame, readWorkplane } from "./workplane.ts";
import { dropEmptyReinforce, readReinforcement } from "./reinforcement.ts";
import type { EditEntry } from "./support-edit-list.ts";
import { readSavedTree, savedToolObjects, treeBody } from "./model-tree-file.ts";
import type { Affine } from "./model-space.ts";
import { readSeamPaint } from "./seam-paint.ts";
import { readPaint } from "./support-paint.ts";
import type { SiteSpec } from "./support-edits.ts";
import { readSummary, readThumbnail, summaryForWire, thumbnailForWire, type ProjectSummary, type ProjectThumbnail } from "./project-thumb.ts";
import { PARAM_NAME } from "./modeling/expr.ts";
import { exportsPieces } from "./split-print.ts";
import type { NodeId } from "./model-tree.ts";
import { readAssemblies, type Assembly } from "./assembly.ts";

export const PROJECT_VERSION = 4;

export type SettingsLevel = "simple" | "advanced" | "expert";

export interface ProjectMesh {
  name: string;
  /** Original mesh bytes (STL, 3MF, or STEP), base64. Not a path. */
  bytesBase64: string;
  byteLength: number;
  /** FNV-1a 64 of those bytes. */
  hash: string;
}

export interface ProjectPlacement {
  orient: [number, number, number, number, number, number, number, number, number];
  scale: number;
  centered: boolean;
  offset: { x: number; y: number; z: number };
  stepTolerance: number;
}

/** A project's printer. One saved before fan settings has no fan, and opens with the active filament's. */
export type ProjectProfile = Omit<PrinterProfile, keyof FanSettings> & Partial<FanSettings>;

/**
 * What the app holds after a project opens. `version` is its layout, not the file's number:
 * 1 is one mesh. 2 keeps that mesh as the first object and adds `objects`, and is written as `PROJECT_VERSION`.
 * Support edits keep birth sites, not walk ids.
 */
export interface LimeProject {
  version: 1 | 2;
  mesh: ProjectMesh;
  placement: ProjectPlacement;
  settings: PresetSettings;
  /** Written as null since presets became profiles. Kept so older files still read. */
  preset: string | null;
  profile: ProjectProfile;
  level: SettingsLevel;
  supportEdits: EditEntry[];
  /** Present only when the user added a height range or a modifier volume. */
  overrides?: OverrideDocument;
  /**
   * Present only for a multi-object plate, or one object with its own settings.
   * Omitted on version 1 so an older app still opens a one-object file.
   */
  objects?: PlateFileObject[];
  /** Omitted for all-at-once, so a project saved before sequential printing still opens. */
  printOrder?: "sequential";
  /** Omitted at 0, which means the nozzle radius plus one line width. */
  sequentialClearanceMm?: number;
  sequentialGantryMm?: number;
  /** Pauses and filament changes from the layer slider. Omitted when there are none. */
  layerActions?: LayerAction[];
  /**
   * The Model trees of tools that left the plate, kept because a saved join takes its tool from them. A join names its
   * tool by `id`. Omitted when there are none.
   */
  modelTools?: ToolTree[];
  /** Omitted when no split to print for an export target holds a piece. */
  heldPieces?: HeldPiece[];
  /**
   * Plate objects held at poses relative to each other (`src/assembly.ts`). Each member's solved pose is also its
   * object's `modelPose`, so an app that ignores this key draws the same assembly. Omitted when there are none.
   */
  assemblies?: Assembly[];
  /**
   * What the MCP server builds from, kept as it wrote it: its named parameters, its stored parts, and each object's
   * model_build recipe. The app writes it back on save. History reads a recipe to show "Built by a recipe".
   * Omitted when there is none.
   */
  mcpModel?: Record<string, unknown>;
  /**
   * --- A6. Named parameters, in evaluation order: a number, or an expression such as "wallH / 2".
   * Omitted when there are none. Older files keep the numbers under `mcpModel.params`; the MCP
   * still reads that, and writes this field.
   */
  parameters?: Record<string, string | number>;
  /** Read only: the names of objects whose Model history was damaged and left out. */
  unreadHistory?: string[];
  /**
   * A PNG of the plate, written first in the file so Explorer can lift it out.
   * Omitted when it is missing, damaged, or drawn from different geometry.
   */
  thumbnail?: ProjectThumbnail;
  /** Name, printer, and a few numbers for the preview card. Omitted when there is nothing to say. */
  summary?: ProjectSummary;
}

export type { ProjectSummary, ProjectThumbnail };

/** A tool's tree kept for a join after its object left the plate: the object's id and name, and its tree as an object keeps one. */
export interface ToolTree {
  id: string;
  name: string;
  modelTree: NonNullable<PlateFileObject["modelTree"]>;
}

/**
 * --- Split to print, D12. A piece of a cut for an export target, which Model holds off the plate: the part's plate object
 * (`object`), the cut's step in its tree (`node`), and the part number (`index`, from 2), or `pins: true` for the cut's pins
 * (milestone 5). It keeps its mesh as a plate object does (`mesh`, `meshSeatMm`) and its solid (`brep`), so a reopened
 * project has the piece as it was cut. The cut's `pieces` and `pins` still say null for it, as an app before this wrote
 * them: that app ignores `heldPieces` and cuts the pieces again on export, and a file it saved reads here with its pieces
 * to cut again (`piecesToCut`).
 */
export interface HeldPiece {
  object: string;
  node: NodeId;
  /** The part number; absent on the pins' row. */
  index?: number;
  pins?: true;
  mesh: ProjectMesh;
  brep?: ProjectMesh;
  meshSeatMm?: number;
}

export type ProjectResult = { ok: true; project: LimeProject } | { ok: false; message: string };

/** `steps[n]` rewrites a version-n document into version n+1 and sets `version` to n+1. */
export type Migration = (doc: Record<string, unknown>) => Record<string, unknown>;

/**
 * Index 0 would migrate a version-0 file, which was never written.
 * Index 1 wraps a version 1 file into one object, id `part`.
 * Index 2 takes a version 2 plate as it is: only what `brep` holds changed.
 * Index 3 takes a version 3 plate as it is: only how its binary records are stored changed.
 */
const migrationSteps: Migration[] = [];
migrationSteps[1] = migrateVersion1;
migrationSteps[2] = (doc) => ({ ...doc, version: 3 });
migrationSteps[3] = (doc) => ({ ...doc, version: 4 });
export const migrations: readonly Migration[] = migrationSteps;

export function meshRecord(name: string, bytes: Uint8Array): ProjectMesh {
  return { name, bytesBase64: bytesToBase64(bytes), byteLength: bytes.byteLength, hash: fnv1aHex(bytes) };
}

/** The plain text of a project: every binary record whole, as `bytesBase64`. A file is written by `encodeProject`. */
export function serializeProject(project: LimeProject): string {
  return JSON.stringify(projectWire(project), null, 2);
}

/**
 * The document a save writes, as a value: always a plate at `PROJECT_VERSION`. A one-object project with nothing of
 * its own becomes the plate of its one object, id `part`, as `migrations[1]` would make it.
 */
export function projectWire(project: LimeProject): Record<string, unknown> {
  const plate = project.version === 2 && project.objects && plateFileIsVersion2(project.objects) ? project.objects : null;
  const own: PlateFileObject = { id: "part", name: project.mesh.name, mesh: project.mesh, placement: project.placement, supportEdits: project.supportEdits };
  const objects = (plate ?? [own]).map(stripEmptySettings);
  const shared = shareRootSteps([...objects, ...(plate ? (project.modelTools ?? []) : [])]);
  const wire: Record<string, unknown> = {
    version: PROJECT_VERSION,
    settings: project.settings,
    preset: project.preset,
    profile: project.profile,
    level: project.level,
    objects: shared.slice(0, objects.length),
  };
  if (plate && project.modelTools?.length) wire.modelTools = shared.slice(objects.length);
  if (plate && project.heldPieces?.length) wire.heldPieces = project.heldPieces;
  const assemblies = plate ? readAssemblies(project.assemblies, plate) : [];
  if (assemblies.length > 0) wire.assemblies = assemblies;
  // --- A8. The MCP record rides along, including each object's recipe. ---
  if (project.mcpModel) wire.mcpModel = project.mcpModel;
  const parameters = parametersForWire(project.parameters);
  if (parameters) wire.parameters = parameters;
  if (project.overrides) wire.overrides = project.overrides;
  if (project.layerActions?.length) wire.layerActions = project.layerActions;
  if (plate && project.printOrder === "sequential") {
    wire.printOrder = "sequential";
    if (project.sequentialClearanceMm !== undefined && project.sequentialClearanceMm > 0) {
      wire.sequentialClearanceMm = project.sequentialClearanceMm;
    }
    if (project.sequentialGantryMm !== undefined && project.sequentialGantryMm > 0) {
      wire.sequentialGantryMm = project.sequentialGantryMm;
    }
  }
  return withPreview(project, wire);
}

/** `thumbnail`, then `summary`, then the keys the file already had. Absent fields stay absent. */
function withPreview(project: LimeProject, body: Record<string, unknown>): Record<string, unknown> {
  const wire: Record<string, unknown> = {};
  const thumbnail = thumbnailForWire(project);
  const summary = summaryForWire(project.summary);
  if (thumbnail) wire.thumbnail = thumbnail;
  if (summary) wire.summary = summary;
  return Object.assign(wire, body);
}

/** Version 1 becomes one object. Plate settings stay on the document. The single mesh fields move onto that object. */
function migrateVersion1(doc: Record<string, unknown>): Record<string, unknown> {
  const mesh = doc.mesh;
  let name = "part";
  if (mesh && typeof mesh === "object" && !Array.isArray(mesh)) {
    const meshName = (mesh as { name?: unknown }).name;
    if (typeof meshName === "string" && meshName.trim()) name = meshName;
  }
  const object: Record<string, unknown> = {
    id: "part",
    name,
    mesh: doc.mesh,
    placement: doc.placement,
    supportEdits: doc.supportEdits ?? [],
  };
  const next: Record<string, unknown> = { ...doc, version: 2, objects: [object] };
  delete next.mesh;
  delete next.placement;
  delete next.supportEdits;
  return next;
}

function stripEmptySettings(object: PlateFileObject): PlateFileObject {
  const nonEmptyReinforce = dropEmptyReinforce(object.reinforcement ?? []);
  const { settings, reinforcement: _reinforce, ...rest } = object;
  return {
    ...rest,
    ...(settingsEmpty(settings) ? {} : { settings }),
    ...(nonEmptyReinforce.length > 0 ? { reinforcement: nonEmptyReinforce } : {}),
  };
}

type StepRecord = { name: string; bytesBase64?: string; byteLength: number; hash: string };

const recordId = (record: StepRecord) => `${record.hash}:${record.byteLength}`;

/** A plate object, or a tool's tree kept for a join: what holds bytes and a tree. */
type TreeHolder = Pick<PlateFileObject, "modelTree"> & { mesh?: ProjectMesh; brep?: ProjectMesh };

/**
 * Bytes the file holds in full, by hash and length: every mesh and solid. Root STEPs written in
 * full join after them, in object order, then the kept tools' in theirs. The first of each wins,
 * on write and on read alike.
 */
function bytesPool(objects: readonly TreeHolder[]): Map<string, string> {
  const pool = new Map<string, string>();
  for (const obj of objects) {
    for (const record of [obj.mesh, obj.brep]) if (record && !pool.has(recordId(record))) pool.set(recordId(record), record.bytesBase64);
  }
  return pool;
}

/**
 * A root STEP whose bytes the file already holds (a copy's root, or a tree on its root step) is
 * written as its name, hash, and length alone. Telo's root is 17 MB of base64.
 */
function shareRootSteps<T extends TreeHolder>(objects: T[]): T[] {
  const pool = bytesPool(objects);
  return objects.map((obj) => {
    const root = obj.modelTree?.rootStep;
    if (!obj.modelTree || !root?.bytesBase64) return obj;
    const known = pool.get(recordId(root));
    if (known === undefined) pool.set(recordId(root), root.bytesBase64);
    if (known !== root.bytesBase64) return obj;
    return { ...obj, modelTree: { ...obj.modelTree, rootStep: { name: root.name, byteLength: root.byteLength, hash: root.hash } } };
  });
}

/**
 * Walk `doc.version` up to `target` by calling `steps[version]`.
 * A missing step, a step that does not advance the version, or a newer file is a failed open.
 */
export function applyMigrations(
  doc: Record<string, unknown>,
  steps: readonly Migration[] = migrations,
  target = PROJECT_VERSION,
): { ok: true; doc: Record<string, unknown> } | { ok: false; message: string } {
  if (typeof doc.version !== "number" || !Number.isInteger(doc.version)) {
    return { ok: false, message: "This project file has no version, so it cannot be opened." };
  }
  let current = doc;
  let version = doc.version;
  if (version > target) {
    return { ok: false, message: `This project is version ${version}. This app opens up to version ${target}.` };
  }
  while (version < target) {
    const step = steps[version];
    if (!step) return { ok: false, message: `This project is version ${version}, which this app cannot update.` };
    let next: Record<string, unknown>;
    try {
      next = step({ ...current });
    } catch {
      return { ok: false, message: "This project could not be updated to the current format." };
    }
    if (!next || typeof next.version !== "number" || next.version !== version + 1) {
      return { ok: false, message: "This project could not be updated to the current format." };
    }
    current = next;
    version = next.version;
  }
  return { ok: true, doc: current };
}

export function parseProject(text: string, steps: readonly Migration[] = migrations, target = PROJECT_VERSION): ProjectResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, message: "This file is not a Lime Slice project." };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: "This file is not a Lime Slice project." };
  }
  return parseProjectDoc(raw as Record<string, unknown>, steps, target);
}

/** `parseProject` for a document already parsed from JSON, with every binary record as `bytesBase64`. */
export function parseProjectDoc(raw: Record<string, unknown>, steps: readonly Migration[] = migrations, target = PROJECT_VERSION): ProjectResult {
  const migrated = applyMigrations(raw, steps, target);
  if (!migrated.ok) return migrated;
  return readProject(migrated.doc);
}

function readProject(doc: Record<string, unknown>): ProjectResult {
  if (doc.version === PROJECT_VERSION) return readPlate(doc);
  if (doc.version !== 1) {
    return { ok: false, message: "This project could not be updated to the current format." };
  }
  return readVersion1(doc);
}

function readVersion1(doc: Record<string, unknown>): ProjectResult {
  const mesh = readMesh(doc.mesh);
  if (typeof mesh === "string") return { ok: false, message: mesh };
  const placement = readPlacement(doc.placement);
  if (typeof placement === "string") return { ok: false, message: placement };
  const settings = readSettings(doc.settings);
  if (typeof settings === "string") return { ok: false, message: settings };
  const profile = readProfile(doc.profile);
  if (typeof profile === "string") return { ok: false, message: profile };
  const level = doc.level;
  if (level !== "simple" && level !== "advanced" && level !== "expert") {
    return { ok: false, message: "This project file is incomplete." };
  }
  const preset = doc.preset === null ? null : typeof doc.preset === "string" ? doc.preset : undefined;
  if (preset === undefined) return { ok: false, message: "This project file is incomplete." };
  const edits = readEdits(doc.supportEdits);
  if (typeof edits === "string") return { ok: false, message: edits };
  const project: LimeProject = { version: 1, mesh, placement, settings, preset, profile, level, supportEdits: edits };
  if (doc.overrides !== undefined) {
    const overrides = parseOverrides(doc.overrides);
    if (!overrides.ok) return overrides;
    project.overrides = overrides.doc;
  }
  const actions = readLayerActions(doc.layerActions);
  if (typeof actions === "string") return { ok: false, message: actions };
  if (actions.length > 0) project.layerActions = actions;
  const parameters = readParameters(doc.parameters);
  if (parameters) project.parameters = parameters;
  takePreview(doc, project);
  return { ok: true, project };
}

function readPlate(doc: Record<string, unknown>): ProjectResult {
  const settings = readSettings(doc.settings);
  if (typeof settings === "string") return { ok: false, message: settings };
  const profile = readProfile(doc.profile);
  if (typeof profile === "string") return { ok: false, message: profile };
  const level = doc.level;
  if (level !== "simple" && level !== "advanced" && level !== "expert") {
    return { ok: false, message: "This project file is incomplete." };
  }
  const preset = doc.preset === null ? null : typeof doc.preset === "string" ? doc.preset : undefined;
  if (preset === undefined) return { ok: false, message: "This project file is incomplete." };
  const read = readPlateObjects(doc.objects, doc.modelTools);
  if (typeof read === "string") return { ok: false, message: read };
  const { objects, modelTools, unreadHistory } = read;
  const primary = objects[0];
  if (!primary) return { ok: false, message: "This project file is incomplete." };
  const project: LimeProject = {
    version: plateFileIsVersion2(objects) ? 2 : 1,
    mesh: primary.mesh,
    placement: primary.placement,
    settings,
    preset,
    profile,
    level,
    supportEdits: primary.supportEdits,
  };
  if (project.version === 2) project.objects = objects;
  if (modelTools.length > 0) project.modelTools = modelTools;
  const held = project.version === 2 ? readHeldPieces(doc.heldPieces, objects) : [];
  if (held.length > 0) project.heldPieces = held;
  const assemblies = project.version === 2 ? readAssemblies(doc.assemblies, objects) : [];
  if (assemblies.length > 0) project.assemblies = assemblies;
  if (unreadHistory.length > 0) project.unreadHistory = unreadHistory;
  if (doc.mcpModel && typeof doc.mcpModel === "object" && !Array.isArray(doc.mcpModel)) project.mcpModel = doc.mcpModel as Record<string, unknown>;
  const parameters = readParameters(doc.parameters);
  if (parameters) project.parameters = parameters;
  if (doc.overrides !== undefined) {
    const overrides = parseOverrides(doc.overrides);
    if (!overrides.ok) return overrides;
    project.overrides = overrides.doc;
  }
  const actions = readLayerActions(doc.layerActions);
  if (typeof actions === "string") return { ok: false, message: actions };
  if (actions.length > 0) project.layerActions = actions;
  if (project.version === 2 && doc.printOrder === "sequential") {
    project.printOrder = "sequential";
    if (finite(doc.sequentialClearanceMm) && (doc.sequentialClearanceMm as number) > 0 && (doc.sequentialClearanceMm as number) <= 100) {
      project.sequentialClearanceMm = doc.sequentialClearanceMm as number;
    }
    if (finite(doc.sequentialGantryMm) && (doc.sequentialGantryMm as number) > 0 && (doc.sequentialGantryMm as number) <= 500) {
      project.sequentialGantryMm = doc.sequentialGantryMm as number;
    }
  }
  takePreview(doc, project);
  return { ok: true, project };
}

/** Named parameters worth writing. An empty table is omitted, so an older file stays as it was. */
function parametersForWire(table: Record<string, string | number> | undefined): Record<string, string | number> | undefined {
  const read = readParameters(table);
  return read && Object.keys(read).length > 0 ? read : undefined;
}

/**
 * A parameter table as the file keeps it. A number is a plain value. A string is an expression.
 * A bad name or value is left out, and a missing or damaged field does not refuse the file.
 */
export function readParameters(value: unknown): Record<string, string | number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string | number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!PARAM_NAME.test(key)) continue;
    if (typeof raw === "number" && Number.isFinite(raw)) out[key] = raw;
    else if (typeof raw === "string" && raw.trim()) out[key] = raw;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function takePreview(doc: Record<string, unknown>, project: LimeProject) {
  const thumbnail = readThumbnail(doc.thumbnail);
  if (thumbnail) project.thumbnail = thumbnail;
  const summary = readSummary(doc.summary);
  if (summary) project.summary = summary;
}

function readPlateObjects(value: unknown, tools: unknown): { objects: PlateFileObject[]; modelTools: ToolTree[]; unreadHistory: string[] } | string {
  if (!Array.isArray(value) || value.length === 0) return "This project file is incomplete.";
  const out: PlateFileObject[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const read = readPlateObject(item);
    if (typeof read === "string") return read;
    if (seen.has(read.id)) return "This project file is incomplete.";
    seen.add(read.id);
    out.push(read);
  }
  // A kept tool is a plate object no more: its id and name, and its tree. One that is not even that is left out, named if it can be.
  const keptRows = Array.isArray(tools) ? tools : [];
  const unreadHistory: string[] = [];
  const kept: { id: string; name: string; raw: unknown }[] = [];
  for (const row of keptRows) {
    const item = row && typeof row === "object" && !Array.isArray(row) ? (row as Record<string, unknown>) : {};
    const name = typeof item.name === "string" && item.name.trim() ? item.name : "";
    if (typeof item.id === "string" && item.id && name && !seen.has(item.id)) {
      seen.add(item.id);
      kept.push({ id: item.id, name, raw: item.modelTree });
    } else {
      unreadHistory.push(name || "a removed tool");
    }
  }
  const holders = [...out.map((obj, i) => ({ id: obj.id, name: obj.name, raw: (value[i] as Record<string, unknown>).modelTree })), ...kept];
  const pool = bytesPool(out);
  const trees = holders.map(({ raw }) => {
    // Every whole root STEP joins the bytes, as the writer counted it, even in a tree too damaged to read.
    const root = raw && typeof raw === "object" ? readRootStep((raw as Record<string, unknown>).rootStep) : null;
    if (root?.bytesBase64 !== undefined && !pool.has(recordId(root))) pool.set(recordId(root), root.bytesBase64);
    const tree = raw == null ? null : readSavedTree(raw);
    return tree && (root || tree.rootPrimitive || tree.rootFeature) ? { tree, root } : null;
  });
  const read = holders.map(({ raw }, i): PlateFileObject["modelTree"] | null => {
    const saved = trees[i];
    // A sketch-started solid's root is its feature: there are no bytes to find.
    if (saved?.tree.rootFeature) return { ...treeBody(saved.tree), rootFeature: saved.tree.rootFeature };
    // A new solid's root is its primitive: there are no bytes to find.
    if (saved?.tree.rootPrimitive) return { ...treeBody(saved.tree), rootPrimitive: saved.tree.rootPrimitive };
    const bytesBase64 = saved?.root ? saved.root.bytesBase64 ?? pool.get(recordId(saved.root)) : undefined;
    if (saved?.root && bytesBase64 !== undefined) return { ...treeBody(saved.tree), rootStep: { ...saved.root, bytesBase64 } };
    return raw != null ? null : undefined;
  });
  // A join whose tool's tree is not in the file cannot rebuild: its tree is left out as a damaged one is, and then any
  // tree that took a tool from that one, and so on. A kept tool no tree names any more goes quietly.
  for (let changed = true; changed; ) {
    changed = false;
    const readable = new Set(holders.filter((_, i) => read[i]).map(({ id }) => id));
    read.forEach((tree, i) => {
      if (tree && [...savedToolObjects(tree)].some((id) => !readable.has(id))) {
        read[i] = null;
        changed = true;
      }
    });
  }
  const named = new Set(read.flatMap((tree) => (tree ? [...savedToolObjects(tree)] : [])));
  const modelTools: ToolTree[] = [];
  holders.forEach(({ id, name }, i) => {
    const tree = read[i];
    if (i >= out.length) {
      if (tree && named.has(id)) modelTools.push({ id, name, modelTree: tree });
      return;
    }
    if (tree) out[i]!.modelTree = tree;
    else if (tree === null) unreadHistory.push(name);
  });
  return { objects: out, modelTools, unreadHistory };
}

/**
 * The held pieces of a file, each for a cut for an export target in its object's tree that names no piece there. A row
 * that is damaged, or names no such cut, is left out: the piece is cut again (`piecesToCut`).
 */
function readHeldPieces(value: unknown, objects: readonly PlateFileObject[]): HeldPiece[] {
  if (!Array.isArray(value)) return [];
  const out: HeldPiece[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const pins = row.pins === true;
    if (typeof row.object !== "string" || !Number.isInteger(row.node) || pins === Number.isInteger(row.index)) continue;
    const node = row.node as number;
    const index = pins ? undefined : (row.index as number);
    const cut = objects.find((obj) => obj.id === row.object)?.modelTree?.nodes.find((step) => step.id === node);
    if (!cut || !exportsPieces(cut.op?.kind === "partition" ? cut.op : null)) continue;
    if (index === undefined ? cut.pins !== null : index < 2 || cut.pieces?.[index - 2] !== null) continue;
    const mesh = readMesh(row.mesh);
    const brep = row.brep === undefined ? undefined : readMesh(row.brep);
    const id = `${row.object}#${node}#${index ?? "pins"}`;
    if (typeof mesh === "string" || typeof brep === "string" || seen.has(id)) continue;
    seen.add(id);
    out.push({ object: row.object, node, ...(index === undefined ? { pins: true as const } : { index }), mesh, ...(brep ? { brep } : {}), ...(finite(row.meshSeatMm) ? { meshSeatMm: row.meshSeatMm as number } : {}) });
  }
  return out;
}

/**
 * The pieces of each cut for an export target that a project holds no saved piece for, as a file 3.8.0 wrote: each
 * plate object's cut, its step, the part numbers to cut again, and `pins` when its pins are to be made again too.
 */
export function piecesToCut(project: LimeProject): { object: string; node: NodeId; indexes: number[]; pins?: true }[] {
  const out: { object: string; node: NodeId; indexes: number[]; pins?: true }[] = [];
  for (const obj of project.objects ?? []) {
    for (const step of obj.modelTree?.nodes ?? []) {
      if (!exportsPieces(step.op?.kind === "partition" ? step.op : null) || !step.pieces) continue;
      const kept = (index?: number) => !!project.heldPieces?.some((held) => held.object === obj.id && held.node === step.id && (index === undefined ? held.pins === true : held.index === index));
      const indexes = step.pieces.flatMap((piece, at) => (piece === null && !kept(at + 2) ? [at + 2] : []));
      const pins = step.pins === null && !kept();
      if (indexes.length > 0 || pins) out.push({ object: obj.id, node: step.id, indexes, ...(pins ? { pins: true as const } : {}) });
    }
  }
  return out;
}

/** A root STEP: whole, or its name, hash, and length alone when the file holds those bytes elsewhere. */
function readRootStep(value: unknown): StepRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.bytesBase64 !== undefined) {
    const whole = readMesh(row);
    return typeof whole === "string" ? null : whole;
  }
  if (typeof row.name !== "string" || !row.name.trim() || typeof row.hash !== "string" || !Number.isInteger(row.byteLength)) return null;
  return { name: row.name, byteLength: row.byteLength as number, hash: row.hash };
}

function readPlateObject(value: unknown): PlateFileObject | string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "This project file is incomplete.";
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !row.id) return "This project file is incomplete.";
  if (typeof row.name !== "string" || !row.name.trim()) return "This project file is incomplete.";
  const mesh = readMesh(row.mesh);
  if (typeof mesh === "string") return mesh;
  const placement = readPlacement(row.placement);
  if (typeof placement === "string") return placement;
  const edits = row.supportEdits === undefined ? [] : readEdits(row.supportEdits);
  if (typeof edits === "string") return edits;
  const settings = readPlateSettings(row.settings);
  if (typeof settings === "string") return settings;
  const paint = readPaint(row.supportPaint);
  if (typeof paint === "string") return paint;
  const seam = readSeamPaint(row.seamPaint);
  if (typeof seam === "string") return seam;
  const reinforcement = readReinforcement(row.reinforcement);
  if (typeof reinforcement === "string") return reinforcement;
  const object: PlateFileObject = { id: row.id, name: row.name, mesh, placement, supportEdits: edits };
  if (settings) object.settings = settings;
  if (paint.length > 0) object.supportPaint = paint;
  if (seam.length > 0) object.seamPaint = seam;
  if (reinforcement.length > 0) object.reinforcement = reinforcement;
  if (row.modelPose !== undefined) {
    const pose = readPose(row.modelPose);
    if (!pose) return "This project's model space position is damaged.";
    object.modelPose = pose;
  }
  if (row.frame === "part") object.frame = "part";
  if (row.workplane !== undefined) {
    const plane = readWorkplane(row.workplane);
    if (!plane) return "This project's workplane is damaged.";
    if (!isGlobalFrame(plane)) object.workplane = plane;
  }
  if (row.meshSeatMm !== undefined) {
    if (!finite(row.meshSeatMm)) return "This project's model space position is damaged.";
    object.meshSeatMm = row.meshSeatMm;
  }
  // A damaged study is left out, the way a damaged history is. The rest of the file still opens.
  if (row.sim !== undefined) {
    const sim = readStudy(row.sim);
    if (sim) object.sim = sim;
  }
  if (row.brep !== undefined && row.brep !== null) {
    const brep = readMesh(row.brep);
    if (typeof brep === "string") {
      return brep.includes("missing") ? "This project is missing its solid." : "The solid in this project is damaged.";
    }
    object.brep = brep;
  }
  return object;
}

/** `{m, t}`: a turn, times at most one uniform scale, and a move. A shear, a mirror, or a collapse is damage. */
function readPose(value: unknown): Affine | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { m, t } = value as Record<string, unknown>;
  if (!Array.isArray(m) || m.length !== 9 || !m.every(finite)) return null;
  if (!Array.isArray(t) || t.length !== 3 || !t.every(finite)) return null;
  const col = (c: number) => [m[c] as number, m[c + 3] as number, m[c + 6] as number];
  const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  const [x, y, z] = [col(0), col(1), col(2)];
  const s2 = dot(x, x);
  const tol = 1e-6 * Math.max(s2, 1e-12);
  if (!(s2 > 1e-12) || Math.abs(dot(y, y) - s2) > tol || Math.abs(dot(z, z) - s2) > tol) return null;
  if (Math.abs(dot(x, y)) > tol || Math.abs(dot(y, z)) > tol || Math.abs(dot(x, z)) > tol) return null;
  const det = x[0]! * (y[1]! * z[2]! - y[2]! * z[1]!) - y[0]! * (x[1]! * z[2]! - x[2]! * z[1]!) + z[0]! * (x[1]! * y[2]! - x[2]! * y[1]!);
  if (!(det > 0)) return null;
  return { m: [...m] as Affine["m"], t: [t[0], t[1], t[2]] };
}

function readMesh(value: unknown): ProjectMesh | string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "This project is missing its mesh.";
  const mesh = value as Record<string, unknown>;
  if (typeof mesh.name !== "string" || !mesh.name.trim()) return "This project is missing its mesh.";
  if (typeof mesh.bytesBase64 !== "string" || typeof mesh.byteLength !== "number" || typeof mesh.hash !== "string") {
    return "The mesh in this project is damaged.";
  }
  const bytes = base64ToBytes(mesh.bytesBase64);
  if (!bytes || bytes.byteLength !== mesh.byteLength || fnv1aHex(bytes) !== mesh.hash) {
    return "The mesh in this project is damaged.";
  }
  return { name: mesh.name, bytesBase64: mesh.bytesBase64, byteLength: mesh.byteLength, hash: mesh.hash };
}

function readPlacement(value: unknown): ProjectPlacement | string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "This project file is incomplete.";
  const row = value as Record<string, unknown>;
  const orient = row.orient;
  if (!Array.isArray(orient) || orient.length !== 9 || orient.some((n) => typeof n !== "number" || !Number.isFinite(n))) {
    return "This project file is incomplete.";
  }
  const offset = row.offset;
  if (!offset || typeof offset !== "object" || Array.isArray(offset)) return "This project file is incomplete.";
  const shift = offset as Record<string, unknown>;
  const scale = row.scale;
  const stepTolerance = row.stepTolerance;
  if (typeof row.centered !== "boolean" || !finite(scale) || !finite(shift.x) || !finite(shift.y) || !finite(shift.z) || !finite(stepTolerance)) {
    return "This project file is incomplete.";
  }
  return {
    orient: orient as ProjectPlacement["orient"],
    scale,
    centered: row.centered,
    offset: { x: shift.x as number, y: shift.y as number, z: shift.z as number },
    stepTolerance,
  };
}

function readSettings(value: unknown): PresetSettings | string {
  return readPresetSettings(value) ?? "This project file is incomplete.";
}

const PROFILE_NUMBERS = [
  "nozzleDiameter",
  "filamentDiameter",
  "nozzleTemp",
  "bedTemp",
  "bedX",
  "bedY",
  "bedZ",
  "maxVolumetricMm3S",
  "maxAccel",
  "filamentDensityGCm3",
  "filamentCostPerKg",
  "pressureAdvance",
  "linearAdvance",
] as const;

function readProfile(value: unknown): ProjectProfile | string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "This project file is incomplete.";
  const row = value as Record<string, unknown>;
  if (typeof row.name !== "string" || !row.name.trim()) return "This project file is incomplete.";
  const profile = { name: row.name } as ProjectProfile;
  for (const key of PROFILE_NUMBERS) {
    if (!finite(row[key])) return "This project file is incomplete.";
    profile[key] = row[key] as number;
  }
  // Projects saved before the Klipper limits existed have none; a stored 0 is a real value.
  for (const key of Object.keys(KLIPPER_NUMBERS) as (keyof typeof KLIPPER_NUMBERS)[]) {
    profile[key] = finite(row[key]) && (row[key] as number) >= 0 ? (row[key] as number) : KLIPPER_NUMBERS[key];
  }
  // A project that saved a fan saved all of it; a support fan it left out follows the fan.
  if (finite(row.fanPercent)) Object.assign(profile, readFan(row, fanDefaults("")));
  return profile;
}

function readEdits(value: unknown): EditEntry[] | string {
  if (!Array.isArray(value)) return "This project file is incomplete.";
  const out: EditEntry[] = [];
  for (const entry of value) {
    const read = readEdit(entry);
    if (typeof read === "string") return read;
    out.push(read);
  }
  return out;
}

/** A prune keeps sites (xy plus contact height). A regrow keeps its region and z range. Walk ids are not read. */
function readEdit(value: unknown): EditEntry | string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "This project file is incomplete.";
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "number" || !Number.isInteger(row.id) || row.id < 1) return "This project file is incomplete.";
  const edit = row.edit;
  if (!edit || typeof edit !== "object" || Array.isArray(edit)) return "This project file is incomplete.";
  const body = edit as Record<string, unknown>;
  if (body.kind === "prune") {
    if (row.scope !== "branch" && row.scope !== "tree") return "This project file is incomplete.";
    const sites = readSites(body.sites);
    if (typeof sites === "string") return sites;
    return { id: row.id, scope: row.scope, edit: { kind: "prune", sites } };
  }
  if (body.kind === "regrow") {
    if (!finite(row.areaMm2)) return "This project file is incomplete.";
    const region = readRegion(body.region);
    const z = readPair(body.z);
    if (typeof region === "string") return region;
    if (!z) return "This project file is incomplete.";
    return { id: row.id, areaMm2: row.areaMm2 as number, edit: { kind: "regrow", region, z } };
  }
  return "This project file is incomplete.";
}

function readSites(value: unknown): SiteSpec[] | string {
  if (!Array.isArray(value) || value.length === 0) return "This project file is incomplete.";
  const sites: SiteSpec[] = [];
  for (const site of value) {
    if (!site || typeof site !== "object" || Array.isArray(site)) return "This project file is incomplete.";
    const row = site as Record<string, unknown>;
    const xy = readPair(row.xy);
    if (!xy || !finite(row.z)) return "This project file is incomplete.";
    sites.push({ xy, z: row.z as number });
  }
  return sites;
}

function readRegion(value: unknown): [number, number][][] | string {
  if (!Array.isArray(value) || value.length === 0) return "This project file is incomplete.";
  const loops: [number, number][][] = [];
  for (const loop of value) {
    if (!Array.isArray(loop) || loop.length < 3) return "This project file is incomplete.";
    const points: [number, number][] = [];
    for (const point of loop) {
      const xy = readPair(point);
      if (!xy) return "This project file is incomplete.";
      points.push(xy);
    }
    loops.push(points);
  }
  return loops;
}

function readLayerActions(value: unknown): LayerAction[] | string {
  if (value === undefined) return [];
  const damaged = "The pauses and filament changes in this project are damaged.";
  if (!Array.isArray(value)) return damaged;
  const out: LayerAction[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return damaged;
    const row = item as Record<string, unknown>;
    if (!finite(row.zMm) || row.zMm < 0) return damaged;
    if (row.note !== undefined && typeof row.note !== "string") return damaged;
    if (row.kind === "customGcode") {
      if (typeof row.gcode !== "string" || row.gcode.trim() === "") return damaged;
      out.push({ zMm: row.zMm, kind: "customGcode", gcode: row.gcode, ...(row.note ? { note: row.note } : {}) });
      continue;
    }
    if (row.kind !== "pause" && row.kind !== "filamentChange") return damaged;
    out.push({ zMm: row.zMm, kind: row.kind, ...(row.note ? { note: row.note } : {}) });
  }
  return out;
}

function readPair(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2 || !finite(value[0]) || !finite(value[1])) return null;
  return [value[0], value[1]];
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
