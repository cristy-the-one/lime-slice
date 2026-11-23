/**
 * --- Organic surfaces S4: the plate's open sheets (the rule is in src/model-sheet.ts). Slice and Export stop on one;
 * Prepare marks it. Model registers these on `fx`, as it does `exportedPart`.
 */
import { SHEET_OBJECT_NOTE, sheetPartNote, treeIsSheet } from "../../model-sheet";
import { modelTrees } from "../model-trees";
import { state } from "../state";

/** The sentence Slice and Export stop with while a plate object is an open sheet, or null. */
export function sheetPart(): string | null {
  return sheetPartNote(state.plate.objects, (key) => modelTrees.get(key));
}

/** Prepare's note on a plate object that is an open sheet, or null. */
export function sheetObjectNote(objectId: string): string | null {
  const key = state.plate.objects.find((obj) => obj.id === objectId)?.modelTree;
  return key && treeIsSheet(modelTrees.get(key)) ? SHEET_OBJECT_NOTE : null;
}
