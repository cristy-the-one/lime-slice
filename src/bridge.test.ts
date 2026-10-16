import { applyBridge, emptyBridgeView } from "./bridge.ts";

let failed = 0;
function check(name: string, ok: boolean) {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}`);
}

const view = emptyBridgeView("cube");
const waiting = applyBridge({ ...view, poseHud: "Scale 120%" }, { tool: "object_place", objectName: "cube", ok: true, args: { scalePercent: 50 } });
check("a gesture in progress waits", waiting.wait && !waiting.place);

const placed = applyBridge(view, { tool: "object_place", objectName: "cube", ok: true, args: { scalePercent: 50, turn: { axis: "z", degrees: 90 } } });
check("a matching place updates the bed", placed.place && placed.partScale === 0.5 && placed.orient?.[1] !== 0);

const other = applyBridge(view, { tool: "object_place", objectName: "other", ok: true, args: { scalePercent: 50 } });
check("a different object is left alone", !other.place && other.partScale === undefined);

const named = applyBridge({ ...view, meshName: "cube.stl" }, { tool: "object_place", objectName: "cube.stl", ok: true, args: { scalePercent: 80 } });
check("a file name matches with its extension", named.place && named.partScale === 0.8);

const settings = applyBridge(view, { tool: "settings_apply", ok: true, args: { preset: "efficiency", supports: true } });
check("a settings mirror sets the card", settings.blendKind === "weight" && settings.toughness === 0.5 && settings.supports === true && !settings.place);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("bridge: mirror waits for a gesture and applies a place");
