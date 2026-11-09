import { fx } from "./fx";
import { session, state } from "./state";
import { presetKeys } from "../presets";
import { KLIPPER_NUMBERS, saveProfile } from "../profiles";
import { restoreFan, snapFan, withFan } from "../fan";
import { emptyOverrides } from "../overrides";
import { emptyPlate, meshTokenOf, pinPlateMeshes, recallPlateMeshes, revivePlate, snapPlate, type MeshPin, type PlateSnap } from "../plate";
import { bridgeTouched, type BridgeTouchRow } from "../bridge";
import { applySelectedToState, syncPlateFromState } from "./plate-sync";
import { loadMachineLibrary, storeMachineLibrary } from "./machine-library";
import { beltStamp, selectIn, selection, setActiveBelt, setActiveFirmware, setActiveFirmwareArcs, setAdvance, setFan, setNozzleTemp, setRetract, setTemps } from "../ui/machine-library";
import { loadSettingsLevel, setSettingsLevel } from "../ui/settings-panel";
import { pushToast } from "../ui/toasts";
import {
  beginGesture,
  commitGesture,
  emptyHistory,
  foldSince,
  historyRefs,
  pushStep,
  putBrepFor,
  redoSnap,
  undoSnap,
  type EditHistory,
  type EditSnap,
} from "../ui/edit-history";

let history: EditHistory = emptyHistory();
/** Told which plate objects a person's step changed (Tandem counts only these as a person's changes). */
let touchListener: ((ids: readonly string[]) => void) | null = null;

/** Hear which plate objects each person's step changes: every pose a person sets lands here as one undo step does. */
export function onPlateTouched(listener: ((ids: readonly string[]) => void) | null) {
  touchListener = listener;
}

function touchRows(plate: PlateSnap | undefined, pins: readonly MeshPin[] | undefined): BridgeTouchRow[] {
  const tokens = new Map((pins ?? []).map((pin) => [pin.id, pin.token]));
  return (plate?.objects ?? []).map((obj) => ({ id: obj.id, name: obj.name, orient: obj.orient, partScale: obj.partScale, centered: obj.centered, offset: obj.offset, mesh: tokens.get(obj.id) }));
}

function noteTouched(before: EditSnap | null | undefined, after: EditSnap | null | undefined) {
  if (!touchListener || !before || !after) return;
  const ids = bridgeTouched(touchRows(before.plate, before.meshPins), touchRows(after.plate, after.meshPins));
  if (ids.length) touchListener(ids);
}

/** The objects the gesture still open has changed so far: a drag or a typed value not yet a step. */
export function pendingTouched(): string[] {
  const start = history.pending;
  if (!start) return [];
  syncPlateFromState();
  const live = state.plate.objects.map((obj) => ({ id: obj.id, name: obj.name, orient: obj.orient, partScale: obj.partScale, centered: obj.centered, offset: obj.offset, mesh: meshTokenOf(obj.bytes) }));
  return bridgeTouched(touchRows(start.plate, start.meshPins), live);
}

/**
 * Changes that came from elsewhere (a Tandem snapshot) and are nobody's step here: every kept step, and the gesture still
 * open, takes them as if they had always been there. So Undo takes back only what the person did, and never undoes MCP's
 * parts or moves in the window, and a gesture open while a snapshot lands does not count MCP's changes as the person's.
 * `set` is each changed or added object as the plate has it now, with its mesh pin; `removed` the objects that went.
 */
export function rebaseEdits(set: ReadonlyMap<string, { row: PlateSnap["objects"][number]; pin: MeshPin }>, removed: ReadonlySet<string>) {
  if (set.size === 0 && removed.size === 0) return;
  const rebase = (snap: EditSnap | null) => {
    if (!snap?.plate) return;
    const have = new Set(snap.plate.objects.map((row) => row.id));
    const tokens = new Map((snap.meshPins ?? []).map((pin) => [pin.id, pin.token]));
    const copy = (row: PlateSnap["objects"][number]) => {
      const { brep, ...rest } = row;
      const out: PlateSnap["objects"][number] = structuredClone(rest);
      if (brep) out.brep = brep;
      return out;
    };
    snap.plate.objects = [
      ...snap.plate.objects.filter((row) => !removed.has(row.id)).map((row) => {
        const next = set.get(row.id);
        if (!next) return row;
        // A new mesh from MCP is the object's own now, history and all; a move keeps what the step had besides the pose.
        if (tokens.get(row.id) !== next.pin.token) return copy(next.row);
        return { ...row, name: next.row.name, orient: [...next.row.orient], partScale: next.row.partScale, centered: next.row.centered, offset: { ...next.row.offset } };
      }),
      ...[...set].filter(([id]) => !have.has(id)).map(([, { row }]) => copy(row)),
    ];
    if (snap.plate.selectedId && removed.has(snap.plate.selectedId)) snap.plate.selectedId = snap.plate.objects[0]?.id ?? null;
    const pins = (snap.meshPins ?? []).filter((pin) => !removed.has(pin.id) && !set.has(pin.id));
    snap.meshPins = [...pins, ...[...set.values()].map(({ pin }) => pin)];
  };
  for (const snap of history.undo) rebase(snap);
  for (const snap of history.redo) rebase(snap);
  rebase(history.pending);
}

/** The state now, as a step would keep it. Take it before a change that `recordForeignStep` then makes undoable. */
export function captureEdit(): EditSnap {
  return capture();
}

/**
 * A change from elsewhere that replaced something of the window's (Tandem: MCP's shape and Model history for a part,
 * over the window's own) is one named undo step: Undo puts `before` back. A gesture still settling lands first as its
 * own step. Run it after the change and before `releaseModelTrees`, so the trees `before` names stay; then rebase the
 * snapshot's other changes (`rebaseEdits`), which reaches this step too, so its Undo takes back only the swapped parts.
 */
export function recordForeignStep(before: EditSnap, label: string) {
  window.clearTimeout(timer);
  settling = false;
  held = false;
  if (history.pending) commitNow(before);
  history = pushStep({ ...history, pending: null }, before, label);
}

/** Close the open gesture as a step and say which objects it changed. */
function commitNow(current: EditSnap) {
  const before = history.pending;
  history = commitGesture(history, current);
  if (before && !history.pending) noteTouched(before, current);
}
let timer = 0;
let applying = false;
/** A grab is open: moves keep its gesture going, however long the pointer rests. */
let held = false;
/** A `noteEdit` gesture waits out its 280 ms before it lands. */
let settling = false;
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
    assemblies: structuredClone(session.assemblies),
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
      const withHeat = typeof snap.profile.nozzleTemp === "number" && typeof snap.profile.bedTemp === "number"
        ? setTemps(withAdvance, state.profile.nozzleTemp, state.profile.bedTemp)
        : typeof snap.profile.nozzleTemp === "number"
          ? setNozzleTemp(withAdvance, state.profile.nozzleTemp)
          : withAdvance;
      const withHeatAndFan = setFan(withHeat, withFan({}, state.profile));
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
  if (snap.assemblies) session.assemblies = structuredClone(snap.assemblies) as typeof session.assemblies;
  recallPlateMeshes(snap.meshPins);
  if (snap.plate && snap.plate.objects.length > 0) {
    const revived = revivePlate(snap.plate);
    if (revived) {
      state.plate = revived;
      applySelectedToState(revived);
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
  if (held) return;
  settling = true;
  timer = window.setTimeout(() => {
    settling = false;
    commitNow(capture());
    fx.releaseModelTrees?.();
    }, 280);
}

/**
 * Start a gesture that stays open until `flushEdit`, however long it lasts: one brush drag. An edit still settling
 * lands first as its own step, so a value typed and entered just before a drag or a nudge is not undone with it.
 */
export function beginEdit() {
  if (applying || session.projectRestoring) return;
  window.clearTimeout(timer);
  if (settling) commitNow(capture());
  settling = false;
  history = beginGesture(history, capture());
}

export function flushEdit() {
  window.clearTimeout(timer);
  settling = false;
  held = false;
  commitNow(capture());
  // A step that lands can push the oldest one out or clear the redo steps, and their trees with them.
  fx.releaseModelTrees?.();
}

/** Start a gesture that every `noteEdit` extends until `flushEdit` or `cancelEdit`: one grab, however slowly it is dragged. */
export function holdEdit() {
  if (applying || session.projectRestoring) return;
  beginEdit();
  held = true;
}

/** Drop the open gesture and put back the state it began with. */
export function cancelEdit() {
  window.clearTimeout(timer);
  settling = false;
  held = false;
  const start = history.pending;
  history = { ...history, pending: null };
  if (!start) return;
  noteTouched(capture(), start);
  applySnap(start);
}

/** What Model must keep for the steps here. */
export function editHistoryRefs() {
  return historyRefs(history);
}

export function clearEditHistory() {
  window.clearTimeout(timer);
  settling = false;
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

/** The plate changed during the Model visit that is open, or that just closed. */
export function modelVisitChanged(): boolean {
  return visitEdited;
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

/** The steps Undo and Redo would take next, so Model can tell that a step it made is still the newest. */
export function newestEdits(): { undo: EditSnap | null; redo: EditSnap | null; pending: boolean } {
  return { undo: history.undo.at(-1) ?? null, redo: history.redo.at(-1) ?? null, pending: history.pending != null };
}

export function undoUserEdit(): boolean {
  window.clearTimeout(timer);
  settling = false;
  const now = capture();
  const step = undoSnap(history, now);
  if (!step) return false;
  history = step.history;
  sayNamed("Undid", step.restore.label, history.redo.at(-1));
  noteTouched(now, step.restore);
  applySnap(step.restore);
  return true;
}

/** A named step keeps its name both ways, and says it: "Undid Assistant: Fuse Ornament gear on Glasses frame". */
function sayNamed(verb: string, label: string | undefined, other: EditSnap | undefined) {
  if (!label) return;
  if (other) other.label = label;
  pushToast(`${verb} ${label}`, "info");
}

export function redoUserEdit(): boolean {
  window.clearTimeout(timer);
  settling = false;
  const now = capture();
  const step = redoSnap(history, now);
  if (!step) return false;
  history = step.history;
  sayNamed("Redid", step.restore.label, history.undo.at(-1));
  noteTouched(now, step.restore);
  applySnap(step.restore);
  return true;
}
