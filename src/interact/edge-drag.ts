/**
 * P2. Drag an edge's knob to fillet it, or chamfer it while Alt is held.
 * The knob sits on the edge's midpoint and points into the angle between its two faces:
 * the bisector of their outward normals, read from the mesh the way `outwardFromMesh` does.
 * Several selected edges move together when the one under the pointer is one of them.
 * The kernel's `maxMm` clamps the radius. No new kernel op: the drag builds a fillet or a chamfer.
 */

import { dragAxis, type Ray } from "./drag-axis.ts";
import { outwardFromMesh, type Vec3 } from "../model-blend.ts";
import { add, edgeAnchor, normalize, scale } from "../model-drag.ts";
import { faceBoundarySegments } from "../model-select.ts";
import { formatMm } from "../model-plane.ts";

export type { Ray, Vec3 };

/** The view's name for the knob, so a tool handle is never treated as this drag. */
export const EDGE_KNOB_ID = "edge-blend";
/** Below this the drag was a click, and nothing is applied. The fillet handle uses the same floor. */
export const EDGE_MIN_MM = 0.05;
/** Ctrl snaps the radius to this, as the fillet handle does. */
export const EDGE_STEP_MM = 0.5;
/** A face boundary this close to the edge's midpoint, in millimetres, is one of the edge's faces. */
export const EDGE_FACE_MM = 0.05;
/** Tab reopens the drag on the step just made, for this long. */
export const EDGE_EDIT_MS = 3000;

export type BlendKind = "fillet" | "chamfer";

export function edgeDragKind(alt: boolean): BlendKind {
  return alt ? "chamfer" : "fillet";
}

/**
 * The edges a drag moves. The hovered edge alone, unless it is already selected: then every
 * selected edge, in the order they were picked.
 */
export function edgeDragEdges(hover: number, selected: readonly number[]): number[] {
  const edges: number[] = [];
  for (const id of selected) if (!edges.includes(id)) edges.push(id);
  return edges.includes(hover) ? edges : [hover];
}

/** Unit bisector of the outward normals. Null when they cancel, so the caller keeps another direction. */
export function blendDirection(normals: readonly Vec3[]): Vec3 | null {
  let x = 0;
  let y = 0;
  let z = 0;
  let count = 0;
  for (const normal of normals) {
    const length = Math.hypot(normal[0], normal[1], normal[2]);
    if (!(length > 1e-9)) continue;
    x += normal[0] / length;
    y += normal[1] / length;
    z += normal[2] / length;
    count += 1;
  }
  if (count === 0) return null;
  const length = Math.hypot(x, y, z);
  if (!(length > 1e-6)) return null;
  return [x / length, y / length, z / length];
}

/**
 * Up to two faces whose outline passes through the edge's midpoint. A corner brings several faces
 * within reach of an endpoint, so the midpoint is what picks out the edge's own faces.
 */
export function facesOnEdge(positions: ArrayLike<number>, triangles: ArrayLike<number>, points: ArrayLike<number>): number[] {
  const mid = edgeAnchor(points, [0, 0, 0])?.point;
  if (!mid) return [];
  const boundary = faceBoundarySegments(positions, triangles);
  const hits: { face: number; dist: number }[] = [];
  for (const [face, flat] of boundary) {
    let dist = Infinity;
    for (let i = 0; i + 5 < flat.length; i += 6) {
      const a: Vec3 = [flat[i]!, flat[i + 1]!, flat[i + 2]!];
      const b: Vec3 = [flat[i + 3]!, flat[i + 4]!, flat[i + 5]!];
      dist = Math.min(dist, segmentDistance(mid, a, b));
    }
    if (dist <= EDGE_FACE_MM) hits.push({ face, dist });
  }
  hits.sort((a, b) => a.dist - b.dist || a.face - b.face);
  return hits.slice(0, 2).map((hit) => hit.face);
}

/**
 * Where the knob sits and which way it drags, in the solid's own frame. The direction is the
 * bisector of the two faces when the mesh has them, and otherwise the direction away from the
 * solid's centre that is square to the edge.
 */
export function edgeFrame(
  positions: ArrayLike<number>,
  triangles: ArrayLike<number>,
  points: ArrayLike<number>,
  center: Vec3,
): { point: Vec3; dir: Vec3 } | null {
  const anchor = edgeAnchor(points, center);
  if (!anchor) return null;
  const normals: Vec3[] = [];
  for (const face of facesOnEdge(positions, triangles, points)) {
    const normal = outwardFromMesh(positions, triangles, face);
    if (normal) normals.push(normal);
  }
  return { point: anchor.point, dir: blendDirection(normals) ?? anchor.out };
}

/** The knob, `size` millimetres out from the midpoint along the bisector. At 0 it sits on the edge. */
export function knobAt(point: Vec3, dir: Vec3, size: number): Vec3 {
  return add(point, scale(normalize(dir), Math.max(0, size)));
}

/**
 * The radius under the pointer: how far the ray's closest point is along the bisector, measured
 * from the edge. Ctrl snaps to `step`. A ray that runs along the bisector has no single distance.
 */
export function blendRadius(
  ray: Ray,
  origin: Vec3,
  dir: Vec3,
  input: { round?: boolean; fine?: boolean; max?: number | null; step?: number } = {},
): number | null {
  const drag = dragAxis(ray, { origin, direction: dir }, {
    round: input.round,
    fine: input.fine,
    step: input.step ?? EDGE_STEP_MM,
    min: 0,
    max: input.max != null && input.max > 0 ? input.max : undefined,
  });
  return drag ? drag.distance : null;
}

/** `maxMm` from a blend probe, when the drag has gone past the largest size that fits. */
export function clampBlendSize(size: number, maxMm: number | null): { size: number; clamped: boolean } {
  if (!Number.isFinite(size) || size < 0) return { size: 0, clamped: false };
  if (maxMm != null && Number.isFinite(maxMm) && maxMm > 0 && size > maxMm) return { size: maxMm, clamped: true };
  return { size, clamped: false };
}

export function edgeDragOp(kind: BlendKind, edges: readonly number[], size: number): { kind: BlendKind; edges: number[]; size: number } {
  return { kind, edges: [...edges], size };
}

/** While the pointer is on an edge and no drag has started. */
export function edgeHoverHint(count: number): string {
  const many = count > 1 ? ` ${count} edges` : "";
  return `Drag to fillet${many} · Alt: chamfer · type a size`;
}

/** The live size, and why it stopped growing when the probe named a largest size. */
export function edgeDragNote(kind: BlendKind, size: number, maxMm: number | null): string {
  const line = `${kind === "fillet" ? "Fillet" : "Chamfer"} ${formatMm(size)} mm.`;
  if (maxMm != null && maxMm > 0 && size >= maxMm - 1e-6) return `${line} The largest that fits is ${formatMm(maxMm)} mm.`;
  return line;
}

/** A probe that refused, in the same words the panel uses, including the largest size when it named one. */
export function edgeDragRefusal(error: string, maxMm: number | null): string {
  const sentence = error.endsWith(".") ? error : `${error}.`;
  const max = maxMm != null && maxMm > 0 ? ` The largest that fits is ${formatMm(maxMm)} mm.` : "";
  return `${sentence}${max}`;
}

/** After the step is applied. Tab, for a few seconds, reopens the drag on it. */
export function edgeAppliedNote(kind: BlendKind, size: number): string {
  return `${kind === "fillet" ? "Fillet" : "Chamfer"} ${formatMm(size)} mm · Tab to edit`;
}

/** Whether Tab still reopens the step made at `started`. */
export function tabStillOpen(started: number, now: number, windowMs = EDGE_EDIT_MS): boolean {
  return now >= started && now - started <= windowMs;
}

function segmentDistance(p: Vec3, a: Vec3, b: Vec3): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abz = b[2] - a[2];
  const length2 = abx * abx + aby * aby + abz * abz;
  const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby + (p[2] - a[2]) * abz) / length2));
  return Math.hypot(p[0] - (a[0] + abx * t), p[1] - (a[1] + aby * t), p[2] - (a[2] + abz * t));
}
