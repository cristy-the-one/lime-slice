/** Print transitions: the card's check, find, fix, ghost, and the stale-pose note. */
import { replayChain } from "../../model-edit";
import { outwardFromMesh } from "../../model-blend";
import { pathTo, type ModelTree, type NodeId, type TransitionOp } from "../../model-tree";
import { probeRequest } from "../../model-request";
import { syncModelChrome } from "../../ui/model-chrome";
import { rowKey } from "../../model-history";
import { type PlateObject } from "../../plate";
import { livePlate, slicedKey } from "../files";
import { fx } from "../fx";
import { plainModelError } from "../model-error";
import { modelTrees } from "../model-trees";
import { refreshObjectList, stale } from "../settings";
import { session, state } from "../state";
import { selection } from "../../ui/machine-library.ts";
import {
  reopenTransitionFind,
  setTransitionCheck,
  setTransitionChain,
  setTransitionFinding,
  setTransitionWaiting,
  transitionCardOpen,
  transitionPicked,
  type TransitionCheck,
} from "../../ui/transition-card.ts";
import {
  edgeChainRequest,
  keptKey,
  readEdgeChain,
  readFinding,
  readTransitionRows,
  reaimedTransition,
  staleNote,
  transitionFindRequest,
  transitionFix,
  transitionStaleBy,
  wedgeSoup,
  type TransitionCard,
  type TransitionPose,
  type TransitionRow,
  checkAgainstSlice,
  positionsBox,
  type Finding,
} from "../../model-transition.ts";
import { loadMachineLibrary } from "../machine-library.ts";
import { S } from "./shared";
import { applyOp } from "./apply";
import { paintBlendHighlight, treeOf } from "./edges";
import { text, treeCall } from "./engine";
import { readout } from "./pick";
import { probeName } from "./probe";
import { runEdit, sentence } from "./run-edit";
import { type Editing, VIEW_ONLY } from "./shared";
import { syncUndo } from "./undo";
import { viewed } from "./view";
import { openObject } from "./workplane";
import { selectedEdges } from "../../model-blend";
import { transitionFloorMm } from "../../model-transition.ts";
import { mountTransitionCard } from "../../ui/transition-card.ts";
import { cancelEdit } from "./edit";

/**
 * --- Print transitions (step 6): the tangent chain through `edge`, from the kernel, picked in place of the edge alone
 * once it answers, if that edge is still the one picked. A lone edge, or a refusal, leaves the pick as it is.
 */
export async function pickTransitionChain(key: string, node: NodeId, edge: number) {
  const generation = S.ticket;
  const body = await treeCall(key, node, edgeChainRequest(key, node, edge));
  if (generation !== S.ticket || !transitionCardOpen()) return;
  if (!(S.picks.length === 1 && S.picks[0]!.kind === "edge" && S.picks[0]!.index === edge)) return;
  const solid = viewed();
  const edges = (readEdgeChain(body, edge) ?? []).filter((index) => solid?.edges.some((row) => row.id === index));
  if (edges.length < 2) return;
  S.picks = edges.map((index) => ({ kind: "edge", index }));
  paintBlendHighlight();
  syncModelChrome(S.picks);
  setTransitionChain(edges);
  transitionPicked();
  readout(`A chain of ${edges.length} edges that run on with no corner. Click one of them again to take it alone.`);
}

// ---------------------------------------------------------------------------
// --- Print transitions (docs/plan-belt-transitions.md, step 3): the card's check and ghost, and the stale-pose note.
// ---------------------------------------------------------------------------

/** The pose a step on `obj` is aimed from: its orientation on the plate and the plate's printer. */
export function transitionPose(obj: PlateObject | undefined): TransitionPose {
  const printer = selection(loadMachineLibrary())?.printer;
  const orient = obj && obj.id !== state.plate.selectedId ? obj.orient : state.orient;
  return { orient: [...orient], belt: printer?.kind === "belt" ? printer.belt : null, printer: printer?.id ?? "" };
}

let transitionTimer = 0;

let transitionSerial = 0;

/** Kernel answers for the card, by `probeName`, so going back to numbers just checked asks nothing. */
const transitionAnswers = new Map<string, Exclude<TransitionCheck, null | { phase: "checking" }>>();

/** The card's op changed: the kernel builds a copy once it rests `wait` ms. */
export function checkTransition(op: TransitionOp | null, wait: number) {
  window.clearTimeout(transitionTimer);
  const serial = ++transitionSerial;
  const at = S.open;
  const tree = treeOf(at);
  if (!op || !at || !tree) {
    setTransitionCheck(null);
    return;
  }
  const node = tree.current;
  const key = probeName(at.key, node, op);
  const known = transitionAnswers.get(key);
  if (known) {
    setTransitionCheck(known);
    return;
  }
  setTransitionCheck({ phase: "checking" });
  transitionTimer = window.setTimeout(() => void sendTransitionCheck(serial, key, at.key, node, op), wait);
}

async function sendTransitionCheck(serial: number, key: string, treeKey: string, node: NodeId, op: TransitionOp) {
  if (serial !== transitionSerial || state.stage !== "model") return;
  const body = await treeCall(treeKey, node, probeRequest(treeKey, node, op));
  const rows = body.ok === true ? readTransitionRows(body.transition, op.orient ?? state.orient) : null;
  const view: Exclude<TransitionCheck, null | { phase: "checking" }> = rows
    ? { phase: "done", ok: true, rows }
    : { phase: "done", ok: false, error: sentence(plainModelError(text(body.error) || "This print transition does not fit.", "transition")) };
  if (typeof body.ok === "boolean") {
    if (transitionAnswers.size >= 64) transitionAnswers.clear();
    transitionAnswers.set(key, view);
  }
  if (serial === transitionSerial && state.stage === "model") setTransitionCheck(view);
}

/** The wedges the kernel's rows describe, on the solid on screen, in its own frame. A lip's gusset or ramp comes as the kernel's own triangles. */
export function transitionWedges(rows: readonly TransitionRow[]): number[] {
  const solid = viewed();
  if (!solid) return [];
  const normal = (face: number) => solid.faces.find((item) => item.id === face)?.normal ?? outwardFromMesh(solid.positions, solid.triangles, face);
  return rows.flatMap((row) => {
    if (row.soup) return row.soup;
    const edge = solid.edges.find((item) => item.id === row.edge);
    const far = normal(row.farFace);
    const near = normal(row.nearFace);
    if (!edge || edge.points.length < 6 || !far || !near) return [];
    const last = edge.points.length - 3;
    const start = [edge.points[0]!, edge.points[1]!, edge.points[2]!];
    const end = [edge.points[last]!, edge.points[last + 1]!, edge.points[last + 2]!];
    return wedgeSoup(start, end, far, near, row.reachMm, row.nearReachMm);
  });
}

// --- Print transitions, auto-find (step 5): the card's list, read by the kernel on the step on screen.
let findSerial = 0;

export async function findTransitions(numbers: TransitionCard) {
  const serial = ++findSerial;
  const at = S.open;
  const tree = treeOf(at);
  if (!at || !tree || S.lens) {
    setTransitionFinding({ phase: "failed", error: "Open a solid to find its edges." });
    return;
  }
  const node = tree.current;
  const fix = transitionFix(numbers);
  const body = await treeCall(at.key, node, transitionFindRequest(at.key, node, numbers.build, numbers.orient, state.supportAngle, fix));
  if (serial !== findSerial || S.open !== at || treeOf(at)?.current !== node || state.stage !== "model") return;
  const plain = (text: string) => sentence(plainModelError(text, "transition"));
  const read = readFinding(body, numbers.orient, fix, plain);
  // --- Step 6b. From the first Find on, slices measure the part beads on nothing, for the check below.
  session.partHold = true;
  setTransitionFinding(typeof read === "string" ? { phase: "failed", error: plain(read) } : { phase: "done", finding: againstSlice(read, at.objectId, tree, node, numbers.build), build: [...numbers.build] });
}

/**
 * --- Print transitions, step 6b (plan decision 7). `finding` marked with what the last slice saw hanging at its edges,
 * when that slice was of this object as it is now: the step on the plate, the same mesh, pose and scale, and settings
 * unchanged. Otherwise it is returned as it is, and the card says to slice.
 */
function againstSlice(finding: Finding, objectId: string, tree: ModelTree, node: NodeId, build: readonly number[]): Finding {
  const hold = session.sliceHold;
  const sliced = hold?.objects.find((row) => row.id === objectId);
  const obj = livePlate().find((row) => row.id === objectId);
  const solid = viewed();
  if (!hold || !sliced || !obj || !solid || stale() || tree.committed !== node || sliced.key !== slicedKey(obj)) return finding;
  const edges = solid.edges.map((edge) => ({ edge: edge.id, points: edge.points }));
  return checkAgainstSlice(finding, hold, sliced, edges, positionsBox(solid.positions), build);
}

/** Fix or Fix all: one history step. Once it builds, the card opens again on the new solid and finds what is left. */
export async function fixTransitions(op: TransitionOp, numbers: TransitionCard) {
  if (S.busy || S.jumping || S.editing) return;
  findSerial += 1;
  setTransitionWaiting(true);
  let built = false;
  try {
    built = await applyOp(op, op.edges.length === 1 ? "Adding the print transition…" : `Adding ${op.edges.length} print transitions…`);
  } finally {
    setTransitionWaiting(false);
  }
  if (built) reopenTransitionFind(numbers);
}

/** "Keep" on a stale step, for the pose it was kept at: a later turn warns again. */
const keptPoses = new Set<string>();

/** The print transitions on `tree`'s path to `node` that were made for another pose and were not kept for this one. */
function staleSteps(tree: ModelTree, node: NodeId, pose: TransitionPose): NodeId[] {
  return pathTo(tree, node).filter((id) => {
    const op = tree.nodes.get(id)?.op;
    return op?.kind === "transition" && transitionStaleBy(op, pose) != null && !keptPoses.has(keptKey(tree.key, id, pose));
  });
}

/** History's note for the open solid: its stale steps and the sentence. Null with none. */
export function staleView(): { ids: NodeId[]; text: string } | null {
  const tree = treeOf(S.open);
  if (!tree || S.lens) return null;
  const pose = transitionPose(openObject());
  const ids = staleSteps(tree, tree.current, pose);
  return ids.length > 0 ? { ids, text: staleNote(ids.length, !!pose.belt) } : null;
}

/** Prepare's note on a plate object whose plate step has stale print transitions, or null. */
export function transitionStaleNote(objectId: string): { text: string } | null {
  const obj = state.plate.objects.find((item) => item.id === objectId);
  const tree = obj?.modelTree ? modelTrees.get(obj.modelTree) : undefined;
  if (!obj || !tree) return null;
  const pose = transitionPose(obj);
  const ids = staleSteps(tree, tree.committed, pose);
  return ids.length > 0 ? { text: staleNote(ids.length, !!pose.belt) } : null;
}

/** Keep: the stale steps of `objectId` stay as built, and the note goes until the pose changes again. */
export function keepStale(objectId: string | null) {
  const obj = state.plate.objects.find((item) => item.id === objectId);
  const tree = obj?.modelTree ? modelTrees.get(obj.modelTree) : undefined;
  if (!obj || !tree) return;
  const pose = transitionPose(obj);
  for (const node of new Set([tree.current, tree.committed])) {
    for (const id of staleSteps(tree, node, pose)) keptPoses.add(keptKey(tree.key, id, pose));
  }
  if (state.stage === "model") {
    syncUndo();
    readout("The print transitions stay as they were made, for the other pose.");
  } else refreshObjectList();
}

/**
 * Re-aim: every stale step on the shown branch is rebuilt with the build direction of this pose, in one edit from the
 * earliest, with the steps after it replayed. A step that now refuses is named with its sentence, as any edit does.
 */
export async function reaimStale() {
  const at = S.open;
  const tree = treeOf(at);
  if (!at || !tree || S.busy || S.jumping || S.editing || S.lens || state.stage !== "model") return;
  if (!at.solid.editable) {
    readout(VIEW_ONLY);
    return;
  }
  const pose = transitionPose(openObject());
  const ids = staleSteps(tree, tree.current, pose);
  const earliest = ids[0];
  const node = earliest == null ? undefined : tree.nodes.get(earliest);
  if (earliest == null || node?.parent == null) return;
  const from = tree.current;
  const replay = replayChain(tree, earliest, from);
  const supplied = [earliest, ...replay].map((id) => {
    const op = tree.nodes.get(id)!.op!;
    return ids.includes(id) && op.kind === "transition" ? reaimedTransition(op, pose) : op;
  });
  const run: Editing = { key: at.key, target: at.key, row: rowKey([], earliest), joins: [], node: earliest, parent: node.parent, from, replay, op: supplied[0]!, panel: null, opened: null, supplied };
  S.editing = run;
  syncUndo();
  await runEdit(run);
  if (S.editing === run) {
    S.editing = null;
    syncUndo();
  }
}

export function requestReaim(objectId: string) {
  if (!state.plate.objects.some((obj) => obj.id === objectId)) return;
  S.reaimQueued = objectId;
  const changed = state.plate.selectedId !== objectId;
  if (changed) fx.selectPlateObject(objectId);
  if (state.stage !== "model") {
    document.querySelector<HTMLButtonElement>("#tabModel")?.click();
    return;
  }
  if (!changed) runQueuedReaim();
}

export function runQueuedReaim() {
  if (!S.reaimQueued || (S.open?.objectId ?? state.plate.selectedId) !== S.reaimQueued || !treeOf(S.open)) return;
  S.reaimQueued = null;
  window.setTimeout(() => void reaimStale(), 0);
}

export function bindTransition() {
  mountTransitionCard({
    solidOpen: () => !!viewed()?.editable && !S.lens,
    pickedEdges: () => selectedEdges(S.picks),
    pose: () => transitionPose(openObject()),
    printerName: (id) => loadMachineLibrary().printers.find((row) => row.id === id)?.name ?? (id || "plate's printer"),
    supportAngle: () => state.supportAngle,
    shallowSkins: () => state.shallowSkins,
    floorMm: () => transitionFloorMm(state.profile.nozzleDiameter),
    check: checkTransition,
    wedges: transitionWedges,
    cancelled: cancelEdit,
    readout,
    find: (numbers) => void findTransitions(numbers),
    fix: (op, numbers) => void fixTransitions(op, numbers),
    flag: (edges, lit) => fx.model?.setFlaggedEdges(edges, lit),
    pick(edge) {
      if (!viewed()?.edges.some((row) => row.id === edge)) return;
      S.picks = [{ kind: "edge", index: edge }];
      fx.model?.highlight(S.picks);
      syncModelChrome(S.picks);
      transitionPicked();
    },
  });
}
