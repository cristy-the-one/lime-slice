import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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

// The bridge token file a bundled server reads (mcp/bridge-client.ts): none unmarked, the release app's with
// stable.identity, the beta's with tandem-beta.identity (the beta wins when both are there), never the other's.
{
  const saved = { file: process.env.LIME_MCP_BRIDGE_FILE, appdata: process.env.APPDATA, xdg: process.env.XDG_CONFIG_HOME };
  delete process.env.LIME_MCP_BRIDGE_FILE;
  const config = mkdtempSync(join(tmpdir(), "lime-bridge-config-"));
  process.env.APPDATA = config;
  process.env.XDG_CONFIG_HOME = config;
  const pick = async (marks: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), "lime-bridge-bundle-"));
    const entry = join(dir, "bridge-client.mjs");
    await build({ entryPoints: ["mcp/bridge-client.ts"], outfile: entry, bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent" });
    for (const mark of marks) writeFileSync(join(dir, mark), "");
    const { bridgeTokenFile } = await import(pathToFileURL(entry).href) as { bridgeTokenFile: () => string | null };
    return bridgeTokenFile();
  };
  const app = (id: string) => (process.platform === "darwin" ? join(homedir(), "Library", "Application Support", id, "tandem-bridge.json") : join(config, id, "tandem-bridge.json"));
  assert.equal(await pick([]), null, "an unmarked server never reads an app's token");
  assert.equal(await pick(["stable.identity"]), app("com.limeslice.slicer"), "a release server reads the release app's token");
  assert.equal(await pick(["tandem-beta.identity"]), app("com.limeslice.slicer.tandem-beta"), "a beta server reads the beta's token");
  assert.equal(await pick(["tandem-beta.identity", "stable.identity"]), app("com.limeslice.slicer.tandem-beta"), "a beta never reads the release app's token");
  for (const [key, value] of [["LIME_MCP_BRIDGE_FILE", saved.file], ["APPDATA", saved.appdata], ["XDG_CONFIG_HOME", saved.xdg]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  console.log("bridge identity: a release server reads the release app's token, a beta's the beta's, an unmarked one none");
}
