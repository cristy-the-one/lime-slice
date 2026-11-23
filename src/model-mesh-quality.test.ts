/**
 * Organic fix round, item 16: only the Model view's display may ask for the fine kernel mesh, and until the kernel's
 * wire field is named nothing is sent at all.
 */
import { DISPLAY_MESH_FIELD, displayMeshIsPlateMesh, meshQualityFor, withMeshQuality } from "./model-mesh-quality.ts";

let failed = 0;
function check(name: string, ok: boolean) {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}`);
}

const goto = { call: "goto", key: "a#1", node: 2, chordMm: 0.05 };
check("no wire field is named yet, so nothing new is sent", DISPLAY_MESH_FIELD === null);
for (const purpose of ["display", "plate", "export", "slice"] as const) {
  check(`today ${purpose} adds no field`, Object.keys(meshQualityFor(purpose)).length === 0 && withMeshQuality(goto, purpose) === goto);
}
check("today the shown mesh is the plate mesh, so commit keeps using it", displayMeshIsPlateMesh());

// Once wired (a stand-in name here): display alone asks, the others never do.
const wired = ["fineMesh", true] as const;
check("wired: display asks for the fine mesh", JSON.stringify(withMeshQuality(goto, "display", wired)) === JSON.stringify({ ...goto, fineMesh: true }));
for (const purpose of ["plate", "export", "slice"] as const) check(`wired: ${purpose} keeps the default mesh`, withMeshQuality(goto, purpose, wired) === goto);
check("wired: a call with no mesh is left alone", !("fineMesh" in withMeshQuality({ call: "close", key: "a#1" }, "display", wired)));
check("wired: the commit must ask for a default mesh instead of using the shown one", !displayMeshIsPlateMesh(wired));

if (failed) {
  console.error(`${failed} checks failed`);
  process.exit(1);
}
console.log("mesh quality: ok");
