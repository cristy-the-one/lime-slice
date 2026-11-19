/**
 * Resin vent notches on a synthetic shelled box, through ribs_plan against real Open CASCADE.
 * The floor's ribs stand upward. buildAxis [0,0,-1] points that opening at the platform, so the
 * closed cells are vented and ribs_apply builds the notched ribNet. With no buildAxis the build is
 * the part as it sits (+Z, toward the tank), so nothing cups, and the note says the plate has no
 * resin printer. Filament and moulded on the same wall have no vents key.
 * Skips without LIME_OCCT_BRIDGE; fails in CI when it is unset.
 * Kept in the folded-shell job: a box plan is too heavy for the shared Open CASCADE job.
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ventPockets } from "../src/modeling/vents.ts";
import { engineCandidates, loadEngineWorker } from "./engine.ts";
import { Session } from "./session.ts";

const bridge = process.env.LIME_OCCT_BRIDGE ?? "";
const root = fileURLToPath(new URL("..", import.meta.url));
const addon = engineCandidates(root).find((path) => existsSync(path)) ?? "";
const ci = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
if (!bridge || !existsSync(bridge) || !addon) {
  if (ci) {
    console.error("vents-occt: LIME_OCCT_BRIDGE and the MCP addon are required");
    process.exit(1);
  }
  console.log("vents-occt: skipped (set LIME_OCCT_BRIDGE and build lime-mcp-engine)");
  process.exit(0);
}

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-vents-"));
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
const resinJob = String((await call("ribs_plan", { object, wall, process: "resin", goal, baselines: false, buildAxis: [0, 0, -1] })).job);
const resin = await waitJob(resinJob);
const resinS = (Date.now() - t0) / 1000;
const t1 = Date.now();
const upright = await waitJob(String((await call("ribs_plan", { object, wall, process: "resin", goal, baselines: false })).job));
const uprightS = (Date.now() - t1) / 1000;
const t2 = Date.now();
const filament = await waitJob(String((await call("ribs_plan", { object, wall, process: "filament", goal, baselines: false })).job));
const filamentS = (Date.now() - t2) / 1000;
const moulded = await waitJob(String((await call("ribs_plan", { object, wall, process: "moulded", goal, baselines: false })).job));

const vents = resin.plan?.vents as Reply | undefined;
const pockets = (vents?.pockets ?? []) as Reply[];
const ribs = (resin.plan?.ribs ?? []) as Reply[];
check("the resin plan finishes and lists its vents", resin.ok === true && vents !== undefined && Array.isArray(pockets), JSON.stringify(resin).slice(0, 400));
check("every closed cell that faces the platform is vented at 0.75 mm", pockets.length > 0 && pockets.every((p) => p.sizeMm === 0.75 && Array.isArray(p.at) && p.at.length === 3), JSON.stringify(vents).slice(0, 500));
check(
  "the reported stiffness is the notched ribs, and a gap costs at least as much as a lowered stretch",
  typeof vents?.factorBefore === "number" && typeof vents?.factorAfter === "number" && vents.factorAfter <= vents.factorBefore + 1e-4 && vents.mouseHoleFactor + 1e-4 >= vents.factorAfter && Math.abs(resin.plan.stiffnessFactor - vents.factorAfter) < 1e-3,
  JSON.stringify({ before: vents?.factorBefore, after: vents?.factorAfter, mouse: vents?.mouseHoleFactor, reported: resin.plan?.stiffnessFactor }),
);
check("a given build axis is the direction the note names", vents?.note === "Build direction is the one given.");

const drained = ventPockets({
  ribs: ribs.map((rib) => ({ points: rib.points, ends: rib.ends?.[0] === "free" || rib.ends?.[1] === "free" ? ["free", "free"] : undefined })),
  opening: [0, 0, 1],
  buildAxis: [0, 0, -1],
});
check("the notched ribs, read on their own, close no cupping cell", drained.pockets.length === 0, JSON.stringify(drained.pockets).slice(0, 300));

const built = await call("ribs_apply", { job: resinJob });
check("the notched ribNet builds", built.ok === true && Number(built.paths) >= ribs.length, JSON.stringify(built).slice(0, 400));

const up = upright.plan?.vents as Reply | undefined;
check("the same floor with the default build, toward the tank, cups nothing", upright.ok === true && Array.isArray(up?.pockets) && up.pockets.length === 0, JSON.stringify(up).slice(0, 300));
check("the note says the plate has no resin printer", typeof up?.note === "string" && String(up.note).includes("no resin printer"));

check("filament has no vents key", filament.ok === true && filament.plan && !("vents" in filament.plan));
check("moulded has no vents key", moulded.ok === true && moulded.plan && !("vents" in moulded.plan) && "moulding" in moulded.plan);
const filamentKeys = Object.keys(filament.plan ?? {}).sort();
const mouldedKeys = Object.keys(moulded.plan ?? {}).filter((key) => key !== "moulding").sort();
const resinKeys = Object.keys(resin.plan ?? {}).filter((key) => key !== "vents").sort();
check("aside from vents and moulding, the plan keys match", JSON.stringify(filamentKeys) === JSON.stringify(mouldedKeys) && JSON.stringify(filamentKeys) === JSON.stringify(resinKeys), JSON.stringify({ filamentKeys, mouldedKeys, resinKeys }));
console.log(`vents-occt: resin ${resinS.toFixed(1)} s, ${pockets.length} pockets, ${ribs.length} ribs, before ${vents?.factorBefore} after ${vents?.factorAfter} mouse ${vents?.mouseHoleFactor}; upright ${uprightS.toFixed(1)} s; filament ${filamentS.toFixed(1)} s`);

if (failed) {
  console.error(`vents-occt: ${failed} failed`);
  process.exit(1);
}
console.log("vents-occt: ok");
// The engine worker keeps the process alive. The folded-shell step is 25 minutes, so exit as the other OCCT tests do.
process.exit(0);
