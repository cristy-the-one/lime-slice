/**
 * Organic fix round, item 6: one rule decides an open sheet. A surfaces-only STEP at its root is an import, as on
 * v7.1.2 (no banner, commits); a sheet a step or a feature root built is gated.
 */
import { isOpenSheet } from "./model-sheet.ts";
import { ROOT } from "./model-tree.ts";

let failed = 0;
function check(name: string, ok: boolean) {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}`);
}

const surfaces = { editable: false, faces: [{}, {}], nakedEdges: [0, 3] };
const solid = { editable: true, faces: [{}, {}], nakedEdges: [] };
const closedShell = { editable: false, faces: [{}, {}] };
const step = { kind: "step" as const };
const feature = { kind: "feature" as const };
const primitive = { kind: "primitive" as const };

check("a surfaces-only STEP at its root is not a sheet (commits as on v7.1.2)", !isOpenSheet(surfaces, step, ROOT));
check("a step that leaves an open sheet on a STEP part is a sheet", isOpenSheet(surfaces, step, 2));
check("a step that leaves an open sheet on a primitive is a sheet", isOpenSheet(surfaces, primitive, 1));
check("a sheet feature as a new object's root is a sheet", isOpenSheet(surfaces, feature, ROOT));
check("a closed solid is never a sheet", !isOpenSheet(solid, feature, 3));
check("a non-solid with no open border is not a sheet (the viewport reads naked edges the same way)", !isOpenSheet(closedShell, feature, 3));
check("nothing on screen is not a sheet", !isOpenSheet(null, feature, ROOT));

if (failed) {
  console.error(`${failed} checks failed`);
  process.exit(1);
}
console.log("open sheet rule: ok");
