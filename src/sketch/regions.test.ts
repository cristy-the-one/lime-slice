/**
 * Regions a sketch encloses: splitting, the left-turn faces, nesting, and profile v2 loops.
 */
import { arcFrom3 } from "./geom.ts";
import { addArc, addCircle, addLine, addSpline, emptySketch, type Pt, type SketchData } from "./model.ts";
import { loopSignedArea, regionAt, sketchRegions, toLoops, type ProfileLoop, type Region } from "./regions.ts";

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
function near(name: string, got: number, want: number, tol = 1e-6) {
  if (Math.abs(got - want) <= tol) return;
  failed += 1;
  console.error(`FAIL ${name}: got ${got} want ${want}`);
}

function rect(x: number, y: number, w: number, h: number, sketch = emptySketch()): SketchData {
  let next = addLine(sketch, [x, y], [x + w, y]).sketch;
  next = addLine(next, [x + w, y], [x + w, y + h]).sketch;
  next = addLine(next, [x + w, y + h], [x, y + h]).sketch;
  next = addLine(next, [x, y + h], [x, y]).sketch;
  return next;
}

function closes(loop: ProfileLoop): boolean {
  const last = loop.segments[loop.segments.length - 1];
  if (!last) return false;
  return Math.hypot(last.to[0] - loop.start[0], last.to[1] - loop.start[1]) <= 1e-6;
}

function regionAreas(sketch: SketchData): number[] {
  return sketchRegions(sketch).map((region) => region.area);
}

// A rectangle, drawn either way, is one region of the right area, counter-clockwise.
const box = rect(0, 0, 10, 6);
const boxRegions = sketchRegions(box);
eq("a rectangle is one region", boxRegions.length, 1);
near("and its area is width times height", boxRegions[0]!.area, 60);
const boxLoops = toLoops(boxRegions[0]!);
eq("with no hole", boxLoops.length, 1);
check("the loop closes", closes(boxLoops[0]!));
near("and runs counter-clockwise", loopSignedArea(boxLoops[0]!), 60);
eq("as four lines", boxLoops[0]!.segments.map((segment) => segment.kind), ["line", "line", "line", "line"]);

let clockwise = emptySketch();
clockwise = addLine(clockwise, [0, 0], [0, 6]).sketch;
clockwise = addLine(clockwise, [0, 6], [10, 6]).sketch;
clockwise = addLine(clockwise, [10, 6], [10, 0]).sketch;
clockwise = addLine(clockwise, [10, 0], [0, 0]).sketch;
const cw = sketchRegions(clockwise);
eq("a clockwise rectangle is still one region", cw.length, 1);
near("traced counter-clockwise", cw[0] ? loopSignedArea(toLoops(cw[0])[0]!) : 0, 60);

// A wall across the rectangle splits it in two.
let split = rect(0, 0, 10, 10);
split = addLine(split, [5, 0], [5, 10]).sketch;
const halves = sketchRegions(split);
eq("a wall splits a square into two regions", halves.length, 2);
near("each half has half the area", halves[0]!.area, 50);
near("and so does the other", halves[1]!.area, 50);
check("the point on the left hits the left half", regionAt(halves, [2, 5])?.area === 50);
check("and they are different regions", regionAt(halves, [2, 5]) !== regionAt(halves, [8, 5]));

// Two squares that share a side stay two regions.
let paired = rect(0, 0, 1, 1);
paired = rect(1, 0, 1, 1, paired);
const pair = sketchRegions(paired);
eq("squares that share a side are two regions", pair.length, 2);
near("their areas add to the whole", pair[0]!.area + pair[1]!.area, 2);

// A gap means two regions, neither inside the other.
const apart = rect(20, 0, 2, 2, rect(0, 0, 2, 2));
eq("two separate rectangles are two regions", sketchRegions(apart).length, 2);

// An open chain encloses nothing.
let open = emptySketch();
open = addLine(open, [0, 0], [4, 0]).sketch;
open = addLine(open, [4, 0], [4, 3]).sketch;
open = addLine(open, [4, 3], [0, 3]).sketch;
eq("an open chain has no region", sketchRegions(open).length, 0);

// Construction geometry is not part of a region, and does not split one.
let built = rect(0, 0, 8, 8);
built = addLine(built, [0, 4], [8, 4], true).sketch;
eq("a construction line does not split a rectangle", sketchRegions(built).length, 1);
near("the area is the whole rectangle", sketchRegions(built)[0]!.area, 64);

// A rectangular hole that does not touch the outside: the frame and the hole.
let frame = rect(0, 0, 10, 10);
frame = rect(3, 3, 4, 2, frame);
const nested = sketchRegions(frame);
eq("a rectangle inside a rectangle is two regions", nested.length, 2);
const ring = nested.find((region) => region.holes.length === 1);
const hole = nested.find((region) => region.holes.length === 0);
check("the frame carries the inner rectangle as a hole", !!ring && !!hole);
near("the frame's area is the difference", ring?.area ?? 0, 100 - 8);
near("the hole is the inner rectangle", hole?.area ?? 0, 8);
check("a point in the hole selects the hole", regionAt(nested, [5, 4]) === hole);
check("a point in the frame selects the frame", regionAt(nested, [1, 1]) === ring);
const frameLoops = toLoops(ring!);
eq("the frame publishes an outer loop and a hole", frameLoops.length, 2);
near("the outer loop is counter-clockwise", loopSignedArea(frameLoops[0]!), 100);
near("the hole is clockwise", loopSignedArea(frameLoops[1]!), -8);
check("both loops close", closes(frameLoops[0]!) && closes(frameLoops[1]!));

// Three deep: each region is holed only by the face directly inside it.
let rings = emptySketch();
rings = addCircle(rings, [0, 0], 10).sketch;
rings = addCircle(rings, [0, 0], 6).sketch;
rings = addCircle(rings, [0, 0], 2).sketch;
const three = sketchRegions(rings);
eq("three nested circles are three regions", three.length, 3);
const byRadius = (point: Pt) => regionAt(three, point);
near("the outer ring is π(10² − 6²)", byRadius([8, 0])?.area ?? 0, Math.PI * (100 - 36), 1e-6);
near("the middle ring is π(6² − 2²)", byRadius([4, 0])?.area ?? 0, Math.PI * (36 - 4), 1e-6);
near("the centre disk is π·2²", byRadius([0, 0])?.area ?? 0, Math.PI * 4, 1e-6);
const outer = byRadius([8, 0])!;
eq("the outer region's only hole is the middle circle", outer.holes.length, 1);
near("that hole has the middle radius", loopSignedArea(toLoops(outer)[1]!), -Math.PI * 36, 1e-4);

// A washer: the ring and the hole, arcs kept as arcs.
let washer = emptySketch();
washer = addCircle(washer, [0, 0], 10).sketch;
washer = addCircle(washer, [0, 0], 4).sketch;
const washerRegions = sketchRegions(washer);
eq("a washer is two regions", washerRegions.length, 2);
near("the ring has area π(R² − r²)", regionAt(washerRegions, [7, 0])?.area ?? 0, Math.PI * (100 - 16), 1e-4);
near("the hole has area πr²", regionAt(washerRegions, [0, 0])?.area ?? 0, Math.PI * 16, 1e-4);
const washerLoops = toLoops(regionAt(washerRegions, [7, 0])!);
check("the ring's loops are arcs", washerLoops.every((loop) => loop.segments.every((segment) => segment.kind === "arc")));
check("every arc is a real arc", washerLoops.every((loop) => {
  let prev = loop.start;
  return loop.segments.every((segment) => {
    const ok = segment.kind === "arc" && arcFrom3(prev, segment.through, segment.to) !== null;
    prev = segment.to;
    return ok;
  });
}));
near("the outer circle is counter-clockwise", loopSignedArea(washerLoops[0]!), Math.PI * 100, 1e-4);
near("the hole circle is clockwise", loopSignedArea(washerLoops[1]!), -Math.PI * 16, 1e-4);

// A circle on its own.
const disk = sketchRegions(addCircle(emptySketch(), [2, 3], 5).sketch);
eq("a circle is one region", disk.length, 1);
near("of area πr²", disk[0]!.area, Math.PI * 25, 1e-4);
const diskLoops = toLoops(disk[0]!);
check("a full circle is published as arcs, not one ambiguous turn", diskLoops[0]!.segments.length >= 2 && diskLoops[0]!.segments.every((segment) => segment.kind === "arc"));
check("and it closes", closes(diskLoops[0]!));
near("counter-clockwise", loopSignedArea(diskLoops[0]!), Math.PI * 25, 1e-4);

// A semicircular D.
let dee = emptySketch();
dee = addArc(dee, [-2, 0], [2, 0], [0, 2]).sketch;
dee = addLine(dee, [2, 0], [-2, 0]).sketch;
const deeRegions = sketchRegions(dee);
eq("a semicircle closed by its chord is one region", deeRegions.length, 1);
near("of area half a disk", deeRegions[0]!.area, Math.PI * 2, 1e-4);
const deeLoop = toLoops(deeRegions[0]!)[0]!;
check("the arc stays an arc", deeLoop.segments.some((segment) => segment.kind === "arc"));
near("counter-clockwise", loopSignedArea(deeLoop), Math.PI * 2, 1e-4);

// A rounded rectangle: width 20, height 10, corner radius 2. Area = wh − (4 − π)r².
// Each corner's through-point is the middle of the quarter circle, not the square's corner.
const s2 = Math.SQRT2;
let round = emptySketch();
round = addLine(round, [2, 0], [18, 0]).sketch;
round = addArc(round, [18, 0], [20, 2], [18 + s2, 2 - s2]).sketch;
round = addLine(round, [20, 2], [20, 8]).sketch;
round = addArc(round, [20, 8], [18, 10], [18 + s2, 8 + s2]).sketch;
round = addLine(round, [18, 10], [2, 10]).sketch;
round = addArc(round, [2, 10], [0, 8], [2 - s2, 8 + s2]).sketch;
round = addLine(round, [0, 8], [0, 2]).sketch;
round = addArc(round, [0, 2], [2, 0], [2 - s2, 2 - s2]).sketch;
const roundRegions = sketchRegions(round);
eq("a rounded rectangle is one region", roundRegions.length, 1);
near("with the exact area", roundRegions[0]!.area, 200 - (4 - Math.PI) * 4, 1e-4);
const roundLoop = toLoops(roundRegions[0]!)[0]!;
eq("lines and quarter-circles alternate", roundLoop.segments.map((segment) => segment.kind), ["line", "arc", "line", "arc", "line", "arc", "line", "arc"]);
near("and the loop's area matches", loopSignedArea(roundLoop), roundRegions[0]!.area, 1e-4);

// A bowtie splits into its two lobes.
let bow = emptySketch();
bow = addLine(bow, [0, 0], [1, 1]).sketch;
bow = addLine(bow, [1, 1], [0, 1]).sketch;
bow = addLine(bow, [0, 1], [1, 0]).sketch;
bow = addLine(bow, [1, 0], [0, 0]).sketch;
const lobes = sketchRegions(bow);
eq("a bowtie is two regions", lobes.length, 2);
near("the lobes have the same area", lobes[0]!.area, 0.25, 1e-6);
near("both of them", lobes[1]!.area, 0.25, 1e-6);

// A closed spline.
let blob = emptySketch();
blob = addSpline(blob, [[0, 0], [10, 0], [5, 8], [0, 0]]).sketch;
const blobRegions = sketchRegions(blob);
eq("a closed spline is one region", blobRegions.length, 1);
check("its area is positive", (blobRegions[0]?.area ?? 0) > 10);
const blobLoop = toLoops(blobRegions[0]!)[0]!;
const blobSpline = blobLoop.segments.find((segment) => segment.kind === "spline");
check("the spline is kept as a spline", !!blobSpline);
check("with its interior controls", blobSpline?.kind === "spline" && blobSpline.through.some((point) => point[0] === 10 && point[1] === 0) && blobSpline.through.some((point) => point[0] === 5 && point[1] === 8));
check("counter-clockwise", loopSignedArea(blobLoop) > 0);
check("it closes", closes(blobLoop));

// A circle inside a rectangle, not touching.
let window = rect(0, 0, 20, 10);
window = addCircle(window, [10, 5], 2).sketch;
const windowRegions = sketchRegions(window);
eq("a circle in a rectangle is two regions", windowRegions.length, 2);
const windowFrame = windowRegions.find((region) => region.holes.length === 1)!;
near("the frame area subtracts the disk", windowFrame.area, 200 - Math.PI * 4, 1e-4);
check("the hole loop is an arc", toLoops(windowFrame)[1]!.segments.every((segment) => segment.kind === "arc"));
near("and clockwise", loopSignedArea(toLoops(windowFrame)[1]!), -Math.PI * 4, 1e-4);

// Identical circles collapse to one disk.
let doubled = emptySketch();
doubled = addCircle(doubled, [0, 0], 3).sketch;
doubled = addCircle(doubled, [0, 0], 3).sketch;
const doubledRegions = sketchRegions(doubled);
eq("two identical circles are one region", doubledRegions.length, 1);
near("of that circle's area", doubledRegions[0]!.area, Math.PI * 9, 1e-4);

function sum(regions: readonly Region[]): number {
  return regions.reduce((total, region) => total + region.area, 0);
}
near("the split square's regions add up", sum(halves), 100);

// A pointer move asks for the same sketch's regions again: they are traced once, and a changed sketch is traced anew.
eq("the same sketch gives back the same regions", sketchRegions(doubled) === doubledRegions, true);
const tripled = addCircle(doubled, [20, 0], 2).sketch;
eq("a changed sketch is traced again", sketchRegions(tripled).length, 2);
eq("and the first keeps its own", sketchRegions(doubled).length, 1);

if (failed) {
  console.error(`regions: ${failed} failed`);
  console.error("areas", regionAreas(box), regionAreas(split), regionAreas(frame));
  throw new Error(`regions: ${failed} failed`);
}
console.log("regions: faces, nesting, and loops ok");
