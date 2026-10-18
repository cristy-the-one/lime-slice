import { base64ToBytes, bytesToBase64 } from "../base64";
import { boundsOf, encodeStl, settleBy, type Bounds, type Mat3 } from "../mesh-place";
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
  fromSolidOp,
  seatLift,
  thenPose,
  toSolidOp,
  turnDir,
  type Affine,
  type PlaceFields,
} from "../model-space";
import { builtBranch, crossEdit, crossPlan, editHead, editNotes, editPanel, editRefusal, editedOp, FEATURE_ROOT_EDIT, forked, matchEdges, matchFaces, olderSplitNote, replayChain, stepIds, toolEditHead, toolEditRefusal, toolPose, type EditLevel, type EditPanel, type ForkStep, type ToolLink } from "../model-edit";
import { primitiveBounds, primitiveName, rootSpec, type PrimitiveSpec } from "../model-primitive";
import { markProjectDirty } from "../project-dirty";
import { unionBox } from "../measure";
import type { ModelPick } from "../model-view";
import { DAMAGED, decodeSolid, readFingerprint, type ParsedSolid } from "../model-reply";
import { holeAxis, lastFace, outwardFromMesh, selectedEdges, selectedFaces } from "../model-blend";
import { throughLength } from "../model-hole";
import { nextModelPicks, selectionCountLabel } from "../model-select";
import { contextParts } from "../model-context";
import { PROBE_WAIT_MS, disjointBoolean, isProbed, probeFromBody, probeKey, type ProbeView } from "../model-feasibility";
import { locatedBoxes } from "../model-check.ts";
import { boxExtentAlong, extentAlong, extentMemo, faceCentre, facePlane, planeFor, splitBase, splitNote, type AxisExtent, type FacePlane, type SplitState } from "../model-plane";
import {
  ROOT,
  childWithOp,
  closeOrder,
  dropped,
  jumped,
  newTree,
  nodeWithMesh,
  opLabel,
  isEdgeStep,
  pathTo,
  reachableTrees,
  renumberedSteps,
  reserveId,
  rootLabel,
  featureObjectName,
  subtree,
  toolKeys,
  usesTree,
  visitStep,
  withChild,
  withNode,
  type FeatureOp,
  type Fingerprint,
  type ModelOp,
  type ModelRoot,
  type ModelTree,
  type NodeId,
  type PlateMesh,
  type PrepareKeep,
  type Vec3,
} from "../model-tree";
import { loadedTree, savedTree, toolFirst, type SavedTree } from "../model-tree-file";
import { applyRequest, crossEditRequest, editRequest, exportRequest, gotoRequest, isBrep, joinOp, newSolidRequest, openRequest, probeRequest, shellOp, stepEdges, stepEdgesRequest, wholeTreeRequest } from "../model-request";
import { edgeOfText, remapBlendFromNode, storedEdgeStep } from "../model-edge-step";
import {
  closeModelTool,
  editedPanel,
  fieldNumber,
  fieldPrimitive,
  holeBoxes,
  joinOpen,
  joinPick,
  mountModelChrome,
  openEditTool,
  openPlaceTool,
  refreshJoinChoices,
  resetKeepTool,
  openModelTool,
  // --- A5. Fillet and chamfer: picked edges, or the edges one history step made. ---
  edgeFilterChoice,
  edgeMode,
  edgeStepId,
  edgeStepKnown,
  setEdgeStep,
  setStepEdgeIndexes,
  stepEdgesOnSolid,
  refreshModelCheck,
  refreshModelGhost,
  setModelEditable,
  setModelLocked,
  setModelPreview,
  setModelProbe,
  setModelWaiting,
  shellClosed,
  syncModelChrome,
  splitMode,
  syncModelSolid,
  syncPlaceFields,
  syncWorkplaneFields,
  toolFrame,
  type PlacePhase,
} from "../ui/model-chrome";
import { mountModelHistory, syncModelHistory, syncModelPosition, syncModelRecipe } from "../ui/model-history";
import { dropRefusal, foldEndingAt, foldRedoFrom, foldedRedoTarget, foldedUndoTarget, readRow, recipeNote, rowKey, rowStep, stepLabel, type RowKey } from "../model-history";
import { addedSolid, addedSplit, freshPlateId, meshSeat, meshToModel, meshTokenOf, modelPoseOf, setMeshSeat, withBrepFor, withModelPose, withWorkplane, withoutObject, type PlateObject } from "../plate";
import type { ContextPart } from "../model-context";
import { authHeaders } from "../ui/api-base";
import { livePlate, openMeshPicker, pickAddedMesh, place } from "./files";
import { beginEdit, editHistoryRefs, endModelVisit, flushEdit, markModelEdit, noteEdit, patchEditBrep } from "./history";
import { fx } from "./fx";
import { modelerFailure, plainModelError } from "./model-error";
import { freshTreeKey, modelTrees } from "./model-trees";
import { applySelectedToState, syncPlateFromState } from "./plate-sync";
import { apiBase, apiToken, isStepName } from "./settings";
import { session, state } from "./state";
import { closeCracks } from "../mesh-check";
import { meshKeyHex } from "../slice-action";
import { axesOf, drillDown, isGlobalFrame, isIdentityFrame, planePoint, planePrimitive, printOrient, sameWorkplane, workplaneIn, workplaneOnFace, workplaneOwn, type Workplane } from "../workplane";

type Body = Record<string, unknown>;

/** The tree in the view, the plate object it belongs to, and the solid of its current node. */
interface Opened {
  objectId: string;
  key: string;
  solid: ParsedSolid;
}

const VIEW_ONLY = "Surfaces only. This file can be measured but not edited.";
const BROKEN = "This step could not be rebuilt, so it and the steps after it are unavailable.";
const ROOT_BROKEN = "This solid's primitive builds differently in this modeler, so its history cannot be rebuilt.";
/** Ops that name edges or faces by the solid's own numbering: they build only on a step the history built. */
const NAMES_TOPOLOGY = new Set<string>(["fillet", "chamfer", "shell"]);
/** A history longer than this many steps rebuilds a few steps per call, with a count in the readout. */
const COUNTED_REBUILD = 20;
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
let pendingProbe: (() => Promise<void>) | null = null;
/** A check the engine is running. The engine runs one call at a time, so a newer check waits for it, and only the newest. */
let probing = false;
let open: Opened | null = null;
/** The plate object Model last opened, so a selection change elsewhere can tell it moved. */
let shownFor: string | null = null;
/** A tree resumed above its broken committed step: the plate keeps that step's mesh until the user moves. */
let parked: string | null = null;
const solids = new Map<string, ParsedSolid>();
/** Mesh tokens whose plate objects already carry that shape's solid (`brep`), or whose mesh is the STEP file itself. */
const stepKnown = new Set<string>();
/** Solid exports on their way, by mesh token, so a save during the write after leaving Model waits for it. */
const writing = new Map<string, Promise<ArrayBuffer | string>>();
/** Kernel answers by `probeKey`. */
const answers = new Map<string, ProbeView>();
/** Restores in flight, by tree key. */
const restoring = new Map<string, Promise<string | null>>();

/**
 * A tree from a project saved before version 3, whose `brep` is STEP, until the engine has the whole of it. Once `live`,
 * the engine holds the plate's step (`node`), read from that step's STEP, as its root: enough to look and measure.
 * An edit, or a call on any other step, first opens the whole tree from its root STEP and ops
 * (`whole`, while that is on its way). Every call waits for that, and for a read of the step's STEP
 * (`reading`) after an engine restart.
 */
interface Seed {
  node: NodeId;
  /** The steps the engine holds while the seed is live: the plate's step, and the steps applied on it since. */
  held: Set<NodeId>;
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
/**
 * The open object's workplane steps in this visit: its frame as the object stores it, and its plate orient, which only
 * Print with W up changes. One gesture is one Prepare step, and Undo here steps them while the Workplane tool is open.
 */
type WorkplaneStep = { plane: Workplane | undefined; orient: Mat3 };
let wpUndo: WorkplaneStep[] = [];
let wpRedo: WorkplaneStep[] = [];
/** Where a workplane gesture started, while it is under way. */
let wpBefore: WorkplaneStep | null = null;
let wpTimer = 0;
/** Each solid's, and each plate mesh's, box in its own frame. */
const ownBoxes = new WeakMap<Float32Array, Bounds>();
/** Mesh tokens of objects whose STEP opened as surfaces with no closed solid: never a join's tool. */
const surfacesOnly = new Set<string>();
/** Trees on their way for objects picked as a join's tool before Model ever opened them, by object id. */
const toolOpens = new Map<string, Promise<{ key: string; node: NodeId } | string>>();
/** The object drawn as the join's ghost rather than grey, and the readout's last account of the join. */
let ghosted: string | null = null;
let joinSaid = "";
let refreshingContext = false;
/** Counts the plates Model has forgotten, so a tree opened for an earlier one is let go. */
let plateEra = 0;
const CYCLE = "The tool object's history already uses this part, so the two cannot be joined";
const STILL_WORKING = "The modeler is still working. Try again in a moment.";
/** What the tools say while a tool's step is looked at in History. */
const PEEK_LOCK = "This is a step of a tool this part was joined with. Edit step changes it; pick a step of this part to work on it.";

/**
 * A step being edited: its tool is open on the step's parent, which the view shows, with the step's own numbers.
 * `parent` is where the edit builds (the root itself for a new solid's root); `from` is the step shown before, where
 * Cancel goes back to; `replay` the steps that replay under the edit, oldest first. `opened` is the op the panel said
 * when it opened, so an untouched panel offers no Update.
 *
 * A tool's step, edited from the open solid's History, is in the tool's tree (`key`), reached through `joins` from the
 * open tree (`target`); `from` and `replay` are the open tree's, and `row` names the step in History. For the open
 * solid's own step, `key` is `target` and `joins` is empty.
 */
interface Editing {
  key: string;
  target: string;
  row: RowKey;
  joins: ToolLink[];
  node: NodeId;
  parent: NodeId;
  from: NodeId;
  replay: NodeId[];
  op: ModelOp;
  panel: EditPanel | null;
  opened: string | null;
}
let editing: Editing | null = null;

/**
 * A tool's step on screen in place of the open solid's: what a click on a tool's row in History shows, read-only, and
 * what an edit of a tool's step builds on. It sits where the joins put it (`pose`), and `open` stays the open solid's
 * shown step throughout, so the plate, Undo and a save never see it. `row` names it in History; `key` and `node` in
 * the engine.
 */
interface Lens {
  row: RowKey;
  key: string;
  node: NodeId;
  joins: ToolLink[];
  pose: Affine;
  solid: ParsedSolid;
}
let lens: Lens | null = null;
/** The last edit, so Undo goes from its tip back to the step shown before it, and Redo forward again. */
let editBack: { key: string; tip: NodeId; back: NodeId; undone: boolean } | null = null;

export function bindModelView() {
  fx.model?.onPick((pick: ModelPick | null, shift: boolean) => void onPick(pick, shift));
  document.querySelector("#modelPickFace")?.addEventListener("click", () => setMode("face"));
  document.querySelector("#modelPickEdge")?.addEventListener("click", () => setMode("edge"));
  document.querySelector("#modelApply")?.addEventListener("click", () => void applyTool());
  document.querySelector("#modelStep")?.addEventListener("click", () => void runExport());
  // While Place is open, Undo and Redo step its moves; the solid's history waits until it closes.
  document.querySelector("#modelUndo")?.addEventListener("click", () => {
    if (openModelTool() === "place") placeStep("undo");
    else if (openModelTool() === "workplane") workplaneStep("undo");
    else void step("undo");
  });
  document.querySelector("#modelRedo")?.addEventListener("click", () => {
    if (openModelTool() === "place") placeStep("redo");
    else if (openModelTool() === "workplane") workplaneStep("redo");
    else void step("redo");
  });
  document.querySelector("#modelResetView")?.addEventListener("click", (ev) => frameModel((ev as MouseEvent).shiftKey));
  document.querySelector("#modelEmptyNew")?.addEventListener("click", () => {
    document.querySelector<HTMLButtonElement>("#modelToolNew")?.click();
    // The card hides with its button: focus goes on to the primitive picked.
    document.querySelector<HTMLButtonElement>('#modelPrim [aria-checked="true"]')?.focus();
  });
  document.querySelector("#modelEmptyOpen")?.addEventListener("click", () => (state.plate.objects.length > 0 ? pickAddedMesh() : openMeshPicker()));
  mountModelChrome({
    clearSelection() {
      if (lens && !editing && open) {
        present(open.solid, about(open.solid));
        return;
      }
      picks = [];
      paintBlendHighlight();
      syncModelChrome([]);
      const solid = viewed();
      if (solid) readout(`${about(solid)} Pick a face or an edge.`);
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
      if (wpBefore && openModelTool() !== "workplane") endWorkplane();
      if (ghostId() !== ghosted) refreshModelContext();
      sayJoin();
      // --- A5. Outline the step's edges, and ask the engine when the step or the filter changed. ---
      void refreshStepEdges();
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
    // --- A7 model check ---
    checkSource() {
      const solid = viewed();
      if (solid && solid.positions.length >= 9) return { positions: solid.positions, toModel: openPose() };
      const obj = state.plate.objects.find((item) => item.id === state.plate.selectedId);
      if (obj && obj.sourcePos.length >= 9) return { positions: obj.sourcePos, toModel: meshToModel(obj) };
      return null;
    },
    edgePoints(edge) {
      const points = viewed()?.edges.find((item) => item.id === edge)?.points;
      const pose = openPose();
      if (!points || isIdentity(pose)) return points ?? null;
      const out = new Float32Array(points.length);
      for (let i = 0; i + 2 < points.length; i += 3) out.set(applyPose(pose, [points[i]!, points[i + 1]!, points[i + 2]!]), i);
      return out;
    },
    holeAxis() {
      return drillAxis();
    },
    throughLength(origin, dir) {
      const solid = viewed();
      if (!solid) return null;
      // In the solid's own frame, from its own box, read once per solid, as the kernel measures it.
      const back = inversePose(openPose());
      return throughLength(boxOf(solid.positions), applyPose(back, origin), turnDir(back, dir));
    },
    placeFields() {
      return open ? placeFields(objectPose(), pivotOf(open.solid)) : null;
    },
    placeMoved,
    workplane: workplaneOfOpen,
    workplaneMoved,
    faceWorkplane,
    workplaneSet(plane) {
      endWorkplane();
      workplaneMoved(plane, "end");
    },
    editing: () => !!editing,
    printsWUp() {
      const obj = plateObjectOpen();
      return !obj || sameMat(state.orient, printOrient(obj.workplane));
    },
    printWUp,
    newSolidAt,
    frameNewSolid(spec) {
      const others = plateBoxes();
      fx.model?.frame(unionBox([primitiveBounds(newSolidAt(spec, others)), ...others])!);
    },
    joinChoices() {
      const at = open;
      return at ? livePlate().filter((obj) => obj.id !== at.objectId && solidObject(obj)).map((obj) => ({ id: obj.id, name: obj.name })) : [];
    },
    joinGhost(id) {
      const obj = livePlate().find((item) => item.id === id);
      return obj ? { id, positions: obj.sourcePos, matrix: meshToModel(obj) } : null;
    },
    notATool(id) {
      const obj = state.plate.objects.find((item) => item.id === id);
      if (!obj) return;
      readout(surfacesOnly.has(meshTokenOf(obj.bytes)) ? `${obj.name} has surfaces but no closed solid, so it cannot be a tool.` : `${obj.name} is a mesh, so it cannot be a tool.`);
      joinSaid = "";
    },
    editClosed: cancelEdit,
    editJoinGhost,
    editUnchanged: editUntouched,
    // --- A5. The blend is built on the step on screen, and can take edges from it or a step above it. ---
    shownNode() {
      return blendTarget()?.node ?? null;
    },
    edgeSteps() {
      return edgeStepChoices();
    },
    // --- A2 shell ---
    shellSeat() {
      return shellSeat();
    },
  });
  mountModelHistory({
    jump(row) {
      // --- A5. While Fillet or Chamfer takes a step's edges, a history row chooses that step. ---
      if (takeEdgeStep(row)) return;
      const step = ownStep(row);
      if (step != null) void jumpTo(step);
      else void peekTool(row);
    },
    rename: renameStep,
    dropRefusal: whyKeepBranch,
    drop: dropBranch,
    editRefusal(row) {
      const tree = treeOf(open);
      const step = tree ? rowStep(modelTrees, tree, row) : null;
      if (!step) return "This step is no longer in the history.";
      return step.joins.length === 0 ? editRefusal(step.tree, step.id) : toolEditRefusal(step.tree, step.joins, step.id);
    },
    edit(row) {
      // Shift+E away from History edits the step shown; while an edit is open that is its parent, so the key waits.
      const tree = treeOf(open);
      if (row != null) void startEdit(row);
      else if (tree && !editing) void startEdit(lens?.row ?? rowKey([], tree.current));
    },
    openPlace: openPlaceTool,
    resetPosition: resetPose,
  });
}

/** While a step is edited: its panel still says the step as it is, so Update would change nothing and no check is needed. */
function editUntouched(): boolean {
  const run = editing;
  return !!run && (run.opened == null || JSON.stringify(editOp(run)) === run.opened);
}

function treeOf(at: Opened | null): ModelTree | null {
  return at ? modelTrees.get(at.key) ?? null : null;
}

/**
 * --- A5. The solid a blend is built on: the edited step's parent, a tool's step on screen, or the open solid's
 * current step. Edges may come from that step or one above it.
 */
function blendTarget(): { key: string; node: NodeId; tree: ModelTree } | null {
  if (editing) {
    const tree = modelTrees.get(editing.key);
    return tree ? { key: editing.key, node: editing.parent, tree } : null;
  }
  const at = open;
  const tree = treeOf(at);
  if (!at || !tree) return null;
  if (lens) {
    const shown = modelTrees.get(lens.key);
    return shown ? { key: lens.key, node: lens.node, tree: shown } : null;
  }
  return { key: at.key, node: tree.current, tree };
}

/** The step on screen and the steps above it, root first, as the step list shows them. */
function edgeStepChoices(): { id: number; label: string }[] {
  const target = blendTarget();
  if (!target) return [];
  return pathTo(target.tree, target.node).flatMap((id) => {
    const node = target.tree.nodes.get(id);
    return node ? [{ id, label: stepLabel(node) }] : [];
  });
}

/**
 * A history row chooses the step whose edges the blend takes. It does not jump. A row of another solid, or a step
 * that is not on this solid or above it, is said and left.
 */
function takeEdgeStep(row: RowKey): boolean {
  const tool = openModelTool();
  if ((tool !== "fillet" && tool !== "chamfer") || edgeMode() !== "step") return false;
  const at = open;
  const openTree = treeOf(at);
  const target = blendTarget();
  if (!at || !openTree || !target) return true;
  const step = rowStep(modelTrees, openTree, row);
  if (!step || step.tree.key !== target.key) {
    readout("A blend takes edges from a step of this solid.");
    return true;
  }
  if (!pathTo(target.tree, target.node).includes(step.id)) {
    readout("A blend can only take edges from this step's parent or a step above it.");
    return true;
  }
  setEdgeStep(step.id);
  return true;
}

/** Outline the step's edges while the blend takes them, and the picks otherwise. */
function paintBlendHighlight() {
  const tool = openModelTool();
  if ((tool === "fillet" || tool === "chamfer") && edgeMode() === "step") {
    fx.model?.highlight(stepEdgesOnSolid().map((index) => ({ kind: "edge", index })));
    return;
  }
  fx.model?.highlight(picks);
}

/** Which step and filter the edge query last answered, so a size change does not ask again. */
let stepEdgeKey = "";
let stepEdgeSerial = 0;
/** One rebuild of a seeded history, shared by the edge query and the dry-run, including the jump back to the step on screen. */
const edgeHistory = new Map<string, Promise<string | null>>();

/**
 * A saved solid stands in for the plate's step, so a step above it is not in the engine until the history is rebuilt.
 * The edge indexes are then read on the step on screen. A step the engine already holds needs nothing.
 */
function ensureEdgeHistory(key: string, viewed: NodeId, steps: readonly NodeId[]): Promise<string | null> {
  const seed = seeds.get(key);
  if (!seed?.live || steps.every((id) => seed.held.has(id))) return Promise.resolve(null);
  const running = edgeHistory.get(key);
  if (running) return running;
  const run = (async () => {
    const problem = await openWhole(key, viewed);
    if (problem) return problem;
    const body = await post(gotoRequest(key, viewed, state.stepTolerance));
    noteHeld(key, body);
    return text(body.error) || null;
  })().finally(() => {
    if (edgeHistory.get(key) === run) edgeHistory.delete(key);
  });
  edgeHistory.set(key, run);
  return run;
}

/** The engine's root is the plate's step while a saved solid stands in for it. */
function sameShownSolid(key: string, viewed: NodeId, engineId: number): boolean {
  if (engineId === viewed) return true;
  const seed = seeds.get(key);
  return !!seed?.live && viewed === seed.node && engineId === ROOT;
}

/** Ask which edges the chosen step left on the solid on screen, and outline them. */
async function refreshStepEdges() {
  const tool = openModelTool();
  if ((tool !== "fillet" && tool !== "chamfer") || edgeMode() !== "step") {
    const stale = stepEdgeKey !== "" || stepEdgesOnSolid().length > 0;
    stepEdgeKey = "";
    stepEdgeSerial += 1;
    if (stepEdgesOnSolid().length > 0) setStepEdgeIndexes([]);
    // The outline goes back to the picked edges once a step's edges are no longer what the blend takes.
    if (stale) paintBlendHighlight();
    return;
  }
  const target = blendTarget();
  const step = edgeStepId();
  if (!target || step == null || !edgeStepKnown()) {
    stepEdgeKey = "";
    stepEdgeSerial += 1;
    setStepEdgeIndexes([]);
    paintBlendHighlight();
    return;
  }
  const filter = edgeFilterChoice();
  const key = `${target.key}|${target.node}|${step}|${filter}`;
  if (key === stepEdgeKey) {
    paintBlendHighlight();
    return;
  }
  const serial = ++stepEdgeSerial;
  stepEdgeKey = key;
  const problem = await ensureEdgeHistory(target.key, target.node, [step]);
  if (serial !== stepEdgeSerial || edgeMode() !== "step") return;
  if (problem) {
    stepEdgeKey = "";
    setStepEdgeIndexes([]);
    paintBlendHighlight();
    return;
  }
  const body = await treeCall(target.key, target.node, stepEdgesRequest(target.key, step, filter));
  if (serial !== stepEdgeSerial || edgeMode() !== "step") return;
  const now = blendTarget();
  if (!now || `${now.key}|${now.node}|${edgeStepId()}|${edgeFilterChoice()}` !== key) return;
  const id = body.id;
  const indexes = typeof body.error === "string" || (typeof id === "number" && !sameShownSolid(target.key, target.node, id))
    ? []
    : Array.isArray(body.edges) ? body.edges.filter((index): index is number => typeof index === "number" && Number.isInteger(index) && index >= 0) : [];
  setStepEdgeIndexes(indexes);
  paintBlendHighlight();
}

/** The engine's name for one node's shape, which never changes. */
function nodeName(key: string, node: NodeId) {
  return `${key}#${node}`;
}

/**
 * --- A7 model check --- A probe's hollows and loose pieces, drawn in model space.
 * A check still in flight keeps the boxes already drawn.
 */
let locatedNow: Bounds[] | null = null;

function publishProbe(view: ProbeView) {
  setModelProbe(view);
  if (view?.phase === "checking") return;
  if (view?.phase === "done" && view.located && view.located.length > 0) {
    showLocated(view.located.map((box) => boxUnder(box, openPose())));
    return;
  }
  showLocated(null);
}

function showLocated(boxes: Bounds[] | null) {
  locatedNow = boxes && boxes.length > 0 ? boxes : null;
  fx.model?.setLocated(locatedNow);
  paintReadout();
}

function frameLocated() {
  const box = locatedNow ? unionBox(locatedNow) : null;
  if (box) fx.model?.frame(box);
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
  const editable = !!viewed()?.editable;
  const op = editable && isProbed(tool) && !editUntouched() ? panelOp() : null;
  const picked = editable ? joinPick() : null;
  if (at && tree && !op && picked) {
    // A tool Model never opened gets its tree first: the engine builds the join from it.
    publishProbe({ phase: "checking" });
    void readyTool(serial, picked);
    return;
  }
  if (!at || !tree || !op) {
    publishProbe(null);
    setModelPreview(null);
    return;
  }
  if (op.kind === "boolean") {
    const solid = viewed();
    const missed = solid ? disjointBoolean(boundsOf(solid.positions), op, op.op) : null;
    if (missed) {
      publishProbe({ phase: "done", ok: false, error: missed });
      setModelPreview(null);
      return;
    }
  }
  // The dry-run builds on the step on screen: a tool's, while one of its steps is edited.
  const [treeKey, node] = lens ? [lens.key, lens.node] : [at.key, tree.current];
  if (op.kind === "join" && usesTree(modelTrees, op.tool.key, treeKey)) {
    publishProbe({ phase: "done", ok: false, error: CYCLE });
    setModelPreview(null);
    return;
  }
  const key = probeName(treeKey, node, op);
  const known = answers.get(key);
  const shape = previewOf(key);
  // A check that worked shows its shape; one whose shape left the few kept asks again, since the shape is what is shown.
  if (known && !(shaped.has(key) && !shape)) {
    publishProbe(known);
    setModelPreview(shape);
    return;
  }
  publishProbe({ phase: "checking" });
  pendingProbe = () => sendProbe(serial, key, treeKey, node, op);
  if (wait > 0) probeTimer = window.setTimeout(sendPending, wait);
  else sendPending();
}

/** A kernel answer's name: the node and the op. Whether a join keeps its tool on the plate changes no solid, so it is left out. */
function probeName(key: string, node: NodeId, op: ModelOp): string {
  return probeKey(nodeName(key, node), op.kind === "join" ? { ...op, keepTool: false } : op);
}

/** The picked tool's tree is opened; then the dry-run goes ahead, unless the panel moved on meanwhile. */
async function readyTool(serial: number, id: string) {
  const obj = state.plate.objects.find((item) => item.id === id);
  const ready = obj ? await toolTreeOf(obj) : "That object is no longer on the plate.";
  if (serial !== probeSerial || state.stage !== "model") return;
  if (typeof ready !== "string" && panelJoin()) {
    scheduleProbe(0);
    return;
  }
  publishProbe({ phase: "done", ok: false, error: typeof ready === "string" ? ready : "That object is no longer on the plate." });
  // Surfaces with no closed solid leave the list.
  refreshJoinChoices();
}

/** The step of its tree that `obj` holds on the plate, as a join's tool, opening that tree first if Model never did. */
function toolTreeOf(obj: PlateObject): Promise<{ key: string; node: NodeId } | string> {
  const token = meshTokenOf(obj.bytes);
  const tree = treeFor(obj.id, obj.modelTree, token);
  const node = tree ? nodeWithMesh(tree, token) : null;
  if (tree && node != null) return Promise.resolve({ key: tree.key, node });
  let pending = toolOpens.get(obj.id);
  if (!pending) {
    pending = openToolTree(obj).finally(() => toolOpens.delete(obj.id));
    toolOpens.set(obj.id, pending);
  }
  return pending;
}

async function openToolTree(obj: PlateObject): Promise<{ key: string; node: NodeId } | string> {
  let source = rootSource(obj);
  if (!source) return `${obj.name} is a mesh, so it cannot be a tool.`;
  if ("copies" in source) {
    const step = await stepOfCopy(source);
    if (typeof step === "string") return step;
    source = step;
  }
  const started = await startTree(obj.id, obj.name, source.from, source.mesh);
  if (typeof started === "string") return started;
  return started.parsed.editable ? { key: started.key, node: ROOT } : `${obj.name} has surfaces but no closed solid, so it cannot be a tool.`;
}

/** Whether `obj` can be a join's tool: a solid, or a STEP or a copy that opens as one. Never a mesh, nor surfaces. */
function solidObject(obj: PlateObject): boolean {
  const token = meshTokenOf(obj.bytes);
  if (surfacesOnly.has(token)) return false;
  return treeFor(obj.id, obj.modelTree, token) != null || rootSource(obj) != null;
}

/**
 * The join the panel describes, in the open solid's own frame: the tool's step as the plate holds it, and its pose in
 * the solid's frame, worked out here, once, so moving either object later moves no cut already made. Null until a tool
 * is picked and has a tree.
 */
function panelJoin(): ModelOp | null {
  const id = joinPick();
  const obj = id ? livePlate().find((item) => item.id === id) : undefined;
  if (!open || !obj) return null;
  const token = meshTokenOf(obj.bytes);
  const tree = treeFor(obj.id, obj.modelTree, token);
  const node = tree ? nodeWithMesh(tree, token) : null;
  if (!tree || node == null) return null;
  const keepTool = document.querySelector<HTMLInputElement>("#modelKeepTool")?.checked ?? false;
  return joinOp(boolOp(), { object: obj.id, key: tree.key, node, name: obj.name }, objectPose(), modelPoseOf(obj), keepTool);
}

/** The readout says what the join will do, each time that changes: "Cut telo split from telo.stp; telo split leaves the plate." */
function sayJoin() {
  const id = joinPick();
  const tool = id ? state.plate.objects.find((item) => item.id === id)?.name : undefined;
  const target = open ? state.plate.objects.find((item) => item.id === open!.objectId)?.name : undefined;
  if (!tool || !target) {
    joinSaid = "";
    return;
  }
  const keep = document.querySelector<HTMLInputElement>("#modelKeepTool")?.checked ?? false;
  const what = { fuse: `Fuse ${tool} into ${target}`, cut: `Cut ${tool} from ${target}`, common: `Intersect ${target} with ${tool}` }[boolOp()];
  const said = `${what}; ${tool} ${keep ? "stays on" : "leaves"} the plate.`;
  if (said === joinSaid) return;
  joinSaid = said;
  readout(said);
}

/**
 * Send the newest check, unless one is still running: then it goes when that one answers, and a check made stale
 * meanwhile is never sent. Numbers typed field after field each asked the engine for a whole edit, one after another,
 * all but the last answered for nothing.
 */
function sendPending() {
  const send = pendingProbe;
  if (!send || probing) return;
  pendingProbe = null;
  // Left Model while it waited: nothing would show its answer.
  if (state.stage !== "model") return;
  probing = true;
  void send().finally(() => {
    probing = false;
    sendPending();
  });
}

async function sendProbe(serial: number, key: string, tree: string, node: NodeId, op: ModelOp) {
  // While it waited, the check before it may have answered these very numbers.
  const known = answers.get(key);
  if (known && !(shaped.has(key) && !previewOf(key))) {
    if (serial !== probeSerial || state.stage !== "model") return;
    publishProbe(known);
    setModelPreview(previewOf(key));
    return;
  }
  // --- A5. A step above a saved solid is not in the engine until that history is rebuilt. ---
  const fromSteps = op.kind === "fillet" || op.kind === "chamfer" ? op.edges.flatMap((edge) => (isEdgeStep(edge) ? [edge.fromNode] : [])) : [];
  if (fromSteps.length > 0) {
    const problem = await ensureEdgeHistory(tree, node, fromSteps);
    if (serial !== probeSerial || state.stage !== "model") return;
    if (problem) {
      setModelProbe({ phase: "done", ok: false, error: problem });
      setModelPreview(null);
      return;
    }
  }
  const body = await treeCall(tree, node, probeRequest(tree, node, op, state.stepTolerance));
  const view = probeFromBody(body);
  if (typeof body.ok === "boolean") remember(key, view);
  // The shape the check built, as Apply would commit it: the engine keeps what it meshed for it, so Apply meshes nothing again.
  const shape = body.ok === true && body.preview && typeof body.preview === "object" ? decodeSolid(body.preview as Body) : null;
  if (shape && typeof shape !== "string") {
    keepPreview(key, shape);
    shaped.add(key);
  }
  if (serial !== probeSerial || state.stage !== "model") return;
  publishProbe(view);
  setModelPreview(shape && typeof shape !== "string" ? shape : null);
}

/** A few checked shapes, by `probeKey`: going back to numbers just checked shows their shape at once. */
const previews = new Map<string, ParsedSolid>();
/** The answers that came with a shape, so one whose shape left `previews` is asked again rather than shown without it. */
const shaped = new Set<string>();
const PREVIEWS = 4;

/** A shape is meshed at a chord: kept by the answer's name and the chord it was asked at. */
function previewName(key: string): string {
  return `${key}@${state.stepTolerance}`;
}

function keepPreview(key: string, shape: ParsedSolid) {
  const name = previewName(key);
  previews.delete(name);
  previews.set(name, shape);
  while (previews.size > PREVIEWS) previews.delete(previews.keys().next().value!);
}

/** The shape kept for an answer, the newest kept now; null when none is. */
function previewOf(key: string): ParsedSolid | null {
  const shape = previews.get(previewName(key));
  if (shape) keepPreview(key, shape);
  return shape ?? null;
}

function remember(key: string, view: ProbeView) {
  if (answers.size >= 256) {
    answers.clear();
    shaped.clear();
  }
  answers.set(key, view);
}

/** What the open panel would build: an edited step's op while one is edited, else the open tool's. */
function panelOp(): ModelOp | null {
  return editing ? editOp(editing) : toolOp(openModelTool());
}

/** An edited step's op as its panel says it: a join keeps its tool and placement, a new solid's root stands as `rootSpec` puts it. */
function editOp(run: Editing): ModelOp | null {
  const tool = openModelTool();
  if (run.op.kind === "root") return tool === "create" ? { kind: "root", ...rootSpec(fieldPrimitive()) } : null;
  if (run.op.kind === "join") {
    const keepTool = document.querySelector<HTMLInputElement>("#modelKeepTool")?.checked ?? false;
    return tool === "boolean" ? { ...run.op, op: boolOp(), keepTool } : null;
  }
  return toolOp(tool);
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
      // --- A5. One step's edges, or the edges picked on the solid. ---
      if (edgeMode() === "step") {
        const id = edgeStepId();
        if (id == null || !edgeStepKnown()) return null;
        return { kind: tool, edges: [stepEdges(id, edgeFilterChoice())], size: num("#modelBlend") };
      }
      const edges = selectedEdges(picks);
      return edges.length === 0 ? null : { kind: tool, edges, size: num("#modelBlend") };
    }
    case "hole": {
      const { through, counterbore } = holeBoxes();
      return {
        kind: "hole",
        origin: planePoint(toolFrame(), origin),
        axis: drillAxis(),
        radius: num("#modelHoleR"),
        depth: num("#modelHoleD"),
        ...(through ? { through: true as const } : {}),
        ...(counterbore ? { counterboreRadius: num("#modelBoreR"), counterboreDepth: num("#modelBoreD") } : {}),
      };
    }
    // --- A2 shell ---
    case "shell":
      return shellOp(num("#modelShell"), shellClosed() ? [] : selectedFaces(picks));
    case "boolean":
      return joinOpen() ? panelJoin() : { kind: "boolean", op: boolOp(), ...planePrimitive(fieldPrimitive(), toolFrame()) };
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
  // While a step is edited the view shows its parent: the plate takes the step shown before the edit, by its plate
  // mesh when the plate held it, else from the recent solids.
  const held = at && tree && editing?.target === at.key ? editing.from : null;
  const solid = held == null || held === at?.solid.id ? at?.solid : recentSolid(at!.key, held, state.stepTolerance);
  const plan = tree ? visitStep(held == null ? tree : { ...tree, current: held }) : null;
  if (!at || !tree || !plan || !state.mesh || at.objectId !== state.plate.selectedId || parked === at.key) return;
  const node = tree.nodes.get(plan.to);
  const mesh = solid?.id === plan.to ? node?.mesh ?? meshOf(solid) : held != null ? node?.mesh : null;
  if (!node || !mesh) return;
  noteEdit();
  tree = withNode(tree, plan.from, { keep: liveKeep() });
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
  const down = pathTo(tree, plan.to).filter((id) => !above.has(id));
  // A piece a join on the way down took off the plate stays off: fused back into its part, it is no part of its own.
  const joined = new Set(down.flatMap((id) => {
    const op = tree!.nodes.get(id)?.op;
    return op?.kind === "join" && !op.keepTool ? [op.tool.key] : [];
  }));
  for (const id of down) {
    const key = tree.nodes.get(id)?.piece;
    const piece = key ? modelTrees.get(key) : undefined;
    const pieceMesh = piece?.nodes.get(piece.committed)?.mesh;
    if (key && pieceMesh && !joined.has(key) && !state.plate.objects.some((obj) => obj.modelTree === key)) placePiece(key, pieceMesh);
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
  // The kernel meshes faces apart; where two sample a shared curved edge at different points, the plate mesh would
  // have a crack the slicer guesses across ("The mesh has gaps on 2333 layers"). Those cracks are closed here.
  const positions = closeCracks(solid.positions);
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

type SavedRoot = { rootStep: { name: string; bytes: ArrayBuffer } } | { rootPrimitive: PrimitiveSpec } | { rootFeature: FeatureOp };

/** What a saved tree reopens from: its root STEP, a new solid's primitive, or a sketch feature. A piece's is its root's STEP, once written. */
function savedRootOf(tree: ModelTree): SavedRoot | null {
  if (tree.root.kind === "step") return { rootStep: { name: tree.root.name, bytes: tree.root.bytes } };
  if (tree.root.kind === "primitive") return { rootPrimitive: tree.root.solid };
  if (tree.root.kind === "feature") return { rootFeature: tree.root.op };
  const root = tree.nodes.get(ROOT)?.mesh;
  return root?.step ? { rootStep: { name: stepFileName(root.name), bytes: root.step } } : null;
}

type TreeToSave = SavedTree<{ name: string; bytes: ArrayBuffer }>;

/**
 * What `.lime` keeps of each plate object's tree, by object id: the tree Model would resume for the
 * object's mesh, when it has a step, a name, a piece a kept split names, a primitive root, or a
 * feature root (a new solid has no file to open again). A split piece's tree is kept from the STEP of its own root,
 * written here if Model has not, so it opens without the part it was cut from; `unsaved` names the
 * objects whose root the engine could not write. Trees of objects no longer on the plate are not
 * saved, except a tool's that a saved join names (`tools`), under the object id the join gives, and
 * a tree whose join's tool tree could not be saved is left out too. Run after `captureOpenSolid`.
 */
export async function historyToSave(): Promise<{ trees: Map<string, TreeToSave>; tools: { id: string; name: string; tree: TreeToSave }[]; unsaved: string[] }> {
  const held = new Map<string, { name: string; key: string; node: NodeId }>();
  for (const obj of state.plate.objects) {
    const token = meshTokenOf(obj.bytes);
    const tree = treeFor(obj.id, obj.modelTree, token);
    const node = tree ? nodeWithMesh(tree, token) : null;
    if (tree && node != null) held.set(obj.id, { name: obj.name, key: tree.key, node });
  }
  const treeOfKey = (key: string) => modelTrees.get(key)!;
  const heldKeys = new Set([...held.values()].map(({ key }) => key));
  // Every tree a held tree's joins take a tool from, at any depth, with the object and the name the first join gives it.
  const toolOf = new Map<string, { id: string; name: string }>();
  for (const queue = [...heldKeys]; queue.length > 0; ) {
    for (const node of modelTrees.get(queue.pop()!)?.nodes.values() ?? []) {
      if (node.op?.kind !== "join" || toolOf.has(node.op.tool.key)) continue;
      toolOf.set(node.op.tool.key, { id: node.op.tool.object, name: node.op.tool.name });
      queue.push(node.op.tool.key);
    }
  }
  const named = new Set([...heldKeys].flatMap((key) => [...treeOfKey(key).nodes.values()].flatMap((node) => (node.piece ? [node.piece] : []))));
  for (const key of toolOf.keys()) named.add(key);
  // A tool no plate object holds goes under the id its join names, or one of its own when a plate object has that id.
  const ids = new Set(state.plate.objects.map((obj) => obj.id));
  const off = new Map<string, { name: string; key: string; node: NodeId }>();
  for (const [key, tool] of toolOf) {
    if (heldKeys.has(key) || !modelTrees.has(key)) continue;
    let id = tool.id;
    for (let n = 2; ids.has(id); n += 1) id = `${tool.id}-${n}`;
    ids.add(id);
    off.set(id, { name: tool.name, key, node: treeOfKey(key).committed });
  }
  const all = new Map([...held, ...off]);
  const roots = new Map<string, SavedRoot>();
  const unsaved: string[] = [];
  for (const [id, { name, key }] of all) {
    // A root STEP written below can outlast the tree: a new file can replace the plate meanwhile.
    if (!modelTrees.has(key)) continue;
    const tree = treeOfKey(key);
    if (tree.nodes.size === 1 && !tree.nodes.get(ROOT)?.name && !named.has(key) && tree.root.kind !== "primitive" && tree.root.kind !== "feature") continue;
    const root = tree.nodes.get(ROOT)?.mesh;
    if (!savedRootOf(tree) && tree.root.kind === "piece" && root) await writeStep(root.token, key, ROOT);
    // An imported STEP root is saved as the engine's own solid of it, once, while the engine holds it: a reopen that
    // needs the root reads that in a fraction of the STEP's time. A root that is still a plate object's file stays, as
    // the file keeps those bytes once for both.
    const rootBytes = tree.root.kind === "step" ? tree.root.bytes : null;
    if (rootBytes && !isBrep(rootBytes) && engineHeld.get(key)?.has(ROOT) && !state.plate.objects.some((obj) => sameBytes(obj.bytes, rootBytes))) await brepRoot(key);
    const saved = modelTrees.has(key) ? savedRootOf(treeOfKey(key)) : null;
    if (saved) roots.set(id, saved);
    else unsaved.push(name);
  }
  const owner = new Map([...roots.keys()].map((id) => [all.get(id)!.key, id]));
  // A join whose tool's tree is not saved could not rebuild after a reopen: its tree stays out too, at any depth.
  for (let changed = true; changed; ) {
    changed = false;
    for (const id of roots.keys()) {
      const { name, key } = all.get(id)!;
      if (!modelTrees.has(key) || [...toolKeys(treeOfKey(key))].every((tool) => owner.has(tool))) continue;
      roots.delete(id);
      owner.delete(key);
      unsaved.push(name);
      changed = true;
    }
  }
  const trees = new Map<string, TreeToSave>();
  const tools: { id: string; name: string; tree: TreeToSave }[] = [];
  for (const [id, root] of roots) {
    const { name, key, node } = all.get(id)!;
    if (!modelTrees.has(key)) continue;
    // While a step is edited the view shows its parent; the file reopens on the step shown before the edit.
    const live = treeOfKey(key);
    const shown = editing?.target === key && live.nodes.has(editing.from) ? { ...live, current: editing.from } : live;
    const tree = { ...savedTree(shown, node, (other) => owner.get(other)), ...root };
    if (held.has(id)) trees.set(id, tree);
    else tools.push({ id, name, tree });
  }
  return { trees, tools, unsaved };
}

/**
 * A project opened: each saved tree joins its plate object under a fresh key, so a file opened
 * twice never meets its own trees in the engine. The engine hears of it when Model needs a step:
 * the plate's step then opens from the object's `brep`, as a STEP file does, and the rest of the
 * tree from its root STEP and ops once another step is asked for. The trees of tools that left the
 * plate (`tools`) are adopted too, each tree after the trees its joins take a tool from; the engine
 * still opens each when a call first needs it.
 */
export function adoptSavedTrees(saved: ReadonlyMap<string, SavedTree<{ name: string; bytes: ArrayBuffer }>>, tools: readonly { id: string; name: string }[] = []) {
  const keys = new Map([...saved.keys()].map((id) => [id, freshTreeKey(id)]));
  const toolNames = new Map(tools.map((tool) => [tool.id, tool.name]));
  for (const id of toolFirst(saved)) {
    const tree = saved.get(id)!;
    const key = keys.get(id)!;
    const obj = state.plate.objects.find((item) => item.id === id);
    const root: ModelRoot = tree.rootFeature
      ? { kind: "feature", op: tree.rootFeature }
      : tree.rootPrimitive
        ? { kind: "primitive", solid: tree.rootPrimitive }
        : { kind: "step", ...tree.rootStep };
    if (!obj) {
      // A tool that left the plate: its tree stays for the joins that name it, and opens whole when one is built.
      const name = toolNames.get(id);
      if (name !== undefined) modelTrees.set(key, loadedTree(tree, key, root, name, null, (other) => keys.get(other)));
      continue;
    }
    const token = meshTokenOf(obj.bytes);
    const mesh: PlateMesh = { name: obj.fileName, bytes: obj.bytes, sourcePos: obj.sourcePos, token, ...(obj.brep ? { step: obj.brep } : {}) };
    const loaded = loadedTree(tree, key, root, obj.name, mesh, (other) => keys.get(other));
    modelTrees.set(key, loaded);
    if (obj.brep || (loaded.committed === ROOT && isStepName(obj.fileName))) stepKnown.add(token);
    // The plate's step opens from its own solid, one read, whatever the root is: a history of hundreds of steps from a
    // primitive would otherwise run again in full before Model showed anything. Earlier steps rebuild when asked for.
    // A solid saved in the binary format is the step exactly, so the whole tree opens at once with it as the step's
    // solid (`openWhole`). An older file's STEP can sit apart from the step, so the step stands alone until an edit.
    if (obj.brep && loaded.committed !== ROOT && !isBrep(obj.brep)) seeds.set(key, { node: loaded.committed, held: new Set([loaded.committed]), live: false, whole: null, reading: null });
    else unopened.add(key);
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
  const gone = closeOrder(modelTrees, [...modelTrees.keys()].filter((key) => !keep.has(key)));
  for (const key of gone) {
    modelTrees.delete(key);
    seeds.delete(key);
    unopened.delete(key);
    seedNotes.delete(key);
    engineHeld.delete(key);
    forgetShown(key);
  }
  void closeInEngine(gone);
}

/** Closes in flight, one at a time, and those the engine refused because a join still named the tree. */
let closing: Promise<void> = Promise.resolve();
const refusedCloses = new Set<string>();

/**
 * The engine keeps a tree a join takes its tool from, so trees close one at a time, each before its tools, in one
 * queue for every release. A close the engine refused, because a tree closing in a later release named it, goes again
 * after each later batch.
 */
function closeInEngine(keys: readonly string[]): Promise<void> {
  closing = closing.then(async () => {
    for (const key of [...keys, ...refusedCloses]) {
      const body = await post({ call: "close", key });
      if (typeof body.error === "string" && body.error !== "unknown") refusedCloses.add(key);
      else refusedCloses.delete(key);
    }
  });
  return closing;
}

/** The solids and kernel answers kept for tree `key`. */
function forgetShown(key: string) {
  for (const name of solids.keys()) if (name.startsWith(`${key}#`)) solids.delete(name);
  for (const name of answers.keys()) if (name.startsWith(`${key}#`)) answers.delete(name);
  for (const name of previews.keys()) if (name.startsWith(`${key}#`)) previews.delete(name);
}

/** Leaving Model: the plate takes the shown node, the visit is one Prepare step, and its solid is written off the UI's path. */
export function leaveModel() {
  forgetPlaceSteps();
  forgetWorkplaneSteps();
  commitModel();
  dropEdit();
  endModelVisit();
  void writeSteps();
}

/** The file's plate is gone: so are its trees. */
export function forgetModelTrees() {
  void closeInEngine(closeOrder(modelTrees, modelTrees.keys()));
  plateEra += 1;
  modelTrees.clear();
  surfacesOnly.clear();
  toolOpens.clear();
  ghosted = null;
  joinSaid = "";
  seeds.clear();
  unopened.clear();
  seedNotes.clear();
  engineHeld.clear();
  solids.clear();
  answers.clear();
  previews.clear();
  shaped.clear();
  lens = null;
  setModelLocked(null);
  stepKnown.clear();
  writing.clear();
  dropEdit();
  editBack = null;
  open = null;
  shownFor = null;
  framedFor = null;
  // The edit history went with the old plate, so a move still under way is dropped, not kept as a step.
  window.clearTimeout(placeTimer);
  placeBefore = null;
  forgetPlaceSteps();
  window.clearTimeout(wpTimer);
  wpBefore = null;
  forgetWorkplaneSteps();
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
  dropEdit();
  editBack = null;
  lens = null;
  setModelLocked(null);
  const mine = ++ticket;
  picks = [];
  busy = false;
  jumping = false;
  parked = null;
  const objectId = state.plate.selectedId;
  if (objectId !== shownFor) {
    forgetPlaceSteps();
    forgetWorkplaneSteps();
  }
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
  const source = rootSource({ fileName: mesh.name, bytes: mesh.bytes, sourcePos: state.sourcePos ?? new Float32Array(0), ...(obj.brep ? { brep: obj.brep } : {}) });
  if (!source) {
    showEmpty(true);
    return;
  }
  if ("from" in source) {
    void openTree(mine, objectId, obj.name, source.from, source.mesh);
    return;
  }
  void (async () => {
    readout("Reading the solid…");
    const step = await stepOfCopy(source);
    if (typeof step === "string") {
      if (mine === ticket) readout(step);
      return;
    }
    if (mine !== ticket) return;
    void openTree(mine, objectId, obj.name, step.from, step.mesh);
  })();
}

type OpenFrom = { from: Exclude<ModelRoot, { kind: "piece" }>; mesh: PlateMesh };

/**
 * What a new tree for a plate mesh opens from: a copy of a new solid's root from the same primitive, even once that root
 * has a STEP; a STEP, the object's own or the file; or, for a copy of an edited object whose STEP is not written yet,
 * the step it copies, whose STEP `stepOfCopy` writes first. Null for a mesh, which Model does not edit.
 */
function rootSource(of: { fileName: string; bytes: ArrayBuffer; sourcePos: Float32Array; brep?: ArrayBuffer }): OpenFrom | { copies: { key: string; node: NodeId }; mesh: PlateMesh } | null {
  const token = meshTokenOf(of.bytes);
  const mesh: PlateMesh = { name: of.fileName, bytes: of.bytes, sourcePos: of.sourcePos, token, ...(of.brep ? { step: of.brep } : {}) };
  const source = [...modelTrees.values()].find((tree) => nodeWithMesh(tree, token) != null);
  if ((source?.root.kind === "primitive" || source?.root.kind === "feature") && nodeWithMesh(source, token) === ROOT) return { from: source.root, mesh };
  if (of.brep || isStepName(of.fileName)) return { from: { kind: "step", name: of.brep ? stepFileName(of.fileName) : of.fileName, bytes: of.brep ?? of.bytes }, mesh };
  return source ? { copies: { key: source.key, node: nodeWithMesh(source, token)! }, mesh } : null;
}

/** A copy's root: the solid of the step it copies, written now and given to every object with that mesh. */
async function stepOfCopy({ copies, mesh }: { copies: { key: string; node: NodeId }; mesh: PlateMesh }): Promise<OpenFrom | string> {
  const step = await exportSolid(copies.key, copies.node, "brep");
  if (typeof step === "string") return step;
  putStep(mesh.token, step);
  return { from: { kind: "step", name: stepFileName(mesh.name), bytes: step }, mesh: { ...mesh, step } };
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
  // A split piece whose part was edited past its split keeps a note of it: the piece is the older split's.
  const known = modelTrees.get(key);
  const older = known ? olderSplitNote(modelTrees, known) : null;
  const greeting = (solid: ParsedSolid) => `${about(solid)} ${older ? `${older} ` : ""}Pick a face or an edge.`;
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
  lens = null;
  setModelLocked(null);
  hideEmpty();
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

/** Open the file's solid, or a copied new solid's primitive, as the root of a new tree for the plate object, and show it. */
async function openTree(mine: number, objectId: string, label: string, from: Exclude<ModelRoot, { kind: "piece" }>, root: PlateMesh) {
  readout("Reading the solid…");
  const started = await startTree(objectId, label, from, root);
  if (typeof started === "string") {
    if (mine === ticket && state.stage === "model") readout(started);
    return;
  }
  keepSolid(started.key, ROOT, state.stepTolerance, started.parsed);
  if (mine !== ticket || state.stage !== "model") return;
  open = { objectId, key: started.key, solid: started.parsed };
  present(started.parsed, `${about(started.parsed)} Pick a face or an edge.`);
}

/**
 * A new tree for the plate object, rooted in `from`: the object then carries its key. A shown object and a join's tool
 * both start here. An open that lands after the plate was replaced leaves nothing behind.
 */
async function startTree(objectId: string, label: string, from: Exclude<ModelRoot, { kind: "piece" }>, root: PlateMesh): Promise<{ key: string; parsed: ParsedSolid } | string> {
  const key = freshTreeKey(objectId);
  const era = plateEra;
  const body = await post(openRequest(key, from, state.stepTolerance));
  const parsed = decodeSolid(body);
  if (typeof parsed === "string" || era !== plateEra) {
    // An open the engine answered but this app cannot read, or no longer wants, still left a tree there.
    if (typeof body.error !== "string") void post({ call: "close", key });
    return typeof parsed === "string" ? parsed : "This solid is no longer open.";
  }
  modelTrees.set(key, withNode(newTree(key, from, rootLabel(from, label), parsed.fingerprint), ROOT, { mesh: root }));
  noteHeld(key, body);
  if (from.kind === "step" || root.step) stepKnown.add(root.token);
  if (!parsed.editable) surfacesOnly.add(root.token);
  setTreeKey(objectId, key);
  return { key, parsed };
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
    readout(tree.nodes.get(ROOT)?.broken ? ROOT_BROKEN : BROKEN);
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
    const body = await treeCall(key, node, gotoRequest(key, node, chord));
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
  const note = seedNotes.get(key);
  seedNotes.delete(key);
  present(solid, note ? `${message(solid)} ${note}` : message(solid));
  return true;
}

/** Where Undo goes: from an edit's tip, back to the step shown before the edit; from the last step of a folded composite, to the step before it; else the parent. */
function undoNode(tree: ModelTree): NodeId | null {
  const back = editBack;
  if (back && !back.undone && back.key === tree.key && tree.current === back.tip && tree.nodes.has(back.back)) return back.back;
  return foldedUndoTarget(tree, modelTrees);
}

/** Where Redo goes: from where an undone edit went back to, forward to its tip again; through a folded composite, to its last step; else the child Redo follows. */
function redoNode(tree: ModelTree): NodeId | null {
  const back = editBack;
  if (back?.undone && back.key === tree.key && tree.current === back.back && tree.nodes.has(back.tip)) return back.tip;
  return foldedRedoTarget(tree, modelTrees);
}

/** Undo is the parent, Redo the child last applied or jumped through, but for an edit, which Undo takes back whole. */
async function step(way: "undo" | "redo") {
  const at = open;
  const tree = treeOf(at);
  const node = tree ? (way === "undo" ? undoNode(tree) : redoNode(tree)) : null;
  if (!at || !tree || node == null || busy || jumping || editing) return;
  parked = null;
  const back = editBack;
  const viaEdit = !!back && node === (way === "undo" ? back.back : back.tip) && tree.current === (way === "undo" ? back.tip : back.back) && back.undone === (way === "redo");
  if (!viaEdit) editBack = null;
  // --- A8. One undo from the last step of a folded composite, and one redo, take the whole run. ---
  const undone = !viaEdit && way === "undo" ? foldEndingAt(tree, tree.current, modelTrees) : null;
  const redone = !viaEdit && way === "redo" ? foldRedoFrom(tree, modelTrees) : null;
  const viaFold = (!!undone && node === undone.before) || (!!redone && node === redone.last);
  const foldLabel = undone?.label ?? redone?.label;
  const done = viaEdit ? (way === "undo" ? "Edit of the step undone." : "Edit of the step redone.") : viaFold && foldLabel ? `${foldLabel} ${way === "undo" ? "undone" : "redone"}.` : way === "undo" ? "Edit undone." : "Edit redone.";
  const shown = await showNode(ticket, at.objectId, at.key, node, (solid) => `${about(solid)} ${done}`);
  if (shown && viaEdit && editBack === back) back!.undone = way === "undo";
  if (shown) syncUndo();
}

/** A row of the History panel: show that step. A jump still on its way to another step gives way to this one. */
async function jumpTo(node: NodeId) {
  const at = open;
  const tree = treeOf(at);
  if (!at || !tree || busy || state.stage !== "model" || !tree.nodes.has(node)) return;
  if (jumping ? node === jumpTarget : node === tree.current && !editing && !lens) return;
  parked = null;
  editBack = null;
  // A step picked in the history ends an edit: the view goes there, not back.
  dropEdit();
  await showNode(ticket, at.objectId, at.key, node, about);
}

/** The open solid's own step a History row names, or null for a tool's step. */
function ownStep(row: RowKey): NodeId | null {
  const read = readRow(row);
  return read && read.via.length === 0 ? read.id : null;
}

/**
 * A tool's row in History: that step of the tool, read-only, where its joins put it, with the open solid grey behind it
 * as it was on screen. Nothing on the plate, in the open solid's history, or in the tool's own tree moves.
 */
async function peekTool(row: RowKey) {
  const at = open;
  const tree = treeOf(at);
  if (!at || !tree || busy || state.stage !== "model" || (lens?.row === row && !editing)) return;
  const step = rowStep(modelTrees, tree, row);
  if (!step) return;
  parked = null;
  editBack = null;
  dropEdit();
  const join = step.joins.at(-1)!;
  await showLens(ticket, row, step, (solid) => `“${stepLabel(step.tree.nodes.get(step.id)!)}” of ${join.op.tool.name}, as “${stepLabel(join.tree.nodes.get(join.id)!)}” takes it. ${about(solid)} Edit step changes it.`);
}

/** Show step `step.id` of a tool's tree in place of the open solid, from the recent solids or the engine. The newest jump wins. */
async function showLens(mine: number, row: RowKey, step: { tree: ModelTree; id: NodeId; joins: ToolLink[] }, message: (solid: ParsedSolid) => string): Promise<boolean> {
  const key = step.tree.key;
  // A jump still on its way gives way to this one, even when this one needs no engine call.
  const serial = ++jumpSerial;
  if (brokenOnPath(step.tree, step.id)) {
    readout(BROKEN);
    return false;
  }
  const chord = state.stepTolerance;
  let solid: ParsedSolid | null = recentSolid(key, step.id, chord) ?? null;
  const seed = seeds.get(key);
  if (solid && readSolids.has(solid) && !(seed?.live && !seed.whole)) solid = null;
  if (!solid) {
    jumping = true;
    jumpTarget = null;
    syncUndo();
    const body = await treeCall(key, step.id, gotoRequest(key, step.id, chord));
    const newest = mine === ticket && serial === jumpSerial;
    if (newest) jumping = false;
    syncUndo();
    if (mine !== ticket || state.stage !== "model") return false;
    const decoded = failed(key, body) ? null : decodeSolid(body);
    if (typeof decoded === "string") readout(decoded);
    if (!decoded || typeof decoded === "string") return false;
    if (body.seeded) readSolids.add(decoded);
    keepSolid(key, step.id, chord, decoded);
    if (!newest) return false;
    solid = decoded;
  }
  if (!open || state.stage !== "model") return false;
  jumping = false;
  present(solid, message(solid), { row, key, node: step.id, joins: step.joins, pose: toolPose(objectPose(), step.joins), solid });
  return true;
}

/** A row's step renamed: the open solid's, or a tool's, which is the same step in the tool object's own History. */
function renameStep(row: RowKey, name: string) {
  const tree = treeOf(open);
  const step = tree ? rowStep(modelTrees, tree, row) : null;
  const node = step?.tree.nodes.get(step.id);
  if (!step || !node || (node.name ?? "") === name) return;
  modelTrees.set(step.tree.key, withNode(step.tree, step.id, { name: name || undefined }));
  syncUndo();
}

/** Why the branch from a row's step stays, or null. A tool's step is on the way to the step its join takes, so it always stays. */
function whyKeepBranch(row: RowKey): string | null {
  const tree = treeOf(open);
  if (!tree) return "This solid is no longer open.";
  if (busy || jumping) return STILL_WORKING;
  const step = rowStep(modelTrees, tree, row);
  if (!step) return "This step is no longer in the history.";
  const join = step.joins[0];
  if (join) return `This step makes ${step.joins.at(-1)!.op.tool.name} as “${stepLabel(join.tree.nodes.get(join.id)!)}” takes it. Delete the branch from that step instead.`;
  // The step being edited (for a tool's step, the join on the way to it) and the step Cancel goes back to count as on screen.
  const run = editing?.target === tree.key ? editing : null;
  const gone = run ? subtree(tree, step.id) : null;
  if (gone && run && (gone.has(run.joins[0]?.id ?? run.node) || gone.has(run.from))) return "The step being edited, or the one Cancel goes back to, is on this branch. Update or cancel the edit first.";
  return dropRefusal(tree, step.id, modelTrees);
}

/** Delete the branch from a row's step down, here and in the engine. A refusal goes to the readout. */
function dropBranch(row: RowKey): boolean {
  const at = open;
  const tree = treeOf(at);
  const refusal = whyKeepBranch(row);
  const node = ownStep(row);
  const next = tree && !refusal && node != null ? dropped(tree, node) : null;
  if (!at || !tree || !next || node == null) {
    readout(refusal ?? "This branch cannot be deleted.");
    return false;
  }
  for (const id of subtree(tree, node)) {
    for (const name of solids.keys()) if (name.startsWith(`${nodeName(at.key, id)}@`)) solids.delete(name);
  }
  const looked = lens && !next.nodes.has(lens.joins[0]!.id);
  modelTrees.set(at.key, next);
  void dropInEngine(at.key, node);
  // The tool's step looked at went with its join: the part comes back.
  if (looked) present(at.solid, about(at.solid));
  syncUndo();
  readout(about(viewed() ?? at.solid));
  return true;
}

function brokenOnPath(tree: ModelTree, node: NodeId) {
  return pathTo(tree, node).some((id) => tree.nodes.get(id)?.broken);
}

/** A failure reply goes to the readout. A node that did not rebuild is marked, with everything under it. */
function failed(key: string, body: Body): boolean {
  const error = text(body.error);
  if (!error) return false;
  // --- A7 model check --- an apply that names where it failed draws those boxes.
  const where = locatedBoxes(body);
  if (where.length > 0) showLocated(where.map((box) => boxUnder(box, openPose())));
  const tree = modelTrees.get(key);
  // A tool tree the engine could not get back marks nothing: the step builds once that tree opens.
  if (typeof body.broken === "number" && tree && !missingToolOf(body)) {
    console.warn(error);
    modelTrees.set(key, withNode(tree, body.broken, { broken: error }));
    readout(body.broken === ROOT ? ROOT_BROKEN : BROKEN);
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

/** What Apply says while a fillet or a chamfer is built: one step's edges, or the edges that were picked. */
function blendWorking(kind: "fillet" | "chamfer", op: ModelOp): string {
  const verb = kind === "fillet" ? "Filleting" : "Chamfering";
  if (op.kind !== kind) return `${verb}…`;
  const step = storedEdgeStep(op.edges);
  if (step) {
    const which = step.filter === "all" ? "sharp" : step.filter;
    return `${verb} the ${which} edges of step ${step.fromNode}…`;
  }
  const count = op.edges.length === 1 ? "the edge" : `${op.edges.length} edges`;
  return `${verb} ${count}…`;
}

async function applyTool() {
  const button = document.querySelector<HTMLButtonElement>("#modelApply");
  const tool = modelTool();
  if (editing) {
    if (button && !button.disabled) await runEdit(editing);
    return;
  }
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
  const working: Partial<Record<ModelOp["kind"], string>> = {
    split: "Splitting the solid…",
    fillet: blendWorking("fillet", op),
    chamfer: blendWorking("chamfer", op),
    hole: "Cutting the hole…",
    shell: "Hollowing the solid…",
    scale: "Scaling the solid…",
  };
  await applyOp(op, working[op.kind] ?? "Editing the solid…");
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
  editBack = null;
  const parent = tree.current;
  const twin = childWithOp(tree, parent, op);
  if (twin != null) {
    // These numbers already built a step from here: show it rather than build it again.
    const shown = await showNode(ticket, at.objectId, at.key, twin, (solid) => appliedMessage(op, solid));
    if (shown) closeModelTool();
    if (shown && op.kind === "join" && !op.keepTool) takeOffPlate(op.tool.object);
    return;
  }
  // A new step placed by its numbers builds on the plate's STEP-read solid at once: rebuilding a long history first took
  // minutes (326 steps on the 2.6.1 back cover). A step that names edges or faces by the solid's numbering (a fillet, a
  // chamfer, a shell) still waits for the rebuilt step, since the read solid can number them apart and the step would
  // then build differently when the history is rebuilt.
  const onSeed = seeds.get(at.key)?.held.has(parent) === true && !NAMES_TOPOLOGY.has(op.kind);
  if (!onSeed && (seeds.has(at.key) || readSolids.has(at.solid))) {
    // A step the engine does not hold yet: the whole tree opens, and the step is shown as rebuilt.
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
    // Edge and face numbers of the read solid may not be the rebuilt one's. A blend that names a step's
    // edges finds them again, and a closed shell names no face, so both go on.
    if (((op.kind === "fillet" || op.kind === "chamfer") && op.edges.some((edge) => !isEdgeStep(edge))) || (op.kind === "shell" && (op.openFaces?.length ?? 0) > 0)) {
      const what = op.kind === "shell" ? "faces" : "edges";
      readout(`${about(open!.solid)} The step was rebuilt from its history: pick the ${what} again.`);
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
  const body = await treeCall(at.key, parent, applyRequest(at.key, parent, node, op, chord, pieceKey));
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
  remember(probeName(at.key, node, op), { phase: "applied" });
  // The tree that names the tool is in place first, so the tool's tree stays for it once the object leaves.
  if (stored.kind === "join" && !stored.keepTool) takeOffPlate(stored.tool.object);
  if (stored.kind === "join") resetKeepTool();
  // Apply ends the tool: no ghost, panel or handles stay behind. Undo takes the step back, and the tool opens again on these numbers.
  closeModelTool();
  present(parsed, appliedMessage(stored, parsed));
}

/** A join's tool leaves the plate, in the visit's one Prepare step, so Prepare undo puts it back with the edit. */
function takeOffPlate(id: string) {
  if (!state.plate.objects.some((obj) => obj.id === id)) return;
  noteEdit();
  syncPlateFromState();
  state.plate = withoutObject(state.plate, id);
  applySelectedToState(state.plate);
  place();
  flushEdit();
  markModelEdit();
}

/** What the plate loses when it takes a new step: the part's paint, and its placement scale after a scale. */
function leavingNotes(scaled: boolean): string {
  const paint = state.supportPaint.length + state.seamPaint.length + state.reinforcement.length + state.supportEdits.length > 0;
  return `${paint ? " Leaving Model clears this part's support paint." : ""}${scaled && state.partScale !== 1 ? " Placement scale becomes 100%." : ""}`;
}

function appliedMessage(op: ModelOp, solid: ParsedSolid) {
  const notes = leavingNotes(op.kind === "scale");
  const volume = about(solid);
  if (op.kind === "split") return `Split. ${volume} On the plate both pieces share one spot: Arrange lays them side by side.${notes}`;
  if (op.kind === "fillet") return `Fillet. ${volume}${notes}`;
  if (op.kind === "chamfer") return `Chamfer. ${volume}${notes}`;
  if (op.kind === "hole") return `Hole. ${volume}${notes}`;
  if (op.kind === "shell") return `Shell. ${volume}${notes}`;
  if (op.kind === "join") return `${opLabel(op)}. ${volume}${op.keepTool ? "" : ` ${op.tool.name} left the plate.`}${notes}`;
  return `${volume}${notes}`;
}

/**
 * Edit step `node`: its tool opens with the numbers it was applied with, on its parent's solid, which the view shows as
 * when the step was first applied, so the ghost, the handles and the dry-run are Apply's. A new solid's root edits in New
 * solid's panel, on the root. A tree from a project still on its STEP-read step opens whole first, as an Apply does.
 */
async function startEdit(row: RowKey) {
  const own = ownStep(row);
  if (own != null) await startOwnEdit(own);
  else await startToolEdit(row);
}

async function startOwnEdit(node: NodeId) {
  const at = open;
  const tree = treeOf(at);
  if (!at || !tree || state.stage !== "model") return;
  if (tree.root.kind === "feature" && tree.nodes.get(node)?.parent === null) {
    readout(FEATURE_ROOT_EDIT);
    return;
  }
  const refusal = editRefusal(tree, node) ?? (busy || jumping ? STILL_WORKING : !at.solid.editable ? VIEW_ONLY : null);
  const op = editedOp(tree, node);
  if (refusal || !op) {
    readout(refusal ?? "This step cannot be edited.");
    return;
  }
  const from = editFrom(at, tree);
  const parent = tree.nodes.get(node)?.parent ?? ROOT;
  const mine = ticket;
  if (seeds.has(at.key) && !(await wholeFirst(mine, [{ key: at.key, node: parent }]))) return;
  const latest = modelTrees.get(at.key);
  if (!latest?.nodes.has(node)) return;
  const run: Editing = { key: at.key, target: at.key, row: rowKey([], node), joins: [], node, parent, from, replay: replayChain(latest, node, from), op, panel: null, opened: null };
  editing = run;
  syncUndo();
  const shown = await showNode(mine, at.objectId, at.key, parent, about);
  const now = open;
  if (editing !== run) return;
  if (!shown || !now || now.key !== run.key || now.solid.id !== parent) {
    editing = null;
    syncUndo();
    return;
  }
  openEditPanel(run, editHead(latest, node));
}

/**
 * Edit a tool's step from the open solid's History: its tool opens with the step's numbers, on the step's parent in the
 * tool's tree, shown where the joins put the tool, so the ghost, the handles and the dry-run are what its Apply had.
 * Trees from a project still on their STEP-read step open whole first, the open solid's and each tool's on the way.
 */
async function startToolEdit(row: RowKey) {
  const at = open;
  const tree = treeOf(at);
  if (!at || !tree || state.stage !== "model") return;
  const step = rowStep(modelTrees, tree, row);
  if (step && step.tree.root.kind === "feature" && step.tree.nodes.get(step.id)?.parent === null) {
    readout(FEATURE_ROOT_EDIT);
    return;
  }
  const refusal = !step ? "This step is no longer in the history." : toolEditRefusal(step.tree, step.joins, step.id) ?? (busy || jumping ? STILL_WORKING : !at.solid.editable ? VIEW_ONLY : null);
  const op = step ? editedOp(step.tree, step.id) : null;
  if (refusal || !step || !op) {
    readout(refusal ?? "This step cannot be edited.");
    return;
  }
  const from = editFrom(at, tree);
  const parent = step.tree.nodes.get(step.id)?.parent ?? ROOT;
  const mine = ticket;
  const parentOf = (link: { tree: ModelTree; id: NodeId }) => link.tree.nodes.get(link.id)?.parent ?? ROOT;
  const chain = [...step.joins.map((link) => ({ key: link.tree.key, node: parentOf(link) })), { key: step.tree.key, node: parent }];
  if (chain.some((link) => seeds.has(link.key)) && !(await wholeFirst(mine, chain.filter((link) => seeds.has(link.key))))) return;
  const latest = treeOf(open);
  const fresh = latest && open?.key === at.key ? rowStep(modelTrees, latest, row) : null;
  if (!latest || !fresh || fresh.joins.length === 0) return;
  const run: Editing = { key: fresh.tree.key, target: at.key, row, joins: fresh.joins, node: step.id, parent, from, replay: replayChain(latest, fresh.joins[0]!.id, from), op, panel: null, opened: null };
  editing = run;
  syncUndo();
  const shown = await showLens(mine, rowKey(readRow(row)!.via, parent), { tree: fresh.tree, id: parent, joins: fresh.joins }, (solid) => about(solid));
  if (editing !== run) return;
  if (!shown || lens?.key !== run.key || lens.node !== parent) {
    editing = null;
    syncUndo();
    return;
  }
  openEditPanel(run, toolEditHead(fresh.tree, step.id, fresh.joins.at(-1)!.op.tool.name));
}

/**
 * Where Cancel goes back to: the step shown now, or for a second edit where the first one started. It stays among the
 * recent solids, so Cancel goes back without the engine, even mid-rebuild. Any open tool closes first.
 */
function editFrom(at: Opened, tree: ModelTree): NodeId {
  const from = editing?.target === at.key ? editing.from : tree.current;
  editing = null;
  if (openModelTool()) closeModelTool();
  parked = null;
  if (at.solid.id === from) keepSolid(at.key, from, state.stepTolerance, at.solid);
  return from;
}

/** Each tree in `chain` that sits on its STEP-read step opens whole, as before an Apply. False when the edit cannot go on. */
async function wholeFirst(mine: number, chain: readonly { key: string; node: NodeId }[]): Promise<boolean> {
  busy = true;
  syncUndo();
  readout("Rebuilding the steps…");
  let problem: string | null = null;
  for (const link of chain) {
    problem = await openWhole(link.key, link.node);
    if (problem) break;
  }
  if (mine === ticket) busy = false;
  syncUndo();
  if (mine !== ticket || state.stage !== "model") return false;
  if (problem) readout(problem);
  return !problem;
}

/** The edited step's tool opens on the solid on screen, its numbers taken into model space at that solid's pose. */
function openEditPanel(run: Editing, head: string) {
  const solid = viewed()!;
  const box = openBox();
  const center: Vec3 = box ? [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2] : [0, 0, 0];
  const panel = editPanel(run.op, openPose(), center);
  run.panel = panel;
  openEditTool(panel, head);
  let said = `${about(solid)} Change the numbers, then Update.`;
  // --- A5. A step's edges open on that step. The line names the row once the panel has filled it. ---
  if (panel.step) {
    const node = modelTrees.get(run.key)?.nodes.get(panel.step.fromNode);
    const row = node ? stepLabel(node) : `step ${panel.step.fromNode}`;
    said = `${about(solid)} ${edgeOfText(row, panel.step.filter)} Change the numbers, then Update.`;
    picks = [];
  } else if (panel.edges && panel.edges.length > 0) {
    const { picked, missing } = matchEdges(solid.edges, panel.edges, state.stepTolerance);
    picks = picked.map((index) => ({ kind: "edge", index }));
    fx.model?.highlight(picks);
    if (missing > 0) said = `${about(solid)} ${missing === panel.edges.length ? "This step's edges are" : `${missing} of this step's edges are`} not on this solid any more: pick them again.`;
  }
  // --- A2 shell: stored face refs are picked again before the opened snapshot, so Update stays off. ---
  if (panel.faces) {
    if (panel.shellClosed || panel.faces.length === 0) {
      picks = [];
      fx.model?.highlight([]);
    } else {
      const { picked, missing } = matchFaces(faceRows(solid), panel.faces, state.stepTolerance);
      picks = picked.map((index) => ({ kind: "face", index }));
      fx.model?.highlight(picks);
      if (missing > 0) said = `${about(solid)} ${missing === panel.faces.length ? "This step's faces are" : `${missing} of this step's faces are`} not on this solid any more: pick them again.`;
    }
  }
  run.opened = JSON.stringify(editOp(run));
  syncModelChrome(picks);
  readout(said);
}

/** The edit's panel closed without Update: the view goes back to the step shown before it. An Update on its way is dropped when it lands. */
function cancelEdit() {
  const run = editing;
  editing = null;
  if (!run) return;
  picks = [];
  fx.model?.highlight([]);
  syncUndo();
  const at = open;
  const tree = treeOf(at);
  if (!at || at.key !== run.target) return;
  // A tool's step was on screen: the open solid's own step comes back, which never left.
  if (lens && at.solid.id === run.from) {
    present(at.solid, about(at.solid));
    return;
  }
  if (!tree?.nodes.has(run.from)) {
    if (lens) present(at.solid, about(at.solid));
    return;
  }
  if (at.solid.id === run.from) {
    readout(about(at.solid));
    return;
  }
  void showNode(ticket, at.objectId, at.key, run.from, about);
}

/** The edit ends where the view is: another step was picked, another object opened, Model closed, or the plate went. */
function dropEdit() {
  editing = null;
  if (editedPanel()) closeModelTool();
}

/**
 * Update: the edited op as a new sibling of the step, and the steps under it replayed on it, in one engine call. The view
 * goes to the last step that built; a step that no longer builds is kept, broken, with the steps after it, and the
 * readout names it. Nothing on the old branch changes, and the plate takes the new tip when it commits, as after any
 * Apply. Cancel while the engine rebuilds takes the view back at once, and what the engine built is dropped when it lands.
 */
async function runEdit(run: Editing) {
  const at = open;
  const tree = treeOf(at);
  if (!at || !tree || at.key !== run.target || busy || jumping || !state.mesh) return;
  if (at.objectId !== state.plate.selectedId) {
    followSelection();
    return;
  }
  const op = editOp(run);
  if (!op) {
    if (run.op.kind === "fillet" || run.op.kind === "chamfer") readout(run.op.kind === "fillet" ? "Pick an edge to fillet." : "Pick an edge to chamfer.");
    if (run.op.kind === "split") readout(splitNote(splitState()).text);
    return;
  }
  if (op.kind === "split" && splitNote(splitState()).bad) {
    readout(splitNote(splitState()).text);
    return;
  }
  if (run.joins.length > 0) {
    await runToolEdit(run, op);
    return;
  }
  const olds = [run.node, ...run.replay].map((id) => tree.nodes.get(id));
  if (olds.some((old) => !old)) {
    readout("This step is no longer in the history.");
    return;
  }
  const replayOps = run.replay.map((id) => tree.nodes.get(id)!.op!);
  const twin = builtBranch(tree, run.parent, op, replayOps);
  if (twin != null) {
    // These numbers already built this branch, in an earlier edit: show it rather than build it again.
    editing = null;
    closeModelTool();
    const shown = await showNode(ticket, at.objectId, at.key, twin, (solid) => `These numbers built this branch before. ${about(solid)}`);
    if (!shown) return;
    editBack = { key: at.key, tip: twin, back: run.from, undone: false };
    syncUndo();
    if (op.kind === "join" && !op.keepTool) takeOffPlate(op.tool.object);
    return;
  }
  let reserved = tree;
  const ids: NodeId[] = [];
  while (ids.length < olds.length) {
    const [next, id] = reserveId(reserved);
    reserved = next;
    ids.push(id);
  }
  modelTrees.set(at.key, reserved);
  // A blend that takes edges from a replayed step takes them from that step's new id.
  const renamed = stepIds([run.node, ...run.replay], ids);
  const replay = replayOps.map((step, i) => ({ id: ids[i + 1]!, op: renumberedSteps(step, renamed) }));
  const chord = state.stepTolerance;
  const mine = ticket;
  busy = true;
  syncUndo();
  readout(ids.length === 1 ? "Rebuilding the step…" : `Rebuilding ${ids.length} steps…`);
  const body = await treeCall(at.key, run.parent, editRequest(at.key, run.parent, ids[0]!, op, replay, chord));
  if (mine === ticket) busy = false;
  syncUndo();
  const latest = modelTrees.get(at.key);
  if (editing !== run || mine !== ticket || state.stage !== "model" || !latest) {
    // Cancelled while the engine rebuilt: the branch it built for this edit goes.
    if (typeof body.error !== "string") void dropInEngine(at.key, ids[0]!);
    return;
  }
  if (failed(at.key, body)) return;
  const parsed = decodeSolid(body);
  const built = builtSteps(body.built);
  if (typeof parsed === "string" || !built?.has(parsed.id)) {
    void dropInEngine(at.key, ids[0]!);
    readout(typeof parsed === "string" ? parsed : DAMAGED);
    return;
  }
  const broken = brokenStep(body.broken);
  const steps = forkSteps(latest, { key: at.key, parent: run.parent, node: ids[0]!, op, replay, old: [run.node, ...run.replay] }, built, broken);
  const next = forked(latest, run.parent, steps, parsed.id);
  modelTrees.set(at.key, next);
  keepSolid(at.key, parsed.id, chord, parsed);
  open = { ...at, solid: parsed };
  editing = null;
  editBack = { key: at.key, tip: parsed.id, back: run.from, undone: false };
  closeModelTool();
  if (op.kind === "join" && !op.keepTool) takeOffPlate(op.tool.object);
  const label = (id: NodeId) => stepLabel(next.nodes.get(id)!);
  const rebuilt = built.size - 1;
  const after = rebuilt === 0 ? "" : rebuilt === 1 ? " and rebuilt the step after it" : ` and rebuilt ${rebuilt} steps after it`;
  const failure = broken ? ` Step ${pathTo(next, broken.id).length - 1}, “${label(broken.id)}”, could not be rebuilt: ${sentence(broken.error)} The view shows the last step that built. Edit that step or delete its branch.` : "";
  const notes = editNotes(modelTrees, latest, [run.node, ...run.replay], (key) => state.plate.objects.find((obj) => obj.modelTree === key)?.name ?? null);
  const plate = leavingNotes([op, ...replayOps].some((step) => step.kind === "scale"));
  present(parsed, [`Updated “${label(ids[0]!)}”${after}. ${about(parsed)}${failure}${plate}`, ...notes].join(" "));
}

/** An edit's `built`: each step the engine kept with its solid, by id, with its op as stored and its fingerprint. Null when damaged. */
function builtSteps(value: unknown): Map<NodeId, { op: ModelOp; fingerprint: Fingerprint | null }> | null {
  if (!Array.isArray(value)) return null;
  const out = new Map<NodeId, { op: ModelOp; fingerprint: Fingerprint | null }>();
  for (const step of value as { id?: unknown; op?: unknown; fingerprint?: unknown }[]) {
    if (!step || typeof step.id !== "number" || !isOp(step.op)) return null;
    out.set(step.id, { op: step.op, fingerprint: readFingerprint(step.fingerprint) });
  }
  return out;
}

/** The step an edit's replay stopped at, and the engine's reason. */
function brokenStep(value: unknown): { id: NodeId; error: string } | null {
  const row = value as { id?: unknown; error?: unknown } | null | undefined;
  return row && typeof row.id === "number" && typeof row.error === "string" ? { id: row.id, error: row.error } : null;
}

type Built = Map<NodeId, { op: ModelOp; fingerprint: Fingerprint | null }>;

/** One tree's new branch as the engine kept it: each step's op as stored, its fingerprint, the name of the step it stands for, and the broken one. */
function forkSteps(tree: ModelTree, level: EditLevel, built: Built, broken: { id: NodeId; error: string } | null): ForkStep[] {
  const ids = [level.node, ...level.replay.map((step) => step.id)];
  return ids.map((id, i) => {
    const old = tree.nodes.get(level.old[i]!);
    const made = built.get(id);
    return {
      id,
      op: made?.op ?? (i === 0 ? level.op : level.replay[i - 1]!.op),
      fingerprint: made?.fingerprint ?? null,
      ...(old?.name ? { name: old.name } : {}),
      ...(broken?.id === id ? { broken: broken.error } : {}),
    };
  });
}

/** An edit's `tools`: each tool tree's part, deepest first, as `count` levels. Null when damaged. */
function toolParts(value: unknown, count: number): { built: Built; broken: { id: NodeId; error: string } | null }[] | null {
  if (count === 0) return [];
  if (!Array.isArray(value) || value.length !== count) return null;
  const parts = (value as { built?: unknown; broken?: unknown }[]).map((part) => ({ built: builtSteps(part?.built), broken: brokenStep(part?.broken) }));
  return parts.every((part) => part.built) ? (parts as { built: Built; broken: { id: NodeId; error: string } | null }[]) : null;
}

/** What an edit across trees built goes, in the engine: the open tree's branch first, since its join names the tool's. */
async function dropLevels(levels: readonly EditLevel[]) {
  for (const level of [...levels].reverse()) await dropInEngine(level.key, level.node);
}

/**
 * Update of a tool's step, edited from the open solid's History: one `edit` call under one engine lock. The tool's tree
 * forks at the step and replays down to the step the join takes, each join above is built again on the new tool step,
 * and the open solid's steps after its join replay, as an edit of its own step does. The old branches stay in every
 * tree. The tool object, on the plate or not, keeps its own plate step: only this part's join takes the edit. When the
 * edited step, or a join on a tool that built, does not build, nothing is kept and the readout says why; a tool step that
 * no longer builds is kept broken, with the join it fed.
 */
async function runToolEdit(run: Editing, op: ModelOp) {
  const at = open!;
  const tree = treeOf(at)!;
  const step = rowStep(modelTrees, tree, run.row);
  if (!step || step.tree.key !== run.key || step.joins.length !== run.joins.length || run.replay.some((id) => !tree.nodes.has(id))) {
    readout("This step is no longer in the history.");
    return;
  }
  const plan = crossPlan(step.tree, step.joins, run.node, op, run.replay);
  if ("twin" in plan) {
    // These numbers already built these branches, in an earlier edit: show the open solid's rather than build them again.
    editing = null;
    closeModelTool();
    const shown = await showNode(ticket, at.objectId, at.key, plan.twin, (solid) => `These numbers built this branch before. ${about(solid)}`);
    if (!shown) return;
    editBack = { key: at.key, tip: plan.twin, back: run.from, undone: false };
    syncUndo();
    return;
  }
  const { from, reused } = plan;
  const levels = crossEdit(from.tool, from.joins, from.node, from.op, run.replay, (key, count) => {
    let reserved = modelTrees.get(key)!;
    const ids: NodeId[] = [];
    while (ids.length < count) {
      const [next, id] = reserveId(reserved);
      reserved = next;
      ids.push(id);
    }
    modelTrees.set(key, reserved);
    return ids;
  });
  const own = levels.at(-1)!;
  const total = levels.reduce((sum, level) => sum + 1 + level.replay.length, 0);
  const chord = state.stepTolerance;
  const mine = ticket;
  busy = true;
  syncUndo();
  readout(`Rebuilding ${total} steps…`);
  const body = await treeCall(at.key, own.parent, crossEditRequest(levels, chord));
  if (mine === ticket) busy = false;
  syncUndo();
  const latest = modelTrees.get(at.key);
  if (editing !== run || mine !== ticket || state.stage !== "model" || !latest) {
    // Cancelled while the engine rebuilt: the branches it built for this edit go.
    if (typeof body.error !== "string") void dropLevels(levels);
    return;
  }
  if (failed(at.key, body)) return;
  const parsed = decodeSolid(body);
  const built = builtSteps(body.built);
  const broken = brokenStep(body.broken);
  const tools = toolParts(body.tools, levels.length - 1);
  // With the tool's step broken, the join it fed is too, and the open solid shows the join's parent.
  const landed = typeof parsed !== "string" && !!built && (built.has(parsed.id) || (parsed.id === own.parent && broken?.id === own.node));
  if (typeof parsed === "string" || !built || !tools || !landed) {
    void dropLevels(levels);
    readout(typeof parsed === "string" ? parsed : DAMAGED);
    return;
  }
  levels.forEach((level, i) => {
    const before = modelTrees.get(level.key)!;
    if (level === own) {
      modelTrees.set(level.key, forked(before, level.parent, forkSteps(before, level, built, broken), parsed.id));
      return;
    }
    // The tool's own tree keeps its shown step, plate step, and where its Redo goes.
    modelTrees.set(level.key, forked(before, level.parent, forkSteps(before, level, tools[i]!.built, tools[i]!.broken), before.current, false));
  });
  keepSolid(at.key, parsed.id, chord, parsed);
  open = { ...at, solid: parsed };
  editing = null;
  editBack = { key: at.key, tip: parsed.id, back: run.from, undone: false };
  closeModelTool();
  // Each built tool level's name, deepest first: the name the join above it gives it.
  const nameOf = (i: number) => from.joins[from.joins.length - 1 - i]!.op.tool.name;
  const label = (key: string, id: NodeId) => stepLabel(modelTrees.get(key)!.nodes.get(id)!);
  const rebuilt = built.size + tools.reduce((sum, part) => sum + part.built.size, 0) - (reused == null ? 1 : 0);
  const after = rebuilt === 0 ? "" : rebuilt === 1 ? " and rebuilt the step after it" : ` and rebuilt ${rebuilt} steps after it`;
  const deepest = tools.findIndex((part) => part.broken);
  const where = (key: string, id: NodeId) => pathTo(modelTrees.get(key)!, id).length - 1;
  const failure = deepest >= 0
    ? ` Step ${where(levels[deepest]!.key, tools[deepest]!.broken!.id)} of ${nameOf(deepest)}, “${label(levels[deepest]!.key, tools[deepest]!.broken!.id)}”, could not be rebuilt: ${sentence(tools[deepest]!.broken!.error)} The view shows the last step of this part that built. Edit that step or delete its branch.`
    : broken
      ? ` Step ${where(at.key, broken.id)}, “${label(at.key, broken.id)}”, could not be rebuilt: ${sentence(broken.error)} The view shows the last step that built. Edit that step or delete its branch.`
      : "";
  const kept = levels.slice(0, -1).flatMap((level) => {
    const obj = state.plate.objects.find((item) => item.modelTree === level.key);
    return obj ? [`${obj.name} on the plate keeps its own steps; only this part's join takes the edit.`] : [];
  });
  const notes = editNotes(modelTrees, latest, own.old, (key) => state.plate.objects.find((obj) => obj.modelTree === key)?.name ?? null);
  const plate = leavingNotes([op, ...own.replay.map((replayed) => replayed.op)].some((made) => made.kind === "scale"));
  present(parsed, [`Updated “${label(step.tree.key, reused ?? levels[0]!.node)}” of ${step.joins.at(-1)!.op.tool.name}${after}. ${about(parsed)}${failure}${plate}`, ...kept, ...notes].join(" "));
}

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** A join being edited: its tool where the join placed it, from the tool step's plate mesh, on the plate or not. */
function editJoinGhost(): ContextPart | null {
  const op = editing?.op;
  if (op?.kind !== "join") return null;
  const mesh = modelTrees.get(op.tool.key)?.nodes.get(op.tool.node)?.mesh;
  if (!mesh) return null;
  return { id: op.tool.object, positions: mesh.sourcePos, matrix: thenPose(thenPose(seatLift(meshSeat(mesh.bytes) ?? 0), op.relative), openPose()) };
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
  const from: ModelRoot = { kind: "primitive", solid: root };
  await finishNewSolid({
    request: (key, chord) => newSolidRequest(key, typed, chord),
    name: (names) => primitiveName(names, typed.primitive),
    root: from,
    // The primitive's box, from its numbers, as before the mesh is read.
    bounds: () => primitiveBounds(root),
  });
}

/**
 * A new plate object whose root is an extrude, a revolve, or a loft, with no primitive under it (K2). The sketch
 * editor (F1) calls this for "New object". Cut and intersect are refused: the feature is the solid.
 */
export async function createFeatureSolid(op: FeatureOp) {
  if (busy || jumping || state.stage !== "model") return;
  if (op.op !== "fuse") {
    const noun = op.kind === "extrude" ? "extrude" : op.kind === "revolve" ? "revolve" : "loft";
    readout(`A new solid is the ${noun} itself. Cut and intersect need a part that is already there.`);
    return;
  }
  const from: ModelRoot = { kind: "feature", op };
  await finishNewSolid({
    request: (key, chord) => openRequest(key, from, chord),
    name: (names) => featureObjectName(names, op.kind),
    root: from,
    bounds: (positions) => boundsOf(positions),
  });
}

/** A new plate object from an `open` that is its own root: a primitive, or a sketch feature. */
async function finishNewSolid(made: {
  request: (key: string, chord: number) => ReturnType<typeof newSolidRequest>;
  name: (names: Iterable<string>) => string;
  root: Exclude<ModelRoot, { kind: "piece" }>;
  bounds: (positions: Float32Array) => Bounds;
}) {
  const id = freshPlateId();
  const key = freshTreeKey(id);
  const chord = state.stepTolerance;
  const mine = ticket;
  busy = true;
  syncUndo();
  readout("Building the solid…");
  const body = await post(made.request(key, chord));
  if (mine === ticket) busy = false;
  syncUndo();
  const parsed = decodeSolid(body);
  if (mine !== ticket || state.stage !== "model" || typeof parsed === "string") {
    // An open the engine answered left a tree there.
    if (typeof body.error !== "string") void post({ call: "close", key });
    if (mine === ticket && state.stage === "model" && typeof parsed === "string") readout(parsed);
    return;
  }
  // The open object's edits reach the plate first. The new object then joins the visit's Prepare step, as an edit does.
  const others = plateBoxes();
  commitModel();
  forgetPlaceSteps();
  forgetWorkplaneSteps();
  flushEdit();
  noteEdit();
  syncPlateFromState();
  const first = state.plate.objects.length === 0;
  const name = made.name(state.plate.objects.map((obj) => obj.name));
  const positions = new Float32Array(parsed.positions);
  const seat = settleBy(positions);
  const fileName = `${name}.stl`;
  const bytes = encodeStl(positions, fileName);
  setMeshSeat(bytes, seat);
  const mesh: PlateMesh = { name: fileName, bytes, sourcePos: positions, token: meshTokenOf(bytes) };
  const pose = newSolidPose(others, made.bounds(positions));
  const { bedX, bedY } = state.profile;
  state.plate = addedSolid(state.plate, { name, fileName, bytes, sourcePos: positions, stepTolerance: chord }, id, key, pose, bedX, bedY);
  applySelectedToState(state.plate);
  modelTrees.set(key, withNode(newTree(key, made.root, rootLabel(made.root, name), parsed.fingerprint), ROOT, { mesh }));
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

/** Where New solid puts `spec` in model space: its root, standing at the origin or beside every object in `others`. */
function newSolidAt(spec: PrimitiveSpec, others = plateBoxes()): PrimitiveSpec {
  const root = rootSpec(spec);
  if (editing?.op.kind === "root") {
    // An edited root stands where the part's root stands: in its own frame, at the part's pose.
    const { kind: _kind, op: _op, ...placed } = fromSolidOp({ kind: "boolean", op: "fuse", ...root }, openPose()) as Extract<ModelOp, { kind: "boolean" }>;
    return placed;
  }
  const { t } = newSolidPose(others, primitiveBounds(root));
  return { ...root, origin: [root.origin[0] + t[0], root.origin[1] + t[1], root.origin[2] + t[2]] };
}

/**
 * Every plate object's box in model space, the open one as the view shows it: an edit not yet on the plate can
 * have grown it. Each mesh's own box is read once.
 */
function plateBoxes(): Bounds[] {
  const shown = openBox();
  return livePlate().map((obj) => (shown && obj.id === open?.objectId ? shown : boxUnder(boxOf(obj.sourcePos), meshToModel(obj))));
}

/** No solid to show: the view says so plainly, with New solid at hand, and shows whatever model space holds. */
function showEmpty(mesh: boolean) {
  readout("");
  const card = document.querySelector<HTMLElement>("#modelEmpty");
  const title = document.querySelector("#modelEmptyTitle");
  const text = document.querySelector("#modelEmptyText");
  if (title) title.textContent = mesh ? "This object is a mesh" : "No solid open";
  if (text) text.textContent = mesh ? "Model edits STEP solids. Start a new solid from a primitive, or add a STEP file." : "Start a solid from a primitive, or open a STEP file.";
  const fileButton = document.querySelector("#modelEmptyOpen");
  if (fileButton) fileButton.textContent = state.plate.objects.length > 0 ? "Add a file" : "Open a file";
  if (card) card.hidden = false;
  framedFor = null;
  const boxes = plateBoxes();
  if (boxes.length > 0) fx.model?.frame(unionBox(boxes)!);
  // --- A7 model check ---
  if (checkQueued) openQueuedCheck();
  else if (openModelTool() === "check") refreshModelCheck();
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
  const step = await exportSolid(at.key, node, "step");
  if (mine === ticket) busy = false;
  syncUndo();
  if (mine !== ticket || state.stage !== "model" || !open) return;
  if (typeof step === "string") {
    readout(step);
    return;
  }
  await saveStepFile(step, stepFileName(state.mesh.name));
  readout(`Saved STEP. ${about(at.solid)}`);
}

/**
 * Write the solid (`brep`) of each plate object's step that has none yet, and give it to every plate object
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

/** The solid of the node whose plate mesh is `token`, given wherever that mesh is. One export per token at a time. */
function writeStep(token: string, key: string, node: NodeId): Promise<ArrayBuffer | string> {
  let pending = writing.get(token);
  if (!pending) {
    pending = exportSolid(key, node, "brep").then((step) => {
      writing.delete(token);
      if (typeof step !== "string") putStep(token, step);
      return step;
    });
    writing.set(token, pending);
  }
  return pending;
}

/** The same bytes, in one buffer or two: a reopened file gives a root and a mesh with the same bytes buffers of their own. */
function sameBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
  return a === b || (a.byteLength === b.byteLength && meshKeyHex(new Uint8Array(a)) === meshKeyHex(new Uint8Array(b)));
}

/** Tree `key`'s STEP root, replaced by the engine's binary solid of it. Left as it is when the engine cannot write it. */
async function brepRoot(key: string) {
  const solid = await exportSolid(key, ROOT, "brep");
  const tree = modelTrees.get(key);
  if (typeof solid === "string" || !isBrep(solid) || tree?.root.kind !== "step") return;
  modelTrees.set(key, { ...tree, root: { ...tree.root, bytes: solid } });
}

/** The node's solid as `format`: `brep`, which the plate object keeps and a project saves, or `step` for the STEP button. */
async function exportSolid(key: string, node: NodeId, format: "step" | "brep"): Promise<ArrayBuffer | string> {
  const body = await treeCall(key, node, exportRequest(key, node, format));
  const problem = text(body.error);
  if (problem) return problem;
  if (typeof body.bytesBase64 !== "string") return "Open CASCADE did not write this solid.";
  const bytes = base64ToBytes(body.bytesBase64);
  if (!bytes || (typeof body.byteLength === "number" && bytes.byteLength !== body.byteLength)) {
    return "Open CASCADE did not write this solid.";
  }
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** `step` is the solid (`brep`) whose plate mesh is `token`: it goes wherever that mesh is. Undefined removes it. */
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
  const stem = name.replace(/\.(step|stp|stl|3mf|brep)$/i, "");
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

/**
 * Show `parsed` as the open tree's current node, or with `view` a tool's step in its place. The camera frames it when
 * another object opened, and stays put otherwise. A tool's step looked at outside an edit is read-only: the tools wait.
 */
function present(parsed: ParsedSolid, message: string, view: Lens | null = null) {
  lens = view;
  picks = [];
  hideEmpty();
  if (!view) learnSeat(parsed);
  setModelLocked(view && !editing ? PEEK_LOCK : null);
  fx.model?.setSolid(parsed, openPose());
  if (open && framedFor !== open.objectId) {
    framedFor = open.objectId;
    frameModel(false);
  }
  syncPlaceFields();
  syncWorkplaneFields();
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
  // --- A7 model check --- a queued Check opens after the solid is on screen; one already open measures this solid.
  if (checkQueued) openQueuedCheck();
  else if (openModelTool() === "check") refreshModelCheck();
}

/** Prepare asked to check this object. The tool opens once that solid, or its mesh, is on screen. */
let checkQueued = false;

export function requestModelCheck(objectId: string) {
  if (!state.plate.objects.some((obj) => obj.id === objectId)) return;
  checkQueued = true;
  const changed = state.plate.selectedId !== objectId;
  if (changed) fx.selectPlateObject(objectId);
  if (state.stage !== "model") {
    document.querySelector<HTMLButtonElement>("#tabModel")?.click();
    return;
  }
  if (!changed) openQueuedCheck();
}

function openQueuedCheck() {
  if (!checkQueued) return;
  checkQueued = false;
  if (openModelTool() === "check") refreshModelCheck();
  else document.querySelector<HTMLButtonElement>("#modelToolCheck")?.click();
}

/** The other plate objects, grey, where they sit in model space, but for a join's tool, which is the ghost. */
export function refreshModelContext() {
  if (refreshingContext) return;
  // The plate changed: a join's list follows it, and loses a tool that left. The refresh that loss asks for is this one.
  refreshingContext = true;
  try {
    refreshJoinChoices();
  } finally {
    refreshingContext = false;
  }
  ghosted = ghostId();
  const parts = contextParts(livePlate(), open?.objectId ?? null).filter((part) => part.id !== ghosted);
  if (lens && open) {
    // A tool's step on screen: the part its join cut is grey behind it, as it was on screen, and the tool's own plate
    // object, if Keep left it there, would only stand in its way.
    const tool = lens.joins.at(-1)?.op.tool.object;
    fx.model?.setContext([...parts.filter((part) => part.id !== tool), { id: open.objectId, positions: open.solid.positions, matrix: objectPose() }]);
  } else {
    fx.model?.setContext(parts);
  }
  const canvas = document.querySelector<HTMLElement>("#model");
  const obj = open ? state.plate.objects.find((item) => item.id === open!.objectId) : undefined;
  // The open object's plate mesh, so a test can tell a model-space move left it alone.
  if (canvas && obj) canvas.dataset.plateMesh = meshTokenOf(obj.bytes);
}

/** The plate object drawn as the ghost rather than grey: Boolean's picked tool, or the tool of a join being edited. */
function ghostId(): string | null {
  const op = editing?.panel ? editing.op : null;
  return joinPick() ?? (op?.kind === "join" ? op.tool.object : null);
}

/** The open object's pose into model space. */
function objectPose(): Affine {
  const obj = open ? state.plate.objects.find((item) => item.id === open!.objectId) : undefined;
  return obj ? modelPoseOf(obj) : IDENTITY_POSE;
}

/** The pose of the solid on screen: a tool's step where its joins put it, else the open object's. */
function openPose(): Affine {
  return lens?.pose ?? objectPose();
}

/** The solid on screen: a tool's step, else the open solid's shown step. Every tool, pick and handle reads this one. */
function viewed(): ParsedSolid | null {
  return lens?.solid ?? open?.solid ?? null;
}

/** The box of the solid on screen, in model space. */
function openBox(): Bounds | null {
  const solid = viewed();
  return solid ? posedBounds(solid.positions, openPose()) : null;
}

/** The box of a mesh's vertices, read once per array: a solid's own box, which Place turns about and the kernel cuts against, or a plate mesh's. */
function boxOf(positions: Float32Array): Bounds {
  let box = ownBoxes.get(positions);
  if (!box) ownBoxes.set(positions, (box = boundsOf(positions)));
  return box;
}

function pivotOf(solid: ParsedSolid): Vec3 {
  const own = boxOf(solid.positions);
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
  const from = objectPose();
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
  fx.model?.setPose(objectPose());
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
  if (!samePose(before, objectPose())) {
    placeUndo.push(before);
    placeRedo = [];
    markModelEdit();
  }
  syncUndo();
  // A turn changes the solid's model-space box, and with it which tools are on offer.
  syncModelSolid();
}

function samePose(a: Affine, b: Affine): boolean {
  return sameMat(a.t, b.t) && sameMat(a.m, b.m);
}

/** Undo or Redo one Place step. A gesture still settling becomes a step first, so Undo takes it back. */
function placeStep(way: "undo" | "redo") {
  endPlace();
  const [from, to] = way === "undo" ? [placeUndo, placeRedo] : [placeRedo, placeUndo];
  const at = open;
  const pose = from.pop();
  if (!at || !pose) return;
  to.push(objectPose());
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

function openObject(): PlateObject | undefined {
  const at = open;
  return at ? state.plate.objects.find((item) => item.id === at.objectId) : undefined;
}

/** The open object while it is also the plate's selected one, whose orient `state.orient` is. */
function plateObjectOpen(): PlateObject | undefined {
  const obj = openObject();
  return obj && obj.id === state.plate.selectedId ? obj : undefined;
}

/** The open object's workplane in model space: the frame it keeps in its own frame, at its pose. */
function workplaneOfOpen(): Workplane {
  const obj = openObject();
  return workplaneIn(obj?.workplane, modelPoseOf(obj ?? {}));
}

/**
 * The frame on the last picked face, in model space. Its U and V are worked out from the face in the part's own frame,
 * so they run along the part's own axes however the part is turned. A curved face is refused; no face is null.
 */
function faceWorkplane(): Workplane | "curved" | null {
  const face = lastFace(picks);
  const at = open;
  if (!at || face == null) return null;
  const own = flatFace(at.solid, face);
  return own ? workplaneIn(workplaneOnFace(own), objectPose()) : "curved";
}

/** A flat face of the open solid, from its own frame into model space. */
function posedFace(own: FacePlane | null): FacePlane | null {
  const pose = openPose();
  return own && !isIdentity(pose) ? { point: applyPose(pose, own.point), normal: turnDir(pose, own.normal) } : own;
}

function sameMat(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function workplaneNow(): WorkplaneStep {
  const plane = openObject()?.workplane;
  return { plane, orient: [...state.orient] as Mat3 };
}

function sameStep(a: WorkplaneStep, b: WorkplaneStep): boolean {
  return (a.plane && b.plane ? sameWorkplane(a.plane, b.plane) : a.plane === b.plane) && sameMat(a.orient, b.orient);
}

/** The Workplane panel moved the open object's frame, given in model space. Neither the plate nor the slice changes. */
function workplaneMoved(plane: Workplane, phase: PlacePhase) {
  const at = open;
  if (!at || busy || jumping) return;
  if (sameWorkplane(plane, workplaneOfOpen())) {
    if (phase === "end") endWorkplane();
    return;
  }
  startWorkplane();
  // Global is model space whatever the part's pose: not stored, so it stays model space after a Place.
  state.plate = withWorkplane(state.plate, at.objectId, isGlobalFrame(plane) ? undefined : workplaneOwn(plane, objectPose()));
  markProjectDirty();
  window.clearTimeout(wpTimer);
  if (phase === "end") endWorkplane();
  else if (phase === "typed") wpTimer = window.setTimeout(endWorkplane, PLACE_SETTLE_MS);
  syncUndo();
}

function startWorkplane() {
  if (wpBefore) return;
  wpBefore = workplaneNow();
  beginEdit();
}

/**
 * Print with W up: the part turns on the plate so its workplane's W points up and U runs along X, as Prepare's Lay
 * flat turns it, one step for Undo here and in Prepare. The frame itself does not move.
 */
function printWUp() {
  const obj = plateObjectOpen();
  if (!obj || busy || jumping) return;
  const orient = printOrient(obj.workplane);
  if (sameMat(state.orient, orient)) return;
  endWorkplane();
  startWorkplane();
  state.orient = orient;
  place();
  endWorkplane();
}

/** A workplane gesture is over: one step back for Undo here, and one Prepare step, folded into the visit like an edit. */
function endWorkplane() {
  window.clearTimeout(wpTimer);
  const before = wpBefore;
  wpBefore = null;
  if (!before) return;
  flushEdit();
  if (!sameStep(before, workplaneNow())) {
    wpUndo.push(before);
    wpRedo = [];
    markModelEdit();
  }
  syncUndo();
}

/** Undo or Redo one workplane step. A gesture still settling becomes a step first, so Undo takes it back. */
function workplaneStep(way: "undo" | "redo") {
  endWorkplane();
  const [from, to] = way === "undo" ? [wpUndo, wpRedo] : [wpRedo, wpUndo];
  const at = open;
  const step = from.pop();
  if (!at || !step) return;
  to.push(workplaneNow());
  beginEdit();
  state.plate = withWorkplane(state.plate, at.objectId, step.plane);
  markProjectDirty();
  if (!sameMat(step.orient, state.orient)) {
    state.orient = [...step.orient] as Mat3;
    place();
  }
  flushEdit();
  markModelEdit();
  syncWorkplaneFields(true);
  syncUndo();
}

/** Workplane steps belong to the object they moved, in one Model visit. */
function forgetWorkplaneSteps() {
  endWorkplane();
  wpUndo = [];
  wpRedo = [];
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
  const framing = openModelTool() === "workplane";
  // While a step is edited, Cancel is the way back.
  const held = busy || jumping || !tree || !!editing;
  if (undo) {
    undo.disabled = held || (placing ? placeUndo.length === 0 && !placeBefore : framing ? wpUndo.length === 0 && !wpBefore : undoNode(tree!) == null);
    undo.dataset.tip = placing ? "Undo the last move" : framing ? "Undo the last workplane move" : "Undo the last solid edit";
  }
  if (redo) {
    redo.disabled = held || (placing ? placeRedo.length === 0 : framing ? wpRedo.length === 0 : redoNode(tree!) == null);
    redo.dataset.tip = placing ? "Redo the last move" : framing ? "Redo the last workplane move" : "Redo the last solid edit";
  }
  const stepButton = document.querySelector<HTMLButtonElement>("#modelStep");
  if (stepButton) stepButton.disabled = busy || jumping || !tree;
  setModelWaiting(busy || jumping);
  syncModelHistory(tree, modelTrees, lens?.row ?? null);
  syncPosition();
  // --- A8. A recipe saved with this object, read-only under the History header. ---
  syncModelRecipe(open ? recipeNote(session.mcpModel, open.objectId) : null);
}

/** The Position row, from the pose the plate object holds and the solid's own box, read once per solid. */
function syncPosition() {
  const pose = objectPose();
  syncModelPosition(open ? placeFields(pose, pivotOf(open.solid)) : null, isIdentity(pose));
}

/**
 * The Position row's Reset: back to where the file put the part, as one Place step, which Prepare undo takes back. It
 * goes through Place, which closes another tool or an edited step first: their checked numbers were for the old pose.
 */
function resetPose() {
  const at = open;
  if (!at || busy || jumping || isIdentity(objectPose())) return;
  openPlaceTool();
  if (openModelTool() !== "place") return;
  endPlace();
  placeBefore = objectPose();
  beginEdit();
  putPose(at.objectId, IDENTITY_POSE);
  endPlace();
  syncPlaceFields(true);
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
  const own = boxOf(solid.positions);
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
  const at = viewed();
  const pose = openPose();
  const box = openBox();
  if (!at || !box) return { why: "Open a STEP file to measure a solid.", wait: true };
  const mode = splitMode();
  const frame = toolFrame();
  const picked = mode === "face" ? lastFace(picks) : null;
  const facePicking = document.querySelector("#modelPickFace")?.getAttribute("aria-pressed") === "true";
  const value = num("#modelPlane");
  const tilt: [number, number] = [num("#modelTiltA"), num("#modelTiltB")];
  // An edited split whose normal points down its axis keeps that side: its base is the axis turned around.
  const edited = editing?.panel?.plane;
  const flip = !!edited?.flip && edited.mode === mode;
  const key = `${mode}|${picked}|${facePicking}|${value}|${tilt}|${flip}|${frame.source}|${frame.origin}|${frame.turn}`;
  if (splitKept?.solid === at && splitKept.pose === pose && splitKept.key === key) return splitKept.state;
  let state: SplitState;
  if (mode === "face" && picked == null) {
    state = { why: facePicking ? "Pick a flat face to cut from." : "Switch to Face picking, then pick a flat face to cut from.", wait: true };
  } else {
    const own = picked == null ? null : flatFace(at, picked);
    const face = posedFace(own);
    const center: Vec3 = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
    let base = splitBase(mode, center, face);
    // X, Y, and Z stay those axes on the global frame. Any other frame reads them as U, V, and W from its origin.
    if (base && mode !== "face" && !isIdentityFrame(frame)) {
      const [u, v, w] = axesOf(frame);
      const axis = mode === "x" ? u : mode === "y" ? v : w;
      base = { mode, normal: axis, base: [frame.origin[0], frame.origin[1], frame.origin[2]], dir: axis };
    }
    if (base && flip) base = { ...base, normal: [-base.normal[0], -base.normal[1], -base.normal[2]] as Vec3 };
    state = base
      ? { plan: planeFor(base, value, tilt, (normal) => modelExtent(at, pose, normal), kernelBox(at, pose)) }
      : { why: "Pick a flat face. This one is curved.", wait: false };
  }
  splitKept = { solid: at, pose, key, state };
  return state;
}

/** A split is on offer when the solid can be cut square to at least one model axis. */
function splitLegal(): boolean {
  const at = viewed();
  const pose = openPose();
  const box = openBox();
  if (!at || !box) return false;
  const kernel = kernelBox(at, pose);
  return (["x", "y", "z"] as const).some((mode) => planeFor(splitBase(mode, [0, 0, 0], null)!, 0, [0, 0], (normal) => modelExtent(at, pose, normal), kernel).range != null);
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

/** Into the last picked face, or with no face picked, the way an edited hole drilled, else along the workplane's −W. */
function drillAxis(): Vec3 {
  const face = lastFace(picks);
  const solid = viewed();
  if (!solid || face == null) return editing?.panel?.axis ?? drillDown(toolFrame());
  const stored = solid.faces.find((item) => item.id === face)?.normal;
  const axis = holeAxis(stored ?? outwardFromMesh(solid.positions, solid.triangles, face));
  const pose = openPose();
  return isIdentity(pose) ? axis : turnDir(pose, axis);
}

// --- A2 shell ---
/** The first picked face's middle and inward normal, in model space. The thickness knob sits there. */
function shellSeat(): { point: Vec3; inward: Vec3 } | null {
  const face = selectedFaces(picks)[0];
  const solid = viewed();
  if (face == null || !solid) return null;
  const stored = solid.faces.find((item) => item.id === face)?.normal;
  const outward = stored ?? outwardFromMesh(solid.positions, solid.triangles, face);
  const centre = faceCentre(solid.positions, solid.triangles, face);
  if (!outward || !centre) return null;
  const inward = holeAxis(outward);
  const pose = openPose();
  return isIdentity(pose) ? { point: centre, inward } : { point: applyPose(pose, centre), inward: turnDir(pose, inward) };
}

/** Each shown face as the shell matcher wants it: its reply area, and the mesh's area-weighted middle. */
function faceRows(solid: ParsedSolid): { id: number; areaMm2: number; mid: Vec3 }[] {
  return solid.faces.map((face) => ({
    id: face.id,
    areaMm2: face.areaMm2,
    mid: faceCentre(solid.positions, solid.triangles, face.id) ?? [Number.NaN, Number.NaN, Number.NaN],
  }));
}

function num(id: string) {
  return fieldNumber(id.slice(1));
}

function stlName(name: string) {
  const stem = name.replace(/\.(step|stp|stl|3mf)$/i, "");
  return `${stem || "solid"}.stl`;
}

let measureSeq = 0;

async function onPick(pick: ModelPick | null, shift: boolean) {
  const at = open;
  const tree = treeOf(at);
  const solid = viewed();
  // A tool's step looked at is read-only; while one is edited, picks are on it.
  if (!at || !tree || !solid || (lens && !editing)) return;
  picks = nextModelPicks(picks, pick, shift);
  paintBlendHighlight();
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
  const [key, node] = lens ? [lens.key, lens.node] : [at.key, tree.current];
  const body = await treeCall(key, node, {
    call: "distance",
    key,
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

let readoutText = "";

function readout(message: string) {
  readoutText = plainModelError(message, modelTool());
  paintReadout();
}

/** The sentence, then Show where while a refusal has boxes. Setting textContent would drop the button. */
function paintReadout() {
  const node = document.querySelector("#modelReadout");
  if (!node) return;
  node.textContent = readoutText;
  if (!locatedNow) return;
  const button = document.createElement("button");
  button.id = "modelShowWhere";
  button.type = "button";
  button.className = "btn model-show-where";
  button.textContent = "Show where";
  button.addEventListener("click", () => frameLocated());
  node.append(button);
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
  const problem = (unopened.has(key) ? await restoreShared(key, node) : null) ?? (await wholeTools(key, node, request));
  if (problem) return { error: problem };
  let body = await seededCall(key, node, request);
  // A join's tool tree the engine lacks (a restarted engine, or a tree opened from a project) opens, and the call goes again.
  for (let tools = 0, round = 0; round < 2; ) {
    const tool = missingToolOf(body);
    if (tool && tools < TOOL_ROUNDS) {
      tools += 1;
      const problem = await restoreTool(tool.key, tool.node);
      if (problem) return { error: problem };
      body = await seededCall(key, node, request);
      continue;
    }
    const missing = missingOf(body);
    if (!missing) return body;
    const running = round === 0 ? restoring.get(key) : undefined;
    round += 1;
    const restored: Promise<string | null> = running ?? restore(key, node, missing).finally(() => {
      if (restoring.get(key) === restored) restoring.delete(key);
    });
    if (!running) restoring.set(key, restored);
    const problem = await restored;
    if (problem) return { error: problem };
    body = await seededCall(key, node, request);
  }
  return missingOf(body) ? { error: GONE } : body;
}

/** Open tree `key` whole, toward `node`, sharing an open already on its way. */
function restoreShared(key: string, node: NodeId): Promise<string | null> {
  const running = restoring.get(key);
  if (running) return running;
  const restored: Promise<string | null> = restore(key, node, [ROOT]).finally(() => {
    if (restoring.get(key) === restored) restoring.delete(key);
  });
  restoring.set(key, restored);
  return restored;
}

/** How many tool trees one call may open again: one per tree in the deepest chain of joins anyone builds. */
const TOOL_ROUNDS = 8;

/**
 * A tree from a project that sits on its STEP-read step numbers that step 0 in the engine, so a join that names its root
 * would take the read solid instead. Every such tree a call on `node` of `key` can build from (by the joins on the way
 * to `node`, the join the call sends, and theirs in turn) opens whole first. A join naming any other step of it gets
 * `missingTool` and opens it then.
 */
async function wholeTools(key: string, node: NodeId, request: Body): Promise<string | null> {
  const joinsTo = (tree: ModelTree | undefined, at: NodeId) =>
    tree ? pathTo(tree, at).flatMap((id) => { const op = tree.nodes.get(id)?.op; return op?.kind === "join" ? [op.tool] : []; }) : [];
  // The op sent, and an edit's replayed ops, can each be a join.
  const ops = (body: Body) => [body.op, ...(Array.isArray(body.replay) ? (body.replay as { op?: unknown }[]).map((step) => step.op) : [])];
  // An edit across trees sends each tool tree's part too: its path, its op and its replay can name a tool as well.
  const parts = Array.isArray(request.tools) ? (request.tools as Body[]) : [];
  const sent = [request, ...parts].flatMap(ops);
  const queue = [
    ...joinsTo(modelTrees.get(key), node),
    ...parts.flatMap((part) => (typeof part.key === "string" && typeof part.parent === "number" ? joinsTo(modelTrees.get(part.key), part.parent) : [])),
    ...sent.flatMap((op) => (isOp(op) && op.kind === "join" ? [op.tool] : [])),
  ];
  const seen = new Set<string>();
  for (let tool = queue.pop(); tool !== undefined; tool = queue.pop()) {
    if (seen.has(`${tool.key}#${tool.node}`)) continue;
    seen.add(`${tool.key}#${tool.node}`);
    const seed = seeds.get(tool.key);
    const problem = seed && tool.node === ROOT ? await openWhole(tool.key, seed.node) : null;
    if (problem) return problem;
    queue.push(...joinsTo(modelTrees.get(tool.key), tool.node));
  }
  return null;
}

/**
 * A join's tool the engine does not hold: its tree comes back from its root and ops, as a tree after a restart does,
 * down to `node`. Calls that find it missing at once share one restore.
 */
function restoreTool(key: string, node: NodeId): Promise<string | null> {
  if (!modelTrees.get(key)?.nodes.has(node)) return Promise.resolve("The tool object's history is no longer open.");
  const running = restoring.get(key);
  if (running) return running;
  const seed = seeds.get(key);
  const restored: Promise<string | null> = (seed ? openWhole(key, seed.node) : restore(key, node, [ROOT])).finally(() => {
    if (restoring.get(key) === restored) restoring.delete(key);
  });
  restoring.set(key, restored);
  return restored;
}

function missingToolOf(body: Body): { key: string; node: NodeId } | null {
  const tool = body.missingTool as { key?: unknown; node?: unknown } | undefined;
  return tool && typeof tool.key === "string" && typeof tool.node === "number" ? { key: tool.key, node: tool.node } : null;
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
    // A step the engine holds takes calls and new steps on it; an earlier step, or an edit of one, needs the history.
    const named = request.call === "apply" && NAMES_TOPOLOGY.has(String((request.op as { kind?: unknown } | undefined)?.kind));
    if (seed && (!seed.held.has(node) || request.call === "edit" || named)) {
      const problem = await openWhole(key, node);
      if (problem) return { error: problem };
      continue;
    }
    if (!seed) {
      await countedReach(key, node);
      const body = await post(request);
      noteHeld(key, body);
      return body;
    }
    if (!seed.live) return post(request);
    const body = await post(engineNumbered(seed, request));
    // The engine does not run calls in the order they were sent: an open that started after this one
    // may have run first, and then its node 0 is the root. Such an answer is asked for again.
    if (seeds.get(key) !== seed || seed.whole || seed.reading || !seed.live) continue;
    if (request.call === "apply" && typeof request.node === "number" && !text(body.error)) seed.held.add(request.node);
    // `seeded`: the answer is about the STEP-read step.
    return { ...body, seeded: true, ...(body.id === ROOT ? { id: seed.node } : {}), ...(body.broken === ROOT ? { broken: seed.node } : {}) };
  }
}

/** `request` with the plate's step of a live seed as the engine's root. */
function engineNumbered(seed: Seed, request: Body): Body {
  const local = (id: unknown) => (id === seed.node ? ROOT : id);
  const asNode = (id: NodeId) => (id === seed.node ? ROOT : id);
  const numbered: Body = { ...request, node: local(request.node), ...("parent" in request ? { parent: local(request.parent) } : {}) };
  // --- A5. A blend's fromNode is a history step. The plate's step is the engine's root. ---
  if (isOp(numbered.op)) numbered.op = remapBlendFromNode(numbered.op, asNode);
  if (Array.isArray(numbered.replay)) {
    numbered.replay = numbered.replay.map((step) => {
      if (!step || typeof step !== "object") return step;
      const op = (step as { op?: unknown }).op;
      return isOp(op) ? { ...(step as object), op: remapBlendFromNode(op, asNode) } : step;
    });
  }
  return numbered;
}

/** Drop the branch from `node` in the engine, once it has one: a seeded tree's engine holds only the steps built on its seed. */
async function dropInEngine(key: string, node: NodeId) {
  for (let seed = seeds.get(key); seed; seed = seeds.get(key)) {
    if (!seed.whole) {
      if (!seed.held.has(node) || node === seed.node) return;
      await post({ call: "drop", key, node });
      const tree = modelTrees.get(key);
      for (const id of [...seed.held]) if (id !== seed.node && !tree?.nodes.has(id)) seed.held.delete(id);
      return;
    }
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
    // A step's own solid, saved in the binary format, stands in for the steps above it: the history builds from there.
    const solid = seedSolid(tree, node);
    // A short history opens at `node` in one call. With a seed, or a long history, it opens at its root, and the steps
    // still to build toward `node` are built a few per call when there are many (`countedReach`), so the readout can
    // count them and a minute of rebuilding is never a silent wait, even when the engine refuses the seed.
    const start = solid || pathTo(tree, node).length > COUNTED_REBUILD ? ROOT : node;
    // Quiet: the call that needed the tree asks for its step next, so the open meshes and sends nothing.
    let body = await post(wholeTreeRequest(tree, tree.root, start, state.stepTolerance, { seed: solid, quiet: true }));
    noteHeld(key, body);
    if (solid && typeof body.seedRefused === "string") {
      refusedSolids.add(solid.bytes);
      // Said with the step once it is shown, which can come after the rebuild's own count in the readout.
      seedNotes.set(key, `The saved solid did not open (${body.seedRefused}), so its history was rebuilt.`);
    }
    if (!text(body.error) && typeof body.broken !== "number") body = await countedReach(key, node);
    if (seed) seed.whole = null;
    if (!modelTrees.has(key)) return closeLate(key);
    // A primitive root that builds differently opens nothing: the whole tree is broken from its root.
    if (body.broken === ROOT) {
      failed(key, body);
      return ROOT_BROKEN;
    }
    const problem = typeof body.broken === "number" ? "" : text(body.error);
    if (problem) return problem;
    unopened.delete(key);
    if (seed) {
      forgetShown(key);
      // The older file's STEP was a read of the step; the step is rebuilt now, and the next save writes its solid exactly.
      const token = tree.nodes.get(seed.node)?.mesh?.token;
      if (token) stepKnown.delete(token);
    }
    seeds.delete(key);
    return null;
  })();
  if (seed) seed.whole = run;
  return run;
}

/** What a call says when the engine lost the tree again while it was being restored. */
const GONE = "The modeler no longer has this solid. Open Model again to reload it.";

/** The engine's refusal of a scale by 1, which it answers after building the step the probe names (`countedBuild`). */
const SCALE_BY_ONE = "Scale needs a factor other than 1";

/** Trees from a project that the engine has not been sent yet: the first call opens them, rather than ask and be told. */
const unopened = new Set<string>();

/** What the readout says with a tree's step when it next shows one: why its saved solid was refused. */
const seedNotes = new Map<string, string>();

/** Solids the engine refused as a seed (another modeler's, or not the step): the history is rebuilt instead. */
const refusedSolids = new WeakSet<ArrayBuffer>();

/**
 * The saved solid to open `node`'s history with: the nearest step on the way to `node` whose plate mesh carries its solid
 * in the binary format, else the plate's step's, which serves a later jump below it. Null when no step has one.
 */
function seedSolid(tree: ModelTree, node: NodeId): { node: NodeId; bytes: ArrayBuffer } | null {
  const usable = (id: NodeId) => {
    const bytes = id === ROOT ? undefined : tree.nodes.get(id)?.mesh?.step;
    return bytes && isBrep(bytes) && !refusedSolids.has(bytes) ? { node: id, bytes } : null;
  };
  for (const id of pathTo(tree, node).reverse()) {
    const found = usable(id);
    if (found) return found;
  }
  return usable(tree.committed);
}

/** The steps of each whole tree the engine said it holds a solid for, from its last answer with `held`. */
const engineHeld = new Map<string, Set<NodeId>>();

function noteHeld(key: string, body: Body) {
  if (Array.isArray(body.held)) engineHeld.set(key, new Set(body.held.filter((id): id is number => typeof id === "number")));
}

/**
 * Build `path` (from a step the engine holds down to the step wanted) a few steps per call, counting them in the
 * readout. Answers the step that broke, or an error, else nothing.
 */
async function countedBuild(key: string, path: readonly NodeId[]): Promise<Body> {
  const steps = path.length - 1;
  const stride = Math.max(1, Math.round(steps / 50));
  const shownHere = () => state.stage === "model" && open?.key === key;
  let body: Body = {};
  for (let at = stride; at <= steps && !text(body.error) && typeof body.broken !== "number"; at = at === steps ? steps + 1 : Math.min(steps, at + stride)) {
    if (!modelTrees.has(key)) break;
    if (shownHere()) readout(`Rebuilding the history: step ${at} of ${steps}…`);
    // A probe builds its step without meshing it; a scale by 1 asks nothing else of the kernel.
    let built = await post(probeRequest(key, path[at]!, { kind: "scale", factor: 1 }));
    // A join on the way whose tool tree the engine does not hold: that tree opens, and the step is asked again.
    for (let tools = 0, tool = missingToolOf(built); tool && tools < TOOL_ROUNDS; tools += 1, tool = missingToolOf(built)) {
      const problem = await restoreTool(tool.key, tool.node);
      if (problem) return { error: problem };
      built = await post(probeRequest(key, path[at]!, { kind: "scale", factor: 1 }));
    }
    body = typeof built.broken === "number" || text(built.error).includes("not open") ? built : {};
    // A probe's answer lists no solids. The scale by 1 is refused once its step is built, so that refusal (or a check that
    // passed) means the step is held now, and the call after this one counts from it; any other answer built nothing.
    if (built.ok === true || text(built.error) === SCALE_BY_ONE) engineHeld.get(key)?.add(path[at]!);
    else if (typeof built.broken !== "number") return { error: missingOf(built) ? GONE : text(built.error) || "The history could not be rebuilt." };
  }
  return body;
}

/**
 * Before a call on `node` of a whole tree: when the engine would replay more than `COUNTED_REBUILD` steps to reach it
 * (a jump far below a reopened project's plate step, or past solids it let go), they are built counted first.
 */
async function countedReach(key: string, node: NodeId): Promise<Body> {
  const held = engineHeld.get(key);
  const tree = modelTrees.get(key);
  if (!held || !tree?.nodes.has(node)) return {};
  const path = pathTo(tree, node);
  let from = path.length - 1;
  while (from > 0 && !held.has(path[from]!)) from -= 1;
  if (path.length - 1 - from <= COUNTED_REBUILD) return {};
  return countedBuild(key, path.slice(from));
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
    const body = await post(openRequest(key, { kind: "step", name: stepFileName(step.name), bytes: step.step }, chord)).finally(() => {
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
    const request = applyRequest(key, step.parent, id, step.op, chord);
    let body = await post(request);
    for (let tools = 0; missingToolOf(body) && tools < TOOL_ROUNDS; tools += 1) {
      const tool = missingToolOf(body)!;
      const problem = await restoreTool(tool.key, tool.node);
      if (problem) return problem;
      body = await post(request);
    }
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
  const body = await treeCall(parentKey, splitNode.parent, applyRequest(parentKey, splitNode.parent, spare, splitNode.op, state.stepTolerance, pieceKey));
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
