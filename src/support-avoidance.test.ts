import { avoidanceSliceField, gentleSliceFields, paintJoinSliceField, slowFragileSliceField, strictStackingSliceField } from "./support-avoidance.ts";
import { recipeKey } from "./slice-action.ts";
import { shallowSkinsSliceField, solidUnderWallsSliceField } from "./slice-request.ts";

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
check("slow fragile supports off is omitted", Object.keys(slowFragileSliceField(false)).length === 0);
check("slow fragile supports on is sent", slowFragileSliceField(true).supportSlowFragile === true);
check("omitted slow fragile supports leaves the recipe key", recipeKey({ ...base, ...slowFragileSliceField(false) }, "mesh") === recipeKey(base, "mesh"));
check("asking for slow fragile supports changes the recipe", recipeKey({ ...base, ...slowFragileSliceField(true) }, "mesh") !== recipeKey(base, "mesh"));
check("gentle speed and accel at Auto are omitted", Object.keys(gentleSliceFields(true, null, null)).length === 0);
check("gentle speed and accel are omitted while gentle printing is off", Object.keys(gentleSliceFields(false, 25, 1200)).length === 0);
check("a set gentle speed and accel are sent", JSON.stringify(gentleSliceFields(true, 25, 1200)) === '{"supportGentleSpeedMmS":25,"supportGentleAccelMmS2":1200}');
check("gentle values are held to what the engine takes", JSON.stringify(gentleSliceFields(true, 1, 90000)) === '{"supportGentleSpeedMmS":5,"supportGentleAccelMmS2":20000}');
check("filling between paint dabs is sent when something is painted", paintJoinSliceField(true, true).supportPaintJoin === true);
check("filling between paint dabs is omitted with nothing painted", Object.keys(paintJoinSliceField(true, false)).length === 0);
check("filling between paint dabs off is omitted", Object.keys(paintJoinSliceField(false, true)).length === 0);
check("an unpainted slice keeps its recipe key", recipeKey({ ...base, ...paintJoinSliceField(true, false) }, "mesh") === recipeKey(base, "mesh"));
check("filling between painted dabs changes the recipe", recipeKey({ ...base, ...paintJoinSliceField(true, true) }, "mesh") !== recipeKey(base, "mesh"));
check("shallow skins off is omitted", Object.keys(shallowSkinsSliceField(false)).length === 0);
check("shallow skins on is sent", shallowSkinsSliceField(true).shallowSkins === true);
check("omitted shallow skins leaves the recipe key", recipeKey({ ...base, ...shallowSkinsSliceField(false) }, "mesh") === recipeKey(base, "mesh"));
check("asking for shallow skins changes the recipe", recipeKey({ ...base, ...shallowSkinsSliceField(true) }, "mesh") !== recipeKey(base, "mesh"));
check("solid under walls off is omitted", Object.keys(solidUnderWallsSliceField(false)).length === 0);
check("solid under walls on is sent", solidUnderWallsSliceField(true).solidUnderWalls === true);
check("omitted solid under walls leaves the recipe key", recipeKey({ ...base, ...solidUnderWallsSliceField(false) }, "mesh") === recipeKey(base, "mesh"));
check("asking for solid under walls changes the recipe", recipeKey({ ...base, ...solidUnderWallsSliceField(true) }, "mesh") !== recipeKey(base, "mesh"));

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("support avoidance ok");
