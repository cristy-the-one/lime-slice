/**
 * The history tree's requests as the engine reads them (`docs/step-modeler.md`, "History tree (engine)"). The app
 * sends exactly these, and a check against the real engine builds its requests here too, so the two cannot drift.
 */
import { bytesToBase64 } from "./base64.ts";
import { rootSpec, type PrimitiveSpec } from "./model-primitive.ts";
import { relativePose, type Affine } from "./model-space.ts";
import type { EditLevel } from "./model-edit.ts";
import { savedNodes, type BooleanKind, type EdgeFilter, type EdgeStep, type ExtrudeOp, type Fingerprint, type JoinTool, type ModelOp, type ModelRoot, type ModelTree, type NodeId, type RevolveOp, type ShellOp, type Vec2, type Vec3 } from "./model-tree.ts";

export type TreeRequest = Record<string, unknown>;

/**
 * What `open` builds the root from: the STEP's bytes, or a new solid's primitive. A primitive root carries its
 * fingerprint, so a root that builds differently is broken like any other step that does.
 */
function rootFields(root: Exclude<ModelRoot, { kind: "piece" }>, fingerprint: Fingerprint | null): TreeRequest {
  if (root.kind === "primitive") return { primitive: root.solid, ...(fingerprint ? { fingerprint } : {}) };
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

/** Open the whole tree from its root and every saved op, showing `current`. */
export function wholeTreeRequest(tree: ModelTree, root: Exclude<ModelRoot, { kind: "piece" }>, current: NodeId, chordMm: number): TreeRequest {
  return { call: "open", key: tree.key, ...rootFields(root, tree.nodes.get(0)?.fingerprint ?? null), chordMm, nodes: savedNodes(tree), current };
}

/** Build `op` on `parent` as `node`. `otherKey` starts the tree of a split's other piece. */
export function applyRequest(key: string, parent: NodeId, node: NodeId, op: ModelOp, chordMm: number, otherKey?: string | null): TreeRequest {
  return { call: "apply", key, parent, node, op, chordMm, ...(otherKey ? { otherKey } : {}) };
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

/**
 * An extrude of `profile` (`[u, v]` points) on `plane`, in the frame the plane is given in: `toSolidOp` takes it into the
 * solid's own frame like any tool's op. `symmetric` is sent only when on, as the engine stores it.
 */
export function extrudeOp(op: BooleanKind, plane: ProfilePlane, profile: readonly Vec2[], depth: number, symmetric = false): ExtrudeOp {
  return { kind: "extrude", op, origin: [...plane.origin], turn: [...plane.turn], profile: profile.map(([u, v]) => [u, v]), depth, ...(symmetric ? { symmetric: true as const } : {}) };
}

/** A revolve of `profile` on `plane` about an in-plane axis. Each of the axis's fields is sent only when given. */
export function revolveOp(op: BooleanKind, plane: ProfilePlane, profile: readonly Vec2[], axis: { origin?: Vec2; dir?: Vec2; angleDeg?: number } = {}): RevolveOp {
  return {
    kind: "revolve",
    op,
    origin: [...plane.origin],
    turn: [...plane.turn],
    profile: profile.map(([u, v]) => [u, v]),
    ...(axis.origin ? { axisOrigin: [...axis.origin] as Vec2 } : {}),
    ...(axis.dir ? { axisDir: [...axis.dir] as Vec2 } : {}),
    ...(axis.angleDeg != null ? { angleDeg: axis.angleDeg } : {}),
  };
}

/** A shell to `thickness`, with the faces of the parent's reply `openFaces` names removed. None open is a closed void. */
export function shellOp(thickness: number, openFaces: readonly number[] = []): ShellOp {
  return { kind: "shell", thickness, ...(openFaces.length > 0 ? { openFaces: [...openFaces] } : {}) };
}

/** A blend's pick of the edges step `fromNode` made: all its sharp ones, or only the convex or the concave ones. */
export function stepEdges(fromNode: NodeId, filter?: EdgeFilter): EdgeStep {
  return { fromNode, ...(filter && filter !== "all" ? { filter } : {}) };
}

/**
 * An edited step: `op` built on `parent` as the new `node`, a sibling of the step edited, then each of `replay` on the one
 * before it. The engine keeps the steps that built, and the first that did not as broken with the rest under it.
 */
export function editRequest(key: string, parent: NodeId, node: NodeId, op: ModelOp, replay: readonly { id: NodeId; op: ModelOp }[], chordMm: number): TreeRequest {
  return { call: "edit", key, parent, node, op, replay, chordMm };
}

/**
 * An edit across trees, one call: `levels` deepest first (`crossEdit`), the open tree last. The tool trees' parts go
 * first, each feeding the join above it, and the engine keeps nothing if the edited step or a join whose tool built fails.
 */
export function crossEditRequest(levels: readonly EditLevel[], chordMm: number): TreeRequest {
  const own = levels.at(-1)!;
  const tools = levels.slice(0, -1).map(({ key, parent, node, op, replay }) => ({ key, parent, node, op, replay }));
  return { ...editRequest(own.key, own.parent, own.node, own.op, own.replay, chordMm), ...(tools.length > 0 ? { tools } : {}) };
}

/** A dry-run of `op` on `node`. With `previewMm`, a build that works answers its shape, tessellated at that chord, as `preview`. */
export function probeRequest(key: string, node: NodeId, op: ModelOp, previewMm?: number): TreeRequest {
  return { call: "probe", key, node, op, ...(previewMm != null ? { preview: true, chordMm: previewMm } : {}) };
}

export function gotoRequest(key: string, node: NodeId, chordMm: number): TreeRequest {
  return { call: "goto", key, node, chordMm };
}

export function exportRequest(key: string, node: NodeId): TreeRequest {
  return { call: "export", key, node };
}
