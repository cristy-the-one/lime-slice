/**
 * A `.lime` project file. Version 1 embeds one mesh so the file opens on its own.
 * Version 2 is a plate of objects. `migrations[1]` wraps a version 1 document into
 * that plate. A plate that is still one object with no per-object settings and no
 * support paint is written back as version 1 and omits `objects`. Support paint is
 * an optional field on each version 2 object, so a version 2 file without it still opens.
 * `brep` is that same kind of field: base64 STEP, present only after Model has a session.
 * `modelTree` is another: the object's Model history. A damaged one is left out and the part opens.
 * `modelTools` keeps the trees of tools that left the plate while a saved join names them.
 * `modelPose` and `meshSeatMm` place the object in Model's shared space; without them it sits where its file put it.
 * A later version adds a function to `migrations` at index `n` that rewrites version `n`
 * into version `n + 1`. `applyMigrations` is that hook.
 */
import { KLIPPER_NUMBERS, type PrinterProfile } from "./profiles.ts";
import type { LayerAction } from "./layer-actions.ts";
import type { PresetSettings } from "./presets.ts";
import { readPresetSettings } from "./presets.ts";
import { fnv1aHex } from "./slice-action.ts";
import { base64ToBytes, bytesToBase64 } from "./base64.ts";
import { parseOverrides, type OverrideDocument } from "./overrides.ts";
import { plateFileIsVersion2, readPlateSettings, settingsEmpty, type PlateFileObject } from "./plate.ts";
import { dropEmptyReinforce, readReinforcement } from "./reinforcement.ts";
import type { EditEntry } from "./support-edit-list.ts";
import { readSavedTree, savedToolObjects, treeBody } from "./model-tree-file.ts";
import type { Affine } from "./model-space.ts";
import { readSeamPaint } from "./seam-paint.ts";
import { readPaint } from "./support-paint.ts";
import type { SiteSpec } from "./support-edits.ts";

export const PROJECT_VERSION = 2;

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

/**
 * What the app holds after a project opens.
 * Version 1 is one mesh. Version 2 keeps that mesh as the first object and adds `objects`.
 * Support edits keep birth sites, not walk ids.
 */
export interface LimeProject {
  version: 1 | 2;
  mesh: ProjectMesh;
  placement: ProjectPlacement;
  settings: PresetSettings;
  /** Written as null since presets became profiles. Kept so older files still read. */
  preset: string | null;
  profile: PrinterProfile;
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
  /** Read only: the names of objects whose Model history was damaged and left out. */
  unreadHistory?: string[];
}

/** A tool's tree kept for a join after its object left the plate: the object's id and name, and its tree as an object keeps one. */
export interface ToolTree {
  id: string;
  name: string;
  modelTree: NonNullable<PlateFileObject["modelTree"]>;
}

export type ProjectResult = { ok: true; project: LimeProject } | { ok: false; message: string };

/** `steps[n]` rewrites a version-n document into version n+1 and sets `version` to n+1. */
export type Migration = (doc: Record<string, unknown>) => Record<string, unknown>;

/**
 * Index 0 would migrate a version-0 file, which was never written.
 * Index 1 wraps a version 1 file into one object, id `part`.
 */
const migrationSteps: Migration[] = [];
migrationSteps[1] = migrateVersion1;
export const migrations: readonly Migration[] = migrationSteps;

export function meshRecord(name: string, bytes: Uint8Array): ProjectMesh {
  return { name, bytesBase64: bytesToBase64(bytes), byteLength: bytes.byteLength, hash: fnv1aHex(bytes) };
}

export function serializeProject(project: LimeProject): string {
  const overrides = project.overrides;
  if (project.version === 2 && project.objects && plateFileIsVersion2(project.objects)) {
    const objects = project.objects.map(stripEmptySettings);
    const shared = shareRootSteps([...objects, ...(project.modelTools ?? [])]);
    const wire: Record<string, unknown> = {
      version: 2,
      settings: project.settings,
      preset: project.preset,
      profile: project.profile,
      level: project.level,
      objects: shared.slice(0, objects.length),
    };
    if (project.modelTools?.length) wire.modelTools = shared.slice(objects.length);
    if (overrides) wire.overrides = overrides;
    if (project.layerActions?.length) wire.layerActions = project.layerActions;
    if (project.printOrder === "sequential") {
      wire.printOrder = "sequential";
      if (project.sequentialClearanceMm !== undefined && project.sequentialClearanceMm > 0) {
        wire.sequentialClearanceMm = project.sequentialClearanceMm;
      }
      if (project.sequentialGantryMm !== undefined && project.sequentialGantryMm > 0) {
        wire.sequentialGantryMm = project.sequentialGantryMm;
      }
    }
    return JSON.stringify(wire, null, 2);
  }
  const wire: Record<string, unknown> = {
    version: 1,
    mesh: project.mesh,
    placement: project.placement,
    settings: project.settings,
    preset: project.preset,
    profile: project.profile,
    level: project.level,
    supportEdits: project.supportEdits,
  };
  if (overrides) wire.overrides = overrides;
  if (project.layerActions?.length) wire.layerActions = project.layerActions;
  return JSON.stringify(wire, null, 2);
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
  const migrated = applyMigrations(raw as Record<string, unknown>, steps, target);
  if (!migrated.ok) return migrated;
  return readProject(migrated.doc);
}

function readProject(doc: Record<string, unknown>): ProjectResult {
  if (doc.version === 2) return readVersion2(doc);
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
  return { ok: true, project };
}

function readVersion2(doc: Record<string, unknown>): ProjectResult {
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
  if (unreadHistory.length > 0) project.unreadHistory = unreadHistory;
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
  return { ok: true, project };
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
    return tree && (root || tree.rootPrimitive) ? { tree, root } : null;
  });
  const read = holders.map(({ raw }, i): PlateFileObject["modelTree"] | null => {
    const saved = trees[i];
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
  if (row.meshSeatMm !== undefined) {
    if (!finite(row.meshSeatMm)) return "This project's model space position is damaged.";
    object.meshSeatMm = row.meshSeatMm;
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

function readProfile(value: unknown): PrinterProfile | string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "This project file is incomplete.";
  const row = value as Record<string, unknown>;
  if (typeof row.name !== "string" || !row.name.trim()) return "This project file is incomplete.";
  const profile = { name: row.name } as PrinterProfile;
  for (const key of PROFILE_NUMBERS) {
    if (!finite(row[key])) return "This project file is incomplete.";
    profile[key] = row[key] as number;
  }
  // Projects saved before the Klipper limits existed have none; a stored 0 is a real value.
  for (const key of Object.keys(KLIPPER_NUMBERS) as (keyof typeof KLIPPER_NUMBERS)[]) {
    profile[key] = finite(row[key]) && (row[key] as number) >= 0 ? (row[key] as number) : KLIPPER_NUMBERS[key];
  }
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
    if (row.kind !== "pause" && row.kind !== "filamentChange") return damaged;
    if (row.note !== undefined && typeof row.note !== "string") return damaged;
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
