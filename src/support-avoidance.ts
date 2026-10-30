/** Tree avoidance sent on a slice. Off is omitted so the recipe key holds. */

export function avoidanceSliceField(on: boolean): { supportAvoidance?: true } {
  return on ? { supportAvoidance: true } : {};
}

/** A tip under every belt interface row. Off is omitted so the recipe key holds. */
export function strictStackingSliceField(on: boolean): { supportStrictStacking?: true } {
  return on ? { supportStrictStacking: true } : {};
}

/**
 * Gaps between enforce dabs filled. Sent only while supports are on and something is painted,
 * so an unpainted slice keeps its recipe key.
 */
export function paintJoinSliceField(on: boolean, painted: boolean): { supportPaintJoin?: true } {
  return on && painted ? { supportPaintJoin: true } : {};
}

/** Tips, thin branches, and interface printed slower. Off is omitted so the recipe key holds. */
export function slowFragileSliceField(on: boolean): { supportSlowFragile?: true } {
  return on ? { supportSlowFragile: true } : {};
}
