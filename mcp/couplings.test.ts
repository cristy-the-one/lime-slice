/**
 * Declared couplings over MCP (docs/plan-coupling-kinds.md), on the fake engine: model_place {couple} with a ratio, a
 * winch, a ratchet with its click, and a clutch; turns through model_place {angle} and {travel}; gears:"list"; remove;
 * one plate_undo; project_save and project_open; and the refusals. The parts are boxes and no kernel call decides
 * anything here: a declared coupling is joint arithmetic, and the click's lift is worked out from horology's ratchet.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeEngine } from "./engine.ts";
import { Session } from "./session.ts";
import { validateTool } from "./schema.ts";
import { clickAngle } from "../src/gear-train.ts";

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-couplings-"));
type Reply = Record<string, unknown>;
const s = new Session(fakeEngine());
const call = async (name: string, input: Record<string, unknown> = {}) => (await s.call(name, input)) as Reply;
const show = (value: unknown) => JSON.stringify(value);
const ok = async (name: string, input: Record<string, unknown>) => {
  const reply = await call(name, input);
  assert.equal(reply.ok, true, `${name} ${show(input)}: ${show(reply)}`);
  return reply;
};
const box = async (name: string, dx: number, dy: number, dz: number) => String((await ok("solid_new", { primitive: "box", dx, dy, dz, name })).object);
const near = (a: number | undefined, b: number, tol = 1e-9) => a !== undefined && Math.abs(a - b) <= tol;
const jointOf = (id: string) => s.assemblies.flatMap((row) => row.members).find((row) => row.object === id)?.joint;
const at = (id: string) => { const joint = jointOf(id); return joint?.kind === "hinge" ? joint.angle ?? 0 : joint?.kind === "slide" ? joint.travel ?? 0 : undefined; };

assert.equal(validateTool("model_place", { object: "obj_1", couple: { driven: "obj_2", kind: "winch", radius: 12 } }), null);
assert.notEqual(validateTool("model_place", { object: "obj_1", couple: { driven: "obj_2", kind: "spring" } }), null, "an unknown kind is refused by the schema");
assert.notEqual(validateTool("model_place", { object: "obj_1", couple: { kind: "ratio", ratio: 2 } }), null, "driven is required");

// A frame, two arbors on hinges, a drum, a weight on a slide below it with a cord seated on the weight.
const frame = await box("Frame", 200, 200, 4);
const arbor = await box("Arbor", 4, 4, 30);
const wheel = await box("Wheel", 30, 30, 3);
const drum = await box("Drum", 24, 24, 20);
const weight = await box("Weight", 20, 20, 30);
const cord = await box("Cord", 1, 1, 40);
const hinge = { kind: "hinge", pivot: [0, 0, 0], axis: [0, 0, 1] };
await ok("model_place", { object: arbor, to: frame, x: 0, y: 0, z: 20 });
await ok("model_place", { object: arbor, joint: hinge });
await ok("model_place", { object: wheel, to: frame, x: 50, y: 0, z: 10 });
await ok("model_place", { object: wheel, joint: hinge });
await ok("model_place", { object: drum, to: frame, x: -50, y: 50, z: 30 });
await ok("model_place", { object: drum, joint: hinge });
await ok("model_place", { object: weight, to: frame, x: -38, y: 0, z: 30 });
await ok("model_place", { object: weight, joint: { kind: "slide", pivot: [0, 0, 0], axis: [0, 1, 0], min: -40, max: 40 } });
await ok("model_place", { object: cord, to: weight, x: 0, y: 25, z: 0 });

// ---- Stage 1: a ratio, hinge to hinge. ----
const mixed = await call("model_place", { object: arbor, couple: { driven: wheel, ratio: 3 }, angle: 5 });
assert.equal(mixed.ok, false, "couple is given on its own");
const declared = await ok("model_place", { object: arbor, couple: { driven: wheel, ratio: 3 } });
assert.deepEqual(declared.coupling, { driver: arbor, driven: wheel, kind: "ratio", names: ["Arbor", "Wheel"], ratio: 3 }, show(declared));
assert.equal(String(declared.note).startsWith("Arbor drives Wheel, ×3."), true, show(declared));
const turned = await ok("model_place", { object: arbor, angle: 10 });
assert.ok(near(at(wheel), 30), `the wheel follows at 3: ${at(wheel)}`);
assert.ok((turned.angles as { object: string }[]).some((row) => row.object === wheel), "the reply names the wheel");
await ok("model_place", { object: wheel, angle: -15 });
assert.ok(near(at(arbor), -5), `the wheel turned back turns the arbor: ${at(arbor)}`);
const listed = await ok("model_place", { object: wheel, gears: "list" });
assert.deepEqual((listed.couplings as Reply[]).map((row) => row.kind), ["ratio"], "gears:list lists a declared coupling");
const uncoupled = await ok("model_place", { object: wheel, gears: "uncouple" });
assert.equal((uncoupled.couplings as Reply[]).length, 1, "Uncouple drops gear couplings only: the declared one stays");
console.log("ratio: arbor drives wheel at 3, both ways; Uncouple leaves it");

// ---- Stage 2: winch. ----
const winch = await ok("model_place", { object: drum, couple: { driven: weight, kind: "winch", radius: 12 } });
const mmPerDeg = (2 * Math.PI * 12) / 360;
assert.ok(near((winch.coupling as { ratio: number }).ratio, Math.round(mmPerDeg * 1e6) / 1e6), show(winch));
const cordBefore = s.find(cord)!.modelPose.t[1];
await ok("model_place", { object: drum, angle: 90 });
assert.ok(near(at(weight), 90 * mmPerDeg), `a quarter turn draws the weight up pi r / 2: ${at(weight)}`);
assert.ok(near(s.find(cord)!.modelPose.t[1] - cordBefore, 90 * mmPerDeg), "the cord moves with the weight");
const limited = await ok("model_place", { object: drum, angle: 720 });
assert.ok(near(at(weight), 40) && near(at(drum), 40 / mmPerDeg), `the slide's limit stops the drum: ${at(weight)} ${at(drum)} ${show(limited)}`);
await ok("model_place", { object: weight, travel: 0 });
assert.ok(near(at(drum), 0, 1e-9), `the weight pulled back to 0 turns the drum back: ${at(drum)}`);
const across = await call("model_place", { object: drum, couple: { driven: weight, kind: "winch" } });
assert.equal(across.ok, false, "a winch needs a radius");
console.log("winch: 2 pi r / 360 mm a degree, the cord with the weight, the slide's limit stops the drum");

// ---- Stage 3: ratchet and click on the frame. A ratchet of 20 teeth (tip 12, root 10.2) on its own arbor; the click
// hinged 15 mm out on the frame, its body toward the notch the way the wheel runs free (forward). ----
const ratchet = await box("Ratchet", 24, 24, 3);
const click = await box("Click", 7, 3, 3);
await ok("model_place", { object: ratchet, to: frame, x: 0, y: -60, z: 40 });
await ok("model_place", { object: ratchet, joint: hinge });
await ok("model_place", { object: click, to: frame, x: -3.5, y: -60 + 11.4, z: 40 });
await ok("model_place", { object: click, joint: { kind: "hinge", pivot: [3.5, 3.6, 0], axis: [0, 0, 1] } });
const wrongHand = await call("model_place", { object: ratchet, couple: { driven: frame, kind: "ratchet", free: -1, click, teeth: 20, tip: 12, root: 10.2 } });
assert.equal(wrongHand.ok, false, show(wrongHand));
assert.match(String(wrongHand.reason ?? wrongHand.error ?? show(wrongHand)), /points the wrong way for Ratchet to run free turning back/);
const pawl = await ok("model_place", { object: ratchet, couple: { driven: frame, kind: "ratchet", free: 1, click, teeth: 20, tip: 12, root: 10.2 } });
const row = pawl.coupling as { click: { liftDeg: number; armMm: number } };
assert.ok(row.click.liftDeg < 0 && Math.abs(row.click.liftDeg) > 5, show(pawl));
const blocked = await call("model_place", { object: ratchet, angle: -3 });
assert.equal(blocked.ok, false, "seated, the wheel cannot turn back");
assert.match(show(blocked), /Ratchet turns only forward: its click on Frame holds it the other way/);
await ok("model_place", { object: ratchet, angle: 9 });
const stored = s.assemblies[0]!.couplings!.find((one) => one.kind === "ratchet")!;
assert.ok(near(at(click), clickAngle(stored.click!, 9)) && Math.abs(at(click)!) > 1, `half a pitch lifts the click: ${at(click)}`);
await ok("model_place", { object: ratchet, angle: 0 });
assert.ok(near(at(ratchet), 0) && near(at(click), 0, 1e-9), `back down the tooth to its seat: ${at(ratchet)} ${at(click)}`);
await ok("model_place", { object: ratchet, angle: 22.5 });
const stopped = await ok("model_place", { object: ratchet, angle: 10 });
assert.ok(near(at(ratchet), 18, 1e-9) && near(at(click), 0, 1e-9), `turned back past its seat it stops on the click: ${at(ratchet)}`);
assert.match(String(stopped.stopped), /turns only forward/);
const clickTurn = await call("model_place", { object: click, angle: 4 });
assert.equal(clickTurn.ok, false, "a click moves only with its ratchet");
console.log("ratchet: forward only, the click rides up a tooth and drops; turned back it stops on its seat");

// ---- Stage 4: clutch. The arbor drives a hand through a clutch; setting the hand leaves the arbor and its wheel. ----
const hand = await box("Hand", 40, 2, 1);
await ok("model_place", { object: hand, to: frame, x: 0, y: 0, z: 40 });
await ok("model_place", { object: hand, joint: { kind: "hinge", pivot: [-20, 0, 0], axis: [0, 0, 1] } });
const clutch = await ok("model_place", { object: arbor, couple: { driven: hand, kind: "clutch" } });
assert.equal((clutch.coupling as { ratio: number }).ratio, 1, show(clutch));
assert.match(String(clutch.note), /No torque is computed/);
await ok("model_place", { object: arbor, angle: 20 });
assert.ok(near(at(hand), 25) && near(at(wheel), 60), `the arbor carries the hand: ${at(hand)} ${at(wheel)}`);
const set = await ok("model_place", { object: hand, angle: 100 });
assert.ok(near(at(hand), 100) && near(at(arbor), 20) && near(at(wheel), 60), "setting the hand leaves the train");
assert.deepEqual(set.slipped, ["Arbor stays: the clutch slips when Hand is turned on its own."], show(set));
console.log("clutch: the arbor carries the hand; the hand set by itself slips");

// Remove, undo, save and reopen.
const before = structuredClone(s.assemblies);
const removed = await ok("model_place", { object: arbor, couple: { driven: hand, remove: true } });
assert.deepEqual(removed.removed, [arbor, hand]);
assert.equal((removed.couplings as Reply[]).some((one) => one.kind === "clutch"), false);
await ok("plate_undo", {});
assert.deepEqual(s.assemblies, before, "one plate_undo brings the clutch back");
const again = await call("model_place", { object: arbor, couple: { driven: drum, remove: true } });
assert.equal(again.ok, false, "nothing to remove is refused");
const saved = await ok("project_save", { name: "couplings.lime" });
const reopened = new Session(fakeEngine());
assert.equal(((await reopened.call("project_open", { path: String(saved.path) })) as Reply).ok, true);
const read = (await reopened.call("model_place", { object: arbor, gears: "list" })) as Reply;
assert.deepEqual((read.couplings as Reply[]).map((one) => one.kind), ["ratio", "winch", "ratchet", "clutch"], show(read));
assert.deepEqual(reopened.assemblies[0]!.couplings, s.assemblies[0]!.couplings, "every declared coupling round-trips, the click's phase included");
console.log("remove, one undo, save and reopen: every declared coupling kept");

// Refusals.
const outside = await box("Loose", 5, 5, 5);
assert.equal((await call("model_place", { object: arbor, couple: { driven: outside } })).ok, false, "a part outside the assembly");
assert.equal((await call("model_place", { object: arbor, couple: { driven: wheel, ratio: 0 } })).ok, false, "a zero ratio");
assert.equal((await call("model_place", { object: arbor, couple: { driven: frame, ratio: 2 } })).ok, false, "a part that cannot move");
const stray = await call("model_place", { object: arbor, couple: { driven: wheel, kind: "clutch", radius: 3 } });
assert.equal(stray.reason, "A clutch coupling takes no radius: it takes ratio.", show(stray));
console.log("refusals ok");
process.exit(0);
