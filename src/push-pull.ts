/**
 * Face push/pull (plan B, P1). A drag along a face's outward normal.
 * With nothing else held it is `moveFaces`, so the neighbours follow.
 * Alt is `faceExtrude`, a prism on that face alone.
 * The kernel builds both. This module only decides the op, the ghost, and the words.
 */

import { dragAxis, type AxisDrag, type FaceLevel, type Ray } from "./interact/drag-axis.ts";
import { facePrism } from "./interact/ghosts.ts";
import { formatNumber, type HudField } from "./interact/hud.ts";
import { dot, scale, sub, type Vec3 } from "./model-drag.ts";
import { faceExtrudeOp, moveFacesOp } from "./model-request.ts";
import type { FaceExtrudeOp, MoveFacesOp } from "./model-tree.ts";

/** How long after a pull Tab still reopens the distance. */
export const TAB_EDIT_MS = 3000;

/** The panel's distance, the same number the drag writes. */
export const PULL_FIELD = "modelPull";

export interface PullFace {
  index: number;
  /** Outward unit normal, in the solid's frame. */
  normal: Vec3;
  /** A point on the face, in the solid's frame. The arrow sits here. */
  at: Vec3;
  areaMm2?: number;
  /** Set when the face is a cylinder, a cone, or a sphere. */
  radiusMm?: number;
  surface?: "cylinder" | "cone" | "sphere";
  /** A point on the cylinder or cone axis, and the axis direction. */
  axisPoint?: Vec3;
  axis?: Vec3;
}

export type PullKind = "move" | "extrude";

export interface PullDrag {
  raw: number;
  distance: number;
  snap: AxisDrag["snap"];
  align: [Vec3, Vec3] | null;
  /** The face the distance lined up with, when it snapped to one. */
  face: FaceLevel | null;
}

/** Hover, before a drag. A double-click repeats the last pull while that pull is the step on screen. */
export function pullHint(previous: number | null): string {
  const base = "Drag to push or pull · Alt: add material";
  if (previous == null || previous === 0) return base;
  return `${base} · double-click: repeat ${formatNumber(Math.abs(previous), 1)} mm`;
}

/** After the pointer lets go. Tab, within {@link TAB_EDIT_MS}, edits this step. */
export function pullDone(distance: number): string {
  const verb = distance < 0 ? "Pushed" : "Pulled";
  return `${verb} ${formatNumber(Math.abs(distance), 1)} mm · Tab to edit`;
}

/** True while Tab still edits the step just made. */
export function tabEditOpen(releasedAt: number, now: number, windowMs = TAB_EDIT_MS): boolean {
  if (!Number.isFinite(releasedAt) || !Number.isFinite(now)) return false;
  const dt = now - releasedAt;
  return dt >= 0 && dt <= windowMs;
}

/**
 * The op a drag commits. Alt on one face adds or cuts a prism (`faceExtrude`).
 * Anything else, including several faces, moves each along its own normal by the same distance.
 * A distance of 0 is no op.
 */
export function pullOp(faces: readonly PullFace[], distance: number, alt: boolean): MoveFacesOp | FaceExtrudeOp | null {
  if (!Number.isFinite(distance) || distance === 0 || faces.length === 0) return null;
  const one = faces[0];
  if (alt && faces.length === 1 && one) return faceExtrudeOp(one.index, distance);
  return moveFacesOp(faces.map((face) => ({ face: face.index, distance })));
}

/**
 * Distance along `line` under the pointer. Other faces' heights snap, Ctrl snaps to a step,
 * and a double-click repeats `previous`. Null when the ray runs along the line.
 */
export function pullDrag(
  ray: Ray,
  origin: Vec3,
  direction: Vec3,
  input: {
    round?: boolean;
    fine?: boolean;
    faces?: readonly FaceLevel[];
    mmPerPx?: number;
    previous?: number | null;
    repeat?: boolean;
  } = {},
): PullDrag | null {
  const dragged = dragAxis(ray, { origin, direction }, input);
  if (!dragged) return null;
  return { raw: dragged.raw, distance: dragged.distance, snap: dragged.snap, align: dragged.align, face: dragged.face };
}

/**
 * Signed heights of the faces that are not being dragged, along `direction` from `origin`.
 * A face whose centre is on the axis is skipped: snapping to it would not move anything.
 */
export function pullLevels(
  faces: readonly PullFace[],
  origin: Vec3,
  direction: Vec3,
  skip: ReadonlySet<number>,
): FaceLevel[] {
  const dir = unit(direction);
  if (!dir) return [];
  const out: FaceLevel[] = [];
  for (const face of faces) {
    if (skip.has(face.index)) continue;
    const delta = sub(face.at, origin);
    const distance = dot(delta, dir);
    if (!Number.isFinite(distance) || Math.abs(distance) < 1e-6) continue;
    out.push({ distance, at: face.at, id: face.index });
  }
  return out;
}

/** The triangles of one face, nine floats a triangle, in the same frame as `positions`. */
export function faceTriangles(positions: ArrayLike<number>, triangles: ArrayLike<number>, face: number): Float32Array {
  const out: number[] = [];
  const count = Math.min(triangles.length, Math.floor(positions.length / 9));
  for (let tri = 0; tri < count; tri += 1) {
    if (triangles[tri] !== face) continue;
    const base = tri * 9;
    for (let i = 0; i < 9; i += 1) out.push(positions[base + i] ?? 0);
  }
  return Float32Array.from(out);
}

/**
 * The client prism shown while the pointer moves: each face's triangles shifted along its normal,
 * plus walls. One distance for every face. Empty at 0.
 */
export function pullGhost(
  positions: ArrayLike<number>,
  triangles: ArrayLike<number>,
  faces: readonly PullFace[],
  distance: number,
): Float32Array {
  if (!Number.isFinite(distance) || distance === 0 || faces.length === 0) return new Float32Array();
  const parts: Float32Array[] = [];
  let total = 0;
  for (const face of faces) {
    const soup = facePrism(faceTriangles(positions, triangles, face.index), face.normal, distance);
    if (soup.length === 0) continue;
    parts.push(soup);
    total += soup.length;
  }
  const out = new Float32Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * The resulting diameter of a cylindrical face moved `distance` along its outward normal.
 * On a boss the normal points away from the axis, so a positive distance grows the diameter.
 * On a hole the normal points toward the axis, so a positive distance shrinks it.
 * Null when the face is not a cylinder, or the move would close it.
 */
export function cylinderDiameter(face: PullFace, distance: number): number | null {
  if (face.surface !== "cylinder" || face.radiusMm == null || !(face.radiusMm > 0)) return null;
  if (!Number.isFinite(distance)) return null;
  const away = axisSense(face);
  const radius = face.radiusMm + away * distance;
  if (!(radius > 1e-6)) return null;
  return radius * 2;
}

/** Distance, and the diameter when exactly one cylindrical face is in the drag. */
export function pullFields(distance: number, faces: readonly PullFace[]): HudField[] {
  const fields: HudField[] = [{ id: "distance", label: "Distance", unit: "mm", value: distance, places: 1 }];
  const cylinders = faces.filter((face) => face.surface === "cylinder" && face.radiusMm != null);
  const only = cylinders.length === 1 ? cylinders[0] : null;
  const diameter = only ? cylinderDiameter(only, distance) : null;
  if (only && diameter != null) fields.push({ id: "diameter", label: "Diameter", unit: "mm", value: diameter, places: 1 });
  return fields;
}

/**
 * A typed diameter, back into the distance that reaches it, for the one cylindrical face.
 * Null when the drag is not a single cylinder.
 */
export function distanceForDiameter(faces: readonly PullFace[], diameter: number): number | null {
  const cylinders = faces.filter((face) => face.surface === "cylinder" && face.radiusMm != null);
  const only = cylinders.length === 1 ? cylinders[0] : null;
  if (!only || only.radiusMm == null || !(diameter > 0)) return null;
  const away = axisSense(only);
  if (away === 0) return null;
  return (diameter / 2 - only.radiusMm) / away;
}

/** +1 when the outward normal points away from the axis (a boss), −1 when it points toward it (a hole). */
function axisSense(face: PullFace): number {
  if (!face.axis || !face.axisPoint) return 1;
  const axis = unit(face.axis);
  if (!axis) return 1;
  const fromAxis = sub(face.at, face.axisPoint);
  const along = dot(fromAxis, axis);
  const radial = sub(fromAxis, scale(axis, along));
  const sense = dot(face.normal, radial);
  if (Math.abs(sense) < 1e-8) return 1;
  return sense > 0 ? 1 : -1;
}

function unit(v: Vec3): Vec3 | null {
  const length = Math.hypot(v[0], v[1], v[2]);
  if (!(length > 1e-12)) return null;
  return [v[0] / length, v[1] / length, v[2] / length];
}
