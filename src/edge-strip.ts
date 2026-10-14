/**
 * Reinforce strips along a face edge: face regions of a triangle soup, their boundary loops,
 * and disk centres inset from a loop. Pure: no three.js, no DOM. Everything is in the
 * geometry frame of the positions it is given.
 */
import { faceNormal, tableSize, vertexIds } from "./mesh-edges.ts";
import { STROKE_STEP_R, type Vec3 } from "./support-paint.ts";

/** The Prepare outline's crease angle: faces that bend more than this are different regions. */
export const REGION_THRESHOLD_DEG = 25;
/** A loop vertex where the boundary turns more than this is a corner. */
export const CORNER_DEG = 10;

/** Face regions of a non-indexed triangle soup: triangles joined across shared edges that bend at most `thresholdDeg`. */
export interface FaceRegions {
  /** Welded vertex id per soup vertex, joined at 1e-4 mm as `sharpEdges` does. */
  ids: Int32Array;
  /** Per half-edge `t * 3 + j` (corner j to corner (j + 1) % 3 of triangle t): the opposite half-edge it pairs with, or -1. */
  twin: Int32Array;
  /** Region per triangle, numbered 0..count-1 in order of first triangle; -1 for a triangle whose welded corners coincide. */
  region: Int32Array;
  count: number;
}

export function labelFaceRegions(positions: Float32Array, thresholdDeg = REGION_THRESHOLD_DEG): FaceRegions {
  const thresholdDot = Math.cos((Math.PI / 180) * thresholdDeg);
  const verts = Math.floor(positions.length / 9) * 3;
  const tris = verts / 3;
  const ids = vertexIds(positions, verts);
  const twin = new Int32Array(verts).fill(-1);
  const normals = new Float32Array(verts);
  const parent = new Int32Array(tris);
  const region = new Int32Array(tris).fill(-1);

  const size = tableSize(verts);
  const mask = size - 1;
  const from = new Int32Array(size).fill(-1);
  const to = new Int32Array(size);
  const half = new Int32Array(size);
  const live = new Uint8Array(size);
  const find = (a: number, b: number) => {
    let slot = (Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca6b)) & mask;
    while (from[slot] !== -1 && (from[slot] !== a || to[slot] !== b)) slot = (slot + 1) & mask;
    return slot;
  };
  const root = (t: number) => {
    while (parent[t] !== t) {
      parent[t] = parent[parent[t]!]!;
      t = parent[t]!;
    }
    return t;
  };

  for (let t = 0; t < tris; t++) {
    parent[t] = t;
    const v = t * 3;
    const a = ids[v]!;
    const b = ids[v + 1]!;
    const c = ids[v + 2]!;
    if (a === b || b === c || c === a) continue;
    region[t] = 0;
    const [nx, ny, nz] = faceNormal(positions, v);
    normals[v] = nx;
    normals[v + 1] = ny;
    normals[v + 2] = nz;
    for (let j = 0; j < 3; j++) {
      const h = v + j;
      const v0 = ids[h]!;
      const v1 = ids[v + ((j + 1) % 3)]!;
      const reverse = find(v1, v0);
      if (from[reverse] !== -1 && live[reverse]) {
        const other = half[reverse]!;
        twin[h] = other;
        twin[other] = h;
        live[reverse] = 0;
        const o = other - (other % 3);
        if (nx * normals[o]! + ny * normals[o + 1]! + nz * normals[o + 2]! > thresholdDot) parent[root(t)] = root(o / 3);
        continue;
      }
      const slot = find(v0, v1);
      if (from[slot] !== -1) continue;
      from[slot] = v0;
      to[slot] = v1;
      half[slot] = h;
      live[slot] = 1;
    }
  }

  const label = new Int32Array(tris).fill(-1);
  let count = 0;
  for (let t = 0; t < tris; t++) {
    if (region[t] === -1) continue;
    const r = root(t);
    if (label[r] === -1) label[r] = count++;
    region[t] = label[r]!;
  }
  return { ids, twin, region, count };
}

/** One closed boundary of a region, in the geometry frame of `positions`. */
export interface EdgeLoop {
  /** Point i joins point (i + 1) % n. points[0] is a corner when the loop has one. */
  points: Vec3[];
  /** Per segment i: the unit normal of the region triangle that owns it (winding order, as `faceNormal`). */
  normals: Vec3[];
  /** Per segment i: the unit vector in that triangle's plane, perpendicular to the segment, pointing into the region. */
  inward: Vec3[];
  /** Point indices where the loop turns more than CORNER_DEG, ascending. */
  corners: number[];
}

const at = (p: Float32Array, v: number): Vec3 => [p[v * 3]!, p[v * 3 + 1]!, p[v * 3 + 2]!];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const length = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const distance = (a: Vec3, b: Vec3) => length(sub(a, b));
const unit = (a: Vec3): Vec3 => {
  const len = length(a);
  return len > 1e-12 ? scale(a, 1 / len) : [0, 0, 0];
};
const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export function boundaryLoops(positions: Float32Array, regions: FaceRegions, region: number): EdgeLoop[] {
  const { twin } = regions;
  const owned = (h: number) => regions.region[Math.floor(h / 3)] === region;
  const isBoundary = (h: number) => twin[h] === -1 || !owned(twin[h]!);
  const next = (h: number) => h - (h % 3) + ((h % 3) + 1) % 3;
  const nextAroundStart = (h: number) => next(twin[h]!);
  const unvisited = new Set<number>();
  let triangles = 0;
  for (let t = 0; t < regions.region.length; t++) {
    if (regions.region[t] !== region) continue;
    triangles++;
    for (let h = t * 3; h < t * 3 + 3; h++) if (isBoundary(h)) unvisited.add(h);
  }
  const cap = unvisited.size * 3;

  const loops: EdgeLoop[] = [];
  for (const start of unvisited) {
    const halfEdges: number[] = [];
    let h = start;
    for (let steps = 0; steps < cap && unvisited.delete(h); steps++) {
      halfEdges.push(h);
      let out = next(h);
      for (let fan = 0; fan < triangles && !isBoundary(out); fan++) out = nextAroundStart(out);
      h = out;
    }
    if (halfEdges.length >= 2) loops.push(loopOf(positions, halfEdges));
  }
  return loops;
}

function loopOf(positions: Float32Array, halfEdges: number[]): EdgeLoop {
  const n = halfEdges.length;
  const points = halfEdges.map((h) => at(positions, h));
  const normals = halfEdges.map((h) => faceNormal(positions, h - (h % 3)));
  const inward = halfEdges.map((h, i) => {
    const t = h - (h % 3);
    const opposite = at(positions, t + ((h - t) + 2) % 3);
    const a = points[i]!;
    const d = unit(sub(points[(i + 1) % n]!, a));
    const toOpposite = sub(opposite, lerp(a, points[(i + 1) % n]!, 0.5));
    return unit(sub(toOpposite, scale(d, dot(toOpposite, d))));
  });
  const cornerDot = Math.cos((Math.PI / 180) * CORNER_DEG);
  const corners: number[] = [];
  for (let i = 0; i < n; i++) {
    const before = unit(sub(points[i]!, points[(i + n - 1) % n]!));
    const after = unit(sub(points[(i + 1) % n]!, points[i]!));
    if (dot(before, after) < cornerDot) corners.push(i);
  }
  const shift = corners[0] ?? 0;
  const rotate = <T>(list: T[]) => list.slice(shift).concat(list.slice(0, shift));
  return { points: rotate(points), normals: rotate(normals), inward: rotate(inward), corners: corners.map((c) => c - shift) };
}

/** A place on a loop: segment `seg` at fraction `t` in [0, 1] from points[seg] to points[(seg + 1) % n]. */
export interface LoopPos {
  seg: number;
  t: number;
}

export function pointAt(loop: EdgeLoop, pos: LoopPos): Vec3 {
  const n = loop.points.length;
  return lerp(loop.points[pos.seg]!, loop.points[(pos.seg + 1) % n]!, pos.t);
}

/** The loop place nearest `p` in 3D, that place's point, and the distance. */
export function nearestOnLoop(loop: EdgeLoop, p: Vec3): { pos: LoopPos; point: Vec3; dist: number } {
  const n = loop.points.length;
  let best = { pos: { seg: 0, t: 0 }, point: loop.points[0]!, dist: Infinity };
  for (let seg = 0; seg < n; seg++) {
    const a = loop.points[seg]!;
    const d = sub(loop.points[(seg + 1) % n]!, a);
    const lenSq = dot(d, d);
    const t = lenSq > 0 ? Math.min(1, Math.max(0, dot(sub(p, a), d) / lenSq)) : 0;
    const point = lerp(a, loop.points[(seg + 1) % n]!, t);
    const dist = distance(point, p);
    if (dist < best.dist) best = { pos: { seg, t }, point, dist };
  }
  return best;
}

/** The corner-to-corner run holding `pos`, as points in loop order. With fewer than 2 corners it is the whole loop, `closed`. */
export function edgeRun(loop: EdgeLoop, pos: LoopPos): { points: Vec3[]; closed: boolean } {
  const { corners, points } = loop;
  const n = points.length;
  if (corners.length < 2) return { points: points.slice(), closed: true };
  let k = corners.length - 1;
  for (let i = 0; i < corners.length - 1; i++) if (pos.seg >= corners[i]! && pos.seg < corners[i + 1]!) k = i;
  const from = corners[k]!;
  const to = corners[(k + 1) % corners.length]!;
  const run: Vec3[] = [];
  for (let i = from; ; i = (i + 1) % n) {
    run.push(points[i]!);
    if (i === to) break;
  }
  return { points: run, closed: false };
}

/** The whole loop, or the shorter of the two arcs between two places on it. */
export type StripSpan = { kind: "loop" } | { kind: "arc"; from: LoopPos; to: LoopPos };
export interface StripSample {
  point: Vec3;
  normal: Vec3;
}

/** A region's triangles, bucketed for short ray casts. Null when the region is flat, where the planar samples already lie on it. */
export interface RegionSurface {
  positions: Float32Array;
  min: Vec3;
  cell: number;
  dims: [number, number, number];
  /** CSR buckets: triangle indices `cellTris[cellStart[c] .. cellStart[c + 1])` overlap cell c. */
  cellStart: Int32Array;
  cellTris: Int32Array;
}

const FLAT_DOT = Math.cos((Math.PI / 180) * 0.5);

export function regionSurface(positions: Float32Array, regions: FaceRegions, region: number): RegionSurface | null {
  const tris: number[] = [];
  for (let t = 0; t < regions.region.length; t++) if (regions.region[t] === region) tris.push(t);
  if (tris.length === 0) return null;
  const first = faceNormal(positions, tris[0]! * 3);
  if (tris.every((t) => dot(faceNormal(positions, t * 3), first) >= FLAT_DOT)) return null;

  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let triExtent = 0;
  const lo: Vec3 = [0, 0, 0];
  const hi: Vec3 = [0, 0, 0];
  const bounds = (t: number) => {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(positions[t * 9 + k]!, positions[t * 9 + 3 + k]!, positions[t * 9 + 6 + k]!);
      hi[k] = Math.max(positions[t * 9 + k]!, positions[t * 9 + 3 + k]!, positions[t * 9 + 6 + k]!);
    }
  };
  for (const t of tris) {
    bounds(t);
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], lo[k]);
      max[k] = Math.max(max[k], hi[k]);
      triExtent = Math.max(triExtent, hi[k] - lo[k]);
    }
  }
  const extent = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 1e-6);
  const perAxis = Math.min(256, Math.max(1, Math.round(Math.cbrt(tris.length) * 1.5)));
  // Cells no smaller than the largest triangle keep each triangle in a handful of buckets.
  const cell = Math.max(extent / perAxis, triExtent, 1e-6);
  const dims: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < 3; k++) dims[k] = Math.floor((max[k] - min[k]) / cell) + 1;
  const cells = dims[0] * dims[1] * dims[2];
  const cellStart = new Int32Array(cells + 1);
  const range = (t: number, each: (c: number) => void) => {
    bounds(t);
    const c0 = lo.map((v, k) => Math.floor((v - min[k]!) / cell));
    const c1 = hi.map((v, k) => Math.floor((v - min[k]!) / cell));
    for (let z = c0[2]!; z <= c1[2]!; z++)
      for (let y = c0[1]!; y <= c1[1]!; y++)
        for (let x = c0[0]!; x <= c1[0]!; x++) each((z * dims[1] + y) * dims[0] + x);
  };
  for (const t of tris) range(t, (c) => cellStart[c + 1]++);
  for (let c = 0; c < cells; c++) cellStart[c + 1] += cellStart[c]!;
  const fill = cellStart.slice(0, cells);
  const cellTris = new Int32Array(cellStart[cells]!);
  for (const t of tris) range(t, (c) => (cellTris[fill[c]++] = t));
  return { positions, min, cell, dims, cellStart, cellTris };
}

/** Möller–Trumbore, both facings: the ray parameter of the hit on triangle t, or -1. */
function rayTriangle(p: Float32Array, t: number, o: Vec3, d: Vec3): number {
  const v = t * 9;
  const a: Vec3 = [p[v]!, p[v + 1]!, p[v + 2]!];
  const e1: Vec3 = [p[v + 3]! - a[0], p[v + 4]! - a[1], p[v + 5]! - a[2]];
  const e2: Vec3 = [p[v + 6]! - a[0], p[v + 7]! - a[1], p[v + 8]! - a[2]];
  const h: Vec3 = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
  const det = dot(e1, h);
  if (Math.abs(det) < 1e-12) return -1;
  const inv = 1 / det;
  const s = sub(o, a);
  const u = dot(s, h) * inv;
  if (u < -1e-9 || u > 1 + 1e-9) return -1;
  const q: Vec3 = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
  const w = dot(d, q) * inv;
  if (w < -1e-9 || u + w > 1 + 1e-9) return -1;
  return dot(e2, q) * inv;
}

/** The nearest triangle the ray `o + s * d`, s in [0, maxLen], hits, walking the grid cell by cell (3D DDA). */
function castRay(surface: RegionSurface, o: Vec3, d: Vec3, maxLen: number): { s: number; tri: number } | null {
  const { min, cell, dims, cellStart, cellTris, positions } = surface;
  let s0 = 0;
  let s1 = maxLen;
  for (let k = 0; k < 3; k++) {
    const lo = min[k] - o[k];
    const hi = lo + dims[k] * cell;
    if (d[k] === 0) {
      if (lo > 0 || hi < 0) return null;
      continue;
    }
    s0 = Math.max(s0, Math.min(lo / d[k], hi / d[k]));
    s1 = Math.min(s1, Math.max(lo / d[k], hi / d[k]));
  }
  if (s0 > s1) return null;
  const idx = [0, 0, 0];
  const step = [0, 0, 0];
  const tMax = [Infinity, Infinity, Infinity];
  const tDelta = [Infinity, Infinity, Infinity];
  for (let k = 0; k < 3; k++) {
    idx[k] = Math.min(dims[k] - 1, Math.max(0, Math.floor((o[k] + d[k] * s0 - min[k]) / cell)));
    if (d[k] === 0) continue;
    step[k] = d[k] > 0 ? 1 : -1;
    const edge = min[k] + (idx[k]! + (d[k] > 0 ? 1 : 0)) * cell;
    tMax[k] = (edge - o[k]) / d[k];
    tDelta[k] = cell / Math.abs(d[k]);
  }
  let best = { s: Infinity, tri: -1 };
  for (let guard = 0; guard < dims[0] + dims[1] + dims[2] + 3; guard++) {
    const c = (idx[2]! * dims[1] + idx[1]!) * dims[0] + idx[0]!;
    for (let i = cellStart[c]!; i < cellStart[c + 1]!; i++) {
      const tri = cellTris[i]!;
      const s = rayTriangle(positions, tri, o, d);
      if (s >= 0 && s <= s1 && s < best.s) best = { s, tri };
    }
    const k = tMax[0]! <= tMax[1]! ? (tMax[0]! <= tMax[2]! ? 0 : 2) : tMax[1]! <= tMax[2]! ? 1 : 2;
    if (best.s <= tMax[k]! || tMax[k]! > s1) break;
    idx[k] += step[k]!;
    if (idx[k]! < 0 || idx[k]! >= dims[k]) break;
    tMax[k] += tDelta[k]!;
  }
  return best.tri === -1 ? null : best;
}

/** The inset polyline the strip runs along; piece i joins `points[i]` to `points[i + 1]` (or back to 0 when closed) and lies on loop segment `owners[i]`. */
interface InsetPath {
  points: Vec3[];
  owners: number[];
  closed: boolean;
}

/** Loop vertex i moved into the region along the bisector of its two segments' inward vectors, mitred to `d`. */
function mitredVertex(loop: EdgeLoop, i: number, d: number): Vec3 {
  const n = loop.points.length;
  const before = loop.inward[(i + n - 1) % n]!;
  const after = loop.inward[i]!;
  let bisector = unit(add(before, after));
  if (length(bisector) === 0) bisector = after;
  const move = Math.min(d / Math.max(dot(bisector, after), 1e-9), 4 * d);
  return add(loop.points[i]!, scale(bisector, move));
}

/** Forward along the loop from one place to another on a different segment. */
function arcLength(loop: EdgeLoop, from: LoopPos, to: LoopPos): number {
  const n = loop.points.length;
  const segLength = (seg: number) => distance(loop.points[seg]!, loop.points[(seg + 1) % n]!);
  let total = (1 - from.t) * segLength(from.seg) + to.t * segLength(to.seg);
  for (let seg = (from.seg + 1) % n; seg !== to.seg; seg = (seg + 1) % n) total += segLength(seg);
  return total;
}

function insetPath(loop: EdgeLoop, span: StripSpan, d: number): InsetPath {
  const n = loop.points.length;
  if (span.kind === "loop") {
    return { points: loop.points.map((_, i) => mitredVertex(loop, i, d)), owners: loop.points.map((_, i) => i), closed: true };
  }
  const { from, to } = span;
  const points = [add(pointAt(loop, from), scale(loop.inward[from.seg]!, d))];
  const owners = [from.seg];
  if (from.seg !== to.seg) {
    for (let seg = (from.seg + 1) % n; ; seg = (seg + 1) % n) {
      points.push(mitredVertex(loop, seg, d));
      owners.push(seg);
      if (seg === to.seg) break;
    }
  }
  points.push(add(pointAt(loop, to), scale(loop.inward[to.seg]!, d)));
  return { points, owners, closed: false };
}

/**
 * Disk centres of a strip `offset` mm from the edge to its near side, disks of radius `r`, so the centre line is
 * inset by `offset + r`. With a surface, each sample is cast from `point + normal * (offset + r)` along `-normal`
 * against the region and takes the nearest hit within 2 * (offset + r) and that triangle's normal; a miss keeps the planar sample.
 */
export function stripSamples(loop: EdgeLoop, span: StripSpan, offset: number, r: number, surface?: RegionSurface | null): StripSample[] {
  const d = offset + r;
  const step = STROKE_STEP_R * r;
  let reversed = false;
  if (span.kind === "arc") {
    const { from, to } = span;
    const backwards = from.seg === to.seg ? to.t < from.t : arcLength(loop, from, to) > arcLength(loop, to, from);
    if (backwards) {
      span = { kind: "arc", from: to, to: from };
      reversed = true;
    }
  }
  const path = insetPath(loop, span, d);
  const pieces = path.closed ? path.points.length : path.points.length - 1;
  const lengths = Array.from({ length: pieces }, (_, i) => distance(path.points[i]!, path.points[(i + 1) % path.points.length]!));
  const total = lengths.reduce((a, b) => a + b, 0);
  const count = path.closed ? Math.max(1, Math.ceil(total / step - 1e-9)) : total < 1e-9 ? 1 : Math.ceil(total / step - 1e-9) + 1;
  const spacing = path.closed ? total / count : count > 1 ? total / (count - 1) : 0;

  const samples: StripSample[] = [];
  let piece = 0;
  let start = 0;
  for (let k = 0; k < count; k++) {
    const s = Math.min(k * spacing, total);
    while (piece < pieces - 1 && start + lengths[piece]! < s) start += lengths[piece++]!;
    const a = path.points[piece]!;
    const b = path.points[(piece + 1) % path.points.length]!;
    const t = lengths[piece]! > 0 ? (s - start) / lengths[piece]! : 0;
    const owner = path.owners[piece]!;
    samples.push(snap(lerp(a, b, t), loop.normals[owner]!, d, surface));
  }
  return reversed ? samples.reverse() : samples;
}

function snap(point: Vec3, normal: Vec3, d: number, surface: RegionSurface | null | undefined): StripSample {
  if (!surface) return { point, normal };
  const down = scale(normal, -1);
  const hit = castRay(surface, add(point, scale(normal, d)), down, 2 * d);
  if (!hit) return { point, normal };
  return { point: add(point, scale(down, hit.s - d)), normal: faceNormal(surface.positions, hit.tri * 3) };
}
