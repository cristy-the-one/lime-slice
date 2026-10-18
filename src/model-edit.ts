/**
 * Editing a step of a Model history tree, as data. An edit never rewrites a step: the edited op becomes a sibling of the
 * step, the steps below it replay under that sibling as new steps, and the old branch stays as it was, since node ids are
 * named by the plate, by split pieces, by kept joins, by Prepare undo, and by saved files. This module says which steps
 * replay, what the fork looks like, why a step cannot be edited, and what the step's tool panel opens with.
 */
import type { ModelTool } from "./model-drag.ts";
import { stepLabel } from "./model-history.ts";
import { tiltOf } from "./model-plane.ts";
import type { PrimitiveKind, PrimitiveSpec } from "./model-primitive.ts";
import { fromSolidOp, thenPose, type Affine } from "./model-space.ts";
import { ROOT, type JoinOp, childrenOf, childrenWithOp, isEdgeStep, opLabel, pathTo, renumberedSteps, toolUser, type BooleanKind, type EdgeRef, type Fingerprint, type ModelOp, type ModelTree, type NodeId, type Vec3 } from "./model-tree.ts";

/**
 * The steps that replay under an edit of `node`, oldest first: the shown branch below it. That is the path down to the
 * step shown when that is below `node`, then on to the branch's tip; else the branch from `node`. A branch goes on as the
 * History panel draws it: the child Redo follows, else the newest. A step Redo would walk is part of what the user sees as
 * the branch, so it comes along rather than stay behind. A `root` step on the way is left out: the edit's own new root
 * stands in for it, and the engine takes a `root` step only right under the root.
 */
export function replayChain(tree: ModelTree, node: NodeId, shown: NodeId): NodeId[] {
  const down = pathTo(tree, shown);
  const at = down.indexOf(node);
  const chain = at >= 0 ? down.slice(at + 1) : [];
  for (let from = chain.at(-1) ?? node; ; ) {
    const next = followed(tree, from);
    if (next == null || chain.includes(next)) break;
    chain.push(next);
    from = next;
  }
  return chain.filter((id) => tree.nodes.get(id)?.op?.kind !== "root");
}

/** The child a branch goes on with: the one Redo follows, else the newest, as `historyLayout` draws it. */
function followed(tree: ModelTree, id: NodeId): NodeId | null {
  const last = tree.lastChild.get(id);
  if (last != null && tree.nodes.get(last)?.parent === id) return last;
  const kids = childrenOf(tree, id);
  return kids.at(-1) ?? null;
}

/** One step of an edit's new branch: built, with its op as the engine stored it and its fingerprint; or never built. */
export interface ForkStep {
  id: NodeId;
  op: ModelOp;
  fingerprint: Fingerprint | null;
  /** The user's name of the step it stands for, which an edit keeps: a renamed step is the same step with new numbers. */
  name?: string;
  /** Why the engine could not build it. The steps after it are under it, unbuilt. */
  broken?: string;
}

/**
 * The tree with `steps` as a new branch from `parent`, each under the one before, showing `shown`. Redo follows the
 * branch, but not into a broken step, which it could not show; the steps under a broken one still follow it, so an edit
 * of the broken step replays them. A tool's tree forked for a join (`follow` false) keeps where Redo goes from `parent`,
 * so the tool object's own History keeps its shape.
 */
export function forked(tree: ModelTree, parent: NodeId, steps: readonly ForkStep[], shown: NodeId, follow = true): ModelTree {
  const nodes = new Map(tree.nodes);
  const lastChild = new Map(tree.lastChild);
  let up = parent;
  for (const step of steps) {
    nodes.set(step.id, {
      id: step.id,
      parent: up,
      op: step.op,
      label: opLabel(step.op),
      fingerprint: step.fingerprint,
      ...(step.name ? { name: step.name } : {}),
      ...(step.broken ? { broken: step.broken } : {}),
    });
    if (!step.broken && (follow || up !== parent)) lastChild.set(up, step.id);
    up = step.id;
  }
  const nextId = Math.max(tree.nextId, ...steps.map((step) => step.id + 1));
  return { ...tree, nodes, lastChild, nextId, current: shown };
}

/** Why step `id` cannot be edited, in plain words, or null when it can. */
export function editRefusal(tree: ModelTree, id: NodeId): string | null {
  const node = tree.nodes.get(id);
  if (!node) return "This step is no longer in the history.";
  if (node.parent === null) {
    if (tree.root.kind === "step") return "The opened file starts the history. Its steps can be edited, not the file.";
    if (tree.root.kind === "piece") return "This piece is as its split cut it. Edit that split in the part it came from.";
    return null;
  }
  if (pathTo(tree, node.parent).some((at) => tree.nodes.get(at)?.broken)) return "A step above this one cannot be rebuilt. Edit or delete that step first.";
  if (node.op && !hasPanel(node.op)) return "This step has no edit panel yet. Delete it and apply it again with new numbers.";
  return null;
}

/** Whether the app has a panel for `op`: not yet for an extrude, a revolve, a loft, a shell, a face extrude, a face move, or a blend that takes an earlier step's edges. */
function hasPanel(op: ModelOp): boolean {
  if (op.kind === "extrude" || op.kind === "revolve" || op.kind === "loft" || op.kind === "shell" || op.kind === "faceExtrude" || op.kind === "moveFaces") return false;
  return !((op.kind === "fillet" || op.kind === "chamfer") && op.edges.some(isEdgeStep));
}

/** The op an edit of `id` starts from: its own, or the primitive a new solid's root is. */
export function editedOp(tree: ModelTree, id: NodeId): ModelOp | null {
  const node = tree.nodes.get(id);
  if (node?.op) return node.op;
  return node && tree.root.kind === "primitive" ? { kind: "root", ...tree.root.solid } : null;
}

/**
 * The panel's header: "Editing step 3: Hole ⌀5 depth 8", or "Editing the new solid: Box 20×20×20" for its root and for
 * a `root` step, which is that root edited before.
 */
export function editHead(tree: ModelTree, id: NodeId): string {
  const node = tree.nodes.get(id);
  if (!node) return "";
  if (node.parent === null || node.op?.kind === "root") return `Editing the new solid: ${stepLabel(node)}`;
  return `Editing step ${pathTo(tree, id).length - 1}: ${stepLabel(node)}`;
}

/**
 * The tip of a branch an edit already built: under `parent`, a step with `op`, then a step with each of `replay` in
 * turn, none broken. An Update with the same numbers shows it rather than build it again. Null when there is none. Every
 * sibling with the same op is searched, so a whole branch is found beside one cut short by Delete branch.
 */
export function builtBranch(tree: ModelTree, parent: NodeId, op: ModelOp, replay: readonly ModelOp[]): NodeId | null {
  return builtPath(tree, parent, op, replay)?.at(-1) ?? null;
}

/** The steps of the branch `builtBranch` finds, its first step first. */
function builtPath(tree: ModelTree, parent: NodeId, op: ModelOp, replay: readonly ModelOp[]): NodeId[] | null {
  for (const at of childrenWithOp(tree, parent, op)) {
    const rest = replay.length === 0 ? [] : builtPath(tree, at, replay[0]!, replay.slice(1));
    if (rest) return [at, ...rest];
  }
  return null;
}

/** A join on the way to a tool's step: step `id` of `tree`, which takes its tool from the next tree down. */
export interface ToolLink {
  tree: ModelTree;
  id: NodeId;
  op: JoinOp;
}

/** One tree's part of an edit across trees, as the engine's `edit` takes it, and the steps it stands for. */
export interface EditLevel {
  key: string;
  parent: NodeId;
  node: NodeId;
  op: ModelOp;
  replay: { id: NodeId; op: ModelOp }[];
  old: NodeId[];
}

/** The steps under `node` down to `tip`, oldest first, but a `root` step, which an edit's new root stands in for. */
function pathBelow(tree: ModelTree, node: NodeId, tip: NodeId): NodeId[] {
  const path = pathTo(tree, tip);
  const at = path.indexOf(node);
  return (at >= 0 ? path.slice(at + 1) : []).filter((id) => tree.nodes.get(id)?.op?.kind !== "root");
}

/**
 * Each tree's part of an edit of step `node` of `tool`, the tree `joins` reach (the open tree's join first), deepest
 * first, the open tree last. The tool's tree forks at the step and replays down to the step the join above takes; each
 * join above is built again on the tip below, as `next` gives it, and its tree replays down to the step the next join
 * takes; the open tree replays `replay`, as an edit of its own step does. `next` gets each level, with the number of
 * joins above it, and answers its tip, or null to stop.
 */
function eachLevel(tool: ModelTree, joins: readonly ToolLink[], node: NodeId, op: ModelOp, replay: readonly NodeId[], next: (tree: ModelTree, edited: NodeId, op: ModelOp, below: NodeId[], above: number) => NodeId | null): boolean {
  let tip: NodeId | null = null;
  for (let i = joins.length; i >= 0; i -= 1) {
    const own = i === joins.length;
    const tree = own ? tool : joins[i]!.tree;
    const edited = own ? node : joins[i]!.id;
    const stepOp: ModelOp = own ? op : { ...joins[i]!.op, tool: { ...joins[i]!.op.tool, node: tip! } };
    const below = i === 0 ? [...replay] : pathBelow(tree, edited, joins[i - 1]!.op.tool.node);
    tip = next(tree, edited, stepOp, below, i);
    if (tip == null) return false;
  }
  return true;
}

/** Each step an edit replays, by its old id, to the new id it is built again under: `old` and `ids` in step. */
export function stepIds(old: readonly NodeId[], ids: readonly NodeId[]): Map<NodeId, NodeId> {
  return new Map(old.map((id, i) => [id, ids[i]!] as const).filter(([, to]) => to !== undefined));
}

/** The levels of an edit across trees (see `eachLevel`). `reserve` hands out each tree's fresh ids. */
export function crossEdit(tool: ModelTree, joins: readonly ToolLink[], node: NodeId, op: ModelOp, replay: readonly NodeId[], reserve: (key: string, count: number) => NodeId[]): EditLevel[] {
  const levels: EditLevel[] = [];
  eachLevel(tool, joins, node, op, replay, (tree, edited, stepOp, below) => {
    const ids = reserve(tree.key, below.length + 1);
    const renamed = stepIds([edited, ...below], ids);
    levels.push({ key: tree.key, parent: tree.nodes.get(edited)?.parent ?? ROOT, node: ids[0]!, op: stepOp, replay: below.map((id, j) => ({ id: ids[j + 1]!, op: renumberedSteps(tree.nodes.get(id)!.op!, renamed) })), old: [edited, ...below] });
    return ids.at(-1)!;
  });
  return levels;
}

/** An edit across trees as `crossEdit` takes it: the edited step `node` of `tool`, reached through `joins`. */
export interface CrossFrom {
  tool: ModelTree;
  joins: ToolLink[];
  node: NodeId;
  op: ModelOp;
}

/** What an edit across trees still has to build (see `crossPlan`). */
export type CrossPlan = { twin: NodeId } | { from: CrossFrom; reused: NodeId | null };

/**
 * What an edit across trees still has to build, after the branches an earlier edit with the same numbers built: those
 * are found deepest first, as each join above names the tip below. `twin` when every tree has its branch, the open
 * tree's tip. Else `from` is the edit that builds the rest, starting at the first tree without one, its op the join on
 * the tip the tree below already has; `reused` is the step that stands for the edited one in the tool's tree, when an
 * earlier edit built it, or null when this edit builds it. So an edit whose part branch was deleted takes the tool
 * branch it built before rather than build a twin of it.
 */
export function crossPlan(tool: ModelTree, joins: readonly ToolLink[], node: NodeId, op: ModelOp, replay: readonly NodeId[]): CrossPlan {
  const found: { twin: NodeId | null; reused: NodeId | null; from?: CrossFrom } = { twin: null, reused: null };
  eachLevel(tool, joins, node, op, replay, (tree, edited, stepOp, below, above) => {
    const path = builtPath(tree, tree.nodes.get(edited)?.parent ?? ROOT, stepOp, below.map((id) => tree.nodes.get(id)!.op!));
    found.twin = path?.at(-1) ?? null;
    if (!path) found.from = { tool: tree, joins: joins.slice(0, above), node: edited, op: stepOp };
    else if (above === joins.length) found.reused = path[0]!;
    return found.twin;
  });
  return found.from ? { from: found.from, reused: found.reused } : { twin: found.twin! };
}

/** Why step `id` of a tool's tree, reached through `joins`, cannot be edited from the open tree's history, or null. */
export function toolEditRefusal(tool: ModelTree, joins: readonly ToolLink[], id: NodeId): string | null {
  return editRefusal(tool, id) ?? joins.map((join) => editRefusal(join.tree, join.id)).find((why) => why != null) ?? null;
}

/** A tool's pose in model space: the open solid's, then each join's placement, the open tree's first. */
export function toolPose(pose: Affine, joins: readonly ToolLink[]): Affine {
  return joins.reduce((at, join) => thenPose(join.op.relative, at), pose);
}

/** The panel's header for a tool's step: "Editing Rod 1, step 2: Scale 150 %", or "Editing Rod 1's primitive: …". */
export function toolEditHead(tool: ModelTree, id: NodeId, name: string): string {
  const node = tool.nodes.get(id);
  if (!node) return "";
  if (node.parent === null || node.op?.kind === "root") return `Editing ${name}'s primitive: ${stepLabel(node)}`;
  return `Editing ${name}, step ${pathTo(tool, id).length - 1}: ${stepLabel(node)}`;
}

/** What an edited step's tool panel opens with, in model space: the inverse of what its Apply would send. */
export interface EditPanel {
  tool: ModelTool;
  /** Input id → value. */
  fields: Record<string, number>;
  primitive?: PrimitiveKind;
  boolOp?: BooleanKind;
  /** A polygon sized across flats. */
  flats?: boolean;
  /**
   * A split's base axis, and whether its normal is that axis turned around: a face split on a face that points down an
   * axis keeps the other side, which the panel's X, Y and Z cannot say on their own.
   */
  plane?: { mode: "x" | "y" | "z"; flip: boolean };
  /** A hole's drill direction, used while no face is picked. */
  axis?: Vec3;
  /** A hole's Through all and Counterbore boxes. */
  hole?: { through: boolean; counterbore: boolean };
  /** A fillet's or a chamfer's edges, as stored. */
  edges?: readonly (number | EdgeRef)[];
  /** A join: its tool stays as applied; its op and Keep can change. */
  join?: { name: string; keepTool: boolean };
}

/**
 * The panel for `op` (in the solid's own frame) on a part posed at `pose`, whose shown solid's model-space centre is
 * `center`. Numbers come back into model space by `fromSolidOp`, so an untouched panel sends the stored op again.
 */
export function editPanel(op: ModelOp, pose: Affine, center: Vec3): EditPanel {
  switch (op.kind) {
    case "root":
      return { tool: "create", fields: sizeFields(op), primitive: op.primitive, ...(op.primitive === "polygon" ? { flats: op.flats ?? false } : {}) };
    case "boolean": {
      const placed = fromSolidOp(op, pose) as typeof op;
      const fields = { ...sizeFields(placed), modelX: placed.origin[0], modelY: placed.origin[1], modelZ: placed.origin[2] };
      const turned: Record<string, number> = placed.primitive === "sphere" ? {} : { modelRx: placed.turn[0], modelRy: placed.turn[1], modelRz: placed.turn[2] };
      return { tool: "boolean", fields: { ...fields, ...turned }, primitive: placed.primitive, boolOp: placed.op, ...(placed.primitive === "polygon" ? { flats: placed.flats ?? false } : {}) };
    }
    case "hole": {
      const placed = fromSolidOp(op, pose) as typeof op;
      const length = Math.hypot(...placed.axis);
      // A counterbore's fields are filled only when the step has one; else they keep the panel's numbers.
      const bore = placed.counterboreRadius != null && placed.counterboreDepth != null ? { modelBoreR: placed.counterboreRadius, modelBoreD: placed.counterboreDepth } : null;
      return {
        tool: "hole",
        fields: { modelX: placed.origin[0], modelY: placed.origin[1], modelZ: placed.origin[2], modelHoleR: placed.radius, modelHoleD: placed.depth, ...bore },
        axis: length > 1e-9 ? placed.axis : [0, 0, -1],
        hole: { through: placed.through === true, counterbore: bore != null },
      };
    }
    case "split": {
      const placed = fromSolidOp(op, pose) as typeof op;
      return { tool: "split", ...splitFields(placed.origin, placed.normal, center) };
    }
    case "fillet":
    case "chamfer":
      return { tool: op.kind, fields: { modelBlend: op.size }, edges: op.edges.filter((edge): edge is number | EdgeRef => !isEdgeStep(edge)) };
    case "scale":
      return { tool: "scale", fields: { modelFactor: op.factor } };
    case "join":
      return { tool: "boolean", fields: {}, boolOp: op.op, join: { name: op.tool.name, keepTool: op.keepTool } };
    case "extrude":
    case "revolve":
    case "loft":
    case "shell":
    case "faceExtrude":
    case "moveFaces":
      // `editRefusal` turns these away before a panel opens.
      throw new Error(`No edit panel for a ${op.kind} step`);
  }
}

/** The size fields the panel shows for the primitive's kind, and only those, so a field another kind reads keeps its number. */
function sizeFields(spec: PrimitiveSpec): Record<string, number> {
  const box = { modelDx: spec.size[0], modelDy: spec.size[1], modelDz: spec.size[2] };
  switch (spec.primitive) {
    case "box":
    case "ellipsoid":
      return box;
    case "wedge":
      return { ...box, modelTopX: spec.topX ?? 0 };
    case "cylinder":
      return { modelRadius: spec.radius, modelHeight: spec.height };
    case "sphere":
      return { modelRadius: spec.radius };
    case "cone":
      return { modelRadius: spec.radius, modelTopR: spec.topRadius ?? 0, modelHeight: spec.height };
    case "torus":
      return { modelRadius: spec.radius, modelTube: spec.tubeRadius ?? 0 };
    case "tube":
      return { modelRadius: spec.radius, modelInnerR: spec.innerRadius ?? 0, modelHeight: spec.height };
    case "polygon":
      return { modelSides: spec.sides ?? 0, modelAcross: spec.across ?? 0, modelHeight: spec.height };
  }
}

const AXES: readonly Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

/**
 * A model-space plane as the Split panel's numbers: the axis its normal is nearest, the tilts from that axis (turned
 * around when the normal points down it), and where the plane crosses the line through `center` along that axis. The
 * panel then builds the same plane, its pivot on that line.
 */
function splitFields(origin: Vec3, normal: Vec3, center: Vec3): Pick<EditPanel, "fields" | "plane"> {
  const length = Math.hypot(...normal) || 1;
  const n: Vec3 = [normal[0] / length, normal[1] / length, normal[2] / length];
  const abs = n.map(Math.abs);
  const axis = abs[0]! >= abs[1]! && abs[0]! >= abs[2]! ? 0 : abs[1]! >= abs[2]! ? 1 : 2;
  const flip = n[axis]! < 0;
  const base = AXES[axis]!.map((value) => (flip ? -value : value)) as Vec3;
  const [tiltA, tiltB] = tiltOf(base, n);
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const line: Vec3 = [...center];
  line[axis] = 0;
  const value = (dot(n, origin) - dot(n, line)) / n[axis]!;
  return { fields: { modelPlane: value, modelTiltA: tiltA, modelTiltB: tiltB }, plane: { mode: (["x", "y", "z"] as const)[axis]!, flip } };
}

/** Edge lengths agree within this, as the engine matches them. */
const EDGE_LENGTH_MM = 1e-3;

/**
 * A fillet's or chamfer's stored edges on the shown solid's `edges`: by index while its length and midpoint still agree,
 * else the one edge that does, as the engine finds them. The midpoint is checked against the edge's polyline, which sits
 * within the chord of the true edge, so `slack` is that chord. `missing` counts the edges no longer on the solid.
 */
export function matchEdges(edges: readonly { id: number; lengthMm: number; points: ArrayLike<number> }[], refs: readonly (number | EdgeRef)[], slack: number): { picked: number[]; missing: number } {
  const picked: number[] = [];
  let missing = 0;
  const byId = new Map(edges.map((edge) => [edge.id, edge]));
  const fits = (edge: (typeof edges)[number] | undefined, ref: EdgeRef) => !!edge && Math.abs(edge.lengthMm - ref.lengthMm) <= EDGE_LENGTH_MM && nearPolyline(edge.points, ref.mid) <= slack + EDGE_LENGTH_MM;
  for (const ref of refs) {
    let found: number | null = null;
    if (typeof ref === "number") found = byId.has(ref) ? ref : null;
    else if (fits(byId.get(ref.index), ref)) found = ref.index;
    else {
      const all = edges.filter((edge) => fits(edge, ref));
      found = all.length === 1 ? all[0]!.id : null;
    }
    if (found == null) missing += 1;
    else if (!picked.includes(found)) picked.push(found);
  }
  return { picked, missing };
}

/** How far `p` is from the polyline through `points`. */
function nearPolyline(points: ArrayLike<number>, p: Vec3): number {
  let best = Infinity;
  const at = (i: number): Vec3 => [points[i * 3]!, points[i * 3 + 1]!, points[i * 3 + 2]!];
  const count = Math.floor(points.length / 3);
  for (let i = 0; i < count; i += 1) {
    const a = at(i);
    const b = i + 1 < count ? at(i + 1) : a;
    const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / len2)) : 0;
    best = Math.min(best, Math.hypot(a[0] + ab[0] * t - p[0], a[1] + ab[1] * t - p[1], a[2] + ab[2] * t - p[2]));
  }
  return best;
}

/**
 * A split piece's note when the step its part's plate holds is not under the split that cut it, as after an edit of
 * that split or of a step above it: the piece is still the older split's. Null otherwise.
 */
export function olderSplitNote(trees: ReadonlyMap<string, ModelTree>, tree: ModelTree): string | null {
  if (tree.root.kind !== "piece") return null;
  const part = trees.get(tree.root.tree);
  if (!part?.nodes.has(tree.root.node) || pathTo(part, part.committed).includes(tree.root.node)) return null;
  return "This piece was cut by a split that its part's steps on the plate no longer have.";
}

/**
 * What an edit leaves as it was, for the readout. `old` is the steps the edit stands in for: the step edited and the
 * steps that replayed. A split among them whose piece is a part of its own keeps that piece as the older split cut it
 * (`pieceName` names it, null when it is not on the plate). A join in another part that names one of them keeps it.
 */
export function editNotes(trees: ReadonlyMap<string, ModelTree>, tree: ModelTree, old: readonly NodeId[], pieceName: (key: string) => string | null): string[] {
  const notes: string[] = [];
  for (const id of old) {
    const key = tree.nodes.get(id)?.piece;
    const name = key ? pieceName(key) : null;
    if (name) notes.push(`${name} stays as the older split cut it.`);
  }
  const user = toolUser(trees, tree.key, new Set(old));
  if (user) notes.push(`“${stepLabel(user)}” in another part still uses this part as it was before the edit.`);
  return notes;
}
