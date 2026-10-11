/** Add, select, remove, and arrange plate objects. Pose tools keep editing the selection. */
import { arrangedObjects, addedCopy, placeObject, plateUnionBounds, withoutObject } from "../plate.ts";
import { fx } from "./fx.ts";
import { place } from "./files.ts";
import { flushEdit, noteEdit } from "./history.ts";
import { applySelectedToState, syncPlateFromState } from "./plate-sync.ts";
import { state } from "./state.ts";
import { currentRules } from "./rules.ts";
import { sequentialClearance } from "../settings-rules.ts";
import type { Bounds } from "../mesh-place.ts";

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
  if (state.plate.objects.length === 1) frameSelection();
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

/** Frame the named solid. Selection, when it changes, is the only undo step. */
export function framePlateObject(id: string) {
  if (!state.plate.objects.some((obj) => obj.id === id)) return;
  if (state.plate.selectedId !== id) selectPlateObject(id);
  frameSelection();
}

function frameSelection() {
  const selected = state.plate.objects.find((obj) => obj.id === state.plate.selectedId);
  if (!selected) return;
  frameBounds(placeObject(selected, state.profile.bedX, state.profile.bedY).bounds);
}

function frameBounds(bounds: Bounds) {
  fx.prepare?.frameBounds?.(bounds);
}

/** A hair past the toolhead clearance, so float rounding never lands an object exactly on the engine's limit. */
const CLEARANCE_SLACK_MM = 0.01;

export function arrangePlate() {
  if (state.plate.objects.length < 2) return;
  noteEdit();
  syncPlateFromState();
  const prior = state.plate.objects.map((obj) => ({ id: obj.id, x: obj.offset.x, y: obj.offset.y, centered: obj.centered }));
  // One at a time, objects keep the toolhead clearance the engine will ask for.
  const clearance = sequentialClearance(currentRules(), { printOrder: state.printOrder, clearanceMm: state.sequentialClearance, gantryMm: state.sequentialGantry });
  state.plate = {
    ...state.plate,
    objects: arrangedObjects(state.plate.objects, state.profile.bedX, state.profile.bedY, clearance === null ? undefined : clearance + CLEARANCE_SLACK_MM),
  };
  const moved = state.plate.objects.some((obj) => {
    const was = prior.find((row) => row.id === obj.id);
    return !was || was.centered || Math.abs(was.x - obj.offset.x) > 0.01 || Math.abs(was.y - obj.offset.y) > 0.01;
  });
  applySelectedToState(state.plate);
  place();
  flushEdit();
  if (!moved) return;
  const union = plateUnionBounds(state.plate.objects, state.profile.bedX, state.profile.bedY);
  if (union) frameBounds(union);
}
