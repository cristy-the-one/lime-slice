/** The edge tool: the fillet/chamfer probe, apply, and its edit. */
import { matchEdges, replayChain } from "../../model-edit";
import { decodeSolid, type ParsedSolid } from "../../model-reply";
import { probeFromBody } from "../../model-feasibility";
import { type EdgeRef, type ModelOp, type NodeId } from "../../model-tree";
import { probeRequest } from "../../model-request";
import { modelCardOpen, openModelTool } from "../../ui/model-chrome";
import { rowKey } from "../../model-history";
import { plainModelError } from "../model-error";
import { sketchOccupiesView } from "../sketch";
import { state } from "../state";
import { stressPicking } from "../../ui/stress.ts";
import { S } from "./shared";
import { applyOp } from "./apply";
import { treeOf } from "./edges";
import { treeCall } from "./engine";
import { about } from "./pick";
import { runEdit } from "./run-edit";
import type { Body, Editing } from "./shared";
import { showNode } from "./tree";
import { syncUndo } from "./undo";
import { viewed } from "./view";

/** P2. The idle edge knob is armed when no other tool is using the view and the solid can be edited. */
export function edgeArmed(): boolean {
  // --- S2: the edge knob waits while a sketch is open. ---
  return state.stage === "model" && !openModelTool() && !modelCardOpen() && !stressPicking() && !sketchOccupiesView() && !(S.lens && !S.editing) && !!viewed()?.editable && !S.busy && !S.jumping;
}

/** P2. Dry-run a fillet or chamfer on the solid on screen. The shape is drawn by the drag, not by the panel. */
export async function probeEdge(op: ModelOp): Promise<{ ok: boolean; error: string; maxMm: number | null; shape: ParsedSolid | null }> {
  const at = S.open;
  const tree = treeOf(at);
  if (!at || !tree || state.stage !== "model") return { ok: false, error: "Nothing is open.", maxMm: null, shape: null };
  const node = S.editing?.edgeOp ? S.editing.parent : tree.current;
  const body = await treeCall(at.key, node, probeRequest(at.key, node, op, state.stepTolerance));
  const view = probeFromBody(body);
  if (view?.phase === "done" && view.ok) {
    const decoded = body.preview && typeof body.preview === "object" ? decodeSolid(body.preview as Body) : null;
    return { ok: true, error: "", maxMm: null, shape: decoded && typeof decoded !== "string" ? decoded : null };
  }
  if (view?.phase === "done") {
    return { ok: false, error: plainModelError(view.error ?? "This does not fit.", op.kind), maxMm: view.maxMm ?? null, shape: null };
  }
  return { ok: false, error: "This does not fit.", maxMm: null, shape: null };
}

/** P2. Apply the drag as a new step. The id of the step now showing, or null when it did not land. */
export async function applyEdge(op: ModelOp): Promise<number | null> {
  const before = treeOf(S.open)?.current ?? null;
  const count = op.kind === "fillet" || op.kind === "chamfer" ? (op.edges.length === 1 ? "the edge" : `${op.edges.length} edges`) : "";
  const working = op.kind === "chamfer" ? `Chamfering ${count}…` : `Filleting ${count}…`;
  await applyOp(op, working);
  const after = treeOf(S.open)?.current ?? null;
  return after != null && after !== before ? after : null;
}

/**
 * P2. Show the step's parent and hold an edit of `node`, without opening the fillet or chamfer panel.
 * Tab, for a few seconds after a drag, is what asks for this.
 */
export async function beginEdgeEdit(node: NodeId, op: ModelOp): Promise<boolean> {
  const at = S.open;
  const tree = treeOf(at);
  if (!at || !tree || state.stage !== "model" || S.busy || S.jumping) return false;
  if (S.editing && !S.editing.edgeOp) return false;
  const parent = tree.nodes.get(node)?.parent;
  if (parent == null || !tree.nodes.has(parent)) return false;
  const from = tree.current;
  const run: Editing = {
    key: at.key,
    target: at.key,
    row: rowKey([], node),
    joins: [],
    node,
    parent,
    from,
    replay: replayChain(tree, node, from),
    op,
    edgeOp: op,
    panel: null,
    opened: null,
  };
  S.editing = run;
  syncUndo();
  const shown = await showNode(S.ticket, at.objectId, at.key, parent, about);
  if (S.editing !== run || !shown) {
    if (S.editing === run) {
      S.editing = null;
      syncUndo();
    }
    return false;
  }
  return true;
}

/** P2. Replace the edited fillet or chamfer and replay what was under it. The id of the step now showing. */
export async function commitEdgeEdit(op: ModelOp): Promise<number | null> {
  const run = S.editing;
  if (!run?.edgeOp) return null;
  const before = treeOf(S.open)?.current ?? null;
  run.edgeOp = op;
  run.op = op;
  await runEdit(run);
  if (S.editing != null) return null;
  const after = treeOf(S.open)?.current ?? null;
  return after != null && after !== before ? after : null;
}

/** P2. The stored blend's edges as they are on the solid now showing. An earlier step's edges are left out. */
export function matchedEdgeIds(op: ModelOp): number[] {
  if (op.kind !== "fillet" && op.kind !== "chamfer") return [];
  const solid = viewed();
  if (!solid) return [];
  const refs = op.edges.filter((edge): edge is number | EdgeRef => typeof edge === "number" || !("fromNode" in edge));
  return matchEdges(solid.edges, refs, state.stepTolerance).picked;
}
