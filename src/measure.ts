/**
 * Size indications over the viewports: dimension callouts on the part's box, a scale bar, and numbers at the
 * bed's 50 mm lines. This file is the pure part: what to show and where, from a camera position and a box.
 * `measure-overlay.ts` draws it.
 *
 * Everything here is in print millimetres, Z up, unless it says pixels.
 */

export type Vec3 = readonly [number, number, number];

export interface Box {
  min: Vec3;
  max: Vec3;
}

export type MeasureAxis = "x" | "y" | "z";

/** One extent of the part's box, as the box edge its line runs along. */
export interface DimEdge {
  axis: MeasureAxis;
  from: Vec3;
  to: Vec3;
}

/** Top-left rectangle in pixels. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The scale bar is picked to be about this long on screen. */
export const SCALE_BAR_MAX_PX = 140;
/** Bed numbers closer than this on screen thin out. */
export const MIN_TICK_GAP_PX = 40;
/** The bed's major grid lines. */
export const BED_MAJOR_MM = 50;

/** The extent as a callout reads it: one decimal, which is what the slicer resolves. */
export function formatMm(mm: number): string {
  const rounded = Math.round(Math.abs(mm) * 10) / 10;
  return `${rounded.toFixed(1)} mm`;
}

/** The largest 1, 2 or 5 times a power of ten that is at most `mm`. */
export function niceLengthMm(mm: number): number {
  if (!Number.isFinite(mm) || mm <= 0) return 1;
  const exponent = Math.floor(Math.log10(mm));
  const base = 10 ** exponent;
  const lead = mm / base;
  const step = lead >= 5 ? 5 : lead >= 2 ? 2 : 1;
  return Number((step * base).toPrecision(12));
}

export interface ScaleBar {
  mm: number;
  /** Drawn length, 56 to 140 px: 1, 2, 5 steps are up to 2.5 apart. */
  px: number;
  label: string;
}

/** The longest nice length that fits `maxPx`, for a view where one pixel spans `mmPerPx`. */
export function scaleBar(mmPerPx: number, maxPx = SCALE_BAR_MAX_PX): ScaleBar | null {
  if (!Number.isFinite(mmPerPx) || mmPerPx <= 0) return null;
  const mm = niceLengthMm(mmPerPx * maxPx);
  return { mm, px: mm / mmPerPx, label: mm >= 1000 ? `${mm / 1000} m` : `${mm} mm` };
}

/**
 * The three edges that carry the part's callouts, picked from where the camera is. Each runs along the box's
 * outline as seen from there, so a line never crosses the part: the two ground-level edges that meet at the
 * corner nearest the camera (the ceiling's when the camera is below the middle), and the vertical edge at the
 * end of one of them that is on the camera's right.
 */
export function chooseEdges(cam: Vec3, box: Box): DimEdge[] {
  const [x0, y0, z0] = box.min;
  const [x1, y1, z1] = box.max;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const z = cam[2] >= (z0 + z1) / 2 ? z0 : z1;
  const nearX = cam[0] >= cx ? x1 : x0;
  const nearY = cam[1] >= cy ? y1 : y0;
  const farX = nearX === x1 ? x0 : x1;
  const farY = nearY === y1 ? y0 : y1;
  // Right of the view direction d = (cx - cam.x, cy - cam.y) with Z up is (d.y, -d.x).
  const rightX = cy - cam[1];
  const rightY = -(cx - cam[0]);
  const side = (px: number, py: number) => (px - cx) * rightX + (py - cy) * rightY;
  const endOfX: [number, number] = [farX, nearY];
  const endOfY: [number, number] = [nearX, farY];
  const [zx, zy] = side(...endOfY) > side(...endOfX) ? endOfY : endOfX;
  return [
    { axis: "x", from: [x0, nearY, z], to: [x1, nearY, z] },
    { axis: "y", from: [nearX, y0, z], to: [nearX, y1, z] },
    { axis: "z", from: [zx, zy, z0], to: [zx, zy, z1] },
  ];
}

/** The 2D layer view looks straight down with +Y up the screen: X under the box, Y along its left side. */
export function flatEdges(box: Box): DimEdge[] {
  const [x0, y0, z] = box.min;
  const [x1, y1] = box.max;
  return [
    { axis: "x", from: [x0, y0, z], to: [x1, y0, z] },
    { axis: "y", from: [x0, y0, z], to: [x0, y1, z] },
  ];
}

export function overlaps(a: Rect, b: Rect, pad = 0): boolean {
  return a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
}

export function within(r: Rect, width: number, height: number, margin = 0): boolean {
  return r.x >= margin && r.y >= margin && r.x + r.w <= width - margin && r.y + r.h <= height - margin;
}

/**
 * The labels that stay, in the order given: one is dropped when it leaves the viewport or overlaps a rectangle
 * already `taken` or an earlier label that stayed. The order is the priority.
 */
export function cullLabels<T extends Rect>(items: readonly T[], width: number, height: number, taken: readonly Rect[] = [], pad = 2): T[] {
  const kept: T[] = [];
  for (const item of items) {
    if (!within(item, width, height, 2)) continue;
    if (taken.some((rect) => overlaps(item, rect, pad)) || kept.some((rect) => overlaps(item, rect, pad))) continue;
    kept.push(item);
  }
  return kept;
}

/** The points that stay, in the order given: one is dropped when it is nearer than `minGap` to a point that stayed. */
export function cullByDistance<T extends { x: number; y: number }>(items: readonly T[], minGap: number): T[] {
  const kept: T[] = [];
  for (const item of items) {
    if (kept.every((other) => Math.hypot(item.x - other.x, item.y - other.y) >= minGap)) kept.push(item);
  }
  return kept;
}

/** Multiples of `step` inside 0..`extent`, the ends included, 0 left out because the corner already says it. */
export function majorTicks(extent: number, step = BED_MAJOR_MM): number[] {
  const out: number[] = [];
  for (let v = step; v <= extent + 1e-6; v += step) out.push(v);
  return out;
}

/** Round numbers first, so 100 and 200 survive a crowd that drops 50 and 150. */
export function tickPriority(mm: number): number {
  return mm % 200 === 0 ? 0 : mm % 100 === 0 ? 1 : 2;
}

/** A bed corner, `nearX` and `nearY` naming the sides the camera is over. */
export interface BedEdges {
  /** Y of the edge the X numbers sit along, the front. */
  frontY: number;
  /** X of the edge the Y numbers sit along, the near side. */
  sideX: number;
  /** Which way is out of the bed on each, +1 or -1. */
  outY: 1 | -1;
  outX: 1 | -1;
}

export interface BedRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The two bed edges nearest the camera. Their numbers sit outside the bed, where nothing else is drawn. */
export function nearBedEdges(cam: Vec3, bed: BedRect): BedEdges {
  const nearY = cam[1] >= (bed.y0 + bed.y1) / 2;
  const nearX = cam[0] >= (bed.x0 + bed.x1) / 2;
  return {
    frontY: nearY ? bed.y1 : bed.y0,
    sideX: nearX ? bed.x1 : bed.x0,
    outY: nearY ? 1 : -1,
    outX: nearX ? 1 : -1,
  };
}

/** The union of boxes, or null for none. */
export function unionBox(boxes: readonly Box[]): Box | null {
  if (boxes.length === 0) return null;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const box of boxes) {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i]!, box.min[i]!);
      max[i] = Math.max(max[i]!, box.max[i]!);
    }
  }
  return { min, max };
}

/**
 * Where a label of `w` x `h` sits beside the point `at`, pushed `gap` px out along the unit vector `dir`
 * so that its nearest edge, not its centre, is `gap` from the point. Returns the top-left corner.
 */
export function labelBeside(at: readonly [number, number], dir: readonly [number, number], w: number, h: number, gap: number): Rect {
  const reach = gap + Math.abs(dir[0]) * (w / 2) + Math.abs(dir[1]) * (h / 2);
  return { x: at[0] + dir[0] * reach - w / 2, y: at[1] + dir[1] * reach - h / 2, w, h };
}

export function sameBox(a: Box | null, b: Box | null): boolean {
  if (!a || !b) return a === b;
  return a.min.every((v, i) => v === b.min[i]) && a.max.every((v, i) => v === b.max[i]);
}
