/**
 * Anchors, model_anchors, each loops, model_define parts, and recipes saved with the project, against the stand-in engine.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { boxPoint, opBox, resolveAnchors } from "./anchors.ts";
import { fakeEngine } from "./engine.ts";
import { expandOps } from "./macro.ts";
import { OP_WORDS, validateTool } from "./schema.ts";
import { Session } from "./session.ts";

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-anchors-"));
process.env.LIME_MCP_WORKSPACE = workspace;

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}
const nearAll = (a: readonly number[], b: readonly number[], eps = 1e-6) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]!) < eps);

// Boxes of stored ops.
const cyl = opBox({ kind: "boolean", op: "fuse", primitive: "cylinder", origin: [0, 0, 10], size: [0, 0, 0], radius: 3, height: 5, turn: [0, 0, 0] } as never);
check("a cylinder's box", !!cyl && nearAll(cyl.min, [-3, -3, 10]) && nearAll(cyl.max, [3, 3, 15]), JSON.stringify(cyl));
const loft = opBox({ kind: "loft", op: "fuse", sections: [{ origin: [0, 0, 0], turn: [0, 0, 0], radius: 2 }, { origin: [0, 0, 10], turn: [0, 0, 0], radius: 4 }] });
check("a loft's box spans its sections", !!loft && nearAll(loft.min, [-4, -4, 0]) && nearAll(loft.max, [4, 4, 10]), JSON.stringify(loft));
const extrude = opBox({ kind: "extrude", op: "fuse", origin: [0, 5, 0], turn: [90, 0, 0], profile: [[0, 0], [10, 0], [5, 8]], depth: 4 });
check("an extrude's box follows its plane", !!extrude && nearAll(extrude.min, [0, 1, 0]) && nearAll(extrude.max, [10, 5, 8]), JSON.stringify(extrude));
const bothWays = opBox({ kind: "extrude", op: "fuse", origin: [0, 0, 0], turn: [0, 0, 0], profile: [[0, 0], [10, 0], [10, 10], [0, 10]], depth: 10, depth2: 4 });
check("a second depth reaches the other side of the plane", !!bothWays && nearAll(bothWays.min, [0, 0, -4]) && nearAll(bothWays.max, [10, 10, 10]), JSON.stringify(bothWays));
const revolve = opBox({ kind: "revolve", op: "fuse", origin: [0, 0, 0], turn: [90, 0, 0], profile: [[0, 0], [6, 0], [6, 2], [0, 4]] });
check("a revolve's box is round its axis", !!revolve && nearAll(revolve.min, [-6, -6, 0]) && nearAll(revolve.max, [6, 6, 4]), JSON.stringify(revolve));
check("points of a box", JSON.stringify(boxPoint({ min: [0, 0, 0], max: [2, 4, 6] }, "top")) === "[1,2,6]" && JSON.stringify(boxPoint({ min: [0, 0, 0], max: [2, 4, 6] }, "front")) === "[1,0,3]");
const resolved = resolveAnchors({ kind: "boolean", centre: { anchor: "post", point: "top", offset: [0, 0, 1] }, op: { kind: "boolean", origin: { anchor: "post" } } }, () => ({ min: [0, 0, 0], max: [2, 2, 2] })) as Record<string, unknown>;
check("anchors resolve anywhere in an op, nested ops too", JSON.stringify(resolved.centre) === "[1,1,3]" && JSON.stringify((resolved.op as Record<string, unknown>).origin) === "[1,1,1]", JSON.stringify(resolved));
check("an anchor passes the schema where a point goes", validateTool("model_apply", { op: { kind: "boolean", op: "fuse", primitive: "sphere", radius: 1, centre: { anchor: "post", point: "top" } } }) === null);

// Loops and parts.
const looped = expandOps([{ kind: "each", var: "k", count: 3, ops: [{ kind: "boolean", op: "cut", primitive: "box", centre: ["k * 10", 0, 0], dx: 1, dy: 1, dz: 1, label: "slot {k}" }] }], {}, new Map(), OP_WORDS) as Record<string, unknown>[];
check("each repeats its ops with the loop name", looped.length === 3 && JSON.stringify(looped[2]!.centre) === "[20,0,0]" && looped[1]!.label === "slot 1", JSON.stringify(looped));
const ranged = expandOps([{ kind: "each", var: "a", from: 0, to: 270, step: 90, ops: [{ kind: "boolean", op: "cut", primitive: "box", turn: [0, 0, "a"], dx: 1, dy: 1, dz: 1 }] }], {}, new Map(), OP_WORDS);
check("from, to, and step include the end", ranged.length === 4, String(ranged.length));
const nested = expandOps([{ kind: "each", var: "i", values: [1, 2], ops: [{ kind: "each", var: "j", count: 2, ops: [{ kind: "boolean", op: "cut", primitive: "box", centre: ["i", "j", 0], dx: 1, dy: 1, dz: 1 }] }] }], {}, new Map(), OP_WORDS) as Record<string, unknown>[];
check("loops nest", nested.length === 4 && JSON.stringify(nested[3]!.centre) === "[2,1,0]", JSON.stringify(nested.map((op) => op.centre)));
const parts = new Map([["peg", { params: { r: 1, h: 4, x: 0 }, ops: [{ kind: "boolean", op: "fuse", primitive: "cylinder", radius: "r", height: "h", centre: ["x", 0, "h / 2"], label: "shaft" }] }]]);
const used = expandOps([{ kind: "use", part: "peg", with: { x: 7, r: "2 * 1.5" }, label: "left peg" }], {}, parts, OP_WORDS) as Record<string, unknown>[];
check("use places a part with its parameters and a label prefix", used.length === 1 && used[0]!.radius === 3 && JSON.stringify(used[0]!.centre) === "[7,0,2]" && used[0]!.label === "left peg shaft", JSON.stringify(used));
let unknownPart = "";
try {
  expandOps([{ kind: "use", part: "nope" }], {}, parts, OP_WORDS);
} catch (err) {
  unknownPart = String(err);
}
check("an unknown part is named, with the parts there are", unknownPart.includes("nope") && unknownPart.includes("peg"), unknownPart);

// The session.
const engine = fakeEngine();
const session = new Session(engine);
const call = (name: string, args: unknown = {}) => session.call(name, args);
const built = await call("model_build", { name: "post", base: { primitive: "box", dx: 20, dy: 20, dz: 20 }, params: { n: 3 }, ops: [
  { kind: "boolean", op: "fuse", primitive: "cylinder", radius: 2, height: 6, centre: [0, 0, 18], label: "post" },
  { kind: "boolean", op: "fuse", primitive: "sphere", radius: 1.5, centre: { anchor: "post", point: "top" }, label: "knob" },
  { kind: "each", var: "i", count: "n", ops: [{ kind: "boolean", op: "cut", primitive: "box", dx: 1, dy: 1, dz: 1, centre: ["i * 4 - 4", -9.5, 10], label: "notch {i}" }] },
] });
check("a build with an anchor and a loop applies", built.ok === true && built.applied === 5, JSON.stringify(built));
const knob = engine.calls.length > 0 ? (await call("model_anchors", { object: built.object, label: "knob" })) : {};
check("the anchor put the knob on the post's top", JSON.stringify(knob.centre) === "[0,0,21]", JSON.stringify(knob));
const all = await call("model_anchors", { object: built.object });
const names = ((all.labels ?? []) as { label: string }[]).map((row) => row.label);
check("model_anchors lists the labels, each loop copy apart", names.includes("post") && names.includes("notch 2") && !!all.part, JSON.stringify(names));
const missing = await call("model_apply", { object: built.object, op: { kind: "boolean", op: "fuse", primitive: "sphere", radius: 1, centre: { anchor: "lid" } }, probe: true });
check("an anchor to no label is a refusal naming it", missing.ok === false && String(missing.reason).includes("\"lid\""), JSON.stringify(missing));

const defined = await call("model_define", { name: "peg", params: { r: 1, x: 0 }, ops: [{ kind: "boolean", op: "fuse", primitive: "cylinder", radius: "r", height: 3, centre: ["x", 0, 21], label: "peg" }] });
check("model_define stores a part", defined.ok === true && (defined.parts as { name: string }[])[0]!.name === "peg", JSON.stringify(defined));
const badPart = await call("model_define", { name: "bad", ops: [{ kind: "boolean", op: "fuse", primitive: "box", dx: "nope", dy: 1, dz: 1 }] });
check("a part with a bad expression is refused when defined", badPart.ok === false && String(badPart.reason).includes("nope"), JSON.stringify(badPart));
const pegs = await call("model_build", { name: "pegs", base: { primitive: "box", dx: 20, dy: 20, dz: 20 }, params: { count: 2 }, ops: [
  { kind: "each", var: "k", count: "count", ops: [{ kind: "use", part: "peg", with: { x: "k * 6 - 3" }, label: "peg {k}" }] },
] });
check("use inside each places a part per loop", pegs.ok === true && pegs.applied === 2, JSON.stringify(pegs));
const rerun = await call("model_build", { object: pegs.object, params: { count: 3 } });
check("a recipe reruns with new parameters, reusing the ops that match", rerun.ok === true && rerun.object === pegs.object && rerun.applied === 3 && (rerun.resumed as { reusedOps?: number })?.reusedOps === 2, JSON.stringify(rerun));
const noRecipe = await call("model_build", { object: "obj_99", params: {} });
check("rerunning an object without a recipe is a refusal", noRecipe.ok === false, JSON.stringify(noRecipe));

const saved = await call("project_save", { name: "recipes.lime" });
const doc = JSON.parse(readFileSync(join(workspace, "recipes.lime"), "utf8")) as { mcpModel?: { parts?: Record<string, unknown>; recipes?: Record<string, { recipe: { params: Record<string, unknown> } }> } };
check("the project keeps parts and recipes", saved.ok === true && !!doc.mcpModel?.parts?.peg && doc.mcpModel?.recipes?.[String(pegs.object)]?.recipe.params.count === 3, JSON.stringify(doc.mcpModel).slice(0, 300));
const reopened = new Session(fakeEngine());
await reopened.call("project_open", { path: "recipes.lime" });
const again = await reopened.call("model_build", { object: String(pegs.object), params: { count: 1 } });
const defs = await reopened.call("model_define", {});
check("a reopened project reruns a recipe and keeps its parts", again.ok === true && (defs.parts as unknown[]).length === 1, JSON.stringify({ again, defs }));

if (failed > 0) {
  console.error(`anchors: ${failed} failed`);
  process.exit(1);
}
console.log("anchors: ok");
