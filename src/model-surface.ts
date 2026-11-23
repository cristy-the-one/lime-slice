/**
 * Continuity asked of a patch edge. An edge that touches a face starts at G1. A free curve starts at G0.
 * Clicking the badge cycles G0, G1, G2.
 */

export type SeamContinuity = "g0" | "g1" | "g2";

const ORDER: SeamContinuity[] = ["g0", "g1", "g2"];

/** An edge that touches a face starts at G1. A free curve starts at G0. */
export function defaultBoundaryContinuity(touchesFace: boolean): SeamContinuity {
  return touchesFace ? "g1" : "g0";
}

/** The next badge, wrapping after G2. */
export function nextContinuity(current: SeamContinuity): SeamContinuity {
  return ORDER[(ORDER.indexOf(current) + 1) % ORDER.length] ?? "g0";
}
