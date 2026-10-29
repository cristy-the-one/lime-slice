/**
 * Print transitions through the MCP server against the stand-in engine (docs/plan-belt-transitions.md, step 2): the op
 * kind, its guide entry, the build direction worked out from the pose and the plate's printer and kept in the typed
 * echo, the support limit on the angle, and the refusals made before the kernel is asked. The real kernel's run is in
 * occt.test.ts.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fakeEngine } from "./engine.ts";
import { Session } from "./session.ts";
import { OP_KINDS, OP_SUMMARY, validateTool } from "./schema.ts";
import { buildDirection } from "../src/belt.ts";

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-mcp-transition-"));

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}
const close = (a: readonly number[] | undefined, b: readonly number[], tol = 1e-6) => !!a && a.length === b.length && a.every((value, i) => Math.abs(value - b[i]!) <= tol);

const engine = fakeEngine();
const session = new Session(engine);
const call = (name: string, args: unknown = {}) => session.call(name, args);

check("transition is an op kind with a summary", OP_KINDS.includes("transition") && typeof OP_SUMMARY.transition === "string");
check("the schema takes size \"face\" or mm", validateTool("model_probe", { object: "obj_1", op: { kind: "transition", edges: [3], size: "face" } }) === null && validateTool("model_probe", { object: "obj_1", op: { kind: "transition", edges: [3], size: 4 } }) === null);
check("the schema refuses an angle past 85°", validateTool("model_probe", { object: "obj_1", op: { kind: "transition", edges: [3], angleDeg: 90 } }) !== null);
const guide = await call("guide", { kind: "transition" });
check(
  "guide {kind:\"transition\"} has the summary, the schema and the ops guide's lines",
  guide.ok === true && guide.summary === OP_SUMMARY.transition && !!guide.schema && Array.isArray(guide.examples) && (guide.examples as string[]).some((line) => line.startsWith("transition:")),
  JSON.stringify(guide).slice(0, 400),
);
const info = await call("session_info", {});
check("session_info lists transition among the ops", ((info.model as { ops: string[] }).ops ?? []).includes("transition"));

const box = await call("solid_new", { primitive: "box", dx: 20, dy: 20, dz: 20 });
const object = String(box.object);
const typedOf = (reply: Record<string, unknown>) => reply.typed as Record<string, unknown>;

// --- A flat bed: the build is the plate's up, the angle the support limit, the size 2 mm.
await call("machine_select", { printerId: "lime-220", filamentId: "lime-pla" });
const flat = await call("model_probe", { object, op: { kind: "transition", edges: [3] } });
const sent = engine.lastProbe as Record<string, unknown> | null;
check("a probe on a flat bed sends build +Z", flat.ok === true && close(sent?.build as number[], [0, 0, 1]), JSON.stringify(sent));
check(
  "the defaults are filled into the typed echo",
  typedOf(flat).angleDeg === 45 && typedOf(flat).size === 2 && close(typedOf(flat).build as number[], [0, 0, 1]) && typedOf(flat).printer === "lime-220" && !("beltDeg" in typedOf(flat)),
  JSON.stringify(flat.typed),
);

// --- The IR3 V2: the belt at 45°, layers stacking toward −Y.
await call("machine_select", { printerId: "ideaformer-ir3-v2", filamentId: "lime-pla" });
const belt = await call("model_probe", { object, op: { kind: "transition", edges: [3] } });
const s = Math.SQRT1_2;
check("on the IR3 V2 the build is (0, −sin 45°, cos 45°)", close((engine.lastProbe as { build?: number[] }).build, [0, -s, s]), JSON.stringify(engine.lastProbe));
check("the belt angle and the pose are stored", typedOf(belt).beltDeg === 45 && close(typedOf(belt).orient as number[], [1, 0, 0, 0, 1, 0, 0, 0, 1]), JSON.stringify(belt.typed));

// --- Turned on the plate, the build follows the pose; a typed build is kept as typed.
await call("object_place", { object, rotX: 90 });
const orient = session.objects.find((row) => row.id === object)!.orient;
const turned = await call("model_probe", { object, op: { kind: "transition", edges: [3] } });
check("turned 90° about X, the build is the shared helper's for that pose", close((engine.lastProbe as { build?: number[] }).build, buildDirection(orient, { angleDeg: 45 }), 1e-9) && turned.ok === true, JSON.stringify(engine.lastProbe));
await call("model_probe", { object, op: { kind: "transition", edges: [3], build: [0, -s, s] } });
check("a typed build is sent as typed", close((engine.lastProbe as { build?: number[] }).build, [0, -s, s]));

// --- Refusals before the kernel.
const flatter = await call("model_probe", { object, op: { kind: "transition", edges: [3], angleDeg: 30 } });
check("an angle under the support limit is refused with the limit", flatter.ok === false && /at least 45°, the support limit/.test(String(flatter.reason)), JSON.stringify(flatter));
await call("settings_set", { values: { supportAngle: 60 } });
const looser = await call("model_probe", { object, op: { kind: "transition", edges: [3], angleDeg: 30 } });
check("a support angle of 60° lets the wedge lie at 30°", looser.ok === true, JSON.stringify(looser));
const defaulted = await call("model_probe", { object, op: { kind: "transition", edges: [3] } });
check("and the default angle follows the limit", typedOf(defaulted).angleDeg === 30, JSON.stringify(defaulted.typed));
const noEdge = await call("model_probe", { object, op: { kind: "transition", edges: [] } });
check("no edge is refused", noEdge.ok === false && noEdge.reason === "Pick an edge for the print transition.", JSON.stringify(noEdge));
const zero = await call("model_probe", { object, op: { kind: "transition", edges: [3], build: [0, 0, 0] } });
check("a zero build is refused", zero.ok === false && /direction/.test(String(zero.reason)), JSON.stringify(zero));

// --- Step 3: a step made for another pose. model_describe names it; the solid keeps it as built.
await call("settings_set", { values: { supportAngle: 45 } });
await call("object_place", { object, rotX: 0 });
await call("model_probe", { object, op: { kind: "transition", edges: [3] } });
const applied = await call("model_apply", { object, op: { kind: "transition", edges: [3] } });
check("the transition applies", applied.ok === true, JSON.stringify(applied).slice(0, 300));
const aimed = await call("model_describe", { object, limit: 1 });
check("a step made for this pose has no note", !("notes" in aimed) && !("staleTransitions" in aimed), JSON.stringify(aimed.notes));
await call("object_place", { object, rotZ: 90 });
const described = await call("model_describe", { object, limit: 1 });
const stale = described.staleTransitions as { node: string; offDeg: number }[] | undefined;
check(
  "after a turn about the plate's Z, model_describe names the step stale",
  stale?.length === 1 && stale[0]!.offDeg === 60 && (described.notes as string[])[0]!.includes("was made for another pose") && (described.notes as string[])[0]!.includes("build:null"),
  JSON.stringify({ notes: described.notes, stale }),
);
await call("object_place", { object, rotZ: 0 });
check("turned back, the note goes", !("notes" in (await call("model_describe", { object, limit: 1 }))));

// --- Step 5: auto-find. model_probe {op:{kind:"transition"}, plan:true} asks the kernel for the edges that start in the
// air on the current step, with this pose's build direction, the plate's up and the support limit; nothing is applied.
check("the schema takes a transition with no edges for plan:true", validateTool("model_probe", { object, op: { kind: "transition" }, plan: true }) === null);
const stepsBefore = ((await call("model_history", { object })).steps as unknown[] | undefined)?.length;
const plan = await call("model_probe", { object, op: { kind: "transition" }, plan: true });
const asked = engine.lastFind as Record<string, unknown> | null;
check(
  "plan:true sends transitionFind for this pose on the current step",
  asked?.call === "transitionFind" && close(asked.build as number[], [0, -s, s]) && close(asked.up as number[], [0, 0, 1]) && asked.limitDeg === 45
    && JSON.stringify(asked.fix) === JSON.stringify({ mode: "auto", angleDeg: 45, size: 2 }),
  JSON.stringify(asked),
);
const planRows = plan.rows as Record<string, unknown>[] | undefined;
check("the rows come longest first, ties by edge", planRows?.map((row) => (row.edges as number[])[0]).join() === "3,7,9", JSON.stringify(planRows));
check(
  "a row is {edges, case, lengthMm, at, fix} with its wedge's volume",
  JSON.stringify(planRows?.[0]) === JSON.stringify({ edges: [3], case: "corner", lengthMm: 20, at: [10, 0, 20], fix: { kind: "transition", mode: "auto", angleDeg: 45, size: 2, edges: [3] }, volumeMm3: 40 }),
  JSON.stringify(planRows?.[0]),
);
check("a fix that refuses gives its sentence", planRows?.[1]?.case === "lip" && /convex/.test(String(planRows?.[1]?.refused)) && planRows?.[2]?.case === "corner" && /adds nothing/.test(String(planRows?.[2]?.refused)), JSON.stringify(planRows));
check("the ready op holds only the rows that build", JSON.stringify(plan.op) === JSON.stringify({ kind: "transition", mode: "auto", angleDeg: 45, size: 2, edges: [3] }), JSON.stringify(plan.op));
check(
  "the reason counts the cases, the refusals and the curved edges",
  plan.ok === true && plan.curvedSkipped === 2 && JSON.stringify(plan.curvedEdges) === "[11,12]" && String(plan.reason).startsWith("3 edges start in the air: 2 corners and 1 lip, longest first. 1 fix builds; 2 refuse, each saying why. 2 curved edges skipped until a later version."),
  String(plan.reason),
);
check("nothing is applied", ((await call("model_history", { object })).steps as unknown[] | undefined)?.length === stepsBefore);
const ready = await call("model_probe", { object, op: plan.op });
check("the ready op probes as an ordinary transition", ready.ok === true && (engine.lastProbe as { kind?: string }).kind === "transition", JSON.stringify(ready).slice(0, 300));
const faced = await call("model_probe", { object, op: { kind: "transition", edges: [3], mode: "add", size: "face" } });
check("mode and size words are words, not parameter names", faced.ok === true && (engine.lastProbe as { size?: unknown }).size === "face" && (engine.lastProbe as { mode?: unknown }).mode === "add", JSON.stringify(faced).slice(0, 300));
await call("model_probe", { object, op: { kind: "transition", size: 5, angleDeg: 50 }, plan: true });
check("plan:true passes a typed size and angle to every row's fix", JSON.stringify((engine.lastFind as { fix?: unknown }).fix) === JSON.stringify({ mode: "auto", angleDeg: 50, size: 5 }), JSON.stringify(engine.lastFind));
const withEdges = await call("model_probe", { object, op: { kind: "transition", edges: [3] }, plan: true });
check("plan:true finds the edges itself", withEdges.ok === false && /not edges/.test(String(withEdges.reason)), JSON.stringify(withEdges));
const cutPlan = await call("model_probe", { object, op: { kind: "transition", mode: "cut" }, plan: true });
check("plan:true proposes mode auto only", cutPlan.ok === false && /mode auto/.test(String(cutPlan.reason)), JSON.stringify(cutPlan));
const flatPlan = await call("model_probe", { object, op: { kind: "transition", angleDeg: 30 }, plan: true });
check("plan:true keeps the support limit on the angle", flatPlan.ok === false && /support limit/.test(String(flatPlan.reason)), JSON.stringify(flatPlan));
await call("machine_select", { printerId: "lime-220", filamentId: "lime-pla" });
await call("model_probe", { object, op: { kind: "transition" }, plan: true });
check("on a flat bed the build is the plate's up", close((engine.lastFind as { build?: number[] }).build, [0, 0, 1]), JSON.stringify(engine.lastFind));

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("transition: ok");
