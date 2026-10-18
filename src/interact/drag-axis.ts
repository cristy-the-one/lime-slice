/**
 * One distance along a 3D line, from a pointer ray. The same closest approach as a dock arrow
 * (`lineParam`), then a snap: a double-click repeats the last distance, Ctrl snaps to a step,
 * and otherwise a nearby face height wins so the view can draw a dotted line to that face.
 */

import { add, dragValue, lineParam, scale, type Vec3 } from "../model-drag.ts";

export type { Vec3 };

export interface Ray {
  origin: Vec3;
  direction: Vec3;
}

export interface AxisLine {
  origin: Vec3;
  direction: Vec3;
}

/** A face's signed height along the drag axis, and a point on it for the dotted line. */
export interface FaceLevel {
  distance: number;
  at: Vec3;
  id?: number;
}

export interface AxisDragInput {
  /** Ctrl (Cmd on a Mac): snap to `step` and ignore face heights. */
  round?: boolean;
  /** Shift: a free drag keeps hundredths instead of tenths. */
  fine?: boolean;
  /** Whole steps for a round drag. Default 1 mm. */
  step?: number;
  faces?: readonly FaceLevel[];
  /**
   * How close a face height must be, in millimetres. When omitted, 8 px at `mmPerPx`, or 1 mm
   * when the zoom is not known.
   */
  toleranceMm?: number;
  mmPerPx?: number;
  /** The distance a double-click repeats. */
  previous?: number | null;
  /** The gesture is that double-click. */
  repeat?: boolean;
  min?: number;
  max?: number;
}

export interface AxisDrag {
  /** The line parameter before any snap. */
  raw: number;
  distance: number;
  snap: "none" | "round" | "face" | "repeat";
  /** The face the distance aligned to, when `snap` is "face". */
  face: FaceLevel | null;
  /** Ends of the dotted line from the axis to that face. */
  align: [Vec3, Vec3] | null;
}

/** A face snap is this close on screen, the same 8 px as plane snapping. */
export const FACE_SNAP_PX = 8;
/** Two clicks this close, in pixels and in milliseconds, repeat the last distance. */
export const REPEAT_PX = 4;
export const REPEAT_MS = 400;

export interface ClickAt {
  at: number;
  x: number;
  y: number;
}

/** Whether `now` is a second click on the same spot, as SketchUp repeats the last push. */
export function repeatClick(previous: ClickAt | null, now: ClickAt, slopPx = REPEAT_PX, windowMs = REPEAT_MS): boolean {
  if (!previous) return false;
  const dt = now.at - previous.at;
  if (!(dt >= 0) || dt > windowMs) return false;
  return Math.hypot(now.x - previous.x, now.y - previous.y) <= slopPx;
}

/**
 * Distance along `line` under the pointer ray. Null when the ray runs along the line, where the
 * closest point is not one point. A repeat uses `previous` and ignores the ray's place.
 */
export function dragAxis(ray: Ray, line: AxisLine, input: AxisDragInput = {}): AxisDrag | null {
  const origin = line.origin;
  const direction = unit(line.direction);
  const rayDirection = unit(ray.direction);
  if (!direction || !rayDirection) return null;
  const raw = lineParam(origin, direction, ray.origin, rayDirection);
  if (raw == null || !Number.isFinite(raw)) return null;

  const step = input.step ?? 1;
  const limits = { rate: 1, step, min: input.min, max: input.max };
  if (input.repeat && input.previous != null && Number.isFinite(input.previous)) {
    const distance = clamp(input.previous, input.min, input.max);
    return { raw, distance, snap: "repeat", face: null, align: null };
  }
  if (input.round) {
    const distance = dragValue(limits, 0, raw, true, input.fine ?? false);
    return { raw, distance, snap: "round", face: null, align: null };
  }
  const tolerance = toleranceOf(input);
  const face = nearestFace(raw, input.faces ?? [], tolerance);
  if (face) {
    const distance = clamp(face.distance, input.min, input.max);
    const at = add(origin, scale(direction, distance));
    return { raw, distance, snap: "face", face, align: [at, face.at] };
  }
  const distance = dragValue(limits, 0, raw, false, input.fine ?? false);
  return { raw, distance, snap: "none", face: null, align: null };
}

function toleranceOf(input: AxisDragInput): number {
  if (input.toleranceMm != null && Number.isFinite(input.toleranceMm)) return Math.max(0, input.toleranceMm);
  if (input.mmPerPx != null && input.mmPerPx > 0) return FACE_SNAP_PX * input.mmPerPx;
  return 1;
}

function nearestFace(raw: number, faces: readonly FaceLevel[], tolerance: number): FaceLevel | null {
  let best: FaceLevel | null = null;
  let bestDist = Infinity;
  for (const face of faces) {
    if (!Number.isFinite(face.distance)) continue;
    const dist = Math.abs(face.distance - raw);
    if (dist > tolerance || dist >= bestDist) continue;
    best = face;
    bestDist = dist;
  }
  return best;
}

function clamp(value: number, min: number | undefined, max: number | undefined): number {
  let out = value;
  if (min != null) out = Math.max(min, out);
  if (max != null) out = Math.min(max, out);
  return out;
}

function unit(v: Vec3): Vec3 | null {
  if (!Number.isFinite(v[0]) || !Number.isFinite(v[1]) || !Number.isFinite(v[2])) return null;
  const length = Math.hypot(v[0], v[1], v[2]);
  if (!(length > 1e-12)) return null;
  return [v[0] / length, v[1] / length, v[2] / length];
}
