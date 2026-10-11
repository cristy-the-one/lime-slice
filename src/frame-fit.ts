/** How far `framePart` sits the camera. A short canvas may only increase this. */
export const FRAME_FACTOR = 2.4;

const OFFSET_LEN = Math.hypot(0.85, 0.62, 0.9);

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
  const usableW = Math.max(32, width - 88 - 24);
  const usableH = Math.max(32, height - 24);
  const limit = Math.min(usableW, usableH);
  if (!(px > limit)) return FRAME_FACTOR;
  return FRAME_FACTOR * (px / limit);
}
