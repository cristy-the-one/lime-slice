/**
 * The in-process addon loads, and session_info reports its version.
 * The source checks run everywhere. The load runs when the library exists.
 * A job that has not built the addon skips the load and exits 0. Jobs that
 * build it (the MCP server jobs) still run the load, and a failed load fails
 * the job.
 */
import { spawnSync } from "node:child_process";
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
  check("the loaded addon reports engine 2.8.0", version === "2.8.0", String(version));

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
  check("session_info on the real addon returns engine 2.8.0", body.ok === true && body.engine === "2.8.0", text);
  await client.close();

  // A native call cannot be interrupted inside a thread. The engine's preview
  // sleeps natively for a minute here; the 1 s budget must stop it, and the
  // process must still exit at once instead of waiting for the sleep.
  const stuckScript = `
    import { pathToFileURL } from "node:url";
    const { loadEngineWorker } = await import(pathToFileURL(${JSON.stringify(fileURLToPath(new URL("./engine.ts", import.meta.url)))}).href);
    const { Session } = await import(pathToFileURL(${JSON.stringify(fileURLToPath(new URL("./session.ts", import.meta.url)))}).href);
    const session = new Session(loadEngineWorker(${JSON.stringify(root)}));
    const reply = await session.call("mesh_import", { path: ${JSON.stringify(fileURLToPath(new URL("../samples/calibration_cube_20mm.stl", import.meta.url)))} });
    console.log(JSON.stringify(reply));
    process.exit(0);
  `;
  const began = Date.now();
  const stuck = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--input-type=module", "-e", stuckScript], {
    cwd: root,
    env: { ...env, LIME_MCP_PREVIEW_DELAY_MS: "60000", LIME_MCP_MODEL_TIMEOUT_S: "1" },
    encoding: "utf8",
    timeout: 30000,
  });
  const stuckSeconds = (Date.now() - began) / 1000;
  check(
    "a stuck native preview is stopped and the process still exits",
    stuck.status === 0 && stuck.stdout.includes("did not finish") && stuckSeconds < 15,
    JSON.stringify({ status: stuck.status, signal: stuck.signal, stuckSeconds, stdout: stuck.stdout.slice(0, 300), stderr: stuck.stderr.slice(0, 300) }),
  );
}

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("native load ok");
