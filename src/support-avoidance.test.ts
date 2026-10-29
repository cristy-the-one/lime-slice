import { avoidanceSliceField, strictStackingSliceField } from "./support-avoidance.ts";
import { recipeKey } from "./slice-action.ts";
import { shallowSkinsSliceField } from "./slice-request.ts";

let failed = 0;

function check(name: string, cond: boolean): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}`);
}

check("off is omitted", Object.keys(avoidanceSliceField(false)).length === 0);
check("on is sent", avoidanceSliceField(true).supportAvoidance === true);

const base = { layerHeight: 0.2, blend: { mode: "single", strategy: "speed" }, supports: true, supportStyle: "tree" };
check("omitted avoidance leaves the recipe key", recipeKey({ ...base, ...avoidanceSliceField(false) }, "mesh") === recipeKey(base, "mesh"));
check("asking for avoidance changes the recipe", recipeKey({ ...base, ...avoidanceSliceField(true) }, "mesh") !== recipeKey(base, "mesh"));
check("strict stacking off is omitted", Object.keys(strictStackingSliceField(false)).length === 0);
check("strict stacking on is sent", strictStackingSliceField(true).supportStrictStacking === true);
check("omitted strict stacking leaves the recipe key", recipeKey({ ...base, ...strictStackingSliceField(false) }, "mesh") === recipeKey(base, "mesh"));
check("asking for strict stacking changes the recipe", recipeKey({ ...base, ...strictStackingSliceField(true) }, "mesh") !== recipeKey(base, "mesh"));
check("shallow skins off is omitted", Object.keys(shallowSkinsSliceField(false)).length === 0);
check("shallow skins on is sent", shallowSkinsSliceField(true).shallowSkins === true);
check("omitted shallow skins leaves the recipe key", recipeKey({ ...base, ...shallowSkinsSliceField(false) }, "mesh") === recipeKey(base, "mesh"));
check("asking for shallow skins changes the recipe", recipeKey({ ...base, ...shallowSkinsSliceField(true) }, "mesh") !== recipeKey(base, "mesh"));

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("support avoidance ok");
