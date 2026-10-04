import { seamSliceField } from "./seam.ts";
import {
  IRONING_FLOW,
  IRONING_SPACING,
  IRONING_SPEED,
  ironingFlowPercent,
  ironingRequest,
  readIroningFlowPercent,
  ironingSpacingMax,
  readIroningSpacing,
  readIroningSpeed,
  sliceIroningFields,
  type IroningChoice,
} from "./ironing.ts";

let failed = 0;

function eq<T>(name: string, actual: T, expected: T): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (same) return;
  failed += 1;
  console.error(`FAIL ${name}: got ${JSON.stringify(actual)}`);
}

function check(name: string, cond: boolean): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}`);
}

const off: IroningChoice = { on: false, flow: IRONING_FLOW, speed: IRONING_SPEED, spacing: IRONING_SPACING };
const defaults: IroningChoice = { on: true, flow: IRONING_FLOW, speed: IRONING_SPEED, spacing: IRONING_SPACING };
const tuned: IroningChoice = { on: true, flow: 0.15, speed: 30, spacing: 0.2 };

eq("blend is left out of the slice body", seamSliceField("blend"), {});
eq("nearest is sent", seamSliceField("nearest"), { seam: "nearest" });
eq("aligned is sent", seamSliceField("aligned"), { seam: "aligned" });
eq("rear is sent", seamSliceField("rear"), { seam: "rear" });

const plain = { layerHeight: 0.2, ...seamSliceField("blend"), ...sliceIroningFields(off) };
check("a default slice has no seam and no ironing", !("seam" in plain) && !("ironing" in plain));

eq("ironing off is omitted from the request", ironingRequest(off), {});
eq("ironing on at the defaults is an empty object", ironingRequest(defaults), { ironing: {} });
eq("only a changed ironing key is kept", ironingRequest({ ...defaults, flow: 0.15 }), { ironing: { flow: 0.15 } });
eq("every changed ironing key is kept", ironingRequest(tuned), { ironing: { flow: 0.15, speed: 30, spacing: 0.2 } });
eq("the slice sends ironing at the defaults as an empty object", sliceIroningFields(defaults), { ironing: {} });
eq("the slice sends every changed ironing key", sliceIroningFields(tuned), { ironing: { flow: 0.15, speed: 30, spacing: 0.2 } });

const sliced = { layerHeight: 0.2, ...seamSliceField("rear"), ...sliceIroningFields(tuned) };
eq("rear and ironing are both on the body", sliced, { layerHeight: 0.2, seam: "rear", ironing: { flow: 0.15, speed: 30, spacing: 0.2 } });

eq("10% is the default flow", readIroningFlowPercent("10"), IRONING_FLOW);
eq("flow percent is clamped", readIroningFlowPercent("250"), 1);
eq("a blank flow falls back", readIroningFlowPercent(""), IRONING_FLOW);
eq("speed is clamped", readIroningSpeed("0"), 1);
eq("spacing is clamped", readIroningSpacing("2"), 1);
eq("spacing stays below a 0.45 mm line", readIroningSpacing("0.5", ironingSpacingMax(0.45)), 0.44);
eq("spacing max for a 0.45 mm line", ironingSpacingMax(0.45), 0.44);
eq("spacing max never passes 1 mm", ironingSpacingMax(1.2), 1);
check("the flow field shows 10", ironingFlowPercent(IRONING_FLOW) === 10);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("ironing: seam omit and ironing fields ok");
