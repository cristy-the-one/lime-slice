/**
 * Client meshes for a drag, before the kernel has answered. Pure triangle soups, nine floats a
 * triangle, wound outward. While the pointer moves only these are drawn; the kernel probe waits
 * until the pointer has been still for `GHOST_PROBE_WAIT_MS`, the same pause as a typed number.
 */

import { cross, scale, type Vec3 } from "../model-drag.ts";

export type { Vec3 };
export type Pt = [number, number];

/** Matches `PROBE_WAIT_MS`. The kernel is not asked while the pointer is still moving. */
export const GHOST_PROBE_WAIT_MS = 300;
/** Facets around a full turn of a revolve ghost. A shorter angle uses the same spacing. */
export const REVOLVE_STEPS = 48;
/** Facets around a fillet tube, the same count the blend ghost in the view uses. */
export const FILLET_AROUND = 8;

/** True while the pointer has not been still long enough to ask the kernel. */
export function previewIsGhost(stillMs: number): boolean {
  return stillMs < GHOST_PROBE_WAIT_MS;
}

export interface PlaneFrame {
  origin: Vec3;
  /** Unit axis of the plane. A sketch point (u, v) is `origin + u·U + v·V`. */
  u: Vec3;
  v: Vec3;
}

/**
 * A prism on a face: the face's triangles moved along `normal`, plus a wall on each boundary edge.
 * `positions` is a triangle soup of the face. `distance` is signed, so a push and a pull both draw.
 * Pass `boundary` when the face's outline is already known; otherwise it is read off the triangles.
 */
export function facePrism(
  positions: ArrayLike<number>,
  normal: Vec3,
  distance: number,
  boundary?: readonly (readonly Vec3[])[],
): Float32Array {
  const n = unit(normal);
  if (!n || !Number.isFinite(distance) || distance === 0) return new Float32Array();
  const off = scale(n, distance);
  const positive = distance > 0;
  const out: number[] = [];
  const count = Math.floor(positions.length / 9);
  for (let tri = 0; tri < count; tri += 1) {
    const base = tri * 9;
    const a = at(positions, base);
    const b = at(positions, base + 3);
    const c = at(positions, base + 6);
    const A = move(a, off);
    const B = move(b, off);
    const C = move(c, off);
    if (positive) {
      pushTri(out, A, B, C);
      pushTri(out, a, c, b);
    } else {
      pushTri(out, A, C, B);
      pushTri(out, a, b, c);
    }
  }
  const loops = boundary ? boundary.map((loop) => loop.map(copy3)) : boundaryLoops(positions);
  for (const loop of loops) {
    if (loop.length < 2) continue;
    for (let i = 0; i < loop.length; i += 1) {
      const a = loop[i]!;
      const b = loop[(i + 1) % loop.length]!;
      const A = move(a, off);
      const B = move(b, off);
      if (positive) pushQuad(out, a, b, B, A);
      else pushQuad(out, a, A, B, b);
    }
  }
  return soup(out);
}

/**
 * A sketch region extruded along the plane normal. The first loop is the outside; the rest are holes.
 * The region is ear-clipped, then walled the same way as a face prism.
 */
export function regionExtrude(plane: PlaneFrame, loops: readonly (readonly Pt[])[], distance: number): Float32Array {
  const flat = triangulate(loops);
  if (flat.triangles.length === 0) return new Float32Array();
  const out: number[] = [];
  for (const [ia, ib, ic] of flat.triangles) {
    const a = flat.points[ia];
    const b = flat.points[ib];
    const c = flat.points[ic];
    if (!a || !b || !c) continue;
    pushTri(out, onPlane(plane, a), onPlane(plane, b), onPlane(plane, c));
  }
  return facePrism(out, planeNormal(plane), distance);
}

export interface RevolveGhost {
  plane: PlaneFrame;
  /** The axis, in the plane's coordinates. */
  axisOrigin: Pt;
  axisDir: Pt;
  /** The region's outline, closed, in the plane's coordinates. */
  outline: readonly Pt[];
  /** Degrees about the axis. Default a full turn. */
  angleDeg?: number;
  /** Steps around a full turn. Default 48. */
  steps?: number;
}

/** A lathe of the outline. A full turn is closed by the sweep; a partial turn gains the two end faces. */
export function revolveGhost(spec: RevolveGhost): Float32Array {
  const outline = clean(spec.outline);
  if (outline.length < 2) return new Float32Array();
  const basis = revolveBasis(spec);
  if (!basis) return new Float32Array();
  const degrees = spec.angleDeg ?? 360;
  if (!Number.isFinite(degrees) || degrees === 0) return new Float32Array();
  const turn = (Math.max(-360, Math.min(360, degrees)) * Math.PI) / 180;
  const full = Math.abs(Math.abs(turn) - Math.PI * 2) < 1e-3;
  const perTurn = spec.steps ?? REVOLVE_STEPS;
  const steps = Math.max(1, full ? perTurn : Math.round((perTurn * Math.abs(turn)) / (Math.PI * 2)));
  const rings: Vec3[][] = [];
  for (let s = 0; s <= (full ? steps - 1 : steps); s += 1) {
    const angle = full ? (Math.sign(turn || 1) * Math.PI * 2 * s) / steps : (turn * s) / steps;
    rings.push(outline.map((point) => placeOnAxis(point, angle, basis)));
  }
  const out: number[] = [];
  for (let s = 0; s < steps; s += 1) {
    const ring0 = rings[s]!;
    const ring1 = rings[full ? (s + 1) % rings.length : s + 1]!;
    for (let i = 0; i < outline.length; i += 1) {
      const j = (i + 1) % outline.length;
      const a = ring0[i];
      const b = ring0[j];
      const c = ring1[j];
      const d = ring1[i];
      if (a && b && c && d) pushQuad(out, a, b, c, d);
    }
  }
  if (!full) {
    const flat = triangulate([outline]);
    const start = rings[0] ?? [];
    const end = rings[rings.length - 1] ?? [];
    for (const [ia, ib, ic] of flat.triangles) {
      const a0 = start[ia];
      const b0 = start[ib];
      const c0 = start[ic];
      const a1 = end[ia];
      const b1 = end[ib];
      const c1 = end[ic];
      if (a0 && b0 && c0) pushTri(out, a0, c0, b0);
      if (a1 && b1 && c1) pushTri(out, a1, b1, c1);
    }
  }
  return soup(out);
}

export interface FilletGhost {
  /** The edge, at least two points. */
  points: readonly Vec3[];
  radius: number;
  /** Facets around the tube. Default 8. */
  around?: number;
}

/**
 * A tube of `radius` along the edge: the blend ghost, without three.js. Open at the ends, the way
 * the view's tube is. Vertices sit on a ring of that radius about the polyline.
 */
export function filletGhost(spec: FilletGhost): Float32Array {
  const points = spec.points.map(copy3).filter((point, index, all) => {
    const prev = all[index - 1];
    return !prev || dist3(prev, point) > 1e-8;
  });
  const around = spec.around ?? FILLET_AROUND;
  if (points.length < 2 || !(spec.radius > 0) || around < 3) return new Float32Array();
  const frames = tubeFrames(points);
  const rings = frames.map((frame) => ring(frame.centre, frame.normal, frame.binormal, spec.radius, around));
  const out: number[] = [];
  for (let i = 0; i + 1 < rings.length; i += 1) {
    const a = rings[i]!;
    const b = rings[i + 1]!;
    for (let k = 0; k < around; k += 1) {
      const n = (k + 1) % around;
      const a0 = a[k];
      const a1 = a[n];
      const b0 = b[k];
      const b1 = b[n];
      if (a0 && a1 && b0 && b1) pushQuad(out, a0, a1, b1, b0);
    }
  }
  return Float32Array.from(out);
}

interface FlatMesh {
  points: Pt[];
  triangles: [number, number, number][];
}

/** Ear-clip a region. The first loop is the outside; further loops are holes. Empty when it will not triangulate. */
export function triangulate(loops: readonly (readonly Pt[])[]): FlatMesh {
  const rings = loops.map(clean).filter((ring) => ring.length >= 3);
  const outer = rings[0];
  if (!outer) return { points: [], triangles: [] };
  let polygon = ccw(outer);
  for (const hole of rings.slice(1)) {
    const linked = linkHole(polygon, cw(hole));
    if (linked) polygon = linked;
  }
  return { points: polygon, triangles: earClip(polygon) };
}

function earClip(polygon: Pt[]): [number, number, number][] {
  const ring = polygon.map((_, index) => index);
  const tris: [number, number, number][] = [];
  let guard = ring.length * ring.length;
  while (ring.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < ring.length; i += 1) {
      const i0 = ring[(i + ring.length - 1) % ring.length]!;
      const i1 = ring[i]!;
      const i2 = ring[(i + 1) % ring.length]!;
      if (!isEar(polygon, ring, i0, i1, i2)) continue;
      tris.push([i0, i1, i2]);
      ring.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (ring.length === 3) tris.push([ring[0]!, ring[1]!, ring[2]!]);
  return tris;
}

function isEar(points: Pt[], ring: number[], i0: number, i1: number, i2: number): boolean {
  const a = points[i0];
  const b = points[i1];
  const c = points[i2];
  if (!a || !b || !c) return false;
  if (cross2(a, b, c) <= 1e-12) return false;
  for (const index of ring) {
    if (index === i0 || index === i1 || index === i2) continue;
    const p = points[index];
    // The bridge repeats a vertex. That copy sits on a corner, so it is not a point inside the ear.
    if (!p || dist2(p, a) < 1e-18 || dist2(p, b) < 1e-18 || dist2(p, c) < 1e-18) continue;
    if (inTri(p, a, b, c)) return false;
  }
  return true;
}

/**
 * Splice a hole into the outer ring by a bridge from the hole's rightmost point to a visible
 * outer vertex. The bridge is walked twice, so it cancels when the walls are built.
 */
function linkHole(outer: Pt[], hole: Pt[]): Pt[] | null {
  if (hole.length < 3) return null;
  let h = 0;
  for (let i = 1; i < hole.length; i += 1) {
    const point = hole[i]!;
    const best = hole[h]!;
    if (point[0] > best[0] + 1e-9 || (Math.abs(point[0] - best[0]) <= 1e-9 && point[1] > best[1])) h = i;
  }
  const hp = hole[h]!;
  const order = outer.map((_, index) => index).sort((i, j) => dist2(outer[i]!, hp) - dist2(outer[j]!, hp));
  let join = -1;
  for (const index of order) {
    if (visible(outer, hole, outer[index]!, hp)) {
      join = index;
      break;
    }
  }
  if (join < 0) return null;
  const ring: Pt[] = [];
  for (let i = 0; i <= join; i += 1) ring.push(outer[i]!);
  for (let k = 0; k < hole.length; k += 1) ring.push(hole[(h + k) % hole.length]!);
  ring.push(hp);
  for (let i = join; i < outer.length; i += 1) ring.push(outer[i]!);
  return ring;
}

function visible(outer: Pt[], hole: Pt[], a: Pt, b: Pt): boolean {
  if (dist2(a, b) < 1e-18) return false;
  if (hits(outer, a, b) || hits(hole, a, b)) return false;
  const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  return inside(outer, mid) && !inside(hole, mid);
}

function hits(ring: Pt[], a: Pt, b: Pt): boolean {
  for (let i = 0; i < ring.length; i += 1) {
    const c = ring[i]!;
    const d = ring[(i + 1) % ring.length]!;
    if (same2(c, a) || same2(d, a) || same2(c, b) || same2(d, b)) continue;
    if (properCross(a, b, c, d)) return true;
  }
  return false;
}

function inside(ring: Pt[], point: Pt): boolean {
  let crossings = false;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    if ((a[1] > point[1]) === (b[1] > point[1])) continue;
    const x = a[0] + ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]);
    if (x > point[0]) crossings = !crossings;
  }
  return crossings;
}

function boundaryLoops(positions: ArrayLike<number>): Vec3[][] {
  const verts = new Map<string, Vec3>();
  const half = new Map<string, { from: string; to: string }>();
  const count = Math.floor(positions.length / 9);
  const idOf = (point: Vec3) => {
    const key = `${Math.round(point[0] * 1e5)},${Math.round(point[1] * 1e5)},${Math.round(point[2] * 1e5)}`;
    if (!verts.has(key)) verts.set(key, point);
    return key;
  };
  for (let tri = 0; tri < count; tri += 1) {
    const base = tri * 9;
    const ids = [idOf(at(positions, base)), idOf(at(positions, base + 3)), idOf(at(positions, base + 6))];
    for (let edge = 0; edge < 3; edge += 1) {
      const from = ids[edge]!;
      const to = ids[(edge + 1) % 3]!;
      if (from === to) continue;
      const key = from < to ? `${from}|${to}` : `${to}|${from}`;
      const existing = half.get(key);
      if (!existing) half.set(key, { from, to });
      else if (existing.from === to && existing.to === from) half.delete(key);
    }
  }
  const next = new Map<string, string>();
  for (const edge of half.values()) if (!next.has(edge.from)) next.set(edge.from, edge.to);
  const loops: Vec3[][] = [];
  const seen = new Set<string>();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop: Vec3[] = [];
    let cursor: string | undefined = start;
    let guard = next.size + 1;
    while (cursor && !seen.has(cursor) && guard-- > 0) {
      seen.add(cursor);
      const point = verts.get(cursor);
      if (point) loop.push(point);
      const to = next.get(cursor);
      if (!to || to === start) break;
      cursor = to;
    }
    if (loop.length >= 2) loops.push(loop);
  }
  return loops;
}

interface AxisBasis {
  origin: Vec3;
  axis: Vec3;
  u: Vec3;
  v: Vec3;
  dir: Pt;
  axisOrigin: Pt;
}

function revolveBasis(spec: RevolveGhost): AxisBasis | null {
  const u = unit(spec.plane.u);
  const v = unit(spec.plane.v);
  const dir = unit2(spec.axisDir);
  if (!u || !v || !dir) return null;
  const axis = unit([dir[0] * u[0] + dir[1] * v[0], dir[0] * u[1] + dir[1] * v[1], dir[0] * u[2] + dir[1] * v[2]]);
  if (!axis) return null;
  return { origin: spec.plane.origin, axis, u, v, dir, axisOrigin: spec.axisOrigin };
}

function placeOnAxis(point: Pt, angle: number, basis: AxisBasis): Vec3 {
  const rel: Pt = [point[0] - basis.axisOrigin[0], point[1] - basis.axisOrigin[1]];
  const along = rel[0] * basis.dir[0] + rel[1] * basis.dir[1];
  const radial: Pt = [rel[0] - basis.dir[0] * along, rel[1] - basis.dir[1] * along];
  const radius = Math.hypot(radial[0], radial[1]);
  const centre = move(basis.origin, [
    basis.u[0] * basis.axisOrigin[0] + basis.v[0] * basis.axisOrigin[1] + basis.axis[0] * along,
    basis.u[1] * basis.axisOrigin[0] + basis.v[1] * basis.axisOrigin[1] + basis.axis[1] * along,
    basis.u[2] * basis.axisOrigin[0] + basis.v[2] * basis.axisOrigin[1] + basis.axis[2] * along,
  ]);
  if (radius < 1e-12) return centre;
  const radial3 = unit([
    radial[0] * basis.u[0] + radial[1] * basis.v[0],
    radial[0] * basis.u[1] + radial[1] * basis.v[1],
    radial[0] * basis.u[2] + radial[1] * basis.v[2],
  ]);
  if (!radial3) return centre;
  const binormal = cross(basis.axis, radial3);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [
    centre[0] + (radial3[0] * c + binormal[0] * s) * radius,
    centre[1] + (radial3[1] * c + binormal[1] * s) * radius,
    centre[2] + (radial3[2] * c + binormal[2] * s) * radius,
  ];
}

interface Frame {
  centre: Vec3;
  normal: Vec3;
  binormal: Vec3;
}

function tubeFrames(points: Vec3[]): Frame[] {
  const tangents: Vec3[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const prev = points[Math.max(0, index - 1)]!;
    const next = points[Math.min(points.length - 1, index + 1)]!;
    tangents.push(unit([next[0] - prev[0], next[1] - prev[1], next[2] - prev[2]]) ?? [1, 0, 0]);
  }
  let normal = perpendicular(tangents[0]!);
  const frames: Frame[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const tangent = tangents[i]!;
    const carried = unit(sub(normal, scale(tangent, dot(normal, tangent))));
    normal = carried ?? perpendicular(tangent);
    frames.push({ centre: points[i]!, normal, binormal: cross(tangent, normal) });
  }
  return frames;
}

function ring(centre: Vec3, normal: Vec3, binormal: Vec3, radius: number, around: number): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < around; i += 1) {
    const angle = (i / around) * Math.PI * 2;
    const c = Math.cos(angle) * radius;
    const s = Math.sin(angle) * radius;
    out.push([
      centre[0] + normal[0] * c + binormal[0] * s,
      centre[1] + normal[1] * c + binormal[1] * s,
      centre[2] + normal[2] * c + binormal[2] * s,
    ]);
  }
  return out;
}

function perpendicular(tangent: Vec3): Vec3 {
  const up: Vec3 = Math.abs(tangent[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  return unit(cross(tangent, up)) ?? [0, 0, 1];
}

function planeNormal(plane: PlaneFrame): Vec3 {
  return cross(plane.u, plane.v);
}

function onPlane(plane: PlaneFrame, point: Pt): Vec3 {
  return [
    plane.origin[0] + plane.u[0] * point[0] + plane.v[0] * point[1],
    plane.origin[1] + plane.u[1] * point[0] + plane.v[1] * point[1],
    plane.origin[2] + plane.u[2] * point[0] + plane.v[2] * point[1],
  ];
}

function soup(values: number[]): Float32Array {
  if (signedVolume(values) < -1e-6) {
    for (let i = 0; i + 8 < values.length; i += 9) {
      const x = values[i + 3]!;
      const y = values[i + 4]!;
      const z = values[i + 5]!;
      values[i + 3] = values[i + 6]!;
      values[i + 4] = values[i + 7]!;
      values[i + 5] = values[i + 8]!;
      values[i + 6] = x;
      values[i + 7] = y;
      values[i + 8] = z;
    }
  }
  return Float32Array.from(values);
}

function signedVolume(values: number[]): number {
  let volume = 0;
  for (let i = 0; i + 8 < values.length; i += 9) {
    const ax = values[i]!;
    const ay = values[i + 1]!;
    const az = values[i + 2]!;
    const bx = values[i + 3]!;
    const by = values[i + 4]!;
    const bz = values[i + 5]!;
    const cx = values[i + 6]!;
    const cy = values[i + 7]!;
    const cz = values[i + 8]!;
    volume += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return volume / 6;
}

function pushTri(out: number[], a: Vec3, b: Vec3, c: Vec3) {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  if (nx * nx + ny * ny + nz * nz < 1e-24) return;
  out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
}

function pushQuad(out: number[], a: Vec3, b: Vec3, c: Vec3, d: Vec3) {
  pushTri(out, a, b, c);
  pushTri(out, a, c, d);
}

function clean(points: readonly Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const point of points) {
    if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) continue;
    const prev = out[out.length - 1];
    if (prev && dist2(prev, point) < 1e-18) continue;
    out.push([point[0], point[1]]);
  }
  if (out.length > 1 && dist2(out[0]!, out[out.length - 1]!) < 1e-18) out.pop();
  return out;
}

function ccw(ring: Pt[]): Pt[] {
  return area(ring) < 0 ? [...ring].reverse() : [...ring];
}

function cw(ring: Pt[]): Pt[] {
  return area(ring) > 0 ? [...ring].reverse() : [...ring];
}

function area(ring: Pt[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

function cross2(a: Pt, b: Pt, c: Pt): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function inTri(p: Pt, a: Pt, b: Pt, c: Pt): boolean {
  const c0 = cross2(a, b, p);
  const c1 = cross2(b, c, p);
  const c2 = cross2(c, a, p);
  return c0 >= -1e-12 && c1 >= -1e-12 && c2 >= -1e-12;
}

function properCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const d1 = cross2(a, b, c);
  const d2 = cross2(a, b, d);
  const d3 = cross2(c, d, a);
  const d4 = cross2(c, d, b);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function at(positions: ArrayLike<number>, index: number): Vec3 {
  return [positions[index] ?? 0, positions[index + 1] ?? 0, positions[index + 2] ?? 0];
}

function move(point: Vec3, by: Vec3): Vec3 {
  return [point[0] + by[0], point[1] + by[1], point[2] + by[2]];
}

function copy3(point: Vec3): Vec3 {
  return [point[0], point[1], point[2]];
}

function unit(v: Vec3): Vec3 | null {
  if (!Number.isFinite(v[0]) || !Number.isFinite(v[1]) || !Number.isFinite(v[2])) return null;
  const length = Math.hypot(v[0], v[1], v[2]);
  if (!(length > 1e-12)) return null;
  return [v[0] / length, v[1] / length, v[2] / length];
}

function unit2(v: Pt | undefined): Pt | null {
  if (!v || !Number.isFinite(v[0]) || !Number.isFinite(v[1])) return null;
  const length = Math.hypot(v[0], v[1]);
  if (!(length > 1e-12)) return null;
  return [v[0] / length, v[1] / length];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dist2(a: Pt, b: Pt): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
}

function dist3(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function same2(a: Pt, b: Pt): boolean {
  return dist2(a, b) < 1e-18;
}
