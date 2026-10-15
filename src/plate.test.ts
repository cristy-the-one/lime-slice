import { encode3mf, ID_MATRIX, offBed, rotZ } from "./mesh-place.ts";
import { nextSplitAt } from "./split-at.ts";
import {
  addedCopy,
  assemblePlate,
  meshSeat,
  addedMesh,
  addedSplit,
  objectMarks,
  arrangeBoxes,
  arrangedObjects,
  boundsSize,
  boxesOverlapXY,
  meshToModel,
  oneObjectPlate,
  overlapPairs,
  placeObject,
  plateFileIsVersion2,
  plateListed,
  plateObjectPositions,
  platePlacedPositions,
  plateUnionBounds,
  readPlateSettings,
  revivePlate,
  setMeshSeat,
  slicePlateFields,
  snapPlate,
  withModelPose,
  type IncomingMesh,
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
    reinforcement: [],
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
const spaced = arrangedObjects(copied!.objects, bed, bed, 35).map((obj) => placeObject(obj, bed, bed).bounds);
check("arrange leaves the gap it is given", Math.abs(spaced[1]!.min[0] - spaced[0]!.max[0] - 35) < 0.01 || Math.abs(spaced[1]!.min[1] - spaced[0]!.max[1] - 35) < 0.01);
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
check("on a belt a box past the bed in X, Y, and Z is not a bed warning, only a width over the belt is", offBed({ min: [0, -300, 0], max: [20, 900, 900] }, 200, 200, 250, true).length === 0 && offBed({ min: [0, 0, 0], max: [260, 10, 10] }, 200, 200, 250, true).join() === "wider than the belt");
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

check("a plain solid has no mark line", objectMarks(left) === "");
check("support angle is not a mark", objectMarks({ ...left, settings: { supportAngle: 40 } }) === "");
const marked = {
  ...left,
  supportPaint: [{ kind: "block" as const, p: [0, 0, 0] as [number, number, number], n: [0, 0, 1] as [number, number, number], r: 3 }],
  seamPaint: [{ p: [1, 0, 0] as [number, number, number], n: [0, 1, 0] as [number, number, number], r: 2 }],
  settings: { supports: false, infill: 0.2, walls: 4, speed: 80 },
};
check(
  "marks name paint, seam, supports, infill, walls, and speed",
  objectMarks(marked) === "paint · seam · supports off · infill 20% · walls 4 · speed 80",
  objectMarks(marked),
);
const reinforcedMark = {
  ...left,
  reinforcement: [{ kind: "paint" as const, density: 1, depthMm: 5, disks: [{ p: [0, 0, 0] as [number, number, number], n: [0, 0, 1] as [number, number, number], r: 3 }] }],
};
check("marks include reinforce when non-empty", objectMarks(reinforcedMark) === "reinforce", objectMarks(reinforcedMark));
check("one object with reinforcement is version 2", plateFileIsVersion2([{ reinforcement: reinforcedMark.reinforcement }]));
check("supports on is not a mark", objectMarks({ ...left, settings: { supports: true, walls: 4 } }) === "walls 4");
check("a copy keeps the marks", objectMarks(addedCopy({ objects: [marked], selectedId: marked.id })!.objects[1]!) === objectMarks(marked));
check("clearing the facts clears the line", objectMarks({ ...marked, supportPaint: [], seamPaint: [], settings: {} }) === "");
check("a whole-millimeter size drops its decimal", boundsSize({ min: [0, 0, 0], max: [20, 20.04, 20] }) === "20 × 20 × 20", boundsSize({ min: [0, 0, 0], max: [20, 20.04, 20] }));
check("a fractional size keeps one decimal", boundsSize({ min: [1, 2, 0], max: [31.5, 12, 7.25] }) === "30.5 × 10 × 7.3", boundsSize({ min: [1, 2, 0], max: [31.5, 12, 7.25] }));

const firstMesh = object(20, "part", true);
firstMesh.fileName = "cube.stl";
firstMesh.name = "cube.stl";
const secondMesh = object(10, "ledge", false, { x: 40, y: 0, z: 0 });
secondMesh.fileName = "ledge.stl";
secondMesh.name = "ledge.stl";
secondMesh.partScale = 0.5;
secondMesh.settings = { walls: 3 };
const picked = addedCopy({ objects: [firstMesh, secondMesh], selectedId: "ledge" });
const solid = new ArrayBuffer(4);
new Uint8Array(solid).set([1, 2, 3, 4]);
firstMesh.brep = solid;
const copiedSolid = addedCopy({ objects: [firstMesh], selectedId: firstMesh.id });
check(
  "duplicate copies the solid and does not share its bytes",
  copiedSolid?.objects[1]?.brep?.byteLength === 4 && copiedSolid.objects[1].brep !== solid && new Uint8Array(copiedSolid.objects[1].brep!)[0] === 1,
);
check(
  "duplicate copies the selected mesh, not the first",
  picked?.objects[2]?.fileName === "ledge.stl" && picked.objects[2].sourcePos === secondMesh.sourcePos && picked.objects[2].partScale === 0.5 && picked.objects[2].settings.walls === 3,
);
check("duplicate leaves the other object", picked?.objects[0]?.fileName === "cube.stl" && picked.objects[0].sourcePos === firstMesh.sourcePos);
check("duplicate selects the copy", picked?.selectedId === picked?.objects[2]?.id);
check("nothing selected copies nothing", addedCopy({ objects: [firstMesh, secondMesh], selectedId: null }) === null);
const painted = {
  ...secondMesh,
  supportPaint: [{ kind: "block" as const, p: [0, 0, 0] as [number, number, number], n: [0, 0, 1] as [number, number, number], r: 1 }],
};
const copiedPaint = addedCopy({ objects: [painted], selectedId: painted.id })!;
copiedPaint.objects[1]!.supportPaint[0]!.r = 9;
check("a copy's paint is its own", painted.supportPaint[0]!.r === 1);

const incoming = (name: string, source: Float32Array, stepTolerance = 0.1): IncomingMesh => ({
  name,
  fileName: name,
  bytes: new ArrayBuffer(4),
  sourcePos: source,
  stepTolerance,
});
const atOrigin = object(20, "a", false, { x: 0, y: 0, z: 0 });
atOrigin.name = "cube.stl";
const parked = addedMesh({ objects: [atOrigin], selectedId: "a" }, incoming("cube.stl", cube(20), 0.05), bed, bed);
const parkedBounds = placeObject(parked!.objects[1]!, bed, bed).bounds;
check("a new part sits one gap to the right of a part at the origin", near(parkedBounds.min[0], 22) && near(parkedBounds.min[1], 0) && near(parkedBounds.min[2], 0));
check("the part already on the bed stays put", parked!.objects[0] === atOrigin);
check("the new part is selected", parked!.selectedId === parked!.objects[1]!.id && parked!.selectedId !== "a");
check("a repeated file name is numbered and the file name stays the file's", parked!.objects[1]!.name === "cube.stl 2" && parked!.objects[1]!.fileName === "cube.stl");
check("a new part is unscaled, unturned, and has no overrides", parked!.objects[1]!.partScale === 1 && parked!.objects[1]!.orient.every((value, index) => value === ID_MATRIX[index]) && Object.keys(parked!.objects[1]!.settings).length === 0);
check("the new part keeps the tolerance it was read with", parked!.objects[1]!.stepTolerance === 0.05);
check("the new part's mesh is not the one already there", parked!.objects[1]!.sourcePos !== atOrigin.sourcePos);
const revivedNew = revivePlate(snapPlate(parked!));
check("undo keeps the new part's own mesh", revivedNew?.objects[1]?.fileName === "cube.stl" && revivedNew.objects[1].sourcePos === parked!.objects[1]!.sourcePos);

const corner = addedMesh({ objects: [firstMesh], selectedId: "part" }, incoming("off.stl", cube(20)), bed, bed);
const cornerBounds = placeObject(corner!.objects[1]!, bed, bed).bounds;
check("a centered part leaves the corner free", near(cornerBounds.min[0], 0) && near(cornerBounds.min[1], 0));
check("the centered part is not moved", corner!.objects[0]!.centered && corner!.objects[0]!.offset.x === 0);
check("the new part clears the one already there", !boxesOverlapXY(placeObject(corner!.objects[0]!, bed, bed).bounds, cornerBounds));

const lifted = cube(10);
for (let i = 2; i < lifted.length; i += 3) lifted[i] += 5;
for (let i = 0; i < lifted.length; i += 3) lifted[i] -= 50;
const laid = addedMesh({ objects: [firstMesh], selectedId: "part" }, incoming("lifted.stl", lifted), bed, bed);
const laidBounds = placeObject(laid!.objects[1]!, bed, bed).bounds;
check("a mesh that loads off the bed is laid on it", near(laidBounds.min[0], 0) && near(laidBounds.min[2], 0), JSON.stringify(laidBounds));

const crowded = addedMesh({ objects: [atOrigin], selectedId: "a" }, incoming("wide.stl", cube(20)), 30, 30);
const crowdedBounds = placeObject(crowded!.objects[1]!, 30, 30).bounds;
check("a crowded bed still gets the part, past the edge", near(crowdedBounds.min[0], 22) && near(crowdedBounds.min[1], 0));
const row2 = object(20, "b", false, { x: 22, y: 0, z: 0 });
const wrapped = addedMesh({ objects: [atOrigin, row2], selectedId: "a" }, incoming("third.stl", cube(20)), 50, 50);
const wrappedBounds = placeObject(wrapped!.objects[2]!, 50, 50).bounds;
check("the next part wraps to a new row when the first row is full", near(wrappedBounds.min[0], 0) && near(wrappedBounds.min[1], 22));
check("an empty plate cannot gain a part this way", addedMesh({ objects: [], selectedId: null }, incoming("nope.stl", cube(10)), bed, bed) === null);

// A 220 mm plate on a 250 mm belt, cut on the top face. Parking the 0.1 mm
// sliver beside the plate is the ~440 mm span the belt width check reported.
const skadis = object(220, "part", true);
skadis.name = "Skadis_Raster";
skadis.fileName = "Skadis_Raster.stl";
skadis.sourcePos = new Float32Array([0, 0, 0, 220, 0, 0, 0, 220, 5]);
const sliver = incoming("Skadis_Raster split", new Float32Array([0.55, 0.55, 0, 219.45, 0.55, 0, 0.55, 219.45, 0.1]));
const belt = 250;
const skadisPlate = { objects: [skadis], selectedId: "part" };
const parkedSliver = addedMesh(skadisPlate, sliver, belt, belt)!;
const parkedWidth = plateUnionBounds(parkedSliver.objects, belt, belt)!;
check(
  "parking the sliver beside the plate spans about 440 mm",
  parkedWidth.max[0] - parkedWidth.min[0] > 400,
  String(parkedWidth.max[0] - parkedWidth.min[0]),
);
const splitPlate = addedSplit(skadisPlate, sliver)!;
const splitWidth = plateUnionBounds(splitPlate.objects, belt, belt)!;
check(
  "a split half stays on the plate instead of doubling the span",
  splitWidth.max[0] - splitWidth.min[0] < 250 && splitWidth.max[0] - splitWidth.min[0] > 200,
  String(splitWidth.max[0] - splitWidth.min[0]),
);
check("the split keeps its name when that name is free", splitPlate.objects[1]?.name === "Skadis_Raster split");
check("the kept piece stays selected", splitPlate.selectedId === "part");
check("the half uses the parent's centering", splitPlate.objects[1]?.centered === true);
check("nothing selected cannot gain a split half", addedSplit({ objects: [skadis], selectedId: null }, sliver) === null);

const joined = platePlacedPositions([atOrigin, object(10, "shift", false, { x: 40, y: 0, z: 0 })], bed, bed);
const model = new TextDecoder().decode(encode3mf(joined));
check("a plate 3mf has every part's triangles", (model.match(/<triangle /g) ?? []).length === joined.length / 9 && joined.length / 9 === 4);
check("a plate 3mf deduplicates shared vertices", (model.match(/<vertex /g) ?? []).length < (joined.length / 3));
check("a plate 3mf keeps the second part's place", model.includes('x="40"'));
const separate = plateObjectPositions([atOrigin, object(10, "shift", false, { x: 40, y: 0, z: 0 })], bed, bed);
const multiModel = new TextDecoder().decode(encode3mf(separate));
check("a multi-object 3mf stores one object and build item per part", (multiModel.match(/<object /g) ?? []).length === 2 && (multiModel.match(/<item /g) ?? []).length === 2);

check("an object may store painted-only supports", JSON.stringify(readPlateSettings({ supports: true, supportSource: "paint" })) === JSON.stringify({ supports: true, supportSource: "paint" }));
check("an object's support source must be auto or paint", readPlateSettings({ supportSource: "everywhere" }) === "This project file is incomplete.");

// Model space: a pose of its own, apart from the plate.
const turnedPose = { m: rotZ(90), t: [100, 0, 5] as [number, number, number] };
const posedParent = { ...object(20, "part", false, { x: 30, y: 40, z: 0 }), modelPose: turnedPose };
const posedSplit = addedSplit({ objects: [posedParent], selectedId: "part" }, incoming("part split", cube(10)))!;
check("a split piece inherits its parent's model pose", posedSplit.objects[1]?.modelPose === turnedPose);
check("a split piece of a part with no pose has none", addedSplit({ objects: [object(20, "part", false)], selectedId: "part" }, incoming("p", cube(10)))!.objects[1]?.modelPose === undefined);
const plainCopy = addedCopy({ objects: [object(20, "part", false)], selectedId: "part" })!.objects[1]!;
check("a copy sits its own width plus 10 mm along model X", JSON.stringify(plainCopy.modelPose) === JSON.stringify({ m: [...ID_MATRIX], t: [30, 0, 0] }));
const turnedCopy = addedCopy({ objects: [posedParent], selectedId: "part" })!.objects[1]!;
check("a copy of a turned part keeps the turn and steps along model X", JSON.stringify(turnedCopy.modelPose?.m) === JSON.stringify(turnedPose.m) && near(turnedCopy.modelPose!.t[0], 130, 1e-6) && turnedCopy.modelPose!.t[1] === 0);
check("a copy keeps its plate pose", JSON.stringify([turnedCopy.offset, turnedCopy.orient]) === JSON.stringify([posedParent.offset, posedParent.orient]));
const unmoved = object(20, "part", false);
const movedPlate = withModelPose({ objects: [unmoved], selectedId: "part" }, "part", { m: [...ID_MATRIX], t: [10, 0, 0] });
const movedObj = movedPlate.objects[0]!;
check("a model-space move leaves the plate pose and the mesh alone", movedObj.offset === unmoved.offset && movedObj.orient === unmoved.orient && movedObj.bytes === unmoved.bytes && movedObj.sourcePos === unmoved.sourcePos);
check("identity drops the key", !("modelPose" in withModelPose(movedPlate, "part", { m: [...ID_MATRIX], t: [0, 0, 0] }).objects[0]!));
const posedSnap = snapPlate({ objects: [posedParent], selectedId: "part" });
check("a Prepare step keeps the model pose", revivePlate(posedSnap)?.objects[0]?.modelPose === turnedPose);
check("one object with a model pose is a version 2 file", plateFileIsVersion2([{ modelPose: turnedPose }]) && !plateFileIsVersion2([{}]));
const record = { name: "p.step", bytesBase64: "", byteLength: 0, hash: "" };
const fileRow = (bytes: ArrayBuffer, extra: object) => ({
  id: "part", name: "p", mesh: { ...record, name: "p.stl" }, supportEdits: [], bytes, sourcePos: cube(10),
  placement: { orient: [...ID_MATRIX] as typeof ID_MATRIX, scale: 1, centered: false, offset: { x: 0, y: 0, z: 0 }, stepTolerance: 0.1 }, ...extra,
});
const oldSolid = new ArrayBuffer(4);
setMeshSeat(oldSolid, 0);
assemblePlate([fileRow(oldSolid, { brep: record })]);
check("a solid's mesh from a file saved before seats has an unknown seat, for Model to learn", meshSeat(oldSolid) === undefined);
const newSolid = new ArrayBuffer(4);
setMeshSeat(newSolid, 0);
assemblePlate([fileRow(newSolid, { brep: record, meshSeatMm: 712.5 })]);
check("a saved seat is the seat", meshSeat(newSolid) === 712.5);
const oldStep = new ArrayBuffer(4);
setMeshSeat(oldStep, 712.5);
assemblePlate([{ ...fileRow(oldStep, { brep: record }), mesh: { ...record, name: "p.step" } }]);
check("a STEP mesh keeps the seat the slicer's reader gave it, even from an old file", meshSeat(oldStep) === 712.5);
const plainStl = new ArrayBuffer(4);
setMeshSeat(plainStl, -3);
assemblePlate([fileRow(plainStl, {})]);
check("a plain mesh keeps the seat it was read with", meshSeat(plainStl) === -3);
const raisedObj = object(20, "part", false);
setMeshSeat(raisedObj.bytes, 712);
check("an object's mesh goes up by its seat before its pose", JSON.stringify(meshToModel(raisedObj).t) === JSON.stringify([0, 0, 712]));

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("plate: overlap, arrange, undo snap, and slice adapter ok");
