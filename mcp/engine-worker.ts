/**
 * Loads the in-process addon off the server's stdio thread.
 * The parent posts `{id, method, arg}` and receives `{id, ok, result}`.
 */
import { parentPort, workerData } from "node:worker_threads";

import { loadNativeEngine } from "./engine.ts";

const port = parentPort;
if (!port) throw new Error("The engine worker needs a parent port.");

const engine = loadNativeEngine(String((workerData as { root?: string }).root ?? ""));

port.on("message", (msg: { id: number; method: string; arg: string }) => {
  try {
    let result: string | boolean;
    switch (msg.method) {
      case "version":
        result = engine.version() as string;
        break;
      case "occt":
        result = engine.occt() as boolean;
        break;
      case "meshPreview":
        result = engine.meshPreview(msg.arg) as string;
        break;
      case "modelTree":
        result = engine.modelTree(msg.arg) as string;
        break;
      case "sliceStart":
        result = engine.sliceStart(msg.arg) as string;
        break;
      case "slicePoll":
        result = engine.slicePoll(msg.arg) as string;
        break;
      case "sliceCancel":
        result = engine.sliceCancel(msg.arg) as string;
        break;
      default:
        throw new Error("That engine call is not on this worker.");
    }
    port.postMessage({ id: msg.id, ok: true, result });
  } catch (err) {
    port.postMessage({ id: msg.id, ok: false, error: err instanceof Error ? err.message : "The engine call failed." });
  }
});
