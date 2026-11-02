/**
 * Nuggets through the MCP (docs/plan-recipe-ingredients.md I12–I17): a run's reply offers what is worth keeping, an
 * ingredient is kept from a run's helpers and found and imported by a fresh session (section 13's "done when", adapted),
 * presets checked against a plugin's ranges and run by name, lessons shown in guide {kind}, one find over every kind,
 * session_info's counts, promotion, and the plugin tool still answering. Real lust, the stand-in engine. Skips without
 * lust; LIME_RECIPE_REQUIRED=1 makes that a failure.
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findLust } from "./recipe.ts";

const lust = findLust();
if (!lust) {
  if (process.env.LIME_RECIPE_REQUIRED === "1") {
    console.error("nugget: lust is required here (LIME_LUST)");
    process.exit(1);
  }
  console.log("nugget: skipped (set LIME_LUST to a lust build)");
  process.exit(0);
}

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-nugget-ws-"));
const library = mkdtempSync(join(tmpdir(), "lime-nugget-lib-"));
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

const { fakeEngine } = await import("./engine.ts");
const { Session } = await import("./session.ts");
type Row = Record<string, unknown>;

// --- Session A: a run with a helper worth keeping and a refusal it got past.
const a = new Session(fakeEngine());
const floor = [
  "use lime_recipe::{ops, Json, Session};",
  "",
  "/// Centres of hex cells, four to a row, every other row shifted.",
  "fn cells(side: f64, count: u32) -> Vec<[f64; 2]> {",
  "    let mut out = Vec::new();",
  "    let r3: f64 = 3.0;",
  "    let pitch = side * r3.sqrt();",
  "    for i in 0..count {",
  "        let row = i / 4;",
  "        let col = i % 4;",
  "        let shift = if row % 2 == 1 { pitch / 2.0 } else { 0.0 };",
  "        out.push([col as f64 * pitch + shift, row as f64 * side * 1.5]);",
  "    }",
  "    out",
  "}",
  "",
  "fn main() {",
  "    let mut s = Session::start();",
  '    let n = s.count("cells", 6).range(1, 40).get();',
  "    let p = s.solid_new(ops::cuboid(60.0, 40.0, 5.0)).unwrap();",
  "    let c = cells(5.0, n);",
  '    if s.call("plate_list", Json::obj()).is_err() {',
  '        s.log("plate_list is not a recipe call");',
  "    }",
  '    s.done_with(&p, Json::obj().set("cells", c.len() as f64));',
  "}",
  "",
].join("\n");
const run = await a.call("recipe_run", { source: floor, name: "honeycomb_floor" });
const offers = (run.nuggets ?? []) as { offer: string; save: Row }[];
check("the run reached done", run.ok === true && (run.metrics as Row)?.cells === 6, run);
const ingredientOffer = offers.find((o) => o.save.kind === "ingredient");
check("the reply offers the helper as an ingredient, with its save call", !!ingredientOffer && /fn cells \(13 lines\)/.test(ingredientOffer.offer) && JSON.stringify(ingredientOffer.save.items) === JSON.stringify(["cells"]) && ingredientOffer.save.from === "honeycomb_floor", offers);
const lessonOffer = offers.find((o) => o.save.kind === "lesson");
check("the reply offers the refusal it got past as a lesson", !!lessonOffer && lessonOffer.save.id === "plate_list" && /line 22/.test(lessonOffer.offer), offers);
check("nothing was saved by the offer", !existsSync(join(library, "ingredients")) && !existsSync(join(library, "lessons.json")), "");

// --- I12. Keep the ingredient: the offered call, with the name the next session will look for.
const saved = await a.call("nugget", { ...ingredientOffer!.save, title: "honeycomb", description: "Hex cell centres for ribbed floors and grilles." });
check("the ingredient is kept, with what it holds and how to import it", saved.ok === true && saved.id === "honeycomb" && saved.version === 1 && JSON.stringify(saved.items) === JSON.stringify(["fn cells"]) && saved.use === "use ingredients::honeycomb::*;", saved);
const file = existsSync(join(library, "ingredients", "honeycomb.rs")) ? readFileSync(join(library, "ingredients", "honeycomb.rs"), "utf8") : "";
check("the file has the ingredient header and the helper made public, without main", file.startsWith("//! ---\n//! ingredient: honeycomb\n") && file.includes("/// Centres of hex cells") && file.includes("pub fn cells(side: f64, count: u32)") && !file.includes("fn main"), file);
const same = await a.call("nugget", { ...ingredientOffer!.save, title: "honeycomb" });
check("the same items again keep the version", same.ok === true && same.version === 1, same);
const missing = await a.call("nugget", { action: "save", kind: "ingredient", from: "honeycomb_floor", items: ["fn grid"], title: "grid" });
check("an item that is not there is refused with the items there are", missing.ok === false && /There is no item fn grid at the top of that recipe; it has: fn cells\./.test(String(missing.reason)), missing);
const alone = await a.call("nugget", { action: "save", kind: "ingredient", source: "pub fn twice(x: f64) -> f64 {\n    helper(x) * 2.0\n}\n", title: "twice" });
check("an ingredient that does not build alone is not kept, with the line", alone.ok === false && /does not build alone, so it was not kept: ingredient twice v0, line 2/.test(String(alone.reason)) && !existsSync(join(library, "ingredients", "twice.rs")), alone);

// --- I15. A lesson, shown in guide {kind}.
const lesson = await a.call("nugget", { action: "save", kind: "lesson", id: "fillet", text: "select.onFace with nearPoint over a pocket picks the pocket floor; aim at material, such as a rib node." });
check("a lesson is kept about an op kind", lesson.ok === true && lesson.id === "fillet/1" && String(lesson.shown).includes("guide {kind:\"fillet\"}"), lesson);
const guide = await a.call("guide", { kind: "fillet" });
check("guide {kind} ends with what was seen in practice, as data", JSON.stringify((guide.data as Row | undefined)?.seenInPractice) === JSON.stringify(["select.onFace with nearPoint over a pocket picks the pocket floor; aim at material, such as a rib node."]), guide.data);
const tooLong = await a.call("nugget", { action: "save", kind: "lesson", id: "fillet", text: "x".repeat(300) });
check("a lesson is one line of at most 200 characters", tooLong.ok === true && ((await a.call("nugget", { action: "get", kind: "lesson", id: String(tooLong.id) })).data as Row).text === "x".repeat(200), tooLong);
await a.call("nugget", { action: "remove", kind: "lesson", id: String(tooLong.id) });

// --- Done when (section 13, adapted): a fresh session finds the ingredient first, and a recipe imports it.
const b = new Session(fakeEngine());
const found = await b.call("nugget", { action: "find", query: "honeycomb" });
const hit = ((found.nuggets ?? []) as Row[]).find((r) => r.kind === "ingredient" && r.id === "honeycomb");
check("a fresh session's nugget find honeycomb returns the ingredient", found.ok === true && !!hit && hit.use === "use ingredients::honeycomb::*;" && hit.items === "fn cells" && (hit.data as Row).description === "Hex cell centres for ribbed floors and grilles.", found);
const plate = [
  "use lime_recipe::{ops, Json, Session};",
  "use ingredients::honeycomb::*;",
  "",
  "fn main() {",
  "    let mut s = Session::start();",
  '    let n = s.count("cells", 6).range(1, 40).label("Cells").get();',
  '    let side = s.number("side", 4.0).range(2.0, 10.0).unit("mm").get();',
  "    let p = s.solid_new(ops::cuboid(30.0, 30.0, 3.0)).unwrap();",
  "    let c = cells(side, n);",
  '    s.done_with(&p, Json::obj().set("cells", c.len() as f64).set("side", side));',
  "}",
  "",
].join("\n");
const imported = await b.call("recipe_run", { source: plate, name: "honeycomb_plate", params: { cells: 9 } });
check("a recipe in the fresh session imports it and runs", imported.ok === true && (imported.metrics as Row)?.cells === 9 && JSON.stringify(imported.ingredients) === JSON.stringify(["honeycomb v1"]), imported);
check("a run with no helper of its own offers no ingredient", !((imported.nuggets ?? []) as { save: Row }[]).some((o) => o.save.kind === "ingredient"), imported.nuggets);

// --- I14. Presets: checked against the plugin's ranges, run by name.
const kept = await b.call("recipe_run", { source: plate, name: "honeycomb_plate", keep: { title: "Honeycomb plate", description: "A plate sized for hex cells." } });
check("the plate is kept as a plugin", kept.ok === true && (kept.kept as Row)?.id === "honeycomb-plate", kept);
const outOfRange = await b.call("nugget", { action: "save", kind: "preset", id: "honeycomb-plate/dense", params: { cells: 99 } });
check("a preset outside the plugin's range is refused", outOfRange.ok === false && outOfRange.reason === "The preset was not kept: cells 99 is outside 1-40.", outOfRange);
const unknownParam = await b.call("nugget", { action: "save", kind: "preset", id: "honeycomb-plate/dense", params: { walls: 2 } });
check("a preset of a parameter the plugin lacks is refused with the ones it has", unknownParam.ok === false && /has no parameter walls; it has: cells, side\./.test(String(unknownParam.reason)), unknownParam);
const preset = await b.call("nugget", { action: "save", kind: "preset", id: "honeycomb-plate/dense", params: { cells: 20, side: 3 } });
check("a preset is kept", preset.ok === true && JSON.stringify(preset.run) === JSON.stringify({ plugin: "honeycomb-plate", preset: "dense" }), preset);
const byPreset = await b.call("recipe_run", { plugin: "honeycomb-plate", preset: "dense" });
check("recipe_run {plugin, preset} runs with its values", byPreset.ok === true && (byPreset.metrics as Row)?.cells === 20 && (byPreset.metrics as Row)?.side === 3 && byPreset.nuggets === undefined, byPreset);
const over = await b.call("recipe_run", { plugin: "honeycomb-plate", preset: "honeycomb-plate/dense", params: { cells: 5 } });
check("params given with a preset win", over.ok === true && (over.metrics as Row)?.cells === 5 && (over.metrics as Row)?.side === 3, over);
const noPreset = await b.call("recipe_run", { plugin: "honeycomb-plate", preset: "sparse" });
check("an unknown preset is refused with the ones there are", noPreset.ok === false && noPreset.reason === "No preset honeycomb-plate/sparse. honeycomb-plate has: honeycomb-plate/dense.", noPreset);
const values = await b.call("recipe_run", { plugin: "honeycomb-plate", params: { cells: 12, side: 5 } });
const presetOffer = ((values.nuggets ?? []) as { save: Row }[]).find((o) => o.save.kind === "preset");
check("a plugin run with its own values offers them as a preset", values.ok === true && !!presetOffer && JSON.stringify(presetOffer.save.params) === JSON.stringify({ cells: 12, side: 5 }), values.nuggets);

// --- I16. One find across every kind; kind narrows it; plugin keeps answering.
const all = await b.call("nugget", { action: "find", query: "honeycomb" });
const kinds = new Set(((all.nuggets ?? []) as Row[]).map((r) => r.kind));
check("find searches plugins, ingredients, presets and drafts together", ["plugin", "ingredient", "preset"].every((k) => kinds.has(k)) && ((all.nuggets ?? []) as Row[]).some((r) => r.id === "draft:honeycomb_plate"), all);
const lessons = await b.call("nugget", { action: "find", query: "pocket", kind: "lesson" });
check("kind narrows find", JSON.stringify(((lessons.nuggets ?? []) as Row[]).map((r) => r.id)) === JSON.stringify(["fillet/1"]), lessons);
const nothing = await b.call("nugget", { action: "find", query: "gearbox" });
check("nothing found says so", nothing.ok === true && (nothing.nuggets as Row[]).length === 0 && typeof nothing.note === "string", nothing);
const viaNugget = await b.call("nugget", { action: "get", kind: "plugin", id: "honeycomb-plate" });
check("nugget get of a plugin is the plugin tool's get, with the ingredient inside", viaNugget.ok === true && (viaNugget.ingredients as Row[])?.[0]?.id === "honeycomb", viaNugget);
const viaPlugin = await b.call("plugin", { action: "list", query: "honeycomb" });
check("the plugin tool still answers", viaPlugin.ok === true && ((viaPlugin.plugins ?? []) as Row[]).some((r) => r.id === "honeycomb-plate"), viaPlugin);
const info = await b.call("session_info", {});
check("session_info counts the nuggets", info.nuggets === "Nuggets: 1 ingredient, 1 preset, 1 lesson.", info.nuggets);

// --- I17. An ingredient two plugins carry is worth proposing for lime_recipe.
await b.call("recipe_run", { source: plate.replace("30.0, 30.0, 3.0", "40.0, 40.0, 3.0"), name: "honeycomb_lid", keep: { title: "Honeycomb lid", description: "A lid with hex cells." } });
const ing = await b.call("nugget", { action: "get", kind: "ingredient", id: "honeycomb", withSource: true });
check("get lists the plugins that carry it and proposes promotion", JSON.stringify([...(ing.usedBy as string[] ?? [])].sort()) === JSON.stringify(["honeycomb-lid", "honeycomb-plate"]) && String(ing.promote).includes("worth proposing for lime_recipe") && String(ing.source).includes("pub fn cells"), ing);

// --- Remove, per kind.
const rmPreset = await b.call("nugget", { action: "remove", kind: "preset", id: "honeycomb-plate/dense" });
const rmLesson = await b.call("nugget", { action: "remove", kind: "lesson", id: "fillet/1" });
const rmIngredient = await b.call("nugget", { action: "remove", kind: "ingredient", id: "honeycomb" });
check("remove takes a preset, a lesson and an ingredient", rmPreset.ok === true && rmLesson.ok === true && rmIngredient.ok === true && (await b.call("session_info", {})).nuggets === "Nuggets: 0 ingredients, 0 presets, 0 lessons.", { rmPreset, rmLesson, rmIngredient });
const stillRuns = await b.call("recipe_run", { plugin: "honeycomb-plate" });
check("a plugin that carried the removed ingredient still runs", stillRuns.ok === true, stillRuns);
const needsKind = await b.call("nugget", { action: "get", id: "honeycomb" });
check("get without kind says what kind is", needsKind.ok === false && String(needsKind.reason).includes("needs kind"), needsKind);

if (failed > 0) {
  console.error(`nugget: ${failed} failed`);
  process.exit(1);
}
console.log("nugget: all passed");
