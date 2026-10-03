/** Apply, save, and move named settings profiles. Switches are one undo step. */
import { saveText } from "./files.ts";
import { fx } from "./fx.ts";
import { flushEdit, noteEdit } from "./history.ts";
import { loadProfileLibrary, storeProfileLibrary } from "./profile-library.ts";
import { currentPreset, touch } from "./settings.ts";
import { state } from "./state.ts";
import { presetKeys } from "../presets.ts";
import { pushToast } from "../ui/toasts.ts";
import { loadSettingsLevel, setSettingsLevel } from "../ui/settings-panel.ts";
import {
  deleteIn,
  duplicateIn,
  importInto,
  parseSettingsProfile,
  profileFileName,
  renameIn,
  saveInto,
  serializeSettingsProfile,
  type SettingsProfileFile,
} from "../ui/settings-profiles.ts";

export function newProfileId(): string {
  return crypto.randomUUID();
}

export function saveSettingsProfile(name: string): boolean {
  const next = saveInto(loadProfileLibrary(), name, currentPreset(), loadSettingsLevel(), newProfileId());
  if (typeof next === "string") {
    pushToast(next, "info");
    return false;
  }
  storeProfileLibrary(next);
  touch();
  pushToast(`Saved ${name.trim()}.`, "success");
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
  pushToast(`Renamed to ${name.trim()}.`, "success");
  return true;
}

export function duplicateSettingsProfile(id: string): boolean {
  const next = duplicateIn(loadProfileLibrary(), id, newProfileId());
  if (typeof next === "string") {
    pushToast(next, "info");
    return false;
  }
  storeProfileLibrary(next);
  const copy = next.profiles.find((entry) => entry.id === next.activeId);
  touch();
  pushToast(`Duplicated as ${copy?.name ?? "a copy"}.`, "success");
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
  pushToast(`Deleted ${profile.name}.`, "success");
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
  pushToast(`Imported ${parsed.profile.name}.`, "success");
}

export function openProfileFile() {
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

export function askProfileName(fallback: string): string | null {
  const typed = typedProfileName();
  if (typed) return typed;
  const asked = window.prompt("Profile name", fallback);
  const name = asked?.trim() ?? "";
  return name || null;
}
