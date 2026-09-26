/** Ribbon meshes for the 3D preview. Built off the main thread. */

import type { PathColumns } from "./preview-wire";

export interface GeomPath {
  kind: string;
  pts: [number, number][];
  zs?: number[];
  width?: number;
  /** Vertical bead size. Falls back to the layer height. */
  beadHeight?: number;
  speed?: number;
  effectiveSpeed?: number;
  toughness?: number;
}

export interface GeomLayer {
  z: number;
  /** Layer height in millimetres. Beads extrude down by this much. */
  height?: number;
  paths: GeomPath[];
}

export interface GeomRequest {
  id: number;
  layers: GeomLayer[];
  min: number[];
  max: number[];
}

/** One preview layer as the engine sends it: paths in columns, not one object per point. */
export interface WireLayer {
  z: number;
  height?: number;
  paths: PathColumns;
}

export interface LayerRange {
  ribbonStart: number;
  ribbonCount: number;
  faceStart: number;
  faceCount: number;
  travelStart: number;
  travelCount: number;
}

/** Fraction of bead half-width kept as the bright face. The rest is the dark margin. */
export const INNER_HALF_SCALE = 0.78;
export const MARGIN_SHADE = 0.38;

/** Kind slots the preview shader can color and hide. Later kinds share the last slot. */
export const MAX_KINDS = 32;

/** Marks kind slots the preview should hide. One slot per kind name, so hiding thin wall leaves gap fill drawn. */
export function fillHiddenKindMask(mask: Float32Array, kinds: readonly string[], hidden: ReadonlySet<string>) {
  mask.fill(0);
  const n = Math.min(kinds.length, mask.length);
  for (let i = 0; i < n; i++) {
    if (hidden.has(kinds[i])) mask[i] = 1;
  }
}

/** Machine XY + nozzle Z → scene, matching the centered ribbon mesh (Y up). */
export function scenePoint(x: number, y: number, z: number, cx: number, cy: number): [number, number, number] {
  return [x - cx, z, -(y - cy)];
}

export function meshCenter(min: number[], max: number[]): { cx: number; cy: number } {
  return { cx: (min[0] + max[0]) / 2, cy: (min[1] + max[1]) / 2 };
}

/**
 * Positions plus one (kind slot, blend weight, speed) triple per vertex.
 * The shader turns the triple into a color, so color mode and hidden
 * kinds change without rebuilding.
 *
 * Each layer is written into its own span of these buffers, in layer index
 * order. Vertex order inside a layer stays path order.
 */
export interface PreviewGeometry {
  ranges: LayerRange[];
  /** Kind name per slot in the info triples. */
  kinds: string[];
  /** Full-width dark margin under each bead. */
  ribbon: Float32Array;
  ribbonInfo: Float32Array;
  /** Narrower bright face. Drawn with a polygon offset so it stays on the margin. */
  face: Float32Array;
  faceInfo: Float32Array;
  travel: Float32Array;
  travelInfo: Float32Array;
}

/** Floats for one extrusion segment: four margin quads and one face quad, six verts each. */
const RIBBON_FLOATS = 72;
const FACE_FLOATS = 18;
const TRAVEL_FLOATS = 6;

interface LayerPlan {
  slots: Int16Array;
  ribbonFloats: number;
  faceFloats: number;
  travelFloats: number;
}

interface MeshSpans {
  ribbon: Float32Array;
  ribbonInfo: Float32Array;
  face: Float32Array;
  faceInfo: Float32Array;
  travel: Float32Array;
  travelInfo: Float32Array;
}

export function buildPreviewGeometry(msg: Omit<GeomRequest, "id">): PreviewGeometry {
  const { kinds, plans } = planObjectLayers(msg.layers);
  const center = meshCenter(msg.min, msg.max);
  return assemble(plans, kinds, (layerIndex, spans, cur) => {
    writeObjectLayer(msg.layers[layerIndex], plans[layerIndex], spans, cur, center);
  });
}

/** Columnar layers, skipping the per-point objects `decodePaths` would allocate. */
export function buildWirePreview(msg: { layers: WireLayer[]; min: number[]; max: number[] }): PreviewGeometry {
  const { kinds, plans } = planWireLayers(msg.layers);
  const center = meshCenter(msg.min, msg.max);
  return assemble(plans, kinds, (layerIndex, spans, cur) => {
    writeWireLayer(msg.layers[layerIndex], plans[layerIndex], spans, cur, center);
  });
}

function assemble(plans: LayerPlan[], kinds: string[], write: (layerIndex: number, spans: MeshSpans, cur: Cursor) => void): PreviewGeometry {
  let ribbonFloats = 0;
  let faceFloats = 0;
  let travelFloats = 0;
  for (const plan of plans) {
    ribbonFloats += plan.ribbonFloats;
    faceFloats += plan.faceFloats;
    travelFloats += plan.travelFloats;
  }
  const ribbon = new Float32Array(ribbonFloats);
  const ribbonInfo = new Float32Array(ribbonFloats);
  const face = new Float32Array(faceFloats);
  const faceInfo = new Float32Array(faceFloats);
  const travel = new Float32Array(travelFloats);
  const travelInfo = new Float32Array(travelFloats);
  const spans: MeshSpans = { ribbon, ribbonInfo, face, faceInfo, travel, travelInfo };
  const cur: Cursor = { ribbon: 0, ribbonInfo: 0, face: 0, faceInfo: 0, travel: 0, travelInfo: 0 };
  const ranges: LayerRange[] = [];
  for (let i = 0; i < plans.length; i++) {
    const ribbonStart = cur.ribbon / 3;
    const faceStart = cur.face / 3;
    const travelStart = cur.travel / 3;
    // Layers write one after another into the same buffers. That placement
    // is the concatenation, in layer index order, with no second copy.
    write(i, spans, cur);
    ranges.push({
      ribbonStart,
      ribbonCount: cur.ribbon / 3 - ribbonStart,
      faceStart,
      faceCount: cur.face / 3 - faceStart,
      travelStart,
      travelCount: cur.travel / 3 - travelStart,
    });
  }
  return { ranges, kinds, ribbon, ribbonInfo, face, faceInfo, travel, travelInfo };
}

function assignSlot(kinds: string[], kind: string): number {
  let i = kinds.indexOf(kind);
  if (i < 0 && kinds.length < MAX_KINDS) i = kinds.push(kind) - 1;
  return i < 0 ? MAX_KINDS - 1 : i;
}

function planObjectLayers(layers: GeomLayer[]): { kinds: string[]; plans: LayerPlan[] } {
  const kinds: string[] = [];
  const plans = layers.map((layer) => planLayer(kinds, layer.paths.length, (i) => {
    const path = layer.paths[i];
    const points = path.pts.length;
    return points < 2 ? null : { name: path.kind, segs: points - 1, travel: path.kind === "travel" };
  }));
  return { kinds, plans };
}

function planWireLayers(layers: WireLayer[]): { kinds: string[]; plans: LayerPlan[] } {
  const kinds: string[] = [];
  const plans = layers.map((layer) => {
    const cols = layer.paths;
    return planLayer(kinds, cols.kind.length, (i) => {
      const points = cols.start[i + 1] - cols.start[i];
      if (points < 2) return null;
      const name = cols.kinds[cols.kind[i]] ?? "";
      return { name, segs: points - 1, travel: name === "travel" };
    });
  });
  return { kinds, plans };
}

function planLayer(kinds: string[], pathCount: number, at: (i: number) => { name: string; segs: number; travel: boolean } | null): LayerPlan {
  const slots = new Int16Array(pathCount);
  let ribbonFloats = 0;
  let faceFloats = 0;
  let travelFloats = 0;
  for (let i = 0; i < pathCount; i++) {
    const path = at(i);
    if (!path) {
      slots[i] = -1;
      continue;
    }
    slots[i] = assignSlot(kinds, path.name);
    if (path.travel) travelFloats += path.segs * TRAVEL_FLOATS;
    else {
      ribbonFloats += path.segs * RIBBON_FLOATS;
      faceFloats += path.segs * FACE_FLOATS;
    }
  }
  return { slots, ribbonFloats, faceFloats, travelFloats };
}

function writeObjectLayer(layer: GeomLayer, plan: LayerPlan, spans: MeshSpans, cur: Cursor, center: { cx: number; cy: number }) {
  const slots = plan.slots;
  // Keep machine coordinates as JS numbers until the Float32 store, matching the old mesh.
  let scratch: number[] = [];
  for (let i = 0; i < layer.paths.length; i++) {
    if (slots[i] < 0) continue;
    const path = layer.paths[i];
    const n = path.pts.length;
    if (scratch.length < n * 2) scratch = new Array(n * 2);
    for (let p = 0; p < n; p++) {
      scratch[p * 2] = path.pts[p][0];
      scratch[p * 2 + 1] = path.pts[p][1];
    }
    const zs = path.zs && path.zs.length === n ? path.zs : null;
    writePath(spans, cur, scratch, 0, n, zs, 0, layer.z, path.kind === "travel", halfWidth(path.width), beadHeight(path.beadHeight, layer.height), slots[i], path.toughness ?? 0, path.effectiveSpeed ?? path.speed ?? 0, center.cx, center.cy);
  }
}

function writeWireLayer(layer: WireLayer, plan: LayerPlan, spans: MeshSpans, cur: Cursor, center: { cx: number; cy: number }) {
  const cols = layer.paths;
  const slots = plan.slots;
  for (let i = 0; i < cols.kind.length; i++) {
    if (slots[i] < 0) continue;
    const a = cols.start[i];
    const b = cols.start[i + 1];
    const name = cols.kinds[cols.kind[i]] ?? "";
    const useZ = cols.z.length >= b;
    writePath(spans, cur, cols.xy, a, b - a, useZ ? cols.z : null, a, layer.z, name === "travel", halfWidth(cols.width[i]), beadHeight(cols.beadHeight[i], layer.height), slots[i], cols.toughness[i] ?? 0, cols.effectiveSpeed[i] ?? cols.speed[i] ?? 0, center.cx, center.cy);
  }
}

function halfWidth(width: number | undefined): number {
  return Math.max(0.05, (width ?? 0.45) / 2);
}

function beadHeight(bead: number | undefined, layerH: number | undefined): number {
  const picked = bead && bead > 1e-6 ? bead : layerH;
  const height = picked && picked > 1e-6 ? picked : 0.2;
  return Math.max(0.04, height);
}

interface Cursor {
  ribbon: number;
  ribbonInfo: number;
  face: number;
  faceInfo: number;
  travel: number;
  travelInfo: number;
}

function writePath(
  spans: MeshSpans,
  cur: Cursor,
  xy: ArrayLike<number>,
  base: number,
  n: number,
  z: ArrayLike<number | null> | null,
  zBase: number,
  layerZ: number,
  travel: boolean,
  half: number,
  height: number,
  slot: number,
  tough: number,
  speed: number,
  cx: number,
  cy: number,
) {
  if (travel) writeTravelPath(spans, cur, xy, base, n, z, zBase, layerZ, slot, tough, speed, cx, cy);
  else writeBeadPath(spans, cur, xy, base, n, z, zBase, layerZ, half, height, slot, tough, speed, cx, cy);
}

function writeTravelPath(
  spans: MeshSpans,
  cur: Cursor,
  xy: ArrayLike<number>,
  base: number,
  n: number,
  z: ArrayLike<number | null> | null,
  zBase: number,
  layerZ: number,
  slot: number,
  tough: number,
  speed: number,
  cx: number,
  cy: number,
) {
  const tp = spans.travel;
  const ti = spans.travelInfo;
  let o = cur.travel;
  let io = cur.travelInfo;
  for (let i = 1; i < n; i++) {
    const p0 = base + i - 1;
    const p1 = base + i;
    const z0 = z ? (z[zBase + i - 1] ?? layerZ) : layerZ;
    const z1 = z ? (z[zBase + i] ?? layerZ) : layerZ;
    tp[o++] = xy[p0 * 2] - cx;
    tp[o++] = z0;
    tp[o++] = -(xy[p0 * 2 + 1] - cy);
    tp[o++] = xy[p1 * 2] - cx;
    tp[o++] = z1;
    tp[o++] = -(xy[p1 * 2 + 1] - cy);
    ti[io++] = slot;
    ti[io++] = tough;
    ti[io++] = speed;
    ti[io++] = slot;
    ti[io++] = tough;
    ti[io++] = speed;
  }
  cur.travel = o;
  cur.travelInfo = io;
}

function writeBeadPath(
  spans: MeshSpans,
  cur: Cursor,
  xy: ArrayLike<number>,
  base: number,
  n: number,
  z: ArrayLike<number | null> | null,
  zBase: number,
  layerZ: number,
  half: number,
  height: number,
  slot: number,
  tough: number,
  speed: number,
  cx: number,
  cy: number,
) {
  const rp = spans.ribbon;
  const ri = spans.ribbonInfo;
  const fp = spans.face;
  const fi = spans.faceInfo;
  const h = height;
  const inner = half * INNER_HALF_SCALE;
  let o = cur.ribbon;
  let io = cur.ribbonInfo;
  let fo = cur.face;
  let fio = cur.faceInfo;
  for (let i = 1; i < n; i++) {
    const p0 = base + i - 1;
    const p1 = base + i;
    const x0 = xy[p0 * 2];
    const y0 = xy[p0 * 2 + 1];
    const x1 = xy[p1 * 2];
    const y1 = xy[p1 * 2 + 1];
    const z0 = z ? (z[zBase + i - 1] ?? layerZ) : layerZ;
    const z1 = z ? (z[zBase + i] ?? layerZ) : layerZ;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    const inv = 1 / len;
    const px = -dy * inv * half;
    const py = dx * inv * half;
    const ix = -dy * inv * inner;
    const iy = dx * inv * inner;
    const z0b = z0 - h;
    const z1b = z1 - h;
    const ax = x0 + px - cx;
    const az = -((y0 + py) - cy);
    const bx = x0 - px - cx;
    const bz = -((y0 - py) - cy);
    const cx1 = x1 - px - cx;
    const cz = -((y1 - py) - cy);
    const dx1 = x1 + px - cx;
    const dz = -((y1 + py) - cy);
    const fax = x0 + ix - cx;
    const faz = -((y0 + iy) - cy);
    const fbx = x0 - ix - cx;
    const fbz = -((y0 - iy) - cy);
    const fcx = x1 - ix - cx;
    const fcz = -((y1 - iy) - cy);
    const fdx = x1 + ix - cx;
    const fdz = -((y1 + iy) - cy);

    rp[o++] = ax; rp[o++] = z0; rp[o++] = az;
    rp[o++] = bx; rp[o++] = z0; rp[o++] = bz;
    rp[o++] = dx1; rp[o++] = z1; rp[o++] = dz;
    rp[o++] = bx; rp[o++] = z0; rp[o++] = bz;
    rp[o++] = cx1; rp[o++] = z1; rp[o++] = cz;
    rp[o++] = dx1; rp[o++] = z1; rp[o++] = dz;

    rp[o++] = ax; rp[o++] = z0b; rp[o++] = az;
    rp[o++] = dx1; rp[o++] = z1b; rp[o++] = dz;
    rp[o++] = bx; rp[o++] = z0b; rp[o++] = bz;
    rp[o++] = dx1; rp[o++] = z1b; rp[o++] = dz;
    rp[o++] = cx1; rp[o++] = z1b; rp[o++] = cz;
    rp[o++] = bx; rp[o++] = z0b; rp[o++] = bz;

    rp[o++] = ax; rp[o++] = z0; rp[o++] = az;
    rp[o++] = ax; rp[o++] = z0b; rp[o++] = az;
    rp[o++] = dx1; rp[o++] = z1; rp[o++] = dz;
    rp[o++] = ax; rp[o++] = z0b; rp[o++] = az;
    rp[o++] = dx1; rp[o++] = z1b; rp[o++] = dz;
    rp[o++] = dx1; rp[o++] = z1; rp[o++] = dz;

    rp[o++] = bx; rp[o++] = z0; rp[o++] = bz;
    rp[o++] = cx1; rp[o++] = z1; rp[o++] = cz;
    rp[o++] = bx; rp[o++] = z0b; rp[o++] = bz;
    rp[o++] = cx1; rp[o++] = z1; rp[o++] = cz;
    rp[o++] = cx1; rp[o++] = z1b; rp[o++] = cz;
    rp[o++] = bx; rp[o++] = z0b; rp[o++] = bz;

    fp[fo++] = fax; fp[fo++] = z0; fp[fo++] = faz;
    fp[fo++] = fbx; fp[fo++] = z0; fp[fo++] = fbz;
    fp[fo++] = fdx; fp[fo++] = z1; fp[fo++] = fdz;
    fp[fo++] = fbx; fp[fo++] = z0; fp[fo++] = fbz;
    fp[fo++] = fcx; fp[fo++] = z1; fp[fo++] = fcz;
    fp[fo++] = fdx; fp[fo++] = z1; fp[fo++] = fdz;

    for (let v = 0; v < 24; v++) {
      ri[io++] = slot;
      ri[io++] = tough;
      ri[io++] = speed;
    }
    for (let v = 0; v < 6; v++) {
      fi[fio++] = slot;
      fi[fio++] = tough;
      fi[fio++] = speed;
    }
  }
  cur.ribbon = o;
  cur.ribbonInfo = io;
  cur.face = fo;
  cur.faceInfo = fio;
}
