/** The Undo and Redo buttons' state, and the edits overlay. */
import { closeModelTool, openModelTool, setModelWaiting } from "../../ui/model-chrome";
import { syncModelHistory, syncModelRecipe, syncTransitionStale } from "../../ui/model-history";
import { refreshPluginsPanel } from "../../ui/plugins-panel";
import { foldEndingAt, foldRedoFrom, recipeNote, stepLabel } from "../../model-history";
import { sketchHistoryButtons } from "../sketch";
import { modelTrees } from "../model-trees";
import { nextPlateStepName } from "../history";
import { session } from "../state";
import { bindParameterActions, syncRebuildCount } from "../../ui/parameters.ts";
import { stressOpen, stressUndoState, syncStress } from "../../ui/stress.ts";
import { splitPrintHistory } from "../../ui/split-print.ts";
import { MODEL_BUILDING, bindModelActionRepaint, bindModelHistoryLocal, modelActionsEnabled, modelActionsShownBusy, noteModelActions } from "./actions";
import { S } from "./shared";
import { treeOf } from "./edges";
import { canRemake, canUnmake } from "./history";
import { syncPosition } from "./place";
import { canSwapBack, syncPluginEnv } from "./plugins";
import { staleView } from "./transition";
import { redoNode, undoNode } from "./tree";

/** A solid's tools show in the rail only while a solid is open; New solid, Sketch and Check always do. */
export function showEdits(on: boolean) {
  let changed = false;
  for (const id of ["#railModel", "#railModelFoot"]) {
    const set = document.querySelector<HTMLElement>(id);
    if (!set || set.hasAttribute("data-no-solid") !== on) continue;
    set.toggleAttribute("data-no-solid", !on);
    changed = true;
  }
  // The rail has more or fewer tools: its folds are worked out again.
  if (changed) window.dispatchEvent(new Event("lime-rail"));
  if (!on) closeModelTool();
}

/** The building sentence on a button, or its own tip once the build is done. */
function paintBusyTip(button: HTMLButtonElement, tip: string, show: boolean) {
  if (show) {
    button.title = MODEL_BUILDING;
    button.dataset.tip = MODEL_BUILDING;
    return;
  }
  if (button.title === MODEL_BUILDING) button.removeAttribute("title");
  button.dataset.tip = tip;
}

/** Sheet ops and Rebuild follow the same show delay as Undo. Their handlers refuse at once. */
function paintLatchedActions() {
  const show = modelActionsShownBusy();
  for (const id of ["#modelSheetThickenGo", "#modelSheetSewGo"]) {
    const button = document.querySelector<HTMLButtonElement>(id);
    if (!button) continue;
    if (!button.dataset.tipIdle && button.dataset.tip && button.dataset.tip !== MODEL_BUILDING) button.dataset.tipIdle = button.dataset.tip;
    button.disabled = show;
    paintBusyTip(button, button.dataset.tipIdle ?? button.dataset.tip ?? "", show);
  }
  const params = document.querySelector<HTMLButtonElement>("#modelParamsRebuild");
  if (params) {
    if (show) {
      params.disabled = true;
      params.title = MODEL_BUILDING;
      params.dataset.tip = MODEL_BUILDING;
    } else if (params.title === MODEL_BUILDING) {
      params.disabled = false;
      params.removeAttribute("title");
      if (params.dataset.tip === MODEL_BUILDING) params.removeAttribute("data-tip");
    }
  }
  const plugin = document.querySelector<HTMLButtonElement>("#modelPluginRebuild");
  if (!plugin) return;
  if (show) {
    plugin.disabled = true;
    plugin.title = MODEL_BUILDING;
    plugin.dataset.tip = MODEL_BUILDING;
  } else if (plugin.title === MODEL_BUILDING) plugin.removeAttribute("title");
}

export function syncUndo() {
  noteModelActions();
  syncStress();
  const tree = treeOf(S.open);
  const undo = document.querySelector<HTMLButtonElement>("#modelUndo");
  const redo = document.querySelector<HTMLButtonElement>("#modelRedo");
  const placing = openModelTool() === "place";
  const framing = openModelTool() === "workplane";
  const show = modelActionsShownBusy();
  // While a step is edited, Cancel is the way back. A build shows as disabled only after it has lasted.
  const held = show || !tree || !!S.editing;
  const unmake = modelActionsEnabled() && !S.editing && (canUnmake() || canSwapBack("undo") || S.sculptHistory?.can("undo") === true);
  const remake = modelActionsEnabled() && !S.editing && (canRemake() || canSwapBack("redo") || S.sculptHistory?.can("redo") === true);
  // --- S2: Undo and Redo step the sketch while one is open. ---
  const sketchHist = sketchHistoryButtons();
  const stressHist = stressOpen() && !openModelTool() ? stressUndoState() : { undo: false, redo: false };
  const cardHist = splitPrintHistory();
  if (undo) {
    if (sketchHist) {
      undo.disabled = !sketchHist.undo;
      paintBusyTip(undo, "Undo the last sketch edit", false);
    } else if (cardHist) {
      undo.disabled = !cardHist.undo;
      paintBusyTip(undo, "Undo the last change to the cuts", false);
    } else if (stressHist.undo || stressHist.redo) {
      undo.disabled = !stressHist.undo;
      paintBusyTip(undo, "Undo the last hold or load", false);
    } else {
      undo.disabled = !(unmake && !placing && !framing) && (held || (placing ? S.placeUndo.length === 0 && !S.placeBefore : framing ? S.wpUndo.length === 0 && !S.wpBefore : undoNode(tree!) == null));
      paintBusyTip(undo, placing ? "Undo the last move" : framing ? "Undo the last workplane move" : "Undo the last solid edit", show);
    }
  }
  if (redo) {
    if (sketchHist) {
      redo.disabled = !sketchHist.redo;
      paintBusyTip(redo, "Redo the last sketch edit", false);
    } else if (cardHist) {
      redo.disabled = !cardHist.redo;
      paintBusyTip(redo, "Redo the last change to the cuts", false);
    } else if (stressHist.undo || stressHist.redo) {
      redo.disabled = !stressHist.redo;
      paintBusyTip(redo, "Redo the last hold or load", false);
    } else {
      redo.disabled = !(remake && !placing && !framing) && (held || (placing ? S.placeRedo.length === 0 : framing ? S.wpRedo.length === 0 : redoNode(tree!) == null));
      paintBusyTip(redo, placing ? "Redo the last move" : framing ? "Redo the last workplane move" : "Redo the last solid edit", show);
    }
  }
  const stepButton = document.querySelector<HTMLButtonElement>("#modelStep");
  if (stepButton) {
    if (!stepButton.dataset.tipIdle && stepButton.dataset.tip && stepButton.dataset.tip !== MODEL_BUILDING) stepButton.dataset.tipIdle = stepButton.dataset.tip;
    stepButton.disabled = show || !tree;
    paintBusyTip(stepButton, stepButton.dataset.tipIdle ?? stepButton.dataset.tip ?? "", show);
  }
  setModelWaiting(S.busy || S.jumping);
  syncModelHistory(tree, modelTrees, S.lens?.row ?? null);
  syncTransitionStale(staleView());
  // The Rebuild count is the shown branch's, so it follows History: another object, a new solid, a step added or dropped.
  syncRebuildCount();
  syncPosition();
  // --- A8. A recipe saved with this object, read-only under the History header. ---
  syncModelRecipe(S.open ? recipeNote(session.mcpModel, S.open.objectId) : null);
  syncPluginEnv();
  refreshPluginsPanel();
  paintLatchedActions();
}

bindModelActionRepaint(syncUndo);
bindModelHistoryLocal(() => !!(sketchHistoryButtons() || (stressOpen() && !openModelTool()) || splitPrintHistory()));
bindParameterActions(modelActionsEnabled);

/**
 * The name of the step Model's Undo or Redo would take, when that name is known.
 * An open sketch, a cut card, Stress, or a tool with its own stack is not the part's history, so this does not name the solid's step then.
 */
export function modelHistoryName(way: "undo" | "redo"): string | null {
  const sketch = sketchHistoryButtons();
  if (sketch) return sketch[way] ? "sketch" : null;
  if (canSwapBack(way)) return nextPlateStepName(way);
  if (splitPrintHistory()) return null;
  if (stressOpen() && !openModelTool() && (stressUndoState().undo || stressUndoState().redo)) return null;
  if (openModelTool() === "place" || openModelTool() === "workplane") return null;
  if (S.sculptHistory?.can(way)) return null;
  const tree = treeOf(S.open);
  if (!tree || S.busy || S.jumping || S.editing) return null;
  if (way === "undo") {
    const fold = foldEndingAt(tree, tree.current, modelTrees);
    if (fold?.label) return fold.label;
    if (undoNode(tree) == null) return null;
    const node = tree.nodes.get(tree.current);
    return node ? stepLabel(node) : null;
  }
  const fold = foldRedoFrom(tree, modelTrees);
  if (fold?.label) return fold.label;
  const next = redoNode(tree);
  if (next == null) return null;
  const node = tree.nodes.get(next);
  return node ? stepLabel(node) : null;
}
