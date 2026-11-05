/** The Undo and Redo buttons' state, and the edits overlay. */
import { closeModelTool, openModelTool, setModelWaiting } from "../../ui/model-chrome";
import { syncModelHistory, syncModelRecipe, syncTransitionStale } from "../../ui/model-history";
import { refreshPluginsPanel } from "../../ui/plugins-panel";
import { recipeNote } from "../../model-history";
import { sketchHistoryButtons } from "../sketch";
import { modelTrees } from "../model-trees";
import { session } from "../state";
import { syncRebuildCount } from "../../ui/parameters.ts";
import { stressOpen, stressUndoState, syncStress } from "../../ui/stress.ts";
import { splitPrintHistory } from "../../ui/split-print.ts";
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

export function syncUndo() {
  syncStress();
  const tree = treeOf(S.open);
  const undo = document.querySelector<HTMLButtonElement>("#modelUndo");
  const redo = document.querySelector<HTMLButtonElement>("#modelRedo");
  const placing = openModelTool() === "place";
  const framing = openModelTool() === "workplane";
  // While a step is edited, Cancel is the way back.
  const held = S.busy || S.jumping || !tree || !!S.editing;
  const unmake = !S.busy && !S.jumping && !S.editing && (canUnmake() || canSwapBack("undo"));
  const remake = !S.busy && !S.jumping && !S.editing && (canRemake() || canSwapBack("redo"));
  // --- S2: Undo and Redo step the sketch while one is open. ---
  const sketchHist = sketchHistoryButtons();
  const stressHist = stressOpen() && !openModelTool() ? stressUndoState() : { undo: false, redo: false };
  const cardHist = splitPrintHistory();
  if (undo) {
    if (sketchHist) {
      undo.disabled = !sketchHist.undo;
      undo.dataset.tip = "Undo the last sketch edit";
    } else if (cardHist) {
      undo.disabled = !cardHist.undo;
      undo.dataset.tip = "Undo the last change to the cuts";
    } else if (stressHist.undo || stressHist.redo) {
      undo.disabled = !stressHist.undo;
      undo.dataset.tip = "Undo the last hold or load";
    } else {
      undo.disabled = !(unmake && !placing && !framing) && (held || (placing ? S.placeUndo.length === 0 && !S.placeBefore : framing ? S.wpUndo.length === 0 && !S.wpBefore : undoNode(tree!) == null));
      undo.dataset.tip = placing ? "Undo the last move" : framing ? "Undo the last workplane move" : "Undo the last solid edit";
    }
  }
  if (redo) {
    if (sketchHist) {
      redo.disabled = !sketchHist.redo;
      redo.dataset.tip = "Redo the last sketch edit";
    } else if (cardHist) {
      redo.disabled = !cardHist.redo;
      redo.dataset.tip = "Redo the last change to the cuts";
    } else if (stressHist.undo || stressHist.redo) {
      redo.disabled = !stressHist.redo;
      redo.dataset.tip = "Redo the last hold or load";
    } else {
      redo.disabled = !(remake && !placing && !framing) && (held || (placing ? S.placeRedo.length === 0 : framing ? S.wpRedo.length === 0 : redoNode(tree!) == null));
      redo.dataset.tip = placing ? "Redo the last move" : framing ? "Redo the last workplane move" : "Redo the last solid edit";
    }
  }
  const stepButton = document.querySelector<HTMLButtonElement>("#modelStep");
  if (stepButton) stepButton.disabled = S.busy || S.jumping || !tree;
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
}
