import { changedPresetKeys, type PresetSettings } from "../presets";
import { CONTROLS } from "./settings-schema";
import "./shell.css";
import "./groups.css";

export type SettingsLevel = "simple" | "advanced" | "expert";

const LEVEL_KEY = "lime-slice-settings-level";
const CLOSED_KEY = "lime-slice-closed-groups";

export function loadSettingsLevel(): SettingsLevel {
  const raw = localStorage.getItem(LEVEL_KEY);
  if (raw === "simple" || raw === "advanced" || raw === "expert") return raw;
  return "expert";
}

export function applyStoredLevel() {
  document.documentElement.dataset.settingsLevel = loadSettingsLevel();
}

export function setSettingsLevel(level: SettingsLevel) {
  localStorage.setItem(LEVEL_KEY, level);
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
    const raw = localStorage.getItem(CLOSED_KEY);
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
  localStorage.setItem(CLOSED_KEY, JSON.stringify([...closed]));
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
