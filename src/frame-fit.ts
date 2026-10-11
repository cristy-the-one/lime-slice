/** How far `framePart` sits the camera. A short canvas may only increase this. */
export const FRAME_FACTOR = 2.4;

/** Rotate-ring pixels on a canvas wide enough to park the gizmo clear of a centred solid. */
export const DESKTOP_GIZMO_PX = 88;

/** Rotate-ring pixels once the canvas is too narrow for that park. */
export const NARROW_GIZMO_PX = 56;

/** Below this width the prepare gizmo shrinks and the default frame shifts the solid right. */
export const NARROW_CANVAS_PX = 700;

const OFFSET = { x: 0.85, y: 0.62, z: 0.9 };
const OFFSET_LEN = Math.hypot(OFFSET.x, OFFSET.y, OFFSET.z);

/** Screen size of the prepare gizmo. Desktop stays at {@link DESKTOP_GIZMO_PX}. */
export function frameGizmoPx(width: number): number {
  if (!(width > 0) || width >= NARROW_CANVAS_PX) return DESKTOP_GIZMO_PX;
  return NARROW_GIZMO_PX;
}

/**
 * How far the default three-quarter frame slides the solid toward screen-right,
 * in pixels. Wide canvases stay centred. Top, front, and isometric do not use this.
 */
export function framePanPx(width: number): number {
  if (!(width > 0) || width >= NARROW_CANVAS_PX) return 0;
  const gizmo = frameGizmoPx(width);
  const rightEdge = gizmo + 18 + gizmo / 2;
  return rightEdge / 2;
}

/**
 * World offset added to the look-at point. The solid stays at the box centre, so a
 * look-at shifted to the camera's left draws the solid to the right of the gizmo.
 * A zero pan returns a zero offset, which is the desktop frame.
 */
export function frameLookShift(panPx: number, dist: number, fovDeg: number, viewportHeight: number): [number, number, number] {
  if (!(panPx > 0) || !(dist > 0) || !(fovDeg > 0) || !(viewportHeight > 1)) return [0, 0, 0];
  const backX = OFFSET.x / OFFSET_LEN;
  const backZ = OFFSET.z / OFFSET_LEN;
  const rightLen = Math.hypot(backZ, backX) || 1;
  const rightX = backZ / rightLen;
  const rightZ = -backX / rightLen;
  const camDist = dist * OFFSET_LEN;
  const worldPerPx = (2 * Math.tan((fovDeg * Math.PI) / 360) * camDist) / viewportHeight;
  const pan = panPx * worldPerPx;
  return [-rightX * pan, 0, -rightZ * pan];
}

/**
 * Multiplier on the solid's largest side. Stays at {@link FRAME_FACTOR} when that
 * distance already fits the canvas beside the parked gizmo. Never gets closer.
 */
export function frameFactor(spanMm: number, fovDeg: number, viewport: { width: number; height: number }): number {
  const span = Math.max(spanMm, 28);
  const height = Math.max(1, viewport.height);
  const width = Math.max(1, viewport.width);
  if (!(fovDeg > 0) || !Number.isFinite(span)) return FRAME_FACTOR;
  const cam = FRAME_FACTOR * span * OFFSET_LEN;
  const worldPerPx = (2 * Math.tan((fovDeg * Math.PI) / 360) * cam) / height;
  const px = worldPerPx > 0 ? span / worldPerPx : 0;
  const gizmo = frameGizmoPx(width);
  const reserved = width >= NARROW_CANVAS_PX ? gizmo + 24 : gizmo + 18 + gizmo / 2 + 16;
  const usableW = Math.max(32, width - reserved);
  const usableH = Math.max(32, height - 24);
  const limit = Math.min(usableW, usableH);
  if (!(px > limit)) return FRAME_FACTOR;
  return FRAME_FACTOR * (px / limit);
}
