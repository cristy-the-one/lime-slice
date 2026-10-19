/**
 * Trim, extend, offset, corner fillet, mirror, and copies.
 */
import { extend, filletCorner, linearCopy, mirror, offset, polarCopy, trim } from "./edit.ts";
import { addArc, addCircle, addLine, addPoint, addSpline, emptySketch, sketchPoint, type SketchData, type SketchEntity } from "./model.ts";

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
function near(name: string, got: readonly number[], want: readonly number[], tol = 1e-6) {
  const ok = got.length === want.length && got.every((value, i) => Math.abs(value - want[i]!) <= tol);
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
}

function lineEnds(sketch: SketchData, entity: SketchEntity): [number, number, number, number] | null {
  if (entity.kind !== "line") return null;
  const a = sketchPoint(sketch, entity.a);
  const b = sketchPoint(sketch, entity.b);
  if (!a || !b) return null;
  return [a.at[0], a.at[1], b.at[0], b.at[1]];
}

function rect(width: number, height: number) {
  let sketch = emptySketch();
  const a = addPoint(sketch, [0, 0]);
  sketch = a.sketch;
  const b = addPoint(sketch, [width, 0]);
  sketch = b.sketch;
  const c = addPoint(sketch, [width, height]);
  sketch = c.sketch;
  const d = addPoint(sketch, [0, height]);
  sketch = d.sketch;
  const bottom = addLine(sketch, a.id, b.id);
  sketch = bottom.sketch;
  const right = addLine(sketch, b.id, c.id);
  sketch = right.sketch;
  const top = addLine(sketch, c.id, d.id);
  sketch = top.sketch;
  const left = addLine(sketch, d.id, a.id);
  return { sketch: left.sketch, ids: [bottom.id, right.id, top.id, left.id] };
}

const crossed = addLine(emptySketch(), [0, 0], [10, 0]);
const cut3 = addLine(crossed.sketch, [3, -2], [3, 2]);
const cut7 = addLine(cut3.sketch, [7, -2], [7, 2]);
const beforeTrim = JSON.stringify(cut7.sketch);
const trimmed = trim(cut7.sketch, crossed.id, [5, 0]);
eq("trimming the middle leaves the two outer pieces", trimmed.error, undefined);
const survivors = trimmed.sketch.entities
  .filter((entity) => entity.kind === "line")
  .map((entity) => lineEnds(trimmed.sketch, entity))
  .filter((ends): ends is [number, number, number, number] => !!ends && Math.abs(ends[1]) < 1e-9 && Math.abs(ends[3]) < 1e-9);
eq("the kept pieces run 0 to 3 and 7 to 10", survivors, [[0, 0, 3, 0], [7, 0, 10, 0]]);
eq("the sketch that was trimmed is unchanged", JSON.parse(beforeTrim), cut7.sketch);

const bar = addLine(emptySketch(), [0, 0], [10, 0]);
const oneCut = addLine(bar.sketch, [3, -2], [3, 2]);
const trimmedEnd = trim(oneCut.sketch, bar.id, [8, 0]);
const keptEnd = trimmedEnd.sketch.entities
  .filter((entity) => !entity.construction && entity.kind === "line" && entity.id !== oneCut.id)
  .map((entity) => lineEnds(trimmedEnd.sketch, entity));
eq("trimming a dangling end keeps the other side", keptEnd, [[0, 0, 3, 0]]);

const alone = addLine(emptySketch(), [0, 0], [4, 0]);
const gone = trim(alone.sketch, alone.id, [2, 0]);
eq("a line with nothing crossing it is removed", gone.sketch.entities, []);
eq("its points go with it", gone.sketch.points, []);

const wall = addLine(emptySketch(), [0, 0], [10, 0]);
const guide = addLine(wall.sketch, [4, -1], [4, 1], true);
const guided = trim(guide.sketch, wall.id, [8, 0]);
const guidedEnds = guided.sketch.entities
  .filter((entity) => !entity.construction)
  .map((entity) => lineEnds(guided.sketch, entity));
eq("a construction line still cuts", guidedEnds, [[0, 0, 4, 0]]);
check("and stays in the sketch", guided.sketch.entities.some((entity) => entity.construction === true));

const disk = addCircle(emptySketch(), [0, 0], 5);
const diameter = addLine(disk.sketch, [0, -6], [0, 6]);
const half = trim(diameter.sketch, disk.id, [5, 0]);
const arc = half.sketch.entities.find((entity) => entity.kind === "arc");
check("trimming a circle on its right leaves one arc", !!arc && arc.kind === "arc");
if (arc && arc.kind === "arc") {
  const start = sketchPoint(half.sketch, arc.a);
  const end = sketchPoint(half.sketch, arc.b);
  near("the arc runs the left semicircle", [...(start?.at ?? []), ...(end?.at ?? []), ...arc.through], [0, 5, 0, -5, -5, 0]);
}

eq("a missing trim target is refused", trim(alone.sketch, 99, [0, 0]).error, "Click a line, arc, circle, or spline to trim.");

const stub = addLine(emptySketch(), [0, 0], [5, 0]);
const fence = addLine(stub.sketch, [8, -3], [8, 3]);
const grown = extend(fence.sketch, stub.id, [4.5, 0]);
const grownLine = grown.sketch.entities.find((entity) => entity.id === stub.id);
const grownEnds = grownLine ? lineEnds(grown.sketch, grownLine) : null;
eq("a line grows to the next wall", grownEnds, [0, 0, 8, 0]);
eq("the fence is left where it was", extend(fence.sketch, stub.id, [4.5, 0]).sketch.entities.find((entity) => entity.id === fence.id) && fence.sketch.entities.length, 2);

const lonely = addLine(emptySketch(), [0, 0], [5, 0]);
eq("nothing to meet refuses the extend", extend(lonely.sketch, lonely.id, [5, 0]).error, "Extend this end until it meets another line or arc. Nothing is in the way yet.");
eq("and leaves the line", extend(lonely.sketch, lonely.id, [5, 0]).sketch, lonely.sketch);
const round = addCircle(emptySketch(), [0, 0], 5);
eq("a circle cannot be extended", extend(round.sketch, round.id, [5, 0]).error, "A circle is already closed.");
const loop = addSpline(emptySketch(), [[0, 0], [1, 1], [0, 2], [0, 0]]);
const loopEntity = loop.sketch.entities[0]!;
eq("a closed spline cannot be extended", extend(loop.sketch, loopEntity.id, [1, 1]).error, "A closed spline has no end to extend.");

const flat = addLine(emptySketch(), [0, 0], [10, 0]);
const raised = offset(flat.sketch, [flat.id], 5);
const raisedLine = raised.sketch.entities.find((entity) => entity.id !== flat.id);
eq("a line offsets to its left", raisedLine ? lineEnds(raised.sketch, raisedLine) : null, [0, 5, 10, 5]);
check("the original line stays", raised.sketch.entities.some((entity) => entity.id === flat.id));
eq("a zero offset is refused", offset(flat.sketch, [flat.id], 0).error, "An offset needs a distance other than 0.");
eq("an empty selection is refused", offset(flat.sketch, [], 1).error, "Select a line, arc, circle, or spline to offset.");

const box = rect(10, 6);
const beforeOffset = JSON.stringify(box.sketch);
const inset = offset(box.sketch, box.ids, 1);
eq("offsetting a loop does not change the original", JSON.parse(beforeOffset), box.sketch);
const fresh = inset.sketch.entities.filter((entity) => !box.ids.includes(entity.id));
eq("the inset is four new lines", fresh.length, 4);
const corners = fresh.flatMap((entity) => {
  const ends = lineEnds(inset.sketch, entity);
  return ends ? [[ends[0], ends[1]], [ends[2], ends[3]]] : [];
});
const key = (pt: number[]) => `${pt[0]},${pt[1]}`;
eq(
  "a counter-clockwise rectangle shrinks",
  [...new Set(corners.map(key))].sort(),
  ["1,1", "1,5", "9,1", "9,5"],
);
const tooFar = offset(box.sketch, box.ids, 4);
eq("an offset that eats the shape is refused", tooFar.error, "That offset is larger than this shape. Use a smaller one.");
eq("and the sketch is the one that was given", tooFar.sketch, box.sketch);
const grownBox = offset(box.sketch, box.ids, -1);
const outer = grownBox.sketch.entities
  .filter((entity) => !box.ids.includes(entity.id))
  .flatMap((entity) => {
    const ends = lineEnds(grownBox.sketch, entity);
    return ends ? [[ends[0], ends[1]], [ends[2], ends[3]]] : [];
  });
eq(
  "a negative offset grows the rectangle",
  [...new Set(outer.map(key))].sort(),
  ["-1,-1", "-1,7", "11,-1", "11,7"],
);

const circle = addCircle(emptySketch(), [0, 0], 5);
const bigger = offset(circle.sketch, [circle.id], 2);
const biggerCircle = bigger.sketch.entities.find((entity) => entity.kind === "circle" && entity.id !== circle.id);
eq("a positive circle offset grows the radius", biggerCircle && biggerCircle.kind === "circle" ? biggerCircle.radius : 0, 7);
const eaten = offset(circle.sketch, [circle.id], -5);
eq("a circle offset past the centre is refused", eaten.error, "That offset is larger than the circle. Use a smaller one.");
const smaller = offset(circle.sketch, [circle.id], -4);
const smallerCircle = smaller.sketch.entities.find((entity) => entity.kind === "circle" && entity.id !== circle.id);
eq("a smaller circle keeps a positive radius", smallerCircle && smallerCircle.kind === "circle" ? smallerCircle.radius : 0, 1);

const quarter = addArc(emptySketch(), [1, 0], [0, 1], [Math.SQRT1_2, Math.SQRT1_2]);
const bowed = offset(quarter.sketch, [quarter.id], -1);
const bowedArc = bowed.sketch.entities.find((entity) => entity.kind === "arc" && entity.id !== quarter.id);
check("the grown quarter is an arc", !!bowedArc && bowedArc.kind === "arc");
if (bowedArc && bowedArc.kind === "arc") {
  const start = sketchPoint(bowed.sketch, bowedArc.a);
  const end = sketchPoint(bowed.sketch, bowedArc.b);
  near("it keeps the quarter and doubles the radius", [...(start?.at ?? []), ...(end?.at ?? []), ...bowedArc.through], [2, 0, 0, 2, Math.SQRT2, Math.SQRT2]);
}

const curve = addSpline(emptySketch(), [[0, 0], [5, 0], [10, 0]]);
const lifted = offset(curve.sketch, [curve.id], 2);
const liftedSpline = lifted.sketch.entities.find((entity) => entity.kind === "spline" && entity.id !== curve.id);
check("a spline offsets to a new spline", !!liftedSpline && liftedSpline.kind === "spline");
if (liftedSpline && liftedSpline.kind === "spline") {
  const ys = liftedSpline.through.map((id) => sketchPoint(lifted.sketch, id)?.at[1] ?? NaN);
  check("its samples sit about the offset distance above the curve", ys.length >= 2 && ys.every((y) => Math.abs(y - 2) < 0.05));
}

let corner = emptySketch();
const origin = addPoint(corner, [0, 0]);
corner = origin.sketch;
const east = addPoint(corner, [4, 0]);
corner = east.sketch;
const north = addPoint(corner, [0, 4]);
corner = north.sketch;
const horizontal = addLine(corner, east.id, origin.id);
corner = horizontal.sketch;
const vertical = addLine(corner, origin.id, north.id);
corner = vertical.sketch;
const rounded = filletCorner(corner, horizontal.id, vertical.id, 2);
eq("a fillet adds the arc and keeps both lines", rounded.sketch.entities.map((entity) => entity.kind), ["line", "line", "arc"]);
const filletArc = rounded.sketch.entities.find((entity) => entity.kind === "arc");
if (filletArc && filletArc.kind === "arc") {
  const start = sketchPoint(rounded.sketch, filletArc.a);
  const end = sketchPoint(rounded.sketch, filletArc.b);
  const ends = [start?.at ?? [], end?.at ?? []].sort((p, q) => (p[0] ?? 0) - (q[0] ?? 0) || (p[1] ?? 0) - (q[1] ?? 0));
  near("the arc meets the lines at the tangent points", [...(ends[0] ?? []), ...(ends[1] ?? [])], [0, 2, 2, 0]);
  near("and bulges through the quarter circle", filletArc.through, [2 - Math.SQRT2, 2 - Math.SQRT2]);
}
eq("a radius that does not fit is refused", filletCorner(corner, horizontal.id, vertical.id, 20).error, "That radius does not fit these two lines. Use a smaller one.");
const parallelA = addLine(emptySketch(), [0, 0], [4, 0]);
const parallelB = addLine(parallelA.sketch, [0, 1], [4, 1]);
eq(
  "parallel lines are refused",
  filletCorner(parallelB.sketch, parallelA.id, parallelB.id, 1).error,
  "These lines do not meet, so there is no corner to round.",
);
const straightA = addLine(emptySketch(), [0, 0], [2, 0]);
const straightB = addLine(straightA.sketch, [2, 0], [5, 0]);
eq(
  "a straight run is refused",
  filletCorner(straightB.sketch, straightA.id, straightB.id, 1).error,
  "These lines are straight, so there is no corner to round.",
);

const source = addLine(emptySketch(), [0, 0], [1, 0]);
const mirrored = mirror(source.sketch, [source.id], [2, 0], [2, 1]);
const image = mirrored.sketch.entities.find((entity) => entity.id !== source.id);
eq("a mirror across x = 2 flips the line", image ? lineEnds(mirrored.sketch, image) : null, [4, 0, 3, 0]);
check("the source line is still there", mirrored.sketch.entities.some((entity) => entity.id === source.id));
eq("a zero-length axis is refused", mirror(source.sketch, [source.id], [0, 0], [0, 0]).error, "Pick an axis of two different points to mirror across.");
eq("mirroring nothing is refused", mirror(source.sketch, [], [0, 0], [0, 1]).error, "Select something to mirror.");

const copied = linearCopy(source.sketch, [source.id], [10, 0], 2);
const copies = copied.sketch.entities.map((entity) => lineEnds(copied.sketch, entity));
eq("two steps land at 10 and at 20", copies, [[0, 0, 1, 0], [10, 0, 11, 0], [20, 0, 21, 0]]);
eq("a copy needs a count", linearCopy(source.sketch, [source.id], [1, 0], 0).error, "A copy needs a count of at least 1.");
eq("a copy needs a distance", linearCopy(source.sketch, [source.id], [0, 0], 1).error, "A copy needs a distance.");

const spoke = addLine(emptySketch(), [1, 0], [2, 0]);
const spun = polarCopy(spoke.sketch, [spoke.id], [0, 0], 90, 3);
const spokes = spun.sketch.entities.map((entity) => lineEnds(spun.sketch, entity) ?? []);
near(
  "three quarter-turns go around the origin",
  spokes.flat(),
  [1, 0, 2, 0, 0, 1, 0, 2, -1, 0, -2, 0, 0, -1, 0, -2],
  1e-9,
);
eq("a round copy needs an angle", polarCopy(spoke.sketch, [spoke.id], [0, 0], 0, 2).error, "A round copy needs an angle other than 0.");
eq("the sketch that was copied is unchanged", polarCopy(spoke.sketch, [spoke.id], [0, 0], 90, 1).sketch !== spoke.sketch && spoke.sketch.entities.length, 1);


// A trimmed spline keeps a few points along the kept piece, not every 0.5 mm sample of the old one.
{
  const controls: [number, number][] = [];
  for (let x = 0; x <= 120; x += 20) controls.push([x, 6 * Math.sin(x / 15)]);
  const wave = addSpline(emptySketch(), controls);
  const cutter = addLine(wave.sketch, [100, -10], [100, 10]);
  const kept = trim(cutter.sketch, wave.id, [110, 6 * Math.sin(110 / 15)]);
  const spline = kept.sketch.entities.find((entity) => entity.kind === "spline");
  check("the trim keeps a spline", !kept.error && !!spline);
  const count = spline && spline.kind === "spline" ? spline.through.length : 0;
  check(`the kept spline has a few points (${count}), not hundreds`, count >= 3 && count <= 40);
  const kept2 = spline && spline.kind === "spline" ? spline.through.map((id) => sketchPoint(kept.sketch, id)!.at) : [];
  check("and they lie on the old wave", kept2.every((at) => Math.abs(at[1] - 6 * Math.sin(at[0] / 15)) < 0.5));
}

// A trim of a long wave stays quick.
{
  const controls: [number, number][] = [];
  for (let x = 0; x <= 600; x += 15) controls.push([x, 8 * Math.sin(x / 9)]);
  const wave = addSpline(emptySketch(), controls);
  const cutter = addLine(wave.sketch, [590, -20], [590, 20]);
  const started = performance.now();
  const kept = trim(cutter.sketch, wave.id, [595, 8 * Math.sin(595 / 9)]);
  const took = performance.now() - started;
  check(`trimming a 600 mm wave takes under a second (${took.toFixed(0)} ms)`, !kept.error && took < 1000);
}
if (failed) {
  console.error(`edit: ${failed} failed`);
  throw new Error(`edit: ${failed} failed`);
}
console.log("edit: trim, offset, and copies ok");
