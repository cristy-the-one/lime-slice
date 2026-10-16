/**
 * A live-bridge message applied to the plate the desktop is showing.
 * The headless server stays right if this never runs. A gesture in progress
 * (`poseHud`) waits; the mirror does not interrupt it.
 */
import { ID_MATRIX, layFlatMatrix, matMul, rotX, rotY, rotZ, type Mat3 } from "./mesh-place.ts";

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

export interface BridgeMessage {
  tool?: string;
  objectName?: string;
  ok?: boolean;
  args?: {
    centreX?: number;
    centreY?: number;
    scalePercent?: number;
    centreOnBed?: boolean;
    layFlat?: boolean;
    turn?: { axis?: string; degrees?: number };
    layerHeight?: number;
    supports?: boolean;
    preset?: string;
  };
}

export interface BridgePatch {
  wait: boolean;
  place: boolean;
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

export function applyBridge(view: BridgeView, message: BridgeMessage): BridgePatch {
  if (view.poseHud) return { wait: true, place: false };
  if (message.ok === false) return { wait: false, place: false };
  const args = message.args ?? {};
  if (message.tool === "settings_apply") {
    const patch: BridgePatch = { wait: false, place: false };
    if (typeof args.layerHeight === "number") patch.layerHeight = args.layerHeight;
    if (typeof args.supports === "boolean") patch.supports = args.supports;
    if (args.preset === "speed") {
      patch.blendKind = "single";
      patch.strategy = "speed";
    } else if (args.preset === "toughness") {
      patch.blendKind = "single";
      patch.strategy = "toughness";
    } else if (args.preset === "efficiency") {
      patch.blendKind = "weight";
      patch.toughness = 0.5;
    } else if (args.preset === "layer") patch.blendKind = "byLayer";
    else if (args.preset === "region") patch.blendKind = "byRegion";
    return patch;
  }
  if (message.tool !== "object_place") return { wait: false, place: false };
  if (!message.objectName || meshStem(message.objectName) !== meshStem(view.meshName)) return { wait: false, place: false };
  let orient = view.orient;
  let partScale = view.partScale;
  let centered = view.centered;
  let offset = { ...view.offset };
  if (typeof args.scalePercent === "number") partScale = args.scalePercent / 100;
  if (args.layFlat === true && view.source) orient = layFlatMatrix(view.source);
  if (args.turn && typeof args.turn.degrees === "number") {
    const rot = args.turn.axis === "x" ? rotX(args.turn.degrees) : args.turn.axis === "y" ? rotY(args.turn.degrees) : rotZ(args.turn.degrees);
    orient = matMul(rot, orient);
  }
  if (args.centreOnBed === true) {
    centered = true;
    offset = { x: 0, y: 0, z: 0 };
  }
  if (typeof args.centreX === "number" || typeof args.centreY === "number") {
    centered = false;
    if (typeof args.centreX === "number") offset.x = args.centreX;
    if (typeof args.centreY === "number") offset.y = args.centreY;
  }
  return { wait: false, place: true, orient, partScale, centered, offset };
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
