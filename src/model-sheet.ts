/**
 * Organic surfaces S4: when the shape on screen is an open sheet the user BUILT, decided in one place.
 *
 * The kernel reports the shape: `editable` false when it holds no closed solid, `nakedEdges` for its open borders
 * (the viewport draws the same list). A STEP that opened as surfaces with no closed solid reports the same, but it is
 * an import, not a sheet anyone built: it opens, commits to the plate and slices as it did before sheets existed
 * (v7.1.2), with no banner and no gate. So a sheet is a non-editable shape with open borders that a step or a feature
 * root built: anything but the root node of a STEP import.
 */
import { ROOT, type ModelRoot, type ModelTree, type NodeId } from "./model-tree.ts";

export interface SheetShape {
  editable: boolean;
  faces: { length: number };
  nakedEdges?: readonly number[];
}

/** True when `shape`, shown at `node` of a tree with `root`, is an open sheet a step or a feature built. */
export function isOpenSheet(shape: SheetShape | null | undefined, root: Pick<ModelRoot, "kind"> | null | undefined, node: NodeId): boolean {
  if (!shape || shape.editable || shape.faces.length === 0 || (shape.nakedEdges?.length ?? 0) === 0) return false;
  // A STEP that opened as surfaces with no closed solid: an import, as on v7.1.2, not a built sheet.
  if (node === ROOT && root?.kind === "step") return false;
  return true;
}

/**
 * The rule for an open sheet that is a plate object (for every sheet kind: sheet, patch, blend, NURBS surface, as the
 * kernel answers, never by op kind):
 * - it is on the plate like any part, so it saves, reopens and thickens later, and its plate mesh follows Model;
 * - its committed node carries `sheet: true` (set from `isOpenSheet` on the kernel's reply when committed);
 * - Prepare marks it (`SHEET_OBJECT_NOTE`), and Slice and Export stop with `sheetPartNote` while one is on the plate.
 */
export const SHEET_OBJECT_NOTE = "Open sheet: not printed. Thicken or Cap & Sew it in Model to make a solid.";

/** True when a plate object's committed Model step is an open sheet. */
export function treeIsSheet(tree: Pick<ModelTree, "nodes" | "committed"> | null | undefined): boolean {
  return tree?.nodes.get(tree.committed)?.sheet === true;
}

/** The sentence Slice and Export stop with: the first plate object that is an open sheet, or null when none is. */
export function sheetPartNote(objects: readonly { name: string; modelTree?: string }[], treeOf: (key: string) => Pick<ModelTree, "nodes" | "committed"> | undefined): string | null {
  for (const obj of objects) {
    if (obj.modelTree && treeIsSheet(treeOf(obj.modelTree))) {
      return `${obj.name} is an open sheet, not a solid. Thicken or Cap & Sew it in Model before slicing or exporting.`;
    }
  }
  return null;
}
