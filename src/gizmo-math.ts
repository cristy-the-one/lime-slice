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
/** Handle units from the dock's middle to the far side of anything on it: a knob's grab sphere. Arrows and rings sit inside it. */
export const DOCK_REACH = DOCK_KNOB_REACH + HANDLE_KNOB_PICK;
/** The smallest handle size the dock shrinks to on a canvas too small for the full one. */
export const DOCK_MIN_PX = 48;
/** Further left than this the dock would sit over the middle of the solid: it shrinks instead. */
const DOCK_MIN_NDC_X = 0.42;

/**
 * Pixels the dock keeps clear of each canvas edge: 24 from the right, and above and below it the
 * Model toolbar and the Measure chip at the top and the view cube at the bottom right.
 */
export interface DockClear {
  right: number;
  top: number;
  bottom: number;
}
export const MODEL_DOCK_CLEAR: DockClear = { right: 24, top: 96, bottom: 136 };

export interface DockSeat {
  ndcX: number;
  ndcY: number;
  /** The handle size the dock is drawn at, `handlePx` or smaller. */
  handlePx: number;
}

/**
 * Where the dock sits, in NDC, and how large. The dock is a ball of `DOCK_REACH` handle units around
 * its middle, drawn at a constant pixel size; seen in perspective, the side of it nearer the camera
 * stands out further. The seat puts that whole ball inside the clear area, as far right as it goes,
 * and shrinks the handles when even that does not fit. It depends on the canvas size, the field of
 * view, and the handle size and on nothing else, so it does not follow the solid and does not move
 * when the view orbits, zooms, or pans.
 */
export function dockSeat(widthPx: number, heightPx: number, fovDeg: number, handlePx: number, clear: DockClear = MODEL_DOCK_CLEAR): DockSeat {
  const width = Math.max(1, widthPx);
  const height = Math.max(1, heightPx);
  const right = 1 - (2 * clear.right) / width;
  const top = 1 - (2 * clear.top) / height;
  const bottom = -1 + (2 * clear.bottom) / height;
  const ndcY = Math.max(-0.5, Math.min(0.5, (top + bottom) / 2));
  let seat: DockSeat | null = null;
  for (let px = Math.max(handlePx, DOCK_MIN_PX); ; px = Math.max(DOCK_MIN_PX, px - 2)) {
    let lo = -1;
    let hi = 1;
    for (let i = 0; i < 40; i += 1) {
      const mid = (lo + hi) / 2;
      if (dockOutline(width, height, fovDeg, px, mid, ndcY).right <= right) lo = mid;
      else hi = mid;
    }
    // At the smallest size the dock still stays on the right side: on a canvas that small it may run
    // past the margin there, but it never jumps across onto the solid.
    seat = { ndcX: px === DOCK_MIN_PX ? Math.max(lo, DOCK_MIN_NDC_X) : lo, ndcY, handlePx: px };
    const outline = dockOutline(width, height, fovDeg, px, lo, ndcY);
    if ((lo >= DOCK_MIN_NDC_X && outline.top <= top && outline.bottom >= bottom) || px === DOCK_MIN_PX) break;
  }
  return seat;
}

/** The NDC box a dock at (`ndcX`, `ndcY`) covers: its ball's outline, sampled around the cone it fills. */
export function dockOutline(widthPx: number, heightPx: number, fovDeg: number, handlePx: number, ndcX: number, ndcY: number): { right: number; top: number; bottom: number } {
  const t = Math.tan((fovDeg * Math.PI) / 360);
  const aspect = widthPx / Math.max(1, heightPx);
  // The ball's radius over its distance from the camera: `gizmoRadiusForPixels` sizes it by that distance.
  const sine = Math.min(0.95, (DOCK_REACH * handlePx * 2 * t) / Math.max(1, heightPx));
  const cosine = Math.sqrt(1 - sine * sine);
  const u = unit([ndcX * t * aspect, ndcY * t, 1]);
  const e1 = unit([u[2], 0, -u[0]]);
  const e2 = [u[1] * e1[2] - u[2] * e1[1], u[2] * e1[0] - u[0] * e1[2], u[0] * e1[1] - u[1] * e1[0]];
  let right = -Infinity;
  let top = -Infinity;
  let bottom = Infinity;
  for (let i = 0; i < 96; i += 1) {
    const phi = (i / 96) * Math.PI * 2;
    const w = [0, 1, 2].map((k) => cosine * u[k]! + sine * (Math.cos(phi) * e1[k]! + Math.sin(phi) * e2[k]!));
    right = Math.max(right, w[0]! / w[2]! / (t * aspect));
    top = Math.max(top, w[1]! / w[2]! / t);
    bottom = Math.min(bottom, w[1]! / w[2]! / t);
  }
  return { right, top, bottom };
}

function unit(v: number[]): number[] {
  const length = Math.hypot(...v);
  return v.map((value) => value / length);
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
