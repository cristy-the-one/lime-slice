/**
 * A local workplane: a Creo-style U, V, W frame a part carries for placing features (`docs/local-workplane.md`).
 *
 * U and V span the plane. W is its normal, the way a sketch extrudes and a hole cuts. A part keeps its frame in its own
 * frame, so the frame moves with it in model space: Place, a duplicate, a split piece. Tools see it in model space
 * (`workplaneIn`), take numbers in it, and `planePoint` and `planePrimitive` put those numbers into model space;
 * `toSolidOp` then stores the op in the solid's own frame as before. A part with no frame has the global one, model space itself, and every
 * number is what it was before workplanes.
 */
import { eulerOrient, orientEuler, type Mat3 } from "./mesh-place.ts";
import { inPlaneAxes, type FacePlane } from "./model-plane.ts";
import { IDENTITY_POSE, applyPose, fromSolidOp, inversePose, isIdentity, poseScale, thenPose, type Affine } from "./model-space.ts";
import type { PrimitiveSpec } from "./model-primitive.ts";
import type { ModelOp } from "./model-tree.ts";

export type Vec3 = [number, number, number];

export type WorkplaneSource = "global" | "bed" | "face";

/** An origin, and a turn about X, then Y, then Z, the order a primitive uses. The turn's columns are U, V, W. */
export interface Workplane {
  source: WorkplaneSource;
  origin: Vec3;
  turn: Vec3;
}

/** U = X, V = Y, W = Z at the model origin: the frame of a part that has none stored. */
export const GLOBAL_WORKPLANE: Workplane = { source: "global", origin: [0, 0, 0], turn: [0, 0, 0] };

/** Origin and turn exactly zero, whatever set them: local numbers are model-space numbers. */
export function isIdentityFrame(plane: Workplane): boolean {
  return plane.origin.every((value) => value === 0) && plane.turn.every((value) => value === 0);
}

/** The untouched global frame, which a part does not store. */
export function isGlobalFrame(plane: Workplane): boolean {
  return plane.source === "global" && isIdentityFrame(plane);
}

/** The frame as a pose from local U, V, W into the frame it is given in. */
export function framePose(plane: Workplane): Affine {
  if (isIdentityFrame(plane)) return IDENTITY_POSE;
  return { m: eulerOrient(plane.turn[0], plane.turn[1], plane.turn[2]), t: [...plane.origin] };
}

function fromPose(source: WorkplaneSource, pose: Affine): Workplane {
  const s = poseScale(pose);
  const turn = orientEuler(pose.m.map((value) => value / s) as Mat3);
  return { source, origin: [...pose.t], turn: [turn.rx, turn.ry, turn.rz] };
}

/**
 * `plane` taken through `pose`. A pose that only moves keeps the turn's numbers as they are, since working them out
 * again would fold a turn past Y ±90° into another three angles, and the panel's next number would start from those.
 */
function throughPose(plane: Workplane, pose: Affine): Workplane {
  if (isIdentity(pose)) return plane;
  if (pose.m.every((value, i) => value === IDENTITY_POSE.m[i])) {
    return { source: plane.source, origin: [plane.origin[0] + pose.t[0], plane.origin[1] + pose.t[1], plane.origin[2] + pose.t[2]], turn: [...plane.turn] };
  }
  return fromPose(plane.source, thenPose(framePose(plane), pose));
}

/** A part's stored frame in model space, at the part's pose. No frame stored is the global frame. */
export function workplaneIn(stored: Workplane | undefined, pose: Affine): Workplane {
  return stored ? throughPose(stored, pose) : GLOBAL_WORKPLANE;
}

/** A model-space frame as the part at `pose` stores it, in its own frame: the inverse of `workplaneIn`. */
export function workplaneOwn(plane: Workplane, pose: Affine): Workplane {
  return throughPose(plane, inversePose(pose));
}

/** Columns U, V, W. */
export function axesOf(plane: Workplane): [Vec3, Vec3, Vec3] {
  const m = framePose(plane).m;
  return [
    [m[0], m[3], m[6]],
    [m[1], m[4], m[7]],
    [m[2], m[5], m[8]],
  ];
}

/** A local point in the frame's space. */
export function planePoint(plane: Workplane, local: readonly number[]): Vec3 {
  return applyPose(framePose(plane), local);
}

/** A point of the frame's space in local U, V, W. */
export function localPoint(plane: Workplane, point: readonly number[]): Vec3 {
  return applyPose(inversePose(framePose(plane)), point);
}

/** −W: where a hole drills with no face picked. Straight down on an untilted frame. */
export function drillDown(plane: Workplane): Vec3 {
  if (plane.turn.every((value) => value === 0)) return [0, 0, -1];
  const w = axesOf(plane)[2];
  return [-w[0], -w[1], -w[2]];
}

/**
 * A primitive typed in the frame's U, V, W, in the frame's space. It turns about its own centre (`turnCentre`), so the
 * centre goes through the frame and the turn takes the frame's turn, as `toSolidOp` takes an op into a solid's frame.
 * An identity frame returns `spec` itself.
 */
export function planePrimitive(spec: PrimitiveSpec, plane: Workplane): PrimitiveSpec {
  if (isIdentityFrame(plane)) return spec;
  const placed = fromSolidOp({ kind: "boolean", op: "fuse", ...spec }, framePose(plane)) as Extract<ModelOp, { kind: "boolean" }>;
  return { ...spec, origin: placed.origin, turn: placed.turn };
}

/**
 * The plate orient that prints a part with W up and U along +X, from the frame as the part stores it: the plate mesh
 * is the part's own frame, lowered, so the orient only undoes the frame's turn. The global frame is the file's own way up.
 */
export function printOrient(stored: Workplane | undefined): Mat3 {
  return [...(stored ? inversePose(framePose(stored)).m : IDENTITY_POSE.m)] as Mat3;
}

/**
 * The frame on a flat face: origin at the face's middle, W the outward normal. On a face that looks up or down, U and V
 * are Split's in-plane axes (`inPlaneAxes`: X, then W × U). On a side face V runs up the face and U = V × W, so U is
 * level and the turn never reaches Y ±90°, where Turn X and Turn Z would be one turn.
 */
export function workplaneOnFace(face: FacePlane): Workplane {
  const w = face.normal;
  const up = Math.abs(w[2]) >= Math.abs(w[0]) && Math.abs(w[2]) >= Math.abs(w[1]);
  const [u, v] = up ? inPlaneAxes(w) : sideAxes(w);
  const turn = orientEuler([u[0], v[0], w[0], u[1], v[1], w[1], u[2], v[2], w[2]]);
  return { source: "face", origin: [face.point[0], face.point[1], face.point[2]], turn: [turn.rx, turn.ry, turn.rz] };
}

/** The bed under a model-space box: the footprint's middle, on the box's lowest point, W up. */
export function workplaneOnBed(box: { min: readonly number[]; max: readonly number[] }): Workplane {
  return {
    source: "bed",
    origin: [(box.min[0]! + box.max[0]!) / 2, (box.min[1]! + box.max[1]!) / 2, box.min[2]!],
    turn: [0, 0, 0],
  };
}

export function sameWorkplane(a: Workplane, b: Workplane): boolean {
  return a.source === b.source
    && a.origin.every((value, i) => value === b.origin[i])
    && a.turn.every((value, i) => value === b.turn[i]);
}

/** U, V on a side face: V the up direction made square to W, U = V × W. */
function sideAxes(w: Vec3): [Vec3, Vec3] {
  const v: Vec3 = [-w[0] * w[2], -w[1] * w[2], 1 - w[2] * w[2]];
  const length = Math.hypot(v[0], v[1], v[2]);
  const vn: Vec3 = [v[0] / length, v[1] / length, v[2] / length];
  return [[vn[1] * w[2] - vn[2] * w[1], vn[2] * w[0] - vn[0] * w[2], vn[0] * w[1] - vn[1] * w[0]], vn];
}

/** What the panel says about the frame, in model space. A bed frame a turn of the part has tipped is no longer under it. */
export function workplaneNote(plane: Workplane): string {
  const uses = "Hole, Boolean, and Split use this frame.";
  if (plane.source === "face") return `Set on a face, W out of it. ${uses}`;
  if (plane.source === "bed" && Math.abs(axesOf(plane)[2][2] - 1) < 1e-9) return `Under the part, W up. ${uses}`;
  if (isIdentityFrame(plane)) return "U, V, W are X, Y, Z. Pick Bed or Face, or type a frame.";
  return uses;
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

export function copyWorkplane(plane: Workplane): Workplane {
  return { source: plane.source, origin: [...plane.origin], turn: [...plane.turn] };
}

function vec3(value: unknown): Vec3 | null {
  if (!Array.isArray(value) || value.length !== 3 || !value.every((entry) => typeof entry === "number" && Number.isFinite(entry))) return null;
  return [value[0], value[1], value[2]];
}
