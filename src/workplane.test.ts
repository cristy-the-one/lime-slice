import { eulerOrient, type Mat3 } from "./mesh-place.ts";
import { turnCentre, type PrimitiveSpec } from "./model-primitive.ts";
import { IDENTITY_POSE, applyPose, inversePose, toSolidOp, type Affine } from "./model-space.ts";
import {
  CURVED_FACE,
  GLOBAL_WORKPLANE,
  axesOf,
  drillDown,
  isGlobalFrame,
  isIdentityFrame,
  localPoint,
  planePoint,
  planePrimitive,
  printOrient,
  readWorkplane,
  sameWorkplane,
  workplaneIn,
  workplaneNote,
  workplaneOnBed,
  workplaneOnFace,
  workplaneOwn,
  type Vec3,
  type Workplane,
} from "./workplane.ts";

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const left = JSON.stringify(got);
  const right = JSON.stringify(want);
  if (left === right) return;
  failed += 1;
  console.error(`FAIL ${name}\n  got  ${left}\n  want ${right}`);
}
function check(name: string, ok: boolean, detail = "") {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name} ${detail}`);
}
const near = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) < tol;
const nearVec = (a: readonly number[], b: readonly number[], tol = 1e-9) => a.length === b.length && a.every((value, i) => near(value, b[i]!, tol));
const nearSet = (a: readonly Vec3[], b: readonly Vec3[]) => a.length === b.length && a.every((p) => b.some((q) => nearVec(p, q, 1e-9)));

const box: PrimitiveSpec = { primitive: "box", origin: [0, 0, 0], size: [4, 5, 6], radius: 0, height: 0, turn: [0, 0, 0] };
const cylinder: PrimitiveSpec = { primitive: "cylinder", origin: [1, 2, 0], size: [0, 0, 0], radius: 3, height: 8, turn: [0, 0, 0] };

/** The corners of a box primitive where the kernel builds it: grown from its origin, then turned about its centre. */
function boxCorners(spec: PrimitiveSpec): Vec3[] {
  const half = turnCentre(spec);
  const m = eulerOrient(spec.turn[0], spec.turn[1], spec.turn[2]);
  const centre = [spec.origin[0] + half[0], spec.origin[1] + half[1], spec.origin[2] + half[2]];
  const out: Vec3[] = [];
  for (let c = 0; c < 8; c += 1) {
    const d = [(c & 1 ? spec.size[0] : 0) - half[0], (c & 2 ? spec.size[1] : 0) - half[1], (c & 4 ? spec.size[2] : 0) - half[2]];
    out.push(applyPose({ m, t: centre as Vec3 }, d));
  }
  return out;
}

// The global frame is model space, number for number.
check("the global frame is the identity, and not stored", isIdentityFrame(GLOBAL_WORKPLANE) && isGlobalFrame(GLOBAL_WORKPLANE));
eq("its axes are X, Y, Z", axesOf(GLOBAL_WORKPLANE), [[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
eq("a point keeps its numbers", planePoint(GLOBAL_WORKPLANE, [10, 2, 3]), [10, 2, 3]);
eq("a hole drills straight down", drillDown(GLOBAL_WORKPLANE), [0, 0, -1]);
check("a primitive is sent as typed", planePrimitive(box, GLOBAL_WORKPLANE) === box);
check("a bed frame at the origin is not the untouched global frame", !isGlobalFrame({ source: "bed", origin: [0, 0, 0], turn: [0, 0, 0] }));

// A moved, untilted frame moves the numbers exactly and keeps the turn.
const bed = workplaneOnBed({ min: [0, 0, 0], max: [20, 10, 8] });
eq("the bed frame sits under the middle, on the floor", bed, { source: "bed", origin: [10, 5, 0], turn: [0, 0, 0] });
eq("a local point on it is the footprint's middle plus the numbers", planePoint(bed, [1, 2, 3]), [11, 7, 3]);
eq("and comes back", localPoint(bed, [11, 7, 3]), [1, 2, 3]);
eq("it still drills straight down", drillDown(bed), [0, 0, -1]);
eq("a box on it moves and keeps its turn", planePrimitive({ ...box, turn: [0, 30, 0] }, bed).origin, [10, 5, 0]);
eq("exactly", planePrimitive({ ...box, turn: [0, 30, 0] }, bed).turn, [0, 30, 0]);

// A side face: W is its outward normal, so a box grows out of the face and a hole drills into it.
const side = workplaneOnFace({ point: [20, 5, 4], normal: [1, 0, 0] });
const [u, v, w] = axesOf(side);
check("W is the face's normal", nearVec(w, [1, 0, 0]));
check("U and V lie in the face, right-handed", near(dot(u, w), 0) && near(dot(v, w), 0) && near(dot(u, v), 0) && nearVec(cross(u, v), w));
check("the step is 3 along U and 4 along W from the face", nearVec(planePoint(side, [3, 0, 4]), add(side.origin, add(scale(u, 3), scale(w, 4)))));
check("and comes back", nearVec(localPoint(side, planePoint(side, [3, -2, 4])), [3, -2, 4]));
check("a hole drills along −W, into the material", nearVec(drillDown(side), [-1, 0, 0]));
// The box typed at U, V, W 0 grows over [0, 4] × [0, 5] × [0, 6] of the frame: its corners are the frame's corners.
const want = boxCorners({ ...box }).map((p) => planePoint(side, p));
check("a box typed on the face sits on the face and grows along U, V, W", nearSet(boxCorners(planePrimitive(box, side)), want), JSON.stringify(boxCorners(planePrimitive(box, side))));
const turned = { ...box, origin: [-2, 1, 0] as Vec3, turn: [0, 0, 30] as Vec3 };
check("a box with a turn of its own turns about its centre in the frame", nearSet(boxCorners(planePrimitive(turned, side)), boxCorners(turned).map((p) => planePoint(side, p))));
const stood = planePrimitive(cylinder, side);
const stoodAxis = axesOf({ ...side, turn: stood.turn })[2];
// The kernel turns it about the middle of its axis, so its bottom centre is that middle less half its height along the axis.
const bottom = add(add(stood.origin, [0, 0, cylinder.height / 2]), scale(stoodAxis, -cylinder.height / 2));
check("a cylinder stands along W, its bottom centre where it was typed", nearVec(stoodAxis, w) && nearVec(bottom, planePoint(side, cylinder.origin)));
const ball = planePrimitive({ ...box, primitive: "sphere", radius: 2, origin: [1, 1, 1] }, side);
check("a sphere only moves", nearVec(ball.origin, planePoint(side, [1, 1, 1])) && ball.turn.every((value) => value === 0));

// A turned frame, then the solid's pose: the op the engine builds is where the frame put it.
const tilted: Workplane = { source: "global", origin: [5, -3, 2], turn: [30, -20, 75] };
const pose: Affine = { m: eulerOrient(10, 40, -60), t: [12, 7, -4] };
const solidOp = toSolidOp({ kind: "boolean", op: "cut", ...planePrimitive(box, tilted) }, pose) as Extract<ReturnType<typeof toSolidOp>, { kind: "boolean" }>;
const back = inversePose(pose);
check("through the solid's pose, the box's corners are the frame's", nearSet(boxCorners(solidOp), boxCorners(box).map((p) => applyPose(back, planePoint(tilted, p)))));

// A part keeps its frame in its own frame: Place moves the frame with the part.
const own = workplaneOwn(side, pose);
check("own and model space round-trip", nearVec(workplaneIn(own, pose).origin, side.origin) && nearVec(axesOf(workplaneIn(own, pose)).flat(), axesOf(side).flat()));
const moved: Affine = { m: pose.m, t: [pose.t[0] + 30, pose.t[1], pose.t[2]] };
check("a move of the part moves its frame by the same", nearVec(workplaneIn(own, moved).origin, add(side.origin, [30, 0, 0])) && nearVec(axesOf(workplaneIn(own, moved)).flat(), axesOf(side).flat()));
const spun: Affine = { m: eulerOrient(0, 0, 90), t: [0, 0, 0] };
check("a turn of the part turns its frame with it", nearVec(axesOf(workplaneIn(side, spun))[2], [0, 1, 0]));
check("an identity pose keeps the stored frame itself", workplaneIn(side, IDENTITY_POSE) === side && workplaneOwn(side, IDENTITY_POSE) === side);
eq("no frame stored is the global frame at any pose", workplaneIn(undefined, pose), GLOBAL_WORKPLANE);

// Print with W up, from the frame as the part keeps it: the plate mesh is the part's own frame, lowered.
eq("the global frame prints the file's own way up", printOrient(undefined), [1, 0, 0, 0, 1, 0, 0, 0, 1]);
const up = printOrient(own);
check("W, in the part's own frame, prints up", nearVec(mulDir(up, axesOf(own)[2]), [0, 0, 1]));
check("and U along X", nearVec(mulDir(up, axesOf(own)[0]), [1, 0, 0]));
check("two equal frames compare equal, and a moved one does not", sameWorkplane(side, { ...side }) && !sameWorkplane(side, { ...side, origin: [21, 5, 4] }));

// A move of the part keeps the turn's numbers: worked out again, a turn past Y 90° would come back as other angles.
const steep: Workplane = { source: "global", origin: [1, 2, 3], turn: [10, 95, 20] };
const slid: Affine = { m: [...IDENTITY_POSE.m] as Mat3, t: [30, 0, 0] };
eq("a moved part's frame keeps its turn exactly", workplaneIn(steep, slid), { source: "global", origin: [31, 2, 3], turn: [10, 95, 20] });
eq("and so does storing it back", workplaneOwn(workplaneIn(steep, slid), slid), steep);

// Faces: V runs up a side face and U is level, so no face frame sits where Turn X and Turn Z are one turn.
for (const normal of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0.6, 0.8, 0], [0.48, 0.64, 0.6]] as Vec3[]) {
  const frame = workplaneOnFace({ point: [0, 0, 0], normal });
  const [fu, fv, fw] = axesOf(frame);
  check(`a face with normal ${normal} has W out of it, right-handed`, nearVec(fw, normal) && nearVec(cross(fu, fv), fw));
  check(`and V up the face, U level, the turn clear of Y ±90°`, fv[2] > 0 && near(fu[2], 0) && Math.abs(Math.abs(frame.turn[1]) - 90) > 1);
}
eq("a front face (−Y) reads U along X and V up Z", axesOf(workplaneOnFace({ point: [0, 0, 0], normal: [0, -1, 0] })).slice(0, 2).map((a) => a.map((x) => Math.round(x * 1e9) / 1e9 + 0)), [[1, 0, 0], [0, 0, 1]]);
eq("a top face keeps Split's in-plane axes, X and Y", axesOf(workplaneOnFace({ point: [0, 0, 0], normal: [0, 0, 1] })).slice(0, 2), [[1, 0, 0], [0, 1, 0]]);

// The note.
eq("the global note names the axes", workplaneNote(GLOBAL_WORKPLANE), "U, V, W are X, Y, Z. Pick Bed or Face, or type a frame.");
eq("the face note says where W points", workplaneNote(side), "Set on a face, W out of it. Hole, Boolean, and Split use this frame.");
eq("the bed note says W is up", workplaneNote(bed), "Under the part, W up. Hole, Boolean, and Split use this frame.");
eq("a bed frame a turn of the part tipped is no longer said to be under it", workplaneNote(workplaneIn(bed, { m: eulerOrient(90, 0, 0), t: [0, 0, 0] })), "Hole, Boolean, and Split use this frame.");
check("Split's curved-face sentence is the one a workplane refuses with", CURVED_FACE === "Pick a flat face. This one is curved.");
eq("a saved frame reads", readWorkplane({ source: "bed", origin: [1, 2, 3], turn: [0, 0, 0] }), { source: "bed", origin: [1, 2, 3], turn: [0, 0, 0] });
eq("a short origin is damaged", readWorkplane({ source: "face", origin: [1, 2], turn: [0, 0, 0] }), null);
eq("an unknown source is damaged", readWorkplane({ source: "sketch", origin: [0, 0, 0], turn: [0, 0, 0] }), null);
eq("a number that is not finite is damaged", readWorkplane({ source: "face", origin: [0, 0, 0], turn: [0, Infinity, 0] }), null);

if (failed > 0) {
  console.error(`${failed} failed`);
  throw new Error(`workplane: ${failed} failed`);
}
console.log("workplane: frames, placement, own frame, and print orient ok");

function dot(a: readonly number[], b: readonly number[]) {
  return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
}
function cross(a: readonly number[], b: readonly number[]): Vec3 {
  return [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
}
function scale(a: readonly number[], k: number): Vec3 {
  return [a[0]! * k, a[1]! * k, a[2]! * k];
}
function add(a: readonly number[], b: readonly number[]): Vec3 {
  return [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!];
}
function mulDir(m: Mat3, d: readonly number[]): Vec3 {
  return [m[0] * d[0]! + m[1] * d[1]! + m[2] * d[2]!, m[3] * d[0]! + m[4] * d[1]! + m[5] * d[2]!, m[6] * d[0]! + m[7] * d[1]! + m[8] * d[2]!];
}
