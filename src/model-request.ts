/**
 * The history tree's requests as the engine reads them (`docs/step-modeler.md`, "History tree (engine)"). The app
 * sends exactly these, and a check against the real engine builds its requests here too, so the two cannot drift.
 */
import { bytesToBase64 } from "./base64.ts";
import { rootSpec, type PrimitiveSpec } from "./model-primitive.ts";
import { relativePose, type Affine } from "./model-space.ts";
import { savedNodes, type BooleanKind, type Fingerprint, type JoinTool, type ModelOp, type ModelRoot, type ModelTree, type NodeId } from "./model-tree.ts";

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

/**
 * An edited step: `op` built on `parent` as the new `node`, a sibling of the step edited, then each of `replay` on the one
 * before it. The engine keeps the steps that built, and the first that did not as broken with the rest under it.
 */
export function editRequest(key: string, parent: NodeId, node: NodeId, op: ModelOp, replay: readonly { id: NodeId; op: ModelOp }[], chordMm: number): TreeRequest {
  return { call: "edit", key, parent, node, op, replay, chordMm };
}

export function probeRequest(key: string, node: NodeId, op: ModelOp): TreeRequest {
  return { call: "probe", key, node, op };
}

export function gotoRequest(key: string, node: NodeId, chordMm: number): TreeRequest {
  return { call: "goto", key, node, chordMm };
}

export function exportRequest(key: string, node: NodeId): TreeRequest {
  return { call: "export", key, node };
}
