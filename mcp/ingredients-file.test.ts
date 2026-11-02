/**
 * Ingredient files and imports (docs/plan-recipe-ingredients.md I9–I11), without lust: the file's front matter, the
 * names a recipe imports, the block the host appends (latest, pinned, and what ingredients import), refusals for
 * unknown names and versions, kept copies, the line map, and the stamps a plugin carries.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const library = mkdtempSync(join(tmpdir(), "lime-ingredients-lib-"));
process.env.LIME_PLUGINS_DIR = library;

const { bodyProblem, builtText, carriedIngredients, codeOnly, hasOwnIngredients, ingredientRefs, ingredientsDir, isIngredientId, lineMap, lineText, locate, resolveIngredients } = await import("./ingredients.ts");
const { bodyHash, listLibrary, parsePlugin, pluginText, readPlugin, writePlugin } = await import("./plugins.ts");
type PluginHeader = import("./plugins.ts").PluginHeader;

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    console.log(`ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name} ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}

const dir = ingredientsDir();
check("ingredients live in the library's ingredients folder", dir === join(library, "ingredients"), dir);

const header = (id: string, version: number, body: string): PluginHeader => ({
  plugin: id,
  kind: "ingredient",
  title: id,
  version,
  description: `The ${id} helpers.`,
  author: "unknown",
  api: "1.1",
  "source-sha256": bodyHash(body),
  created: "2026-11-02",
  target: "new",
  params: [],
});
const keep = (id: string, version: number, body: string) => writePlugin(header(id, version, body), body, dir);

// --- I9. The file.
const hc1 = "pub fn side(k: f64) -> f64 {\n    k * 5.0\n}\n";
const hc2 = "use lime_recipe::geom2d::Poly;\n\npub fn side(k: f64) -> f64 {\n    k * 10.0 + crate::ingredients::tray::depth()\n}\n";
const tray = "pub const DEPTH: f64 = 3.0;\n\npub fn depth() -> f64 {\n    DEPTH\n}\n";
keep("honeycomb", 1, hc1);
keep("honeycomb", 2, hc2);
keep("tray", 1, tray);
const text = pluginText(header("honeycomb", 2, hc2), hc2);
check("an ingredient's header names it with ingredient:, and has no target or params", text.startsWith("//! ---\n//! ingredient: honeycomb\n") && !text.includes("//! target:") && !text.includes("//! params:") && !text.includes("//! plugin:"), text);
const parsed = parsePlugin(text);
check("it reads back as an ingredient", !("reason" in parsed) && parsed.header.kind === "ingredient" && parsed.header.plugin === "honeycomb" && parsed.matches, parsed);
check("the older version is kept beside it", !!readPlugin("honeycomb", dir, 1, "ingredient"), "");
const asPlugin = readPlugin("honeycomb", dir, undefined, "plugin");
check("an ingredient is not read as a plugin", !!asPlugin && "reason" in asPlugin && /an ingredient, not a plugin/.test(asPlugin.reason), asPlugin);
check("the plugin list does not see the ingredients folder", listLibrary(library).length === 0 && listLibrary(dir, "ingredient").map((f) => f.header.plugin).join() === "honeycomb,tray", listLibrary(dir, "ingredient").map((f) => f.header.plugin));
check("ingredient ids are module names", isIngredientId("moulded-tray") && !isIngredientId("3d-grid") && !isIngredientId("type") && !isIngredientId("v2") && !isIngredientId("Tray"), "");

// --- I10. What a recipe imports.
const refs = (src: string) => ingredientRefs(src).map((r) => (r.version === undefined ? r.module : `${r.module}@${r.version}`)).sort().join(" ");
check("a use of the latest version", refs("use ingredients::honeycomb::*;") === "honeycomb", refs("use ingredients::honeycomb::*;"));
check("a pinned version", refs("use ingredients::honeycomb::v1::{side, Cell};") === "honeycomb@1", "");
check("a group with an alias and a pin", refs("use ingredients::{tray, honeycomb::v1 as old, moulded_tray::{a, b}};") === "honeycomb@1 moulded_tray tray", refs("use ingredients::{tray, honeycomb::v1 as old, moulded_tray::{a, b}};"));
check("an inline path and crate::", refs("let d = crate::ingredients::tray::depth() + ingredients::honeycomb::side(1.0);") === "honeycomb tray", "");
check("comments and strings are not imports", refs('// use ingredients::nope::*;\n/* ingredients::nada */ let s = "ingredients::never"; let c = \'"\';') === "", codeOnly('let s = "ingredients::never";'));
check("self:: and super:: paths are not the library", refs("use self::ingredients::a; use super::ingredients::b;") === "", "");
check("a source with its own mod ingredients carries them", hasOwnIngredients("fn main() {}\n#[allow(dead_code)]\nmod ingredients {\n}\n") && !hasOwnIngredients("// mod ingredients {\nfn main() {}"), "");

const recipe = "use lime_recipe::{ops, Session};\nuse ingredients::honeycomb::*;\nuse ingredients::honeycomb::v1 as old;\n\nfn main() {\n    let mut s = Session::start();\n    let p = s.solid_new(ops::cuboid(side(2.0), 10.0, old::side(1.0))).unwrap();\n    s.done(&p);\n}\n";
const r = resolveIngredients(recipe);
check("the recipe resolves", !("reason" in r), r);
if (!("reason" in r)) {
  check("latest, pinned, and what an ingredient imports are all in", Object.keys(r.used).sort().join() === "honeycomb,honeycomb@1,tray" && r.used.honeycomb!.version === 2 && r.used["honeycomb@1"]!.version === 1, Object.keys(r.used));
  const built = builtText(recipe, r.suffix);
  check("the recipe's own lines come first, unchanged", built.startsWith(recipe), "");
  check("the latest is the module, a pin is v<N> inside it", /pub mod honeycomb \{\n\/\/ ingredient: honeycomb v2 sha256:[0-9a-f]{64}\nuse lime_recipe::geom2d::Poly;[\s\S]*pub mod v1 \{\n\/\/ ingredient: honeycomb v1 sha256:[0-9a-f]{64}\npub fn side/.test(built) && built.includes("pub mod tray {"), built);
  const map = lineMap(recipe, r);
  const lines = built.split("\n");
  const at = lines.findIndex((l) => l.includes("k * 10.0")) + 1;
  check("a line in an ingredient maps to its body line", JSON.stringify(locate(map, at)) === JSON.stringify({ line: 4, ingredient: "honeycomb v2" }) && lineText(map, at) === "ingredient honeycomb v2, line 4", locate(map, at));
  check("a recipe line stays itself", JSON.stringify(locate(map, 7)) === JSON.stringify({ line: 7 }), locate(map, 7));
  const noNewline = recipe.trimEnd();
  const r2 = resolveIngredients(noNewline);
  if (!("reason" in r2)) {
    const built2 = builtText(noNewline, r2.suffix).split("\n");
    const at2 = built2.findIndex((l) => l.includes("k * 10.0")) + 1;
    check("the map holds for a recipe with no final newline", lineText(lineMap(noNewline, r2), at2) === "ingredient honeycomb v2, line 4", at2);
  }
  const carried = carriedIngredients(built);
  check("the stamps name each carried ingredient", carried.map((c) => `${c.id} v${c.version}`).sort().join() === "honeycomb v1,honeycomb v2,tray v1" && carried.every((c) => /^[0-9a-f]{64}$/.test(c.sha256)), carried);
  const again = resolveIngredients(built);
  check("a source that carries them is built as it stands", !("reason" in again) && again.suffix === "", again);
}

// --- Refusals.
const unknown = resolveIngredients("use ingredients::honeycom::*;\nfn main() {}\n");
check("an unknown name is refused with the close name and the names there are", "reason" in unknown && /No ingredient is named honeycom\. Did you mean honeycomb\? The library has: honeycomb, tray\./.test(unknown.reason), unknown);
const pinned = resolveIngredients("use ingredients::honeycomb::v7::*;\nfn main() {}\n");
check("a version that is not kept is refused with the versions there are", "reason" in pinned && pinned.reason === "No version 7 of the ingredient honeycomb is kept: honeycomb has versions 1, 2.", pinned);
mkdirSync(dir, { recursive: true });
const withMain = "pub fn a() {}\nfn main() {}\n";
writeFileSync(join(dir, "mainish.rs"), pluginText(header("mainish", 1, withMain), withMain));
const bad = resolveIngredients("use ingredients::mainish::*;\nfn main() {}\n");
check("an ingredient with a main is refused with its line", "reason" in bad && /mainish cannot be imported: line 2 is a main/.test(bad.reason), bad);
check("another file or crate in an ingredient is refused", /line 1 brings in another file/.test(bodyProblem("mod other;\n") ?? ""), bodyProblem("mod other;\n"));

// --- Kept copies: a rerun builds what it built; a missing name falls back to the copy.
const kept = { id: "honeycomb", version: 2, sha256: "k", body: "pub fn side(k: f64) -> f64 {\n    k\n}\n" };
const rerun = resolveIngredients("use ingredients::honeycomb::*;\nfn main() {}\n", { kept: { honeycomb: kept }, preferKept: true });
check("a rerun builds the copy it kept", !("reason" in rerun) && rerun.used.honeycomb?.body === kept.body, rerun);
const fresh = resolveIngredients("use ingredients::honeycomb::*;\nfn main() {}\n", { kept: { honeycomb: kept } });
check("new source reads the library", !("reason" in fresh) && fresh.used.honeycomb?.body.includes("k * 10.0") === true, fresh);
const gone = resolveIngredients("use ingredients::lattice_extra::*;\nfn main() {}\n", { kept: { lattice_extra: { ...kept, id: "lattice-extra" } } });
check("a name the library no longer has builds from the kept copy", !("reason" in gone) && gone.used.lattice_extra?.id === "lattice-extra", gone);

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\ningredients-file: all checks passed");
