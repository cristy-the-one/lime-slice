/** Screen-constant gizmo sizing and drag snapping. Pure math, no Three.js. */

/** Vertical pixels the rotate ring should occupy, regardless of camera distance. */
export const GIZMO_SCREEN_PX = 88;

/**
 * World-space radius that projects to `pixels` of vertical screen height.
 * Perspective dolly changes `distance`; dividing by it keeps the on-screen size put.
 * `zoom` is the camera's orthographic/perspective zoom factor (1 for a normal dolly).
 */
export function gizmoRadiusForPixels(
  distance: number,
  fovDeg: number,
  viewportHeightPx: number,
  pixels: number,
  zoom = 1,
): number {
  const height = Math.max(1, viewportHeightPx);
  const dist = Math.max(1e-4, distance);
  const z = zoom > 1e-4 ? zoom : 1;
  const worldPerPx = (2 * Math.tan((fovDeg * Math.PI) / 360) * dist) / (height * z);
  return pixels * worldPerPx;
}

/** Free drag, or a snapped multiple of `step` while Shift is held. */
export function snapStep(total: number, shift: boolean, step: number): number {
  if (!shift || !(step > 0) || !Number.isFinite(total)) return total;
  return Math.round(total / step) * step;
}
