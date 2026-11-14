/**
 * Gear kinds, stage 3 (docs/plan-gear-kinds.md): rack and pinion. The window's mesh check agrees with the rack's rule; a
 * pinion on a hinge and a rack on a slide along its teeth couple at PI m z / 360 mm a degree, with the sign the geometry
 * gives; either one drives; slide limits stop the train; the mesh check judges sampled frames; the seat survives turns and
 * reads; Couple gears gives a free rack a slide and a free pinion a hinge; a rack on a hinge is refused.
 */
import { readAssemblies, solveAssembly, type Assembly, type Member } from "./assembly.ts";
import { placeGear, rackTravel, worldPair, type WorldGear } from "./gear-pair.ts";
import { couplingLine, findCouplings, prepareTrain, preparedLines, trainCheck, trainTurn, type GearPart } from "./gear-train.ts";
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

const P = Math.PI;
const spec = (teeth: number, phaseDeg: number, rack = false): PrimitiveSpec => ({ primitive: "gear", origin: [0, 0, 0], size: [0, 0, 0], radius: 0, height: 6, turn: [0, 0, 0], teeth, module: 1, phaseDeg, ...(rack ? { rack: true } : {}) });
const at = (x: number, y = 0, z = 0): Affine => ({ m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [x, y, z] });
// A pinion of 12 (module 1) over a rack of 40: the pinion's tooth 0 points down at the rack, so the rack's tooth sits half
// a pitch off under it. The rack's tooth 0 is at U = P / 2; the pinion stands over U = 10 P.
const SPECS: Record<string, { spec: PrimitiveSpec; name: string }> = { pin: { spec: spec(12, -90), name: "Pinion" }, rack: { spec: spec(40, 0, true), name: "Rack" } };
const POSES: Record<string, Affine> = { frame: at(0, -20), pin: at(10 * P, 6), rack: at(P / 2) };
const poseOf = (id: string) => POSES[id];
const gearsAt = (poses: ReadonlyMap<string, Affine>): WorldGear[] => [...poses].flatMap(([id, pose]) => {
  const row = SPECS[id];
  const gear = row ? placeGear(row.spec, pose, id, row.name, null) : null;
  return gear ? [gear] : [];
});
const jointOf = (assembly: Assembly, id: string) => assembly.members.find((row) => row.object === id)?.joint;
const angleOf = (assembly: Assembly, id: string) => { const j = jointOf(assembly, id); return j?.kind === "hinge" ? j.angle ?? 0 : undefined; };
const travelOf = (assembly: Assembly, id: string) => { const j = jointOf(assembly, id); return j?.kind === "slide" ? j.travel ?? 0 : undefined; };
const seat = (object: string, parent: string, pose: Affine, extra: Partial<Member> = {}): Member => ({ object, parent, offset: [pose.t[0] - POSES.frame!.t[0], pose.t[1] - POSES.frame!.t[1], pose.t[2]] as Vec3, turn: [0, 0, 0], ...extra });
const SWEEP = Array.from({ length: 41 }, (_, i) => -100 + i * 5.03);

// --- The window's check: a rack and a pinion at their mating phase mesh; half a pitch off, they do not.
{
  const gears = gearsAt(new Map(Object.entries(POSES)));
  const pin = gears.find((gear) => gear.objectId === "pin")!, rack = gears.find((gear) => gear.objectId === "rack")!;
  check("the rack is a rack", rack.rack === true);
  eq("they mesh", worldPair(pin, rack)?.verdict, "meshing");
  eq("either way round", worldPair(rack, pin)?.verdict, "meshing");
  const off = placeGear(SPECS.rack!.spec, at(P / 2 + P / 2), "rack", "Rack", null)!;
  eq("half a pitch off, tooth on tooth", worldPair(pin, off)?.verdict, "toothOnTooth");
  const far = placeGear(SPECS.pin!.spec, at(10 * P, 7), "pin", "Pinion", null)!;
  eq("1 mm too far, loose", worldPair(far, rack)?.verdict, "loose");
}

// --- On a frame: the pinion on a hinge, the rack on a slide along its teeth.
const hinge = (pivot: Vec3 = [0, 0, 3]) => ({ kind: "hinge" as const, pivot, axis: [0, 0, 1] as Vec3, angle: 0 });
const slide = (axis: Vec3 = [1, 0, 0], extra = {}) => ({ kind: "slide" as const, pivot: [0, 0, 3] as Vec3, axis, travel: 0, ...extra });
function framed(pin: Partial<Member>, rack: Partial<Member>): Assembly {
  return { id: "r", name: "Rack", members: [{ object: "frame", parent: null, offset: [0, 0, 0], turn: [0, 0, 0] }, seat("pin", "frame", POSES.pin!, pin), seat("rack", "frame", POSES.rack!, rack)] };
}
function couple(assembly: Assembly) {
  const poses = solveAssembly(assembly, poseOf).poses;
  const found = findCouplings(assembly, gearsAt(poses), poses);
  return { found, coupled: { ...assembly, couplings: found.couplings } as Assembly };
}
{
  const { found, coupled } = couple(framed({ joint: hinge() }, { joint: slide() }));
  // The pinion turned + (counter-clockwise from above) rolls along the rack toward +X... seen from the pinion's centre
  // above the rack, its lowest point moves +X, so the rack travels +X: PI m z / 360 = PI / 30 mm a degree.
  eq("one coupling at PI z m / 360 mm a degree", found.couplings.map((row) => [row.driver, row.driven, Math.round(row.ratio * 1e9) / 1e9, row.rack]), [["pin", "rack", Math.round((P / 30) * 1e9) / 1e9, "driven"]]);
  eq("nothing refused or locked", [found.notCoupled, found.locked], [[], []]);
  eq("the line says millimetres", couplingLine(found.couplings[0]!), "Pinion drives Rack, ×0.105 mm a degree");
  const turned = trainTurn(coupled, "pin", 30);
  check("pinion 30: the rack travels PI mm", !("reason" in turned) && near(travelOf(turned.assembly, "rack"), rackTravel(30, 12, 1)) && near(rackTravel(30, 12, 1), P), JSON.stringify(!("reason" in turned) && turned.angles));
  if (!("reason" in turned)) {
    eq("the reply names the slide's travel", turned.angles.map((row) => Object.keys(row)), [["object", "angle"], ["object", "travel"]]);
    const poses = solveAssembly(turned.assembly, poseOf).poses;
    check("the rack moved PI along X", near(poses.get("rack")!.t[0], P / 2 + P));
  }
  const fromRack = trainTurn(coupled, "rack", -P / 2);
  check("the rack moved -PI/2 turns the pinion -15", !("reason" in fromRack) && near(angleOf(fromRack.assembly, "pin"), -15));
  const sweep = trainCheck(coupled, poseOf, gearsAt, "pin", SWEEP);
  check("from -100 to +100 degrees the pair meshes everywhere", !("reason" in sweep) && sweep.bad.length === 0, JSON.stringify(sweep).slice(0, 300));
  const wrong = { ...coupled, couplings: coupled.couplings!.map((row) => ({ ...row, ratio: -row.ratio })) };
  const caught = trainCheck(wrong, poseOf, gearsAt, "pin", SWEEP);
  check("the rack sent the wrong way is caught", !("reason" in caught) && caught.bad.some((row) => row.verdict === "toothOnTooth"));
  // The slide's limits stop the train: the rack may go 2 mm.
  const limited = { ...coupled, members: coupled.members.map((row) => (row.object === "rack" ? { ...row, joint: slide([1, 0, 0], { min: -2, max: 2 }) } : row)) };
  const stopped = trainTurn(limited, "pin", 90);
  check("a slide limit holds the pinion short", !("reason" in stopped) && stopped.clamped && near(travelOf(stopped.assembly, "rack"), 2) && near(angleOf(stopped.assembly, "pin"), 2 / (P / 30), 1e-9));
  // The file keeps the slide and the coupling; 200 turns and reads later they still read.
  const objects = Object.entries(POSES).map(([id, modelPose]) => ({ id, modelPose }));
  let worn: Assembly = coupled;
  for (let i = 0; i < 200; i += 1) {
    const step = trainTurn(worn, i % 2 ? "pin" : "rack", i % 2 ? 3.3 * (i % 4 === 1 ? 1 : -1) : 0.7 * (i % 4 === 0 ? 1 : -1));
    if ("reason" in step) throw new Error(step.reason);
    worn = readAssemblies(JSON.parse(JSON.stringify([step.assembly])), objects)[0]!;
  }
  eq("200 turns and reads later the coupling still reads", worn.couplings?.length, 1);
  const wornCheck = trainCheck(worn, poseOf, gearsAt, "pin", [0, 13, -27]);
  check("and still meshes", !("reason" in wornCheck) && wornCheck.bad.length === 0, JSON.stringify(wornCheck));
  const moved = { ...coupled, members: coupled.members.map((row) => (row.object === "rack" ? { ...row, offset: [row.offset[0], row.offset[1] + 1, row.offset[2]] as Vec3 } : row)) };
  eq("a rack moved off its line by hand drops the coupling", readAssemblies(JSON.parse(JSON.stringify([moved])), objects)[0]?.couplings, undefined);
}

// --- Refusals: a rack on a hinge, and a slide across its teeth.
{
  eq("a rack on a hinge is not coupled", couple(framed({ joint: hinge() }, { joint: hinge([0, 0, 3]) })).found.notCoupled.map((row) => row.reason), ["Pinion and Rack are not coupled: Rack turns on a hinge, and a rack is driven only on a slide."]);
  eq("a slide across the teeth is not coupled", couple(framed({ joint: hinge() }, { joint: slide([0, 1, 0]) })).found.notCoupled.map((row) => row.reason), ["Pinion and Rack are not coupled: Rack's slide does not run along its teeth."]);
  const held = couple(framed({ joint: hinge() }, { held: true }));
  eq("a held rack locks its pinion", held.found.locked.map((row) => row.reason), ["Pinion and Rack are locked: Rack cannot turn, and the train meshes with it."]);
}

// --- Couple gears from free parts: the pinion is the root and turns on the plate, the rack gets a slide on it.
{
  const parts: GearPart[] = ["rack", "pin"].map((id) => ({ id, name: SPECS[id]!.name, pose: POSES[id]!, gears: [placeGear(SPECS[id]!.spec, POSES[id]!, id, SPECS[id]!.name, null)!] }));
  const prepared = prepareTrain([], parts, "rack", poseOf, "asm_1");
  eq("the pinion is the root, not the rack", prepared.assembly!.members.map((row) => [row.object, row.parent]), [["pin", null], ["rack", "pin"]]);
  eq("a hinge and a slide", [jointOf(prepared.assembly!, "pin")?.kind, jointOf(prepared.assembly!, "rack")?.kind], ["hinge", "slide"]);
  eq("what it says", preparedLines(prepared, (id) => SPECS[id]?.name ?? id), ["Gave Pinion a hinge about its axis.", "Gave Rack a slide along its teeth.", "They stand in a new assembly, Gear train. Pinion turns on the plate."]);
  const assembly = prepared.assembly!;
  const poses = solveAssembly(assembly, poseOf).poses;
  const found = findCouplings(assembly, gearsAt(poses), poses);
  eq("coupled", found.couplings.length, 1);
  const coupled = { ...assembly, couplings: found.couplings };
  const turned = trainTurn(coupled, "pin", 45);
  if (!("reason" in turned)) {
    const after = solveAssembly(turned.assembly, poseOf).poses;
    check("the root pinion turned in place and the rack slid 1.5 PI along X", near(after.get("pin")!.t[0], 10 * P) && near(after.get("rack")!.t[0], P / 2 + 1.5 * P) && near(after.get("rack")!.t[1], 0) && near(after.get("rack")!.m[0], 1));
  } else check("the root pinion turns", false, turned.reason);
  const sweep = trainCheck(coupled, poseOf, gearsAt, "pin", SWEEP);
  check("and meshes from -100 to +100 degrees", !("reason" in sweep) && sweep.bad.length === 0, JSON.stringify(sweep).slice(0, 300));
}

if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("gear-rack: all passed");
