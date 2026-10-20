import { readFileSync } from "node:fs";
import { DOCK_KNOB_REACH, HANDLE_KNOB_PICK } from "./gizmo-math.ts";
import {
  DRAG_FIELDS,
  MODEL_TOOLS,
  axisValues,
  dragLabel,
  dragValue,
  edgeAnchor,
  handlesFor,
  lineParam,
  measureNote,
  moveFine,
  startFine,
  turnGimbal,
  turnedAxes,
  wrapDegrees,
  type DragContext,
  type DragHandle,
  type Vec3,
} from "./model-drag.ts";
import { extentAlong, planeFor, splitBase } from "./model-plane.ts";
import { PRIMITIVES } from "./model-primitive.ts";
import { GLOBAL_WORKPLANE, axesOf, workplaneOnFace } from "./workplane.ts";

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
function near(a: number, b: number, tol = 1e-6) {
  return Math.abs(a - b) < tol;
}
function nearVec(a: readonly number[], b: readonly number[], tol = 1e-6) {
  return a.every((value, i) => near(value, b[i]!, tol));
}

// Checklist: every toolbar tool has a viewport drag for every number its panel shows.
const markup = readFileSync(new URL("./app/markup.ts", import.meta.url), "utf8");
const toolbar = [...markup.matchAll(/class="model-tool"[^>]*data-tool="(\w+)"/g)].map((match) => match[1]!);
check("the Model toolbar has tools", toolbar.length >= 7);
for (const tool of toolbar) check(`${tool} is on the drag checklist`, (MODEL_TOOLS as readonly string[]).includes(tool));
for (const tool of MODEL_TOOLS) check(`${tool} is on the toolbar`, toolbar.includes(tool));

const numberFields = [...markup.matchAll(/<label data-for="([\w ]+)"[^>]*>.*?<input id="(\w+)" type="number"/g)].map((match) => ({
  tools: match[1]!.split(" "),
  id: match[2]!,
}));
check("the Model panel has number fields", numberFields.length >= 20);
for (const tool of MODEL_TOOLS) {
  const shown = numberFields.filter((field) => field.tools.includes(tool)).map((field) => field.id);
  for (const id of shown) check(`${tool} drags ${id}`, DRAG_FIELDS[tool].includes(id));
  for (const id of DRAG_FIELDS[tool]) check(`${tool} shows ${id} as a number`, shown.includes(id));
}

const values: Record<string, number> = {
  modelX: 2, modelY: 3, modelZ: 10, modelDx: 4, modelDy: 6, modelDz: 8, modelRadius: 5, modelHeight: 10,
  modelRx: 0, modelRy: 0, modelRz: 0, modelPlane: 5, modelTiltA: 0, modelTiltB: 0, modelBlend: 1, modelHoleR: 2, modelHoleD: 12, modelShell: 2, modelFactor: 2,
  modelAx: 0, modelAy: 0, modelAz: 0, modelBx: 10, modelBy: 0, modelBz: 0,
};
/** A 10 mm cube's corners as a soup: enough for its extent along any normal. */
const cubeCorners = [0, 0, 0, 10, 0, 0, 0, 10, 0, 10, 10, 0, 0, 0, 10, 10, 0, 10, 0, 10, 10, 10, 10, 10];
const cube = { min: [0, 0, 0] as Vec3, max: [10, 10, 10] as Vec3 };
const splitAt = (mode: "x" | "y" | "z" | "face", value: number, tilt: [number, number] = [0, 0]) =>
  planeFor(splitBase(mode, [5, 5, 5], { point: [5, 5, 10], normal: [0, 0, 1] })!, value, tilt, (n) => extentAlong(cubeCorners, n), cube);
function context(primitive: DragContext["primitive"], extra: Partial<DragContext> = {}): DragContext {
  return {
    read: (field) => values[field] ?? 0,
    primitive,
    center: [5, 5, 5],
    extent: 10,
    split: splitAt("z", 5),
    edge: { point: [5, 0, 10], out: [0, -Math.SQRT1_2, Math.SQRT1_2] },
    // P1. A face under the pointer, so Push/Pull has its arrow. A test that wants none passes pull: null.
    pull: { at: [5, 5, 10], dir: [0, 0, 1] },
    ...extra,
  };
}
for (const tool of MODEL_TOOLS) {
  const dragged = new Set<string>();
  // A hole's counterbore fields show only with its box ticked, and have handles then.
  // A feature's circle and polygon sizes show only for that shape, and have handles then.
  const features: Partial<DragContext>[] = [{}, { feature: { shape: "circle" } }, { feature: { shape: "arch" } }, { feature: { cell: "circle" } }, { feature: { cell: "polygon" } }, { feature: { along: "v" } }];
  // --- A4. Polar and path fields are on screen only in that mode, and have handles then. ---
  const repeats: Partial<DragContext>[] = [{}, { repeat: { mode: "polar" } }, { repeat: { mode: "path" } }];
  for (const hole of [undefined, { through: false, counterbore: true }]) {
    for (const { kind: primitive } of PRIMITIVES) {
      for (const feature of features) {
        for (const repeat of repeats) {
          for (const handle of handlesFor(tool, context(primitive, { hole, ...feature, ...repeat }))) handle.fields.forEach((field) => dragged.add(field));
        }
      }
    }
  }
  for (const field of DRAG_FIELDS[tool]) check(`${tool} has a handle for ${field}`, dragged.has(field));
}
check("a fillet with no edge has no handle yet", handlesFor("fillet", context("box", { edge: null })).length === 0);
check("push/pull with no face has no arrow yet", handlesFor("pushpull", context("box", { pull: null })).length === 0);
check("no tool, no handles", handlesFor(null, context("box")).length === 0);

const docked = (handle: DragHandle) => handle.seat.at === "dock";
const ghosted = (handle: DragHandle) => handle.seat.at === "ghost";
const reachOf = (handle: DragHandle) => (handle.seat.at === "dock" ? handle.seat.reach : null);
const originOf = (handle: DragHandle) => (handle.seat.at === "feature" ? handle.seat.origin : null);

const holeIds = (hole: DragContext["hole"]) => handlesFor("hole", context("box", { hole })).map((handle) => handle.id);
eq("a plain hole drags its origin, radius and depth", holeIds({ through: false, counterbore: false }), ["hole-origin", "hole-move-u", "hole-move-v", "hole-radius", "hole-depth"]);
eq("Through all has no depth to drag", holeIds({ through: true, counterbore: false }), ["hole-origin", "hole-move-u", "hole-move-v", "hole-radius"]);
const bored = handlesFor("hole", context("box", { hole: { through: true, counterbore: true } }));
eq("a counterbore adds its radius and depth knobs", bored.map((handle) => handle.id), ["hole-origin", "hole-move-u", "hole-move-v", "hole-radius", "bore-radius", "bore-depth"]);
eq("one hole per sketch point drags radius and depth", handlesFor("hole", context("box", { hole: { through: false, counterbore: false }, sketchHoles: true })).map((handle) => handle.id), ["hole-radius", "hole-depth"]);
const boreRadius = bored.find((handle) => handle.id === "bore-radius")!;
const boreDepth = bored.find((handle) => handle.id === "bore-depth")!;
eq("the bore radius knob takes the next axis, out past the arrows", [boreRadius.dir, reachOf(boreRadius)], [[0, 1, 0], DOCK_KNOB_REACH]);
check("the bore depth knob sits on the drill axis, clear of the dock's middle and of the depth knob", nearVec(boreDepth.dir, [0, 0, -1]) && DOCK_KNOB_REACH - reachOf(boreDepth)! > 2 * HANDLE_KNOB_PICK && reachOf(boreDepth)! > 2 * HANDLE_KNOB_PICK);

const box = handlesFor("boolean", context("box"));
const moveX = box.find((handle) => handle.id === "move-x")!;
eq("a box move arrow sits at the ghost's centre and points along world X", [moveX.seat, moveX.dir], [{ at: "ghost", role: "centre", fallback: 0 }, [1, 0, 0]]);
eq("a handle carries its field's value", moveX.values, [2]);
eq("the box size knobs sit on the ghost's faces", box.filter((handle) => handle.id.startsWith("size-")).map((handle) => handle.seat), [
  { at: "ghost", role: "face", fallback: DOCK_KNOB_REACH },
  { at: "ghost", role: "face", fallback: DOCK_KNOB_REACH },
  { at: "ghost", role: "face", fallback: DOCK_KNOB_REACH },
]);
eq("the box turn rings sit at the ghost's centre", box.filter((handle) => handle.kind === "ring").every((handle) => handle.seat.at === "ghost" && handle.seat.role === "centre"), true);
const turnedBox = handlesFor("boolean", context("box", { read: (field) => (field === "modelRz" ? 90 : values[field] ?? 0) }));
check("a box turned a quarter about Z has its Width X knob along world Y", nearVec(turnedBox.find((handle) => handle.id === "size-0")!.dir, [0, 1, 0]));
const sizeZ = box.find((handle) => handle.id === "size-2")!;
eq("the box Z size knob points along Z from its face", [sizeZ.dir, sizeZ.seat], [[0, 0, 1], { at: "ghost", role: "face", fallback: DOCK_KNOB_REACH }]);
const cylinder = handlesFor("boolean", context("cylinder"));
eq("the cylinder radius and height knobs sit on the ghost", cylinder.filter((handle) => handle.kind === "axis" && handle.look === "knob").map((handle) => [handle.id, ghosted(handle)]), [["radius", true], ["height", true]]);
const ball = handlesFor("boolean", context("sphere"));
eq("the sphere radius knob sits on the ghost", ball.find((handle) => handle.id === "radius")!.seat, { at: "ghost", role: "face", fallback: DOCK_KNOB_REACH });
check("a sphere does not turn", !ball.some((handle) => handle.kind === "ring"));
eq("box and cylinder turn on three rings", cylinder.filter((handle) => handle.kind === "ring").map((handle) => handle.fields[0]), ["modelRx", "modelRy", "modelRz"]);
// The newer primitives: every size has a knob of its own on the dock, and no two knobs share a spot.
for (const { kind } of PRIMITIVES) {
  const knobs = handlesFor("boolean", context(kind)).filter((handle) => handle.look === "knob");
  const spots = new Set(knobs.map((handle) => handle.dir.map((value) => value.toFixed(3)).join(",")));
  eq(`a ${kind}'s size knobs each have a spot of their own`, spots.size, knobs.length);
  check(`a ${kind}'s size knobs sit on the ghost`, knobs.every(ghosted));
}
eq("a cone's knobs name its two radii", handlesFor("boolean", context("cone")).filter((handle) => handle.look === "knob").map((handle) => handle.label), ["Bottom radius", "Top radius", "Height"]);
eq("a torus turns, on three rings", handlesFor("boolean", context("torus")).filter((handle) => handle.kind === "ring").length, 3);
const sides = handlesFor("boolean", context("polygon")).find((handle) => handle.id === "sides")!;
eq("a polygon's sides drag in whole numbers from 3 to 64", [sides.whole, sides.min, sides.max], [true, 3, 64]);
eq("a side per four millimetres", dragValue(sides, 6, 10.4, false, false), 9);
eq("never past 64", dragValue(sides, 60, 100, false, false), 64);
eq("the sides label is a count", dragLabel(sides, [7]), "Sides 7");
eq("New solid has the size knobs alone: it places itself, unturned", handlesFor("create", context("cone")).map((handle) => handle.id), ["radius", "top-radius", "height"]);
eq("its knobs sit along the world axes", handlesFor("create", context("box", { read: (field) => (field === "modelRz" ? 90 : values[field] ?? 0) })).map((handle) => handle.dir), [[1, 0, 0], [0, 1, 0], [0, 0, 1]]);

const plane = handlesFor("split", context("box"))[0]!;
eq("the split arrow keeps the plane inside the part", [plane.min!, plane.max!, originOf(plane)![2]].map((value) => Math.round(value * 1e4) / 1e4), [0.251, 9.749, 5]);
eq("it points up Z and moves the plane one for one", [plane.dir, plane.rate, plane.label], [[0, 0, 1], 1, "Plane Z"]);
const tiltRingsOf = handlesFor("split", context("box")).filter((handle) => handle.kind === "ring");
eq("the split's two tilt rings are docked, about X and Y for a Z plane", tiltRingsOf.map((handle) => [handle.fields[0], docked(handle), handle.dir]), [["modelTiltA", true, [1, 0, 0]], ["modelTiltB", true, [0, 1, 0]]]);
const onX = handlesFor("split", context("box", { split: splitAt("x", 7) }))[0]!;
eq("an X plane's arrow sits on the pivot and points along X", [originOf(onX), onX.dir, onX.color, onX.label], [[7, 5, 5], [1, 0, 0], "x", "Plane X"]);
const intoFace = handlesFor("split", context("box", { split: splitAt("face", 2) }))[0]!;
eq("a face's arrow points into the part, where the offset grows", [originOf(intoFace), intoFace.dir, intoFace.rate, intoFace.label], [[5, 5, 8], [0, 0, -1], 1, "Offset"]);
const leaning = handlesFor("split", context("box", { split: splitAt("z", 5, [60, 0]) }))[0]!;
check("a plane tilted 60 degrees moves 1 mm for every 2 mm of its pivot", near(leaning.rate, 2));
check("a split with no plane yet has no handles", handlesFor("split", context("box", { split: null })).length === 0);
const blend = handlesFor("fillet", context("box"))[0]!;
check("the fillet knob sits one size out from the edge, on the feature", nearVec(originOf(blend)!, [5, -Math.SQRT1_2, 10 + Math.SQRT1_2]));
const factor = handlesFor("scale", context("box"))[0]!;
check("the scale knob moves one factor per half the part", near(factor.rate, 0.2));
eq("the scale knob is docked", docked(factor), true);
const depth = handlesFor("hole", context("box")).find((handle) => handle.id === "hole-depth")!;
eq("the depth knob is docked and pulls down", [depth.seat, depth.dir], [{ at: "dock", reach: DOCK_KNOB_REACH }, [0, 0, -1]]);
const side = handlesFor("hole", context("box", { holeAxis: [-1, 0, 0] })).find((handle) => handle.id === "hole-depth")!;
eq("a side hole's depth knob follows the face", side.dir, [-1, 0, 0]);
check("measure has two surface points", handlesFor("measure", context("box")).every((handle) => handle.kind === "surface" && handle.fields.length === 3));

// Every docked handle sits on the dock; only handles that edit a picked feature stay on the solid.
const everyTool = MODEL_TOOLS.flatMap((tool) => handlesFor(tool, context("box")));
eq("the origin dot, the blend knob, the split plane, the measure dots, the pull arrow, the feature dots and the mirror point stay on the feature", everyTool.filter((handle) => handle.seat.at === "feature").map((handle) => handle.id), ["plane", "blend", "blend", "hole-origin", "measure-a", "measure-b", "pull", "feat-at", "feat-at", "feat-at", "mir-origin"]);
check("boolean and new solid sit on the ghost, and Place stays on the dock", box.every(ghosted) && handlesFor("create", context("box")).every(ghosted) && handlesFor("place", context("box")).every(docked));
const pocket = handlesFor("pocket", context("box"));
eq("a pocket's position stays on the face and its depth knob points into it", [pocket.find((handle) => handle.id === "feat-at")!.seat.at, pocket.find((handle) => handle.id === "feat-depth")!.dir], ["feature", [0, 0, -1]]);
eq("texture pitch knobs are docked", handlesFor("texture", context("box")).filter((handle) => handle.id.startsWith("feat-pitch")).every(docked), true);
const shelled = handlesFor("shell", context("box", { shell: { point: [5, 5, 10], inward: [0, 0, -1] } }))[0]!;
eq("the thickness knob sits one thickness in from the first face, along its inward normal", [originOf(shelled), shelled.dir, shelled.fields, shelled.min], [[5, 5, 8], [0, 0, -1], ["modelShell"], 0.05]);
eq("with no face the thickness knob docks", handlesFor("shell", context("box")).map((handle) => [handle.id, handle.seat.at]), [["shell", "dock"]]);

// A hole slides in its face plane.
const holeDown = handlesFor("hole", context("box"));
const slides = holeDown.filter((handle) => handle.id.startsWith("hole-move-"));
eq("a hole has two in-plane move arrows", slides.length, 2);
eq("a straight-down hole slides along +X and +Y", slides.map((handle) => handle.dir), [[1, 0, 0], [0, 1, 0]]);
eq("those arrows move all three coordinates together", slides.map((handle) => handle.fields), [["modelX", "modelY", "modelZ"], ["modelX", "modelY", "modelZ"]]);
eq("those arrows are docked at the centre and coloured by the axis they follow", slides.map((handle) => [reachOf(handle), handle.color]), [[0, "x"], [0, "y"]]);
const holeSide = handlesFor("hole", context("box", { holeAxis: [-1, 0, 0] })).filter((handle) => handle.id.startsWith("hole-move-"));
check("a side hole's arrows are square to its drill", holeSide.every((handle) => near(handle.dir[0], 0)));
eq("a side hole slides along +Y and +Z", holeSide.map((handle) => handle.dir), [[0, 1, 0], [0, 0, 1]]);
const tilted = handlesFor("hole", context("box", { holeAxis: [-Math.SQRT1_2, 0, -Math.SQRT1_2] })).filter((handle) => handle.id.startsWith("hole-move-"));
check("a slanted hole's arrows stay square to its drill", tilted.every((handle) => near(handle.dir[0] * -Math.SQRT1_2 + handle.dir[2] * -Math.SQRT1_2, 0)));
eq("an arrow that lines up with no world axis takes the accent colour", tilted.map((handle) => handle.color), ["y", "accent"]);
eq("the hole's origin dot stays on the feature", originOf(holeDown.find((handle) => handle.id === "hole-origin")!), [2, 3, 10]);

// Sliding a point.
const slideAt45 = { fields: ["modelX", "modelY", "modelZ"], dir: [Math.SQRT1_2, Math.SQRT1_2, 0] as Vec3, rate: 1, step: 1 };
eq("ten millimetres along a 45 degree in-plane arrow moves X and Y by 7.0711 and not Z", axisValues(slideAt45, [2, 3, 10], 10, false, false), [9.0711, 10.0711, 10]);
eq("Ctrl snaps the travel to whole millimetres", axisValues(slideAt45, [0, 0, 5], 3.4, true, false), [2.1213, 2.1213, 5]);
eq("one field slides like dragValue", axisValues({ fields: ["modelDx"], dir: [1, 0, 0], rate: 1, step: 1, min: 0.1 }, [4], -9, false, false), [0.1]);

// Shift is fine, Ctrl snaps.
const mm: Pick<DragHandle, "rate" | "step" | "min" | "max"> = { rate: 1, step: 1, min: 0.1 };
eq("a free drag rounds to a tenth", dragValue(mm, 5, 1.234, false, false), 6.2);
eq("a fine drag rounds to a hundredth", dragValue(mm, 5, 0.1234, false, true), 5.12);
eq("ctrl snaps to whole steps", dragValue(mm, 5, 1.6, true, false), 7);
eq("a size stops at its minimum", dragValue(mm, 1, -5, false, false), 0.1);
eq("a limit off the tenths holds exactly", dragValue({ rate: 1, step: 1, min: 0.25, max: 9.75 }, 5, 40, false, false), 9.75);
eq("the scale knob snaps to tenths", dragValue({ rate: 0.2, step: 0.1, min: 0.1, max: 20 }, 2, 1.3, true, false), 2.3);
eq("turns snap to 15 degrees", dragValue({ rate: 1, step: 15 }, 0, 22, true, false), 15);

let pointer = startFine(100, 100, false);
pointer = moveFine(pointer, 150, 100, false);
eq("a plain drag follows the pointer", [pointer.x, pointer.y], [150, 100]);
pointer = moveFine(pointer, 150, 100, true);
eq("pressing Shift does not jump", [pointer.x, pointer.y], [150, 100]);
pointer = moveFine(pointer, 250, 100, true);
eq("Shift moves a tenth as far", [pointer.x, pointer.y], [160, 100]);
pointer = moveFine(pointer, 250, 100, false);
pointer = moveFine(pointer, 260, 100, false);
eq("releasing Shift goes back to full speed from where it was", [pointer.x, pointer.y], [170, 100]);

const t = lineParam([0, 0, 0], [1, 0, 0], [3, -5, 2], [0, 1, 0]);
check("the axis point under a ray", t != null && near(t, 3));
check("a ray along the axis has no answer", lineParam([0, 0, 0], [1, 0, 0], [0, 0, 0], [1, 0, 0]) == null);

const quarter = turnedAxes([0, 0, 90]);
check("a quarter turn about Z puts X on Y", nearVec(quarter[0], [0, 1, 0]));
const tipped = turnedAxes([90, 0, 0]);
check("a quarter turn about X puts Z on -Y", nearVec(tipped[2], [0, -1, 0]));
const both = turnedAxes([0, 30, 40]);
check("the X ring follows the Y and Z turns", nearVec(turnGimbal([0, 30, 40])[0], both[0]));

const anchor = edgeAnchor(new Float32Array([0, 0, 10, 10, 0, 10]), [5, 5, 5]);
check("an edge anchors at its middle", !!anchor && nearVec(anchor.point, [5, 0, 10]));
check("the anchor points out of the solid, square to the edge", !!anchor && nearVec(anchor.out, [0, -Math.SQRT1_2, Math.SQRT1_2]));
check("a one-point edge has no anchor", edgeAnchor(new Float32Array([1, 2, 3]), [0, 0, 0]) == null);

eq("degrees wrap", [wrapDegrees(190), wrapDegrees(-190), wrapDegrees(180), wrapDegrees(-180)], [-170, 170, 180, 180]);
eq("a length label", dragLabel({ label: "Width X", unit: "mm" }, [12.345]), "Width X 12.35 mm");
eq("a turn label", dragLabel({ label: "Turn Z", unit: "°" }, [45]), "Turn Z 45°");
eq("a factor label", dragLabel({ label: "Factor", unit: "×" }, [1.5]), "Factor 1.5×");
eq("a point label", dragLabel({ label: "A", unit: "mm" }, [1, 2, 3]), "A 1, 2, 3 mm");
eq("a hole radius knob reads as the diameter", dragLabel({ label: "Diameter", unit: "mm", shown: 2 }, [1.7]), "Diameter 3.4 mm");
const a: Vec3 = [0, 0, 0];
eq("the measure note", measureNote(a, [3, 4, 0]), "Distance 5 mm. ΔX 3, ΔY 4, ΔZ 0 mm.");

const wp = handlesFor("workplane", context("box"));
eq("the workplane drags from the dock", wp.map(docked), [true, true, true, true, true, true]);
eq("on the global frame its arrows slide the origin along X, Y, Z", wp.filter((handle) => handle.kind === "axis").map((handle) => [handle.fields, handle.dir, handle.label]), [
  [["modelWpX", "modelWpY", "modelWpZ"], [1, 0, 0], "Move U"],
  [["modelWpX", "modelWpY", "modelWpZ"], [0, 1, 0], "Move V"],
  [["modelWpX", "modelWpY", "modelWpZ"], [0, 0, 1], "Move W"],
]);
eq("its rings turn it about model X, Y, Z, as Place's do", wp.filter((handle) => handle.kind === "ring").map((handle) => [handle.fields[0], handle.label]), [["modelWpRx", "Turn X"], ["modelWpRy", "Turn Y"], ["modelWpRz", "Turn Z"]]);
const sideFace = workplaneOnFace({ point: [20, 5, 4], normal: [1, 0, 0] });
const sideAxes = axesOf(sideFace);
const sideWp = handlesFor("workplane", context("box", { frame: sideFace })).filter((handle) => handle.kind === "axis");
eq("on a side face its arrows slide the origin along U, V, W", sideWp.map((handle) => handle.dir), sideAxes);

eq("the global frame keeps the box's arrows on X", handlesFor("boolean", context("box", { frame: GLOBAL_WORKPLANE })).filter((handle) => handle.id.startsWith("move-")).map((handle) => [handle.dir, handle.label]), [[[1, 0, 0], "Move X"], [[0, 1, 0], "Move Y"], [[0, 0, 1], "Move Z"]]);
const globalHole = handlesFor("hole", context("box", { frame: GLOBAL_WORKPLANE }));
eq("and the hole's slides on three fields, as before workplanes", globalHole.filter((handle) => handle.id.startsWith("hole-move-")).map((handle) => [handle.fields.length, handle.dir]), [[3, [1, 0, 0]], [3, [0, 1, 0]]]);
check("and the hole's dot writes model space", globalHole.find((handle) => handle.id === "hole-origin")!.frame === undefined);

const bed = { source: "bed" as const, origin: [10, 0, 0] as Vec3, turn: [0, 0, 0] as Vec3 };
const bedHole = handlesFor("hole", context("box", { frame: bed }));
eq("a moved frame puts the hole dot on the model-space point", originOf(bedHole.find((handle) => handle.id === "hole-origin")!), [12, 3, 10]);
check("and the dot writes the frame's U, V, W", bedHole.find((handle) => handle.id === "hole-origin")!.frame === bed);
eq("a moved frame names its arrows U and V", bedHole.filter((handle) => handle.id.startsWith("hole-move-")).map((handle) => [handle.fields, handle.label]), [[["modelX"], "Move U"], [["modelY"], "Move V"]]);
const sideMoves = handlesFor("boolean", context("box", { frame: sideFace })).filter((handle) => handle.id.startsWith("move-"));
eq("a turned frame moves a box along U, V, W", sideMoves.map((handle) => [handle.fields[0], handle.dir, handle.label]), [["modelX", sideAxes[0], "Move U"], ["modelY", sideAxes[1], "Move V"], ["modelZ", sideAxes[2], "Move W"]]);
const sideKnob = handlesFor("boolean", context("box", { frame: sideFace })).find((handle) => handle.fields[0] === "modelDz")!;
check("and its height knob runs along W", nearVec(sideKnob.dir, sideAxes[2]));
const sideSlides = handlesFor("hole", context("box", { frame: sideFace })).filter((handle) => handle.id.startsWith("hole-move-"));
eq("a turned frame slides a hole along U and V, one field each", sideSlides.map((handle) => [handle.fields, handle.dir]), [[["modelX"], sideAxes[0]], [["modelY"], sideAxes[1]]]);
eq("a split on a workplane names its arrow by U, V, W", handlesFor("split", context("box", { frame: sideFace })).find((handle) => handle.id === "plane")!.label, "Plane W");

if (failed) {
  console.error(`model-drag: ${failed} failed`);
  throw new Error(`model-drag: ${failed} failed`);
}
console.log("model-drag: every tool drags every number, with fine and snap ok");
