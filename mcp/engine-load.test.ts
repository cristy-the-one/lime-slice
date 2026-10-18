/**
 * Finding 1 of the 2.6.1 session: an engine that was not found stayed not found until the client reconnected, and
 * the message only said to build it. These run without a built engine.
 */
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { bundledVersion, engineCandidates, engineNotFound, installedMcpDir, installedVersionRefusal, loadEngineWorker } from "./engine.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`ok ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

check(
  "the Windows install folder is under LOCALAPPDATA",
  installedMcpDir("win32", { LOCALAPPDATA: "C:\\Users\\you\\AppData\\Local" }) === join("C:\\Users\\you\\AppData\\Local", "Lime Slice", "mcp"),
  String(installedMcpDir("win32", { LOCALAPPDATA: "C:\\Users\\you\\AppData\\Local" })),
);
check("no LOCALAPPDATA means no Windows install folder", installedMcpDir("win32", {}) === null);

const message = engineNotFound(["a.dll", "b.dll"], "win32");
check("the not-found message lists where it looked", message.includes("Looked in: a.dll, b.dll."), message);
check("the not-found message names the installed server on Windows", message.includes("%LOCALAPPDATA%\\Lime Slice\\mcp\\server.mjs"), message);
check("the not-found message names the build and LIME_MCP_ENGINE", message.includes("cargo build -p lime-mcp-engine --release") && message.includes("LIME_MCP_ENGINE"), message);

check("an installed engine of the same version is used", installedVersionRefusal("x.dll", "2.6.1", "2.6.1") === null);
check(
  "an installed engine of another version is refused with both versions",
  installedVersionRefusal("x.dll", "2.6.0", "2.6.1") === "The installed engine at x.dll is 2.6.0, but this server is 2.6.1. Build the engine from this checkout with cargo build -p lime-mcp-engine --release, or point the MCP client at the installed server.mjs.",
);

// The installed server names its release; it is read before the engine beside it is loaded.
{
  const dir = mkdtempSync(join(tmpdir(), "lime-bundled-"));
  writeFileSync(join(dir, "server.mjs"), 'import x from "y";\nfunction appVersion() {\n  if (true) return "9.9.9";\n  const pkg = 1;\n}\n');
  check("the bundle's release is read from its text", bundledVersion(dir) === "9.9.9", String(bundledVersion(dir)));
  check("a folder without a bundle has no release", bundledVersion(tmpdir()) === null);
  if (process.env.LIME_TEST_BUNDLE_DIR) check("the real bundle names its release", bundledVersion(process.env.LIME_TEST_BUNDLE_DIR) === "2.8.0", String(bundledVersion(process.env.LIME_TEST_BUNDLE_DIR)));
}

// A missing engine fails the call; the next call loads again and sees a library set since.
const dir = mkdtempSync(join(tmpdir(), "lime-engine-load-"));
const first = join(dir, "first.dll");
const second = join(dir, "second.dll");
process.env.LIME_MCP_ENGINE = first;
const root = fileURLToPath(new URL("..", import.meta.url));
check("LIME_MCP_ENGINE is the only candidate", engineCandidates(root).length === 1 && engineCandidates(root)[0] === first);
const engine = loadEngineWorker(root);
const reason = async () => {
  try {
    await engine.version();
    return "answered";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
};
const one = await reason();
check("the first call fails with the not-found message", one.startsWith("The Lime Slice engine") && one.includes(first), one);
process.env.LIME_MCP_ENGINE = second;
const two = await reason();
check("the next call tries again instead of repeating the cached failure", two.includes(second) && !two.includes(first), two);

// With a real engine on this machine, the third call answers.
const real = [process.env.LIME_TEST_REAL_ENGINE ?? "", join(root, "target", "release", "lime_mcp_engine.dll"), join(root, "target", "release", "liblime_mcp_engine.so"), join(root, "target", "release", "liblime_mcp_engine.dylib")].find((path) => existsSync(path));
if (real) {
  process.env.LIME_MCP_ENGINE = real;
  const three = await reason();
  check("after the engine appears, a call answers without a reconnect", three === "answered", three);
} else {
  console.log("skip: no built engine for the recovery check");
}

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("engine-load: ok");
process.exit(0);
