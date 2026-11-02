/**
 * groovi's R-C: a kernel failure is a refusal, never a crash. An engine process that ends under a call (a kernel crash,
 * a stack overflow, its memory cap) answers that call with a sentence; the part stays at its step and the next call
 * builds its history again. A job a restarted server never had brings the last server's plate back.
 * The stand-in kernel stops on a loft of more than four sections (LIME_MCP_FAKE_STOP_LOFT); the memory cap is checked
 * on a real engine process when the addon is built.
 */
import { existsSync, mkdtempSync, readdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { EngineStopped, engineCandidates, engineCapMb, fakeEngine, loadEngineWorker, stopReason } from "./engine.ts";
import { Session } from "./session.ts";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    console.log(`ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name} ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}

// --- Why a process ended, in words.
check("an access violation is named", stopReason(0xc0000005, null) === "an access violation in the kernel");
check("a stack overflow is named, as Windows reports it", stopReason(-1073741571, null) === "a stack overflow in the kernel");
check("a POSIX segfault is named", stopReason(null, "SIGSEGV") === "a memory fault in the kernel");
check("the memory cap is named in MB", stopReason(1, null, 900) === "it passed its memory cap of 900 MB");
check("and in GB", stopReason(1, null, 11469) === "it passed its memory cap of 11.2 GB");
check("an unknown code is shown", stopReason(0xffffffff, null) === "exit code 0xFFFFFFFF", stopReason(0xffffffff, null));
check("the slicer has no memory cap", engineCapMb("slice", {}) === 0);
check("the modeler's cap is 70 % of memory", engineCapMb("model", {}, 16 * 1024 ** 3) === Math.round(16 * 1024 * 0.7));
check("LIME_MCP_ENGINE_CAP_MB sets it", engineCapMb("model", { LIME_MCP_ENGINE_CAP_MB: "2048" }) === 2048);

// --- A loft that stops the kernel: a refusal, the part as it was, and the next call works.
process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-kernel-stop-"));
process.env.LIME_MCP_FAKE_STOP_LOFT = "1";
const engine = fakeEngine();
const session = new Session(engine);
const call = (name: string, args: unknown = {}) => session.call(name, args);
const made = await call("solid_new", { primitive: "box", dx: 40, dy: 40, dz: 40 });
const id = String(made.object);
const before = Number((await call("model_describe", { object: id })).volumeMm3);
const section = (z: number) => ({ origin: [0, 0, z], turn: [0, 0, 0], profile: [[-5, -5], [5, -5], [5, 5], [-5, 5]] });
const long = { kind: "loft", op: "cut", sections: [2, 6, 10, 14, 18, 22].map(section) };
let threw = "";
let stopped: Record<string, unknown> = {};
try {
  stopped = await call("model_apply", { object: id, op: long, probe: true });
} catch (err) {
  threw = String(err);
}
check("the stopped loft is not a thrown error", threw === "", threw);
check("it is a refusal that names the loft and the stop", stopped.ok === false && /^The loft stopped the kernel \(a stack overflow in the kernel\)\. Nothing changed\./.test(String(stopped.reason)), stopped);
check("it says how to cut it instead", /at most 4 sections each/.test(String(stopped.reason)), stopped.reason);
check("it says the histories are built again", stopped.treeLost === true && /The modeler stopped/.test(String(stopped.treeNote)), stopped);
const after = await call("model_describe", { object: id });
check("the part is at its step", after.ok === true && Number(after.volumeMm3) === before, { before, after: after.volumeMm3 });
const next = await call("model_apply", { object: id, op: { kind: "boolean", op: "cut", primitive: "cylinder", radius: 3, height: 60, origin: [10, 10, -10] }, probe: true });
check("the next edit applies", next.ok === true, next);
const short = await call("model_apply", { object: id, op: { kind: "loft", op: "cut", sections: [2, 6, 10, 14].map(section) }, probe: true });
check("a loft of four sections applies", short.ok === true, short);
const committed = await call("model_commit", { object: id });
check("the part commits", committed.ok === true, committed);
const listed = (await call("plate_list", {})).objects as { object: string; bboxMm: { min: number[]; max: number[] } }[];
const box = listed.find((row) => row.object === id)?.bboxMm;
check("the plate keeps the part at its size", !!box && box.max[0]! - box.min[0]! > 10, listed);
delete process.env.LIME_MCP_FAKE_STOP_LOFT;

// --- A job a restarted server never had: the plate the last server autosaved comes back.
session.flushAutosave();
await session.autosaveSettled();
const own = readdirSync(process.env.LIME_MCP_WORKSPACE).find((name) => /^autosave-\d+\.lime$/.test(name));
check("the first server autosaved its plate", !!own, readdirSync(process.env.LIME_MCP_WORKSPACE));
// The server that wrote it has ended: its file carries a process id nothing runs under.
if (own) renameSync(join(process.env.LIME_MCP_WORKSPACE, own), join(process.env.LIME_MCP_WORKSPACE, "autosave-999999.lime"));
const restarted = new Session(fakeEngine());
const lost = await restarted.call("slice_wait", { job: "job_3" });
check("the lost job is said to be lost to a restart", lost.ok === false && lost.status === "lost" && /The server restarted at .*restored from the autosave/.test(String(lost.reason)), lost);
const back = ((await restarted.call("plate_list", {})).objects as { object: string }[]).map((row) => row.object);
check("the plate is back", back.includes(id), back);
const again = await restarted.call("slice_wait", { job: "job_4" });
check("with a plate, an unknown job is only unknown", again.ok === false && again.status === undefined && again.reason === "That slice job is not in this session.", again);

// --- The memory cap on a real engine process: it ends itself and the call says why.
const root = fileURLToPath(new URL("..", import.meta.url));
if (engineCandidates(root).some((path) => existsSync(path))) {
  process.env.LIME_MCP_ENGINE_CAP_MB = "1";
  const capped = loadEngineWorker(root);
  delete process.env.LIME_MCP_ENGINE_CAP_MB;
  // A quick call can answer before the process's first check, so the next one meets the cap.
  let error: unknown = null;
  for (let attempt = 0; attempt < 6 && !error; attempt += 1) {
    try {
      await capped.modelTree(JSON.stringify({ call: "close", key: "none" }));
      await new Promise((resolve) => setTimeout(resolve, 400));
    } catch (err) {
      error = err;
    }
  }
  check("a modeler over its memory cap stops with that reason", error instanceof EngineStopped && /memory cap of 1 MB/.test(error.message), String(error));
} else {
  console.log("skip the memory cap on a real engine process (no lime-mcp-engine build)");
}

if (failed > 0) {
  console.error(`kernel-stop: ${failed} failed`);
  process.exit(1);
}
console.log("kernel-stop: all passed");
process.exit(0);
