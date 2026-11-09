/**
 * The Tandem light in the top bar: is the live bridge to an MCP server off, on (waiting for one), or connected? It
 * always shows (in the release app too since 6.2.0; before, only in the Tandem beta or while a launcher's bridge ran),
 * and the person can turn the bridge on or off here. Turning it on makes the app keep a random token in a file of its
 * own (loopback only; see src-tauri/src/bridge.rs); the app's bundled MCP server reads that file (mcp/bridge-client.ts:
 * the release's reads the release app's, the beta's the beta's), and "Copy MCP settings" gives another MCP client the
 * two lines it needs. The token never stays in the page.
 */
import { pushToast } from "../ui/toasts.ts";

export type BridgeLightState = "off" | "on" | "connected";

interface BridgeStatus {
  state: BridgeLightState;
  beta: boolean;
  port: number;
  source?: "launcher" | "app";
  url?: string;
}

/** What the light says, in words, for its label and its panel. */
export function bridgeLightText(status: Pick<BridgeStatus, "state" | "source" | "port">): { short: string; long: string } {
  if (status.state === "connected") return { short: "Tandem: connected", long: "An MCP server is connected. Its changes show here live, each one undoable." };
  if (status.state === "on") {
    const by = status.source === "launcher" ? "The bridge launcher started the bridge" : "The bridge is on";
    return { short: "Tandem: on", long: `${by} (127.0.0.1:${status.port}, this computer only). No MCP server has connected yet: the app's own MCP server connects by itself; another needs the copied settings.` };
  }
  return { short: "Tandem: off", long: "The bridge is off: an MCP server's changes reach this window only by reopening the file. Turn it on here, or start the app with the bridge launcher." };
}

async function invoke<T>(cmd: string): Promise<T> {
  const { invoke: call } = await import("@tauri-apps/api/core");
  return call<T>(cmd);
}

export function mountBridgeLight(): void {
  const light = document.querySelector<HTMLDetailsElement>("#tandemBridge");
  const text = document.querySelector<HTMLElement>("#tandemBridgeText");
  const say = document.querySelector<HTMLElement>("#tandemBridgeSay");
  const toggle = document.querySelector<HTMLButtonElement>("#tandemBridgeToggle");
  const copy = document.querySelector<HTMLButtonElement>("#tandemBridgeCopy");
  if (!light || !text || !say || !toggle || !copy) return;
  let current: BridgeStatus | null = null;
  const show = (status: BridgeStatus) => {
    current = status;
    const words = bridgeLightText(status);
    // Always shown since 6.2.0: the release app's own MCP server reads its token file as the beta's does.
    light.hidden = false;
    light.dataset.state = status.state;
    text.textContent = words.short;
    say.textContent = words.long;
    toggle.textContent = status.state === "off" ? "Turn the bridge on" : "Turn the bridge off";
    copy.hidden = status.state === "off";
  };
  const refresh = () => invoke<BridgeStatus>("bridge_status").then(show).catch(() => { light.hidden = true; });
  toggle.addEventListener("click", () => {
    const on = current?.state === "off";
    void invoke<BridgeStatus>(on ? "bridge_enable" : "bridge_disable").then((status) => {
      show(status);
      pushToast(on ? "Tandem bridge on. The app's own MCP server connects by itself; use Copy MCP settings for another." : "Tandem bridge off. It stays off when the app starts again.", "info");
    }).catch((err: unknown) => pushToast(`The Tandem bridge did not start: ${err instanceof Error ? err.message : String(err)}`, "error"));
  });
  copy.addEventListener("click", () => {
    void invoke<{ url: string; token: string } | null>("bridge_setup").then(async (setup) => {
      if (!setup) return;
      // Straight to the clipboard: the token is never written into the page.
      await navigator.clipboard.writeText(`LIME_MCP_BRIDGE=${setup.url}\nLIME_MCP_BRIDGE_TOKEN=${setup.token}`);
      pushToast("Copied the MCP settings (address and token). Paste them into the MCP server's environment.", "info");
    }).catch(() => pushToast("The MCP settings could not be copied.", "error"));
  });
  void refresh();
  // Cheap and local: a status read every few seconds while the window is visible, for the connected light.
  setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 4000);
}
