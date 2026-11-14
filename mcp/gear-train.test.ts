/**
 * Gear trains over MCP (docs/plan-gear-coupling.md): a pinion and a wheel placed at their centre distance with the
 * mating phase on one frame, each on a hinge about its axis. model_place {gears:"couple"} couples them from the mesh
 * check, a turn of the pinion turns the wheel by -z1/z2, model_check still calls the pair meshing at every sampled
 * angle, gears:"list" reads the coupling back, a pair that does not mesh is not coupled and says why, a fixed gear
 * locks its train, and the couplings survive project_save and project_open. The gears are tree roots, so the fake
 * engine is enough: no kernel call decides any of this.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeEngine } from "./engine.ts";
import { Session } from "./session.ts";
import { validateTool } from "./schema.ts";

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-gear-train-"));
type Reply = Record<string, unknown>;
const s = new Session(fakeEngine());
const call = async (name: string, input: Record<string, unknown> = {}) => (await s.call(name, input)) as Reply;
const show = (value: unknown) => JSON.stringify(value);

// mate_phase(0, 12, 0, 24) = 180 - 0.5 * 360 / 24 = 172.5: the wheel's tooth 0 meets the pinion's gap along +X.
const WHEEL_PHASE = 172.5;
const solid = async (input: Reply) => {
  const made = await call("solid_new", input);
  assert.equal(made.ok, true, show(made));
  return String(made.object);
};
const frame = await solid({ primitive: "box", dx: 90, dy: 50, dz: 4 });
const pinion = await solid({ gear: { teeth: 12, module: 2, thickness: 6, bore: 5 }, name: "pinion" });
const wheel = await solid({ gear: { teeth: 24, module: 2, thickness: 6, bore: 5, phaseDeg: WHEEL_PHASE }, name: "wheel" });
for (const [object, x] of [[pinion, 0], [wheel, 36]] as const) {
  const placed = await call("model_place", { object, to: frame, x, y: 0, z: 4 });
  assert.equal(placed.ok, true, show(placed));
  const hinged = await call("model_place", { object, joint: { kind: "hinge", pivot: [0, 0, 0], axis: [0, 0, 1] } });
  assert.equal(hinged.ok, true, show(hinged));
}

assert.equal(validateTool("model_place", { object: pinion, gears: "couple" }), null);
assert.notEqual(validateTool("model_place", { object: pinion, gears: "mesh" }), null);
const refusedMix = await call("model_place", { object: pinion, gears: "couple", angle: 5 });
assert.equal(refusedMix.ok, false, "gears is given on its own");

const coupled = await call("model_place", { object: pinion, gears: "couple" });
assert.equal(coupled.ok, true, show(coupled));
type Row = { driver: string; driven: string; gears: string[]; ratio: number };
const rows = coupled.couplings as Row[];
assert.deepEqual(rows.map((row) => [row.driver, row.driven, row.ratio]), [[pinion, wheel, -0.5]], show(coupled));
assert.equal(coupled.notCoupled, undefined, show(coupled));
assert.equal(coupled.locked, undefined, show(coupled));
const checked = coupled.checked as { frames: number; pairs: number; bad: unknown[] };
assert.deepEqual([checked.frames, checked.pairs, checked.bad], [24, 1, []], "the validator turned the train 24 times and every frame meshed");
console.log("couple: one coupling at -0.5, the validator's 24 sampled frames all meshing");

const listed = await call("model_place", { object: wheel, gears: "list" });
assert.deepEqual(listed.couplings, coupled.couplings, "gears:list reads the coupling back from either gear");

// Turn the pinion: the wheel turns -z1/z2 of it, and the mesh check still calls the pair meshing at each angle.
const angleOf = (id: string) => {
  const joint = s.assemblies[0]!.members.find((row) => row.object === id)?.joint;
  return joint?.kind === "hinge" ? joint.angle ?? 0 : NaN;
};
type GearRow = { a: string; b: string; verdict: string };
for (const angle of [7, 30, 55, 100, 233]) {
  const turned = await call("model_place", { object: pinion, angle, reply: "angles" });
  assert.equal(turned.ok, true, show(turned));
  assert.ok(Math.abs(angleOf(wheel) + angle / 2) < 1e-9, `pinion ${angle}: wheel at ${angleOf(wheel)}`);
  assert.ok((turned.angles as { object: string }[]).some((row) => row.object === wheel), "the reply names the wheel's hinge");
  const check = await call("model_check", { object: wheel });
  const row = (check.gears as GearRow[] | undefined)?.find((one) => [one.a, one.b].includes(pinion));
  assert.equal(row?.verdict, "meshing", `pinion ${angle}: ${show(row)}`);
}
console.log("turn: the wheel follows at -0.5 and model_check says meshing at 7, 30, 55, 100 and 233 degrees");

// Turning the wheel drives the pinion back; Undo restores both.
const before = structuredClone(s.assemblies);
assert.equal((await call("model_place", { object: wheel, angle: 0 })).ok, true);
assert.ok(Math.abs(angleOf(pinion)) < 1e-9, `the wheel back to 0 brings the pinion to 0: ${angleOf(pinion)}`);
assert.equal((await call("plate_undo")).ok, true);
assert.deepEqual(s.assemblies, before, "one Undo restores the whole train");

// The project keeps the coupling; an older reader would see an assembly without it.
const saved = await call("project_save", { name: "train.lime" });
assert.equal(saved.ok, true, show(saved));
const reopened = new Session(fakeEngine());
assert.equal(((await reopened.call("project_open", { path: String(saved.path) })) as Reply).ok, true);
const again = (await reopened.call("model_place", { object: pinion, gears: "list" })) as Reply;
assert.deepEqual(again.couplings, coupled.couplings, "the coupling round-trips through the project");
console.log("save: the coupling is kept with the project");

// A third gear seated on the frame, at the mating phase along -X: mate_phase(0, 12, 180, 24) = 352.5. 1 mm too far
// first: not coupled, with the reason.
assert.equal((await call("model_place", { object: pinion, angle: 0 })).ok, true);
const far = await solid({ gear: { teeth: 24, module: 2, thickness: 6, phaseDeg: 352.5 }, name: "far" });
assert.equal((await call("model_place", { object: far, to: frame, x: -37, y: 0, z: 4 })).ok, true);
const recoupled = await call("model_place", { object: frame, gears: "couple" });
const notCoupled = recoupled.notCoupled as { gears: string[]; reason: string }[];
assert.deepEqual(notCoupled, [{ gears: ["pinion", "far"], reason: "pinion and far are not coupled: they are too far apart (centres 37 mm apart, they mesh at 36 mm)." }], show(recoupled));
assert.equal((recoupled.couplings as Row[]).length, 1, "the meshing pair is still coupled");
console.log(`not meshing: ${notCoupled[0]!.reason}`);

// At its centre distance the frame's gear meshes, but it is fixed: the train locks, and a turn moves nothing.
assert.equal((await call("model_place", { object: far, to: frame, x: -36, y: 0, z: 4 })).ok, true);
const lockedReply = await call("model_place", { object: pinion, gears: "couple" });
const locked = lockedReply.locked as { gears: string[]; reason: string }[];
assert.deepEqual(locked, [{ gears: ["pinion", "wheel", "far"], reason: "pinion, wheel and far are locked: far cannot turn, and the train meshes with it." }], show(lockedReply));
const refused = await call("model_place", { object: wheel, angle: 10 });
assert.equal(refused.ok, false, "a locked train refuses the turn");
assert.equal(String(refused.reason), locked[0]!.reason);
assert.deepEqual([angleOf(pinion), angleOf(wheel)], [0, 0], "and nothing moved");
console.log(`locked: ${locked[0]!.reason}`);

const dropped = await call("model_place", { object: pinion, gears: "uncouple" });
assert.deepEqual(dropped.couplings, [], show(dropped));
console.log("MCP gear train: couple, turn, check, list, save, refusals and uncouple ok");
