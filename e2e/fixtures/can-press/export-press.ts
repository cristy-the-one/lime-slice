/**
 * Build the can press from mcp/fixtures/can-press/can_press.rs and write the browser fixture.
 * Run after OCCT and lime-mcp-engine are built:
 *   OCCT_ROOT=... LIME_OCCT_BRIDGE=... LIME_LUST=... node --experimental-strip-types --no-warnings e2e/fixtures/can-press/export-press.ts
 * The owner's can-press project is never read. Closures are left off, so the Joint tool is what closes the loops.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { closeLoop, closureGapMm } from "../../../src/pose-loops.ts";
import type { ParsedSolid } from "../../../src/model-reply.ts";
import { applyPose, type Affine } from "../../../src/model-space.ts";
import type { Vec3 } from "../../../src/model-tree.ts";
import { coaxialPinAt, loopPickStatus, pickLoopFace } from "../../../src/pose-loop-pick.ts";
import { engineCandidates, loadEngineWorker } from "../../../mcp/engine.ts";
import { findLust } from "../../../mcp/recipe.ts";
import { Session } from "../../../mcp/session.ts";
import type { PlateObject } from "../../../mcp/session/shared.ts";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const bridge = process.env.LIME_OCCT_BRIDGE ?? "";
const addon = engineCandidates(root).find((path) => existsSync(path)) ?? "";
if (!bridge || !addon || !findLust()) {
  console.error("export-press needs LIME_OCCT_BRIDGE, lime-mcp-engine, and lust");
  process.exit(1);
}

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-press-fixture-"));
process.env.LIME_MCP_MODEL_TIMEOUT_S = process.env.LIME_MCP_MODEL_TIMEOUT_S ?? "180";

const session = new Session(loadEngineWorker(root));
const source = readFileSync(join(root, "mcp/fixtures/can-press/can_press.rs"), "utf8");
const built = await session.call("recipe_run", { source, name: "lever-can-press" });
if (built.ok !== true) {
  console.error(built.reason ?? built.diagnostics ?? built);
  process.exit(1);
}
const assembly = session.assemblies[0];
if (!assembly) {
  console.error("the recipe left no assembly");
  process.exit(1);
}

const vsub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vadd = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const vscale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const vcross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const vlen = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const vunit = (a: Vec3): Vec3 | null => {
  const l = vlen(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : null;
};

function b64(values: ArrayLike<number>, kind: "f32" | "u32"): string {
  const bytes = kind === "f32"
    ? new Uint8Array(Float32Array.from(values).buffer)
    : new Uint8Array(Uint32Array.from(values).buffer);
  return Buffer.from(bytes).toString("base64");
}

function parsedOf(row: PlateObject): ParsedSolid {
  const view = row.solid;
  if (!view || view.positions.length < 9) throw new Error(`${row.name} has no solid`);
  const lengthOf = new Map(view.edges.map((edge) => [edge.index, edge.lengthMm]));
  return {
    id: view.id,
    volumeMm3: view.volumeMm3,
    positions: view.positions,
    triangles: view.triangles,
    faces: view.faces.map((face) => {
      const curved = face.kind === "cylinder" || face.kind === "cone" || face.kind === "sphere" ? face.kind : null;
      return {
        id: face.index,
        areaMm2: face.areaMm2,
        ...(face.normal ? { normal: face.normal } : {}),
        ...(curved && face.radiusMm ? { surface: curved, radiusMm: face.radiusMm, ...(face.axis && face.axisPoint ? { axis: face.axis, axisPoint: face.axisPoint } : {}) } : {}),
      };
    }),
    edges: view.lines.map((line) => ({ id: line.edge, lengthMm: lengthOf.get(line.edge) ?? 0, points: line.points })),
    fingerprint: view.fingerprint,
    editable: view.editable,
  };
}

function wireOf(solid: ParsedSolid) {
  return {
    volumeMm3: solid.volumeMm3,
    positionsB64: b64(solid.positions, "f32"),
    trianglesB64: b64(solid.triangles, "u32"),
    faces: solid.faces.map((face) => ({
      id: face.id,
      areaMm2: face.areaMm2,
      ...(face.normal ? { normal: face.normal } : {}),
      ...(face.surface ? { surface: face.surface, radiusMm: face.radiusMm, axisPoint: face.axisPoint, axis: face.axis } : {}),
    })),
    edges: solid.edges.map((edge) => ({ id: edge.id, lengthMm: edge.lengthMm, pointsB64: b64(edge.points, "f32") })),
  };
}

const byName = new Map(session.objects.map((object) => [object.name, object as PlateObject]));
const nameOf = new Map(session.objects.map((object) => [object.id, object.name]));
const poseOf = (id: string): Affine | undefined => byName.get(nameOf.get(id) ?? "")?.modelPose;

function axisExtent(solid: ParsedSolid, face: number, axis: Vec3, origin: Vec3): { lo: number; hi: number } {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < solid.triangles.length; i += 1) {
    if (solid.triangles[i] !== face) continue;
    for (let v = 0; v < 3; v += 1) {
      const at = (i * 3 + v) * 3;
      const t = axis[0] * (solid.positions[at]! - origin[0]) + axis[1] * (solid.positions[at + 1]! - origin[1]) + axis[2] * (solid.positions[at + 2]! - origin[2]);
      lo = Math.min(lo, t);
      hi = Math.max(hi, t);
    }
  }
  return { lo, hi };
}

/** Triangles in a grid, so a ray test reads the cells it crosses instead of every triangle of the press. */
class MeshAccel {
  pos: Float32Array;
  min: Vec3;
  dims: Vec3;
  cell: number;
  buckets: number[][];
  constructor(pos: Float32Array, cell = 12) {
    this.pos = pos;
    this.cell = cell;
    const lo: Vec3 = [Infinity, Infinity, Infinity];
    const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) for (let a = 0; a < 3; a += 1) {
      lo[a] = Math.min(lo[a], pos[i + a]!);
      hi[a] = Math.max(hi[a], pos[i + a]!);
    }
    this.min = lo.map((v) => v - cell) as unknown as Vec3;
    this.dims = [0, 1, 2].map((a) => Math.max(1, Math.ceil((hi[a]! - lo[a]! + 2 * cell) / cell))) as unknown as Vec3;
    this.buckets = Array.from({ length: this.dims[0] * this.dims[1] * this.dims[2] }, () => []);
    const tris = pos.length / 9;
    for (let t = 0; t < tris; t += 1) {
      const b0: Vec3 = [Infinity, Infinity, Infinity];
      const b1: Vec3 = [-Infinity, -Infinity, -Infinity];
      for (let v = 0; v < 3; v += 1) for (let a = 0; a < 3; a += 1) {
        const value = pos[t * 9 + v * 3 + a]!;
        b0[a] = Math.min(b0[a], value);
        b1[a] = Math.max(b1[a], value);
      }
      const c0 = b0.map((v, a) => Math.max(0, Math.min(this.dims[a] - 1, Math.floor((v - this.min[a]) / cell))));
      const c1 = b1.map((v, a) => Math.max(0, Math.min(this.dims[a] - 1, Math.floor((v - this.min[a]) / cell))));
      for (let ix = c0[0]!; ix <= c1[0]!; ix += 1) for (let iy = c0[1]!; iy <= c1[1]!; iy += 1) for (let iz = c0[2]!; iz <= c1[2]!; iz += 1) {
        this.buckets[(ix * this.dims[1] + iy) * this.dims[2] + iz]!.push(t);
      }
    }
  }
  /** Closest hit distance along `dir` (unit), or null. `maxT` stops the walk. The camera starts outside the grid. */
  hit(origin: Vec3, dir: Vec3, maxT: number): number | null {
    const maxBound = this.min.map((v, a) => v + this.dims[a] * this.cell) as unknown as Vec3;
    let tEnter = 0;
    let tLeave = maxT;
    for (let a = 0; a < 3; a += 1) {
      if (Math.abs(dir[a]) < 1e-12) {
        if (origin[a] < this.min[a] || origin[a] > maxBound[a]) return null;
        continue;
      }
      let ta = (this.min[a] - origin[a]) / dir[a];
      let tb = (maxBound[a] - origin[a]) / dir[a];
      if (ta > tb) { const swap = ta; ta = tb; tb = swap; }
      tEnter = Math.max(tEnter, ta);
      tLeave = Math.min(tLeave, tb);
      if (tEnter > tLeave) return null;
    }
    const into = Math.max(tEnter, 0) + 1e-3;
    if (into >= tLeave) return null;
    const from = vadd(origin, vscale(dir, into));
    const start: number[] = [0, 1, 2].map((a) => Math.min(this.dims[a] - 1, Math.max(0, Math.floor((from[a] - this.min[a]) / this.cell))));
    const step = dir.map((v) => (v >= 0 ? 1 : -1));
    const next = (index: number, a: number) => {
      const boundary = this.min[a] + (index + (step[a]! > 0 ? 1 : 0)) * this.cell;
      return Math.abs(dir[a]) < 1e-12 ? Infinity : (boundary - origin[a]) / dir[a];
    };
    const delta = dir.map((v) => (Math.abs(v) < 1e-12 ? Infinity : this.cell / Math.abs(v)));
    let [ix, iy, iz] = start;
    let [tx, ty, tz] = [0, 1, 2].map((a) => next([ix, iy, iz][a]!, a));
    let best: number | null = null;
    const seen = new Set<number>();
    for (let guard = 0; guard < 400; guard += 1) {
      const bucket = this.buckets[(ix * this.dims[1] + iy) * this.dims[2] + iz];
      if (bucket) for (const t of bucket) {
        if (seen.has(t)) continue;
        seen.add(t);
        const o = t * 9;
        const ax = this.pos[o]!, ay = this.pos[o + 1]!, az = this.pos[o + 2]!;
        const bx = this.pos[o + 3]!, by = this.pos[o + 4]!, bz = this.pos[o + 5]!;
        const cx = this.pos[o + 6]!, cy = this.pos[o + 7]!, cz = this.pos[o + 8]!;
        const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
        const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
        const px = dir[1] * e2z - dir[2] * e2y, py = dir[2] * e2x - dir[0] * e2z, pz = dir[0] * e2y - dir[1] * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-12) continue;
        const inv = 1 / det;
        const sx = origin[0] - ax, sy = origin[1] - ay, sz = origin[2] - az;
        const u = (sx * px + sy * py + sz * pz) * inv;
        if (u < -1e-6 || u > 1 + 1e-6) continue;
        const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
        const v = (dir[0] * qx + dir[1] * qy + dir[2] * qz) * inv;
        if (v < -1e-6 || u + v > 1 + 1e-6) continue;
        const dist = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (dist > 0.05 && dist < (best ?? maxT)) best = dist;
      }
      const limit = best ?? maxT;
      if (tx > limit && ty > limit && tz > limit) break;
      if (tx <= ty && tx <= tz) { ix += step[0]!; tx += delta[0]!; }
      else if (ty <= tz) { iy += step[1]!; ty += delta[1]!; }
      else { iz += step[2]!; tz += delta[2]!; }
      if (ix < 0 || iy < 0 || iz < 0 || ix >= this.dims[0] || iy >= this.dims[1] || iz >= this.dims[2]) break;
    }
    return best;
  }
}

interface Shown { name: string; accel: MeshAccel }
function firstHit(shown: readonly Shown[], origin: Vec3, dir: Vec3, maxT: number): { name: string; at: Vec3; distance: number } | null {
  let best: { name: string; distance: number } | null = null;
  for (const row of shown) {
    const distance = row.accel.hit(origin, dir, best?.distance ?? maxT);
    if (distance != null && (!best || distance < best.distance)) best = { name: row.name, distance };
  }
  return best ? { name: best.name, distance: best.distance, at: vadd(origin, vscale(dir, best.distance)) } : null;
}

/** The pose view's camera: the whole press framed, seen from `from` (aim() in src/pose-view.ts, fov 40). */
function viewCamera(bounds: { min: Vec3; max: Vec3 }, from: Vec3): Vec3 {
  const look = bounds.min.map((v, i) => (v + bounds.max[i]) / 2) as unknown as Vec3;
  const size = Math.max(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2], 1);
  const dist = ((size * Math.sqrt(3)) / 2) / Math.sin((40 * Math.PI) / 360) * 1.35;
  return vadd(look, vscale(vunit(from)!, dist));
}

/**
 * A point of `name` that the pose camera sees, and the direction to put the camera.
 * The ray is the one the view will cast: from the framed camera through `at`.
 */
function visibleLook(shown: readonly Shown[], bounds: { min: Vec3; max: Vec3 }, name: string, points: readonly Vec3[], directions: readonly Vec3[]): { at: Vec3; look: Vec3 } | null {
  let best: { at: Vec3; look: Vec3; score: number } | null = null;
  for (const look of directions) {
    if (Math.abs(vunit(look)![2]) > 0.7) continue;
    const camera = viewCamera(bounds, look);
    for (const at of points) {
      const toward = vunit(vsub(at, camera));
      if (!toward) continue;
      const reach = vlen(vsub(at, camera));
      const hit = firstHit(shown, camera, toward, reach + 2);
      if (!hit || hit.name !== name || vlen(vsub(hit.at, at)) > 1.5) continue;
      const score = hit.distance;
      if (!best || score > best.score) best = { at, look: vunit(look)!, score };
    }
    if (best) break;
  }
  return best ? { at: best.at, look: best.look } : null;
}

/** `lookFrom` that puts the pose camera on the ray arriving at `point` along `toward` (unit, pointing at the point). */
function sphereLook(bounds: { min: Vec3; max: Vec3 }, point: Vec3, toward: Vec3): Vec3 | null {
  const look = bounds.min.map((v, i) => (v + bounds.max[i]!) / 2) as unknown as Vec3;
  const size = Math.max(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2], 1);
  const dist = ((size * Math.sqrt(3)) / 2) / Math.sin((40 * Math.PI) / 360) * 1.35;
  const w = vsub(point, look);
  const b = w[0] * toward[0] + w[1] * toward[1] + w[2] * toward[2];
  const disc = b * b - (vlen(w) ** 2 - dist * dist);
  if (disc < 0) return null;
  const t = b + Math.sqrt(disc);
  if (!(t > 1)) return null;
  const camera = vsub(point, vscale(toward, t));
  return vsub(camera, look);
}

/**
 * A camera direction whose ray actually hits `name` at one of `points`.
 * A short ray first checks the point is not buried, then the same direction is placed on the view's camera sphere.
 */
function clearLook(shown: readonly Shown[], bounds: { min: Vec3; max: Vec3 }, name: string, points: readonly Vec3[], normal: Vec3): { at: Vec3; look: Vec3; ray: Vec3; incidence: number } | null {
  let best: { at: Vec3; look: Vec3; ray: Vec3; incidence: number } | null = null;
  const n = vunit(normal);
  for (const at of points) {
    for (const outward of lookGrid(normal)) {
      // A framed view of the whole press draws an edge-on plate thinner than a pixel, so the click misses. Keep a ray that meets the face.
      const incidence = n ? Math.abs(outward[0] * n[0] + outward[1] * n[1] + outward[2] * n[2]) : 0;
      if (incidence < 0.3) continue;
      const toward = vscale(outward, -1);
      const origin = vadd(at, vscale(outward, 14));
      const near = firstHit(shown, origin, toward, 18);
      if (!near || near.name !== name || vlen(vsub(near.at, at)) > 1.5) continue;
      const look = sphereLook(bounds, at, toward);
      // Straight down is parallel to the camera's up axis, so the projected pixel is not the ray through the point.
      if (!look || Math.abs(vunit(look)![2]) > 0.92) continue;
      const camera = viewCamera(bounds, look);
      const ray = vunit(vsub(camera, at));
      if (!ray) continue;
      const hit = firstHit(shown, camera, vscale(ray, -1), vlen(vsub(at, camera)) + 2);
      if (!(hit && hit.name === name && vlen(vsub(hit.at, at)) < 1.5)) continue;
      if (!best || incidence > best.incidence) best = { at, look: vunit(look)!, ray, incidence };
    }
  }
  return best;
}

function lookGrid(normal: Vec3): Vec3[] {
  const n = vunit(normal)!;
  const helper: Vec3 = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = vunit(vcross(helper, n))!;
  const v = vcross(n, u);
  const out: Vec3[] = [n];
  for (const rise of [80, 60, 45, 30, 18, 10, 5, 3, 1.5]) {
    const elev = rise * Math.PI / 180;
    for (let k = 0; k < 12; k += 1) {
      const az = (k / 12) * Math.PI * 2;
      out.push(vunit(vadd(vscale(n, Math.sin(elev)), vadd(vscale(u, Math.cos(elev) * Math.cos(az)), vscale(v, Math.cos(elev) * Math.sin(az)))))!);
    }
  }
  return out;
}

function faceBox(solid: ParsedSolid, face: number): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < solid.triangles.length; i += 1) {
    if (solid.triangles[i] !== face) continue;
    for (let v = 0; v < 3; v += 1) {
      const at = (i * 3 + v) * 3;
      for (let a = 0; a < 3; a += 1) {
        const value = solid.positions[at + a]!;
        min[a] = Math.min(min[a], value);
        max[a] = Math.max(max[a], value);
      }
    }
  }
  return { min, max };
}

/** The +Y ram-pin stub: radius about 5, axis along Y, the piece that stands out past the link. */
function pinFaceOf(solid: ParsedSolid): number {
  let best = -1;
  let bestY = -Infinity;
  for (const face of solid.faces) {
    if (face.surface !== "cylinder" || !face.radiusMm || !face.axis) continue;
    const box = faceBox(solid, face.id);
    // The pin barrel, not the thread end past the nut (that one sits further out, near r = 4.6).
    if (Math.abs(face.axis[1]) < 0.9 || face.radiusMm < 4.8 || face.radiusMm > 5.2) continue;
    if (box.max[1] < 20 || box.max[1] > 42) continue;
    if (box.max[1] > bestY) { bestY = box.max[1]; best = face.id; }
  }
  if (best < 0) throw new Error("the ram has no pin cylinder");
  return best;
}

/**
 * A point on the link's outer plate, just beside the ram-end hole.
 * The hole is a polygonal extrude, so the snap (not a cylinder face) is what finds it.
 */
function holeClick(solid: ParsedSolid, side: 1 | -1): { at: Vec3; face: number } {
  let outer = side > 0 ? -Infinity : Infinity;
  for (let i = 1; i < solid.positions.length; i += 3) {
    const y = solid.positions[i]!;
    outer = side > 0 ? Math.max(outer, y) : Math.min(outer, y);
  }
  const planes: number[] = [];
  let outerFace = -1;
  let miss = Infinity;
  for (const face of solid.faces) {
    if (face.surface || !face.normal || Math.abs(face.normal[1]) < 0.9 || face.areaMm2 < 500) continue;
    planes.push(face.id);
    if (Math.sign(face.normal[1]) !== side) continue;
    const span = axisExtent(solid, face.id, [0, 1, 0], [0, 0, 0]);
    const edge = side > 0 ? span.hi : span.lo;
    const score = Math.abs(edge - outer);
    if (score < miss) { miss = score; outerFace = face.id; }
  }
  planes.sort((a, b) => (a === outerFace ? -1 : b === outerFace ? 1 : 0));
  if (!planes.length) throw new Error("the link has no outer plate face");
  let best: { at: Vec3; pivotX: number; beside: number; face: number } | null = null;
  for (const plane of planes) {
    for (let i = 0; i < solid.triangles.length; i += 1) {
      if (solid.triangles[i] !== plane) continue;
      const mid: Vec3 = [0, 0, 0];
      for (let v = 0; v < 3; v += 1) {
        const at = (i * 3 + v) * 3;
        mid[0] += solid.positions[at]! / 3;
        mid[1] += solid.positions[at + 1]! / 3;
        mid[2] += solid.positions[at + 2]! / 3;
      }
      const picked = pickLoopFace(solid, plane, mid);
      if (picked?.kind !== "hole") continue;
      const beside = Math.hypot(mid[0] - picked.at[0], mid[2] - picked.at[2]);
      const better = !best || Math.abs(picked.at[0]) < Math.abs(best.pivotX) - 1 || (Math.abs(Math.abs(picked.at[0]) - Math.abs(best.pivotX)) <= 1 && beside < best.beside);
      if (better) best = { at: mid, pivotX: picked.at[0], beside, face: plane };
    }
    if (best && Math.abs(best.pivotX) <= 2) break;
    const box = faceBox(solid, plane);
    for (let x = -8; x <= 8; x += 1) for (let z = box.min[2]; z <= box.max[2]; z += 1.2) {
      const mid: Vec3 = [x, (box.min[1] + box.max[1]) / 2, z];
      const picked = pickLoopFace(solid, plane, mid);
      if (picked?.kind !== "hole" || Math.abs(picked.at[0]) > 2) continue;
      const beside = Math.hypot(mid[0] - picked.at[0], mid[2] - picked.at[2]);
      if (!best || Math.abs(best.pivotX) > 2 || beside < best.beside) best = { at: mid, pivotX: picked.at[0], beside, face: plane };
    }
    if (best && Math.abs(best.pivotX) <= 2) break;
  }
  if (!best || Math.abs(best.pivotX) > 2) throw new Error("the link has no ram-end hole");
  return { at: best.at, face: best.face };
}

const pickedNames = ["Link L", "Link R", "Ram"] as const;
const solids = new Map<string, ParsedSolid>();
for (const name of pickedNames) {
  const row = byName.get(name);
  if (!row) throw new Error(`missing ${name}`);
  solids.set(name, parsedOf(row));
}

function worldOf(row: PlateObject): Float32Array {
  const pose = row.modelPose ?? { m: [1, 0, 0, 0, 1, 0, 0, 0, 1] as Affine["m"], t: [0, 0, 0] as Vec3 };
  const src = row.source;
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    const at = applyPose(pose, [src[i]!, src[i + 1]!, src[i + 2]! + row.seatMm]);
    out[i] = at[0]; out[i + 1] = at[1]; out[i + 2] = at[2];
  }
  return out;
}
const shown: Shown[] = session.objects.map((object) => {
  const row = object as PlateObject;
  const pos = worldOf(row);
  return { name: row.name, accel: new MeshAccel(pos) };
});
const bounds = { min: [Infinity, Infinity, Infinity] as Vec3, max: [-Infinity, -Infinity, -Infinity] as Vec3 };
for (const row of shown) {
  const pos = row.accel.pos;
  for (let i = 0; i < pos.length; i += 3) for (let a = 0; a < 3; a += 1) {
    bounds.min[a] = Math.min(bounds.min[a], pos[i + a]!);
    bounds.max[a] = Math.max(bounds.max[a], pos[i + a]!);
  }
}

const ram = solids.get("Ram")!;
const ramRow = byName.get("Ram")!;
const ramPose = poseOf(ramRow.id)!;
const pinFace = pinFaceOf(ram);
const pinPoints: { local: Vec3; world: Vec3 }[] = [];
{
  const face = ram.faces.find((row) => row.id === pinFace)!;
  const box = faceBox(ram, pinFace);
  const axis = vunit(face.axis!)!;
  const origin = face.axisPoint!;
  const radius = face.radiusMm!;
  const side = vunit(vcross(Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], axis))!;
  const up = vcross(axis, side);
  const y0 = box.min[1];
  const y1 = box.max[1];
  // The link covers the middle of the stub. The open band is the inner gap and the hair past the plate, before the washer.
  for (const y of [y0 + 0.2, y0 + 0.45, y1 - 0.08, y1 - 0.2]) {
    const along = (y - origin[1]) / (axis[1] || 1);
    const centre = vadd(origin, vscale(axis, along));
    for (let k = 0; k < 8; k += 1) {
      const ang = (k / 8) * Math.PI * 2;
      const local = vadd(centre, vadd(vscale(side, Math.cos(ang) * radius), vscale(up, Math.sin(ang) * radius))) as Vec3;
      const picked = pickLoopFace(ram, pinFace, local);
      if (picked?.kind === "pin") pinPoints.push({ local, world: applyPose(ramPose, local) });
    }
  }
}
const pinSeen = visibleLook(shown, bounds, "Ram", pinPoints.map((row) => row.world), [[1, 0.5, 0.4], [-1, 0.5, 0.4], [0.3, 1, 0.4], [0.3, -1, 0.4], [1, -0.4, 0.3], ...lookGrid([0, 1, 0]), ...lookGrid([1, 0, 0])]);
if (!pinSeen) throw new Error("no ram pin point is visible to the pose camera");
const pinChoice = pinPoints.find((row) => vlen(vsub(row.world, pinSeen.at)) < 0.05) ?? pinPoints[0]!;
const ramPick = pickLoopFace(ram, pinFace, pinChoice.local);
if (!ramPick || ramPick.kind !== "pin") throw new Error(`ram click is not a pin: ${JSON.stringify(ramPick)}`);
const pinRay = vunit(vsub(viewCamera(bounds, pinSeen.look), pinSeen.at))!;
console.log(`ram pick ${loopPickStatus(ramPick.kind, ramPick.diameterMm, "Ram")} at ${ramPick.at.map((v) => v.toFixed(3)).join(",")} ray ${pinRay.map((v) => v.toFixed(3)).join(",")}`);

const picks = [];
let closing = { ...assembly, closures: [] as NonNullable<typeof assembly.closures> };
for (const name of ["Link L", "Link R"] as const) {
  const solid = solids.get(name)!;
  const row = byName.get(name)!;
  const pose = poseOf(row.id)!;
  const side = name.endsWith("L") ? 1 : -1;
  const hit = holeClick(solid, side);
  const seed = pickLoopFace(solid, hit.face, hit.at);
  if (!seed || seed.kind !== "hole") throw new Error(`${name} click is not a hole`);
  const faces = [hit.face];
  for (const face of solid.faces) {
    if (face.surface || !face.normal || Math.sign(face.normal[1] ?? 0) === side || Math.abs(face.normal[1] ?? 0) < 0.9) continue;
    faces.push(face.id);
    break;
  }
  let seen: { at: Vec3; look: Vec3; ray: Vec3; incidence: number } | null = null;
  let holePoints: Vec3[] = [];
  let planeFace = hit.face;
  for (const face of faces) {
    const normal: Vec3 = solid.faces.find((row) => row.id === face)?.normal ?? [0, side, 0];
    const plateY = face === hit.face ? hit.at[1] : (faceBox(solid, face).min[1] + faceBox(solid, face).max[1]) / 2;
    holePoints = face === hit.face ? [hit.at] : [];
    const radius = seed.diameterMm / 2 + 0.45;
    for (let k = 0; k < 12; k += 1) {
      const ang = (k / 12) * Math.PI * 2;
      const local: Vec3 = [seed.at[0] + Math.cos(ang) * radius, plateY, seed.at[2] + Math.sin(ang) * radius];
      const snapped = pickLoopFace(solid, face, local);
      if (snapped?.kind === "hole" && vlen(vsub(snapped.at, seed.at)) < 1) holePoints.push(local);
    }
    for (let i = 0; i < solid.triangles.length; i += 1) {
      if (solid.triangles[i] !== face) continue;
      const mid: Vec3 = [0, 0, 0];
      for (let v = 0; v < 3; v += 1) {
        const at = (i * 3 + v) * 3;
        mid[0] += solid.positions[at]! / 3;
        mid[1] += solid.positions[at + 1]! / 3;
        mid[2] += solid.positions[at + 2]! / 3;
      }
      const snapped = pickLoopFace(solid, face, mid);
      if (snapped?.kind === "hole" && vlen(vsub(snapped.at, seed.at)) < 1) holePoints.push(mid);
    }
    if (!holePoints.length) continue;
    seen = clearLook(shown, bounds, name, holePoints.map((local) => applyPose(pose, local)), normal);
    if (seen) { planeFace = face; break; }
  }
  if (!seen) throw new Error(`${name}: no point beside the hole is visible. The nuts may cover the whole snap ring.`);
  const localHit = holePoints.find((local) => vlen(vsub(applyPose(pose, local), seen.at)) < 0.05) ?? holePoints[0]!;
  const hole = pickLoopFace(solid, planeFace, localHit);
  if (!hole || hole.kind !== "hole") throw new Error(`${name} click is not a hole: ${JSON.stringify(hole)}`);
  const foot = coaxialPinAt({ at: hole.at, axis: hole.axis }, pose, { at: ramPick.at, axis: ramPick.axis }, ramPose);
  if (!foot) throw new Error(`${name} and the ram pin are not coaxial`);
  const closed = closeLoop(
    closing,
    { member: row.id, at: hole.at, to: ramRow.id, toAt: foot },
    (id) => nameOf.get(id) ?? id,
    poseOf,
  );
  if ("reason" in closed) throw new Error(`${name} did not close: ${closed.reason}`);
  closing = closed.assembly;
  const gap = closureGapMm(closing, poseOf);
  const holeRay = vunit(vsub(viewCamera(bounds, seen.look), seen.at))!;
  console.log(`${name} ${loopPickStatus(hole.kind, hole.diameterMm, name)} click ${localHit.map((v) => v.toFixed(3)).join(",")} incidence ${seen.incidence.toFixed(2)} ray ${holeRay.map((v) => v.toFixed(3)).join(",")} foot ${foot.map((v) => v.toFixed(3)).join(",")} gap ${gap}`);
  if (gap > 0.01) throw new Error(`${name} closure gap ${gap} mm`);
  picks.push({
    link: name,
    holeAt: localHit,
    holeLook: seen.look,
    holeRay,
    holeStatus: loopPickStatus(hole.kind, hole.diameterMm, name),
    pinAt: pinChoice.local,
    pinLook: pinSeen.look,
    pinRay,
    pinStatus: loopPickStatus(ramPick.kind, ramPick.diameterMm, "Ram"),
    solverGapMm: gap,
  });
}

const parts = session.objects.map((object) => {
  const row = object as PlateObject;
  const keep = solids.get(row.name);
  return {
    name: row.name,
    seatMm: row.seatMm,
    triangles: row.triangles,
    positionsB64: b64(row.source, "f32"),
    ...(keep ? { solid: wireOf(keep) } : {}),
  };
});

const members = assembly.members.map((member) => ({
  ...member,
  object: nameOf.get(member.object) ?? member.object,
  parent: member.parent ? (nameOf.get(member.parent) ?? member.parent) : null,
}));

const out = {
  source: "mcp/fixtures/can-press/can_press.rs",
  parts,
  members,
  picks,
};
const dest = join(dirname(fileURLToPath(import.meta.url)), "press.json");
mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, JSON.stringify(out));
console.log(`wrote ${dest} (${(Buffer.byteLength(JSON.stringify(out)) / 1e6).toFixed(2)} MB) parts=${parts.length}`);
for (const part of parts) console.log(`  ${part.name} seat=${part.seatMm} meshFloats=${part.triangles * 9} solid=${part.solid ? "yes" : "mesh only"}`);
process.exit(0);
