/** Joining a tool object into the open part: its tree, the join op, and what the card says about it. */
import { ROOT, nodeWithMesh, type ModelOp, type NodeId } from "../../model-tree";
import { joinOp } from "../../model-request";
import { joinPick } from "../../ui/model-chrome";
import { meshTokenOf, modelPoseOf, type PlateObject } from "../../plate";
import { livePlate } from "../files";
import { state } from "../state";
import { S } from "./shared";
import { boolOp } from "./ops";
import { readout } from "./pick";
import { surfacesOnly, toolOpens } from "./shared";
import { rootSource, startTree, stepOfCopy, treeFor } from "./tree";
import { objectPose } from "./view";

/** The step of its tree that `obj` holds on the plate, as a join's tool, opening that tree first if Model never did. */
export function toolTreeOf(obj: PlateObject): Promise<{ key: string; node: NodeId } | string> {
  const token = meshTokenOf(obj.bytes);
  const tree = treeFor(obj.id, obj.modelTree, token);
  const node = tree ? nodeWithMesh(tree, token) : null;
  if (tree && node != null) return Promise.resolve({ key: tree.key, node });
  let pending = toolOpens.get(obj.id);
  if (!pending) {
    pending = openToolTree(obj).finally(() => toolOpens.delete(obj.id));
    toolOpens.set(obj.id, pending);
  }
  return pending;
}

async function openToolTree(obj: PlateObject): Promise<{ key: string; node: NodeId } | string> {
  let source = rootSource(obj);
  if (!source) return `${obj.name} is a mesh, so it cannot be a tool.`;
  if ("copies" in source) {
    const step = await stepOfCopy(source);
    if (typeof step === "string") return step;
    source = step;
  }
  const started = await startTree(obj.id, obj.name, source.from, source.mesh);
  if (typeof started === "string") return started;
  return started.parsed.editable ? { key: started.key, node: ROOT } : `${obj.name} has surfaces but no closed solid, so it cannot be a tool.`;
}

/** Whether `obj` can be a join's tool: a solid, or a STEP or a copy that opens as one. Never a mesh, nor surfaces. */
export function solidObject(obj: PlateObject): boolean {
  const token = meshTokenOf(obj.bytes);
  if (surfacesOnly.has(token)) return false;
  return treeFor(obj.id, obj.modelTree, token) != null || rootSource(obj) != null;
}

/**
 * The join the panel describes, in the open solid's own frame: the tool's step as the plate holds it, and its pose in
 * the solid's frame, worked out here, once, so moving either object later moves no cut already made. Null until a tool
 * is picked and has a tree.
 */
export function panelJoin(): ModelOp | null {
  const id = joinPick();
  const obj = id ? livePlate().find((item) => item.id === id) : undefined;
  if (!S.open || !obj) return null;
  const token = meshTokenOf(obj.bytes);
  const tree = treeFor(obj.id, obj.modelTree, token);
  const node = tree ? nodeWithMesh(tree, token) : null;
  if (!tree || node == null) return null;
  const keepTool = document.querySelector<HTMLInputElement>("#modelKeepTool")?.checked ?? false;
  return joinOp(boolOp(), { object: obj.id, key: tree.key, node, name: obj.name }, objectPose(), modelPoseOf(obj), keepTool);
}

/** The readout says what the join will do, each time that changes: "Cut telo split from telo.stp; telo split leaves the plate." */
export function sayJoin() {
  const id = joinPick();
  const tool = id ? state.plate.objects.find((item) => item.id === id)?.name : undefined;
  const target = S.open ? state.plate.objects.find((item) => item.id === S.open!.objectId)?.name : undefined;
  if (!tool || !target) {
    S.joinSaid = "";
    return;
  }
  const keep = document.querySelector<HTMLInputElement>("#modelKeepTool")?.checked ?? false;
  const what = { fuse: `Fuse ${tool} into ${target}`, cut: `Cut ${tool} from ${target}`, common: `Intersect ${target} with ${tool}` }[boolOp()];
  const said = `${what}; ${tool} ${keep ? "stays on" : "leaves"} the plate.`;
  if (said === S.joinSaid) return;
  S.joinSaid = said;
  readout(said);
}
