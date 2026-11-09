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
  /** Editable histories for newly mirrored objects, in the project-file format. */
  modelHistories?: Record<string, { tree: NonNullable<PlateFileObject["modelTree"]>; brepB64?: string }>;
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

/** What to do about a held part, in a sentence a person or an agent can act on. */
export function bridgeHoldReason(name: string, kind: BridgeHoldKind): string {
  if (kind === "model-history") return `${name} has a Model history in the window, so MCP's new shape for it was held back; the rest of the plate updated. Undo the change in MCP (plate_undo) to keep the window's, or project_save from MCP and open that project in the window to take MCP's.`;
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
    plate.push({
      id: row.object,
      name: row.name,
      scalePercent: row.scalePercent,
      centered: row.centered,
      offset: { ...row.offset },
      orient: [...row.orient] as Mat3,
      meshHash: hash,
      ...(mesh ? { mesh } : {}),
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
