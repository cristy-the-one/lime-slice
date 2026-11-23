/**
 * Organic fix round, item 12: every op that names faces or edges by the solid's own numbering waits for the rebuilt
 * step (NAMES_TOPOLOGY), Replace face and Split face included: on a STEP-read seed solid the indices can differ.
 */
import { register } from "node:module";

register(new URL("../../model-view/resolve-ts.mjs", import.meta.url).href, import.meta.url);
const { NAMES_TOPOLOGY } = await import("./shared.ts");

let failed = 0;
for (const kind of ["fillet", "chamfer", "shell", "faceExtrude", "moveFaces", "draft", "transition", "patch", "blendSurface", "replaceFace", "splitFace"]) {
  if (NAMES_TOPOLOGY.has(kind)) continue;
  failed += 1;
  console.error(`FAIL ${kind} names faces or edges by index but builds on a seed solid`);
}
// A step that names nothing by index still builds on the seed at once.
for (const kind of ["boolean", "hole", "extrude", "sheet", "thicken", "sew", "trimSplit"]) {
  if (!NAMES_TOPOLOGY.has(kind)) continue;
  failed += 1;
  console.error(`FAIL ${kind} names nothing by index but waits for a rebuild`);
}
if (failed) process.exit(1);
console.log("names topology: ok");
