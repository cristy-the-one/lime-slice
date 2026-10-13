import { blendNote, probeAllowsApply, probeFromBody, toolAvailable, PROBE_WAIT_MS } from "./model-feasibility.ts";

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const left = JSON.stringify(got);
  const right = JSON.stringify(want);
  if (left === right) return;
  failed += 1;
  console.error(`FAIL ${name}\n  got  ${left}\n  want ${right}`);
}
function check(name: string, ok: boolean) {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}`);
}

const face = (index: number) => ({ kind: "face" as const, index });
const edge = (index: number) => ({ kind: "edge" as const, index });

check("fillet waits for an edge", toolAvailable("fillet", [face(1)], true) === false);
check("chamfer uses the last edge", toolAvailable("chamfer", [face(1), edge(2)], true));
check("a hole does not need a pick", toolAvailable("hole", [], true));
check("boolean stays available", toolAvailable("boolean", [], false));
check("scale stays available", toolAvailable("scale", [], true));
check("split waits on a sheet that is too thin", toolAvailable("split", [], false) === false);
check("split is available inside a thick solid", toolAvailable("split", [], true));
check("the dry-run waits out a keystroke", PROBE_WAIT_MS >= 200);

eq("a fitting fillet", probeFromBody({ ok: true }), { phase: "done", ok: true });
eq(
  "a fillet that does not fit names a maximum",
  probeFromBody({ ok: false, error: "The fillet did not fit this edge", maxMm: 2.5 }),
  { phase: "done", ok: false, error: "The fillet did not fit this edge", maxMm: 2.5 },
);
eq(
  "a missing kernel is a failure",
  probeFromBody({ error: "OCCT_ROOT is not set" }),
  { phase: "done", ok: false, error: "OCCT_ROOT is not set" },
);

eq("checking copy", blendNote("fillet", { phase: "checking" }), { text: "Checking this fillet…", bad: false });
eq("a fit", blendNote("chamfer", { phase: "done", ok: true }), { text: "This chamfer fits.", bad: false });
eq(
  "why not, and the largest size",
  blendNote("fillet", { phase: "done", ok: false, error: "The fillet did not fit this edge", maxMm: 2.5 }),
  { text: "The fillet did not fit this edge. The largest that fits is 2.5 mm.", bad: true },
);

check("apply waits while the check is in flight", probeAllowsApply("fillet", { phase: "checking" }) === false);
check("apply waits when the fillet does not fit", probeAllowsApply("fillet", { phase: "done", ok: false }) === false);
check("apply runs when the fillet fits", probeAllowsApply("fillet", { phase: "done", ok: true }));
check("a hole is not gated by the blend check", probeAllowsApply("hole", null));

if (failed) {
  console.error(`model-feasibility: ${failed} failed`);
  throw new Error(`model-feasibility: ${failed} failed`);
}
console.log("model-feasibility: tool gates and blend status ok");
