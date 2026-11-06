/**
 * K1 (sketch for people, milestone 7): constraints while drawing. Each inference, the Ctrl skip, one undo step for a
 * line and its rules, the solver agreeing with what is stored, and a saved sketch reading back unchanged.
 */
import { fittingActions } from "./constrain.ts";
import { keepRules } from "./infer.ts";
import { planeOf, originFrame } from "./frame.ts";
import { addCircle, addLine, emptySketch, readSketch, sketchJson, sketchPoint, type Pt, type SketchData } from "./model.ts";
import { activeSketch, commitSizes, constrainChoices, enterSketch, inferenceMarks, sketchKey, sketchOff, sketchPointer, sketchReadout, undoSketch, withTool, type SketchEditor, type SketchEnv, type SketchPointer } from "./session.ts";
import { constraintStatus, dragSketch, parseConstraints } from "./solve.ts";

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

// 20 px per mm would be too coarse to tell a rule from the grid: 0.05 mm a pixel puts the reach of every rule at 0.4 mm
// and the grid at 1 mm.
const env: SketchEnv = { mmPerPx: 0.05, project: (at) => ({ x: at[0], y: at[1] }) };
const plane = planeOf(originFrame("XY"));
const open = () => withTool(enterSketch(sketchOff(), plane), "line");

function pointer(phase: SketchPointer["phase"], uv: Pt, extra: Partial<SketchPointer> = {}): SketchPointer {
  return { phase, uv, sx: uv[0], sy: uv[1], shift: false, ctrl: false, alt: false, ...extra };
}
const click = (editor: SketchEditor, uv: Pt, extra: Partial<SketchPointer> = {}) => sketchPointer(sketchPointer(editor, pointer("down", uv, extra), env), pointer("up", uv, extra), env);
const move = (editor: SketchEditor, uv: Pt, extra: Partial<SketchPointer> = {}) => sketchPointer(editor, pointer("move", uv, extra), env);
const sketchOf = (editor: SketchEditor): SketchData => activeSketch(editor)!;
const kinds = (sketch: SketchData) => parseConstraints(sketch).map((item) => item.kind);
const lineEnds = (sketch: SketchData, index: number): [Pt, Pt] => {
  const line = sketch.entities.filter((entity) => entity.kind === "line")[index];
  if (line?.kind !== "line") throw new Error("no line");
  return [sketchPoint(sketch, line.a)!.at, sketchPoint(sketch, line.b)!.at];
};
const texts = (editor: SketchEditor) => inferenceMarks(editor).map((mark) => mark.text);

// --- H: a line within reach of level is placed level and keeps it. ---
let editor = open();
editor = click(editor, [0, 0]);
editor = move(editor, [20, 0.25]);
eq("a line near level shows H beside the pointer", texts(editor), ["H"]);
check("and the status line says what the click keeps", sketchReadout(editor).includes("Click keeps it horizontal. Ctrl skips."), sketchReadout(editor));
editor = click(editor, [20, 0.25]);
eq("the click keeps horizontal", kinds(sketchOf(editor)), ["horizontal"]);
eq("and the end sits exactly level", lineEnds(sketchOf(editor), 0)[1], [20, 0]);
check("no mark is left once the point is placed", texts(editor).length <= 1);

// --- V, in the same polyline. The line before is level, so square to it comes free and is not stored twice. ---
editor = move(editor, [20.2, 30]);
eq("a line near upright shows V and no square mark", texts(editor), ["V"]);
editor = click(editor, [20.2, 30]);
eq("the click keeps vertical, and square is not repeated", kinds(sketchOf(editor)), ["horizontal", "vertical"]);
eq("the L has no slack", lineEnds(sketchOf(editor), 1), [[20, 0], [20, 30]]);
check("the solver agrees with what is stored", (constraintStatus(sketchOf(editor))?.conflicting.length ?? 1) === 0 && (constraintStatus(sketchOf(editor))?.redundant.length ?? 1) === 0);

// --- Dragging a corner of the L keeps both sides level and upright: the constraints are real. ---
const corner = sketchOf(editor).entities.find((entity) => entity.kind === "line")!;
const moved = dragSketch(sketchOf(editor), [corner.kind === "line" ? corner.b : 0], [3, 4]);
const [, bent] = lineEnds(moved, 0);
const [stand, top] = lineEnds(moved, 1);
check("a dragged corner keeps the bottom level", Math.abs(lineEnds(moved, 0)[0][1] - bent[1]) < 1e-6);
check("and the side upright", Math.abs(stand[0] - top[0]) < 1e-6);

// --- One undo step takes the line and its rules. ---
const before = sketchOf(editor);
editor = undoSketch(editor);
eq("undo takes the second line and its vertical together", [sketchOf(editor).entities.length, kinds(sketchOf(editor))], [1, ["horizontal"]]);
check("and left the drawing it was before", JSON.stringify(sketchOf(editor).dims) !== JSON.stringify(before.dims));
editor = undoSketch(editor);
eq("one more takes the first line and its horizontal", [sketchOf(editor).entities.length, sketchOf(editor).dims ?? null], [0, null]);

// --- Square to the line before: a slanted line first (Ctrl, so it keeps nothing), then one square to it. ---
editor = open();
editor = click(editor, [0, 0]);
editor = click(editor, [10, 10], { ctrl: true });
eq("a Ctrl-click keeps nothing", sketchOf(editor).dims ?? null, null);
editor = move(editor, [25, -5.1]);
eq("a line near square to the one before shows the square mark", texts(editor), ["⊥"]);
check("and the readout says so", sketchReadout(editor).includes("square to the last line"), sketchReadout(editor));
editor = click(editor, [25, -5.1]);
eq("the click keeps perpendicular", kinds(sketchOf(editor)), ["perpendicular"]);
const [p, q] = lineEnds(sketchOf(editor), 1);
const [a, b] = lineEnds(sketchOf(editor), 0);
check("and the two lines are square", Math.abs((q[0] - p[0]) * (b[0] - a[0]) + (q[1] - p[1]) * (b[1] - a[1])) < 1e-6);

// --- Equal: the same length as the line before, when the pointer is within reach of it. ---
editor = open();
editor = click(editor, [0, 0]);
editor = click(editor, [20, 0.2]);
editor = move(editor, [34.1, 14.2]);
eq("a segment near the line before's length shows =", texts(editor), ["="]);
editor = click(editor, [34.1, 14.2]);
eq("the click keeps equal", kinds(sketchOf(editor)), ["horizontal", "equal"]);
const [s0, s1] = lineEnds(sketchOf(editor), 1);
check("and the new line is exactly as long as the one before", Math.abs(Math.hypot(s1[0] - s0[0], s1[1] - s0[1]) - 20) < 1e-6);
check("which the solver holds when the first line is lengthened", (() => {
  const firstLine = sketchOf(editor).entities.find((entity) => entity.kind === "line");
  const grown = dragSketch(sketchOf(editor), [firstLine?.kind === "line" ? firstLine.b : 0], [5, 0]);
  const first = lineEnds(grown, 0);
  const second = lineEnds(grown, 1);
  return Math.abs(Math.hypot(first[1][0] - first[0][0], first[1][1] - first[0][1]) - Math.hypot(second[1][0] - second[0][0], second[1][1] - second[0][1])) < 1e-6;
})());

// --- Ctrl skips it all: no snap to level, no rule, no mark. ---
editor = open();
editor = click(editor, [0, 0]);
editor = move(editor, [20.5, 0.25], { ctrl: true });
eq("with Ctrl held the mark goes", texts(editor), []);
editor = click(editor, [20.5, 0.25], { ctrl: true });
eq("a Ctrl-click keeps no rule", sketchOf(editor).dims ?? null, null);
eq("and does not move the point level", lineEnds(sketchOf(editor), 0)[1], [20.5, 0.25]);
editor = move(editor, [20.6, 30.5], { ctrl: true });
check("an upright line with Ctrl is not placed upright", Math.abs(editor.cursor![0] - 20.6) < 1e-9);

// --- A typed length and angle are the person's numbers: nothing is inferred from them. ---
editor = open();
editor = click(editor, [0, 0]);
editor = commitSizes(editor, [20, 0]);
eq("a typed line at 0 degrees keeps no rule", sketchOf(editor).dims ?? null, null);

// --- A square drawn with the Line tool keeps its sides level and upright, closing line included. ---
editor = open();
for (const at of [[0, 0], [20, 0.1], [20.1, 15], [0, 15.1]] as Pt[]) editor = click(editor, at);
editor = move(editor, [0.1, 0.1]);
check("the closing click shows the closing line's rule", texts(editor).includes("V"), texts(editor).join());
editor = click(editor, [0, 0]);
eq("a closed square holds H, V, H and V (the equal sides repeat nothing the level and upright sides do not set)", kinds(sketchOf(editor)).filter((kind) => kind === "horizontal" || kind === "vertical").length, 4);
check("and the solver finds no conflict", (constraintStatus(sketchOf(editor))?.conflicting.length ?? 1) === 0);

// --- A point put on a curve is kept there: the first point of a polyline and the end of a segment. ---
editor = open();
editor = click(editor, [0, 0]);
editor = click(editor, [20, 0.2]);
editor = sketchKey(editor, "Escape", { ctrl: false, meta: false, shift: false }) ?? editor;
editor = move(editor, [5, 0.15]);
eq("a first point on a line shows a dot", texts(editor), ["○"]);
editor = click(editor, [5, 0.15]);
const lines = sketchOf(editor).entities.length;
editor = click(editor, [5, 15.2]);
const kept = kinds(sketchOf(editor));
check("the click keeps vertical and the start on the line", kept.includes("vertical") && kept.includes("coincident"), kept.join());
eq("one new line", sketchOf(editor).entities.length, lines + 1);
check("the solver keeps the start on the line", (constraintStatus(sketchOf(editor))?.conflicting.length ?? 1) === 0);
editor = undoSketch(editor);
eq("one undo takes that line and its rules, and the start point with it", [sketchOf(editor).entities.length, kinds(sketchOf(editor))], [1, ["horizontal"]]);

// --- The end of a line on a circle is kept on it, and the solver holds it when the circle is resized by a dimension. ---
editor = open();
editor = withTool(editor, "circle");
editor = click(editor, [0, 0]);
editor = click(editor, [10, 0]);
editor = withTool(editor, "line");
editor = click(editor, [30, 5]);
editor = move(editor, [10.1, 0.1]);
eq("a point near a circle's rim shows the dot", texts(editor), ["○"]);
editor = click(editor, [10.1, 0.1]);
const rimEnd = sketchOf(editor).entities.find((entity) => entity.kind === "line");
const rimPoint = rimEnd?.kind === "line" ? sketchPoint(sketchOf(editor), rimEnd.b)!.at : [0, 0];
check("the end lands exactly on the rim", Math.abs(Math.hypot(rimPoint[0], rimPoint[1]) - 10) < 1e-6, JSON.stringify(rimPoint));
eq("and is kept there", kinds(sketchOf(editor)), ["coincident"]);
check("the solver finds nothing wrong", (constraintStatus(sketchOf(editor))?.conflicting.length ?? 1) === 0);

// --- A rule that fights what is already held, or repeats it, is left out. The line itself is still drawn. ---
const two = addLine(addLine(emptySketch(), [0, 0], [20, 0]).sketch, [0, 10], [30, 10]);
const sized: SketchData = { ...two.sketch, dims: [{ id: 1, kind: "length", line: 1, value: 20 }, { id: 2, kind: "length", line: two.id, value: 30 }] };
const fight = keepRules(sized, two.id, 4, [{ kind: "equal", line: 1 }]);
eq("an equal length that fights two different dimensions is not stored", (fight.dims ?? []).map((dim) => dim.kind), ["length", "length"]);
const twin = keepRules(sized, two.id, 4, [{ kind: "horizontal" }, { kind: "horizontal" }]);
eq("a rule stated twice is stored once", (twin.dims ?? []).filter((dim) => dim.kind === "horizontal").length, 1);

// --- A saved sketch reads back the same, and one saved before K1 has no new field. ---
const drawn = sketchOf((() => {
  let e = open();
  e = click(e, [0, 0]);
  e = click(e, [20, 0.2]);
  e = click(e, [20, 30.1]);
  return e;
})());
eq("a drawn sketch round-trips through its JSON", JSON.stringify(readSketch(JSON.parse(JSON.stringify(drawn)))), JSON.stringify(sketchJson(drawn)));
check("its constraints are the stored kinds the solver reads", (drawn.dims ?? []).every((dim) => ["horizontal", "vertical", "perpendicular", "equal", "coincident"].includes(String(dim.kind))));
const oldFile = JSON.stringify({ v: 1, plane: { origin: [0, 0, 0], turn: [0, 0, 0] }, points: [{ id: 1, at: [0, 0] }, { id: 2, at: [5, 0] }], entities: [{ id: 1, kind: "line", a: 1, b: 2 }] });
eq("a sketch saved before K1 reads back as it was", JSON.stringify(readSketch(JSON.parse(oldFile))), oldFile);

// --- The Constrain menu offers what fits the selection. ---
let hand = emptySketch();
const first = addLine(hand, [0, 0], [10, 3]);
hand = addCircle(first.sketch, [20, 20], 4).sketch;
const circleId = hand.entities.find((entity) => entity.kind === "circle")!.id;
eq("with nothing selected every rule is offered", fittingActions(hand, { entities: [], points: [] }, null), null);
const forLine = fittingActions(hand, { entities: [first.id], points: [] }, null) ?? [];
check("a line offers level, upright and a length", ["horizontal", "vertical", "length", "fixed"].every((name) => forLine.includes(name as never)), forLine.join());
check("and rules that take a second line, to wait for it", ["parallel", "perpendicular", "equal", "angle"].every((name) => forLine.includes(name as never)), forLine.join());
check("but not a radius", !forLine.includes("radius") && !forLine.includes("diameter") && !forLine.includes("concentric"), forLine.join());
const forCircle = fittingActions(hand, { entities: [circleId], points: [] }, null) ?? [];
check("a circle offers radius, diameter and concentric", ["radius", "diameter", "concentric", "fixed"].every((name) => forCircle.includes(name as never)), forCircle.join());
check("and not level, upright or a length", !forCircle.includes("horizontal") && !forCircle.includes("vertical") && !forCircle.includes("length"), forCircle.join());
const both = fittingActions(hand, { entities: [first.id, circleId], points: [] }, null) ?? [];
check("a line and a circle offer tangent, and not parallel", both.includes("tangent") && !both.includes("parallel"), both.join());
eq("a selected constraint offers only Remove", fittingActions(hand, { entities: [], points: [] }, 3), ["remove"]);
check("Remove shows when the selection has a constraint on it", (() => {
  let e = open();
  e = click(e, [0, 0]);
  e = click(e, [20, 0.2]);
  const line = sketchOf(e).entities[0]!.id;
  return (fittingActions(sketchOf(e), { entities: [line], points: [] }, null) ?? []).includes("remove") && !(fittingActions(hand, { entities: [first.id], points: [] }, null) ?? []).includes("remove");
})());
check("the editor reads its own selection", (() => {
  let e = open();
  e = click(e, [0, 0]);
  e = click(e, [20, 0.2], { ctrl: true });
  return constrainChoices(e) === null;
})());

if (failed) {
  console.error(`${failed} infer checks failed`);
  process.exit(1);
}
console.log("infer ok");
