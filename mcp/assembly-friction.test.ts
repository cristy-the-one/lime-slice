/**
 * Wave 8 lane A, on the stand-in engine: redefining a hinge keeps its zero (model_place {joint:{zero}}), and
 * object_duplicate carries a part's assembly seat, joint and recipe, and links copies to a rebuild.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeEngine } from "./engine.ts";
import { Session } from "./session.ts";
import { validateTool } from "./schema.ts";

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-friction-"));
const s = new Session(fakeEngine());
const call = (name: string, input: Record<string, unknown> = {}) => s.call(name, input);
const make = async () => String((await call("solid_new", { primitive: "box", dx: 2, dy: 2, dz: 2 })).object);
const root = await make(), arm = await make();
assert.equal((await call("model_place", { object: arm, to: root, x: 10 })).ok, true);
const hinge = { kind: "hinge", pivot: [0, 0, 0], axis: [0, 0, 1], min: -90, max: 90 };
assert.equal((await call("model_place", { object: arm, joint: hinge })).ok, true);
const member = (id: string) => s.assemblies[0]!.members.find((row) => row.object === id)!;
const angle = (id: string) => (member(id).joint as { angle?: number }).angle ?? 0;
const pos = (id: string) => s.find(id)!.modelPose.t;
assert.equal(validateTool("model_place", { object: arm, joint: { ...hinge, zero: "keep" } }), null);

// Turn to 40 degrees, then change only the limits: the zero stays, the pose stays, the angle is still 40.
assert.equal((await call("model_place", { object: arm, angle: 40 })).ok, true);
const posed = [...pos(arm)];
const limits = await call("model_place", { object: arm, joint: { min: -120, max: 120 } });
assert.equal(limits.ok, true, JSON.stringify(limits));
assert.equal(angle(arm), 40, "the angle is still measured from the old zero");
assert.deepEqual(pos(arm).map((v) => Math.round(v * 1e6)), posed.map((v) => Math.round(v * 1e6)), "the part did not move");
assert.deepEqual((member(arm).joint as { min?: number }).min, -120);
// The feedback's case: limits and angle:0 in the same call turn the part back to the kept zero.
const back = await call("model_place", { object: arm, joint: { ...hinge, min: -100, max: 100 }, angle: 0 });
assert.equal(back.ok, true, JSON.stringify(back));
assert.equal(angle(arm), 0);
assert.ok(Math.abs(pos(arm)[0]! - 10) < 1e-6 && Math.abs(pos(arm)[1]!) < 1e-6, "angle 0 is the original zero, not the pose it was turned to");
// New limits that exclude the pose are refused unless the call's angle brings it back in.
assert.equal((await call("model_place", { object: arm, angle: 60 })).ok, true);
const tight = await call("model_place", { object: arm, joint: { min: -30, max: 30 } });
assert.equal(tight.ok, false);
assert.equal(angle(arm), 60, "a refusal changes nothing");
const within = await call("model_place", { object: arm, joint: { min: -30, max: 30 }, angle: 20 });
assert.equal(within.ok, true, JSON.stringify(within));
assert.equal(angle(arm), 20);
// zero: "here" makes the present pose the zero; a new axis cannot keep one.
const here = await call("model_place", { object: arm, joint: { min: -30, max: 30, zero: "here" } });
assert.equal(here.ok, true);
assert.equal(angle(arm), 0);
const turnedAxis = await call("model_place", { object: arm, joint: { ...hinge, axis: [0, 1, 0], zero: "keep" } });
assert.equal(turnedAxis.ok, false);
const newAxis = await call("model_place", { object: arm, joint: { ...hinge, axis: [0, 1, 0] } });
assert.equal(newAxis.ok, true, "without zero, a moved axis takes the present pose as zero");
assert.equal(angle(arm), 0);
// A part with no joint yet takes "here"; keep has nothing to keep.
const other = await make();
assert.equal((await call("model_place", { object: other, to: root, x: -10 })).ok, true);
assert.equal((await call("model_place", { object: other, joint: { ...hinge, zero: "keep" } })).ok, false);
assert.equal((await call("model_place", { object: other, joint: hinge })).ok, true);

// A duplicate joins the original's assembly on the same parent, with the same joint at the same angle.
assert.equal((await call("model_place", { object: arm, joint: hinge, angle: 25 })).ok, true);
const dup = await call("object_duplicate", { object: arm });
assert.equal(dup.ok, true, JSON.stringify(dup));
const copy = (dup.objects as string[])[0]!;
assert.equal(member(copy).parent, root);
assert.deepEqual(member(copy).joint, member(arm).joint);
assert.deepEqual(member(copy).offset, member(arm).offset);
assert.equal(angle(copy), 25);
assert.ok(String(dup.note).includes("joined"));
assert.equal((await call("model_place", { object: copy, angle: 50 })).ok, true);
assert.equal(angle(arm), 25, "turning the copy leaves the original");
// A root has no seat to copy; its copy stands alone.
const rootCopy = await call("object_duplicate", { object: root });
assert.equal(rootCopy.ok, true);
assert.equal(s.assemblies[0]!.members.some((row) => row.object === (rootCopy.objects as string[])[0]), false);
// Linked is recorded and survives a project round trip.
const linked = await call("object_duplicate", { object: arm, linked: true });
assert.equal(linked.ok, true);
const link = (linked.objects as string[])[0]!;
assert.equal(s.find(link)!.linkedTo, arm);
assert.equal(s.find(copy)!.linkedTo, undefined);
assert.equal(validateTool("object_duplicate", { object: arm, linked: true }), null);
assert.equal((await call("project_save", { name: "friction.lime" })).ok, true);
const reopened = await call("project_open", { path: "friction.lime" });
assert.equal(reopened.ok, true, JSON.stringify(reopened));
assert.equal(s.find(link)?.linkedTo, arm, "the link survives a save and reopen");
assert.equal(s.find(copy)?.linkedTo, undefined);
assert.equal(angle(copy), 50);
console.log("assembly-friction: ok");
