// Bundles the MCP server for the installer: plain JavaScript that a stock Node 22
// runs without type stripping. The engine library is copied next to it by the
// release workflow. Usage: node tools/mcp/bundle.mjs [outdir]
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = fileURLToPath(new URL("../..", import.meta.url));
const outdir = process.argv[2] ?? `${root}src-tauri/resources/mcp`;
const { version } = JSON.parse(readFileSync(`${root}package.json`, "utf8"));

// The folder also holds the engine library; only the scripts are rebuilt.
for (const name of ["server.mjs", "engine-worker.mjs"]) rmSync(`${outdir}/${name}`, { force: true });
// The release workflow adds this only for a beta tag. A later stable build must not inherit it.
rmSync(`${outdir}/tandem-beta.identity`, { force: true });
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
// recipe_run builds recipes against lime-recipe; the server finds this copy beside it (mcp/recipe.ts).
mkdirSync(`${outdir}/lime-recipe/src`, { recursive: true });
copyFileSync(`${root}crates/lime-recipe/src/lib.rs`, `${outdir}/lime-recipe/src/lib.rs`);
// docs/plan-recipe-plugins.md D12: after a major bump, the last crate of each earlier major is kept in the repo as
// crates/lime-recipe-<major>/ (not a workspace member) and ships beside the current one, where recipeCrates finds it.
for (const name of readdirSync(`${root}crates`)) {
  if (!/^lime-recipe-\d+$/.test(name) || !existsSync(`${root}crates/${name}/src/lib.rs`)) continue;
  mkdirSync(`${outdir}/${name}/src`, { recursive: true });
  copyFileSync(`${root}crates/${name}/src/lib.rs`, `${outdir}/${name}/src/lib.rs`);
}
console.log(`MCP server ${version} bundled into ${outdir}`);
