import { changedPresetKeys, type PresetSettings } from "../presets";
import { CONTROLS } from "./settings-schema";
import "./shell.css";
import "./groups.css";

export type { SettingsLevel } from "./first-run";
import { LEVEL_KEY, levelFromStored, type SettingsLevel } from "./first-run";
import { prefs } from "../prefs.ts";

const CLOSED_KEY = "lime-slice-closed-groups";

/** The saved level, or null on a first run. */
export function storedSettingsLevel(): string | null {
  try {
    return prefs.get(LEVEL_KEY);
  } catch {
    return null;
  }
}

/** The saved level; a first run (nothing saved) starts at Simple. */
export function loadSettingsLevel(): SettingsLevel {
  return levelFromStored(storedSettingsLevel());
}

export function applyStoredLevel() {
  document.documentElement.dataset.settingsLevel = loadSettingsLevel();
}

export function setSettingsLevel(level: SettingsLevel) {
  prefs.set(LEVEL_KEY, level);
  document.documentElement.dataset.settingsLevel = level;
  const pick = document.querySelector<HTMLSelectElement>("#levelPick");
  if (pick && pick.value !== level) pick.value = level;
}

export function levelSelectHtml() {
  const level = loadSettingsLevel();
  const option = (id: SettingsLevel, label: string) => `<option value="${id}"${level === id ? " selected" : ""}>${label}</option>`;
  return `<select id="levelPick" class="level-pick" aria-label="Settings level" data-tip="Which settings the panel shows">${option("simple", "Simple")}${option("advanced", "Advanced")}${option("expert", "Expert")}</select>`;
}

/** The groups the user closed, or `defaults` until a toggle was stored. */
export function loadClosedGroups(defaults: string[]): Set<string> {
  try {
    const raw = prefs.get(CLOSED_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return new Set(parsed.filter((id): id is string => typeof id === "string"));
    }
  } catch {
    // An unreadable entry reads as the defaults.
  }
  return new Set(defaults);
}

export function saveClosedGroups(closed: ReadonlySet<string>) {
  prefs.setJson(CLOSED_KEY, [...closed]);
}

export function mountSettingsPanel() {
  applyStoredLevel();
}

/** Dots for values that differ from the factory preset. Same comparison as a profile's diff. */
export function paintSettingMarks(current: PresetSettings) {
  const changed = new Set(changedPresetKeys(current));
  for (const spec of CONTROLS) {
    if (!spec.preset) continue;
    const input = document.getElementById(spec.id);
    const row = input?.closest<HTMLElement>("label, .setting");
    row?.classList.toggle("is-modified", changed.has(spec.preset));
  }
}
