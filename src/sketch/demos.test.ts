/**
 * --- P2. Show me: each Make tool's demo is a saved sketch, sits on the person's plane where they look, and its tool's
 * next step builds the tool's op. A broken demo, or a tool that stops building it, fails here before the e2e specs. ---
 */
import { buildSketchExtrude, chooseRegions } from "./extrude.ts";
import { hintById, HINT_LIMIT } from "./hints.ts";
import { everyHoleSelection, holeTargets, holesInModel, sketchOnFace } from "./holes.ts";
import { buildSketchLoft, sectionFromRegion, sectionsCoplanar } from "./loft.ts";
import { planeAbove } from "./loft-above.ts";
import { sketchJson, type SketchData, type SketchPlane } from "./model.ts";
import { MAKE_BUTTONS, endsWithAction, sharpCorners } from "./reasons.ts";
import { sketchRegions } from "./regions.ts";
import { axisChoices, buildSketchRevolve } from "./revolve.ts";
import { roundRouteCorners, routeCornerLines, smallestRouteRadius } from "./round-route.ts";
import { buildSketchSweep, oneSketchSweep, openChain, pipeProfile, standUpProfile } from "./sweep.ts";
import { DEMO_DONE, DEMO_HOLE_SIZES, DEMO_KINDS, DEMO_LEAD, DEMO_WALL, DEMOS, EDIT_DEMO_KINDS, EDIT_DEMO_LEAD, LOFT_TOP_HEIGHT_MM, LOFT_TOP_NAME, demoDrawing, demoForHow, isEditDemo, placeDemo, type DemoKind } from "./demos.ts";
import { activeSketch, commitSizes, enterSketchData, sketchOff, sketchPointer, withRefs, withTool, type SketchEditor, type SketchEnv } from "./session.ts";
import { armOffset } from "./tools.ts";
import { EDIT_BUTTONS } from "./reasons.ts";
import { IDENTITY_POSE } from "../model-space.ts";

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

// --- Every Make tool has a demo, and every demo's words follow R1. ---
for (const tool of MAKE_BUTTONS) check(`the Make tool ${tool} has a demo`, (DEMO_KINDS as readonly string[]).includes(tool));
check("Pipe has a demo of its own", DEMO_KINDS.includes("pipe"));
for (const kind of DEMO_KINDS) {
  const spec = DEMOS[kind];
  check(`${kind}: the next step ends with what to do: ${spec.tryIt}`, endsWithAction(spec.tryIt));
  check(`${kind}: the next step fits the status line`, spec.tryIt.length <= HINT_LIMIT);
  check(`${kind}: what it made is a sentence`, spec.made.length > 10 && spec.made.endsWith("."));
}
check("the done line ends with what to do", endsWithAction(DEMO_DONE) && DEMO_DONE.length <= HINT_LIMIT);
check("the Make row's lead is a sentence", DEMO_LEAD.endsWith("."));
// Each feature How with a Make tool opens that tool's demo; a How with no demo has no Show me.
eq("How kinds to demos", ["extrude", "revolve", "loft", "sweep", "sweep-one", "pipe", "profile"].map(demoForHow), ["extrude", "revolve", "loft", "sweep", "sweep", "pipe", null]);
for (const how of ["extrude", "revolve", "loft", "sweep", "sweep-one", "pipe"]) check(`How ${how} has steps`, (hintById(how)?.steps.length ?? 0) > 0);

// --- The stored drawings are saved sketches, around (0, 0). ---
for (const kind of [...DEMO_KINDS, "loft-top" as const]) {
  const sketch = demoDrawing(kind);
  eq(`${kind} reads back as the JSON it is`, sketchJson(sketch), sketch);
  const us = sketch.points.map((point) => point.at[0]);
  const vs = sketch.points.map((point) => point.at[1]);
  check(`${kind} is small: within 40 mm`, Math.max(...us) - Math.min(...us) <= 40 && Math.max(...vs) - Math.min(...vs) <= 40);
  check(`${kind} sits around the origin`, Math.abs((Math.max(...us) + Math.min(...us)) / 2) <= 10 && Math.abs((Math.max(...vs) + Math.min(...vs)) / 2) <= 10);
}

// --- Placed on a turned, moved plane, each demo is the stored drawing moved, and its tool builds. ---
const plane: SketchPlane = { origin: [5, 6, 7], turn: [90, 0, 30] };
const centre: [number, number] = [3, -2];
const pose = IDENTITY_POSE;
const placed = (kind: DemoKind, on?: SketchData["on"]) => placeDemo(kind, { plane, centre, ...(on ? { on } : {}) });

for (const kind of DEMO_KINDS) {
  const { drawing } = placed(kind);
  const stored = demoDrawing(kind);
  eq(`${kind} is on the person's plane`, drawing.plane, plane);
  eq(`${kind} keeps its lines`, drawing.entities.map((entity) => entity.kind), stored.entities.map((entity) => entity.kind));
  eq(`${kind} is moved to the centre`, drawing.points.map((point) => point.at), stored.points.map((point) => [point.at[0] + centre[0], point.at[1] + centre[1]]));
}

{
  const sketch = placed("extrude").drawing;
  const regions = chooseRegions(sketch, [], null);
  eq("extrude: the plate is picked with nothing selected, the circle a hole in it", regions.map((region) => region.holes.length), [1]);
  const built = buildSketchExtrude({ sketch, regions, distance: 8, depth2: null, draftDeg: null, upTo: null, mode: "new" });
  eq("extrude: 8 mm builds an extrude", "op" in built ? built.op.kind : built.error, "extrude");
}

{
  const sketch = placed("revolve").drawing;
  const regions = chooseRegions(sketch, [], null);
  eq("revolve: the cup's wall is the one shape", regions.length, 1);
  const choices = axisChoices(sketch, regions, null);
  eq("revolve: your helper line is listed first", choices[0]?.label, "your helper line");
  check("revolve: and the wall doesn't cross it", choices[0]?.crosses === false);
  const built = buildSketchRevolve({ sketch, regions, axis: choices[0]!.axis, angleDeg: 360, mode: "new" });
  eq("revolve: a full turn about it builds", "op" in built ? built.op.kind : built.error, "revolve");
}

{
  const { drawing, cards } = placed("loft");
  eq("loft: one card, the top shape", cards.map((card) => card.name), [LOFT_TOP_NAME]);
  const top = cards[0]!.sketch;
  eq("loft: the top shape is on the plane above", top.plane, planeAbove(plane, LOFT_TOP_HEIGHT_MM));
  check("loft: the top shape is on no face", top.on === undefined);
  const square = chooseRegions(drawing, [], null)[0]!;
  const circle = sketchRegions(top)[0]!;
  const picks = [{ sketch: drawing, section: sectionFromRegion(drawing, square) }, { sketch: top, section: sectionFromRegion(top, circle) }];
  check("loft: the two shapes are at different heights", !sectionsCoplanar(picks.map((pick) => pick.section)));
  const built = buildSketchLoft({ picks, ruled: false, mode: "new" });
  eq("loft: square to round builds", "op" in built ? built.op.kind : built.error, "loft");
}

{
  const sketch = placed("sweep").drawing;
  const split = oneSketchSweep(sketch);
  check("sweep: the circle and the route are one sketch's shape and route", split != null);
  const stood = split ? standUpProfile(split) : null;
  check("sweep: the circle stands up at the route's start", stood != null);
  if (stood) {
    eq("sweep: the route turns smoothly, no corner to round", sharpCorners(stood.path, stood.check), []);
    const built = buildSketchSweep({ ...stood, scale: 1, mode: "new" });
    eq("sweep: Apply builds", "op" in built ? built.op.kind : built.error, "loft");
  }
}

{
  const sketch = placed("pipe").drawing;
  eq("pipe: a route and no shape", sketchRegions(sketch).length, 0);
  const chain = openChain(sketch)!;
  const corners = sharpCorners(chain.path, chain.check);
  eq("pipe: one sharp corner, for Round corners", corners.length, 1);
  const ids = routeCornerLines(sketch, corners);
  const pipeOf = (drawing: SketchData) => {
    const made = pipeProfile(drawing, openChain(drawing)!, 8, 0);
    return "error" in made ? made : buildSketchSweep({ ...made, scale: 1, mode: "new" });
  };
  const found = ids ? smallestRouteRadius(sketch, ids, 4, (rounded) => "op" in pipeOf(rounded)) : null;
  eq("pipe: an 8 mm pipe rounds at its own radius", found?.radius, 4);
  const rounded = ids && found ? roundRouteCorners(sketch, ids, found.radius) : null;
  const built = rounded && "sketch" in rounded ? pipeOf(rounded.sketch) : { error: "not rounded" };
  eq("pipe: and it builds", "op" in built ? built.op.kind : built.error, "loft");
}

{
  const free = placed("holes").drawing;
  check("holes: off a face, the demo stands on a face of its own", sketchOnFace(free) && free.on?.kind === "face" && free.on.face.index === -1);
  const face = { kind: "face" as const, face: { index: 4, mid: [1, 2, 3] as [number, number, number], areaMm2: 400 } };
  eq("holes: on a face, it stays on the person's face", placed("holes", face).drawing.on, face);
  eq("holes: other demos keep the person's face too", placed("extrude", face).drawing.on, face);
  const targets = holeTargets(free, everyHoleSelection(free));
  eq("holes: Yes picks the three circles, not the helper corners", targets.length, 3);
  const built = holesInModel({ sketch: free, points: targets, pose, sizes: DEMO_HOLE_SIZES });
  eq("holes: a group of three holes", "op" in built ? [built.op.kind, built.op.steps.length] : built.error, ["group", 3]);
}

eq("the op each demo checks", DEMO_KINDS.map((kind) => DEMOS[kind].op), ["extrude", "revolve", "loft", "loft", "loft", "group"]);

// --- Milestone 6: each Edit tool's demo, and the tool's next click on it, through the editor a person drives. ---
for (const tool of ["trim", "offset", "fillet", "construction", "use"] as const) check(`the Edit tool ${tool} has a demo`, (EDIT_DEMO_KINDS as readonly string[]).includes(tool) && (EDIT_BUTTONS as readonly string[]).includes(tool));
for (const kind of EDIT_DEMO_KINDS) {
  const spec = DEMOS[kind];
  check(`${kind}: the next step ends with what to do: ${spec.tryIt}`, endsWithAction(spec.tryIt));
  check(`${kind}: the next step fits the status line`, spec.tryIt.length <= HINT_LIMIT);
  check(`${kind}: what it made is a sentence`, spec.made.length > 10 && spec.made.endsWith("."));
  check(`${kind}: its op is its tool`, spec.op === kind && isEditDemo(kind));
  const stored = demoDrawing(kind);
  eq(`${kind} reads back as the JSON it is`, sketchJson(stored), stored);
  const { drawing, aim } = placed(kind);
  eq(`${kind} is on the person's plane`, drawing.plane, plane);
  check(`${kind} says where the next click goes`, !!aim && Math.abs(aim[0] - spec.aim![0] - centre[0]) < 1e-9 && Math.abs(aim[1] - spec.aim![1] - centre[1]) < 1e-9);
}
check("the Edit row's lead is a sentence", EDIT_DEMO_LEAD.endsWith("."));
{
  const env: SketchEnv = { mmPerPx: 0.05, project: (at) => ({ x: at[0] * 20, y: at[1] * 20 }) };
  const at = (uv: [number, number]) => ({ uv, sx: uv[0] * 20, sy: uv[1] * 20, shift: false, ctrl: false, alt: false });
  const click = (editor: SketchEditor, uv: [number, number]) =>
    sketchPointer(sketchPointer(sketchPointer(editor, { phase: "down", ...at(uv) }, env), { phase: "move", ...at(uv) }, env), { phase: "up", ...at(uv) }, env);
  const open = (kind: (typeof EDIT_DEMO_KINDS)[number]) => {
    const demo = placed(kind);
    let editor = withTool(enterSketchData(sketchOff(), demo.drawing), kind);
    if (demo.refs) editor = withRefs(editor, demo.refs);
    return { editor, aim: demo.aim!, drawing: demo.drawing };
  };

  const trim = open("trim");
  eq("trim: the outline closes only through the overhang's crossing", sketchRegions(trim.drawing).length, 1);
  const trimmed = activeSketch(click(trim.editor, trim.aim))!;
  check("trim: one click at the aim cuts the overhang off", trimmed.points.every((point) => point.at[0] <= 15 + centre[0] + 1e-9));
  eq("trim: and the plate is still one shape", sketchRegions(trimmed).length, 1);

  const off = open("offset");
  const ids = off.drawing.entities.map((entity) => entity.id);
  let wall = { ...off.editor, draw: armOffset(off.drawing, { ...off.editor.draw, wall: { ...DEMO_WALL } }, ids, off.aim) };
  wall = commitSizes(wall, [1.5]);
  const walled = activeSketch(wall)!;
  eq("offset: 1.5 and Enter make one wall", sketchRegions(walled).length, 1);
  check("offset: around the route, now helper lines", ids.every((id) => walled.entities.find((entity) => entity.id === id)?.construction === true));

  const fillet = open("fillet");
  const rounded = activeSketch(commitSizes(click(fillet.editor, fillet.aim), [4]))!;
  eq("fillet: a click on the corner and 4 round it", rounded.entities.filter((entity) => entity.kind === "arc").length, 1);

  const helper = open("construction");
  eq("helper line: the middle line splits the plate in two", sketchRegions(helper.drawing).length, 2);
  const helped = activeSketch(click(helper.editor, helper.aim))!;
  eq("helper line: one click makes it a helper, and the plate is one shape", [helped.entities.filter((entity) => entity.construction).length, sketchRegions(helped).length], [1, 1]);

  const use = open("use");
  eq("copy edge: the demo starts with nothing drawn", use.drawing.entities.length, 0);
  const copied = activeSketch(click(use.editor, use.aim))!;
  eq("copy edge: a click inside the face copies its outline and its hole", copied.entities.map((entity) => entity.kind).sort(), ["circle", "line", "line", "line", "line"]);
}

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("demo tests passed");
