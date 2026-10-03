/** Add, select, remove, and arrange plate objects. Pose tools keep editing the selection. */
import { arrangedObjects, addedCopy, withoutObject } from "../plate.ts";
import { place } from "./files.ts";
import { flushEdit, noteEdit } from "./history.ts";
import { applySelectedToState, syncPlateFromState } from "./plate-sync.ts";
import { state } from "./state.ts";

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

export function arrangePlate() {
  if (state.plate.objects.length < 2) return;
  noteEdit();
  syncPlateFromState();
  state.plate = {
    ...state.plate,
    objects: arrangedObjects(state.plate.objects, state.profile.bedX, state.profile.bedY),
  };
  applySelectedToState(state.plate);
  place();
  flushEdit();
}
