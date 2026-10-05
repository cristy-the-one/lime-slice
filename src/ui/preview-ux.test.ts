import { GIZMO_NUDGE_DEG, GIZMO_NUDGE_MM, wheelNotch } from "../gizmo-math.ts";
import { freshPreviewMode, gizmoNudge, topLayerIndex, viewportPending } from "./preview-ux.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

function eq<T>(name: string, actual: T, expected: T): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, same, same ? "" : `got ${JSON.stringify(actual)}`);
}

eq("fresh preview is perspective 3D", freshPreviewMode(null), "solid");
eq("a chosen 2D view stays", freshPreviewMode("flat"), "flat");
eq("a chosen split view stays", freshPreviewMode("split"), "split");

eq("no slice yet is pending", viewportPending(false, false), true);
eq("slicing is pending", viewportPending(true, true), true);
eq("a finished slice is sharp", viewportPending(false, true), false);

eq("top layer of 100", topLayerIndex(100), 99);
eq("top layer of one", topLayerIndex(1), 0);
eq("top layer of none", topLayerIndex(0), 0);

eq("move nudge is a tenth of a millimetre", gizmoNudge("move", 1), { kind: "move", amount: GIZMO_NUDGE_MM });
eq("all-tools nudge still moves", gizmoNudge("all", -1), { kind: "move", amount: -GIZMO_NUDGE_MM });
eq("rotate nudge is one degree", gizmoNudge("rotate", 1), { kind: "rotate", amount: GIZMO_NUDGE_DEG });
eq("zero sign does nothing", gizmoNudge("rotate", 0), { kind: "rotate", amount: 0 });
check("nudge is finer than the shift snap", GIZMO_NUDGE_MM < 1 && GIZMO_NUDGE_DEG < 15);

eq("small touchpad deltas wait", wheelNotch(20, 0, 0), { notches: 0, accum: 20 });
eq("accumulated pixels step once", wheelNotch(30, 0, 20), { notches: -1, accum: 0 });
eq("scroll up steps the other way", wheelNotch(-48, 0, 0), { notches: 1, accum: 0 });
eq("a wheel line is one step", wheelNotch(1, 1, 30), { notches: -1, accum: 0 });
eq("zero delta keeps the accumulator", wheelNotch(0, 0, 12), { notches: 0, accum: 12 });

if (failed > 0) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("preview ux ok");
