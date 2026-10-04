/** Apply, save, and move printer and filament profiles. A switch is one undo step. */
import { flushEdit, noteEdit } from "./history.ts";
import { loadMachineLibrary, machineLibraryStored, storeMachineLibrary } from "./machine-library.ts";
import { markProjectDirty } from "../project-dirty.ts";
import { fx } from "./fx.ts";
import { saveProfile, defaultProfile, type PrinterProfile } from "../profiles.ts";
import { state } from "./state.ts";
import { pushToast } from "../ui/toasts.ts";
import {
  adoptProfile,
  builtinLibrary,
  deleteActive,
  duplicateActive,
  enginePrinter,
  fileFromSelection,
  importInto,
  machineFileName,
  parseMachineFile,
  saveActive,
  savePrinterName,
  selectIn,
  selection,
  serializeMachineFile,
  adoptLegacyLink,
  setAdvance,
  setGcode,
  type MachineLibrary,
  type MachineNumbers,
} from "../ui/machine-library.ts";
import { LEGACY_PRUSA_LINK_KEY, parseLegacyPrusaLink } from "../ui/prusa-link.ts";

export function newMachineId(): string {
  return crypto.randomUUID();
}

/** Seed the catalog. A saved single printer that is not the factory default becomes a user profile. */
export function bootMachines() {
  let library = loadMachineLibrary();
  if (!machineLibraryStored()) {
    library = builtinLibrary();
    if (!isFactoryProfile(state.profile, state.pressureAdvance, state.linearAdvance)) {
      library = adoptProfile(library, { ...state.profile, pressureAdvance: state.pressureAdvance, linearAdvance: state.linearAdvance }, "saved-printer", "saved-filament");
    }
  }
  library = adoptLegacyLink(library, takeLegacyPrusa());
  storeMachineLibrary(library);
  writeState(library);
}

export function chooseMachine(printerId: string, filamentId: string, nozzleMm: number) {
  const next = selectIn(loadMachineLibrary(), printerId, filamentId, nozzleMm);
  if (typeof next === "string") {
    pushToast(next, "info");
    return;
  }
  commitSwitch(next);
}

export function noteAdvance(pressure: number, linear: number) {
  noteEdit();
  state.pressureAdvance = pressure;
  state.linearAdvance = linear;
  state.profile.pressureAdvance = pressure;
  state.profile.linearAdvance = linear;
  saveProfile(state.profile);
  storeMachineLibrary(setAdvance(loadMachineLibrary(), pressure, linear));
  syncAdvanceInputs(pressure, linear);
}

export function noteNozzle(mm: number) {
  const library = loadMachineLibrary();
  const next = selectIn(library, library.printerId, library.filamentId, mm);
  if (typeof next === "string") return;
  storeMachineLibrary(next);
  const picked = selection(next);
  if (!picked) return;
  const printer = enginePrinter(picked.printer, picked.filament, mm);
  state.pressureAdvance = printer.pressureAdvance;
  state.linearAdvance = printer.linearAdvance;
  state.profile.pressureAdvance = printer.pressureAdvance;
  state.profile.linearAdvance = printer.linearAdvance;
  saveProfile(state.profile);
  syncAdvanceInputs(printer.pressureAdvance, printer.linearAdvance);
  const nozzle = document.querySelector<HTMLSelectElement>("#machineNozzle");
  if (nozzle) nozzle.value = String(Math.round(mm * 1000) / 1000);
}

export function noteGcode(startGcode: string, endGcode: string) {
  storeMachineLibrary(setGcode(loadMachineLibrary(), startGcode, endGcode));
}

export function saveMachine(name: string): boolean {
  const numbers = currentNumbers();
  const library = loadMachineLibrary();
  const next = name ? savePrinterName(library, name, numbers, newMachineId()) : saveActive(library, numbers);
  if (typeof next === "string") {
    pushToast(next, "info");
    return false;
  }
  commitSwitch(next);
  pushToast(name ? `Saved ${name.trim()}.` : "Saved the printer and filament.", "success");
  return true;
}

export function duplicateMachine(): boolean {
  const next = duplicateActive(loadMachineLibrary(), newMachineId(), newMachineId());
  if (typeof next === "string") {
    pushToast(next, "info");
    return false;
  }
  commitSwitch(next);
  const picked = selection(next);
  pushToast(`Duplicated as ${picked?.printer.name ?? "a copy"}.`, "success");
  return true;
}

export function deleteMachine(): boolean {
  const next = deleteActive(loadMachineLibrary());
  if (typeof next === "string") {
    pushToast(next, "info");
    return false;
  }
  commitSwitch(next);
  pushToast("Deleted the copy.", "success");
  return true;
}

export function machineExportFile(): { text: string; name: string } | null {
  const file = fileFromSelection(loadMachineLibrary());
  if (!file) {
    pushToast("Choose a printer and a filament first.", "info");
    return null;
  }
  return { text: serializeMachineFile(file), name: machineFileName(file.printer.name, file.filament.name) };
}

export async function importMachineFile(file: File) {
  const parsed = parseMachineFile(await file.text());
  if (!parsed.ok) {
    pushToast(parsed.message, "error", { label: "Retry", run: openMachineFile });
    return;
  }
  const next = importInto(loadMachineLibrary(), parsed.file, newMachineId(), newMachineId());
  commitSwitch(next);
  pushToast(`Imported ${parsed.file.printer.name}.`, "success");
}

export function openMachineFile() {
  const details = document.querySelector<HTMLDetailsElement>("#machineMore");
  if (details) details.open = true;
  document.querySelector<HTMLInputElement>("#machineFile")?.click();
}

export function typedMachineName(): string {
  return document.querySelector<HTMLInputElement>("#machineName")?.value.trim() ?? "";
}

function commitSwitch(library: MachineLibrary) {
  flushEdit();
  noteEdit();
  storeMachineLibrary(library);
  writeState(library);
  flushEdit();
  markProjectDirty();
  state.notice = "";
  fx.renderChrome?.();
  fx.draw?.();
  fx.scheduleAuto?.();
}

function writeState(library: MachineLibrary) {
  const picked = selection(library);
  if (!picked) return;
  const next = enginePrinter(picked.printer, picked.filament, library.nozzleMm);
  state.profile = next;
  state.pressureAdvance = next.pressureAdvance;
  state.linearAdvance = next.linearAdvance;
  saveProfile(state.profile);
  fx.prepare?.setBed(next.bedX, next.bedY, next.bedZ);
  fx.view3d?.setBed(next.bedX, next.bedY, next.bedZ);
}

function currentNumbers(): MachineNumbers {
  const picked = selection(loadMachineLibrary())?.printer;
  const startGcode = document.querySelector<HTMLTextAreaElement>("#machineStart")?.value ?? picked?.startGcode ?? "";
  const endGcode = document.querySelector<HTMLTextAreaElement>("#machineEnd")?.value ?? picked?.endGcode ?? "";
  const hostField = document.querySelector<HTMLInputElement>("#machineHost");
  const keyField = document.querySelector<HTMLInputElement>("#machineKey");
  const startField = document.querySelector<HTMLInputElement>("#machineStartPrint");
  return {
    nozzleDiameter: state.profile.nozzleDiameter,
    filamentDiameter: state.profile.filamentDiameter,
    nozzleTemp: state.profile.nozzleTemp,
    bedTemp: state.profile.bedTemp,
    bedX: state.profile.bedX,
    bedY: state.profile.bedY,
    bedZ: state.profile.bedZ,
    maxVolumetricMm3S: state.profile.maxVolumetricMm3S,
    maxAccel: state.profile.maxAccel,
    filamentDensityGCm3: state.profile.filamentDensityGCm3,
    filamentCostPerKg: state.profile.filamentCostPerKg,
    pressureAdvance: state.pressureAdvance,
    linearAdvance: state.linearAdvance,
    startGcode,
    endGcode,
    host: hostField?.value.trim() ?? picked?.host ?? "",
    apiKey: keyField?.value ?? picked?.apiKey ?? "",
    startPrint: startField ? startField.checked : picked?.startPrint === true,
  };
}

function takeLegacyPrusa(): { url: string; apiKey: string; startPrint: boolean } | null {
  try {
    const text = localStorage.getItem(LEGACY_PRUSA_LINK_KEY);
    if (text !== null) localStorage.removeItem(LEGACY_PRUSA_LINK_KEY);
    return parseLegacyPrusaLink(text);
  } catch {
    return null;
  }
}

function syncAdvanceInputs(pressure: number, linear: number) {
  const machinePa = document.querySelector<HTMLInputElement>("#machinePa");
  if (machinePa && document.activeElement !== machinePa) machinePa.value = String(pressure);
  const pa = document.querySelector<HTMLInputElement>("#pa");
  if (pa && document.activeElement !== pa) pa.value = String(pressure);
  const la = document.querySelector<HTMLInputElement>("#la");
  if (la && document.activeElement !== la) la.value = String(linear);
}

function isFactoryProfile(profile: PrinterProfile, pressure: number, linear: number): boolean {
  const factory = defaultProfile();
  return pressure === factory.pressureAdvance && linear === factory.linearAdvance && sameProfile(profile, factory);
}

function sameProfile(a: PrinterProfile, b: PrinterProfile): boolean {
  const keys = Object.keys(b) as (keyof PrinterProfile)[];
  return keys.every((key) => a[key] === b[key]);
}
