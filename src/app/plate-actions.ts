/** Select, duplicate, remove, and arrange plate objects. Adding a file is `addMeshBytes`. Pose tools keep editing the selection. */
import { arrangedObjects, addedCopy, placeObject, plateUnionBounds, withoutObject } from "../plate.ts";
import { fx } from "./fx.ts";
import { place } from "./files.ts";
import { flushEdit, noteEdit } from "./history.ts";
import { commitModel, exportAssemblyStep, followSelection, frameInModel } from "./model.ts";
import { applySelectedToState, syncPlateFromState } from "./plate-sync.ts";
import { state } from "./state.ts";
import { attachTo, liveAssemblies, ungroup } from "./assemblies.ts";
import { pushToast } from "../ui/toasts.ts";
import { currentRules } from "./rules.ts";
import { sequentialClearance } from "../settings-rules.ts";
import type { Bounds } from "../mesh-place.ts";
import { alignDelta, bedBox, type AlignRelation } from "../place-snap.ts";
import { nudgePlacement } from "./files.ts";
import { renderChrome } from "./settings.ts";

/** An exact copy of the selected object: same mesh, pose, paint, and overrides. In model space it sits beside the original. */
export function duplicatePlateObject() {
  if (!state.mesh || !state.sourcePos || !state.plate.selectedId) return;
  commitModel();
  noteEdit();
  syncPlateFromState();
  const next = addedCopy(state.plate);
  if (!next) return;
  state.plate = next;
  applySelectedToState(state.plate);
  place();
  flushEdit();
  followSelection();
}

export function removePlateObject(id: string) {
  if (state.plate.objects.length <= 1) return;
  commitModel();
  noteEdit();
  syncPlateFromState();
  state.plate = withoutObject(state.plate, id);
  applySelectedToState(state.plate);
  place();
  flushEdit();
  followSelection();
  if (state.plate.objects.length === 1) frameSelection();
}

/**
 * --- Assemblies M5. Attach: `id` sits on the selected object where it stands, in its assembly or a new one with the
 * selected object as its root. A member's typed Model numbers are read in its own frame (D2). Null, or why not.
 */
export function attachPlateObject(id: string): string | null {
  const parent = state.plate.selectedId;
  if (!parent || parent === id) return null;
  commitModel();
  noteEdit();
  syncPlateFromState();
  const refused = attachTo(id, parent);
  if (refused) {
    flushEdit();
    return refused;
  }
  state.plate = { ...state.plate, objects: state.plate.objects.map((obj) => (obj.id === id ? { ...obj, frame: "part" as const } : obj)) };
  place();
  flushEdit();
  return null;
}

/** Ungroup: the assembly goes, and every part keeps where it is in both views. */
export function ungroupAssembly(id: string) {
  noteEdit();
  ungroup(id);
  place();
  flushEdit();
}

/**
 * --- Assemblies M9. Lay out one assembly for print: its members are laid out on the bed around the other objects,
 * which stay where they are, as Arrange lays out a whole plate. Their assembled poses do not change. One undo step.
 */
export function layOutAssembly(id: string) {
  const assembly = liveAssemblies().find((row) => row.id === id);
  if (!assembly) return;
  commitModel();
  noteEdit();
  syncPlateFromState();
  const members = new Set(assembly.members.map((row) => row.object));
  const keep = new Set(state.plate.objects.filter((obj) => !members.has(obj.id)).map((obj) => obj.id));
  const clearance = sequentialClearance(currentRules(), { printOrder: state.printOrder, clearanceMm: state.sequentialClearance, gantryMm: state.sequentialGantry });
  state.plate = {
    ...state.plate,
    objects: arrangedObjects(state.plate.objects, state.profile.bedX, state.profile.bedY, clearance === null ? undefined : clearance + CLEARANCE_SLACK_MM, keep),
  };
  applySelectedToState(state.plate);
  place();
  flushEdit();
  const union = plateUnionBounds(state.plate.objects.filter((obj) => members.has(obj.id)), state.profile.bedX, state.profile.bedY);
  if (union) frameBounds(union);
}

/** --- Assemblies M9. Save one STEP file of the assembly at its assembled poses, and say what was saved. */
export async function exportAssembly(id: string) {
  const assembly = liveAssemblies().find((row) => row.id === id);
  if (!assembly) return;
  commitModel();
  const done = await exportAssemblyStep(assembly);
  pushToast(done.message, done.ok ? "info" : "error");
}

export function selectPlateObject(id: string) {
  if (state.plate.selectedId === id) return;
  if (!state.plate.objects.some((obj) => obj.id === id)) return;
  // The live state is about to become the other object's, so the open solid's shown step lands first.
  commitModel();
  noteEdit();
  syncPlateFromState();
  state.plate = { ...state.plate, selectedId: id };
  applySelectedToState(state.plate);
  place();
  flushEdit();
  followSelection();
}

/** Frame the named solid in the view on screen: the plate, or model space in Model. Selection, when it changes, is the only undo step. */
export function framePlateObject(id: string) {
  if (!state.plate.objects.some((obj) => obj.id === id)) return;
  if (state.stage === "model") frameInModel(id);
  if (state.plate.selectedId !== id) selectPlateObject(id);
  if (state.stage !== "model") frameSelection();
}

function frameSelection() {
  const selected = state.plate.objects.find((obj) => obj.id === state.plate.selectedId);
  if (!selected) return;
  frameBounds(placeObject(selected, state.profile.bedX, state.profile.bedY).bounds);
}

// --- A7 model check --- model.ts asks for a selection change without importing this module back.
fx.selectPlateObject = selectPlateObject;

function frameBounds(bounds: Bounds) {
  fx.prepare?.frameBounds?.(bounds);
}

/** A hair past the toolhead clearance, so float rounding never lands an object exactly on the engine's limit. */
const CLEARANCE_SLACK_MM = 0.01;

export function arrangePlate() {
  if (state.plate.objects.length < 2) return;
  commitModel();
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

/**
 * Line the selected object up with the bed (`"bed"`) or another object, one undo step. The bed has no far side, so it takes only
 * the relations that do not touch from outside. False when nothing moved.
 */
export function alignSelectedTo(targetId: string, relation: AlignRelation): boolean {
  const moving = state.placed?.bounds;
  if (!moving || !state.plate.selectedId) return false;
  const { bedX, bedY, bedZ } = state.profile;
  const target = targetId === "bed" ? bedBox(bedX, bedY, bedZ) : state.plate.objects.find((obj) => obj.id === targetId && obj.id !== state.plate.selectedId);
  const box = target && "min" in target ? target : target ? placeObject(target, bedX, bedY).bounds : null;
  if (!box) return false;
  const delta = alignDelta(moving, box, relation, targetId === "bed");
  if (!delta || delta.every((d) => d === 0)) return false;
  commitModel();
  noteEdit();
  nudgePlacement("x", delta[0]);
  nudgePlacement("y", delta[1]);
  nudgePlacement("z", delta[2]);
  flushEdit();
  fx.scheduleAuto();
  renderChrome();
  return true;
}
