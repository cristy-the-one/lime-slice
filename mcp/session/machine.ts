/**
 * Printer and filament records: list, select, load, get, set, save, and profiles.
 * The methods run with this: Session; session.ts installs them on the Session prototype.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { FIT_ROWS, clearanceKey, enterMeasured, fitResultsRefusal, resetMeasured, type FitResults } from "../../src/modeling/partition.ts";
import { page } from "../../src/modeling/model-calls.ts";
import { exportOnlyRefusal, fileFromSelection, heatFor, parseMachineFile, serializeMachineFile, setAdvance, setFlow, setGcode, setMeasuredFits, setNozzleTemp, setRetract, type FilamentRecord, type MachineLibrary, type PrinterRecord } from "../../src/ui/machine-library.ts";
import { profileFileName, serializeSettingsProfile } from "../../src/ui/settings-profiles.ts";
import { reviewGcode } from "../review.ts";
import { resolveRead, resolveWrite } from "../workspace.ts";
import { type ToolHandler, shownName } from "./shared.ts";
import type { Session } from "../session.ts";

function machineGet(this: Session): Record<string, unknown> {
  const printer = this.printer();
  const filament = this.filament();
  const { host: _host, apiKey: _key, hostType: _kind, startPrint: _send, ...safe } = printer;
  return {
    ok: true,
    printer: { ...safe, bedMm: [printer.bedX, printer.bedY, printer.bedZ] },
    filament: {
      id: filament.id,
      name: filament.name,
      material: filament.material,
      nozzleTemp: filament.nozzleTemp,
      bedTemp: filament.bedTemp,
      flow: filament.flow,
      pressureAdvance: filament.pressureAdvance,
    },
    ...(this.library.measuredFits ? { measuredFits: this.library.measuredFits } : {}),
  };
}

function machineSet(this: Session, input: Record<string, unknown>): Record<string, unknown> {
  const printerPatch = input.printer && typeof input.printer === "object" && !Array.isArray(input.printer) ? input.printer as Record<string, unknown> : {};
  const filamentPatch = input.filament && typeof input.filament === "object" && !Array.isArray(input.filament) ? input.filament as Record<string, unknown> : {};
  for (const key of [...Object.keys(printerPatch), ...Object.keys(filamentPatch)]) {
    if (key === "host" || key === "apiKey" || key === "hostType" || key === "startPrint") {
      return { ok: false, reason: "This server does not store a printer host or a key." };
    }
  }
  const before = this.machineGet();
  let library = this.library;
  const printer = library.printers.find((row) => row.id === library.printerId);
  const filament = library.filaments.find((row) => row.id === library.filamentId);
  if (!printer || !filament) return { ok: false, reason: "Choose a printer and a filament first." };
  if (typeof printerPatch.retractLength === "number" || typeof printerPatch.retractSpeed === "number") {
    library = setRetract(library, typeof printerPatch.retractLength === "number" ? printerPatch.retractLength : null, typeof printerPatch.retractSpeed === "number" ? printerPatch.retractSpeed : null);
  }
  if (typeof filamentPatch.flow === "number") library = setFlow(library, filamentPatch.flow);
  if (typeof filamentPatch.nozzleTemp === "number") library = setNozzleTemp(library, filamentPatch.nozzleTemp);
  if (typeof filamentPatch.pressureAdvance === "number") {
    const linear = typeof filamentPatch.linearAdvance === "number" ? filamentPatch.linearAdvance : filament.linearAdvance[String(library.nozzleMm)] ?? 0;
    library = setAdvance(library, filamentPatch.pressureAdvance, linear);
  }
  let fitsSaid: string | undefined;
  if (input.fits !== undefined) {
    const entered = this.enterFits(library, input.fits);
    if ("reason" in entered) return { ok: false, reason: entered.reason };
    library = entered.library;
    fitsSaid = entered.said;
  }
  const start = typeof printerPatch.startGcode === "string" ? printerPatch.startGcode : printer.startGcode;
  const end = typeof printerPatch.endGcode === "string" ? printerPatch.endGcode : printer.endGcode;
  if (start !== printer.startGcode || end !== printer.endGcode) library = setGcode(library, start, end);
  library = {
    ...library,
    printers: library.printers.map((row) => {
      if (row.id !== library.printerId) return row;
      return {
        ...row,
        ...(typeof printerPatch.bedX === "number" ? { bedX: printerPatch.bedX } : {}),
        ...(typeof printerPatch.bedY === "number" ? { bedY: printerPatch.bedY } : {}),
        ...(typeof printerPatch.bedZ === "number" ? { bedZ: printerPatch.bedZ } : {}),
      };
    }),
    filaments: library.filaments.map((row) => row.id === library.filamentId && typeof filamentPatch.bedTemp === "number" ? { ...row, bedTemp: filamentPatch.bedTemp } : row),
  };
  const review = reviewGcode(`${start}\n${end}`, { custom: [start, end] });
  if (input.dryRun === true) {
    return { ok: true, dryRun: true, ...(fitsSaid ? { fits: fitsSaid } : {}), review: review.review.map((line) => line.text), custom: review.custom.map((line) => line.text) };
  }
  this.remember("Machine");
  this.library = library;
  const after = this.machineGet();
  return { ok: true, stale: true, ...(fitsSaid ? { fits: fitsSaid } : {}), from: before, to: after, review: review.review.map((line) => line.text), custom: review.custom.map((line) => line.text), label: "Machine" };
}

/**
 * machine_set's `fits`: coupon results (plan section 28). `{material, process?, snug?, loose?, press?, wallMm?}` writes
 * measured cells for that row into the library, `{material, reset: true}` puts its starting values back.
 */
function enterFits(this: Session, library: MachineLibrary, value: unknown): { library: MachineLibrary; said: string } | { reason: string } {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  if (!raw) return { reason: "fits is {material, process?, snug?, loose?, press?, wallMm?}, or {material, reset: true}." };
  if (raw.process !== undefined && raw.process !== "fdm" && raw.process !== "resin") return { reason: "fits.process is fdm or resin." };
  const process = raw.process === "resin" ? "resin" : "fdm";
  const material = typeof raw.material === "string" ? raw.material : this.filament().material;
  const key = clearanceKey(process, material);
  if (!key) return { reason: `No fit row for ${material || "that material"}. The rows are PLA, PETG, ABS or ASA, TPU, and process resin for the Form 4's standard resin.` };
  const name = FIT_ROWS.find((row) => row.key === key)?.name ?? key;
  if (raw.reset === true) return { library: setMeasuredFits(library, resetMeasured(library.measuredFits, key)), said: `${name} is back to its starting values.` };
  const results: FitResults = {};
  for (const field of ["snug", "loose", "press", "wallMm"] as const) {
    if (raw[field] === undefined) continue;
    if (typeof raw[field] !== "number") return { reason: `fits.${field} is a number of millimetres.` };
    results[field] = raw[field] as number;
  }
  if (results.wallMm !== undefined && key !== "resin") return { reason: "fits.wallMm is for the resin row." };
  const refusal = fitResultsRefusal(results);
  if (refusal) return { reason: `fits: ${refusal}` };
  const said = [...(["snug", "loose", "press"] as const).filter((fit) => results[fit] !== undefined).map((fit) => `${fit} ${results[fit]} mm`), ...(results.wallMm !== undefined ? [`wall ${results.wallMm} mm`] : [])];
  return { library: setMeasuredFits(library, enterMeasured(library.measuredFits, key, results)), said: `${name} measured: ${said.join(", ")} each side. New cuts use it; applied cuts keep theirs.` };
}

function machineSave(this: Session, name: string): Record<string, unknown> {
  const file = fileFromSelection(this.library);
  if (!file) return { ok: false, reason: "Choose a printer and a filament first." };
  const doc = JSON.parse(serializeMachineFile(file)) as { printer?: Record<string, unknown> };
  if (doc.printer) {
    delete doc.printer.host;
    delete doc.printer.apiKey;
    delete doc.printer.hostType;
    delete doc.printer.startPrint;
  }
  const text = JSON.stringify(doc, null, 2);
  if (text.includes("apiKey") || text.includes("\"host\"")) return { ok: false, reason: "The machine file still names a host." };
  const path = resolveWrite(name.endsWith(".json") ? name : `${name}.limemachine.json`, ".json");
  writeFileSync(path, text);
  return { ok: true, path, bytes: Buffer.byteLength(text) };
}

function profileSave(this: Session, name: string): Record<string, unknown> {
  const text = serializeSettingsProfile({ version: 1, name, settings: this.settings, level: "expert" });
  const path = resolveWrite(profileFileName(name), ".json");
  writeFileSync(path, text);
  return { ok: true, path, bytes: Buffer.byteLength(text) };
}

function machineList(this: Session, input: Record<string, unknown>): Record<string, unknown> {
  const printers = this.library.printers.map((row) => ({
    id: row.id,
    name: shownName(row.name),
    kind: row.kind,
    bedMm: [row.bedX, row.bedY, row.bedZ],
    nozzlesMm: [0.4, 0.6, 0.8],
  }));
  const filaments = this.library.filaments.map((row) => ({
    id: row.id,
    name: shownName(row.name),
    material: row.material,
  }));
  const printerPage = page(printers, input.printerCursor ?? input.cursor, input.limit);
  const filamentPage = page(filaments, input.filamentCursor, input.limit);
  return {
    ok: true,
    printers: printerPage.rows,
    filaments: filamentPage.rows,
    ...(printerPage.nextCursor ? { printersNextCursor: printerPage.nextCursor } : {}),
    ...(filamentPage.nextCursor ? { filamentsNextCursor: filamentPage.nextCursor } : {}),
  };
}

function machineSelect(this: Session, printerId: string, filamentId: string, nozzle: unknown): Record<string, unknown> {
  // --- Split to print (D11). An export-only printer is a target for the pieces, never the plate's printer.
  const exportOnly = exportOnlyRefusal(printerId);
  if (exportOnly) return { ok: false, reason: exportOnly };
  const printer = this.library.printers.find((row) => row.id === printerId);
  const filament = this.library.filaments.find((row) => row.id === filamentId);
  if (!printer || !filament) return { ok: false, reason: "That printer or filament is not in the library." };
  this.library = { ...this.library, printerId, filamentId, nozzleMm: typeof nozzle === "number" ? nozzle : this.library.nozzleMm };
  this.profileTouched = true;
  const heat = heatFor(printer, filament.nozzleTemp, filament.bedTemp);
  const start = printer.startGcode.trim() === "" ? "none" : "applied at export";
  return {
    ok: true,
    printer: printer.name,
    filament: filament.name,
    bedMm: [printer.bedX, printer.bedY, printer.bedZ],
    nozzleC: heat.nozzleC,
    bedC: heat.bedC,
    startGcode: start,
  };
}

function machineLoad(this: Session, path: string): Record<string, unknown> {
  const full = resolveRead(path, "machine");
  const parsed = parseMachineFile(readFileSync(full, "utf8"));
  if (!parsed.ok) return { ok: false, reason: parsed.message };
  const printer: PrinterRecord = { ...parsed.file.printer, id: "loaded-printer", builtin: false };
  const filament: FilamentRecord = { ...parsed.file.filament, id: "loaded-filament", builtin: false };
  this.library = {
    ...this.library,
    printers: [...this.library.printers.filter((row) => row.id !== printer.id), printer],
    filaments: [...this.library.filaments.filter((row) => row.id !== filament.id), filament],
    printerId: printer.id,
    filamentId: filament.id,
    nozzleMm: parsed.file.nozzleMm,
  };
  return this.machineSelect(printer.id, filament.id, parsed.file.nozzleMm);
}

/** The methods this module adds to Session. */
export const machineMethods = {
  machineGet,
  machineSet,
  enterFits,
  machineSave,
  profileSave,
  machineList,
  machineSelect,
  machineLoad,
};

export const machineHandlers: Record<string, ToolHandler> = {
  machine_list: (s, input) => s.machineList(input),
  machine_select: (s, input) => s.machineSelect(String(input.printerId), String(input.filamentId), input.nozzleMm),
  machine_load: (s, input) => s.machineLoad(String(input.path)),
  machine_get: (s) => s.machineGet(),
  machine_set: (s, input) => s.machineSet(input),
  machine_save: (s, input) => s.machineSave(String(input.name)),
  profile_save: (s, input) => s.profileSave(String(input.name)),
};
