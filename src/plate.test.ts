import { ID_MATRIX } from "./mesh-place.ts";
import {
  addedCopy,
  arrangeBoxes,
  arrangedObjects,
  boxesOverlapXY,
  oneObjectPlate,
  overlapPairs,
  placeObject,
  plateFileIsVersion2,
  revivePlate,
  slicePlateFields,
  snapPlate,
  type PlateObject,
} from "./plate.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

function near(actual: number, expected: number, eps = 0.05): boolean {
  return Math.abs(actual - expected) <= eps;
}

function cube(size: number): Float32Array {
  return new Float32Array([
    0, 0, 0, size, 0, 0, 0, size, 0,
    0, 0, 0, size, 0, 0, 0, 0, size,
  ]);
}

function object(size: number, id: string, centered: boolean, offset = { x: 0, y: 0, z: 0 }): PlateObject {
  const bytes = new ArrayBuffer(8);
  return {
    id,
    name: id,
    fileName: `${id}.stl`,
    bytes,
    sourcePos: cube(size),
    orient: [...ID_MATRIX],
    partScale: 1,
    centered,
    offset,
    stepTolerance: 0.1,
    supportEdits: [],
    settings: {},
  };
}

const bed = 220;
const left = object(20, "part", true);
const right = object(20, "obj-2", true);
const same = placeObject(left, bed, bed).bounds;
const other = placeObject(right, bed, bed).bounds;
check("two centered copies overlap", boxesOverlapXY(same, other));
check(
  "the overlap line names both objects",
  overlapPairs([
    { id: left.id, name: "cube", bounds: same },
    { id: right.id, name: "cube 2", bounds: other },
  ])[0]?.line === "cube overlaps cube 2",
);

const touching = { min: [20, 0, 0] as [number, number, number], max: [40, 20, 20] as [number, number, number] };
const origin = { min: [0, 0, 0] as [number, number, number], max: [20, 20, 20] as [number, number, number] };
check("faces that only touch are not an overlap", !boxesOverlapXY(origin, touching));
const beside = { min: [30, 0, 0] as [number, number, number], max: [50, 20, 10] as [number, number, number] };
check("separated boxes are not an overlap", !boxesOverlapXY(origin, beside));

const plate = oneObjectPlate({
  name: "cube.stl",
  fileName: "cube.stl",
  bytes: left.bytes,
  sourcePos: left.sourcePos,
  orient: left.orient,
  partScale: 1,
  centered: true,
  offset: { x: 0, y: 0, z: 0 },
  stepTolerance: 0.1,
  supportEdits: [],
});
const copied = addedCopy(plate);
check("add selects the copy", copied?.selectedId !== "part" && copied?.objects.length === 2);
const arranged = arrangedObjects(copied!.objects, bed, bed);
const bounds = arranged.map((obj) => placeObject(obj, bed, bed).bounds);
check("arrange clears the overlap", !boxesOverlapXY(bounds[0]!, bounds[1]!));
for (const box of bounds) {
  check("arranged boxes stay inside the bed", box.min[0] >= -0.05 && box.min[1] >= -0.05 && box.max[0] <= bed + 0.05 && box.max[1] <= bed + 0.05, JSON.stringify(box));
}
check("arrange does not rotate", arranged.every((obj) => obj.orient.every((value, index) => value === ID_MATRIX[index])));
check("the first box starts at the left edge", near(bounds[0]!.min[0], 0) && near(bounds[0]!.min[1], 0));
check("the second box sits one gap to the right", near(bounds[1]!.min[0], 22) && near(bounds[1]!.min[1], 0));

const wide = arrangeBoxes([
  { id: "a", minX: 0, minY: 0, maxX: 100, maxY: 20 },
  { id: "b", minX: 0, minY: 0, maxX: 100, maxY: 20 },
  { id: "c", minX: 0, minY: 0, maxX: 100, maxY: 20 },
], 220);
check("a row wraps before it leaves the bed", wide[0]?.minX === 0 && wide[1]?.minX === 102 && wide[2]?.minX === 0 && wide[2]?.minY === 22);
const packed = wide.map((move) => {
  const width = 100;
  const height = 20;
  return move.minX >= -0.05 && move.minY >= -0.05 && move.minX + width <= 220.05 && move.minY + height <= 220.05;
});
check("wrapped boxes stay inside the bed", packed.every(Boolean));

const snap = snapPlate({ objects: arranged, selectedId: arranged[1]!.id });
const revived = revivePlate(snap);
check("undo can restore the arranged plate", revived?.objects.length === 2 && revived.selectedId === arranged[1]!.id);
check("the restored offset matches", near(revived!.objects[1]!.offset.x, arranged[1]!.offset.x));

check("the slice adapter adds no fields", Object.keys(slicePlateFields({ objects: arranged, selectedId: "part" })).length === 0);
check("one object with no settings stays version 1", !plateFileIsVersion2([{ settings: {} }]) && !plateFileIsVersion2([{}]));
check("two objects are version 2", plateFileIsVersion2([{ settings: {} }, { settings: {} }]));
check("one object with settings is version 2", plateFileIsVersion2([{ settings: { supports: true } }]));

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("plate: overlap, arrange, undo snap, and slice adapter ok");
