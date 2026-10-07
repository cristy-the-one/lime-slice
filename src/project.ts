/**
 * A `.lime` project file. Version 1 embeds one mesh so the file opens on its own.
 * Version 2 is a plate of objects. `migrations[1]` wraps a version 1 document into
 * that plate. A plate that is still one object with no per-object settings and no
 * support paint is written back as version 1 and omits `objects`. Support paint is
 * an optional field on each version 2 object, so a version 2 file without it still opens.
 * A later version adds a function to `migrations` at index `n` that rewrites version `n`
 * into version `n + 1`. `applyMigrations` is that hook.
 */
import type { PrinterProfile } from "./profiles.ts";
import type { PresetSettings } from "./presets.ts";
import { readPresetSettings } from "./presets.ts";
import { fnv1aHex } from "./slice-action.ts";
import { bytesToBase64 } from "./base64.ts";
import { parseOverrides, type OverrideDocument } from "./overrides.ts";
import { plateFileIsVersion2, readPlateSettings, settingsEmpty, type PlateFileObject } from "./plate.ts";
import type { EditEntry } from "./support-edit-list.ts";
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
  /** Saved-preset name these settings matched, or null when they match none. */
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

export function base64ToBytes(text: string): Uint8Array | null {
  try {
    const binary = atob(text);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function meshRecord(name: string, bytes: Uint8Array): ProjectMesh {
  return { name, bytesBase64: bytesToBase64(bytes), byteLength: bytes.byteLength, hash: fnv1aHex(bytes) };
}

export function serializeProject(project: LimeProject): string {
  const overrides = project.overrides;
  if (project.version === 2 && project.objects && plateFileIsVersion2(project.objects)) {
    const wire: Record<string, unknown> = {
      version: 2,
      settings: project.settings,
      preset: project.preset,
      profile: project.profile,
      level: project.level,
      objects: project.objects.map(stripEmptySettings),
    };
    if (overrides) wire.overrides = overrides;
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
  if (settingsEmpty(object.settings)) {
    const { settings: _settings, ...rest } = object;
    return rest;
  }
  return object;
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
  const objects = readPlateObjects(doc.objects);
  if (typeof objects === "string") return { ok: false, message: objects };
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
  if (doc.overrides !== undefined) {
    const overrides = parseOverrides(doc.overrides);
    if (!overrides.ok) return overrides;
    project.overrides = overrides.doc;
  }
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

function readPlateObjects(value: unknown): PlateFileObject[] | string {
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
  return out;
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
  const object: PlateFileObject = { id: row.id, name: row.name, mesh, placement, supportEdits: edits };
  if (settings) object.settings = settings;
  if (paint.length > 0) object.supportPaint = paint;
  if (seam.length > 0) object.seamPaint = seam;
  return object;
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

function readPair(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2 || !finite(value[0]) || !finite(value[1])) return null;
  return [value[0], value[1]];
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
