/**
 * Model history as a tree, one per plate object: the ops, which branch Redo follows, the node the
 * view shows (`current`), and the node the plate holds (`committed`). The engine keeps the solids,
 * keyed by `key` and node id; this keeps what the client needs to hand them back.
 */
import { formatMm, splitLabel } from "./model-plane.ts";
import { primitiveLabel, type PrimitiveSpec } from "./model-primitive.ts";
import type { Affine } from "./model-space.ts";
import type { CutInput, Labels, Target } from "./modeling/partition.ts";
import type { SketchData } from "./sketch/model.ts";
import type { ReinforceRegion } from "./reinforcement.ts";
import type { SeamDisk } from "./seam-paint.ts";
import type { EditEntry } from "./support-edit-list.ts";
import type { PaintDisk } from "./support-paint.ts";

/** Given by the client, never reused in one tree. The root is 0. */
export type NodeId = number;
export type Vec3 = [number, number, number];
export type Vec2 = [number, number];

/** An edge as the engine stores it, so a rebuild can find it again after its index moves. */
export interface EdgeRef {
  index: number;
  mid: Vec3;
  lengthMm: number;
}

/** Which of a step's edges a pick takes. Each is sharp: an edge already smooth, or a seam, cannot be blended. */
export type EdgeFilter = "all" | "convex" | "concave";

/**
 * The edges an earlier step made or changed, still on the solid blended: `filter` ("all" when absent) keeps the sharp,
 * convex, or concave ones. The engine finds them at every build, so an edit above the step finds them again.
 */
export interface EdgeStep {
  fromNode: NodeId;
  filter?: EdgeFilter;
}

/** A blend's edge: an index into the parent's reply when fresh, a reference once stored, or an earlier step's edges. */
export type EdgePick = number | EdgeRef | EdgeStep;

export function isEdgeStep(edge: EdgePick): edge is EdgeStep {
  return typeof edge === "object" && "fromNode" in edge;
}

/** A face as the engine stores it: its centre of area and its area, so a rebuild can find it again. */
export interface FaceRef {
  index: number;
  mid: Vec3;
  areaMm2: number;
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
type ModelOpBase =
  | ({ kind: "boolean"; op: BooleanKind } & PrimitiveSpec)
  | HoleOp
  | { kind: "split"; origin: Vec3; normal: Vec3 }
  | { kind: "fillet" | "chamfer"; edges: EdgePick[]; size: number }
  | { kind: "scale"; factor: number }
  /** Another object's solid at `tool`, placed by `relative`: its pose in this solid's own frame, worked out once at Apply. */
  | { kind: "join"; op: BooleanKind; tool: JoinTool; relative: Affine; keepTool: boolean }
  /** A new solid's primitive built again from other numbers, in place of the solid above: an edited root, right under the root. */
  | ({ kind: "root" } & PrimitiveSpec)
  | ExtrudeOp
  | RevolveOp
  | LoftOp
  | ShellOp
  | GroupOp
  | FaceExtrudeOp
  | MoveFacesOp
  | PartitionModelOp;

/**
 * --- A6. `exprs` is the expression text for a panel field (`modelDz` → `"wallH / 2"`).
 * The op's numbers stay the evaluated values. Absent when every number was typed as a number.
 * Stripped before the engine sees the op.
 */
export type ModelOp = ModelOpBase & { exprs?: Record<string, string> };

/**
 * --- Split to print (docs/plan-split-connectors.md, D1). The solid cut along every plane at once, in its own frame. The
 * node keeps the first piece in partition order; the others root trees of their own (`pieces`). Absent fields are the
 * planner's defaults (`fillPartition`).
 */
export interface PartitionModelOp {
  kind: "partition";
  cuts: CutInput[];
  target?: Target;
  orient?: "keep" | ("keep" | "joint")[];
  arrange?: boolean;
  labels?: Labels;
  bedMarginMm?: number;
  maxPieces?: number;
}

/** One edge of a loop, from the previous end (the loop's start, for the first) to `to`. */
export type ProfileSegment =
  | { kind: "line"; to: Vec2 }
  | { kind: "arc"; through: Vec2; to: Vec2 }
  | { kind: "spline"; through: Vec2[]; to: Vec2 };

/** A closed loop on a profile's plane. The first of an op's loops is the outline; the rest are holes. */
export interface ProfileLoop {
  start: Vec2;
  segments: ProfileSegment[];
}

/**
 * One history row for a composite edit. Each step is built on the shape the one before left.
 * `source` is the composite as typed, kept so an edit can reopen it, and never built.
 */
export interface GroupOp {
  kind: "group";
  /** The history row's name, e.g. "Pocket 10 × 10, 2 bars". */
  label: string;
  /** The composite as typed (`{kind: "pocket", ...}`). Absent on a group that was not typed as one. */
  source?: unknown;
  steps: ModelOp[];
}

/**
 * A closed outline of `[u, v]` points on a plane, as a workplane is: `origin`, and `turn` about X, then Y, then Z, whose
 * columns are U, V, and W. An extrude pushes it `depth` along W (−W when negative), or centred on the plane with
 * `symmetric`; a revolve turns it about an in-plane axis. Either is then fused, cut, or intersected with the solid.
 * `loops` replaces `profile`: the first loop is the outline, and the rest are holes.
 */
export interface ExtrudeOp {
  kind: "extrude";
  op: BooleanKind;
  origin: Vec3;
  turn: Vec3;
  profile?: Vec2[];
  depth: number;
  symmetric?: true;
  /** Splines through the points instead of straight edges, sharp at the points `corners` lists. */
  smooth?: true;
  corners?: number[];
  /** K3. The other side of the plane, above 0. Absent on a plain extrude. */
  depth2?: number;
  /** K3. Draft angle in degrees. Positive makes the section smaller as W increases. Absent when there is none. */
  draftDeg?: number;
  /** K3. Stop at this face. A fresh pick is an index; a stored op names `{index, mid, areaMm2}`. */
  upTo?: number | FaceRef;
  /** K1: closed loops in place of `profile`. Absent for a point profile. */
  loops?: ProfileLoop[];
  /**
   * --- F1. The sketch this extrude was edited as. The kernel never reads it.
   * Absent on an extrude from before sketches, and on one typed without a drawing.
   */
  sketch?: SketchData;
}

/** Turned `angleDeg` (360 when absent) about the line through `axisOrigin` ([0, 0]) along `axisDir` (V, [0, 1]). */
export interface RevolveOp {
  kind: "revolve";
  op: BooleanKind;
  origin: Vec3;
  turn: Vec3;
  profile?: Vec2[];
  axisOrigin?: Vec2;
  axisDir?: Vec2;
  angleDeg?: number;
  smooth?: true;
  corners?: number[];
  /** K1: closed loops in place of `profile`. Absent for a point profile. */
  loops?: ProfileLoop[];
  /**
   * --- F2. The sketch this revolve was edited as. The kernel never reads it.
   * Absent on a revolve from before sketches, and on one typed without a drawing.
   */
  sketch?: SketchData;
}

/**
 * One cross-section of a loft, on a plane as a profile's is: a closed outline of `[u, v]` points (smooth, sharp at
 * `corners`, as a profile's), or a circle of `radius` about the plane's origin, an ellipse with `radiusV` along V.
 */
export interface LoftSection {
  origin: Vec3;
  turn: Vec3;
  profile?: Vec2[];
  radius?: number;
  radiusV?: number;
  smooth?: true;
  corners?: number[];
  /** K1: closed loops in place of `profile` or `radius`. Absent otherwise. */
  loops?: ProfileLoop[];
}

/**
 * --- F3. A sweep remembered on the loft it became. The kernel never reads it.
 * `scale` is the MCP sweep field: one number, or one per path point. There is no twist field.
 */
export interface SweepDrawing {
  profile: SketchData;
  pathSketch?: SketchData;
  path: Vec3[];
  scale: number | number[];
  /** A number `scale` is the size at the path's end. Absent on a sweep from before 3.0.1, where it was the whole size. */
  scaleAtEnd?: true;
  /** Solid edges the path was picked from, when it was. */
  edges?: number[];
}

/**
 * --- F3. The sketches a loft was picked from. Absent on a loft from before this field.
 * `sketches` lines up with `sections`; null is a face, or a section typed without a drawing.
 */
export interface LoftDrawing {
  sketches?: (SketchData | null)[];
  sweep?: SweepDrawing;
}

/** A solid through `sections` in order, smooth or `ruled` (flat between sections), fused, cut, or intersected. */
export interface LoftOp {
  kind: "loft";
  op: BooleanKind;
  sections: LoftSection[];
  ruled?: true;
  /** --- F3. Stripped before the engine sees the op. An old loft has none. --- */
  drawing?: LoftDrawing;
}

/** The solid hollowed inward to walls `thickness` thick, with `openFaces` removed: indexes when fresh, references once stored. */
export interface ShellOp {
  kind: "shell";
  thickness: number;
  openFaces?: (number | FaceRef)[];
}

/** A face pulled along its outward normal. Positive distance adds material; negative cuts it away. */
export interface FaceExtrudeOp {
  kind: "faceExtrude";
  face: number | FaceRef;
  distance: number;
  /** Degrees. Absent when there is no draft. */
  draftDeg?: number;
  /** The face the prism stops at. Absent when the distance sets the length. */
  upTo?: number | FaceRef;
}

/** One face of a `moveFaces`, moved `distance` along its outward normal. */
export interface FaceMove {
  face: number | FaceRef;
  distance: number;
}

/** Faces offset along their outward normals. The neighbours extend or trim. */
export interface MoveFacesOp {
  kind: "moveFaces";
  faces: FaceMove[];
}

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
  /**
   * A split to print: the keys of the trees its pieces 2, 3, … root, in partition order. Null for a piece no tree here
   * holds, so the list still counts the parts.
   */
  pieces?: (string | null)[];
  keep?: PrepareKeep;
  mesh?: PlateMesh;
}

/** An extrude, a revolve, or a loft that can start a solid on its own (K2). */
export type FeatureOp = ExtrudeOp | RevolveOp | LoftOp;

export function isFeatureOp(op: ModelOp): op is FeatureOp {
  return op.kind === "extrude" || op.kind === "revolve" || op.kind === "loft";
}

/**
 * Where the root solid comes from: STEP bytes, a primitive built from its numbers, a feature built against nothing, or the
 * piece a split cut off in another tree. A split to print's piece names its part number, `index` (2, 3, …).
 */
export type ModelRoot =
  | { kind: "step"; name: string; bytes: ArrayBuffer }
  | { kind: "primitive"; solid: PrimitiveSpec; exprs?: Record<string, string> }
  | { kind: "feature"; op: FeatureOp }
  | { kind: "piece"; tree: string; node: NodeId; index?: number };

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
  if ([...gone].some((at) => tree.nodes.get(at)?.mesh || makesParts(tree.nodes.get(at)))) return null;
  const nodes = new Map([...tree.nodes].filter(([key]) => !gone.has(key)));
  const lastChild = new Map([...tree.lastChild].filter(([from]) => !gone.has(from)));
  if (gone.has(lastChild.get(node.parent) ?? -1)) {
    const rest = [...nodes.values()].filter((other) => other.parent === node.parent).map((other) => other.id);
    if (rest.length > 0) lastChild.set(node.parent, Math.max(...rest));
    else lastChild.delete(node.parent);
  }
  return { ...tree, nodes, lastChild };
}

/** Whether a split or a split to print at `node` made a part that a tree of its own roots. */
export function makesParts(node: ModelNode | undefined): boolean {
  return !!node?.piece || (node?.pieces ?? []).some((key) => key != null);
}

/**
 * --- D9. The steps a split to print's piece had after its root, which a rebuild of that piece replays, oldest first: those
 * on the way to the step shown, then a branch kept broken under it by an earlier rebuild (its newest), so a step that did
 * not build once is tried again rather than lost.
 */
export function keptSteps(tree: ModelTree): NodeId[] {
  const steps = pathTo(tree, tree.current).slice(1);
  let at = tree.current;
  let broken = false;
  for (;;) {
    const below = childrenOf(tree, at).filter((id) => broken || tree.nodes.get(id)?.broken);
    const next = below.at(-1);
    if (next === undefined) break;
    broken = true;
    steps.push(next);
    at = next;
  }
  return steps.filter((id) => tree.nodes.get(id)?.op);
}

/** How many parts a split to print made, read from its node's `pieces`. Undefined for any other step. */
export function partsOf(node: Pick<ModelNode, "op" | "pieces">): number | undefined {
  return node.op?.kind === "partition" && node.pieces ? node.pieces.length + 1 : undefined;
}

/**
 * The child of `parent` that `op` already built, so an Apply of the same numbers jumps to it instead
 * of building it again. A stored edge matches a fresh pick by index.
 */
export function childWithOp(tree: ModelTree, parent: NodeId, op: ModelOp): NodeId | null {
  return childrenWithOp(tree, parent, op)[0] ?? null;
}

/** Every child of `parent` that `op` built, oldest first, none broken. */
export function childrenWithOp(tree: ModelTree, parent: NodeId, op: ModelOp): NodeId[] {
  const want = canonical(op);
  return childrenOf(tree, parent).filter((id) => {
    const node = tree.nodes.get(id);
    return !!node?.op && !node.broken && canonical(node.op) === want;
  });
}

function canonical(op: ModelOp): string {
  return JSON.stringify(canonicalValue(op), (_, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value,
  );
}

/** The op as `childWithOp` compares it. A group's label and `source` build nothing, as the kernel's `same_request`. */
function canonicalValue(op: ModelOp): unknown {
  // A stored reference matches a fresh index pick; an earlier step's edges match as they are.
  const index = (pick: EdgePick | FaceRef) => (typeof pick === "number" ? pick : "index" in pick ? pick.index : pick);
  if (op.kind === "fillet" || op.kind === "chamfer") return { ...op, edges: op.edges.map(index) };
  if (op.kind === "shell" && op.openFaces) return { ...op, openFaces: op.openFaces.map(index) };
  if (op.kind === "extrude" && op.upTo !== undefined) return { ...op, upTo: index(op.upTo) };
  if (op.kind === "faceExtrude") return { ...op, face: index(op.face), ...(op.upTo !== undefined ? { upTo: index(op.upTo) } : {}) };
  if (op.kind === "moveFaces") return { ...op, faces: op.faces.map((row) => ({ ...row, face: index(row.face) })) };
  if (op.kind === "group") {
    const { source: _source, label: _label, steps, ...rest } = op;
    return { ...rest, steps: steps.map(canonicalValue) };
  }
  return op;
}

/**
 * `op` with each step its blend takes edges from renamed by `ids`: an edit replays a step under new ids, so a blend
 * that took edges from a replayed step takes them from its new id. `op` itself when nothing is renamed.
 */
export function renumberedSteps(op: ModelOp, ids: ReadonlyMap<NodeId, NodeId>): ModelOp {
  // --- A1 group: a blend inside a group takes edges from the replayed step's new id. ---
  if (op.kind === "group") {
    const steps = op.steps.map((step) => renumberedSteps(step, ids));
    // A pattern or mirror names its source steps; a replayed source step has a new id.
    const of = (op.source as { of?: unknown } | undefined)?.of;
    const renamed = Array.isArray(of) && of.some((id) => ids.has(id)) ? of.map((id) => ids.get(id) ?? id) : null;
    if (!renamed && steps.every((step, i) => step === op.steps[i])) return op;
    return { ...op, steps, ...(renamed ? { source: { ...(op.source as Record<string, unknown>), of: renamed } } : {}) };
  }
  if (op.kind !== "fillet" && op.kind !== "chamfer") return op;
  if (!op.edges.some((edge) => isEdgeStep(edge) && ids.has(edge.fromNode))) return op;
  return { ...op, edges: op.edges.map((edge) => (isEdgeStep(edge) && ids.has(edge.fromNode) ? { ...edge, fromNode: ids.get(edge.fromNode)! } : edge)) };
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
      for (const piece of node.pieces ?? []) if (piece) queue.push(piece);
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

/** The root's name in the history list: the file's, the primitive a new solid started as ("Box 20×20×20"), or the feature it started as. */
export function rootLabel(root: ModelRoot, fileLabel: string): string {
  if (root.kind === "primitive") return primitiveTitle(root.solid);
  if (root.kind === "feature") return opLabel(root.op);
  return fileLabel;
}

function primitiveTitle(spec: PrimitiveSpec): string {
  const text = primitiveLabel(spec);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const FEATURE_NAMES = { extrude: "Extrude", revolve: "Revolve", loft: "Loft" } as const;

/**
 * --- F1/E1. A group of extrudes that came from one sketch: no composite `source`, so it is not a pocket,
 * a pattern, or a mirror. Edit reopens that sketch. Any other group stays what it was.
 */
export function isSketchExtrudeGroup(op: ModelOp): op is GroupOp {
  return op.kind === "group" && op.source == null && op.steps.length > 0 && op.steps.every((step) => step.kind === "extrude");
}

/** --- F2. A group of revolves from one sketch. Edit reopens that sketch. Any other group stays what it was. */
export function isSketchRevolveGroup(op: ModelOp): op is GroupOp {
  return op.kind === "group" && op.source == null && op.steps.length > 0 && op.steps.every((step) => step.kind === "revolve");
}

/** The plate name of a solid that started from a sketch: "Extrude 1", and the first number no object of that kind has yet. */
export function featureObjectName(names: Iterable<string>, kind: FeatureOp["kind"]): string {
  const label = FEATURE_NAMES[kind];
  const taken = new Set(names);
  let at = 1;
  while (taken.has(`${label} ${at}`)) at += 1;
  return `${label} ${at}`;
}

/** --- F3. A sweep is a loft op. The plate still calls the object a sweep. --- */
export function sweepObjectName(names: Iterable<string>): string {
  const taken = new Set(names);
  let at = 1;
  while (taken.has(`Sweep ${at}`)) at += 1;
  return `Sweep ${at}`;
}

/**
 * The same tree, now rooted in `op`. Node 0 keeps its id; its label becomes the feature's. A sketch edit
 * (E1) calls this when the root feature's numbers change.
 */
export function withFeatureRoot(tree: ModelTree, op: FeatureOp): ModelTree {
  const root = { kind: "feature" as const, op };
  const nodes = new Map(tree.nodes);
  const node = nodes.get(ROOT);
  if (node) nodes.set(ROOT, { ...node, label: rootLabel(root, node.label) });
  return { ...tree, root, nodes };
}

/** A short name for the step, for the history list. `parts` is how many pieces a split to print made, when known. */
export function opLabel(op: ModelOp, parts?: number): string {
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
      const picked = op.edges.filter((edge) => !isEdgeStep(edge)).length;
      const steps = op.edges.filter(isEdgeStep).map((edge) => `${edge.filter && edge.filter !== "all" ? `${edge.filter} ` : ""}edges of node ${edge.fromNode}`);
      const count = [...(picked > 0 || steps.length === 0 ? [picked === 1 ? "1 edge" : `${picked} edges`] : []), ...steps].join(" + ");
      return `${op.kind === "fillet" ? "Fillet" : "Chamfer"} ${count} ${op.kind === "fillet" ? "r " : ""}${n(op.size)}`;
    }
    case "scale":
      return `Scale ${n(op.factor * 100)} %`;
    case "join":
      return `${BOOLEAN_VERB[op.op]} ${op.tool.name}`;
    case "root":
      return primitiveTitle(op);
    case "extrude": {
      const verb = op.op === "fuse" ? "Extrude" : `${BOOLEAN_VERB[op.op]} extrude`;
      const outline = op.loops?.length ? `${op.loops.length}-loop profile` : `${op.profile?.length ?? 0}-point profile`;
      // The depth keeps its sign, which says the side, and its unit, as every other row does.
      const reach = op.upTo != null
        ? "up to a face"
        : `${n(op.depth)}${op.depth2 != null ? ` and ${n(op.depth2)}` : ""} mm${op.depth2 == null && op.symmetric ? " both ways" : ""}`;
      const draft = op.draftDeg != null && op.draftDeg !== 0 ? `, draft ${n(op.draftDeg)}°` : "";
      return `${verb} ${outline} ${reach}${draft}`;
    }
    case "revolve": {
      const verb = op.op === "fuse" ? "Revolve" : `${BOOLEAN_VERB[op.op]} revolve`;
      const outline = op.loops?.length ? `${op.loops.length}-loop profile` : `${op.profile?.length ?? 0}-point profile`;
      return `${verb} ${outline} ${n(op.angleDeg ?? 360)}°`;
    }
    case "loft": {
      // --- F3. A sweep is stored as a loft. The row names the path. ---
      if (op.drawing?.sweep) {
        const verb = op.op === "fuse" ? "Sweep" : `${BOOLEAN_VERB[op.op]} sweep`;
        return `${verb} along ${op.drawing.sweep.path.length} points`;
      }
      const verb = op.op === "fuse" ? "Loft" : `${BOOLEAN_VERB[op.op]} loft`;
      return `${verb} through ${op.sections.length} sections${op.ruled ? ", ruled" : ""}`;
    }
    case "shell": {
      const open = op.openFaces?.length ?? 0;
      return `Shell ${n(op.thickness)}, ${open === 0 ? "closed" : open === 1 ? "1 face open" : `${open} faces open`}`;
    }
    // --- A1 group: the row is the composite's name, not a list of its steps. ---
    case "group":
      return op.label;
    // A prism on one face adds or cuts material; it does not move the face, so it is not called a pull.
    case "faceExtrude": {
      const verb = op.distance < 0 ? "Cut" : "Extrude";
      const draft = op.draftDeg ? `, draft ${n(op.draftDeg)}°` : "";
      const until = op.upTo !== undefined ? ", up to a face" : "";
      return `${verb} face ${n(Math.abs(op.distance))} mm${draft}${until}`;
    }
    // --- Split to print (plan section 11). Profiles, connectors and an export target join the label in later milestones.
    case "partition":
      return parts != null ? `Split to print, ${parts} parts` : "Split to print";
    case "moveFaces": {
      const count = op.faces.length;
      const distance = op.faces[0]?.distance;
      const shared = distance !== undefined && op.faces.every((row) => row.distance === distance);
      if (count <= 1 && distance !== undefined) return `${distance < 0 ? "Push" : "Pull"} face ${n(Math.abs(distance))} mm`;
      return shared ? `Move ${count} faces ${n(distance)} mm` : `Move ${count} faces`;
    }
  }
}

/** The sketch card's name, or "Sketch N" when the drawing was stored without one. */
function sketchTitle(sketch: SketchData | null | undefined, index: number): string {
  const name = sketch?.name?.trim();
  return name || `Sketch ${index}`;
}

function featureMode(op: BooleanKind): string {
  if (op === "cut") return ", cut";
  if (op === "common") return ", intersect";
  return "";
}

/**
 * The history row for a sketch feature. `fallback` is the stored label (`opLabel`), used for MCP-made
 * steps and for anything that was not drawn from a sketch.
 */
export function historyCaption(op: ModelOp | null, fallback: string): string {
  const n = formatMm;
  if (!op) return fallback;
  if (op.kind === "extrude" && op.sketch) {
    const reach = op.upTo != null ? "up to a face" : `${n(Math.abs(op.depth))} mm`;
    return `Extrude ${sketchTitle(op.sketch, 1)}, ${reach}${featureMode(op.op)}`;
  }
  if (op.kind === "revolve" && op.sketch) {
    return `Revolve ${sketchTitle(op.sketch, 1)}, ${n(op.angleDeg ?? 360)}°${featureMode(op.op)}`;
  }
  if (op.kind === "loft" && op.drawing?.sweep) {
    return `Sweep ${sketchTitle(op.drawing.sweep.profile, 1)}${featureMode(op.op)}`;
  }
  if (op.kind === "loft" && op.drawing?.sketches && op.drawing.sketches.length >= 2) {
    const sketches = op.drawing.sketches;
    const from = sketchTitle(sketches[0], 1);
    const to = sketchTitle(sketches[sketches.length - 1], sketches.length);
    return `Loft ${from} → ${to}${op.ruled ? ", ruled" : ""}${featureMode(op.op)}`;
  }
  return fallback;
}
