/**
 * What a person measured on printed fit coupons, as the machine library keeps it. Kept apart from the Split to print
 * planner (./partition.ts, which re-exports all of this) so the machine library, which loads with the app, reads it
 * without loading the planner.
 */

export type Clearance = "snug" | "loose" | "press";

/** The materials the table has a row for: PLA, PETG, ABS (ASA reads as it), TPU, and standard resin on the Form 4. */
export type ClearanceKey = "pla" | "petg" | "abs" | "tpu" | "resin";

/** The table's rows, in its order. */
export const CLEARANCE_KEYS: readonly ClearanceKey[] = ["pla", "petg", "abs", "tpu", "resin"];

/** The fit cells, in the order the card lists them. */
export const FIT_NAMES: readonly Clearance[] = ["snug", "loose", "press"];

/**
 * What a person measured on printed coupons, kept beside the machine library (`MachineLibrary.measuredFits`): per row,
 * the cells a coupon fixed, each a gap on each side. `resinFeatureMm` is the thinnest wall that survived on the resin
 * printer. A stored op keeps the clearance it was filled with, so this only reaches a cut made after it is saved.
 */
export interface MeasuredFits {
  cells?: Partial<Record<ClearanceKey, Partial<Record<Clearance, number>>>>;
  resinFeatureMm?: number;
}

/** The measured fits a library holds, each cell a gap from 0 to 2 mm; anything else is left out. */
export function readMeasuredFits(value: unknown): MeasuredFits | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const out: MeasuredFits = {};
  const cells: NonNullable<MeasuredFits["cells"]> = {};
  const rows = raw.cells && typeof raw.cells === "object" && !Array.isArray(raw.cells) ? (raw.cells as Record<string, unknown>) : {};
  for (const key of CLEARANCE_KEYS) {
    const row = rows[key];
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    for (const fit of FIT_NAMES) {
      const n = (row as Record<string, unknown>)[fit];
      if (typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 2) cells[key] = { ...cells[key], [fit]: n };
    }
  }
  if (Object.keys(cells).length > 0) out.cells = cells;
  if (typeof raw.resinFeatureMm === "number" && Number.isFinite(raw.resinFeatureMm) && raw.resinFeatureMm > 0 && raw.resinFeatureMm <= 5) out.resinFeatureMm = raw.resinFeatureMm;
  return Object.keys(out).length > 0 ? out : undefined;
}
