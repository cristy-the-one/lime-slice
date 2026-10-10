/** Test, upload, and read a job on a real Prusa Link printer. */
import { fx } from "./fx.ts";
import { loadMachineLibrary, storeMachineLibrary } from "./machine-library.ts";
import { state } from "./state.ts";
import { pushToast } from "../ui/toasts.ts";
import { selection, setLink } from "../ui/machine-library.ts";
import {
  gcodeFileName,
  hostProblem,
  keyProblem,
  parsePrusaOrigin,
  performPrusa,
  readStatus,
  readVersion,
  sendGcode,
  statusRequest,
  transportFetch,
  versionRequest,
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
  return hostProblem(selection(loadMachineLibrary())?.printer.host ?? "");
}

/** Send exists only for a printer with a Prusa Link host. */
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
  const origin = parsePrusaOrigin(url);
  storeMachineLibrary(setLink(loadMachineLibrary(), origin ?? url.trim(), apiKey, startPrint));
  syncSendButtons();
}

export function testPrusaLink() {
  void run("test", (origin, apiKey) => performPrusa(versionRequest(origin, apiKey), transportFetch, (status, text) => readVersion(status, text)));
}

export function refreshPrusaJob() {
  void run("job", (origin, apiKey) => performPrusa(statusRequest(origin, apiKey), transportFetch, (status, text) => readStatus(status, text)));
}

export async function uploadToPrusaLink() {
  rememberPrusaForm();
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
    { url: printer.host, apiKey: printer.apiKey, startPrint: printer.startPrint },
    filename,
    gcode,
    transportFetch,
  );
  finish("upload", outcome);
}

async function run(
  action: "test" | "upload" | "job",
  work: (origin: string, apiKey: string) => Promise<PrusaLinkResult>,
) {
  rememberPrusaForm();
  const printer = selection(loadMachineLibrary())?.printer;
  const host = hostProblem(printer?.host ?? "");
  if (host || !printer) {
    const message = host ?? "Choose a printer first.";
    show(message);
    pushToast(message, "info");
    return;
  }
  const key = keyProblem(printer.apiKey);
  if (key) {
    show(key);
    pushToast(key, "info");
    return;
  }
  const origin = parsePrusaOrigin(printer.host);
  if (!origin) {
    const message = hostProblem(printer.host) ?? "Add a Prusa Link host on this printer first.";
    show(message);
    pushToast(message, "info");
    return;
  }
  finish(action, await work(origin, printer.apiKey));
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
