/** One Model history tree per plate object, by the key the object carries (`PlateObject.modelTree`) and the engine uses. */
import type { ModelTree } from "../model-tree";

export const modelTrees = new Map<string, ModelTree>();

/** A serve process outlives a page reload, so keys from an earlier page must not come back. */
const page = Math.random().toString(36).slice(2, 8);
let seq = 0;

export function freshTreeKey(objectId: string): string {
  seq += 1;
  return `${objectId}#${page}.${seq}`;
}
