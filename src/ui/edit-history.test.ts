import {
  beginGesture,
  canRedo,
  canUndo,
  commitGesture,
  emptyHistory,
  redoSnap,
  sameSnap,
  undoSnap,
  type EditSnap,
} from "./edit-history.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

function snap(scale: number, layer = 0.2): EditSnap {
  return {
    placement: {
      orient: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      partScale: scale,
      centered: true,
      offset: { x: 0, y: 0, z: 0 },
      stepTolerance: 0.1,
    },
    settings: { layerHeight: layer, blendKind: "single" },
    splitCustom: false,
    profile: {
      nozzleDiameter: 0.4,
      bedX: 220,
      bedY: 220,
      bedZ: 250,
      maxVolumetricMm3S: 12,
      maxAccel: 10000,
      filamentDensityGCm3: 1.24,
      filamentCostPerKg: 20,
    },
  };
}

const before = snap(1, 0.2);
const after = snap(1.5, 0.28);
let history = beginGesture(emptyHistory(), before);
history = beginGesture(history, after);
check("a gesture keeps the first snapshot", sameSnap(history.pending!, before));
history = commitGesture(history, after);
check("one gesture is one undo step", history.undo.length === 1 && history.redo.length === 0 && history.pending == null);
check("undo is available", canUndo(history, after));
check("redo is empty", !canRedo(history, after));

const undone = undoSnap(history, after);
check("undo restores the scale", undone?.restore.placement.partScale === 1);
check("undo keeps the layer height", undone?.restore.settings.layerHeight === 0.2);
history = undone!.history;
check("redo is available after undo", canRedo(history, undone!.restore) && history.redo.length === 1);

const redone = redoSnap(history, undone!.restore);
check("redo restores the edited scale", redone?.restore.placement.partScale === 1.5);
history = redone!.history;
check("redo spends the future", history.redo.length === 0 && history.undo.length === 1);

const open = beginGesture(history, redone!.restore);
const moved = snap(2, 0.28);
check("an open gesture can undo", canUndo(open, moved));
check("an open gesture hides redo", !canRedo(open, moved));
const cancelled = undoSnap(open, moved);
check("undo closes the open gesture", cancelled?.restore.placement.partScale === 1.5 && cancelled.history.pending == null);

const identical = commitGesture(beginGesture(emptyHistory(), before), before);
check("an unchanged gesture does not stack", identical.undo.length === 0 && identical.pending == null);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("edit-history: gesture, undo, and redo ok");
