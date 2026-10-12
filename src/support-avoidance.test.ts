import { avoidanceSliceField } from "./support-avoidance.ts";
import { recipeKey } from "./slice-action.ts";

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

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("support avoidance ok");
