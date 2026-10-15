/** Test, upload, read a job, and import `printer.cfg` on a Prusa Link, Moonraker, or OctoPrint printer. */
import { fx } from "./fx.ts";
import { flushEdit, noteEdit } from "./history.ts";
import { loadMachineLibrary, storeMachineLibrary } from "./machine-library.ts";
import { markProjectDirty } from "../project-dirty.ts";
import { saveProfile } from "../profiles.ts";
import { state } from "./state.ts";
import { pushToast } from "../ui/toasts.ts";
import {
  applyMoonrakerGeometry,
  applyMoonrakerLimits,
  setActiveFirmwareArcs,
  enginePrinter,
  selection,
  setLink,
  type MachineLibrary,
} from "../ui/machine-library.ts";
import {
  coerceHostKind,
  gcodeFileName,
  hostProblem,
  keyProblem,
  moonrakerConfigRequest,
  parsePrusaOrigin,
  performPrusa,
  readMoonrakerConfig,
  readStatus,
  readVersion,
  sendGcode,
  statusRequest,
  transportFetch,
  unreachable,
  versionRequest,
  type MoonrakerConfigImport,
  type PrinterHostKind,
  type PrusaLinkResult,
} from "../ui/prusa-link.ts";

let summary = "";

export function prusaSummary(): string {
  return summary;
}

export function canSendToPrinter(): boolean {
  return sendBlock() === null;
}

/** Why Send is off, or a tip when it is on. */
export function sendTitle(): string {
  return sendBlock() ?? (state.result && !fx.stale?.() ? "Send the current G-code to this printer." : "Slice, then send the G-code to this printer.");
}

function hostProblemNow(): string | null {
  const printer = selection(loadMachineLibrary())?.printer;
  return hostProblem(printer?.host ?? "", coerceHostKind(printer?.hostType));
}

/** Send exists only for a printer with a host. */
export function syncSendButtons() {
  const title = sendTitle();
  const ready = canSendToPrinter();
  const hosted = hostProblemNow() === null;
  for (const id of ["#sendPrinter", "#compactSend"]) {
    const button = document.querySelector<HTMLButtonElement>(id);
    if (!button) continue;
    button.hidden = !hosted;
    button.disabled = !ready;
    button.title = title;
    button.dataset.tip = title;
  }
}

export function rememberPrusaForm() {
  const url = document.querySelector<HTMLInputElement>("#machineHost")?.value ?? "";
  const apiKey = document.querySelector<HTMLInputElement>("#machineKey")?.value ?? "";
  const startPrint = document.querySelector<HTMLInputElement>("#machineStartPrint")?.checked === true;
  const hostTypeRaw = document.querySelector<HTMLSelectElement>("#machineHostType")?.value;
  const origin = parsePrusaOrigin(url);
  const library = loadMachineLibrary();
  const hostType = hostTypeRaw !== undefined
    ? coerceHostKind(hostTypeRaw)
    : coerceHostKind(selection(library)?.printer.hostType);
  storeMachineLibrary(setLink(library, origin ?? url.trim(), apiKey, startPrint, hostType));
  syncSendButtons();
}

export function testPrusaLink() {
  void run("test", (origin, apiKey, hostType) =>
    performPrusa(
      versionRequest(origin, apiKey, hostType),
      transportFetch,
      (status, text) => readVersion(status, text, hostType),
      hostType,
    ));
}

export function refreshPrusaJob() {
  void run("job", (origin, apiKey, hostType) =>
    performPrusa(
      statusRequest(origin, apiKey, hostType),
      transportFetch,
      (status, text) => readStatus(status, text, hostType),
      hostType,
    ));
}

export async function importMoonrakerConfig() {
  rememberPrusaForm();
  const printer = selection(loadMachineLibrary())?.printer;
  const host = hostProblem(printer?.host ?? "", "moonraker");
  if (host || !printer) {
    const message = host ?? "Choose a printer first.";
    show(message);
    pushToast(message, "info");
    return;
  }
  const origin = parsePrusaOrigin(printer.host);
  if (!origin) {
    const message = hostProblem(printer.host, "moonraker") ?? "Add a Moonraker host on this printer first.";
    show(message);
    pushToast(message, "info");
    return;
  }
  let status = 0;
  let text = "";
  try {
    const res = await transportFetch(moonrakerConfigRequest(origin, printer.apiKey));
    status = res.status;
    text = res.text;
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const failed = !raw || raw === "Failed to fetch" || raw.includes("Failed to fetch") || raw.startsWith("NetworkError")
      ? unreachable(origin, "moonraker")
      : { ok: false as const, message: raw };
    const message = failed.ok ? failed.summary : failed.message;
    show(message);
    pushToast(message, "error", { label: "Retry", run: () => { void importMoonrakerConfig(); } });
    return;
  }
  const parsed = readMoonrakerConfig(status, text);
  if (!parsed.ok) {
    show(parsed.message);
    pushToast(parsed.message, "error", { label: "Retry", run: () => { void importMoonrakerConfig(); } });
    return;
  }
  applyImportedMoonraker(parsed.config);
}

function applyImportedMoonraker(config: MoonrakerConfigImport) {
  flushEdit();
  noteEdit();
  let library = loadMachineLibrary();
  library = setLink(
    library,
    selection(library)?.printer.host ?? "",
    selection(library)?.printer.apiKey ?? "",
    selection(library)?.printer.startPrint === true,
    "moonraker",
  );
  library = applyMoonrakerLimits(library, config.limits);
  // Klipper runs G2/G3 only with [gcode_arcs]; the import reads which this printer has.
  library = setActiveFirmwareArcs(library, config.firmwareArcs);
  storeMachineLibrary(library);
  syncImportedState(library);
  flushEdit();
  markProjectDirty();
  show(config.summary);
  fx.renderChrome?.();
  fx.markStale?.();

  const picked = selection(library);
  const geom = config.geometry;
  const hasRestChanges = Boolean(
    picked && (
      (geom.bedX && geom.bedX !== picked.printer.bedX) ||
      (geom.bedY && geom.bedY !== picked.printer.bedY) ||
      (geom.bedZ && geom.bedZ !== picked.printer.bedZ) ||
      (geom.nozzleDiameter && Math.abs(geom.nozzleDiameter - library.nozzleMm) > 1e-4) ||
      (geom.maxBedC && geom.maxBedC !== picked.printer.maxBedC) ||
      (geom.maxNozzleC && geom.maxNozzleC !== picked.printer.maxNozzleC)
    ),
  );
  if (hasRestChanges) {
    const details: string[] = [];
    if (geom.bedX && geom.bedY && geom.bedZ) details.push(`${geom.bedX}×${geom.bedY}×${geom.bedZ} mm bed`);
    if (geom.nozzleDiameter) details.push(`${geom.nozzleDiameter} mm nozzle`);
    if (geom.maxNozzleC || geom.maxBedC) details.push("temperature caps");
    pushToast(
      `${config.summary}. Also found ${details.join(", ")} in printer.cfg.`,
      "info",
      {
        label: "Update bed & nozzle",
        run: () => {
          flushEdit();
          noteEdit();
          const updated = applyMoonrakerGeometry(loadMachineLibrary(), geom);
          storeMachineLibrary(updated);
          syncImportedState(updated);
          flushEdit();
          markProjectDirty();
          fx.renderChrome?.();
          fx.markStale?.();
        },
      },
    );
  } else {
    pushToast(config.summary, "info");
  }
}

function syncImportedState(library: MachineLibrary) {
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

export async function uploadToPrusaLink() {
  rememberPrusaForm();
  fx.commitModel?.();
  if (sendBlock()) return;
  // A missing or stale slice is made first, as Export does.
  if (!state.result || fx.stale?.()) await fx.runSlice?.(false);
  const result = state.result;
  if (!result || fx.stale?.()) return;
  let gcode = "";
  try {
    gcode = await fx.printableGcode(result);
  } catch {
    gcode = "";
  }
  if (!gcode) {
    const message = "No G-code for this slice.";
    show(message);
    pushToast(message, "info");
    return;
  }
  const printer = selection(loadMachineLibrary())?.printer;
  if (!printer) {
    const message = "Choose a printer first.";
    show(message);
    pushToast(message, "info");
    return;
  }
  const filename = gcodeFileName(state.mesh?.name ?? "part");
  const outcome = await sendGcode(
    {
      url: printer.host,
      apiKey: printer.apiKey,
      startPrint: printer.startPrint,
      hostType: coerceHostKind(printer.hostType),
    },
    filename,
    gcode,
    transportFetch,
  );
  finish("upload", outcome);
}

async function run(
  action: "test" | "upload" | "job",
  work: (origin: string, apiKey: string, hostType: PrinterHostKind) => Promise<PrusaLinkResult>,
) {
  rememberPrusaForm();
  const printer = selection(loadMachineLibrary())?.printer;
  const hostType = coerceHostKind(printer?.hostType);
  const host = hostProblem(printer?.host ?? "", hostType);
  if (host || !printer) {
    const message = host ?? "Choose a printer first.";
    show(message);
    pushToast(message, "info");
    return;
  }
  const key = keyProblem(printer.apiKey, hostType);
  if (key) {
    show(key);
    pushToast(key, "info");
    return;
  }
  const origin = parsePrusaOrigin(printer.host);
  if (!origin) {
    const message = hostProblem(printer.host, hostType) ?? "Add a Prusa Link host on this printer first.";
    show(message);
    pushToast(message, "info");
    return;
  }
  finish(action, await work(origin, printer.apiKey, hostType));
}

function finish(action: "test" | "upload" | "job", result: PrusaLinkResult) {
  if (!result.ok) {
    show(result.message);
    pushToast(result.message, "error", { label: "Retry", run: () => retry(action) });
    return;
  }
  show(result.summary);
}

function retry(action: "test" | "upload" | "job") {
  if (action === "test") testPrusaLink();
  else if (action === "upload") void uploadToPrusaLink();
  else refreshPrusaJob();
}

/** Why Send is off. Send follows a mesh and a host: with no current slice it slices first. */
function sendBlock(): string | null {
  const host = hostProblemNow();
  if (host) return host;
  if (state.busy) return "Wait for the slice to finish, then send.";
  if (!state.mesh) return "Load a mesh, then send.";
  return null;
}

function show(text: string) {
  summary = text;
  const node = document.querySelector("#prusaStatus");
  if (node) node.textContent = text;
}
