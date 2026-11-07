import { ID_MATRIX, placeMesh, rotZ, type Mat3 } from "./mesh-place.ts";
import {
  bedToSourcePoint,
  centreOf,
  heldPivotPose,
  offsetKeepingPoint,
  snapPivotPoint,
  sourceToBedPoint,
  usingCustomPivot,
} from "./pivot.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

function near(name: string, actual: readonly number[] | undefined, expected: readonly number[], tol = 1e-4): void {
  const ok = !!actual && actual.length === expected.length && actual.every((value, index) => Math.abs(value - expected[index]!) <= tol);
  check(name, ok, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

/** A closed box, two triangles a face. `min` is included, so a 20 mm cube from the origin is the calibration cube. */
function box(size: number): Float32Array {
  const x0 = 0;
  const y0 = 0;
  const z0 = 0;
  const x1 = size;
  const y1 = size;
  const z1 = size;
  const corners = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const faces = [
    [0, 1, 2, 0, 2, 3],
    [4, 6, 5, 4, 7, 6],
    [0, 4, 5, 0, 5, 1],
    [1, 5, 6, 1, 6, 2],
    [2, 6, 7, 2, 7, 3],
    [3, 7, 4, 3, 4, 0],
  ];
  const out: number[] = [];
  for (const face of faces) {
    for (const index of face) {
      const corner = corners[index]!;
      out.push(corner[0]!, corner[1]!, corner[2]!);
    }
  }
  return new Float32Array(out);
}

const source = box(20);
const centre = centreOf(source);
const bed = 220;
const turn = rotZ(90);

check("the cube's centre is its middle", centre[0] === 10 && centre[1] === 10 && centre[2] === 10);
check("no pivot is the centre path", usingCustomPivot(undefined, centre) === false);
check("the centre itself is the centre path", usingCustomPivot([10, 10, 10], centre) === false);
check("a corner is a custom pivot", usingCustomPivot([0, 0, 0], centre) === true);

{
  const placed = placeMesh(source, ID_MATRIX, 1, bed, bed, true);
  const again = placeMesh(source, ID_MATRIX, 1, bed, bed, true);
  check("placing twice is the same pose", JSON.stringify(placed.pose) === JSON.stringify(again.pose));
  const positions = placed.positions;
  let matched = true;
  for (let i = 0; i < source.length; i += 3) {
    const at = sourceToBedPoint(source, [source[i]!, source[i + 1]!, source[i + 2]!], ID_MATRIX, 1, true, { x: 0, y: 0, z: 0 }, bed, bed);
    if (Math.abs(at[0] - positions[i]!) > 1e-4 || Math.abs(at[1] - positions[i + 1]!) > 1e-4 || Math.abs(at[2] - positions[i + 2]!) > 1e-4) matched = false;
  }
  check("a source vertex lands on the placed mesh", matched);
}

{
  const before = placeMesh(source, ID_MATRIX, 1, bed, bed, false, { x: 4, y: -2, z: 0 });
  const held = heldPivotPose(
    source,
    undefined,
    { orient: ID_MATRIX, partScale: 1, centered: false, offset: { x: 4, y: -2, z: 0 } },
    { orient: turn, partScale: 1 },
    bed,
    bed,
  );
  check("a turn with no pivot leaves the offset alone", held === null);
  const after = placeMesh(source, turn, 1, bed, bed, false, { x: 4, y: -2, z: 0 });
  check("that turn still reports the bounds centre as the slicer pivot", JSON.stringify(after.pose.pivot) === JSON.stringify(before.pose.pivot));
}

{
  const pivot: [number, number, number] = [0, 0, 0];
  const offset = { x: 30, y: 12, z: 0 };
  const world = sourceToBedPoint(source, pivot, ID_MATRIX, 1, false, offset, bed, bed);
  const held = heldPivotPose(
    source,
    pivot,
    { orient: ID_MATRIX, partScale: 1, centered: false, offset },
    { orient: turn, partScale: 1 },
    bed,
    bed,
  );
  check("a custom pivot rewrites the offset", held !== null && held.centered === false);
  const landed = sourceToBedPoint(source, pivot, turn, 1, false, held!.offset, bed, bed);
  near("the corner stays where it was after a quarter turn", landed, world, 1e-3);
  const mesh = placeMesh(source, turn, 1, bed, bed, false, held!.offset);
  near("the slicer pivot stays the bounds centre", mesh.pose.pivot, centre, 1e-6);
  const back = bedToSourcePoint(source, world, turn, 1, false, held!.offset, bed, bed);
  near("the bed point reads back as the source corner", back, pivot, 1e-2);
}

{
  const pivot: [number, number, number] = [0, 0, 20];
  const offset = { x: 0, y: 0, z: 0 };
  const world = sourceToBedPoint(source, pivot, ID_MATRIX, 1, false, offset, bed, bed);
  const held = heldPivotPose(
    source,
    pivot,
    { orient: ID_MATRIX, partScale: 1, centered: false, offset },
    { orient: ID_MATRIX, partScale: 2 },
    bed,
    bed,
  );
  const landed = sourceToBedPoint(source, pivot, ID_MATRIX, 2, false, held!.offset, bed, bed);
  near("scale keeps the pivot", landed, world, 1e-2);
  const direct = offsetKeepingPoint(source, pivot, ID_MATRIX, 2, bed, bed, world);
  near("the kept offset is that shift", [direct.x, direct.y, direct.z], [held!.offset.x, held!.offset.y, held!.offset.z], 1e-6);
}

{
  const snapped = snapPivotPoint(source, [0.4, 0.2, 19.7], 1.5);
  near("a near corner snaps", snapped, [0, 0, 20], 1e-6);
  const free = snapPivotPoint(source, [3, 4, 5], 1);
  near("a point clear of every feature stays", free, [3, 4, 5], 1e-6);
  const vertex = snapPivotPoint(source, [10.2, 10.1, 10.2], 1, [[10, 10, 10]]);
  near("the centre wins over a far vertex", vertex, [10, 10, 10], 1e-6);
}

void (turn satisfies Mat3);

if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("pivot tests passed");
