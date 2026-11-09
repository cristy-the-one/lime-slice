/** The Model view's entry: binds its buttons and cards, each area in the module that owns it. Its other parts live in ./model/. */
import { mountDockPanes } from "../ui/dock-panes";
import { fx } from "./fx";
import { bindChrome, bindToolbar } from "./model/bind-chrome";
import { bindSketch } from "./model/bind-sketch";
import { bindStress } from "./model/bind-stress";
import { commitModel } from "./model/commit";
import { bindEdgeDrag } from "./model/edge-tool";
import { bindHistory } from "./model/history";
import { followSelection, forgetModelTrees } from "./model/lifecycle";
import { bindParameters, noteParametersBuilt } from "./model/parameters";
import { bindPlugins } from "./model/plugin-panel";
import { bindPull } from "./model/pull";
import { releaseModelTrees } from "./model/save";
import { bindSplitPrint, exportedPart, exportSplitNote } from "./model/split-print";
import { bindTransition, keepStale, requestReaim, transitionStaleNote } from "./model/transition";
import { bindInspect, bindLook, refreshModelContext } from "./model/view";
export { commonVolume, exportAssemblyStep } from "./model/assembly";
export { captureOpenSolid, commitModel } from "./model/commit";
export { createFeatureSolid } from "./model/create";
export { warmHeldPieces } from "./model/engine";
export { followSelection, forgetModelTrees, leaveModel, modelEditingPart, showModel } from "./model/lifecycle";
export { noteBridgeSwap } from "./model/plugins";
export { noteParametersBuilt } from "./model/parameters";
export { adoptHeldPieces, adoptSavedTrees, bridgeHistoryOf, historyToSave, releaseModelTrees } from "./model/save";
export type { HeldToSave } from "./model/save";
export { exportSplitNote, exportedPart } from "./model/split-print";
export { keepStale, requestReaim, transitionStaleNote } from "./model/transition";
export { frameInModel, frameModel, refreshModelContext, requestModelCheck } from "./model/view";

export function bindModelView() {
  bindToolbar();
  bindChrome();
  bindSplitPrint();
  bindPlugins();
  bindTransition();
  bindParameters();
  bindStress();
  noteParametersBuilt();
  bindInspect();
  bindPull();
  bindEdgeDrag();
  bindSketch();
  bindHistory();
  // The tool, History, Parameters, and Stress share the dock's height; after History has its header.
  mountDockPanes();
  bindLook();
}

Object.assign(fx, { refreshModelContext, commitModel, exportedPart, exportSplitNote, transitionStaleNote, requestReaim, keepStale, forgetModelTrees, followSelection, releaseModelTrees });
