/**
 * The body of a saved Model tree, without its root, as a project file carries it. Kept apart from ./model-tree-file.ts
 * (which re-exports these) so opening and saving a project, which load with the app, do not load the tree readers.
 */
import type { SavedTreeBody } from "./model-tree-file.ts";

/** The tree without its root, to give it another. `rootExprs` rides along when the primitive has any. */
export function treeBody({ nodes, current, committed, nextId, rootExprs }: SavedTreeBody): SavedTreeBody {
  return { nodes, current, committed, nextId, ...(rootExprs && Object.keys(rootExprs).length > 0 ? { rootExprs } : {}) };
}

/** The objects whose trees a saved tree's joins take a tool from. */
export function savedToolObjects(saved: SavedTreeBody): Set<string> {
  return new Set(saved.nodes.flatMap((node) => (node.op?.kind === "join" ? [node.op.tool.object] : [])));
}
