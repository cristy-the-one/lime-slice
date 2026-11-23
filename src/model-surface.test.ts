/**
 * A patch edge is G0. Asking for G1 or G2 is refused, and the edge stays G0.
 */
import { PATCH_NOT_YET, clearPatchLater, defaultBoundaryContinuity, notePatchLater, patchLaterNote } from "./model-surface.ts";

let failed = 0;
function check(name: string, ok: boolean) {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}`);
}

check("an edge on a face is G0", defaultBoundaryContinuity(true) === "g0");
check("a free curve is G0", defaultBoundaryContinuity(false) === "g0");
clearPatchLater();
check("nothing is refused until a later continuity is asked", patchLaterNote() === null);
notePatchLater();
check("G1 or G2 is refused in one sentence", patchLaterNote() === PATCH_NOT_YET);
clearPatchLater();
check("the refusal clears", patchLaterNote() === null);

if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("ok");
