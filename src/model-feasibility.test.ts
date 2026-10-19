import { readFileSync } from "node:fs";
import { isProbed, probeAllowsApply, probeFromBody, probeKey, probeNote, toolAvailable, toolBlockedTip, PROBE_WAIT_MS } from "./model-feasibility.ts";

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

eq("a disabled fillet says how to enable it", toolBlockedTip("fillet", [], true), "Pick an edge to fillet. Switch to Edge, then click the edges.");
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
eq(
  "a group's failed step is kept",
  probeFromBody({ ok: false, error: "Step 2 of 3: A box needs a positive length on each side", failedStep: 2 }),
  { phase: "done", ok: false, error: "Step 2 of 3: A box needs a positive length on each side", failedStep: 2 },
);
eq(
  "a group's missed steps are kept",
  probeFromBody({ ok: true, volumeMm3: 800, solids: 1, shells: 1, before: { volumeMm3: 1000, solids: 1, shells: 1 }, skipped: 1 }),
  { phase: "done", ok: true, measure: { volumeMm3: 800, solids: 1, shells: 1, before: { volumeMm3: 1000, solids: 1, shells: 1 } }, skipped: 1 },
);
// --- D20. The note says how many steps of a group missed the part.
eq(
  "a pattern whose copies partly miss says how many",
  probeNote("pattern", probeFromBody({ ok: true, volumeMm3: 800, solids: 1, shells: 1, before: { volumeMm3: 1000, solids: 1, shells: 1 }, skipped: 2 }, 6)),
  { text: "This pattern changes the solid. 2 of 6 steps miss the part and are left out.", bad: false },
);
eq(
  "a group that misses nowhere says only that it fits",
  probeNote("pattern", probeFromBody({ ok: true, skipped: 0 }, 6)),
  { text: "This pattern changes the solid.", bad: false },
);
eq(
  "the engine's refusal of a group that misses everywhere is the note",
  probeNote("pattern", probeFromBody({ ok: false, error: "None of its 6 steps changes the part." }, 6)),
  { text: "None of its 6 steps changes the part.", bad: true },
);
eq(
  "a failed probe keeps the void it named",
  probeFromBody({ ok: false, error: "This would seal off a hollow inside the part.", voids: [{ min: [2, 2, 2], max: [8, 8, 6] }] }),
  { phase: "done", ok: false, error: "This would seal off a hollow inside the part.", located: [{ min: [2, 2, 2], max: [8, 8, 6] }] },
);

eq("checking copy", probeNote("fillet", { phase: "checking" }), { text: "Checking this fillet…", bad: false });
eq("a group is one check", probeNote("group", { phase: "checking" }), { text: "Checking these steps…", bad: false });
eq("a group that fits", probeNote("group", { phase: "done", ok: true }), { text: "These steps change the solid.", bad: false });
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
eq(
  "a kernel class name is rewritten",
  probeNote("fillet", { phase: "done", ok: false, error: "StdFail_NotDone" }),
  {
    text: "Could not complete this fillet operation on the selected geometry. Try a smaller dimension or a different face or edge.",
    bad: true,
  },
);
eq(
  "a smooth edge stays a plain sentence",
  probeNote("fillet", { phase: "done", ok: false, error: "This edge is already smooth and cannot be filleted." }),
  { text: "This edge is already smooth and cannot be filleted.", bad: true },
);
eq(
  "a seam edge stays a plain sentence",
  probeNote("chamfer", { phase: "done", ok: false, error: "This seam edge cannot be chamfered." }),
  { text: "This seam edge cannot be chamfered.", bad: true },
);

check("apply waits while the check is in flight", probeAllowsApply("fillet", { phase: "checking" }) === false);
check("apply waits when the fillet does not fit", probeAllowsApply("fillet", { phase: "done", ok: false }) === false);
check("apply runs when the fillet fits", probeAllowsApply("fillet", { phase: "done", ok: true }));
check("apply waits for the hole check", probeAllowsApply("hole", null) === false);
check("apply waits when the boolean would fail", probeAllowsApply("boolean", { phase: "done", ok: false }) === false);
check("split is not gated by a kernel dry-run", probeAllowsApply("split", null));
check("numbers just applied cannot be applied again", !probeAllowsApply("hole", { phase: "applied" }));
eq("numbers just applied say nothing about fit", probeNote("boolean", { phase: "applied" }), null);

const hole = { kind: "hole", origin: [5, 5, 10], axis: [0, 0, -1], radius: 2, depth: 12 };
const key = probeKey("part#a.1#2", hole);
check("the same node and numbers share an answer", probeKey("part#a.1#2", { ...hole }) === key);
check("another node of the tree asks again", probeKey("part#a.1#3", hole) !== key);
check("another tree asks again", probeKey("part#a.2#2", hole) !== key);
check("another number asks again", probeKey("part#a.1#2", { ...hole, radius: 2.0000001 }) !== key);

const desktop = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const commands = [...desktop.matchAll(/#\[tauri::command(\(async\))?\]\s*(?:async\s+)?fn (model_\w+)/g)];
check("the desktop shell has the Model tree command", commands.some((match) => match[2] === "model_tree"));
for (const match of commands) check(`${match[2]} runs off the UI thread`, match[1] === "(async)");

if (failed) {
  console.error(`model-feasibility: ${failed} failed`);
  throw new Error(`model-feasibility: ${failed} failed`);
}
console.log("model-feasibility: tool gates, dry-run status, and off-thread commands ok");
