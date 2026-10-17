/**
 * Files the desktop shell hands the page: the one the app was started with (a launch argument or a file
 * association), one a second launch passed to this window, or one the MCP server asked it to open over the bridge.
 * Each opens the way File > Open does, with its unsaved-changes prompt.
 */
import { base64ToBytes } from "../base64.ts";
import { isTauri } from "../platform.ts";
import { pushToast } from "../ui/toasts.ts";
import { fail } from "./files.ts";
import { fx } from "./fx.ts";
import { openPickedFile } from "./project-io.ts";
import { state } from "./state.ts";

interface ShellFile {
  name: string;
  bytesB64: string;
}

async function openShellFile(shell: ShellFile): Promise<void> {
  const bytes = base64ToBytes(shell.bytesB64);
  if (!bytes) {
    pushToast(`${shell.name} could not be read.`, "error");
    return;
  }
  await openPickedFile(new File([bytes as Uint8Array<ArrayBuffer>], shell.name));
  // A fresh window opens on Preview: show the plate that was opened. Model stays put.
  if (state.mesh && state.stage !== "model" && state.stage !== "prepare") fx.setStage("prepare");
}

export function mountOpenFile(): void {
  if (!isTauri()) return;
  void (async () => {
    const [{ listen }, { invoke }] = await Promise.all([import("@tauri-apps/api/event"), import("@tauri-apps/api/core")]);
    // Listen first, so a path that arrives while the launch file is read is not missed.
    await listen<ShellFile>("lime-open-file", (event) => {
      openShellFile(event.payload).catch(fail);
    });
    try {
      const launch = await invoke<ShellFile | null>("take_launch_file");
      if (launch) await openShellFile(launch);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), "error");
    }
  })();
}
