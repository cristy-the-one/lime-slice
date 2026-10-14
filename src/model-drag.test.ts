import { readFileSync } from "node:fs";
import { DOCK_KNOB_REACH } from "./gizmo-math.ts";
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
  modelRx: 0, modelRy: 0, modelRz: 0, modelPlaneZ: 5, modelBlend: 1, modelHoleR: 2, modelHoleD: 12, modelFactor: 2,
  modelAx: 0, modelAy: 0, modelAz: 0, modelBx: 10, modelBy: 0, modelBz: 0,
};
function context(primitive: DragContext["primitive"], extra: Partial<DragContext> = {}): DragContext {
  return {
    read: (field) => values[field] ?? 0,
    primitive,
    center: [5, 5, 5],
    extent: 10,
    split: { min: 0.25, max: 9.75 },
    edge: { point: [5, 0, 10], out: [0, -Math.SQRT1_2, Math.SQRT1_2] },
    ...extra,
  };
}
for (const tool of MODEL_TOOLS) {
  const dragged = new Set<string>();
  for (const primitive of ["box", "cylinder", "sphere"] as const) {
    for (const handle of handlesFor(tool, context(primitive))) handle.fields.forEach((field) => dragged.add(field));
  }
  for (const field of DRAG_FIELDS[tool]) check(`${tool} has a handle for ${field}`, dragged.has(field));
}
check("a fillet with no edge has no handle yet", handlesFor("fillet", context("box", { edge: null })).length === 0);
check("no tool, no handles", handlesFor(null, context("box")).length === 0);

const docked = (handle: DragHandle) => handle.seat.at === "dock";
const reachOf = (handle: DragHandle) => (handle.seat.at === "dock" ? handle.seat.reach : null);
const originOf = (handle: DragHandle) => (handle.seat.at === "feature" ? handle.seat.origin : null);

const box = handlesFor("boolean", context("box"));
const moveX = box.find((handle) => handle.id === "move-x")!;
eq("a box move arrow is docked at the centre and points along world X", [reachOf(moveX), moveX.dir], [0, [1, 0, 0]]);
eq("a handle carries its field's value", moveX.values, [2]);
eq("the box size knobs are docked", box.filter((handle) => handle.id.startsWith("size-")).map(docked), [true, true, true]);
eq("the box turn rings are docked", box.filter((handle) => handle.kind === "ring").map(docked), [true, true, true]);
const turnedBox = handlesFor("boolean", context("box", { read: (field) => (field === "modelRz" ? 90 : values[field] ?? 0) }));
check("a box turned a quarter about Z has its Size X knob along world Y", nearVec(turnedBox.find((handle) => handle.id === "size-0")!.dir, [0, 1, 0]));
const sizeZ = box.find((handle) => handle.id === "size-2")!;
eq("the box Z size knob sits out along Z, past the arrows", [sizeZ.dir, reachOf(sizeZ)], [[0, 0, 1], DOCK_KNOB_REACH]);
const cylinder = handlesFor("boolean", context("cylinder"));
eq("the cylinder radius and height knobs are docked", cylinder.filter((handle) => handle.kind === "axis" && handle.look === "knob").map((handle) => [handle.id, docked(handle)]), [["radius", true], ["height", true]]);
const ball = handlesFor("boolean", context("sphere"));
eq("the sphere radius knob is docked", ball.find((handle) => handle.id === "radius")!.seat, { at: "dock", reach: DOCK_KNOB_REACH });
check("a sphere does not turn", !ball.some((handle) => handle.kind === "ring"));
eq("box and cylinder turn on three rings", cylinder.filter((handle) => handle.kind === "ring").map((handle) => handle.fields[0]), ["modelRx", "modelRy", "modelRz"]);
const plane = handlesFor("split", context("box"))[0]!;
eq("the split arrow keeps the plane inside the part", [plane.min, plane.max, originOf(plane)![2]], [0.25, 9.75, 5]);
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
eq("the origin dot, the blend knob, the split plane and the measure dots stay on the feature", everyTool.filter((handle) => !docked(handle)).map((handle) => handle.id), ["plane", "blend", "blend", "hole-origin", "measure-a", "measure-b"]);

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
eq("a length label", dragLabel({ label: "Size X", unit: "mm" }, [12.345]), "Size X 12.35 mm");
eq("a turn label", dragLabel({ label: "Turn Z", unit: "°" }, [45]), "Turn Z 45°");
eq("a factor label", dragLabel({ label: "Factor", unit: "×" }, [1.5]), "Factor 1.5×");
eq("a point label", dragLabel({ label: "A", unit: "mm" }, [1, 2, 3]), "A 1, 2, 3 mm");
const a: Vec3 = [0, 0, 0];
eq("the measure note", measureNote(a, [3, 4, 0]), "Distance 5 mm. ΔX 3, ΔY 4, ΔZ 0 mm.");

if (failed) {
  console.error(`model-drag: ${failed} failed`);
  throw new Error(`model-drag: ${failed} failed`);
}
console.log("model-drag: every tool drags every number, with fine and snap ok");
