/**
 * Belt-printer geometry the UI can use before the engine slices a tilted plane.
 * Angle is the nozzle plane against the belt. Advance per layer is
 * `layerHeight / sin(angle)`, which is `layerHeight * √2` at 45°.
 */

export type PrinterKind = "cartesian" | "belt";
export type BeltAxis = "x" | "y" | "z";

export interface BeltSettings {
  /** Nozzle plane against the belt, degrees. 45 is a CR-30. */
  angleDeg: number;
  /** Firmware axis that advances the belt. Z on a CR-30 and a BlackBelt. */
  axis: BeltAxis;
  /** +1 advances as the axis increases. */
  direction: 1 | -1;
  /** Usable width across the belt, mm. */
  widthMm: number;
  /** Cap along the belt, mm. Null is unlimited. */
  maxLengthMm: number | null;
  /** Back-to-back copies, including the original. */
  copies: number;
  /** Gap between copies along the belt, mm. */
  gapMm: number;
}

export const BELT_MOCK_BANNER =
  "Mock belt preview. These layers are a stand-in, not a toolpath. Export and send stay off.";
export const BELT_MOCK_EXPORT =
  "Belt preview is a mock. Export stays off until the engine slices belts.";
export const BELT_MOCK_SEND =
  "Belt preview is a mock. Send stays off until the engine slices belts.";

export function defaultBelt(widthMm = 220): BeltSettings {
  return {
    angleDeg: 45,
    axis: "z",
    direction: 1,
    widthMm: clamp(widthMm, 10, 4000),
    maxLengthMm: null,
    copies: 1,
    gapMm: 5,
  };
}

/** Belt travel between two layers, mm. */
export function beltAdvanceMm(layerHeightMm: number, angleDeg: number): number {
  const sin = Math.sin((clamp(angleDeg, 10, 80) * Math.PI) / 180);
  return layerHeightMm / sin;
}

/**
 * Drawn length of the strip. An unlimited belt is long enough for the copies
 * and then some, and is still a finite mesh.
 */
export function beltStripLength(belt: BeltSettings, partDepthMm: number): { lengthMm: number; unlimited: boolean } {
  const depth = Math.max(partDepthMm, 1);
  const span = belt.copies * depth + Math.max(0, belt.copies - 1) * belt.gapMm;
  const cap = belt.maxLengthMm;
  const unlimited = cap == null;
  const wanted = cap == null ? Math.max(belt.widthMm * 3, span + 80, 480) : cap;
  return { lengthMm: Math.max(wanted, span + 20, 40), unlimited };
}

/**
 * Pose of a unit plane that shows the nozzle plane. Scale Y by `slopeMm`.
 * The low edge sits on the belt at print Y = 0. Print X, Y, Z is scene X, −Z, Y.
 */
export function tiltPose(widthMm: number, heightMm: number, angleDeg: number): {
  rotationX: number;
  x: number;
  y: number;
  z: number;
  slopeMm: number;
} {
  const angle = (clamp(angleDeg, 10, 80) * Math.PI) / 180;
  const slope = Math.max(heightMm, 10) / Math.sin(angle);
  const half = slope / 2;
  return {
    rotationX: -Math.PI / 2 + angle,
    x: widthMm / 2,
    y: half * Math.sin(angle),
    z: -half * Math.cos(angle),
    slopeMm: slope,
  };
}

/** Fill gaps and clamp. A missing length is unlimited. */
export function coerceBelt(value: unknown, widthFallback: number): BeltSettings {
  const row = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const angleDeg = finite(row.angleDeg) ? clamp(row.angleDeg, 10, 80) : 45;
  const axis: BeltAxis = row.axis === "x" || row.axis === "y" || row.axis === "z" ? row.axis : "z";
  const direction: 1 | -1 = row.direction === -1 ? -1 : 1;
  const widthMm = finite(row.widthMm) && row.widthMm > 0 ? clamp(row.widthMm, 10, 4000) : clamp(widthFallback, 10, 4000);
  let maxLengthMm: number | null = null;
  if (row.maxLengthMm != null && finite(row.maxLengthMm) && row.maxLengthMm > 0) {
    maxLengthMm = clamp(row.maxLengthMm, 10, 100000);
  }
  const copies = finite(row.copies) ? Math.round(clamp(row.copies, 1, 24)) : 1;
  const gapMm = finite(row.gapMm) && row.gapMm >= 0 ? clamp(row.gapMm, 0, 500) : 5;
  return { angleDeg, axis, direction, widthMm, maxLengthMm, copies, gapMm };
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
