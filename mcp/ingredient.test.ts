/**
 * Ingredients through recipe_run (docs/plan-recipe-ingredients.md I9–I11): a recipe imports library ingredients by name
 * (latest or pinned), the same text builds the same calls under lust and rustc, lines inside an ingredient are reported
 * as that ingredient's, unknown names are refused with the names there are, a rerun builds the copies it kept (also
 * after the project is reopened), and a kept plugin carries its ingredients so it builds without the library. Real
 * lust, the stand-in engine. Skips without lust; LIME_RECIPE_REQUIRED=1 makes that a failure.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { findLust } from "./recipe.ts";

const lust = findLust();
if (!lust) {
  if (process.env.LIME_RECIPE_REQUIRED === "1") {
    console.error("ingredient: lust is required here (LIME_LUST)");
    process.exit(1);
  }
  console.log("ingredient: skipped (set LIME_LUST to a lust build)");
  process.exit(0);
}

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-ingredient-ws-"));
const library = mkdtempSync(join(tmpdir(), "lime-ingredient-lib-"));
process.env.LIME_PLUGINS_DIR = library;

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    console.log(`ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name} ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 3000)}`);
}

const { builtText, ingredientsDir, resolveIngredients } = await import("./ingredients.ts");
const { bodyHash, removePlugin, writePlugin } = await import("./plugins.ts");
const { RecipeHost, recipeCrateDir } = await import("./recipe.ts");
const { fakeEngine } = await import("./engine.ts");
const { Session } = await import("./session.ts");

const dir = ingredientsDir();
const keepIngredient = (id: string, version: number, body: string) => writePlugin({ plugin: id, kind: "ingredient", title: id, version, description: `The ${id} helpers.`, author: "unknown", api: "1.1", "source-sha256": bodyHash(body), created: "2026-11-02", target: "new", params: [] }, body, dir);

keepIngredient("honeycomb", 1, "pub fn side(k: f64) -> f64 {\n    k * 5.0\n}\n");
keepIngredient("honeycomb", 2, "use lime_recipe::{Json, Session};\n\npub fn side(k: f64) -> f64 {\n    k * 10.0 + crate::ingredients::tray::depth()\n}\n\npub fn note(s: &mut Session) {\n    let _ = s.call(\"plate_list\", Json::obj());\n}\n");
keepIngredient("tray", 1, "pub const DEPTH: f64 = 3.0;\n\npub fn depth() -> f64 {\n    DEPTH\n}\n");
keepIngredient("strict", 1, "pub fn at_most_one(x: f64) -> f64 {\n    if x > 1.0 {\n        panic!(\"{} is over one\", x);\n    }\n    x\n}\n");
keepIngredient("typo", 1, "pub fn one() -> f64 {\n    let n: u32 = 1.5;\n    n as f64\n}\n");

const session = new Session(fakeEngine());
const call = (name: string, args: unknown = {}) => session.call(name, args);
const volume = async (s: InstanceType<typeof Session>, object: string) => Number((await s.call("model_describe", { object })).volumeMm3);

const block = [
  "use lime_recipe::{ops, Json, Session};",
  "use ingredients::honeycomb::*;",
  "use ingredients::honeycomb::v1 as old;",
  "",
  "fn main() {",
  "    let mut s = Session::start();",
  '    let k = s.number("k", 2.0).range(1.0, 5.0).get();',
  "    let p = s.solid_new(ops::cuboid(side(k), 10.0, old::side(1.0))).unwrap();",
  "    note(&mut s);",
  '    s.done_with(&p, Json::obj().set("side", side(k)));',
  "}",
  "",
].join("\n");

// --- I10. Import by name: the latest version, a pinned one, and what an ingredient imports.
const first = await call("recipe_run", { source: block, name: "hcblock" });
const obj = String(first.object);
check("a recipe that imports ingredients runs", first.ok === true && (first.metrics as { side?: number })?.side === 23, first);
check("the reply names the ingredients it built with", JSON.stringify([...(first.ingredients as string[] ?? [])].sort()) === JSON.stringify(["honeycomb v1", "honeycomb v2", "tray v1"]), first.ingredients);
check("the part is what the latest and the pinned version make", (await volume(session, obj)) === 23 * 10 * 5, await volume(session, obj));
const refused = (first.refused as { line: number; ingredient?: string; reason: string }[] | undefined)?.[0];
check("a call refused inside an ingredient names the ingredient and its line", refused?.ingredient === "honeycomb v2" && refused.line === 8, first.refused);

// --- Unknown names and versions are refused before the build, with the names there are.
const unknown = await call("recipe_run", { source: block.replace("ingredients::honeycomb::*", "ingredients::honeycombs::*"), name: "hc_typo" });
check("an unknown ingredient is refused with the close name and the library's names", unknown.ok === false && String(unknown.reason).startsWith("No ingredient is named honeycombs. Did you mean honeycomb? The library has: honeycomb, strict, tray, typo."), unknown);
const noVersion = await call("recipe_run", { source: block.replace("honeycomb::v1", "honeycomb::v9"), name: "hc_v9" });
check("a version that is not kept is refused", noVersion.ok === false && noVersion.reason === "No version 9 of the ingredient honeycomb is kept: honeycomb has versions 1, 2.", noVersion);

// --- Lines inside an ingredient: a panic and a diagnostic.
const strict = await call("recipe_run", { source: "use lime_recipe::{ops, Session};\nuse ingredients::strict::at_most_one;\n\nfn main() {\n    let mut s = Session::start();\n    let p = s.solid_new(ops::cuboid(at_most_one(5.0), 1.0, 1.0)).unwrap();\n    s.done(&p);\n}\n", name: "strict_use" });
check("a panic in an ingredient says which ingredient and line", strict.ok === false && /The recipe panicked at ingredient strict v1, line 3: 5 is over one/.test(String(strict.reason)) && strict.line === 3, strict);
const typo = await call("recipe_run", { source: "use lime_recipe::{ops, Session};\nuse ingredients::typo;\n\nfn main() {\n    let mut s = Session::start();\n    let p = s.solid_new(ops::cuboid(typo::one(), 1.0, 1.0)).unwrap();\n    s.done(&p);\n}\n", name: "typo_use" });
const diag = (typo.diagnostics as { line: number; ingredient?: string }[] | undefined)?.[0];
check("a diagnostic in an ingredient names it, its line, and is never auto-fixed", typo.ok === false && diag?.ingredient === "typo v1" && diag.line === 2 && typo.fixedSource === undefined, typo);

// --- I11. A kept plugin carries its ingredients: one file that builds without the library.
const kept = await call("recipe_run", { source: block, name: "hcblock2", keep: { title: "Honeycomb block", description: "A block sized by the honeycomb ingredient." } });
const keptRow = kept.kept as { id: string; ingredients?: string[] } | undefined;
check("keep saves a plugin and says which ingredients it carries", kept.ok === true && keptRow?.id === "honeycomb-block" && JSON.stringify([...(keptRow.ingredients ?? [])].sort()) === JSON.stringify(["honeycomb v1", "honeycomb v2", "tray v1"]), kept);
const pluginText = readFileSync(join(library, "honeycomb-block.rs"), "utf8");
check("the plugin file is the recipe, then its ingredients as inline modules, stamped", pluginText.includes(block) && pluginText.includes("\nmod ingredients {\n") && /\/\/ ingredient: honeycomb v2 sha256:[0-9a-f]{64}\n/.test(pluginText) && /\/\/ ingredient: tray v1 sha256:[0-9a-f]{64}\n/.test(pluginText), pluginText.slice(-1500));
const got = await call("plugin", { action: "get", id: "honeycomb-block" });
check("plugin get lists the ingredients inside", JSON.stringify((got.ingredients as { id: string; version: number }[] ?? []).map((r) => `${r.id} v${r.version}`).sort()) === JSON.stringify(["honeycomb v1", "honeycomb v2", "tray v1"]), got.ingredients);

// --- A newer library version: a rerun builds the copy it kept; new source reads the library.
keepIngredient("honeycomb", 3, "use lime_recipe::{Json, Session};\n\npub fn side(k: f64) -> f64 {\n    k * 100.0\n}\n\npub fn note(_s: &mut Session) {}\n");
const rerun = await call("recipe_run", { object: obj, params: { k: 3 } });
check("a rerun builds the ingredients its last apply built", rerun.ok === true && (rerun.metrics as { side?: number })?.side === 33 && JSON.stringify(rerun.replaced) === JSON.stringify([obj]), rerun);
const plugin = await call("recipe_run", { plugin: "honeycomb-block" });
check("the plugin builds its own copies, not the library's newer one", plugin.ok === true && (plugin.metrics as { side?: number })?.side === 23 && plugin.ingredients === undefined, plugin);
const fresh = await call("recipe_run", { source: block, name: "hcblock", object: obj });
check("new source reads the library's latest", fresh.ok === true && (fresh.metrics as { side?: number })?.side === 300, fresh);

// --- The project keeps the copies: a later session reruns without the library.
await call("recipe_run", { object: obj, params: { k: 2 } });
await call("project_save", { name: "ingredients.lime" });
const doc = JSON.parse(readFileSync(join(process.env.LIME_MCP_WORKSPACE!, "ingredients.lime"), "utf8")) as { mcpModel?: { rustRecipes?: Record<string, { ingredients?: Record<string, { id: string; version: number; body: string }> }> } };
const keptCopies = doc.mcpModel?.rustRecipes?.hcblock?.ingredients ?? {};
check("the project keeps each ingredient a run built with", Object.keys(keptCopies).sort().join() === "honeycomb,honeycomb@1" && keptCopies.honeycomb?.version === 3, Object.keys(keptCopies));
removePlugin("honeycomb", dir);
removePlugin("tray", dir);
const later = new Session(fakeEngine());
await later.call("project_open", { path: "ingredients.lime" });
const laterRun = await later.call("recipe_run", { object: obj, params: { k: 4 } });
check("a reopened project reruns from its kept copies with the library gone", laterRun.ok === true && (laterRun.metrics as { side?: number })?.side === 400, laterRun);
const pluginAlone = await call("recipe_run", { plugin: "honeycomb-block", params: { k: 1 } });
check("the kept plugin runs with its ingredients gone from the library", pluginAlone.ok === true && (pluginAlone.metrics as { side?: number })?.side === 13, pluginAlone);

// --- Rule zero: the text the host builds sends the same calls under lust and rustc.
const root = fileURLToPath(new URL("..", import.meta.url));
const crateDir = join(root, "crates", "lime-recipe");
const scratch = mkdtempSync(join(tmpdir(), "lime-ingredient-rustc-"));
keepIngredient("honeycomb", 1, "pub fn side(k: f64) -> f64 {\n    k * 5.0\n}\n");
keepIngredient("honeycomb", 2, "use lime_recipe::Session;\nuse lime_recipe::geom2d::rect;\n\npub fn side(k: f64) -> f64 {\n    rect(k, 2.0).area() + crate::ingredients::tray::depth()\n}\n\npub fn note(s: &mut Session) {\n    s.log(&format!(\"{:.6}\", side(1.0).sqrt() / 7.0));\n}\n");
keepIngredient("tray", 1, "pub const DEPTH: f64 = 3.0;\n\npub fn depth() -> f64 {\n    DEPTH\n}\n");
const resolved = resolveIngredients(block);
if ("reason" in resolved) check("the block resolves for the rustc build", false, resolved);
else {
  const text = builtText(block, resolved.suffix);
  const host = new RecipeHost({ crateDir: recipeCrateDir(import.meta.url), root: join(scratch, "host"), lust });
  const built = await host.build("rule_zero", block, false, resolved.suffix);
  check("lust builds the recipe with its ingredients", built.ok, built.diagnostics.length ? built.diagnostics : built.reason);
  const exe = process.platform === "win32" ? ".exe" : "";
  const rlib = join(scratch, "liblime_recipe.rlib");
  const lib = spawnSync("rustc", ["--edition", "2024", "-O", "--crate-type", "rlib", "--crate-name", "lime_recipe", join(crateDir, "src", "lib.rs"), "-o", rlib], { encoding: "utf8" });
  const src = join(scratch, "main.rs");
  writeFileSync(src, text);
  const rustcExe = join(scratch, `rule_zero${exe}`);
  const r = lib.status === 0 ? spawnSync("rustc", ["--edition", "2024", "-O", src, "--extern", `lime_recipe=${rlib}`, "-o", rustcExe], { encoding: "utf8" }) : lib;
  check("rustc builds the same text", r.status === 0, r.stderr);
  if (built.ok && r.status === 0) {
    const runOne = async (path: string) => {
      const log: string[] = [];
      const out = await host.run(path, { params: { k: 2.5 }, context: { units: "mm" } }, async (site) => {
        log.push(JSON.stringify([site.tool, site.args, site.line]));
        return site.tool === "solid_new" ? { ok: true, result: { ok: true, object: "obj_1" } } : { ok: true, result: { ok: true } };
      });
      return { out, log };
    };
    const a = await runOne(built.exe!);
    const b = await runOne(rustcExe);
    check("both reach done with the same metrics", a.out.ok && b.out.ok && JSON.stringify(a.out.done) === JSON.stringify(b.out.done), { lust: a.out.done ?? a.out.reason, rustc: b.out.done ?? b.out.reason });
    check(`the same ${a.log.length} calls, byte for byte`, a.log.length > 1 && JSON.stringify(a.log) === JSON.stringify(b.log), { lust: a.log, rustc: b.log });
  }
}

if (failed > 0) {
  console.error(`ingredient: ${failed} failed`);
  process.exit(1);
}
console.log("ingredient: all passed");
