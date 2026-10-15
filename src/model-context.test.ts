import { boundsOf, ID_MATRIX, rotZ, type Mat3 } from "./mesh-place.ts";
import { affineRows, bedParts, contextParts } from "./model-context.ts";
import { boxUnder, type Affine } from "./model-space.ts";
import { setMeshSeat, type PlateObject } from "./plate.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

function sameBox(name: string, actual: { min: number[]; max: number[] }, min: number[], max: number[]): void {
  const close = (a: number[], b: number[]) => a.every((value, i) => Math.abs(value - b[i]!) < 1e-3);
  check(name, close(actual.min, min) && close(actual.max, max), `${JSON.stringify(actual)} vs ${JSON.stringify({ min, max })}`);
}

function cube(size: number): Float32Array {
  return new Float32Array([
    0, 0, 0, size, 0, 0, 0, size, 0,
    0, 0, 0, size, 0, 0, 0, 0, size,
    size, size, size, size, 0, 0, 0, size, 0,
  ]);
}

function object(id: string, size: number, x: number, y: number, orient: Mat3 = ID_MATRIX, partScale = 1, modelPose?: Affine): PlateObject {
  return {
    id,
    name: id,
    fileName: `${id}.stl`,
    bytes: new ArrayBuffer(8),
    sourcePos: cube(size),
    orient,
    partScale,
    centered: false,
    offset: { x, y, z: 0 },
    stepTolerance: 0.1,
    supportEdits: [],
    supportPaint: [],
    seamPaint: [],
    reinforcement: [],
    settings: {},
    ...(modelPose ? { modelPose } : {}),
  };
}

function boxIn(objects: PlateObject[], openId: string, id: string) {
  const part = contextParts(objects, openId).find((item) => item.id === id);
  return part ? boxUnder(boundsOf(part.positions), part.matrix) : null;
}

const a = object("part", 20, 50, 60);
const b = object("obj-2", 10, 80, 60);
sameBox("another object sits where its file put it, whatever the plate does", boxIn([a, b], "part", "obj-2")!, [0, 0, 0], [10, 10, 10]);
const shuffled = { ...b, offset: { x: 150, y: 10, z: 0 }, orient: rotZ(90), partScale: 2 };
sameBox("a plate move, turn, or scale leaves it in model space", boxIn([a, shuffled], "part", "obj-2")!, [0, 0, 0], [10, 10, 10]);

const raised = object("obj-3", 10, 0, 0);
setMeshSeat(raised.bytes, 712.5);
sameBox("a mesh lowered onto the bed goes back up by its seat", boxIn([a, raised], "part", "obj-3")!, [0, 0, 712.5], [10, 10, 722.5]);

const placed = object("obj-4", 10, 0, 0, ID_MATRIX, 1, { m: rotZ(90), t: [100, 0, 0] });
sameBox("an object's model pose places it", boxIn([a, placed], "part", "obj-4")!, [90, 0, 0], [100, 10, 10]);
const placedRaised = object("obj-5", 10, 0, 0, ID_MATRIX, 1, { m: [...ID_MATRIX], t: [0, 0, 5] });
setMeshSeat(placedRaised.bytes, 2);
sameBox("the seat comes first, then the pose", boxIn([a, placedRaised], "part", "obj-5")!, [0, 0, 7], [10, 10, 17]);

check("the open object is never its own context", contextParts([a, b], "part").every((part) => part.id !== "part"));
check("one object on the plate has no context", contextParts([a], "part").length === 0);
check("an unknown open object has no context", contextParts([a, b], "missing").length === 0);
check("a part keeps the source array it was built from", contextParts([a, b], "part")[0]?.positions === b.sourcePos);

function slab(): Float32Array {
  return new Float32Array([
    0, 0, 0, 20, 0, 0, 0, 10, 0,
    20, 10, 5, 20, 0, 0, 0, 10, 0,
  ]);
}

function bedBox(objects: PlateObject[], selectedId: string | null, id: string) {
  const part = bedParts(objects, selectedId, 220, 220).find((item) => item.id === id);
  return part ? boxUnder(boundsOf(part.positions), part.matrix) : null;
}

sameBox("the other object sits at its own bed pose", bedBox([a, b], "part", "obj-2")!, [80, 60, 0], [90, 70, 10]);
sameBox("selecting the second object makes the first the other one", bedBox([a, b], "obj-2", "part")!, [50, 60, 0], [70, 80, 20]);
check("the selected object is not among the bed parts", bedParts([a, b], "part", 220, 220).map((part) => part.id).join() === "obj-2");
check("one object on the plate has no bed parts", bedParts([a], "part", 220, 220).length === 0);
check("with nothing selected every object is a bed part", bedParts([a, b], null, 220, 220).length === 2);
check("a bed part keeps the source array it was built from", bedParts([a, b], "part", 220, 220)[0]?.positions === b.sourcePos);

const tall = { ...object("obj-3", 10, 100, 30, rotZ(90), 2), sourcePos: slab() };
sameBox("a quarter turn and a placement scale of 2 swap and double the slab's footprint", bedBox([a, tall], "part", "obj-3")!, [100, 15, 0], [120, 55, 10]);

check("affineRows lays a matrix out row by row with the shift last", affineRows({ m: [1, 2, 3, 4, 5, 6, 7, 8, 9], t: [10, 11, 12] }).join() === "1,2,3,10,4,5,6,11,7,8,9,12");

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("model context: other objects in model space, plate pose on the bed ok");
