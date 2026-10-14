import { bytesToBase64 } from "../base64";
import { encodeStl, settle } from "../mesh-place";
import type { ModelPick, ModelSolid } from "../model-view";
import { holeAxis, lastFace, outwardFromMesh, selectedEdges } from "../model-blend";
import { nextModelPicks, selectionCountLabel } from "../model-select";
import { contextParts } from "../model-context";
import { PROBE_WAIT_MS, isProbed, probeFromBody, probeKey, type ProbeView } from "../model-feasibility";
import { formatMm, splitPlaneInside, splitPlaneRange, zExtent } from "../model-plane";
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
  savedNodes,
  subtree,
  undoTarget,
  visitStep,
  withChild,
  withNode,
  type Fingerprint,
  type ModelOp,
  type ModelTree,
  type NodeId,
  type PlateMesh,
  type PrepareKeep,
  type Vec3,
} from "../model-tree";
import { loadedTree, savedTree, type SavedTree } from "../model-tree-file";
import {
  closeModelTool,
  mountModelChrome,
  openModelTool,
  refreshModelGhost,
  setModelEditable,
  setModelProbe,
  setModelWaiting,
  syncModelChrome,
  syncModelSolid,
} from "../ui/model-chrome";
import { mountModelHistory, syncModelHistory } from "../ui/model-history";
import { dropRefusal } from "../model-history";
import { addedSplit, meshTokenOf, withBrepFor } from "../plate";
import { base64ToBytes } from "../project";
import { authHeaders } from "../ui/api-base";
import { livePlate, place } from "./files";
import { editHistoryRefs, endModelVisit, flushEdit, markModelEdit, noteEdit, patchEditBrep } from "./history";
import { fx } from "./fx";
import { modelerFailure, plainModelError } from "./model-error";
import { freshTreeKey, modelTrees } from "./model-trees";
import { applySelectedToState, syncPlateFromState } from "./plate-sync";
import { apiBase, apiToken, isStepName } from "./settings";
import { state } from "./state";

type Body = Record<string, unknown>;

interface ParsedSolid extends ModelSolid {
  faces: { id: number; areaMm2: number; normal?: [number, number, number] }[];
  fingerprint: Fingerprint | null;
  /** False for surfaces with no closed solid: measured, never edited, and its volume means nothing. */
  editable: boolean;
}

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

export function bindModelView() {
  fx.model?.onPick((pick: ModelPick | null, shift: boolean) => void onPick(pick, shift));
  document.querySelector("#modelPickFace")?.addEventListener("click", () => setMode("face"));
  document.querySelector("#modelPickEdge")?.addEventListener("click", () => setMode("edge"));
  document.querySelector("#modelApply")?.addEventListener("click", () => void applyTool());
  document.querySelector("#modelStep")?.addEventListener("click", () => void runExport());
  document.querySelector("#modelUndo")?.addEventListener("click", () => void step(undoTarget, "Edit undone."));
  document.querySelector("#modelRedo")?.addEventListener("click", () => void step(redoTarget, "Edit redone."));
  mountModelChrome({
    clearSelection() {
      picks = [];
      fx.model?.highlight([]);
      syncModelChrome([]);
      if (open) readout(`${about(open.solid)} Pick a face or an edge.`);
    },
    solidZ() {
      return zExtent(open?.solid.positions ?? null);
    },
    paramsChanged(typed) {
      scheduleProbe(typed ? PROBE_WAIT_MS : 0);
    },
    probeNow() {
      if (!pendingProbe) return;
      window.clearTimeout(probeTimer);
      sendPending();
    },
    solidBox() {
      return open ? boxOf(open.solid.positions) : null;
    },
    edgePoints(edge) {
      return open?.solid.edges.find((item) => item.id === edge)?.points ?? null;
    },
    holeAxis() {
      return drillAxis();
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

/** The open tool's edit, from its fields. Null when it cannot run yet. */
function toolOp(tool: string | null | undefined): ModelOp | null {
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
      return {
        kind: "boolean",
        op: boolOp(),
        primitive: prim(),
        origin,
        size: [num("#modelDx"), num("#modelDy"), num("#modelDz")],
        radius: num("#modelRadius"),
        height: num("#modelHeight"),
        turn: turn(),
      };
    case "split":
      return { kind: "split", origin: [0, 0, num("#modelPlaneZ")], normal: [0, 0, 1] };
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
  const positions = settle(new Float32Array(solid.positions));
  const name = stlName(state.mesh?.name ?? "solid");
  const bytes = encodeStl(positions, name);
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

/** The root STEP a saved tree reopens from. A piece's is its root's STEP, once written. */
function rootStepOf(tree: ModelTree): { name: string; bytes: ArrayBuffer } | null {
  if (tree.root.kind === "step") return { name: tree.root.name, bytes: tree.root.bytes };
  const root = tree.nodes.get(ROOT)?.mesh;
  return root?.step ? { name: stepFileName(root.name), bytes: root.step } : null;
}

type TreeToSave = { tree: Omit<SavedTree<never>, "rootStep">; rootStep: { name: string; bytes: ArrayBuffer } };

/**
 * What `.lime` keeps of each plate object's tree, by object id: the tree Model would resume for the
 * object's mesh, when it has a step, a name, or a piece a kept split names. A split piece's tree is
 * kept from the STEP of its own root, written here if Model has not, so it opens without the part
 * it was cut from; `unsaved` names the objects whose root the engine could not write. Trees of
 * objects no longer on the plate are not saved. Run after `captureOpenSolid`.
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
  const roots = new Map<string, { name: string; bytes: ArrayBuffer }>();
  const unsaved: string[] = [];
  for (const [id, { name, key }] of held) {
    // A root STEP written below can outlast the tree: a new file can replace the plate meanwhile.
    if (!modelTrees.has(key)) continue;
    const tree = treeOfKey(key);
    if (tree.nodes.size === 1 && !tree.nodes.get(ROOT)?.name && !named.has(key)) continue;
    const root = tree.nodes.get(ROOT)?.mesh;
    if (!rootStepOf(tree) && tree.root.kind === "piece" && root) await writeStep(root.token, key, ROOT);
    const rootStep = modelTrees.has(key) ? rootStepOf(treeOfKey(key)) : null;
    if (rootStep) roots.set(id, rootStep);
    else unsaved.push(name);
  }
  const owner = new Map([...roots.keys()].map((id) => [held.get(id)!.key, id]));
  const trees = new Map<string, TreeToSave>();
  for (const [id, rootStep] of roots) {
    const { key, node } = held.get(id)!;
    if (modelTrees.has(key)) trees.set(id, { tree: savedTree(treeOfKey(key), node, (piece) => owner.get(piece)), rootStep });
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
    const loaded = loadedTree(tree, key, { kind: "step", ...tree.rootStep }, obj.name, mesh, (id) => keys.get(id));
    modelTrees.set(key, loaded);
    if (obj.brep || (loaded.committed === ROOT && isStepName(obj.fileName))) stepKnown.add(token);
    if (obj.brep && loaded.committed !== ROOT) seeds.set(key, { node: loaded.committed, live: false, whole: null, reading: null });
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
  flushEdit();
  open = null;
  syncUndo();
  const mesh = state.mesh;
  const objectId = state.plate.selectedId;
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
    readout("Open a STEP file to measure a solid.");
    return;
  }
  // A tree that has no node with this mesh stays open: a Prepare undo or redo can bring one of its meshes back.
  const sourcePos = state.sourcePos ?? new Float32Array(0);
  const brep = obj.brep ?? null;
  if (brep || isStepName(mesh.name)) {
    const root: PlateMesh = { name: mesh.name, bytes: mesh.bytes, sourcePos, token, ...(brep ? { step: brep } : {}) };
    void openTree(mine, objectId, obj.name, brep ? stepFileName(mesh.name) : mesh.name, brep ?? mesh.bytes, root);
    return;
  }
  const source = [...modelTrees.values()].find((tree) => nodeWithMesh(tree, token) != null);
  if (!source) {
    readout("Model measure reads a STEP solid. This file is a mesh.");
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
    void openTree(mine, objectId, obj.name, stepFileName(mesh.name), step, { name: mesh.name, bytes: mesh.bytes, sourcePos, token, step });
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
  fx.model?.setSolid(null);
  refreshModelContext();
  fx.model?.highlight([]);
  syncModelChrome([]);
  showEdits(false);
}

function setMode(mode: "face" | "edge") {
  fx.model?.setPickMode(mode);
  picks = [];
  fx.model?.highlight([]);
  syncModelChrome([]);
  document.querySelector("#modelPickFace")?.setAttribute("aria-pressed", mode === "face" ? "true" : "false");
  document.querySelector("#modelPickFace")?.classList.toggle("on", mode === "face");
  document.querySelector("#modelPickEdge")?.setAttribute("aria-pressed", mode === "edge" ? "true" : "false");
  document.querySelector("#modelPickEdge")?.classList.toggle("on", mode === "edge");
  if (open) readout(`${about(open.solid)} Pick ${mode === "face" ? "a face" : "an edge"}.`);
}

/** Open the file's solid as the root of a new tree for the plate object. */
async function openTree(mine: number, objectId: string, label: string, name: string, bytes: ArrayBuffer, root: PlateMesh) {
  readout("Reading the solid…");
  const key = freshTreeKey(objectId);
  const chord = state.stepTolerance;
  const body = await post({ call: "open", key, filename: name, dataB64: bytesToBase64(new Uint8Array(bytes)), chordMm: chord });
  const parsed = asSolid(body);
  if (!parsed) {
    if (mine === ticket && state.stage === "model") readout(text(body.error) || "Could not read this STEP solid.");
    return;
  }
  modelTrees.set(key, withNode(newTree(key, { kind: "step", name, bytes }, label, parsed.fingerprint), ROOT, { mesh: root }));
  stepKnown.add(root.token);
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
      const late = text(body.error) || !modelTrees.get(key)?.nodes.has(node) ? null : asSolid(body);
      if (late && body.seeded) readSolids.add(late);
      if (late) keepSolid(key, node, chord, late);
      return false;
    }
    if (failed(key, body)) return false;
    solid = asSolid(body);
    if (!solid) {
      readout("The modeler returned no solid for this step.");
      return false;
    }
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
  if (!button || button.disabled || !open) return;
  const tool = modelTool();
  const op = toolOp(tool);
  if (!op) {
    if (tool === "fillet" || tool === "chamfer") readout(tool === "fillet" ? "Pick an edge to fillet." : "Pick an edge to chamfer.");
    return;
  }
  if (op.kind === "split") {
    const range = splitPlaneRange(zExtent(open.solid.positions));
    if (!range) {
      readout("This solid is too thin to split.");
      return;
    }
    if (!splitPlaneInside(op.origin[2], range)) {
      readout(`Move the plane into the part, between ${formatMm(range.min)} and ${formatMm(range.max)} mm.`);
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
  const parsed = asSolid(body);
  const other = pieceKey && body.other && typeof body.other === "object" ? asSolid(body.other as Body) : null;
  if (!parsed || (pieceKey && !other)) {
    readout(pieceKey ? "The plane did not split this solid." : "The modeler returned no solid.");
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
  if (op.kind === "split") return `Split. ${volume} The other piece sits in the same spot. Use Arrange to lay them side by side.${notes}`;
  if (op.kind === "fillet") return `Fillet. ${volume}${notes}`;
  if (op.kind === "chamfer") return `Chamfer. ${volume}${notes}`;
  if (op.kind === "hole") return `Hole. ${volume}${notes}`;
  return `${volume}${notes}`;
}

/** The split-off piece goes on the plate at once, in its parent's place, as the root of its own tree. */
function addPiece(at: Opened, other: ParsedSolid, key: string, split: NodeId): boolean {
  if (!state.mesh) return false;
  noteEdit();
  syncPlateFromState();
  const positions = settle(new Float32Array(other.positions));
  const fileName = `${stlName(state.mesh.name).replace(/\.stl$/i, "")} split.stl`;
  const bytes = encodeStl(positions, fileName);
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

/** Show `parsed` as the open tree's current node. */
function present(parsed: ParsedSolid, message: string) {
  picks = [];
  fx.model?.setSolid(parsed);
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

/** The other plate objects, grey, in the open solid's frame. Nothing is drawn without an open solid. */
export function refreshModelContext() {
  const box = open ? boxOf(open.solid.positions) : null;
  fx.model?.setContext(box && open ? contextParts(livePlate(), open.objectId, box, state.profile.bedX, state.profile.bedY) : []);
}

function showEdits(on: boolean) {
  document.querySelector("#modelEdit")?.toggleAttribute("hidden", !on);
  if (!on) closeModelTool();
}

function syncUndo() {
  const tree = treeOf(open);
  const undo = document.querySelector<HTMLButtonElement>("#modelUndo");
  const redo = document.querySelector<HTMLButtonElement>("#modelRedo");
  if (undo) undo.disabled = busy || jumping || !tree || undoTarget(tree) == null;
  if (redo) redo.disabled = busy || jumping || !tree || redoTarget(tree) == null;
  const stepButton = document.querySelector<HTMLButtonElement>("#modelStep");
  if (stepButton) stepButton.disabled = busy || jumping || !tree;
  setModelWaiting(busy || jumping);
  syncModelHistory(tree);
}

/** Turn degrees for a box or cylinder. A sphere does not turn. */
function turn(): Vec3 {
  if (prim() === "sphere") return [0, 0, 0];
  return [num("#modelRx"), num("#modelRy"), num("#modelRz")];
}

function boxOf(positions: Float32Array): { min: [number, number, number]; max: [number, number, number] } | null {
  if (positions.length < 3) return null;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[i + axis]!;
      if (value < min[axis]!) min[axis] = value;
      if (value > max[axis]!) max[axis] = value;
    }
  }
  return { min, max };
}

function prim(): "box" | "cylinder" | "sphere" {
  const value = document.querySelector<HTMLSelectElement>("#modelPrim")?.value;
  return value === "cylinder" || value === "sphere" ? value : "box";
}

/** Into the last picked face, or straight down when no face is picked. */
function drillAxis(): Vec3 {
  const face = lastFace(picks);
  if (!open || face == null) return [0, 0, -1];
  const stored = open.solid.faces.find((item) => item.id === face)?.normal;
  return holeAxis(stored ?? outwardFromMesh(open.solid.positions, open.solid.triangles, face));
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

function readNormal(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const normal = value.slice(0, 3).map((item) => (typeof item === "number" ? item : Number.NaN));
  if (normal.some((item) => !Number.isFinite(item))) return null;
  return [normal[0]!, normal[1]!, normal[2]!];
}

function readFingerprint(value: unknown): Fingerprint | null {
  if (!value || typeof value !== "object") return null;
  const row = value as { volumeMm3?: unknown; faces?: unknown; edges?: unknown };
  if (typeof row.volumeMm3 !== "number" || typeof row.faces !== "number" || typeof row.edges !== "number") return null;
  return { volumeMm3: row.volumeMm3, faces: row.faces, edges: row.edges };
}

function asSolid(body: Body): ParsedSolid | null {
  if (typeof body.volumeMm3 !== "number" || !Array.isArray(body.positions) || !Array.isArray(body.triangles)) return null;
  const faces = Array.isArray(body.faces) ? body.faces.flatMap((face) => {
    if (!face || typeof face !== "object") return [];
    const row = face as { id?: unknown; areaMm2?: unknown; normal?: unknown };
    if (typeof row.id !== "number" || typeof row.areaMm2 !== "number") return [];
    const normal = readNormal(row.normal);
    return [{ id: row.id, areaMm2: row.areaMm2, ...(normal ? { normal } : {}) }];
  }) : [];
  const edges = Array.isArray(body.edges) ? body.edges.flatMap((edge) => {
    if (!edge || typeof edge !== "object") return [];
    const row = edge as { id?: unknown; lengthMm?: unknown; points?: unknown };
    if (typeof row.id !== "number" || typeof row.lengthMm !== "number" || !Array.isArray(row.points)) return [];
    return [{ id: row.id, lengthMm: row.lengthMm, points: Float32Array.from(row.points.filter((item) => typeof item === "number")) }];
  }) : [];
  return {
    id: typeof body.id === "number" ? body.id : ROOT,
    volumeMm3: body.volumeMm3,
    positions: Float32Array.from(body.positions.filter((item) => typeof item === "number")),
    triangles: body.triangles.filter((item) => typeof item === "number"),
    faces,
    edges,
    fingerprint: readFingerprint(body.fingerprint),
    editable: body.solid !== false,
  };
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
    if (!tree || tree.root.kind !== "step") return "This solid is no longer open.";
    const body = await post({
      call: "open",
      key,
      filename: tree.root.name,
      dataB64: bytesToBase64(new Uint8Array(tree.root.bytes)),
      chordMm: state.stepTolerance,
      nodes: savedNodes(tree),
      current: node,
    });
    if (seed) seed.whole = null;
    if (!modelTrees.has(key)) return closeLate(key);
    const problem = typeof body.broken === "number" ? "" : text(body.error);
    if (problem) return problem;
    if (seed) forgetShown(key);
    seeds.delete(key);
    return null;
  })();
  if (seed) seed.whole = run;
  return run;
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
    if (tree.root.kind === "step") return openWhole(key, node);
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
