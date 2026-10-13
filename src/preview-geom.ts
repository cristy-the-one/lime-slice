/** Compact point records for the 3D preview. Built off the main thread, expanded into beads by the shader. */

import type { PathColumns } from "./preview-wire";

/** One preview layer as the engine sends it: paths in columns, not one object per point. */
export interface WireLayer {
  index: number;
  z: number;
  height?: number;
  paths: PathColumns;
}

/** Fraction of bead half-width kept as the bright face. The rest is the dark margin. */
export const INNER_HALF_SCALE = 0.78;
export const MARGIN_SHADE = 0.6;
/** Set in a point's speed word on odd layers, so the shader can alternate their brightness. */
export const ODD_LAYER_BIT = 0x8000;

/** Kind slots the preview shader can color and hide. Later kinds share the last slot. */
export const MAX_KINDS = 32;

/**
 * Layers per chunk, by engine layer index. A patch re-uploads only the chunks
 * it touches, and every chunk costs a few draw calls per frame.
 */
export const CHUNK_LAYERS = 32;

/** u16 words per point in `PointRun.style`. */
export const STYLE_WORDS = 4;
/** Blend weight steps in the low bits of the first style word; the kind slot sits above them. */
export const WEIGHT_STEPS = 2047;
export const KIND_SHIFT = 2048;

/** Marks kind slots the preview should hide. One slot per kind name, so hiding thin wall leaves gap fill drawn. */
export function fillHiddenKindMask(mask: Float32Array, kinds: readonly string[], hidden: ReadonlySet<string>) {
  mask.fill(0);
  const n = Math.min(kinds.length, mask.length);
  for (let i = 0; i < n; i++) {
    if (hidden.has(kinds[i])) mask[i] = 1;
  }
}

/** Machine XY + nozzle Z → scene, matching the centered preview (Y up). */
export function scenePoint(x: number, y: number, z: number, cx: number, cy: number): [number, number, number] {
  return [x - cx, z, -(y - cy)];
}

export function meshCenter(min: number[], max: number[]): { cx: number; cy: number } {
  return { cx: (min[0] + max[0]) / 2, cy: (min[1] + max[1]) / 2 };
}

/**
 * Path points in print order. `xyz` is each point in scene space. `style` is
 * `STYLE_WORDS` u16 per point describing the segment that starts there:
 * `[kind slot * KIND_SHIFT + blend weight * WEIGHT_STEPS, speed * 10 + ODD_LAYER_BIT on odd layers, half width µm, bead height µm]`.
 * A path's last point has all zeros, so no segment joins it to the next path.
 */
export interface PointRun {
  xyz: Float32Array;
  style: Uint16Array;
  /** First point of each layer of the chunk, then the point count. */
  at: Int32Array;
}

/** Consecutive layers of one plate object sharing one set of GPU buffers, in that object's part frame. */
export interface PreviewChunk {
  /** Plate object index. Each object is drawn under its own offset. */
  object: number;
  /** Engine index of each layer, in order. */
  indices: number[];
  beads: PointRun;
  travel: PointRun;
}

/**
 * The 3D preview of a slice. Kind slots, blend weight, and speed go to the
 * shader as numbers, so color mode and hidden kinds change without a rebuild.
 */
export interface PreviewGeometry {
  /** Kind name per slot. */
  kinds: string[];
  chunks: PreviewChunk[];
}

export function chunkKey(index: number): number {
  return Math.floor(index / CHUNK_LAYERS);
}

/** Plate objects a preview's layers draw: one more than the highest object index, at least one. */
export function objectCount(layers: readonly WireLayer[]): number {
  let n = 1;
  for (const layer of layers) for (const o of layer.paths.object ?? []) n = Math.max(n, o + 1);
  return n;
}

/**
 * `kinds` seeds the kind slots, so the result can be spliced into geometry built with that table.
 * `objects` is the plate's object count; every object gets a chunk for every layer range, empty or not.
 *
 * Each path is counted once and copied once. Kind slots stay in the old order: every range of
 * object 0 before object 1, so an earlier object's later layer still claims a name first.
 */
export function buildWirePreview(msg: { layers: WireLayer[]; min: number[]; max: number[]; kinds?: readonly string[]; objects?: number }): PreviewGeometry {
  const kinds = [...(msg.kinds ?? [])];
  const { cx, cy } = meshCenter(msg.min, msg.max);
  const layers = msg.layers;
  const objects = Math.max(msg.objects ?? 1, objectCount(layers));
  const slots = objectSlots(objects);
  if (slots === 0) return { kinds, chunks: [] };
  const ranges: WireLayer[][] = [];
  for (let i = 0; i < layers.length;) {
    const key = chunkKey(layers[i].index);
    let j = i + 1;
    while (j < layers.length && chunkKey(layers[j].index) === key) j++;
    ranges.push(layers.slice(i, j));
    i = j;
  }
  const introduced: string[][] = Array.from({ length: slots }, () => []);
  const seen: Array<Set<string>> = Array.from({ length: slots }, () => new Set());
  const counted = ranges.map((range) => countLayerRange(range, objects, introduced, seen));
  for (const names of introduced) for (const name of names) assignSlot(kinds, name);
  const built = counted.map((range) => buildChunksForLayerRange(range, kinds, cx, cy));
  const chunks: PreviewChunk[] = [];
  for (let object = 0; object < slots; object++) for (const group of built) chunks.push(group[object]);
  return { kinds, chunks };
}

function assignSlot(kinds: string[], kind: string): number {
  let i = kinds.indexOf(kind);
  if (i < 0 && kinds.length < MAX_KINDS) i = kinds.push(kind) - 1;
  return i < 0 ? MAX_KINDS - 1 : i;
}

/** How many integer object slots `for (object = 0; object < objects; object++)` visits. */
function objectSlots(objects: number): number {
  return objects > 0 ? Math.ceil(objects) : 0;
}

/** Index the per-object scan would draw, or -1 when that path matched no slot. */
function objectSlot(raw: number | undefined, objects: number): number {
  const obj = raw ?? 0;
  if (obj < 0 || obj >= objects || !Number.isInteger(obj)) return -1;
  return obj;
}

interface RangeCounts {
  layers: WireLayer[];
  objects: number;
  travelSlot: Int32Array;
  beadAt: Int32Array[];
  travelAt: Int32Array[];
}

/** One pass over the range: point counts per object, and the kind names each object introduces. */
function countLayerRange(layers: WireLayer[], objects: number, introduced: string[][], seen: Array<Set<string>>): RangeCounts {
  const slots = introduced.length;
  const travelSlot = new Int32Array(layers.length);
  const beadAt = Array.from({ length: slots }, () => new Int32Array(layers.length + 1));
  const travelAt = Array.from({ length: slots }, () => new Int32Array(layers.length + 1));
  for (let l = 0; l < layers.length; l++) {
    const cols = layers[l].paths;
    travelSlot[l] = cols.kinds.indexOf("travel");
    for (let i = 0; i < cols.kind.length; i++) {
      const points = cols.start[i + 1] - cols.start[i];
      if (points < 2) continue;
      const object = objectSlot(cols.object?.[i], objects);
      if (object < 0) continue;
      const name = cols.kinds[cols.kind[i]];
      if (!seen[object].has(name)) {
        seen[object].add(name);
        introduced[object].push(name);
      }
      if (cols.kind[i] === travelSlot[l]) travelAt[object][l + 1] += points;
      else beadAt[object][l + 1] += points;
    }
    for (let object = 0; object < slots; object++) {
      beadAt[object][l + 1] += beadAt[object][l];
      travelAt[object][l + 1] += travelAt[object][l];
    }
  }
  return { layers, objects, travelSlot, beadAt, travelAt };
}

/**
 * One pass over the range writes every object's chunk. Buffers are already sized, including
 * empty objects, and kind slots are already claimed in object order.
 */
function buildChunksForLayerRange(range: RangeCounts, kinds: string[], cx: number, cy: number): PreviewChunk[] {
  const { layers, objects, travelSlot, beadAt, travelAt } = range;
  const slots = beadAt.length;
  const chunks: PreviewChunk[] = new Array(slots);
  for (let object = 0; object < slots; object++) {
    chunks[object] = {
      object,
      indices: layers.map((layer) => layer.index),
      beads: emptyRun(beadAt[object]),
      travel: emptyRun(travelAt[object]),
    };
  }
  const beadCur = new Int32Array(slots);
  const travelCur = new Int32Array(slots);
  for (let l = 0; l < layers.length; l++) {
    const layer = layers[l];
    const cols = layer.paths;
    const slotOf = new Int16Array(cols.kinds.length).fill(-1);
    for (let object = 0; object < slots; object++) {
      beadCur[object] = beadAt[object][l];
      travelCur[object] = travelAt[object][l];
    }
    for (let i = 0; i < cols.kind.length; i++) {
      const start = cols.start[i];
      const end = cols.start[i + 1];
      if (end - start < 2) continue;
      const object = objectSlot(cols.object?.[i], objects);
      if (object < 0) continue;
      const isTravel = cols.kind[i] === travelSlot[l];
      const run = isTravel ? chunks[object].travel : chunks[object].beads;
      const at = isTravel ? travelCur[object] : beadCur[object];
      const z = cols.z.length >= end ? cols.z : null;
      for (let k = start; k < end; k++) {
        const o = (at + k - start) * 3;
        run.xyz[o] = cols.xy[2 * k] - cx;
        run.xyz[o + 1] = z ? (z[k] ?? layer.z) : layer.z;
        run.xyz[o + 2] = -(cols.xy[2 * k + 1] - cy);
      }
      if (slotOf[cols.kind[i]] < 0) slotOf[cols.kind[i]] = assignSlot(kinds, cols.kinds[cols.kind[i]]);
      const word = slotOf[cols.kind[i]] * KIND_SHIFT + Math.round(clamp01(cols.toughness[i] ?? 0) * WEIGHT_STEPS);
      const speed = Math.min(ODD_LAYER_BIT - 1, u16((cols.effectiveSpeed[i] ?? cols.speed[i] ?? 0) * 10)) | (layer.index & 1 ? ODD_LAYER_BIT : 0);
      const half = u16(halfWidth(cols.width[i]) * 1000);
      const height = u16(beadHeight(cols.beadHeight[i], layer.height) * 1000);
      for (let s = at * STYLE_WORDS, last = (at + end - start - 1) * STYLE_WORDS; s < last; s += STYLE_WORDS) {
        run.style[s] = word;
        run.style[s + 1] = speed;
        run.style[s + 2] = half;
        run.style[s + 3] = height;
      }
      if (isTravel) travelCur[object] = at + end - start;
      else beadCur[object] = at + end - start;
    }
  }
  return chunks;
}

function emptyRun(at: Int32Array): PointRun {
  const points = at[at.length - 1];
  return { xyz: new Float32Array(points * 3), style: new Uint16Array(points * STYLE_WORDS), at };
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const u16 = (v: number) => Math.min(65535, Math.max(0, Math.round(v)));

function halfWidth(width: number | undefined): number {
  return Math.max(0.05, (width ?? 0.45) / 2);
}

function beadHeight(bead: number | undefined, layerH: number | undefined): number {
  const picked = bead && bead > 1e-6 ? bead : layerH;
  const height = picked && picked > 1e-6 ? picked : 0.2;
  return Math.max(0.04, height);
}
