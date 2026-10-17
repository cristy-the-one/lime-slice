// Bundles the MCP server for the installer: plain JavaScript that a stock Node 22
// runs without type stripping. The engine library is copied next to it by the
// release workflow. Usage: node tools/mcp/bundle.mjs [outdir]
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = fileURLToPath(new URL("../..", import.meta.url));
const outdir = process.argv[2] ?? `${root}src-tauri/resources/mcp`;
const { version } = JSON.parse(readFileSync(`${root}package.json`, "utf8"));

// The folder also holds the engine library; only the scripts are rebuilt.
for (const name of ["server.mjs", "engine-worker.mjs"]) rmSync(`${outdir}/${name}`, { force: true });
await build({
  entryPoints: [`${root}mcp/server.ts`, `${root}mcp/engine-worker.ts`],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outdir,
  outExtension: { ".js": ".mjs" },
  // An installed app has no package.json to read the version from.
  define: { __LIME_MCP_VERSION__: JSON.stringify(version) },
  logLevel: "warning",
});
console.log(`MCP server ${version} bundled into ${outdir}`);
