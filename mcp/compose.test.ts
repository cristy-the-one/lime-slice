/**
 * Composite Model edits, batches, labels, parameters, and the op schema's refusals, against the stand-in engine.
 * The real Open CASCADE kernel is not built in this run, so shapes are checked as the ops sent, not as solids.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cleanOp, expand, movedSpec, primitiveFrom, type ExpandContext, type Piece } from "./compose.ts";
import { evaluate, resolveNumbers } from "./expr.ts";
import { fakeEngine } from "./engine.ts";
import { validateTool } from "./schema.ts";
import { Session } from "./session.ts";
import { GLOBAL_WORKPLANE, workplaneOnFace } from "../src/workplane.ts";
import type { PrimitiveSpec } from "../src/model-primitive.ts";
import { eulerOrient } from "../src/mesh-place.ts";

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-compose-"));
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
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;
const nearAll = (a: readonly number[], b: readonly number[], eps = 1e-6) => a.length === b.length && a.every((value, i) => near(value, b[i]!, eps));

// Expressions.
check("an expression reads names and functions", near(evaluate("wallH / 2 + sqrt(4) * 3 - -1", { wallH: 10 }), 12));
check("power and brackets bind as written", near(evaluate("2 ^ 3 ^ 2", {}), 512) && near(evaluate("(1 + 2) * 3", {}), 9));
check("cos takes degrees", near(evaluate("cos(60)", {}), 0.5));
let unknown = "";
try {
  evaluate("roofW + 1", {});
} catch (err) {
  unknown = err instanceof Error ? err.message : "";
}
check("an unknown name is a sentence", unknown.includes("roofW") && unknown.includes("model_params"), unknown);
const resolved = resolveNumbers({ kind: "boolean", op: "cut", primitive: "box", dx: "w * 2", origin: [0, "w", 1], label: "left wall" }, { w: 3 }) as Record<string, unknown>;
check("numbers in an op resolve and text fields stay text", resolved.dx === 6 && (resolved.origin as number[])[1] === 3 && resolved.label === "left wall" && resolved.kind === "boolean", JSON.stringify(resolved));

// Primitive placement.
const byCentre = primitiveFrom({ primitive: "box", dx: 10, dy: 4, dz: 2, centre: [1, 2, 3] }) as PrimitiveSpec;
check("centre places a box by its middle", nearAll(byCentre.origin, [-4, 0, 2]), JSON.stringify(byCentre.origin));
const cylCentre = primitiveFrom({ primitive: "cylinder", radius: 5, height: 4, centre: [0, -20, 18], turn: [90, 0, 0] }) as PrimitiveSpec;
check("centre places a cylinder halfway up its axis", nearAll(cylCentre.origin, [0, -20, 16]), JSON.stringify(cylCentre.origin));
check("origin and centre together are refused", "reason" in primitiveFrom({ primitive: "box", origin: [0, 0, 0], centre: [0, 0, 0] }));
check("an echo keeps only the fields a box reads", JSON.stringify(cleanOp({ kind: "boolean", op: "cut", primitive: "box", origin: [0, 0, 0], size: [1, 2, 3], radius: 31, height: 3, turn: [0, 0, 0] })) === JSON.stringify({ kind: "boolean", op: "cut", primitive: "box", origin: [0, 0, 0], size: [1, 2, 3], turn: [0, 0, 0] }));

// Mirror and pattern geometry.
const tilted = primitiveFrom({ primitive: "box", dx: 60, dy: 1.6, dz: 0.8, centre: [0, 4, 55], turn: [45, 0, 0] }) as PrimitiveSpec;
const mirrored = movedSpec(tilted, { m: [1, 0, 0, 0, -1, 0, 0, 0, 1], t: [0, 0, 0], reflect: true }) as PrimitiveSpec;
const mirroredCentre = [mirrored.origin[0] + 30, mirrored.origin[1] + 0.8, mirrored.origin[2] + 0.4];
check("a mirrored groove sits on the other slope", nearAll(mirroredCentre, [0, -4, 55]), JSON.stringify(mirrored));
const turned = eulerOrient(mirrored.turn[0], mirrored.turn[1], mirrored.turn[2]);
const grooveNormal = [turned[1], turned[4], turned[7]];
check("a mirrored groove faces out of the other slope", nearAll(grooveNormal.map(Math.abs), [0, Math.SQRT1_2, Math.SQRT1_2]) && grooveNormal[1]! * grooveNormal[2]! < 0, JSON.stringify(mirrored.turn));
const wedge = primitiveFrom({ primitive: "wedge", dx: 4, dy: 4, dz: 4 }) as PrimitiveSpec;
check("a wedge mirror is refused", "reason" in movedSpec(wedge, { m: [-1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0], reflect: true }));

const globalCtx: ExpandContext = { plane: GLOBAL_WORKPLANE, face: () => ({ reason: "no faces" }) };
const toPart = (op: Record<string, unknown>): Piece | { reason: string } => {
  const spec = primitiveFrom(op);
  return "reason" in spec ? spec : { op: op.op === "fuse" ? "fuse" : "cut", spec };
};
const post = { kind: "boolean", op: "fuse", primitive: "cylinder", radius: 1, height: 5, origin: [0, 0, 0] };
const row = expand({ kind: "pattern", op: post, linear: { step: [10, 0, 0], count: 4, step2: [0, 5, 0], count2: 2 } }, globalCtx, toPart) as Piece[];
check("a linear grid makes count times count2 steps", Array.isArray(row) && row.length === 8 && nearAll(row[7]!.spec.origin, [30, 5, 0]), JSON.stringify(row.map((p) => p.spec.origin)));
const ring = expand({ kind: "pattern", op: { ...post, origin: [10, 0, 0] }, polar: { count: 4 } }, globalCtx, toPart) as Piece[];
check("a polar pattern turns copies about Z", ring.length === 4 && nearAll(ring[1]!.spec.origin, [0, 10, 0], 1e-5), JSON.stringify(ring.map((p) => p.spec.origin)));
const pair = expand({ kind: "mirror", op: { ...post, origin: [7, 2, 0] }, plane: "x" }, globalCtx, toPart) as Piece[];
check("a mirror keeps the original and adds its reflection", pair.length === 2 && nearAll(pair[1]!.spec.origin, [-7, 2, 0], 1e-6), JSON.stringify(pair.map((p) => p.spec.origin)));
const nested = expand({ kind: "mirror", plane: "y", op: { kind: "pattern", op: post, linear: { step: [5, 0, 0], count: 3 } } }, globalCtx, toPart) as Piece[];
check("a mirror of a pattern makes both rows", nested.length === 6);

// Pocket, boss, texture on a face: the -Y wall of a 60 x 40 x 35 house body.
const front = workplaneOnFace({ point: [0, -20, 17.5], normal: [0, -1, 0] });
const faceCtx: ExpandContext = { plane: GLOBAL_WORKPLANE, face: (index) => index === 5 ? { plane: front, extent: { u: [-30, 30], v: [-17.5, 17.5] } } : { reason: "That face is not on this solid." } };
const window = expand({ kind: "pocket", faceIndex: 5, at: { u: 18, v: 2.5 }, width: 10, height: 10, depth: 1.5, bars: { vertical: 1, horizontal: 1, width: 1 } }, faceCtx, toPart) as Piece[];
check("a barred window is one cut and two bars", window.length === 3 && window[0]!.op === "cut" && window[1]!.op === "fuse" && window[2]!.op === "fuse");
const cutBox = window[0]!.spec;
const cutCentre = [cutBox.origin[0] + 5, cutBox.origin[1] + 5, cutBox.origin[2] + 1.25];
check("the window cut is centred on the face point it names", near(cutCentre[2], 17.5 + 2.5, 1e-6) && near(Math.abs(cutCentre[0]), 18, 1e-6), JSON.stringify(cutBox));
const door = expand({ kind: "pocket", faceIndex: 5, shape: "arch", at: { u: 0, v: -8.5 }, width: 10, height: 18, depth: 1.5 }, faceCtx, toPart) as Piece[];
check("an arch is a box and a cylinder", door.length === 2 && door[0]!.spec.primitive === "box" && door[1]!.spec.primitive === "cylinder");
check("a short arch is refused", "reason" in (expand({ kind: "pocket", faceIndex: 5, shape: "arch", width: 10, height: 4, depth: 1 }, faceCtx, toPart) as object));
const sill = expand({ kind: "boss", faceIndex: 5, at: { u: 18, v: -3.25 }, width: 12, height: 1.5, depth: 2 }, faceCtx, toPart) as Piece[];
check("a boss is one fuse", sill.length === 1 && sill[0]!.op === "fuse");
const tiles = expand({ kind: "texture", faceIndex: 5, pattern: "brick", pitch: [10, 7] }, faceCtx, toPart) as Piece[];
const lines = tiles.filter((piece) => Math.max(...piece.spec.size) >= 59);
check("a brick texture has row grooves and staggered joints", lines.length === 4 && tiles.length > lines.length, `${tiles.length} ${lines.length}`);
check("a texture without a face or region is refused", "reason" in (expand({ kind: "texture", pitch: [5, 5] }, globalCtx, toPart) as object));
check("a missing face is refused", "reason" in (expand({ kind: "pocket", faceIndex: 9, width: 1, height: 1, depth: 1 }, faceCtx, toPart) as object));

// Schema refusals name the right field.
check("size on a boolean names dx, dy, dz", (validateTool("model_apply", { op: { kind: "boolean", op: "fuse", primitive: "box", size: [1, 2, 3] } }) ?? "").includes("Use dx, dy, dz"));
check("a nested unknown field is refused", (validateTool("model_apply", { op: { kind: "pattern", op: { kind: "boolean", op: "cut", primitive: "box", center: [0, 0, 0] }, linear: { step: [1, 0, 0], count: 2 } } }) ?? "").includes("Use centre"));
check("model_probe refuses a composite", (validateTool("model_probe", { op: { kind: "pocket", depth: 1 } }) ?? "").includes("several steps"));
check("a batch op is checked by index", (validateTool("model_apply_batch", { ops: [{ kind: "hole", diameterMm: 3, through: true }, { kind: "hole", diam: 3 }] }) ?? "").startsWith("ops[1].diam"));

// The session, end to end.
const engine = fakeEngine();
const session = new Session(engine);
const call = (name: string, args: unknown = {}) => session.call(name, args);

const info = await call("session_info");
const model = info.model as { composite?: string[]; guides?: string[] };
check("session_info lists composite ops and guides", !!model?.composite?.includes("texture") && !!model?.guides?.includes("ops"), JSON.stringify(info.model));
const topics = await call("guide");
check("guide lists its topics", JSON.stringify(topics).includes("compose"));
const opsGuide = await call("guide", { topic: "ops" });
check("guide returns the op reference", typeof opsGuide.text === "string" && (opsGuide.text as string).includes("pocket"));
check("an unknown guide names the topics", (await call("guide", { topic: "nope" })).ok === false);

const made = await call("solid_new", { primitive: "box", dx: 60, dy: 40, dz: 35 });
const object = String(made.object);
const bounds = made.bounds as { min: number[]; max: number[] };
check("solid_new returns bounds", nearAll(bounds.min, [-30, -20, 0]) && nearAll(bounds.max, [30, 20, 35]), JSON.stringify(made));

const roof = { kind: "boolean", op: "fuse", primitive: "box", centre: [0, 0, 35], dx: 60, dy: 33.94, dz: 33.94, turn: [45, 0, 0], label: "roof" };
const unprobed = await call("model_apply", { object, op: roof });
check("a plain apply without a probe is refused", unprobed.ok === false && String(unprobed.reason).includes("probe: true"));
const roofed = await call("model_apply", { object, op: roof, probe: true });
check("probe: true checks and applies in one call", roofed.ok === true && roofed.label === "roof", JSON.stringify(roofed));
const stored = roofed.stored as Record<string, unknown>;
check("the echo leaves out fields a box does not read", stored.radius === undefined && stored.height === undefined && Array.isArray(stored.size));

const historyBefore = ((await call("model_history", { object })).nodes as unknown[]).length;
const windows = await call("model_apply", {
  object,
  op: { kind: "mirror", plane: "x", label: "front windows", op: { kind: "pocket", faceIndex: 5, at: { u: 18, v: 2.5 }, width: 10, height: 10, depth: 1.5, bars: { vertical: 1, horizontal: 1 } } },
});
check("a mirrored barred window applies six steps", windows.ok === true && windows.applied === 6, JSON.stringify(windows));
const historyAfter = (await call("model_history", { object })).nodes as { id: string; label: string }[];
check("composite steps carry the label", historyAfter.length === historyBefore + 6 && historyAfter.some((node) => node.label === "front windows 1/6"), JSON.stringify(historyAfter.map((n) => n.label)));
const undone = await call("model_undo", { object });
check("one undo takes the whole composite back", undone.ok === true && undone.node === roofed.node && undone.group === "front windows", JSON.stringify(undone));
const redone = await call("model_redo", { object });
check("one redo brings it all again", redone.ok === true && redone.node === windows.node, JSON.stringify(redone));
const back = await call("model_goto", { object, node: "roof" });
check("model_goto takes a step label", back.ok === true && back.node === roofed.node, JSON.stringify(back));
const forward = await call("model_goto", { object, node: "front windows" });
check("model_goto takes a composite label", forward.ok === true && forward.node === windows.node, JSON.stringify(forward));

const rolled = await call("model_apply_batch", {
  object,
  label: "doomed",
  ops: [
    { kind: "pocket", faceIndex: 5, at: { u: 0, v: -8 }, width: 10, height: 18, depth: 1.5 },
    { kind: "boolean", op: "cut", primitive: "box", origin: [500, 500, 500], dx: 1, dy: 1, dz: 1 },
  ],
});
check("a refusal rolls the batch back", rolled.ok === false && rolled.rolledBack === true && (rolled.failed as { index: number }).index === 1 && rolled.node === windows.node, JSON.stringify(rolled));
const kept = await call("model_apply_batch", {
  object,
  onError: "stop",
  ops: [
    { kind: "pocket", faceIndex: 5, at: { u: 0, v: -8 }, width: 10, height: 18, depth: 1.5 },
    { kind: "boolean", op: "cut", primitive: "box", origin: [500, 500, 500], dx: 1, dy: 1, dz: 1 },
  ],
});
check("onError stop keeps what applied", kept.ok === false && kept.applied === 1 && kept.rolledBack === undefined, JSON.stringify(kept));

const params = await call("model_params", { set: { wallW: 60, half: "wallW / 2" } });
check("model_params evaluates in order", (params.params as Record<string, number>).half === 30, JSON.stringify(params));
const badParam = await call("model_params", { set: { "2bad": 1 } });
check("a bad parameter name is refused", badParam.ok === false);
// The stand-in engine answers model_goto with a 20 mm cube from the origin, so this cut sits inside that.
const exprApply = await call("model_apply", { object, probe: true, op: { kind: "boolean", op: "cut", primitive: "box", origin: ["half - 25", 1, 1], dx: "wallW / 10", dy: 2, dz: 1 } });
check("op numbers may be expressions", exprApply.ok === true && JSON.stringify(exprApply.typed).includes("[5,1,1]") && JSON.stringify(exprApply.typed).includes("[6,2,1]"), JSON.stringify(exprApply));
const badExpr = await call("model_apply", { object, probe: true, op: { kind: "boolean", op: "cut", primitive: "box", dx: "nope * 2" } });
check("an unknown name in an op is a refusal", badExpr.ok === false && String(badExpr.reason).includes("nope"), JSON.stringify(badExpr));

const built = await call("model_build", {
  name: "shed",
  params: { w: 30, d: 20, h: 15 },
  base: { primitive: "box", dx: "w", dy: "d", dz: "h" },
  ops: [
    { kind: "boolean", op: "fuse", primitive: "box", centre: [0, 0, "h"], dx: "w", dy: "d / sqrt(2)", dz: "d / sqrt(2)", turn: [45, 0, 0], label: "roof" },
    { kind: "texture", faceIndex: 4, pattern: "lines", pitch: [5, 5], label: "siding" },
  ],
});
check("model_build makes, edits, and commits in one call", built.ok === true && built.committed === true && typeof built.object === "string" && (built.applied as number) > 2, JSON.stringify(built));

writeFileSync(join(workspace, "taken.lime"), "{}");
const refusedSave = await call("project_save", { name: "taken.lime", ifExists: "refuse" });
check("project_save can refuse to replace a file", refusedSave.ok === false && String(refusedSave.reason).includes("already"), JSON.stringify(refusedSave));
const saved = await call("project_save", { name: "fresh.lime", ifExists: "refuse" });
check("project_save writes a new name", saved.ok === true, JSON.stringify(saved));

if (failed > 0) {
  console.error(`compose: ${failed} failed`);
  process.exit(1);
}
console.log("compose: ok");
