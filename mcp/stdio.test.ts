/**
 * A real MCP client against mcp/server.ts.
 * Newline-delimited JSON, a parse error that leaves the process up,
 * progress, a short slice_wait, and cancel.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { engineCandidates } from "./engine.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
// LIME_MCP_SERVER runs the same checks against another server file, such as the installer's bundle.
const server = process.env.LIME_MCP_SERVER || fileURLToPath(new URL("./server.ts", import.meta.url));
const serverArgs = server.endsWith(".mjs") ? [server] : ["--experimental-strip-types", server];
const cube = fileURLToPath(new URL("../samples/calibration_cube_20mm.stl", import.meta.url));

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

function toolText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  for (const row of content) {
    if (!row || typeof row !== "object") continue;
    const item = row as { type?: unknown; text?: unknown };
    if (item.type === "text" && typeof item.text === "string") return item.text;
  }
  return "";
}

function childEnv(extra: Record<string, string>, fake = true): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  if (fake) env.LIME_MCP_FAKE = "1";
  else delete env.LIME_MCP_FAKE;
  env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-mcp-stdio-"));
  return { ...env, ...extra };
}

function startRaw(extra: Record<string, string> = {}, fake = true) {
  const child = spawn(process.execPath, serverArgs, {
    cwd: root,
    env: childEnv(extra, fake),
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
  const next = (ms = 4000) => new Promise<string>((resolve, reject) => {
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
  return {
    child,
    stderr: () => stderr,
    send(text: string) {
      child.stdin.write(text);
    },
    next,
  };
}

const sdk = new StdioClientTransport({
  command: process.execPath,
  args: serverArgs,
  cwd: root,
  env: childEnv({ LIME_MCP_POLLS_UNTIL_DONE: "100000" }),
  stderr: "pipe",
});
const client = new Client({ name: "lime-mcp-test", version: "0.0.0" });
await client.connect(sdk);
const listed = await client.listTools();
check("the SDK client lists tools", listed.tools.length >= 30, String(listed.tools.length));
check("every tool has annotations", listed.tools.every((tool) => tool.annotations && typeof tool.annotations.readOnlyHint === "boolean"));
check("initialize carries instructions", (client.getInstructions() ?? "").includes("faces_find") && (client.getInstructions() ?? "").includes("slice_wait"));
const info = await client.callTool({ name: "session_info", arguments: {} });
const infoText = toolText(info.content);
const infoBody = JSON.parse(infoText) as { ok?: boolean; engine?: string };
check("tools/call session_info answers", infoBody.ok === true && infoBody.engine === "2.5.1", infoText);
const prompt = await client.getPrompt({ name: "hole-on-face", arguments: { object: "obj_1" } });
const promptText = prompt.messages.map((message) => message.content.type === "text" ? message.content.text : "").join("\n");
const steps = ["faces_find", "workplane_set", "model_probe", "model_apply"];
let at = -1;
let ordered = true;
for (const step of steps) {
  const nextAt = promptText.indexOf(step);
  if (nextAt <= at) ordered = false;
  at = nextAt;
}
check("hole-on-face names faces_find, workplane, probe, apply in order", ordered, promptText);

const imported = JSON.parse(toolText((await client.callTool({ name: "mesh_import", arguments: { path: cube } })).content) || "{}") as { ok?: boolean };
check("the SDK client imports a mesh", imported.ok === true);
await client.callTool({ name: "machine_select", arguments: { printerId: "lime-220", filamentId: "lime-pla" } });
const started = JSON.parse(toolText((await client.callTool({ name: "slice_start", arguments: {} })).content) || "{}") as { job?: string };
let sawProgress = false;
const waitedText = toolText((await client.callTool(
  { name: "slice_wait", arguments: { job: started.job, timeoutS: 0.35 } },
  undefined,
  { onprogress: () => { sawProgress = true; }, timeout: 5000 },
)).content) || "{}";
const waited = JSON.parse(waitedText) as { status?: string; fraction?: number };
check("a long slice_wait returns running before the client timeout", waited.status === "running" && typeof waited.fraction === "number", waitedText);
check("a progress token produces a progress notification", sawProgress);
await client.close();

const cancelled = startRaw({ LIME_MCP_POLLS_UNTIL_DONE: "100000" });
const call = async (id: number, name: string, args: Record<string, unknown>) => {
  cancelled.send(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
  const line = await cancelled.next();
  return JSON.parse(line) as { id?: number; result?: { content?: { text?: string }[] } };
};
await call(1, "mesh_import", { path: cube });
await call(2, "machine_select", { printerId: "lime-220", filamentId: "lime-pla" });
const startedJob = JSON.parse(String((await call(3, "slice_start", {})).result?.content?.[0]?.text ?? "{}")) as { job?: string };
const waitSent = Date.now();
cancelled.send(`${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "slice_wait", arguments: { job: startedJob.job, timeoutS: 30 } } })}\n`);
cancelled.send(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 4 } })}\n`);
let cancelBody = "";
const cancelDeadline = Date.now() + 1000;
while (Date.now() < cancelDeadline && !cancelBody) {
  const row = JSON.parse(await cancelled.next(1000)) as { id?: number; result?: { content?: { text?: string }[] } };
  if (row.id === 4) cancelBody = row.result?.content?.[0]?.text ?? "";
}
const cancelParsed = cancelBody ? JSON.parse(cancelBody) as { status?: string } : {};
check("cancelling slice_wait stops the wait", cancelParsed.status === "cancelled" && Date.now() - waitSent < 1000, cancelBody || "no reply");
cancelled.child.kill();

const paired = startRaw();
paired.send('{"jsonrpc":"2.0","id":1,"method":"ping"}\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n');
const first = JSON.parse(await paired.next()) as { id?: number; result?: unknown };
const second = JSON.parse(await paired.next()) as { id?: number; result?: unknown };
const ids = [first.id, second.id].sort();
check("two requests in one write get two replies", ids[0] === 1 && ids[1] === 2 && first.result !== undefined && second.result !== undefined, JSON.stringify([first, second]));
check("replies are one JSON value per line", !JSON.stringify(first).includes("Content-Length"));
paired.child.kill();

const broken = startRaw();
broken.send('{"jsonrpc":"2.0","id":1,\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n');
const parseError = JSON.parse(await broken.next()) as { id?: unknown; error?: { code?: number } };
const ping = JSON.parse(await broken.next()) as { id?: number; result?: unknown };
check("a malformed line is a parse error", parseError.id === null && parseError.error?.code === -32700, JSON.stringify(parseError));
check("a ping after a malformed line is answered", ping.id === 2 && ping.result !== undefined, JSON.stringify(ping));
check("the process is still alive", broken.child.exitCode === null);
broken.child.kill();

const slow = startRaw({ LIME_MCP_FAKE_BLOCK_MS: "400" });
slow.send('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}\n');
await slow.next();
const importLine = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "mesh_import", arguments: { path: cube } } });
const pingLine = JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" });
const sentAt = Date.now();
slow.send(`${importLine}\n${pingLine}\n`);
let pingAt = 0;
let sawPing = false;
for (let i = 0; i < 2; i += 1) {
  const row = JSON.parse(await slow.next(2000)) as { id?: number };
  if (row.id === 3) {
    sawPing = true;
    pingAt = Date.now() - sentAt;
    break;
  }
}
check("ping answers during a slow import", sawPing && pingAt < 100, `${pingAt} ms`);
slow.child.kill();

if (engineCandidates(root).some((path) => existsSync(path))) {
  const native = startRaw({ LIME_MCP_PREVIEW_DELAY_MS: "400" }, false);
  native.send('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}\n');
  await native.next(15000);
  const nativeImport = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "mesh_import", arguments: { path: cube } } });
  const nativePing = JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" });
  const nativeSent = Date.now();
  native.send(`${nativeImport}\n${nativePing}\n`);
  let nativePingAt = 0;
  let sawNativePing = false;
  for (let i = 0; i < 2; i += 1) {
    const row = JSON.parse(await native.next(2000)) as { id?: number };
    if (row.id === 3) {
      sawNativePing = true;
      nativePingAt = Date.now() - nativeSent;
      break;
    }
  }
  check("ping answers during a delayed native preview", sawNativePing && nativePingAt < 100, `${nativePingAt} ms ${native.stderr()}`);
  native.child.kill();
} else {
  console.log("native preview delay: skipped (engine addon is not built)");
}

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("stdio: ok");
