/**
 * --- L1. Add a shape above: the copy sits on the plane moved along the normal, and the loft it makes is the loft a
 * second sketch set up by hand on that plane makes. ---
 */
import { frameOf, toWorld } from "./frame.ts";
import { buildSketchLoft, sectionFromRegion } from "./loft.ts";
import { ABOVE_HEIGHT_MM, ABOVE_HEIGHT_REFUSAL, planeAbove, settleAbove, shapeAbove } from "./loft-above.ts";
import { addCircle, addLine, emptySketch, type SketchData, type SketchPlane } from "./model.ts";
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

function square(plane: SketchPlane, size: number, on?: SketchData["on"]): SketchData {
  let out = emptySketch(plane, on);
  out = addLine(out, [0, 0], [size, 0]).sketch;
  out = addLine(out, [size, 0], [size, size]).sketch;
  out = addLine(out, [size, size], [0, size]).sketch;
  out = addLine(out, [0, size], [0, 0]).sketch;
  return out;
}

function made(result: SketchData | { error: string }): SketchData {
  if ("error" in result) throw new Error(result.error);
  return result;
}

eq("the height opens at 20 mm", ABOVE_HEIGHT_MM, 20);

// The plane moves along its own normal and keeps its turn.
eq("XY moves straight up", planeAbove({ origin: [0, 0, 0], turn: [0, 0, 0] }, 20), { origin: [0, 0, 20], turn: [0, 0, 0] });
eq("a negative height goes below", planeAbove({ origin: [1, 2, 3], turn: [0, 0, 0] }, -5), { origin: [1, 2, -2], turn: [0, 0, 0] });
const tilted: SketchPlane = { origin: [5, 0, 2], turn: [90, 0, 30] };
const lifted = planeAbove(tilted, 12);
const base = frameOf(tilted);
const top = frameOf(lifted);
eq("a turned plane keeps its turn", lifted.turn, tilted.turn);
const rise = [0, 1, 2].map((i) => lifted.origin[i]! - tilted.origin[i]!);
check("a turned plane moves along its normal", Math.abs(rise[0]! - base.w[0] * 12) < 1e-9 && Math.abs(rise[1]! - base.w[1] * 12) < 1e-9 && Math.abs(rise[2]! - base.w[2] * 12) < 1e-9);
const corner = toWorld(base, [10, 10]);
const above = toWorld(top, [10, 10]);
check("each point lands straight above", Math.abs(Math.hypot(above[0] - corner[0], above[1] - corner[1], above[2] - corner[2]) - 12) < 1e-9);

// The copy: same drawing, new plane, no card name, no face.
const ground: SketchPlane = { origin: [0, 0, 0], turn: [0, 0, 0] };
const first = { ...square(ground, 10, { kind: "plane", name: "XY" }), name: "Sketch 1" };
const copy = made(shapeAbove(first, 20));
eq("the copy keeps the points", copy.points, first.points);
eq("the copy keeps the lines", copy.entities, first.entities);
eq("the copy is on the plane 20 above", copy.plane, { origin: [0, 0, 20], turn: [0, 0, 0] });
eq("the copy has no card name", copy.name, undefined);
eq("an origin plane stays named", copy.on, { kind: "plane", name: "XY" });
const onFace = made(shapeAbove(square(ground, 10, { kind: "face", face: { index: 1, mid: [5, 5, 0], areaMm2: 100 } }), 20));
eq("a face is not carried up", onFace.on, undefined);
eq("the first sketch is untouched", first.plane.origin, [0, 0, 0]);
eq("a zero height is refused with what to type", shapeAbove(first, 0), { error: ABOVE_HEIGHT_REFUSAL });
eq("a non-number height is refused", shapeAbove(first, Number.NaN), { error: ABOVE_HEIGHT_REFUSAL });

// Section 7: the op equals the strict path's. The strict path is a second sketch set up by hand on XY offset 20
// (the chooser's Offset field) with the same square drawn on it.
const byHand = square({ origin: [0, 0, 20], turn: [0, 0, 0] }, 10, { kind: "plane", name: "XY" });
eq("the copy is the sketch drawn by hand on the offset plane", copy, byHand);
function loftOf(second: SketchData) {
  const named = { ...second, name: "Sketch 2" };
  const picks = [first, named].map((sketch) => ({ sketch, section: sectionFromRegion(sketch, sketchRegions(sketch)[0]!) }));
  return buildSketchLoft({ picks, ruled: false, mode: "new" });
}
const assisted = loftOf(copy);
check("the assisted loft builds", "op" in assisted);
eq("Add a shape above stores the strict path's loft", assisted, loftOf(byHand));

// Square to round: a circle drawn beside the untouched copy turns the copy into helper lines.
const withCircle = addCircle(copy, [5, 5], 3).sketch;
eq("a circle inside the copy makes two shapes", sketchRegions(withCircle).length, 2);
const settled = settleAbove(copy, withCircle);
check("the untouched copy became helper lines", settled.helpers && settled.sketch.entities.filter((entity) => entity.construction).length === 4);
eq("the circle is the one shape left", sketchRegions(settled.sketch).length, 1);
const circleByHand = addCircle(square({ origin: [0, 0, 20], turn: [0, 0, 0] }, 10, { kind: "plane", name: "XY" }), [5, 5], 3).sketch;
const helpersByHand: SketchData = { ...circleByHand, entities: circleByHand.entities.map((entity) => (entity.kind === "line" ? { ...entity, construction: true as const } : entity)) };
eq("square to round stores the loft of a circle drawn by hand over helper lines", loftOf(settled.sketch), loftOf(helpersByHand));

// An edited copy is the person's shape: it is left alone.
const moved: SketchData = { ...withCircle, points: withCircle.points.map((point) => (point.id === 1 ? { ...point, at: [-2, -2] as [number, number] } : point)) };
eq("a moved copy stays solid", settleAbove(copy, moved).helpers, false);
eq("the copy alone stays solid", settleAbove(copy, copy).helpers, false);
const swapped = addCircle(emptySketch(copy.plane, copy.on), [5, 5], 3).sketch;
eq("a copy deleted and replaced is left as drawn", settleAbove(copy, swapped).sketch, swapped);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("loft-above ok");
