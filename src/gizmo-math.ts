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

export interface PxRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GizmoSeat {
  ndcX: number;
  ndcY: number;
  parked: boolean;
}

const SEAT_GAP_PX = 18;

/**
 * Where a gizmo sits so it does not cover the solid.
 * The first choice is a short gap to one side of the solid's screen box.
 * A seat that would leave the canvas, still cover the solid, or sit on top of
 * the edge park uses that park instead. `stickPark` keeps the park until
 * the offset seat is clearly on canvas, so the widget does not hop between them.
 */
export function placeClearGizmo(
  viewW: number,
  viewH: number,
  object: PxRect | null,
  spanPx: number,
  stickPark = false,
  side: "left" | "right" = "left",
): GizmoSeat {
  const span = Math.max(32, spanPx);
  const radius = span / 2;
  const margin = radius + SEAT_GAP_PX;
  const parkNdc = side === "right" ? parkRightNdcX(viewW, margin) : parkLeftNdcX(viewW, margin);
  const park: GizmoSeat = { ndcX: parkNdc, ndcY: 0, parked: true };
  if (!object || !(object.w > 1) || !(object.h > 1) || !(viewW > 1) || !(viewH > 1)) return park;
  const cx = side === "right" ? object.x + object.w + SEAT_GAP_PX + radius : object.x - SEAT_GAP_PX - radius;
  const cy = object.y + object.h / 2;
  const inset = stickPark ? 28 : 8;
  const left = cx - radius;
  const top = cy - radius;
  const onCanvas = left >= inset && top >= inset && left + span <= viewW - inset && top + span <= viewH - inset;
  const overlaps = left < object.x + object.w && left + span > object.x && top < object.y + object.h && top + span > object.y;
  const parkX = (parkNdc * 0.5 + 0.5) * viewW;
  const nearPark = Math.hypot(cx - parkX, cy - viewH / 2) < radius;
  if (!onCanvas || overlaps || nearPark) return park;
  return { ndcX: (cx / viewW) * 2 - 1, ndcY: -((cy / viewH) * 2 - 1), parked: false };
}

/** Camera-space point for an NDC seat on the plane `distance` in front of the camera. */
export function gizmoAtNdc(
  ndcX: number,
  ndcY: number,
  distance: number,
  fovDeg: number,
  aspect: number,
  zoom = 1,
): readonly [number, number, number] {
  const depth = Math.max(1e-4, distance);
  const halfH = Math.tan((fovDeg * Math.PI) / 360) * depth / Math.max(zoom, 1e-4);
  const halfW = halfH * Math.max(aspect, 1e-4);
  return [ndcX * halfW, ndcY * halfH, -depth];
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
