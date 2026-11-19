/**
 * Resin vent notches through ribs_plan against real Open CASCADE.
 *
 * The floor of an open box is walled in all round. With the part sitting +Z, that
 * opening faces the tank, so the plan reports that the part itself cups and cuts
 * nothing. The box is 90 mm tall so a side wall is about 36 × 88 mm. Its free rim
 * is the open top. Ribs there are straight, 1.2 mm wide, at least 5 mm long and
 * 16 mm apart, so a boundary stretch can hold a 0.75 mm gap. A drafted root on
 * that rim runs off the wall, which ribNet will not build. buildAxis along the
 * opening (plate frame) vents it; the opposite axis, facing the platform, cups nothing.
 * The gap is measured on the ribs the solid is built from, then ribs_apply builds them.
 *
 * Filament and moulded omit vents. A buildAxis on either is refused.
 * This machine has no Open CASCADE; the folded-shell job is the proof.
 * Skips without LIME_OCCT_BRIDGE; fails in CI when it is unset.
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { GIVEN_AXIS, NO_RESIN_PRINTER, PART_CUPS } from "../src/modeling/vents.ts";
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

function gapMm(ribs: Reply[]): number {
  const ends: number[][] = [];
  for (const rib of ribs) {
    const points = rib.points as number[][] | undefined;
    if (!points || points.length < 2) continue;
    ends.push(points[0]!, points[points.length - 1]!);
  }
  let best = -1;
  for (let i = 0; i < ends.length; i += 1) {
    for (let j = i + 1; j < ends.length; j += 1) {
      const a = ends[i]!;
      const b = ends[j]!;
      const d = Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
      if (d > 0.2 && d < 2 && (best < 0 || Math.abs(d - 0.75) < Math.abs(best - 0.75))) best = d;
    }
  }
  return best;
}

const object = String((await call("solid_new", { primitive: "box", dx: 64, dy: 40, dz: 90 })).object);
const shelled = await call("model_apply", { object, probe: true, op: { kind: "shell", thickness: 2, openFaces: [{ normal: [0, 0, 1] }] } });
if (shelled.ok !== true) throw new Error(`shell: ${JSON.stringify(shelled).slice(0, 300)}`);

const floor = { face: { normal: [0, 0, 1], nearPoint: [0, 0, 2] } };
// The box is centred in X and Y and stands on Z 0. The inner +X wall is at X 30.
const side = { face: { normal: [-1, 0, 0], nearPoint: [30, 0, 40] } };
const goal = { budgetMm3: 2500 };
const sideGoal = { budgetMm3: 8000 };
// 16 mm between ribs, on a wall about 88 mm tall. A 0.75 mm gap in the middle of
// such a stretch leaves two pieces longer than the 5 mm minimum. Straight: resin's
// drafted root runs off the open rim.
const sideRib = { profile: "straight", width: 1.2, minLength: 5, minSpacing: 16 };

const t0 = Date.now();
const floorJob = String((await call("ribs_plan", { object, wall: floor, process: "resin", goal, baselines: false })).job);
const floorPlan = await waitJob(floorJob);
const floorS = (Date.now() - t0) / 1000;

const t1 = Date.now();
const sideJob = String((await call("ribs_plan", { object, wall: side, process: "resin", goal: sideGoal, baselines: false, buildAxis: [-1, 0, 0], rib: sideRib })).job);
const sidePlan = await waitJob(sideJob);
const sideS = (Date.now() - t1) / 1000;

const t2 = Date.now();
const platform = await waitJob(String((await call("ribs_plan", { object, wall: side, process: "resin", goal: sideGoal, baselines: false, buildAxis: [1, 0, 0], rib: sideRib })).job));
const platformS = (Date.now() - t2) / 1000;

const t3 = Date.now();
const filament = await waitJob(String((await call("ribs_plan", { object, wall: floor, process: "filament", goal, baselines: false })).job));
const filamentS = (Date.now() - t3) / 1000;
const moulded = await waitJob(String((await call("ribs_plan", { object, wall: floor, process: "moulded", goal, baselines: false })).job));
const refusedStart = await call("ribs_plan", { object, wall: floor, process: "filament", goal, baselines: false, buildAxis: [0, 0, 1] });
const refused = refusedStart.job ? await waitJob(String(refusedStart.job)) : refusedStart;

const floorVents = floorPlan.plan?.vents as Reply | undefined;
const floorNotes = (floorPlan.plan?.notes ?? floorPlan.notes ?? []) as string[];
check("the floor plan finishes", floorPlan.ok === true && floorVents !== undefined, JSON.stringify(floorPlan).slice(0, 400));
check("the default note says the plate has no resin printer", floorNotes.some((note) => note === NO_RESIN_PRINTER) || String(floorVents?.note ?? "").includes("no resin printer"), JSON.stringify(floorNotes));
check(
  "a floor walled all round is not notched",
  Array.isArray(floorVents?.pockets) && floorVents.pockets.length === 0 && Array.isArray(floorVents?.unvented) && floorVents.unvented.some((item: Reply) => item.message === PART_CUPS),
  JSON.stringify(floorVents).slice(0, 500),
);

const vents = sidePlan.plan?.vents as Reply | undefined;
const pockets = (vents?.pockets ?? []) as Reply[];
const ribs = (sidePlan.plan?.ribs ?? []) as Reply[];
const sideNotes = (sidePlan.plan?.notes ?? sidePlan.notes ?? []) as string[];
check("the side wall, opening toward the tank, is vented", sidePlan.ok === true && pockets.length > 0 && pockets.every((p) => p.sizeMm === 0.75), JSON.stringify(vents).slice(0, 500));
check("the note names the given plate-frame axis", sideNotes.some((note) => note === GIVEN_AXIS), JSON.stringify(sideNotes));
const measured = gapMm(ribs);
check("a 0.75 mm gap is still open in the ribs the solid is built from", measured > 0.7 && measured < 1.2, String(measured));
check(
  "the reported stiffness is the notched solve",
  typeof vents?.factorBefore === "number" && typeof vents?.factorAfter === "number" && vents.factorAfter <= vents.factorBefore + 1e-4 && Math.abs(sidePlan.plan.stiffnessFactor - vents.factorAfter) < 1e-3,
  JSON.stringify({ before: vents?.factorBefore, after: vents?.factorAfter, reported: sidePlan.plan?.stiffnessFactor }),
);
for (const pocket of pockets) {
  check(`pocket.rib ${pocket.rib} indexes a returned rib`, typeof pocket.rib === "number" && pocket.rib >= 0 && pocket.rib < ribs.length, JSON.stringify(pocket));
}

const built = await call("ribs_apply", { job: sideJob });
check("the notched ribNet builds", built.ok === true && Number(built.paths) >= 1, JSON.stringify(built).slice(0, 400));

const away = platform.plan?.vents as Reply | undefined;
check("the same wall facing the platform cups nothing", platform.ok === true && Array.isArray(away?.pockets) && away.pockets.length === 0 && (away.unvented ?? []).length === 0, JSON.stringify(away).slice(0, 300));

check("filament has no vents key", filament.ok === true && filament.plan && !("vents" in filament.plan));
check("moulded has no vents key", moulded.ok === true && moulded.plan && !("vents" in moulded.plan) && "moulding" in moulded.plan);
check("filament refuses a build axis", refused.ok === false && String(refused.reason ?? refused.message ?? "").includes("resin"), JSON.stringify(refused).slice(0, 300));
const filamentKeys = Object.keys(filament.plan ?? {}).sort();
const mouldedKeys = Object.keys(moulded.plan ?? {}).filter((key) => key !== "moulding").sort();
const resinKeys = Object.keys(floorPlan.plan ?? {}).filter((key) => key !== "vents" && key !== "notes").sort();
check("aside from vents, notes and moulding, the plan keys match", JSON.stringify(filamentKeys) === JSON.stringify(mouldedKeys) && JSON.stringify(filamentKeys) === JSON.stringify(resinKeys), JSON.stringify({ filamentKeys, mouldedKeys, resinKeys }));

console.log(`vents-occt: floor ${floorS.toFixed(1)} s (part cups), side ${sideS.toFixed(1)} s, ${pockets.length} pockets, gap ${measured.toFixed(3)} mm, before ${vents?.factorBefore} after ${vents?.factorAfter}; platform ${platformS.toFixed(1)} s; filament ${filamentS.toFixed(1)} s`);

if (failed) {
  console.error(`vents-occt: ${failed} failed`);
  process.exit(1);
}
console.log("vents-occt: ok");
process.exit(0);
