/**
 * Moving an ingredient between libraries (release to beta) over MCP, found in the Tandem beta on 2026-11-09:
 * nugget {action:"save", kind:"ingredient", from:"<file>.rs"} imports a kept ingredient file from the workspace as a
 * plugin file imports (checked, built alone, marked imported, a clash kept beside or replaced), and a recipe that
 * imports it by name then builds. Real lust, the stand-in engine. Skips without lust; LIME_RECIPE_REQUIRED=1 makes that
 * a failure.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findLust } from "./recipe.ts";

const lust = findLust();
if (!lust) {
  if (process.env.LIME_RECIPE_REQUIRED === "1") {
    console.error("ingredient-import: lust is required here (LIME_LUST)");
    process.exit(1);
  }
  console.log("ingredient-import: skipped (set LIME_LUST to a lust build)");
  process.exit(0);
}

const ws = mkdtempSync(join(tmpdir(), "lime-ingimport-ws-"));
process.env.LIME_MCP_WORKSPACE = ws;
const release = mkdtempSync(join(tmpdir(), "lime-ingimport-release-"));
const beta = mkdtempSync(join(tmpdir(), "lime-ingimport-beta-"));
process.env.LIME_PLUGINS_DIR = release;

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    console.log(`ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name} ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 3000)}`);
}

const { fakeEngine } = await import("./engine.ts");
const { Session } = await import("./session.ts");
const session = new Session(fakeEngine());
const call = (name: string, args: unknown = {}) => session.call(name, args);

// --- The release library keeps an ingredient.
const gears = "pub fn pitch_mm(teeth: u32, module_mm: f64) -> f64 {\n    teeth as f64 * module_mm\n}\n";
const kept = await call("nugget", { action: "save", kind: "ingredient", source: gears, title: "involute gears", description: "Gear sizes." });
check("release: the ingredient is kept", kept.ok === true && kept.id === "involute-gears", kept);
mkdirSync(join(ws, "from-release"), { recursive: true });
copyFileSync(join(release, "ingredients", "involute-gears.rs"), join(ws, "from-release", "involute-gears.rs"));

// --- The beta library imports that file as it is.
process.env.LIME_PLUGINS_DIR = beta;
const before = await call("nugget", { action: "save", kind: "ingredient", title: "involute gears", from: "from-release" });
check("a recipe name in from still means a run of this session", before.ok === false && before.code === "no-draft", before);
const imported = await call("nugget", { action: "save", kind: "ingredient", from: "from-release/involute-gears.rs" });
check("beta: the ingredient file imports without a title, with the same hash, marked imported", imported.ok === true && imported.id === "involute-gears" && imported.imported === true && imported.sha256 === kept.sha256 && imported.version === 1 && imported.use === "use ingredients::involute_gears::*;", imported);
check("beta: it is in the beta library's ingredients folder", existsSync(join(beta, "ingredients", "involute-gears.rs")) && JSON.parse(readFileSync(join(beta, "ingredients", "imported.json"), "utf8"))["involute-gears"]?.from === "file");
const found = await call("nugget", { action: "find", kind: "ingredient", query: "gears" });
const row = (found.nuggets as Record<string, unknown>[] | undefined)?.find((item) => item.id === "involute-gears");
check("find lists it, marked imported", row?.imported === true && (row.data as { title?: string })?.title === "involute gears", found);

const recipe = [
  "use lime_recipe::{ops, Json, Session};",
  "use ingredients::involute_gears::*;",
  "",
  "fn main() {",
  "    let mut s = Session::start();",
  "    let p = s.solid_new(ops::cuboid(pitch_mm(20, 1.5), 10.0, 5.0)).unwrap();",
  '    s.done_with(&p, Json::obj().set("pitch", pitch_mm(20, 1.5)));',
  "}",
  "",
].join("\n");
const built = await call("recipe_run", { source: recipe, name: "gear_blank" });
check("beta: a recipe that uses the imported ingredient builds", built.ok === true && (built.metrics as { pitch?: number })?.pitch === 30 && JSON.stringify(built.ingredients) === JSON.stringify(["involute-gears v1"]), built);

// --- Again: nothing new. Another file under the same id: kept beside, or replaced.
const again = await call("nugget", { action: "save", kind: "ingredient", from: "from-release/involute-gears.rs" });
check("the same file again changes nothing", again.ok === true && again.same === true && again.version === 1, again);
const other = readFileSync(join(ws, "from-release", "involute-gears.rs"), "utf8").replace("teeth as f64 * module_mm", "teeth as f64 * module_mm * 2.0");
writeFileSync(join(ws, "from-release", "other-gears.rs"), other);
const beside = await call("nugget", { action: "save", kind: "ingredient", from: "from-release/other-gears.rs" });
check("a different ingredient of the same name is kept beside it", beside.ok === true && beside.id === "involute-gears-2" && beside.keptBeside === "involute-gears" && beside.use === "use ingredients::involute_gears_2::*;" && beside.edited === true, beside);
const replaced = await call("nugget", { action: "save", kind: "ingredient", from: "from-release/other-gears.rs", replace: true });
check("replace:true replaces it as the next version", replaced.ok === true && replaced.id === "involute-gears" && replaced.version === 2 && replaced.replaced === "v1" && existsSync(join(beta, "ingredients", "involute-gears.v1.rs")), replaced);

// --- Files that are not an ingredient, or do not build alone, are refused and nothing is written.
writeFileSync(join(ws, "from-release", "a-plugin.rs"), "//! ---\n//! plugin: a-plugin\n//! title: A plugin\n//! version: 1\n//! api: 1.1\n//! ---\nfn main() {}\n");
const plugin = await call("nugget", { action: "save", kind: "ingredient", from: "from-release/a-plugin.rs" });
check("a plugin file is refused as an ingredient, with where it goes", plugin.ok === false && /kind:"plugin"/.test(String(plugin.reason)), plugin);
writeFileSync(join(ws, "from-release", "broken.rs"), "//! ---\n//! ingredient: broken\n//! title: broken\n//! version: 1\n//! api: 1.1\n//! ---\npub fn one() -> f64 {\n    let n: u32 = 1.5;\n    n as f64\n}\n");
const broken = await call("nugget", { action: "save", kind: "ingredient", from: "from-release/broken.rs" });
check("an ingredient that does not build alone is not kept", broken.ok === false && broken.code === "ingredient-invalid" && !existsSync(join(beta, "ingredients", "broken.rs")), broken);
const missing = await call("nugget", { action: "save", kind: "ingredient", from: "from-release/nothing.rs" });
check("a file that is not there is refused", missing.ok === false && /There is no/.test(String(missing.reason)), missing);

if (failed) {
  console.error(`ingredient-import: ${failed} failed`);
  process.exit(1);
}
console.log("ingredient-import: an ingredient file moves between libraries over MCP");
process.exit(0);
