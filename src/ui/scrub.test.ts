import { SCRUB_PX_PER_STEP, SCRUB_SLOP_PX, scrubIntent, scrubTarget, scrubTravel } from "./scrub.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

function eq(name: string, actual: number, expected: number): void {
  check(name, actual === expected, `got ${actual}, expected ${expected}`);
}

check("two pixels is not a scrub", scrubIntent(2, 0) === "pending");
check("two pixels the other way is not a scrub", scrubIntent(0, -2) === "pending");
check("a vertical drag is the sheet", scrubIntent(1, 12) === "scroll");
check("a horizontal drag is a scrub", scrubIntent(12, 1) === "scrub");
check("the slop itself is still pending", scrubIntent(SCRUB_SLOP_PX - 0.01, 0) === "pending");

eq("inside the slop adds nothing", scrubTarget(2, false, 0.1, 1), 0);
eq("one step is a tenth", scrubTarget(scrubTravel(1), false, 0.1, 1), 0.1);
eq("fourteen steps are 1.4 mm", scrubTarget(scrubTravel(14), false, 0.1, 1), 1.4);
eq("left is negative", scrubTarget(scrubTravel(-14), false, 0.1, 1), -1.4);
eq("shift uses the millimetre quantum", scrubTarget(scrubTravel(2), true, 0.1, 1), 2);
eq("shift of one step is 1 mm", scrubTarget(scrubTravel(1), true, 0.1, 1), 1);
eq("scale steps are one percent", scrubTarget(scrubTravel(10), false, 1, 5), 10);
eq("shift scale steps are five percent", scrubTarget(scrubTravel(2), true, 1, 5), 10);
eq("a partial pixel step adds nothing", scrubTarget(SCRUB_SLOP_PX + SCRUB_PX_PER_STEP - 1, false, 0.1, 1), 0);
eq("travel of fourteen steps round-trips", scrubTarget(scrubTravel(14), false, 0.1, 1), 1.4);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("scrub: slop, tenths, and shift ok");
