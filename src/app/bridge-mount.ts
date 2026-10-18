/**
 * Opt-in live mirror. The desktop listens for `lime-bridge` only inside Tauri.
 * The headless MCP server does not import this file.
 */
import { bridgeSettings, mirrorPlate, parkBridge, releaseBridge, type BridgeMessage, type BridgeSeen, type MirrorObject } from "../bridge.ts";
import type { Mat3 } from "../mesh-place.ts";
import { bridgedObject, emptyPlate, mirroredPlate, setMeshSeat, type PlateObject } from "../plate.ts";
import { isTauri } from "../platform.ts";
import { fnv1aHex } from "../slice-action.ts";
import { pushToast } from "../ui/toasts.ts";
import { place } from "./files.ts";
import { fx } from "./fx.ts";
import { followSelection, releaseModelTrees } from "./model.ts";
import { applySelectedToState, syncPlateFromState } from "./plate-sync.ts";
import { markStale, renderChrome } from "./settings.ts";
import { state, STEP_TOLERANCE_DEFAULT } from "./state.ts";

const waiting: BridgeMessage[] = [];
let seen: BridgeSeen = { session: "", seq: 0 };
/** Server objects on this plate. The mirror never removes an object outside this set. */
let owned = new Set<string>();
let timer: ReturnType<typeof setTimeout> | undefined;
let lastMissing = "";
/** A mesh hash per buffer, so a big part is hashed once and not on every message. */
const hashes = new WeakMap<ArrayBuffer, string>();

function hashOf(bytes: ArrayBuffer): string {
  let hash = hashes.get(bytes);
  if (!hash) {
    hash = fnv1aHex(new Uint8Array(bytes));
    hashes.set(bytes, hash);
  }
  return hash;
}

function applyMessage(message: BridgeMessage): void {
  waiting.splice(0, waiting.length, ...parkBridge(waiting, message));
  flush();
}

function flush(): void {
  const released = releaseBridge(waiting, state.poseHud);
  waiting.splice(0, waiting.length, ...released.waiting);
  for (const message of released.ready) {
    try {
      apply(message);
    } catch (err) {
      // A mirror never stops the window. Say what went wrong, so it is not a silent empty plate.
      pushToast(`The MCP mirror could not be shown: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }
  if (waiting.length > 0 && timer === undefined) {
    timer = setTimeout(() => {
      timer = undefined;
      flush();
    }, 200);
  }
}

function apply(message: BridgeMessage): void {
  const settings = bridgeSettings(message);
  if (settings) assignSettings(settings);
  // The selected object's live pose is the plate's before the mirror compares against it.
  syncPlateFromState();
  const current: MirrorObject<PlateObject>[] = state.plate.objects.map((obj) => ({
    id: obj.id,
    name: obj.name,
    scalePercent: obj.partScale * 100,
    centered: obj.centered,
    offset: { ...obj.offset },
    orient: [...obj.orient] as Mat3,
    meshHash: hashOf(obj.bytes),
    extra: obj,
  }));
  const result = mirrorPlate(current, message, seen, owned);
  if (result.missing) {
    // Say it once per gap. Telling the listener this window is new makes the server send every mesh again.
    if (lastMissing !== `${message.session}:${message.seq}`) pushToast(result.missing, "info");
    lastMissing = `${message.session}:${message.seq}`;
    void announce();
    return;
  }
  seen = result.seen;
  owned = result.owned;
  const plateChanged = result.plate.length !== current.length || result.plate.some((obj, at) => obj.mesh || obj.extra !== current[at]?.extra || !samePose(obj, current[at]));
  if (!plateChanged) {
    if (settings) {
      markStale();
      renderChrome();
    }
    return;
  }
  const objects = result.plate.map(toPlateObject);
  if (objects.length === 0) {
    state.plate = emptyPlate();
    state.mesh = null;
    state.sourcePos = null;
  } else {
    state.plate = mirroredPlate(objects, result.selectId ?? state.plate.selectedId);
    applySelectedToState(state.plate);
  }
  releaseModelTrees();
  place("load");
  markStale();
  // A fresh window opens on Preview, and a changed plate makes any preview stale: show the plate. Model stays put.
  if (objects.length > 0 && state.stage !== "model" && state.stage !== "prepare") fx.setStage("prepare");
  followSelection();
  renderChrome();
}

function samePose(next: MirrorObject<PlateObject>, before: MirrorObject<PlateObject> | undefined): boolean {
  if (!before || before.id !== next.id || before.name !== next.name) return false;
  if (before.scalePercent !== next.scalePercent || before.centered !== next.centered) return false;
  if (before.offset.x !== next.offset.x || before.offset.y !== next.offset.y || before.offset.z !== next.offset.z) return false;
  return before.orient.every((value, at) => value === next.orient[at]);
}

/** A mirrored row as the desktop's plate object. A new mesh drops the desktop's own solid and Model history for it. */
function toPlateObject(row: MirrorObject<PlateObject>): PlateObject {
  const pose = {
    name: row.name,
    orient: [...row.orient] as Mat3,
    partScale: row.scalePercent / 100,
    centered: row.centered,
    offset: { ...row.offset },
  };
  // `mirrorPlate` sends a mesh with every row the desktop did not have, so a row without one has `extra`.
  if (!row.mesh) return { ...row.extra!, ...pose };
  const bytes = row.mesh.bytes.buffer.slice(row.mesh.bytes.byteOffset, row.mesh.bytes.byteOffset + row.mesh.bytes.byteLength) as ArrayBuffer;
  hashes.set(bytes, row.meshHash);
  if (row.mesh.seatMm !== undefined) setMeshSeat(bytes, row.mesh.seatMm);
  const incoming = {
    name: row.name,
    fileName: row.mesh.fileName,
    bytes,
    sourcePos: row.mesh.source,
    stepTolerance: row.extra?.stepTolerance ?? STEP_TOLERANCE_DEFAULT,
  };
  if (!row.extra) return { ...bridgedObject(row.id, row.name, incoming), ...pose };
  const next: PlateObject = { ...row.extra, ...pose, fileName: incoming.fileName, bytes, sourcePos: incoming.sourcePos };
  delete next.brep;
  delete next.modelTree;
  delete next.modelPose;
  delete next.workplane;
  return next;
}

function assignSettings(settings: NonNullable<ReturnType<typeof bridgeSettings>>): void {
  if (typeof settings.layerHeight === "number") state.layerHeight = settings.layerHeight;
  if (typeof settings.supports === "boolean") state.supports = settings.supports;
  if (settings.blendKind === "single" || settings.blendKind === "weight" || settings.blendKind === "byLayer" || settings.blendKind === "byRegion") state.blendKind = settings.blendKind;
  if (settings.strategy === "speed" || settings.strategy === "toughness") state.strategy = settings.strategy;
  if (typeof settings.toughness === "number") state.toughness = settings.toughness;
}

/** Tell the listener this page is new, so the server's next message carries every mesh. */
async function announce(): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("bridge_ready");
  } catch {
    // The bridge is off, or this build has no listener: nothing to announce.
  }
}

/** Drop the mirrored plate so a new document does not keep the previous MCP session. */
export function resetBridgeMirror(): void {
  waiting.splice(0, waiting.length);
  seen = { session: "", seq: 0 };
  owned = new Set();
  lastMissing = "";
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  void announce();
}

export function mountBridge(): void {
  if (!isTauri()) return;
  void import("@tauri-apps/api/event").then(({ listen }) => {
    void listen<BridgeMessage>("lime-bridge", (event) => {
      applyMessage(event.payload);
    });
  });
  void announce();
}
