import { eulerOrient } from "./mesh-place.ts";
import {
  IDENTITY_POSE,
  applyPose,
  boxUnder,
  duplicatePose,
  inversePose,
  isRigid,
  isIdentity,
  movedPose,
  newSolidPose,
  placeFields,
  poseFromPlace,
  posedBounds,
  relativePose,
  thenPose,
  toSolidOp,
  turnDir,
  typedPoseOf,
  type Affine,
} from "./model-space.ts";
import { opLabel, type ModelOp, type Vec3 } from "./model-tree.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, same, same ? "" : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

function nearVec(a: readonly number[], b: readonly number[], tol = 1e-9): boolean {
  return a.length === b.length && a.every((value, i) => Math.abs(value - b[i]!) < tol);
}

/** Turned 90° about Z and moved: what a user gets from Place with Rz 90 and a move. */
const turned: Affine = { m: eulerOrient(0, 0, 90), t: [100, -20, 7] };
/** A turn about every axis, so no coordinate maps onto another. */
const skew: Affine = { m: eulerOrient(30, -50, 115), t: [12.5, 3, -40] };

// Identity is a no-op.
const box: ModelOp = { kind: "boolean", op: "cut", primitive: "box", origin: [0.1, 0.2, 0.3], size: [10, 0.7, 3], radius: 0, height: 0, turn: [15, 0, 30] };
const hole: ModelOp = { kind: "hole", origin: [1.1, 2.2, 3.3], axis: [0, 0, -1], radius: 2, depth: 8 };
const split: ModelOp = { kind: "split", origin: [0, 0, 42.42], normal: [0, 0, 1] };
for (const op of [box, hole, split]) check(`identity sends the ${op.kind} exactly as typed`, toSolidOp(op, IDENTITY_POSE) === op);
check("a pose of zeros and ones is identity", isIdentity({ m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] }) && isIdentity(undefined));
check("a move is not identity", !isIdentity({ m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 1e-9] }));

// Composition and inverse.
const p: Vec3 = [3, -4, 5];
check("inverse undoes a turned and moved pose", nearVec(applyPose(inversePose(skew), applyPose(skew, p)), p));
check("then applies the first pose first", nearVec(applyPose(thenPose(turned, skew), p), applyPose(skew, applyPose(turned, p))));
check("a quarter turn about Z puts X on Y", nearVec(turnDir(turned, [1, 0, 0]), [0, 1, 0]));

// A tool converted through a turned and moved pose names the same place on the solid.
const movedOnly: Affine = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [10, 0, -5] };
eq("a move shifts a hole by the move back", toSolidOp(hole, movedOnly), { ...hole, origin: [1.1 - 10, 2.2, 3.3 + 5] });
const solidHole = toSolidOp(hole, turned) as Extract<ModelOp, { kind: "hole" }>;
check("a hole's origin goes back through the pose", nearVec(applyPose(turned, solidHole.origin), hole.origin));
check("a hole typed straight down in model space drills straight down when the turn is about Z", nearVec(solidHole.axis, [0, 0, -1]));
const solidSplit = toSolidOp(split, skew) as Extract<ModelOp, { kind: "split" }>;
check("a split plane comes back to model Z", nearVec(turnDir(skew, solidSplit.normal), [0, 0, 1]) && Math.abs(applyPose(skew, solidSplit.origin)[2] - 42.42) < 1e-9);

/** The eight corners of a turned box primitive, as the kernel builds it: axis-aligned at `origin`, turned about its centre. */
function corners(op: Extract<ModelOp, { kind: "boolean" }>): Vec3[] {
  const half: Vec3 = [op.size[0] / 2, op.size[1] / 2, op.size[2] / 2];
  const centre: Vec3 = [op.origin[0] + half[0], op.origin[1] + half[1], op.origin[2] + half[2]];
  const turn = { m: eulerOrient(op.turn[0], op.turn[1], op.turn[2]), t: centre };
  const out: Vec3[] = [];
  for (let c = 0; c < 8; c += 1) out.push(applyPose(turn, [c & 1 ? half[0] : -half[0], c & 2 ? half[1] : -half[1], c & 4 ? half[2] : -half[2]]));
  return out;
}
const solidBox = toSolidOp(box, skew) as Extract<ModelOp, { kind: "boolean" }>;
const back = corners(solidBox).map((corner) => applyPose(skew, corner));
check("a turned box converts to the same eight corners", corners(box as Extract<ModelOp, { kind: "boolean" }>).every((corner, i) => nearVec(corner, back[i]!, 1e-9)));
eq("the box keeps its size", solidBox.size, [10, 0.7, 3]);
const cylinder: ModelOp = { kind: "boolean", op: "fuse", primitive: "cylinder", origin: [5, 5, 2], size: [0, 0, 0], radius: 3, height: 12, turn: [0, 20, 0] };
const solidCylinder = toSolidOp(cylinder, skew) as Extract<ModelOp, { kind: "boolean" }>;
const centreOf = (op: Extract<ModelOp, { kind: "boolean" }>) => applyPose({ m: eulerOrient(op.turn[0], op.turn[1], op.turn[2]), t: [op.origin[0], op.origin[1], op.origin[2] + op.height / 2] }, [0, 0, 0]);
check("a cylinder turns about its middle, which goes back through the pose", nearVec(applyPose(skew, centreOf(solidCylinder)), centreOf(cylinder as Extract<ModelOp, { kind: "boolean" }>)));
const axisOf = (op: Extract<ModelOp, { kind: "boolean" }>) => turnDir({ m: eulerOrient(op.turn[0], op.turn[1], op.turn[2]), t: [0, 0, 0] }, [0, 0, 1]);
check("a cylinder's axis comes back to the axis typed", nearVec(turnDir(skew, axisOf(solidCylinder)), axisOf(cylinder as Extract<ModelOp, { kind: "boolean" }>)));
const sphere: ModelOp = { kind: "boolean", op: "cut", primitive: "sphere", origin: [1, 2, 3], size: [0, 0, 0], radius: 4, height: 0, turn: [0, 0, 0] };
eq("a sphere only moves its centre", (toSolidOp(sphere, skew) as Extract<ModelOp, { kind: "boolean" }>).turn, [0, 0, 0]);
// The new primitives turn about the centre the kernel turns them about: a torus about its own centre, a wedge about its box's.
const torus: ModelOp = { kind: "boolean", op: "cut", primitive: "torus", origin: [4, 5, 6], size: [0, 0, 0], radius: 8, height: 0, turn: [90, 0, 0], tubeRadius: 2 };
const solidTorus = toSolidOp(torus, skew) as Extract<ModelOp, { kind: "boolean" }>;
check("a torus's centre goes back through the pose", nearVec(applyPose(skew, solidTorus.origin), torus.origin));
check("and its axis comes back to the axis typed", nearVec(turnDir(skew, axisOf(solidTorus)), axisOf(torus as Extract<ModelOp, { kind: "boolean" }>)));
eq("a torus keeps its tube", solidTorus.tubeRadius, 2);
const wedge: ModelOp = { kind: "boolean", op: "fuse", primitive: "wedge", origin: [0.1, 0.2, 0.3], size: [10, 0.7, 3], radius: 0, height: 0, turn: [15, 0, 30], topX: 4 };
const solidWedge = toSolidOp(wedge, skew) as Extract<ModelOp, { kind: "boolean" }>;
const wedgeBack = corners(solidWedge).map((corner) => applyPose(skew, corner));
check("a turned wedge converts to the same eight box corners", corners(wedge as Extract<ModelOp, { kind: "boolean" }>).every((corner, i) => nearVec(corner, wedgeBack[i]!, 1e-9)));
const cone: ModelOp = { kind: "boolean", op: "cut", primitive: "cone", origin: [5, 5, 2], size: [0, 0, 0], radius: 3, height: 12, turn: [0, 20, 0], topRadius: 1 };
check("a cone turns about the middle of its axis, as a cylinder", nearVec(applyPose(skew, centreOf(toSolidOp(cone, skew) as Extract<ModelOp, { kind: "boolean" }>)), centreOf(cone as Extract<ModelOp, { kind: "boolean" }>)));

// New solid: at the origin of an empty model space, else past everything along X.
eq("a new solid in an empty model space stands where it was built", newSolidPose([], { min: [-5, -5, 0], max: [5, 5, 10] }), IDENTITY_POSE);
eq(
  "beside two objects: 10 mm past the farthest, centred on their Y, on their floor",
  newSolidPose([{ min: [0, 0, 2], max: [20, 20, 12] }, { min: [-40, 30, 5], max: [-30, 40, 9] }], { min: [-5, -5, 0], max: [5, 5, 10] }).t,
  [35, 20, 2],
);

const fillet: ModelOp = { kind: "fillet", edges: [3], size: 1 };
check("a fillet names edges, which no pose moves", toSolidOp(fillet, skew) === fillet);
const group: ModelOp = { kind: "group", label: "Two cuts", source: { kind: "pocket" }, steps: [box, hole] };
eq("a turned pose moves each step of a group", toSolidOp(group, skew), { ...group, steps: [toSolidOp(box, skew), toSolidOp(hole, skew)] });
check("with no pose a group is the op typed", toSolidOp(group, IDENTITY_POSE) === group);

// History labels name the step in the part's own frame, so moving the part later never renames it.
const raisedTen: Affine = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 10] };
eq("a split typed at model Z 15 on a part raised 10 is labelled at Z 5", opLabel(toSolidOp({ kind: "split", origin: [0, 0, 15], normal: [0, 0, 1] }, raisedTen)), "Split at Z 5");
eq("with no pose the label is the number typed", opLabel(toSolidOp(split, IDENTITY_POSE)), "Split at Z 42.42");
eq("a part lying on its side takes a model Z plane on its own Y", opLabel(toSolidOp({ kind: "split", origin: [0, 0, 15], normal: [0, 0, 1] }, { m: eulerOrient(90, 0, 0), t: [0, 0, 0] })), "Split at Y 15");
eq("a model Z plane on a part turned 30° about X is a tilted plane of the part", opLabel(toSolidOp({ kind: "split", origin: [0, 0, 15], normal: [0, 0, 1] }, { m: eulerOrient(30, 0, 0), t: [0, 0, 0] })), "Split at Z 17.32, tilt −30° / 0°");

// Place fields.
const pivot: Vec3 = [10, 20, 30];
eq("identity shows zeros", placeFields(IDENTITY_POSE, pivot), { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 });
const moved = poseFromPlace(IDENTITY_POSE, pivot, "x", 10);
eq("moving X by 10 moves the pose by 10", moved, { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [10, 0, 0] });
const spun = poseFromPlace(IDENTITY_POSE, pivot, "rz", 90);
check("a turn keeps the centre where it is", nearVec(applyPose(spun, pivot), pivot));
const fields = placeFields(spun, pivot);
check("the fields of a turn read back", nearVec([fields.x, fields.y, fields.z, fields.rx, fields.ry, fields.rz], [0, 0, 0, 0, 0, 90], 1e-9));
const odd: Affine = { m: eulerOrient(12.345678, -3.2, 71.11), t: [0.123456789, -7.000001, 3] };
const thenMoved = poseFromPlace(odd, pivot, "y", placeFields(odd, pivot).y + 5);
eq("a move keeps the turn it had, bit for bit", thenMoved.m, odd.m);
eq("a move along Y leaves X and Z exactly where they were", [thenMoved.t[0], thenMoved.t[2]], [odd.t[0], odd.t[2]]);
check("and moves Y by the amount typed", Math.abs(thenMoved.t[1] - (odd.t[1] + 5)) < 1e-12);
const retilted = placeFields(poseFromPlace(odd, pivot, "rx", 30), pivot);
check("a turn field changes only its own angle and keeps the centre", nearVec([retilted.rx, retilted.ry, retilted.rz], [30, -3.2, 71.11], 1e-9) && nearVec([retilted.x, retilted.y, retilted.z], [placeFields(odd, pivot).x, placeFields(odd, pivot).y, placeFields(odd, pivot).z], 1e-9));

// Duplicate.
eq("a duplicate sits its own width plus 10 mm along X", duplicatePose(IDENTITY_POSE, { min: [0, 0, 0], max: [40, 30, 20] }).t, [50, 0, 0]);

// Boxes.
const cube = new Float32Array([0, 0, 0, 10, 0, 0, 0, 20, 0, 0, 0, 5]);
eq("posed bounds of a box turned a quarter", posedBounds(cube, turned), { min: [80, -20, 7], max: [100, -10, 12] });
check("posed bounds are kept for the same solid and pose", posedBounds(cube, turned) === posedBounds(cube, turned));
const skewBox = posedBounds(cube, skew)!;
const shiftedBox = posedBounds(cube, movedPose(skew, [5, -2, 1]))!;
const fresh = posedBounds(new Float32Array(cube), movedPose(skew, [5, -2, 1]))!;
check("a pose that only moved shifts the kept box", nearVec([...shiftedBox.min, ...shiftedBox.max], [skewBox.min[0] + 5, skewBox.min[1] - 2, skewBox.min[2] + 1, skewBox.max[0] + 5, skewBox.max[1] - 2, skewBox.max[2] + 1], 1e-9));
check("and the shifted box is the one every vertex gives", nearVec([...shiftedBox.min, ...shiftedBox.max], [...fresh.min, ...fresh.max], 1e-9));
eq("a box under a move", boxUnder({ min: [0, 0, 0], max: [1, 2, 3] }, movedOnly), { min: [10, 0, -5], max: [11, 2, -2] });

// A join's tool in the target's own frame ---------------------------------------------------------------------------

const target: Affine = { m: eulerOrient(20, 0, 30), t: [5, -3, 12] };
const toolPose: Affine = { m: eulerOrient(0, 45, 90), t: [40, 2, 0] };
const relative = relativePose(target, toolPose);
for (const p of [[0, 0, 0], [10, 4, -2], [-7, 3, 9]] as Vec3[]) {
  check(`the tool's point ${p} lands where the target's frame puts it`, nearVec(applyPose(target, applyPose(relative, p)), applyPose(toolPose, p), 1e-9));
}
check("and back: the target's inverse undoes it", nearVec(applyPose(thenPose(relative, target), [1, 2, 3]), applyPose(toolPose, [1, 2, 3]), 1e-9));
eq("on an untouched target it is the tool's own pose", relativePose(IDENTITY_POSE, toolPose), toolPose);
eq("two objects moved alike leave it alone", relativePose(movedPose(target, [8, 8, 8]), movedPose(toolPose, [8, 8, 8])).t.map((v) => Math.round(v * 1e9) / 1e9), relative.t.map((v) => Math.round(v * 1e9) / 1e9));
eq("a quarter turn about Z of the target moves a model −Y into its own −X", relativePose({ m: eulerOrient(0, 0, 90), t: [5, 7, 0] }, { m: eulerOrient(0, 0, 90), t: [5, -3, 0] }).t.map((v) => Math.round(v * 1e9) / 1e9), [-10, 0, 0]);
eq("rigid: a turn and a move are; a scale, a mirror and a shear are not", [
  isRigid(relative),
  isRigid({ m: [2, 0, 0, 0, 2, 0, 0, 0, 2], t: [0, 0, 0] }),
  isRigid({ m: [-1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] }),
  isRigid({ m: [1, 0.5, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] }),
  isRigid({ m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, Number.NaN, 0] }),
], [true, false, false, false, false]);

// Assemblies M1: a part-frame object types its numbers through no pose, so a stored op is the op that was typed.
{
  const moved: Affine = { m: [0, -1, 0, 1, 0, 0, 0, 0, 1], t: [200, 30, 0] };
  const typed: ModelOp = { kind: "boolean", op: "fuse", primitive: "box", origin: [10, 5, 5], size: [6, 6, 8], radius: 0, height: 0, turn: [0, 0, 0] };
  eq("an object in the default frame types through its pose", typedPoseOf({ modelPose: moved }), moved);
  eq("a model-frame object is the same", typedPoseOf({ modelPose: moved, frame: "model" }), moved);
  eq("a part-frame object types through none", typedPoseOf({ modelPose: moved, frame: "part" }), IDENTITY_POSE);
  eq("so the stored op is the typed op", toSolidOp(typed, typedPoseOf({ modelPose: moved, frame: "part" })), typed);
  check("while the default frame moves it", JSON.stringify(toSolidOp(typed, typedPoseOf({ modelPose: moved }))) !== JSON.stringify(typed));
  eq("an object with no pose is the identity in either frame", [typedPoseOf({}), typedPoseOf({ frame: "part" })], [IDENTITY_POSE, IDENTITY_POSE]);
}

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("model space: poses, tool conversion, place fields ok");
