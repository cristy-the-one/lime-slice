import { resolved } from "./strategy.ts";
import type { PrinterSpeeds } from "./profiles.ts";
import { IR3_V2_SPEEDS } from "./ui/machine-library.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

// No printer speeds: the panel shows the blend's own numbers.
const plain = resolved(0.5);
check("the default blend without printer speeds is unchanged", near(plain.outer, 85) && near(plain.inner, 104) && near(plain.sparse, 137.5) && near(plain.top, 78) && near(plain.travel, 220), JSON.stringify(plain));
check("an empty speeds block changes nothing", JSON.stringify(resolved(0.5, 0.2, 0.45, 12, {})) === JSON.stringify(plain));

// A printer with its own feeds: the default blend shows exactly its numbers, as the engine prints them.
const TABLE: PrinterSpeeds = { outerWall: 96, innerWall: 160, sparseInfill: 160, topSurface: 160, travel: 200 };
const mid = resolved(0.5, 0.2, 0.45, 1000, TABLE);
check("the default blend shows the printer's numbers", near(mid.outer, 96) && near(mid.inner, 160) && near(mid.sparse, 160) && near(mid.top, 160) && near(mid.travel, 200), JSON.stringify(mid));

// The slider's ends keep their ratio to the default blend.
const fast = resolved(0, 0.2, 0.45, 1000, TABLE);
const tough = resolved(1, 0.2, 0.45, 1000, TABLE);
check("Speed keeps its ratio", near(fast.outer, (130 * 96) / 85) && fast.outer > mid.outer, String(fast.outer));
check("Toughness keeps its ratio", near(tough.outer, (40 * 96) / 85) && tough.outer < mid.outer, String(tough.outer));

// The flow cap still applies: 12 mm³/s holds a 0.2 mm layer under about 133 mm/s.
const capped = resolved(0.5, 0.2, 0.45, 12, TABLE);
check("effective feeds keep the flow cap", near(capped.inner, 160) && capped.effectiveInner < 134 && capped.effectiveInner > 133, String(capped.effectiveInner));

// The IR3 V2 sets accelerations only, so its panel shows the blend's own feeds.
check("the IR3 V2's card shows the blend's own feeds", JSON.stringify(resolved(0.5, 0.2, 0.45, 12, IR3_V2_SPEEDS)) === JSON.stringify(resolved(0.5)));

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("strategy speeds: the panel's card follows the printer's own speeds");
