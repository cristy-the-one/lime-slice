/**
 * The sketch editor's own state: names, undo, Esc, selection, and typed sizes.
 */
import type { Pt } from "./model.ts";
import {
  beginChoose,
  enterSketch,
  finishSketch,
  reopenSketch,
  sketchKey,
  sketchOff,
  sketchPointer,
  type SketchEditor,
  type SketchEnv,
  type SketchPointer,
} from "./session.ts";

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const left = JSON.stringify(got);
  const right = JSON.stringify(want);
  if (left === right) return;
  failed += 1;
  console.error(`FAIL ${name}\n  got  ${left}\n  want ${right}`);
}

/** 1 mm per pixel, the plane's origin at pixel (0, 0), V up the screen. */
const env: SketchEnv = { mmPerPx: 1, project: (at: Pt) => ({ x: at[0], y: -at[1] }) };

function pointer(phase: SketchPointer["phase"], uv: Pt, extra: Partial<SketchPointer> = {}): SketchPointer {
  return { phase, uv, sx: uv[0], sy: -uv[1], shift: false, ctrl: false, alt: false, ...extra };
}

function click(editor: SketchEditor, at: Pt): SketchEditor {
  let next = sketchPointer(editor, pointer("down", at), env);
  next = sketchPointer(next, pointer("up", at), env);
  return next;
}

function drawn(): SketchEditor {
  const open = enterSketch(beginChoose(sketchOff()), { origin: [0, 0, 0], turn: [0, 0, 0] });
  let next = click(open, [0, 0]);
  next = click(next, [20, 0]);
  return sketchKey(next, "Escape", { ctrl: false, meta: false, shift: false }) ?? next;
}

function names(editor: SketchEditor): string[] {
  return editor.pinned.map((item) => item.name);
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

if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("session tests passed");
