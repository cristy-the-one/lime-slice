import { boundsOf, ID_MATRIX, rotZ, type Mat3 } from "./mesh-place.ts";
import { contextParts, partBox } from "./model-context.ts";
import type { PlateObject } from "./plate.ts";

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

function object(id: string, size: number, x: number, y: number, orient: Mat3 = ID_MATRIX, partScale = 1): PlateObject {
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
  };
}

const solidBox = { min: [5, 7, 3] as [number, number, number], max: [25, 27, 23] as [number, number, number] };

function boxIn(objects: PlateObject[], openId: string, id: string) {
  const part = contextParts(objects, openId, solidBox, 220, 220).find((item) => item.id === id);
  return part ? partBox(boundsOf(part.positions), part.matrix) : null;
}

const a = object("part", 20, 50, 60);
const b = object("obj-2", 10, 80, 60);
const beside = boxIn([a, b], "part", "obj-2")!;
sameBox("an object 30 mm to the right on the bed sits 30 mm to the right of the open solid", beside, [35, 7, 3], [45, 17, 13]);

const flipped = boxIn([a, b], "obj-2", "part")!;
sameBox("opening the other object puts the first 30 mm to the left of it", flipped, [-25, 7, 3], [-5, 27, 23]);

check("the open object is never its own context", contextParts([a, b], "part", solidBox, 220, 220).every((part) => part.id !== "part"));
check("one object on the plate has no context", contextParts([a], "part", solidBox, 220, 220).length === 0);
check("an unknown open object has no context", contextParts([a, b], "missing", solidBox, 220, 220).length === 0);
check("a part keeps the source array it was built from", contextParts([a, b], "part", solidBox, 220, 220)[0]?.positions === b.sourcePos);

const turned = object("part", 20, 50, 60, rotZ(90));
sameBox("a quarter turn of the open object turns the offset with it", boxIn([turned, b], "part", "obj-2")!, [5, -13, 3], [15, -3, 13]);

const doubled = object("part", 10, 50, 60, ID_MATRIX, 2);
sameBox("a placement scale of 2 halves the neighbour in the solid's frame", boxIn([doubled, b], "part", "obj-2")!, [22.5, 9.5, 3], [27.5, 14.5, 8]);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("model context: plate pose into the open solid's frame ok");
