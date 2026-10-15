import { fx } from "./fx";
import { session, state } from "./state";
import { presetKeys } from "../presets";
import { KLIPPER_NUMBERS, saveProfile } from "../profiles";
import { restoreFan, snapFan, withFan } from "../fan";
import { emptyOverrides } from "../overrides";
import { emptyPlate, pinPlateMeshes, recallPlateMeshes, revivePlate, snapPlate } from "../plate";
import type { Mat3 } from "../mesh-place.ts";
import { isUntilted } from "../workplane";
import { syncOrientBase } from "../workplane-orient";
import { applySelectedToState, syncPlateFromState } from "./plate-sync";
import { loadMachineLibrary, storeMachineLibrary } from "./machine-library";
import { beltStamp, selectIn, selection, setActiveBelt, setActiveFirmware, setActiveFirmwareArcs, setAdvance, setFan, setNozzleTemp, setRetract } from "../ui/machine-library";
import { loadSettingsLevel, setSettingsLevel } from "../ui/settings-panel";
import {
  beginGesture,
  commitGesture,
  emptyHistory,
  foldSince,
  historyRefs,
  putBrepFor,
  redoSnap,
  undoSnap,
  type EditHistory,
  type EditSnap,
} from "../ui/edit-history";

let history: EditHistory = emptyHistory();
let timer = 0;
let applying = false;
/** Steps that existed when Model opened. Null outside Model. */
let preVisit: WeakSet<EditSnap> | null = null;
let visitEdited = false;

function capture(): EditSnap {
  syncPlateFromState();
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
      squareCornerVelocity: profile.squareCornerVelocity,
      minimumCruiseRatio: profile.minimumCruiseRatio,
      extruderCornerVelocity: profile.extruderCornerVelocity,
      maxVelocity: profile.maxVelocity,
      maxZVelocity: profile.maxZVelocity,
      maxZAccel: profile.maxZAccel,
      ...snapFan(profile),
    },
    level: loadSettingsLevel(),
    machine: machineSnap(),
    overrides: structuredClone(state.overrides),
    selectedVolumeId: state.selectedVolumeId,
    plate: snapPlate(state.plate),
    ...(state.mesh ? {} : { meshless: true }),
    meshPins: pinPlateMeshes(state.plate),
    printOrder: state.printOrder,
    sequentialClearanceMm: state.sequentialClearance,
    sequentialGantryMm: state.sequentialGantry,
  };
}

function machineSnap(): EditSnap["machine"] {
  const library = loadMachineLibrary();
  const printer = selection(library)?.printer;
  return {
    printerId: library.printerId,
    filamentId: library.filamentId,
    nozzleMm: library.nozzleMm,
    ...(printer ? { kind: printer.kind, belt: structuredClone(printer.belt), firmware: printer.firmware, firmwareArcs: printer.firmwareArcs ?? null } : {}),
  };
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
  for (const key of Object.keys(KLIPPER_NUMBERS) as (keyof typeof KLIPPER_NUMBERS)[]) {
    const value = snap.profile[key];
    if (typeof value === "number") state.profile[key] = value;
  }
  state.profile = withFan(state.profile, restoreFan(state.profile, snap.profile));
  if (snap.level === "simple" || snap.level === "advanced" || snap.level === "expert") setSettingsLevel(snap.level);
  state.profile.pressureAdvance = state.pressureAdvance;
  state.profile.linearAdvance = state.linearAdvance;
  saveProfile(state.profile);
  if (snap.machine) {
    const selected = selectIn(loadMachineLibrary(), snap.machine.printerId, snap.machine.filamentId, snap.machine.nozzleMm);
    if (typeof selected !== "string") {
      const withAdvance = setAdvance(selected, state.pressureAdvance, state.linearAdvance);
      const withHeatAndFan = setFan(setNozzleTemp(withAdvance, state.profile.nozzleTemp), withFan({}, state.profile));
      const speed = state.retractOn && Math.abs(state.retractSpeed - 30) > 1e-6 ? state.retractSpeed : null;
      storeMachineLibrary(setRetract(withHeatAndFan, state.retractOn ? state.retractLength : null, speed));
    }
    if (snap.machine.kind && snap.machine.belt) {
      const belted = setActiveBelt(loadMachineLibrary(), snap.machine.kind, snap.machine.belt);
      const firmware = snap.machine.firmware ? setActiveFirmware(belted, snap.machine.firmware) : belted;
      const library = snap.machine.firmwareArcs !== undefined ? setActiveFirmwareArcs(firmware, snap.machine.firmwareArcs) : firmware;
      storeMachineLibrary(library);
      fx.prepare?.setBelt(beltStamp(library));
      fx.view3d?.setBelt(beltStamp(library));
      // The kind, the raft, the length cap, and the firmware each change which controls show.
      fx.renderChrome?.();
    }
  }
  state.overrides = snap.overrides ? structuredClone(snap.overrides) : emptyOverrides();
  state.selectedVolumeId = snap.selectedVolumeId ?? null;
  if (state.selectedVolumeId && !state.overrides.volumes.some((volume) => volume.id === state.selectedVolumeId)) {
    state.selectedVolumeId = null;
  }
  state.printOrder = snap.printOrder === "sequential" ? "sequential" : "all-at-once";
  state.sequentialClearance = snap.sequentialClearanceMm ?? 0;
  state.sequentialGantry = snap.sequentialGantryMm ?? 0;
  recallPlateMeshes(snap.meshPins);
  if (snap.plate && snap.plate.objects.length > 0) {
    const revived = revivePlate(snap.plate);
    if (revived) {
      const live = state.plate.objects;
      for (const obj of revived.objects) {
        const was = live.find((item) => item.id === obj.id);
        const leaving = was && (!was.workplane || isUntilted(was.workplane));
        syncOrientBase(obj.id, leaving === true, !obj.workplane || isUntilted(obj.workplane), was ? ([...was.orient] as Mat3) : null);
      }
      state.plate = revived;
      applySelectedToState(revived);
      fx.syncModelFrame?.();
    }
  } else if (snap.meshless) {
    // Before Model's New solid on an empty plate: the plate is empty again. A file still being read has its mesh
    // already, so a step taken meanwhile never empties the plate it lands on.
    state.plate = emptyPlate();
    state.mesh = null;
    state.sourcePos = null;
  }
  applying = false;
  fx.applyPlace?.(true);
}

/** Start or continue a gesture. Call this before the state write. */
export function noteEdit() {
  if (applying || session.projectRestoring) return;
  history = beginGesture(history, capture());
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    history = commitGesture(history, capture());
    fx.releaseModelTrees?.();
    }, 280);
}

/** Start a gesture that stays open until `flushEdit`, however long it lasts: one brush drag. */
export function beginEdit() {
  if (applying || session.projectRestoring) return;
  window.clearTimeout(timer);
  history = beginGesture(history, capture());
}

export function flushEdit() {
  window.clearTimeout(timer);
  history = commitGesture(history, capture());
  // A step that lands can push the oldest one out or clear the redo steps, and their trees with them.
  fx.releaseModelTrees?.();
}

/** What Model must keep for the steps here. */
export function editHistoryRefs() {
  return historyRefs(history);
}

export function clearEditHistory() {
  window.clearTimeout(timer);
  history = emptyHistory();
}

/** Model opened. The steps taken from here on are one visit, until `endModelVisit`. */
export function beginModelVisit() {
  preVisit = new WeakSet([...history.undo, ...history.redo]);
  visitEdited = false;
}

/** The plate took a Model node, or a split piece, in this visit. */
export function markModelEdit() {
  visitEdited = true;
}

/**
 * Fold a visit that changed the plate into one step: only the state before the visit and the one
 * after it stay reachable. The Model tree keeps the steps in between, and the after state gets its
 * STEP by `patchEditBrep` once it is written.
 */
export function endModelVisit() {
  const before = preVisit;
  preVisit = null;
  if (before && visitEdited) history = foldSince(history, before);
}

/** Give every step whose object has mesh `token` that mesh's solid STEP. Undefined removes it. */
export function patchEditBrep(token: string, brep: ArrayBuffer | undefined) {
  putBrepFor(history, token, brep);
}

export function undoUserEdit(): boolean {
  window.clearTimeout(timer);
  const step = undoSnap(history, capture());
  if (!step) return false;
  history = step.history;
  applySnap(step.restore);
  return true;
}

export function redoUserEdit(): boolean {
  window.clearTimeout(timer);
  const step = redoSnap(history, capture());
  if (!step) return false;
  history = step.history;
  applySnap(step.restore);
  return true;
}
