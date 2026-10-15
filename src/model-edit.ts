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
import { fromSolidOp, type Affine } from "./model-space.ts";
import { opLabel, pathTo, toolUser, type BooleanKind, type EdgeRef, type Fingerprint, type ModelOp, type ModelTree, type NodeId, type Vec3 } from "./model-tree.ts";

/**
 * The steps that replay under an edit of `node`, oldest first: the shown branch below it. That is the path down to the
 * step shown when that is below `node`, then on as Redo walks to the branch's tip; else the branch Redo walks from `node`.
 * A step Redo would walk is part of what the user sees as the branch, so it comes along rather than stay behind.
 */
export function replayChain(tree: ModelTree, node: NodeId, shown: NodeId): NodeId[] {
  const down = pathTo(tree, shown);
  const at = down.indexOf(node);
  const chain = at >= 0 ? down.slice(at + 1) : [];
  for (let from = chain.at(-1) ?? node; ; ) {
    const next = tree.lastChild.get(from);
    if (next == null || tree.nodes.get(next)?.parent !== from || chain.includes(next)) return chain;
    chain.push(next);
    from = next;
  }
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

/** The tree with `steps` as a new branch from `parent`, each under the one before, showing `shown`; Redo follows the branch. */
export function forked(tree: ModelTree, parent: NodeId, steps: readonly ForkStep[], shown: NodeId): ModelTree {
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
    lastChild.set(up, step.id);
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
  return null;
}

/** The op an edit of `id` starts from: its own, or the primitive a new solid's root is. */
export function editedOp(tree: ModelTree, id: NodeId): ModelOp | null {
  const node = tree.nodes.get(id);
  if (node?.op) return node.op;
  return node && tree.root.kind === "primitive" ? { kind: "root", ...tree.root.solid } : null;
}

/** The panel's header: "Editing step 3: Hole ⌀5 depth 8", or "Editing the new solid: Box 20×20×20" for its root. */
export function editHead(tree: ModelTree, id: NodeId): string {
  const node = tree.nodes.get(id);
  if (!node) return "";
  const depth = pathTo(tree, id).length - 1;
  return depth === 0 ? `Editing the new solid: ${stepLabel(node)}` : `Editing step ${depth}: ${stepLabel(node)}`;
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
      return {
        tool: "hole",
        fields: { modelX: placed.origin[0], modelY: placed.origin[1], modelZ: placed.origin[2], modelHoleR: placed.radius, modelHoleD: placed.depth },
        axis: length > 1e-9 ? placed.axis : [0, 0, -1],
      };
    }
    case "split": {
      const placed = fromSolidOp(op, pose) as typeof op;
      return { tool: "split", ...splitFields(placed.origin, placed.normal, center) };
    }
    case "fillet":
    case "chamfer":
      return { tool: op.kind, fields: { modelBlend: op.size }, edges: op.edges };
    case "scale":
      return { tool: "scale", fields: { modelFactor: op.factor } };
    case "join":
      return { tool: "boolean", fields: {}, boolOp: op.op, join: { name: op.tool.name, keepTool: op.keepTool } };
  }
}

/** The size fields the panel shows for the primitive's kind, and only those, so a field another kind reads keeps its number. */
function sizeFields(spec: PrimitiveSpec): Record<string, number> {
  const box = { modelDx: spec.size[0], modelDy: spec.size[1], modelDz: spec.size[2] };
  switch (spec.primitive) {
    case "box":
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
  const fits = (edge: (typeof edges)[number] | undefined, ref: EdgeRef) => !!edge && Math.abs(edge.lengthMm - ref.lengthMm) <= EDGE_LENGTH_MM && nearPolyline(edge.points, ref.mid) <= slack + EDGE_LENGTH_MM;
  for (const ref of refs) {
    let found: number | null = null;
    if (typeof ref === "number") found = edges[ref] ? ref : null;
    else if (fits(edges[ref.index], ref)) found = ref.index;
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
