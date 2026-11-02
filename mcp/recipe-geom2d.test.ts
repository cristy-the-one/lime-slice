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

/** A section answer as the kernel gives one: a 284 × 104 floor with R7 corners (arcs in loops, sampled in regions). */
const corner = (cx: number, cy: number, a0: number) => Array.from({ length: 9 }, (_, i) => {
  const a = ((a0 + (90 * i) / 8) * Math.PI) / 180;
  return [Math.round((cx + 7 * Math.cos(a)) * 1e6) / 1e6, Math.round((cy + 7 * Math.sin(a)) * 1e6) / 1e6];
});
const SECTION_REPLY = {
  ok: true,
  object: "obj_1",
  sections: [{
    frame: { origin: [0, 0, 5], u: [1, 0, 0], v: [0, 1, 0], w: [0, 0, 1] },
    origin: [0, 0, 5],
    turn: [0, 0, 0],
    loops: [{ start: [-135, -52], segments: [{ kind: "line", to: [135, -52] }, { kind: "arc", to: [142, -45], center: [135, -45] }, { kind: "line", to: [142, 45] }] }],
    regions: [{ outer: [...corner(135, -45, -90), ...corner(135, 45, 0), ...corner(-135, 45, 90), ...corner(-135, -45, 180)], holes: [] }],
    areaMm2: 29493.94,
  }],
};

function stub(log: RecipeCallSite[]) {
  return async (site: RecipeCallSite): Promise<RecipeReply> => {
    log.push(site);
    if (site.tool === "solid_new") return { ok: true, result: { ok: true, object: "obj_1" } };
    if (site.tool === "section") return { ok: true, result: SECTION_REPLY };
    if (site.tool === "model_apply_batch") return { ok: true, result: { ok: true, applied: (site.args.ops as unknown[]).length - 1, combined: (site.args.ops as unknown[]).length, failures: [{ index: 1, reason: "This op misses the part." }] } };
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

  // The recipes guide's example, as it stands (typed parameters since API 1.1).
  const recipes = GUIDES.find((g) => g.uri === "lime://guide/recipes")!.text.split("\n");
  const at = recipes.indexOf("use lime_recipe::{ops, Json, Session};");
  const end = recipes.indexOf("}", at);
  const bar = await sameUnderBoth("guide_recipes", `${recipes.slice(at, end + 1).join("\n")}\n`);
  check("the recipes guide's example drills its holes", bar.filter((c) => c.tool === "model_apply").length === 4, bar.map((c) => c.tool));

  // The typed wrappers for section and combine: a honeycomb clipped to the floor's real outline, cut in one boolean.
  const wrapped = [
    "use lime_recipe::lattice::{hex, Orient};",
    "use lime_recipe::{ops, Json, Session};",
    "fn main() {",
    "    let mut s = Session::start();",
    "    let part = s.solid_new(ops::cuboid(300.0, 120.0, 10.0)).unwrap();",
    "    let floor = s.face_outline(&part, Json::obj().set(\"normal\", [0.0, 0.0, 1.0]).set(\"nearPoint\", [0.0, 0.0, 5.0]), 3.0).unwrap();",
    "    let cut = s.section(&part, [0.0, 0.0, 2.0], [0.0, 0.0, 1.0]).unwrap();",
    "    let many = s.sections(&part, Json::obj().set(\"levels\", Json::obj().set(\"axis\", \"z\").set(\"values\", vec![1.0, 2.0]))).unwrap();",
    "    let mut ops: Vec<Json> = Vec::new();",
    "    for c in hex(10.0, Orient::Pointy).rib(2.4).cells(&floor.region, 12.0) {",
    "        let lp = c.poly().clean(0.05).round_corners_with(2.0, 0.45, 0.3).to_loop();",
    "        ops.push(floor.extrude(\"cut\", -3.5, Json::arr(vec![lp])));",
    "    }",
    "    let n = ops.len();",
    "    let done = s.apply_many(&part, \"cut\", ops).unwrap();",
    "    let corner = floor.frame.point([10.0, 20.0]);",
    "    s.done_with(&part, Json::obj().set(\"cells\", n).set(\"applied\", done.applied).set(\"left\", done.failures.len()).set(\"area\", floor.region.area()).set(\"cutArea\", cut.area).set(\"levels\", many.len()).set(\"corner\", corner));",
    "}",
    "",
  ].join("\n");
  const viaWrappers = await sameUnderBoth("section_wrappers", wrapped);
  const batch = viaWrappers.find((c) => c.tool === "model_apply_batch");
  const sent = (batch?.args.ops as { origin?: number[]; depth?: number }[] | undefined) ?? [];
  check("the wrappers send section and one combined batch", viaWrappers.map((c) => c.tool).join() === "solid_new,section,section,section,model_apply_batch" && batch?.args.combine === "cut" && sent.length > 100 && sent[0]?.origin?.[2] === 5 && sent[0]?.depth === -3.5, viaWrappers.map((c) => c.tool));
  check("face_outline sends its face and inset", JSON.stringify(viaWrappers[1]?.args) === '{"object":"obj_1","face":{"normal":[0,0,1],"nearPoint":[0,0,5]},"insetMm":3}', viaWrappers[1]?.args);
}

if (failed > 0) {
  console.error(`recipe-geom2d: ${failed} failed`);
  process.exit(1);
}
console.log("recipe-geom2d: ok");
