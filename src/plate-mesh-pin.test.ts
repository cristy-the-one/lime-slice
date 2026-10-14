import { ID_MATRIX } from "./mesh-place.ts";
import {
  meshTokenOf,
  pinPlateMeshes,
  recallPlateMeshes,
  resetHeldGeometry,
  revivePlate,
  shareMeshToken,
  snapPlate,
  withBrepFor,
  withSelectedPose,
  type PlateObject,
  type PlateState,
} from "./plate.ts";
import { cloneSnap, sameSnap, type EditSnap } from "./ui/edit-history.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

function bytesOf(values: number[]): ArrayBuffer {
  const bytes = new Uint8Array(values);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function sameBytes(buffer: ArrayBuffer, values: number[]): boolean {
  const got = [...new Uint8Array(buffer)];
  return got.length === values.length && got.every((value, index) => value === values[index]);
}

function object(id: string, values: number[]): PlateObject {
  return {
    id,
    name: id,
    fileName: `${id}.stl`,
    bytes: bytesOf(values),
    sourcePos: new Float32Array(values),
    orient: [...ID_MATRIX],
    partScale: 1,
    centered: true,
    offset: { x: 0, y: 0, z: 0 },
    stepTolerance: 0.1,
    supportEdits: [],
    supportPaint: [],
    seamPaint: [],
    reinforcement: [],
    settings: {},
    brep: bytesOf([4, 5, 6]),
  };
}

function plateOf(obj: PlateObject): PlateState {
  return { objects: [obj], selectedId: obj.id };
}

const original = object("part", [1, 2, 3]);
const plate = plateOf(original);
const pins = pinPlateMeshes(plate);
const again = pinPlateMeshes(plate);
check("pinning the same mesh keeps the token", pins[0]?.token === again[0]?.token && pins.length === 1);

const snap = snapPlate(plate);
const copy = original.bytes.slice(0);
shareMeshToken(original.bytes, copy);
const shared = pinPlateMeshes(plateOf({ ...original, bytes: copy }));
check("a sliced copy shares the live mesh token", shared[0]?.token === pins[0]?.token);

const replaced = bytesOf([7, 7, 7]);
const edited = withSelectedPose(plate, {
  orient: [...ID_MATRIX],
  partScale: 1,
  centered: true,
  offset: { x: 0, y: 0, z: 0 },
  stepTolerance: 0.1,
  supportEdits: [],
  supportPaint: [],
  seamPaint: [],
  fileName: "part.stl",
  bytes: replaced,
  sourcePos: new Float32Array([7, 7, 7]),
});
const overwritten = revivePlate(snap);
check("the live mesh replaces what a snap would revive", overwritten != null && sameBytes(overwritten.objects[0]!.bytes, [7, 7, 7]));

recallPlateMeshes(pins);
const revived = revivePlate(snap);
check("recall puts the pinned mesh back", revived != null && sameBytes(revived.objects[0]!.bytes, [1, 2, 3]));
check("recall keeps the B-rep", revived != null && sameBytes(revived.objects[0]!.brep!, [4, 5, 6]));

const afterRecall = pinPlateMeshes(revived!);
check("a recalled mesh keeps its token", afterRecall[0]?.token === pins[0]?.token);

resetHeldGeometry();
recallPlateMeshes(pins);
const afterReset = revivePlate(snap);
check("clearing the live meshes keeps undo pins", afterReset != null && sameBytes(afterReset.objects[0]!.bytes, [1, 2, 3]));

const editedPins = pinPlateMeshes(edited);
check("a replaced mesh is a different undo step", editedPins[0]?.token !== pins[0]?.token);

function historySnap(token: string): EditSnap {
  return {
    placement: {
      orient: [...ID_MATRIX],
      partScale: 1,
      centered: true,
      offset: { x: 0, y: 0, z: 0 },
      stepTolerance: 0.1,
    },
    settings: {},
    splitCustom: false,
    profile: {
      nozzleDiameter: 0.4,
      bedX: 220,
      bedY: 220,
      bedZ: 250,
      maxVolumetricMm3S: 12,
      maxAccel: 10000,
      filamentDensityGCm3: 1.24,
      filamentCostPerKg: 20,
    },
    level: "simple",
    plate: snap,
    meshPins: [{ id: "part", token }],
  };
}

const kept = cloneSnap(historySnap(pins[0]!.token));
check("undo keeps the B-rep bytes", kept.plate?.objects[0]?.brep instanceof ArrayBuffer && sameBytes(kept.plate.objects[0].brep, [4, 5, 6]));
check("a mesh pin change is a different step", !sameSnap(historySnap("m1"), historySnap("m2")));

{
  const mesh = bytesOf([9, 9, 9]);
  const copy = mesh.slice(0);
  shareMeshToken(mesh, copy);
  const other = bytesOf([8]);
  const plate = { selectedId: "p", objects: [{ ...object("p", []), bytes: mesh }, { ...object("q", []), bytes: copy }, { ...object("r", []), bytes: other }] };
  const step = bytesOf([7]);
  const written = withBrepFor(plate, meshTokenOf(mesh), step);
  check("a solid's STEP lands on each object with its mesh", written.objects[0]!.brep === step && written.objects[1]!.brep === step);
  check("an object with another mesh keeps its own", written.objects[2]!.brep === plate.objects[2]!.brep);
  check("a mesh token survives a copy", meshTokenOf(copy) === meshTokenOf(mesh) && meshTokenOf(other) !== meshTokenOf(mesh));
  check("nothing to write keeps the plate", withBrepFor(written, meshTokenOf(mesh), step) === written);
  check("undefined removes the STEP", !("brep" in withBrepFor(written, meshTokenOf(mesh), undefined).objects[0]!));
}

if (failed) {
  console.error(`plate-mesh-pin: ${failed} failed`);
  throw new Error(`plate-mesh-pin: ${failed} failed`);
}
console.log("plate-mesh-pin: pins, recall, and B-rep undo ok");
