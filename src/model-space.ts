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
import { eulerOrient, matMul, orientEuler, wrapDeg, type Bounds, type Mat3 } from "./mesh-place.ts";
import { turnCentre } from "./model-primitive.ts";
import type { ModelOp, Vec3 } from "./model-tree.ts";

/** `q = m·p + t`. A rigid pose, or a rigid pose times one uniform scale folded into `m`. */
export interface Affine {
  m: Mat3;
  t: Vec3;
}

export const IDENTITY_POSE: Affine = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };

/** The frame an object's typed Model numbers are read and written in: its own CAD frame (`"part"`), or model space (`"model"`, the default). */
export type ObjectFrame = "model" | "part";

/** The pose a typed number goes through into the solid's frame: none in the part's own frame, else the object's model pose. */
export function typedPoseOf(obj: { modelPose?: Affine; frame?: ObjectFrame }): Affine {
  return obj.frame === "part" ? IDENTITY_POSE : obj.modelPose ?? IDENTITY_POSE;
}

/**
 * --- Assemblies M10. Model space into the frame Model draws and types in while `obj` is open (D12). A part-frame member
 * of an assembly that stands moved or turned opens in its own frame: the inverse of its pose, so it stands as it was
 * modelled and the other objects move around it. Anything else opens in model space.
 */
export function viewFrameOf(obj: { modelPose?: Affine; frame?: ObjectFrame } | undefined, inAssembly: boolean): Affine {
  return obj && inAssembly && obj.frame === "part" && !isIdentity(obj.modelPose) ? inversePose(obj.modelPose!) : IDENTITY_POSE;
}

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

/** A turn and a move only, within 1e-6, as the engine checks a join's placement: no scale, shear, or mirror. */
export function isRigid({ m, t }: Affine): boolean {
  const col = (c: number): Vec3 => [m[c], m[c + 3], m[c + 6]];
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const [x, y, z] = [col(0), col(1), col(2)];
  const det = dot(x, [y[1] * z[2] - y[2] * z[1], y[2] * z[0] - y[0] * z[2], y[0] * z[1] - y[1] * z[0]]);
  return [...m, ...t].every(Number.isFinite)
    && [x, y, z].every((c) => Math.abs(dot(c, c) - 1) <= 1e-6)
    && [[x, y], [y, z], [x, z]].every(([a, b]) => Math.abs(dot(a!, b!)) <= 1e-6)
    && det > 0;
}

/**
 * Where a tool solid sits in a target solid's own frame: out of the tool's own frame into model space by its pose, then
 * back into the target's by the inverse of the target's. A join stores this once, at Apply, so moving either object
 * later never moves a cut already made.
 */
export function relativePose(target: Affine, tool: Affine): Affine {
  return thenPose(tool, inversePose(target));
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
    // --- Split to print: each cut's plane as a split's, and its U turned with it. ---
    case "partition":
      return { ...op, cuts: op.cuts.map((cut) => ({ ...cut, origin: point(cut.origin), normal: turnDir(back, cut.normal), ...(cut.u ? { u: turnDir(back, cut.u) } : {}) })) };
    case "extrude":
    case "revolve": {
      // The profile's plane is a frame: its origin goes through the pose and its turn takes the pose's turn.
      if (moveOnly(back)) return { ...op, origin: point(op.origin) };
      const s = poseScale(back);
      const turned = orientEuler(matMul(back.m.map((value) => value / s) as Mat3, eulerOrient(op.turn[0], op.turn[1], op.turn[2])));
      return { ...op, origin: point(op.origin), turn: [turned.rx, turned.ry, turned.rz] };
    }
    case "loft": {
      // Each section's plane is a frame, as a profile's is.
      if (moveOnly(back)) return { ...op, sections: op.sections.map((section) => ({ ...section, origin: point(section.origin) })) };
      const s = poseScale(back);
      const turn = back.m.map((value) => value / s) as Mat3;
      return {
        ...op,
        sections: op.sections.map((section) => {
          const turned = orientEuler(matMul(turn, eulerOrient(section.turn[0], section.turn[1], section.turn[2])));
          return { ...section, origin: point(section.origin), turn: [turned.rx, turned.ry, turned.rz] };
        }),
      };
    }
    // --- A1 group: every step goes into the solid's frame, the same way it would alone. ---
    case "group":
      return { ...op, steps: op.steps.map((step) => toSolidOp(step, pose)) };
    default:
      return op;
  }
}

/**
 * A stored op, in the solid's own frame, back in model space at the object's pose: what an edited step's panel opens
 * with, so `toSolidOp` of it at the same pose is the op again. Identity returns `op` itself.
 */
export function fromSolidOp(op: ModelOp, pose: Affine): ModelOp {
  return isIdentity(pose) ? op : toSolidOp(op, inversePose(pose));
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

/** Rx, Ry, Rz in degrees, as `eulerOrient` takes them. */
export type Turn = Pick<PlaceFields, "rx" | "ry" | "rz">;

/** How far apart two angles are, the short way round, in degrees. */
function apart(a: number, b: number): number {
  return Math.abs(wrapDeg(a - b));
}

/**
 * The Rx, Ry, Rz that `eulerOrient` turns into `turn`, chosen to read well. Every turn has two readings, (rx, ry, rz)
 * and (rx + 180, 180 - ry, rz + 180), and at Ry ±90 only Rx - Rz (or Rx + Rz) counts. Of these, the one nearest
 * `near`, the angles last shown or typed, so a number typed reads back as typed and a turn never jumps to its twin.
 * Without `near`, the one with the smaller angles: a half turn about Y reads 0/120/0, not 180/60/180.
 */
export function steadyTurn(turn: Mat3, near?: Turn): Turn {
  const base = orientEuler(turn);
  if (Math.hypot(turn[0], turn[3]) <= 1e-6) {
    if (!near) return { rx: base.rx, ry: base.ry, rz: 0 };
    // Gimbal lock: Rz keeps the value shown, and Rx takes the rest.
    const rz = wrapDeg(near.rz);
    return { rx: wrapDeg(base.ry > 0 ? base.rx + rz : base.rx - rz), ry: base.ry, rz };
  }
  const twin: Turn = { rx: wrapDeg(base.rx + 180), ry: wrapDeg(180 - base.ry), rz: wrapDeg(base.rz + 180) };
  const cost = (t: Turn) => (near ? apart(t.rx, near.rx) + apart(t.ry, near.ry) + apart(t.rz, near.rz) : Math.abs(t.rx) + Math.abs(t.ry) + Math.abs(t.rz));
  return cost(twin) < cost(base) - 1e-9 ? twin : { rx: base.rx, ry: base.ry, rz: base.rz };
}

/** The Place fields of `pose`, for a part whose own-frame centre is `pivot`. The turn reads as `steadyTurn` reads it. */
export function placeFields(pose: Affine, pivot: Vec3, near?: Turn): PlaceFields {
  const s = poseScale(pose);
  const at = applyPose(pose, pivot);
  const turn = steadyTurn(pose.m.map((value) => value / s) as Mat3, near);
  return { x: at[0] - pivot[0], y: at[1] - pivot[1], z: at[2] - pivot[2], rx: turn.rx, ry: turn.ry, rz: turn.rz };
}

/**
 * `from` with one Place field set to `value`: turned by Rx, then Ry, then Rz about the centre, which then moves
 * by X, Y, Z. Every other field keeps the value `from` has, not the rounded one a field shows, so a move never
 * nudges the other axes or the turn, and the scale stays. `near` is the turn the fields show, so the other two
 * angles are the ones the user sees.
 */
export function poseFromPlace(from: Affine, pivot: Vec3, field: keyof PlaceFields, value: number, near?: Turn): Affine {
  const now = placeFields(from, pivot, near);
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
