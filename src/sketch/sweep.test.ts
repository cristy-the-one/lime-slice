/**
 * --- F3. A sweep along a smooth arc, and a sharp corner that is refused. ---
 */
import { keepSketch, withoutSketch } from "../model-request.ts";
import { opLabel } from "../model-tree.ts";
import type { LoftSection, ProfileLoop, Vec3 } from "../model-tree.ts";
import { frameOf, planeOf, toWorld } from "./frame.ts";
import { addArc, addCircle, addLine, emptySketch, type SketchData } from "./model.ts";
import { sketchRegions, toLoops } from "./regions.ts";
import { PIPE_DIAMETER_REFUSAL, PIPE_WALL_REFUSAL, SHARP_CORNER, alongRefusal, oneSketchSweep, pipeProfile, standUpProfile, buildSketchSweep, extendPath, openChain, sharpCorner, sweepEditOf, turningDeg } from "./sweep.ts";

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
function near(a: number, b: number, tol = 1e-3) {
  return Math.abs(a - b) < tol;
}

function square(sketch: SketchData, at: number, size: number): SketchData {
  let out = sketch;
  out = addLine(out, [at, at], [at + size, at]).sketch;
  out = addLine(out, [at + size, at], [at + size, at + size]).sketch;
  out = addLine(out, [at + size, at + size], [at, at + size]).sketch;
  out = addLine(out, [at, at + size], [at, at]).sketch;
  return out;
}

function squareSketch(): SketchData {
  return square(emptySketch(), 0, 4);
}

/** Every loop point of a section, in model space. */
function sectionPoints(section: LoftSection): Vec3[] {
  const frame = frameOf(section);
  return (section.loops ?? []).flatMap((loop) => [loop.start, ...loop.segments.map((segment) => segment.to)].map((point) => toWorld(frame, [point[0], point[1]])));
}

/** How far a section's outline reaches from the square's centre (2, 2), on its own plane. */
function reachOf(section: LoftSection | undefined): number {
  const loop = section?.loops?.[0] as ProfileLoop | undefined;
  if (!loop) return 0;
  return Math.max(...[loop.start, ...loop.segments.map((segment) => segment.to)].map((point) => Math.hypot(point[0] - 2, point[1] - 2)));
}

/** A quarter circle of radius 20 that rises from the bed at (2, 2, 0), straight up at first, and bends toward +X. */
function risingArc(): { path: Vec3[]; check: boolean[] } {
  const path: Vec3[] = [];
  for (let k = 0; k <= 6; k += 1) {
    const angle = (k / 6) * (Math.PI / 2);
    path.push([2 + 20 * (1 - Math.cos(angle)), 2, 20 * Math.sin(angle)]);
  }
  return { path, check: path.map((_, index) => index === 0 || index === path.length - 1) };
}

const profileSketch = squareSketch();
const profile = sketchRegions(profileSketch)[0];
check("the square is a region", !!profile);

const elbow = sharpCorner([[0, 0, 0], [10, 0, 0], [10, 10, 0]]);
eq("an L is a sharp corner", elbow, SHARP_CORNER);
check("a right angle is 90°", near(turningDeg([1, 0, 0], [0, 1, 0]), 90, 1e-6));
eq("a straight run is not sharp", sharpCorner([[0, 0, 0], [5, 0, 0], [10, 0, 0]]), null);

if (profile) {
  const refused = buildSketchSweep({ profileSketch, profile, path: [[0, 0, 0], [10, 0, 0], [10, 10, 0]], scale: 1, mode: "new" });
  eq("a sharp path is refused and not lofted", "error" in refused ? refused.error : "", SHARP_CORNER);

  const radius = 20;
  const mid = radius / Math.SQRT2;
  let arc = emptySketch();
  arc = addArc(arc, [radius, 0], [0, radius], [mid, mid]).sketch;
  const chain = openChain(arc);
  check("a quarter-circle arc is an open path", !!chain && chain.path.length >= 4);
  if (chain) {
    eq("samples inside the arc are not corners", sharpCorner(chain.path, chain.check), null);
    const along = buildSketchSweep({ profileSketch, profile, path: chain.path, check: chain.check, pathSketch: arc, scale: 1, mode: "new" });
    const alongText = "error" in along ? along.error : "";
    check("a profile drawn on the path's own plane is refused in words", alongText.startsWith("The profile and the path are on the same plane"));
    check("the refusal names the origin plane that faces the arc's start", /on the (XZ|YZ) plane, which faces/.test(alongText));
    eq("a path starting along X off the origin names YZ and its offset", alongRefusal([12, 3, 0], [1, 0, 0]), "The profile and the path are on the same plane, so there is nothing to sweep. Finish this sketch, then draw the profile in a new sketch on the YZ plane with Offset 12 mm, which faces where the path starts.");
    check("a slanted start points to a workplane", alongRefusal([0, 0, 0], [1, 1, 0]).includes("set a workplane square to where the path starts"));
    const rising = risingArc();
    const swept = buildSketchSweep({
      profileSketch,
      profile,
      path: rising.path,
      check: rising.check,
      pathSketch: arc,
      scale: 1,
      mode: "new",
    });
    check("the arc sweeps", "op" in swept);
    if ("op" in swept) {
      check("the sweep is a loft of at least two sections", swept.op.kind === "loft" && swept.op.sections.length >= 2);
      const first = swept.op.sections[0]!;
      eq("the first section is the profile where it was drawn: its plane", [first.origin, first.turn], [[0, 0, 0], [0, 0, 0]]);
      eq("and its loops", first.loops, toLoops(profile));
      const last = swept.op.sections.at(-1)!;
      const ends = sectionPoints(last);
      check("the last section stands at the arc's end, square to it", ends.every((point) => near(point[0], 22, 0.05)) && ends.every((point) => point[2] > 17.9 && point[2] < 22.1));
      check("no section goes below the bed", swept.op.sections.every((section) => sectionPoints(section).every((point) => point[2] > -1e-6)));
      const sent = withoutSketch(swept.op);
      check("the engine op has no drawing", !("drawing" in sent));
      eq("the drawing comes back on the echo", keepSketch(sent, swept.op), swept.op);
      check("the row says sweep", opLabel(swept.op).startsWith("Sweep along "));
      const again = sweepEditOf(swept.op, true);
      check("History Edit reopens the profile and the path", !!again && again.kind === "sweep" && again.choice === "new" && again.path.length === chain.path.length && again.profile.entities.length === profileSketch.entities.length);
    }
  }

  const scaled = buildSketchSweep({
    profileSketch,
    profile,
    path: [[0, 0, 0], [0, 0, 10], [0, 0, 20]],
    scale: [1, 2, 1],
    mode: "fuse",
  });
  check("a scale per point is accepted", "op" in scaled);
  if ("op" in scaled && scaled.op.kind === "loft") {
    check("the middle section is twice the end", near(reachOf(scaled.op.sections[1]), reachOf(scaled.op.sections[0]) * 2, 0.05));
    eq("the stored scale is the list", scaled.op.drawing?.sweep?.scale, [1, 2, 1]);
  }

  // One number is the size at the end: the start is the profile as drawn, and the size grows evenly along the path.
  const tapered = buildSketchSweep({ profileSketch, profile, path: [[0, 0, 0], [0, 0, 10], [0, 0, 20]], scale: 2, mode: "fuse" });
  if ("op" in tapered) {
    const sections = tapered.op.sections;
    check("an end scale keeps the start as drawn", near(reachOf(sections[0]), Math.hypot(2, 2)));
    check("and ends at twice the size", near(reachOf(sections.at(-1)), 2 * Math.hypot(2, 2)));
    check("halfway along it is 1.5 times", near(reachOf(sections[1]), 1.5 * Math.hypot(2, 2)));
    eq("an end scale is marked so", tapered.op.drawing?.sweep?.scaleAtEnd, true);
    const older = { ...tapered.op, drawing: { ...tapered.op.drawing, sweep: { ...tapered.op.drawing!.sweep!, scaleAtEnd: undefined } } };
    eq("a sweep from before keeps its whole-size scale on Edit, as one per path point", sweepEditOf(older, false)?.scale, [2, 2, 2]);
    eq("a marked one keeps its end scale", sweepEditOf(tapered.op, false)?.scale, 2);
  } else check("an end scale sweeps", false);

  // A ring keeps its hole along the sweep.
  const ringSketch = square(square(emptySketch(), 0, 4), 1, 2);
  const ring = sketchRegions(ringSketch).reduce((big, region) => (region.area > big.area ? region : big));
  const piped = buildSketchSweep({ profileSketch: ringSketch, profile: ring, path: [[0, 0, 0], [0, 0, 10]], scale: 1, mode: "new" });
  check("a ring sweeps with its hole on every section", "op" in piped && piped.op.sections.every((section) => section.loops?.length === 2));
}

const closed = openChain(profileSketch);
eq("a closed rectangle is not a sweep path", closed, null);

const met = extendPath([[0, 0, 0], [10, 0, 0]], [true, true], [[10, 0, 0], [10, 8, 0]]);
check("an edge that meets is appended", "path" in met && met.path.length === 3 && met.path[2]![1] === 8);
const missed = extendPath([[0, 0, 0], [10, 0, 0]], [true, true], [[0, 5, 0], [0, 9, 0]]);
eq("an edge that misses says so", "error" in missed ? missed.error : "", "Pick an edge that meets the path.");

// --- S1. A circle and a route in one sketch on the bed: the circle stands up at the route's nearer end. ---
{
  let one = addCircle(emptySketch(), [0, 0], 3).sketch;
  one = addLine(one, [40, 0], [10, 0]).sketch;
  one = addArc(one, [40, 0], [60, 20], [54.142136, 5.857864]).sketch;
  const split = oneSketchSweep(one);
  check("a circle and an open route split into shape and route", !!split && split.shape.entities.length === 1 && split.route.entities.length === 2);
  const stood = split ? standUpProfile(split) : null;
  check("the shape stands up", !!stood);
  if (stood) {
    eq("the route starts at the end nearer the circle", stood.path[0], [10, 0, 0]);
    const frame = frameOf(stood.profileSketch.plane);
    check("the stood-up plane faces along the route's start", near(frame.w[0], 1) && near(frame.w[1], 0) && near(frame.w[2], 0));
    check("the circle's centre sits on the start", sectionPointsNear(toWorld(frame, [0, 0]), [10, 0, 0]));
    eq("the route sketch keeps only the route", stood.pathSketch.entities.map((entity) => entity.kind), ["line", "arc"]);

    // The same sweep made the strict way: the circle drawn by hand on a plane facing +X at the start, and the route alone.
    const byHandPlane = planeOf({ origin: [10, 0, 0], u: [0, 0, -1], v: [0, 1, 0], w: [1, 0, 0] });
    const byHand = addCircle(emptySketch(byHandPlane), [0, 0], 3).sketch;
    let routeOnly = emptySketch();
    routeOnly = { ...routeOnly, points: stood.pathSketch.points, entities: stood.pathSketch.entities };
    const strictChain = openChain(routeOnly)!;
    const forward = strictChain.path[0]![0] === 10 ? strictChain : { path: [...strictChain.path].reverse(), check: [...strictChain.check].reverse() };
    const strict = buildSketchSweep({ profileSketch: byHand, profile: sketchRegions(byHand)[0]!, path: forward.path, check: forward.check, pathSketch: routeOnly, scale: 1, mode: "new" });
    const easy = buildSketchSweep({ profileSketch: stood.profileSketch, profile: stood.profile, path: stood.path, check: stood.check, pathSketch: stood.pathSketch, scale: 1, mode: "new" });
    check("both ways build", "op" in strict && "op" in easy);
    eq("the one-sketch sweep stores the same op as the two-sketch sweep", "op" in easy ? easy.op : null, "op" in strict ? strict.op : null);
  }
  const asDrawn = split ? buildSketchSweep({ profileSketch: one, profile: split.profile, path: split.chain.path, check: split.chain.check, pathSketch: one, scale: 1, mode: "new" }) : null;
  check("as drawn, the flat circle is still refused", !!asDrawn && "error" in asDrawn && asDrawn.error.startsWith("The profile and the path are on the same plane"));
  eq("a closed shape alone is not a one-sketch sweep", oneSketchSweep(squareSketch()), null);
  eq("a route alone is not one either", oneSketchSweep(addLine(emptySketch(), [0, 0], [10, 0]).sketch), null);
}

// --- S2. Pipe mode: a circle at the route's start, with a hole for a wall. ---
{
  const route = addLine(emptySketch(), [0, 0], [30, 0]).sketch;
  const chain = openChain(route)!;
  const rod = pipeProfile(route, chain, 8, 0);
  check("a pipe makes a profile", "profile" in rod);
  if ("profile" in rod) {
    eq("a rod is one circle", rod.profileSketch.entities.map((entity) => entity.kind), ["circle"]);
    eq("of the typed diameter", (rod.profileSketch.entities[0] as { radius: number }).radius, 4);
    const frame = frameOf(rod.profileSketch.plane);
    check("facing along the route", near(Math.abs(frame.w[0]), 1));
    const built = buildSketchSweep({ ...rod, scale: 1, mode: "new" });
    check("a rod sweeps", "op" in built && built.op.kind === "loft" && !!built.op.drawing?.sweep);
  }
  const tube = pipeProfile(route, chain, 8, 1);
  check("a wall makes a hole", "profile" in tube && tube.profile.holes.length === 1);
  if ("profile" in tube) check("a tube sweeps with its hole", (() => { const built = buildSketchSweep({ ...tube, scale: 1, mode: "new" }); return "op" in built && built.op.sections.every((section) => section.loops?.length === 2); })());
  eq("no diameter is refused", "error" in pipeProfile(route, chain, 0, 0) ? (pipeProfile(route, chain, 0, 0) as { error: string }).error : "", PIPE_DIAMETER_REFUSAL);
  eq("a wall as thick as the radius is refused", "error" in pipeProfile(route, chain, 8, 4) ? (pipeProfile(route, chain, 8, 4) as { error: string }).error : "", PIPE_WALL_REFUSAL);
}

function sectionPointsNear(a: Vec3, b: Vec3): boolean {
  return near(a[0], b[0]) && near(a[1], b[1]) && near(a[2], b[2]);
}

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("sweep tests passed");
