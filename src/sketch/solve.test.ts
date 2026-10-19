/**
 * S4: the in-house solver. Convergence, degrees of freedom, redundant and conflicting
 * constraints, and a drag that keeps the constraints. A sketch with no constraint is not solved.
 */
import { arcFrom3 } from "./geom.ts";
import { originFrame, planeOf } from "./frame.ts";
import { addArc, addCircle, addLine, addPoint, emptySketch, sketchPoint, type SketchData } from "./model.ts";
import { applyConstrainAction, constraintGlyphs, drivingValue, plainDrivingValue, setDrivingEvaluator, withRectangleConstraints } from "./constrain.ts";
import {
  activeSketch,
  applyConstraint,
  beginChoose,
  commitDimensionText,
  editDimension,
  enterSketch,
  redoSketch,
  sketchKey,
  sketchOff,
  sketchPointer,
  undoSketch,
  withTool,
  type SketchEditor,
  type SketchEnv,
} from "./session.ts";
import { constraintStatus, dragSketch, parseConstraints, solveSketch } from "./solve.ts";

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
function near(name: string, got: number, want: number, tol = 1e-4) {
  if (Number.isFinite(got) && Math.abs(got - want) <= tol) return;
  failed += 1;
  console.error(`FAIL ${name}\n  got  ${got}\n  want ${want}`);
}

function line(a: [number, number], b: [number, number], sketch = emptySketch()): SketchData {
  return addLine(sketch, a, b).sketch;
}
function ends(sketch: SketchData, entity = 1): [[number, number], [number, number]] {
  const item = sketch.entities.find((entry) => entry.id === entity);
  if (item?.kind !== "line") throw new Error("not a line");
  return [sketchPoint(sketch, item.a)!.at, sketchPoint(sketch, item.b)!.at];
}
function lengthOf(sketch: SketchData, entity = 1): number {
  const [a, b] = ends(sketch, entity);
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

const free = line([0, 0], [3, 4]);
const dragged = dragSketch(free, [2], [1, 0]);
eq("a sketch with no constraint is translated exactly", sketchPoint(dragged, 2)?.at, [4, 4]);
eq("and the point that was not dragged stays", sketchPoint(dragged, 1)?.at, [0, 0]);
check("an unknown dimension does not start the solver", !parseConstraints({ ...free, dims: [{ id: 1, kind: "distance", value: "wall / 2" }] }).length);
const kept = dragSketch({ ...free, dims: [{ id: 1, kind: "distance", value: "wall / 2" }] }, [2], [0, 2]);
eq("that dimension is ignored and the drag stays exact", sketchPoint(kept, 2)?.at, [3, 6]);
eq("solving nothing reports that it did not run", solveSketch(free).ran, false);

const horizontal = applyConstrainAction(free, "horizontal", { entities: [1], points: [] }, null).sketch!;
const hy = ends(horizontal);
near("horizontal pulls the ends onto one height", hy[0][1], hy[1][1], 1e-6);
near("and leaves the run of the line", hy[1][0] - hy[0][0], 3, 1e-4);
const hStatus = constraintStatus(horizontal)!;
eq("one horizontal on a free line leaves three degrees of freedom", hStatus.dof, 3);
check("so the line is not fully defined", hStatus.fullyDefined === false && hStatus.conflicting.length === 0);

const again = applyConstrainAction(horizontal, "horizontal", { entities: [1], points: [] }, null);
eq("a second horizontal on the same line is not added, and says so", [again.sketch, again.hint ?? again.error], [undefined, "Those lines are already horizontal."]);

const sized = applyConstrainAction(line([0, 0], [3, 4]), "length", { entities: [1], points: [] }, null).sketch!;
const longer = applyConstrainAction(sized, "length", { entities: [1], points: [] }, null).sketch!;
const conflicted = applyConstrainAction(
  { ...longer, dims: longer.dims!.map((dim, index) => (index === 1 ? { ...dim, value: 20 } : dim)) },
  "horizontal",
  { entities: [], points: [] },
  null,
).sketch!;
// The horizontal above may not apply. Set the conflicting length directly and solve.
const clash = solveSketch({ ...sized, dims: [...(sized.dims ?? []), { id: 2, kind: "length", line: 1, value: 20 }] });
check("two lengths that disagree are a conflict", clash.conflicting.length >= 1 && clash.ok === false, JSON.stringify({ conflicting: clash.conflicting, ok: clash.ok, residual: clash.residual }));
void conflicted;

const pinned = addPoint(line([0, 0], [1, 0.2]), [0, 0], true).sketch;
// The added point is a new id. Fix the existing origin instead.
let anchored = line([0, 0], [4, 1]);
anchored = applyConstrainAction(anchored, "fixed", { entities: [], points: [1] }, null).sketch!;
anchored = applyConstrainAction(anchored, "horizontal", { entities: [1], points: [] }, null).sketch!;
anchored = applyConstrainAction(anchored, "length", { entities: [1], points: [] }, null).sketch!;
anchored = applyConstrainAction(anchored, "length", { entities: [1], points: [] }, null).sketch ?? anchored;
const driven = solveSketch({
  ...anchored,
  dims: anchored.dims!.map((dim) => (dim.kind === "length" ? { ...dim, value: 30 } : dim)),
});
const far = ends(driven.sketch);
near("a fixed end stays put", far[0][0], 0, 1e-6);
near("the fixed end's height stays", far[0][1], 0, 1e-6);
near("the free end meets the length", far[1][0], 30, 1e-3);
near("and the horizontal", far[1][1], 0, 1e-4);
check("that line is fully defined", driven.fullyDefined === true && driven.dof === 0, JSON.stringify(driven));
void pinned;

function rect(): SketchData {
  let sketch = emptySketch();
  const a = addPoint(sketch, [0, 0]);
  const b = addPoint(a.sketch, [10, 1]);
  const c = addPoint(b.sketch, [11, 6]);
  const d = addPoint(c.sketch, [1, 5]);
  sketch = d.sketch;
  sketch = addLine(sketch, a.id, b.id).sketch;
  sketch = addLine(sketch, b.id, c.id).sketch;
  sketch = addLine(sketch, c.id, d.id).sketch;
  sketch = addLine(sketch, d.id, a.id).sketch;
  return sketch;
}
let box = rect();
box = applyConstrainAction(box, "fixed", { entities: [], points: [1] }, null).sketch!;
box = applyConstrainAction(box, "horizontal", { entities: [1], points: [] }, null).sketch!;
box = applyConstrainAction(box, "vertical", { entities: [2], points: [] }, null).sketch!;
box = applyConstrainAction(box, "horizontal", { entities: [3], points: [] }, null).sketch!;
box = applyConstrainAction(box, "vertical", { entities: [4], points: [] }, null).sketch!;
box = applyConstrainAction(box, "length", { entities: [1], points: [] }, null).sketch!;
box = applyConstrainAction(box, "length", { entities: [4], points: [] }, null).sketch!;
const defined = solveSketch({
  ...box,
  dims: box.dims!.map((dim) => {
    if (dim.kind === "length" && dim.line === 1) return { ...dim, value: 20 };
    if (dim.kind === "length" && dim.line === 4) return { ...dim, value: 8 };
    return dim;
  }),
});
check("a rectangle with a fixed corner, directions and two sizes is fully defined", defined.fullyDefined && defined.dof === 0, JSON.stringify({ dof: defined.dof, conflicting: defined.conflicting, residual: defined.residual, redundant: defined.redundant }));
const corner = (id: number) => sketchPoint(defined.sketch, id)!.at;
near("the width is 20", corner(2)[0], 20, 1e-3);
near("the width stays on the axis", corner(2)[1], 0, 1e-3);
near("the height is 8", corner(4)[1], 8, 1e-3);
near("the far corner follows both", corner(3)[0], 20, 1e-3);
near("and its height", corner(3)[1], 8, 1e-3);

const slid = dragSketch(defined.sketch, [3], [5, -4]);
near("a fully defined corner does not drag", sketchPoint(slid, 3)!.at[0], 20, 1e-3);
near("nor in the other axis", sketchPoint(slid, 3)!.at[1], 8, 1e-3);

const loose = solveSketch(applyConstrainAction(line([0, 0], [10, 0.5]), "horizontal", { entities: [1], points: [] }, null).sketch!);
const moved = dragSketch(loose.sketch, [2], [0, 5]);
const my = ends(moved);
near("dragging one end of a horizontal line keeps it horizontal", my[0][1], my[1][1], 1e-3);
near("and the dragged end follows", my[1][1] - ends(loose.sketch)[1][1], 5, 0.05);

let pair = line([0, 0], [4, 1]);
pair = addLine(pair, [0, 2], [1, 5]).sketch;
pair = applyConstrainAction(pair, "perpendicular", { entities: [1, 2], points: [] }, null).sketch!;
{
  const [a0, a1] = ends(pair, 1);
  const [b0, b1] = ends(pair, 2);
  const dot = (a1[0] - a0[0]) * (b1[0] - b0[0]) + (a1[1] - a0[1]) * (b1[1] - b0[1]);
  const scale = Math.hypot(a1[0] - a0[0], a1[1] - a0[1]) * Math.hypot(b1[0] - b0[0], b1[1] - b0[1]);
  near("perpendicular lines have no dot product", dot / scale, 0, 1e-4);
}
pair = applyConstrainAction(line([0, 0], [4, 0]), "parallel", { entities: [], points: [] }, null).sketch ?? pair;
let parallel = line([0, 0], [4, 0.2]);
parallel = addLine(parallel, [0, 3], [2, 4]).sketch;
parallel = applyConstrainAction(parallel, "parallel", { entities: [1, 2], points: [] }, null).sketch!;
{
  const [a0, a1] = ends(parallel, 1);
  const [b0, b1] = ends(parallel, 2);
  const cross = (a1[0] - a0[0]) * (b1[1] - b0[1]) - (a1[1] - a0[1]) * (b1[0] - b0[0]);
  const scale = Math.hypot(a1[0] - a0[0], a1[1] - a0[1]) * Math.hypot(b1[0] - b0[0], b1[1] - b0[1]);
  near("parallel lines have no cross product", cross / scale, 0, 1e-4);
}

let equal = line([0, 0], [6, 0]);
equal = addLine(equal, [0, 2], [2, 3]).sketch;
equal = applyConstrainAction(equal, "equal", { entities: [1, 2], points: [] }, null).sketch!;
near("equal lines match in length", lengthOf(equal, 1), lengthOf(equal, 2), 1e-4);

let mid = line([0, 0], [10, 0]);
mid = addPoint(mid, [1, 4]).sketch;
mid = applyConstrainAction(mid, "fixed", { entities: [], points: [1, 2] }, null).sketch!;
mid = applyConstrainAction(mid, "midpoint", { entities: [1], points: [3] }, null).sketch!;
const midAt = sketchPoint(mid, 3)!.at;
near("a midpoint sits halfway in x", midAt[0], 5, 1e-4);
near("and halfway in y", midAt[1], 0, 1e-4);

let circles = addCircle(emptySketch(), [0, 0], 3).sketch;
circles = addCircle(circles, [4, 1], 1).sketch;
circles = applyConstrainAction(circles, "concentric", { entities: [1, 2], points: [] }, null).sketch!;
{
  const c0 = sketchPoint(circles, (circles.entities[0] as { centre: number }).centre)!.at;
  const c1 = sketchPoint(circles, (circles.entities[1] as { centre: number }).centre)!.at;
  near("concentric circles share a centre", Math.hypot(c0[0] - c1[0], c0[1] - c1[1]), 0, 1e-4);
}
circles = applyConstrainAction(circles, "equal", { entities: [1, 2], points: [] }, null).sketch!;
{
  const r0 = circles.entities[0]?.kind === "circle" ? circles.entities[0].radius : 0;
  const r1 = circles.entities[1]?.kind === "circle" ? circles.entities[1].radius : 0;
  near("equal circles share a radius", r0, r1, 1e-4);
}

let tangent = line([0, 0], [10, 0]);
tangent = applyConstrainAction(tangent, "fixed", { entities: [], points: [1, 2] }, null).sketch!;
tangent = addCircle(tangent, [5, 4], 1).sketch;
const circleId = tangent.entities.find((entity) => entity.kind === "circle")!.id;
tangent = applyConstrainAction(tangent, "tangent", { entities: [1, circleId], points: [] }, null).sketch!;
{
  const circle = tangent.entities.find((entity) => entity.kind === "circle");
  const centre = circle && circle.kind === "circle" ? sketchPoint(tangent, circle.centre)!.at : [0, 0];
  const radius = circle && circle.kind === "circle" ? circle.radius : 0;
  near("a circle tangent to a fixed line sits one radius off it", Math.abs(centre[1]), radius, 1e-3);
}

let angled = line([0, 0], [10, 0]);
angled = applyConstrainAction(angled, "fixed", { entities: [], points: [1, 2] }, null).sketch!;
angled = addLine(angled, 1, [3, 1]).sketch;
const angleLine = angled.entities.filter((entity) => entity.kind === "line").map((entity) => entity.id);
angled = applyConstrainAction(angled, "angle", { entities: angleLine, points: [] }, null).sketch!;
angled = solveSketch({ ...angled, dims: angled.dims!.map((dim) => (dim.kind === "angle" ? { ...dim, value: 90 } : dim)) }).sketch;
{
  const [b0, b1] = ends(angled, angleLine[1]!);
  const dot = 10 * (b1[0] - b0[0]) + 0 * (b1[1] - b0[1]);
  const scale = 10 * Math.hypot(b1[0] - b0[0], b1[1] - b0[1]);
  near("a driving angle of 90 leaves the lines perpendicular", dot / scale, 0, 1e-3);
}

let arc = addArc(emptySketch(), [0, 0], [10, 0], [5, 2]).sketch;
arc = applyConstrainAction(arc, "fixed", { entities: [], points: [1, 2] }, null).sketch!;
const beforeR = arcFrom3([0, 0], arc.entities[0]!.kind === "arc" ? arc.entities[0].through : [5, 2], [10, 0])!.radius;
arc = applyConstrainAction(arc, "radius", { entities: [1], points: [] }, null).sketch!;
const grownArc = solveSketch({ ...arc, dims: arc.dims!.map((dim) => (dim.kind === "radius" ? { ...dim, value: beforeR + 4 } : dim)) }).sketch;
const arcEntity = grownArc.entities[0];
const after = arcEntity?.kind === "arc" ? arcFrom3(sketchPoint(grownArc, arcEntity.a)!.at, arcEntity.through, sketchPoint(grownArc, arcEntity.b)!.at) : null;
near("a driving radius moves an arc", after?.radius ?? 0, beforeR + 4, 1e-2);

let diameter = addCircle(emptySketch(), [0, 0], 4).sketch;
diameter = applyConstrainAction(diameter, "diameter", { entities: [1], points: [] }, null).sketch!;
diameter = solveSketch({ ...diameter, dims: diameter.dims!.map((dim) => (dim.kind === "diameter" ? { ...dim, value: 10 } : dim)) }).sketch;
near("a driving diameter is twice the radius", diameter.entities[0]?.kind === "circle" ? diameter.entities[0].radius : 0, 5, 1e-4);

let gap = line([0, 0], [10, 0]);
gap = applyConstrainAction(gap, "fixed", { entities: [1], points: [] }, null).sketch!;
gap = addPoint(gap, [4, 2]).sketch;
gap = applyConstrainAction(gap, "distance", { entities: [1], points: [3] }, null).sketch!;
gap = solveSketch({ ...gap, dims: gap.dims!.map((dim) => (dim.kind === "distance" ? { ...dim, value: 7 } : dim)) }).sketch;
near("a point-to-line distance holds", sketchPoint(gap, 3)!.at[1], 7, 1e-3);

let joined = line([0, 0], [2, 0]);
joined = addLine(joined, [2.4, 0.2], [4, 1]).sketch;
const merged = applyConstrainAction(joined, "coincident", { entities: [], points: [2, 3] }, null).sketch!;
check("coincident keeps a single shared point", merged.points.length === 3, JSON.stringify(merged.points));
check("both lines name that point", merged.entities.every((entity) => entity.kind === "line" && (entity.a === 2 || entity.b === 2)));

eq("a plain number is a driving value", drivingValue("12.5"), 12.5);
eq("an expression is refused until parameters exist", plainDrivingValue("wall / 2"), null);
setDrivingEvaluator((text) => (text.trim() === "wall / 2" ? 4 : plainDrivingValue(text)));
eq("the hook can accept an expression later", drivingValue("wall / 2"), 4);
setDrivingEvaluator(plainDrivingValue);

const mods = { ctrl: false, meta: false, shift: false };
const env: SketchEnv = { mmPerPx: 0.25, project: (at) => ({ x: at[0], y: at[1] }) };
const click = (editor: SketchEditor, uv: [number, number]) => {
  let next = sketchPointer(editor, { phase: "down", uv, sx: uv[0], sy: uv[1], shift: false, ctrl: false, alt: false }, env);
  next = sketchPointer(next, { phase: "move", uv, sx: uv[0], sy: uv[1], shift: false, ctrl: false, alt: false }, env);
  return sketchPointer(next, { phase: "up", uv, sx: uv[0], sy: uv[1], shift: false, ctrl: false, alt: false }, env);
};
let editor = enterSketch(beginChoose(sketchOff()), planeOf(originFrame("XY")), { kind: "plane", name: "XY" });
editor = click(editor, [0, 0]);
editor = click(editor, [10, 4]);
editor = sketchKey(editor, "Escape", mods)!;
const drawn = ends(activeSketch(editor)!);
editor = withTool(editor, "select");
editor = click(editor, [(drawn[0][0] + drawn[1][0]) / 2, (drawn[0][1] + drawn[1][1]) / 2]);
check("the line is selected", editor.selection.entities.includes(1));
editor = applyConstraint(editor, "horizontal");
{
  const sketch = activeSketch(editor)!;
  const [a, b] = ends(sketch);
  near("the menu horizontal levels the line", a[1], b[1], 1e-4);
  check("and records one constraint", (sketch.dims?.length ?? 0) === 1);
}
editor = undoSketch(editor);
{
  const sketch = activeSketch(editor)!;
  eq("undo restores the line", ends(sketch), drawn);
  check("and drops the constraint", (sketch.dims?.length ?? 0) === 0);
  check("the line stays", sketch.entities.length === 1);
}
editor = redoSketch(editor);
{
  const sketch = activeSketch(editor)!;
  const [a, b] = ends(sketch);
  near("redo levels the line again", a[1], b[1], 1e-4);
}
editor = applyConstraint(editor, "length");
const held = lengthOf(activeSketch(editor)!);
const dimId = Number(activeSketch(editor)!.dims!.find((dim) => dim.kind === "length")!.id);
editor = commitDimensionText(editor, dimId, "40");
near("a typed length drives the line", lengthOf(activeSketch(editor)!), 40, 1e-3);
{
  const [a, b] = ends(activeSketch(editor)!);
  near("and the horizontal holds", a[1], b[1], 1e-3);
}
editor = undoSketch(editor);
near("undo restores the length from before the typed value", lengthOf(activeSketch(editor)!), held, 1e-3);
editor = redoSketch(editor);
near("redo puts the typed length back", lengthOf(activeSketch(editor)!), 40, 1e-3);
const typedId = Number(activeSketch(editor)!.dims!.find((dim) => dim.kind === "length")!.id);
editor = editDimension(editor, typedId);
editor = sketchKey(editor, "Delete", mods)!;
check("delete removes the driving dimension", !activeSketch(editor)!.dims!.some((dim) => dim.kind === "length"));
check("the horizontal remains", activeSketch(editor)!.dims!.some((dim) => dim.kind === "horizontal"));
editor = undoSketch(editor);
near("undo puts the dimension back", lengthOf(activeSketch(editor)!), 40, 1e-3);

// --- A16. Horizontal on every selected line, a point on a line or a circle, a rectangle that stays square, and marks.
{
  let two = line([0, 0], [10, 1]);
  two = addLine(two, [0, 5], [10, 7]).sketch;
  const both = applyConstrainAction(two, "horizontal", { entities: [1, 2], points: [] }, null).sketch!;
  near("the first selected line is made horizontal", ends(both, 1)[0][1], ends(both, 1)[1][1], 1e-6);
  near("and so is the second", ends(both, 2)[0][1], ends(both, 2)[1][1], 1e-6);
  eq("one horizontal each", parseConstraints(both).map((item) => item.kind), ["horizontal", "horizontal"]);

  let onLine = line([0, 0], [10, 0]);
  const loose = addPoint(onLine, [4, 3]);
  onLine = loose.sketch;
  const pinned = applyConstrainAction(onLine, "coincident", { entities: [1], points: [loose.id] }, null).sketch!;
  const onAt = sketchPoint(pinned, loose.id)!.at;
  const [pa, pb] = ends(pinned, 1);
  near("a point made coincident with a line lands on it", ((pb[0] - pa[0]) * (onAt[1] - pa[1]) - (pb[1] - pa[1]) * (onAt[0] - pa[0])) / Math.hypot(pb[0] - pa[0], pb[1] - pa[1]), 0, 1e-5);
  check("and is not merged into an end", pinned.points.length === 3);
  const slid = dragSketch(pinned, [loose.id], [3, 2]);
  const [la, lb] = ends(slid, 1);
  const moved = sketchPoint(slid, loose.id)!.at;
  const off = ((lb[0] - la[0]) * (moved[1] - la[1]) - (lb[1] - la[1]) * (moved[0] - la[0])) / Math.hypot(lb[0] - la[0], lb[1] - la[1]);
  near("dragged, it stays on the line", off, 0, 1e-5);
  check("and moves", Math.hypot(moved[0] - 4, moved[1]) > 0.5);

  const ring = addCircle(emptySketch(), [0, 0], 5);
  const near0 = addPoint(ring.sketch, [7, 1]);
  const onCircle = applyConstrainAction(near0.sketch, "coincident", { entities: [ring.id], points: [near0.id] }, null).sketch!;
  const at = sketchPoint(onCircle, near0.id)!.at;
  const centre = sketchPoint(onCircle, onCircle.entities[0]!.kind === "circle" ? onCircle.entities[0]!.centre : 0)!.at;
  const radius = onCircle.entities[0]!.kind === "circle" ? onCircle.entities[0]!.radius : 0;
  near("a point made coincident with a circle lands on it", Math.hypot(at[0] - centre[0], at[1] - centre[1]), radius, 1e-6);

  let box = emptySketch();
  const corners: [number, number][] = [[0, 0], [10, 0], [10, 6], [0, 6]];
  const ids: number[] = [];
  for (const corner of corners) {
    const added = addPoint(box, corner);
    box = added.sketch;
    ids.push(added.id);
  }
  const sides: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const added = addLine(box, ids[i]!, ids[(i + 1) % 4]!);
    box = added.sketch;
    sides.push(added.id);
  }
  const square = withRectangleConstraints(box, sides as [number, number, number, number]);
  eq("a rectangle carries horizontal and vertical sides", parseConstraints(square).map((item) => item.kind), ["horizontal", "vertical", "horizontal", "vertical"]);
  const pulled = dragSketch(square, [ids[2]!], [3, 2]);
  near("a dragged corner keeps the top level", sketchPoint(pulled, ids[3]!)!.at[1], sketchPoint(pulled, ids[2]!)!.at[1], 1e-6);
  near("and the side upright", sketchPoint(pulled, ids[1]!)!.at[0], sketchPoint(pulled, ids[2]!)!.at[0], 1e-6);

  const marks = constraintGlyphs(square);
  eq("each side shows its mark", marks.map((mark) => mark.text), ["H", "V", "H", "V"]);
  eq("at the side's middle", marks[0]!.at, [5, 0]);
  eq("a mark can be picked by the constraint it shows", marks.map((mark) => mark.id), parseConstraints(square).map((item) => item.id));
}

if (failed) {
  console.error(`solve: ${failed} failed`);
  process.exit(1);
}
console.log("solve: constraints ok");
