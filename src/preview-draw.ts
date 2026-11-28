import type { ColorMode } from "./colors.ts";
import { readsStress } from "./colors.ts";
import { KIND_SHIFT, STYLE_WORDS, type PointRun } from "./preview-geom.ts";

/** Interior infill drawn only near the slider while the camera is moving. */
export const TOP_INFILL_LAYERS = 8;

/** Beads thinner than this on screen are drawn as lines. */
export const LINE_PX = 1.5;
/** Half-width of the band that keeps a chunk from flickering between boxes and lines. */
const LINE_HYST_PX = 0.35;

const INTERIOR_INFILL = new Set(["sparse", "infill", "solid"]);

/** The outside perimeter. `outer` when features have their own speeds, `wall` when they do not. */
const OUTER_WALL_KINDS = ["outer", "wall"];

/** A bead of one of these closes the part from the side. */
const WALL_KINDS = new Set(["outer", "inner", "wall", "thin-wall"]);

/**
 * Beads that belong to the part rather than a skirt, a support, or ironing.
 * Ironing sits on the top skin, so it does not move the part's top layer.
 */
const PART_KINDS = new Set([...WALL_KINDS, "sparse", "infill", "solid", "top", "gap-fill", "bridge"]);

/**
 * How far from the part's top or bottom a skin bead still counts as that shell.
 * Top skin is at most 1.2 mm and the thinnest layer is 0.05 mm, so 24 layers,
 * plus a couple for a bead that lands beside the skin. A `top` kind farther
 * in is a step or a floor, not the shell that closes this end.
 */
export const SHELL_BAND_LAYERS = 26;

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

/** Inclusive layer ranges of interior infill. Null draws those kinds across the whole `lo..hi` window. */
export type InteriorWindow = readonly (readonly [number, number])[] | null;

/**
 * Instanced ranges for layers `lo..hi`. A hidden kind is omitted. Adjacent visible kinds that share
 * a buffer range become one draw. `interior` limits sparse, infill, and solid to those layer ranges
 * (a moving frame passes the top band; a resting frame passes both ends). Null draws them across
 * the whole window. The shader mask still covers a run that was not split.
 */
export function visibleSpans(
  layouts: readonly KindLayout[],
  kindNames: readonly string[],
  lo: number,
  hi: number,
  hidden: ReadonlySet<string>,
  interior: InteriorWindow,
): DrawSpan[] {
  if (layouts.length === 0 || lo > hi) return [];
  const layers = layouts[0].at.length - 1;
  const hiC = Math.min(hi, layers - 1);
  const loC = Math.max(0, lo);
  if (loC > hiC) return [];
  const spans: DrawSpan[] = [];
  let open: DrawSpan | null = null;
  let openEnd = -1;
  const push = (from: number, end: number) => {
    const count = end - from - 1;
    if (count <= 0) {
      open = null;
      return;
    }
    if (open && from === openEnd) {
      open.count = end - open.from - 1;
      openEnd = end;
    } else {
      open = { from, count };
      openEnd = end;
      spans.push(open);
    }
  };
  for (const layout of layouts) {
    const name = kindNames[layout.slot] ?? "";
    if (hidden.has(name)) {
      open = null;
      continue;
    }
    const ranges = INTERIOR_INFILL.has(name) && interior != null ? mergedRanges(loC, hiC, interior) : [[loC, hiC] as [number, number]];
    if (ranges.length === 0) {
      open = null;
      continue;
    }
    for (const [start, end] of ranges) push(layout.at[start], layout.at[end + 1]);
  }
  return spans;
}

/** Clip `ranges` to `lo..hi` and join ones that touch or overlap. */
function mergedRanges(lo: number, hi: number, ranges: readonly (readonly [number, number])[]): [number, number][] {
  const clipped: [number, number][] = [];
  for (const [start, end] of ranges) {
    const from = Math.max(lo, Math.min(start, end));
    const to = Math.min(hi, Math.max(start, end));
    if (from <= to) clipped.push([from, to]);
  }
  clipped.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const range of clipped) {
    const prev = merged.length > 0 ? merged[merged.length - 1] : undefined;
    if (prev && range[0] <= prev[1] + 1) prev[1] = Math.max(prev[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

/**
 * While the camera moves, interior infill is the top band only (V1). At rest both ends of
 * `low..high` stay open, unless `reveal` asks for the whole interior.
 */
export function interiorWindow(moving: boolean, low: number, high: number, reveal: boolean): InteriorWindow {
  const reach = TOP_INFILL_LAYERS - 1;
  if (moving) return [[high - reach, high]];
  if (reveal) return null;
  return [[low, low + reach], [high - reach, high]];
}

export interface ShellFacts {
  /** Any perimeter bead: outer, inner, wall, or thin wall. */
  hasWalls: boolean;
  /** Kind `top` on the part's highest layers. */
  hasTopSkin: boolean;
  /** Kind `solid` (bottom skin, when features have their own speeds) on the lowest layers. */
  hasBottomSkin: boolean;
}

/** One layer of one object, and the kind names that have a bead on it. */
export interface LayerKinds {
  layer: number;
  kinds: ReadonlySet<string>;
}

/**
 * Whether this object's beads close the interior. Read from per-layer kind counts, not from
 * slice settings: skin depth is an engine constant (0.6 mm on speed, 1.2 mm on toughness) and
 * a modifier can change the walls in one region, so the beads are what the picture has.
 * Bottom skin is kind `solid` and top skin is kind `top` when features have their own speeds.
 * A slice that labels every bead `infill` has neither, and the caller draws the whole interior.
 */
export function shellFromLayerKinds(layers: readonly LayerKinds[]): ShellFacts {
  let hasWalls = false;
  let min = Infinity;
  let max = -Infinity;
  const topLayers: number[] = [];
  const solidLayers: number[] = [];
  for (const row of layers) {
    let part = false;
    for (const name of row.kinds) {
      if (WALL_KINDS.has(name)) hasWalls = true;
      if (PART_KINDS.has(name)) part = true;
      if (name === "top") topLayers.push(row.layer);
      if (name === "solid") solidLayers.push(row.layer);
    }
    if (!part) continue;
    if (row.layer < min) min = row.layer;
    if (row.layer > max) max = row.layer;
  }
  if (min === Infinity) return { hasWalls, hasTopSkin: false, hasBottomSkin: false };
  const nearTop = (layer: number) => layer <= max && layer >= max - (SHELL_BAND_LAYERS - 1);
  const nearBottom = (layer: number) => layer >= min && layer <= min + (SHELL_BAND_LAYERS - 1);
  return {
    hasWalls,
    hasTopSkin: topLayers.some(nearTop),
    hasBottomSkin: solidLayers.some(nearBottom) || topLayers.some(nearBottom),
  };
}

/** Kinds present on each layer of one chunk. `first` is that chunk's first layer in its object. */
export function layerKindsOf(first: number, layouts: readonly KindLayout[], kindNames: readonly string[]): LayerKinds[] {
  let layers = 0;
  for (const layout of layouts) layers = Math.max(layers, layout.at.length - 1);
  const out: LayerKinds[] = [];
  for (let layer = 0; layer < layers; layer++) {
    const kinds = new Set<string>();
    for (const layout of layouts) {
      if (layer + 1 >= layout.at.length) continue;
      if (layout.at[layer + 1] > layout.at[layer]) kinds.add(kindNames[layout.slot] ?? "");
    }
    if (kinds.size > 0) out.push({ layer: first + layer, kinds });
  }
  return out;
}

/** Every object that has beads is closed. An empty list is not. */
export function shellEnclosed(parts: readonly ShellFacts[]): boolean {
  return parts.length > 0 && parts.every((part) => part.hasWalls && part.hasTopSkin && part.hasBottomSkin);
}

/**
 * Draw every interior bead. The outside no longer hides it, or the colour is there to show
 * the inside. Weight and speed stay on the shell: they colour a bead by its flow or its feed,
 * and the walls already show that. Stress and safety colour the load through the volume.
 */
export function revealInterior(input: {
  hidden: ReadonlySet<string>;
  kindNames: readonly string[];
  section: boolean;
  cut: boolean;
  colorMode: ColorMode;
  enclosed: boolean;
}): boolean {
  if (input.section || input.cut) return true;
  if (readsStress(input.colorMode)) return true;
  if (OUTER_WALL_KINDS.some((kind) => input.hidden.has(kind) && input.kindNames.includes(kind))) return true;
  return !input.enclosed;
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
