/**
 * The gear-pair verdict against the same poses the kernel measures: centre distance and mating phase mesh, 0.06 mm
 * along the pitch circle is still mesh, 0.16 mm and half a tooth cross, and a driven turn stays in mesh.
 */
import { classify, drivenTurn, gearAt, gearPairRows, gearsInTree, nearestVerdict, placeGear, verdictSentence, worldPair, type Spur } from "./gear-pair.ts";
import { IDENTITY_POSE } from "./model-space.ts";
import type { PrimitiveSpec } from "./model-primitive.ts";
import { newTree, type ModelTree } from "./model-tree.ts";

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

const modules = classify(spur(12, 2), spur(24, 1.5), [0, 0], [36, 0], 0, 172.5);
eq("modules 2 and 1.5", modules.verdict, "moduleMismatch");
check("a module mismatch skips the outlines", !modules.narrow);

const pressure = classify(spur(12, 2), spur(24, 2, 25), [0, 0], [36, 0], 0, matePhase(0, 12, 0, 24));
eq("pressure angles differ", pressure.verdict, "pressureMismatch");

const close = classify(spur(24, 1), spur(24, 1), [0, 0], [24 - 0.25, 0], 0, matePhase(0, 24, 0, 24));
eq("inside the backlash", close.verdict, "tooClose");
check("too close still compares outlines", close.narrow);

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
  eq("model_check rows", rows, [{ a: "pin", b: "wheel", names: ["Pinion", "Wheel"], verdict: "meshing", narrow: true, hit: false }]);
}

const root = gearSpec(12, 2, [0, 0, 0]);
const tree: ModelTree = newTree("k", { kind: "primitive", solid: root }, "Pinion", null);
const found = gearsInTree(tree, IDENTITY_POSE, "pin", "Pinion");
eq("a root gear is the object's own", found.map((gear) => [gear.objectId, gear.step, gear.label, gear.spur.teeth]), [["pin", null, "Pinion", 12]]);

eq("the sentences", [verdictSentence("Wheel", "apart"), verdictSentence("Wheel", "toothOnTooth"), verdictSentence("Wheel", "moduleMismatch")], ["Clear of Wheel.", "Teeth cross Wheel.", "Module does not match Wheel."]);

if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("gear-pair: ok");
