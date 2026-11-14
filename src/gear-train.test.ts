/**
 * Gear trains (docs/plan-gear-coupling.md): couplings found from meshing pairs, the tooth ratio and its sign, a turn
 * carried through a train and a shared shaft, loops that turn and loops that lock, hinge limits that stop the train,
 * the mesh check as the validator over sampled frames, the file round trip, and an animation keyed on the driver.
 */
import { readAssemblies, solveAssembly, withoutMember, type Assembly, type Coupling, type Member } from "./assembly.ts";
import { placeGear, type WorldGear } from "./gear-pair.ts";
import { bodyOf, findCouplings, trainCheck, trainOf, trainScales, trainTurn } from "./gear-train.ts";
import { IDENTITY_POSE, type Affine } from "./model-space.ts";
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

function matePhase(ownPhase: number, ownZ: number, dir: number, mateZ: number): number {
  const ownPitch = 360 / ownZ;
  const f = ((((dir - ownPhase) / ownPitch) % 1) + 1) % 1;
  return dir + 180 - (0.5 - f) * (360 / mateZ);
}

function gearSpec(teeth: number, phaseDeg = 0, module = 2): PrimitiveSpec {
  return { primitive: "gear", origin: [0, 0, 0], size: [0, 0, 0], radius: 0, height: 6, turn: [0, 0, 0], teeth, module, phaseDeg };
}

/** A gear on a hinge about its own axis (part-frame Z), sat on `parent` at `offset`. */
function hinged(object: string, parent: string, offset: Vec3, axis: Vec3 = [0, 0, 1], extra: Partial<Extract<Member["joint"], { kind: "hinge" }>> = {}): Member {
  return { object, parent, offset, turn: [0, 0, 0], joint: { kind: "hinge", pivot: [0, 0, 0], axis, angle: 0, ...extra } };
}

const FRAME: Member = { object: "frame", parent: null, offset: [0, 0, 0], turn: [0, 0, 0] };

/** The members' gears at `poses`. */
function gearsWith(specs: Record<string, { spec: PrimitiveSpec; name: string }>) {
  return (poses: ReadonlyMap<string, Affine>): WorldGear[] =>
    Object.entries(specs).flatMap(([id, row]) => {
      const pose = poses.get(id);
      const gear = pose ? placeGear(row.spec, pose, id, row.name, null) : null;
      return gear ? [gear] : [];
    });
}

const poseOf = () => IDENTITY_POSE;
const angleOf = (assembly: Assembly, id: string) => {
  const joint = assembly.members.find((row) => row.object === id)?.joint;
  return joint?.kind === "hinge" ? joint.angle ?? 0 : undefined;
};

function couple(assembly: Assembly, gearsAt: (poses: ReadonlyMap<string, Affine>) => WorldGear[]) {
  const found = findCouplings(assembly, gearsAt(solveAssembly(assembly, poseOf).poses), solveAssembly(assembly, poseOf).poses);
  return { found, coupled: { ...assembly, couplings: found.couplings } as Assembly };
}

// Not a divisor of a pitch: at 15° steps a wrong sign moves the wheel by whole teeth and looks right.
const SWEEP = Array.from({ length: 73 }, (_, i) => i * 5);

// --- A pinion (12) and a wheel (24) at their centre distance, the wheel at the mating phase.
const WHEEL_PHASE = matePhase(0, 12, 0, 24);
const pair: Assembly = { id: "a", name: "Pair", members: [FRAME, hinged("pin", "frame", [0, 0, 0]), hinged("wheel", "frame", [36, 0, 0])] };
const pairGears = gearsWith({ pin: { spec: gearSpec(12), name: "Pinion" }, wheel: { spec: gearSpec(24, WHEEL_PHASE), name: "Wheel" } });
{
  const { found, coupled } = couple(pair, pairGears);
  eq("a meshing pair is one coupling at -z1/z2", found.couplings.map((row) => [row.driver, row.driven, row.ratio]), [["pin", "wheel", -0.5]]);
  eq("nothing refused or locked", [found.notCoupled, found.locked], [[], []]);
  const turned = trainTurn(coupled, "pin", 30);
  check("turning the pinion is not refused", !("reason" in turned), JSON.stringify(turned));
  if (!("reason" in turned)) {
    check("the pinion stands at 30", near(angleOf(turned.assembly, "pin"), 30));
    check("the wheel turned -15", near(angleOf(turned.assembly, "wheel"), -15));
    eq("the reply names both hinges", turned.angles.map((row) => row.object), ["pin", "wheel"]);
  }
  const back = trainTurn(coupled, "wheel", 10);
  check("turning the wheel drives the pinion back by -20", !("reason" in back) && near(angleOf(back.assembly, "pin"), -20));
  const check1 = trainCheck(coupled, poseOf, pairGears, "pin", SWEEP);
  check("a whole turn of the pinion, sampled every 5°, stays meshing", !("reason" in check1) && check1.frames === 73 && check1.pairs === 1 && check1.bad.length === 0, JSON.stringify(check1));
  // The validator is a real judge: with the sign of the ratio wrong, the teeth cross.
  const wrong: Assembly = { ...coupled, couplings: coupled.couplings!.map((row) => ({ ...row, ratio: -row.ratio })) };
  const check2 = trainCheck(wrong, poseOf, pairGears, "pin", SWEEP);
  check("a wrong ratio is caught as tooth on tooth", !("reason" in check2) && check2.bad.some((row) => row.verdict === "toothOnTooth"), JSON.stringify(check2));
  eq("an uncoupled hinge turns alone", (() => { const one = trainTurn(pair, "pin", 30); return "reason" in one ? one.reason : [angleOf(one.assembly, "pin"), angleOf(one.assembly, "wheel")]; })(), [30, 0]);
}

// --- The wheel's hinge points the other way: the two turn the same way about their own axes.
{
  const flipped: Assembly = { ...pair, members: [FRAME, hinged("pin", "frame", [0, 0, 0]), hinged("wheel", "frame", [36, 0, 0], [0, 0, -1])] };
  const { found, coupled } = couple(flipped, pairGears);
  eq("hinge axes opposite: the ratio is +z1/z2", found.couplings.map((row) => row.ratio), [0.5]);
  const turned = trainTurn(coupled, "pin", 30);
  check("the wheel's hinge reads +15", !("reason" in turned) && near(angleOf(turned.assembly, "wheel"), 15));
  const sweep = trainCheck(coupled, poseOf, pairGears, "pin", SWEEP);
  check("and still meshes at every sampled angle", !("reason" in sweep) && sweep.bad.length === 0, JSON.stringify(sweep));
}

// --- Three gears in a row: each mesh flips and scales.
const THIRD_PHASE = matePhase(WHEEL_PHASE, 24, 0, 18);
const row3: Assembly = { id: "r", name: "Row", members: [FRAME, hinged("pin", "frame", [0, 0, 0]), hinged("wheel", "frame", [36, 0, 0]), hinged("third", "frame", [78, 0, 0])] };
const row3Gears = gearsWith({ pin: { spec: gearSpec(12), name: "Pinion" }, wheel: { spec: gearSpec(24, WHEEL_PHASE), name: "Wheel" }, third: { spec: gearSpec(18, THIRD_PHASE), name: "Third" } });
{
  const { found, coupled } = couple(row3, row3Gears);
  eq("three in a row: two couplings", found.couplings.map((row) => [row.driver, row.driven, row.ratio]), [["pin", "wheel", -0.5], ["wheel", "third", -24 / 18]]);
  const turned = trainTurn(coupled, "pin", 30);
  check("pinion 30, wheel -15, third +20", !("reason" in turned) && near(angleOf(turned.assembly, "wheel"), -15) && near(angleOf(turned.assembly, "third"), 20), JSON.stringify(!("reason" in turned) && turned.angles));
  const fromEnd = trainTurn(coupled, "third", -20);
  check("turning the far end drives back to the pinion", !("reason" in fromEnd) && near(angleOf(fromEnd.assembly, "pin"), -30));
  const sweep = trainCheck(coupled, poseOf, row3Gears, "pin", SWEEP);
  check("the whole train stays meshing over a turn", !("reason" in sweep) && sweep.pairs === 2 && sweep.bad.length === 0, JSON.stringify(sweep));
  eq("trainOf names every body", [...trainOf(coupled, "third")].sort(), ["pin", "third", "wheel"]);

  // Hinge limits stop the whole train together: the third gear may go to +10 only.
  const limited: Assembly = { ...coupled, members: coupled.members.map((row) => (row.object === "third" ? hinged("third", "frame", [78, 0, 0], [0, 0, 1], { min: -90, max: 10 }) : row)) };
  const stopped = trainTurn(limited, "pin", 30);
  check("a limit holds the train short", !("reason" in stopped) && stopped.clamped && near(angleOf(stopped.assembly, "third"), 10) && near(angleOf(stopped.assembly, "pin"), 15) && near(angleOf(stopped.assembly, "wheel"), -7.5), JSON.stringify(!("reason" in stopped) && stopped.angles));
}

// --- A shared shaft: a small gear seated on the wheel without a joint turns with it, and drives a fourth gear.
{
  const shaft: Assembly = { id: "s", name: "Shaft", members: [
    FRAME, hinged("pin", "frame", [0, 0, 0]), hinged("wheel", "frame", [36, 0, 0]),
    { object: "small", parent: "wheel", offset: [0, 0, 10], turn: [0, 0, 0] },
    hinged("out", "frame", [72, 0, 10]),
  ] };
  const gears = gearsWith({ pin: { spec: gearSpec(12), name: "Pinion" }, wheel: { spec: gearSpec(24, WHEEL_PHASE), name: "Wheel" }, small: { spec: gearSpec(12), name: "Small" }, out: { spec: gearSpec(24, WHEEL_PHASE), name: "Out" } });
  eq("the small gear's body is the wheel", bodyOf(shaft, "small"), { body: "wheel", fixed: false });
  const { found, coupled } = couple(shaft, gears);
  eq("the shaft carries the train on", found.couplings.map((row) => [row.driver, row.driven, row.ratio, row.gears[0].name, row.gears[1].name]), [["pin", "wheel", -0.5, "Pinion", "Wheel"], ["wheel", "out", -0.5, "Small", "Out"]]);
  const turned = trainTurn(coupled, "pin", 40);
  check("pinion 40, wheel and small -20, out +10", !("reason" in turned) && near(angleOf(turned.assembly, "wheel"), -20) && near(angleOf(turned.assembly, "out"), 10));
  const sweep = trainCheck(coupled, poseOf, gears, "pin", SWEEP);
  check("the shaft train stays meshing", !("reason" in sweep) && sweep.pairs === 2 && sweep.bad.length === 0, JSON.stringify(sweep));
}

// --- Loops, by hand-made couplings: a ring of four equal gears turns; three in a ring lock.
const ref = (object: string) => ({ object, step: null, name: object.toUpperCase() });
const link = (driver: string, driven: string, ratio: number): Coupling => ({ driver, driven, ratio, gears: [ref(driver), ref(driven)] });
{
  const members = [FRAME, ...["a", "b", "c", "d"].map((id, i) => hinged(id, "frame", [i * 30, 0, 0]))];
  const ring: Assembly = { id: "q", name: "Ring", members, couplings: [link("a", "b", -1), link("b", "c", -1), link("c", "d", -1), link("d", "a", -1)] };
  eq("an even ring of equal gears agrees", trainScales(ring, "a").locked, undefined);
  const turned = trainTurn(ring, "a", 12);
  check("and turns: b -12, c +12, d -12", !("reason" in turned) && near(angleOf(turned.assembly, "b"), -12) && near(angleOf(turned.assembly, "c"), 12) && near(angleOf(turned.assembly, "d"), -12));
  const triangle: Assembly = { id: "t", name: "Triangle", members: members.slice(0, 4), couplings: [link("a", "b", -1), link("b", "c", -1), link("c", "a", -1)] };
  const locked = trainTurn(triangle, "b", 12);
  eq("three gears in a ring lock, named in a sentence", locked, { reason: "A, B and C are locked: they close a loop whose tooth ratios do not agree, so none of them can turn.", locked: ["A", "B", "C"] });
  eq("and nothing moved", triangle.members.map((row) => angleOf(triangle, row.object) ?? null), [null, 0, 0, 0]);
  const mixed: Assembly = { ...triangle, couplings: [link("a", "b", -2), link("b", "c", -0.5), link("a", "c", 1.0000001)] };
  check("a ratio loop off by more than rounding locks", "locked" in trainTurn(mixed, "a", 1));
  const agreeing: Assembly = { ...triangle, couplings: [link("a", "b", -2), link("b", "c", -0.5), link("a", "c", 1)] };
  check("a loop whose ratios agree turns", !("reason" in trainTurn(agreeing, "a", 1)));
}

// --- A gear fused onto the fixed frame: the pinion meshing with it cannot turn.
{
  const fixed: Assembly = { id: "f", name: "Fixed", members: [FRAME, hinged("pin", "frame", [0, 0, 0])] };
  const gears = gearsWith({ frame: { spec: { ...gearSpec(24, WHEEL_PHASE), origin: [36, 0, 0] }, name: "Ring" }, pin: { spec: gearSpec(12), name: "Pinion" } });
  const { found, coupled } = couple(fixed, gears);
  eq("the fixed gear is coupled and the train is locked", [found.couplings.length, found.locked.map((row) => row.reason)], [1, ["Pinion and Ring are locked: Ring cannot turn, and the train meshes with it."]]);
  check("turning the pinion is refused", "reason" in trainTurn(coupled, "pin", 5));
  // The same pair with the pinion seated without a joint: they mesh and neither can turn. That is said, not skipped.
  const { joint: _joint, ...seatedPin } = hinged("pin", "frame", [0, 0, 0]);
  const seated = couple({ id: "s", name: "Seated", members: [FRAME, seatedPin] }, gears).found;
  eq("two meshing gears with no hinge are named, not coupled", [seated.couplings.length, seated.notCoupled.map((row) => row.reason)], [0, ["Ring and Pinion are not coupled: they mesh, but neither has a hinge to turn on."]]);
}

// --- Pairs that do not mesh are not coupled, in one sentence each.
{
  const far: Assembly = { ...pair, members: [FRAME, hinged("pin", "frame", [0, 0, 0]), hinged("wheel", "frame", [37, 0, 0])] };
  eq("too far: the sentence says where they mesh", couple(far, pairGears).found.notCoupled, [{ names: ["Pinion", "Wheel"], verdict: "loose", reason: "Pinion and Wheel are not coupled: they are too far apart (centres 37 mm apart, they mesh at 36 mm)." }]);
  const crossing = gearsWith({ pin: { spec: gearSpec(12), name: "Pinion" }, wheel: { spec: gearSpec(24, WHEEL_PHASE + 7.5), name: "Wheel" } });
  eq("half a tooth off: the teeth cross", couple(pair, crossing).found.notCoupled.map((row) => row.reason), ["Pinion and Wheel are not coupled: their teeth cross."]);
  const offAxis: Assembly = { ...pair, members: [FRAME, hinged("pin", "frame", [0, 0, 0]), { ...hinged("wheel", "frame", [36, 0, 0]), joint: { kind: "hinge", pivot: [3, 0, 0], axis: [0, 0, 1], angle: 0 } }] };
  eq("a hinge off the gear's axis is not coupled", couple(offAxis, pairGears).found.notCoupled.map((row) => row.reason), ["Pinion and Wheel are not coupled: Wheel's hinge does not turn about its gear's axis."]);
  const planet: Assembly = { ...pair, members: [FRAME, hinged("pin", "frame", [0, 0, 0]), hinged("arm", "frame", [0, 0, 0], [0, 0, 1]), hinged("wheel", "arm", [36, 0, 0])] };
  // A planet on an arm that turns about the pinion's axis is a planetary mesh (docs/plan-gear-kinds.md, stage 2).
  eq("a planet on an arm coaxial with its sun is coupled through the arm", couple(planet, pairGears).found.couplings.map((row) => [row.driver, row.driven, row.ratio, row.carrier?.body]), [["pin", "wheel", -0.5, "arm"]]);
  const offArm: Assembly = { ...pair, members: [FRAME, hinged("pin", "frame", [0, 0, 0]), hinged("arm", "frame", [5, 0, 0], [0, 0, 1]), hinged("wheel", "arm", [31, 0, 0])] };
  eq("an arm off the sun's axis is not covered", couple(offArm, pairGears).found.notCoupled.map((row) => row.reason), ["Pinion and Wheel are not coupled: their hinges sit on different parts, and a gear that rides on another turning part is covered only on a carrier whose hinge shares the other gear's axis."]);
}

// --- The file: couplings round-trip, a damaged one is dropped, and a removed member or joint drops its couplings.
{
  const { coupled } = couple(row3, row3Gears);
  const objects = row3.members.map((row) => ({ id: row.object }));
  const read = readAssemblies(JSON.parse(JSON.stringify([coupled])), objects);
  eq("couplings round-trip through the reader", read[0]?.couplings, coupled.couplings);
  const damaged = JSON.parse(JSON.stringify([coupled]));
  damaged[0].couplings.push({ driver: "pin", driven: "wheel", ratio: "x" }, null);
  eq("a damaged row is left out and the assembly stays", readAssemblies(damaged, objects)[0]?.couplings?.length, 2);
  eq("without the third gear one coupling is left", readAssemblies(JSON.parse(JSON.stringify([coupled])), objects.filter((row) => row.id !== "third"))[0]?.couplings?.map((row) => row.driven), ["wheel"]);
  const unjointed = { ...coupled, members: coupled.members.map((row) => (row.object === "wheel" ? { object: "wheel", parent: "frame", offset: row.offset, turn: row.turn } : row)) };
  eq("a body that lost its hinge drops its couplings", readAssemblies([unjointed], objects)[0]?.couplings, undefined);
  eq("withoutMember drops the couplings it touched", withoutMember(coupled, "pin", poseOf)?.couplings?.map((row) => row.driver), ["wheel"]);
  // The seat: hinge turns never change it, so a train turned 600 times by odd steps keeps every coupling.
  let worn: Assembly = coupled;
  for (let i = 0; i < 600; i++) {
    const step = trainTurn(worn, i % 3 === 0 ? "third" : "pin", 7.37 * (i % 2 ? -1 : 1.3));
    if ("reason" in step) throw new Error(step.reason);
    worn = step.assembly;
  }
  eq("600 turns later the couplings still read", readAssemblies([worn], objects)[0]?.couplings?.length, 2);
  const wornCheck = trainCheck(readAssemblies([worn], objects)[0]!, poseOf, row3Gears, "pin", SWEEP);
  check("and the train still meshes everywhere", !("reason" in wornCheck) && wornCheck.bad.length === 0, JSON.stringify(wornCheck));
  // Moving a coupled gear, or its hinge's pivot, uncouples it: the joint never drives gears that may no longer mesh.
  const moved = { ...coupled, members: coupled.members.map((row) => (row.object === "third" ? { ...row, offset: [79, 0, 0] as Vec3 } : row)) };
  eq("a gear moved by hand drops its couplings", readAssemblies([moved], objects)[0]?.couplings?.map((row) => row.driven), ["wheel"]);
  const pivoted = { ...coupled, members: coupled.members.map((row) => (row.object === "wheel" && row.joint?.kind === "hinge" ? { ...row, joint: { ...row.joint, pivot: [0, 1, 0] as Vec3 } } : row)) };
  eq("a hinge whose pivot moved drops both couplings", readAssemblies([pivoted], objects)[0]?.couplings, undefined);
  const zeroed = { ...worn, members: worn.members.map((row) => (row.joint?.kind === "hinge" ? { ...row, joint: { ...row.joint, angle: 0 } } : row)) };
  eq("Make rest (a new zero, the same pose) keeps them", readAssemblies([zeroed], objects)[0]?.couplings?.length, 2);
  // An older app reads id, name and members: the same rows, without the couplings.
  const older = (JSON.parse(JSON.stringify([coupled])) as Record<string, unknown>[]).map(({ id, name, members }) => ({ id, name, members }));
  eq("what an older app keeps still opens", readAssemblies(older, objects)[0]?.members.length, 4);
}

// --- Animation: a key on the pinion turns the train; keys on two gears of one train are refused; rest goes through the lead.
{
  const { coupled } = couple(row3, row3Gears);
  const parts = coupled.members.map((row) => ({ object: row.object, name: row.object === "frame" ? "Frame" : row.object }));
  const run = sampleAnimation({ fps: 4, keys: [{ t: 0, set: { pin: 0 } }, { t: 1, set: { pin: 90 } }] }, coupled, poseOf, parts);
  check("an animation keyed on the pinion samples", !("issues" in run), JSON.stringify(run));
  if (!("issues" in run)) {
    const last = run.frames.at(-1)!.assembly;
    check("its last frame turned the wheel -45 and the third +60", near(angleOf(last, "wheel"), -45) && near(angleOf(last, "third"), 60), JSON.stringify(last.members.map((row) => [row.object, angleOf(last, row.object)])));
    const pairsMesh = run.frames.every((frame) => {
      const gears = row3Gears(frame.poses);
      const sweep = trainCheck(frame.assembly, poseOf, row3Gears, "pin", [0]);
      return gears.length === 3 && !("reason" in sweep) && sweep.bad.length === 0;
    });
    check("every frame of the animation meshes", pairsMesh);
  }
  const both = sampleAnimation({ fps: 4, keys: [{ t: 0, set: { pin: 0, third: 0 } }, { t: 1, set: { pin: 90 } }] }, coupled, poseOf, parts);
  eq("two gears of one train keyed are refused", "issues" in both && both.issues.map((row) => row.reason), ["pin and third are one gear train; key only one of them."]);
  const rest = sampleAnimation({ fps: 4, keys: [{ t: 0, rest: true }, { t: 1, set: { wheel: 30 } }] }, coupled, poseOf, parts);
  check("rest goes through the keyed gear alone", !("issues" in rest) && near(angleOf(rest.frames.at(-1)!.assembly, "pin"), -60), JSON.stringify(rest));
}

if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("gear-train: all passed");
