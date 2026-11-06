/** History rows: made objects, jump, peek, lens, rename, and drop of a branch. */
import { toolPose, type ToolLink } from "../../model-edit";
import { decodeSolid, type ParsedSolid } from "../../model-reply";
import { dropped, subtree, withNode, type ModelTree, type NodeId } from "../../model-tree";
import { gotoRequest } from "../../model-request";
import { dropRefusal, readRow, rowStep, stepLabel, type RowKey } from "../../model-history";
import { newestEdits, redoUserEdit, undoUserEdit } from "../history";
import { modelTrees } from "../model-trees";
import { state } from "../state";
import { S } from "./shared";
import { brokenOnPath, failed, keepSolid, recentSolid } from "./apply";
import { nodeName, treeOf } from "./edges";
import { dropEdit } from "./edit";
import { dropInEngine, treeCall } from "./engine";
import { showModel } from "./lifecycle";
import { noteParametersBuilt } from "./parameters";
import { about, readout } from "./pick";
import { BROKEN, MADE_KEPT, type MadeObject, readSolids, seeds, solids, STILL_WORKING } from "./shared";
import { cutHeldAgain } from "./split-apply";
import { showNode, undoNode } from "./tree";
import { syncUndo } from "./undo";
import { objectPose, present, viewed } from "./view";
import { editRefusal, toolEditRefusal } from "../../model-edit";
import { rowKey } from "../../model-history";
import { isRepeatTool, repeatSourceIds, toggleRepeatSource } from "../../model-repeat";
import { recipesUnavailable } from "../../recipe/runtime";
import { openModelTool, openPlaceTool, syncModelChrome } from "../../ui/model-chrome";
import { mountModelHistory, paintRepeatSources } from "../../ui/model-history";
import { pluginAuthor } from "../../ui/plugins-panel";
import { fx } from "../fx";
import { takeEdgeStep } from "./edges";
import { startEdit } from "./edit";
import { exportPieceFiles, exportsRow } from "./export";
import { cancelPluginFacePick, plateSketches, startPluginFacePick } from "./pick";
import { resetPose } from "./place";
import { savePluginRow, useLibraryVersion } from "./plugin-panel";
import { rebuildPluginRow } from "./plugins";
import { keepStale, reaimStale } from "./transition";

let unmadeBatches: MadeObject[][] = [];

export function canUnmake(): boolean {
  const last = S.madeBatches.at(-1)?.at(-1);
  const tree = treeOf(S.open);
  const edits = newestEdits();
  return !!last && !!tree && S.open?.objectId === last.id && undoNode(tree) == null && !edits.pending && edits.undo === last.step;
}

export function canRemake(): boolean {
  const first = unmadeBatches.at(-1)?.[0];
  const edits = newestEdits();
  return !!first && !edits.pending && edits.redo === first.step;
}

export function newObjectStep(way: "undo" | "redo"): boolean {
  if (way === "undo" ? !canUnmake() : !canRemake()) return false;
  const batch = way === "undo" ? S.madeBatches.pop()! : unmadeBatches.pop()!;
  const moved: MadeObject[] = [];
  for (const made of way === "undo" ? [...batch].reverse() : batch) {
    const edits = newestEdits();
    if (edits.pending || (way === "undo" ? edits.undo : edits.redo) !== made.step) break;
    if (!(way === "undo" ? undoUserEdit() : redoUserEdit())) break;
    const after = newestEdits();
    if (way === "undo") moved.unshift({ id: made.id, step: after.redo });
    else moved.push({ id: made.id, step: after.undo });
  }
  if (moved.length > 0) (way === "undo" ? unmadeBatches : S.madeBatches).push(moved);
  showModel();
  return true;
}

export function noteMadeObject(id: string) {
  const made: MadeObject = { id, step: newestEdits().undo };
  unmadeBatches = [];
  if (S.makingBatch) S.makingBatch.push(made);
  else S.madeBatches = [...S.madeBatches, [made]].slice(-MADE_KEPT);
}

/** A row of the History panel: show that step. A jump still on its way to another step gives way to this one. */
export async function jumpTo(node: NodeId) {
  const at = S.open;
  const tree = treeOf(at);
  if (!at || !tree || S.busy || state.stage !== "model" || !tree.nodes.has(node)) return;
  if (S.jumping ? node === S.jumpTarget : node === tree.current && !S.editing && !S.lens) return;
  S.parked = null;
  S.editBack = null;
  // A step picked in the history ends an edit: the view goes there, not back.
  dropEdit();
  if (!(await showNode(S.ticket, at.objectId, at.key, node, about))) return;
  noteParametersBuilt();
  await cutHeldAgain(S.ticket);
}

/** The open solid's own step a History row names, or null for a tool's step. */
export function ownStep(row: RowKey): NodeId | null {
  const read = readRow(row);
  return read && read.via.length === 0 ? read.id : null;
}

/**
 * A tool's row in History: that step of the tool, read-only, where its joins put it, with the open solid grey behind it
 * as it was on screen. Nothing on the plate, in the open solid's history, or in the tool's own tree moves.
 */
export async function peekTool(row: RowKey) {
  const at = S.open;
  const tree = treeOf(at);
  if (!at || !tree || S.busy || state.stage !== "model" || (S.lens?.row === row && !S.editing)) return;
  const step = rowStep(modelTrees, tree, row);
  if (!step) return;
  S.parked = null;
  S.editBack = null;
  dropEdit();
  const join = step.joins.at(-1)!;
  await showLens(S.ticket, row, step, (solid) => `“${stepLabel(step.tree.nodes.get(step.id)!)}” of ${join.op.tool.name}, as “${stepLabel(join.tree.nodes.get(join.id)!)}” takes it. ${about(solid)} Edit step changes it.`);
}

/** Show step `step.id` of a tool's tree in place of the open solid, from the recent solids or the engine. The newest jump wins. */
export async function showLens(mine: number, row: RowKey, step: { tree: ModelTree; id: NodeId; joins: ToolLink[] }, message: (solid: ParsedSolid) => string): Promise<boolean> {
  const key = step.tree.key;
  // A jump still on its way gives way to this one, even when this one needs no engine call.
  const serial = ++S.jumpSerial;
  if (brokenOnPath(step.tree, step.id)) {
    readout(BROKEN);
    return false;
  }
  const chord = state.stepTolerance;
  let solid: ParsedSolid | null = recentSolid(key, step.id, chord) ?? null;
  const seed = seeds.get(key);
  if (solid && readSolids.has(solid) && !(seed?.live && !seed.whole)) solid = null;
  if (!solid) {
    S.jumping = true;
    S.jumpTarget = null;
    syncUndo();
    const body = await treeCall(key, step.id, gotoRequest(key, step.id, chord));
    const newest = mine === S.ticket && serial === S.jumpSerial;
    if (newest) S.jumping = false;
    syncUndo();
    if (mine !== S.ticket || state.stage !== "model") return false;
    const decoded = failed(key, body) ? null : decodeSolid(body);
    if (typeof decoded === "string") readout(decoded);
    if (!decoded || typeof decoded === "string") return false;
    if (body.seeded) readSolids.add(decoded);
    keepSolid(key, step.id, chord, decoded);
    if (!newest) return false;
    solid = decoded;
  }
  if (!S.open || state.stage !== "model") return false;
  S.jumping = false;
  present(solid, message(solid), { row, key, node: step.id, joins: step.joins, pose: toolPose(objectPose(), step.joins), solid });
  return true;
}

/** A row's step renamed: the open solid's, or a tool's, which is the same step in the tool object's own History. */
export function renameStep(row: RowKey, name: string) {
  const tree = treeOf(S.open);
  const step = tree ? rowStep(modelTrees, tree, row) : null;
  const node = step?.tree.nodes.get(step.id);
  if (!step || !node || (node.name ?? "") === name) return;
  modelTrees.set(step.tree.key, withNode(step.tree, step.id, { name: name || undefined }));
  syncUndo();
}

/** Why the branch from a row's step stays, or null. A tool's step is on the way to the step its join takes, so it always stays. */
export function whyKeepBranch(row: RowKey): string | null {
  const tree = treeOf(S.open);
  if (!tree) return "This solid is no longer open.";
  if (S.busy || S.jumping) return STILL_WORKING;
  const step = rowStep(modelTrees, tree, row);
  if (!step) return "This step is no longer in the history.";
  const join = step.joins[0];
  if (join) return `This step makes ${step.joins.at(-1)!.op.tool.name} as “${stepLabel(join.tree.nodes.get(join.id)!)}” takes it. Delete the branch from that step instead.`;
  // The step being edited (for a tool's step, the join on the way to it) and the step Cancel goes back to count as on screen.
  const run = S.editing?.target === tree.key ? S.editing : null;
  const gone = run ? subtree(tree, step.id) : null;
  if (gone && run && (gone.has(run.joins[0]?.id ?? run.node) || gone.has(run.from))) return "The step being edited, or the one Cancel goes back to, is on this branch. Update or cancel the edit first.";
  return dropRefusal(tree, step.id, modelTrees);
}

/** Delete the branch from a row's step down, here and in the engine. A refusal goes to the readout. */
export function dropBranch(row: RowKey): boolean {
  const at = S.open;
  const tree = treeOf(at);
  const refusal = whyKeepBranch(row);
  const node = ownStep(row);
  const next = tree && !refusal && node != null ? dropped(tree, node) : null;
  if (!at || !tree || !next || node == null) {
    readout(refusal ?? "This branch cannot be deleted.");
    return false;
  }
  for (const id of subtree(tree, node)) {
    for (const name of solids.keys()) if (name.startsWith(`${nodeName(at.key, id)}@`)) solids.delete(name);
  }
  const looked = S.lens && !next.nodes.has(S.lens.joins[0]!.id);
  modelTrees.set(at.key, next);
  void dropInEngine(at.key, node);
  // The tool's step looked at went with its join: the part comes back.
  if (looked) present(at.solid, about(at.solid));
  syncUndo();
  readout(about(viewed() ?? at.solid));
  return true;
}

export function bindHistory() {
  mountModelHistory({
    jump(row) {
      // --- A5. While Fillet or Chamfer takes a step's edges, a history row chooses that step. ---
      if (takeEdgeStep(row)) return;
      const step = ownStep(row);
      if (step != null) void jumpTo(step);
      else void peekTool(row);
    },
    rename: renameStep,
    dropRefusal: whyKeepBranch,
    drop: dropBranch,
    editRefusal(row) {
      const tree = treeOf(S.open);
      const step = tree ? rowStep(modelTrees, tree, row) : null;
      if (!step) return "This step is no longer in the history.";
      return step.joins.length === 0 ? editRefusal(step.tree, step.id) : toolEditRefusal(step.tree, step.joins, step.id);
    },
    edit(row) {
      // Shift+E away from History edits the step shown; while an edit is open that is its parent, so the key waits.
      const tree = treeOf(S.open);
      if (row != null) void startEdit(row);
      else if (tree && !S.editing) void startEdit(S.lens?.row ?? rowKey([], tree.current));
    },
    exportable: exportsRow,
    exportPieces: (row) => void exportPieceFiles(row),
    openPlace: openPlaceTool,
    resetPosition: resetPose,
    // --- A10. Hovering or focusing a row tints the faces that step made.
    highlight(id) {
      fx.model?.setStepHighlight(id);
    },
    // --- Print transitions (decision 5): the note's Re-aim and Keep.
    reaim: () => void reaimStale(),
    keepPose: () => keepStale(S.open?.objectId ?? null),
    // --- Plugin steps (milestone 6): a plugin step's values change in the card and rebuild here.
    pluginRunner: recipesUnavailable,
    async pluginRebuild(row, changes, edited) {
      const next = await rebuildPluginRow(row, changes, edited);
      return next ? { row: next } : { reason: S.readoutText || "The step was not rebuilt." };
    },
    pluginSketches: () => plateSketches(),
    pluginPickFace: (done) => startPluginFacePick(done),
    pluginCancelPick: () => cancelPluginFacePick(false),
    // --- Milestone 7: Use vN from the library, Save as plugin… for a draft, and the author the dialog starts with.
    async pluginUseVersion(row) {
      const next = await useLibraryVersion(row);
      return next ? { row: next } : { reason: S.readoutText || "The step was not rebuilt." };
    },
    pluginSave: (row, words) => savePluginRow(row, words),
    pluginAuthor,
    // --- A4. Ctrl-click adds or removes a step of this solid. A tool's step is not one of those. ---
    picking: () => isRepeatTool(openModelTool()) && !S.lens,
    pickSource(row) {
      if (!isRepeatTool(openModelTool())) return false;
      const parsed = readRow(row);
      if (!parsed || parsed.via.length !== 0) {
        readout("A pattern repeats a step of this solid.");
        return true;
      }
      toggleRepeatSource(parsed.id);
      paintRepeatSources(repeatSourceIds());
      syncModelChrome(S.picks);
      return true;
    },
  });
}
