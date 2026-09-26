/** Where the By region plane sits, in print millimetres. */

export interface AxisBounds {
  min: [number, number, number];
  max: [number, number, number];
}

export type SplitAxis = "x" | "y";
export type SplitSync = "load" | "axis" | "transform" | "open";

export function splitIndex(axis: SplitAxis): 0 | 1 {
  return axis === "x" ? 0 : 1;
}

export function splitMidpoint(bounds: AxisBounds, axis: SplitAxis): number {
  const i = splitIndex(axis);
  return (bounds.min[i] + bounds.max[i]) / 2;
}

export function roundSplit(at: number): number {
  return Math.round(at * 10) / 10;
}

export function splitOutside(at: number, bounds: AxisBounds, axis: SplitAxis): boolean {
  const i = splitIndex(axis);
  return at < bounds.min[i] - 1e-4 || at > bounds.max[i] + 1e-4;
}

export function clampSplit(at: number, bounds: AxisBounds, axis: SplitAxis): number {
  const i = splitIndex(axis);
  return Math.min(bounds.max[i], Math.max(bounds.min[i], at));
}

/**
 * Load and axis changes take the midpoint of the mesh on that axis.
 * A transform or opening By region keeps a custom value that still cuts the
 * mesh; anything outside snaps back to the midpoint so the plane is a real cut.
 */
export function nextSplitAt(
  reason: SplitSync,
  at: number,
  bounds: AxisBounds | null,
  axis: SplitAxis,
  custom: boolean,
): number {
  if (!bounds) return roundSplit(at);
  const mid = roundSplit(splitMidpoint(bounds, axis));
  if (reason === "load" || reason === "axis") return mid;
  if (!custom || splitOutside(at, bounds, axis)) return mid;
  return roundSplit(at);
}
