/**
 * Smooth shading for the plate mesh in Prepare and Pose: where the normals come from, and how they are carried onto the
 * plate mesh, and the views' side: a geometry takes the exact normals in place. This module loads with Model's code,
 * Pose's, or the background call (src/app/plate-shading-warm.ts); the first chunk holds only the hooks it fills
 * (src/plate-shading.ts). Only the `normal` attribute of a drawn geometry changes: `position`, the triangles, picking
 * (three.js works the face normal of a hit out of the positions) and everything drawn on the surface stay as they were.
 *
 * A part made in Model (or read from STEP) is drawn there from its plate mesh: the mesh that is committed, sliced,
 * exported and read by Stress, Auto ribs, the checks, picking and paint. Lit as a triangle soup, each of its triangles
 * is flat, so a fillet or a cylinder shows its facets, where Model draws the same part smooth. This module gives the
 * views the exact surface normal at each corner of the plate mesh's own triangles, so the same triangles are shaded
 * smooth. The plate mesh itself is never changed or replaced: what is picked, painted, measured, sliced and saved is
 * the same array, and nothing here is saved with a project.
 *
 * Where the normals come from:
 * - The kernel's reply to a Model view request (`meshQuality: "display"`) carries `plateNormals`, the exact normals at
 *   the corners of its plate mesh, beside that mesh. A commit hands them to the plate mesh it makes (`giveShading`) in
 *   the same synchronous step.
 * - A part with a solid but no normals yet (a project opened, a STEP import) gets them from one stateless kernel call
 *   on that solid (src/app/plate-shading-warm.ts). The answer only ever reaches this table, keyed by the plate mesh's
 *   own array, so it cannot touch another mesh, the plate, undo or the slice.
 * - A part without a solid (an STL or 3MF mesh) has none. Nor has a part past the background call's budget
 *   (src/app/plate-shading-warm.ts), or a split piece until it is saved. Such a mesh is shaded from its own triangles
 *   instead (src/mesh-crease.ts): smooth, but hard across an edge sharper than CREASE_DEG, the angle Pose draws its edge
 *   lines at. Exact normals that arrive later take over in place.
 *
 * The plate mesh may not be the kernel's mesh corner for corner: the commit closes cracks between faces (which splits
 * triangles) and settles the part onto Z = 0. So the normals are carried over by place (`transferNormals`): each plate
 * corner takes the normal of the nearest source triangle that faces the same way, interpolated across that triangle.
 * Where the two meshes are the same corner for corner, the normals are copied as they are.
 */

import * as THREE from "three";
import { base64ToBytes } from "./base64.ts";
import { creasedNormals } from "./mesh-crease.ts";
import { plateShading } from "./plate-shading.ts";

/** What a plate mesh is shaded from: a triangle soup of the same solid with the exact normal at each of its corners. */
export interface ShadeSource {
  positions: Float32Array;
  normals: Float32Array;
  /** How far apart the two meshes may lie, millimetres: a little over the chord they were both meshed to. */
  reachMm: number;
}

/** How close a plate corner must lie to the source mesh, at least, millimetres. */
export const MIN_REACH_MM = 0.05;

/** The reach for meshes made to `chordMm`. Two meshes of one surface to one chord lie within about two chords. */
export function reachFor(chordMm: number): number {
  return Math.max(MIN_REACH_MM, (Number.isFinite(chordMm) && chordMm > 0 ? chordMm : 0.1) * 2.5);
}

/** A source triangle must face within this of the plate triangle (60 degrees), so a corner on a sharp edge takes its own face's normal. */
const FACING_COS = 0.5;

/** A plate mesh whose corners are not this close to the source, all but this share, is another shape: it is not shaded. */
const MATCHED_SHARE = 0.98;

const sources = new WeakMap<Float32Array, ShadeSource>();
const derived = new WeakMap<Float32Array, Float32Array | null>();
const listeners = new Set<() => void>();
const recent: { positions: Float32Array; source: ShadeSource }[] = [];
const RECENT = 64;

/** Plate mesh `positions` is shaded from `source`. Nothing else about the mesh changes. */
export function giveShading(positions: Float32Array, source: ShadeSource): void {
  if (positions.length < 9 || source.positions.length < 9 || source.normals.length !== source.positions.length) return;
  sources.set(positions, source);
  derived.delete(positions);
  const at = recent.findIndex((row) => row.positions === positions);
  if (at >= 0) recent.splice(at, 1);
  recent.push({ positions, source });
  if (recent.length > RECENT) recent.shift();
  for (const listener of listeners) listener();
}

/**
 * Plate mesh `plate`, made from `solid`'s plate mesh (cracks closed, settled), is shaded from the normals the same
 * reply carried. Nothing when the reply had none (a request that did not ask, an older kernel, a stand-in).
 */
export function shadeFromSolid(plate: Float32Array, solid: { positions: Float32Array; display?: { plateNormals?: unknown } }, chordMm: number): void {
  const normals = plateNormalsOf(solid.display?.plateNormals, solid.positions.length);
  if (normals) giveShading(plate, { positions: solid.positions, normals, reachMm: reachFor(chordMm) });
}

/** `display.plateNormals` as the kernel sent it (base64, or bytes from a binary reply): `count` f32, or null. */
export function plateNormalsOf(raw: unknown, count: number): Float32Array | null {
  const bytes = typeof raw === "string" ? base64ToBytes(raw) : raw instanceof Uint8Array ? raw : null;
  return bytes && bytes.byteLength === count * 4 ? new Float32Array(bytes.slice().buffer) : null;
}

/** True when `positions` has a source to be shaded from, as given or as a copy of a mesh that has one. */
export function hasShadeSource(positions: Float32Array): boolean {
  return sourceOf(plateOf(positions)) !== null;
}

/** The plate mesh `positions` stands for: itself, or the mesh it is a uniformly scaled copy of. */
function plateOf(positions: Float32Array): Float32Array {
  return plateShading.aliases.get(positions) ?? positions;
}

/** `copy` is `of` scaled uniformly about a point (or the same numbers): it is shaded with the same normals. */
export function aliasShading(copy: Float32Array, of: Float32Array): void {
  if (copy !== of) plateShading.aliases.set(copy, of);
}

/** Called after a plate mesh gets a source, so a view can shade a mesh it already draws. Returns the unsubscribe. */
export function onShading(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The normal at each corner of `positions` (three numbers a corner, in its order), for drawing only; null when it has
 * no source, or the source is not this shape. Worked out once per array.
 */
export function shadingOf(positions: Float32Array): Float32Array | null {
  const plate = plateOf(positions);
  if (derived.has(plate)) return derived.get(plate) ?? null;
  const source = sourceOf(plate);
  if (!source) return null;
  const made = transferNormals(plate, source.positions, source.normals, source.reachMm);
  const normals = made ? made.normals : null;
  derived.set(plate, normals);
  return normals;
}

/** A mesh with no exact normals is shaded smooth from its own triangles, but hard across an edge sharper than this: the angle Pose draws its edge lines at. */
export const CREASE_DEG = 30;

const creased = new WeakMap<Float32Array, Float32Array>();

/** The normals `positions` is shaded with when it has no exact ones (src/mesh-crease.ts). Worked out once per array. */
export function creaseOf(positions: Float32Array): Float32Array {
  const plate = plateOf(positions);
  let normals = creased.get(plate);
  if (!normals) {
    normals = creasedNormals(plate, CREASE_DEG);
    creased.set(plate, normals);
  }
  return normals;
}

/**
 * True when `geometry` (built on `positions`) now carries the exact normals. Already shaded is true, and costs nothing.
 * Without exact normals it is given the creased ones (isCreased), and false: exact ones that come later replace them.
 */
export function shadeGeometry(geometry: THREE.BufferGeometry, positions: Float32Array): boolean {
  if (geometry.userData.plateShaded === true) return true;
  const normals = shadingOf(positions);
  if (normals && normals.length === positions.length) {
    geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    geometry.userData.plateShaded = true;
    geometry.userData.plateCreased = false;
    return true;
  }
  if (geometry.userData.plateCreased !== true && positions.length >= 9) {
    const own = creaseOf(positions);
    if (own.length === positions.length) {
      geometry.setAttribute("normal", new THREE.BufferAttribute(own, 3));
      geometry.userData.plateCreased = true;
    }
  }
  return false;
}

/** A new geometry on `positions`: the exact normals when the array has them, else the creased ones from its own triangles. */
export function plateGeometry(positions: Float32Array): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  if (!shadeGeometry(geometry, positions) && !isCreased(geometry)) geometry.computeVertexNormals();
  return geometry;
}

/** True when the geometry was given the exact normals. */
export function isShaded(geometry: THREE.BufferGeometry): boolean {
  return geometry.userData.plateShaded === true;
}

/** True when the geometry has no exact normals and is shaded from its own triangles instead. */
export function isCreased(geometry: THREE.BufferGeometry): boolean {
  return geometry.userData.plateShaded !== true && geometry.userData.plateCreased === true;
}

/** What a view reports for one geometry: `smooth` (exact normals), `crease` (its own triangles'), or `flat`. */
export function shadingKind(geometry: THREE.BufferGeometry): "smooth" | "crease" | "flat" {
  return isShaded(geometry) ? "smooth" : isCreased(geometry) ? "crease" : "flat";
}

// The first chunk's views (Prepare) hand their geometries over through src/plate-shading.ts: each new one is shaded as
// it is made, those drawn already are shaded now and whenever normals arrive, and each view reports what it shows.
let reporting = false;
function report() {
  if (reporting) return;
  reporting = true;
  queueMicrotask(() => {
    reporting = false;
    for (const view of plateShading.views) {
      const [selected, ...others] = view.meshes();
      view.canvas.dataset.plateShading = selected ? shadingKind(selected[1]) : "";
      view.canvas.dataset.plateShadedOthers = String(others.filter((row) => row && isShaded(row[1])).length);
      view.canvas.dataset.plateCreasedOthers = String(others.filter((row) => row && isCreased(row[1])).length);
    }
  });
}
function refreshViews() {
  for (const view of plateShading.views) {
    for (const row of view.meshes()) if (row) shadeGeometry(row[1], row[0]);
    view.render();
  }
  report();
}
plateShading.shade = (geometry, positions) => {
  shadeGeometry(geometry, positions);
  report();
};
onShading(refreshViews);
if (typeof window !== "undefined") refreshViews();

function sourceOf(positions: Float32Array): ShadeSource | null {
  const known = sources.get(positions);
  if (known) return known;
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const row = recent[i]!;
    if (row.positions.length !== positions.length || !sameNumbers(row.positions, positions)) continue;
    sources.set(positions, row.source);
    return row.source;
  }
  return null;
}

function sameNumbers(a: Float32Array, b: Float32Array): boolean {
  const x = new Uint32Array(a.buffer, a.byteOffset, a.length);
  const y = new Uint32Array(b.buffer, b.byteOffset, b.length);
  for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return false;
  return true;
}

export interface Transferred {
  /** Three a corner, in the order of the target's corners. */
  normals: Float32Array;
  /** Corners that found a source triangle; the others keep their own triangle's normal. */
  matched: number;
  /** True when the two meshes were the same corner for corner, and the normals were copied. */
  copied: boolean;
}

/**
 * The normal at each corner of `target` from `source` and its corner normals: the nearest source triangle within
 * `reachMm` that faces the same way as the target triangle (a corner on a sharp edge so keeps its own face), its
 * normals interpolated at the nearest point. The source may be offset from the target (a part settled onto the bed):
 * the two are lined up by their boxes first. Null when the two are not one shape: boxes of other sizes, or fewer than
 * 98 in 100 corners near the source.
 */
export function transferNormals(target: Float32Array, source: Float32Array, sourceNormals: Float32Array, reachMm: number): Transferred | null {
  const tCount = Math.floor(target.length / 9);
  const sCount = Math.floor(source.length / 9);
  if (tCount === 0 || sCount === 0 || sourceNormals.length < sCount * 9) return null;
  const tBox = boxOf(target);
  const sBox = boxOf(source);
  const shift = [0, 0, 0];
  for (let a = 0; a < 3; a += 1) {
    if (Math.abs(tBox[a + 3]! - tBox[a]! - (sBox[a + 3]! - sBox[a]!)) > reachMm) return null;
    shift[a] = tBox[a]! - sBox[a]!;
  }
  // The same mesh, moved at most: the normals as they are, but for a corner whose normal faces away from its own
  // triangle (Open CASCADE turns the normal over at a sphere's pole, where the surface has none of its own).
  if (target.length === source.length) {
    let same = true;
    for (let i = 0; i < target.length && same; i += 1) if (Math.abs(target[i]! - (source[i]! + shift[i % 3]!)) > 1e-4) same = false;
    if (same) {
      const normals = Float32Array.from(sourceNormals.subarray(0, target.length));
      const own = new Float64Array(3);
      let matched = tCount * 3;
      for (let t = 0; t < tCount; t += 1) {
        faceNormal(target, t * 9, own, 0);
        for (let k = 0; k < 3; k += 1) {
          const at = t * 9 + k * 3;
          if (normals[at]! * own[0]! + normals[at + 1]! * own[1]! + normals[at + 2]! * own[2]! >= 0) continue;
          normals[at] = own[0]!;
          normals[at + 1] = own[1]!;
          normals[at + 2] = own[2]!;
          matched -= 1;
        }
      }
      return { normals, matched, copied: true };
    }
  }

  // Source triangles, moved onto the target, with their unit normals.
  const s = new Float64Array(sCount * 9);
  for (let i = 0; i < sCount * 9; i += 1) s[i] = source[i]! + shift[i % 3]!;
  const sNormal = new Float64Array(sCount * 3);
  for (let t = 0; t < sCount; t += 1) faceNormal(s, t * 9, sNormal, t * 3);

  // A grid of cells, each listing the source triangles whose box (grown by the reach) touches it.
  let extent = 0;
  for (let t = 0; t < sCount; t += 1) {
    const o = t * 9;
    for (let a = 0; a < 3; a += 1) {
      const lo = Math.min(s[o + a]!, s[o + 3 + a]!, s[o + 6 + a]!);
      const hi = Math.max(s[o + a]!, s[o + 3 + a]!, s[o + 6 + a]!);
      extent += hi - lo;
    }
  }
  const lo = [tBox[0]! - reachMm, tBox[1]! - reachMm, tBox[2]! - reachMm];
  const span = [0, 1, 2].map((a) => tBox[a + 3]! - tBox[a]! + 2 * reachMm);
  let cell = Math.max(extent / (sCount * 3), reachMm * 2, 1e-3);
  // At most about two million cells.
  while ((Math.floor(span[0]! / cell) + 1) * (Math.floor(span[1]! / cell) + 1) * (Math.floor(span[2]! / cell) + 1) > 2_000_000) cell *= 1.5;
  let n: [number, number, number] = [1, 1, 1];
  const cellOf = (value: number, a: number) => Math.min(n[a]! - 1, Math.max(0, Math.floor((value - lo[a]!) / cell)));
  const ranges = new Int32Array(sCount * 6);
  let counts = new Int32Array(1);
  // Long thin triangles (a flat face with many holes) touch many cells: past about sixteen million entries the cells grow.
  for (;;) {
    n = span.map((value) => Math.floor(value / cell) + 1) as [number, number, number];
    let total = 0;
    for (let t = 0; t < sCount; t += 1) {
      const o = t * 9;
      for (let a = 0; a < 3; a += 1) {
        ranges[t * 6 + a] = cellOf(Math.min(s[o + a]!, s[o + 3 + a]!, s[o + 6 + a]!) - reachMm, a);
        ranges[t * 6 + 3 + a] = cellOf(Math.max(s[o + a]!, s[o + 3 + a]!, s[o + 6 + a]!) + reachMm, a);
      }
      total += (ranges[t * 6 + 3]! - ranges[t * 6]! + 1) * (ranges[t * 6 + 4]! - ranges[t * 6 + 1]! + 1) * (ranges[t * 6 + 5]! - ranges[t * 6 + 2]! + 1);
    }
    if (total <= 16_000_000 || n[0] * n[1] * n[2] <= 1) break;
    cell *= 1.6;
  }
  counts = new Int32Array(n[0] * n[1] * n[2] + 1);
  for (let t = 0; t < sCount; t += 1) {
    for (let z = ranges[t * 6 + 2]!; z <= ranges[t * 6 + 5]!; z += 1)
      for (let y = ranges[t * 6 + 1]!; y <= ranges[t * 6 + 4]!; y += 1)
        for (let x = ranges[t * 6]!; x <= ranges[t * 6 + 3]!; x += 1) counts[x + n[0] * (y + n[1] * z) + 1]! += 1;
  }
  for (let i = 1; i < counts.length; i += 1) counts[i]! += counts[i - 1]!;
  const fill = counts.slice(0, counts.length - 1);
  const items = new Int32Array(counts[counts.length - 1]!);
  for (let t = 0; t < sCount; t += 1) {
    for (let z = ranges[t * 6 + 2]!; z <= ranges[t * 6 + 5]!; z += 1)
      for (let y = ranges[t * 6 + 1]!; y <= ranges[t * 6 + 4]!; y += 1)
        for (let x = ranges[t * 6]!; x <= ranges[t * 6 + 3]!; x += 1) items[fill[x + n[0] * (y + n[1] * z)]!++] = t;
  }

  const normals = new Float32Array(tCount * 9);
  const own = new Float64Array(3);
  const bary = new Float64Array(4);
  const one = new Float64Array(9);
  let matched = 0;
  for (let t = 0; t < tCount; t += 1) {
    for (let i = 0; i < 9; i += 1) one[i] = target[t * 9 + i]!;
    faceNormal(one, 0, own, 0);
    for (let k = 0; k < 3; k += 1) {
      const px = one[k * 3]!, py = one[k * 3 + 1]!, pz = one[k * 3 + 2]!;
      const c = cellOf(px, 0) + n[0] * (cellOf(py, 1) + n[1] * cellOf(pz, 2));
      let best = -1;
      let bestScore = Infinity;
      let bu = 0, bv = 0, bw = 0;
      for (let at = counts[c]!; at < counts[c + 1]!; at += 1) {
        const st = items[at]!;
        const facing = sNormal[st * 3]! * own[0]! + sNormal[st * 3 + 1]! * own[1]! + sNormal[st * 3 + 2]! * own[2]!;
        if (facing < FACING_COS) continue;
        nearestOnTriangle(s, st * 9, px, py, pz, bary);
        const d = Math.sqrt(bary[3]!);
        if (d > reachMm) continue;
        // Nearer wins; of two at one distance (a corner on an edge), the one facing more nearly the same way.
        const score = d + reachMm * (1 - facing);
        if (score < bestScore) {
          bestScore = score;
          best = st;
          bu = bary[0]!;
          bv = bary[1]!;
          bw = bary[2]!;
        }
      }
      const out = t * 9 + k * 3;
      if (best >= 0) {
        const o = best * 9;
        let nx = bu * sourceNormals[o]! + bv * sourceNormals[o + 3]! + bw * sourceNormals[o + 6]!;
        let ny = bu * sourceNormals[o + 1]! + bv * sourceNormals[o + 4]! + bw * sourceNormals[o + 7]!;
        let nz = bu * sourceNormals[o + 2]! + bv * sourceNormals[o + 5]! + bw * sourceNormals[o + 8]!;
        const len = Math.hypot(nx, ny, nz);
        if (len > 1e-9 && (nx * own[0]! + ny * own[1]! + nz * own[2]!) / len >= FACING_COS) {
          nx /= len;
          ny /= len;
          nz /= len;
          normals[out] = nx;
          normals[out + 1] = ny;
          normals[out + 2] = nz;
          matched += 1;
          continue;
        }
      }
      normals[out] = own[0]!;
      normals[out + 1] = own[1]!;
      normals[out + 2] = own[2]!;
    }
  }
  if (matched < tCount * 3 * MATCHED_SHARE) return null;
  return { normals, matched, copied: false };
}

function boxOf(p: Float32Array): number[] {
  const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < p.length; i += 3) {
    for (let a = 0; a < 3; a += 1) {
      const v = p[i + a]!;
      if (v < box[a]!) box[a] = v;
      if (v > box[a + 3]!) box[a + 3] = v;
    }
  }
  return box;
}

/** The unit normal of the triangle at `p[o..o+9]`, wound counterclockwise, into `out[at..at+3]`; zero for no area. */
function faceNormal(p: ArrayLike<number>, o: number, out: Float64Array, at: number) {
  const ux = p[o + 3]! - p[o]!, uy = p[o + 4]! - p[o + 1]!, uz = p[o + 5]! - p[o + 2]!;
  const vx = p[o + 6]! - p[o]!, vy = p[o + 7]! - p[o + 1]!, vz = p[o + 8]! - p[o + 2]!;
  const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
  const len = Math.hypot(x, y, z);
  out[at] = len > 0 ? x / len : 0;
  out[at + 1] = len > 0 ? y / len : 0;
  out[at + 2] = len > 0 ? z / len : 0;
}

/**
 * The nearest point of triangle `s[o..o+9]` to (px, py, pz), as barycentric weights of its corners in `out[0..3]` and
 * the squared distance in `out[3]` (Ericson, Real-Time Collision Detection, 5.1.5).
 */
function nearestOnTriangle(s: Float64Array, o: number, px: number, py: number, pz: number, out: Float64Array) {
  const ax = s[o]!, ay = s[o + 1]!, az = s[o + 2]!;
  const abx = s[o + 3]! - ax, aby = s[o + 4]! - ay, abz = s[o + 5]! - az;
  const acx = s[o + 6]! - ax, acy = s[o + 7]! - ay, acz = s[o + 8]! - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  let u: number, v: number, w: number;
  if (d1 <= 0 && d2 <= 0) {
    u = 1; v = 0; w = 0;
  } else {
    const bpx = px - s[o + 3]!, bpy = py - s[o + 4]!, bpz = pz - s[o + 5]!;
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    const cpx = px - s[o + 6]!, cpy = py - s[o + 7]!, cpz = pz - s[o + 8]!;
    const d5 = abx * cpx + aby * cpy + abz * cpz;
    const d6 = acx * cpx + acy * cpy + acz * cpz;
    const vc = d1 * d4 - d3 * d2;
    const vb = d5 * d2 - d1 * d6;
    const va = d3 * d6 - d5 * d4;
    if (d3 >= 0 && d4 <= d3) {
      u = 0; v = 1; w = 0;
    } else if (vc <= 0 && d1 >= 0 && d3 <= 0) {
      const t = d1 / (d1 - d3);
      u = 1 - t; v = t; w = 0;
    } else if (d6 >= 0 && d5 <= d6) {
      u = 0; v = 0; w = 1;
    } else if (vb <= 0 && d2 >= 0 && d6 <= 0) {
      const t = d2 / (d2 - d6);
      u = 1 - t; v = 0; w = t;
    } else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
      const t = (d4 - d3) / (d4 - d3 + (d5 - d6));
      u = 0; v = 1 - t; w = t;
    } else {
      const denom = va + vb + vc;
      if (Math.abs(denom) < 1e-30) {
        u = 1; v = 0; w = 0;
      } else {
        v = vb / denom;
        w = vc / denom;
        u = 1 - v - w;
      }
    }
  }
  const qx = ax + abx * v + acx * w, qy = ay + aby * v + acy * w, qz = az + abz * v + acz * w;
  out[0] = u;
  out[1] = v;
  out[2] = w;
  out[3] = (px - qx) ** 2 + (py - qy) ** 2 + (pz - qz) ** 2;
}
