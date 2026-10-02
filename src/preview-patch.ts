/**
 * Partial previews. After a support edit the engine can send only the layers
 * that changed (`previewPatch`), each as references to paths the shown layer
 * already has plus the paths it lacks. These functions rebuild the full
 * layer list and the full preview buffers from what is already shown, so a
 * click copies the unchanged geometry instead of building it again.
 */

import type { LayerRange, PreviewGeometry } from "./preview-geom";
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

/** Floats per segment, as `preview-geom` writes them. */
const RIBBON = 72;
const FACE = 18;
const TRAVEL = 6;

/** Where each path of a layer starts in each buffer, relative to the layer, plus the layer's totals at the end. */
interface PathSpans {
  ribbon: Int32Array;
  face: Int32Array;
  travel: Int32Array;
}

function pathSpans(cols: PathColumns): PathSpans {
  const n = cols.kind.length;
  const spans = { ribbon: new Int32Array(n + 1), face: new Int32Array(n + 1), travel: new Int32Array(n + 1) };
  let r = 0;
  let f = 0;
  let t = 0;
  for (let i = 0; i < n; i++) {
    spans.ribbon[i] = r;
    spans.face[i] = f;
    spans.travel[i] = t;
    const segs = cols.start[i + 1] - cols.start[i] - 1;
    if (segs < 1) continue;
    if (cols.kinds[cols.kind[i]] === "travel") t += segs * TRAVEL;
    else {
      r += segs * RIBBON;
      f += segs * FACE;
    }
  }
  spans.ribbon[n] = r;
  spans.face[n] = f;
  spans.travel[n] = t;
  return spans;
}

/** One source of copied floats: a buffer set and where a layer starts in it. */
interface Source {
  geom: PreviewGeometry;
  range: LayerRange;
  spans: PathSpans;
}

/**
 * The full preview buffers of the patched preview. `old` and `oldLayers` are
 * what is shown, `fresh` is `buildWirePreview` of the patch's own paths, one
 * layer per `patch.changed` and seeded with `old.kinds` so their kind slots
 * agree. Unchanged layers copy whole; a changed layer copies each path from
 * whichever buffer holds it.
 */
export function patchGeometry(old: PreviewGeometry, oldLayers: readonly HeldLayer[], patch: PreviewPatch, fresh: PreviewGeometry): PreviewGeometry {
  const oldAt = new Map(oldLayers.map((l, i) => [l.index, i]));
  const changedAt = new Map(patch.changed.map((l, i) => [l.index, i]));
  type Part = { src: Source; ribbon: number; face: number; travel: number; rn: number; fn: number; tn: number };
  const layers: Part[][] = [];
  const sources = new Map<number, Source>();
  const oldSource = (i: number) => {
    let src = sources.get(i);
    if (!src) {
      src = { geom: old, range: old.ranges[i], spans: pathSpans(oldLayers[i].paths) };
      sources.set(i, src);
    }
    return src;
  };
  const totals = { ribbon: 0, face: 0, travel: 0 };
  for (const index of patch.layers) {
    const c = changedAt.get(index);
    const parts: Part[] = [];
    if (c == null) {
      const r = old.ranges[oldAt.get(index)!];
      const src: Source = { geom: old, range: r, spans: { ribbon: new Int32Array(0), face: new Int32Array(0), travel: new Int32Array(0) } };
      parts.push({ src, ribbon: 0, face: 0, travel: 0, rn: r.ribbonCount * 3, fn: r.faceCount * 3, tn: r.travelCount * 3 });
    } else {
      const layer = patch.changed[c];
      const lit: Source = { geom: fresh, range: fresh.ranges[c], spans: pathSpans(layer.paths) };
      const was = oldAt.get(index);
      for (const ref of layer.order) {
        const src = ref >= 0 ? oldSource(was!) : lit;
        const k = ref >= 0 ? ref : -1 - ref;
        const s = src.spans;
        const part = { src, ribbon: s.ribbon[k], face: s.face[k], travel: s.travel[k], rn: s.ribbon[k + 1] - s.ribbon[k], fn: s.face[k + 1] - s.face[k], tn: s.travel[k + 1] - s.travel[k] };
        const last = parts[parts.length - 1];
        if (last && last.src === src && last.ribbon + last.rn === part.ribbon && last.face + last.fn === part.face && last.travel + last.tn === part.travel) {
          last.rn += part.rn;
          last.fn += part.fn;
          last.tn += part.tn;
        } else parts.push(part);
      }
    }
    layers.push(parts);
    for (const p of parts) {
      totals.ribbon += p.rn;
      totals.face += p.fn;
      totals.travel += p.tn;
    }
  }
  const out: PreviewGeometry = {
    ranges: [],
    kinds: fresh.kinds,
    ribbon: new Float32Array(totals.ribbon),
    ribbonInfo: new Float32Array(totals.ribbon),
    face: new Float32Array(totals.face),
    faceInfo: new Float32Array(totals.face),
    travel: new Float32Array(totals.travel),
    travelInfo: new Float32Array(totals.travel),
  };
  const at = { ribbon: 0, face: 0, travel: 0 };
  for (const parts of layers) {
    const start = { ...at };
    for (const p of parts) {
      const g = p.src.geom;
      const r0 = p.src.range.ribbonStart * 3 + p.ribbon;
      const f0 = p.src.range.faceStart * 3 + p.face;
      const t0 = p.src.range.travelStart * 3 + p.travel;
      out.ribbon.set(g.ribbon.subarray(r0, r0 + p.rn), at.ribbon);
      out.ribbonInfo.set(g.ribbonInfo.subarray(r0, r0 + p.rn), at.ribbon);
      out.face.set(g.face.subarray(f0, f0 + p.fn), at.face);
      out.faceInfo.set(g.faceInfo.subarray(f0, f0 + p.fn), at.face);
      out.travel.set(g.travel.subarray(t0, t0 + p.tn), at.travel);
      out.travelInfo.set(g.travelInfo.subarray(t0, t0 + p.tn), at.travel);
      at.ribbon += p.rn;
      at.face += p.fn;
      at.travel += p.tn;
    }
    out.ranges.push({
      ribbonStart: start.ribbon / 3,
      ribbonCount: (at.ribbon - start.ribbon) / 3,
      faceStart: start.face / 3,
      faceCount: (at.face - start.face) / 3,
      travelStart: start.travel / 3,
      travelCount: (at.travel - start.travel) / 3,
    });
  }
  return out;
}
