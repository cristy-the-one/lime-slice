/**
 * Mechanical study recipes: lust build and one stub-host run each (docs/studies/mechanical-components.md).
 * Real geometry and bounds are checked in mcp/recipe-mech-study-occt.test.ts (Open CASCADE CI job).
 */
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { findLust, RecipeHost, type RecipeCallSite, type RecipeReply } from "./recipe.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const studyDir = join(root, "mcp", "fixtures", "plugins", "mech-study");
const lust = findLust();
if (!lust) {
  if (process.env.LIME_RECIPE_REQUIRED === "1") {
    console.error("recipe-mech-study: lust is required here (LIME_LUST)");
    process.exit(1);
  }
  console.log("recipe-mech-study: skipped (set LIME_LUST to a lust build)");
  process.exit(0);
}

const plugins = readdirSync(studyDir).filter((f) => f.endsWith(".rs")).sort();
if (plugins.length === 0) {
  console.error("recipe-mech-study: no plugins in mech-study/");
  process.exit(1);
}

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    console.log(`ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name} ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 2000)}`);
}

const dir = mkdtempSync(join(tmpdir(), "lime-recipe-mech-study-"));
const host = new RecipeHost({ crateDir: join(root, "crates", "lime-recipe"), root: join(dir, "host"), lust });

function stub() {
  return async (site: RecipeCallSite): Promise<RecipeReply> => {
    if (site.tool === "solid_new") return { ok: true, result: { ok: true, object: "obj_1" } };
    if (site.tool === "model_describe" || site.tool === "bounds") {
      return { ok: true, result: { ok: true, bounds: { min: [-10, -10, 0], max: [10, 10, 12] } } };
    }
    return { ok: true, result: { ok: true, volumeMm3: 1000 } };
  };
}

for (const file of plugins) {
  const id = file.replace(/\.rs$/, "");
  const source = readFileSync(join(studyDir, file), "utf8");
  const built = await host.build(id, source, false);
  check(`${id}: lust builds`, built.ok, built.diagnostics.length ? built.diagnostics : built.reason);
  if (built.ok && built.exe) {
    const ran = await host.run(built.exe, { params: {}, context: { units: "mm" } }, stub());
    check(`${id}: stub run reaches done`, ran.ok && !!ran.done, ran.reason ?? ran.stderr);
    const metrics = ran.done?.metrics as { bmin?: number[]; bmax?: number[] } | undefined;
    check(`${id}: done reports bmin/bmax from s.bounds`, !!metrics?.bmin && metrics.bmin.length === 3 && !!metrics?.bmax && metrics.bmax.length === 3, metrics);
  }
}

if (failed > 0) {
  console.error(`recipe-mech-study: ${failed} failed`);
  process.exit(1);
}
console.log(`recipe-mech-study: ${plugins.length}/${plugins.length} lust builds ok (stub host)`);