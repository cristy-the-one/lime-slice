/**
 * Moulding report on a synthetic shelled box, through ribs_plan against real Open CASCADE.
 * Process moulded carries plan.moulding, and each flag names a rib of that plan.
 * Process filament on the same box has no moulding key; the plan's other keys are the same set.
 * Skips without LIME_OCCT_BRIDGE; fails in CI when it is unset.
 * Kept in the folded-shell job: a box plan is too heavy for the shared Open CASCADE job.
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { engineCandidates, loadEngineWorker } from "./engine.ts";
import { Session } from "./session.ts";

const bridge = process.env.LIME_OCCT_BRIDGE ?? "";
const root = fileURLToPath(new URL("..", import.meta.url));
const addon = engineCandidates(root).find((path) => existsSync(path)) ?? "";
const ci = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
if (!bridge || !existsSync(bridge) || !addon) {
  if (ci) {
    console.error("moulding-occt: LIME_OCCT_BRIDGE and the MCP addon are required");
    process.exit(1);
  }
  console.log("moulding-occt: skipped (set LIME_OCCT_BRIDGE and build lime-mcp-engine)");
  process.exit(0);
}

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-moulding-"));
process.env.LIME_MCP_WORKSPACE = workspace;
process.env.LIME_MCP_MODEL_TIMEOUT_S = process.env.LIME_MCP_MODEL_TIMEOUT_S ?? "180";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`ok ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Reply = Record<string, any>;
const session = new Session(loadEngineWorker(root));
const call = async (name: string, args: unknown = {}) => (await session.call(name, args)) as Reply;

async function waitJob(job: string): Promise<Reply> {
  for (;;) {
    const reply = await call("slice_wait", { job, timeoutS: 2 });
    if (reply.status !== "running") return reply;
  }
}

const object = String((await call("solid_new", { primitive: "box", dx: 64, dy: 40, dz: 16 })).object);
const shelled = await call("model_apply", { object, probe: true, op: { kind: "shell", thickness: 2, openFaces: [{ normal: [0, 0, 1] }] } });
if (shelled.ok !== true) throw new Error(`shell: ${JSON.stringify(shelled).slice(0, 300)}`);

const wall = { face: { normal: [0, 0, 1], nearPoint: [0, 0, 2] } };
const goal = { budgetMm3: 2500 };
const t0 = Date.now();
const moulded = await waitJob(String((await call("ribs_plan", { object, wall, process: "moulded", goal, baselines: false })).job));
const mouldedS = (Date.now() - t0) / 1000;
const t1 = Date.now();
const filament = await waitJob(String((await call("ribs_plan", { object, wall, process: "filament", goal, baselines: false })).job));
const filamentS = (Date.now() - t1) / 1000;

check("moulded plan finishes", moulded.ok === true && Array.isArray(moulded.plan?.ribs), JSON.stringify(moulded).slice(0, 400));
check("filament plan finishes", filament.ok === true && Array.isArray(filament.plan?.ribs), JSON.stringify(filament).slice(0, 400));

const report = moulded.plan?.moulding as Reply | undefined;
const rules = (report?.rules ?? []) as Reply[];
const flags = (report?.flags ?? []) as Reply[];
const ribs = (moulded.plan?.ribs ?? []) as Reply[];
check(
  "moulded plan.moulding has the six rules, and the radius band is 0.25 to 0.5",
  rules.length === 6 && rules.every((row) => typeof row.rule === "string" && "pass" in row) && rules.filter((row) => row.rule !== "radius").every((row) => typeof row.threshold === "number") && JSON.stringify(rules.find((row) => row.rule === "radius")?.threshold) === JSON.stringify([0.25, 0.5]),
  JSON.stringify(rules),
);
check(
  "each flag names a real rib, with a number and a threshold",
  flags.every((flag) => Number.isInteger(flag.rib) && flag.rib >= 0 && flag.rib < ribs.length && typeof flag.rule === "string" && flag.at && typeof flag.value === "number" && typeof flag.threshold === "number"),
  JSON.stringify(flags).slice(0, 500),
);
check("filament plan has no moulding key", filament.plan && !("moulding" in filament.plan) && !JSON.stringify(filament).includes('"moulding"'));
const filamentKeys = Object.keys(filament.plan ?? {}).sort();
const mouldedKeys = Object.keys(moulded.plan ?? {}).filter((key) => key !== "moulding").sort();
check("aside from moulding, the plan keys match", JSON.stringify(filamentKeys) === JSON.stringify(mouldedKeys), JSON.stringify({ filamentKeys, mouldedKeys }));
console.log(`moulding-occt: moulded ${mouldedS.toFixed(1)} s, ${ribs.length} ribs, ${flags.length} flags, rules ${JSON.stringify(rules)}; filament ${filamentS.toFixed(1)} s, ${filament.plan?.ribs?.length ?? 0} ribs`);

if (failed) {
  console.error(`moulding-occt: ${failed} failed`);
  process.exit(1);
}
console.log("moulding-occt: ok");
// The engine worker keeps the process alive. The folded-shell step is 25 minutes, so exit as the other OCCT tests do.
process.exit(0);
