import { type ColorMode } from "../colors";
import { layFlatMatrix, matMul, rotX, rotY, rotZ } from "../mesh-place";
import { addPlateObject, arrangePlate, removePlateObject, selectPlateObject } from "./plate-actions";
import { applyTheme, type ThemeChoice } from "../theme";
import { clampOffset, flipSection } from "../section-plane";
import { wheelNotch } from "../gizmo-math";
import { state, type CardId } from "./state";
import { commitSplit, draw, layerGcode, paintPlayback, paintSectionChrome, prepare, scrub, sectionLimit, setHelp, setStage, setView, stepGizmo, stopPlay, syncGcodeHighlight, togglePlay, view3d } from "./viewer";
import { applyPareto, cancelSlice, runFlowCal, runPaCal, runPareto, runRetractCal, runSlice, runTempCal } from "./slice-run";
import { adoptBytes, export3mf, exportGcode, fail, loadNamed, place, saveText, setPlaceCenter, withPrinterGcode } from "./files";
import { mountProjectFiles, openProjectFile, saveCurrentProject } from "./project-io";
import { pickModelFile } from "../platform";
import { noteGroupToggle, noteObjectOverride, noteSequential, onSettings, pickStrategy, revealPrinterDetails, revealResults, setCalibrate, syncFindStuck, touch } from "./settings";
import { noteEdit } from "./history";
import {
  applyNamedProfile,
  askProfileName,
  migrateLegacyPresets,
  deleteSettingsProfile,
  duplicateSettingsProfile,
  exportSettingsProfile,
  importSettingsProfileFile,
  openProfileMore,
  overwriteSettingsProfile,
  renameSettingsProfile,
  saveSettingsProfile,
  selectedProfileId,
  typedProfileName,
} from "./profile-actions";
import {
  addHeightRange,
  addModifier,
  commitOverrideInput,
  editOverrideInput,
  removeOverrideCard,
  selectModifier,
  setModifierTool,
} from "./override-actions";
import { pushToast } from "../ui/toasts";
import { currentRules } from "./rules";
import { turnOnSupports } from "./support-actions";
import {
  bootMachines,
  noteAdvance,
  noteBeltForm,
  noteFlow,
  noteNozzleTemp,
  noteRetract,
  chooseMachine,
  deleteMachine,
  duplicateMachine,
  machineExportFile,
  importMachineFile,
  saveMachine,
  typedMachineName,
} from "./machine-actions";
import { refreshPrusaJob, rememberPrusaForm, testPrusaLink, uploadToPrusaLink } from "./prusa-actions";

export function wireApp() {
  bootMachines();
  migrateLegacyPresets();
  document.querySelector("#left")!.addEventListener("input", (ev) => {
    const target = ev.target as HTMLInputElement;
    if (isBeltField(target)) {
      noteBeltForm(target.id);
      return;
    }
    if (target.closest?.("[data-override-card]")) {
      editOverrideInput(target);
      return;
    }
    onSettings(ev);
  });
  document.querySelector("#left")!.addEventListener("change", (ev) => {
    const target = ev.target as HTMLElement;
    if (isBeltField(target)) {
      noteBeltForm(target.id);
      return;
    }
    if (target.id === "placeX" || target.id === "placeY") {
      const mm = Number((target as HTMLInputElement).value);
      if (!Number.isFinite(mm)) return;
      noteEdit();
      setPlaceCenter(target.id === "placeX" ? "x" : "y", mm);
      return;
    }
    if (target.id === "objInfill" || target.id === "objWalls" || target.id === "objSpeed") {
      if (noteObjectOverride(target.id, (target as HTMLInputElement).value)) touch();
      return;
    }
    if (target.id === "seqclear" || target.id === "seqgantry") {
      if (noteSequential(target.id, (target as HTMLInputElement).value)) touch();
      return;
    }
    if (target.id === "at") {
      const value = Number((target as HTMLInputElement).value);
      if (Number.isFinite(value)) commitSplit(value);
      return;
    }
    if (target.id === "profilePick") {
      const id = (target as HTMLSelectElement).value;
      if (id) applyNamedProfile(id);
      return;
    }
    if (target.id === "machineHost" || target.id === "machineKey" || target.id === "machineStartPrint") {
      rememberPrusaForm();
      return;
    }
    if (target.id === "profileFile") {
      const input = target as HTMLInputElement;
      const file = input.files?.[0];
      input.value = "";
      if (file) void importSettingsProfileFile(file);
      return;
    }
    if (target.id === "machineFile") {
      const input = target as HTMLInputElement;
      const file = input.files?.[0];
      input.value = "";
      if (file) void importMachineFile(file);
    }
    if (target instanceof HTMLInputElement && target.closest("[data-override-card]")) commitOverrideInput(target);
  });
  // A search opens groups on its own; only a toggle outside one is the user's choice to keep.
  document.querySelector("#left")!.addEventListener("toggle", (ev) => {
    const details = ev.target as HTMLDetailsElement;
    const id = details.dataset.group;
    if (!id || state.query.trim()) return;
    noteGroupToggle(id, details.open);
  }, true);
  document.querySelector("#left")!.addEventListener("click", (ev) => {
    const raw = ev.target as HTMLElement;
    // An icon button is hit on its svg; the button is what the ids below name.
    const t = raw.closest<HTMLElement>("button") ?? raw;
    const railTool = t.closest<HTMLElement>("[data-rail-tool]")?.dataset.railTool;
    if (railTool) {
      document.querySelector<HTMLButtonElement>(`#toolRail [data-tool="${railTool}"]`)?.click();
      return;
    }
    const cardEl = t.closest<HTMLElement>("[data-card]");
    if (cardEl) {
      pickStrategy(cardEl.dataset.card as CardId);
      return;
    }
    if (t.id === "profileSave") {
      const typed = typedProfileName();
      if (typed) saveSettingsProfile(typed);
      else if (selectedProfileId()) overwriteSettingsProfile(selectedProfileId());
      else {
        openProfileMore();
        pushToast("Name the profile first.", "info");
      }
      return;
    }
    if (t.id === "profileRename") {
      const id = selectedProfileId();
      if (!id) {
        pushToast("Choose a profile first.", "info");
        return;
      }
      const name = askProfileName("");
      if (name) renameSettingsProfile(id, name);
      return;
    }
    if (t.id === "profileDuplicate") {
      const id = selectedProfileId();
      if (!id) pushToast("Choose a profile first.", "info");
      else duplicateSettingsProfile(id);
      return;
    }
    if (t.id === "profileDelete") {
      const id = selectedProfileId();
      if (!id) pushToast("Choose a profile first.", "info");
      else deleteSettingsProfile(id);
      return;
    }
    if (t.id === "settingsProfileExport") {
      exportSettingsProfile(selectedProfileId());
      return;
    }
    if (t.id === "plateAdd" || t.id === "plateDuplicate") {
      addPlateObject();
      return;
    }
    if (t.id === "plateArrange" || t.closest("[data-plate-arrange]")) {
      arrangePlate();
      return;
    }
    const plateSelect = t.closest<HTMLElement>("[data-plate-select]")?.dataset.plateSelect;
    if (plateSelect) {
      selectPlateObject(plateSelect);
      return;
    }
    const plateRemove = t.closest<HTMLElement>("[data-plate-remove]")?.dataset.plateRemove;
    if (plateRemove) {
      removePlateObject(plateRemove);
      return;
    }
    if (t.id === "center") { noteEdit(); state.centered = true; state.offset = { x: 0, y: 0, z: 0 }; place(); }
    if (t.id === "layflat" && state.sourcePos) { noteEdit(); state.orient = layFlatMatrix(state.sourcePos); place(); }
    if (t.id === "rotX") { noteEdit(); state.orient = matMul(rotX(90), state.orient); place(); }
    if (t.id === "rotY") { noteEdit(); state.orient = matMul(rotY(90), state.orient); place(); }
    if (t.id === "rotZ") { noteEdit(); state.orient = matMul(rotZ(90), state.orient); place(); }
    if (t.id === "heightAdd") {
      addHeightRange();
      return;
    }
    if (t.id === "volumeBox" || t.id === "volumeCylinder" || t.id === "volumeSphere") {
      addModifier(t.id === "volumeBox" ? "box" : t.id === "volumeCylinder" ? "cylinder" : "sphere");
      return;
    }
    if (t.id === "modToolMove" || t.id === "modToolScale") {
      setModifierTool(t.id === "modToolScale" ? "scale" : "move");
      return;
    }
    const selectId = t.closest<HTMLElement>("[data-override-select]")?.dataset.overrideSelect;
    if (selectId) {
      selectModifier(selectId);
      return;
    }
    if (t.dataset.overrideRemove) {
      const card = t.closest<HTMLElement>("[data-override-card]");
      if (card) removeOverrideCard(card);
      return;
    }
    if (t.id === "machineSave") {
      saveMachine(typedMachineName());
      return;
    }
    if (t.id === "machineDuplicate") {
      duplicateMachine();
      return;
    }
    if (t.id === "machineDelete") {
      deleteMachine();
      return;
    }
    if (t.id === "machineExport") {
      const file = machineExportFile();
      if (file) void saveText(file.text, file.name, "json");
      return;
    }
    if (t.id === "prusaTest") {
      testPrusaLink();
      return;
    }
    if (t.id === "prusaJob") {
      refreshPrusaJob();
      return;
    }
  });
  document.querySelector("#right")!.addEventListener("click", (ev) => {
    const dot = (ev.target as HTMLElement).closest<SVGElement>("[data-pareto]");
    if (dot) {
      applyPareto(Number(dot.dataset.pareto));
      return;
    }
    if ((ev.target as HTMLElement).id === "paretoBtn") {
      void runPareto();
      return;
    }
  });
  document.querySelector("#banner")!.addEventListener("click", (ev) => {
    const action = (ev.target as HTMLElement).closest<HTMLElement>("[data-banner-action]")?.dataset.bannerAction;
    if (action === "supports") turnOnSupports();
  });

  const fileMenu = document.querySelector<HTMLDetailsElement>("#fileMenu")!;
  const closeFileMenu = () => {
    fileMenu.open = false;
    (document.querySelector("#samples") as HTMLDetailsElement).open = false;
  };
  fileMenu.addEventListener("click", (ev) => {
    const button = (ev.target as HTMLElement).closest<HTMLButtonElement>("button");
    if (!button) return;
    closeFileMenu();
    const action = button.dataset.fileAction;
    if (action === "open") pickModelFile();
    else if (action === "save") void saveCurrentProject();
    else if (button.dataset.sample) void loadNamed(button.dataset.sample).catch(fail);
    else if (button.id === "export3mf") void export3mf();
    else if (button.id === "machineOpen") revealPrinterDetails();
    else if (button.id === "calibrateOpen") document.dispatchEvent(new CustomEvent("lime-open-calibrate"));
  });
  mountProjectFiles();
  document.querySelector("#file")!.addEventListener("change", (ev) => {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    if (/\.lime$/i.test(file.name)) {
      void openProjectFile(file);
      return;
    }
    file.arrayBuffer().then((bytes) => adoptBytes(file.name, bytes)).catch(fail);
  });
  // The printer chip's pickers also serve the compact Device page, so the listener sits on the document.
  document.addEventListener("change", (ev) => {
    const target = ev.target as HTMLElement;
    if (target.id !== "machinePrinter" && target.id !== "machineFilament" && target.id !== "machineNozzle") return;
    const printerId = document.querySelector<HTMLSelectElement>("#machinePrinter")?.value ?? "";
    const filamentId = document.querySelector<HTMLSelectElement>("#machineFilament")?.value ?? "";
    const nozzleMm = Number(document.querySelector<HTMLSelectElement>("#machineNozzle")?.value);
    chooseMachine(printerId, filamentId, nozzleMm);
  });
  document.addEventListener("click", (ev) => {
    if (!(ev.target as HTMLElement).closest("#editPrinter")) return;
    const chip = document.querySelector<HTMLDetailsElement>("#printerChip");
    if (chip) chip.open = false;
    revealPrinterDetails();
  });
  document.querySelector("#timing")!.addEventListener("click", () => revealResults());
  document.addEventListener("lime-open-calibrate", () => setCalibrate(true));
  document.querySelector("#calibrateClose")!.addEventListener("click", () => setCalibrate(false));
  document.querySelector("#calibrate")!.addEventListener("mousedown", (ev) => {
    if (ev.target === ev.currentTarget) setCalibrate(false);
  });
  window.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && document.documentElement.dataset.overlay === "calibrate") {
      ev.preventDefault();
      ev.stopPropagation();
      setCalibrate(false);
    }
  }, true);
  document.querySelector("#calibrate")!.addEventListener("input", onSettings);
  document.querySelector("#calibrate")!.addEventListener("click", (ev) => {
    const t = (ev.target as HTMLElement).closest<HTMLButtonElement>("button");
    if (!t) return;
    if (t.id === "pacal") void runPaCal();
    if (t.id === "flowcal") void runFlowCal();
    if (t.id === "tempcal") void runTempCal();
    if (t.id === "retractcal") void runRetractCal();
    if (t.id === "paapply") {
      const chosen = Number((document.querySelector("#pachosen") as HTMLInputElement).value);
      const marlin = currentRules().firmware === "marlin";
      noteAdvance(marlin ? state.pressureAdvance : chosen, marlin ? chosen : state.linearAdvance);
      touch();
    }
    if (t.id === "paexport" && state.paGcode) void saveText(withPrinterGcode(state.paGcode), "pa-calibration.gcode", "gcode");
    if (t.id === "flowapply") {
      noteEdit();
      noteFlow(Number((document.querySelector("#flowchosen") as HTMLInputElement).value));
      touch();
    }
    if (t.id === "flowexport" && state.flowGcode) void saveText(withPrinterGcode(state.flowGcode), "flow-calibration.gcode", "gcode");
    if (t.id === "tempapply") {
      noteEdit();
      noteNozzleTemp(Number((document.querySelector("#tempchosen") as HTMLInputElement).value));
      touch();
    }
    if (t.id === "tempexport" && state.tempGcode) void saveText(withPrinterGcode(state.tempGcode), "temperature-calibration.gcode", "gcode");
    if (t.id === "retractapply") {
      noteEdit();
      const length = Number((document.querySelector("#retractchosen") as HTMLInputElement).value);
      const speed = state.retractOn && Math.abs(state.retractSpeed - 30) > 1e-6 ? state.retractSpeed : null;
      noteRetract(length, speed);
      touch();
    }
    if (t.id === "retractexport" && state.retractGcode) void saveText(withPrinterGcode(state.retractGcode), "retraction-calibration.gcode", "gcode");
  });
  document.querySelector(".top")!.addEventListener("input", onSettings);
  document.querySelectorAll<HTMLButtonElement>(".mode:not(.tab)").forEach((button) => {
    button.addEventListener("click", () => setView(button.dataset.mode as typeof state.viewMode, "user"));
  });
  document.querySelector("#theme")!.addEventListener("change", (ev) => {
    applyTheme((ev.target as HTMLSelectElement).value as ThemeChoice);
    view3d.setTheme();
    prepare.setTheme();
    draw();
  });
  document.querySelectorAll<HTMLButtonElement>(".tab").forEach((button) => {
    button.addEventListener("click", () => {
      const tab = button.dataset.tab;
      setStage(tab === "prepare" || tab === "gcode" ? tab : "preview");
    });
  });
  document.querySelector("#play")!.addEventListener("click", () => togglePlay());
  document.querySelector("#move")!.addEventListener("input", (ev) => {
    const next = Number((ev.target as HTMLInputElement).value);
    if (next === state.move) return;
    stopPlay();
    layerGcode(true);
    state.move = next;
    paintPlayback();
    syncGcodeHighlight();
    draw();
  });
  document.querySelector("#spark")!.addEventListener("click", (ev) => {
    const layers = state.result?.layers.length ?? 0;
    if (layers === 0) return;
    const rect = (ev.currentTarget as HTMLCanvasElement).getBoundingClientRect();
    const t = ((ev as MouseEvent).clientX - rect.left) / Math.max(1, rect.width);
    const index = Math.max(0, Math.min(layers - 1, Math.floor(t * layers)));
    if (index < state.rangeLow) state.rangeLow = index;
    scrub(index);
  });
  document.querySelector("#colorBy")!.addEventListener("change", (ev) => {
    state.colorMode = (ev.target as HTMLSelectElement).value as ColorMode;
    draw();
  });
  document.querySelector("#bedOpacity")!.addEventListener("input", (ev) => {
    state.bedOpacity = Math.min(1, Math.max(0, Number((ev.target as HTMLInputElement).value) / 100));
    prepare.setBedOpacity(state.bedOpacity);
    view3d.setBedOpacity(state.bedOpacity);
  });
  document.querySelector("#sectionOn")!.addEventListener("change", (ev) => {
    state.sectionOn = (ev.target as HTMLInputElement).checked;
    state.sectionHud = "";
    paintSectionChrome();
    draw();
  });
  document.querySelector("#sectionOffset")!.addEventListener("input", (ev) => {
    state.sectionOffset = clampOffset(Number((ev.target as HTMLInputElement).value), sectionLimit());
    state.sectionHud = "";
    paintSectionChrome();
    draw();
  });
  document.querySelector("#sectionFlip")!.addEventListener("click", () => {
    const next = flipSection({ normal: state.sectionNormal, offset: state.sectionOffset });
    state.sectionNormal = next.normal;
    state.sectionOffset = next.offset;
    state.sectionHud = "";
    paintSectionChrome();
    draw();
  });
  document.querySelector("#legend")!.addEventListener("change", (ev) => {
    const input = ev.target as HTMLInputElement;
    const kind = input.dataset.kind;
    if (!kind) return;
    if (input.checked) state.hidden.delete(kind);
    else state.hidden.add(kind);
    if (kind === "travel") state.showTravel = input.checked;
    view3d.setShowTravel(state.showTravel && !state.hidden.has("travel"));
    draw();
  });
  document.querySelector("#layerNext")!.addEventListener("click", () => scrub(state.layer + 1));
  document.querySelector("#layerPrev")!.addEventListener("click", () => scrub(state.layer - 1));
  let layerWheel = 0;
  document.querySelector<HTMLElement>("#vslider")!.addEventListener("wheel", (ev) => {
    if (!state.result) return;
    ev.preventDefault();
    const turned = wheelNotch(ev.deltaY, ev.deltaMode, layerWheel);
    layerWheel = turned.accum;
    if (turned.notches !== 0) scrub(state.layer + turned.notches);
  }, { passive: false });
  document.addEventListener("click", (ev) => {
    const button = (ev.target as Element | null)?.closest<HTMLButtonElement>("#gizmoNudge button");
    if (!button) return;
    const axis = button.dataset.axis;
    const sign = Number(button.dataset.sign);
    if ((axis !== "x" && axis !== "y" && axis !== "z") || !Number.isFinite(sign) || sign === 0) return;
    stepGizmo(axis, sign);
  });
  document.querySelector("#rangeHigh")!.addEventListener("input", (ev) => {
    const value = Number((ev.target as HTMLInputElement).value);
    if (value < state.rangeLow) state.rangeLow = value;
    scrub(value);
  });
  document.querySelector("#rangeLow")!.addEventListener("input", (ev) => {
    state.rangeLow = Math.min(state.layer, Number((ev.target as HTMLInputElement).value));
    scrub(state.layer);
  });
  document.querySelector("#toggleLeft")!.addEventListener("click", () => {
    document.querySelector(".workspace")!.classList.toggle("show-left");
  });
  document.querySelector("#toggleRight")!.addEventListener("click", () => {
    document.querySelector(".workspace")!.classList.toggle("show-right");
  });
  document.querySelector("#slice")!.addEventListener("click", () => void runSlice(false));
  document.querySelector("#force")!.addEventListener("click", () => void runSlice(true));
  document.querySelector("#cancel")!.addEventListener("click", () => cancelSlice());
  document.querySelector("#export")!.addEventListener("click", () => void exportGcode());
  document.querySelector("#sendPrinter")!.addEventListener("click", () => void uploadToPrusaLink());
  document.querySelector("#helpClose")!.addEventListener("click", () => setHelp(false));

  document.addEventListener("scroll", (ev) => {
    const scrolling = ev.target;
    if (!(scrolling instanceof HTMLElement)) return;
    if (scrolling.id === "left" || scrolling.id === "compactSheetBody") syncFindStuck();
  }, true);

  document.querySelector(".app")!.addEventListener("dragover", (ev) => {
    ev.preventDefault();
    document.querySelector(".app")!.classList.add("dropping");
  });
  document.querySelector(".app")!.addEventListener("dragleave", () => {
    document.querySelector(".app")!.classList.remove("dropping");
  });
  document.querySelector(".app")!.addEventListener("drop", (ev) => {
    const drop = ev as DragEvent;
    drop.preventDefault();
    document.querySelector(".app")!.classList.remove("dropping");
    const file = drop.dataTransfer?.files?.[0];
    if (!file) return;
    void file.arrayBuffer().then((bytes: ArrayBuffer) => adoptBytes(file.name, bytes)).catch(fail);
  });
}

function isBeltField(target: HTMLElement): boolean {
  return target.id === "machineKind" || target.id.startsWith("belt");
}
