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
  options?: string[];
  default: unknown;
  value: unknown;
  level: string;
  dependsOn?: string;
  help?: string;
}

function unitOf(label: string): string {
  if (/mm\/s²/i.test(label)) return "mm/s²";
  if (/mm\/s/i.test(label)) return "mm/s";
  if (/%/.test(label)) return "%";
  if (/\bmm\b/i.test(label)) return "mm";
  if (/°/.test(label)) return "deg";
  return "";
}

function nameOf(label: string): string {
  return label.replace(/\s*mm\/s²$/i, "").replace(/\s*mm\/s$/i, "").replace(/\s*mm$/i, "").replace(/\s*%$/i, "").replace(/\s*°$/i, "").trim();
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

/** The values a select or segmented control takes. */
function choices(kind: ControlSpec["kind"], ctx: SchemaContext): string[] {
  if (kind.type !== "select" && kind.type !== "segmented") return [];
  const options = typeof kind.options === "function" ? kind.options(ctx) : kind.options;
  return options.map(([value]) => value);
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
  const options = choices(control.kind, ctx);
  const parent = control.parent ? BY_ID.get(control.parent) : undefined;
  return {
    key: control.preset,
    label: nameOf(control.label),
    unit: unitOf(control.label),
    type: control.kind.type,
    ...(limits ? { min: limits.min, max: limits.max, step: limits.step } : {}),
    ...(options.length ? { options } : {}),
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

/** One per-object key: the panel row with the value this object slices with, whether the object sets it, and the plate's value. */
export interface ObjectSettingRow extends SettingRow {
  /** True when this object sets the key itself; false when it follows the plate. */
  own: boolean;
  /** What the plate gives an object that does not set it. null for infill, walls and speed: the strategy decides. */
  plate: unknown;
}

const STRATEGY_ROWS: Record<"infill" | "walls" | "speed", { label: string; unit: string; min: number; max: number; step: number; help: string }> = {
  infill: { label: "Infill", unit: "fraction", min: 0, max: 1, step: 0.01, help: "Sparse infill of this object, a fraction from 0 to 1 (0.2 is 20 %). null follows the strategy. A height range or a modifier wins where it reaches." },
  walls: { label: "Walls", unit: "", min: 1, max: 12, step: 1, help: "Wall count of this object. null follows the strategy. A height range or a modifier wins where it reaches." },
  speed: { label: "Speed cap", unit: "mm/s", min: 1, max: 1000, step: 1, help: "Speed cap of this object, mm/s. null follows the strategy. A height range or a modifier wins where it reaches." },
};

/**
 * The keys settings_set {object} takes, with this object's values. A key the object does not set shows the plate's
 * value with own false. Supports is the panel's choice (off, auto, paint), read from the object's supports and source.
 */
export function objectSettingRows(own: Partial<Record<ObjectSettingKey, unknown>>, plate: PresetSettings, ctx: SchemaContext): ObjectSettingRow[] {
  const merged = { ...plate } as PresetSettings;
  for (const key of OBJECT_KEYS) {
    if (key in STRATEGY_ROWS || own[key] === undefined) continue;
    (merged as unknown as Record<string, unknown>)[key] = own[key];
  }
  const rows: ObjectSettingRow[] = [];
  for (const key of OBJECT_KEYS) {
    const isOwn = own[key] !== undefined;
    if (key === "infill" || key === "walls" || key === "speed") {
      const spec = STRATEGY_ROWS[key];
      rows.push({ key, label: spec.label, unit: spec.unit, type: "number", min: spec.min, max: spec.max, step: spec.step, default: null, value: isOwn ? own[key] : null, level: "simple", help: spec.help, own: isOwn, plate: null });
      continue;
    }
    if (key === "supportSource") {
      rows.push({ key, label: "Support source", unit: "", type: "select", options: ["auto", "paint"], default: DEFAULT_PRESET.supportSource, value: merged.supportSource, level: "advanced", dependsOn: "supports", help: "auto: supports wherever the part needs them; paint: only where Enforce paint asks. settings_set supports sets it too.", own: isOwn, plate: plate.supportSource });
      continue;
    }
    const control = BY_KEY.get(key);
    const row = control ? settingRow(control, merged, ctx) : null;
    if (!row || !control) continue;
    const plateValue = shown(control, plate);
    rows.push({ ...row, own: isOwn, plate: plateValue });
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
  if (control.kind.type === "select" || control.kind.type === "segmented") {
    // Supports reads true and false as Automatic and Off, as settings_apply does.
    if (key === "supports" && typeof value === "boolean") value = value ? "auto" : "off";
    const options = choices(control.kind, ctx);
    if (typeof value !== "string" || !options.includes(value)) {
      return { reason: `${nameOf(control.label)} must be one of ${options.map((option) => `"${option}"`).join(", ")}.` };
    }
  }
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

/** Rules that hide a control on a flat printer, so the slice leaves its key out. */
const BELT_ONLY_RULES: ReadonlySet<string> = new Set(["supportStrictStacking", "supportBeltAnchors", "supportBeltHoldThin"]);

/** A belt-only key turned on while the printer is flat: kept, but the slice leaves it out until a belt printer is selected. */
export function beltOnlyWarning(key: string, value: unknown, ctx: SchemaContext): string | null {
  const control = BY_KEY.get(key);
  if (ctx.belt || !control?.rule || !BELT_ONLY_RULES.has(control.rule) || value === false) return null;
  return `${key} applies only on a belt printer. This printer is flat, so the slice leaves it out.`;
}

/**
 * Per-object keys the plate stores beside the preset. Infill stays a fraction from 0 to 1.
 * `supports` is the Supports choice, so it brings `supportSource` with it in `also`: an object set to
 * Automatic stays Automatic on a plate set to Painted only.
 */
export function applyObjectSetting(
  plate: PresetSettings,
  key: ObjectSettingKey,
  value: unknown,
  ctx: SchemaContext,
): { value: unknown; also?: { supportSource: "auto" | "paint" } } | { reason: string } {
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
  if (key === "supportSource") {
    if (value !== "auto" && value !== "paint") return { reason: 'supportSource must be "auto" or "paint".' };
    return { value };
  }
  const applied = applySetting(plate, key, value, ctx);
  if ("reason" in applied) return applied;
  if (key === "supports") return { value: applied.settings.supports, also: { supportSource: applied.settings.supportSource === "paint" ? "paint" : "auto" } };
  return { value: applied.settings[key] };
}
