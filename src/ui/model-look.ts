/**
 * --- A10. Model's View menu: section (a plane dragged by one arrow, or typed) and colour by step.
 * The menu sits in the model foot, beside Reset view. It changes only how the solid is drawn.
 * The settings belong to the open object: opening another one, or a new plate, starts them over.
 */
import { idleLook, offsetAfterDrag, stepHex, type LookState, type Plane, type SectionAxis } from "../model-look.ts";
import { syncStepColours } from "./model-history.ts";

export interface ModelLookView {
  setLook(state: LookState): void;
  onSectionDrag(cb: (mm: number, phase: "start" | "move" | "end") => void): void;
  /** A plane in the open solid's frame, in model space at the solid's pose now. */
  posed(plane: Plane): Plane;
}

let state: LookState = idleLook();
let view: ModelLookView | null = null;
let dragOffset = 0;
let note = "";
/** The picked section face in the solid's frame, so the plane moves with the part when Place moves it. */
let ownFace: Plane | null = null;
/** Face was just chosen: the next face pick is the plane. A pick for another tool leaves the plane alone. */
let faceArmed = false;

function byId<T extends HTMLElement>(id: string): T | null {
  return document.querySelector<T>(id);
}

function push() {
  state = { ...state, face: ownFace && view ? view.posed(ownFace) : null };
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

function paintAxis(axis: SectionAxis) {
  for (const button of document.querySelectorAll<HTMLButtonElement>("#modelSectionAxis [data-axis]")) {
    button.setAttribute("aria-pressed", button.dataset.axis === axis ? "true" : "false");
  }
}

function setAxis(axis: SectionAxis) {
  state = { ...state, axis };
  paintAxis(axis);
  faceArmed = axis === "face";
  note = axis === "face" ? (ownFace ? "Pick a flat face to move the plane there." : "Pick a flat face.") : "";
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
    faceArmed = state.section && state.axis === "face" && !ownFace;
    note = faceArmed ? "Pick a flat face." : "";
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
  resetModelLook();
}

/** Another object opened, or the plate was replaced: section and colour by step start over, off. */
export function resetModelLook() {
  state = idleLook();
  ownFace = null;
  faceArmed = false;
  dragOffset = 0;
  note = "";
  for (const id of ["#modelSection", "#modelSectionFlip", "#modelColourSteps"]) {
    const box = byId<HTMLInputElement>(id);
    if (box) box.checked = false;
  }
  paintAxis(state.axis);
  closePanel();
  push();
}

/** The open object moved or turned: a face plane goes with it. */
export function lookPoseChanged() {
  if (ownFace) push();
}

/**
 * A picked face becomes the section plane right after Face was chosen (or Section turned on with Face and no plane
 * yet). A curved face is refused in the menu. `own` is that face in the solid's frame.
 */
export function sectionFacePicked(own: Plane | "curved") {
  if (!state.section || state.axis !== "face" || !faceArmed) return;
  if (own === "curved") {
    note = "Pick a flat face. This one is curved.";
    push();
    return;
  }
  ownFace = { origin: [...own.origin], normal: [...own.normal] };
  faceArmed = false;
  state = { ...state, offset: 0 };
  dragOffset = 0;
  note = "";
  push();
}
