/** Add, select, remove, and arrange plate objects. Pose tools keep editing the selection. */
import { arrangedObjects, addedCopy, withoutObject } from "../plate.ts";
import { place } from "./files.ts";
import { flushEdit, noteEdit } from "./history.ts";
import { applySelectedToState, syncPlateFromState } from "./plate-sync.ts";
import { state } from "./state.ts";
import { currentRules } from "./rules.ts";
import { sequentialClearance } from "../settings-rules.ts";

export function addPlateObject() {
  if (!state.mesh || !state.sourcePos) return;
  noteEdit();
  syncPlateFromState();
  const next = addedCopy(state.plate);
  if (!next) return;
  state.plate = next;
  applySelectedToState(state.plate);
  place();
  flushEdit();
}

export function removePlateObject(id: string) {
  if (state.plate.objects.length <= 1) return;
  noteEdit();
  syncPlateFromState();
  state.plate = withoutObject(state.plate, id);
  applySelectedToState(state.plate);
  place();
  flushEdit();
}

export function selectPlateObject(id: string) {
  if (state.plate.selectedId === id) return;
  if (!state.plate.objects.some((obj) => obj.id === id)) return;
  noteEdit();
  syncPlateFromState();
  state.plate = { ...state.plate, selectedId: id };
  applySelectedToState(state.plate);
  place();
  flushEdit();
}

/** A hair past the toolhead clearance, so float rounding never lands an object exactly on the engine's limit. */
const CLEARANCE_SLACK_MM = 0.01;

export function arrangePlate() {
  if (state.plate.objects.length < 2) return;
  noteEdit();
  syncPlateFromState();
  // One at a time, objects keep the toolhead clearance the engine will ask for.
  const clearance = sequentialClearance(currentRules(), { printOrder: state.printOrder, clearanceMm: state.sequentialClearance, gantryMm: state.sequentialGantry });
  state.plate = {
    ...state.plate,
    objects: arrangedObjects(state.plate.objects, state.profile.bedX, state.profile.bedY, clearance === null ? undefined : clearance + CLEARANCE_SLACK_MM),
  };
  applySelectedToState(state.plate);
  place();
  flushEdit();
}
