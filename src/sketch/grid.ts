/**
 * The sketch plane's grid. Spacing comes from `gridSpacing` in `src/interact/snap.ts`:
 * 1, 2 or 5 times a power of ten, and never closer than 12 px. This only lays the lines
 * across a window of the plane.
 */
import type { Pt } from "./model.ts";

export interface GridLine {
  a: Pt;
  b: Pt;
}

/** At most this many lines each way, so an edge-on view cannot ask for millions. */
const MAX_LINES = 80;

/** Grid lines covering the window, including the line through zero when it is in range. */
export function gridLines(minU: number, maxU: number, minV: number, maxV: number, spacing: number): GridLine[] {
  if (!(spacing > 0) || !Number.isFinite(spacing)) return [];
  const u0 = Math.min(minU, maxU);
  const u1 = Math.max(minU, maxU);
  const v0 = Math.min(minV, maxV);
  const v1 = Math.max(minV, maxV);
  const lines: GridLine[] = [];
  for (const at of steps(u0, u1, spacing)) lines.push({ a: [at, v0], b: [at, v1] });
  for (const at of steps(v0, v1, spacing)) lines.push({ a: [u0, at], b: [u1, at] });
  return lines;
}

function steps(min: number, max: number, spacing: number): number[] {
  if (!(max > min)) return [];
  let at = Math.ceil(min / spacing) * spacing;
  const out: number[] = [];
  let guard = 0;
  while (at <= max + spacing * 1e-6 && guard < MAX_LINES) {
    if (at >= min - spacing * 1e-6) out.push(snapZero(at, spacing));
    at += spacing;
    guard += 1;
  }
  return out;
}

/** A step that landed a hair off zero is zero, so the origin line is exact. */
function snapZero(value: number, spacing: number): number {
  return Math.abs(value) < spacing * 1e-6 ? 0 : value;
}
