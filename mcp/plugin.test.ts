/**
 * Plugins through the MCP (docs/plan-recipe-plugins.md milestones 1 and 2): keep a recipe, find it, run it by id,
 * versions, a name clash, a hand-edited file, remove, typed parameters and describe mode, the save checks (late
 * parameters, defaults that do not build), the API level, and own parts only for every recipe_run. Real lust, the
 * stand-in engine. Skips without lust; LIME_RECIPE_REQUIRED=1 makes that a failure.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findLust } from "./recipe.ts";

const lust = findLust();
if (!lust) {
  if (process.env.LIME_RECIPE_REQUIRED === "1") {
    console.error("plugin: lust is required here (LIME_LUST)");
    process.exit(1);
  }
  console.log("plugin: skipped (set LIME_LUST to a lust build)");
  process.exit(0);
}

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-plugin-ws-"));
const library = mkdtempSync(join(tmpdir(), "lime-plugin-lib-"));
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
const session = new Session(fakeEngine());
session.clientName = "plugin-test";
const call = (name: string, args: unknown = {}) => session.call(name, args);
const volume = async (object: string) => Number((await call("model_describe", { object })).volumeMm3);

const flange = (tweak = "") => [
  "use lime_recipe::{ops, Json, Session};",
  "",
  "fn main() {",
  "    let mut s = Session::start();",
  '    let d = s.number("diameter", 80.0).range(20.0, 250.0).step(0.5).unit("mm").label("Outer diameter").get();',
  '    let holes = s.count("holes", 6).range(3, 24).label("Bolt holes").get();',
  '    let bore = s.toggle("bore", true).label("Centre bore").get();',
  '    let edge = s.choice("edge", &["fillet", "chamfer", "sharp"], "fillet").get();',
  `    let p = s.solid_new(ops::cuboid(d, 20.0, 4.0${tweak})).unwrap();`,
  "    for i in 0..holes {",
  "        let x = -d / 2.0 + d * (i as f64 + 0.5) / holes as f64;",
  `        s.apply(&p, ops::boolean("fuse", ops::cylinder(1.5, 3.0), [x, 0.0, 4.0${tweak}])).unwrap();`,
  "    }",
  "    if bore {",
  '        s.log("bore");',
  "    }",
  '    s.done_with(&p, Json::obj().set("holes", holes).set("edge", edge.as_str()));',
  "}",
  "",
].join("\n");

// --- Keep: a run that worked, kept with one field.
const kept = await call("recipe_run", { source: flange(), name: "flange", keep: { title: "Bolt-circle flange", description: "A round flange with bolt holes on a circle and an optional centre bore." } });
const keptRow = kept.kept as { id: string; version: number; sha256: string } | undefined;
check("keep saves the run as a plugin", kept.ok === true && keptRow?.id === "bolt-circle-flange" && keptRow.version === 1 && /^[0-9a-f]{64}$/.test(keptRow.sha256), kept);
const file = join(library, "bolt-circle-flange.rs");
const text = existsSync(file) ? readFileSync(file, "utf8") : "";
check("the file is the recipe after a //! header", text.startsWith("//! ---\n//! plugin: bolt-circle-flange\n") && text.endsWith(flange()) && text.includes("//! made-by: plugin-test") && text.includes("//! api: 1.2") && text.includes("//! target: new"), text.slice(0, 900));
check("the header caches the declared parameters", text.includes('"name":"diameter","kind":"number","default":80,"min":20,"max":250,"step":0.5,"unit":"mm","label":"Outer diameter"') && text.includes('"options":["fillet","chamfer","sharp"]'), text.slice(0, 900));

// --- Find it.
const listed = await call("plugin", { action: "list", query: "flange holes" });
const rows = (listed.plugins ?? []) as { id: string; v?: number; target?: string; params?: string; data?: { title?: string } }[];
const row = rows.find((r) => r.id === "bolt-circle-flange");
check("list finds it by a word of what it does", listed.ok === true && !!row && row.v === 1 && row.target === "new" && row.data?.title === "Bolt-circle flange", listed);
check("list shows the parameters with units and ranges", row?.params === 'diameter mm 80 [20-250], holes 6 [3-24], bore true, edge "fillet" (fillet|chamfer|sharp)', row?.params);
check("list shows this session's runs as drafts", rows.some((r) => r.id === "draft:flange"), rows.map((r) => r.id));
check("a query that matches nothing lists nothing of the library", ((await call("plugin", { action: "list", query: "gearbox" })).plugins as unknown[]).length === 0);
const got = await call("plugin", { action: "get", id: "bolt-circle-flange" });
check("get gives the header and parameters without the source", got.ok === true && got.version === 1 && (got.params as unknown[]).length === 4 && got.source === undefined && (got.data as { description?: string }).description?.startsWith("A round flange") === true, got);
const withSource = await call("plugin", { action: "get", id: "bolt-circle-flange", withSource: true });
check("withSource adds the recipe", withSource.source === flange(), String(withSource.source).slice(0, 200));

// --- Run it by id: the same part as the run that was kept.
const byId = await call("recipe_run", { plugin: "bolt-circle-flange" });
check("recipe_run {plugin} runs the saved recipe", byId.ok === true && (byId.plugin as { id: string; version: number }).version === 1 && (byId.metrics as { holes: number }).holes === 6, byId);
check("the same values give the same solid", Math.abs((await volume(String(byId.object))) - (await volume(String(kept.object)))) < 1e-6);
const eight = await call("recipe_run", { plugin: "bolt-circle-flange", params: { holes: 8, diameter: 999 } });
check("values out of range are held to it, with a note", eight.ok === true && (eight.metrics as { holes: number }).holes === 8 && JSON.stringify(eight.notes).includes("diameter 999 is above its maximum; the run used 250."), eight);
const none = await call("recipe_run", { plugin: "no-such-plugin" });
check("an unknown plugin names what there is", none.ok === false && String(none.reason).includes("bolt-circle-flange"), none);

// --- Versions: the same body keeps its version; a changed body under the plugin's name is the next one.
const again = await call("plugin", { action: "save", from: "flange", title: "Bolt-circle flange", description: "Same code, new words." });
check("saving the same body keeps the version", again.ok === true && again.id === "bolt-circle-flange" && again.version === 1 && !existsSync(join(library, "bolt-circle-flange.v1.rs")), again);
const edited = await call("recipe_run", { source: flange(" + 1.0"), name: "bolt-circle-flange", keep: { title: "Bolt-circle flange", description: "Thicker." } });
check("a changed body kept under the plugin's name is version 2", edited.ok === true && (edited.kept as { version: number } | undefined)?.version === 2 && existsSync(join(library, "bolt-circle-flange.v1.rs")), edited);

// --- A name clash: another recipe with the same title becomes <id>-2.
const other = await call("recipe_run", { source: flange(" + 2.0"), name: "other", keep: { title: "Bolt-circle flange", description: "Someone else's." } });
check("another recipe with the same title is kept beside it", other.ok === true && (other.kept as { id: string } | undefined)?.id === "bolt-circle-flange-2", other);

// --- A file edited by hand: the hash and parameters are worked out again, the version goes up, and it says so.
const path2 = join(library, "bolt-circle-flange-2.rs");
writeFileSync(path2, readFileSync(path2, "utf8").replace('s.count("holes", 6)', 's.count("holes", 5)'));
const reread = await call("plugin", { action: "get", id: "bolt-circle-flange-2" });
check("an edited file is read again as a new version", reread.ok === true && reread.version === 2 && String(reread.note).includes("changed outside") && JSON.stringify(reread.params).includes('"default":5'), reread);
check("and its header now matches", readFileSync(path2, "utf8").includes("//! version: 2"));

// --- Saving checks the plugin: parameters declared late, defaults that do not build, sandbox text caps.
const late = [
  "use lime_recipe::{ops, Session};",
  "fn main() {",
  "    let mut s = Session::start();",
  "    let p = s.solid_new(ops::cuboid(10.0, 10.0, 10.0)).unwrap();",
  '    let w = s.number("width", 4.0).get();',
  "    s.apply(&p, ops::hole_through([0.0, 0.0, 10.0], [0.0, 0.0, -1.0], w)).unwrap();",
  "    s.done(&p);",
  "}",
].join("\n");
const lateRun = await call("recipe_run", { source: late, name: "late", keep: { title: "Late", description: "x" } });
check("a parameter declared after the first call is refused at keep, with its line", lateRun.ok === true && String(lateRun.keepRefused).includes("Declare width before the first call (line 5)") && !existsSync(join(library, "late.rs")), lateRun);
const fragile = [
  "use lime_recipe::{ops, Session};",
  "fn main() {",
  "    let mut s = Session::start();",
  '    let n = s.count("n", 0).range(0, 9).get();',
  '    if n == 0 { panic!("n must be at least 1"); }',
  "    let p = s.solid_new(ops::cuboid(10.0, 10.0, n as f64)).unwrap();",
  "    s.done(&p);",
  "}",
].join("\n");
const fragileRun = await call("recipe_run", { source: fragile, name: "fragile", params: { n: 3 }, keep: { title: "Fragile", description: "x" } });
check("a plugin whose defaults do not build is not kept", fragileRun.ok === true && String(fragileRun.keepRefused).startsWith("This plugin does not build with its own defaults") && !existsSync(join(library, "fragile.rs")), fragileRun);
const noTitle = await call("plugin", { action: "save", from: "flange", title: "  " });
check("a save needs a title", noTitle.ok === false && /title/.test(String(noTitle.reason)), noTitle);

// --- A plugin that changes a part: target object, run on the part given.
const studs = [
  "use lime_recipe::{ops, Session};",
  "fn main() {",
  "    let mut s = Session::start();",
  '    let n = s.count("studs", 3).range(1, 10).get();',
  "    let p = s.object().unwrap();",
  "    for i in 0..n {",
  "        s.apply(&p, ops::boolean(\"fuse\", ops::cylinder(1.0, 3.0), [-6.0 + 4.0 * i as f64, 0.0, 10.0])).unwrap();",
  "    }",
  "    s.done(&p);",
  "}",
].join("\n");
const block = String((await call("solid_new", { primitive: "box", dx: 30, dy: 20, dz: 10 })).object);
const studRun = await call("recipe_run", { source: studs, name: "studs", object: block, keep: { title: "Studs on top", description: "A row of studs on a part." } });
const studFile = readFileSync(join(library, "studs-on-top.rs"), "utf8");
check("a plugin that needs a part is kept with target object", studRun.ok === true && (studRun.kept as { id: string } | undefined)?.id === "studs-on-top" && studFile.includes("//! target: object"), { studRun, head: studFile.slice(0, 600) });
// The kept run's steps are a plugin step now (milestone 3), so the undo names the plugin it was kept as.
check("the keep's check run on the part is taken back: one undo is the recipe", (await call("model_undo", { object: block })).group === "recipe studs-on-top");
const needsPart = await call("recipe_run", { plugin: "studs-on-top" });
check("running it without a part says it needs one", needsPart.ok === false && /needs a part/.test(String(needsPart.reason)), needsPart);

// --- Own parts only (O8): a recipe may touch the part it was given and the parts it made, nothing else.
const bystander = String((await call("solid_new", { primitive: "box", dx: 5, dy: 5, dz: 5 })).object);
const reach = [
  "use lime_recipe::{ops, Session};",
  "fn main() {",
  "    let mut s = Session::start();",
  "    let p = s.object().unwrap();",
  `    let other = lime_recipe::Part { object: "${bystander}".to_string() };`,
  "    let r = s.apply(&other, ops::hole_through([0.0, 0.0, 5.0], [0.0, 0.0, -1.0], 1.0));",
  '    if let Err(e) = r { s.log(&e.reason); }',
  "    s.done(&p);",
  "}",
].join("\n");
const before = await volume(bystander);
const reached = await call("recipe_run", { source: reach, name: "reach", object: block });
check("a call on another part is refused", reached.ok === true && JSON.stringify(reached.refused).includes("A recipe can change only the part it was given and the parts it made") && (await volume(bystander)) === before, reached);

// --- The API level: a plugin for a newer crate is refused without a build.
writeFileSync(join(library, "future.rs"), readFileSync(file, "utf8").replace("plugin: bolt-circle-flange", "plugin: future").replace("api: 1.2", "api: 9.0"));
const future = await call("recipe_run", { plugin: "future" });
check("a plugin for a newer API is refused before it builds", future.ok === false && String(future.reason).includes("needs recipe API 9.0") && future.diagnostics === undefined, future);

// --- The project keeps the drafts its parts use (#527's rustRecipes): made by them or changed by them, with the stamp.
await call("project_save", { name: "plugins.lime" });
const doc = JSON.parse(readFileSync(join(process.env.LIME_MCP_WORKSPACE!, "plugins.lime"), "utf8")) as { mcpModel?: { rustRecipes?: Record<string, { sha256?: string; changed?: string[]; plugin?: { id: string; version: number } }> } };
const kept2 = doc.mcpModel?.rustRecipes ?? {};
check("the project keeps a kept run with its plugin stamp and hash", kept2.flange?.plugin?.id === "bolt-circle-flange" && /^[0-9a-f]{64}$/.test(kept2.flange?.sha256 ?? ""), kept2.flange);
check("the project keeps a run that changed a part, naming the part", JSON.stringify(kept2.studs?.changed) === JSON.stringify([block]), kept2.studs);
const later = new Session(fakeEngine());
await later.call("project_open", { path: "plugins.lime" });
const laterList = (await later.call("plugin", { action: "list", query: "flange" })).plugins as { id: string; from?: string }[];
check("a later session on the project lists its drafts", laterList.some((r) => r.id === "draft:flange" && r.from === "bolt-circle-flange"), laterList);

// --- session_info counts the library; remove takes a plugin and its older versions.
const info = await call("session_info", {});
check("session_info counts the library", String(info.plugins).startsWith("Plugins: 4 in your library"), info.plugins);
const removed = await call("plugin", { action: "remove", id: "bolt-circle-flange" });
check("remove takes the plugin and its older versions", removed.ok === true && removed.files === 2 && !readdirSync(library).some((n) => n.startsWith("bolt-circle-flange.")), { removed, left: readdirSync(library) });
check("the part built with it stays", (await volume(String(byId.object))) > 0);

if (failed > 0) {
  console.error(`plugin: ${failed} failed`);
  process.exit(1);
}
console.log("plugin: all passed");
