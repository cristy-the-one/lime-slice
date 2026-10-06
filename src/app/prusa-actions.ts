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

let summary = "Not checked.";

export function prusaSummary(): string {
  return summary;
}

export function canSendToPrinter(): boolean {
  return sendBlock() === null;
}

/** Why Send is off, or a tip when it is on. */
export function sendTitle(): string {
  return sendBlock() ?? "Send the current G-code to this printer.";
}

export function syncSendButtons() {
  const title = sendTitle();
  const ready = canSendToPrinter();
  for (const id of ["#sendPrinter", "#compactSend"]) {
    const button = document.querySelector<HTMLButtonElement>(id);
    if (!button) continue;
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
  const result = state.result;
  if (!result || fx.stale?.() || state.busy) {
    const message = state.busy ? "Wait for the slice to finish, then send." : "Slice first, then send.";
    show(message);
    pushToast(message, "info");
    return;
  }
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
  pushToast(result.summary, "success");
}

function retry(action: "test" | "upload" | "job") {
  if (action === "test") testPrusaLink();
  else if (action === "upload") void uploadToPrusaLink();
  else refreshPrusaJob();
}

function sendBlock(): string | null {
  if (state.busy) return "Wait for the slice to finish, then send.";
  const host = hostProblem(selection(loadMachineLibrary())?.printer.host ?? "");
  const hasGcode = !!state.result && !fx.stale?.();
  if (!hasGcode && host) return "Slice first, and add a Prusa Link host on this printer.";
  if (!hasGcode) return "Slice first, then send.";
  return host;
}

function show(text: string) {
  summary = text;
  const node = document.querySelector("#prusaStatus");
  if (node) node.textContent = text;
}
