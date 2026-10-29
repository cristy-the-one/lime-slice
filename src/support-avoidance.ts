/** Tree avoidance sent on a slice. Off is omitted so the recipe key holds. */

export function avoidanceSliceField(on: boolean): { supportAvoidance?: true } {
  return on ? { supportAvoidance: true } : {};
}

/** A tip under every belt interface row. Off is omitted so the recipe key holds. */
export function strictStackingSliceField(on: boolean): { supportStrictStacking?: true } {
  return on ? { supportStrictStacking: true } : {};
}
