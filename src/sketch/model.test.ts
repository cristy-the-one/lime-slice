/**
 * The sketch document: shared points, versioned JSON, and what a bad file is refused as.
 */
import { addArc, addCircle, addLine, addPoint, addSpline, emptySketch, prunePoints, readSketch, sketchJson, type SketchData } from "./model.ts";

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

const ground = emptySketch();
eq("an empty sketch is version 1 on the ground", ground, { v: 1, plane: { origin: [0, 0, 0], turn: [0, 0, 0] }, points: [], entities: [] });

const onFace = emptySketch(
  { origin: [1, 2, 3], turn: [90, 0, 0] },
  { kind: "face", face: { index: 4, mid: [1, 2, 3], areaMm2: 12 } },
);
eq("a sketch remembers the face it was drawn on", onFace.on, { kind: "face", face: { index: 4, mid: [1, 2, 3], areaMm2: 12 } });
eq("and a named plane", emptySketch(undefined, { kind: "plane", name: "XZ" }).on, { kind: "plane", name: "XZ" });

const first = addPoint(ground, [1, 2]);
const second = addPoint(first.sketch, [3, 4], true);
eq("a free point has no fixed field", first.sketch.points[0], { id: 1, at: [1, 2] });
eq("a fixed point stores it", second.sketch.points[1], { id: 2, at: [3, 4], fixed: true });
check("adding a point does not change the sketch it was given", ground.points.length === 0);

const line = addLine(second.sketch, 1, 2);
eq("a line names its ends by id", line.sketch.entities[0], { id: 1, kind: "line", a: 1, b: 2 });
const built = addLine(ground, [0, 0], [4, 0]);
eq("a line given coordinates creates the two points", built.sketch.points.map((point) => point.at), [[0, 0], [4, 0]]);
const again = addLine(built.sketch, built.sketch.points[1]!.id, [4, 5]);
eq("a following line reuses the shared corner", again.sketch.entities.map((entity) => entity.kind === "line" && [entity.a, entity.b]), [[1, 2], [2, 3]]);

const arc = addArc(ground, [0, 0], [1, 0], [0.5, 0.5]);
eq("an arc keeps its through point as a coordinate", arc.sketch.entities[0], { id: 1, kind: "arc", a: 1, b: 2, through: [0.5, 0.5] });
const circle = addCircle(ground, [0, 0], 3, true);
eq("construction is stored only when set", circle.sketch.entities[0], { id: 1, kind: "circle", centre: 1, radius: 3, construction: true });
const openSpline = addSpline(ground, [[0, 0], [1, 1], [2, 0]]);
const openThrough = openSpline.sketch.entities[0]?.kind === "spline" ? openSpline.sketch.entities[0].through : [];
const spline = addSpline(openSpline.sketch, [...openThrough, openThrough[0] ?? 0]);
const splineEntity = spline.sketch.entities[1];
check("a repeated end closes a spline on the same point", splineEntity?.kind === "spline" && splineEntity.through[0] === splineEntity.through[3]);

const round = readSketch(sketchJson(onFace));
eq("a sketch survives JSON", round, onFace);
const withDim: SketchData = { ...ground, dims: [{ id: 1, kind: "distance", value: "wall / 2" }] };
eq("a dimension is kept unread", readSketch(JSON.parse(JSON.stringify(withDim)))?.dims, [{ id: 1, kind: "distance", value: "wall / 2" }]);

eq("the wrong version is refused", readSketch({ ...ground, v: 2 }), null);
eq("a line that names a missing point is refused", readSketch({ v: 1, plane: ground.plane, points: [], entities: [{ id: 1, kind: "line", a: 1, b: 2 }] }), null);
eq("a circle with no radius is refused", readSketch({ v: 1, plane: ground.plane, points: [{ id: 1, at: [0, 0] }], entities: [{ id: 1, kind: "circle", centre: 1, radius: 0 }] }), null);
eq("a duplicate point id is refused", readSketch({ v: 1, plane: ground.plane, points: [{ id: 1, at: [0, 0] }, { id: 1, at: [1, 0] }], entities: [] }), null);
eq("a bad plane name is refused", readSketch({ v: 1, plane: ground.plane, on: { kind: "plane", name: "AB" }, points: [], entities: [] }), null);
eq("a point that is not a pair is refused", readSketch({ v: 1, plane: ground.plane, points: [{ id: 1, at: [0] }], entities: [] }), null);

const dangling = addPoint(built.sketch, [9, 9], true);
const pruned = prunePoints(dangling.sketch);
check("an unused free point is dropped", pruned.points.every((point) => point.at[0] !== 9 || point.fixed));
check("an unused fixed point stays", pruned.points.some((point) => point.fixed === true && point.at[0] === 9));

if (failed) {
  console.error(`model: ${failed} failed`);
  throw new Error(`model: ${failed} failed`);
}
console.log("model: sketch document ok");
