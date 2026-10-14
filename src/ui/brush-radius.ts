/** Step a paint-brush radius and write the visible number. The bar's own input handler updates the 3D cursor. */

export function steppedRadius(current: number, by: number, min: number, max: number, step: number): number {
  if (!Number.isFinite(current) || !Number.isFinite(by)) return Number.isFinite(current) ? current : min;
  const quantum = step > 0 ? step : 0.5;
  const next = Math.min(max, Math.max(min, current + by));
  const snapped = Math.round(next / quantum) * quantum;
  const clamped = Math.min(max, Math.max(min, snapped));
  return Math.round(clamped * 1000) / 1000;
}

/** The radius field of the brush bar that is open, if one is. */
export function activeBrushRadius(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>(".paint-bar:not([hidden]) [data-brush-radius]");
}

/** Add `by` millimetres to the open brush and tell its bar. No open brush is a no-op. */
export function nudgeBrushRadius(by: number): void {
  const radius = activeBrushRadius();
  if (!radius) return;
  const min = Number(radius.min);
  const max = Number(radius.max);
  const step = Number(radius.step);
  const next = steppedRadius(
    Number(radius.value),
    by,
    Number.isFinite(min) ? min : 0.5,
    Number.isFinite(max) ? max : 20,
    Number.isFinite(step) && step > 0 ? step : 0.5,
  );
  const text = String(next);
  if (radius.value === text) return;
  radius.value = text;
  radius.dispatchEvent(new Event("input", { bubbles: true }));
}
