/**
 * Recipes that use plugins (recipe API 1.16, docs/plan-plugin-recipes.md), over MCP on the stand-in engine with real
 * lust. Stage 1: a recipe runs a kept plugin with `s.run_plugin` and gets its parts back, with nothing open on the
 * plate; a refusal it handles leaves nothing of the nested run; one it does not handle takes the whole run back; a
 * plugin cannot run itself through another; one marked imported does not run hidden inside another; the version that
 * ran is pinned, so a rerun with new values runs it again after the library moved on (and says so) while a new run takes
 * the library's; the project keeps the plugin's code, so it rebuilds with the library gone. Stage 2 and 3: a recipe
 * runs "gear on arbor" three times, places the gears at their centre distances with mating phases, hinges and couples
 * them; a rerun with a new module rebuilds the train, still coupled, under the same handles, and it survives a save and
 * reopen. Skips without lust; LIME_RECIPE_REQUIRED=1 makes that a failure.
 */
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bodyHash, writePlugin, type PluginHeader } from "./plugins.ts";
import { findLust } from "./recipe.ts";

const lust = findLust();
if (!lust) {
  if (process.env.LIME_RECIPE_REQUIRED === "1") {
    console.error("plugin-recipes: lust is required here (LIME_LUST)");
    process.exit(1);
  }
  console.log("plugin-recipes: skipped (set LIME_LUST to a lust build)");
  process.exit(0);
}

const workspace = mkdtempSync(join(tmpdir(), "lime-plugin-recipes-ws-"));
process.env.LIME_MCP_WORKSPACE = workspace;
const library = mkdtempSync(join(tmpdir(), "lime-plugin-recipes-lib-"));
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
type Reply = Record<string, unknown>;
let session = new Session(fakeEngine());
session.clientName = "plugin-recipes-test";
const call = async (name: string, args: unknown = {}) => (await session.call(name, args)) as Reply;
const ids = () => session.objects.map((obj) => obj.id);

/** A plugin in the library, as a person keeps one: `version`, its body, and a header that matches it. */
function keep(id: string, body: string, version = 1, title = id): string {
  const header: PluginHeader = { plugin: id, title, version, description: `${title} for the plugin-recipes test.`, author: "test", api: "1.16", "source-sha256": bodyHash(body), created: "2026-11-15", target: "new", params: [] };
  return writePlugin(header, body, library);
}

/** "Gear on arbor": a spur gear on its own arbor, the clock's building block. `rev` says which version ran. */
const gearOnArbor = (rev: number) => [
  "use lime_recipe::{gears, ops, Json, Session};",
  "",
  "fn main() {",
  "    let mut s = Session::start();",
  '    let teeth = s.count("teeth", 24).range(6, 200).label("Teeth").get();',
  '    let module = s.number("module", 1.0).range(0.3, 5.0).unit("mm").label("Module").get();',
  '    let thickness = s.number("thickness", 4.0).range(1.0, 20.0).unit("mm").get();',
  '    let phase = s.number("phase", 0.0).label("Phase").get();',
  '    let name = s.text("name", "wheel").get();',
  '    let gear = Json::obj().set("teeth", teeth).set("module", module).set("thickness", thickness).set("bore", 0.0).set("phaseDeg", phase);',
  '    let part = s.solid_new(Json::obj().set("gear", gear).set("name", name.as_str())).unwrap();',
  `    s.apply(&part, ops::boolean("fuse", ops::cylinder(1.5, thickness + 6.0), [0.0, 0.0, -3.0])).unwrap();`,
  `    s.done_with(&part, Json::obj().set("teeth", teeth).set("pitchRadius", gears::pitch_radius(teeth, module)).set("rev", ${rev}));`,
  "}",
  "",
].join("\n");
const gearPath = keep("gear-on-arbor", gearOnArbor(1), 1, "Gear on arbor");

// --- Stage 1. A recipe runs a kept plugin with nothing on the plate, and gets its part back.
const outer = [
  "use lime_recipe::{Json, Session};",
  "",
  "fn main() {",
  "    let mut s = Session::start();",
  '    let teeth = s.count("teeth", 30).range(6, 200).get();',
  '    let run = s.run_plugin("gear-on-arbor", Json::obj().set("teeth", teeth).set("name", "centre wheel")).unwrap();',
  '    let rev = run.metrics.get("rev").and_then(Json::as_f64).unwrap_or(0.0);',
  '    s.done_with(&run.part, Json::obj().set("made", run.parts.len()).set("version", run.version).set("rev", rev).set("plugin", run.plugin.as_str()));',
  "}",
  "",
].join("\n");
check("the plate starts empty: the plugin needs no part open", session.objects.length === 0);
const first = await call("recipe_run", { source: outer, name: "one-wheel" });
check("a recipe runs a kept plugin and ends on the part it made", first.ok === true && typeof first.object === "string" && (first.metrics as Reply)?.made === 1 && (first.metrics as Reply)?.version === 1 && (first.metrics as Reply)?.plugin === "gear-on-arbor", first);
const wheel = String(first.object);
check("the part is on the plate, named by the plugin, and the run's own", ids().includes(wheel) && session.find(wheel)?.name === "centre wheel" && session.find(wheel)?.rustRecipe === "one-wheel", { ids: ids(), name: session.find(wheel)?.name });
const stampOf = (object: string) => {
  const tree = session.find(object)?.tree;
  return tree ? [...tree.nodes.values()].find((node) => node.plugin)?.plugin : undefined;
};
const gearSha = bodyHash(gearOnArbor(1));
check("the run's stamp pins the plugin it ran, by version and hash", JSON.stringify(stampOf(wheel)?.uses) === JSON.stringify({ "gear-on-arbor": { version: 1, sha256: gearSha } }), stampOf(wheel));
check("so does the run's record", JSON.stringify(session.rustRecipes.get("one-wheel")?.uses) === JSON.stringify({ "gear-on-arbor": { version: 1, sha256: gearSha } }), session.rustRecipes.get("one-wheel"));
check("and the project keeps the plugin's code by its hash", (session.projectPlugins.get(gearSha) ?? "").includes("plugin: gear-on-arbor"), [...session.projectPlugins.keys()]);

// --- A refusal the recipe handles: nothing of the nested run is left, and the recipe carries on.
keep("picky-gear", [
  "use lime_recipe::{ops, Json, Session};",
  "",
  "fn main() {",
  "    let mut s = Session::start();",
  '    let teeth = s.count("teeth", 24).range(1, 500).get();',
  "    let part = s.solid_new(ops::cylinder(10.0, 3.0)).unwrap();",
  '    if teeth > 100 { s.refuse("More than 100 teeth is more than this plugin cuts."); }',
  "    s.done_with(&part, Json::obj().set(\"teeth\", teeth));",
  "}",
  "",
].join("\n"));
const handled = [
  "use lime_recipe::{ops, Json, Session};",
  "",
  "fn main() {",
  "    let mut s = Session::start();",
  '    let said = match s.run_plugin("picky-gear", Json::obj().set("teeth", 140)) { Ok(_) => "ran".to_string(), Err(e) => e.reason };',
  '    let missing = match s.run_plugin("no-such-plugin", Json::obj()) { Ok(_) => "ran".to_string(), Err(e) => e.reason };',
  "    s.log(&said);",
  "    s.log(&missing);",
  "    let own = s.solid_new(ops::cuboid(5.0, 5.0, 5.0)).unwrap();",
  "    s.done(&own);",
  "}",
  "",
].join("\n");
const before = ids();
const carried = await call("recipe_run", { source: handled, name: "handled" });
const notes = (carried.notes ?? []) as string[];
check("a handled refusal: the recipe carries on and ends on its own part", carried.ok === true && ids().length === before.length + 1, { carried, ids: ids() });
check("the nested refusal reads as the plugin's title and its own sentence", notes.some((note) => note.includes("picky-gear: More than 100 teeth is more than this plugin cuts.")), notes);
check("a plugin that is not in the library is refused with a sentence", notes.some((note) => note.includes("No plugin is named no-such-plugin in your library")), notes);
check("the refused nested run left no part behind", carried.created !== undefined && (carried.created as string[]).length === 1, carried.created);

// --- One the recipe does not handle: the whole run is taken back, the parts an earlier nested run made too.
const unhandled = [
  "use lime_recipe::{Json, Session};",
  "",
  "fn main() {",
  "    let mut s = Session::start();",
  '    let a = s.run_plugin("gear-on-arbor", Json::obj().set("teeth", 20)).unwrap();',
  '    s.run_plugin("picky-gear", Json::obj().set("teeth", 300)).unwrap();',
  "    s.done(&a.part);",
  "}",
  "",
].join("\n");
const plateBefore = ids();
const failedRun = await call("recipe_run", { source: unhandled, name: "unhandled" });
check("an unhandled nested refusal fails the run with the plugin's sentence", failedRun.ok === false && String(failedRun.reason).includes("picky-gear: More than 100 teeth"), failedRun);
check("and takes everything back, the first plugin's gear too", JSON.stringify(ids()) === JSON.stringify(plateBefore), { before: plateBefore, now: ids() });

// --- A plugin cannot run itself through another.
const runs = (other: string) => [
  "use lime_recipe::{Json, Session};",
  "",
  "fn main() {",
  "    let mut s = Session::start();",
  `    let r = s.run_plugin("${other}", Json::obj()).unwrap();`,
  "    s.done(&r.part);",
  "}",
  "",
].join("\n");
keep("loop-a", runs("loop-b"));
keep("loop-b", runs("loop-a"));
const looped = await call("recipe_run", { plugin: "loop-a" });
check("a cycle is refused with a sentence that names the loop", looped.ok === false && String(looped.reason).includes("loop-a runs loop-b runs loop-a: a plugin cannot run itself"), looped);
check("and nothing is left on the plate", JSON.stringify(ids()) === JSON.stringify(plateBefore), ids());

// --- Trust: a plugin marked imported, which no person has run yet, never runs from inside another.
const importedPath = keep("imported-gear", gearOnArbor(9), 1, "Imported gear");
const importedSha = bodyHash(gearOnArbor(9));
writeFileSync(join(library, "imported.json"), JSON.stringify({ "imported-gear": { sha256: importedSha, from: "file", at: "2026-11-15" } }));
const trusting = await call("recipe_run", { source: runs("imported-gear"), name: "trusting" });
check("an imported plugin nobody ran is refused from inside another", trusting.ok === false && String(trusting.reason).includes("was imported and no person has run it yet"), trusting);
rmSync(join(library, "imported.json"));
rmSync(importedPath);

// --- Versions: the run is pinned to v1. The library moves on to v2: a rerun with new values runs v1 and says so; a new
// run takes v2.
copyFileSync(gearPath, join(library, "gear-on-arbor.v1.rs"));
keep("gear-on-arbor", gearOnArbor(2), 2, "Gear on arbor");
const rerun = await call("recipe_run", { object: wheel, params: { teeth: 36 } });
check("a rerun with new values runs the pinned v1", rerun.ok === true && (rerun.metrics as Reply)?.rev === 1 && (rerun.metrics as Reply)?.version === 1, rerun);
check("under the same handle", rerun.object === wheel && JSON.stringify(rerun.replaced) === JSON.stringify([wheel]), rerun);
check("and says the library has a newer version", ((rerun.notes ?? []) as string[]).some((note) => note.includes("v2 of gear-on-arbor is in your library; this run used v1")), rerun.notes);
const fresh = await call("recipe_run", { source: outer, name: "one-wheel-new" });
check("a new run takes the library's v2", fresh.ok === true && (fresh.metrics as Reply)?.rev === 2 && (fresh.metrics as Reply)?.version === 2, fresh);
await call("object_remove", { object: String(fresh.object) });
const asked = await call("recipe_run", { source: outer.replace('s.run_plugin("gear-on-arbor", ', 's.run_plugin_version("gear-on-arbor", 1, '), name: "asked-v1" });
check("run_plugin_version runs the version asked for", asked.ok === true && (asked.metrics as Reply)?.rev === 1, asked);
await call("object_remove", { object: String(asked.object) });

// --- The project keeps the pinned code: saved, the library emptied, reopened, the rerun still builds v1.
await call("project_save", { name: "uses.lime" });
const doc = JSON.parse(readFileSync(join(workspace, "uses.lime"), "utf8")) as { project?: { plugins?: Record<string, string> }; plugins?: Record<string, string> };
const savedPlugins = doc.project?.plugins ?? doc.plugins ?? {};
check("the saved project carries gear-on-arbor v1's code", (savedPlugins[gearSha] ?? "").includes("plugin: gear-on-arbor"), Object.keys(savedPlugins));
for (const name of ["gear-on-arbor.rs", "gear-on-arbor.v1.rs"]) rmSync(join(library, name));
session = new Session(fakeEngine());
session.clientName = "plugin-recipes-test";
const opened = await call("project_open", { path: "uses.lime" });
check("the project opens", opened.ok === true, opened);
const offline = await call("recipe_run", { object: wheel, params: { teeth: 40 } });
check("with the library gone, the rerun builds the pinned v1 from the project's copy", offline.ok === true && (offline.metrics as Reply)?.rev === 1 && offline.object === wheel, offline);

// --- In the app (src/recipe/apply.ts and app-nested.ts): the same plugins through the window's run, as the Plugins
// panel runs them with nothing open, the calls answered by AppRecipeCalls against the engine's trees.
{
  const { RecipeHost, recipeCrateDir } = await import("./recipe.ts");
  const { runPluginFresh } = await import("../src/recipe/apply.ts");
  const { readPluginFile } = await import("../src/plugin-file.ts");
  type AppEngine = import("../src/recipe/app-calls.ts").AppEngine;
  type AppPluginSources = import("../src/recipe/app-nested.ts").AppPluginSources;
  type PluginCode = import("../src/recipe/nested.ts").PluginCode;
  const host = new RecipeHost({ crateDir: recipeCrateDir(new URL("./recipe.ts", import.meta.url).href), root: mkdtempSync(join(tmpdir(), "lime-plugin-recipes-app-")), lust });
  const engine = fakeEngine();
  const appEngine: AppEngine = {
    tree: async (_key, _node, request) => JSON.parse(await engine.modelTree(JSON.stringify(request))) as Reply,
    open: async (request) => JSON.parse(await engine.modelTree(JSON.stringify(request))) as Reply,
  };
  let n = 0;
  const env = { chordMm: 0.05, params: {}, newPart: () => ({ id: `app_${++n}`, key: `app-tree-${n}` }) };
  /** The library the window read: id to the file's text. */
  const libraryOf = (files: Record<string, string>, approved = true): AppPluginSources => ({
    sources: (id) => ({
      project: () => null,
      library: (version) => {
        const text = files[id];
        const file = text ? readPluginFile(text) : null;
        return file && (version === undefined || version === file.version) ? ({ version: file.version, sha256: bodyHash(file.body), text } satisfies PluginCode) : null;
      },
      olderVersions: () => [],
    }),
    untrusted: (file) => (approved ? null : `${file.title} has not been run here yet, so it does not run from inside another plugin.`),
  });
  const textOf = (id: string, body: string, title = id) => `//! ---\n//! plugin: ${id}\n//! title: ${title}\n//! version: 1\n//! description: test\n//! author: test\n//! api: 1.16\n//! source-sha256: ${bodyHash(body)}\n//! created: 2026-11-15\n//! target: new\n//! params: []\n//! ---\n${body}`;
  const gears = { "gear-on-arbor": textOf("gear-on-arbor", gearOnArbor(1), "Gear on arbor") };
  const pairBody = [
    "use lime_recipe::{Json, Session};",
    "",
    "fn main() {",
    "    let mut s = Session::start();",
    '    let a = s.run_plugin("gear-on-arbor", Json::obj().set("teeth", 12).set("name", "pinion")).unwrap();',
    '    let b = s.run_plugin("gear-on-arbor", Json::obj().set("teeth", 24).set("name", "wheel")).unwrap();',
    "    s.done_with(&b.part, Json::obj().set(\"parts\", a.parts.len() + b.parts.len()));",
    "}",
    "",
  ].join("\n");
  const context = { bedMm: [220, 220, 250] as [number, number, number], nozzleMm: 0.4 };
  const run = (body: string, plugins: AppPluginSources) => runPluginFresh({ part: null, plugin: { id: "wheel-pair", version: 1, sha256: bodyHash(body), api: "1.16" }, body, params: {}, context, recipes: host, engine: appEngine, env, runId: "a1b2c3d4", plugins });
  const pair = await run(pairBody, libraryOf(gears));
  check("in the app, a plugin runs another twice with nothing open and keeps both parts", pair.ok === true && pair.kept.length === 2 && pair.kept.map((row) => row.part.name).join(",") === "pinion,wheel", pair.ok ? pair.kept.map((row) => row.part.name) : pair);
  if (pair.ok) {
    check("each part is stamped by the outer run, with the plugin it ran pinned", pair.kept.every((row) => row.stamp.plugin === "wheel-pair" && JSON.stringify(row.stamp.uses) === JSON.stringify({ "gear-on-arbor": { version: 1, sha256: bodyHash(gearOnArbor(1)) } })), pair.kept.map((row) => row.stamp));
    check("and the run hands back the code it ran, for the project's copy", pair.used.length === 1 && pair.used[0]!.text === gears["gear-on-arbor"], pair.used.map((row) => row.sha256));
  }
  const untrusted = await run(pairBody, libraryOf(gears, false));
  check("in the app, a plugin nobody approved does not run from inside another", untrusted.ok === false && untrusted.reason.includes("has not been run here yet"), untrusted);
  const selfish = await run(runs("wheel-pair"), libraryOf({ "wheel-pair": textOf("wheel-pair", runs("wheel-pair")) }));
  check("in the app, a plugin that runs itself is refused with the loop", selfish.ok === false && selfish.reason.includes("wheel-pair runs wheel-pair: a plugin cannot run itself"), selfish);
  const none = await runPluginFresh({ part: null, plugin: { id: "wheel-pair", version: 1, sha256: bodyHash(pairBody), api: "1.16" }, body: pairBody, params: {}, context, recipes: host, engine: appEngine, env, runId: "a1b2c3d5" });
  check("a run given no plugin sources says it cannot run other plugins", none.ok === false && none.reason.includes("cannot run other plugins"), none);
}

if (failed > 0) {
  console.error(`plugin-recipes: ${failed} failed`);
  process.exit(1);
}
console.log("plugin-recipes: all passed");
process.exit(0);
