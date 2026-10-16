import { applyBridge, emptyBridgeView, parkBridge, releaseBridge, runBridgePatch, type BridgeMessage, type BridgePlacement } from "./bridge.ts";
import { ID_MATRIX, rotZ, type Mat3 } from "./mesh-place.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

const placement: BridgePlacement = {
  orient: rotZ(90),
  scale: 0.5,
  centered: true,
  offset: { x: 0, y: 0, z: 0 },
};
const view = emptyBridgeView("cube");
const waiting = applyBridge({ ...view, poseHud: "Scale 120%" }, { tool: "object_place", objectName: "cube", ok: true, placement });
check("a gesture in progress waits", waiting.wait && !waiting.place);

const placed = applyBridge(view, { tool: "object_place", objectName: "cube", ok: true, placement });
check("a matching place copies the result", placed.place && placed.partScale === 0.5 && placed.orient?.[1] !== 0 && placed.centered === true);

const other = applyBridge(view, { tool: "object_place", objectName: "other", ok: true, placement });
check("a different object is left alone", !other.place && other.partScale === undefined);

const named = applyBridge({ ...view, meshName: "cube.stl" }, {
  tool: "object_place",
  objectName: "cube.stl",
  ok: true,
  placement: { ...placement, scale: 0.8 },
});
check("a file name matches with its extension", named.place && named.partScale === 0.8);

const ignored = applyBridge(view, {
  tool: "object_place",
  objectName: "cube",
  ok: true,
  placement: { orient: [...ID_MATRIX] as Mat3, scale: 1, centered: false, offset: { x: 12, y: 0, z: 0 } },
});
check("the mirror uses the resulting offset, not a typed centre", ignored.place && ignored.offset?.x === 12 && ignored.centered === false);

const second = applyBridge(view, { tool: "object_place", objectId: "obj_2", objectName: "cube", ok: true, placement }, "obj_1");
check("a second object with the same name is not applied", !second.place);

const settings = applyBridge(view, {
  tool: "settings_apply",
  ok: true,
  settings: { layerHeight: 0.28, supports: true, blendKind: "weight", toughness: 0.5 },
});
check("a settings mirror copies the result and marks it stale", settings.layerHeight === 0.28 && settings.supports === true && settings.blendKind === "weight" && settings.stale === true && !settings.place);

let stale = 0;
let redraws = 0;
let height = 0.2;
runBridgePatch(settings, {
  assign: (patch) => {
    if (typeof patch.layerHeight === "number") height = patch.layerHeight;
  },
  place: () => {},
  markStale: () => {
    stale += 1;
  },
  renderChrome: () => {
    redraws += 1;
  },
});
check("settings update the field and mark the slice stale", height === 0.28 && stale === 1 && redraws === 1);

let queued: BridgeMessage[] = [];
const duringDrag: BridgeMessage = { tool: "object_place", objectId: "obj_1", objectName: "cube", ok: true, placement };
for (let i = 0; i < 20; i += 1) queued = parkBridge(queued, duringDrag);
let heldAll = true;
for (let i = 0; i < 20; i += 1) {
  const held = releaseBridge(queued, "dragging");
  heldAll = heldAll && held.ready.length === 0 && held.waiting.length === 20;
  queued = held.waiting;
}
check("a mirror during a drag stays queued", heldAll);
const after = releaseBridge(queued, "");
check("the queued mirrors apply after the drag", after.ready.length === 20 && after.waiting.length === 0);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("bridge: mirror waits for a gesture and applies a place");
