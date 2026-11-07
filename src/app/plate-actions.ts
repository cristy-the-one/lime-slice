/** Select, duplicate, remove, and arrange plate objects. Adding a file is `addMeshBytes`. Pose tools keep editing the selection. */
import { arrangedObjects, addedCopy, freshPlateId, placeObject, plateUnionBounds, type PlateObject } from "../plate.ts";
import { componentIds, copyName, duplicateChain, linkedTo, refreshLinks, removedChain, removedMember, unlinked } from "../chain.ts";
import { bedToSourcePoint, centreOf, snapPivotPoint, usingCustomPivot, type Vec3 } from "../pivot.ts";
import { fx } from "./fx.ts";
import { applyPlace, place, syncPlateView } from "./files.ts";
import { isHidden, isolate, setHidden, showAll } from "../model-hidden.ts";
import { flushEdit, noteEdit } from "./history.ts";
import { loadModel, modelApi, withModel } from "./workspaces.ts";
import { applySelectedToState, syncPlateFromState } from "./plate-sync.ts";
import { session, state } from "./state.ts";
import { attachTo, liveAssemblies, ungroup } from "./assemblies.ts";
import { pushToast } from "../ui/toasts.ts";
import { currentRules } from "./rules.ts";
import { sequentialClearance } from "../settings-rules.ts";
import type { Bounds } from "../mesh-place.ts";
import { alignDelta, bedBox, type AlignRelation } from "../place-snap.ts";
import { nudgePlacement } from "./files.ts";
import { refreshObjectList, renderChrome } from "./settings.ts";

/** An exact copy of the selected object: same mesh, pose, paint, and overrides. In model space it sits beside the original. */
export function duplicatePlateObject() {
  if (!state.mesh || !state.sourcePos || !state.plate.selectedId) return;
  modelApi()?.commitModel();
  noteEdit();
  syncPlateFromState();
  const bed = { x: state.profile.bedX, y: state.profile.bedY };
  const selected = state.plate.selectedId;
  const chain = session.chainRoot && componentIds(state.plate.objects, session.chainRoot);
  if (chain && chain.length > 1 && chain.includes(selected)) {
    const copied = duplicateChain(state.plate.objects, session.chainRoot!, bed, freshPlateId, copyName);
    if (!copied) return;
    state.plate = { objects: copied.objects, selectedId: copied.selectedId };
    session.chainRoot = componentIds(copied.objects, copied.selectedId)[0] ?? null;
  } else {
    const next = addedCopy(state.plate);
    if (!next) return;
    state.plate = next;
    session.chainRoot = null;
  }
  applySelectedToState(state.plate);
  place();
  flushEdit();
  modelApi()?.followSelection();
}

export function removePlateObject(id: string) {
  if (state.plate.objects.length <= 1) return;
  const asChain = session.chainRoot !== null && componentIds(state.plate.objects, session.chainRoot).includes(id);
  if (asChain && !removedChain(state.plate.objects, session.chainRoot!)) return;
  modelApi()?.commitModel();
  noteEdit();
  syncPlateFromState();
  const bed = { x: state.profile.bedX, y: state.profile.bedY };
  if (asChain) {
    const kept = removedChain(state.plate.objects, session.chainRoot!);
    if (!kept) return;
    const selectedId = kept.some((obj) => obj.id === state.plate.selectedId) ? state.plate.selectedId : kept[0]!.id;
    state.plate = { objects: kept, selectedId };
    session.chainRoot = null;
  } else {
    const objects = removedMember(state.plate.objects, id, bed);
    const selectedId = objects.some((obj) => obj.id === state.plate.selectedId) ? state.plate.selectedId : objects[0]?.id ?? null;
    state.plate = { objects, selectedId };
    if (session.chainRoot && !objects.some((obj) => obj.id === session.chainRoot)) session.chainRoot = null;
  }
  applySelectedToState(state.plate);
  place();
  flushEdit();
  modelApi()?.followSelection();
  if (state.plate.objects.length === 1) frameSelection();
}

/**
 * --- Assemblies M5. Attach: `id` sits on the selected object where it stands, in its assembly or a new one with the
 * selected object as its root. A member's typed Model numbers are read in its own frame (D2). Null, or why not.
 */
export function attachPlateObject(id: string): string | null {
  const parent = state.plate.selectedId;
  if (!parent || parent === id) return null;
  modelApi()?.commitModel();
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
  modelApi()?.commitModel();
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
  modelApi()?.commitModel();
  const done = await (await loadModel()).exportAssemblyStep(assembly);
  pushToast(done.message, done.ok ? "info" : "error");
}

export function selectPlateObject(id: string) {
  if (state.plate.selectedId === id && session.chainRoot === null) return;
  if (!state.plate.objects.some((obj) => obj.id === id)) return;
  session.chainRoot = null;
  // The live state is about to become the other object's, so the open solid's shown step lands first.
  modelApi()?.commitModel();
  noteEdit();
  syncPlateFromState();
  state.plate = { ...state.plate, selectedId: id };
  applySelectedToState(state.plate);
  place();
  flushEdit();
  modelApi()?.followSelection();
}

/**
 * The eye in the Objects list: hide or show one object in the 3D view (`only`: show just this one, or all again). The
 * selected object is always shown. A view choice: the plate, the slice and the export are untouched.
 */
export function togglePlateHidden(id: string, only: boolean) {
  const ids = state.plate.objects.map((obj) => obj.id).filter((other) => other !== state.plate.selectedId);
  if (!ids.includes(id)) return;
  if (only) isolate(id, ids);
  else setHidden(id, !isHidden(id));
  hiddenChanged();
}

export function showAllPlateObjects() {
  showAll();
  hiddenChanged();
}

function hiddenChanged() {
  syncPlateView();
  refreshObjectList();
  if (state.stage === "model") fx.refreshModelContext?.();
}

/** Frame the named solid in the view on screen: the plate, or model space in Model. Selection, when it changes, is the only undo step. */
export function framePlateObject(id: string) {
  if (!state.plate.objects.some((obj) => obj.id === id)) return;
  if (state.stage === "model") withModel((model) => model.frameInModel(id));
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
  modelApi()?.commitModel();
  noteEdit();
  syncPlateFromState();
  const prior = state.plate.objects.map((obj) => ({ id: obj.id, x: obj.offset.x, y: obj.offset.y, centered: obj.centered }));
  // One at a time, objects keep the toolhead clearance the engine will ask for.
  const clearance = sequentialClearance(currentRules(), { printOrder: state.printOrder, clearanceMm: state.sequentialClearance, gantryMm: state.sequentialGantry });
  state.plate = {
    ...state.plate,
    objects: refreshLinks(
      arrangedObjects(state.plate.objects, state.profile.bedX, state.profile.bedY, clearance === null ? undefined : clearance + CLEARANCE_SLACK_MM),
      { x: state.profile.bedX, y: state.profile.bedY },
    ),
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
  modelApi()?.commitModel();
  noteEdit();
  nudgePlacement("x", delta[0]);
  nudgePlacement("y", delta[1]);
  nudgePlacement("z", delta[2]);
  flushEdit();
  fx.scheduleAuto();
  renderChrome();
  return true;
}

Object.assign(fx, { notePivotTriple });

function bedSize() {
  return { x: state.profile.bedX, y: state.profile.bedY };
}

function rewritePlate(objects: PlateObject[], selectedId = state.plate.selectedId) {
  state.plate = { objects, selectedId };
  applySelectedToState(state.plate);
  place();
}

/** Select the whole chain so the common move, rotate, scale, duplicate and delete act on it. */
export function selectChain(id: string) {
  const ids = componentIds(state.plate.objects, id);
  const root = ids[0];
  if (!root || ids.length < 2) return;
  session.chainRoot = root;
  if (state.plate.selectedId === root) {
    renderChrome();
    return;
  }
  modelApi()?.commitModel();
  noteEdit();
  syncPlateFromState();
  state.plate = { ...state.plate, selectedId: root };
  applySelectedToState(state.plate);
  place();
  flushEdit();
}

export function linkPlateObject(childId: string): string | null {
  const parentId = state.plate.selectedId;
  if (!parentId || parentId === childId) return "Select the parent, then link the child.";
  const linked = linkedTo(state.plate.objects, childId, parentId, bedSize());
  if (linked.reason) return linked.reason;
  modelApi()?.commitModel();
  noteEdit();
  syncPlateFromState();
  const placed = linkedTo(state.plate.objects, childId, parentId, bedSize());
  session.chainRoot = componentIds(placed.objects, parentId)[0] ?? parentId;
  rewritePlate(placed.objects, parentId);
  flushEdit();
  return null;
}

export function unlinkPlateObject(id: string) {
  modelApi()?.commitModel();
  noteEdit();
  syncPlateFromState();
  if (session.chainRoot === id) session.chainRoot = null;
  rewritePlate(unlinked(state.plate.objects, id));
  flushEdit();
}

function withPivot(objects: PlateObject[], id: string, point: Vec3 | null): PlateObject[] {
  return refreshLinks(
    objects.map((row) => {
      if (row.id !== id) return row;
      if (!point || !usingCustomPivot(point, centreOf(row.sourcePos))) {
        const next = { ...row };
        delete next.pivot;
        return next;
      }
      return { ...row, pivot: [point[0], point[1], point[2]] as Vec3 };
    }),
    bedSize(),
  );
}

/** Write the pivot in source millimetres. Null resets it to the centre, which the file then omits. */
export function setObjectPivot(id: string, point: Vec3 | null) {
  if (!state.plate.objects.some((row) => row.id === id)) return;
  modelApi()?.commitModel();
  noteEdit();
  syncPlateFromState();
  rewritePlate(withPivot(state.plate.objects, id, point));
  flushEdit();
}

/** A pivot drag: the gesture around it owns the undo step. */
export function movePivot(id: string, point: Vec3) {
  if (!state.plate.objects.some((row) => row.id === id)) return;
  syncPlateFromState();
  state.plate = { ...state.plate, objects: withPivot(state.plate.objects, id, point) };
  applySelectedToState(state.plate);
  applyPlace(false);
}

/** A click on the bed, optionally snapped to a corner, the centre, or a vertex. */
export function placePivotAt(id: string, bedPoint: Vec3, snap: boolean) {
  const obj = state.plate.objects.find((row) => row.id === id);
  if (!obj) return;
  const source = bedToSourcePoint(obj.sourcePos, bedPoint, obj.orient, obj.partScale, obj.centered, obj.offset, state.profile.bedX, state.profile.bedY);
  const point = snap ? snapPivotPoint(obj.sourcePos, source, 8, obj.pivot ? [obj.pivot] : []) : source;
  setObjectPivot(id, point);
}

/** The three pivot fields. Empty clears a custom pivot. A half-filled row is left alone. */
export function notePivotTriple(raw: readonly [string, string, string]): boolean {
  const id = state.plate.selectedId;
  if (!id) return false;
  const trimmed = raw.map((value) => value.trim()) as [string, string, string];
  if (trimmed.every((value) => value === "")) {
    const obj = state.plate.objects.find((row) => row.id === id);
    if (!obj?.pivot) return false;
    setObjectPivot(id, null);
    return true;
  }
  if (trimmed.some((value) => value === "" || !Number.isFinite(Number(value)))) return false;
  setObjectPivot(id, [Number(trimmed[0]), Number(trimmed[1]), Number(trimmed[2])]);
  return true;
}
