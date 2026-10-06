/** Extrusion multiplier sent on a slice. `1` is omitted so the recipe key holds. */

export function coerceFlow(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  const rounded = Math.round(value * 1000) / 1000;
  return Math.min(1.5, Math.max(0.5, rounded));
}

export function flowSliceField(flow: number): { flow?: number } {
  if (!Number.isFinite(flow) || Math.abs(flow - 1) < 1e-6) return {};
  return { flow: coerceFlow(flow) };
}
