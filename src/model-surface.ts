/**
 * Continuity asked of a patch edge. An edge that touches a face starts at G1. A free curve starts at G0.
 * Clicking the badge cycles G0 and G1. A G2 patch side is not built in this version: the kernel measures each half-side
 * at its ends and refuses a side asked G2 (the curvature jump at the side's midpoint stays over the 0.001 per mm bound),
 * so the badge does not offer it. A stored or MCP patch that asks G2 still goes to the kernel and shows its refusal.
 */

export type SeamContinuity = "g0" | "g1" | "g2";

/** What the Patch badge offers. G2 stays a `SeamContinuity` (Blend builds it; a stored patch may ask it). */
const ORDER: SeamContinuity[] = ["g0", "g1"];

/** An edge that touches a face starts at G1. A free curve starts at G0. */
export function defaultBoundaryContinuity(touchesFace: boolean): SeamContinuity {
  return touchesFace ? "g1" : "g0";
}

/** The next badge, wrapping after G1. A G2 the badge did not set (a stored patch) goes to G0. */
export function nextContinuity(current: SeamContinuity): SeamContinuity {
  return ORDER[(ORDER.indexOf(current) + 1) % ORDER.length] ?? "g0";
}
