/** The Hole tool's numbers that are not a field: how far Through all reaches, and the screw sizes it offers. Pure. */
import type { Bounds } from "./mesh-place.ts";

/** How far past the far side of the part's box a through hole runs, as the kernel cuts it (`kThroughMarginMm`). */
export const THROUGH_MARGIN_MM = 1;

/**
 * How long a through hole from `origin` along the unit `axis` is: to the farthest corner of `box` along the axis, and the
 * margin past it. The kernel works it out the same way from the solid it cuts, so the ghost shows what Apply cuts.
 */
export function throughLength(box: Bounds, origin: readonly number[], axis: readonly number[]): number {
  let far = 0;
  for (let corner = 0; corner < 8; corner += 1) {
    let along = 0;
    for (let i = 0; i < 3; i += 1) along += (((corner >> i) & 1 ? box.max[i]! : box.min[i]!) - origin[i]!) * axis[i]!;
    far = Math.max(far, along);
  }
  return far + THROUGH_MARGIN_MM;
}

/** A metric screw's clearance hole and the counterbore for its socket head, as diameters in millimetres. */
export interface Screw {
  name: string;
  hole: number;
  bore: number;
  boreDepth: number;
}

/**
 * The medium clearance hole of ISO 273, and a counterbore for an ISO 4762 socket head cap screw: the head's largest
 * diameter plus 1 mm, and its height plus 0.4 mm, so the head sinks just below the face with room for a printed part.
 */
export const SCREWS: readonly Screw[] = [
  { name: "M2", hole: 2.4, bore: 4.8, boreDepth: 2.4 },
  { name: "M2.5", hole: 2.9, bore: 5.5, boreDepth: 2.9 },
  { name: "M3", hole: 3.4, bore: 6.5, boreDepth: 3.4 },
  { name: "M4", hole: 4.5, bore: 8, boreDepth: 4.4 },
  { name: "M5", hole: 5.5, bore: 9.5, boreDepth: 5.4 },
  { name: "M6", hole: 6.6, bore: 11, boreDepth: 6.4 },
  { name: "M8", hole: 9, bore: 14, boreDepth: 8.4 },
];

/** The panel's hole numbers, as radii, and its two boxes. */
export interface HoleChoice {
  radius: number;
  through: boolean;
  counterbore: boolean;
  boreRadius: number;
  boreDepth: number;
}

/** The screw the panel's numbers are, or null: through, counterbored, and each size as the screw has it. */
export function screwOf(hole: HoleChoice): Screw | null {
  if (!hole.through || !hole.counterbore) return null;
  const same = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  return SCREWS.find((screw) => same(hole.radius, screw.hole / 2) && same(hole.boreRadius, screw.bore / 2) && same(hole.boreDepth, screw.boreDepth)) ?? null;
}
