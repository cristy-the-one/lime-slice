/**
 * The plate orient from before a tilted workplane, for this visit only.
 * It is not written into `.lime`. An untilted frame clears it, so a later tilt
 * remembers the orient the part has then. Stepping back onto a tilt from an
 * untilted frame remembers the orient being left, so the next untilt can restore it.
 */
import type { Mat3 } from "./mesh-place.ts";

const bases = new Map<string, Mat3>();

/** Remember `orient` the first time `id` tilts. A later tilt keeps that first one. */
export function keepOrientBase(id: string, orient: Mat3) {
  if (!bases.has(id)) bases.set(id, [...orient] as Mat3);
}

export function orientBaseOf(id: string): Mat3 | undefined {
  const kept = bases.get(id);
  return kept ? ([...kept] as Mat3) : undefined;
}

export function clearOrientBase(id: string) {
  bases.delete(id);
}

/**
 * An untilted arrival drops the remembered orient. A tilt that arrives from an untilted
 * frame remembers the orient being left. A tilt that arrives from another tilt keeps the one already stored.
 */
export function syncOrientBase(id: string, leavingUntilted: boolean, arrivingUntilted: boolean, leavingOrient: Mat3 | null) {
  if (arrivingUntilted) clearOrientBase(id);
  else if (leavingUntilted && leavingOrient) keepOrientBase(id, leavingOrient);
}
