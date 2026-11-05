/**
 * The Model workspace as one module that loads on first use (./workspaces.ts): Model, its sketch, Stress, Split to print
 * and Plugins, with their markup. `mountModelWorkspace` does what the app did for Model at start, in the same order:
 * the markup, the view, its bindings, then the parts the always-loaded code had bound around them.
 */
import "./modeling";
import { createModelView } from "../model-view";
import { mountModelMarkup } from "./model/markup";
import { bindModelView, noteParametersBuilt, requestModelCheck, showModel } from "./model";
import { pickAddedMesh } from "./files";
import { fx } from "./fx";
import { state } from "./state";
import { adoptModelRail } from "../ui/chrome";
import { adoptCompactModel } from "../ui/compact/mount";
import { mountModelRulers } from "../ui/measure-toggle";
import { mountSketchKeys } from "../ui/keys";
import { setInspectPlateActions } from "../ui/model-inspect";
import { duplicatePlateObject, framePlateObject, removePlateObject, selectPlateObject } from "./plate-actions";

export {
  adoptHeldPieces,
  adoptSavedTrees,
  captureOpenSolid,
  commitModel,
  commonVolume,
  exportAssemblyStep,
  followSelection,
  forgetModelTrees,
  frameInModel,
  frameModel,
  historyToSave,
  leaveModel,
  noteParametersBuilt,
  releaseModelTrees,
  requestModelCheck,
  showModel,
  warmHeldPieces,
} from "./model";
export type { HeldToSave } from "./model";
export { closeStress, revealStress } from "../ui/stress";
export { loadLibrary, openPluginsPanel, pluginLibrary, togglePluginsPanel } from "../ui/plugins-panel";
export { importPluginFiles, projectPluginsOffer } from "../ui/plugin-import";
export { libraryIo, projectCopies, stampedShas } from "../plugins/library";
export { escapeModel, openJoinTool } from "../ui/model-chrome";
export { editModelStep, toggleModelHistoryFocus } from "../ui/model-history";
export { toggleParameters } from "../ui/parameters";
export { openSplitPrint } from "../ui/split-print";

let mounted = false;

export function mountModelWorkspace() {
  if (mounted) return;
  mounted = true;
  mountModelMarkup();
  const model = createModelView(document.querySelector<HTMLCanvasElement>("#model")!);
  fx.model = model;
  bindModelView();
  mountSketchKeys();
  model.setBed(state.profile.bedX, state.profile.bedY, state.profile.bedZ);
  model.setTheme();
  adoptModelRail();
  mountModelRulers();
  // --- E3. Inspect's plate rows: the same actions as the Prepare list, which Model hides.
  setInspectPlateActions({ select: selectPlateObject, frame: framePlateObject, check: requestModelCheck, remove: removePlateObject, duplicate: duplicatePlateObject, add: pickAddedMesh });
  adoptCompactModel();
  // What the app told Model while it had not loaded: the project's parameters, and the stage it is on.
  noteParametersBuilt();
  fx.resize?.();
  if (state.stage === "model") showModel();
}
