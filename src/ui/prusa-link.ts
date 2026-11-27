/**
 * Printer hosts for Prusa Link, Moonraker (Klipper), and OctoPrint: the types, and the checks Prepare's Send button
 * reads at start-up. The HTTP client itself is src/ui/prusa-link-net.ts, loaded on the first Test, Send, Job, or import.
 * The slicer engine has no send-to-printer API; the UI talks directly to the
 * printer host stored on the printer profile.
 *
 * CI never calls a printer. Tests pass a mock `PrusaFetch`. That mock is not a
 * device in the UI.
 * Desktop `http://` goes through the helper in `src-tauri/src/prusa_http.rs`,
 * because the printer does not send the CORS headers a webview requires.
 * The browser, and any `https://` host, use `fetch`.
 */
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
  /** printer.cfg has a `[gcode_arcs]` section, so this Klipper runs G2/G3. */
  firmwareArcs: boolean;
  summary: string;
}

export type MoonrakerConfigResult =
  | { ok: true; config: MoonrakerConfigImport }
  | { ok: false; message: string };


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

export function gcodeFileName(meshName: string): string {
  const base = meshName.replace(/\.(stl|3mf|step|stp)$/i, "").replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "part";
  return `${base}.gcode`;
}
