/**
 * Opt-in live mirror. The desktop listens for `lime-bridge` only inside Tauri.
 * The headless MCP server does not import this file.
 */
import { applyBridge, BRIDGE_RELOAD, parkBridge, releaseBridge, runBridgePatch, type BridgeMessage, type BridgePatch, type BridgePlateRow, type BridgeView } from "../bridge.ts";
import type { Mat3 } from "../mesh-place.ts";
import { withoutObject } from "../plate.ts";
import { isTauri } from "../platform.ts";
import { place } from "./files.ts";
import { markStale, renderChrome } from "./settings.ts";
import { state } from "./state.ts";

const waiting: BridgeMessage[] = [];
let boundId = "";
let seenSeq = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

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

function applyMessage(message: BridgeMessage): void {
  waiting.splice(0, waiting.length, ...parkBridge(waiting, message));
  flush();
}

function flush(): void {
  const released = releaseBridge(waiting, state.poseHud);
  waiting.splice(0, waiting.length, ...released.waiting);
  for (const message of released.ready) commit(message);
  if (waiting.length > 0 && timer === undefined) {
    timer = setTimeout(() => {
      timer = undefined;
      flush();
    }, 200);
  }
}

function assign(patch: BridgePatch): void {
  if (patch.unbind) boundId = "";
  if (patch.bindId) boundId = patch.bindId;
  if (patch.orient) state.orient = patch.orient;
  if (typeof patch.partScale === "number") state.partScale = patch.partScale;
  if (typeof patch.centered === "boolean") state.centered = patch.centered;
  if (patch.offset) state.offset = patch.offset;
  if (typeof patch.layerHeight === "number") state.layerHeight = patch.layerHeight;
  if (typeof patch.supports === "boolean") state.supports = patch.supports;
  if (patch.blendKind === "single" || patch.blendKind === "weight" || patch.blendKind === "byLayer" || patch.blendKind === "byRegion") state.blendKind = patch.blendKind;
  if (patch.strategy === "speed" || patch.strategy === "toughness") state.strategy = patch.strategy;
  if (typeof patch.toughness === "number") state.toughness = patch.toughness;
}

function commit(message: BridgeMessage): void {
  const patch = applyBridge(view(), message, boundId, seenSeq);
  if (patch.reload) {
    state.notice = patch.reload;
    return;
  }
  if (typeof patch.seq === "number") seenSeq = patch.seq;
  runBridgePatch(patch, {
    assign,
    place: () => place("transform"),
    markStale: () => markStale(),
    renderChrome: () => renderChrome(),
  });
  if (patch.plate) adoptPlate(patch.plate);
  // A commit names a STEP file. Reading it needs the desktop window, so the
  // mesh replace stays on `mirrorPlate` until that window is open.
  if (patch.commit) state.notice = BRIDGE_RELOAD;
}

/** Copy poses onto objects this window already shows. A new id asks for a reload. */
function adoptPlate(rows: BridgePlateRow[]): void {
  const ids = new Set(rows.map((row) => row.object));
  const have = new Set(state.plate.objects.map((obj) => obj.id));
  const added = rows.some((row) => !have.has(row.object));
  const last = state.plate.objects.length === 1 ? state.plate.objects[0] : undefined;
  if (added || (last && !ids.has(last.id))) {
    state.notice = BRIDGE_RELOAD;
    return;
  }
  let plate = state.plate;
  for (const obj of [...plate.objects]) {
    if (!ids.has(obj.id)) plate = withoutObject(plate, obj.id);
  }
  const byId = new Map(rows.map((row) => [row.object, row]));
  state.plate = {
    ...plate,
    objects: plate.objects.map((obj) => {
      const row = byId.get(obj.id);
      if (!row) return obj;
      return {
        ...obj,
        orient: [...row.orient] as Mat3,
        partScale: row.scalePercent / 100,
        centered: row.centered,
        offset: { ...row.offset },
      };
    }),
  };
}

export function mountBridge(): void {
  if (!isTauri()) return;
  void import("@tauri-apps/api/event").then(({ listen }) => {
    void listen<BridgeMessage>("lime-bridge", (event) => {
      applyMessage(event.payload);
    });
  });
}
