/**
 * Gear kinds, stage 1 (docs/plan-gear-kinds.md): a train without hand-made hinges or a frame. Couple gears' first step
 * (`prepareTrain`) puts free gears in an assembly and gives each gear that needs one a hinge about its own axis; a hinged
 * root turns on the plate and keeps the parts hinged on it on their pins; the mesh check judges sampled frames; the seat
 * survives turns and reads; a compound gear rides its shaft; a held gear locks its train; an older app's view.
 */
import { readAssemblies, rootOf, solveAssembly, turnsOnPlate, withRootAt, type Assembly, type Member } from "./assembly.ts";
import { placeGear, type WorldGear } from "./gear-pair.ts";
import { findCouplings, prepareTrain, preparedLines, trainCheck, trainTurn, type GearPart } from "./gear-train.ts";
import { applyPose, type Affine } from "./model-space.ts";
import type { PrimitiveSpec } from "./model-primitive.ts";
import type { Vec3 } from "./model-tree.ts";
import { sampleAnimation } from "./pose-anim.ts";

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
const near = (a: number | undefined, b: number, tol = 1e-6) => a !== undefined && Math.abs(a - b) <= tol;
const nearVec = (a: readonly number[] | undefined, b: readonly number[], tol = 1e-6) => !!a && a.every((v, i) => Math.abs(v - b[i]!) <= tol);

function matePhase(ownPhase: number, ownZ: number, dir: number, mateZ: number): number {
  const ownPitch = 360 / ownZ;
  const f = ((((dir - ownPhase) / ownPitch) % 1) + 1) % 1;
  return dir + 180 - (0.5 - f) * (360 / mateZ);
}
function gearSpec(teeth: number, phaseDeg = 0, module = 2): PrimitiveSpec {
  return { primitive: "gear", origin: [0, 0, 0], size: [0, 0, 0], radius: 0, height: 6, turn: [0, 0, 0], teeth, module, phaseDeg };
}
const at = (x: number, y = 0, z = 0): Affine => ({ m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [x, y, z] });
const angleOf = (assembly: Assembly, id: string) => {
  const joint = assembly.members.find((row) => row.object === id)?.joint;
  return joint?.kind === "hinge" ? joint.angle ?? 0 : undefined;
};

const WHEEL_PHASE = matePhase(0, 12, 0, 24);
const THIRD_PHASE = matePhase(WHEEL_PHASE, 24, 0, 18);
const SPECS: Record<string, { spec: PrimitiveSpec; name: string }> = {
  pin: { spec: gearSpec(12), name: "Pinion" },
  wheel: { spec: gearSpec(24, WHEEL_PHASE), name: "Wheel" },
  third: { spec: gearSpec(18, THIRD_PHASE), name: "Third" },
  small: { spec: gearSpec(12), name: "Small" },
  out: { spec: gearSpec(24, WHEEL_PHASE), name: "Out" },
  lone: { spec: gearSpec(20), name: "Lone" },
};

/** A plate: object ids at model poses. `parts` are the gear parts in plate order; `gearsAt` places them at solved poses. */
function plate(poses: Record<string, Affine>) {
  const live = new Map(Object.entries(poses));
  const poseOf = (id: string) => live.get(id);
  const parts = (): GearPart[] => [...live].flatMap(([id, pose]) => {
    const row = SPECS[id];
    const gear = row ? placeGear(row.spec, pose, id, row.name, null) : null;
    return gear ? [{ id, name: row!.name, pose, gears: [gear] }] : [];
  });
  const gearsAt = (solved: ReadonlyMap<string, Affine>): WorldGear[] => [...solved].flatMap(([id, pose]) => {
    const row = SPECS[id];
    const gear = row ? placeGear(row.spec, pose, id, row.name, null) : null;
    return gear ? [gear] : [];
  });
  /** Every member's model pose written back, as the app and the MCP session do after a solve. */
  const write = (assembly: Assembly) => { for (const [id, pose] of solveAssembly(assembly, poseOf).poses) live.set(id, pose); };
  return { live, poseOf, parts, gearsAt, write };
}
const nameOf = (id: string) => SPECS[id]?.name ?? id;
const SWEEP = Array.from({ length: 73 }, (_, i) => i * 5);

// --- Three free gears at mesh, no hinges, no frame, no assembly: Couple gears makes the train.
{
  const p = plate({ pin: at(0), wheel: at(36), third: at(78), lone: at(0, 80) });
  const prepared = prepareTrain([], p.parts(), "pin", p.poseOf, "asm_1");
  const assembly = prepared.assembly!;
  check("a new assembly was made", prepared.made && !!assembly);
  eq("the pinion is its root, the others sit on it, the lone gear stays free", assembly.members.map((row) => [row.object, row.parent]), [["pin", null], ["wheel", "pin"], ["third", "pin"]]);
  eq("each gear got a hinge", prepared.hinged, ["pin", "wheel", "third"]);
  eq("joined", prepared.joined, ["pin", "wheel", "third"]);
  eq("about its own axis, through its centre", assembly.members.map((row) => row.joint), [0, 1, 2].map(() => ({ kind: "hinge", pivot: [0, 0, 3], axis: [0, 0, 1], angle: 0 })));
  check("the root turns on the plate", turnsOnPlate(rootOf(assembly)));
  eq("what it says", preparedLines(prepared, nameOf), ["Gave Pinion, Wheel and Third a hinge about their axes.", "They stand in a new assembly, Gear train. Pinion turns on the plate."]);
  const poses = solveAssembly(assembly, p.poseOf).poses;
  eq("nothing moved", [...poses].map(([id, pose]) => [id, pose.t]), [["pin", [0, 0, 0]], ["wheel", [36, 0, 0]], ["third", [78, 0, 0]]]);
  const found = findCouplings(assembly, p.gearsAt(poses), poses);
  eq("two couplings, at the ratios", found.couplings.map((row) => [row.driver, row.driven, row.ratio]), [["pin", "wheel", -0.5], ["wheel", "third", -24 / 18]]);
  eq("nothing refused or locked", [found.notCoupled, found.locked], [[], []]);
  const coupled: Assembly = { ...assembly, couplings: found.couplings };

  // Turning the root turns the train, and the gears hinged on it stay on their pins.
  const turned = trainTurn(coupled, "pin", 30);
  check("turning the root is not refused", !("reason" in turned), JSON.stringify(turned));
  if (!("reason" in turned)) {
    check("pinion 30, wheel -15, third +20", near(angleOf(turned.assembly, "pin"), 30) && near(angleOf(turned.assembly, "wheel"), -15) && near(angleOf(turned.assembly, "third"), 20));
    const after = solveAssembly(turned.assembly, p.poseOf).poses;
    check("the wheel's centre did not move", nearVec(applyPose(after.get("wheel")!, [0, 0, 3]), [36, 0, 3]));
    check("the third's centre did not move", nearVec(applyPose(after.get("third")!, [0, 0, 3]), [78, 0, 3]));
    check("the pinion turned in place", nearVec(after.get("pin")!.t, [0, 0, 0]) && near(Math.atan2(after.get("pin")!.m[3], after.get("pin")!.m[0]) * 180 / Math.PI, 30));
    check("the wheel turned -15 about its own centre", near(Math.atan2(after.get("wheel")!.m[3], after.get("wheel")!.m[0]) * 180 / Math.PI, -15));
  }
  // Turning a member turns the root with it.
  const fromWheel = trainTurn(coupled, "wheel", 10);
  check("turning the wheel turns the root pinion -20", !("reason" in fromWheel) && near(angleOf(fromWheel.assembly, "pin"), -20) && near(angleOf(fromWheel.assembly, "third"), -40 / 3));
  for (const start of ["pin", "wheel", "third"]) {
    const sweep = trainCheck(coupled, p.poseOf, p.gearsAt, start, SWEEP);
    check(`a whole turn from ${start}, sampled every 5°, stays meshing`, !("reason" in sweep) && sweep.pairs === 2 && sweep.bad.length === 0, JSON.stringify(sweep));
  }
  const wrong: Assembly = { ...coupled, couplings: coupled.couplings!.map((row) => ({ ...row, ratio: -row.ratio })) };
  const caught = trainCheck(wrong, p.poseOf, p.gearsAt, "pin", SWEEP);
  check("the validator still catches a wrong ratio", !("reason" in caught) && caught.bad.some((row) => row.verdict === "toothOnTooth"));

  // The seat: turns of the root and of the members, each written to the plate and read again, keep every coupling.
  let worn: Assembly = coupled;
  for (let i = 0; i < 300; i += 1) {
    const step = trainTurn(worn, ["pin", "wheel", "third"][i % 3]!, 7.37 * (i % 2 ? -1 : 1.3));
    if ("reason" in step) throw new Error(step.reason);
    p.write(step.assembly);
    worn = readAssemblies(JSON.parse(JSON.stringify([step.assembly])), [...p.live].map(([id, modelPose]) => ({ id, modelPose })))[0]!;
  }
  eq("300 turns and reads later the couplings still read", worn.couplings?.length, 2);
  const wornCheck = trainCheck(worn, p.poseOf, p.gearsAt, "pin", SWEEP);
  check("and the train still meshes everywhere", !("reason" in wornCheck) && wornCheck.bad.length === 0, JSON.stringify(wornCheck));
  check("the gears are still on their pins", nearVec(applyPose(p.live.get("wheel")!, [0, 0, 3]), [36, 0, 3], 1e-6) && nearVec(applyPose(p.live.get("third")!, [0, 0, 3]), [78, 0, 3], 1e-6));

  // The root moved by hand carries the train (D9): its pin moves with it, and the couplings stay.
  const objectsMoved = [...p.live].map(([id, modelPose]) => ({ id, modelPose: id === "pin" ? { ...modelPose, t: [modelPose.t[0] + 10, modelPose.t[1] + 5, modelPose.t[2]] as Vec3 } : modelPose }));
  const carried = readAssemblies(JSON.parse(JSON.stringify([worn])), objectsMoved)[0]!;
  eq("a root moved by hand keeps the couplings", carried.couplings?.length, 2);
  const carriedPoses = solveAssembly(carried, (id) => objectsMoved.find((row) => row.id === id)?.modelPose);
  check("and the train moved with it", nearVec(applyPose(carriedPoses.poses.get("wheel")!, [0, 0, 3]), [46, 5, 3], 1e-6));
  // A member moved by hand drops its couplings.
  const moved = { ...worn, members: worn.members.map((row) => (row.object === "third" ? { ...row, offset: [row.offset[0] + 1, row.offset[1], row.offset[2]] as Vec3 } : row)) };
  eq("a gear moved by hand drops its coupling", readAssemblies([moved], [...p.live].map(([id, modelPose]) => ({ id, modelPose })))[0]?.couplings?.map((row) => row.driven), ["wheel"]);

  // An older app: it reads the root's hinge, calls the root fixed and solves from its model pose. Every pose is where the
  // new app left it.
  const older: Assembly = { ...worn, members: worn.members.map((row) => (row.parent === null ? { object: row.object, parent: null, offset: [0, 0, 0], turn: [0, 0, 0] } : row)) };
  const oldPoses = solveAssembly(older, p.poseOf).poses, newPoses = solveAssembly(worn, p.poseOf).poses;
  check("an older app solves every pose where it stands", [...newPoses].every(([id, pose]) => nearVec(oldPoses.get(id)!.t, pose.t, 1e-9) && nearVec(oldPoses.get(id)!.m, pose.m, 1e-9)));

  // Animation: a key on the root turns the train; every frame meshes.
  const parts = coupled.members.map((row) => ({ object: row.object, name: nameOf(row.object) }));
  const run = sampleAnimation({ fps: 4, keys: [{ t: 0, set: { Pinion: 0 } }, { t: 1, set: { Pinion: 90 } }] }, coupled, p.poseOf, parts);
  check("an animation keyed on the hinged root samples", !("issues" in run), JSON.stringify(run));
  if (!("issues" in run)) {
    const last = run.frames.at(-1)!;
    check("its last frame turned the wheel -45 and the third +60", near(angleOf(last.assembly, "wheel"), -45) && near(angleOf(last.assembly, "third"), 60));
    check("the wheel stayed on its pin", nearVec(applyPose(last.poses.get("wheel")!, [0, 0, 3]), [36, 0, 3]));
    check("every frame meshes", run.frames.every((frame) => { const sweep = trainCheck(frame.assembly, p.poseOf, p.gearsAt, "pin", [0]); return !("reason" in sweep) && sweep.bad.length === 0; }));
  }
}

// --- A free gear that meshes with nothing: no assembly, nothing changed.
{
  const p = plate({ pin: at(0), lone: at(0, 80) });
  const prepared = prepareTrain([], p.parts(), "pin", p.poseOf, "asm_1");
  eq("nothing meshes, nothing is made", [prepared.assembly, prepared.assemblies.length, prepared.hinged], [null, 0, []]);
}

// --- Gears attached to a frame without hinges (Attach in Prepare), and a compound gear on the wheel's shaft.
const FRAME: Member = { object: "frame", parent: null, offset: [0, 0, 0], turn: [0, 0, 0] };
const seated = (object: string, parent: string, offset: Vec3): Member => ({ object, parent, offset, turn: [0, 0, 0] });
{
  const p = plate({ frame: at(0), pin: at(0), wheel: at(36), third: at(78), small: at(36, 0, 10), out: at(72, 0, 10) });
  const framed: Assembly = { id: "asm_1", name: "Frame", members: [FRAME, seated("pin", "frame", [0, 0, 0]), seated("wheel", "frame", [36, 0, 0]), seated("third", "frame", [78, 0, 0]), seated("small", "wheel", [0, 0, 10]), seated("out", "frame", [72, 0, 10])] };
  const prepared = prepareTrain([framed], p.parts(), "pin", p.poseOf, "asm_2");
  check("no new assembly", !prepared.made && prepared.assemblies.length === 1);
  eq("every gear on the frame got a hinge; the small gear on the wheel's shaft did not", prepared.hinged, ["pin", "wheel", "third", "out"]);
  eq("the small gear still sits on the wheel without a joint", prepared.assembly!.members.find((row) => row.object === "small"), seated("small", "wheel", [0, 0, 10]));
  const poses = solveAssembly(prepared.assembly!, p.poseOf).poses;
  const found = findCouplings(prepared.assembly!, p.gearsAt(poses), poses);
  eq("the shaft carries the train on", found.couplings.map((row) => [row.driver, row.driven, row.ratio, row.gears[0].name, row.gears[1].name]), [["pin", "wheel", -0.5, "Pinion", "Wheel"], ["wheel", "third", -24 / 18, "Wheel", "Third"], ["wheel", "out", -0.5, "Small", "Out"]]);
  const coupled = { ...prepared.assembly!, couplings: found.couplings };
  const turned = trainTurn(coupled, "pin", 40);
  check("pinion 40, wheel and small -20, out +10", !("reason" in turned) && near(angleOf(turned.assembly, "wheel"), -20) && near(angleOf(turned.assembly, "out"), 10));
  const sweep = trainCheck(coupled, p.poseOf, p.gearsAt, "pin", SWEEP);
  check("and stays meshing", !("reason" in sweep) && sweep.pairs === 3 && sweep.bad.length === 0, JSON.stringify(sweep));
  // Couple gears again changes no hinge.
  eq("a second Couple gears gives no hinge", prepareTrain([coupled], p.parts(), "wheel", p.poseOf, "asm_2").hinged, []);
}

// --- A gear seated without a joint on a gear it meshes with (not one shaft): a gear of its own.
{
  // On the root of a frameless assembly: it keeps its seat on the root, which turns on the plate.
  const p = plate({ pin: at(0), wheel: at(36) });
  const onRoot: Assembly = { id: "asm_1", name: "Pinion", members: [{ object: "pin", parent: null, offset: [0, 0, 0], turn: [0, 0, 0] }, seated("wheel", "pin", [36, 0, 0])] };
  const prepared = prepareTrain([onRoot], p.parts(), "pin", p.poseOf, "asm_2");
  eq("both get a hinge", prepared.hinged, ["pin", "wheel"]);
  eq("the wheel stays seated on the root", prepared.assembly!.members.find((row) => row.object === "wheel")?.parent, "pin");
  const poses = solveAssembly(prepared.assembly!, p.poseOf).poses;
  const found = findCouplings(prepared.assembly!, p.gearsAt(poses), poses);
  eq("and they couple", found.couplings.map((row) => row.ratio), [-0.5]);

  // On a hinged gear on a frame: seated on the frame instead, where it stands.
  const q = plate({ frame: at(0), pin: at(0), wheel: at(36) });
  const onGear: Assembly = { id: "asm_1", name: "Frame", members: [FRAME, { ...seated("pin", "frame", [0, 0, 0]), joint: { kind: "hinge", pivot: [0, 0, 3], axis: [0, 0, 1], angle: 0 } }, seated("wheel", "pin", [36, 0, 0])] };
  const moved = prepareTrain([onGear], q.parts(), "pin", q.poseOf, "asm_2");
  eq("only the wheel gets a hinge", moved.hinged, ["wheel"]);
  eq("seated on the frame where it stands", moved.assembly!.members.find((row) => row.object === "wheel")?.parent, "frame");
  check("where it stands", nearVec(solveAssembly(moved.assembly!, q.poseOf).poses.get("wheel")!.t, [36, 0, 0]));
}

// --- Held: a gear fixed on purpose is never given a hinge, and the train meshing with it is locked.
{
  const p = plate({ frame: at(0), pin: at(0), wheel: at(36) });
  const ringed: Assembly = { id: "asm_1", name: "Frame", members: [FRAME, seated("pin", "frame", [0, 0, 0]), { ...seated("wheel", "frame", [36, 0, 0]), held: true }] };
  const prepared = prepareTrain([ringed], p.parts(), "pin", p.poseOf, "asm_2");
  eq("the held wheel gets no hinge", prepared.hinged, ["pin"]);
  const poses = solveAssembly(prepared.assembly!, p.poseOf).poses;
  const found = findCouplings(prepared.assembly!, p.gearsAt(poses), poses);
  eq("and the train is locked, with its sentence", found.locked.map((row) => row.reason), ["Pinion and Wheel are locked: Wheel cannot turn, and the train meshes with it."]);
  eq("held survives the file", readAssemblies(JSON.parse(JSON.stringify([ringed])), [{ id: "frame" }, { id: "pin" }, { id: "wheel" }])[0]?.members[2]?.held, true);
  // A held root of a frameless pair stays fixed too.
  const q = plate({ pin: at(0), wheel: at(36) });
  const heldRoot: Assembly = { id: "asm_1", name: "Pinion", members: [{ object: "pin", parent: null, offset: [0, 0, 0], turn: [0, 0, 0], held: true }, seated("wheel", "pin", [36, 0, 0])] };
  eq("a held root gets no hinge", prepareTrain([heldRoot], q.parts(), "wheel", q.poseOf, "asm_2").hinged, ["wheel"]);
}

// --- A hinge off the gear's axis is kept and still refused with its sentence.
{
  const p = plate({ frame: at(0), pin: at(0), wheel: at(36) });
  const off: Assembly = { id: "asm_1", name: "Frame", members: [FRAME, seated("pin", "frame", [0, 0, 0]), { ...seated("wheel", "frame", [36, 0, 0]), joint: { kind: "hinge", pivot: [3, 0, 0], axis: [0, 0, 1], angle: 0 } }] };
  const prepared = prepareTrain([off], p.parts(), "pin", p.poseOf, "asm_2");
  eq("only the pinion is given a hinge", prepared.hinged, ["pin"]);
  const poses = solveAssembly(prepared.assembly!, p.poseOf).poses;
  eq("the wheel's own hinge is refused", findCouplings(prepared.assembly!, p.gearsAt(poses), poses).notCoupled.map((row) => row.reason), ["Pinion and Wheel are not coupled: Wheel's hinge does not turn about its gear's axis."]);
}

// --- A free gear meshing with an assembly's gear joins it; a gear riding the turning root is a planet.
{
  const p = plate({ frame: at(0), pin: at(0), wheel: at(36) });
  const one: Assembly = { id: "asm_1", name: "Frame", members: [FRAME, { ...seated("pin", "frame", [0, 0, 0]), joint: { kind: "hinge", pivot: [0, 0, 3], axis: [0, 0, 1], angle: 0 } }] };
  const prepared = prepareTrain([one], p.parts(), "pin", p.poseOf, "asm_2");
  eq("the free wheel joined on the root, with a hinge", [prepared.joined, prepared.hinged, prepared.assembly!.members.find((row) => row.object === "wheel")?.parent], [["wheel"], ["wheel"], "frame"]);
  const fromFree = prepareTrain([one], p.parts(), "wheel", p.poseOf, "asm_2");
  eq("Couple gears on the free wheel takes it into the assembly it meshes with", [fromFree.made, fromFree.assemblies.length, fromFree.joined, fromFree.hinged], [false, 1, ["wheel"], ["wheel"]]);

  const q = plate({ pin: at(0), arm: at(0, 0, 0), wheel: at(36) });
  const rides: Assembly = { id: "asm_1", name: "Pinion", members: [
    { object: "pin", parent: null, offset: [0, 0, 0], turn: [0, 0, 0], joint: { kind: "hinge", pivot: [0, 0, 3], axis: [0, 0, 1], angle: 0 } },
    seated("arm", "pin", [0, 0, 0]),
    { ...seated("wheel", "arm", [36, 0, 0]), joint: { kind: "hinge", pivot: [0, 0, 3], axis: [0, 0, 1], angle: 0 } },
  ] };
  const poses = solveAssembly(rides, q.poseOf).poses;
  eq("a hinge on a part that turns with the root is a planet", findCouplings(rides, q.gearsAt(poses), poses).notCoupled.map((row) => row.reason), ["Pinion and Wheel are not coupled: their hinges sit on different parts, and a gear that rides on another turning part is not covered."]);
}

// --- A scaled root cannot turn on the plate; a file with one drops the root's hinge.
{
  const scaled: Affine = { m: [2, 0, 0, 0, 2, 0, 0, 0, 2], t: [0, 0, 0] };
  const p = plate({ pin: scaled, wheel: at(36) });
  const prepared = prepareTrain([], p.parts(), "pin", p.poseOf, "asm_1");
  eq("refused with a sentence", prepared.refused, ["Pinion is scaled in model space, so it cannot turn on the plate."]);
  const hingedRoot = withRootAt({ id: "a", name: "A", members: [{ object: "pin", parent: null, offset: [0, 0, 0], turn: [0, 0, 0], joint: { kind: "hinge", pivot: [0, 0, 3], axis: [0, 0, 1], angle: 0 } }, seated("wheel", "pin", [18, 0, 0])] }, at(0));
  eq("a file with a scaled hinged root drops its hinge", readAssemblies([hingedRoot], [{ id: "pin", modelPose: scaled }, { id: "wheel" }])[0]?.members[0]?.joint, undefined);
}

if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("gear-kinds: all passed");
