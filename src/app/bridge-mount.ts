/**
 * Opt-in live mirror. The desktop listens for `lime-bridge` only inside Tauri.
 * The headless MCP server does not import this file.
 */
import { applyBridge, type BridgeMessage, type BridgeView } from "../bridge.ts";
import { isTauri } from "../platform.ts";
import { place } from "./files.ts";
import { state } from "./state.ts";

function view(): BridgeView {
  return {
    meshName: state.mesh?.name.replace(/\.(stl|3mf|step|stp)$/i, "") ?? "",
    poseHud: state.poseHud,
    orient: state.orient,
    partScale: state.partScale,
    centered: state.centered,
    offset: { ...state.offset },
    layerHeight: state.layerHeight,
    supports: state.supports,
    blendKind: state.blendKind,
    strategy: state.strategy,
    toughness: state.toughness,
    source: state.sourcePos,
  };
}

function applyMessage(message: BridgeMessage, tries = 0): void {
  const patch = applyBridge(view(), message);
  if (patch.wait) {
    if (tries < 8) setTimeout(() => applyMessage(message, tries + 1), 200);
    return;
  }
  if (patch.orient) state.orient = patch.orient;
  if (typeof patch.partScale === "number") state.partScale = patch.partScale;
  if (typeof patch.centered === "boolean") state.centered = patch.centered;
  if (patch.offset) state.offset = patch.offset;
  if (typeof patch.layerHeight === "number") state.layerHeight = patch.layerHeight;
  if (typeof patch.supports === "boolean") state.supports = patch.supports;
  if (patch.blendKind) state.blendKind = patch.blendKind as typeof state.blendKind;
  if (patch.strategy === "speed" || patch.strategy === "toughness") state.strategy = patch.strategy;
  if (typeof patch.toughness === "number") state.toughness = patch.toughness;
  if (patch.place) place("transform");
}

export function mountBridge(): void {
  if (!isTauri()) return;
  void import("@tauri-apps/api/event").then(({ listen }) => {
    void listen<BridgeMessage>("lime-bridge", (event) => {
      applyMessage(event.payload);
    });
  });
}
