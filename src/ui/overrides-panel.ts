import { Plus, X, createElement } from "lucide";
import type { HeightRange, ModifierVolume, OverrideDocument, SettingOverride } from "../overrides.ts";

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] ?? ch));
}

/** Ids of the ranges and volumes whose fields are open. A render keeps them; the toggle handler updates them. */
const openItems = new Set<string>();

export function setModifierOpen(id: string, open: boolean) {
  if (open) openItems.add(id);
  else openItems.delete(id);
}

function num(field: string, label: string, value: string, min: number, max: number, step: number, span: 2 | 3): string {
  return `<label class="setting span${span}" data-label="${esc(label.toLowerCase())}">${esc(label)}<input data-field="${field}" type="number" min="${min}" max="${max}" step="${step}" value="${esc(value)}" aria-label="${esc(label)}" /></label>`;
}

function optional(value: number | undefined, digits = 0): string {
  if (value === undefined) return "";
  if (digits === 0) return String(value);
  return String(Math.round(value * 10 ** digits) / 10 ** digits);
}

export const OVERRIDES_TIP = "Infill, walls, and a speed cap apply on a range's layers and inside a volume. A volume wins over a range, and a later entry wins over an earlier one. Supports stay as set. Layer height stays the one slice setting. A range cannot change it. Move and scale use the gizmo on the shape. Shift snaps 1 mm.";

const mm = (value: number) => String(Number(value.toFixed(2)));

/** `40% · 4 walls · 40 mm/s`: only what the item sets. */
export function overrideSummary(override: SettingOverride): string {
  const bits: string[] = [];
  if (override.infill !== undefined) bits.push(`${Math.round(override.infill * 100)}%`);
  if (override.walls !== undefined) bits.push(`${override.walls} walls`);
  if (override.speed !== undefined) bits.push(`${override.speed} mm/s`);
  return bits.join(" · ") || "no changes";
}

function overrideFields(override: SettingOverride): string {
  return `
      ${num("infill", "Infill %", optional(override.infill === undefined ? undefined : override.infill * 100), 0, 100, 1, 2)}
      ${num("walls", "Walls", optional(override.walls), 1, 12, 1, 2)}
      ${num("speed", "Speed mm/s", optional(override.speed), 1, 1000, 1, 2)}`;
}

function removeButton(kind: "range" | "volume", label: string): string {
  const cross = createElement(X, { width: 12, height: 12, "aria-hidden": "true", class: "ico" }).outerHTML;
  return `<button class="mod-remove" type="button" data-override-remove="${kind}" aria-label="Remove ${label}" data-tip="Remove ${label}">${cross}</button>`;
}

function rangeItem(range: HeightRange): string {
  const label = `Z ${mm(range.zFrom)}–${mm(range.zTo)} mm`;
  return `
    <details class="mod-item" data-override-card data-range="${esc(range.id)}" data-mod="${esc(range.id)}"${openItems.has(range.id) ? " open" : ""}>
      <summary><span class="mod-name">${label}</span><span class="mod-val">${overrideSummary(range.override)}</span>${removeButton("range", "height range")}</summary>
      <div class="mod-fields">
        ${num("zFrom", "From Z mm", String(range.zFrom), 0, 1000, 0.1, 3)}
        ${num("zTo", "To Z mm", String(range.zTo), 0, 1000, 0.1, 3)}
        ${overrideFields(range.override)}
      </div>
    </details>`;
}

function volumeItem(volume: ModifierVolume, selectedId: string | null): string {
  const selected = volume.id === selectedId;
  const label = volumeLabel(volume.kind);
  return `
    <details class="mod-item${selected ? " is-selected" : ""}" data-override-card data-volume="${esc(volume.id)}" data-mod="${esc(volume.id)}"${openItems.has(volume.id) ? " open" : ""}>
      <summary data-override-select="${esc(volume.id)}" aria-current="${selected ? "true" : "false"}"><span class="mod-name">${label}</span><span class="mod-val">${mm(volume.sx)} × ${mm(volume.sy)} × ${mm(volume.sz)} mm</span>${removeButton("volume", label.toLowerCase())}</summary>
      <div class="mod-fields">
        ${num("x", "X mm", String(volume.x), -500, 1500, 0.1, 2)}
        ${num("y", "Y mm", String(volume.y), -500, 1500, 0.1, 2)}
        ${num("z", "Z mm", String(volume.z), -500, 1500, 0.1, 2)}
        ${num("sx", "Size X mm", String(volume.sx), 0.2, 1000, 0.1, 2)}
        ${num("sy", "Size Y mm", String(volume.sy), 0.2, 1000, 0.1, 2)}
        ${num("sz", "Size Z mm", String(volume.sz), 0.2, 1000, 0.1, 2)}
        ${overrideFields(volume.override)}
      </div>
    </details>`;
}

function addButton(id: string, label: string, tip: string): string {
  const plus = createElement(Plus, { width: 12, height: 12, "aria-hidden": "true", class: "ico" }).outerHTML;
  return `<button class="btn mini" id="${id}" type="button" data-tip="${esc(tip)}">${plus}${esc(label)}</button>`;
}

/** Two add rows, each item a closed row until opened, and the move/scale switch while a volume is selected. */
export function overrideSectionHtml(doc: OverrideDocument, selectedId: string | null, tool: "move" | "scale"): string {
  const selected = doc.volumes.some((volume) => volume.id === selectedId);
  return `
    <div class="mod-row"><span class="mod-label">Height ranges</span>${addButton("heightAdd", "Add", "Add a height range")}</div>
    ${doc.ranges.map(rangeItem).join("")}
    <div class="mod-row"><span class="mod-label">Volumes</span><span class="mod-adds">${addButton("volumeBox", "Box", "Add a box volume")}${addButton("volumeCylinder", "Cylinder", "Add a cylinder volume")}${addButton("volumeSphere", "Sphere", "Add a sphere volume")}</span></div>
    ${doc.volumes.map((volume) => volumeItem(volume, selectedId)).join("")}
    ${selected ? `<div class="mod-row"><span class="mod-label">Gizmo</span><span class="modes" role="group" aria-label="Volume gizmo"><button class="btn mode" id="modToolMove" type="button" aria-pressed="${tool === "move" ? "true" : "false"}">Move</button><button class="btn mode" id="modToolScale" type="button" aria-pressed="${tool === "scale" ? "true" : "false"}">Scale</button></span></div>` : ""}`;
}

function volumeLabel(kind: "box" | "cylinder" | "sphere"): string {
  if (kind === "box") return "Box";
  if (kind === "cylinder") return "Cylinder";
  return "Sphere";
}
