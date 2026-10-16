/**
 * The G-code file Export writes, without the browser.
 * `withPrinterGcode` in the app loads the library and the clock, then calls this.
 */
import { withFooterGrams } from "./estimate.ts";
import { withMachineGcode } from "./machine-gcode.ts";
import { withPrintMeta } from "./print-meta.ts";
import { heatNotes, type Heat } from "./ui/machine-library.ts";

export interface StampedFile {
  gcode: string;
  now: Date;
  version: string;
  layerSeconds: readonly number[];
  layerHeight?: number;
  nozzleDiameter?: number;
  filamentType?: string;
  startGcode: string;
  endGcode: string;
  startOwnsHoming: boolean;
  heat: Heat;
}

export interface PrintFile extends StampedFile {
  grams: number;
}

/** The generated-by line, `M73`, then the printer's start and end text. The grams are already in `gcode`. */
export function stampedPrinterGcode(input: StampedFile): string {
  const stamped = withPrintMeta(input.gcode, {
    now: input.now,
    version: input.version,
    layerSeconds: input.layerSeconds,
    layerHeight: input.layerHeight,
    nozzleDiameter: input.nozzleDiameter,
    filamentType: input.filamentType,
  });
  return withMachineGcode(stamped, input.startGcode, input.endGcode, {
    startOwnsHoming: input.startOwnsHoming,
    heat: { bedC: input.heat.bedC, nozzleC: input.heat.nozzleC },
    notes: heatNotes(input.heat),
  });
}

/** Footer grams, then the same stamp and start and end text the app writes. */
export function printerGcode(input: PrintFile): string {
  return stampedPrinterGcode({ ...input, gcode: withFooterGrams(input.gcode, input.grams) });
}
