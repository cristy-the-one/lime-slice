/** Turn one object into plate objects: a STEP file's solids, or a mesh's disconnected shells. They keep the bed position they already have. */
import { placeObject, replaceWithShells, replaceWithSolids, type PlateObject, type SolidPiece } from "../plate.ts";
import { shellGroups, takeGroups } from "../mesh-shells.ts";
import { pieceFileName, separateBy, solidNames, stepSolidHint } from "../step-solids.ts";
import { pushToast } from "../ui/toasts.ts";
import { fx } from "./fx.ts";
import { place, previewRemote } from "./files.ts";
import { flushEdit, noteEdit } from "./history.ts";
import { applySelectedToState, syncPlateFromState } from "./plate-sync.ts";
import { state, session } from "./state.ts";
import { stepSolidFiles } from "./step-solids.ts";

/** Split `id`, or the selection. False when that object is one solid. A STEP file of several solids splits by them. */
export function separateShells(id?: string | null): boolean {
  fx.commitModel?.();
  const target = id ?? state.plate.selectedId;
  const found = state.plate.objects.find((item) => item.id === target);
  if (found && separateBy(found.fileName, stepSolidHint(found.bytes)) === "solids") {
    void separateSolids(found);
    return true;
  }
  return separateByShells(target);
}

function separateByShells(target: string | null): boolean {
  noteEdit();
  syncPlateFromState();
  const obj = state.plate.objects.find((item) => item.id === target);
  const groups = obj ? shellGroups(obj.sourcePos) : null;
  if (!obj || !groups) {
    flushEdit();
    return false;
  }
  const world = placeObject(obj, state.profile.bedX, state.profile.bedY).positions;
  const next = replaceWithShells(state.plate, obj.id, takeGroups(world, groups.groups), state.profile.bedX, state.profile.bedY);
  if (!next) {
    flushEdit();
    return false;
  }
  land(next, obj);
  return true;
}

/** One object per solid of `obj`'s STEP file, each read as a STEP file of its own, named from the file. */
async function separateSolids(obj: PlateObject) {
  if (reading.has(obj.bytes)) return;
  reading.add(obj.bytes);
  try {
    await readAndSeparate(obj);
  } finally {
    reading.delete(obj.bytes);
  }
}

const reading = new WeakSet<ArrayBuffer>();

async function readAndSeparate(obj: PlateObject) {
  const epoch = session.meshEpoch;
  pushToast(`Reading the ${stepSolidHint(obj.bytes)} solids of ${obj.name}…`, "info");
  const files = await stepSolidFiles(obj.bytes);
  if (typeof files === "string") {
    pushToast(files, "error");
    return;
  }
  if (session.meshEpoch !== epoch) return;
  if (files.length < 2) {
    if (!separateByShells(obj.id)) pushToast(`${obj.name} is one solid.`, "info");
    return;
  }
  const names = solidNames(obj.fileName, files);
  const pieces: SolidPiece[] = [];
  for (const [index, { bytes }] of files.entries()) {
    const fileName = pieceFileName(names[index]!);
    const read = await previewRemote(fileName, bytes, obj.stepTolerance);
    if (!read) {
      pushToast(state.error || `Could not read ${fileName}.`, "error");
      return;
    }
    pieces.push({ name: names[index]!, fileName, bytes, sourcePos: read.positions, seatMm: read.seatMm ?? 0 });
  }
  if (session.meshEpoch !== epoch || !state.plate.objects.some((item) => item.id === obj.id && item.bytes === obj.bytes)) return;
  fx.commitModel?.();
  noteEdit();
  syncPlateFromState();
  const now = state.plate.objects.find((item) => item.id === obj.id)!;
  const next = replaceWithSolids(state.plate, now.id, pieces, state.profile.bedX, state.profile.bedY);
  if (!next) {
    flushEdit();
    return;
  }
  land(next, now);
}

function land(next: typeof state.plate, from: PlateObject) {
  const painted = from.supportPaint.length + from.seamPaint.length + (from.reinforcement?.length ?? 0) + from.supportEdits.length > 0;
  state.plate = next;
  applySelectedToState(state.plate);
  place();
  flushEdit();
  fx.followSelection?.();
  if (painted) pushToast("Paint on this object was cleared.", "info");
}

Object.assign(fx, { separateShells });
