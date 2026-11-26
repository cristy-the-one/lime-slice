/**
 * MCP 2026-07-28 M3. A client that lists io.modelcontextprotocol/tasks gets a task
 * where this server would have answered with a job. Everyone else still gets the job.
 * Stand-in engine. LIME_MCP_REPLY_S is small so a detachable call answers before it finishes.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { GUIDES } from "./guides.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const server = fileURLToPath(new URL("./server.ts", import.meta.url));
const TASKS = "io.modelcontextprotocol/tasks";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  env.LIME_MCP_FAKE = "1";
  env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-mcp-tasks-"));
  return { ...env, ...extra };
}

function startRaw(extra: Record<string, string> = {}) {
  const child = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", server], {
    cwd: root,
    env: childEnv(extra),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  let buf = "";
  const pending: string[] = [];
  const waiters: ((line: string) => void)[] = [];
  child.stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else pending.push(line);
      nl = buf.indexOf("\n");
    }
  });
  const next = (ms = 20000) => new Promise<string>((resolve, reject) => {
    const queued = pending.shift();
    if (queued !== undefined) {
      resolve(queued);
      return;
    }
    const timer = setTimeout(() => reject(new Error(`no line within ${ms} ms\n${stderr}`)), ms);
    waiters.push((line) => {
      clearTimeout(timer);
      resolve(line);
    });
  });
  let seq = 1;
  return {
    child,
    stderr: () => stderr,
    id: () => seq++,
    send(text: string) {
      child.stdin.write(text);
    },
    next,
  };
}

type Raw = ReturnType<typeof startRaw>;

interface RpcError {
  code?: number;
  message?: string;
  data?: { requiredCapabilities?: { extensions?: Record<string, unknown> } };
}

interface TaskBody {
  resultType?: string;
  taskId?: string;
  status?: string;
  fraction?: number;
  stage?: string;
  ttlMs?: number | null;
  pollIntervalMs?: number;
  createdAt?: string;
  lastUpdatedAt?: string;
  statusMessage?: string;
  result?: Record<string, unknown>;
  capabilities?: { tools?: { listChanged?: boolean }; extensions?: Record<string, unknown> };
  content?: { type?: string; text?: string }[];
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

interface Row {
  id?: number | null;
  method?: string;
  result?: TaskBody;
  error?: RpcError;
}

function rpc(id: number, method: string, params?: Record<string, unknown>): string {
  const message: Record<string, unknown> = { jsonrpc: "2.0", id, method };
  if (params) message.params = params;
  return `${JSON.stringify(message)}\n`;
}

function meta(tasks: boolean, version = "2026-07-28"): Record<string, unknown> {
  return {
    "io.modelcontextprotocol/protocolVersion": version,
    "io.modelcontextprotocol/clientInfo": { name: tasks ? "task-client" : "plain-2026", version: "0" },
    "io.modelcontextprotocol/clientCapabilities": tasks ? { extensions: { [TASKS]: {} } } : {},
  };
}

const taskMeta = meta(true);
const plainMeta = meta(false);

async function untilId(io: Raw, id: number): Promise<Row> {
  for (;;) {
    const row = JSON.parse(await io.next()) as Row;
    if (row.id === id) return row;
  }
}

async function callRaw(io: Raw, name: string, args: Record<string, unknown>, requestMeta?: Record<string, unknown>): Promise<Row> {
  const id = io.id();
  const params: Record<string, unknown> = { name, arguments: args };
  if (requestMeta) params._meta = requestMeta;
  io.send(rpc(id, "tools/call", params));
  return untilId(io, id);
}

function toolBody(row: Row): Record<string, unknown> {
  const text = row.result?.content?.[0]?.text;
  if (typeof text !== "string") return { __envelope: row.result ?? null, __error: row.error ?? null };
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: text };
  }
}

async function tool(io: Raw, name: string, args: Record<string, unknown>, requestMeta?: Record<string, unknown>): Promise<Record<string, unknown>> {
  return toolBody(await callRaw(io, name, args, requestMeta));
}

const bosses = (count: number) => Array.from({ length: count }, (_, i) => ({
  kind: "boolean", op: "fuse", primitive: "box", origin: [-9 + i * 2, -2, 19], dx: 2, dy: 2, dz: 3,
}));

/** Job ids and the wall-clock seconds field. Everything else is the reply. */
function canon(value: unknown): string {
  return JSON.stringify(value ?? null).replace(/job_\d+/g, "job_N").replace(/"seconds":\d+/g, `"seconds":0`);
}

/** The job handle inside a completed task, whether the result is still the bare tool JSON or a CallToolResult. */
function nestedJob(row: Row): string {
  const nested = row.result?.result as { job?: unknown; content?: { text?: string }[] } | undefined;
  if (!nested) return "";
  if (typeof nested.job === "string") return nested.job;
  const text = nested.content?.[0]?.text;
  if (typeof text !== "string") return "";
  try {
    const body = JSON.parse(text) as { job?: unknown };
    return typeof body.job === "string" ? body.job : "";
  } catch {
    return "";
  }
}

async function pollTask(io: Raw, taskId: string, requestMeta: Record<string, unknown>): Promise<Row> {
  let last: Row = {};
  for (let round = 0; round < 40; round += 1) {
    const id = io.id();
    io.send(rpc(id, "tasks/get", { taskId, _meta: requestMeta }));
    last = await untilId(io, id);
    const status = last.result?.status;
    if (status && status !== "working" && status !== "input_required") return last;
  }
  return last;
}

const opsGuide = GUIDES.find((guide) => guide.uri === "lime://guide/ops")?.text ?? "";
check(
  "the guide says a client that speaks tasks gets a task",
  opsGuide.includes("A client that speaks tasks gets a task"),
  opsGuide.includes("slice_wait") ? "the long-call line is there, the tasks line is not" : "ops guide missing",
);

const plan = readFileSync(join(root, "docs/plan-mcp-2026-07-28.md"), "utf8");
const milestone = plan.split("\n").find((line) => line.startsWith("| M3 |"));
check("plan §3 marks M3 done", milestone !== undefined && /\bDone\b/.test(milestone ?? ""), milestone ?? "no M3 row");

const slow = { LIME_MCP_REPLY_S: "0.05", LIME_MCP_FAKE_MODEL_MS: "200" };

const tasks = startRaw(slow);
const legacy = startRaw(slow);
const plain = startRaw(slow);
try {
  const initId = tasks.id();
  tasks.send(rpc(initId, "initialize", {
    protocolVersion: "2026-07-28",
    capabilities: { extensions: { [TASKS]: {} } },
    clientInfo: { name: "task-client", version: "0" },
  }));
  const init = await untilId(tasks, initId);
  const advertised = init.result?.capabilities?.extensions?.[TASKS];
  check(
    "initialize advertises the tasks extension when 2026-07-28 is agreed",
    init.result?.resultType === "complete" && advertised !== undefined && JSON.stringify(advertised) === "{}",
    JSON.stringify(init.result?.capabilities ?? init.error),
  );

  const discoverId = tasks.id();
  tasks.send(rpc(discoverId, "server/discover", { _meta: taskMeta }));
  const discovered = await untilId(tasks, discoverId);
  check(
    "server/discover advertises the tasks extension",
    JSON.stringify(discovered.result?.capabilities?.extensions?.[TASKS]) === "{}",
    JSON.stringify(discovered.result?.capabilities ?? discovered.error),
  );

  const info = await tool(tasks, "session_info", {}, taskMeta);
  check(
    "a fast call stays a tool result",
    info.ok === true && info.__envelope === undefined,
    JSON.stringify(info).slice(0, 300),
  );

  const planned = await callRaw(tasks, "ribs_plan", { wall: { faces: [0] } }, taskMeta);
  check(
    "startsAsJob answers with a task",
    planned.result?.resultType === "task" && planned.result.status === "working" && typeof planned.result.taskId === "string",
    JSON.stringify(planned.result ?? planned.error).slice(0, 400),
  );
  const planTask = planned.result?.taskId ?? "";
  const planDone = planTask ? await pollTask(tasks, planTask, taskMeta) : {};
  const planJob = nestedJob(planDone);
  const planWait = planJob ? await callRaw(tasks, "slice_wait", { job: planJob, timeoutS: 2 }, taskMeta) : {};
  check(
    "tasks/get of a ribs_plan task equals the tools/call slice_wait result",
    planDone.result?.status === "completed" && planDone.result.resultType === "complete" && JSON.stringify(planDone.result.result) === JSON.stringify(planWait.result),
    JSON.stringify({ task: planDone.result?.result, wait: planWait.result }).slice(0, 800),
  );

  const made = await tool(tasks, "solid_new", { primitive: "box", dx: 20, dy: 20, dz: 20 }, taskMeta);
  const object = String(made.object ?? "");
  check("solid_new answers directly", made.ok === true && object !== "", JSON.stringify(made).slice(0, 300));

  const batch = await callRaw(tasks, "model_apply_batch", { object, ops: bosses(4) }, taskMeta);
  check(
    "a call past the reply time answers with a task",
    batch.result?.resultType === "task" && batch.result.status === "working" && typeof batch.result.taskId === "string" && batch.result.content === undefined,
    JSON.stringify(batch.result ?? batch.error).slice(0, 500),
  );
  const runningId = tasks.id();
  tasks.send(rpc(runningId, "tasks/get", { taskId: batch.result?.taskId, _meta: taskMeta }));
  const running = await untilId(tasks, runningId);
  check(
    "tasks/get while it runs has fraction and stage",
    running.result?.resultType === "complete"
      && running.result.status === "working"
      && typeof running.result.fraction === "number"
      && typeof running.result.stage === "string"
      && running.result.stage.length > 0,
    JSON.stringify(running.result ?? running.error).slice(0, 500),
  );

  const busy = await callRaw(tasks, "model_apply", {
    object,
    probe: true,
    op: bosses(1)[0],
  }, taskMeta);
  const busyBody = toolBody(busy);
  check(
    "WHILE_BUSY still refuses an edit and names slice_wait",
    busy.result?.resultType === "complete"
      && busy.result.content !== undefined
      && busyBody.ok === false
      && busyBody.job !== undefined
      && String(busyBody.reason).includes("slice_wait"),
    JSON.stringify(busyBody).slice(0, 400),
  );

  const done = await pollTask(tasks, batch.result?.taskId ?? "", taskMeta);
  const doneJob = nestedJob(done);
  const waited = doneJob ? await callRaw(tasks, "slice_wait", { job: doneJob, timeoutS: 5 }, taskMeta) : {};
  const waitedBody = toolBody(waited);
  check(
    "tasks/get when done equals the tools/call slice_wait result",
    done.result?.status === "completed" && JSON.stringify(done.result.result) === JSON.stringify(waited.result) && waitedBody.status === "done" && waitedBody.applied === 4,
    JSON.stringify({ task: done.result?.result, wait: waited.result }).slice(0, 800),
  );

  const before = await tool(tasks, "model_history", { object, limit: 100 }, taskMeta);
  const beforeNodes = Array.isArray(before.nodes) ? before.nodes.length : -1;
  const cancelBatch = await callRaw(tasks, "model_apply_batch", { object, ops: bosses(4) }, taskMeta);
  const cancelId = tasks.id();
  tasks.send(rpc(cancelId, "tasks/cancel", { taskId: cancelBatch.result?.taskId, _meta: taskMeta }));
  const cancelAck = await untilId(tasks, cancelId);
  const cancelKeys = Object.keys(cancelAck.result ?? {}).sort();
  check(
    "tasks/cancel acks empty",
    cancelAck.error === undefined && cancelAck.result?.resultType === "complete" && cancelAck.result.taskId === undefined && cancelAck.result.status === undefined,
    JSON.stringify(cancelAck.result ?? cancelAck.error),
  );
  check(
    "the ack is resultType, serverInfo, and nothing else",
    JSON.stringify(cancelKeys) === JSON.stringify(["_meta", "resultType"]),
    cancelKeys.join(","),
  );
  const cancelDone = await pollTask(tasks, cancelBatch.result?.taskId ?? "", taskMeta);
  const after = await tool(tasks, "model_history", { object, limit: 100 }, taskMeta);
  const afterNodes = Array.isArray(after.nodes) ? after.nodes.length : -1;
  check(
    "a stoppable batch cancelled mid-run is cancelled",
    cancelDone.result?.resultType === "complete"
      && cancelDone.result.status === "cancelled"
      && !("result" in (cancelDone.result ?? {}))
      && typeof cancelDone.result.statusMessage === "string"
      && cancelDone.result.statusMessage.includes("taken back")
      && afterNodes === beforeNodes,
    JSON.stringify({ task: cancelDone.result, beforeNodes, afterNodes }).slice(0, 600),
  );

  const finishBefore = await tool(tasks, "model_history", { object, limit: 100 }, taskMeta);
  const finishNodes = Array.isArray(finishBefore.nodes) ? finishBefore.nodes.length : -1;
  const finishing = await callRaw(tasks, "model_apply", { object, probe: true, op: bosses(1)[0] }, taskMeta);
  const finishCancel = tasks.id();
  tasks.send(rpc(finishCancel, "tasks/cancel", { taskId: finishing.result?.taskId, _meta: taskMeta }));
  const finishAck = await untilId(tasks, finishCancel);
  const finishDone = finishing.result?.taskId ? await pollTask(tasks, finishing.result.taskId, taskMeta) : {};
  const finishJob = nestedJob(finishDone);
  const finishWait = finishJob ? await callRaw(tasks, "slice_wait", { job: finishJob, timeoutS: 5 }, taskMeta) : {};
  const finishAfter = await tool(tasks, "model_history", { object, limit: 100 }, taskMeta);
  const finishAfterNodes = Array.isArray(finishAfter.nodes) ? finishAfter.nodes.length : -1;
  check(
    "a call that finishes anyway is completed",
    finishing.result?.resultType === "task"
      && finishAck.error === undefined
      && finishAck.result?.resultType === "complete"
      && finishAck.result.status === undefined
      && finishDone.result?.status === "completed"
      && JSON.stringify(finishDone.result.result) === JSON.stringify(finishWait.result)
      && toolBody(finishWait).status === "done"
      && finishAfterNodes === finishNodes + 1,
    JSON.stringify({ ack: finishAck.result ?? finishAck.error, task: finishDone.result, wait: finishWait.result, finishNodes, finishAfterNodes }).slice(0, 900),
  );

  const sliced = await callRaw(tasks, "slice_start", {}, taskMeta);
  check(
    "slice_start answers with a task",
    sliced.result?.resultType === "task" && typeof sliced.result.taskId === "string",
    JSON.stringify(sliced.result ?? sliced.error).slice(0, 400),
  );
  const sliceDone = await pollTask(tasks, sliced.result?.taskId ?? "", taskMeta);
  const sliceJob = nestedJob(sliceDone);
  const sliceWait = sliceJob ? await callRaw(tasks, "slice_wait", { job: sliceJob, timeoutS: 5 }, taskMeta) : {};
  check(
    "tasks/get of a slice equals the tools/call slice_wait result",
    sliceDone.result?.status === "completed" && JSON.stringify(sliceDone.result.result) === JSON.stringify(sliceWait.result) && toolBody(sliceWait).status === "done",
    JSON.stringify({ task: sliceDone.result?.result, wait: sliceWait.result }).slice(0, 600),
  );

  const missingId = tasks.id();
  tasks.send(rpc(missingId, "tasks/get", { taskId: "no-such-task", _meta: plainMeta }));
  const missingCap = await untilId(tasks, missingId);
  check(
    "tasks/get without the extension is -32021",
    missingCap.error?.code === -32021
      && missingCap.error.message === "Missing required client capability"
      && JSON.stringify(missingCap.error.data?.requiredCapabilities?.extensions?.[TASKS]) === "{}",
    JSON.stringify(missingCap.error),
  );
  const unknownId = tasks.id();
  tasks.send(rpc(unknownId, "tasks/get", { taskId: "no-such-task", _meta: taskMeta }));
  const unknown = await untilId(tasks, unknownId);
  check(
    "tasks/get of an unknown task is -32602",
    unknown.error?.code === -32602 && (unknown.error.message ?? "").includes("Task not found"),
    JSON.stringify(unknown.error),
  );
  const updateId = tasks.id();
  tasks.send(rpc(updateId, "tasks/update", { taskId: batch.result?.taskId, inputResponses: {}, _meta: taskMeta }));
  const updated = await untilId(tasks, updateId);
  check(
    "tasks/update acks empty when the task asks for nothing",
    updated.error === undefined && updated.result?.resultType === "complete" && updated.result.status === undefined,
    JSON.stringify(updated.result ?? updated.error),
  );
  const oldId = tasks.id();
  tasks.send(rpc(oldId, "tasks/result", { taskId: batch.result?.taskId, _meta: taskMeta }));
  const old = await untilId(tasks, oldId);
  check("tasks/result is not a method", old.error?.code === -32601, JSON.stringify(old.error));

  // The same batch, on a 2025-11-25 client and a 2026 client that does not list the extension.
  const legacyInit = legacy.id();
  legacy.send(rpc(legacyInit, "initialize", {
    protocolVersion: "2025-11-25",
    capabilities: { extensions: { [TASKS]: {} } },
    clientInfo: { name: "legacy", version: "0" },
  }));
  const legacyHello = await untilId(legacy, legacyInit);
  // Skills are declared on this revision too. This check is only that tasks are not.
  check(
    "a 2025-11-25 initialize does not advertise tasks",
    legacyHello.result?.capabilities?.extensions?.[TASKS] === undefined && legacyHello.result?.capabilities?.tools?.listChanged === true,
    JSON.stringify(legacyHello.result?.capabilities),
  );
  const legacyPart = await tool(legacy, "solid_new", { primitive: "box", dx: 20, dy: 20, dz: 20 });
  const legacyObject = String(legacyPart.object ?? "");
  const legacyBatch = await callRaw(legacy, "model_apply_batch", { object: legacyObject, ops: bosses(4) });
  const legacyBody = toolBody(legacyBatch);

  const plainPart = await tool(plain, "solid_new", { primitive: "box", dx: 20, dy: 20, dz: 20 }, plainMeta);
  const plainObject = String(plainPart.object ?? "");
  const plainBatch = await callRaw(plain, "model_apply_batch", { object: plainObject, ops: bosses(4) }, plainMeta);
  const plainBody = toolBody(plainBatch);
  check(
    "a 2026 client without the extension gets a job handle",
    plainBatch.result?.resultType === "complete" && plainBatch.result.taskId === undefined && plainBody.ok === true && plainBody.status === "running" && typeof plainBody.job === "string",
    JSON.stringify(plainBody).slice(0, 400),
  );
  check(
    "a 2025-11-25 client gets a job handle",
    legacyBatch.result?.resultType === "complete" && legacyBody.ok === true && legacyBody.status === "running" && typeof legacyBody.job === "string" && String(legacyBody.note).includes("slice_wait"),
    JSON.stringify(legacyBody).slice(0, 400),
  );
  check(
    "the 2025 and 2026-without replies are the same bytes, apart from the job id and seconds",
    canon(legacyBatch.result) === canon(plainBatch.result),
    JSON.stringify({ legacy: legacyBatch.result, plain: plainBatch.result }).slice(0, 1200),
  );

  const legacyHistory = await tool(legacy, "model_history", { object: legacyObject, limit: 100 });
  const legacyNodes = Array.isArray(legacyHistory.nodes) ? legacyHistory.nodes.length : -1;
  const legacyCancel = await tool(legacy, "slice_cancel", { job: String(legacyBody.job) });
  let legacyOutcome = legacyCancel;
  for (let round = 0; (legacyOutcome.status === "cancelling" || legacyOutcome.status === "running") && round < 8; round += 1) {
    legacyOutcome = await tool(legacy, "slice_wait", { job: String(legacyBody.job), timeoutS: 5 });
  }
  const legacyAfter = await tool(legacy, "model_history", { object: legacyObject, limit: 100 });
  check(
    "slice_cancel takes the same batch back",
    legacyOutcome.cancelled === true && legacyOutcome.rolledBack === true && Array.isArray(legacyAfter.nodes) && legacyAfter.nodes.length === legacyNodes,
    JSON.stringify(legacyOutcome).slice(0, 400),
  );
  check(
    "the cancelled task's message is what slice_cancel reports",
    cancelDone.result?.status === "cancelled" && cancelDone.result.statusMessage === legacyOutcome.reason,
    JSON.stringify({ message: cancelDone.result?.statusMessage, reason: legacyOutcome.reason }),
  );

  // Spec: the extension does not exist on 2025-11-25, even if the client lists it.
  const dated = await callRaw(legacy, "model_apply_batch", {
    object: legacyObject,
    ops: bosses(4),
  }, meta(true, "2025-11-25"));
  const datedBody = toolBody(dated);
  check(
    "a 2025-11-25 client that lists the extension still gets a job",
    dated.result?.resultType === "complete" && dated.result.taskId === undefined && datedBody.status === "running" && typeof datedBody.job === "string",
    JSON.stringify(dated.result ?? datedBody).slice(0, 400),
  );
  await tool(legacy, "slice_cancel", { job: String(datedBody.job) });
} finally {
  tasks.child.kill();
  legacy.child.kill();
  plain.child.kill();
}

const dropped = startRaw({ LIME_MCP_FAKE_MODEL_MS: "300", LIME_MCP_REPLY_S: "30" });
try {
  const made = await tool(dropped, "solid_new", { primitive: "box", dx: 20, dy: 20, dz: 20 }, taskMeta);
  const id = dropped.id();
  dropped.send(rpc(id, "tools/call", {
    name: "model_apply_batch",
    arguments: { object: made.object, ops: bosses(4) },
    _meta: taskMeta,
  }));
  dropped.send(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } })}\n`);
  const row = await untilId(dropped, id);
  check(
    "a call the client cancels mid-run answers with a task",
    row.result?.resultType === "task" && row.result.status === "working" && typeof row.result.taskId === "string",
    JSON.stringify(row.result ?? row.error).slice(0, 400),
  );
} finally {
  dropped.child.kill();
}

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("protocol tasks: ok");
