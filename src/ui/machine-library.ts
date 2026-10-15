/**
 * Printer, filament, and nozzle library. Version 3 stores belt printers.
 * A later version adds a function to `machineMigrations` at index `n` that rewrites version `n`
 * into version `n + 1`.
 *
 * The slice request's `printer` is nozzle, temperatures, bed, flow, accel,
 * density, cost, pressure advance, and linear advance. It has no filament catalog,
 * no start or end G-code, and no printer host. Those stay in this library.
 * A belt printer also sends `belt` beside `printer`. `enginePrinter` still copies
 * only the fields `PrinterProfile` knows. Start and end G-code are spliced
 * into the exported file by the UI, and stay off the slice request.
 */
import { coerceBelt, defaultBelt, type BeltSettings, type PrinterKind } from "../belt.ts";
import { KLIPPER_NUMBERS, type KlipperLimits, type PrinterProfile } from "../profiles.ts";
import { ADVANCE, firmwareTakesArcs, type Firmware, type Rules } from "../settings-rules.ts";
import { coerceHostKind, type MoonrakerConfigImport, type PrinterHostKind } from "./prusa-link.ts";

export const MACHINE_FILE_VERSION = 3;

export const NOZZLE_MM = [0.4, 0.6, 0.8] as const;

export interface PrinterRecord extends KlipperLimits {
  id: string;
  name: string;
  builtin: boolean;
  bedX: number;
  bedY: number;
  bedZ: number;
  maxVolumetricMm3S: number;
  maxAccel: number;
  /** Stored with the printer. Not sent on the slice request. */
  startGcode: string;
  /** Stored with the printer. Not sent on the slice request. */
  endGcode: string;
  /** Hottest bed this printer accepts, in °C. Every bed temperature sent or written is held at it. */
  maxBedC: number;
  /** Hottest nozzle this printer accepts, in °C. */
  maxNozzleC: number;
  /** The start G-code heats and homes itself, so Export drops the engine's heat and `G28` lines. */
  startOwnsHoming: boolean;
  /** Prusa Link / Moonraker / OctoPrint origin, such as http://192.168.1.50. Empty on a built-in printer. Not sent on the slice request. */
  host: string;
  /** Host protocol when not Prusa Link (`"moonraker"` or `"octoprint"`). Omitted for `"prusalink"`. */
  hostType?: PrinterHostKind;
  /** Prusa Link / Moonraker / OctoPrint API key. Stored with the printer. Not sent on the slice request. */
  apiKey: string;
  /** When set, Send asks Prusa Link to start the job after the upload. */
  startPrint: boolean;
  /** Which advance the printer takes: Klipper's pressure advance or Marlin's linear advance K. */
  firmware: Firmware;
  /**
   * Whether the firmware runs G2/G3. Left out, the firmware decides (`acceptsArcs`): Klipper no,
   * Marlin yes. Off, the slice writes no arcs whatever Arc fit says. Sent as `printer.firmwareArcs`.
   */
  firmwareArcs?: boolean;
  /** Cartesian bed, or a conveyor. */
  kind: PrinterKind;
  /** Sent beside `printer` on the slice request when `kind` is a belt. */
  belt: BeltSettings;
}

export interface FilamentRecord {
  id: string;
  name: string;
  builtin: boolean;
  material: string;
  diameterMm: number;
  densityGCm3: number;
  costPerKg: number;
  nozzleTemp: number;
  bedTemp: number;
  /** Pressure advance keyed by nozzle millimetres, such as "0.4". */
  pressureAdvance: Record<string, number>;
  linearAdvance: Record<string, number>;
  /** Extrusion multiplier. `1` is omitted from a slice request. */
  flow: number;
  /** Set when the filament overrides the strategy retract length. */
  retractLength?: number;
  /** Set when the retract feed is not 30 mm/s. */
  retractSpeed?: number;
}

export interface MachineLibrary {
  version: 3;
  printers: PrinterRecord[];
  filaments: FilamentRecord[];
  printerId: string;
  filamentId: string;
  nozzleMm: number;
}

export interface MachineFile {
  version: 3;
  printer: Omit<PrinterRecord, "id" | "builtin">;
  filament: Omit<FilamentRecord, "id" | "builtin">;
  nozzleMm: number;
}

export type MachineFileResult = { ok: true; file: MachineFile } | { ok: false; message: string };

/** `steps[n]` rewrites a version-n document into version n+1 and sets `version` to n+1. */
export type MachineMigration = (doc: Record<string, unknown>) => Record<string, unknown>;

/**
 * Index 0 would migrate a version-0 file, which was never written.
 * Index 1 adds an empty Prusa Link host, API key, and start-print flag onto each printer.
 * Index 2 adds a cartesian kind and a default belt block. The belt is stored and not sliced.
 */
const machineMigrationSteps: MachineMigration[] = [];
machineMigrationSteps[1] = migrateMachineVersion1;
machineMigrationSteps[2] = migrateMachineVersion2;
export const machineMigrations: readonly MachineMigration[] = machineMigrationSteps;

export interface MachineNumbers extends KlipperLimits {
  nozzleDiameter: number;
  filamentDiameter: number;
  nozzleTemp: number;
  bedTemp: number;
  bedX: number;
  bedY: number;
  bedZ: number;
  maxVolumetricMm3S: number;
  maxAccel: number;
  filamentDensityGCm3: number;
  filamentCostPerKg: number;
  pressureAdvance: number;
  linearAdvance: number;
  flow: number;
  startGcode: string;
  endGcode: string;
  maxBedC: number;
  maxNozzleC: number;
  startOwnsHoming: boolean;
  host: string;
  hostType?: PrinterHostKind;
  apiKey: string;
  startPrint: boolean;
}

export const DEFAULT_MAX_BED_C = 120;
export const DEFAULT_MAX_NOZZLE_C = 300;

/** What a filament asks for, and what the printer is asked for after its limits. */
export interface Heat {
  nozzleC: number;
  bedC: number;
  nozzleAskC: number;
  bedAskC: number;
}

/** The temperatures to send: each ask held at the printer's limit. No printer means no limit. */
export function heatFor(
  printer: Pick<PrinterRecord, "maxBedC" | "maxNozzleC"> | undefined,
  nozzleAskC: number,
  bedAskC: number,
): Heat {
  return {
    nozzleC: Math.min(nozzleAskC, printer?.maxNozzleC ?? Infinity),
    bedC: Math.min(bedAskC, printer?.maxBedC ?? Infinity),
    nozzleAskC,
    bedAskC,
  };
}

/** Comment lines for the exported file, one per temperature the printer's limit held down. */
export function heatNotes(heat: Heat): string[] {
  const notes: string[] = [];
  if (heat.bedC < heat.bedAskC) notes.push(`; bed capped at ${heat.bedC} C (filament ${heat.bedAskC} C)`);
  if (heat.nozzleC < heat.nozzleAskC) notes.push(`; nozzle capped at ${heat.nozzleC} C (filament ${heat.nozzleAskC} C)`);
  return notes;
}

/** The same caps as sentences for the person at the printer panel. */
export function heatWarnings(heat: Heat, filamentName: string): string[] {
  const out: string[] = [];
  if (heat.bedC < heat.bedAskC) out.push(`Bed ${heat.bedC} °C (${filamentName} asks ${heat.bedAskC} °C, this printer stops at ${heat.bedC} °C)`);
  if (heat.nozzleC < heat.nozzleAskC) out.push(`Nozzle ${heat.nozzleC} °C (${filamentName} asks ${heat.nozzleAskC} °C, this printer stops at ${heat.nozzleC} °C)`);
  return out;
}

/** "Nozzle 250 °C · bed 90 °C", the temperatures that are sent. */
export function heatReadout(heat: Heat): string {
  return `Nozzle ${Math.round(heat.nozzleC)} °C · bed ${Math.round(heat.bedC)} °C`;
}

/** The cap warning, always in the markup so a temperature edit can fill or hide it in place. */
export function heatNoteHtml(heat: Heat, filamentName: string, id: string): string {
  const lines = heatWarnings(heat, filamentName);
  return `<div class="meta heat-note" id="${id}" role="status"${lines.length > 0 ? "" : " hidden"}>${lines.map(escapeHtml).join("<br>")}</div>`;
}

export function nozzleKey(mm: number): string {
  return String(Math.round(mm * 1000) / 1000);
}

export function advanceFor(map: Record<string, number>, nozzleMm: number): number {
  const value = map[nozzleKey(nozzleMm)];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function emptyLibrary(): MachineLibrary {
  return { version: MACHINE_FILE_VERSION, printers: [], filaments: [], printerId: "", filamentId: "", nozzleMm: 0.4 };
}

export function builtinLibrary(): MachineLibrary {
  const printers = builtinPrinters();
  const filaments = builtinFilaments();
  return {
    version: MACHINE_FILE_VERSION,
    printers,
    filaments,
    printerId: printers[0]!.id,
    filamentId: filaments[0]!.id,
    nozzleMm: 0.4,
  };
}

/**
 * Put any missing built-in profile back. A stored built-in whose start and end
 * G-code are both blank has not been edited there, so it takes the catalog's
 * G-code, limits, and flag. One with text of its own, and every user copy, is left as it is.
 */
export function ensureBuiltins(library: MachineLibrary): MachineLibrary {
  const catalog = builtinPrinters();
  const printers = library.printers.map((row) => refreshBuiltin(row, catalog.find((printer) => printer.id === row.id)));
  for (const printer of catalog) {
    if (!printers.some((row) => row.id === printer.id)) printers.push(printer);
  }
  const filaments = [...library.filaments];
  for (const filament of builtinFilaments()) {
    if (!filaments.some((row) => row.id === filament.id)) filaments.push(filament);
  }
  const printerId = printers.some((row) => row.id === library.printerId) ? library.printerId : printers[0]!.id;
  const filamentId = filaments.some((row) => row.id === library.filamentId) ? library.filamentId : filaments[0]!.id;
  const nozzleMm = Number.isFinite(library.nozzleMm) && library.nozzleMm > 0 ? library.nozzleMm : 0.4;
  return { version: MACHINE_FILE_VERSION, printers, filaments, printerId, filamentId, nozzleMm };
}

function refreshBuiltin(stored: PrinterRecord, catalog: PrinterRecord | undefined): PrinterRecord {
  if (!stored.builtin || !catalog || stored.startGcode.trim() !== "" || stored.endGcode.trim() !== "") return stored;
  const { startGcode, endGcode, startOwnsHoming, maxBedC, maxNozzleC } = catalog;
  return { ...stored, startGcode, endGcode, startOwnsHoming, maxBedC, maxNozzleC, ...klipperLimits(catalog) };
}

export function selection(library: MachineLibrary): { printer: PrinterRecord; filament: FilamentRecord } | null {
  const printer = library.printers.find((row) => row.id === library.printerId);
  const filament = library.filaments.find((row) => row.id === library.filamentId);
  if (!printer || !filament) return null;
  return { printer, filament };
}

/** Printer fields the slice request already accepts. Start G-code, end G-code, and the Prusa Link host are not among them. */
export function enginePrinter(printer: PrinterRecord, filament: FilamentRecord, nozzleMm: number): PrinterProfile {
  return {
    name: printer.name,
    nozzleDiameter: nozzleMm,
    filamentDiameter: filament.diameterMm,
    nozzleTemp: filament.nozzleTemp,
    bedTemp: filament.bedTemp,
    bedX: printer.bedX,
    bedY: printer.bedY,
    bedZ: printer.bedZ,
    maxVolumetricMm3S: printer.maxVolumetricMm3S,
    maxAccel: printer.maxAccel,
    filamentDensityGCm3: filament.densityGCm3,
    filamentCostPerKg: filament.costPerKg,
    pressureAdvance: advanceFor(filament.pressureAdvance, nozzleMm),
    linearAdvance: advanceFor(filament.linearAdvance, nozzleMm),
    ...klipperLimits(printer),
  };
}

function klipperLimits(printer: KlipperLimits): KlipperLimits {
  return {
    squareCornerVelocity: printer.squareCornerVelocity,
    minimumCruiseRatio: printer.minimumCruiseRatio,
    extruderCornerVelocity: printer.extruderCornerVelocity,
    maxVelocity: printer.maxVelocity,
    maxZVelocity: printer.maxZVelocity,
    maxZAccel: printer.maxZAccel,
  };
}

export function serializeLibrary(library: MachineLibrary): string {
  return JSON.stringify(library);
}

export function parseLibrary(text: string | null): MachineLibrary {
  if (!text) return emptyLibrary();
  try {
    const raw = JSON.parse(text) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyLibrary();
    const migrated = applyMigrations(raw as Record<string, unknown>, machineMigrations, MACHINE_FILE_VERSION);
    if (!migrated.ok) return emptyLibrary();
    const doc = migrated.doc;
    if (doc.version !== MACHINE_FILE_VERSION || !Array.isArray(doc.printers) || !Array.isArray(doc.filaments)) return emptyLibrary();
    const printers = doc.printers.map(readPrinter).filter((row): row is PrinterRecord => row !== null);
    const filaments = doc.filaments.map(readFilament).filter((row): row is FilamentRecord => row !== null);
    const nozzleMm = finite(doc.nozzleMm) && doc.nozzleMm > 0 ? doc.nozzleMm : 0.4;
    return {
      version: MACHINE_FILE_VERSION,
      printers,
      filaments,
      printerId: typeof doc.printerId === "string" ? doc.printerId : "",
      filamentId: typeof doc.filamentId === "string" ? doc.filamentId : "",
      nozzleMm,
    };
  } catch {
    return emptyLibrary();
  }
}

/**
 * Whether a machine file asks for its seam on the belt edge, as printers did
 * before the Seam position choice had a Belt edge option. The flag is not kept;
 * the caller moves the seam choice instead.
 */
export function legacySeamOnEdge(text: string): boolean {
  try {
    const doc = JSON.parse(text) as { printer?: { kind?: unknown; belt?: { seamOnEdge?: unknown } } };
    return doc?.printer?.kind === "belt" && doc.printer.belt?.seamOnEdge === true;
  } catch {
    return false;
  }
}

export function machineFileName(printer: string, filament: string): string {
  const safe = (name: string) => name.trim().replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "machine";
  return `${safe(printer)}__${safe(filament)}.limemachine.json`;
}

export function serializeMachineFile(file: MachineFile): string {
  return JSON.stringify(file, null, 2);
}

export function fileFromSelection(library: MachineLibrary): MachineFile | null {
  const picked = selection(library);
  if (!picked) return null;
  return {
    version: MACHINE_FILE_VERSION,
    printer: stripPrinter(picked.printer),
    filament: stripFilament(picked.filament),
    nozzleMm: library.nozzleMm,
  };
}

export function parseMachineFile(
  text: string,
  steps: readonly MachineMigration[] = machineMigrations,
  target = MACHINE_FILE_VERSION,
): MachineFileResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, message: "This file is not a Lime Slice machine profile." };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: "This file is not a Lime Slice machine profile." };
  }
  const migrated = applyMigrations(raw as Record<string, unknown>, steps, target);
  if (!migrated.ok) return migrated;
  return readFile(migrated.doc);
}

export function selectIn(library: MachineLibrary, printerId: string, filamentId: string, nozzleMm: number): MachineLibrary | string {
  if (!library.printers.some((row) => row.id === printerId)) return "That printer is no longer saved.";
  if (!library.filaments.some((row) => row.id === filamentId)) return "That filament is no longer saved.";
  if (!Number.isFinite(nozzleMm) || nozzleMm <= 0) return "Choose a nozzle size.";
  return { ...library, printerId, filamentId, nozzleMm };
}

export function setFlow(library: MachineLibrary, flow: number): MachineLibrary {
  const value = Math.min(1.5, Math.max(0.5, Math.round(flow * 1000) / 1000));
  const safe = Number.isFinite(value) ? value : 1;
  return {
    ...library,
    filaments: library.filaments.map((filament) => filament.id === library.filamentId ? { ...filament, flow: safe } : filament),
  };
}

export function setRetract(library: MachineLibrary, length: number | null, speed: number | null): MachineLibrary {
  return {
    ...library,
    filaments: library.filaments.map((filament) => {
      if (filament.id !== library.filamentId) return filament;
      const next = { ...filament };
      delete next.retractLength;
      delete next.retractSpeed;
      if (length == null || !Number.isFinite(length)) return next;
      next.retractLength = Math.min(5, Math.max(0, Math.round(length * 1000) / 1000));
      if (speed != null && Number.isFinite(speed) && Math.abs(speed - 30) > 1e-6) {
        next.retractSpeed = Math.min(80, Math.max(5, Math.round(speed)));
      }
      return next;
    }),
  };
}

export function setNozzleTemp(library: MachineLibrary, temp: number): MachineLibrary {
  const rounded = Math.round(temp);
  const safe = Number.isFinite(rounded) ? Math.min(320, Math.max(150, rounded)) : 200;
  return {
    ...library,
    filaments: library.filaments.map((filament) => filament.id === library.filamentId ? { ...filament, nozzleTemp: safe } : filament),
  };
}

export function setAdvance(library: MachineLibrary, pressure: number, linear: number): MachineLibrary {
  const key = nozzleKey(library.nozzleMm);
  return {
    ...library,
    filaments: library.filaments.map((filament) => filament.id === library.filamentId
      ? {
          ...filament,
          pressureAdvance: { ...filament.pressureAdvance, [key]: pressure },
          linearAdvance: { ...filament.linearAdvance, [key]: linear },
        }
      : filament),
  };
}

export function setGcode(library: MachineLibrary, startGcode: string, endGcode: string): MachineLibrary {
  return {
    ...library,
    printers: library.printers.map((printer) => printer.id === library.printerId ? { ...printer, startGcode, endGcode } : printer),
  };
}

/** Store the temperature limits and the start-block flag on the active printer. */
export function setHeatLimits(library: MachineLibrary, maxBedC: number, maxNozzleC: number, startOwnsHoming: boolean): MachineLibrary {
  const bed = Number.isFinite(maxBedC) ? Math.min(200, Math.max(30, Math.round(maxBedC))) : DEFAULT_MAX_BED_C;
  const nozzle = Number.isFinite(maxNozzleC) ? Math.min(500, Math.max(150, Math.round(maxNozzleC))) : DEFAULT_MAX_NOZZLE_C;
  return {
    ...library,
    printers: library.printers.map((printer) => printer.id === library.printerId ? { ...printer, maxBedC: bed, maxNozzleC: nozzle, startOwnsHoming } : printer),
  };
}

/** The active printer's belt, or null when the printer is cartesian. */
export function beltStamp(library: MachineLibrary): BeltSettings | null {
  const printer = selection(library)?.printer;
  if (!printer || printer.kind !== "belt") return null;
  return printer.belt;
}

/** Store the firmware on the active printer. It picks which advance the slice sends. */
export function setActiveFirmware(library: MachineLibrary, firmware: Firmware): MachineLibrary {
  return {
    ...library,
    printers: library.printers.map((printer) => printer.id === library.printerId ? { ...printer, firmware } : printer),
  };
}

/** Whether this printer's firmware runs G2/G3: its own answer, else its firmware's default. A missing printer counts as Klipper. */
export function acceptsArcs(printer: Pick<PrinterRecord, "firmware" | "firmwareArcs"> | undefined): boolean {
  return firmwareTakesArcs(printer?.firmware ?? "klipper", printer?.firmwareArcs);
}

/**
 * Store whether the active printer's firmware runs G2/G3. `null` clears the answer, so the
 * printer follows its firmware's default again; an undo step restores it that way.
 */
export function setActiveFirmwareArcs(library: MachineLibrary, on: boolean | null): MachineLibrary {
  return {
    ...library,
    printers: library.printers.map((printer) => {
      if (printer.id !== library.printerId) return printer;
      const next: PrinterRecord = { ...printer };
      if (on === null) delete next.firmwareArcs;
      else next.firmwareArcs = on;
      return next;
    }),
  };
}

/** Store the kind and belt on the active printer. `enginePrinter` still omits the belt; the slice request sends it beside `printer`. */
export function setActiveBelt(library: MachineLibrary, kind: PrinterKind, belt: BeltSettings): MachineLibrary {
  return {
    ...library,
    printers: library.printers.map((printer) => printer.id === library.printerId ? { ...printer, kind, belt } : printer),
  };
}

/** Store the printer host connection on the active printer. An empty host means Send stays off. */
export function setLink(
  library: MachineLibrary,
  host: string,
  apiKey: string,
  startPrint: boolean,
  hostType?: PrinterHostKind,
): MachineLibrary {
  const kind = coerceHostKind(hostType);
  return {
    ...library,
    printers: library.printers.map((printer) => {
      if (printer.id !== library.printerId) return printer;
      const next: PrinterRecord = { ...printer, host, apiKey, startPrint };
      if (kind === "prusalink") delete next.hostType;
      else next.hostType = kind;
      return next;
    }),
  };
}

/** Apply kinematic limits imported from Moonraker's `printer.cfg` onto the active printer. */
export function applyMoonrakerLimits(
  library: MachineLibrary,
  limits: MoonrakerConfigImport["limits"],
): MachineLibrary {
  return {
    ...library,
    printers: library.printers.map((printer) => {
      if (printer.id !== library.printerId) return printer;
      return {
        ...printer,
        maxAccel: limits.maxAccel ?? printer.maxAccel,
        maxVelocity: limits.maxVelocity ?? printer.maxVelocity,
        squareCornerVelocity: limits.squareCornerVelocity ?? printer.squareCornerVelocity,
        minimumCruiseRatio: limits.minimumCruiseRatio ?? printer.minimumCruiseRatio,
        extruderCornerVelocity: limits.extruderCornerVelocity ?? printer.extruderCornerVelocity,
        maxZVelocity: limits.maxZVelocity ?? printer.maxZVelocity,
        maxZAccel: limits.maxZAccel ?? printer.maxZAccel,
      };
    }),
  };
}

/** Apply bed volume, nozzle size, filament diameter, and temperature caps from Moonraker's `printer.cfg`. */
export function applyMoonrakerGeometry(
  library: MachineLibrary,
  geometry: MoonrakerConfigImport["geometry"],
): MachineLibrary {
  const nozzleMm = geometry.nozzleDiameter && geometry.nozzleDiameter > 0 ? geometry.nozzleDiameter : library.nozzleMm;
  return {
    ...library,
    nozzleMm,
    printers: library.printers.map((printer) => {
      if (printer.id !== library.printerId) return printer;
      return {
        ...printer,
        bedX: geometry.bedX ?? printer.bedX,
        bedY: geometry.bedY ?? printer.bedY,
        bedZ: geometry.bedZ ?? printer.bedZ,
        maxBedC: geometry.maxBedC ?? printer.maxBedC,
        maxNozzleC: geometry.maxNozzleC ?? printer.maxNozzleC,
      };
    }),
    filaments: library.filaments.map((filament) => {
      if (filament.id !== library.filamentId) return filament;
      return {
        ...filament,
        diameterMm: geometry.filamentDiameter ?? filament.diameterMm,
      };
    }),
  };
}

/**
 * Copy a previously saved host onto the active printer when that printer has none.
 * The caller drops the old store after this so a cleared host stays cleared.
 */
export function adoptLegacyLink(
  library: MachineLibrary,
  legacy: { url: string; apiKey: string; startPrint: boolean } | null,
): MachineLibrary {
  const url = legacy?.url.trim() ?? "";
  if (!url) return library;
  const picked = selection(library);
  if (!picked || picked.printer.host.trim()) return library;
  return setLink(library, url, legacy?.apiKey ?? "", legacy?.startPrint === true);
}

export function saveActive(library: MachineLibrary, numbers: MachineNumbers): MachineLibrary | string {
  if (!selection(library)) return "Choose a printer and a filament first.";
  return writeNumbers(library, library.printerId, library.filamentId, numbers);
}

/** Overwrite a printer with this name, or add one and select it. The active filament keeps the material numbers. */
export function savePrinterName(library: MachineLibrary, name: string, numbers: MachineNumbers, id: string): MachineLibrary | string {
  const trimmed = name.trim();
  if (!trimmed) return "Name the printer first.";
  if (!selection(library)) return "Choose a printer and a filament first.";
  const existing = library.printers.find((printer) => printer.name === trimmed);
  if (existing) return writeNumbers({ ...library, printerId: existing.id }, existing.id, library.filamentId, numbers);
  // The firmware facts and the belt are not among the numbers, so the new printer takes the active one's.
  const active = selection(library)!.printer;
  const facts = {
    firmware: active.firmware,
    ...(active.firmwareArcs !== undefined ? { firmwareArcs: active.firmwareArcs } : {}),
    kind: active.kind,
    belt: { ...active.belt },
  };
  const added: MachineLibrary = {
    ...library,
    printerId: id,
    printers: [...library.printers, { ...blankPrinter(id, trimmed), ...facts, builtin: false }],
  };
  return writeNumbers(added, id, library.filamentId, numbers);
}

export function duplicateActive(library: MachineLibrary, printerId: string, filamentId: string): MachineLibrary | string {
  const picked = selection(library);
  if (!picked) return "Choose a printer and a filament first.";
  return {
    ...library,
    printerId,
    filamentId,
    printers: [...library.printers, { ...picked.printer, id: printerId, builtin: false, name: uniqueName(library.printers, `${picked.printer.name} copy`) }],
    filaments: [...library.filaments, { ...picked.filament, id: filamentId, builtin: false, name: uniqueName(library.filaments, `${picked.filament.name} copy`), pressureAdvance: { ...picked.filament.pressureAdvance }, linearAdvance: { ...picked.filament.linearAdvance } }],
  };
}

export function deleteActive(library: MachineLibrary): MachineLibrary | string {
  const picked = selection(library);
  if (!picked) return "Choose a printer and a filament first.";
  if (picked.printer.builtin) return "Built-in profiles stay in the catalog. Duplicate one to change the copy.";
  const printers = library.printers.filter((row) => row.id !== picked.printer.id);
  const filaments = picked.filament.builtin ? library.filaments : library.filaments.filter((row) => row.id !== picked.filament.id);
  const fallbackPrinter = printers.find((row) => row.id === "lime-220") ?? printers[0];
  const fallbackFilament = filaments.find((row) => row.id === "lime-pla") ?? filaments[0];
  if (!fallbackPrinter || !fallbackFilament) return "Choose a printer and a filament first.";
  const filamentId = filaments.some((row) => row.id === library.filamentId) ? library.filamentId : fallbackFilament.id;
  return {
    ...library,
    printers,
    filaments,
    printerId: printers.some((row) => row.id === library.printerId) ? library.printerId : fallbackPrinter.id,
    filamentId,
  };
}

export function importInto(library: MachineLibrary, file: MachineFile, printerId: string, filamentId: string): MachineLibrary {
  return {
    ...library,
    printerId,
    filamentId,
    nozzleMm: file.nozzleMm,
    printers: [...library.printers, { ...file.printer, id: printerId, builtin: false, name: uniqueName(library.printers, file.printer.name) }],
    filaments: [...library.filaments, { ...file.filament, id: filamentId, builtin: false, name: uniqueName(library.filaments, file.filament.name), pressureAdvance: { ...file.filament.pressureAdvance }, linearAdvance: { ...file.filament.linearAdvance } }],
  };
}

export function adoptProfile(library: MachineLibrary, profile: PrinterProfile, printerId: string, filamentId: string): MachineLibrary {
  const key = nozzleKey(profile.nozzleDiameter);
  const printer: PrinterRecord = {
    id: printerId,
    name: profile.name,
    builtin: false,
    bedX: profile.bedX,
    bedY: profile.bedY,
    bedZ: profile.bedZ,
    maxVolumetricMm3S: profile.maxVolumetricMm3S,
    maxAccel: profile.maxAccel,
    startGcode: "",
    endGcode: "",
    maxBedC: DEFAULT_MAX_BED_C,
    maxNozzleC: DEFAULT_MAX_NOZZLE_C,
    startOwnsHoming: false,
    host: "",
    apiKey: "",
    startPrint: false,
    firmware: "klipper",
    kind: "cartesian",
    belt: defaultBelt(profile.bedX),
    ...klipperLimits(profile),
  };
  const filament: FilamentRecord = {
    id: filamentId,
    name: "Saved filament",
    builtin: false,
    material: "Saved",
    diameterMm: profile.filamentDiameter,
    densityGCm3: profile.filamentDensityGCm3,
    costPerKg: profile.filamentCostPerKg,
    nozzleTemp: profile.nozzleTemp,
    bedTemp: profile.bedTemp,
    pressureAdvance: { [key]: profile.pressureAdvance },
    linearAdvance: { [key]: profile.linearAdvance },
    flow: 1,
  };
  return {
    ...library,
    printerId,
    filamentId,
    nozzleMm: profile.nozzleDiameter,
    printers: [...library.printers, printer],
    filaments: [...library.filaments, filament],
  };
}

const GCODE_TIP = "Start and end G-code are inserted into Export and Send. They are not sent to the slicer. Unless Start G-code heats and homes is on, the engine still writes temperatures and homing first. {bed} and {nozzle} become the temperatures after the printer's limits. Leave both blank and the file stays the engine's bytes.";

const OWNS_HOMING_TIP = "Turn on when the start G-code heats and homes by itself, such as a Klipper PRINT_START macro. Export then drops the engine's own heat and G28 lines and writes the start G-code first.";

const LIMIT_TIP = "The hottest bed and nozzle this printer accepts. Any temperature above it is held at the limit in the slice and in the exported file, with a comment line that says so.";

const ARCS_TIP = "Whether this printer runs G2/G3 arc moves. Off, the slice writes no arcs, whatever Arc fit says. Klipper runs them only with a [gcode_arcs] section in printer.cfg; without it each arc is skipped and the next move pushes its plastic at once, which can stop the print. A stock Klipper config has none, so a Klipper printer starts off. Marlin builds usually have ARC_SUPPORT, so a Marlin printer starts on.";

const BELT_DIRECTION_TIP = "Which way the belt axis counts in the printer's firmware; it does not turn the plate around. The end of the part nearest the arrow head in Prepare prints first and leaves the printer first.";

const BELT_TIP = "The engine slices this belt. Export follows the slice. Send follows the printer connection. Seam on the belt edge and the belt raft stay off until those boxes are checked. A raft is a pad on the belt under the part and 1 mm past it, raft layers times the layer height thick; the part stands on it. Supports on a belt printer grow down to the tilted belt. They are not available together with a raft. The end of the part nearest the arrow head in Prepare prints first and leaves the printer first.";

/** The printer chip's label: "Lime 220 · PLA · 0.4 mm". */
export function machineChipLabel(library: MachineLibrary): string {
  const picked = selection(library);
  if (!picked) return "No printer";
  return `${picked.printer.name} · ${picked.filament.name} · ${nozzleKey(library.nozzleMm)} mm`;
}

/** The printer, filament, and nozzle pickers of the printer chip. */
export function machinePickHtml(library: MachineLibrary): string {
  const picked = selection(library);
  const nozzles: number[] = [...NOZZLE_MM];
  if (!nozzles.some((size) => nozzleKey(size) === nozzleKey(library.nozzleMm))) nozzles.push(library.nozzleMm);
  const printerOptions = library.printers
    .map((printer) => `<option value="${escapeHtml(printer.id)}"${printer.id === library.printerId ? " selected" : ""}>${escapeHtml(printer.name)}</option>`)
    .join("");
  const filamentOptions = library.filaments
    .map((filament) => `<option value="${escapeHtml(filament.id)}"${filament.id === library.filamentId ? " selected" : ""}>${escapeHtml(filament.name)}</option>`)
    .join("");
  const nozzleOptions = nozzles
    .map((size) => `<option value="${nozzleKey(size)}"${nozzleKey(size) === nozzleKey(library.nozzleMm) ? " selected" : ""}>${nozzleKey(size)} mm</option>`)
    .join("");
  return `
    <label class="field">Printer
      <select id="machinePrinter" aria-label="Printer">${printerOptions}</select>
    </label>
    <label class="field">Filament
      <select id="machineFilament" aria-label="Filament">${filamentOptions}</select>
    </label>
    <label class="field">Nozzle
      <select id="machineNozzle" aria-label="Nozzle size">${nozzleOptions}</select>
    </label>
    ${picked ? heatNoteHtml(heatFor(picked.printer, picked.filament.nozzleTemp, picked.filament.bedTemp), picked.filament.name, "printerHeatNote") : ""}
    <button class="btn" id="editPrinter" type="button">Edit printer…</button>`;
}

export function machineSectionHtml(
  library: MachineLibrary,
  live: { advance: number; nozzleTemp: number; bedTemp: number; flow: number },
  rules: Rules,
  linkSummary = "",
): string {
  const picked = selection(library);
  const advance = ADVANCE[rules.firmware];
  const heat = heatFor(picked?.printer, live.nozzleTemp, live.bedTemp);
  return `
    <div class="machine-block">
      ${beltFieldsHtml(picked?.printer, rules)}
      <label class="field setting" data-label="firmware" data-keywords="klipper marlin pressure advance linear advance">Firmware
        <select id="machineFirmware" aria-label="Printer firmware">
          <option value="klipper"${rules.firmware === "klipper" ? " selected" : ""}>Klipper</option>
          <option value="marlin"${rules.firmware === "marlin" ? " selected" : ""}>Marlin</option>
        </select>
      </label>
      <label class="check setting" data-label="firmware accepts arcs" data-keywords="g2 g3 arc fit gcode_arcs arc_support klipper marlin" data-tip="${ARCS_TIP}"><input id="machineArcs" type="checkbox" ${rules.firmwareArcs ? "checked" : ""}/> Firmware accepts arcs (G2/G3)</label>
      <label class="field setting" data-label="${advance.label.toLowerCase()}" data-keywords="filament nozzle pressure advance linear advance klipper marlin">${advance.label}
        <input id="machineAdvance" type="number" min="0" max="${advance.max}" step="${advance.step}" value="${live.advance}" aria-label="${advance.label} for this filament and nozzle" />
      </label>
      <label class="field setting" data-label="flow" data-keywords="extrusion multiplier flow ratio">Flow
        <input id="machineFlow" type="number" min="0.5" max="1.5" step="0.01" value="${live.flow}" aria-label="Flow multiplier for this filament" />
      </label>
      <div class="meta" id="machineTemps">${heatReadout(heat)}</div>
      ${heatNoteHtml(heat, picked?.filament.name ?? "", "machineHeatNote")}
      <div class="row">
        <button class="btn" id="machineSave" type="button">Save</button>
        <details class="machine-more" id="machineMore">
          <summary class="btn" aria-label="Machine actions">More</summary>
          <div class="profile-actions">
            <input id="machineName" type="text" aria-label="Printer name" placeholder="Printer name" />
            <button class="btn" id="machineDuplicate" type="button">Duplicate</button>
            <button class="btn" id="machineDelete" type="button">Delete</button>
            <button class="btn" id="machineExport" type="button">Export</button>
            <label class="btn file">Import<input id="machineFile" type="file" accept=".limemachine.json,application/json" /></label>
            <label class="field setting" data-label="start g-code" data-keywords="start gcode header" data-tip="${GCODE_TIP}">Start G-code
              <textarea id="machineStart" class="machine-gcode" rows="3" aria-label="Start G-code">${escapeHtml(picked?.printer.startGcode ?? "")}</textarea>
            </label>
            <label class="field setting" data-label="end g-code" data-keywords="end gcode footer" data-tip="${GCODE_TIP}">End G-code
              <textarea id="machineEnd" class="machine-gcode" rows="3" aria-label="End G-code">${escapeHtml(picked?.printer.endGcode ?? "")}</textarea>
            </label>
            <label class="check setting" data-label="start g-code heats and homes" data-keywords="print_start macro klipper homing owns" data-tip="${OWNS_HOMING_TIP}"><input id="machineOwnsHoming" type="checkbox" ${picked?.printer.startOwnsHoming ? "checked" : ""}/> Start G-code heats and homes</label>
            <label class="field setting" data-label="max bed temperature" data-keywords="bed limit cap heated belt" data-tip="${LIMIT_TIP}">Max bed °C
              <input id="machineMaxBed" type="number" min="30" max="200" step="1" value="${picked?.printer.maxBedC ?? DEFAULT_MAX_BED_C}" aria-label="Hottest bed this printer accepts" />
            </label>
            <label class="field setting" data-label="max nozzle temperature" data-keywords="nozzle limit cap hotend" data-tip="${LIMIT_TIP}">Max nozzle °C
              <input id="machineMaxNozzle" type="number" min="150" max="500" step="1" value="${picked?.printer.maxNozzleC ?? DEFAULT_MAX_NOZZLE_C}" aria-label="Hottest nozzle this printer accepts" />
            </label>
            <label class="field setting machine-link" data-label="printer host type" data-keywords="prusa link moonraker klipper octoprint host send">Host type
              <select id="machineHostType" aria-label="Printer host type">
                <option value="prusalink"${coerceHostKind(picked?.printer.hostType) === "prusalink" ? " selected" : ""}>Prusa Link</option>
                <option value="moonraker"${coerceHostKind(picked?.printer.hostType) === "moonraker" ? " selected" : ""}>Moonraker (Klipper)</option>
                <option value="octoprint"${coerceHostKind(picked?.printer.hostType) === "octoprint" ? " selected" : ""}>OctoPrint</option>
              </select>
            </label>
            <label class="field setting machine-link" data-label="prusa link host" data-keywords="printer host url send moonraker octoprint" data-tip="Host and API key are stored on this printer and in an exported machine file. Built-in printers start with an empty host. Send uploads the current G-code to Prusa Link, Moonraker, or OctoPrint. The slicer does not talk to the printer.">Prusa Link host
              <input id="machineHost" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="http://192.168.1.50" value="${escapeHtml(picked?.printer.host ?? "")}" aria-label="Prusa Link host" />
            </label>
            <label class="field setting machine-link" data-label="prusa link api key" data-keywords="printer key password send moonraker octoprint">Prusa Link API key
              <input id="machineKey" type="password" autocomplete="off" spellcheck="false" value="${escapeHtml(picked?.printer.apiKey ?? "")}" aria-label="Prusa Link API key" />
            </label>
            <label class="check setting machine-link" data-label="start print after upload" data-keywords="prusa link send moonraker octoprint"><input id="machineStartPrint" type="checkbox" ${picked?.printer.startPrint ? "checked" : ""}/> Start print after upload</label>
            <div class="row machine-link">
              <button class="btn" id="prusaTest" type="button">Test connection</button>
              <button class="btn" id="prusaJob" type="button">Job status</button>
              <button class="btn" id="moonrakerImport" type="button" data-tip="Read velocity, acceleration, bed size, and nozzle from Moonraker printer.cfg">Read printer.cfg</button>
            </div>
            <div class="meta machine-link" id="prusaStatus">${escapeHtml(linkSummary)}</div>
          </div>
        </details>
      </div>
    </div>`;
}

function writeNumbers(library: MachineLibrary, printerId: string, filamentId: string, numbers: MachineNumbers): MachineLibrary {
  const key = nozzleKey(numbers.nozzleDiameter);
  return {
    ...library,
    printerId,
    filamentId,
    nozzleMm: numbers.nozzleDiameter,
    printers: library.printers.map((printer) => {
      if (printer.id !== printerId) return printer;
      const hostType = coerceHostKind(numbers.hostType ?? printer.hostType);
      const next: PrinterRecord = {
        ...printer,
        bedX: numbers.bedX,
        bedY: numbers.bedY,
        bedZ: numbers.bedZ,
        maxVolumetricMm3S: numbers.maxVolumetricMm3S,
        maxAccel: numbers.maxAccel,
        startGcode: numbers.startGcode,
        endGcode: numbers.endGcode,
        maxBedC: numbers.maxBedC,
        maxNozzleC: numbers.maxNozzleC,
        startOwnsHoming: numbers.startOwnsHoming,
        host: numbers.host,
        apiKey: numbers.apiKey,
        startPrint: numbers.startPrint,
        ...klipperLimits(numbers),
      };
      if (hostType === "prusalink") delete next.hostType;
      else next.hostType = hostType;
      return next;
    }),
    filaments: library.filaments.map((filament) => filament.id === filamentId
      ? {
          ...filament,
          diameterMm: numbers.filamentDiameter,
          densityGCm3: numbers.filamentDensityGCm3,
          costPerKg: numbers.filamentCostPerKg,
          nozzleTemp: numbers.nozzleTemp,
          bedTemp: numbers.bedTemp,
          pressureAdvance: { ...filament.pressureAdvance, [key]: numbers.pressureAdvance },
          linearAdvance: { ...filament.linearAdvance, [key]: numbers.linearAdvance },
          flow: numbers.flow,
        }
      : filament),
  };
}

function blankPrinter(id: string, name: string): PrinterRecord {
  return {
    id,
    name,
    builtin: false,
    bedX: 220,
    bedY: 220,
    bedZ: 250,
    maxVolumetricMm3S: 12,
    maxAccel: 10000,
    startGcode: "",
    endGcode: "",
    maxBedC: DEFAULT_MAX_BED_C,
    maxNozzleC: DEFAULT_MAX_NOZZLE_C,
    startOwnsHoming: false,
    host: "",
    apiKey: "",
    startPrint: false,
    firmware: "klipper",
    kind: "cartesian",
    belt: defaultBelt(220),
    ...KLIPPER_NUMBERS,
  };
}

function stripPrinter(printer: PrinterRecord): MachineFile["printer"] {
  const hostType = coerceHostKind(printer.hostType);
  return {
    name: printer.name,
    bedX: printer.bedX,
    bedY: printer.bedY,
    bedZ: printer.bedZ,
    maxVolumetricMm3S: printer.maxVolumetricMm3S,
    maxAccel: printer.maxAccel,
    startGcode: printer.startGcode,
    endGcode: printer.endGcode,
    maxBedC: printer.maxBedC,
    maxNozzleC: printer.maxNozzleC,
    startOwnsHoming: printer.startOwnsHoming,
    host: printer.host,
    ...(hostType !== "prusalink" ? { hostType } : {}),
    apiKey: printer.apiKey,
    startPrint: printer.startPrint,
    firmware: printer.firmware,
    ...(printer.firmwareArcs !== undefined ? { firmwareArcs: printer.firmwareArcs } : {}),
    kind: printer.kind,
    belt: { ...printer.belt },
    ...klipperLimits(printer),
  };
}

function stripFilament(filament: FilamentRecord): MachineFile["filament"] {
  return {
    name: filament.name,
    material: filament.material,
    diameterMm: filament.diameterMm,
    densityGCm3: filament.densityGCm3,
    costPerKg: filament.costPerKg,
    nozzleTemp: filament.nozzleTemp,
    bedTemp: filament.bedTemp,
    pressureAdvance: { ...filament.pressureAdvance },
    linearAdvance: { ...filament.linearAdvance },
    flow: filament.flow,
  };
}

function uniqueName(rows: { name: string }[], name: string): string {
  const taken = new Set(rows.map((row) => row.name));
  if (!taken.has(name)) return name;
  let n = 2;
  while (taken.has(`${name} ${n}`)) n += 1;
  return `${name} ${n}`;
}

/**
 * The IR3 V2's start sequence. PRINT_START is the printer's own macro. The belt has no Z endstop,
 * so only Y homes. The purge draws a Z-shaped line up the belt, then Z is zeroed at the nozzle.
 * It ends in absolute extrusion because the engine's body is absolute.
 */
const IR3_V2_START = [
  "PRINT_START",
  "M140 S{bed}",
  "M104 S{nozzle}",
  "M109 S{nozzle}",
  "G90",
  "M83",
  "G92 E0",
  "G1 Y0.1 F6000",
  "G1 E10",
  "G1 Z20 E23 F800",
  "G28 Y",
  "FMS_on",
  "G92 Z0",
  "G1 Z0.4 F900",
  "G1 X0 Z0.4 F6000",
  "G1 Z5.4 E1. F1200",
  "; 8-fold Z-shaped purge line: 6.67 mm wide, 2 mm per segment",
  "G1 X6.67 Z7.4 E1.85",
  "G1 X0 Z9.4 E1.85",
  "G1 X6.67 Z11.4 E1.85",
  "G1 X0 Z13.4 E1.85",
  "G1 X6.67 Z15.4 E1.85",
  "G1 X0 Z17.4 E1.85",
  "G1 X6.67 Z19.4 E1.85",
  "G1 X0 Z21.4 E1.85",
  "G1 X6.67 Z23.4 E1.85",
  "G1 Z28.4 E0.50",
  "G92 E0 Z0",
  "M82",
].join("\n");

const IR3_V2_LIMITS: KlipperLimits = {
  squareCornerVelocity: 5,
  minimumCruiseRatio: 0.5,
  extruderCornerVelocity: 1,
  maxVelocity: 400,
  maxZVelocity: 20,
  maxZAccel: 500,
};

function builtinPrinters(): PrinterRecord[] {
  return [
    printer("lime-220", "Lime 220", 220, 220, 250, 12, 10000),
    printer("lime-300", "Lime 300", 300, 300, 320, 15, 5000),
    printer("lime-180", "Lime 180", 180, 180, 180, 8, 2000),
    { ...printer("generic-belt-45", "Generic belt 45°", 200, 200, 200, 12, 5000), kind: "belt" },
    // Klipper, 45° gantry, 250 mm belt and gantry. The limits are the printer's own
    // printer.cfg, read from Moonraker on 2026-10-13.
    {
      ...printer("ideaformer-ir3-v2", "Ideaformer IR3 V2", 250, 250, 250, 12, 20000),
      ...IR3_V2_LIMITS,
      kind: "belt",
      // Its printer.cfg has no [gcode_arcs], and Ideaformer's own slicer writes no arcs.
      firmwareArcs: false,
      maxBedC: 90,
      startOwnsHoming: true,
      startGcode: IR3_V2_START,
      endGcode: "PRINT_END",
    },
  ];
}

function printer(id: string, name: string, bedX: number, bedY: number, bedZ: number, flow: number, accel: number): PrinterRecord {
  return {
    id,
    name,
    builtin: true,
    bedX,
    bedY,
    bedZ,
    maxVolumetricMm3S: flow,
    maxAccel: accel,
    startGcode: "",
    endGcode: "",
    maxBedC: DEFAULT_MAX_BED_C,
    maxNozzleC: DEFAULT_MAX_NOZZLE_C,
    startOwnsHoming: false,
    host: "",
    apiKey: "",
    startPrint: false,
    firmware: "klipper",
    kind: "cartesian",
    belt: defaultBelt(bedX),
    ...KLIPPER_NUMBERS,
  };
}

function builtinFilaments(): FilamentRecord[] {
  return [
    filament("lime-pla", "PLA", "PLA", 1.24, 20, 200, 60, { "0.4": 0, "0.6": 0.035, "0.8": 0.05 }),
    filament("lime-petg", "PETG", "PETG", 1.27, 25, 240, 80, { "0.4": 0.05, "0.6": 0.06, "0.8": 0.07 }),
    filament("lime-abs", "ABS", "ABS", 1.04, 25, 250, 100, { "0.4": 0.04, "0.6": 0.05, "0.8": 0.055 }),
    filament("lime-tpu", "TPU", "TPU", 1.21, 35, 230, 40, { "0.4": 0.08, "0.6": 0.1, "0.8": 0.12 }),
  ];
}

/** Starting pressure-advance numbers for our own filaments. Not a vendor table. */
function filament(
  id: string,
  name: string,
  material: string,
  density: number,
  cost: number,
  nozzleTemp: number,
  bedTemp: number,
  pressureAdvance: Record<string, number>,
): FilamentRecord {
  return {
    id,
    name,
    builtin: true,
    material,
    diameterMm: 1.75,
    densityGCm3: density,
    costPerKg: cost,
    nozzleTemp,
    bedTemp,
    pressureAdvance,
    linearAdvance: { "0.4": 0, "0.6": 0, "0.8": 0 },
    flow: 1,
  };
}

function applyMigrations(
  doc: Record<string, unknown>,
  steps: readonly MachineMigration[],
  target: number,
): { ok: true; doc: Record<string, unknown> } | { ok: false; message: string } {
  if (typeof doc.version !== "number" || !Number.isInteger(doc.version)) {
    return { ok: false, message: "This machine profile has no version, so it cannot be opened." };
  }
  let current = doc;
  let version = doc.version;
  if (version > target) {
    return { ok: false, message: `This machine profile is version ${version}. This app opens up to version ${target}.` };
  }
  while (version < target) {
    const step = steps[version];
    if (!step) return { ok: false, message: "This machine profile could not be updated to the current format." };
    let next: Record<string, unknown>;
    try {
      next = step({ ...current });
    } catch {
      return { ok: false, message: "This machine profile could not be updated to the current format." };
    }
    if (!next || typeof next.version !== "number" || next.version !== version + 1) {
      return { ok: false, message: "This machine profile could not be updated to the current format." };
    }
    current = next;
    version = next.version;
  }
  return { ok: true, doc: current };
}

function readFile(doc: Record<string, unknown>): MachineFileResult {
  if (doc.version !== MACHINE_FILE_VERSION) return { ok: false, message: "This machine profile could not be updated to the current format." };
  const printer = readPrinterBody(doc.printer);
  const filament = readFilamentBody(doc.filament);
  if (!printer || !filament || !finite(doc.nozzleMm) || doc.nozzleMm <= 0) {
    return { ok: false, message: "This machine profile is incomplete." };
  }
  return { ok: true, file: { version: MACHINE_FILE_VERSION, printer, filament, nozzleMm: doc.nozzleMm } };
}

function readPrinter(value: unknown): PrinterRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  // A library stored before these limits existed gets the built-in printer's own, not Klipper's blanks.
  const ir3 = row.id === "ideaformer-ir3-v2";
  const body = readPrinterBody(row, ir3 ? IR3_V2_LIMITS : KLIPPER_NUMBERS);
  if (!body || typeof row.id !== "string" || !row.id) return null;
  // Stored before the arcs answer existed: the IR3 V2 takes the catalog's no, others their firmware's default.
  const arcs = ir3 && body.firmwareArcs === undefined ? { firmwareArcs: false } : {};
  return { ...body, ...arcs, id: row.id, builtin: row.builtin === true };
}

function readFilament(value: unknown): FilamentRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const body = readFilamentBody(row);
  if (!body || typeof row.id !== "string" || !row.id) return null;
  return { ...body, id: row.id, builtin: row.builtin === true };
}

function readPrinterBody(value: unknown, missing: KlipperLimits = KLIPPER_NUMBERS): Omit<PrinterRecord, "id" | "builtin"> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.name !== "string" || !row.name.trim()) return null;
  if (!positive(row.bedX) || !positive(row.bedY) || !positive(row.bedZ)) return null;
  if (!positive(row.maxVolumetricMm3S) || !positive(row.maxAccel)) return null;
  if (typeof row.startGcode !== "string" || typeof row.endGcode !== "string") return null;
  if (row.startGcode.length > 20000 || row.endGcode.length > 20000) return null;
  if (typeof row.host !== "string" || typeof row.apiKey !== "string" || typeof row.startPrint !== "boolean") return null;
  if (row.host.length > 500 || row.apiKey.length > 500) return null;
  if (row.kind !== "cartesian" && row.kind !== "belt") return null;
  if (!row.belt || typeof row.belt !== "object" || Array.isArray(row.belt)) return null;
  const hostType = coerceHostKind(row.hostType);
  return {
    name: row.name.trim(),
    bedX: row.bedX,
    bedY: row.bedY,
    bedZ: row.bedZ,
    maxVolumetricMm3S: row.maxVolumetricMm3S,
    maxAccel: row.maxAccel,
    startGcode: row.startGcode,
    endGcode: row.endGcode,
    maxBedC: limit(row.maxBedC, DEFAULT_MAX_BED_C),
    maxNozzleC: limit(row.maxNozzleC, DEFAULT_MAX_NOZZLE_C),
    startOwnsHoming: row.startOwnsHoming === true,
    host: row.host.trim(),
    ...(hostType !== "prusalink" ? { hostType } : {}),
    apiKey: row.apiKey,
    startPrint: row.startPrint,
    firmware: row.firmware === "marlin" ? "marlin" : "klipper",
    ...(typeof row.firmwareArcs === "boolean" ? { firmwareArcs: row.firmwareArcs } : {}),
    kind: row.kind,
    belt: coerceBelt(row.belt, row.bedX),
    squareCornerVelocity: atLeast(row.squareCornerVelocity, missing.squareCornerVelocity),
    minimumCruiseRatio: Math.min(0.95, atLeast(row.minimumCruiseRatio, missing.minimumCruiseRatio)),
    extruderCornerVelocity: atLeast(row.extruderCornerVelocity, missing.extruderCornerVelocity),
    maxVelocity: atLeast(row.maxVelocity, missing.maxVelocity),
    maxZVelocity: atLeast(row.maxZVelocity, missing.maxZVelocity),
    maxZAccel: atLeast(row.maxZAccel, missing.maxZAccel),
  };
}

/** A stored limit that is a number from zero up, else `fallback`. Zero is a real value: no cap. */
function atLeast(value: unknown, fallback: number): number {
  return finite(value) && value >= 0 ? value : fallback;
}

/** Version 2 printers have no belt. Version 3 adds a cartesian kind and a default belt block. */
function migrateMachineVersion2(doc: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...doc, version: 3 };
  if (Array.isArray(doc.printers)) next.printers = doc.printers.map(withBelt);
  if (doc.printer && typeof doc.printer === "object" && !Array.isArray(doc.printer)) next.printer = withBelt(doc.printer);
  return next;
}

function withBelt(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const row = value as Record<string, unknown>;
  const width = typeof row.bedX === "number" && row.bedX > 0 ? row.bedX : 220;
  return {
    ...row,
    kind: row.kind === "belt" ? "belt" : "cartesian",
    belt: coerceBelt(row.belt, width),
  };
}

function beltFieldsHtml(printer: PrinterRecord | undefined, rules: Rules): string {
  const kind = printer?.kind ?? "cartesian";
  const belt = printer?.belt ?? defaultBelt(printer?.bedX ?? 220);
  const axis = (value: string) => `<option value="${value}"${belt.axis === value ? " selected" : ""}>${value.toUpperCase()}</option>`;
  const length = belt.maxLengthMm == null ? "" : String(belt.maxLengthMm);
  return `
      <label class="field setting" data-label="printer kind" data-keywords="belt conveyor cr-30 ifactory blackbelt cartesian" data-tip="${BELT_TIP}">Kind
        <select id="machineKind" aria-label="Printer kind">
          <option value="cartesian"${kind === "cartesian" ? " selected" : ""}>Cartesian</option>
          <option value="belt"${kind === "belt" ? " selected" : ""}>Belt</option>
        </select>
      </label>
      <div class="belt-grid" id="beltFields"${rules.hidden.has("beltFields") ? " hidden" : ""}>
        <label class="field setting" data-label="belt angle" data-keywords="gantry tilt degrees">Angle °
          <input id="beltAngle" type="number" min="10" max="80" step="1" value="${belt.angleDeg}" aria-label="Belt angle" />
        </label>
        <label class="field setting" data-label="belt axis" data-keywords="conveyor axis">Belt axis
          <select id="beltAxis" aria-label="Belt axis">${axis("x")}${axis("y")}${axis("z")}</select>
        </label>
        <label class="field setting" data-label="belt direction" data-keywords="belt sign" data-tip="${BELT_DIRECTION_TIP}">Direction
          <select id="beltDirection" aria-label="Belt direction">
            <option value="1"${belt.direction === 1 ? " selected" : ""}>+ axis</option>
            <option value="-1"${belt.direction === -1 ? " selected" : ""}>− axis</option>
          </select>
        </label>
        <label class="field setting" data-label="belt width" data-keywords="usable width">Width mm
          <input id="beltWidth" type="number" min="10" max="4000" step="1" value="${belt.widthMm}" aria-label="Belt width" />
        </label>
        <label class="check setting belt-wide" data-label="unlimited belt" data-keywords="endless length"><input id="beltUnlimited" type="checkbox"${belt.maxLengthMm == null ? " checked" : ""}/> Unlimited length</label>
        ${rules.hidden.has("beltMaxLength") ? "" : `<label class="field setting" data-label="belt length" data-keywords="max length">Max length mm
          <input id="beltLength" type="number" min="10" step="1" value="${length}" aria-label="Belt max length" />
        </label>`}
        <label class="field setting" data-label="belt copies" data-keywords="back to back repeat">Copies
          <input id="beltCopies" type="number" min="1" max="24" step="1" value="${belt.copies}" aria-label="Belt copies" />
        </label>
        <label class="field setting" data-label="belt gap" data-keywords="copy spacing">Gap mm
          <input id="beltGap" type="number" min="0" max="500" step="1" value="${belt.gapMm}" aria-label="Gap between copies" />
        </label>
        <label class="check setting belt-wide" data-label="belt raft" data-keywords="raft pad adhesion first layers" data-tip="A pad on the belt under the part, 1 mm past it. A raft and supports replace each other."><input id="beltRaft" type="checkbox"${belt.raftLayers > 0 ? " checked" : ""}/> Belt raft</label>
        ${rules.hidden.has("beltRaftLayers") ? "" : `<label class="field setting" data-label="belt raft layers" data-keywords="raft layers pad">Raft layers
          <input id="beltRaftLayers" type="number" min="1" max="8" step="1" value="${belt.raftLayers}" aria-label="Belt raft layers" />
        </label>`}
      </div>`;
}

/** Version 1 printers have no host. Version 2 adds an empty Prusa Link connection. */
function migrateMachineVersion1(doc: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...doc, version: 2 };
  if (Array.isArray(doc.printers)) next.printers = doc.printers.map(withConnection);
  if (doc.printer && typeof doc.printer === "object" && !Array.isArray(doc.printer)) next.printer = withConnection(doc.printer);
  return next;
}

function withConnection(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const row = value as Record<string, unknown>;
  return {
    ...row,
    host: typeof row.host === "string" ? row.host : "",
    apiKey: typeof row.apiKey === "string" ? row.apiKey : "",
    startPrint: row.startPrint === true,
  };
}

function readFilamentBody(value: unknown): Omit<FilamentRecord, "id" | "builtin"> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.name !== "string" || !row.name.trim()) return null;
  if (typeof row.material !== "string" || !row.material.trim()) return null;
  if (!positive(row.diameterMm) || !positive(row.densityGCm3)) return null;
  if (!finite(row.costPerKg) || row.costPerKg < 0) return null;
  if (!finite(row.nozzleTemp) || !finite(row.bedTemp)) return null;
  const pressureAdvance = readAdvance(row.pressureAdvance);
  const linearAdvance = readAdvance(row.linearAdvance);
  if (!pressureAdvance || !linearAdvance) return null;
  const retract = optionalRetract(row.retractLength, row.retractSpeed);
  if (!retract) return null;
  return {
    name: row.name.trim(),
    material: row.material.trim(),
    diameterMm: row.diameterMm,
    densityGCm3: row.densityGCm3,
    costPerKg: row.costPerKg,
    nozzleTemp: row.nozzleTemp,
    bedTemp: row.bedTemp,
    pressureAdvance,
    linearAdvance,
    flow: readFlow(row.flow),
    ...retract,
  };
}

function optionalRetract(length: unknown, speed: unknown): { retractLength?: number; retractSpeed?: number } | null {
  const out: { retractLength?: number; retractSpeed?: number } = {};
  if (length == null) {
    // absent
  } else if (typeof length === "number" && Number.isFinite(length) && length >= 0 && length <= 5) {
    out.retractLength = Math.round(length * 1000) / 1000;
  } else {
    return null;
  }
  if (speed == null) return out;
  if (typeof speed === "number" && Number.isFinite(speed) && speed >= 5 && speed <= 80) {
    out.retractSpeed = Math.round(speed);
    return out;
  }
  return null;
}

function readFlow(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  return Math.min(1.5, Math.max(0.5, Math.round(value * 1000) / 1000));
}

function readAdvance(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, number> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!finite(item) || item < 0 || item > 2) return null;
    out[key] = item;
  }
  return out;
}

function limit(value: unknown, fallback: number): number {
  return positive(value) ? Math.min(1000, value) : fallback;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function positive(value: unknown): value is number {
  return finite(value) && value > 0;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}
