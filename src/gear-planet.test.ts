/**
 * Gear kinds, stage 2 (docs/plan-gear-kinds.md): a pinion inside a ring turns the same way at +z1/z2, and a planetary
 * stage (sun 12, three planets 12 on a carrier, ring 36) turns by the planetary relation with any one of sun, ring or
 * carrier held. All three free is refused with a sentence; the mesh check judges sampled frames; the carrier coupling
 * survives the file and drops when the carrier is moved; Couple gears' first step finds the carrier and leaves a root ring
 * as the housing.
 */
import { readAssemblies, solveAssembly, type Assembly, type Member } from "./assembly.ts";
import { matePhase, matePhaseInternal, placeGear, type WorldGear } from "./gear-pair.ts";
import { couplingLine, findCouplings, prepareTrain, trainCheck, trainScales, trainTurn, type GearPart } from "./gear-train.ts";
import type { Affine } from "./model-space.ts";
import type { PrimitiveSpec } from "./model-primitive.ts";
import type { Vec3 } from "./model-tree.ts";

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const left = JSON.stringify(got);
  const right = JSON.stringify(want);
  if (left === right) return;
  failed += 1;
  console.error(`FAIL ${name}\n  got  ${left}\n  want ${right}`);
}
function check(name: string, ok: boolean, detail = "") {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}
const near = (a: number | undefined, b: number, tol = 1e-9) => a !== undefined && Math.abs(a - b) <= tol;

const gearSpec = (teeth: number, phaseDeg: number, internal = false): PrimitiveSpec => ({ primitive: "gear", origin: [0, 0, 0], size: [0, 0, 0], radius: 0, height: 6, turn: [0, 0, 0], teeth, module: 1, phaseDeg, ...(internal ? { internal: true } : {}) });
const at = (x: number, y = 0, z = 0): Affine => ({ m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [x, y, z] });
const angleOf = (assembly: Assembly, id: string) => {
  const joint = assembly.members.find((row) => row.object === id)?.joint;
  return joint?.kind === "hinge" ? joint.angle ?? 0 : undefined;
};
const SWEEP = Array.from({ length: 49 }, (_, i) => i * 7.5 + 0.3);

// The stage, module 1: sun 12 at the centre, planets 12 at 12 mm on 0, 120 and 240 degrees, ring 36. (12 + 36) / 3 = 16,
// so one ring phase meets all three planets.
const PLANET_AT = [0, 120, 240].map((deg) => [12 * Math.cos((deg * Math.PI) / 180), 12 * Math.sin((deg * Math.PI) / 180)] as const);
const planetPhase = (i: number) => matePhase(0, 12, [0, 120, 240][i]!, 12);
const RING_PHASE = matePhaseInternal(planetPhase(0), 12, 0, 36);
const SPECS: Record<string, { spec: PrimitiveSpec; name: string }> = {
  sun: { spec: gearSpec(12, 0), name: "Sun" },
  p0: { spec: gearSpec(12, planetPhase(0)), name: "Planet 1" },
  p1: { spec: gearSpec(12, planetPhase(1)), name: "Planet 2" },
  p2: { spec: gearSpec(12, planetPhase(2)), name: "Planet 3" },
  ring: { spec: gearSpec(36, RING_PHASE, true), name: "Ring" },
};
const POSES: Record<string, Affine> = { frame: at(0), sun: at(0), carrier: at(0), ring: at(0), p0: at(...PLANET_AT[0]!), p1: at(...PLANET_AT[1]!), p2: at(...PLANET_AT[2]!) };
const poseOf = (id: string) => POSES[id];
const gearsAt = (poses: ReadonlyMap<string, Affine>): WorldGear[] => [...poses].flatMap(([id, pose]) => {
  const row = SPECS[id];
  const gear = row ? placeGear(row.spec, pose, id, row.name, null) : null;
  return gear ? [gear] : [];
});
const NAMES: Record<string, string> = { frame: "Frame", carrier: "Carrier" };
const nameOf = (id: string) => SPECS[id]?.name ?? NAMES[id] ?? id;
const hinge = (pivot: Vec3 = [0, 0, 3]) => ({ kind: "hinge" as const, pivot, axis: [0, 0, 1] as Vec3, angle: 0 });
const seat = (object: string, parent: string, pose: Affine, extra: Partial<Member> = {}): Member => ({ object, parent, offset: [...pose.t] as Vec3, turn: [0, 0, 0], ...extra });

// --- Every pair of the stage meshes where it stands.
{
  const gears = gearsAt(new Map(Object.entries(POSES)));
  const ring = gears.find((gear) => gear.objectId === "ring")!;
  check("the ring is an internal gear", ring.internal === true);
  for (const id of ["p0", "p1", "p2"]) {
    const planet = gears.find((gear) => gear.objectId === id)!;
    eq(`${id} meshes with the sun`, findCouplings({ id: "x", name: "x", members: [{ object: "frame", parent: null, offset: [0, 0, 0], turn: [0, 0, 0] }, seat("sun", "frame", POSES.sun!, { joint: hinge() }), seat(id, "frame", POSES[id]!, { joint: hinge() })] }, [gears.find((gear) => gear.objectId === "sun")!, planet], new Map([["frame", at(0)], ["sun", at(0)], [id, POSES[id]!]])).couplings.length, 1);
  }
}

// --- A pinion inside a ring on fixed axes: the same way round, at +z1/z2.
{
  const members: Member[] = [{ object: "frame", parent: null, offset: [0, 0, 0], turn: [0, 0, 0] }, seat("p0", "frame", POSES.p0!, { joint: hinge() }), seat("ring", "frame", POSES.ring!, { joint: hinge() })];
  const assembly: Assembly = { id: "i", name: "Inside", members };
  const poses = solveAssembly(assembly, poseOf).poses;
  const found = findCouplings(assembly, gearsAt(poses), poses, nameOf);
  eq("pinion inside ring: one coupling at +12/36", found.couplings.map((row) => [row.driver, row.driven, Math.round(row.ratio * 1e9) / 1e9, row.carrier ?? null]), [["p0", "ring", 0.333333333, null]]);
  const coupled = { ...assembly, couplings: found.couplings };
  const turned = trainTurn(coupled, "p0", 30);
  check("the ring turns +10 for the pinion's +30", !("reason" in turned) && near(angleOf(turned.assembly, "ring"), 10));
  const sweep = trainCheck(coupled, poseOf, gearsAt, "p0", SWEEP);
  check("and meshes at every sampled turn", !("reason" in sweep) && sweep.bad.length === 0, JSON.stringify(sweep));
  const wrong = { ...coupled, couplings: coupled.couplings.map((row) => ({ ...row, ratio: -row.ratio })) };
  const caught = trainCheck(wrong, poseOf, gearsAt, "p0", SWEEP);
  check("turned against each other, the teeth cross", !("reason" in caught) && caught.bad.some((row) => row.verdict === "toothOnTooth"));
}

// --- The planetary stage on a frame, the ring held: the sun drives the carrier at zs / (zs + zr) = 1/4.
function stage(ring: Partial<Member>, sun: Partial<Member>): Assembly {
  return {
    id: "p", name: "Planetary", members: [
      { object: "frame", parent: null, offset: [0, 0, 0], turn: [0, 0, 0] },
      seat("sun", "frame", POSES.sun!, sun),
      seat("ring", "frame", POSES.ring!, ring),
      seat("carrier", "frame", POSES.carrier!, { joint: hinge() }),
      ...["p0", "p1", "p2"].map((id) => seat(id, "carrier", POSES[id]!, { joint: hinge() })),
    ],
  };
}
function coupleStage(assembly: Assembly) {
  const poses = solveAssembly(assembly, poseOf).poses;
  const found = findCouplings(assembly, gearsAt(poses), poses, nameOf);
  return { found, coupled: { ...assembly, couplings: found.couplings } as Assembly };
}
{
  const { found, coupled } = coupleStage(stage({ held: true }, { joint: hinge() }));
  eq("six meshes, each through the carrier", found.couplings.map((row) => [row.gears[0].name, row.gears[1].name, row.carrier?.body]), [["Sun", "Planet 1", "carrier"], ["Sun", "Planet 2", "carrier"], ["Sun", "Planet 3", "carrier"], ["Planet 1", "Ring", "carrier"], ["Planet 2", "Ring", "carrier"], ["Planet 3", "Ring", "carrier"]]);
  eq("nothing refused or locked", [found.notCoupled, found.locked], [[], []]);
  eq("a line reads through the carrier", couplingLine(found.couplings[0]!), "Sun drives Planet 1 on Carrier, ×−1");
  const scales = trainScales(coupled, "sun");
  check("carrier 1/4 of the sun, each planet -3/4 on it", !scales.locked && near(scales.scales.get("carrier"), 0.25) && ["p0", "p1", "p2"].every((id) => near(scales.scales.get(id), -0.75)) && !scales.scales.has("frame"), JSON.stringify([...scales.scales]));
  const turned = trainTurn(coupled, "sun", 40);
  check("sun 40: carrier 10, planets -30", !("reason" in turned) && near(angleOf(turned.assembly, "carrier"), 10) && near(angleOf(turned.assembly, "p1"), -30), JSON.stringify(!("reason" in turned) && turned.angles));
  if (!("reason" in turned)) {
    // The planets orbit with the carrier: planet 1 stands 10 degrees round from where it was, still 12 mm out.
    const poses = solveAssembly(turned.assembly, poseOf).poses;
    const p = poses.get("p0")!.t;
    check("planet 1 orbited 10 degrees", near(Math.hypot(p[0], p[1]), 12, 1e-9) && near((Math.atan2(p[1], p[0]) * 180) / Math.PI, 10, 1e-9), JSON.stringify(p));
  }
  for (const start of ["sun", "carrier", "p1"]) {
    const sweep = trainCheck(coupled, poseOf, gearsAt, start, SWEEP);
    check(`from ${start}: every pair meshes at every sampled turn`, !("reason" in sweep) && sweep.pairs === 6 && sweep.bad.length === 0, JSON.stringify(sweep).slice(0, 400));
  }
  // The validator is a real judge: the carrier term taken off (a fixed-axis train), the planets leave their mesh.
  const noCarrier: Assembly = { ...coupled, couplings: coupled.couplings!.map(({ carrier: _c, ...row }) => row) };
  const bad = trainCheck(noCarrier, poseOf, gearsAt, "sun", SWEEP);
  check("without the carrier term the train is wrong", "reason" in bad || bad.bad.length > 0);
  const back = trainTurn(coupled, "carrier", 10);
  check("the carrier turned 10 drives the sun to 40", !("reason" in back) && near(angleOf(back.assembly, "sun"), 40));
  // The file keeps the carrier; moving the carrier's pin by hand drops its couplings.
  const objects = Object.entries(POSES).map(([id, modelPose]) => ({ id, modelPose }));
  const read = readAssemblies(JSON.parse(JSON.stringify([coupled])), objects)[0]!;
  eq("the couplings round-trip, carrier included", read.couplings, coupled.couplings);
  const moved = { ...coupled, members: coupled.members.map((row) => (row.object === "carrier" && row.joint?.kind === "hinge" ? { ...row, joint: { ...row.joint, pivot: [1, 0, 3] as Vec3 } } : row)) };
  eq("a carrier whose pin moved drops every coupling through it", readAssemblies(JSON.parse(JSON.stringify([moved])), objects)[0]?.couplings, undefined);
  let worn = coupled;
  for (let i = 0; i < 120; i += 1) {
    const step = trainTurn(worn, ["sun", "carrier", "p2"][i % 3]!, 3.7 * (i % 2 ? -1 : 1.4));
    if ("reason" in step) throw new Error(step.reason);
    worn = step.assembly;
  }
  eq("120 turns later the couplings still read", readAssemblies(JSON.parse(JSON.stringify([worn])), objects)[0]?.couplings?.length, 6);
  const wornCheck = trainCheck(worn, poseOf, gearsAt, "sun", SWEEP);
  check("and the stage still meshes everywhere", !("reason" in wornCheck) && wornCheck.bad.length === 0, JSON.stringify(wornCheck).slice(0, 300));
}

// --- The sun held: the carrier drives the ring at (zs + zr) / zr = 4/3. The carrier held: a star, the ring at -1/3.
{
  const { found, coupled } = coupleStage(stage({ joint: hinge() }, { held: true }));
  eq("sun held: nothing locked", found.locked, []);
  const turned = trainTurn(coupled, "carrier", 30);
  check("carrier 30: ring 40", !("reason" in turned) && near(angleOf(turned.assembly, "ring"), 40), JSON.stringify(!("reason" in turned) && turned.angles));
  const sweep = trainCheck(coupled, poseOf, gearsAt, "carrier", SWEEP);
  check("and meshes at every sampled turn", !("reason" in sweep) && sweep.bad.length === 0, JSON.stringify(sweep).slice(0, 300));
  const star = stage({ joint: hinge() }, { joint: hinge() });
  const fixedCarrier: Assembly = { ...star, members: star.members.map((row) => (row.object === "carrier" ? { ...row, joint: undefined, held: true as const } : row)).map(({ joint, ...row }) => (joint ? { ...row, joint } : row)) };
  const held = coupleStage(fixedCarrier);
  eq("carrier held: plain fixed-axis meshes, no carrier term", held.found.couplings.map((row) => row.carrier ?? null), [null, null, null, null, null, null]);
  const starTurn = trainTurn(held.coupled, "sun", 30);
  check("sun 30: planets -30, ring -10", !("reason" in starTurn) && near(angleOf(starTurn.assembly, "p0"), -30) && near(angleOf(starTurn.assembly, "ring"), -10), JSON.stringify(!("reason" in starTurn) && starTurn.angles));
  // Nothing held: sun, ring and carrier turn more than one way.
  const free = coupleStage(stage({ joint: hinge() }, { joint: hinge() }));
  eq("all three free is refused with a sentence", free.found.locked.map((row) => row.reason), ["Sun, Planet 1, Planet 2, Planet 3, Ring and Carrier turn more than one way: hold the sun, the ring or the carrier (Joint: Held), and the others follow."]);
  check("and a turn moves nothing", "reason" in trainTurn(free.coupled, "sun", 5));
}

// --- Couple gears' first step: the ring is the root (the housing), the carrier and the sun sit on it, the planets on the
// carrier, nothing jointed. It finds the carrier, hinges the sun, the planets and the carrier, and leaves the ring fixed.
{
  const parts: GearPart[] = Object.keys(SPECS).map((id) => ({ id, name: nameOf(id), pose: POSES[id]!, gears: [placeGear(SPECS[id]!.spec, POSES[id]!, id, nameOf(id), null)!] }));
  const plain: Assembly = { id: "asm_1", name: "Ring", members: [
    { object: "ring", parent: null, offset: [0, 0, 0], turn: [0, 0, 0] },
    seat("carrier", "ring", POSES.carrier!), seat("sun", "ring", POSES.sun!),
    ...["p0", "p1", "p2"].map((id) => seat(id, "carrier", POSES[id]!)),
  ] };
  const prepared = prepareTrain([plain], parts, "sun", poseOf, "asm_2");
  eq("the carrier, the sun and the planets get hinges; the ring stays", prepared.hinged, ["carrier", "sun", "p0", "p1", "p2"]);
  const assembly = prepared.assembly!;
  eq("the ring root has no joint", assembly.members[0]!.joint, undefined);
  eq("the planets stay on the carrier", ["p0", "p1", "p2"].map((id) => assembly.members.find((row) => row.object === id)?.parent), ["carrier", "carrier", "carrier"]);
  const poses = solveAssembly(assembly, poseOf).poses;
  const found = findCouplings(assembly, gearsAt(poses), poses, nameOf);
  eq("six meshes through the carrier, nothing locked", [found.couplings.filter((row) => row.carrier?.body === "carrier").length, found.locked], [6, []]);
  const coupled = { ...assembly, couplings: found.couplings };
  const turned = trainTurn(coupled, "sun", 40);
  check("the sun turns the carrier by a quarter", !("reason" in turned) && near(angleOf(turned.assembly, "carrier"), 10));
  const sweep = trainCheck(coupled, poseOf, gearsAt, "sun", SWEEP);
  check("and the stage meshes at every sampled turn", !("reason" in sweep) && sweep.bad.length === 0, JSON.stringify(sweep).slice(0, 300));
}

if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("gear-planet: all passed");
