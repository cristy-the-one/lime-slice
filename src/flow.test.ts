import { coerceFlow, flowSliceField } from "./flow.ts";
import { recipeKey } from "./slice-action.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

check("flow 1 is omitted", Object.keys(flowSliceField(1)).length === 0);
check("a hair off 1 is still omitted", Object.keys(flowSliceField(1.0000001)).length === 0);
check("1.05 is sent", flowSliceField(1.05).flow === 1.05);
check("a wild value is clamped before it is sent", flowSliceField(4).flow === 1.5);
check("a missing value is 1", coerceFlow(undefined) === 1);
check("NaN is 1", coerceFlow(Number.NaN) === 1);

const base = { layerHeight: 0.2, blend: { mode: "single", strategy: "speed" } };
check("omitted flow leaves the recipe key", recipeKey({ ...base, ...flowSliceField(1) }, "mesh") === recipeKey(base, "mesh"));
check("a real multiplier changes the recipe", recipeKey({ ...base, ...flowSliceField(1.05) }, "mesh") !== recipeKey(base, "mesh"));

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("flow ok");
