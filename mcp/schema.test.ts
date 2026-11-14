import { occtHint } from "./engine.ts";
import { AREA_NAMES, catalogTools, firstSentence, search, toolDoc } from "./catalog.ts";
import { EXAMPLES } from "./examples.ts";
import { FIRST_TOOLS, groupOf, TOOL_GROUPS } from "./groups.ts";
import { DISCOVERY_INSTRUCTIONS } from "./protocol.ts";
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
// Discovery (docs/plan-mcp-discovery.md D5). The one token bound is on first contact: the server's instructions and
// the default tools/list, which every client reads every session. Everything else is read on demand through guide, so
// a tool's words cost nothing until an agent asks for that tool, and adding a tool or a field touches no other tool.
// Tokens are UTF-8 bytes / 4, rounded up: no tokenizer runs here, and compact JSON comes out at about four bytes a
// token for current tokenizers. Before discovery the first list was 5,649 tokens (31 tools) against a 5,650 bound and
// the flat list 18,249 against 18,250, so every new field was paid for by cutting another tool's description.
const tokens = (text: string) => Math.ceil(Buffer.byteLength(text) / 4);
const rowsOf = (tools: ToolSpec[]) => tools.map((tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.inputSchema,
  annotations: annotationsFor(tool.name),
}));
const rows = rowsOf(advertisedTools());
const firstList = JSON.stringify({ tools: rowsOf(listedTools(new Set())) });
const firstContact = tokens(firstList) + tokens(DISCOVERY_INSTRUCTIONS);
console.log(`first contact: instructions ~${tokens(DISCOVERY_INSTRUCTIONS)} tokens, tools/list ~${tokens(firstList)} tokens (${listedTools(new Set()).length} tools), ~${firstContact} together`);
console.log(`for comparison, not bound: core list ~${tokens(JSON.stringify({ tools: rowsOf(listedTools(new Set(["core"]))) }))} tokens, flat list ~${tokens(JSON.stringify({ tools: rowsOf(listedTools(null)) }))}`);
/** Instructions and the default tools/list together. A feature never enters first contact, so this has no feature history. */
const FIRST_CONTACT_BUDGET = 1_500;
check(`first contact fits ${FIRST_CONTACT_BUDGET} tokens (it is ~${firstContact})`, firstContact <= FIRST_CONTACT_BUDGET);
check("the default list is exactly the four first tools", JSON.stringify(listedTools(new Set()).map((tool) => tool.name).sort()) === JSON.stringify([...FIRST_TOOLS].sort()));
check("the instructions name no tool outside the first four and the slice path", (() => {
  const named = TOOLS.map((tool) => tool.name).filter((name) => new RegExp(`\\b${name}\\b`).test(DISCOVERY_INSTRUCTIONS));
  return named.every((name) => FIRST_TOOLS.includes(name) || ["mesh_import", "slice_wait"].includes(name));
})());
check("the instructions map every area", AREA_NAMES.every((area) => DISCOVERY_INSTRUCTIONS.includes(`${area}: `)));
check("every group is an area", Object.keys(TOOL_GROUPS).every((group) => AREA_NAMES.includes(group)) && AREA_NAMES.length === Object.keys(TOOL_GROUPS).length + 1);

// Reachability: every tool, field and op kind is found and explained through guide, with an example.
const reachable = catalogTools();
check("discovery covers every tool but the old aliases", reachable.length === TOOLS.length - UNLISTED_TOOLS.size);
const notFirst = reachable.filter((tool) => search(tool.name, 3)[0]?.label !== tool.name).map((tool) => tool.name);
check(`a search for a tool's name finds it first${notFirst.length ? `: not ${notFirst.join(", ")}` : ""}`, notFirst.length === 0);
const docProblems: string[] = [];
const REPLY_BUDGET = 3_000;
for (const tool of reachable) {
  const doc = toolDoc(tool.name, false);
  if (!doc) { docProblems.push(`${tool.name}: no doc`); continue; }
  const fields = Object.keys((tool.inputSchema.properties ?? {}) as Record<string, unknown>);
  const lines = doc.fields as string[];
  const missing = fields.filter((field) => !lines.some((line) => line.startsWith(`${field} (`)));
  if (missing.length) docProblems.push(`${tool.name}: no line for ${missing.join(", ")}`);
  if ((doc.examples as string[]).length === 0) docProblems.push(`${tool.name}: no example`);
  const sentence = firstSentence(tool.description);
  if (!/[.!?]$/.test(sentence) || sentence.length > 200 || sentence.length < 20) docProblems.push(`${tool.name}: first sentence "${sentence}" must stand alone, 20 to 200 characters`);
  // Bounds this tool's own reply only: growing one tool never touches another.
  const size = tokens(JSON.stringify(doc));
  if (size > REPLY_BUDGET) docProblems.push(`${tool.name}: guide {tool} is ~${size} tokens, over ${REPLY_BUDGET}`);
}
check(`guide {tool} explains every tool: a description, a line per field, an example${docProblems.length ? `: ${docProblems.join("; ")}` : ""}`, docProblems.length === 0);
const badExamples = Object.entries(EXAMPLES).flatMap(([name, list]) => list.map((args) => [name, validateTool(name, args)] as const).filter(([, problem]) => problem !== null).map(([n, problem]) => `${n}: ${problem}`));
check(`every example is a valid call${badExamples.length ? `: ${badExamples.join("; ")}` : ""}`, badExamples.length === 0);
check("every example is of a tool", Object.keys(EXAMPLES).every((name) => names.has(name)));
check("a search for an op kind finds it", OP_KINDS.every((kind) => search(kind, 3).some((hit) => hit.label === `op ${kind}`)));
check("a search by task finds the tool", search("paint a seam")[0]?.label === "paint_seam" && search("slice a mesh").some((hit) => hit.label === "slice_start") && search("export step").some((hit) => hit.label === "model_export_step"));
check("a search finds a field by its name", search("hinge angle").some((hit) => hit.label === "model_place" && hit.fields.includes("angle")));
check("a field cut from a refusal points at guide {tool}", String(validateTool("settings_apply", { nope: 1 })).includes("guide {tool:\"settings_apply\"}") || !String(validateTool("settings_apply", { nope: 1 })).includes(", ..."));
const grouped = Object.values(TOOL_GROUPS).flatMap((row) => row.tools);
check("every grouped tool is a tool, in one group", grouped.every((name) => names.has(name)) && new Set(grouped).size === grouped.length);
check("groups off lists every tool but tools_enable and the unlisted ones", listedTools(null).length === TOOLS.length - 1 - UNLISTED_TOOLS.size && !listedTools(null).some((tool) => UNLISTED_TOOLS.has(tool.name)) && !listedTools(null).some((tool) => tool.name === "tools_enable"));
check("the core list is the first tools, every tool outside a group, and tools_enable", listedTools(new Set(["core"])).every((tool) => groupOf(tool.name) === null) && listedTools(new Set(["core"])).some((tool) => tool.name === "tools_enable") && listedTools(new Set(["core"])).some((tool) => tool.name === "slice_start") && listedTools(new Set(["core"])).some((tool) => tool.name === "call"));
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

// A wrong field of a tool names the tool's own fields, so the next call is right. The op hints ("Use label.")
// stay for an op's fields.
check("a wrong tool field names the tool's fields", validateTool("workplane_set", { face: 3 }) === "input.face is not a field of this tool. It takes object, source, faceIndex, origin, turn.");
check("a wrong tool field gets no op hint", !String(validateTool("nugget", { action: "find", name: "x" })).includes("Use label."));

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("schema: ok");
