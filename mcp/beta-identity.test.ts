import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

if (process.platform === "win32") {
  const root = mkdtempSync(join(tmpdir(), "lime-beta-install-"));
  const bundled = join(root, "mcp");
  mkdirSync(bundled);
  const entry = join(bundled, "app-open.mjs");
  await build({ entryPoints: ["mcp/app-open.ts"], outfile: entry, bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent" });
  writeFileSync(join(bundled, "tandem-beta.identity"), "");
  const { installedApp } = await import(pathToFileURL(entry).href) as { installedApp: () => string | null };
  assert.equal(installedApp(), null, "a beta must not fall back to a stable install");
  const betaExe = join(root, "lime-slice-tandem-beta.exe");
  writeFileSync(betaExe, "test placeholder; never executed");
  assert.equal(installedApp(), betaExe, "the bundled beta finds its own executable");
  console.log("beta identity: bundled MCP selects its own app and never falls back to stable");
} else {
  console.log("beta identity: Windows executable lookup skipped on this platform");
}
