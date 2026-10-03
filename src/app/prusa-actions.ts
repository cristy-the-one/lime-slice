/** Test, upload, and read a job on a real Prusa Link printer. */
import { fx } from "./fx.ts";
import { loadPrusaLink, storePrusaLink } from "./prusa-link.ts";
import { state } from "./state.ts";
import { pushToast } from "../ui/toasts.ts";
import {
  gcodeFileName,
  parsePrusaOrigin,
  readStatus,
  readUpload,
  readVersion,
  statusRequest,
  unreachable,
  uploadRequest,
  versionRequest,
  type PrusaLinkResult,
  type PrusaLinkSettings,
} from "../ui/prusa-link.ts";

let summary = "Not checked.";

export function prusaSummary(): string {
  return summary;
}

export function rememberPrusaForm() {
  const url = document.querySelector<HTMLInputElement>("#prusaUrl")?.value ?? "";
  const apiKey = document.querySelector<HTMLInputElement>("#prusaKey")?.value ?? "";
  const startPrint = document.querySelector<HTMLInputElement>("#prusaStart")?.checked === true;
  const origin = parsePrusaOrigin(url);
  storePrusaLink({ version: 1, url: origin ?? url.trim(), apiKey, startPrint });
}

export function testPrusaLink() {
  void run("test", (settings, origin) => call(versionRequest(origin, settings.apiKey), (status, text) => readVersion(status, text)));
}

export function refreshPrusaJob() {
  void run("job", (settings, origin) => call(statusRequest(origin, settings.apiKey), (status, text) => readStatus(status, text)));
}

export async function uploadToPrusaLink() {
  const result = state.result;
  if (!result || fx.stale?.()) {
    pushToast("Slice first, then upload.", "info");
    return;
  }
  let gcode = "";
  try {
    gcode = await fx.loadGcode(result);
  } catch {
    gcode = "";
  }
  if (!gcode) {
    pushToast("No G-code for this slice.", "info");
    return;
  }
  const filename = gcodeFileName(state.mesh?.name ?? "part");
  await run("upload", async (settings, origin) => {
    const request = uploadRequest(origin, settings.apiKey, filename, gcode, settings.startPrint);
    const uploaded = await call(request, (status) => readUpload(status));
    if (!uploaded.ok || !settings.startPrint) return uploaded;
    const job = await call(statusRequest(origin, settings.apiKey), (status, text) => readStatus(status, text));
    if (!job.ok) return { ok: true, summary: `${uploaded.summary} ${job.message}` };
    return { ok: true, summary: `Uploaded. ${job.summary}` };
  });
}

async function run(
  action: "test" | "upload" | "job",
  work: (settings: PrusaLinkSettings, origin: string) => Promise<PrusaLinkResult>,
) {
  rememberPrusaForm();
  const settings = loadPrusaLink();
  const origin = parsePrusaOrigin(settings.url);
  if (!origin || !settings.apiKey.trim()) {
    const message = "Add the Prusa Link URL and API key first.";
    show(message);
    pushToast(message, "info");
    return;
  }
  const result = await work(settings, origin);
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

async function call(request: { url: string; method: "GET" | "PUT"; headers: Record<string, string>; body?: string }, read: (status: number, text: string) => PrusaLinkResult): Promise<PrusaLinkResult> {
  try {
    const res = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body });
    return read(res.status, await res.text());
  } catch {
    return unreachable(new URL(request.url).origin);
  }
}

function show(text: string) {
  summary = text;
  const node = document.querySelector("#prusaStatus");
  if (node) node.textContent = text;
}
