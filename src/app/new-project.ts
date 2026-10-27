/** File > New. The dirty flag is the one Open already uses. */
import { blankDocument, LAUNCH_CALIBRATION, replaceChoice, type SaveChoice } from "../project-blank.ts";
import { markProjectClean } from "../project-dirty.ts";
import { emptyOverrides } from "../overrides.ts";
import { ID_MATRIX } from "../mesh-place.ts";
import { DEFAULT_PRESET, presetKeys } from "../presets.ts";
import { emptyPlate, resetHeldGeometry } from "../plate.ts";
import { clearEdits } from "../support-edit-list.ts";
import { applyActivePrinter, launchSettingsLevel } from "./machine-actions.ts";
import { beginModelVisit, clearEditHistory } from "./history.ts";
import { forgetModelTrees, noteParametersBuilt, showModel } from "./model.ts";
import { forgetSavedThumbnail, saveCurrentProject } from "./project-io.ts";
import { setProjectTitle } from "./project-title.ts";
import { resetBridgeMirror } from "./bridge-mount.ts";
import { cancelSlice, dropWorkerMesh } from "./slice-run.ts";
import { renderChrome } from "./settings.ts";
import { setSettingsLevel } from "../ui/settings-panel.ts";
import { session, state, STEP_TOLERANCE_DEFAULT } from "./state.ts";
import { fx } from "./fx.ts";
import { dropShownPreview, setStage, stopPlay } from "./viewer.ts";
import { closeStress } from "../ui/stress.ts";
import { clearStressCells } from "../sim/stress-cells.ts";

export async function newProject() {
  const choice = await askIfDirty();
  if (choice === "cancel") return;
  if (choice === "save") {
    await saveCurrentProject();
    if (session.projectDirty) return;
  }
  blankProject();
}

function askIfDirty(): Promise<SaveChoice> {
  if (!session.projectDirty) return Promise.resolve(replaceChoice(false, null));
  return askUnsaved().then((answer) => replaceChoice(true, answer));
}

function askUnsaved(): Promise<SaveChoice | null> {
  const sheet = document.querySelector<HTMLElement>("#unsaved");
  if (!sheet) return Promise.resolve(null);
  sheet.hidden = false;
  document.documentElement.dataset.overlay = "unsaved";
  const save = sheet.querySelector<HTMLButtonElement>('[data-unsaved="save"]');
  save?.focus();
  return new Promise((resolve) => {
    const finish = (answer: SaveChoice | null) => {
      sheet.hidden = true;
      if (document.documentElement.dataset.overlay === "unsaved") delete document.documentElement.dataset.overlay;
      sheet.removeEventListener("click", onClick);
      window.removeEventListener("keydown", onKey);
      resolve(answer);
    };
    const onClick = (ev: MouseEvent) => {
      const choice = (ev.target as HTMLElement).closest<HTMLElement>("[data-unsaved]")?.dataset.unsaved;
      if (choice === "save" || choice === "discard" || choice === "cancel") finish(choice);
      else if (ev.target === sheet) finish(null);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      finish(null);
    };
    sheet.addEventListener("click", onClick);
    window.addEventListener("keydown", onKey);
  });
}

/** Empty plate, launch settings and printer, no slice, no file name. */
export function blankProject() {
  session.docEpoch += 1;
  // The last study's colours, deformed copy and Preview cells belong to the old plate.
  closeStress();
  clearStressCells();
  // --- A8. File > New drops the previous project's MCP record. ---
  session.mcpModel = undefined;
  session.parameters = {};
  session.assemblies = [];
  noteParametersBuilt();
  const stayInModel = state.stage === "model";
  cancelSlice();
  dropWorkerMesh();
  stopPlay();
  window.clearTimeout(session.autoTimer);
  window.clearTimeout(session.stepTimer);
  session.autoDeferred = false;
  session.askSlice = false;
  session.paintUi?.stop();
  session.seamUi?.stop();
  session.reinforceUi?.stop();
  session.supportUi?.reset();
  forgetModelTrees();
  for (const key of presetKeys()) {
    (state as unknown as Record<string, unknown>)[key] = DEFAULT_PRESET[key];
  }
  state.splitCustom = false;
  applyActivePrinter();
  setSettingsLevel(launchSettingsLevel());
  state.paStart = LAUNCH_CALIBRATION.paStart;
  state.paEnd = LAUNCH_CALIBRATION.paEnd;
  state.paStep = LAUNCH_CALIBRATION.paStep;
  state.paBands = [];
  state.paGcode = "";
  state.flowStart = LAUNCH_CALIBRATION.flowStart;
  state.flowEnd = LAUNCH_CALIBRATION.flowEnd;
  state.flowStep = LAUNCH_CALIBRATION.flowStep;
  state.flowBands = [];
  state.flowGcode = "";
  state.tempStart = LAUNCH_CALIBRATION.tempStart;
  state.tempEnd = LAUNCH_CALIBRATION.tempEnd;
  state.tempStep = LAUNCH_CALIBRATION.tempStep;
  state.tempBands = [];
  state.tempGcode = "";
  state.retractStart = LAUNCH_CALIBRATION.retractStart;
  state.retractEnd = LAUNCH_CALIBRATION.retractEnd;
  state.retractStep = LAUNCH_CALIBRATION.retractStep;
  state.retractBands = [];
  state.retractGcode = "";
  state.mesh = null;
  state.result = null;
  state.slicedHash = "";
  state.layer = 0;
  state.rangeLow = 0;
  state.error = "";
  state.notice = "";
  state.progress = 0;
  state.busy = false;
  state.sourcePos = null;
  state.placed = null;
  state.orient = ID_MATRIX;
  state.partScale = 1;
  state.stepTolerance = STEP_TOLERANCE_DEFAULT;
  state.centered = true;
  state.offset = { x: 0, y: 0, z: 0 };
  state.supportEdits = clearEdits();
  state.supportPaint = [];
  state.seamPaint = [];
  state.reinforcement = [];
  state.overrides = emptyOverrides();
  state.selectedVolumeId = null;
  state.layerActions = [];
  state.printOrder = "all-at-once";
  state.sequentialClearance = 0;
  state.sequentialGantry = 0;
  state.pareto = [];
  state.hidden = new Set();
  state.query = "";
  state.poseHud = "";
  state.sectionOn = false;
  state.sectionOffset = 0;
  state.sectionNormal = [0, 0, 1];
  state.plate = emptyPlate();
  resetHeldGeometry();
  session.meshEpoch += 1;
  session.shown = null;
  session.resultJob = 0;
  session.resultFrame = "";
  session.chosenZ = null;
  session.shownRecipe = null;
  session.slicedFrame = null;
  session.quietTried = "";
  session.slicedEdits = [];
  session.slicedPaint = [];
  session.slicedBed = null;
  session.slicedObjects = null;
  session.fingerSource = null;
  session.fingerScale = Number.NaN;
  session.finger = "";
  session.geomReady = null;
  session.drag2d = false;
  session.liveProgress = false;
  clearEditHistory();
  if (stayInModel) beginModelVisit();
  forgetSavedThumbnail();
  resetBridgeMirror();
  setProjectTitle(null);
  markProjectClean();
  const rail = document.querySelector<HTMLElement>("#toolRail");
  if (rail) rail.dataset.tool = "all";
  rail?.querySelectorAll<HTMLButtonElement>("[aria-pressed='true']").forEach((button) => button.setAttribute("aria-pressed", "false"));
  document.querySelectorAll<HTMLButtonElement>(".model-tool[aria-pressed='true']").forEach((button) => button.setAttribute("aria-pressed", "false"));
  fx.prepare?.setMesh(null);
  fx.prepare?.setPlate?.([], []);
  const { bedX, bedY, bedZ } = state.profile;
  fx.prepare?.setBed(bedX, bedY, bedZ);
  fx.view3d?.setBed(bedX, bedY, bedZ);
  dropShownPreview();
  fx.paintSectionChrome?.();
  fx.paintGizmoReadout?.();
  const nextStage = blankDocument({ stage: state.stage, layerHeight: state.layerHeight, profileName: state.profile.name }).stage;
  if (nextStage === "model") showModel();
  else if (state.stage !== "preview") setStage("preview");
  renderChrome();
  markProjectClean();
}
