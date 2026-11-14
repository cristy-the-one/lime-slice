/**
 * The gear-pair verdict against the same poses the kernel measures: centre distance and mating phase mesh, 0.06 mm
 * along the pitch circle is still mesh, 0.16 mm and half a tooth cross, and a driven turn stays in mesh.
 */
import { classify, drivenTurn, gearAt, gearPairRows, gearsInTree, nearestVerdict, placeGear, verdictSentence, worldPair, type Spur } from "./gear-pair.ts";
import { IDENTITY_POSE } from "./model-space.ts";
import type { PrimitiveSpec } from "./model-primitive.ts";
import { newTree, withChild, type ModelTree } from "./model-tree.ts";

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

const PAIRS: [number, number, number][] = [
  [12, 24, 2],
  [17, 31, 1.5],
  [9, 40, 1],
  [24, 24, 1],
];

function spur(teeth: number, module: number, pressureDeg = 20, backlash = 0.1, shift = 0): Spur {
  return { teeth, module, pressureDeg, backlash, shift };
}

function matePhase(ownPhase: number, ownZ: number, dir: number, mateZ: number): number {
  const ownPitch = 360 / ownZ;
  const f = ((((dir - ownPhase) / ownPitch) % 1) + 1) % 1;
  return dir + 180 - (0.5 - f) * (360 / mateZ);
}

function at(z1: number, z2: number, module: number, turnMm: number) {
  const driver = spur(z1, module);
  const driven = spur(z2, module);
  const distance = (module * (z1 + z2)) / 2;
  const phase = matePhase(0, z1, 0, z2);
  const deg = phase + (turnMm / ((module * z2) / 2)) * (180 / Math.PI);
  return classify(driver, driven, [0, 0], [distance, 0], 0, deg);
}

for (const [z1, z2, module] of PAIRS) {
  for (const turn of [0, 0.06, -0.06]) {
    const report = at(z1, z2, module, turn);
    eq(`${z1}/${z2} at ${turn} mm meshes`, report.verdict, "meshing");
    check(`${z1}/${z2} at ${turn} mm compares outlines`, report.narrow);
    check(`${z1}/${z2} at ${turn} mm has no segment hit`, !report.hit);
  }
  for (const turn of [0.16, -0.16]) {
    eq(`${z1}/${z2} at ${turn} mm crosses`, at(z1, z2, module, turn).verdict, "toothOnTooth");
  }
  eq(`${z1}/${z2} half a tooth crosses`, at(z1, z2, module, (Math.PI * module) / 2).verdict, "toothOnTooth");
  const driver = spur(z1, module);
  const driven = spur(z2, module);
  const distance = (module * (z1 + z2)) / 2;
  const phase = matePhase(0, z1, 0, z2);
  for (const angle of [0, 1, 15, 90, 180, 360]) {
    const report = drivenTurn(driver, driven, [0, 0], [distance, 0], 0, phase, angle);
    eq(`${z1}/${z2} driven at ${angle}° meshes`, report.verdict, "meshing");
    check(`${z1}/${z2} driven at ${angle}° has no segment hit`, !report.hit);
  }
}

const apart = classify(spur(12, 2), spur(24, 2), [0, 0], [1000, 0], 0, 172.5);
eq("far apart", apart, { verdict: "apart", narrow: false, hit: false });

// Tip radii 14 and 19.5 mm: at 30 mm the gears reach each other and cannot mesh. At 36 mm they do not reach, and two
// stages of a train with different modules are not a fault.
const modules = classify(spur(12, 2), spur(24, 1.5), [0, 0], [30, 0], 0, 172.5);
eq("modules 2 and 1.5 that reach each other", modules.verdict, "moduleMismatch");
check("a module mismatch skips the outlines", !modules.narrow);
eq("modules 2 and 1.5 that do not reach", classify(spur(12, 2), spur(24, 1.5), [0, 0], [36, 0], 0, 172.5).verdict, "apart");

const pressure = classify(spur(12, 2), spur(24, 2, 25), [0, 0], [36, 0], 0, matePhase(0, 12, 0, 24));
eq("pressure angles differ", pressure.verdict, "pressureMismatch");

const close = classify(spur(24, 1), spur(24, 1), [0, 0], [24 - 0.25, 0], 0, matePhase(0, 24, 0, 24));
eq("inside the backlash", close.verdict, "tooClose");
check("too close still compares outlines", close.narrow);

const widened = spur(12, 2);
const widenedMate = spur(24, 2);
const widenedPhase = matePhase(0, 12, 0, 24);
{
  const deg = widenedPhase + (0.16 / 24) * (180 / Math.PI);
  const onEdge = classify(widened, widenedMate, [0, 0], [36.2, 0], 0, deg);
  check("36.2 mm has no segment hit", !onEdge.hit);
  eq("36.2 mm is still in the band", onEdge.verdict, "meshing");
}
for (const distance of [37, 38, 39.9]) {
  const deg = widenedPhase + (0.16 / 24) * (180 / Math.PI);
  const report = classify(widened, widenedMate, [0, 0], [distance, 0], 0, deg);
  check(`${distance} mm has no segment hit`, !report.hit);
  eq(`${distance} mm is loose`, report.verdict, "loose");
}
eq("12/24 m2 at 39.9 mm is loose", classify(widened, widenedMate, [0, 0], [39.9, 0], 0, widenedPhase).verdict, "loose");
const tightDeg = widenedPhase + (0.065 / 24) * (180 / Math.PI);
const tight = classify(widened, widenedMate, [0, 0], [35.9, 0], 0, tightDeg);
check("0.065 mm tight does not cross", !tight.hit);
eq("35.9 mm shrinks the play", tight.verdict, "toothOnTooth");
const crossedDeg = widenedPhase + (Math.PI / 24) * (180 / Math.PI);
const crossed = classify(widened, widenedMate, [0, 0], [36, 0], 0, crossedDeg);
check("half a tooth crosses", crossed.hit);
eq("a crossing stays tooth on tooth", crossed.verdict, "toothOnTooth");

// Past the band the teeth are narrow where they overlap: a fifth of a tooth at 39 mm and just over a quarter at
// 39.5 mm cross nothing, so the pair is loose. Tip against tip crosses.
const pitchMm = Math.PI * 2;
for (const [distance, tooth] of [[39, 0.2], [39.5, 0.26]] as const) {
  const report = classify(widened, widenedMate, [0, 0], [distance, 0], 0, widenedPhase + ((tooth * pitchMm) / 24) * (180 / Math.PI));
  check(`${distance} mm, ${tooth} of a tooth has no segment hit`, !report.hit);
  eq(`${distance} mm, ${tooth} of a tooth is loose`, report.verdict, "loose");
}
for (const [distance, tooth] of [[39, 0.5], [39.5, 0.5], [38, 0.2]] as const) {
  const report = classify(widened, widenedMate, [0, 0], [distance, 0], 0, widenedPhase + ((tooth * pitchMm) / 24) * (180 / Math.PI));
  check(`${distance} mm, ${tooth} of a tooth crosses`, report.hit);
  eq(`${distance} mm, ${tooth} of a tooth is tooth on tooth`, report.verdict, "toothOnTooth");
}

const pointed = spur(6, 1, 30, 0.1, 1);
const pointedMate = spur(12, 1, 30);
// Working distance for shift 1 at 30°, the pose that would be a mesh if the outline existed.
const pointedDistance = 9.889005006574346;
const pointedPhase = matePhase(0, 6, 0, 12);
const refused = classify(pointed, pointedMate, [0, 0], [pointedDistance, 0], 0, pointedPhase);
check("a pointed gear is not compared", !refused.narrow);
check("a pointed gear is not a hit", !refused.hit);
eq("a pointed gear is unbuildable", refused.verdict, "unbuildable");
check("the card can name the refusal", (refused.reason ?? "").includes("come to a point"), refused.reason ?? "");

function gearSpec(teeth: number, module: number, origin: [number, number, number], phaseDeg = 0): PrimitiveSpec {
  return { primitive: "gear", origin, size: [0, 0, 0], radius: 0, height: 6, turn: [0, 0, 0], teeth, module, phaseDeg };
}

const pinion = gearAt(gearSpec(12, 2, [0, 0, 0]), "pin", "Pinion");
const wheel = gearAt(gearSpec(24, 2, [36, 0, 0], matePhase(0, 12, 0, 24)), "wheel", "Wheel");
check("a placed pair is two gears", !!pinion && !!wheel);
if (pinion && wheel) {
  const pair = worldPair(pinion, wheel);
  eq("placed at the centre distance", pair && { verdict: pair.verdict, hit: pair.hit, narrow: pair.narrow }, { verdict: "meshing", hit: false, narrow: true });
  const stacked = placeGear(gearSpec(24, 2, [36, 0, 20], matePhase(0, 12, 0, 24)), IDENTITY_POSE, "high", "High", null);
  const above = stacked ? worldPair(pinion, stacked) : null;
  eq("stacked clear of the teeth", above, { verdict: "apart", narrow: false, hit: false });
  const nearest = nearestVerdict(pinion, [stacked!, wheel]);
  eq("the card names the gear it meshes with", nearest && verdictSentence(nearest.other.label, nearest.report.verdict), "Meshes with Wheel.");
  const rows = gearPairRows([pinion, wheel], "pin");
  eq("model_check rows", rows, [{ a: "pin", b: "wheel", names: ["Pinion", "Wheel"], verdict: "meshing", narrow: true, hit: false, distanceMm: 36, workingMm: 36 }]);
  // The wheel lying the other way up (turned 180° about X, about the middle of its axis) is the same gear: its
  // tooth 0 shows at the mirrored phase in the pinion's plane.
  const flipped = placeGear({ ...gearSpec(24, 2, [36, 0, 0], -matePhase(0, 12, 0, 24)), turn: [180, 0, 0] }, IDENTITY_POSE, "flip", "Flipped", null);
  eq("a flipped wheel still meshes", flipped && worldPair(pinion, flipped)?.verdict, "meshing");
  const flippedOff = placeGear({ ...gearSpec(24, 2, [36, 0, 0], matePhase(0, 12, 0, 24) + 7.5), turn: [180, 0, 0] }, IDENTITY_POSE, "flip", "Flipped", null);
  eq("a flipped wheel half a tooth off crosses", flippedOff && worldPair(pinion, flippedOff)?.verdict, "toothOnTooth");
  const square = placeGear({ ...gearSpec(24, 2, [36, 0, 0]), turn: [90, 0, 0] }, IDENTITY_POSE, "sq", "Square", null);
  eq("axes at a right angle are not this check", square && worldPair(pinion, square), null);
  const wide = gearAt(gearSpec(24, 2, [37, 0, 0], matePhase(0, 12, 0, 24)), "wide", "Wide");
  const widePair = wide ? worldPair(pinion, wide) : null;
  eq("a wide pair says where it meshes", widePair && verdictSentence("Wide", widePair.verdict, widePair.reason, widePair.distanceMm, widePair.workingMm), "Too far from Wide: centres 37 mm apart, they mesh at 36 mm.");
}

const root = gearSpec(12, 2, [0, 0, 0]);
const tree: ModelTree = newTree("k", { kind: "primitive", solid: root }, "Pinion", null);
const found = gearsInTree(tree, IDENTITY_POSE, "pin", "Pinion");
eq("a root gear is the object's own", found.map((gear) => [gear.objectId, gear.step, gear.label, gear.spur.teeth]), [["pin", null, "Pinion", 12]]);

const patterned = withChild(newTree("p", { kind: "primitive", solid: { primitive: "box", origin: [0, 0, 0], size: [10, 10, 10], radius: 0, height: 0, turn: [0, 0, 0] } }, "Box", null), 0, {
  id: 1,
  op: {
    kind: "group",
    label: "Pattern",
    steps: [
      { ...gearSpec(18, 1, [0, 0, 0]), kind: "boolean", op: "fuse" },
      { kind: "group", label: "Batch", steps: [{ ...gearSpec(30, 1, [24, 0, 0]), kind: "boolean", op: "fuse" }] },
    ],
  },
  label: "Pattern",
  fingerprint: null,
});
const inGroup = gearsInTree(patterned, IDENTITY_POSE, "box", "Box");
// Two gears of one solid are one body: no row between them, a row each against another object's gear.
const loneWheel = gearAt(gearSpec(30, 1, [24, 0, 0]), "other", "Other");
eq("gears of one solid are not a pair", gearPairRows(inGroup, "box"), []);
eq("each is a pair with another solid's gear", loneWheel && gearPairRows([...inGroup, loneWheel], "box").map((row) => [row.a, row.b, row.steps]), [["box", "other", [1, null]], ["box", "other", [1, null]]]);
eq("a pattern and a nested batch both count", inGroup.map((gear) => [gear.step, gear.spur.teeth, gear.centre[0]]), [[1, 18, 0], [1, 30, 24]]);

eq("the sentences", [verdictSentence("Wheel", "apart"), verdictSentence("Wheel", "toothOnTooth"), verdictSentence("Wheel", "loose"), verdictSentence("Wheel", "unbuildable", "These teeth come to a point below the tip.")], ["Clear of Wheel.", "Teeth cross Wheel.", "Too far from Wheel.", "Unbuildable with Wheel: These teeth come to a point below the tip."]);

const self = gearAt(gearSpec(12, 2, [0, 0, 0]), "pin", "Pinion");
const far = gearAt(gearSpec(24, 2, [200, 0, 0], 0), "far", "Far");
const near = gearAt(gearSpec(24, 2, [36, 0, 0], 0), "near", "Near");
check("the card repro is three gears", !!self && !!far && !!near);
if (self && far && near) {
  eq("far then near names the nearer crossing", nearestVerdict(self, [far, near]) && verdictSentence(nearestVerdict(self, [far, near])!.other.label, nearestVerdict(self, [far, near])!.report.verdict), "Teeth cross Near.");
  const small = gearAt(gearSpec(6, 1, [20, 0, 0], 0), "small", "Small");
  eq("a gear it reaches wins over a nearer one it does not", small && nearestVerdict(self, [small, near])?.other.label, "Near");
  eq("near then far names the nearer crossing", nearestVerdict(self, [near, far]) && verdictSentence(nearestVerdict(self, [near, far])!.other.label, nearestVerdict(self, [near, far])!.report.verdict), "Teeth cross Near.");
  const meshFar = gearAt(gearSpec(40, 2, [52, 0, 0], matePhase(0, 12, 0, 40)), "mesh", "Mesh");
  if (meshFar) {
    eq("the farther gear meshes", worldPair(self, meshFar)?.verdict, "meshing");
    eq("a mesh wins over a nearer crossing", nearestVerdict(self, [near, meshFar])?.other.label, "Mesh");
  }
}

if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("gear-pair: ok");
