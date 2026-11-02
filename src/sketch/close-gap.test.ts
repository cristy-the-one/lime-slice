/**
 * --- E1. Close the gap: open ends are joined or snapped, and the extrude it makes is the extrude of the drawing
 * closed by hand. ---
 */
import { buildSketchExtrude } from "./extrude.ts";
import { closeGap, SNAP_GAP_MM } from "./close-gap.ts";
import { addArc, addCircle, addLine, emptySketch, type Pt, type SketchData } from "./model.ts";
import { openEnds } from "./reasons.ts";
import { sketchRegions } from "./regions.ts";

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

function polyline(points: Pt[], sketch = emptySketch()): SketchData {
  // Each line starts on the last one's end point, as the Line tool draws a chain.
  let out = sketch;
  let last: number | null = null;
  for (let i = 1; i < points.length; i += 1) {
    out = addLine(out, last ?? points[i - 1]!, points[i]!).sketch;
    const line = out.entities[out.entities.length - 1]!;
    last = line.kind === "line" ? line.b : null;
  }
  return out;
}

function extrudeOf(sketch: SketchData) {
  return buildSketchExtrude({ sketch, regions: sketchRegions(sketch), distance: 10, depth2: null, draftDeg: null, upTo: null, mode: "new" });
}

// A near-closed L: the last line stops 0.6 mm short of the start. A line joins the two red ends.
const lShape: Pt[] = [[0, 0], [20, 0], [20, 8], [8, 8], [8, 20], [0, 20], [0, 0.6]];
const nearL = polyline(lShape);
eq("the near-closed L has two red ends", openEnds(nearL).length, 2);
const joined = closeGap(nearL);
check("Close the gap closes the L", joined != null);
eq("one line joins the ends", joined?.joins.map((join) => join.kind), ["line"]);
eq("no red end is left", openEnds(joined!.sketch), []);
eq("the L is one shape", sketchRegions(joined!.sketch).length, 1);
// Section 7: the same extrude as the L closed by hand with a line from the first end to the last.
const lByHand = addLine(nearL, 1, nearL.points[nearL.points.length - 1]!.id).sketch;
eq("the closed drawing is the one closed by hand", joined!.sketch, lByHand);
eq("Close the gap stores the strict path's extrude", extrudeOf(joined!.sketch), extrudeOf(lByHand));
check("that extrude builds", "op" in extrudeOf(lByHand));

// Ends closer than the snap gap become one point: the later end moves onto the first.
const slip = SNAP_GAP_MM / 2;
const nearSquare = polyline([[0, 0], [10, 0], [10, 10], [0, 10], [0, slip]]);
const snapped = closeGap(nearSquare);
eq("a hairline gap is snapped, not bridged", snapped?.joins.map((join) => join.kind), ["snap"]);
eq("the snapped square has four lines", snapped?.sketch.entities.length, 4);
eq("and four corners", snapped?.sketch.points.length, 4);
const squareByHand = polyline([[0, 0], [10, 0], [10, 10], [0, 10]]);
const squareClosed = addLine(squareByHand, 4, 1).sketch;
eq("the snapped square is the square drawn closed", snapped!.sketch, squareClosed);
eq("the snapped square extrudes as the square drawn closed", extrudeOf(snapped!.sketch), extrudeOf(squareClosed));

// A point a size names is not moved: the gap gets a line instead.
const sized: SketchData = { ...nearSquare, dims: [{ id: 1, kind: "fixed", point: 5 }] };
eq("a fixed end is joined, not moved", closeGap(sized)?.joins.map((join) => join.kind), ["line"]);

// An arc and a line, a U and its open top, two gaps at once.
const dShape = addArc(emptySketch(), [0, 0], [0, 10], [5, 5]).sketch;
eq("an arc's ends close with a line into a D", closeGap(dShape)?.joins.map((join) => join.kind), ["line"]);
const u = polyline([[0, 10], [0, 0], [10, 0], [10, 10]]);
eq("a U closes across its top", sketchRegions(closeGap(u)!.sketch).length, 1);
const halves = polyline([[0, 0], [10, 0], [10, 10]], polyline([[10, 10.5], [0, 10.5], [0, 0.5]]));
const both = closeGap(halves);
eq("two gaps close at once, nearest pairs first", both?.joins.length, 2);
eq("and leave no red end", openEnds(both!.sketch), []);

// Nothing to close, or closing makes no shape.
eq("a closed square has no gap", closeGap(squareClosed), null);
eq("a circle has no gap", closeGap(addCircle(emptySketch(), [0, 0], 5).sketch), null);
eq("a lone line makes no shape", closeGap(polyline([[0, 0], [10, 0]])), null);
eq("an empty sketch has no gap", closeGap(emptySketch()), null);
const helper = addLine(polyline([[0, 0], [10, 0], [10, 10]]), [0, 0], [10, 10], true).sketch;
check("a helper line is not counted as closing", closeGap(helper) != null && closeGap(helper)!.sketch.entities.filter((entity) => !entity.construction).length === 3);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("close-gap ok");
