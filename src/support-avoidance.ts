/** Tree avoidance sent on a slice. Off is omitted so the recipe key holds. */

export function avoidanceSliceField(on: boolean): { supportAvoidance?: true } {
  return on ? { supportAvoidance: true } : {};
}
