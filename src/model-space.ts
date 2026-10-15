/**
 * Model space: the one frame Model mode draws every object in, apart from the plate layout that prints them.
 *
 * Each plate object carries a pose from its own CAD frame into model space (`PlateObject.modelPose`, identity
 * when absent), so files cut from one assembly line up as designed. A plate mesh is lowered onto Z = 0 when it
 * is read; its `seat` is how far, so its CAD frame is the mesh moved up by the seat.
 *
 * Tools take model-space numbers. `toSolidOp` turns them into the open solid's own frame before the engine
 * sees them, so stored ops, replay, and saved trees never depend on where an object sits in model space.
 */
import { eulerOrient, matMul, orientEuler, type Bounds, type Mat3 } from "./mesh-place.ts";
import { turnCentre } from "./model-primitive.ts";
import type { ModelOp, Vec3 } from "./model-tree.ts";

/** `q = m·p + t`. A rigid pose, or a rigid pose times one uniform scale folded into `m`. */
export interface Affine {
  m: Mat3;
  t: Vec3;
}

export const IDENTITY_POSE: Affine = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };

/** A copy beside its source along model X, its own width plus this gap away, so the two never sit on each other. */
export const DUPLICATE_GAP_MM = 10;

/** Exactly the identity: a file's own coordinates. Anything else, however close, is a pose the user set. */
export function isIdentity(pose: Affine | undefined): boolean {
  return !pose || (moveOnly(pose) && pose.t[0] === 0 && pose.t[1] === 0 && pose.t[2] === 0);
}

/** The pose turns nothing and scales nothing. */
function moveOnly(pose: Affine): boolean {
  return pose.m.every((value, i) => value === IDENTITY_POSE.m[i]);
}

export function applyPose(pose: Affine, p: readonly number[]): Vec3 {
  const { m, t } = pose;
  return [
    m[0] * p[0]! + m[1] * p[1]! + m[2] * p[2]! + t[0],
    m[3] * p[0]! + m[4] * p[1]! + m[5] * p[2]! + t[1],
    m[6] * p[0]! + m[7] * p[1]! + m[8] * p[2]! + t[2],
  ];
}

/** A direction through the pose, as a unit vector. */
export function turnDir(pose: Affine, d: readonly number[]): Vec3 {
  const { m } = pose;
  const out: Vec3 = [m[0] * d[0]! + m[1] * d[1]! + m[2] * d[2]!, m[3] * d[0]! + m[4] * d[1]! + m[5] * d[2]!, m[6] * d[0]! + m[7] * d[1]! + m[8] * d[2]!];
  const length = Math.hypot(...out);
  return length > 0 ? [out[0] / length, out[1] / length, out[2] / length] : out;
}

/** `first`, then `second`. */
export function thenPose(first: Affine, second: Affine): Affine {
  return { m: matMul(second.m, first.m), t: applyPose(second, first.t) };
}

/** The scale folded into a pose: 1 for a rigid one. */
export function poseScale(pose: Affine): number {
  return Math.hypot(pose.m[0], pose.m[3], pose.m[6]);
}

/** The inverse of a rigid pose times a uniform scale: its transpose over the scale squared. */
export function inversePose(pose: Affine): Affine {
  const { m } = pose;
  const s2 = m[0] * m[0] + m[3] * m[3] + m[6] * m[6];
  const inv = [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]].map((value) => value / s2) as Mat3;
  const t = applyPose({ m: inv, t: [0, 0, 0] }, pose.t);
  return { m: inv, t: [-t[0], -t[1], -t[2]] };
}

/** A move by `d` after the pose. */
export function movedPose(pose: Affine, d: Vec3): Affine {
  return { m: [...pose.m] as Mat3, t: [pose.t[0] + d[0], pose.t[1] + d[1], pose.t[2] + d[2]] };
}

/** A plate mesh into its CAD frame: up by its seat. */
export function seatLift(seat: number): Affine {
  return { m: [...IDENTITY_POSE.m] as Mat3, t: [0, 0, seat] };
}

/** The box a source box takes once `pose` is applied. Exact for turns in quarter steps, a bound otherwise. */
export function boxUnder(source: Bounds, pose: Affine): Bounds {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let corner = 0; corner < 8; corner += 1) {
    const q = applyPose(pose, [corner & 1 ? source.max[0] : source.min[0], corner & 2 ? source.max[1] : source.min[1], corner & 4 ? source.max[2] : source.min[2]]);
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis]!, q[axis]!);
      max[axis] = Math.max(max[axis]!, q[axis]!);
    }
  }
  return { min, max };
}

let lastBounds: { positions: ArrayLike<number>; pose: Affine; box: Bounds | null } | null = null;

/**
 * The exact box of `positions` once posed. Kept for the last solid and pose, since every tool, handle and
 * note reads it while the numbers move and only a new solid or a new pose changes it. A pose that only
 * moved shifts the kept box instead of reading every vertex again, as Place does on each pointer move.
 */
export function posedBounds(positions: ArrayLike<number>, pose: Affine): Bounds | null {
  const held = lastBounds;
  if (held && held.positions === positions) {
    if (held.pose === pose) return held.box;
    if (held.box && pose.m.every((value, i) => value === held.pose.m[i])) {
      const d = [pose.t[0] - held.pose.t[0], pose.t[1] - held.pose.t[1], pose.t[2] - held.pose.t[2]];
      const box: Bounds = { min: [held.box.min[0] + d[0]!, held.box.min[1] + d[1]!, held.box.min[2] + d[2]!], max: [held.box.max[0] + d[0]!, held.box.max[1] + d[1]!, held.box.max[2] + d[2]!] };
      lastBounds = { positions, pose, box };
      return box;
    }
  }
  let box: Bounds | null = null;
  if (positions.length >= 3) {
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    const { m, t } = pose;
    for (let i = 0; i + 2 < positions.length; i += 3) {
      const x = positions[i]!, y = positions[i + 1]!, z = positions[i + 2]!;
      const q = [m[0] * x + m[1] * y + m[2] * z + t[0], m[3] * x + m[4] * y + m[5] * z + t[1], m[6] * x + m[7] * y + m[8] * z + t[2]];
      for (let axis = 0; axis < 3; axis += 1) {
        if (q[axis]! < min[axis]!) min[axis] = q[axis]!;
        if (q[axis]! > max[axis]!) max[axis] = q[axis]!;
      }
    }
    box = { min, max };
  }
  lastBounds = { positions, pose, box };
  return box;
}

/**
 * A tool's op, typed in model space, in the open solid's own frame: what the engine builds and the tree stores.
 * A primitive turns about its centre (`turnCentre`), so that centre goes through the pose and the turn takes the pose's
 * turn. Identity returns `op` itself, so every file without a pose sends exactly the numbers typed.
 * The pose is rigid: only a Separate-shells piece of a scaled part carries a scale, and Model never opens one.
 */
export function toSolidOp(op: ModelOp, pose: Affine): ModelOp {
  if (isIdentity(pose)) return op;
  const back = inversePose(pose);
  const point = (p: Vec3) => applyPose(back, p);
  switch (op.kind) {
    case "boolean": {
      if (op.primitive === "sphere" || moveOnly(back)) return { ...op, origin: point(op.origin) };
      const half = turnCentre(op);
      const centre = point([op.origin[0] + half[0], op.origin[1] + half[1], op.origin[2] + half[2]]);
      const s = poseScale(back);
      const turned = orientEuler(matMul(back.m.map((value) => value / s) as Mat3, eulerOrient(op.turn[0], op.turn[1], op.turn[2])));
      return { ...op, origin: [centre[0] - half[0], centre[1] - half[1], centre[2] - half[2]], turn: [turned.rx, turned.ry, turned.rz] };
    }
    case "hole":
      return { ...op, origin: point(op.origin), axis: turnDir(back, op.axis) };
    case "split":
      return { ...op, origin: point(op.origin), normal: turnDir(back, op.normal) };
    default:
      return op;
  }
}

/** What the Place tool shows: how far the part's centre moved from where its file put it, and the turn about it. */
export interface PlaceFields {
  x: number;
  y: number;
  z: number;
  rx: number;
  ry: number;
  rz: number;
}

/** The Place fields of `pose`, for a part whose own-frame centre is `pivot`. */
export function placeFields(pose: Affine, pivot: Vec3): PlaceFields {
  const s = poseScale(pose);
  const at = applyPose(pose, pivot);
  const turn = orientEuler(pose.m.map((value) => value / s) as Mat3);
  return { x: at[0] - pivot[0], y: at[1] - pivot[1], z: at[2] - pivot[2], rx: turn.rx, ry: turn.ry, rz: turn.rz };
}

/**
 * `from` with one Place field set to `value`: turned by Rx, then Ry, then Rz about the centre, which then moves
 * by X, Y, Z. Every other field keeps the value `from` has, not the rounded one a field shows, so a move never
 * nudges the other axes or the turn, and the scale stays.
 */
export function poseFromPlace(from: Affine, pivot: Vec3, field: keyof PlaceFields, value: number): Affine {
  const now = placeFields(from, pivot);
  const axis = ["x", "y", "z"].indexOf(field);
  if (axis >= 0) {
    const t: Vec3 = [...from.t];
    t[axis] += value - now[field];
    return { m: [...from.m] as Mat3, t };
  }
  const fields = { ...now, [field]: value };
  const s = poseScale(from);
  const m = eulerOrient(fields.rx, fields.ry, fields.rz).map((entry) => entry * s) as Mat3;
  const turned = applyPose({ m, t: [0, 0, 0] }, pivot);
  return { m, t: [pivot[0] + fields.x - turned[0], pivot[1] + fields.y - turned[1], pivot[2] + fields.z - turned[2]] };
}

/**
 * Where a new solid whose own box is `own` goes in model space: where it stands, at the origin, when model space is
 * empty; else beside everything along +X, a gap past the last object, centred on their Y and sitting on their floor.
 */
export function newSolidPose(others: readonly Bounds[], own: Bounds): Affine {
  if (others.length === 0) return IDENTITY_POSE;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const box of others) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis]!, box.min[axis]!);
      max[axis] = Math.max(max[axis]!, box.max[axis]!);
    }
  }
  const t: Vec3 = [max[0] + DUPLICATE_GAP_MM - own.min[0], (min[1] + max[1]) / 2 - (own.min[1] + own.max[1]) / 2, min[2] - own.min[2]];
  return { m: [...IDENTITY_POSE.m] as Mat3, t };
}

/** Where a copy of an object whose model-space box is `box` goes: beside it along X. */
export function duplicatePose(pose: Affine, box: Bounds): Affine {
  return movedPose(pose, [box.max[0] - box.min[0] + DUPLICATE_GAP_MM, 0, 0]);
}
