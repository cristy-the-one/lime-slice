/**
 * The in-process addon loads, and session_info reports its version.
 * The source checks run everywhere. The load runs when the library exists.
 * A job that has not built the addon skips the load and exits 0. Jobs that
 * build it (the MCP server jobs) still run the load, and a failed load fails
 * the job.
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { engineCandidates, loadNativeEngine } from "./engine.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const server = fileURLToPath(new URL("./server.ts", import.meta.url));

let failed = 0;
function toolText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  for (const row of content) {
    if (!row || typeof row !== "object") continue;
    const item = row as { type?: unknown; text?: unknown };
    if (item.type === "text" && typeof item.text === "string") return item.text;
  }
  return "";
}

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

const buildRs = readFileSync(new URL("../crates/lime-mcp-engine/build.rs", import.meta.url), "utf8");
const libRs = readFileSync(new URL("../crates/lime-mcp-engine/src/lib.rs", import.meta.url), "utf8");
check("the Windows build does not leave napi imports unresolved", !buildRs.includes("FORCE:UNRESOLVED"));
check("Windows resolves napi from the process that loads the addon", libRs.includes("GetModuleHandleW") && libRs.includes("GetProcAddress"));

const built = engineCandidates(root).some((path) => existsSync(path));
if (!built) {
  console.log("native load: skipped (engine addon is not built)");
} else {
  const engine = loadNativeEngine(root);
  const version = await engine.version();
  check("the loaded addon reports engine 1.8.0", version === "1.8.0", String(version));

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string" && key !== "LIME_MCP_FAKE") env[key] = value;
  }
  env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-mcp-native-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--experimental-strip-types", server],
    cwd: root,
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "lime-mcp-native", version: "0.0.0" });
  await client.connect(transport);
  const info = await client.callTool({ name: "session_info", arguments: {} });
  const text = toolText(info.content);
  const body = JSON.parse(text) as { ok?: boolean; engine?: string };
  check("session_info on the real addon returns engine 1.8.0", body.ok === true && body.engine === "1.8.0", text);
  await client.close();
}

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("native load ok");
