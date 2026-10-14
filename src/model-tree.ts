/**
 * Model history as a tree, one per plate object: the ops, which branch Redo follows, the node the
 * view shows (`current`), and the node the plate holds (`committed`). The engine keeps the solids,
 * keyed by `key` and node id; this keeps what the client needs to hand them back.
 */
import { formatMm } from "./model-plane.ts";
import type { ReinforceRegion } from "./reinforcement.ts";
import type { SeamDisk } from "./seam-paint.ts";
import type { EditEntry } from "./support-edit-list.ts";
import type { PaintDisk } from "./support-paint.ts";

/** Given by the client, never reused in one tree. The root is 0. */
export type NodeId = number;
export type Vec3 = [number, number, number];

/** An edge as the engine stores it, so a rebuild can find it again after its index moves. */
export interface EdgeRef {
  index: number;
  mid: Vec3;
  lengthMm: number;
}

/** One edit, in the solid's own frame. A fresh fillet or chamfer names edges by index. */
export type ModelOp =
  | { kind: "boolean"; op: "fuse" | "cut" | "common"; primitive: "box" | "cylinder" | "sphere"; origin: Vec3; size: Vec3; radius: number; height: number; turn: Vec3 }
  | { kind: "hole"; origin: Vec3; axis: Vec3; radius: number; depth: number }
  | { kind: "split"; origin: Vec3; normal: Vec3 }
  | { kind: "fillet" | "chamfer"; edges: (number | EdgeRef)[]; size: number }
  | { kind: "scale"; factor: number };

export interface Fingerprint {
  volumeMm3: number;
  faces: number;
  edges: number;
}

/** The Prepare state that names one shape's surface. Saved when the plate leaves a node, put back when it returns. */
export interface PrepareKeep {
  supportEdits: EditEntry[];
  supportPaint: readonly PaintDisk[];
  seamPaint: readonly SeamDisk[];
  reinforcement: readonly ReinforceRegion[];
  partScale: number;
}

/** The plate's mesh for a node the plate has held. The buffers are shared, never copied. */
export interface PlateMesh {
  name: string;
  bytes: ArrayBuffer;
  sourcePos: Float32Array;
  /** `meshTokenOf(bytes)`. */
  token: string;
}

export interface ModelNode {
  id: NodeId;
  parent: NodeId | null;
  /** Null on the root. */
  op: ModelOp | null;
  label: string;
  fingerprint: Fingerprint | null;
  /** Why the engine could not rebuild this node. Nothing under it rebuilds either. */
  broken?: string;
  /** A split: the key of the tree its other piece roots. */
  piece?: string;
  keep?: PrepareKeep;
  mesh?: PlateMesh;
}

/** Where the root solid comes from: STEP bytes, or the piece a split cut off in another tree. */
export type ModelRoot = { kind: "step"; name: string; bytes: ArrayBuffer } | { kind: "piece"; tree: string; node: NodeId };

export interface ModelTree {
  key: string;
  root: ModelRoot;
  nodes: ReadonlyMap<NodeId, ModelNode>;
  nextId: NodeId;
  current: NodeId;
  committed: NodeId;
  /** The child Redo goes to from each node: the newest one applied or jumped through. */
  lastChild: ReadonlyMap<NodeId, NodeId>;
}

export const ROOT: NodeId = 0;

export function newTree(key: string, root: ModelRoot, label: string, fingerprint: Fingerprint | null): ModelTree {
  return {
    key,
    root,
    nodes: new Map([[ROOT, { id: ROOT, parent: null, op: null, label, fingerprint }]]),
    nextId: ROOT + 1,
    current: ROOT,
    committed: ROOT,
    lastChild: new Map(),
  };
}

/** A fresh id for the next Apply. Taken even if the Apply fails, so the engine never sees one id twice. */
export function reserveId(tree: ModelTree): [ModelTree, NodeId] {
  return [{ ...tree, nextId: tree.nextId + 1 }, tree.nextId];
}

/** The ids from the root down to `id`. Empty when `id` is not in the tree. */
export function pathTo(tree: ModelTree, id: NodeId): NodeId[] {
  const path: NodeId[] = [];
  for (let at = tree.nodes.get(id); at; at = at.parent === null ? undefined : tree.nodes.get(at.parent)) path.push(at.id);
  return path.reverse();
}

export function childrenOf(tree: ModelTree, id: NodeId): NodeId[] {
  return [...tree.nodes.values()].filter((node) => node.parent === id).map((node) => node.id).sort((a, b) => a - b);
}

/**
 * The result of an Apply on `parent`, now current. From a node that already has children this
 * starts a new branch; the old ones stay, and Redo from `parent` follows the new one.
 */
export function withChild(tree: ModelTree, parent: NodeId, child: Omit<ModelNode, "parent">): ModelTree {
  const nodes = new Map(tree.nodes);
  nodes.set(child.id, { ...child, parent });
  const lastChild = new Map(tree.lastChild);
  lastChild.set(parent, child.id);
  return { ...tree, nodes, lastChild, nextId: Math.max(tree.nextId, child.id + 1), current: child.id };
}

/** Show `id`. Redo from each node above it now leads back down to it. */
export function jumped(tree: ModelTree, id: NodeId): ModelTree {
  const path = pathTo(tree, id);
  if (path.length === 0) return tree;
  const lastChild = new Map(tree.lastChild);
  for (let i = 1; i < path.length; i += 1) lastChild.set(path[i - 1]!, path[i]!);
  return { ...tree, lastChild, current: id };
}

/** Where Undo goes: the parent. Null at the root. */
export function undoTarget(tree: ModelTree): NodeId | null {
  return tree.nodes.get(tree.current)?.parent ?? null;
}

/** Where Redo goes: the child last applied or jumped through. */
export function redoTarget(tree: ModelTree): NodeId | null {
  const next = tree.lastChild.get(tree.current);
  return next != null && tree.nodes.has(next) ? next : null;
}

export function withNode(tree: ModelTree, id: NodeId, patch: Partial<Omit<ModelNode, "id" | "parent">>): ModelTree {
  const node = tree.nodes.get(id);
  if (!node) return tree;
  const nodes = new Map(tree.nodes);
  nodes.set(id, { ...node, ...patch });
  return { ...tree, nodes };
}

/** `id` and every node under it. */
export function subtree(tree: ModelTree, id: NodeId): Set<NodeId> {
  const found = new Set<NodeId>(tree.nodes.has(id) ? [id] : []);
  for (const node of [...tree.nodes.values()].sort((a, b) => a.id - b.id)) {
    if (node.parent !== null && found.has(node.parent)) found.add(node.id);
  }
  return found;
}

/**
 * The tree without `id` and everything under it. Null for the root, or for a branch that holds the
 * node the view shows or the plate holds. Redo from the parent falls back to its newest other child.
 */
export function dropped(tree: ModelTree, id: NodeId): ModelTree | null {
  const node = tree.nodes.get(id);
  if (!node || node.parent === null) return null;
  const gone = subtree(tree, id);
  if (gone.has(tree.current) || gone.has(tree.committed)) return null;
  const nodes = new Map([...tree.nodes].filter(([key]) => !gone.has(key)));
  const lastChild = new Map([...tree.lastChild].filter(([from]) => !gone.has(from)));
  if (gone.has(lastChild.get(node.parent) ?? -1)) {
    const rest = [...nodes.values()].filter((other) => other.parent === node.parent).map((other) => other.id);
    if (rest.length > 0) lastChild.set(node.parent, Math.max(...rest));
    else lastChild.delete(node.parent);
  }
  return { ...tree, nodes, lastChild };
}

/** The node whose plate mesh is `token`: how a plate restored by Prepare undo finds its place in the tree. */
export function nodeWithMesh(tree: ModelTree, token: string): NodeId | null {
  for (const node of tree.nodes.values()) if (node.mesh?.token === token) return node.id;
  return null;
}

/** Every node but the root, parents first, as the engine's `open` registers them. */
export function savedNodes(tree: ModelTree): { id: NodeId; parent: NodeId; op: ModelOp; fingerprint: Fingerprint | null }[] {
  return [...tree.nodes.values()]
    .filter((node): node is ModelNode & { parent: NodeId; op: ModelOp } => node.parent !== null && node.op !== null)
    .sort((a, b) => a.id - b.id)
    .map((node) => ({ id: node.id, parent: node.parent, op: node.op, fingerprint: node.fingerprint }));
}

/**
 * What the plate does when it takes the shown node: null when it already holds it. `keep` is the
 * Prepare state saved for that node, or null when it has none, so its paint starts empty. Without a
 * saved state, a scale between the two nodes sets placement scale back to 100%, as Apply of a scale did.
 */
export interface VisitStep {
  from: NodeId;
  to: NodeId;
  keep: PrepareKeep | null;
  resetScale: boolean;
}

export function visitStep(tree: ModelTree): VisitStep | null {
  if (tree.current === tree.committed) return null;
  const keep = tree.nodes.get(tree.current)?.keep ?? null;
  return { from: tree.committed, to: tree.current, keep, resetScale: keep === null && scaleBetween(tree, tree.committed, tree.current) };
}

/** Whether a scale op lies on the way from `a` to `b`, through the node both descend from. */
export function scaleBetween(tree: ModelTree, a: NodeId, b: NodeId): boolean {
  const up = new Set(pathTo(tree, a));
  const down = pathTo(tree, b);
  const common = [...down].reverse().find((id) => up.has(id)) ?? ROOT;
  const below = (path: NodeId[]) => path.slice(path.indexOf(common) + 1);
  return [...below(pathTo(tree, a)), ...below(down)].some((id) => tree.nodes.get(id)?.op?.kind === "scale");
}

const BOOLEAN_VERB = { fuse: "Fuse", cut: "Cut", common: "Intersect" } as const;

/** A short name for the step, for the history list. */
export function opLabel(op: ModelOp): string {
  const n = formatMm;
  switch (op.kind) {
    case "boolean": {
      const shape =
        op.primitive === "box"
          ? `box ${n(op.size[0])}×${n(op.size[1])}×${n(op.size[2])}`
          : op.primitive === "cylinder"
            ? `cylinder r ${n(op.radius)} h ${n(op.height)}`
            : `sphere r ${n(op.radius)}`;
      return `${BOOLEAN_VERB[op.op]} ${shape}`;
    }
    case "hole":
      return `Hole r ${n(op.radius)} depth ${n(op.depth)}`;
    case "split":
      return `Split at Z ${n(op.origin[2])}`;
    case "fillet":
    case "chamfer": {
      const count = op.edges.length === 1 ? "1 edge" : `${op.edges.length} edges`;
      return `${op.kind === "fillet" ? "Fillet" : "Chamfer"} ${count} ${op.kind === "fillet" ? "r " : ""}${n(op.size)}`;
    }
    case "scale":
      return `Scale ${n(op.factor * 100)} %`;
  }
}
