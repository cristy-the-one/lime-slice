/**
 * A Model history tree as `.lime` keeps it: the ops, names, and fingerprints of every node, which
 * node the view and the plate were on, and the root STEP, or a new solid's root primitive. Engine keys are not saved: they name a
 * tree for one page load. A split names its piece, a split to print its pieces, and a join its tool, by that plate
 * object's id instead.
 */
import { isPrimitiveKind, primitiveMesh, type PrimitiveSpec } from "./model-primitive.ts";
import { isBoreShape } from "./model-gear.ts";
import { isPartKind } from "./model-part.ts";
import { readLoftDrawing } from "./sketch/loft-file.ts";
import { readSketch } from "./sketch/model.ts";
import { SPLINE_THROUGH_MAX } from "./sketch/geom.ts";
import { isRigid, type Affine } from "./model-space.ts";
import { MAX_PIECES_HARD_STOP, type CutInput, type Labels, type Profile, type Target } from "./modeling/partition.ts";
import { jumped, opLabel, partsOf, rootLabel, type PartitionModelOp, type BooleanKind, type Curve3D, type Curve3DSegment, type DraftNeutral, type EdgePick, type EdgeSig, type FaceRef, type FeatureOp, type FilletContinuity, type Fingerprint, type JoinTool, type LoftBoundary, type LoftSection, type ModelOp, type ModelRoot, type ModelTree, type ModelNode, type NodeId, type PlateMesh, type PluginPins, type PluginStamp, type RunMark, type ProfileLoop, type ProfileSegment, type SheetMode, type SheetSpec, type SurfaceBoundary, type SurfaceContinuity, type SweepMode, type SweepTransition, type ThickenDirection, type TrimKeep, type Vec2, type Vec3 } from "./model-tree.ts";

// A project file reads and writes a tree's body without loading the readers here (./saved-tree-body.ts).
import { savedToolObjects, treeBody } from "./saved-tree-body.ts";
export { savedToolObjects, treeBody };

type JoinOp = Extract<ModelOp, { kind: "join" }>;

/** A join as saved: its tool named by object id and step, without the engine key, which is the page's. */
export type SavedJoin = Omit<JoinOp, "tool"> & { tool: Omit<JoinTool, "key"> };

/** An op as `.lime` keeps it. */
export type SavedOp = Exclude<ModelOp, JoinOp> | SavedJoin;

interface SavedNode {
  id: NodeId;
  parent: NodeId | null;
  op: SavedOp | null;
  name?: string;
  fingerprint: Fingerprint | null;
  /** A split whose other piece is on the plate: that object's id. */
  piece?: string;
  /** A split to print: each piece after the first, in partition order, as its plate object's id, or null when not saved. */
  pieces?: (string | null)[];
  /** A split to print with dowels: its pins' plate object's id, or null when not saved. */
  pins?: string | null;
  /** --- Plugin steps (D8). The recipe a run of steps came from, on its first node, and the run on each of its nodes. */
  plugin?: PluginStamp;
  run?: RunMark;
  /** --- docs/plan-native-recipes.md 7.1. A recipe's queued step: the first step it was built with. */
  builtWith?: NodeId;
}

/**
 * The root is exactly one of a STEP, `rootStep` (bytes in the app, a base64 record in the file), a primitive,
 * `rootPrimitive` (a new solid's few numbers, built again on open), or a feature, `rootFeature` (an extrude, a
 * revolve, a loft, a sheet, or a NURBS surface built against nothing). Old files have no `rootFeature`.
 */
export type SavedTree<Step> = SavedTreeBody & (
  | { rootStep: Step; rootPrimitive?: undefined; rootFeature?: undefined }
  | { rootPrimitive: PrimitiveSpec; rootStep?: undefined; rootFeature?: undefined }
  | { rootFeature: FeatureOp; rootStep?: undefined; rootPrimitive?: undefined }
);

export interface SavedTreeBody {
  nodes: SavedNode[];
  current: NodeId;
  committed: NodeId;
  nextId: NodeId;
  /**
   * --- A6. Expressions on a new solid's primitive root. Absent on a STEP or feature root,
   * and on a primitive whose sizes were all typed as numbers. A bad value is left out.
   */
  rootExprs?: Record<string, string>;
}

/**
 * The tree as it is saved, less its root. `owner` names the object whose saved tree has an engine key, if any: a split
 * names its piece, and a join its tool, by that object's id.
 */
export function savedTree(tree: ModelTree, committed: NodeId, owner: (key: string) => string | undefined): SavedTreeBody {
  const nodes = [...tree.nodes.values()]
    .sort((a, b) => a.id - b.id)
    .map((node) => {
      const piece = node.piece ? owner(node.piece) : undefined;
      const pieces = node.pieces?.map((key) => (key ? owner(key) ?? null : null));
      const pins = node.pins ? owner(node.pins) ?? null : undefined;
      // --- A8. A renamed step keeps its name. An MCP composite writes "prefix k/n" onto the label; that is kept
      // as the name too, so the app can fold those rows after the file opens. ---
      const name = savedName(node);
      return {
        id: node.id,
        parent: node.parent,
        op: node.op?.kind === "join" ? savedJoin(node.op, owner) : node.op,
        ...(name ? { name } : {}),
        fingerprint: node.fingerprint,
        ...(piece ? { piece } : {}),
        ...(pieces && pieces.length > 0 ? { pieces } : {}),
        ...(pins !== undefined ? { pins } : {}),
        ...(node.plugin ? { plugin: node.plugin } : {}),
        ...(node.run ? { run: node.run } : {}),
        ...(node.builtWith !== undefined ? { builtWith: node.builtWith } : {}),
      };
    });
  return { nodes, current: tree.current, committed, nextId: tree.nextId };
}

/** The name to keep: the user's name, or a label the op would not have produced on its own. */
function savedName(node: ModelNode): string {
  const named = node.name?.trim() ?? "";
  if (named) return named.slice(0, 80);
  if (!node.op) return "";
  const label = node.label.trim();
  if (!label || label === opLabel(node.op, partsOf(node))) return "";
  return label.slice(0, 80);
}

/**
 * A saved name is what this step is called. The MCP session reads `label`, so after a load the name is copied there
 * and a composite's "prefix k/n" reads as it did when it was built.
 */
export function withSavedNames(tree: ModelTree): ModelTree {
  let nodes: Map<NodeId, ModelNode> | null = null;
  for (const node of tree.nodes.values()) {
    if (!node.name || node.name === node.label) continue;
    nodes ??= new Map(tree.nodes);
    nodes.set(node.id, { ...node, label: node.name });
  }
  return nodes ? { ...tree, nodes } : tree;
}

function savedJoin({ op, tool, relative, keepTool }: JoinOp, owner: (key: string) => string | undefined): SavedJoin {
  return { kind: "join", op, tool: { object: owner(tool.key) ?? tool.object, node: tool.node, name: tool.name }, relative, keepTool };
}

/** The saved trees' object ids, each tree after the trees its joins take a tool from: the order they open in. */
export function toolFirst(saved: ReadonlyMap<string, SavedTreeBody>): string[] {
  const order: string[] = [];
  const placed = new Set<string>();
  const visit = (id: string) => {
    const tree = saved.get(id);
    if (!tree || placed.has(id)) return;
    placed.add(id);
    for (const tool of savedToolObjects(tree)) visit(tool);
    order.push(id);
  };
  for (const id of saved.keys()) visit(id);
  return order;
}

/**
 * The tree a project saved, under `key`. The plate holds `committed`, with `mesh`; the view opens
 * there too, and Redo from it leads to the step the view was on when saved. A tool's tree kept for
 * a join after its object left the plate has no `mesh`. `objectKey` gives the key each object's
 * tree opened under, for the pieces and tools the tree names.
 */
export function loadedTree(saved: SavedTreeBody, key: string, root: ModelRoot, fileLabel: string, mesh: PlateMesh | null, objectKey: (objectId: string) => string | undefined): ModelTree {
  const nodes = new Map<NodeId, ModelNode>();
  for (const node of saved.nodes) {
    const piece = node.piece ? objectKey(node.piece) : undefined;
    const pieces = node.pieces?.map((id) => (id ? objectKey(id) ?? null : null));
    const pins = node.pins ? objectKey(node.pins) ?? null : node.pins === null ? null : undefined;
    const op: ModelOp | null = node.op?.kind === "join" ? { ...node.op, tool: { object: node.op.tool.object, key: objectKey(node.op.tool.object) ?? "", node: node.op.tool.node, name: node.op.tool.name } } : node.op;
    nodes.set(node.id, {
      id: node.id,
      parent: node.parent,
      op,
      label: op ? opLabel(op, pieces ? pieces.length + 1 : undefined) : rootLabel(root, fileLabel),
      fingerprint: node.fingerprint,
      ...(node.name ? { name: node.name } : {}),
      ...(piece ? { piece } : {}),
      ...(pieces ? { pieces } : {}),
      ...(pins !== undefined ? { pins } : {}),
      ...(node.plugin ? { plugin: node.plugin } : {}),
      ...(node.run ? { run: node.run } : {}),
      ...(node.builtWith !== undefined ? { builtWith: node.builtWith } : {}),
      ...(mesh && node.id === saved.committed ? { mesh } : {}),
    });
  }
  const tree: ModelTree = { key, root, nodes, nextId: saved.nextId, current: saved.current, committed: saved.committed, lastChild: new Map() };
  return { ...jumped(tree, saved.current), current: saved.committed };
}

/** The saved tree, checked, with its root STEP as it was found. Null when anything in it is damaged. */
export function readSavedTree(value: unknown): SavedTree<unknown> | null {
  if (!isRecord(value) || !Array.isArray(value.nodes)) return null;
  const nodes: SavedNode[] = [];
  for (const raw of value.nodes) {
    const node = readNode(raw);
    if (!node) return null;
    nodes.push(node);
  }
  nodes.sort((a, b) => a.id - b.id);
  const ids = new Set<NodeId>();
  for (const node of nodes) {
    // Parents come first, so a parent always has the smaller id; only the root has none.
    if (ids.has(node.id) || (node.parent === null) !== (node.id === 0) || (node.parent !== null && !ids.has(node.parent))) return null;
    if ((node.op === null) !== (node.parent === null) || (node.piece !== undefined && node.op?.kind !== "split" && node.op?.kind !== "trimSplit")) return null;
    // --- Split to print. `pieces` belongs to a split to print as `piece` does to a split, and to nothing else.
    if ((node.pieces !== undefined || node.pins !== undefined) && node.op?.kind !== "partition") return null;
    // An edited primitive root is built again right under the root, and only there.
    if (node.op?.kind === "root" && node.parent !== 0) return null;
    ids.add(node.id);
  }
  const { current, committed, nextId } = value;
  if (!ids.has(0) || !isId(current) || !ids.has(current) || !isId(committed) || !ids.has(committed) || !isId(nextId)) return null;
  const body = { nodes, current, committed, nextId: Math.max(nextId, Math.max(...ids) + 1) };
  // --- K2 feature root. Exactly one of rootStep, rootPrimitive, rootFeature. A cut or intersect is kept so the file
  // round-trips; the engine refuses it on open. ---
  if (value.rootFeature != null) {
    if (value.rootPrimitive != null || value.rootStep !== undefined) return null;
    const op = readOp(value.rootFeature);
    if (!op || (op.kind !== "extrude" && op.kind !== "revolve" && op.kind !== "loft" && op.kind !== "sweep" && op.kind !== "sheet" && op.kind !== "nurbsSurface")) return null;
    return { ...body, rootFeature: op };
  }
  if (value.rootPrimitive != null) {
    // A primitive the app would not build is as damaged as a missing STEP: the part opens from its mesh.
    const solid = value.rootStep === undefined ? readPrimitive(value.rootPrimitive) : undefined;
    if (!solid || primitiveMesh(solid).length === 0) return null;
    const rootExprs = readExprs(value.rootExprs);
    return { ...body, rootPrimitive: solid, ...(rootExprs ? { rootExprs } : {}) };
  }
  if (value.rootStep === undefined) return null;
  return { ...body, rootStep: value.rootStep };
}

function readNode(value: unknown): SavedNode | null {
  if (!isRecord(value) || !isId(value.id)) return null;
  const parent = value.parent === null ? null : isId(value.parent) ? value.parent : undefined;
  if (parent === undefined) return null;
  const op = value.op === null ? null : readOp(value.op);
  if (op === undefined) return null;
  const fingerprint = value.fingerprint === null || value.fingerprint === undefined ? null : readFingerprint(value.fingerprint);
  if (fingerprint === undefined) return null;
  if (value.name !== undefined && typeof value.name !== "string") return null;
  if (value.piece !== undefined && (typeof value.piece !== "string" || !value.piece)) return null;
  const pieces = value.pieces === undefined ? undefined : readPieces(value.pieces);
  if (pieces === null) return null;
  if (value.pins !== undefined && value.pins !== null && (typeof value.pins !== "string" || !value.pins)) return null;
  const name = typeof value.name === "string" ? value.name.trim() : "";
  // A damaged stamp or run mark is left out: the step still opens as built, only as a plain step.
  const plugin = value.plugin === undefined ? undefined : readStamp(value.plugin);
  const run = value.run === undefined ? undefined : readRun(value.run);
  return {
    id: value.id,
    parent,
    op,
    ...(name ? { name } : {}),
    fingerprint,
    ...(typeof value.piece === "string" ? { piece: value.piece } : {}),
    ...(pieces ? { pieces } : {}),
    ...(value.pins !== undefined ? { pins: value.pins as string | null } : {}),
    ...(plugin ? { plugin } : {}),
    ...(run ? { run } : {}),
    ...(isId(value.builtWith) ? { builtWith: value.builtWith } : {}),
  };
}

/** --- Plugin steps (D8). A stamp as saved; undefined when any field is damaged. */
export function readStamp(value: unknown): PluginStamp | undefined {
  if (!isRecord(value) || typeof value.plugin !== "string" || !value.plugin || value.plugin.length > 80) return undefined;
  if (!isId(value.version) || typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256) || typeof value.api !== "string" || !/^\d+\.\d+$/.test(value.api)) return undefined;
  if (!isRecord(value.params) || !isRecord(value.context)) return undefined;
  const params: PluginStamp["params"] = {};
  for (const [key, raw] of Object.entries(value.params)) {
    // A picked face or outline (API 1.2) is kept as its JSON object.
    if (typeof raw === "boolean" || typeof raw === "string" || finite(raw) || (isRecord(raw) && JSON.stringify(raw).length <= 200_000)) params[key] = raw as PluginStamp["params"][string];
    else return undefined;
  }
  const bed = vec(value.context.bedMm);
  if (!bed || !finite(value.context.nozzleMm)) return undefined;
  const fingerprint = value.fingerprint === null || value.fingerprint === undefined ? null : readFingerprint(value.fingerprint);
  if (fingerprint === undefined) return undefined;
  const exprs = readExprs(value.exprs);
  const uses = readPins(value.uses);
  return { plugin: value.plugin, version: value.version, sha256: value.sha256, api: value.api, params, ...(exprs ? { exprs } : {}), context: { bedMm: bed, nozzleMm: value.context.nozzleMm as number }, fingerprint, ...(uses ? { uses } : {}) };
}

/** --- API 1.16. The plugins a run ran from inside it, pinned; undefined when absent or damaged (the stamp keeps the rest). */
export function readPins(value: unknown): PluginPins | undefined {
  if (!isRecord(value)) return undefined;
  const out: PluginPins = {};
  for (const [id, pin] of Object.entries(value)) {
    if (!id || id.length > 80 || !isRecord(pin) || !isId(pin.version) || typeof pin.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(pin.sha256)) return undefined;
    out[id] = { version: pin.version as number, sha256: pin.sha256 };
  }
  return Object.keys(out).length ? out : undefined;
}

function readRun(value: unknown): RunMark | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id || value.id.length > 64 || !isId(value.k) || !isId(value.n)) return undefined;
  const k = value.k as number;
  const n = value.n as number;
  return k >= 1 && k <= n ? { id: value.id, k, n } : undefined;
}

/** A split to print's pieces: one object id, or null, for each piece after the first. Null when damaged. */
function readPieces(value: unknown): (string | null)[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length >= MAX_PIECES_HARD_STOP) return null;
  return value.every((id) => id === null || (typeof id === "string" && id.length > 0)) ? [...value] as (string | null)[] : null;
}

/** --- Split to print. The printer a partition was cut for (D11). Undefined when absent, null when damaged. */
function readTarget(value: unknown): Target | null | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value.printer !== "string" || (value.process !== "fdm" && value.process !== "resin")) return null;
  const volumeMm = vec(value.volumeMm);
  return volumeMm ? { printer: value.printer, process: value.process, volumeMm } : null;
}

/** --- Split to print. One cut: a plane, and its U, profile and connectors as stored. Null when damaged. */
function readCut(value: unknown): CutInput | null {
  if (!isRecord(value)) return null;
  const origin = vec(value.origin);
  const normal = vec(value.normal);
  const u = value.u === undefined ? undefined : vec(value.u);
  if (!origin || !normal || u === null) return null;
  if (value.profile !== undefined && (!isRecord(value.profile) || typeof value.profile.kind !== "string")) return null;
  if (value.connectors !== undefined && !isRecord(value.connectors)) return null;
  return {
    origin,
    normal,
    ...(u ? { u } : {}),
    ...(value.profile !== undefined ? { profile: value.profile as unknown as Profile } : {}),
    ...(value.connectors !== undefined ? { connectors: value.connectors as CutInput["connectors"] } : {}),
  };
}

/** An op as the engine stores it, plus its expression text when that text is a record of strings. */
function readOp(value: unknown): SavedOp | undefined {
  const op = readOpBody(value);
  if (!op || !isRecord(value)) return op;
  const exprs = readExprs(value.exprs);
  return exprs ? { ...op, exprs } : op;
}

/** Field id → expression. Anything else is dropped, and the op still opens. */
function readExprs(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof key === "string" && key && typeof raw === "string" && raw.trim()) out[key] = raw;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** An op as the engine stores it. Fields the engine defaults may be absent, as there. */
function readOpBody(value: unknown): SavedOp | undefined {
  if (!isRecord(value)) return undefined;
  const origin = vec(value.origin);
  switch (value.kind) {
    case "boolean": {
      if (value.op !== "fuse" && value.op !== "cut" && value.op !== "common") return undefined;
      const tool = readPrimitive(value);
      if (value.merge !== undefined && typeof value.merge !== "boolean") return undefined;
      return tool ? { kind: "boolean", op: value.op, ...tool, ...(value.merge === true ? { merge: true } : {}) } : undefined;
    }
    case "hole": {
      const axis = value.axis === undefined ? [0, 0, 0] as Vec3 : vec(value.axis);
      if (!origin || !axis || !finite(value.radius) || !finite(value.depth)) return undefined;
      if (value.through !== undefined && typeof value.through !== "boolean") return undefined;
      // A counterbore is both its numbers or neither.
      const { counterboreRadius: boreR, counterboreDepth: boreD } = value;
      const bore = finite(boreR) && finite(boreD);
      if (!bore && (boreR !== undefined || boreD !== undefined)) return undefined;
      return {
        kind: "hole",
        origin,
        axis,
        radius: value.radius,
        depth: value.depth,
        ...(value.through === true ? { through: true as const } : {}),
        ...(bore ? { counterboreRadius: boreR, counterboreDepth: boreD } : {}),
      };
    }
    case "split": {
      const normal = vec(value.normal);
      if (!origin || !normal) return undefined;
      return { kind: "split", origin, normal };
    }
    case "fillet":
    case "chamfer": {
      if (!Array.isArray(value.edges) || value.edges.length === 0 || !finite(value.size)) return undefined;
      // The engine stores each edge as a reference; an op it did not echo back keeps the picked indices. A pick of an
      // earlier step's edges is kept as sent; the engine refuses one that names no step above this one.
      const edges: EdgePick[] = [];
      for (const raw of value.edges) {
        if (isId(raw)) {
          edges.push(raw);
          continue;
        }
        if (isRecord(raw) && raw.fromNode !== undefined) {
          if (!isId(raw.fromNode) || (raw.filter !== undefined && raw.filter !== "all" && raw.filter !== "convex" && raw.filter !== "concave")) return undefined;
          edges.push({ fromNode: raw.fromNode, ...(raw.filter !== undefined ? { filter: raw.filter } : {}) });
          continue;
        }
        const mid = isRecord(raw) ? vec(raw.mid) : null;
        if (!isRecord(raw) || !isId(raw.index) || !mid || !finite(raw.lengthMm)) return undefined;
        const sig = readEdgeSig(raw.sig);
        if (sig === null) return undefined;
        edges.push({ index: raw.index, mid, lengthMm: raw.lengthMm, ...(sig ? { sig } : {}) });
      }
      if (value.kind === "fillet") {
        const continuity = value.continuity === undefined ? undefined : value.continuity === "g1" || value.continuity === "g2" || value.continuity === "conic" ? (value.continuity as FilletContinuity) : null;
        if (continuity === null) return undefined;
        if (value.rho !== undefined && (!finite(value.rho) || value.rho < 0.05 || value.rho > 0.95)) return undefined;
        let variable: [number, number][] | undefined;
        if (value.variable !== undefined) {
          if (!Array.isArray(value.variable) || value.variable.length < 2) return undefined;
          const parsed = value.variable.map(pair);
          if (parsed.some((p) => !p || p[0] < 0 || p[0] > 1 || !(p[1] > 0))) return undefined;
          variable = parsed as [number, number][];
        }
        return {
          kind: "fillet",
          edges,
          size: value.size,
          ...(continuity && continuity !== "g1" ? { continuity } : {}),
          ...(finite(value.rho) ? { rho: value.rho } : {}),
          ...(variable ? { variable } : {}),
        };
      }
      // A chamfer by two sizes: the second distance or the angle, and which face takes the first. Absent when equal.
      const { size2, angleDeg, flip } = value;
      if ((size2 !== undefined && !finite(size2)) || (angleDeg !== undefined && !finite(angleDeg)) || (flip !== undefined && typeof flip !== "boolean")) return undefined;
      return {
        kind: "chamfer",
        edges,
        size: value.size,
        ...(size2 !== undefined ? { size2 } : {}),
        ...(angleDeg !== undefined ? { angleDeg } : {}),
        ...(flip === true ? { flip: true } : {}),
      };
    }
    case "scale":
      return finite(value.factor) ? { kind: "scale", factor: value.factor } : undefined;
    case "unify":
      return { kind: "unify" };
    case "join": {
      const tool = value.tool;
      const relative = readAffine(value.relative);
      if (value.op !== "fuse" && value.op !== "cut" && value.op !== "common") return undefined;
      if (!isRecord(tool) || typeof tool.object !== "string" || !tool.object || !isId(tool.node) || typeof tool.name !== "string") return undefined;
      if (!relative || !isRigid(relative) || (value.keepTool !== undefined && typeof value.keepTool !== "boolean")) return undefined;
      return { kind: "join", op: value.op, tool: { object: tool.object, node: tool.node, name: tool.name }, relative, keepTool: value.keepTool === true };
    }
    case "root": {
      const solid = readPrimitive(value);
      return solid && primitiveMesh(solid).length > 0 ? { kind: "root", ...solid } : undefined;
    }
    case "extrude":
    case "revolve": {
      if (value.op !== "fuse" && value.op !== "cut" && value.op !== "common") return undefined;
      const turn = value.turn === undefined ? ([0, 0, 0] as Vec3) : vec(value.turn);
      if (!origin || !turn) return undefined;
      // K1: `loops` may stand in for `profile`. A file with neither is the old refusal. Both, when well formed, are
      // kept so the engine can refuse them rather than the file dropping the tree.
      const loops = readLoops(value.loops);
      if (loops === null) return undefined;
      const profileGiven = value.profile !== undefined;
      let profile: Vec2[] | undefined;
      let shape: { smooth?: true; corners?: number[] } | null = {};
      if (profileGiven) {
        const parsed = Array.isArray(value.profile) ? value.profile.map(pair) : null;
        if (!parsed || parsed.length < 3 || parsed.some((point) => !point)) return undefined;
        shape = readProfileShape(value, parsed.length);
        if (!shape) return undefined;
        profile = parsed as Vec2[];
      } else if (value.smooth !== undefined || value.corners !== undefined) {
        shape = readProfileShape(value, 200);
        if (!shape) return undefined;
      }
      if (!loops && !profile) return undefined;
      const plane = { op: value.op as BooleanKind, origin, turn, ...(profile ? { profile } : {}), ...shape, ...(loops ? { loops } : {}) };
      if (value.kind === "extrude") {
        if (!finite(value.depth) || (value.symmetric !== undefined && typeof value.symmetric !== "boolean")) return undefined;
        // K3. Each new field is optional. A file from before they existed has none of them.
        if (value.depth2 !== undefined && !finite(value.depth2)) return undefined;
        if (value.draftDeg !== undefined && !finite(value.draftDeg)) return undefined;
        const upTo = readUpTo(value.upTo);
        if (upTo === null) return undefined;
        // --- F1. `sketch` is optional. A bad drawing is dropped and the extrude still opens. ---
        const sketch = value.sketch === undefined ? undefined : readSketch(value.sketch) ?? undefined;
        return {
          kind: "extrude",
          ...plane,
          depth: value.depth,
          ...(value.symmetric === true ? { symmetric: true as const } : {}),
          ...(finite(value.depth2) ? { depth2: value.depth2 } : {}),
          ...(finite(value.draftDeg) ? { draftDeg: value.draftDeg } : {}),
          ...(upTo !== undefined ? { upTo } : {}),
          ...(sketch ? { sketch } : {}),
        };
      }
      const axisOrigin = value.axisOrigin === undefined ? undefined : pair(value.axisOrigin);
      const axisDir = value.axisDir === undefined ? undefined : pair(value.axisDir);
      if (axisOrigin === null || axisDir === null || (value.angleDeg !== undefined && !finite(value.angleDeg))) return undefined;
      // --- F2. `sketch` is optional. A bad drawing is dropped and the revolve still opens. ---
      const sketch = value.sketch === undefined ? undefined : readSketch(value.sketch) ?? undefined;
      return {
        kind: "revolve",
        ...plane,
        ...(axisOrigin ? { axisOrigin } : {}),
        ...(axisDir ? { axisDir } : {}),
        ...(finite(value.angleDeg) ? { angleDeg: value.angleDeg } : {}),
        ...(sketch ? { sketch } : {}),
      };
    }
    case "loft": {
      if (value.op !== "fuse" && value.op !== "cut" && value.op !== "common") return undefined;
      if (!Array.isArray(value.sections) || value.sections.length < 2 || (value.ruled !== undefined && typeof value.ruled !== "boolean")) return undefined;
      if (value.closed !== undefined && typeof value.closed !== "boolean") return undefined;
      if (value.smoothing !== undefined && typeof value.smoothing !== "boolean") return undefined;
      // The kernel takes 2..10. A file written when 11 and 12 were accepted still opens, its loft capped at 10.
      if (value.maxDegree !== undefined && (!isId(value.maxDegree) || value.maxDegree < 2 || value.maxDegree > 12)) return undefined;
      const sections: LoftSection[] = [];
      for (const raw of value.sections) {
        const section = readSectionItem(raw);
        if (!section) return undefined;
        sections.push(section);
      }
      let guides: Curve3D[] | undefined;
      if (value.guides !== undefined) {
        if (!Array.isArray(value.guides)) return undefined;
        guides = [];
        for (const g of value.guides) {
          const curve = readCurve3D(g);
          if (!curve) return undefined;
          guides.push(curve);
        }
        if (guides.length === 0) guides = undefined;
      }
      const startCondition = value.startCondition === undefined ? undefined : readLoftBoundary(value.startCondition);
      if (value.startCondition !== undefined && !startCondition) return undefined;
      const endCondition = value.endCondition === undefined ? undefined : readLoftBoundary(value.endCondition);
      if (value.endCondition !== undefined && !endCondition) return undefined;
      // --- F3. `drawing` is optional. A bad drawing is dropped and the loft still opens. ---
      const drawing = value.drawing === undefined ? undefined : readLoftDrawing(value.drawing);
      return {
        kind: "loft",
        op: value.op,
        sections,
        ...(value.ruled === true ? { ruled: true as const } : {}),
        ...(guides ? { guides } : {}),
        ...(startCondition ? { startCondition } : {}),
        ...(endCondition ? { endCondition } : {}),
        ...(value.closed === true ? { closed: true as const } : {}),
        ...(value.smoothing === true ? { smoothing: true as const } : {}),
        ...(value.maxDegree !== undefined ? { maxDegree: Math.min(10, value.maxDegree as number) } : {}),
        ...(drawing ? { drawing } : {}),
      };
    }
    case "sweep": {
      if (value.op !== "fuse" && value.op !== "cut" && value.op !== "common") return undefined;
      if (!Array.isArray(value.sections) || value.sections.length < 1) return undefined;
      const sections: LoftSection[] = [];
      for (const raw of value.sections) {
        const section = readSectionItem(raw);
        if (!section) return undefined;
        sections.push(section);
      }
      const spine = readCurve3D(value.spine);
      if (!spine) return undefined;
      const mode = value.mode === undefined ? undefined : readSweepMode(value.mode);
      if (value.mode !== undefined && !mode) return undefined;
      const transition = value.transition === undefined ? undefined : value.transition === "round" || value.transition === "right" || value.transition === "transformed" ? (value.transition as SweepTransition) : null;
      if (transition === null) return undefined;
      let scale: [number, number][] | undefined;
      if (value.scale !== undefined) {
        if (!Array.isArray(value.scale) || value.scale.length < 2) return undefined;
        const parsed = value.scale.map(pair);
        if (parsed.some((p) => !p || !(p[1] > 0))) return undefined;
        scale = parsed as [number, number][];
      }
      if (value.twistDeg !== undefined && !finite(value.twistDeg)) return undefined;
      const capOf = (raw: unknown): "round" | "point" | undefined => raw === "round" || raw === "point" ? raw : undefined;
      if (value.capStart !== undefined && value.capStart !== "flat" && !capOf(value.capStart)) return undefined;
      if (value.capEnd !== undefined && value.capEnd !== "flat" && !capOf(value.capEnd)) return undefined;
      if (value.capLength !== undefined && (typeof value.capLength !== "number" || !Number.isFinite(value.capLength) || !(value.capLength > 0) || value.capLength > 1000)) return undefined;
      const drawing = value.drawing === undefined ? undefined : readLoftDrawing(value.drawing);
      return {
        kind: "sweep",
        op: value.op,
        sections,
        spine,
        ...(mode ? { mode } : {}),
        ...(transition ? { transition } : {}),
        ...(scale ? { scale } : {}),
        ...(finite(value.twistDeg) ? { twistDeg: value.twistDeg } : {}),
        ...(capOf(value.capStart) ? { capStart: capOf(value.capStart) } : {}),
        ...(capOf(value.capEnd) ? { capEnd: capOf(value.capEnd) } : {}),
        ...(typeof value.capLength === "number" ? { capLength: value.capLength } : {}),
        ...(drawing ? { drawing } : {}),
      };
    }
    case "sheet": {
      const spec = readSheetSpec(value);
      return spec ? { kind: "sheet", ...spec } : undefined;
    }
    case "sew": {
      if (value.tolerance !== undefined && (!finite(value.tolerance) || !(value.tolerance > 0))) return undefined;
      if (value.makeSolid !== undefined && typeof value.makeSolid !== "boolean") return undefined;
      if (value.capPlanar !== undefined && typeof value.capPlanar !== "boolean") return undefined;
      return {
        kind: "sew",
        ...(finite(value.tolerance) ? { tolerance: value.tolerance } : {}),
        ...(value.makeSolid === false ? { makeSolid: false } : {}),
        ...(value.capPlanar === true ? { capPlanar: true as const } : {}),
      };
    }
    case "thicken": {
      if (!finite(value.thickness) || !(value.thickness > 0)) return undefined;
      const direction = value.direction === undefined ? undefined : value.direction === "normal" || value.direction === "reverse" || value.direction === "both" ? (value.direction as ThickenDirection) : null;
      if (direction === null) return undefined;
      if (value.tolerance !== undefined && (!finite(value.tolerance) || !(value.tolerance > 0))) return undefined;
      return {
        kind: "thicken",
        thickness: value.thickness,
        ...(direction ? { direction } : {}),
        ...(finite(value.tolerance) ? { tolerance: value.tolerance } : {}),
      };
    }
    case "trimSplit": {
      const sheet = readSheetSpec(value.sheet);
      if (!sheet) return undefined;
      const keep = value.keep === undefined ? undefined : value.keep === "above" || value.keep === "below" || value.keep === "both" ? (value.keep as TrimKeep) : null;
      if (keep === null) return undefined;
      return { kind: "trimSplit", sheet, ...(keep ? { keep } : {}) };
    }
    case "replaceFace": {
      const face = readFacePick(value.face);
      const sheet = readSheetSpec(value.sheet);
      if (face === undefined || !sheet) return undefined;
      return { kind: "replaceFace", face, sheet };
    }
    case "splitFace": {
      if (!Array.isArray(value.faces) || value.faces.length === 0) return undefined;
      const faces: (number | FaceRef)[] = [];
      for (const raw of value.faces) {
        const f = readFacePick(raw);
        if (f === undefined) return undefined;
        faces.push(f);
      }
      const curve = readCurve3D(value.curve);
      if (!curve) return undefined;
      const direction = value.direction === undefined ? undefined : vec(value.direction);
      if (value.direction !== undefined && !direction) return undefined;
      return { kind: "splitFace", faces, curve, ...(direction ? { direction } : {}) };
    }
    case "shell": {
      if (!finite(value.thickness)) return undefined;
      if (value.openFaces === undefined) return { kind: "shell", thickness: value.thickness };
      if (!Array.isArray(value.openFaces)) return undefined;
      // The engine stores each open face as a reference, as it does a blend's edges.
      const openFaces: (number | FaceRef)[] = [];
      for (const raw of value.openFaces) {
        if (isId(raw)) {
          openFaces.push(raw);
          continue;
        }
        const mid = isRecord(raw) ? vec(raw.mid) : null;
        if (!isRecord(raw) || !isId(raw.index) || !mid || !finite(raw.areaMm2)) return undefined;
        openFaces.push({ index: raw.index, mid, areaMm2: raw.areaMm2 });
      }
      return { kind: "shell", thickness: value.thickness, ...(openFaces.length > 0 ? { openFaces } : {}) };
    }
    // --- A1 group: each step is an op, and `source` is kept as typed. Absent source stays absent. ---
    case "group": {
      if (typeof value.label !== "string" || !Array.isArray(value.steps) || value.steps.length === 0) return undefined;
      const steps: ModelOp[] = [];
      for (const raw of value.steps) {
        const step = readOp(raw);
        if (!step || step.kind === "join") return undefined;
        steps.push(step);
      }
      return { kind: "group", label: value.label, ...(value.source !== undefined ? { source: value.source } : {}), steps };
    }
    // --- Text with real fonts: the letters of a text group's one step, the font with its version. Optional fields stay absent.
    case "lettering": {
      const turn = value.turn === undefined ? ([0, 0, 0] as Vec3) : vec(value.turn);
      if ((value.op !== "fuse" && value.op !== "cut") || !origin || !turn) return undefined;
      if (typeof value.text !== "string" || !value.text || typeof value.font !== "string" || !value.font || !finite(value.height) || !finite(value.depth)) return undefined;
      const { style, spacing, lineSpacing, align, angleDeg, weight, strokeWidth, along, flip, wrap } = value;
      if (weight !== undefined && !finite(weight)) return undefined;
      if (strokeWidth !== undefined && !finite(strokeWidth)) return undefined;
      if (along !== undefined && along !== "around" && along !== "axis" && along !== "u" && along !== "v") return undefined;
      if (wrap !== undefined && wrap !== "project") return undefined;
      if (style !== undefined && style !== "regular" && style !== "bold" && style !== "italic" && style !== "bold-italic") return undefined;
      if (align !== undefined && align !== "left" && align !== "centre" && align !== "right") return undefined;
      if ((spacing !== undefined && !finite(spacing)) || (lineSpacing !== undefined && !finite(lineSpacing)) || (angleDeg !== undefined && !finite(angleDeg))) return undefined;
      return {
        kind: "lettering",
        op: value.op,
        origin,
        turn,
        text: value.text,
        font: value.font,
        ...(style !== undefined ? { style } : {}),
        height: value.height,
        depth: value.depth,
        ...(spacing !== undefined ? { spacing } : {}),
        ...(lineSpacing !== undefined ? { lineSpacing } : {}),
        ...(align !== undefined ? { align } : {}),
        ...(angleDeg !== undefined ? { angleDeg } : {}),
        ...(weight !== undefined ? { weight } : {}),
        ...(strokeWidth !== undefined ? { strokeWidth } : {}),
        ...(along !== undefined ? { along } : {}),
        ...(flip === true ? { flip: true as const } : {}),
        ...(wrap !== undefined ? { wrap } : {}),
      };
    }
    // --- K4: faceExtrude and moveFaces. Optional fields stay absent when unset. ---
    case "faceExtrude": {
      const face = readFacePick(value.face);
      if (!face || !finite(value.distance) || value.distance === 0) return undefined;
      if (value.draftDeg !== undefined && !finite(value.draftDeg)) return undefined;
      const upTo = value.upTo === undefined ? undefined : readFacePick(value.upTo);
      if (value.upTo !== undefined && upTo === undefined) return undefined;
      return {
        kind: "faceExtrude",
        face,
        distance: value.distance,
        ...(finite(value.draftDeg) && value.draftDeg !== 0 ? { draftDeg: value.draftDeg } : {}),
        ...(upTo !== undefined ? { upTo } : {}),
      };
    }
    case "moveFaces": {
      if (!Array.isArray(value.faces) || value.faces.length === 0) return undefined;
      const faces: { face: number | FaceRef; distance: number }[] = [];
      for (const raw of value.faces) {
        if (!isRecord(raw) || !finite(raw.distance) || raw.distance === 0) return undefined;
        const face = readFacePick(raw.face);
        if (!face) return undefined;
        faces.push({ face, distance: raw.distance });
      }
      return { kind: "moveFaces", faces };
    }
    case "draft": {
      if (!Array.isArray(value.faces) || value.faces.length < 1 || value.faces.length > 50) return undefined;
      if (!finite(value.angleDeg) || value.angleDeg === 0 || value.angleDeg < -30 || value.angleDeg > 30) return undefined;
      const faces: (number | FaceRef)[] = [];
      for (const raw of value.faces) {
        const face = readFacePick(raw);
        if (face === undefined) return undefined;
        faces.push(face);
      }
      const pull = value.pull === undefined ? undefined : vec(value.pull);
      if (value.pull !== undefined && !pull) return undefined;
      if (pull && Math.hypot(pull[0], pull[1], pull[2]) < 1e-9) return undefined;
      const neutral = value.neutral === undefined ? undefined : readNeutral(value.neutral);
      if (value.neutral !== undefined && neutral === undefined) return undefined;
      return { kind: "draft", faces, angleDeg: value.angleDeg, ...(pull ? { pull } : {}), ...(neutral !== undefined ? { neutral } : {}) };
    }
    // --- Split to print. The fields a later milestone builds are kept as stored, so the file round-trips. ---
    case "partition": {
      if (!Array.isArray(value.cuts) || value.cuts.length === 0 || value.cuts.length >= MAX_PIECES_HARD_STOP) return undefined;
      const cuts: CutInput[] = [];
      for (const raw of value.cuts) {
        const cut = readCut(raw);
        if (!cut) return undefined;
        cuts.push(cut);
      }
      const target = readTarget(value.target);
      if (target === null) return undefined;
      const orient = value.orient;
      const orientOk = orient === undefined || orient === "keep" || (Array.isArray(orient) && orient.every((one) => one === "keep" || one === "joint"));
      if (!orientOk || (value.arrange !== undefined && typeof value.arrange !== "boolean") || (value.labels !== undefined && !isRecord(value.labels))) return undefined;
      if ((value.bedMarginMm !== undefined && !finite(value.bedMarginMm)) || (value.maxPieces !== undefined && !finite(value.maxPieces))) return undefined;
      const up = value.up === undefined ? undefined : vec(value.up);
      if (up === null) return undefined;
      return {
        kind: "partition",
        cuts,
        ...(target ? { target } : {}),
        ...(orient !== undefined ? { orient: (Array.isArray(orient) ? [...orient] : orient) as PartitionModelOp["orient"] } : {}),
        ...(typeof value.arrange === "boolean" ? { arrange: value.arrange } : {}),
        ...(isRecord(value.labels) ? { labels: value.labels as Labels } : {}),
        ...(finite(value.bedMarginMm) ? { bedMarginMm: value.bedMarginMm } : {}),
        ...(finite(value.maxPieces) ? { maxPieces: value.maxPieces } : {}),
        ...(up ? { up } : {}),
      };
    }
    case "patch": {
      const boundaries = readBoundaries(value.boundaries);
      if (!boundaries) return undefined;
      const guides = value.guides === undefined ? undefined : readCurves(value.guides);
      if (value.guides !== undefined && !guides) return undefined;
      const points = value.points === undefined ? undefined : readPoints(value.points);
      if (value.points !== undefined && !points) return undefined;
      if (value.tolerance !== undefined && (!finite(value.tolerance) || !(value.tolerance > 0))) return undefined;
      return {
        kind: "patch",
        boundaries,
        ...(guides ? { guides } : {}),
        ...(points ? { points } : {}),
        ...(finite(value.tolerance) ? { tolerance: value.tolerance } : {}),
      };
    }
    case "blendSurface": {
      const a = readBoundary(value.a);
      const b = readBoundary(value.b);
      if (!a || !b) return undefined;
      const continuity = readContinuity(value.continuity);
      if (continuity === null || continuity === "g0") return undefined;
      if (value.tensionA !== undefined && !finite(value.tensionA)) return undefined;
      if (value.tensionB !== undefined && !finite(value.tensionB)) return undefined;
      if (value.tolerance !== undefined && (!finite(value.tolerance) || !(value.tolerance > 0))) return undefined;
      return {
        kind: "blendSurface",
        a,
        b,
        ...(continuity ? { continuity } : {}),
        ...(finite(value.tensionA) ? { tensionA: value.tensionA } : {}),
        ...(finite(value.tensionB) ? { tensionB: value.tensionB } : {}),
        ...(finite(value.tolerance) ? { tolerance: value.tolerance } : {}),
      };
    }
    case "nurbsSurface": {
      // --- S6. Up to 64 poles each way, the schema's cap (a curve's point list stops at 50).
      if (!Array.isArray(value.poles) || value.poles.length < 1 || value.poles.length > 64) return undefined;
      const poles: Vec3[][] = [];
      for (const raw of value.poles) {
        const row = readPoints(raw, 64);
        if (!row || row.length < 1) return undefined;
        poles.push(row);
      }
      const nv = poles[0]!.length;
      if (poles.some((row) => row.length !== nv)) return undefined;
      const weights = value.weights === undefined ? undefined : readWeightGrid(value.weights, poles.length, nv);
      if (value.weights !== undefined && !weights) return undefined;
      const degreeU = optionalInt(value.degreeU);
      const degreeV = optionalInt(value.degreeV);
      if (value.degreeU !== undefined && degreeU === undefined) return undefined;
      if (value.degreeV !== undefined && degreeV === undefined) return undefined;
      const knotsU = optionalNumbers(value.knotsU);
      const knotsV = optionalNumbers(value.knotsV);
      const multsU = optionalInts(value.multsU);
      const multsV = optionalInts(value.multsV);
      if (value.knotsU !== undefined && !knotsU) return undefined;
      if (value.knotsV !== undefined && !knotsV) return undefined;
      if (value.multsU !== undefined && !multsU) return undefined;
      if (value.multsV !== undefined && !multsV) return undefined;
      // --- S6. Knot insertion and degree elevation the kernel applies on open, as the schema takes them. The app bakes
      // them into the grid before it stores an op, so only an older or hand-written file carries them; they are kept.
      const insertU = value.insertU === undefined ? undefined : readInsertPairs(value.insertU);
      const insertV = value.insertV === undefined ? undefined : readInsertPairs(value.insertV);
      if (value.insertU !== undefined && !insertU) return undefined;
      if (value.insertV !== undefined && !insertV) return undefined;
      const elevateU = optionalInt(value.elevateU);
      const elevateV = optionalInt(value.elevateV);
      if (value.elevateU !== undefined && elevateU === undefined) return undefined;
      if (value.elevateV !== undefined && elevateV === undefined) return undefined;
      return {
        kind: "nurbsSurface",
        poles,
        ...(weights ? { weights } : {}),
        ...(degreeU !== undefined ? { degreeU } : {}),
        ...(degreeV !== undefined ? { degreeV } : {}),
        ...(knotsU ? { knotsU } : {}),
        ...(multsU ? { multsU } : {}),
        ...(knotsV ? { knotsV } : {}),
        ...(multsV ? { multsV } : {}),
        ...(value.periodicU === true ? { periodicU: true } : {}),
        ...(value.periodicV === true ? { periodicV: true } : {}),
        ...(insertU && insertU.length > 0 ? { insertU } : {}),
        ...(insertV && insertV.length > 0 ? { insertV } : {}),
        ...(elevateU !== undefined ? { elevateU } : {}),
        ...(elevateV !== undefined ? { elevateV } : {}),
      };
    }
    default:
      return undefined;
  }
}

function optionalInt(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : undefined;
}

function optionalNumbers(value: unknown): number[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "number" || !Number.isFinite(item))) return undefined;
  return [...value];
}

function optionalInts(value: unknown): number[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "number" || !Number.isInteger(item) || item < 1)) return undefined;
  return [...value];
}

/** `[parameter, times]` pairs, each a finite number and a count of at least 1. */
function readInsertPairs(value: unknown): [number, number][] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: [number, number][] = [];
  for (const pair of value) {
    if (!Array.isArray(pair) || pair.length !== 2) return undefined;
    const [param, times] = pair as unknown[];
    if (typeof param !== "number" || !Number.isFinite(param) || typeof times !== "number" || !Number.isInteger(times) || times < 1) return undefined;
    out.push([param, times]);
  }
  return out;
}

function readWeightGrid(value: unknown, nu: number, nv: number): number[][] | undefined {
  if (!Array.isArray(value) || value.length !== nu) return undefined;
  const weights: number[][] = [];
  for (const raw of value) {
    if (!Array.isArray(raw) || raw.length !== nv || raw.some((item) => typeof item !== "number" || !(item > 0))) return undefined;
    weights.push([...raw]);
  }
  return weights;
}

/** A primitive as the engine stores it. Fields it defaults may be absent; the newer ones are kept only when there. */
function readPrimitive(value: unknown): PrimitiveSpec | undefined {
  if (!isRecord(value) || !isPrimitiveKind(value.primitive)) return undefined;
  const origin = vec(value.origin);
  const size = value.size === undefined ? [0, 0, 0] as Vec3 : vec(value.size);
  const turn = value.turn === undefined ? [0, 0, 0] as Vec3 : vec(value.turn);
  const radius = value.radius === undefined ? 0 : value.radius;
  const height = value.height === undefined ? 0 : value.height;
  if (!origin || !size || !turn || !finite(radius) || !finite(height)) return undefined;
  const spec: PrimitiveSpec = { primitive: value.primitive, origin, size, radius, height, turn };
  // A gear's numbers (src/model-gear.ts) ride with the same rule: kept only when there.
  for (const key of ["topRadius", "tubeRadius", "innerRadius", "topX", "sides", "across", "cornerRadius", "teeth", "module", "pressureDeg", "backlash", "profileShift", "phaseDeg", "bore", "boreFlat", "hubDiameter", "hubHeight", "rim", "back"] as const) {
    const raw = value[key];
    if (raw === undefined) continue;
    if (!finite(raw)) return undefined;
    spec[key] = raw;
  }
  if (value.flats !== undefined) {
    if (typeof value.flats !== "boolean") return undefined;
    spec.flats = value.flats;
  }
  if (value.boreShape !== undefined) {
    if (!isBoreShape(value.boreShape)) return undefined;
    spec.boreShape = value.boreShape;
  }
  // A ring gear (docs/plan-gear-kinds.md, stage 2). An older app drops the flag and builds an external gear there.
  if (value.internal !== undefined) {
    if (typeof value.internal !== "boolean") return undefined;
    if (value.internal) spec.internal = true;
  }
  // A rack (stage 3); an older app drops the flag and builds a spur gear of those numbers there.
  if (value.rack !== undefined) {
    if (typeof value.rack !== "boolean") return undefined;
    if (value.rack) spec.rack = true;
  }
  // A fastener (docs/plan-mech-parts.md). Dropping these would make the mesh empty and the history unreadable.
  if (value.partKind !== undefined) {
    if (!isPartKind(value.partKind)) return undefined;
    spec.partKind = value.partKind;
  }
  if (value.nominal !== undefined) {
    if (typeof value.nominal !== "string") return undefined;
    spec.nominal = value.nominal;
  }
  if (value.section !== undefined) {
    if (typeof value.section !== "string") return undefined;
    spec.section = value.section;
  }
  for (const key of ["allowance", "length", "headDiameter", "headHeight", "socketDepth", "diameter", "taper", "setScrew", "holes", "pitchCircle", "grooves"] as const) {
    const raw = value[key];
    if (raw === undefined) continue;
    if (!finite(raw)) return undefined;
    spec[key] = raw;
  }
  if (value.boreKind !== undefined) {
    if (value.boreKind !== "tap" && value.boreKind !== "thread") return undefined;
    spec.boreKind = value.boreKind;
  }
  if (value.hollow !== undefined) {
    if (typeof value.hollow !== "boolean") return undefined;
    spec.hollow = value.hollow;
  }
  if (value.fit !== undefined) {
    if (value.fit !== "running" && value.fit !== "sliding" && value.fit !== "press") return undefined;
    spec.fit = value.fit;
  }
  if (value.article !== undefined) {
    if (typeof value.article !== "string") return undefined;
    spec.article = value.article;
  }
  if (value.holeFor !== undefined) {
    if (typeof value.holeFor !== "string") return undefined;
    spec.holeFor = value.holeFor;
  }
  return spec;
}

/** An edge's stored signature: undefined when there is none (an edge stored before them), null when it is malformed. */
function readEdgeSig(value: unknown): EdgeSig | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !isId(value.curve) || !Array.isArray(value.kinds) || value.kinds.length !== 2 || !value.kinds.every(isId)) return null;
  const dir = vec(value.dir);
  const normals = Array.isArray(value.normals) && value.normals.length === 2 ? value.normals.map(vec) : null;
  if (!dir || !normals || normals.some((normal) => !normal)) return null;
  return { curve: value.curve as number, dir, kinds: [value.kinds[0] as number, value.kinds[1] as number], normals: [normals[0]!, normals[1]!] };
}

function readFingerprint(value: unknown): Fingerprint | undefined {
  if (!isRecord(value) || !finite(value.volumeMm3) || !isId(value.faces) || !isId(value.edges)) return undefined;
  return { volumeMm3: value.volumeMm3, faces: value.faces as number, edges: value.edges as number };
}

function readAffine(value: unknown): Affine | null {
  if (!isRecord(value) || !Array.isArray(value.m) || value.m.length !== 9 || !value.m.every(finite)) return null;
  const t = vec(value.t);
  return t ? { m: [...value.m] as Affine["m"], t } : null;
}

/** A profile's smooth and corners fields, as the engine stores them: absent when off. Null when either is malformed. */
function readProfileShape(value: Record<string, unknown>, points: number): { smooth?: true; corners?: number[] } | null {
  if (value.smooth !== undefined && typeof value.smooth !== "boolean") return null;
  if (value.corners === undefined) return value.smooth === true ? { smooth: true } : {};
  if (!Array.isArray(value.corners) || !value.corners.every((corner) => isId(corner) && corner < points)) return null;
  return { ...(value.smooth === true ? { smooth: true as const } : {}), ...(value.corners.length > 0 ? { corners: [...value.corners] as number[] } : {}) };
}

/** K3. A face an extrude stops at: a fresh index, or the reference the engine stored. Undefined when the field is absent, null when it is malformed. */
function readUpTo(raw: unknown): number | FaceRef | null | undefined {
  if (raw === undefined) return undefined;
  if (isId(raw)) return raw;
  if (!isRecord(raw) || !isId(raw.index)) return null;
  const mid = vec(raw.mid);
  if (!mid || !finite(raw.areaMm2)) return null;
  return { index: raw.index, mid, areaMm2: raw.areaMm2 };
}

/**
 * K1 loops, or null when the field is present and malformed. Undefined when it is absent or empty, so an old file
 * reads with no `loops` key.
 */
function readLoops(value: unknown): ProfileLoop[] | null | undefined {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) return undefined;
  if (!Array.isArray(value) || value.length > 32) return null;
  const loops: ProfileLoop[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || !Array.isArray(raw.segments) || raw.segments.length < 1 || raw.segments.length > 200) return null;
    const start = pair(raw.start);
    if (!start) return null;
    const segments: ProfileSegment[] = [];
    for (const seg of raw.segments) {
      if (!isRecord(seg)) return null;
      const to = pair(seg.to);
      if (!to) return null;
      if (seg.kind === "line") {
        if (seg.through !== undefined) return null;
        segments.push({ kind: "line", to });
      } else if (seg.kind === "arc") {
        const through = pair(seg.through);
        if (!through) return null;
        segments.push({ kind: "arc", through, to });
      } else if (seg.kind === "spline") {
        if (!Array.isArray(seg.through) || seg.through.length < 1 || seg.through.length > SPLINE_THROUGH_MAX) return null;
        const through: Vec2[] = [];
        for (const point of seg.through) {
          const at = pair(point);
          if (!at) return null;
          through.push(at);
        }
        segments.push({ kind: "spline", through, to });
      } else if (seg.kind === "nurbs") {
        const nurbs = readNurbs2DFields(seg);
        if (!nurbs) return null;
        segments.push({ kind: "nurbs", ...nurbs, to });
      } else {
        return null;
      }
    }
    loops.push({ start, segments });
  }
  return loops;
}

function readSheetSpec(value: unknown): SheetSpec | null {
  if (!isRecord(value)) return null;
  if (value.mode !== "extrude" && value.mode !== "revolve" && value.mode !== "loft" && value.mode !== "planar") return null;
  if (!Array.isArray(value.curves) || value.curves.length < 1) return null;
  const curves: Curve3D[] = [];
  for (const raw of value.curves) {
    const curve = readCurve3D(raw);
    if (!curve) return null;
    curves.push(curve);
  }
  const dir = value.dir === undefined ? undefined : vec(value.dir);
  if (value.dir !== undefined && !dir) return null;
  if (value.distance !== undefined && !finite(value.distance)) return null;
  const axisOrigin = value.axisOrigin === undefined ? undefined : vec(value.axisOrigin);
  if (value.axisOrigin !== undefined && !axisOrigin) return null;
  if (value.angleDeg !== undefined && !finite(value.angleDeg)) return null;
  if (value.ruled !== undefined && typeof value.ruled !== "boolean") return null;
  if (value.symmetric !== undefined && typeof value.symmetric !== "boolean") return null;
  return {
    mode: value.mode as SheetMode,
    curves,
    ...(dir ? { dir } : {}),
    ...(finite(value.distance) ? { distance: value.distance } : {}),
    ...(axisOrigin ? { axisOrigin } : {}),
    ...(finite(value.angleDeg) ? { angleDeg: value.angleDeg } : {}),
    ...(value.ruled === true ? { ruled: true as const } : {}),
    ...(value.symmetric === true ? { symmetric: true as const } : {}),
  };
}

function readLoftBoundary(value: unknown): LoftBoundary | null {
  if (!isRecord(value)) return null;
  if (value.kind === "free") return { kind: "free" };
  const tension = value.tension === undefined ? undefined : finite(value.tension) && value.tension > 0 ? value.tension : null;
  if (tension === null) return null;
  if (value.kind === "normal") return { kind: "normal", ...(tension !== undefined ? { tension } : {}) };
  if (value.kind === "tangent") {
    const dir = vec(value.dir);
    if (!dir) return null;
    return { kind: "tangent", dir, ...(tension !== undefined ? { tension } : {}) };
  }
  if (value.kind === "curvature") {
    const dir = value.dir === undefined ? undefined : vec(value.dir);
    if (value.dir !== undefined && !dir) return null;
    return { kind: "curvature", ...(dir ? { dir } : {}), ...(tension !== undefined ? { tension } : {}) };
  }
  return null;
}

function readSectionItem(raw: unknown): LoftSection | null {
  if (!isRecord(raw)) return null;
  if (raw.apex !== undefined) {
    const apex = vec(raw.apex);
    if (!apex) return null;
    return { origin: [...apex] as Vec3, turn: [0, 0, 0], apex };
  }
  const at = vec(raw.origin);
  const turn = raw.turn === undefined ? ([0, 0, 0] as Vec3) : vec(raw.turn);
  if (!at || !turn) return null;
  const loops = readLoops(raw.loops);
  if (loops === null) return null;
  if (!loops && finite(raw.radius)) {
    if (raw.radiusV !== undefined && !finite(raw.radiusV)) return null;
    return { origin: at, turn, radius: raw.radius, ...(finite(raw.radiusV) ? { radiusV: raw.radiusV } : {}) };
  }
  if (!loops) {
    const profile = Array.isArray(raw.profile) ? raw.profile.map(pair) : null;
    if (!profile || profile.length < 3 || profile.some((point) => !point)) return null;
    const shape = readProfileShape(raw, profile.length);
    if (!shape) return null;
    return { origin: at, turn, profile: profile as Vec2[], ...shape };
  }
  const section: LoftSection = { origin: at, turn };
  if (finite(raw.radius)) {
    if (raw.radiusV !== undefined && !finite(raw.radiusV)) return null;
    section.radius = raw.radius;
    if (finite(raw.radiusV)) section.radiusV = raw.radiusV;
  }
  if (raw.profile !== undefined) {
    const profile = Array.isArray(raw.profile) ? raw.profile.map(pair) : null;
    if (!profile || profile.length < 3 || profile.some((point) => !point)) return null;
    const shape = readProfileShape(raw, profile.length);
    if (!shape) return null;
    section.profile = profile as Vec2[];
    Object.assign(section, shape);
  } else if (raw.smooth !== undefined || raw.corners !== undefined) {
    const shape = readProfileShape(raw, 200);
    if (!shape) return null;
    Object.assign(section, shape);
  }
  section.loops = loops;
  return section;
}

function readNurbsMeta(raw: Record<string, unknown>): { weights?: number[]; degree?: number; knots?: number[]; mults?: number[] } | null {
  let weights: number[] | undefined;
  if (raw.weights !== undefined) {
    if (!Array.isArray(raw.weights) || raw.weights.some((w) => !finite(w) || !(w > 0))) return null;
    weights = [...raw.weights];
  }
  let degree: number | undefined;
  if (raw.degree !== undefined) {
    if (!Number.isInteger(raw.degree) || (raw.degree as number) < 1 || (raw.degree as number) > 10) return null;
    degree = raw.degree as number;
  }
  let knots: number[] | undefined;
  if (raw.knots !== undefined) {
    if (!Array.isArray(raw.knots) || raw.knots.some((k) => !finite(k))) return null;
    knots = [...raw.knots];
  }
  let mults: number[] | undefined;
  if (raw.mults !== undefined) {
    if (!Array.isArray(raw.mults) || raw.mults.some((m) => !Number.isInteger(m) || (m as number) < 1)) return null;
    mults = [...raw.mults] as number[];
  }
  return { ...(weights ? { weights } : {}), ...(degree !== undefined ? { degree } : {}), ...(knots ? { knots } : {}), ...(mults ? { mults } : {}) };
}

function readNurbs2DFields(raw: Record<string, unknown>): { poles?: Vec2[]; weights?: number[]; degree?: number; knots?: number[]; mults?: number[] } | null {
  const meta = readNurbsMeta(raw);
  if (!meta) return null;
  let poles: Vec2[] | undefined;
  if (raw.poles !== undefined) {
    if (!Array.isArray(raw.poles) || raw.poles.length > SPLINE_THROUGH_MAX) return null;
    const parsed = raw.poles.map(pair);
    if (parsed.some((p) => !p)) return null;
    poles = parsed as Vec2[];
  }
  return { ...(poles ? { poles } : {}), ...meta };
}

function readEdgePickList(value: unknown): EdgePick[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const edges: EdgePick[] = [];
  for (const raw of value) {
    if (isId(raw)) {
      edges.push(raw);
      continue;
    }
    if (isRecord(raw) && raw.fromNode !== undefined) {
      if (!isId(raw.fromNode) || (raw.filter !== undefined && raw.filter !== "all" && raw.filter !== "convex" && raw.filter !== "concave")) return null;
      edges.push({ fromNode: raw.fromNode, ...(raw.filter !== undefined ? { filter: raw.filter } : {}) });
      continue;
    }
    const mid = isRecord(raw) ? vec(raw.mid) : null;
    if (!isRecord(raw) || !isId(raw.index) || !mid || !finite(raw.lengthMm)) return null;
    const sig = readEdgeSig(raw.sig);
    if (sig === null) return null;
    edges.push({ index: raw.index, mid, lengthMm: raw.lengthMm, ...(sig ? { sig } : {}) });
  }
  return edges;
}

function readCurve3D(value: unknown): Curve3D | null {
  if (!isRecord(value)) return null;
  if (value.kind === "polyline") {
    if (!Array.isArray(value.points) || value.points.length < 2) return null;
    const points = value.points.map(vec);
    if (points.some((p) => !p)) return null;
    return { kind: "polyline", points: points as Vec3[], ...(value.closed === true ? { closed: true as const } : {}) };
  }
  if (value.kind === "spline") {
    if (!Array.isArray(value.through) || value.through.length < 2) return null;
    const through = value.through.map(vec);
    if (through.some((p) => !p)) return null;
    return { kind: "spline", through: through as Vec3[], ...(value.closed === true ? { closed: true as const } : {}) };
  }
  if (value.kind === "nurbs") {
    if (!Array.isArray(value.poles) || value.poles.length < 2) return null;
    const poles = value.poles.map(vec);
    if (poles.some((p) => !p)) return null;
    const meta = readNurbsMeta(value);
    if (!meta) return null;
    return { kind: "nurbs", poles: poles as Vec3[], ...meta, ...(value.closed === true ? { closed: true as const } : {}) };
  }
  if (value.kind === "segments") {
    const start = vec(value.start);
    if (!start || !Array.isArray(value.segments) || value.segments.length < 1) return null;
    const segments: Curve3DSegment[] = [];
    for (const raw of value.segments) {
      if (!isRecord(raw)) return null;
      const to = vec(raw.to);
      if (!to) return null;
      if (raw.kind === "line") segments.push({ kind: "line", to });
      else if (raw.kind === "arc") {
        const through = vec(raw.through);
        if (!through) return null;
        segments.push({ kind: "arc", through, to });
      } else if (raw.kind === "spline") {
        if (!Array.isArray(raw.through) || raw.through.length < 1) return null;
        const through = raw.through.map(vec);
        if (through.some((p) => !p)) return null;
        segments.push({ kind: "spline", through: through as Vec3[], to });
      } else if (raw.kind === "nurbs") {
        const meta = readNurbsMeta(raw);
        if (!meta) return null;
        let poles: Vec3[] | undefined;
        if (raw.poles !== undefined) {
          if (!Array.isArray(raw.poles)) return null;
          const parsed = raw.poles.map(vec);
          if (parsed.some((p) => !p)) return null;
          poles = parsed as Vec3[];
        }
        segments.push({ kind: "nurbs", ...(poles ? { poles } : {}), ...meta, to });
      } else return null;
    }
    return { kind: "segments", start, segments };
  }
  if (value.kind === "edges") {
    const edges = readEdgePickList(value.edges);
    return edges ? { kind: "edges", edges } : null;
  }
  return null;
}

function readSweepMode(value: unknown): SweepMode | null {
  if (!isRecord(value)) return null;
  if (value.kind === "correctedFrenet") return { kind: "correctedFrenet" };
  if (value.kind === "frenet") return { kind: "frenet" };
  if (value.kind === "fixedBinormal") {
    const dir = vec(value.dir);
    return dir ? { kind: "fixedBinormal", dir } : null;
  }
  if (value.kind === "auxSpine") {
    const spine = readCurve3D(value.spine);
    if (!spine) return null;
    return {
      kind: "auxSpine",
      spine,
      ...(typeof value.curvilinear === "boolean" ? { curvilinear: value.curvilinear } : {}),
      ...(typeof value.keepContact === "boolean" ? { keepContact: value.keepContact } : {}),
    };
  }
  return null;
}

function pair(value: unknown): Vec2 | null {
  if (!Array.isArray(value) || value.length !== 2 || !value.every(finite)) return null;
  return [value[0], value[1]];
}

/** A draft's neutral face, or a plane. Undefined when the value is damaged. */
function readNeutral(value: unknown): DraftNeutral | undefined {
  if (isId(value)) return value;
  if (!isRecord(value)) return undefined;
  if (value.origin !== undefined || value.normal !== undefined) {
    const origin = vec(value.origin);
    const normal = vec(value.normal);
    if (!origin || !normal || Math.hypot(normal[0], normal[1], normal[2]) < 1e-9) return undefined;
    return { origin, normal };
  }
  return readFacePick(value);
}

function readContinuity(value: unknown): SurfaceContinuity | undefined | null {
  if (value === undefined) return undefined;
  if (value === "g0" || value === "g1" || value === "g2") return value;
  return null;
}

function readBoundary(value: unknown): SurfaceBoundary | undefined {
  if (!isRecord(value)) return undefined;
  const continuity = readContinuity(value.continuity);
  if (continuity === null) return undefined;
  let edges: EdgePick[] | undefined;
  if (value.edges !== undefined) {
    const read = readEdgePickList(value.edges);
    if (!read) return undefined;
    edges = read;
  }
  let curve: Curve3D | undefined;
  if (value.curve !== undefined) {
    const read = readCurve3D(value.curve);
    if (!read) return undefined;
    curve = read;
  }
  if (!edges && !curve) return undefined;
  const face = value.face === undefined ? undefined : readFacePick(value.face);
  if (value.face !== undefined && face === undefined) return undefined;
  return {
    ...(curve ? { curve } : {}),
    ...(edges ? { edges } : {}),
    ...(face !== undefined ? { face } : {}),
    ...(continuity ? { continuity } : {}),
  };
}

function readBoundaries(value: unknown): SurfaceBoundary[] | undefined {
  if (!Array.isArray(value) || value.length < 2 || value.length > 20) return undefined;
  const boundaries: SurfaceBoundary[] = [];
  for (const raw of value) {
    const bound = readBoundary(raw);
    if (!bound) return undefined;
    boundaries.push(bound);
  }
  return boundaries;
}

function readCurves(value: unknown): Curve3D[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) return undefined;
  const curves: Curve3D[] = [];
  for (const raw of value) {
    const curve = readCurve3D(raw);
    if (!curve) return undefined;
    curves.push(curve);
  }
  return curves;
}

function readPoints(value: unknown, most = 50): Vec3[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > most) return undefined;
  const points: Vec3[] = [];
  for (const raw of value) {
    const point = vec(raw);
    if (!point) return undefined;
    points.push(point);
  }
  return points;
}

/** K4. A face index, or the reference a stored step keeps. Undefined when the value is damaged. */
function readFacePick(value: unknown): number | FaceRef | undefined {
  if (isId(value)) return value;
  const mid = isRecord(value) ? vec(value.mid) : null;
  if (!isRecord(value) || !isId(value.index) || !mid || !finite(value.areaMm2)) return undefined;
  return { index: value.index, mid, areaMm2: value.areaMm2 };
}

function vec(value: unknown): Vec3 | null {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(finite)) return null;
  return [value[0], value[1], value[2]];
}

function isId(value: unknown): value is NodeId {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
