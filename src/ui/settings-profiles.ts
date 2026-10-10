/**
 * Named settings profiles. Version 1 stores a preset and a settings level.
 * A later version adds a function to `profileMigrations` at index `n` that rewrites version `n`
 * into version `n + 1`.
 */
import type { SettingsLevel } from "../project.ts";
import { readPresetSettings, type PresetSettings } from "../presets.ts";

export const SETTINGS_PROFILE_VERSION = 1;

export interface SettingsProfileFile {
  version: 1;
  name: string;
  settings: PresetSettings;
  level: SettingsLevel;
}

export interface NamedSettingsProfile {
  id: string;
  name: string;
  settings: PresetSettings;
  level: SettingsLevel;
}

export interface ProfileLibrary {
  version: 1;
  activeId: string | null;
  profiles: NamedSettingsProfile[];
}

export type ProfileFileResult = { ok: true; profile: SettingsProfileFile } | { ok: false; message: string };

/** `steps[n]` rewrites a version-n document into version n+1 and sets `version` to n+1. */
export type ProfileMigration = (doc: Record<string, unknown>) => Record<string, unknown>;

/** Empty until a version 2 exists. */
export const profileMigrations: readonly ProfileMigration[] = [];

export function emptyLibrary(): ProfileLibrary {
  return { version: 1, activeId: null, profiles: [] };
}

export function serializeLibrary(library: ProfileLibrary): string {
  return JSON.stringify(library);
}

export function parseLibrary(text: string | null): ProfileLibrary {
  if (!text) return emptyLibrary();
  try {
    const raw = JSON.parse(text) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyLibrary();
    const doc = raw as Record<string, unknown>;
    if (doc.version !== 1 || !Array.isArray(doc.profiles)) return emptyLibrary();
    const profiles: NamedSettingsProfile[] = [];
    for (const row of doc.profiles) {
      const read = readNamed(row);
      if (read) profiles.push(read);
    }
    const activeId = typeof doc.activeId === "string" && profiles.some((profile) => profile.id === doc.activeId) ? doc.activeId : null;
    return { version: 1, activeId, profiles };
  } catch {
    return emptyLibrary();
  }
}

export function serializeSettingsProfile(file: SettingsProfileFile): string {
  return JSON.stringify(file, null, 2);
}

export function profileFileName(name: string): string {
  const safe = name.trim().replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "settings";
  return `${safe}.limeprofile.json`;
}

export function parseSettingsProfile(
  text: string,
  steps: readonly ProfileMigration[] = profileMigrations,
  target = SETTINGS_PROFILE_VERSION,
): ProfileFileResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, message: "This file is not a Lime Slice settings profile." };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: "This file is not a Lime Slice settings profile." };
  }
  const migrated = applyProfileMigrations(raw as Record<string, unknown>, steps, target);
  if (!migrated.ok) return migrated;
  return readFile(migrated.doc);
}

export function saveInto(library: ProfileLibrary, name: string, settings: PresetSettings, level: SettingsLevel, id: string): ProfileLibrary | string {
  const trimmed = name.trim();
  if (!trimmed) return "Name the profile first.";
  const existing = library.profiles.find((profile) => profile.name === trimmed);
  if (existing) {
    return {
      version: 1,
      activeId: existing.id,
      profiles: library.profiles.map((profile) => profile.id === existing.id ? { ...profile, settings: cloneSettings(settings), level } : profile),
    };
  }
  return {
    version: 1,
    activeId: id,
    profiles: [...library.profiles, { id, name: trimmed, settings: cloneSettings(settings), level }],
  };
}

export function renameIn(library: ProfileLibrary, id: string, name: string): ProfileLibrary | string {
  const trimmed = name.trim();
  if (!trimmed) return "Name the profile first.";
  if (!library.profiles.some((profile) => profile.id === id)) return "That profile is no longer saved.";
  if (library.profiles.some((profile) => profile.id !== id && profile.name === trimmed)) return `A profile named ${trimmed} already exists.`;
  return {
    ...library,
    profiles: library.profiles.map((profile) => profile.id === id ? { ...profile, name: trimmed } : profile),
  };
}

export function duplicateIn(library: ProfileLibrary, id: string, newId: string): ProfileLibrary | string {
  const source = library.profiles.find((profile) => profile.id === id);
  if (!source) return "That profile is no longer saved.";
  const name = copyName(library, source.name);
  return {
    version: 1,
    activeId: newId,
    profiles: [...library.profiles, { id: newId, name, settings: cloneSettings(source.settings), level: source.level }],
  };
}

export function deleteIn(library: ProfileLibrary, id: string): ProfileLibrary {
  return {
    version: 1,
    activeId: library.activeId === id ? null : library.activeId,
    profiles: library.profiles.filter((profile) => profile.id !== id),
  };
}

/** Saved presets become profiles at the given level. A name that is already a profile is left alone. */
export function adoptPresets(library: ProfileLibrary, presets: Record<string, PresetSettings>, level: SettingsLevel, newId: () => string): ProfileLibrary {
  const taken = new Set(library.profiles.map((profile) => profile.name));
  const added: NamedSettingsProfile[] = [];
  for (const name of Object.keys(presets).sort()) {
    if (taken.has(name)) continue;
    taken.add(name);
    added.push({ id: newId(), name, settings: cloneSettings(presets[name]!), level });
  }
  if (added.length === 0) return library;
  return { ...library, profiles: [...library.profiles, ...added] };
}

export function importInto(library: ProfileLibrary, file: SettingsProfileFile, id: string): ProfileLibrary {
  return {
    version: 1,
    activeId: id,
    profiles: [...library.profiles, { id, name: uniqueName(library, file.name), settings: cloneSettings(file.settings), level: file.level }],
  };
}

/** The active profile when it still matches, otherwise the first saved match. */
export function displayId(library: ProfileLibrary, settings: PresetSettings, level: SettingsLevel): string {
  const active = library.profiles.find((profile) => profile.id === library.activeId);
  if (active && sameContent(active, settings, level)) return active.id;
  return library.profiles.find((profile) => sameContent(profile, settings, level))?.id ?? "";
}

function sameContent(profile: NamedSettingsProfile, settings: PresetSettings, level: SettingsLevel): boolean {
  return profile.level === level && JSON.stringify(profile.settings) === JSON.stringify(settings);
}

function cloneSettings(settings: PresetSettings): PresetSettings {
  return { ...settings };
}

function copyName(library: ProfileLibrary, name: string): string {
  return uniqueName(library, `${name} copy`);
}

function uniqueName(library: ProfileLibrary, name: string): string {
  const taken = new Set(library.profiles.map((profile) => profile.name));
  if (!taken.has(name)) return name;
  let n = 2;
  while (taken.has(`${name} ${n}`)) n += 1;
  return `${name} ${n}`;
}

function applyProfileMigrations(
  doc: Record<string, unknown>,
  steps: readonly ProfileMigration[],
  target: number,
): { ok: true; doc: Record<string, unknown> } | { ok: false; message: string } {
  if (typeof doc.version !== "number" || !Number.isInteger(doc.version)) {
    return { ok: false, message: "This settings profile has no version, so it cannot be opened." };
  }
  let current = doc;
  let version = doc.version;
  if (version > target) {
    return { ok: false, message: `This settings profile is version ${version}. This app opens up to version ${target}.` };
  }
  while (version < target) {
    const step = steps[version];
    if (!step) return { ok: false, message: "This settings profile could not be updated to the current format." };
    let next: Record<string, unknown>;
    try {
      next = step({ ...current });
    } catch {
      return { ok: false, message: "This settings profile could not be updated to the current format." };
    }
    if (!next || typeof next.version !== "number" || next.version !== version + 1) {
      return { ok: false, message: "This settings profile could not be updated to the current format." };
    }
    current = next;
    version = next.version;
  }
  return { ok: true, doc: current };
}

function readFile(doc: Record<string, unknown>): ProfileFileResult {
  if (doc.version !== SETTINGS_PROFILE_VERSION) return { ok: false, message: "This settings profile could not be updated to the current format." };
  if (typeof doc.name !== "string" || !doc.name.trim()) return { ok: false, message: "This settings profile is incomplete." };
  const settings = readPreset(doc.settings);
  if (typeof settings === "string") return { ok: false, message: settings };
  if (!isLevel(doc.level)) return { ok: false, message: "This settings profile is incomplete." };
  return { ok: true, profile: { version: 1, name: doc.name.trim(), settings, level: doc.level } };
}

function readNamed(value: unknown): NamedSettingsProfile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !row.id || typeof row.name !== "string" || !row.name.trim()) return null;
  const settings = readPreset(row.settings);
  if (typeof settings === "string" || !isLevel(row.level)) return null;
  return { id: row.id, name: row.name.trim(), settings, level: row.level };
}

function readPreset(value: unknown): PresetSettings | string {
  return readPresetSettings(value) ?? "This settings profile is incomplete.";
}

function isLevel(value: unknown): value is SettingsLevel {
  return value === "simple" || value === "advanced" || value === "expert";
}
