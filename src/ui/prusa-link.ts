/**
 * Prusa Link HTTP client. The slicer engine has no send-to-printer API.
 * This talks to the printer's own Prusa Link: GET /api/version, PUT /api/v1/files/local,
 * and GET /api/v1/status. Nothing here is a fake printer.
 */
export const PRUSA_LINK_VERSION = 1;

export interface PrusaLinkSettings {
  version: 1;
  /** Printer origin, such as http://192.168.1.50. Empty until the user sets one. */
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

export type PrusaLinkResult = { ok: true; summary: string } | { ok: false; message: string };

export function emptyPrusaLink(): PrusaLinkSettings {
  return { version: 1, url: "", apiKey: "", startPrint: false };
}

export function parsePrusaOrigin(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
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

export function readStatus(status: number, text: string): PrusaLinkResult {
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
  return { ok: true, summary: bits.join(" · ") };
}

export function readUpload(status: number): PrusaLinkResult {
  if (status === 201) return { ok: true, summary: "Uploaded." };
  if (status === 401) return { ok: false, message: "Prusa Link refused the API key." };
  if (status === 409) return { ok: false, message: "Prusa Link already has that file and would not replace it." };
  return { ok: false, message: `Prusa Link returned ${status}.` };
}

export function unreachable(origin: string): PrusaLinkResult {
  return { ok: false, message: `Could not reach Prusa Link at ${origin}. The printer may be off, or the browser blocked the request.` };
}

export function prusaFieldsHtml(settings: PrusaLinkSettings, summary: string): string {
  return `
    <h2>Prusa Link</h2>
    <label class="field setting" data-label="prusa link url" data-keywords="printer host send">Printer URL
      <input id="prusaUrl" type="url" inputmode="url" autocomplete="off" placeholder="http://192.168.1.50" value="${escapeHtml(settings.url)}" aria-label="Prusa Link URL" />
    </label>
    <label class="field setting" data-label="prusa link api key" data-keywords="printer key password">API key
      <input id="prusaKey" type="password" autocomplete="off" value="${escapeHtml(settings.apiKey)}" aria-label="Prusa Link API key" />
    </label>
    <label class="check setting" data-label="start print after upload" data-keywords="prusa link"><input id="prusaStart" type="checkbox" ${settings.startPrint ? "checked" : ""}/> Start print after upload</label>
    <div class="row">
      <button class="btn" id="prusaTest" type="button">Test connection</button>
      <button class="btn" id="prusaUpload" type="button">Upload G-code</button>
      <button class="btn" id="prusaJob" type="button">Job status</button>
    </div>
    <div class="meta" id="prusaStatus">${escapeHtml(summary)}</div>
    <p class="meta">URL and API key stay in this browser. Upload uses Prusa Link's file API. A browser on another machine can be blocked by the printer's CORS policy.</p>`;
}

function authHeaders(apiKey: string): Record<string, string> {
  return { "X-Api-Key": apiKey };
}

function formatLeft(seconds: number): string {
  const minutes = Math.max(0, Math.round(seconds / 60));
  if (minutes < 1) return "under a minute left";
  return `${minutes} min left`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}
