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
import { dropEmptyReinforce } from "../reinforcement.ts";
import { base64ToBytes } from "../base64.ts";
import { meshRecord, parseProject, serializeProject, type LimeProject, type ProjectPlacement } from "../project.ts";
import { saveProfile } from "../profiles.ts";
import { loadSettingsLevel, setSettingsLevel } from "../ui/settings-panel.ts";
import { pushToast } from "../ui/toasts.ts";
import { adoptBytes, place, previewRemote } from "./files.ts";
import { adoptSavedTrees, captureOpenSolid, historyToSave } from "./model.ts";
import type { SavedTree } from "../model-tree-file.ts";
import { applySelectedToState, syncPlateFromState } from "./plate-sync.ts";
import { applyPreset, currentPreset, needsEngine, renderChrome } from "./settings.ts";
import { session, state } from "./state.ts";

export async function saveCurrentProject() {
  if (!state.mesh) {
    pushToast("Load a mesh before saving a project.", "info");
    return;
  }
  await captureOpenSolid();
  // The trees are matched to the plate's meshes as written below.
  syncPlateFromState();
  const history = await historyToSave();
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
    preset: null,
    profile: { ...state.profile },
    level: loadSettingsLevel(),
    supportEdits: state.supportEdits.map((entry) => structuredClone(entry)),
  };
  const objects = fileObjects(history.trees);
  if (plateFileIsVersion2(objects)) {
    project.version = 2;
    project.objects = objects;
  }
  const overrides = projectOverrides(state.overrides);
  if (overrides) project.overrides = structuredClone(overrides);
  if (state.layerActions.length > 0) project.layerActions = state.layerActions.map((action) => ({ ...action }));
  if (project.version === 2 && state.printOrder === "sequential") {
    project.printOrder = "sequential";
    if (state.sequentialClearance > 0) project.sequentialClearanceMm = state.sequentialClearance;
    if (state.sequentialGantry > 0) project.sequentialGantryMm = state.sequentialGantry;
  }
  const name = `${state.mesh.name.replace(/\.(stl|3mf|step|stp|lime)$/i, "")}.lime`;
  const wrote = await saveProjectText(serializeProject(project), name);
  if (!wrote) return;
  markProjectClean();
  if (history.unsaved.length > 0) {
    pushToast(`The Model history of ${history.unsaved.join(", ")} could not be saved, so the part is saved without it.`, "info");
  }
}

export async function openProjectFile(file: File) {
  if (!confirmDiscard()) return;
  const parsed = parseProject(await file.text());
  if (!parsed.ok) {
    pushToast(parsed.message, "error", { label: "Retry", run: openProjectPicker });
    return;
  }
  await restoreProject(parsed.project);
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
  const unread = [...(project.unreadHistory ?? [])];
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
    state.layerActions = project.layerActions?.map((action) => ({ ...action })) ?? [];
    state.printOrder = project.printOrder === "sequential" ? "sequential" : "all-at-once";
    state.sequentialClearance = project.sequentialClearanceMm ?? 0;
    state.sequentialGantry = project.sequentialGantryMm ?? 0;
    state.selectedVolumeId = state.overrides.volumes[0]?.id ?? null;
    if (project.objects && project.objects.length > 0) {
      const loaded = await loadPlateObjects(project.objects);
      if (typeof loaded === "string") {
        pushToast(loaded, "error", { label: "Retry", run: openProjectPicker });
        return false;
      }
      state.plate = loaded.plate;
      applySelectedToState(loaded.plate);
      adoptSavedTrees(loaded.trees);
      unread.push(...loaded.unread);
      // An Add that started while these meshes were loading was aimed at the plate this replaced.
      session.meshEpoch += 1;
    }
    session.slicedEdits = [];
    session.slicedPaint = [];
    place("load");
    session.supportUi?.refresh();
    renderChrome();
    markProjectClean();
    if (unread.length > 0) {
      pushToast(`The Model history of ${unread.join(", ")} could not be read, so it starts again from the saved part.`, "info");
    }
    return true;
  } finally {
    session.projectRestoring = false;
  }
}

function fileObjects(trees: Awaited<ReturnType<typeof historyToSave>>["trees"]): PlateFileObject[] {
  // Bytes held twice (a root STEP that is the part's own solid or mesh) are encoded and hashed once.
  const records = new Map<ArrayBuffer, ReturnType<typeof meshRecord>>();
  const record = (name: string, bytes: ArrayBuffer) => {
    let made = records.get(bytes);
    if (!made) {
      made = meshRecord(name, new Uint8Array(bytes));
      records.set(bytes, made);
    }
    return { ...made, name };
  };
  return state.plate.objects.map((obj) => {
    const row: PlateFileObject = {
      id: obj.id,
      name: obj.name,
      mesh: record(obj.fileName, obj.bytes),
      placement: {
        orient: [...obj.orient] as ProjectPlacement["orient"],
        scale: obj.partScale,
        centered: obj.centered,
        offset: { ...obj.offset },
        stepTolerance: obj.stepTolerance,
      },
      supportEdits: obj.supportEdits.map((entry) => structuredClone(entry)),
    };
    if (!settingsEmpty(obj.settings)) row.settings = { ...obj.settings };
    if (obj.supportPaint.length > 0) row.supportPaint = obj.supportPaint.map((disk) => structuredClone(disk));
    if (obj.seamPaint.length > 0) row.seamPaint = obj.seamPaint.map((disk) => structuredClone(disk));
    const reinforce = dropEmptyReinforce(obj.reinforcement ?? []);
    if (reinforce.length > 0) row.reinforcement = reinforce.map((reg) => structuredClone(reg));
    if (obj.brep) row.brep = record(stepFileName(obj.fileName), obj.brep);
    const saved = trees.get(obj.id);
    if (saved) row.modelTree = { ...saved.tree, rootStep: record(saved.rootStep.name, saved.rootStep.bytes) };
    return row;
  });
}

function stepFileName(name: string) {
  const stem = name.replace(/\.(step|stp|stl|3mf)$/i, "");
  return `${stem || "solid"}.step`;
}

async function loadPlateObjects(objects: PlateFileObject[]) {
  const rows = [];
  const trees = new Map<string, SavedTree<{ name: string; bytes: ArrayBuffer }>>();
  const unread: string[] = [];
  // A root STEP with the bytes of a mesh or a solid read before it shares that buffer.
  const decoded = new Map<string, ArrayBuffer>();
  const decode = (record: { bytesBase64: string; byteLength: number; hash: string }) => {
    const id = `${record.hash}:${record.byteLength}`;
    const known = decoded.get(id);
    if (known) return known;
    const bytes = base64ToBytes(record.bytesBase64);
    if (!bytes) return null;
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    decoded.set(id, buffer);
    return buffer;
  };
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
    if (!decoded.has(`${row.mesh.hash}:${row.mesh.byteLength}`)) decoded.set(`${row.mesh.hash}:${row.mesh.byteLength}`, copy);
    let brepBytes: ArrayBuffer | undefined;
    if (row.brep) {
      const solid = decode(row.brep);
      if (!solid) return "The solid in this project is damaged.";
      brepBytes = solid;
    }
    const root = row.modelTree?.rootStep;
    const rootBytes = root?.bytesBase64 === undefined ? null : decode({ ...root, bytesBase64: root.bytesBase64 });
    if (row.modelTree && root && rootBytes) trees.set(row.id, { ...row.modelTree, rootStep: { name: root.name, bytes: rootBytes } });
    else if (row.modelTree) unread.push(row.name);
    rows.push({ ...row, bytes: copy, sourcePos, brepBytes });
  }
  return { plate: assemblePlate(rows), trees, unread };
}

function hashOf(bytes: ArrayBuffer): string {
  return meshRecord("part", new Uint8Array(bytes)).hash;
}
