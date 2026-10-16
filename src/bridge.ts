/**
 * A live-bridge message applied to the plate the desktop is showing.
 * The headless server stays right if this never runs. A gesture in progress
 * (`poseHud`) waits; the mirror does not interrupt it.
 */
import { ID_MATRIX, type Mat3 } from "./mesh-place.ts";

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

export interface BridgeMessage {
  tool?: string;
  objectId?: string;
  objectName?: string;
  ok?: boolean;
  /** The placement after the tool, not the arguments that produced it. */
  placement?: BridgePlacement;
  /** The settings after the tool. */
  settings?: BridgeSettings;
}

export interface BridgePatch {
  wait: boolean;
  place: boolean;
  stale?: boolean;
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
}

export function applyBridge(view: BridgeView, message: BridgeMessage, boundId = ""): BridgePatch {
  if (view.poseHud) return { wait: true, place: false };
  if (message.ok === false) return { wait: false, place: false };
  if (message.tool === "settings_apply" && message.settings) {
    return { wait: false, place: false, stale: true, ...message.settings };
  }
  if (message.tool !== "object_place" || !message.placement) return { wait: false, place: false };
  if (message.objectId && boundId && message.objectId !== boundId) return { wait: false, place: false };
  const named = message.objectName ? meshStem(message.objectName) === meshStem(view.meshName) : false;
  if (!message.objectId && !named) return { wait: false, place: false };
  if (message.objectId && !boundId && message.objectName && !named) return { wait: false, place: false };
  const placement = message.placement;
  return {
    wait: false,
    place: true,
    orient: [...placement.orient] as Mat3,
    partScale: placement.scale,
    centered: placement.centered,
    offset: { ...placement.offset },
    ...(message.objectId && message.objectId !== boundId ? { bindId: message.objectId } : {}),
  };
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
