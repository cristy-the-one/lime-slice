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
if (process.argv.includes("--escapement")) {
  // docs/plan-hinge-dynamics.md: a Graham escapement from horology's outlines (src/graham.ts; 30 teeth, tip 22.5, root
  // 17.5, lean 12, span 7.5), each part an STL in model space (its own frame), imported and seated on a frame where it
  // stands: the wheel on a hinge about +Y at the origin, the anchor about +Y at the pivot distance above it, a rod and a
  // bob seated on the anchor. The wheel is turned 0.3 degrees on from the rest pose, so no tooth touches.
  const { writeFileSync } = await import("node:fs");
  const { clockMeshes } = await import("../src/escapement-parts.ts");
  const { escapeWheel, graham, restPose } = await import("../src/graham.ts");
  const { box } = await import("../src/box-mesh.ts");
  const g = graham(escapeWheel(30, 22.5, 17.5, 12), 7.5);
  const meshes = clockMeshes(g, (restPose(g) as [number, number])[0] - 0.3);
  if ("reason" in meshes) throw new Error(meshes.reason);
  const d = meshes.pivotDistance;
  const part = async (name: string, positions: Float32Array) => {
    const n = positions.length / 9, bytes = Buffer.alloc(84 + 50 * n);
    bytes.writeUInt32LE(n, 80);
    for (let i = 0; i < n; i += 1) for (let k = 0; k < 9; k += 1) bytes.writeFloatLE(positions[i * 9 + k]!, 84 + 50 * i + 12 + 4 * k);
    const path = join(process.env.LIME_MCP_WORKSPACE!, `${name}.stl`);
    writeFileSync(path, bytes);
    return String((await call("mesh_import", { path })).object);
  };
  const frame = await part("Frame", box(120, 4, 200, [0, -10, 40]));
  const wheel = await part("Escape wheel", meshes.wheel);
  const anchor = await part("Anchor", meshes.anchor);
  const rod = await part("Rod", box(3, 3, 140, [0, 12, d - 70]));
  const bob = await part("Bob", box(30, 6, 30, [0, 12, d - 140]));
  for (const id of [wheel, anchor]) await call("model_place", { object: id, to: frame });
  for (const id of [rod, bob]) await call("model_place", { object: id, to: anchor });
  await call("model_place", { object: wheel, joint: { kind: "hinge", pivot: [0, 0, 0], axis: [0, 1, 0] } });
  await call("model_place", { object: anchor, joint: { kind: "hinge", pivot: [0, 0, d], axis: [0, 1, 0] } });
  const saved = await call("project_save", { name: "pose-escapement.lime" });
  copyFileSync(String(saved.path), out);
  console.log(JSON.stringify({ frame, wheel, anchor, rod, bob }));
  process.exit(0);
}
if (process.argv.includes("--contact")) {
  // docs/plan-contact-poses.md: a frame (z 0 to 4), an arm 20 x 2 x 5 hinged about +z at its near end (the origin), and a
  // stop 2 x 2 x 5 at x 12 to 14, y 5 to 7, both standing at z 6. Turning +z, the arm's face y = 1 first meets the stop's
  // corner (14, 5). The hinge stops at -30 the other way, where nothing is in reach.
  const frame = String((await call("solid_new", { primitive: "box", dx: 60, dy: 60, dz: 4, name: "Frame" })).object);
  const arm = String((await call("solid_new", { primitive: "box", dx: 20, dy: 2, dz: 5, name: "Arm" })).object);
  const stop = String((await call("solid_new", { primitive: "box", dx: 2, dy: 2, dz: 5, name: "Stop" })).object);
  await call("model_place", { object: arm, to: frame, x: 10, y: 0, z: 6 });
  await call("model_place", { object: arm, joint: { kind: "hinge", pivot: [-10, 0, 0], axis: [0, 0, 1], min: -30 } });
  await call("model_place", { object: stop, to: frame, x: 13, y: 6, z: 6 });
  const saved = await call("project_save", { name: "pose-contact.lime" });
  copyFileSync(String(saved.path), out);
  console.log(JSON.stringify({ frame, arm, stop }));
  process.exit(0);
}
if (process.argv.includes("--ratchet")) {
  // docs/plan-coupling-kinds.md, stage 3: a real ratchet wheel and its click, from lime_recipe::horology's outlines
  // (ported in src/ratchet-click.ts): Ratchet::new(20, 12, 10.2) and its click of length 10 (click_size), seated in tooth
  // 0's notch. Each part is a box cut to its outline by an extrude `common`, 3 mm thick, so the kernel builds the teeth
  // and the click as solids. Both stand 6 mm above a frame, the wheel on a hinge about +Z at its centre, the click on a
  // hinge at its pivot. Horology's wheel runs free clockwise seen from +Z: free -1 on that hinge.
  // `--real` builds them with the real kernel (target/release/lime_mcp_engine.dll, loadEngineWorker), so Pose draws the
  // teeth; without it the fake engine stands in boxes. `--coupled` also declares the ratchet with its click (needs the
  // real kernel's solids: the click's hand is read from its box).
  const { clickGeometry, clickOutline, ratchetOutline } = await import("../src/ratchet-click.ts");
  const shape = { teeth: 20, tip: 12, root: 10.2, arm: 10 };
  const loop = (points: [number, number][]) => ({ start: points[0], segments: [...points.slice(1), points[0]].map((to) => ({ kind: "line", to })) });
  const wheelPoints = ratchetOutline(shape), clickPoints = clickOutline(shape);
  if (!clickPoints) throw new Error("horology refuses this click");
  const real = process.argv.includes("--real");
  const sessionNow = real ? new Session((await import("../mcp/engine.ts")).loadEngineWorker(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))) : session;
  const ask = async (name: string, input: Record<string, unknown> = {}) => {
    const reply = (await sessionNow.call(name, input)) as Record<string, unknown>;
    if (reply.ok !== true) throw new Error(`${name}: ${JSON.stringify(reply)}`);
    return reply;
  };
  const cutTo = async (name: string, points: [number, number][]) => {
    const reach = Math.max(...points.flatMap(([x, y]) => [Math.abs(x), Math.abs(y)])) + 2;
    const object = String((await ask("solid_new", { primitive: "box", dx: 2 * reach, dy: 2 * reach, dz: 3, name })).object);
    await ask("model_apply", { object, probe: true, op: { kind: "extrude", op: "common", loops: [loop(points)], origin: [0, 0, -10], depth: 20 } });
    return object;
  };
  const frame = String((await ask("solid_new", { primitive: "box", dx: 80, dy: 80, dz: 4, name: "Frame" })).object);
  const ratchet = await cutTo("Ratchet", wheelPoints);
  const click = await cutTo("Click", clickPoints);
  const { pivot } = clickGeometry(shape);
  await ask("model_place", { object: ratchet, to: frame, x: 0, y: 0, z: 6 });
  await ask("model_place", { object: ratchet, joint: { kind: "hinge", pivot: [0, 0, 0], axis: [0, 0, 1] } });
  await ask("model_place", { object: click, to: frame, x: 0, y: 0, z: 6 });
  await ask("model_place", { object: click, joint: { kind: "hinge", pivot: [pivot[0], pivot[1], 0], axis: [0, 0, 1] } });
  if (process.argv.includes("--coupled")) await ask("model_place", { object: ratchet, couple: { driven: frame, kind: "ratchet", free: -1, click, teeth: shape.teeth, tip: shape.tip, root: shape.root } });
  const saved = await ask("project_save", { name: "pose-ratchet.lime" });
  copyFileSync(String(saved.path), out);
  console.log(JSON.stringify({ frame, ratchet, click, teeth: shape.teeth, tip: shape.tip, root: shape.root, free: -1, liftDeg: clickGeometry(shape).liftDeg }));
  process.exit(0);
}
if (process.argv.includes("--couplings")) {
  // docs/plan-coupling-kinds.md: parts on joints and nothing coupled, for a person to couple in Pose. A frame (the root);
  // a centre arbor and a wheel on hinges (a ratio); a hand on a hinge over the arbor (a clutch); a drum on a hinge with a
  // weight on a slide below it and a cord seated on the weight (a winch); a ratchet wheel of 20 teeth (tip 12, root 10.2)
  // on a hinge and its click on a hinge on the frame, 15 mm out, its body toward the notch the way the wheel runs free.
  const box = async (name: string, dx: number, dy: number, dz: number) => String((await call("solid_new", { primitive: "box", dx, dy, dz, name })).object);
  const frame = await box("Frame", 200, 200, 4);
  const centre = await box("Centre", 6, 6, 30);
  const wheel = await box("Wheel", 30, 30, 3);
  const hand = await box("Hand", 40, 2, 1);
  const drum = await box("Drum", 24, 24, 20);
  const weight = await box("Weight", 20, 20, 30);
  const cord = await box("Cord", 1, 1, 40);
  const ratchet = await box("Ratchet", 24, 24, 3);
  const click = await box("Click", 7, 3, 3);
  const hinge = { kind: "hinge", pivot: [0, 0, 0], axis: [0, 0, 1] };
  await call("model_place", { object: centre, to: frame, x: 0, y: 0, z: 20 });
  await call("model_place", { object: centre, joint: hinge });
  await call("model_place", { object: wheel, to: frame, x: 50, y: 0, z: 10 });
  await call("model_place", { object: wheel, joint: hinge });
  await call("model_place", { object: hand, to: frame, x: 20, y: 0, z: 40 });
  await call("model_place", { object: hand, joint: { kind: "hinge", pivot: [-20, 0, 0], axis: [0, 0, 1] } });
  await call("model_place", { object: drum, to: frame, x: -60, y: 50, z: 30 });
  await call("model_place", { object: drum, joint: hinge });
  await call("model_place", { object: weight, to: frame, x: -48, y: 0, z: 30 });
  await call("model_place", { object: weight, joint: { kind: "slide", pivot: [0, 0, 0], axis: [0, 1, 0], min: -40, max: 40 } });
  await call("model_place", { object: cord, to: weight, x: 0, y: 25, z: 0 });
  await call("model_place", { object: ratchet, to: frame, x: 0, y: -60, z: 40 });
  await call("model_place", { object: ratchet, joint: hinge });
  await call("model_place", { object: click, to: frame, x: -3.5, y: -48.6, z: 40 });
  await call("model_place", { object: click, joint: { kind: "hinge", pivot: [3.5, 3.6, 0], axis: [0, 0, 1] } });
  const saved = await call("project_save", { name: "pose-couplings.lime" });
  copyFileSync(String(saved.path), out);
  console.log(JSON.stringify({ frame, centre, wheel, hand, drum, weight, cord, ratchet, click }));
  process.exit(0);
}
if (process.argv.includes("--compound")) {
  // A free compound train, ten to one: a driver of 16 on a wheel of 40, and a pinion of 12 attached to that wheel (one
  // shaft, no joint) on an output of 48. Module 1, each at its mating phase. Only the pinion is in an assembly.
  const { matePhase } = await import("../src/gear-pair.ts");
  const driver = String((await call("solid_new", { gear: { teeth: 16, module: 1, thickness: 6 }, name: "Driver" })).object);
  const wheel = String((await call("solid_new", { gear: { teeth: 40, module: 1, thickness: 6, phaseDeg: matePhase(0, 16, 0, 40) }, name: "Compound wheel" })).object);
  const pinion = String((await call("solid_new", { gear: { teeth: 12, module: 1, thickness: 6 }, name: "Compound pinion" })).object);
  const output = String((await call("solid_new", { gear: { teeth: 48, module: 1, thickness: 6, phaseDeg: matePhase(0, 12, 0, 48) }, name: "Output" })).object);
  await call("model_place", { object: wheel, x: 28, y: 0, z: 0 });
  await call("model_place", { object: pinion, to: wheel, x: 0, y: 0, z: 8 });
  await call("model_place", { object: output, x: 58, y: 0, z: 8 });
  const saved = await call("project_save", { name: "pose-gears-compound.lime" });
  copyFileSync(String(saved.path), out);
  console.log(JSON.stringify({ driver, wheel, pinion, output }));
  process.exit(0);
}
if (process.argv.includes("--crossed")) {
  // docs/plan-gear-kinds.md, stage 4: two gears of 20 whose axes cross at a right angle, within reach, as a bevel pair.
  const flat = String((await call("solid_new", { gear: { teeth: 20, module: 1, thickness: 6 }, name: "flat" })).object);
  const standing = String((await call("solid_new", { gear: { teeth: 20, module: 1, thickness: 6 }, name: "standing" })).object);
  await call("model_place", { object: standing, x: 12, y: 0, z: 14, turnX: 90 });
  const saved = await call("project_save", { name: "pose-gears-crossed.lime" });
  copyFileSync(String(saved.path), out);
  console.log(JSON.stringify({ flat, standing }));
  process.exit(0);
}
if (process.argv.includes("--rack")) {
  // docs/plan-gear-kinds.md, stage 3: a pinion of 12 over a rack of 40 (module 1), free and at mesh: the pinion's tooth 0
  // points down at the rack over U = 10 PI, and the rack's tooth 0 sits half a pitch on. No joint, no assembly.
  const pinion = String((await call("solid_new", { gear: { teeth: 12, module: 1, thickness: 6, bore: 3, phaseDeg: -90 }, name: "pinion" })).object);
  const rack = String((await call("solid_new", { gear: { teeth: 40, module: 1, thickness: 6, rack: true }, name: "rack" })).object);
  await call("model_place", { object: pinion, x: 10 * Math.PI, y: 6, z: 0 });
  await call("model_place", { object: rack, x: Math.PI / 2, y: 0, z: 0 });
  const saved = await call("project_save", { name: "pose-gears-rack.lime" });
  copyFileSync(String(saved.path), out);
  console.log(JSON.stringify({ pinion, rack }));
  process.exit(0);
}
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
