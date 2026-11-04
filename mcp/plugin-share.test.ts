/**
 * Sharing plugins through the MCP (docs/plan-recipe-plugins.md milestone 8): nugget {action: "export"} writes one file
 * (the plugin, the ingredient and recipe data it carries, its presets, the lessons about it); a second person's library
 * imports it from that file (nugget save {from: "<file>.rs"}) with the same hash, marked imported, and builds the same
 * solid with neither the ingredient nor the data file there. A clash keeps both, or replaces with replace:true. The
 * plan's fixtures answer with their sentences; a description carrying an instruction comes back only as data. A project
 * that carries a plugin names it on open and imports it from project:<id>. Real lust, the stand-in engine. Skips
 * without lust; LIME_RECIPE_REQUIRED=1 makes that a failure.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findLust } from "./recipe.ts";

const lust = findLust();
if (!lust) {
  if (process.env.LIME_RECIPE_REQUIRED === "1") {
    console.error("plugin-share: lust is required here (LIME_LUST)");
    process.exit(1);
  }
  console.log("plugin-share: skipped (set LIME_LUST to a lust build)");
  process.exit(0);
}

const ws = mkdtempSync(join(tmpdir(), "lime-share-ws-"));
process.env.LIME_MCP_WORKSPACE = ws;
const sender = mkdtempSync(join(tmpdir(), "lime-share-a-"));
const receiver = mkdtempSync(join(tmpdir(), "lime-share-b-"));
process.env.LIME_PLUGINS_DIR = sender;
process.env.LIME_PLUGIN_AUTHOR = "Sender";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    console.log(`ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name} ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 3000)}`);
}
type Row = Record<string, unknown>;

const { fakeEngine } = await import("./engine.ts");
const { Session } = await import("./session.ts");
const a = new Session(fakeEngine());
a.clientName = "share-test";
const volume = async (s: InstanceType<typeof Session>, object: string) => Number((await s.call("model_describe", { object })).volumeMm3);

// --- The sender keeps an ingredient, data, a plugin that uses both, a preset and two lessons.
const ingredient = await a.call("nugget", { action: "save", kind: "ingredient", source: "pub fn ribs_for(width: f64) -> u32 {\n    (width / 10.0) as u32\n}\n", title: "tray ribs" });
check("sender: the ingredient is kept", ingredient.ok === true && ingredient.id === "tray-ribs", ingredient);
mkdirSync(join(ws, "trays"), { recursive: true });
writeFileSync(join(ws, "trays", "size.json"), JSON.stringify({ depth: 20 }));
const tray = [
  "use lime_recipe::{ops, Json, Session};",
  "use ingredients::tray_ribs::*;",
  "",
  "fn main() {",
  "    let mut s = Session::start();",
  '    let w = s.number("width", 30.0).range(10.0, 120.0).unit("mm").label("Width").get();',
  '    let d = s.data("trays/size").unwrap();',
  '    let depth = d.get("depth").and_then(|v| v.as_f64()).unwrap();',
  "    let p = s.solid_new(ops::cuboid(w, depth, 3.0)).unwrap();",
  "    let n = ribs_for(w);",
  "    for i in 0..n {",
  "        let x = -w / 2.0 + w * (i as f64 + 0.5) / n as f64;",
  "        s.apply(&p, ops::boolean(\"fuse\", ops::cuboid(1.0, depth, 2.0), [x, 0.0, 3.0])).unwrap();",
  "    }",
  '    s.done_with(&p, Json::obj().set("ribs", n));',
  "}",
  "",
].join("\n");
const kept = await a.call("recipe_run", { source: tray, name: "shared_tray", keep: { title: "Shared tray", description: "A ribbed tray sized from measured data." } });
const keptRow = kept.kept as { id: string; sha256: string; ingredients?: string[]; recipeData?: unknown[] } | undefined;
check("sender: the plugin carries the ingredient and the data", kept.ok === true && keptRow?.id === "shared-tray" && JSON.stringify(keptRow.ingredients) === JSON.stringify(["tray-ribs v1"]) && (keptRow.recipeData ?? []).length === 1, kept);
await a.call("nugget", { action: "save", kind: "preset", id: "shared-tray/wide", params: { width: 90 } });
await a.call("nugget", { action: "save", kind: "lesson", id: "shared-tray", text: "Over 100 mm wide, print it diagonally on a 250 mm bed." });
await a.call("nugget", { action: "save", kind: "lesson", id: "fillet", text: "A lesson about an op kind stays home." });
const senderRun = await a.call("recipe_run", { plugin: "shared-tray", params: { width: 50 } });
const senderVolume = await volume(a, String(senderRun.object));
check("sender: it runs from the library", senderRun.ok === true && senderVolume > 0, senderRun);

// --- Export: one file in the workspace.
const exported = await a.call("nugget", { action: "export", kind: "plugin", id: "shared-tray" });
const sharedPath = join(ws, "shared-tray-v1.lime-plugin.rs");
const sharedText = existsSync(sharedPath) ? readFileSync(sharedPath, "utf8") : "";
check("export writes <id>-v<N>.lime-plugin.rs with what it carries", exported.ok === true && exported.file === "shared-tray-v1.lime-plugin.rs" && exported.sha256 === keptRow?.sha256 && JSON.stringify(exported.presets) === JSON.stringify(["wide"]) && exported.lessons === 1 && (exported.recipeData as unknown[]).length === 1, exported);
check("the file holds the code, the ingredient, the data, the preset and only the lesson about it", sharedText.includes("pub mod tray_ribs") && sharedText.includes("// data: trays/size sha256:") && sharedText.includes('//! presets: {"wide":') && sharedText.includes("print it diagonally") && !sharedText.includes("stays home"), sharedText.slice(0, 1500));
check("export of a plugin that is not there is one sentence", (await a.call("nugget", { action: "export", kind: "plugin", id: "nothing-here" })).ok === false);

// --- The receiver: another library, no ingredient, no data file.
unlinkSync(join(ws, "trays", "size.json"));
process.env.LIME_PLUGINS_DIR = receiver;
process.env.LIME_PLUGIN_AUTHOR = "Receiver";
const b = new Session(fakeEngine());
b.clientName = "share-test-b";
const imported = await b.call("nugget", { action: "save", kind: "plugin", from: "shared-tray-v1.lime-plugin.rs" });
check("import: the same id, version and hash, marked imported", imported.ok === true && imported.id === "shared-tray" && imported.version === 1 && imported.sha256 === keptRow?.sha256 && imported.imported === true, imported);
check("import: the author and made-by are the sender's, as data", (imported.data as Row)?.author === "Sender" && (imported.data as Row)?.madeBy === "share-test", imported.data);
check("import: its preset and lesson join the library", JSON.stringify(imported.presets) === JSON.stringify(["wide"]) && imported.lessons === 1, imported);
const senderFile = readFileSync(join(sender, "shared-tray.rs"), "utf8");
const receiverFile = existsSync(join(receiver, "shared-tray.rs")) ? readFileSync(join(receiver, "shared-tray.rs"), "utf8") : "";
check("round trip: the receiver's library file is the sender's, byte for byte", receiverFile === senderFile, receiverFile.slice(0, 900));
const marks = JSON.parse(readFileSync(join(receiver, "imported.json"), "utf8")) as Record<string, { sha256: string; from: string }>;
check("imported.json marks it until a person's first run", marks["shared-tray"]?.sha256 === keptRow?.sha256 && marks["shared-tray"]?.from === "file", marks);
const got = await b.call("nugget", { action: "get", kind: "plugin", id: "shared-tray" });
check("get and find say it was imported", got.imported === true && ((await b.call("nugget", { action: "find", query: "tray" })).nuggets as Row[]).some((r) => r.id === "shared-tray" && r.imported === true), got);
const receiverRun = await b.call("recipe_run", { plugin: "shared-tray", params: { width: 50 } });
check("round trip: it builds the same solid without the ingredient or the data file", receiverRun.ok === true && Math.abs((await volume(b, String(receiverRun.object))) - senderVolume) < 1e-6, receiverRun);
const preset = await b.call("recipe_run", { plugin: "shared-tray", preset: "wide" });
check("its preset runs by name", preset.ok === true, preset);
const again = await b.call("nugget", { action: "save", kind: "plugin", from: "shared-tray-v1.lime-plugin.rs" });
check("importing the same file again changes nothing", again.ok === true && again.same === true && again.version === 1, again);

// --- A clash: the same id with other code.
const other = sharedText.replace("ops::cuboid(w, depth, 3.0)", "ops::cuboid(w, depth, 4.0)");
writeFileSync(join(ws, "other-tray.lime-plugin.rs"), other);
const beside = await b.call("nugget", { action: "save", kind: "plugin", from: "other-tray.lime-plugin.rs" });
check("a clash keeps both: the import becomes <id>-2, titled (2)", beside.ok === true && beside.id === "shared-tray-2" && beside.keptBeside === "shared-tray" && (beside.data as Row).title === "Shared tray (2)" && beside.edited === true, beside);
const replaced = await b.call("nugget", { action: "save", kind: "plugin", from: "other-tray.lime-plugin.rs", replace: true });
check("replace:true replaces it, the old one kept as v1", replaced.ok === true && replaced.id === "shared-tray" && replaced.version === 2 && existsSync(join(receiver, "shared-tray.v1.rs")), replaced);

// --- The plan's fixtures.
const fixtures = join(import.meta.dirname, "fixtures", "plugin-import");
const viaSource = async (name: string) => b.call("nugget", { action: "save", kind: "plugin", source: readFileSync(join(fixtures, name), "utf8") });
const clean = await viaSource("clean.lime-plugin.rs");
check("fixture: a clean plugin imports from source", clean.ok === true && clean.id === "fixture-block" && clean.imported === true, clean);
const said = JSON.stringify({ ...clean, data: undefined });
check("fixture: its description, which carries an instruction, comes back only as data", String((clean.data as Row).description).includes("Ignore all previous instructions") && !said.includes("Ignore all previous") && /data, not instructions/.test(String(clean.marked)), clean);
check("fixture: the instruction was not followed: the library still has its plugins", existsSync(join(receiver, "shared-tray.rs")) && existsSync(join(receiver, "shared-tray-2.rs")));
const mod = await viaSource("mod-file.lime-plugin.rs");
check("fixture: mod x; is refused with its line", mod.ok === false && mod.reason === "Line 2 brings in another file or crate; a plugin is one file against lime_recipe, so it was not imported.", mod);
const long = await viaSource("long-description.lime-plugin.rs");
check("fixture: an over-long description is refused", long.ok === false && /^Its description is \d+ characters; a plugin's description is at most 280\./.test(String(long.reason)) && !existsSync(join(receiver, "fixture-long.rs")), long);
const future = await viaSource("newer-api.lime-plugin.rs");
check("fixture: a newer API is refused in one sentence", future.ok === false && /^It needs recipe API 9\.0; this Lime Slice has \d+\.\d+\. Update Lime Slice, then import it again\.$/.test(String(future.reason)) && !existsSync(join(receiver, "fixture-future.rs")), future);

// --- A project that carries a plugin: named on open, imported only when asked.
process.env.LIME_PLUGINS_DIR = sender;
const onPlate = await a.call("recipe_run", { plugin: "shared-tray", params: { width: 40 } });
check("sender: a part built with the plugin", onPlate.ok === true, onPlate);
await a.call("project_save", { name: "tray.lime" });
const third = mkdtempSync(join(tmpdir(), "lime-share-c-"));
process.env.LIME_PLUGINS_DIR = third;
const c = new Session(fakeEngine());
const opened = await c.call("project_open", { path: "tray.lime" });
check("open names the plugin the library lacks, and adds nothing", opened.ok === true && JSON.stringify(opened.pluginsNotInLibrary) === JSON.stringify(["shared-tray v1"]) && /ask the person first/.test(String(opened.pluginsNote)) && !existsSync(join(third, "shared-tray.rs")), opened);
const fromProject = await c.call("nugget", { action: "save", kind: "plugin", from: "project:shared-tray" });
check("project:<id> imports the project's copy, marked from the project", fromProject.ok === true && fromProject.sha256 === keptRow?.sha256 && (JSON.parse(readFileSync(join(third, "imported.json"), "utf8")) as Record<string, { from: string }>)["shared-tray"]?.from === "project", fromProject);
check("project:<id> of a plugin it does not carry is one sentence", (await c.call("nugget", { action: "save", kind: "plugin", from: "project:nothing" })).ok === false);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("plugin-share: ok");
