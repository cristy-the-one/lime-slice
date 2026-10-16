/**
 * Model history as a tree, one per plate object: the ops, which branch Redo follows, the node the
 * view shows (`current`), and the node the plate holds (`committed`). The engine keeps the solids,
 * keyed by `key` and node id; this keeps what the client needs to hand them back.
 */
import { formatMm, splitLabel } from "./model-plane.ts";
import { primitiveLabel, type PrimitiveSpec } from "./model-primitive.ts";
import type { Affine } from "./model-space.ts";
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

/**
 * The solid a join takes from another plate object: that object's id, its name when the join was applied (so a later
 * rename never renames the step), and the step of its tree it held then, by the tree's engine key.
 */
export interface JoinTool {
  object: string;
  key: string;
  node: NodeId;
  name: string;
}

export type BooleanKind = "fuse" | "cut" | "common";

/** A join between two objects' trees: this tree's solid with `tool`'s step, placed by `relative`. */
export type JoinOp = Extract<ModelOp, { kind: "join" }>;

/** One edit, in the solid's own frame. A fresh fillet or chamfer names edges by index. */
export type ModelOp =
  | ({ kind: "boolean"; op: BooleanKind } & PrimitiveSpec)
  | HoleOp
  | { kind: "split"; origin: Vec3; normal: Vec3 }
  | { kind: "fillet" | "chamfer"; edges: (number | EdgeRef)[]; size: number }
  | { kind: "scale"; factor: number }
  /** Another object's solid at `tool`, placed by `relative`: its pose in this solid's own frame, worked out once at Apply. */
  | { kind: "join"; op: BooleanKind; tool: JoinTool; relative: Affine; keepTool: boolean }
  /** A new solid's primitive built again from other numbers, in place of the solid above: an edited root, right under the root. */
  | ({ kind: "root" } & PrimitiveSpec);

/**
 * A hole into `axis` from `origin`. `through` cuts to wherever the part ends, worked out by the engine from the solid it
 * is cut from, so `depth` stays only for the panel. A counterbore is a wider, shallow bore at the entry: both its fields,
 * or neither. The newer fields are absent when off, so an older op, file and probe key read as before.
 */
export interface HoleOp {
  kind: "hole";
  origin: Vec3;
  axis: Vec3;
  radius: number;
  depth: number;
  through?: true;
  counterboreRadius?: number;
  counterboreDepth?: number;
}

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
  /** The node's STEP, once written. The plate object carries it as `brep` while it holds this node. */
  step?: ArrayBuffer;
}

export interface ModelNode {
  id: NodeId;
  parent: NodeId | null;
  /** Null on the root. */
  op: ModelOp | null;
  label: string;
  /** The user's name for the step, shown instead of `label`. */
  name?: string;
  fingerprint: Fingerprint | null;
  /** Why the engine could not rebuild this node. Nothing under it rebuilds either. */
  broken?: string;
  /** A split: the key of the tree its other piece roots. */
  piece?: string;
  keep?: PrepareKeep;
  mesh?: PlateMesh;
}

/** Where the root solid comes from: STEP bytes, a primitive built from its numbers, or the piece a split cut off in another tree. */
export type ModelRoot =
  | { kind: "step"; name: string; bytes: ArrayBuffer }
  | { kind: "primitive"; solid: PrimitiveSpec }
  | { kind: "piece"; tree: string; node: NodeId };

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
 * node the view shows or the plate holds, a node the plate held (a Prepare undo can put its mesh
 * back), or a split whose piece roots a tree of its own. Redo from the parent falls back to its
 * newest other child.
 */
export function dropped(tree: ModelTree, id: NodeId): ModelTree | null {
  const node = tree.nodes.get(id);
  if (!node || node.parent === null) return null;
  const gone = subtree(tree, id);
  if (gone.has(tree.current) || gone.has(tree.committed)) return null;
  if ([...gone].some((at) => tree.nodes.get(at)?.mesh || tree.nodes.get(at)?.piece)) return null;
  const nodes = new Map([...tree.nodes].filter(([key]) => !gone.has(key)));
  const lastChild = new Map([...tree.lastChild].filter(([from]) => !gone.has(from)));
  if (gone.has(lastChild.get(node.parent) ?? -1)) {
    const rest = [...nodes.values()].filter((other) => other.parent === node.parent).map((other) => other.id);
    if (rest.length > 0) lastChild.set(node.parent, Math.max(...rest));
    else lastChild.delete(node.parent);
  }
  return { ...tree, nodes, lastChild };
}

/**
 * The child of `parent` that `op` already built, so an Apply of the same numbers jumps to it instead
 * of building it again. A stored edge matches a fresh pick by index.
 */
export function childWithOp(tree: ModelTree, parent: NodeId, op: ModelOp): NodeId | null {
  const want = canonical(op);
  for (const id of childrenOf(tree, parent)) {
    const node = tree.nodes.get(id);
    if (node?.op && !node.broken && canonical(node.op) === want) return id;
  }
  return null;
}

function canonical(op: ModelOp): string {
  const plain = op.kind === "fillet" || op.kind === "chamfer" ? { ...op, edges: op.edges.map((edge) => (typeof edge === "number" ? edge : edge.index)) } : op;
  return JSON.stringify(plain, (_, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value,
  );
}

/** The node whose plate mesh is `token`: how a plate restored by Prepare undo finds its place in the tree. */
export function nodeWithMesh(tree: ModelTree, token: string): NodeId | null {
  for (const node of tree.nodes.values()) if (node.mesh?.token === token) return node.id;
  return null;
}

/** A plate object as the plate or a Prepare step holds it: its id, its tree's key if it has one, and its mesh. */
export interface TreeRef {
  id: string;
  key?: string;
  token?: string;
}

/**
 * The trees still in use, found as Model finds them: the tree an object names; a tree of that object
 * with a step whose plate mesh it holds (after a Prepare undo to before it had a key); for an object
 * that names no tree, any tree with its mesh (a copy finding the step it copies); and from each, the
 * tree its piece was split from, the trees of the pieces its splits made, and the trees its joins take a tool from,
 * which stay as long as a join names them, on the plate or not.
 */
export function reachableTrees(trees: ReadonlyMap<string, ModelTree>, refs: Iterable<TreeRef>): Set<string> {
  const queue: string[] = [];
  const holds = (tree: ModelTree, token: string) => [...tree.nodes.values()].some((node) => node.mesh?.token === token);
  for (const ref of refs) {
    if (ref.key) queue.push(ref.key);
    if (!ref.token) continue;
    for (const tree of trees.values()) {
      if ((!ref.key || tree.key.startsWith(`${ref.id}#`)) && holds(tree, ref.token)) queue.push(tree.key);
    }
  }
  const keep = new Set<string>();
  for (let key = queue.pop(); key !== undefined; key = queue.pop()) {
    const tree = trees.get(key);
    if (!tree || keep.has(key)) continue;
    keep.add(key);
    if (tree.root.kind === "piece") queue.push(tree.root.tree);
    for (const node of tree.nodes.values()) {
      if (node.piece) queue.push(node.piece);
      if (node.op?.kind === "join") queue.push(node.op.tool.key);
    }
  }
  return keep;
}

/** The trees the joins of `tree` take a tool from. */
export function toolKeys(tree: ModelTree): Set<string> {
  const keys = new Set<string>();
  for (const node of tree.nodes.values()) if (node.op?.kind === "join") keys.add(node.op.tool.key);
  return keys;
}

/**
 * Whether tree `from`, or a tree its joins take a tool from, at any depth, is tree `key`. Such a tool would tie two
 * histories that each name the other, so neither could ever be closed, nor its join's branch deleted: it is refused.
 */
export function usesTree(trees: ReadonlyMap<string, ModelTree>, from: string, key: string): boolean {
  const queue = [from];
  const seen = new Set<string>();
  for (let at = queue.pop(); at !== undefined; at = queue.pop()) {
    if (at === key) return true;
    if (seen.has(at)) continue;
    seen.add(at);
    const tree = trees.get(at);
    if (tree) queue.push(...toolKeys(tree));
  }
  return false;
}

/** A join in another tree that takes its tool from one of `nodes` of tree `key`, or null. */
export function toolUser(trees: ReadonlyMap<string, ModelTree>, key: string, nodes: ReadonlySet<NodeId>): ModelNode | null {
  for (const tree of trees.values()) {
    if (tree.key === key) continue;
    for (const node of tree.nodes.values()) if (node.op?.kind === "join" && node.op.tool.key === key && nodes.has(node.op.tool.node)) return node;
  }
  return null;
}

/** `keys` in an order the engine closes them all in: each tree before the trees its joins take a tool from. */
export function closeOrder(trees: ReadonlyMap<string, ModelTree>, keys: Iterable<string>): string[] {
  const closing = new Set(keys);
  const order: string[] = [];
  const visit = (key: string) => {
    if (!closing.delete(key)) return;
    for (const tree of trees.values()) if (closing.has(tree.key) && toolKeys(tree).has(key)) visit(tree.key);
    order.push(key);
  };
  for (const key of [...closing]) visit(key);
  return order;
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

/** The root's name in the history list: the file's, or the primitive a new solid started as ("Box 20×20×20"). */
export function rootLabel(root: ModelRoot, fileLabel: string): string {
  return root.kind === "primitive" ? primitiveTitle(root.solid) : fileLabel;
}

function primitiveTitle(spec: PrimitiveSpec): string {
  const text = primitiveLabel(spec);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A short name for the step, for the history list. */
export function opLabel(op: ModelOp): string {
  const n = formatMm;
  switch (op.kind) {
    case "boolean":
      return `${BOOLEAN_VERB[op.op]} ${primitiveLabel(op)}`;
    case "hole": {
      const bore = op.counterboreRadius != null && op.counterboreDepth != null ? `, counterbore ⌀${n(op.counterboreRadius * 2)} × ${n(op.counterboreDepth)}` : "";
      return `Hole ⌀${n(op.radius * 2)} ${op.through ? "through" : `depth ${n(op.depth)}`}${bore}`;
    }
    case "split":
      return splitLabel(op.origin, op.normal);
    case "fillet":
    case "chamfer": {
      const count = op.edges.length === 1 ? "1 edge" : `${op.edges.length} edges`;
      return `${op.kind === "fillet" ? "Fillet" : "Chamfer"} ${count} ${op.kind === "fillet" ? "r " : ""}${n(op.size)}`;
    }
    case "scale":
      return `Scale ${n(op.factor * 100)} %`;
    case "join":
      return `${BOOLEAN_VERB[op.op]} ${op.tool.name}`;
    case "root":
      return primitiveTitle(op);
  }
}
