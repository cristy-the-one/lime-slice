/** Workplane: the open part's work plane, its moves, and their undo. */
import { type Mat3 } from "../../mesh-place";
import { applyPose, isIdentity, turnDir } from "../../model-space";
import { markProjectDirty } from "../../project-dirty";
import { lastFace } from "../../model-blend";
import { type FacePlane } from "../../model-plane";
import { syncWorkplaneFields, type PlacePhase } from "../../ui/model-chrome";
import { withWorkplane, type PlateObject } from "../../plate";
import { place } from "../files";
import { beginEdit, flushEdit, markModelEdit } from "../history";
import { state } from "../state";
import {
  isGlobalFrame,
  printOrient,
  sameWorkplane,
  workplaneIn,
  workplaneOnFace,
  workplaneOwn,
  type Workplane,
} from "../../workplane";
import { S } from "./shared";
import { flatFace } from "./geometry";
import { PLACE_SETTLE_MS, type WorkplaneStep } from "./shared";
import { syncUndo } from "./undo";
import { openPose, shownPose } from "./view";

export function openObject(): PlateObject | undefined {
  const at = S.open;
  return at ? state.plate.objects.find((item) => item.id === at.objectId) : undefined;
}

/** The open object while it is also the plate's selected one, whose orient `state.orient` is. */
export function plateObjectOpen(): PlateObject | undefined {
  const obj = openObject();
  return obj && obj.id === state.plate.selectedId ? obj : undefined;
}

/** The open object's workplane in model space: the frame it keeps in its own frame, at its pose. */
export function workplaneOfOpen(): Workplane {
  const obj = openObject();
  return workplaneIn(obj?.workplane, shownPose());
}

/**
 * The frame on the last picked face, in model space. Its U and V are worked out from the face in the part's own frame,
 * so they run along the part's own axes however the part is turned. A curved face is refused; no face is null.
 */
export function faceWorkplane(): Workplane | "curved" | null {
  const face = lastFace(S.picks);
  const at = S.open;
  if (!at || face == null) return null;
  const own = flatFace(at.solid, face);
  return own ? workplaneIn(workplaneOnFace(own), shownPose()) : "curved";
}

/** A flat face of the open solid, from its own frame into model space. */
export function posedFace(own: FacePlane | null): FacePlane | null {
  const pose = openPose();
  return own && !isIdentity(pose) ? { point: applyPose(pose, own.point), normal: turnDir(pose, own.normal) } : own;
}

export function sameMat(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function workplaneNow(): WorkplaneStep {
  const plane = openObject()?.workplane;
  return { plane, orient: [...state.orient] as Mat3 };
}

function sameStep(a: WorkplaneStep, b: WorkplaneStep): boolean {
  return (a.plane && b.plane ? sameWorkplane(a.plane, b.plane) : a.plane === b.plane) && sameMat(a.orient, b.orient);
}

/** The Workplane panel moved the open object's frame, given in model space. Neither the plate nor the slice changes. */
export function workplaneMoved(plane: Workplane, phase: PlacePhase) {
  const at = S.open;
  if (!at || S.busy || S.jumping) return;
  if (sameWorkplane(plane, workplaneOfOpen())) {
    if (phase === "end") endWorkplane();
    return;
  }
  startWorkplane();
  // Global is model space whatever the part's pose: not stored, so it stays model space after a Place.
  state.plate = withWorkplane(state.plate, at.objectId, isGlobalFrame(plane) ? undefined : workplaneOwn(plane, shownPose()));
  markProjectDirty();
  window.clearTimeout(S.wpTimer);
  if (phase === "end") endWorkplane();
  else if (phase === "typed") S.wpTimer = window.setTimeout(endWorkplane, PLACE_SETTLE_MS);
  syncUndo();
}

function startWorkplane() {
  if (S.wpBefore) return;
  S.wpBefore = workplaneNow();
  beginEdit();
}

/**
 * Print with W up: the part turns on the plate so its workplane's W points up and U runs along X, as Prepare's Lay
 * flat turns it, one step for Undo here and in Prepare. The frame itself does not move.
 */
export function printWUp() {
  const obj = plateObjectOpen();
  if (!obj || S.busy || S.jumping) return;
  const orient = printOrient(obj.workplane);
  if (sameMat(state.orient, orient)) return;
  endWorkplane();
  startWorkplane();
  state.orient = orient;
  place();
  endWorkplane();
}

/** A workplane gesture is over: one step back for Undo here, and one Prepare step, folded into the visit like an edit. */
export function endWorkplane() {
  window.clearTimeout(S.wpTimer);
  const before = S.wpBefore;
  S.wpBefore = null;
  if (!before) return;
  flushEdit();
  if (!sameStep(before, workplaneNow())) {
    S.wpUndo.push(before);
    S.wpRedo = [];
    markModelEdit();
  }
  syncUndo();
}

/** Undo or Redo one workplane step. A gesture still settling becomes a step first, so Undo takes it back. */
export function workplaneStep(way: "undo" | "redo") {
  endWorkplane();
  const [from, to] = way === "undo" ? [S.wpUndo, S.wpRedo] : [S.wpRedo, S.wpUndo];
  const at = S.open;
  const step = from.pop();
  if (!at || !step) return;
  to.push(workplaneNow());
  beginEdit();
  state.plate = withWorkplane(state.plate, at.objectId, step.plane);
  markProjectDirty();
  if (!sameMat(step.orient, state.orient)) {
    state.orient = [...step.orient] as Mat3;
    place();
  }
  flushEdit();
  markModelEdit();
  syncWorkplaneFields(true);
  syncUndo();
}

/** Workplane steps belong to the object they moved, in one Model visit. */
export function forgetWorkplaneSteps() {
  endWorkplane();
  S.wpUndo = [];
  S.wpRedo = [];
}
