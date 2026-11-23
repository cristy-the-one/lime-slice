/**
 * Organic fix round S6: the view asks the kernel for its display mesh (`meshQuality: "display"`); every path whose
 * reply reaches the plate, a slice, an export or a file asks without it. One list decides: `requestFor` adds the field
 * to every mesh call, and a plate path opts out by name (`plateRequest`). The scan below finds every request a Model
 * module builds, so a new path is classified the day it is written.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { asksDisplay, DISPLAY_MESH_FIELD, MESH_CALLS, PURPOSE_KEY, plateRequest, requestFor } from "./model-mesh-quality.ts";
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
  const view = requestFor(request);
  const plate = requestFor(plateRequest(request));
  check(`${name}: the view's request asks for the display mesh`, asksDisplay(view));
  check(`${name}: a plate request does not, and its mark is not sent`, !asksDisplay(plate) && !(PURPOSE_KEY in plate) && !(DISPLAY_MESH_FIELD[0] in plate));
}
check("a call with no mesh is sent as it is", !("meshQuality" in requestFor({ call: "close", key: "a#1" })) && MESH_CALLS.has("goto") && !MESH_CALLS.has("close"));

// Every request a Model module builds, by file: the ones whose reply reaches the plate are marked plateRequest.
const root = fileURLToPath(new URL("./app/model/", import.meta.url));
const BUILDERS = /\b(openRequest|newSolidRequest|gotoRequest|editRequest|applyRequest|crossEditRequest|probeRequest)\(/;
/** The plate paths, one per line: file and the builder its reply goes to the plate from. */
const PLATE_PATHS: [string, string][] = [
  ["create.ts", "newSolidRequest"], // a new primitive object
  ["create.ts", "openRequest"], // a new sketch-feature object
  ["assembly.ts", "gotoRequest"], // a pose export's mesh at another chord
  ["split-apply.ts", "editRequest"], // a replayed piece of a split to print
  ["plate-mesh.ts", "gotoRequest"], // the plate boundary: a shown node's plate-quality mesh
];
const found: string[] = [];
for (const file of readdirSync(root).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))) {
  const lines = readFileSync(join(root, file), "utf8").split(/\r?\n/);
  for (const line of lines) {
    const match = BUILDERS.exec(line);
    if (!match || /^\s*(import|export function|\*|\/\/)/.test(line)) continue;
    if (line.includes("plateRequest(")) found.push(`${file}:${match[1]}`);
  }
}
for (const [file, builder] of PLATE_PATHS) check(`plate path ${file} ${builder} is marked plateRequest`, found.includes(`${file}:${builder}`), found.join(", "));
check("no other request is marked for the plate without being listed", found.every((site) => PLATE_PATHS.some(([file, builder]) => site === `${file}:${builder}`)), found.join(", "));
// Paths that take their engine calls through an adapter (plugins) or a reply's own solid (a split's other piece, the
// piece export) reach the plate only through plateRequest / plateSolidOf: the files say so.
for (const [file, needle] of [["plugins.ts", "plateRequest(request)"], ["plugin-panel.ts", "plateRequest(request)"], ["apply.ts", "plateSolidOf("], ["export.ts", "plateSolidOf("], ["commit.ts", "cachedPlateSolid("]] as const) {
  check(`${file} reaches the plate through ${needle.replace("(request)", "").replace("(", "")}`, readFileSync(join(root, file), "utf8").includes(needle));
}

if (failed) {
  console.error(`${failed} checks failed`);
  process.exit(1);
}
console.log("mesh quality: ok");
