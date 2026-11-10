/**
 * A live-bridge message applied to the plate the desktop is showing.
 * Every message carries the whole plate after its tool, so a missed message
 * is repaired by the next one. A mesh travels once per desktop: the message
 * names it by hash, and carries its bytes and triangles only while the
 * desktop has not been sent them. The headless server stays right if this
 * never runs. A gesture in progress (`poseHud`) waits; the mirror does not
 * interrupt it.
 */
import { base64ToBytes } from "./base64.ts";
import type { Mat3 } from "./mesh-place.ts";
import type { Affine, ObjectFrame } from "./model-space.ts";
import type { PlateFileObject } from "./plate.ts";
import { savedToolObjects, treeBody } from "./saved-tree-body.ts";
import type { SavedTree } from "./model-tree-file.ts";

/** Shown when a message names a mesh this window was never sent. The server sends it again on its next tool. */
export const BRIDGE_RESEND = "The MCP session changed a part this window has not received yet. It arrives with the session's next step.";

export interface BridgeSettings {
  layerHeight?: number;
  supports?: boolean;
  blendKind?: string;
  strategy?: string;
  toughness?: number;
}

/** One object after the tool. Poses are the result, not the arguments. */
export interface BridgePlateRow {
  object: string;
  name: string;
  scalePercent: number;
  centered: boolean;
  offset: { x: number; y: number; z: number };
  orient: Mat3;
  /** `fnv1aHex` of the object's file bytes. A key of `meshes`. */
  meshHash?: string;
  /**
   * Where the part stands in Model's shared space (its place in an assembly), as the project file keeps it. A server
   * that sends it sends it for every part, identity included; an older server sends none, and the window then keeps
   * the pose it has. The window takes it with a new part and with a new shape of a part, not with a placement alone:
   * a person's own pose in the window is not overwritten by a move on the plate.
   */
  modelPose?: Affine;
  /** `"part"` when Model numbers are typed in the part's own frame; absent is model space. Read with `modelPose`. */
  frame?: ObjectFrame;
}

/** A row's `modelPose` when it is one: nine and three finite numbers. Anything else is no pose. */
export function bridgeModelPose(raw: unknown): Affine | null {
  const pose = raw as { m?: unknown; t?: unknown } | null | undefined;
  const numbers = (list: unknown, count: number): list is number[] => Array.isArray(list) && list.length === count && list.every((value) => typeof value === "number" && Number.isFinite(value));
  if (!pose || !numbers(pose.m, 9) || !numbers(pose.t, 3)) return null;
  return { m: [...pose.m] as Affine["m"], t: [...pose.t] as Affine["t"] };
}

/** A mesh as the server slices it: its file, and the triangles it read from that file. */
export interface BridgeMesh {
  fileName: string;
  bytesB64: string;
  /** Float32 xyz triangles, little-endian, in the object's source frame. */
  positionsB64: string;
  /** How far the reader lowered the triangles onto Z = 0. */
  seatMm?: number;
}

/** A commit replaced the plate mesh. The mesh itself is in `meshes`; edits are not replayed. */
export interface BridgeCommit {
  object: string;
  meshHash: string;
}

export interface BridgeMessage {
  activity?: { id: string; phase: "start" | "end"; tool?: string; object?: string };
  tool?: string;
  /** One MCP server process. A new one starts its sequence again. */
  session?: string;
  seq?: number;
  objectId?: string;
  objectName?: string;
  ok?: boolean;
  /** The settings after the tool. */
  settings?: BridgeSettings;
  /** Every object on the plate after the tool. */
  plate?: BridgePlateRow[];
  /** Meshes this desktop has not been sent, by hash. */
  meshes?: Record<string, BridgeMesh>;
  /** Set only for `model_commit`. Absent for a probe or an apply. */
  commit?: BridgeCommit;
  /**
   * Editable histories, in the project-file format: for a new part, and for every part whose mesh this message changes
   * (a commit, an undo of one), so the window takes MCP's history with MCP's shape.
   */
  modelHistories?: Record<string, { tree: NonNullable<PlateFileObject["modelTree"]>; brepB64?: string }>;
  /** What the tool did, in a few words ("Fuse Ornament gear"), for the window's undo step. Absent when MCP cannot say. */
  change?: string;
}

/** Decode a self-contained history. Linked trees need a coordinated transfer and are refused here. */
export function decodeBridgeHistory(saved: NonNullable<BridgeMessage["modelHistories"]>[string]): { tree: SavedTree<{ name: string; bytes: ArrayBuffer }>; brep?: ArrayBuffer } | null {
  const tree = saved.tree;
  if (savedToolObjects(tree).size || tree.nodes.some((node) => node.piece || node.pins || node.pieces?.some(Boolean))) return null;
  let decoded: SavedTree<{ name: string; bytes: ArrayBuffer }>;
  if (tree.rootPrimitive) decoded = { ...treeBody(tree), rootPrimitive: tree.rootPrimitive };
  else if (tree.rootFeature) decoded = { ...treeBody(tree), rootFeature: tree.rootFeature };
  else {
    const root = tree.rootStep;
    const bytes = root?.bytesBase64 ? base64ToBytes(root.bytesBase64) : null;
    if (!root || !bytes || bytes.byteLength !== root.byteLength) return null;
    decoded = { ...treeBody(tree), rootStep: { name: root.name, bytes: bytes.slice().buffer as ArrayBuffer } };
  }
  if (!saved.brepB64) return { tree: decoded };
  const bytes = base64ToBytes(saved.brepB64);
  return bytes?.length ? { tree: decoded, brep: bytes.slice().buffer as ArrayBuffer } : null;
}

/** Where this window is in the server's sequence. */
export interface BridgeSeen {
  session: string;
  seq: number;
}

/**
 * One object on the desktop plate, as the mirror sees it. `extra` is whatever
 * the desktop keeps with the object; the mirror carries it over untouched
 * while the mesh stays the same.
 */
export interface MirrorObject<T = unknown> {
  id: string;
  name: string;
  scalePercent: number;
  centered: boolean;
  offset: { x: number; y: number; z: number };
  orient: Mat3;
  meshHash: string;
  /** Set when the mesh came from this mirror message. Otherwise the desktop's own mesh stays. */
  mesh?: { fileName: string; bytes: Uint8Array; source: Float32Array; seatMm?: number };
  /**
   * The server's place for the part in Model's shared space, when the server sent one (`BridgePlateRow.modelPose`).
   * It is no part of what makes two rows the same placement: the plate does not read it.
   */
  model?: { pose: Affine; frame?: ObjectFrame };
  extra: T | null;
}

export interface MirrorResult<T = unknown> {
  plate: MirrorObject<T>[];
  seen: BridgeSeen;
  /** Server objects on this plate after the message. Desktop objects outside it are never removed. */
  owned: Set<string>;
  /** Set when a row needs a mesh this window does not have. The plate is left as it was. */
  missing: string | null;
  applied: boolean;
  /** The selection the server's tool points at, when it is on the plate. */
  selectId: string | null;
}

/** Tools whose result is a new plate. `plate_sync` is the server's full resend. */
const PLATE_TOOLS = new Set([
  "plate_sync",
  "mesh_import",
  "solid_new",
  "object_place",
  "object_remove",
  "object_duplicate",
  "object_split_shells",
  "plate_arrange",
  "plate_undo",
  "plate_redo",
  "workplane_print_up",
  "model_commit",
  "project_open",
  "project_create",
  "tandem_pull",
]);

export function bridgeHasPlateUpdate(message: BridgeMessage): boolean {
  return message.ok !== false && !!message.tool && PLATE_TOOLS.has(message.tool) && !!message.plate;
}

/** Never replace or remove a desktop Model history with a mesh-only bridge snapshot. The first part it would, or null. */
export function bridgeProtectedModel<T>(current: readonly MirrorObject<T>[], message: BridgeMessage, seen: BridgeSeen, owned: ReadonlySet<string>, hasModel: (extra: T | null) => boolean): string | null {
  return bridgeHolds(current, message, seen, new Map(), owned, { protectedModel: (row) => hasModel(row.extra) }).find((hold) => hold.kind === "model-history")?.name ?? null;
}

/**
 * Why the desktop held one part of a snapshot back. Only that part waits; the rest of the snapshot applies.
 * - `model-history`: the window holds an editable Model history for it that MCP's new mesh (or removal) would discard.
 * - `both-changed`: a person changed it here and MCP changed it too since the last shared version.
 * - `removed-here`: a person removed it here and MCP changed it.
 */
export type BridgeHoldKind = "model-history" | "both-changed" | "removed-here";

export interface BridgeHold {
  object: string;
  name: string;
  kind: BridgeHoldKind;
  /** One sentence: what was held and how to clear it. */
  reason: string;
}

/**
 * What to do about a held part, in a sentence a person or an agent can act on. Since live shapes (wave 8) the window
 * applies MCP's version of every part and keeps its own as an undo step, so it holds nothing back; the sentences stay
 * for a peer that still reports holds. None of them asks for a reload.
 */
export function bridgeHoldReason(name: string, kind: BridgeHoldKind): string {
  if (kind === "model-history") return `${name} has a Model history in the window, so MCP's new shape for it was held back; the rest of the plate updated. Undo the change in MCP (plate_undo) to keep the window's, or undo the window's edit to the part to take MCP's.`;
  if (kind === "removed-here") return `${name} was removed in the window and changed by MCP, so MCP's update to it was held back; the rest of the plate updated. Undo the removal in the window to take MCP's version, or object_remove it in MCP.`;
  return `${name} was changed both in the window and by MCP, so MCP's update to it was held back; the rest of the plate updated. Undo it in the window to take MCP's version, or plate_undo in MCP and tandem_pull the window's.`;
}

/** A person's change to `id` since the shared version. Without `touched`, any difference counts, as before Tandem knew. */
function humanChanged<T>(id: string, before: MirrorObject<null>, human: MirrorObject<T> | undefined, touched?: ReadonlySet<string>): boolean {
  return (!touched || touched.has(id)) && !sameBridgeObject(before, human);
}

function incomingRows(message: BridgeMessage): Map<string, MirrorObject<null>> {
  return bridgeServerBaseline(message);
}

/**
 * The parts of this snapshot the desktop must hold back, each with its reason. Everything else applies. A part counts as
 * changed by a person only when `touched` names it (an edit the window recorded as an undo step); a pose the window
 * drifted to by itself is not a person's change, so it never holds anything back and is put right by the snapshot.
 */
export function bridgeHolds<T>(
  current: readonly MirrorObject<T>[],
  message: BridgeMessage,
  seen: BridgeSeen,
  baseline: ReadonlyMap<string, MirrorObject<null>>,
  owned: ReadonlySet<string>,
  options: { protectedModel?: (row: MirrorObject<T>) => boolean; touched?: ReadonlySet<string> } = {},
): BridgeHold[] {
  if (!bridgeIsNew(seen, message) || !bridgeHasPlateUpdate(message) || !message.plate) return [];
  const sameSession = (message.session ?? "") === seen.session;
  const incoming = incomingRows(message);
  const holds: BridgeHold[] = [];
  const hold = (object: string, name: string, kind: BridgeHoldKind) => holds.push({ object, name, kind, reason: bridgeHoldReason(name, kind) });
  for (const row of current) {
    if (!options.protectedModel?.(row)) continue;
    const next = incoming.get(row.id);
    if ((next && next.meshHash !== row.meshHash) || (!next && sameSession && owned.has(row.id))) hold(row.id, row.name, "model-history");
  }
  if (!sameSession) return holds;
  const here = new Map(current.map((row) => [row.id, row]));
  for (const [id, before] of baseline) {
    if (holds.some((row) => row.object === id)) continue;
    const human = here.get(id);
    const remote = incoming.get(id);
    if (!humanChanged(id, before, human, options.touched) || sameBridgeObject(human, remote)) continue;
    if (!human) hold(id, before.name, "removed-here");
    else if (!sameBridgeObject(before, remote)) hold(id, human.name, "both-changed");
  }
  return holds;
}

/**
 * The snapshot as this desktop applies it: a held part keeps the desktop's version (or stays removed), a person's change
 * to a part MCP left alone is carried forward, and every other row is MCP's. `diverged` says a person's change was kept.
 */
export function bridgeMerge<T>(
  current: readonly MirrorObject<T>[],
  message: BridgeMessage,
  seen: BridgeSeen,
  baseline: ReadonlyMap<string, MirrorObject<null>>,
  holds: readonly BridgeHold[],
  touched?: ReadonlySet<string>,
): { message: BridgeMessage; diverged: boolean } {
  if (!bridgeIsNew(seen, message) || !bridgeHasPlateUpdate(message) || !message.plate) return { message, diverged: false };
  const sameSession = (message.session ?? "") === seen.session;
  const here = new Map(current.map((row) => [row.id, row]));
  const incoming = incomingRows(message);
  const held = new Set(holds.map((row) => row.object));
  const asRow = (human: MirrorObject<T>, row?: BridgePlateRow): BridgePlateRow => ({ ...(row ?? {}), object: human.id, name: human.name, scalePercent: human.scalePercent, centered: human.centered, offset: { ...human.offset }, orient: [...human.orient] as Mat3, meshHash: human.meshHash });
  let diverged = false;
  const plate: BridgePlateRow[] = [];
  for (const row of message.plate) {
    const human = here.get(row.object);
    if (held.has(row.object)) {
      if (human) plate.push(asRow(human, row));
      continue;
    }
    const before = baseline.get(row.object);
    if (sameSession && before && human && humanChanged(row.object, before, human, touched) && sameBridgeObject(before, incoming.get(row.object))) {
      plate.push(asRow(human, row));
      diverged = true;
      continue;
    }
    plate.push(row);
  }
  // A held part MCP removed stays on the desktop, as the window has it.
  for (const id of held) {
    const human = here.get(id);
    if (human && !incoming.has(id)) plate.push(asRow(human));
  }
  return { message: { ...message, plate }, diverged };
}

/** The shared version after a snapshot: MCP's rows, except that a held part keeps the version both last agreed on. */
export function bridgeNextBaseline(message: BridgeMessage, previous: ReadonlyMap<string, MirrorObject<null>>, holds: readonly BridgeHold[]): Map<string, MirrorObject<null>> {
  const next = bridgeServerBaseline(message);
  for (const { object } of holds) {
    const before = previous.get(object);
    if (before) next.set(object, before);
    else next.delete(object);
  }
  return next;
}

/**
 * What MCP's version of a part replaced in the window, for the receipt, so the agent can tell the person:
 * - `human-edits`: a person changed the part here (an undo step did) and MCP changed it too;
 * - `removed-here`: a person removed it here and MCP changed it, so it is back;
 * - `model-history`: the window held a Model history for it that MCP's is not built on (not the same steps, nor those
 *   steps and more), such as an older copy of the project. A history MCP's continues is not reported: that is a
 *   fast-forward, and nothing of the window's is lost.
 * The window's version is one Ctrl+Z away in every case.
 */
export type BridgeReplacedKind = "human-edits" | "removed-here" | "model-history";

export interface BridgeReplaced {
  object: string;
  name: string;
  kind: BridgeReplacedKind;
}

/** The parts whose shape this snapshot changes on the desktop: a new mesh, or MCP removed a part it had sent. */
export function bridgeShapeChanges<T>(current: readonly MirrorObject<T>[], message: BridgeMessage, seen: BridgeSeen, owned: ReadonlySet<string>): string[] {
  if (!bridgeIsNew(seen, message) || !bridgeHasPlateUpdate(message) || !message.plate) return [];
  const sameSession = (message.session ?? "") === seen.session;
  const incoming = new Map(message.plate.map((row) => [row.object, row]));
  return current.filter((row) => {
    const next = incoming.get(row.id);
    return next ? (next.meshHash ?? "") !== row.meshHash : sameSession && owned.has(row.id);
  }).map((row) => row.id);
}

/**
 * MCP's snapshot always applies (the owner's Tandem rule: a change made through MCP shows in the window live, every
 * time). What it overwrites in the window becomes one undo step there instead of a hold:
 * - `swaps`: every part whose window version is replaced and must come back with Ctrl+Z: a part with a Model history
 *   here whose shape MCP changed or removed, and a part a person changed here that MCP changed too (or a person removed).
 * - `replaced`: the ones to report, with why (see `BridgeReplacedKind`). `historyBehind(id)` says whether the window's
 *   history for a part is the same as MCP's incoming one or an ancestor of it; null when it cannot tell.
 */
export function bridgeOverrides<T>(
  current: readonly MirrorObject<T>[],
  message: BridgeMessage,
  seen: BridgeSeen,
  baseline: ReadonlyMap<string, MirrorObject<null>>,
  owned: ReadonlySet<string>,
  options: { hasModel?: (row: MirrorObject<T>) => boolean; touched?: ReadonlySet<string>; historyBehind?: (id: string) => boolean | null } = {},
): { swaps: string[]; replaced: BridgeReplaced[] } {
  const found = bridgeHolds(current, message, seen, baseline, owned, { protectedModel: options.hasModel, touched: options.touched });
  const here = new Map(current.map((row) => [row.id, row]));
  const replaced: BridgeReplaced[] = [];
  for (const hold of found) {
    if (hold.kind === "both-changed") replaced.push({ object: hold.object, name: hold.name, kind: "human-edits" });
    else if (hold.kind === "removed-here") replaced.push({ object: hold.object, name: hold.name, kind: "removed-here" });
    else if (options.touched?.has(hold.object) && (!baseline.has(hold.object) || !sameBridgeObject(baseline.get(hold.object), here.get(hold.object)))) replaced.push({ object: hold.object, name: hold.name, kind: "human-edits" });
    else if (message.plate?.some((row) => row.object === hold.object) && options.historyBehind?.(hold.object) !== true) replaced.push({ object: hold.object, name: hold.name, kind: "model-history" });
  }
  return { swaps: found.map((hold) => hold.object), replaced };
}

/** A Model history as the bridge compares it: the root, and the steps from the root to the plate's step. */
export interface BridgeHistoryShape {
  /** Any text that is the same exactly when the root is: a primitive's or a feature's JSON, a STEP's size and hash. */
  root: string;
  nodes: readonly { id: number; parent: number | null; op: unknown }[];
  committed: number;
}

/** The same JSON whatever the key order, so an op read from a file and one built in memory compare equal. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value as Record<string, unknown>).sort().filter((key) => (value as Record<string, unknown>)[key] !== undefined).map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function historyPath(shape: BridgeHistoryShape): string[] | null {
  const byId = new Map(shape.nodes.map((node) => [node.id, node]));
  const path: string[] = [];
  let at: number | null = shape.committed;
  for (let guard = 0; at !== null; guard += 1) {
    const node = byId.get(at);
    if (!node || guard > byId.size) return null;
    if (node.parent !== null) path.push(stableJson(node.op));
    at = node.parent;
  }
  return path.reverse();
}

/**
 * How the window's history for a part stands to MCP's: `same`, `behind` (MCP's is the window's steps and more: a
 * fast-forward, the common case when the window opened a project MCP saved), `kept` (MCP's plate step is elsewhere,
 * after an undo say, but its tree still holds all the window's steps), or `diverged`. Null when either is unknown.
 */
export function bridgeHistoryRelation(here: BridgeHistoryShape | null, incoming: BridgeHistoryShape | null): "same" | "behind" | "kept" | "diverged" | null {
  if (!here || !incoming) return null;
  if (here.root !== incoming.root) return "diverged";
  const mine = historyPath(here);
  const theirs = historyPath(incoming);
  if (!mine || !theirs) return null;
  if (mine.length <= theirs.length && mine.every((op, at) => op === theirs[at])) return mine.length === theirs.length ? "same" : "behind";
  // MCP went back (an undo, a step on another branch) but its tree still holds every step of the window's: `kept`.
  return holdsPath(incoming, mine) ? "kept" : "diverged";
}

/** Whether `path`'s steps lead down from the root of `tree`, on any branch. */
function holdsPath(tree: BridgeHistoryShape, path: readonly string[]): boolean {
  const root = tree.nodes.find((node) => node.parent === null);
  let at: number[] = root ? [root.id] : [];
  for (const op of path) {
    at = tree.nodes.filter((node) => node.parent !== null && at.includes(node.parent) && stableJson(node.op) === op).map((node) => node.id);
    if (at.length === 0) return false;
  }
  return true;
}

/** The root text of a history as a project file (and the bridge) carries it. */
export function bridgeSavedRoot(tree: { rootPrimitive?: unknown; rootFeature?: unknown; rootStep?: { byteLength?: number; hash?: string } | null }): string {
  if (tree.rootPrimitive) return `primitive:${stableJson(tree.rootPrimitive)}`;
  if (tree.rootFeature) return `feature:${stableJson(tree.rootFeature)}`;
  return `step:${tree.rootStep?.byteLength ?? 0}:${tree.rootStep?.hash ?? ""}`;
}

/**
 * The name of the window's undo step for MCP's change: "Assistant: Fuse Ornament gear on Glasses frame". The product
 * names no vendor, since any MCP client can drive it; the step says what was done, from MCP's `change` or the tool.
 */
export function bridgeSwapLabel(message: BridgeMessage, names: readonly string[]): string {
  const what = (message.change?.trim() || (message.tool ?? "change").replaceAll("_", " ")).slice(0, 80);
  const parts = names.length === 0 ? "" : names.length <= 2 ? names.join(" and ") : `${names[0]} and ${names.length - 1} more parts`;
  return `Assistant: ${what}${parts ? ` on ${parts}` : ""}`;
}

/** A plate object's pose and mesh, as a person's edit can change them. `mesh` is any token that changes with the mesh. */
export interface BridgeTouchRow {
  id: string;
  name: string;
  orient: readonly number[];
  partScale: number;
  centered: boolean;
  offset: { x: number; y: number; z: number };
  mesh?: string;
}

/** The objects an edit changed, added or removed: what goes in `touched`. */
export function bridgeTouched(before: readonly BridgeTouchRow[], after: readonly BridgeTouchRow[]): string[] {
  const was = new Map(before.map((row) => [row.id, row]));
  const ids = new Set<string>();
  for (const row of after) {
    const old = was.get(row.id);
    was.delete(row.id);
    if (!old || old.name !== row.name || old.partScale !== row.partScale || old.centered !== row.centered || old.mesh !== row.mesh
      || old.offset.x !== row.offset.x || old.offset.y !== row.offset.y || old.offset.z !== row.offset.z
      || old.orient.some((value, index) => value !== row.orient[index])) ids.add(row.id);
  }
  for (const id of was.keys()) ids.add(id);
  return [...ids];
}

/** Mirrored parts whose pose on the desktop is no longer the pose the mirror just wrote: the window moved them by itself. */
export function bridgeDrifted<T>(written: readonly MirrorObject<T>[], now: readonly MirrorObject<T>[], owned: ReadonlySet<string>): string[] {
  const here = new Map(now.map((row) => [row.id, row]));
  return written.filter((row) => owned.has(row.id) && here.has(row.id) && !sameBridgeObject({ ...row, meshHash: "" }, { ...here.get(row.id)!, meshHash: "" })).map((row) => row.id);
}

/** A detached copy of the last plate state actually accepted by this desktop. */
export function bridgeBaseline<T>(plate: readonly MirrorObject<T>[], owned: ReadonlySet<string>): Map<string, MirrorObject<null>> {
  return new Map(plate.filter((row) => owned.has(row.id)).map((row) => [row.id, {
    id: row.id, name: row.name, scalePercent: row.scalePercent, centered: row.centered,
    offset: { ...row.offset }, orient: [...row.orient] as Mat3, meshHash: row.meshHash, extra: null,
  }]));
}

/** Remember what the server sent, even when the desktop keeps its own independent edit. */
export function bridgeServerBaseline(message: BridgeMessage): Map<string, MirrorObject<null>> {
  return new Map((message.plate ?? []).map((row) => [row.object, {
    id: row.object, name: row.name, scalePercent: row.scalePercent, centered: row.centered,
    offset: { ...row.offset }, orient: [...row.orient] as Mat3, meshHash: row.meshHash ?? "", extra: null,
  }]));
}

function sameBridgeObject(a: MirrorObject<unknown> | undefined, b: MirrorObject<unknown> | undefined): boolean {
  if (!a || !b) return a === b;
  return a.name === b.name && a.scalePercent === b.scalePercent && a.centered === b.centered && a.meshHash === b.meshHash
    && a.offset.x === b.offset.x && a.offset.y === b.offset.y && a.offset.z === b.offset.z
    && a.orient.every((value, index) => value === b.orient[index]);
}

/**
 * A small description of a person's edits to previously mirrored parts, without transferring meshes. With `touched`,
 * only the parts a person edited count: a difference the window made by itself is not reported as theirs.
 */
export function bridgeHumanChanges<T>(current: readonly MirrorObject<T>[], baseline: ReadonlyMap<string, MirrorObject<null>>, touched?: ReadonlySet<string>): Array<Record<string, unknown>> {
  const here = new Map(current.map((row) => [row.id, row]));
  const changed: Array<Record<string, unknown>> = [];
  for (const [id, before] of baseline) {
    const row = here.get(id);
    if (!humanChanged(id, before, row, touched)) continue;
    if (!row) changed.push({ object: id, name: before.name, removed: true });
    else changed.push({ object: id, name: row.name, scalePercent: row.scalePercent, centered: row.centered, offset: { ...row.offset }, orient: [...row.orient], meshChanged: row.meshHash !== before.meshHash, base: { name: before.name, scalePercent: before.scalePercent, centered: before.centered, offset: { ...before.offset }, orient: [...before.orient], meshHash: before.meshHash } });
  }
  return changed;
}

/** The first part a snapshot would overwrite after a desktop edit since the last accepted snapshot, or null. */
export function bridgeConflict<T>(current: readonly MirrorObject<T>[], message: BridgeMessage, seen: BridgeSeen, baseline: ReadonlyMap<string, MirrorObject<null>>, touched?: ReadonlySet<string>): string | null {
  return bridgeHolds(current, message, seen, baseline, new Set(), { touched })[0]?.name ?? null;
}

/** Carry a desktop-only change forward when the incoming server row still equals the shared baseline. */
export function bridgePreserveHuman<T>(current: readonly MirrorObject<T>[], message: BridgeMessage, seen: BridgeSeen, baseline: ReadonlyMap<string, MirrorObject<null>>, touched?: ReadonlySet<string>): BridgeMessage {
  return bridgeMerge(current, message, seen, baseline, [], touched).message;
}

/** True when this message is newer than what the window has, or comes from a new server process. */
export function bridgeIsNew(seen: BridgeSeen, message: BridgeMessage): boolean {
  if (typeof message.seq !== "number") return true;
  if ((message.session ?? "") !== seen.session) return true;
  return message.seq > seen.seq;
}

function nextSeen(seen: BridgeSeen, message: BridgeMessage): BridgeSeen {
  if (typeof message.seq !== "number") return seen;
  return { session: message.session ?? "", seq: message.seq };
}

/** The settings a message sets, or null. */
export function bridgeSettings(message: BridgeMessage): BridgeSettings | null {
  if (message.ok === false) return null;
  if (message.tool !== "settings_apply" && message.tool !== "settings_set") return null;
  return message.settings ?? null;
}

/**
 * Apply one mirror to the desktop plate.
 * Rows replace the pose of the object with the same id, and its mesh when the hash moved.
 * A new id is added. An id the server sent before and no longer lists is removed.
 * Objects the server never named stay where they are.
 * An older message, a failed tool, or one that does not change the plate leaves the plate alone.
 */
export function mirrorPlate<T>(
  current: readonly MirrorObject<T>[],
  message: BridgeMessage,
  seen: BridgeSeen,
  owned: ReadonlySet<string> = new Set(),
): MirrorResult<T> {
  const unchanged = (applied: boolean, missing: string | null = null): MirrorResult<T> => ({
    plate: [...current],
    seen: applied ? nextSeen(seen, message) : seen,
    owned: new Set(owned),
    missing,
    applied,
    selectId: null,
  });
  if (!bridgeIsNew(seen, message)) return unchanged(false);
  // A new server process numbers its objects again: what the old one sent is the desktop's now.
  const stillOwned = (message.session ?? "") === seen.session ? owned : new Set<string>();
  if (message.ok === false || !message.tool || !PLATE_TOOLS.has(message.tool) || !message.plate) {
    return { ...unchanged(true), owned: new Set(stillOwned) };
  }
  const rows = message.plate;
  const byId = new Map(current.map((obj) => [obj.id, obj]));
  const decoded = new Map<string, NonNullable<MirrorObject["mesh"]>>();
  for (const row of rows) {
    const old = byId.get(row.object);
    const hash = row.meshHash ?? "";
    if (old && old.meshHash === hash) continue;
    const sent = decoded.get(hash) ?? decodeMesh(message.meshes?.[hash]);
    if (!sent) return unchanged(false, BRIDGE_RESEND);
    decoded.set(hash, sent);
  }
  const listed = new Set(rows.map((row) => row.object));
  const plate: MirrorObject<T>[] = [];
  for (const obj of current) {
    if (listed.has(obj.id)) continue;
    if (stillOwned.has(obj.id)) continue;
    plate.push(obj);
  }
  // Server objects keep the server's order, after the desktop's own.
  for (const row of rows) {
    const old = byId.get(row.object);
    const hash = row.meshHash ?? "";
    const mesh = old && old.meshHash === hash ? undefined : decoded.get(hash);
    const modelPose = bridgeModelPose(row.modelPose);
    plate.push({
      id: row.object,
      name: row.name,
      scalePercent: row.scalePercent,
      centered: row.centered,
      offset: { ...row.offset },
      orient: [...row.orient] as Mat3,
      meshHash: hash,
      ...(mesh ? { mesh } : {}),
      ...(modelPose ? { model: { pose: modelPose, ...(row.frame === "part" ? { frame: "part" as const } : {}) } } : {}),
      extra: old ? old.extra : null,
    });
  }
  const selectId = message.objectId && listed.has(message.objectId) ? message.objectId : null;
  return { plate, seen: nextSeen(seen, message), owned: listed, missing: null, applied: true, selectId };
}

function decodeMesh(mesh: BridgeMesh | undefined): MirrorObject["mesh"] | null {
  if (!mesh) return null;
  const bytes = base64ToBytes(mesh.bytesB64);
  const raw = base64ToBytes(mesh.positionsB64);
  if (!bytes || bytes.byteLength === 0 || !raw || raw.byteLength < 36 || raw.byteLength % 36 !== 0) return null;
  // A copy so the floats start on a 4-byte boundary.
  const aligned = new Uint8Array(raw.byteLength);
  aligned.set(raw);
  return {
    fileName: mesh.fileName,
    bytes,
    source: new Float32Array(aligned.buffer),
    ...(typeof mesh.seatMm === "number" && Number.isFinite(mesh.seatMm) ? { seatMm: mesh.seatMm } : {}),
  };
}

/** Keep a mirror until the gesture ends. Nothing is dropped for being old. */
export function parkBridge(queue: BridgeMessage[], message: BridgeMessage): BridgeMessage[] {
  return [...queue, message];
}

/** New arrays, never `queue` itself: the caller empties its queue in place and must not empty `ready` with it. */
export function releaseBridge(queue: readonly BridgeMessage[], poseHud: string): { ready: BridgeMessage[]; waiting: BridgeMessage[] } {
  if (poseHud) return { ready: [], waiting: [...queue] };
  return { ready: [...queue], waiting: [] };
}
