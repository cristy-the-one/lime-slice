/**
 * --- A10. Model's View menu: section (a plane dragged by one arrow, or typed) and colour by step.
 * The menu sits in the model foot, beside Reset view. It changes only how the solid is drawn.
 */
import { idleLook, offsetAfterDrag, stepHex, type LookState, type Plane, type SectionAxis } from "../model-look.ts";
import { syncStepColours } from "./model-history.ts";

export interface ModelLookView {
  setLook(state: LookState): void;
  onSectionDrag(cb: (mm: number, phase: "start" | "move" | "end") => void): void;
}

let state: LookState = idleLook();
let view: ModelLookView | null = null;
let dragOffset = 0;
let note = "";

function byId<T extends HTMLElement>(id: string): T | null {
  return document.querySelector<T>(id);
}

function push() {
  view?.setLook(state);
  const offset = byId<HTMLInputElement>("#modelSectionOffset");
  if (offset && document.activeElement !== offset) offset.value = String(Math.round(state.offset * 1000) / 1000);
  const message = byId<HTMLElement>("#modelSectionNote");
  if (message) {
    message.hidden = !note;
    message.textContent = note;
  }
  syncStepColours(state.colourByStep, stepHex);
}

function setAxis(axis: SectionAxis) {
  state = { ...state, axis };
  for (const button of document.querySelectorAll<HTMLButtonElement>("#modelSectionAxis [data-axis]")) {
    const on = button.dataset.axis === axis;
    button.setAttribute("aria-pressed", on ? "true" : "false");
  }
  note = axis === "face" && !state.face ? "Pick a flat face." : "";
  push();
}

function closePanel() {
  const panel = byId<HTMLElement>("#modelLookPanel");
  const open = byId<HTMLButtonElement>("#modelLookOpen");
  if (!panel || panel.hidden) return;
  panel.hidden = true;
  open?.setAttribute("aria-expanded", "false");
}

function togglePanel() {
  const panel = byId<HTMLElement>("#modelLookPanel");
  const open = byId<HTMLButtonElement>("#modelLookOpen");
  if (!panel || !open) return;
  const show = panel.hidden;
  panel.hidden = !show;
  open.setAttribute("aria-expanded", show ? "true" : "false");
  if (show) byId<HTMLInputElement>("#modelSection")?.focus();
}

export function mountModelLook(next: ModelLookView) {
  view = next;
  const open = byId<HTMLButtonElement>("#modelLookOpen");
  const panel = byId<HTMLElement>("#modelLookPanel");
  if (!open || !panel) return;
  open.addEventListener("click", () => togglePanel());
  byId<HTMLInputElement>("#modelSection")?.addEventListener("change", (ev) => {
    state = { ...state, section: (ev.target as HTMLInputElement).checked };
    note = state.section && state.axis === "face" && !state.face ? "Pick a flat face." : "";
    push();
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>("#modelSectionAxis [data-axis]")) {
    button.addEventListener("click", () => setAxis(button.dataset.axis as SectionAxis));
  }
  const offset = byId<HTMLInputElement>("#modelSectionOffset");
  offset?.addEventListener("input", () => {
    const value = Number(offset.value);
    if (!Number.isFinite(value)) return;
    state = { ...state, offset: value };
    push();
  });
  byId<HTMLInputElement>("#modelSectionFlip")?.addEventListener("change", (ev) => {
    state = { ...state, flip: (ev.target as HTMLInputElement).checked };
    push();
  });
  byId<HTMLInputElement>("#modelColourSteps")?.addEventListener("change", (ev) => {
    state = { ...state, colourByStep: (ev.target as HTMLInputElement).checked };
    push();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && panel && !panel.hidden) {
      closePanel();
      open.focus();
    }
  });
  document.addEventListener("pointerdown", (ev) => {
    if (panel.hidden) return;
    const target = ev.target;
    if (target instanceof Node && (panel.contains(target) || open.contains(target))) return;
    closePanel();
  });
  next.onSectionDrag((mm, phase) => {
    if (phase === "start") {
      dragOffset = state.offset;
      return;
    }
    state = { ...state, offset: offsetAfterDrag(dragOffset, mm, state.flip) };
    if (phase === "end") dragOffset = state.offset;
    push();
  });
  setAxis("z");
}

/**
 * A picked face becomes the section plane while the axis is Face. A curved face is refused in the menu.
 * `posed` is that face in model space.
 */
export function sectionFacePicked(posed: Plane | "curved") {
  if (!state.section || state.axis !== "face") return;
  if (posed === "curved") {
    note = "Pick a flat face. This one is curved.";
    push();
    return;
  }
  state = { ...state, face: { origin: [...posed.origin], normal: [...posed.normal] }, offset: 0 };
  dragOffset = 0;
  note = "";
  push();
}
