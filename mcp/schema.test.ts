import { occtHint } from "./engine.ts";
import { groupOf, TOOL_GROUPS } from "./groups.ts";
import { advertisedTools, annotationsFor, listedTools, OP_KINDS, OP_SUMMARY, TOOLS, UNLISTED_TOOLS, validateTool, type ToolSpec } from "./schema.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

const names = new Set(TOOLS.map((tool) => tool.name));
const placeDescription = TOOLS.find((tool) => tool.name === "model_place")!.description;
check("model_place says the print layout does not move", placeDescription.includes("print layout does not move") && !placeDescription.includes("The bed moves at model_commit"));
check("the mvp tools are present", ["session_info", "project_open", "project_create", "project_save", "mesh_import", "plate_list", "object_select", "object_place", "object_remove", "machine_list", "machine_select", "settings_apply", "slice_start", "slice_wait", "slice_cancel", "gcode_summary", "gcode_export", "export_3mf"].every((name) => names.has(name)));
check("printer send is not a tool", !names.has("printer_send"));
check("app_open starts an app, so it is not a read", !annotationsFor("app_open").readOnlyHint && annotationsFor("app_open").destructiveHint);
check("app_open takes only a path", validateTool("app_open", { path: "a.lime", app: "calc.exe" }) !== null);
check("project_save says it may overwrite", TOOLS.find((tool) => tool.name === "project_save")!.description.includes("overwrites"));
check(
  "a missing bridge names where to put it",
  occtHint("Open CASCADE bridge was not found.").includes("LIME_OCCT_BRIDGE") && occtHint("Open CASCADE bridge was not found.").includes("next to node"),
);
check("a bridge message that already names the variable stays as it is", !occtHint("Open CASCADE. Set LIME_OCCT_BRIDGE.").includes("next to node"));

check("a missing path is rejected", validateTool("project_open", {}) !== null);
check("long recipes can request ten minutes", validateTool("recipe_run", { source: "fn main() {}", timeoutS: 600 }) === null && validateTool("recipe_run", { source: "fn main() {}", timeoutS: 601 }) !== null);
check("a hole diameter of 0 is rejected", validateTool("model_probe", { object: "obj_1", op: { kind: "hole", diameterMm: 0, through: true } }) !== null);
check("a scale percent of 9 is rejected", validateTool("object_place", { object: "obj_1", scalePercent: 9 }) !== null);
check("a fractional edge index is rejected", validateTool("model_probe", { object: "obj_1", op: { kind: "fillet", edges: [1.5], size: 1 } }) !== null);
check("a hole does not take a fillet size", validateTool("model_probe", { object: "obj_1", op: { kind: "hole", size: 2 } }) !== null);
check("a counterbore is a hole field", validateTool("model_probe", { object: "obj_1", op: { kind: "hole", diameterMm: 4, through: true, counterboreDiameterMm: 8, counterboreDepth: 3 } }) === null);
check("an unknown edit names the kinds", validateTool("model_probe", { op: { kind: "twist" } }) === "op.kind must be one of hole, fillet, chamfer, split, scale, extrude, revolve, loft, sweep, shell, faceExtrude, moveFaces, unify, boolean, root, join, pocket, boss, texture, pattern, mirror, text, array, ribs, partition, transition, gear.");
const square = [[0, 0], [10, 0], [10, 10], [0, 10]];
const longProfile = Array.from({ length: 1001 }, (_, i) => [i, i % 2]);
check("extrude profiles accept up to 1000 points", validateTool("model_apply", { op: { kind: "extrude", profile: longProfile.slice(0, 1000), depth: 1 } }) === null && validateTool("model_apply", { op: { kind: "extrude", profile: longProfile, depth: 1 } }) !== null);
check("an extrude accepts a second depth and a draft", validateTool("model_probe", { object: "obj_1", op: { kind: "extrude", profile: square, depth: 10, depth2: 4, draftDeg: 5 } }) === null);
check("an extrude accepts a face to stop at", validateTool("model_probe", { object: "obj_1", op: { kind: "extrude", profile: square, depth: 0, upTo: 3 } }) === null);
check("an extrude accepts a face selector to stop at", validateTool("model_probe", { object: "obj_1", op: { kind: "extrude", profile: square, depth: 10, upTo: { normal: [0, 0, 1], nearPoint: [5, 5, 10] } } }) === null);
check("a draft of 90 degrees is rejected", validateTool("model_probe", { object: "obj_1", op: { kind: "extrude", profile: square, depth: 10, draftDeg: 90 } }) !== null);
check("a low scale names the bound", validateTool("object_place", { object: "obj_1", scalePercent: 9 }) === "scalePercent must be at least 10.");
const layerHeight = (TOOLS.find((tool) => tool.name === "settings_apply")!.inputSchema.properties as { layerHeight: { minimum?: number; maximum?: number } }).layerHeight;
check("layer height is 0.08 to 0.4", layerHeight.minimum === 0.08 && layerHeight.maximum === 0.4);
check("layer height 0.9 is outside the schema", validateTool("settings_apply", { layerHeight: 0.9 }) !== null);
check("model_apply uses the typed edit", JSON.stringify(TOOLS.find((tool) => tool.name === "model_apply")!.inputSchema).includes("oneOf"));
check("a fillet can select edges", validateTool("model_probe", { object: "obj_1", op: { kind: "fillet", edges: { select: { direction: [0, 0, 1] } }, size: 1 } }) === null);
check("every op kind has a one-line summary", OP_KINDS.length === Object.keys(OP_SUMMARY).length && OP_KINDS.every((kind) => typeof OP_SUMMARY[kind] === "string"));
check(
  "a chamfer without size names the field and a chamfer's fields",
  validateTool("model_apply", { op: { kind: "chamfer", edges: [0] } }) === "input.op.size is required. A chamfer op takes edges (required, list or object), size (required, number), size2 (number), angleDeg (number), flip (true or false), label (text). guide {kind:\"chamfer\"} has its full schema.",
);
check("a refused field outside an op is unchanged", validateTool("model_apply", { op: { kind: "scale", factor: 2 }, probe: 1 }) === "input.probe must be true or false.");
check("settings and selectors are tools", ["settings_schema", "settings_set", "faces_find", "edges_find"].every((name) => names.has(name)));

function missingDescriptions(node: unknown, missing: string[]): void {
  if (!node || typeof node !== "object") return;
  const record = node as { properties?: Record<string, { description?: string }>; items?: unknown; oneOf?: unknown[] };
  if (record.properties) {
    for (const [key, child] of Object.entries(record.properties)) {
      if (!child || typeof child.description !== "string" || child.description.trim() === "") missing.push(key);
      missingDescriptions(child, missing);
    }
  }
  if (record.items) missingDescriptions(record.items, missing);
  if (Array.isArray(record.oneOf)) for (const branch of record.oneOf) missingDescriptions(branch, missing);
}
const undescribed: string[] = [];
for (const tool of TOOLS) missingDescriptions(tool.inputSchema, undescribed);
check("every property has a description", undescribed.length === 0);
// Every client reads the whole tools/list each session, so it is held to a token budget. Tokens are estimated as
// UTF-8 bytes / 4, rounded up: no tokenizer runs here, and compact JSON schema text comes out at about four bytes a
// token for current tokenizers. The list was 78.8 KB (~19,700 tokens) before model_apply's op became kind names
// and one line each (its full schema alone was 28.9 KB); guide {kind} serves a kind's full schema on demand.
const tokens = (text: string) => Math.ceil(Buffer.byteLength(text) / 4);
const rowsOf = (tools: ToolSpec[]) => tools.map((tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.inputSchema,
  annotations: annotationsFor(tool.name),
}));
// Every tool, tools_enable too, for the per-tool budget; the default list (groups off) for the total.
const rows = rowsOf(advertisedTools());
const listed = JSON.stringify({ tools: rowsOf(listedTools(null)) });
const core = JSON.stringify({ tools: rowsOf(listedTools(new Set())) });
console.log(`with tool groups on, the first tools/list is ${Buffer.byteLength(core)} bytes, ~${tokens(core)} tokens, ${listedTools(new Set()).length} tools`);
const TOOL_BUDGET = 750;
/** Tools allowed past TOOL_BUDGET, each with its reason. */
const TOOL_BUDGET_EXCEPTIONS: Record<string, { budget: number; reason: string }> = {
  model_apply: { budget: 900, reason: "lists every op kind with one line each, the map a caller picks a kind from" },
};
// 14,500 on main; the five stress tools (sim_*, ~1,500 tokens, each inside its own budget) add the rest. With
// tool groups on they are in the stress group and stay out of the first list. The transition kind's line in model_apply
// (docs/plan-belt-transitions.md, step 2) adds about 25 tokens to a list that was at 15,999. Step 5's auto-find
// (model_probe plan:true for a transition, named in the plan field) adds 11 to a list at 16,049. support_edit's
// grow action and its count add 24 to a list at 16,060. object_split_shells names that a committed
// model of several solids gives each object only its own solid, 19 tokens on a list at 16,084. recipe_run
// (docs/plan-recipes.md) adds 249 to a list at 16,103; it is in the model group, so the first list with groups on
// does not grow, and one recipe stands in for a probe-and-apply round trip per op. section (docs/plan-recipe-ingredients.md
// I5–I6 and the groovi R-B ask: a face's outline, plane cuts of a solid, and cuts of a mesh, in one tool rather than
// three) and model_apply_batch's combine (I19) add 308 to a list at 16,351. section is in the model group, so the first
// list with groups on does not grow; one section call replaces an outside script that read the STL by hand.
// recipe_run's path (the source read from a workspace file, so an edit and rerun sends a path instead of the source:
// about 5,000 tokens a call for the groovi skin) and maxSteps (a partial dry run) add 50 more (16,710 together), in the model group as well.
// section's saveAs (the answer written as recipe data, so a mesh's measured sections, tens of kilobytes, never pass
// through the model) adds 29 to a list at 16,710, in the model group.
// Plugins (docs/plan-recipe-plugins.md D14, milestones 1–2): the plugin tool (list, get, save, remove: one tool with an
// action, as the plan chose over four) and recipe_run's plugin and keep add 281 to a list at 16,740 (the plan estimated
// about 260). Both are in the model group, so the first list with groups on does not grow, and one plugin list plus a
// recipe_run {plugin} replaces writing and sending a recipe again: thousands of tokens a reuse.
// Nuggets (docs/plan-recipe-ingredients.md I12–I16, Q2): one nugget tool for plugins, ingredients, presets and lessons,
// in place of the plugin tool (which still answers, unlisted) and the three more tools the plan sketched, and
// recipe_run's preset, add 102 to a list at 17,021. nugget is in the model group, so the first list with groups on does
// not grow, and one find before writing replaces rewriting helpers a library already holds.
// Plugin data (a kept plugin carries the recipe data it read): nugget's data, the names a library plugin carries from
// the workspace without running it again, adds 29 to a list at 17,123, in the model group; the other way to carry it
// is a whole recipe_run with keep.
// Sharing (docs/plan-recipe-plugins.md milestone 8): nugget's export action, from naming a plugin file or a project's
// copy to import, and replace for a name clash add 31 to a list at 17,152, in the model group. One export or import call
// moves a plugin with its ingredients, data, presets and lessons, in place of pasting its source into a chat.
// Tool groups are the default now (docs/mcp-server.md), so the budget that matters to a client is FIRST_LIST_BUDGET, the
// list it reads every session; TOTAL_BUDGET is the flat list (LIME_MCP_TOOL_GROUPS=0) and every group opened, raised from
// 17,190 to measured + 3% (17,187 -> 17,700) so a tool added to a group does not need a budget edit; the first list is tight.
// Raised again to measured + 3% (17,712 -> 18,250) when model_place took root:true.
const TOTAL_BUDGET = 18_250;
// Raised from 4,600 to 5,300 (measured 5,260) when model_place and model_export_step became core: posing and saving the pose as STEP need
// no Model edit, and a client that never re-reads the list after tools_enable could not call them by name. With
// model_place root:true the first list measures 5,285.
// pose_animate is a core tool (animation plan D7): one call replaces many pose and render calls.
const FIRST_LIST_BUDGET = 5_650;
const sized = rows.map((row) => ({ name: row.name, tokens: tokens(JSON.stringify(row)) })).sort((a, b) => b.tokens - a.tokens);
const over = sized.filter((row) => row.tokens > (TOOL_BUDGET_EXCEPTIONS[row.name]?.budget ?? TOOL_BUDGET));
const overText = over.map((row) => `${row.name} is ~${row.tokens} tokens, over its ${TOOL_BUDGET_EXCEPTIONS[row.name]?.budget ?? TOOL_BUDGET}`).join("; ");
check(`every tool fits its token budget${over.length ? `: ${overText}` : ""}`, over.length === 0);
const total = tokens(listed);
console.log(`tools/list is ${Buffer.byteLength(listed)} bytes, ~${total} tokens, ${listedTools(null).length} tools`);
const largest = sized.slice(0, 10).map((row) => `${row.name} ~${row.tokens}`).join(", ");
check(`tools/list fits ${TOTAL_BUDGET} tokens${total > TOTAL_BUDGET ? ` (it is ~${total}; largest: ${largest})` : ""}`, total <= TOTAL_BUDGET);
const firstTokens = tokens(core);
check(`the first tools/list (groups on, none opened) fits ${FIRST_LIST_BUDGET} tokens${firstTokens > FIRST_LIST_BUDGET ? ` (it is ~${firstTokens})` : ""}`, firstTokens <= FIRST_LIST_BUDGET);
const grouped = Object.values(TOOL_GROUPS).flatMap((row) => row.tools);
check("every grouped tool is a tool, in one group", grouped.every((name) => names.has(name)) && new Set(grouped).size === grouped.length);
check("groups off lists every tool but tools_enable and the unlisted ones", listedTools(null).length === TOOLS.length - 1 - UNLISTED_TOOLS.size && !listedTools(null).some((tool) => UNLISTED_TOOLS.has(tool.name)) &&!listedTools(null).some((tool) => tool.name === "tools_enable"));
check("groups on lists the core and tools_enable first", listedTools(new Set()).every((tool) => groupOf(tool.name) === null) && listedTools(new Set()).some((tool) => tool.name === "tools_enable") && listedTools(new Set()).some((tool) => tool.name === "slice_start"));
check("an enabled group adds its tools", listedTools(new Set(["paint"]).add("model")).some((tool) => tool.name === "model_apply" && listedTools(new Set(["paint"])).every((row) => row.name !== "model_apply")));
check("model_apply lists every op kind by name",JSON.stringify(rows.find((row) => row.name === "model_apply")!.inputSchema).includes('"enum":["hole","fillet"'));

const accepted: [string, unknown][] = [
  ["session_info", {}],
  ["project_open", { path: "prints/bracket.lime" }],
  ["project_create", {}],
  ["project_save", { name: "bracket.lime" }],
  ["app_open", {}],
  ["app_open", { path: "bracket.lime" }],
  ["mesh_import", { path: "samples/calibration_cube_20mm.stl", stepToleranceMm: 0.05 }],
  ["plate_list", { limit: 20 }],
  ["object_select", { object: "obj_1" }],
  ["object_place", { object: "obj_1", centreOnBed: true, scalePercent: 100, turn: { axis: "z", degrees: 90 } }],
  ["object_remove", { object: "obj_1" }],
  ["machine_select", { printerId: "lime-220", filamentId: "lime-pla", nozzleMm: 0.4 }],
  ["settings_apply", { preset: "speed", layerHeight: 0.2, supports: false }],
  ["slice_start", {}],
  ["slice_wait", { job: "job_1" }],
  ["slice_cancel", { job: "job_1" }],
  ["gcode_summary", {}],
  ["gcode_export", { name: "cube.gcode", now: "2020-01-02T03:04:05.000Z" }],
  ["export_3mf", { name: "cube.3mf" }],
  ["model_probe", { object: "obj_1", op: { kind: "hole", diameterMm: 4, through: true, at: { u: 10, v: 10 } } }],
  ["model_apply", { object: "obj_1", op: { kind: "hole", diameterMm: 4, through: true, at: { u: 10, v: 10 } } }],
  ["measure", { object: "obj_1", a: [0, 0, 0], b: [10, 0, 0], frame: "model" }],
];
for (const [name, input] of accepted) check(`accepts ${name}`, validateTool(name, input) === null);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("schema: ok");
