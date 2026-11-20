/**
 * Mechanical study recipes on real Open CASCADE (docs/studies/mechanical-components.md): lust build,
 * recipe_run at default parameters, model_check closed/manifold, and model_describe bounds match the recipe's
 * claimed bmin/bmax from s.bounds. Runs in the "MCP server against real Open CASCADE" CI job only.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { engineCandidates, loadEngineWorker } from "./engine.ts";
import { findLust, RecipeHost } from "./recipe.ts";
import { Session } from "./session.ts";

const bridge = process.env.LIME_OCCT_BRIDGE ?? "";
const root = fileURLToPath(new URL("..", import.meta.url));
const addon = engineCandidates(root).find((p) => existsSync(p)) ?? "";
const ci = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
const lust = findLust();

if (!lust || !bridge || !existsSync(bridge) || !addon) {
  if (ci || process.env.LIME_REQUIRE_OCCT === "1") {
    console.error("recipe-mech-study-occt: lust, LIME_OCCT_BRIDGE and lime-mcp-engine are required");
    process.exit(1);
  }
  console.log("recipe-mech-study-occt: skipped");
  process.exit(0);
}

const studyDir = join(root, "mcp", "fixtures", "plugins", "mech-study");
const plugins = readdirSync(studyDir).filter((f) => f.endsWith(".rs")).sort();

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    console.log(`ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name} ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 2500)}`);
}

const near = (a: number[], b: number[], tol: number) => a.length === 3 && a.every((v, i) => Math.abs(v - (b[i] ?? NaN)) <= tol);

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-mech-study-occt-"));
process.env.LIME_MCP_MODEL_TIMEOUT_S = process.env.LIME_MCP_MODEL_TIMEOUT_S ?? "120";

const worker = loadEngineWorker(root);
const hasOcct = await worker.occt();
if (!hasOcct) {
  console.error("recipe-mech-study-occt: engine reports Open CASCADE unavailable (OCCT_ROOT at build)");
  process.exit(1);
}

const session = new Session(worker);
const call = (name: string, args: unknown = {}) => session.call(name, args) as Promise<Record<string, unknown>>;
await call("project_create", {});

const host = new RecipeHost({ crateDir: join(root, "crates", "lime-recipe"), root: mkdtempSync(join(tmpdir(), "lime-mech-study-build-")), lust });

const built: string[] = [];
for (const file of plugins) {
  const id = file.replace(/\.rs$/, "");
  const source = readFileSync(join(studyDir, file), "utf8");
  const compile = await host.build(id, source, false);
  check(`${id}: lust builds`, compile.ok, compile.diagnostics.length ? compile.diagnostics : compile.reason);
  if (!compile.ok) continue;
  const run = await call("recipe_run", { source, name: id, timeoutS: 180 });
  check(`${id}: recipe_run ok`, run.ok === true, run);
  if (run.ok !== true || !run.object) continue;
  const mc = await call("model_check", { object: run.object });
  const edges = mc.edges as { open?: number; nonManifold?: number } | undefined;
  check(`${id}: model_check closed manifold`, edges?.open === 0 && edges?.nonManifold === 0, mc);
  const described = await call("model_describe", { object: run.object, limit: 1 });
  const box = described.bounds as { min?: number[]; max?: number[] } | undefined;
  const metrics = run.metrics as { bmin?: number[]; bmax?: number[] } | undefined;
  const tol = 0.05;
  const boundsOk =
    !!box?.min && !!box?.max && !!metrics?.bmin && !!metrics?.bmax && near(box.min, metrics.bmin, tol) && near(box.max, metrics.bmax, tol);
  check(`${id}: measured bounds match claimed bmin/bmax (tol ${tol} mm)`, boundsOk, {
    measured: box,
    claimed: { bmin: metrics?.bmin, bmax: metrics?.bmax },
  });
  if (run.ok === true && edges?.open === 0 && edges?.nonManifold === 0 && boundsOk) built.push(id);
}

console.log(`recipe-mech-study-occt: built on OCCT ${built.length}/${plugins.length}`);

if (failed > 0) {
  console.error(`recipe-mech-study-occt: ${failed} failed`);
  process.exit(1);
}