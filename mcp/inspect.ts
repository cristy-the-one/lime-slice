/**
 * Looking at a solid without rendering it: where a ray lands, what a probe would change, and
 * what a print would trip over. All of it reads the tessellated mesh in the part frame, whose
 * chord tolerance is 0.05 mm, so a number here is that close and no closer.
 */
import { shellCount, shellGroups, takeGroups } from "../src/mesh-shells.ts";
import { eulerOrient } from "../src/mesh-place.ts";
import { primitiveMesh, turnCentre, type PrimitiveSpec } from "../src/model-primitive.ts";

type Vec = [number, number, number];
export interface Box {
  min: Vec;
  max: Vec;
}

const round = (value: number, places = 3) => Math.round(value * 10 ** places) / 10 ** places;
const roundVec = (v: readonly number[]): Vec => [round(v[0]!), round(v[1]!), round(v[2]!)];

export function boxOf(pos: ArrayLike<number>): Box {
  const min: Vec = [Infinity, Infinity, Infinity];
  const max: Vec = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < pos.length; i += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = pos[i + axis]!;
      if (value < min[axis]!) min[axis] = value;
      if (value > max[axis]!) max[axis] = value;
    }
  }
  return { min, max };
}

/** The tool shape of a boolean op as a triangle soup in the solid's frame: turned about its centre, then placed. */
export function toolMesh(spec: PrimitiveSpec): Float32Array {
  const local = primitiveMesh(spec);
  const centre = turnCentre(spec);
  const rot = eulerOrient(spec.turn[0], spec.turn[1], spec.turn[2]);
  const out = new Float32Array(local.length);
  for (let i = 0; i + 2 < local.length; i += 3) {
    const dx = local[i]! - centre[0];
    const dy = local[i + 1]! - centre[1];
    const dz = local[i + 2]! - centre[2];
    out[i] = spec.origin[0] + centre[0] + rot[0] * dx + rot[1] * dy + rot[2] * dz;
    out[i + 1] = spec.origin[1] + centre[1] + rot[3] * dx + rot[4] * dy + rot[5] * dz;
    out[i + 2] = spec.origin[2] + centre[2] + rot[6] * dx + rot[7] * dy + rot[8] * dz;
  }
  return out;
}

export interface Hit {
  triangle: number;
  distanceMm: number;
  point: Vec;
  normal: Vec;
  /** The ray starts inside the solid: it met a face from behind. */
  fromInside: boolean;
}

/** The first triangle a ray meets, Möller–Trumbore. `direction` need not be a unit vector. */
export function firstHit(pos: Float32Array, origin: Vec, direction: Vec): Hit | null {
  const length = Math.hypot(direction[0], direction[1], direction[2]);
  if (!(length > 0)) return null;
  const d: Vec = [direction[0] / length, direction[1] / length, direction[2] / length];
  let best: Hit | null = null;
  for (let tri = 0; tri * 9 + 8 < pos.length; tri += 1) {
    const b = tri * 9;
    const e1: Vec = [pos[b + 3]! - pos[b]!, pos[b + 4]! - pos[b + 1]!, pos[b + 5]! - pos[b + 2]!];
    const e2: Vec = [pos[b + 6]! - pos[b]!, pos[b + 7]! - pos[b + 1]!, pos[b + 8]! - pos[b + 2]!];
    const p: Vec = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
    const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
    if (Math.abs(det) < 1e-12) continue;
    const s: Vec = [origin[0] - pos[b]!, origin[1] - pos[b + 1]!, origin[2] - pos[b + 2]!];
    const u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) / det;
    if (u < -1e-9 || u > 1 + 1e-9) continue;
    const q: Vec = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
    const v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) / det;
    if (v < -1e-9 || u + v > 1 + 1e-9) continue;
    const t = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det;
    if (t < 0 || (best && t >= best.distanceMm)) continue;
    const n: Vec = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const nl = Math.hypot(n[0], n[1], n[2]);
    if (!(nl > 0)) continue;
    const normal: Vec = [n[0] / nl, n[1] / nl, n[2] / nl];
    best = {
      triangle: tri,
      distanceMm: t,
      point: [origin[0] + d[0] * t, origin[1] + d[1] * t, origin[2] + d[2] * t],
      normal,
      fromInside: normal[0] * d[0] + normal[1] * d[1] + normal[2] * d[2] > 0,
    };
  }
  return best;
}

function vec3(value: unknown): Vec | null {
  return Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === "number" && Number.isFinite(n)) ? value as Vec : null;
}

/** surface_at: the first hit of a ray, or of a straight-down ray at x, y. */
export function surfaceAt(
  solid: { positions: Float32Array; triangles: Uint32Array; bounds: Box },
  input: Record<string, unknown>,
): Record<string, unknown> {
  const point = vec3(input.point);
  const direction = input.direction === undefined ? null : vec3(input.direction);
  if (input.direction !== undefined && (!direction || !(Math.hypot(...direction) > 0))) return { ok: false, reason: "The direction needs three numbers that are not all zero." };
  let origin: Vec;
  let aim: Vec;
  if (point) {
    if (!direction) return { ok: false, reason: "A point needs a direction." };
    origin = point;
    aim = direction;
  } else if (typeof input.x === "number" && typeof input.y === "number") {
    // Straight down from just above the part, unless the caller aims it.
    origin = [input.x, input.y, solid.bounds.max[2] + 1];
    aim = direction ?? [0, 0, -1];
  } else {
    return { ok: false, reason: "Give a point and a direction, or x and y." };
  }
  const hit = firstHit(solid.positions, origin, aim);
  if (!hit) return { ok: true, hit: false, reason: "The ray misses the solid." };
  const face = solid.triangles.length * 9 === solid.positions.length ? solid.triangles[hit.triangle] : undefined;
  return {
    ok: true,
    hit: true,
    point: roundVec(hit.point),
    normal: roundVec(hit.normal),
    distanceMm: round(hit.distanceMm),
    ...(face !== undefined ? { faceIndex: face } : {}),
    ...(hit.fromInside ? { fromInside: true } : {}),
  };
}

export interface SolidMetrics {
  volumeMm3: number;
  bbox: Box;
  shellCount: number;
}

export function solidMetrics(solid: { positions: Float32Array; volumeMm3: number }): SolidMetrics {
  return { volumeMm3: solid.volumeMm3, bbox: boxOf(solid.positions), shellCount: shellCount(solid.positions) };
}

const shown = (m: SolidMetrics) => ({
  volumeMm3: round(m.volumeMm3, 2),
  bbox: { min: roundVec(m.bbox.min), max: roundVec(m.bbox.max) },
  shellCount: m.shellCount,
});

/**
 * What a probe tells beside "it fits". `after` is null when the engine sent no mesh for the edit, and then
 * only `before` is real: the result names what is missing instead of guessing it.
 */
export function probeMetrics(before: SolidMetrics, after: SolidMetrics | null): { metrics: Record<string, unknown>; warning?: string } {
  if (!after) {
    return {
      metrics: {
        before: shown(before),
        unavailable: ["volumeAfter", "bboxAfter", "shellCountAfter", "delta"],
        note: "The modeler sent no mesh for this edit, so only the solid before it is measured.",
      },
    };
  }
  const delta = {
    volumeMm3: round(after.volumeMm3 - before.volumeMm3, 2),
    bboxMin: roundVec(after.bbox.min.map((v, i) => v - before.bbox.min[i]!)),
    bboxMax: roundVec(after.bbox.max.map((v, i) => v - before.bbox.max[i]!)),
    shellCount: after.shellCount - before.shellCount,
  };
  const warning = after.shellCount > before.shellCount ? `This leaves ${after.shellCount} separate pieces.` : undefined;
  return { metrics: { before: shown(before), after: shown(after), delta }, ...(warning ? { warning } : {}) };
}

export interface CheckInput {
  positions: Float32Array;
  overhangDeg: number;
  buildMm: Vec;
}

const BED_EPS = 0.02;

/** model_check: the printability of the solid as it stands, lowest point on the bed. */
export function printCheck(input: CheckInput): Record<string, unknown> {
  const { positions: pos, overhangDeg, buildMm } = input;
  const box = boxOf(pos);
  const floor = box.min[2];
  const sine = Math.sin((overhangDeg * Math.PI) / 180);
  const cell = 10;
  const cells = new Map<string, { area: number; sum: Vec; min: Vec; max: Vec }>();
  const levels = new Map<number, { area: number; sum: Vec }>();
  let total = 0;
  let overhang = 0;
  let bed = 0;
  for (let tri = 0; tri * 9 + 8 < pos.length; tri += 1) {
    const b = tri * 9;
    const e1: Vec = [pos[b + 3]! - pos[b]!, pos[b + 4]! - pos[b + 1]!, pos[b + 5]! - pos[b + 2]!];
    const e2: Vec = [pos[b + 6]! - pos[b]!, pos[b + 7]! - pos[b + 1]!, pos[b + 8]! - pos[b + 2]!];
    const n: Vec = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const twice = Math.hypot(n[0], n[1], n[2]);
    if (!(twice > 0)) continue;
    const area = twice / 2;
    const nz = n[2] / twice;
    total += area;
    const z0 = pos[b + 2]!;
    const z1 = pos[b + 5]!;
    const z2 = pos[b + 8]!;
    const centre: Vec = [
      (pos[b]! + pos[b + 3]! + pos[b + 6]!) / 3,
      (pos[b + 1]! + pos[b + 4]! + pos[b + 7]!) / 3,
      (z0 + z1 + z2) / 3,
    ];
    const onBed = Math.max(z0, z1, z2) <= floor + BED_EPS;
    if (onBed && nz < -0.9) {
      bed += area;
      continue;
    }
    if (-nz <= sine) continue;
    overhang += area;
    const key = `${Math.floor(centre[0] / cell)},${Math.floor(centre[1] / cell)},${Math.floor(centre[2] / cell)}`;
    const slot = cells.get(key) ?? { area: 0, sum: [0, 0, 0], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    slot.area += area;
    for (let axis = 0; axis < 3; axis += 1) {
      slot.sum[axis]! += centre[axis]! * area;
      slot.min[axis] = Math.min(slot.min[axis]!, pos[b + axis]!, pos[b + 3 + axis]!, pos[b + 6 + axis]!);
      slot.max[axis] = Math.max(slot.max[axis]!, pos[b + axis]!, pos[b + 3 + axis]!, pos[b + 6 + axis]!);
    }
    cells.set(key, slot);
    if (nz < -0.99) {
      const level = round(centre[2], 1);
      const row = levels.get(level) ?? { area: 0, sum: [0, 0, 0] };
      row.area += area;
      row.sum[0]! += centre[0] * area;
      row.sum[1]! += centre[1] * area;
      levels.set(level, row);
    }
  }
  const regions = [...cells.values()]
    .sort((a, b) => b.area - a.area)
    .slice(0, 6)
    .map((slot) => ({
      areaMm2: round(slot.area, 1),
      centre: roundVec([slot.sum[0]! / slot.area, slot.sum[1]! / slot.area, slot.sum[2]! / slot.area]),
      min: roundVec(slot.min),
      max: roundVec(slot.max),
    }));
  const ceilings = [...levels.entries()]
    .filter(([, row]) => row.area >= 1)
    .sort((a, b) => b[1].area - a[1].area)
    .slice(0, 6)
    .map(([z, row]) => ({ zMm: z, areaMm2: round(row.area, 1), centre: roundVec([row.sum[0]! / row.area, row.sum[1]! / row.area, z]) }));
  const groups = shellGroups(pos);
  const islands: { bbox: { min: Vec; max: Vec }; floatsMm: number }[] = [];
  if (groups) {
    for (const part of takeGroups(pos, groups.groups)) {
      const shell = boxOf(part);
      if (shell.min[2] > floor + BED_EPS) islands.push({ bbox: { min: roundVec(shell.min), max: roundVec(shell.max) }, floatsMm: round(shell.min[2] - floor) });
    }
  }
  const size: Vec = [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];
  const over = (["x", "y", "z"] as const).filter((_, axis) => size[axis]! > buildMm[axis]! + 1e-6);
  const warnings: string[] = [];
  if (over.length > 0) warnings.push(`The part is larger than the build volume along ${over.join(" and ").toUpperCase()}.`);
  if (islands.length > 0) warnings.push(`${islands.length === 1 ? "One piece does" : `${islands.length} pieces do`} not touch the bed and would print in the air.`);
  if (ceilings.length > 0) warnings.push(`Flat faces point down above the bed at Z ${ceilings.map((row) => row.zMm).join(", ")}; they need support or a bridge.`);
  if (overhang > 0 && total > 0) warnings.push(`${round(overhang, 1)} mm² overhangs more than ${overhangDeg}°.`);
  if (!(bed > 0)) warnings.push("Nothing flat rests on the bed.");
  return {
    ok: true,
    overhang: { thresholdDeg: overhangDeg, areaMm2: round(overhang, 1), share: total > 0 ? round(overhang / total, 3) : 0, regions },
    ceilings,
    bedContact: { areaMm2: round(bed, 1) },
    islands,
    fit: { sizeMm: roundVec(size), buildVolumeMm: buildMm, fits: over.length === 0, over },
    warnings,
    notChecked: ["thin walls"],
  };
}
