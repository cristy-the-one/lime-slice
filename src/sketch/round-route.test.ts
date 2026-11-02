/**
 * --- S3. Round corners: a sharp route corner is filleted as Fillet corner would, at the smallest radius the sweep
 * builds with, and the sweep it stores is the strict path's sweep of the same drawing. ---
 */
import { planeOf } from "./frame.ts";
import { filletCorner } from "./edit.ts";
import { addArc, addCircle, addLine, emptySketch, type SketchData } from "./model.ts";
import { sharpCorners } from "./reasons.ts";
import { sketchRegions } from "./regions.ts";
import { roundRouteCorners, roundUpRadius, routeCornerLines, smallestRouteRadius } from "./round-route.ts";
import { SHARP_CORNER, buildSketchSweep, oneSketchSweep, openChain, pipeProfile, standUpProfile } from "./sweep.ts";

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

/** An L route on the bed: 40 mm along X from (10, 0), then 30 mm along Y. Lines 1 and 2 share the corner (50, 0). */
function lRoute(sketch: SketchData): { sketch: SketchData; lines: [number, number] } {
  const first = addLine(sketch, [10, 0], [50, 0]);
  const corner = first.sketch.entities.at(-1)!;
  const cornerPoint = corner.kind === "line" ? corner.b : -1;
  const second = addLine(first.sketch, cornerPoint, [50, 30]);
  return { sketch: second.sketch, lines: [corner.id, second.sketch.entities.at(-1)!.id] };
}

/** The S1 sweep of a one-sketch drawing, as the card builds it. */
function oneSketchOp(sketch: SketchData) {
  const split = oneSketchSweep(sketch);
  const stood = split ? standUpProfile(split) : null;
  if (!stood) return { error: "no split" };
  return buildSketchSweep({ profileSketch: stood.profileSketch, profile: stood.profile, path: stood.path, check: stood.check, pathSketch: stood.pathSketch, scale: 1, mode: "new" });
}

eq("a radius rounds up to half millimetres", [roundUpRadius(3), roundUpRadius(3.01), roundUpRadius(0.1), roundUpRadius(4.5)], [3, 3.5, 0.5, 4.5]);

// --- S1 with an L route: refused as drawn, rounded at the circle's radius or more, and swept in one Apply. ---
{
  const { sketch, lines } = lRoute(addCircle(emptySketch(), [0, 0], 3).sketch);
  const asDrawn = oneSketchOp(sketch);
  eq("as drawn, the L's corner is refused", "error" in asDrawn ? asDrawn.error : "", SHARP_CORNER);
  const split = oneSketchSweep(sketch)!;
  const stood = standUpProfile(split)!;
  const corners = sharpCorners(stood.path, stood.check);
  eq("one sharp corner, at (50, 0)", corners, [[50, 0, 0]]);
  const ids = routeCornerLines(sketch, corners);
  eq("the corner is the two lines of the L", ids, [lines]);
  const found = ids ? smallestRouteRadius(sketch, ids, 3, (rounded) => "op" in oneSketchOp(rounded)) : null;
  check("a radius is found", found != null);
  if (found && ids) {
    check("the radius is at least the circle's", found.radius >= 3);
    check("and the smallest that sweeps: a step less doesn't", found.radius === 3 || !("op" in oneSketchOp((roundRouteCorners(sketch, ids, found.radius - 0.5) as { sketch: SketchData }).sketch)));
    // The arcs are Fillet corner's arcs, at the same radius.
    const byFillet = filletCorner(sketch, lines[0], lines[1], found.radius);
    eq("the drawing is the one Fillet corner makes", found.sketch, byFillet.sketch);
    eq("one arc is added", found.sketch.entities.map((entity) => entity.kind), ["circle", "line", "line", "arc"]);

    // The strict path: the circle drawn by hand on a plane facing +X at the route's start, and the route alone,
    // its corner rounded with Fillet corner.
    const easy = oneSketchOp(found.sketch);
    const route = byFillet.sketch;
    const routeEntities = route.entities.filter((entity) => entity.kind !== "circle");
    const usedByRoute = (id: number) => routeEntities.some((entity) => (entity.kind === "line" || entity.kind === "arc") && (entity.a === id || entity.b === id));
    const routeOnly: SketchData = { ...emptySketch(), points: route.points.filter((point) => usedByRoute(point.id)), entities: routeEntities };
    const chain = openChain(routeOnly)!;
    const forward = chain.path[0]![0] === 10 ? chain : { path: [...chain.path].reverse(), check: [...chain.check].reverse() };
    const byHand = addCircle(emptySketch(planeOf({ origin: [10, 0, 0], u: [0, 0, -1], v: [0, 1, 0], w: [1, 0, 0] })), [0, 0], 3).sketch;
    const strict = buildSketchSweep({ profileSketch: byHand, profile: sketchRegions(byHand)[0]!, path: forward.path, check: forward.check, pathSketch: routeOnly, scale: 1, mode: "new" });
    check("both ways build", "op" in easy && "op" in strict);
    eq("Round corners stores the strict path's sweep", "op" in easy ? easy.op : null, "op" in strict ? strict.op : null);
  }
}

// --- S2 with an L route: an 8 mm pipe needs at least a 4 mm radius. ---
{
  const { sketch } = lRoute(emptySketch());
  const pipeOf = (drawing: SketchData) => {
    const made = pipeProfile(drawing, openChain(drawing)!, 8, 0);
    return "error" in made ? made : buildSketchSweep({ ...made, scale: 1, mode: "new" });
  };
  eq("a pipe along the L is refused as drawn", (pipeOf(sketch) as { error?: string }).error, SHARP_CORNER);
  const chain = openChain(sketch)!;
  const ids = routeCornerLines(sketch, sharpCorners(chain.path, chain.check));
  const found = ids ? smallestRouteRadius(sketch, ids, 4, (rounded) => "op" in pipeOf(rounded)) : null;
  check("the pipe's corner is rounded", found != null && found.radius >= 4);
  check("and the pipe sweeps", found != null && "op" in pipeOf(found.sketch));
}

// --- Two lines whose ends sit on one spot without sharing a point are a corner too, as Fillet corner takes them. ---
{
  let sketch = addLine(emptySketch(), [0, 0], [40, 0]).sketch;
  sketch = { ...sketch, points: [...sketch.points, { id: 90, at: [40, 0] }, { id: 91, at: [40, 30] }], entities: [...sketch.entities, { id: 95, kind: "line", a: 90, b: 91 }] };
  const chain = openChain(sketch)!;
  const corners = routeCornerLines(sketch, sharpCorners(chain.path, chain.check));
  eq("the corner is found by where the ends are", corners, [[1, 95]]);
  const rounded = corners ? roundRouteCorners(sketch, corners, 5) : null;
  check("and it rounds", !!rounded && "sketch" in rounded && rounded.sketch.entities.some((entity) => entity.kind === "arc"));
}

// --- What Round corners leaves alone. ---
{
  // A corner where a line meets an arc is not two lines: Round corners isn't offered, and the reason stays.
  let sketch = addLine(emptySketch(), [0, 0], [20, 0]).sketch;
  sketch = addArc(sketch, 2, [20, 20], [30, 10]).sketch;
  eq("a line into an arc is not a corner to round", routeCornerLines(sketch, [[20, 0, 0]]), null);
  // Three lines at one point are not a route corner.
  let three = addLine(emptySketch(), [0, 0], [10, 0]).sketch;
  three = addLine(three, 2, [10, 10]).sketch;
  three = addLine(three, 2, [20, 0]).sketch;
  eq("three lines at a point are left alone", routeCornerLines(three, [[10, 0, 0]]), null);
  eq("no corners, nothing to round", routeCornerLines(three, []), null);
  // A radius larger than the lines are long is Fillet corner's refusal, and no radius is offered.
  const { sketch: short } = lRoute(emptySketch());
  const ids = routeCornerLines(short, [[50, 0, 0]])!;
  const tooBig = roundRouteCorners(short, ids, 60);
  eq("a radius that doesn't fit says so", "error" in tooBig ? tooBig.error : "", "That radius does not fit these two lines. Use a smaller one.");
  eq("nothing is offered when no radius fits", smallestRouteRadius(short, ids, 45, () => true), null);
}

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("round route tests passed");
