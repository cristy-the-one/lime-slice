/**
 * Gaps batch A against the stand-in engine: each op field typed as an expression is stored with a link the app's
 * Parameters panel counts and its Rebuild follows (`op.exprs`), for model_apply, model_apply_batch with `use`, and
 * model_build; the workplane's expressions; call-level params; and project_create's refusal.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fakeEngine } from "./engine.ts";
import { Session } from "./session.ts";
import { stepOutOfDate, usedByCount } from "../src/modeling/params.ts";
import type { ModelOp } from "../src/model-tree.ts";

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-mcp-vars-links-"));

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}
const json = (value: unknown) => JSON.stringify(value);

const session = new Session(fakeEngine());
const call = (name: string, args: unknown = {}) => session.call(name, args) as Promise<Record<string, any>>;
const params = { w: 40, h: 30, r: 4, t: 3, u: 10, px: -6, d: 4, L: 12, n: 3 };
await call("model_params", { set: params });

/** The stored ops of the object's history, oldest first, from a saved project, and its root's links. */
async function stored(object: string): Promise<{ ops: ModelOp[]; root?: Record<string, string> }> {
  const saved = await call("project_save", { name: `links-${object}-${Date.now()}.lime` });
  const doc = JSON.parse(readFileSync(String(saved.path), "utf8")) as { objects: { id?: string; modelTree?: { rootExprs?: Record<string, string>; nodes?: { op?: ModelOp | null }[]; current?: number } }[] };
  const listed = await call("plate_list", { limit: 100 });
  const index = (listed.objects as { object: string }[]).findIndex((row) => row.object === object);
  const tree = doc.objects[index]!.modelTree!;
  return { ops: (tree.nodes ?? []).map((node) => node.op).filter((op): op is ModelOp => !!op), root: tree.rootExprs };
}

async function applied(op: Record<string, unknown>, base: Record<string, unknown> = { primitive: "box", dx: 80, dy: 80, dz: 20 }): Promise<{ result: Record<string, any>; op: ModelOp | undefined; all: ModelOp[] }> {
  const made = await call("solid_new", base);
  const result = await call("model_apply", { object: made.object, probe: true, op });
  const { ops } = await stored(String(made.object));
  return { result, op: ops.at(-1), all: ops };
}

const square = [[0, 0], ["w", 0], ["w", "h"], [0, "h"]];
{
  const { result, op } = await applied({ kind: "extrude", op: "fuse", profile: square, depth: "t", origin: [0, 0, "t"], turn: [0, 0, 0] });
  check("an extrude applies", result.ok === true, json(result));
  check("an extrude links its profile points, its plane's origin, and its depth", json(op?.exprs) === json({ "@origin.2": "t", "@profile.1.0": "w", "@profile.2.0": "w", "@profile.2.1": "h", "@profile.3.1": "h", depth: "t" }), json(op?.exprs));
  check("the panel counts the extrude for w and t", usedByCount("w", [op!]) === 1 && usedByCount("t", [op!]) === 1 && usedByCount("r", [op!]) === 0);
  check("and the extrude is out of date when h moves", !stepOutOfDate(op!, params) && stepOutOfDate(op!, { ...params, h: 31 }));
}
{
  const { op } = await applied({ kind: "extrude", op: "fuse", profile: [[0, 0], [10, 0], [10, 10]], depth: 5, origin: [0, 0, 20], turn: [0, 0, "u"] });
  check("an extrude's plane turn links", json(op?.exprs) === json({ "@turn.2": "u" }), json(op?.exprs));
}
{
  const loop = { start: [0, 0], segments: [{ kind: "line", to: ["w", 0] }, { kind: "arc", through: ["w + r", "h / 2"], to: ["w", "h"] }, { kind: "line", to: [0, "h"] }] };
  const { op } = await applied({ kind: "extrude", op: "fuse", loops: [loop], depth: 4, origin: [0, 0, 20], turn: [0, 0, 0] });
  check("an extrude's loop points link", json(op?.exprs) === json({ "@loops.0.segments.0.to.0": "w", "@loops.0.segments.1.through.0": "w + r", "@loops.0.segments.1.through.1": "h / 2", "@loops.0.segments.1.to.0": "w", "@loops.0.segments.1.to.1": "h", "@loops.0.segments.2.to.1": "h" }), json(op?.exprs));
}
{
  const { op } = await applied({ kind: "revolve", op: "fuse", profile: [[2, 0], ["r + 2", 0], ["r + 2", "L"], [2, "L"]], axisOrigin: [0, 0], axisDir: [0, 1], angleDeg: "90 + u", origin: [0, 0, 20], turn: [90, 0, 0] });
  check("a revolve links its profile and its angle", json(op?.exprs) === json({ "@profile.1.0": "r + 2", "@profile.2.0": "r + 2", "@profile.2.1": "L", "@profile.3.1": "L", angle: "90 + u" }), json(op?.exprs));
}
{
  const { op } = await applied({ kind: "loft", op: "fuse", sections: [{ origin: [0, 0, 20], turn: [0, 0, 0], radius: "r" }, { origin: [0, 0, "20 + L"], turn: [0, 0, 0], radius: "r / 2" }] });
  check("a loft links each section's place and size", json(op?.exprs) === json({ "@sections.0.radius": "r", "@sections.1.origin.2": "20 + L", "@sections.1.radius": "r / 2" }), json(op?.exprs));
}
{
  const { result, op } = await applied({ kind: "sweep", op: "fuse", path: [[0, 0, 20], [0, 0, "20 + L"]], radius: "r / 2" });
  const linked = Object.keys(op?.exprs ?? {});
  check("a straight sweep links its sections along the path", result.ok === true && linked.includes("@sections.1.origin.2") && linked.includes("@sections.0.radius"), json(op?.exprs));
  const bent = await applied({ kind: "sweep", op: "fuse", path: [[0, 0, 20], ["u", 0, 30], [0, 0, 40]], radius: 2 });
  check("a sweep whose path turns with u keeps u unlinked and says so", !Object.values(bent.op?.exprs ?? {}).some((text) => text.includes("u")) && json(bent.result.notLinked?.map((row: { text: string }) => row.text)) === '["u"]', json([bent.op?.exprs, bent.result.notLinked]));
}
{
  const { op } = await applied({ kind: "boolean", op: "cut", primitive: "box", dx: "w / 4", dy: 6, dz: 6, origin: ["px", "-h / 4", 16] });
  check("a boolean links its position and size by the panel's fields", json(op?.exprs) === json({ modelX: "px", modelY: "-h / 4", modelDx: "w / 4" }), json(op?.exprs));
  const centred = await applied({ kind: "boolean", op: "cut", primitive: "box", dx: "w / 4", dy: 6, dz: 6, centre: ["px", 0, 18] });
  check("a boolean placed by its centre keeps its links, the corner following the size", json(centred.op?.exprs) === json({ "@origin.0": "-0.5 * (w / 4) + (px)", modelDx: "w / 4" }), json(centred.op?.exprs));
  const at = (centred.op as unknown as { origin: number[] }).origin;
  check("whose numbers are in date", at[0] === -11 && !stepOutOfDate(centred.op!, params));
}
{
  const { op } = await applied({ kind: "mirror", plane: "x", op: { kind: "boolean", op: "cut", primitive: "cylinder", radius: "r / 2", height: 5, origin: ["u", 0, 15] } });
  const steps = op?.kind === "group" ? op.steps : [];
  check("a mirror's copies link one by one", steps.length === 2 && json(steps.map((step) => step.exprs)) === json([{ modelX: "u", modelRadius: "r / 2" }, { "@origin.0": "-(u)", modelRadius: "r / 2" }]), json(steps.map((step) => step.exprs)));
  check("the mirror counts once for u", usedByCount("u", [op!]) === 1);
  const pattern = await applied({ kind: "pattern", op: { kind: "boolean", op: "cut", primitive: "box", dx: 2, dy: 2, dz: 4, origin: [-30, 0, 16] }, linear: { count: 3, step: ["L", 0, 0] } });
  const copies = pattern.op?.kind === "group" ? pattern.op.steps : [];
  check("a pattern's copies follow its step", copies.length === 3 && json(copies.map((step) => step.exprs ?? null)) === json([null, { "@origin.0": "-30 + (L)" }, { "@origin.0": "-30 + 2 * (L)" }]),json(copies.map((step) => step.exprs ?? null)));
}
{
  const made = await call("solid_new", { primitive: "box", dx: 40, dy: 40, dz: 10 });
  const top = await call("faces_find", { object: made.object, normal: [0, 0, 1] });
  const face = top.faces?.[0]?.index;
  const pull = await call("model_apply", { object: made.object, probe: true, op: { kind: "faceExtrude", face, distance: "t" } });
  const moved = await call("model_apply", { object: made.object, probe: true, op: { kind: "moveFaces", faces: [{ face, distance: "t / 3" }] } });
  const hole = await call("model_apply", { object: made.object, probe: true, op: { kind: "hole", diameterMm: "d", depth: 3, at: { u: "px", v: "u - 5" } } });
  const split = await call("model_apply", { object: made.object, probe: true, op: { kind: "split", origin: [0, 0, "t"], normal: [0, 0, 1], keep: "below" } });
  check("face, hole, and split ops apply", [pull, moved, hole, split].every((row) => row.ok === true), json([pull, moved, hole, split]));
  const { ops } = await stored(String(made.object));
  const by = (kind: string) => ops.find((op) => op.kind === kind)?.exprs;
  check("a face extrude links its distance", json(by("faceExtrude")) === json({ modelPull: "t" }), json(by("faceExtrude")));
  check("a face move links its distance", json(by("moveFaces")) === json({ "@faces.0.distance": "t / 3" }), json(by("moveFaces")));
  check("a hole links its position and diameter", json(by("hole")) === json({ "@origin.0": "px", "@origin.1": "u - 5", modelHoleR: "(d) / 2" }), json(by("hole")));
  check("a split links its origin", json(by("split")) === json({ "@origin.2": "t" }), json(by("split")));
}
{
  const made = await call("solid_new", { primitive: "box", dx: 40, dy: 40, dz: 10 });
  const plane = await call("workplane_set", { object: made.object, source: "global", origin: [0, 0, "t * 2"], turn: [0, 0, 0] });
  check("workplane_set takes an expression", plane.ok === true && json(plane.origin) === "[0,0,6]", json(plane));
  await call("model_apply", { object: made.object, probe: true, op: { kind: "boolean", op: "cut", primitive: "box", dx: 4, dy: 4, dz: 4, origin: ["u", 0, 0] } });
  const { ops } = await stored(String(made.object));
  check("an op typed on it links to the workplane's expression too", json(ops.at(-1)?.exprs) === json({ modelX: "u", modelZ: "t * 2" }), json(ops.at(-1)?.exprs));
  await call("model_params", { set: { t: 4 } });
  const probed = await call("model_probe", { object: made.object, op: { kind: "boolean", op: "cut", primitive: "box", dx: 4, dy: 4, dz: 4, origin: [0, 0, 0] } });
  check("a parameter set moves the workplane: an op typed on it now lands at 8", json((probed.stored as { origin?: number[] } | undefined)?.origin) === "[0,0,8]", json(probed).slice(0, 400));
  await call("model_params", { set: { t: 3 } });
}

// Item 2: a batch with a `use` keeps every op's links, including those the part made.
await call("model_define", { name: "peg", params: { pr: 2 }, ops: [{ kind: "boolean", op: "fuse", primitive: "cylinder", radius: "pr", height: 4, origin: [0, "h / 2", 20] }] });
{
  const made = await call("solid_new", { primitive: "box", dx: 60, dy: 60, dz: 20 });
  const batch = await call("model_apply_batch", { object: made.object, ops: [
    { kind: "boolean", op: "cut", primitive: "box", dx: "d", dy: 5, dz: 5, origin: [0, 0, 17] },
    { kind: "use", part: "peg", with: { pr: "d / 2" } },
  ] });
  const { ops } = await stored(String(made.object));
  check("a batch with a use applies", batch.ok === true, json(batch));
  check("each op of it keeps its links", json(ops.slice(-2).map((op) => op.exprs)) === json([{ modelDx: "d" }, { modelY: "h / 2", modelRadius: "d / 2" }]), json(ops.slice(-2).map((op) => op.exprs)));
}

// Item 1: model_build links the root and every op.
{
  await call("model_define", { name: "stud", params: { pr: 2 }, ops: [{ kind: "boolean", op: "fuse", primitive: "cylinder", radius: "pr", height: 4, origin: [0, "h / 4", "t"] }] });
  const built = await call("model_build", { base: { primitive: "box", dx: "w", dy: "h", dz: "t" }, ops: [{ kind: "boolean", op: "cut", primitive: "box", dx: 4, dy: 4, dz: 4, origin: ["px", 0, 0] }, { kind: "use", part: "stud", with: { pr: "r / 2" } }] });
  const { ops, root } = await stored(String(built.object));
  check("model_build builds", built.ok === true, json(built));
  check("its root keeps its base's links", json(root) === json({ "@origin.0": "-0.5 * (w)", "@origin.1": "-0.5 * (h)", modelDx: "w", modelDy: "h", modelDz: "t" }), json(root));
  check("and each op its own", json(ops.map((op) => op.exprs)) === json([{ modelX: "px" }, { modelY: "h / 4", modelZ: "t", modelRadius: "r / 2" }]), json(ops.map((op) => op.exprs)));
  // Item 4: call-level params for project names are for the call only; the others stay with the recipe.
  const once = await call("model_build", { base: { primitive: "box", dx: "w", dy: "q", dz: 5 }, params: { w: 20, q: 8 } });
  check("a call-level w is reported as for this call only", json(once.oneOff) === '["w"]' && typeof once.oneOffNote === "string", json(once));
  const onceTree = await stored(String(once.object));
  check("a step built at a call-level value of a project name keeps no link to it", !Object.values(onceTree.root ?? {}).some((text) => /\bw\b/.test(text)), json(onceTree.root));
  const rerun = await call("model_build", { object: once.object });
  // The stand-in engine keeps its box through a root step, so the new base is read from the step the rerun stored.
  const rerunTree = await stored(String(once.object));
  const base = rerunTree.ops.find((op) => op.kind === "root") as unknown as { size?: number[]; exprs?: Record<string, string> } | undefined;
  check("a rerun takes the project's w and the recipe's own q, on a new root", rerun.ok === true && rerun.resumed?.newBase === true && json(base?.size) === "[40,8,5]", json([rerun.resumed, base]));
  check("and the new root links w, not the recipe's q", json(base?.exprs) === json({ "@origin.0": "-0.5 * (w)", modelDx: "w" }), json(base?.exprs));
}

// Item 5: model_params {rebuild} on a part with nothing out of date.
{
  const none = await call("model_params", { set: { unused: 1 }, rebuild: true });
  check("a rebuild that reaches no part says so", none.ok === true && json(none.rebuilt) === "[]" && typeof none.note === "string", json(none));
}

// Item 6: project_create refuses to drop parameters and parts, unless asked.
{
  const refused = await call("project_create", {});
  check("project_create refuses while there are parameters and parts", refused.ok === false && /parameters? \(.*\) and 2 parts \(peg, stud\)/.test(String(refused.reason)) && String(refused.reason).includes("discard: true"), json(refused));
  const kept = await call("model_params", {});
  check("and keeps them", kept.params?.w === 40, json(kept));
  const created = await call("project_create", { discard: true });
  const empty = await call("model_params", {});
  check("discard: true starts empty", created.ok === true && json(empty.params) === "{}", json([created, empty]));
  const blank = await call("project_create", {});
  check("an empty project needs no discard", blank.ok === true, json(blank));
}

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("mcp vars-links: ok");
