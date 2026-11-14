/**
 * Writes the project `e2e/pose-gears.spec.ts` opens: a frame, a 12-tooth pinion and a 24-tooth wheel at their centre
 * distance with the mating phase, an 18-tooth third gear on from the wheel, and a compound stage (a 12-tooth gear seated
 * on the wheel without a joint, one shaft, driving a 24-tooth "out"). Each hinged gear turns about its own axis; nothing
 * is coupled yet. Built by the MCP session on the fake
 * engine, so the gears are Model tree roots exactly as the app saves them. Run with Node:
 * `node --experimental-strip-types --no-warnings e2e/gear-train-project.ts <out.lime>`.
 *
 * With `--free` (docs/plan-gear-kinds.md, stage 1): the pinion, the wheel and the third gear only, each placed at mesh
 * in model space and nothing else: no frame, no hinge, no assembly. What a person has after making three gears in Model
 * and putting them where the gear card says they mesh.
 */
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeEngine } from "../mcp/engine.ts";
import { Session } from "../mcp/session.ts";

const out = process.argv[2];
const free = process.argv.includes("--free");
if (!out) throw new Error("Give the .lime path to write.");
process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-pose-gears-"));
const session = new Session(fakeEngine());
const call = async (name: string, input: Record<string, unknown> = {}) => {
  const reply = (await session.call(name, input)) as Record<string, unknown>;
  if (reply.ok !== true) throw new Error(`${name}: ${JSON.stringify(reply)}`);
  return reply;
};
if (process.argv.includes("--planetary")) {
  // docs/plan-gear-kinds.md, stage 2: a ring of 36 (module 1) as the assembly's root, the housing; a sun of 12 and a
  // carrier attached to it; three planets of 12 attached to the carrier, 12 mm out on 0, 120 and 240 degrees. Each at its
  // mating phase, and no joint anywhere: Attach is all a person did.
  const { matePhase, matePhaseInternal } = await import("../src/gear-pair.ts");
  const planetPhase = (deg: number) => matePhase(0, 12, deg, 12);
  const ring = String((await call("solid_new", { gear: { teeth: 36, module: 1, thickness: 6, internal: true, phaseDeg: matePhaseInternal(planetPhase(0), 12, 0, 36) }, name: "ring" })).object);
  const sun = String((await call("solid_new", { gear: { teeth: 12, module: 1, thickness: 6 }, name: "sun" })).object);
  const carrier = String((await call("solid_new", { primitive: "cylinder", radius: 15, height: 2, name: "carrier" })).object);
  await call("model_place", { object: sun, to: ring, x: 0, y: 0, z: 0 });
  await call("model_place", { object: carrier, to: ring, x: 0, y: 0, z: 6 });
  const planets: string[] = [];
  for (const [i, deg] of [0, 120, 240].entries()) {
    const planet = String((await call("solid_new", { gear: { teeth: 12, module: 1, thickness: 6, phaseDeg: planetPhase(deg) }, name: `planet ${i + 1}` })).object);
    await call("model_place", { object: planet, to: carrier, x: 12 * Math.cos((deg * Math.PI) / 180), y: 12 * Math.sin((deg * Math.PI) / 180), z: -6 });
    planets.push(planet);
  }
  const saved = await call("project_save", { name: "pose-gears-planetary.lime" });
  copyFileSync(String(saved.path), out);
  console.log(JSON.stringify({ ring, sun, carrier, planets }));
  process.exit(0);
}
if (free) {
  const pinion = String((await call("solid_new", { gear: { teeth: 12, module: 2, thickness: 6, bore: 5 }, name: "pinion" })).object);
  const wheel = String((await call("solid_new", { gear: { teeth: 24, module: 2, thickness: 6, bore: 5, phaseDeg: 172.5 }, name: "wheel" })).object);
  const third = String((await call("solid_new", { gear: { teeth: 18, module: 2, thickness: 6, bore: 5, phaseDeg: 180 }, name: "third" })).object);
  for (const [object, x] of [[wheel, 36], [third, 78]] as const) await call("model_place", { object, x, y: 0, z: 0 });
  if (session.assemblies.length) throw new Error("free gears must stand in no assembly");
  const saved = await call("project_save", { name: "pose-gears-free.lime" });
  copyFileSync(String(saved.path), out);
  console.log(JSON.stringify({ pinion, wheel, third }));
  process.exit(0);
}
const frame = String((await call("solid_new", { primitive: "box", dx: 90, dy: 50, dz: 4, name: "frame" })).object);
const pinion = String((await call("solid_new", { gear: { teeth: 12, module: 2, thickness: 6, bore: 5 }, name: "pinion" })).object);
const wheel = String((await call("solid_new", { gear: { teeth: 24, module: 2, thickness: 6, bore: 5, phaseDeg: 172.5 }, name: "wheel" })).object);
// A third gear on from the wheel: mate_phase(172.5, 24, 0, 18) = 180, at 24 + 18 = 42 mm from it.
const third = String((await call("solid_new", { gear: { teeth: 18, module: 2, thickness: 6, bore: 5, phaseDeg: 180 }, name: "third" })).object);
// A compound stage: a small gear seated on the wheel without a joint (one shaft), above the first plane, driving "out".
const small = String((await call("solid_new", { gear: { teeth: 12, module: 2, thickness: 6, bore: 5 }, name: "small" })).object);
const outGear = String((await call("solid_new", { gear: { teeth: 24, module: 2, thickness: 6, bore: 5, phaseDeg: 172.5 }, name: "out" })).object);
const hinge = { kind: "hinge", pivot: [0, 0, 0], axis: [0, 0, 1] };
for (const [object, x, z] of [[pinion, 0, 4], [wheel, 36, 4], [third, 78, 4], [outGear, 72, 14]] as const) {
  await call("model_place", { object, to: frame, x, y: 0, z });
  await call("model_place", { object, joint: hinge });
}
await call("model_place", { object: small, to: wheel, x: 0, y: 0, z: 10 });
const saved = await call("project_save", { name: "pose-gears.lime" });
copyFileSync(String(saved.path), out);
console.log(JSON.stringify({ frame, pinion, wheel, third, small, out: outGear }));
process.exit(0);
