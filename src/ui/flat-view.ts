/**
 * 2D preview camera. The picture is whatever the layer actually draws
 * (gantry X/Y, plus a bed offset), not the part's box and not the bed.
 * A belt layer slides along the belt, so each layer is framed from its own
 * bounds. A similar next layer keeps the zoom and recenters; a layer that
 * would not fit is framed again. A pan or zoom the user made stays until
 * the next layer would leave the canvas.
 */

export interface XyBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** World point at the canvas center, and canvas pixels per world unit. */
export interface FlatView {
  cx: number;
  cy: number;
  scale: number;
}

/** CSS pixels of air around a fitted layer. Device pixels are this times the pixel ratio. */
export const FLAT_PAD_CSS = 28;

const MIN_SPAN = 1e-4;
const MIN_SCALE = 0.02;
const MAX_SCALE = 4000;
/** A fit within this of the current zoom counts as the same zoom. */
const STABLE_ZOOM = 0.08;

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

export function fitFlatView(bounds: XyBounds, width: number, height: number, pad: number): FlatView {
  const spanX = Math.max(MIN_SPAN, bounds.maxX - bounds.minX);
  const spanY = Math.max(MIN_SPAN, bounds.maxY - bounds.minY);
  const inset = insetPad(width, height, pad);
  const availW = Math.max(1, width - inset * 2);
  const availH = Math.max(1, height - inset * 2);
  return {
    cx: (bounds.minX + bounds.maxX) / 2,
    cy: (bounds.minY + bounds.maxY) / 2,
    scale: clampScale(Math.min(availW / spanX, availH / spanY)),
  };
}

export function mapFlat(view: FlatView, width: number, height: number, x: number, y: number): [number, number] {
  return [width / 2 + (x - view.cx) * view.scale, height / 2 - (y - view.cy) * view.scale];
}

export function unmapFlat(view: FlatView, width: number, height: number, sx: number, sy: number): [number, number] {
  return [view.cx + (sx - width / 2) / view.scale, view.cy - (sy - height / 2) / view.scale];
}

/** Screen drag: the world under the cursor follows the pointer. */
export function panFlat(view: FlatView, dsx: number, dsy: number): FlatView {
  return { ...view, cx: view.cx - dsx / view.scale, cy: view.cy + dsy / view.scale };
}

/** Zoom about a canvas pixel. The world point under that pixel stays put. */
export function zoomFlat(view: FlatView, width: number, height: number, sx: number, sy: number, factor: number): FlatView {
  const [wx, wy] = unmapFlat(view, width, height, sx, sy);
  const scale = clampScale(view.scale * factor);
  return {
    cx: wx - (sx - width / 2) / scale,
    cy: wy + (sy - height / 2) / scale,
    scale,
  };
}

export interface ScreenBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function screenBox(view: FlatView, bounds: XyBounds, width: number, height: number): ScreenBox {
  const [x0, y0] = mapFlat(view, width, height, bounds.minX, bounds.minY);
  const [x1, y1] = mapFlat(view, width, height, bounds.maxX, bounds.maxY);
  return { left: Math.min(x0, x1), top: Math.min(y0, y1), right: Math.max(x0, x1), bottom: Math.max(y0, y1) };
}

function insetPad(width: number, height: number, pad: number): number {
  const room = Math.min(width, height) * 0.2;
  return Math.max(0, Math.min(pad, room));
}

function centerOf(bounds: XyBounds): { cx: number; cy: number } {
  return { cx: (bounds.minX + bounds.maxX) / 2, cy: (bounds.minY + bounds.maxY) / 2 };
}

/**
 * Keep `view` when `bounds` already sits inside the padded canvas.
 * Otherwise slide it in. Zoom out only when `allowZoomOut` and the layer
 * is larger than the canvas; a user zoom stays put and the layer is centered
 * so it cannot leave the screen entirely.
 */
export function holdFlatView(
  view: FlatView,
  bounds: XyBounds,
  width: number,
  height: number,
  pad: number,
  allowZoomOut: boolean,
): FlatView {
  const inset = insetPad(width, height, pad);
  const innerL = inset;
  const innerT = inset;
  const innerR = width - inset;
  const innerB = height - inset;
  let next = view;
  let box = screenBox(next, bounds, width, height);
  const bw = Math.max(MIN_SPAN, box.right - box.left);
  const bh = Math.max(MIN_SPAN, box.bottom - box.top);
  const availW = Math.max(1, innerR - innerL);
  const availH = Math.max(1, innerB - innerT);
  const fits = bw <= availW + 0.5 && bh <= availH + 0.5;
  if (!fits && allowZoomOut) {
    const midSx = (box.left + box.right) / 2;
    const midSy = (box.top + box.bottom) / 2;
    next = zoomFlat(next, width, height, midSx, midSy, Math.min(availW / bw, availH / bh));
    box = screenBox(next, bounds, width, height);
  } else if (!fits || outside(box, width, height)) {
    const mid = centerOf(bounds);
    next = { ...next, cx: mid.cx, cy: mid.cy };
    box = screenBox(next, bounds, width, height);
  }
  let dsx = 0;
  let dsy = 0;
  if (box.left < innerL) dsx = innerL - box.left;
  else if (box.right > innerR) dsx = innerR - box.right;
  if (box.top < innerT) dsy = innerT - box.top;
  else if (box.bottom > innerB) dsy = innerB - box.bottom;
  if (box.right - box.left > innerR - innerL) dsx = width / 2 - (box.left + box.right) / 2;
  if (box.bottom - box.top > innerB - innerT) dsy = height / 2 - (box.top + box.bottom) / 2;
  if (dsx === 0 && dsy === 0) return next;
  return panFlat(next, dsx, dsy);
}

function outside(box: ScreenBox, width: number, height: number): boolean {
  return box.right < 0 || box.left > width || box.bottom < 0 || box.top > height;
}

/**
 * The camera after a layer change.
 * Fit mode frames the layer. A zoom close to the one already on screen is
 * kept and the layer is recentered, so stepping similar layers does not
 * pulse. User mode keeps that zoom and only moves enough to keep the layer
 * on screen.
 */
export function frameFlatView(
  previous: FlatView | null,
  bounds: XyBounds,
  width: number,
  height: number,
  pad: number,
  mode: "fit" | "user",
): FlatView {
  const fitted = fitFlatView(bounds, width, height, pad);
  if (!previous) return fitted;
  if (mode === "user") return holdFlatView(previous, bounds, width, height, pad, false);
  const ratio = fitted.scale / previous.scale;
  if (ratio < 1 - STABLE_ZOOM || ratio > 1 + STABLE_ZOOM) return fitted;
  const mid = centerOf(bounds);
  return holdFlatView({ cx: mid.cx, cy: mid.cy, scale: previous.scale }, bounds, width, height, pad, true);
}

/** Multiplier for one wheel event. Positive `deltaY` zooms out. */
export function wheelZoomFactor(deltaY: number, deltaMode: number): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  return Math.exp(-px * 0.0015);
}

/**
 * Pinch and a mouse wheel zoom. A two-finger trackpad scroll pans:
 * it is a pixel-mode wheel with a sideways component, a fraction, or a small step.
 */
export function wheelKind(deltaX: number, deltaY: number, deltaMode: number, ctrlKey: boolean, metaKey: boolean): "pan" | "zoom" {
  if (ctrlKey || metaKey) return "zoom";
  if (deltaMode !== 0) return "zoom";
  if (deltaX !== 0) return "pan";
  if (!Number.isInteger(deltaY)) return "pan";
  if (Math.abs(deltaY) < 50) return "pan";
  return "zoom";
}
