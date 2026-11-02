/**
 * Loads the in-process addon in a child process, off the server's stdio loop.
 * The parent sends `{id, method, arg, bytes}` and receives `{id, ok, result}`.
 * A load failure is sent as id -1. The parent kills this process to stop a call that runs too long.
 */
import { writeSync } from "node:fs";
import { Worker } from "node:worker_threads";

import { type Engine, loadNativeEngine, MEMORY_CAP_MARK, withMesh } from "./engine.ts";
import { appVersion } from "./version.ts";

if (!process.send) throw new Error("The engine process needs an IPC channel.");
const send = (msg: unknown) => process.send?.(msg);

// A native call blocks this thread, so a closed channel cannot be noticed here.
// This thread checks that the server is still alive and ends the process when it is not. --- R-C. It also ends the
// process when its memory passes the cap the server set (LIME_MCP_ENGINE_CAP_MB), after one line on stdout that names
// it: a kernel call that eats the machine's memory stops here, and the server and its plate stay.
const parent = process.ppid;
const capMb = Number(process.env.LIME_MCP_ENGINE_CAP_MB) || 0;
new Worker(`
  const { workerData } = require("node:worker_threads");
  const { writeSync } = require("node:fs");
  const capped = () => {
    if (workerData.capMb > 0 && process.memoryUsage.rss() / 1048576 > workerData.capMb) {
      try { writeSync(1, workerData.mark + Math.round(workerData.capMb) + "\\n"); } catch {}
      process.kill(workerData.self, "SIGKILL");
    }
  };
  capped();
  let tick = 0;
  setInterval(() => {
    tick += 1;
    if (tick % 4 === 0) {
      try { process.kill(workerData.parent, 0); } catch { process.kill(workerData.self, "SIGKILL"); }
    }
    capped();
  }, 250);
`, { eval: true, workerData: { parent, self: process.pid, capMb, mark: MEMORY_CAP_MARK } }).unref();
process.on("disconnect", () => process.exit(0));
// A cap below what the engine needs before its first call is met here, before any call is taken.
if (capMb > 0 && process.memoryUsage.rss() / 1048576 > capMb) {
  writeSync(1, `${MEMORY_CAP_MARK}${Math.round(capMb)}\n`);
  process.exit(1);
}

let engine: Engine & { path: string; installed: boolean };
try {
  engine = loadNativeEngine(String(process.env.LIME_MCP_ENGINE_ROOT ?? ""), appVersion());
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
      case "enginePath":
        result = JSON.stringify({ path: engine.path, installed: engine.installed });
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
      case "simStudy":
        result = engine.simStudy(msg.arg) as string;
        break;
      default:
        throw new Error("That engine call is not on this worker.");
    }
    send({ id: msg.id, ok: true, result });
  } catch (err) {
    send({ id: msg.id, ok: false, error: err instanceof Error ? err.message : "The engine call failed." });
  }
});
