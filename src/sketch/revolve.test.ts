/**
 * Revolve from a sketch: the axis, a region that crosses it, the op, and reopening it.
 */
import { addArc, addCircle, addLine, emptySketch, type SketchData } from "./model.ts";
import { sketchRegions } from "./regions.ts";
import { keepSketch, probeRequest, withoutSketch } from "../model-request.ts";
import { loadedTree, readSavedTree, savedTree } from "../model-tree-file.ts";
import { isSketchRevolveGroup, newTree, opLabel, withChild, type RevolveOp, type Vec3 } from "../model-tree.ts";
import { frameOf } from "./frame.ts";
import {
  ANGLE_REFUSAL,
  CROSS_REFUSAL,
  FULL_TURN,
  axisWorld,
  buildSketchRevolve,
  chooseRegions,
  clipAxis,
  dashSegment,
  defaultAxis,
  dragAngle,
  edgeAxes,
  featureRevolve,
  perpPixels,
  pickAxis,
  planeAxes,
  regionCrossesAxis,
  regionsForEdit,
  resolveExtrudeMode,
  revolveOutlines,
  revolvePresetOf,
  revolveRing,
  signedSide,
  sketchAxes,
  sketchForRevolve,
  sketchTouchesSolid,
  typedAngle,
} from "./revolve.ts";

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
function near(name: string, got: number, want: number) {
  if (Math.abs(got - want) < 1e-6) return;
  failed += 1;
  console.error(`FAIL ${name}\n  got  ${got}\n  want ${want}`);
}

function rect(x: number, y: number, w: number, h: number, sketch = emptySketch()): SketchData {
  let next = addLine(sketch, [x, y], [x + w, y]).sketch;
  next = addLine(next, [x + w, y], [x + w, y + h]).sketch;
  next = addLine(next, [x + w, y + h], [x, y + h]).sketch;
  next = addLine(next, [x, y + h], [x, y]).sketch;
  return next;
}

const beside = rect(2, 0, 4, 6);
const regions = chooseRegions(beside, [], null);
eq("a rectangle off the axis is one region", regions.length, 1);
check("V does not cross it", regions[0] != null && !regionCrossesAxis(regions[0], defaultAxis()));
const touching = rect(0, 0, 4, 6);
check("a rectangle that starts on V only touches it", chooseRegions(touching, [], null)[0] != null && !regionCrossesAxis(chooseRegions(touching, [], null)[0]!, defaultAxis()));
const across = rect(-2, 0, 6, 4);
check("a rectangle across V is refused", chooseRegions(across, [], null)[0] != null && regionCrossesAxis(chooseRegions(across, [], null)[0]!, defaultAxis()));

const made = buildSketchRevolve({ sketch: beside, regions, axis: defaultAxis(), angleDeg: FULL_TURN, mode: "new" });
check("a rectangle revolved 360 builds", "op" in made);
const op = "op" in made ? made.op : null;
check("it is one revolve", op?.kind === "revolve");
if (op?.kind === "revolve") {
  eq("a new object fuses", op.op, "fuse");
  eq("the angle is the full turn", op.angleDeg, 360);
  eq("the axis is V through the origin", { origin: op.axisOrigin, dir: op.axisDir }, { origin: [0, 0], dir: [0, 1] });
  eq("the outline is one loop", op.loops?.length, 1);
  check("a point profile is not sent", op.profile === undefined);
  check("the sketch is kept", op.sketch?.v === 1 && op.sketch.entities.length === 4);
  const sent = withoutSketch(op);
  check("the engine op drops the sketch", !("sketch" in sent) && sent !== op);
  eq("the probe sends that op", probeRequest("k", 0, op).op, sent);
  eq("putting the sketch back restores it", keepSketch(sent, op), op);
  eq("the history names the turn", opLabel(op), "Revolve 1-loop profile 360°");
}

const uAxis = planeAxes()[0]!;
const aboutU = buildSketchRevolve({ sketch: beside, regions, axis: uAxis, angleDeg: 90, mode: "fuse" });
if ("op" in aboutU && aboutU.op.kind === "revolve") {
  eq("U is the other plane axis", { origin: aboutU.op.axisOrigin, dir: aboutU.op.axisDir, angle: aboutU.op.angleDeg }, { origin: [0, 0], dir: [1, 0], angle: 90 });
}

const crossed = buildSketchRevolve({ sketch: across, regions: chooseRegions(across, [], null), axis: defaultAxis(), angleDeg: 360, mode: "fuse" });
eq("a region across the axis is refused in the kernel's words", "error" in crossed ? crossed.error : "", CROSS_REFUSAL);
eq("a zero angle is refused", "error" in buildSketchRevolve({ sketch: beside, regions, axis: defaultAxis(), angleDeg: 0, mode: "fuse" }) ? (buildSketchRevolve({ sketch: beside, regions, axis: defaultAxis(), angleDeg: 0, mode: "fuse" }) as { error: string }).error : "", ANGLE_REFUSAL);
eq("typing 360 snaps to a full turn", typedAngle(360), { angle: 360 });
eq("typing 90 keeps 90", typedAngle(90), { angle: 90 });
eq("typing 400 is refused", typedAngle(400), { error: ANGLE_REFUSAL });
eq("a drag past a full turn stays there", dragAngle(350, 20), 360);
eq("a drag of one pixel is one degree", dragAngle(360, -15), 345);
eq("ctrl snaps the drag to 15 degrees", dragAngle(10, 20, "step"), 30);
near("motion to the left of an upward axis lowers the angle", perpPixels([0, -1], [-8, 0]), -8);

let bulged = addLine(emptySketch(), [1, -2], [1, 2]).sketch;
bulged = addArc(bulged, [1, 2], [1, -2], [-1, 0]).sketch;
const bulge = sketchRegions(bulged).find((region) => region.area > 1);
check("an arc that bulges across the axis crosses it", bulge != null && regionCrossesAxis(bulge, defaultAxis()));

let washer = addCircle(emptySketch(), [8, 0], 3).sketch;
washer = addCircle(washer, [8, 0], 1).sketch;
const ring = chooseRegions(washer, washer.entities.map((entity) => entity.id), null);
eq("a washer off the axis is one region", ring.length, 1);
check("and it does not cross V", ring[0] != null && !regionCrossesAxis(ring[0], defaultAxis()));
const spun = buildSketchRevolve({ sketch: washer, regions: ring, axis: defaultAxis(), angleDeg: 180, mode: "cut" });
if ("op" in spun && spun.op.kind === "revolve") {
  eq("the washer keeps its hole", spun.op.loops?.length, 2);
  eq("a cut stays a cut", spun.op.op, "cut");
  eq("half a turn is sent", spun.op.angleDeg, 180);
}

const withLine = addLine(beside, [-4, -2], [-4, 8], true).sketch;
const construction = sketchAxes(withLine).find((axis) => axis.kind === "construction");
check("a construction line is an axis", construction != null);
const picked = pickAxis([...sketchAxes(withLine), ...planeAxes()], [-4, 0], 0.5);
eq("the pointer on that line picks it ahead of V", picked?.kind, "construction");
const planePick = pickAxis(planeAxes(), [0.2, 5], 0.5);
eq("near the V axis, with no line there, picks V", planePick?.kind, "v");
const edges = edgeAxes([{ a: [10, 0], b: [10, 6], source: "edge" }]);
eq("a projected edge is an axis of that kind", edges[0]?.kind, "edge");
eq("a point on it is no distance off", edges[0] ? Math.abs(signedSide([10, 3], edges[0])) : 1, 0);

const clipped = clipAxis(defaultAxis(), { minU: -10, maxU: 10, minV: -4, maxV: 8 });
eq("V is clipped to the window", clipped, [[0, -4], [0, 8]]);
const dashes = dashSegment([0, 0], [10, 0], 4, 2);
eq("dashes leave a gap", dashes.length, 2);
check("the first dash is 4 long", dashes[0] != null && Math.abs(dashes[0][1][0] - 4) < 1e-6);

const two = rect(20, 0, 3, 3, beside);
const both = chooseRegions(two, two.entities.map((entity) => entity.id), null);
eq("two rectangles are two regions", both.length, 2);
const group = buildSketchRevolve({ sketch: two, regions: both, axis: defaultAxis(), angleDeg: 360, mode: "fuse" });
check("disjoint regions are a group of revolves", "op" in group && isSketchRevolveGroup(group.op));
if ("op" in group && group.op.kind === "group") {
  eq("the row names them", group.op.label, "Revolve 2 regions");
  eq("only the first step keeps the drawing", group.op.steps.map((step) => step.kind === "revolve" && step.sketch != null), [true, false]);
  check("the engine group drops the sketch", !("sketch" in (withoutSketch(group.op) as { steps: { sketch?: unknown }[] }).steps[0]!));
  // A third rectangle the revolve did not use: the edit picks the two it did, not every region.
  const three = rect(30, 0, 2, 2, two);
  eq("an edit picks the revolved regions only", regionsForEdit(three, revolveOutlines(group.op)).map((region) => Math.round(region.area)), [24, 9]);
}

eq("no solid is a new object", resolveExtrudeMode({ choice: "cut", hasSolid: false, touches: true, distance: 1, lockNew: false }), "new");
eq("a sketch on the solid joins unless the card says otherwise", resolveExtrudeMode({ choice: "auto", hasSolid: true, touches: true, distance: 1, lockNew: false }), "fuse");
eq("the card's cut wins", resolveExtrudeMode({ choice: "cut", hasSolid: true, touches: true, distance: 1, lockNew: false }), "cut");
const ground = frameOf(beside.plane);
eq("the rectangle under a solid on the bed touches it", sketchTouchesSolid(ground, regions, { min: [0, 0, 0], max: [20, 20, 10] }, false), true);

const old: RevolveOp = { kind: "revolve", op: "fuse", origin: [0, 0, 0], turn: [0, 0, 0], profile: [[2, 0], [6, 0], [6, 4], [2, 4]], angleDeg: 90, axisDir: [0, 1] };
const rebuilt = sketchForRevolve(old);
check("a profile with no sketch becomes lines", (rebuilt?.entities.length ?? 0) === 4 && rebuilt?.entities.every((entity) => entity.kind === "line") === true);
const again = rebuilt ? buildSketchRevolve({ sketch: rebuilt, regions: regionsForEdit(rebuilt, revolveOutlines(old)), axis: defaultAxis(), angleDeg: 90, mode: "new" }) : { error: "no sketch" };
check("and those lines revolve", "op" in again && again.op.kind === "revolve" && (again.op.loops?.length ?? 0) === 1);
const preset = revolvePresetOf(old, true);
eq("an edit of a root is a new object at the stored angle", preset && { angle: preset.angleDeg, choice: preset.choice, kind: preset.axis.kind }, { angle: 90, choice: "new", kind: "v" });
if (op?.kind === "revolve") {
  const stepPreset = revolvePresetOf({ ...op, op: "cut", angleDeg: 45, axisOrigin: [1, 2], axisDir: [1, 0] }, false);
  eq("a cut edit keeps the cut, the angle, and the axis", stepPreset && { angle: stepPreset.angleDeg, choice: stepPreset.choice, origin: stepPreset.axis.origin, dir: stepPreset.axis.dir }, { angle: 45, choice: "cut", origin: [1, 2], dir: [1, 0] });
  check("the first revolve of a group is the one an edit opens", featureRevolve(op)?.kind === "revolve");
}

const handle = revolveRing([1, 2, 3], [0, 2, 0], 360);
eq("the ring sits on the region and turns about the axis", { kind: handle.kind, look: handle.look, at: handle.seat, dir: handle.dir, angle: handle.values }, { kind: "ring", look: "ring", at: { at: "feature", origin: [1, 2, 3] }, dir: [0, 1, 0], angle: [360] });
eq("the axis direction follows the plane", axisWorld({ u: [1, 0, 0], v: [0, 1, 0] }, defaultAxis()), [0, 1, 0]);

const fp = { volumeMm3: 1, faces: 6, edges: 12 };
const root = { kind: "primitive" as const, solid: { primitive: "box" as const, origin: [0, 0, 0] as Vec3, size: [1, 1, 1] as Vec3, radius: 0, height: 0, turn: [0, 0, 0] as Vec3 } };
const withSketch = op?.kind === "revolve" ? op : old;
let tree = newTree("k", root, "Box", fp);
tree = withChild(tree, 0, { id: 1, op: withSketch, label: "Revolve", fingerprint: fp });
const json = JSON.parse(JSON.stringify({ ...savedTree(tree, 1, () => undefined), rootPrimitive: root.solid }));
const read = readSavedTree(json);
eq("a sketch on a revolve round-trips", read?.nodes[1]?.op, withSketch);
const stripped = JSON.parse(JSON.stringify(json));
delete stripped.nodes[1].op.sketch;
eq("an older revolve, with no sketch, opens unchanged", readSavedTree(stripped)?.nodes[1]?.op, withoutSketch(withSketch));
const broken = JSON.parse(JSON.stringify(json));
broken.nodes[1].op.sketch = { v: 2 };
eq("a sketch this app cannot read is dropped", readSavedTree(broken)?.nodes[1]?.op, withoutSketch(withSketch));
const loaded = read && loadedTree(read, "k2", root, "Box", null, () => undefined);
eq("the loaded step still carries the sketch", loaded?.nodes.get(1)?.op, withSketch);

if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("revolve tests passed");
