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

/** Never replace or remove a desktop Model history with a mesh-only bridge snapshot. */
export function bridgeProtectedModel<T>(current: readonly MirrorObject<T>[], message: BridgeMessage, seen: BridgeSeen, owned: ReadonlySet<string>, hasModel: (extra: T | null) => boolean): string | null {
  if (!bridgeIsNew(seen, message) || !bridgeHasPlateUpdate(message) || !message.plate) return null;
  const incoming = new Map(message.plate.map((row) => [row.object, row]));
  for (const row of current) {
    if (!hasModel(row.extra)) continue;
    const next = incoming.get(row.id);
    if ((next && (next.meshHash ?? "") !== row.meshHash) || (!next && (message.session ?? "") === seen.session && owned.has(row.id))) return row.name;
  }
  return null;
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

/** A small description of local edits to previously mirrored parts, without transferring meshes. */
export function bridgeHumanChanges<T>(current: readonly MirrorObject<T>[], baseline: ReadonlyMap<string, MirrorObject<null>>): Array<Record<string, unknown>> {
  const here = new Map(current.map((row) => [row.id, row]));
  const changed: Array<Record<string, unknown>> = [];
  for (const [id, before] of baseline) {
    const row = here.get(id);
    if (sameBridgeObject(before, row)) continue;
    if (!row) changed.push({ object: id, name: before.name, removed: true });
    else changed.push({ object: id, name: row.name, scalePercent: row.scalePercent, centered: row.centered, offset: { ...row.offset }, orient: [...row.orient], meshChanged: row.meshHash !== before.meshHash, base: { name: before.name, scalePercent: before.scalePercent, centered: before.centered, offset: { ...before.offset }, orient: [...before.orient], meshHash: before.meshHash } });
  }
  return changed;
}

/** Refuse a snapshot that would overwrite a desktop edit since the last accepted snapshot. */
export function bridgeConflict<T>(current: readonly MirrorObject<T>[], message: BridgeMessage, seen: BridgeSeen, baseline: ReadonlyMap<string, MirrorObject<null>>): string | null {
  if (!bridgeIsNew(seen, message) || (message.session ?? "") !== seen.session || !bridgeHasPlateUpdate(message) || !message.plate) return null;
  const here = new Map(current.map((row) => [row.id, row]));
  const incoming = new Map(message.plate.map((row) => [row.object, {
    id: row.object, name: row.name, scalePercent: row.scalePercent, centered: row.centered,
    offset: row.offset, orient: row.orient, meshHash: row.meshHash ?? "", extra: null,
  }]));
  for (const [id, before] of baseline) {
    const human = here.get(id);
    const remote = incoming.get(id);
    if (!sameBridgeObject(before, human) && !sameBridgeObject(human, remote) && (!human || !sameBridgeObject(before, remote))) return human?.name ?? before.name;
  }
  return null;
}

/** Carry a desktop-only change forward when the incoming server row still equals the shared baseline. */
export function bridgePreserveHuman<T>(current: readonly MirrorObject<T>[], message: BridgeMessage, seen: BridgeSeen, baseline: ReadonlyMap<string, MirrorObject<null>>): BridgeMessage {
  if (!bridgeIsNew(seen, message) || (message.session ?? "") !== seen.session || !bridgeHasPlateUpdate(message) || !message.plate) return message;
  const here = new Map(current.map((row) => [row.id, row]));
  const incoming = bridgeServerBaseline(message);
  return { ...message, plate: message.plate.map((row) => {
    const before = baseline.get(row.object);
    const human = here.get(row.object);
    if (!before || !human || sameBridgeObject(before, human) || !sameBridgeObject(before, incoming.get(row.object))) return row;
    return { ...row, name: human.name, scalePercent: human.scalePercent, centered: human.centered, offset: { ...human.offset }, orient: [...human.orient] as Mat3, meshHash: human.meshHash };
  }) };
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
