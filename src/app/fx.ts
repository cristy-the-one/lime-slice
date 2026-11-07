/** Late-bound calls between app modules. Each module registers its own functions; nothing imports main.ts. */

// Type-only imports of the modules that register the functions: they describe the shape and add no runtime dependency.
type Files = typeof import("./files.ts");
type Viewer = typeof import("./viewer.ts");
type Settings = typeof import("./settings.ts");
type SliceRun = typeof import("./slice-run.ts");
type PlateActions = typeof import("./plate-actions.ts");
type ShellActions = typeof import("./shell-actions.ts");
type Commit = typeof import("./model/commit.ts");
type Lifecycle = typeof import("./model/lifecycle.ts");
type SplitPrint = typeof import("./model/split-print.ts");
type Transition = typeof import("./model/transition.ts");
type Save = typeof import("./model/save.ts");
type ModelViewing = typeof import("./model/view.ts");

export interface Fx {
  // Views, set when they are mounted.
  prepare: ReturnType<typeof import("../prepare-view").createPrepareView>;
  view3d: ReturnType<typeof import("../view3d").createSliceView>;
  model?: ReturnType<typeof import("../model-view").createModelView>;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  // files.ts
  applyPlace: Files["applyPlace"];
  isTauri: Files["isTauri"];
  printableGcode: Files["printableGcode"];
  refreshStepPreview: Files["refreshStepPreview"];
  setOrientAngle: Files["setOrientAngle"];
  setPlaceCenter: Files["setPlaceCenter"];
  // viewer.ts
  draw: Viewer["draw"];
  loadGcode: Viewer["loadGcode"];
  paintGcode: Viewer["paintGcode"];
  paintGizmoReadout: Viewer["paintGizmoReadout"];
  paintLegend: Viewer["paintLegend"];
  paintPlayback: Viewer["paintPlayback"];
  paintSectionChrome: Viewer["paintSectionChrome"];
  paintSlider: Viewer["paintSlider"];
  paintSpark: Viewer["paintSpark"];
  realignSplit: Viewer["realignSplit"];
  resize: Viewer["resize"];
  setStage: Viewer["setStage"];
  syncCut: Viewer["syncCut"];
  syncPreviewPending: Viewer["syncPreviewPending"];
  syncSplitField: Viewer["syncSplitField"];
  // settings.ts
  markStale: Settings["markStale"];
  renderChrome: Settings["renderChrome"];
  stale: Settings["stale"];
  // slice-run.ts
  lineWidth: SliceRun["lineWidth"];
  paintForceButton: SliceRun["paintForceButton"];
  paintSliceButton: SliceRun["paintSliceButton"];
  quietRefreshing: SliceRun["quietRefreshing"];
  runSlice: SliceRun["runSlice"];
  scheduleAuto: SliceRun["scheduleAuto"];
  // plate-actions.ts, shell-actions.ts, main.ts
  selectPlateObject: PlateActions["selectPlateObject"];
  notePivotTriple: PlateActions["notePivotTriple"];
  noteJointField: PlateActions["noteJointField"];
  separateShells: ShellActions["separateShells"];
  drawPaint: () => void;
  // pose.ts: redraw the Pose stage when the plate or the assemblies change. Set once Pose has been opened.
  syncPose?: () => void;
  // The Model workspace (model.ts registers them)
  commitModel: Commit["commitModel"];
  exportedPart: SplitPrint["exportedPart"];
  exportSplitNote: SplitPrint["exportSplitNote"];
  followSelection: Lifecycle["followSelection"];
  forgetModelTrees: Lifecycle["forgetModelTrees"];
  keepStale: Transition["keepStale"];
  refreshModelContext: ModelViewing["refreshModelContext"];
  releaseModelTrees: Save["releaseModelTrees"];
  requestReaim: Transition["requestReaim"];
  transitionStaleNote: Transition["transitionStaleNote"];
}

export const fx = {} as Fx;
