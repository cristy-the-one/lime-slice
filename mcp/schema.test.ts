import { occtHint } from "./engine.ts";
import { annotationsFor, TOOLS, validateTool } from "./schema.ts";

let failed = 0;
function check(name: string, ok: boolean) {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}`);
}

const names = new Set(TOOLS.map((tool) => tool.name));
check("the mvp tools are present", ["session_info", "project_open", "project_create", "project_save", "mesh_import", "plate_list", "object_select", "object_place", "object_remove", "machine_list", "machine_select", "settings_apply", "slice_start", "slice_wait", "slice_cancel", "gcode_summary", "gcode_export", "export_3mf"].every((name) => names.has(name)));
check("printer send is not a tool", !names.has("printer_send"));
check("project_save says it may overwrite", TOOLS.find((tool) => tool.name === "project_save")!.description.includes("overwrites"));
check(
  "a missing bridge names where to put it",
  occtHint("Open CASCADE bridge was not found.").includes("LIME_OCCT_BRIDGE") && occtHint("Open CASCADE bridge was not found.").includes("next to node"),
);
check("a bridge message that already names the variable stays as it is", !occtHint("Open CASCADE. Set LIME_OCCT_BRIDGE.").includes("next to node"));

check("a missing path is rejected", validateTool("project_open", {}) !== null);
check("a hole diameter of 0 is rejected", validateTool("model_probe", { object: "obj_1", op: { kind: "hole", diameterMm: 0, through: true } }) !== null);
check("a scale percent of 9 is rejected", validateTool("object_place", { object: "obj_1", scalePercent: 9 }) !== null);
check("a fractional edge index is rejected", validateTool("model_probe", { object: "obj_1", op: { kind: "fillet", edges: [1.5], size: 1 } }) !== null);
check("a hole does not take a fillet size", validateTool("model_probe", { object: "obj_1", op: { kind: "hole", size: 2 } }) !== null);
check("a counterbore is a hole field", validateTool("model_probe", { object: "obj_1", op: { kind: "hole", diameterMm: 4, through: true, counterboreDiameterMm: 8, counterboreDepth: 3 } }) === null);
check("an unknown edit names the kinds", validateTool("model_probe", { op: { kind: "twist" } }) === "op.kind must be one of hole, fillet, chamfer, split, scale, boolean, join.");
check("a low scale names the bound", validateTool("object_place", { object: "obj_1", scalePercent: 9 }) === "scalePercent must be at least 10.");
const layerHeight = (TOOLS.find((tool) => tool.name === "settings_apply")!.inputSchema.properties as { layerHeight: { minimum?: number; maximum?: number } }).layerHeight;
check("layer height is 0.08 to 0.4", layerHeight.minimum === 0.08 && layerHeight.maximum === 0.4);
check("layer height 0.9 is outside the schema", validateTool("settings_apply", { layerHeight: 0.9 }) !== null);
check("model_apply uses the typed edit", JSON.stringify(TOOLS.find((tool) => tool.name === "model_apply")!.inputSchema).includes("oneOf"));

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
const listed = JSON.stringify({
  tools: TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: annotationsFor(tool.name),
  })),
});
check("tools/list stays under 32 KB", Buffer.byteLength(listed) < 32 * 1024);

const accepted: [string, unknown][] = [
  ["session_info", {}],
  ["project_open", { path: "prints/bracket.lime" }],
  ["project_create", {}],
  ["project_save", { name: "bracket.lime" }],
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
