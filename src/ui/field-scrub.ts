/**
 * Drag a number's label. The label is rebuilt with the panel; the listener stays on a stable ancestor.
 * `data-scrub="field"` is the marker. Placement X/Y/scale and Rx/Ry/Rz keep their own listener.
 */
import { scrubIntent, scrubTarget, type ScrubIntent } from "./scrub";

type Drag = {
  id: number;
  handle: HTMLElement;
  input: HTMLInputElement;
  startX: number;
  startY: number;
  origin: number;
  step: number;
  mode: ScrubIntent;
  moved: boolean;
};

let drag: Drag | null = null;

function stopTracking() {
  window.removeEventListener("pointermove", onMove);
  window.removeEventListener("pointerup", onUp);
  window.removeEventListener("pointercancel", onUp);
}

function onMove(ev: PointerEvent) {
  const current = drag;
  if (!current || ev.pointerId !== current.id) return;
  const dx = ev.clientX - current.startX;
  const dy = ev.clientY - current.startY;
  if (current.mode === "pending") {
    current.mode = scrubIntent(dx, dy);
    if (current.mode !== "scrub") return;
    current.handle.setPointerCapture(ev.pointerId);
  }
  if (current.mode !== "scrub") return;
  ev.preventDefault();
  // Shift is a tenth of a step. The field's own min and max still hold.
  const quantum = ev.shiftKey ? current.step / 10 : current.step;
  const total = scrubTarget(dx, false, quantum, quantum);
  let next = current.origin + total;
  if (current.input.min !== "") {
    const min = Number(current.input.min);
    if (Number.isFinite(min)) next = Math.max(min, next);
  }
  if (current.input.max !== "") {
    const max = Number(current.input.max);
    if (Number.isFinite(max)) next = Math.min(max, next);
  }
  const places = (quantum.toString().split(".")[1] ?? "").length;
  const text = places > 0 ? next.toFixed(places) : String(Math.round(next));
  if (current.input.value === text) return;
  current.moved = true;
  current.input.value = text;
  current.input.dispatchEvent(new Event("input", { bubbles: true }));
}

function onUp(ev: PointerEvent) {
  if (!drag || ev.pointerId !== drag.id) return;
  const ended = drag;
  drag = null;
  stopTracking();
  if (ended.moved && ended.input.closest("[data-override-card]")) {
    ended.input.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

/** Listen on a parent that survives innerHTML rebuilds of the number rows. */
export function bindFieldScrub(root: HTMLElement) {
  root.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0 || drag) return;
    const handle = (ev.target as Element | null)?.closest<HTMLElement>("[data-scrub]");
    if (handle?.dataset.scrub !== "field") return;
    const input = handle.parentElement?.querySelector<HTMLInputElement>('input[type="number"]');
    if (!input) return;
    const origin = Number(input.value);
    if (!Number.isFinite(origin)) return;
    if (ev.pointerType !== "touch") ev.preventDefault();
    const step = Number(input.step) > 0 ? Number(input.step) : 0.1;
    drag = {
      id: ev.pointerId,
      handle,
      input,
      startX: ev.clientX,
      startY: ev.clientY,
      origin,
      step,
      mode: "pending",
      moved: false,
    };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  });
}
