/**
 * Continuity asked of a patch edge. A patch is G0. G1, G2, and an opening of more than four sides are refused.
 */

export type SeamContinuity = "g0" | "g1" | "g2";

export const PATCH_NOT_YET =
  "G1, G2, an interior guide, and openings with more than four sides are not available yet. A patch is G0, with two to four sides.";

/** Every patch edge is G0, whether or not it touches a face. */
export function defaultBoundaryContinuity(_touchesFace: boolean): SeamContinuity {
  return "g0";
}

let askedLater = false;

/** The badge was asked for G1 or G2. The edge stays G0. */
export function notePatchLater(): void {
  askedLater = true;
}

export function clearPatchLater(): void {
  askedLater = false;
}

export function patchLaterNote(): string | null {
  return askedLater ? PATCH_NOT_YET : null;
}
