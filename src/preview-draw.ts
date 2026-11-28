import { KIND_SHIFT, STYLE_WORDS, type PointRun } from "./preview-geom.ts";

/** Interior infill drawn only near the slider while the camera is moving. */
export const TOP_INFILL_LAYERS = 8;

/** Beads thinner than this on screen are drawn as lines. */
export const LINE_PX = 1.5;
/** Half-width of the band that keeps a chunk from flickering between boxes and lines. */
const LINE_HYST_PX = 0.35;

const INTERIOR_INFILL = new Set(["sparse", "infill", "solid"]);

export interface KindLayout {
  /** Kind slot in the preview's kind table. */
  slot: number;
  /** First point of each layer, then the point count. Absolute in the reordered run. */
  at: Int32Array;
}

export interface BeadLayout {
  xyz: Float32Array;
  style: Uint16Array;
  /** Kinds that have points, in slot order, so neighbours can share one draw. */
  layouts: KindLayout[];
  /** Most common full bead width, in millimetres. 0 when the run has no bead. */
  nominalWidth: number;
  /** Centre of the chunk's bead bounds, in the same space as `xyz`. */
  center: [number, number, number];
  radius: number;
}

export interface DrawSpan {
  /** First point of the instanced range. */
  from: number;
  /** Instances: one per point except the range's last, which only closes a segment. */
  count: number;
}

/**
 * Copies `run` so each kind's points are contiguous and, within a kind, layers stay in order.
 * A path's own point order is kept. The source arrays are not modified.
 */
export function layoutBeads(run: PointRun): BeadLayout {
  const layers = Math.max(0, run.at.length - 1);
  const counts: Int32Array[] = [];
  forEachPath(run, (layer, slot, start, end) => {
    let row = counts[slot];
    if (!row) {
      row = new Int32Array(layers + 1);
      counts[slot] = row;
    }
    row[layer + 1] += end - start;
  });
  const layouts: KindLayout[] = [];
  let total = 0;
  for (let slot = 0; slot < counts.length; slot++) {
    const row = counts[slot];
    if (!row) continue;
    for (let layer = 0; layer < layers; layer++) row[layer + 1] += row[layer];
    if (row[layers] === 0) continue;
    for (let i = 0; i <= layers; i++) row[i] += total;
    total = row[layers];
    layouts.push({ slot, at: row });
  }
  const xyz = new Float32Array(total * 3);
  const style = new Uint16Array(total * STYLE_WORDS);
  const cursor = new Int32Array(counts.length);
  for (const layout of layouts) cursor[layout.slot] = layout.at[0];
  const widths = new Map<number, number>();
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  forEachPath(run, (_layer, slot, start, end) => {
    const at = cursor[slot];
    cursor[slot] = at + (end - start);
    xyz.set(run.xyz.subarray(start * 3, end * 3), at * 3);
    style.set(run.style.subarray(start * STYLE_WORDS, end * STYLE_WORDS), at * STYLE_WORDS);
    for (let p = start; p < end; p++) {
      const o = p * 3;
      const x = run.xyz[o];
      const y = run.xyz[o + 1];
      const z = run.xyz[o + 2];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
      const words = p * STYLE_WORDS;
      if (run.style[words + 3] === 0) continue;
      const half = run.style[words + 2];
      widths.set(half, (widths.get(half) ?? 0) + 1);
    }
  });
  let nominal = 0;
  let best = 0;
  for (const [half, n] of widths) {
    if (n > best) {
      best = n;
      nominal = (half * 2) / 1000;
    }
  }
  const center: [number, number, number] = total > 0 ? [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2] : [0, 0, 0];
  const radius = total > 0 ? Math.hypot(maxX - center[0], maxY - center[1], maxZ - center[2]) : 0;
  return { xyz, style, layouts, nominalWidth: nominal, center, radius };
}

/**
 * Instanced ranges for layers `lo..hi`. A hidden kind is omitted. Adjacent visible kinds that share
 * a layer window become one range. `interiorFrom` is the first layer of sparse and internal infill
 * while the camera moves; null draws those kinds across the whole window. The shader mask still
 * covers a run that was not split.
 */
export function visibleSpans(
  layouts: readonly KindLayout[],
  kindNames: readonly string[],
  lo: number,
  hi: number,
  hidden: ReadonlySet<string>,
  interiorFrom: number | null,
): DrawSpan[] {
  if (layouts.length === 0 || lo > hi) return [];
  const layers = layouts[0].at.length - 1;
  const hiC = Math.min(hi, layers - 1);
  const loC = Math.max(0, lo);
  if (loC > hiC) return [];
  const spans: DrawSpan[] = [];
  let open: DrawSpan | null = null;
  let openEnd = -1;
  for (const layout of layouts) {
    const name = kindNames[layout.slot] ?? "";
    const interior = INTERIOR_INFILL.has(name);
    const spanLo = interior && interiorFrom != null ? Math.max(loC, interiorFrom) : loC;
    if (hidden.has(name) || spanLo > hiC) {
      open = null;
      continue;
    }
    const from = layout.at[spanLo];
    const end = layout.at[hiC + 1];
    const count = end - from - 1;
    if (count <= 0) {
      open = null;
      continue;
    }
    if (open && from === openEnd) {
      open.count = end - open.from - 1;
      openEnd = end;
    } else {
      open = { from, count };
      openEnd = end;
      spans.push(open);
    }
  }
  return spans;
}

/** Screen pixels a bead of `widthMm` covers at `distanceMm` from the camera. */
export function beadWidthPx(distanceMm: number, widthMm: number, viewHeightPx: number, fovDeg: number, zoom: number): number {
  const dist = Math.max(distanceMm, 1e-3);
  const pxPerMm = (viewHeightPx * Math.max(zoom, 1e-6)) / (2 * dist * Math.tan((fovDeg * Math.PI) / 360));
  return widthMm * pxPerMm;
}

/** `linesOn` is the chunk's current choice. The band around {@link LINE_PX} stops a one-frame flip. */
export function lineMode(linesOn: boolean, widthPx: number): boolean {
  return linesOn ? widthPx < LINE_PX + LINE_HYST_PX : widthPx < LINE_PX - LINE_HYST_PX;
}

function forEachPath(run: PointRun, visit: (layer: number, slot: number, start: number, end: number) => void) {
  const layers = Math.max(0, run.at.length - 1);
  const style = run.style;
  for (let layer = 0; layer < layers; layer++) {
    let i = run.at[layer];
    const end = run.at[layer + 1];
    while (i < end) {
      if (style[i * STYLE_WORDS + 3] === 0) {
        i += 1;
        continue;
      }
      const slot = Math.floor(style[i * STYLE_WORDS] / KIND_SHIFT);
      let j = i + 1;
      while (j < end && style[j * STYLE_WORDS + 3] !== 0) j += 1;
      if (j < end) j += 1;
      visit(layer, slot, i, j);
      i = j;
    }
  }
}
