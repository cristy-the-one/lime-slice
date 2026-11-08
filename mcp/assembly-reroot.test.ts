/**
 * model_place {object, root:true}: a member becomes its assembly's fixed root where everything stands. The links up to
 * the old root turn round and carry their joints, so every pose is kept, a reversed hinge turns the same pair of parts
 * the same way, and IK anchors at the new root.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeEngine } from "./engine.ts";
import { Session } from "./session.ts";
import { validateTool } from "./schema.ts";
import { memberPose, rootOf, rotationQuaternion, solveAssembly, type Assembly } from "../src/assembly.ts";
import { relativePose, type Affine } from "../src/model-space.ts";

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-reroot-"));
const s = new Session(fakeEngine());
const call = async (name: string, input: Record<string, unknown> = {}) => {
  const reply = await s.call(name, input);
  return reply as Record<string, unknown> & { ok: boolean };
};
const make = async () => String((await call("solid_new", { primitive: "box", dx: 4, dy: 2, dz: 2 })).object);

// base -> a -> b -> c, with d on a off the path. Turned offsets, so no frame lines up with another.
const base = await make(), a = await make(), b = await make(), c = await make(), d = await make();
assert.equal((await call("model_params", { set: { w: 6 } })).ok, true);
assert.equal((await call("model_place", { object: a, to: base, x: 20, y: 5, turnZ: 30, assembly: "Arm" })).ok, true);
assert.equal((await call("model_place", { object: b, to: a, x: 18, turnY: -15, turnZ: 20 })).ok, true);
assert.equal((await call("model_place", { object: c, to: b, x: 16, z: 3, turnX: 40 })).ok, true);
assert.equal((await call("model_place", { object: d, to: a, x: "w", y: 4 })).ok, true);
assert.equal((await call("model_place", { object: a, joint: { kind: "hinge", pivot: [0, 0, 0], axis: [0, 0, 1], min: -90, max: 90 } })).ok, true);
assert.equal((await call("model_place", { object: b, joint: { kind: "hinge", pivot: [1, 0, 1], axis: [1, 1, 0], min: -60, max: 60 } })).ok, true);
assert.equal((await call("model_place", { object: c, joint: { kind: "ball", pivot: [0, 0, 0], cone: 45 } })).ok, true);
assert.equal((await call("model_place", { object: a, angle: 25 })).ok, true);
assert.equal((await call("model_place", { object: b, angle: -40 })).ok, true);

const pose = (id: string): Affine => s.find(id)!.modelPose;
const ids = [base, a, b, c, d];
const close = (x: Affine, y: Affine, tol = 1e-7) => x.m.every((v, i) => Math.abs(v - y.m[i]!) <= tol) && x.t.every((v, i) => Math.abs(v - y.t[i]!) <= tol);
const arm = (): Assembly => s.assemblies.find((row) => row.name === "Arm")!;
const parentOf = (id: string) => arm().members.find((row) => row.object === id)!.parent;

// What turning a's hinge 15 degrees further does to a in base's frame, before any re-root.
const layout = s.objects.map((o) => JSON.stringify(o.offset ?? null));
assert.equal((await call("model_place", { object: a, angle: 40 })).ok, true);
const turnedBefore = relativePose(pose(base), pose(a));
assert.equal((await call("plate_undo")).ok, true);

const posesBefore = new Map(ids.map((id) => [id, structuredClone(pose(id))]));
const assemblyBefore = structuredClone(arm());
const baseFrameBefore = s.find(base)!.frame;

// --- Refusals and the schema.
assert.notEqual(validateTool("model_place", { object: c, root: false }), null, "root takes only true");
assert.equal(validateTool("model_place", { object: c, root: true }), null);
assert.equal((await call("model_place", { object: c, root: true, x: 1 })).ok, false, "root:true is its own call");
assert.equal((await call("model_place", { objects: [c], to: base, root: true })).ok, false);
const loose = await make();
const outside = await call("model_place", { object: loose, root: true });
assert.equal(outside.ok, false, "a part in no assembly has no root to become");
assert.deepEqual(arm(), assemblyBefore, "a refusal changes nothing");

// --- Re-root at the claw end.
const reply = await call("model_place", { object: c, root: true });
assert.equal(reply.ok, true, JSON.stringify(reply));
assert.equal(reply.root, c);
assert.equal(reply.previousRoot, base);
assert.equal(rootOf(arm())!.object, c, "c is the root");
assert.equal(s.find(base)!.frame, "part", "the old root reads its numbers in its part frame, as a member does");
assert.deepEqual([parentOf(b), parentOf(a), parentOf(base), parentOf(d)], [c, b, a, a], "the path turns round; d keeps its link");
for (const id of ids) assert.ok(close(pose(id), posesBefore.get(id)!), `${id} stays where it was`);
const solved = solveAssembly(arm(), (id) => s.find(id)?.modelPose, s.params).poses;
for (const id of ids) assert.ok(close(solved.get(id)!, posesBefore.get(id)!, 1e-6), `${id} solves to where it stands from the new root`);
assert.deepEqual(s.objects.map((o) => JSON.stringify(o.offset ?? null)).slice(0, layout.length), layout, "the print layout does not move");

// Joints moved one link up the old chain; the new root has none.
const joint = (id: string) => arm().members.find((row) => row.object === id)!.joint;
assert.equal(joint(c), undefined);
assert.equal(joint(b)?.kind, "ball", "c's ball now turns b");
assert.equal(joint(a)?.kind, "hinge", "b's hinge now turns a");
assert.equal(joint(base)?.kind, "hinge", "a's hinge now turns base");
const baseHinge = joint(base)!;
assert.ok(baseHinge.kind === "hinge" && baseHinge.angle === 25 && baseHinge.min === -90 && baseHinge.max === 90, "a hinge keeps its angle and limits");
const ball = joint(b)!;
assert.ok(ball.kind === "ball" && ball.cone === 45 && ball.rest, "the ball keeps its cone and has a rest");
const restNow = rotationQuaternion(memberPose(arm().members.find((row) => row.object === b)!).m);
const sameRotation = ball.kind === "ball" && Math.abs(Math.abs(restNow.reduce((sum, v, i) => sum + v * ball.rest![i]!, 0)) - 1) < 1e-9;
assert.ok(sameRotation, "a ball made at this pose has the reversed pose as its rest");
// Expressions: d's link is kept with its text, the reversed links are plain numbers.
assert.deepEqual(arm().members.find((row) => row.object === d)!.exprs?.offset?.[0], "w");
assert.equal(arm().members.find((row) => row.object === base)!.exprs, undefined);

// The reversed hinge turns the same pair the same way: 15 degrees further gives a the same place in base's frame.
assert.equal((await call("model_place", { object: base, angle: 40 })).ok, true);
assert.ok(close(relativePose(pose(base), pose(a)), turnedBefore, 1e-6), "the reversed hinge matches the original turn");
for (const id of [a, b, c, d]) assert.ok(close(pose(id), posesBefore.get(id)!), `${id} holds still while base turns`);
assert.equal((await call("plate_undo")).ok, true);

// IK now anchors at the new root.
const reach = await call("model_place", { object: base, reach: { at: [2, 0, 0], to: [pose(c).t[0] + 10, pose(c).t[1] + 25, pose(c).t[2]] } });
assert.equal(reach.ok, true, JSON.stringify(reach));
assert.equal(reach.anchor, c, "the reach stops at the new root");
assert.ok(close(pose(c), posesBefore.get(c)!), "the new root does not move");
assert.equal((await call("plate_undo")).ok, true);

// Already the root: nothing to do, no undo step.
const again = await call("model_place", { object: c, root: true, compact: true });
assert.equal(again.ok, true);
assert.equal(again.previousRoot, c);

// One undo restores the old tree and root.
assert.equal((await call("plate_undo")).ok, true);
assert.equal(rootOf(arm())!.object, base, "undo gives the old root back");
assert.equal(s.find(base)!.frame, baseFrameBefore, "undo gives the old root its frame back");
assert.deepEqual(arm(), assemblyBefore);
for (const id of ids) assert.ok(close(pose(id), posesBefore.get(id)!), `${id} is unchanged after undo`);

// Back to base as the root through the same call, and every pose still holds.
await call("plate_redo");
assert.equal((await call("model_place", { object: base, root: true })).ok, true);
assert.equal(rootOf(arm())!.object, base);
for (const id of ids) assert.ok(close(pose(id), posesBefore.get(id)!), `${id} holds through two re-roots`);
const back = arm().members.find((row) => row.object === a)!.joint!;
assert.ok(back.kind === "hinge" && Math.abs(back.axis[2] - 1) < 1e-9 && Math.hypot(back.pivot[0], back.pivot[1], back.pivot[2]) < 1e-9, "two re-roots give a its own hinge back");

console.log("MCP assembly re-root: poses kept, joints carried, IK anchor, undo and refusals ok");
