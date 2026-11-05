/** Apply: the tool's op sent to the engine, the pull apply, and the message after. */
import { boxUnder } from "../../model-space";
import { decodeSolid, type ParsedSolid } from "../../model-reply";
import { locatedBoxes } from "../../model-check.ts";
import { splitNote } from "../../model-plane";
import {
  ROOT,
  childWithOp,
  opLabel,
  isEdgeStep,
  pathTo,
  reserveId,
  withChild,
  withNode,
  type ModelOp,
  type ModelTree,
  type NodeId,
} from "../../model-tree";
import { applyRequest, keepSketch } from "../../model-request";
import { storedEdgeStep } from "../../model-edge-step";
import { type PullMade } from "../../push-pull-ui";
import { closeModelTool, resetKeepTool } from "../../ui/model-chrome";
import { applyPluginsPanel, pluginsPanelOpen } from "../../ui/plugins-panel";
import { withoutObject } from "../../plate";
import { place } from "../files";
import { flushEdit, markModelEdit, noteEdit } from "../history";
import { closeSketchSession, holdSketchForApply } from "../sketch";
import { POINT_REFUSAL, holeSizeRefusal } from "../../sketch/holes.ts";
import { freshTreeKey, modelTrees } from "../model-trees";
import { applySelectedToState, syncPlateFromState } from "../plate-sync";
import { state } from "../state";
import { splitPrintOp, splitPrintOpen } from "../../ui/split-print.ts";
import {
  setTransitionWaiting,
  transitionApplied,
  transitionCardOp,
  transitionCardOpen,
} from "../../ui/transition-card.ts";
import { S } from "./shared";
import { addPiece, createSolid } from "./create";
import { nodeName, treeOf } from "./edges";
import { dropInEngine, isOp, missingToolOf, openWhole, post, text, treeCall } from "./engine";
import { splitState } from "./geometry";
import { followSelection } from "./lifecycle";
import { holeSizesNow, toolOp } from "./ops";
import { about, modelTool, readout } from "./pick";
import { probeName, remember, showLocated } from "./probe";
import { pullGuard } from "./pull";
import { runEdit } from "./run-edit";
import { type Body, BROKEN, NAMES_TOPOLOGY, readSolids, ROOT_BROKEN, seeds, solids } from "./shared";
import { applySplitPrint, updateSplitPrint } from "./split-apply";
import { resume, showNode } from "./tree";
import { syncUndo } from "./undo";
import { openPose, present } from "./view";

/** Parsed solids of recently shown nodes, so a jump back to one needs no engine call. */
const SOLID_CACHE = 4;

export function brokenOnPath(tree: ModelTree, node: NodeId) {
  return pathTo(tree, node).some((id) => tree.nodes.get(id)?.broken);
}

/** A failure reply goes to the readout. A node that did not rebuild is marked, with everything under it. */
export function failed(key: string, body: Body): boolean {
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

export function recentSolid(key: string, node: NodeId, chord: number): ParsedSolid | undefined {
  const name = `${nodeName(key, node)}@${chord}`;
  const solid = solids.get(name);
  if (solid) {
    solids.delete(name);
    solids.set(name, solid);
  }
  return solid;
}

export function keepSolid(key: string, node: NodeId, chord: number, solid: ParsedSolid) {
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

export async function applyTool() {
  const button = document.querySelector<HTMLButtonElement>("#modelApply");
  if (pluginsPanelOpen()) {
    if (button && !button.disabled) await applyPluginsPanel();
    return;
  }
  if (splitPrintOpen()) {
    const typed = splitPrintOp();
    if (!typed || !button || button.disabled) return;
    if (S.editing) await updateSplitPrint(S.editing, typed);
    else await applySplitPrint(typed);
    return;
  }
  if (transitionCardOpen()) {
    const typed = transitionCardOp();
    if (!typed || !button || button.disabled) return;
    setTransitionWaiting(true);
    try {
      if (S.editing) await runEdit(S.editing);
      else if (await applyOp(typed, typed.edges.length === 1 ? "Adding the print transition…" : `Adding ${typed.edges.length} print transitions…`)) transitionApplied();
    } finally {
      setTransitionWaiting(false);
    }
    return;
  }
  const tool = modelTool();
  if (S.editing) {
    if (button && !button.disabled) await runEdit(S.editing);
    return;
  }
  if (button && !button.disabled && tool === "create") {
    await createSolid();
    return;
  }
  if (!button || button.disabled || !S.open) return;
  const op = toolOp(tool);
  if (!op) {
    if (tool === "fillet" || tool === "chamfer") readout(tool === "fillet" ? "Pick an edge to fillet." : "Pick an edge to chamfer.");
    if (tool === "split") readout(splitNote(splitState()).text);
    if (tool === "hole" && S.sketchHoleDraft) readout(holeSizeRefusal(holeSizesNow()) ?? POINT_REFUSAL);
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
    // --- P1 ---
    faceExtrude: "Pulling the face…",
    moveFaces: "Pulling the face…",
  };
  const fromSketch = tool === "hole" && S.sketchHoleDraft != null;
  if (fromSketch) holdSketchForApply(true);
  let applied = false;
  try {
    applied = await applyOp(op, op.kind === "group" ? `Applying ${op.label}…` : working[op.kind] ?? "Editing the solid…");
  } finally {
    if (fromSketch) holdSketchForApply(false);
  }
  // Holes from a sketch are its feature: the sketch closes as it does after an extrude, so Undo then takes the holes back.
  if (applied && fromSketch) closeSketchSession();
}

/** Apply `op` to the shown node. The result is a new child, shown; the plate takes it on commit. */
export async function applyOp(op: ModelOp, working: string): Promise<boolean> {
  const at = S.open;
  const tree = treeOf(at);
  if (!at || !tree || S.busy || S.jumping || !state.mesh) return false;
  if (at.objectId !== state.plate.selectedId) {
    followSelection();
    return false;
  }
  S.parked = null;
  S.editBack = null;
  const parent = tree.current;
  const twin = childWithOp(tree, parent, op);
  if (twin != null) {
    // These numbers already built a step from here: show it rather than build it again.
    const shown = await showNode(S.ticket, at.objectId, at.key, twin, (solid) => appliedMessage(op, solid));
    if (shown) closeModelTool();
    if (shown && op.kind === "join" && !op.keepTool) takeOffPlate(op.tool.object);
    return shown;
  }
  // A new step placed by its numbers builds on the plate's STEP-read solid at once: rebuilding a long history first took
  // minutes (326 steps on the 2.6.1 back cover). A step that names edges or faces by the solid's numbering (a fillet, a
  // chamfer, a shell) still waits for the rebuilt step, since the read solid can number them apart and the step would
  // then build differently when the history is rebuilt.
  const onSeed = seeds.get(at.key)?.held.has(parent) === true && !NAMES_TOPOLOGY.has(op.kind);
  if (!onSeed && (seeds.has(at.key) || readSolids.has(at.solid))) {
    // A step the engine does not hold yet: the whole tree opens, and the step is shown as rebuilt.
    const mine = S.ticket;
    S.busy = true;
    syncUndo();
    readout("Rebuilding the steps…");
    const problem = seeds.has(at.key) ? await openWhole(at.key, parent) : null;
    if (mine === S.ticket) S.busy = false;
    syncUndo();
    if (mine !== S.ticket || state.stage !== "model") return false;
    if (problem) {
      readout(problem);
      return false;
    }
    if (!(await showNode(mine, at.objectId, at.key, parent, about))) {
      // The step no longer rebuilds: the view goes to the last one that does, and nothing is built.
      if (mine === S.ticket && state.stage === "model") await resume(mine, at.objectId, at.key, parent);
      return false;
    }
    // Edge and face numbers of the read solid may not be the rebuilt one's. A blend that names a step's
    // edges finds them again, and a closed shell names no face, so both go on.
    if (((op.kind === "fillet" || op.kind === "chamfer") && op.edges.some((edge) => !isEdgeStep(edge))) || (op.kind === "shell" && (op.openFaces?.length ?? 0) > 0)) {
      const what = op.kind === "shell" ? "faces" : "edges";
      readout(`${about(S.open!.solid)} The step was rebuilt from its history: pick the ${what} again.`);
      return false;
    }
    return applyOp(op, working);
  }
  const [reserved, node] = reserveId(tree);
  modelTrees.set(at.key, reserved);
  const pieceKey = op.kind === "split" ? freshTreeKey(`${at.objectId}-piece`) : null;
  const chord = state.stepTolerance;
  const mine = S.ticket;
  S.busy = true;
  syncUndo();
  readout(working);
  const body = await treeCall(at.key, parent, applyRequest(at.key, parent, node, op, chord, pieceKey));
  if (mine === S.ticket) S.busy = false;
  syncUndo();
  const latest = modelTrees.get(at.key);
  if (mine !== S.ticket || state.stage !== "model" || !latest) return false;
  if (failed(at.key, body)) return false;
  const parsed = decodeSolid(body);
  const other = !pieceKey ? null : body.other && typeof body.other === "object" ? decodeSolid(body.other as Body) : "The plane did not split this solid.";
  if (typeof parsed === "string" || typeof other === "string") {
    // The engine holds the step, and a split's piece tree, that this reply failed to describe.
    void dropInEngine(at.key, node);
    if (pieceKey) void post({ call: "close", key: pieceKey });
    readout(typeof parsed === "string" ? parsed : (other as string));
    return false;
  }
  // --- F1. The engine's echo has no sketch. Put the one this call sent back on the stored op. ---
  const stored = keepSketch(isOp(body.op) ? body.op : op, op);
  if (pieceKey && other && !addPiece(at, other, pieceKey, node)) {
    void dropInEngine(at.key, node);
    void post({ call: "close", key: pieceKey });
    readout("The other piece could not be added. The solid is unchanged.");
    return false;
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
  S.open = { ...at, solid: parsed };
  remember(probeName(at.key, node, op), { phase: "applied" });
  // The tree that names the tool is in place first, so the tool's tree stays for it once the object leaves.
  if (stored.kind === "join" && !stored.keepTool) takeOffPlate(stored.tool.object);
  if (stored.kind === "join") resetKeepTool();
  // Apply ends the tool: no ghost, panel or handles stay behind. Undo takes the step back, and the tool opens again on these numbers.
  closeModelTool();
  present(parsed, appliedMessage(stored, parsed));
  return true;
}

/** A join's tool leaves the plate, in the visit's one Prepare step, so Prepare undo puts it back with the edit. */
export function takeOffPlate(id: string) {
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
export function leavingNotes(scaled: boolean): string {
  const paint = state.supportPaint.length + state.seamPaint.length + state.reinforcement.length + state.supportEdits.length > 0;
  return `${paint ? " Leaving Model clears this part's support paint." : ""}${scaled && state.partScale !== 1 ? " Placement scale becomes 100%." : ""}`;
}

/** P1. Apply a face drag. The step just made is what Tab edits. Null when it was not kept. */
export async function applyPull(op: ModelOp): Promise<PullMade | null> {
  const at = S.open;
  const tree = treeOf(at);
  if (!at || !tree) return null;
  const said = pullGuard(op);
  if (said) {
    readout(said);
    return null;
  }
  const parent = tree.current;
  await applyOp(op, "Pulling the face…");
  const now = modelTrees.get(at.key);
  if (!now || now.current === parent || state.stage !== "model") return null;
  return { parent, node: now.current };
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
