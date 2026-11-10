/**
 * Forms that save a round trip, against the stand-in engine: surface_at {rays}, object_remove {objects}, and
 * commit: true on model_apply and model_apply_batch.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fakeEngine } from "./engine.ts";
import { validateTool } from "./schema.ts";
import { Session } from "./session.ts";

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-mcp-batch-forms-"));
process.env.LIME_MCP_BRIDGE = "0";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 500)}` : ""}`);
}
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const session = new Session(fakeEngine());
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Reply = Record<string, any>;
const call = (name: string, args: unknown = {}) => session.call(name, args) as Promise<Reply>;

// surface_at {rays}.
const object = (await call("solid_new", { primitive: "box", dx: 60, dy: 40, dz: 35 })).object as string;
const rays = [{ x: 3, y: 4 }, { point: [-50, 0, 10], direction: [1, 0, 0] }, { x: 500, y: 500 }, { point: [0, 0, 0] }, { x: -10, y: -10 }, { x: 10, y: 10 }];
const singles: Reply[] = [];
for (const ray of rays) singles.push(await call("surface_at", { object, ...ray }));
const many = await call("surface_at", { object, rays });
console.log(`surface_at, ${rays.length} rays: ${bytes(many)} bytes in one reply, ${singles.reduce((sum, row) => sum + bytes(row), 0)} bytes in ${rays.length} replies`);
check("rays answers one row a ray, in order", many.ok === true && many.frame === "model" && Array.isArray(many.hits) && many.hits.length === rays.length, many);
check("each hit is what a single call answers, without ok and frame", many.hits.every((hit: Reply, i: number) => {
  const { ok: _ok, frame: _frame, ...rest } = singles[i]!;
  return singles[i]!.ok === false ? hit.hit === false && hit.reason === singles[i]!.reason : same(hit, rest);
}), { many: many.hits, singles });
check("a ray that misses and one that is not a ray are rows, not a refusal", many.hits[2].hit === false && many.hits[3].hit === false && typeof many.hits[3].reason === "string");
const both = await call("surface_at", { object, rays, x: 1, y: 2 });
check("rays with a single ray's fields is refused", both.ok === false && both.code === "conflicting-arguments", both);
check("one ray answers as it did", singles[0]!.ok === true && singles[0]!.hit === true && singles[0]!.frame === "model" && singles[0]!.hits === undefined);

// object_remove {objects}.
const a = (await call("solid_new", { primitive: "box", dx: 5, dy: 5, dz: 5 })).object as string;
const b = (await call("solid_new", { primitive: "box", dx: 6, dy: 6, dz: 6 })).object as string;
const c = (await call("solid_new", { primitive: "box", dx: 7, dy: 7, dz: 7 })).object as string;
const ids = async () => ((await call("plate_list", {})).objects as { object: string }[]).map((row) => row.object);
const before = await ids();
const unknown = await call("object_remove", { objects: [a, "obj_999", b] });
check("an unknown handle among several removes nothing and is named", unknown.ok === false && unknown.code === "no-object" && String(unknown.reason).includes("obj_999") && same(await ids(), before), unknown);
const removed = await call("object_remove", { objects: [a, b] });
check("objects removes several in one call", removed.ok === true && !removed.objects.includes(a) && !removed.objects.includes(b) && removed.objects.includes(c) && removed.objects.includes(object), removed);
await call("plate_undo");
check("and one undo puts them all back", same((await ids()).sort(), [...before].sort()));
const one = await call("object_remove", { object: c });
check("one object is removed as before", one.ok === true && !one.objects.includes(c));
const neither = await call("object_remove", {});
check("neither object nor objects is refused", neither.ok === false && neither.code === "missing-argument", neither);
check("object and objects together are refused", (await call("object_remove", { object: a, objects: [b] })).ok === false);
check("the schema takes objects", validateTool("object_remove", { objects: [a, b] }) === null && validateTool("object_remove", { objects: [] }) !== null);

// commit: true.
const cut = (x: number) => ({ kind: "boolean", op: "cut", primitive: "box", centre: [x, 0, 34.5], dx: 2, dy: 2, dz: 3 });
const plain = await call("model_apply", { object, op: cut(-20), probe: true });
check("without commit the reply is as it was", plain.ok === true && plain.committed === undefined && plain.commit === undefined);
const history = async () => (await call("model_history", { object })) as Reply;
const uncommitted = await history();
const applied = await call("model_apply", { object, op: cut(-10), probe: true, commit: true });
const separate = await call("model_commit", { object });
check("commit: true on model_apply commits in the same call", applied.ok === true && applied.committed === true && typeof applied.node === "string" && applied.commit && typeof applied.commit.triangles === "number" && applied.commit.ok === undefined, applied);
check("its commit is what model_commit answers", Object.keys(applied.commit).filter((key) => !key.startsWith("tandem")).every((key) => key in separate), { applied: applied.commit, separate });
const committedNow = await history();
check("the history shows the step on the plate", JSON.stringify(committedNow) !== JSON.stringify(uncommitted));
const batch = await call("model_apply_batch", { object, ops: [cut(0), cut(10)], commit: true });
check("commit: true on model_apply_batch commits after the batch", batch.ok === true && batch.committed === true && typeof batch.commit.triangles === "number", batch);
const refused = await call("model_apply", { object, op: { ...cut(0), centre: [500, 0, 0] }, probe: true, commit: true });
check("a refused edit is not committed", refused.ok === false && refused.committed === undefined && refused.commit === undefined, refused);
const planned = await call("plan_run", { steps: [{ tool: "model_apply", args: { object, op: cut(20), probe: true, commit: true } }, { tool: "plate_list", args: {} }] });
check("commit: true works as a plan's step", planned.ok === true && planned.steps[0].result.committed === true, planned);
console.log(`model_apply_batch then model_commit: ${bytes(batch)} bytes in one reply; two calls were ${bytes({ ...batch, committed: undefined, commit: undefined })} + ${bytes(separate)} bytes and one more round trip`);

if (failed > 0) {
  console.error(`${failed} checks failed`);
  process.exit(1);
}
console.log("batch forms: all checks passed");
