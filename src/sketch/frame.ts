/**
 * The sketch plane as a frame, and the camera that looks straight at it
 * (`docs/plan-gui-cad-modeling.md`, Plan B §4.3).
 *
 * U and V span the plane. W is the normal the camera sits on. A point on the plane is
 * `origin + u·U + v·V`. Nothing here touches the view.
 */
import { orientEuler, type Mat3 } from "../mesh-place.ts";
import { axesOf, type Workplane } from "../workplane.ts";
import type { Pt, SketchPlane, Vec3 } from "./model.ts";

export interface SketchFrame {
  origin: Vec3;
  u: Vec3;
  v: Vec3;
  w: Vec3;
}

/** How long the camera takes to turn onto the plane. */
export const SKETCH_ANIM_MS = 250;

export interface CameraPose {
  position: Vec3;
  target: Vec3;
  up: Vec3;
}

/** The frame a stored sketch plane names. */
export function frameOf(plane: SketchPlane): SketchFrame {
  const [u, v, w] = axesOf({ source: "global", origin: plane.origin, turn: plane.turn });
  return { origin: [plane.origin[0], plane.origin[1], plane.origin[2]], u, v, w };
}

/** The same frame as a sketch plane: origin, and a turn about X, then Y, then Z. */
export function planeOf(frame: SketchFrame): SketchPlane {
  const turn = orientEuler(basis(frame));
  return { origin: [frame.origin[0], frame.origin[1], frame.origin[2]], turn: [turn.rx, turn.ry, turn.rz] };
}

/** XY, XZ, or YZ through `origin`. W points so a viewer on the positive side looks at the plane. */
export function originFrame(name: "XY" | "XZ" | "YZ", origin: Vec3 = [0, 0, 0]): SketchFrame {
  const at: Vec3 = [origin[0], origin[1], origin[2]];
  if (name === "XY") return { origin: at, u: [1, 0, 0], v: [0, 1, 0], w: [0, 0, 1] };
  if (name === "XZ") return { origin: at, u: [1, 0, 0], v: [0, 0, 1], w: [0, -1, 0] };
  return { origin: at, u: [0, 1, 0], v: [0, 0, 1], w: [1, 0, 0] };
}

export function frameFromWorkplane(plane: Workplane): SketchFrame {
  return frameOf({ origin: plane.origin, turn: plane.turn });
}

/** A plane point, in the frame's space. */
export function toWorld(frame: SketchFrame, at: Pt): Vec3 {
  return [
    frame.origin[0] + frame.u[0] * at[0] + frame.v[0] * at[1],
    frame.origin[1] + frame.u[1] * at[0] + frame.v[1] * at[1],
    frame.origin[2] + frame.u[2] * at[0] + frame.v[2] * at[1],
  ];
}

/** `point` dropped onto the plane, and how far it stands off along W. */
export function toPlane(frame: SketchFrame, point: Vec3): { uv: Pt; height: number } {
  const d: Vec3 = [point[0] - frame.origin[0], point[1] - frame.origin[1], point[2] - frame.origin[2]];
  return { uv: [dot(d, frame.u), dot(d, frame.v)], height: dot(d, frame.w) };
}

/**
 * Where a ray meets the plane. `t` is the distance along `dir` from `origin`.
 * Null when the ray is parallel to the plane or meets it behind the origin.
 */
export function rayOnPlane(frame: SketchFrame, origin: Vec3, dir: Vec3): { uv: Pt; t: number } | null {
  const denom = dot(dir, frame.w);
  if (Math.abs(denom) < 1e-9) return null;
  const gap: Vec3 = [frame.origin[0] - origin[0], frame.origin[1] - origin[1], frame.origin[2] - origin[2]];
  const t = dot(gap, frame.w) / denom;
  if (!(t >= 0) || !Number.isFinite(t)) return null;
  const hit: Vec3 = [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t];
  return { uv: toPlane(frame, hit).uv, t };
}

/** Inside a square of the plane, `half` millimetres each way from the origin. The nearest hit wins a pick. */
export function rayOnQuad(frame: SketchFrame, origin: Vec3, dir: Vec3, half: number): { uv: Pt; t: number } | null {
  const hit = rayOnPlane(frame, origin, dir);
  if (!hit || Math.abs(hit.uv[0]) > half || Math.abs(hit.uv[1]) > half) return null;
  return hit;
}

/**
 * Camera on the outward normal, far enough that `extent` fills the view, looking at `focus` dropped onto the plane.
 * Screen-up is V.
 */
export function lookAtFrame(frame: SketchFrame, focus: Vec3, extent: number, fovDeg: number): CameraPose {
  const target = toWorld(frame, toPlane(frame, focus).uv);
  const radius = Math.max(extent, 10) * 0.5;
  const fov = ((Number.isFinite(fovDeg) && fovDeg > 1 ? fovDeg : 40) * Math.PI) / 180;
  const dist = Math.max(20, (radius / Math.sin(fov / 2)) * 1.35);
  return {
    position: [
      target[0] + frame.w[0] * dist,
      target[1] + frame.w[1] * dist,
      target[2] + frame.w[2] * dist,
    ],
    target,
    up: [frame.v[0], frame.v[1], frame.v[2]],
  };
}

/** Smooth step from `a` to `b`. `t` is 0 at the start and 1 at the end. */
export function lerpPose(a: CameraPose, b: CameraPose, t: number): CameraPose {
  const s = smooth(t);
  return {
    position: lerp(a.position, b.position, s),
    target: lerp(a.target, b.target, s),
    up: unit(lerp(a.up, b.up, s)) ?? [0, 1, 0],
  };
}

/** Millimetres on a plane facing the camera for one pixel. */
export function mmPerPixel(distance: number, fovDeg: number, heightPx: number): number {
  if (!(distance > 0) || !(heightPx > 0) || !(fovDeg > 0)) return 1;
  return (2 * distance * Math.tan((fovDeg * Math.PI) / 360)) / heightPx;
}

export interface PlaneWindow {
  minU: number;
  maxU: number;
  minV: number;
  maxV: number;
}

/**
 * The rectangle of the plane on screen. `up` is the camera's up, `dir` is where it looks.
 * A view that sees the plane edge-on is clamped, so the grid cannot run away.
 */
export function planeWindow(
  frame: SketchFrame,
  camera: { position: Vec3; target: Vec3; up: Vec3; fovDeg: number; aspect: number },
  limit = 2000,
): PlaneWindow {
  const focus = toPlane(frame, camera.target).uv;
  const dist = Math.hypot(
    camera.position[0] - camera.target[0],
    camera.position[1] - camera.target[1],
    camera.position[2] - camera.target[2],
  );
  const halfH = dist * Math.tan(((camera.fovDeg * Math.PI) / 180) / 2);
  const halfW = halfH * (camera.aspect > 0 ? camera.aspect : 1);
  const dir = unit([
    camera.target[0] - camera.position[0],
    camera.target[1] - camera.position[1],
    camera.target[2] - camera.position[2],
  ]) ?? [0, 0, -1];
  const up = unit(camera.up) ?? [0, 1, 0];
  const right = unit(cross(up, dir)) ?? [1, 0, 0];
  const corners: Pt[] = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const world: Vec3 = [
        camera.target[0] + right[0] * halfW * sx + up[0] * halfH * sy,
        camera.target[1] + right[1] * halfW * sx + up[1] * halfH * sy,
        camera.target[2] + right[2] * halfW * sx + up[2] * halfH * sy,
      ];
      corners.push(toPlane(frame, world).uv);
    }
  }
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const at of corners) {
    minU = Math.min(minU, at[0]);
    maxU = Math.max(maxU, at[0]);
    minV = Math.min(minV, at[1]);
    maxV = Math.max(maxV, at[1]);
  }
  const cap = Math.max(40, limit);
  return {
    minU: clamp(minU, focus[0] - cap, focus[0] + cap),
    maxU: clamp(maxU, focus[0] - cap, focus[0] + cap),
    minV: clamp(minV, focus[1] - cap, focus[1] + cap),
    maxV: clamp(maxV, focus[1] - cap, focus[1] + cap),
  };
}

function basis(frame: SketchFrame): Mat3 {
  return [
    frame.u[0], frame.v[0], frame.w[0],
    frame.u[1], frame.v[1], frame.w[1],
    frame.u[2], frame.v[2], frame.w[2],
  ];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function unit(v: Vec3): Vec3 | null {
  const length = Math.hypot(v[0], v[1], v[2]);
  if (!(length > 1e-9)) return null;
  return [v[0] / length, v[1] / length, v[2] / length];
}

function smooth(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(max, Math.max(min, value));
}
