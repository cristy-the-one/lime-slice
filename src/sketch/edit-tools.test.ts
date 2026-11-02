/**
 * --- Sketch for people, milestone 6 (`docs/plan-sketch-for-people.md`, section 6): the Edit tools' new behaviour. ---
 * O1's corner rule against the three fixtures `geom2d::offset` shares (`crates/lime-recipe`, 7a), Offset makes walls,
 * T1's pieces, F1's corners, and C1 and U1 in the editor. The stored sketch is the same `SketchData` throughout.
 */
import { CORNER_CLASH, cornerLines, filletCorner, filletCorners, offset, offsetWall, trimPieceAt, trimPieces } from "./edit.ts";
import { addCircle, addLine, addPoint, emptySketch, readSketch, sketchJson, sketchPoint, type Pt, type SketchData } from "./model.ts";
import { loopSignedArea, sketchRegions, toLoops } from "./regions.ts";
import { endsWithAction } from "./reasons.ts";
import { sketchMesh } from "./draw.ts";
import { originFrame } from "./frame.ts";
import {
  activeSketch,
  commitSizes,
  enterSketchData,
  ghosts,
  previewSizes,
  sketchKey,
  sketchOff,
  sketchPointer,
  sketchReadout,
  trimHover,
  withRefs,
  withTool,
  withWall,
  type SketchEditor,
  type SketchEnv,
} from "./session.ts";
import { armOffset, DRAW_MENU, freshDraw, noCrossing, USE_MISSING } from "./tools.ts";

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}${detail === undefined ? "" : `\n  ${JSON.stringify(detail)}`}`);
}
const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;

/** A closed polygon of lines through `corners`, counter-clockwise as given. */
function polygon(corners: readonly Pt[]): { sketch: SketchData; lines: number[]; points: number[] } {
  let sketch = emptySketch();
  const points: number[] = [];
  for (const at of corners) {
    const added = addPoint(sketch, at);
    sketch = added.sketch;
    points.push(added.id);
  }
  const lines: number[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const line = addLine(sketch, points[i]!, points[(i + 1) % points.length]!);
    sketch = line.sketch;
    lines.push(line.id);
  }
  return { sketch, lines, points };
}

/** The area the new (offset) curves enclose: the region of a sketch holding only them. */
function newArea(before: SketchData, after: SketchData): number {
  const old = new Set(before.entities.map((entity) => entity.id));
  const only: SketchData = { ...after, entities: after.entities.filter((entity) => !old.has(entity.id)) };
  const regions = sketchRegions(only);
  let total = 0;
  for (const region of regions.slice(0, 1)) for (const loop of toLoops(region)) total += loopSignedArea(loop);
  return total;
}

/** Arcs among the new curves, with each arc's radius. */
function newArcs(before: SketchData, after: SketchData): number[] {
  const old = new Set(before.entities.map((entity) => entity.id));
  const out: number[] = [];
  for (const entity of after.entities) {
    if (old.has(entity.id) || entity.kind !== "arc") continue;
    const a = sketchPoint(after, entity.a)!.at;
    const b = sketchPoint(after, entity.b)!.at;
    // The circle through the two ends and the bulge.
    const [ax, ay] = a;
    const [bx, by] = b;
    const [cx, cy] = entity.through;
    const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
    const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
    out.push(Math.hypot(ax - ux, ay - uy));
  }
  return out.sort((p, q) => p - q);
}

// --- O1 corner rule: the three fixtures of `geom2d::offset` (crates/lime-recipe, offset_fixture_*). A counter-clockwise
// outline offsets to its left, inwards, so a negative distance grows it. ---
{
  // Outside corners: a 20 mm square grown by 2 has four arcs of radius 2, each centred on its original corner.
  const square = polygon([[10, 10], [30, 10], [30, 30], [10, 30]]);
  const grown = offset(square.sketch, square.lines, -2, "round");
  check("the grown square has no refusal", !grown.error, grown.error);
  const arcs = newArcs(square.sketch, grown.sketch);
  check("four outside corners, rounded with the distance", arcs.length === 4 && arcs.every((r) => near(r, 2)), arcs);
  check("its area is the fixture's", near(newArea(square.sketch, grown.sketch), 400 + 4 * 20 * 2 + Math.PI * 4, 1e-6), newArea(square.sketch, grown.sketch));
  const s = 2 / Math.SQRT2;
  const bulge = grown.sketch.entities.some((entity) => entity.kind === "arc" && near(entity.through[0], 30 + s) && near(entity.through[1], 30 + s));
  check("the corner at (30, 30) bulges to (31.414, 31.414): the arc is centred on the corner", bulge);
  const shrunk = offset(square.sketch, square.lines, 2, "round");
  check("shrunk, every corner is inside and stays sharp", newArcs(square.sketch, shrunk.sketch).length === 0);
  check("the shrunk square is 16 mm", near(newArea(square.sketch, shrunk.sketch), 256, 1e-6), newArea(square.sketch, shrunk.sketch));
  const sharp = offset(square.sketch, square.lines, -2);
  check("the strict offset still mitres", newArcs(square.sketch, sharp.sketch).length === 0 && near(newArea(square.sketch, sharp.sketch), 576, 1e-6));
}
{
  // Inside corner: an L grown by 1 keeps its inside corner sharp at (11, 11) and rounds the other five.
  const l = polygon([[0, 0], [20, 0], [20, 10], [10, 10], [10, 20], [0, 20]]);
  const grown = offset(l.sketch, l.lines, -1, "round");
  const arcs = newArcs(l.sketch, grown.sketch);
  check("five outside corners rounded, radius 1", arcs.length === 5 && arcs.every((r) => near(r, 1)), arcs);
  check("the inside corner is a sharp point at (11, 11)", grown.sketch.points.some((point) => near(point.at[0], 11) && near(point.at[1], 11)));
  check("the L's area is the fixture's", near(newArea(l.sketch, grown.sketch), 300 + 80 - 1 + 1.25 * Math.PI, 1e-6), newArea(l.sketch, grown.sketch));
  const shrunk = offset(l.sketch, l.lines, 1, "round");
  check("shrunk, the inside corner is the only one rounded", newArcs(l.sketch, shrunk.sketch).length === 1);
}
{
  // Short edge: a 1 mm step grown by 2 has 1 mm of edge at the corner above it, so that radius is reduced to 1.
  const step = polygon([[0, 0], [20, 0], [20, 10], [11, 10], [11, 11], [0, 11]]);
  const grown = offset(step.sketch, step.lines, -2, "round");
  check("the step grows with no refusal", !grown.error, grown.error);
  const arcs = newArcs(step.sketch, grown.sketch);
  check("four full corners and one reduced to 1 mm", arcs.length === 5 && near(arcs[0]!, 1) && arcs.slice(1).every((r) => near(r, 2)), arcs);
  check("and it grew", newArea(step.sketch, grown.sketch) > 20 * 10 + 11 * 1);
}

// --- O1: Offset makes walls. ---
{
  let sketch = emptySketch();
  const line = addLine(sketch, [0, 0], [30, 0]);
  sketch = line.sketch;
  const wall = offsetWall(sketch, [line.id], 1.5, { both: true, close: true, helper: true });
  check("a line, both sides and closed, is a wall", !wall.error, wall.error);
  const regions = sketchRegions(wall.sketch);
  check("one shape: 30 × 3", regions.length === 1 && near(toLoops(regions[0]!).reduce((sum, loop) => sum + loopSignedArea(loop), 0), 90, 1e-6), regions.length);
  check("the line itself is a helper line", wall.sketch.entities.find((entity) => entity.id === line.id)?.construction === true);
  check("four new solid lines", wall.sketch.entities.filter((entity) => !entity.construction).length === 4);
  const solidOriginal = offsetWall(sketch, [line.id], 1.5, { both: true, close: true, helper: false });
  check("kept solid, the line splits the wall in two halves", sketchRegions(solidOriginal.sketch).length === 2);
  const oneSide = offsetWall(sketch, [line.id], 2, { both: false, close: true, helper: true });
  const one = sketchRegions(oneSide.sketch);
  check("one side, closed: the line is the wall's other side and stays solid", one.length === 1 && oneSide.sketch.entities.every((entity) => !entity.construction));
  check("one side is 2 mm thick", near(Math.abs(toLoops(one[0]!).reduce((sum, loop) => sum + loopSignedArea(loop), 0)), 60, 1e-6));
  const open = offsetWall(sketch, [line.id], 2, { both: true, close: false, helper: false });
  check("both sides, open: two lines and no shape", open.sketch.entities.length === 3 && sketchRegions(open.sketch).length === 0);
  const plain = offsetWall(sketch, [line.id], 2, { both: false, close: false, helper: false });
  check("no options is a plain offset", plain.sketch.entities.length === 2);
}
{
  // An L route both sides, closed: one wall with a rounded outside corner and a sharp inside one.
  let sketch = emptySketch();
  const a = addPoint(sketch, [0, 0]);
  const b = addPoint(a.sketch, [20, 0]);
  const c = addPoint(b.sketch, [20, 15]);
  sketch = c.sketch;
  const first = addLine(sketch, a.id, b.id);
  const second = addLine(first.sketch, b.id, c.id);
  sketch = second.sketch;
  const wall = offsetWall(sketch, [first.id, second.id], 1, { both: true, close: true, helper: true });
  const regions = sketchRegions(wall.sketch);
  check("an L wall is one shape", !wall.error && regions.length === 1, wall.error);
  const arcs = newArcs(sketch, wall.sketch);
  check("its outside corner is rounded at 1 mm, its inside corner sharp", arcs.length === 1 && near(arcs[0]!, 1), arcs);
  const area = toLoops(regions[0]!).reduce((sum, loop) => sum + loopSignedArea(loop), 0);
  check("its area is the centre line's length times 2, less the rounded corner's", near(Math.abs(area), 35 * 2 - (1 - Math.PI / 4), 1e-6), area);
}
{
  // A closed rectangle both sides is a ring; Close the ends has nothing to close.
  const rect = polygon([[0, 0], [20, 0], [20, 10], [0, 10]]);
  const ring = offsetWall(rect.sketch, rect.lines, 1, { both: true, close: true, helper: true });
  const regions = sketchRegions(ring.sketch);
  check("a rectangle both sides is a ring: its largest shape has one hole", !ring.error && regions.some((region) => region.holes.length === 1 && near(region.area, 264 - (4 - Math.PI) - 144)), ring.error);
  const circle = addCircle(emptySketch(), [0, 0], 5);
  const tube = offsetWall(circle.sketch, [circle.id], 1, { both: true, close: true, helper: true });
  check("a circle both sides is a 4/6 ring", sketchRegions(tube.sketch).some((region) => region.holes.length === 1) && tube.sketch.entities.filter((entity) => entity.kind === "circle").length === 3);
}

// --- T1: Trim shows its pieces. ---
{
  // A horizontal bar crossed by two uprights: three pieces, the middle one cut at both ends.
  let sketch = emptySketch();
  const bar = addLine(sketch, [0, 0], [30, 0]);
  sketch = bar.sketch;
  sketch = addLine(sketch, [10, -5], [10, 5]).sketch;
  sketch = addLine(sketch, [20, -5], [20, 5]).sketch;
  const found = trimPieces(sketch, bar.id)!;
  check("the bar has three pieces", found.pieces.length === 3 && found.crossed, found.pieces.length);
  check("the middle piece runs 10 to 20, cut at both ends", near(found.pieces[1]!.samples[0]![0], 10) && near(found.pieces[1]!.samples.at(-1)![0], 20) && found.pieces[1]!.cut.every(Boolean));
  check("the outer pieces have a free end", !found.pieces[0]!.cut[0] && found.pieces[0]!.cut[1] && found.pieces[2]!.cut[0] && !found.pieces[2]!.cut[1]);
  check("the pointer at 15 is on the middle piece", trimPieceAt(sketch, bar.id, [15, 0.2]) === 1);
  const lone = addLine(emptySketch(), [0, 0], [5, 5]);
  const alone = trimPieces(lone.sketch, lone.id)!;
  check("a line nothing crosses is one piece, not crossed", alone.pieces.length === 1 && !alone.crossed);
  const circle = addCircle(emptySketch(), [0, 0], 5);
  const cut = addLine(circle.sketch, [-10, 0], [10, 0]);
  const round = trimPieces(cut.sketch, circle.id)!;
  check("a circle across a diameter is two pieces", round.pieces.length === 2 && round.crossed);
  const rect = polygon([[0, 0], [20, 0], [20, 10], [0, 10]]);
  const side = trimPieces(rect.sketch, rect.lines[0]!)!;
  check("a rectangle's side is one piece, touched only at its corners", side.pieces.length === 1 && !side.crossed && side.pieces[0]!.cut.every(Boolean));
}

// --- F1: Fillet the corner I click, and several corners at once. ---
{
  const rect = polygon([[0, 0], [20, 0], [20, 10], [0, 10]]);
  const corner = rect.points[2]!;
  const lines = cornerLines(rect.sketch, corner);
  check("a rectangle's corner names its two sides", !!lines && lines.includes(rect.lines[1]!) && lines.includes(rect.lines[2]!), lines);
  const byPoint = filletCorners(rect.sketch, [corner], 3);
  const byLines = filletCorner(rect.sketch, rect.lines[1]!, rect.lines[2]!, 3);
  check("a click on the corner stores what clicking both lines stores", JSON.stringify(byPoint.sketch) === JSON.stringify(byLines.sketch));
  const all = filletCorners(rect.sketch, rect.points, 2);
  check("four corners in one box, one radius", !all.error && all.sketch.entities.filter((entity) => entity.kind === "arc").length === 4, all.error);
  const tooBig = filletCorners(rect.sketch, rect.points, 6);
  check("a radius that doesn't fit every corner is refused whole", tooBig.error === CORNER_CLASH && tooBig.sketch === rect.sketch);
  check("the refusal says what to do", endsWithAction(CORNER_CLASH));
  let straight = emptySketch();
  const p = addPoint(straight, [0, 0]);
  const q = addPoint(p.sketch, [5, 0]);
  const r = addPoint(q.sketch, [10, 0]);
  straight = r.sketch;
  straight = addLine(addLine(straight, p.id, q.id).sketch, q.id, r.id).sketch;
  check("the middle of a straight run is no corner", cornerLines(straight, q.id) === null);
  const none = filletCorners(straight, [q.id], 1);
  check("and is refused with an action", !!none.error && endsWithAction(none.error!));
}

// --- Same stored data: every edit writes plain SketchData that reads back unchanged. ---
{
  const rect = polygon([[0, 0], [20, 0], [20, 10], [0, 10]]);
  for (const [name, sketch] of [
    ["offset", offset(rect.sketch, rect.lines, -2, "round").sketch],
    ["wall", offsetWall(rect.sketch, rect.lines, 1, { both: true, close: true, helper: true }).sketch],
    ["corners", filletCorners(rect.sketch, rect.points, 2).sketch],
  ] as const) {
    const back = readSketch(JSON.parse(JSON.stringify(sketchJson(sketch))));
    check(`${name} round-trips as a saved sketch`, !!back && JSON.stringify(back) === JSON.stringify(sketchJson(sketch)));
  }
}

// --- In the editor, with the pointer and the keys a person uses. ---
const env: SketchEnv = { mmPerPx: 0.05, project: (at) => ({ x: at[0] * 20, y: at[1] * 20 }) };
const NO_MODS = { ctrl: false, meta: false, shift: false };
const pointer = (editor: SketchEditor, phase: "down" | "move" | "up", uv: Pt) => sketchPointer(editor, { phase, uv, sx: uv[0] * 20, sy: uv[1] * 20, shift: false, ctrl: false, alt: false }, env);
const click = (editor: SketchEditor, uv: Pt) => pointer(pointer(pointer(editor, "down", uv), "move", uv), "up", uv);
const drawn = (sketch: SketchData, tool: SketchEditor["tool"]) => withTool(enterSketchData(sketchOff(), sketch), tool);
{
  // T1: the piece under the pointer is the red one, and a line nothing crosses says so before and on the click.
  let sketch = emptySketch();
  const bar = addLine(sketch, [0, 0], [30, 0]);
  sketch = addLine(addLine(bar.sketch, [10, -5], [10, 5]).sketch, [20, -5], [20, 5]).sketch;
  sketch = addLine(sketch, [0, 20], [10, 20]).sketch;
  let editor = pointer(drawn(sketch, "trim"), "move", [15, 0.1]);
  const hot = trimHover(editor);
  check("Trim marks the middle piece under the pointer", hot?.entity === bar.id && hot.piece === 1 && hot.crossed, hot);
  const mesh = sketchMesh(editor, originFrame("XY"), [], [], 0.05);
  check("the view draws every piece, the hot one red", mesh.shown?.trimPieces === 3 + 2 + 2 + 1 && mesh.shown.trimHot === `${bar.id}:1` && mesh.strokes.some((stroke) => stroke.role === "refuse"), mesh.shown);
  editor = pointer(editor, "move", [5, 20.1]);
  check("over a lone line the status line says nothing crosses it", sketchReadout(editor).includes("Nothing crosses this line") && endsWithAction(noCrossing("line")));
  const before = activeSketch(editor)!;
  editor = click(editor, [5, 20.1]);
  check("a click on it removes nothing and picks it, so Delete removes it", activeSketch(editor)!.entities.length === before.entities.length && editor.selection.entities.length === 1);
  editor = sketchKey(editor, "Delete", NO_MODS)!;
  check("Delete then removes it", activeSketch(editor)!.entities.length === before.entities.length - 1);
  editor = click(editor, [15, 0.1]);
  check("a click on the middle piece trims it", activeSketch(editor)!.entities.filter((entity) => entity.kind === "line").length === before.entities.length);
}
{
  // F1: a click on the corner, a box around corners, and G on corners picked with Select.
  const rect = polygon([[0, 0], [20, 0], [20, 10], [0, 10]]);
  let editor = click(drawn(rect.sketch, "fillet"), [20, 10]);
  check("a click on a corner arms its two lines", editor.draw.gesture?.kind === "filletReady");
  editor = commitSizes(editor, [3]);
  const one = activeSketch(editor)!;
  check("typing 3 rounds that corner, as two line clicks would", JSON.stringify(one) === JSON.stringify(filletCorner(rect.sketch, rect.lines[1]!, rect.lines[2]!, 3).sketch));
  editor = drawn(rect.sketch, "fillet");
  editor = pointer(editor, "down", [-2, -2]);
  editor = pointer(editor, "move", [22, 12]);
  check("a drag on empty space draws a box", editor.box != null);
  editor = pointer(editor, "up", [22, 12]);
  check("the box arms all four corners", editor.draw.gesture?.kind === "filletMany" && editor.draw.gesture.corners.length === 4, editor.draw.gesture);
  check("their ghost is four arcs", (ghosts(previewSizes(editor, [2]))?.length ?? 0) === 4);
  editor = commitSizes(editor, [2]);
  check("one radius rounds the four, as one undo step", activeSketch(editor)!.entities.filter((entity) => entity.kind === "arc").length === 4 && editor.undo.length === 1);
  let picked = withTool(enterSketchData(sketchOff(), rect.sketch), "select");
  picked = { ...picked, selection: { entities: [], points: [rect.points[0]!, rect.points[1]!] } };
  picked = sketchKey(picked, "g", NO_MODS)!;
  check("G on two selected corners arms both", picked.tool === "fillet" && picked.draw.gesture?.kind === "filletMany" && picked.draw.gesture.corners.length === 2);
}
{
  // C1: Shift+X draws helper lines; X still toggles; the labels are renamed and the key, tool id and field are not.
  let editor = sketchKey(enterSketchData(sketchOff(), emptySketch()), "X", { ...NO_MODS, shift: true })!;
  check("Shift+X is the Line tool drawing helper lines", editor.tool === "line" && editor.helperLine && sketchReadout(editor).startsWith("Helper line."));
  editor = click(click(editor, [0, 0]), [10, 0]);
  check("the line drawn is a helper line", activeSketch(editor)!.entities.every((entity) => entity.construction === true) && activeSketch(editor)!.entities.length === 1);
  editor = sketchKey(editor, "l", NO_MODS)!;
  check("L is the plain Line tool again", !editor.helperLine);
  check("the menu says Helper line and Copy edge, with the same tools and keys", DRAW_MENU.some((item) => item.tool === "construction" && item.label === "Helper line" && item.shortcut === "X") && DRAW_MENU.some((item) => item.tool === "use" && item.label === "Copy edge" && item.shortcut === "U"));
}
{
  // U1: a click inside the face copies its whole outline, holes too; the edge under the pointer brightens.
  type P = [number, number];
  const loop = (points: P[]) => points.map((a, i) => ({ a, b: points[(i + 1) % points.length]!, source: "outline" as const }));
  const refs = { segments: [...loop([[0, 0], [30, 0], [30, 20], [0, 20]]), ...loop([[10, 5], [10, 15], [20, 15], [20, 5]])], vertices: [] };
  let editor = withRefs(drawn(emptySketch(), "use"), refs);
  editor = pointer(editor, "move", [5, 10]);
  check("inside the face, the whole outline brightens", editor.hoverRef.face && sketchMesh(editor, originFrame("XY"), [], []).shown?.refHot === 8);
  editor = pointer(editor, "move", [15, 10]);
  check("in the hole, nothing is the face", !editor.hoverRef.face && editor.hoverRef.index == null);
  editor = pointer(editor, "move", [15, 0.1]);
  check("on an edge, its loop brightens", editor.hoverRef.index != null && sketchMesh(editor, originFrame("XY"), [], []).shown?.refHot === 4);
  editor = click(editor, [5, 10]);
  check("a click inside the face copies all eight sides", activeSketch(editor)!.entities.length === 8 && sketchRegions(activeSketch(editor)!).some((region) => region.holes.length === 1));
  const outside = click(withRefs(drawn(emptySketch(), "use"), refs), [40, 40]);
  check("a click off the face says what to click", outside.draw.note === USE_MISSING && endsWithAction(USE_MISSING));
}
{
  // O1 in the editor: the options are remembered, the ghost shows both sides, and Enter makes the wall in one step.
  let sketch = emptySketch();
  const line = addLine(sketch, [0, 0], [30, 0]);
  sketch = line.sketch;
  let editor = drawn(sketch, "offset");
  editor = withWall(withWall(editor, "both"), "close");
  check("Close the ends brings Keep the line as a helper with it", editor.draw.wall.both && editor.draw.wall.close && editor.draw.wall.helper);
  editor = click(editor, [15, 0]);
  editor = previewSizes(editor, [1.5]);
  check("the ghost is the wall's four sides", ghosts(editor)?.length === 4);
  editor = commitSizes(editor, [1.5]);
  const wall = activeSketch(editor)!;
  check("Enter makes a 30 × 3 wall around a helper line", sketchRegions(wall).length === 1 && wall.entities.find((entity) => entity.id === line.id)?.construction === true && editor.undo.length === 1);
  editor = withTool(editor, "line");
  editor = withTool(editor, "offset");
  check("the options stay on for the next offset", editor.draw.wall.both && editor.draw.wall.close);
  const armed = armOffset(sketch, freshDraw(), [line.id], [15, 5]);
  check("the demo's line can be armed for a typed distance", armed.gesture?.kind === "offset");
}

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("edit tools ok");
