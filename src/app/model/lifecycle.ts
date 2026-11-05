/** Closing, leaving, and showing the Model view, and following the plate's selection. */
import { forgetFeatureContext } from "../../model-features";
import { closeOrder, jumped, nodeWithMesh } from "../../model-tree";
import { setModelLocked } from "../../ui/model-chrome";
import { resetModelLook } from "../../ui/model-look";
import { meshTokenOf } from "../../plate";
import { endModelVisit, flushEdit } from "../history";
import { closeSketchSession, forgetSketches } from "../sketch";
import { modelTrees } from "../model-trees";
import { refreshObjectList } from "../settings";
import { state } from "../state";
import { endStressPick } from "../../ui/stress.ts";
import { S } from "./shared";
import { commitModel } from "./commit";
import { showEmpty } from "./create";
import { treeOf } from "./edges";
import { dropEdit } from "./edit";
import { post } from "./engine";
import { writeSteps } from "./export";
import { readout } from "./pick";
import { forgetPlaceSteps } from "./place";
import {
  answers,
  engineHeld,
  previews,
  seedNotes,
  seeds,
  shaped,
  solids,
  stepKnown,
  surfacesOnly,
  toolOpens,
  unopened,
  writing,
} from "./shared";
import { clearView, openingStep, openTree, resume, rootSource, setTreeKey, stepOfCopy, treeFor } from "./tree";
import { syncUndo } from "./undo";
import { forgetWorkplaneSteps } from "./workplane";

/** Closes in flight, one at a time, and those the engine refused because a join still named the tree. */
let closing: Promise<void> = Promise.resolve();

const refusedCloses = new Set<string>();

/**
 * The engine keeps a tree a join takes its tool from, so trees close one at a time, each before its tools, in one
 * queue for every release. A close the engine refused, because a tree closing in a later release named it, goes again
 * after each later batch.
 */
export function closeInEngine(keys: readonly string[]): Promise<void> {
  closing = closing.then(async () => {
    for (const key of [...keys, ...refusedCloses]) {
      const body = await post({ call: "close", key });
      if (typeof body.error === "string" && body.error !== "unknown") refusedCloses.add(key);
      else refusedCloses.delete(key);
    }
  });
  return closing;
}

/** The solids and kernel answers kept for tree `key`. */
export function forgetShown(key: string) {
  for (const name of solids.keys()) if (name.startsWith(`${key}#`)) solids.delete(name);
  for (const name of answers.keys()) if (name.startsWith(`${key}#`)) answers.delete(name);
  for (const name of previews.keys()) if (name.startsWith(`${key}#`)) previews.delete(name);
}

/** Leaving Model: the plate takes the shown node, the visit is one Prepare step, and its solid is written off the UI's path. */
export function leaveModel() {
  endStressPick();
  // A face push or an edge size still being typed ends with Model, so its box does not stay behind.
  S.endPullDrag?.();
  S.edgeDrag?.end();
  // --- D40. A Check asked for and not yet open is dropped with the visit, so it cannot open on a later one.
  S.checkQueued = null;
  forgetPlaceSteps();
  forgetWorkplaneSteps();
  commitModel();
  dropEdit();
  // An open sketch is finished and kept as a card, so its keys and its view do not follow into Prepare.
  closeSketchSession();
  endModelVisit();
  void writeSteps();
  // Prepare's list notes a part split for an export target, which Model's steps decide.
  refreshObjectList();
}

/** The object whose View settings (section, colour by step) are showing. */
let lookObject: string | null = null;

/** --- D11. The View menu belongs to one object: another object starts it over. */
export function lookFor(objectId: string) {
  if (lookObject === objectId) return;
  lookObject = objectId;
  resetModelLook();
}

/** The file's plate is gone: so are its trees. */
export function forgetModelTrees() {
  lookObject = null;
  forgetFeatureContext();
  resetModelLook();
  void closeInEngine(closeOrder(modelTrees, modelTrees.keys()));
  S.plateEra += 1;
  modelTrees.clear();
  surfacesOnly.clear();
  toolOpens.clear();
  S.ghosted = null;
  S.joinSaid = "";
  seeds.clear();
  unopened.clear();
  seedNotes.clear();
  engineHeld.clear();
  solids.clear();
  answers.clear();
  previews.clear();
  shaped.clear();
  S.lens = null;
  setModelLocked(null);
  stepKnown.clear();
  writing.clear();
  dropEdit();
  forgetSketches();
  S.editBack = null;
  S.open = null;
  S.shownFor = null;
  S.framedFor = null;
  // The edit history went with the old plate, so a move still under way is dropped, not kept as a step.
  window.clearTimeout(S.placeTimer);
  S.placeBefore = null;
  forgetPlaceSteps();
  window.clearTimeout(S.wpTimer);
  S.wpBefore = null;
  forgetWorkplaneSteps();
  S.ticket += 1;
  S.busy = false;
  S.jumping = false;
  syncUndo();
}

/** A plate action changed the selection while Model is open: the view opens the selected object's solid. */
export function followSelection() {
  if (state.stage !== "model") return;
  const tree = treeOf(S.open);
  const foreign = !!tree && !!state.mesh && nodeWithMesh(tree, meshTokenOf(state.mesh.bytes)) == null;
  if (state.plate.selectedId !== S.shownFor || foreign) showModel();
}

export function showModel() {
  dropEdit();
  S.editBack = null;
  S.lens = null;
  setModelLocked(null);
  const mine = ++S.ticket;
  S.picks = [];
  S.busy = false;
  S.jumping = false;
  S.parked = null;
  const objectId = state.plate.selectedId;
  if (objectId !== S.shownFor) {
    forgetPlaceSteps();
    forgetWorkplaneSteps();
  }
  flushEdit();
  S.open = null;
  syncUndo();
  const mesh = state.mesh;
  S.shownFor = objectId;
  // --- D11. A mesh with no tree starts the View menu over too.
  if (objectId) lookFor(objectId);
  const obj = state.plate.objects.find((item) => item.id === objectId);
  const token = mesh ? meshTokenOf(mesh.bytes) : null;
  const known = objectId && token ? treeFor(objectId, obj?.modelTree, token) : null;
  const node = known && token ? nodeWithMesh(known, token) : null;
  if (objectId && known && node != null) {
    // The plate holds this node: Model resumes there, with the other branches kept and the open tool still open.
    modelTrees.set(known.key, { ...jumped(known, node), committed: node });
    if (obj?.modelTree !== known.key) setTreeKey(objectId, known.key);
    void resume(mine, objectId, known.key, openingStep(known, node));
    return;
  }
  clearView();
  if (!mesh || !objectId || !obj || !token) {
    showEmpty(false);
    return;
  }
  // A tree that has no node with this mesh stays open: a Prepare undo or redo can bring one of its meshes back.
  const source = rootSource({ fileName: mesh.name, bytes: mesh.bytes, sourcePos: state.sourcePos ?? new Float32Array(0), ...(obj.brep ? { brep: obj.brep } : {}) });
  if (!source) {
    showEmpty(true);
    return;
  }
  if ("from" in source) {
    void openTree(mine, objectId, obj.name, source.from, source.mesh);
    return;
  }
  void (async () => {
    readout("Reading the solid…");
    const step = await stepOfCopy(source);
    if (typeof step === "string") {
      if (mine === S.ticket) readout(step);
      return;
    }
    if (mine !== S.ticket) return;
    void openTree(mine, objectId, obj.name, step.from, step.mesh);
  })();
}
