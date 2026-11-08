/** Read the solid matching the plate mesh for a Pose face pick, without opening Model or changing the plate. */
import { solidFileName } from "../../brep-file.ts";
import { decodeSolid, type ParsedSolid } from "../../model-reply.ts";
import { gotoRequest, openRequest } from "../../model-request.ts";
import { nodeWithMesh } from "../../model-tree.ts";
import { meshTokenOf, type PlateObject } from "../../plate.ts";
import { modelTrees } from "../model-trees.ts";
import { state } from "../state.ts";
import { recentSolid } from "./apply.ts";
import { post, treeCall } from "./engine.ts";

let serial = 0;
export async function poseSolid(object: PlateObject): Promise<ParsedSolid | string | null> {
  const tree = object.modelTree ? modelTrees.get(object.modelTree) : undefined;
  const node = tree ? nodeWithMesh(tree, meshTokenOf(object.bytes)) : null;
  if (tree && node != null) {
    const cached = recentSolid(tree.key, node, state.stepTolerance);
    if (cached) return cached;
    return decodeSolid(await treeCall(tree.key, node, gotoRequest(tree.key, node, state.stepTolerance)));
  }
  const bytes = object.brep ?? (/\.(step|stp)$/i.test(object.fileName) ? object.bytes : null);
  if (!bytes) return null;
  const key = `pose-pick-${++serial}`;
  try {
    return decodeSolid(await post(openRequest(key, { kind: "step", name: solidFileName(object.fileName, bytes), bytes }, state.stepTolerance)));
  } finally {
    void post({ call: "close", key });
  }
}
