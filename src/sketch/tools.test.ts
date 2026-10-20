/**
 * S3 drawing tools: circle, arc, polygon, slot, spline, trim, offset, fillet, construction, use.
 * Each one with the pointer and with a typed size. Line and rectangle stay covered in shell.test.ts.
 */
import { arcFrom3, arcPoint } from "./geom.ts";
import { sketchPoint, type SketchData } from "./model.ts";
import { activeSketch, commitSizes, enterSketch, previewSizes, sketchDimensions, sketchKey, sketchOff, sketchPointer, sketchReadout, undoSketch, withRefs, withTool, type SketchEditor, type SketchEnv } from "./session.ts";
import { arcFromChord, hitReference, regularPolygon, slotWidth, tangentArcBySweep } from "./tools.ts";
import { planeOf, originFrame } from "./frame.ts";

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
  console.error(`FAIL ${name}\n  got  ${got}\n  want ${want}`);
}

const env: SketchEnv = { mmPerPx: 0.25, project: (at) => ({ x: at[0], y: at[1] }) };
const fine: SketchEnv = { mmPerPx: 0.05, project: env.project };
const click = (editor: SketchEditor, uv: [number, number], extra: Partial<Parameters<typeof sketchPointer>[1]> = {}, scale = fine) => {
  let next = sketchPointer(editor, { phase: "down", uv, sx: uv[0], sy: uv[1], shift: false, ctrl: false, alt: false, ...extra }, scale);
  next = sketchPointer(next, { phase: "move", uv, sx: uv[0], sy: uv[1], shift: false, ctrl: false, alt: false, ...extra }, scale);
  return sketchPointer(next, { phase: "up", uv, sx: uv[0], sy: uv[1], shift: false, ctrl: false, alt: false, ...extra }, scale);
};
const plane = planeOf(originFrame("XY"));
const open = (tool: SketchEditor["tool"] = "line") => withTool(enterSketch(sketchOff(), plane), tool);

const quarter = arcFromChord([1, 0], [0, 1], 1, Math.PI / 2);
check("a quarter circle from its chord ends on the second point", !!quarter && Math.hypot(arcPoint(quarter, 1)[0] - 0, arcPoint(quarter, 1)[1] - 1) < 1e-6);
check("and its middle is the unit arc", !!quarter && Math.abs(arcPoint(quarter, 0.5)[0] - Math.SQRT1_2) < 1e-6 && Math.abs(arcPoint(quarter, 0.5)[1] - Math.SQRT1_2) < 1e-6);
const turned = tangentArcBySweep([0, 0], [1, 0], 10, Math.PI / 2);
check("a tangent quarter turn ends a radius up and across", !!turned && Math.abs(arcPoint(turned, 1)[0] - 10) < 1e-6 && Math.abs(arcPoint(turned, 1)[1] - 10) < 1e-6);
const hex = regularPolygon([0, 0], [10, 0], 6);
eq("a hexagon has six corners", hex.length, 6);
near("the second corner is 60 degrees on", hex[1]?.[1] ?? 0, 10 * Math.sin(Math.PI / 3), 1e-9);
near("slot width is twice the distance off the centre line", slotWidth([0, 0], [10, 0], [5, 2]), 4);

let editor = open("circle");
check("the readout names the circle", sketchReadout(editor).startsWith("Circle."));
editor = click(editor, [0, 0]);
editor = sketchPointer(editor, { phase: "move", uv: [4, 0], sx: 4, sy: 0, shift: false, ctrl: false, alt: false }, fine);
eq("a circle in progress offers a diameter", sketchDimensions(editor)?.fields.map((field) => field.id), ["diameter"]);
editor = commitSizes(editor, [20]);
const circle = activeSketch(editor)?.entities.find((entity) => entity.kind === "circle");
check("typing a diameter builds the circle", !!circle && circle.kind === "circle" && circle.radius === 10, JSON.stringify(circle));
editor = undoSketch(editor);
eq("undo removes the circle", activeSketch(editor)?.entities.length, 0);

editor = open("circle");
editor = click(editor, [1, 2]);
editor = click(editor, [1, 6]);
const dragged = activeSketch(editor)?.entities.find((entity) => entity.kind === "circle");
check("two clicks set the centre and the radius", !!dragged && dragged.kind === "circle" && dragged.radius === 4);

editor = open("arc");
editor = click(editor, [0, 0]);
editor = click(editor, [10, 0]);
editor = sketchPointer(editor, { phase: "move", uv: [5, 4], sx: 5, sy: 4, shift: false, ctrl: false, alt: false }, fine);
eq("an arc offers a radius and a sweep", sketchDimensions(editor)?.fields.map((field) => field.id), ["radius", "sweep"]);
editor = click(editor, [5, 5]);
const arc = activeSketch(editor)?.entities.find((entity) => entity.kind === "arc");
check("three clicks build the arc", !!arc && arc.kind === "arc");
if (arc && arc.kind === "arc") {
  const sketch = activeSketch(editor)!;
  const built = arcFrom3(sketchPoint(sketch, arc.a)!.at, arc.through, sketchPoint(sketch, arc.b)!.at);
  near("the arc passes through the third click", built ? arcPoint(built, 0.5)[1] : 0, 5, 1e-6);
  eq("and runs from the first click to the second", [sketchPoint(sketch, arc.a)!.at, sketchPoint(sketch, arc.b)!.at], [[0, 0], [10, 0]]);
}
editor = open("line");
editor = click(editor, [0, 0]);
editor = click(editor, [10, 0]);
editor = sketchKey(editor, "Escape", { ctrl: false, meta: false, shift: false })!;
editor = sketchKey(editor, "a", { ctrl: false, meta: false, shift: true })!;
editor = click(editor, [20, 10]);
const tangent = activeSketch(editor)?.entities.find((entity) => entity.kind === "arc");
check("shift-A builds a tangent arc off the last line", !!tangent && tangent.kind === "arc");
if (tangent && tangent.kind === "arc") {
  const start = sketchPoint(activeSketch(editor)!, tangent.a)?.at;
  near("it leaves the end of the line", start?.[0] ?? -1, 10);
  near("along that line", start?.[1] ?? -1, 0);
}

editor = open("polygon");
editor = click(editor, [0, 0]);
editor = sketchPointer(editor, { phase: "move", uv: [10, 0], sx: 10, sy: 0, shift: false, ctrl: false, alt: false }, fine);
eq("a polygon offers corners, flats, and sides", sketchDimensions(editor)?.fields.map((field) => field.id), ["corners", "flats", "sides"]);
editor = commitSizes(editor, [20, 10, 4]);
const poly = activeSketch(editor)!;
eq("typing flats and sides builds a square", poly.entities.filter((entity) => entity.kind === "line").length, 4);
const far = Math.max(...poly.points.map((point) => Math.hypot(point.at[0], point.at[1])));
near("the square reaches the flat size", far, 5 / Math.cos(Math.PI / 4), 1e-6);

editor = open("polygon");
editor = click(editor, [0, 0]);
editor = previewSizes(editor, [20, 0, 6]);
editor = previewSizes(editor, [20, 0, 4]);
editor = commitSizes(editor, [20, 0, 4]);
const sided = activeSketch(editor)!;
eq("changing sides keeps the typed across-corners size", sided.entities.filter((entity) => entity.kind === "line").length, 4);
near("that square is still 20 across corners", Math.max(...sided.points.map((point) => Math.hypot(point.at[0], point.at[1]))), 10, 1e-6);

editor = open("slot");
editor = click(editor, [0, 0]);
editor = click(editor, [10, 0]);
editor = sketchPointer(editor, { phase: "move", uv: [5, 1], sx: 5, sy: 1, shift: false, ctrl: false, alt: false }, fine);
eq("a slot offers length and width", sketchDimensions(editor)?.fields.map((field) => field.id), ["length", "width"]);
editor = commitSizes(editor, [10, 4]);
const slot = activeSketch(editor)!;
eq("a slot is two lines and two arcs", slot.entities.map((entity) => entity.kind).sort(), ["arc", "arc", "line", "line"]);
const top = slot.points.some((point) => Math.abs(point.at[1] - 2) < 1e-6);
const caps = slot.entities.filter((entity) => entity.kind === "arc").map((entity) => (entity.kind === "arc" ? entity.through[0] : 0));
check("the slot is 4 wide, with caps past the centres", top && caps.some((x) => Math.abs(x - 12) < 1e-6) && caps.some((x) => Math.abs(x + 2) < 1e-6), JSON.stringify(slot.entities));

editor = open("spline");
editor = click(editor, [0, 0]);
editor = click(editor, [5, 2]);
editor = click(editor, [10, 0]);
editor = sketchKey(editor, "Enter", { ctrl: false, meta: false, shift: false })!;
const spline = activeSketch(editor)?.entities.find((entity) => entity.kind === "spline");
check("enter ends an open spline through the clicks", !!spline && spline.kind === "spline" && spline.through.length === 3);
editor = open("spline");
editor = click(editor, [0, 0]);
editor = click(editor, [4, 3]);
editor = click(editor, [8, 0]);
editor = click(editor, [0, 0]);
const closed = activeSketch(editor)?.entities.find((entity) => entity.kind === "spline");
check("clicking the start closes the spline", !!closed && closed.kind === "spline" && closed.through[0] === closed.through[closed.through.length - 1]);

const cross = (sketch: SketchData) => sketch;
editor = open("line");
editor = click(editor, [0, 0]);
editor = click(editor, [10, 0]);
editor = sketchKey(editor, "Escape", { ctrl: false, meta: false, shift: false })!;
editor = withTool(editor, "line");
editor = click(editor, [4, -4]);
editor = click(editor, [4, 4]);
editor = sketchKey(editor, "Escape", { ctrl: false, meta: false, shift: false })!;
editor = sketchKey(editor, "t", { ctrl: false, meta: false, shift: false })!;
check("trim says what to click", sketchReadout(editor).startsWith("Trim."));
const before = activeSketch(editor)!;
void cross(before);
editor = click(editor, [8, 0]);
const trimmed = activeSketch(editor)!;
check("trimming keeps both lines, one of them shorter", trimmed.entities.length === before.entities.length && trimmed.entities.every((entity) => entity.kind === "line"));
const kept = trimmed.entities.filter((entity) => entity.kind === "line").map((entity) => {
  if (entity.kind !== "line") return null;
  const a = sketchPoint(trimmed, entity.a)?.at;
  const b = sketchPoint(trimmed, entity.b)?.at;
  return a && b ? [a[0], a[1], b[0], b[1]] : null;
});
check("the horizontal line now stops at the crossing", kept.some((ends) => ends && Math.abs(ends[0] - 0) < 1e-6 && Math.abs(ends[2] - 4) < 1e-6), JSON.stringify(kept));

editor = open("line");
editor = click(editor, [0, 0]);
editor = click(editor, [10, 0]);
editor = sketchKey(editor, "Escape", { ctrl: false, meta: false, shift: false })!;
editor = sketchKey(editor, "f", { ctrl: false, meta: false, shift: false })!;
editor = click(editor, [5, 0]);
editor = commitSizes(editor, [3]);
const raised = activeSketch(editor)!.entities.filter((entity) => entity.kind === "line");
check("typing an offset distance adds a parallel line", raised.length === 2);
const heights = raised.map((entity) => (entity.kind === "line" ? sketchPoint(activeSketch(editor)!, entity.a)?.at[1] : 0));
check("the new line sits the typed distance to the left", heights.some((y) => Math.abs((y ?? 0) - 3) < 1e-6), JSON.stringify(heights));
const copy = raised.find((entity) => entity.kind === "line" && Math.abs((sketchPoint(activeSketch(editor)!, entity.a)?.at[1] ?? 0) - 3) < 1e-6);
const copyEnds = copy && copy.kind === "line" ? [sketchPoint(activeSketch(editor)!, copy.a)!.at[0], sketchPoint(activeSketch(editor)!, copy.b)!.at[0]].sort((a, b) => a - b) : [];
eq("and spans the same run, 0 to 10", copyEnds, [0, 10]);

editor = open("line");
editor = click(editor, [0, 0]);
editor = click(editor, [10, 0]);
editor = sketchKey(editor, "Escape", { ctrl: false, meta: false, shift: false })!;
editor = withTool(editor, "line");
editor = click(editor, [0, 0]);
editor = click(editor, [0, 10]);
editor = sketchKey(editor, "Escape", { ctrl: false, meta: false, shift: false })!;
editor = sketchKey(editor, "g", { ctrl: false, meta: false, shift: false })!;
editor = click(editor, [6, 0]);
editor = click(editor, [0, 6]);
check("two lines arm the fillet", sketchDimensions(editor)?.fields[0]?.id === "radius");
editor = commitSizes(editor, [2]);
const rounded = activeSketch(editor)!;
check("typing a radius adds the corner arc", rounded.entities.some((entity) => entity.kind === "arc"), JSON.stringify(rounded.entities.map((entity) => entity.kind)));
const round = rounded.entities.find((entity) => entity.kind === "arc");
if (round && round.kind === "arc") {
  near("the arc bulges into the corner", round.through[0], 2 - Math.SQRT2, 1e-6);
  eq("and meets the lines where they were cut back, 2 from the corner", [sketchPoint(rounded, round.a)!.at, sketchPoint(rounded, round.b)!.at].map((at) => at.map((v) => Math.round(v * 1e6) / 1e6)).sort(), [[0, 2], [2, 0]]);
}

editor = open("line");
editor = click(editor, [0, 0]);
editor = click(editor, [4, 0]);
editor = sketchKey(editor, "Escape", { ctrl: false, meta: false, shift: false })!;
editor = sketchKey(editor, "x", { ctrl: false, meta: false, shift: false })!;
editor = click(editor, [2, 0]);
check("construction toggles the clicked line", activeSketch(editor)?.entities[0]?.construction === true);
editor = click(editor, [2, 0]);
check("clicking again clears it", activeSketch(editor)?.entities[0]?.construction === undefined);

const refs = {
  segments: [
    { a: [0, 0] as [number, number], b: [6, 0] as [number, number], source: "edge" as const },
    { a: [0, 0] as [number, number], b: [0, 4] as [number, number], source: "outline" as const },
    { a: [0, 4] as [number, number], b: [6, 4] as [number, number], source: "outline" as const },
  ],
  vertices: [],
};
eq("an outline wins a tie with an edge", hitReference(refs, [0, 2], 0.5), 1);
editor = withRefs(open("use"), refs);
check("use says to click a faint edge", sketchReadout(editor).startsWith("Use."));
editor = click(editor, [3, 0]);
eq("using an edge copies that one line", activeSketch(editor)?.entities.length, 1);
editor = click(editor, [0, 2]);
eq("using the outline copies every outline segment", activeSketch(editor)?.entities.length, 3);
editor = click(editor, [3, 0]);
check("using the same edge again says so", sketchReadout(editor).includes("already in the sketch"));

// Use on a curved edge copies the curve, and on the outline only the loop that was clicked.
{
  type P = [number, number];
  const ring = (cx: number, cy: number, r: number, from: number, to: number, count: number): P[] => Array.from({ length: count + 1 }, (_, k) => [cx + r * Math.cos(from + ((to - from) * k) / count), cy + r * Math.sin(from + ((to - from) * k) / count)] as P);
  const pieces = (points: P[], extra: Record<string, unknown>) => points.slice(1).map((b, i) => ({ a: points[i]!, b, ...extra }));
  const square = (x: number, size: number): P[] => [[x, x], [x + size, x], [x + size, x + size], [x, x + size], [x, x]];
  const curved = {
    segments: [
      ...pieces(ring(30, 0, 5, 0, 2 * Math.PI, 32), { source: "edge" as const, edge: 0 }),
      ...pieces(ring(60, 0, 8, 0, Math.PI / 2, 8), { source: "edge" as const, edge: 1 }),
      ...pieces(square(0, 20), { source: "outline" as const }),
      ...pieces(square(5, 4), { source: "outline" as const }),
    ],
    vertices: [],
  };
  let used = withRefs(open("use"), curved);
  used = click(used, [35, 0]);
  const circles = activeSketch(used)!.entities.filter((entity) => entity.kind === "circle");
  eq("a circular edge is one circle, not 32 lines", activeSketch(used)!.entities.map((entity) => entity.kind), ["circle"]);
  near("of the edge's radius", circles[0]?.kind === "circle" ? circles[0].radius : 0, 5, 1e-6);
  used = click(used, [60 + 8 * Math.cos(Math.PI / 4), 8 * Math.sin(Math.PI / 4)]);
  eq("a quarter-circle edge is one arc", activeSketch(used)!.entities.map((entity) => entity.kind), ["circle", "arc"]);
  used = click(used, [10, 0]);
  eq("the outer outline is its four sides, not the hole's too", activeSketch(used)!.entities.map((entity) => entity.kind), ["circle", "arc", "line", "line", "line", "line"]);
  used = click(used, [5, 7]);
  eq("and a click on the hole copies the hole", activeSketch(used)!.entities.length, 10);
  const decagon = { segments: pieces(ring(0, 0, 10, 0, 2 * Math.PI, 10), { source: "outline" as const }), vertices: [] };
  const sides = click(withRefs(open("use"), decagon), [(10 + 10 * Math.cos(Math.PI / 5)) / 2, (10 * Math.sin(Math.PI / 5)) / 2]);
  eq("a decagon outline stays ten sides, not a circle", activeSketch(sides)!.entities.map((entity) => entity.kind), Array(10).fill("line"));
}

editor = open("line");
eq("C switches to the circle without leaving the sketch", sketchKey(editor, "c", { ctrl: false, meta: false, shift: false })?.tool, "circle");
check("plain S does not start a second sketch", sketchKey(editor, "s", { ctrl: false, meta: false, shift: false }) === editor);
eq("shift-S is the slot", sketchKey(editor, "S", { ctrl: false, meta: false, shift: true })?.tool, "slot");

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("sketch tools ok");
