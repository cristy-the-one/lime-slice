/**
 * A Model history tree as `.lime` keeps it: the ops, names, and fingerprints of every node, which
 * node the view and the plate were on, and the root STEP, or a new solid's root primitive. Engine keys are not saved: they name a
 * tree for one page load. A split names its piece, and a join its tool, by that plate object's id instead.
 */
import { isPrimitiveKind, primitiveMesh, type PrimitiveSpec } from "./model-primitive.ts";
import { isRigid, type Affine } from "./model-space.ts";
import { jumped, opLabel, rootLabel, type BooleanKind, type EdgePick, type FaceRef, type FeatureOp, type Fingerprint, type JoinTool, type LoftSection, type ModelOp, type ModelRoot, type ModelTree, type ModelNode, type NodeId, type PlateMesh, type ProfileLoop, type ProfileSegment, type Vec2, type Vec3 } from "./model-tree.ts";

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
}

/**
 * The root is exactly one of a STEP, `rootStep` (bytes in the app, a base64 record in the file), a primitive,
 * `rootPrimitive` (a new solid's few numbers, built again on open), or a feature, `rootFeature` (an extrude, a
 * revolve, or a loft built against nothing). Old files have no `rootFeature`.
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
}

/** The tree without its root, to give it another. */
export function treeBody({ nodes, current, committed, nextId }: SavedTreeBody): SavedTreeBody {
  return { nodes, current, committed, nextId };
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
      return {
        id: node.id,
        parent: node.parent,
        op: node.op?.kind === "join" ? savedJoin(node.op, owner) : node.op,
        ...(node.name ? { name: node.name } : {}),
        fingerprint: node.fingerprint,
        ...(piece ? { piece } : {}),
      };
    });
  return { nodes, current: tree.current, committed, nextId: tree.nextId };
}

function savedJoin({ op, tool, relative, keepTool }: JoinOp, owner: (key: string) => string | undefined): SavedJoin {
  return { kind: "join", op, tool: { object: owner(tool.key) ?? tool.object, node: tool.node, name: tool.name }, relative, keepTool };
}

/** The objects whose trees a saved tree's joins take a tool from. */
export function savedToolObjects(saved: SavedTreeBody): Set<string> {
  return new Set(saved.nodes.flatMap((node) => (node.op?.kind === "join" ? [node.op.tool.object] : [])));
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
    const op: ModelOp | null = node.op?.kind === "join" ? { ...node.op, tool: { object: node.op.tool.object, key: objectKey(node.op.tool.object) ?? "", node: node.op.tool.node, name: node.op.tool.name } } : node.op;
    nodes.set(node.id, {
      id: node.id,
      parent: node.parent,
      op,
      label: op ? opLabel(op) : rootLabel(root, fileLabel),
      fingerprint: node.fingerprint,
      ...(node.name ? { name: node.name } : {}),
      ...(piece ? { piece } : {}),
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
    if ((node.op === null) !== (node.parent === null) || (node.piece !== undefined && node.op?.kind !== "split")) return null;
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
    if (!op || (op.kind !== "extrude" && op.kind !== "revolve" && op.kind !== "loft")) return null;
    return { ...body, rootFeature: op };
  }
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
function readOp(value: unknown): SavedOp | undefined {
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
        edges.push({ index: raw.index, mid, lengthMm: raw.lengthMm });
      }
      return { kind: value.kind, edges, size: value.size };
    }
    case "scale":
      return finite(value.factor) ? { kind: "scale", factor: value.factor } : undefined;
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
        return { kind: "extrude", ...plane, depth: value.depth, ...(value.symmetric === true ? { symmetric: true as const } : {}) };
      }
      const axisOrigin = value.axisOrigin === undefined ? undefined : pair(value.axisOrigin);
      const axisDir = value.axisDir === undefined ? undefined : pair(value.axisDir);
      if (axisOrigin === null || axisDir === null || (value.angleDeg !== undefined && !finite(value.angleDeg))) return undefined;
      return {
        kind: "revolve",
        ...plane,
        ...(axisOrigin ? { axisOrigin } : {}),
        ...(axisDir ? { axisDir } : {}),
        ...(finite(value.angleDeg) ? { angleDeg: value.angleDeg } : {}),
      };
    }
    case "loft": {
      if (value.op !== "fuse" && value.op !== "cut" && value.op !== "common") return undefined;
      if (!Array.isArray(value.sections) || value.sections.length < 2 || (value.ruled !== undefined && typeof value.ruled !== "boolean")) return undefined;
      const sections: LoftSection[] = [];
      for (const raw of value.sections) {
        if (!isRecord(raw)) return undefined;
        const at = vec(raw.origin);
        const turn = raw.turn === undefined ? ([0, 0, 0] as Vec3) : vec(raw.turn);
        if (!at || !turn) return undefined;
        const loops = readLoops(raw.loops);
        if (loops === null) return undefined;
        if (!loops && finite(raw.radius)) {
          if (raw.radiusV !== undefined && !finite(raw.radiusV)) return undefined;
          sections.push({ origin: at, turn, radius: raw.radius, ...(finite(raw.radiusV) ? { radiusV: raw.radiusV } : {}) });
          continue;
        }
        if (!loops) {
          const profile = Array.isArray(raw.profile) ? raw.profile.map(pair) : null;
          if (!profile || profile.length < 3 || profile.some((point) => !point)) return undefined;
          const shape = readProfileShape(raw, profile.length);
          if (!shape) return undefined;
          sections.push({ origin: at, turn, profile: profile as Vec2[], ...shape });
          continue;
        }
        const section: LoftSection = { origin: at, turn };
        if (finite(raw.radius)) {
          if (raw.radiusV !== undefined && !finite(raw.radiusV)) return undefined;
          section.radius = raw.radius;
          if (finite(raw.radiusV)) section.radiusV = raw.radiusV;
        }
        if (raw.profile !== undefined) {
          const profile = Array.isArray(raw.profile) ? raw.profile.map(pair) : null;
          if (!profile || profile.length < 3 || profile.some((point) => !point)) return undefined;
          const shape = readProfileShape(raw, profile.length);
          if (!shape) return undefined;
          section.profile = profile as Vec2[];
          Object.assign(section, shape);
        } else if (raw.smooth !== undefined || raw.corners !== undefined) {
          const shape = readProfileShape(raw, 200);
          if (!shape) return undefined;
          Object.assign(section, shape);
        }
        section.loops = loops;
        sections.push(section);
      }
      return { kind: "loft", op: value.op, sections, ...(value.ruled === true ? { ruled: true as const } : {}) };
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
        if (!Array.isArray(seg.through) || seg.through.length < 1 || seg.through.length > 200) return null;
        const through: Vec2[] = [];
        for (const point of seg.through) {
          const at = pair(point);
          if (!at) return null;
          through.push(at);
        }
        segments.push({ kind: "spline", through, to });
      } else {
        return null;
      }
    }
    loops.push({ start, segments });
  }
  return loops;
}

function pair(value: unknown): Vec2 | null {
  if (!Array.isArray(value) || value.length !== 2 || !value.every(finite)) return null;
  return [value[0], value[1]];
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
