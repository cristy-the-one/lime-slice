import { DEFAULT_PRESET, readPresetSettings } from "./presets.ts";
import { recipeKey } from "./slice-action.ts";
import { supportModeOf, supportModeState, supportSourceSliceField } from "./support-source.ts";

let failed = 0;

function check(name: string, cond: boolean): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}`);
}

check("supports off reads Off", supportModeOf({ supports: false, supportSource: "auto" }) === "off");
check("supports on reads Automatic", supportModeOf({ supports: true, supportSource: "auto" }) === "auto");
check("supports on from paint reads Painted only", supportModeOf({ supports: true, supportSource: "paint" }) === "paint");
check("a stale source under Off still reads Off", supportModeOf({ supports: false, supportSource: "paint" }) === "off");
check("a source the app does not know reads Automatic", supportModeOf({ supports: true, supportSource: "everywhere" }) === "auto");

check("Off turns supports off and forgets the source", JSON.stringify(supportModeState("off")) === JSON.stringify({ supports: false, supportSource: "auto" }));
check("Automatic turns supports on", JSON.stringify(supportModeState("auto")) === JSON.stringify({ supports: true, supportSource: "auto" }));
check("Painted only turns supports on from paint", JSON.stringify(supportModeState("paint")) === JSON.stringify({ supports: true, supportSource: "paint" }));

check("Painted only is sent", supportSourceSliceField(true, "paint").supportSource === "paint");
check("Automatic sends nothing", Object.keys(supportSourceSliceField(true, "auto")).length === 0);
check("Off sends nothing even from a stale paint source", Object.keys(supportSourceSliceField(false, "paint")).length === 0);

const base = { layerHeight: 0.2, blend: { mode: "single", strategy: "speed" }, supports: true, supportStyle: "tree" };
check("Automatic leaves the recipe key", recipeKey({ ...base, ...supportSourceSliceField(true, "auto") }, "mesh") === recipeKey(base, "mesh"));
check("Painted only changes the recipe", recipeKey({ ...base, ...supportSourceSliceField(true, "paint") }, "mesh") !== recipeKey(base, "mesh"));

check("the factory source is Automatic", DEFAULT_PRESET.supportSource === "auto");
const { supportSource: _later, ...old } = { ...DEFAULT_PRESET, supports: true };
check("a profile from before the key reads Automatic", readPresetSettings(old)?.supportSource === "auto" && readPresetSettings(old)?.supports === true);
check("a profile that stores Painted only keeps it", readPresetSettings({ ...old, supportSource: "paint" })?.supportSource === "paint");
check("a source that is not a string is refused", readPresetSettings({ ...old, supportSource: 3 }) === null);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("support source ok");
