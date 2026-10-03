/**
 * Partial previews. After a support edit the engine can send only the layers
 * that changed (`previewPatch`), each as references to paths the shown layer
 * already has plus the paths it lacks. These functions rebuild the full
 * layer list and the preview from what is already shown, so a click copies
 * the unchanged geometry instead of building it again.
 */

import { chunkKey, STYLE_WORDS, type PointRun, type PreviewChunk, type PreviewGeometry } from "./preview-geom.ts";
import type { PathColumns } from "./preview-wire";

/** One changed layer. `paths` holds only the paths the base layer lacks. */
export interface PatchLayer {
  index: number;
  z: number;
  height: number;
  paths: PathColumns;
  /** The layer in print order: `k >= 0` is the base layer's path `k`, `-1 - j` is `paths` path `j`. */
  order: number[];
}

export interface PreviewPatch {
  /** The `previewToken` of the preview this patch applies to. */
  base: string;
  /** `index` of every layer of the patched preview, in order. A layer not in `changed` is the base's. */
  layers: number[];
  changed: PatchLayer[];
}

interface HeldLayer {
  index: number;
  paths: PathColumns;
}

/**
 * The patched layer list, or `null` when `held` is not the preview the patch
 * was made against: a layer or path it names is missing.
 */
export function patchLayers<L extends HeldLayer>(held: readonly L[], patch: PreviewPatch): L[] | null {
  const byIndex = new Map(held.map((l) => [l.index, l]));
  const changed = new Map(patch.changed.map((l) => [l.index, l]));
  const out: L[] = [];
  for (const index of patch.layers) {
    const fresh = changed.get(index);
    const was = byIndex.get(index);
    if (!fresh) {
      if (!was) return null;
      out.push(was);
      continue;
    }
    const paths = mergeColumns(was?.paths ?? null, fresh.paths, fresh.order);
    if (!paths) return null;
    const { order: _order, ...layer } = fresh;
    out.push({ ...(layer as unknown as L), paths });
  }
  return out;
}

function mergeColumns(was: PathColumns | null, fresh: PathColumns, order: readonly number[]): PathColumns | null {
  const kinds: string[] = [];
  const strategies: string[] = [];
  /** A source table's slot in the merged table, added on first use so unused names stay out. */
  const slotter = (names: string[], table: string[]) => {
    const map = new Array<number>(names.length).fill(-1);
    return (s: number) => {
      if (map[s] < 0) {
        const i = table.indexOf(names[s]);
        map[s] = i >= 0 ? i : table.push(names[s]) - 1;
      }
      return map[s];
    };
  };
  const srcs = [was, fresh].map((cols) =>
    cols ? { cols, kind: slotter(cols.kinds, kinds), strategy: slotter(cols.strategies, strategies) } : null,
  );
  const n = order.length;
  let points = 0;
  for (const ref of order) {
    const src = srcs[ref >= 0 ? 0 : 1];
    const i = ref >= 0 ? ref : -1 - ref;
    if (!src || i >= src.cols.kind.length) return null;
    points += src.cols.start[i + 1] - src.cols.start[i];
  }
  const withZ = (was?.z.length ?? 0) > 0 || fresh.z.length > 0;
  const out: PathColumns = {
    kinds,
    strategies,
    kind: new Array(n),
    strategy: new Array(n),
    width: new Array(n),
    speed: new Array(n),
    effectiveSpeed: new Array(n),
    toughness: new Array(n),
    beadHeight: new Array(n),
    start: new Array(n + 1),
    xy: new Array(points * 2),
    z: withZ ? new Array(points) : [],
  };
  out.start[0] = 0;
  let at = 0;
  for (let p = 0; p < n; p++) {
    const ref = order[p];
    const src = srcs[ref >= 0 ? 0 : 1]!;
    const cols = src.cols;
    const i = ref >= 0 ? ref : -1 - ref;
    out.kind[p] = src.kind(cols.kind[i]);
    out.strategy[p] = src.strategy(cols.strategy[i]);
    out.width[p] = cols.width[i];
    out.speed[p] = cols.speed[i];
    out.effectiveSpeed[p] = cols.effectiveSpeed[i];
    out.toughness[p] = cols.toughness[i];
    out.beadHeight[p] = cols.beadHeight[i];
    const a = cols.start[i];
    const b = cols.start[i + 1];
    const hasZ = cols.z.length > 0;
    for (let k = a; k < b; k++, at++) {
      out.xy[2 * at] = cols.xy[2 * k];
      out.xy[2 * at + 1] = cols.xy[2 * k + 1];
      if (withZ) out.z[at] = hasZ ? cols.z[k] : null;
    }
    out.start[p + 1] = at;
  }
  return out;
}

/** Where a layer's points sit: a chunk and the layer's position in it. */
interface LayerSource {
  chunk: PreviewChunk;
  k: number;
}

/**
 * The patched preview. `old` is what is shown; `fresh` is `buildWirePreview`
 * of the patched list's changed layers, seeded with `old.kinds` so their kind
 * slots agree. A chunk none of whose layers changed is `old`'s own object, so
 * its GPU buffers stay; any other chunk copies each layer from where it is.
 */
export function patchGeometry(old: PreviewGeometry, patch: PreviewPatch, fresh: PreviewGeometry): PreviewGeometry {
  const sources = new Map<number, LayerSource>();
  const index = (geom: PreviewGeometry) => {
    for (const chunk of geom.chunks) chunk.indices.forEach((i, k) => sources.set(i, { chunk, k }));
  };
  index(old);
  const oldChunks = new Map(old.chunks.map((chunk) => [chunkKey(chunk.indices[0]), chunk]));
  index(fresh);
  const changed = new Set(patch.changed.map((l) => l.index));
  const chunks: PreviewChunk[] = [];
  for (let i = 0; i < patch.layers.length;) {
    const key = chunkKey(patch.layers[i]);
    let j = i + 1;
    while (j < patch.layers.length && chunkKey(patch.layers[j]) === key) j++;
    const indices = patch.layers.slice(i, j);
    const was = oldChunks.get(key);
    const same = was && was.indices.length === indices.length && indices.every((n, k) => n === was.indices[k] && !changed.has(n));
    chunks.push(same ? was : joinLayers(indices.map((n) => sources.get(n)!), indices));
    i = j;
  }
  return { kinds: fresh.kinds, chunks };
}

function joinLayers(parts: LayerSource[], indices: number[]): PreviewChunk {
  const join = (run: (c: PreviewChunk) => PointRun): PointRun => {
    const at = new Int32Array(parts.length + 1);
    parts.forEach(({ chunk, k }, l) => {
      const src = run(chunk).at;
      at[l + 1] = at[l] + src[k + 1] - src[k];
    });
    const points = at[parts.length];
    const out: PointRun = { xyz: new Float32Array(points * 3), style: new Uint16Array(points * STYLE_WORDS), at };
    parts.forEach(({ chunk, k }, l) => {
      const src = run(chunk);
      out.xyz.set(src.xyz.subarray(src.at[k] * 3, src.at[k + 1] * 3), at[l] * 3);
      out.style.set(src.style.subarray(src.at[k] * STYLE_WORDS, src.at[k + 1] * STYLE_WORDS), at[l] * STYLE_WORDS);
    });
    return out;
  };
  return { indices, beads: join((c) => c.beads), travel: join((c) => c.travel) };
}
