/**
 * The sketch editor's own state: names, undo, Esc, selection, typed sizes, and dimensions through edits.
 */
import { addLine, emptySketch, sketchPoint, type Pt, type SketchData } from "./model.ts";
import { ADD_CONFLICT, VALUE_CONFLICT, applyConstrainAction } from "./constrain.ts";
import { constraintStatus } from "./solve.ts";
import {
  SIZE_REFUSAL,
  activeSketch,
  applyConstraint,
  beginChoose,
  blurDimensionText,
  commitDimensionText,
  commitSizes,
  editDimension,
  enterSketch,
  enterSketchData,
  finishSketch,
  redoSketch,
  reopenSketch,
  sketchKey,
  sketchOff,
  sketchPointer,
  undoSketch,
  withTool,
  type SketchEditor,
  type SketchEnv,
  type SketchPointer,
  type SketchTool,
} from "./session.ts";

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const left = JSON.stringify(got);
  const right = JSON.stringify(want);
  if (left === right) return;
  failed += 1;
  console.error(`FAIL ${name}\n  got  ${left}\n  want ${right}`);
}

/** 4 pixels per mm, the plane's origin at pixel (0, 0), V up the screen. A hit reaches 2 mm. */
const env: SketchEnv = { mmPerPx: 0.25, project: (at: Pt) => ({ x: at[0] * 4, y: -at[1] * 4 }) };
const plain = { ctrl: false, meta: false, shift: false };

function pointer(phase: SketchPointer["phase"], uv: Pt, extra: Partial<SketchPointer> = {}): SketchPointer {
  return { phase, uv, sx: uv[0] * 4, sy: -uv[1] * 4, shift: false, ctrl: false, alt: false, ...extra };
}

function click(editor: SketchEditor, at: Pt, extra: Partial<SketchPointer> = {}): SketchEditor {
  let next = sketchPointer(editor, pointer("down", at, extra), env);
  next = sketchPointer(next, pointer("up", at, extra), env);
  return next;
}

/** Press at `from`, move to `to` in four steps, release there. */
function drag(editor: SketchEditor, from: Pt, to: Pt, extra: Partial<SketchPointer> = {}): SketchEditor {
  let next = sketchPointer(editor, pointer("down", from, extra), env);
  for (let step = 1; step <= 4; step += 1) {
    const at: Pt = [from[0] + ((to[0] - from[0]) * step) / 4, from[1] + ((to[1] - from[1]) * step) / 4];
    next = sketchPointer(next, pointer("move", at, extra), env);
  }
  return sketchPointer(next, pointer("up", to, extra), env);
}

function key(editor: SketchEditor, name: string): SketchEditor {
  return sketchKey(editor, name, plain) ?? editor;
}

function open(): SketchEditor {
  return enterSketch(beginChoose(sketchOff()), { origin: [0, 0, 0], turn: [0, 0, 0] });
}

function drawn(): SketchEditor {
  return key(click(click(open(), [0, 0]), [20, 0]), "Escape");
}

function names(editor: SketchEditor): string[] {
  return editor.pinned.map((item) => item.name);
}

function sketchOf(editor: SketchEditor): SketchData {
  return activeSketch(editor) ?? emptySketch();
}

function kinds(editor: SketchEditor): string[] {
  return sketchOf(editor).entities.map((entity) => entity.kind);
}

function dimKinds(editor: SketchEditor): string[] {
  return (sketchOf(editor).dims ?? []).map((dim) => String(dim.kind));
}

function rectangle(): SketchData {
  let sketch = addLine(emptySketch(), [0, 0], [20, 0]).sketch;
  sketch = addLine(sketch, 2, [20, 10]).sketch;
  sketch = addLine(sketch, 3, [0, 10]).sketch;
  sketch = addLine(sketch, 4, 1).sketch;
  return sketch;
}

function editing(sketch: SketchData, tool: SketchTool = "select"): SketchEditor {
  return withTool(enterSketchData(sketchOff(), sketch), tool);
}

// --- A15. A reopened sketch keeps its name. ---
{
  const first = finishSketch(drawn());
  eq("a finished sketch is Sketch 1", names(first), ["Sketch 1"]);
  const reopened = reopenSketch(first, first.pinned[0]!.id);
  eq("reopening it keeps the card", reopened.phase, "editing");
  const again = finishSketch(reopened);
  eq("finishing it again keeps its name", names(again), ["Sketch 1"]);
  const second = finishSketch(click(click(enterSketch(beginChoose(again), { origin: [0, 0, 0], turn: [0, 0, 0] }), [0, 5]), [9, 5]));
  eq("the next new sketch is Sketch 2", names(second), ["Sketch 1", "Sketch 2"]);
  eq("each card has its own id", new Set(second.pinned.map((item) => item.id)).size, 2);
}

// --- A3. Trim and Fillet corner carry the dimensions, so the sketch does not lock. ---
{
  let crossed = addLine(emptySketch(), [0, 0], [20, 0]).sketch;
  crossed = addLine(crossed, [10, -5], [10, 5]).sketch;
  crossed = { ...crossed, dims: [{ id: 1, kind: "length", line: 1, value: 20 }, { id: 2, kind: "vertical", line: 2 }] };
  const trimmed = click(editing(crossed, "trim"), [15, 0]);
  eq("the trim removed the right piece", kinds(trimmed), ["line", "line"]);
  eq("the length on the trimmed line goes; the other line's constraint stays", dimKinds(trimmed), ["vertical"]);
  eq("nothing conflicts after the trim", constraintStatus(sketchOf(trimmed))?.conflicting ?? [], []);

  const boxed = { ...rectangle(), dims: [{ id: 1, kind: "horizontal", line: 1 }, { id: 2, kind: "vertical", line: 2 }, { id: 3, kind: "length", line: 1, value: 20 }, { id: 4, kind: "length", line: 2, value: 10 }, { id: 5, kind: "length", line: 3, value: 20 }] };
  let filleting = click(editing(boxed, "fillet"), [10, 0]);
  filleting = click(filleting, [20, 5]);
  const filleted = commitSizes(filleting, [2]);
  eq("the fillet adds its arc", kinds(filleted), ["line", "line", "line", "line", "arc"]);
  eq("the lines it shortened keep their direction but not their length", dimKinds(filleted), ["horizontal", "vertical", "length"]);
  eq("nothing conflicts after the fillet", constraintStatus(sketchOf(filleted))?.conflicting ?? [], []);
  // A point on the far line still drags: the sketch is not locked.
  const corner = sketchOf(filleted).points.find((point) => point.at[0] === 0 && point.at[1] === 10)!;
  const moved = drag(withTool(filleted, "select"), [0, 10], [-3, 10]);
  eq("a corner still drags", sketchPoint(sketchOf(moved), corner.id)?.at[0] !== 0, true);

  // Remove constraint with nothing selected clears the ones that cannot be met.
  const stuck = { ...rectangle(), dims: [{ id: 1, kind: "length", line: 1, value: 20 }, { id: 2, kind: "length", line: 99, value: 5 }] };
  const freed = applyConstrainAction(stuck, "remove", { entities: [], points: [] }, null);
  eq("an unresolved constraint is removed with nothing selected", freed.sketch?.dims?.map((dim) => dim.id), [1]);
}

// --- A4. Esc during a drag puts the drag back. ---
{
  const start = editing(rectangle());
  const before = sketchOf(start).points.map((point) => point.at);
  let moving = sketchPointer(start, pointer("down", [20, 10]), env);
  moving = sketchPointer(moving, pointer("move", [26, 14]), env);
  moving = sketchPointer(moving, pointer("move", [30, 20]), env);
  eq("the drag moved the corner", sketchPoint(sketchOf(moving), 3)?.at, [30, 20]);
  const escaped = key(moving, "Escape");
  eq("Esc puts every point back", sketchOf(escaped).points.map((point) => point.at), before);
  eq("and no undo step was made", escaped.undo.length, 0);
  eq("the release after Esc moves nothing", sketchOf(sketchPointer(escaped, pointer("up", [30, 20]), env)).points.map((point) => point.at), before);
}

// --- A8. Undo after ending a line does not restart the line. ---
{
  let line = click(click(click(open(), [0, 0]), [10, 0]), [10, 10]);
  line = key(line, "Escape");
  eq("two segments", kinds(line), ["line", "line"]);
  const undone = undoSketch(line);
  eq("undo drops the last segment", kinds(undone), ["line"]);
  eq("and the line does not start again", undone.chain, null);
  eq("so there is no size box", undone.typed, null);
  const redone = redoSketch(undone);
  eq("redo puts it back, still not drawing", { kinds: kinds(redone), chain: redone.chain }, { kinds: ["line", "line"], chain: null });
}

// --- A10. A driving value the constraints cannot meet is refused, and the old value stays. ---
{
  const pinned = { ...rectangle(), points: rectangle().points.map((point) => ({ ...point, fixed: true as const })), dims: [{ id: 1, kind: "length", line: 1, value: 20 }] };
  const editor = editDimension(editing(pinned), 1);
  const refused = commitDimensionText(editor, 1, "30");
  eq("the conflicting value is refused in a sentence", refused.constrain.note, VALUE_CONFLICT);
  eq("the stored value is the old one", sketchOf(refused).dims?.[0]?.value, 20);
  const added = applyConstrainAction(pinned, "vertical", { entities: [1], points: [] }, null);
  eq("a constraint that cannot be met is not added", added.error, ADD_CONFLICT);
  eq("and the sketch is unchanged", added.sketch, undefined);
}

// --- A9. A dimension label that loses focus sets what was typed. ---
{
  const sized = { ...rectangle(), dims: [{ id: 1, kind: "length", line: 1, value: 20 }] };
  const editor = editDimension(editing(sized), 1);
  const left = blurDimensionText(editor, 1, "24");
  eq("blur sets the typed length", sketchOf(left).dims?.[0]?.value, 24);
  const ends = [sketchPoint(sketchOf(left), 1)!.at, sketchPoint(sketchOf(left), 2)!.at];
  eq("and the line follows", Math.round(Math.hypot(ends[1][0] - ends[0][0], ends[1][1] - ends[0][1]) * 1000) / 1000, 24);
  eq("an empty label only closes", sketchOf(blurDimensionText(editor, 1, " ")).dims?.[0]?.value, 20);
}

// --- A13. Esc clears the selection before it arms finishing. ---
{
  const picked = click(editing(rectangle()), [10, 0]);
  eq("a click selects the line", picked.selection.entities.length, 1);
  const first = key(picked, "Escape");
  eq("the first Esc clears the selection", { selection: first.selection.entities.length, phase: first.phase, esc: first.esc }, { selection: 0, phase: "editing", esc: 0 });
  const second = key(first, "Escape");
  eq("the second arms finishing", { phase: second.phase, esc: second.esc }, { phase: "editing", esc: 1 });
  eq("the third finishes", key(second, "Escape").phase, "pinned");
}

// --- A14. Press, drag, release draws from the press to the release. ---
{
  const line = drag(open(), [0, 0], [15, 5]);
  eq("a dragged line is one segment from press to release", sketchOf(line).points.map((point) => point.at), [[0, 0], [15, 5]]);
  const circle = drag(withTool(open(), "circle"), [0, 0], [6, 0]);
  eq("a dragged circle is centred on the press", sketchOf(circle).entities.map((entity) => (entity.kind === "circle" ? Math.round(entity.radius) : -1)), [6]);
  const small = drag(open(), [0, 0], [0.5, 0.25]);
  eq("a press that hardly moved is still one click", sketchOf(small).entities.length, 0);
}

// --- A17. Shift and a box add to the selection. ---
{
  let picked = click(editing(rectangle()), [10, 0]);
  picked = drag(picked, [5, 15], [-5, 5], { shift: true });
  eq("a crossing box with Shift adds the left and top lines to the bottom one", [...picked.selection.entities].sort(), [1, 3, 4]);
}

// --- A18. One rule for typed sizes. ---
{
  const started = click(withTool(open(), "rectangle"), [0, 0]);
  const flat = commitSizes(started, [10, 0]);
  eq("a zero height is refused in a sentence", { entities: kinds(flat).length, note: flat.draw.note }, { entities: 0, note: SIZE_REFUSAL });
  const negative = commitSizes(started, [-10, 4]);
  eq("a negative width is refused the same way", { entities: kinds(negative).length, note: negative.draw.note }, { entities: 0, note: SIZE_REFUSAL });
  const line = commitSizes(click(open(), [0, 0]), [0, 30]);
  eq("a zero length is refused", line.draw.note, SIZE_REFUSAL);
  const circle = commitSizes(click(withTool(open(), "circle"), [0, 0]), [-4]);
  eq("a negative diameter is refused", { entities: kinds(circle).length, note: circle.draw.note }, { entities: 0, note: SIZE_REFUSAL });
}

// --- A22. A History Edit starts with no stale constraint state. ---
{
  const sized = { ...rectangle(), dims: [{ id: 1, kind: "length", line: 1, value: 20 }] };
  const before = applyConstraint(editDimension(editing(sized), 1), "length");
  const reopened = enterSketchData(before, rectangle());
  eq("the edit opens with no picks and no label open", { picks: reopened.constrain.picks.length, hud: reopened.constrain.hud, selected: reopened.constrain.selected }, { picks: 0, hud: null, selected: null });
}

if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("session tests passed");
