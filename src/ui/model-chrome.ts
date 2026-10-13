/**
 * Model mode's toolbar, the tool that is open, and the ghost that follows its numbers.
 * Apply still lives in `app/model.ts`. This file only decides what is on screen.
 */
import { Box, CircleDot, Download, Scaling, Spline, SquareSplitHorizontal, Triangle, Undo2, createElement, type IconNode } from "lucide";
import type { ModelGhost } from "../model-view";
import { blendNote, probeAllowsApply, toolAvailable, type ProbeView } from "../model-feasibility";
import { formatMm, splitPlaneInside, splitPlaneRange, type AxisExtent } from "../model-plane";
import { lastEdge, modelApplyReady, selectionCountLabel, type ModelPickRef } from "../model-select";
import { scrubIntent, scrubTarget, type ScrubIntent } from "./scrub";
import { fx } from "../app/fx";
import { state } from "../app/state";

export type ModelTool = "boolean" | "split" | "fillet" | "chamfer" | "hole" | "scale";

interface ModelChromeHooks {
  clearSelection(): void;
  /** Z extent of the open solid, in the solid's own frame. */
  solidZ(): AxisExtent | null;
  /** A tool opened, the selection changed, or a number changed. */
  paramsChanged(): void;
}

const TOOLS: { id: ModelTool; icon: IconNode; label: string }[] = [
  { id: "boolean", icon: Box, label: "Boolean" },
  { id: "split", icon: SquareSplitHorizontal, label: "Split" },
  { id: "fillet", icon: Spline, label: "Fillet" },
  { id: "chamfer", icon: Triangle, label: "Chamfer" },
  { id: "hole", icon: CircleDot, label: "Hole" },
  { id: "scale", icon: Scaling, label: "Scale" },
];

let hooks: ModelChromeHooks | null = null;
let tool: ModelTool | null = null;
let picks: ModelPickRef[] = [];
let probe: ProbeView = null;

type Scrub = {
  id: number;
  input: HTMLInputElement;
  startX: number;
  startY: number;
  origin: number;
  step: number;
  shiftStep: number;
  mode: ScrubIntent;
};

let scrub: Scrub | null = null;

function svgIcon(node: IconNode) {
  return createElement(node, { width: 14, height: 14, "aria-hidden": "true", class: "ico" });
}

function iconize(id: string, node: IconNode) {
  const button = document.querySelector<HTMLButtonElement>(id);
  if (!button || button.querySelector(":scope > .ico")) return;
  const label = button.textContent?.trim() ?? "";
  button.replaceChildren(svgIcon(node));
  const text = document.createElement("span");
  text.className = "model-tool-label";
  text.textContent = label;
  button.append(text);
}

export function mountModelChrome(next: ModelChromeHooks) {
  hooks = next;
  for (const entry of TOOLS) iconize(`#modelTool${entry.label}`, entry.icon);
  iconize("#modelStep", Download);
  iconize("#modelUndo", Undo2);

  document.querySelector("#modelBar")?.addEventListener("click", (ev) => {
    const target = ev.target instanceof Element ? ev.target : null;
    const toolButton = target?.closest<HTMLButtonElement>(".model-tool[data-tool]");
    if (toolButton?.dataset.tool) {
      toggleTool(toolButton.dataset.tool as ModelTool);
      return;
    }
    const op = target?.closest<HTMLButtonElement>("#modelFuse, #modelCut, #modelCommon");
    if (op) setBoolOp(op.id);
  });
  document.querySelector("#modelCancel")?.addEventListener("click", () => closeTool());
  document.querySelector("#modelPanel")?.addEventListener("input", () => {
    refreshApply();
    refreshGhost();
    hooks?.paramsChanged();
  });
  document.querySelector("#modelPrim")?.addEventListener("change", () => {
    syncFields();
    refreshGhost();
  });
  bindScrub();
  window.addEventListener("keydown", onEnter, true);
  syncFields();
  refreshTools();
}

/** Esc cancels the open tool first, and clears the selection when no tool is open. */
export function escapeModel() {
  if (tool) {
    closeTool();
    return;
  }
  hooks?.clearSelection();
}

export function closeModelTool() {
  closeTool();
}

export function syncModelChrome(next: readonly ModelPickRef[]) {
  picks = next.map((pick) => ({ kind: pick.kind, index: pick.index }));
  const label = selectionCountLabel(picks);
  const chip = document.querySelector("#modelCount");
  if (chip) {
    chip.textContent = label;
    chip.toggleAttribute("hidden", label.length === 0);
  }
  refreshTools();
  refreshApply();
  refreshNote();
  refreshGhost();
  hooks?.paramsChanged();
}

export function refreshModelGhost() {
  refreshGhost();
}

/** The open solid changed. A split plane goes back to the new middle. */
export function syncModelSolid() {
  if (tool === "split") applySplitDefaults();
  refreshTools();
  refreshApply();
  refreshNote();
}

export function openModelTool(): ModelTool | null {
  return tool;
}

/** The latest fillet or chamfer dry-run. Null clears it. */
export function setModelProbe(next: ProbeView) {
  probe = next;
  refreshApply();
  refreshNote();
}

function toggleTool(next: ModelTool) {
  if (tool === next) {
    closeTool();
    return;
  }
  tool = next;
  const bar = document.querySelector<HTMLElement>("#modelBar");
  if (bar) bar.dataset.tool = next;
  document.querySelectorAll<HTMLButtonElement>(".model-tool[data-tool]").forEach((button) => {
    button.setAttribute("aria-pressed", button.dataset.tool === next ? "true" : "false");
  });
  document.querySelector("#modelPanel")?.toggleAttribute("hidden", false);
  if ((next === "fillet" || next === "chamfer") && document.querySelector("#modelPickEdge")?.getAttribute("aria-pressed") !== "true") {
    document.querySelector<HTMLButtonElement>("#modelPickEdge")?.click();
  }
  if (next === "split") applySplitDefaults();
  syncFields();
  refreshTools();
  refreshApply();
  refreshNote();
  refreshGhost();
  hooks?.paramsChanged();
}

function closeTool() {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.closest("#modelPanel")) active.blur();
  tool = null;
  const bar = document.querySelector<HTMLElement>("#modelBar");
  if (bar) delete bar.dataset.tool;
  document.querySelectorAll<HTMLButtonElement>(".model-tool[data-tool]").forEach((button) => {
    button.setAttribute("aria-pressed", "false");
  });
  document.querySelector("#modelPanel")?.toggleAttribute("hidden", true);
  probe = null;
  refreshNote();
  fx.model?.setGhost(null);
  hooks?.paramsChanged();
}

function setBoolOp(id: string) {
  for (const opId of ["modelFuse", "modelCut", "modelCommon"]) {
    const button = document.querySelector<HTMLButtonElement>(`#${opId}`);
    const on = opId === id;
    button?.setAttribute("aria-pressed", on ? "true" : "false");
    button?.classList.toggle("on", on);
  }
}

function syncFields() {
  const primName = document.querySelector<HTMLSelectElement>("#modelPrim")?.value ?? "box";
  document.querySelectorAll<HTMLElement>("#modelPanel [data-for]").forEach((node) => {
    const forOk = !!tool && (node.dataset.for ?? "").split(" ").includes(tool);
    const primOk = !node.dataset.prim || node.dataset.prim.split(" ").includes(primName);
    node.toggleAttribute("hidden", !(forOk && primOk));
  });
}

function applySplitDefaults() {
  const input = document.querySelector<HTMLInputElement>("#modelPlaneZ");
  const range = splitPlaneRange(hooks?.solidZ() ?? null);
  if (!input) return;
  if (!range) {
    input.removeAttribute("min");
    input.removeAttribute("max");
    return;
  }
  input.min = String(range.min);
  input.max = String(range.max);
  input.value = formatMm(range.mid);
}

function splitLegal() {
  return splitPlaneRange(hooks?.solidZ() ?? null) != null;
}

function refreshTools() {
  document.querySelectorAll<HTMLButtonElement>(".model-tool[data-tool]").forEach((button) => {
    const id = button.dataset.tool ?? "";
    button.disabled = !toolAvailable(id, picks, splitLegal());
  });
}

function refreshApply() {
  const button = document.querySelector<HTMLButtonElement>("#modelApply");
  if (!button) return;
  const range = splitPlaneRange(hooks?.solidZ() ?? null);
  button.disabled = !tool || !modelApplyReady(
    tool,
    picks,
    num("#modelFactor"),
    splitPlaneInside(num("#modelPlaneZ"), range),
    probeAllowsApply(tool, probe),
  );
}

function refreshNote() {
  const note = document.querySelector("#modelNote");
  if (!note) return;
  let text = "";
  let bad = false;
  if (tool === "split") {
    const range = splitPlaneRange(hooks?.solidZ() ?? null);
    if (!range) {
      text = "This solid is too thin to split.";
      bad = true;
    } else if (!splitPlaneInside(num("#modelPlaneZ"), range)) {
      text = `Move the plane into the part, between ${formatMm(range.min)} and ${formatMm(range.max)} mm.`;
      bad = true;
    } else {
      text = `From ${formatMm(range.min)} to ${formatMm(range.max)} mm. The middle is ${formatMm(range.mid)}.`;
    }
  } else if (tool === "fillet" || tool === "chamfer") {
    if (lastEdge(picks) == null) text = "Pick an edge.";
    else {
      const note = blendNote(tool, probe);
      text = note.text;
      bad = note.bad;
    }
  } else if (tool === "hole") text = "Straight down from the origin.";
  else if (tool === "scale") text = "About the centre. Placement scale becomes 100%.";
  note.textContent = text;
  note.classList.toggle("is-bad", bad);
  note.toggleAttribute("hidden", text.length === 0);
}

function refreshGhost() {
  const view = fx.model;
  if (!view) return;
  if (state.stage !== "model" || !tool) {
    view.setGhost(null);
    return;
  }
  view.setGhost(ghostFor(tool));
}

function ghostFor(current: ModelTool): ModelGhost | null {
  if (current === "boolean") {
    const prim = document.querySelector<HTMLSelectElement>("#modelPrim")?.value ?? "box";
    const origin = { x: num("#modelX"), y: num("#modelY"), z: num("#modelZ") };
    if (prim === "cylinder") return { kind: "cylinder", ...origin, radius: num("#modelRadius"), height: num("#modelHeight") };
    if (prim === "sphere") return { kind: "sphere", ...origin, radius: num("#modelRadius") };
    return { kind: "box", ...origin, dx: num("#modelDx"), dy: num("#modelDy"), dz: num("#modelDz") };
  }
  if (current === "split") return { kind: "plane", z: num("#modelPlaneZ") };
  if (current === "hole") return { kind: "hole", x: num("#modelX"), y: num("#modelY"), z: num("#modelZ"), radius: num("#modelHoleR"), depth: num("#modelHoleD") };
  if (current === "scale") return { kind: "scale", factor: num("#modelFactor") };
  const edge = lastEdge(picks);
  if (edge == null) return null;
  return { kind: "blend", edge, radius: num("#modelBlend") };
}

function num(id: string) {
  const value = Number(document.querySelector<HTMLInputElement>(id)?.value);
  return Number.isFinite(value) ? value : 0;
}

function onEnter(ev: KeyboardEvent) {
  if (ev.key !== "Enter" || ev.repeat || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  if (state.stage !== "model" || !tool) return;
  const target = ev.target instanceof Element ? ev.target : null;
  if (!target?.closest("#modelPanel")) return;
  ev.preventDefault();
  ev.stopPropagation();
  document.querySelector<HTMLButtonElement>("#modelApply")?.click();
}

function bindScrub() {
  const root = document.querySelector<HTMLElement>("#modelPanel");
  if (!root) return;
  root.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0 || scrub) return;
    const handle = (ev.target as Element | null)?.closest<HTMLElement>("[data-scrub]");
    const input = handle?.parentElement?.querySelector<HTMLInputElement>("input");
    if (!handle || !input) return;
    const origin = Number(input.value);
    if (!Number.isFinite(origin)) return;
    if (ev.pointerType !== "touch") ev.preventDefault();
    const step = Number(input.step) > 0 ? Number(input.step) : 0.1;
    const shiftStep = Number(handle.parentElement?.dataset.shift) > 0 ? Number(handle.parentElement?.dataset.shift) : step * 10;
    scrub = { id: ev.pointerId, input, startX: ev.clientX, startY: ev.clientY, origin, step, shiftStep, mode: "pending" };
    window.addEventListener("pointermove", onScrubMove, { passive: false });
    window.addEventListener("pointerup", onScrubUp);
    window.addEventListener("pointercancel", onScrubUp);
  });
}

function onScrubMove(ev: PointerEvent) {
  const current = scrub;
  if (!current || ev.pointerId !== current.id) return;
  const dx = ev.clientX - current.startX;
  const dy = ev.clientY - current.startY;
  if (current.mode === "pending") {
    current.mode = scrubIntent(dx, dy);
    if (current.mode !== "scrub") return;
  }
  if (current.mode !== "scrub") return;
  ev.preventDefault();
  const total = scrubTarget(dx, ev.shiftKey, current.step, current.shiftStep);
  let next = current.origin + total;
  if (current.input.min !== "") {
    const min = Number(current.input.min);
    if (Number.isFinite(min)) next = Math.max(min, next);
  }
  if (current.input.max !== "") {
    const max = Number(current.input.max);
    if (Number.isFinite(max)) next = Math.min(max, next);
  }
  const places = (current.step.toString().split(".")[1] ?? "").length;
  const text = places > 0 ? next.toFixed(places) : String(Math.round(next));
  if (current.input.value === text) return;
  current.input.value = text;
  current.input.dispatchEvent(new Event("input", { bubbles: true }));
}

function onScrubUp(ev: PointerEvent) {
  if (!scrub || ev.pointerId !== scrub.id) return;
  scrub = null;
  window.removeEventListener("pointermove", onScrubMove);
  window.removeEventListener("pointerup", onScrubUp);
  window.removeEventListener("pointercancel", onScrubUp);
}
