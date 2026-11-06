/**
 * A plane's in-plane axes from its normal, shared by Split's planes (./model-plane.ts, which re-exports it) and the
 * workplane (./workplane.ts), which loads with the app. Kept apart so the app does not load Split's plane math at start.
 */

type Vec3 = [number, number, number];

const AXES: readonly Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

/**
 * The plane's in-plane axes (u, v), from its normal alone: u is the world axis after the normal's
 * nearest one (X → Y → Z → X), made square to the normal, and v = n × u. So Z gets X and Y, X gets
 * Y and Z, and Y gets Z and X.
 */
export function inPlaneAxes(normal: Vec3): [Vec3, Vec3] {
  const n = unit(normal);
  const helper = AXES[(dominant(n) + 1) % 3]!;
  const u = unit(sub(helper, scale(n, dot(helper, n))));
  return [u, cross(n, u)];
}

function dominant(v: Vec3): number {
  const abs = v.map(Math.abs);
  return abs[0]! >= abs[1]! && abs[0]! >= abs[2]! ? 0 : abs[1]! >= abs[2]! ? 1 : 2;
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scale(a: Vec3, k: number): Vec3 {
  return [a[0] * k, a[1] * k, a[2] * k];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function unit(a: Vec3): Vec3 {
  const length = Math.hypot(a[0], a[1], a[2]);
  return length > 0 ? scale(a, 1 / length) : [0, 0, 1];
}
