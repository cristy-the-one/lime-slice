/**
 * A pivot is a point in an object's source frame, before scale and turn. Absent means the bounds centre, which is
 * where rotate and scale already happen. A stored pivot is not a slice input: the mesh is still scaled about the
 * centre and the pose the engine sees still names that centre. Rotate and scale about a custom pivot are written as
 * the same orient and scale plus the bed offset that keeps the pivot where it was.
 */
import { boundsOf, type Mat3, type MeshShift } from "./mesh-place.ts";

export type Vec3 = [number, number, number];

const SEAT_EPS = 1e-6;

export function centreOf(source: Float32Array): Vec3 {
  const box = boundsOf(source);
  return [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
}

/** A pivot the user set, or the bounds centre when they have not. */
export function pivotOrCentre(pivot: Vec3 | undefined, centre: Vec3): Vec3 {
  return pivot ?? centre;
}

/**
 * True when rotate and scale must keep this point fixed. The centre, and a point on the centre, take the path the
 * gizmo already had: the offset is not rewritten, so an unchanged pose stays byte-identical.
 */
export function usingCustomPivot(pivot: Vec3 | undefined, centre: Vec3): pivot is Vec3 {
  if (!pivot || pivot.length !== 3 || pivot.some((value) => !Number.isFinite(value))) return false;
  return pivot.some((value, index) => Math.abs(value - centre[index]!) > 1e-6);
}

export function transpose(m: Mat3): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

export function matVec(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

export function add3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale3(v: Vec3, k: number): Vec3 {
  return [v[0] * k, v[1] * k, v[2] * k];
}

export function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross3(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function hypot3(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

/** The source scaled and turned about its bounds centre, then seated, matching `placeMesh` before the bed shift. */
interface ParkedFrame {
  centre: Vec3;
  /** Settled positions, float32, the same numbers `placeMesh` shifts onto the bed. */
  settled: Float32Array;
  seat: number;
  min: Vec3;
  max: Vec3;
}

function parkFrame(source: Float32Array, orient: Mat3, scale: number): ParkedFrame {
  const centre = centreOf(source);
  const out = new Float32Array(source.length);
  for (let i = 0; i < source.length; i += 3) {
    const x = (source[i]! - centre[0]) * scale;
    const y = (source[i + 1]! - centre[1]) * scale;
    const z = (source[i + 2]! - centre[2]) * scale;
    out[i] = orient[0] * x + orient[1] * y + orient[2] * z + centre[0];
    out[i + 1] = orient[3] * x + orient[4] * y + orient[5] * z + centre[1];
    out[i + 2] = orient[6] * x + orient[7] * y + orient[8] * z + centre[2];
  }
  let minZ = Infinity;
  for (let i = 2; i < out.length; i += 3) if (out[i]! < minZ) minZ = out[i]!;
  const seat = !Number.isFinite(minZ) || Math.abs(minZ) <= SEAT_EPS ? 0 : minZ;
  if (seat !== 0) for (let i = 2; i < out.length; i += 3) out[i] = out[i]! - seat;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < out.length; i += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = out[i + axis]!;
      if (value < min[axis]) min[axis] = value;
      if (value > max[axis]) max[axis] = value;
    }
  }
  return { centre, settled: out, seat, min, max };
}

function bedShift(frame: ParkedFrame, bedX: number, bedY: number, centered: boolean, offset: MeshShift): MeshShift {
  if (centered) {
    return {
      x: bedX / 2 - (frame.min[0] + frame.max[0]) / 2,
      y: bedY / 2 - (frame.min[1] + frame.max[1]) / 2,
      z: 0,
    };
  }
  return { x: offset.x, y: offset.y, z: offset.z };
}

function mapPoint(point: Vec3, frame: ParkedFrame, orient: Mat3, scale: number, move: MeshShift): Vec3 {
  const x = (point[0] - frame.centre[0]) * scale;
  const y = (point[1] - frame.centre[1]) * scale;
  const z = (point[2] - frame.centre[2]) * scale;
  const rx = Math.fround(orient[0] * x + orient[1] * y + orient[2] * z + frame.centre[0]);
  const ry = Math.fround(orient[3] * x + orient[4] * y + orient[5] * z + frame.centre[1]);
  const rz = Math.fround(orient[6] * x + orient[7] * y + orient[8] * z + frame.centre[2]);
  const seated = frame.seat === 0 ? rz : Math.fround(rz - frame.seat);
  return [Math.fround(rx + move.x), Math.fround(ry + move.y), Math.fround(seated + move.z)];
}

/** Where a source point lands on the bed, by the same turn, scale, seat and shift as `placeMesh`. */
export function sourceToBedPoint(
  source: Float32Array,
  point: Vec3,
  orient: Mat3,
  scale: number,
  centered: boolean,
  offset: MeshShift,
  bedX: number,
  bedY: number,
): Vec3 {
  const frame = parkFrame(source, orient, scale);
  return mapPoint(point, frame, orient, scale, bedShift(frame, bedX, bedY, centered, offset));
}

/** The source point that `sourceToBedPoint` sends to `bed`, for the same pose. */
export function bedToSourcePoint(
  source: Float32Array,
  bed: Vec3,
  orient: Mat3,
  scale: number,
  centered: boolean,
  offset: MeshShift,
  bedX: number,
  bedY: number,
): Vec3 {
  const frame = parkFrame(source, orient, scale);
  const move = bedShift(frame, bedX, bedY, centered, offset);
  const seated: Vec3 = [bed[0] - move.x, bed[1] - move.y, bed[2] - move.z];
  const turned: Vec3 = [seated[0], seated[1], frame.seat === 0 ? seated[2] : seated[2] + frame.seat];
  const local = matVec(transpose(orient), sub3(turned, frame.centre));
  const safe = scale === 0 ? 1 : scale;
  return add3(frame.centre, scale3(local, 1 / safe));
}

/** The bed offset that puts `point` on `world` after this turn and scale. Centering is off: the offset owns the place. */
export function offsetKeepingPoint(
  source: Float32Array,
  point: Vec3,
  orient: Mat3,
  scale: number,
  bedX: number,
  bedY: number,
  world: Vec3,
): MeshShift {
  // Centering is off, so the bed size does not move the point. The arguments stay so this matches `parked`.
  void bedX;
  void bedY;
  const frame = parkFrame(source, orient, scale);
  const at = mapPoint(point, frame, orient, scale, { x: 0, y: 0, z: 0 });
  return { x: world[0] - at[0], y: world[1] - at[1], z: world[2] - at[2] };
}

export interface PoseBits {
  orient: Mat3;
  partScale: number;
  centered: boolean;
  offset: MeshShift;
}

/**
 * The centred flag and offset after a new orient or scale. Null when the pivot is the centre: the caller keeps the
 * offset it already has, including its object identity, so a turn about the centre does not touch it.
 */
export function heldPivotPose(
  source: Float32Array,
  pivot: Vec3 | undefined,
  before: PoseBits,
  after: { orient: Mat3; partScale: number },
  bedX: number,
  bedY: number,
): { centered: false; offset: MeshShift } | null {
  const centre = centreOf(source);
  if (!usingCustomPivot(pivot, centre)) return null;
  const world = sourceToBedPoint(source, pivot, before.orient, before.partScale, before.centered, before.offset, bedX, bedY);
  return {
    centered: false,
    offset: offsetKeepingPoint(source, pivot, after.orient, after.partScale, bedX, bedY, world),
  };
}

/** Corners, centre, and the nearest source vertex, for placing a pivot. `reachMm` is how far a snap may jump. */
export function snapPivotPoint(source: Float32Array, point: Vec3, reachMm: number, extras: readonly Vec3[] = []): Vec3 {
  const centre = centreOf(source);
  const box = boundsOf(source);
  const corners: Vec3[] = [];
  for (const x of [box.min[0], box.max[0]]) {
    for (const y of [box.min[1], box.max[1]]) {
      for (const z of [box.min[2], box.max[2]]) corners.push([x, y, z]);
    }
  }
  let best: Vec3 = point;
  let bestDist = reachMm;
  const offer = (candidate: Vec3) => {
    const dist = hypot3(sub3(candidate, point));
    if (dist < bestDist - 1e-9 || (Math.abs(dist - bestDist) <= 1e-9 && hypot3(sub3(candidate, centre)) < hypot3(sub3(best, centre)))) {
      best = candidate;
      bestDist = dist;
    }
  };
  offer(centre);
  for (const corner of corners) offer(corner);
  for (const extra of extras) offer(extra);
  // Vertices after the features, so a corner wins a tie with the vertex that sits on it.
  let vertex: Vec3 | null = null;
  let vertexDist = bestDist;
  for (let i = 0; i < source.length; i += 3) {
    const at: Vec3 = [source[i]!, source[i + 1]!, source[i + 2]!];
    const dist = hypot3(sub3(at, point));
    if (dist < vertexDist - 1e-9) {
      vertex = at;
      vertexDist = dist;
    }
  }
  return vertex ?? best;
}
