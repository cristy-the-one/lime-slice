/** Screen-constant gizmo sizing, edge parking, the Model dock, and drag snapping. Pure math, no Three.js. */

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

/** Horizontal NDC for a widget parked just inside the right edge. */
export function parkRightNdcX(viewportWidthPx: number, marginPx = PARK_MARGIN_PX): number {
  const ndcX = 1 - (marginPx / Math.max(viewportWidthPx, 1)) * 2;
  return Math.max(0.42, Math.min(0.92, ndcX));
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
 * The Model dock: one fixed seat on the right edge for every handle that edits the tool's object.
 * Lengths are in handle units, where one unit is the handle's on-screen pixel size.
 */
export const HANDLE_ARROW_TIP = 0.97;
export const HANDLE_RING_RADIUS = 0.7;
export const HANDLE_KNOB_PICK = 0.17;
/** A size knob sits this far out on its axis, past the arrow heads and outside the rings. */
export const DOCK_KNOB_REACH = 1.3;
const DOCK_EDGE_GAP_PX = 18;

/** Pixels from the dock's centre to the far side of its farthest knob. */
export function dockSpanPx(handlePx: number): number {
  return (DOCK_KNOB_REACH + HANDLE_KNOB_PICK) * handlePx;
}

/**
 * Where the dock sits, in NDC. It depends on the canvas width and the handle size and on nothing else,
 * so it does not follow the solid and does not change when the view orbits, zooms, or pans.
 */
export function dockNdc(viewportWidthPx: number, handlePx: number): { ndcX: number; ndcY: number } {
  return { ndcX: parkRightNdcX(viewportWidthPx, dockSpanPx(handlePx) + DOCK_EDGE_GAP_PX), ndcY: 0 };
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

/**
 * Fine steps for the prepare gizmo. Smaller than the Shift snap (1 mm / 15°).
 * The on-screen gizmo and its pick geometry stay the same size; these steps are
 * how a touchpad moves one increment without dragging.
 */
export const GIZMO_NUDGE_MM = 0.1;
export const GIZMO_NUDGE_DEG = 1;

/** One percentage point of part scale per millimetre of travel along a parked scale handle. */
export const SCALE_PERCENT_PER_MM = 2;
/** Shift snap for a scale drag, matching the Scale % field step. */
export const SCALE_SNAP_PERCENT = 5;
/** Wheel and nudge step for the scale tool. */
export const SCALE_NUDGE_PERCENT = 1;
export const SCALE_MIN_PERCENT = 10;
export const SCALE_MAX_PERCENT = 400;

/** The Scale % field's range, rounded to a whole percent. */
export function clampPartPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 100;
  return Math.min(SCALE_MAX_PERCENT, Math.max(SCALE_MIN_PERCENT, Math.round(percent)));
}

/**
 * One discrete step from a mouse wheel or touchpad scroll.
 * Pixel deltas accumulate until `threshold`; a line or page delta is one step.
 * Positive `deltaY` (scroll down) yields a negative notch.
 */
export function wheelNotch(
  deltaY: number,
  deltaMode: number,
  accum: number,
  threshold = 48,
): { notches: number; accum: number } {
  if (!Number.isFinite(deltaY) || deltaY === 0) return { notches: 0, accum };
  if (deltaMode === 1 || deltaMode === 2) return { notches: deltaY > 0 ? -1 : 1, accum: 0 };
  const next = accum + deltaY;
  if (Math.abs(next) < threshold) return { notches: 0, accum: next };
  return { notches: next > 0 ? -1 : 1, accum: 0 };
}
