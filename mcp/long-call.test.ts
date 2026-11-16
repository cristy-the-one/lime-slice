/**
 * Finding 2 of the 2.6.1 back-cover session: a long model_apply_batch hit the client's 60 s request timeout, the client
 * restarted the server, and the plate was gone. Against a slow stand-in kernel and the MCP SDK's own client:
 * progress keeps a client that restarts its timeout waiting; a cancelled or slow batch goes on as a job that
 * slice_wait returns and slice_cancel takes back (3.1 finding 1); and a server
 * started again in the same workspace offers the last autosave, which opens with its history.
 */
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { takePreviousAutosave } from "./autosave.ts";
import { nextProgress } from "./protocol.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const server = process.env.LIME_MCP_SERVER || fileURLToPath(new URL("./server.ts", import.meta.url));
const serverArgs = server.endsWith(".mjs") ? [server] : ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", server];
const workspace = mkdtempSync(join(tmpdir(), "lime-long-call-"));

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`ok ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

check("progress that does not move forward still grows", nextProgress(0.5, 0.4) === 0.51 && nextProgress(0.5, null) === 0.51);
check("progress the work reports is sent as it is", nextProgress(0.2, 0.6) === 0.6);

{
  // Two servers on one workspace: a running one's autosave is left alone; an ended one's is offered.
  const shared = mkdtempSync(join(tmpdir(), "lime-autosave-"));
  const before = process.env.LIME_MCP_WORKSPACE;
  process.env.LIME_MCP_WORKSPACE = shared;
  writeFileSync(join(shared, `autosave-${process.ppid}.lime`), JSON.stringify({ objects: [{}] }));
  const live = takePreviousAutosave();
  check("a running server's autosave is not taken", live === null && existsSync(join(shared, `autosave-${process.ppid}.lime`)));
  writeFileSync(join(shared, "autosave-2147483646.lime"), JSON.stringify({ objects: [{}, {}] }));
  const ended = takePreviousAutosave();
  check("an ended server's autosave is offered as the previous plate", ended?.objects === 2 && ended.path === join(shared, "autosave-previous.lime") && !existsSync(join(shared, "autosave-2147483646.lime")), JSON.stringify(ended));
  if (before === undefined) delete process.env.LIME_MCP_WORKSPACE;
  else process.env.LIME_MCP_WORKSPACE = before;
}

async function connect(extra: Record<string, string> = {}): Promise<{ client: Client; call: (name: string, args: unknown) => Promise<Record<string, unknown>> }> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (typeof value === "string") env[key] = value;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: serverArgs,
    cwd: root,
    env: { ...env, LIME_MCP_FAKE: "1", LIME_MCP_WORKSPACE: workspace, LIME_MCP_FAKE_MODEL_MS: "150", LIME_MCP_HEARTBEAT_MS: "100", ...extra },
    stderr: "pipe",
  });
  const client = new Client({ name: "lime-long-call-test", version: "0.0.0" });
  await client.connect(transport);
  const call = async (name: string, args: unknown) => {
    const reply = await client.callTool({ name, arguments: args as Record<string, unknown> });
    const text = (reply.content as { type: string; text?: string }[]).find((row) => row.type === "text")?.text ?? "{}";
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { ok: false, reason: text };
    }
  };
  return { client, call };
}

const bosses = (count: number) => Array.from({ length: count }, (_, i) => ({ kind: "boolean", op: "fuse", primitive: "box", origin: [-9 + i * 2, -2, 19], dx: 2, dy: 2, dz: 3 }));

const first = await connect();
const box = await first.call("solid_new", { primitive: "box", dx: 20, dy: 20, dz: 20 });
const object = String(box.object);

// Eight ops of 2 × 150 ms each run about 2.4 s; the client gives up after 1 s without progress.
const seen: number[] = [];
const long = await first.client.callTool(
  { name: "model_apply_batch", arguments: { object, ops: bosses(8), label: "studs" } },
  undefined,
  { timeout: 1000, resetTimeoutOnProgress: true, onprogress: (row) => seen.push(row.progress) },
);
const longBody = JSON.parse((long.content as { text: string }[])[0]!.text) as Record<string, unknown>;
check("a batch longer than the client's timeout finishes when progress resets it", longBody.ok === true && longBody.applied === 8, JSON.stringify(longBody));
check("progress came, always growing", seen.length >= 8 && seen.every((value, i) => i === 0 || value > seen[i - 1]!), JSON.stringify(seen));
const afterLong = await first.call("model_history", { object, limit: 100 });
const kept = (afterLong.nodes as unknown[]).length;
check("the history holds the root and the eight steps", kept === 9, JSON.stringify(afterLong));

// A client that does not reset its timeout gives up and cancels (3.1 finding 1): the batch is not thrown away but goes
// on as a background job, which session_info names, an edit is refused with, and slice_wait returns the result of.
let timedOut = false;
try {
  await first.client.callTool({ name: "model_apply_batch", arguments: { object, ops: bosses(8) } }, undefined, { timeout: 700 });
} catch {
  timedOut = true;
}
check("a client without progress resets times out", timedOut);
const busyInfo = await first.call("session_info", {});
const running = (busyInfo.job as { job?: string; tool?: string } | undefined) ?? {};
check("session_info names the job the cancelled call became", typeof running.job === "string" && running.tool === "model_apply_batch", JSON.stringify(busyInfo.job));
const busy = await first.call("model_apply", { object, probe: true, op: bosses(1)[0] });
check("an edit while it runs is refused with the job's handle", busy.ok === false && busy.job === running.job && String(busy.reason).includes("slice_wait"), JSON.stringify(busy));
let waited = await first.call("slice_wait", { job: running.job, timeoutS: 20 });
for (let round = 0; waited.status === "running" && round < 5; round += 1) waited = await first.call("slice_wait", { job: running.job, timeoutS: 20 });
check("slice_wait returns the batch's own result once it is done", waited.status === "done" && waited.ok === true && waited.applied === 8 && waited.tool === "model_apply_batch", JSON.stringify(waited));
const afterJob = await first.call("model_history", { object, limit: 100 });
check("the job's eight steps are in the history", (afterJob.nodes as unknown[]).length === kept + 8, JSON.stringify(afterJob));

// slice_cancel takes a job back whole: the part and its history are as they were before it.
let cancelledJob = "";
try {
  await first.client.callTool({ name: "model_apply_batch", arguments: { object, ops: bosses(8) } }, undefined, { timeout: 700 });
} catch {
  cancelledJob = String(((await first.call("session_info", {})).job as { job?: string } | undefined)?.job ?? "");
}
const stopped = await first.call("slice_cancel", { job: cancelledJob });
let outcome = stopped;
for (let round = 0; outcome.status === "cancelling" && round < 5; round += 1) outcome = await first.call("slice_wait", { job: cancelledJob, timeoutS: 20 });
const afterCancel = await first.call("model_history", { object, limit: 100 });
check("slice_cancel takes the job's batch back whole", outcome.cancelled === true && outcome.rolledBack === true && (afterCancel.nodes as unknown[]).length === kept + 8, JSON.stringify({ outcome, afterCancel }));
await new Promise((resolve) => setTimeout(resolve, 1300));
await first.client.close();

// The client restarts the server: the new one offers the plate the old one autosaved.
const second = await connect();
const info = await second.call("session_info", {});
const offer = info.autosave as { path?: string; objects?: number } | undefined;
check("a restarted server offers the last autosave", typeof offer?.path === "string" && offer.path.endsWith("autosave-previous.lime") && offer.objects === 1, JSON.stringify(info.autosave));
const listed = await second.call("plate_list", {});
check("an empty plate list names the autosave too", (listed.objects as unknown[]).length === 0 && (listed.autosave as { path?: string } | undefined)?.path === offer?.path, JSON.stringify(listed));
const stale = await second.call("model_history", { object });
check("an old handle says where the last plate is", stale.ok === false && String(stale.reason).includes("project_open that path") && stale.autosave === offer?.path, JSON.stringify(stale));
const reopened = await second.call("project_open", { path: offer?.path ?? "" });
const rows = (reopened.objects ?? []) as { object: string }[];
const back = rows.length ? await second.call("model_history", { object: rows[0]!.object, limit: 100 }) : {};
check("the autosave opens with the whole history", reopened.ok === true && Array.isArray(back.nodes) && (back.nodes as unknown[]).length === kept + 8, JSON.stringify({ reopened, back }));
await second.client.close();

// A call that runs past LIME_MCP_REPLY_S answers with a job before any client gives up; slice_wait has its result.
const third = await connect({ LIME_MCP_REPLY_S: "0.5" });
const part = String((await third.call("solid_new", { primitive: "box", dx: 20, dy: 20, dz: 20 })).object);
const early = await third.call("model_apply_batch", { object: part, ops: bosses(8) });
check("a batch past the reply time answers with a running job", early.ok === true && early.status === "running" && typeof early.job === "string" && early.tool === "model_apply_batch", JSON.stringify(early));
let late = await third.call("slice_wait", { job: early.job, timeoutS: 20 });
for (let round = 0; late.status === "running" && round < 5; round += 1) late = await third.call("slice_wait", { job: early.job, timeoutS: 20 });
check("its wait returns the applied batch", late.status === "done" && late.applied === 8, JSON.stringify(late));
await third.client.close();

// --- A long model_check {sweep} and model_place {until} (feedback: both ran synchronously, so no heartbeat went out,
// the client timed out at 60 s and restarted the server). Now they give the event loop a turn every ~20 ms: progress
// flows, a call past the reply time answers with a job whose result is the direct one, and a cancel puts poses back.
// The rig: an arm hinged at the origin, a block it meets near 80 degrees, and 200 posts out of its reach that make
// every angle cost (about 0.8 s for 800 angles); in a second assembly a carriage slides 99 mm 0.06 mm from a wall, so
// the until search steps by 0.06 mm (about 1800 poses).
type Conn = Awaited<ReturnType<typeof connect>>;
const POSTS = 200;
async function settle(conn: Conn, reply: Record<string, unknown>): Promise<Record<string, unknown>> {
  let out = reply;
  for (let round = 0; out.status === "running" && round < 20; round += 1) out = await conn.call("slice_wait", { job: out.job, timeoutS: 20 });
  return out;
}
async function mechanism(conn: Conn) {
  const made = async (dx: number, dy: number, name: string) => String((await settle(conn, await conn.call("solid_new", { primitive: "box", dx, dy, dz: 5, name }))).object);
  const placeOk = async (input: Record<string, unknown>) => {
    const placed = await settle(conn, await conn.call("model_place", input));
    if (placed.ok !== true) throw new Error(JSON.stringify(placed));
  };
  const base = await made(400, 120, "Base");
  const arm = await made(30, 4, "Arm");
  const block = await made(4, 4, "Block");
  await placeOk({ object: arm, to: base, x: 15, y: 0, z: 6 });
  await placeOk({ object: arm, joint: { kind: "hinge", pivot: [-15, 0, 0], axis: [0, 0, 1] } });
  await placeOk({ object: block, to: base, x: 0, y: 20, z: 6 });
  const posts: string[] = [];
  for (let i = 0; i < POSTS; i += 1) posts.push(await made(2, 2, `Post ${i + 1}`));
  await placeOk({ objects: posts, to: base });
  for (const [i, post] of posts.entries()) await placeOk({ object: post, x: -190 + (i % 100) * 3, y: -40 - Math.floor(i / 100) * 3, z: 6 });
  const rail = await made(300, 40, "Rail");
  const carriage = await made(4, 4, "Carriage");
  const wall = await made(200, 2, "Wall");
  const stop = await made(2, 10, "Stop");
  await placeOk({ object: carriage, to: rail, x: -100, y: 0, z: 6 });
  await placeOk({ object: carriage, joint: { kind: "slide", pivot: [0, 0, 0], axis: [1, 0, 0] } });
  await placeOk({ object: wall, to: rail, x: 0, y: 3.06, z: 6 });
  await placeOk({ object: stop, to: rail, x: 2, y: 0, z: 6 });
  return { arm, carriage };
}
const sweepArgs = (arm: string) => ({ object: arm, sweep: { from: 0, to: 99.9, step: 0.1 } });
const untilArgs = (carriage: string) => ({ object: carriage, until: { contact: "any", dir: 1, max: 140, exact: false } });
const strip = (reply: Record<string, unknown>) => {
  const { job: _job, status: _status, tool: _tool, ...rest } = reply;
  return JSON.stringify(rest);
};
const posesOf = async (conn: Conn) => JSON.stringify(((await conn.call("plate_list", {})).objects as { object: string; assembledMm?: unknown }[]).map((row) => [row.object, row.assembledMm]));

// The direct answers, from a server with the usual reply time; the client resets its timeout on progress, so a sweep
// longer than that timeout finishes only if progress goes out while it runs.
const direct = await connect({ LIME_MCP_FAKE_MODEL_MS: "0" });
const plain = await mechanism(direct);
const beats: number[] = [];
let sweptStart = Date.now();
const sweptRaw = await direct.client.callTool({ name: "model_check", arguments: sweepArgs(plain.arm) }, undefined, { timeout: 300, resetTimeoutOnProgress: true, onprogress: (row) => beats.push(row.progress) });
const sweptMs = Date.now() - sweptStart;
const sweptDirect = JSON.parse((sweptRaw.content as { text: string }[])[0]!.text) as Record<string, unknown>;
check("a sweep longer than the client's timeout finishes, kept alive by progress", sweptDirect.ok === true && sweptMs > 300 && Number(sweptDirect.firstCollisionDeg) > 70 && beats.length >= 3, JSON.stringify({ sweptMs, beats: beats.length, sweptDirect }).slice(0, 600));
check("its progress grows", beats.every((value, i) => i === 0 || value > beats[i - 1]!), JSON.stringify(beats));
sweptStart = Date.now();
const untilDirect = await direct.call("model_place", untilArgs(plain.carriage));
check("a long until answers directly on the usual reply time", untilDirect.ok === true && Math.abs(Number(untilDirect.travel) - 99) < 0.02 && Number(untilDirect.evaluations) > 1000, JSON.stringify(untilDirect).slice(0, 600));
console.log(`     sweep ${sweptMs} ms, ${String(sweptDirect.evaluations)} poses; until ${Date.now() - sweptStart} ms, ${String(untilDirect.evaluations)} poses`);
await direct.client.close();

// The same calls on a server whose reply time is 1 ms: each answers with a job, and slice_wait returns the direct result.
const quick = await connect({ LIME_MCP_FAKE_MODEL_MS: "0", LIME_MCP_REPLY_S: "0.001" });
const rig = await mechanism(quick);
const before = await posesOf(quick);
const sweepJob = await quick.call("model_check", sweepArgs(rig.arm));
check("a long sweep answers with a running job", sweepJob.ok === true && sweepJob.status === "running" && sweepJob.tool === "model_check", JSON.stringify(sweepJob));
const sweepDone = await settle(quick, sweepJob);
check("its wait returns the same result as the direct call", sweepDone.status === "done" && strip(sweepDone) === strip(sweptDirect), JSON.stringify({ job: sweepDone, direct: sweptDirect }).slice(0, 1500));
check("and the poses are as they were", (await posesOf(quick)) === before);

// slice_cancel stops a sweep between angles; the poses are put back.
const cancelJob = await quick.call("model_check", sweepArgs(rig.arm));
const cancelReply = await quick.call("slice_cancel", { job: cancelJob.job });
const cancelOutcome = await settle(quick, cancelReply.status === "cancelling" ? { ...cancelReply, status: "running" } : cancelReply);
check("a cancelled sweep stops with a sentence", cancelJob.status === "running" && cancelOutcome.ok === false && cancelOutcome.code === "cancelled" && /sweep was cancelled at angle \d+ of \d+/.test(String(cancelOutcome.reason)), JSON.stringify({ cancelJob, cancelReply, cancelOutcome }));
check("a cancelled sweep leaves the poses as they were", (await posesOf(quick)) === before);

// A long step inside plan_run hands the plan over too.
const planJob = await quick.call("plan_run", { steps: [{ tool: "model_check", args: sweepArgs(rig.arm) }] });
check("a plan whose step sweeps long answers with a job", planJob.status === "running" && planJob.tool === "plan_run", JSON.stringify(planJob));
const planDone = await settle(quick, planJob);
const planStep = ((planDone.steps ?? []) as { result?: Record<string, unknown> }[])[0]?.result;
check("the plan's result holds the sweep's", planDone.ok === true && planStep?.firstCollisionDeg === sweptDirect.firstCollisionDeg && planStep?.evaluations === sweptDirect.evaluations, JSON.stringify(planDone).slice(0, 800));

// A long until, the same way; a cancelled one moves nothing.
const stopJob = await quick.call("model_place", untilArgs(rig.carriage));
const stopReply = await quick.call("slice_cancel", { job: stopJob.job });
const stopOutcome = await settle(quick, stopReply.status === "cancelling" ? { ...stopReply, status: "running" } : stopReply);
check("a cancelled until moves nothing", stopJob.status === "running" && stopOutcome.code === "cancelled" && String(stopOutcome.reason).includes("nothing moved") && (await posesOf(quick)) === before, JSON.stringify({ stopJob, stopOutcome }));
const untilJob = await quick.call("model_place", untilArgs(rig.carriage));
check("a long until answers with a running job", untilJob.ok === true && untilJob.status === "running" && untilJob.tool === "model_place", JSON.stringify(untilJob));
const untilDone = await settle(quick, untilJob);
check("its wait returns the same result as the direct call", untilDone.status === "done" && strip(untilDone) === strip(untilDirect), JSON.stringify({ job: untilDone, direct: untilDirect }).slice(0, 1500));
await quick.client.close();

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("long-call: ok");
process.exit(0);
