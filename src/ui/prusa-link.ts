/**
 * Real printer HTTP client for Prusa Link, Moonraker (Klipper), and OctoPrint.
 * The slicer engine has no send-to-printer API; the UI talks directly to the
 * printer host stored on the printer profile.
 *
 * CI never calls a printer. Tests pass a mock `PrusaFetch`. That mock is not a
 * device in the UI.
 * Desktop `http://` goes through the helper in `src-tauri/src/prusa_http.rs`,
 * because the printer does not send the CORS headers a webview requires.
 * The browser, and any `https://` host, use `fetch`.
 */
import { isTauri } from "../platform.ts";
import type { KlipperLimits } from "../profiles.ts";

/** Old browser-only key. Boot copies it onto the active printer once, then deletes it. */
export const LEGACY_PRUSA_LINK_KEY = "lime-slice-prusa-link";

export type PrinterHostKind = "prusalink" | "moonraker" | "octoprint";

export interface PrusaLinkTarget {
  url: string;
  apiKey: string;
  startPrint: boolean;
  hostType?: PrinterHostKind;
}

export interface PrusaLinkRequest {
  url: string;
  method: "GET" | "PUT" | "POST";
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

export interface MoonrakerConfigImport {
  limits: Partial<KlipperLimits> & { maxAccel?: number };
  geometry: {
    bedX?: number;
    bedY?: number;
    bedZ?: number;
    nozzleDiameter?: number;
    filamentDiameter?: number;
    maxNozzleC?: number;
    maxBedC?: number;
  };
  summary: string;
}

export type MoonrakerConfigResult =
  | { ok: true; config: MoonrakerConfigImport }
  | { ok: false; message: string };

const BUSY_STATES = new Set(["PRINTING", "BUSY", "PAUSED", "PAUSING", "CANCELLING"]);
const MULTIPART_BOUNDARY = "----LimeSliceBoundary7MA4YWxkTrZu0gW";

export function coerceHostKind(value: unknown): PrinterHostKind {
  if (value === "moonraker" || value === "octoprint") return value;
  return "prusalink";
}

export function hostKindLabel(hostType: PrinterHostKind = "prusalink"): string {
  if (hostType === "moonraker") return "Moonraker";
  if (hostType === "octoprint") return "OctoPrint";
  return "Prusa Link";
}

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
export function hostProblem(value: string, hostType: PrinterHostKind = "prusalink"): string | null {
  const trimmed = value.trim();
  const label = hostKindLabel(hostType);
  if (!trimmed) return `Add a ${label} host on this printer first.`;
  if (!parsePrusaOrigin(trimmed)) return `That host is not a ${label} URL. Use http:// or https:// and a host name.`;
  return null;
}

export function keyProblem(apiKey: string, hostType: PrinterHostKind = "prusalink"): string | null {
  if (hostType === "moonraker") return null;
  if (!apiKey.trim()) return `Add the ${hostKindLabel(hostType)} API key for this printer.`;
  return null;
}

export function isPrinterBusy(state: string): boolean {
  const upper = state.trim().toUpperCase();
  return BUSY_STATES.has(upper) || upper.startsWith("PRINTING");
}

export function busyMessage(state: string): string {
  return `The printer is busy (${state}). Wait until it is idle, then send again.`;
}

export function gcodeFileName(meshName: string): string {
  const base = meshName.replace(/\.(stl|3mf|step|stp)$/i, "").replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "part";
  return `${base}.gcode`;
}

export function versionRequest(origin: string, apiKey: string, hostType: PrinterHostKind = "prusalink"): PrusaLinkRequest {
  if (hostType === "moonraker") {
    return { url: `${origin}/printer/info`, method: "GET", headers: authHeaders(apiKey, hostType) };
  }
  return { url: `${origin}/api/version`, method: "GET", headers: authHeaders(apiKey, hostType) };
}

export function statusRequest(origin: string, apiKey: string, hostType: PrinterHostKind = "prusalink"): PrusaLinkRequest {
  if (hostType === "moonraker") {
    return {
      url: `${origin}/printer/objects/query?print_stats&virtual_sdcard`,
      method: "GET",
      headers: authHeaders(apiKey, hostType),
    };
  }
  if (hostType === "octoprint") {
    return { url: `${origin}/api/job`, method: "GET", headers: authHeaders(apiKey, hostType) };
  }
  return { url: `${origin}/api/v1/status`, method: "GET", headers: authHeaders(apiKey, hostType) };
}

export function moonrakerConfigRequest(origin: string, apiKey = ""): PrusaLinkRequest {
  return {
    url: `${origin}/printer/objects/query?configfile=settings`,
    method: "GET",
    headers: authHeaders(apiKey, "moonraker"),
  };
}

export function uploadRequest(
  origin: string,
  apiKey: string,
  filename: string,
  gcode: string,
  startPrint: boolean,
  hostType: PrinterHostKind = "prusalink",
): PrusaLinkRequest {
  if (hostType === "moonraker") {
    const fields: [string, string][] = [["root", "gcodes"]];
    if (startPrint) fields.push(["print", "true"]);
    return {
      url: `${origin}/server/files/upload`,
      method: "POST",
      headers: {
        ...authHeaders(apiKey, hostType),
        "Content-Type": `multipart/form-data; boundary=${MULTIPART_BOUNDARY}`,
      },
      body: buildMultipartGcode(fields, filename, gcode),
    };
  }
  if (hostType === "octoprint") {
    const fields: [string, string][] = [
      ["select", "true"],
      ["print", startPrint ? "true" : "false"],
    ];
    return {
      url: `${origin}/api/files/local`,
      method: "POST",
      headers: {
        ...authHeaders(apiKey, hostType),
        "Content-Type": `multipart/form-data; boundary=${MULTIPART_BOUNDARY}`,
      },
      body: buildMultipartGcode(fields, filename, gcode),
    };
  }
  const name = filename.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return {
    url: `${origin}/api/v1/files/local/${name}`,
    method: "PUT",
    headers: {
      ...authHeaders(apiKey, hostType),
      "Content-Type": "text/x.gcode",
      "Overwrite": "?1",
      "Print-After-Upload": startPrint ? "?1" : "?0",
    },
    body: gcode,
  };
}

function buildMultipartGcode(fields: [string, string][], filename: string, gcode: string): string {
  const safeName = filename.replace(/["\r\n\\]/g, "_") || "part.gcode";
  const parts: string[] = [];
  for (const [key, value] of fields) {
    parts.push(
      `--${MULTIPART_BOUNDARY}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`,
    );
  }
  parts.push(
    `--${MULTIPART_BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"\r\nContent-Type: text/x.gcode\r\n\r\n${gcode}\r\n--${MULTIPART_BOUNDARY}--\r\n`,
  );
  return parts.join("");
}

export function readVersion(status: number, text: string, hostType: PrinterHostKind = "prusalink"): PrusaLinkResult {
  const labelName = hostKindLabel(hostType);
  if (status === 401 || status === 403) return { ok: false, message: `${labelName} refused the API key.` };
  if (status !== 200) return { ok: false, message: `${labelName} returned ${status}.` };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, message: `${labelName} did not return version JSON.` };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: `${labelName} did not return version JSON.` };
  }
  const row = body as Record<string, unknown>;
  if (row.result && typeof row.result === "object" && !Array.isArray(row.result)) {
    const res = row.result as Record<string, unknown>;
    const sw = typeof res.software_version === "string" && res.software_version.trim() ? `Klipper ${res.software_version.trim()}` : "Moonraker";
    const state = typeof res.state === "string" && res.state.trim() ? res.state.trim() : "";
    return { ok: true, summary: [sw, state].filter(Boolean).join(" · ") };
  }
  const label = typeof row.text === "string" && row.text.trim()
    ? row.text.trim()
    : typeof row.server === "string" && row.server.trim()
      ? `${labelName} ${row.server.trim()}`
      : typeof row.api === "string"
        ? `${labelName} API ${row.api}`
        : "";
  if (!label) return { ok: false, message: `${labelName} did not return version JSON.` };
  return { ok: true, summary: label };
}

export function readPrinterState(status: number, text: string, hostType: PrinterHostKind = "prusalink"): PrinterStateResult {
  const labelName = hostKindLabel(hostType);
  if (status === 401 || status === 403) return { ok: false, message: `${labelName} refused the API key.` };
  if (status !== 200) return { ok: false, message: `${labelName} returned ${status}.` };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, message: `${labelName} did not return job status.` };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: `${labelName} did not return job status.` };
  }
  const row = body as Record<string, unknown>;

  // Moonraker `/printer/objects/query?print_stats&virtual_sdcard`
  if (row.result && typeof row.result === "object" && !Array.isArray(row.result)) {
    const res = row.result as Record<string, unknown>;
    const st = res.status && typeof res.status === "object" && !Array.isArray(res.status)
      ? res.status as Record<string, unknown>
      : null;
    const stats = st?.print_stats && typeof st.print_stats === "object" && !Array.isArray(st.print_stats)
      ? st.print_stats as Record<string, unknown>
      : null;
    const sd = st?.virtual_sdcard && typeof st.virtual_sdcard === "object" && !Array.isArray(st.virtual_sdcard)
      ? st.virtual_sdcard as Record<string, unknown>
      : null;
    const rawState = stats && typeof stats.state === "string" ? stats.state.trim() : "";
    if (!rawState) return { ok: false, message: `${labelName} did not return job status.` };
    const state = rawState.toUpperCase();
    const frac = sd && typeof sd.progress === "number" && Number.isFinite(sd.progress) ? sd.progress : null;
    const progress = frac != null && frac > 0 ? `${Math.round(frac * 100)}%` : "";
    const duration = stats && typeof stats.print_duration === "number" && Number.isFinite(stats.print_duration) ? stats.print_duration : 0;
    const left = frac != null && frac > 0.01 && frac < 1 && duration > 0
      ? formatLeft((duration / frac) * (1 - frac))
      : "";
    const bits = [state, progress, left].filter(Boolean);
    return { ok: true, state, summary: bits.join(" · ") };
  }

  // OctoPrint `/api/job`
  if (typeof row.state === "string" && row.state.trim()) {
    const rawState = row.state.trim();
    const upper = rawState.toUpperCase();
    const state = upper.startsWith("PRINTING")
      ? "PRINTING"
      : upper.startsWith("PAUS")
        ? "PAUSED"
        : upper === "OPERATIONAL"
          ? "IDLE"
          : rawState;
    const progObj = row.progress && typeof row.progress === "object" && !Array.isArray(row.progress)
      ? row.progress as Record<string, unknown>
      : null;
    const completion = progObj && typeof progObj.completion === "number" && Number.isFinite(progObj.completion)
      ? `${Math.round(progObj.completion)}%`
      : "";
    const left = progObj && typeof progObj.printTimeLeft === "number" && Number.isFinite(progObj.printTimeLeft)
      ? formatLeft(progObj.printTimeLeft)
      : "";
    const bits = [state, completion, left].filter(Boolean);
    return { ok: true, state, summary: bits.join(" · ") };
  }

  // Prusa Link `/api/v1/status`
  const printer = row.printer && typeof row.printer === "object" && !Array.isArray(row.printer) ? row.printer as Record<string, unknown> : null;
  const state = printer && typeof printer.state === "string" ? printer.state : "";
  if (!state) return { ok: false, message: `${labelName} did not return job status.` };
  const job = row.job && typeof row.job === "object" && !Array.isArray(row.job) ? row.job as Record<string, unknown> : null;
  const progress = job && typeof job.progress === "number" && Number.isFinite(job.progress) ? `${Math.round(job.progress)}%` : "";
  const left = job && typeof job.time_remaining === "number" && Number.isFinite(job.time_remaining) ? formatLeft(job.time_remaining) : "";
  const bits = [state, progress, left].filter(Boolean);
  return { ok: true, state, summary: bits.join(" · ") };
}

export function readStatus(status: number, text: string, hostType: PrinterHostKind = "prusalink"): PrusaLinkResult {
  const parsed = readPrinterState(status, text, hostType);
  if (!parsed.ok) return parsed;
  return { ok: true, summary: parsed.summary };
}

export function readUpload(status: number, hostType: PrinterHostKind = "prusalink"): PrusaLinkResult {
  const labelName = hostKindLabel(hostType);
  if (status === 201 || status === 200) return { ok: true, summary: "Uploaded." };
  if (status === 401 || status === 403) return { ok: false, message: `${labelName} refused the API key.` };
  if (status === 409) return { ok: false, message: "The printer is busy with that file and would not replace it." };
  return { ok: false, message: `${labelName} returned ${status}.` };
}

export function readMoonrakerConfig(status: number, text: string): MoonrakerConfigResult {
  if (status === 401 || status === 403) return { ok: false, message: "Moonraker refused the API key." };
  if (status !== 200) return { ok: false, message: `Moonraker returned ${status}.` };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, message: "Moonraker did not return config JSON." };
  }
  const settings = extractConfigSettings(body);
  if (!settings) return { ok: false, message: "Moonraker did not return printer.cfg settings." };

  const printerSec = asRecord(settings.printer);
  const extruderSec = asRecord(settings.extruder);
  const bedSec = asRecord(settings.heater_bed);
  const stepperX = asRecord(settings.stepper_x);
  const stepperY = asRecord(settings.stepper_y);
  const stepperZ = asRecord(settings.stepper_z);

  const limits: MoonrakerConfigImport["limits"] = {};
  const maxVelocity = posNumber(printerSec?.max_velocity);
  if (maxVelocity !== undefined) limits.maxVelocity = maxVelocity;
  const maxAccel = posNumber(printerSec?.max_accel);
  if (maxAccel !== undefined) limits.maxAccel = Math.round(maxAccel);
  const scv = nonNegNumber(printerSec?.square_corner_velocity);
  if (scv !== undefined) limits.squareCornerVelocity = scv;
  const mcr = nonNegNumber(printerSec?.minimum_cruise_ratio);
  const accelToDecel = posNumber(printerSec?.max_accel_to_decel);
  if (mcr !== undefined) {
    limits.minimumCruiseRatio = Math.min(0.95, Math.round(mcr * 1000) / 1000);
  } else if (accelToDecel !== undefined && maxAccel !== undefined && maxAccel > 0) {
    limits.minimumCruiseRatio = Math.max(0, Math.min(0.95, Math.round((1 - accelToDecel / maxAccel) * 1000) / 1000));
  }
  const ecv = nonNegNumber(extruderSec?.instantaneous_corner_velocity);
  if (ecv !== undefined) limits.extruderCornerVelocity = ecv;
  const maxZVelocity = posNumber(printerSec?.max_z_velocity);
  if (maxZVelocity !== undefined) limits.maxZVelocity = maxZVelocity;
  const maxZAccel = posNumber(printerSec?.max_z_accel);
  if (maxZAccel !== undefined) limits.maxZAccel = Math.round(maxZAccel);

  const geometry: MoonrakerConfigImport["geometry"] = {};
  const bedX = posNumber(stepperX?.position_max);
  const bedY = posNumber(stepperY?.position_max);
  const bedZ = posNumber(stepperZ?.position_max);
  if (bedX !== undefined) geometry.bedX = Math.round(bedX);
  if (bedY !== undefined) geometry.bedY = Math.round(bedY);
  if (bedZ !== undefined) geometry.bedZ = Math.round(bedZ);
  const nozzle = posNumber(extruderSec?.nozzle_diameter);
  if (nozzle !== undefined) geometry.nozzleDiameter = Math.round(nozzle * 1000) / 1000;
  const filament = posNumber(extruderSec?.filament_diameter);
  if (filament !== undefined) geometry.filamentDiameter = Math.round(filament * 1000) / 1000;
  const maxNozzleC = posNumber(extruderSec?.max_temp);
  if (maxNozzleC !== undefined) geometry.maxNozzleC = Math.round(maxNozzleC);
  const maxBedC = posNumber(bedSec?.max_temp);
  if (maxBedC !== undefined) geometry.maxBedC = Math.round(maxBedC);

  if (Object.keys(limits).length === 0 && Object.keys(geometry).length === 0) {
    return { ok: false, message: "Moonraker returned an empty printer.cfg." };
  }

  const parts: string[] = [];
  if (limits.maxVelocity !== undefined) parts.push(`${limits.maxVelocity} mm/s`);
  if (limits.maxAccel !== undefined) parts.push(`${limits.maxAccel} mm/s²`);
  if (limits.squareCornerVelocity !== undefined) parts.push(`SCV ${limits.squareCornerVelocity}`);
  if (geometry.bedX && geometry.bedY && geometry.bedZ) parts.push(`${geometry.bedX}×${geometry.bedY}×${geometry.bedZ} mm`);
  if (geometry.nozzleDiameter) parts.push(`${geometry.nozzleDiameter} mm nozzle`);

  return {
    ok: true,
    config: {
      limits,
      geometry,
      summary: `Imported printer.cfg (${parts.join(" · ") || "limits updated"})`,
    },
  };
}

function extractConfigSettings(body: unknown): Record<string, unknown> | null {
  const root = asRecord(body);
  const res = asRecord(root?.result);
  const st = asRecord(res?.status);
  const cfg = asRecord(st?.configfile);
  return asRecord(cfg?.settings) ?? asRecord(cfg?.config);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function posNumber(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function nonNegNumber(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function unreachable(origin: string, hostType: PrinterHostKind = "prusalink"): PrusaLinkResult {
  return { ok: false, message: `Could not reach ${hostKindLabel(hostType)} at ${origin}. The printer may be off, or the page was blocked from calling it.` };
}

export async function performPrusa(
  request: PrusaLinkRequest,
  fetchImpl: PrusaFetch,
  read: (status: number, text: string) => PrusaLinkResult,
  hostType: PrinterHostKind = "prusalink",
): Promise<PrusaLinkResult> {
  try {
    const res = await fetchImpl(request);
    return read(res.status, res.text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message || message === "Failed to fetch" || message.includes("Failed to fetch") || message.startsWith("NetworkError")) {
      return unreachable(originOf(request.url), hostType);
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
  const hostType = coerceHostKind(target.hostType);
  const host = hostProblem(target.url, hostType);
  if (host) return { ok: false, message: host };
  const key = keyProblem(target.apiKey, hostType);
  if (key) return { ok: false, message: key };
  const origin = parsePrusaOrigin(target.url)!;
  if (target.startPrint) {
    const status = await performPrusa(
      statusRequest(origin, target.apiKey, hostType),
      fetchImpl,
      (code, text) => {
        const parsed = readPrinterState(code, text, hostType);
        if (!parsed.ok) return parsed;
        if (isPrinterBusy(parsed.state)) return { ok: false, message: busyMessage(parsed.state) };
        return { ok: true, summary: parsed.state };
      },
      hostType,
    );
    if (!status.ok) return status;
  }
  const uploaded = await performPrusa(
    uploadRequest(origin, target.apiKey, filename, gcode, target.startPrint, hostType),
    fetchImpl,
    (code) => readUpload(code, hostType),
    hostType,
  );
  if (!uploaded.ok || !target.startPrint) return uploaded;
  const job = await performPrusa(
    statusRequest(origin, target.apiKey, hostType),
    fetchImpl,
    (code, text) => readStatus(code, text, hostType),
    hostType,
  );
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

function authHeaders(apiKey: string, hostType: PrinterHostKind = "prusalink"): Record<string, string> {
  if (!apiKey.trim() && hostType === "moonraker") return {};
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
