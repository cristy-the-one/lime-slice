/**
 * Where recipe_run looks for lust (mcp/recipe.ts `lustCandidates`, `findLust`): LIME_LUST, then the copy the installers
 * ship beside server.mjs, then `lust` on PATH. Node stands in for lust: it answers `--version` too.
 */
import { copyFileSync, linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { findLust, lustCandidates, RecipeHost } from "./recipe.ts";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    console.log(`ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name} ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}

const dir = mkdtempSync(join(tmpdir(), "lime-recipe-find-"));
const serverUrl = pathToFileURL(join(dir, "server.mjs")).href;
const bundled = join(dir, "lust", "bin", process.platform === "win32" ? "lust.exe" : "lust");
const saved = process.env.LIME_LUST;
delete process.env.LIME_LUST;

try {
  check("without a bundle: PATH only", JSON.stringify(lustCandidates(serverUrl)) === JSON.stringify(["lust"]), lustCandidates(serverUrl));
  check("without a module URL: PATH only", JSON.stringify(lustCandidates()) === JSON.stringify(["lust"]), lustCandidates());

  mkdirSync(join(dir, "lust", "bin"), { recursive: true });
  try {
    linkSync(process.execPath, bundled);
  } catch {
    copyFileSync(process.execPath, bundled);
  }
  check("the bundled copy comes before PATH", JSON.stringify(lustCandidates(serverUrl)) === JSON.stringify([bundled, "lust"]), lustCandidates(serverUrl));
  check("findLust takes the bundled copy", findLust(serverUrl) === bundled, findLust(serverUrl));

  const named = join(dir, "named-lust");
  writeFileSync(named, "");
  process.env.LIME_LUST = named;
  check("LIME_LUST comes first", JSON.stringify(lustCandidates(serverUrl)) === JSON.stringify([named, bundled, "lust"]), lustCandidates(serverUrl));
  check("a LIME_LUST that does not run falls through to the bundled copy", findLust(serverUrl) === bundled, findLust(serverUrl));
  process.env.LIME_LUST = process.execPath;
  check("a LIME_LUST that runs wins", findLust(serverUrl) === process.execPath, findLust(serverUrl));
  delete process.env.LIME_LUST;

  const host = new RecipeHost({ crateDir: join(dir, "no-crate"), root: join(dir, "root"), moduleUrl: serverUrl });
  const avail = host.available();
  check("the host finds the bundled copy from the server's URL", !avail.ok && /lime-recipe crate is missing/.test(avail.reason), avail);

  rmSync(join(dir, "lust"), { recursive: true, force: true });
  const bare = new RecipeHost({ crateDir: join(dir, "no-crate"), root: join(dir, "root"), moduleUrl: serverUrl, lust: null });
  const none = bare.available();
  check("without lust the call says it needs lust", !none.ok && none.reason.startsWith("Recipes need lust"), none);
} finally {
  if (saved === undefined) delete process.env.LIME_LUST;
  else process.env.LIME_LUST = saved;
  rmSync(dir, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`recipe-find: ${failed} failed`);
  process.exit(1);
}
console.log("recipe-find: all passed");
