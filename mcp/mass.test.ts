/**
 * model_mass over MCP (docs/plan-mass-properties.md) on the fake engine: a box's volume, mass at the filament's density
 * and at a given one, centre and principal moments; a pendulum assembly (a frame, a rod on a level hinge, a bob seated
 * on the rod without a joint) weighed as one body, with its inertia about the hinge, lever arm and compound-pendulum
 * period against the same numbers worked by hand; about {point, axis} in a part's own frame; a vertical axis without a
 * period; and the refusals (no hinge, a bad density, an open mesh). The parts are tree roots, so no kernel call decides
 * any of this.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeEngine } from "./engine.ts";
import { Session } from "./session.ts";
import { validateTool } from "./schema.ts";
import { G_MM_S2 } from "../src/mass.ts";

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-mass-"));
type Reply = Record<string, unknown>;
const s = new Session(fakeEngine());
const call = async (name: string, input: Record<string, unknown> = {}) => (await s.call(name, input)) as Reply;
const show = (value: unknown) => JSON.stringify(value);
const near = (a: unknown, b: number, rel = 1e-5) => typeof a === "number" && Math.abs(a - b) <= rel * Math.max(1, Math.abs(b));
const solid = async (input: Reply) => {
  const made = await call("solid_new", input);
  assert.equal(made.ok, true, show(made));
  return String(made.object);
};

const rho = s.filament().densityGCm3;

// --- One box: volume, the filament's density, centre, principal moments.
const block = await solid({ primitive: "box", dx: 40, dy: 20, dz: 10, name: "block" });
const weighed = await call("model_mass", { object: block });
assert.equal(weighed.ok, true, show(weighed));
const m = (8000 * rho) / 1000;
assert.ok(near(weighed.volumeMm3, 8000), show(weighed));
const mass = weighed.mass as { grams: number; source: string; densityGCm3: number; from: string };
assert.ok(near(mass.grams, m) && mass.source === "solid" && mass.from === "filament" && mass.densityGCm3 === rho, show(mass));
assert.match(String(weighed.note), /solid body/);
assert.match(String(weighed.note), /infill weighs less/);
assert.equal(weighed.frame, "model");
const moments = (weighed.principalInertia as { momentsGmm2: number[] }).momentsGmm2;
assert.ok(near(moments[0], (m * (400 + 100)) / 12) && near(moments[2], (m * (1600 + 400)) / 12), show(moments));
assert.equal(weighed.about, undefined);
assert.equal(weighed.sliced, undefined);
const centre = weighed.centreOfGravityMm as number[];
console.log(`box: ${show({ volume: weighed.volumeMm3, grams: mass.grams, centre })}`);

// A density given: the mass follows it, the reply says where it came from.
const petg = await call("model_mass", { object: block, density: 1.27 });
assert.ok(near((petg.mass as { grams: number }).grams, 8000 * 1.27 / 1000) && (petg.mass as { from: string }).from === "density", show(petg.mass));
assert.match(String(petg.note), /1\.27 g\/cm³ as given/);

// --- A pendulum: a frame, a rod hung on a level hinge at its top, a bob seated on the rod without a joint.
const frame = await solid({ primitive: "box", dx: 60, dy: 20, dz: 10, name: "frame" });
const rod = await solid({ primitive: "box", dx: 4, dy: 4, dz: 200, name: "rod" });
const bob = await solid({ primitive: "box", dx: 30, dy: 10, dz: 30, name: "bob" });
// Each box's own frame: centred in X and Y, its base at z = 0 (as the centre above says).
const base = centre[2]! - 5;
assert.equal((await call("model_place", { object: rod, to: frame, x: 0, y: 30, z: -200 })).ok, true);
assert.equal((await call("model_place", { object: rod, joint: { kind: "hinge", pivot: [0, 0, 200 + base], axis: [1, 0, 0] } })).ok, true);
assert.equal((await call("model_place", { object: bob, to: rod, x: 0, y: 0, z: -30 })).ok, true);

// By hand, about the hinge (the rod's top): the rod's centre is 100 mm below it, the bob's 215 mm.
const mr = (4 * 4 * 200 * rho) / 1000, mb = (30 * 10 * 30 * rho) / 1000, M = mr + mb;
const I = (mr * (16 + 40000)) / 12 + mr * 100 * 100 + (mb * (100 + 900)) / 12 + mb * 215 * 215;
const d = (mr * 100 + mb * 215) / M;
const T = 2 * Math.PI * Math.sqrt(I / (M * G_MM_S2 * d));
for (const asked of [rod, bob]) {
  const hinge = await call("model_mass", { object: asked, about: "hinge" });
  assert.equal(hinge.ok, true, show(hinge));
  assert.equal(hinge.body, rod, `${asked}: the body is the rod`);
  assert.deepEqual((hinge.parts as { object: string }[]).map((row) => row.object), [rod, bob], show(hinge.parts));
  assert.ok(near((hinge.mass as { grams: number }).grams, M), show(hinge.mass));
  const about = hinge.about as { kind: string; inertiaGmm2: number; leverMm: number; pendulum: { periodS: number; lengthMm: number; gravityMmS2: number; offRestDeg: number } };
  assert.equal(about.kind, "hinge");
  assert.ok(near(about.inertiaGmm2, I), show({ about, I }));
  assert.ok(near(about.leverMm, d), show({ about, d }));
  assert.ok(near(about.pendulum.periodS, T), show({ about, T }));
  assert.ok(near(about.pendulum.lengthMm, I / (M * d)), show(about));
  assert.ok(near(about.pendulum.gravityMmS2, G_MM_S2) && about.pendulum.offRestDeg < 0.01, show(about));
  assert.match(String(hinge.note), /along −Z of model space/);
  assert.match(String(hinge.note), /2 parts that move together/);
}
console.log(`pendulum: ${show({ grams: M, inertia: I, lever: d, periodS: T })} from the rod and from the bob`);

// part:true (feedback 3.8): the bob alone, not the body it moves with, and the reply says what was left out.
const bobAlone = await call("model_mass", { object: bob, part: true });
assert.equal(bobAlone.ok, true, show(bobAlone));
assert.equal(bobAlone.part, true);
assert.equal(bobAlone.body, bob);
assert.deepEqual((bobAlone.parts as { object: string }[]).map((row) => row.object), [bob], show(bobAlone.parts));
assert.ok(near((bobAlone.mass as { grams: number }).grams, mb), show(bobAlone.mass));
assert.match(String(bobAlone.note), /part:true: bob alone; the other part that moves with it \(rod\) is left out/);
assert.match(String(bobAlone.basis), /mass\.grams is the solid at .* g\/cm³ \(the filament .*\); no slice was used\./);
const rodBody = await call("model_mass", { object: rod });
assert.match(String(rodBody.note), /part:true weighs rod alone/);
assert.equal(rodBody.part, undefined);
assert.notEqual(validateTool("model_mass", { object: bob, part: "yes" }), null);
assert.equal(validateTool("model_mass", { object: bob, part: true }), null);
console.log(`part:true: the bob alone ${show((bobAlone.mass as { grams: number }).grams)} g of the body's ${show(M)} g`);

// Turned 20° on its hinge, the same period, 20° off rest.
assert.equal((await call("model_place", { object: rod, angle: 20 })).ok, true);
const turned = await call("model_mass", { object: rod, about: "hinge" });
const swung = (turned.about as { pendulum: { periodS: number; offRestDeg: number } }).pendulum;
assert.ok(near(swung.periodS, T) && Math.abs(swung.offRestDeg - 20) < 0.01, show(turned.about));
assert.match(String(turned.note), /turned 20° from rest/);
assert.equal((await call("model_place", { object: rod, angle: 0 })).ok, true);

// The frame is the fixed root: its body is the frame alone (the rod hangs on a hinge), and it has no hinge.
const fixed = await call("model_mass", { object: frame, about: "hinge" });
assert.equal(fixed.ok, false, show(fixed));
assert.match(String(fixed.reason), /fixed root, so there is no hinge/);
const frameMass = await call("model_mass", { object: frame });
assert.deepEqual((frameMass.parts as { object: string }[]).map((row) => row.object), [frame], "a part on its own hinge is not the frame's");

// --- about {point, axis} in a part's own frame: the rod's hinge line typed in the rod's frame gives the same answer.
assert.equal((await call("model_place", { object: rod, frame: "part" })).ok, true);
const line = await call("model_mass", { object: rod, about: { point: [5, 0, 200 + base], axis: [2, 0, 0] } });
assert.equal(line.ok, true, show(line));
assert.equal(line.frame, "part");
assert.ok(Array.isArray(line.centreOfGravityModelMm), "a part frame also gives the centre in model space");
const lineAbout = line.about as { kind: string; inertiaGmm2: number; pendulum: { periodS: number }; pointMm: number[]; axis: number[] };
assert.equal(lineAbout.kind, "axis");
assert.ok(near(lineAbout.inertiaGmm2, I) && near(lineAbout.pendulum.periodS, T), show(lineAbout));
assert.deepEqual([lineAbout.pointMm, lineAbout.axis], [[5, 0, 200 + base], [1, 0, 0]], "the line answers in the frame it was typed in");
assert.ok(near((line.centreOfGravityMm as number[])[2], 200 + base - d), show(line.centreOfGravityMm));

// A vertical axis: inertia and lever, no period, with the sentence.
const spin = await call("model_mass", { object: rod, about: { point: [0, 0, 0], axis: [0, 0, 1] } });
assert.equal(spin.ok, true, show(spin));
assert.match(String((spin.about as { noPeriod?: string }).noPeriod), /vertical/);

// --- Refusals: a bad density and a bad line by the schema, and an open mesh with where it is open.
assert.notEqual(validateTool("model_mass", { object: block, density: 0 }), null);
assert.notEqual(validateTool("model_mass", { object: block, about: "pivot" }), null);
assert.notEqual(validateTool("model_mass", { object: block, about: { point: [0, 0] , axis: [1, 0, 0] } }), null);
assert.equal(validateTool("model_mass", { object: block, about: { point: [0, 0, 0], axis: [1, 0, 0] }, density: 1.04 }), null);
const zeroAxis = await call("model_mass", { object: block, about: { point: [0, 0, 0], axis: [0, 0, 0] } });
assert.equal(zeroAxis.ok, false, show(zeroAxis));
const loose = await call("model_mass", { object: block, about: "hinge" });
assert.equal(loose.ok, false);
assert.match(String(loose.reason), /in no assembly/);
const part = s.find(block)!;
const opened = part.solid!.positions.slice(9);
part.solid = { ...part.solid!, positions: opened };
const open = await call("model_mass", { object: block });
assert.equal(open.ok, false, show(open));
assert.equal(open.code, "open-mesh");
assert.match(String(open.reason), /^block's mesh has \d+ open edges?, the first at \(.*\), so it encloses no volume to weigh\./);
console.log("refusals: no hinge on a root or a free part, a zero axis, the schema's bounds, and an open mesh with where");

// --- Sliced grams: a part sliced alone gets the slice's grams of its own beads, the inertia scaled to them, and the
// same period. The fake slicer lays 100 mm of outer wall.
{
  const alone = new Session(fakeEngine());
  const ask = async (name: string, input: Record<string, unknown> = {}) => (await alone.call(name, input)) as Reply;
  const made = await ask("solid_new", { primitive: "box", dx: 10, dy: 10, dz: 40, name: "arm" });
  const arm = String(made.object);
  const before = await ask("model_mass", { object: arm });
  assert.equal(before.sliced, undefined, "no slice, no sliced grams");
  assert.equal(before.slicedNot, undefined, "no slice, nothing to explain");
  const started = await ask("slice_start", {});
  assert.equal(started.ok, true, show(started));
  const done = await ask("slice_wait", { job: started.job });
  assert.equal(done.ok, true, show(done));
  const line = { point: [0, 0, 40], axis: [0, 1, 0] };
  const after = await ask("model_mass", { object: arm, about: line });
  assert.equal(after.ok, true, show(after));
  const f = alone.filament();
  const grams = (100 * Math.PI * (f.diameterMm / 2) ** 2 * f.densityGCm3) / 1000;
  const sliced = after.sliced as { grams: number; massRatio: number; inertiaGmm2: number; job: string };
  const solidGrams = (after.mass as { grams: number }).grams;
  assert.ok(near(sliced.grams, grams), show({ sliced, grams }));
  assert.ok(near(sliced.massRatio, grams / solidGrams), show(sliced));
  assert.ok(near(sliced.inertiaGmm2, (after.about as { inertiaGmm2: number }).inertiaGmm2 * sliced.massRatio), show(after));
  assert.match(String(after.note), /assumes the printed mass is spread as the solid's is/);
  assert.match(String(after.note), /period and the equivalent length do not change/);
  // The plate changed since: the slice is stale and the reply says so instead.
  assert.equal((await ask("object_place", { object: arm, scalePercent: 150 })).ok, true);
  const stale = await ask("model_mass", { object: arm });
  assert.equal(stale.sliced, undefined, show(stale));
  assert.match(String(stale.slicedNot), /slice again/);
  console.log(`sliced: ${show({ grams: sliced.grams, ratio: sliced.massRatio })}, and stale after a change, with the sentence`);
}

// --- An earlier slice of the part alone is used when the latest slice is the plate's (feedback 3.8).
{
  const two = new Session(fakeEngine());
  const ask = async (name: string, input: Record<string, unknown> = {}) => (await two.call(name, input)) as Reply;
  const first = String((await ask("solid_new", { primitive: "box", dx: 10, dy: 10, dz: 40, name: "arm" })).object);
  const second = String((await ask("solid_new", { primitive: "box", dx: 10, dy: 10, dz: 10, name: "foot" })).object);
  assert.equal((await ask("object_place", { object: second, centreX: 60, centreY: 60 })).ok, true);
  const none = await ask("model_mass", { object: first });
  assert.equal(none.sliced, undefined);
  assert.equal((await ask("object_select", { object: first })).ok, true);
  const one = await ask("slice_start", { scope: "object" });
  assert.equal((await ask("slice_wait", { job: one.job })).ok, true);
  const plate = await ask("slice_start", { scope: "plate" });
  assert.equal((await ask("slice_wait", { job: plate.job })).ok, true);
  assert.notEqual(two.latest?.handle, one.job, "the latest slice is the plate's");
  const found = await ask("model_mass", { object: first });
  const usedJob = (found.sliced as { job?: string } | undefined)?.job;
  assert.equal(usedJob, one.job, show(found));
  assert.match(String(found.note), /an earlier slice of this part alone/);
  assert.match(String(found.basis), new RegExp(`sliced\.grams is from the slice ${String(one.job)} of arm alone`));
  const other = await ask("model_mass", { object: second });
  assert.equal(other.sliced, undefined, show(other));
  assert.match(String(other.slicedNot), /No slice in this session is of foot alone/);
  console.log(`earlier slice: ${String(usedJob)} used for arm while the latest is the plate's; foot says why there is none`);
}

console.log("model_mass: ok");
