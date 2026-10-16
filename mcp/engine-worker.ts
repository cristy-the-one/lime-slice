/**
 * Loads the in-process addon in a child process, off the server's stdio loop.
 * The parent sends `{id, method, arg, bytes}` and receives `{id, ok, result}`.
 * A load failure is sent as id -1. The parent kills this process to stop a call that runs too long.
 */
import { Worker } from "node:worker_threads";

import { type Engine, loadNativeEngine, withMesh } from "./engine.ts";

if (!process.send) throw new Error("The engine process needs an IPC channel.");
const send = (msg: unknown) => process.send?.(msg);

// A native call blocks this thread, so a closed channel cannot be noticed here.
// This thread checks that the server is still alive and ends the process when it is not.
const parent = process.ppid;
new Worker(`
  const { workerData } = require("node:worker_threads");
  setInterval(() => {
    try { process.kill(workerData.parent, 0); } catch { process.kill(workerData.self, "SIGKILL"); }
  }, 1000);
`, { eval: true, workerData: { parent, self: process.pid } }).unref();
process.on("disconnect", () => process.exit(0));

let engine: Engine;
try {
  engine = loadNativeEngine(String(process.env.LIME_MCP_ENGINE_ROOT ?? ""));
} catch (err) {
  send({ id: -1, ok: false, error: err instanceof Error ? err.message : "The in-process engine did not load." });
  process.exit(1);
}

process.on("message", (msg: { id: number; method: string; arg: string; bytes?: Uint8Array }) => {
  try {
    let result: string | boolean;
    const mesh = msg.bytes ? withMesh(msg.arg, msg.bytes) : msg.arg;
    switch (msg.method) {
      case "version":
        result = engine.version() as string;
        break;
      case "occt":
        result = engine.occt() as boolean;
        break;
      case "meshPreview":
        result = engine.meshPreview(mesh) as string;
        break;
      case "modelTree":
        result = engine.modelTree(msg.arg) as string;
        break;
      case "sliceStart":
        result = engine.sliceStart(mesh) as string;
        break;
      case "slicePoll":
        result = engine.slicePoll(msg.arg) as string;
        break;
      case "sliceCancel":
        result = engine.sliceCancel(msg.arg) as string;
        break;
      case "calibrate":
        result = engine.calibrate(msg.arg) as string;
        break;
      case "pareto":
        result = engine.pareto(msg.arg) as string;
        break;
      default:
        throw new Error("That engine call is not on this worker.");
    }
    send({ id: msg.id, ok: true, result });
  } catch (err) {
    send({ id: msg.id, ok: false, error: err instanceof Error ? err.message : "The engine call failed." });
  }
});
