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

