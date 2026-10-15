import { rotX, type Mat3 } from "./mesh-place.ts";
import type { PrimitiveSpec } from "./model-primitive.ts";
import {
  CURVED_FACE,
  GLOBAL_WORKPLANE,
  axesOf,
  isIdentityFrame,
  isUntilted,
  modelDir,
  modelPoint,
  modelToLocal,
  placePrimitive,
  printOrient,
  readWorkplane,
  sameWorkplane,
  shiftWorkplane,
  workplaneNote,
  workplaneOnBed,
  workplaneOnFace,
} from "./workplane.ts";

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const left = JSON.stringify(got);
  const right = JSON.stringify(want);
  if (left === right) return;
  failed += 1;
  console.error(`FAIL ${name}\n  got  ${left}\n  want ${right}`);
}
function check(name: string, ok: boolean) {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}`);
}
function near(a: number, b: number, tol = 1e-6) {
  return Math.abs(a - b) < tol;
}
function nearVec(a: readonly number[], b: readonly number[], tol = 1e-6) {
  return a.length === b.length && a.every((value, i) => near(value, b[i]!, tol));
}

const box: PrimitiveSpec = {
  primitive: "box",
  origin: [10, 0, 0],
  size: [4, 5, 6],
  radius: 0,
  height: 0,
  turn: [0, 0, 0],
};

check("the global frame is the identity", isIdentityFrame(GLOBAL_WORKPLANE) && isUntilted(GLOBAL_WORKPLANE));
eq("the global axes are X, Y, Z", axesOf(GLOBAL_WORKPLANE), [[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
eq("an identity frame keeps a point's numbers", modelPoint(GLOBAL_WORKPLANE, [10, 2, 3]), [10, 2, 3]);
eq("an identity frame keeps a direction", modelDir(GLOBAL_WORKPLANE, [0, 0, -1]), [0, 0, -1]);
check("an identity frame returns the primitive itself", placePrimitive(box, GLOBAL_WORKPLANE) === box);
eq("an untilted frame does not rotate the plate", printOrient(GLOBAL_WORKPLANE, [1, 0, 0, 0, 1, 0, 0, 0, 1]), null);

const shifted = { ...GLOBAL_WORKPLANE, origin: [5, 6, 7] as [number, number, number] };
eq("a moved frame carries a local point", modelPoint(shifted, [10, 0, 0]), [15, 6, 7]);
eq("the point comes back", modelToLocal(shifted, [15, 6, 7]), [10, 0, 0]);
const moved = placePrimitive(box, shifted);
eq("a moved frame carries a box and keeps its turn", [moved.origin, moved.turn, moved.size], [[15, 6, 7], [0, 0, 0], [4, 5, 6]]);
check("the original spec is untouched", box.origin[0] === 10);

const bed = workplaneOnBed({ min: [0, 0, 0], max: [20, 10, 8] });
eq("the bed frame sits under the middle, on the floor", bed, { source: "bed", origin: [10, 5, 0], turn: [0, 0, 0] });
check("the bed frame does not tilt the plate", isUntilted(bed) && printOrient(bed, [1, 0, 0, 0, 1, 0, 0, 0, 1]) === null);

const top = workplaneOnFace({ point: [10, 5, 8], normal: [0, 0, 1] });
eq("a top face is U X, V Y, W Z at the face", [top.source, top.origin, top.turn], ["face", [10, 5, 8], [0, 0, 0]]);
eq("a hole at the local origin starts on that face", modelPoint(top, [0, 0, 0]), [10, 5, 8]);
eq("and drills along -W, which is straight down", modelDir(top, [0, 0, -1]), [0, 0, -1]);

const side = workplaneOnFace({ point: [20, 5, 4], normal: [1, 0, 0] });
const [u, v, w] = axesOf(side);
check("a side face has W along its normal", nearVec(w, [1, 0, 0]));
check("U and V lie in the face", near(dot(u, w), 0) && near(dot(v, w), 0) && near(dot(u, v), 0));
check("the frame stays right-handed", nearVec(cross(u, v), w));
const stepped = modelPoint(side, [3, 0, 4]);
check("the step is 3 along U and 4 along W from the face", nearVec(stepped, add(side.origin, add(scale(u, 3), scale(w, 4)))));
eq("drilling -W goes into the material", modelDir(side, [0, 0, -1]).map(round6), scale(w, -1).map(round6));
const stood = placePrimitive({ ...box, origin: [0, 0, 0], turn: [0, 0, 0] }, side);
check("a box on the side face turns so its height follows W", nearVec(axesOf({ ...side, origin: [0, 0, 0], turn: stood.turn })[2], w));

const tilt = { source: "face" as const, origin: [0, 0, 0] as [number, number, number], turn: [90, 0, 0] as [number, number, number] };
check("a quarter turn about X lays W along -Y", nearVec(axesOf(tilt)[2], [0, -1, 0]));
const orient = printOrient(tilt, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
check("print orient maps W to +Z", orient != null && nearVec(mulDir(orient, axesOf(tilt)[2]), [0, 0, 1]));
check("and U to +X", orient != null && nearVec(mulDir(orient, axesOf(tilt)[0]), [1, 0, 0]));
const posed = printOrient(tilt, rotX(90));
const meshW = mulDir(transpose(rotX(90)), axesOf(tilt)[2]);
check("a part already turned in model space still prints W up", posed != null && nearVec(mulDir(posed, meshW), [0, 0, 1]));

const copy = shiftWorkplane(side, [30, 0, 0]);
eq("a copy's frame moves with the part", [copy.origin[0] - side.origin[0], copy.turn], [30, side.turn]);
check("two equal frames compare equal", sameWorkplane(top, { ...top }));

eq("the global note names the axes", workplaneNote(GLOBAL_WORKPLANE, null).text.startsWith("U is X"), true);
eq("a tilted note says the part sits up", workplaneNote(tilt, null).text.includes("W points up"), true);
eq("a curved face is refused in plain words", workplaneNote(GLOBAL_WORKPLANE, CURVED_FACE), { text: CURVED_FACE, bad: true });
check("the refusal does not name a kernel", !CURVED_FACE.includes("OCCT") && !CURVED_FACE.includes("BRep"));

eq("a saved frame round-trips", readWorkplane({ source: "bed", origin: [1, 2, 3], turn: [0, 0, 0] }), { source: "bed", origin: [1, 2, 3], turn: [0, 0, 0] });
eq("a damaged frame is refused", readWorkplane({ source: "face", origin: [1, 2], turn: [0, 0, 0] }), null);
eq("an unknown source is refused", readWorkplane({ source: "sketch", origin: [0, 0, 0], turn: [0, 0, 0] }), null);

// A local turn survives a frame whose own turn is zero, number for number.
const spun = placePrimitive({ ...box, turn: [0, 30, 0] }, shifted);
eq("an untilted frame keeps the typed turn", spun.turn, [0, 30, 0]);

if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("workplane: frame, placement, and plate orient ok");

function round6(value: number) {
  return Math.round(value * 1e6) / 1e6;
}
function dot(a: readonly number[], b: readonly number[]) {
  return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
}
function cross(a: readonly number[], b: readonly number[]): [number, number, number] {
  return [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
}
function scale(a: readonly number[], k: number): [number, number, number] {
  return [a[0]! * k, a[1]! * k, a[2]! * k];
}
function add(a: readonly number[], b: readonly number[]): [number, number, number] {
  return [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!];
}
function mulDir(m: Mat3, d: readonly number[]): [number, number, number] {
  return [
    m[0] * d[0]! + m[1] * d[1]! + m[2] * d[2]!,
    m[3] * d[0]! + m[4] * d[1]! + m[5] * d[2]!,
    m[6] * d[0]! + m[7] * d[1]! + m[8] * d[2]!,
  ];
}
function transpose(m: Mat3): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}
