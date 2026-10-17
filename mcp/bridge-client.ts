/**
 * Optional mirror into a desktop app. Off unless both variables are set. A failure stays off the tool result.
 * Messages go one at a time, in order. The desktop answers each with its instance: a new one (the app or its
 * page started again) has none of the meshes sent so far, so the session sends the whole plate again.
 */

export interface BridgeLink {
  /** Mesh hashes the current desktop has been sent. */
  known: Set<string>;
  /** Called when a new desktop answered a message that did not carry every mesh. Queue a full resend. */
  resync: () => void;
}

let queue: Promise<void> = Promise.resolve();
let instance = "";
const SEND_TIMEOUT_MS = 30_000;

/** The mirror's address and token, or null when the mirror is off. */
export function bridgeTarget(): { url: string; token: string } | null {
  const url = process.env.LIME_MCP_BRIDGE;
  const token = process.env.LIME_MCP_BRIDGE_TOKEN;
  if (!url || !token) return null;
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
export function mirror(payload: unknown, link?: BridgeLink, carriedAll = false): Promise<void> {
  const target = bridgeTarget();
  if (!target) return Promise.resolve();
  queue = queue.then(() => send(target, payload, link, carriedAll));
  return queue;
}

async function send(target: { url: string; token: string }, payload: unknown, link: BridgeLink | undefined, carriedAll: boolean): Promise<void> {
  try {
    const response = await fetch(target.url, {
      method: "POST",
      headers: { authorization: `Bearer ${target.token}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error("lime-mcp: the desktop bridge refused the mirror.");
      // Whatever this message carried did not arrive.
      link?.known.clear();
      return;
    }
    const answered = response.headers.get("x-lime-bridge-instance") ?? "";
    if (answered !== instance) {
      const first = instance === "";
      instance = answered;
      if (!carriedAll || !first) {
        link?.known.clear();
        link?.resync();
      }
    }
  } catch {
    console.error("lime-mcp: the desktop bridge did not accept the mirror.");
    // The desktop may be closed. The next desktop gets every mesh again.
    link?.known.clear();
    instance = "";
  }
}
