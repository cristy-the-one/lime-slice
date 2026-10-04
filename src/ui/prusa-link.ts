/**
 * Real Prusa Link HTTP client. The slicer has no send-to-printer API.
 * This talks to the printer: GET /api/version, PUT /api/v1/files/local/<name>,
 * and GET /api/v1/status.
 *
 * CI never calls a printer. Tests pass a mock `PrusaFetch`. That mock is not a
 * device in the UI.
 * Desktop `http://` goes through the helper in `src-tauri/src/prusa_http.rs`,
 * because the printer does not send the CORS headers a webview requires.
 * The browser, and any `https://` host, use `fetch`.
 */
import { isTauri } from "../platform.ts";

/** Old browser-only key. Boot copies it onto the active printer once, then deletes it. */
export const LEGACY_PRUSA_LINK_KEY = "lime-slice-prusa-link";

export interface PrusaLinkTarget {
  url: string;
  apiKey: string;
  startPrint: boolean;
}

export interface PrusaLinkRequest {
  url: string;
  method: "GET" | "PUT";
  headers: Record<string, string>;
  body?: string;
}

export interface PrusaResponse {
  status: number;
  text: string;
}

/** Injected in tests. The app uses `transportFetch`, which is the real printer call. */
export type PrusaFetch = (request: PrusaLinkRequest) => Promise<PrusaResponse>;

export type PrusaLinkResult = { ok: true; summary: string } | { ok: false; message: string };

export type PrinterStateResult =
  | { ok: true; state: string; summary: string }
  | { ok: false; message: string };

const BUSY_STATES = new Set(["PRINTING", "BUSY", "PAUSED"]);

export function parseLegacyPrusaLink(text: string | null): PrusaLinkTarget | null {
  if (!text) return null;
  try {
    const raw = JSON.parse(text) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const row = raw as Record<string, unknown>;
    if (row.version !== 1) return null;
    return {
      url: typeof row.url === "string" ? row.url : "",
      apiKey: typeof row.apiKey === "string" ? row.apiKey : "",
      startPrint: row.startPrint === true,
    };
  } catch {
    return null;
  }
}

export function parsePrusaOrigin(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Empty host, or a value that is not an http(s) origin. */
export function hostProblem(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "Add a Prusa Link host on this printer first.";
  if (!parsePrusaOrigin(trimmed)) return "That host is not a Prusa Link URL. Use http:// or https:// and a host name.";
  return null;
}

export function keyProblem(apiKey: string): string | null {
  if (!apiKey.trim()) return "Add the Prusa Link API key for this printer.";
  return null;
}

export function isPrinterBusy(state: string): boolean {
  return BUSY_STATES.has(state.trim().toUpperCase());
}

export function busyMessage(state: string): string {
  return `The printer is busy (${state}). Wait until it is idle, then send again.`;
}

export function gcodeFileName(meshName: string): string {
  const base = meshName.replace(/\.(stl|3mf|step|stp)$/i, "").replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "part";
  return `${base}.gcode`;
}

export function versionRequest(origin: string, apiKey: string): PrusaLinkRequest {
  return { url: `${origin}/api/version`, method: "GET", headers: authHeaders(apiKey) };
}

export function statusRequest(origin: string, apiKey: string): PrusaLinkRequest {
  return { url: `${origin}/api/v1/status`, method: "GET", headers: authHeaders(apiKey) };
}

export function uploadRequest(origin: string, apiKey: string, filename: string, gcode: string, startPrint: boolean): PrusaLinkRequest {
  const name = filename.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return {
    url: `${origin}/api/v1/files/local/${name}`,
    method: "PUT",
    headers: {
      ...authHeaders(apiKey),
      "Content-Type": "text/x.gcode",
      "Overwrite": "?1",
      "Print-After-Upload": startPrint ? "?1" : "?0",
    },
    body: gcode,
  };
}

export function readVersion(status: number, text: string): PrusaLinkResult {
  if (status === 401) return { ok: false, message: "Prusa Link refused the API key." };
  if (status !== 200) return { ok: false, message: `Prusa Link returned ${status}.` };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, message: "Prusa Link did not return version JSON." };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, message: "Prusa Link did not return version JSON." };
  const row = body as Record<string, unknown>;
  const label = typeof row.text === "string" && row.text.trim() ? row.text.trim() : typeof row.api === "string" ? `Prusa Link API ${row.api}` : "";
  if (!label) return { ok: false, message: "Prusa Link did not return version JSON." };
  return { ok: true, summary: label };
}

export function readPrinterState(status: number, text: string): PrinterStateResult {
  if (status === 401) return { ok: false, message: "Prusa Link refused the API key." };
  if (status !== 200) return { ok: false, message: `Prusa Link returned ${status}.` };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, message: "Prusa Link did not return job status." };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, message: "Prusa Link did not return job status." };
  const row = body as Record<string, unknown>;
  const printer = row.printer && typeof row.printer === "object" && !Array.isArray(row.printer) ? row.printer as Record<string, unknown> : null;
  const state = printer && typeof printer.state === "string" ? printer.state : "";
  if (!state) return { ok: false, message: "Prusa Link did not return job status." };
  const job = row.job && typeof row.job === "object" && !Array.isArray(row.job) ? row.job as Record<string, unknown> : null;
  const progress = job && typeof job.progress === "number" && Number.isFinite(job.progress) ? `${Math.round(job.progress)}%` : "";
  const left = job && typeof job.time_remaining === "number" && Number.isFinite(job.time_remaining) ? formatLeft(job.time_remaining) : "";
  const bits = [state, progress, left].filter(Boolean);
  return { ok: true, state, summary: bits.join(" · ") };
}

export function readStatus(status: number, text: string): PrusaLinkResult {
  const parsed = readPrinterState(status, text);
  if (!parsed.ok) return parsed;
  return { ok: true, summary: parsed.summary };
}

export function readUpload(status: number): PrusaLinkResult {
  if (status === 201 || status === 200) return { ok: true, summary: "Uploaded." };
  if (status === 401) return { ok: false, message: "Prusa Link refused the API key." };
  if (status === 409) return { ok: false, message: "The printer is busy with that file and would not replace it." };
  return { ok: false, message: `Prusa Link returned ${status}.` };
}

export function unreachable(origin: string): PrusaLinkResult {
  return { ok: false, message: `Could not reach Prusa Link at ${origin}. The printer may be off, or the page was blocked from calling it.` };
}

export async function performPrusa(
  request: PrusaLinkRequest,
  fetchImpl: PrusaFetch,
  read: (status: number, text: string) => PrusaLinkResult,
): Promise<PrusaLinkResult> {
  try {
    const res = await fetchImpl(request);
    return read(res.status, res.text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message || message === "Failed to fetch" || message.includes("Failed to fetch") || message.startsWith("NetworkError")) {
      return unreachable(originOf(request.url));
    }
    return { ok: false, message };
  }
}

/**
 * Upload G-code. When start-print is set, a busy printer is refused before the upload.
 * A failed status check is returned as-is and does not continue into the upload.
 */
export async function sendGcode(
  target: PrusaLinkTarget,
  filename: string,
  gcode: string,
  fetchImpl: PrusaFetch,
): Promise<PrusaLinkResult> {
  const host = hostProblem(target.url);
  if (host) return { ok: false, message: host };
  const key = keyProblem(target.apiKey);
  if (key) return { ok: false, message: key };
  const origin = parsePrusaOrigin(target.url)!;
  if (target.startPrint) {
    const status = await performPrusa(statusRequest(origin, target.apiKey), fetchImpl, (code, text) => {
      const parsed = readPrinterState(code, text);
      if (!parsed.ok) return parsed;
      if (isPrinterBusy(parsed.state)) return { ok: false, message: busyMessage(parsed.state) };
      return { ok: true, summary: parsed.state };
    });
    if (!status.ok) return status;
  }
  const uploaded = await performPrusa(
    uploadRequest(origin, target.apiKey, filename, gcode, target.startPrint),
    fetchImpl,
    (code) => readUpload(code),
  );
  if (!uploaded.ok || !target.startPrint) return uploaded;
  const job = await performPrusa(statusRequest(origin, target.apiKey), fetchImpl, (code, text) => readStatus(code, text));
  if (!job.ok) return { ok: true, summary: `${uploaded.summary} ${job.message}` };
  return { ok: true, summary: `Uploaded. ${job.summary}` };
}

/** Browser `fetch`, or the desktop helper for `http://` so a missing CORS header does not block the printer. */
export async function transportFetch(request: PrusaLinkRequest): Promise<PrusaResponse> {
  if (isTauri() && request.url.startsWith("http://")) return desktopFetch(request);
  const res = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body });
  return { status: res.status, text: await res.text() };
}

async function desktopFetch(request: PrusaLinkRequest): Promise<PrusaResponse> {
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<PrusaResponse>("prusa_link_http", {
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: request.body ?? null,
    });
  } catch (err) {
    const message = typeof err === "string" && err.trim() ? err : err instanceof Error && err.message.trim() ? err.message : "";
    throw new Error(message || `Could not reach Prusa Link at ${originOf(request.url)}. The printer may be off or not on this network.`);
  }
}

function authHeaders(apiKey: string): Record<string, string> {
  return { "X-Api-Key": apiKey };
}

function formatLeft(seconds: number): string {
  const minutes = Math.max(0, Math.round(seconds / 60));
  if (minutes < 1) return "under a minute left";
  return `${minutes} min left`;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}
