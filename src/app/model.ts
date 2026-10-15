import { base64ToBytes, bytesToBase64 } from "../base64";
import { boundsOf, encodeStl, settleBy, type Bounds } from "../mesh-place";
import {
  IDENTITY_POSE,
  applyPose,
  boxUnder,
  inversePose,
  isIdentity,
  newSolidPose,
  placeFields,
  poseFromPlace,
  posedBounds,
  toSolidOp,
  turnDir,
  type Affine,
  type PlaceFields,
} from "../model-space";
import { primitiveBounds, primitiveName, rootSpec, type PrimitiveSpec } from "../model-primitive";
import { markProjectDirty } from "../project-dirty";
import { unionBox } from "../measure";
import type { ModelPick } from "../model-view";
import { decodeSolid, type ParsedSolid } from "../model-reply";
import { holeAxis, lastFace, outwardFromMesh, selectedEdges } from "../model-blend";
import { nextModelPicks, selectionCountLabel } from "../model-select";
import { contextParts } from "../model-context";
import { PROBE_WAIT_MS, isProbed, probeFromBody, probeKey, type ProbeView } from "../model-feasibility";
import { boxExtentAlong, extentAlong, extentMemo, facePlane, planeFor, splitBase, splitNote, type AxisExtent, type FacePlane, type SplitState } from "../model-plane";
import {
  ROOT,
  childWithOp,
  dropped,
  jumped,
  newTree,
  nodeWithMesh,
  opLabel,
  pathTo,
  reachableTrees,
  redoTarget,
  reserveId,
  rootLabel,
  savedNodes,
  subtree,
  undoTarget,
  visitStep,
  withChild,
  withNode,
  type Fingerprint,
  type ModelOp,
  type ModelRoot,
  type ModelTree,
  type NodeId,
  type PlateMesh,
  type PrepareKeep,
  type Vec3,
} from "../model-tree";
import { loadedTree, savedTree, type SavedTree } from "../model-tree-file";
import {
  closeModelTool,
  fieldPrimitive,
  mountModelChrome,
  openModelTool,
  refreshModelGhost,
  setModelEditable,
  setModelProbe,
  setModelWaiting,
  syncModelChrome,
  splitMode,
  syncModelSolid,
  syncPlaceFields,
  type PlacePhase,
} from "../ui/model-chrome";
import { mountModelHistory, syncModelHistory } from "../ui/model-history";
import { dropRefusal } from "../model-history";
import { addedSolid, addedSplit, freshPlateId, meshSeat, meshToModel, meshTokenOf, modelPoseOf, setMeshSeat, withBrepFor, withModelPose } from "../plate";
import { authHeaders } from "../ui/api-base";
import { livePlate, openMeshPicker, place } from "./files";
import { beginEdit, editHistoryRefs, endModelVisit, flushEdit, markModelEdit, noteEdit, patchEditBrep } from "./history";
import { fx } from "./fx";
import { modelerFailure, plainModelError } from "./model-error";
import { freshTreeKey, modelTrees } from "./model-trees";
import { applySelectedToState, syncPlateFromState } from "./plate-sync";
import { apiBase, apiToken, isStepName } from "./settings";
import { state } from "./state";

type Body = Record<string, unknown>;

/** The tree in the view, the plate object it belongs to, and the solid of its current node. */
interface Opened {
  objectId: string;
  key: string;
  solid: ParsedSolid;
}

const VIEW_ONLY = "Surfaces only. This file can be measured but not edited.";
const BROKEN = "This step could not be rebuilt, so it and the steps after it are unavailable.";
/** Parsed solids of recently shown nodes, so a jump back to one needs no engine call. */
const SOLID_CACHE = 4;

let ticket = 0;
let picks: ModelPick[] = [];
let busy = false;
/** A `goto` for `jumpTarget` is on its way. A newer jump takes over from it (`jumpSerial`); edits, Undo, and STEP are off until it lands. */
let jumping = false;
let jumpSerial = 0;
let jumpTarget: NodeId | null = null;
let probeSerial = 0;
let probeTimer = 0;
let pendingProbe: (() => void) | null = null;
let open: Opened | null = null;
/** The plate object Model last opened, so a selection change elsewhere can tell it moved. */
let shownFor: string | null = null;
/** A tree resumed above its broken committed step: the plate keeps that step's mesh until the user moves. */
let parked: string | null = null;
const solids = new Map<string, ParsedSolid>();
/** Mesh tokens whose plate objects already carry that shape's STEP, or whose mesh is the STEP file itself. */
const stepKnown = new Set<string>();
/** STEP exports on their way, by mesh token, so a save during the write after leaving Model waits for it. */
const writing = new Map<string, Promise<ArrayBuffer | string>>();
/** Kernel answers by `probeKey`. */
const answers = new Map<string, ProbeView>();
/** Restores in flight, by tree key. */
const restoring = new Map<string, Promise<string | null>>();

/**
 * A tree from a saved project, until the engine has the whole of it. Once `live`, the engine holds
 * the plate's step (`node`), read from that step's STEP, as its root: enough to look and measure.
 * An edit, or a call on any other step, first opens the whole tree from its root STEP and ops
 * (`whole`, while that is on its way). Every call waits for that, and for a read of the step's STEP
 * (`reading`) after an engine restart.
 */
interface Seed {
  node: NodeId;
  live: boolean;
  whole: Promise<string | null> | null;
  reading: Promise<void> | null;
}
const seeds = new Map<string, Seed>();
/** Solids the engine answered from a seed's STEP-read step: shown only while that seed stands alone. */
const readSolids = new WeakSet<ParsedSolid>();

/** The object the camera last framed. A new solid of the same object keeps the user's view. */
let framedFor: string | null = null;
/** Place moves of the open object in this visit, for Undo and Redo while Place is open. One gesture is one step. */
let placeUndo: Affine[] = [];
let placeRedo: Affine[] = [];
/** The pose a Place gesture started from, while it is under way. */
let placeBefore: Affine | null = null;
let placeTimer = 0;
/** A typed or scrubbed Place number is one step once it rests this long. A drag ends its own step. */
const PLACE_SETTLE_MS = 400;
/** Each solid's, and each plate mesh's, box in its own frame. */
const ownBoxes = new WeakMap<Float32Array, Bounds>();

export function bindModelView() {
  fx.model?.onPick((pick: ModelPick | null, shift: boolean) => void onPick(pick, shift));
  document.querySelector("#modelPickFace")?.addEventListener("click", () => setMode("face"));
  document.querySelector("#modelPickEdge")?.addEventListener("click", () => setMode("edge"));
  document.querySelector("#modelApply")?.addEventListener("click", () => void applyTool());
  document.querySelector("#modelStep")?.addEventListener("click", () => void runExport());
  // While Place is open, Undo and Redo step its moves; the solid's history waits until it closes.
  document.querySelector("#modelUndo")?.addEventListener("click", () => {
    if (openModelTool() === "place") placeStep("undo");
    else void step(undoTarget, "Edit undone.");
  });
  document.querySelector("#modelRedo")?.addEventListener("click", () => {
    if (openModelTool() === "place") placeStep("redo");
    else void step(redoTarget, "Edit redone.");
  });
  document.querySelector("#modelResetView")?.addEventListener("click", (ev) => frameModel((ev as MouseEvent).shiftKey));
  document.querySelector("#modelEmptyNew")?.addEventListener("click", () => document.querySelector<HTMLButtonElement>("#modelToolNew")?.click());
  document.querySelector("#modelEmptyOpen")?.addEventListener("click", () => openMeshPicker());
  mountModelChrome({
    clearSelection() {
      picks = [];
      fx.model?.highlight([]);
      syncModelChrome([]);
      if (open) readout(`${about(open.solid)} Pick a face or an edge.`);
    },
    split() {
      return splitState();
    },
    splitLegal() {
      return splitLegal();
    },
    paramsChanged(typed) {
      // Place closed while a typed move was settling: that move is its step now, before Undo means the solid again.
      if (placeBefore && openModelTool() !== "place") endPlace();
      scheduleProbe(typed ? PROBE_WAIT_MS : 0);
      syncUndo();
    },
    probeNow() {
      if (!pendingProbe) return;
      window.clearTimeout(probeTimer);
      sendPending();
    },
    solidBox() {
      return openBox();
    },
    edgePoints(edge) {
      const points = open?.solid.edges.find((item) => item.id === edge)?.points;
      const pose = openPose();
      if (!points || isIdentity(pose)) return points ?? null;
      const out = new Float32Array(points.length);
      for (let i = 0; i + 2 < points.length; i += 3) out.set(applyPose(pose, [points[i]!, points[i + 1]!, points[i + 2]!]), i);
      return out;
    },
    holeAxis() {
      return drillAxis();
    },
    placeFields() {
      return open ? placeFields(openPose(), pivotOf(open.solid)) : null;
    },
    placeMoved,
    newSolidAt,
    frameNewSolid(spec) {
      const others = plateBoxes();
      fx.model?.frame(unionBox([primitiveBounds(newSolidAt(spec)), ...others])!);
    },
  });
  mountModelHistory({
    jump(node) {
      void jumpTo(node);
    },
    rename: renameStep,
    dropRefusal: whyKeepBranch,
    drop: dropBranch,
  });
}

function treeOf(at: Opened | null): ModelTree | null {
  return at ? modelTrees.get(at.key) ?? null : null;
}

/** The engine's name for one node's shape, which never changes. */
function nodeName(key: string, node: NodeId) {
  return `${key}#${node}`;
}

/**
 * Fillet, chamfer, hole, and boolean ask the kernel whether the edit works before Apply.
 * A number still being typed waits `wait` ms; a newer edit discards the older answer.
 * An answer already known for this node and numbers is used without asking.
 */
function scheduleProbe(wait: number) {
  window.clearTimeout(probeTimer);
  pendingProbe = null;
  probeSerial += 1;
  const serial = probeSerial;
  const at = open;
  const tree = treeOf(at);
  const tool = openModelTool();
  const op = at?.solid.editable && isProbed(tool) ? toolOp(tool) : null;
  if (!at || !tree || !op) {
    setModelProbe(null);
    return;
  }
  const node = tree.current;
  const key = probeKey(nodeName(at.key, node), op);
  const known = answers.get(key);
  if (known) {
    setModelProbe(known);
    return;
  }
  setModelProbe({ phase: "checking" });
  pendingProbe = () => void sendProbe(serial, key, at.key, node, op);
  if (wait > 0) probeTimer = window.setTimeout(sendPending, wait);
  else sendPending();
}

function sendPending() {
  const send = pendingProbe;
  pendingProbe = null;
  send?.();
}

async function sendProbe(serial: number, key: string, tree: string, node: NodeId, op: ModelOp) {
  const body = await treeCall(tree, node, { call: "probe", key: tree, node, op });
  const view = probeFromBody(body);
  if (typeof body.ok === "boolean") remember(key, view);
  if (serial !== probeSerial || state.stage !== "model") return;
  setModelProbe(view);
}

function remember(key: string, view: ProbeView) {
  if (answers.size >= 256) answers.clear();
  answers.set(key, view);
}

/** The open tool's edit in the solid's own frame, from its model-space fields. Null when it cannot run yet. */
function toolOp(tool: string | null | undefined): ModelOp | null {
  const op = fieldOp(tool);
  return op && toSolidOp(op, openPose());
}

/** The open tool's edit as its fields say it, in model space. */
function fieldOp(tool: string | null | undefined): ModelOp | null {
  const origin: Vec3 = [num("#modelX"), num("#modelY"), num("#modelZ")];
  switch (tool) {
    case "fillet":
    case "chamfer": {
      const edges = selectedEdges(picks);
      return edges.length === 0 ? null : { kind: tool, edges, size: num("#modelBlend") };
    }
    case "hole":
      return { kind: "hole", origin, axis: drillAxis(), radius: num("#modelHoleR"), depth: num("#modelHoleD") };
    case "boolean":
      return { kind: "boolean", op: boolOp(), ...fieldPrimitive() };
    case "split": {
      const split = splitState();
      return "plan" in split ? { kind: "split", origin: split.plan.origin, normal: split.plan.normal } : null;
    }
    case "scale":
      return { kind: "scale", factor: num("#modelFactor") };
    default:
      return null;
  }
}

function boolOp(): "fuse" | "cut" | "common" {
  if (document.querySelector("#modelCut")?.getAttribute("aria-pressed") === "true") return "cut";
  if (document.querySelector("#modelCommon")?.getAttribute("aria-pressed") === "true") return "common";
  return "fuse";
}

/**
 * The plate takes the node the view shows: that node's mesh, and the Prepare state saved for it.
 * Model edits and jumps change nothing else on the plate, so this runs on leaving Model, and before
 * a slice, an export, a save, or a plate action that reads the open object's mesh.
 */
export function commitModel() {
  const at = open;
  let tree = treeOf(at);
  const plan = tree ? visitStep(tree) : null;
  if (!at || !tree || !plan || !state.mesh || at.objectId !== state.plate.selectedId || parked === at.key) return;
  const node = tree.nodes.get(plan.to);
  if (!node || at.solid.id !== plan.to) return;
  noteEdit();
  tree = withNode(tree, plan.from, { keep: liveKeep() });
  const mesh = node.mesh ?? meshOf(at.solid);
  state.mesh = { name: mesh.name, bytes: mesh.bytes };
  state.sourcePos = new Float32Array(mesh.sourcePos);
  const keep = plan.keep;
  state.supportEdits = keep ? structuredClone(keep.supportEdits) : [];
  state.supportPaint = keep ? structuredClone(keep.supportPaint) as typeof state.supportPaint : [];
  state.seamPaint = keep ? structuredClone(keep.seamPaint) as typeof state.seamPaint : [];
  state.reinforcement = keep ? structuredClone(keep.reinforcement) as typeof state.reinforcement : [];
  if (keep) state.partScale = keep.partScale;
  else if (plan.resetScale) state.partScale = 1;
  setBrep(at.objectId, mesh.step);
  modelTrees.set(at.key, { ...withNode(tree, plan.to, { mesh }), committed: plan.to });
  // A Prepare undo can have taken off the piece of a split this commit crosses on its way down: the
  // plate gets it back. A piece removed by hand stays removed while the plate stays below its split.
  syncPlateFromState();
  const above = new Set(pathTo(tree, plan.from));
  for (const id of pathTo(tree, plan.to)) {
    if (above.has(id)) continue;
    const key = tree.nodes.get(id)?.piece;
    const piece = key ? modelTrees.get(key) : undefined;
    const pieceMesh = piece?.nodes.get(piece.committed)?.mesh;
    if (key && pieceMesh && !state.plate.objects.some((obj) => obj.modelTree === key)) placePiece(key, pieceMesh);
  }
  place();
  flushEdit();
  markModelEdit();
  syncUndo();
}

function liveKeep(): PrepareKeep {
  return structuredClone({
    supportEdits: state.supportEdits,
    supportPaint: state.supportPaint,
    seamPaint: state.seamPaint,
    reinforcement: state.reinforcement,
    partScale: state.partScale,
  }) as PrepareKeep;
}

function meshOf(solid: ParsedSolid): PlateMesh {
  const positions = new Float32Array(solid.positions);
  const seat = settleBy(positions);
  const name = stlName(state.mesh?.name ?? "solid");
  const bytes = encodeStl(positions, name);
  setMeshSeat(bytes, seat);
  return { name, bytes, sourcePos: positions, token: meshTokenOf(bytes) };
}

/**
 * Before a project save: the plate takes the shown node, and every object's solid gets its STEP. A
 * solid the engine can no longer write loses its STEP rather than keep one from an older shape.
 */
export async function captureOpenSolid() {
  commitModel();
  const failed = await writeSteps();
  for (const token of failed) putStep(token, undefined);
}

type SavedRoot = { rootStep: { name: string; bytes: ArrayBuffer } } | { rootPrimitive: PrimitiveSpec };

/** What a saved tree reopens from: its root STEP, or a new solid's primitive. A piece's is its root's STEP, once written. */
function savedRootOf(tree: ModelTree): SavedRoot | null {
  if (tree.root.kind === "step") return { rootStep: { name: tree.root.name, bytes: tree.root.bytes } };
  if (tree.root.kind === "primitive") return { rootPrimitive: tree.root.solid };
  const root = tree.nodes.get(ROOT)?.mesh;
  return root?.step ? { rootStep: { name: stepFileName(root.name), bytes: root.step } } : null;
}

type TreeToSave = SavedTree<{ name: string; bytes: ArrayBuffer }>;

/**
 * What `.lime` keeps of each plate object's tree, by object id: the tree Model would resume for the
 * object's mesh, when it has a step, a name, a piece a kept split names, or a primitive root (a new
 * solid has no file to open again). A split piece's tree is kept from the STEP of its own root,
 * written here if Model has not, so it opens without the part it was cut from; `unsaved` names the
 * objects whose root the engine could not write. Trees of objects no longer on the plate are not
 * saved. Run after `captureOpenSolid`.
 */
export async function historyToSave(): Promise<{ trees: Map<string, TreeToSave>; unsaved: string[] }> {
  const held = new Map<string, { name: string; key: string; node: NodeId }>();
  for (const obj of state.plate.objects) {
    const token = meshTokenOf(obj.bytes);
    const tree = treeFor(obj.id, obj.modelTree, token);
    const node = tree ? nodeWithMesh(tree, token) : null;
    if (tree && node != null) held.set(obj.id, { name: obj.name, key: tree.key, node });
  }
  const treeOfKey = (key: string) => modelTrees.get(key)!;
  const linked = (keys: Iterable<string>) => new Set([...keys].flatMap((key) => [...treeOfKey(key).nodes.values()].flatMap((node) => (node.piece ? [node.piece] : []))));
  const named = linked([...held.values()].map(({ key }) => key));
  const roots = new Map<string, SavedRoot>();
  const unsaved: string[] = [];
  for (const [id, { name, key }] of held) {
    // A root STEP written below can outlast the tree: a new file can replace the plate meanwhile.
    if (!modelTrees.has(key)) continue;
    const tree = treeOfKey(key);
    if (tree.nodes.size === 1 && !tree.nodes.get(ROOT)?.name && !named.has(key) && tree.root.kind !== "primitive") continue;
    const root = tree.nodes.get(ROOT)?.mesh;
    if (!savedRootOf(tree) && tree.root.kind === "piece" && root) await writeStep(root.token, key, ROOT);
    const saved = modelTrees.has(key) ? savedRootOf(treeOfKey(key)) : null;
    if (saved) roots.set(id, saved);
    else unsaved.push(name);
  }
  const owner = new Map([...roots.keys()].map((id) => [held.get(id)!.key, id]));
  const trees = new Map<string, TreeToSave>();
  for (const [id, root] of roots) {
    const { key, node } = held.get(id)!;
    if (modelTrees.has(key)) trees.set(id, { ...savedTree(treeOfKey(key), node, (piece) => owner.get(piece)), ...root });
  }
  return { trees, unsaved };
}

/**
 * A project opened: each saved tree joins its plate object under a fresh key, so a file opened
 * twice never meets its own trees in the engine. The engine hears of it when Model needs a step:
 * the plate's step then opens from the object's `brep`, as a STEP file does, and the rest of the
 * tree from its root STEP and ops once another step is asked for.
 */
export function adoptSavedTrees(saved: ReadonlyMap<string, SavedTree<{ name: string; bytes: ArrayBuffer }>>) {
  const keys = new Map([...saved.keys()].map((id) => [id, freshTreeKey(id)]));
  for (const obj of state.plate.objects) {
    const tree = saved.get(obj.id);
    const key = keys.get(obj.id);
    if (!tree || !key) continue;
    const token = meshTokenOf(obj.bytes);
    const mesh: PlateMesh = { name: obj.fileName, bytes: obj.bytes, sourcePos: obj.sourcePos, token, ...(obj.brep ? { step: obj.brep } : {}) };
    const root: ModelRoot = tree.rootPrimitive ? { kind: "primitive", solid: tree.rootPrimitive } : { kind: "step", ...tree.rootStep };
    const loaded = loadedTree(tree, key, root, obj.name, mesh, (id) => keys.get(id));
    modelTrees.set(key, loaded);
    if (obj.brep || (loaded.committed === ROOT && isStepName(obj.fileName))) stepKnown.add(token);
    // A primitive root is a few numbers, so its tree opens whole from them and no STEP is read; the first edit would rebuild it anyway.
    if (obj.brep && loaded.committed !== ROOT && root.kind === "step") seeds.set(key, { node: loaded.committed, live: false, whole: null, reading: null });
  }
  state.plate = { ...state.plate, objects: state.plate.objects.map((obj) => (keys.has(obj.id) ? { ...obj, modelTree: keys.get(obj.id) } : obj)) };
}

/**
 * Close the trees that no plate object and no Prepare step can reach any more, here and in the
 * engine. A removed object's tree stays while a Prepare step holds it, since undo can bring it back.
 */
export function releaseModelTrees() {
  const refs = editHistoryRefs();
  for (const obj of state.plate.objects) refs.push({ id: obj.id, ...(obj.modelTree ? { key: obj.modelTree } : {}), token: meshTokenOf(obj.bytes) });
  if (open) refs.push({ id: open.objectId, key: open.key });
  const keep = reachableTrees(modelTrees, refs);
  for (const key of [...modelTrees.keys()]) {
    if (keep.has(key)) continue;
    modelTrees.delete(key);
    seeds.delete(key);
    forgetShown(key);
    void post({ call: "close", key });
  }
}

/** The solids and kernel answers kept for tree `key`. */
function forgetShown(key: string) {
  for (const name of solids.keys()) if (name.startsWith(`${key}#`)) solids.delete(name);
  for (const name of answers.keys()) if (name.startsWith(`${key}#`)) answers.delete(name);
}

/** Leaving Model: the plate takes the shown node, the visit is one Prepare step, and the STEP is written off the UI's path. */
export function leaveModel() {
  forgetPlaceSteps();
  commitModel();
  endModelVisit();
  void writeSteps();
}

/** The file's plate is gone: so are its trees. */
export function forgetModelTrees() {
  for (const key of modelTrees.keys()) void post({ call: "close", key });
  modelTrees.clear();
  seeds.clear();
  solids.clear();
  answers.clear();
  stepKnown.clear();
  writing.clear();
  open = null;
  shownFor = null;
  framedFor = null;
  // The edit history went with the old plate, so a move still under way is dropped, not kept as a step.
  window.clearTimeout(placeTimer);
  placeBefore = null;
  forgetPlaceSteps();
  ticket += 1;
  busy = false;
  jumping = false;
  syncUndo();
}

/** A plate action changed the selection while Model is open: the view opens the selected object's solid. */
export function followSelection() {
  if (state.stage !== "model") return;
  const tree = treeOf(open);
  const foreign = !!tree && !!state.mesh && nodeWithMesh(tree, meshTokenOf(state.mesh.bytes)) == null;
  if (state.plate.selectedId !== shownFor || foreign) showModel();
}

export function showModel() {
  const mine = ++ticket;
  picks = [];
  busy = false;
  jumping = false;
  parked = null;
  const objectId = state.plate.selectedId;
  if (objectId !== shownFor) forgetPlaceSteps();
  flushEdit();
  open = null;
  syncUndo();
  const mesh = state.mesh;
  shownFor = objectId;
  const obj = state.plate.objects.find((item) => item.id === objectId);
  const token = mesh ? meshTokenOf(mesh.bytes) : null;
  const known = objectId && token ? treeFor(objectId, obj?.modelTree, token) : null;
  const node = known && token ? nodeWithMesh(known, token) : null;
  if (objectId && known && node != null) {
    // The plate holds this node: Model resumes there, with the other branches kept and the open tool still open.
    modelTrees.set(known.key, { ...jumped(known, node), committed: node });
    if (obj?.modelTree !== known.key) setTreeKey(objectId, known.key);
    void resume(mine, objectId, known.key, node);
    return;
  }
  clearView();
  if (!mesh || !objectId || !obj || !token) {
    showEmpty(false);
    return;
  }
  // A tree that has no node with this mesh stays open: a Prepare undo or redo can bring one of its meshes back.
  const sourcePos = state.sourcePos ?? new Float32Array(0);
  const brep = obj.brep ?? null;
  if (brep || isStepName(mesh.name)) {
    const root: PlateMesh = { name: mesh.name, bytes: mesh.bytes, sourcePos, token, ...(brep ? { step: brep } : {}) };
    void openTree(mine, objectId, obj.name, { kind: "step", name: brep ? stepFileName(mesh.name) : mesh.name, bytes: brep ?? mesh.bytes }, root);
    return;
  }
  const source = [...modelTrees.values()].find((tree) => nodeWithMesh(tree, token) != null);
  if (!source) {
    showEmpty(true);
    return;
  }
  if (source.root.kind === "primitive" && nodeWithMesh(source, token) === ROOT) {
    // A copy of a new solid that has no step yet starts from the same primitive: no STEP to write or read.
    void openTree(mine, objectId, obj.name, source.root, { name: mesh.name, bytes: mesh.bytes, sourcePos, token });
    return;
  }
  // A copy of an edited object whose STEP is not written yet: its own tree starts from that step's STEP.
  void (async () => {
    readout("Reading the solid…");
    const step = await exportStep(source.key, nodeWithMesh(source, token)!);
    if (typeof step === "string") {
      if (mine === ticket) readout(step);
      return;
    }
    putStep(token, step);
    if (mine !== ticket) return;
    void openTree(mine, objectId, obj.name, { kind: "step", name: stepFileName(mesh.name), bytes: step }, { name: mesh.name, bytes: mesh.bytes, sourcePos, token, step });
  })();
}

/**
 * The object's tree that holds a node with the plate's mesh. A Prepare undo to before the object's
 * first Model visit restores a plate without the key, so the object's other trees are searched too.
 */
function treeFor(objectId: string, key: string | undefined, token: string): ModelTree | null {
  const named = key ? modelTrees.get(key) : undefined;
  if (named && nodeWithMesh(named, token) != null) return named;
  for (const tree of modelTrees.values()) {
    if (tree.key.startsWith(`${objectId}#`) && nodeWithMesh(tree, token) != null) return tree;
  }
  return null;
}

function setTreeKey(objectId: string, key: string) {
  state.plate = {
    ...state.plate,
    objects: state.plate.objects.map((obj) => (obj.id === objectId ? { ...obj, modelTree: key } : obj)),
  };
}

/** Back into Model on the node the plate holds. If it no longer rebuilds, on the last step above it that does. */
async function resume(mine: number, objectId: string, key: string, node: NodeId) {
  const greeting = (solid: ParsedSolid) => `${about(solid)} Pick a face or an edge.`;
  if (await showNode(mine, objectId, key, node, greeting) || mine !== ticket) return;
  const tree = modelTrees.get(key);
  const good = tree ? lastGood(tree, node) : null;
  if (good != null && good !== node && (await showNode(mine, objectId, key, good, (solid) => `${BROKEN} ${greeting(solid)}`))) {
    // The plate's mesh of the broken step is still good: it stays until an edit or a jump here.
    parked = key;
    return;
  }
  if (mine === ticket) clearView();
}

/** The deepest node on the way to `node` that is not marked broken. */
function lastGood(tree: ModelTree, node: NodeId): NodeId | null {
  let good: NodeId | null = null;
  for (const id of pathTo(tree, node)) {
    if (tree.nodes.get(id)?.broken) break;
    good = id;
  }
  return good;
}

function clearView() {
  fx.model?.setSolid(null, IDENTITY_POSE);
  refreshModelContext();
  fx.model?.highlight([]);
  syncModelChrome([]);
  showEdits(false);
}

function setMode(mode: "face" | "edge") {
  fx.model?.setPickMode(mode);
  picks = [];
  fx.model?.highlight([]);
  // The buttons first: the Split panel's note reads which one is on.
  document.querySelector("#modelPickFace")?.setAttribute("aria-pressed", mode === "face" ? "true" : "false");
  document.querySelector("#modelPickFace")?.classList.toggle("on", mode === "face");
  document.querySelector("#modelPickEdge")?.setAttribute("aria-pressed", mode === "edge" ? "true" : "false");
  document.querySelector("#modelPickEdge")?.classList.toggle("on", mode === "edge");
  syncModelChrome([]);
  if (open) readout(`${about(open.solid)} Pick ${mode === "face" ? "a face" : "an edge"}.`);
}

/** Open the file's solid, or a copied new solid's primitive, as the root of a new tree for the plate object. */
async function openTree(mine: number, objectId: string, label: string, from: Exclude<ModelRoot, { kind: "piece" }>, root: PlateMesh) {
  readout("Reading the solid…");
  const key = freshTreeKey(objectId);
  const chord = state.stepTolerance;
  const body = await post({ call: "open", key, ...rootRequest(from, null), chordMm: chord });
  const parsed = decodeSolid(body);
  if (typeof parsed === "string") {
    // An open the engine answered but this app cannot read still left a tree there.
    if (typeof body.error !== "string") void post({ call: "close", key });
    if (mine === ticket && state.stage === "model") readout(parsed);
    return;
  }
  modelTrees.set(key, withNode(newTree(key, from, rootLabel(from, label), parsed.fingerprint), ROOT, { mesh: root }));
  if (from.kind === "step") stepKnown.add(root.token);
  keepSolid(key, ROOT, chord, parsed);
  setTreeKey(objectId, key);
  if (mine !== ticket || state.stage !== "model") return;
  open = { objectId, key, solid: parsed };
  present(parsed, `${about(parsed)} Pick a face or an edge.`);
}

/**
 * Show `node` of the open tree: from the recent solids when it is there, else from the engine. The
 * latest jump wins: an older one's late reply is kept for later and not shown.
 */
async function showNode(mine: number, objectId: string, key: string, node: NodeId, message: (solid: ParsedSolid) => string): Promise<boolean> {
  const tree = modelTrees.get(key);
  if (!tree) return false;
  const serial = ++jumpSerial;
  if (brokenOnPath(tree, node)) {
    jumping = false;
    syncUndo();
    readout(BROKEN);
    return false;
  }
  const chord = state.stepTolerance;
  let solid: ParsedSolid | null = recentSolid(key, node, chord) ?? null;
  const seed = seeds.get(key);
  if (solid && readSolids.has(solid) && !(seed?.live && !seed.whole)) solid = null;
  if (!solid) {
    jumping = true;
    jumpTarget = node;
    syncUndo();
    const body = await treeCall(key, node, { call: "goto", key, node, chordMm: chord });
    const newest = mine === ticket && serial === jumpSerial;
    if (newest) jumping = false;
    syncUndo();
    if (mine !== ticket || state.stage !== "model") return false;
    if (!newest) {
      const late = modelTrees.get(key)?.nodes.has(node) ? decodeSolid(body) : null;
      if (late && typeof late !== "string") {
        if (body.seeded) readSolids.add(late);
        keepSolid(key, node, chord, late);
      }
      return false;
    }
    if (failed(key, body)) return false;
    const decoded = decodeSolid(body);
    if (typeof decoded === "string") {
      readout(decoded);
      return false;
    }
    solid = decoded;
    if (body.seeded) readSolids.add(solid);
    keepSolid(key, node, chord, solid);
  }
  jumping = false;
  const latest = modelTrees.get(key);
  if (!latest) return false;
  modelTrees.set(key, jumped(latest, node));
  open = { objectId, key, solid };
  present(solid, message(solid));
  return true;
}

/** Undo is the parent, Redo the child last applied or jumped through. */
async function step(target: (tree: ModelTree) => NodeId | null, done: string) {
  const at = open;
  const tree = treeOf(at);
  const node = tree ? target(tree) : null;
  if (!at || node == null || busy || jumping) return;
  parked = null;
  await showNode(ticket, at.objectId, at.key, node, (solid) => `${about(solid)} ${done}`);
}

/** A row of the History panel: show that step. A jump still on its way to another step gives way to this one. */
async function jumpTo(node: NodeId) {
  const at = open;
  const tree = treeOf(at);
  if (!at || !tree || busy || state.stage !== "model" || !tree.nodes.has(node)) return;
  if (jumping ? node === jumpTarget : node === tree.current) return;
  parked = null;
  await showNode(ticket, at.objectId, at.key, node, about);
}

function renameStep(node: NodeId, name: string) {
  const tree = treeOf(open);
  const step = tree?.nodes.get(node);
  if (!open || !tree || !step || (step.name ?? "") === name) return;
  modelTrees.set(open.key, withNode(tree, node, { name: name || undefined }));
  syncUndo();
}

/** Why the branch from `node` stays, or null. */
function whyKeepBranch(node: NodeId): string | null {
  const tree = treeOf(open);
  if (!tree) return "This solid is no longer open.";
  if (busy || jumping) return "The modeler is still working. Try again in a moment.";
  return dropRefusal(tree, node);
}

/** Delete the branch from `node` down, here and in the engine. A refusal goes to the readout. */
function dropBranch(node: NodeId): boolean {
  const at = open;
  const tree = treeOf(at);
  const refusal = whyKeepBranch(node);
  const next = tree && !refusal ? dropped(tree, node) : null;
  if (!at || !tree || !next) {
    readout(refusal ?? "This branch cannot be deleted.");
    return false;
  }
  for (const id of subtree(tree, node)) {
    for (const name of solids.keys()) if (name.startsWith(`${nodeName(at.key, id)}@`)) solids.delete(name);
  }
  modelTrees.set(at.key, next);
  void dropInEngine(at.key, node);
  syncUndo();
  readout(about(at.solid));
  return true;
}

function brokenOnPath(tree: ModelTree, node: NodeId) {
  return pathTo(tree, node).some((id) => tree.nodes.get(id)?.broken);
}

/** A failure reply goes to the readout. A node that did not rebuild is marked, with everything under it. */
function failed(key: string, body: Body): boolean {
  const error = text(body.error);
  if (!error) return false;
  const tree = modelTrees.get(key);
  if (typeof body.broken === "number" && tree) {
    console.warn(error);
    modelTrees.set(key, withNode(tree, body.broken, { broken: error }));
    readout(BROKEN);
  } else {
    readout(error);
  }
  syncUndo();
  return true;
}

function recentSolid(key: string, node: NodeId, chord: number): ParsedSolid | undefined {
  const name = `${nodeName(key, node)}@${chord}`;
  const solid = solids.get(name);
  if (solid) {
    solids.delete(name);
    solids.set(name, solid);
  }
  return solid;
}

function keepSolid(key: string, node: NodeId, chord: number, solid: ParsedSolid) {
  const name = `${nodeName(key, node)}@${chord}`;
  solids.delete(name);
  solids.set(name, solid);
  while (solids.size > SOLID_CACHE) solids.delete(solids.keys().next().value!);
}

async function applyTool() {
  const button = document.querySelector<HTMLButtonElement>("#modelApply");
  const tool = modelTool();
  if (button && !button.disabled && tool === "create") {
    await createSolid();
    return;
  }
  if (!button || button.disabled || !open) return;
  const op = toolOp(tool);
  if (!op) {
    if (tool === "fillet" || tool === "chamfer") readout(tool === "fillet" ? "Pick an edge to fillet." : "Pick an edge to chamfer.");
    if (tool === "split") readout(splitNote(splitState()).text);
    return;
  }
  if (op.kind === "split") {
    const note = splitNote(splitState());
    if (note.bad) {
      readout(note.text);
      return;
    }
  }
  const count = op.kind === "fillet" || op.kind === "chamfer" ? (op.edges.length === 1 ? "the edge" : `${op.edges.length} edges`) : "";
  const working = {
    boolean: "Editing the solid…",
    split: "Splitting the solid…",
    fillet: `Filleting ${count}…`,
    chamfer: `Chamfering ${count}…`,
    hole: "Cutting the hole…",
    scale: "Scaling the solid…",
  }[op.kind];
  await applyOp(op, working);
}

/** Apply `op` to the shown node. The result is a new child, shown; the plate takes it on commit. */
async function applyOp(op: ModelOp, working: string) {
  const at = open;
  const tree = treeOf(at);
  if (!at || !tree || busy || jumping || !state.mesh) return;
  if (at.objectId !== state.plate.selectedId) {
    followSelection();
    return;
  }
  parked = null;
  const parent = tree.current;
  const twin = childWithOp(tree, parent, op);
  if (twin != null) {
    // These numbers already built a step from here: show it rather than build it again.
    await showNode(ticket, at.objectId, at.key, twin, (solid) => appliedMessage(op, solid));
    return;
  }
  if (seeds.has(at.key) || readSolids.has(at.solid)) {
    // A reopened project's step was read from its STEP, which can sit apart from the step its history
    // builds: on Telo, a hole on the read solid removed 483 mm³ more than the same hole after a rebuild.
    // So an edit builds on the history: the whole tree opens, and the step is shown as rebuilt.
    const mine = ticket;
    busy = true;
    syncUndo();
    readout("Rebuilding the steps…");
    const problem = seeds.has(at.key) ? await openWhole(at.key, parent) : null;
    if (mine === ticket) busy = false;
    syncUndo();
    if (mine !== ticket || state.stage !== "model") return;
    if (problem) {
      readout(problem);
      return;
    }
    if (!(await showNode(mine, at.objectId, at.key, parent, about))) {
      // The step no longer rebuilds: the view goes to the last one that does, and nothing is built.
      if (mine === ticket && state.stage === "model") await resume(mine, at.objectId, at.key, parent);
      return;
    }
    // Edge numbers of the read solid may not be the rebuilt one's.
    if (op.kind === "fillet" || op.kind === "chamfer") {
      readout(`${about(open!.solid)} The step was rebuilt from its history: pick the edges again.`);
      return;
    }
    await applyOp(op, working);
    return;
  }
  const [reserved, node] = reserveId(tree);
  modelTrees.set(at.key, reserved);
  const pieceKey = op.kind === "split" ? freshTreeKey(`${at.objectId}-piece`) : null;
  const chord = state.stepTolerance;
  const mine = ticket;
  busy = true;
  syncUndo();
  readout(working);
  const body = await treeCall(at.key, parent, {
    call: "apply",
    key: at.key,
    parent,
    node,
    op,
    chordMm: chord,
    ...(pieceKey ? { otherKey: pieceKey } : {}),
  });
  if (mine === ticket) busy = false;
  syncUndo();
  const latest = modelTrees.get(at.key);
  if (mine !== ticket || state.stage !== "model" || !latest) return;
  if (failed(at.key, body)) return;
  const parsed = decodeSolid(body);
  const other = !pieceKey ? null : body.other && typeof body.other === "object" ? decodeSolid(body.other as Body) : "The plane did not split this solid.";
  if (typeof parsed === "string" || typeof other === "string") {
    // The engine holds the step, and a split's piece tree, that this reply failed to describe.
    void dropInEngine(at.key, node);
    if (pieceKey) void post({ call: "close", key: pieceKey });
    readout(typeof parsed === "string" ? parsed : (other as string));
    return;
  }
  const stored = isOp(body.op) ? body.op : op;
  if (pieceKey && other && !addPiece(at, other, pieceKey, node)) {
    void dropInEngine(at.key, node);
    void post({ call: "close", key: pieceKey });
    readout("The other piece could not be added. The solid is unchanged.");
    return;
  }
  const grown = withChild(modelTrees.get(at.key) ?? latest, parent, {
    id: node,
    op: stored,
    label: opLabel(stored),
    fingerprint: parsed.fingerprint,
    ...(pieceKey ? { piece: pieceKey } : {}),
  });
  modelTrees.set(at.key, grown);
  keepSolid(at.key, node, chord, parsed);
  open = { ...at, solid: parsed };
  if (isProbed(op.kind)) remember(probeKey(nodeName(at.key, node), op), { phase: "applied" });
  present(parsed, appliedMessage(op, parsed));
}

function appliedMessage(op: ModelOp, solid: ParsedSolid) {
  const paint = state.supportPaint.length + state.seamPaint.length + state.reinforcement.length + state.supportEdits.length > 0;
  const notes = `${paint ? " Leaving Model clears this part's support paint." : ""}${op.kind === "scale" && state.partScale !== 1 ? " Placement scale becomes 100%." : ""}`;
  const volume = about(solid);
  if (op.kind === "split") return `Split. ${volume} On the plate both pieces share one spot: Arrange lays them side by side.${notes}`;
  if (op.kind === "fillet") return `Fillet. ${volume}${notes}`;
  if (op.kind === "chamfer") return `Chamfer. ${volume}${notes}`;
  if (op.kind === "hole") return `Hole. ${volume}${notes}`;
  return `${volume}${notes}`;
}

/**
 * New solid: the primitive the panel describes becomes a plate object of its own, the root of a tree of its own,
 * so no file is read. It stands at the origin of an empty model space, else beside the other objects, goes on the
 * plate as an added file does, and opens at once. Creating it is one Prepare step, which Prepare undo takes back.
 */
async function createSolid() {
  if (busy || jumping || state.stage !== "model") return;
  const typed = fieldPrimitive();
  const root = rootSpec(typed);
  const id = freshPlateId();
  const key = freshTreeKey(id);
  const chord = state.stepTolerance;
  const mine = ticket;
  busy = true;
  syncUndo();
  readout("Building the solid…");
  const body = await post({ call: "open", key, primitive: root, chordMm: chord });
  if (mine === ticket) busy = false;
  syncUndo();
  const parsed = decodeSolid(body);
  const current = mine === ticket && state.stage === "model";
  if (typeof parsed === "string" || !current) {
    // An open the engine answered left a tree there.
    if (typeof body.error !== "string") void post({ call: "close", key });
    if (current) readout(parsed as string);
    return;
  }
  // The open object's edits reach the plate first, so the new object is a Prepare step of its own.
  commitModel();
  forgetPlaceSteps();
  flushEdit();
  noteEdit();
  syncPlateFromState();
  const first = state.plate.objects.length === 0;
  const name = primitiveName(state.plate.objects.map((obj) => obj.name), typed.primitive);
  const positions = new Float32Array(parsed.positions);
  const seat = settleBy(positions);
  const fileName = `${name}.stl`;
  const bytes = encodeStl(positions, fileName);
  setMeshSeat(bytes, seat);
  const mesh: PlateMesh = { name: fileName, bytes, sourcePos: positions, token: meshTokenOf(bytes) };
  const pose = newSolidPose(plateBoxes(), primitiveBounds(root));
  const { bedX, bedY } = state.profile;
  state.plate = addedSolid(state.plate, { name, fileName, bytes, sourcePos: positions, stepTolerance: chord }, id, key, pose, bedX, bedY);
  applySelectedToState(state.plate);
  const from: ModelRoot = { kind: "primitive", solid: root };
  modelTrees.set(key, withNode(newTree(key, from, rootLabel(from, name), parsed.fingerprint), ROOT, { mesh }));
  keepSolid(key, ROOT, chord, parsed);
  place(first ? "load" : "transform");
  flushEdit();
  markModelEdit();
  ticket += 1;
  picks = [];
  parked = null;
  shownFor = id;
  closeModelTool();
  open = { objectId: id, key, solid: parsed };
  present(parsed, `${name}. ${about(parsed)} Pick a face or an edge.`);
}

/** Where New solid puts `spec` in model space: its root, standing at the origin or beside every object. */
function newSolidAt(spec: PrimitiveSpec): PrimitiveSpec {
  const root = rootSpec(spec);
  const { t } = newSolidPose(plateBoxes(), primitiveBounds(root));
  return { ...root, origin: [root.origin[0] + t[0], root.origin[1] + t[1], root.origin[2] + t[2]] };
}

/** Every plate object's box in model space. Each mesh's own box is read once. */
function plateBoxes(): Bounds[] {
  return livePlate().map((obj) => boxUnder(boxOf(obj.sourcePos), meshToModel(obj)));
}

/** No solid to show: the view says so plainly, with New solid at hand, and shows whatever model space holds. */
function showEmpty(mesh: boolean) {
  readout("");
  const card = document.querySelector<HTMLElement>("#modelEmpty");
  const title = document.querySelector("#modelEmptyTitle");
  const text = document.querySelector("#modelEmptyText");
  if (title) title.textContent = mesh ? "This object is a mesh" : "No solid open";
  if (text) text.textContent = mesh ? "Model edits STEP solids. Start a new solid from a primitive, or open a STEP file." : "Start a solid from a primitive, or open a STEP file.";
  if (card) card.hidden = false;
  framedFor = null;
  const boxes = plateBoxes();
  if (boxes.length > 0) fx.model?.frame(unionBox(boxes)!);
}

function hideEmpty() {
  document.querySelector<HTMLElement>("#modelEmpty")?.toggleAttribute("hidden", true);
}

/** The split-off piece goes on the plate at once, in its parent's place, as the root of its own tree. */
function addPiece(at: Opened, other: ParsedSolid, key: string, split: NodeId): boolean {
  if (!state.mesh) return false;
  noteEdit();
  syncPlateFromState();
  const positions = new Float32Array(other.positions);
  const seat = settleBy(positions);
  const fileName = `${stlName(state.mesh.name).replace(/\.stl$/i, "")} split.stl`;
  const bytes = encodeStl(positions, fileName);
  setMeshSeat(bytes, seat);
  const mesh: PlateMesh = { name: fileName, bytes, sourcePos: positions, token: meshTokenOf(bytes) };
  const name = placePiece(key, mesh);
  if (!name) {
    flushEdit();
    return false;
  }
  modelTrees.set(key, withNode(newTree(key, { kind: "piece", tree: at.key, node: split }, name, other.fingerprint), ROOT, { mesh }));
  keepSolid(key, ROOT, state.stepTolerance, other);
  place();
  flushEdit();
  markModelEdit();
  return true;
}

/** A split piece with `mesh` joins the plate in the selected object's place, carrying its tree's key. Its plate name, or null. */
function placePiece(key: string, mesh: PlateMesh): string | null {
  const selected = state.plate.selectedId;
  const prev = new Set(state.plate.objects.map((obj) => obj.id));
  const next = selected
    ? addedSplit(state.plate, { name: mesh.name.replace(/\.stl$/i, ""), fileName: mesh.name, bytes: mesh.bytes, sourcePos: new Float32Array(mesh.sourcePos), stepTolerance: state.stepTolerance })
    : null;
  const piece = next?.objects.find((obj) => !prev.has(obj.id));
  if (!next || !selected || !piece) return null;
  const step = mesh.step ? { brep: mesh.step } : {};
  state.plate = { objects: next.objects.map((obj) => (obj.id === piece.id ? { ...obj, ...step, modelTree: key } : obj)), selectedId: selected };
  applySelectedToState(state.plate);
  return piece.name;
}

async function runExport() {
  const at = open;
  const tree = treeOf(at);
  if (!at || !tree || busy || jumping || !state.mesh) return;
  const node = tree.current;
  busy = true;
  syncUndo();
  readout("Writing STEP…");
  const mine = ticket;
  const step = await exportStep(at.key, node);
  if (mine === ticket) busy = false;
  syncUndo();
  if (mine !== ticket || state.stage !== "model" || !open) return;
  if (typeof step === "string") {
    readout(step);
    return;
  }
  const mesh = tree.nodes.get(node)?.mesh;
  if (mesh) putStep(mesh.token, step);
  await saveStepFile(step, stepFileName(state.mesh.name));
  readout(`Saved STEP. ${about(at.solid)}`);
}

/**
 * Write the STEP of each plate object's solid that has none yet, and give it to every plate object
 * and Prepare step with that mesh. Returns the mesh tokens the engine could not write.
 */
async function writeSteps(): Promise<string[]> {
  const failedTokens: string[] = [];
  const asked = new Set<string>();
  for (const obj of state.plate.objects) {
    const token = meshTokenOf(obj.bytes);
    const tree = treeFor(obj.id, obj.modelTree, token);
    const node = tree ? nodeWithMesh(tree, token) : null;
    if (!tree || node == null || stepKnown.has(token) || asked.has(token)) continue;
    asked.add(token);
    if (typeof (await writeStep(token, tree.key, node)) === "string") failedTokens.push(token);
  }
  return failedTokens;
}

/** The STEP of the node whose plate mesh is `token`, given wherever that mesh is. One export per token at a time. */
function writeStep(token: string, key: string, node: NodeId): Promise<ArrayBuffer | string> {
  let pending = writing.get(token);
  if (!pending) {
    pending = exportStep(key, node).then((step) => {
      writing.delete(token);
      if (typeof step !== "string") putStep(token, step);
      return step;
    });
    writing.set(token, pending);
  }
  return pending;
}

async function exportStep(key: string, node: NodeId): Promise<ArrayBuffer | string> {
  const body = await treeCall(key, node, { call: "export", key, node });
  const problem = text(body.error);
  if (problem) return problem;
  if (typeof body.bytesBase64 !== "string") return "Open CASCADE did not write this solid.";
  const bytes = base64ToBytes(body.bytesBase64);
  if (!bytes || (typeof body.byteLength === "number" && bytes.byteLength !== body.byteLength)) {
    return "Open CASCADE did not write this solid.";
  }
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** `step` is the solid whose plate mesh is `token`: it goes wherever that mesh is. Undefined removes it. */
function putStep(token: string, step: ArrayBuffer | undefined) {
  state.plate = withBrepFor(state.plate, token, step);
  patchEditBrep(token, step);
  for (const tree of modelTrees.values()) {
    const node = nodeWithMesh(tree, token);
    const mesh = node == null ? undefined : tree.nodes.get(node)?.mesh;
    if (node == null || !mesh) continue;
    const next = { ...mesh };
    if (step) next.step = step;
    else delete next.step;
    modelTrees.set(tree.key, withNode(tree, node, { mesh: next }));
  }
  if (step) stepKnown.add(token);
  else stepKnown.delete(token);
}

function setBrep(objectId: string, bytes: ArrayBuffer | undefined) {
  state.plate = {
    ...state.plate,
    objects: state.plate.objects.map((obj) => {
      if (obj.id !== objectId) return obj;
      const next = { ...obj };
      if (bytes && bytes.byteLength > 0) next.brep = bytes;
      else delete next.brep;
      return next;
    }),
  };
}

function stepFileName(name: string) {
  const stem = name.replace(/\.(step|stp|stl|3mf)$/i, "");
  return `${stem || "solid"}.step`;
}

async function saveStepFile(bytes: ArrayBuffer, name: string) {
  const tauri = (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  if (tauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("save_text_file", { text: "", defaultName: name, extension: "step", bytesB64: bytesToBase64(new Uint8Array(bytes)) });
    return;
  }
  const blob = new Blob([bytes], { type: "application/step" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}

/** Show `parsed` as the open tree's current node. The camera frames it when another object opened, and stays put otherwise. */
function present(parsed: ParsedSolid, message: string) {
  picks = [];
  hideEmpty();
  learnSeat(parsed);
  fx.model?.setSolid(parsed, openPose());
  if (open && framedFor !== open.objectId) {
    framedFor = open.objectId;
    frameModel(false);
  }
  syncPlaceFields();
  refreshModelContext();
  fx.model?.highlight([]);
  setModelEditable(parsed.editable);
  syncModelSolid();
  syncModelChrome([]);
  fx.model?.resize();
  showEdits(true);
  refreshModelGhost();
  syncUndo();
  readout(message);
}

/** The other plate objects, grey, where they sit in model space. Nothing is drawn without an open solid. */
export function refreshModelContext() {
  fx.model?.setContext(contextParts(livePlate(), open?.objectId ?? null));
  const canvas = document.querySelector<HTMLElement>("#model");
  const obj = open ? state.plate.objects.find((item) => item.id === open!.objectId) : undefined;
  // The open object's plate mesh, so a test can tell a model-space move left it alone.
  if (canvas && obj) canvas.dataset.plateMesh = meshTokenOf(obj.bytes);
}

/** The open object's pose into model space. */
function openPose(): Affine {
  const obj = open ? state.plate.objects.find((item) => item.id === open!.objectId) : undefined;
  return obj ? modelPoseOf(obj) : IDENTITY_POSE;
}

/** The open solid's box in model space. */
function openBox(): Bounds | null {
  return open ? posedBounds(open.solid.positions, openPose()) : null;
}

/** The solid's box in its own frame: Place turns about its centre, and the kernel cuts against it. */
function ownBox(solid: ParsedSolid): Bounds {
  return boxOf(solid.positions);
}

/** The box of a mesh's vertices, read once per array. */
function boxOf(positions: Float32Array): Bounds {
  let box = ownBoxes.get(positions);
  if (!box) ownBoxes.set(positions, (box = boundsOf(positions)));
  return box;
}

function pivotOf(solid: ParsedSolid): Vec3 {
  const own = ownBox(solid);
  return [(own.min[0] + own.max[0]) / 2, (own.min[1] + own.max[1]) / 2, (own.min[2] + own.max[2]) / 2];
}

/**
 * The plate mesh of a step the engine just described sits under that step's solid by the solid's lowest
 * point. When an engine from before `seatMm` read a STEP without saying how far it lowered it, Model learns it here.
 */
function learnSeat(solid: ParsedSolid) {
  const mesh = treeOf(open)?.nodes.get(solid.id)?.mesh;
  if (!mesh || meshSeat(mesh.bytes) !== undefined) return;
  const z = extentAlong(solid.positions, [0, 0, 1]);
  if (z) setMeshSeat(mesh.bytes, z.min);
}

/**
 * Frame the open object, or with `all` every object, from the direction Model opens with. The Reset view
 * button, Home, the Objects list's Frame, and the first look at an object all come here.
 */
export function frameModel(all: boolean) {
  const box = openBox();
  // With no solid open, the view frames whatever model space holds.
  const others = all || !box ? contextParts(livePlate(), open?.objectId ?? null).map((part) => boxUnder(boxOf(part.positions), part.matrix)) : [];
  const union = unionBox(box ? [box, ...others] : others);
  if (union) fx.model?.frame(union);
}

/** The Objects list's Frame in Model: that object, opened if it is not the open one. */
export function frameInModel(id: string) {
  if (open?.objectId === id) frameModel(false);
  else framedFor = null;
}

/** A Place field moved the open object in model space. Its plate pose, mesh, and slice stay as they are. */
function placeMoved(field: keyof PlaceFields, value: number, phase: PlacePhase) {
  const at = open;
  if (!at || busy || jumping) return;
  const from = openPose();
  const next = poseFromPlace(from, pivotOf(at.solid), field, value);
  if (samePose(next, from)) {
    // A grab with no move, or a number retyped as it was, changes nothing and opens no step.
    if (phase === "end") endPlace();
    return;
  }
  if (!placeBefore) {
    placeBefore = from;
    beginEdit();
  }
  putPose(at.objectId, next);
  window.clearTimeout(placeTimer);
  if (phase === "end") endPlace();
  else if (phase === "typed") placeTimer = window.setTimeout(endPlace, PLACE_SETTLE_MS);
  syncUndo();
}

function putPose(objectId: string, pose: Affine) {
  state.plate = withModelPose(state.plate, objectId, pose);
  fx.model?.setPose(openPose());
  refreshModelGhost();
  markProjectDirty();
}

/** A Place gesture is over: one step back for Undo here, and one Prepare step, folded into the visit like an edit. */
function endPlace() {
  window.clearTimeout(placeTimer);
  const before = placeBefore;
  placeBefore = null;
  if (!before) return;
  flushEdit();
  if (!samePose(before, openPose())) {
    placeUndo.push(before);
    placeRedo = [];
    markModelEdit();
  }
  syncUndo();
  // A turn changes the solid's model-space box, and with it which tools are on offer.
  syncModelSolid();
}

function samePose(a: Affine, b: Affine): boolean {
  return a.t.every((value, i) => value === b.t[i]) && a.m.every((value, i) => value === b.m[i]);
}

/** Undo or Redo one Place step. A gesture still settling becomes a step first, so Undo takes it back. */
function placeStep(way: "undo" | "redo") {
  endPlace();
  const [from, to] = way === "undo" ? [placeUndo, placeRedo] : [placeRedo, placeUndo];
  const at = open;
  const pose = from.pop();
  if (!at || !pose) return;
  to.push(openPose());
  beginEdit();
  putPose(at.objectId, pose);
  flushEdit();
  markModelEdit();
  syncPlaceFields(true);
  syncUndo();
}

/** Place steps belong to the object they moved, in one Model visit. */
function forgetPlaceSteps() {
  endPlace();
  placeUndo = [];
  placeRedo = [];
}

function showEdits(on: boolean) {
  document.querySelector("#modelEdit")?.toggleAttribute("hidden", !on);
  document.querySelector("#modelToolNew")?.classList.toggle("is-icon", on);
  if (!on) closeModelTool();
}

function syncUndo() {
  const tree = treeOf(open);
  const undo = document.querySelector<HTMLButtonElement>("#modelUndo");
  const redo = document.querySelector<HTMLButtonElement>("#modelRedo");
  const placing = openModelTool() === "place";
  if (undo) {
    undo.disabled = busy || jumping || !tree || (placing ? placeUndo.length === 0 && !placeBefore : undoTarget(tree) == null);
    undo.dataset.tip = placing ? "Undo the last move" : "Undo the last solid edit";
  }
  if (redo) {
    redo.disabled = busy || jumping || !tree || (placing ? placeRedo.length === 0 : redoTarget(tree) == null);
    redo.dataset.tip = placing ? "Redo the last move" : "Redo the last solid edit";
  }
  const stepButton = document.querySelector<HTMLButtonElement>("#modelStep");
  if (stepButton) stepButton.disabled = busy || jumping || !tree;
  setModelWaiting(busy || jumping);
  syncModelHistory(tree);
}

const extentOf = extentMemo();
/** Each solid's flat faces, by face index; null for a curved one. */
const flatFaces = new WeakMap<ParsedSolid, Map<number, FacePlane | null>>();

/** The last split worked out, for the solid, pose, and panel state it was worked out from: one input asks several times. */
let splitKept: { solid: ParsedSolid; pose: Affine; key: string; state: SplitState } | null = null;

/**
 * The open solid's extent along a model-space normal: its own extent along that normal turned back into the
 * solid's frame, moved by the pose. Exact, since the pose is rigid.
 */
function modelExtent(solid: ParsedSolid, pose: Affine, normal: Vec3): AxisExtent | null {
  const own = extentOf(solid.positions, isIdentity(pose) ? normal : turnDir(inversePose(pose), normal));
  const shift = normal[0] * pose.t[0] + normal[1] * pose.t[1] + normal[2] * pose.t[2];
  return own && { min: own.min + shift, max: own.max + shift };
}

/**
 * The box the kernel measures a cut against, the solid's own, as `planeFor` takes it: the box itself on an
 * identity pose, else its corners' extent along a model-space normal turned back into the solid's frame.
 */
function kernelBox(solid: ParsedSolid, pose: Affine): { min: Vec3; max: Vec3 } | ((normal: Vec3) => AxisExtent) {
  const own = ownBox(solid);
  if (isIdentity(pose)) return own;
  const back = inversePose(pose);
  return (normal) => {
    const extent = boxExtentAlong(own, turnDir(back, normal));
    const shift = normal[0] * pose.t[0] + normal[1] * pose.t[1] + normal[2] * pose.t[2];
    return { min: extent.min + shift, max: extent.max + shift };
  };
}

/**
 * The split plane from the panel, in model space: the one place a split request is built, and `toolOp` takes
 * it into the solid's frame. X, Y, and Z cut square to that axis of the view, which is model space; Face cuts
 * parallel to the last picked flat face.
 */
function splitState(): SplitState {
  const at = open;
  const pose = openPose();
  const box = openBox();
  if (!at || !box) return { why: "Open a STEP file to measure a solid.", wait: true };
  const mode = splitMode();
  const picked = mode === "face" ? lastFace(picks) : null;
  const facePicking = document.querySelector("#modelPickFace")?.getAttribute("aria-pressed") === "true";
  const value = num("#modelPlane");
  const tilt: [number, number] = [num("#modelTiltA"), num("#modelTiltB")];
  const key = `${mode}|${picked}|${facePicking}|${value}|${tilt}`;
  if (splitKept?.solid === at.solid && splitKept.pose === pose && splitKept.key === key) return splitKept.state;
  let state: SplitState;
  if (mode === "face" && picked == null) {
    state = { why: facePicking ? "Pick a flat face to cut from." : "Switch to Face picking, then pick a flat face to cut from.", wait: true };
  } else {
    const own = picked == null ? null : flatFace(at.solid, picked);
    const face = own && !isIdentity(pose) ? { point: applyPose(pose, own.point), normal: turnDir(pose, own.normal) } : own;
    const center: Vec3 = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
    const base = splitBase(mode, center, face);
    state = base
      ? { plan: planeFor(base, value, tilt, (normal) => modelExtent(at.solid, pose, normal), kernelBox(at.solid, pose)) }
      : { why: "Pick a flat face. This one is curved.", wait: false };
  }
  splitKept = { solid: at.solid, pose, key, state };
  return state;
}

/** A split is on offer when the solid can be cut square to at least one model axis. */
function splitLegal(): boolean {
  const at = open;
  const pose = openPose();
  const box = openBox();
  if (!at || !box) return false;
  const kernel = kernelBox(at.solid, pose);
  return (["x", "y", "z"] as const).some((mode) => planeFor(splitBase(mode, [0, 0, 0], null)!, 0, [0, 0], (normal) => modelExtent(at.solid, pose, normal), kernel).range != null);
}

function flatFace(solid: ParsedSolid, face: number): FacePlane | null {
  let known = flatFaces.get(solid);
  if (!known) flatFaces.set(solid, (known = new Map()));
  if (!known.has(face)) {
    const normal = solid.faces.find((item) => item.id === face)?.normal ?? outwardFromMesh(solid.positions, solid.triangles, face);
    known.set(face, normal ? facePlane(solid.positions, solid.triangles, face, normal as Vec3) : null);
  }
  return known.get(face)!;
}

/** Into the last picked face, or straight down in model space when no face is picked. */
function drillAxis(): Vec3 {
  const face = lastFace(picks);
  if (!open || face == null) return [0, 0, -1];
  const stored = open.solid.faces.find((item) => item.id === face)?.normal;
  const axis = holeAxis(stored ?? outwardFromMesh(open.solid.positions, open.solid.triangles, face));
  const pose = openPose();
  return isIdentity(pose) ? axis : turnDir(pose, axis);
}

function num(id: string) {
  const value = Number(document.querySelector<HTMLInputElement>(id)?.value);
  return Number.isFinite(value) ? value : 0;
}

function stlName(name: string) {
  const stem = name.replace(/\.(step|stp|stl|3mf)$/i, "");
  return `${stem || "solid"}.stl`;
}

let measureSeq = 0;

async function onPick(pick: ModelPick | null, shift: boolean) {
  const at = open;
  const tree = treeOf(at);
  if (!at || !tree) return;
  const solid = at.solid;
  picks = nextModelPicks(picks, pick, shift);
  fx.model?.highlight(picks);
  syncModelChrome(picks);
  const seq = ++measureSeq;
  if (picks.length === 0) {
    readout(`${about(solid)} Pick a face or an edge.`);
    return;
  }
  if (picks.length === 1) {
    readout(`${describe(solid, picks[0]!)} ${about(solid)}`);
    return;
  }
  if (picks.length !== 2) {
    readout(`${selectionCountLabel(picks)}. ${about(solid)}`);
    return;
  }
  readout("Measuring distance…");
  const generation = ticket;
  const node = tree.current;
  const body = await treeCall(at.key, node, {
    call: "distance",
    key: at.key,
    node,
    aKind: picks[0]!.kind,
    aIndex: picks[0]!.index,
    bKind: picks[1]!.kind,
    bIndex: picks[1]!.index,
  });
  if (seq !== measureSeq || generation !== ticket || state.stage !== "model") return;
  const distance = typeof body.distanceMm === "number" ? body.distanceMm : null;
  if (distance == null) {
    readout(text(body.error) || "Could not measure that distance.");
    return;
  }
  readout(`${describe(solid, picks[0]!)} ${describe(solid, picks[1]!)} Distance ${mm(distance)} mm.`);
}

function describe(current: ParsedSolid, pick: ModelPick) {
  if (pick.kind === "face") {
    const area = current.faces.find((face) => face.id === pick.index)?.areaMm2;
    return `Face ${pick.index + 1} · ${mm(area ?? Number.NaN)} mm².`;
  }
  const length = current.edges.find((edge) => edge.id === pick.index)?.lengthMm;
  return `Edge ${pick.index + 1} · ${mm(length ?? Number.NaN)} mm.`;
}

/** The solid's volume, or why there is none. */
function about(solid: ParsedSolid) {
  return solid.editable ? `Volume ${mm(solid.volumeMm3)} mm³.` : VIEW_ONLY;
}

function modelTool(): string | undefined {
  return document.querySelector<HTMLElement>("#modelBar")?.dataset.tool;
}

function readout(message: string) {
  const node = document.querySelector("#modelReadout");
  if (node) node.textContent = plainModelError(message, modelTool());
}

function mm(value: number) {
  if (!Number.isFinite(value)) return "—";
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function isOp(value: unknown): value is ModelOp {
  return !!value && typeof value === "object" && typeof (value as { kind?: unknown }).kind === "string";
}

function missingOf(body: Body): NodeId[] | null {
  if (body.error !== "unknown" || !Array.isArray(body.missing)) return null;
  return body.missing.filter((id): id is number => typeof id === "number");
}

/**
 * One call on tree `key` that needs `node`. When the engine has forgotten the tree or the node (a
 * restarted engine), it gets the root and the ops again, and the call is asked once more. Calls that
 * find the same tree missing share one restore; a call whose node that restore did not bring back
 * runs one of its own.
 */
async function treeCall(key: string, node: NodeId, request: Body): Promise<Body> {
  let body = await seededCall(key, node, request);
  for (let round = 0; round < 2; round += 1) {
    const missing = missingOf(body);
    if (!missing) return body;
    const running = round === 0 ? restoring.get(key) : undefined;
    const restored: Promise<string | null> = running ?? restore(key, node, missing).finally(() => {
      if (restoring.get(key) === restored) restoring.delete(key);
    });
    if (!running) restoring.set(key, restored);
    const problem = await restored;
    if (problem) return { error: problem };
    body = await seededCall(key, node, request);
  }
  return missingOf(body) ? { error: "The modeler no longer has this solid. Open Model again to reload it." } : body;
}

/**
 * One call as the engine numbers the tree. While a seed is live, the plate's step is the engine's
 * root, and a step the engine was never given needs the whole tree first. While the whole tree is
 * on its way, a call waits for it: the engine runs it after the open, on the whole tree.
 */
async function seededCall(key: string, node: NodeId, request: Body): Promise<Body> {
  for (;;) {
    let seed = seeds.get(key);
    for (; seed?.whole || seed?.reading; seed = seeds.get(key)) await (seed.whole ?? seed.reading);
    if (seed && (node !== seed.node || request.call === "apply")) {
      const problem = await openWhole(key, node);
      if (problem) return { error: problem };
      continue;
    }
    if (!seed?.live) return post(request);
    const body = await post(engineNumbered(seed, request));
    // The engine does not run calls in the order they were sent: an open that started after this one
    // may have run first, and then its node 0 is the root. Such an answer is asked for again.
    if (seeds.get(key) !== seed || seed.whole || seed.reading || !seed.live) continue;
    // `seeded`: the answer is about the STEP-read step.
    return { ...body, seeded: true, ...(body.id === ROOT ? { id: seed.node } : {}), ...(body.broken === ROOT ? { broken: seed.node } : {}) };
  }
}

/** `request` with the plate's step of a live seed as the engine's root. */
function engineNumbered(seed: Seed, request: Body): Body {
  const local = (id: unknown) => (id === seed.node ? ROOT : id);
  return { ...request, node: local(request.node), ...("parent" in request ? { parent: local(request.parent) } : {}) };
}

/** Drop the branch from `node` in the engine, once it has one: a seeded tree's engine holds no branch. */
async function dropInEngine(key: string, node: NodeId) {
  for (let seed = seeds.get(key); seed; seed = seeds.get(key)) {
    if (!seed.whole) return;
    await seed.whole;
  }
  await post({ call: "drop", key, node });
}

/**
 * The tree's root STEP and every op to the engine, which builds each step when it is asked for.
 * `node` is the step wanted next; a step that no longer rebuilds is marked when it is asked again.
 * Calls on a seeded tree share one open. The solids and answers that came from the seed's STEP-read
 * solid go: the engine's steps are rebuilt from the root now, and their edges may be numbered apart.
 */
function openWhole(key: string, node: NodeId): Promise<string | null> {
  const seed = seeds.get(key);
  if (seed?.whole) return seed.whole;
  const run = (async () => {
    if (seed?.reading) await seed.reading;
    const tree = modelTrees.get(key);
    if (!tree || tree.root.kind === "piece") return "This solid is no longer open.";
    const body = await post({
      call: "open",
      key,
      ...rootRequest(tree.root, tree.nodes.get(ROOT)?.fingerprint ?? null),
      chordMm: state.stepTolerance,
      nodes: savedNodes(tree),
      current: node,
    });
    if (seed) seed.whole = null;
    if (!modelTrees.has(key)) return closeLate(key);
    // A primitive root that builds differently opens nothing: the whole tree is broken from its root.
    if (body.broken === ROOT) {
      failed(key, body);
      return BROKEN;
    }
    const problem = typeof body.broken === "number" ? "" : text(body.error);
    if (problem) return problem;
    if (seed) forgetShown(key);
    seeds.delete(key);
    return null;
  })();
  if (seed) seed.whole = run;
  return run;
}

/**
 * What `open` builds the root from: the STEP's bytes, or a new solid's primitive. A primitive root carries its
 * fingerprint, so a root that builds differently is broken like any other step that does.
 */
function rootRequest(root: Exclude<ModelRoot, { kind: "piece" }>, fingerprint: Fingerprint | null): Body {
  if (root.kind === "primitive") return { primitive: root.solid, ...(fingerprint ? { fingerprint } : {}) };
  return { filename: root.name, dataB64: bytesToBase64(new Uint8Array(root.bytes)) };
}

/** An open that lands for a tree released or forgotten meanwhile: the engine lets it go too. */
function closeLate(key: string): string {
  void post({ call: "close", key });
  return "This solid is no longer open.";
}

async function restore(key: string, node: NodeId, missing: NodeId[]): Promise<string | null> {
  const tree = modelTrees.get(key);
  if (!tree) return "This solid is no longer open.";
  const chord = state.stepTolerance;
  const seed = seeds.get(key);
  if (seed?.whole) return seed.whole;
  // The plate's step opens from its own STEP, as fast as the file: at first, and again after an engine restart.
  const step = seed && node === seed.node ? tree.nodes.get(node)?.mesh : undefined;
  if (seed && step?.step) {
    if (state.stage === "model") readout("Reading the solid…");
    seed.live = false;
    let read = () => {};
    seed.reading = new Promise<void>((resolve) => (read = resolve));
    const body = await post({ call: "open", key, filename: stepFileName(step.name), dataB64: bytesToBase64(new Uint8Array(step.step)), chordMm: chord }).finally(() => {
      seed.reading = null;
      read();
    });
    if (!modelTrees.has(key)) return closeLate(key);
    if (seeds.get(key) !== seed) return openWhole(key, node);
    if (!text(body.error)) {
      seed.live = true;
      return null;
    }
  }
  if (seed || missing.includes(ROOT)) {
    // `open` registers every saved node, so nothing else is missing.
    if (tree.root.kind !== "piece") return openWhole(key, node);
    const problem = await rebuildPiece(tree.root.tree, tree.root.node, key);
    if (problem) return problem;
  }
  // A piece's tree comes back as its root only: its steps are applied again down to `node`. A split
  // among them goes without its `otherKey`, which would start that piece's tree over.
  for (const id of pathTo(tree, node).slice(1)) {
    const step = tree.nodes.get(id);
    if (!step?.op || step.parent === null) continue;
    const body = await post({
      call: "apply",
      key,
      parent: step.parent,
      node: id,
      op: step.op,
      chordMm: chord,
    });
    // A node the engine still has, made by a split with its piece's key, refuses a resend without it.
    if (text(body.error).includes("already in this tree")) continue;
    if (failed(key, body)) return text(body.error);
  }
  return null;
}

/** The piece a split cut off comes back by running that split again on a spare node, which then goes. */
async function rebuildPiece(parentKey: string, split: NodeId, pieceKey: string): Promise<string | null> {
  const parent = modelTrees.get(parentKey);
  const splitNode = parent?.nodes.get(split);
  if (!parent || !splitNode?.op || splitNode.parent === null) return "The part this piece was split from is no longer open.";
  const [reserved, spare] = reserveId(parent);
  modelTrees.set(parentKey, reserved);
  const body = await treeCall(parentKey, splitNode.parent, {
    call: "apply",
    key: parentKey,
    parent: splitNode.parent,
    node: spare,
    op: splitNode.op,
    chordMm: state.stepTolerance,
    otherKey: pieceKey,
  });
  await dropInEngine(parentKey, spare);
  return text(body.error) || null;
}

async function post(payload: Body): Promise<Body> {
  const tauri = (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  try {
    if (tauri) {
      const { invoke } = await import("@tauri-apps/api/core");
      return JSON.parse(await invoke<string>("model_tree", { payload: JSON.stringify(payload) })) as Body;
    }
    const res = await fetch(`${apiBase()}/api/model/tree`, {
      method: "POST",
      headers: authHeaders(apiToken(), { "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });
    const body = await res.json() as Body;
    if (!res.ok && typeof body.error !== "string") {
      return { error: modelerFailure(body.error ?? body.message, modelTool()) };
    }
    return body;
  } catch (err) {
    const message = modelerFailure(err, modelTool());
    if (message === "Failed to fetch") {
      return { error: `Model measure needs the slicer engine at ${apiBase()}. Start it with cargo run -p lime-slice --release -- serve.` };
    }
    return { error: message };
  }
}

Object.assign(fx, { refreshModelContext, commitModel, forgetModelTrees, followSelection, releaseModelTrees });
