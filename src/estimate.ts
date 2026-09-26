export interface FeatureEstimate {
  kind: string;
  seconds: number;
  filamentG: number;
}

export interface FeatureGroup {
  label: string;
  seconds: number;
  grams: number;
}

/**
 * Rolls per-feature time into the estimate table.
 *
 * Thin wall joins Inner wall (with inner and wall). The core prints that bead
 * at inner speed and scores it as a wall, same strength class as outer, inner,
 * and wall. Gap fill stays in Infill with sparse, infill, and solid: it is an
 * enclosed bead fed at solid speed.
 */
export function groupFeatures(rows: FeatureEstimate[]): FeatureGroup[] {
  const bucket = (label: string, kinds: string[]) => {
    const hit = rows.filter((row) => kinds.includes(row.kind));
    return { label, seconds: hit.reduce((s, r) => s + r.seconds, 0), grams: hit.reduce((s, r) => s + r.filamentG, 0) };
  };
  const used = new Set(["outer", "inner", "wall", "thin-wall", "sparse", "infill", "solid", "gap-fill", "top", "support", "support-interface", "travel"]);
  const other = rows.filter((row) => !used.has(row.kind));
  return [
    bucket("Outer wall", ["outer"]),
    bucket("Inner wall", ["inner", "wall", "thin-wall"]),
    bucket("Infill", ["sparse", "infill", "solid", "gap-fill"]),
    bucket("Top / bottom", ["top"]),
    bucket("Supports", ["support", "support-interface"]),
    bucket("Travel", ["travel"]),
    { label: "Other", seconds: other.reduce((s, r) => s + r.seconds, 0), grams: other.reduce((s, r) => s + r.filamentG, 0) },
  ].filter((row) => row.seconds > 0.05 || row.grams > 0.001);
}
