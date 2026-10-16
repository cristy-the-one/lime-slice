/**
 * A live-bridge message applied to the plate the desktop is showing.
 * The headless server stays right if this never runs. A gesture in progress
 * (`poseHud`) waits; the mirror does not interrupt it.
 */
import { base64ToBytes } from "./base64.ts";
import { ID_MATRIX, type Mat3 } from "./mesh-place.ts";

/** Shown when a mirror skipped a sequence, or the mesh file cannot be read here. */
export const BRIDGE_RELOAD = "The MCP session changed the plate; reload from it?";

/** The stand-in STEP embeds the mesh after this mark. A real STEP file has no mark. */
const SOLID_MARK = "lime-mcp-solid ";

export interface BridgeView {
  meshName: string;
  poseHud: string;
  orient: Mat3;
  partScale: number;
  centered: boolean;
  offset: { x: number; y: number; z: number };
  layerHeight: number;
  supports: boolean;
  blendKind: string;
  strategy: string;
  toughness: number;
  source: Float32Array | null;
}

export interface BridgePlacement {
  orient: Mat3;
  scale: number;
  centered: boolean;
  offset: { x: number; y: number; z: number };
}

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
  meshHash?: string;
  file?: string;
}

/** A commit replaced the plate mesh. The desktop reloads `file` and does not replay edits. */
export interface BridgeCommit {
  object: string;
  meshHash: string;
  file: string;
}

export interface BridgeMessage {
  tool?: string;
  seq?: number;
  objectId?: string;
  objectName?: string;
  ok?: boolean;
  /** The placement after the tool, not the arguments that produced it. */
  placement?: BridgePlacement;
  /** The settings after the tool. */
  settings?: BridgeSettings;
  /** Every object on the plate after the tool. */
  plate?: BridgePlateRow[];
  /** Set only for `model_commit`. Absent for a probe or an apply. */
  commit?: BridgeCommit;
}

export interface BridgePatch {
  wait: boolean;
  place: boolean;
  stale?: boolean;
  /** The desktop's own sequence does not match this message. */
  reload?: string;
  /** The sequence this patch consumed. Absent when the message carried none. */
  seq?: number;
  /** Remember this id so a later mirror for another object is not applied here. */
  bindId?: string;
  orient?: Mat3;
  partScale?: number;
  centered?: boolean;
  offset?: { x: number; y: number; z: number };
  layerHeight?: number;
  supports?: boolean;
  blendKind?: string;
  strategy?: string;
  toughness?: number;
  /** The plate after the tool, when this tool changes the plate. */
  plate?: BridgePlateRow[];
  /** The bound object is no longer on the plate. */
  removed?: boolean;
  /** A commit. Model history is not in this patch. */
  commit?: BridgeCommit;
  historyKept?: boolean;
}

/** The headless stand-in for the plate the desktop is showing. */
export interface MirrorObject {
  id: string;
  name: string;
  scalePercent: number;
  centered: boolean;
  offset: { x: number; y: number; z: number };
  orient: Mat3;
  meshHash: string;
  source: Float32Array | null;
  /** Desktop Model history. A commit keeps this reference. */
  history: unknown;
}

export interface MirrorResult {
  plate: MirrorObject[];
  seenSeq: number;
  reload: string | null;
  applied: boolean;
}

const PLATE_TOOLS = new Set([
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
]);

function sequenceFits(seenSeq: number, next: number): boolean {
  if (seenSeq === 0) return next === 1;
  return next === seenSeq + 1;
}

function withSeq(patch: BridgePatch, message: BridgeMessage): BridgePatch {
  return typeof message.seq === "number" ? { ...patch, seq: message.seq } : patch;
}

export function applyBridge(view: BridgeView, message: BridgeMessage, boundId = "", seenSeq = 0): BridgePatch {
  if (view.poseHud) return { wait: true, place: false };
  if (typeof message.seq === "number" && !sequenceFits(seenSeq, message.seq)) {
    return { wait: false, place: false, reload: BRIDGE_RELOAD };
  }
  if (message.ok === false) return withSeq({ wait: false, place: false }, message);
  if ((message.tool === "settings_apply" || message.tool === "settings_set") && message.settings) {
    return withSeq({ wait: false, place: false, stale: true, ...message.settings }, message);
  }
  if (message.tool === "model_commit" && message.commit) {
    const row = message.plate?.find((item) => item.object === message.commit?.object);
    return withSeq({
      wait: false,
      place: Boolean(row),
      stale: true,
      historyKept: true,
      commit: message.commit,
      ...(message.plate ? { plate: message.plate } : {}),
      ...(row ? poseOf(row) : {}),
    }, message);
  }
  if (message.tool === "object_place" && message.placement) {
    if (message.objectId && boundId && message.objectId !== boundId) return withSeq({ wait: false, place: false }, message);
    const named = message.objectName ? meshStem(message.objectName) === meshStem(view.meshName) : false;
    if (!message.objectId && !named) return withSeq({ wait: false, place: false }, message);
    if (message.objectId && !boundId && message.objectName && !named) return withSeq({ wait: false, place: false }, message);
    const placement = message.placement;
    return withSeq({
      wait: false,
      place: true,
      orient: [...placement.orient] as Mat3,
      partScale: placement.scale,
      centered: placement.centered,
      offset: { ...placement.offset },
      ...(message.objectId && message.objectId !== boundId ? { bindId: message.objectId } : {}),
      ...(message.plate ? { plate: message.plate } : {}),
    }, message);
  }
  if (message.plate && message.tool && PLATE_TOOLS.has(message.tool)) {
    const id = message.objectId || boundId;
    const row = id ? message.plate.find((item) => item.object === id) : message.plate[0];
    if (!row) {
      return withSeq({ wait: false, place: false, stale: true, removed: true, plate: message.plate }, message);
    }
    return withSeq({
      wait: false,
      place: true,
      stale: true,
      plate: message.plate,
      ...poseOf(row),
    }, message);
  }
  return withSeq({ wait: false, place: false }, message);
}

function poseOf(row: BridgePlateRow): Pick<BridgePatch, "orient" | "partScale" | "centered" | "offset"> {
  return {
    orient: [...row.orient] as Mat3,
    partScale: row.scalePercent / 100,
    centered: row.centered,
    offset: { ...row.offset },
  };
}

/**
 * Apply one mirror to a plate copy.
 * A commit replaces that object's mesh and keeps its `history` reference.
 * A sequence gap leaves the plate as it was.
 */
export function mirrorPlate(
  current: readonly MirrorObject[],
  message: BridgeMessage,
  seenSeq: number,
  readFile?: (path: string) => Uint8Array | null,
): MirrorResult {
  if (typeof message.seq === "number" && !sequenceFits(seenSeq, message.seq)) {
    return { plate: [...current], seenSeq, reload: BRIDGE_RELOAD, applied: false };
  }
  const nextSeq = typeof message.seq === "number" ? message.seq : seenSeq;
  if (message.ok === false || !message.tool || !PLATE_TOOLS.has(message.tool) || !message.plate) {
    return { plate: [...current], seenSeq: nextSeq, reload: null, applied: message.ok !== false };
  }
  let positions: Float32Array | null = null;
  if (message.commit) {
    const bytes = readFile?.(message.commit.file) ?? null;
    positions = bytes ? positionsFromCommittedStep(bytes) : null;
    if (!positions || positions.length < 9) {
      return { plate: [...current], seenSeq, reload: BRIDGE_RELOAD, applied: false };
    }
  }
  const previous = new Map(current.map((obj) => [obj.id, obj]));
  const plate = message.plate.map((row) => {
    const old = previous.get(row.object);
    const committed = message.commit?.object === row.object ? positions : null;
    return {
      id: row.object,
      name: row.name,
      scalePercent: row.scalePercent,
      centered: row.centered,
      offset: { ...row.offset },
      orient: [...row.orient] as Mat3,
      meshHash: message.commit?.object === row.object ? message.commit.meshHash : (row.meshHash ?? old?.meshHash ?? ""),
      source: committed ?? old?.source ?? null,
      history: old ? old.history : null,
    };
  });
  return { plate, seenSeq: nextSeq, reload: null, applied: true };
}

/** Triangles embedded in a stand-in STEP. A real STEP file returns null. */
export function positionsFromCommittedStep(bytes: Uint8Array): Float32Array | null {
  const text = new TextDecoder().decode(bytes);
  const at = text.indexOf(SOLID_MARK);
  if (at < 0) return null;
  const encoded = text.slice(at + SOLID_MARK.length).split(/\s/)[0] ?? "";
  const raw = base64ToBytes(encoded);
  if (!raw || raw.byteLength < 36 || raw.byteLength % 4 !== 0) return null;
  const copy = new Uint8Array(raw.byteLength);
  copy.set(raw);
  return new Float32Array(copy.buffer);
}

/** Keep a mirror until the gesture ends. Nothing is dropped for being old. */
export function parkBridge(queue: BridgeMessage[], message: BridgeMessage): BridgeMessage[] {
  return [...queue, message];
}

export function releaseBridge(queue: BridgeMessage[], poseHud: string): { ready: BridgeMessage[]; waiting: BridgeMessage[] } {
  if (poseHud) return { ready: [], waiting: queue };
  return { ready: queue, waiting: [] };
}

/** Write a patch through the app: placement goes through `place`, settings mark the slice stale and redraw. */
export function runBridgePatch(
  patch: BridgePatch,
  fx: {
    assign: (patch: BridgePatch) => void;
    place: () => void;
    markStale: () => void;
    renderChrome: () => void;
  },
): void {
  if (patch.wait || (!patch.place && !patch.stale)) return;
  fx.assign(patch);
  if (patch.place) fx.place();
  if (patch.stale) {
    fx.markStale();
    fx.renderChrome();
  }
}

/** The file name with or without its mesh extension names the same part. */
function meshStem(name: string): string {
  return name.replace(/\.(stl|3mf|step|stp)$/i, "");
}

export function emptyBridgeView(name = ""): BridgeView {
  return {
    meshName: name,
    poseHud: "",
    orient: [...ID_MATRIX],
    partScale: 1,
    centered: true,
    offset: { x: 0, y: 0, z: 0 },
    layerHeight: 0.2,
    supports: false,
    blendKind: "single",
    strategy: "speed",
    toughness: 0.5,
    source: null,
  };
}
