/** Step edges: the blend target, the outline of a step's edges, and their engine history. */
import { ROOT, pathTo, type ModelTree, type NodeId } from "../../model-tree";
import { gotoRequest, stepEdgesRequest } from "../../model-request";
import {
  openModelTool,
  edgeFilterChoice,
  edgeMode,
  edgeStepId,
  edgeStepKnown,
  setEdgeStep,
  setStepEdgeIndexes,
  stepEdgesOnSolid,
} from "../../ui/model-chrome";
import { rowStep, stepLabel, type RowKey } from "../../model-history";
import { fx } from "../fx";
import { modelTrees } from "../model-trees";
import { state } from "../state";
import { S } from "./shared";
import { noteHeld, openWhole, post, text, treeCall } from "./engine";
import { editOp } from "./ops";
import { readout } from "./pick";
import { type Opened, seeds } from "./shared";

/** While a step is edited: its panel still says the step as it is, so Update would change nothing and no check is needed. */
export function editUntouched(): boolean {
  const run = S.editing;
  return !!run && (run.opened == null || JSON.stringify(editOp(run)) === run.opened);
}

export function treeOf(at: Opened | null): ModelTree | null {
  return at ? modelTrees.get(at.key) ?? null : null;
}

/**
 * --- A5. The solid a blend is built on: the edited step's parent, a tool's step on screen, or the open solid's
 * current step. Edges may come from that step or one above it.
 */
export function blendTarget(): { key: string; node: NodeId; tree: ModelTree } | null {
  if (S.editing) {
    const tree = modelTrees.get(S.editing.key);
    return tree ? { key: S.editing.key, node: S.editing.parent, tree } : null;
  }
  const at = S.open;
  const tree = treeOf(at);
  if (!at || !tree) return null;
  if (S.lens) {
    const shown = modelTrees.get(S.lens.key);
    return shown ? { key: S.lens.key, node: S.lens.node, tree: shown } : null;
  }
  return { key: at.key, node: tree.current, tree };
}

/** The step on screen and the steps above it, root first, as the step list shows them. */
export function edgeStepChoices(): { id: number; label: string }[] {
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
export function takeEdgeStep(row: RowKey): boolean {
  const tool = openModelTool();
  if ((tool !== "fillet" && tool !== "chamfer") || edgeMode() !== "step") return false;
  const at = S.open;
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
export function paintBlendHighlight() {
  const tool = openModelTool();
  if ((tool === "fillet" || tool === "chamfer") && edgeMode() === "step") {
    fx.model?.highlight(stepEdgesOnSolid().map((index) => ({ kind: "edge", index })));
    return;
  }
  fx.model?.highlight(S.picks);
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
export function ensureEdgeHistory(key: string, viewed: NodeId, steps: readonly NodeId[]): Promise<string | null> {
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
export async function refreshStepEdges() {
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
export function nodeName(key: string, node: NodeId) {
  return `${key}#${node}`;
}
