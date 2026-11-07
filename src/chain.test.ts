import { ID_MATRIX, rotZ, type Mat3 } from "./mesh-place.ts";
import { heldPivotPose } from "./pivot.ts";
import {
  componentIds,
  copyName,
  duplicateChain,
  isChainLeaf,
  linkBetween,
  linkRefusal,
  linkedTo,
  pivotBed,
  readChain,
  readJointLimits,
  readPivot,
  removedChain,
  removedMember,
  saneChains,
  scaledDescendants,
  solveDescendants,
  solveIk,
  type ChainObject,
} from "./chain.ts";
import type { Vec3 } from "./pivot.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

function near(name: string, actual: readonly number[] | undefined, expected: readonly number[], tol = 0.05): void {
  const ok = !!actual && actual.length === expected.length && actual.every((value, index) => Math.abs(value - expected[index]!) <= tol);
  check(name, ok, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

function box(): Float32Array {
  const out: number[] = [];
  const corners = [
    [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
    [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
  ];
  const faces = [
    [0, 1, 2, 0, 2, 3],
    [4, 6, 5, 4, 7, 6],
    [0, 4, 5, 0, 5, 1],
    [1, 5, 6, 1, 6, 2],
    [2, 6, 7, 2, 7, 3],
    [3, 7, 4, 3, 4, 0],
  ];
  for (const face of faces) for (const index of face) out.push(...corners[index]!);
  return new Float32Array(out);
}

const mesh = box();
const bed = { x: 220, y: 220 };

function part(id: string, pivot: Vec3, offset: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 }): ChainObject {
  return {
    id,
    name: id,
    sourcePos: mesh,
    orient: [...ID_MATRIX] as Mat3,
    partScale: 1,
    centered: false,
    offset: { ...offset },
    pivot: [...pivot],
  };
}

let rows = [part("root", [0, 0, 0]), part("mid", [10, 0, 0]), part("end", [20, 0, 0])];
rows = linkedTo(rows, "mid", "root", bed).objects;
rows = linkedTo(rows, "end", "mid", bed).objects;

near("the mid pivot starts at 10", pivotBed(rows[1]!, bed), [10, 0, 0]);
near("the end pivot starts at 20", pivotBed(rows[2]!, bed), [20, 0, 0]);
check("the end is a leaf", isChainLeaf(rows, "end"));
check("the root is not a leaf", !isChainLeaf(rows, "root"));
check("a loop is refused", linkRefusal(rows, "root", "end") === "That link would make a loop.");
check("a part cannot link to itself", linkRefusal(rows, "mid", "mid") !== null);

{
  const root = { ...rows[0]!, offset: { x: 5, y: -2, z: 1 } };
  const moved = solveDescendants(rows.map((obj) => (obj.id === "root" ? root : obj)), "root", bed);
  near("a moved root carries the mid pivot", pivotBed(moved[1]!, bed), [15, -2, 1]);
  near("and the end pivot", pivotBed(moved[2]!, bed), [25, -2, 1]);
  check("the stored link is what the solve read", JSON.stringify(moved[1]!.chain!.offset) === JSON.stringify(rows[1]!.chain!.offset));
}

{
  const held = heldPivotPose(mesh, [0, 0, 0], rows[0]!, { orient: rotZ(90), partScale: 1 }, bed.x, bed.y)!;
  const turned = { ...rows[0]!, orient: rotZ(90), centered: held.centered, offset: held.offset };
  const swung = solveDescendants([turned, rows[1]!, rows[2]!], "root", bed);
  near("a quarter turn of the root swings the end up", pivotBed(swung[2]!, bed), [0, 20, 0], 0.2);
  near("the mid swings on the same arc", pivotBed(swung[1]!, bed), [0, 10, 0], 0.2);
}

{
  const held = heldPivotPose(mesh, [0, 0, 0], rows[0]!, { orient: rows[0]!.orient, partScale: 2 }, bed.x, bed.y)!;
  const grown = scaledDescendants(rows, "root", 2);
  const solved = solveDescendants(grown.map((obj) => (obj.id === "root" ? { ...obj, partScale: 2, centered: held.centered, offset: held.offset } : obj)), "root", bed);
  check("children scale with the root", Math.abs(solved[1]!.partScale - 2) < 1e-9 && Math.abs(solved[2]!.partScale - 2) < 1e-9);
  near("the end is twice as far", pivotBed(solved[2]!, bed), [40, 0, 0], 0.2);
}

{
  const target: Vec3 = [0, 20, 0];
  const posed = solveIk(rows, "end", target, bed);
  check("dragging the end solves", posed !== null);
  near("the end pivot reaches the target", pivotBed(posed![2]!, bed), target, 0.5);
  const rootAt = pivotBed(posed![0]!, bed);
  const midAt = pivotBed(posed![1]!, bed);
  const endAt = pivotBed(posed![2]!, bed);
  const bone = (a: Vec3, b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  check("the first bone keeps its length", Math.abs(bone(rootAt, midAt) - 10) < 0.2);
  check("the second bone keeps its length", Math.abs(bone(midAt, endAt) - 10) < 0.2);
  check("a free part is not an end", solveIk([rows[0]!], "root", target, bed) === null);
}

{
  const limited = rows.map((obj) => (obj.id === "root" ? { ...obj, jointLimits: { z: [0, 0] as [number, number] } } : obj));
  const posed = solveIk(limited, "end", [10, 10, 0], bed)!;
  near("a locked root stays put", pivotBed(posed[0]!, bed), [0, 0, 0], 0.05);
  near("the mid joint still brings the end around itself", pivotBed(posed[2]!, bed), [10, 10, 0], 0.6);
  check("limits round-trip through the reader", JSON.stringify(readJointLimits({ z: [0, 0], y: [1, 0] })) === JSON.stringify({ z: [0, 0] }));
}

{
  const one = removedMember(rows, "mid", bed);
  check("removing the mid leaves two", one.length === 2);
  const end = one.find((obj) => obj.id === "end")!;
  check("the end sits on the root", end.chain?.parent === "root");
  near("and it has not jumped", pivotBed(end, bed), [20, 0, 0], 0.05);
  check("removing the whole chain of a full plate is refused", removedChain(rows, "root") === null);
  const extra = part("other", [0, 40, 0]);
  const gone = removedChain([...rows, extra], "end");
  check("removing a chain keeps the part outside it", gone?.length === 1 && gone[0]!.id === "other");
}

{
  let n = 0;
  const copied = duplicateChain(rows, "end", bed, () => `copy-${n++}`, copyName);
  check("a chain duplicates as one", copied !== null && copied!.objects.length === 6);
  const clones = copied!.objects.filter((obj) => obj.id.startsWith("copy-"));
  check("the copy is its own chain", componentIds(copied!.objects, clones[2]!.id).length === 3);
  check("the copy does not still point at the original", clones.every((obj) => !obj.chain || obj.chain.parent.startsWith("copy-")));
  near("the copied end is shifted clear of the original", pivotBed(clones[2]!, bed), [48, 0, 0], 0.2);
  check("copy names grow", copyName("end", ["end", "end copy"]) === "end copy 2");
}

{
  const damaged = saneChains([
    part("a", [0, 0, 0]),
    { ...part("b", [5, 0, 0]), chain: linkBetween(part("missing", [0, 0, 0]), part("b", [5, 0, 0]), bed) },
  ]);
  check("a link to a missing parent is dropped", damaged[1]!.chain === undefined);
  check("a sound chain is the same array", saneChains(rows) === rows);
}

check("a chain row reads", readChain({ parent: "root", offset: [1, 2, 3], turn: [...ID_MATRIX] })?.parent === "root");
check("a damaged chain row is dropped", readChain({ parent: "root", offset: [1], turn: [...ID_MATRIX] }) === null);
check("a pivot reads", JSON.stringify(readPivot([1, 2, 3])) === JSON.stringify([1, 2, 3]));
check("a damaged pivot is dropped", readPivot([1, 2]) === undefined);

if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("chain tests passed");
