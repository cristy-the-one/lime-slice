/**
 * The solid as the Model reads answer it: in the frame its ops are typed in.
 *
 * A part's solid is kept in its own frame, and `model_place` gives it a pose into model space. Ops are typed in the
 * part's typed frame (`typedPoseOf`: model space, unless `model_place {frame:"part"}`) and `toSolidOp` takes them into
 * the solid's frame. The reads (model_describe, faces_find, edges_find, surface_at, a recipe's `bounds` and `pick_face`)
 * answer through this view, so a point a read gives is the point an op at it hits, whether the part was moved, turned,
 * or neither. Identity returns the solid itself, so a part with no pose reads exactly as before.
 */
import { applyPose, isIdentity, poseScale, turnDir, type Affine } from "../model-space.ts";
import { faceRows, type EdgeRow, type EngineFace, type FaceRow } from "./solid-geometry.ts";

type Vec3 = [number, number, number];
type Box = { min: Vec3; max: Vec3 };

/** What a read takes of a solid: its mesh, face and edge rows and box, and its edge polylines when it has them. */
export interface ReadableSolid {
  positions: ArrayLike<number>;
  triangles: ArrayLike<number>;
  faces: readonly FaceRow[];
  edges: readonly EdgeRow[];
  bounds: Box;
  lines?: readonly { edge: number; points: ArrayLike<number> }[];
}

const kept = new WeakMap<object, { pose: string; view: unknown }>();

function posedPoints(points: ArrayLike<number>, pose: Affine): Float32Array {
  const out = new Float32Array(points.length - (points.length % 3));
  for (let i = 0; i + 2 < points.length; i += 3) out.set(applyPose(pose, [points[i]!, points[i + 1]!, points[i + 2]!]), i);
  return out;
}

function boxOf(points: ArrayLike<number>): Box {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < points.length; i += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = points[i + axis]!;
      if (value < min[axis]!) min[axis] = value;
      if (value > max[axis]!) max[axis] = value;
    }
  }
  return Number.isFinite(min[0]) ? { min, max } : { min: [0, 0, 0], max: [0, 0, 0] };
}

/** A point of the solid's own frame in the typed frame. */
export function typedPoint(pose: Affine, p: readonly number[]): Vec3 {
  return isIdentity(pose) ? [p[0]!, p[1]!, p[2]!] : applyPose(pose, p);
}

/** A direction of the solid's own frame in the typed frame, as a unit vector. */
export function typedDir(pose: Affine, d: readonly number[]): Vec3 {
  return isIdentity(pose) ? [d[0]!, d[1]!, d[2]!] : turnDir(pose, d);
}

/**
 * `solid` in the typed frame of `pose`: its mesh, each face's normal, centre, box and axis (a sphere's axis point is its
 * centre), each edge's ends, middle and direction, its polylines and its box. Face and edge indexes are the solid's own.
 * Kept for the last pose asked of each solid, since a run reads the same solid many times.
 */
export function typedView<T extends ReadableSolid>(solid: T, pose: Affine): T {
  if (isIdentity(pose)) return solid;
  const key = JSON.stringify(pose);
  const held = kept.get(solid);
  if (held && held.pose === key) return held.view as T;
  const s = poseScale(pose);
  const positions = posedPoints(solid.positions, pose);
  // The face rows again from the posed mesh, so each centre and box is the posed face's own, not a box around a turned box.
  const engineFaces: EngineFace[] = solid.faces.map((face) => ({
    areaMm2: face.areaMm2 * s * s,
    ...(face.normal ? { normal: turnDir(pose, face.normal) } : {}),
    ...(face.kind !== "plane" && face.kind !== "other" && face.radiusMm !== undefined
      ? { surface: face.kind, radiusMm: face.radiusMm * s, ...(face.axis && face.axisPoint ? { axis: turnDir(pose, face.axis), axisPoint: applyPose(pose, face.axisPoint) } : {}) }
      : {}),
  }));
  const rows = faceRows(positions, solid.triangles, engineFaces);
  // A face's kind stays the solid's: a turn does not make a face flat or curved.
  const faces: FaceRow[] = rows.map((row, i) => ({ ...row, index: solid.faces[i]?.index ?? row.index, kind: solid.faces[i]?.kind ?? row.kind }));
  const edges: EdgeRow[] = solid.edges.map((edge) => ({
    ...edge,
    lengthMm: edge.lengthMm * s,
    start: applyPose(pose, edge.start),
    end: applyPose(pose, edge.end),
    mid: applyPose(pose, edge.mid),
    ...(edge.dir ? { dir: turnDir(pose, edge.dir) } : {}),
  }));
  const view = {
    ...solid,
    positions,
    faces,
    edges,
    bounds: boxOf(positions),
    ...(solid.lines ? { lines: solid.lines.map((line) => ({ ...line, points: posedPoints(line.points, pose) })) } : {}),
  } as T;
  kept.set(solid, { pose: key, view });
  return view;
}
