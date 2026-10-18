/**
 * Intersections, projection, arcs, fillets, and spline sampling.
 */
import {
  arcFrom3,
  arcParam,
  arcPoint,
  arcTangent,
  circleCircleHits,
  cornerFillet,
  curveIntersect,
  curveOf,
  curveProject,
  dist,
  lineCircleHits,
  lineLineHit,
  mirrorPoint,
  projectToArc,
  projectToSegment,
  rotatePoint,
  sampleSpline,
  segmentSegmentHits,
  tangentArc,
} from "./geom.ts";
import { addArc, addCircle, addLine, addSpline, emptySketch, type Pt } from "./model.ts";

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
function near(name: string, got: readonly number[], want: readonly number[], tol = 1e-8) {
  if (got.length === want.length && got.every((value, i) => Math.abs(value - want[i]!) <= tol)) return;
  failed += 1;
  console.error(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
}
const cross = lineLineHit([0, 0], [4, 4], [0, 4], [4, 0]);
near("two lines cross at their middle", cross?.pt ?? [], [2, 2]);
check("parallel lines do not meet", lineLineHit([0, 0], [1, 0], [0, 1], [1, 1]) === null);
const tee = segmentSegmentHits([0, 0], [4, 0], [2, -1], [2, 1]);
near("a T-junction is an intersection", tee[0]?.pt ?? [], [2, 0]);
eq("a miss is no intersection", segmentSegmentHits([0, 0], [1, 0], [0, 1], [1, 2]).length, 0);
const overlap = segmentSegmentHits([0, 0], [4, 0], [2, 0], [6, 0]);
eq("a collinear overlap splits at both ends of the overlap", overlap.map((hit) => hit.pt[0]).sort((a, b) => a - b), [2, 4]);

const lineCircle = lineCircleHits([3, -10], [3, 10], [0, 0], 5);
eq("a line meets a circle twice", lineCircle.length, 2);
check("at the two heights", lineCircle.every((hit) => Math.abs(Math.abs(hit.pt[1]) - 4) < 1e-8 && Math.abs(hit.pt[0] - 3) < 1e-8));
eq("a line misses a circle", lineCircleHits([10, -1], [10, 1], [0, 0], 5).length, 0);
eq("a tangent is one point", lineCircleHits([5, -1], [5, 1], [0, 0], 5).length, 1);

const circles = circleCircleHits([0, 0], 5, [6, 0], 5);
eq("two circles meet twice", circles.length, 2);
check("at (3, ±4)", circles.some((pt) => Math.hypot(pt[0] - 3, pt[1] - 4) < 1e-8) && circles.some((pt) => Math.hypot(pt[0] - 3, pt[1] + 4) < 1e-8));
eq("separate circles miss", circleCircleHits([0, 0], 1, [5, 0], 1).length, 0);
eq("one circle inside another misses", circleCircleHits([0, 0], 5, [1, 0], 1).length, 0);
eq("the same circle is not a pair of points", circleCircleHits([0, 0], 5, [0, 0], 5).length, 0);

const quarter = arcFrom3([1, 0], [Math.SQRT1_2, Math.SQRT1_2], [0, 1]);
check("three points of a quarter circle make that circle", !!quarter && Math.hypot(quarter.centre[0], quarter.centre[1]) < 1e-8 && Math.abs(quarter.radius - 1) < 1e-8);
check("and the sweep is a quarter turn", !!quarter && Math.abs(quarter.sweep - Math.PI / 2) < 1e-8);
const semi = arcFrom3([1, 0], [0, 1], [-1, 0]);
check("a semicircle sweeps half a turn", !!semi && Math.abs(semi.sweep - Math.PI) < 1e-8);
eq("collinear points are not an arc", arcFrom3([0, 0], [1, 0], [2, 0]), null);
eq("a repeated point is not an arc", arcFrom3([0, 0], [0, 0], [1, 0]), null);

const tangent = tangentArc([1, 0], [0, 1], [0, 1]);
check("a tangent arc ends on the point", !!tangent && dist(arcPoint(tangent, 1), [0, 1]) < 1e-8);
check("and leaves along the requested direction", !!tangent && arcTangent(tangent, 0)[0] * 0 + arcTangent(tangent, 0)[1] * 1 > 0.99);
check("a point on the tangent line is not an arc", tangentArc([0, 0], [1, 0], [5, 0]) === null);
check("a point on the arc reports its parameter", !!quarter && Math.abs((arcParam(quarter, [0, 1]) ?? -1) - 1) < 1e-8);
check("a point on the circle but off the arc does not", !!quarter && arcParam(quarter, [0, -1]) === null);

let sketch = emptySketch();
sketch = addLine(sketch, [0, 0], [4, 0]).sketch;
sketch = addArc(sketch, [0, 0], [2, 0], [1, 1]).sketch;
const line = curveOf(sketch, sketch.entities[0]!);
const arc = curveOf(sketch, sketch.entities[1]!);
check("a line meets an arc where the arc crosses it", !!line && !!arc && curveIntersect(line, arc).some((hit) => Math.hypot(hit.pt[0] - 2, hit.pt[1]) < 1e-6));

const upper = arcFrom3([1, 0], [0, 1], [-1, 0])!;
const lower = arcFrom3([1, 0], [0, -1], [-1, 0])!;
// Two semicircles of the same circle meet at their ends. A second circle crosses both.
sketch = addCircle(emptySketch(), [0, 0], 5).sketch;
sketch = addCircle(sketch, [6, 0], 5).sketch;
const hits = curveIntersect(curveOf(sketch, sketch.entities[0]!)!, curveOf(sketch, sketch.entities[1]!)!);
eq("circle meets circle at two points", hits.length, 2);

const clamped = projectToSegment([0, 0], [10, 0], [12, 3]);
near("projection onto a segment stops at the end", clamped?.pt ?? [], [10, 0]);
eq("and the parameter is the end", clamped?.t, 1);
const mid = projectToSegment([0, 0], [10, 0], [4, 3]);
near("projection onto the middle", mid?.pt ?? [], [4, 0]);
const onArc = projectToArc(upper, [0, 2]);
near("projection onto an arc hits the arc", onArc.pt, [0, 1]);
const offArc = projectToArc(upper, [0, -2]);
check("projection off an arc falls to an end", Math.hypot(offArc.pt[1], 0) < 1e-8 && Math.abs(Math.abs(offArc.pt[0]) - 1) < 1e-8);

const controls: Pt[] = [[0, 0], [1, 2], [3, 3], [5, 1]];
const samples = sampleSpline(controls, false, 0.5);
for (const control of controls) {
  check(`the spline passes through ${control}`, samples.some((point) => dist(point, control) <= 1e-9));
}
const closed = sampleSpline([[0, 0], [2, 1], [1, 3]], true, 0.5);
check("a closed spline returns to its start", dist(closed[0]!, closed[closed.length - 1]!) <= 1e-9);
const splineSketch = addSpline(emptySketch(), controls).sketch;
const splineCurve = curveOf(splineSketch, splineSketch.entities[0]!)!;
const projected = curveProject(splineCurve, [1, 2]);
check("projection onto a spline can land on a control", !!projected && projected.distance < 1e-6);

const fillet = cornerFillet([0, 0], [10, 0], [0, 0], [0, 10], 2);
if ("error" in fillet) check("a right-angle fillet is built", false);
else {
  near("the tangent points sit one radius along each line", fillet.tangentA, [2, 0]);
  near("and along the other", fillet.tangentB, [0, 2]);
  near("the arc passes closest to the corner on the bisector", fillet.through, [2 - Math.SQRT2, 2 - Math.SQRT2]);
  check("and that point is on the circle", Math.abs(dist(fillet.through, fillet.centre) - 2) < 1e-8);
}
eq("a radius of 0 is refused", cornerFillet([0, 0], [1, 0], [0, 0], [0, 1], 0), { error: "A corner round needs a radius above 0." });
eq("parallel lines are refused", "error" in cornerFillet([0, 0], [1, 0], [0, 2], [1, 2], 1) && (cornerFillet([0, 0], [1, 0], [0, 2], [1, 2], 1) as { error: string }).error, "These lines do not meet, so there is no corner to round.");
eq("a radius larger than the lines is refused", cornerFillet([0, 0], [1, 0], [0, 0], [0, 1], 5), { error: "That radius does not fit these two lines. Use a smaller one." });
eq("a straight pair is refused", cornerFillet([0, 0], [2, 0], [2, 0], [4, 0], 0.5), { error: "These lines are straight, so there is no corner to round." });

near("a point mirrors across a vertical axis", mirrorPoint([0, 1], [2, 0], [2, 5]) ?? [], [4, 1]);
eq("an axis with no length does not mirror", mirrorPoint([0, 0], [1, 1], [1, 1]), null);
near("a quarter turn about the origin", rotatePoint([1, 0], [0, 0], Math.PI / 2), [0, 1]);

void lower;

if (failed) {
  console.error(`geom: ${failed} failed`);
  throw new Error(`geom: ${failed} failed`);
}
console.log("geom: intersections, arcs, and splines ok");
