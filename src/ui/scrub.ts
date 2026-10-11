/**
 * Label-drag quanta for a number the sheet already edits.
 * A short move is not a scrub, so a sheet can still scroll.
 */

/** Pointer travel that is still a scroll, not a value change. Two pixels is inside this. */
export const SCRUB_SLOP_PX = 5;

/** Pixels of travel, past the slop, for one step. */
export const SCRUB_PX_PER_STEP = 4;

export type ScrubIntent = "pending" | "scroll" | "scrub";

/** Horizontal past the slop is a scrub. Vertical past the slop is the sheet's scroll. */
export function scrubIntent(dx: number, dy: number, slop = SCRUB_SLOP_PX): ScrubIntent {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return "pending";
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < slop && ay < slop) return "pending";
  if (ay > ax) return "scroll";
  return "scrub";
}

/**
 * The amount to add for a horizontal drag. Zero until a whole step has cleared the slop.
 * Shift changes the quantum. The pixel size stays.
 */
export function scrubTarget(
  dx: number,
  shift: boolean,
  step: number,
  shiftStep: number,
  slop = SCRUB_SLOP_PX,
  pxPerStep = SCRUB_PX_PER_STEP,
): number {
  if (scrubIntent(dx, 0, slop) !== "scrub") return 0;
  if (!(step > 0) || !(shiftStep > 0) || !(pxPerStep > 0)) return 0;
  const past = dx > 0 ? dx - slop : dx + slop;
  const steps = Math.trunc(past / pxPerStep);
  if (steps === 0) return 0;
  const quantum = shift ? shiftStep : step;
  return Math.round(steps * quantum * 1000) / 1000;
}

/** Pointer travel from the down point that yields this many steps. */
export function scrubTravel(steps: number, slop = SCRUB_SLOP_PX, pxPerStep = SCRUB_PX_PER_STEP): number {
  const sign = steps < 0 ? -1 : 1;
  return sign * (slop + Math.abs(steps) * pxPerStep);
}
