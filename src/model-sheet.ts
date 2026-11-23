/**
 * Organic surfaces S4: what is an open sheet, decided in one place, from what the kernel reports.
 *
 * The kernel reports the shape: `editable` false when it holds no closed solid, `nakedEdges` for its open borders.
 * `sheetVerdict` is that verdict. A STEP that opened as surfaces with no closed solid reports the same, but it is an
 * import, not a sheet anyone built: it opens, commits to the plate and slices as it did before sheets existed (v7.1.2),
 * with no banner, no badge, no sheet look and no gate. So `isOpenSheet` is the verdict on anything but the root of a
 * STEP import, unless that plate object is already marked a sheet (a sheet object duplicated, or saved and reopened
 * from its STEP, opens with a STEP root and must stay a sheet).
 *
 * The rule for a sheet on the plate (every sheet kind: sheet, patch, blend, NURBS surface; never decided by op kind):
 * - the object is on the plate like any part, so it saves, reopens and thickens later, and its plate mesh follows Model;
 * - the object carries `sheet: true` (`PlateObject.sheet`), set from the verdict wherever Model puts a mesh on the plate
 *   (`PlateMesh.sheet` -> `withSheet`), carried by Duplicate and Split shells, saved in the project;
 * - Prepare marks the row (`SHEET_OBJECT_NOTE`), and Slice, the plate's 3MF, the pose export and a Stress slice stop
 *   with `sheetPartNote` while a marked object is on the plate.
 */
import type { ModelRoot, NodeId } from "./model-tree.ts";

/** `ROOT` in src/model-tree.ts, kept here so the always-loaded gates do not load the tree module. */
const ROOT: NodeId = 0;

export interface SheetShape {
  editable: boolean;
  faces: { length: number };
  nakedEdges?: readonly number[];
}

/** The kernel's verdict: no closed solid, and open borders. */
export function sheetVerdict(shape: SheetShape | null | undefined): boolean {
  return !!shape && !shape.editable && shape.faces.length > 0 && (shape.nakedEdges?.length ?? 0) > 0;
}

/**
 * True when `shape`, shown at `node` of a tree with `root`, is an open sheet: the verdict, except at the root of a
 * STEP import (surfaces only, as on v7.1.2) unless the plate object is `marked` a sheet already.
 */
export function isOpenSheet(shape: SheetShape | null | undefined, root: Pick<ModelRoot, "kind"> | null | undefined, node: NodeId, marked = false): boolean {
  return sheetAt(sheetVerdict(shape), root, node, marked);
}

/** `isOpenSheet` from a verdict already taken (a History row reads the one its node keeps, `ModelNode.sheet`). */
export function sheetAt(verdict: boolean | undefined, root: Pick<ModelRoot, "kind"> | null | undefined, node: NodeId, marked = false): boolean {
  if (verdict !== true) return false;
  if (node === ROOT && root?.kind === "step" && !marked) return false;
  return true;
}

/** Prepare's note on a plate object marked a sheet. */
export const SHEET_OBJECT_NOTE = "Open sheet: not printed. Thicken or Cap & Sew it in Model to make a solid.";

/** The sentence Slice and Export stop with: the first plate object marked a sheet, or null when none is. */
export function sheetPartNote(objects: readonly { name: string; sheet?: true }[]): string | null {
  const sheet = objects.find((obj) => obj.sheet === true);
  return sheet ? `${sheet.name} is an open sheet, not a solid. Thicken or Cap & Sew it in Model before slicing or exporting.` : null;
}
