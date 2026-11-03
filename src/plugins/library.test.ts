/**
 * The plugin library as the app reads it (docs/plan-recipe-plugins.md D7, D9, D13, milestone 7): the folder's files,
 * older versions, presets and the author setting; the panel's sections, search and order; the form's values; the
 * version a save takes; Use vN's carried values; and the project's copies. The file text the app writes is the MCP's.
 */
import { createHash } from "node:crypto";

import { pluginFileText, readPluginFile } from "../plugin-file.ts";
import type { PluginStamp } from "../model-tree.ts";
import { DEMO_BODY, DEMO_PLUGIN, DEMO_TRY } from "./demo.ts";
import {
  carriedValues,
  droppedSentence,
  ingredientUse,
  ingredientUsers,
  lessonsAbout,
  lessonsWithout,
  pluginIngredients,
  presetParams,
  presetProblem,
  presetsWithout,
  publicItems,
  readLessons,
  searchedIngredients,
  searchedLessons,
  searchedPresets,
  toolLessonKinds,
  formParams,
  formProblem,
  newerInLibrary,
  panelPlugins,
  presetsText,
  presetValues,
  projectCopies,
  readAuthor,
  readLibrary,
  savePlan,
  searched,
  settingsText,
  stampedShas,
  type LibraryListing,
} from "./library.ts";
import { KIND_PURPOSE, PURPOSE, REASON } from "../ui/plugins-panel-text.ts";

let failed = 0;
function eq<T>(name: string, actual: T, expected: T): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) return;
  failed += 1;
  console.error(`FAIL ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

const sha = (body: string) => createHash("sha256").update(body.replace(/\r\n?/g, "\n"), "utf8").digest("hex");
const body = (n: number) => `use lime_recipe::Session;\nfn main() {\n    let _s = Session::start(); // ${n}\n}\n`;
const params = [
  { name: "studs", kind: "count" as const, default: 3, min: 1, max: 10, label: "Studs" },
  { name: "radius", kind: "number" as const, default: 1, min: 0.5, max: 3, unit: "mm", label: "Stud radius" },
  { name: "edge", kind: "choice" as const, default: "fillet", options: ["fillet", "sharp"] },
];
const header = (id: string, title: string, version: number, text: string, target: "new" | "object" | "either" = "object", description = "A row of studs along the top.") =>
  pluginFileText({ plugin: id, title, version, description, author: "Marius", api: "1.1", sha256: sha(text), created: "2026-11-02", target, params }, text);

// --- The file the app writes reads back (mcp/plugins-file.test.ts checks it is byte for byte the MCP server's).
const read = readPluginFile(header("stud-row", "Stud row", 3, body(1)));
eq("the header reads back with its target and hash", [read?.target, read?.headerSha === sha(body(1)), read?.created], ["object", true, "2026-11-02"]);

// --- The folder: current versions, older ones, an edited file, presets and the author.
const listing: LibraryListing = {
  dir: "C:/plugins",
  files: [
    { name: "stud-row.rs", text: header("stud-row", "Stud row", 3, body(3)) },
    { name: "stud-row.v2.rs", text: header("stud-row", "Stud row", 2, body(2)) },
    { name: "stud-row.v1.rs", text: header("stud-row", "Stud row", 1, body(1)) },
    { name: "flange.rs", text: header("flange", "Bolt-circle flange", 1, body(9), "new", "A round flange with bolt holes on a circle.").replace("// 9", "// edited") },
    { name: "notes.rs", text: "fn main() {}" },
    { name: "other.rs", text: header("stud-row", "Misnamed", 1, body(5)) },
  ],
  presets: [{ plugin: "stud-row", text: presetsText(null, { name: "dense", params: { studs: 8, radius: 0.8, extra: 1 } }, "2026-11-02") }, { plugin: "flange", text: "not json" }],
  settings: settingsText(null, "  Marius   C. "),
};
const library = await readLibrary(listing);
eq("current versions by id; files that are not plugins or name another are left out", [...library.plugins.keys()].sort(), ["flange", "stud-row"]);
eq("older versions are found", library.plugins.get("stud-row")?.older, [1, 2]);
eq("every version is found by its hash", [sha(body(1)), sha(body(2)), sha(body(3))].map((h) => library.bySha.get(h)?.version), [1, 2, 3]);
eq("a file edited by hand is not intact", [library.plugins.get("stud-row")?.intact, library.plugins.get("flange")?.intact], [true, false]);
eq("presets read; a damaged file is none", [library.presets.get("stud-row")?.map((p) => p.name), library.presets.get("flange")], [["dense"], []]);
eq("the author setting, on one line", library.author, "Marius C.");
eq("no settings is no author; an empty name clears it", [readAuthor(null), readAuthor(settingsText('{"author":"x","other":1}', ""))], ["", ""]);

// --- The panel's list: the project's plugins the library lacks first, then the library; search; last used first.
const project = new Map([[sha(body(3)), read!], [sha(body(7)), readPluginFile(header("hook", "Wall hook", 1, body(7), "new", "A hook for a wall."))!]]);
project.set(sha(body(3)), readPluginFile(header("stud-row", "Stud row", 3, body(3)))!);
const rows = panelPlugins(library, project, { flange: 5 });
eq("sections in order; a project copy the library holds at that hash is listed once", rows.map((r) => [r.section, r.file.plugin]), [["project", "hook"], ["library", "flange"], ["library", "stud-row"]]);
eq("badges: needs a part, edited", rows.map((r) => r.badges), [[], ["edited"], ["needs a part"]]);
eq("search by a word of the title or description", searched(rows, "bolt").map((r) => r.file.plugin), ["flange"]);
eq("search ranks within a section and drops non-matches", searched(rows, "row studs wall").map((r) => r.file.plugin), ["hook", "stud-row"]);
eq("a one-letter query is no search", searched(rows, "a").length, 3);
eq("last used moves up", panelPlugins(library, new Map(), { "stud-row": 9, flange: 5 }).map((r) => r.file.plugin), ["stud-row", "flange"]);

// --- The form.
eq("a value outside its range names the range and the fix", formProblem(params, { studs: "12" }), "Studs is 1 to 10. Type a value in that range.");
eq("a count is whole", formProblem(params, { studs: "2.5" }), "Studs is a whole number. Type one, for example 3.");
eq("a number with a comma reads", formProblem(params, { radius: "1,5" }), null);
eq("only values that differ from the defaults are given", formParams(params, { studs: "3", radius: "1,5", edge: "sharp" }), { radius: 1.5, edge: "sharp" });
eq("a preset fills what fits and names the rest", presetValues(library.presets.get("stud-row")![0]!, params), { values: { studs: 8, radius: 0.8 }, skipped: ["extra"] });

// --- Save: the MCP's version rule.
eq("a new title is v1", savePlan(library, "Wall hook", sha(body(7))), { id: "wall-hook", version: 1, same: false });
eq("the same code keeps its version", savePlan(library, "Stud row", sha(body(3))), { id: "stud-row", version: 3, same: true });
eq("new code of the same plugin is the next version", savePlan(library, "Stud row", sha(body(4)), "stud-row"), { id: "stud-row", version: 4, same: false });
eq("a clash with another recipe's title is kept beside it", savePlan(library, "Stud row", sha(body(4)), "my-recipe"), { id: "stud-row-2", version: 1, same: false });

// --- Use vN: a newer version, values carried by name.
const stamp = (version: number, h: string): PluginStamp => ({ plugin: "stud-row", version, sha256: h, api: "1.1", params: { studs: 5, bore: true }, context: { bedMm: [250, 210, 220], nozzleMm: 0.4 }, fingerprint: null });
eq("a step on v2 sees v3", newerInLibrary(stamp(2, sha(body(2))), library)?.file.version, 3);
eq("the current version and a draft see none", [newerInLibrary(stamp(3, sha(body(3))), library), newerInLibrary(stamp(0, "x"), library)], [null, null]);
const carried = carriedValues({ studs: 5, bore: true }, params);
eq("values carry by name; removed ones are named; new ones take their defaults", carried, { params: { studs: 5 }, dropped: ["bore"], added: ["radius", "edge"] });
eq("the dropped sentence", [droppedSentence(["bore"], 3), droppedSentence(["a", "b", "c"], 4), droppedSentence([], 4)], ["bore is no longer in v3, so it was dropped.", "a, b and c are no longer in v4, so they were dropped.", ""]);

// --- The project's copies on save: a stamp only the library has code for gets the library's file.
const objects = [{ modelTree: { nodes: [{ id: 1, plugin: { sha256: sha(body(2)), version: 2 } }, { id: 2, plugin: { sha256: "draft", version: 0 } }, { id: 3 }] } }, { mesh: true }];
eq("the stamps of a project's plugins (drafts are kept elsewhere)", stampedShas(objects), [sha(body(2))]);
eq("a missing copy comes from the library; a kept one stays", Object.keys(projectCopies({ keep: "x" }, stampedShas(objects), library) ?? {}), ["keep", sha(body(2))]);
eq("nothing to add is nothing", projectCopies(undefined, [], library), undefined);

// --- The demo: a plugin whose form shows, ready for its next click (Show me).
eq("the demo reads as a plugin that makes a new part", [DEMO_PLUGIN.file.target, DEMO_PLUGIN.file.params.map((p) => p.name), DEMO_PLUGIN.file.body], ["new", ["width", "holes", "diameter"], DEMO_BODY]);
const declared = [...DEMO_BODY.matchAll(/s\.(number|count)\("(\w+)", ([\d.]+)\)/g)].map((m) => [m[2], Number(m[3])]);
eq("the demo's header declares what its code does", declared, DEMO_PLUGIN.file.params.map((p) => [p.name, p.default]));

// --- Nuggets (docs/plan-recipe-ingredients.md I9–I16): ingredients, lessons, presets kept from the form, one search.
const ingredient = (v: number, extra = "") => `//! ---\n//! ingredient: honeycomb\n//! title: Honeycomb cells\n//! version: ${v}\n//! description: Hex pockets clipped to a region, with rounded nodes.\n//! author: Marius\n//! ---\nuse lime_recipe::geom2d::*;\n/// Cells.\npub fn cells(side: f64) -> Vec<Poly> { Vec::new() }\npub const RIB: f64 = 2.4;\npub struct Cell { pub x: f64 }\nfn helper() {}\n${extra}`;
const nugListing: LibraryListing = {
  dir: "C:/plugins",
  files: [{ name: "tray.rs", text: header("tray", "Honeycomb tray", 2, `${body(5)}\nmod ingredients {\n// ingredient: honeycomb v2 sha256:${"a".repeat(64)}\npub mod honeycomb {}\n}\n`) }],
  presets: [{ plugin: "tray", text: JSON.stringify({ "pp-5mm-wall": { params: { studs: 4 }, created: "x" } }) }],
  ingredients: [
    { name: "honeycomb.rs", text: ingredient(2) },
    { name: "honeycomb.v1.rs", text: ingredient(1) },
    { name: "moulded-tray.rs", text: "//! ---\n//! ingredient: moulded-tray\n//! title: Moulded tray\n//! version: 1\n//! ---\npub fn drafted_body() {}\n" },
    { name: "wrong.rs", text: "//! ---\n//! ingredient: other\n//! ---\npub fn a() {}\n" },
    { name: "plain.rs", text: "pub fn a() {}" },
  ],
  lessons: JSON.stringify([
    { n: 1, about: "fillet", text: "select.onFace with nearPoint over a pocket picks the pocket floor; aim at material.", created: "a" },
    { n: 2, about: "extrude", text: "At most 1000 loops in one extrude.", created: "b" },
    { n: 3, about: "fillet", text: "A 2 mm fillet on a 1.5 mm rib is refused; use 0.7.", created: "c" },
    { bad: true },
  ]),
  settings: null,
};
const nug = await readLibrary(nugListing);
eq("ingredients: current versions by id, older ones beside, a mismatched or plain file left out", [...nug.ingredients.keys()], ["honeycomb", "moulded-tray"]);
const honey = nug.ingredients.get("honeycomb")!;
eq("an ingredient reads its header, older versions and public items", [honey.title, honey.version, honey.older, honey.author, honey.items], ["Honeycomb cells", 2, [1], "Marius", [{ kind: "fn", name: "cells" }, { kind: "const", name: "RIB" }, { kind: "struct", name: "Cell" }]]);
eq("public items skip private ones and read const fn as fn", publicItems("pub const fn a() {}\nfn b() {}\npub(crate) fn c() {}\npub enum E {}\n"), [{ kind: "fn", name: "a" }, { kind: "enum", name: "E" }]);
eq("the import line names the module", [ingredientUse("honeycomb"), ingredientUse("moulded-tray")], ["use ingredients::honeycomb::*;", "use ingredients::moulded_tray::*;"]);
eq("a plugin lists the ingredients it carries", pluginIngredients(nug.plugins.get("tray")!.file), [{ id: "honeycomb", version: 2 }]);
eq("an ingredient lists the plugins that carry it", [ingredientUsers(nug, "honeycomb"), ingredientUsers(nug, "moulded-tray")], [[{ title: "Honeycomb tray", version: 2 }], []]);
eq("lessons: damaged rows left out, oldest first", nug.lessons.map((l) => l.n), [1, 2, 3]);
eq("a damaged lessons file is no lessons", [readLessons("not json"), readLessons(null), readLessons("{}")], [[], [], []]);
eq("an op's lessons: its kinds, newest first", lessonsAbout(nug.lessons, toolLessonKinds("fillet")).map((l) => l.n), [3, 1]);
eq("Push/pull's card reads extrude lessons too", lessonsAbout(nug.lessons, toolLessonKinds("pushpull")).map((l) => l.n), [2]);
eq("removing a lesson keeps the rest as written", JSON.parse(lessonsWithout(nugListing.lessons!, 1)).map((l: { n?: number }) => l.n), [2, 3, undefined]);
eq("search: an ingredient by a function it gives", searchedIngredients(nug, "cells").map((r) => r.id), ["honeycomb"]);
eq("search: no word lists every ingredient", searchedIngredients(nug, "").map((r) => r.id), ["honeycomb", "moulded-tray"]);
eq("search: a preset by its plugin's title", searchedPresets(nug, "honeycomb").map((r) => `${r.plugin}/${r.preset.name}`), ["tray/pp-5mm-wall"]);
eq("search: a lesson by a word of it", searchedLessons(nug, "pocket").map((l) => l.n), [1]);
eq("a preset's name is a slug, and its values fit", [presetProblem("Thick Wall", params, {}), presetProblem("thick", params, { studs: 40 }), presetProblem("thick", params, { studs: 4 })], ["A preset's name is lower-case letters, digits and dashes, for example pp-5mm-wall. Type one like that.", "Studs is 1 to 10. Type a value in that range.", null]);
eq("a preset keeps every declared value, typed or default", presetParams(params, { studs: "4", radius: "1,5" }), { studs: 4, radius: 1.5, edge: "fillet" });
eq("removing the last preset leaves an empty file", [JSON.parse(presetsWithout(nugListing.presets[0]!.text, "pp-5mm-wall")), JSON.parse(presetsWithout("{\"a\":{\"params\":{}},\"b\":{\"params\":{}}}", "a"))], [{}, { b: { params: {} } }]);
eq("a shell from before nuggets lists none", [(await readLibrary({ dir: "", files: [], presets: [], settings: null })).ingredients.size, (await readLibrary({ dir: "", files: [], presets: [], settings: null })).lessons.length], [0, 0]);

// --- R1, R4: every reason ends with what to do, every purpose says what it is for.
const actions = /\b(click|select|type|wait|open|change|press|update|run|save|keep|clear|try|use)\b[^.]*\.$/i;
for (const [name, text] of [...Object.entries(REASON), ["demo", DEMO_TRY]]) eq(`reason ${name} ends with an action`, actions.test(String(text)), true);
for (const [name, text] of [...Object.entries(PURPOSE), ...Object.entries(KIND_PURPOSE)]) eq(`purpose ${name} is one sentence or two`, /^[A-Z].*\.$/.test(text) && text.length <= 120, true);

if (failed) {
  console.error(`plugins library: ${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("plugins library: files, versions, presets, author, list, search, form, save plan, Use vN, copies ok");
