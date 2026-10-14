/** Turn one mesh's disconnected shells into plate objects. They keep the bed position they already have. */
import { placeObject, replaceWithShells } from "../plate.ts";
import { shellGroups, takeGroups } from "../mesh-shells.ts";
import { pushToast } from "../ui/toasts.ts";
import { fx } from "./fx.ts";
import { place } from "./files.ts";
import { flushEdit, noteEdit } from "./history.ts";
import { applySelectedToState, syncPlateFromState } from "./plate-sync.ts";
import { state } from "./state.ts";

/** Split `id`, or the selection. False when that object is one solid. */
export function separateShells(id?: string | null): boolean {
  noteEdit();
  syncPlateFromState();
  const target = id ?? state.plate.selectedId;
  const obj = state.plate.objects.find((item) => item.id === target);
  const groups = obj ? shellGroups(obj.sourcePos) : null;
  if (!obj || !groups) {
    flushEdit();
    return false;
  }
  const painted = obj.supportPaint.length + obj.seamPaint.length + (obj.reinforcement?.length ?? 0) + obj.supportEdits.length > 0;
  const world = placeObject(obj, state.profile.bedX, state.profile.bedY).positions;
  const next = replaceWithShells(state.plate, obj.id, takeGroups(world, groups.groups));
  if (!next) {
    flushEdit();
    return false;
  }
  state.plate = next;
  applySelectedToState(state.plate);
  place();
  flushEdit();
  if (painted) pushToast("Paint on this object was cleared.", "info");
  return true;
}

Object.assign(fx, { separateShells });
