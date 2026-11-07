/** Save and open a `.lime` project against the live session. */
import { saveProjectText } from "../platform.ts";
import { confirmDiscard, markProjectClean } from "../project-dirty.ts";
import { emptyOverrides, projectOverrides } from "../overrides.ts";
import {
  assemblePlate,
  meshSeat,
  meshTokenOf,
  setMeshSeat,
  plateFileIsVersion2,
  settingsEmpty,
  type PlateFileObject,
} from "../plate.ts";
import { dropEmptyReinforce } from "../reinforcement.ts";
import { base64ToBytes } from "../base64.ts";
import { meshRecord, type HeldPiece, type LimeProject, type ProjectPlacement, type ProjectProfile, type ProjectResult, type ToolTree } from "../project-envelope.ts";
import { decodeProjectEnvelope, encodeProject } from "../project-pack.ts";
import { geometryHash, projectSummary, thumbnailFromPng, type ProjectThumbnail } from "../project-thumb.ts";
import { capturePlatePng } from "./thumb-capture.ts";
import { saveProfile, type PrinterProfile } from "../profiles.ts";
import { fanDefaults, projectFan, withFan } from "../fan.ts";
import { filamentMatching, selectIn, selection } from "../ui/machine-library.ts";
import { loadMachineLibrary, storeMachineLibrary } from "./machine-library.ts";
import { loadSettingsLevel, setSettingsLevel } from "../ui/settings-panel.ts";
import { pushToast } from "../ui/toasts.ts";
import { adoptBytes, place, previewRemote, seatedPositions, stlPositions } from "./files.ts";
import { loadModel, modelApi, withModel } from "./workspaces.ts";
import type { HeldToSave, historyToSave } from "./model.ts";
import type { SavedTree } from "../model-tree-file.ts";
import { savedToolObjects, treeBody } from "../saved-tree-body.ts";
import { copyWorkplane } from "../workplane.ts";
import { setStage } from "./viewer.ts";
import { cloneStudy } from "../sim/study-data.ts";
import { solidFileName } from "../brep-file.ts";
import { applySelectedToState, syncPlateFromState } from "./plate-sync.ts";
import { applyPreset, currentPreset, needsEngine, renderChrome, stale } from "./settings.ts";
import { customGcodeNotice } from "../layer-actions.ts";
import { setProjectTitle } from "./project-title.ts";
import { projectFileName } from "../project-file-name.ts";
import { session, state } from "./state.ts";
import { dropProjectFonts, shelf } from "./user-fonts.ts";
import { clearStressCells } from "../sim/stress-cells.ts";

/** A picture opened with the file. Kept when a later save cannot draw and the geometry is unchanged. */
let keptThumb: ProjectThumbnail | undefined;

export async function saveCurrentProject() {
  if (!state.mesh) {
    pushToast("Load a mesh before saving a project.", "info");
    return;
  }
  // Model holds the open solid, the trees and the plugin library a save writes: it loads first, if it had not.
  const model = await loadModel();
  await model.captureOpenSolid();
  // The trees are matched to the plate's meshes as written below.
  syncPlateFromState();
  const history = await model.historyToSave();
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
  const { objects, tools, pieces } = fileObjects(history);
  if (plateFileIsVersion2(objects)) {
    project.version = 2;
    project.objects = objects;
    if (tools.length > 0) project.modelTools = tools;
    if (pieces.length > 0) project.heldPieces = pieces;
  }
  const overrides = projectOverrides(state.overrides);
  if (overrides) project.overrides = structuredClone(overrides);
  if (state.layerActions.length > 0) project.layerActions = state.layerActions.map((action) => ({ ...action }));
  // --- A8. The record opened with the project, so a later save still carries its recipes. ---
  if (session.mcpModel) project.mcpModel = session.mcpModel;
  // --- Plugins (D9): a stamp whose code only the library holds gets a copy here, so the project rebuilds anywhere.
  const plugins = model.projectCopies(session.plugins, model.stampedShas(project.objects), model.pluginLibrary());
  if (plugins) project.plugins = plugins;
  // --- Text milestone 4 (D5): the fonts of the person's that texts use go in the project, whole, or as the outlines of the
  // letters used when the font's licence forbids embedding it.
  const fonts = await shelf.recordsFor(project, session.fonts);
  if (fonts) project.fonts = fonts;
  if (Object.keys(session.parameters).length > 0) project.parameters = { ...session.parameters };
  if (project.version === 2 && session.assemblies.length > 0) project.assemblies = structuredClone(session.assemblies);
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
  const name = projectFileName(session.projectTitle, state.mesh.name);
  const wrote = await saveProjectText(await encodeProject(project), name);
  if (!wrote) return;
  setProjectTitle(name);
  markProjectClean();
  if (history.unsaved.length > 0) {
    pushToast(`The Model history of ${history.unsaved.join(", ")} could not be saved, so the part is saved without it.`, "info");
  }
}

export async function openProjectFile(file: File) {
  if (!(await confirmDiscard())) return;
  const parsed = await readProjectText(await file.text());
  if (!parsed.ok) {
    pushToast(parsed.message, "error", { label: "Retry", run: openProjectPicker });
    return;
  }
  if (await restoreProject(parsed.project)) setProjectTitle(file.name);
}

/**
 * A file's project, read whole. The envelope reads with the app; a file with Model sections (a history, a kept tool, a
 * held piece) loads their reader first, which is not in the app's first chunk.
 */
async function readProjectText(text: string): Promise<ProjectResult> {
  const parsed = await decodeProjectEnvelope(text);
  if (!parsed.ok || !parsed.project.modelSections) return parsed;
  try {
    const { readModelSections } = await import("../project-model.ts");
    return { ok: true, project: readModelSections(parsed.project) };
  } catch (err) {
    return { ok: false, message: `This project's Model history could not be read: ${err instanceof Error ? err.message : String(err)}` };
  }
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
  // A project with Model steps replays them in Model: Model loads before anything of the project is taken, so the
  // plate never shows its parts before their steps.
  const steps = !!project.objects?.some((obj) => obj.modelTree) || (project.modelTools?.length ?? 0) > 0 || (project.heldPieces?.length ?? 0) > 0;
  if (steps) {
    try {
      await loadModel();
    } catch (err) {
      pushToast(`Model could not load, so this project was not opened: ${err instanceof Error ? err.message : String(err)}`, "error", { label: "Retry", run: openProjectPicker });
      return false;
    }
  }
  session.projectRestoring = true;
  // The last study's colours, deformed copy and Preview cells belong to the old plate.
  modelApi()?.closeStress();
  clearStressCells();
  // --- A8. Kept before the meshes load, and still there if that load is replaced by a later open. ---
  session.mcpModel = project.mcpModel;
  session.plugins = project.plugins;
  // --- Text milestone 4: the project's fonts go to the engine before its history is rebuilt from them.
  session.fonts = project.fonts;
  dropProjectFonts();
  const fontNotes = await shelf.adopt(project.fonts);
  session.parameters = project.parameters ? { ...project.parameters } : {};
  session.assemblies = project.assemblies ? structuredClone(project.assemblies) : [];
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
      const loaded = await loadPlateObjects(project.objects, project.modelTools ?? [], project.heldPieces ?? []);
      if (typeof loaded === "string") {
        pushToast(loaded, "error", { label: "Retry", run: openProjectPicker });
        return false;
      }
      if (session.docEpoch !== doc) return false;
      // Model has loaded if the file has steps (above); a plate without steps needs none of it.
      const model = modelApi();
      state.plate = loaded.plate;
      applySelectedToState(loaded.plate);
      model?.adoptSavedTrees(loaded.trees, project.modelTools ?? []);
      model?.adoptHeldPieces(loaded.pieces);
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
    if (fontNotes.length > 0) pushToast(fontNotes.join(" "), "info");
    const custom = customGcodeNotice(state.layerActions);
    if (custom) pushToast(custom, "info");
    modelApi()?.noteParametersBuilt();
    void offerProjectPlugins(project.plugins, doc);
    // After the open, not in it: the held pieces' solids are cut again while the plate is already in use.
    window.setTimeout(() => {
      if (session.docEpoch === doc) modelApi()?.warmHeldPieces();
    }, 0);
    return true;
  } finally {
    session.projectRestoring = false;
  }
}

/**
 * --- Plugin milestone 8 (D10): a project from someone else may carry plugins the library lacks. Say so once, with Review
 * (the Plugins panel's "In this project", where Add to library shows each one's code first); never add them silently.
 */
async function offerProjectPlugins(plugins: Record<string, string> | undefined, doc: number) {
  if (!plugins || Object.keys(plugins).length === 0) return;
  const model = await loadModel();
  if (!(await model.libraryIo())) return;
  const offer = await model.projectPluginsOffer(plugins, await model.loadLibrary());
  if (!offer || session.docEpoch !== doc) return;
  pushToast(offer.text, "info", { label: "Review", run: () => { setStage("model"); withModel((open) => open.openPluginsPanel()); } });
}

function fileObjects({ trees, tools, pieces }: Awaited<ReturnType<typeof historyToSave>>): { objects: PlateFileObject[]; tools: ToolTree[]; pieces: HeldPiece[] } {
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
    if (obj.frame === "part") row.frame = "part";
    if (obj.workplane) row.workplane = copyWorkplane(obj.workplane);
    if (obj.sim) row.sim = cloneStudy(obj.sim);
    if (obj.pivot) row.pivot = [...obj.pivot] as [number, number, number];
    if (obj.chain) row.chain = { parent: obj.chain.parent, offset: [...obj.chain.offset] as [number, number, number], turn: [...obj.chain.turn] as ProjectPlacement["orient"] };
    if (obj.jointLimits) {
      row.jointLimits = {
        ...(obj.jointLimits.x ? { x: [...obj.jointLimits.x] as [number, number] } : {}),
        ...(obj.jointLimits.y ? { y: [...obj.jointLimits.y] as [number, number] } : {}),
        ...(obj.jointLimits.z ? { z: [...obj.jointLimits.z] as [number, number] } : {}),
      };
    }
    const seat = meshSeat(obj.bytes);
    if (seat !== undefined) row.meshSeatMm = seat;
    const saved = trees.get(obj.id);
    if (saved) row.modelTree = fileTree(saved);
    return row;
  });
  const held = pieces.map(({ object, node, index, pins, mesh }): HeldPiece => {
    const seat = meshSeat(mesh.bytes);
    return {
      object,
      node,
      ...(pins ? { pins } : { index }),
      mesh: record(mesh.name, mesh.bytes),
      ...(seat !== undefined ? { meshSeatMm: seat } : {}),
    };
  });
  return { objects, tools: tools.map(({ id, name, tree }) => ({ id, name, modelTree: fileTree(tree) })), pieces: held };
}

async function loadPlateObjects(objects: PlateFileObject[], tools: readonly ToolTree[], held: readonly HeldPiece[]) {
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
  // A held piece whose mesh does not read is left out, and cut again when its step is shown.
  const pieces: HeldToSave[] = [];
  for (const piece of held) {
    // A buffer of its own: a mesh is known by its buffer, and two pieces can have the same bytes.
    const bytes = decode(piece.mesh)?.slice(0);
    const sourcePos = bytes ? stlPositions(bytes) : null;
    if (!bytes || !sourcePos) continue;
    const solid = piece.brep ? decode(piece.brep) : null;
    if (piece.meshSeatMm !== undefined) setMeshSeat(bytes, piece.meshSeatMm);
    pieces.push({ object: piece.object, node: piece.node, ...(piece.pins ? { pins: piece.pins } : { index: piece.index }), mesh: { name: piece.mesh.name, bytes, sourcePos, token: meshTokenOf(bytes), ...(solid ? { step: solid } : {}) } });
  }
  return { plate: assemblePlate(rows), trees, unread, pieces };
}

function hashOf(bytes: ArrayBuffer): string {
  return meshRecord("part", new Uint8Array(bytes)).hash;
}
