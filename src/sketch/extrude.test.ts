/**
 * Extrude from a sketch: the op, the mode, and reopening it when the file has no sketch.
 */
import { addArc, addCircle, addLine, emptySketch, type SketchData } from "./model.ts";
import { sketchRegions, toLoops } from "./regions.ts";
import {
  buildSketchExtrude,
  chooseRegions,
  cycleMode,
  type ModeChoice,
  featureExtrude,
  featureOutlines,
  opensSketchEditor,
  regionsOfOutlines,
  presetOf,
  resolveExtrudeMode,
  sketchForFeature,
  sketchTouchesSolid,
} from "./extrude.ts";
import { frameOf } from "./frame.ts";
import { keepSketch, probeRequest, withoutSketch } from "../model-request.ts";
import { loadedTree, readSavedTree, savedTree } from "../model-tree-file.ts";
import { newTree, withChild, type ExtrudeOp, type ModelOp, type Vec3 } from "../model-tree.ts";

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

function rect(x: number, y: number, w: number, h: number, sketch = emptySketch()): SketchData {
  let next = addLine(sketch, [x, y], [x + w, y]).sketch;
  next = addLine(next, [x + w, y], [x + w, y + h]).sketch;
  next = addLine(next, [x + w, y + h], [x, y + h]).sketch;
  next = addLine(next, [x, y + h], [x, y]).sketch;
  return next;
}

const bed = rect(0, 0, 10, 4);
const regions = chooseRegions(bed, [], null);
eq("one rectangle is the region, with nothing selected", regions.length, 1);

const made = buildSketchExtrude({ sketch: bed, regions, distance: 20, depth2: null, draftDeg: null, upTo: null, mode: "new" });
check("a rectangle extruded 20 builds", "op" in made);
const op = "op" in made ? made.op : null;
check("it is one extrude", op?.kind === "extrude");
if (op?.kind === "extrude") {
  eq("new object fuses the loops", op.op, "fuse");
  eq("depth is the typed distance", op.depth, 20);
  eq("the outline is one loop", op.loops?.length, 1);
  check("the loop is lines", op.loops?.[0]?.segments.every((segment) => segment.kind === "line") === true);
  check("the sketch is kept on the op", op.sketch?.v === 1 && op.sketch.entities.length === 4);
  check("a point profile is not sent", op.profile === undefined);
  const sent = withoutSketch(op);
  check("the engine op is a different object", sent !== op);
  check("and it has no sketch", !("sketch" in sent));
  eq("the probe sends that op", probeRequest("k", 0, op).op, sent);
  eq("putting the sketch back restores it", keepSketch(sent, op), op);
}

const bare = withoutSketch({ kind: "shell", thickness: 1 });
eq("an op with no sketch is the same object", withoutSketch(bare) === bare, true);

eq("no solid is a new object even when the choice is cut", resolveExtrudeMode({ choice: "cut", hasSolid: false, touches: true, distance: -5, lockNew: false }), "new");
eq("a push into a touched solid cuts", resolveExtrudeMode({ choice: "auto", hasSolid: true, touches: true, distance: -5, lockNew: false }), "cut");
eq("a pull out of it joins", resolveExtrudeMode({ choice: "auto", hasSolid: true, touches: true, distance: 5, lockNew: false }), "fuse");
eq("a sketch that misses the solid is a new object", resolveExtrudeMode({ choice: "auto", hasSolid: true, touches: false, distance: 5, lockNew: false }), "new");
eq("one pushed away from it is a new object too", resolveExtrudeMode({ choice: "auto", hasSolid: true, touches: false, distance: -5, lockNew: false }), "new");
eq("a step edit that misses its solid still joins", resolveExtrudeMode({ choice: "auto", hasSolid: true, touches: false, distance: 5, lockNew: false, stepEdit: true }), "fuse");
eq("the card's intersect wins", resolveExtrudeMode({ choice: "common", hasSolid: true, touches: true, distance: 5, lockNew: false }), "common");
eq("a root edit stays a new object", resolveExtrudeMode({ choice: "cut", hasSolid: true, touches: true, distance: -5, lockNew: true }), "new");

const faceCut = buildSketchExtrude({ sketch: bed, regions, distance: -5, depth2: null, draftDeg: null, upTo: null, mode: "cut" });
check("a cut builds", "op" in faceCut && faceCut.op.kind === "extrude" && faceCut.op.op === "cut" && faceCut.op.depth === -5);

const two = rect(20, 0, 4, 4, bed);
const both = chooseRegions(two, two.entities.map((entity) => entity.id), null);
eq("two rectangles are two regions", both.length, 2);
const group = buildSketchExtrude({ sketch: two, regions: both, distance: 8, depth2: null, draftDeg: null, upTo: null, mode: "fuse" });
check("disjoint regions are a group", "op" in group && group.op.kind === "group" && group.op.steps.length === 2);
if ("op" in group && group.op.kind === "group") {
  eq("only the first step keeps the drawing", group.op.steps.map((step) => (step.kind === "extrude" ? step.sketch?.entities.length ?? 0 : -1)), [8, 0]);
  check("the group is not a pocket", group.op.source == null);
  eq("the engine group drops the sketch", withoutSketch(group.op) === group.op, false);
  const reopened = sketchForFeature(group.op);
  eq("an edit reopens the whole drawing", reopened?.entities.length, 8);
  const outlines = featureOutlines(group.op);
  eq("each step's outline is kept", outlines.length, 2);
  const again = reopened ? regionsOfOutlines(reopened, outlines) : [];
  eq("both regions are picked again", again.map((region) => Math.round(region.area)), [40, 16]);
  // A third rectangle that was never extruded stays out of the edit.
  const more = reopened ? rect(40, 0, 2, 2, reopened) : emptySketch();
  eq("a region the step did not use is not picked", regionsOfOutlines(more, outlines).map((region) => Math.round(region.area)), [40, 16]);
  // The drawing moved 0.5 mm: each region is found from a point inside its old outline.
  const moved = reopened ? { ...reopened, points: reopened.points.map((point) => ({ ...point, at: [point.at[0] + 0.5, point.at[1]] as [number, number] })) } : emptySketch();
  eq("a moved drawing still picks both", regionsOfOutlines(moved, outlines).length, 2);
}
const pointProfile: ExtrudeOp = { kind: "extrude", op: "fuse", origin: [0, 0, 0], turn: [0, 0, 0], profile: [[20, 0], [24, 0], [24, 4], [20, 4]], depth: 5, depth2: 2 };
eq("a point profile's outline picks its region", regionsOfOutlines(two, featureOutlines(pointProfile)).map((region) => Math.round(region.area)), [16]);

let washer = addCircle(emptySketch(), [0, 0], 10).sketch;
washer = addCircle(washer, [0, 0], 4).sketch;
const washerRegions = sketchRegions(washer);
const washerChosen = chooseRegions(washer, washer.entities.map((entity) => entity.id), null);
eq("a washer selects the ring, not the hole as well", washerChosen.length, 1);
check("and the ring keeps its hole", washerChosen[0] != null && toLoops(washerChosen[0]).length === 2);
check("the hole region existed to be dropped", washerRegions.length === 2);

const sided = buildSketchExtrude({ sketch: bed, regions, distance: 6, depth2: 6, draftDeg: null, upTo: null, mode: "fuse" });
if ("op" in sided && sided.op.kind === "extrude") {
  eq("equal sides are centred", sided.op.symmetric, true);
  eq("and the depth is both of them", sided.op.depth, 12);
  check("the second depth is not also sent", sided.op.depth2 === undefined);
  check("loops stay, since centred is not a point-profile field", (sided.op.loops?.length ?? 0) === 1);
} else check("equal sides build", false);

const drafted = buildSketchExtrude({ sketch: bed, regions, distance: 10, depth2: null, draftDeg: 5, upTo: null, mode: "fuse" });
if ("op" in drafted && drafted.op.kind === "extrude") {
  eq("a drafted line outline is a point profile", drafted.op.profile?.length, 4);
  check("loops are left off", drafted.op.loops === undefined);
  eq("the draft is sent", drafted.op.draftDeg, 5);
} else check("a draft builds", false);

let bulged = addLine(emptySketch(), [0, 0], [10, 0]).sketch;
bulged = addArc(bulged, [10, 0], [0, 0], [5, 4]).sketch;
const bulgeRegions = chooseRegions(bulged, [], null);
const bulge = buildSketchExtrude({ sketch: bulged, regions: bulgeRegions, distance: 10, depth2: null, draftDeg: 5, upTo: null, mode: "fuse" });
eq("an arc with a draft is refused in plain words", "error" in bulge ? bulge.error : "", "A draft works on an outline of straight lines with no holes for now. Drop the draft, or draw the outline with lines.");
const twoSided = buildSketchExtrude({ sketch: bulged, regions: bulgeRegions, distance: 10, depth2: 4, draftDeg: null, upTo: null, mode: "fuse" });
eq("an arc with two different sides says to make them the same", "error" in twoSided ? twoSided.error : "", "A different depth on the other side works on an outline of straight lines with no holes for now. Give both sides the same depth, or draw the outline with lines.");
const evenSides = buildSketchExtrude({ sketch: bulged, regions: bulgeRegions, distance: 6, depth2: 6, draftDeg: null, upTo: null, mode: "fuse" });
check("an arc with the same depth both sides builds", "op" in evenSides);

const upTo: { index: number; mid: Vec3; areaMm2: number } = { index: 3, mid: [0, 0, 10], areaMm2: 40 };
const stopped = buildSketchExtrude({ sketch: bed, regions, distance: 10, depth2: null, draftDeg: 4, upTo, mode: "fuse" });
eq("a draft up to a face is refused", "error" in stopped ? stopped.error : "", "A draft up to a face is not available yet. Drop the draft, or drop the face and set a depth.");
const zero = buildSketchExtrude({ sketch: bed, regions, distance: 0, depth2: null, draftDeg: null, upTo: null, mode: "fuse" });
eq("a zero depth is refused", "error" in zero ? zero.error : "", "An extrude needs a depth other than 0.");

const box = { min: [0, 0, 0] as Vec3, max: [20, 20, 10] as Vec3 };
const ground = frameOf(bed.plane);
eq("a rectangle on the bed under the part touches it", sketchTouchesSolid(ground, regions, box, false), true);
const beside = rect(40, 0, 4, 4);
eq("a rectangle beside the part does not", sketchTouchesSolid(ground, chooseRegions(beside, [], null), box, false), false);
eq("a face sketch touches", sketchTouchesSolid(ground, regions, box, true), true);

eq("M walks auto, new, join, cut, intersect", [0, 1, 2, 3, 4].reduce<ModeChoice>((choice) => cycleMode(choice, null), "auto"), "auto");
eq("a step edit never offers a new object", cycleMode("auto", "step"), "fuse");
eq("a root edit stays new", cycleMode("new", "root"), "new");

const old: ExtrudeOp = { kind: "extrude", op: "fuse", origin: [0, 0, 0], turn: [0, 0, 0], profile: [[0, 0], [10, 0], [10, 4], [0, 4]], depth: 20 };
check("an extrude with no sketch still opens the editor", opensSketchEditor(old));
const rebuilt = sketchForFeature(old);
check("its profile becomes lines", (rebuilt?.entities.length ?? 0) === 4 && rebuilt?.entities.every((entity) => entity.kind === "line") === true);
const again = rebuilt ? buildSketchExtrude({ sketch: rebuilt, regions: chooseRegions(rebuilt, [], null), distance: 20, depth2: null, draftDeg: null, upTo: null, mode: "new" }) : { error: "no sketch" };
check("and those lines extrude", "op" in again && again.op.kind === "extrude" && (again.op.loops?.length ?? again.op.profile?.length ?? 0) > 0);

if (op?.kind === "extrude") {
  const preset = presetOf({ ...op, symmetric: true, depth: 20, depth2: undefined }, true);
  eq("a centred root edit is two sides of 10", preset, { distance: 10, depth2: 10, draftDeg: null, upTo: null, choice: "new" });
  const stepPreset = presetOf({ ...op, op: "cut", depth: -5 }, false);
  eq("a cut edit keeps the cut and the depth", stepPreset && { distance: stepPreset.distance, choice: stepPreset.choice }, { distance: -5, choice: "cut" });
}

const fp = { volumeMm3: 1, faces: 6, edges: 12 };
const root = { kind: "primitive" as const, solid: { primitive: "box" as const, origin: [0, 0, 0] as Vec3, size: [1, 1, 1] as Vec3, radius: 0, height: 0, turn: [0, 0, 0] as Vec3 } };
const withSketch = op?.kind === "extrude" ? op : old;
let tree = newTree("k", root, "Box", fp);
tree = withChild(tree, 0, { id: 1, op: withSketch, label: "Extrude", fingerprint: fp });
const json = JSON.parse(JSON.stringify({ ...savedTree(tree, 1, () => undefined), rootPrimitive: root.solid }));
const read = readSavedTree(json);
eq("a sketch on an extrude round-trips", read?.nodes[1]?.op, withSketch);
const stripped = JSON.parse(JSON.stringify(json));
delete stripped.nodes[1].op.sketch;
eq("an older extrude, with no sketch, opens unchanged", readSavedTree(stripped)?.nodes[1]?.op, withoutSketch(withSketch));
const broken = JSON.parse(JSON.stringify(json));
broken.nodes[1].op.sketch = { v: 2 };
const dropped = readSavedTree(broken)?.nodes[1]?.op as ModelOp | undefined;
eq("a sketch this app cannot read is dropped", dropped, withoutSketch(withSketch));
check("and the extrude is still editable", dropped != null && opensSketchEditor(dropped));
const loaded = read && loadedTree(read, "k2", root, "Box", null, () => undefined);
eq("the loaded step still carries the sketch", loaded?.nodes.get(1)?.op, withSketch);
check("the first extrude of a group is the one an edit opens", featureExtrude(withSketch)?.kind === "extrude");

// A plate with more holes than one profile takes is refused before the engine, with what to do.
function perforated(holes: number): SketchData {
  let plate = emptySketch();
  plate = addLine(plate, [0, 0], [100, 0]).sketch;
  plate = addLine(plate, [100, 0], [100, 100]).sketch;
  plate = addLine(plate, [100, 100], [0, 100]).sketch;
  plate = addLine(plate, [0, 100], [0, 0]).sketch;
  for (let k = 0; k < holes; k += 1) plate = addCircle(plate, [6 + (k % 8) * 12, 6 + Math.floor(k / 8) * 12], 2).sketch;
  return plate;
}
for (const holes of [31, 32]) {
  const plate = perforated(holes);
  const outer = sketchRegions(plate).reduce((big, region) => (region.area > big.area ? region : big));
  const made = buildSketchExtrude({ sketch: plate, regions: [outer], distance: 3, depth2: null, draftDeg: null, upTo: null, mode: "new" });
  if (holes === 31) eq("a plate with 31 holes extrudes", "op" in made, true);
  else eq("a plate with 32 holes says what to do", "error" in made ? made.error : "", "This region has 32 holes, and one profile takes 31. Apply it with 31 or fewer holes, then cut the rest from a second sketch.");
}

if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("extrude tests passed");
