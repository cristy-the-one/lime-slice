/**
 * The pose math of a Ctrl-drag in Model: where the pointer ray meets the grab height, and a pose turned about a world
 * axis through the part's middle. Pure, in model space (Z up), so a test can reach it. The pointer handling is in
 * `model-view.ts`.
 */
import type { Affine } from "./model-space.ts";
import type { Mat3 } from "./mesh-place.ts";
import type { GrabAxis } from "./viewport-grab.ts";

export type Point3 = readonly [number, number, number];

/** A ray this close to level meets a horizontal plane too far away, and too unsteadily, to steer a part by. */
const MIN_RISE = 0.04;

/** Where a ray from `origin` along `dir` meets the plane Z = `z`. Null when it runs level or away from it. */
export function rayAtHeight(origin: Point3, dir: Point3, z: number): [number, number, number] | null {
  const length = Math.hypot(dir[0], dir[1], dir[2]);
  if (!(length > 0) || Math.abs(dir[2]) / length < MIN_RISE) return null;
  const t = (z - origin[2]) / dir[2];
  if (!(t > 0)) return null;
  return [origin[0] + dir[0] * t, origin[1] + dir[1] * t, z];
}

/** The rotation of `deg` degrees about a world axis, counter-clockwise seen from the axis tip, as rows. */
export function axisTurn(axis: GrabAxis, deg: number): Mat3 {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  if (axis === "x") return [1, 0, 0, 0, c, -s, 0, s, c];
  if (axis === "y") return [c, 0, s, 0, 1, 0, -s, 0, c];
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

/** `pose` followed by a turn of `deg` degrees about the world axis through `centre`. The scale folded into the pose stays. */
export function turnPoseAbout(pose: Affine, centre: Point3, axis: GrabAxis, deg: number): Affine {
  const r = axisTurn(axis, deg);
  const m = pose.m;
  const next: Mat3 = [
    r[0] * m[0] + r[1] * m[3] + r[2] * m[6], r[0] * m[1] + r[1] * m[4] + r[2] * m[7], r[0] * m[2] + r[1] * m[5] + r[2] * m[8],
    r[3] * m[0] + r[4] * m[3] + r[5] * m[6], r[3] * m[1] + r[4] * m[4] + r[5] * m[7], r[3] * m[2] + r[4] * m[5] + r[5] * m[8],
    r[6] * m[0] + r[7] * m[3] + r[8] * m[6], r[6] * m[1] + r[7] * m[4] + r[8] * m[7], r[6] * m[2] + r[7] * m[5] + r[8] * m[8],
  ];
  const d: Point3 = [pose.t[0] - centre[0], pose.t[1] - centre[1], pose.t[2] - centre[2]];
  const t: [number, number, number] = [
    r[0] * d[0] + r[1] * d[1] + r[2] * d[2] + centre[0],
    r[3] * d[0] + r[4] * d[1] + r[5] * d[2] + centre[1],
    r[6] * d[0] + r[7] * d[1] + r[8] * d[2] + centre[2],
  ];
  return { m: next, t };
}
