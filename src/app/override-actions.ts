/** Edits to height ranges and modifier volumes. The slice request carries them (`sliceOverrideFields`). */
import { fx } from "./fx";
import { flushEdit, noteEdit } from "./history";
import { state } from "./state";
import { markProjectDirty } from "../project-dirty";
import { markStale, renderChrome } from "./settings";
import { setModifierOpen } from "../ui/overrides-panel";
import {
  addRange,
  clampWalls,
  addVolume,
  defaultRange,
  defaultVolume,
  moveVolume,
  orderRange,
  removeRange,
  removeVolume,
  replaceRange,
  replaceVolume,
  scaleVolume,
  type AxisName,
  type HeightRange,
  type ModifierVolume,
  type SettingOverride,
  type VolumeKind,
} from "../overrides";

export function addHeightRange() {
  noteEdit();
  const range = defaultRange();
  setModifierOpen(range.id, true);
  state.overrides = addRange(state.overrides, range);
  markProjectDirty();
  flushEdit();
  renderChrome();
}

export function addModifier(kind: VolumeKind) {
  noteEdit();
  const volume = defaultVolume(kind, state.profile.bedX, state.profile.bedY);
  state.overrides = addVolume(state.overrides, volume);
  state.selectedVolumeId = volume.id;
  setModifierOpen(volume.id, true);
  markProjectDirty();
  flushEdit();
  renderChrome();
}

export function removeOverrideCard(card: HTMLElement) {
  const rangeId = card.dataset.range;
  const volumeId = card.dataset.volume;
  noteEdit();
  if (rangeId) state.overrides = removeRange(state.overrides, rangeId);
  if (volumeId) {
    state.overrides = removeVolume(state.overrides, volumeId);
    if (state.selectedVolumeId === volumeId) state.selectedVolumeId = state.overrides.volumes[0]?.id ?? null;
  }
  markProjectDirty();
  flushEdit();
  renderChrome();
}

export function selectModifier(id: string) {
  state.selectedVolumeId = id;
  setModifierOpen(id, true);
  renderChrome();
}

export function setModifierTool(tool: "move" | "scale") {
  state.modifierTool = tool;
  renderChrome();
}

export function beginModifierEdit() {
  noteEdit();
}

export function nudgeModifier(id: string, kind: "move" | "scale", axis: AxisName, deltaMm: number) {
  const volume = state.overrides.volumes.find((item) => item.id === id);
  if (!volume) return;
  const next = kind === "scale" ? scaleVolume(volume, axis, deltaMm) : moveVolume(volume, axis, deltaMm);
  state.overrides = replaceVolume(state.overrides, next);
  markProjectDirty();
  fx.paintSlider?.();
}

export function endModifierEdit() {
  flushEdit();
  renderChrome();
}

export function editOverrideInput(input: HTMLInputElement) {
  const card = input.closest<HTMLElement>("[data-override-card]");
  const field = input.dataset.field;
  if (!card || !field) return;
  noteEdit();
  if (card.dataset.range) {
    const range = state.overrides.ranges.find((item) => item.id === card.dataset.range);
    if (!range) return;
    state.overrides = replaceRange(state.overrides, applyRangeField(range, field, input.value));
  } else if (card.dataset.volume) {
    const volume = state.overrides.volumes.find((item) => item.id === card.dataset.volume);
    if (!volume) return;
    state.overrides = replaceVolume(state.overrides, applyVolumeField(volume, field, input.value));
  }
  markProjectDirty();
  fx.paintSlider?.();
  markStale();
}

export function commitOverrideInput(input: HTMLInputElement) {
  const card = input.closest<HTMLElement>("[data-range]");
  if (!card?.dataset.range) return;
  const range = state.overrides.ranges.find((item) => item.id === card.dataset.range);
  if (!range) return;
  const ordered = orderRange(range);
  if (ordered === range) return;
  noteEdit();
  state.overrides = replaceRange(state.overrides, ordered);
  markProjectDirty();
  flushEdit();
  renderChrome();
}

function applyRangeField(range: HeightRange, field: string, raw: string): HeightRange {
  if (field === "zFrom" || field === "zTo") {
    const value = Number(raw);
    if (!Number.isFinite(value)) return range;
    return { ...range, [field]: value };
  }
  return { ...range, override: applyOverride(range.override, field, raw) };
}

function applyVolumeField(volume: ModifierVolume, field: string, raw: string): ModifierVolume {
  if (field === "x" || field === "y" || field === "z" || field === "sx" || field === "sy" || field === "sz") {
    const value = Number(raw);
    if (!Number.isFinite(value)) return volume;
    const next = { ...volume, [field]: value };
    if (field === "sx" || field === "sy" || field === "sz") next[field] = Math.max(0.2, value);
    return next;
  }
  return { ...volume, override: applyOverride(volume.override, field, raw) };
}

function applyOverride(override: SettingOverride, field: string, raw: string): SettingOverride {
  const next = { ...override };
  const trimmed = raw.trim();
  if (field === "infill") {
    if (!trimmed) delete next.infill;
    else {
      const value = Number(trimmed);
      if (Number.isFinite(value)) next.infill = Math.min(1, Math.max(0, value / 100));
    }
  } else if (field === "walls") {
    if (!trimmed) delete next.walls;
    else {
      const value = Number(trimmed);
      if (Number.isFinite(value)) next.walls = clampWalls(value);
    }
  } else if (field === "speed") {
    if (!trimmed) delete next.speed;
    else {
      const value = Number(trimmed);
      if (Number.isFinite(value) && value > 0) next.speed = Math.min(1000, value);
    }
  }
  return next;
}
