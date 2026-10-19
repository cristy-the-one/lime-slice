/**
 * A fillet or chamfer that takes the edges an earlier step made.
 * The panel is either the edges picked on the solid, or one step and a filter.
 * `src/model-request.ts` `stepEdges` is the pick the engine stores.
 */
import { isEdgeStep, type EdgeFilter, type EdgePick, type ModelOp, type NodeId } from "./model-tree.ts";

export type EdgeSource = "picked" | "step";

const FILTERS: readonly EdgeFilter[] = ["all", "convex", "concave"];

export function isEdgeFilter(value: unknown): value is EdgeFilter {
  return FILTERS.includes(value as EdgeFilter);
}

/** The panel line for a step pick: "Edges of: Roof (convex)". */
export function edgeOfText(row: string, filter: EdgeFilter): string {
  return `Edges of: ${row} (${filter})`;
}

/**
 * The one step a stored blend took every edge from. Null when an edge was picked on the solid, or the
 * picks name more than one step: the panel edits one step at a time.
 */
export function storedEdgeStep(edges: readonly EdgePick[]): { fromNode: NodeId; filter: EdgeFilter } | null {
  if (edges.length === 0 || edges.some((edge) => !isEdgeStep(edge))) return null;
  const first = edges[0]!;
  if (!isEdgeStep(first)) return null;
  const filter = first.filter ?? "all";
  const one = edges.every((edge) => isEdgeStep(edge) && edge.fromNode === first.fromNode && (edge.filter ?? "all") === filter);
  return one ? { fromNode: first.fromNode, filter } : null;
}

/**
 * While a saved solid stands in for step `plate`, the engine numbers that step 0. A blend's `fromNode` is renamed
 * the same way the call's `node` is, and left as it is otherwise. Other ops are returned as given.
 */
export function remapBlendFromNode(op: ModelOp, local: (id: NodeId) => NodeId): ModelOp {
  if (op.kind === "fillet" || op.kind === "chamfer") {
    if (!op.edges.some(isEdgeStep)) return op;
    return { ...op, edges: op.edges.map((edge) => (isEdgeStep(edge) ? { ...edge, fromNode: local(edge.fromNode) } : edge)) };
  }
  if (op.kind === "group") {
    let changed = false;
    const steps = op.steps.map((step) => {
      const next = remapBlendFromNode(step, local);
      if (next !== step) changed = true;
      return next;
    });
    return changed ? { ...op, steps } : op;
  }
  return op;
}
