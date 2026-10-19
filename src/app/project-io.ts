/** Save and open a `.lime` project against the live session. */
import { saveProjectText } from "../platform.ts";
import { confirmDiscard, markProjectClean } from "../project-dirty.ts";
import { emptyOverrides, projectOverrides } from "../overrides.ts";
import {
  assemblePlate,
  meshSeat,
  setMeshSeat,
  plateFileIsVersion2,
  settingsEmpty,
  type PlateFileObject,
} from "../plate.ts";
import { dropEmptyReinforce } from "../reinforcement.ts";
import { base64ToBytes } from "../base64.ts";
import { meshRecord, parseProject, serializeProject, type LimeProject, type ProjectPlacement, type ProjectProfile, type ToolTree } from "../project.ts";
import { geometryHash, projectSummary, thumbnailFromPng, type ProjectThumbnail } from "../project-thumb.ts";
import { capturePlatePng } from "./thumb-capture.ts";
import { saveProfile, type PrinterProfile } from "../profiles.ts";
import { fanDefaults, projectFan, withFan } from "../fan.ts";
import { filamentMatching, selectIn, selection } from "../ui/machine-library.ts";
import { loadMachineLibrary, storeMachineLibrary } from "./machine-library.ts";
import { loadSettingsLevel, setSettingsLevel } from "../ui/settings-panel.ts";
import { pushToast } from "../ui/toasts.ts";
import { adoptBytes, place, previewRemote, seatedPositions, stlPositions } from "./files.ts";
import { adoptSavedTrees, captureOpenSolid, historyToSave } from "./model.ts";
import { savedToolObjects, treeBody, type SavedTree } from "../model-tree-file.ts";
import { copyWorkplane } from "../workplane.ts";
import { solidFileName } from "../model-request.ts";
import { applySelectedToState, syncPlateFromState } from "./plate-sync.ts";
import { applyPreset, currentPreset, needsEngine, renderChrome, stale } from "./settings.ts";
import { customGcodeNotice } from "../layer-actions.ts";
import { setProjectTitle } from "./project-title.ts";
import { session, state } from "./state.ts";

/** A picture opened with the file. Kept when a later save cannot draw and the geometry is unchanged. */
let keptThumb: ProjectThumbnail | undefined;

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
  const { objects, tools } = fileObjects(history);
  if (plateFileIsVersion2(objects)) {
    project.version = 2;
    project.objects = objects;
    if (tools.length > 0) project.modelTools = tools;
  }
  const overrides = projectOverrides(state.overrides);
  if (overrides) project.overrides = structuredClone(overrides);
  if (state.layerActions.length > 0) project.layerActions = state.layerActions.map((action) => ({ ...action }));
  // --- A8. The record opened with the project, so a later save still carries its recipes. ---
  if (session.mcpModel) project.mcpModel = session.mcpModel;
  if (project.version === 2 && state.printOrder === "sequential") {
    project.printOrder = "sequential";
    if (state.sequentialClearance > 0) project.sequentialClearanceMm = state.sequentialClearance;
    if (state.sequentialGantry > 0) project.sequentialGantryMm = state.sequentialGantry;
  }
  const estimate = !stale() && state.result?.estimate ? state.result.estimate : undefined;
  project.summary = projectSummary(project, estimate ? { seconds: estimate.seconds, grams: estimate.filamentG } : undefined);
  const hash = geometryHash(project);
  const png = await capturePlatePng();
  if (png) {
    const drawn = thumbnailFromPng(png, hash, `lime-slice/${__APP_VERSION__}`);
    if (drawn) project.thumbnail = drawn;
  }
  if (!project.thumbnail && keptThumb?.meshHash === hash) project.thumbnail = keptThumb;
  const name = `${state.mesh.name.replace(/\.(stl|3mf|step|stp|lime)$/i, "")}.lime`;
  const wrote = await saveProjectText(serializeProject(project), name);
  if (!wrote) return;
  setProjectTitle(name);
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
  if (await restoreProject(parsed.project)) setProjectTitle(file.name);
}

export function forgetSavedThumbnail() {
  keptThumb = undefined;
}

/** A file from File > Open, a launch argument, or the MCP bridge: a project, or a mesh that replaces the plate. */
export async function openPickedFile(file: File) {
  if (/\.lime$/i.test(file.name)) {
    await openProjectFile(file);
    return;
  }
  await adoptBytes(file.name, await file.arrayBuffer());
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

/** A project saved before fan settings opens with the active filament's fan. */
function projectProfile(profile: ProjectProfile): PrinterProfile {
  return withFan(profile, projectFan(profile, selection(loadMachineLibrary())?.filament ?? fanDefaults("")));
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
  // --- A8. Kept before the meshes load, and still there if that load is replaced by a later open. ---
  session.mcpModel = project.mcpModel;
  const unread = [...(project.unreadHistory ?? [])];
  const doc = session.docEpoch;
  try {
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    await adoptBytes(project.mesh.name, copy);
    if (session.docEpoch !== doc) return false;
    state.orient = project.placement.orient;
    state.partScale = project.placement.scale;
    state.centered = project.placement.centered;
    state.offset = { ...project.placement.offset };
    state.stepTolerance = project.placement.stepTolerance;
    state.profile = projectProfile(project.profile);
    saveProfile(state.profile);
    // A project saved at a filament's own temperatures selects that filament, and does not rewrite it.
    const match = filamentMatching(loadMachineLibrary(), state.profile);
    if (match && match !== loadMachineLibrary().filamentId) {
      const next = selectIn(loadMachineLibrary(), loadMachineLibrary().printerId, match, loadMachineLibrary().nozzleMm);
      if (typeof next !== "string") storeMachineLibrary(next);
    }
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
      const loaded = await loadPlateObjects(project.objects, project.modelTools ?? []);
      if (typeof loaded === "string") {
        pushToast(loaded, "error", { label: "Retry", run: openProjectPicker });
        return false;
      }
      if (session.docEpoch !== doc) return false;
      state.plate = loaded.plate;
      applySelectedToState(loaded.plate);
      adoptSavedTrees(loaded.trees, project.modelTools ?? []);
      unread.push(...loaded.unread);
      // An Add that started while these meshes were loading was aimed at the plate this replaced.
      session.meshEpoch += 1;
    }
    session.slicedEdits = [];
    session.slicedPaint = [];
    place("load");
    session.supportUi?.refresh();
    renderChrome();
    keptThumb = project.thumbnail;
    markProjectClean();
    if (unread.length > 0) {
      pushToast(`The Model history of ${unread.join(", ")} could not be read, so it starts again from the saved part.`, "info");
    }
    const custom = customGcodeNotice(state.layerActions);
    if (custom) pushToast(custom, "info");
    return true;
  } finally {
    session.projectRestoring = false;
  }
}

function fileObjects({ trees, tools }: Awaited<ReturnType<typeof historyToSave>>): { objects: PlateFileObject[]; tools: ToolTree[] } {
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
  const fileTree = (saved: SavedTree<{ name: string; bytes: ArrayBuffer }>): NonNullable<PlateFileObject["modelTree"]> => {
    if (saved.rootFeature) return { ...treeBody(saved), rootFeature: saved.rootFeature };
    if (saved.rootPrimitive) return { ...treeBody(saved), rootPrimitive: saved.rootPrimitive };
    return { ...treeBody(saved), rootStep: record(saved.rootStep.name, saved.rootStep.bytes) };
  };
  const objects = state.plate.objects.map((obj) => {
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
    if (obj.brep) row.brep = record(solidFileName(obj.fileName, obj.brep), obj.brep);
    if (obj.modelPose) row.modelPose = { m: [...obj.modelPose.m], t: [...obj.modelPose.t] };
    if (obj.workplane) row.workplane = copyWorkplane(obj.workplane);
    const seat = meshSeat(obj.bytes);
    if (seat !== undefined) row.meshSeatMm = seat;
    const saved = trees.get(obj.id);
    if (saved) row.modelTree = fileTree(saved);
    return row;
  });
  return { objects, tools: tools.map(({ id, name, tree }) => ({ id, name, modelTree: fileTree(tree) })) };
}

async function loadPlateObjects(objects: PlateFileObject[], tools: readonly ToolTree[]) {
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
  /** A plate object's or a kept tool's tree into `trees`, with its root STEP's bytes. False when it has one that does not read. */
  const adopt = ({ id, modelTree }: { id: string; modelTree?: PlateFileObject["modelTree"] }) => {
    if (!modelTree) return true;
    if (modelTree.rootFeature) {
      trees.set(id, { ...treeBody(modelTree), rootFeature: modelTree.rootFeature });
      return true;
    }
    if (modelTree.rootPrimitive) {
      trees.set(id, { ...treeBody(modelTree), rootPrimitive: modelTree.rootPrimitive });
      return true;
    }
    const root = modelTree.rootStep;
    const bytes = root?.bytesBase64 === undefined ? null : decode({ ...root, bytesBase64: root.bytesBase64 });
    if (!root || !bytes) return false;
    trees.set(id, { ...treeBody(modelTree), rootStep: { name: root.name, bytes } });
    return true;
  };
  for (const row of objects) {
    const bytes = base64ToBytes(row.mesh.bytesBase64);
    if (!bytes) return "The mesh in this project is damaged.";
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    let sourcePos = needsEngine(row.mesh.name) ? null : stlPositions(copy);
    if (!sourcePos && state.sourcePos && state.mesh && row.mesh.hash === hashOf(state.mesh.bytes) && row.mesh.name === state.mesh.name) {
      sourcePos = state.sourcePos;
      const seat = meshSeat(state.mesh.bytes);
      if (seat !== undefined) setMeshSeat(copy, seat);
    }
    if (!sourcePos) sourcePos = seatedPositions(copy, await previewRemote(row.mesh.name, copy));
    if (!sourcePos) return `Could not read ${row.name}.`;
    if (!decoded.has(`${row.mesh.hash}:${row.mesh.byteLength}`)) decoded.set(`${row.mesh.hash}:${row.mesh.byteLength}`, copy);
    let brepBytes: ArrayBuffer | undefined;
    if (row.brep) {
      const solid = decode(row.brep);
      if (!solid) return "The solid in this project is damaged.";
      brepBytes = solid;
    }
    if (!adopt(row)) unread.push(row.name);
    rows.push({ ...row, bytes: copy, sourcePos, brepBytes });
  }
  // A kept tool's tree after the plate's, so a root STEP it shares with them is decoded once.
  for (const tool of tools) if (!adopt(tool)) unread.push(tool.name);
  // A join whose tool's tree did not read could not rebuild: its tree is left out too, at any depth, as the file's reader does.
  const names = new Map([...objects, ...tools].map((row) => [row.id, row.name]));
  for (let changed = true; changed; ) {
    changed = false;
    for (const [id, tree] of trees) {
      if ([...savedToolObjects(tree)].every((tool) => trees.has(tool))) continue;
      trees.delete(id);
      unread.push(names.get(id) ?? id);
      changed = true;
    }
  }
  return { plate: assemblePlate(rows), trees, unread };
}

function hashOf(bytes: ArrayBuffer): string {
  return meshRecord("part", new Uint8Array(bytes)).hash;
}
