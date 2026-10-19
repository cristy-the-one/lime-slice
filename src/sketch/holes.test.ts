/**
 * Holes from sketch points: one group, circle centres, and the panel an edit reopens.
 */
import { IDENTITY_POSE, toSolidOp, type Affine } from "../model-space.ts";
import { editPanel, editRefusal } from "../model-edit.ts";
import { loadedTree, readSavedTree, savedTree } from "../model-tree-file.ts";
import { newTree, opLabel, withChild, type ModelOp } from "../model-tree.ts";
import { handlesFor } from "../model-drag.ts";
import { eulerOrient } from "../mesh-place.ts";
import { addCircle, addLine, addPoint, emptySketch, type SketchData } from "./model.ts";
import { frameOf, planeOf } from "./frame.ts";
import {
  FACE_REFUSAL,
  POINT_REFUSAL,
  holeMarks,
  holePointsSentence,
  holeTargets,
  holesInModel,
  isSketchHoleGroup,
  pointsFromSource,
  refusedHole,
  sketchHolePanel,
  sketchHoleSource,
  sketchOnFace,
  type HoleSizes,
} from "./holes.ts";

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
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}
function near(a: number, b: number, tol = 1e-6) {
  return Math.abs(a - b) <= tol;
}

const face = { index: 1, mid: [10, 10, 20] as [number, number, number], areaMm2: 400 };
const onFace = emptySketch({ origin: [10, 10, 20], turn: [0, 0, 0] }, { kind: "face", face });
const sizes: HoleSizes = { radius: 2, depth: 8, through: false, counterboreRadius: null, counterboreDepth: null };

function withPoints(sketch: SketchData, at: [number, number][]): SketchData {
  let next = sketch;
  for (const point of at) next = addPoint(next, point, true).sketch;
  return next;
}

const three = withPoints(onFace, [[0, 0], [5, 0], [-4, 3]]);
const ids = three.points.map((point) => point.id);
const picked = { entities: [] as number[], points: ids };

check("a face sketch can take holes", sketchOnFace(three));
check("a plane sketch cannot", !sketchOnFace(emptySketch({ origin: [0, 0, 0], turn: [0, 0, 0] }, { kind: "plane", name: "XY" })));
eq("the sentence names the face", FACE_REFUSAL, "Sketch on a face to place a hole at each point.");
eq("the sentence names the points", POINT_REFUSAL, "Select points or circle centres.");

const targets = holeTargets(three, picked);
eq("three selected points are three holes", targets.map((point) => point.id), ids);
eq("the layout names each point", holePointsSentence(3), "One hole at each of 3 points.");
eq("one point stays singular", holePointsSentence(1), "One hole at each of 1 point.");

const built = holesInModel({ sketch: three, points: targets, pose: IDENTITY_POSE, sizes });
if (!("op" in built)) throw new Error(built.error);
const group = built.op;
eq("the result is one group", group.kind, "group");
eq("the row names the three holes", group.label, "3 holes ⌀4 depth 8");
eq("opLabel is that row", opLabel(group), "3 holes ⌀4 depth 8");
check("every step is a hole", group.steps.every((step) => step.kind === "hole"));
eq("three steps", group.steps.length, 3);
eq("they drill down into the top face", group.steps.map((step) => (step.kind === "hole" ? step.axis : null)), [[0, 0, -1], [0, 0, -1], [0, 0, -1]]);
eq("each hole starts at its point on the face", group.steps.map((step) => (step.kind === "hole" ? step.origin : null)), [[10, 10, 20], [15, 10, 20], [6, 13, 20]]);
eq("radius and depth are the panel's", group.steps.map((step) => (step.kind === "hole" ? [step.radius, step.depth] : null)), [[2, 8], [2, 8], [2, 8]]);
check("a blind hole stores no through flag", group.steps.every((step) => step.kind === "hole" && step.through === undefined));

const source = sketchHoleSource(group);
check("the group is holes from a sketch", isSketchHoleGroup(group) && source != null);
eq("source keeps the point ids in step order", source?.points, ids);
eq("an edit reads those points back", pointsFromSource(source!).map((point) => point.at), targets.map((point) => point.at));

const bored = holesInModel({
  sketch: three,
  points: targets.slice(0, 1),
  pose: IDENTITY_POSE,
  sizes: { radius: 1.7, depth: 12, through: true, counterboreRadius: 3, counterboreDepth: 3.2 },
});
if (!("op" in bored)) throw new Error(bored.error);
eq("one through hole is still one group", bored.op.label, "1 hole ⌀3.4 through, counterbore ⌀6 × 3.2");
const boredStep = bored.op.steps[0]!;
check("through and the counterbore are on the step", boredStep.kind === "hole" && boredStep.through === true && boredStep.counterboreRadius === 3 && boredStep.counterboreDepth === 3.2);

const none = holesInModel({ sketch: three, points: [], pose: IDENTITY_POSE, sizes });
eq("no points is refused before a group is built", "error" in none ? none.error : "", POINT_REFUSAL);

let circles = onFace;
const centres: number[] = [];
for (const at of [[2, 2], [8, 1], [-3, 4]] as [number, number][]) {
  const added = addCircle(circles, at, 1.5);
  circles = added.sketch;
  const entity = circles.entities.find((item) => item.id === added.id);
  if (entity?.kind === "circle") centres.push(entity.centre);
}
const fromCircles = holeTargets(circles, { entities: circles.entities.map((entity) => entity.id), points: [] });
eq("selected circles drill at their centres", fromCircles.map((point) => point.id), centres);
const both = holeTargets(circles, { entities: circles.entities.map((entity) => entity.id), points: [centres[0]!] });
eq("a centre picked twice is one hole", both.length, 3);

const line = addLine(onFace, [0, 0], [4, 0]).sketch;
const lineOnly = holeTargets(line, { entities: [line.entities[0]!.id], points: [] });
eq("a selected line is not two holes", lineOnly, []);
const end = line.points[0]!.id;
eq("a selected endpoint is a hole", holeTargets(line, { entities: [], points: [end] }).map((point) => point.id), [end]);

const side = frameOf(planeOf({ origin: [0, 10, 10], u: [0, 1, 0], v: [0, 0, 1], w: [1, 0, 0] }));
const sideSketch = emptySketch(planeOf(side), { kind: "face", face: { index: 2, mid: [0, 10, 10], areaMm2: 200 } });
const sidePoint = addPoint(sideSketch, [0, 0], true);
const sideBuilt = holesInModel({ sketch: sidePoint.sketch, points: [{ id: sidePoint.id, at: [0, 0] }], pose: IDENTITY_POSE, sizes });
if (!("op" in sideBuilt)) throw new Error(sideBuilt.error);
const sideHole = sideBuilt.op.steps[0]!;
check("a side face drills along −W", sideHole.kind === "hole" && near(sideHole.axis[0]!, -1) && near(sideHole.axis[1]!, 0) && near(sideHole.axis[2]!, 0));

const pose: Affine = { m: eulerOrient(0, 0, 90), t: [3, 0, 0] };
const posed = toSolidOp(group, pose);
check("a pose moves every hole and leaves the source", posed.kind === "group" && posed.steps.length === 3 && sketchHoleSource(posed)?.points.length === 3);
const moved = posed.kind === "group" ? posed.steps[0] : null;
check("the first hole follows the pose", moved?.kind === "hole" && near(moved.origin[0], 10) && near(moved.origin[1], -7) && near(moved.origin[2], 20));

eq("step 2 of 3 is the second hole", refusedHole(2, 3), 2);
eq("a missing step highlights nothing", refusedHole(undefined, 3), undefined);
eq("a step past the end highlights nothing", refusedHole(4, 3), undefined);

const marks = holeMarks(group, IDENTITY_POSE, () => 99);
eq("the ghosts follow the steps", marks.map((mark) => mark.origin), [[10, 10, 20], [15, 10, 20], [6, 13, 20]]);
eq("a blind ghost uses the typed depth", marks[0]?.depth, 8);
const throughMarks = holeMarks(bored.op, IDENTITY_POSE, () => 20);
eq("a through ghost uses the reach it was given", throughMarks[0]?.depth, 20);
eq("a counterbore ghost keeps the bore", throughMarks[0]?.bore, { radius: 3, depth: 3.2 });

const root = { kind: "primitive" as const, solid: { primitive: "box" as const, origin: [0, 0, 0] as [number, number, number], size: [20, 20, 20] as [number, number, number], radius: 0, height: 0, turn: [0, 0, 0] as [number, number, number] } };
const fp = { volumeMm3: 8000, faces: 6, edges: 12 };
let tree = withChild(newTree("box", root, "Box", fp), 0, { id: 1, op: group, label: group.label, fingerprint: fp });
eq("a sketch-hole group can be edited", editRefusal(tree, 1), null);
const panel = editPanel(group, IDENTITY_POSE, [10, 10, 10]);
eq("History Edit reopens the Hole panel", panel.tool, "hole");
eq("the panel keeps the radius and depth", { r: panel.fields.modelHoleR, d: panel.fields.modelHoleD }, { r: 2, d: 8 });
eq("the drill stays the step's axis", panel.axis, [0, 0, -1]);
check("through and the counterbore stay off", panel.hole?.through === false && panel.hole?.counterbore === false);
eq("sketchHolePanel agrees", sketchHolePanel(group, IDENTITY_POSE)?.fields.modelHoleR, 2);

const file = JSON.parse(JSON.stringify({ ...savedTree(tree, 1, () => undefined), rootPrimitive: root.solid }));
const opened = readSavedTree(file);
eq("the group round-trips with its source and three holes", opened?.nodes[1]?.op, group);
const openedTree = opened && loadedTree(opened, "box2", root, "Box", null, () => undefined);
eq("it opens as one history row", openedTree?.nodes.get(1)?.label, "3 holes ⌀4 depth 8");

const plain: ModelOp = { kind: "group", label: "Edges", steps: [{ kind: "hole", origin: [0, 0, 1], axis: [0, 0, -1], radius: 1, depth: 1 }] };
check("a hole group with no sketch source is not this package", !isSketchHoleGroup(plain));

const holeContext = {
  read: (field: string) => (field === "modelHoleR" ? 2 : field === "modelHoleD" ? 8 : 0),
  primitive: "box" as const,
  center: [5, 5, 5] as [number, number, number],
  extent: 10,
  split: null,
  edge: null,
  hole: { through: false, counterbore: false },
  pull: null,
  sketchHoles: true,
};
const knobs = handlesFor("hole", holeContext).map((handle) => handle.id);
eq("one hole per point drags radius and depth, not the origin", knobs, ["hole-radius", "hole-depth"]);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("sketch holes ok");
