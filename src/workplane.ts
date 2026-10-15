/**
 * A local workplane: Creo-style U, V, W in model space (`docs/local-workplane.md`).
 *
 * U and V span the plane. W is its normal, and the direction a sketch extrudes or a hole cuts along.
 * The global frame is U = X, V = Y, W = Z at the model origin. Tools type in this frame; `toSolidOp`
 * still stores the resolved op in the solid's own frame. An identity frame returns the numbers it was given.
 */
import { eulerOrient, orientEuler, type Mat3 } from "./mesh-place.ts";
import { inPlaneAxes, type FacePlane } from "./model-plane.ts";
import type { PrimitiveSpec } from "./model-primitive.ts";

export type Vec3 = [number, number, number];

export type WorkplaneSource = "global" | "bed" | "face";

/** Origin in model space, and a turn about X, then Y, then Z, the same order a primitive uses. Columns are U, V, W. */
export interface Workplane {
  source: WorkplaneSource;
  origin: Vec3;
  turn: Vec3;
}

/** U = X, V = Y, W = Z, origin at the model origin. An object with no workplane stored is this frame. */
export const GLOBAL_WORKPLANE: Workplane = { source: "global", origin: [0, 0, 0], turn: [0, 0, 0] };

const ID: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** Untouched global frame: origin and turn are exactly zero. Anything else, however close, was set. */
export function isIdentityFrame(plane: Workplane): boolean {
  return plane.origin[0] === 0 && plane.origin[1] === 0 && plane.origin[2] === 0
    && plane.turn[0] === 0 && plane.turn[1] === 0 && plane.turn[2] === 0;
}

/** The turn does not move W off +Z. A bed frame and a top face are untilted, so the plate pose stays. */
export function isUntilted(plane: Workplane): boolean {
  return plane.turn[0] === 0 && plane.turn[1] === 0 && plane.turn[2] === 0;
}

/** Columns U, V, W in model space. */
export function axesOf(plane: Workplane): [Vec3, Vec3, Vec3] {
  const m = isUntilted(plane) ? ID : eulerOrient(plane.turn[0], plane.turn[1], plane.turn[2]);
  return [
    [m[0], m[3], m[6]],
    [m[1], m[4], m[7]],
    [m[2], m[5], m[8]],
  ];
}

/** A local point in model space. An identity frame returns the same numbers. */
export function modelPoint(plane: Workplane, local: Vec3): Vec3 {
  if (isIdentityFrame(plane)) return [local[0], local[1], local[2]];
  const [u, v, w] = axesOf(plane);
  const [a, b, c] = local;
  const o = plane.origin;
  return [
    o[0] + u[0] * a + v[0] * b + w[0] * c,
    o[1] + u[1] * a + v[1] * b + w[1] * c,
    o[2] + u[2] * a + v[2] * b + w[2] * c,
  ];
}

/** A model-space point in local U, V, W. An identity frame returns the same numbers. */
export function modelToLocal(plane: Workplane, point: readonly number[]): Vec3 {
  if (isIdentityFrame(plane)) return [point[0] ?? 0, point[1] ?? 0, point[2] ?? 0];
  const [u, v, w] = axesOf(plane);
  const d: Vec3 = [ (point[0] ?? 0) - plane.origin[0], (point[1] ?? 0) - plane.origin[1], (point[2] ?? 0) - plane.origin[2] ];
  return [dot(d, u), dot(d, v), dot(d, w)];
}

/** A local direction in model space, as a unit vector. An untilted frame returns the direction unchanged. */
export function modelDir(plane: Workplane, local: Vec3): Vec3 {
  if (isUntilted(plane)) return [local[0], local[1], local[2]];
  const [u, v, w] = axesOf(plane);
  const out: Vec3 = [
    u[0] * local[0] + v[0] * local[1] + w[0] * local[2],
    u[1] * local[0] + v[1] * local[1] + w[1] * local[2],
    u[2] * local[0] + v[2] * local[1] + w[2] * local[2],
  ];
  const length = Math.hypot(out[0], out[1], out[2]);
  return length > 0 ? [out[0] / length, out[1] / length, out[2] / length] : [0, 0, -1];
}

/**
 * The primitive's origin and turn, typed in the workplane, in model space. An identity frame returns `spec`.
 * An untilted frame moves the origin and keeps the turn's numbers. A sphere does not turn.
 */
export function placePrimitive(spec: PrimitiveSpec, plane: Workplane): PrimitiveSpec {
  if (isIdentityFrame(plane)) return spec;
  const origin = modelPoint(plane, spec.origin);
  if (isUntilted(plane) || spec.primitive === "sphere") return { ...spec, origin };
  const axes = eulerOrient(plane.turn[0], plane.turn[1], plane.turn[2]);
  const local = eulerOrient(spec.turn[0], spec.turn[1], spec.turn[2]);
  const turned = orientEuler(matMul(axes, local));
  return { ...spec, origin, turn: [turned.rx, turned.ry, turned.rz] };
}

/**
 * Plate rotation that stands W up: mesh directions go through `modelRotation` into model space, then the
 * workplane's turn is undone so W is +Z and U is +X. Null when the frame is untilted, so the plate pose stays.
 */
export function printOrient(plane: Workplane, modelRotation: Mat3): Mat3 | null {
  if (isUntilted(plane)) return null;
  const align = transpose(eulerOrient(plane.turn[0], plane.turn[1], plane.turn[2]));
  return matMul(align, modelRotation);
}

/** The frame on a flat face: origin at the face's middle, W the outward normal, U and V in the plane. */
export function workplaneOnFace(face: FacePlane): Workplane {
  const [u, v] = inPlaneAxes(face.normal);
  const w = face.normal;
  const m: Mat3 = [u[0], v[0], w[0], u[1], v[1], w[1], u[2], v[2], w[2]];
  const turn = orientEuler(m);
  return { source: "face", origin: [face.point[0], face.point[1], face.point[2]], turn: [turn.rx, turn.ry, turn.rz] };
}

/** The bed under a model-space box: the footprint's middle, on the box's lowest point, W up. */
export function workplaneOnBed(box: { min: Vec3; max: Vec3 }): Workplane {
  return {
    source: "bed",
    origin: [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, box.min[2]],
    turn: [0, 0, 0],
  };
}

/** The same frame, moved in model space. A duplicate's frame follows the copy. */
export function shiftWorkplane(plane: Workplane, delta: Vec3): Workplane {
  return { source: plane.source, origin: [plane.origin[0] + delta[0], plane.origin[1] + delta[1], plane.origin[2] + delta[2]], turn: [...plane.turn] };
}

export function sameWorkplane(a: Workplane, b: Workplane): boolean {
  return a.source === b.source
    && a.origin.every((value, i) => value === b.origin[i])
    && a.turn.every((value, i) => value === b.turn[i]);
}

/** What the panel says about the frame, or why a face was refused. */
export function workplaneNote(plane: Workplane, problem: string | null): { text: string; bad: boolean } {
  if (problem) return { text: problem, bad: true };
  const where = plane.source === "bed"
    ? "On the bed, under the part. W points up. "
    : plane.source === "face"
      ? "On the picked face. W points along its normal. "
      : "U is X, V is Y, and W is Z. ";
  const carry = "A hole, box, cylinder, split, or boolean uses this frame, and moving the frame moves it.";
  const print = isUntilted(plane) ? "" : " On the plate, W points up and the part sits on the bed.";
  return { text: `${where}${carry}${print}`, bad: false };
}

export const CURVED_FACE = "Pick a flat face. This one is curved.";

/** A workplane as `.lime` stores it. Null when the value is damaged. */
export function readWorkplane(value: unknown): Workplane | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.source !== "global" && row.source !== "bed" && row.source !== "face") return null;
  const origin = vec3(row.origin);
  const turn = vec3(row.turn);
  if (!origin || !turn) return null;
  return { source: row.source, origin, turn };
}

function vec3(value: unknown): Vec3 | null {
  if (!Array.isArray(value) || value.length !== 3 || !value.every((entry) => typeof entry === "number" && Number.isFinite(entry))) return null;
  return [value[0], value[1], value[2]];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function transpose(m: Mat3): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

function matMul(a: Mat3, b: Mat3): Mat3 {
  const o: number[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) o.push(a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!);
  }
  return o as Mat3;
}
