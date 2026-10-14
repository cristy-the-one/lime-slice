import {
  beginGesture,
  canRedo,
  canUndo,
  cloneSnap,
  commitGesture,
  emptyHistory,
  foldSince,
  putBrepFor,
  redoSnap,
  sameSnap,
  undoSnap,
  type EditSnap,
} from "./edit-history.ts";
import type { PlateSnapObject } from "../plate.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

function snap(scale: number, layer = 0.2, level: "simple" | "advanced" | "expert" = "expert"): EditSnap {
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
    level,
  };
}

function plateRow(id: string): PlateSnapObject {
  return {
    id,
    name: id,
    fileName: `${id}.stl`,
    orient: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    partScale: 1,
    centered: true,
    offset: { x: 0, y: 0, z: 0 },
    stepTolerance: 0.1,
    supportEdits: [],
    supportPaint: [],
    seamPaint: [],
    settings: {},
  };
}

const before = snap(1, 0.2, "expert");
const after = snap(1.5, 0.28, "simple");
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
check("undo restores the settings level", undone?.restore.level === "expert");
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

let visit = commitGesture(beginGesture(emptyHistory(), snap(1)), snap(2));
const earlier = new WeakSet(visit.undo);
for (const scale of [3, 4, 5]) visit = commitGesture(beginGesture(visit, snap(scale - 1)), snap(scale));
const visited = undoSnap(visit, snap(5))!.history;
const folded = foldSince(visited, earlier);
check(
  "a Model visit folds to its first step",
  folded.undo.length === 2 && folded.undo[0]!.placement.partScale === 1 && folded.undo[1]!.placement.partScale === 2,
  JSON.stringify(folded.undo.map((step) => step.placement.partScale)),
);
check("a folded visit has no redo", folded.redo.length === 0);
const untouched = foldSince(visit, new WeakSet([...visit.undo]));
check("a visit with no new step keeps every step", untouched.undo.length === visit.undo.length);

const pinned = (token: string): EditSnap => ({
  ...snap(1),
  plate: { selectedId: "a", objects: [{ ...plateRow("a"), brep: new ArrayBuffer(1) }, plateRow("b")] },
  meshPins: [{ id: "a", token }, { id: "b", token: "other" }],
});
const stale = { undo: [pinned("m7"), pinned("m8")], redo: [pinned("m7")], pending: null };
const kept = stale.undo[0]!;
const step = new ArrayBuffer(9);
putBrepFor(stale, "m7", step);
check("the STEP lands on every step with that mesh", stale.undo[0]!.plate!.objects[0]!.brep === step && stale.redo[0]!.plate!.objects[0]!.brep === step);
check("a step with another mesh keeps its STEP", stale.undo[1]!.plate!.objects[0]!.brep?.byteLength === 1);
check("another object keeps none", stale.undo[0]!.plate!.objects[1]!.brep === undefined);
check("a patched step is still the same step", stale.undo[0] === kept);
putBrepFor(stale, "m7", undefined);
check("an unwritable solid loses its STEP", !("brep" in stale.undo[0]!.plate!.objects[0]!));

const solid = pinned("m9");
const cloned = cloneSnap(solid);
check("a copied step shares the STEP buffer", cloned.plate!.objects[0]!.brep === solid.plate!.objects[0]!.brep);
check("an object without a STEP stays without one", !("brep" in cloned.plate!.objects[1]!));
check("the rest is a copy", cloned.plate!.objects[0] !== solid.plate!.objects[0] && cloned.meshPins !== solid.meshPins && sameSnap(cloned, solid));

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("edit-history: gesture, undo, and redo ok");
