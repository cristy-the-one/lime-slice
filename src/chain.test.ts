import { ID_MATRIX, rotZ, type Mat3 } from "./mesh-place.ts";
import { heldPivotPose, placedBox } from "./pivot.ts";
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
  // The root already turned 90°: a mid joint locked at 0 in its parent's frame must stay straight on the root,
  // not snap to 0° on the bed.
  const held = heldPivotPose(mesh, [0, 0, 0], rows[0]!, { orient: rotZ(90), partScale: 1 }, bed.x, bed.y)!;
  const turned = solveDescendants(rows.map((obj) => (obj.id === "root" ? { ...obj, orient: rotZ(90), centered: held.centered, offset: held.offset } : obj)), "root", bed);
  const locked = turned.map((obj) => (obj.id === "mid" ? { ...obj, jointLimits: { z: [0, 0] as [number, number] } } : obj));
  const posed = solveIk(locked, "end", [-5, 15, 0], bed)!;
  const rootAt = pivotBed(posed[0]!, bed);
  const midAt = pivotBed(posed[1]!, bed);
  const endAt = pivotBed(posed[2]!, bed);
  const dir = (a: readonly number[], b: readonly number[]) => Math.atan2(b[1]! - a[1]!, b[0]! - a[0]!);
  check("a locked mid joint keeps the end in line with the first bone", Math.abs(dir(rootAt, midAt) - dir(midAt, endAt)) < 0.02, `bones at ${dir(rootAt, midAt)} and ${dir(midAt, endAt)}`);
}

{
  // A joint already outside its limit is not snapped back on the first step.
  const bent = rows.map((obj) => (obj.id === "root" ? { ...obj, jointLimits: { z: [-10, 10] as [number, number] } } : obj));
  const held = heldPivotPose(mesh, [0, 0, 0], bent[0]!, { orient: rotZ(45), partScale: 1 }, bed.x, bed.y)!;
  const out = solveDescendants(bent.map((obj) => (obj.id === "root" ? { ...obj, orient: rotZ(45), centered: held.centered, offset: held.offset } : obj)), "root", bed);
  const endBefore = pivotBed(out[2]!, bed);
  // A little further round: the root may not turn further out, and must not snap back to 10° either.
  const posed = solveIk(out, "end", [endBefore[0] - 0.5, endBefore[1] + 0.5, 0], bed)!;
  const rootAt = pivotBed(posed[0]!, bed);
  const midAt = pivotBed(posed[1]!, bed);
  const deg = (Math.atan2(midAt[1] - rootAt[1], midAt[0] - rootAt[0]) * 180) / Math.PI;
  check("a root bent past its limit holds where it is", Math.abs(deg - 45) < 0.5, `first bone at ${deg}°`);
}

{
  // A child at the 400% clamp grows less than its parent, so the joint on it moves by what it really grew.
  const big = rows.map((obj) => (obj.id === "mid" ? { ...obj, partScale: 3 } : obj));
  const grown = scaledDescendants(big, "root", 2);
  const mid = grown.find((obj) => obj.id === "mid")!;
  const end = grown.find((obj) => obj.id === "end")!;
  check("the clamped child stops at 400%", Math.abs(mid.partScale - 4) < 1e-9);
  near("its own link follows the root's full ratio", mid.chain!.offset, [20, 0, 0], 1e-6);
  near("the link on it follows its clamped ratio", end.chain!.offset, [10 * (4 / 3), 0, 0], 1e-6);
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
  const boxes = (list: readonly ChainObject[]) => list.map((obj) => placedBox(obj.sourcePos, obj.orient, obj.partScale, obj.centered, obj.offset, bed.x, bed.y));
  const maxOriginal = Math.max(...boxes(rows).map((b) => b.max[0]));
  const minCopy = Math.min(...boxes(clones).map((b) => b.min[0]));
  check("the copied parts sit clear of the original parts, not just their pivots", minCopy >= maxOriginal + 7.9, `copy starts at ${minCopy}, original ends at ${maxOriginal}`);
  // Pivots stacked in one column: the pivot span on X is 0, the parts are 30 mm wide.
  const wide = (id: string, pivot: Vec3): ChainObject => ({ ...part(id, pivot), partScale: 30 });
  let stacked = [wide("s0", [0.5, 0.5, 0]), wide("s1", [0.5, 0.5, 1])];
  stacked = linkedTo(stacked, "s1", "s0", bed).objects;
  const stackCopy = duplicateChain(stacked, "s0", bed, () => `sc-${n++}`, copyName)!;
  const stackMax = Math.max(...boxes(stacked).map((b) => b.max[0]));
  const stackMin = Math.min(...boxes(stackCopy.objects.filter((obj) => obj.id.startsWith("sc-"))).map((b) => b.min[0]));
  check("a stacked chain's copy does not overlap it", stackMin >= stackMax + 7.9, `copy starts at ${stackMin}, original ends at ${stackMax}`);
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
