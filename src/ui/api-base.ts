/** Where the browser UI sends slice, mesh, and health requests. Tauri keeps using invoke. */

export const API_STORAGE_KEY = "lime-slice-api";
export const TOKEN_STORAGE_KEY = "lime-slice-api-token";
export const DEFAULT_LOOPBACK_API = "http://127.0.0.1:43118";
export const API_PORT = 43118;

export interface ResolveInput {
  stored?: string | null;
  query?: string | null;
  env?: string | null;
  protocol?: string;
  hostname?: string;
}

export function normalizeBase(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "";
  return trimmed.replace(/\/+$/, "");
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.trim().replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0:0:0:0:0:0:0:1";
}

function bracketHost(hostname: string): string {
  const host = hostname.trim();
  if (host.includes(":") && !host.startsWith("[")) return `[${host}]`;
  return host;
}

/**
 * Stored setting, then `?api=`, then `VITE_LIME_API`, then the page host on port 43118
 * when that host is not loopback, otherwise `http://127.0.0.1:43118`.
 */
export function resolveApiBase(input: ResolveInput): string {
  const stored = normalizeBase(input.stored);
  if (stored) return stored;
  const query = normalizeBase(input.query);
  if (query) return query;
  const env = normalizeBase(input.env);
  if (env) return env;
  const hostname = (input.hostname ?? "").trim();
  if (hostname && !isLoopbackHost(hostname)) {
    const protocol = input.protocol === "https:" ? "https:" : "http:";
    return `${protocol}//${bracketHost(hostname)}:${API_PORT}`;
  }
  return DEFAULT_LOOPBACK_API;
}

/** Stored token, then `?token=`, then `VITE_LIME_TOKEN`. Empty means the engine is open. */
export function resolveApiToken(input: { stored?: string | null; query?: string | null; env?: string | null }): string {
  return input.stored?.trim() || input.query?.trim() || input.env?.trim() || "";
}

export function engineDownMessage(url: string): string {
  return `Slicer engine not running at ${url}. Start it with cargo run -p lime-slice --release -- serve`;
}

export function authHeaders(token: string, extra?: Record<string, string>): Record<string, string> {
  const headers = { ...(extra ?? {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export interface ApiLocation {
  protocol: string;
  hostname: string;
  search: string;
}

export function readApiTarget(
  loc: ApiLocation,
  storedBase: string | null,
  storedToken: string | null,
  envBase: string | null | undefined,
  envToken: string | null | undefined,
): { base: string; token: string } {
  const params = new URLSearchParams(loc.search.startsWith("?") ? loc.search.slice(1) : loc.search);
  return {
    base: resolveApiBase({
      stored: storedBase,
      query: params.get("api"),
      env: envBase,
      protocol: loc.protocol,
      hostname: loc.hostname,
    }),
    token: resolveApiToken({
      stored: storedToken,
      query: params.get("token"),
      env: envToken,
    }),
  };
}

function viteEnv(name: string): string | undefined {
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
  const value = env?.[name];
  return value && value.length > 0 ? value : undefined;
}

export function currentApiTarget(): { base: string; token: string } {
  return readApiTarget(
    { protocol: location.protocol, hostname: location.hostname, search: location.search },
    localStorage.getItem(API_STORAGE_KEY),
    localStorage.getItem(TOKEN_STORAGE_KEY),
    viteEnv("VITE_LIME_API"),
    viteEnv("VITE_LIME_TOKEN"),
  );
}
