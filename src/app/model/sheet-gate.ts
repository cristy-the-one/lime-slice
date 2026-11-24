/**
 * --- Organic surfaces S4: Model's side of the sheet rule (src/model-sheet.ts): the verdict a mesh carries when Model
 * puts it on the plate.
 */
import { sheetVerdict, type SheetShape } from "../../model-sheet";
import { withSheet } from "../../plate";
import { state } from "../state";

/** The plate object `id` takes the verdict of the mesh Model just put on it (`PlateMesh.sheet`; undefined keeps it). */
export function markSheet(id: string, sheet: boolean | undefined) {
  state.plate = withSheet(state.plate, id, sheet);
}

/** The verdict a mesh made from this kernel reply carries. */
export function meshSheet(shape: SheetShape): { sheet: boolean } {
  return { sheet: sheetVerdict(shape) };
}
