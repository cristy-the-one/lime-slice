/**
 * A Model history tree as `.lime` keeps it: the ops, names, and fingerprints of every node, which
 * node the view and the plate were on, and the root STEP. Engine keys are not saved: they name a
 * tree for one page load. A split names its piece by the piece's plate object id instead.
 */
import { jumped, opLabel, type EdgeRef, type Fingerprint, type ModelOp, type ModelRoot, type ModelTree, type ModelNode, type NodeId, type PlateMesh, type Vec3 } from "./model-tree.ts";

export interface SavedNode {
  id: NodeId;
  parent: NodeId | null;
  op: ModelOp | null;
  name?: string;
  fingerprint: Fingerprint | null;
  /** A split whose other piece is on the plate: that object's id. */
  piece?: string;
}

/** `Step` is the root STEP: bytes in the app, a base64 record in the file. */
export interface SavedTree<Step> {
  nodes: SavedNode[];
  current: NodeId;
  committed: NodeId;
  nextId: NodeId;
  rootStep: Step;
}

/** The tree as it is saved, less its root STEP. `pieceOwner` names the plate object a piece key belongs to, if any. */
export function savedTree(tree: ModelTree, committed: NodeId, pieceOwner: (key: string) => string | undefined): Omit<SavedTree<never>, "rootStep"> {
  const nodes = [...tree.nodes.values()]
    .sort((a, b) => a.id - b.id)
    .map((node) => {
      const owner = node.piece ? pieceOwner(node.piece) : undefined;
      return {
        id: node.id,
        parent: node.parent,
        op: node.op,
        ...(node.name ? { name: node.name } : {}),
        fingerprint: node.fingerprint,
        ...(owner ? { piece: owner } : {}),
      };
    });
  return { nodes, current: tree.current, committed, nextId: tree.nextId };
}

/**
 * The tree a project saved, under `key`. The plate holds `committed`, with `mesh`; the view opens
 * there too, and Redo from it leads to the step the view was on when saved.
 */
export function loadedTree(saved: SavedTree<unknown>, key: string, root: ModelRoot, rootLabel: string, mesh: PlateMesh, pieceKey: (objectId: string) => string | undefined): ModelTree {
  const nodes = new Map<NodeId, ModelNode>();
  for (const node of saved.nodes) {
    const piece = node.piece ? pieceKey(node.piece) : undefined;
    nodes.set(node.id, {
      id: node.id,
      parent: node.parent,
      op: node.op,
      label: node.op ? opLabel(node.op) : rootLabel,
      fingerprint: node.fingerprint,
      ...(node.name ? { name: node.name } : {}),
      ...(piece ? { piece } : {}),
      ...(node.id === saved.committed ? { mesh } : {}),
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
    if ((node.op === null) !== (node.parent === null)) return null;
    ids.add(node.id);
  }
  const { current, committed, nextId } = value;
  if (!ids.has(0) || !isId(current) || !ids.has(current) || !isId(committed) || !ids.has(committed) || !isId(nextId)) return null;
  if (value.rootStep === undefined) return null;
  return { nodes, current, committed, nextId: Math.max(nextId, Math.max(...ids) + 1), rootStep: value.rootStep };
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
  const name = typeof value.name === "string" ? value.name.trim() : "";
  return {
    id: value.id,
    parent,
    op,
    ...(name ? { name } : {}),
    fingerprint,
    ...(typeof value.piece === "string" ? { piece: value.piece } : {}),
  };
}

/** An op as the engine stores it. Fields the engine defaults may be absent, as there. */
function readOp(value: unknown): ModelOp | undefined {
  if (!isRecord(value)) return undefined;
  const origin = vec(value.origin);
  switch (value.kind) {
    case "boolean": {
      const size = value.size === undefined ? [0, 0, 0] as Vec3 : vec(value.size);
      const turn = value.turn === undefined ? [0, 0, 0] as Vec3 : vec(value.turn);
      const radius = value.radius === undefined ? 0 : value.radius;
      const height = value.height === undefined ? 0 : value.height;
      if (value.op !== "fuse" && value.op !== "cut" && value.op !== "common") return undefined;
      if (value.primitive !== "box" && value.primitive !== "cylinder" && value.primitive !== "sphere") return undefined;
      if (!origin || !size || !turn || !finite(radius) || !finite(height)) return undefined;
      return { kind: "boolean", op: value.op, primitive: value.primitive, origin, size, radius, height, turn };
    }
    case "hole": {
      const axis = value.axis === undefined ? [0, 0, 0] as Vec3 : vec(value.axis);
      if (!origin || !axis || !finite(value.radius) || !finite(value.depth)) return undefined;
      return { kind: "hole", origin, axis, radius: value.radius, depth: value.depth };
    }
    case "split": {
      const normal = vec(value.normal);
      if (!origin || !normal) return undefined;
      return { kind: "split", origin, normal };
    }
    case "fillet":
    case "chamfer": {
      if (!Array.isArray(value.edges) || value.edges.length === 0 || !finite(value.size)) return undefined;
      const edges: EdgeRef[] = [];
      for (const raw of value.edges) {
        const mid = isRecord(raw) ? vec(raw.mid) : null;
        if (!isRecord(raw) || !Number.isInteger(raw.index) || (raw.index as number) < 0 || !mid || !finite(raw.lengthMm)) return undefined;
        edges.push({ index: raw.index as number, mid, lengthMm: raw.lengthMm });
      }
      return { kind: value.kind, edges, size: value.size };
    }
    case "scale":
      return finite(value.factor) ? { kind: "scale", factor: value.factor } : undefined;
    default:
      return undefined;
  }
}

function readFingerprint(value: unknown): Fingerprint | undefined {
  if (!isRecord(value) || !finite(value.volumeMm3) || !Number.isInteger(value.faces) || !Number.isInteger(value.edges)) return undefined;
  return { volumeMm3: value.volumeMm3, faces: value.faces as number, edges: value.edges as number };
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
