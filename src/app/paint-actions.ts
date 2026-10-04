/** Support paint against the live session: brush strokes, clear, the drawn disks, and the reply's tally. */
import { fx } from "./fx";
import { session, state, type SliceResponse } from "./state";
import { beginEdit, flushEdit } from "./history";
import { syncPlateFromState } from "./plate-sync";
import { touch } from "./settings";
import { sourceFrame } from "../plate";
import { markProjectDirty } from "../project-dirty";
import { addDisk, diskFromHit, inMeshFrame, MAX_PAINT_DISKS, strokeTakes, tallyText, type PaintDisk, type PaintKind, type PaintTally } from "../support-paint";
import type { BrushHooks } from "../prepare-view";
import { pushToast } from "../ui/toasts";

/** Draw the selected object's paint on the prepare mesh and repaint the brush bar. */
export function drawPaint() {
  const source = state.sourcePos;
  const frame = source ? sourceFrame(source, state.partScale) : null;
  fx.prepare?.setPaint(frame ? state.supportPaint.map((d) => inMeshFrame(d, frame)) : []);
  session.paintUi?.refresh();
}

/** After paint changed: keep it on the plate and slice, as a support edit does. */
function painted() {
  syncPlateFromState();
  markProjectDirty();
  drawPaint();
  if (state.result) void fx.runSlice(false);
  else touch();
}

/** One drag of the brush: one undo step, then one slice. */
export function paintStroke(kind: PaintKind, radius: number): BrushHooks {
  const before = state.supportPaint;
  let last: PaintDisk | undefined;
  let warned = false;
  return {
    start: () => beginEdit(),
    hit(point, normal) {
      const placed = state.placed;
      if (!placed || !state.sourcePos) return;
      const disk = diskFromHit(kind, point, normal, radius, placed.pose, sourceFrame(state.sourcePos, state.partScale));
      if (!strokeTakes(last, disk)) return;
      const next = addDisk(state.supportPaint, disk);
      if (next === state.supportPaint) {
        if (!warned) pushToast(`One object holds at most ${MAX_PAINT_DISKS} paint disks. Clear some paint to add more.`, "warn");
        warned = true;
        return;
      }
      state.supportPaint = next;
      last = disk;
      drawPaint();
    },
    end() {
      flushEdit();
      if (state.supportPaint !== before) painted();
    },
    cancel() {
      state.supportPaint = before;
      flushEdit();
      drawPaint();
    },
  };
}

export function clearPaint() {
  if (state.supportPaint.length === 0) return;
  beginEdit();
  state.supportPaint = [];
  flushEdit();
  painted();
}

/** The selected object's tally in `result`. */
export function tallyOf(result: SliceResponse | null, objectIndex: number): PaintTally | null {
  if (!result) return null;
  return (result.objects ? result.objects[objectIndex]?.supportPaint : result.supportPaint) ?? null;
}

/** A slice landed with `sent` as its paint: warn once when that paint cannot print or missed the part. */
export function noteTally(result: SliceResponse, objectIndex: number, sent: readonly PaintDisk[], before: readonly PaintDisk[]) {
  const tally = tallyOf(result, objectIndex);
  if (tally && sent !== before) {
    const line = tallyText(tally);
    if (line.warn) pushToast(line.text, "warn");
  }
  session.paintUi?.refresh();
}
