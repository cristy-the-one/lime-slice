/**
 * Shows a workspace file in the Lime Slice desktop app: through the live bridge when it is on and a running app
 * answers, otherwise by starting the installed app with the file. Starting an app is a side effect the user sees.
 * A running app that was started again hands the file to its own window, so a launch also reaches it.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { bridgeOpen, bridgeStatus, type BridgeOpen, type BridgeStatus } from "./bridge-client.ts";
import { refuse } from "./refusals.ts";

/** This file's folder. In an installed app it is the `mcp` folder beside the desktop program's resources. */
const HERE = dirname(fileURLToPath(import.meta.url));
const BETA = existsSync(join(HERE, "tandem-beta.identity"));
const PROGRAM = BETA ? "lime-slice-tandem-beta" : "lime-slice-desktop";

/** The ways to reach the app. Tests replace them. */
export interface AppOpener {
  /** Ask a running app over the bridge. */
  viaBridge(path: string): Promise<BridgeOpen>;
  /** The installed desktop program, or null. */
  installed(): string | null;
  /** Start `program` with `path`. Rejects when it did not start. */
  launch(program: string, path: string): Promise<void>;
  /** Whether a window is on the bridge, and why not. Absent: not asked. */
  bridge?(): Promise<BridgeStatus>;
}

/**
 * The installed desktop program, found from where the installer put this server. On Windows the per-user install
 * is under %LOCALAPPDATA%\Lime Slice, which is also looked at from a checkout.
 */
export function installedApp(): string | null {
  const candidates: string[] = [];
  if (process.platform === "win32") {
    candidates.push(join(HERE, "..", `${PROGRAM}.exe`));
    for (const root of BETA ? [] : [process.env.LOCALAPPDATA, process.env.ProgramFiles]) {
      if (root) candidates.push(join(root, "Lime Slice", `${PROGRAM}.exe`));
    }
  } else if (process.platform === "darwin") {
    candidates.push(join(HERE, "..", "..", "MacOS", PROGRAM));
    if (!BETA) candidates.push(join("/Applications", "Lime Slice.app", "Contents", "MacOS", PROGRAM));
  } else {
    candidates.push(join(HERE, "..", "..", "..", "bin", PROGRAM));
    if (!BETA) candidates.push(join("/usr", "bin", PROGRAM));
  }
  return candidates.find((path) => existsSync(path)) ?? null;
}

/** Start the app on its own, so it outlives this server and opens no console. */
export function launchApp(program: string, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, [path], { cwd: dirname(program), detached: true, stdio: "ignore", windowsHide: false });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export const systemOpener: AppOpener = { viaBridge: bridgeOpen, installed: installedApp, launch: launchApp, bridge: bridgeStatus };

/** Open `path`, a workspace file, in the app. `saved` says this call wrote it. The result says how in a sentence. */
export async function openInApp(path: string, opener: AppOpener, saved: boolean): Promise<Record<string, unknown>> {
  const name = basename(path);
  const kept = saved ? `the project is saved at ${path}` : `the file is at ${path}`;
  const answer = await opener.viaBridge(path);
  if (answer?.opened) return { ok: true, path, saved, opened: "bridge", status: "requested", note: `Sent ${name} to the running app. The app may ask the user to confirm before opening it.` };
  if (answer) return refuse("app-refused", `The running app did not open ${name}: ${answer.reason}`, { path });
  const program = opener.installed();
  if (!program) return refuse("app-not-installed", `Lime Slice is not installed; ${kept}.`, { path });
  try {
    await opener.launch(program, path);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return refuse("app-not-started", `Lime Slice did not start (${why}); ${kept}.`, { path });
  }
  // Feedback 2026-11-09, section 3: a launch quietly reloaded the file in the running window three turns running. Say so.
  const status = await opener.bridge?.();
  const absent = status?.bridge === "absent"
    ? { bridge: "absent", warning: `The Tandem bridge is not connected (${status.why ?? "no window answers"}). This reloads ${name} in the app: its camera, selection and open panels start over, and later MCP changes will not show there live. Tell the person.` }
    : {};
  return { ok: true, path, saved, opened: "launch", note: `Started Lime Slice with ${name}. An app that was already running opens it in its window.`, ...absent };
}
