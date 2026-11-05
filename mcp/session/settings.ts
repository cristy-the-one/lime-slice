/**
 * Slice settings and per-region overrides: settings tools, height ranges, modifiers, overrides, and layer actions.
 * The methods run with this: Session; session.ts installs them on the Session prototype.
 */
import { readFileSync } from "node:fs";
import { page } from "../../src/modeling/model-calls.ts";
import { DEFAULT_PRESET, presetKeys, type PresetSettings } from "../../src/presets.ts";
import { addRange, addVolume, freshOverrideId, removeRange, removeVolume, type SettingOverride } from "../../src/overrides.ts";
import type { PlateObjectSettings } from "../../src/plate.ts";
import { parseSettingsProfile } from "../../src/ui/settings-profiles.ts";
import { applyPreset } from "../request.ts";
import { reviewGcode } from "../review.ts";
import { applyObjectSetting, applySetting, inactiveWarning, isObjectKey, settingRows, type ObjectSettingKey } from "../settings-rows.ts";
import { settingsRangeError } from "../settings-check.ts";
import { readVec3 } from "../../src/modeling/compose.ts";
import { resolveRead } from "../workspace.ts";
import { type ToolHandler, UNKNOWN_OBJECT } from "./shared.ts";
import type { Session } from "../session.ts";

function overrideOf(this: Session, input: Record<string, unknown>): SettingOverride | { reason: string } {
  const override: SettingOverride = {};
  if (typeof input.infillPercent === "number") {
    if (input.infillPercent < 0 || input.infillPercent > 100) return { reason: "Infill must be from 0–100%." };
    override.infill = input.infillPercent / 100;
  }
  if (typeof input.walls === "number") {
    if (!Number.isInteger(input.walls) || input.walls < 1 || input.walls > 12) return { reason: "Walls must be from 1–12." };
    override.walls = input.walls;
  }
  if (typeof input.speedMmS === "number") {
    if (!(input.speedMmS > 0) || input.speedMmS > 1000) return { reason: "Speed must be from 0–1000 mm/s." };
    override.speed = input.speedMmS;
  }
  if (override.infill === undefined && override.walls === undefined && override.speed === undefined) {
    return { reason: "Set an infill, a wall count, or a speed." };
  }
  return override;
}

function partSpan(this: Session): { min: number; max: number } | null {
  const obj = this.selectedObject();
  if (!obj) return null;
  const bounds = this.placed(obj).bounds;
  return { min: bounds.min[2], max: bounds.max[2] };
}

function rangeAdd(this: Session, input: Record<string, unknown>): Record<string, unknown> {
  const span = this.partSpan();
  if (!span) return { ok: false, reason: "Load a mesh first." };
  const zFrom = Number(input.zFromMm);
  const zTo = Number(input.zToMm);
  if (zTo < span.min - 1e-6 || zFrom > span.max + 1e-6) {
    return { ok: false, reason: `That range is outside the part. It stands from ${span.min} to ${span.max} mm.` };
  }
  const override = this.overrideOf(input);
  if ("reason" in override) return { ok: false, reason: override.reason };
  const id = freshOverrideId("range");
  if (input.dryRun === true) return { ok: true, dryRun: true, id, zFrom, zTo, override };
  this.remember("Height range");
  this.overrides = addRange(this.overrides, { id, zFrom, zTo, override });
  return { ok: true, id, stale: true, label: "Height range" };
}

function modifierAdd(this: Session, input: Record<string, unknown>): Record<string, unknown> {
  const obj = this.selectedObject();
  if (!obj) return { ok: false, reason: "Load a mesh first." };
  const kind = input.kind === "cylinder" || input.kind === "sphere" ? input.kind : input.kind === "box" ? "box" : null;
  if (!kind) return { ok: false, reason: "kind is box, cylinder, or sphere." };
  const centre = readVec3(input.centre, [Number.NaN, Number.NaN, Number.NaN]);
  const size = readVec3(input.sizeMm, [Number.NaN, Number.NaN, Number.NaN]);
  if (centre.some((value) => !Number.isFinite(value)) || size.some((value) => !(value > 0))) {
    return { ok: false, reason: "The volume needs a centre and a size, in millimetres." };
  }
  const part = this.placed(obj).bounds;
  const volume = { min: [centre[0] - size[0] / 2, centre[1] - size[1] / 2, centre[2] - size[2] / 2], max: [centre[0] + size[0] / 2, centre[1] + size[1] / 2, centre[2] + size[2] / 2] };
  const touches = volume.min.every((value, axis) => value <= part.max[axis] && volume.max[axis] >= part.min[axis]);
  if (!touches) return { ok: false, reason: "That volume does not touch the part." };
  const override = this.overrideOf(input);
  if ("reason" in override) return { ok: false, reason: override.reason };
  const id = freshOverrideId("volume");
  if (input.dryRun === true) return { ok: true, dryRun: true, id };
  this.remember("Modifier");
  this.overrides = addVolume(this.overrides, { id, kind, x: centre[0], y: centre[1], z: centre[2], sx: size[0], sy: size[1], sz: size[2], override });
  return { ok: true, id, stale: true, label: "Modifier" };
}

function overridesList(this: Session): Record<string, unknown> {
  return { ok: true, ranges: this.overrides.ranges, volumes: this.overrides.volumes };
}

function overrideRemove(this: Session, id: string): Record<string, unknown> {
  const had = this.overrides.ranges.some((row) => row.id === id) || this.overrides.volumes.some((row) => row.id === id);
  if (!had) return { ok: false, reason: "That override is not on the plate." };
  this.remember("Remove override");
  this.overrides = removeVolume(removeRange(this.overrides, id), id);
  return { ok: true, stale: true, label: "Remove override" };
}

function layerActionSet(this: Session, input: Record<string, unknown>): Record<string, unknown> {
  const kind = input.kind === "pause" || input.kind === "filamentChange" || input.kind === "customGcode" ? input.kind : null;
  if (!kind) return { ok: false, reason: "kind is pause, filamentChange, or customGcode." };
  let zMm = Number(input.zMm);
  if (!Number.isFinite(zMm) || zMm < 0) return { ok: false, reason: "zMm is a height in millimetres." };
  const tops = this.latest ? this.summarize(this.latest).layers.map((layer) => layer.z).filter((z) => z + 1e-9 >= zMm) : [];
  if (this.latest && tops.length === 0) return { ok: false, reason: `That is above the sliced part. The top is ${this.summarize(this.latest).layers.at(-1)?.z ?? 0} mm.` };
  if (tops.length) zMm = tops.reduce((m, z) => Math.min(m, z));
  const gcode = typeof input.gcode === "string" ? input.gcode : "";
  if (kind === "customGcode") {
    if (gcode.trim() === "") return { ok: false, reason: "A custom line needs gcode." };
    if (new TextEncoder().encode(gcode).byteLength > 400) return { ok: false, reason: "A custom line is at most 400 bytes." };
  }
  const review = kind === "customGcode" ? reviewGcode(gcode, { custom: [gcode] }).review.map((line) => line.text) : [];
  if (input.dryRun === true) return { ok: true, dryRun: true, zMm, kind, ...(review.length ? { review } : {}) };
  this.remember("Layer action");
  this.actions = this.actions.filter((action) => Math.abs(action.zMm - zMm) > 1e-6);
  this.actions.push({ zMm, kind, ...(typeof input.note === "string" && input.note ? { note: input.note.slice(0, 80) } : {}), ...(kind === "customGcode" ? { gcode: gcode.trim() } : {}) });
  return { ok: true, zMm, stale: true, ...(review.length ? { review } : {}), label: "Layer action" };
}

function layerActionsList(this: Session): Record<string, unknown> {
  return { ok: true, actions: this.actions.map((action) => ({ ...action })) };
}

function layerActionRemove(this: Session, zMm: number): Record<string, unknown> {
  const next = this.actions.filter((action) => Math.abs(action.zMm - zMm) > 1e-6);
  if (next.length === this.actions.length) return { ok: false, reason: "There is no action at that height." };
  this.remember("Remove layer action");
  this.actions = next;
  return { ok: true, stale: true, label: "Remove layer action" };
}

function settingsApply(this: Session, input: Record<string, unknown>): Record<string, unknown> {
  let next = this.settings;
  if (typeof input.path === "string") {
    const parsed = parseSettingsProfile(readFileSync(resolveRead(input.path, "profile"), "utf8"));
    if (!parsed.ok) return { ok: false, reason: parsed.message, changed: [] };
    next = { ...parsed.profile.settings };
  }
  if (typeof input.preset === "string") next = applyPreset(next, input.preset);
  if (typeof input.layerHeight === "number") next = { ...next, layerHeight: input.layerHeight };
  if (typeof input.supports === "boolean") next = { ...next, supports: input.supports };
  const range = settingsRangeError(next, { belt: this.printer().kind === "belt", lineWidth: Math.min(1.2, Math.max(0.2, this.library.nozzleMm * 1.125)) });
  if (range) return { ok: false, reason: range, changed: [] };
  this.remember("Settings");
  this.settings = next;
  const changed = presetKeys().filter((key) => this.settings[key] !== DEFAULT_PRESET[key]);
  return { ok: true, changed, label: "Settings" };
}

function schemaContext(this: Session) {
  return { belt: this.printer().kind === "belt", lineWidth: Math.min(1.2, Math.max(0.2, this.library.nozzleMm * 1.125)) };
}

function settingsSchema(this: Session, input: Record<string, unknown>): Record<string, unknown> {
  const level = input.level === "simple" || input.level === "advanced" || input.level === "expert" ? input.level : undefined;
  const rows = settingRows({
    settings: this.settings,
    ctx: this.schemaContext(),
    query: typeof input.query === "string" ? input.query : undefined,
    level,
    all: input.all === true,
  });
  const listed = page(rows, input.cursor, input.limit);
  return { ok: true, rows: listed.rows, ...(listed.nextCursor ? { nextCursor: listed.nextCursor } : {}) };
}

function settingsSet(this: Session, input: Record<string, unknown>): Record<string, unknown> {
  const values = input.values;
  if (!values || typeof values !== "object" || Array.isArray(values)) return { ok: false, reason: "values must be an object of setting keys." };
  const objectId = typeof input.object === "string" ? input.object : "";
  const obj = objectId ? this.find(objectId) : null;
  if (objectId && !obj) return { ok: false, reason: UNKNOWN_OBJECT, next: "Call plate_list for the current handles." };
  const dryRun = input.dryRun === true;
  const changed: { key: string; from: unknown; to: unknown }[] = [];
  const refused: { key: string; reason: string }[] = [];
  let next = this.settings;
  const objectNext: PlateObjectSettings = obj ? { ...obj.objectSettings } : {};
  for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
    if (obj) {
      if (!isObjectKey(key)) {
        refused.push({ key, reason: "This setting is plate-wide." });
        continue;
      }
      const applied = applyObjectSetting(next, key, value, this.schemaContext());
      if ("reason" in applied) {
        refused.push({ key, reason: applied.reason });
        continue;
      }
      (objectNext as Record<ObjectSettingKey, unknown>)[key] = applied.value;
      changed.push({ key, from: obj.objectSettings[key], to: applied.value });
      continue;
    }
    const applied = applySetting(next, key, value, this.schemaContext());
    if ("reason" in applied) {
      refused.push({ key, reason: applied.reason });
      continue;
    }
    const to = applied.settings[key as keyof PresetSettings];
    next = applied.settings;
    changed.push({ key, from: this.settings[key as keyof PresetSettings], to });
  }
  const warnings = changed.flatMap((row) => {
    const note = inactiveWarning(obj ? this.settings : next, row.key);
    return note ? [note] : [];
  });
  if (changed.length === 0) return { ok: false, reason: refused[0]?.reason ?? "Nothing to change.", refused, ...(warnings.length ? { warnings } : {}) };
  if (!dryRun) {
    this.remember(obj ? "Object settings" : "Settings");
    if (obj) obj.objectSettings = { ...obj.objectSettings, ...objectNext };
    else this.settings = next;
  }
  return {
    ok: true,
    changed,
    ...(refused.length ? { refused } : {}),
    ...(warnings.length ? { warnings } : {}),
    ...(dryRun ? { dryRun: true } : { stale: true }),
    label: obj ? "Object settings" : "Settings",
  };
}

/** The methods this module adds to Session. */
export const settingsMethods = {
  overrideOf,
  partSpan,
  rangeAdd,
  modifierAdd,
  overridesList,
  overrideRemove,
  layerActionSet,
  layerActionsList,
  layerActionRemove,
  settingsApply,
  schemaContext,
  settingsSchema,
  settingsSet,
};

export const settingsHandlers: Record<string, ToolHandler> = {
  settings_apply: (s, input) => s.settingsApply(input),
  settings_schema: (s, input) => s.settingsSchema(input),
  settings_set: (s, input) => s.settingsSet(input),
  range_add: (s, input) => s.rangeAdd(input),
  modifier_add: (s, input) => s.modifierAdd(input),
  overrides_list: (s) => s.overridesList(),
  override_remove: (s, input) => s.overrideRemove(String(input.id)),
  layer_action_set: (s, input) => s.layerActionSet(input),
  layer_actions_list: (s) => s.layerActionsList(),
  layer_action_remove: (s, input) => s.layerActionRemove(Number(input.zMm)),
};
