/** Opening a tree and showing a node: the open, resume, and step (undo/redo) paths. */
import { IDENTITY_POSE } from "../../model-space";
import { olderSplitNote } from "../../model-edit";
import { decodeSolid, type ParsedSolid } from "../../model-reply";
import {
  ROOT,
  jumped,
  newTree,
  nodeWithMesh,
  pathTo,
  rootLabel,
  withNode,
  type ModelRoot,
  type ModelTree,
  type NodeId,
  type PlateMesh,
} from "../../model-tree";
import { gotoRequest, openRequest } from "../../model-request";
import { setModelLocked, syncModelChrome } from "../../ui/model-chrome";
import { pluginStepTitle } from "../../ui/model-history";
import { foldEndingAt, foldRedoFrom, foldedRedoTarget, foldedUndoTarget } from "../../model-history";
import { meshTokenOf } from "../../plate";
import { fx } from "../fx";
import { freshTreeKey, modelTrees } from "../model-trees";
import { isStepName } from "../settings";
import { setInspectVolume } from "../../ui/model-inspect";
import { state } from "../state";
import { endStressPick } from "../../ui/stress.ts";
import { exportsPieces } from "../../split-print.ts";
import { S } from "./shared";
import { brokenOnPath, failed, keepSolid, recentSolid } from "./apply";
import { hideEmpty } from "./create";
import { treeOf } from "./edges";
import { noteHeld, post, treeCall } from "./engine";
import { exportSolid, putStep, stepFileName } from "./export";
import { newObjectStep } from "./history";
import { lookFor } from "./lifecycle";
import { noteParametersBuilt } from "./parameters";
import { about, readout } from "./pick";
import { swapStep } from "./plugins";
import { BROKEN, readSolids, ROOT_BROKEN, seedNotes, seeds, stepKnown, surfacesOnly } from "./shared";
import { cutHeldAgain } from "./split-apply";
import { showEdits, syncUndo } from "./undo";
import { present, refreshModelContext } from "./view";

type OpenFrom = { from: Exclude<ModelRoot, { kind: "piece" }>; mesh: PlateMesh };

/**
 * What a new tree for a plate mesh opens from: a copy of a new solid's root from the same primitive, even once that root
 * has a STEP; a STEP, the object's own or the file; or, for a copy of an edited object whose STEP is not written yet,
 * the step it copies, whose STEP `stepOfCopy` writes first. Null for a mesh, which Model does not edit.
 */
export function rootSource(of: { fileName: string; bytes: ArrayBuffer; sourcePos: Float32Array; brep?: ArrayBuffer }): OpenFrom | { copies: { key: string; node: NodeId }; mesh: PlateMesh } | null {
  const token = meshTokenOf(of.bytes);
  const mesh: PlateMesh = { name: of.fileName, bytes: of.bytes, sourcePos: of.sourcePos, token, ...(of.brep ? { step: of.brep } : {}) };
  const source = [...modelTrees.values()].find((tree) => nodeWithMesh(tree, token) != null);
  if ((source?.root.kind === "primitive" || source?.root.kind === "feature") && nodeWithMesh(source, token) === ROOT) return { from: source.root, mesh };
  if (of.brep || isStepName(of.fileName)) return { from: { kind: "step", name: of.brep ? stepFileName(of.fileName) : of.fileName, bytes: of.brep ?? of.bytes }, mesh };
  return source ? { copies: { key: source.key, node: nodeWithMesh(source, token)! }, mesh } : null;
}

/** A copy's root: the solid of the step it copies, written now and given to every object with that mesh. */
export async function stepOfCopy({ copies, mesh }: { copies: { key: string; node: NodeId }; mesh: PlateMesh }): Promise<OpenFrom | string> {
  const step = await exportSolid(copies.key, copies.node, "brep");
  if (typeof step === "string") return step;
  putStep(mesh.token, step);
  return { from: { kind: "step", name: stepFileName(mesh.name), bytes: step }, mesh: { ...mesh, step } };
}

/**
 * The object's tree that holds a node with the plate's mesh. A Prepare undo to before the object's
 * first Model visit restores a plate without the key, so the object's other trees are searched too.
 */
export function treeFor(objectId: string, key: string | undefined, token: string): ModelTree | null {
  const named = key ? modelTrees.get(key) : undefined;
  if (named && nodeWithMesh(named, token) != null) return named;
  for (const tree of modelTrees.values()) {
    if (tree.key.startsWith(`${objectId}#`) && nodeWithMesh(tree, token) != null) return tree;
  }
  return null;
}

export function setTreeKey(objectId: string, key: string) {
  state.plate = {
    ...state.plate,
    objects: state.plate.objects.map((obj) => (obj.id === objectId ? { ...obj, modelTree: key } : obj)),
  };
}

/**
 * --- D12. The step Model opens on for a part whose plate step is `node`: that one, unless the part's latest step, the end
 * of Redo from there, is a split to print for an export target. The plate keeps the part whole, and that split's pieces
 * are only in Model, so Model opens on it.
 */
export function openingStep(tree: ModelTree, node: NodeId): NodeId {
  let end = node;
  for (let next = tree.lastChild.get(end); next != null && tree.nodes.has(next); next = tree.lastChild.get(end)) end = next;
  return end !== node && exportsPieces(tree.nodes.get(end)?.op) ? end : node;
}

/** Back into Model on the node the plate holds, or `openingStep`'s. If it no longer rebuilds, on the last step above it that does. */
export async function resume(mine: number, objectId: string, key: string, node: NodeId) {
  // A split piece whose part was edited past its split keeps a note of it: the piece is the older split's.
  const known = modelTrees.get(key);
  const older = known ? olderSplitNote(modelTrees, known) : null;
  const greeting = (solid: ParsedSolid) => `${about(solid)} ${older ? `${older} ` : ""}Pick a face or an edge.`;
  if (await showNode(mine, objectId, key, node, greeting)) {
    await cutHeldAgain(mine);
    return;
  }
  if (mine !== S.ticket) return;
  const tree = modelTrees.get(key);
  const good = tree ? lastGood(tree, node) : null;
  if (good != null && good !== node && (await showNode(mine, objectId, key, good, (solid) => `${BROKEN} ${greeting(solid)}`))) {
    // The plate's mesh of the broken step is still good: it stays until an edit or a jump here.
    S.parked = key;
    return;
  }
  if (mine === S.ticket) clearView();
}

/** The deepest node on the way to `node` that is not marked broken. */
export function lastGood(tree: ModelTree, node: NodeId): NodeId | null {
  let good: NodeId | null = null;
  for (const id of pathTo(tree, node)) {
    if (tree.nodes.get(id)?.broken) break;
    good = id;
  }
  return good;
}

export function clearView() {
  S.lens = null;
  setModelLocked(null);
  hideEmpty();
  fx.model?.setSolid(null, IDENTITY_POSE);
  setInspectVolume("—");
  refreshModelContext();
  fx.model?.highlight([]);
  syncModelChrome([]);
  showEdits(false);
}

export function setMode(mode: "face" | "edge") {
  if (mode === "edge") endStressPick();
  fx.model?.setPickMode(mode);
  S.picks = [];
  fx.model?.highlight([]);
  // The buttons first: the Split panel's note reads which one is on.
  document.querySelector("#modelPickFace")?.setAttribute("aria-pressed", mode === "face" ? "true" : "false");
  document.querySelector("#modelPickFace")?.classList.toggle("on", mode === "face");
  document.querySelector("#modelPickEdge")?.setAttribute("aria-pressed", mode === "edge" ? "true" : "false");
  document.querySelector("#modelPickEdge")?.classList.toggle("on", mode === "edge");
  syncModelChrome([]);
  if (S.open) readout(`${about(S.open.solid)} Pick ${mode === "face" ? "a face" : "an edge"}.`);
}

/** Open the file's solid, or a copied new solid's primitive, as the root of a new tree for the plate object, and show it. */
export async function openTree(mine: number, objectId: string, label: string, from: Exclude<ModelRoot, { kind: "piece" }>, root: PlateMesh) {
  readout("Reading the solid…");
  const started = await startTree(objectId, label, from, root);
  if (typeof started === "string") {
    if (mine === S.ticket && state.stage === "model") readout(started);
    return;
  }
  keepSolid(started.key, ROOT, state.stepTolerance, started.parsed);
  if (mine !== S.ticket || state.stage !== "model") return;
  S.open = { objectId, key: started.key, solid: started.parsed };
  lookFor(objectId);
  present(started.parsed, `${about(started.parsed)} Pick a face or an edge.`);
}

/**
 * A new tree for the plate object, rooted in `from`: the object then carries its key. A shown object and a join's tool
 * both start here. An open that lands after the plate was replaced leaves nothing behind.
 */
export async function startTree(objectId: string, label: string, from: Exclude<ModelRoot, { kind: "piece" }>, root: PlateMesh): Promise<{ key: string; parsed: ParsedSolid } | string> {
  const key = freshTreeKey(objectId);
  const era = S.plateEra;
  const body = await post(openRequest(key, from, state.stepTolerance));
  const parsed = decodeSolid(body);
  if (typeof parsed === "string" || era !== S.plateEra) {
    // An open the engine answered but this app cannot read, or no longer wants, still left a tree there.
    if (typeof body.error !== "string") void post({ call: "close", key });
    return typeof parsed === "string" ? parsed : "This solid is no longer open.";
  }
  modelTrees.set(key, withNode(newTree(key, from, rootLabel(from, label), parsed.fingerprint), ROOT, { mesh: root }));
  noteHeld(key, body);
  if (from.kind === "step" || root.step) stepKnown.add(root.token);
  if (!parsed.editable) surfacesOnly.add(root.token);
  setTreeKey(objectId, key);
  return { key, parsed };
}

/**
 * Show `node` of the open tree: from the recent solids when it is there, else from the engine. The
 * latest jump wins: an older one's late reply is kept for later and not shown.
 */
export async function showNode(mine: number, objectId: string, key: string, node: NodeId, message: (solid: ParsedSolid) => string): Promise<boolean> {
  const tree = modelTrees.get(key);
  if (!tree) return false;
  const serial = ++S.jumpSerial;
  if (brokenOnPath(tree, node)) {
    S.jumping = false;
    syncUndo();
    readout(tree.nodes.get(ROOT)?.broken ? ROOT_BROKEN : BROKEN);
    return false;
  }
  const chord = state.stepTolerance;
  let solid: ParsedSolid | null = recentSolid(key, node, chord) ?? null;
  const seed = seeds.get(key);
  if (solid && readSolids.has(solid) && !(seed?.live && !seed.whole)) solid = null;
  if (!solid) {
    S.jumping = true;
    S.jumpTarget = node;
    syncUndo();
    const body = await treeCall(key, node, gotoRequest(key, node, chord));
    const newest = mine === S.ticket && serial === S.jumpSerial;
    if (newest) S.jumping = false;
    syncUndo();
    if (mine !== S.ticket || state.stage !== "model") return false;
    if (!newest) {
      const late = modelTrees.get(key)?.nodes.has(node) ? decodeSolid(body) : null;
      if (late && typeof late !== "string") {
        if (body.seeded) readSolids.add(late);
        keepSolid(key, node, chord, late);
      }
      return false;
    }
    if (failed(key, body)) return false;
    const decoded = decodeSolid(body);
    if (typeof decoded === "string") {
      readout(decoded);
      return false;
    }
    solid = decoded;
    if (body.seeded) readSolids.add(solid);
    keepSolid(key, node, chord, solid);
  }
  S.jumping = false;
  const latest = modelTrees.get(key);
  if (!latest) return false;
  modelTrees.set(key, jumped(latest, node));
  S.open = { objectId, key, solid };
  lookFor(objectId);
  const note = seedNotes.get(key);
  seedNotes.delete(key);
  present(solid, note ? `${message(solid)} ${note}` : message(solid));
  return true;
}

/** Where Undo goes: from an edit's tip, back to the step shown before the edit; from the last step of a folded composite, to the step before it; else the parent. */
export function undoNode(tree: ModelTree): NodeId | null {
  const back = S.editBack;
  if (back && !back.undone && back.key === tree.key && tree.current === back.tip && tree.nodes.has(back.back)) return back.back;
  return foldedUndoTarget(tree, modelTrees);
}

/** Where Redo goes: from where an undone edit went back to, forward to its tip again; through a folded composite, to its last step; else the child Redo follows. */
export function redoNode(tree: ModelTree): NodeId | null {
  const back = S.editBack;
  if (back?.undone && back.key === tree.key && tree.current === back.back && tree.nodes.has(back.tip)) return back.tip;
  return foldedRedoTarget(tree, modelTrees);
}

/** Undo is the parent, Redo the child last applied or jumped through, but for an edit, which Undo takes back whole. */
export async function step(way: "undo" | "redo") {
  if (!S.busy && !S.jumping && !S.editing && !S.sketchRootEdit && (swapStep(way) || newObjectStep(way))) return;
  const at = S.open;
  const tree = treeOf(at);
  const node = tree ? (way === "undo" ? undoNode(tree) : redoNode(tree)) : null;
  if (!at || !tree || node == null || S.busy || S.jumping || S.editing || S.sketchRootEdit) return;
  S.parked = null;
  const back = S.editBack;
  const viaEdit = !!back && node === (way === "undo" ? back.back : back.tip) && tree.current === (way === "undo" ? back.tip : back.back) && back.undone === (way === "redo");
  if (!viaEdit) S.editBack = null;
  // --- A8. One undo from the last step of a folded composite, and one redo, take the whole run. ---
  const undone = !viaEdit && way === "undo" ? foldEndingAt(tree, tree.current, modelTrees, pluginStepTitle) : null;
  const redone = !viaEdit && way === "redo" ? foldRedoFrom(tree, modelTrees, pluginStepTitle) : null;
  const viaFold = (!!undone && node === undone.before) || (!!redone && node === redone.last);
  const foldLabel = undone?.label ?? redone?.label;
  const done = viaEdit ? (way === "undo" ? "Edit of the step undone." : "Edit of the step redone.") : viaFold && foldLabel ? `${foldLabel} ${way === "undo" ? "undone" : "redone"}.` : way === "undo" ? "Edit undone." : "Edit redone.";
  const shown = await showNode(S.ticket, at.objectId, at.key, node, (solid) => `${about(solid)} ${done}`);
  if (shown && viaEdit && S.editBack === back) back!.undone = way === "undo";
  if (!shown) return;
  syncUndo();
  // The shown branch changed, so the Rebuild count does too.
  noteParametersBuilt();
}
