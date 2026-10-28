/**
 * The settings panel's controls, as rows an LLM can read and set.
 * A value is judged in the units the panel shows.
 */
import { DEFAULT_PRESET, type PresetSettings } from "../src/presets.ts";
import { settingMatches } from "../src/ui/settings-search.ts";
import { CONTROLS, shownAtLevel, type ControlSpec, type SchemaContext, type Settings, type Tier } from "../src/ui/settings-schema.ts";
import { settingsRangeError } from "./settings-check.ts";

export const OBJECT_KEYS = [
  "supports",
  "supportAngle",
  "supportStyle",
  "supportSource",
  "infillCombine",
  "variableWidth",
  "scarfSeam",
  "gyroid3d",
  "infill",
  "walls",
  "speed",
] as const;

export type ObjectSettingKey = (typeof OBJECT_KEYS)[number];

const BY_KEY = new Map<string, ControlSpec>();
const BY_ID = new Map<string, ControlSpec>();
for (const control of CONTROLS) {
  if (control.preset) BY_KEY.set(control.preset, control);
  BY_ID.set(control.id, control);
}

export interface SettingRow {
  key: string;
  label: string;
  unit: string;
  type: string;
  min?: number;
  max?: number;
  step?: number;
  default: unknown;
  value: unknown;
  level: string;
  dependsOn?: string;
  help?: string;
}

function unitOf(label: string): string {
  if (/mm\/s/i.test(label)) return "mm/s";
  if (/%/.test(label)) return "%";
  if (/\bmm\b/i.test(label)) return "mm";
  if (/°/.test(label)) return "deg";
  return "";
}

function nameOf(label: string): string {
  return label.replace(/\s*mm\/s$/i, "").replace(/\s*mm$/i, "").replace(/\s*%$/i, "").replace(/\s*°$/i, "").trim();
}

function shown(control: ControlSpec, settings: PresetSettings): unknown {
  if (!control.get) return control.preset ? settings[control.preset] : undefined;
  try {
    const value = control.get(settings as unknown as Settings);
    // An empty box is Auto, and Auto is null on the wire.
    return control.placeholder && value === "" ? null : value;
  } catch {
    return control.preset ? settings[control.preset] : undefined;
  }
}

function span(control: ControlSpec, ctx: SchemaContext): { min: number; max: number; step: number } | null {
  const kind = control.kind;
  if (kind.type !== "number" && kind.type !== "range") return null;
  const max = typeof kind.max === "function" ? kind.max(ctx) : kind.max;
  return { min: kind.min, max, step: kind.step };
}

export function settingRow(control: ControlSpec, settings: PresetSettings, ctx: SchemaContext): SettingRow | null {
  if (!control.preset) return null;
  const limits = span(control, ctx);
  const parent = control.parent ? BY_ID.get(control.parent) : undefined;
  return {
    key: control.preset,
    label: nameOf(control.label),
    unit: unitOf(control.label),
    type: control.kind.type,
    ...(limits ? { min: limits.min, max: limits.max, step: limits.step } : {}),
    default: shown(control, DEFAULT_PRESET),
    value: shown(control, settings),
    level: control.tier,
    ...(parent?.preset ? { dependsOn: parent.preset } : {}),
    ...(control.tip ? { help: control.tip } : {}),
  };
}

export function settingRows(input: {
  settings: PresetSettings;
  ctx: SchemaContext;
  query?: string;
  level?: Tier;
  all?: boolean;
}): SettingRow[] {
  const rows: SettingRow[] = [];
  for (const control of CONTROLS) {
    if (!control.preset) continue;
    if (input.level && !shownAtLevel(control.tier, input.level)) continue;
    if (input.query && !settingMatches(input.query, control.label, control.keywords)) continue;
    const row = settingRow(control, input.settings, input.ctx);
    if (!row) continue;
    if (!input.all && !input.query && row.value === row.default) continue;
    rows.push(row);
  }
  return rows;
}

export function isObjectKey(key: string): key is ObjectSettingKey {
  return (OBJECT_KEYS as readonly string[]).includes(key);
}

/** One key, written onto a copy. The sentence is the panel's when the value is out of range. */
export function applySetting(settings: PresetSettings, key: string, value: unknown, ctx: SchemaContext): { settings: PresetSettings; warning?: string } | { reason: string } {
  const control = BY_KEY.get(key);
  if (!control?.set || !control.preset) return { reason: `There is no setting named ${key}.` };
  if (control.kind.type === "check" && typeof value !== "boolean") return { reason: `${nameOf(control.label)} must be true or false.` };
  const auto = value === null && control.placeholder !== undefined;
  if ((control.kind.type === "number" || control.kind.type === "range") && typeof value !== "number" && !auto) {
    return { reason: `${nameOf(control.label)} must be a number${control.placeholder ? ", or null for Auto" : ""}.` };
  }
  const next = { ...settings };
  try {
    control.set(next as unknown as Settings, auto ? "" : (value as number | boolean | string));
  } catch {
    return { reason: `${nameOf(control.label)} could not be set.` };
  }
  const range = settingsRangeError(next, ctx);
  if (range) return { reason: range };
  return { settings: next };
}

/** A child key whose parent is still off. Checked after the whole batch, so turning the parent on in the same call is quiet. */
export function inactiveWarning(settings: PresetSettings, key: string): string | null {
  const control = BY_KEY.get(key);
  const parent = control?.parent ? BY_ID.get(control.parent) : undefined;
  if (!parent?.preset || !control?.preset) return null;
  const parentValue = settings[parent.preset];
  if (parentValue === false || parentValue === "off") return `${control.preset} has no effect while ${parent.preset} is off.`;
  return null;
}

/** Per-object keys the plate stores beside the preset. Infill stays a fraction from 0 to 1. */
export function applyObjectSetting(
  plate: PresetSettings,
  key: ObjectSettingKey,
  value: unknown,
  ctx: SchemaContext,
): { value: unknown } | { reason: string } {
  if (key === "infill") {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return { reason: "Infill must be from 0–1." };
    return { value };
  }
  if (key === "walls") {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 12) return { reason: "Walls must be from 1–12." };
    return { value };
  }
  if (key === "speed") {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1000) return { reason: "Speed must be from 0–1000 mm/s." };
    return { value };
  }
  const applied = applySetting(plate, key, value, ctx);
  if ("reason" in applied) return applied;
  return { value: applied.settings[key] };
}
