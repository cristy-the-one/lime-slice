/** The feasibility probe: the panel's dry-run, its answers, and the preview solids kept for it. */
import { boundsOf, type Bounds } from "../../mesh-place";
import { boxUnder } from "../../model-space";
import { unionBox } from "../../measure";
import { decodeSolid, type ParsedSolid } from "../../model-reply";
import { disjointBoolean, isProbed, probeFromBody, probeKey, type ProbeView } from "../../model-feasibility";
import { isEdgeStep, usesTree, type ModelOp, type NodeId } from "../../model-tree";
import { probeRequest } from "../../model-request";
import { joinPick, refreshJoinChoices, openModelTool, setModelPreview, setModelProbe } from "../../ui/model-chrome";
import { fx } from "../fx";
import { modelTrees } from "../model-trees";
import { state } from "../state";
import { S } from "./shared";
import { editUntouched, ensureEdgeHistory, nodeName, treeOf } from "./edges";
import { treeCall } from "./engine";
import { panelJoin, toolTreeOf } from "./join";
import { panelOp } from "./ops";
import { paintReadout } from "./pick";
import { pullGuard } from "./pull";
import { answers, type Body, previews, shaped } from "./shared";
import { openPose, viewed } from "./view";

let probeSerial = 0;

/** A check the engine is running. The engine runs one call at a time, so a newer check waits for it, and only the newest. */
let probing = false;

const CYCLE = "The tool object's history already uses this part, so the two cannot be joined";

function publishProbe(view: ProbeView) {
  setModelProbe(view);
  if (view?.phase === "checking") return;
  if (view?.phase === "done" && view.located && view.located.length > 0) {
    showLocated(view.located.map((box) => boxUnder(box, openPose())));
    return;
  }
  showLocated(null);
}

export function showLocated(boxes: Bounds[] | null) {
  S.locatedNow = boxes && boxes.length > 0 ? boxes : null;
  fx.model?.setLocated(S.locatedNow);
  paintReadout();
}

export function frameLocated() {
  const box = S.locatedNow ? unionBox(S.locatedNow) : null;
  if (box) fx.model?.frame(box);
}

/**
 * Fillet, chamfer, hole, and boolean ask the kernel whether the edit works before Apply.
 * A number still being typed waits `wait` ms; a newer edit discards the older answer.
 * An answer already known for this node and numbers is used without asking.
 */
export function scheduleProbe(wait: number) {
  // --- P1: a face drag has its own probe. The panel's check must not cancel it. ---
  if (S.pullProbe) return;
  window.clearTimeout(S.probeTimer);
  S.pendingProbe = null;
  probeSerial += 1;
  const serial = probeSerial;
  const at = S.open;
  const tree = treeOf(at);
  const tool = openModelTool();
  const editable = !!viewed()?.editable;
  // --- P1: Push/Pull's panel probes like a face move. The gesture probes on its own. ---
  const op = editable && (isProbed(tool) || tool === "pushpull") && !editUntouched() ? panelOp() : null;
  const picked = editable ? joinPick() : null;
  if (at && tree && !op && picked) {
    // A tool Model never opened gets its tree first: the engine builds the join from it.
    publishProbe({ phase: "checking" });
    void readyTool(serial, picked);
    return;
  }
  if (!at || !tree || !op) {
    publishProbe(null);
    // P2. The edge drag draws its own preview. A panel with nothing to check must not clear it.
    if (!S.edgeDrag?.holding()) setModelPreview(null);
    return;
  }
  // P1. A distance no printer reaches, or a push through the part, is refused here, in its own words.
  const pulled = tool === "pushpull" ? pullGuard(op) : null;
  if (pulled) {
    publishProbe({ phase: "done", ok: false, error: pulled });
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
  const [treeKey, node] = S.lens ? [S.lens.key, S.lens.node] : [at.key, tree.current];
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
  S.pendingProbe = () => sendProbe(serial, key, treeKey, node, op);
  if (wait > 0) S.probeTimer = window.setTimeout(sendPending, wait);
  else sendPending();
}

/** A kernel answer's name: the node and the op. Whether a join keeps its tool on the plate changes no solid, so it is left out. */
export function probeName(key: string, node: NodeId, op: ModelOp): string {
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

/**
 * Send the newest check, unless one is still running: then it goes when that one answers, and a check made stale
 * meanwhile is never sent. Numbers typed field after field each asked the engine for a whole edit, one after another,
 * all but the last answered for nothing.
 */
export function sendPending() {
  const send = S.pendingProbe;
  if (!send || probing) return;
  S.pendingProbe = null;
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
  const view = probeFromBody(body, op.kind === "group" ? op.steps.length : undefined);
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

const PREVIEWS = 4;

/** A shape is meshed at a chord: kept by the answer's name and the chord it was asked at. */
function previewName(key: string): string {
  return `${key}@${state.stepTolerance}`;
}

export function keepPreview(key: string, shape: ParsedSolid) {
  const name = previewName(key);
  previews.delete(name);
  previews.set(name, shape);
  while (previews.size > PREVIEWS) previews.delete(previews.keys().next().value!);
}

/** The shape kept for an answer, the newest kept now; null when none is. */
export function previewOf(key: string): ParsedSolid | null {
  const shape = previews.get(previewName(key));
  if (shape) keepPreview(key, shape);
  return shape ?? null;
}

export function remember(key: string, view: ProbeView) {
  if (answers.size >= 256) {
    answers.clear();
    shaped.clear();
  }
  answers.set(key, view);
}
