/**
 * MCP 2026-07-28, M0 and M1, over stdio.
 * One process speaks the old initialize handshake and the 2026 per-request form.
 * Each bullet of the milestone is its own check.
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { DISCOVERY_INSTRUCTIONS } from "./protocol.ts";
import { listedTools } from "./schema.ts";
import { appVersion } from "./version.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const server = fileURLToPath(new URL("./server.ts", import.meta.url));

/** A day. Static lists do not change until the next release of this process. */
const LIST_TTL_MS = 86_400_000;
const DISCOVERY_ORDER = listedTools(new Set()).map((tool) => tool.name);
const SUPPORTED = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25", "2026-07-28"];

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

const tokens = (text: string) => Math.ceil(Buffer.byteLength(text) / 4);

function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  env.LIME_MCP_FAKE = "1";
  env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-mcp-2026-"));
  return { ...env, ...extra };
}

function startRaw(extra: Record<string, string> = {}) {
  const child = spawn(process.execPath, ["--experimental-strip-types", server], {
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
  return {
    child,
    stderr: () => stderr,
    send(text: string) {
      child.stdin.write(text);
    },
    next,
  };
}

type RawClient = ReturnType<typeof startRaw>;

interface RpcError {
  code?: number;
  message?: string;
  data?: { supported?: string[]; requested?: string };
}

interface Row {
  id?: number | null;
  method?: string;
  result?: {
    protocolVersion?: string;
    resultType?: string;
    ttlMs?: number;
    cacheScope?: string;
    supportedVersions?: string[];
    capabilities?: { tools?: { listChanged?: boolean } };
    serverInfo?: { name?: string; version?: string };
    instructions?: string;
    tools?: { name: string }[];
    content?: { type?: string; text?: string }[];
    isError?: boolean;
    prompts?: unknown[];
    resources?: unknown[];
    contents?: { text?: string }[];
    _meta?: Record<string, unknown>;
  };
  error?: RpcError;
}

function rpc(id: number, method: string, params?: Record<string, unknown>): string {
  const message: Record<string, unknown> = { jsonrpc: "2.0", id, method };
  if (params) message.params = params;
  return `${JSON.stringify(message)}\n`;
}

function modernMeta(info: { name: string; version: string }, capabilities: Record<string, unknown>): Record<string, unknown> {
  return {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": info,
    "io.modelcontextprotocol/clientCapabilities": capabilities,
  };
}

async function untilId(io: RawClient, id: number): Promise<{ row: Row; notes: string[] }> {
  const notes: string[] = [];
  for (;;) {
    const row = JSON.parse(await io.next()) as Row;
    if (typeof row.method === "string") notes.push(row.method);
    if (row.id === id) return { row, notes };
  }
}

function clientLogs(stderr: string): string[] {
  return stderr.split("\n").filter((line) => line.includes("lime-slice mcp: protocolVersion="));
}

function serverInfoOf(result: Row["result"]): { name?: string; version?: string } | null {
  const meta = result?._meta?.["io.modelcontextprotocol/serverInfo"];
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  return meta as { name?: string; version?: string };
}

function hasListCache(result: Row["result"]): boolean {
  return result?.ttlMs === LIST_TTL_MS && result.cacheScope === "public" && result.resultType === "complete";
}

const dual = startRaw({ LIME_MCP_TOOLS: "core" });
try {
  dual.send(rpc(1, "initialize", {
    protocolVersion: "2025-11-25",
    capabilities: { roots: { listChanged: true } },
    clientInfo: { name: "legacy-test", version: "1.2.3" },
  }));
  const init = (await untilId(dual, 1)).row;
  check(
    "initialize accepts 2025-11-25 and echoes it",
    init.result?.protocolVersion === "2025-11-25",
    JSON.stringify(init.result?.protocolVersion ?? init.error),
  );
  check(
    "initialize still answers a client that sends it",
    init.result?.serverInfo?.name === "lime-slice" && init.result.serverInfo.version === appVersion() && (init.result.instructions ?? "").includes("guide"),
    JSON.stringify(init.error ?? init.result?.serverInfo),
  );
  check(
    "an older client keeps tool groups: initialize offers listChanged",
    init.result?.capabilities?.tools?.listChanged === true,
    JSON.stringify(init.result?.capabilities),
  );
  check("initialize resultType is complete", init.result?.resultType === "complete", JSON.stringify(init.result?.resultType));
  const initInfo = serverInfoOf(init.result);
  check(
    "initialize puts serverInfo in the result _meta",
    initInfo?.name === "lime-slice" && initInfo.version === appVersion(),
    JSON.stringify(init.result?._meta),
  );
  const logged = clientLogs(dual.stderr());
  check(
    "the process logs the initialize protocolVersion and clientInfo once",
    logged.length === 1 && logged[0]!.includes("protocolVersion=2025-11-25") && logged[0]!.includes("\"name\":\"legacy-test\"") && logged[0]!.includes("\"version\":\"1.2.3\""),
    logged.join(" | ") || dual.stderr().slice(0, 500),
  );

  dual.send(rpc(2, "ping"));
  const ping = (await untilId(dual, 2)).row;
  check("ping still answers a client that sends it", ping.result !== undefined && ping.error === undefined, JSON.stringify(ping));
  check("ping resultType is complete", ping.result?.resultType === "complete", JSON.stringify(ping.result));

  dual.send(rpc(3, "tools/list"));
  const legacyList = (await untilId(dual, 3)).row;
  const legacyNames = legacyList.result?.tools?.map((tool) => tool.name) ?? [];
  check(
    "an older client keeps tool groups: tools/list is the core set",
    legacyNames.includes("tools_enable") && legacyNames.includes("mesh_import") && !legacyNames.includes("model_apply"),
    legacyNames.join(","),
  );
  check("tools/list resultType, ttlMs and cacheScope are set on the legacy list", hasListCache(legacyList.result), JSON.stringify({
    resultType: legacyList.result?.resultType,
    ttlMs: legacyList.result?.ttlMs,
    cacheScope: legacyList.result?.cacheScope,
  }));
  dual.send(rpc(4, "tools/list"));
  const legacyAgain = (await untilId(dual, 4)).row;
  const legacyAgainNames = legacyAgain.result?.tools?.map((tool) => tool.name) ?? [];
  check("tools/list order is stable across two calls", JSON.stringify(legacyNames) === JSON.stringify(legacyAgainNames) && legacyNames.length > 4, legacyNames.join(","));

  dual.send(rpc(5, "tools/call", { name: "tools_enable", arguments: { groups: ["paint"] } }));
  const enabled = await untilId(dual, 5);
  check(
    "an older client keeps tool groups: tools_enable sends list_changed",
    enabled.notes.includes("notifications/tools/list_changed"),
    enabled.notes.join(",") || "no notification",
  );

  const modern = modernMeta({ name: "modern-test", version: "9" }, { roots: {} });
  dual.send(rpc(6, "tools/list", { _meta: modern }));
  const modernList = (await untilId(dual, 6)).row;
  const modernNames = modernList.result?.tools?.map((tool) => tool.name) ?? [];
  check(
    "a 2026 client gets the discovery tools only, in the stable list order",
    JSON.stringify(modernNames) === JSON.stringify(DISCOVERY_ORDER) && JSON.stringify([...DISCOVERY_ORDER].sort()) === JSON.stringify(["call", "guide", "plan_run", "session_info"]),
    modernNames.join(","),
  );
  check("a 2026 tools/list carries resultType, a long public ttl, and serverInfo", hasListCache(modernList.result) && serverInfoOf(modernList.result)?.version === appVersion(), JSON.stringify({
    resultType: modernList.result?.resultType,
    ttlMs: modernList.result?.ttlMs,
    cacheScope: modernList.result?.cacheScope,
    meta: modernList.result?._meta,
  }));
  const firstContact = tokens(DISCOVERY_INSTRUCTIONS) + tokens(JSON.stringify({ tools: modernList.result?.tools }));
  const wireContact = tokens(DISCOVERY_INSTRUCTIONS) + tokens(JSON.stringify(modernList.result));
  console.log(`first contact: instructions + tools ~${firstContact} tokens; with the 2026 list envelope ~${wireContact}`);
  check(`first contact stays within 1500 tokens (it is ~${firstContact})`, firstContact <= 1500);

  dual.send(rpc(7, "tools/list", { _meta: modern }));
  const modernAgain = (await untilId(dual, 7)).row;
  check(
    "a second 2026 tools/list is the same order",
    JSON.stringify(modernAgain.result?.tools?.map((tool) => tool.name)) === JSON.stringify(modernNames),
    (modernAgain.result?.tools ?? []).map((tool) => tool.name).join(","),
  );

  dual.send(rpc(8, "tools/call", {
    name: "tools_enable",
    arguments: { groups: ["stress"] },
    _meta: modern,
  }));
  const hidden = await untilId(dual, 8);
  const hiddenText = hidden.row.result?.content?.[0]?.text ?? "";
  check(
    "a 2026 client gets no list_changed when a group would open",
    !hidden.notes.includes("notifications/tools/list_changed") && hiddenText.includes("stress"),
    `${hidden.notes.join(",")} ${hiddenText.slice(0, 240)}`,
  );
  check("a 2026 tool reply keeps the tool's own JSON and resultType on the envelope", (() => {
    const body = JSON.parse(hiddenText) as Record<string, unknown>;
    return hidden.row.result?.resultType === "complete" && hidden.row.result.isError !== true && !("resultType" in body);
  })(), hiddenText.slice(0, 240));

  dual.send(rpc(9, "tools/list", { _meta: modern }));
  const still = (await untilId(dual, 9)).row;
  check(
    "opening a group does not change the 2026 tools/list",
    JSON.stringify(still.result?.tools?.map((tool) => tool.name)) === JSON.stringify(DISCOVERY_ORDER),
    (still.result?.tools ?? []).map((tool) => tool.name).join(","),
  );

  dual.send(rpc(10, "server/discover", { _meta: modern }));
  const discovered = (await untilId(dual, 10)).row;
  const discoverInfo = serverInfoOf(discovered.result);
  check(
    "server/discover returns the supported versions, capabilities, and serverInfo",
    JSON.stringify(discovered.result?.supportedVersions) === JSON.stringify(SUPPORTED)
      && discovered.result?.capabilities?.tools?.listChanged !== true
      && discoverInfo?.name === "lime-slice"
      && discoverInfo.version === appVersion(),
    JSON.stringify(discovered.result ?? discovered.error).slice(0, 500),
  );
  check("server/discover resultType is complete, with a long public ttl", hasListCache(discovered.result), JSON.stringify({
    resultType: discovered.result?.resultType,
    ttlMs: discovered.result?.ttlMs,
    cacheScope: discovered.result?.cacheScope,
  }));

  dual.send(rpc(11, "prompts/list", { _meta: modern }));
  const prompts = (await untilId(dual, 11)).row;
  check("prompts/list carries resultType and a long public ttl", hasListCache(prompts.result) && (prompts.result?.prompts?.length ?? 0) > 0, JSON.stringify({
    resultType: prompts.result?.resultType,
    ttlMs: prompts.result?.ttlMs,
    n: prompts.result?.prompts?.length,
  }));

  dual.send(rpc(12, "resources/list", { _meta: modern }));
  const resources = (await untilId(dual, 12)).row;
  check("resources/list carries resultType and a long public ttl", hasListCache(resources.result) && (resources.result?.resources?.length ?? 0) > 0, JSON.stringify({
    resultType: resources.result?.resultType,
    ttlMs: resources.result?.ttlMs,
    n: resources.result?.resources?.length,
  }));

  dual.send(rpc(13, "resources/read", { uri: "lime://session", _meta: modern }));
  const read = (await untilId(dual, 13)).row;
  check(
    "resources/read carries resultType, ttlMs 0 and cacheScope private",
    read.result?.resultType === "complete" && read.result.ttlMs === 0 && read.result.cacheScope === "private" && (read.result.contents?.[0]?.text ?? "").includes("workspace"),
    JSON.stringify({ resultType: read.result?.resultType, ttlMs: read.result?.ttlMs, cacheScope: read.result?.cacheScope }),
  );

  dual.send(rpc(14, "resources/read", { uri: "lime://no-such", _meta: modern }));
  const missing = (await untilId(dual, 14)).row;
  check(
    "an unknown resource answers -32602",
    missing.error?.code === -32602 && (missing.error.message ?? "").includes("not on this server"),
    JSON.stringify(missing.error),
  );

  dual.send(rpc(15, "prompts/get", { name: "hole-on-face", arguments: { object: "obj_1" }, _meta: modern }));
  const prompt = (await untilId(dual, 15)).row;
  check("prompts/get resultType is complete", prompt.result?.resultType === "complete" && serverInfoOf(prompt.result)?.name === "lime-slice", JSON.stringify(prompt.error ?? prompt.result?.resultType));

  dual.send(rpc(16, "tools/list", {
    _meta: { "io.modelcontextprotocol/protocolVersion": "1900-01-01" },
  }));
  const badMeta = (await untilId(dual, 16)).row;
  check(
    "an unknown per-request version answers -32022 Unsupported protocol version",
    badMeta.error?.code === -32022
      && badMeta.error.message === "Unsupported protocol version"
      && badMeta.error.data?.requested === "1900-01-01"
      && JSON.stringify(badMeta.error.data?.supported) === JSON.stringify(SUPPORTED)
      && badMeta.result === undefined,
    JSON.stringify(badMeta.error ?? badMeta.result),
  );

  dual.send(rpc(17, "initialize", { protocolVersion: "1900-01-01", capabilities: {}, clientInfo: { name: "nope", version: "0" } }));
  const badInit = (await untilId(dual, 17)).row;
  check(
    "an unknown initialize version answers -32022 instead of 2024-11-05",
    badInit.error?.code === -32022 && badInit.error.message === "Unsupported protocol version" && badInit.result?.protocolVersion !== "2024-11-05",
    JSON.stringify(badInit.error ?? badInit.result),
  );

  for (const version of ["2024-11-05", "2025-03-26", "2025-06-18", "2026-07-28"]) {
    const id = 30 + SUPPORTED.indexOf(version);
    dual.send(rpc(id, "initialize", { protocolVersion: version, capabilities: {}, clientInfo: { name: "echo", version: "0" } }));
    const echoed = (await untilId(dual, id)).row;
    check(`initialize echoes ${version}`, echoed.result?.protocolVersion === version, JSON.stringify(echoed.error ?? echoed.result?.protocolVersion));
  }
  dual.send(rpc(40, "initialize", { capabilities: {}, clientInfo: { name: "omitted", version: "0" } }));
  const omitted = (await untilId(dual, 40)).row;
  check(
    "initialize with no protocolVersion still answers 2024-11-05",
    omitted.result?.protocolVersion === "2024-11-05",
    JSON.stringify(omitted.error ?? omitted.result?.protocolVersion),
  );

  const after = clientLogs(dual.stderr());
  check("the client log stays one line for the process", after.length === 1, after.join(" | "));
} finally {
  dual.child.kill();
}

const modernOnly = startRaw();
try {
  const info = { name: "cursor-probe", version: "0.0.1" };
  const capabilities = { roots: { listChanged: true } };
  modernOnly.send(rpc(1, "tools/list", { _meta: modernMeta(info, capabilities) }));
  const listed = (await untilId(modernOnly, 1)).row;
  check(
    "a 2026 client that never calls initialize still gets the discovery list",
    JSON.stringify(listed.result?.tools?.map((tool) => tool.name)) === JSON.stringify(DISCOVERY_ORDER),
    (listed.result?.tools ?? []).map((tool) => tool.name).join(","),
  );
  const lines = clientLogs(modernOnly.stderr());
  check(
    "the process logs protocolVersion and clientInfo from the request _meta",
    lines.length === 1
      && lines[0]!.includes("protocolVersion=2026-07-28")
      && lines[0]!.includes(JSON.stringify(info))
      && lines[0]!.includes(JSON.stringify(capabilities)),
    lines.join(" | ") || modernOnly.stderr().slice(0, 500),
  );
  modernOnly.send(rpc(2, "ping", { _meta: modernMeta({ name: "other", version: "9" }, {}) }));
  const again = (await untilId(modernOnly, 2)).row;
  check("ping works with no initialize", again.result?.resultType === "complete" && again.error === undefined, JSON.stringify(again));
  check("a second request does not log the client again", clientLogs(modernOnly.stderr()).length === 1, clientLogs(modernOnly.stderr()).join(" | "));
} finally {
  modernOnly.child.kill();
}

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("protocol 2026: ok");
