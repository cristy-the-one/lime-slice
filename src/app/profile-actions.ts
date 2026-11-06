/** Apply, save, and move named settings profiles. Switches are one undo step. */
import { saveText } from "./files.ts";
import { fx } from "./fx.ts";
import { flushEdit, noteEdit } from "./history.ts";
import { loadProfileLibrary, storeProfileLibrary } from "./profile-library.ts";
import { currentPreset, touch } from "./settings.ts";
import { state } from "./state.ts";
import { LEGACY_PRESETS_KEY, parseLegacyPresets, presetKeys } from "../presets.ts";
import { pushToast } from "../ui/toasts.ts";
import { askSheet } from "../ui/ask-sheet.ts";
import { loadSettingsLevel, setSettingsLevel } from "../ui/settings-panel.ts";
import {
  adoptPresets,
  deleteIn,
  duplicateIn,
  importInto,
  parseSettingsProfile,
  profileNameProblem,
  profileFileName,
  renameIn,
  saveInto,
  serializeSettingsProfile,
  type SettingsProfileFile,
} from "../ui/settings-profiles.ts";
import { prefs } from "../prefs.ts";

export function newProfileId(): string {
  return crypto.randomUUID();
}

/** Presets saved before settings profiles become profiles once, then their store is dropped. */
export function migrateLegacyPresets() {
  const text = prefs.get(LEGACY_PRESETS_KEY);
  if (text === null) return;
  const presets = parseLegacyPresets(text);
  if (Object.keys(presets).length > 0) storeProfileLibrary(adoptPresets(loadProfileLibrary(), presets, loadSettingsLevel(), newProfileId));
  prefs.remove(LEGACY_PRESETS_KEY);
}

export function saveSettingsProfile(name: string): boolean {
  const next = saveInto(loadProfileLibrary(), name, currentPreset(), loadSettingsLevel(), newProfileId());
  if (typeof next === "string") {
    pushToast(next, "info");
    return false;
  }
  storeProfileLibrary(next);
  touch();
  return true;
}

export function overwriteSettingsProfile(id: string): boolean {
  const profile = loadProfileLibrary().profiles.find((entry) => entry.id === id);
  if (!profile) {
    pushToast("Choose a profile first.", "info");
    return false;
  }
  return saveSettingsProfile(profile.name);
}

export function renameSettingsProfile(id: string, name: string): boolean {
  const next = renameIn(loadProfileLibrary(), id, name);
  if (typeof next === "string") {
    pushToast(next, "info");
    return false;
  }
  storeProfileLibrary(next);
  touch();
  return true;
}

export function duplicateSettingsProfile(id: string): boolean {
  const next = duplicateIn(loadProfileLibrary(), id, newProfileId(), typedProfileName());
  if (typeof next === "string") {
    pushToast(next, "info");
    return false;
  }
  storeProfileLibrary(next);
  touch();
  return true;
}

export function deleteSettingsProfile(id: string): boolean {
  const library = loadProfileLibrary();
  const profile = library.profiles.find((entry) => entry.id === id);
  if (!profile) {
    pushToast("Choose a profile first.", "info");
    return false;
  }
  storeProfileLibrary(deleteIn(library, id));
  touch();
  return true;
}

/** Close any open settings gesture, then record the switch as its own step. */
export function applyNamedProfile(id: string) {
  const profile = loadProfileLibrary().profiles.find((entry) => entry.id === id);
  if (!profile) return;
  flushEdit();
  noteEdit();
  for (const key of presetKeys()) {
    (state as unknown as Record<string, unknown>)[key] = profile.settings[key];
  }
  state.splitCustom = true;
  if (state.blendKind === "byRegion") fx.realignSplit?.("open");
  setSettingsLevel(profile.level);
  const library = loadProfileLibrary();
  storeProfileLibrary({ ...library, activeId: id });
  flushEdit();
  touch();
}

export function exportSettingsProfile(id: string) {
  const profile = id ? loadProfileLibrary().profiles.find((entry) => entry.id === id) : undefined;
  const file: SettingsProfileFile = profile
    ? { version: 1, name: profile.name, settings: profile.settings, level: profile.level }
    : { version: 1, name: "settings", settings: currentPreset(), level: loadSettingsLevel() };
  void saveText(serializeSettingsProfile(file), profileFileName(file.name), "json");
}

export async function importSettingsProfileFile(file: File) {
  const parsed = parseSettingsProfile(await file.text());
  if (!parsed.ok) {
    pushToast(parsed.message, "error", { label: "Retry", run: openProfileFile });
    return;
  }
  const id = newProfileId();
  storeProfileLibrary(importInto(loadProfileLibrary(), parsed.profile, id));
  applyNamedProfile(id);
}

export function openProfileFile() {
  const details = document.querySelector<HTMLDetailsElement>(".profile-more");
  if (details) details.open = true;
  document.querySelector<HTMLInputElement>("#profileFile")?.click();
}

export function openProfileMore() {
  const details = document.querySelector<HTMLDetailsElement>(".profile-more");
  if (details) details.open = true;
  document.querySelector<HTMLInputElement>("#profileName")?.focus();
}

export function selectedProfileId(): string {
  return document.querySelector<HTMLSelectElement>("#profilePick")?.value ?? "";
}

export function typedProfileName(): string {
  return document.querySelector<HTMLInputElement>("#profileName")?.value.trim() ?? "";
}

/**
 * The name typed in the More row, else one asked in the app's sheet, checked as the person types; null when they
 * cancel. `renaming` is the id of the profile being renamed, so the sheet refuses another profile's name.
 */
export async function askProfileName(fallback: string, renaming?: string): Promise<string | null> {
  const typed = typedProfileName();
  if (typed) return typed;
  const library = loadProfileLibrary();
  const name = await askSheet({
    title: renaming === undefined ? "Save settings profile" : "Rename settings profile",
    body: renaming === undefined ? "A name for these slicing settings. A profile with the same name is replaced." : undefined,
    confirmLabel: renaming === undefined ? "Save" : "Rename",
    input: { label: "Profile name", value: fallback, placeholder: "Profile name", maxLength: 80, problem: (value) => profileNameProblem(library, value, renaming) },
  });
  return name || null;
}
