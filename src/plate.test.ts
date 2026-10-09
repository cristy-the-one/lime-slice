import { ID_MATRIX, offBed } from "./mesh-place.ts";
import { nextSplitAt } from "./split-at.ts";
import {
  addedCopy,
  arrangeBoxes,
  arrangedObjects,
  boxesOverlapXY,
  oneObjectPlate,
  overlapPairs,
  placeObject,
  plateFileIsVersion2,
  plateListed,
  plateUnionBounds,
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
    supportPaint: [],
    seamPaint: [],
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
  supportPaint: [],
  seamPaint: [],
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

check("one object without settings sends today's body", !plateListed(plate));
check("two objects send objects", plateListed(copied!));
check("one object with its own settings sends objects", plateListed({ objects: [{ ...left, settings: { supports: false } }], selectedId: "part" }));
const shoved = object(20, "wide", false, { x: 250, y: 0, z: 0 });
check("a box past the bed warns in X", offBed(placeObject(shoved, bed, bed).bounds, bed, bed, 250).includes("outside the bed in X"));
const prune = { id: 1, edit: { kind: "prune", sites: [{ xy: [1, 2], z: 3 }] } } as unknown as PlateObject["supportEdits"][number];
const edited = arranged.map((obj, i) => (i === 0 ? { ...obj, supportEdits: [prune], settings: { supportAngle: 50 } } : obj));
const sent = slicePlateFields(edited, (obj) => placeObject(obj, bed, bed).pose, { supports: true, supportStyle: "tree" }).objects;
check("each object carries its id and its own pose", sent.map((o) => o.id).join() === "part,obj-1" && sent[0]!.pose.translation[0] !== sent[1]!.pose.translation[0], JSON.stringify(sent.map((o) => o.id)));
check("a mesh named step is sent as its tessellated STL", slicePlateFields([{ ...left, fileName: "cover.step" }], (obj) => placeObject(obj, bed, bed).pose, { supports: false, supportStyle: "tree" }).objects[0]!.filename === "cover.stl");
check("settings and edits go only with the object that has them", JSON.stringify(sent[0]!.settings) === '{"supportAngle":50}' && sent[0]!.supportEdits?.length === 1 && !("settings" in sent[1]!) && !("supportEdits" in sent[1]!));
const gridded = slicePlateFields(edited, (obj) => placeObject(obj, bed, bed).pose, { supports: true, supportStyle: "grid" }).objects;
check("edits stay home without tree supports", !("supportEdits" in gridded[0]!));
check("no mesh bytes ride in the request yet", sent.every((o) => !("dataB64" in o)));
check("one object with no settings stays version 1", !plateFileIsVersion2([{ settings: {} }]) && !plateFileIsVersion2([{}]));
check("two objects are version 2", plateFileIsVersion2([{ settings: {} }, { settings: {} }]));
check("one object with settings is version 2", plateFileIsVersion2([{ settings: { supports: true } }]));

// By region is one plane across the plate, so its extent is every object, not the selected one.
const apart = [object(20, "a", false, { x: 26.9, y: 10, z: 0 }), object(20, "b", false, { x: 51.4, y: 30, z: 0 })];
const union = plateUnionBounds(apart, bed, bed)!;
check("the union spans every object", near(union.min[0], 26.9) && near(union.max[0], 71.4) && near(union.min[1], 10) && near(union.max[1], 50), JSON.stringify(union));
check("one object's union is its own bounds", JSON.stringify(plateUnionBounds([apart[0]!], bed, bed)) === JSON.stringify(placeObject(apart[0]!, bed, bed).bounds));
check("no objects have no union", plateUnionBounds([], bed, bed) === null);
check("a custom split between two objects survives a move", nextSplitAt("transform", 56.8, union, "x", true) === 56.8);
check("one object's bounds would pull that split to its own midpoint", nextSplitAt("transform", 56.8, placeObject(apart[0]!, bed, bed).bounds, "x", true) === 36.9);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("plate: overlap, arrange, undo snap, and slice adapter ok");
