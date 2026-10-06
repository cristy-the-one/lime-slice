/** Seam paint against the live session: brush strokes, clear, and the drawn disks. */
import { fx } from "./fx";
import { session, state } from "./state";
import { beginEdit, flushEdit } from "./history";
import { syncPlateFromState } from "./plate-sync";
import { touch } from "./settings";
import { sourceFrame } from "../plate";
import { markProjectDirty } from "../project-dirty";
import { addSeamDisk, MAX_PAINT_DISKS, seamDiskFromHit, seamInMeshFrame, strokeTakes, type SeamDisk } from "../seam-paint";
import type { BrushHooks } from "../prepare-view";
import { pushToast } from "../ui/toasts";

/** Draw the selected object's seam paint on the prepare mesh and repaint the brush bar. */
export function drawSeam() {
  const source = state.sourcePos;
  const frame = source ? sourceFrame(source, state.partScale) : null;
  fx.prepare?.setSeamPaint(frame ? state.seamPaint.map((d) => seamInMeshFrame(d, frame)) : []);
  session.seamUi?.refresh();
}

function painted() {
  syncPlateFromState();
  markProjectDirty();
  drawSeam();
  if (state.result) void fx.runSlice(false);
  else touch();
}

/** One drag of the brush: one undo step, then one slice. */
export function seamStroke(radius: number): BrushHooks {
  const before = state.seamPaint;
  let last: SeamDisk | undefined;
  let warned = false;
  return {
    start: () => beginEdit(),
    hit(point, normal) {
      const placed = state.placed;
      if (!placed || !state.sourcePos) return;
      const disk = seamDiskFromHit(point, normal, radius, placed.pose, sourceFrame(state.sourcePos, state.partScale));
      if (!strokeTakes(last ? { ...last, kind: "enforce" } : undefined, { ...disk, kind: "enforce" })) return;
      const next = addSeamDisk(state.seamPaint, disk);
      if (next === state.seamPaint) {
        if (!warned) pushToast(`One object holds at most ${MAX_PAINT_DISKS} seam disks. Clear some paint to add more.`, "warn");
        warned = true;
        return;
      }
      state.seamPaint = next;
      last = disk;
      drawSeam();
    },
    end() {
      flushEdit();
      if (state.seamPaint !== before) painted();
    },
    cancel() {
      state.seamPaint = before;
      flushEdit();
      drawSeam();
    },
  };
}

export function clearSeam() {
  if (state.seamPaint.length === 0) return;
  beginEdit();
  state.seamPaint = [];
  flushEdit();
  painted();
}
