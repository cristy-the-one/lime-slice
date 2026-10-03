import { fx } from "./fx";
import { session, state } from "./state";
import { presetKeys } from "../presets";
import { saveProfile } from "../profiles";
import { loadMachineLibrary, storeMachineLibrary } from "./machine-library";
import { selectIn, setAdvance } from "../ui/machine-library";
import { loadSettingsLevel, setSettingsLevel } from "../ui/settings-panel";
import {
  beginGesture,
  canRedo,
  canUndo,
  commitGesture,
  emptyHistory,
  redoSnap,
  undoSnap,
  type EditHistory,
  type EditSnap,
} from "../ui/edit-history";

let history: EditHistory = emptyHistory();
let timer = 0;
let applying = false;

function capture(): EditSnap {
  const settings: EditSnap["settings"] = {};
  for (const key of presetKeys()) settings[key] = state[key] as string | number | boolean;
  const profile = state.profile;
  return {
    placement: {
      orient: [...state.orient],
      partScale: state.partScale,
      centered: state.centered,
      offset: { x: state.offset.x, y: state.offset.y, z: state.offset.z },
      stepTolerance: state.stepTolerance,
    },
    settings,
    splitCustom: state.splitCustom,
    profile: {
      nozzleDiameter: profile.nozzleDiameter,
      bedX: profile.bedX,
      bedY: profile.bedY,
      bedZ: profile.bedZ,
      maxVolumetricMm3S: profile.maxVolumetricMm3S,
      maxAccel: profile.maxAccel,
      filamentDensityGCm3: profile.filamentDensityGCm3,
      filamentCostPerKg: profile.filamentCostPerKg,
      name: profile.name,
      filamentDiameter: profile.filamentDiameter,
      nozzleTemp: profile.nozzleTemp,
      bedTemp: profile.bedTemp,
    },
    level: loadSettingsLevel(),
    machine: {
      printerId: loadMachineLibrary().printerId,
      filamentId: loadMachineLibrary().filamentId,
      nozzleMm: loadMachineLibrary().nozzleMm,
    },
  };
}

function paintHistoryButtons() {
  const undo = document.querySelector<HTMLButtonElement>("#undoEdit");
  const redo = document.querySelector<HTMLButtonElement>("#redoEdit");
  const current = capture();
  if (undo) undo.disabled = !canUndo(history, current);
  if (redo) redo.disabled = !canRedo(history, current);
}

function applySnap(snap: EditSnap) {
  applying = true;
  state.orient = snap.placement.orient as typeof state.orient;
  state.partScale = snap.placement.partScale;
  state.centered = snap.placement.centered;
  state.offset = { ...snap.placement.offset };
  state.stepTolerance = snap.placement.stepTolerance;
  state.splitCustom = snap.splitCustom;
  for (const key of presetKeys()) {
    if (key in snap.settings) (state as unknown as Record<string, unknown>)[key] = snap.settings[key];
  }
  state.profile.nozzleDiameter = snap.profile.nozzleDiameter;
  state.profile.bedX = snap.profile.bedX;
  state.profile.bedY = snap.profile.bedY;
  state.profile.bedZ = snap.profile.bedZ;
  state.profile.maxVolumetricMm3S = snap.profile.maxVolumetricMm3S;
  state.profile.maxAccel = snap.profile.maxAccel;
  state.profile.filamentDensityGCm3 = snap.profile.filamentDensityGCm3;
  state.profile.filamentCostPerKg = snap.profile.filamentCostPerKg;
  if (typeof snap.profile.name === "string") state.profile.name = snap.profile.name;
  if (typeof snap.profile.filamentDiameter === "number") state.profile.filamentDiameter = snap.profile.filamentDiameter;
  if (typeof snap.profile.nozzleTemp === "number") state.profile.nozzleTemp = snap.profile.nozzleTemp;
  if (typeof snap.profile.bedTemp === "number") state.profile.bedTemp = snap.profile.bedTemp;
  if (snap.level === "simple" || snap.level === "advanced" || snap.level === "expert") setSettingsLevel(snap.level);
  state.profile.pressureAdvance = state.pressureAdvance;
  state.profile.linearAdvance = state.linearAdvance;
  saveProfile(state.profile);
  if (snap.machine) {
    const selected = selectIn(loadMachineLibrary(), snap.machine.printerId, snap.machine.filamentId, snap.machine.nozzleMm);
    if (typeof selected !== "string") storeMachineLibrary(setAdvance(selected, state.pressureAdvance, state.linearAdvance));
  }
  applying = false;
  fx.applyPlace?.(true);
  paintHistoryButtons();
}

/** Start or continue a gesture. Call this before the state write. */
export function noteEdit() {
  if (applying || session.projectRestoring) return;
  history = beginGesture(history, capture());
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    history = commitGesture(history, capture());
    paintHistoryButtons();
  }, 280);
}

export function flushEdit() {
  window.clearTimeout(timer);
  history = commitGesture(history, capture());
  paintHistoryButtons();
}

export function canUndoEdit() {
  return canUndo(history, capture());
}

export function canRedoEdit() {
  return canRedo(history, capture());
}

export function clearEditHistory() {
  window.clearTimeout(timer);
  history = emptyHistory();
  paintHistoryButtons();
}

export function undoUserEdit() {
  window.clearTimeout(timer);
  const step = undoSnap(history, capture());
  if (!step) {
    paintHistoryButtons();
    return;
  }
  history = step.history;
  applySnap(step.restore);
}

export function redoUserEdit() {
  window.clearTimeout(timer);
  const step = redoSnap(history, capture());
  if (!step) {
    paintHistoryButtons();
    return;
  }
  history = step.history;
  applySnap(step.restore);
}
