/**
 * The exported file the app writes: footer grams at the filament density,
 * then the generated-by line and `M73`, then the printer's start and end text.
 * `src/app/files.ts` does this with the DOM in the way, so the server calls
 * the same three functions with an explicit clock.
 */
import { readFileSync } from "node:fs";

import { filamentCost, filamentGrams, type Filament } from "../src/estimate.ts";
import { legacyStockEnd, legacyStockStart, spliceText } from "../src/machine-gcode.ts";
import { printerGcode } from "../src/print-file.ts";
import { type Heat } from "../src/ui/machine-library.ts";

export function appVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}

export interface ExportInput {
  gcode: string;
  grams: number;
  now: Date;
  layerSeconds: readonly number[];
  layerHeight: number;
  nozzleDiameter: number;
  filamentType?: string;
  printerName: string;
  startGcode: string;
  endGcode: string;
  startOwnsHoming: boolean;
  heat: Heat;
}

export function exportGcode(input: ExportInput): string {
  return printerGcode({
    gcode: input.gcode,
    grams: input.grams,
    now: input.now,
    version: appVersion(),
    layerSeconds: input.layerSeconds,
    layerHeight: input.layerHeight,
    nozzleDiameter: input.nozzleDiameter,
    filamentType: input.filamentType,
    startGcode: spliceText(input.startGcode, legacyStockStart(input.printerName)),
    endGcode: spliceText(input.endGcode, legacyStockEnd(input.printerName)),
    startOwnsHoming: input.startOwnsHoming,
    heat: input.heat,
  });
}

export function mass(mm: number, filament: Filament): { grams: number; cost: number } {
  const grams = filamentGrams(mm, filament);
  return { grams, cost: filamentCost(grams, filament) };
}
