/**
 * Picks for Close a loop (L3b). A cylindrical face keeps its axis. Two coaxial cylinders share one
 * point along that axis, so a pin closes where the parts stand. A click on a flat face beside a
 * hole snaps to the hole's cylinder, at the plate's mid-thickness.
 */
import type { ParsedSolid } from "./model-reply.ts";
import { applyPose, inversePose, turnDir, type Affine } from "./model-space.ts";
import type { Vec3 } from "./model-tree.ts";
import { fitCircle, type Circle } from "./measure-snap.ts";
import { cylinderJoint } from "./pose-cylinder.ts";

export interface AxisPick { at: Vec3; axis: Vec3 }
export interface LoopFacePick { at: Vec3; axis: Vec3; kind: "hole" | "pin"; diameterMm: number }

/** Axes this close in angle, and this close as lines, are one axis. */
const COAXIAL_ANGLE_DEG = 1;
const COAXIAL_GAP_MM = 0.5;
/** A click inside a hole, or this close to its rim, snaps to the hole. */
const HOLE_SNAP_MM = 1;
/** An edge bounds the clicked face when its samples sit on that face's outline. */
const BOUND_MM = 0.5;
const PLANE_MM = 0.35;

type V = readonly [number, number, number];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: V, b: V): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V, b: V): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const cross = (a: V, b: V): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V): Vec3 | null => {
  const l = len(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : null;
};

/**
 * `b.at` in b's frame: the foot of a's point on b's axis, when the two cylinder axes are parallel
 * within 1° and within 0.5 mm. Null leaves today's midpoint. The same foot is a line closure's point.
 */
export function coaxialPinAt(a: AxisPick, aPose: Affine, b: AxisPick, bPose: Affine): Vec3 | null {
  const aDir = turnDir(aPose, a.axis);
  const bDir = turnDir(bPose, b.axis);
  if (len(aDir) < 1e-8 || len(bDir) < 1e-8) return null;
  if (Math.abs(dot(aDir, bDir)) < Math.cos(COAXIAL_ANGLE_DEG * Math.PI / 180) - 1e-12) return null;
  const aAt = applyPose(aPose, a.at);
  const bAt = applyPose(bPose, b.at);
  const gap = len(cross(sub(aAt, bAt), bDir));
  if (gap > COAXIAL_GAP_MM + 1e-6) return null;
  const t = dot(sub(aAt, bAt), bDir);
  return applyPose(inversePose(bPose), add(bAt, scale(bDir, t)));
}

export function loopPickStatus(kind: "hole" | "pin", diameterMm: number, name: string): string {
  const tenths = Math.round(diameterMm * 10) / 10;
  const text = Number.isInteger(tenths) ? String(tenths) : tenths.toFixed(1);
  return `${kind === "hole" ? "Hole" : "Pin"} Ø${text} on ${name}`;
}

function pointAt(positions: ArrayLike<number>, index: number): Vec3 {
  const o = index * 3;
  return [positions[o]!, positions[o + 1]!, positions[o + 2]!];
}

/** Outward normal points toward the axis on a hole, and away from it on a pin. */
function cylinderKind(solid: ParsedSolid, face: number, axisPoint: Vec3, axis: Vec3): "hole" | "pin" {
  const pos = solid.positions;
  for (let i = 0; i < solid.triangles.length; i += 1) {
    if (solid.triangles[i] !== face) continue;
    const a = pointAt(pos, i * 3);
    const b = pointAt(pos, i * 3 + 1);
    const c = pointAt(pos, i * 3 + 2);
    const normal = cross(sub(b, a), sub(c, a));
    if (len(normal) < 1e-8) continue;
    const mid = scale(add(add(a, b), c), 1 / 3);
    const rel = sub(mid, axisPoint);
    const radial = sub(rel, scale(axis, dot(rel, axis)));
    if (len(radial) < 1e-6) continue;
    return dot(normal, radial) < 0 ? "hole" : "pin";
  }
  return "pin";
}

function facePlane(solid: ParsedSolid, face: number): { normal: Vec3; point: Vec3 } | null {
  const row = solid.faces[face];
  if (!row || row.surface) return null;
  let point: Vec3 | null = null;
  for (let i = 0; i < solid.triangles.length; i += 1) {
    if (solid.triangles[i] !== face) continue;
    point = pointAt(solid.positions, i * 3);
    break;
  }
  if (!point) return null;
  const given = row.normal ? unit(row.normal) : null;
  if (given) return { normal: given, point };
  for (let i = 0; i < solid.triangles.length; i += 1) {
    if (solid.triangles[i] !== face) continue;
    const a = pointAt(solid.positions, i * 3);
    const b = pointAt(solid.positions, i * 3 + 1);
    const c = pointAt(solid.positions, i * 3 + 2);
    const normal = unit(cross(sub(b, a), sub(c, a)));
    if (normal) return { normal, point: a };
  }
  return null;
}

/** Outline segments of one face: triangle edges that no second triangle of the face shares. */
function boundaryOf(solid: ParsedSolid, face: number): [Vec3, Vec3][] {
  const counts = new Map<string, { a: Vec3; b: Vec3; n: number }>();
  const key = (p: Vec3) => `${Math.round(p[0] * 1e3)},${Math.round(p[1] * 1e3)},${Math.round(p[2] * 1e3)}`;
  for (let i = 0; i < solid.triangles.length; i += 1) {
    if (solid.triangles[i] !== face) continue;
    const v = [0, 1, 2].map((k) => pointAt(solid.positions, i * 3 + k));
    for (let e = 0; e < 3; e += 1) {
      const a = v[e]!;
      const b = v[(e + 1) % 3]!;
      const ka = key(a);
      const kb = key(b);
      const id = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const row = counts.get(id);
      if (row) row.n += 1;
      else counts.set(id, { a, b, n: 1 });
    }
  }
  const out: [Vec3, Vec3][] = [];
  for (const row of counts.values()) if (row.n === 1) out.push([row.a, row.b]);
  return out;
}

function segmentDistance(p: Vec3, a: Vec3, b: Vec3): number {
  const ab = sub(b, a);
  const length2 = dot(ab, ab);
  if (length2 < 1e-12) return len(sub(p, a));
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / length2));
  return len(sub(p, add(a, scale(ab, t))));
}

function onBoundary(points: ArrayLike<number>, boundary: readonly [Vec3, Vec3][]): boolean {
  const count = Math.floor(points.length / 3);
  if (!boundary.length || count === 0) return false;
  for (let i = 0; i < count; i += 1) {
    const p = pointAt(points, i);
    let best = Infinity;
    for (const [a, b] of boundary) best = Math.min(best, segmentDistance(p, a, b));
    if (best > BOUND_MM) return false;
  }
  return true;
}

function lineGap(point: V, origin: V, direction: V): number {
  return len(cross(sub(point, origin), direction));
}

/** The cylinder face this circle is the rim of, or -1. */
function cylinderOf(solid: ParsedSolid, circle: Circle): number {
  let best = -1;
  let score = Infinity;
  for (let face = 0; face < solid.faces.length; face += 1) {
    const row = solid.faces[face]!;
    if (row.surface !== "cylinder" || !row.radiusMm || !row.axis || !row.axisPoint) continue;
    const axis = unit(row.axis);
    if (!axis) continue;
    if (Math.abs(dot(axis, circle.normal)) < Math.cos(COAXIAL_ANGLE_DEG * Math.PI / 180)) continue;
    if (Math.abs(row.radiusMm - circle.radius) > Math.max(0.25, circle.radius * 0.03)) continue;
    const gap = lineGap(circle.centre, row.axisPoint, axis);
    if (gap > 0.35) continue;
    const miss = Math.abs(row.radiusMm - circle.radius) + gap;
    if (miss < score) { score = miss; best = face; }
  }
  return best;
}

interface HoleCandidate { circle: Circle; face: number; rim: number }

/** Closed chains of a face outline. A faceted hole is one of these, not one analytic edge. */
function boundaryLoops(boundary: readonly [Vec3, Vec3][]): Vec3[][] {
  const key = (p: V) => `${Math.round(p[0] * 1e3)},${Math.round(p[1] * 1e3)},${Math.round(p[2] * 1e3)}`;
  const next = new Map<string, { at: Vec3; to: string }[]>();
  for (const [a, b] of boundary) {
    const from = key(a);
    const list = next.get(from) ?? [];
    list.push({ at: a, to: key(b) });
    next.set(from, list);
  }
  const used = new Set<string>();
  const loops: Vec3[][] = [];
  for (const [start, outs] of next) {
    for (const first of outs) {
      const id = `${start}>${first.to}`;
      if (used.has(id)) continue;
      const loop: Vec3[] = [first.at];
      used.add(id);
      let cur = first.to;
      let guard = 0;
      while (cur !== start && guard < boundary.length + 2) {
        guard += 1;
        const step = (next.get(cur) ?? []).find((row) => !used.has(`${cur}>${row.to}`));
        if (!step) break;
        used.add(`${cur}>${step.to}`);
        loop.push(step.at);
        cur = step.to;
      }
      if (cur === start && loop.length >= 6) loops.push(loop);
    }
  }
  return loops;
}

function coversPoint(solid: ParsedSolid, face: number, point: Vec3): boolean {
  const pos = solid.positions;
  for (let i = 0; i < solid.triangles.length; i += 1) {
    if (solid.triangles[i] !== face) continue;
    const a = pointAt(pos, i * 3);
    const b = pointAt(pos, i * 3 + 1);
    const c = pointAt(pos, i * 3 + 2);
    const ab = sub(b, a);
    const ac = sub(c, a);
    const ap = sub(point, a);
    const d00 = dot(ab, ab);
    const d01 = dot(ab, ac);
    const d11 = dot(ac, ac);
    const d20 = dot(ap, ab);
    const d21 = dot(ap, ac);
    const den = d00 * d11 - d01 * d01;
    if (den < 1e-8) continue;
    const v = (d11 * d20 - d01 * d21) / den;
    const w = (d00 * d21 - d01 * d20) / den;
    if (v >= -0.02 && w >= -0.02 && v + w <= 1.02) return true;
  }
  return false;
}

/** A hole: the plate is just outside the circle and open just inside it. One sample can land in a crack or off the end of the plate, so several directions count. The outer rim fails this: material inside the circle, nothing outside. `radial` is a unit vector in the plane. */
function isOpening(solid: ParsedSolid, face: number, circle: Circle, radial: Vec3): boolean {
  const normal = unit(circle.normal);
  const axis = normal ? unit(cross(normal, radial)) : null;
  if (!axis) return false;
  let opened = false;
  for (let k = 0; k < 8; k += 1) {
    const ang = (k / 8) * Math.PI * 2;
    const dir = unit(add(scale(radial, Math.cos(ang)), scale(axis, Math.sin(ang))));
    if (!dir) continue;
    const inward = add(circle.centre, scale(dir, Math.max(0, circle.radius - 0.3)));
    const outside = add(circle.centre, scale(dir, circle.radius + 0.3));
    const inn = coversPoint(solid, face, inward);
    const out = coversPoint(solid, face, outside);
    if (inn && !out) return false;
    if (!inn && out) opened = true;
  }
  return opened;
}

/** The circle's centre, moved to halfway through the plate. */
function midThickness(solid: ParsedSolid, plane: { normal: Vec3; point: Vec3 }, centre: V): Vec3 {
  const onPlane = add(centre, scale(plane.normal, -dot(sub(centre, plane.point), plane.normal)));
  let gap: number | null = null;
  for (let face = 0; face < solid.faces.length; face += 1) {
    const other = facePlane(solid, face);
    if (!other || dot(other.normal, plane.normal) > -0.99) continue;
    const dist = dot(sub(other.point, plane.point), plane.normal);
    if (dist >= -0.2) continue;
    if (gap === null || dist > gap) gap = dist;
  }
  return gap === null ? onPlane : add(onPlane, scale(plane.normal, gap / 2));
}

/**
 * What a click picked. A cylinder is itself. A planar face snaps to the nearest circular edge that
 * bounds it, when the hit is inside that circle or within 1 mm of it. Anything else is null, and
 * the click keeps today's refusal.
 */
export function pickLoopFace(solid: ParsedSolid, face: number, hit: Vec3): LoopFacePick | null {
  const row = solid.faces[face];
  if (!row) return null;
  if (row.surface === "cylinder") {
    const joint = cylinderJoint(solid, face);
    if (!joint || !row.radiusMm) return null;
    return { at: joint.pivot, axis: joint.axis, kind: cylinderKind(solid, face, joint.pivot, joint.axis), diameterMm: row.radiusMm * 2 };
  }
  const plane = facePlane(solid, face);
  if (!plane) return null;
  if (Math.abs(dot(sub(hit, plane.point), plane.normal)) > PLANE_MM) return null;
  const boundary = boundaryOf(solid, face);
  const held: { best: HoleCandidate | null } = { best: null };
  const consider = (circle: Circle, onFace: boolean) => {
    if (Math.abs(dot(circle.normal, plane.normal)) < Math.cos(COAXIAL_ANGLE_DEG * Math.PI / 180)) return;
    if (Math.abs(dot(sub(circle.centre, plane.point), plane.normal)) > PLANE_MM) return;
    const flat = sub(sub(hit, circle.centre), scale(plane.normal, dot(sub(hit, circle.centre), plane.normal)));
    const radial = len(flat);
    if (radial > circle.radius + HOLE_SNAP_MM) return;
    const rim = Math.abs(radial - circle.radius);
    const wall = cylinderOf(solid, circle);
    if (wall < 0 && !onFace) return;
    const best = held.best;
    if (!best || rim < best.rim - 1e-6 || (Math.abs(rim - best.rim) <= 1e-6 && circle.radius < best.circle.radius)) held.best = { circle, face: wall, rim };
  };
  for (const edge of solid.edges) {
    const circle = fitCircle(edge.points);
    if (!circle || !onBoundary(edge.points, boundary)) continue;
    consider(circle, false);
  }
  if (!held.best) {
    const away = unit(cross(plane.normal, Math.abs(plane.normal[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
    const loops = boundaryLoops(boundary);
    for (const loop of loops) {
      const flat: number[] = [];
      for (const point of loop) flat.push(point[0], point[1], point[2]);
      const circle = fitCircle(new Float32Array(flat));
      if (!circle || !away || !isOpening(solid, face, circle, away)) continue;
      consider(circle, true);
    }
  }
  const best = held.best;
  if (!best) return null;
  if (best.face >= 0) {
    const joint = cylinderJoint(solid, best.face);
    const wall = solid.faces[best.face];
    if (!joint || !wall?.radiusMm) return null;
    return { at: joint.pivot, axis: joint.axis, kind: cylinderKind(solid, best.face, joint.pivot, joint.axis), diameterMm: wall.radiusMm * 2 };
  }
  const axis = unit(best.circle.normal);
  if (!axis) return null;
  return { at: midThickness(solid, plane, best.circle.centre), axis, kind: "hole", diameterMm: best.circle.radius * 2 };
}
