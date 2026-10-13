import { meshRepairOf, meshWarningKey, meshWarningText } from "./mesh-warning.ts";
import type { SliceResponse } from "./state.ts";

let failed = 0;

function eq(name: string, actual: unknown, expected: unknown): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left === right) return;
  failed += 1;
  console.error(`FAIL ${name}: got ${left}`);
}

function reply(extra: { warnings?: SliceResponse["warnings"]; mesh?: Partial<SliceResponse["mesh"]> }): SliceResponse {
  return {
    coreMs: 1,
    baselineMs: 0,
    blend: "single speed",
    gcode: "G1",
    layers: [],
    sanity: { ok: true, notes: [], layers: 1, finalE: 1, extrusionLengthMm: 1 },
    warnings: extra.warnings,
    mesh: { triangles: 12, min: [0, 0, 0], max: [1, 1, 1], ...extra.mesh },
  };
}

eq("a clean reply has no pill", meshRepairOf(reply({})), null);
eq("zeros stay quiet", meshRepairOf(reply({ mesh: { repairedLayers: 0, droppedChains: 0 } })), null);
eq("an older reply uses the mesh counts", meshRepairOf(reply({ mesh: { repairedLayers: 4, droppedChains: 2 } })), {
  repairedLayers: 4,
  bridgedMm: 0,
  droppedChains: 2,
});

const warned = meshRepairOf(reply({
  warnings: [{ code: "mesh-repair", repairedLayers: 14, bridgedMm: 12.34, droppedChains: 6 }],
  mesh: { repairedLayers: 1, droppedChains: 1 },
}));
eq("the warning wins over the mesh counts", warned, { repairedLayers: 14, bridgedMm: 12.34, droppedChains: 6 });
eq("the sentence names the gaps, the bridge, and the skipped segments", meshWarningText(warned!), "The mesh has gaps on 14 layers. The slicer closed 12.3 mm of those gaps. 6 open contour segments were skipped, so that outline is missing.");
eq("one layer and one segment stay singular", meshWarningText({ repairedLayers: 1, bridgedMm: 0, droppedChains: 1 }), "The mesh has gaps on 1 layer. 1 open contour segment was skipped, so that outline is missing.");
eq("the sentence does not name a repair command", meshWarningText(warned!).includes("Repair"), false);
eq("the same counts keep one key", meshWarningKey(warned!), meshWarningKey({ repairedLayers: 14, bridgedMm: 12.34, droppedChains: 6 }));
eq("a different count is a new key", meshWarningKey(warned!) === meshWarningKey({ repairedLayers: 15, bridgedMm: 12.34, droppedChains: 6 }), false);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("mesh-warning: pill copy follows the repair counts");
