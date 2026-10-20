/**
 * Face and edge filters. Centres and edge mids are in the part frame, millimetres.
 * A direction matches either way along the edge.
 */
import { pointTriangleDistance } from "../src/modeling/frames.ts";

import type { EdgeRow, FaceRow } from "./solid-geometry.ts";

type Vec3 = [number, number, number];

function readVec(value: unknown): Vec3 | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const xyz = value.slice(0, 3);
  if (!xyz.every((item) => typeof item === "number" && Number.isFinite(item))) return null;
  return [xyz[0] as number, xyz[1] as number, xyz[2] as number];
}

function unit(value: Vec3): Vec3 | null {
  const len = Math.hypot(value[0], value[1], value[2]);
  if (len < 1e-12) return null;
  return [value[0] / len, value[1] / len, value[2] / len];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
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

/** Degrees between two directions. Faces use the signed angle; edges match either way. */
function directedDeg(a: Vec3, b: Vec3): number {
  const cos = Math.min(1, Math.max(-1, dot(a, b)));
  return (Math.acos(cos) * 180) / Math.PI;
}

function undirectedDeg(a: Vec3, b: Vec3): number {
  const cos = Math.min(1, Math.max(-1, Math.abs(dot(a, b))));
  return (Math.acos(cos) * 180) / Math.PI;
}

function within(input: Record<string, unknown>, aimed: boolean): number | { reason: string } {
  if (!aimed && input.withinDeg === undefined) return 180;
  const value = input.withinDeg === undefined ? 5 : input.withinDeg;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 180) {
    return { reason: "withinDeg must be from 0 to 180." };
  }
  return value;
}

function onPlane(point: Vec3, face: FaceRow): boolean {
  if (!face.normal) return false;
  return Math.abs(dot(sub(point, face.centre), face.normal)) <= 0.05;
}

function inBox(point: Vec3, face: FaceRow): boolean {
  const slack = 0.05;
  return point.every((value, axis) => value >= face.bbox.min[axis] - slack && value <= face.bbox.max[axis] + slack);
}

export function edgeOnFace(edge: EdgeRow, face: FaceRow): boolean {
  return onPlane(edge.start, face) && onPlane(edge.end, face) && inBox(edge.start, face) && inBox(edge.end, face);
}

function boxDistance(point: Vec3, face: FaceRow): number {
  let sum = 0;
  for (let axis = 0; axis < 3; axis += 1) {
    const value = point[axis];
    const low = face.bbox.min[axis];
    const high = face.bbox.max[axis];
    const gap = value < low ? low - value : value > high ? value - high : 0;
    sum += gap * gap;
  }
  return Math.sqrt(sum);
}

/** A point just outside a convex corner is outside every face plane. */
function insidePlanes(point: Vec3, faces: readonly FaceRow[]): boolean {
  for (const face of faces) {
    if (!face.normal || face.kind !== "plane") continue;
    if (dot(sub(point, face.centre), face.normal) > 0.02) return false;
  }
  return true;
}

function convexEdge(edge: EdgeRow, faces: readonly FaceRow[]): boolean | null {
  const touching = faces.filter((face) => face.kind === "plane" && face.normal && edgeOnFace(edge, face));
  if (touching.length < 2) return null;
  const left = touching[0]!.normal!;
  const right = touching[1]!.normal!;
  const outward = unit(add(left, right));
  if (!outward) return null;
  const step = 0.05;
  const outside = add(edge.mid, scale(outward, step));
  const inside = sub(edge.mid, scale(outward, step));
  return !insidePlanes(outside, faces) && insidePlanes(inside, faces);
}

/** The nearest distance from `point` to each face's triangles, in mm. */
function faceDistances(point: Vec3, mesh: { positions: ArrayLike<number>; triangles: ArrayLike<number> }, wanted: ReadonlySet<number>): Map<number, number> {
  const gap = new Map<number, number>();
  const count = Math.min(mesh.triangles.length, Math.floor(mesh.positions.length / 9));
  for (let tri = 0; tri < count; tri += 1) {
    const face = mesh.triangles[tri]!;
    if (!wanted.has(face)) continue;
    const at = tri * 9;
    const p = mesh.positions;
    const d = pointTriangleDistance(point, [p[at]!, p[at + 1]!, p[at + 2]!], [p[at + 3]!, p[at + 4]!, p[at + 5]!], [p[at + 6]!, p[at + 7]!, p[at + 8]!]);
    if (d < (gap.get(face) ?? Infinity)) gap.set(face, d);
  }
  return gap;
}

/**
 * The faces that match `input`. --- 3.1 F13. With `nearPoint` every match is kept, nearest first by the distance from
 * the point to the face itself (`distanceMm`), larger faces first on a tie: a box around a curved or slanted face held
 * points nowhere near it, and a point a little off every face matched none. Without the mesh, the faces' boxes stand in.
 */
export function facesMatching(faces: readonly FaceRow[], input: Record<string, unknown>, mesh?: { positions: ArrayLike<number>; triangles: ArrayLike<number> }): (FaceRow & { distanceMm?: number })[] | { reason: string } {
  const aimed = input.normal !== undefined;
  const normal = aimed ? readVec(input.normal) : null;
  if (aimed && !normal) return { reason: "normal is three numbers." };
  const direction = normal ? unit(normal) : null;
  if (normal && !direction) return { reason: "normal needs a direction." };
  const span = within(input, aimed);
  if (typeof span !== "number") return span;
  if (input.kind !== undefined && !["plane", "cylinder", "cone", "sphere", "other"].includes(String(input.kind))) return { reason: "kind is plane, cylinder, cone, sphere, or other." };
  if (input.areaMinMm2 !== undefined && (typeof input.areaMinMm2 !== "number" || !(input.areaMinMm2 >= 0))) {
    return { reason: "areaMinMm2 must be a number of square millimetres." };
  }
  const near = input.nearPoint !== undefined ? readVec(input.nearPoint) : null;
  if (input.nearPoint !== undefined && !near) return { reason: "nearPoint is three numbers." };
  const matched = faces.filter((face) => {
    if (direction) {
      if (!face.normal) return false;
      const faceDir = unit(face.normal);
      if (!faceDir || directedDeg(faceDir, direction) > span) return false;
    }
    if (input.kind && face.kind !== input.kind) return false;
    if (typeof input.areaMinMm2 === "number" && face.areaMm2 < input.areaMinMm2) return false;
    return true;
  });
  if (!near) return matched;
  const gap = mesh ? faceDistances(near, mesh, new Set(matched.map((face) => face.index))) : null;
  const distance = (face: FaceRow) => gap?.get(face.index) ?? boxDistance(near, face);
  return matched
    .map((face) => ({ ...face, distanceMm: Math.round(distance(face) * 1000) / 1000 }))
    .sort((a, b) => a.distanceMm - b.distanceMm || b.areaMm2 - a.areaMm2);
}

export function edgesMatching(
  edges: readonly EdgeRow[],
  faces: readonly FaceRow[],
  input: Record<string, unknown>,
): EdgeRow[] | { reason: string } {
  const aimed = input.direction !== undefined;
  const raw = aimed ? readVec(input.direction) : null;
  if (aimed && !raw) return { reason: "direction is three numbers." };
  const direction = raw ? unit(raw) : null;
  if (raw && !direction) return { reason: "direction needs a direction." };
  const span = within(input, aimed);
  if (typeof span !== "number") return span;
  if (input.lengthMinMm !== undefined && (typeof input.lengthMinMm !== "number" || !(input.lengthMinMm >= 0))) {
    return { reason: "lengthMinMm must be a number of millimetres." };
  }
  if (input.convex !== undefined && typeof input.convex !== "boolean") return { reason: "convex must be true or false." };
  let on: FaceRow | undefined;
  if (input.onFace !== undefined) {
    if (typeof input.onFace !== "number" || !Number.isInteger(input.onFace)) return { reason: "onFace is a face index, or a flat face selector {normal, withinDeg, nearPoint}." };
    on = faces.find((face) => face.index === input.onFace);
    if (!on) return { reason: "That face is not on this solid." };
  }
  return edges.filter((edge) => {
    if (direction) {
      if (!edge.dir) return false;
      const edgeDir = unit(edge.dir);
      if (!edgeDir || undirectedDeg(edgeDir, direction) > span) return false;
    }
    if (typeof input.lengthMinMm === "number" && edge.lengthMm < input.lengthMinMm) return false;
    if (on && !edgeOnFace(edge, on)) return false;
    if (typeof input.convex === "boolean" && convexEdge(edge, faces) !== input.convex) return false;
    return true;
  });
}
