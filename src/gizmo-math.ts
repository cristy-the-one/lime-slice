/** Screen-constant gizmo sizing, left-edge parking, and drag snapping. Pure math, no Three.js. */

/** Vertical pixels the rotate ring should occupy, regardless of camera distance. */
export const GIZMO_SCREEN_PX = 88;

/** Pixels from the left edge to a parked widget's center, so the rings stay on canvas. */
export const PARK_MARGIN_PX = GIZMO_SCREEN_PX + 18;

/**
 * Horizontal NDC (−1 left, +1 right) for a widget parked just inside the left edge.
 * Clamped so a narrow view stays on screen and a wide one does not drift toward the mesh.
 */
export function parkLeftNdcX(viewportWidthPx: number, marginPx = PARK_MARGIN_PX): number {
  const ndcX = (marginPx / Math.max(viewportWidthPx, 1)) * 2 - 1;
  return Math.max(-0.92, Math.min(-0.42, ndcX));
}

/**
 * Camera-space point for a widget parked on the left, vertically centered, on the
 * plane `distance` in front of the camera. Three.js cameras look down −Z.
 * Multiply by the camera world matrix to place it in the scene. The same depth
 * sizes the widget, so it stays a fixed size at that screen position.
 */
export function parkLeftCameraSpace(
  viewportWidthPx: number,
  distance: number,
  fovDeg: number,
  aspect: number,
  zoom = 1,
  marginPx = PARK_MARGIN_PX,
): readonly [number, number, number] {
  const depth = Math.max(1e-4, distance);
  const ndcX = parkLeftNdcX(viewportWidthPx, marginPx);
  const halfH = Math.tan((fovDeg * Math.PI) / 360) * depth / Math.max(zoom, 1e-4);
  const halfW = halfH * Math.max(aspect, 1e-4);
  return [ndcX * halfW, 0, -depth];
}

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
