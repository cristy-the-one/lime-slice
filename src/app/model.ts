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
  jumped,
  newTree,
  nodeWithMesh,
  opLabel,
  pathTo,
  redoTarget,
  reserveId,
  savedNodes,
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
import {
  closeModelTool,
  mountModelChrome,
  openModelTool,
  refreshModelGhost,
  setModelEditable,
  setModelProbe,
  syncModelChrome,
  syncModelSolid,
} from "../ui/model-chrome";
import { addedSplit, meshTokenOf, withBrepFor } from "../plate";
import { base64ToBytes } from "../project";
import { authHeaders } from "../ui/api-base";
import { livePlate, place } from "./files";
import { endModelVisit, flushEdit, markModelEdit, noteEdit, patchEditBrep } from "./history";
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
let probeSerial = 0;
let probeTimer = 0;
let pendingProbe: (() => void) | null = null;
let open: Opened | null = null;
/** The plate object Model last opened, so a selection change elsewhere can tell it moved. */
let shownFor: string | null = null;
const solids = new Map<string, ParsedSolid>();
/** Mesh tokens whose plate objects already carry that shape's STEP, or whose mesh is the STEP file itself. */
const stepKnown = new Set<string>();
/** Kernel answers by `probeKey`. */
const answers = new Map<string, ProbeView>();
/** Restores in flight, by tree key. */
const restoring = new Map<string, Promise<string | null>>();

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
  if (!at || !tree || !plan || !state.mesh || at.objectId !== state.plate.selectedId) return;
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
  // A Prepare undo can have taken off a piece that a split on this path cut off: the plate gets it back.
  for (const id of pathTo(tree, plan.to)) {
    const key = tree.nodes.get(id)?.piece;
    const piece = key ? modelTrees.get(key) : undefined;
    const pieceMesh = piece?.nodes.get(piece.committed)?.mesh;
    if (key && pieceMesh && !state.plate.objects.some((obj) => obj.modelTree === key)) placePiece(key, pieceMesh);
  }
  place();
  flushEdit();
  markModelEdit();
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
  solids.clear();
  answers.clear();
  stepKnown.clear();
  open = null;
  shownFor = null;
  ticket += 1;
  busy = false;
}

/** A plate action changed the selection while Model is open: the view opens the selected object's solid. */
export function followSelection() {
  if (state.stage === "model" && state.plate.selectedId !== shownFor) showModel();
}

export function showModel() {
  const mine = ++ticket;
  picks = [];
  busy = false;
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
  const stale = obj.modelTree ? modelTrees.get(obj.modelTree) : undefined;
  if (stale) closeTree(stale.key);
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
  if (good == null || good === node || !(await showNode(mine, objectId, key, good, (solid) => `${BROKEN} ${greeting(solid)}`))) {
    if (mine === ticket) clearView();
  }
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

function closeTree(key: string) {
  modelTrees.delete(key);
  for (const name of solids.keys()) if (name.startsWith(`${key}#`)) solids.delete(name);
  void post({ call: "close", key });
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

/** Show `node` of the open tree: from the recent solids when it is there, else from the engine. */
async function showNode(mine: number, objectId: string, key: string, node: NodeId, message: (solid: ParsedSolid) => string): Promise<boolean> {
  const tree = modelTrees.get(key);
  if (!tree) return false;
  if (brokenOnPath(tree, node)) {
    readout(BROKEN);
    return false;
  }
  const chord = state.stepTolerance;
  let solid: ParsedSolid | null = recentSolid(key, node, chord) ?? null;
  if (!solid) {
    busy = true;
    syncUndo();
    const body = await treeCall(key, node, { call: "goto", key, node, chordMm: chord });
    if (mine === ticket) busy = false;
    syncUndo();
    if (mine !== ticket || state.stage !== "model") return false;
    if (failed(key, body)) return false;
    solid = asSolid(body);
    if (!solid) {
      readout("The modeler returned no solid for this step.");
      return false;
    }
    keepSolid(key, node, chord, solid);
  }
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
  if (!at || node == null || busy) return;
  await showNode(ticket, at.objectId, at.key, node, (solid) => `${about(solid)} ${done}`);
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
  if (!at || !tree || busy || !state.mesh) return;
  if (at.objectId !== state.plate.selectedId) {
    followSelection();
    return;
  }
  const parent = tree.current;
  const twin = childWithOp(tree, parent, op);
  if (twin != null) {
    // These numbers already built a step from here: show it rather than build it again.
    await showNode(ticket, at.objectId, at.key, twin, (solid) => appliedMessage(op, solid));
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
    void post({ call: "drop", key: at.key, node });
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
  if (!at || !tree || busy || !state.mesh) return;
  const node = tree.current;
  busy = true;
  readout("Writing STEP…");
  const mine = ticket;
  const step = await exportStep(at.key, node);
  if (mine === ticket) busy = false;
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
    const tree = obj.modelTree ? modelTrees.get(obj.modelTree) : undefined;
    const token = meshTokenOf(obj.bytes);
    const node = tree ? nodeWithMesh(tree, token) : null;
    if (!tree || node == null || stepKnown.has(token) || asked.has(token)) continue;
    asked.add(token);
    const step = await exportStep(tree.key, node);
    if (typeof step === "string") failedTokens.push(token);
    else putStep(token, step);
  }
  return failedTokens;
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
  if (undo) undo.disabled = busy || !tree || undoTarget(tree) == null;
  if (redo) redo.disabled = busy || !tree || redoTarget(tree) == null;
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
  let body = await post(request);
  for (let round = 0; round < 2; round += 1) {
    const missing = missingOf(body);
    if (!missing) return body;
    const running = round === 0 ? restoring.get(key) : undefined;
    const restored = running ?? restore(key, node, missing).finally(() => restoring.delete(key));
    if (!running) restoring.set(key, restored);
    const problem = await restored;
    if (problem) return { error: problem };
    body = await post(request);
  }
  return missingOf(body) ? { error: "The modeler no longer has this solid. Open Model again to reload it." } : body;
}

async function restore(key: string, node: NodeId, missing: NodeId[]): Promise<string | null> {
  const tree = modelTrees.get(key);
  if (!tree) return "This solid is no longer open.";
  const chord = state.stepTolerance;
  if (missing.includes(ROOT)) {
    if (tree.root.kind === "step") {
      const body = await post({
        call: "open",
        key,
        filename: tree.root.name,
        dataB64: bytesToBase64(new Uint8Array(tree.root.bytes)),
        chordMm: chord,
        nodes: savedNodes(tree),
      });
      // `open` registers every saved node, so nothing else is missing.
      return text(body.error) || null;
    }
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
  await post({ call: "drop", key: parentKey, node: spare });
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

Object.assign(fx, { refreshModelContext, commitModel, forgetModelTrees, followSelection });
