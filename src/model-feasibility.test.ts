import { readFileSync } from "node:fs";
import { isProbed, probeAllowsApply, probeFromBody, probeNote, toolAvailable, toolBlockedTip, PROBE_WAIT_MS } from "./model-feasibility.ts";

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

eq("a disabled fillet says how to enable it", toolBlockedTip("fillet", [], true), "Pick an edge to fillet. Switch to Edge, then click one.");
eq("a disabled split says why", toolBlockedTip("split", [], false), "This solid is too thin to split.");
eq("an enabled tool has no reason", toolBlockedTip("hole", [], true), "");

for (const tool of ["fillet", "chamfer", "hole", "boolean"]) check(`${tool} is checked by the kernel before Apply`, isProbed(tool));
check("split is checked from its range", !isProbed("split"));
check("scale is checked from its factor", !isProbed("scale"));

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

eq("checking copy", probeNote("fillet", { phase: "checking" }), { text: "Checking this fillet…", bad: false });
eq("a fit", probeNote("chamfer", { phase: "done", ok: true }), { text: "This chamfer fits.", bad: false });
eq(
  "why not, and the largest size",
  probeNote("fillet", { phase: "done", ok: false, error: "The fillet did not fit this edge", maxMm: 2.5 }),
  { text: "The fillet did not fit this edge. The largest that fits is 2.5 mm.", bad: true },
);
eq(
  "a hole that misses",
  probeNote("hole", { phase: "done", ok: false, error: "The hole missed this solid" }),
  { text: "The hole missed this solid.", bad: true },
);
eq(
  "a common with no overlap",
  probeNote("boolean", { phase: "done", ok: false, error: "The solids do not overlap" }),
  { text: "The solids do not overlap.", bad: true },
);

check("apply waits while the check is in flight", probeAllowsApply("fillet", { phase: "checking" }) === false);
check("apply waits when the fillet does not fit", probeAllowsApply("fillet", { phase: "done", ok: false }) === false);
check("apply runs when the fillet fits", probeAllowsApply("fillet", { phase: "done", ok: true }));
check("apply waits for the hole check", probeAllowsApply("hole", null) === false);
check("apply waits when the boolean would fail", probeAllowsApply("boolean", { phase: "done", ok: false }) === false);
check("split is not gated by a kernel dry-run", probeAllowsApply("split", null));

const desktop = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const commands = [...desktop.matchAll(/#\[tauri::command(\(async\))?\]\s*(?:async\s+)?fn (model_\w+)/g)];
check("the desktop shell has Model commands", commands.length >= 10);
for (const match of commands) check(`${match[2]} runs off the UI thread`, match[1] === "(async)");

if (failed) {
  console.error(`model-feasibility: ${failed} failed`);
  throw new Error(`model-feasibility: ${failed} failed`);
}
console.log("model-feasibility: tool gates, dry-run status, and off-thread commands ok");
