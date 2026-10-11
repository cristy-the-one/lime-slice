/**
 * Drag the X or Y label. One gesture, one undo step, the same centre `setPlaceCenter` already writes.
 * A short or vertical drag does not capture, so the sheet can scroll.
 */
import { scrubIntent, scrubTarget, type ScrubIntent } from "../ui/scrub";
import { fx } from "./fx";
import { setPlaceCenter } from "./files";
import { beginEdit, flushEdit } from "./history";
import { renderChrome } from "./settings";
import { state } from "./state";

const STEP_MM = 0.1;
const SHIFT_MM = 1;

type Axis = "x" | "y";

type Drag = {
  id: number;
  axis: Axis;
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
  if (active instanceof HTMLInputElement && (active.id === "placeX" || active.id === "placeY")) active.blur();
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
  if (!ended?.opened) return;
  flushEdit();
  state.poseHud = "";
  fx.paintGizmoReadout?.();
  renderChrome();
  fx.scheduleAuto?.();
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
    document.querySelector<HTMLElement>(`[data-scrub="${current.axis}"]`)?.setPointerCapture(ev.pointerId);
  }
  if (current.mode !== "scrub") return;
  ev.preventDefault();
  const total = scrubTarget(dx, ev.shiftKey, STEP_MM, SHIFT_MM);
  const next = Math.round((current.origin + total) * 1000) / 1000;
  if (!current.opened) {
    if (total === 0) return;
    beginEdit();
    current.opened = true;
  }
  state.poseHud = hud(current.axis, total);
  if (next !== current.written) {
    current.written = next;
    setPlaceCenter(current.axis, next);
  }
  fx.paintGizmoReadout?.();
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
    if (axis !== "x" && axis !== "y") return;
    const origin = centerOf(axis);
    if (origin == null) return;
    if (ev.pointerType !== "touch") ev.preventDefault();
    drag = {
      id: ev.pointerId,
      axis,
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
