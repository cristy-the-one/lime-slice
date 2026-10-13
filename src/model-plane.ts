/**
 * Where a horizontal split is allowed to sit.
 * The Open CASCADE session uses the same floor and fraction, so a plane the
 * panel accepts is one the kernel will cut.
 */

export const SPLIT_MARGIN_FLOOR_MM = 0.25;
export const SPLIT_MARGIN_FRACTION = 0.02;

export interface AxisExtent {
  min: number;
  max: number;
}

export interface SplitPlaneRange {
  min: number;
  max: number;
  mid: number;
}

/** Z of a tessellation, or null when it has no finite height. */
export function zExtent(positions: ArrayLike<number> | null | undefined): AxisExtent | null {
  if (!positions || positions.length < 3) return null;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 2; i < positions.length; i += 3) {
    const z = positions[i]!;
    if (!Number.isFinite(z)) continue;
    if (z < min) min = z;
    if (z > max) max = z;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return { min, max };
}

/** Clearance kept off each face. A 5 mm plate keeps 0.25 mm, so Z = 5 cannot shave a sliver. */
export function splitMargin(thickness: number): number {
  if (!(thickness > 0)) return SPLIT_MARGIN_FLOOR_MM;
  return Math.max(SPLIT_MARGIN_FLOOR_MM, thickness * SPLIT_MARGIN_FRACTION);
}

/** Legal plane heights. Null when any cut would leave a sliver. `mid` is the part's middle. */
export function splitPlaneRange(bounds: AxisExtent | null): SplitPlaneRange | null {
  if (!bounds) return null;
  const thickness = bounds.max - bounds.min;
  if (!(thickness > 0)) return null;
  const margin = splitMargin(thickness);
  if (!(thickness > margin * 2)) return null;
  return {
    min: bounds.min + margin,
    max: bounds.max - margin,
    mid: (bounds.min + bounds.max) / 2,
  };
}

export function splitPlaneInside(z: number, range: SplitPlaneRange | null): boolean {
  if (!range || !Number.isFinite(z)) return false;
  return z >= range.min - 1e-6 && z <= range.max + 1e-6;
}

export function formatMm(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const rounded = Math.round(value * 100) / 100;
  return String(rounded);
}
