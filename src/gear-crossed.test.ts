/**
 * Gear kinds, stage 4 (docs/plan-gear-kinds.md): bevel gears and worms are not covered, and gears whose axes cross say so
 * in one sentence instead of nothing. Two spur gears at a right angle within reach are refused with the angle; the same
 * pair out of reach, or on parallel axes, says nothing of it; Couple gears gives neither a hinge.
 */
import { solveAssembly, type Assembly } from "./assembly.ts";
import { placeGear, type WorldGear } from "./gear-pair.ts";
import { crossedNotes, crossedSentence, findCouplings, prepareTrain, type GearPart } from "./gear-train.ts";
import type { Affine } from "./model-space.ts";
import type { PrimitiveSpec } from "./model-primitive.ts";

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const left = JSON.stringify(got);
  const right = JSON.stringify(want);
  if (left === right) return;
  failed += 1;
  console.error(`FAIL ${name}\n  got  ${left}\n  want ${right}`);
}

const spec = (teeth: number, turn: [number, number, number] = [0, 0, 0]): PrimitiveSpec => ({ primitive: "gear", origin: [0, 0, 0], size: [0, 0, 0], radius: 0, height: 6, turn, teeth, module: 1 });
const at = (x: number, y = 0, z = 0): Affine => ({ m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [x, y, z] });
// A 20-tooth gear flat on the plate, and a 20-tooth gear stood on its edge (turned 90 degrees about X) beside it, the way a
// bevel pair stands: their axes cross at a right angle and their teeth reach each other.
const flat = placeGear(spec(20), at(0), "a", "Flat", null)!;
const standing = (x: number) => placeGear({ ...spec(20, [90, 0, 0]), origin: [0, 3, 0] }, at(x, 0, 14), "b", "Standing", null)!;

eq("crossed within reach: one sentence with the angle", crossedSentence(flat, standing(12)), "Flat and Standing are not coupled: their axes cross at 90°, and bevel gears and worms are not covered.");
eq("crossed out of reach: nothing", crossedSentence(flat, standing(200)), null);
eq("parallel axes: nothing here", crossedSentence(flat, placeGear(spec(20), at(20), "c", "Beside", null)!), null);
eq("a 30-degree skew says 30", crossedSentence(flat, placeGear({ ...spec(20, [30, 0, 0]) }, at(5, 0, 8), "d", "Skew", null)!)?.match(/\d+°/)?.[0], "30°");

// In an assembly, the pair is refused with that sentence; Couple gears on free gears gives neither a hinge and says why.
{
  const assembly: Assembly = { id: "x", name: "X", members: [
    { object: "frame", parent: null, offset: [0, 0, 0], turn: [0, 0, 0] },
    { object: "a", parent: "frame", offset: [0, 0, 0], turn: [0, 0, 0], joint: { kind: "hinge", pivot: [0, 0, 3], axis: [0, 0, 1], angle: 0 } },
    { object: "b", parent: "frame", offset: [12, 0, 14], turn: [0, 0, 0], joint: { kind: "hinge", pivot: [0, 0, 0], axis: [0, 1, 0], angle: 0 } },
  ] };
  const poses: Record<string, Affine> = { frame: at(0), a: at(0), b: at(12, 0, 14) };
  const solved = solveAssembly(assembly, (id) => poses[id]).poses;
  const gearsAt = (map: ReadonlyMap<string, Affine>): WorldGear[] => [map.get("a") ? placeGear(spec(20), map.get("a")!, "a", "Flat", null)! : null, map.get("b") ? placeGear({ ...spec(20, [90, 0, 0]), origin: [0, 3, 0] }, map.get("b")!, "b", "Standing", null)! : null].filter((gear): gear is WorldGear => !!gear);
  const found = findCouplings(assembly, gearsAt(solved), solved);
  eq("an assembly's crossed pair is said, not coupled", [found.couplings.length, found.notCoupled.map((row) => row.reason)], [0, ["Flat and Standing are not coupled: their axes cross at 90°, and bevel gears and worms are not covered."]]);
  const parts: GearPart[] = [{ id: "a", name: "Flat", pose: at(0), gears: [flat] }, { id: "b", name: "Standing", pose: at(12, 0, 14), gears: [standing(12)] }];
  const prepared = prepareTrain([], parts, "a", (id) => poses[id], "asm_1");
  eq("Couple gears makes nothing of a crossed pair", [prepared.assembly, prepared.hinged], [null, []]);
  eq("and the note says why", crossedNotes(parts.flatMap((part) => part.gears), "a"), ["Flat and Standing are not coupled: their axes cross at 90°, and bevel gears and worms are not covered."]);
}

if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("gear-crossed: all passed");
