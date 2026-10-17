/**
 * Finding 2 of the 2.6.1 back-cover session: a long model_apply_batch hit the client's 60 s request timeout, the client
 * restarted the server, and the plate was gone. Against a slow stand-in kernel and the MCP SDK's own client:
 * progress keeps a client that restarts its timeout waiting; a cancelled batch is taken back whole; and a server
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

async function connect(): Promise<{ client: Client; call: (name: string, args: unknown) => Promise<Record<string, unknown>> }> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (typeof value === "string") env[key] = value;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: serverArgs,
    cwd: root,
    env: { ...env, LIME_MCP_FAKE: "1", LIME_MCP_WORKSPACE: workspace, LIME_MCP_FAKE_MODEL_MS: "150", LIME_MCP_HEARTBEAT_MS: "100" },
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

// A client that does not reset its timeout gives up and cancels: the batch is taken back whole.
let timedOut = false;
try {
  await first.client.callTool({ name: "model_apply_batch", arguments: { object, ops: bosses(8) } }, undefined, { timeout: 700 });
} catch {
  timedOut = true;
}
check("a client without progress resets times out", timedOut);
// The server takes the batch back once the step in flight ends: wait for the history to settle, up to 10 s.
let afterCancel = await first.call("model_history", { object, limit: 100 });
for (let waited = 0; (afterCancel.nodes as unknown[]).length !== kept && waited < 10_000; waited += 200) {
  await new Promise((resolve) => setTimeout(resolve, 200));
  afterCancel = await first.call("model_history", { object, limit: 100 });
}
check("the cancelled batch left no steps behind", (afterCancel.nodes as unknown[]).length === kept, JSON.stringify(afterCancel));
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
check("the autosave opens with the whole history", reopened.ok === true && Array.isArray(back.nodes) && (back.nodes as unknown[]).length === kept, JSON.stringify({ reopened, back }));
await second.client.close();

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("long-call: ok");
process.exit(0);
