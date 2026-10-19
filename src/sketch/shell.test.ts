/**
 * The sketch editor shell: enter and leave, the plane camera, the grid, reference projection,
 * picking, and Line and Rectangle with typed sizes and undo.
 */
import { gridSpacing } from "../interact/snap.ts";
import { frameOf, lookAtFrame, mmPerPixel, originFrame, planeOf, planeWindow, rayOnPlane, rayOnQuad, SKETCH_ANIM_MS } from "./frame.ts";
import { gridLines } from "./grid.ts";
import { boxCrosses, boxPick, hitSketch } from "./hit.ts";
import { addLine, emptySketch, sketchPoint } from "./model.ts";
import { projectReferences } from "./refs.ts";
import {
  activeSketch,
  beginChoose,
  canUndoSketch,
  commitSizes,
  discardSketch,
  enterSketch,
  finishSketch,
  reopenSketch,
  sketchDimensions,
  sketchKey,
  sketchOff,
  sketchPointer,
  sketchReadout,
  undoSketch,
  withRefs,
  withTool,
  type SketchEditor,
  type SketchEnv,
} from "./session.ts";

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

const env: SketchEnv = { mmPerPx: 0.25, project: (at) => ({ x: at[0], y: at[1] }) };
const click = (editor: SketchEditor, uv: [number, number], extra: Partial<Parameters<typeof sketchPointer>[1]> = {}, scale = env) => {
  let next = sketchPointer(editor, { phase: "down", uv, sx: uv[0], sy: uv[1], shift: false, ctrl: false, alt: false, ...extra }, scale);
  next = sketchPointer(next, { phase: "move", uv, sx: uv[0], sy: uv[1], shift: false, ctrl: false, alt: false, ...extra }, scale);
  return sketchPointer(next, { phase: "up", uv, sx: uv[0], sy: uv[1], shift: false, ctrl: false, alt: false, ...extra }, scale);
};

const xy = originFrame("XY");
eq("XY is the ground, Z up", [xy.u, xy.v, xy.w], [[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
eq("XZ stands on X with Z across", [originFrame("XZ").v, originFrame("XZ").w], [[0, 0, 1], [0, -1, 0]]);
const yzBack = frameOf(planeOf(originFrame("YZ", [1, 2, 3])));
check("a frame round-trips through a sketch plane", yzBack.w.every((value, i) => Math.abs(value - originFrame("YZ").w[i]!) < 1e-9) && yzBack.origin.every((value, i) => value === [1, 2, 3][i]));
const looked = lookAtFrame(xy, [10, 4, 8], 20, 40);
check("the camera sits on the normal and looks at the plane", looked.position[2] > looked.target[2] && looked.target[0] === 10 && looked.target[1] === 4 && looked.target[2] === 0);
check("the turn onto the plane is a quarter of a second", SKETCH_ANIM_MS === 250);
const hit = rayOnPlane(xy, [3, 5, 12], [0, 0, -1]);
eq("a ray straight down meets XY", hit && [hit.uv, hit.t], [[3, 5], 12]);
check("a quad misses a hit outside itself", rayOnQuad(xy, [30, 0, 10], [0, 0, -1], 10) == null);
check("one pixel on a facing plane is the view height", Math.abs(mmPerPixel(100, 40, 100) - (2 * 100 * Math.tan((40 * Math.PI) / 360)) / 100) < 1e-9);
const window = planeWindow(xy, { position: [0, 0, 100], target: [0, 0, 0], up: [0, 1, 0], fovDeg: 40, aspect: 1 });
check("a top view's window is square about the target", Math.abs(window.maxU + window.minU) < 1e-6 && window.maxU > 10);

const spacing = gridSpacing(0.25);
const lines = gridLines(-20, 20, -10, 10, spacing);
check("the grid draws the origin and stays on the spacing", lines.some((line) => line.a[0] === 0 && line.b[0] === 0) && lines.every((line) => line.a[0] === line.b[0] || line.a[1] === line.b[1]));

const refs = projectReferences(
  xy,
  [
    { points: [0, 0, 0, 10, 0, 0] },
    { points: [0, 0, 5, 0, 0, -5] },
    { points: [0, 0, 5, 4, 0, 5] },
  ],
  [0, 0, 0, 2, 0, 0],
);
check("an edge on the plane and the face outline are reference", refs.segments.length >= 2);
check("a crossing edge marks the point it crosses", refs.vertices.some((at) => Math.hypot(at[0], at[1]) < 1e-6));
check(
  "an edge that misses the plane is left out",
  !refs.segments.some((segment) => Math.abs(segment.a[0]) < 1e-6 && Math.abs(segment.b[0] - 4) < 1e-6 && Math.abs(segment.a[1]) < 1e-6 && Math.abs(segment.b[1]) < 1e-6),
);

let editor = enterSketch(beginChoose(sketchOff()), planeOf(xy), { kind: "plane", name: "XY" });
eq("entering lands on the plane with the line tool", [editor.phase, editor.tool, activeSketch(editor)?.on], ["editing", "line", { kind: "plane", name: "XY" }]);
check("the readout names the line", sketchReadout(editor).startsWith("Line."));
editor = click(editor, [0, 0]);
editor = click(editor, [10, 0]);
const line = activeSketch(editor);
eq("two clicks are one line on shared points", [line?.entities.length, line?.points.length, line?.entities[0]], [1, 2, { id: 1, kind: "line", a: 1, b: 2 }]);
editor = click(editor, [10, 4]);
editor = click(editor, [0, 0]);
eq("clicking the start closes the polyline", activeSketch(editor)?.entities.length, 3);
check("the chain has ended", editor.chain == null);

editor = withTool(editor, "rectangle");
const fine = { mmPerPx: 0.05, project: env.project };
editor = click(editor, [0, 0], { ctrl: true }, fine);
editor = click(editor, [6, -4], {}, fine);
const rect = activeSketch(editor)!;
eq("Ctrl adds the rectangle's four lines", rect.entities.filter((entity) => entity.kind === "line").length, 7);
const xs = rect.points.map((point) => point.at[0]);
const ys = rect.points.map((point) => point.at[1]);
check("the centre rectangle reaches both ways", Math.min(...xs) <= -6 && Math.max(...xs) >= 6 && Math.min(...ys) <= -4 && Math.max(...ys) >= 4);

editor = withTool(sketchOff(), "line");
editor = enterSketch(editor, planeOf(xy));
editor = click(editor, [0, 0]);
const dims = sketchDimensions(editor);
check("a line in progress offers length and angle", dims?.fields.map((field) => field.id).join() === "length,angle");
editor = sketchPointer(editor, { phase: "move", uv: [10, 0], sx: 10, sy: 0, shift: false, ctrl: false, alt: false }, env);
editor = commitSizes(editor, [25, 90]);
const placed = sketchPoint(activeSketch(editor)!, 2)?.at;
check("typing length and angle places the point", !!placed && Math.abs(placed[0]) < 1e-6 && Math.abs(placed[1] - 25) < 1e-6, JSON.stringify(placed));

editor = withTool(editor, "rectangle");
editor = click(editor, [0, 0]);
editor = sketchPointer(editor, { phase: "move", uv: [4, -3], sx: 4, sy: -3, shift: false, ctrl: false, alt: false }, env);
editor = commitSizes(editor, [12, 5]);
const grown = activeSketch(editor)!;
const corner = grown.points.map((point) => point.at);
check("typing width and height builds the rectangle toward the pointer", corner.some((at) => Math.abs(at[0] - 12) < 1e-6 && Math.abs(at[1] + 5) < 1e-6), JSON.stringify(corner));
const beforeUndo = grown.entities.length;
editor = undoSketch(editor);
eq("undo drops the rectangle and keeps the line", [activeSketch(editor)?.entities.length, canUndoSketch(editor)], [beforeUndo - 4, true]);
check("redo is offered", sketchKey(editor, "y", { ctrl: true, meta: false, shift: false }) !== editor);

const moved = (() => {
  let next = withTool(enterSketch(sketchOff(), planeOf(xy)), "line");
  next = click(next, [0, 0]);
  next = click(next, [4, 0]);
  next = click(next, [4, 0], { double: true });
  next = withTool(next, "select");
  const point = activeSketch(next)!.points[1]!.id;
  next = sketchPointer(next, { phase: "down", uv: [4, 0], sx: 4, sy: 0, shift: false, ctrl: false, alt: false }, env);
  next = sketchPointer(next, { phase: "move", uv: [4, 3], sx: 4, sy: 30, shift: false, ctrl: false, alt: false }, env);
  next = sketchPointer(next, { phase: "up", uv: [4, 3], sx: 4, sy: 30, shift: false, ctrl: false, alt: false }, env);
  return { next, point };
})();
eq("dragging the shared end moves the line", sketchPoint(activeSketch(moved.next)!, moved.point)?.at, [4, 3]);
const undone = undoSketch(moved.next);
eq("undo puts the point back", sketchPoint(activeSketch(undone)!, moved.point)?.at, [4, 0]);

const boxSketch = addLine(addLine(emptySketch(), [0, 0], [2, 0]).sketch, [0, 0], [0, 2]).sketch;
const enclosed = boxPick(boxSketch, { x0: -1, y0: -1, x1: 3, y1: 1 }, false, (at) => ({ x: at[0], y: at[1] }));
eq("a left-to-right box keeps the line it encloses", enclosed.entities, [1]);
const crossing = boxPick(boxSketch, { x0: 3, y0: -1, x1: 1, y1: 1 }, boxCrosses(3, 1), (at) => ({ x: at[0], y: at[1] }));
eq("a right-to-left box also takes the line it crosses", crossing.entities, [1]);
eq("a click on the line hits that line", hitSketch(boxSketch, [1, 0.1], 0.2).entity, 1);

let leaving = enterSketch(sketchOff(), planeOf(xy));
leaving = click(leaving, [0, 0]);
leaving = click(leaving, [1, 0]);
leaving = sketchKey(leaving, "Escape", { ctrl: false, meta: false, shift: false })!;
check("the first Esc ends the line and asks again", leaving.chain == null && sketchReadout(leaving).includes("Esc again"));
leaving = sketchKey(leaving, "Escape", { ctrl: false, meta: false, shift: false })!;
eq("the second Esc pins the sketch", [leaving.phase, leaving.pinned.map((item) => item.name)], ["pinned", ["Sketch 1"]]);
const empty = finishSketch(enterSketch(sketchOff(), planeOf(xy)));
eq("a sketch with nothing in it is not kept", [empty.phase, empty.pinned.length], ["off", 0]);
const again = reopenSketch(leaving, leaving.pinned[0]!.id);
eq("the card opens the same entities", [again.phase, activeSketch(again)?.entities.length], ["editing", 1]);
const dropped = discardSketch(finishSketch(again), 1);
eq("discard drops the card", [dropped.phase, dropped.pinned.length], ["off", 0]);

const choosing = beginChoose(sketchOff());
eq("Esc leaves the chooser", sketchKey(choosing, "Escape", { ctrl: false, meta: false, shift: false })?.phase, "off");
check("choosing says what to click", sketchReadout(choosing).includes("origin plane"));

const referenced = withRefs(enterSketch(sketchOff(), planeOf(xy)), refs);
const snapped = sketchPointer(referenced, { phase: "move", uv: [0.1, 0], sx: 0, sy: 0, shift: false, ctrl: false, alt: false }, { mmPerPx: 0.05, project: env.project });
check("a reference vertex snaps", snapped.snap?.kind === "vertex" || snapped.snap?.kind === "endpoint" || snapped.snap?.kind === "edge-midpoint");

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("sketch shell ok");
