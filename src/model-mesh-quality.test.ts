/**
 * The Model view asks for the kernel's display mesh (`meshQuality: "display"`) on the requests it draws; a request whose
 * reply only feeds the plate or an export does not. Either way the reply's `positions` are the plate mesh, so this only
 * decides who gets the extra `display` mesh. A scan lists every request a Model module builds, against two lists, so a
 * new path is classified the day it is written.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { asksDisplay, DISPLAY_MESH_FIELD, MESH_CALLS, viewRequest } from "./model-mesh-quality.ts";
import { applyRequest, editRequest, gotoRequest, newSolidRequest, openRequest, probeRequest } from "./model-request.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

check("the wire field is the kernel's: meshQuality = \"display\"", DISPLAY_MESH_FIELD[0] === "meshQuality" && DISPLAY_MESH_FIELD[1] === "display");
const box = { kind: "boolean", op: "cut", primitive: "box", origin: [0, 0, 0], size: [1, 1, 1], radius: 0, height: 0, turn: [0, 0, 0] } as never;
const builders: [string, Record<string, unknown>][] = [
  ["open", openRequest("a#1", { kind: "primitive", solid: { primitive: "box", origin: [0, 0, 0], size: [2, 2, 2] } } as never, 0.05) as Record<string, unknown>],
  ["new solid", newSolidRequest("a#1", { primitive: "box", origin: [0, 0, 0], size: [2, 2, 2] } as never, 0.05) as Record<string, unknown>],
  ["goto", gotoRequest("a#1", 2, 0.05) as Record<string, unknown>],
  ["apply", applyRequest("a#1", 0, 1, box, 0.05) as Record<string, unknown>],
  ["edit", editRequest("a#1", 0, 1, box, [], 0.05) as Record<string, unknown>],
  ["probe preview", probeRequest("a#1", 0, box, 0.05) as Record<string, unknown>],
  ["surface inspect", { call: "surfaceInspect", key: "a#1", node: 2, chordMm: 0.05, curvature: true }],
];
for (const [name, request] of builders) {
  check(`${name}: a builder alone sends no display field`, !asksDisplay(request));
  check(`${name}: built for the view, it asks for the display mesh`, asksDisplay(viewRequest(request)));
}
check("a call with no mesh is sent as it is", !(DISPLAY_MESH_FIELD[0] in viewRequest({ call: "close", key: "a#1" })) && MESH_CALLS.has("goto") && !MESH_CALLS.has("close"));

// Every request a Model module builds, by file and builder: drawn by the view (flag) or feeding the plate or an export.
const root = fileURLToPath(new URL("./app/model/", import.meta.url));
const BUILDERS = /\b(openRequest|newSolidRequest|gotoRequest|editRequest|applyRequest|crossEditRequest|probeRequest)\(/;
const VIEW: string[] = [
  "apply.ts:applyRequest", "edge-tool.ts:probeRequest", "edges.ts:gotoRequest", "edit.ts:probeRequest", "history.ts:gotoRequest",
  "parameters.ts:gotoRequest", "probe.ts:probeRequest", "pull.ts:probeRequest", "run-edit.ts:editRequest", "run-edit.ts:crossEditRequest",
  "split-apply.ts:applyRequest", "split-apply.ts:crossEditRequest", "split-print.ts:probeRequest", "transition.ts:probeRequest",
  "tree.ts:openRequest", "tree.ts:gotoRequest", "nurbs-sculpt.ts:editRequest",
];
/** No flag: a new object's mesh, a restore or replay, the pose and piece exports, an interference probe, a plugin's moves. */
const NO_FLAG: string[] = [
  "create.ts:newSolidRequest", "create.ts:openRequest", "assembly.ts:probeRequest", "assembly.ts:gotoRequest", "engine.ts:probeRequest",
  "engine.ts:openRequest", "engine.ts:applyRequest", "plugin-panel.ts:gotoRequest", "pose-solid.ts:gotoRequest", "pose-solid.ts:openRequest",
  "split-apply.ts:editRequest",
];
const flagged = new Set<string>();
const plain = new Set<string>();
for (const file of readdirSync(root).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))) {
  for (const line of readFileSync(join(root, file), "utf8").split(/\r?\n/)) {
    const match = BUILDERS.exec(line);
    if (!match || /^\s*(import|export function|\*|\/\/)/.test(line)) continue;
    (line.includes("viewRequest(") ? flagged : plain).add(`${file}:${match[1]}`);
  }
}
check("every view request asks for the display mesh", VIEW.every((site) => flagged.has(site)), `missing: ${VIEW.filter((site) => !flagged.has(site)).join(", ")}`);
check("every request without the flag is one listed as plate or export", [...plain].every((site) => NO_FLAG.includes(site)), `unlisted: ${[...plain].filter((site) => !NO_FLAG.includes(site)).join(", ")}`);
check("no plate or export request asks for the display mesh", NO_FLAG.every((site) => !flagged.has(site)), [...flagged].filter((site) => NO_FLAG.includes(site)).join(", "));
const view = readFileSync(join(root, "view.ts"), "utf8");
check("surfaceInspect asks with the same field, so its curvature matches the mesh drawn", /viewRequest\(\{\s*call: "surfaceInspect"/.test(view));

if (failed) {
  console.error(`${failed} checks failed`);
  process.exit(1);
}
console.log("mesh quality: ok");
