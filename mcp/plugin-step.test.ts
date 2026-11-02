/**
 * Plugin steps through the MCP (docs/plan-recipe-plugins.md milestone 3): a plugin run is stamped on the part it changed
 * or made, the project keeps its own copy of the plugin, and recipe_run {plugin, object, params} rebuilds the step with
 * the steps after it replayed, as one undo step. Real lust; the real engine when LIME_OCCT_BRIDGE and the MCP addon are
 * there (CI's OCCT job), else the stand-in engine. Skips without lust; LIME_RECIPE_REQUIRED=1 makes that a failure.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { engineCandidates, fakeEngine, loadEngineWorker } from "./engine.ts";
import { findLust } from "./recipe.ts";

const lust = findLust();
if (!lust) {
  if (process.env.LIME_RECIPE_REQUIRED === "1") {
    console.error("plugin-step: lust is required here (LIME_LUST)");
    process.exit(1);
  }
  console.log("plugin-step: skipped (set LIME_LUST to a lust build)");
  process.exit(0);
}

const workspace = mkdtempSync(join(tmpdir(), "lime-plugin-step-ws-"));
process.env.LIME_MCP_WORKSPACE = workspace;
const library = mkdtempSync(join(tmpdir(), "lime-plugin-step-lib-"));
process.env.LIME_PLUGINS_DIR = library;
process.env.LIME_MCP_MODEL_TIMEOUT_S = process.env.LIME_MCP_MODEL_TIMEOUT_S ?? "25";

const root = fileURLToPath(new URL("..", import.meta.url));
const bridge = process.env.LIME_OCCT_BRIDGE ?? "";
const addon = engineCandidates(root).find((path) => existsSync(path)) ?? "";
const real = !!bridge && existsSync(bridge) && !!addon;
console.log(`plugin-step: ${real ? "real Open CASCADE" : "stand-in engine"}`);

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    console.log(`ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name} ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 3000)}`);
}

const { Session } = await import("./session.ts");
const engine = () => (real ? loadEngineWorker(root) : fakeEngine());
let session = new Session(engine());
session.clientName = "plugin-step-test";
const call = (name: string, args: unknown = {}) => session.call(name, args);
const volume = async (object: string) => Number((await call("model_describe", { object })).volumeMm3);
interface Row { id: string; parent: string | null; label: string; current: boolean; plugin?: { id: string; version: number; params: Record<string, unknown> }; run?: string }
const history = async (object: string) => ((await call("model_history", { object, limit: 100 })).nodes ?? []) as Row[];
/** The rows from the root to the shown step. */
const shownPath = (rows: Row[]) => {
  const by = new Map(rows.map((row) => [row.id, row]));
  const out: Row[] = [];
  for (let at = rows.find((row) => row.current); at; at = at.parent ? by.get(at.parent) : undefined) out.unshift(at);
  return out;
};
const near = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b));

// --- A plugin that changes the part it is given: a row of studs on top.
const studs = [
  "use lime_recipe::{ops, Session};",
  "fn main() {",
  "    let mut s = Session::start();",
  '    let n = s.count("studs", 3).range(1, 10).label("Studs").get();',
  '    let r = s.number("radius", 1.0).range(0.5, 3.0).unit("mm").get();',
  "    let p = s.object().unwrap();",
  "    for i in 0..n {",
  '        s.apply(&p, ops::boolean("fuse", ops::cylinder(r, 3.0), [-10.0 + 4.0 * i as f64, 0.0, 10.0])).unwrap();',
  "    }",
  "    s.done(&p);",
  "}",
  "",
].join("\n");

// --- Build: run it on a block and keep it, then two later steps of the person's own.
const block = String((await call("solid_new", { primitive: "box", dx: 40, dy: 20, dz: 10 })).object);
const first = await call("recipe_run", { source: studs, name: "stud-row", object: block, keep: { title: "Stud row", description: "A row of studs along the top." } });
check("the plugin runs on the block and is kept", first.ok === true && (first.kept as { id?: string } | undefined)?.id === "stud-row", first);
check("the reply names the stamped step", (first.step as { steps?: number } | undefined)?.steps === 3, first.step);
let rows = await history(block);
let path = shownPath(rows);
const stamped = path.filter((row) => row.plugin);
check("the run's first step carries the stamp: the plugin, its version, its values", stamped.length === 1 && stamped[0]!.plugin!.id === "stud-row" && stamped[0]!.plugin!.version === 1 && stamped[0]!.plugin!.params.studs === undefined, stamped);
const runRows = path.filter((row) => row.run);
check("every step of the run carries the run id, 1/3 to 3/3", runRows.length === 3 && runRows.every((row, i) => row.run === `${runRows[0]!.run!.split(" ")[0]} ${i + 1}/3`), runRows.map((row) => row.run));
const lump = await call("model_apply", { object: block, probe: true, op: { kind: "boolean", op: "fuse", primitive: "box", origin: [12, -4, 10], dx: 6, dy: 8, dz: 2 } });
const bore = await call("model_apply", { object: block, probe: true, op: { kind: "boolean", op: "cut", primitive: "cylinder", radius: 2, height: 30, origin: [-15, 0, -5] } });
check("two steps of the person's own apply", lump.ok === true && bore.ok === true, { lump, bore });
rows = await history(block);
path = shownPath(rows);
check("two later steps follow the run", path.length === 6 && path.slice(4).every((row) => !row.run), path.map((row) => row.label));
const laterLabels = path.slice(4).map((row) => row.label);
const beforeVolume = await volume(block);
const beforeNode = path.at(-1)!.id;

// --- One undo of a later step is that step; the run is one undo step.
const undoCut = await call("model_undo", { object: block });
const undoFuse = await call("model_undo", { object: block });
const undoRun = await call("model_undo", { object: block });
check("one undo takes the whole run back", undoRun.ok === true && undoRun.group === "recipe stud-row" && undoRun.node === path[0]!.id, { undoCut, undoFuse, undoRun });
const redoRun = await call("model_redo", { object: block });
check("one redo brings the whole run again", redoRun.ok === true && redoRun.node === path[3]!.id && redoRun.group === "recipe stud-row", redoRun);
await call("model_redo", { object: block });
await call("model_redo", { object: block });

// --- Rebuild with a new value: a new branch from the step before the run, the later steps replayed on it.
const five = await call("recipe_run", { plugin: "stud-row", object: block, params: { studs: 5 } });
check("a rebuild with a new value works", five.ok === true && (five.rebuilt as { replayed?: number } | undefined)?.replayed === 2, five);
rows = await history(block);
path = shownPath(rows);
check("the rebuilt run has five steps and its new value", path.filter((row) => row.run && !path.slice(-2).includes(row)).length === 5 && path.find((row) => row.plugin)?.plugin?.params.studs === 5, path.map((row) => [row.label, row.run, row.plugin?.params]));
check("the later steps are built again after it, with their labels", JSON.stringify(path.slice(-2).map((row) => row.label)) === JSON.stringify(laterLabels) && path.slice(-2).every((row) => !row.run), path.map((row) => row.label));
check("the rebuild branches from the step before the run", path[1]!.parent === path[0]!.id && rows.filter((row) => row.parent === path[0]!.id).length === 2, rows.map((row) => [row.id, row.parent, row.label]));
const fiveVolume = await volume(block);
if (real) check("more studs, more volume", fiveVolume > beforeVolume + 1, { beforeVolume, fiveVolume });
const undoRebuild = await call("model_undo", { object: block });
check("one undo goes back to the old values on the old branch", undoRebuild.ok === true && undoRebuild.node === beforeNode && near(await volume(block), beforeVolume), { undoRebuild, beforeNode });
const redoRebuild = await call("model_redo", { object: block });
check("one redo goes to the rebuild again", redoRebuild.ok === true && near(await volume(block), fiveVolume), redoRebuild);

// --- Save: the stamp and run ids in the tree, the plugin's file in the project's own `plugins` map.
await call("project_save", { name: "steps.lime" });
const file = join(workspace, "steps.lime");
const doc = JSON.parse(readFileSync(file, "utf8")) as { plugins?: Record<string, string>; objects: { id: string; modelTree?: { nodes: { plugin?: { sha256: string; plugin: string }; run?: unknown }[] } }[] };
const savedNodes = doc.objects.find((obj) => obj.id === block)?.modelTree?.nodes ?? [];
const savedStamps = savedNodes.filter((node) => node.plugin);
const sha = savedStamps.at(-1)?.plugin?.sha256 ?? "";
check("the saved tree keeps the stamps and the run ids", savedStamps.length === 2 && savedNodes.filter((node) => node.run).length === 8, savedStamps);
check("the project carries the plugin's file under its hash", typeof doc.plugins?.[sha] === "string" && doc.plugins[sha]!.startsWith("//! ---\n//! plugin: stud-row\n") && doc.plugins[sha]!.includes('s.count("studs", 3)'), Object.keys(doc.plugins ?? {}));

// --- Reopen with the library gone: nothing replays, the stamp is intact, and a rebuild with the same values lands on
// the same solid, from the project's copy.
rmSync(join(library, "stud-row.rs"));
const reopenEngine = engine();
session = new Session(reopenEngine);
const opened = await call("project_open", { path: "steps.lime" });
check("the project opens", opened.ok === true, opened);
const fake = real ? null : (reopenEngine as ReturnType<typeof fakeEngine>);
const callsAtOpen = fake ? fake.calls.length : 0;
rows = await history(block);
path = shownPath(rows);
check("after reopening the stamp is intact", path.find((row) => row.plugin)?.plugin?.params.studs === 5 && path.filter((row) => row.run).length === 5, path.map((row) => [row.label, row.run]));
if (fake) check("opening built nothing again", !fake.calls.slice(0, callsAtOpen).some((c) => c === "edit" || c === "apply"), fake.calls.slice(0, callsAtOpen));
const reopenedVolume = await volume(block);
const reopenedNode = path.at(-1)!.id;
const same = await call("recipe_run", { plugin: "stud-row", object: block });
check("a rebuild after reopening runs from the project's copy", same.ok === true && (same.plugin as { version?: number } | undefined)?.version === 1, same);
check("with unchanged values it lands on the same fingerprint", (same.rebuilt as { sameSolid?: boolean } | undefined)?.sameSolid === true && !JSON.stringify(same.notes ?? []).includes("different solid"), same);
// The stand-in's replay does not keep volumes; the real kernel's does.
if (real) check("and the same volume", near(await volume(block), reopenedVolume), { reopenedVolume });
const undoSame = await call("model_undo", { object: block });
check("and is one undo step there too", undoSame.ok === true && undoSame.node === reopenedNode, { undoSame, reopenedNode });

// --- D9: a project whose copy was edited outside the app, and one with no copy anywhere, keep the part and say why.
const edited = { ...doc, plugins: { [sha]: doc.plugins![sha]!.replace("-10.0 + 4.0", "-11.0 + 4.0") } };
writeFileSync(join(workspace, "edited.lime"), JSON.stringify(edited));
session = new Session(engine());
await call("project_open", { path: "edited.lime" });
const changed = await call("recipe_run", { plugin: "stud-row", object: block, params: { studs: 4 } });
check("an edited copy is named, and nothing changes", changed.ok === false && String(changed.reason).includes("changed outside the app"), changed);
// The project's drafts (#527's rustRecipes) are a copy too, so this project carries neither.
const { plugins: _plugins, ...bare } = doc as typeof doc & { mcpModel?: Record<string, unknown> };
writeFileSync(join(workspace, "bare.lime"), JSON.stringify({ ...bare, mcpModel: { ...bare.mcpModel, rustRecipes: {} } }));
session = new Session(engine());
await call("project_open", { path: "bare.lime" });
const bareVolume = await volume(block);
const missing = await call("recipe_run", { plugin: "stud-row", object: block, params: { studs: 4 } });
check("with no copy anywhere the part is kept as built, in one sentence", missing.ok === false && String(missing.reason).startsWith("The plugin source is not in this project or your library.") && near(await volume(block), bareVolume), missing);

// --- A plugin that makes its part: the stamp is on the root; a rebuild makes a new tree for the same object, with the
// later step replayed, and one undo puts the old one back.
session = new Session(engine());
const plate = [
  "use lime_recipe::{ops, Session};",
  "fn main() {",
  "    let mut s = Session::start();",
  '    let w = s.number("width", 30.0).range(10.0, 80.0).unit("mm").get();',
  "    let p = s.solid_new(ops::cuboid(w, 20.0, 4.0)).unwrap();",
  '    s.apply(&p, ops::boolean("fuse", ops::cylinder(2.0, 3.0), [0.0, 0.0, 4.0])).unwrap();',
  "    s.done(&p);",
  "}",
  "",
].join("\n");
const made = await call("recipe_run", { source: plate, name: "tab-plate", keep: { title: "Tab plate", description: "A plate with a tab." } });
const part = String(made.object);
rows = await history(part);
check("a part the plugin made has the stamp on its root", made.ok === true && rows.find((row) => row.parent === null)?.plugin?.id === "tab-plate", rows);
await call("model_apply", { object: part, probe: true, op: { kind: "boolean", op: "cut", primitive: "cylinder", radius: 1, height: 20, origin: [8, 0, -5] } });
const madeBefore = await volume(part);
const wider = await call("recipe_run", { plugin: "tab-plate", object: part, params: { width: 50 } });
rows = await history(part);
path = shownPath(rows);
check("its rebuild keeps the object and replays the later step", wider.ok === true && wider.object === part && (wider.rebuilt as { replayed?: number } | undefined)?.replayed === 1 && path.at(-1)!.label.startsWith("Cut cylinder") && path[0]!.plugin?.params.width === 50, { wider, path: path.map((row) => row.label) });
if (real) check("the wider plate has more volume", (await volume(part)) > madeBefore + 1);
const undoMade = await call("model_undo", { object: part });
check("one undo puts the old tree back", undoMade.ok === true && near(await volume(part), madeBefore) && shownPath(await history(part))[0]!.plugin?.params.width === undefined, undoMade);
const redoMade = await call("model_redo", { object: part });
check("one redo brings the rebuild again", redoMade.ok === true && shownPath(await history(part))[0]!.plugin?.params.width === 50, redoMade);

if (failed > 0) {
  console.error(`plugin-step: ${failed} failed`);
  process.exit(1);
}
console.log("plugin-step: all passed");
