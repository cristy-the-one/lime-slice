/**
 * A Model history tree as `.lime` keeps it: the ops, names, and fingerprints of every node, which
 * node the view and the plate were on, and the root STEP, or a new solid's root primitive. Engine keys are not saved: they name a
 * tree for one page load. A split names its piece by the piece's plate object id instead.
 */
import { isPrimitiveKind, primitiveMesh, type PrimitiveSpec } from "./model-primitive.ts";
import { jumped, opLabel, rootLabel, type EdgeRef, type Fingerprint, type ModelOp, type ModelRoot, type ModelTree, type ModelNode, type NodeId, type PlateMesh, type Vec3 } from "./model-tree.ts";

interface SavedNode {
  id: NodeId;
  parent: NodeId | null;
  op: ModelOp | null;
  name?: string;
  fingerprint: Fingerprint | null;
  /** A split whose other piece is on the plate: that object's id. */
  piece?: string;
}

/**
 * The root is a STEP, `rootStep` (bytes in the app, a base64 record in the file), or a primitive,
 * `rootPrimitive`: a new solid's few numbers, built again on open. Exactly one is there.
 */
export type SavedTree<Step> = SavedTreeBody & ({ rootStep: Step; rootPrimitive?: undefined } | { rootPrimitive: PrimitiveSpec; rootStep?: undefined });

export interface SavedTreeBody {
  nodes: SavedNode[];
  current: NodeId;
  committed: NodeId;
  nextId: NodeId;
}

/** The tree without its root, to give it another. */
export function treeBody({ nodes, current, committed, nextId }: SavedTreeBody): SavedTreeBody {
  return { nodes, current, committed, nextId };
}

/** The tree as it is saved, less its root. `pieceOwner` names the plate object a piece key belongs to, if any. */
export function savedTree(tree: ModelTree, committed: NodeId, pieceOwner: (key: string) => string | undefined): SavedTreeBody {
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
export function loadedTree(saved: SavedTreeBody, key: string, root: ModelRoot, fileLabel: string, mesh: PlateMesh, pieceKey: (objectId: string) => string | undefined): ModelTree {
  const nodes = new Map<NodeId, ModelNode>();
  for (const node of saved.nodes) {
    const piece = node.piece ? pieceKey(node.piece) : undefined;
    nodes.set(node.id, {
      id: node.id,
      parent: node.parent,
      op: node.op,
      label: node.op ? opLabel(node.op) : rootLabel(root, fileLabel),
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
    if ((node.op === null) !== (node.parent === null) || (node.piece !== undefined && node.op?.kind !== "split")) return null;
    ids.add(node.id);
  }
  const { current, committed, nextId } = value;
  if (!ids.has(0) || !isId(current) || !ids.has(current) || !isId(committed) || !ids.has(committed) || !isId(nextId)) return null;
  const body = { nodes, current, committed, nextId: Math.max(nextId, Math.max(...ids) + 1) };
  if (value.rootPrimitive != null) {
    // A primitive the app would not build is as damaged as a missing STEP: the part opens from its mesh.
    const solid = value.rootStep === undefined ? readPrimitive(value.rootPrimitive) : undefined;
    return solid && primitiveMesh(solid).length > 0 ? { ...body, rootPrimitive: solid } : null;
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
      if (value.op !== "fuse" && value.op !== "cut" && value.op !== "common") return undefined;
      const tool = readPrimitive(value);
      return tool ? { kind: "boolean", op: value.op, ...tool } : undefined;
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
      // The engine stores each edge as a reference; an op it did not echo back keeps the picked indices.
      const edges: (number | EdgeRef)[] = [];
      for (const raw of value.edges) {
        if (isId(raw)) {
          edges.push(raw);
          continue;
        }
        const mid = isRecord(raw) ? vec(raw.mid) : null;
        if (!isRecord(raw) || !isId(raw.index) || !mid || !finite(raw.lengthMm)) return undefined;
        edges.push({ index: raw.index, mid, lengthMm: raw.lengthMm });
      }
      return { kind: value.kind, edges, size: value.size };
    }
    case "scale":
      return finite(value.factor) ? { kind: "scale", factor: value.factor } : undefined;
    default:
      return undefined;
  }
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
  for (const key of ["topRadius", "tubeRadius", "innerRadius", "topX", "sides", "across"] as const) {
    const raw = value[key];
    if (raw === undefined) continue;
    if (!finite(raw)) return undefined;
    spec[key] = raw;
  }
  if (value.flats !== undefined) {
    if (typeof value.flats !== "boolean") return undefined;
    spec.flats = value.flats;
  }
  return spec;
}

function readFingerprint(value: unknown): Fingerprint | undefined {
  if (!isRecord(value) || !finite(value.volumeMm3) || !isId(value.faces) || !isId(value.edges)) return undefined;
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
