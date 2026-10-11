/**
 * Drag a placement label. One gesture, one undo step.
 * X and Y call `setPlaceCenter`. Scale writes the one `partScale` multiplier.
 * A short or vertical drag does not capture, so the sheet can scroll.
 */
import { scrubIntent, scrubTarget, type ScrubIntent } from "../ui/scrub";
import { fx } from "./fx";
import { setPlaceCenter } from "./files";
import { beginEdit, flushEdit } from "./history";
import { renderChrome } from "./settings";
import { state } from "./state";

const MOVE_STEP_MM = 0.1;
const MOVE_SHIFT_MM = 1;
const SCALE_STEP = 1;
const SCALE_SHIFT = 5;
const SCALE_MIN = 10;
const SCALE_MAX = 400;

type Axis = "x" | "y" | "scale";

type Drag = {
  id: number;
  axis: Axis;
  label: HTMLElement;
  startX: number;
  startY: number;
  origin: number;
  mode: ScrubIntent;
  opened: boolean;
  written: number;
};

let drag: Drag | null = null;

function centerOf(axis: Axis): number | null {
  const bounds = state.placed?.bounds;
  if (!bounds) return null;
  const i = axis === "x" ? 0 : 1;
  return (bounds.min[i] + bounds.max[i]) / 2;
}

function hud(axis: Axis, total: number): string {
  return `${axis.toUpperCase()} ${total >= 0 ? "+" : ""}${total.toFixed(1)} mm`;
}

function blurPlaceField() {
  const active = document.activeElement;
  if (active instanceof HTMLInputElement && (active.id === "placeX" || active.id === "placeY" || active.id === "partScale")) active.blur();
}

function writeScale(percent: number) {
  state.partScale = percent / 100;
  const input = document.querySelector<HTMLInputElement>("#partScale");
  if (input && document.activeElement !== input) input.value = String(percent);
  fx.applyPlace(false);
}

function stopTracking() {
  window.removeEventListener("pointermove", onMove);
  window.removeEventListener("pointerup", onUp);
  window.removeEventListener("pointercancel", onUp);
}

function endDrag() {
  const ended = drag;
  drag = null;
  stopTracking();
  if (ended?.mode === "scrub" && !ended.label.closest("label.setting")) swallowNextClick();
  if (!ended?.opened) return;
  flushEdit();
  state.poseHud = "";
  fx.paintGizmoReadout?.();
  renderChrome();
  fx.scheduleAuto?.();
}

/** A scrub is not a click. The volume name sits on a summary, and that click would open the row. */
function swallowNextClick() {
  const stop = (ev: Event) => {
    ev.preventDefault();
    ev.stopPropagation();
  };
  document.addEventListener("click", stop, { capture: true, once: true });
  window.setTimeout(() => document.removeEventListener("click", stop, { capture: true }), 0);
}

function onMove(ev: PointerEvent) {
  const current = drag;
  if (!current || ev.pointerId !== current.id) return;
  const dx = ev.clientX - current.startX;
  const dy = ev.clientY - current.startY;
  if (current.mode === "pending") {
    current.mode = scrubIntent(dx, dy);
    if (current.mode !== "scrub") return;
    blurPlaceField();
    current.label.setPointerCapture(ev.pointerId);
  }
  if (current.mode !== "scrub") return;
  ev.preventDefault();
  const move = current.axis !== "scale";
  const total = scrubTarget(dx, ev.shiftKey, move ? MOVE_STEP_MM : SCALE_STEP, move ? MOVE_SHIFT_MM : SCALE_SHIFT);
  const next = move
    ? Math.round((current.origin + total) * 1000) / 1000
    : Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.round(current.origin + total)));
  if (!current.opened) {
    if (next === current.origin) return;
    beginEdit();
    current.opened = true;
  }
  if (current.axis === "x" || current.axis === "y") {
    state.poseHud = hud(current.axis, total);
    fx.paintGizmoReadout?.();
  }
  if (next === current.written) return;
  current.written = next;
  if (current.axis === "scale") writeScale(next);
  else setPlaceCenter(current.axis, next);
}

function onUp(ev: PointerEvent) {
  if (!drag || ev.pointerId !== drag.id) return;
  endDrag();
}

/** Listen on the sheet. The labels are rebuilt with the chrome; the listener is not. */
export function bindPlaceScrub(root: HTMLElement) {
  root.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0 || drag) return;
    const label = (ev.target as HTMLElement).closest<HTMLElement>("[data-scrub]");
    const axis = label?.dataset.scrub;
    if (axis !== "x" && axis !== "y" && axis !== "scale") return;
    const origin = axis === "scale" ? Math.round(state.partScale * 100) : centerOf(axis);
    if (origin == null || !label) return;
    // Placement labels sit on the number. Cancelling the click keeps it from focusing.
    // A volume name is the summary's label: a click must still open the row.
    if (ev.pointerType !== "touch" && label.closest("label.setting")) ev.preventDefault();
    drag = {
      id: ev.pointerId,
      axis,
      label,
      startX: ev.clientX,
      startY: ev.clientY,
      origin,
      mode: "pending",
      opened: false,
      written: origin,
    };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  });
}
