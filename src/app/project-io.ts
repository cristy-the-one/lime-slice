/** Save and open a `.lime` project against the live session. */
import { saveProjectText } from "../platform.ts";
import { confirmDiscard, markProjectClean } from "../project-dirty.ts";
import { base64ToBytes, meshRecord, parseProject, serializeProject, type LimeProject } from "../project.ts";
import { saveProfile } from "../profiles.ts";
import { DEFAULT_PRESET, readPresets, type PresetSettings } from "../presets.ts";
import { loadSettingsLevel, setSettingsLevel } from "../ui/settings-panel.ts";
import { pushToast } from "../ui/toasts.ts";
import { adoptBytes, place } from "./files.ts";
import { applyPreset, currentPreset, renderChrome } from "./settings.ts";
import { session, state } from "./state.ts";

export async function saveCurrentProject() {
  if (!state.mesh) {
    pushToast("Load a mesh before saving a project.", "info");
    return;
  }
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
    pushToast(parsed.message, "error");
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

async function restoreProject(project: LimeProject): Promise<boolean> {
  const bytes = base64ToBytes(project.mesh.bytesBase64);
  if (!bytes) {
    pushToast("The mesh in this project is damaged.", "error");
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
    session.slicedEdits = [];
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

function matchingPreset(current: PresetSettings): string | null {
  for (const [name, preset] of Object.entries(readPresets())) {
    if (JSON.stringify({ ...DEFAULT_PRESET, ...preset }) === JSON.stringify(current)) return name;
  }
  return null;
}
