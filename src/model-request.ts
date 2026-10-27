/**
 * The history tree's requests as the engine reads them (`docs/step-modeler.md`, "History tree (engine)"). The app
 * sends exactly these, and a check against the real engine builds its requests here too, so the two cannot drift.
 */
import { bytesToBase64 } from "./base64.ts";
import { rootSpec, type PrimitiveSpec } from "./model-primitive.ts";
import { relativePose, type Affine } from "./model-space.ts";
import type { EditLevel } from "./model-edit.ts";
import { partitionNumbers } from "./modeling/partition.ts";
import { savedNodes, type BooleanKind, type EdgeFilter, type EdgeStep, type ExtrudeOp, type FaceExtrudeOp, type FaceRef, type Fingerprint, type JoinTool, type LoftOp, type LoftSection, type ModelOp, type ModelRoot, type ModelTree, type MoveFacesOp, type NodeId, type ProfileLoop, type ProfileSegment, type RevolveOp, type ShellOp, type Vec2, type Vec3 } from "./model-tree.ts";

export type TreeRequest = Record<string, unknown>;

/**
 * What `open` builds the root from: the STEP's bytes, a new solid's primitive, or a feature built against nothing.
 * A primitive or feature root carries its fingerprint, so a root that builds differently is broken like any other
 * step that does. `feature` is sent only for a feature root, so a STEP or a primitive open stays the same request.
 */
function rootFields(root: Exclude<ModelRoot, { kind: "piece" }>, fingerprint: Fingerprint | null): TreeRequest {
  if (root.kind === "primitive") return { primitive: root.solid, ...(fingerprint ? { fingerprint } : {}) };
  // --- K2 feature root. The sketch on an extrude is editing state; the engine never sees it. ---
  if (root.kind === "feature") return { feature: withoutSketch(root.op), ...(fingerprint ? { fingerprint } : {}) };
  return { filename: root.name, dataB64: bytesToBase64(new Uint8Array(root.bytes)) };
}

/** Open a tree on its root alone: a file, a copy's root, or a step's own STEP. */
export function openRequest(key: string, root: Exclude<ModelRoot, { kind: "piece" }>, chordMm: number): TreeRequest {
  return { call: "open", key, ...rootFields(root, null), chordMm };
}

/** New solid: a tree rooted in the primitive the panel describes, standing as `rootSpec` puts it. */
export function newSolidRequest(key: string, typed: PrimitiveSpec, chordMm: number): TreeRequest {
  return { call: "open", key, primitive: rootSpec(typed), chordMm };
}

/**
 * Open the whole tree from its root and every saved op, showing `current`. `seed` is one step's solid as `export` wrote it
 * in `brep` (`isBrep`): that step and the steps after it build from it, not from the root. `quiet` builds `current`
 * without meshing it or sending it, for a caller that asks for the step next.
 */
export function wholeTreeRequest(
  tree: ModelTree,
  root: Exclude<ModelRoot, { kind: "piece" }>,
  current: NodeId,
  chordMm: number,
  extra: { seed?: { node: NodeId; bytes: ArrayBuffer | Uint8Array } | null; quiet?: boolean } = {},
): TreeRequest {
  const { seed, quiet } = extra;
  const seedField = seed ? { seed: { node: seed.node, dataB64: bytesToBase64(seed.bytes instanceof Uint8Array ? seed.bytes : new Uint8Array(seed.bytes)) } } : {};
  return { call: "open", key: tree.key, ...rootFields(root, tree.nodes.get(0)?.fingerprint ?? null), chordMm, nodes: engineNodes(tree), current, ...seedField, ...(quiet ? { quiet: true } : {}) };
}

/**
 * Build `op` on `parent` as `node`. `otherKey` starts the tree of a split's other piece; `pieceKeys` the trees of a split
 * to print's pieces 2, 3, … in partition order, null leaving that piece unseen.
 */
export function applyRequest(key: string, parent: NodeId, node: NodeId, op: ModelOp, chordMm: number, otherKey?: string | null, pieceKeys?: readonly (string | null)[], pinsKey?: string | null): TreeRequest {
  return { call: "apply", key, parent, node, op: withoutSketch(op), chordMm, ...(otherKey ? { otherKey } : {}), ...(pieceKeys?.length ? { pieceKeys: [...pieceKeys] } : {}), ...(pinsKey ? { pinsKey } : {}) };
}

/**
 * A join of the solid posed at `target` with the tool's step, its object posed at `tool` in model space. The tool's pose in
 * the solid's own frame is worked out here, once, and stored, so moving either object later never moves the cut.
 */
export function joinOp(op: BooleanKind, toolRef: JoinTool, target: Affine, tool: Affine, keepTool: boolean): Extract<ModelOp, { kind: "join" }> {
  return { kind: "join", op, tool: toolRef, relative: relativePose(target, tool), keepTool };
}

/** A profile's plane: an origin, and a turn about X, then Y, then Z, whose columns are U, V, and W, as a workplane's. */
export interface ProfilePlane {
  origin: Vec3;
  turn: Vec3;
}

/** K3. Each field is sent only when set, so a plain extrude is the same object as before. */
export interface ExtrudeExtent {
  /** The other side of the plane, above 0. */
  depth2?: number;
  /** Draft angle in degrees. Zero is left off. */
  draftDeg?: number;
  /** A face of the solid this extrude is built on: an index, or the reference the engine stored. */
  upTo?: number | FaceRef;
}

/**
 * An extrude of `profile` (`[u, v]` points) on `plane`, in the frame the plane is given in: `toSolidOp` takes it into the
 * solid's own frame like any tool's op. `symmetric` is sent only when on, as the engine stores it. `extent` is the
 * second side, the draft, and the face to stop at, each only when set.
 */
function isProfileLoops(value: ExtrudeExtent | readonly ProfileLoop[]): value is readonly ProfileLoop[] {
  return Array.isArray(value);
}

export function extrudeOp(op: BooleanKind, plane: ProfilePlane, profile: readonly Vec2[], depth: number, symmetric = false, shape: ProfileShape = {}, extentOrLoops: ExtrudeExtent | readonly ProfileLoop[] = {}): ExtrudeOp {
  const loops = isProfileLoops(extentOrLoops) ? extentOrLoops : undefined;
  const extent = isProfileLoops(extentOrLoops) ? {} : extentOrLoops;
  const copied = loops && loops.length > 0 ? copyLoops(loops) : undefined;
  const upTo = extent.upTo === undefined ? undefined : typeof extent.upTo === "number" ? extent.upTo : { index: extent.upTo.index, mid: [...extent.upTo.mid] as Vec3, areaMm2: extent.upTo.areaMm2 };
  return {
    kind: "extrude",
    op,
    origin: [...plane.origin],
    turn: [...plane.turn],
    ...(copied ? { loops: copied } : { profile: profile.map(([u, v]) => [u, v] as Vec2) }),
    depth,
    ...(symmetric ? { symmetric: true as const } : {}),
    ...(copied ? {} : shapeFields(shape)),
    ...(extent.depth2 !== undefined ? { depth2: extent.depth2 } : {}),
    ...(extent.draftDeg !== undefined && extent.draftDeg !== 0 ? { draftDeg: extent.draftDeg } : {}),
    ...(upTo !== undefined ? { upTo } : {}),
  };
}

/** A copy of `loops`, so a caller that keeps the arrays does not share them with the stored op. */
function copyLoops(loops: readonly ProfileLoop[]): ProfileLoop[] {
  return loops.map((loop) => ({
    start: [loop.start[0], loop.start[1]],
    segments: loop.segments.map((seg) => copySegment(seg)),
  }));
}

function copySegment(seg: ProfileSegment): ProfileSegment {
  if (seg.kind === "line") return { kind: "line", to: [seg.to[0], seg.to[1]] };
  if (seg.kind === "arc") return { kind: "arc", through: [seg.through[0], seg.through[1]], to: [seg.to[0], seg.to[1]] };
  return { kind: "spline", through: seg.through.map(([u, v]) => [u, v] as Vec2), to: [seg.to[0], seg.to[1]] };
}

/** Splines through a profile's points, sharp at `corners`. Each field is sent only when on, as the engine stores it. */
export interface ProfileShape {
  smooth?: boolean;
  corners?: readonly number[];
}

function shapeFields(shape: ProfileShape): { smooth?: true; corners?: number[] } {
  return { ...(shape.smooth ? { smooth: true as const } : {}), ...(shape.smooth && shape.corners?.length ? { corners: [...shape.corners] } : {}) };
}

/** A loft through `sections`, each a profile (with its shape) or a circle or ellipse, on its own plane. */
export function loftOp(op: BooleanKind, sections: readonly LoftSection[], ruled = false): LoftOp {
  return {
    kind: "loft",
    op,
    sections: sections.map((section) => ({
      origin: [...section.origin],
      turn: [...section.turn],
      ...(section.loops && section.loops.length > 0
        ? { loops: copyLoops(section.loops) }
        : section.radius !== undefined
          ? { radius: section.radius, ...(section.radiusV !== undefined ? { radiusV: section.radiusV } : {}) }
          : { profile: (section.profile ?? []).map(([u, v]) => [u, v] as Vec2), ...shapeFields({ smooth: section.smooth, corners: section.corners }) }),
    })),
    ...(ruled ? { ruled: true as const } : {}),
  };
}

/** A revolve of `profile` on `plane` about an in-plane axis. Each of the axis's fields is sent only when given. */
export function revolveOp(op: BooleanKind, plane: ProfilePlane, profile: readonly Vec2[], axis: { origin?: Vec2; dir?: Vec2; angleDeg?: number } = {}, shape: ProfileShape = {}, loops?: readonly ProfileLoop[]): RevolveOp {
  const copied = loops && loops.length > 0 ? copyLoops(loops) : undefined;
  return {
    kind: "revolve",
    op,
    origin: [...plane.origin],
    turn: [...plane.turn],
    ...(copied ? { loops: copied } : { profile: profile.map(([u, v]) => [u, v] as Vec2) }),
    ...(axis.origin ? { axisOrigin: [...axis.origin] as Vec2 } : {}),
    ...(axis.dir ? { axisDir: [...axis.dir] as Vec2 } : {}),
    ...(axis.angleDeg != null ? { angleDeg: axis.angleDeg } : {}),
    ...(copied ? {} : shapeFields(shape)),
  };
}

/** A shell to `thickness`, with the faces of the parent's reply `openFaces` names removed. None open is a closed void. */
export function shellOp(thickness: number, openFaces: readonly number[] = []): ShellOp {
  return { kind: "shell", thickness, ...(openFaces.length > 0 ? { openFaces: [...openFaces] } : {}) };
}

/** K4. A face pulled `distance` along its outward normal. `draftDeg` and `upTo` are sent only when set. */
export function faceExtrudeOp(
  face: number | FaceRef,
  distance: number,
  options: { draftDeg?: number; upTo?: number | FaceRef | null } = {},
): FaceExtrudeOp {
  const draft = options.draftDeg;
  const upTo = options.upTo;
  return {
    kind: "faceExtrude",
    face: typeof face === "number" ? face : { ...face, mid: [...face.mid] },
    distance,
    ...(draft != null && draft !== 0 ? { draftDeg: draft } : {}),
    ...(upTo != null ? { upTo: typeof upTo === "number" ? upTo : { ...upTo, mid: [...upTo.mid] } } : {}),
  };
}

/** K4. Faces offset along their outward normals, each by its own distance. */
export function moveFacesOp(faces: readonly { face: number | FaceRef; distance: number }[]): MoveFacesOp {
  return {
    kind: "moveFaces",
    faces: faces.map((row) => ({
      face: typeof row.face === "number" ? row.face : { ...row.face, mid: [...row.face.mid] },
      distance: row.distance,
    })),
  };
}

/** K4. The face's outline in its plane. */
export function faceLoopsRequest(key: string, node: NodeId, face: number | FaceRef): TreeRequest {
  return { call: "faceLoops", key, node, face: typeof face === "number" ? face : { ...face, mid: [...face.mid] } };
}

/** A blend's pick of the edges step `fromNode` made: all its sharp ones, or only the convex or the concave ones. */
export function stepEdges(fromNode: NodeId, filter?: EdgeFilter): EdgeStep {
  return { fromNode, ...(filter && filter !== "all" ? { filter } : {}) };
}

/**
 * --- A5. The edges step `node` made, as indexes on the tree's current solid. `filter` is sent only when it narrows,
 * as `stepEdges` stores it. The caller shows that solid first, so the indexes are the ones on screen.
 */
export function stepEdgesRequest(key: string, node: NodeId, filter?: EdgeFilter): TreeRequest {
  return { call: "stepEdges", key, node, ...(filter && filter !== "all" ? { filter } : {}) };
}

/**
 * An edited step: `op` built on `parent` as the new `node`, a sibling of the step edited, then each of `replay` on the one
 * before it. The engine keeps the steps that built, and the first that did not as broken with the rest under it.
 */
export function editRequest(key: string, parent: NodeId, node: NodeId, op: ModelOp, replay: readonly { id: NodeId; op: ModelOp }[], chordMm: number): TreeRequest {
  return { call: "edit", key, parent, node, op: withoutSketch(op), replay: replay.map((step) => ({ id: step.id, op: withoutSketch(step.op) })), chordMm };
}

/**
 * An edit across trees, one call: `levels` deepest first (`crossEdit`), the open tree last. The tool trees' parts go
 * first, each feeding the join above it, and the engine keeps nothing if the edited step or a join whose tool built fails.
 * `pieceKeys` are an edited split to print's, as `applyRequest` sends them.
 */
export function crossEditRequest(levels: readonly EditLevel[], chordMm: number, pieceKeys?: readonly (string | null)[], pinsKey?: string | null): TreeRequest {
  const own = levels.at(-1)!;
  const tools = levels.slice(0, -1).map(({ key, parent, node, op, replay }) => ({ key, parent, node, op: withoutSketch(op), replay: replay.map((step) => ({ id: step.id, op: withoutSketch(step.op) })) }));
  return { ...editRequest(own.key, own.parent, own.node, own.op, own.replay, chordMm), ...(tools.length > 0 ? { tools } : {}), ...(pieceKeys?.length ? { pieceKeys: [...pieceKeys] } : {}), ...(pinsKey ? { pinsKey } : {}) };
}

/** A dry-run of `op` on `node`. With `previewMm`, a build that works answers its shape, tessellated at that chord, as `preview`. */
export function probeRequest(key: string, node: NodeId, op: ModelOp, previewMm?: number): TreeRequest {
  return { call: "probe", key, node, op: withoutSketch(op), ...(previewMm != null ? { preview: true, chordMm: previewMm } : {}) };
}

/**
 * --- F1. Drop `sketch` before an engine call. An op with no sketch is returned as the same object,
 * so a request that never had one stays byte-for-byte what it was.
 * --- A6. `exprs` is dropped the same way. An op with neither is still the same object.
 */
export function withoutSketch(op: ModelOp): ModelOp {
  let next = op;
  // --- F2. A revolve keeps its sketch the same way an extrude does. ---
  if (op.kind === "extrude" || op.kind === "revolve") {
    if (op.sketch) {
      const { sketch: _sketch, ...rest } = op;
      next = rest;
    }
  } else if (op.kind === "loft") {
    // --- F3. A loft's drawing is the same kind of client field. No drawing leaves the op as it was. ---
    if (op.drawing) {
      const { drawing: _drawing, ...rest } = op;
      next = rest;
    }
  } else if (op.kind === "group") {
    let changed = false;
    const steps = op.steps.map((step) => {
      const child = withoutSketch(step);
      if (child !== step) changed = true;
      return child;
    });
    if (changed) next = { ...op, steps };
  } else if (op.kind === "partition") {
    // --- Milestone 10. A sketched cut's sketch is the pencil's, as an extrude's is: the engine cuts along the chain.
    const drawn = op.cuts.some((cut) => cut.profile?.kind === "sketch" && cut.profile.sketch);
    const cuts = drawn ? op.cuts.map((cut) => (cut.profile?.kind === "sketch" && cut.profile.sketch ? { ...cut, profile: withoutDrawing(cut.profile) } : cut)) : op.cuts;
    // --- Split to print, part numbers: the engine-only strokes go the other way, added for every call and never echoed.
    const numbers = partitionNumbers(op);
    if (numbers || drawn) next = { ...op, cuts, ...(numbers ? { numbers } : {}) } as ModelOp;
  }
  if (!next.exprs) return next;
  const { exprs: _exprs, ...rest } = next;
  return rest;
}

function withoutDrawing<T extends { sketch?: unknown }>(profile: T): Omit<T, "sketch"> {
  const { sketch: _sketch, ...rest } = profile;
  return rest;
}

/** Put `source`'s sketch and expression text back on `stored`. The engine's echo has neither. `stored` itself when there is nothing to put back. */
export function keepSketch(stored: ModelOp, source: ModelOp): ModelOp {
  let next = stored;
  // --- F2. The engine's echo of a revolve has no sketch either. ---
  if ((stored.kind === "extrude" || stored.kind === "revolve") && stored.kind === source.kind && source.sketch && !stored.sketch) {
    next = { ...stored, sketch: source.sketch };
  } else if (stored.kind === "loft" && source.kind === "loft" && source.drawing && !stored.drawing) {
    // --- F3. The engine's echo of a loft has no drawing either. ---
    next = { ...stored, drawing: source.drawing };
  } else if (stored.kind === "group" && source.kind === "group") {
    let changed = false;
    const steps = stored.steps.map((step, index) => {
      const child = keepSketch(step, source.steps[index] ?? step);
      if (child !== step) changed = true;
      return child;
    });
    if (changed) next = { ...stored, steps };
  } else if (stored.kind === "partition" && source.kind === "partition" && source.cuts.some((cut) => cut.profile?.kind === "sketch" && cut.profile.sketch)) {
    // --- Milestone 10. The echo's sketched cuts have their chain, not the sketch the pencil reopens.
    const cuts = stored.cuts.map((cut, at) => {
      const drawn = source.cuts[at]?.profile;
      return cut.profile?.kind === "sketch" && !cut.profile.sketch && drawn?.kind === "sketch" && drawn.sketch ? { ...cut, profile: { ...cut.profile, sketch: drawn.sketch } } : cut;
    });
    next = { ...stored, cuts };
  }
  if (source.exprs && !next.exprs) return { ...next, exprs: source.exprs };
  return next;
}

/** Saved nodes with sketches removed. The same array when none of them has one. */
function engineNodes(tree: ModelTree): ReturnType<typeof savedNodes> {
  const nodes = savedNodes(tree);
  let changed = false;
  const mapped = nodes.map((node) => {
    const op = withoutSketch(node.op);
    if (op === node.op) return node;
    changed = true;
    return { ...node, op };
  });
  return changed ? mapped : nodes;
}

export function gotoRequest(key: string, node: NodeId, chordMm: number): TreeRequest {
  return { call: "goto", key, node, chordMm };
}

/**
 * The step's solid as a file: `step` to hand on (the STEP button, `model_export_step`), or `brep`, the binary a project
 * keeps (`isBrep`), which reads back as the same solid, face and edge numbers included.
 */
/**
 * `pieces`, a split to print's other pieces by tree and step, join this solid in one STEP file of named solids.
 * `names` is each solid's product name, this one first and then the pieces in order (`pieceNames`); the engine refuses
 * pieces without one for each.
 */
export function exportRequest(key: string, node: NodeId, format: "step" | "brep", pieces?: readonly { key: string; node: NodeId }[], names?: readonly string[]): TreeRequest {
  return {
    call: "export",
    key,
    node,
    format,
    ...(pieces?.length ? { pieces: pieces.map((piece) => ({ key: piece.key, node: piece.node })), names: [...(names ?? [])] } : {}),
  };
}

/** The first bytes of a solid the engine wrote in `brep`. A STEP file starts with `ISO-10303-21`. */
const BREP_MAGIC = [0x4c, 0x49, 0x4d, 0x45, 0x42, 0x52, 0x45, 0x50, 0x20]; // "LIMEBREP "

/**
 * Whether `bytes` are a solid the engine wrote in Open CASCADE's binary format, rather than a STEP file: such a solid
 * reads back as the step it was written from exactly, so an edit can build on it at once.
 */
export function isBrep(bytes: ArrayBuffer | Uint8Array | undefined | null): boolean {
  if (!bytes) return false;
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return view.byteLength > BREP_MAGIC.length && BREP_MAGIC.every((byte, i) => view[i] === byte);
}

/** The name a project gives an object's solid: its file's stem, `.brep` for the binary format, else `.step`. */
export function solidFileName(name: string, bytes: ArrayBuffer | Uint8Array): string {
  const stem = name.replace(/\.(step|stp|stl|3mf|brep)$/i, "");
  return `${stem || "solid"}.${isBrep(bytes) ? "brep" : "step"}`;
}
