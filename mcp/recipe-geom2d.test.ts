/**
 * Rule zero for lime_recipe's geometry (geom2d, lattice): a recipe that uses them sends the same calls, byte for byte,
 * built by lust and by rustc. lust's libm differs from rustc's in the last bit for sin, cos, atan2 and the like on
 * Windows, so the crate uses its own; this test is what catches a slip back. It runs the crate's vent_plate example
 * and the ingredients guide's example. Skips without lust; LIME_RECIPE_REQUIRED=1 (the CI jobs that build lust) makes
 * that a failure.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { GUIDES } from "./guides.ts";
import { findLust, RecipeHost, type RecipeCallSite, type RecipeReply } from "./recipe.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const crateDir = join(root, "crates", "lime-recipe");
const lust = findLust();
if (!lust) {
  if (process.env.LIME_RECIPE_REQUIRED === "1") {
    console.error("recipe-geom2d: lust is required here (LIME_LUST)");
    process.exit(1);
  }
  console.log("recipe-geom2d: skipped (set LIME_LUST to a lust build)");
  process.exit(0);
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

const dir = mkdtempSync(join(tmpdir(), "lime-recipe-geom2d-"));
const host = new RecipeHost({ crateDir, root: join(dir, "host"), lust });
const exe = process.platform === "win32" ? ".exe" : "";

// The crate as rustc builds it for a recipe: one rlib, no dev-dependencies.
const rlib = join(dir, "liblime_recipe.rlib");
const lib = spawnSync("rustc", ["--edition", "2024", "-O", "--crate-type", "rlib", "--crate-name", "lime_recipe", join(crateDir, "src", "lib.rs"), "-o", rlib], { encoding: "utf8" });
check("rustc builds lime_recipe", lib.status === 0, lib.stderr);

function stub(log: RecipeCallSite[]) {
  return async (site: RecipeCallSite): Promise<RecipeReply> => {
    log.push(site);
    if (site.tool === "solid_new") return { ok: true, result: { ok: true, object: "obj_1" } };
    return { ok: true, result: { ok: true, volumeMm3: 1000 } };
  };
}

async function sameUnderBoth(name: string, source: string): Promise<RecipeCallSite[]> {
  const built = await host.build(name, source, false);
  check(`${name}: lust builds it`, built.ok, built.diagnostics.length ? built.diagnostics : built.reason);
  const src = join(dir, `${name}.rs`);
  writeFileSync(src, source);
  const rustcExe = join(dir, `${name}${exe}`);
  const r = spawnSync("rustc", ["--edition", "2024", "-O", src, "--extern", `lime_recipe=${rlib}`, "-o", rustcExe], { encoding: "utf8" });
  check(`${name}: rustc builds it`, r.status === 0, r.stderr);
  if (!built.ok || r.status !== 0) return [];
  const viaLust: RecipeCallSite[] = [];
  const viaRustc: RecipeCallSite[] = [];
  const a = await host.run(built.exe!, { params: {}, context: { units: "mm" } }, stub(viaLust));
  const b = await host.run(rustcExe, { params: {}, context: { units: "mm" } }, stub(viaRustc));
  check(`${name}: both runs reach done`, a.ok && b.ok, { lust: a.reason ?? a.stderr, rustc: b.reason ?? b.stderr });
  const textA = viaLust.map((c) => JSON.stringify([c.tool, c.args, c.line]));
  const textB = viaRustc.map((c) => JSON.stringify([c.tool, c.args, c.line]));
  const first = textA.findIndex((t, i) => t !== textB[i]);
  check(`${name}: ${textA.length} calls, the same under lust and rustc`, textA.length === textB.length && first < 0, first >= 0 ? { call: first + 1, lust: textA[first], rustc: textB[first] } : "");
  check(`${name}: the same metrics`, JSON.stringify(a.done?.metrics) === JSON.stringify(b.done?.metrics), { lust: a.done, rustc: b.done });
  console.log(`     ${name}: lust run ${a.ms} ms, rustc run ${b.ms} ms, metrics ${JSON.stringify(a.done?.metrics)}`);
  return viaLust;
}

if (lib.status === 0) {
  const vent = await sameUnderBoth("vent_plate", readFileSync(join(crateDir, "examples", "vent_plate.rs"), "utf8"));
  const cells = vent.filter((c) => String((c.args.op as { label?: string } | undefined)?.label ?? "").startsWith("cell "));
  check("vent_plate cuts its cells with arcs", cells.length > 50 && JSON.stringify(cells[0]?.args).includes('"kind":"arc"'), cells.length);

  // The ingredients guide's example, inside a main.
  const guide = GUIDES.find((g) => g.uri === "lime://guide/ingredients")!.text.split("\n");
  const from = guide.findIndex((l) => l.startsWith("let floor"));
  const body = guide.slice(from).map((l) => `    ${l}`).join("\n");
  const example = [
    "use lime_recipe::geom2d::rect;",
    "use lime_recipe::lattice::{hex, Orient};",
    "use lime_recipe::{ops, Json, Session};",
    "fn main() {",
    "    let mut s = Session::start();",
    "    let part = s.solid_new(ops::cuboid(300.0, 120.0, 10.0)).unwrap();",
    body,
    "    s.done(&part);",
    "}",
    "",
  ].join("\n");
  const floor = await sameUnderBoth("guide_floor", example);
  check("the guide's example cuts cells", floor.filter((c) => c.tool === "model_apply").length > 100, floor.length);
}

if (failed > 0) {
  console.error(`recipe-geom2d: ${failed} failed`);
  process.exit(1);
}
console.log("recipe-geom2d: ok");
