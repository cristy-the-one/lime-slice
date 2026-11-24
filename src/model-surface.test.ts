/**
 * Patch defaults: an edge that touches a face starts at G1, and the badge cycles G0 and G1 (G2 patch sides are not
 * built in this version).
 */
import { defaultBoundaryContinuity, nextContinuity } from "./model-surface.ts";

let failed = 0;
function check(name: string, ok: boolean) {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}`);
}

check("an edge on a face defaults to G1", defaultBoundaryContinuity(true) === "g1");
check("a free curve defaults to G0", defaultBoundaryContinuity(false) === "g0");
check("the badge cycles G0 and G1, never offering G2", nextContinuity("g0") === "g1" && nextContinuity("g1") === "g0");
check("a G2 the badge did not set moves on to G0", nextContinuity("g2") === "g0");

if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("ok");
