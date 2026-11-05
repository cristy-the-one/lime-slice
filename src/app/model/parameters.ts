/** Parameters: the table's params, what they affect, and the rebuild they run. */
import { decodeSolid, type ParsedSolid } from "../../model-reply";
import { pathTo, type ModelOp, type ModelTree, type NodeId } from "../../model-tree";
import { gotoRequest } from "../../model-request";
import { panelExprs } from "../../ui/model-chrome";
import { rowKey } from "../../model-history";
import { session, state } from "../state";
import type { Params } from "../../modeling/expr.ts";
import { appParamMessage, evaluateTable, usedByCount } from "../../modeling/params.ts";
import { outOfDateSteps, planRebuild } from "../../param-rebuild.ts";
import { syncParameters } from "../../ui/parameters.ts";
import { S } from "./shared";
import { keepSolid, recentSolid } from "./apply";
import { treeOf } from "./edges";
import { text, treeCall } from "./engine";
import { readout } from "./pick";
import { runEdit } from "./run-edit";
import { type Editing, readSolids, VIEW_ONLY } from "./shared";
import { syncUndo } from "./undo";
import { openPose } from "./view";

/** Evaluated parameters. Later names see earlier ones, as `mergeParams` does. */
export function currentParams(): Params {
  return evaluateTable(session.parameters).values;
}

/**
 * The history or the table changed (a rebuild, an undo, a redo, a jump, a file): the Parameters panel and its
 * Rebuild count follow. A step is out of date when a stored number differs from its expression at the table, so
 * nothing needs to remember which table the numbers were built at.
 */
export function noteParametersBuilt() {
  syncParameters();
}

export function withPanelExprs(op: ModelOp): ModelOp {
  const exprs = panelExprs();
  if (exprs) return { ...op, exprs };
  if (!op.exprs) return op;
  const { exprs: _drop, ...rest } = op;
  return rest;
}

export function usedByName(name: string): number {
  const tree = treeOf(S.open);
  if (!tree) return 0;
  const path = pathTo(tree, tree.current);
  const rootOnPath = path.some((id) => tree.nodes.get(id)?.op?.kind === "root");
  const ops = path.map((id) => tree.nodes.get(id)?.op ?? null);
  const rootExprs = !rootOnPath && tree.root.kind === "primitive" ? tree.root.exprs : null;
  return usedByCount(name, ops, rootExprs);
}

/** History steps on the shown branch whose stored numbers no longer match the parameter table. */
export function affectedNodeIds(): NodeId[] {
  const tree = treeOf(S.open);
  return tree ? outOfDateSteps(tree, currentParams()) : [];
}

/**
 * --- D21. The solid a feature step was built on, which its re-expansion reads: kept, on screen, or asked of the engine
 * (`goto`), as after a reopen, when only the shown step is kept. A string is why the engine could not give it.
 */
async function builtOn(tree: ModelTree, parent: NodeId): Promise<ParsedSolid | string> {
  const chord = state.stepTolerance;
  const kept = recentSolid(tree.key, parent, chord) ?? (S.open?.key === tree.key && S.open.solid.id === parent ? S.open.solid : null);
  if (kept) return kept;
  const body = await treeCall(tree.key, parent, gotoRequest(tree.key, parent, chord));
  const error = text(body.error);
  if (error) return error;
  const decoded = decodeSolid(body);
  if (typeof decoded === "string") return decoded;
  if (body.seeded) readSolids.add(decoded);
  keepSolid(tree.key, parent, chord, decoded);
  return decoded;
}

export async function rebuildFromParameters() {
  if (S.rebuilding) return;
  S.rebuilding = true;
  try {
    await rebuildNow();
  } finally {
    S.rebuilding = false;
  }
}

async function rebuildNow() {
  const at = S.open;
  const tree = treeOf(at);
  if (!at || !tree || S.busy || S.jumping || state.stage !== "model") return;
  if (!at.solid.editable) {
    readout(VIEW_ONLY);
    return;
  }
  const from = tree.current;
  const plan = await planRebuild(tree, { ...currentParams() }, {
    pose: openPose(),
    builtOn: (parent) => builtOn(tree, parent),
    current: () => at === S.open && state.stage === "model" && treeOf(at)?.current === from,
  });
  if (plan === "stale") return;
  if (plan === null) {
    noteParametersBuilt();
    return;
  }
  if ("error" in plan) {
    readout(appParamMessage(plan.error));
    return;
  }
  const { node: earliest, parent, replay, supplied } = plan;
  const run: Editing = {
    key: at.key,
    target: at.key,
    row: rowKey([], earliest),
    joins: [],
    node: earliest,
    parent,
    from,
    replay,
    op: supplied[0]!,
    panel: null,
    opened: null,
    supplied,
  };
  S.editing = run;
  syncUndo();
  const back = S.editBack;
  await runEdit(run);
  if (S.editing === run) {
    S.editing = null;
    syncUndo();
    return;
  }
  if (S.editBack !== back) noteParametersBuilt();
}
