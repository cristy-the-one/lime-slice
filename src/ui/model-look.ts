/**
 * --- A10. Model's View menu: section (a plane dragged by one arrow, or typed), colour by step, and, for a split to
 * print's part, Explode.
 * The menu sits in the model foot, beside Reset view. It changes only how the solid is drawn.
 * The settings belong to the open object: opening another one, or a new plate, starts them over.
 */
import {
  idleLook,
  offsetAfterDrag,
  stepHex,
  withShading,
  type CurvatureMode,
  type LookState,
  type Plane,
  type SectionAxis,
  type ShadingMode,
  type ZebraAxis,
} from "../model-look.ts";
import { EXPLODE_GAP_MM } from "../model-explode.ts";
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
  // --- D36. A section drag pushes on every move; History repaints its rows only when colour by step changes.
  if (paintedColours !== state.colourByStep) {
    paintedColours = state.colourByStep;
    syncStepColours(state.colourByStep, stepHex);
  }
}

let paintedColours: boolean | null = null;
let surfaceNeedChanged: (need: { curvature: boolean; isoparms: boolean }) => void = () => {};

/** Current View look state (read by Model when a new solid arrives to know if curvature/isoparms should load). */
export function lookState(): LookState {
  return state;
}

/** Register a callback fired whenever Curvature or Surface grid (Isoparms) inspection data is needed. */
export function onSurfaceNeed(cb: (need: { curvature: boolean; isoparms: boolean }) => void) {
  surfaceNeedChanged = cb;
}

function paintSurfaceControls() {
  for (const button of document.querySelectorAll<HTMLButtonElement>("#modelShading [data-shading]")) {
    button.setAttribute("aria-pressed", button.dataset.shading === state.shading ? "true" : "false");
  }
  const stepBox = byId<HTMLInputElement>("#modelColourSteps");
  if (stepBox) stepBox.checked = state.shading === "step";
  const isoBox = byId<HTMLInputElement>("#modelIsoparms");
  if (isoBox) isoBox.checked = state.isoparms;
  const zebraRow = byId<HTMLElement>("#modelZebraRow");
  if (zebraRow) zebraRow.hidden = state.shading !== "zebra";
  const curvRow = byId<HTMLElement>("#modelCurvatureRow");
  if (curvRow) curvRow.hidden = state.shading !== "curvature";
  const warnRow = byId<HTMLElement>("#modelCurvatureWarnRow");
  if (warnRow) warnRow.hidden = state.curvatureMode !== "radius";
  for (const button of document.querySelectorAll<HTMLButtonElement>("#modelZebraAxis [data-zebra-axis]")) {
    button.setAttribute("aria-pressed", button.dataset.zebraAxis === state.zebraAxis ? "true" : "false");
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("#modelCurvatureMode [data-curvature-mode]")) {
    button.setAttribute("aria-pressed", button.dataset.curvatureMode === state.curvatureMode ? "true" : "false");
  }
  const stripes = byId<HTMLInputElement>("#modelZebraStripes");
  if (stripes && document.activeElement !== stripes) stripes.value = String(state.zebraStripes);
  const warn = byId<HTMLInputElement>("#modelCurvatureWarn");
  if (warn && document.activeElement !== warn) warn.value = String(state.curvatureWarnMm);
}

function setShading(shading: ShadingMode) {
  state = withShading(state, shading);
  paintSurfaceControls();
  push();
  if (state.shading === "curvature" || state.isoparms) {
    surfaceNeedChanged({ curvature: state.shading === "curvature", isoparms: state.isoparms });
  }
}

export function toggleZebra() {
  setShading(state.shading === "zebra" ? "normal" : "zebra");
}

export function toggleCurvature() {
  setShading(state.shading === "curvature" ? "normal" : "curvature");
}

export function toggleIsoparms() {
  state = { ...state, isoparms: !state.isoparms };
  paintSurfaceControls();
  push();
  if (state.isoparms || state.shading === "curvature") {
    surfaceNeedChanged({ curvature: state.shading === "curvature", isoparms: state.isoparms });
  }
}

// --- Split to print, Explode (D12). A view of a split to print's pieces, off with each new object and never saved.
let explode = { on: false, gapMm: EXPLODE_GAP_MM };
let explodeAvailable = false;
let explodeChanged: () => void = () => {};

/** Whether Explode applies now (it is on, and the open part has pieces), and its gap in millimetres. */
export function explodeLook(): { on: boolean; gapMm: number } {
  return { on: explode.on && explodeAvailable, gapMm: explode.gapMm };
}

/** Model draws the pieces again when Explode or its gap changes. */
export function onExplode(cb: () => void) {
  explodeChanged = cb;
}

/** The open part has pieces to explode, or not: the row shows only then. A setting turned on stays on, to apply again when they are. */
export function showExplode(available: boolean) {
  explodeAvailable = available;
  const row = byId<HTMLElement>("#modelExplodeRow");
  if (row) row.hidden = !available;
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
  if (show) {
    seat(open, panel);
    byId<HTMLInputElement>("#modelSection")?.focus();
  }
}

/** E3. View opens beside the rail, level with its button and on screen; under the button on the phone's strip. */
function seat(open: HTMLElement, panel: HTMLElement) {
  const at = open.getBoundingClientRect();
  const rail = open.closest("#toolRail")?.getBoundingClientRect();
  if (rail && rail.height > rail.width) {
    // Beside the rail, or beside a folded group's row when View was opened from it.
    panel.style.left = `${Math.max(rail.right, at.right) + 6}px`;
    panel.style.top = `${Math.max(8, Math.min(at.top - 4, window.innerHeight - panel.offsetHeight - 8))}px`;
  } else {
    panel.style.top = `${at.bottom + 4}px`;
    panel.style.left = `${Math.max(8, Math.min(at.left, window.innerWidth - panel.offsetWidth - 8))}px`;
  }
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
    setShading((ev.target as HTMLInputElement).checked ? "step" : "normal");
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>("#modelShading [data-shading]")) {
    button.addEventListener("click", () => setShading(button.dataset.shading as ShadingMode));
  }
  const stripes = byId<HTMLInputElement>("#modelZebraStripes");
  stripes?.addEventListener("input", () => {
    const value = Number(stripes.value);
    if (!Number.isFinite(value)) return;
    state = { ...state, zebraStripes: Math.max(4, Math.min(40, value)) };
    push();
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>("#modelZebraAxis [data-zebra-axis]")) {
    button.addEventListener("click", () => {
      state = { ...state, zebraAxis: button.dataset.zebraAxis as ZebraAxis };
      paintSurfaceControls();
      push();
    });
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("#modelCurvatureMode [data-curvature-mode]")) {
    button.addEventListener("click", () => {
      state = { ...state, curvatureMode: button.dataset.curvatureMode as CurvatureMode };
      paintSurfaceControls();
      push();
    });
  }
  const warn = byId<HTMLInputElement>("#modelCurvatureWarn");
  warn?.addEventListener("input", () => {
    const value = Number(warn.value);
    if (!Number.isFinite(value) || value <= 0) return;
    state = { ...state, curvatureWarnMm: value };
    push();
  });
  byId<HTMLInputElement>("#modelIsoparms")?.addEventListener("change", (ev) => {
    state = { ...state, isoparms: (ev.target as HTMLInputElement).checked };
    paintSurfaceControls();
    push();
    if (state.isoparms || state.shading === "curvature") {
      surfaceNeedChanged({ curvature: state.shading === "curvature", isoparms: state.isoparms });
    }
  });
  byId<HTMLInputElement>("#modelExplode")?.addEventListener("change", (ev) => {
    explode = { ...explode, on: (ev.target as HTMLInputElement).checked };
    explodeChanged();
  });
  const gap = byId<HTMLInputElement>("#modelExplodeGap");
  gap?.addEventListener("input", () => {
    const value = Number(gap.value);
    if (gap.value.trim() === "" || !Number.isFinite(value) || value < 0) return;
    explode = { ...explode, gapMm: value };
    if (explode.on) explodeChanged();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && panel && !panel.hidden) {
      closePanel();
      open.focus();
      return;
    }
    // Alt+Z, Alt+C and Alt+I are commands (src/ui/commands.ts): help, the palette and the one-key-one-command test see them.
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
  for (const id of ["#modelSection", "#modelSectionFlip", "#modelColourSteps", "#modelIsoparms", "#modelExplode"]) {
    const box = byId<HTMLInputElement>(id);
    if (box) box.checked = false;
  }
  const wasExploded = explode.on;
  explode = { on: false, gapMm: EXPLODE_GAP_MM };
  const gap = byId<HTMLInputElement>("#modelExplodeGap");
  if (gap) gap.value = String(EXPLODE_GAP_MM);
  if (wasExploded) queueMicrotask(() => explodeChanged());
  paintAxis(state.axis);
  paintSurfaceControls();
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
