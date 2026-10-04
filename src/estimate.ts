export interface FeatureEstimate {
  kind: string;
  seconds: number;
  filamentMm: number;
}

export interface FeatureGroup {
  label: string;
  seconds: number;
  grams: number;
}

/** What turns filament length into grams and euros. Not sent with the slice, so editing it never makes the slice stale. */
export interface Filament {
  filamentDiameter: number;
  filamentDensityGCm3: number;
  filamentCostPerKg: number;
}

/** Grams of `mm` of filament, computed as the engine's G-code footer computes them. */
export function filamentGrams(mm: number, filament: Filament): number {
  const r = filament.filamentDiameter * 0.5;
  const area = Math.PI * (r * r);
  return (mm * area * filament.filamentDensityGCm3) / 1000;
}

export function filamentCost(grams: number, filament: Filament): number {
  return (grams / 1000) * filament.filamentCostPerKg;
}

/**
 * `gcode` with the footer's `FILAMENT_G` at `grams`. The engine prints that
 * line at its default density, since the request does not carry the user's.
 */
export function withFooterGrams(gcode: string, grams: number): string {
  return gcode.replace(/^(; TIME:\S+ FILAMENT_MM:\S+ FILAMENT_G:)\S+/m, `$1${grams.toFixed(3)}`);
}

/**
 * Rolls per-feature time into the estimate table.
 *
 * Thin wall joins Inner wall (with inner and wall). The core prints that bead
 * at inner speed and scores it as a wall, same strength class as outer, inner,
 * and wall. Gap fill stays in Infill with sparse, infill, and solid: it is an
 * enclosed bead fed at solid speed.
 */
export function groupFeatures(rows: FeatureEstimate[], filament: Filament): FeatureGroup[] {
  const bucket = (label: string, hit: FeatureEstimate[]) => ({
    label,
    seconds: hit.reduce((s, r) => s + r.seconds, 0),
    grams: filamentGrams(hit.reduce((s, r) => s + r.filamentMm, 0), filament),
  });
  const of = (kinds: string[]) => rows.filter((row) => kinds.includes(row.kind));
  const used = new Set(["outer", "inner", "wall", "thin-wall", "sparse", "infill", "solid", "gap-fill", "top", "support", "support-interface", "travel"]);
  return [
    bucket("Outer wall", of(["outer"])),
    bucket("Inner wall", of(["inner", "wall", "thin-wall"])),
    bucket("Infill", of(["sparse", "infill", "solid", "gap-fill"])),
    bucket("Top / bottom", of(["top"])),
    bucket("Supports", of(["support", "support-interface"])),
    bucket("Travel", of(["travel"])),
    bucket("Other", rows.filter((row) => !used.has(row.kind))),
  ].filter((row) => row.seconds > 0.05 || row.grams > 0.001);
}
