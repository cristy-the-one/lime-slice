import type { ModelOp } from "./model-tree.ts";

/**
 * A Split to print cut for an export target (not this FDM printer): its pieces stay in Model, off the plate. Its own
 * file so a project can be read without loading Split to print.
 */
export function exportsPieces(op: ModelOp | null | undefined): boolean {
  return op?.kind === "partition" && op.target !== undefined && op.target.process !== "fdm";
}
