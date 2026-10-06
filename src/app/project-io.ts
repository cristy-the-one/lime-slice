/** Save and open a `.lime` project against the live session. */
import { parseStl } from "../mesh-place.ts";
import { saveProjectText } from "../platform.ts";
import { confirmDiscard, markProjectClean } from "../project-dirty.ts";
import { emptyOverrides, projectOverrides } from "../overrides.ts";
import {
  assemblePlate,
  plateFileIsVersion2,
  settingsEmpty,
  type PlateFileObject,
} from "../plate.ts";
import { base64ToBytes, meshRecord, parseProject, serializeProject, type LimeProject, type ProjectPlacement } from "../project.ts";
import { saveProfile } from "../profiles.ts";
import { DEFAULT_PRESET, readPresets, type PresetSettings } from "../presets.ts";
import { loadSettingsLevel, setSettingsLevel } from "../ui/settings-panel.ts";
import { pushToast } from "../ui/toasts.ts";
import { adoptBytes, place, previewRemote } from "./files.ts";
import { applySelectedToState, syncPlateFromState } from "./plate-sync.ts";
import { applyPreset, currentPreset, needsEngine, renderChrome } from "./settings.ts";
import { session, state } from "./state.ts";

export async function saveCurrentProject() {
  if (!state.mesh) {
    pushToast("Load a mesh before saving a project.", "info");
    return;
  }
  syncPlateFromState();
  const project: LimeProject = {
    version: 1,
    mesh: meshRecord(state.mesh.name, new Uint8Array(state.mesh.bytes)),
    placement: {
      orient: [...state.orient],
      scale: state.partScale,
      centered: state.centered,
      offset: { ...state.offset },
      stepTolerance: state.stepTolerance,
    },
    settings: currentPreset(),
    preset: matchingPreset(currentPreset()),
    profile: { ...state.profile },
    level: loadSettingsLevel(),
    supportEdits: state.supportEdits.map((entry) => structuredClone(entry)),
  };
  const objects = fileObjects();
  if (plateFileIsVersion2(objects)) {
    project.version = 2;
    project.objects = objects;
  }
  const overrides = projectOverrides(state.overrides);
  if (overrides) project.overrides = structuredClone(overrides);
  if (project.version === 2 && state.printOrder === "sequential") {
    project.printOrder = "sequential";
    if (state.sequentialClearance > 0) project.sequentialClearanceMm = state.sequentialClearance;
  }
  const name = `${state.mesh.name.replace(/\.(stl|3mf|step|stp|lime)$/i, "")}.lime`;
  const wrote = await saveProjectText(serializeProject(project), name);
  if (!wrote) return;
  markProjectClean();
  pushToast("Saved project.", "success");
}

export async function openProjectFile(file: File) {
  if (!confirmDiscard()) return;
  const parsed = parseProject(await file.text());
  if (!parsed.ok) {
    pushToast(parsed.message, "error", { label: "Retry", run: openProjectPicker });
    return;
  }
  if (await restoreProject(parsed.project)) pushToast(`Opened ${file.name}.`, "success");
}

export function mountProjectFiles() {
  document.querySelector("#projectFile")?.addEventListener("change", (ev) => {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    void openProjectFile(file);
  });
  window.addEventListener("beforeunload", (ev) => {
    if (!session.projectDirty) return;
    ev.preventDefault();
    ev.returnValue = "";
  });
}

function openProjectPicker() {
  document.querySelector<HTMLInputElement>("#projectFile")?.click();
}

async function restoreProject(project: LimeProject): Promise<boolean> {
  const bytes = base64ToBytes(project.mesh.bytesBase64);
  if (!bytes) {
    pushToast("The mesh in this project is damaged.", "error", { label: "Retry", run: openProjectPicker });
    return false;
  }
  session.projectRestoring = true;
  try {
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    await adoptBytes(project.mesh.name, copy);
    state.orient = project.placement.orient;
    state.partScale = project.placement.scale;
    state.centered = project.placement.centered;
    state.offset = { ...project.placement.offset };
    state.stepTolerance = project.placement.stepTolerance;
    state.profile = project.profile;
    saveProfile(project.profile);
    applyPreset(project.settings);
    setSettingsLevel(project.level);
    state.supportEdits = project.supportEdits;
    state.overrides = project.overrides ? structuredClone(project.overrides) : emptyOverrides();
    state.printOrder = project.printOrder === "sequential" ? "sequential" : "all-at-once";
    state.sequentialClearance = project.sequentialClearanceMm ?? 0;
    state.selectedVolumeId = state.overrides.volumes[0]?.id ?? null;
    if (project.objects && project.objects.length > 0) {
      const loaded = await loadPlateObjects(project.objects);
      if (typeof loaded === "string") {
        pushToast(loaded, "error", { label: "Retry", run: openProjectPicker });
        return false;
      }
      state.plate = loaded;
      applySelectedToState(loaded);
    }
    session.slicedEdits = [];
    session.slicedPaint = [];
    place("load");
    session.supportUi?.refresh();
    renderChrome();
    const pick = document.querySelector<HTMLSelectElement>("#presetPick");
    if (pick && project.preset) pick.value = project.preset;
    markProjectClean();
    return true;
  } finally {
    session.projectRestoring = false;
  }
}

function fileObjects(): PlateFileObject[] {
  return state.plate.objects.map((obj) => {
    const record: PlateFileObject = {
      id: obj.id,
      name: obj.name,
      mesh: meshRecord(obj.fileName, new Uint8Array(obj.bytes)),
      placement: {
        orient: [...obj.orient] as ProjectPlacement["orient"],
        scale: obj.partScale,
        centered: obj.centered,
        offset: { ...obj.offset },
        stepTolerance: obj.stepTolerance,
      },
      supportEdits: obj.supportEdits.map((entry) => structuredClone(entry)),
    };
    if (!settingsEmpty(obj.settings)) record.settings = { ...obj.settings };
    if (obj.supportPaint.length > 0) record.supportPaint = obj.supportPaint.map((disk) => structuredClone(disk));
    if (obj.seamPaint.length > 0) record.seamPaint = obj.seamPaint.map((disk) => structuredClone(disk));
    return record;
  });
}

async function loadPlateObjects(objects: PlateFileObject[]) {
  const rows = [];
  for (const row of objects) {
    const bytes = base64ToBytes(row.mesh.bytesBase64);
    if (!bytes) return "The mesh in this project is damaged.";
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    let sourcePos = needsEngine(row.mesh.name) ? null : parseStl(copy);
    if (!sourcePos && state.sourcePos && state.mesh && row.mesh.hash === hashOf(state.mesh.bytes) && row.mesh.name === state.mesh.name) {
      sourcePos = state.sourcePos;
    }
    if (!sourcePos) sourcePos = await previewRemote(row.mesh.name, copy);
    if (!sourcePos) return `Could not read ${row.name}.`;
    rows.push({ ...row, bytes: copy, sourcePos });
  }
  return assemblePlate(rows);
}

function hashOf(bytes: ArrayBuffer): string {
  return meshRecord("part", new Uint8Array(bytes)).hash;
}

function matchingPreset(current: PresetSettings): string | null {
  for (const [name, preset] of Object.entries(readPresets())) {
    if (JSON.stringify({ ...DEFAULT_PRESET, ...preset }) === JSON.stringify(current)) return name;
  }
  return null;
}
