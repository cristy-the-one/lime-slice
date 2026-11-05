/** Place: the typed and dragged moves of the open part, with their undo. */
import {
  IDENTITY_POSE,
  boxUnder,
  isIdentity,
  movedPose,
  placeFields,
  poseFromPlace,
  thenPose,
  type Affine,
  type ObjectFrame,
  type PlaceFields,
  type Turn,
} from "../../model-space";
import { lowestZ, settledPose, solidHull } from "../../model-settle";
import { settleOn } from "../../bed-rest-pref";
import { alignDelta, type AlignRelation } from "../../place-snap";
import { markProjectDirty } from "../../project-dirty";
import { contextParts } from "../../model-context";
import {
  openPlaceTool,
  openModelTool,
  refreshModelGhost,
  syncModelSolid,
  syncPlaceFields,
  type PlacePhase,
} from "../../ui/model-chrome";
import { syncModelPosition } from "../../ui/model-history";
import { lookPoseChanged } from "../../ui/model-look";
import { modelPoseOf, withFrame, withModelPose } from "../../plate";
import { livePlate } from "../files";
import { beginEdit, flushEdit, markModelEdit } from "../history";
import { fx } from "../fx";
import { session, state } from "../state";
import type { Params } from "../../modeling/expr.ts";
import { readAssemblies, resolveForParameters } from "../../assembly";
import { assemblyOfObject, followAssemblyMove, syncAssemblyView } from "../assemblies.ts";
import { S } from "./shared";
import { currentParams } from "./parameters";
import { PLACE_SETTLE_MS } from "./shared";
import { syncUndo } from "./undo";
import {
  boxOf,
  frameModel,
  modelDirection,
  objectPose,
  openBox,
  openPose,
  partsInView,
  pivotOf,
  refreshModelContext,
  viewFrame,
} from "./view";
import { openObject, sameMat } from "./workplane";

/**
 * Settle on the bed during a ring turn: the pose the rings hold, the settled pose shown for it, and the floor the turn
 * began on. While the part still shows `shown`, the next frame turns from `free`, as Prepare's held pose does.
 */
let settleHold: { free: Affine; shown: Affine; floor: number } | null = null;

/** --- Assemblies M10. A Ctrl-drag's start pose, when the part is open in its own frame, so the view's poses map back to model space. */
let grabFrom: Affine | null = null;

/** The turn the Place fields show for the open object, if they showed one. */
export function turnHint(): Turn | undefined {
  return S.open && S.shownTurn?.id === S.open.objectId ? S.shownTurn.turn : undefined;
}

/**
 * A Place field moved the open object in model space. Its plate pose, mesh, and slice stay as they are. With Settle on
 * the bed, a ring's turn snaps to the nearest rest face, as Prepare's rings do, and rests on the floor it began on.
 */
export function placeMoved(field: keyof PlaceFields, value: number, phase: PlacePhase) {
  const at = S.open;
  if (!at || S.busy || S.jumping) return;
  const from = objectPose();
  const pivot = pivotOf(at.solid);
  const turning = field === "rx" || field === "ry" || field === "rz";
  const ring = turning && phase !== "typed";
  const hold = ring && settleHold && samePose(settleHold.shown, from) ? settleHold : null;
  const base = hold ? hold.free : from;
  const near = turnHint();
  let next = poseFromPlace(base, pivot, field, value, near);
  if (turning) {
    const was = placeFields(base, pivot, near);
    S.shownTurn = { id: at.objectId, turn: { rx: was.rx, ry: was.ry, rz: was.rz, [field]: value } };
  }
  settleHold = null;
  const hull = ring && settleOn() ? solidHull(at.solid.positions) : null;
  if (hull) {
    const floor = hold ? hold.floor : lowestZ(hull, from);
    const settled = settledPose(hull, next, pivot, floor);
    if (phase !== "end") settleHold = { free: next, shown: settled.pose, floor };
    next = settled.pose;
  }
  // The ring wrote the angle it was held at; once let go, the fields read the pose it settled to.
  const settledEnd = !!hull && phase === "end";
  if (samePose(next, from)) {
    // A grab with no move, or a number retyped as it was, changes nothing and opens no step.
    if (phase === "end") endPlace();
    if (settledEnd) syncPlaceFields(true);
    return;
  }
  if (!S.placeBefore) {
    S.placeBefore = from;
    beginEdit();
  }
  putPose(at.objectId, next);
  window.clearTimeout(S.placeTimer);
  if (phase === "end") endPlace();
  else if (phase === "typed") S.placeTimer = window.setTimeout(endPlace, PLACE_SETTLE_MS);
  if (settledEnd) syncPlaceFields(true);
  syncUndo();
}

/** --- Assemblies M3. Each assembly that reads a changed parameter is solved again, and its members move in model space. */
export function followAssemblyPoses(before: Params) {
  if (session.assemblies.length === 0) return;
  const live = readAssemblies(session.assemblies, state.plate.objects);
  const followed = resolveForParameters(live, (id) => {
    const obj = state.plate.objects.find((item) => item.id === id);
    return obj ? modelPoseOf(obj) : undefined;
  }, before, currentParams());
  session.assemblies = followed.assemblies;
  if (followed.moved.length === 0) return;
  for (const { object, pose } of followed.moved) state.plate = withModelPose(state.plate, object, pose);
  syncAssemblyView();
  if (S.open && followed.moved.some((row) => row.object === S.open!.objectId)) {
    fx.model?.setPose(openPose());
    lookPoseChanged();
    refreshModelGhost();
  }
  refreshModelContext();
}

function putPose(objectId: string, pose: Affine) {
  const framed = !isIdentity(viewFrame());
  state.plate = withModelPose(state.plate, objectId, pose);
  // --- Assemblies M5. The root carries its assembly (D9); a member keeps where it was put, as its new offset.
  // --- M10. A part open in its own frame stays put, and the others move the opposite way.
  if (followAssemblyMove(objectId, pose) || framed || !isIdentity(viewFrame())) refreshModelContext();
  fx.model?.setPose(openPose());
  lookPoseChanged();
  refreshModelGhost();
  markProjectDirty();
}

/** A Place gesture is over: one step back for Undo here, and one Prepare step, folded into the visit like an edit. */
export function endPlace() {
  window.clearTimeout(S.placeTimer);
  const before = S.placeBefore;
  S.placeBefore = null;
  if (!before) return;
  flushEdit();
  if (!samePose(before, objectPose())) {
    S.placeUndo.push({ pose: before, frame: openObject()?.frame ?? "model" });
    S.placeRedo = [];
    markModelEdit();
  }
  syncUndo();
  // A turn changes the solid's model-space box, and with it which tools are on offer.
  syncModelSolid();
}

function samePose(a: Affine, b: Affine): boolean {
  return sameMat(a.t, b.t) && sameMat(a.m, b.m);
}

/** Undo or Redo one Place step. A gesture still settling becomes a step first, so Undo takes it back. */
export function placeStep(way: "undo" | "redo") {
  endPlace();
  const [from, to] = way === "undo" ? [S.placeUndo, S.placeRedo] : [S.placeRedo, S.placeUndo];
  const at = S.open;
  const step = from.pop();
  if (!at || !step) return;
  const frame = openObject()?.frame ?? "model";
  to.push({ pose: objectPose(), frame });
  beginEdit();
  if (step.frame !== frame) {
    state.plate = withFrame(state.plate, at.objectId, step.frame);
    frameShown();
  }
  if (!samePose(step.pose, objectPose())) putPose(at.objectId, step.pose);
  flushEdit();
  markModelEdit();
  syncPlaceFields(true);
  syncUndo();
}

/** Whether a Ctrl-drag on the open solid may start: a solid is open and settled, no step is edited, and none stands in for it. */
export function grabReady(): boolean {
  return !!S.open && !S.busy && !S.jumping && !S.editing && !S.lens;
}

/** The pointer has left the slop of a Ctrl-press: Place opens, and the whole grab is one step of it. */
export function grabStart(): boolean {
  if (!grabReady()) return false;
  openPlaceTool();
  if (openModelTool() !== "place") return false;
  endPlace();
  S.placeBefore = objectPose();
  grabFrom = isIdentity(viewFrame()) ? null : S.placeBefore;
  beginEdit();
  return true;
}

/** `pose` is in the view the grab started in: for a part open in its own frame, that is its pose when the grab began. */
export function grabMove(pose: Affine) {
  const at = S.open;
  if (!at || !S.placeBefore) return;
  putPose(at.objectId, grabFrom ? thenPose(pose, grabFrom) : pose);
  syncPlaceFields(true);
  syncUndo();
}

export function grabEnd() {
  endPlace();
  syncPlaceFields(true);
}

/** Esc: the pose goes back and the history gesture closes with nothing in it, so no step lands. */
export function grabCancel() {
  const at = S.open;
  const before = S.placeBefore;
  window.clearTimeout(S.placeTimer);
  S.placeBefore = null;
  if (!at || !before) return;
  putPose(at.objectId, before);
  flushEdit();
  syncPlaceFields(true);
  syncUndo();
}

/** Align to...: the open object lines up with another by `relation`, in model space, as one Place step. */
export function alignOpenTo(targetId: string, relation: AlignRelation): boolean {
  const at = S.open;
  if (!at || S.busy || S.jumping || S.editing || S.lens) return false;
  const moving = openBox();
  const target = partsInView(contextParts(livePlate(), at.objectId)).find((part) => part.id === targetId);
  if (!moving || !target) return false;
  const delta = alignDelta(moving, boxUnder(boxOf(target.positions), target.matrix), relation);
  if (!delta || delta.every((d) => d === 0)) return false;
  openPlaceTool();
  if (openModelTool() !== "place") return false;
  endPlace();
  S.placeBefore = objectPose();
  beginEdit();
  putPose(at.objectId, movedPose(objectPose(), modelDirection([delta[0], delta[1], delta[2]])));
  endPlace();
  syncPlaceFields(true);
  return true;
}

/** Place steps belong to the object they moved, in one Model visit. */
export function forgetPlaceSteps() {
  endPlace();
  S.placeUndo = [];
  S.placeRedo = [];
  settleHold = null;
}

/** --- Assemblies M11. The open part's frame, for the Place tool's switch: null for a part in no assembly. */
export function placeFrame(): ObjectFrame | null {
  const obj = openObject();
  return obj && assemblyOfObject(obj.id) ? obj.frame ?? "model" : null;
}

/**
 * The Place tool's switch: the open member's numbers move to `frame`, the field `model_place {frame}` sets, as one
 * Place step and one Prepare step. With M10, Model then draws the part in that frame and frames it.
 */
export function setPlaceFrame(frame: ObjectFrame) {
  const at = S.open;
  const now = placeFrame();
  if (!at || S.busy || S.jumping || S.editing || S.lens || now === null || now === frame) return;
  endPlace();
  beginEdit();
  S.placeUndo.push({ pose: objectPose(), frame: now });
  S.placeRedo = [];
  state.plate = withFrame(state.plate, at.objectId, frame);
  flushEdit();
  markModelEdit();
  frameShown();
  frameModel(false);
  syncUndo();
}

/** The open part's frame changed: the solid, the grey context and the ghost are drawn in the view it now has. */
function frameShown() {
  refreshModelContext();
  fx.model?.setPose(openPose());
  lookPoseChanged();
  refreshModelGhost();
  markProjectDirty();
  syncModelSolid();
}

/** The Position row, from the pose the plate object holds and the solid's own box, read once per solid. */
export function syncPosition() {
  const pose = objectPose();
  syncModelPosition(S.open ? placeFields(pose, pivotOf(S.open.solid), turnHint()) : null, isIdentity(pose), placeFrame());
}

/**
 * The Position row's Reset: back to where the file put the part, as one Place step, which Prepare undo takes back. It
 * goes through Place, which closes another tool or an edited step first: their checked numbers were for the old pose.
 */
export function resetPose() {
  const at = S.open;
  if (!at || S.busy || S.jumping || isIdentity(objectPose())) return;
  openPlaceTool();
  if (openModelTool() !== "place") return;
  endPlace();
  S.placeBefore = objectPose();
  beginEdit();
  putPose(at.objectId, IDENTITY_POSE);
  endPlace();
  syncPlaceFields(true);
}
