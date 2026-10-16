/**
 * Turn a region on a triangle soup into the disks a hand brush would leave.
 *
 * A drag in the app places a new disk once the hit moves half a radius
 * (`STROKE_STEP_R`). The next stroke starts one radius away, and its first
 * disk is always kept. Disks come back in the same frame as `positions`.
 */
import {
  BRUSH_R_MAX_MM,
  BRUSH_R_MIN_MM,
  MAX_PAINT_DISKS,
  STROKE_STEP_R,
  type Vec3,
} from "./support-paint.ts";

export interface RegionQuery {
  faces?: number[];
  /** Downward faces flatter than this many degrees from horizontal. */
  overhangBelowDeg?: number;
  zRangeMm?: [number, number];
  box?: { min: Vec3; max: Vec3 };
  sphere?: { centre: Vec3; radiusMm: number };
  stroke?: { points: Vec3[]; radiusMm: number };
}

export interface SurfaceDisk {
  p: Vec3;
  n: Vec3;
  r: number;
}

export type Cover =
  | { disks: SurfaceDisk[]; areaMm2: number; triangles: number }
  | { reason: string };

const ROW_STEP_R = 1;

function grouped(count: number): string {
  return Math.round(count).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale(a: Vec3, k: number): Vec3 {
  return [a[0] * k, a[1] * k, a[2] * k];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function unit(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]);
  return len > 1e-12 ? [v[0] / len, v[1] / len, v[2] / len] : [0, 0, 1];
}

function triAt(positions: Float32Array, index: number): [Vec3, Vec3, Vec3] {
  const base = index * 9;
  const at = (offset: number): Vec3 => [positions[base + offset] ?? 0, positions[base + offset + 1] ?? 0, positions[base + offset + 2] ?? 0];
  return [at(0), at(3), at(6)];
}

function triNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  return unit(cross(sub(b, a), sub(c, a)));
}

function triArea(a: Vec3, b: Vec3, c: Vec3): number {
  const n = cross(sub(b, a), sub(c, a));
  return Math.hypot(n[0], n[1], n[2]) / 2;
}

/** Degrees from horizontal. A flat underside is 0. A wall is 90. */
export function angleFromHorizontal(normal: Vec3): number {
  const len = Math.hypot(normal[0], normal[1], normal[2]) || 1;
  return (Math.acos(Math.min(1, Math.abs(normal[2] / len))) * 180) / Math.PI;
}

function pointInBox(p: Vec3, min: Vec3, max: Vec3): boolean {
  return p[0] >= min[0] && p[0] <= max[0] && p[1] >= min[1] && p[1] <= max[1] && p[2] >= min[2] && p[2] <= max[2];
}

function segmentHitsBox(p: Vec3, q: Vec3, min: Vec3, max: Vec3): boolean {
  let t0 = 0;
  let t1 = 1;
  for (let axis = 0; axis < 3; axis += 1) {
    const delta = q[axis] - p[axis];
    if (Math.abs(delta) < 1e-12) {
      if (p[axis] < min[axis] || p[axis] > max[axis]) return false;
      continue;
    }
    let near = (min[axis] - p[axis]) / delta;
    let far = (max[axis] - p[axis]) / delta;
    if (near > far) [near, far] = [far, near];
    t0 = Math.max(t0, near);
    t1 = Math.min(t1, far);
    if (t0 > t1) return false;
  }
  return true;
}

function bary(p: Vec3, a: Vec3, b: Vec3, c: Vec3, normal: Vec3): { inside: boolean; z: number } {
  const axis = Math.abs(normal[2]) >= Math.abs(normal[0]) && Math.abs(normal[2]) >= Math.abs(normal[1]) ? 2
    : Math.abs(normal[1]) >= Math.abs(normal[0]) ? 1 : 0;
  const u = (axis + 1) % 3;
  const v = (axis + 2) % 3;
  const area = (b[u] - a[u]) * (c[v] - a[v]) - (c[u] - a[u]) * (b[v] - a[v]);
  if (Math.abs(area) < 1e-12) return { inside: false, z: p[2] };
  const w0 = ((b[u] - p[u]) * (c[v] - p[v]) - (c[u] - p[u]) * (b[v] - p[v])) / area;
  const w1 = ((c[u] - p[u]) * (a[v] - p[v]) - (a[u] - p[u]) * (c[v] - p[v])) / area;
  const w2 = 1 - w0 - w1;
  const inside = w0 >= -1e-4 && w1 >= -1e-4 && w2 >= -1e-4;
  return { inside, z: a[2] * w0 + b[2] * w1 + c[2] * w2 };
}

function triHitsBox(a: Vec3, b: Vec3, c: Vec3, min: Vec3, max: Vec3): boolean {
  if (pointInBox(a, min, max) || pointInBox(b, min, max) || pointInBox(c, min, max)) return true;
  if (segmentHitsBox(a, b, min, max) || segmentHitsBox(b, c, min, max) || segmentHitsBox(c, a, min, max)) return true;
  const normal = triNormal(a, b, c);
  const centre: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const dist = dot(sub(centre, a), normal);
  const half = Math.abs(normal[0]) * (max[0] - min[0]) / 2 + Math.abs(normal[1]) * (max[1] - min[1]) / 2 + Math.abs(normal[2]) * (max[2] - min[2]) / 2;
  if (Math.abs(dist) > half + 1e-6) return false;
  const projected = sub(centre, scale(normal, dist));
  return bary(projected, a, b, c, normal).inside;
}

function pointSegDist(p: Vec3, a: Vec3, b: Vec3): number {
  const ab = sub(b, a);
  const len2 = dot(ab, ab);
  const t = len2 < 1e-12 ? 0 : Math.min(1, Math.max(0, dot(sub(p, a), ab) / len2));
  const q = add(a, scale(ab, t));
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

function triHitsSphere(a: Vec3, b: Vec3, c: Vec3, centre: Vec3, radius: number): boolean {
  const normal = triNormal(a, b, c);
  const dist = dot(sub(centre, a), normal);
  if (Math.abs(dist) > radius) return false;
  const projected = sub(centre, scale(normal, dist));
  if (bary(projected, a, b, c, normal).inside) return true;
  return pointSegDist(centre, a, b) <= radius || pointSegDist(centre, b, c) <= radius || pointSegDist(centre, c, a) <= radius;
}

function triHitsStroke(a: Vec3, b: Vec3, c: Vec3, points: Vec3[], radius: number): boolean {
  const samples = [a, b, c, [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3] as Vec3];
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i]!;
    const q = points[Math.min(points.length - 1, i + 1)]!;
    for (const sample of samples) {
      if (pointSegDist(sample, p, q) <= radius) return true;
    }
  }
  return false;
}

function hasFilter(region: RegionQuery): boolean {
  return region.faces != null || region.overhangBelowDeg != null || region.box != null || region.sphere != null || region.stroke != null;
}

/** Triangle indexes whose surface is inside the region. */
export function selectTriangles(positions: Float32Array, region: RegionQuery, faceOf?: (index: number) => number): number[] {
  const count = Math.floor(positions.length / 9);
  const faces = region.faces ? new Set(region.faces) : null;
  const out: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const [a, b, c] = triAt(positions, index);
    const normal = triNormal(a, b, c);
    const centroid: Vec3 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    if (faces && !faces.has(faceOf ? faceOf(index) : index)) continue;
    if (region.overhangBelowDeg != null) {
      if (!(normal[2] < -1e-3) || angleFromHorizontal(normal) >= region.overhangBelowDeg) continue;
    }
    if (region.zRangeMm && (centroid[2] < region.zRangeMm[0] || centroid[2] > region.zRangeMm[1])) continue;
    if (region.box && !triHitsBox(a, b, c, region.box.min, region.box.max)) continue;
    if (region.sphere && !triHitsSphere(a, b, c, region.sphere.centre, region.sphere.radiusMm)) continue;
    if (region.stroke && !triHitsStroke(a, b, c, region.stroke.points, region.stroke.radiusMm)) continue;
    if (triArea(a, b, c) < 1e-8) continue;
    out.push(index);
  }
  return out;
}

interface Sample {
  p: Vec3;
  n: Vec3;
  row: number;
  along: number;
}

function pushDisk(rows: Map<number, Sample[]>, sample: Sample): void {
  const row = rows.get(sample.row);
  if (row) row.push(sample);
  else rows.set(sample.row, [sample]);
}

function onSurface(positions: Float32Array, tris: readonly number[], x: number, y: number): { z: number; n: Vec3 } | null {
  for (const index of tris) {
    const [a, b, c] = triAt(positions, index);
    const normal = triNormal(a, b, c);
    if (Math.abs(normal[2]) < 0.5) continue;
    const hit = bary([x, y, 0], a, b, c, normal);
    if (hit.inside) return { z: hit.z, n: normal };
  }
  return null;
}

/** Flat up/down patches are stroked in bed X, the way a person paints while looking down. */
function coverFlat(positions: Float32Array, tris: readonly number[], radius: number, rows: Map<number, Sample[]>): void {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const index of tris) {
    const [a, b, c] = triAt(positions, index);
    for (const p of [a, b, c]) {
      if (p[0] < minX) minX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] > maxY) maxY = p[1];
    }
  }
  const along = STROKE_STEP_R * radius;
  const rowStep = ROW_STEP_R * radius;
  let row = 0;
  for (let y = minY; y <= maxY + 1e-6; y += rowStep) {
    for (let x = minX; x <= maxX + 1e-6; x += along) {
      const hit = onSurface(positions, tris, x, y);
      if (!hit) continue;
      pushDisk(rows, { p: [x, y, hit.z], n: hit.n, row, along: x });
    }
    row += 1;
  }
}

function coverTilted(positions: Float32Array, tris: readonly number[], radius: number, rows: Map<number, Sample[]>): void {
  const along = STROKE_STEP_R * radius;
  const rowStep = ROW_STEP_R * radius;
  let rowBase = 0;
  for (const index of tris) {
    const [a, b, c] = triAt(positions, index);
    const normal = triNormal(a, b, c);
    const e1 = sub(b, a);
    const len = Math.hypot(e1[0], e1[1], e1[2]) || 1;
    const u = scale(e1, 1 / len);
    const v = cross(normal, u);
    const coords = [a, b, c].map((p) => ({ u: dot(sub(p, a), u), v: dot(sub(p, a), v) }));
    const umin = Math.min(...coords.map((p) => p.u));
    const umax = Math.max(...coords.map((p) => p.u));
    const vmin = Math.min(...coords.map((p) => p.v));
    const vmax = Math.max(...coords.map((p) => p.v));
    let row = 0;
    for (let vv = vmin; vv <= vmax + 1e-6; vv += rowStep) {
      for (let uu = umin; uu <= umax + 1e-6; uu += along) {
        const point = add(a, add(scale(u, uu), scale(v, vv)));
        if (!bary(point, a, b, c, normal).inside) continue;
        pushDisk(rows, { p: point, n: normal, row: rowBase + row, along: uu });
      }
      row += 1;
    }
    rowBase += row + 1;
  }
}

function nearlyFlat(positions: Float32Array, tris: readonly number[]): boolean {
  if (tris.length === 0) return false;
  for (const index of tris) {
    const [a, b, c] = triAt(positions, index);
    if (Math.abs(triNormal(a, b, c)[2]) < 0.85) return false;
  }
  return true;
}

function disksFromRows(rows: Map<number, Sample[]>, radius: number): SurfaceDisk[] | string {
  const disks: SurfaceDisk[] = [];
  const keys = [...rows.keys()].sort((a, b) => a - b);
  for (const key of keys) {
    const samples = rows.get(key) ?? [];
    samples.sort((a, b) => a.along - b.along);
    let last: Vec3 | null = null;
    for (const sample of samples) {
      if (last) {
        const d = Math.hypot(sample.p[0] - last[0], sample.p[1] - last[1], sample.p[2] - last[2]);
        if (d < STROKE_STEP_R * radius - 1e-6) continue;
      }
      disks.push({ p: sample.p, n: sample.n, r: radius });
      last = sample.p;
      if (disks.length > MAX_PAINT_DISKS) {
        return `That needs more than ${grouped(MAX_PAINT_DISKS)} disks; the limit is ${grouped(MAX_PAINT_DISKS)}. Use a larger radius.`;
      }
    }
  }
  return disks;
}

function emptyReason(region: RegionQuery): string {
  if (region.box || region.sphere || region.stroke) return "No surface is inside that box.";
  if (region.faces) return "No face matches that filter.";
  return "No surface matches that overhang.";
}

/**
 * Disks that cover `region` at `radiusMm`, spaced like a hand brush.
 * An empty region or a brush past the cap is a sentence, and nothing is implied to be stored.
 */
export function coverRegion(positions: Float32Array, region: RegionQuery, radiusMm: number, faceOf?: (index: number) => number): Cover {
  if (!hasFilter(region)) return { reason: "Name a face, an overhang, a box, a sphere, or a stroke." };
  if (!(radiusMm >= BRUSH_R_MIN_MM && radiusMm <= BRUSH_R_MAX_MM)) {
    return { reason: `Brush radius must be from ${BRUSH_R_MIN_MM}–${BRUSH_R_MAX_MM} mm.` };
  }
  const picked = selectTriangles(positions, region, faceOf);
  if (picked.length === 0) return { reason: emptyReason(region) };
  let area = 0;
  for (const index of picked) {
    const [a, b, c] = triAt(positions, index);
    area += triArea(a, b, c);
  }
  const cell = STROKE_STEP_R * radiusMm * radiusMm;
  if (area / cell > MAX_PAINT_DISKS * 1.5) {
    return { reason: `That needs ${grouped(area / cell)} disks; the limit is ${grouped(MAX_PAINT_DISKS)}. Use a larger radius.` };
  }
  const rows = new Map<number, Sample[]>();
  if (nearlyFlat(positions, picked)) coverFlat(positions, picked, radiusMm, rows);
  else coverTilted(positions, picked, radiusMm, rows);
  const disks = disksFromRows(rows, radiusMm);
  if (typeof disks === "string") return { reason: disks };
  if (disks.length === 0) return { reason: emptyReason(region) };
  return { disks, areaMm2: area, triangles: picked.length };
}

/** True when `point` lies within `radius` of a selected triangle. Used to drop erased disks. */
export function onSelection(positions: Float32Array, triangles: readonly number[], point: Vec3, radius: number): boolean {
  for (const index of triangles) {
    const [a, b, c] = triAt(positions, index);
    if (triHitsSphere(a, b, c, point, radius)) return true;
  }
  return false;
}
