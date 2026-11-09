/**
 * Optional mirror into a desktop app. Off unless both variables are set. A failure stays off the tool result.
 * Messages go one at a time, in order. The desktop answers each with its instance: a new one (the app or its
 * page started again) has none of the meshes sent so far, so the session sends the whole plate again.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface BridgeLink {
  /** Mesh hashes the current desktop has been sent. */
  known: Set<string>;
  /** Called when a new desktop answered a message that did not carry every mesh. Queue a full resend. */
  resync: () => void;
}

let queue: Promise<void> = Promise.resolve();
let instance = "";
const SEND_TIMEOUT_MS = 30_000;

/** Recent desktop outcomes, queried on demand; null means the desktop cannot provide receipts. */
export async function bridgeReceipts(): Promise<unknown[] | null> {
  const target = bridgeTarget();
  if (!target) return null;
  try {
    const response = await fetch(new URL("/tandem-receipts", target.url), { headers: { authorization: `Bearer ${target.token}` }, signal: AbortSignal.timeout(1000) });
    if (!response.ok || !(response.headers.get("x-lime-bridge-features") ?? "").split(/[\s,]+/).includes("tandem-receipts")) return null;
    const value: unknown = await response.json();
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** Read the desktop's small human context only when explicitly asked. */
export async function bridgeHumanContext(): Promise<unknown | null> {
  const target = bridgeTarget();
  if (!target) return null;
  try {
    const response = await fetch(new URL("/tandem-context", target.url), { headers: { authorization: `Bearer ${target.token}` }, signal: AbortSignal.timeout(1000) });
    if (!response.ok || !(response.headers.get("x-lime-bridge-features") ?? "").split(/[\s,]+/).includes("tandem-context")) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/** This file's folder: in an installed app, the `mcp` folder beside the desktop program, with the beta's identity file. */
const HERE = dirname(fileURLToPath(import.meta.url));
const BETA_ID = "com.limeslice.slicer.tandem-beta";

/**
 * The file the app keeps its bridge token in when the person turns the bridge on in the app (the Tandem light): the
 * app's config folder, as Tauri names it. `LIME_MCP_BRIDGE_FILE` names it for any server; without it, only the Tandem
 * beta's bundled server looks there, so a checkout or a test never mirrors into a running app by itself.
 */
export function bridgeTokenFile(): string | null {
  if (process.env.LIME_MCP_BRIDGE_FILE) return process.env.LIME_MCP_BRIDGE_FILE;
  if (!existsSync(join(HERE, "tandem-beta.identity"))) return null;
  if (process.platform === "win32") return process.env.APPDATA ? join(process.env.APPDATA, BETA_ID, "tandem-bridge.json") : null;
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", BETA_ID, "tandem-bridge.json");
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), BETA_ID, "tandem-bridge.json");
}

/** The file is read at most once a second: several reads in one call cost one. */
let fileCache: { at: number; path: string; value: { url: string; token: string } | null } | null = null;

function fromTokenFile(): { url: string; token: string } | null {
  const path = bridgeTokenFile();
  if (!path) return null;
  if (fileCache && fileCache.path === path && Date.now() - fileCache.at < 1000) return fileCache.value;
  let value: { url: string; token: string } | null = null;
  try {
    const read = JSON.parse(readFileSync(path, "utf8")) as { url?: unknown; token?: unknown };
    value = typeof read.url === "string" && typeof read.token === "string" && read.token ? { url: read.url, token: read.token } : null;
  } catch {
    value = null;
  }
  fileCache = { at: Date.now(), path, value };
  return value;
}

/** The mirror's address and token, or null when the mirror is off: the environment, else the app's token file. */
export function bridgeTarget(): { url: string; token: string } | null {
  const fromEnv = process.env.LIME_MCP_BRIDGE && process.env.LIME_MCP_BRIDGE_TOKEN ? { url: process.env.LIME_MCP_BRIDGE, token: process.env.LIME_MCP_BRIDGE_TOKEN } : null;
  const found = fromEnv ?? fromTokenFile();
  if (!found) return null;
  const { url, token } = found;
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    console.error("lime-mcp: LIME_MCP_BRIDGE is not a URL, so the mirror was not sent.");
    return null;
  }
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]" && host !== "::1") {
    console.error("lime-mcp: LIME_MCP_BRIDGE is not a loopback address, so the mirror was not sent.");
    return null;
  }
  return { url, token };
}

/**
 * Send `payload` after every message before it. `carriedAll` says the payload holds every mesh on the plate,
 * so a new desktop needs nothing more from it.
 */
export function mirror(payload: unknown, link?: BridgeLink, carriedAll = false): Promise<boolean> {
  const target = bridgeTarget();
  if (!target) return Promise.resolve(false);
  const sent = queue.then(() => send(target, payload, link, carriedAll));
  queue = sent.then(() => undefined);
  return sent;
}

/** Why the last message did not reach the window, or empty when it did. Never names the token. */
let lastFailure = "";

/** Whether a window accepted the last message, and why not. */
export function bridgeDelivery(): { ok: boolean; why: string } {
  return { ok: lastFailure === "", why: lastFailure };
}

/** True when the window accepted the message. */
async function send(target: { url: string; token: string }, payload: unknown, link: BridgeLink | undefined, carriedAll: boolean): Promise<boolean> {
  try {
    const response = await fetch(target.url, {
      method: "POST",
      headers: { authorization: `Bearer ${target.token}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error("lime-mcp: the desktop bridge refused the mirror.");
      lastFailure = response.status === 401 ? `the app at ${target.url} refused the bridge token` : `the app at ${target.url} refused the message (${response.status})`;
      // Whatever this message carried did not arrive.
      link?.known.clear();
      return false;
    }
    lastFailure = "";
    const answered = response.headers.get("x-lime-bridge-instance") ?? "";
    if (answered !== instance) {
      const first = instance === "";
      instance = answered;
      if (!carriedAll || !first) {
        link?.known.clear();
        link?.resync();
      }
    }
    return true;
  } catch {
    console.error("lime-mcp: the desktop bridge did not accept the mirror.");
    lastFailure = `nothing answers at ${target.url}`;
    // The desktop may be closed. The next desktop gets every mesh again.
    link?.known.clear();
    instance = "";
    return false;
  }
}

/** Whether a desktop window is on the other end of the bridge, and in words why not. */
export interface BridgeStatus {
  bridge: "connected" | "absent";
  why?: string;
  url?: string;
}

/**
 * Ask the bridge's health check (one bounded request). `absent` says why: not configured, nobody answering (the app is
 * closed or was started without the bridge), or the token refused.
 */
export async function bridgeStatus(): Promise<BridgeStatus> {
  const target = bridgeTarget();
  const turnOn = "start the app with the bridge launcher, or turn the bridge on with the Tandem light in the app's top bar";
  if (!target) return { bridge: "absent", why: `not configured: LIME_MCP_BRIDGE and LIME_MCP_BRIDGE_TOKEN are not set${bridgeTokenFile() ? " and the app has not turned the bridge on" : ""}; ${turnOn}` };
  try {
    const response = await fetch(new URL("/health", target.url), { headers: { authorization: `Bearer ${target.token}` }, signal: AbortSignal.timeout(1000) });
    if (response.ok) return { bridge: "connected", url: target.url };
    if (response.status === 401) return { bridge: "absent", url: target.url, why: "the app refused the bridge token: LIME_MCP_BRIDGE_TOKEN is not the app's" };
    return { bridge: "absent", url: target.url, why: `the app answered ${response.status}` };
  } catch {
    return { bridge: "absent", url: target.url, why: `not answering at ${target.url}: the app is closed or was started without the bridge; ${turnOn}` };
  }
}

/** How a running desktop answered an open: it opened the file, it refused with a reason, or nobody answered. */
export type BridgeOpen = { opened: true } | { opened: false; reason: string } | null;

const OPEN_TIMEOUT_MS = 10_000;

/**
 * Ask the desktop to open `path`, after every mirror before it. Null when the mirror is off, the desktop does not
 * answer, or it is an older one without `open` in `X-Lime-Bridge-Features`, which would take the message for a plate.
 */
export function bridgeOpen(path: string): Promise<BridgeOpen> {
  const target = bridgeTarget();
  if (!target) return Promise.resolve(null);
  const asked = queue.then(() => sendOpen(target, path));
  queue = asked.then(() => undefined);
  return asked;
}

async function sendOpen(target: { url: string; token: string }, path: string): Promise<BridgeOpen> {
  const authorization = `Bearer ${target.token}`;
  try {
    const health = await fetch(new URL("/health", target.url), { headers: { authorization }, signal: AbortSignal.timeout(OPEN_TIMEOUT_MS) });
    const features = (health.headers.get("x-lime-bridge-features") ?? "").split(/[\s,]+/);
    if (!health.ok || !features.includes("open")) return null;
    const response = await fetch(target.url, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ open: path }),
      signal: AbortSignal.timeout(OPEN_TIMEOUT_MS),
    });
    if (response.ok) return { opened: true };
    if (response.status === 404) return { opened: false, reason: (await response.text()).trim() || "The app did not open the file." };
    return null;
  } catch {
    return null;
  }
}
