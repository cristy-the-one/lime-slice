/**
 * Organic surfaces S4: when the shape on screen is an open sheet the user BUILT, decided in one place.
 *
 * The kernel reports the shape: `editable` false when it holds no closed solid, `nakedEdges` for its open borders
 * (the viewport draws the same list). A STEP that opened as surfaces with no closed solid reports the same, but it is
 * an import, not a sheet anyone built: it opens, commits to the plate and slices as it did before sheets existed
 * (v7.1.2), with no banner and no gate. So a sheet is a non-editable shape with open borders that a step or a feature
 * root built: anything but the root node of a STEP import.
 */
import { ROOT, type ModelRoot, type NodeId } from "./model-tree.ts";

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

/** Why an open sheet does not go to the plate: the toast each gate shows. */
export const SHEET_NOT_PRINTABLE = "This part is an open sheet. Thicken or Cap & Sew it into a solid before slicing.";
